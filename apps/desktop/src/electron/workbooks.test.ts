import { describe, expect, it } from "vitest";
import ExcelJS, { type Workbook } from "exceljs";
import { createInventoryWorkbook, createProductsWorkbook, createShiftsWorkbook } from "./workbooks.js";

const { Workbook: WorkbookConstructor } = ExcelJS;

async function openWorkbook(bytes: Uint8Array): Promise<Workbook> {
  const workbook = new WorkbookConstructor();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer as ArrayBuffer);
  return workbook;
}

describe("Excel exports", () => {
  it("creates an Excel product-price file that can be opened without repair", async () => {
    const bytes = await createProductsWorkbook({
      storeName: "نبتة",
      generatedAt: "2026-10-13T00:00:00.000Z",
      mode: "INTERNAL",
      items: [{ nameAr: "أرز", category: "بقالة", barcode: "123456", unitKind: "WEIGHT", availableQtyMilli: 1250, wholesalePriceMinor: 2500, priceMinor: 3000 }],
    });
    const workbook = await openWorkbook(bytes);
    const sheet = workbook.getWorksheet("أسعار الجملة");
    expect(sheet).toBeDefined();
    expect(sheet?.getCell("A4").value).toBe("الصنف");
    expect(sheet?.getCell("A5").value).toBe("أرز");
    expect(sheet?.getCell("E5").value).toBe(1.25);
    expect(sheet?.getCell("F5").value).toBe(25);
    expect(sheet?.getCell("G5").value).toBe(30);
  });

  it("creates an Excel inventory file that can be opened without repair", async () => {
    const bytes = await createInventoryWorkbook({
      storeName: "نبتة",
      generatedAt: "2026-10-13T00:00:00.000Z",
      items: [{ nameAr: "سكر", category: "بقالة", barcode: "654321", unitKind: "PIECE", availableQtyMilli: 2000, priceMinor: 1500, createdAt: "2026-10-12T00:00:00.000Z" }],
    });
    const workbook = await openWorkbook(bytes);
    const sheet = workbook.getWorksheet("المخزون الحالي");
    expect(sheet).toBeDefined();
    expect(sheet?.getCell("A4").value).toBe("الصنف");
    expect(sheet?.getCell("D5").value).toBe(2);
    expect(sheet?.getCell("F5").value).toBe(15);
  });

  it("creates an Excel monthly shift register with cashier and close details", async () => {
    const bytes = await createShiftsWorkbook({
      storeName: "الشيماء",
      month: "2026-10",
      generatedAt: "2026-10-13T00:00:00.000Z",
      items: [{
        id: "00000000-0000-4000-8000-000000000001",
        cashierName: "أحمد",
        terminalName: "كاشير 1",
        status: "CLOSED",
        openedAt: "2026-10-13T08:00:00.000Z",
        closedAt: "2026-10-13T16:00:00.000Z",
        openingMinor: 10_000,
        expectedCashMinor: 25_000,
        actualCashMinor: 24_500,
        differenceMinor: -500,
        invoiceCount: 12,
        salesTotalMinor: 65_000,
        closeNote: "فرق بسيط",
      }],
    });
    const workbook = await openWorkbook(bytes);
    const sheet = workbook.getWorksheet("سجل الورديات");
    expect(sheet?.getCell("A4").value).toBe("الكاشير");
    expect(sheet?.getCell("A5").value).toBe("أحمد");
    expect(sheet?.getCell("F5").value).toBe(100);
    expect(sheet?.getCell("I5").value).toBe(-5);
    expect(sheet?.getCell("J5").value).toBe(12);
  });
});
