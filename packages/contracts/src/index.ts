import { z } from "zod";

export const amountMinorSchema = z.number().int().min(0).max(9_000_000_000_000);
export const signedAmountMinorSchema = z.number().int().min(-9_000_000_000_000).max(9_000_000_000_000);
export const qtyMilliSchema = z.number().int().positive().max(9_000_000_000_000);
export const idSchema = z.string().uuid();
export const barcodeSchema = z.string().trim().min(1).max(80).regex(/^[^\r\n]+$/);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const inventoryReportPeriodSchema = z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]);
export const cloudflareConnectionUpdateSchema = z.object({
  enabled: z.boolean(),
  autoStart: z.boolean(),
  tunnelToken: z.string().trim().min(32).max(4096).optional(),
  commerceSharedSecret: z.string().trim().min(32).max(512).optional(),
  terminalRelaySharedSecret: z.string().trim().min(32).max(512).optional(),
  terminalRelayUrl: z.string().trim().url().max(500).or(z.literal(" ")).or(z.literal("")).optional(),
  publicApiUrl: z.string().trim().url().max(500).or(z.literal(" ")).or(z.literal("")).optional(),
});

export const cloudMigrationRunSchema = z.object({
  cloudUrl: z.string().trim().url().max(500),
  // Entered only while creating the store's Durable Object. The desktop does
  // not save this account-wide key after the migration starts.
  bootstrapKey: z.string().trim().min(48).max(512).optional(),
  // Credentials are required only when the store is first claimed. Later
  // protected refreshes reuse the already-claimed cloud account and must not
  // force an owner to rotate a password merely to create a backup.
  ownerUsername: z.string().trim().min(2).max(100).optional(),
  ownerCloudPassword: z.string().min(12).max(256).optional(),
}).strict();

export const multiTerminalJoinRequestSchema = z.object({
  serverUrl: z.string().trim().url().max(500),
  relayKey: z.string().trim().min(32).max(512),
  terminalName: z.string().trim().min(2).max(100),
  enrollmentPin: z.string().regex(/^\d{6}$/),
});

export const terminalEnrollRequestSchema = z.object({
  terminalId: idSchema,
  terminalName: z.string().trim().min(2).max(100),
  enrollmentPin: z.string().regex(/^\d{6}$/),
});

export const roleSchema = z.enum(["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "EXPIRY_CLERK"]);
export const unitKindSchema = z.enum(["PIECE", "WEIGHT"]);
/** How a packaged product is placed in the sales cart. Stock remains in base pieces. */
export const saleUnitSchema = z.enum(["UNIT", "PACKAGE", "CARTON"]);
export const customerOrderStatusSchema = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "FULFILLED"]);
export const customerOrderSourceSchema = z.enum(["WEB", "MESSENGER"]);
export const productBarcodeMappingSchema = z.object({
  barcode: barcodeSchema,
  saleUnit: saleUnitSchema,
});
export const retailPackageUnitSchema = z.enum(["PIECE", "BAG"]);
/** Customer-facing name of a middle selling level (e.g. foam/plate stack). */
export const retailPackageLabelSchema = z.enum(["PACKAGE", "STACK", "PACKET"]);
export const retailPackageSchema = z.object({
  unitsPerPackage: z.number().int().min(2).max(100_000),
  packagePriceMinor: amountMinorSchema.positive(),
  contentsUnit: retailPackageUnitSchema,
  label: retailPackageLabelSchema.default("PACKAGE"),
});
/**
 * Fractional products share one exact thousandth-based stock representation:
 * grams for weight and millilitres for liquids.  The displayed unit keeps the
 * two business flows distinct without introducing floating point arithmetic.
 */
export const weightUnitSchema = z.enum(["KILOGRAM", "GRAM", "LITER", "MILLILITER"]);
// CARD is kept for backwards-compatible manual bookkeeping. Provider-backed
// payments use their own method values and require a confirmed payment intent.
export const paymentMethodSchema = z.enum([
  "CASH", "CARD", "CREDIT", "KASHIER_POS_CARD", "FAWRY_REFERENCE", "ONLINE_CARD",
  "MOBILE_WALLET", "PAYMENT_LINK", "INSTAPAY_QR", "INSTAPAY_R2P",
  "BANK_INSTALLMENTS", "BNPL", "MEEZA_CARD", "OTHER_MANUAL_TRANSFER",
  "MIXED_PAYMENT",
]);
export const electronicPaymentMethodSchema = z.enum([
  "KASHIER_POS_CARD", "FAWRY_REFERENCE", "ONLINE_CARD", "MOBILE_WALLET", "PAYMENT_LINK",
  "INSTAPAY_QR", "INSTAPAY_R2P", "BANK_INSTALLMENTS", "BNPL", "MEEZA_CARD",
]);
export const paymentIntentStatusSchema = z.enum([
  "CREATED", "AWAITING_CUSTOMER", "PROCESSING", "PENDING_CONFIRMATION",
  "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED", "RECONCILIATION_REQUIRED",
  "REFUND_PENDING", "REFUNDED",
]);
export const shiftStatusSchema = z.enum(["OPEN", "CLOSED"]);
export const stockMovementTypeSchema = z.enum([
  "OPENING",
  "PURCHASE_RECEIPT",
  "SALE",
  "SALE_RETURN",
  "SUPPLIER_RETURN",
  "COUNT_ADJUSTMENT",
  "WRITE_OFF",
  "TRANSFER_IN",
  "TRANSFER_OUT",
]);

export const setupRequestSchema = z.object({
  setupToken: z.string().min(20).max(512),
  storeName: z.string().trim().min(2).max(120),
  branchName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  username: z.string().trim().min(3).max(80).regex(/^[\p{L}\p{N}._-]+$/u),
  password: z.string().min(12).max(256),
  terminalName: z.string().trim().min(2).max(80),
});

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
  terminalId: idSchema,
});

export const createProductRequestSchema = z.object({
  nameAr: z.string().trim().min(2).max(160),
  sku: z.string().trim().max(80).optional(),
  category: z.string().trim().min(1).max(100),
  unitKind: unitKindSchema,
  weightUnit: weightUnitSchema.default("KILOGRAM"),
  priceMinor: amountMinorSchema.positive(),
  wholesalePriceMinor: amountMinorSchema.optional(),
  /** Optional advertised price for a complete supplier carton. */
  cartonPriceMinor: amountMinorSchema.positive().optional(),
  /** What a full carton contains when it can also be sold loose. */
  cartonContentsUnit: retailPackageUnitSchema.optional(),
  /** Number of base pieces in one supplier carton. One means purchased by piece. */
  purchasePackSize: z.number().int().min(1).max(100_000).default(1),
  /** Optional retail package that can be sold whole or as loose pieces/bags. */
  retailPackage: retailPackageSchema.optional(),
  reorderLevelMilli: amountMinorSchema,
  barcodes: z.array(barcodeSchema).min(1).max(20),
  barcodeMappings: z.array(productBarcodeMappingSchema).min(1).max(3).optional(),
  openingQtyMilli: amountMinorSchema.optional().default(0),
  openingUnitCostMinor: amountMinorSchema.optional().default(0),
  /** Exact opening value, used when a carton total cannot be divided into whole piastres. */
  openingTotalCostMinor: amountMinorSchema.optional(),
}).superRefine((value, context) => {
  if (value.cartonPriceMinor && value.retailPackage?.label === "STACK" && value.purchasePackSize % value.retailPackage.unitsPerPackage !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["purchasePackSize"], message: "Carton capacity must contain a whole number of stacks" });
  }
});

export const updateProductPriceRequestSchema = z.object({
  productId: idSchema,
  priceMinor: amountMinorSchema.positive().optional(),
  wholesalePriceMinor: amountMinorSchema.optional(),
}).refine((value) => value.priceMinor !== undefined || value.wholesalePriceMinor !== undefined, {
  message: "أدخل سعر البيع أو سعر الجملة الداخلي",
});

