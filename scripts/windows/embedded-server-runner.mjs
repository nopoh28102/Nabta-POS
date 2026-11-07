import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

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
const connectionPath = path.join(serverData, "cloudflare-connection.json");
if (localMode) await Promise.all([mkdir(serverData, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(backupDir, { recursive: true })]);
let secrets;
if (localMode) {
  let saved = {};
  let connection = {};
  try { saved = JSON.parse((await readFile(secretPath, "utf8")).replace(/^\uFEFF/, "")); }
  catch { /* First local start: the directory is intentionally empty. */ }
  // The desktop process owns this user-scoped connection document.  It lets a
  // primary device be provisioned by the installer, then later moved to a new
  // Cloudflare Tunnel without changing source code or environment variables.
  try { connection = JSON.parse((await readFile(connectionPath, "utf8")).replace(/^\uFEFF/, "")); }
  catch { /* Cloudflare is optional; offline POS mode remains fully available. */ }
  const commerceApiSharedSecret = typeof connection.commerceSharedSecret === "string" && connection.commerceSharedSecret.length >= 32
    ? connection.commerceSharedSecret
    : typeof saved.commerceApiSharedSecret === "string" && saved.commerceApiSharedSecret.length >= 32
    ? saved.commerceApiSharedSecret
    : (process.env.COMMERCE_API_SHARED_SECRET ?? randomBytes(32).toString("base64url"));
  const terminalRelaySharedSecret = typeof connection.terminalRelaySharedSecret === "string" && connection.terminalRelaySharedSecret.length >= 32
    ? connection.terminalRelaySharedSecret
    : typeof saved.terminalRelaySharedSecret === "string" && saved.terminalRelaySharedSecret.length >= 32
      ? saved.terminalRelaySharedSecret
      : undefined;
  secrets = { ...saved, setupToken: "nabta-local-setup-token", pfxPassword: "", fingerprint: "", commerceApiSharedSecret, ...(terminalRelaySharedSecret ? { terminalRelaySharedSecret } : {}) };
  await writeFile(secretPath, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
} else {
  secrets = JSON.parse((await readFile(secretPath, "utf8")).replace(/^\uFEFF/, ""));
}

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
  COMMERCE_API_SHARED_SECRET: secrets.commerceApiSharedSecret,
  ...(secrets.terminalRelaySharedSecret ? { TERMINAL_RELAY_SHARED_SECRET: secrets.terminalRelaySharedSecret } : {}),
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
  COMMERCE_API_SHARED_SECRET: secrets.commerceApiSharedSecret,
  LOG_LEVEL: "info",
});

// A fresh installation must be usable without a separate migration command.
// Apply the bundled migrations before the HTTP service starts.
const { PGlite } = await import("./pglite/dist/index.js");
const { pgcrypto } = await import("./pglite/dist/contrib/pgcrypto.js");

