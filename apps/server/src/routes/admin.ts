import type { FastifyInstance } from "fastify";
import { branchSettingsRequestSchema, createTerminalRequestSchema, createUserRequestSchema, updateUserRequestSchema } from "@nabta/contracts";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { requireAuth, requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { runBackup } from "../backup.js";
import { hashPassword } from "../security.js";
import { ApiError } from "../errors.js";

export function registerAdminRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.get("/v1/store-info", async (request) => {
    const auth = requireAuth(request);
    const result = await db.query<{ store_name: string; receipt_phone: string; whatsapp_phone: string; social_handle: string; receipt_footer: string; logo_data_url: string }>(`
      SELECT ss.store_name, b.receipt_phone, b.whatsapp_phone, b.social_handle, b.receipt_footer, b.logo_data_url
      FROM terminals t JOIN branches b ON b.id = t.branch_id CROSS JOIN system_state ss
      WHERE t.id = $1
    `, [auth.terminalId]);
    if (!result.rows[0]) throw new ApiError(404, "STORE_NOT_FOUND", "تعذر العثور على بيانات المتجر");
    const row = result.rows[0];
    return { storeName: row.store_name, receiptPhone: row.receipt_phone, whatsappPhone: row.whatsapp_phone, socialHandle: row.social_handle, receiptFooter: row.receipt_footer, logoDataUrl: row.logo_data_url };
  });

  app.get("/v1/settings/branch", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const result = await db.query<{ credit_sales_enabled: boolean; prevent_expired_sales: boolean; name: string; store_name: string; receipt_phone: string; whatsapp_phone: string; social_handle: string; receipt_footer: string; logo_data_url: string }>(`
      SELECT b.name, b.credit_sales_enabled, b.prevent_expired_sales, b.receipt_phone, b.whatsapp_phone, b.social_handle, b.receipt_footer, b.logo_data_url, ss.store_name
      FROM terminals t JOIN branches b ON b.id = t.branch_id CROSS JOIN system_state ss WHERE t.id = $1
    `, [auth.terminalId]);
    if (!result.rows[0]) throw new ApiError(404, "BRANCH_NOT_FOUND", "تعذر العثور على إعدادات الفرع");
    const row = result.rows[0];
    return { name: row.name, storeName: row.store_name, creditSalesEnabled: row.credit_sales_enabled, preventExpiredSales: row.prevent_expired_sales, receiptPhone: row.receipt_phone, whatsappPhone: row.whatsapp_phone, socialHandle: row.social_handle, receiptFooter: row.receipt_footer, logoDataUrl: row.logo_data_url };
  });

  app.put("/v1/settings/branch", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = branchSettingsRequestSchema.parse(request.body);
    return transaction(db, async (client) => {
      const updated = await client.query<{ id: string }>(`
        UPDATE branches SET credit_sales_enabled = $2, prevent_expired_sales = $3, receipt_phone = $4, whatsapp_phone = $5, social_handle = $6, receipt_footer = $7, logo_data_url = $8
        WHERE id = (SELECT branch_id FROM terminals WHERE id = $1) RETURNING id
      `, [auth.terminalId, body.creditSalesEnabled, body.preventExpiredSales, body.receiptPhone, body.whatsappPhone, body.socialHandle, body.receiptFooter, body.logoDataUrl]);
      await client.query("UPDATE system_state SET store_name = $1 WHERE singleton", [body.storeName]);
      await audit(client, auth, "BRANCH_SETTINGS_UPDATED", "branch", updated.rows[0]!.id, { ...body, logoDataUrl: body.logoDataUrl ? "updated" : "none" });
      return { ...body };
    });
  });

  app.post("/v1/settings/data-reset", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = (request.body ?? {}) as { confirmationCode?: unknown };
    if (auth.role !== "OWNER") {
      throw new ApiError(403, "OWNER_REQUIRED", "إعادة بدء دورة العمل متاحة للمالك فقط");
    }
    if (typeof body.confirmationCode !== "string" || body.confirmationCode !== config.DATA_RESET_PIN) {
      throw new ApiError(403, "RESET_CODE_INVALID", "الرمز السري غير صحيح");
    }

    const openShift = await db.query<{ terminal_name: string }>(`
      SELECT t.name AS terminal_name
      FROM shifts s
      JOIN terminals t ON t.id = s.terminal_id
      WHERE s.status = 'OPEN'
      ORDER BY s.opened_at
      LIMIT 1
    `);
    if (openShift.rows[0]) {
      throw new ApiError(409, "OPEN_SHIFT_EXISTS", `أغلق الوردية المفتوحة على ${openShift.rows[0].terminal_name} أولًا قبل بدء دورة جديدة`);
    }

    // The backup is deliberately created before the destructive transaction.
    // A reset never starts when a recoverable restore point cannot be created.
    const backup = await runBackup(db, config, auth.userId, undefined, { runKind: "RESET" });

    const result = await transaction(db, async (client) => {
      const counts = await client.query<{
        sales: number;
        purchases: number;
        customers: number;
        shifts: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM sales) AS sales,
          (SELECT count(*)::int FROM purchase_receipts) AS purchases,
          (SELECT count(*)::int FROM customers) AS customers,
          (SELECT count(*)::int FROM shifts) AS shifts
      `);

      // Ledger rows are normally immutable.  Migration 009 allows this scoped,
      // transaction-local reset flag only for the owner-confirmed workflow.
      await client.query("SELECT set_config('nabta.data_reset_authorized', '1', true)");

      await client.query("DELETE FROM partner_document_payments");
      await client.query("DELETE FROM partner_documents");
      await client.query("DELETE FROM customer_ledger");
      await client.query("DELETE FROM supplier_ledger");
      await client.query("DELETE FROM refund_payments");
      await client.query("DELETE FROM sale_return_lines");
      await client.query("DELETE FROM sale_returns");
      await client.query("DELETE FROM sale_lot_allocations");
      await client.query("DELETE FROM payments");
      await client.query("DELETE FROM sale_lines");
      await client.query("DELETE FROM sales");
      await client.query("DELETE FROM quotes");
      await client.query("DELETE FROM cash_movements");
      await client.query("DELETE FROM shifts");
      await client.query("DELETE FROM purchase_receipt_lines");
      await client.query("DELETE FROM purchase_receipts");
      await client.query("DELETE FROM stock_counts");
      await client.query("DELETE FROM stock_lots");
      await client.query("DELETE FROM stock_movements");
      await client.query("DELETE FROM idempotency_requests");
      await client.query("DELETE FROM customers");

      // Keep products, barcodes, prices and the live stock balance.  Recreate
      // the lots and stock ledger as one opening balance per product so the
      // next sale still has a valid FEFO source and correct cost basis.
      await client.query(`
        INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli)
        SELECT warehouse_id, product_id, 'RESET-OPENING', qty_milli
        FROM stock_balances
        WHERE qty_milli > 0
      `);
      await client.query(`
        INSERT INTO stock_movements(
          warehouse_id, product_id, movement_type, qty_delta_milli,
          value_delta_minor, balance_qty_milli, balance_value_minor,
          reference_type, reference_id, actor_user_id, reason
        )
        SELECT warehouse_id, product_id, 'OPENING', qty_milli,
               inventory_value_minor, qty_milli, inventory_value_minor,
               'data_reset', gen_random_uuid(), $1, 'رصيد افتتاحي بعد بدء دورة جديدة'
        FROM stock_balances
        WHERE qty_milli > 0
      `, [auth.userId]);
      await client.query("UPDATE branches SET invoice_counter = 0");
      await client.query("UPDATE sessions SET revoked_at = now() WHERE id <> $1 AND revoked_at IS NULL", [auth.sessionId]);

      await audit(client, auth, "OPERATIONAL_DATA_RESET", "system", null, {
        sales: counts.rows[0]!.sales,
        purchases: counts.rows[0]!.purchases,
        customers: counts.rows[0]!.customers,
        shifts: counts.rows[0]!.shifts,
        backupPath: backup.path,
      });
      return counts.rows[0]!;
    });

    return { reset: true, backupPath: backup.path, removed: result };
  });

  app.post("/v1/users", async (request, reply) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = createUserRequestSchema.parse(request.body);
    const result = await transaction(db, async (client) => {
      const passwordHash = await hashPassword(body.password);
      const user = await client.query<{ id: string }>(`
        INSERT INTO users(display_name, username, password_hash, role, discount_limit_bps)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [body.displayName, body.username, passwordHash, body.role, body.discountLimitBps]);
      await audit(client, auth, "USER_CREATED", "user", user.rows[0]!.id, { role: body.role, discountLimitBps: body.discountLimitBps });
      return { id: user.rows[0]!.id };
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/users", async (request) => {
    requirePermission(request, "SETTINGS");
    const result = await db.query(`
      SELECT id, display_name AS "displayName", username, role, active,
             discount_limit_bps AS "discountLimitBps", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM users ORDER BY active DESC, display_name, username
    `);
    return { users: result.rows };
  });

  app.put<{ Params: { id: string } }>("/v1/users/:id", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = updateUserRequestSchema.parse(request.body);
    if (request.params.id === auth.userId && (!body.active || body.role !== auth.role)) {
      throw new ApiError(422, "SELF_LOCKOUT", "لا يمكنك تعطيل حسابك أو تغيير دوره من جلستك الحالية");
    }
    return transaction(db, async (client) => {
      const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!existing.rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "المستخدم غير موجود");
      const passwordHash = body.password ? await hashPassword(body.password) : null;
      await client.query(`UPDATE users SET display_name = $2, role = $3, discount_limit_bps = $4, active = $5,
        password_hash = COALESCE($6, password_hash), updated_at = now() WHERE id = $1`,
      [request.params.id, body.displayName, body.role, body.discountLimitBps, body.active, passwordHash]);
      if (!body.active) await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [request.params.id]);
      await audit(client, auth, "USER_UPDATED", "user", request.params.id, { role: body.role, active: body.active, discountLimitBps: body.discountLimitBps, passwordReset: Boolean(body.password) });
      return { id: request.params.id };
    });
  });

  app.get("/v1/audit", async (request) => {
    requirePermission(request, "SETTINGS");
    const rawLimit = Number((request.query as Record<string, unknown>).limit ?? 100);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 100;
    const result = await db.query(`
      SELECT al.id, al.action, al.entity_type AS "entityType", al.entity_id AS "entityId", al.reason,
             al.metadata, al.occurred_at AS "occurredAt", COALESCE(u.display_name, 'النظام') AS "actorName",
             t.name AS "terminalName"
      FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id LEFT JOIN terminals t ON t.id = al.terminal_id
      ORDER BY al.occurred_at DESC, al.id DESC LIMIT $1
    `, [limit]);
    return { entries: result.rows };
  });

  app.post("/v1/terminals", async (request, reply) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = createTerminalRequestSchema.parse(request.body);
    const result = await transaction(db, async (client) => {
      const current = await client.query<{ branch_id: string; warehouse_id: string }>("SELECT branch_id, warehouse_id FROM terminals WHERE id = $1", [auth.terminalId]);
      const terminal = await client.query<{ id: string }>("INSERT INTO terminals(branch_id, warehouse_id, name) VALUES ($1, $2, $3) RETURNING id", [current.rows[0]!.branch_id, current.rows[0]!.warehouse_id, body.name]);
      await audit(client, auth, "TERMINAL_CREATED", "terminal", terminal.rows[0]!.id, { name: body.name });
      return { id: terminal.rows[0]!.id, name: body.name };
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/terminals", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const result = await db.query(`SELECT other.id, other.name, other.active FROM terminals current
      JOIN terminals other ON other.branch_id = current.branch_id WHERE current.id = $1 ORDER BY other.name`, [auth.terminalId]);
    return { terminals: result.rows };
  });
}
