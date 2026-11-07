import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { getCloudMigrationChunk, getCloudMigrationManifest, prepareCloudMigration } from "../cloud-migration.js";
import { ApiError } from "../errors.js";

const prepareSchema = z.object({ chunkBytes: z.number().int().min(32 * 1024).max(512 * 1024).optional() }).strict();
const idSchema = z.string().uuid();
const sequenceSchema = z.coerce.number().int().min(0);

function requireLocalOwner(request: { ip: string; auth: { role: string } | null }): void {
  const loopback = request.ip === "127.0.0.1" || request.ip === "::1" || request.ip === "::ffff:127.0.0.1";
  if (!loopback) throw new ApiError(403, "CLOUD_MIGRATION_LOCAL_ONLY", "تجهيز نقل البيانات السحابي متاح من جهاز نبتة المصدر فقط");
  if (request.auth?.role !== "OWNER") throw new ApiError(403, "CLOUD_MIGRATION_OWNER_ONLY", "نقل بيانات المتجر للسحابة يحتاج حساب المالك");
}

export function registerCloudMigrationRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.post("/v1/cloud-migration/prepare", async (request, reply) => {
    const auth = requirePermission(request, "BACKUP");
    requireLocalOwner(request);
    const body = prepareSchema.parse(request.body ?? {});
    const manifest = await prepareCloudMigration(db, config, auth.userId, body.chunkBytes);
    await audit(db, auth, "CLOUD_MIGRATION_PREPARED", "CLOUD_MIGRATION", manifest.migrationId, {
      schemaVersion: manifest.schemaVersion,
      recordCount: manifest.recordCount,
      chunkCount: manifest.chunkCount,
      verifiedBackupId: manifest.backup.id,
      verifiedBackupSha256: manifest.backup.sha256,
    });
    return reply.status(201).send(manifest);
  });

  app.get<{ Params: { migrationId: string } }>("/v1/cloud-migration/:migrationId", async (request) => {
    requirePermission(request, "BACKUP");
    requireLocalOwner(request);
    return getCloudMigrationManifest(config, idSchema.parse(request.params.migrationId));
  });

  app.get<{ Params: { migrationId: string; sequence: string } }>("/v1/cloud-migration/:migrationId/chunks/:sequence", async (request) => {
    requirePermission(request, "BACKUP");
    requireLocalOwner(request);
    return getCloudMigrationChunk(config, idSchema.parse(request.params.migrationId), sequenceSchema.parse(request.params.sequence));
  });
}
