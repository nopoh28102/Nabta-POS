import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ExcelJS = require("../apps/desktop/node_modules/exceljs");
const { PGlite } = require("../apps/server/node_modules/@electric-sql/pglite");
const { pgcrypto } = require("../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.cjs");

const [sourcePath, dataDir, mediaDir, backupPath] = process.argv.slice(2);
if (!sourcePath || !dataDir || !mediaDir || !backupPath) {
  throw new Error("Usage: node scripts/import-grocery-catalog.mjs <xlsx> <pglite-data-dir> <media-dir> <backup-file>");
}

const MAX_IMAGE_BYTES = Math.max(1, Number(process.env.NABTA_CATALOG_MAX_IMAGE_MB ?? "5")) * 1024 * 1024;
const IMAGE_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.NABTA_CATALOG_IMAGE_CONCURRENCY ?? "8")));

function text(value, limit = 4000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function barcode(value) {
  return text(value, 80).replace(/\s/g, "");
}

function normalizeArabic(value) {
  return text(value, 500)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u064B-\u065F\u0670]/g, "");
}

function localizedCatalogName(value, category) {
  const clean = text(value, 500).replace(/&#39;/g, "'");
  if (/[\u0600-\u06FF]/.test(clean)) return clean;
  const phrases = [
    ["black pepper", "فلفل أسود"], ["white pepper", "فلفل أبيض"], ["baking powder", "بيكنج باودر"],
    ["tomato paste", "صلصة طماطم"], ["tomato ketchup", "كاتشب طماطم"], ["coconut milk", "حليب جوز الهند"],
    ["fava beans", "فول مدمس"], ["corn oil", "زيت ذرة"], ["sunflower oil", "زيت عباد الشمس"],
    ["olive oil", "زيت زيتون"], ["apple vinegar", "خل تفاح"], ["white vinegar", "خل أبيض"],
    ["brown sugar", "سكر بني"], ["powdered sugar", "سكر بودرة"], ["vanilla flavour", "نكهة فانيليا"],
    ["vanilla flavor", "نكهة فانيليا"], ["strawberry sauce", "صوص فراولة"], ["cheese burger", "برجر جبنة"],
    ["mozzarella cheese", "جبنة موزاريلا"], ["feta cheese", "جبنة فيتا"], ["roumy cheese", "جبنة رومي"],
    ["chewing gum", "لبان"], ["soft drink", "مشروب غازي"], ["coffee capsules", "كبسولات قهوة"],
    ["instant coffee", "قهوة سريعة التحضير"], ["coffee mate", "مبيض قهوة"], ["chocolate cake", "كيك شوكولاتة"],
    ["plain biscuits", "بسكويت سادة"], ["vanilla biscuits", "بسكويت فانيليا"], ["potato chips", "شيبسي بطاطس"],
    ["cake baking", "للكيك"], ["baking", "للخبز"], ["flour", "دقيق"], ["honey", "عسل"], ["cereal", "حبوب إفطار"],
    ["biscuits", "بسكويت"], ["biscuit", "بسكويت"], ["syrup", "شراب مركز"], ["sauce", "صوص"],
    ["seasoning", "تتبيلة"], ["chicken stock", "مرقة دجاج"], ["beef stock", "مرقة لحم"], ["milk", "حليب"],
    ["yogurt", "زبادي"], ["butter", "زبدة"], ["cream", "كريمة"], ["cola", "كولا"], ["orange", "برتقال"],
    ["strawberry", "فراولة"], ["chocolate", "شوكولاتة"], ["hazelnut", "بندق"], ["coconut", "جوز الهند"],
    ["vanilla", "فانيليا"], ["mint", "نعناع"], ["plain", "سادة"], ["original", "أصلي"], ["premium", "ممتاز"],
    ["multi purpose", "متعدد الاستخدام"], ["with", "بـ"], ["and", "و"], ["pack of", "عبوة"],
    ["pieces", "قطع"], ["piece", "قطعة"], ["capsules", "كبسولات"], ["sachets", "أكياس"],
    ["grams", "جرام"], ["gram", "جرام"], ["gms", "جم"], ["gm", "جم"], ["kilogram", "كيلو"], ["kg", "كجم"],
    ["milliliters", "مل"], ["milliliter", "مل"], ["ml", "مل"], ["liters", "لتر"], ["liter", "لتر"],
  ];
  let localized = clean;
  for (const [from, to] of phrases) {
    localized = localized.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), to);
  }
  localized = localized.replace(/\s+-\s+/g, " - ").replace(/\s{2,}/g, " ").trim();
  // A brand may intentionally remain in Latin script; the descriptor and the
  // category are Arabic so cashiers can still identify and search the item.
  return /[\u0600-\u06FF]/.test(localized) ? localized : `${localized} - ${category || "أصناف عامة"}`;
}

