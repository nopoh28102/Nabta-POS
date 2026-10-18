import type { FastifyInstance } from "fastify";
import { reportQuerySchema } from "@nabta/contracts";
import type { Database } from "../db.js";
import { requireAuth, requirePermission } from "../auth.js";

interface SummaryRow {
  gross_sales_minor: number;
  discounts_minor: number;
  returns_minor: number;
  net_sales_minor: number;
  gross_cogs_minor: number;
  returned_cogs_minor: number;
  net_cogs_minor: number;
  damaged_loss_minor: number;
  expenses_minor: number;
  gross_profit_minor: number;
  estimated_net_profit_minor: number;
  invoice_count: number;
}

export function registerReportRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/reports/summary", async (request) => {
    const auth = requirePermission(request, "VIEW_PROFIT");
    const filters = reportQuerySchema.parse(request.query);
    const result = await db.query<SummaryRow>(`
      WITH filtered_sales AS (
        SELECT s.* FROM sales s
        WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR s.branch_id = $3)
          AND ($4::uuid IS NULL OR s.terminal_id = $4)
          AND ($5::payment_method IS NULL OR EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.method = $5))
      ), sale_totals AS (
        SELECT COALESCE(sum(subtotal_minor),0)::bigint AS gross_sales,
               COALESCE(sum(discount_minor),0)::bigint AS discounts,
               COALESCE(sum(total_minor),0)::bigint AS sale_net,
               COALESCE(sum(cost_minor),0)::bigint AS gross_cogs,
               count(*)::bigint AS invoice_count
        FROM filtered_sales
      ), return_totals AS (
        SELECT COALESCE(sum(sr.total_refund_minor),0)::bigint AS returns,
               COALESCE(sum(sr.cost_reversal_minor),0)::bigint AS returned_cogs
        FROM sale_returns sr JOIN filtered_sales fs ON fs.id = sr.sale_id
        WHERE (sr.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
      ), losses AS (
        SELECT COALESCE(sum(srl.cost_minor),0)::bigint AS damaged
        FROM sale_return_lines srl JOIN sale_returns sr ON sr.id = srl.return_id
        JOIN filtered_sales fs ON fs.id = sr.sale_id
        WHERE srl.condition = 'DAMAGED'
          AND (sr.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
      ), expenses AS (
        SELECT COALESCE(sum(cm.amount_minor),0)::bigint AS expenses
        FROM cash_movements cm JOIN shifts sh ON sh.id = cm.shift_id JOIN terminals t ON t.id = sh.terminal_id
        WHERE cm.type = 'EXPENSE' AND (cm.occurred_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR t.branch_id = $3) AND ($4::uuid IS NULL OR t.id = $4)
      )
      SELECT st.gross_sales AS gross_sales_minor, st.discounts AS discounts_minor, rt.returns AS returns_minor,
             st.sale_net - rt.returns AS net_sales_minor, st.gross_cogs AS gross_cogs_minor,
             rt.returned_cogs AS returned_cogs_minor, st.gross_cogs - rt.returned_cogs AS net_cogs_minor,
             l.damaged AS damaged_loss_minor, e.expenses AS expenses_minor,
             (st.sale_net - rt.returns) - (st.gross_cogs - rt.returned_cogs) AS gross_profit_minor,
             (st.sale_net - rt.returns) - (st.gross_cogs - rt.returned_cogs) - l.damaged - e.expenses AS estimated_net_profit_minor,
             st.invoice_count
      FROM sale_totals st CROSS JOIN return_totals rt CROSS JOIN losses l CROSS JOIN expenses e
    `, [filters.from, filters.to, filters.branchId ?? null, filters.terminalId ?? null, filters.paymentMethod ?? null]);
    const stock = await db.query<{ qty_milli: number; inventory_value_minor: number; low_count: number }>(`
      SELECT COALESCE(sum(sb.qty_milli),0)::bigint AS qty_milli,
             COALESCE(sum(sb.inventory_value_minor),0)::bigint AS inventory_value_minor,
             count(*) FILTER (WHERE sb.qty_milli <= p.reorder_level_milli)::bigint AS low_count
      FROM stock_balances sb JOIN products p ON p.id = sb.product_id JOIN warehouses w ON w.id = sb.warehouse_id
      JOIN terminals t ON t.warehouse_id = w.id WHERE t.id = $1
    `, [auth.terminalId]);
    return { period: { from: filters.from, to: filters.to, timezone: "Africa/Cairo" }, ...result.rows[0], stock: stock.rows[0] };
  });

  app.get("/v1/reports/reconciliation", async (request) => {
    requirePermission(request, "VIEW_PROFIT");
    const filters = reportQuerySchema.parse(request.query);
    const result = await db.query(`
      SELECT s.id, s.invoice_no, s.total_minor,
        COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.sale_id = s.id),0)::bigint AS payment_minor,
        COALESCE((SELECT sum(sl.net_minor) FROM sale_lines sl WHERE sl.sale_id = s.id),0)::bigint AS lines_minor
      FROM sales s
      WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
        AND (s.total_minor <> COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.sale_id = s.id),0)
          OR s.total_minor <> COALESCE((SELECT sum(sl.net_minor) FROM sale_lines sl WHERE sl.sale_id = s.id),0))
    `, [filters.from, filters.to]);
    const stock = await db.query(`
      SELECT sb.warehouse_id, sb.product_id, sb.qty_milli, sb.inventory_value_minor,
             latest.balance_qty_milli AS ledger_qty_milli, latest.balance_value_minor AS ledger_value_minor
      FROM stock_balances sb
      LEFT JOIN LATERAL (SELECT balance_qty_milli, balance_value_minor FROM stock_movements sm
        WHERE sm.warehouse_id = sb.warehouse_id AND sm.product_id = sb.product_id ORDER BY occurred_at DESC, id DESC LIMIT 1) latest ON true
      WHERE latest.balance_qty_milli IS DISTINCT FROM sb.qty_milli OR latest.balance_value_minor IS DISTINCT FROM sb.inventory_value_minor
    `);
    return { ok: result.rows.length === 0 && stock.rows.length === 0, invoiceMismatches: result.rows, stockMismatches: stock.rows };
  });

  app.get("/v1/pos/metrics", async (request) => {
    requireAuth(request);
    const salesToday = await db.query<{ today_sales_minor: string | null; today_invoice_count: number; today_customer_count: number }>(`
      SELECT
        COALESCE(SUM(total_minor), 0)::bigint AS today_sales_minor,
        COUNT(*)::int AS today_invoice_count,
        COUNT(DISTINCT COALESCE(customer_id::text, id::text))::int AS today_customer_count
      FROM sales
      WHERE (posted_at AT TIME ZONE 'Africa/Cairo')::date = CURRENT_DATE
    `);
    const productsCount = await db.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM products WHERE active = true
    `);
    const customersCount = await db.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM customers WHERE active = true
    `);
    const s = salesToday.rows[0];
    const todayInvoiceCount = Number(s?.today_invoice_count ?? 0);
    return {
      todaySalesMinor: Number(s?.today_sales_minor ?? 0),
      todayInvoiceCount,
      totalProductsCount: Number(productsCount.rows[0]?.count ?? 0),
      todayCustomerCount: todayInvoiceCount > 0
        ? Number(s?.today_customer_count ?? 0)
        : Number(customersCount.rows[0]?.count ?? 0),
    };
  });
}
