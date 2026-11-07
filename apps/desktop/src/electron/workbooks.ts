// exceljs is published as CommonJS.  Electron starts the main process as ESM,
// so a named import works in some development test runners but fails once the
// app is packaged.  The default import is Node's supported CJS interop path.
import ExcelJS, { type Workbook } from "exceljs";
import type { ComprehensiveReportResponse, InventoryExcelExportResponse, InventoryPeriodicExcelExportResponse, ProductExcelExportResponse, ShiftHistoryExcelExportResponse } from "@nabta/contracts";

const { Workbook: WorkbookConstructor } = ExcelJS;

export interface ExpiryWorkbookData {
  days: number;
  lots: Array<{
    lot_id: string;
    name_ar: string;
    unit_kind: "PIECE" | "WEIGHT";
    lot_code: string | null;
    expires_on: string;
    qty_milli: number;
    days_remaining: number;
  }>;
}

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

/** A dedicated sheet keeps expiry actions separate from the general inventory export. */
export async function createExpiryWorkbook(data: ExpiryWorkbookData): Promise<Buffer> {
  const workbook = baseWorkbook();
  const sheet = styleSheet(
    workbook,
    "تنبيه الصلاحية",
    `تنبيه صلاحية المخزون — خلال ${data.days} يومًا`,
    `وقت التصدير: ${exportedAt(new Date().toISOString())} | عدد التشغيلات: ${data.lots.length}`,
    ["الصنف", "رقم التشغيلة", "الكمية", "الوحدة", "تاريخ الصلاحية", "الأيام المتبقية", "الحالة"],
    [34, 20, 15, 12, 17, 16, 18],
  );
  data.lots.forEach((lot, index) => {
    const rowNumber = index + 5;
    const status = lot.days_remaining < 0 ? "منتهي" : lot.days_remaining === 0 ? "ينتهي اليوم" : "قريب الانتهاء";
    sheet.getRow(rowNumber).values = [
      lot.name_ar,
      lot.lot_code ?? "—",
      lot.qty_milli / 1000,
      lot.unit_kind === "WEIGHT" ? "كجم" : "قطعة",
      lot.expires_on,
      lot.days_remaining,
      status,
    ];
    styleDataRow(sheet, rowNumber, 3, []);
    const statusCell = sheet.getCell(rowNumber, 7);
    statusCell.font = { name: "Arial", size: 11, bold: true, color: { argb: lot.days_remaining < 0 ? "FFB42318" : "FFB54708" } };
  });
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.lots.length + 4, 4), column: 7 } };
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

const productSyncHeaders = [
  "اسم الصنف", "التصنيف", "طريقة البيع والاستلام", "باركود الكيس / القطعة", "باركود العبوة", "باركود الكرتونة",
  "الرصيد الكلي (وحدة)", "عدد العبوات / الكراتين", "الفرط خارجها", "سعة العبوة / الكرتونة", "سعة العمود (للأطباق)", "محتوى البيع",
  "سعر بيع الكيس / القطعة (جنيه)", "سعر بيع العبوة / العمود (جنيه)", "سعر بيع الكرتونة (جنيه)", "سعر الجملة للوحدة (جنيه)", "إجمالي الجملة (محسوب)", "حد إعادة الطلب", "الوصف", "تاريخ تصدير القالب", "رقم مراجعة الرصيد",
];

const saleMethods = ["كيلو", "جرام", "لتر (منتج سائل)", "ملليلتر (منتج سائل)", "قطعة منفردة", "عبوة (تباع عبوة أو فرط)", "كرتونة", "أطباق فوم (طبق / عمود / كرتونة)"];

