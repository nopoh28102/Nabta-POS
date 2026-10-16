import type { FastifyInstance } from "fastify";
import { postSaleRequestSchema } from "@nabta/contracts";
import { calculateInventoryIssueValue } from "@nabta/domain";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requireAuth, requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { canonicalJson, sha256 } from "../security.js";

interface QuoteLine {
  lineId: string;
  productId: string;
  nameAr: string;
  unitKind: "PIECE" | "WEIGHT";
  qtyMilli: number;
  unitPriceMinor: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  stockVersion: number;
}

interface QuoteRow {
  id: string;
  terminal_id: string;
  shift_id: string;
  user_id: string;
  subtotal_minor: number;
  discount_minor: number;
  total_minor: number;
  lines_json: QuoteLine[];
  expires_at: Date;
  consumed_at: Date | null;
}

interface BalanceRow {
  product_id: string;
  qty_milli: number;
  inventory_value_minor: number;
  version: number;
  price_minor: number;
  active: boolean;
  prevent_expired_sales: boolean;
  warehouse_id: string;
  branch_id: string;
}

interface LotRow {
  id: string;
  qty_milli: number;
  expires_on: string | null;
}

interface IdempotencyRow {
  payload_hash: string;
  status: "PROCESSING" | "COMPLETED";
  response_status: number | null;
  response_body: unknown | null;
}

