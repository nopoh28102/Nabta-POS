import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { ApiError } from "./errors.js";
import { runBackup, verifyBackupRestore } from "./backup.js";

const FORMAT = "NABTA_CLOUD_MIGRATION_V1";
const DEFAULT_CHUNK_BYTES = 192 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type CloudMigrationManifest = {
  format: typeof FORMAT;
  migrationId: string;
  createdAt: string;
  schemaVersion: string;
  backup: { id: string; sha256: string; sizeBytes: number };
  chunkCount: number;
  recordCount: number;
  tables: Array<{ name: string; rowCount: number; sha256: string }>;
};

export type CloudMigrationChunk = {
  format: typeof FORMAT;
  migrationId: string;
  sequence: number;
  records: Array<{ table: string; record: Json }>;
  sha256: string;
};

function isSafeIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function migrationRoot(config: AppConfig): string {
  if (!config.BACKUP_DIR) throw new ApiError(503, "CLOUD_MIGRATION_BACKUP_REQUIRED", "يلزم وجود مسار النسخ الاحتياطي قبل تجهيز نقل البيانات للسحابة");
  return resolve(config.BACKUP_DIR, "cloud-migration");
}

function assertInside(root: string, candidate: string): void {
  const value = relative(root, candidate);
  if (value.startsWith("..") || /^([/\\]|[a-z]:)/i.test(value)) throw new ApiError(403, "CLOUD_MIGRATION_PATH_INVALID", "مسار نقل البيانات غير صالح");
}

async function readManifest(config: AppConfig, migrationId: string): Promise<CloudMigrationManifest> {
  if (!/^[0-9a-f-]{36}$/i.test(migrationId)) throw new ApiError(422, "CLOUD_MIGRATION_ID_INVALID", "معرّف نقل البيانات غير صالح");
  const root = migrationRoot(config);
  const path = resolve(root, migrationId, "manifest.json");
  assertInside(root, path);
  try {
    return JSON.parse(await readFile(path, "utf8")) as CloudMigrationManifest;
  } catch {
    throw new ApiError(404, "CLOUD_MIGRATION_NOT_FOUND", "لم يتم العثور على ملف نقل البيانات المطلوب");
  }
}

/**
 * Produces an immutable, verified logical snapshot.  It never reads directly
 * from the live PGlite directory: first a normal backup is made and restored
 * in isolation, then that isolated archive is exported in small resumable chunks.
 */
export async function prepareCloudMigration(
  db: Database,
  config: AppConfig,
  requestedBy: string,
  requestedChunkBytes = DEFAULT_CHUNK_BYTES,
): Promise<CloudMigrationManifest> {
  if (db.kind !== "embedded") throw new ApiError(422, "CLOUD_MIGRATION_EMBEDDED_ONLY", "نقل التثبيت الحالي للسحابة متاح لقاعدة نبتة المحلية فقط");
  const chunkBytes = Math.min(MAX_CHUNK_BYTES, Math.max(32 * 1024, requestedChunkBytes));
  const backup = await runBackup(db, config, requestedBy, undefined, { runKind: "MANUAL" });
  const verified = await verifyBackupRestore(db, config, backup.id);
  const archive = await readFile(backup.path);
  const migrationId = randomUUID();
  const root = migrationRoot(config);
  const outputDirectory = resolve(root, migrationId);
  assertInside(root, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });

  let snapshot: PGlite | null = null;
  try {
    snapshot = new PGlite(resolve(outputDirectory, "source"), {
      extensions: { pgcrypto },
      loadDataDir: new Blob([archive]),
    });
    await snapshot.waitReady;
    const tableRows = await snapshot.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const tables = tableRows.rows.map((row) => row.tablename).filter(isSafeIdentifier);
    const tableManifest: CloudMigrationManifest["tables"] = [];
    let recordCount = 0;
    let sequence = 0;
    let records: CloudMigrationChunk["records"] = [];

    const flush = async (): Promise<void> => {
      if (records.length === 0) return;
      const chunk: CloudMigrationChunk = {
        format: FORMAT,
        migrationId,
        sequence,
        records,
        sha256: sha256(canonicalJson(records)),
      };
      await writeFile(resolve(outputDirectory, `chunk-${String(sequence).padStart(6, "0")}.json`), JSON.stringify(chunk), { encoding: "utf8", mode: 0o600 });
      sequence += 1;
      records = [];
    };

    for (const table of tables) {
      const rows = await snapshot.query<{ row_json: string }>(`SELECT to_jsonb(t)::text AS row_json FROM public."${table}" t ORDER BY 1`);
      const tableHash = createHash("sha256");
      for (const row of rows.rows) {
        const record = JSON.parse(row.row_json) as Json;
        const candidate = { table, record };
        const nextSize = Buffer.byteLength(canonicalJson([...records, candidate]), "utf8");
        if (records.length > 0 && nextSize > chunkBytes) await flush();
        if (Buffer.byteLength(canonicalJson([candidate]), "utf8") > MAX_CHUNK_BYTES) {
          throw new ApiError(422, "CLOUD_MIGRATION_RECORD_TOO_LARGE", `سجل في جدول ${table} أكبر من الحد الآمن للنقل`);
        }
        records.push(candidate);
        tableHash.update(canonicalJson(record), "utf8");
        tableHash.update("\n", "utf8");
        recordCount += 1;
      }
      tableManifest.push({ name: table, rowCount: rows.rows.length, sha256: tableHash.digest("hex") });
    }
    await flush();
    const manifest: CloudMigrationManifest = {
      format: FORMAT,
      migrationId,
      createdAt: new Date().toISOString(),
      schemaVersion: verified.schemaVersion,
      backup: { id: backup.id, sha256: backup.sha256, sizeBytes: backup.sizeBytes },
      chunkCount: sequence,
      recordCount,
      tables: tableManifest,
    };
    await writeFile(resolve(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
    return manifest;
  } finally {
    if (snapshot) await snapshot.close().catch(() => undefined);
  }
}

export async function getCloudMigrationManifest(config: AppConfig, migrationId: string): Promise<CloudMigrationManifest> {
  return readManifest(config, migrationId);
}

export async function getCloudMigrationChunk(config: AppConfig, migrationId: string, sequence: number): Promise<CloudMigrationChunk> {
  const manifest = await readManifest(config, migrationId);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= manifest.chunkCount) throw new ApiError(404, "CLOUD_MIGRATION_CHUNK_NOT_FOUND", "دفعة نقل البيانات غير موجودة");
  const root = migrationRoot(config);
  const path = resolve(root, migrationId, `chunk-${String(sequence).padStart(6, "0")}.json`);
  assertInside(root, path);
  try {
    const chunk = JSON.parse(await readFile(path, "utf8")) as CloudMigrationChunk;
    const metadata = await stat(path);
    if (metadata.size === 0 || chunk.migrationId !== migrationId || chunk.sequence !== sequence || chunk.sha256 !== sha256(canonicalJson(chunk.records))) {
      throw new Error("invalid cloud migration chunk");
    }
    return chunk;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "CLOUD_MIGRATION_CHUNK_INVALID", "تعذر التحقق من دفعة نقل البيانات");
  }
}
