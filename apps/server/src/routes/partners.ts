import type { FastifyInstance } from "fastify";
import { createCustomerRequestSchema, createPartnerDocumentRequestSchema, createSupplierRequestSchema, partnerDocumentListQuerySchema, partnerDocumentPaymentRequestSchema, partnerPaymentRequestSchema } from "@nabta/contracts";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { canonicalJson, sha256 } from "../security.js";

export function registerPartnerRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/partners/suppliers", async (request) => {
    requirePermission(request, "PARTNER_VIEW");
    const result = await db.query(`
      SELECT s.id, s.name, s.phone, s.active, s.opening_balance_minor,
             COALESCE(SUM(l.amount_minor), s.opening_balance_minor)::bigint AS balance_minor
      FROM suppliers s LEFT JOIN supplier_ledger l ON l.supplier_id = s.id
      WHERE s.active GROUP BY s.id ORDER BY s.name
    `);
    return result.rows;
  });

  app.get("/v1/partners/customers", async (request) => {
    requirePermission(request, "PARTNER_VIEW");
    const result = await db.query(`
      SELECT c.id, c.name, c.phone, c.active, c.credit_limit_minor, c.opening_balance_minor,
             COALESCE(SUM(l.amount_minor), c.opening_balance_minor)::bigint AS balance_minor
      FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id
      WHERE c.active GROUP BY c.id ORDER BY c.name
    `);
    return result.rows;
  });

  app.post("/v1/partners/suppliers", async (request, reply) => {
    const auth = requirePermission(request, "PARTNER_MANAGE");
    const body = createSupplierRequestSchema.parse(request.body);
    const supplier = await transaction(db, async (client) => {
      const row = await client.query<{ id: string }>("INSERT INTO suppliers(name, phone, opening_balance_minor) VALUES ($1, $2, $3) RETURNING id", [body.name, body.phone ?? null, body.openingBalanceMinor]);
      if (body.openingBalanceMinor) await client.query("INSERT INTO supplier_ledger(supplier_id, type, amount_minor, note, actor_user_id) VALUES ($1, 'OPENING', $2, $3, $4)", [row.rows[0]!.id, body.openingBalanceMinor, "رصيد افتتاحي", auth.userId]);
      await audit(client, auth, "SUPPLIER_CREATED", "supplier", row.rows[0]!.id, { name: body.name });
      return { id: row.rows[0]!.id, name: body.name };
    });
    return reply.status(201).send(supplier);
  });

  app.post("/v1/partners/customers", async (request, reply) => {
    const auth = requirePermission(request, "PARTNER_MANAGE");
    const body = createCustomerRequestSchema.parse(request.body);
    const customer = await transaction(db, async (client) => {
      const row = await client.query<{ id: string }>("INSERT INTO customers(name, phone, credit_limit_minor, opening_balance_minor) VALUES ($1, $2, $3, $4) RETURNING id", [body.name, body.phone ?? null, body.creditLimitMinor, body.openingBalanceMinor]);
      if (body.openingBalanceMinor) await client.query("INSERT INTO customer_ledger(customer_id, type, amount_minor, note, actor_user_id) VALUES ($1, 'OPENING', $2, $3, $4)", [row.rows[0]!.id, body.openingBalanceMinor, "رصيد افتتاحي", auth.userId]);
      await audit(client, auth, "CUSTOMER_CREATED", "customer", row.rows[0]!.id, { name: body.name });
      return { id: row.rows[0]!.id, name: body.name };
    });
    return reply.status(201).send(customer);
  });

  app.post("/v1/partners/customer/collect", async (request, reply) => {
    const auth = requirePermission(request, "PARTNER_MANAGE");
    const body = request.body as { idempotencyKey?: string; payment?: unknown };
    if (!body.idempotencyKey || !/^[0-9a-f-]{36}$/i.test(body.idempotencyKey)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب");
    const payment = partnerPaymentRequestSchema.parse(body.payment);
    const result = await transaction(db, async (client) => {
      const hash = sha256(canonicalJson(payment));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${body.idempotencyKey}`]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, body.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "مفتاح العملية مستخدم ببيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, body.idempotencyKey, hash]);
      const customer = await client.query<{ id: string }>("SELECT id FROM customers WHERE id = $1 AND active FOR UPDATE", [payment.partnerId]);
      if (!customer.rows[0]) throw new ApiError(404, "CUSTOMER_NOT_FOUND", "العميل غير موجود");
      const row = await client.query<{ id: string }>("INSERT INTO customer_ledger(customer_id, type, amount_minor, note, actor_user_id) VALUES ($1, 'COLLECTION', $2, $3, $4) RETURNING id", [payment.partnerId, -payment.amountMinor, payment.note, auth.userId]);
      await audit(client, auth, "CUSTOMER_COLLECTION", "customer_ledger", row.rows[0]!.id, { customerId: payment.partnerId, amountMinor: payment.amountMinor }, payment.note);
      const response = { ledgerId: row.rows[0]!.id, partnerId: payment.partnerId, amountMinor: payment.amountMinor };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, body.idempotencyKey, JSON.stringify(response)]);
      return response;
    });
    return reply.status(201).send(result);
  });

  app.post("/v1/partners/supplier/pay", async (request, reply) => {
    const auth = requirePermission(request, "PARTNER_MANAGE");
    const body = request.body as { idempotencyKey?: string; payment?: unknown };
    if (!body.idempotencyKey || !/^[0-9a-f-]{36}$/i.test(body.idempotencyKey)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب");
    const payment = partnerPaymentRequestSchema.parse(body.payment);
    const result = await transaction(db, async (client) => {
      const hash = sha256(canonicalJson(payment));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${body.idempotencyKey}`]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, body.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "مفتاح العملية مستخدم ببيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, body.idempotencyKey, hash]);
      const supplier = await client.query<{ id: string }>("SELECT id FROM suppliers WHERE id = $1 AND active FOR UPDATE", [payment.partnerId]);
      if (!supplier.rows[0]) throw new ApiError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
      const row = await client.query<{ id: string }>("INSERT INTO supplier_ledger(supplier_id, type, amount_minor, note, actor_user_id) VALUES ($1, 'PAYMENT', $2, $3, $4) RETURNING id", [payment.partnerId, -payment.amountMinor, payment.note, auth.userId]);
      await audit(client, auth, "SUPPLIER_PAYMENT", "supplier_ledger", row.rows[0]!.id, { supplierId: payment.partnerId, amountMinor: payment.amountMinor }, payment.note);
      const response = { ledgerId: row.rows[0]!.id, partnerId: payment.partnerId, amountMinor: payment.amountMinor };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, body.idempotencyKey, JSON.stringify(response)]);
      return response;
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/partners/documents", async (request) => {
    requirePermission(request, "PARTNER_VIEW");
    const query = partnerDocumentListQuerySchema.parse(request.query);
    const result = query.partnerKind === "SUPPLIER"
      ? await db.query(`SELECT d.*, s.name AS partner_name, COALESCE(SUM(p.amount_minor), 0)::bigint AS paid_minor FROM partner_documents d JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN partner_document_payments p ON p.document_id = d.id WHERE d.supplier_id = $1 GROUP BY d.id, s.name ORDER BY d.created_at DESC`, [query.partnerId])
      : await db.query(`SELECT d.*, c.name AS partner_name, COALESCE(SUM(p.amount_minor), 0)::bigint AS paid_minor FROM partner_documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN partner_document_payments p ON p.document_id = d.id WHERE d.customer_id = $1 GROUP BY d.id, c.name ORDER BY d.created_at DESC`, [query.partnerId]);
    return { documents: result.rows };
  });

  app.post("/v1/partners/documents", async (request, reply) => {
    const auth = requirePermission(request, "PARTNER_MANAGE");
    const body = request.body as { idempotencyKey?: string; document?: unknown };
    if (!body.idempotencyKey || !/^[0-9a-f-]{36}$/i.test(body.idempotencyKey)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب");
    const document = createPartnerDocumentRequestSchema.parse(body.document);
    const result = await transaction(db, async (client) => {
      const hash = sha256(canonicalJson(document));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${body.idempotencyKey}`]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, body.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "مفتاح العملية مستخدم ببيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, body.idempotencyKey, hash]);
      const partner = document.partnerKind === "SUPPLIER"
        ? await client.query<{ id: string }>("SELECT id FROM suppliers WHERE id = $1 AND active FOR UPDATE", [document.partnerId])
        : await client.query<{ id: string }>("SELECT id FROM customers WHERE id = $1 AND active FOR UPDATE", [document.partnerId]);
      if (!partner.rows[0]) throw new ApiError(404, "PARTNER_NOT_FOUND", "المورد أو العميل غير موجود أو غير نشط");
      const totalMinor = document.goodsMinor + document.feesMinor;
      const created = await client.query<{ id: string }>(`INSERT INTO partner_documents(partner_kind, supplier_id, customer_id, reference_no, goods_summary, goods_minor, fees_minor, total_minor, remaining_minor, status, note, due_on, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'OPEN', $9, $10, $11) RETURNING id`, [document.partnerKind, document.partnerKind === "SUPPLIER" ? document.partnerId : null, document.partnerKind === "CUSTOMER" ? document.partnerId : null, document.referenceNo || null, document.goodsSummary, document.goodsMinor, document.feesMinor, totalMinor, document.note || null, document.dueOn || null, auth.userId]);
      const documentId = created.rows[0]!.id;
      const ledgerTable = document.partnerKind === "SUPPLIER" ? "supplier_ledger" : "customer_ledger";
      const partnerColumn = document.partnerKind === "SUPPLIER" ? "supplier_id" : "customer_id";
      const ledgerType = document.partnerKind === "SUPPLIER" ? "PURCHASE" : "SALE_CREDIT";
      const description = `${document.partnerKind === "SUPPLIER" ? "فاتورة مورد" : "مديونية عميل"}${document.referenceNo ? ` ${document.referenceNo}` : ""}: ${document.goodsSummary}`;
      await client.query(`INSERT INTO ${ledgerTable}(${partnerColumn}, type, amount_minor, reference_id, note, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6)`, [document.partnerId, ledgerType, totalMinor, documentId, description, auth.userId]);
      await audit(client, auth, "PARTNER_DOCUMENT_CREATED", "partner_document", documentId, { partnerKind: document.partnerKind, partnerId: document.partnerId, referenceNo: document.referenceNo || null, goodsMinor: document.goodsMinor, feesMinor: document.feesMinor, totalMinor }, document.note);
      const response = { documentId, partnerId: document.partnerId, totalMinor, remainingMinor: totalMinor };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, body.idempotencyKey, JSON.stringify(response)]);
      return response;
    });
    return reply.status(201).send(result);
  });

  app.post("/v1/partners/documents/:documentId/payments", async (request, reply) => {
    const auth = requirePermission(request, "PARTNER_MANAGE");
    const body = request.body as { idempotencyKey?: string; payment?: unknown };
    if (!body.idempotencyKey || !/^[0-9a-f-]{36}$/i.test(body.idempotencyKey)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب");
    const payment = partnerDocumentPaymentRequestSchema.parse({ ...(body.payment as Record<string, unknown>), documentId: request.params && (request.params as { documentId?: string }).documentId });
    const result = await transaction(db, async (client) => {
      const hash = sha256(canonicalJson(payment));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.userId}:${body.idempotencyKey}`]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, body.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "مفتاح العملية مستخدم ببيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, body.idempotencyKey, hash]);
      const found = await client.query<{ id: string; partner_kind: "SUPPLIER" | "CUSTOMER"; supplier_id: string | null; customer_id: string | null; reference_no: string | null; remaining_minor: number }>("SELECT id, partner_kind, supplier_id, customer_id, reference_no, remaining_minor FROM partner_documents WHERE id = $1 FOR UPDATE", [payment.documentId]);
      const document = found.rows[0];
      if (!document) throw new ApiError(404, "PARTNER_DOCUMENT_NOT_FOUND", "فاتورة الحساب غير موجودة");
      if (payment.amountMinor > document.remaining_minor) throw new ApiError(422, "PAYMENT_EXCEEDS_REMAINING", "مبلغ السداد أكبر من المتبقي في هذه الفاتورة");
      const paymentRow = await client.query<{ id: string }>("INSERT INTO partner_document_payments(document_id, amount_minor, note, actor_user_id) VALUES ($1, $2, $3, $4) RETURNING id", [document.id, payment.amountMinor, payment.note, auth.userId]);
      const remainingMinor = document.remaining_minor - payment.amountMinor;
      const status = remainingMinor === 0 ? "SETTLED" : "PARTIAL";
      await client.query("UPDATE partner_documents SET remaining_minor = $2, status = $3 WHERE id = $1", [document.id, remainingMinor, status]);
      const ledgerTable = document.partner_kind === "SUPPLIER" ? "supplier_ledger" : "customer_ledger";
      const partnerColumn = document.partner_kind === "SUPPLIER" ? "supplier_id" : "customer_id";
      const ledgerType = document.partner_kind === "SUPPLIER" ? "PAYMENT" : "COLLECTION";
      const partnerId = document.supplier_id ?? document.customer_id;
      await client.query(`INSERT INTO ${ledgerTable}(${partnerColumn}, type, amount_minor, reference_id, note, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6)`, [partnerId, ledgerType, -payment.amountMinor, document.id, `سداد فاتورة ${document.reference_no ?? document.id.slice(0, 8)}: ${payment.note}`, auth.userId]);
      await audit(client, auth, "PARTNER_DOCUMENT_PAYMENT", "partner_document_payment", paymentRow.rows[0]!.id, { documentId: document.id, amountMinor: payment.amountMinor, remainingMinor, status }, payment.note);
      const response = { documentId: document.id, paymentId: paymentRow.rows[0]!.id, remainingMinor, status };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, body.idempotencyKey, JSON.stringify(response)]);
      return response;
    });
    return reply.status(201).send(result);
  });
}
