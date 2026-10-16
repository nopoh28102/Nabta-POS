import type { FastifyInstance } from "fastify";
import { saleReturnRequestSchema } from "@nabta/contracts";
import { allocateProportionally, allocateReturnValue } from "@nabta/domain";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { canonicalJson, sha256 } from "../security.js";

interface SaleLineRow {
  id: string;
  product_id: string;
  qty_milli: number;
  net_minor: number;
  cost_minor: number;
  returned_qty_milli: number;
  refunded_minor: number;
  returned_cost_minor: number;
  warehouse_id: string;
}

interface PaymentRow { method: "CASH" | "CARD" | "CREDIT"; amount_minor: number; }
interface AllocationRow { lot_id: string; qty_milli: number; returned_qty_milli: number; }

export function registerReturnRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string } }>("/v1/sales/:id/returns", async (request, reply) => {
    const auth = requirePermission(request, "RETURN_SALE");
    const body = saleReturnRequestSchema.parse(request.body);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[0-9a-f-]{36}$/i.test(key)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب للمرتجع");
    const payloadHash = sha256(canonicalJson({ saleId: request.params.id, ...body }));
    const response = await transaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${key}`]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== payloadHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "استُخدم مفتاح العملية نفسه مع بيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else {
        await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, key, payloadHash]);
      }
      const shift = await client.query("SELECT id FROM shifts WHERE id = $1 AND user_id = $2 AND terminal_id = $3 AND status = 'OPEN' FOR UPDATE", [body.shiftId, auth.userId, auth.terminalId]);
      if (!shift.rows[0]) throw new ApiError(409, "SHIFT_CLOSED", "يجب تنفيذ المرتجع من وردية مفتوحة");
      const lineIds = body.lines.map((line) => line.saleLineId).sort();
      const lines = await client.query<SaleLineRow>(`
        SELECT sl.*, s.warehouse_id FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE sl.id = ANY($1::uuid[]) AND sl.sale_id = $2 ORDER BY sl.id FOR UPDATE OF sl
      `, [lineIds, request.params.id]);
      if (lines.rows.length !== lineIds.length) throw new ApiError(404, "SALE_LINE_NOT_FOUND", "أحد أسطر المرتجع لا ينتمي إلى الفاتورة");
      const byId = new Map(lines.rows.map((line) => [line.id, line]));
      const calculated = body.lines.map((requested) => {
        const line = byId.get(requested.saleLineId)!;
        let refundMinor: number;
        let costMinor: number;
        try {
          refundMinor = Number(allocateReturnValue({ originalValueMinor: BigInt(line.net_minor), soldQtyMilli: BigInt(line.qty_milli), previouslyReturnedQtyMilli: BigInt(line.returned_qty_milli), previouslyRefundedMinor: BigInt(line.refunded_minor), returnQtyMilli: BigInt(requested.qtyMilli) }));
          costMinor = Number(allocateReturnValue({ originalValueMinor: BigInt(line.cost_minor), soldQtyMilli: BigInt(line.qty_milli), previouslyReturnedQtyMilli: BigInt(line.returned_qty_milli), previouslyRefundedMinor: BigInt(line.returned_cost_minor), returnQtyMilli: BigInt(requested.qtyMilli) }));
        } catch (error) {
          if (error instanceof RangeError) throw new ApiError(409, "RETURN_LIMIT", "كمية المرتجع تتجاوز الكمية المتبقية في الفاتورة");
          throw error;
        }
        return { ...requested, line, refundMinor, costMinor };
      });
      const totalRefundMinor = calculated.reduce((sum, line) => sum + line.refundMinor, 0);
      const totalCostMinor = calculated.reduce((sum, line) => sum + line.costMinor, 0);
      const saleMeta = await client.query<{ customer_id: string | null }>("SELECT customer_id FROM sales WHERE id = $1 FOR SHARE", [request.params.id]);
      let refunds = body.refunds;
      if (!refunds) {
        const original = await client.query<PaymentRow>("SELECT method, sum(amount_minor)::bigint AS amount_minor FROM payments WHERE sale_id = $1 GROUP BY method ORDER BY method", [request.params.id]);
        const allocation = allocateProportionally(BigInt(totalRefundMinor), original.rows.map((row) => ({ id: row.method, weight: BigInt(row.amount_minor) })));
        refunds = original.rows.map((row) => ({ method: row.method, amountMinor: Number(allocation.get(row.method) ?? 0n) })).filter((row) => row.amountMinor > 0);
      }
      if (refunds.reduce((sum, refund) => sum + refund.amountMinor, 0) !== totalRefundMinor) throw new ApiError(422, "REFUND_MISMATCH", "مجموع وسائل رد المبلغ لا يساوي قيمة المرتجع");
      const saleReturn = await client.query<{ id: string; posted_at: Date }>(`
        INSERT INTO sale_returns(sale_id, shift_id, user_id, reason, total_refund_minor, cost_reversal_minor)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, posted_at
      `, [request.params.id, body.shiftId, auth.userId, body.reason, totalRefundMinor, totalCostMinor]);
      const returnId = saleReturn.rows[0]!.id;
      for (const item of calculated) {
        await client.query(`INSERT INTO sale_return_lines(return_id, sale_line_id, qty_milli, condition, refund_minor, cost_minor)
          VALUES ($1, $2, $3, $4, $5, $6)`, [returnId, item.saleLineId, item.qtyMilli, item.condition, item.refundMinor, item.costMinor]);
        await client.query(`UPDATE sale_lines SET returned_qty_milli = returned_qty_milli + $2,
          refunded_minor = refunded_minor + $3, returned_cost_minor = returned_cost_minor + $4 WHERE id = $1`,
        [item.saleLineId, item.qtyMilli, item.refundMinor, item.costMinor]);
        if (item.condition === "RESTOCK") {
          const balance = await client.query<{ qty_milli: number; inventory_value_minor: number }>("SELECT qty_milli, inventory_value_minor FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE", [item.line.warehouse_id, item.line.product_id]);
          const newQty = balance.rows[0]!.qty_milli + item.qtyMilli;
          const newValue = balance.rows[0]!.inventory_value_minor + item.costMinor;
          await client.query("UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2", [item.line.warehouse_id, item.line.product_id, newQty, newValue]);
          let lotRemaining = item.qtyMilli;
          const allocations = await client.query<AllocationRow>("SELECT lot_id, qty_milli, returned_qty_milli FROM sale_lot_allocations WHERE sale_line_id = $1 ORDER BY lot_id FOR UPDATE", [item.saleLineId]);
          for (const allocation of allocations.rows) {
            const canReturn = allocation.qty_milli - allocation.returned_qty_milli;
            const qty = Math.min(canReturn, lotRemaining);
            if (qty > 0) {
              await client.query("UPDATE sale_lot_allocations SET returned_qty_milli = returned_qty_milli + $3 WHERE sale_line_id = $1 AND lot_id = $2", [item.saleLineId, allocation.lot_id, qty]);
              await client.query("UPDATE stock_lots SET qty_milli = qty_milli + $2 WHERE id = $1", [allocation.lot_id, qty]);
              lotRemaining -= qty;
            }
            if (lotRemaining === 0) break;
          }
          if (lotRemaining !== 0) throw new Error("lot return allocation invariant failed");
          await client.query(`INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
            value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
            VALUES ($1, $2, 'SALE_RETURN', $3, $4, $5, $6, 'sale_return', $7, $8, $9)`,
          [item.line.warehouse_id, item.line.product_id, item.qtyMilli, item.costMinor, newQty, newValue, returnId, auth.userId, body.reason]);
        }
      }
      for (const refund of refunds) await client.query("INSERT INTO refund_payments(return_id, method, amount_minor) VALUES ($1, $2, $3)", [returnId, refund.method, refund.amountMinor]);
      const creditRefund = refunds.filter((refund) => refund.method === "CREDIT").reduce((sum, refund) => sum + refund.amountMinor, 0);
      if (creditRefund > 0 && saleMeta.rows[0]?.customer_id) {
        await client.query("INSERT INTO customer_ledger(customer_id, type, amount_minor, reference_id, note, actor_user_id) VALUES ($1, 'REFUND', $2, $3, $4, $5)", [saleMeta.rows[0].customer_id, -creditRefund, returnId, body.reason, auth.userId]);
      }
      await audit(client, auth, "SALE_RETURN_POSTED", "sale_return", returnId, { saleId: request.params.id, totalRefundMinor, totalCostMinor, damagedLines: calculated.filter((line) => line.condition === "DAMAGED").length }, body.reason);
      const result = { returnId, saleId: request.params.id, totalRefundMinor, costReversalMinor: totalCostMinor, refunds, postedAt: saleReturn.rows[0]!.posted_at.toISOString() };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, key, JSON.stringify(result)]);
      return result;
    });
    return reply.status(201).send(response);
  });
}
