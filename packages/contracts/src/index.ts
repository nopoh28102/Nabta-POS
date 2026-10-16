import { z } from "zod";

export const amountMinorSchema = z.number().int().min(0).max(9_000_000_000_000);
export const signedAmountMinorSchema = z.number().int().min(-9_000_000_000_000).max(9_000_000_000_000);
export const qtyMilliSchema = z.number().int().positive().max(9_000_000_000_000);
export const idSchema = z.string().uuid();
export const barcodeSchema = z.string().trim().min(1).max(80).regex(/^[^\r\n]+$/);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const roleSchema = z.enum(["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER"]);
export const unitKindSchema = z.enum(["PIECE", "WEIGHT"]);
export const paymentMethodSchema = z.enum(["CASH", "CARD", "CREDIT"]);
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
  priceMinor: amountMinorSchema.positive(),
  wholesalePriceMinor: amountMinorSchema.optional(),
  reorderLevelMilli: amountMinorSchema,
  barcodes: z.array(barcodeSchema).min(1).max(20),
  openingQtyMilli: amountMinorSchema.optional().default(0),
  openingUnitCostMinor: amountMinorSchema.optional().default(0),
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
  description: z.string().trim().max(4_000).default(""),
  priceMinor: amountMinorSchema,
  wholesalePriceMinor: amountMinorSchema.optional(),
  availableQtyMilli: amountMinorSchema,
  expectedStockVersion: z.number().int().min(0),
}).superRefine((value, context) => {
  if (value.priceMinor < 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "سعر البيع لا يمكن أن يكون سالباً" });
});

export const archiveProductRequestSchema = z.object({
  productId: idSchema,
});

export const productExportRequestSchema = z.object({
  mode: z.enum(["PUBLIC", "INTERNAL"]).default("PUBLIC"),
  query: z.string().trim().max(160).optional(),
  productIds: z.preprocess(
    (value) => typeof value === "string" ? value.split(",").filter(Boolean) : value,
    z.array(idSchema).min(1).max(250).optional(),
  ),
});

export const productCsvImportRequestSchema = z.object({
  csv: z.string().max(5_000_000),
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
  lines: z.array(z.object({ productId: idSchema, qtyMilli: qtyMilliSchema })).min(1).max(200),
  discountMinor: amountMinorSchema.default(0),
});

