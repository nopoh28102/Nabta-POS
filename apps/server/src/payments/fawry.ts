import { createHash } from "node:crypto";

export type FawryEnvironment = "TEST" | "LIVE";

export interface FawryCredentials {
  merchantCode: string;
  secureHashKey: string;
}

export interface FawryHttp {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface FawryReferenceRequest {
  merchantRefNumber: string;
  amountMinor: number;
  customerName?: string;
  customerMobile: string;
  customerEmail: string;
  expiresAt: Date;
  webhookUrl?: string;
  description: string;
}

export class FawryAdapter {
  readonly baseUrl: string;
  constructor(environment: FawryEnvironment, private readonly credentials: FawryCredentials, private readonly http: FawryHttp = { fetch }) {
    this.baseUrl = environment === "TEST" ? "https://atfawry.fawrystaging.com" : "https://atfawry.com";
  }

  async createReference(input: FawryReferenceRequest): Promise<Record<string, unknown>> {
    const amount = egpDecimal(input.amountMinor);
    const profileId = input.merchantRefNumber;
    const signature = sha256(`${this.credentials.merchantCode}${input.merchantRefNumber}${profileId}PayAtFawry${amount}${this.credentials.secureHashKey}`);
    return this.request("/ECommerceWeb/Fawry/payments/charge", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        merchantCode: this.credentials.merchantCode,
        merchantRefNum: input.merchantRefNumber,
        customerProfileId: profileId,
        customerName: input.customerName ?? "عميل نبته",
        customerMobile: input.customerMobile,
        customerEmail: input.customerEmail,
        amount,
        paymentExpiry: input.expiresAt.getTime(),
        currencyCode: "EGP",
        language: "ar-eg",
        chargeItems: [{ itemId: input.merchantRefNumber, description: input.description.slice(0, 250), price: amount, quantity: 1 }],
        signature,
        paymentMethod: "PayAtFawry",
        description: input.description.slice(0, 250),
        ...(input.webhookUrl ? { orderWebHookUrl: input.webhookUrl } : {}),
      }),
    });
  }

  async getPaymentStatus(merchantRefNumber: string): Promise<Record<string, unknown>> {
    const signature = sha256(`${this.credentials.merchantCode}${merchantRefNumber}${this.credentials.secureHashKey}`);
    const query = new URLSearchParams({ merchantCode: this.credentials.merchantCode, merchantRefNumber, signature });
    return this.request(`/ECommerceWeb/Fawry/payments/status/v2?${query.toString()}`, { method: "GET", headers: { accept: "application/json" } });
  }

  verifyMessageSignature(payload: Record<string, unknown>): boolean {
    const signature = stringValue(payload.messageSignature);
    if (!signature) return false;
    const expected = sha256(`${stringValue(payload.fawryRefNumber) ?? ""}${stringValue(payload.merchantRefNum) ?? stringValue(payload.merchantRefNumber) ?? ""}${decimal(payload.paymentAmount)}${decimal(payload.orderAmount)}${stringValue(payload.orderStatus) ?? ""}${stringValue(payload.paymentMethod) ?? ""}${stringValue(payload.paymentRefrenceNumber) ?? ""}${this.credentials.secureHashKey}`);
    return signature.toLowerCase() === expected;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.http.fetch(`${this.baseUrl}${path}`, init); }
    catch (cause) { throw new FawryProtocolError("FAWRY_NETWORK", "تعذر الاتصال بخدمة فوري", cause); }
    const text = await response.text();
    let raw: Record<string, unknown> = {};
    try { raw = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { raw = { responseText: text.slice(0, 500) }; }
    if (!response.ok) throw new FawryProtocolError("FAWRY_REJECTED", "رفضت فوري طلب الدفع أو التحقق", undefined, response.status, raw);
    return raw;
  }
}

export class FawryProtocolError extends Error {
  constructor(public readonly code: string, public readonly messageAr: string, public readonly originalCause?: unknown, public readonly status?: number, public readonly metadata?: Record<string, unknown>) { super(code); }
}

export function egpDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid minor amount");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined; }
function decimal(value: unknown): string { const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0; return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00"; }
