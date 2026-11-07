import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createPaymentIntentSchema, paymentDeviceBindingSchema, paymentRefundRequestSchema,
  paymentSettingsUpdateSchema,
} from "@nabta/contracts";
import type { AppConfig } from "../config.js";
import type { Database, DbClient } from "../db.js";
import { transaction } from "../db.js";
import { requireAuth, requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { ApiError } from "../errors.js";
import { decryptPaymentSecret, encryptPaymentSecret, type EncryptedValue } from "../payments/crypto.js";
import { KashierAdapter, KashierProtocolError, type KashierCredentials } from "../payments/kashier.js";
import { FawryAdapter, type FawryCredentials } from "../payments/fawry.js";
import { verifyPassword } from "../security.js";

type Environment = "TEST" | "LIVE";
type IntentStatus = "CREATED" | "AWAITING_CUSTOMER" | "PROCESSING" | "PENDING_CONFIRMATION" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED" | "RECONCILIATION_REQUIRED" | "REFUND_PENDING" | "REFUNDED";
type Provider = "KASHIER" | "FAWRY";
type ElectronicMethod = "KASHIER_POS_CARD" | "FAWRY_REFERENCE" | "ONLINE_CARD" | "MOBILE_WALLET" | "PAYMENT_LINK" | "INSTAPAY_QR" | "INSTAPAY_R2P" | "BANK_INSTALLMENTS" | "BNPL" | "MEEZA_CARD";

interface SettingsRow {
  environment: Environment;
  merchant_id: string | null;
  encrypted_credentials: Record<string, EncryptedValue>;
  webhook_url: string | null;
  merchant_redirect_url: string | null;
  relay_url: string | null;
  receipt_print_enabled: boolean;
  request_timeout_ms: number;
  retry_limit: number;
  enabled_methods: ElectronicMethod[];
}
interface IntentRow {
  id: string; quote_id: string; terminal_id: string; shift_id: string; user_id: string;
  method: ElectronicMethod; provider: Provider; status: IntentStatus; amount_minor: number; merchant_order_id: string;
  provider_session_id: string | null; provider_transaction_id: string | null; provider_order_id: string | null;
  checkout_url: string | null; device_serial_no: string | null; expires_at: Date; sale_id: string | null;
}
interface QuoteLine { productId: string; qtyMilli: number; }
interface QuoteRow { id: string; terminal_id: string; shift_id: string; user_id: string; total_minor: number; lines_json: QuoteLine[]; expires_at: Date; consumed_at: Date | null; }

export function registerPaymentRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.get("/v1/payments/settings", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const provider: Provider = (request.query as { provider?: string }).provider === "FAWRY" ? "FAWRY" : "KASHIER";
    const rows = await db.query<SettingsRow>("SELECT environment, merchant_id, encrypted_credentials, webhook_url, merchant_redirect_url, relay_url, receipt_print_enabled, request_timeout_ms, retry_limit, enabled_methods FROM payment_provider_settings WHERE provider = $1 ORDER BY environment", [provider]);
    const bindings = await db.query<{ terminal_id: string; serial_no: string; is_default: boolean; active: boolean }>("SELECT terminal_id, serial_no, is_default, active FROM payment_device_bindings WHERE provider = $1 ORDER BY terminal_id, is_default DESC, created_at", [provider]);
    const runtime = await db.query<{ active_environment: Environment }>("SELECT active_environment FROM payment_provider_runtime WHERE provider = $1", [provider]);
    return {
      provider, canEditLive: auth.role === "OWNER",
      activeEnvironment: runtime.rows[0]?.active_environment ?? "TEST",
      environments: rows.rows.map((row) => ({
        environment: row.environment, merchantId: row.merchant_id, webhookUrl: row.webhook_url ?? "", merchantRedirectUrl: row.merchant_redirect_url ?? "", relayUrl: row.relay_url ?? "",
        receiptPrintEnabled: row.receipt_print_enabled, requestTimeoutMs: row.request_timeout_ms, retryLimit: row.retry_limit,
        enabledMethods: row.enabled_methods ?? [], configured: provider === "KASHIER"
          ? Boolean(row.merchant_id && row.encrypted_credentials.secretKey && row.encrypted_credentials.apiKey && row.encrypted_credentials.paymentApiKey)
          : Boolean(row.merchant_id && row.encrypted_credentials.secureHashKey),
      })),
      devices: bindings.rows.map((binding) => ({ terminalId: binding.terminal_id, serialNo: binding.serial_no, isDefault: binding.is_default, active: binding.active })),
    };
  });

  app.put("/v1/payments/settings", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = paymentSettingsUpdateSchema.parse(request.body);
    if (auth.role !== "OWNER") throw new ApiError(403, "OWNER_REQUIRED", "إعداد مفاتيح المدفوعات متاح للمالك فقط");
    const user = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1 AND active", [auth.userId]);
    if (!user.rows[0] || !await verifyPassword(body.confirmationPassword, user.rows[0].password_hash)) throw new ApiError(403, "PAYMENT_REAUTH_REQUIRED", "أعد إدخال كلمة مرور المالك قبل حفظ مفاتيح الدفع");
    if (body.environment === "LIVE" && !config.NABTA_PAYMENT_ENCRYPTION_KEY) throw new ApiError(422, "PAYMENT_ENCRYPTION_KEY_REQUIRED", "أضف مفتاح تشفير المدفوعات إلى إعداد خادم نبته قبل تفعيل وضع Live");
    if (!config.NABTA_PAYMENT_ENCRYPTION_KEY) throw new ApiError(422, "PAYMENT_ENCRYPTION_KEY_REQUIRED", "أضف مفتاح تشفير المدفوعات إلى إعداد خادم نبته قبل حفظ المفاتيح");
    await transaction(db, async (client) => {
      const previous = await client.query<SettingsRow>("SELECT environment, merchant_id, encrypted_credentials, webhook_url, merchant_redirect_url, relay_url, receipt_print_enabled, request_timeout_ms, retry_limit, enabled_methods FROM payment_provider_settings WHERE provider = $1 AND environment = $2 FOR UPDATE", [body.provider, body.environment]);
      const old = previous.rows[0];
      const credentials = { ...(old?.encrypted_credentials ?? {}) } as Record<string, EncryptedValue>;
      if (body.provider === "KASHIER") {
        if (body.secretKey) credentials.secretKey = encryptPaymentSecret(body.secretKey, config.NABTA_PAYMENT_ENCRYPTION_KEY);
        if (body.apiKey) credentials.apiKey = encryptPaymentSecret(body.apiKey, config.NABTA_PAYMENT_ENCRYPTION_KEY);
        if (body.paymentApiKey) credentials.paymentApiKey = encryptPaymentSecret(body.paymentApiKey, config.NABTA_PAYMENT_ENCRYPTION_KEY);
      } else if (body.secureHashKey) credentials.secureHashKey = encryptPaymentSecret(body.secureHashKey, config.NABTA_PAYMENT_ENCRYPTION_KEY);
      if (body.relayToken) credentials.relayToken = encryptPaymentSecret(body.relayToken, config.NABTA_PAYMENT_ENCRYPTION_KEY);
      await client.query(`
        INSERT INTO payment_provider_settings(provider, environment, merchant_id, encrypted_credentials, webhook_url, merchant_redirect_url, relay_url, receipt_print_enabled, request_timeout_ms, retry_limit, enabled_methods, updated_by)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
        ON CONFLICT (provider, environment) DO UPDATE SET merchant_id = EXCLUDED.merchant_id, encrypted_credentials = EXCLUDED.encrypted_credentials,
          webhook_url = EXCLUDED.webhook_url, merchant_redirect_url = EXCLUDED.merchant_redirect_url, relay_url = EXCLUDED.relay_url, receipt_print_enabled = EXCLUDED.receipt_print_enabled,
          request_timeout_ms = EXCLUDED.request_timeout_ms, retry_limit = EXCLUDED.retry_limit, enabled_methods = EXCLUDED.enabled_methods, updated_by = EXCLUDED.updated_by, updated_at = now()
      `, [body.provider, body.environment, body.merchantId, JSON.stringify(credentials), body.webhookUrl || null, body.merchantRedirectUrl || null, body.relayUrl || null, body.receiptPrintEnabled, body.requestTimeoutMs, body.retryLimit, JSON.stringify(body.enabledMethods), auth.userId]);
      if (body.activateEnvironment) await client.query(`INSERT INTO payment_provider_runtime(provider, active_environment, updated_by)
        VALUES ($1, $2, $3) ON CONFLICT (provider) DO UPDATE SET active_environment = EXCLUDED.active_environment, updated_by = EXCLUDED.updated_by, updated_at = now()`, [body.provider, body.environment, auth.userId]);
      await audit(client, auth, "PAYMENT_PROVIDER_SETTINGS_UPDATED", "payment_provider_settings", body.environment, { provider: body.provider, environment: body.environment, merchantId: body.merchantId, changedSecrets: { secretKey: Boolean(body.secretKey), apiKey: Boolean(body.apiKey), paymentApiKey: Boolean(body.paymentApiKey), secureHashKey: Boolean(body.secureHashKey), relayToken: Boolean(body.relayToken) } });
    });
    return { saved: true };
  });

  app.get("/v1/payments/devices", async (request) => {
    requirePermission(request, "SETTINGS");
    const provider: Provider = (request.query as { provider?: string }).provider === "FAWRY" ? "FAWRY" : "KASHIER";
    const result = await db.query("SELECT terminal_id AS \"terminalId\", serial_no AS \"serialNo\", is_default AS \"isDefault\", active, created_at AS \"createdAt\" FROM payment_device_bindings WHERE provider = $1 ORDER BY terminal_id, is_default DESC, created_at", [provider]);
    return { devices: result.rows };
  });

  app.put("/v1/payments/devices", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const body = paymentDeviceBindingSchema.parse(request.body);
    await transaction(db, async (client) => {
      const terminal = await client.query<{ id: string }>("SELECT id FROM terminals WHERE id = $1 FOR UPDATE", [body.terminalId]);
      if (!terminal.rows[0]) throw new ApiError(404, "TERMINAL_NOT_FOUND", "نقطة البيع غير موجودة");
      if (body.isDefault && body.active) await client.query("UPDATE payment_device_bindings SET is_default = false, updated_at = now() WHERE terminal_id = $1 AND provider = $2 AND is_default", [body.terminalId, body.provider]);
      await client.query(`INSERT INTO payment_device_bindings(terminal_id, provider, serial_no, is_default, active, created_by) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (provider, serial_no) DO UPDATE SET terminal_id = EXCLUDED.terminal_id, is_default = EXCLUDED.is_default, active = EXCLUDED.active, updated_at = now()`, [body.terminalId, body.provider, body.serialNo, body.isDefault, body.active, auth.userId]);
      await audit(client, auth, "PAYMENT_DEVICE_BOUND", "payment_device_binding", body.terminalId, { provider: body.provider, serialNo: body.serialNo, isDefault: body.isDefault, active: body.active });
    });
    return { saved: true };
  });

  app.post("/v1/payments/intents", async (request, reply) => {
    const auth = requirePermission(request, "SALE_POST");
    const body = createPaymentIntentSchema.parse(request.body);
    if (body.terminalId !== auth.terminalId) throw new ApiError(403, "TERMINAL_MISMATCH", "الجلسة مرتبطة بنقطة بيع أخرى");
    const provider: Provider = body.method === "FAWRY_REFERENCE" ? "FAWRY" : "KASHIER";
    const environment = await activeEnvironment(db, provider);
    const intent = await createIntent(db, auth, body, environment, provider);
    try {
      const started = await startIntent(db, config, intent.id, environment);
      return reply.status(201).send(started);
    } catch (cause) {
      await markIntentFailed(db, intent.id, cause);
      throw cause;
    }
  });

  app.get<{ Params: { id: string } }>("/v1/payments/intents/:id", async (request) => {
    const auth = requireAuth(request);
    const intent = await db.query<IntentRow>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id FROM payment_intents WHERE id = $1", [request.params.id]);
    const row = intent.rows[0];
    if (!row || row.terminal_id !== auth.terminalId) throw new ApiError(404, "PAYMENT_INTENT_NOT_FOUND", "طلب الدفع غير موجود");
    return publicIntent(row);
  });

  app.post<{ Params: { id: string } }>("/v1/payments/intents/:id/verify", async (request) => {
    const auth = requirePermission(request, "SALE_POST");
    const intent = await getOwnedIntent(db, request.params.id, auth.terminalId);
    const environment = await activeEnvironment(db, intent.provider);
    if (intent.status === "SUCCEEDED" || intent.status === "FAILED" || intent.status === "CANCELLED" || intent.status === "EXPIRED") return publicIntent(intent);
    if (!intent.provider_session_id) return publicIntent(intent);
    const providerPayload = intent.provider === "FAWRY"
      ? await configuredFawryAdapter(db, config, environment).then((adapter) => adapter.getPaymentStatus(intent.merchant_order_id))
      : await configuredAdapter(db, config, environment).then((adapter) => adapter.getPaymentSession(intent.provider_session_id!));
    const result = providerStatus(providerPayload);
    await applyProviderOutcome(db, intent.id, result, providerPayload);
    return publicIntent((await getOwnedIntent(db, intent.id, auth.terminalId)));
  });

  app.post<{ Params: { id: string } }>("/v1/payments/intents/:id/cancel", async (request) => {
    const auth = requirePermission(request, "SALE_POST");
    const intent = await getOwnedIntent(db, request.params.id, auth.terminalId);
    if (["SUCCEEDED", "REFUNDED"].includes(intent.status)) throw new ApiError(409, "PAYMENT_ALREADY_SETTLED", "لا يمكن إلغاء عملية مدفوعة");
    await transaction(db, async (client) => {
      await client.query("UPDATE payment_intents SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [intent.id]);
      await client.query("UPDATE payment_reservations SET released_at = now() WHERE payment_intent_id = $1 AND released_at IS NULL", [intent.id]);
      await paymentAudit(client, intent.id, auth.userId, "PAYMENT_CANCELLED", {});
    });
    return { cancelled: true };
  });

  app.post<{ Params: { id: string } }>("/v1/payments/intents/:id/refunds", async (request) => {
    const auth = requirePermission(request, "SALE_RETURN");
    const body = paymentRefundRequestSchema.parse(request.body);
    const intent = await getOwnedIntent(db, request.params.id, auth.terminalId);
    if (intent.status !== "SUCCEEDED" || !intent.provider_order_id) throw new ApiError(409, "PAYMENT_REFUND_UNAVAILABLE", "لا يمكن طلب رد إلكتروني لهذه العملية");
    const prior = await db.query<{ amount_minor: number }>("SELECT COALESCE(SUM(amount_minor), 0)::bigint AS amount_minor FROM payment_refunds WHERE payment_intent_id = $1 AND status IN ('REFUND_PENDING', 'REFUNDED')", [intent.id]);
    if (prior.rows[0]!.amount_minor + body.amountMinor > intent.amount_minor) throw new ApiError(422, "REFUND_EXCEEDS_PAYMENT", "قيمة الاسترجاع أكبر من قيمة التحصيل المؤكد");
    const inserted = await transaction(db, async (client) => {
      const refund = await client.query<{ id: string }>("INSERT INTO payment_refunds(payment_intent_id, amount_minor, idempotency_key, requested_by) VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING id", [intent.id, body.amountMinor, body.idempotencyKey, auth.userId]);
      await paymentAudit(client, intent.id, auth.userId, "REFUND_REQUESTED", { amountMinor: body.amountMinor, refundId: refund.rows[0]!.id });
      return refund.rows[0]!.id;
    });
    const environment = await activeEnvironment(db, intent.provider);
    if (intent.provider === "FAWRY") throw new ApiError(422, "FAWRY_REFUND_REQUIRES_MERCHANT_PORTAL", "استرجاع فوري يحتاج مسار الاسترجاع المعتمد في حساب التاجر لدى فوري");
    const adapter = await configuredAdapter(db, config, environment);
    try {
      const provider = await adapter.refundOrder(intent.provider_order_id, body.amountMinor, intent.provider_transaction_id ?? undefined);
      const status = providerStatus(provider);
      await db.query("UPDATE payment_refunds SET status = $2, provider_refund_id = COALESCE($3, provider_refund_id), completed_at = CASE WHEN $2 = 'REFUNDED' THEN now() ELSE NULL END WHERE id = $1", [inserted, status === "SUCCEEDED" ? "REFUNDED" : "REFUND_PENDING", stringField(provider, "transactionId")]);
      return { refundId: inserted, status: status === "SUCCEEDED" ? "REFUNDED" : "REFUND_PENDING" };
    } catch (cause) {
      await db.query("UPDATE payment_refunds SET status = 'FAILED', failure_message = $2 WHERE id = $1", [inserted, safeError(cause)]);
      throw cause;
    }
  });

  app.post("/v1/payments/methods/refresh", async (request) => {
    requirePermission(request, "SETTINGS");
    const provider: Provider = (request.body as { provider?: string } | undefined)?.provider === "FAWRY" ? "FAWRY" : "KASHIER";
    const environment = await activeEnvironment(db, provider);
    if (provider === "FAWRY") {
      await configuredFawryAdapter(db, config, environment);
      return { provider, environment, methods: ["FAWRY_REFERENCE"] };
    }
    const methods = await configuredAdapter(db, config, environment).then((adapter) => adapter.getMerchantPaymentMethods());
    return { provider, environment, methods };
  });

  app.post("/v1/payments/reconcile", async (request) => {
    const auth = requirePermission(request, "SETTINGS");
    const provider: Provider = (request.body as { provider?: string } | undefined)?.provider === "FAWRY" ? "FAWRY" : "KASHIER";
    const environment = await activeEnvironment(db, provider);
    const run = await db.query<{ id: string }>("INSERT INTO payment_reconciliation_runs(provider, environment, requested_by, status) VALUES ($1, $2, $3, 'STARTED') RETURNING id", [provider, environment, auth.userId]);
    const pending = await db.query<IntentRow>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id FROM payment_intents WHERE provider = $1 AND status IN ('AWAITING_CUSTOMER', 'PROCESSING', 'PENDING_CONFIRMATION') AND provider_session_id IS NOT NULL ORDER BY created_at LIMIT 100", [provider]);
    let reconciled = 0;
    if (provider === "FAWRY") {
      const adapter = await configuredFawryAdapter(db, config, environment);
      for (const intent of pending.rows) {
        try { const status = await adapter.getPaymentStatus(intent.merchant_order_id); await applyProviderOutcome(db, intent.id, providerStatus(status), status); reconciled += 1; } catch { /* retained for the next reconciliation run */ }
      }
    } else {
      const relay = await syncRelayEvents(db, config, environment);
      const adapter = await configuredAdapter(db, config, environment);
      for (const intent of pending.rows) {
        try { const status = await adapter.getPaymentSession(intent.provider_session_id!); await applyProviderOutcome(db, intent.id, providerStatus(status), status); reconciled += 1; } catch { /* retained for the next reconciliation run */ }
      }
      reconciled += relay.processed;
    }
    await db.query("UPDATE payment_reconciliation_runs SET status = 'COMPLETED', summary = $2::jsonb, completed_at = now() WHERE id = $1", [run.rows[0]!.id, JSON.stringify({ candidates: pending.rows.length, reconciled })]);
    return { runId: run.rows[0]!.id, candidates: pending.rows.length, reconciled };
  });

  // This route is intended for the authenticated Cloudflare relay.  It is
  // still signature-verified locally, so a relay compromise cannot turn an
  // arbitrary request into a settled payment.
  app.post<{ Params: { environment: Environment } }>("/v1/payments/webhooks/kashier/:environment", async (request, reply) => {
    const environment = request.params.environment === "LIVE" ? "LIVE" : "TEST";
    const payload = request.body as { event?: unknown; data?: Record<string, unknown> };
    const signature = request.headers["x-kashier-signature"];
    const settings = await loadSettings(db, environment, "KASHIER");
    if (!settings) throw new ApiError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "إعداد Kashier غير مكتمل");
    const paymentApiKey = decryptCredential(settings, "paymentApiKey", config);
    const valid = typeof signature === "string" && verifyWebhookSignature(payload.data, signature, paymentApiKey);
    if (!valid) throw new ApiError(401, "WEBHOOK_SIGNATURE_INVALID", "توقيع webhook غير صالح");
    const data = payload.data ?? {};
    const eventKey = `${String(data.transactionId ?? "none")}::${String(data.status ?? "none")}::${String(payload.event ?? "unknown")}`;
    const stored = await db.query<{ id: string }>(`INSERT INTO payment_provider_events(provider, environment, event_type, provider_event_key, merchant_order_id, provider_transaction_id, signature_valid, payload)
      VALUES ('KASHIER', $1, $2, $3, $4, $5, true, $6::jsonb) ON CONFLICT (provider, environment, provider_event_key) DO NOTHING RETURNING id`, [environment, String(payload.event ?? "unknown"), eventKey, stringField(data, "merchantOrderId"), stringField(data, "transactionId"), JSON.stringify(payload)]);
    if (!stored.rows[0]) return reply.status(409).send();
    const orderId = stringField(data, "merchantOrderId");
    if (orderId) {
      const intent = await db.query<{ id: string }>("SELECT id FROM payment_intents WHERE merchant_order_id = $1", [orderId]);
      if (intent.rows[0]) await applyProviderOutcome(db, intent.rows[0].id, providerStatus(data), data);
    }
    await db.query("UPDATE payment_provider_events SET processed_at = now() WHERE id = $1", [stored.rows[0].id]);
    return reply.status(200).send();
  });

  // Fawry calls this endpoint after a reference-number payment changes state.
  // The signature is checked again on the local server; a relay cannot settle
  // a sale on its own.
  app.post<{ Params: { environment: Environment } }>("/v1/payments/webhooks/fawry/:environment", async (request, reply) => {
    const environment = request.params.environment === "LIVE" ? "LIVE" : "TEST";
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const adapter = await configuredFawryAdapter(db, config, environment);
    if (!adapter.verifyMessageSignature(payload)) throw new ApiError(401, "WEBHOOK_SIGNATURE_INVALID", "توقيع إشعار فوري غير صالح");
    const merchantOrderId = stringField(payload, "merchantRefNum") ?? stringField(payload, "merchantRefNumber");
    const transactionId = stringField(payload, "fawryRefNumber") ?? stringField(payload, "paymentRefrenceNumber");
    const eventKey = `${merchantOrderId ?? "none"}::${transactionId ?? "none"}::${String(payload.orderStatus ?? "unknown")}`;
    const stored = await db.query<{ id: string }>(`INSERT INTO payment_provider_events(provider, environment, event_type, provider_event_key, merchant_order_id, provider_transaction_id, signature_valid, payload)
      VALUES ('FAWRY', $1, 'PAYMENT_STATUS', $2, $3, $4, true, $5::jsonb)
      ON CONFLICT (provider, environment, provider_event_key) DO NOTHING RETURNING id`, [environment, eventKey, merchantOrderId ?? null, transactionId ?? null, JSON.stringify(payload)]);
    if (!stored.rows[0]) return reply.status(409).send();
    if (merchantOrderId) {
      const intent = await db.query<{ id: string }>("SELECT id FROM payment_intents WHERE provider = 'FAWRY' AND merchant_order_id = $1", [merchantOrderId]);
      if (intent.rows[0]) await applyProviderOutcome(db, intent.rows[0].id, providerStatus(payload), payload);
    }
    await db.query("UPDATE payment_provider_events SET processed_at = now() WHERE id = $1", [stored.rows[0].id]);
    return reply.status(200).send({ received: true });
  });
}