function saleMethodForWorkbook(item: ProductExcelExportResponse["items"][number]): string {
  if (item.unitKind === "WEIGHT") return ({ KILOGRAM: "كيلو", GRAM: "جرام", LITER: "لتر (منتج سائل)", MILLILITER: "ملليلتر (منتج سائل)" }[item.weightUnit ?? "KILOGRAM"]);
  if (item.cartonPriceMinor && item.retailPackage?.label === "STACK") return "أطباق فوم (طبق / عمود / كرتونة)";
  if (item.cartonPriceMinor) return "كرتونة";
  if (item.retailPackage) return "عبوة (تباع عبوة أو فرط)";
  return "قطعة منفردة";
}

function escapeCsvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function arabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replaceAll("٬", "").replaceAll("٫", ".").replaceAll(",", ".");
}

function decimalToInteger(value: string, scale: 2 | 3, field: string, row: number, empty = "0"): string {
  const normalized = arabicDigits(value.trim() || empty);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`السطر ${row}: ${field} يجب أن يكون رقماً موجباً أو صفراً.`);
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > scale) throw new Error(`السطر ${row}: ${field} يحتوي منازل عشرية أكثر من المسموح.`);
  return String(Number(whole) * 10 ** scale + Number((fraction + "0".repeat(scale)).slice(0, scale)));
}

/**
 * A write-back workbook: existing barcodes update the product card and can
 * record a counted stock quantity; new barcodes create products.
 */