/**
 * Owner/manager edit of the product card.  The quantity is deliberately part
 * of this request rather than a direct balance update: the server records a
 * stock-count adjustment and keeps the stock ledger intact.
 */
export const updateProductRequestSchema = z.object({
  productId: idSchema,
  nameAr: z.string().trim().min(2).max(160),
  category: z.string().trim().min(1).max(100),
  description: z.string().trim().max(4_000).default(""),
  priceMinor: amountMinorSchema,
  wholesalePriceMinor: amountMinorSchema.optional(),
  purchasePackSize: z.number().int().min(1).max(100_000),
  /** null removes retail-package selling; omitted preserves the current setting. */
  retailPackage: retailPackageSchema.nullable().optional(),
  /** null removes full-carton selling; omitted preserves the current setting. */
  cartonPriceMinor: amountMinorSchema.positive().nullable().optional(),
  cartonContentsUnit: retailPackageUnitSchema.nullable().optional(),
  availableQtyMilli: amountMinorSchema,
  expectedStockVersion: z.number().int().min(0),
  /** Only the optional full-package/carton mappings are edited here. */
  barcodeMappings: z.array(productBarcodeMappingSchema).max(2).optional(),
  /** Existing barcodes are merged into the current product automatically. */
  mergeLegacyProducts: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.priceMinor < 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "سعر البيع لا يمكن أن يكون سالباً" });
  if (value.cartonPriceMinor && value.retailPackage?.label === "STACK" && value.purchasePackSize % value.retailPackage.unitsPerPackage !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["purchasePackSize"], message: "Carton capacity must contain a whole number of stacks" });
  }
});

export const archiveProductRequestSchema = z.object({
  productId: idSchema,
});

export const attachNumericBarcodeRequestSchema = z.object({
  productId: idSchema,
  barcode: z.string().regex(/^\d{8,14}$/, "الباركود يجب أن يكون أرقاماً فقط"),
});

export const productExportRequestSchema = z.object({
  mode: z.enum(["PUBLIC", "INTERNAL"]).default("PUBLIC"),
  query: z.string().trim().max(160).optional(),
  availableOnly: z.coerce.boolean().default(false),
  productIds: z.preprocess(
    (value) => typeof value === "string" ? value.split(",").filter(Boolean) : value,
    z.array(idSchema).min(1).max(250).optional(),
  ),
});

export const productCsvImportRequestSchema = z.object({
  csv: z.string().max(5_000_000),
  preview: z.boolean().default(true),
});

/**
 * This is intentionally a small public contract.  Prices, stock and totals are
 * always recalculated on Nabta's server, never trusted from the customer app.
 */
export const commerceOrderRequestSchema = z.object({
  clientOrderId: idSchema,
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z.string().trim().min(6).max(30).regex(/^[0-9+()\-\s]+$/),
  deliveryAddress: z.string().trim().min(5).max(500),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(z.object({
    productId: idSchema,
    qtyMilli: qtyMilliSchema,
    saleUnit: saleUnitSchema.default("UNIT"),
  })).min(1).max(100),
});

export const commerceOrderStatusUpdateSchema = z.object({
  status: customerOrderStatusSchema,
  note: z.string().trim().max(500).optional(),
});

/** The desktop process reads the workbook locally, then sends its validated tabular data to the API. */
export const productWorkbookImportRequestSchema = z.object({
  idempotencyKey: idSchema,
  workbookBase64: z.string().min(1).max(25_000_000),
  preview: z.boolean().default(true),
});

export const createUserRequestSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  username: z.string().trim().min(3).max(80).regex(/^[\p{L}\p{N}._-]+$/u),
  password: z.string().min(12).max(256),
  role: roleSchema,
  discountLimitBps: z.number().int().min(0).max(10000).default(0),
});

export const updateUserRequestSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  role: roleSchema,
  discountLimitBps: z.number().int().min(0).max(10000),
  active: z.boolean(),
  password: z.string().min(12).max(256).optional(),
});

export const createTerminalRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const openShiftRequestSchema = z.object({
  terminalId: idSchema,
  openingMinor: amountMinorSchema,
});

export const cashMovementRequestSchema = z.object({
  type: z.enum(["EXPENSE", "WITHDRAWAL", "DEPOSIT"]),
  amountMinor: amountMinorSchema.positive(),
  reason: z.string().trim().min(3).max(250),
  expenseCategory: z.string().trim().min(2).max(80).optional(),
  consumption: z.object({
    itemName: z.string().trim().min(2).max(160),
    category: z.string().trim().min(2).max(80),
    quantityNote: z.string().trim().max(80).optional(),
    supplierName: z.string().trim().max(160).optional(),
    consumedOn: localDateSchema,
    note: z.string().trim().max(250).optional(),
  }).optional(),
}).superRefine((value, context) => {
  if (value.consumption && value.type !== "EXPENSE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "استهلاك المحل يجب أن يكون مصروفًا نقديًا" });
  }
});

export const shopConsumptionListQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
});

export const branchSettingsRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  creditSalesEnabled: z.boolean(),
  preventExpiredSales: z.boolean(),
  receiptPhone: z.string().trim().max(40).default(""),
  whatsappPhone: z.string().trim().max(40).default(""),
  socialHandle: z.string().trim().max(120).default(""),
  receiptFooter: z.string().trim().max(180).default("شكراً لزيارتكم"),
  logoDataUrl: z.union([
    z.literal(""),
    z.string().max(800_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  ]).default(""),
});

export const closeShiftRequestSchema = z.object({
  actualCashMinor: amountMinorSchema,
  note: z.string().trim().max(250).optional(),
  managerUsername: z.string().trim().max(80).optional(),
  managerPassword: z.string().max(256).optional(),
});

export const shiftHistoryQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "اختر شهرًا صحيحًا بصيغة سنة-شهر"),
});

export interface ShiftHistoryExcelExportResponse {
  storeName: string;
  month: string;
  generatedAt: string;
  items: Array<{
    id: string;
    cashierName: string;
    terminalName: string;
    status: "OPEN" | "CLOSED";
    openedAt: string;
    closedAt: string | null;
    openingMinor: number;
    expectedCashMinor: number;
    actualCashMinor: number | null;
    differenceMinor: number | null;
    invoiceCount: number;
    salesTotalMinor: number;
    closeNote: string | null;
  }>;
}

export const quoteRequestSchema = z.object({
  terminalId: idSchema,
  shiftId: idSchema,
  lines: z.array(z.object({
    productId: idSchema.optional(),
    /** A cash-register-only line. It is printed on this invoice but never creates a catalogue or stock record. */
    manualNameAr: z.string().trim().min(1).max(160).optional(),
    manualPriceMinor: amountMinorSchema.positive().optional(),
    qtyMilli: qtyMilliSchema,
    saleUnit: saleUnitSchema.default("UNIT"),
    weightedLabelBarcode: z.string().regex(/^\d{13}$/).optional(),
    /** Cashier-entered final total for an unlabelled weighted item. */
    enteredTotalMinor: amountMinorSchema.positive().optional(),
  }).superRefine((line, context) => {
    const manual = line.manualNameAr !== undefined || line.manualPriceMinor !== undefined;
    if (!line.productId && (!line.manualNameAr || line.manualPriceMinor === undefined)) {
      context.addIssue({ code: "custom", path: ["manualNameAr"], message: "اكتب اسم وسعر الصنف المباشر" });
    }
    if (line.productId && manual) {
      context.addIssue({ code: "custom", path: ["productId"], message: "السطر إما صنف مسجل أو صنف مباشر" });
    }
    if (manual && (line.qtyMilli !== 1000 || line.saleUnit !== "UNIT" || line.weightedLabelBarcode || line.enteredTotalMinor !== undefined)) {
      context.addIssue({ code: "custom", path: ["qtyMilli"], message: "الصنف المباشر يباع كسطر واحد بالسعر النهائي" });
    }
    if (line.enteredTotalMinor !== undefined && line.saleUnit !== "UNIT") {
      context.addIssue({ code: "custom", path: ["enteredTotalMinor"], message: "السعر النهائي المباشر متاح للوزن المفرد فقط" });
    }
    if (line.enteredTotalMinor !== undefined && line.weightedLabelBarcode) {
      context.addIssue({ code: "custom", path: ["enteredTotalMinor"], message: "لا يُضاف سعر يدوي إلى ملصق وزن مطبوع" });
    }
  })).min(1).max(200),
  discountMinor: amountMinorSchema.default(0),
});

