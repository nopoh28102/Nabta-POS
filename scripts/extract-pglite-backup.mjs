import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PGlite } from "../apps/server/node_modules/@electric-sql/pglite/dist/index.js";
import { pgcrypto } from "../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js";

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) {
  throw new Error("Usage: node scripts/extract-pglite-backup.mjs <pglite-directory> <new-backup.dump>");
}

const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "nabta-pglite-extract-"));
const temporaryDatabase = resolve(temporaryRoot, "pglite");
let db;

try {
  // Never open the owner's folder directly. PGlite can update runtime files
  // while opening, so extraction occurs from an exact temporary copy.
  await cp(source, temporaryDatabase, { recursive: true, errorOnExist: true });
  db = new PGlite(temporaryDatabase, { extensions: { pgcrypto } });
  await db.waitReady;
  const [products, sales, receipts, latestMigration] = await Promise.all([
    db.query("SELECT count(*)::int AS value FROM products"),
    db.query("SELECT count(*)::int AS value FROM sales"),
    db.query("SELECT count(*)::int AS value FROM purchase_receipts"),
    db.query("SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1"),
  ]);
  const dump = await db.dumpDataDir();
  await writeFile(output, dump instanceof Uint8Array ? dump : new Uint8Array(await dump.arrayBuffer()), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    output,
    products: products.rows[0]?.value ?? 0,
    sales: sales.rows[0]?.value ?? 0,
    purchaseReceipts: receipts.rows[0]?.value ?? 0,
    latestMigration: latestMigration.rows[0]?.version ?? null,
  })}\n`);
} finally {
  await db?.close();
  // This exact directory was created by mkdtemp above and contains only the
  // temporary working copy. The original PGlite directory is never removed.
  await rm(temporaryRoot, { recursive: true, force: true });
}
