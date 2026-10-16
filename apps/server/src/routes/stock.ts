import type { FastifyInstance } from "fastify";
import { stockCountPostRequestSchema } from "@nabta/contracts";
import { calculateInventoryIssueValue, roundHalfUp } from "@nabta/domain";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";

export function registerStockRoutes(app: FastifyInstance, db: Database): void {
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
