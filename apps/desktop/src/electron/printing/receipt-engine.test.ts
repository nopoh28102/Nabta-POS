import { describe, expect, it } from "vitest";
import {
  escapeReceiptHtml,
  formatQtyForReceipt,
  formatReceiptMoney,
  receiptHtml,
  resolveReceiptDimensions,
} from "./receipt-engine.js";

describe("Receipt Engine — Thermal Receipt Geometry and Layout", () => {
  const sampleRequest = {
    storeName: "نبتة — اختبار الطابعة",
    sale: {
      saleId: "00000000-0000-4000-8000-000000000001",
      invoiceNo: "TEST-RECEIPT",
      postedAt: "2026-10-17T14:20:00.000Z",
      subtotalMinor: 1250,
      discountMinor: 0,
      totalMinor: 1250,
      paidMinor: 1250,
      changeMinor: 0,
      lines: [
        {
          productId: "00000000-0000-4000-8000-000000000002",
          nameAr: "إيصال اختبار",
          unitKind: "PIECE" as const,
          qtyMilli: 1000,
          unitPriceMinor: 1250,
          grossMinor: 1250,
          discountMinor: 0,
          netMinor: 1250,
          stockVersion: 0,
        },
      ],
    },
  };

  it("resolves physical printable width to 72 mm for 80 mm thermal printers", () => {
    const dims = resolveReceiptDimensions("80");
    expect(dims.paperWidth).toBe("80");
    expect(dims.printableWidthMm).toBe(72);
    expect(dims.sidePaddingMm).toBe(3.5);
  });

  it("resolves physical printable width to 48 mm for 58 mm thermal printers", () => {
    const dims = resolveReceiptDimensions("58");
    expect(dims.paperWidth).toBe("58");
    expect(dims.printableWidthMm).toBe(48);
    expect(dims.sidePaddingMm).toBe(2.5);
  });

  it("formats Egyptian currency with symbol and comma decimal separator", () => {
    expect(formatReceiptMoney(1250)).toContain("١٢٫٥٠");
    expect(formatReceiptMoney(1250)).toContain("ج.م");
    expect(formatReceiptMoney(0)).toContain("٠٫٠٠");
    expect(formatReceiptMoney(-500)).toContain("−");
  });

  it("formats piece and weight quantities correctly", () => {
    expect(formatQtyForReceipt(1000, "PIECE")).toBe("1");
    expect(formatQtyForReceipt(2500, "PIECE")).toBe("2.5");
    expect(formatQtyForReceipt(1500, "WEIGHT")).toBe("1.500 كجم");
  });

  it("escapes dangerous HTML characters in receipt strings", () => {
    expect(escapeReceiptHtml('<script>alert("xss")</script> & "me"')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;me&quot;"
    );
  });

  it("generates 80 mm receipt HTML matching 72 mm driver page box with safe margins", () => {
    const html = receiptHtml(sampleRequest, "80");

    // Must NOT define @page as 80 mm (which causes 8 mm RTL left overflow and clipping)
    expect(html).not.toContain("@page { size: 80mm auto;");
    // Must declare exact 72 mm page box matching Windows driver DEVMODE PageMediaSize
    expect(html).toContain("@page { size: 72mm auto; margin: 0; }");
    // Body must match 72 mm
    expect(html).toContain("width: 72mm;");
    expect(html).toContain("max-width: 72mm;");
    // Container must use 100% of 72 mm with 3.5 mm safe side padding
    expect(html).toContain("padding: 2.5mm 3.5mm 3.5mm;");
    // Arabic RTL layout preserved
    expect(html).toContain('lang="ar" dir="rtl"');
    expect(html).toContain("نبتة — اختبار الطابعة");
    expect(html).toContain("TEST-RECEIPT");
    expect(html).toContain("إيصال اختبار");
    expect(html).toContain("إجمالي المطلوب");
    expect(html).toContain("المدفوع");
    expect(html).toContain("الباقي");
  });

  it("generates 58 mm receipt HTML matching 48 mm driver page box", () => {
    const html = receiptHtml(sampleRequest, "58");

    expect(html).not.toContain("@page { size: 58mm auto;");
    expect(html).toContain("@page { size: 48mm auto; margin: 0; }");
    expect(html).toContain("width: 48mm;");
    expect(html).toContain("padding: 2.5mm 2.5mm 3.5mm;");
  });
});
