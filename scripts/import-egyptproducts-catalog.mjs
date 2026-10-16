import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PGlite } = require("../apps/server/node_modules/@electric-sql/pglite");
const { pgcrypto } = require("../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.cjs");

const [dataDir, targetRaw, backupPath] = process.argv.slice(2);
const target = Number(targetRaw ?? "5000");
if (!dataDir || !Number.isInteger(target) || target < 1 || !backupPath) {
  throw new Error("Usage: node scripts/import-egyptproducts-catalog.mjs <pglite-data-dir> <target-active-products> <backup-file>");
}

const BASE_URL = "https://egyptproducts.info/complete-list/";
const SOURCE_DATE = new Date().toISOString().slice(0, 10);
const SOURCE_NAME = `Egypt Products Barcode Database — complete list, retrieved ${SOURCE_DATE}`;

function clean(value, limit = 4000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function decodeHtml(value) {
  return clean(value
    .replace(/<br\s*\/?>(\r?\n)?/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10))),
  );
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

function categoryFor(item) {
  const source = `${item.name} ${item.description} ${item.manufacturer}`.toLowerCase();
  if (/shampoo|soap|cream|serum|hair|skin|body oil|lotion|deodorant|tooth|cosmetic|beauty|كريم|شامبو|صابون|شاور|معطر جسم/.test(source)) return "عناية شخصية وتجميل";
  if (/detergent|bleach|cleaner|dish|floor|chlor|منظف|كلور|مسحوق|سائل اطباق|معطر ارض/.test(source)) return "منظفات ومستلزمات منزلية";
  if (/coffee|tea|espresso|قهوة|شاي|كركديه/.test(source)) return "شاي وقهوة";
  if (/chocolate|biscuit|cookie|wafer|chips|candy|bar |حلويات|شيكولاتة|رقائق|لب /.test(source)) return "سناكس وحلويات";
  if (/rice|bean|lentil|pasta|flour|oil|sugar|salt|spice|seasoning|dates|تمر|أرز|عدس|مكرونة|دقيق|زيت|بهارات|توابل/.test(source)) return "مواد غذائية أساسية";
  if (/milk|cheese|yogurt|dairy|لبن|جبن|زبادي/.test(source)) return "ألبان وأجبان";
  if (/juice|water|soda|drink|beverage|عصير|مياه|مشروب/.test(source)) return "مشروبات";
  if (/frozen|bread|pastry|مخبوز|مجمد/.test(source)) return "مخبوزات ومجمدات";
  if (/spice|herb|pepper|cumin|mint|paprika|عطارة|فلفل|كمون|نعناع|بابريكا/.test(source)) return "عطارة وتوابل";
  return "بقالة ومنتجات مصرية";
}

function groceryPriority(item) {
  const source = `${item.name} ${item.description} ${item.manufacturer}`.toLowerCase();
  if (/oil|sugar|juice|water|drink|soda|cola|chocolate|chips|crisps|biscuit|cookie|wafer|cheese|milk|yogurt|pasta|macaroni|spaghetti/.test(source)) return 2;
  if (/rice|flour|salt|coffee|tea|beans|lentil|tuna|tomato|jam|honey|butter|ghee/.test(source)) return 1;
  return 0;
}

function parsePage(html) {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? "";
  const items = [];
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1]));
    if (cells.length < 7) continue;
    const barcode = cells[0].replace(/\D/g, "");
    const name = clean(cells[1], 300);
    if (!isValidRetailGtin(barcode) || name.length < 2 || name === barcode) continue;
    const item = {
      barcode,
      name,
      description: clean(cells[2]),
      manufacturer: clean(cells[3], 300),
      size: clean(cells[4], 120),
    };
    items.push({ ...item, category: categoryFor(item) });
  }
  return items;
}

async function requestPage(page) {
  const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "NabtaPOS/0.1.38 (local catalog update; support@nabta.local)" },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw new Error(`Egypt Products request failed for page ${page} after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
  } else {
    const needed = target - activeBefore;
    const knownBarcodes = new Set(barcodeResult.rows.map((row) => row.barcode));
    const candidates = [];
    let sourceRows = 0;
    let skippedExisting = 0;
    for (let page = 1; page <= 40; page += 1) {
      const html = await requestPage(page);
      if (html === null) break;
      const items = parsePage(html);
      if (!items.length) break;
      sourceRows += items.length;
      for (const item of items) {
        if (knownBarcodes.has(item.barcode)) {
          skippedExisting += 1;
          continue;
        }
        knownBarcodes.add(item.barcode);
        candidates.push(item);
      }
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    if (candidates.length < needed) {
      throw new Error(`Verified source supplied only ${candidates.length} new products; ${needed} are required to reach ${target}. No database changes were made.`);
    }

    candidates.sort((a, b) => groceryPriority(b) - groceryPriority(a) || a.name.localeCompare(b.name));
    const selected = candidates.slice(0, needed);

    await mkdir(dirname(backupPath), { recursive: true });
    const dump = await db.dumpDataDir();
    await writeFile(backupPath, Buffer.from(await dump.arrayBuffer()), { flag: "wx" });
    for (let offset = 0; offset < selected.length; offset += 100) {
      const batch = selected.slice(offset, offset + 100);
      await db.transaction(async (tx) => {
        for (const item of batch) {
          await tx.query(`
            INSERT INTO product_reference_catalog
              (barcode, name_ar, category, subcategory, brand, manufacturer, size, flavor, description, image_source_url, source_name)
            VALUES ($1, $2, $3, '', $4, $4, $5, '', $6, '', $7)
            ON CONFLICT (barcode) DO NOTHING
          `, [item.barcode, item.name, item.category, item.manufacturer, item.size, item.description, SOURCE_NAME]);
          const inserted = await tx.query(`
            INSERT INTO products (name_ar, description, search_name, sku, category, unit_kind, price_minor, wholesale_price_minor, reorder_level_milli)
            SELECT $1, $2, lower(regexp_replace(trim($1), '[[:space:]]+', ' ', 'g')), $3, $4, 'PIECE', 0, 0, 0
            WHERE NOT EXISTS (SELECT 1 FROM product_barcodes WHERE barcode = $5)
              AND NOT EXISTS (SELECT 1 FROM products WHERE lower(sku) = lower($3))
            RETURNING id
          `, [item.name, item.description, `CATALOG:${item.barcode}`, item.category, item.barcode]);
          const productId = inserted.rows[0]?.id;
          if (!productId) continue;
          await tx.query("INSERT INTO product_barcodes(product_id, barcode) VALUES ($1, $2) ON CONFLICT (barcode) DO NOTHING", [productId, item.barcode]);
          await tx.query("INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version) VALUES ($1, $2, 0, 0, 0) ON CONFLICT (warehouse_id, product_id) DO NOTHING", [warehouseId, productId]);
        }
      });
    }
    const activeAfter = Number((await db.query("SELECT count(*)::int AS count FROM products WHERE active")).rows[0]?.count ?? 0);
    console.log(JSON.stringify({ activeBefore, activeAfter, target, added: activeAfter - activeBefore, sourceRows, skippedExisting, source: SOURCE_NAME, backupPath }, null, 2));
  }
} finally {
  await db.close();
}
