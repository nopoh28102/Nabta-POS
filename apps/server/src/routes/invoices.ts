import type { FastifyInstance } from "fastify";
import { invoiceListQuerySchema, type InvoiceSummaryItem, type InvoiceDetailResponse } from "@nabta/contracts";
import type { Database } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError } from "../errors.js";

export function registerInvoiceRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/invoices", async (request) => {
    const auth = requireAuth(request);
    const parsed = invoiceListQuerySchema.parse(request.query);
    const { kind, query, from, to, limit } = parsed;

    // Retrieve branchId and warehouseId for current terminal
    const terminalInfo = await db.query<{ branch_id: string; warehouse_id: string }>(
      "SELECT branch_id, warehouse_id FROM terminals WHERE id = $1",
      [auth.terminalId]
    );
    if (!terminalInfo.rows[0]) throw new ApiError(404, "TERMINAL_NOT_FOUND", "نقطة البيع غير موجودة");
    const { branch_id: branchId, warehouse_id: warehouseId } = terminalInfo.rows[0];

    const includeSales = kind === "ALL" || kind === "SALE";
    const includePurchases = kind === "ALL" || kind === "PURCHASE";

    const parts: string[] = [];
    const values: unknown[] = [];

    if (includeSales) {
      values.push(branchId);
      const branchParam = `$${values.length}`;
      let salesConditions = `s.branch_id = ${branchParam}`;

      if (from) {
        values.push(from);
        salesConditions += ` AND (s.posted_at AT TIME ZONE 'Africa/Cairo')::date >= $${values.length}::date`;
      }
      if (to) {
        values.push(to);
        salesConditions += ` AND (s.posted_at AT TIME ZONE 'Africa/Cairo')::date <= $${values.length}::date`;
      }
      if (query) {
        values.push(query);
        const queryParam = `$${values.length}`;
        salesConditions += ` AND (s.invoice_no ILIKE ('%' || ${queryParam} || '%') OR (c.name IS NOT NULL AND c.name ILIKE ('%' || ${queryParam} || '%')))`;
      }

      parts.push(`
        SELECT
          s.id,
          'SALE' AS kind,
          s.invoice_no,
          COALESCE(c.name, 'عميل نقدي') AS party_name,
          c.phone AS party_phone,
          (SELECT count(*)::int FROM sale_lines sl WHERE sl.sale_id = s.id) AS item_count,
          s.total_minor,
          s.discount_minor,
          COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.sale_id = s.id), s.total_minor)::bigint AS paid_minor,
          0::bigint AS supply_expenses_minor,
          (SELECT p.method::text FROM payments p WHERE p.sale_id = s.id ORDER BY p.id LIMIT 1) AS payment_method,
          s.posted_at,
          COALESCE(u.display_name, 'كاشير') AS cashier_or_receiver_name
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE ${salesConditions}
      `);
    }

    if (includePurchases) {
      values.push(warehouseId);
      const warehouseParam = `$${values.length}`;
      let purchaseConditions = `pr.warehouse_id = ${warehouseParam}`;

      if (from) {
        values.push(from);
        purchaseConditions += ` AND (pr.posted_at AT TIME ZONE 'Africa/Cairo')::date >= $${values.length}::date`;
      }
      if (to) {
        values.push(to);
        purchaseConditions += ` AND (pr.posted_at AT TIME ZONE 'Africa/Cairo')::date <= $${values.length}::date`;
      }
      if (query) {
        values.push(query);
        const queryParam = `$${values.length}`;
        purchaseConditions += ` AND ((pr.supplier_invoice_no IS NOT NULL AND pr.supplier_invoice_no ILIKE ('%' || ${queryParam} || '%')) OR pr.supplier_name ILIKE ('%' || ${queryParam} || '%') OR (sup.name IS NOT NULL AND sup.name ILIKE ('%' || ${queryParam} || '%')))`;
      }

      parts.push(`
        SELECT
          pr.id,
          'PURCHASE' AS kind,
          COALESCE(pr.supplier_invoice_no, 'استلام-' || substring(pr.id::text from 1 for 8)) AS invoice_no,
          pr.supplier_name AS party_name,
          sup.phone AS party_phone,
          (SELECT count(*)::int FROM purchase_receipt_lines prl WHERE prl.receipt_id = pr.id) AS item_count,
          pr.total_minor,
          0::bigint AS discount_minor,
          pr.total_minor AS paid_minor,
          pr.supply_expenses_minor,
          'PURCHASE_RECEIPT' AS payment_method,
          pr.posted_at,
          COALESCE(u.display_name, 'أمين مخزن') AS cashier_or_receiver_name
        FROM purchase_receipts pr
        LEFT JOIN suppliers sup ON sup.id = pr.supplier_id
        LEFT JOIN users u ON u.id = pr.user_id
        WHERE ${purchaseConditions}
      `);
    }

    if (parts.length === 0) return { items: [] };

    values.push(limit);
    const limitParam = `$${values.length}`;
    const sql = `
      SELECT * FROM (
        ${parts.join(" UNION ALL ")}
      ) combined
      ORDER BY posted_at DESC
      LIMIT ${limitParam}
    `;

    interface QueryRow {
      id: string;
      kind: "SALE" | "PURCHASE";
      invoice_no: string;
      party_name: string;
      party_phone: string | null;
      item_count: number;
      total_minor: number;
      discount_minor: number;
      paid_minor: number;
      supply_expenses_minor: number;
      payment_method: string | null;
      posted_at: Date;
      cashier_or_receiver_name: string;
    }

    const result = await db.query<QueryRow>(sql, values);

    const items: InvoiceSummaryItem[] = result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      invoiceNo: row.invoice_no,
      partyName: row.party_name,
      partyPhone: row.party_phone,
      itemCount: row.item_count,
      totalMinor: Number(row.total_minor),
      discountMinor: Number(row.discount_minor),
      paidMinor: Number(row.paid_minor),
      supplyExpensesMinor: Number(row.supply_expenses_minor),
      paymentMethod: row.payment_method,
      postedAt: row.posted_at.toISOString(),
      cashierOrReceiverName: row.cashier_or_receiver_name,
    }));

    return { items };
  });

  app.get<{ Params: { kind: string; id: string } }>("/v1/invoices/:kind/:id", async (request): Promise<InvoiceDetailResponse> => {
    requireAuth(request);
    const { kind, id } = request.params;

    if (kind === "SALE") {
      const saleResult = await db.query<{
        id: string;
        invoice_no: string;
        party_name: string;
        party_phone: string | null;
        total_minor: number;
        subtotal_minor: number;
        discount_minor: number;
        paid_minor: number;
        change_minor: number;
        payment_method: string | null;
        posted_at: Date;
        cashier_or_receiver_name: string;
      }>(`
        SELECT
          s.id,
          s.invoice_no,
          COALESCE(c.name, 'عميل نقدي') AS party_name,
          c.phone AS party_phone,
          s.total_minor,
          s.subtotal_minor,
          s.discount_minor,
          COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.sale_id = s.id), s.total_minor)::bigint AS paid_minor,
          COALESCE((SELECT sum(p.change_minor) FROM payments p WHERE p.sale_id = s.id), 0)::bigint AS change_minor,
          (SELECT p.method::text FROM payments p WHERE p.sale_id = s.id ORDER BY p.id LIMIT 1) AS payment_method,
          s.posted_at,
          COALESCE(u.display_name, 'كاشير') AS cashier_or_receiver_name
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = $1
      `, [id]);

      if (!saleResult.rows[0]) throw new ApiError(404, "INVOICE_NOT_FOUND", "فاتورة البيع غير موجودة");
      const saleRow = saleResult.rows[0];

      const linesResult = await db.query<{
        productId: string;
        nameAr: string;
        unitKind: "PIECE" | "WEIGHT";
        qtyMilli: number;
        unitPriceMinor: number;
        totalMinor: number;
      }>(`
        SELECT
          sl.product_id AS "productId",
          sl.name_snapshot AS "nameAr",
          sl.unit_kind_snapshot AS "unitKind",
          sl.qty_milli AS "qtyMilli",
          sl.unit_price_minor AS "unitPriceMinor",
          sl.net_minor AS "totalMinor"
        FROM sale_lines sl
        WHERE sl.sale_id = $1
        ORDER BY sl.id
      `, [id]);

      return {
        id: saleRow.id,
        kind: "SALE",
        invoiceNo: saleRow.invoice_no,
        partyName: saleRow.party_name,
        partyPhone: saleRow.party_phone,
        itemCount: linesResult.rows.length,
        totalMinor: Number(saleRow.total_minor),
        subtotalMinor: Number(saleRow.subtotal_minor),
        discountMinor: Number(saleRow.discount_minor),
        paidMinor: Number(saleRow.paid_minor),
        changeMinor: Number(saleRow.change_minor),
        supplyExpensesMinor: 0,
        paymentMethod: saleRow.payment_method,
        postedAt: saleRow.posted_at.toISOString(),
        cashierOrReceiverName: saleRow.cashier_or_receiver_name,
        lines: linesResult.rows.map((row) => ({
          productId: row.productId,
          nameAr: row.nameAr,
          unitKind: row.unitKind,
          qtyMilli: Number(row.qtyMilli),
          unitPriceMinor: Number(row.unitPriceMinor),
          totalMinor: Number(row.totalMinor),
        })),
      };
    }

    if (kind === "PURCHASE") {
      const purchaseResult = await db.query<{
        id: string;
        invoice_no: string;
        party_name: string;
        party_phone: string | null;
        total_minor: number;
        subtotal_minor: number;
        supply_expenses_minor: number;
        posted_at: Date;
        cashier_or_receiver_name: string;
      }>(`
        SELECT
          pr.id,
          COALESCE(pr.supplier_invoice_no, 'استلام-' || substring(pr.id::text from 1 for 8)) AS invoice_no,
          pr.supplier_name AS party_name,
          sup.phone AS party_phone,
          pr.total_minor,
          pr.goods_minor AS subtotal_minor,
          pr.supply_expenses_minor,
          pr.posted_at,
          COALESCE(u.display_name, 'أمين مخزن') AS cashier_or_receiver_name
        FROM purchase_receipts pr
        LEFT JOIN suppliers sup ON sup.id = pr.supplier_id
        LEFT JOIN users u ON u.id = pr.user_id
        WHERE pr.id = $1
      `, [id]);

      if (!purchaseResult.rows[0]) throw new ApiError(404, "INVOICE_NOT_FOUND", "فاتورة التوريد غير موجودة");
      const purchaseRow = purchaseResult.rows[0];

      const linesResult = await db.query<{
        productId: string;
        nameAr: string;
        unitKind: "PIECE" | "WEIGHT";
        qtyMilli: number;
        unitPriceMinor: number;
        totalMinor: number;
        lotCode: string | null;
        expiresOn: string | null;
      }>(`
        SELECT
          prl.product_id AS "productId",
          p.name_ar AS "nameAr",
          p.unit_kind AS "unitKind",
          prl.qty_milli AS "qtyMilli",
          prl.unit_cost_minor AS "unitPriceMinor",
          prl.goods_minor AS "totalMinor",
          sl.lot_code AS "lotCode",
          sl.expires_on AS "expiresOn"
        FROM purchase_receipt_lines prl
        JOIN products p ON p.id = prl.product_id
        LEFT JOIN stock_lots sl ON sl.id = prl.lot_id
        WHERE prl.receipt_id = $1
        ORDER BY prl.id
      `, [id]);

      return {
        id: purchaseRow.id,
        kind: "PURCHASE",
        invoiceNo: purchaseRow.invoice_no,
        partyName: purchaseRow.party_name,
        partyPhone: purchaseRow.party_phone,
        itemCount: linesResult.rows.length,
        totalMinor: Number(purchaseRow.total_minor),
        subtotalMinor: Number(purchaseRow.subtotal_minor),
        discountMinor: 0,
        paidMinor: Number(purchaseRow.total_minor),
        changeMinor: 0,
        supplyExpensesMinor: Number(purchaseRow.supply_expenses_minor),
        paymentMethod: "PURCHASE_RECEIPT",
        postedAt: purchaseRow.posted_at.toISOString(),
        cashierOrReceiverName: purchaseRow.cashier_or_receiver_name,
        lines: linesResult.rows.map((row) => ({
          productId: row.productId,
          nameAr: row.nameAr,
          unitKind: row.unitKind,
          qtyMilli: Number(row.qtyMilli),
          unitPriceMinor: Number(row.unitPriceMinor),
          totalMinor: Number(row.totalMinor),
          lotCode: row.lotCode,
          expiresOn: row.expiresOn,
        })),
      };
    }

    throw new ApiError(400, "INVALID_KIND", "نوع الفاتورة غير صحيح");
  });
}