function priceMinor(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null;
}

function imageUrl(cell) {
  const hyperlink = cell?.hyperlink;
  if (typeof hyperlink === "string" && /^https?:\/\//i.test(hyperlink)) return hyperlink;
  const value = cell?.value;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  return "";
}

function contentType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function wikimediaFallback(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "upload.wikimedia.org") return null;
    const filename = parsed.pathname.split("/").pop();
    return filename ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=1200` : null;
  } catch {
    return null;
  }
}

async function fetchCatalogImage(url) {
  const request = (source) => fetch(source, {
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "Nabta-POS Catalog Importer/1.0 (local inventory application)" },
  });
  let response = await request(url);
  if (response.status === 429) {
    const fallback = wikimediaFallback(url);
    if (fallback) response = await request(fallback);
  }
  return response;
}

function cellText(row, column) {
  const cell = row.getCell(column);
  return text(cell.text || cell.value);
}

async function mapWithConcurrency(values, worker) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, values.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= values.length) return;
      await worker(values[current], current);
    }
  }));
}

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(sourcePath);
const sheet = workbook.worksheets[0];
if (!sheet) throw new Error("The workbook has no worksheets");

const rows = [];
const invalidRows = [];
sheet.eachRow((row, rowNumber) => {
  if (rowNumber === 1) return;
  const code = barcode(cellText(row, 1));
  const nameAr = cellText(row, 2);
  if (!code || !nameAr) {
    invalidRows.push(rowNumber);
    return;
  }
  rows.push({
    barcode: code,
    nameAr: localizedCatalogName(nameAr, cellText(row, 3, 300)),
    category: cellText(row, 3, 300) || "أصناف عامة",
    subcategory: cellText(row, 4, 300),
    brand: cellText(row, 5, 300),
    manufacturer: cellText(row, 6, 300),
    size: cellText(row, 7, 300),
    flavor: cellText(row, 8, 300),
    description: cellText(row, 9, 4000),
    priceMinor: priceMinor(row.getCell(10).value),
    imageSourceUrl: imageUrl(row.getCell(12)),
    sourceName: cellText(row, 25, 300) || basename(sourcePath),
  });
});

const db = new PGlite(dataDir, { extensions: { pgcrypto } });
await db.waitReady;
let summary;
try {
  await mkdir(dirname(backupPath), { recursive: true });
  if (existsSync(backupPath)) throw new Error(`Backup path already exists: ${backupPath}`);
  const dump = await db.dumpDataDir();
  await writeFile(backupPath, Buffer.from(await dump.arrayBuffer()), { flag: "wx" });

  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const appliedMigrations = new Set((await db.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  for (const file of ["006_product_reference_catalog.sql", "007_materialize_catalog_products.sql"]) {
    const version = file.replace(/\.sql$/, "");
    if (appliedMigrations.has(version)) continue;
    await db.exec(await readFile(resolve("migrations", file), "utf8"));
    await db.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [version]);
  }
  // Migration 008 must run after the catalog rows are upserted below, otherwise
  // an older database would materialise only the references it had before this import.

  const [knownBarcodes, warehouseResult] = await Promise.all([
    db.query("SELECT barcode FROM product_barcodes"),
    db.query("SELECT id FROM warehouses WHERE is_default ORDER BY created_at LIMIT 1"),
  ]);
  const warehouseId = warehouseResult.rows[0]?.id;
  if (!warehouseId) throw new Error("No default warehouse exists in the database");

  const productBarcodes = new Set(knownBarcodes.rows.map((item) => item.barcode));
  const fileBarcodes = new Set();
  const references = [];
  let duplicateRows = 0;

  for (const row of rows) {
    if (fileBarcodes.has(row.barcode)) {
      duplicateRows += 1;
      continue;
    }
    fileBarcodes.add(row.barcode);
    // Upsert every row so an existing reference receives the corrected Arabic
    // name and latest description too; the barcode remains the unique key.
    references.push(row);
    if (productBarcodes.has(row.barcode)) duplicateRows += 1;
    else productBarcodes.add(row.barcode);
  }

  for (let offset = 0; offset < references.length; offset += 100) {
    const batch = references.slice(offset, offset + 100);
    await db.transaction(async (tx) => {
      for (const row of batch) {
        await tx.query(`
          INSERT INTO product_reference_catalog
            (barcode, name_ar, category, subcategory, brand, manufacturer, size, flavor, description, image_source_url, source_name)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (barcode) DO UPDATE SET
            name_ar = EXCLUDED.name_ar,
            category = EXCLUDED.category,
            subcategory = EXCLUDED.subcategory,
            brand = EXCLUDED.brand,
            manufacturer = EXCLUDED.manufacturer,
            size = EXCLUDED.size,
            flavor = EXCLUDED.flavor,
            description = EXCLUDED.description,
            image_source_url = EXCLUDED.image_source_url,
            source_name = EXCLUDED.source_name
        `, [row.barcode, row.nameAr, row.category, row.subcategory, row.brand, row.manufacturer, row.size, row.flavor, row.description, row.imageSourceUrl, row.sourceName]);
      }
    });
  }

  const materializeVersion = "008_product_editor_and_catalog_completion";
  if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version = $1", [materializeVersion])).rows.length) {
    await db.exec(await readFile(resolve("migrations", `${materializeVersion}.sql`), "utf8"));
    await db.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [materializeVersion]);
  }
  // Keep imported descriptions and localized names in sync without overwriting
  // a cashier's custom Arabic product name.
  await db.query(`
    UPDATE products AS product
    SET description = CASE WHEN product.description = '' THEN reference.description ELSE product.description END,
        name_ar = CASE WHEN product.name_ar !~ '[ء-ي]' THEN reference.name_ar ELSE product.name_ar END,
        search_name = CASE WHEN product.name_ar !~ '[ء-ي]' THEN lower(regexp_replace(trim(reference.name_ar), '[[:space:]]+', ' ', 'g')) ELSE product.search_name END,
        updated_at = now()
    FROM product_barcodes AS barcode
    JOIN product_reference_catalog AS reference ON reference.barcode = barcode.barcode
    WHERE barcode.product_id = product.id
  `);

  // Revisit every row with an image URL. This repairs the local image cache when
  // a previous installation left the database references intact but media files
  // are missing (for example after a damaged user-data folder).
  const imageRows = await db.query("SELECT barcode, image_source_url FROM product_reference_catalog WHERE image_source_url <> '' ORDER BY barcode");
  const catalogMediaDir = resolve(mediaDir, "catalog");
  await mkdir(catalogMediaDir, { recursive: true });
  let downloadedImages = 0;
  let skippedImages = 0;
  let reusedImages = 0;
  const imageFailures = [];
  await mapWithConcurrency(imageRows.rows, async (row, index) => {
    const target = resolve(catalogMediaDir, `${row.barcode}.img`);
    try {
      if (existsSync(target) && (await stat(target)).size > 0) {
        skippedImages += 1;
      } else {
        const existing = await db.query(
          "SELECT image_asset_path FROM product_reference_catalog WHERE image_source_url = $1 AND image_asset_path IS NOT NULL AND barcode <> $2 LIMIT 1",
          [row.image_source_url, row.barcode],
        );
        const existingPath = text(existing.rows[0]?.image_asset_path, 200);
        const existingFile = existingPath.startsWith("catalog/") ? resolve(mediaDir, existingPath) : "";
        if (existingFile && existsSync(existingFile)) {
          await copyFile(existingFile, target);
          reusedImages += 1;
        } else {
          const response = await fetchCatalogImage(row.image_source_url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const length = Number(response.headers.get("content-length") ?? "0");
          if (length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !contentType(bytes)) throw new Error("Response is not a supported image");
          await writeFile(target, bytes);
          downloadedImages += 1;
        }
      }
      await db.query("UPDATE product_reference_catalog SET image_asset_path = $2 WHERE barcode = $1", [row.barcode, `catalog/${row.barcode}.img`]);
    } catch (error) {
      imageFailures.push({ barcode: row.barcode, message: error instanceof Error ? error.message : "Unknown error" });
    }
    if ((index + 1) % 100 === 0) process.stdout.write(`Downloaded or linked ${index + 1}/${imageRows.rows.length} product images\n`);
  });

  summary = {
    sourceRows: rows.length,
    invalidRows: invalidRows.length,
    duplicateRows,
    referenceRowsInserted: references.length,
    sellableProductsInserted: (await db.query("SELECT count(*)::int AS count FROM products WHERE active")).rows[0]?.count ?? 0,
    pricedRowsInFile: rows.filter((row) => row.priceMinor).length,
    imagesDownloaded: downloadedImages,
    imagesAlreadyCached: skippedImages,
    imagesReusedFromCatalog: reusedImages,
    imageFailures: imageFailures.length,
    imageFailureSamples: imageFailures.slice(0, 20),
    backupPath,
  };
} finally {
  await db.close();
}

console.log(JSON.stringify(summary, null, 2));
