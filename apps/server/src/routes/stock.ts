import type { FastifyInstance } from "fastify";
import { inventoryPeriodicExportRequestSchema, stockCountPostRequestSchema } from "@nabta/contracts";
import { calculateInventoryIssueValue, roundHalfUp } from "@nabta/domain";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";

function datePartsInCairo(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function formatLocalDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function parseReferenceDate(value: string | undefined): { year: number; month: number; day: number } {
  if (!value) return datePartsInCairo(new Date());
  const [rawYear, rawMonth, rawDay] = value.split("-");
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new ApiError(422, "INVALID_REFERENCE_DATE", "تاريخ التقرير غير صالح");
  }
  return { year, month, day };
}

function resolvePeriod(period: "MONTHLY" | "QUARTERLY" | "YEARLY", referenceDate: string | undefined): { start: string; endExclusive: string; end: string; label: string } {
  const reference = parseReferenceDate(referenceDate);
  if (period === "MONTHLY") {
    const start = { ...reference, day: 1 };
    const next = start.month === 12 ? { year: start.year + 1, month: 1, day: 1 } : { year: start.year, month: start.month + 1, day: 1 };
    const end = addDays(next, -1);
    return { start: formatLocalDate(start.year, start.month, start.day), endExclusive: formatLocalDate(next.year, next.month, next.day), end: formatLocalDate(end.year, end.month, end.day), label: "جرد شهري" };
  }
  if (period === "QUARTERLY") {
    const startMonth = Math.floor((reference.month - 1) / 3) * 3 + 1;
    const start = { year: reference.year, month: startMonth, day: 1 };
    const next = startMonth === 10 ? { year: reference.year + 1, month: 1, day: 1 } : { year: reference.year, month: startMonth + 3, day: 1 };
    const end = addDays(next, -1);
    return { start: formatLocalDate(start.year, start.month, start.day), endExclusive: formatLocalDate(next.year, next.month, next.day), end: formatLocalDate(end.year, end.month, end.day), label: "جرد ربع سنوي" };
  }
  const start = { year: reference.year, month: 1, day: 1 };
  const next = { year: reference.year + 1, month: 1, day: 1 };
  const end = addDays(next, -1);
  return { start: formatLocalDate(start.year, start.month, start.day), endExclusive: formatLocalDate(next.year, next.month, next.day), end: formatLocalDate(end.year, end.month, end.day), label: "جرد سنوي" };
}

function averageUnitPriceMinor(netSalesMinor: number, netQtyMilli: number): number | null {
  if (netSalesMinor <= 0 || netQtyMilli <= 0) return null;
  const numerator = BigInt(netSalesMinor) * 1000n;
  const denominator = BigInt(netQtyMilli);
  return Number((numerator + denominator / 2n) / denominator);
}