export const weightedLabelCreateRequestSchema = z.object({
  productId: idSchema,
  mode: z.enum(["AMOUNT", "QUANTITY"]),
  amountMinor: amountMinorSchema.positive().optional(),
  qtyMilli: qtyMilliSchema.optional(),
  /** The Windows primary owns the label printer; mobile only queues work. */
  printOnPrimary: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.mode === "AMOUNT" && value.amountMinor === undefined) context.addIssue({ code: "custom", path: ["amountMinor"], message: "المبلغ مطلوب" });
  if (value.mode === "QUANTITY" && value.qtyMilli === undefined) context.addIssue({ code: "custom", path: ["qtyMilli"], message: "الكمية مطلوبة" });
});

export const weightedLabelMarkPrintedRequestSchema = z.object({ barcode: z.string().regex(/^\d{13}$/) });

export const postSaleRequestSchema = z.object({
  terminalId: idSchema,
  shiftId: idSchema,
  quoteId: idSchema,
  /** Queues one receipt on the primary Windows device; the phone never reaches a printer directly. */
  printOnPrimary: z.boolean().optional(),
  customerId: idSchema.optional(),
  // Only a server-confirmed payment intent may authorize an electronic
  // allocation.  The client cannot synthesize this identifier into success.
  paymentIntentId: idSchema.optional(),
  payments: z.array(z.object({
    method: paymentMethodSchema,
    amountMinor: amountMinorSchema,
    tenderedMinor: amountMinorSchema.optional(),
    reference: z.string().trim().max(120).optional(),
  })).min(1).max(4),
});

export const paymentSettingsUpdateSchema = z.object({
  provider: z.enum(["FAWRY", "KASHIER"]).default("FAWRY"),
  environment: z.enum(["TEST", "LIVE"]),
  activateEnvironment: z.boolean().default(true),
  merchantId: z.string().trim().min(3).max(160),
  secretKey: z.string().trim().min(8).max(1024).optional(),
  apiKey: z.string().trim().min(8).max(1024).optional(),
  paymentApiKey: z.string().trim().min(8).max(1024).optional(),
  secureHashKey: z.string().trim().min(8).max(1024).optional(),
  relayToken: z.string().trim().min(16).max(1024).optional(),
  webhookUrl: z.string().url().max(500).optional().or(z.literal("")),
  merchantRedirectUrl: z.string().url().max(500).optional().or(z.literal("")),
  relayUrl: z.string().url().max(500).optional().or(z.literal("")),
  receiptPrintEnabled: z.boolean().default(true),
  requestTimeoutMs: z.number().int().min(3000).max(60000).default(30000),
  retryLimit: z.number().int().min(0).max(3).default(0),
  enabledMethods: z.array(electronicPaymentMethodSchema).max(9).default([]),
  confirmationPassword: z.string().min(1).max(256),
});

export const paymentDeviceBindingSchema = z.object({
  provider: z.enum(["FAWRY", "KASHIER"]).default("FAWRY"),
  terminalId: idSchema,
  serialNo: z.string().trim().min(3).max(160),
  isDefault: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const createPaymentIntentSchema = z.object({
  terminalId: idSchema,
  shiftId: idSchema,
  quoteId: idSchema,
  method: electronicPaymentMethodSchema,
  idempotencyKey: idSchema,
  printReceipt: z.boolean().default(true),
  redirectUrl: z.string().url().max(500).optional(),
  customerName: z.string().trim().min(2).max(120).optional(),
  customerMobile: z.string().trim().regex(/^01\d{9}$/).optional(),
  customerEmail: z.string().trim().email().max(254).optional(),
});

export const paymentRefundRequestSchema = z.object({
  amountMinor: amountMinorSchema.positive(),
  idempotencyKey: idSchema,
});

export const saleReturnRequestSchema = z.object({
  shiftId: idSchema,
  lines: z.array(z.object({
    saleLineId: idSchema,
    qtyMilli: qtyMilliSchema,
    condition: z.enum(["RESTOCK", "DAMAGED"]),
  })).min(1).max(200),
  refunds: z.array(z.object({
    method: paymentMethodSchema,
    amountMinor: amountMinorSchema,
  })).max(4).optional(),
  reason: z.string().trim().min(3).max(250),
});

export const purchaseReceiptRequestSchema = z.object({
  warehouseId: idSchema,
  supplierId: idSchema.optional(),
  supplierName: z.string().trim().min(2).max(160),
  supplierInvoiceNo: z.string().trim().max(100).optional(),
  supplyExpensesMinor: amountMinorSchema.default(0),
  /** A mobile receiving session may ask the primary Windows device to print once. */
  printOnPrimary: z.boolean().optional(),
  lines: z.array(z.object({
    productId: idSchema,
    /** Always the normalized stock quantity in base units. */
    qtyMilli: qtyMilliSchema,
    unitCostMinor: amountMinorSchema,
    entryUnit: z.enum(["PIECE", "CARTON", "WEIGHT"]).default("PIECE"),
    costBasis: z.enum(["UNIT", "PACKAGE", "LINE_TOTAL"]).default("UNIT"),
    packageCount: z.number().int().min(1).max(1_000_000).optional(),
    unitsPerPackage: z.number().int().min(1).max(100_000).optional(),
    packageCostMinor: amountMinorSchema.optional(),
    lineTotalMinor: amountMinorSchema.optional(),
    wholesalePriceMinor: amountMinorSchema.optional(),
    retailPriceMinor: amountMinorSchema.positive().optional(),
    lotCode: z.string().trim().max(100).optional(),
    expiresOn: localDateSchema.optional(),
  }).superRefine((line, context) => {
    const hasCartonData = line.packageCount !== undefined || line.unitsPerPackage !== undefined || line.packageCostMinor !== undefined;
    if (line.entryUnit === "CARTON" && (line.packageCount === undefined || line.unitsPerPackage === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "بيانات الكرتونة غير مكتملة" });
    }
    if (line.entryUnit === "CARTON" && line.costBasis === "PACKAGE" && line.packageCostMinor === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "تكلفة الكرتونة مطلوبة" });
    }
    if (line.entryUnit === "CARTON" && line.costBasis === "LINE_TOTAL" && line.lineTotalMinor === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "إجمالي الكراتين مطلوب" });
    }
    if (line.entryUnit === "CARTON" && line.costBasis === "UNIT") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "إدخال الكراتين يحتاج تكلفة للكرتونة أو إجمالي السطر" });
    }
    if ((line.entryUnit === "PIECE" || line.entryUnit === "WEIGHT") && hasCartonData) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "بيانات الكرتونة لا تُرسل مع إدخال القطع أو الوزن" });
    }
    if ((line.entryUnit === "PIECE" || line.entryUnit === "WEIGHT") && line.costBasis === "PACKAGE") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "إدخال القطع أو الوزن لا يقبل تكلفة الكرتونة" });
    }
    if ((line.entryUnit === "PIECE" || line.entryUnit === "WEIGHT") && line.costBasis === "LINE_TOTAL" && line.lineTotalMinor === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "إجمالي سعر شراء السطر مطلوب" });
    }
  })).min(1).max(500),
});

export const createSupplierRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40).optional(),
  openingBalanceMinor: amountMinorSchema.default(0),
});

