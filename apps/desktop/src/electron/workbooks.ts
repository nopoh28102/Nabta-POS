// exceljs is published as CommonJS.  Electron starts the main process as ESM,
// so a named import works in some development test runners but fails once the
// app is packaged.  The default import is Node's supported CJS interop path.
import ExcelJS, { type Workbook } from "exceljs";
import type { InventoryExcelExportResponse, InventoryPeriodicExcelExportResponse, ProductExcelExportResponse, ShiftHistoryExcelExportResponse } from "@nabta/contracts";

const { Workbook: WorkbookConstructor } = ExcelJS;

const border = {
  top: { style: "thin" as const, color: { argb: "FFD3E2DC" } },
  left: { style: "thin" as const, color: { argb: "FFD3E2DC" } },
  bottom: { style: "thin" as const, color: { argb: "FFD3E2DC" } },
  right: { style: "thin" as const, color: { argb: "FFD3E2DC" } },
};

function columnLetter(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function exportedAt(value: string): string {
  return new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(value));
}

function baseWorkbook(): Workbook {
  const workbook = new WorkbookConstructor();
  workbook.creator = "Nabta POS";
  workbook.created = new Date();
  workbook.modified = new Date();
  return workbook;
}

function styleSheet(
  workbook: Workbook,
  sheetName: string,
  title: string,
  subtitle: string,
  headers: string[],
  widths: number[],
) {
  const sheet = workbook.addWorksheet(sheetName, { views: [{ rightToLeft: true, state: "frozen", xSplit: 0, ySplit: 4, activeCell: "A5" }] });
  sheet.properties.defaultRowHeight = 19;
  sheet.columns = widths.map((width) => ({ width }));
  const lastColumn = columnLetter(headers.length);
  sheet.mergeCells(`A1:${lastColumn}1`);
  sheet.mergeCells(`A2:${lastColumn}2`);
  sheet.getCell("A1").value = title;
  sheet.getCell("A2").value = subtitle;
  sheet.getRow(1).height = 30;
  sheet.getRow(2).height = 22;
  sheet.getRow(4).height = 24;
  sheet.getCell("A1").font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16785F" } };
  sheet.getCell("A1").alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF5F0" } };
  sheet.getCell("A2").alignment = { horizontal: "right", vertical: "middle" };
  headers.forEach((header, index) => {
    const cell = sheet.getCell(4, index + 1);
    cell.value = header;
    cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16785F" } };
    cell.border = border;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  return sheet;
}

function styleDataRow(sheet: ReturnType<Workbook["addWorksheet"]>, rowNumber: number, quantityColumns: number | number[], moneyColumns: number[]): void {
  const row = sheet.getRow(rowNumber);
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "Arial", size: 11 };
    cell.border = border;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  row.getCell(1).alignment = { horizontal: "right", vertical: "middle" };
  row.getCell(2).alignment = { horizontal: "right", vertical: "middle" };
  (Array.isArray(quantityColumns) ? quantityColumns : [quantityColumns]).forEach((column) => { row.getCell(column).numFmt = "0.###"; });
  moneyColumns.forEach((column) => { row.getCell(column).numFmt = '0.00 "ج.م"'; });
}

async function serialize(workbook: Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function createInventoryWorkbook(data: InventoryExcelExportResponse): Promise<Buffer> {
  const workbook = baseWorkbook();
  const sheet = styleSheet(
    workbook,
    "المخزون الحالي",
    `المخزون الحالي — ${data.storeName}`,
    `وقت التصدير: ${exportedAt(data.generatedAt)} | الأصناف المتاحة: ${data.items.length}`,
    ["الصنف", "التصنيف", "الباركود", "الكمية المتاحة", "الوحدة", "سعر البيع", "تاريخ الإضافة"],
    [31, 18, 20, 16, 12, 15, 17],
  );
  data.items.forEach((item, index) => {
    const rowNumber = index + 5;
    sheet.getRow(rowNumber).values = [
      item.nameAr,
      item.category,
      item.barcode ?? "—",
      item.availableQtyMilli / 1000,
      item.unitKind === "WEIGHT" ? "كجم" : "قطعة",
      item.priceMinor / 100,
      new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(new Date(item.createdAt)),
    ];
    styleDataRow(sheet, rowNumber, 4, [6]);
  });
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.items.length + 4, 4), column: 7 } };
  return serialize(workbook);
}