async function createIntent(db: Database, auth: ReturnType<typeof requireAuth>, body: ReturnType<typeof createPaymentIntentSchema.parse>, environment: Environment, provider: Provider): Promise<IntentRow> {
  return transaction(db, async (client) => {
    const existing = await client.query<IntentRow>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id FROM payment_intents WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE", [auth.userId, body.idempotencyKey]);
    if (existing.rows[0]) return existing.rows[0];
    const quote = await client.query<QuoteRow>("SELECT id, terminal_id, shift_id, user_id, total_minor, lines_json, expires_at, consumed_at FROM quotes WHERE id = $1 FOR UPDATE", [body.quoteId]);
    const row = quote.rows[0];
    if (!row || row.terminal_id !== auth.terminalId || row.shift_id !== body.shiftId || row.user_id !== auth.userId || row.consumed_at) throw new ApiError(409, "QUOTE_NOT_AVAILABLE", "لا يمكن بدء دفع لهذا العرض");
    const shift = await client.query("SELECT id FROM shifts WHERE id = $1 AND terminal_id = $2 AND user_id = $3 AND status = 'OPEN' FOR UPDATE", [body.shiftId, auth.terminalId, auth.userId]);
    if (!shift.rows[0]) throw new ApiError(409, "SHIFT_CLOSED", "الوردية مغلقة أو لا تخص هذا الكاشير");
    const ttl = new Date(Date.now() + 10 * 60_000);
    const warehouse = await client.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1", [auth.terminalId]);
    for (const line of row.lines_json) {
      const stock = await client.query<{ qty_milli: number }>(`SELECT sb.qty_milli - COALESCE((SELECT SUM(pr.qty_milli) FROM payment_reservations pr WHERE pr.warehouse_id = sb.warehouse_id AND pr.product_id = sb.product_id AND pr.released_at IS NULL AND pr.expires_at > now()), 0)::bigint AS qty_milli FROM stock_balances sb WHERE sb.warehouse_id = $1 AND sb.product_id = $2 FOR UPDATE`, [warehouse.rows[0]!.warehouse_id, line.productId]);
      if (!stock.rows[0] || stock.rows[0].qty_milli < line.qtyMilli) throw new ApiError(409, "INSUFFICIENT_STOCK", "المخزون غير كافٍ لحجز عملية الدفع الإلكتروني");
    }
    if (body.method === "FAWRY_REFERENCE" && (!body.customerMobile || !body.customerEmail)) throw new ApiError(422, "FAWRY_CUSTOMER_CONTACT_REQUIRED", "رقم هاتف العميل وبريده الإلكتروني مطلوبان لإنشاء رقم فوري المرجعي");
    const intentId = randomUUID();
    const merchantOrderId = provider === "FAWRY" ? `${Date.now()}${Math.floor(Math.random() * 900 + 100)}` : `NABTA-${intentId}`;
    const device = body.method === "KASHIER_POS_CARD" ? await client.query<{ serial_no: string }>("SELECT serial_no FROM payment_device_bindings WHERE terminal_id = $1 AND provider = 'KASHIER' AND active ORDER BY is_default DESC, created_at LIMIT 1 FOR UPDATE", [auth.terminalId]) : { rows: [] };
    if (body.method === "KASHIER_POS_CARD" && !device.rows[0]) throw new ApiError(422, "KASHIER_TERMINAL_NOT_BOUND", "اربط ماكينة Kashier بنقطة البيع من الإعدادات أولاً");
    const intent = await client.query<IntentRow>(`INSERT INTO payment_intents(id, quote_id, terminal_id, shift_id, user_id, method, provider, amount_minor, merchant_order_id, idempotency_key, device_serial_no, expires_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      RETURNING id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id`, [intentId, row.id, auth.terminalId, body.shiftId, auth.userId, body.method, provider, row.total_minor, merchantOrderId, body.idempotencyKey, device.rows[0]?.serial_no ?? null, ttl.toISOString(), JSON.stringify({ printReceipt: body.printReceipt, environment, customerName: body.customerName, customerMobile: body.customerMobile, customerEmail: body.customerEmail })]);
    for (const line of row.lines_json) await client.query("INSERT INTO payment_reservations(payment_intent_id, warehouse_id, product_id, qty_milli, expires_at) VALUES ($1, $2, $3, $4, $5)", [intentId, warehouse.rows[0]!.warehouse_id, line.productId, line.qtyMilli, ttl.toISOString()]);
    await client.query("UPDATE quotes SET expires_at = GREATEST(expires_at, $2) WHERE id = $1", [row.id, ttl.toISOString()]);
    await paymentAudit(client, intentId, auth.userId, "PAYMENT_INTENT_CREATED", { method: body.method, amountMinor: row.total_minor, environment });
    return intent.rows[0]!;
  });
}

