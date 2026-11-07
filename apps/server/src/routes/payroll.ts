import type { FastifyInstance } from "fastify";
import { financialMonthCloseRequestSchema, payrollEntryRequestSchema, payrollListQuerySchema } from "@nabta/contracts";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { ApiError } from "../errors.js";
import { audit } from "../audit.js";

function monthBounds(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { from, to: date.toISOString().slice(0, 10) };
}

async function expectedCash(client: { query: Database["query"] }, shiftId: string): Promise<number> {
  const result = await client.query<{ expected_cash_minor: number }>(`
    SELECT s.opening_minor
      + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales sa ON sa.id = p.sale_id WHERE sa.shift_id = s.id AND p.method = 'CASH'), 0)
      - COALESCE((SELECT sum(rp.amount_minor) FROM refund_payments rp JOIN sale_returns sr ON sr.id = rp.return_id WHERE sr.shift_id = s.id AND rp.method = 'CASH'), 0)
      + COALESCE((SELECT sum(CASE WHEN cm.type = 'DEPOSIT' THEN cm.amount_minor ELSE -cm.amount_minor END) FROM cash_movements cm WHERE cm.shift_id = s.id), 0)
      AS expected_cash_minor
    FROM shifts s WHERE s.id = $1
  `, [shiftId]);
  if (!result.rows[0]) throw new ApiError(404, "SHIFT_NOT_FOUND", "الوردية غير موجودة");
  return Number(result.rows[0].expected_cash_minor);
}

