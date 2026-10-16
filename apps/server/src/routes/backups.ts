import type { FastifyInstance } from "fastify";
import { basename } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { getBackupPolicy, importBackup, runAutomaticBackupIfDue, runBackup, updateBackupPolicy, verifyBackupRestore } from "../backup.js";
import { ApiError } from "../errors.js";

const backupDestinationSchema = z.object({ destinationPath: z.string().trim().min(1).max(32_767) }).strict();
const backupImportSchema = z.object({ sourcePath: z.string().trim().min(1).max(32_767) }).strict();
const backupPolicySchema = z.object({
  destinationPath: z.string().trim().min(1).max(32_767),
  automaticEnabled: z.boolean().optional(),
}).strict();

function requireLocalDesktopFileAccess(request: { ip: string }, config: AppConfig): void {
  const loopback = request.ip === "127.0.0.1" || request.ip === "::1" || request.ip === "::ffff:127.0.0.1";
  if (config.NABTA_LOCAL_MODE !== "1" || !loopback) {
    throw new ApiError(403, "LOCAL_FILE_ACCESS_ONLY", "اختيار ملفات النسخ متاح من تطبيق نبتة المحلي على هذا الجهاز فقط");
  }
}

export function registerBackupRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.get("/v1/backups/policy", async (request) => {
    requirePermission(request, "BACKUP");
    return getBackupPolicy(db, config);
  });

  app.put("/v1/backups/policy", async (request) => {
    const auth = requirePermission(request, "BACKUP");
    requireLocalDesktopFileAccess(request, config);
    const body = backupPolicySchema.parse(request.body);
    const policy = await updateBackupPolicy(db, config, body);
    const automatic = body.automaticEnabled === false ? { backup: null, policy } : await runAutomaticBackupIfDue(db, config, true);
    await audit(db, auth, "AUTOMATIC_BACKUP_POLICY_UPDATED", "BACKUP", "automatic-policy", {
      destinationPath: policy.destinationPath,
      intervalDays: policy.intervalDays,
      retentionDays: policy.retentionDays,
      automaticEnabled: policy.automaticEnabled,
      initialBackupPath: automatic.backup?.path ?? null,
    });
    return automatic;
  });

  app.post("/v1/backups", async (request, reply) => {
    const auth = requirePermission(request, "BACKUP");
    const body = request.body === undefined ? undefined : backupDestinationSchema.parse(request.body);
    if (body) requireLocalDesktopFileAccess(request, config);
    const result = await runBackup(db, config, auth.userId, body?.destinationPath);
    await audit(db, auth, "BACKUP_CREATED", "BACKUP", result.id, { fileName: basename(result.path), sizeBytes: result.sizeBytes, sha256: result.sha256, customDestination: Boolean(body) });
    return reply.status(201).send(result);
  });

  app.post("/v1/backups/import", async (request, reply) => {
    const auth = requirePermission(request, "BACKUP");
    requireLocalDesktopFileAccess(request, config);
    const body = backupImportSchema.parse(request.body);
    const result = await importBackup(db, config, auth.userId, body.sourcePath);
    await audit(db, auth, "BACKUP_IMPORTED", "BACKUP", result.id, { sourceFileName: basename(body.sourcePath), storedFileName: basename(result.path), sizeBytes: result.sizeBytes, sha256: result.sha256, schemaVersion: result.schemaVersion });
    return reply.status(201).send(result);
  });

  app.get("/v1/backups", async (request) => {
    requirePermission(request, "BACKUP");
    const result = await db.query("SELECT id, path, sha256, size_bytes, status, error_message, started_at, completed_at FROM backup_runs ORDER BY started_at DESC LIMIT 100");
    return { backups: result.rows };
  });

  app.post<{ Params: { id: string } }>("/v1/backups/:id/verify", async (request) => {
    requirePermission(request, "BACKUP");
    return verifyBackupRestore(db, config, request.params.id);
  });
}