export function registerSaleRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/sales", async (request, reply) => {
    const auth = requirePermission(request, "SALE_POST");
    const keyHeader = request.headers["idempotency-key"];
    if (typeof keyHeader !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(keyHeader)) {
      throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب ويجب أن يكون UUID صالحًا");
    }
    const body = postSaleRequestSchema.parse(request.body);
    if (body.terminalId !== auth.terminalId) throw new ApiError(403, "TERMINAL_MISMATCH", "الجلسة مرتبطة بنقطة بيع أخرى");
    const payloadHash = sha256(canonicalJson(body));

    const result = await transaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${keyHeader}`]);
      const existing = await client.query<IdempotencyRow>("SELECT payload_hash, status, response_status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, keyHeader]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== payloadHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "استُخدم مفتاح العملية نفسه مع بيانات مختلفة");
        if (existing.rows[0].status === "COMPLETED") return { status: existing.rows[0].response_status ?? 201, body: existing.rows[0].response_body, replay: true };
        throw new ApiError(409, "OPERATION_IN_PROGRESS", "العملية ما زالت قيد التنفيذ؛ استعلم عنها بالمفتاح نفسه");
      }
      await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, keyHeader, payloadHash]);

      const quoteResult = await client.query<QuoteRow>("SELECT * FROM quotes WHERE id = $1 FOR UPDATE", [body.quoteId]);
      const quote = quoteResult.rows[0];
      if (!quote || quote.terminal_id !== auth.terminalId || quote.shift_id !== body.shiftId || quote.user_id !== auth.userId) {
        throw new ApiError(404, "QUOTE_NOT_FOUND", "عرض السعر غير موجود لهذه الجلسة");
      }
      if (quote.consumed_at) throw new ApiError(409, "QUOTE_CONSUMED", "تم استخدام عرض السعر من قبل");
      if (quote.expires_at <= new Date()) throw new ApiError(409, "PRICE_CHANGED", "انتهت صلاحية التسعير؛ أعد تقييم السلة");
      const shift = await client.query("SELECT id FROM shifts WHERE id = $1 AND terminal_id = $2 AND user_id = $3 AND status = 'OPEN' FOR UPDATE", [body.shiftId, auth.terminalId, auth.userId]);
      if (!shift.rows[0]) throw new ApiError(409, "SHIFT_CLOSED", "الوردية مغلقة أو لا تخص هذا الكاشير");

      const paymentTotal = body.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (paymentTotal !== quote.total_minor) throw new ApiError(422, "PAYMENT_MISMATCH", "مجموع وسائل الدفع لا يساوي إجمالي الفاتورة");
      const branchSettings = await client.query<{ credit_sales_enabled: boolean }>(`
        SELECT b.credit_sales_enabled FROM terminals t JOIN branches b ON b.id = t.branch_id WHERE t.id = $1
      `, [auth.terminalId]);
      const creditMinor = body.payments.filter((payment) => payment.method === "CREDIT").reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (creditMinor > 0 && !body.customerId) throw new ApiError(422, "CUSTOMER_REQUIRED", "العميل مطلوب للبيع الآجل");
      if (creditMinor > 0 && body.customerId) {
        const customer = await client.query<{ id: string; credit_limit_minor: number; opening_balance_minor: number }>("SELECT id, credit_limit_minor, opening_balance_minor FROM customers WHERE id = $1 AND active FOR UPDATE", [body.customerId]);
        if (!customer.rows[0]) throw new ApiError(404, "CUSTOMER_NOT_FOUND", "العميل غير موجود");
        const balance = await client.query<{ balance_minor: number }>("SELECT COALESCE(SUM(amount_minor), $2)::bigint AS balance_minor FROM customer_ledger WHERE customer_id = $1", [body.customerId, customer.rows[0].opening_balance_minor]);
        if (customer.rows[0].credit_limit_minor > 0 && balance.rows[0]!.balance_minor + creditMinor > customer.rows[0].credit_limit_minor) {
          throw new ApiError(409, "CREDIT_LIMIT", "تم تجاوز حد ائتمان العميل");
        }
      }
      if (body.payments.some((payment) => payment.method === "CREDIT") && !branchSettings.rows[0]?.credit_sales_enabled) {
        throw new ApiError(422, "CREDIT_DISABLED", "البيع الآجل غير مفعّل لهذا الفرع");
      }
      for (const payment of body.payments) {
        if (payment.method === "CASH" && (payment.tenderedMinor ?? payment.amountMinor) < payment.amountMinor) {
          throw new ApiError(422, "INSUFFICIENT_TENDER", "المبلغ النقدي المستلم أقل من المطلوب");
        }
      }

      const productIds = quote.lines_json.map((line) => line.productId).sort();
      const balances = await client.query<BalanceRow>(`
        SELECT sb.product_id, sb.qty_milli, sb.inventory_value_minor, sb.version, p.price_minor, p.active,
               b.prevent_expired_sales, sb.warehouse_id, b.id AS branch_id
        FROM stock_balances sb
        JOIN products p ON p.id = sb.product_id
        JOIN warehouses w ON w.id = sb.warehouse_id
        JOIN branches b ON b.id = w.branch_id
        JOIN terminals t ON t.warehouse_id = sb.warehouse_id
        WHERE t.id = $1 AND sb.product_id = ANY($2::uuid[])
        ORDER BY sb.product_id
        FOR UPDATE OF sb
      `, [auth.terminalId, productIds]);
      if (balances.rows.length !== productIds.length) throw new ApiError(409, "PRODUCT_NOT_FOUND", "أحد الأصناف لم يعد متاحًا");
      const balanceByProduct = new Map(balances.rows.map((row) => [row.product_id, row]));

      for (const line of quote.lines_json) {
        const balance = balanceByProduct.get(line.productId)!;
        if (balance.price_minor <= 0 || line.unitPriceMinor <= 0) throw new ApiError(422, "PRICE_NOT_SET", `\u062d\u062f\u062f \u0633\u0639\u0631 \u0628\u064a\u0639 \u0644\u0644\u0635\u0646\u0641 ${line.nameAr} \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u0628\u064a\u0639`);
        if (!balance.active || balance.price_minor !== line.unitPriceMinor) throw new ApiError(409, "PRICE_CHANGED", `تغير سعر الصنف ${line.nameAr}؛ راجع السلة`);
        if (balance.version !== line.stockVersion) throw new ApiError(409, "STOCK_CHANGED", `تغير مخزون الصنف ${line.nameAr}؛ راجع السلة`);
        if (balance.qty_milli < line.qtyMilli) throw new ApiError(409, "INSUFFICIENT_STOCK", `المخزون غير كافٍ: ${line.nameAr}`, { productId: line.productId, availableQtyMilli: balance.qty_milli });
      }

      const firstBalance = balances.rows[0]!;
      const counter = await client.query<{ invoice_counter: number }>("UPDATE branches SET invoice_counter = invoice_counter + 1 WHERE id = $1 RETURNING invoice_counter", [firstBalance.branch_id]);
      const invoiceNo = `INV-${new Date().getUTCFullYear()}-${String(counter.rows[0]!.invoice_counter).padStart(8, "0")}`;
      const sale = await client.query<{ id: string; posted_at: Date }>(`
        INSERT INTO sales(branch_id, warehouse_id, terminal_id, shift_id, user_id, customer_id, quote_id, invoice_no,
          subtotal_minor, discount_minor, total_minor, cost_minor)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0) RETURNING id, posted_at
      `, [firstBalance.branch_id, firstBalance.warehouse_id, auth.terminalId, body.shiftId, auth.userId, body.customerId ?? null, quote.id, invoiceNo, quote.subtotal_minor, quote.discount_minor, quote.total_minor]);
      const saleId = sale.rows[0]!.id;
      if (process.env.NODE_ENV === "test" && request.headers["x-nabta-test-fail"] === "after-sale-header") {
        throw new Error("injected rollback after sale header");
      }
      let totalCostMinor = 0;

      for (const line of quote.lines_json) {
        const balance = balanceByProduct.get(line.productId)!;
        const costMinor = Number(calculateInventoryIssueValue(BigInt(balance.inventory_value_minor), BigInt(balance.qty_milli), BigInt(line.qtyMilli)));
        totalCostMinor += costMinor;
        let remaining = line.qtyMilli;
        const lots = await client.query<LotRow>(`
          SELECT id, qty_milli, expires_on::text FROM stock_lots
          WHERE warehouse_id = $1 AND product_id = $2 AND qty_milli > 0
          ORDER BY (expires_on IS NULL), expires_on, received_at, id
          FOR UPDATE
        `, [balance.warehouse_id, line.productId]);
        const allocations: Array<{ lotId: string; qtyMilli: number }> = [];
        const cairoDate = await client.query<{ today: string }>("SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today");
        for (const lot of lots.rows) {
          if (balance.prevent_expired_sales && lot.expires_on && lot.expires_on < cairoDate.rows[0]!.today) continue;
          const used = Math.min(remaining, lot.qty_milli);
          if (used > 0) allocations.push({ lotId: lot.id, qtyMilli: used });
          remaining -= used;
          if (remaining === 0) break;
        }
        if (remaining > 0) {
          const code = lots.rows.reduce((sum, lot) => sum + lot.qty_milli, 0) >= line.qtyMilli ? "STOCK_EXPIRED" : "INSUFFICIENT_STOCK";
          throw new ApiError(409, code, code === "STOCK_EXPIRED" ? `المتاح من ${line.nameAr} منتهي الصلاحية وفق سياسة الفرع` : `المخزون غير كافٍ: ${line.nameAr}`);
        }
        await client.query(`
          INSERT INTO sale_lines(id, sale_id, product_id, name_snapshot, unit_kind_snapshot, qty_milli,
            unit_price_minor, gross_minor, discount_minor, net_minor, cost_minor)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [line.lineId, saleId, line.productId, line.nameAr, line.unitKind, line.qtyMilli, line.unitPriceMinor, line.grossMinor, line.discountMinor, line.netMinor, costMinor]);
        for (const allocation of allocations) {
          await client.query("UPDATE stock_lots SET qty_milli = qty_milli - $2 WHERE id = $1", [allocation.lotId, allocation.qtyMilli]);
          await client.query("INSERT INTO sale_lot_allocations(sale_line_id, lot_id, qty_milli) VALUES ($1, $2, $3)", [line.lineId, allocation.lotId, allocation.qtyMilli]);
        }
        const newQty = balance.qty_milli - line.qtyMilli;
        const newValue = newQty === 0 ? 0 : balance.inventory_value_minor - costMinor;
        await client.query("UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2", [balance.warehouse_id, line.productId, newQty, newValue]);
        await client.query(`
          INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor,
            balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id)
          VALUES ($1, $2, 'SALE', $3, $4, $5, $6, 'sale', $7, $8)
        `, [balance.warehouse_id, line.productId, -line.qtyMilli, -costMinor, newQty, newValue, saleId, auth.userId]);
      }
      await client.query("UPDATE sales SET cost_minor = $2 WHERE id = $1", [saleId, totalCostMinor]);
      let totalChange = 0;
      for (const payment of body.payments) {
        const tendered = payment.method === "CASH" ? payment.tenderedMinor ?? payment.amountMinor : null;
        const change = tendered === null ? 0 : tendered - payment.amountMinor;
        totalChange += change;
        await client.query(`INSERT INTO payments(sale_id, method, amount_minor, tendered_minor, change_minor, reference)
          VALUES ($1, $2, $3, $4, $5, $6)`, [saleId, payment.method, payment.amountMinor, tendered, change, payment.reference ?? null]);
      }
      if (creditMinor > 0 && body.customerId) {
        await client.query("INSERT INTO customer_ledger(customer_id, type, amount_minor, sale_id, reference_id, note, actor_user_id) VALUES ($1, 'SALE_CREDIT', $2, $3, $3, $4, $5)", [body.customerId, creditMinor, saleId, invoiceNo, auth.userId]);
      }
      await client.query("UPDATE quotes SET consumed_at = now() WHERE id = $1", [quote.id]);
      await audit(client, auth, "SALE_POSTED", "sale", saleId, { invoiceNo, totalMinor: quote.total_minor, costMinor: totalCostMinor, idempotencyKey: keyHeader });
      const response = {
        saleId, invoiceNo, postedAt: sale.rows[0]!.posted_at.toISOString(), subtotalMinor: quote.subtotal_minor,
        discountMinor: quote.discount_minor, totalMinor: quote.total_minor, paidMinor: paymentTotal,
        changeMinor: totalChange, lines: quote.lines_json,
      };
      await client.query(`UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201,
        response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2`, [auth.userId, keyHeader, JSON.stringify(response)]);
      return { status: 201, body: response, replay: false };
    });
    reply.header("Idempotent-Replay", result.replay ? "true" : "false");
    return reply.status(result.status).send(result.body);
  });

  app.get<{ Params: { requestId: string } }>("/v1/operations/:requestId", async (request) => {
    const auth = requireAuth(request);
    const result = await db.query<IdempotencyRow>("SELECT payload_hash, status, response_status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2", [auth.userId, request.params.requestId]);
    if (!result.rows[0]) return { status: "NOT_FOUND" };
    if (result.rows[0].status === "PROCESSING") return { status: "PENDING" };
    return { status: "POSTED", responseStatus: result.rows[0].response_status, response: result.rows[0].response_body };
  });

  app.get<{ Params: { id: string } }>("/v1/sales/:id", async (request) => {
    const auth = requireAuth(request);
    const sale = await db.query(`
      SELECT s.id, s.invoice_no, s.subtotal_minor, s.discount_minor, s.total_minor, s.posted_at,
             jsonb_agg(jsonb_build_object('id', sl.id, 'nameAr', sl.name_snapshot, 'unitKind', sl.unit_kind_snapshot,
               'qtyMilli', sl.qty_milli, 'unitPriceMinor', sl.unit_price_minor, 'grossMinor', sl.gross_minor,
               'discountMinor', sl.discount_minor, 'netMinor', sl.net_minor) ORDER BY sl.id) AS lines
      FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
      JOIN terminals t ON t.branch_id = s.branch_id
      WHERE s.id = $1 AND t.id = $2 GROUP BY s.id
    `, [request.params.id, auth.terminalId]);
    if (!sale.rows[0]) throw new ApiError(404, "SALE_NOT_FOUND", "الفاتورة غير موجودة");
    return sale.rows[0];
  });

  app.post<{ Params: { id: string } }>("/v1/sales/:id/reprint", async (request) => {
    const auth = requirePermission(request, "SALE_POST");
    return transaction(db, async (client) => {
      const sale = await client.query<{
        id: string; invoice_no: string; posted_at: Date; subtotal_minor: number; discount_minor: number; total_minor: number;
        paid_minor: number; change_minor: number;
      }>(`
        SELECT s.id, s.invoice_no, s.posted_at, s.subtotal_minor, s.discount_minor, s.total_minor,
          COALESCE((SELECT sum(amount_minor) FROM payments p WHERE p.sale_id = s.id), 0)::bigint AS paid_minor,
          COALESCE((SELECT sum(change_minor) FROM payments p WHERE p.sale_id = s.id), 0)::bigint AS change_minor
        FROM sales s JOIN terminals t ON t.branch_id = s.branch_id
        WHERE s.id = $1 AND t.id = $2 FOR SHARE
      `, [request.params.id, auth.terminalId]);
      if (!sale.rows[0]) throw new ApiError(404, "SALE_NOT_FOUND", "الفاتورة غير موجودة");
      const lines = await client.query<QuoteLine>(`
        SELECT product_id AS "productId", name_snapshot AS "nameAr", unit_kind_snapshot AS "unitKind", qty_milli AS "qtyMilli",
          unit_price_minor AS "unitPriceMinor", gross_minor AS "grossMinor", discount_minor AS "discountMinor",
          net_minor AS "netMinor", 0 AS "stockVersion", id AS "lineId"
        FROM sale_lines WHERE sale_id = $1 ORDER BY id
      `, [sale.rows[0].id]);
      const reprints = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_logs WHERE action = 'RECEIPT_REPRINTED' AND entity_type = 'sale' AND entity_id = $1", [sale.rows[0].id]);
      const count = reprints.rows[0]!.count + 1;
      await audit(client, auth, "RECEIPT_REPRINTED", "sale", sale.rows[0].id, { invoiceNo: sale.rows[0].invoice_no, reprintCount: count });
      const row = sale.rows[0];
      return { saleId: row.id, invoiceNo: row.invoice_no, postedAt: row.posted_at.toISOString(), subtotalMinor: row.subtotal_minor,
        discountMinor: row.discount_minor, totalMinor: row.total_minor, paidMinor: row.paid_minor, changeMinor: row.change_minor,
        lines: lines.rows.map(({ lineId: _lineId, ...line }) => line), reprintCount: count };
    });
  });

  app.get("/v1/sales/lookup", async (request) => {
    const auth = requireAuth(request);
    const invoiceNo = String((request.query as Record<string, unknown>).invoiceNo ?? "").trim();
    if (!invoiceNo) throw new ApiError(400, "INVOICE_REQUIRED", "رقم الفاتورة مطلوب");
    const sale = await db.query(`
      SELECT s.id AS sale_id, s.invoice_no, s.subtotal_minor, s.discount_minor, s.total_minor, s.posted_at,
             jsonb_agg(jsonb_build_object('id', sl.id, 'nameAr', sl.name_snapshot, 'unitKind', sl.unit_kind_snapshot,
               'qtyMilli', sl.qty_milli, 'unitPriceMinor', sl.unit_price_minor, 'grossMinor', sl.gross_minor,
               'discountMinor', sl.discount_minor, 'netMinor', sl.net_minor,
               'returnedQtyMilli', sl.returned_qty_milli) ORDER BY sl.id) AS lines
      FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
      JOIN terminals t ON t.branch_id = s.branch_id
      WHERE s.invoice_no = $1 AND t.id = $2 GROUP BY s.id
    `, [invoiceNo, auth.terminalId]);
    if (!sale.rows[0]) throw new ApiError(404, "SALE_NOT_FOUND", "الفاتورة غير موجودة");
    return sale.rows[0];
  });
}