export async function createInventoryPeriodicWorkbook(data: InventoryPeriodicExcelExportResponse): Promise<Buffer> {
  const workbook = baseWorkbook();
  const summary = styleSheet(
    workbook,
    "ملخص الجرد",
    `${data.periodLabel} — ${data.storeName}`,
    `الفترة: ${data.periodStart} إلى ${data.periodEnd} | وقت التصدير: ${exportedAt(data.generatedAt)}`,
    ["البند", "القيمة"],
    [34, 28],
  );
  const summaryRows: Array<[string, string | number]> = [
    ["عدد الأصناف التي بها حركة بيع أو مرتجع", data.totals.soldProductCount],
    ["إجمالي المبيعات قبل المرتجعات", data.totals.grossSalesMinor / 100],
    ["قيمة المرتجعات خلال الفترة", data.totals.returnsMinor / 100],
    ["صافي المبيعات", data.totals.netSalesMinor / 100],
    ["أصناف نفدت وتحتاج شراء", data.totals.outOfStockCount],
    ["أصناف أقل من حد إعادة الطلب", data.totals.belowReorderCount],
  ];
  summaryRows.forEach(([label, value], index) => {
    const rowNumber = index + 5;
    summary.getRow(rowNumber).values = [label, value];
    styleDataRow(summary, rowNumber, [], [2, 3, 4].includes(index + 1) ? [2] : []);
  });
  summary.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(summaryRows.length + 4, 4), column: 2 } };

  const sales = styleSheet(
    workbook,
    "الأصناف المباعة",
    `تفصيل مبيعات الأصناف — ${data.storeName}`,
    `الفترة: ${data.periodStart} إلى ${data.periodEnd} | عدد الأصناف: ${data.salesItems.length}`,
    ["الصنف", "التصنيف", "الباركود", "الوحدة", "الكمية المباعة", "المرتجع", "صافي الكمية", "متوسط سعر البيع", "صافي المبيعات", "الرصيد الحالي", "حد إعادة الطلب"],
    [32, 18, 20, 11, 15, 13, 15, 17, 17, 15, 16],
  );
  data.salesItems.forEach((item, index) => {
    const rowNumber = index + 5;
    sales.getRow(rowNumber).values = [
      item.nameAr, item.category, item.barcode ?? "—", item.unitKind === "WEIGHT" ? "كجم" : "قطعة",
      item.grossQtyMilli / 1000, item.returnedQtyMilli / 1000, item.netQtyMilli / 1000,
      item.averageUnitPriceMinor === null ? "—" : item.averageUnitPriceMinor / 100,
      item.netSalesMinor / 100, item.availableQtyMilli / 1000, item.reorderLevelMilli / 1000,
    ];
    styleDataRow(sales, rowNumber, [5, 6, 7, 10, 11], [8, 9]);
  });
  sales.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.salesItems.length + 4, 4), column: 11 } };

  const reorder = styleSheet(
    workbook,
    "نواقص وإعادة الطلب",
    `قائمة النواقص والشراء المقترح — ${data.storeName}`,
    `الرصيد الحالي وقت التصدير | عدد الأصناف: ${data.reorderItems.length}`,
    ["الصنف", "التصنيف", "الباركود", "الوحدة", "المتاح", "حد إعادة الطلب", "الكمية المقترحة للشراء", "الحالة", "سعر البيع"],
    [32, 18, 20, 11, 14, 16, 22, 18, 15],
  );
  data.reorderItems.forEach((item, index) => {
    const rowNumber = index + 5;
    const status = item.status === "OUT_OF_STOCK" ? "نفد من المخزون" : item.status === "BELOW_REORDER" ? "أقل من حد الطلب" : "عند حد الطلب";
    reorder.getRow(rowNumber).values = [
      item.nameAr, item.category, item.barcode ?? "—", item.unitKind === "WEIGHT" ? "كجم" : "قطعة",
      item.availableQtyMilli / 1000, item.reorderLevelMilli / 1000, item.shortageQtyMilli / 1000, status, item.priceMinor / 100,
    ];
    styleDataRow(reorder, rowNumber, [5, 6, 7], [9]);
    const statusCell = reorder.getCell(rowNumber, 8);
    statusCell.font = { name: "Arial", size: 11, bold: true, color: { argb: item.status === "OUT_OF_STOCK" ? "FFB42318" : "FFB54708" } };
  });
  reorder.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.reorderItems.length + 4, 4), column: 9 } };
  return serialize(workbook);
}

