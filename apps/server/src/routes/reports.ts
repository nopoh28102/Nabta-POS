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
  payroll_minor: number;
  shop_consumption_minor: number;
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
        LEFT JOIN shop_consumptions sc ON sc.cash_movement_id = cm.id
        WHERE cm.type = 'EXPENSE' AND COALESCE(sc.consumed_on, (cm.occurred_at AT TIME ZONE 'Africa/Cairo')::date) BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR t.branch_id = $3) AND ($4::uuid IS NULL OR t.id = $4)
          AND NOT EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.cash_movement_id = cm.id)
      ), payroll AS (
        SELECT COALESCE(sum(pe.net_minor),0)::bigint AS payroll
        FROM payroll_entries pe WHERE pe.payroll_month BETWEEN date_trunc('month', $1::date)::date AND date_trunc('month', $2::date)::date
      ), consumptions AS (
        SELECT COALESCE(sum(cm.amount_minor),0)::bigint AS consumption
        FROM shop_consumptions sc JOIN cash_movements cm ON cm.id = sc.cash_movement_id JOIN shifts sh ON sh.id = cm.shift_id
        WHERE sc.consumed_on BETWEEN $1::date AND $2::date
      )
      SELECT st.gross_sales AS gross_sales_minor, st.discounts AS discounts_minor, rt.returns AS returns_minor,
             st.sale_net - rt.returns AS net_sales_minor, st.gross_cogs AS gross_cogs_minor,
             rt.returned_cogs AS returned_cogs_minor, st.gross_cogs - rt.returned_cogs AS net_cogs_minor,
             l.damaged AS damaged_loss_minor, e.expenses AS expenses_minor, p.payroll AS payroll_minor, c.consumption AS shop_consumption_minor,
             (st.sale_net - rt.returns) - (st.gross_cogs - rt.returned_cogs) AS gross_profit_minor,
             (st.sale_net - rt.returns) - (st.gross_cogs - rt.returned_cogs) - l.damaged - e.expenses - p.payroll AS estimated_net_profit_minor,
             st.invoice_count
      FROM sale_totals st CROSS JOIN return_totals rt CROSS JOIN losses l CROSS JOIN expenses e CROSS JOIN payroll p CROSS JOIN consumptions c
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

  app.get("/v1/reports/comprehensive", async (request) => {
    const auth = requirePermission(request, "VIEW_PROFIT");
    const filters = reportQuerySchema.parse(request.query);
    const params = [filters.from, filters.to, filters.branchId ?? null, filters.terminalId ?? null, filters.paymentMethod ?? null];
    const [summaryResult, dailyResult, paymentResult, productResult, categoryResult, inventoryResult, storeResult, expenseCategoryResult, consumptionResult, payrollResult] = await Promise.all([
      db.query<SummaryRow>(`
        WITH filtered_sales AS (
          SELECT s.* FROM sales s WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
            AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::uuid IS NULL OR s.terminal_id = $4)
            AND ($5::payment_method IS NULL OR EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.method = $5))
        ), sale_totals AS (
          SELECT COALESCE(sum(subtotal_minor),0)::bigint gross_sales, COALESCE(sum(discount_minor),0)::bigint discounts,
            COALESCE(sum(total_minor),0)::bigint sale_net, COALESCE(sum(cost_minor),0)::bigint gross_cogs, count(*)::bigint invoice_count FROM filtered_sales
        ), return_totals AS (
          SELECT COALESCE(sum(sr.total_refund_minor),0)::bigint returns, COALESCE(sum(sr.cost_reversal_minor),0)::bigint returned_cogs
          FROM sale_returns sr JOIN filtered_sales fs ON fs.id = sr.sale_id WHERE (sr.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
        ), losses AS (
          SELECT COALESCE(sum(srl.cost_minor),0)::bigint damaged FROM sale_return_lines srl JOIN sale_returns sr ON sr.id = srl.return_id
          JOIN filtered_sales fs ON fs.id = sr.sale_id WHERE srl.condition = 'DAMAGED' AND (sr.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
        ), expenses AS (
          SELECT COALESCE(sum(cm.amount_minor),0)::bigint expenses FROM cash_movements cm JOIN shifts sh ON sh.id = cm.shift_id JOIN terminals t ON t.id = sh.terminal_id
          LEFT JOIN shop_consumptions sc ON sc.cash_movement_id = cm.id
          WHERE cm.type = 'EXPENSE' AND COALESCE(sc.consumed_on, (cm.occurred_at AT TIME ZONE 'Africa/Cairo')::date) BETWEEN $1::date AND $2::date
            AND ($3::uuid IS NULL OR t.branch_id = $3) AND ($4::uuid IS NULL OR t.id = $4)
            AND NOT EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.cash_movement_id = cm.id)
        ), payroll AS (
          SELECT COALESCE(sum(net_minor),0)::bigint payroll FROM payroll_entries
          WHERE payroll_month BETWEEN date_trunc('month', $1::date)::date AND date_trunc('month', $2::date)::date
        ), consumptions AS (
          SELECT COALESCE(sum(cm.amount_minor),0)::bigint consumption
          FROM shop_consumptions sc JOIN cash_movements cm ON cm.id = sc.cash_movement_id
          WHERE sc.consumed_on BETWEEN $1::date AND $2::date
        ) SELECT st.gross_sales gross_sales_minor, st.discounts discounts_minor, rt.returns returns_minor,
          st.sale_net - rt.returns net_sales_minor, st.gross_cogs gross_cogs_minor, rt.returned_cogs returned_cogs_minor,
          st.gross_cogs - rt.returned_cogs net_cogs_minor, l.damaged damaged_loss_minor, e.expenses expenses_minor,
          p.payroll payroll_minor, c.consumption shop_consumption_minor,
          (st.sale_net - rt.returns) - (st.gross_cogs - rt.returned_cogs) gross_profit_minor,
          (st.sale_net - rt.returns) - (st.gross_cogs - rt.returned_cogs) - l.damaged - e.expenses - p.payroll estimated_net_profit_minor, st.invoice_count
        FROM sale_totals st CROSS JOIN return_totals rt CROSS JOIN losses l CROSS JOIN expenses e CROSS JOIN payroll p CROSS JOIN consumptions c`, params),
      db.query<{ date: string; net_sales_minor: number; gross_profit_minor: number; invoice_count: number }>(`
        SELECT (s.posted_at AT TIME ZONE 'Africa/Cairo')::date::text date,
          COALESCE(sum(s.total_minor),0)::bigint net_sales_minor, COALESCE(sum(s.total_minor - s.cost_minor),0)::bigint gross_profit_minor, count(*)::bigint invoice_count
        FROM sales s WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::uuid IS NULL OR s.terminal_id = $4)
          AND ($5::payment_method IS NULL OR EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.method = $5))
        GROUP BY 1 ORDER BY 1`, params),
      db.query<{ method: string; amount_minor: number; transaction_count: number }>(`
        SELECT p.method::text method, COALESCE(sum(p.amount_minor),0)::bigint amount_minor, count(*)::bigint transaction_count
        FROM payments p JOIN sales s ON s.id = p.sale_id WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::uuid IS NULL OR s.terminal_id = $4) AND ($5::payment_method IS NULL OR p.method = $5)
        GROUP BY p.method ORDER BY amount_minor DESC`, params),
      db.query<{ name_ar: string; category: string; net_qty_milli: number; net_sales_minor: number; gross_profit_minor: number }>(`
        SELECT sl.name_snapshot name_ar, COALESCE(p.category, 'بيع مباشر غير مسجل') category, COALESCE(sum(sl.qty_milli - sl.returned_qty_milli),0)::bigint net_qty_milli,
          COALESCE(sum(sl.net_minor - sl.refunded_minor),0)::bigint net_sales_minor, COALESCE(sum((sl.net_minor - sl.refunded_minor) - (sl.cost_minor - sl.returned_cost_minor)),0)::bigint gross_profit_minor
        FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id LEFT JOIN products p ON p.id = sl.product_id
        WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::uuid IS NULL OR s.terminal_id = $4)
          AND ($5::payment_method IS NULL OR EXISTS (SELECT 1 FROM payments pay WHERE pay.sale_id = s.id AND pay.method = $5))
        GROUP BY sl.name_snapshot, p.category ORDER BY net_sales_minor DESC, sl.name_snapshot LIMIT 20`, params),
      db.query<{ category: string; net_sales_minor: number; gross_profit_minor: number }>(`
        SELECT COALESCE(p.category, 'بيع مباشر غير مسجل') category, COALESCE(sum(sl.net_minor - sl.refunded_minor),0)::bigint net_sales_minor,
          COALESCE(sum((sl.net_minor - sl.refunded_minor) - (sl.cost_minor - sl.returned_cost_minor)),0)::bigint gross_profit_minor
        FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id LEFT JOIN products p ON p.id = sl.product_id
        WHERE (s.posted_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::uuid IS NULL OR s.terminal_id = $4)
          AND ($5::payment_method IS NULL OR EXISTS (SELECT 1 FROM payments pay WHERE pay.sale_id = s.id AND pay.method = $5))
        GROUP BY p.category ORDER BY net_sales_minor DESC, p.category LIMIT 20`, params),
      db.query<{ inventory_value_minor: number; low_stock_count: number; out_of_stock_count: number; active_product_count: number }>(`
        SELECT COALESCE(sum(sb.inventory_value_minor),0)::bigint inventory_value_minor,
          count(*) FILTER (WHERE sb.qty_milli <= p.reorder_level_milli)::bigint low_stock_count,
          count(*) FILTER (WHERE sb.qty_milli = 0)::bigint out_of_stock_count,
          (SELECT count(*)::bigint FROM products WHERE active) active_product_count
        FROM stock_balances sb JOIN products p ON p.id = sb.product_id JOIN terminals t ON t.warehouse_id = sb.warehouse_id WHERE t.id = $1`, [auth.terminalId]),
      db.query<{ store_name: string }>("SELECT store_name FROM system_state WHERE singleton"),
      db.query<{ category: string; amount_minor: number; item_count: number }>(`
        SELECT COALESCE(sc.category, cm.expense_category) category, COALESCE(sum(cm.amount_minor),0)::bigint amount_minor, count(*)::int item_count
        FROM cash_movements cm LEFT JOIN shop_consumptions sc ON sc.cash_movement_id = cm.id
        WHERE cm.type = 'EXPENSE' AND COALESCE(sc.consumed_on, (cm.occurred_at AT TIME ZONE 'Africa/Cairo')::date) BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.cash_movement_id = cm.id)
        GROUP BY 1 ORDER BY amount_minor DESC`, [filters.from, filters.to]),
      db.query<{ date: string; item_name: string; category: string; amount_minor: number }>(`
        SELECT sc.consumed_on::text date, sc.item_name, sc.category, cm.amount_minor
        FROM shop_consumptions sc JOIN cash_movements cm ON cm.id = sc.cash_movement_id
        WHERE sc.consumed_on BETWEEN $1::date AND $2::date ORDER BY sc.consumed_on DESC, sc.created_at DESC LIMIT 500`, [filters.from, filters.to]),
      db.query<{ employee_name: string; payroll_label: string; net_minor: number; payment_method: string; paid_on: string }>(`
        SELECT u.display_name employee_name, pe.payroll_month::text payroll_label, pe.net_minor, pe.payment_method, pe.paid_on::text
        FROM payroll_entries pe JOIN users u ON u.id = pe.employee_user_id
        WHERE pe.payroll_month BETWEEN date_trunc('month', $1::date)::date AND date_trunc('month', $2::date)::date
        ORDER BY pe.payroll_month, u.display_name`, [filters.from, filters.to]),
    ]);
    const summary = summaryResult.rows[0]!;
    const inventory = inventoryResult.rows[0] ?? { inventory_value_minor: 0, low_stock_count: 0, out_of_stock_count: 0, active_product_count: 0 };
    const insights: string[] = [];
    if (Number(summary.invoice_count) === 0) insights.push("لا توجد فواتير مسجلة ضمن الفترة المختارة.");
    else {
      insights.push(`متوسط الفاتورة: ${Math.round(Number(summary.net_sales_minor) / Number(summary.invoice_count))} قرش.`);
      if (Number(summary.returns_minor) > 0) insights.push(`المرتجعات تمثل ${((Number(summary.returns_minor) * 100) / Math.max(1, Number(summary.gross_sales_minor))).toFixed(1)}% من إجمالي المبيعات.`);
      if (Number(inventory.low_stock_count) > 0) insights.push(`يوجد ${Number(inventory.low_stock_count)} صنف عند أو تحت حد إعادة الطلب.`);
    }
    return {
      storeName: storeResult.rows[0]?.store_name ?? "نبتة", generatedAt: new Date().toISOString(), period: { from: filters.from, to: filters.to, timezone: "Africa/Cairo" as const },
      summary: { grossSalesMinor: Number(summary.gross_sales_minor), discountsMinor: Number(summary.discounts_minor), returnsMinor: Number(summary.returns_minor), netSalesMinor: Number(summary.net_sales_minor), netCogsMinor: Number(summary.net_cogs_minor), grossProfitMinor: Number(summary.gross_profit_minor), estimatedNetProfitMinor: Number(summary.estimated_net_profit_minor), expensesMinor: Number(summary.expenses_minor), payrollMinor: Number(summary.payroll_minor), operatingExpensesMinor: Number(summary.expenses_minor), shopConsumptionMinor: Number(summary.shop_consumption_minor), damagedLossMinor: Number(summary.damaged_loss_minor), invoiceCount: Number(summary.invoice_count) },
      dailySales: dailyResult.rows.map((row) => ({ date: row.date, netSalesMinor: Number(row.net_sales_minor), grossProfitMinor: Number(row.gross_profit_minor), invoiceCount: Number(row.invoice_count) })),
      paymentMethods: paymentResult.rows.map((row) => ({ method: row.method, amountMinor: Number(row.amount_minor), transactionCount: Number(row.transaction_count) })),
      topProducts: productResult.rows.map((row) => ({ nameAr: row.name_ar, category: row.category, netQtyMilli: Number(row.net_qty_milli), netSalesMinor: Number(row.net_sales_minor), grossProfitMinor: Number(row.gross_profit_minor) })),
      categories: categoryResult.rows.map((row) => ({ category: row.category, netSalesMinor: Number(row.net_sales_minor), grossProfitMinor: Number(row.gross_profit_minor) })),
      expenseCategories: expenseCategoryResult.rows.map((row) => ({ category: row.category, amountMinor: Number(row.amount_minor), itemCount: Number(row.item_count) })),
      shopConsumptions: consumptionResult.rows.map((row) => ({ date: row.date, itemName: row.item_name, category: row.category, amountMinor: Number(row.amount_minor) })),
      payroll: payrollResult.rows.map((row) => ({ employeeName: row.employee_name, month: row.payroll_label.slice(0, 7), netMinor: Number(row.net_minor), paymentMethod: row.payment_method, paidOn: row.paid_on })),
      inventory: { inventoryValueMinor: Number(inventory.inventory_value_minor), lowStockCount: Number(inventory.low_stock_count), outOfStockCount: Number(inventory.out_of_stock_count), activeProductCount: Number(inventory.active_product_count) }, insights,
    };
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
