import type { FastifyInstance } from "fastify";
import { purchaseReceiptRequestSchema } from "@nabta/contracts";
import { allocateProportionally, calculateLineMinor } from "@nabta/domain";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { canonicalJson, sha256 } from "../security.js";

export function registerPurchaseRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/purchase-receipts", async (request, reply) => {
    const auth = requirePermission(request, "PURCHASE_RECEIVE");
    const body = purchaseReceiptRequestSchema.parse(request.body);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[0-9a-f-]{36}$/i.test(key)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب للاستلام");
    const hash = sha256(canonicalJson(body));
    const response = await transaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${key}`]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "استُخدم مفتاح العملية نفسه مع بيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, key, hash]);
      const terminal = await client.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1 AND active", [auth.terminalId]);
      if (!terminal.rows[0] || terminal.rows[0].warehouse_id !== body.warehouseId) throw new ApiError(403, "WAREHOUSE_FORBIDDEN", "المخزن لا يتبع نقطة البيع الحالية");
      if (body.supplierId) {
        const supplier = await client.query("SELECT id FROM suppliers WHERE id = $1 AND active FOR UPDATE", [body.supplierId]);
        if (!supplier.rows[0]) throw new ApiError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
      }
      const productIds = [...new Set(body.lines.map((line) => line.productId))].sort();
      if (productIds.length !== body.lines.length) throw new ApiError(422, "DUPLICATE_PRODUCT", "ادمج تكرار الصنف في سطر استلام واحد");
      const products = await client.query<{ id: string; unit_kind: "PIECE" | "WEIGHT"; name_ar: string; price_minor: number; wholesale_price_minor: number }>("SELECT id, unit_kind, name_ar, price_minor, wholesale_price_minor FROM products WHERE id = ANY($1::uuid[]) AND active ORDER BY id FOR UPDATE", [productIds]);
      if (products.rows.length !== productIds.length) throw new ApiError(404, "PRODUCT_NOT_FOUND", "أحد أصناف الاستلام غير موجود");
      const kindById = new Map(products.rows.map((row) => [row.id, row.unit_kind]));
      const productById = new Map(products.rows.map((row) => [row.id, row]));
      const calculated = body.lines.map((line) => {
        if (kindById.get(line.productId) === "PIECE" && line.qtyMilli % 1000 !== 0) throw new ApiError(422, "PIECE_FRACTION", "صنف القطعة لا يقبل كمية كسرية");
        return { ...line, id: line.productId, goodsMinor: Number(calculateLineMinor(BigInt(line.unitCostMinor), BigInt(line.qtyMilli))) };
      });
      const goodsMinor = calculated.reduce((sum, line) => sum + line.goodsMinor, 0);
      const expenseAllocation = body.supplyExpensesMinor === 0 ? new Map<string, bigint>() : allocateProportionally(BigInt(body.supplyExpensesMinor), calculated.map((line) => ({ id: line.productId, weight: BigInt(line.goodsMinor) })));
      const receipt = await client.query<{ id: string; posted_at: Date }>(`
        INSERT INTO purchase_receipts(warehouse_id, supplier_id, supplier_name, supplier_invoice_no, goods_minor,
          supply_expenses_minor, total_minor, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, posted_at
      `, [body.warehouseId, body.supplierId ?? null, body.supplierName, body.supplierInvoiceNo ?? null, goodsMinor, body.supplyExpensesMinor, goodsMinor + body.supplyExpensesMinor, auth.userId]);
      for (const line of calculated.sort((a, b) => a.productId.localeCompare(b.productId, "en"))) {
        const balance = await client.query<{ qty_milli: number; inventory_value_minor: number }>("SELECT qty_milli, inventory_value_minor FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE", [body.warehouseId, line.productId]);
        if (!balance.rows[0]) throw new ApiError(409, "STOCK_BALANCE_MISSING", "رصيد الصنف غير مهيأ في المخزن");
        const allocatedExpense = Number(expenseAllocation.get(line.productId) ?? 0n);
        const inventoryValue = line.goodsMinor + allocatedExpense;
        const newQty = balance.rows[0].qty_milli + line.qtyMilli;
        const newValue = balance.rows[0].inventory_value_minor + inventoryValue;
        const lot = await client.query<{ id: string }>(`
          INSERT INTO stock_lots(warehouse_id, product_id, lot_code, expires_on, qty_milli)
          VALUES ($1, $2, $3, $4, $5) RETURNING id
        `, [body.warehouseId, line.productId, line.lotCode ?? null, line.expiresOn ?? null, line.qtyMilli]);
        await client.query(`INSERT INTO purchase_receipt_lines(receipt_id, product_id, qty_milli, unit_cost_minor,
          goods_minor, allocated_expense_minor, inventory_value_minor, lot_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [receipt.rows[0]!.id, line.productId, line.qtyMilli, line.unitCostMinor, line.goodsMinor, allocatedExpense, inventoryValue, lot.rows[0]!.id]);
        await client.query("UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2", [body.warehouseId, line.productId, newQty, newValue]);
        await client.query(`INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
          value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id)
          VALUES ($1, $2, 'PURCHASE_RECEIPT', $3, $4, $5, $6, 'purchase_receipt', $7, $8)`,
        [body.warehouseId, line.productId, line.qtyMilli, inventoryValue, newQty, newValue, receipt.rows[0]!.id, auth.userId]);
        if (line.retailPriceMinor !== undefined || line.wholesalePriceMinor !== undefined) {
          const product = productById.get(line.productId)!;
          await client.query(`UPDATE products
            SET price_minor = COALESCE($2, price_minor),
                wholesale_price_minor = COALESCE($3, wholesale_price_minor),
                updated_at = now()
            WHERE id = $1`, [line.productId, line.retailPriceMinor ?? null, line.wholesalePriceMinor ?? null]);
          await audit(client, auth, "PRODUCT_PRICE_UPDATED_FROM_PURCHASE", "product", line.productId, {
            nameAr: product.name_ar,
            purchaseReceiptId: receipt.rows[0]!.id,
            previousPriceMinor: product.price_minor,
            priceMinor: line.retailPriceMinor ?? product.price_minor,
            previousWholesalePriceMinor: product.wholesale_price_minor,
            wholesalePriceMinor: line.wholesalePriceMinor ?? product.wholesale_price_minor,
          });
        }
      }
      if (body.supplierId && goodsMinor + body.supplyExpensesMinor > 0) {
        await client.query("INSERT INTO supplier_ledger(supplier_id, type, amount_minor, purchase_receipt_id, reference_id, note, actor_user_id) VALUES ($1, 'PURCHASE', $2, $3, $3, $4, $5)", [body.supplierId, goodsMinor + body.supplyExpensesMinor, receipt.rows[0]!.id, body.supplierInvoiceNo ?? "فاتورة مشتريات", auth.userId]);
      }
      await audit(client, auth, "PURCHASE_RECEIPT_POSTED", "purchase_receipt", receipt.rows[0]!.id, { goodsMinor, supplyExpensesMinor: body.supplyExpensesMinor, lineCount: body.lines.length });
      const result = { receiptId: receipt.rows[0]!.id, goodsMinor, supplyExpensesMinor: body.supplyExpensesMinor, totalMinor: goodsMinor + body.supplyExpensesMinor, postedAt: receipt.rows[0]!.posted_at.toISOString() };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, key, JSON.stringify(result)]);
      return result;
    });
    return reply.status(201).send(response);
  });
}
