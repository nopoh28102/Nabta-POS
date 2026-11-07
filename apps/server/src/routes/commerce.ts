import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { commerceOrderRequestSchema, commerceOrderStatusUpdateSchema } from "@nabta/contracts";
import { calculateLineMinor, normalizeArabicSearch, toSafeNumber } from "@nabta/domain";
import { calculateInventoryIssueValue } from "@nabta/domain";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";

type SaleUnit = "UNIT" | "PACKAGE" | "CARTON";
type UnitKind = "PIECE" | "WEIGHT";
/** Starts at EGP 20.00 and is calculated by Nabta, not by a bot or browser. */
const DEFAULT_DELIVERY_FEE_MINOR = 2_000;

interface CommerceProductRow {
  id: string;
  name_ar: string;
  description: string;
  category: string;
  unit_kind: UnitKind;
  weight_unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER";
  price_minor: number;
  carton_price_minor: number | null;
  purchase_pack_size: number;
  retail_package_size: number | null;
  retail_package_price_minor: number | null;
  retail_package_unit: "PIECE" | "BAG" | null;
  retail_package_label: "PACKAGE" | "STACK" | "PACKET" | null;
  qty_milli: number;
  barcodes: string[];
}

interface StockBalanceRow {
  product_id: string;
  qty_milli: number;
  inventory_value_minor: number;
}

function requireCommerceKey(request: FastifyRequest, config: AppConfig): void {
  const expected = config.COMMERCE_API_SHARED_SECRET;
  if (!expected) throw new ApiError(503, "COMMERCE_NOT_CONFIGURED", "ربط تطبيق العملاء لم يُفعّل بعد في إعدادات الخادم");
  const received = request.headers["x-nabta-commerce-key"];
  if (typeof received !== "string") throw new ApiError(401, "COMMERCE_AUTH_REQUIRED", "مفتاح ربط تطبيق العملاء مطلوب");
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new ApiError(401, "COMMERCE_AUTH_INVALID", "مفتاح ربط تطبيق العملاء غير صحيح");
  }
}

function salePrice(row: CommerceProductRow, saleUnit: SaleUnit, qtyMilli: number): { unitPriceMinor: number; totalMinor: number; packageSize?: number } {
  if (row.unit_kind === "PIECE" && qtyMilli % 1000 !== 0) throw new ApiError(422, "PIECE_FRACTION", `الصنف ${row.name_ar} يباع بوحدة كاملة`);
  if (saleUnit === "CARTON") {
    const cartonQtyMilli = row.purchase_pack_size * 1000;
    if (row.unit_kind !== "PIECE" || !row.carton_price_minor || row.purchase_pack_size < 2 || qtyMilli % cartonQtyMilli !== 0) {
      throw new ApiError(422, "RETAIL_CARTON_NOT_CONFIGURED", `بيع الكرتونة غير مُعد للصنف ${row.name_ar}`);
    }
    return { unitPriceMinor: row.carton_price_minor, totalMinor: row.carton_price_minor * (qtyMilli / cartonQtyMilli), packageSize: row.purchase_pack_size };
  }
  if (saleUnit === "PACKAGE") {
    const packageQtyMilli = (row.retail_package_size ?? 0) * 1000;
    if (row.unit_kind !== "PIECE" || !row.retail_package_price_minor || packageQtyMilli === 0 || qtyMilli % packageQtyMilli !== 0) {
      throw new ApiError(422, "RETAIL_PACKAGE_NOT_CONFIGURED", `بيع العبوة غير مُعد للصنف ${row.name_ar}`);
    }
    return { unitPriceMinor: row.retail_package_price_minor, totalMinor: row.retail_package_price_minor * (qtyMilli / packageQtyMilli), packageSize: row.retail_package_size! };
  }
  return { unitPriceMinor: row.price_minor, totalMinor: toSafeNumber(calculateLineMinor(BigInt(row.price_minor), BigInt(qtyMilli)), "commerceLineTotal") };
}

function catalogQuery(value: unknown): { query: string; category: string; limit: number } {
  const input = value as Record<string, unknown>;
  const query = String(input.query ?? "").trim().slice(0, 160);
  const category = String(input.category ?? "").trim().slice(0, 100);
  const requestedLimit = Number(input.limit ?? 48);
  return { query, category, limit: Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 96) : 48 };
}

function isLegacyFulfillment(status: string): boolean {
  return status === "FULFILLED";
}

