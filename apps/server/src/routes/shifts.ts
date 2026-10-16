import type { FastifyInstance } from "fastify";
import { cashMovementRequestSchema, closeShiftRequestSchema, openShiftRequestSchema, shiftHistoryQuerySchema } from "@nabta/contracts";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requireAuth, requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { verifyPassword } from "../security.js";

interface ShiftRow {
  id: string;
  terminal_id: string;
  user_id: string;
  status: "OPEN" | "CLOSED";
  opening_minor: number;
  opened_at: Date;
}

interface ShiftHistoryRow {
  id: string;
  cashier_name: string;
  terminal_name: string;
  status: "OPEN" | "CLOSED";
  opened_at: Date;
  closed_at: Date | null;
  opening_minor: number;
  expected_cash_minor: number;
  actual_cash_minor: number | null;
  difference_minor: number | null;
  invoice_count: number;
  sales_total_minor: number;
  close_note: string | null;
}

interface ShiftHistoryAuth {
  terminalId: string;
  userId: string;
  role: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function listShiftHistory(db: Database, auth: ShiftHistoryAuth, month: string) {
  const monthStart = `${month}-01`;
  const userScope = auth.role === "OWNER" || auth.role === "MANAGER" ? null : auth.userId;
  const result = await db.query<ShiftHistoryRow>(`
    SELECT s.id, u.display_name AS cashier_name, t.name AS terminal_name, s.status,
           s.opened_at, s.closed_at, s.opening_minor,
           COALESCE(s.expected_cash_minor, s.opening_minor
             + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales sa ON sa.id = p.sale_id WHERE sa.shift_id = s.id AND p.method = 'CASH'), 0)
             - COALESCE((SELECT sum(rp.amount_minor) FROM refund_payments rp JOIN sale_returns sr ON sr.id = rp.return_id WHERE sr.shift_id = s.id AND rp.method = 'CASH'), 0)
             + COALESCE((SELECT sum(CASE WHEN cm.type = 'DEPOSIT' THEN cm.amount_minor ELSE -cm.amount_minor END) FROM cash_movements cm WHERE cm.shift_id = s.id), 0)
           ) AS expected_cash_minor,
           s.actual_cash_minor, s.difference_minor,
           COALESCE((SELECT count(*)::int FROM sales sa WHERE sa.shift_id = s.id), 0) AS invoice_count,
           COALESCE((SELECT sum(sa.total_minor) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_total_minor,
           s.close_note
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    JOIN terminals t ON t.id = s.terminal_id
    WHERE s.terminal_id = $1
      AND s.opened_at >= ($2::date AT TIME ZONE 'Africa/Cairo')
      AND s.opened_at < ($3::date AT TIME ZONE 'Africa/Cairo')
      AND ($4::uuid IS NULL OR s.user_id = $4)
    ORDER BY s.opened_at DESC
  `, [auth.terminalId, monthStart, nextMonth(month), userScope]);
  return result.rows.map((row) => ({
    id: row.id,
    cashierName: row.cashier_name,
    terminalName: row.terminal_name,
    status: row.status,
    openedAt: toIso(row.opened_at),
    closedAt: row.closed_at ? toIso(row.closed_at) : null,
    openingMinor: row.opening_minor,
    expectedCashMinor: row.expected_cash_minor,
    actualCashMinor: row.actual_cash_minor,
    differenceMinor: row.difference_minor,
    invoiceCount: row.invoice_count,
    salesTotalMinor: row.sales_total_minor,
    closeNote: row.close_note,
  }));
}

async function expectedCash(client: { query: Database["query"] }, shiftId: string): Promise<number> {
  const result = await client.query<{ expected: number }>(`
    SELECT s.opening_minor
      + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales sa ON sa.id = p.sale_id WHERE sa.shift_id = s.id AND p.method = 'CASH'), 0)
      - COALESCE((SELECT sum(rp.amount_minor) FROM refund_payments rp JOIN sale_returns sr ON sr.id = rp.return_id WHERE sr.shift_id = s.id AND rp.method = 'CASH'), 0)
      + COALESCE((SELECT sum(CASE WHEN cm.type = 'DEPOSIT' THEN cm.amount_minor ELSE -cm.amount_minor END) FROM cash_movements cm WHERE cm.shift_id = s.id), 0)
      AS expected
    FROM shifts s WHERE s.id = $1
  `, [shiftId]);
  if (!result.rows[0]) throw new ApiError(404, "SHIFT_NOT_FOUND", "الوردية غير موجودة");
  return result.rows[0].expected;
}

export function registerShiftRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/shifts/current", async (request) => {
    const auth = requireAuth(request);
    const result = await db.query<ShiftRow>("SELECT * FROM shifts WHERE terminal_id = $1 AND user_id = $2 AND status = 'OPEN'", [auth.terminalId, auth.userId]);
    const shift = result.rows[0];
    if (!shift) return { shift: null };
    return { shift: { id: shift.id, terminalId: shift.terminal_id, openingMinor: shift.opening_minor, openedAt: shift.opened_at.toISOString(), expectedCashMinor: await expectedCash(db, shift.id) } };
  });

  app.post("/v1/shifts", async (request, reply) => {
    const auth = requirePermission(request, "SHIFT_OPEN");
    const body = openShiftRequestSchema.parse(request.body);
    if (body.terminalId !== auth.terminalId) throw new ApiError(403, "TERMINAL_MISMATCH", "الجلسة مرتبطة بنقطة بيع أخرى");
    const response = await transaction(db, async (client) => {
      const existing = await client.query("SELECT id FROM shifts WHERE terminal_id = $1 AND status = 'OPEN' FOR UPDATE", [auth.terminalId]);
      if ((existing.rowCount ?? 0) > 0) throw new ApiError(409, "SHIFT_ALREADY_OPEN", "توجد وردية مفتوحة بالفعل على نقطة البيع");
      const result = await client.query<{ id: string; opened_at: Date }>(`
        INSERT INTO shifts(terminal_id, user_id, opening_minor) VALUES ($1, $2, $3) RETURNING id, opened_at
      `, [auth.terminalId, auth.userId, body.openingMinor]);
      await audit(client, auth, "SHIFT_OPENED", "shift", result.rows[0]!.id, { openingMinor: body.openingMinor });
      return { id: result.rows[0]!.id, openingMinor: body.openingMinor, openedAt: result.rows[0]!.opened_at.toISOString() };
    });
    return reply.status(201).send(response);
  });

  app.post<{ Params: { id: string } }>("/v1/shifts/:id/cash-movements", async (request, reply) => {
    const auth = requirePermission(request, "CASH_MOVE");
    const body = cashMovementRequestSchema.parse(request.body);
    const response = await transaction(db, async (client) => {
      const shift = await client.query<ShiftRow>("SELECT * FROM shifts WHERE id = $1 AND terminal_id = $2 FOR UPDATE", [request.params.id, auth.terminalId]);
      if (!shift.rows[0] || shift.rows[0].status !== "OPEN") throw new ApiError(409, "SHIFT_CLOSED", "لا يمكن تسجيل حركة على وردية مغلقة");
      if (body.type !== "DEPOSIT" && body.amountMinor > await expectedCash(client as never, request.params.id)) {
        throw new ApiError(422, "INSUFFICIENT_CASH", "القيمة أكبر من النقدية المتوقعة في الدرج");
      }
      const movement = await client.query<{ id: string; occurred_at: Date }>(`
        INSERT INTO cash_movements(shift_id, user_id, type, amount_minor, reason)
        VALUES ($1, $2, $3, $4, $5) RETURNING id, occurred_at
      `, [request.params.id, auth.userId, body.type, body.amountMinor, body.reason]);
      await audit(client, auth, "CASH_MOVEMENT_POSTED", "cash_movement", movement.rows[0]!.id, { type: body.type, amountMinor: body.amountMinor }, body.reason);
      return { id: movement.rows[0]!.id, occurredAt: movement.rows[0]!.occurred_at.toISOString() };
    });
    return reply.status(201).send(response);
  });

  app.post<{ Params: { id: string } }>("/v1/shifts/:id/close", async (request) => {
    const auth = requirePermission(request, "SHIFT_CLOSE");
    const body = closeShiftRequestSchema.parse(request.body);
    return transaction(db, async (client) => {
      const shift = await client.query<ShiftRow>("SELECT * FROM shifts WHERE id = $1 AND terminal_id = $2 FOR UPDATE", [request.params.id, auth.terminalId]);
      if (!shift.rows[0] || shift.rows[0].status !== "OPEN") throw new ApiError(409, "SHIFT_CLOSED", "الوردية مغلقة بالفعل أو غير موجودة");
      const expected = await expectedCash(client as never, request.params.id);
      const difference = body.actualCashMinor - expected;
      let approvedBy: string | null = auth.role === "OWNER" || auth.role === "MANAGER" ? auth.userId : null;
      if (difference !== 0 && !approvedBy) {
        if (!body.managerUsername || !body.managerPassword) throw new ApiError(403, "MANAGER_APPROVAL_REQUIRED", "فرق الدرج يحتاج اعتماد مدير بحسابه");
        const manager = await client.query<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE lower(username) = lower($1) AND active AND role IN ('OWNER','MANAGER')", [body.managerUsername]);
        if (!manager.rows[0] || !(await verifyPassword(body.managerPassword, manager.rows[0].password_hash))) throw new ApiError(403, "MANAGER_APPROVAL_FAILED", "بيانات اعتماد المدير غير صحيحة");
        approvedBy = manager.rows[0].id;
      }
      await client.query(`UPDATE shifts SET status = 'CLOSED', closed_at = now(), expected_cash_minor = $2,
        actual_cash_minor = $3, difference_minor = $4, close_note = $5, approved_by = $6 WHERE id = $1`,
      [request.params.id, expected, body.actualCashMinor, difference, body.note ?? null, approvedBy]);
      await audit(client, auth, "SHIFT_CLOSED", "shift", request.params.id, { expectedCashMinor: expected, actualCashMinor: body.actualCashMinor, differenceMinor: difference, approvedBy }, body.note);
      return { id: request.params.id, expectedCashMinor: expected, actualCashMinor: body.actualCashMinor, differenceMinor: difference, closedAt: new Date().toISOString() };
    });
  });

  app.get("/v1/shifts/history", async (request) => {
    const auth = requireAuth(request);
    const query = shiftHistoryQuerySchema.parse(request.query);
    return { month: query.month, items: await listShiftHistory(db, auth, query.month) };
  });

  app.get("/v1/shifts/export-data", async (request) => {
    const auth = requirePermission(request, "EXPORT");
    const query = shiftHistoryQuerySchema.parse(request.query);
    const [store, items] = await Promise.all([
      db.query<{ store_name: string }>("SELECT store_name FROM system_state WHERE singleton"),
      listShiftHistory(db, auth, query.month),
    ]);
    return {
      storeName: store.rows[0]?.store_name ?? "الشيماء",
      month: query.month,
      generatedAt: new Date().toISOString(),
      items,
    };
  });
}

export { expectedCash };