export async function createProductSyncWorkbook(data: ProductExcelExportResponse): Promise<Buffer> {
  const workbook = baseWorkbook();
  const sheet = styleSheet(
    workbook,
    "تعديل الأصناف",
    `تعديل واستيراد الأصناف — ${data.storeName}`,
    "المتاح فقط عند التصدير. كل صف بطاقة إدخال: اكتب أو امسح الباركودات واختر طريقة البيع، ثم استورد نفس الملف لتحديثه.",
    productSyncHeaders,
    [30, 19, 28, 21, 21, 21, 17, 18, 16, 19, 18, 15, 20, 20, 20, 20, 23, 18, 42, 24, 18],
  );
  const categories = [...new Set(data.items.map((item) => item.category).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ar"));
  const lists = workbook.addWorksheet("قوائم مساعدة", { views: [{ rightToLeft: true }] });
  lists.getColumn(1).values = ["التصنيفات", ...categories];
  lists.getColumn(2).values = ["طرق البيع والاستلام", ...saleMethods];
  lists.getColumn(3).values = ["محتوى البيع", "قطعة", "كيس"];
  const categoryEnd = Math.max(categories.length + 1, 2);
  workbook.definedNames.add(`'قوائم مساعدة'!$A$2:$A$${categoryEnd}`, "ProductCategories");
  workbook.definedNames.add("'قوائم مساعدة'!$B$2:$B$9", "SaleMethods");
  workbook.definedNames.add("'قوائم مساعدة'!$C$2:$C$3", "ContentsUnits");
  const endRow = Math.max(data.items.length + 4, 10_004);
  const validations = sheet as unknown as { dataValidations: { add(range: string, validation: object): void } };
  validations.dataValidations.add(`B5:B${endRow}`, { type: "list", allowBlank: false, formulae: ["ProductCategories"], showErrorMessage: true, errorTitle: "اختر تصنيفاً", error: "اختر تصنيفاً من القائمة أو أضفه في صفحة قوائم مساعدة قبل الاستيراد." });
  validations.dataValidations.add(`C5:C${endRow}`, { type: "list", allowBlank: false, formulae: ["SaleMethods"], showErrorMessage: true, errorTitle: "طريقة بيع غير صحيحة", error: "اختر طريقة البيع والاستلام من القائمة." });
  validations.dataValidations.add(`L5:L${endRow}`, { type: "list", allowBlank: true, formulae: ["ContentsUnits"], showErrorMessage: true, errorTitle: "محتوى غير صحيح", error: "اختر قطعة أو كيس من القائمة." });
  data.items.forEach((item, index) => {
    const rowNumber = index + 5;
    const method = saleMethodForWorkbook(item);
    const isContainer = method === "عبوة (تباع عبوة أو فرط)" || method === "كرتونة" || method === "أطباق فوم (طبق / عمود / كرتونة)";
    const capacity = method === "عبوة (تباع عبوة أو فرط)" ? item.retailPackage?.unitsPerPackage : item.purchasePackSize;
    const totalUnits = item.availableQtyMilli / 1000;
    const fullContainers = isContainer && capacity ? Math.floor(totalUnits / capacity) : "";
    const looseUnits = isContainer && capacity ? totalUnits % capacity : "";
    const unitBarcode = item.barcodeMappings?.find((mapping) => mapping.saleUnit === "UNIT")?.barcode ?? item.barcode ?? "";
    const packageBarcode = item.barcodeMappings?.find((mapping) => mapping.saleUnit === "PACKAGE")?.barcode ?? "";
    const cartonBarcode = item.barcodeMappings?.find((mapping) => mapping.saleUnit === "CARTON")?.barcode ?? "";
    sheet.getRow(rowNumber).values = [
      item.nameAr, item.category, method, unitBarcode, packageBarcode, cartonBarcode,
      totalUnits, fullContainers, looseUnits, capacity ?? "", method === "أطباق فوم (طبق / عمود / كرتونة)" ? item.retailPackage?.unitsPerPackage ?? "" : "", item.cartonContentsUnit === "BAG" || item.retailPackage?.contentsUnit === "BAG" ? "كيس" : "قطعة",
      item.priceMinor / 100, item.retailPackage ? item.retailPackage.packagePriceMinor / 100 : "", item.cartonPriceMinor ? item.cartonPriceMinor / 100 : "", (item.wholesalePriceMinor ?? 0) / 100, null, (item.reorderLevelMilli ?? 0) / 1000, item.description ?? "", data.generatedAt, item.stockVersion ?? 0,
    ];
    sheet.getCell(rowNumber, 17).value = { formula: `G${rowNumber}*P${rowNumber}`, result: totalUnits * ((item.wholesalePriceMinor ?? 0) / 100) };
    styleDataRow(sheet, rowNumber, [7, 8, 9, 10, 11, 18], [13, 14, 15, 16, 17]);
    sheet.getCell(rowNumber, 17).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4F2" } };
  });
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(data.items.length + 4, 4), column: productSyncHeaders.length } };

  const guide = workbook.addWorksheet("تعليمات", { views: [{ rightToLeft: true }] });
  guide.columns = [{ width: 26 }, { width: 88 }];
  guide.getRow(1).values = ["الحقل", "طريقة الاستخدام"];
  guide.getRow(1).font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  guide.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16785F" } };
  const instructions: Array<[string, string]> = [
    ["بحث سريع", "استعمل سهم التصفية في صف العناوين وابحث بالاسم أو بأي باركود. الصفوف التي يصدرها الزر هي المنتجات المتاحة فقط؛ ويمكنك إضافة صف جديد أسفلها."],
    ["الباركودات", "باركود الكيس/القطعة هو مفتاح المطابقة. اكتب باركود العبوة وباركود الكرتونة عند وجودهما؛ يبيع النظام كل باركود بوحدته الصحيحة."],
    ["طريقة البيع", "اختر من القائمة: كيلو، جرام، لتر، ملليلتر، قطعة، عبوة، كرتونة، أو أطباق فوم. تظهر نفس الاختيارات الموجودة في بطاقة إضافة الصنف."],
    ["العبوة والكرتونة", "للعبوة أو الكرتونة اكتب السعة، وعدد العبوات/الكراتين، والفرط خارجها. يمكن كتابة 1.5 كرتونة بشرط أن يكون الناتج عدد أكياس/قطع صحيحًا."],
    ["الأسعار", "اكتب سعر بيع الكيس/القطعة، وسعر العبوة أو العمود، وسعر الكرتونة بحسب الطريقة المختارة. إجمالي الجملة محسوب تلقائيًا من الرصيد الكلي × سعر الجملة للوحدة."],
    ["تاريخ ومراجعة الرصيد", "يحفظ القالب تاريخ التصدير ورقم مراجعة الرصيد. لا تعدلهما. إذا تغيّر رصيد الصنف داخل البرنامج بعد التصدير، يمنع البرنامج ملفًا قديمًا من استبداله برقم مختلف."],
    ["تعديل رصيد قائم", "الرصيد الكلي أو (الكراتين/العبوات + الفرط) يعدّل الرصيد بحركة جرد موثقة، ولا يغيّر الفواتير السابقة. إذا كان الرقم نفسه فلن تُسجل حركة مخزون."],
    ["صنف جديد", "أضف صفًا جديدًا، املأ الاسم والتصنيف والطريقة وباركود الكيس/القطعة والسعر والجملة والرصيد. يحفظه البرنامج كرصد افتتاحي."],
    ["تنبيه", "لا تغيّر صنفًا قائمًا من قطعة إلى وزن أو العكس، ولا تغيّر وحدة الوزن الأساسية؛ أنشئ صنفًا جديدًا عند اختلافها."],
  ];
  instructions.forEach((item, index) => {
    const row = index + 2;
    guide.getRow(row).values = item;
    guide.getRow(row).alignment = { wrapText: true, vertical: "top", horizontal: "right" };
    guide.getRow(row).height = 38;
  });
  return serialize(workbook);
}

