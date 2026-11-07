import { describe, expect, it } from "vitest";
import ExcelJS, { type Workbook } from "exceljs";
import { createComprehensiveReportWorkbook, createInventoryPeriodicWorkbook, createInventoryWorkbook, createProductsWorkbook, createProductSyncWorkbook, createShiftsWorkbook, productSyncWorkbookToCsv } from "./workbooks.js";

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

  it("creates an editable product workbook with validated lists and converts it to import CSV", async () => {
    const bytes = await createProductSyncWorkbook({
      storeName: "نبتة", generatedAt: "2026-10-21T00:00:00.000Z", mode: "INTERNAL",
      items: [{ nameAr: "أرز", category: "بقالة", barcode: "6220000000001", unitKind: "PIECE", availableQtyMilli: 27_000, wholesalePriceMinor: 1_500, priceMinor: 2_500, purchasePackSize: 12, cartonPriceMinor: 40_000, cartonContentsUnit: "BAG", barcodeMappings: [{ barcode: "6220000000001", saleUnit: "UNIT" }, { barcode: "6220000000018", saleUnit: "CARTON" }] }],
    });
    const workbook = await openWorkbook(bytes);
    const sheet = workbook.getWorksheet("تعديل الأصناف");
    expect(sheet?.getCell("A4").value).toBe("اسم الصنف");
    expect(sheet?.getCell("C5").value).toBe("كرتونة");
    expect(sheet?.getCell("F5").value).toBe("6220000000018");
    expect(sheet?.getCell("G5").value).toBe(27);
    expect(sheet?.getCell("H5").value).toBe(2);
    expect(sheet?.getCell("I5").value).toBe(3);
    expect(sheet?.getCell("J5").value).toBe(12);
    expect(Object.keys(sheet?.dataValidations.model ?? {}).length).toBeGreaterThan(0);
    expect(sheet).toBeDefined();
    const editable = sheet!;
    editable.getCell("A6").value = "عدس جديد";
    editable.getCell("B6").value = "بقالة";
    editable.getCell("C6").value = "كرتونة";
    editable.getCell("D6").value = "6220000000002";
    editable.getCell("F6").value = "6220000000019";
    editable.getCell("G6").value = 27;
    editable.getCell("H6").value = 2;
    editable.getCell("I6").value = 3;
    editable.getCell("J6").value = 12;
    editable.getCell("L6").value = "كيس";
    editable.getCell("M6").value = 14.5;
    editable.getCell("O6").value = 180;
    editable.getCell("P6").value = 9.25;
    editable.getCell("R6").value = 4;
    editable.getCell("S6").value = "صنف كرتونة جديد";
    const edited = Buffer.from(await workbook.xlsx.writeBuffer());
    const csv = await productSyncWorkbookToCsv(edited);
    expect(csv).toContain("أرز,بقالة,PIECE,2500,6220000000001,0,27000,1500,1500,27000,KILOGRAM,,12,40000,BAG,,,,PACKAGE,,6220000000018,2026-10-21T00:00:00.000Z,0");
    expect(csv).toContain("عدس جديد,بقالة,PIECE,1450,6220000000002,4000,27000,925,925,27000,KILOGRAM,صنف كرتونة جديد,12,18000,BAG,,,,PACKAGE,,6220000000019,,");
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

  it("creates a periodic inventory audit with sales, shortages, and an Arabic summary", async () => {
    const bytes = await createInventoryPeriodicWorkbook({
      storeName: "الشيماء",
      generatedAt: "2026-10-16T00:00:00.000Z",
      period: "MONTHLY",
      periodLabel: "جرد شهري",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      totals: {
        soldProductCount: 1, grossQtyMilli: 2000, returnedQtyMilli: 0, netQtyMilli: 2000,
        grossSalesMinor: 5000, returnsMinor: 0, netSalesMinor: 5000,
        outOfStockCount: 1, belowReorderCount: 0,
      },
      salesItems: [{
        nameAr: "أرز", category: "بقالة", barcode: "6220000000001", unitKind: "PIECE",
        grossQtyMilli: 2000, returnedQtyMilli: 0, netQtyMilli: 2000,
        grossSalesMinor: 5000, returnsMinor: 0, netSalesMinor: 5000,
        averageUnitPriceMinor: 2500, availableQtyMilli: 0, reorderLevelMilli: 3000,
      }],
      reorderItems: [{
        nameAr: "أرز", category: "بقالة", barcode: "6220000000001", unitKind: "PIECE",
        availableQtyMilli: 0, reorderLevelMilli: 3000, shortageQtyMilli: 3000,
        priceMinor: 2500, status: "OUT_OF_STOCK",
      }],
    });
    const workbook = await openWorkbook(bytes);
    expect(workbook.getWorksheet("ملخص الجرد")?.getCell("A4").value).toBe("البند");
    expect(workbook.getWorksheet("الأصناف المباعة")?.getCell("A5").value).toBe("أرز");
    expect(workbook.getWorksheet("الأصناف المباعة")?.getCell("E5").value).toBe(2);
    expect(workbook.getWorksheet("نواقص وإعادة الطلب")?.getCell("G5").value).toBe(3);
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

  it("creates a comprehensive report with analytical sheets and numeric totals", async () => {
    const bytes = await createComprehensiveReportWorkbook({
      storeName: "نبتة", generatedAt: "2026-10-18T00:00:00.000Z", period: { from: "2026-10-01", to: "2026-10-31", timezone: "Africa/Cairo" },
      summary: { grossSalesMinor: 12_000, discountsMinor: 500, returnsMinor: 1_000, netSalesMinor: 10_500, netCogsMinor: 6_000, grossProfitMinor: 4_500, estimatedNetProfitMinor: 3_800, expensesMinor: 500, payrollMinor: 0, operatingExpensesMinor: 500, shopConsumptionMinor: 0, damagedLossMinor: 200, invoiceCount: 7 },
      dailySales: [{ date: "2026-10-01", netSalesMinor: 10_500, grossProfitMinor: 4_500, invoiceCount: 7 }],
      paymentMethods: [{ method: "CASH", amountMinor: 10_500, transactionCount: 7 }],
      topProducts: [{ nameAr: "أرز", category: "بقالة", netQtyMilli: 2_000, netSalesMinor: 10_500, grossProfitMinor: 4_500 }],
      categories: [{ category: "بقالة", netSalesMinor: 10_500, grossProfitMinor: 4_500 }],
      expenseCategories: [], shopConsumptions: [], payroll: [],
      inventory: { inventoryValueMinor: 20_000, lowStockCount: 2, outOfStockCount: 1, activeProductCount: 15 }, insights: ["متوسط الفاتورة: 1500 قرش."],
    });
    const workbook = await openWorkbook(bytes);
    expect(workbook.getWorksheet("لوحة التقرير")?.getCell("A4").value).toBe("المؤشر");
    expect(workbook.getWorksheet("لوحة التقرير")?.getCell("B5").value).toBe(120);
    expect(workbook.getWorksheet("اتجاه المبيعات")?.getCell("A5").value).toBe("2026-10-01");
    expect(workbook.getWorksheet("وسائل الدفع")?.getCell("A5").value).toBe("CASH");
    expect(workbook.getWorksheet("أفضل الأصناف")?.getCell("A5").value).toBe("أرز");
  });
});