async function startIntent(db: Database, config: AppConfig, intentId: string, environment: Environment): Promise<ReturnType<typeof publicIntent>> {
  const intent = await db.query<IntentRow & { metadata: Record<string, unknown> }>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id, metadata FROM payment_intents WHERE id = $1", [intentId]);
  const row = intent.rows[0]!;
  if (row.status !== "CREATED") return publicIntent(row);
  const attemptId = randomUUID();
  await db.query("INSERT INTO payment_attempts(payment_intent_id, attempt_no, operation, idempotency_key, status) VALUES ($1, 1, 'START', $2, 'STARTED')", [row.id, attemptId]);
  const settings = await loadSettings(db, environment, row.provider);
  const webhookUrl = settings?.relay_url || settings?.webhook_url || undefined;
  let result;
  if (row.method === "FAWRY_REFERENCE") {
    const adapter = await configuredFawryAdapter(db, config, environment);
    const customerName = stringField(row.metadata, "customerName");
    result = await adapter.createReference({ merchantRefNumber: row.merchant_order_id, amountMinor: row.amount_minor, expiresAt: row.expires_at, ...(customerName !== undefined ? { customerName } : {}), customerMobile: stringField(row.metadata, "customerMobile")!, customerEmail: stringField(row.metadata, "customerEmail")!, ...(webhookUrl ? { webhookUrl } : {}), description: `Nabta POS ${row.merchant_order_id}` });
  }
  else if (row.method === "KASHIER_POS_CARD") {
    const adapter = await configuredAdapter(db, config, environment);
    result = await adapter.startPosSale({ serialNo: row.device_serial_no!, amountMinor: row.amount_minor, merchantOrderId: row.merchant_order_id, printReceipt: settings?.receipt_print_enabled ?? true, ...(webhookUrl ? { webhookUrl } : {}) });
  }
  else if (["ONLINE_CARD", "MOBILE_WALLET", "BANK_INSTALLMENTS", "BNPL", "MEEZA_CARD"].includes(row.method)) {
    const adapter = await configuredAdapter(db, config, environment);
    if (!settings?.merchant_redirect_url) throw new ApiError(422, "PAYMENT_REDIRECT_URL_REQUIRED", "أدخل رابط العودة HTTPS الخاص بالتاجر قبل استخدام جلسة الدفع المستضافة");
    result = await adapter.createPaymentSession({ amountMinor: row.amount_minor, merchantOrderId: row.merchant_order_id, expiresAt: row.expires_at.toISOString(), allowedMethods: allowedMethods(row.method), ...(webhookUrl ? { webhookUrl } : {}), redirectUrl: settings.merchant_redirect_url });
  }
  else throw new ApiError(422, "PAYMENT_METHOD_REQUIRES_ACTIVATION", "هذه الوسيلة تحتاج تفعيلًا وعقدًا مخصصًا من Kashier قبل استخدامها");
  await transaction(db, async (client) => {
    const resultRaw = ("raw" in result ? result.raw : result) as Record<string, unknown>;
    const providerSessionId = "providerSessionId" in result && typeof result.providerSessionId === "string" ? result.providerSessionId : undefined;
    const checkoutUrl = "checkoutUrl" in result && typeof result.checkoutUrl === "string" ? result.checkoutUrl : undefined;
    await client.query("UPDATE payment_attempts SET status = 'ACCEPTED', response_metadata = $2::jsonb, completed_at = now() WHERE payment_intent_id = $1 AND attempt_no = 1", [row.id, JSON.stringify(resultRaw)]);
    const fawryReference = row.method === "FAWRY_REFERENCE" ? stringField(resultRaw, "fawryRefNumber") ?? stringField(resultRaw, "referenceNumber") : undefined;
    await client.query("UPDATE payment_intents SET status = 'AWAITING_CUSTOMER', provider_session_id = $2, checkout_url = $3, provider_transaction_id = COALESCE($4, provider_transaction_id), updated_at = now() WHERE id = $1", [row.id, providerSessionId ?? fawryReference ?? null, checkoutUrl ?? null, fawryReference ?? null]);
    await paymentAudit(client, row.id, row.user_id, "PAYMENT_DISPATCHED", { method: row.method, providerSessionId: providerSessionId ?? fawryReference ?? null });
  });
  return publicIntent((await db.query<IntentRow>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id FROM payment_intents WHERE id = $1", [row.id])).rows[0]!);
}

async function markIntentFailed(db: Database, intentId: string, cause: unknown): Promise<void> {
  await transaction(db, async (client) => {
    await client.query("UPDATE payment_intents SET status = 'FAILED', failure_code = $2, failure_message = $3, updated_at = now() WHERE id = $1 AND status = 'CREATED'", [intentId, cause instanceof KashierProtocolError ? cause.code : "PAYMENT_START_FAILED", safeError(cause)]);
    await client.query("UPDATE payment_reservations SET released_at = now() WHERE payment_intent_id = $1 AND released_at IS NULL", [intentId]);
    await paymentAudit(client, intentId, null, "PAYMENT_START_FAILED", { code: cause instanceof KashierProtocolError ? cause.code : "PAYMENT_START_FAILED" });
  });
}

async function applyProviderOutcome(db: Database, intentId: string, status: IntentStatus, payload: Record<string, unknown>): Promise<void> {
  await transaction(db, async (client) => {
    const intent = await client.query<IntentRow>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id FROM payment_intents WHERE id = $1 FOR UPDATE", [intentId]);
    const row = intent.rows[0];
    if (!row || ["SUCCEEDED", "REFUNDED"].includes(row.status)) return;
    const next = row.expires_at <= new Date() && status !== "SUCCEEDED" ? "EXPIRED" : status;
    const transactionId = stringField(payload, "transactionId") ?? stringField(payload, "fawryRefNumber") ?? stringField(payload, "paymentRefrenceNumber");
    const orderId = stringField(payload, "kashierOrderId") ?? stringField(payload, "orderId") ?? stringField(payload, "merchantRefNum") ?? stringField(payload, "merchantRefNumber");
    await client.query("UPDATE payment_intents SET status = $2, provider_transaction_id = COALESCE($3, provider_transaction_id), provider_order_id = COALESCE($4, provider_order_id), failure_code = CASE WHEN $2 = 'FAILED' THEN $5 ELSE NULL END, updated_at = now(), completed_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE completed_at END WHERE id = $1", [row.id, next, transactionId, orderId, next === "FAILED" ? stringField(payload, "transactionResponseCode") ?? "KASHIER_FAILED" : null]);
    if (["FAILED", "CANCELLED", "EXPIRED"].includes(next)) await client.query("UPDATE payment_reservations SET released_at = now() WHERE payment_intent_id = $1 AND released_at IS NULL", [row.id]);
    await paymentAudit(client, row.id, null, "PAYMENT_PROVIDER_STATUS", { status: next, transactionId: transactionId ?? null, orderId: orderId ?? null });
  });
}

async function getOwnedIntent(db: Database, intentId: string, terminalId: string): Promise<IntentRow> {
  const result = await db.query<IntentRow>("SELECT id, quote_id, terminal_id, shift_id, user_id, method, provider, status, amount_minor, merchant_order_id, provider_session_id, provider_transaction_id, provider_order_id, checkout_url, device_serial_no, expires_at, sale_id FROM payment_intents WHERE id = $1", [intentId]);
  if (!result.rows[0] || result.rows[0].terminal_id !== terminalId) throw new ApiError(404, "PAYMENT_INTENT_NOT_FOUND", "طلب الدفع غير موجود");
  return result.rows[0];
}
async function loadSettings(db: Database, environment: Environment, provider: Provider = "FAWRY"): Promise<SettingsRow | null> { return (await db.query<SettingsRow>("SELECT environment, merchant_id, encrypted_credentials, webhook_url, merchant_redirect_url, relay_url, receipt_print_enabled, request_timeout_ms, retry_limit, enabled_methods FROM payment_provider_settings WHERE provider = $1 AND environment = $2", [provider, environment])).rows[0] ?? null; }
export async function syncRelayEvents(db: Database, config: AppConfig, environment: Environment): Promise<{ processed: number }> {
  const settings = await loadSettings(db, environment, "KASHIER");
  if (!settings?.relay_url || !settings.encrypted_credentials.relayToken) return { processed: 0 };
  const relayToken = decryptCredential(settings, "relayToken", config);
  let eventsUrl: URL;
  try { eventsUrl = new URL("/events", settings.relay_url); } catch { throw new ApiError(422, "PAYMENT_RELAY_URL_INVALID", "رابط مرحّل أحداث Kashier غير صالح"); }
  let response: Response;
  try { response = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${relayToken}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ApiError(503, "PAYMENT_RELAY_UNAVAILABLE", "تعذر الاتصال بمرحّل أحداث Kashier"); }
  if (!response.ok) throw new ApiError(503, "PAYMENT_RELAY_REJECTED", "رفض مرحّل أحداث Kashier طلب التسوية");
  const body = await response.json() as { events?: Array<{ id: number; environment: Environment; signature: string; payload: { event?: unknown; data?: Record<string, unknown> } }> };
  let processed = 0;
  for (const event of body.events ?? []) {
    if (event.environment !== environment || !Number.isSafeInteger(event.id) || !event.payload?.data || !verifyWebhookSignature(event.payload.data, event.signature, decryptCredential(settings, "paymentApiKey", config))) continue;
    const data = event.payload.data;
    const eventKey = `${String(data.transactionId ?? "none")}::${String(data.status ?? "none")}::${String(event.payload.event ?? "unknown")}`;
    const stored = await db.query<{ id: string }>(`INSERT INTO payment_provider_events(provider, environment, event_type, provider_event_key, merchant_order_id, provider_transaction_id, signature_valid, payload)
      VALUES ('KASHIER', $1, $2, $3, $4, $5, true, $6::jsonb) ON CONFLICT (provider, environment, provider_event_key) DO NOTHING RETURNING id`, [environment, String(event.payload.event ?? "unknown"), eventKey, stringField(data, "merchantOrderId"), stringField(data, "transactionId"), JSON.stringify(event.payload)]);
    const orderId = stringField(data, "merchantOrderId");
    if (orderId) {
      const intent = await db.query<{ id: string }>("SELECT id FROM payment_intents WHERE merchant_order_id = $1", [orderId]);
      if (intent.rows[0]) await applyProviderOutcome(db, intent.rows[0].id, providerStatus(data), data);
    }
    if (stored.rows[0]) await db.query("UPDATE payment_provider_events SET processed_at = now() WHERE id = $1", [stored.rows[0].id]);
    const ackUrl = new URL(`/events/${event.id}/ack`, eventsUrl);
    await fetch(ackUrl, { method: "POST", headers: { Authorization: `Bearer ${relayToken}` }, signal: AbortSignal.timeout(10_000) });
    processed += 1;
  }
  return { processed };
}
async function configuredAdapter(db: Database, config: AppConfig, environment: Environment): Promise<KashierAdapter> {
  const settings = await loadSettings(db, environment, "KASHIER");
  if (!settings?.merchant_id) throw new ApiError(422, "PAYMENT_PROVIDER_NOT_CONFIGURED", "أكمل إعداد Kashier في الإعدادات أولاً");
  const credentials: KashierCredentials = { merchantId: settings.merchant_id, secretKey: decryptCredential(settings, "secretKey", config), apiKey: decryptCredential(settings, "apiKey", config), paymentApiKey: decryptCredential(settings, "paymentApiKey", config) };
  return new KashierAdapter(environment, credentials);
}
function decryptCredential(settings: SettingsRow, name: "secretKey" | "apiKey" | "paymentApiKey" | "relayToken", config: AppConfig): string { const stored = settings.encrypted_credentials[name]; if (!stored) throw new ApiError(422, "PAYMENT_PROVIDER_NOT_CONFIGURED", "بيانات Kashier غير مكتملة"); try { return decryptPaymentSecret(stored, config.NABTA_PAYMENT_ENCRYPTION_KEY); } catch { throw new ApiError(422, "PAYMENT_CREDENTIALS_UNAVAILABLE", "تعذر فتح بيانات Kashier المشفرة؛ تحقق من مفتاح تشفير الخادم"); } }
async function configuredFawryAdapter(db: Database, config: AppConfig, environment: Environment): Promise<FawryAdapter> {
  const settings = await loadSettings(db, environment, "FAWRY");
  if (!settings?.merchant_id) throw new ApiError(422, "PAYMENT_PROVIDER_NOT_CONFIGURED", "أكمل Merchant Code ومفتاح Secure Hash لفوري أولاً");
  const stored = settings.encrypted_credentials.secureHashKey;
  if (!stored) throw new ApiError(422, "PAYMENT_PROVIDER_NOT_CONFIGURED", "أكمل مفتاح Secure Hash لفوري أولاً");
  try {
    const credentials: FawryCredentials = { merchantCode: settings.merchant_id, secureHashKey: decryptPaymentSecret(stored, config.NABTA_PAYMENT_ENCRYPTION_KEY) };
    return new FawryAdapter(environment, credentials);
  } catch { throw new ApiError(422, "PAYMENT_CREDENTIALS_UNAVAILABLE", "تعذر فتح بيانات فوري المشفرة؛ تحقق من مفتاح تشفير الخادم"); }
}
function verifyWebhookSignature(data: Record<string, unknown> | undefined, signature: string, paymentApiKey: string): boolean { const keys = Array.isArray(data?.signatureKeys) ? data!.signatureKeys.filter((key): key is string => typeof key === "string").sort() : []; if (!keys.length || !data) return false; const payload = keys.map((key) => `${key}=${encodeURIComponent(String(data[key] ?? ""))}`).join("&"); const expected = createHmac("sha256", paymentApiKey).update(payload, "utf8").digest(); const received = Buffer.from(signature, "hex"); return received.length === expected.length && timingSafeEqual(received, expected); }
function providerStatus(payload: Record<string, unknown>): IntentStatus { const status = String(payload.orderStatus ?? payload.paymentStatus ?? payload.status ?? (payload.response as Record<string, unknown> | undefined)?.status ?? "PENDING").toUpperCase(); if (["SUCCESS", "PAID", "SUCCEEDED"].includes(status)) return "SUCCEEDED"; if (["FAILURE", "FAILED"].includes(status)) return "FAILED"; if (["CANCELLED", "CANCELED"].includes(status)) return "CANCELLED"; if (status === "EXPIRED") return "EXPIRED"; return "PENDING_CONFIRMATION"; }
async function activeEnvironment(db: Database, provider: Provider = "FAWRY"): Promise<Environment> {
  const result = await db.query<{ active_environment: Environment }>("SELECT active_environment FROM payment_provider_runtime WHERE provider = $1", [provider]);
  return result.rows[0]?.active_environment ?? "TEST";
}
function allowedMethods(method: ElectronicMethod): string[] { if (method === "MOBILE_WALLET") return ["wallet"]; if (method === "BANK_INSTALLMENTS") return ["installment"]; if (method === "BNPL") return ["bnpl"]; return ["card"]; }
function stringField(payload: Record<string, unknown>, name: string): string | undefined { const value = payload[name]; return typeof value === "string" && value ? value : undefined; }
function safeError(error: unknown): string { return error instanceof KashierProtocolError ? error.messageAr : error instanceof Error ? error.message.slice(0, 300) : "Payment operation failed"; }
async function paymentAudit(client: DbClient, intentId: string, actorUserId: string | null, action: string, metadata: Record<string, unknown>): Promise<void> { await client.query("INSERT INTO payment_audit_log(payment_intent_id, actor_user_id, action, metadata) VALUES ($1, $2, $3, $4::jsonb)", [intentId, actorUserId, action, JSON.stringify(metadata)]); }
function publicIntent(row: IntentRow) { return { intentId: row.id, quoteId: row.quote_id, method: row.method, status: row.status, amountMinor: row.amount_minor, merchantOrderId: row.merchant_order_id, providerSessionId: row.provider_session_id, transactionId: row.provider_transaction_id, checkoutUrl: row.checkout_url, deviceSerialNo: row.device_serial_no, expiresAt: row.expires_at.toISOString(), saleId: row.sale_id }; }