/** Converts Nabta's guided Excel entry sheet to the validated product-import contract. */
export async function productSyncWorkbookToCsv(bytes: Uint8Array): Promise<string> {
  const workbook = baseWorkbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("تعديل الأصناف");
  if (!sheet) throw { code: "PRODUCT_WORKBOOK_TEMPLATE_INVALID", messageAr: "ملف Excel لا يحتوي ورقة «تعديل الأصناف» الخاصة بنبتة." };
  const actual = productSyncHeaders.map((_, index) => sheet.getCell(4, index + 1).text.trim());
  if (actual.join("|") !== productSyncHeaders.join("|")) throw { code: "PRODUCT_WORKBOOK_TEMPLATE_INVALID", messageAr: "رؤوس أعمدة ملف Excel لا تطابق قالب نبتة الجديد. صدّر قالباً جديداً ثم انقل بياناتك إليه." };
  const lines = ["nameAr,category,unitKind,priceMinor,barcode,reorderLevelMilli,openingQtyMilli,openingUnitCostMinor,wholesalePriceMinor,availableQtyMilli,weightUnit,description,purchasePackSize,cartonPriceMinor,cartonContentsUnit,retailPackageSize,retailPackagePriceMinor,retailPackageContentsUnit,retailPackageLabel,packageBarcode,cartonBarcode,exportedAt,expectedStockVersion"];
  const methodMap: Record<string, { unitKind: "PIECE" | "WEIGHT"; weightUnit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" }> = {
    "كيلو": { unitKind: "WEIGHT", weightUnit: "KILOGRAM" }, "جرام": { unitKind: "WEIGHT", weightUnit: "GRAM" }, "لتر (منتج سائل)": { unitKind: "WEIGHT", weightUnit: "LITER" }, "ملليلتر (منتج سائل)": { unitKind: "WEIGHT", weightUnit: "MILLILITER" },
    "قطعة منفردة": { unitKind: "PIECE", weightUnit: "KILOGRAM" }, "عبوة (تباع عبوة أو فرط)": { unitKind: "PIECE", weightUnit: "KILOGRAM" }, "كرتونة": { unitKind: "PIECE", weightUnit: "KILOGRAM" }, "أطباق فوم (طبق / عمود / كرتونة)": { unitKind: "PIECE", weightUnit: "KILOGRAM" },
  };
  for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = Array.from({ length: productSyncHeaders.length }, (_, index) => sheet.getCell(rowNumber, index + 1).text.trim());
    if (values.every((value) => !value)) continue;
    const [nameAr = "", category = "", saleMethod = "", barcode = "", packageBarcode = "", cartonBarcode = "", total = "", containers = "", loose = "", capacity = "", stackSize = "", contents = "", unitPrice = "", packagePrice = "", cartonPrice = "", wholesale = "", _totalWholesale = "", reorder = "", description = "", exportedAt = "", expectedStockVersion = ""] = values;
    const mapped = methodMap[saleMethod];
    if (!mapped) throw { code: "PRODUCT_WORKBOOK_INVALID", messageAr: `السطر ${rowNumber}: اختر طريقة البيع والاستلام من القائمة.` };
    try {
      const isPackage = saleMethod === "عبوة (تباع عبوة أو فرط)";
      const isPlate = saleMethod === "أطباق فوم (طبق / عمود / كرتونة)";
      const isCarton = saleMethod === "كرتونة" || isPlate;
      const isContainer = isPackage || isCarton;
      const packSize = isContainer ? Number(decimalToInteger(capacity, 3, "سعة العبوة أو الكرتونة", rowNumber, "")) / 1000 : 1;
      if (isContainer && (!Number.isInteger(packSize) || packSize < 2)) throw new Error(`السطر ${rowNumber}: سعة العبوة أو الكرتونة يجب أن تكون عدداً صحيحاً لا يقل عن 2.`);
      let quantity = Number(decimalToInteger(total, 3, "الرصيد الكلي", rowNumber, "")) / 1000;
      if (isContainer && (containers || loose)) {
        const containerCount = Number(arabicDigits(containers || "0"));
        const looseCount = Number(arabicDigits(loose || "0"));
        quantity = containerCount * packSize + looseCount;
        if (!Number.isFinite(containerCount) || containerCount < 0 || !Number.isInteger(containerCount * 2) || !Number.isInteger(looseCount) || looseCount < 0 || looseCount >= packSize || !Number.isInteger(quantity)) throw new Error(`السطر ${rowNumber}: اكتب كراتين أو عبوات كاملة/نصفية وفرطاً صحيحاً أقل من السعة.`);
      }
      if (mapped.unitKind === "PIECE" && !Number.isInteger(quantity)) throw new Error(`السطر ${rowNumber}: رصيد صنف القطعة يجب أن يكون عدداً صحيحاً.`);
      const availableQtyMilli = String(Math.round(quantity * 1000));
      const contentsUnit = contents === "كيس" ? "BAG" : "PIECE";
      const stackUnits = isPlate ? Number(decimalToInteger(stackSize, 3, "سعة العمود", rowNumber, "")) / 1000 : 0;
      if (isPlate && (!Number.isInteger(stackUnits) || stackUnits < 2 || stackUnits > packSize)) throw new Error(`السطر ${rowNumber}: سعة العمود يجب أن تكون من 2 إلى سعة الكرتونة.`);
      const packagePriceMinor = isPackage || isPlate ? decimalToInteger(packagePrice, 2, "سعر بيع العبوة أو العمود", rowNumber, "") : "";
      const cartonPriceMinor = isCarton ? decimalToInteger(cartonPrice, 2, "سعر بيع الكرتونة", rowNumber, "") : "";
      if ((isPackage && Number(packagePriceMinor) <= 0) || (isCarton && Number(cartonPriceMinor) <= 0)) throw new Error(`السطر ${rowNumber}: اكتب سعر بيع الشكل الكامل المختار.`);
      lines.push([
        nameAr, category, mapped.unitKind, decimalToInteger(unitPrice, 2, "سعر بيع الكيس أو القطعة", rowNumber, ""), barcode,
        decimalToInteger(reorder, 3, "حد إعادة الطلب", rowNumber), availableQtyMilli, decimalToInteger(wholesale, 2, "سعر الجملة للوحدة", rowNumber), decimalToInteger(wholesale, 2, "سعر الجملة للوحدة", rowNumber), availableQtyMilli, mapped.weightUnit,
        description, String(packSize), cartonPriceMinor, isCarton ? contentsUnit : "", isPackage || isPlate ? String(isPackage ? packSize : stackUnits) : "", packagePriceMinor, isPackage || isPlate ? contentsUnit : "", isPlate ? "STACK" : "PACKAGE", packageBarcode, cartonBarcode, exportedAt, expectedStockVersion,
      ].map(escapeCsvCell).join(","));
    } catch (cause) {
      const messageAr = cause instanceof Error ? cause.message : "تعذر قراءة بيانات الصف.";
      throw { code: "PRODUCT_WORKBOOK_INVALID", messageAr };
    }
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
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

function visualBar(value: number, max: number, size = 28): string {
  if (max <= 0 || value <= 0) return "";
  return "█".repeat(Math.max(1, Math.round((value / max) * size)));
}

/** A complete, printable Excel report. Values remain numeric; visual bars are a compact chart for Excel versions without embedded-chart support. */
export async function createComprehensiveReportWorkbook(data: ComprehensiveReportResponse): Promise<Buffer> {
  const workbook = baseWorkbook();
  const summary = styleSheet(
    workbook, "لوحة التقرير", `التقرير التشغيلي الشامل — ${data.storeName}`,
    `الفترة: ${data.period.from} إلى ${data.period.to} | وقت التصدير: ${exportedAt(data.generatedAt)}`,
    ["المؤشر", "القيمة"], [36, 24],
  );
  const metrics: Array<[string, number]> = [
    ["إجمالي المبيعات", data.summary.grossSalesMinor], ["الخصومات", data.summary.discountsMinor], ["المرتجعات", data.summary.returnsMinor],
    ["صافي المبيعات", data.summary.netSalesMinor], ["تكلفة المبيعات", data.summary.netCogsMinor], ["مجمل الربح", data.summary.grossProfitMinor],
    ["المصروفات", data.summary.expensesMinor], ["خسارة التالف", data.summary.damagedLossMinor], ["صافي الربح التقديري", data.summary.estimatedNetProfitMinor],
    ["عدد الفواتير", data.summary.invoiceCount], ["قيمة المخزون الحالية", data.inventory.inventoryValueMinor], ["أصناف منخفضة المخزون", data.inventory.lowStockCount], ["أصناف نافدة", data.inventory.outOfStockCount],
  ];
  metrics.forEach(([label, value], index) => {
    const row = index + 5;
    summary.getRow(row).values = [label, index === 9 || index >= 11 ? value : value / 100];
    styleDataRow(summary, row, [], index === 9 || index >= 11 ? [] : [2]);
  });
  const insightStart = metrics.length + 7;
  summary.getCell(`A${insightStart}`).value = "الاستنتاجات";
  summary.getCell(`A${insightStart}`).font = { name: "Arial", bold: true, color: { argb: "FF16785F" } };
  data.insights.forEach((insight, index) => { summary.mergeCells(`A${insightStart + index + 1}:B${insightStart + index + 1}`); summary.getCell(`A${insightStart + index + 1}`).value = `• ${insight}`; });

  const daily = styleSheet(workbook, "اتجاه المبيعات", `اتجاه المبيعات اليومي — ${data.storeName}`, `الفترة: ${data.period.from} إلى ${data.period.to}`, ["التاريخ", "صافي المبيعات", "مجمل الربح", "الفواتير", "رسم صافي المبيعات"], [16, 18, 18, 12, 34]);
  const dailyMax = Math.max(0, ...data.dailySales.map((item) => item.netSalesMinor));
  data.dailySales.forEach((item, index) => { const row = index + 5; daily.getRow(row).values = [item.date, item.netSalesMinor / 100, item.grossProfitMinor / 100, item.invoiceCount, visualBar(item.netSalesMinor, dailyMax)]; styleDataRow(daily, row, [], [2, 3]); daily.getCell(row, 5).font = { name: "Arial", color: { argb: "FF16785F" } }; });
  daily.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.dailySales.length + 4), column: 5 } };

  const payments = styleSheet(workbook, "وسائل الدفع", `تحليل وسائل الدفع — ${data.storeName}`, `الفترة: ${data.period.from} إلى ${data.period.to}`, ["وسيلة الدفع", "القيمة", "عدد العمليات", "الرسم البياني"], [24, 20, 16, 34]);
  const paymentMax = Math.max(0, ...data.paymentMethods.map((item) => item.amountMinor));
  data.paymentMethods.forEach((item, index) => { const row = index + 5; payments.getRow(row).values = [item.method, item.amountMinor / 100, item.transactionCount, visualBar(item.amountMinor, paymentMax)]; styleDataRow(payments, row, [], [2]); payments.getCell(row, 4).font = { name: "Arial", color: { argb: "FF2563EB" } }; });
  payments.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.paymentMethods.length + 4), column: 4 } };

  const products = styleSheet(workbook, "أفضل الأصناف", `أفضل 20 صنفًا — ${data.storeName}`, `مرتبة حسب صافي المبيعات خلال الفترة`, ["الصنف", "التصنيف", "صافي الكمية", "صافي المبيعات", "مجمل الربح"], [34, 20, 16, 20, 20]);
  data.topProducts.forEach((item, index) => { const row = index + 5; products.getRow(row).values = [item.nameAr, item.category, item.netQtyMilli / 1000, item.netSalesMinor / 100, item.grossProfitMinor / 100]; styleDataRow(products, row, 3, [4, 5]); });
  products.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.topProducts.length + 4), column: 5 } };

  const categories = styleSheet(workbook, "التصنيفات", `تحليل التصنيفات — ${data.storeName}`, `الفترة: ${data.period.from} إلى ${data.period.to}`, ["التصنيف", "صافي المبيعات", "مجمل الربح"], [28, 20, 20]);
  data.categories.forEach((item, index) => { const row = index + 5; categories.getRow(row).values = [item.category, item.netSalesMinor / 100, item.grossProfitMinor / 100]; styleDataRow(categories, row, [], [2, 3]); });
  categories.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.categories.length + 4), column: 3 } };

  const expenses = styleSheet(workbook, "تحليل المصروفات", `تحليل المصروفات — ${data.storeName}`, `الفترة: ${data.period.from} إلى ${data.period.to}`, ["التصنيف", "القيمة", "عدد الحركات"], [34, 20, 18]);
  data.expenseCategories.forEach((item, index) => { const row = index + 5; expenses.getRow(row).values = [item.category, item.amountMinor / 100, item.itemCount]; styleDataRow(expenses, row, [], [2]); });
  expenses.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.expenseCategories.length + 4), column: 3 } };

  const consumption = styleSheet(workbook, "استهلاك المحل", `استهلاك المحل — ${data.storeName}`, `الفترة: ${data.period.from} إلى ${data.period.to}`, ["التاريخ", "البيان", "التصنيف", "القيمة"], [16, 38, 24, 20]);
  data.shopConsumptions.forEach((item, index) => { const row = index + 5; consumption.getRow(row).values = [item.date, item.itemName, item.category, item.amountMinor / 100]; styleDataRow(consumption, row, [], [4]); });
  consumption.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.shopConsumptions.length + 4), column: 4 } };

  const payroll = styleSheet(workbook, "الرواتب", `كشف الرواتب — ${data.storeName}`, `الفترة: ${data.period.from} إلى ${data.period.to}`, ["الموظف", "شهر الراتب", "الصافي", "الدفع", "تاريخ الصرف"], [30, 18, 20, 20, 18]);
  data.payroll.forEach((item, index) => { const row = index + 5; payroll.getRow(row).values = [item.employeeName, item.month, item.netMinor / 100, item.paymentMethod, item.paidOn]; styleDataRow(payroll, row, [], [3]); });
  payroll.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, data.payroll.length + 4), column: 5 } };
  return serialize(workbook);
}
