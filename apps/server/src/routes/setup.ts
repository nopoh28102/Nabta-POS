import type { FastifyInstance } from "fastify";
import { setupRequestSchema } from "@nabta/contracts";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { audit } from "../audit.js";
import { hashPassword } from "../security.js";

export function registerSetupRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.get("/v1/discovery/terminals", async () => {
    const result = await db.query<{ id: string; name: string }>("SELECT id, name FROM terminals WHERE active ORDER BY created_at");
    return { terminals: result.rows };
  });
  app.get("/v1/setup/status", async () => {
    const result = await db.query<{ setup_completed: boolean }>("SELECT setup_completed FROM system_state WHERE singleton");
    return { setupCompleted: result.rows[0]?.setup_completed ?? false };
  });

  app.post("/v1/setup", async (request, reply) => {
    const body = setupRequestSchema.parse(request.body);
    if (body.setupToken !== config.SETUP_TOKEN) throw new ApiError(403, "SETUP_TOKEN_INVALID", "رمز إعداد الخادم غير صحيح");
    const response = await transaction(db, async (client) => {
      const state = await client.query<{ setup_completed: boolean }>("SELECT setup_completed FROM system_state WHERE singleton FOR UPDATE");
      if (state.rows[0]?.setup_completed) throw new ApiError(409, "SETUP_COMPLETED", "تم إعداد هذا الخادم بالفعل");
      const branch = await client.query<{ id: string }>("INSERT INTO branches(name) VALUES ($1) RETURNING id", [body.branchName]);
      const branchId = branch.rows[0]!.id;
      const warehouse = await client.query<{ id: string }>("INSERT INTO warehouses(branch_id, name, is_default) VALUES ($1, $2, true) RETURNING id", [branchId, "المخزن الرئيسي"]);
      const warehouseId = warehouse.rows[0]!.id;
      const terminal = await client.query<{ id: string }>("INSERT INTO terminals(branch_id, warehouse_id, name) VALUES ($1, $2, $3) RETURNING id", [branchId, warehouseId, body.terminalName]);
      const passwordHash = await hashPassword(body.password);
      const owner = await client.query<{ id: string }>(`
        INSERT INTO users(display_name, username, password_hash, role, discount_limit_bps)
        VALUES ($1, $2, $3, 'OWNER', 10000) RETURNING id
      `, [body.ownerName, body.username, passwordHash]);
      await client.query("UPDATE system_state SET setup_completed = true, store_name = $1 WHERE singleton", [body.storeName]);
      await audit(client, { userId: owner.rows[0]!.id, terminalId: terminal.rows[0]!.id }, "SETUP_COMPLETED", "system", "singleton", { branchId, warehouseId });
      return { branchId, warehouseId, terminalId: terminal.rows[0]!.id };
    });
    return reply.status(201).send(response);
  });
}
