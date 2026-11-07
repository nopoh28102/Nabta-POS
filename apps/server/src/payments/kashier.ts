export type KashierEnvironment = "TEST" | "LIVE";

export interface KashierCredentials {
  merchantId: string;
  secretKey: string;
  apiKey: string;
  paymentApiKey: string;
}

export interface KashierHttp {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface KashierPosSaleRequest {
  serialNo: string;
  amountMinor: number;
  merchantOrderId: string;
  printReceipt: boolean;
  webhookUrl?: string;
}

export interface KashierSessionRequest {
  amountMinor: number;
  merchantOrderId: string;
  expiresAt: string;
  allowedMethods: string[];
  webhookUrl?: string;
  redirectUrl: string;
}

export interface KashierStartResult {
  providerSessionId?: string;
  checkoutUrl?: string;
  raw: Record<string, unknown>;
}

export class KashierAdapter {
  readonly baseUrl: string;
  constructor(private readonly environment: KashierEnvironment, private readonly credentials: KashierCredentials, private readonly http: KashierHttp = { fetch }) {
    this.baseUrl = environment === "TEST" ? "https://test-api.kashier.io" : "https://api.kashier.io";
  }

  async startPosSale(input: KashierPosSaleRequest): Promise<KashierStartResult> {
    const body = {
      event: "sale",
      data: { message: {
        amount: egpDecimal(input.amountMinor), currency: "EGP", merchantOrderId: input.merchantOrderId,
        transactionType: "sale", printReceipt: input.printReceipt, metaData: {},
        ...(input.webhookUrl ? { reconciliation: { webhookUrl: input.webhookUrl } } : {}),
      } },
    };
    const raw = await this.request(`/v3/payment/pos/messages/${encodeURIComponent(input.serialNo)}`, {
      method: "POST", headers: this.secretHeaders(), body: JSON.stringify(body),
    });
    return { raw };
  }

  async createPaymentSession(input: KashierSessionRequest): Promise<KashierStartResult> {
    const body = {
      expireAt: input.expiresAt, maxFailureAttempts: 3, paymentType: "credit", amount: egpDecimal(input.amountMinor),
      currency: "EGP", order: input.merchantOrderId, merchantRedirect: input.redirectUrl, display: "ar", type: "one-time",
      allowedMethods: input.allowedMethods.join(","), merchantId: this.credentials.merchantId, failureRedirect: false,
      description: `Nabta POS ${input.merchantOrderId}`, interactionSource: "ECOMMERCE", enable3DS: true,
      ...(input.webhookUrl ? { serverWebhook: input.webhookUrl } : {}),
    };
    const raw = await this.request("/v3/payment/sessions", { method: "POST", headers: { ...this.secretHeaders(), "api-key": this.credentials.apiKey }, body: JSON.stringify(body) });
    const sessionUrl = firstString(raw, ["sessionUrl", "body.sessionUrl", "data.sessionUrl"]);
    const sessionId = firstString(raw, ["sessionId", "id", "body.id", "data.id"]);
    if (!sessionUrl) throw new KashierProtocolError("KASHIER_SESSION_URL_MISSING", "لم تُرجع Kashier رابط جلسة الدفع");
    return { ...(sessionId ? { providerSessionId: sessionId } : {}), checkoutUrl: sessionUrl, raw };
  }

  async getPaymentSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(`/v3/payment/sessions/${encodeURIComponent(sessionId)}/payment`, { method: "GET", headers: this.secretHeaders() });
  }

  async getMerchantPaymentMethods(): Promise<Record<string, unknown>> {
    return this.request(`/v2/merchants/${encodeURIComponent(this.credentials.merchantId)}/paymentMethods`, { method: "GET", headers: this.secretHeaders() });
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    return this.request(`/v2/aggregator/transactions/${encodeURIComponent(transactionId)}`, { method: "GET", headers: this.secretHeaders() });
  }

  async refundOrder(orderId: string, amountMinor: number, transactionId?: string): Promise<Record<string, unknown>> {
    const host = this.environment === "TEST" ? "https://test-fep.kashier.io" : "https://fep.kashier.io";
    const body = { apiOperation: "REFUND", transaction: { amount: Number(egpDecimal(amountMinor)), ...(transactionId ? { targetTransactionId: transactionId } : {}) } };
    let response: Response;
    try { response = await this.http.fetch(`${host}/v3/orders/${encodeURIComponent(orderId)}`, { method: "PUT", headers: this.secretHeaders(), body: JSON.stringify(body) }); }
    catch (cause) { throw new KashierProtocolError("KASHIER_NETWORK", "تعذر الاتصال بخدمة Kashier", cause); }
    const text = await response.text();
    let raw: Record<string, unknown> = {};
    try { raw = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { raw = { responseText: text.slice(0, 500) }; }
    if (!response.ok) throw new KashierProtocolError("KASHIER_REJECTED", "رفضت Kashier طلب الاسترجاع", undefined, response.status, raw);
    return raw;
  }

  private secretHeaders(): Record<string, string> { return { Authorization: this.credentials.secretKey, "content-type": "application/json", accept: "application/json" }; }
  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.http.fetch(`${this.baseUrl}${path}`, init); }
    catch (cause) { throw new KashierProtocolError("KASHIER_NETWORK", "تعذر الاتصال بخدمة Kashier", cause); }
    const rawText = await response.text();
    let raw: Record<string, unknown> = {};
    try { raw = rawText ? JSON.parse(rawText) as Record<string, unknown> : {}; } catch { raw = { responseText: rawText.slice(0, 500) }; }
    if (!response.ok) throw new KashierProtocolError("KASHIER_REJECTED", "رفضت Kashier طلب الدفع أو لم تسمح به", undefined, response.status, raw);
    return raw;
  }
}

export class KashierProtocolError extends Error {
  constructor(public readonly code: string, public readonly messageAr: string, public readonly originalCause?: unknown, public readonly status?: number, public readonly metadata?: Record<string, unknown>) { super(code); }
}

export function egpDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid minor amount");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

function firstString(source: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let current: unknown = source;
    for (const key of path.split(".")) current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined;
    if (typeof current === "string" && current) return current;
  }
  return undefined;
}
