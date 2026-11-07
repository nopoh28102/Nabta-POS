// Produces a new archive only. It never alters either source database.
// The first archive is the future primary store and wins for shared products.
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "../apps/server/node_modules/@electric-sql/pglite/dist/index.js";
import { pgcrypto } from "../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js";

const [primaryArchive, incomingDataDir, outputArchive] = process.argv.slice(2);
if (!primaryArchive || !incomingDataDir || !outputArchive) {
  throw new Error("Usage: node scripts/merge-primary-replacement.mjs <primary.dump> <incoming-pglite-dir> <new-merged.dump>");
}

try {
  await access(outputArchive, constants.F_OK);
  throw new Error(`Refusing to overwrite existing archive: ${outputArchive}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function insertRow(db, table, row) {
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row),
  );
}

const workDir = await mkdtemp(join(tmpdir(), "nabta-primary-merge-"));
let primary;
let incoming;
try {
  primary = new PGlite(workDir, {
    extensions: { pgcrypto },
    loadDataDir: new Blob([await readFile(primaryArchive)]),
  });
  incoming = new PGlite(incomingDataDir, { extensions: { pgcrypto } });
  await Promise.all([primary.waitReady, incoming.waitReady]);

  const [primaryProducts, incomingProducts, primaryBarcodes, incomingBarcodes] = await Promise.all([
    primary.query("SELECT * FROM products"),
    incoming.query("SELECT * FROM products"),
    primary.query("SELECT pb.barcode, p.id, p.name_ar, p.price_minor FROM product_barcodes pb JOIN products p ON p.id = pb.product_id"),
    incoming.query("SELECT * FROM product_barcodes"),
  ]);
  const primaryProductById = new Map(primaryProducts.rows.map((product) => [product.id, product]));
  const primaryByBarcode = new Map();
  for (const row of primaryBarcodes.rows) {
    const matches = primaryByBarcode.get(row.barcode) ?? [];
    matches.push(row);
    primaryByBarcode.set(row.barcode, matches);
  }
  const sourceBarcodesByProduct = new Map();
  for (const row of incomingBarcodes.rows) {
    const list = sourceBarcodesByProduct.get(row.product_id) ?? [];
    list.push(row);
    sourceBarcodesByProduct.set(row.product_id, list);
  }

  const productMap = new Map();
  const addedProductIds = new Set();
  const resolvedBarcodeConflicts = [];
  for (const product of incomingProducts.rows) {
    const candidateIds = new Set();
    for (const barcode of sourceBarcodesByProduct.get(product.id) ?? []) {
      for (const match of primaryByBarcode.get(barcode.barcode) ?? []) candidateIds.add(match.id);
    }
    const candidates = [...candidateIds].map((id) => primaryProductById.get(id));
    if (candidates.length === 0) {
      await insertRow(primary, "products", product);
      for (const barcode of sourceBarcodesByProduct.get(product.id) ?? []) await insertRow(primary, "product_barcodes", barcode);
      productMap.set(product.id, product.id);
      addedProductIds.add(product.id);
      continue;
    }
    if (candidates.length === 1) {
      productMap.set(product.id, candidates[0].id);
      continue;
    }
    // The primary database remains authoritative. A duplicate source product
    // can only be resolved automatically when exactly one candidate has its
    // original product name, preferring an equal historical price if present.
    const sameName = candidates.filter((candidate) => candidate.name_ar === product.name_ar);
    const exact = sameName.filter((candidate) => candidate.price_minor === product.price_minor);
    const selected = exact.length === 1 ? exact[0] : sameName.length === 1 ? sameName[0] : null;
    if (!selected) throw new Error(`Ambiguous barcode mapping for source product ${product.id}`);
    productMap.set(product.id, selected.id);
    resolvedBarcodeConflicts.push(product.id);
  }

  // Only source-only products receive their source balance. Existing primary
  // products retain every price, stock quantity and stock movement unchanged.
  const balances = await incoming.query("SELECT * FROM stock_balances");
  for (const balance of balances.rows) {
    if (addedProductIds.has(balance.product_id)) await insertRow(primary, "stock_balances", balance);
  }

  const existingSales = new Set((await primary.query("SELECT id FROM sales")).rows.map((sale) => sale.id));
  const sourceSales = (await incoming.query("SELECT * FROM sales ORDER BY posted_at, id")).rows.filter((sale) => !existingSales.has(sale.id));
  const importedSaleIds = new Set();
  if (sourceSales.length) {
    const ids = sourceSales.map((sale) => sale.id);
    const markers = ids.map((_, index) => `$${index + 1}`).join(", ");
    const [lines, payments, quotes, shifts] = await Promise.all([
      incoming.query(`SELECT * FROM sale_lines WHERE sale_id IN (${markers})`, ids),
      incoming.query(`SELECT * FROM payments WHERE sale_id IN (${markers})`, ids),
      incoming.query(`SELECT q.* FROM quotes q JOIN sales s ON s.quote_id = q.id WHERE s.id IN (${markers})`, ids),
      incoming.query(`SELECT DISTINCT sh.* FROM shifts sh JOIN sales s ON s.shift_id = sh.id WHERE s.id IN (${markers})`, ids),
    ]);
    const existingShiftIds = new Set((await primary.query("SELECT id FROM shifts")).rows.map((shift) => shift.id));
    for (const shift of shifts.rows) if (!existingShiftIds.has(shift.id)) await insertRow(primary, "shifts", shift);
    const existingQuoteIds = new Set((await primary.query("SELECT id FROM quotes")).rows.map((quote) => quote.id));
    for (const quote of quotes.rows) {
      if (existingQuoteIds.has(quote.id)) continue;
      await insertRow(primary, "quotes", {
        ...quote,
        lines_json: (quote.lines_json ?? []).map((line) => ({ ...line, productId: productMap.get(line.productId) ?? line.productId })),
      });
    }
    for (const sale of sourceSales) {
      await insertRow(primary, "sales", sale);
      importedSaleIds.add(sale.id);
    }
    for (const line of lines.rows) {
      if (!importedSaleIds.has(line.sale_id)) continue;
      const productId = productMap.get(line.product_id);
      if (!productId) throw new Error(`Missing product mapping for sale line ${line.id}`);
      await insertRow(primary, "sale_lines", { ...line, product_id: productId });
    }
    for (const payment of payments.rows) if (importedSaleIds.has(payment.sale_id)) await insertRow(primary, "payments", payment);
  }

  const bytes = Buffer.from(await (await primary.dumpDataDir()).arrayBuffer());
  await writeFile(outputArchive, bytes, { flag: "wx" });
  const summary = {
    addedProducts: addedProductIds.size,
    importedHistoricalSales: importedSaleIds.size,
    resolvedBarcodeConflicts: resolvedBarcodeConflicts.length,
    targetStockLeftUnchanged: true,
    products: Number((await primary.query("SELECT count(*)::int AS count FROM products")).rows[0].count),
    sales: Number((await primary.query("SELECT count(*)::int AS count FROM sales")).rows[0].count),
    saleLines: Number((await primary.query("SELECT count(*)::int AS count FROM sale_lines")).rows[0].count),
  };
  console.log(JSON.stringify({ outputArchive, sizeBytes: (await stat(outputArchive)).size, sha256: createHash("sha256").update(bytes).digest("hex"), summary }, null, 2));
} finally {
  if (primary) await primary.close();
  if (incoming) await incoming.close();
  await rm(workDir, { recursive: true, force: true });
}