export async function createProductsWorkbook(data: ProductExcelExportResponse): Promise<Buffer> {
  const workbook = baseWorkbook();
  const isInternal = data.mode === "INTERNAL";
  const headers = isInternal
    ? ["الصنف", "التصنيف", "الباركود", "الوحدة", "الكمية المتاحة", "سعر الجملة", "سعر البيع"]
    : ["الصنف", "التصنيف", "الباركود", "الوحدة", "الكمية المتاحة", "سعر البيع"];
  const sheet = styleSheet(
    workbook,
    isInternal ? "أسعار الجملة" : "أسعار البيع",
    `${isInternal ? "قائمة أسعار الجملة" : "قائمة أسعار البيع"} — ${data.storeName}`,
    `وقت التصدير: ${exportedAt(data.generatedAt)} | عدد الأصناف: ${data.items.length}`,
    headers,
    isInternal ? [31, 18, 20, 12, 16, 15, 15] : [31, 18, 20, 12, 16, 15],
  );
  data.items.forEach((item, index) => {
    const rowNumber = index + 5;
    sheet.getRow(rowNumber).values = isInternal
      ? [item.nameAr, item.category, item.barcode ?? "—", item.unitKind === "WEIGHT" ? "كجم" : "قطعة", item.availableQtyMilli / 1000, (item.wholesalePriceMinor ?? 0) / 100, item.priceMinor / 100]
      : [item.nameAr, item.category, item.barcode ?? "—", item.unitKind === "WEIGHT" ? "كجم" : "قطعة", item.availableQtyMilli / 1000, item.priceMinor / 100];
    styleDataRow(sheet, rowNumber, 5, isInternal ? [6, 7] : [6]);
  });
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.items.length + 4, 4), column: headers.length } };
  return serialize(workbook);
}

export async function createShiftsWorkbook(data: ShiftHistoryExcelExportResponse): Promise<Buffer> {
  const workbook = baseWorkbook();
  const sheet = styleSheet(
    workbook,
    "سجل الورديات",
    `سجل الورديات — ${data.storeName}`,
    `الشهر: ${data.month} | وقت التصدير: ${exportedAt(data.generatedAt)} | عدد الورديات: ${data.items.length}`,
    ["الكاشير", "نقطة البيع", "الحالة", "وقت الفتح", "وقت الإغلاق", "الرصيد الافتتاحي", "النقد المتوقع", "النقد الفعلي", "الفرق", "الفواتير", "إجمالي المبيعات", "ملاحظة الإغلاق"],
    [20, 18, 12, 21, 21, 16, 16, 16, 14, 12, 17, 30],
  );
  data.items.forEach((item, index) => {
    const rowNumber = index + 5;
    sheet.getRow(rowNumber).values = [
      item.cashierName,
      item.terminalName,
      item.status === "OPEN" ? "مفتوحة" : "مغلقة",
      exportedAt(item.openedAt),
      item.closedAt ? exportedAt(item.closedAt) : "—",
      item.openingMinor / 100,
      item.expectedCashMinor / 100,
      item.actualCashMinor === null ? "—" : item.actualCashMinor / 100,
      item.differenceMinor === null ? "—" : item.differenceMinor / 100,
      item.invoiceCount,
      item.salesTotalMinor / 100,
      item.closeNote ?? "—",
    ];
    styleDataRow(sheet, rowNumber, 10, [6, 7, 8, 9, 11]);
  });
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.items.length + 4, 4), column: 12 } };
  return serialize(workbook);
}
