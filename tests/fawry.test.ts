import { describe, expect, it } from "vitest";
import { FawryAdapter, egpDecimal } from "../apps/server/src/payments/fawry.js";

const credentials = { merchantCode: "merchant-code", secureHashKey: "secure-hash" };

describe("Fawry adapter", () => {
  it("creates a signed PayAtFawry reference request using exact piastres", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const adapter = new FawryAdapter("TEST", credentials, { fetch: async (url, init) => {
      receivedUrl = url;
      receivedInit = init;
      return new Response(JSON.stringify({ type: "ChargeResponse", fawryRefNumber: "9990076204" }), { status: 200 });
    } });
    await adapter.createReference({ merchantRefNumber: "1234567890123", amountMinor: 12345, customerMobile: "01234567890", customerEmail: "customer@example.com", expiresAt: new Date("2026-10-25T12:00:00.000Z"), webhookUrl: "https://merchant.example/fawry", description: "Nabta POS sale" });
    expect(receivedUrl).toBe("https://atfawry.fawrystaging.com/ECommerceWeb/Fawry/payments/charge");
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({ merchantCode: "merchant-code", merchantRefNum: "1234567890123", customerProfileId: "1234567890123", amount: "123.45", paymentMethod: "PayAtFawry", orderWebHookUrl: "https://merchant.example/fawry" });
  });

  it("uses the documented status endpoint and server-side signature", async () => {
    let receivedUrl = "";
    const adapter = new FawryAdapter("LIVE", credentials, { fetch: async (url) => {
      receivedUrl = url;
      return new Response(JSON.stringify({ orderStatus: "PAID" }), { status: 200 });
    } });
    await adapter.getPaymentStatus("1234567890123");
    expect(receivedUrl).toMatch(/^https:\/\/atfawry\.com\/ECommerceWeb\/Fawry\/payments\/status\/v2\?/);
    expect(receivedUrl).toContain("merchantCode=merchant-code");
    expect(receivedUrl).toContain("merchantRefNumber=1234567890123");
  });

  it("formats EGP without binary floating point", () => {
    expect(egpDecimal(1)).toBe("0.01");
    expect(egpDecimal(12345)).toBe("123.45");
  });
});