export function registerStockRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/inventory/periodic-report", async (request) => {
    const auth = requirePermission(request, "EXPORT");
    const query = inventoryPeriodicExportRequestSchema.parse(request.query);
    const range = resolvePeriod(query.period, query.referenceDate);
    const terminal = await db.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1 AND active", [auth.terminalId]);
    if (!terminal.rows[0]) throw new ApiError(409, "TERMINAL_INVALID", "نقطة البيع غير صالحة");
    const warehouseId = terminal.rows[0].warehouse_id;
    const [store, sales, reorder] = await Promise.all([
      db.query<{ store_name: string }>("SELECT store_name FROM system_state WHERE singleton"),
      db.query<{
        name_ar: string; category: string; barcode: string | null; unit_kind: "PIECE" | "WEIGHT";
        gross_qty_milli: number; returned_qty_milli: number; gross_sales_minor: number; returns_minor: number;
        available_qty_milli: number; reorder_level_milli: number;
      }>(`
        WITH sales_in_period AS (
          SELECT sl.product_id, max(sl.name_snapshot) AS name_ar, max(sl.unit_kind_snapshot)::text AS unit_kind,
                 sum(sl.qty_milli)::bigint AS gross_qty_milli, sum(sl.net_minor)::bigint AS gross_sales_minor
          FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
          WHERE s.warehouse_id = $1
            AND (s.posted_at AT TIME ZONE 'Africa/Cairo')::date >= $2::date
            AND (s.posted_at AT TIME ZONE 'Africa/Cairo')::date < $3::date
          GROUP BY sl.product_id
        ), returns_in_period AS (
          SELECT sl.product_id, max(sl.name_snapshot) AS name_ar, max(sl.unit_kind_snapshot)::text AS unit_kind,
                 sum(srl.qty_milli)::bigint AS returned_qty_milli, sum(srl.refund_minor)::bigint AS returns_minor
          FROM sale_returns sr
          JOIN sale_return_lines srl ON srl.return_id = sr.id
          JOIN sale_lines sl ON sl.id = srl.sale_line_id
          JOIN sales s ON s.id = sl.sale_id
          WHERE s.warehouse_id = $1
            AND (sr.posted_at AT TIME ZONE 'Africa/Cairo')::date >= $2::date
            AND (sr.posted_at AT TIME ZONE 'Africa/Cairo')::date < $3::date
          GROUP BY sl.product_id
        )
        SELECT COALESCE(si.name_ar, ri.name_ar) AS name_ar, COALESCE(p.category, 'غير مصنف') AS category,
               min(pb.barcode) AS barcode, COALESCE(si.unit_kind, ri.unit_kind)::text AS unit_kind,
               COALESCE(si.gross_qty_milli, 0)::bigint AS gross_qty_milli,
               COALESCE(ri.returned_qty_milli, 0)::bigint AS returned_qty_milli,
               COALESCE(si.gross_sales_minor, 0)::bigint AS gross_sales_minor,
               COALESCE(ri.returns_minor, 0)::bigint AS returns_minor,
               COALESCE(sb.qty_milli, 0)::bigint AS available_qty_milli,
               COALESCE(p.reorder_level_milli, 0)::bigint AS reorder_level_milli
        FROM sales_in_period si FULL OUTER JOIN returns_in_period ri ON ri.product_id = si.product_id
        LEFT JOIN products p ON p.id = COALESCE(si.product_id, ri.product_id)
        LEFT JOIN stock_balances sb ON sb.product_id = COALESCE(si.product_id, ri.product_id) AND sb.warehouse_id = $1
        LEFT JOIN product_barcodes pb ON pb.product_id = COALESCE(si.product_id, ri.product_id)
        GROUP BY si.name_ar, ri.name_ar, p.category, si.unit_kind, ri.unit_kind, si.gross_qty_milli,
                 ri.returned_qty_milli, si.gross_sales_minor, ri.returns_minor, sb.qty_milli, p.reorder_level_milli
        ORDER BY COALESCE(si.name_ar, ri.name_ar)
      `, [warehouseId, range.start, range.endExclusive]),
      db.query<{
        name_ar: string; category: string; barcode: string | null; unit_kind: "PIECE" | "WEIGHT";
        qty_milli: number; reorder_level_milli: number; price_minor: number;
      }>(`
        SELECT p.name_ar, p.category, min(pb.barcode) AS barcode, p.unit_kind,
               COALESCE(sb.qty_milli, 0)::bigint AS qty_milli, p.reorder_level_milli, p.price_minor
        FROM terminals t
        JOIN products p ON p.active AND p.reorder_level_milli > 0
        LEFT JOIN stock_balances sb ON sb.warehouse_id = t.warehouse_id AND sb.product_id = p.id
        LEFT JOIN product_barcodes pb ON pb.product_id = p.id
        WHERE t.id = $1 AND COALESCE(sb.qty_milli, 0) <= p.reorder_level_milli
        GROUP BY p.id, p.name_ar, p.category, p.unit_kind, sb.qty_milli, p.reorder_level_milli, p.price_minor
        ORDER BY CASE WHEN COALESCE(sb.qty_milli, 0) = 0 THEN 0 WHEN COALESCE(sb.qty_milli, 0) < p.reorder_level_milli THEN 1 ELSE 2 END, p.name_ar
      `, [auth.terminalId]),
    ]);
    const salesItems = sales.rows.map((item) => {
      const netQtyMilli = item.gross_qty_milli - item.returned_qty_milli;
      const netSalesMinor = item.gross_sales_minor - item.returns_minor;
      return {
        nameAr: item.name_ar,
        category: item.category,
        barcode: item.barcode,
        unitKind: item.unit_kind,
        grossQtyMilli: item.gross_qty_milli,
        returnedQtyMilli: item.returned_qty_milli,
        netQtyMilli,
        grossSalesMinor: item.gross_sales_minor,
        returnsMinor: item.returns_minor,
        netSalesMinor,
        averageUnitPriceMinor: averageUnitPriceMinor(netSalesMinor, netQtyMilli),
        availableQtyMilli: item.available_qty_milli,
        reorderLevelMilli: item.reorder_level_milli,
      };
    });
    const reorderItems = reorder.rows.map((item) => ({
      nameAr: item.name_ar,
      category: item.category,
      barcode: item.barcode,
      unitKind: item.unit_kind,
      availableQtyMilli: item.qty_milli,
      reorderLevelMilli: item.reorder_level_milli,
      shortageQtyMilli: Math.max(0, item.reorder_level_milli - item.qty_milli),
      priceMinor: item.price_minor,
      status: item.qty_milli === 0 ? "OUT_OF_STOCK" as const : item.qty_milli < item.reorder_level_milli ? "BELOW_REORDER" as const : "AT_REORDER" as const,
    }));
    const totals = salesItems.reduce((result, item) => ({
      soldProductCount: result.soldProductCount + 1,
      grossQtyMilli: result.grossQtyMilli + item.grossQtyMilli,
      returnedQtyMilli: result.returnedQtyMilli + item.returnedQtyMilli,
      netQtyMilli: result.netQtyMilli + item.netQtyMilli,
      grossSalesMinor: result.grossSalesMinor + item.grossSalesMinor,
      returnsMinor: result.returnsMinor + item.returnsMinor,
      netSalesMinor: result.netSalesMinor + item.netSalesMinor,
      outOfStockCount: result.outOfStockCount,
      belowReorderCount: result.belowReorderCount,
    }), {
      soldProductCount: 0, grossQtyMilli: 0, returnedQtyMilli: 0, netQtyMilli: 0,
      grossSalesMinor: 0, returnsMinor: 0, netSalesMinor: 0,
      outOfStockCount: reorderItems.filter((item) => item.status === "OUT_OF_STOCK").length,
      belowReorderCount: reorderItems.filter((item) => item.status === "BELOW_REORDER").length,
    });
    return {
      storeName: store.rows[0]?.store_name ?? "نبتة",
      generatedAt: new Date().toISOString(),
      period: query.period,
      periodLabel: range.label,
      periodStart: range.start,
      periodEnd: range.end,
      salesItems,
      reorderItems,
      totals,
    };
  });

  app.get("/v1/stock/reorder-list", async (request) => {
    const auth = requirePermission(request, "STOCK_COUNT");
    const result = await db.query<{
      product_id: string; name_ar: string; category: string; barcode: string | null;
      unit_kind: "PIECE" | "WEIGHT"; qty_milli: number; reorder_level_milli: number;
    }>(`
      SELECT p.id AS product_id, p.name_ar, p.category, min(pb.barcode) AS barcode,
             p.unit_kind, COALESCE(sb.qty_milli, 0)::bigint AS qty_milli, p.reorder_level_milli
      FROM terminals t
      JOIN products p ON p.active AND p.reorder_level_milli > 0
      LEFT JOIN stock_balances sb ON sb.warehouse_id = t.warehouse_id AND sb.product_id = p.id
      LEFT JOIN product_barcodes pb ON pb.product_id = p.id
      WHERE t.id = $1 AND COALESCE(sb.qty_milli, 0) <= p.reorder_level_milli
      GROUP BY p.id, p.name_ar, p.category, p.unit_kind, sb.qty_milli, p.reorder_level_milli
      ORDER BY CASE WHEN COALESCE(sb.qty_milli, 0) = 0 THEN 0 WHEN COALESCE(sb.qty_milli, 0) < p.reorder_level_milli THEN 1 ELSE 2 END,
               p.name_ar
      LIMIT 2_000
    `, [auth.terminalId]);
    const items = result.rows.map((row) => ({
      productId: row.product_id,
      nameAr: row.name_ar,
      category: row.category,
      barcode: row.barcode,
      unitKind: row.unit_kind,
      availableQtyMilli: row.qty_milli,
      reorderLevelMilli: row.reorder_level_milli,
      shortageQtyMilli: Math.max(0, row.reorder_level_milli - row.qty_milli),
      status: row.qty_milli === 0 ? "OUT_OF_STOCK" as const : row.qty_milli < row.reorder_level_milli ? "BELOW_REORDER" as const : "AT_REORDER" as const,
    }));
    return {
      generatedAt: new Date().toISOString(),
      items,
      totals: {
        outOfStock: items.filter((item) => item.status === "OUT_OF_STOCK").length,
        belowReorder: items.filter((item) => item.status === "BELOW_REORDER").length,
        atReorder: items.filter((item) => item.status === "AT_REORDER").length,
      },
    };
  });

  app.get("/v1/stock-expiry", async (request) => {
    const auth = requirePermission(request, "STOCK_COUNT");
    const rawDays = Number((request.query as Record<string, unknown>).days ?? 30);
    const days = Number.isInteger(rawDays) ? Math.max(0, Math.min(365, rawDays)) : 30;
    const result = await db.query(`
      SELECT sl.id AS lot_id, p.id AS product_id, p.name_ar, p.unit_kind, sl.lot_code, sl.expires_on,
             sl.qty_milli, (sl.expires_on - (now() AT TIME ZONE 'Africa/Cairo')::date) AS days_remaining
      FROM stock_lots sl JOIN products p ON p.id = sl.product_id
      JOIN terminals t ON t.warehouse_id = sl.warehouse_id
      WHERE t.id = $1 AND sl.qty_milli > 0 AND sl.expires_on IS NOT NULL
        AND sl.expires_on <= ((now() AT TIME ZONE 'Africa/Cairo')::date + $2::int)
      ORDER BY sl.expires_on, p.name_ar, sl.id
      LIMIT 500
    `, [auth.terminalId, days]);
    return { days, lots: result.rows };
  });

  app.get("/v1/stock-movements", async (request) => {
    const auth = requirePermission(request, "STOCK_COUNT");
    const query = request.query as Record<string, unknown>;
    const productId = typeof query.productId === "string" ? query.productId : null;
    const result = await db.query(`
      SELECT sm.id, sm.product_id, p.name_ar, sm.movement_type, sm.qty_delta_milli, sm.value_delta_minor,
             sm.balance_qty_milli, sm.balance_value_minor, sm.reference_type, sm.reference_id,
             sm.reason, sm.occurred_at
      FROM stock_movements sm JOIN products p ON p.id = sm.product_id
      JOIN terminals t ON t.warehouse_id = sm.warehouse_id
      WHERE t.id = $1 AND ($2::uuid IS NULL OR sm.product_id = $2)
      ORDER BY sm.occurred_at DESC, sm.id DESC LIMIT 500
    `, [auth.terminalId, productId]);
    return { movements: result.rows };
  });

  app.post("/v1/stock-counts/post", async (request, reply) => {
    const auth = requirePermission(request, "STOCK_COUNT");
    if (auth.role !== "OWNER" && auth.role !== "MANAGER") throw new ApiError(403, "MANAGER_APPROVAL_REQUIRED", "ترحيل فرق الجرد يحتاج حساب مدير أو مالك؛ أمين المخزن يسجل المسودة فقط");
    const body = stockCountPostRequestSchema.parse(request.body);
    const result = await transaction(db, async (client) => {
      const terminal = await client.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1", [auth.terminalId]);
      if (!terminal.rows[0] || terminal.rows[0].warehouse_id !== body.warehouseId) throw new ApiError(403, "WAREHOUSE_FORBIDDEN", "المخزن لا يتبع نقطة البيع الحالية");
      const product = await client.query<{ unit_kind: "PIECE" | "WEIGHT" }>("SELECT unit_kind FROM products WHERE id = $1 AND active", [body.productId]);
      if (!product.rows[0]) throw new ApiError(404, "PRODUCT_NOT_FOUND", "الصنف غير موجود");
      if (product.rows[0].unit_kind === "PIECE" && body.actualQtyMilli % 1000 !== 0) throw new ApiError(422, "PIECE_FRACTION", "صنف القطعة لا يقبل كمية كسرية");
      const balance = await client.query<{ qty_milli: number; inventory_value_minor: number; version: number }>("SELECT qty_milli, inventory_value_minor, version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE", [body.warehouseId, body.productId]);
      const current = balance.rows[0];
      if (!current) throw new ApiError(404, "STOCK_BALANCE_MISSING", "رصيد الصنف غير موجود");
      if (current.version !== body.expectedVersion) throw new ApiError(409, "VERSION_CONFLICT", "تغير الرصيد بعد بدء الجرد؛ أعد العد أو راجع الفرق");
      const delta = body.actualQtyMilli - current.qty_milli;
      if (delta === 0) throw new ApiError(422, "NO_STOCK_DIFFERENCE", "لا يوجد فرق لترحيله");
      let valueDelta: number;
      if (delta < 0) {
        valueDelta = -Number(calculateInventoryIssueValue(BigInt(current.inventory_value_minor), BigInt(current.qty_milli), BigInt(-delta)));
      } else if (current.qty_milli > 0) {
        valueDelta = Number(roundHalfUp(BigInt(current.inventory_value_minor) * BigInt(delta), BigInt(current.qty_milli)));
      } else {
        const latest = await client.query<{ inventory_value_minor: number; qty_milli: number }>(`
          SELECT inventory_value_minor, qty_milli FROM purchase_receipt_lines
          WHERE product_id = $1 ORDER BY id DESC LIMIT 1
        `, [body.productId]);
        if (!latest.rows[0]) throw new ApiError(422, "COST_REQUIRED", "لا توجد تكلفة سابقة لتقييم زيادة الجرد؛ استلم البضاعة أولًا أو استخدم تسوية تكلفة معتمدة");
        valueDelta = Number(roundHalfUp(BigInt(latest.rows[0].inventory_value_minor) * BigInt(delta), BigInt(latest.rows[0].qty_milli)));
      }
      const newValue = body.actualQtyMilli === 0 ? 0 : current.inventory_value_minor + valueDelta;
      if (newValue < 0) throw new Error("negative inventory value invariant failed");
      const count = await client.query<{ id: string; posted_at: Date }>(`
        INSERT INTO stock_counts(warehouse_id, product_id, expected_qty_milli, actual_qty_milli, expected_version,
          value_delta_minor, reason, user_id, approved_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING id, posted_at
      `, [body.warehouseId, body.productId, current.qty_milli, body.actualQtyMilli, current.version, valueDelta, body.reason, auth.userId]);
      await client.query("UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2", [body.warehouseId, body.productId, body.actualQtyMilli, newValue]);
      await client.query(`INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
        value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
        VALUES ($1, $2, 'COUNT_ADJUSTMENT', $3, $4, $5, $6, 'stock_count', $7, $8, $9)`,
      [body.warehouseId, body.productId, delta, valueDelta, body.actualQtyMilli, newValue, count.rows[0]!.id, auth.userId, body.reason]);
      if (delta > 0) await client.query("INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, 'COUNT-GAIN', $3)", [body.warehouseId, body.productId, delta]);
      if (delta < 0) {
        let remaining = -delta;
        const lots = await client.query<{ id: string; qty_milli: number }>("SELECT id, qty_milli FROM stock_lots WHERE warehouse_id = $1 AND product_id = $2 AND qty_milli > 0 ORDER BY (expires_on IS NULL), expires_on, received_at, id FOR UPDATE", [body.warehouseId, body.productId]);
        for (const lot of lots.rows) {
          const qty = Math.min(remaining, lot.qty_milli);
          if (qty > 0) await client.query("UPDATE stock_lots SET qty_milli = qty_milli - $2 WHERE id = $1", [lot.id, qty]);
          remaining -= qty;
          if (remaining === 0) break;
        }
        if (remaining !== 0) throw new Error("lot count allocation invariant failed");
      }
      await audit(client, auth, "STOCK_COUNT_POSTED", "stock_count", count.rows[0]!.id, { expectedQtyMilli: current.qty_milli, actualQtyMilli: body.actualQtyMilli, valueDeltaMinor: valueDelta }, body.reason);
      return { countId: count.rows[0]!.id, deltaQtyMilli: delta, valueDeltaMinor: valueDelta, newVersion: current.version + 1, postedAt: count.rows[0]!.posted_at.toISOString() };
    });
    return reply.status(201).send(result);
  });
}