export const createCustomerRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40).optional(),
  creditLimitMinor: amountMinorSchema.default(0),
  openingBalanceMinor: amountMinorSchema.default(0),
});

export const partnerPaymentRequestSchema = z.object({
  partnerId: idSchema,
  amountMinor: amountMinorSchema.positive(),
  note: z.string().trim().min(3).max(250),
});

export const partnerDocumentKindSchema = z.enum(["SUPPLIER", "CUSTOMER"]);
export const createPartnerDocumentRequestSchema = z.object({
  partnerKind: partnerDocumentKindSchema,
  partnerId: idSchema,
  referenceNo: z.string().trim().max(80).optional(),
  goodsSummary: z.string().trim().min(3).max(500),
  goodsMinor: amountMinorSchema,
  feesMinor: amountMinorSchema.default(0),
  note: z.string().trim().max(250).optional(),
  dueOn: localDateSchema.optional(),
}).refine((value) => value.goodsMinor + value.feesMinor > 0, { message: "أدخل قيمة البضاعة أو الرسوم على الأقل" });

export const partnerDocumentPaymentRequestSchema = z.object({
  documentId: idSchema,
  amountMinor: amountMinorSchema.positive(),
  note: z.string().trim().min(3).max(250),
});

export const partnerDocumentListQuerySchema = z.object({
  partnerKind: partnerDocumentKindSchema,
  partnerId: idSchema,
});

export const stockCountPostRequestSchema = z.object({
  warehouseId: idSchema,
  productId: idSchema,
  actualQtyMilli: amountMinorSchema,
  reason: z.string().trim().min(3).max(250),
  expectedVersion: z.number().int().min(0),
});

/**
 * Reclassifies already available, un-dated stock into one dated lot.  It does
 * not add or remove inventory: the source lots are reduced by the same amount.
 */
export const stockExpiryRegistrationRequestSchema = z.object({
  productId: idSchema,
  qtyMilli: qtyMilliSchema,
  expiresOn: localDateSchema,
  lotCode: z.string().trim().min(1).max(80).optional(),
});

export const reportQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  branchId: idSchema.optional(),
  terminalId: idSchema.optional(),
  paymentMethod: paymentMethodSchema.optional(),
});

export const payrollEntryRequestSchema = z.object({
  employeeUserId: idSchema,
  payrollMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "اختر شهر راتب صحيح"),
  baseMinor: amountMinorSchema,
  overtimeMinor: amountMinorSchema.default(0),
  bonusMinor: amountMinorSchema.default(0),
  deductionMinor: amountMinorSchema.default(0),
  advanceMinor: amountMinorSchema.default(0),
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "WALLET"]),
  shiftId: idSchema.optional(),
  paidOn: localDateSchema,
  note: z.string().trim().max(250).optional(),
}).superRefine((value, context) => {
  if (value.baseMinor + value.overtimeMinor + value.bonusMinor - value.deductionMinor - value.advanceMinor < 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "الخصومات والسلف أكبر من استحقاق الموظف" });
  }
  if (value.paymentMethod === "CASH" && !value.shiftId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "حدد وردية مفتوحة عند دفع الراتب نقدًا من الدرج" });
  }
});

export const payrollListQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "اختر شهرًا صحيحًا"),
});

export const financialMonthCloseRequestSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "اختر شهرًا صحيحًا"),
  note: z.string().trim().max(250).optional(),
});

export const reportPdfExportRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  from: localDateSchema,
  to: localDateSchema,
  summary: z.object({
    netSalesMinor: signedAmountMinorSchema,
    netCogsMinor: signedAmountMinorSchema,
    grossProfitMinor: signedAmountMinorSchema,
    estimatedNetProfitMinor: signedAmountMinorSchema,
    returnsMinor: signedAmountMinorSchema,
    expensesMinor: signedAmountMinorSchema,
    damagedLossMinor: signedAmountMinorSchema,
    invoiceCount: z.number().int().min(0).max(10_000_000),
  }),
});

export interface ComprehensiveReportResponse {
  storeName: string;
  generatedAt: string;
  period: { from: string; to: string; timezone: "Africa/Cairo" };
  summary: {
    grossSalesMinor: number;
    discountsMinor: number;
    returnsMinor: number;
    netSalesMinor: number;
    netCogsMinor: number;
    grossProfitMinor: number;
    estimatedNetProfitMinor: number;
    expensesMinor: number;
    payrollMinor: number;
    operatingExpensesMinor: number;
    shopConsumptionMinor: number;
    damagedLossMinor: number;
    invoiceCount: number;
  };
  dailySales: Array<{ date: string; netSalesMinor: number; grossProfitMinor: number; invoiceCount: number }>;
  paymentMethods: Array<{ method: string; amountMinor: number; transactionCount: number }>;
  topProducts: Array<{ nameAr: string; category: string; netQtyMilli: number; netSalesMinor: number; grossProfitMinor: number }>;
  categories: Array<{ category: string; netSalesMinor: number; grossProfitMinor: number }>;
  expenseCategories: Array<{ category: string; amountMinor: number; itemCount: number }>;
  shopConsumptions: Array<{ date: string; itemName: string; category: string; amountMinor: number }>;
  payroll: Array<{ employeeName: string; month: string; netMinor: number; paymentMethod: string; paidOn: string }>;
  inventory: { inventoryValueMinor: number; lowStockCount: number; outOfStockCount: number; activeProductCount: number };
  insights: string[];
}

export const reorderListItemSchema = z.object({
  productId: idSchema,
  nameAr: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(80).nullable(),
  unitKind: unitKindSchema,
  availableQtyMilli: amountMinorSchema,
  reorderLevelMilli: amountMinorSchema.positive(),
  /** Computed from net sales during the preceding 28 days (7 delivery + 3 safety days). */
  smartReorderLevelMilli: amountMinorSchema,
  averageDailyDemandMilli: amountMinorSchema,
  shortageQtyMilli: amountMinorSchema,
  status: z.enum(["OUT_OF_STOCK", "BELOW_REORDER", "AT_REORDER"]),
});

export const reorderListDocumentRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  generatedAt: z.string().datetime(),
  items: z.array(reorderListItemSchema).max(2_000),
});

export const partnerListDocumentRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  title: z.string().trim().min(2).max(160),
  filterLabel: z.string().trim().min(1).max(240),
  generatedAt: z.string().datetime(),
  items: z.array(z.object({
    type: z.enum(["SUPPLIER", "CUSTOMER"]),
    name: z.string().trim().min(1).max(160),
    phone: z.string().trim().max(40).nullable(),
    balanceMinor: signedAmountMinorSchema,
    creditLimitMinor: amountMinorSchema.nullable(),
  })).max(10_000),
});

/** Local device preferences are deliberately separate from the store database.
 * They belong to this Windows cash-register only and contain no credentials. */
