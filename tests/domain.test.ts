import { describe, expect, it } from "vitest";
import {
  allocateInvoiceDiscount,
  allocateProportionally,
  allocateReturnValue,
  calculateInventoryIssueValue,
  calculateLineMinor,
  extractTokenVariants,
  matchesArabicGuessing,
  normalizeArabicSearch,
  roundHalfUp,
} from "@nabta/domain";

describe("money and quantity rules", () => {
  it("rounds half up exactly without floating point", () => {
    expect(roundHalfUp(1n, 2n)).toBe(1n);
    expect(roundHalfUp(4n, 3n)).toBe(1n);
    expect(roundHalfUp(5n, 3n)).toBe(2n);
    expect(roundHalfUp(-1n, 2n)).toBe(-1n);
  });

  it("prices weighted goods at integer milli-units", () => {
    expect(calculateLineMinor(16_000n, 375n)).toBe(6_000n);
    expect(calculateLineMinor(333n, 1n)).toBe(0n);
    expect(calculateLineMinor(500n, 1n)).toBe(1n);
  });

  it("distributes invoice discount deterministically", () => {
    const lines = [
      { lineId: "b", unitPriceMinor: 100n, qtyMilli: 1_000n },
      { lineId: "a", unitPriceMinor: 100n, qtyMilli: 1_000n },
      { lineId: "c", unitPriceMinor: 100n, qtyMilli: 1_000n },
    ];
    const result = allocateInvoiceDiscount(lines, 2n);
    expect(result.map((line) => [line.lineId, line.discountMinor])).toEqual([["b", 1n], ["a", 1n], ["c", 0n]]);
    expect(result.reduce((sum, line) => sum + line.discountMinor, 0n)).toBe(2n);
    expect(result.reduce((sum, line) => sum + line.netMinor, 0n)).toBe(298n);
  });

  it("rejects discounts above the invoice", () => {
    expect(() => allocateInvoiceDiscount([{ lineId: "1", unitPriceMinor: 100n, qtyMilli: 1_000n }], 101n)).toThrow();
  });
});

describe("partial return allocation", () => {
  it("makes repeated partial returns add exactly to the original line", () => {
    const first = allocateReturnValue({ originalValueMinor: 100n, soldQtyMilli: 3_000n, previouslyReturnedQtyMilli: 0n, previouslyRefundedMinor: 0n, returnQtyMilli: 1_000n });
    const second = allocateReturnValue({ originalValueMinor: 100n, soldQtyMilli: 3_000n, previouslyReturnedQtyMilli: 1_000n, previouslyRefundedMinor: first, returnQtyMilli: 1_000n });
    const last = allocateReturnValue({ originalValueMinor: 100n, soldQtyMilli: 3_000n, previouslyReturnedQtyMilli: 2_000n, previouslyRefundedMinor: first + second, returnQtyMilli: 1_000n });
    expect([first, second, last]).toEqual([33n, 34n, 33n]);
    expect(first + second + last).toBe(100n);
  });

  it("rejects a return above remaining quantity", () => {
    expect(() => allocateReturnValue({ originalValueMinor: 100n, soldQtyMilli: 1_000n, previouslyReturnedQtyMilli: 500n, previouslyRefundedMinor: 50n, returnQtyMilli: 501n })).toThrow();
  });
});

describe("stock valuation", () => {
  it("uses moving weighted value and clears final residual", () => {
    expect(calculateInventoryIssueValue(1_000n, 3_000n, 1_000n)).toBe(333n);
    expect(calculateInventoryIssueValue(667n, 2_000n, 2_000n)).toBe(667n);
  });

  it("allocates landed expense to the exact original amount", () => {
    const result = allocateProportionally(5n, [{ id: "a", weight: 10n }, { id: "b", weight: 20n }]);
    expect(result.get("a")).toBe(2n);
    expect(result.get("b")).toBe(3n);
    expect([...result.values()].reduce((sum, value) => sum + value, 0n)).toBe(5n);
  });
});

describe("Arabic search", () => {
  it("normalizes common Arabic spelling variants but not barcodes", () => {
    expect(normalizeArabicSearch("  أَرُزّ  مصري  ")).toBe("ارز مصري");
    expect(normalizeArabicSearch("جبنة بيضاء")).toBe(normalizeArabicSearch("جبنه بيضاء"));
    expect(normalizeArabicSearch("06221000000011")).toBe("06221000000011");
  });

  it("extracts Arabic token variants without prefixes", () => {
    expect(extractTokenVariants("الجبنة")).toContain("الجبنة");
    expect(extractTokenVariants("الجبنة")).toContain("جبنة");
    expect(extractTokenVariants("بالشوكولاتة")).toContain("شوكولاتة");
  });

  it("matches products by middle word, last word, or out-of-order guessing", () => {
    const product = "شيبسي بطاطس عائلي بالجبنة المتبلة 50 جم";
    expect(matchesArabicGuessing(product, "متبلة")).toBe(true);
    expect(matchesArabicGuessing(product, "جبنة")).toBe(true);
    expect(matchesArabicGuessing(product, "جبنة متبلة")).toBe(true);
    expect(matchesArabicGuessing(product, "متبلة شيبسي")).toBe(true);
    expect(matchesArabicGuessing(product, "50 عائلي")).toBe(true);
    expect(matchesArabicGuessing(product, "طماطم")).toBe(false);
  });
});
