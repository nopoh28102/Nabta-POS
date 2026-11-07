import { describe, expect, it } from "vitest";
import { KashierAdapter, KashierProtocolError, egpDecimal } from "../apps/server/src/payments/kashier.js";

const credentials = { merchantId: "merchant-test", secretKey: "secret-test", apiKey: "api-test", paymentApiKey: "payment-api-test" };

describe("Kashier adapter", () => {
  it("uses exact piastre amounts and the documented POS message shape", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const adapter = new KashierAdapter("TEST", credentials, { fetch: async (url, init) => {
      receivedUrl = url;
      receivedInit = init;
      return new Response("{}", { status: 200 });
    } });
    await adapter.startPosSale({ serialNo: "SN / 1", amountMinor: 12345, merchantOrderId: "NABTA-order", printReceipt: true, webhookUrl: "https://relay.example/kashier/TEST" });
    expect(receivedUrl).toBe("https://test-api.kashier.io/v3/payment/pos/messages/SN%20%2F%201");
    expect(receivedInit?.headers).toMatchObject({ Authorization: "secret-test" });
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({ event: "sale", data: { message: { amount: "123.45", currency: "EGP", merchantOrderId: "NABTA-order", transactionType: "sale", printReceipt: true, metaData: {}, reconciliation: { webhookUrl: "https://relay.example/kashier/TEST" } } } });
  });

  it("requires a usable checkout URL from a payment session", async () => {
    const adapter = new KashierAdapter("TEST", credentials, { fetch: async () => new Response(JSON.stringify({ id: "s_1" }), { status: 201 }) });
    await expect(adapter.createPaymentSession({ amountMinor: 100, merchantOrderId: "NABTA-order", expiresAt: "2026-10-18T12:00:00.000Z", allowedMethods: ["card"], redirectUrl: "https://merchant.example/return" })).rejects.toMatchObject({ code: "KASHIER_SESSION_URL_MISSING" } satisfies Partial<KashierProtocolError>);
  });

  it("formats EGP without binary floating point", () => {
    expect(egpDecimal(0)).toBe("0.00");
    expect(egpDecimal(1)).toBe("0.01");
    expect(egpDecimal(199)).toBe("1.99");
    expect(() => egpDecimal(-1)).toThrow("Invalid minor amount");
  });
});