export function registerPayrollRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/payroll", async (request) => {
    requirePermission(request, "VIEW_PROFIT");
    const query = payrollListQuerySchema.parse(request.query);
    const { from, to } = monthBounds(query.month);
    const result = await db.query<{
      id: string; employee_name: string; employee_user_id: string; payroll_month: string; base_minor: number;
      overtime_minor: number; bonus_minor: number; deduction_minor: number; advance_minor: number; net_minor: number;
      payment_method: string; paid_on: string; note: string | null;
    }>(`
      SELECT pe.id, u.display_name employee_name, pe.employee_user_id, pe.payroll_month::text, pe.base_minor,
             pe.overtime_minor, pe.bonus_minor, pe.deduction_minor, pe.advance_minor, pe.net_minor,
             pe.payment_method, pe.paid_on::text, pe.note
      FROM payroll_entries pe JOIN users u ON u.id = pe.employee_user_id
      WHERE pe.payroll_month >= $1::date AND pe.payroll_month < $2::date
      ORDER BY u.display_name, pe.created_at
    `, [from, to]);
    return { month: query.month, items: result.rows.map((row) => ({
      id: row.id, employeeName: row.employee_name, employeeUserId: row.employee_user_id, payrollMonth: row.payroll_month,
      baseMinor: Number(row.base_minor), overtimeMinor: Number(row.overtime_minor), bonusMinor: Number(row.bonus_minor),
      deductionMinor: Number(row.deduction_minor), advanceMinor: Number(row.advance_minor), netMinor: Number(row.net_minor),
      paymentMethod: row.payment_method, paidOn: row.paid_on, note: row.note,
    })) };
  });

  app.post("/v1/payroll", async (request, reply) => {
    const auth = requirePermission(request, "VIEW_PROFIT");
    const body = payrollEntryRequestSchema.parse(request.body);
    const netMinor = body.baseMinor + body.overtimeMinor + body.bonusMinor - body.deductionMinor - body.advanceMinor;
    const result = await transaction(db, async (client) => {
      const employee = await client.query<{ id: string }>("SELECT id FROM users WHERE id = $1 AND active FOR UPDATE", [body.employeeUserId]);
      if (!employee.rows[0]) throw new ApiError(422, "EMPLOYEE_NOT_ACTIVE", "الموظف غير موجود أو غير نشط");
      let cashMovementId: string | null = null;
      if (body.paymentMethod === "CASH") {
        const shift = await client.query<{ id: string }>("SELECT id FROM shifts WHERE id = $1 AND terminal_id = $2 AND status = 'OPEN' FOR UPDATE", [body.shiftId, auth.terminalId]);
        if (!shift.rows[0]) throw new ApiError(409, "SHIFT_CLOSED", "دفع الراتب النقدي يحتاج وردية مفتوحة على نقطة البيع الحالية");
        if (netMinor > await expectedCash(client as never, body.shiftId!)) throw new ApiError(422, "INSUFFICIENT_CASH", "الرصيد النقدي في الدرج لا يكفي لدفع الراتب");
        const movement = await client.query<{ id: string }>(`
          INSERT INTO cash_movements(shift_id, user_id, type, amount_minor, reason)
          VALUES ($1, $2, 'EXPENSE', $3, $4) RETURNING id
        `, [body.shiftId, auth.userId, netMinor, `راتب ${body.payrollMonth}`]);
        cashMovementId = movement.rows[0]!.id;
      }
      const saved = await client.query<{ id: string; created_at: Date }>(`
        INSERT INTO payroll_entries(employee_user_id, payroll_month, base_minor, overtime_minor, bonus_minor, deduction_minor, advance_minor, net_minor, payment_method, cash_movement_id, paid_on, note, recorded_by_user_id)
        VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13) RETURNING id, created_at
      `, [body.employeeUserId, `${body.payrollMonth}-01`, body.baseMinor, body.overtimeMinor, body.bonusMinor, body.deductionMinor, body.advanceMinor, netMinor, body.paymentMethod, cashMovementId, body.paidOn, body.note ?? null, auth.userId]);
      await audit(client, auth, "PAYROLL_POSTED", "payroll_entry", saved.rows[0]!.id, { employeeUserId: body.employeeUserId, payrollMonth: body.payrollMonth, netMinor, paymentMethod: body.paymentMethod }, body.note);
      return { id: saved.rows[0]!.id, netMinor, createdAt: saved.rows[0]!.created_at.toISOString() };
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/financial-periods", async (request) => {
    requirePermission(request, "VIEW_PROFIT");
    const result = await db.query<{ id: string; period_month: string; closed_at: Date; closed_by: string; note: string | null }>(`
      SELECT c.id, c.period_month::text, c.closed_at, u.display_name closed_by, c.note
      FROM financial_period_closures c JOIN users u ON u.id = c.closed_by_user_id ORDER BY c.period_month DESC LIMIT 60
    `);
    return { items: result.rows.map((row) => ({ id: row.id, month: row.period_month.slice(0, 7), closedAt: row.closed_at.toISOString(), closedBy: row.closed_by, note: row.note })) };
  });

  app.post("/v1/financial-periods/close", async (request, reply) => {
    const auth = requirePermission(request, "VIEW_PROFIT");
    if (auth.role !== "OWNER" && auth.role !== "MANAGER") throw new ApiError(403, "FORBIDDEN", "إقفال الشهر متاح للمالك أو المدير فقط");
    const body = financialMonthCloseRequestSchema.parse(request.body);
    const { from, to } = monthBounds(body.month);
    const closed = await transaction(db, async (client) => {
      const summary = await client.query<{ net_sales_minor: number; payroll_minor: number; expenses_minor: number }>(`
        SELECT
          COALESCE((SELECT sum(total_minor) FROM sales WHERE (posted_at AT TIME ZONE 'Africa/Cairo')::date >= $1::date AND (posted_at AT TIME ZONE 'Africa/Cairo')::date < $2::date), 0)::bigint net_sales_minor,
          COALESCE((SELECT sum(net_minor) FROM payroll_entries WHERE payroll_month >= $1::date AND payroll_month < $2::date), 0)::bigint payroll_minor,
          COALESCE((SELECT sum(amount_minor) FROM cash_movements WHERE type = 'EXPENSE' AND (occurred_at AT TIME ZONE 'Africa/Cairo')::date >= $1::date AND (occurred_at AT TIME ZONE 'Africa/Cairo')::date < $2::date), 0)::bigint expenses_minor
      `, [from, to]);
      const saved = await client.query<{ id: string; closed_at: Date }>(`
        INSERT INTO financial_period_closures(period_month, closed_by_user_id, summary, note)
        VALUES ($1::date, $2, $3::jsonb, $4) RETURNING id, closed_at
      `, [`${body.month}-01`, auth.userId, JSON.stringify(summary.rows[0] ?? {}), body.note ?? null]);
      await audit(client, auth, "FINANCIAL_PERIOD_CLOSED", "financial_period", saved.rows[0]!.id, { month: body.month, summary: summary.rows[0] }, body.note);
      return { id: saved.rows[0]!.id, closedAt: saved.rows[0]!.closed_at.toISOString() };
    });
    return reply.status(201).send(closed);
  });
}