export const hardwareSettingsSchema = z.object({
  scannerMode: z.enum(["HID", "SERIAL"]).default("HID"),
  scannerTerminator: z.enum(["ENTER", "TAB"]).default("ENTER"),
  duplicateGuardMs: z.number().int().min(40).max(1_000).default(140),
  serialPortPath: z.string().trim().max(160).default(""),
  serialBaudRate: z.number().int().min(1_200).max(230_400).default(9_600),
  /** Windows printer dedicated to barcode labels; never used for receipts. */
  barcodePrinterName: z.string().trim().max(300).default("Xprinter XP-233B"),
  /** Native TSPL avoids browser/driver scaling for calibrated XP-233B labels. */
  labelPrintTransport: z.enum(["TSPL", "WINDOWS"]).default("TSPL"),
  labelPrinterModel: z.literal("XP-233B").default("XP-233B"),
  labelDpi: z.literal(203).default(203),
  /** Physical media values are deliberately user-calibrated, not inferred facts. */
  labelWidthMm: z.number().min(20).max(56).default(50),
  labelHeightMm: z.number().min(10).max(150).default(20),
  labelGapMm: z.number().min(0.5).max(10).default(2),
  labelSpeedMmPerSecond: z.number().min(25.4).max(127).default(50.8),
  labelDensity: z.number().int().min(0).max(15).default(8),
  labelDirection: z.union([z.literal(0), z.literal(1)]).default(1),
  labelBarcodeRenderMode: z.enum(["RASTER", "NATIVE_TSPL"]).default("RASTER"),
  labelOffsetXmm: z.number().min(-10).max(10).default(0),
  labelOffsetYmm: z.number().min(-10).max(10).default(0),
  labelMediaType: z.literal("GAP").default("GAP"),
  /** Batches stay unavailable until a physical test label is accepted. */
  labelCalibrationConfirmed: z.boolean().default(false),
  /**
   * Supported XP-233B label media.  Legacy small sizes remain accepted so an
   * existing terminal can load its old local settings, but the application
   * migrates them before printing retail barcodes.
   */
  labelPaperSize: z.enum(["20x10", "24x14", "30x20", "40x25", "40x30", "50x30", "50x50", "58x30", "58x40", "58x60"]).default("58x30"),
  /** Visual layout of the chosen barcode-label media. */
  labelTemplate: z.enum(["STANDARD", "PRICE_FOCUS", "COMPACT", "MICRO"]).default("STANDARD"),
  receiptPrinterName: z.string().trim().max(300).default("Xprinter XP-Q808K USB"),
  receiptPaperWidth: z.enum(["58", "80"]).default("80"),
  autoPrintReceipt: z.boolean().default(false),
  /** Number of customer receipt copies sent automatically after a completed sale. */
  receiptCopies: z.number().int().min(1).max(5).default(1),
  /** Cash drawers are driven through the receipt printer's RJ11 port using ESC/POS. */
  cashDrawerEnabled: z.boolean().default(false),
  /** The physical drawer cable may use either standard ESC/POS kick-out pin. */
  cashDrawerPin: z.enum(["2", "5"]).default("2"),
});

export const productLabelPrintRequestSchema = z.object({
  nameAr: z.string().trim().min(1).max(160),
  barcode: barcodeSchema,
  priceMinor: amountMinorSchema.positive(),
  copies: z.number().int().min(1).max(100).default(1),
  /** Keeps the price in the product record while omitting it from the printed sticker. */
  hidePrice: z.boolean().default(false),
});

export const productLabelBatchPrintRequestSchema = z.object({
  labels: z.array(productLabelPrintRequestSchema).min(1).max(20),
});

export const receiptBrandingSchema = z.object({
  logoDataUrl: z.union([
    z.literal(""),
    z.string().max(800_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  ]).default(""),
  receiptPhone: z.string().trim().max(40).default(""),
  whatsappPhone: z.string().trim().max(40).default(""),
  socialHandle: z.string().trim().max(120).default(""),
  receiptFooter: z.string().trim().max(180).default("شكراً لزيارتكم"),
});

export const receiptPrintRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  branding: receiptBrandingSchema.optional(),
  /** Manual reprints remain one copy unless the caller explicitly requests more. */
  copies: z.number().int().min(1).max(5).default(1),
  sale: z.object({
    saleId: idSchema,
    invoiceNo: z.string().trim().min(1).max(100),
    postedAt: z.string().min(1).max(80),
    subtotalMinor: signedAmountMinorSchema,
    discountMinor: amountMinorSchema,
    totalMinor: amountMinorSchema,
    paidMinor: amountMinorSchema,
    changeMinor: amountMinorSchema,
    lines: z.array(z.object({
      productId: idSchema,
    nameAr: z.string().trim().min(1).max(160),
    unitKind: unitKindSchema,
    saleUnit: saleUnitSchema.optional(),
    packageSize: z.number().int().min(2).optional(),
    qtyMilli: qtyMilliSchema,
      unitPriceMinor: amountMinorSchema,
      grossMinor: amountMinorSchema,
      discountMinor: amountMinorSchema,
      netMinor: amountMinorSchema,
      stockVersion: z.number().int().min(0),
    })).min(1).max(200),
  }),
});

/**
 * A delivery preparation slip is deliberately separate from a posted sale
 * receipt.  It may be printed after the owner confirms an online/Messenger
 * request, but it never means that cash was collected or inventory deducted.
 */
export const deliveryOrderPrintRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  copies: z.number().int().min(1).max(5).default(1),
  order: z.object({
    id: idSchema,
    source: customerOrderSourceSchema,
    customerName: z.string().trim().min(2).max(120),
    customerPhone: z.string().trim().min(6).max(30),
    deliveryAddress: z.string().trim().min(5).max(500),
    notes: z.string().trim().max(500).nullable(),
    createdAt: z.string().min(1).max(80),
    subtotalMinor: amountMinorSchema,
    deliveryFeeMinor: amountMinorSchema,
    totalMinor: amountMinorSchema,
    lines: z.array(z.object({
      productId: idSchema,
      nameAr: z.string().trim().min(1).max(160),
      unitKind: unitKindSchema,
      saleUnit: saleUnitSchema,
      salePackageSize: z.number().int().min(2).nullable(),
      qtyMilli: qtyMilliSchema,
      unitPriceMinor: amountMinorSchema,
      lineTotalMinor: amountMinorSchema,
    })).min(1).max(200),
  }),
});

export const apiErrorSchema = z.object({
  code: z.string(),
  messageAr: z.string(),
  requestId: z.string(),
  details: z.unknown().optional(),
});

export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;
export type OpenShiftRequest = z.infer<typeof openShiftRequestSchema>;
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type PostSaleRequest = z.infer<typeof postSaleRequestSchema>;
export type DeliveryOrderPrintRequest = z.infer<typeof deliveryOrderPrintRequestSchema>;
export type PaymentSettingsUpdate = z.infer<typeof paymentSettingsUpdateSchema>;
export type PaymentDeviceBinding = z.infer<typeof paymentDeviceBindingSchema>;
export type CreatePaymentIntent = z.infer<typeof createPaymentIntentSchema>;
export type SaleReturnRequest = z.infer<typeof saleReturnRequestSchema>;
export type PurchaseReceiptRequest = z.infer<typeof purchaseReceiptRequestSchema>;
export type StockCountPostRequest = z.infer<typeof stockCountPostRequestSchema>;
export type StockExpiryRegistrationRequest = z.infer<typeof stockExpiryRegistrationRequestSchema>;
export type CreateSupplierRequest = z.infer<typeof createSupplierRequestSchema>;
export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;
export type PartnerPaymentRequest = z.infer<typeof partnerPaymentRequestSchema>;
export type CreatePartnerDocumentRequest = z.infer<typeof createPartnerDocumentRequestSchema>;
export type PartnerDocumentPaymentRequest = z.infer<typeof partnerDocumentPaymentRequestSchema>;
export type ReportPdfExportRequest = z.infer<typeof reportPdfExportRequestSchema>;
export type ReorderListItem = z.infer<typeof reorderListItemSchema>;
export type ReorderListDocumentRequest = z.infer<typeof reorderListDocumentRequestSchema>;
export type PartnerListDocumentRequest = z.infer<typeof partnerListDocumentRequestSchema>;
export type HardwareSettings = z.infer<typeof hardwareSettingsSchema>;
export type ProductLabelPrintRequest = z.infer<typeof productLabelPrintRequestSchema>;
export type ProductLabelBatchPrintRequest = z.infer<typeof productLabelBatchPrintRequestSchema>;
export type ReceiptPrintRequest = z.infer<typeof receiptPrintRequestSchema>;
export type ReceiptBranding = z.infer<typeof receiptBrandingSchema>;

export const invoiceKindSchema = z.enum(["ALL", "SALE", "PURCHASE"]);
export type InvoiceKind = z.infer<typeof invoiceKindSchema>;

