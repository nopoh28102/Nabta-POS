import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { ApiError } from "./errors.js";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`pg_dump exited ${code}: ${stderr}`)));
  });
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolvePromise(hash.digest("hex")));
  });
}

const MAX_IMPORT_SIZE_BYTES = 20 * 1024 * 1024 * 1024;
const AUTOMATIC_BACKUP_INTERVAL_DAYS = 3;
const AUTOMATIC_BACKUP_RETENTION_DAYS = 30;

type BackupRunKind = "MANUAL" | "AUTOMATIC" | "RESET";

export type BackupPolicy = {
  automaticEnabled: boolean;
  destinationPath: string;
  intervalDays: number;
  retentionDays: number;
  lastAutomaticBackupAt: string | null;
  nextBackupDueAt: string | null;
};

type BackupPolicyRow = {
  automatic_enabled: boolean;
  destination_path: string | null;
  interval_days: number;
  retention_days: number;
  last_automatic_backup_at: Date | string | null;
};

function isPathInside(path: string, parent: string): boolean {
  const value = relative(parent, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function assertSafeBackupDirectory(directory: string, config: AppConfig): string {
  const backupDir = resolve(directory);
  const appDir = resolve(process.cwd());
  const databaseDir = resolve(config.DATABASE_DIR);
  if (isPathInside(backupDir, appDir) || isPathInside(backupDir, databaseDir)) {
    throw new ApiError(500, "BACKUP_PATH_UNSAFE", "يجب أن يكون مسار النسخ الاحتياطي خارج مجلد التطبيق وقاعدة البيانات الحية");
  }
  return backupDir;
}

function backupDirectory(config: AppConfig): string {
  if (!config.BACKUP_DIR) throw new ApiError(503, "BACKUP_NOT_CONFIGURED", "مسار النسخ الاحتياطي غير مُعد على الخادم");
  return assertSafeBackupDirectory(config.BACKUP_DIR, config);
}

function requestedBackupPath(backupDir: string, config: AppConfig, destinationPath?: string): string {
  if (!destinationPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return resolve(backupDir, `nabta-${stamp}.dump`);
  }
  const finalPath = resolve(destinationPath);
  if (!isAbsolute(destinationPath) || extname(finalPath).toLowerCase() !== ".dump") {
    throw new ApiError(422, "BACKUP_DESTINATION_INVALID", "اختر ملف نسخ احتياطي بامتداد .dump في مسار صالح");
  }
  assertSafeBackupDirectory(dirname(finalPath), config);
  return finalPath;
}

async function assertNewBackupPath(path: string): Promise<void> {
  for (const candidate of [path, `${path}.partial`]) {
    try {
      await stat(candidate);
      throw new ApiError(409, "BACKUP_FILE_EXISTS", "يوجد ملف بالاسم المختار بالفعل؛ اختر اسمًا آخر لحماية النسخة الموجودة");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function runBackup(
  db: Database,
  config: AppConfig,
  requestedBy: string | null,
  destinationPath?: string,
  options: { runKind?: BackupRunKind; retentionDays?: number } = {},
): Promise<{ id: string; path: string; sha256: string; sizeBytes: number }> {
  if (!config.BACKUP_DIR || (db.kind === "postgres" && (!config.PG_DUMP_PATH || !config.DATABASE_URL))) {
    throw new ApiError(503, "BACKUP_NOT_CONFIGURED", "مسار النسخ الاحتياطي أو أداة النسخ غير مُعدة على الخادم");
  }
  const backupDir = backupDirectory(config);
  await mkdir(backupDir, { recursive: true });
  const finalPath = requestedBackupPath(backupDir, config, destinationPath);
  await mkdir(dirname(finalPath), { recursive: true });
  await assertNewBackupPath(finalPath);
  const partialPath = `${finalPath}.partial`;
  const runKind = options.runKind ?? "MANUAL";
  const started = await db.query<{ id: string }>("INSERT INTO backup_runs(requested_by, path, status, run_kind) VALUES ($1, $2, 'STARTED', $3) RETURNING id", [requestedBy, finalPath, runKind]);
  try {
    if (db.kind === "embedded" && "dumpDataDir" in db) {
      await writeFile(partialPath, await db.dumpDataDir());
    } else {
      const url = new URL(config.DATABASE_URL!);
      const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) };
      await run(config.PG_DUMP_PATH!, ["--format=custom", "--no-owner", "--no-privileges", `--file=${partialPath}`], env);
    }
    const fileStat = await stat(partialPath);
    if (fileStat.size === 0) throw new Error("backup produced an empty file");
    const hash = await sha256File(partialPath);
    await rename(partialPath, finalPath);
    await db.query("UPDATE backup_runs SET status = 'COMPLETED', sha256 = $2, size_bytes = $3, completed_at = now() WHERE id = $1", [started.rows[0]!.id, hash, fileStat.size]);
    await enforceRetention(dirname(finalPath), options.retentionDays ?? config.BACKUP_RETENTION_DAYS);
    return { id: started.rows[0]!.id, path: finalPath, sha256: hash, sizeBytes: fileStat.size };
  } catch (error) {
    await rm(partialPath, { force: true });
    await db.query("UPDATE backup_runs SET status = 'FAILED', error_message = $2, completed_at = now() WHERE id = $1", [started.rows[0]!.id, error instanceof Error ? error.message.slice(0, 1000) : "unknown error"]);
    throw error;
  }
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export async function getBackupPolicy(db: Database, config: AppConfig): Promise<BackupPolicy> {
  const result = await db.query<BackupPolicyRow>(`
    SELECT bp.automatic_enabled, bp.destination_path, bp.interval_days, bp.retention_days,
      (
        SELECT max(completed_at) FROM backup_runs
        WHERE run_kind = 'AUTOMATIC' AND status IN ('COMPLETED', 'RESTORE_VERIFIED')
      ) AS last_automatic_backup_at
    FROM backup_policy bp
    WHERE bp.singleton
  `);
  const row = result.rows[0];
  const destinationPath = assertSafeBackupDirectory(row?.destination_path ?? backupDirectory(config), config);
  const intervalDays = row?.interval_days ?? AUTOMATIC_BACKUP_INTERVAL_DAYS;
  const retentionDays = row?.retention_days ?? AUTOMATIC_BACKUP_RETENTION_DAYS;
  const lastAutomaticBackupAt = toIso(row?.last_automatic_backup_at ?? null);
  return {
    automaticEnabled: row?.automatic_enabled ?? true,
    destinationPath,
    intervalDays,
    retentionDays,
    lastAutomaticBackupAt,
    nextBackupDueAt: lastAutomaticBackupAt
      ? new Date(new Date(lastAutomaticBackupAt).valueOf() + intervalDays * 86_400_000).toISOString()
      : null,
  };
}

export async function updateBackupPolicy(
  db: Database,
  config: AppConfig,
  input: { destinationPath: string; automaticEnabled?: boolean | undefined },
): Promise<BackupPolicy> {
  const destinationPath = assertSafeBackupDirectory(input.destinationPath, config);
  await mkdir(destinationPath, { recursive: true });
  await db.query(`
    INSERT INTO backup_policy(singleton, automatic_enabled, destination_path, interval_days, retention_days, updated_at)
    VALUES (true, $1, $2, $3, $4, now())
    ON CONFLICT (singleton) DO UPDATE
      SET automatic_enabled = EXCLUDED.automatic_enabled,
          destination_path = EXCLUDED.destination_path,
          interval_days = EXCLUDED.interval_days,
          retention_days = EXCLUDED.retention_days,
          updated_at = now()
  `, [input.automaticEnabled ?? true, destinationPath, AUTOMATIC_BACKUP_INTERVAL_DAYS, AUTOMATIC_BACKUP_RETENTION_DAYS]);
  return getBackupPolicy(db, config);
}

let automaticBackupInFlight: Promise<{ backup: { id: string; path: string; sha256: string; sizeBytes: number } | null; policy: BackupPolicy }> | null = null;

/** Creates a verified archive only when the configured 3-day interval is due. */
export async function runAutomaticBackupIfDue(
  db: Database,
  config: AppConfig,
  force = false,
): Promise<{ backup: { id: string; path: string; sha256: string; sizeBytes: number } | null; policy: BackupPolicy }> {
  if (automaticBackupInFlight) return automaticBackupInFlight;
  automaticBackupInFlight = (async () => {
    const policy = await getBackupPolicy(db, config);
    if (!policy.automaticEnabled) return { backup: null, policy };
    const dueAt = policy.nextBackupDueAt ? new Date(policy.nextBackupDueAt).valueOf() : 0;
    if (!force && dueAt > Date.now()) return { backup: null, policy };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destinationPath = resolve(policy.destinationPath, `nabta-auto-${stamp}.dump`);
    const backup = await runBackup(db, config, null, destinationPath, {
      runKind: "AUTOMATIC",
      retentionDays: policy.retentionDays,
    });
    if (db.kind === "embedded") await verifyBackupRestore(db, config, backup.id);
    return { backup, policy: await getBackupPolicy(db, config) };
  })();
  try {
    return await automaticBackupInFlight;
  } finally {
    automaticBackupInFlight = null;
  }
}

/** Imports an owner-selected PGlite archive into the managed backup store and verifies it in isolation.
 * Live store data is intentionally never replaced while the POS is running. */
export async function importBackup(db: Database, config: AppConfig, requestedBy: string | null, sourcePath: string): Promise<{ id: string; path: string; sha256: string; sizeBytes: number; schemaVersion: string }> {
  if (db.kind !== "embedded") throw new ApiError(422, "BACKUP_IMPORT_UNSUPPORTED", "استيراد النسخ من الواجهة متاح لقاعدة نبتة المحلية فقط");
  const backupDir = backupDirectory(config);
  const source = resolve(sourcePath);
  if (!isAbsolute(sourcePath) || extname(source).toLowerCase() !== ".dump") {
    throw new ApiError(422, "BACKUP_IMPORT_INVALID", "اختر ملف نسخة احتياطية بامتداد .dump");
  }
  let sourceStat: Awaited<ReturnType<typeof stat>>;
  try { sourceStat = await stat(source); }
  catch { throw new ApiError(404, "BACKUP_IMPORT_NOT_FOUND", "لم يُعثر على ملف النسخة الاحتياطية المختار"); }
  if (!sourceStat.isFile() || sourceStat.size === 0 || sourceStat.size > MAX_IMPORT_SIZE_BYTES) {
    throw new ApiError(422, "BACKUP_IMPORT_INVALID", "ملف النسخة غير صالح أو يتجاوز الحجم المسموح");
  }
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = resolve(backupDir, `nabta-imported-${stamp}-${randomUUID()}.dump`);
  const partialPath = `${finalPath}.partial`;
  const started = await db.query<{ id: string }>("INSERT INTO backup_runs(requested_by, path, status) VALUES ($1, $2, 'STARTED') RETURNING id", [requestedBy, finalPath]);
  try {
    await copyFile(source, partialPath, constants.COPYFILE_EXCL);
    const fileStat = await stat(partialPath);
    const hash = await sha256File(partialPath);
    await rename(partialPath, finalPath);
    await db.query("UPDATE backup_runs SET status = 'COMPLETED', sha256 = $2, size_bytes = $3, completed_at = now() WHERE id = $1", [started.rows[0]!.id, hash, fileStat.size]);
    const verification = await verifyBackupRestore(db, config, started.rows[0]!.id);
    return { id: started.rows[0]!.id, path: finalPath, sha256: hash, sizeBytes: fileStat.size, schemaVersion: verification.schemaVersion };
  } catch (error) {
    await rm(partialPath, { force: true });
    await db.query("UPDATE backup_runs SET status = 'FAILED', error_message = $2, completed_at = now() WHERE id = $1", [started.rows[0]!.id, error instanceof Error ? error.message.slice(0, 1000) : "backup import failed"]);
    throw error;
  }
}

/** Restores a PGlite archive only into a fresh temporary directory, then checks the schema.
 * It never touches the live data directory; replacing live data remains an offline owner operation. */
export async function verifyBackupRestore(db: Database, _config: AppConfig, backupId: string): Promise<{ verified: true; schemaVersion: string }> {
  if (db.kind !== "embedded") throw new ApiError(422, "RESTORE_VERIFY_UNSUPPORTED", "اختبار الاستعادة التلقائي متاح لقاعدة نبتة المحلية فقط");
  const record = await db.query<{ path: string }>("SELECT path FROM backup_runs WHERE id = $1", [backupId]);
  if (!record.rows[0]) throw new ApiError(404, "BACKUP_NOT_FOUND", "النسخة الاحتياطية غير موجودة في السجل");
  const archivePath = resolve(record.rows[0].path);
  if (!isAbsolute(record.rows[0].path) || basename(archivePath) !== basename(record.rows[0].path) || extname(archivePath).toLowerCase() !== ".dump") {
    throw new ApiError(422, "BACKUP_PATH_UNSAFE", "مسار النسخة الاحتياطية غير آمن");
  }
  const isolatedDir = await mkdtemp(resolve(tmpdir(), "nabta-restore-verify-"));
  let restored: PGlite | null = null;
  try {
    const archive = new Blob([await readFile(archivePath)]);
    restored = new PGlite(isolatedDir, { extensions: { pgcrypto }, loadDataDir: archive });
    await restored.waitReady;
    const state = await restored.query<{ setup_completed: boolean }>("SELECT setup_completed FROM system_state WHERE singleton");
    const version = await restored.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1");
    if (!state.rows[0]?.setup_completed || !version.rows[0]?.version) throw new Error("archive does not contain a valid Nabta store");
    await db.query("UPDATE backup_runs SET status = 'RESTORE_VERIFIED', completed_at = now(), error_message = NULL WHERE id = $1", [backupId]);
    return { verified: true, schemaVersion: version.rows[0].version };
  } catch (error) {
    await db.query("UPDATE backup_runs SET status = 'FAILED', error_message = $2, completed_at = now() WHERE id = $1", [backupId, error instanceof Error ? error.message.slice(0, 1000) : "restore verification failed"]);
    throw new ApiError(422, "RESTORE_VERIFY_FAILED", "تعذر اختبار استعادة النسخة؛ لا تستخدمها قبل إنشاء نسخة جديدة", error instanceof Error ? { message: error.message } : undefined);
  } finally {
    if (restored) await restored.close().catch(() => undefined);
    await rm(isolatedDir, { recursive: true, force: true });
  }
}

async function enforceRetention(directory: string, days: number): Promise<void> {
  const threshold = Date.now() - days * 86_400_000;
  for (const name of await readdir(directory)) {
    // Only the archives generated by the automatic policy are removed here.
    // A manual copy chosen by the owner is never silently deleted.
    if (!/^nabta-auto-\d{4}-\d{2}-\d{2}T.+\.dump$/.test(name) || basename(name) !== name) continue;
    const path = resolve(directory, name);
    const item = await stat(path);
    if (item.mtimeMs < threshold) await rm(path, { force: true });
  }
}

export function startBackupScheduler(db: Database, config: AppConfig): NodeJS.Timeout | null {
  if ((config.NODE_ENV !== "production" && config.NABTA_LOCAL_MODE !== "1") || !config.BACKUP_DIR || (db.kind === "postgres" && (!config.PG_DUMP_PATH || !config.DATABASE_URL))) return null;
  const trigger = () => {
    void runAutomaticBackupIfDue(db, config).catch((error) => {
      console.warn("[nabta-backup] automatic backup failed", error instanceof Error ? error.message : error);
    });
  };
  // Wait until the cash register finishes its startup work before taking a
  // potentially large archive. The six-hour checks then catch up safely after
  // a machine was switched off, without delaying sign-in or the first sale.
  const firstCheck = setTimeout(trigger, 60_000);
  firstCheck.unref();
  const timer = setInterval(trigger, 6 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