async function restoreLocalDataFromArchive(archivePath) {
  if (!localMode) throw new Error("Recovery archive is available only for the local desktop database.");
  const resolvedArchive = path.resolve(archivePath);
  if (!resolvedArchive.toLowerCase().endsWith(".dump")) throw new Error("The selected recovery file is not a Nabta .dump backup.");

  // Restore into a sibling directory first.  The live data directory is not
  // renamed until PGlite has opened the archive and the essential tables have
  // been queried successfully.  This avoids a reset or a partially restored
  // database if a user accidentally selects a wrong/corrupt file.
  const candidateDir = `${dataDir}.recovering-${randomUUID()}`;
  const preservedDir = `${dataDir}.pre-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const archive = await readFile(resolvedArchive);
  let candidate;
  try {
    candidate = new PGlite(candidateDir, {
      extensions: { pgcrypto },
      loadDataDir: new Blob([archive]),
    });
    await candidate.waitReady;
    await candidate.query("SELECT 1 FROM system_state LIMIT 1");
    await candidate.query("SELECT 1 FROM products LIMIT 1");
  } catch (error) {
    throw new Error("The selected Nabta backup could not be opened safely; the current data was left unchanged.", { cause: error });
  } finally {
    await candidate?.close();
  }

  // The local data directory is made during first start.  It is safe to move
  // it aside even when it is empty, and the old folder remains available for
  // later forensic recovery instead of being deleted.
  await rename(dataDir, preservedDir);
  try {
    await rename(candidateDir, dataDir);
  } catch (error) {
    // Keep the previous database usable if Windows refuses the second rename.
    await rename(preservedDir, dataDir).catch(() => undefined);
    throw new Error("Nabta could not activate the restored data directory; the previous data directory was kept.", { cause: error });
  }
  process.stderr.write(`[nabta-recovery] Restored ${path.basename(resolvedArchive)}; previous data kept at ${preservedDir}\n`);
}

if (process.env.NABTA_RECOVERY_ARCHIVE) {
  await restoreLocalDataFromArchive(process.env.NABTA_RECOVERY_ARCHIVE);
}

async function openLocalPGlite(stage) {
  const db = new PGlite(dataDir, { extensions: { pgcrypto } });
  try {
    await db.waitReady;
    return db;
  } catch (error) {
    // Preserve the database in place. The desktop logger records this
    // context, allowing recovery from a backup rather than an unsafe reset.
    throw new Error(`PGlite could not open the local data directory during ${stage}: ${dataDir}`, { cause: error });
  }
}

/**
 * A database engine can open successfully while an upcoming schema change
 * still fails (for example after a power loss).  Before applying any pending
 * migration, create a portable archive and prove that it opens in a fresh
 * PGlite directory.  The migration is not attempted if this guard fails.
 */
async function createVerifiedPreMigrationBackup(db, pendingMigrations) {
  if (pendingMigrations.length === 0) return null;
  const guardDir = path.join(backupDir, "update-guard");
  await mkdir(guardDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(guardDir, `nabta-before-schema-${stamp}.dump`);
  const partialPath = `${finalPath}.partial`;
  let verificationDir = null;
  let verificationDb = null;
  try {
    const dump = await db.dumpDataDir();
    const archive = dump instanceof Uint8Array ? dump : new Uint8Array(await dump.arrayBuffer());
    if (archive.byteLength === 0) throw new Error("database backup is empty");
    await writeFile(partialPath, archive, { flag: "wx" });
    const fileStat = await stat(partialPath);
    if (fileStat.size !== archive.byteLength) throw new Error("database backup size mismatch");

    verificationDir = await mkdtemp(path.join(os.tmpdir(), "nabta-update-guard-"));
    verificationDb = new PGlite(verificationDir, { extensions: { pgcrypto }, loadDataDir: new Blob([archive]) });
    await verificationDb.waitReady;
    await verificationDb.query("SELECT 1 FROM schema_migrations LIMIT 1");
    await verificationDb.query("SELECT 1 FROM system_state LIMIT 1");
    await verificationDb.close();
    verificationDb = null;
    await rename(partialPath, finalPath);
    process.stderr.write(`[nabta-update-guard] Verified backup before ${pendingMigrations.length} migration(s): ${finalPath}\n`);
    return finalPath;
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw new Error("Nabta stopped before changing the database because the pre-update backup could not be verified.", { cause: error });
  } finally {
    await verificationDb?.close().catch(() => undefined);
    if (verificationDir) await rm(verificationDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Keep a small, independently openable recovery point whenever the local
 * store has started cleanly.  It is not a substitute for a UPS, but gives the
 * recovery screen a known-good local archive after an abrupt power loss.
 */
async function createVerifiedStartupRecoveryCheckpoint(db) {
  const checkpointDir = path.join(backupDir, "recovery-checkpoints");
  await mkdir(checkpointDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(checkpointDir, `nabta-startup-${stamp}.dump`);
  const partialPath = `${finalPath}.partial`;
  let verificationDir = null;
  let verificationDb = null;
  try {
    const dump = await db.dumpDataDir();
    const archive = dump instanceof Uint8Array ? dump : new Uint8Array(await dump.arrayBuffer());
    if (archive.byteLength === 0) throw new Error("startup recovery archive is empty");
    await writeFile(partialPath, archive, { flag: "wx" });
    verificationDir = await mkdtemp(path.join(os.tmpdir(), "nabta-startup-recovery-"));
    verificationDb = new PGlite(verificationDir, { extensions: { pgcrypto }, loadDataDir: new Blob([archive]) });
    await verificationDb.waitReady;
    await verificationDb.query("SELECT 1 FROM system_state WHERE singleton");
    await verificationDb.query("SELECT 1 FROM products LIMIT 1");
    await verificationDb.close();
    verificationDb = null;
    await rename(partialPath, finalPath);

    // Keep the newest fourteen successful-start checkpoints. These are only
    // safety points; the owner's normal automatic/manual backups are never
    // removed by this cleanup.
    const checkpoints = (await readdir(checkpointDir))
      .filter((name) => /^nabta-startup-.*\.dump$/.test(name))
      .sort()
      .reverse();
    await Promise.all(checkpoints.slice(14).map((name) => rm(path.join(checkpointDir, name), { force: true })));
    process.stderr.write(`[nabta-recovery] Verified startup checkpoint: ${finalPath}\n`);
    return finalPath;
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await verificationDb?.close().catch(() => undefined);
    if (verificationDir) await rm(verificationDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const migrationDb = await openLocalPGlite("migration");
try {
  await migrationDb.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await migrationDb.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const entries = (await import("node:fs/promises")).readdir(runtimeRoot + "/migrations");
  const pendingMigrations = (await entries).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().filter((file) => !applied.has(file.replace(/\.sql$/, "")));
  await createVerifiedPreMigrationBackup(migrationDb, pendingMigrations);
  for (const file of pendingMigrations) {
    const version = file.replace(/\.sql$/, "");
    try {
      await migrationDb.exec("BEGIN");
      await migrationDb.exec(await readFile(path.join(runtimeRoot, "migrations", file), "utf8"));
      await migrationDb.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [version]);
      await migrationDb.exec("COMMIT");
    } catch (error) {
      await migrationDb.exec("ROLLBACK").catch(() => undefined);
      throw new Error(`Schema migration ${version} was rolled back; the previous data remains intact.`, { cause: error });
    }
  }
} finally {
  await migrationDb.close();
}

// Local desktop mode: create a deterministic terminal and the requested first-run
// account so the user never has to configure a server or complete a setup wizard.
// The password is still stored as a scrypt hash; it is never sent to the renderer.
const localBranchId = "00000000-0000-4000-8000-000000000001";
const localWarehouseId = "00000000-0000-4000-8000-000000000002";
const legacyLocalTerminalId = "00000000-0000-4000-8000-000000000003";
const localTerminalId = process.env.NABTA_LOCAL_TERMINAL_ID ?? legacyLocalTerminalId;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localTerminalId)) {
  throw new Error("NABTA_LOCAL_TERMINAL_ID must be a UUID");
}
const localAdminId = "00000000-0000-4000-8000-000000000004";
const localAdminHash = "scrypt$65536$8$1$MduoiBabZ8Cg9IlK3LA0CVYsO6Nd4vfZ$gLFHl6S6-lL3qPrzrKgi_L-44TmR-l8aS9YkpAH2fqZvNpKBFiDtCK3ifiuTdZtAH4Xe3x0XCiGMeMqDUR-G0A";
const bootstrapDb = await openLocalPGlite("local bootstrap");
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
  // Do not serve the register until the core business tables answer normally.
  // If this fails after an unclean power loss, the live folder is preserved and
  // the desktop recovery screen can restore a verified checkpoint or backup.
  await bootstrapDb.query("SELECT 1 FROM system_state WHERE singleton");
  await bootstrapDb.query("SELECT 1 FROM products LIMIT 1");
  await bootstrapDb.query("SELECT 1 FROM stock_balances LIMIT 1");
  await createVerifiedStartupRecoveryCheckpoint(bootstrapDb).catch((error) => {
    process.stderr.write(`[nabta-recovery] Startup checkpoint skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  });
} finally {
  await bootstrapDb.close();
}

await import(pathToFileURL(path.join(runtimeRoot, "server-bundle.mjs")).href);