export function registerCommerceRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.get("/v1/commerce/catalog", async (request) => {
    requireCommerceKey(request, config);
    const input = catalogQuery(request.query);
    const normalized = normalizeArabicSearch(input.query);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const params: unknown[] = [input.category, input.limit];
    const tokenChecks: string[] = [];
    for (const token of tokens) {
      params.push(`%${token}%`);
      tokenChecks.push(`p.search_name LIKE $${params.length}`);
    }
    const result = await db.query<CommerceProductRow>(`
      WITH default_warehouse AS (
        SELECT id FROM warehouses ORDER BY is_default DESC, created_at, id LIMIT 1
      )
      SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.weight_unit,
             p.price_minor, p.carton_price_minor, p.purchase_pack_size,
             p.retail_package_size, p.retail_package_price_minor, p.retail_package_unit,
             p.retail_package_label,
             COALESCE((
               SELECT array_agg(barcode ORDER BY created_at, barcode)
               FROM product_barcodes
               WHERE product_id = p.id
             ), '{}'::text[]) AS barcodes,
             GREATEST(0, COALESCE(sb.qty_milli, 0) - COALESCE((
               SELECT SUM(cor.qty_milli) FROM customer_order_reservations cor
               WHERE cor.warehouse_id = dw.id AND cor.product_id = p.id AND cor.released_at IS NULL
             ), 0) - COALESCE((
               SELECT SUM(pr.qty_milli) FROM payment_reservations pr
               WHERE pr.warehouse_id = dw.id AND pr.product_id = p.id
                 AND pr.released_at IS NULL AND pr.expires_at > now()
             ), 0))::bigint AS qty_milli
      FROM products p
      CROSS JOIN default_warehouse dw
      LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = dw.id
      WHERE p.active
        AND ($1 = '' OR p.category = $1)
        ${tokenChecks.length ? `AND ${tokenChecks.join(" AND ")}` : ""}
      ORDER BY (COALESCE(sb.qty_milli, 0) > 0) DESC, p.name_ar, p.id
      LIMIT $2
    `, params);
    return {
      products: result.rows.map((row) => ({
        id: row.id, nameAr: row.name_ar, description: row.description, category: row.category,
        unitKind: row.unit_kind, weightUnit: row.weight_unit, priceMinor: row.price_minor,
        available: row.qty_milli > 0, availableQtyMilli: row.qty_milli,
        barcodes: row.barcodes,
        ...(row.retail_package_size && row.retail_package_price_minor && row.retail_package_unit ? {
          retailPackage: { unitsPerPackage: row.retail_package_size, packagePriceMinor: row.retail_package_price_minor, contentsUnit: row.retail_package_unit, label: row.retail_package_label ?? "PACKAGE" },
        } : {}),
        ...(row.purchase_pack_size > 1 && row.carton_price_minor ? { carton: { unitsPerCarton: row.purchase_pack_size, cartonPriceMinor: row.carton_price_minor } } : {}),
      })),
    };
  });

  const createOrder = async (request: FastifyRequest, reply: { status(code: number): { send(value: unknown): unknown } }, source: "WEB" | "MESSENGER") => {
    requireCommerceKey(request, config);
    const body = commerceOrderRequestSchema.parse(request.body);
    const order = await transaction(db, async (client) => {
      const prior = await client.query<{ id: string; status: string; subtotal_minor: number; delivery_fee_minor: number; total_minor: number; tracking_token: string }>(
        "SELECT id, status, subtotal_minor, delivery_fee_minor, total_minor, tracking_token FROM customer_orders WHERE client_order_id = $1 FOR UPDATE",
        [body.clientOrderId],
      );
      if (prior.rows[0]) return { orderId: prior.rows[0].id, status: prior.rows[0].status, subtotalMinor: prior.rows[0].subtotal_minor, deliveryFeeMinor: prior.rows[0].delivery_fee_minor, totalMinor: prior.rows[0].total_minor, trackingToken: prior.rows[0].tracking_token, replayed: true };
      const warehouse = await client.query<{ id: string }>("SELECT id FROM warehouses ORDER BY is_default DESC, created_at, id LIMIT 1 FOR UPDATE");
      if (!warehouse.rows[0]) throw new ApiError(409, "WAREHOUSE_NOT_CONFIGURED", "لا يوجد مخزن رئيسي لاستقبال طلبات العملاء");
      const requestedByProduct = new Map<string, number>();
      for (const line of body.lines) requestedByProduct.set(line.productId, (requestedByProduct.get(line.productId) ?? 0) + line.qtyMilli);
      const productIds = [...requestedByProduct.keys()];
      const rows = await client.query<CommerceProductRow>(`
        SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.weight_unit,
               p.price_minor, p.carton_price_minor, p.purchase_pack_size,
               p.retail_package_size, p.retail_package_price_minor, p.retail_package_unit,
               p.retail_package_label, sb.qty_milli
        FROM products p
        JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = $2
        WHERE p.id = ANY($1::uuid[]) AND p.active
        FOR UPDATE OF sb
      `, [productIds, warehouse.rows[0].id]);
      if (rows.rows.length !== productIds.length) throw new ApiError(404, "PRODUCT_NOT_FOUND", "أحد الأصناف لم يعد متاحًا للطلب");
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      for (const [productId, requested] of requestedByProduct) {
        const product = byId.get(productId)!;
        const reserved = await client.query<{ qty_milli: number }>(`
          SELECT COALESCE(SUM(qty_milli), 0)::bigint AS qty_milli
          FROM customer_order_reservations
          WHERE warehouse_id = $1 AND product_id = $2 AND released_at IS NULL
        `, [warehouse.rows[0].id, productId]);
        const paymentReserved = await client.query<{ qty_milli: number }>(`
          SELECT COALESCE(SUM(qty_milli), 0)::bigint AS qty_milli
          FROM payment_reservations
          WHERE warehouse_id = $1 AND product_id = $2 AND released_at IS NULL AND expires_at > now()
        `, [warehouse.rows[0].id, productId]);
        const availableQtyMilli = product.qty_milli - reserved.rows[0]!.qty_milli - paymentReserved.rows[0]!.qty_milli;
        if (requested > availableQtyMilli) throw new ApiError(409, "INSUFFICIENT_STOCK", `الكمية لم تعد متاحة للصنف ${product.name_ar}`, { productId, availableQtyMilli: Math.max(0, availableQtyMilli) });
      }
      const priced = body.lines.map((line) => {
        const product = byId.get(line.productId)!;
        const price = salePrice(product, line.saleUnit, line.qtyMilli);
        return { product, line, ...price };
      });
      const subtotalMinor = priced.reduce((sum, line) => sum + line.totalMinor, 0);
      const deliveryFeeMinor = DEFAULT_DELIVERY_FEE_MINOR;
      const totalMinor = subtotalMinor + deliveryFeeMinor;
      const saved = await client.query<{ id: string; tracking_token: string }>(`
        INSERT INTO customer_orders(client_order_id, warehouse_id, customer_name, customer_phone, delivery_address, notes, source, subtotal_minor, delivery_fee_minor, total_minor)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, tracking_token
      `, [body.clientOrderId, warehouse.rows[0].id, body.customerName, body.customerPhone, body.deliveryAddress, body.notes ?? null, source, subtotalMinor, deliveryFeeMinor, totalMinor]);
      const orderId = saved.rows[0]!.id;
      for (const line of priced) {
        await client.query(`
          INSERT INTO customer_order_lines(customer_order_id, product_id, name_snapshot, unit_kind_snapshot, sale_unit_snapshot, sale_package_size_snapshot, qty_milli, unit_price_minor, line_total_minor)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [orderId, line.product.id, line.product.name_ar, line.product.unit_kind, line.line.saleUnit, line.packageSize ?? null, line.line.qtyMilli, line.unitPriceMinor, line.totalMinor]);
      }
      for (const [productId, qtyMilli] of requestedByProduct) {
        await client.query(`
          INSERT INTO customer_order_reservations(customer_order_id, warehouse_id, product_id, qty_milli)
          VALUES ($1, $2, $3, $4)
        `, [orderId, warehouse.rows[0].id, productId, qtyMilli]);
      }
      return { orderId, status: "PENDING", subtotalMinor, deliveryFeeMinor, totalMinor, trackingToken: saved.rows[0]!.tracking_token, replayed: false };
    });
    return reply.status(order.replayed ? 200 : 201).send(order);
  };

  app.post("/v1/commerce/orders", async (request, reply) => createOrder(request, reply, "WEB"));
  // This path is intentionally not exposed by the public customer storefront.
  // A verified Messenger Worker calls it using the same server-to-Worker key.
  app.post("/v1/commerce/messenger/orders", async (request, reply) => createOrder(request, reply, "MESSENGER"));

  app.get("/v1/commerce/orders/:orderId", async (request) => {
    requireCommerceKey(request, config);
    const orderId = String((request.params as { orderId?: string }).orderId ?? "");
    const trackingToken = request.headers["x-nabta-order-token"];
    if (typeof trackingToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trackingToken)) {
      throw new ApiError(401, "ORDER_TRACKING_TOKEN_REQUIRED", "رمز متابعة الطلب مطلوب");
    }
    const order = await db.query<{ id: string; status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FULFILLED"; subtotal_minor: number; delivery_fee_minor: number; total_minor: number; status_note: string | null; created_at: Date }>(`
      SELECT id, status, subtotal_minor, delivery_fee_minor, total_minor, status_note, created_at
      FROM customer_orders
      WHERE id = $1 AND tracking_token = $2
    `, [orderId, trackingToken]);
    const current = order.rows[0];
    if (!current) throw new ApiError(404, "CUSTOMER_ORDER_NOT_FOUND", "الطلب غير موجود أو رمز المتابعة غير صحيح");
    const lines = await db.query<{ product_id: string; name_snapshot: string; unit_kind_snapshot: UnitKind; sale_unit_snapshot: SaleUnit; sale_package_size_snapshot: number | null; qty_milli: number; unit_price_minor: number; line_total_minor: number }>(`
      SELECT product_id, name_snapshot, unit_kind_snapshot, sale_unit_snapshot, sale_package_size_snapshot, qty_milli, unit_price_minor, line_total_minor
      FROM customer_order_lines WHERE customer_order_id = $1 ORDER BY id
    `, [current.id]);
    return {
      id: current.id,
      status: current.status,
      subtotalMinor: current.subtotal_minor,
      deliveryFeeMinor: current.delivery_fee_minor,
      totalMinor: current.total_minor,
      statusNote: current.status_note,
      createdAt: current.created_at.toISOString(),
      lines: lines.rows.map((line) => ({
        productId: line.product_id,
        nameAr: line.name_snapshot,
        unitKind: line.unit_kind_snapshot,
        saleUnit: line.sale_unit_snapshot,
        salePackageSize: line.sale_package_size_snapshot,
        qtyMilli: line.qty_milli,
        unitPriceMinor: line.unit_price_minor,
        lineTotalMinor: line.line_total_minor,
      })),
    };
  });

  app.get("/v1/commerce/admin/orders", async (request) => {
    requirePermission(request, "SALE_POST");
    const status = String((request.query as Record<string, unknown>).status ?? "").trim();
    if (status && !["PENDING", "CONFIRMED", "CANCELLED", "FULFILLED"].includes(status)) throw new ApiError(400, "ORDER_STATUS_INVALID", "حالة الطلب غير صحيحة");
    const orders = await db.query<{ id: string; customer_name: string; customer_phone: string; delivery_address: string; notes: string | null; source: "WEB" | "MESSENGER"; status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FULFILLED"; subtotal_minor: number; delivery_fee_minor: number; total_minor: number; created_at: Date; status_note: string | null; lines: Array<{ productId: string; nameAr: string; unitKind: UnitKind; saleUnit: SaleUnit; salePackageSize: number | null; qtyMilli: number; unitPriceMinor: number; lineTotalMinor: number }> }>(`
      SELECT co.id, co.customer_name, co.customer_phone, co.delivery_address, co.notes, co.source, co.status,
             co.subtotal_minor, co.delivery_fee_minor, co.total_minor, co.created_at, co.status_note,
             COALESCE(jsonb_agg(jsonb_build_object(
               'productId', col.product_id, 'nameAr', col.name_snapshot,
               'unitKind', col.unit_kind_snapshot, 'saleUnit', col.sale_unit_snapshot,
               'salePackageSize', col.sale_package_size_snapshot, 'qtyMilli', col.qty_milli,
               'unitPriceMinor', col.unit_price_minor, 'lineTotalMinor', col.line_total_minor
             ) ORDER BY col.id) FILTER (WHERE col.id IS NOT NULL), '[]'::jsonb) AS lines
      FROM customer_orders co
      LEFT JOIN customer_order_lines col ON col.customer_order_id = co.id
      WHERE ($1 = '' OR co.status = $1)
      GROUP BY co.id
      ORDER BY co.created_at DESC LIMIT 200
    `, [status]);
    return { orders: orders.rows.map((row) => ({ id: row.id, customerName: row.customer_name, customerPhone: row.customer_phone, deliveryAddress: row.delivery_address, notes: row.notes, source: row.source, status: row.status, subtotalMinor: row.subtotal_minor, deliveryFeeMinor: row.delivery_fee_minor, totalMinor: row.total_minor, createdAt: row.created_at.toISOString(), statusNote: row.status_note, lines: row.lines })) };
  });

  app.put("/v1/commerce/admin/orders/:orderId", async (request) => {
    const auth = requirePermission(request, "SALE_POST");
    const orderId = String((request.params as { orderId?: string }).orderId ?? "");
    const body = commerceOrderStatusUpdateSchema.parse(request.body);
    const updated = await transaction(db, async (client) => {
      const current = await client.query<{ id: string; warehouse_id: string; status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FULFILLED" }>(
        "SELECT id, warehouse_id, status FROM customer_orders WHERE id = $1 FOR UPDATE",
        [orderId],
      );
      const order = current.rows[0];
      if (!order) throw new ApiError(404, "CUSTOMER_ORDER_NOT_FOUND", "طلب العميل غير موجود");
      if (order.status === body.status) return { id: order.id, status: order.status, replayed: true };
      if (order.status === "CANCELLED" || order.status === "FULFILLED") throw new ApiError(409, "CUSTOMER_ORDER_FINAL", "لا يمكن تعديل طلب ملغي أو تم تسليمه");
      if (isLegacyFulfillment(body.status)) throw new ApiError(409, "CUSTOMER_ORDER_FINAL_SALE_REQUIRED", "لا يُسجّل التسليم من هذه الشاشة. أصدر الفاتورة النهائية أولًا من نقطة البيع حتى تُحفظ حركة البيع والمخزون بصورة صحيحة.");

      if (body.status === "CANCELLED") {
        await client.query("UPDATE customer_order_reservations SET released_at = now() WHERE customer_order_id = $1 AND released_at IS NULL", [order.id]);
      }
      if (isLegacyFulfillment(body.status)) {
        const lines = await client.query<{ product_id: string; qty_milli: number; name_snapshot: string }>(
          "SELECT product_id, qty_milli, name_snapshot FROM customer_order_lines WHERE customer_order_id = $1 ORDER BY product_id FOR UPDATE",
          [order.id],
        );
        for (const line of lines.rows) {
          const balance = await client.query<StockBalanceRow>(`
            SELECT product_id, qty_milli, inventory_value_minor
            FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE
          `, [order.warehouse_id, line.product_id]);
          const currentBalance = balance.rows[0];
          if (!currentBalance || currentBalance.qty_milli < line.qty_milli) throw new ApiError(409, "INSUFFICIENT_STOCK", `تعذر تسليم ${line.name_snapshot}: تغير المخزون بعد الحجز`);
          const costMinor = Number(calculateInventoryIssueValue(BigInt(currentBalance.inventory_value_minor), BigInt(currentBalance.qty_milli), BigInt(line.qty_milli)));
          const nextQty = currentBalance.qty_milli - line.qty_milli;
          const nextValue = nextQty === 0 ? 0 : currentBalance.inventory_value_minor - costMinor;
          await client.query("UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2", [order.warehouse_id, line.product_id, nextQty, nextValue]);
          await client.query(`INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
            VALUES ($1, $2, 'TRANSFER_OUT', $3, $4, $5, $6, 'customer_order', $7, $8, $9)`, [order.warehouse_id, line.product_id, -line.qty_milli, -costMinor, nextQty, nextValue, order.id, auth.userId, body.note ?? "تم تسليم طلب العميل"]);
        }
        await client.query("UPDATE customer_order_reservations SET released_at = now() WHERE customer_order_id = $1 AND released_at IS NULL", [order.id]);
      }
      const saved = await client.query<{ id: string; status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FULFILLED" }>(`
        UPDATE customer_orders SET status = $2, status_note = $3, updated_at = now()
        WHERE id = $1 RETURNING id, status
      `, [order.id, body.status, body.note ?? null]);
      await audit(client, auth, isLegacyFulfillment(body.status) ? "CUSTOMER_ORDER_FULFILLED" : "CUSTOMER_ORDER_STATUS_UPDATED", "customer_order", order.id, { from: order.status, to: body.status }, body.note);
      return { id: saved.rows[0]!.id, status: saved.rows[0]!.status, replayed: false };
    });
    app.log.info({ orderId, userId: auth.userId, status: updated.status, replayed: updated.replayed }, "customer order status updated");
    return updated;
  });
}
