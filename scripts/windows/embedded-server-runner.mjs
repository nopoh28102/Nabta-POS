import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const localMode = process.env.NABTA_LOCAL_MODE === "1";
const localRoot = process.env.NABTA_LOCAL_DATA_DIR;
const programData = process.env.ProgramData ?? "C:\\ProgramData";
if (localMode && !localRoot) throw new Error("NABTA_LOCAL_DATA_DIR is required in local mode");
const serverData = localMode ? path.join(localRoot, "runtime") : path.join(programData, "Nabta", "server");
const dataDir = localMode ? path.join(localRoot, "pglite") : path.join(programData, "Nabta", "data", "pglite");
// The desktop process supplies a user-visible Documents folder. Keep that
// location if present; it survives application updates and is outside live data.
const backupDir = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : (localMode ? path.join(localRoot, "backups") : path.join(programData, "Nabta", "backups"));
const secretPath = path.join(serverData, "server-secrets.json");
if (localMode) await Promise.all([mkdir(serverData, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(backupDir, { recursive: true })]);
const secrets = localMode
  ? { setupToken: "nabta-local-setup-token", pfxPassword: "", fingerprint: "" }
  : JSON.parse((await readFile(secretPath, "utf8")).replace(/^\uFEFF/, ""));

process.chdir(runtimeRoot);
Object.assign(process.env, localMode ? {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: process.env.NABTA_LOCAL_PORT ?? "17443",
  DISCOVERY_PORT: "47621",
  DATABASE_MODE: "embedded",
  DATABASE_DIR: dataDir,
  BACKUP_DIR: backupDir,
  SETUP_TOKEN: secrets.setupToken,
  LOG_LEVEL: "warn",
} : {
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: "7443",
  DISCOVERY_PORT: "47620",
  DATABASE_MODE: "embedded",
  DATABASE_DIR: dataDir,
  BACKUP_DIR: backupDir,
  SETUP_TOKEN: secrets.setupToken,
  TLS_PFX_PATH: path.join(serverData, "server.pfx"),
  TLS_PFX_PASSWORD: secrets.pfxPassword,
  TLS_FINGERPRINT: secrets.fingerprint,
  LOG_LEVEL: "info",
});

// A fresh installation must be usable without a separate migration command.
// Apply the bundled migrations before the HTTP service starts.
const { PGlite } = await import("./pglite/dist/index.js");
const { pgcrypto } = await import("./pglite/dist/contrib/pgcrypto.js");
const migrationDb = new PGlite(dataDir, { extensions: { pgcrypto } });
await migrationDb.waitReady;
try {
  await migrationDb.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await migrationDb.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const entries = (await import("node:fs/promises")).readdir(runtimeRoot + "/migrations");
  for (const file of (await entries).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    await migrationDb.exec(await readFile(path.join(runtimeRoot, "migrations", file), "utf8"));
    await migrationDb.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [version]);
  }
} finally {
  await migrationDb.close();
}

// Local desktop mode: create a deterministic terminal and the requested first-run
// account so the user never has to configure a server or complete a setup wizard.
// The password is still stored as a scrypt hash; it is never sent to the renderer.
const localBranchId = "00000000-0000-4000-8000-000000000001";
const localWarehouseId = "00000000-0000-4000-8000-000000000002";
const localTerminalId = "00000000-0000-4000-8000-000000000003";
const localAdminId = "00000000-0000-4000-8000-000000000004";
const localAdminHash = "scrypt$65536$8$1$MduoiBabZ8Cg9IlK3LA0CVYsO6Nd4vfZ$gLFHl6S6-lL3qPrzrKgi_L-44TmR-l8aS9YkpAH2fqZvNpKBFiDtCK3ifiuTdZtAH4Xe3x0XCiGMeMqDUR-G0A";
const bootstrapDb = new PGlite(dataDir, { extensions: { pgcrypto } });
await bootstrapDb.waitReady;
try {
  await bootstrapDb.exec(`
    INSERT INTO branches(id, name) VALUES ('${localBranchId}', 'المتجر الرئيسي') ON CONFLICT (id) DO NOTHING;
    INSERT INTO warehouses(id, branch_id, name, is_default) VALUES ('${localWarehouseId}', '${localBranchId}', 'المخزن الرئيسي', true) ON CONFLICT (id) DO NOTHING;
    INSERT INTO terminals(id, branch_id, warehouse_id, name, active) VALUES ('${localTerminalId}', '${localBranchId}', '${localWarehouseId}', 'كاشير 1', true) ON CONFLICT (id) DO NOTHING;
    INSERT INTO users(id, display_name, username, password_hash, role, discount_limit_bps)
      VALUES ('${localAdminId}', 'المدير العام', 'admin', '${localAdminHash}', 'OWNER', 10000)
      ON CONFLICT DO NOTHING;
    UPDATE users SET password_hash = '${localAdminHash}', role = 'OWNER', active = true, failed_login_count = 0, locked_until = NULL
      WHERE lower(username) = 'admin';
    UPDATE system_state SET setup_completed = true, store_name = COALESCE(NULLIF(store_name, ''), 'نبتة') WHERE singleton;
  `);
} finally {
  await bootstrapDb.close();
}

await import(pathToFileURL(path.join(runtimeRoot, "server-bundle.mjs")).href);
