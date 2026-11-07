import type { FastifyInstance } from "fastify";
import { terminalEnrollRequestSchema } from "@nabta/contracts";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";

function relayKeyMatches(value: unknown, expected: string | undefined): boolean {
  return typeof value === "string" && Boolean(expected) && value.length === expected!.length && value === expected;
}

/**
 * A new cashier has no session yet, so it cannot use the owner-only terminal
 * administration endpoint. Enrollment is intentionally narrow: the request
 * must first cross the Cloudflare terminal relay key and then present the
 * owner-selected six digit enrollment PIN. It can only create a till in the
 * primary terminal's existing branch and warehouse.
 */
export function registerTerminalEnrollmentRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.post("/v1/terminals/enroll", async (request, reply) => {
    if (!config.TERMINAL_RELAY_SHARED_SECRET || !relayKeyMatches(request.headers["x-nabta-terminal-relay-key"], config.TERMINAL_RELAY_SHARED_SECRET)) {
      throw new ApiError(403, "TERMINAL_RELAY_REQUIRED", "هذا المسار متاح فقط عبر رابط أجهزة نبتة الموثوق");
    }
    const body = terminalEnrollRequestSchema.parse(request.body);
    if (body.enrollmentPin !== config.TERMINAL_ENROLLMENT_PIN) {
      throw new ApiError(403, "TERMINAL_ENROLLMENT_PIN_INVALID", "رمز ربط الجهاز غير صحيح");
    }
    const result = await transaction(db, async (client) => {
      const primary = await client.query<{ branch_id: string; warehouse_id: string }>(
        "SELECT branch_id, warehouse_id FROM terminals WHERE active ORDER BY created_at, id LIMIT 1 FOR UPDATE",
      );
      if (!primary.rows[0]) throw new ApiError(409, "PRIMARY_TERMINAL_UNAVAILABLE", "لم يتم إعداد جهاز رئيسي صالح بعد");
      const existing = await client.query<{ branch_id: string; warehouse_id: string }>("SELECT branch_id, warehouse_id FROM terminals WHERE id = $1 FOR UPDATE", [body.terminalId]);
      if (existing.rows[0] && (existing.rows[0].branch_id !== primary.rows[0].branch_id || existing.rows[0].warehouse_id !== primary.rows[0].warehouse_id)) {
        throw new ApiError(409, "TERMINAL_ALREADY_BOUND", "هذا الجهاز مرتبط بمتجر آخر ولا يمكن ضمه تلقائيًا");
      }
      await client.query(`
        INSERT INTO terminals(id, branch_id, warehouse_id, name, active)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = true
      `, [body.terminalId, primary.rows[0].branch_id, primary.rows[0].warehouse_id, body.terminalName]);
      return { terminalId: body.terminalId, terminalName: body.terminalName };
    });
    return reply.status(201).send(result);
  });
}
