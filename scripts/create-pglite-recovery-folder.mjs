import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// This is a root-level maintenance script while PGlite is a server-workspace
// dependency, so resolve it from that workspace explicitly.
import { PGlite } from "../apps/server/node_modules/@electric-sql/pglite/dist/index.js";
import { pgcrypto } from "../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [archiveArgument, destinationArgument] = process.argv.slice(2);

if (!archiveArgument || !destinationArgument) {
  throw new Error("Usage: node scripts/create-pglite-recovery-folder.mjs <backup.dump> <destination-folder>");
}

const archivePath = resolve(archiveArgument);
const destination = resolve(destinationArgument);
const dataDirectory = resolve(destination, "pglite");
const migrationDirectory = resolve(projectRoot, "migrations");

if (!archivePath.toLowerCase().endsWith(".dump")) {
  throw new Error("The recovery input must be a Nabta .dump backup file.");
}

await stat(archivePath);
try {
  await stat(destination);
  throw new Error(`Destination already exists: ${destination}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await mkdir(destination, { recursive: true });
const archive = await readFile(archivePath);
const db = new PGlite(dataDirectory, {
  extensions: { pgcrypto },
  loadDataDir: new Blob([archive]),
});

try {
  await db.waitReady;
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();

  for (const file of migrations) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    await db.exec(await readFile(resolve(migrationDirectory, file), "utf8"));
    await db.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [version]);
  }

  const [products, sales, migration] = await Promise.all([
    db.query("SELECT count(*)::int AS value FROM products"),
    db.query("SELECT count(*)::int AS value FROM sales"),
    db.query("SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1"),
  ]);
  const recoveryInfo = {
    generatedAt: new Date().toISOString(),
    sourceBackup: basename(archivePath),
    sourceBackupSha256: createHash("sha256").update(archive).digest("hex"),
    databaseDirectory: "pglite",
    latestMigration: migration.rows[0]?.version ?? null,
    products: products.rows[0]?.value ?? 0,
    sales: sales.rows[0]?.value ?? 0,
  };
  await writeFile(resolve(destination, "RECOVERY-INFO.json"), `${JSON.stringify(recoveryInfo, null, 2)}\n`, "utf8");
  await writeFile(resolve(destination, "README-استعادة-نبتة.txt"), [
    "مجلد بيانات نبتة المستعاد — جاهز للنقل.",
    "",
    "قبل النقل: أغلق برنامج نبتة تماماً.",
    "1) افتح هذا المسار على الجهاز الرئيسي:",
    "   C:\\Users\\alshimaa\\AppData\\Roaming\\@nabta\\desktop\\local-data",
    "2) غيّر اسم المجلد pglite الحالي إلى pglite-corrupt-2026-10-31 ولا تحذفه.",
    "3) انقل مجلد pglite الموجود داخل هذا المجلد إلى local-data بحيث يصبح المسار النهائي:",
    "   C:\\Users\\alshimaa\\AppData\\Roaming\\@nabta\\desktop\\local-data\\pglite",
    "4) شغّل إصدار نبتة 0.2.18 أو أحدث.",
    "",
    "هذه النسخة تم فحصها بعد الاستعادة وترحيلها إلى آخر بنية بيانات متاحة.",
    "لا تنقل مجلد local-data كاملاً حتى تبقى إعدادات الاتصال والنسخ الاحتياطية كما هي.",
  ].join("\r\n"), "utf8");
  process.stdout.write(`${JSON.stringify(recoveryInfo)}\n`);
} finally {
  await db.close();
}
