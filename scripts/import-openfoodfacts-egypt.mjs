import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PGlite } = require("../apps/server/node_modules/@electric-sql/pglite");
const { pgcrypto } = require("../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.cjs");

const [dataDir, targetRaw, backupPath] = process.argv.slice(2);
const target = Number(targetRaw ?? "5000");
if (!dataDir || !Number.isInteger(target) || target < 1 || !backupPath) {
  throw new Error("Usage: node scripts/import-openfoodfacts-egypt.mjs <pglite-data-dir> <target-active-products> <backup-file>");
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const SOURCE_DATE = new Date().toISOString().slice(0, 10);
const SOURCE_NAME = `Open Food Facts — Egypt catalog (ODbL), retrieved ${SOURCE_DATE}`;

function clean(value, limit = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function isValidRetailGtin(value) {
  if (!/^(?:\d{8}|\d{12}|\d{13})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop();
  let sum = 0;
  let multiplier = 3;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += digits[index] * multiplier;
    multiplier = multiplier === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === check;
}

function categoryAr(value) {
  const source = clean(value, 500).toLowerCase();
  if (/milk|yogurt|cheese|dairy|kefir|cream/.test(source)) return "ألبان وأجبان";
  if (/water|juice|soda|beverage|drink|coffee|tea/.test(source)) return "مشروبات";
  if (/chocolate|candy|biscuit|cookie|wafer|snack|chips/.test(source)) return "سناكس وحلويات";
  if (/rice|pasta|flour|oil|sauce|spice|cereal|beans|lentil|sugar|salt/.test(source)) return "مواد غذائية أساسية";
  if (/frozen|ice cream/.test(source)) return "مجمدات";
  if (/baby/.test(source)) return "أغذية أطفال";
  return "بقالة";
}

function productName(product, category) {
  const arabic = clean(product.product_name_ar);
  if (arabic && arabic !== product.code) return arabic;
  const name = clean(product.product_name);
  if (!name || name === product.code) return "";
  return /[\u0621-\u064A]/.test(name) ? name : `${name} — ${category}`;
}

function toReference(product) {
  const barcode = clean(product.code, 80);
  if (!isValidRetailGtin(barcode)) return null;
  const rawCategories = clean(product.categories, 700);
  if (/alcohol|beer|wine|spirits/.test(rawCategories.toLowerCase())) return null;
  const category = categoryAr(rawCategories);
  const nameAr = productName(product, category);
  if (nameAr.length < 2) return null;
  const brand = clean(product.brands);
  const quantity = clean(product.quantity, 120);
  const description = [brand && `العلامة: ${brand}`, quantity && `العبوة: ${quantity}`, rawCategories && `التصنيف المصدر: ${rawCategories}`]
    .filter(Boolean)
    .join(" | ");
  return { barcode, nameAr, category, brand, quantity, description };
}

async function requestPage(page) {
  const params = new URLSearchParams({
    countries_tags_en: "egypt",
    page: String(page),
    page_size: String(PAGE_SIZE),
    fields: "code,product_name,product_name_ar,brands,categories,quantity",
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`https://world.openfoodfacts.net/api/v2/search?${params}`, {
      headers: { "User-Agent": "NabtaPOS/0.1.38 (local Egyptian grocery catalog enrichment; contact: support@nabta.local)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status !== 503) {
      throw new Error(`Open Food Facts request failed: HTTP ${response.status}`);
    }
    if (attempt === 5) throw new Error(`Open Food Facts remained unavailable: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  throw new Error("Open Food Facts request did not return a response");
}

const db = new PGlite(dataDir, { extensions: { pgcrypto } });
await db.waitReady;
try {
  const [activeCountResult, barcodeResult, warehouseResult] = await Promise.all([
    db.query("SELECT count(*)::int AS count FROM products WHERE active"),
    db.query("SELECT barcode FROM product_barcodes"),
    db.query("SELECT id FROM warehouses WHERE is_default ORDER BY created_at LIMIT 1"),
  ]);
  const activeBefore = Number(activeCountResult.rows[0]?.count ?? 0);
  const warehouseId = warehouseResult.rows[0]?.id;
  if (!warehouseId) throw new Error("No default warehouse exists in the database");
  if (activeBefore >= target) {
    console.log(JSON.stringify({ activeBefore, activeAfter: activeBefore, target, added: 0, reason: "target-already-reached" }));
    process.exitCode = 0;
  } else {
    await mkdir(dirname(backupPath), { recursive: true });
    const dump = await db.dumpDataDir();
    await writeFile(backupPath, Buffer.from(await dump.arrayBuffer()), { flag: "wx" });

    const knownBarcodes = new Set(barcodeResult.rows.map((row) => row.barcode));
    const needed = target - activeBefore;
    const candidates = [];
    let fetchedRows = 0;
    let rejectedRows = 0;
    for (let page = 1; page <= MAX_PAGES && candidates.length < needed; page += 1) {
      const payload = await requestPage(page);
      const products = Array.isArray(payload.products) ? payload.products : [];
      fetchedRows += products.length;
      for (const product of products) {
        const reference = toReference(product);
        if (!reference || knownBarcodes.has(reference.barcode)) {
          rejectedRows += 1;
          continue;
        }
        knownBarcodes.add(reference.barcode);
        candidates.push(reference);
        if (candidates.length >= needed) break;
      }
      if (!products.length) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      await db.transaction(async (tx) => {
        for (const item of batch) {
          await tx.query(`
            INSERT INTO product_reference_catalog
              (barcode, name_ar, category, subcategory, brand, manufacturer, size, flavor, description, image_source_url, source_name)
            VALUES ($1, $2, $3, '', $4, '', $5, '', $6, '', $7)
            ON CONFLICT (barcode) DO NOTHING
          `, [item.barcode, item.nameAr, item.category, item.brand, item.quantity, item.description, SOURCE_NAME]);
          const inserted = await tx.query(`
            INSERT INTO products (name_ar, description, search_name, sku, category, unit_kind, price_minor, wholesale_price_minor, reorder_level_milli)
            SELECT $1, $2, lower(regexp_replace(trim($1), '[[:space:]]+', ' ', 'g')), $3, $4, 'PIECE', 0, 0, 0
            WHERE NOT EXISTS (SELECT 1 FROM product_barcodes WHERE barcode = $5)
            ON CONFLICT (sku) DO NOTHING
            RETURNING id
          `, [item.nameAr, item.description, `CATALOG:${item.barcode}`, item.category, item.barcode]);
          const productId = inserted.rows[0]?.id;
          if (!productId) continue;
          await tx.query("INSERT INTO product_barcodes(product_id, barcode) VALUES ($1, $2) ON CONFLICT (barcode) DO NOTHING", [productId, item.barcode]);
          await tx.query("INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version) VALUES ($1, $2, 0, 0, 0) ON CONFLICT (warehouse_id, product_id) DO NOTHING", [warehouseId, productId]);
        }
      });
    }

    const activeAfter = Number((await db.query("SELECT count(*)::int AS count FROM products WHERE active")).rows[0]?.count ?? 0);
    console.log(JSON.stringify({
      activeBefore,
      activeAfter,
      target,
      added: activeAfter - activeBefore,
      fetchedRows,
      rejectedRows,
      candidates: candidates.length,
      source: SOURCE_NAME,
      backupPath,
    }, null, 2));
  }
} finally {
  await db.close();
}