export const postSaleRequestSchema = z.object({
  terminalId: idSchema,
  shiftId: idSchema,
  quoteId: idSchema,
  customerId: idSchema.optional(),
  payments: z.array(z.object({
    method: paymentMethodSchema,
    amountMinor: amountMinorSchema,
    tenderedMinor: amountMinorSchema.optional(),
    reference: z.string().trim().max(120).optional(),
  })).min(1).max(4),
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
  lines: z.array(z.object({
    productId: idSchema,
    qtyMilli: qtyMilliSchema,
    unitCostMinor: amountMinorSchema,
    wholesalePriceMinor: amountMinorSchema.optional(),
    retailPriceMinor: amountMinorSchema.positive().optional(),
    lotCode: z.string().trim().max(100).optional(),
    expiresOn: localDateSchema.optional(),
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

export const reportQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  branchId: idSchema.optional(),
  terminalId: idSchema.optional(),
  paymentMethod: paymentMethodSchema.optional(),
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

export const reorderListItemSchema = z.object({
  productId: idSchema,
  nameAr: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(80).nullable(),
  unitKind: unitKindSchema,
  availableQtyMilli: amountMinorSchema,
  reorderLevelMilli: amountMinorSchema.positive(),
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
      qtyMilli: qtyMilliSchema,
      unitPriceMinor: amountMinorSchema,
      grossMinor: amountMinorSchema,
      discountMinor: amountMinorSchema,
      netMinor: amountMinorSchema,
      stockVersion: z.number().int().min(0),
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
export type SaleReturnRequest = z.infer<typeof saleReturnRequestSchema>;
export type PurchaseReceiptRequest = z.infer<typeof purchaseReceiptRequestSchema>;
export type StockCountPostRequest = z.infer<typeof stockCountPostRequestSchema>;
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
  priceMinor: number;
  /** Available only to roles that may view internal costs/prices. */
  wholesalePriceMinor?: number;
  availableQtyMilli: number;
  reorderLevelMilli: number;
  barcodes: string[];
  /** Barcode whose imported catalog image is available in this local desktop installation. */
  imageBarcode?: string;
  version: number;
}

export interface InventoryExcelExportItem {
  nameAr: string;
  category: string;
  barcode: string | null;
  unitKind: z.infer<typeof unitKindSchema>;
  availableQtyMilli: number;
  priceMinor: number;
  createdAt: string;
}

export interface InventoryExcelExportResponse {
  storeName: string;
  generatedAt: string;
  items: InventoryExcelExportItem[];
}

/** Data used by the desktop app to create a locally saved product-price Excel file. */
export interface ProductExcelExportItem {
  nameAr: string;
  category: string;
  barcode: string | null;
  unitKind: z.infer<typeof unitKindSchema>;
  availableQtyMilli: number;
  priceMinor: number;
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
    nameAr: string;
    unitKind: z.infer<typeof unitKindSchema>;
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

export const ipcRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("config.get") }),
  z.object({ operation: z.literal("config.set"), payload: z.object({ serverUrl: z.string().url(), terminalId: idSchema.optional(), certificateFingerprint: z.string().max(256).default("") }) }),
  z.object({ operation: z.literal("servers.discover") }),
  z.object({ operation: z.literal("host.start") }),
  z.object({ operation: z.literal("health") }),
  z.object({ operation: z.literal("terminals.discover") }),
  z.object({ operation: z.literal("setup"), payload: setupRequestSchema }),
  z.object({ operation: z.literal("login"), payload: loginRequestSchema }),
  z.object({ operation: z.literal("logout") }),
  z.object({ operation: z.literal("catalog.list"), payload: z.object({ query: z.string().max(160).optional(), category: z.string().max(100).optional() }) }),
  z.object({ operation: z.literal("products.reference.lookup"), payload: z.object({ barcode: z.string().trim().min(1).max(80) }) }),
  z.object({ operation: z.literal("products.barcode.generate") }),
  z.object({ operation: z.literal("products.create"), payload: createProductRequestSchema }),
  z.object({ operation: z.literal("products.price.update"), payload: updateProductPriceRequestSchema }),
  z.object({ operation: z.literal("products.update"), payload: updateProductRequestSchema }),
  z.object({ operation: z.literal("products.archive"), payload: archiveProductRequestSchema }),
  z.object({ operation: z.literal("products.export"), payload: productExportRequestSchema.optional() }),
  z.object({ operation: z.literal("inventory.export-xlsx") }),
  z.object({ operation: z.literal("products.import"), payload: z.object({ idempotencyKey: idSchema, request: productCsvImportRequestSchema }) }),
  z.object({ operation: z.literal("sales.lookup"), payload: z.object({ invoiceNo: z.string().trim().min(1).max(80) }) }),
  z.object({ operation: z.literal("sales.return"), payload: z.object({ saleId: idSchema, idempotencyKey: idSchema, return: saleReturnRequestSchema }) }),
  z.object({ operation: z.literal("purchases.receive"), payload: z.object({ idempotencyKey: idSchema, receipt: purchaseReceiptRequestSchema }) }),
  z.object({ operation: z.literal("stock.count.post"), payload: stockCountPostRequestSchema }),
  z.object({ operation: z.literal("stock.movements"), payload: z.object({ productId: idSchema.optional() }) }),
  z.object({ operation: z.literal("stock.expiry"), payload: z.object({ days: z.number().int().min(0).max(365).default(30) }) }),
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
  z.object({ operation: z.literal("shifts.close"), payload: z.object({ shiftId: idSchema }).and(closeShiftRequestSchema) }),
  z.object({ operation: z.literal("shifts.history"), payload: shiftHistoryQuerySchema }),
  z.object({ operation: z.literal("shifts.export-xlsx"), payload: shiftHistoryQuerySchema }),
  z.object({ operation: z.literal("store.info") }),
  z.object({ operation: z.literal("settings.branch.get") }),
  z.object({ operation: z.literal("settings.branch.update"), payload: branchSettingsRequestSchema }),
  z.object({ operation: z.literal("settings.data-reset"), payload: z.object({ confirmationCode: z.string().trim().regex(/^\d{6}$/) }) }),
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
  z.object({ operation: z.literal("reports.print"), payload: reportPdfExportRequestSchema }),
  z.object({ operation: z.literal("reports.export-pdf"), payload: reportPdfExportRequestSchema }),
  z.object({ operation: z.literal("reorder-list.print"), payload: reorderListDocumentRequestSchema }),
  z.object({ operation: z.literal("reorder-list.export-pdf"), payload: reorderListDocumentRequestSchema }),
  z.object({ operation: z.literal("partners.export-pdf"), payload: partnerListDocumentRequestSchema }),
  z.object({ operation: z.literal("hardware.settings.get") }),
  z.object({ operation: z.literal("hardware.settings.save"), payload: hardwareSettingsSchema }),
  z.object({ operation: z.literal("hardware.printers.list") }),
  z.object({ operation: z.literal("hardware.serial.list") }),
  z.object({ operation: z.literal("hardware.receipt.print"), payload: receiptPrintRequestSchema }),
  z.object({ operation: z.literal("hardware.receipt.test") }),
  z.object({ operation: z.literal("hardware.drawer.open") }),
  z.object({ operation: z.literal("hardware.drivers.open-folder") }),
  z.object({ operation: z.literal("hardware.driver.install"), payload: z.object({ role: z.enum(["LABEL", "RECEIPT"]) }) }),
  z.object({ operation: z.literal("hardware.label.print"), payload: productLabelPrintRequestSchema }),
  z.object({ operation: z.literal("hardware.label.test") }),
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
