import { createRequire } from "node:module";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const ExcelJS = require("../apps/desktop/node_modules/exceljs");

const [sourcePath, mediaDir] = process.argv.slice(2);
if (!sourcePath || !mediaDir) {
  throw new Error("Usage: node scripts/repair-catalog-media.mjs <xlsx> <media-dir>");
}

const MAX_IMAGE_BYTES = Math.max(1, Number(process.env.NABTA_CATALOG_MAX_IMAGE_MB ?? "5")) * 1024 * 1024;
const IMAGE_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.NABTA_CATALOG_IMAGE_CONCURRENCY ?? "8")));
const IMAGE_TIMEOUT_MS = Math.max(5_000, Math.min(120_000, Number(process.env.NABTA_CATALOG_IMAGE_TIMEOUT_MS ?? "20000")));

function barcode(value) {
  return String(value ?? "").replace(/\s/g, "").trim();
}

function imageUrl(cell) {
  const hyperlink = cell?.hyperlink;
  if (typeof hyperlink === "string" && /^https?:\/\//i.test(hyperlink)) return hyperlink;
  return typeof cell?.value === "string" && /^https?:\/\//i.test(cell.value) ? cell.value : "";
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

async function fetchImage(url) {
  const request = (source) => fetch(source, {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    headers: { "User-Agent": "Nabta-POS Catalog Media Repair/1.0 (local inventory application)" },
  });
  let response = await request(url);
  if (response.status === 429) {
    const fallback = wikimediaFallback(url);
    if (fallback) response = await request(fallback);
  }
  return response;
}

async function mapWithConcurrency(values, worker) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, values.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= values.length) return;
      await worker(values[current], current);
    }
  }));
}

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(sourcePath);
const sheet = workbook.worksheets[0];
if (!sheet) throw new Error("The workbook has no worksheets");

const products = [];
sheet.eachRow((row, rowNumber) => {
  if (rowNumber === 1) return;
  const code = barcode(row.getCell(1).text || row.getCell(1).value);
  const url = imageUrl(row.getCell(12));
  if (/^\d{6,80}$/.test(code) && url) products.push({ barcode: code, url });
});

const catalogDir = resolve(mediaDir, "catalog");
await mkdir(catalogDir, { recursive: true });
let downloaded = 0;
let alreadyCached = 0;
const failures = [];

await mapWithConcurrency(products, async (product, index) => {
  const target = resolve(catalogDir, `${product.barcode}.img`);
  try {
    if (existsSync(target) && (await stat(target)).size > 0) {
      alreadyCached += 1;
    } else {
      const response = await fetchImage(product.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !contentType(bytes)) throw new Error("Invalid image response");
      const temporary = `${target}.part-${process.pid}`;
      await writeFile(temporary, bytes, { flag: "w" });
      await rename(temporary, target);
      downloaded += 1;
    }
  } catch (error) {
    await unlink(`${target}.part-${process.pid}`).catch(() => undefined);
    failures.push({ barcode: product.barcode, message: error instanceof Error ? error.message : "Unknown error" });
  }
  if ((index + 1) % 100 === 0) process.stdout.write(`Repaired ${index + 1}/${products.length} catalog images\n`);
});

console.log(JSON.stringify({
  sourceRowsWithImages: products.length,
  imagesDownloaded: downloaded,
  imagesAlreadyCached: alreadyCached,
  imageFailures: failures.length,
  imageFailureSamples: failures.slice(0, 20),
  catalogDir,
}, null, 2));