export const invoiceListQuerySchema = z.object({
  kind: invoiceKindSchema.default("ALL"),
  query: z.string().trim().max(160).optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  // Query strings arrive at Fastify as text. Coercion keeps the desktop URL
  // bridge and direct HTTP callers consistent while preserving the same bounds.
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

export const invoiceDetailQuerySchema = z.object({
  kind: z.enum(["SALE", "PURCHASE"]),
  id: idSchema,
});
export type InvoiceDetailQuery = z.infer<typeof invoiceDetailQuerySchema>;

export const invoiceLineSchema = z.object({
  productId: idSchema,
  nameAr: z.string(),
  unitKind: unitKindSchema,
  saleUnit: saleUnitSchema.optional(),
  packageSize: z.number().int().min(2).optional(),
  qtyMilli: qtyMilliSchema,
  unitPriceMinor: amountMinorSchema,
  totalMinor: amountMinorSchema,
  lotCode: z.string().nullable().optional(),
  expiresOn: z.string().nullable().optional(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceSummaryItemSchema = z.object({
  id: idSchema,
  kind: z.enum(["SALE", "PURCHASE"]),
  invoiceNo: z.string(),
  partyName: z.string(),
  partyPhone: z.string().nullable().optional(),
  itemCount: z.number().int().min(0),
  totalMinor: amountMinorSchema,
  discountMinor: amountMinorSchema.default(0),
  paidMinor: amountMinorSchema.default(0),
  supplyExpensesMinor: amountMinorSchema.default(0),
  paymentMethod: z.string().nullable().optional(),
  postedAt: z.string(),
  cashierOrReceiverName: z.string(),
});
export type InvoiceSummaryItem = z.infer<typeof invoiceSummaryItemSchema>;

export const invoiceDetailResponseSchema = z.object({
  id: idSchema,
  kind: z.enum(["SALE", "PURCHASE"]),
  invoiceNo: z.string(),
  partyName: z.string(),
  partyPhone: z.string().nullable().optional(),
  itemCount: z.number().int().min(0),
  totalMinor: amountMinorSchema,
  subtotalMinor: amountMinorSchema.optional(),
  discountMinor: amountMinorSchema.default(0),
  paidMinor: amountMinorSchema.default(0),
  changeMinor: amountMinorSchema.default(0),
  supplyExpensesMinor: amountMinorSchema.default(0),
  paymentMethod: z.string().nullable().optional(),
  postedAt: z.string(),
  cashierOrReceiverName: z.string(),
  lines: z.array(invoiceLineSchema),
});
export type InvoiceDetailResponse = z.infer<typeof invoiceDetailResponseSchema>;

export const purchaseReceiptPrintRequestSchema = z.object({
  storeName: z.string().trim().min(2).max(160),
  branding: receiptBrandingSchema.optional(),
  receipt: z.object({
    id: idSchema,
    invoiceNo: z.string().trim().min(1).max(100),
    supplierName: z.string().trim().min(1).max(160),
    supplierPhone: z.string().trim().max(40).nullable().optional(),
    postedAt: z.string().min(1).max(80),
    goodsMinor: amountMinorSchema,
    supplyExpensesMinor: amountMinorSchema,
    totalMinor: amountMinorSchema,
    receiverName: z.string().trim().min(1).max(160),
    lines: z.array(z.object({
      productId: idSchema,
      nameAr: z.string().trim().min(1).max(160),
      unitKind: unitKindSchema,
      qtyMilli: qtyMilliSchema,
      unitCostMinor: amountMinorSchema,
      goodsMinor: amountMinorSchema,
      lotCode: z.string().trim().max(100).nullable().optional(),
      expiresOn: localDateSchema.nullable().optional(),
    })).min(1).max(500),
  }),
});
export type PurchaseReceiptPrintRequest = z.infer<typeof purchaseReceiptPrintRequestSchema>;

export interface CatalogProduct {
  id: string;
  warehouseId: string;
  nameAr: string;
  description: string;
  category: string;
  unitKind: z.infer<typeof unitKindSchema>;
  /** Present for weighted items; omitted by older servers for backwards compatibility. */
  weightUnit?: z.infer<typeof weightUnitSchema>;
  /** Default supplier-carton content in base pieces. */
  purchasePackSize: number;
  /** An optional customer-facing package that may be sold whole or loose. */
  retailPackage?: {
    unitsPerPackage: number;
    packagePriceMinor: number;
    contentsUnit: z.infer<typeof retailPackageUnitSchema>;
    /** Omitted for the legacy/default package wording; STACK is explicit. */
    label?: z.infer<typeof retailPackageLabelSchema>;
  };
  priceMinor: number;
  cartonPriceMinor?: number;
  cartonContentsUnit?: z.infer<typeof retailPackageUnitSchema>;
  /** Available only to roles that may view internal costs/prices. */
  wholesalePriceMinor?: number;
  availableQtyMilli: number;
  /** Balance version captured when the editable workbook was exported. */
  stockVersion?: number;
  reorderLevelMilli: number;
  barcodes: string[];
  /** Barcode-specific selling unit; a carton scan must not be treated as one loose item. */
  barcodeMappings?: Array<{ barcode: string; saleUnit: z.infer<typeof saleUnitSchema> }>;
  /** Barcode whose imported catalog image is available in this local desktop installation. */
  imageBarcode?: string;
  version: number;
}

export interface WeightedProductLabel {
  barcode: string;
  productId: string;
  nameAr: string;
  weightUnit: z.infer<typeof weightUnitSchema>;
  qtyMilli: number;
  unitPriceMinor: number;
  totalMinor: number;
  createdAt: string;
  printCount: number;
  usedAt?: string;
}

export interface InventoryExcelExportItem {
  nameAr: string;
  category: string;
  barcode: string | null;
  unitKind: z.infer<typeof unitKindSchema>;
  weightUnit?: z.infer<typeof weightUnitSchema>;
  availableQtyMilli: number;
  priceMinor: number;
  createdAt: string;
}

export interface InventoryExcelExportResponse {
  storeName: string;
  generatedAt: string;
  items: InventoryExcelExportItem[];
}

/** Requested period is resolved by the server in Africa/Cairo time. */
export const inventoryPeriodicExportRequestSchema = z.object({
  period: inventoryReportPeriodSchema.default("MONTHLY"),
  /** Any day within the desired month, quarter, or year. Defaults to today in Cairo. */
  referenceDate: localDateSchema.optional(),
});
export type InventoryReportPeriod = z.infer<typeof inventoryReportPeriodSchema>;

export interface InventoryPeriodicSalesExportItem {
  nameAr: string;
  category: string;
  barcode: string | null;
  unitKind: z.infer<typeof unitKindSchema>;
  grossQtyMilli: number;
  returnedQtyMilli: number;
  netQtyMilli: number;
  grossSalesMinor: number;
  returnsMinor: number;
  netSalesMinor: number;
  averageUnitPriceMinor: number | null;
  availableQtyMilli: number;
  reorderLevelMilli: number;
}

export interface InventoryPeriodicReorderExportItem {
  nameAr: string;
  category: string;
  barcode: string | null;
  unitKind: z.infer<typeof unitKindSchema>;
  availableQtyMilli: number;
  reorderLevelMilli: number;
  shortageQtyMilli: number;
  priceMinor: number;
  status: "OUT_OF_STOCK" | "BELOW_REORDER" | "AT_REORDER";
}

/** Data used by the desktop app to create a locally saved periodic stock-audit Excel file. */
export interface InventoryPeriodicExcelExportResponse {
  storeName: string;
  generatedAt: string;
  period: InventoryReportPeriod;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  salesItems: InventoryPeriodicSalesExportItem[];
  reorderItems: InventoryPeriodicReorderExportItem[];
  totals: {
    soldProductCount: number;
    grossQtyMilli: number;
    returnedQtyMilli: number;
    netQtyMilli: number;
    grossSalesMinor: number;
    returnsMinor: number;
    netSalesMinor: number;
    outOfStockCount: number;
    belowReorderCount: number;
  };
}

/** Data used by the desktop app to create a locally saved product-price Excel file. */
export interface ProductExcelExportItem {
  nameAr: string;
  category: string;
  barcode: string | null;
  description?: string;
  unitKind: z.infer<typeof unitKindSchema>;
  /** The base unit selected for a weighted product. */
  weightUnit?: z.infer<typeof weightUnitSchema>;
  availableQtyMilli: number;
  /** Balance version captured when the editable workbook was exported. */
  stockVersion?: number;
  reorderLevelMilli: number;
  priceMinor: number;
  purchasePackSize?: number;
  cartonPriceMinor?: number;
  cartonContentsUnit?: z.infer<typeof retailPackageUnitSchema>;
  retailPackage?: {
    unitsPerPackage: number;
    packagePriceMinor: number;
    contentsUnit: z.infer<typeof retailPackageUnitSchema>;
    label?: z.infer<typeof retailPackageLabelSchema>;
  };
  barcodeMappings?: Array<{ barcode: string; saleUnit: z.infer<typeof saleUnitSchema> }>;
  /** Returned only for an authorized internal/wholesale export. */
  wholesalePriceMinor?: number;
}

export interface ProductExcelExportResponse {
  storeName: string;
  generatedAt: string;
  mode: "PUBLIC" | "INTERNAL";
  items: ProductExcelExportItem[];
}

export interface QuoteResponse {
  quoteId: string;
  expiresAt: string;
  lines: Array<{
    productId: string;
    manualItem?: boolean;
    nameAr: string;
    unitKind: z.infer<typeof unitKindSchema>;
    saleUnit: z.infer<typeof saleUnitSchema>;
    /** Number of loose pieces/bags in each sold package; absent for loose sales. */
    packageSize?: number;
    qtyMilli: number;
    unitPriceMinor: number;
    grossMinor: number;
    discountMinor: number;
    netMinor: number;
    stockVersion: number;
  }>;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}

export interface SaleResponse {
  saleId: string;
  invoiceNo: string;
  postedAt: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  lines: QuoteResponse["lines"];
}

export interface PosMetricsResponse {
  todaySalesMinor: number;
  todayInvoiceCount: number;
  totalProductsCount: number;
  todayCustomerCount: number;
}

export const ipcRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("config.get") }),
  z.object({ operation: z.literal("config.set"), payload: z.object({ serverUrl: z.string().url(), terminalId: idSchema.optional(), certificateFingerprint: z.string().max(256).default(""), deviceMode: z.enum(["PRIMARY", "SECONDARY"]).optional(), terminalRelayKey: z.string().trim().min(32).max(512).optional() }) }),
  z.object({ operation: z.literal("multi-terminal.join"), payload: multiTerminalJoinRequestSchema }),
  z.object({ operation: z.literal("multi-terminal.primary.enable"), payload: z.object({ enrollmentPin: z.string().regex(/^\d{6}$/) }) }),
  z.object({ operation: z.literal("cloudflare.connection.get") }),
  z.object({ operation: z.literal("cloudflare.connection.update"), payload: cloudflareConnectionUpdateSchema }),
  z.object({ operation: z.literal("cloud.migration.run"), payload: cloudMigrationRunSchema }),
  z.object({ operation: z.literal("servers.discover") }),
  z.object({ operation: z.literal("host.start") }),
  z.object({ operation: z.literal("host.recovery.restore") }),
  z.object({ operation: z.literal("health") }),
  z.object({ operation: z.literal("pos.metrics") }),
  z.object({ operation: z.literal("terminals.discover") }),
  z.object({ operation: z.literal("setup"), payload: setupRequestSchema }),
  z.object({ operation: z.literal("login"), payload: loginRequestSchema }),
  z.object({ operation: z.literal("logout") }),
  z.object({ operation: z.literal("catalog.list"), payload: z.object({
    query: z.string().max(160).optional(),
    category: z.string().max(100).optional(),
    unitKind: unitKindSchema.optional(),
    // A small, bounded page keeps the renderer responsive even when a store
    // has tens of thousands of products. Barcode lookups can still request a
    // single exact match without transferring the whole catalog.
    limit: z.number().int().min(1).max(200).optional(),
    // Opaque keyset cursor returned by the previous page.  This avoids the
    // increasingly expensive OFFSET scans that make deep catalogue browsing
    // slow once a store has tens of thousands of products.
    cursor: z.string().min(1).max(512).optional(),
  }) }),
  z.object({ operation: z.literal("products.reference.lookup"), payload: z.object({ barcode: z.string().trim().min(1).max(80) }) }),
  z.object({ operation: z.literal("products.barcode.generate") }),
  z.object({ operation: z.literal("products.barcode.attach"), payload: attachNumericBarcodeRequestSchema }),
  z.object({ operation: z.literal("weighted-labels.create"), payload: weightedLabelCreateRequestSchema }),
  z.object({ operation: z.literal("weighted-labels.list"), payload: z.object({ productId: idSchema.optional() }) }),
  z.object({ operation: z.literal("weighted-labels.resolve"), payload: z.object({ barcode: z.string().regex(/^\d{13}$/) }) }),
  z.object({ operation: z.literal("weighted-labels.mark-printed"), payload: weightedLabelMarkPrintedRequestSchema }),
  z.object({ operation: z.literal("products.create"), payload: createProductRequestSchema }),
  z.object({ operation: z.literal("products.price.update"), payload: updateProductPriceRequestSchema }),
  z.object({ operation: z.literal("products.update"), payload: updateProductRequestSchema }),
  z.object({ operation: z.literal("products.archive"), payload: archiveProductRequestSchema }),
  z.object({ operation: z.literal("products.export"), payload: productExportRequestSchema.optional() }),
  z.object({ operation: z.literal("products.sync-workbook.export"), payload: productExportRequestSchema.optional() }),
  z.object({ operation: z.literal("inventory.export-xlsx") }),
  z.object({ operation: z.literal("inventory.periodic-export-xlsx"), payload: inventoryPeriodicExportRequestSchema }),
  z.object({ operation: z.literal("products.import"), payload: z.object({ idempotencyKey: idSchema, request: productCsvImportRequestSchema }) }),
  z.object({ operation: z.literal("products.import-workbook"), payload: productWorkbookImportRequestSchema }),
  z.object({ operation: z.literal("sales.lookup"), payload: z.object({ invoiceNo: z.string().trim().min(1).max(80) }) }),
  z.object({ operation: z.literal("sales.return"), payload: z.object({ saleId: idSchema, idempotencyKey: idSchema, return: saleReturnRequestSchema }) }),
  z.object({ operation: z.literal("purchases.receive"), payload: z.object({ idempotencyKey: idSchema, receipt: purchaseReceiptRequestSchema }) }),
  z.object({ operation: z.literal("stock.count.post"), payload: stockCountPostRequestSchema }),
  z.object({ operation: z.literal("stock.movements"), payload: z.object({ productId: idSchema.optional() }) }),
  z.object({ operation: z.literal("stock.expiry"), payload: z.object({ days: z.number().int().min(0).max(365).default(30) }) }),
  z.object({ operation: z.literal("stock.expiry.export-xlsx"), payload: z.object({ days: z.number().int().min(0).max(365).default(30) }) }),
  z.object({ operation: z.literal("stock.reorder-list") }),
  z.object({ operation: z.literal("partners.suppliers.list") }),
  z.object({ operation: z.literal("partners.suppliers.create"), payload: createSupplierRequestSchema }),
  z.object({ operation: z.literal("partners.customers.list") }),
  z.object({ operation: z.literal("partners.customers.create"), payload: createCustomerRequestSchema }),
  z.object({ operation: z.literal("partners.customer.collect"), payload: z.object({ idempotencyKey: idSchema, payment: partnerPaymentRequestSchema }) }),
  z.object({ operation: z.literal("partners.supplier.pay"), payload: z.object({ idempotencyKey: idSchema, payment: partnerPaymentRequestSchema }) }),
  z.object({ operation: z.literal("partners.documents.list"), payload: partnerDocumentListQuerySchema }),
  z.object({ operation: z.literal("partners.documents.create"), payload: z.object({ idempotencyKey: idSchema, document: createPartnerDocumentRequestSchema }) }),
  z.object({ operation: z.literal("partners.documents.pay"), payload: z.object({ idempotencyKey: idSchema, payment: partnerDocumentPaymentRequestSchema }) }),
  z.object({ operation: z.literal("shifts.current") }),
  z.object({ operation: z.literal("shifts.open"), payload: openShiftRequestSchema }),
  z.object({ operation: z.literal("shifts.cash-movement"), payload: z.object({ shiftId: idSchema, movement: cashMovementRequestSchema }) }),
  z.object({ operation: z.literal("shop-consumptions.list"), payload: shopConsumptionListQuerySchema }),
  z.object({ operation: z.literal("payroll.list"), payload: payrollListQuerySchema }),
  z.object({ operation: z.literal("payroll.create"), payload: payrollEntryRequestSchema }),
  z.object({ operation: z.literal("financial-periods.close"), payload: financialMonthCloseRequestSchema }),
  z.object({ operation: z.literal("financial-periods.list") }),
  z.object({ operation: z.literal("shifts.close"), payload: z.object({ shiftId: idSchema }).and(closeShiftRequestSchema) }),
  z.object({ operation: z.literal("shifts.history"), payload: shiftHistoryQuerySchema }),
  z.object({ operation: z.literal("shifts.export-xlsx"), payload: shiftHistoryQuerySchema }),
  z.object({ operation: z.literal("store.info") }),
  z.object({ operation: z.literal("settings.branch.get") }),
  z.object({ operation: z.literal("settings.branch.update"), payload: branchSettingsRequestSchema }),
  z.object({ operation: z.literal("settings.data-reset"), payload: z.object({ confirmationCode: z.string().trim().regex(/^\d{6}$/) }) }),
  z.object({ operation: z.literal("payments.settings.get"), payload: z.object({ provider: z.enum(["KASHIER", "FAWRY"]).default("KASHIER") }).optional() }),
  z.object({ operation: z.literal("payments.settings.update"), payload: paymentSettingsUpdateSchema }),
  z.object({ operation: z.literal("payments.devices.list"), payload: z.object({ provider: z.enum(["KASHIER", "FAWRY"]).default("KASHIER") }).optional() }),
  z.object({ operation: z.literal("payments.devices.bind"), payload: paymentDeviceBindingSchema }),
  z.object({ operation: z.literal("payments.methods.refresh"), payload: z.object({ provider: z.enum(["KASHIER", "FAWRY"]).default("KASHIER") }).optional() }),
  z.object({ operation: z.literal("payments.intents.create"), payload: createPaymentIntentSchema }),
  z.object({ operation: z.literal("payments.intents.get"), payload: z.object({ intentId: idSchema }) }),
  z.object({ operation: z.literal("payments.intents.verify"), payload: z.object({ intentId: idSchema }) }),
  z.object({ operation: z.literal("payments.intents.cancel"), payload: z.object({ intentId: idSchema }) }),
  z.object({ operation: z.literal("payments.reconcile"), payload: z.object({ provider: z.enum(["KASHIER", "FAWRY"]).default("KASHIER") }).optional() }),
  z.object({ operation: z.literal("commerce.orders.list"), payload: z.object({ status: customerOrderStatusSchema.optional() }).optional() }),
  z.object({ operation: z.literal("commerce.orders.update"), payload: z.object({ orderId: idSchema }).and(commerceOrderStatusUpdateSchema) }),
  z.object({ operation: z.literal("users.list") }),
  z.object({ operation: z.literal("users.create"), payload: createUserRequestSchema }),
  z.object({ operation: z.literal("users.update"), payload: z.object({ userId: idSchema, update: updateUserRequestSchema }) }),
  z.object({ operation: z.literal("audit.list"), payload: z.object({ limit: z.number().int().min(1).max(200).default(100) }) }),
  z.object({ operation: z.literal("sales.reprint"), payload: z.object({ saleId: idSchema }) }),
  z.object({ operation: z.literal("backups.list") }),
  z.object({ operation: z.literal("backups.policy.get") }),
  z.object({ operation: z.literal("backups.choose-automatic-directory") }),
  z.object({ operation: z.literal("backups.run") }),
  z.object({ operation: z.literal("backups.choose-destination") }),
  z.object({ operation: z.literal("backups.import-from-file") }),
  z.object({ operation: z.literal("backups.verify"), payload: z.object({ backupId: idSchema }) }),
  z.object({ operation: z.literal("quotes.create"), payload: quoteRequestSchema }),
  z.object({ operation: z.literal("sales.post"), payload: z.object({ idempotencyKey: idSchema, sale: postSaleRequestSchema }) }),
  z.object({ operation: z.literal("operations.get"), payload: z.object({ requestId: idSchema }) }),
  z.object({ operation: z.literal("reports.summary"), payload: reportQuerySchema }),
  z.object({ operation: z.literal("reports.comprehensive"), payload: reportQuerySchema }),
  z.object({ operation: z.literal("reports.export-xlsx"), payload: reportQuerySchema }),
  z.object({ operation: z.literal("reports.print"), payload: reportPdfExportRequestSchema }),
  z.object({ operation: z.literal("reports.export-pdf"), payload: reportPdfExportRequestSchema }),
  z.object({ operation: z.literal("reorder-list.print"), payload: reorderListDocumentRequestSchema }),
  z.object({ operation: z.literal("reorder-list.export-pdf"), payload: reorderListDocumentRequestSchema }),
  z.object({ operation: z.literal("partners.export-pdf"), payload: partnerListDocumentRequestSchema }),
  z.object({ operation: z.literal("hardware.settings.get") }),
  z.object({ operation: z.literal("hardware.settings.save"), payload: hardwareSettingsSchema }),
  z.object({ operation: z.literal("hardware.settings.restore") }),
  z.object({ operation: z.literal("hardware.printers.list") }),
  z.object({ operation: z.literal("hardware.serial.list") }),
  z.object({ operation: z.literal("hardware.receipt.print"), payload: receiptPrintRequestSchema }),
  z.object({ operation: z.literal("hardware.delivery-order.print"), payload: deliveryOrderPrintRequestSchema }),
  z.object({ operation: z.literal("hardware.receipt.test") }),
  z.object({ operation: z.literal("hardware.drawer.open") }),
  z.object({ operation: z.literal("hardware.drivers.open-folder") }),
  z.object({ operation: z.literal("hardware.driver.install"), payload: z.object({ role: z.enum(["LABEL", "RECEIPT"]) }) }),
  z.object({ operation: z.literal("hardware.label.print"), payload: productLabelPrintRequestSchema }),
  z.object({ operation: z.literal("hardware.label.test") }),
  z.object({ operation: z.literal("hardware.label.calibrate") }),
  z.object({ operation: z.literal("hardware.label.batch.print"), payload: productLabelBatchPrintRequestSchema }),
  z.object({ operation: z.literal("invoices.list"), payload: invoiceListQuerySchema }),
  z.object({ operation: z.literal("invoices.get"), payload: invoiceDetailQuerySchema }),
  z.object({ operation: z.literal("hardware.purchase-receipt.print"), payload: purchaseReceiptPrintRequestSchema }),
  z.object({ operation: z.literal("invoices.purchase-receipt.export-pdf"), payload: purchaseReceiptPrintRequestSchema }),
]);

export type IpcRequest = z.infer<typeof ipcRequestSchema>;

export interface DiscoveredServer {
  protocol: "NABTA_DISCOVER_V1";
  name: string;
  host: string;
  apiPort: number;
  tls: boolean;
  certificateFingerprint?: string;
  serverUrl: string;
}
