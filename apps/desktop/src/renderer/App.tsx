import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  CatalogProduct,
  ComprehensiveReportResponse,
  DiscoveredServer,
  HardwareSettings,
  InvoiceDetailResponse,
  InvoiceKind,
  InvoiceSummaryItem,
  InventoryReportPeriod,
  PartnerListDocumentRequest,
  PosMetricsResponse,
  QuoteResponse,
  ReceiptBranding,
  ReorderListDocumentRequest,
  ReorderListItem,
  SaleResponse,
} from "@nabta/contracts";
import {
  formatMoney,
  formatQty,
  invoke,
  minorFromInput,
  type ApiFailure,
} from "./api";

function productUnitLabel(product: CatalogProduct): string {
  if (product.unitKind === "PIECE") return "قطعة";
  return product.weightUnit === "GRAM" ? "جرام"
    : product.weightUnit === "LITER" ? "لتر"
      : product.weightUnit === "MILLILITER" ? "ملليلتر"
        : "كيلو";
}

function productQuantityLabel(product: CatalogProduct, qtyMilli = product.availableQtyMilli): string {
  if (product.unitKind === "WEIGHT" && (product.weightUnit === "GRAM" || product.weightUnit === "MILLILITER")) {
    return `${new Intl.NumberFormat("ar-EG").format(qtyMilli)} ${product.weightUnit === "GRAM" ? "جرام" : "ملليلتر"}`;
  }
  return `${formatQty(qtyMilli, product.unitKind)} ${productUnitLabel(product)}`;
}

function productDisplayPriceMinor(product: CatalogProduct, priceMinor = product.priceMinor): number {
  return product.unitKind === "WEIGHT" && (product.weightUnit === "GRAM" || product.weightUnit === "MILLILITER")
    ? Math.round(priceMinor / 1000)
    : priceMinor;
}

function isSmallMeasuredUnit(weightUnit: CatalogProduct["weightUnit"]): boolean {
  return weightUnit === "GRAM" || weightUnit === "MILLILITER";
}

function measurementUnitLabel(weightUnit: CatalogProduct["weightUnit"]): string {
  return weightUnit === "GRAM" ? "جرام" : weightUnit === "MILLILITER" ? "ملليلتر" : weightUnit === "LITER" ? "لتر" : "كيلو";
}

/** A final price is only a faster way to derive the physical quantity from
 * the registered unit price; the resulting quantity is still what the stock
 * ledger deducts when the sale is posted. */
function parseWeightQuantityFromTotal(product: CatalogProduct, totalInput: string): number {
  const totalMinor = minorFromInput(totalInput);
  if (totalMinor <= 0 || product.priceMinor <= 0) throw new Error("أدخل إجمالي سعر صحيح بعد ضبط سعر الوحدة للصنف.");
  const quantity = Math.round((totalMinor * 1000) / product.priceMinor);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("لا يمكن استخراج وزن صحيح من هذا السعر.");
  return quantity;
}

function retailPackageLabel(product: CatalogProduct): string {
  return product.retailPackage?.label === "STACK" ? "عمود" : product.retailPackage?.label === "PACKET" ? "باكيت" : "عبوة";
}

type Screen =
  | "pos"
  | "products"
  | "weight-labels"
  | "inventory"
  | "reorder"
  | "partners"
  | "invoices"
  | "reports"
  | "shift"
  | "expenses"
  | "settings";

interface TaxSettings {
  enabled: boolean;
  ratePercent: number;
}
const DEFAULT_TAX_SETTINGS: TaxSettings = { enabled: false, ratePercent: 14 };
const TAX_SETTINGS_KEY = "nabta.tax-settings";

interface Config {
  serverUrl: string;
  terminalId?: string;
  certificateFingerprint: string;
  deviceMode?: "PRIMARY" | "SECONDARY";
  terminalRelayKey?: string;
}
interface CatalogPage {
  products: CatalogProduct[];
  hasMore: boolean;
  nextCursor?: string;
}
interface User {
  id: string;
  displayName: string;
  role: string;
  permissions: string[];
}
type ThemeMode = "dark" | "light";
interface Shift {
  id: string;
  terminalId: string;
  openingMinor: number;
  openedAt: string;
  expectedCashMinor: number;
}
interface ShiftHistoryItem {
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
}
interface CartLine {
  product: CatalogProduct;
  qtyMilli: number;
  /** Printed only on the current invoice; never saved in the catalogue or stock. */
  manualItem?: boolean;
  saleUnit?: "UNIT" | "PACKAGE" | "CARTON";
  weightedLabelBarcode?: string;
  weightedLabelUnitPriceMinor?: number;
  weightedLabelTotalMinor?: number;
  /** Exact cashier amount for an unlabelled weighed sale. */
  enteredTotalMinor?: number;
  /** Keeps independently priced weighed entries from being merged in the cart. */
  enteredWeightId?: string;
}
interface ShopConsumption {
  id: string;
  itemName: string;
  category: string;
  quantityNote: string | null;
  supplierName: string | null;
  consumedOn: string;
  note: string | null;
  amountMinor: number;
  cashierName: string;
}

function cartLineSaleUnit(line: CartLine): "UNIT" | "PACKAGE" | "CARTON" {
  return line.saleUnit ?? "UNIT";
}

function cartLineUnitPriceMinor(line: CartLine): number {
  if (line.weightedLabelUnitPriceMinor !== undefined) return line.weightedLabelUnitPriceMinor;
  if (cartLineSaleUnit(line) === "PACKAGE") return line.product.retailPackage!.packagePriceMinor;
  if (cartLineSaleUnit(line) === "CARTON") return line.product.cartonPriceMinor!;
  return line.product.priceMinor;
}

function cartLineTotalMinor(line: CartLine): number {
  if (line.weightedLabelTotalMinor !== undefined) return line.weightedLabelTotalMinor;
  if (line.enteredTotalMinor !== undefined) return line.enteredTotalMinor;
  if (cartLineSaleUnit(line) === "PACKAGE") {
    return (line.qtyMilli / (line.product.retailPackage!.unitsPerPackage * 1000)) * line.product.retailPackage!.packagePriceMinor;
  }
  if (cartLineSaleUnit(line) === "CARTON") {
    return (line.qtyMilli / (line.product.purchasePackSize * 1000)) * line.product.cartonPriceMinor!;
  }
  return Math.round((line.product.priceMinor * line.qtyMilli) / 1000);
}

function cartLineKey(line: CartLine): string {
  return line.weightedLabelBarcode
    ? `label:${line.weightedLabelBarcode}`
    : line.enteredWeightId
      ? `entered-weight:${line.enteredWeightId}`
      : line.manualItem
        ? `manual:${line.product.id}`
      : `product:${line.product.id}:${cartLineSaleUnit(line)}`;
}

function cartLineQuantityText(line: CartLine): string {
  const saleUnit = cartLineSaleUnit(line);
  if (saleUnit === "PACKAGE") return String(line.qtyMilli / (line.product.retailPackage!.unitsPerPackage * 1000));
  if (saleUnit === "CARTON") return String(line.qtyMilli / (line.product.purchasePackSize * 1000));
  if (line.product.unitKind === "PIECE") return String(line.qtyMilli / 1000);
  if (isSmallMeasuredUnit(line.product.weightUnit)) return String(line.qtyMilli);
  return (line.qtyMilli / 1000).toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function cartLineQuantityUnit(line: CartLine): string {
  const saleUnit = cartLineSaleUnit(line);
  if (saleUnit === "PACKAGE") return "عبوة";
  if (saleUnit === "CARTON") return "كرتونة";
  return productUnitLabel(line.product);
}

function parseManualCartQuantity(line: CartLine, rawValue: string): number {
  const normalized = rawValue.trim()
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[٫,]/g, ".");
  const saleUnit = cartLineSaleUnit(line);
  if (saleUnit === "PACKAGE" || saleUnit === "CARTON" || line.product.unitKind === "PIECE" || isSmallMeasuredUnit(line.product.weightUnit)) {
    if (!/^\d+$/.test(normalized)) throw new Error("أدخل عددًا صحيحًا أكبر من صفر.");
    const entered = Number(normalized);
    const multiplier = saleUnit === "PACKAGE"
      ? line.product.retailPackage!.unitsPerPackage * 1000
      : saleUnit === "CARTON"
        ? line.product.purchasePackSize * 1000
        : line.product.unitKind === "PIECE"
          ? 1000
          : 1;
    const quantity = entered * multiplier;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("الكمية غير صحيحة.");
    return quantity;
  }
  const quantity = qtyFromInput(normalized);
  if (quantity <= 0) throw new Error("أدخل كمية أكبر من صفر.");
  return quantity;
}

interface WeightedLabelResult {
  barcode: string;
  productId: string;
  nameAr: string;
  weightUnit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER";
  qtyMilli: number;
  unitPriceMinor: number;
  totalMinor: number;
  createdAt: string;
  printCount: number;
  usedAt?: string;
}
interface ReceiptLineDraft {
  productId: string;
  /** A barcode scanned on a supplier invoice before its product card exists. */
  pendingBarcode?: string;
  entryUnit: "PIECE" | "CARTON" | "WEIGHT";
  costBasis: "UNIT" | "PACKAGE" | "LINE_TOTAL";
  /** Number of base pieces in a carton; ignored when entryUnit is PIECE. */
  unitsPerPackage: string;
  /** A cashier-facing label only; stock remains in the product's base unit. */
  cartonContent?: "PIECE" | "PACK" | "BAG";
  qty: string;
  /** Total paid to the supplier for the entire line, never a per-unit cost. */
  cost: string;
  /** Selling price for one piece, pack, bag, kilogram, or gram as applicable. */
  retail: string;
  lot: string;
  expires: string;
}

const PURCHASE_RECEIPT_DRAFT_KEY = "nabta-purchase-receipt-draft-v1";
const EMPTY_RECEIPT_LINE = (): ReceiptLineDraft => ({
  productId: "", entryUnit: "PIECE", costBasis: "LINE_TOTAL", unitsPerPackage: "1", qty: "", cost: "", retail: "", lot: "", expires: "",
});
interface PurchaseReceiptDraft {
  lines: ReceiptLineDraft[];
  supplier: string;
  invoiceNo: string;
  expenses: string;
  issuedAt: string;
}
function loadPurchaseReceiptDraft(): PurchaseReceiptDraft {
  const fallback: PurchaseReceiptDraft = { lines: [EMPTY_RECEIPT_LINE()], supplier: "", invoiceNo: "", expenses: "0.00", issuedAt: new Date().toISOString() };
  try {
    const parsed = JSON.parse(localStorage.getItem(PURCHASE_RECEIPT_DRAFT_KEY) ?? "null") as Partial<PurchaseReceiptDraft> | null;
    if (!parsed || !Array.isArray(parsed.lines)) return fallback;
    return {
      lines: parsed.lines.length ? parsed.lines.map((line) => ({ ...EMPTY_RECEIPT_LINE(), ...line })) : [EMPTY_RECEIPT_LINE()],
      supplier: typeof parsed.supplier === "string" ? parsed.supplier : "",
      invoiceNo: typeof parsed.invoiceNo === "string" ? parsed.invoiceNo : "",
      expenses: typeof parsed.expenses === "string" ? parsed.expenses : "0.00",
      issuedAt: typeof parsed.issuedAt === "string" ? parsed.issuedAt : fallback.issuedAt,
    };
  } catch {
    return fallback;
  }
}
interface PurchasePriceAlert {
  productName: string;
  currentUnitCostMinor: number;
  cheaperUnitCostMinor: number;
  supplierName: string;
  postedAt: string;
}
interface Health {
  status: string;
  setupCompleted: boolean;
  version: string;
}
interface Partner {
  id: string;
  name: string;
  phone?: string | null;
  balance_minor: number;
  credit_limit_minor?: number;
}
interface Terminal {
  id: string;
  name: string;
}
interface ProductReference {
  barcode: string;
  nameAr: string;
  category: string;
  subcategory: string;
  size: string;
  manufacturer: string;
  description: string;
  imageUrl: string;
  notes: string;
}
interface ReportSummary {
  netSalesMinor: number;
  netCogsMinor: number;
  grossProfitMinor: number;
  estimatedNetProfitMinor: number;
  returnsMinor: number;
  expensesMinor: number;
  damagedLossMinor: number;
  invoiceCount: number;
}
interface InstalledPrinter {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
  description: string;
}
interface SerialDevice {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}
interface ReorderListResponse {
  generatedAt: string;
  items: ReorderListItem[];
  totals: { outOfStock: number; belowReorder: number; atReorder: number };
}
interface BranchSettings extends ReceiptBranding {
  name: string;
  storeName: string;
  creditSalesEnabled: boolean;
  preventExpiredSales: boolean;
}

const DRAFT_KEY = "nabta-cart-draft-v1";
const PENDING_KEY = "nabta-pending-sale-v1";
const PENDING_RECEIPT_SCAN_KEY = "nabta-pending-receipt-scan-v1";
const HELD_INVOICES_KEY = "nabta-held-invoices-v1";
const POS_SESSIONS_KEY = "nabta-pos-sessions-v1";

interface HeldInvoice {
  id: string;
  heldAt: string;
  cart: CartLine[];
  discount: string;
  customerId: string;
  totalMinor: number;
}
const THEME_KEY = "nabta-theme-mode";
const POS_GRID_PAGE_SIZE = 60;
const PRODUCTS_TABLE_PAGE_SIZE = 100;
const DEFAULT_HARDWARE: HardwareSettings = {
  scannerMode: "HID",
  scannerTerminator: "ENTER",
  duplicateGuardMs: 140,
  serialPortPath: "",
  serialBaudRate: 9600,
  barcodePrinterName: "Xprinter XP-233B",
  labelPrintTransport: "TSPL",
  labelPrinterModel: "XP-233B",
  labelDpi: 203,
  labelWidthMm: 50,
  labelHeightMm: 20,
  labelGapMm: 2,
  labelSpeedMmPerSecond: 50.8,
  labelDensity: 8,
  labelDirection: 1,
  labelBarcodeRenderMode: "RASTER",
  labelOffsetXmm: 0,
  labelOffsetYmm: 0,
  labelMediaType: "GAP",
  labelCalibrationConfirmed: false,
  labelPaperSize: "58x30",
  labelTemplate: "STANDARD",
  receiptPrinterName: "Xprinter XP-Q808K USB",
  receiptPaperWidth: "80",
  autoPrintReceipt: false,
  receiptCopies: 1,
  cashDrawerEnabled: false,
  cashDrawerPin: "2",
};

function savedTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const LABEL_PAPER_SIZES = [
  { value: "40x25", label: "40 × 25 مم", use: "ملصق صغير آمن لباركود EAN-13" },
  { value: "40x30", label: "40 × 30 مم", use: "صنف صغير مع سعر وباركود واضح" },
  { value: "50x30", label: "50 × 30 مم", use: "مقاس تجزئة شائع" },
  { value: "50x50", label: "50 × 50 مم", use: "اسم أكبر أو معلومات إضافية" },
  { value: "58x30", label: "58 × 30 مم — الموصى به للرول المركّب", use: "المقاس المطابق لاختبار XP-233B الحالي" },
  { value: "58x40", label: "58 × 40 مم", use: "للأسماء الطويلة أو الخط الأكبر" },
  { value: "58x60", label: "58 × 60 مم", use: "لبيانات أوضح ومعلومات إضافية" },
] as const;

const LABEL_TEMPLATES = [
  { value: "MICRO", label: "مصغّر 20 × 10", description: "اسم مختصر وسعر وباركود في مساحة صغيرة" },
  { value: "STANDARD", label: "تصميم الشيماء", description: "باركود كبير واسم/سعر بأسفل الملصق" },
  { value: "PRICE_FOCUS", label: "سعر بارز", description: "سعر كبير مناسب للعرض على الرف" },
  { value: "COMPACT", label: "مضغوط", description: "مناسب للملصقات الصغيرة" },
] as const;

function labelPaperSize(value: string): HardwareSettings["labelPaperSize"] {
  return LABEL_PAPER_SIZES.some((size) => size.value === value)
    ? value as HardwareSettings["labelPaperSize"]
    : "58x30";
}

function labelTemplate(value: string): HardwareSettings["labelTemplate"] {
  return LABEL_TEMPLATES.some((template) => template.value === value)
    ? value as HardwareSettings["labelTemplate"]
    : "STANDARD";
}

function errorMessage(error: unknown): string {
  return (
    (error as Partial<ApiFailure>)?.messageAr ??
    (error instanceof Error ? error.message : "تعذر تنفيذ العملية")
  );
}

function playScanTone(kind: "known" | "unknown"): void {
  try {
    const Audio =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Audio) return;
    const audio = new Audio();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = kind === "known" ? "sine" : "square";
    oscillator.frequency.value = kind === "known" ? 880 : 190;
    gain.gain.setValueAtTime(0.055, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      audio.currentTime + (kind === "known" ? 0.09 : 0.19),
    );
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + (kind === "known" ? 0.1 : 0.2));
  } catch {
    /* The operating system may block sound until the user has interacted. */
  }
}

function barcodeKind(barcode: string): string {
  if (/^\d{13}$/.test(barcode)) return "EAN-13";
  if (/^\d{8}$/.test(barcode)) return "EAN-8";
  if (/^\d{12}$/.test(barcode)) return "UPC-A";
  if (/^\d+$/.test(barcode)) return "باركود رقمي";
  return "Code 128 / نصي";
}

function Field(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

interface SearchableOption {
  value: string;
  label: string;
  searchText?: string;
}

function SearchableSelect({
  name,
  value,
  options,
  onChange,
  placeholder = "اكتب للبحث ثم اختر",
  required = false,
  emptyText = "لا توجد نتائج مطابقة.",
}: {
  name?: string;
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  emptyText?: string;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase("ar-EG");
  const digitsQuery = query.replace(/\D/g, "");
  const matches = useMemo(
    () =>
      options.filter((option) => {
        if (!normalizedQuery) return true;
        const text = `${option.label} ${option.searchText ?? ""}`.toLocaleLowerCase("ar-EG");
        const digitText = `${option.label} ${option.searchText ?? ""}`.replace(/\D/g, "");
        return text.includes(normalizedQuery) || (digitsQuery.length > 0 && digitText.includes(digitsQuery));
      }).slice(0, 12),
    [options, normalizedQuery, digitsQuery],
  );
  const displayValue = query || selected?.label || "";

  function choose(option: SearchableOption): void {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className="searchable-select">
      {name && <input type="hidden" name={name} value={value} />}
      <input
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={name ? `${name}-results` : undefined}
        value={displayValue}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        onFocus={() => {
          setQuery("");
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 130)}
        onChange={(event) => {
          setQuery(event.target.value);
          if (value) onChange("");
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && matches[activeIndex]) {
            event.preventDefault();
            choose(matches[activeIndex]!);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="searchable-results" id={name ? `${name}-results` : undefined} role="listbox">
          {matches.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={index === activeIndex ? "active" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              {option.label}
            </button>
          ))}
          {!matches.length && <p>{emptyText}</p>}
        </div>
      )}
    </div>
  );
}

function readLogoDataUrl(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("اختر شعارًا بصيغة PNG أو JPG أو WebP.");
  if (file.size > 550_000)
    throw new Error("حجم الشعار كبير. اختر صورة أصغر من 550 كيلوبايت.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذر قراءة ملف الشعار."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function printProductLabel(
  name: string,
  barcode: string,
  priceMinor: number,
  copies = 1,
  hidePrice = false,
): Promise<{ printerName: string }> {
  return invoke({
    operation: "hardware.label.print",
    payload: { nameAr: name, barcode, priceMinor, copies, hidePrice },
  });
}

/**
 * A live cashier workspace.  Unlike a held invoice, a workspace remains open
 * while the cashier serves another customer, so both carts can be continued
 * without re-entering products.
 */
interface PosSession {
  id: string;
  label: string;
  cart: CartLine[];
  discount: string;
  customerId: string;
  createdAt: string;
}

function shouldHidePriceOnProductLabel(product: CatalogProduct): boolean {
  return /فوم|foam/iu.test(`${product.nameAr} ${product.category}`);
}

function ManualConnectionSetup({
  initial,
  onReady,
}: {
  initial: Config | null;
  onReady: (config: Config, health: Health) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const payload = {
        serverUrl: String(data.get("serverUrl")),
        certificateFingerprint: String(data.get("fingerprint") ?? ""),
        ...(String(data.get("terminalId") ?? "").trim()
          ? { terminalId: String(data.get("terminalId")) }
          : {}),
      };
      const config = await invoke<Config>({ operation: "config.set", payload });
      const health = await invoke<Health>({ operation: "health" });
      onReady(config, health);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Centered
      title="ربط نبتة بخادم المتجر"
      subtitle="يُحفظ عنوان الخادم وبصمة شهادته على هذا الجهاز فقط."
    >
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="عنوان الخادم">
          <input
            name="serverUrl"
            defaultValue={initial?.serverUrl ?? "http://127.0.0.1:7443"}
            dir="ltr"
            required
          />
        </Field>
        <Field label="بصمة شهادة TLS">
          <input
            name="fingerprint"
            defaultValue={initial?.certificateFingerprint ?? ""}
            dir="ltr"
            placeholder="SHA256 fingerprint"
          />
        </Field>
        <Field label="معرّف نقطة البيع (إن كان الخادم مُعدًا)">
          <input
            name="terminalId"
            defaultValue={initial?.terminalId ?? ""}
            dir="ltr"
            placeholder="UUID"
          />
        </Field>
        <p className="hint full">
          الاتصال غير المشفّر مسموح فقط على هذا الجهاز أثناء التطوير. على شبكة
          المتجر يلزم HTTPS وبصمة مطابقة.
        </p>
        {error && (
          <div className="error full" role="alert">
            {error}
          </div>
        )}
        <button className="primary full" disabled={busy}>
          {busy ? "جارٍ الاختبار…" : "حفظ واختبار الاتصال"}
        </button>
      </form>
    </Centered>
  );
}

function ConnectionSetup({
  initial,
  onReady,
}: {
  initial: Config | null;
  onReady: (config: Config, health: Health) => void;
}): ReactNode {
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [hostStarting, setHostStarting] = useState(false);

  const discover = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (initial) {
        try {
          const health = await invoke<Health>({ operation: "health" });
          onReady(initial, health);
          return;
        } catch {
          /* Continue with LAN discovery when the saved server is unavailable. */
        }
      }
      const candidates = await invoke<DiscoveredServer[]>({
        operation: "servers.discover",
      });
      for (const candidate of candidates) {
        try {
          const config = await invoke<Config>({
            operation: "config.set",
            payload: {
              serverUrl: candidate.serverUrl,
              certificateFingerprint: candidate.certificateFingerprint ?? "",
              ...(initial?.terminalId
                ? { terminalId: initial.terminalId }
                : {}),
            },
          });
          const health = await invoke<Health>({ operation: "health" });
          onReady(config, health);
          return;
        } catch {
          /* Try the next discovered server. */
        }
      }
      setError(
        candidates.length
          ? "تم العثور على خادم، لكن تعذر التحقق من اتصاله."
          : "لم نعثر على خادم نبتة على الشبكة المحلية.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [initial, onReady]);

  useEffect(() => {
    void discover();
  }, [discover]);
  // The host task may need a moment to start after Windows finishes an install.
  // Retry quietly so the user does not have to keep pressing the button.
  useEffect(() => {
    if (manual || busy || !error) return;
    const timer = window.setTimeout(() => {
      void discover();
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [manual, busy, error, discover]);
  async function startLocalHost(): Promise<void> {
    setHostStarting(true);
    setError("");
    try {
      await invoke<{ started: boolean }>({ operation: "host.start" });
      window.setTimeout(() => {
        void discover();
      }, 1_500);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setHostStarting(false);
    }
  }
  if (manual)
    return <ManualConnectionSetup initial={initial} onReady={onReady} />;
  return (
    <Centered
      title="جارٍ البحث عن خادم نبتة"
      subtitle="سيتم الاتصال تلقائيًا بأي خادم نبتة موثوق على شبكة المتجر."
    >
      <div className="connection-discovery" aria-live="polite">
        {busy ? (
          <>
            <div className="spinner" />
            <p>جارٍ اكتشاف الخوادم المحلية…</p>
          </>
        ) : (
          <p>{error}</p>
        )}
        {!busy && (
          <button type="button" onClick={() => void discover()}>
            إعادة البحث
          </button>
        )}
        {!busy && (
          <button
            type="button"
            onClick={() => void startLocalHost()}
            disabled={hostStarting}
          >
            {hostStarting
              ? "جارٍ تشغيل الخادم…"
              : "تشغيل هذا الجهاز كخادم رئيسي"}
          </button>
        )}
        <button
          type="button"
          className="link-button"
          onClick={() => setManual(true)}
        >
          إعداد الاتصال يدويًا من هنا
        </button>
      </div>
    </Centered>
  );
}

function ConnectionSettings({
  initial,
  onBack,
}: {
  initial: Config;
  onBack?: () => void;
}): ReactNode {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const config = await invoke<Config>({
        operation: "config.set",
        payload: {
          serverUrl: String(data.get("serverUrl")),
          certificateFingerprint: String(data.get("fingerprint") ?? ""),
          ...(String(data.get("terminalId") ?? "").trim()
            ? { terminalId: String(data.get("terminalId")) }
            : {}),
        },
      });
      await invoke<Health>({ operation: "health" });
      setMessage(`تم حفظ الاتصال بالخادم ${config.serverUrl}.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHead
        title="إعدادات الاتصال"
        subtitle="الاتصال التلقائي يعمل افتراضيًا. استخدم هذه الصفحة عند الحاجة إلى تحديد خادم أو بصمة شهادة يدويًا."
        action={
          onBack && (
            <button type="button" onClick={onBack}>
              العودة
            </button>
          )
        }
      />
      <section className="panel settings-panel">
        <form className="form-grid" onSubmit={(event) => void save(event)}>
          <Field label="عنوان الخادم">
            <input
              name="serverUrl"
              defaultValue={initial.serverUrl}
              dir="ltr"
              required
            />
          </Field>
          <Field label="بصمة شهادة TLS">
            <input
              name="fingerprint"
              defaultValue={initial.certificateFingerprint}
              dir="ltr"
              placeholder="SHA256 fingerprint"
            />
          </Field>
          <Field label="معرّف نقطة البيع">
            <input
              name="terminalId"
              defaultValue={initial.terminalId ?? ""}
              dir="ltr"
              placeholder="UUID"
            />
          </Field>
          {message && (
            <div className="hint full" role="status">
              {message}
            </div>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? "جارٍ الحفظ والاختبار…" : "حفظ واختبار الاتصال"}
          </button>
        </form>
      </section>
    </>
  );
}

function OwnerSetup({ onDone }: { onDone: () => void }): ReactNode {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await invoke({
        operation: "setup",
        payload: {
          setupToken: String(data.get("setupToken")),
          storeName: String(data.get("storeName")),
          branchName: String(data.get("branchName")),
          ownerName: String(data.get("ownerName")),
          username: String(data.get("username")),
          password: String(data.get("password")),
          terminalName: String(data.get("terminalName")),
        },
      });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Centered
      title="إعداد المتجر لأول مرة"
      subtitle="لا يوجد حساب افتراضي. أنشئ المالك ونقطة البيع بكلمة مرور قوية."
    >
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="اسم المتجر">
          <input name="storeName" required minLength={2} />
        </Field>
        <Field label="اسم الفرع">
          <input name="branchName" defaultValue="الفرع الرئيسي" required />
        </Field>
        <Field label="اسم المالك">
          <input name="ownerName" required />
        </Field>
        <Field label="اسم المستخدم">
          <input name="username" autoComplete="username" required dir="ltr" />
        </Field>
        <Field label="كلمة المرور (12 حرفًا على الأقل)">
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>
        <Field label="اسم نقطة البيع">
          <input name="terminalName" defaultValue="كاشير 1" required />
        </Field>
        <Field label="رمز إعداد الخادم">
          <input
            name="setupToken"
            type="password"
            minLength={20}
            required
            dir="ltr"
          />
        </Field>
        {error && (
          <div className="error full" role="alert">
            {error}
          </div>
        )}
        <button className="primary full" disabled={busy}>
          {busy ? "جارٍ الإنشاء…" : "إنشاء المتجر والحساب"}
        </button>
      </form>
    </Centered>
  );
}

function Login({
  terminalId,
  onLogin,
  theme,
  onThemeChange,
}: {
  terminalId: string | undefined;
  onLogin: (user: User) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): ReactNode {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState(
    terminalId ?? "",
  );
  useEffect(() => {
    if (terminalId) return;
    void invoke<{ terminals: Terminal[] }>({ operation: "terminals.discover" })
      .then((result) => {
        setTerminals(result.terminals);
        setSelectedTerminalId(result.terminals[0]?.id ?? "");
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, [terminalId]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const activeTerminalId = terminalId ?? selectedTerminalId;
    if (!activeTerminalId) {
      setError("لا توجد نقطة بيع مفعّلة على الخادم.");
      return;
    }
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await invoke<{ user: User }>({
        operation: "login",
        payload: {
          username: String(data.get("username")),
          password: String(data.get("password")),
          terminalId: activeTerminalId,
        },
      });
      onLogin(response.user);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Centered
      title="مرحبًا بك في نبتة"
      subtitle="سجّل الدخول لفتح ورديتك وبدء البيع."
    >
      <div className="login-theme-row">
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </div>
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <Field label="اسم المستخدم">
          <input
            name="username"
            autoComplete="username"
            defaultValue="admin"
            required
            autoFocus
          />
        </Field>
        <Field label="كلمة المرور">
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            defaultValue="admin"
            required
          />
        </Field>
        {!terminalId && (
          <Field label="نقطة البيع">
            <SearchableSelect
              value={selectedTerminalId}
              onChange={setSelectedTerminalId}
              options={terminals.map((item) => ({ value: item.id, label: item.name }))}
              placeholder="ابحث عن نقطة البيع"
              required
            />
          </Field>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "جارٍ الدخول…" : "دخول"}
        </button>
      </form>
    </Centered>
  );
}

function ThemeToggle({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): ReactNode {
  const isLight = theme === "light";
  const nextTheme = isLight ? "dark" : "light";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={isLight}
      aria-label={isLight ? "تفعيل الوضع الليلي" : "تفعيل الوضع النهاري"}
      title={isLight ? "تفعيل الوضع الليلي" : "تفعيل الوضع النهاري"}
      onClick={() => onThemeChange(nextTheme)}
    >
      <span aria-hidden="true">{isLight ? "☾" : "☀"}</span>
      <span>{isLight ? "وضع ليلي" : "وضع نهاري"}</span>
    </button>
  );
}

function Centered({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}): ReactNode {
  return (
    <main className="centered">
      <section className="welcome-card">
        <div className="brand-lockup">
          <span className="leaf">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: 22, height: 22 }}
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
              <path d="M8 12h8M12 8v8" />
            </svg>
          </span>
          <b>نبتة</b>
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        {children}
      </section>
    </main>
  );
}

function renderCategoryIcon(categoryName: string): ReactNode {
  if (categoryName === "الكل") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </svg>
    );
  }
  if (
    categoryName.includes("مشروب") ||
    categoryName.includes("عصير") ||
    categoryName.includes("قهوة") ||
    categoryName.includes("شاي") ||
    categoryName.includes("ماء") ||
    categoryName.includes("مياه")
  ) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
        <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
        <line x1="6" y1="1" x2="6" y2="4" />
        <line x1="10" y1="1" x2="10" y2="4" />
        <line x1="14" y1="1" x2="14" y2="4" />
      </svg>
    );
  }
  if (
    categoryName.includes("مأكول") ||
    categoryName.includes("خفيف") ||
    categoryName.includes("سناك") ||
    categoryName.includes("شيبس") ||
    categoryName.includes("حلويات") ||
    categoryName.includes("شوكول")
  ) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 2v20M21 2v20M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20" />
      </svg>
    );
  }
  if (
    categoryName.includes("بقال") ||
    categoryName.includes("تموين") ||
    categoryName.includes("أغذية") ||
    categoryName.includes("طعام") ||
    categoryName.includes("أرز") ||
    categoryName.includes("زيت")
  ) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
    );
  }
  if (
    categoryName.includes("منزل") ||
    categoryName.includes("منظف") ||
    categoryName.includes("ورق") ||
    categoryName.includes("مناديل")
  ) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function ProductArt({ product }: { product: CatalogProduct }): ReactNode {
  const [hasError, setHasError] = useState(false);
  const showImage = Boolean(product.imageBarcode) && !hasError;

  return (
    <span className="product-art">
      {showImage ? (
        <img
          className="product-image"
          src={`nabta-media://product/${encodeURIComponent(product.imageBarcode!)}`}
          alt={product.nameAr}
          loading="lazy"
          onError={() => setHasError(true)}
        />
      ) : product.unitKind === "WEIGHT" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="product-fallback-icon"
        >
          <path d="M6 2h12l2 6H4L6 2z" />
          <rect x="3" y="8" width="18" height="13" rx="2" />
          <path d="M12 12v5M9 14h6" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="product-fallback-icon"
        >
          <rect x="2" y="7" width="20" height="14" rx="2" />
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
        </svg>
      )}
    </span>
  );
}

type ProductCreationMode = "PIECE" | "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" | "CARTON" | "PACKAGE" | "PLATE_CARTON";

function productEditorMode(product: CatalogProduct): ProductCreationMode {
  if (product.unitKind === "WEIGHT") return product.weightUnit ?? "KILOGRAM";
  if (product.cartonPriceMinor && product.retailPackage?.label === "STACK") return "PLATE_CARTON";
  if (product.cartonPriceMinor || (product.purchasePackSize >= 2 && product.cartonContentsUnit)) return "CARTON";
  if (product.retailPackage) return "PACKAGE";
  return "PIECE";
}

interface ProductCreationResult {
  product: CatalogProduct;
  mode: ProductCreationMode;
  entryUnit: "PIECE" | "CARTON" | "WEIGHT";
  quantity: string;
  /** The complete supplier-line cost, suitable for a purchase invoice line. */
  totalCost: string;
  /** Selling price in the product's actual selling unit. */
  retailPrice: string;
  purchasePackSize: number;
}

/**
 * The full product card used when a barcode is not yet registered.  Keeping this
 * beside the POS screen means a cashier or storekeeper can finish a product
 * without leaving the sale or supplier invoice they are currently entering.
 */
function ProductCreateModal({
  barcode: initialBarcode,
  initialName = "",
  products,
  refresh,
  canViewCost = true,
  stockTarget = "OPENING",
  title = "إضافة صنف",
  description,
  onClose,
  onCreated,
}: {
  barcode?: string | undefined;
  initialName?: string;
  products: CatalogProduct[];
  refresh: () => Promise<CatalogProduct[]>;
  canViewCost?: boolean;
  /** A supplier invoice receives stock later, so creating its product must not duplicate it. */
  stockTarget?: "OPENING" | "RECEIPT";
  title?: string;
  description?: ReactNode;
  onClose: () => void;
  onCreated: (result: ProductCreationResult) => void | Promise<void>;
}): ReactNode {
  const [mode, setMode] = useState<ProductCreationMode>("PIECE");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const categories = useMemo(
    () => [...new Set(products.map((product) => product.category))]
      .sort((a, b) => a.localeCompare(b, "ar")),
    [products],
  );

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    try {
      setSaving(true);
      const isWeighted = mode === "KILOGRAM" || mode === "GRAM" || mode === "LITER" || mode === "MILLILITER";
      const weightUnit = mode === "GRAM" ? "GRAM" : mode === "LITER" ? "LITER" : mode === "MILLILITER" ? "MILLILITER" : "KILOGRAM";
      const cartonCount = Number(data.get("openingCartons") || 0);
      const supportsLooseContainerStock = mode === "CARTON" || mode === "PLATE_CARTON";
      const looseUnits = supportsLooseContainerStock ? Number(data.get("openingLooseUnits") || 0) : 0;
      const looseStacks = mode === "PLATE_CARTON" ? Number(data.get("openingLooseStacks") || 0) : 0;
      const stackSize = mode === "PLATE_CARTON" ? Number(data.get("stackSize") || 0) : 0;
      const stacksPerCarton = mode === "PLATE_CARTON" ? Number(data.get("stacksPerCarton") || 0) : 0;
      const purchasePackSize = mode === "CARTON" || mode === "PACKAGE" || mode === "PLATE_CARTON"
        ? mode === "PLATE_CARTON" ? stacksPerCarton * stackSize : Number(data.get("purchasePackSize") || 0)
        : 1;
      const totalContainerUnits = mode === "PLATE_CARTON"
        ? cartonCount * purchasePackSize + looseStacks * stackSize + looseUnits
        : cartonCount * purchasePackSize + looseUnits;
      if (mode !== "PLATE_CARTON" && (mode === "CARTON" || mode === "PACKAGE") &&
        (!Number.isInteger(purchasePackSize) || purchasePackSize < 1 ||
          (supportsLooseContainerStock
            ? (!Number.isFinite(cartonCount) || cartonCount < 0 || !Number.isInteger(cartonCount * 2) || !Number.isInteger(looseUnits) || looseUnits < 0 || looseUnits >= purchasePackSize || !Number.isInteger(totalContainerUnits) || totalContainerUnits < 1)
            : (!Number.isInteger(cartonCount) || cartonCount < 1)))) {
        throw new Error("أدخل عدد الكراتين والفرط بصورة صحيحة؛ يسمح بنصف كرتونة فقط إذا كان الناتج عدد أكياس/عبوات صحيحًا، والفرط أقل من السعة.");
      }
      if (mode === "PLATE_CARTON") {
        const stackPriceMinor = minorFromInput(String(data.get("stackPrice") || "0"));
        if (!Number.isInteger(cartonCount) || cartonCount < 0 || !Number.isInteger(stacksPerCarton) || stacksPerCarton < 1 || !Number.isInteger(stackSize) || stackSize < 2 || !Number.isInteger(looseStacks) || looseStacks < 0 || looseStacks >= stacksPerCarton || !Number.isInteger(looseUnits) || looseUnits < 0 || looseUnits >= stackSize || !Number.isSafeInteger(totalContainerUnits) || totalContainerUnits < 1 || stackPriceMinor <= 0) {
          throw new Error("أدخل الكراتين والأعمدة والأكواب/الأطباق الفرط بصورة صحيحة. الكرتونة = عدد الأعمدة × سعة العمود.");
        }
      }
      const openingQuantity = String(data.get("openingQty") || "0").trim();
      const rawGramQty = Number(openingQuantity);
      if ((mode === "GRAM" || mode === "MILLILITER") && (!Number.isSafeInteger(rawGramQty) || rawGramQty < 0)) {
        throw new Error("أدخل عدد الجرامات كعدد صحيح.");
      }
      const qtyMilli = mode === "CARTON" || mode === "PACKAGE" || mode === "PLATE_CARTON"
        ? totalContainerUnits * 1000
        : mode === "GRAM" || mode === "MILLILITER" ? rawGramQty : qtyFromInput(openingQuantity);
      if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 0 ||
        (mode === "PIECE" && qtyMilli % 1000 !== 0)) {
        throw new Error("أدخل كمية صحيحة للصنف.");
      }
      const cartonTotalCostMinor = mode === "CARTON" || mode === "PACKAGE" || mode === "PLATE_CARTON"
        ? minorFromInput(String(data.get("cartonTotalWholesale") || "0"))
        : undefined;
      const enteredWholesaleMinor = canViewCost
        ? minorFromInput(String(data.get("wholesalePrice") || "0"))
        : 0;
      const wholesalePriceMinor = mode === "CARTON" || mode === "PACKAGE" || mode === "PLATE_CARTON"
        ? Math.floor((cartonTotalCostMinor! * 1000) / qtyMilli)
        : mode === "GRAM" || mode === "MILLILITER" ? enteredWholesaleMinor * 1000 : enteredWholesaleMinor;
      if (canViewCost && qtyMilli > 0 && wholesalePriceMinor <= 0) {
        throw new Error("أدخل سعر الجملة قبل حفظ كمية متاحة.");
      }
      const requestedBarcode = String(data.get("unitBarcode") ?? initialBarcode ?? "").trim();
      const generated = requestedBarcode
        ? undefined
        : await invoke<{ barcode: string }>({ operation: "products.barcode.generate" });
      const barcode = requestedBarcode || generated!.barcode;
      const packageBarcode = String(data.get("packageBarcode") ?? "").trim();
      const cartonBarcode = String(data.get("cartonBarcode") ?? "").trim();
      const cartonPriceMinor = mode === "CARTON" || mode === "PLATE_CARTON"
        ? (() => { const value = minorFromInput(String(data.get("cartonPrice") || "0")); return value > 0 ? value : undefined; })()
        : undefined;
      const barcodeMappings = [
        ...(barcode !== packageBarcode && (barcode !== cartonBarcode || !cartonPriceMinor) ? [{ barcode, saleUnit: "UNIT" as const }] : []),
        ...(packageBarcode ? [{ barcode: packageBarcode, saleUnit: "PACKAGE" as const }] : []),
        ...(cartonBarcode && cartonPriceMinor ? [{ barcode: cartonBarcode, saleUnit: "CARTON" as const }] : []),
      ];
      const retailPriceText = String(data.get(mode === "CARTON" || mode === "PLATE_CARTON" ? "piecePrice" : mode === "PACKAGE" ? "unitPrice" : "price") || "");
      const enteredPriceMinor = minorFromInput(retailPriceText);
      const packagePriceMinor = mode === "PACKAGE" ? minorFromInput(String(data.get("packagePrice") || "")) : undefined;
      const priceMinor = mode === "GRAM" || mode === "MILLILITER" ? enteredPriceMinor * 1000 : enteredPriceMinor;
      const created = await invoke<{ id: string }>({
        operation: "products.create",
        payload: {
          nameAr: String(data.get("nameAr") || "").trim(),
          category: String(data.get("category") || "").trim(),
          unitKind: isWeighted ? "WEIGHT" : "PIECE",
          weightUnit,
          priceMinor,
          wholesalePriceMinor,
          purchasePackSize,
          ...(mode === "PACKAGE" ? { retailPackage: { unitsPerPackage: purchasePackSize, packagePriceMinor: packagePriceMinor!, contentsUnit: String(data.get("packageContentsUnit")) as "PIECE" | "BAG", label: String(data.get("packageLabel")) as "PACKAGE" | "PACKET" } } : {}),
          ...(mode === "PLATE_CARTON" ? { retailPackage: { unitsPerPackage: stackSize, packagePriceMinor: minorFromInput(String(data.get("stackPrice") || "0")), contentsUnit: "PIECE" as const, label: "STACK" as const } } : {}),
          ...(cartonPriceMinor !== undefined ? { cartonPriceMinor } : {}),
          ...(mode === "CARTON" || mode === "PLATE_CARTON" ? { cartonContentsUnit: mode === "PLATE_CARTON" ? "PIECE" as const : String(data.get("cartonContentsUnit")) as "PIECE" | "BAG" } : {}),
          reorderLevelMilli: 0,
          barcodes: barcodeMappings.map((item) => item.barcode),
          barcodeMappings,
          openingQtyMilli: stockTarget === "OPENING" ? qtyMilli : 0,
          openingUnitCostMinor: stockTarget === "OPENING" && qtyMilli > 0 ? wholesalePriceMinor : 0,
          ...(stockTarget === "OPENING" && cartonTotalCostMinor !== undefined
            ? { openingTotalCostMinor: cartonTotalCostMinor }
            : {}),
        },
      });
      const catalog = await refresh();
      const product = catalog.find((item) => item.id === created.id) ??
        (await invoke<{ products: CatalogProduct[] }>({
          operation: "catalog.list", payload: { query: barcode, limit: 10 },
        })).products.find((item) => item.id === created.id);
      if (!product) throw new Error("حُفظ الصنف، لكن تعذر تحميله لإكمال العملية الحالية.");
      const receiptTotalCostMinor = cartonTotalCostMinor ??
        Math.round((wholesalePriceMinor * qtyMilli) / 1000);
      await onCreated({
        product,
        mode,
        entryUnit: mode === "CARTON" || mode === "PACKAGE" || mode === "PLATE_CARTON" ? "CARTON" : isWeighted ? "WEIGHT" : "PIECE",
        quantity: mode === "CARTON" || mode === "PACKAGE" || mode === "PLATE_CARTON" ? String(cartonCount) : openingQuantity,
        totalCost: (receiptTotalCostMinor / 100).toFixed(2),
        retailPrice: mode === "PACKAGE" ? (priceMinor / 100).toFixed(2) : retailPriceText,
        purchasePackSize,
      });
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal form-grid" onSubmit={(event) => void create(event)}>
        <h2 className="full">{title}</h2>
        <p className="hint full">{description ?? <>الباركود {initialBarcode ? <b dir="ltr">{initialBarcode}</b> : "سيُولَّد تلقائياً عند الحفظ"}. اختر طريقة البيع والاستلام المناسبة؛ لن يتم إرسال أمر طباعة باركود تلقائياً.</>}</p>
        {message && <p className="notice warning full">{message}</p>}
        <Field label="الاسم"><input name="nameAr" required autoFocus defaultValue={initialName} /></Field>
        <Field label="التصنيف"><input name="category" required list="nabta-inline-product-category-options" placeholder="اكتب أول حرفين لعرض التصنيفات" /></Field>
        <Field label="باركود القطعة / الكيس الفردي"><input name="unitBarcode" inputMode="numeric" dir="ltr" defaultValue={initialBarcode} placeholder="اتركه فارغًا لتوليد باركود" /></Field>
        <Field label="طريقة البيع والاستلام">
          <select value={mode} onChange={(event) => setMode(event.target.value as ProductCreationMode)}>
            <option value="KILOGRAM">كيلو</option><option value="GRAM">جرام</option><option value="LITER">لتر (منتج سائل)</option><option value="MILLILITER">ملليلتر (منتج سائل)</option><option value="PIECE">قطعة منفردة</option><option value="PACKAGE">عبوة (تباع عبوة أو فرط)</option><option value="CARTON">كرتونة/علبة (تباع فرط أو كرتونة)</option><option value="PLATE_CARTON">أطباق وفوم (طبق / عمود / كرتونة)</option>
          </select>
        </Field>
        {(mode === "KILOGRAM" || mode === "GRAM" || mode === "LITER" || mode === "MILLILITER") && <>
          <Field label={mode === "KILOGRAM" ? "الكمية المستلمة بالكيلو" : mode === "GRAM" ? "الكمية المستلمة بالجرام" : mode === "LITER" ? "الكمية المستلمة باللتر" : "الكمية المستلمة بالملليلتر"}><input name="openingQty" defaultValue="0" required inputMode={mode === "KILOGRAM" || mode === "LITER" ? "decimal" : "numeric"} dir="ltr" placeholder={mode === "KILOGRAM" || mode === "LITER" ? "مثال: 8 أو 0.250" : "مثال: 8000 أو 250"} /></Field>
          <Field label={`سعر البيع لكل ${mode === "KILOGRAM" ? "كيلو" : mode === "GRAM" ? "جرام" : mode === "LITER" ? "لتر" : "ملليلتر"}`}><input name="price" required inputMode="decimal" dir="ltr" /></Field>
          {canViewCost && <Field label={`سعر الجملة لكل ${mode === "KILOGRAM" ? "كيلو" : mode === "GRAM" ? "جرام" : mode === "LITER" ? "لتر" : "ملليلتر"}`}><input name="wholesalePrice" required defaultValue="0.00" inputMode="decimal" dir="ltr" /></Field>}
          <p className="hint full">يُحفظ الوزن بالجرام والسوائل بالملليلتر للحساب الدقيق.</p>
        </>}
        {mode === "PIECE" && <>
          <Field label="عدد القطع المستلمة"><input name="openingQty" defaultValue="0" required inputMode="numeric" dir="ltr" /></Field>
          <Field label="سعر البيع للقطعة"><input name="price" required inputMode="decimal" dir="ltr" /></Field>
          {canViewCost && <Field label="سعر الجملة للقطعة"><input name="wholesalePrice" required defaultValue="0.00" inputMode="decimal" dir="ltr" /></Field>}
        </>}
        {mode === "CARTON" && <>
          <Field label="عدد الكراتين المتاحة الآن (يسمح بـ 0.5)"><input name="openingCartons" required min="0" step="0.5" inputMode="decimal" dir="ltr" /></Field>
          <Field label="محتوى الكرتونة"><select name="cartonContentsUnit" defaultValue="BAG"><option value="BAG">أكياس</option><option value="PIECE">قطع</option></select></Field>
          <Field label="سعة الكرتونة الواحدة (عدد القطع / العبوات / الأكياس داخلها)"><input name="purchasePackSize" required min="1" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="عدد الأكياس / القطع الفرط خارج الكراتين"><input name="openingLooseUnits" required defaultValue="0" min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="إجمالي سعر الجملة للكراتين المستلمة"><input name="cartonTotalWholesale" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر بيع الكرتونة إن كانت تُباع كاملة (اختياري)"><input name="cartonPrice" min="0" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر البيع للقطعة / العبوة / الكيس"><input name="piecePrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="باركود الكرتونة الكامل (اختياري)"><input name="cartonBarcode" inputMode="numeric" dir="ltr" placeholder="يمسح ويبيع كرتونة كاملة" /></Field>
          <p className="hint full">اكتب الكراتين الكاملة أو النصفية ثم الفرط خارجها. مثال: سعة 12، كرتونة ونصف و3 أكياس = 1.5 كرتونة و3 فرط. لا يقبل النظام جزءًا من كيس أو قطعة.</p>
        </>}
        {mode === "PLATE_CARTON" && <>
          <Field label="عدد الكراتين المستلمة"><input name="openingCartons" required min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="عدد الأعمدة داخل الكرتونة (مثال: 40)"><input name="stacksPerCarton" required min="1" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="سعة العمود (عدد الأكواب أو الأطباق)"><input name="stackSize" required min="2" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="عدد الأعمدة الفرط خارج الكراتين"><input name="openingLooseStacks" required defaultValue="0" min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="عدد الأكواب أو الأطباق الفرط خارج الأعمدة"><input name="openingLooseUnits" required defaultValue="0" min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="إجمالي سعر الجملة للكراتين المستلمة"><input name="cartonTotalWholesale" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر بيع الكوب أو الطبق"><input name="piecePrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر بيع العمود"><input name="stackPrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="باركود الكرتونة الكامل (اختياري)"><input name="cartonBarcode" inputMode="numeric" dir="ltr" placeholder="يمسح ويبيع كرتونة كاملة" /></Field>
          <Field label="سعر بيع الكرتونة"><input name="cartonPrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <p className="hint full">مثال الأكواب: كرتونة بها 40 عمودًا، وكل عمود 50 كوبًا = 2000 كوب. تبيع الكرتونة أو العمود أو كوبًا/طبقًا مفردًا، ويُخصم دائمًا من نفس رصيد القطع.</p>
        </>}
        {mode === "PACKAGE" && <>
          <Field label="شكل البيع الكامل"><select name="packageLabel" defaultValue="PACKAGE"><option value="PACKAGE">عبوة</option><option value="PACKET">باكيت (كانز أو زجاجات)</option></select></Field>
          <Field label="عدد العبوات المستلمة"><input name="openingCartons" required min="1" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="محتوى العبوة"><select name="packageContentsUnit" defaultValue="PIECE"><option value="PIECE">قطع</option><option value="BAG">أكياس</option></select></Field>
          <Field label="عدد القطع / الأكياس داخل العبوة"><input name="purchasePackSize" required min="2" step="1" inputMode="numeric" dir="ltr" /></Field>
          <Field label="إجمالي سعر الجملة للعبوات المستلمة"><input name="cartonTotalWholesale" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر بيع العبوة"><input name="packagePrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر بيع الكيس أو القطعة (فرط)"><input name="unitPrice" required min="0.01" inputMode="decimal" dir="ltr" placeholder="السعر المُعلن للوحدة" /></Field>
          <Field label="باركود العبوة الكامل (اختياري)"><input name="packageBarcode" inputMode="numeric" dir="ltr" placeholder="يمسح ويبيع عبوة كاملة" /></Field>
          <p className="hint full">سعر العبوة الكاملة وسعر الكيس أو القطعة مستقلان؛ اكتب السعر المُعلن لكلٍ منهما. في نقطة البيع يمكنك اختيار بيع عبوة كاملة أو البيع فرطاً بالسعر الذي أدخلته.</p>
        </>}
        <datalist id="nabta-inline-product-category-options">{categories.map((category) => <option key={category} value={category} />)}</datalist>
        <div className="modal-actions full"><button type="button" disabled={saving} onClick={onClose}>إلغاء</button><button className="primary" disabled={saving}>{saving ? "جارٍ الحفظ…" : "حفظ"}</button></div>
      </form>
    </div>
  );
}

function PosScreen({
  products,
  shift,
  online,
  refreshProducts,
  lookupProducts,
  refreshShift,
  storeName = "نبتة",
  branding,
  onOpenShift,
  canViewCost = true,
  onEditProductByQuery = () => undefined,
  onPurchaseScan = (barcode: string) =>
    window.dispatchEvent(
      new CustomEvent("nabta:purchase-scan", { detail: barcode }),
    ),
  globalSearch = "",
  posMetrics = null,
  refreshPosMetrics,
  taxSettings = DEFAULT_TAX_SETTINGS,
}: {
  products: CatalogProduct[];
  shift: Shift | null;
  online: boolean;
  /** Reloads the complete cached catalog after a stock-changing operation. */
  refreshProducts: () => Promise<CatalogProduct[]>;
  /** Looks up a barcode without replacing the on-screen catalog. */
  lookupProducts: (query: string, cursor?: string) => Promise<CatalogPage>;
  refreshShift: () => Promise<void>;
  storeName: string;
  branding?: ReceiptBranding | undefined;
  onOpenShift: () => void;
  canViewCost?: boolean;
  onEditProductByQuery?: (query: string) => void;
  onPurchaseScan?: (barcode: string) => void;
  globalSearch?: string;
  posMetrics?: PosMetricsResponse | null;
  refreshPosMetrics?: () => Promise<PosMetricsResponse | null>;
  taxSettings?: TaxSettings;
}): ReactNode {
  const [activePosSessionId, setActivePosSessionId] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(POS_SESSIONS_KEY) ?? "[]") as PosSession[];
      return stored[0]?.id ?? "primary";
    } catch {
      return "primary";
    }
  });
  const [cart, setCart] = useState<CartLine[]>(() => {
    try {
      const sessions = JSON.parse(localStorage.getItem(POS_SESSIONS_KEY) ?? "[]") as PosSession[];
      if (sessions[0]) return sessions[0].cart;
      return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "[]") as CartLine[];
    } catch {
      return [];
    }
  });
  const [posSessions, setPosSessions] = useState<PosSession[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(POS_SESSIONS_KEY) ?? "[]") as PosSession[];
      if (stored.length) return stored;
    } catch {
      // The legacy single-cart draft below remains a safe migration fallback.
    }
    let legacyCart: CartLine[] = [];
    try {
      legacyCart = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "[]") as CartLine[];
    } catch {
      legacyCart = [];
    }
    return [{
      id: "primary",
      label: "العميل 1",
      cart: legacyCart,
      discount: "0.00",
      customerId: "",
      createdAt: new Date().toISOString(),
    }];
  });
  const [heldInvoices, setHeldInvoices] = useState<HeldInvoice[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HELD_INVOICES_KEY) ?? "[]") as HeldInvoice[];
    } catch {
      return [];
    }
  });
  const [showHeldModal, setShowHeldModal] = useState(false);
  const [cartSaleTab, setCartSaleTab] = useState<"direct" | "customer">("direct");
  const [cartQuantityDrafts, setCartQuantityDrafts] = useState<Record<string, string>>({});
  const [sortOption, setSortOption] = useState<"default" | "price-asc" | "price-desc" | "name-asc">("default");
  const [filterOption, setFilterOption] = useState<"all" | "in-stock" | "weight-only">("all");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>(products);
  const [catalogSearching, setCatalogSearching] = useState(false);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const [nextCatalogCursor, setNextCatalogCursor] = useState<string | null>(null);
  const [category, setCategory] = useState("الكل");
  const [catalogPage, setCatalogPage] = useState(0);
  const [discount, setDiscount] = useState(() => {
    try {
      return (JSON.parse(localStorage.getItem(POS_SESSIONS_KEY) ?? "[]") as PosSession[])[0]?.discount ?? "0.00";
    } catch { return "0.00"; }
  });
  /** Cashier-only aid: it is never submitted as an invoice line or payment value. */
  const [cashReceived, setCashReceived] = useState("");
  const [dialog, setDialog] = useState<{
    quote: QuoteResponse;
    method: "CASH" | "CARD" | "MIXED" | "CREDIT" | "KASHIER_POS_CARD" | "FAWRY_REFERENCE";
  } | null>(null);
  const [electronicIntent, setElectronicIntent] = useState<{
    intentId: string;
    status: string;
    amountMinor: number;
    merchantOrderId: string;
    deviceSerialNo?: string | null;
  } | null>(null);
  const [customers, setCustomers] = useState<Partner[]>([]);
  const [customerId, setCustomerId] = useState(() => {
    try {
      return (JSON.parse(localStorage.getItem(POS_SESSIONS_KEY) ?? "[]") as PosSession[])[0]?.customerId ?? "";
    } catch { return ""; }
  });
  const [weightTarget, setWeightTarget] = useState<CatalogProduct | null>(null);
  const [weightTotalInput, setWeightTotalInput] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [packageTarget, setPackageTarget] = useState<CatalogProduct | null>(null);
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<SaleResponse | null>(null);
  const [unknownBarcode, setUnknownBarcode] = useState("");
  const [newProductBarcode, setNewProductBarcode] = useState("");
  const [newProductName, setNewProductName] = useState("");
  const [quickSaleProductOpen, setQuickSaleProductOpen] = useState(false);
  const [quickSaleProductSaving, setQuickSaleProductSaving] = useState(false);
  const [quickSaleProductError, setQuickSaleProductError] = useState("");
  const [pendingScan, setPendingScan] = useState("");
  const [salesSheetOpen, setSalesSheetOpen] = useState(() => cart.length > 0);
  const [hardware, setHardware] = useState<HardwareSettings>(DEFAULT_HARDWARE);
  const [paymentPreparing, setPaymentPreparing] = useState(false);
  const [salePosting, setSalePosting] = useState(false);
  const [receiptPrinting, setReceiptPrinting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogRequestRef = useRef(0);
  /**
   * State updates are asynchronous, while USB scanners can send the next
   * barcode immediately.  Keep this ref in sync so the next scan can safely
   * complete an unanswered package choice as one loose unit.
   */
  const packageTargetRef = useRef<CatalogProduct | null>(null);
  /** Serializes scanner input so rapid scans cannot overtake each other. */
  const scanQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scanHandlerRef = useRef<
    (barcode: string, source: "HID" | "SERIAL") => Promise<void>
  >(async () => undefined);
  const recentScanRef = useRef<{ barcode: string; at: number } | null>(null);
  // Refs change synchronously, unlike React state.  They close the small gap
  // between two very fast clicks before the disabled button is re-rendered.
  const paymentPreparingRef = useRef(false);
  const salePostingRef = useRef(false);
  const receiptPrintingRef = useRef(false);
  const cashReceivedMinor = useMemo(() => {
    try {
      return minorFromInput(cashReceived.trim() || "0");
    } catch {
      return 0;
    }
  }, [cashReceived]);
  const cashChangeMinor = dialog?.method === "CASH"
    ? cashReceivedMinor - dialog.quote.totalMinor
    : null;
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(cart));
    setPosSessions((sessions) => sessions.map((session) => session.id === activePosSessionId
      ? { ...session, cart, discount, customerId }
      : session));
  }, [activePosSessionId, cart, customerId, discount]);
  useEffect(() => {
    localStorage.setItem(POS_SESSIONS_KEY, JSON.stringify(posSessions));
  }, [posSessions]);
  useEffect(() => {
    void invoke<Partner[]>({ operation: "partners.customers.list" })
      .then(setCustomers)
      .catch(() => setCustomers([]));
  }, []);
  useEffect(() => {
    void invoke<HardwareSettings>({ operation: "hardware.settings.get" })
      .then(setHardware)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { key: string };
      void invoke<{ status: "POSTED" | "PENDING" | "NOT_FOUND" }>({
        operation: "operations.get",
        payload: { requestId: pending.key },
      })
        .then((result) => {
          if (result.status === "POSTED") {
            localStorage.removeItem(PENDING_KEY);
            localStorage.removeItem(DRAFT_KEY);
            setCart([]);
            setNotice("تم تأكيد العملية المعلّقة من الخادم؛ لم نكرر الفاتورة.");
          } else if (result.status === "PENDING")
            setNotice(
              "توجد عملية بيع معلّقة؛ لن نعيد إرسالها حتى يجيب الخادم.",
            );
          else
            setNotice(
              "لم يعثر الخادم على العملية المعلّقة؛ راجع السلة قبل إعادة المحاولة.",
            );
        })
        .catch(() =>
          setNotice(
            "تعذر الاستعلام عن عملية معلّقة؛ السلة محفوظة ولن تصدر فاتورة دون اتصال.",
          ),
        );
    } catch {
      localStorage.removeItem(PENDING_KEY);
    }
  }, []);
  const categories = useMemo(
    () => ["الكل", ...new Set(products.map((product) => product.category))],
    [products],
  );
  // Search and browsing stay server-backed. The renderer only holds a small
  // page, even when the store has tens of thousands of items.
  useEffect(() => {
    const normalized = query.trim();
    let cancelled = false;
    const requestId = ++catalogRequestRef.current;
    setCatalogPage(0);
    setCatalogSearching(true);
    const timer = window.setTimeout(() => {
      void lookupProducts(normalized)
        .then((next) => {
          if (cancelled || requestId !== catalogRequestRef.current) return;
          setSearchResults(next.products);
          setCatalogHasMore(next.hasMore);
          setNextCatalogCursor(next.nextCursor ?? null);
        })
        .catch(() => {
          if (cancelled || requestId !== catalogRequestRef.current) return;
          setSearchResults([]);
          setCatalogHasMore(false);
          setNextCatalogCursor(null);
        })
        .finally(() => {
          if (!cancelled && requestId === catalogRequestRef.current) setCatalogSearching(false);
        });
    }, normalized ? 140 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lookupProducts, products, query]);
  useEffect(() => {
    if (globalSearch) {
      setQuery(globalSearch);
    }
  }, [globalSearch]);

  const filteredProducts = useMemo(() => {
    let list = searchResults.filter(
      (product) => category === "الكل" || product.category === category,
    );
    if (filterOption === "in-stock") {
      list = list.filter((p) => p.availableQtyMilli > 0);
    } else if (filterOption === "weight-only") {
      list = list.filter((p) => p.unitKind === "WEIGHT");
    }
    const stockFirst = (left: CatalogProduct, right: CatalogProduct): number =>
      Number(right.availableQtyMilli > 0) - Number(left.availableQtyMilli > 0);
    if (sortOption === "price-asc") {
      list = [...list].sort((a, b) => stockFirst(a, b) || a.priceMinor - b.priceMinor);
    } else if (sortOption === "price-desc") {
      list = [...list].sort((a, b) => stockFirst(a, b) || b.priceMinor - a.priceMinor);
    } else if (sortOption === "name-asc") {
      list = [...list].sort((a, b) => stockFirst(a, b) || a.nameAr.localeCompare(b.nameAr, "ar"));
    } else {
      // Keep the server relevance order inside each group, but always put
      // sellable stock in front of unavailable search matches.
      list = [...list].sort(stockFirst);
    }
    return list;
  }, [category, filterOption, searchResults, sortOption]);
  const searchSuggestions = useMemo(() => {
    if (!query.trim()) return [];
    return [...searchResults]
      .sort((left, right) => Number(right.availableQtyMilli > 0) - Number(left.availableQtyMilli > 0))
      .slice(0, 7);
  }, [query, searchResults]);

  const visible = filteredProducts;
  const catalogPageCount = Math.max(
    1,
    Math.ceil(visible.length / POS_GRID_PAGE_SIZE) + (catalogHasMore ? 1 : 0),
  );
  const activeCatalogPage = Math.min(catalogPage, catalogPageCount - 1);
  const visiblePage = visible.slice(
    activeCatalogPage * POS_GRID_PAGE_SIZE,
    (activeCatalogPage + 1) * POS_GRID_PAGE_SIZE,
  );
  useEffect(() => {
    if (!catalogHasMore || !nextCatalogCursor || catalogSearching) return;
    if (activeCatalogPage * POS_GRID_PAGE_SIZE < visible.length) return;
    let cancelled = false;
    setCatalogSearching(true);
    void lookupProducts(query.trim(), nextCatalogCursor)
      .then((next) => {
        if (cancelled) return;
        setSearchResults((current) => [...current, ...next.products]);
        setCatalogHasMore(next.hasMore);
        setNextCatalogCursor(next.nextCursor ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogHasMore(false);
          setNextCatalogCursor(null);
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogSearching(false);
      });
    return () => { cancelled = true; };
  }, [activeCatalogPage, catalogHasMore, catalogSearching, lookupProducts, nextCatalogCursor, query, visible.length]);
  useEffect(() => setCatalogPage(0), [query, category, filterOption, sortOption]);
  const subtotal = cart.reduce((sum, line) => sum + cartLineTotalMinor(line), 0);
  const discountMinor = (() => {
    try {
      return minorFromInput(discount);
    } catch {
      return 0;
    }
  })();
  const discountedSubtotal = Math.max(0, subtotal - discountMinor);
  const taxMinor =
    taxSettings?.enabled && (taxSettings.ratePercent ?? 0) > 0
      ? Math.round(discountedSubtotal * (taxSettings.ratePercent / 100))
      : 0;
  const grandTotal = discountedSubtotal + taxMinor;
  const weightPreview = useMemo(() => {
    if (!weightTarget) return null;
    try {
      const totalMinor = minorFromInput(weightTotalInput);
      const qtyMilli = parseWeightQuantityFromTotal(weightTarget, weightTotalInput);
      return {
        qtyMilli,
        // Keep the cashier's final amount exactly as entered. The derived
        // quantity is used only for stock deduction at sale posting.
        totalMinor,
        remainingQtyMilli: Math.max(0, weightTarget.availableQtyMilli - qtyMilli),
        enoughStock: qtyMilli <= weightTarget.availableQtyMilli,
      };
    } catch {
      return null;
    }
  }, [weightTarget, weightTotalInput]);

  function activatePosSession(session: PosSession): void {
    if (salePosting || paymentPreparing) {
      setNotice("أكمل أو ألغِ عملية الدفع الحالية قبل الانتقال إلى عميل آخر.");
      return;
    }
    setActivePosSessionId(session.id);
    setCart(session.cart);
    setDiscount(session.discount || "0.00");
    setCustomerId(session.customerId || "");
    setCartSaleTab(session.customerId ? "customer" : "direct");
    setCartQuantityDrafts({});
    setDialog(null);
    setElectronicIntent(null);
  }

  function openNewPosSession(): void {
    const id = crypto.randomUUID();
    const session: PosSession = {
      id,
      label: `العميل ${posSessions.length + 1}`,
      cart: [],
      discount: "0.00",
      customerId: "",
      createdAt: new Date().toISOString(),
    };
    setPosSessions((sessions) => [
      ...sessions.map((item) => item.id === activePosSessionId ? { ...item, cart, discount, customerId } : item),
      session,
    ]);
    activatePosSession(session);
    setNotice("تم فتح فاتورة مستقلة لعميل جديد. الفاتورة السابقة محفوظة في تبويبها.");
  }

  function closePosSession(id: string): void {
    if (posSessions.length <= 1) {
      setNotice("لا يمكن إغلاق آخر فاتورة مفتوحة. يمكنك تفريغها أو تعليقها.");
      return;
    }
    const session = posSessions.find((item) => item.id === id);
    if (session?.cart.length && !window.confirm(`سيُغلق تبويب «${session.label}» وتُحذف مسودته. هل تريد المتابعة؟`)) return;
    const remaining = posSessions.filter((item) => item.id !== id);
    setPosSessions(remaining);
    if (id === activePosSessionId) activatePosSession(remaining[0]!);
  }

  function clearCurrentCart(): void {
    if (!cart.length) return;
    if (window.confirm("هل تريد تفريغ عناصر السلة الحالية؟")) {
      setCart([]);
      setDiscount("0.00");
    }
  }

  function holdCurrentCart(): void {
    if (cart.length === 0) return;
    const newHeld: HeldInvoice = {
      id: crypto.randomUUID(),
      heldAt: new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
      cart: [...cart],
      discount,
      customerId,
      totalMinor: grandTotal,
    };
    const updated = [newHeld, ...heldInvoices];
    setHeldInvoices(updated);
    localStorage.setItem(HELD_INVOICES_KEY, JSON.stringify(updated));
    setCart([]);
    setDiscount("0.00");
    setNotice("تم حفظ الفاتورة في الفواتير المعلقة بنجاح.");
  }

  function restoreHeldCart(held: HeldInvoice): void {
    if (cart.length > 0) {
      if (!window.confirm("السلة الحالية تحتوي على أصناف. هل تريد استبدالها بالفاتورة المعلقة؟")) {
        return;
      }
    }
    setCart(held.cart);
    setDiscount(held.discount || "0.00");
    if (held.customerId) setCustomerId(held.customerId);
    const updated = heldInvoices.filter((item) => item.id !== held.id);
    setHeldInvoices(updated);
    localStorage.setItem(HELD_INVOICES_KEY, JSON.stringify(updated));
    setShowHeldModal(false);
    setNotice("تمت استعادة الفاتورة المعلقة إلى السلة.");
  }

  function deleteHeldCart(id: string): void {
    const updated = heldInvoices.filter((item) => item.id !== id);
    setHeldInvoices(updated);
    localStorage.setItem(HELD_INVOICES_KEY, JSON.stringify(updated));
  }

  function addWithQty(product: CatalogProduct, qtyMilli: number, saleUnit: "UNIT" | "PACKAGE" | "CARTON" = "UNIT"): void {
    if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) {
      setNotice("الكمية غير صحيحة");
      return;
    }
    setCart((current) => {
      const found = current.find((line) => line.product.id === product.id && cartLineSaleUnit(line) === saleUnit && !line.weightedLabelBarcode);
      const productQtyInCart = current.filter((line) => line.product.id === product.id).reduce((sum, line) => sum + line.qtyMilli, 0);
      const nextQty = (found?.qtyMilli ?? 0) + qtyMilli;
      if (productQtyInCart + qtyMilli > product.availableQtyMilli) {
        setNotice("المخزون الظاهر غير كافٍ؛ سيعيد الخادم التحقق عند الإتمام");
        return current;
      }
      return found
        ? current.map((line) =>
            line.product.id === product.id && cartLineSaleUnit(line) === saleUnit && !line.weightedLabelBarcode
              ? { ...line, qtyMilli: nextQty }
              : line,
          )
        : [...current, { product, qtyMilli, saleUnit }];
    });
  }

  function addWeightedLabel(product: CatalogProduct, label: WeightedLabelResult): void {
    if (label.qtyMilli > product.availableQtyMilli) {
      setNotice("المخزون الظاهر لا يكفي لهذا الملصق؛ سيُتحقق منه نهائيًا عند إتمام البيع.");
      return;
    }
    setCart((current) => current.some((line) => line.weightedLabelBarcode === label.barcode)
      ? current
      : [...current, { product, qtyMilli: label.qtyMilli, weightedLabelBarcode: label.barcode, weightedLabelUnitPriceMinor: label.unitPriceMinor, weightedLabelTotalMinor: label.totalMinor }]);
  }

  function openPackageSaleChoice(product: CatalogProduct): void {
    packageTargetRef.current = product;
    setPackageTarget(product);
  }

  function closePackageSaleChoice(): void {
    packageTargetRef.current = null;
    setPackageTarget(null);
  }

  function looseUnitLabel(product: CatalogProduct): string {
    return (product.retailPackage?.contentsUnit ?? product.cartonContentsUnit) === "BAG"
      ? "كيس"
      : "قطعة";
  }

  /**
   * A second scan means the cashier has moved on.  Do not throw away the
   * previous sale merely because its carton/package chooser was unanswered:
   * record it as the smallest sellable unit, then handle the new scan.
   */
  function commitUnansweredPackageAsLooseUnit(): CatalogProduct | null {
    const pending = packageTargetRef.current;
    if (!pending) return null;
    closePackageSaleChoice();
    addWithQty(pending, 1000, "UNIT");
    return pending;
  }

  function add(product: CatalogProduct): void {
    if (product.availableQtyMilli <= 0) {
      setNotice(`الصنف (${product.nameAr}) غير متوفر حالياً في المخزون (الرصيد: 0). سجل استلام بضاعة لبيعه.`);
      return;
    }
    setSalesSheetOpen(true);
    if (product.unitKind === "WEIGHT") {
      setWeightTarget(product);
      setWeightTotalInput("");
      return;
    }
    if (product.retailPackage || (product.cartonPriceMinor && product.purchasePackSize >= 2)) {
      openPackageSaleChoice(product);
      return;
    }
    addWithQty(product, 1000);
  }

  function changeCartQty(target: CartLine, direction: 1 | -1): void {
    if (target.weightedLabelBarcode || target.manualItem) return;
    const product = target.product;
    const saleUnit = cartLineSaleUnit(target);
    const delta = saleUnit === "PACKAGE" ? product.retailPackage!.unitsPerPackage * 1000 : saleUnit === "CARTON" ? product.purchasePackSize * 1000 : product.unitKind === "WEIGHT" ? 250 : 1000;
    setCartQuantityDrafts((current) => {
      const { [cartLineKey(target)]: _discarded, ...remaining } = current;
      return remaining;
    });
    setCart((current) =>
      current.flatMap((line) => {
        if (line.product.id !== product.id || cartLineSaleUnit(line) !== saleUnit) return [line];
        if (line.weightedLabelBarcode) return [line];
        const nextQty = line.qtyMilli + direction * delta;
        return nextQty > 0 && nextQty <= product.availableQtyMilli
          ? [{ ...line, qtyMilli: nextQty }]
          : nextQty <= 0
            ? []
            : [line];
      }),
    );
  }

  function commitManualCartQuantity(target: CartLine, value: string): void {
    if (target.weightedLabelBarcode || target.manualItem) return;
    const key = cartLineKey(target);
    let requestedQuantity: number;
    try {
      requestedQuantity = parseManualCartQuantity(target, value);
    } catch (cause) {
      setNotice(errorMessage(cause));
      setCartQuantityDrafts((current) => ({ ...current, [key]: cartLineQuantityText(target) }));
      return;
    }
    setCart((current) => {
      const otherQuantity = current
        .filter((line) => line.product.id === target.product.id && cartLineKey(line) !== key)
        .reduce((sum, line) => sum + line.qtyMilli, 0);
      if (otherQuantity + requestedQuantity > target.product.availableQtyMilli) {
        setNotice("الكمية المطلوبة أكبر من المخزون المتاح.");
        return current;
      }
      return current.map((line) => cartLineKey(line) === key ? { ...line, qtyMilli: requestedQuantity } : line);
    });
    setCartQuantityDrafts((current) => {
      const { [key]: _discarded, ...remaining } = current;
      return remaining;
    });
  }

  function confirmWeight(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!weightTarget) return;
    const qtyMilli = weightPreview?.qtyMilli;
    if (!qtyMilli) { setNotice("أدخل السعر النهائي بصورة صحيحة."); return; }
    if (qtyMilli > weightTarget.availableQtyMilli) {
      setNotice(`الوزن المطلوب أكبر من الرصيد المتاح (${productQuantityLabel(weightTarget)}).`);
      return;
    }
    setCart((current) => {
      const alreadyInCart = current
        .filter((line) => line.product.id === weightTarget.id)
        .reduce((sum, line) => sum + line.qtyMilli, 0);
      if (alreadyInCart + qtyMilli > weightTarget.availableQtyMilli) {
        setNotice("المخزون الظاهر لا يكفي لهذا السعر؛ خفّض السعر أو راجع الرصيد.");
        return current;
      }
      return [...current, {
        product: weightTarget,
        qtyMilli,
        saleUnit: "UNIT",
        enteredTotalMinor: weightPreview.totalMinor,
        enteredWeightId: crypto.randomUUID(),
      }];
    });
    setWeightTarget(null);
  }

  function createQuickSaleProduct(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (quickSaleProductSaving) return;
    const data = new FormData(event.currentTarget);
    try {
      setQuickSaleProductSaving(true);
      setQuickSaleProductError("");
      const nameAr = String(data.get("nameAr") ?? "").trim();
      const priceMinor = minorFromInput(String(data.get("price") ?? ""));
      if (!nameAr || priceMinor <= 0) {
        throw new Error("اكتب اسم الصنف وسعر بيع صحيح.");
      }
      const product: CatalogProduct = {
        id: crypto.randomUUID(), warehouseId: "", nameAr, description: "صنف بيع مباشر غير مسجل",
        category: "بيع مباشر", unitKind: "PIECE", weightUnit: "KILOGRAM", purchasePackSize: 1,
        priceMinor, availableQtyMilli: 1000, reorderLevelMilli: 0, barcodes: [], version: 0,
      };
      setSalesSheetOpen(true);
      setCart((current) => [...current, { product, qtyMilli: 1000, saleUnit: "UNIT", manualItem: true }]);
      setQuickSaleProductOpen(false);
      setNotice(`أُضيف «${product.nameAr}» إلى الفاتورة فقط، ولن يُحفظ في الأصناف أو المخزون.`);
    } catch (cause) {
      setQuickSaleProductError(errorMessage(cause));
    } finally {
      setQuickSaleProductSaving(false);
    }
  }

  function choosePackageSale(saleUnit: "UNIT" | "PACKAGE" | "CARTON"): void {
    const target = packageTargetRef.current ?? packageTarget;
    if (!target) return;
    const qtyMilli = saleUnit === "PACKAGE"
      ? target.retailPackage!.unitsPerPackage * 1000
      : saleUnit === "CARTON"
        ? target.purchasePackSize * 1000
      : 1000;
    closePackageSaleChoice();
    addWithQty(target, qtyMilli, saleUnit);
  }

  async function addSaleBarcode(barcode: string): Promise<boolean> {
    const raw = barcode.trim();
    const candidates = [raw];
    if (raw.length === 12 && /^\d+$/.test(raw)) {
      candidates.push("0" + raw);
    } else if (raw.length === 13 && raw.startsWith("0")) {
      candidates.push(raw.slice(1));
    }

    for (const code of candidates) {
      try {
        const resolved = await invoke<{ label: WeightedLabelResult; product: CatalogProduct }>({ operation: "weighted-labels.resolve", payload: { barcode: code } });
        addWeightedLabel(resolved.product, resolved.label);
        setQuery("");
        playScanTone("known");
        return true;
      } catch (cause) {
        const failure = cause as Partial<ApiFailure>;
        if (failure.code === "WEIGHT_LABEL_USED") {
          setNotice("تم بيع ملصق الوزن هذا بالفعل ولا يمكن إضافته مرة أخرى.");
          playScanTone("unknown");
          return false;
        }
      }
    }

    let exact: CatalogProduct | undefined;
    let matchedCode = "";
    for (const code of candidates) {
      exact = products.find((product) => product.barcodes.includes(code));
      if (exact) { matchedCode = code; break; }
    }
    if (!exact) {
      for (const code of candidates) {
        const found = (await lookupProducts(code)).products.find((product) =>
          product.barcodes.includes(code),
        );
        if (found) {
          exact = found;
          matchedCode = code;
          break;
        }
      }
    }
    if (exact) {
      const mapping = exact.barcodeMappings?.find((item) => item.barcode === matchedCode);
      if (mapping && mapping.saleUnit !== "UNIT") {
        const qtyMilli = mapping.saleUnit === "PACKAGE"
          ? (exact.retailPackage?.unitsPerPackage ?? 0) * 1000
          : exact.purchasePackSize * 1000;
        if (qtyMilli <= 0) {
          setNotice("باركود العبوة أو الكرتونة غير مكتمل الإعداد؛ راجع بطاقة الصنف.");
          playScanTone("unknown");
          return false;
        }
        addWithQty(exact, qtyMilli, mapping.saleUnit);
      } else add(exact);
      setQuery("");
      playScanTone("known");
      return true;
    }
    playScanTone("unknown");
    if (/^\d+$/.test(raw)) setUnknownBarcode(raw);
    else setNewProductName(raw);
    return false;
  }

  async function handleBarcode(
    barcode: string,
    _source: "HID" | "SERIAL" = "HID",
  ): Promise<void> {
    const normalized = barcode.trim();
    if (!normalized) return;
    const now = Date.now();
    const recent = recentScanRef.current;
    if (
      recent?.barcode === normalized &&
      now - recent.at < hardware.duplicateGuardMs
    )
      return;
    recentScanRef.current = { barcode: normalized, at: now };
    const autoCommitted = commitUnansweredPackageAsLooseUnit();
    setNotice(`تمت قراءة ${barcodeKind(normalized)}: ${normalized}`);
    if (!salesSheetOpen && cart.length === 0) {
      setPendingScan(normalized);
      return;
    }
    await addSaleBarcode(normalized);
    if (autoCommitted) {
      setNotice(`أُضيف «${autoCommitted.nameAr}» تلقائيًا كـ${looseUnitLabel(autoCommitted)} لأن مسحًا جديدًا وصل قبل اختيار الكرتونة أو العبوة.`);
    }
  }

  function queueBarcode(barcode: string, source: "HID" | "SERIAL" = "HID"): Promise<void> {
    const next = scanQueueRef.current.then(() => handleBarcode(barcode, source));
    // Keep future scans alive even if a lookup fails; the individual scan
    // already shows its own Arabic error/notice.
    scanQueueRef.current = next.catch(() => undefined);
    return next;
  }

  async function scan(): Promise<void> {
    const barcode = query.trim();
    if (!barcode) return;
    setQuery("");
    await queueBarcode(barcode, "HID");
  }

  async function preparePayment(): Promise<void> {
    if (!shift || !cart.length) return;
    if (paymentPreparingRef.current || salePostingRef.current) return;
    paymentPreparingRef.current = true;
    setPaymentPreparing(true);
    try {
      const quote = await invoke<QuoteResponse>({
        operation: "quotes.create",
        payload: {
          terminalId: shift.terminalId,
          shiftId: shift.id,
          discountMinor: minorFromInput(discount),
          lines: cart.map((line) => line.manualItem
            ? { manualNameAr: line.product.nameAr, manualPriceMinor: line.product.priceMinor, qtyMilli: 1000, saleUnit: "UNIT" as const }
            : {
              productId: line.product.id,
              qtyMilli: line.qtyMilli,
              saleUnit: cartLineSaleUnit(line),
              ...(line.weightedLabelBarcode ? { weightedLabelBarcode: line.weightedLabelBarcode } : {}),
              ...(line.enteredTotalMinor !== undefined ? { enteredTotalMinor: line.enteredTotalMinor } : {}),
            }),
        },
      });
      const changed = quote.lines.some((line) => {
        const cartLine = line.manualItem ? undefined : cart.find((item) => !item.manualItem && !item.weightedLabelBarcode && item.product.id === line.productId && cartLineSaleUnit(item) === line.saleUnit);
        return cartLine ? cartLineUnitPriceMinor(cartLine) !== line.unitPriceMinor : false;
      });
      if (
        changed &&
        !window.confirm(
          "تغير سعر صنف واحد أو أكثر. راجع الإجمالي الجديد ثم وافق للمتابعة.",
        )
      )
        return;
      setCustomerId(customers[0]?.id ?? "");
      setElectronicIntent(null);
      setCashReceived((quote.totalMinor / 100).toFixed(2));
      setDialog({ quote, method: "CASH" });
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      paymentPreparingRef.current = false;
      setPaymentPreparing(false);
    }
  }

  async function postSale(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dialog || !shift) return;
    if (salePostingRef.current) return;
    salePostingRef.current = true;
    setSalePosting(true);
    const data = new FormData(event.currentTarget);
    try {
      // This is intentionally a per-sale choice. A cashier can skip paper
      // for small purchases without changing the terminal's default setting.
      const printCustomerReceipt = data.get("printReceipt") === "on";
      const electronicMethod = dialog.method === "KASHIER_POS_CARD" || dialog.method === "FAWRY_REFERENCE" ? dialog.method : null;
      const shouldOpenCashDrawer = hardware.cashDrawerEnabled && (dialog.method === "CASH" || dialog.method === "MIXED");
      if (electronicMethod && (!electronicIntent || electronicIntent.status !== "SUCCEEDED")) {
        const started = await invoke<typeof electronicIntent & { intentId: string }>({
          operation: "payments.intents.create",
          payload: {
            terminalId: shift.terminalId,
            shiftId: shift.id,
            quoteId: dialog.quote.quoteId,
            method: electronicMethod,
            idempotencyKey: crypto.randomUUID(),
            printReceipt: printCustomerReceipt,
            ...(electronicMethod === "FAWRY_REFERENCE" ? { customerName: String(data.get("fawryCustomerName") ?? "").trim() || undefined, customerMobile: String(data.get("fawryCustomerMobile") ?? "").trim(), customerEmail: String(data.get("fawryCustomerEmail") ?? "").trim() } : {}),
          },
        });
        setElectronicIntent(started);
        setNotice(electronicMethod === "KASHIER_POS_CARD" ? "تم إرسال إجمالي الفاتورة إلى ماكينة Kashier. انتظر تأكيد العملية ثم اضغط «تحقق من حالة الدفع»." : "تم إنشاء رقم فوري المرجعي. اطلب من العميل السداد في نقطة فوري، ثم اضغط «تحقق من حالة الدفع».");
        return;
      }
      if (dialog.method === "CASH" && cashReceivedMinor < dialog.quote.totalMinor) {
        throw new Error("المبلغ المستلم أقل من إجمالي الفاتورة.");
      }
      const payments =
        dialog.method === "CASH"
          ? [
              {
                method: "CASH" as const,
                amountMinor: dialog.quote.totalMinor,
              },
            ]
          : dialog.method === "CARD"
            ? [
                {
                  method: "CARD" as const,
                  amountMinor: dialog.quote.totalMinor,
                },
              ]
            : dialog.method === "CREDIT"
              ? [
                  {
                    method: "CREDIT" as const,
                    amountMinor: dialog.quote.totalMinor,
                  },
                ]
              : electronicMethod
                ? [{ method: electronicMethod, amountMinor: dialog.quote.totalMinor }]
                : (() => {
                  const cash = minorFromInput(String(data.get("cash")));
                  return [
                    {
                      method: "CASH" as const,
                      amountMinor: cash,
                      tenderedMinor: cash,
                    },
                    {
                      method: "CARD" as const,
                      amountMinor: dialog.quote.totalMinor - cash,
                    },
                  ];
                })();
      const key = crypto.randomUUID();
      const salePayload = {
        terminalId: shift.terminalId,
        shiftId: shift.id,
        quoteId: dialog.quote.quoteId,
        payments,
        ...(electronicMethod && electronicIntent ? { paymentIntentId: electronicIntent.intentId } : {}),
        ...(dialog.method === "CREDIT" ? { customerId } : {}),
      };
      localStorage.setItem(PENDING_KEY, JSON.stringify({ key, salePayload }));
      const sale = await invoke<SaleResponse>({
        operation: "sales.post",
        payload: { idempotencyKey: key, sale: salePayload },
      });
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(DRAFT_KEY);
      setCart([]);
      setSalesSheetOpen(false);
      setDialog(null);
      setCashReceived("");
      setElectronicIntent(null);
      setReceipt(printCustomerReceipt ? sale : null);
      setDiscount("0.00");
      if (printCustomerReceipt && hardware.receiptPrinterName) {
        void printReceiptForSale(sale, false, hardware.receiptCopies).catch((cause) =>
          setNotice(
            `تم تسجيل الفاتورة، لكن تعذرت طباعتها: ${errorMessage(cause)}`,
          ),
        );
      } else if (!printCustomerReceipt) {
        setNotice(`تم تسجيل الفاتورة ${sale.invoiceNo} بدون طباعة إيصال للعميل.`);
      }
      if (shouldOpenCashDrawer) {
        void invoke<{ printerName: string }>({ operation: "hardware.drawer.open" }).catch((cause) =>
          setNotice(`تم تسجيل الفاتورة، لكن تعذر فتح الدرج: ${errorMessage(cause)}`),
        );
      }
      await Promise.all([
        refreshProducts(),
        refreshShift(),
        refreshPosMetrics ? refreshPosMetrics() : Promise.resolve(),
      ]);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      salePostingRef.current = false;
      setSalePosting(false);
    }
  }

  async function verifyElectronicPayment(): Promise<void> {
    if (!electronicIntent) return;
    setSalePosting(true);
    try {
      const next = await invoke<typeof electronicIntent & { intentId: string }>({
        operation: "payments.intents.verify",
        payload: { intentId: electronicIntent.intentId },
      });
      setElectronicIntent(next);
      setNotice(next.status === "SUCCEEDED" ? "تم التحقق من نجاح التحصيل. اضغط إتمام البيع لتسجيل الفاتورة." : `حالة Kashier الحالية: ${next.status}`);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setSalePosting(false);
    }
  }

  useEffect(() => {
    scanHandlerRef.current = queueBarcode;
  });

  useEffect(() => {
    function receiveBarcode(event: Event): void {
      const barcode = String((event as CustomEvent<string>).detail || "");
      if (barcode) void scanHandlerRef.current(barcode, "HID");
    }
    window.addEventListener("nabta:pos-barcode-scan", receiveBarcode);
    return () => {
      window.removeEventListener("nabta:pos-barcode-scan", receiveBarcode);
    };
  }, []);

  async function printReceiptForSale(sale: SaleResponse, announce = true, copies = 1): Promise<void> {
    if (receiptPrintingRef.current) {
      if (announce) setNotice("جارٍ بالفعل إرسال هذا الإيصال للطابعة؛ لن يُرسل أمر مكرر.");
      return;
    }
    receiptPrintingRef.current = true;
    setReceiptPrinting(true);
    if (!hardware.receiptPrinterName) {
      try {
        window.print();
      } finally {
        receiptPrintingRef.current = false;
        setReceiptPrinting(false);
      }
      return;
    }
    try {
      await invoke({
        operation: "hardware.receipt.print",
        payload: { storeName, branding, sale, copies },
      });
      if (announce) setNotice(`أُرسل ${copies === 1 ? "الإيصال" : `${copies} نسخ من الإيصال`} إلى ${hardware.receiptPrinterName}.`);
    } catch (cause) {
      if (announce) setNotice(errorMessage(cause));
      throw cause;
    } finally {
      receiptPrintingRef.current = false;
      setReceiptPrinting(false);
    }
  }

  async function printCurrentReceipt(): Promise<void> {
    if (!receipt) return;
    await printReceiptForSale(receipt);
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if ((event.key === "F2" || (event.code === "KeyF" && !typing && !event.ctrlKey && !event.altKey && !event.metaKey))) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "F6" || event.code === "F6") {
        event.preventDefault();
        event.stopPropagation();
        setQuickSaleProductError("");
        setQuickSaleProductOpen(true);
      }
      if (event.key === "F4") {
        event.preventDefault();
        if (shift) void preparePayment();
        else onOpenShift();
      }
      if (event.key === "Escape") setDialog(null);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  return (
    <>
      <h1 className="sr-only">نقطة البيع</h1>
      {!online && (
        <div className="offline">
          الخادم غير متاح. المسودة محفوظة على هذا الجهاز، وإصدار الفاتورة متوقف
          حتى عودة الاتصال.
        </div>
      )}
      {notice && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice} ×
        </button>
      )}
      {/* ─── Top 4 Metric Stat Cards ───────────────────────── */}
      <div className="pos-stat-cards">
        <div className="pos-stat-card sales">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="21" r="1.4" />
              <circle cx="20" cy="21" r="1.4" />
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
            </svg>
          </div>
          <div className="stat-info">
            <span className="stat-title">إجمالي المبيعات اليوم</span>
            <span className="stat-value">
              {formatMoney(posMetrics ? posMetrics.todaySalesMinor : (shift ? Math.max(0, shift.expectedCashMinor - shift.openingMinor) : 0))}
            </span>
          </div>
        </div>

        <div className="pos-stat-card invoices">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div className="stat-info">
            <span className="stat-title">عدد الفواتير اليوم</span>
            <span className="stat-value">
              {posMetrics ? posMetrics.todayInvoiceCount : (shift && shift.expectedCashMinor > shift.openingMinor ? 1 : 0)}{" "}
              <span className="stat-unit">فاتورة</span>
            </span>
          </div>
        </div>

        <div className="pos-stat-card products">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>
          <div className="stat-info">
            <span className="stat-title">عدد المنتجات</span>
            <span className="stat-value">
              {(posMetrics ? posMetrics.totalProductsCount : products.length).toLocaleString("ar-EG")}{" "}
              <span className="stat-unit">منتج</span>
            </span>
          </div>
        </div>

        <div className="pos-stat-card customers">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="stat-info">
            <span className="stat-title">العملاء اليوم</span>
            <span className="stat-value">
              {posMetrics ? posMetrics.todayCustomerCount : (customers.length || 0)}{" "}
              <span className="stat-unit">عميل</span>
            </span>
          </div>
        </div>
      </div>

      <section className="pos-session-strip" aria-label="فواتير العملاء المفتوحة">
        <div>
          <b>فواتير مفتوحة</b>
          <small>كل تبويب يحتفظ بأصنافه وخصمه وعميله بصورة مستقلة.</small>
        </div>
        <div className="pos-session-tabs" role="tablist" aria-label="العملاء الحاليون">
          {posSessions.map((session) => (
            <div key={session.id} className={`pos-session-tab ${session.id === activePosSessionId ? "active" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={session.id === activePosSessionId}
                onClick={() => activatePosSession(session)}
                title={`فتح ${session.label}`}
              >
                {session.customerId ? customers.find((customer) => customer.id === session.customerId)?.name ?? session.label : session.label}
                {session.cart.length ? ` (${session.cart.length})` : ""}
              </button>
              {posSessions.length > 1 && (
                <button type="button" className="pos-session-close" aria-label={`إغلاق ${session.label}`} onClick={() => closePosSession(session.id)}>×</button>
              )}
            </div>
          ))}
          <button type="button" className="pos-session-new" onClick={openNewPosSession} title="فتح فاتورة مستقلة لعميل آخر">
            + عميل جديد
          </button>
        </div>
      </section>

      {/* ─── Main POS Layout (Catalog + Cart) ────────────────── */}
      <div className="pos-layout">
        <section className="catalog-area">
          <div className="catalog-header-row">
            <div className="catalog-main-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              <h2>المنتجات</h2>
            </div>
          </div>

          <div className="catalog-categories">
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                className={`category-pill ${category === item ? "active" : ""}`}
                onClick={() => setCategory(item)}
              >
                {renderCategoryIcon(item)}
                <span>{item}</span>
              </button>
            ))}
          </div>

          <div className="catalog-toolbar">
            <div className="catalog-search-wrap">
              <span className="catalog-search-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                data-testid="pos-scanner"
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
                onKeyDown={(event) => {
                  if (event.defaultPrevented) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setQuery("");
                    return;
                  }
                  if (event.key === "F3") {
                    event.preventDefault();
                    if (query.trim()) onEditProductByQuery(query);
                    else setNotice("امسح باركود الصنف أو ابحث عنه أولاً، ثم اضغط F3 للتعديل.");
                    return;
                  }
                  if (
                    event.key ===
                    (hardware.scannerTerminator === "ENTER" ? "Enter" : "Tab")
                  ) {
                    event.preventDefault();
                    void scan();
                  }
                }}
                placeholder="ابحث أو امسح الباركود… F أو F2 | Esc لمسح | F3 لتعديل الصنف"
                autoFocus
              />
              {searchFocused && searchSuggestions.length > 0 && (
                <div className="pos-search-suggestions" role="listbox" aria-label="اقتراحات البحث">
                  {searchSuggestions.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      role="option"
                      aria-selected="false"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setQuery("");
                        setSearchFocused(false);
                        add(product);
                      }}
                    >
                      <span><b>{product.nameAr}</b><small>{product.category} · {productQuantityLabel(product)}</small></span>
                      <strong>{formatMoney(productDisplayPriceMinor(product))}{product.unitKind === "WEIGHT" ? ` / ${measurementUnitLabel(product.weightUnit)}` : ""}</strong>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="toolbar-action-btn"
              onClick={() => { setQuickSaleProductError(""); setQuickSaleProductOpen(true); }}
              title="إضافة صنف جديد سريعًا إلى الفاتورة (F6)"
            >
              + صنف سريع <kbd>F6</kbd>
            </button>

            <div className="catalog-toolbar-actions">
              <button
                type="button"
                className="toolbar-action-btn"
                onClick={() => {
                  setSortOption((prev) =>
                    prev === "default"
                      ? "price-asc"
                      : prev === "price-asc"
                        ? "price-desc"
                        : prev === "price-desc"
                          ? "name-asc"
                          : "default"
                  );
                }}
                title="تغيير الترتيب"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
                <span>
                  {sortOption === "default"
                    ? "ترتيب"
                    : sortOption === "price-asc"
                      ? "السعر ↑"
                      : sortOption === "price-desc"
                        ? "السعر ↓"
                        : "الاسم أ-ي"}
                </span>
              </button>

              <button
                type="button"
                className="toolbar-action-btn"
                onClick={() => {
                  setFilterOption((prev) =>
                    prev === "all"
                      ? "in-stock"
                      : prev === "in-stock"
                        ? "weight-only"
                        : "all"
                  );
                }}
                title="تصفية الأصناف"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                <span>
                  {filterOption === "all"
                    ? "تصفية"
                    : filterOption === "in-stock"
                      ? "المتوفر فقط"
                      : "الموزون فقط"}
                </span>
              </button>
            </div>
          </div>

          <div className="product-grid">
            {visiblePage.map((product) => (
              <div
                key={product.id}
                className={`product-card${product.availableQtyMilli <= 0 ? " out-of-stock" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => add(product)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    add(product);
                  }
                }}
              >
                {product.availableQtyMilli <= 0 ? (
                  <span className="stock-tag out-of-stock">نفد المخزون</span>
                ) : (
                  <span className="stock-tag">
                    {productQuantityLabel(product)}
                  </span>
                )}

                <ProductArt product={product} />

                <b className="product-name">{product.nameAr}</b>

                <div className="product-card-footer">
                  <span className="product-price-tag">
                    {formatMoney(productDisplayPriceMinor(product))}
                    <small className="product-price-currency">
                      {product.unitKind === "WEIGHT" ? ` / ${productUnitLabel(product)}` : ""}
                    </small>
                  </span>

                  <span
                    className="quick-add-btn"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      add(product);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        e.preventDefault();
                        add(product);
                      }
                    }}
                    aria-label={`إضافة ${product.nameAr}`}
                    title="إضافة سريعة للسلة"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </div>
              </div>
            ))}
          </div>

          {filteredProducts.length > POS_GRID_PAGE_SIZE && (
            <nav className="catalog-pagination" aria-label="تصفح الأصناف">
              <span>
                عرض {activeCatalogPage * POS_GRID_PAGE_SIZE + 1}
                {"–"}
                {Math.min((activeCatalogPage + 1) * POS_GRID_PAGE_SIZE, filteredProducts.length)} من {filteredProducts.length}
              </span>
              <div>
                <button
                  type="button"
                  disabled={activeCatalogPage === 0}
                  onClick={() => setCatalogPage((page) => Math.max(0, page - 1))}
                >
                  السابق
                </button>
                <span>{activeCatalogPage + 1} / {catalogPageCount}</span>
                <button
                  type="button"
                  disabled={activeCatalogPage >= catalogPageCount - 1}
                  onClick={() => setCatalogPage((page) => Math.min(catalogPageCount - 1, page + 1))}
                >
                  التالي
                </button>
              </div>
            </nav>
          )}
        </section>

        {/* ─── Cart Panel ───────────────────────────────────────── */}
        <aside className="cart">
          <div className="cart-header-top">
            <h2>{posSessions.find((session) => session.id === activePosSessionId)?.label ?? "فاتورة جديدة"}</h2>
            <button
              type="button"
              className="cart-clear-icon-btn"
              onClick={clearCurrentCart}
              disabled={cart.length === 0}
              title="تفريغ السلة"
              aria-label="تفريغ السلة"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>

          <div className="cart-sale-tabs">
            <button
              type="button"
              className={`cart-sale-tab ${cartSaleTab === "direct" ? "active" : ""}`}
              onClick={() => setCartSaleTab("direct")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="21" r="1" />
                <circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
              <span>بيع مباشر</span>
            </button>
            <button
              type="button"
              className={`cart-sale-tab ${cartSaleTab === "customer" ? "active" : ""}`}
              onClick={() => setCartSaleTab("customer")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span>عميل</span>
            </button>
          </div>

          {cartSaleTab === "customer" && (
            <div className="cart-customer-selector">
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                aria-label="اختيار العميل"
              >
                <option value="">-- بيع مباشر (بدون تسجيل عميل) --</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.phone ? `(${c.phone})` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="cart-lines-container">
            {cart.length === 0 ? (
              <div className="cart-empty-message">
                امسح باركودًا أو اختر منتجًا للبدء
              </div>
            ) : (
              <div className="cart-table">
                <div className="cart-table-head">
                  <span></span>
                  <span>الإجمالي</span>
                  <span>السعر</span>
                  <span>الكمية</span>
                  <span>المنتج</span>
                </div>
                {cart.map((line) => (
                  <div className="cart-line cart-table-row" key={line.weightedLabelBarcode ?? `${line.product.id}:${cartLineSaleUnit(line)}`}>
                    <button
                      type="button"
                      className="cart-row-delete"
                      aria-label="حذف الصنف"
                      onClick={() =>
                        setCart((items) =>
                          items.filter((item) => line.weightedLabelBarcode ? item.weightedLabelBarcode !== line.weightedLabelBarcode : item.product.id !== line.product.id || cartLineSaleUnit(item) !== cartLineSaleUnit(line))
                        )
                      }
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>

                    <span className="cart-row-total">
                      {formatMoney(cartLineTotalMinor(line))}
                    </span>

                    <span className="cart-row-price">
                      {formatMoney(cartLineUnitPriceMinor(line))}
                    </span>

                    <div className="cart-stepper">
                      <button
                        type="button"
                        aria-label="تقليل الكمية"
                        disabled={Boolean(line.weightedLabelBarcode)}
                        onClick={() => changeCartQty(line, -1)}
                      >
                        −
                      </button>
                      {line.weightedLabelBarcode ? (
                        <span>{productQuantityLabel(line.product, line.qtyMilli)}</span>
                      ) : (
                        <label className="cart-quantity-input-wrap">
                          <input
                            aria-label={`الكمية المباعة من ${line.product.nameAr}`}
                            value={cartQuantityDrafts[cartLineKey(line)] ?? cartLineQuantityText(line)}
                            inputMode={line.product.unitKind === "WEIGHT" && !isSmallMeasuredUnit(line.product.weightUnit) ? "decimal" : "numeric"}
                            dir="ltr"
                            onChange={(event) => setCartQuantityDrafts((current) => ({ ...current, [cartLineKey(line)]: event.target.value }))}
                            onBlur={(event) => commitManualCartQuantity(line, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          <small>{cartLineQuantityUnit(line)}</small>
                        </label>
                      )}
                      <button
                        type="button"
                        aria-label="زيادة الكمية"
                        disabled={Boolean(line.weightedLabelBarcode)}
                        onClick={() => changeCartQty(line, 1)}
                      >
                        +
                      </button>
                    </div>

                    <div className="cart-row-product-info">
                      {line.product.imageBarcode ? (
                        <img
                          className="thumb"
                          src={`nabta-media://product/${encodeURIComponent(line.product.imageBarcode)}`}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : null}
                      <b>{line.product.nameAr}{cartLineSaleUnit(line) === "PACKAGE" ? " — عبوة كاملة" : cartLineSaleUnit(line) === "CARTON" ? " — كرتونة كاملة" : ""}</b>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="cart-summary-box">
            <div className="cart-summary-line">
              <span>المجموع الفرعي</span>
              <b>{formatMoney(subtotal)}</b>
            </div>

            <div className="cart-summary-line">
              <span>% خصم</span>
              <div className="cart-discount-input-row">
                <input
                  value={discount}
                  onChange={(event) => setDiscount(event.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0.00"
                />
              </div>
            </div>

            {taxSettings?.enabled && (taxSettings.ratePercent ?? 0) > 0 && (
              <div className="cart-summary-line">
                <span>الضريبة ({taxSettings.ratePercent}%)</span>
                <b>{formatMoney(taxMinor)}</b>
              </div>
            )}

            <div className="cart-grand-total-row">
              <span>الإجمالي</span>
              <strong>{formatMoney(grandTotal)}</strong>
            </div>

            <div className="cart-buttons-group">
              <button
                type="button"
                className={`cart-btn-checkout${shift ? "" : " open-shift-checkout"}`}
                disabled={!online || cart.length === 0 || paymentPreparing || salePosting}
                onClick={() => {
                  if (!shift) {
                    onOpenShift();
                    return;
                  }
                  void preparePayment();
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <line x1="2" y1="10" x2="22" y2="10" />
                </svg>
                <span>
                  {paymentPreparing
                    ? "جارٍ تجهيز الدفع..."
                    : shift
                      ? "إتمام البيع"
                      : "فتح وردية للبدء"}
                </span>
                <kbd style={{ fontSize: 10, opacity: 0.8, padding: "2px 5px", background: "rgba(0,0,0,0.15)", borderRadius: 4 }}>F4</kbd>
              </button>

              <button
                type="button"
                className="cart-btn-hold"
                disabled={cart.length === 0}
                onClick={holdCurrentCart}
                title="تعليق وحفظ الفاتورة الحالية لاسترجاعها لاحقًا"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                <span>حفظ الفاتورة</span>
              </button>
            </div>

            {heldInvoices.length > 0 && (
              <button
                type="button"
                className="held-invoices-pill"
                onClick={() => setShowHeldModal(true)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>فواتير معلقة ({heldInvoices.length})</span>
              </button>
            )}
          </div>
        </aside>
      </div>

      {/* ─── Held Invoices Modal ─────────────────────────────── */}
      {showHeldModal && (
        <div className="modal-backdrop" onClick={() => setShowHeldModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
            <h2>الفواتير المعلقة ({heldInvoices.length})</h2>
            <p className="hint">اختر فاتورة معلقة لاستعادتها إلى السلة وإتمام عملية البيع.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "16px 0", maxHeight: 360, overflowY: "auto" }}>
              {heldInvoices.map((held, idx) => (
                <div
                  key={held.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    border: "1px solid var(--line)",
                    borderRadius: 12,
                    background: "#f8fafc",
                  }}
                >
                  <div>
                    <b>فاتورة #{heldInvoices.length - idx}</b>
                    <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 3 }}>
                      الوقت: {held.heldAt} • {held.cart.length} أصناف
                    </div>
                    <div style={{ fontSize: 13, fontWeight: "bold", color: "var(--green)", marginTop: 2 }}>
                      {formatMoney(held.totalMinor)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="primary"
                      style={{ padding: "6px 14px", fontSize: 12 }}
                      onClick={() => restoreHeldCart(held)}
                    >
                      استعادة
                    </button>
                    <button
                      type="button"
                      style={{ padding: "6px 10px", fontSize: 12, color: "var(--red)", borderColor: "rgba(239,68,68,0.3)" }}
                      onClick={() => deleteHeldCart(held.id)}
                    >
                      حذف
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setShowHeldModal(false)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}
      {pendingScan && (
        <div className="modal-backdrop">
          <section className="modal scanner-modal">
            <span className="scanner-icon">⌁</span>
            <h2>ماذا تريد أن تبدأ؟</h2>
            <p>
              تمت قراءة الباركود <b dir="ltr">{pendingScan}</b>. اختر نوع الورقة
              أولاً، ثم ستُضاف المسحات التالية إليها.
            </p>
            <div className="choice-actions">
              <button
                className="primary"
                onClick={() => {
                  const barcode = pendingScan;
                  setPendingScan("");
                  setSalesSheetOpen(true);
                  void addSaleBarcode(barcode);
                }}
              >
                فاتورة بيع
              </button>
              <button
                onClick={() => {
                  const barcode = pendingScan;
                  setPendingScan("");
                  if (products.some((product) => product.barcodes.includes(barcode))) {
                    onPurchaseScan(barcode);
                  } else if (/^\d+$/.test(barcode)) {
                    setNewProductBarcode(barcode);
                  } else {
                    setNewProductName(barcode);
                  }
                }}
              >
                إدخال / استلام سلع
              </button>
            </div>
            <button
              className="link-button"
              onClick={() => {
                setPendingScan("");
                setQuery("");
              }}
            >
              إلغاء
            </button>
          </section>
        </div>
      )}
      {unknownBarcode && (
        <div className="modal-backdrop">
          <section className="modal scanner-modal">
            <span className="scanner-icon">⌁</span>
            <h2>باركود غير مسجل</h2>
            <p>
              الباركود <b dir="ltr">{unknownBarcode}</b> غير موجود في الأصناف.
            </p>
            <p className="hint">
              أضفه الآن كسجل صنف جديد، أو أغلق الرسالة وواصل البيع.
            </p>
            <div className="modal-actions">
              <button onClick={() => setUnknownBarcode("")}>إلغاء</button>
              <button
                className="primary"
                onClick={() => {
                  setNewProductBarcode(unknownBarcode);
                  setUnknownBarcode("");
                }}
              >
                إضافة صنف جديد
              </button>
            </div>
          </section>
        </div>
      )}
      {(newProductBarcode || newProductName) && (
        <ProductCreateModal
          barcode={newProductBarcode || undefined}
          initialName={newProductName}
          products={products}
          refresh={refreshProducts}
          canViewCost={canViewCost}
          title="إضافة صنف جديد داخل نقطة البيع"
          description={newProductBarcode
            ? <>الباركود <b dir="ltr">{newProductBarcode}</b> غير مسجل. أتمم نفس بطاقة إضافة الصنف هنا، ثم سيُضاف الصنف مباشرةً إلى سلة البيع دون مغادرة نقطة البيع.</>
            : <>أكمل بيانات الصنف «{newProductName}» هنا، ثم سيُضاف إلى مسار البيع الحالي دون مغادرة نقطة البيع.</>}
          onClose={() => { setNewProductBarcode(""); setNewProductName(""); }}
          onCreated={async ({ product }) => {
            setNewProductBarcode("");
            setNewProductName("");
            setNotice(`تم حفظ «${product.nameAr}» وإضافته إلى مسار البيع الحالي.`);
            add(product);
          }}
        />
      )}
      {quickSaleProductOpen && (
        <div className="modal-backdrop">
          <form className="modal quick-sale-product-modal" onSubmit={createQuickSaleProduct}>
            <h2>⚡ صنف سريع داخل الفاتورة</h2>
            <p className="hint">اكتب الاسم والسعر فقط. هذا بند مؤقت للفاتورة الحالية ولن يُحفظ في الأصناف أو المخزون.</p>
            {quickSaleProductError && <p className="notice warning">{quickSaleProductError}</p>}
            <Field label="اسم الصنف"><input name="nameAr" autoFocus required placeholder="مثال: جبنة رومي" /></Field>
            <Field label="سعر البيع بالجنيه"><input name="price" required min="0.01" inputMode="decimal" dir="ltr" placeholder="مثال: 50" /></Field>
            <p className="hint">يُسجل كبند واحد بسعره النهائي؛ لا يخصم من المخزون ولا ينشئ باركوداً أو صنفاً جديداً.</p>
            <div className="modal-actions">
              <button type="button" disabled={quickSaleProductSaving} onClick={() => setQuickSaleProductOpen(false)}>إلغاء</button>
              <button className="primary" disabled={quickSaleProductSaving}>{quickSaleProductSaving ? "جارٍ الإضافة…" : "إضافة للفاتورة"}</button>
            </div>
          </form>
        </div>
      )}
      {weightTarget && (
        <div className="modal-backdrop">
          <form className="modal weight-sale-modal" onSubmit={confirmWeight}>
            <h2>⚖️ بيع منتج بالوزن</h2>
            <p className="hint">
              <b>{weightTarget.nameAr}</b> — اكتب المبلغ النهائي الذي استلمته من العميل؛ يُسجّل في الفاتورة كما هو بالضبط ويُستخرج الوزن تلقائيًا لخصم المخزون.
            </p>
            <Field label="السعر النهائي بالجنيه">
              <input
                aria-label="إجمالي سعر المنتج الموزون"
                value={weightTotalInput}
                onChange={(event) => setWeightTotalInput(event.target.value)}
                inputMode="decimal"
                dir="ltr"
                placeholder="مثال: 50"
                autoFocus
                required
              />
            </Field>
            <section className={`weight-sale-preview${weightPreview && !weightPreview.enoughStock ? " insufficient" : ""}`} aria-live="polite">
              {weightPreview ? <>
                <span>السعر الذي سيُسجل في الفاتورة</span><b>{formatMoney(weightPreview.totalMinor)}</b>
                <small>{weightPreview.enoughStock
                  ? `سيُخصم تقديريًا ${productQuantityLabel(weightTarget, weightPreview.qtyMilli)} من المخزون. بعد اعتماد الفاتورة سيبقى ${productQuantityLabel(weightTarget, weightPreview.remainingQtyMilli)}.`
                  : `المتاح حاليًا ${productQuantityLabel(weightTarget)} فقط؛ خفّض الوزن المطلوب.`}</small>
              </> : <small>أدخل سعرًا صحيحًا لعرض الوزن والرصيد المتبقي.</small>}
            </section>
            <div className="modal-actions">
              <button type="button" onClick={() => setWeightTarget(null)}>
                إلغاء
              </button>
              <button className="primary" disabled={!weightPreview || !weightPreview.enoughStock}>إضافة للسلة</button>
            </div>
          </form>
        </div>
      )}
      {packageTarget && (packageTarget.retailPackage || (packageTarget.cartonPriceMinor && packageTarget.purchasePackSize >= 2)) && (
        <div className="modal-backdrop">
          <div className="modal form-grid" role="dialog" aria-modal="true" aria-labelledby="pos-package-sale-title">
            <h2 id="pos-package-sale-title" className="full">طريقة بيع الصنف</h2>
            <p className="hint full">اختر ما تم بيعه من «{packageTarget.nameAr}». يظل الرصيد محسوباً بعدد الأكياس أو القطع الفعلية.</p>
            {packageTarget.cartonPriceMinor && packageTarget.purchasePackSize >= 2 && <button type="button" className="primary full" onClick={() => choosePackageSale("CARTON")}>كرتونة كاملة ({packageTarget.purchasePackSize} {packageTarget.cartonContentsUnit === "BAG" ? "كيس" : "قطعة"}) — {formatMoney(packageTarget.cartonPriceMinor)}</button>}
            {packageTarget.retailPackage && <button type="button" className={packageTarget.cartonPriceMinor ? "full" : "primary full"} onClick={() => choosePackageSale("PACKAGE")}>{retailPackageLabel(packageTarget)} كامل ({packageTarget.retailPackage.unitsPerPackage} {packageTarget.retailPackage.contentsUnit === "BAG" ? "كيس" : "قطعة"}) — {formatMoney(packageTarget.retailPackage.packagePriceMinor)}</button>}
            <button type="button" className="full" onClick={() => choosePackageSale("UNIT")}>{(packageTarget.retailPackage?.contentsUnit ?? packageTarget.cartonContentsUnit) === "BAG" ? "كيس فرط" : "قطعة فرط"} — {formatMoney(packageTarget.priceMinor)}</button>
            <div className="modal-actions full"><button type="button" onClick={closePackageSaleChoice}>إلغاء</button></div>
          </div>
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void postSale(event)}>
            <h2>تأكيد الدفع</h2>
            <div className="amount-due">
              {formatMoney(dialog.quote.totalMinor)}
            </div>
            <div className="payment-tabs">
              <button
                type="button"
                disabled={salePosting}
                className={dialog.method === "CASH" ? "selected" : ""}
                onClick={() => {
                  setCashReceived((dialog.quote.totalMinor / 100).toFixed(2));
                  setDialog({ ...dialog, method: "CASH" });
                }}
              >
                نقدي
              </button>
              <button
                type="button"
                disabled={salePosting}
                className={dialog.method === "CARD" ? "selected" : ""}
                onClick={() => setDialog({ ...dialog, method: "CARD" })}
              >
                بطاقة
              </button>
              <button
                type="button"
                disabled={salePosting}
                className={dialog.method === "KASHIER_POS_CARD" ? "selected" : ""}
                onClick={() => { setElectronicIntent(null); setDialog({ ...dialog, method: "KASHIER_POS_CARD" }); }}
              >
                Kashier POS
              </button>
              <button
                type="button"
                disabled={salePosting}
                className={dialog.method === "FAWRY_REFERENCE" ? "selected" : ""}
                onClick={() => { setElectronicIntent(null); setDialog({ ...dialog, method: "FAWRY_REFERENCE" }); }}
              >
                فوري
              </button>
              <button
                type="button"
                disabled={salePosting}
                className={dialog.method === "MIXED" ? "selected" : ""}
                onClick={() => setDialog({ ...dialog, method: "MIXED" })}
              >
                مختلط
              </button>
              <button
                type="button"
                disabled={salePosting}
                className={dialog.method === "CREDIT" ? "selected" : ""}
                onClick={() => setDialog({ ...dialog, method: "CREDIT" })}
              >
                آجل
              </button>
            </div>
            {dialog.method === "CASH" && (
              <>
                <Field label="المبلغ المستلم">
                  <input
                    name="received"
                    value={cashReceived}
                    onChange={(event) => setCashReceived(event.target.value)}
                    inputMode="decimal"
                    dir="ltr"
                    aria-describedby="cash-change-helper"
                    required
                  />
                </Field>
                <div
                  id="cash-change-helper"
                  className={`cash-change-helper ${cashChangeMinor !== null && cashChangeMinor < 0 ? "cash-change-short" : ""}`}
                  role="status"
                >
                  {cashChangeMinor !== null && cashChangeMinor >= 0 ? (
                    <>
                      <span>الباقي للعميل</span>
                      <b>{formatMoney(cashChangeMinor)}</b>
                    </>
                  ) : (
                    <>
                      <span>المتبقي على العميل</span>
                      <b>{formatMoney(Math.abs(cashChangeMinor ?? 0))}</b>
                    </>
                  )}
                  <small>مساعدة للحساب فقط؛ لا يُضاف كبند أو قيمة إلى الفاتورة.</small>
                </div>
              </>
            )}
            {dialog.method === "MIXED" && (
              <Field label="الجزء النقدي">
                <input
                  name="cash"
                  defaultValue="0.00"
                  inputMode="decimal"
                  dir="ltr"
                  required
                />
              </Field>
            )}
            {dialog.method === "CREDIT" && (
              <Field label="العميل">
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customers.map((customer) => ({
                    value: customer.id,
                    label: `${customer.name} — ${formatMoney(customer.balance_minor)}`,
                    searchText: customer.phone ?? "",
                  }))}
                  placeholder="ابحث باسم العميل أو هاتفه"
                  required
                />
              </Field>
            )}
            {dialog.method === "FAWRY_REFERENCE" && (
              <div className="payment-provider-status">
                <b>دفع فوري برقم مرجعي</b>
                <p>ينشئ البرنامج رقمًا مرجعيًا من فوري؛ لا تُسجل الفاتورة قبل أن يتحقق البرنامج من السداد.</p>
                {!electronicIntent && <div className="two-columns">
                  <Field label="اسم العميل (اختياري)"><input name="fawryCustomerName" autoComplete="name" /></Field>
                  <Field label="هاتف العميل"><input name="fawryCustomerMobile" inputMode="numeric" pattern="01[0-9]{9}" placeholder="01xxxxxxxxx" required /></Field>
                  <Field label="بريد العميل"><input name="fawryCustomerEmail" type="email" placeholder="name@example.com" required /></Field>
                </div>}
                {electronicIntent && <p dir="ltr">{electronicIntent.merchantOrderId} — {electronicIntent.status}{electronicIntent.deviceSerialNo ? ` — ${electronicIntent.deviceSerialNo}` : ""}</p>}
                {electronicIntent && electronicIntent.status !== "SUCCEEDED" && (
                  <button type="button" onClick={() => void verifyElectronicPayment()} disabled={salePosting}>تحقق من حالة الدفع</button>
                )}
              </div>
            )}
            {dialog.method === "KASHIER_POS_CARD" && (
              <div className="payment-provider-status">
                <b>دفع بالبطاقة أو NFC عبر ماكينة Kashier</b>
                <p>سيُرسل إجمالي الفاتورة إلى الماكينة المربوطة بهذه النقطة. لا تُسجل الفاتورة قبل وصول التأكيد الموثوق من Kashier.</p>
                {electronicIntent && <p dir="ltr">{electronicIntent.merchantOrderId} — {electronicIntent.status}{electronicIntent.deviceSerialNo ? ` — ${electronicIntent.deviceSerialNo}` : ""}</p>}
                {electronicIntent && electronicIntent.status !== "SUCCEEDED" && <button type="button" onClick={() => void verifyElectronicPayment()} disabled={salePosting}>تحقق من حالة الدفع</button>}
              </div>
            )}
            <label className="toggle-row">
              <input
                type="checkbox"
                name="printReceipt"
                defaultChecked={hardware.autoPrintReceipt && Boolean(hardware.receiptPrinterName)}
                disabled={salePosting || !hardware.receiptPrinterName}
              />
              <span>
                طباعة إيصال للعميل بعد إتمام البيع
                {!hardware.receiptPrinterName && " — اختر طابعة إيصالات أولًا"}
              </span>
            </label>
            <p className="hint">يمكن إنهاء هذه الفاتورة بدون ورق؛ تظل مسجلة ويمكن طباعتها لاحقًا من الفواتير.</p>
            <p className="hint">
              البطاقة هنا تسجيل محاسبي فقط؛ والآجل يخضع لحد ائتمان العميل.
            </p>
            <div className="modal-actions">
              <button type="button" disabled={salePosting} onClick={() => { setCashReceived(""); setDialog(null); }}>
                إلغاء
              </button>
              <button className="primary" disabled={salePosting}>
                {salePosting ? "جارٍ إصدار الفاتورة..." : "إصدار الفاتورة"}
              </button>
            </div>
          </form>
        </div>
      )}
      {receipt && (
        <div className="modal-backdrop">
          <section className="modal receipt" id="receipt">
            <h2>{storeName}</h2>
            <p>{receipt.invoiceNo}</p>
            <div className="amount-due">{formatMoney(receipt.totalMinor)}</div>
            <p>الباقي: {formatMoney(receipt.changeMinor)}</p>
            <p className="hint">
              {hardware.receiptPrinterName
                ? `الطابعة المختارة: ${hardware.receiptPrinterName}`
                : "اختر طابعة إيصالات من الإعدادات لتفعيل الطباعة المباشرة."}
            </p>
            <div className="modal-actions no-print">
              <button onClick={() => setReceipt(null)}>إغلاق</button>
              <button
                className="primary"
                disabled={receiptPrinting}
                onClick={() => void printCurrentReceipt()}
              >
                {receiptPrinting ? "جارٍ إرسال الطباعة..." : "طباعة"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function WeightLabelsScreen({
  products,
}: {
  products: CatalogProduct[];
}): ReactNode {
  const [weightedProducts, setWeightedProducts] = useState<CatalogProduct[]>(() =>
    products.filter((product) => product.unitKind === "WEIGHT"),
  );
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productId, setProductId] = useState("");
  const [mode, setMode] = useState<"AMOUNT" | "QUANTITY">("AMOUNT");
  const [value, setValue] = useState("");
  const [labels, setLabels] = useState<WeightedLabelResult[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const product = weightedProducts.find((item) => item.id === productId);

  const loadWeightedProducts = useCallback(async () => {
    try {
      setLoadingProducts(true);
      const all: CatalogProduct[] = [];
      let cursor: string | undefined;
      do {
        const page = await invoke<CatalogPage>({
          operation: "catalog.list",
          payload: { unitKind: "WEIGHT", limit: 200, ...(cursor ? { cursor } : {}) },
        });
        all.push(...page.products);
        cursor = page.nextCursor;
      } while (cursor);
      setWeightedProducts(all);
    } catch (cause) {
      setWeightedProducts(products.filter((item) => item.unitKind === "WEIGHT"));
      setMessage(errorMessage(cause));
    } finally {
      setLoadingProducts(false);
    }
  }, [products]);

  useEffect(() => {
    void loadWeightedProducts();
  }, [loadWeightedProducts]);

  const loadLabels = useCallback(async (nextProductId?: string) => {
    try {
      const result = await invoke<{ labels: WeightedLabelResult[] }>({ operation: "weighted-labels.list", payload: nextProductId ? { productId: nextProductId } : {} });
      setLabels(result.labels);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }, []);

  useEffect(() => { void loadLabels(productId || undefined); }, [loadLabels, productId]);

  async function createLabel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!product) { setMessage("اختر صنفًا موزونًا أولاً."); return; }
    try {
      setBusy(true);
      const payload = mode === "AMOUNT"
        ? { productId: product.id, mode, amountMinor: minorFromInput(value) }
        : { productId: product.id, mode, qtyMilli: isSmallMeasuredUnit(product.weightUnit) ? Number(value) : qtyFromInput(value) };
      if (mode === "QUANTITY" && (!Number.isSafeInteger(payload.qtyMilli!) || payload.qtyMilli! < 1)) throw new Error(isSmallMeasuredUnit(product.weightUnit) ? `أدخل عدد ${measurementUnitLabel(product.weightUnit)} كعدد صحيح.` : "أدخل كمية صحيحة.");
      const result = await invoke<{ label: WeightedLabelResult }>({ operation: "weighted-labels.create", payload });
      setLabels((items) => [result.label, ...items]);
      setValue("");
      setMessage(`تم حفظ ملصق ${result.label.barcode}. لا يُخصم المخزون إلا عند إتمام البيع.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function printLabel(label: WeightedLabelResult): Promise<void> {
    try {
      setBusy(true);
      const weightText = isSmallMeasuredUnit(label.weightUnit) ? `${label.qtyMilli} ${measurementUnitLabel(label.weightUnit)}` : `${(label.qtyMilli / 1000).toFixed(3)} ${measurementUnitLabel(label.weightUnit)}`;
      await printProductLabel(`${label.nameAr} — ${weightText}`, label.barcode, label.totalMinor);
      await invoke({ operation: "weighted-labels.mark-printed", payload: { barcode: label.barcode } });
      await loadLabels(productId || undefined);
      setMessage(`أُرسل ملصق «${label.nameAr}» للطباعة. سيظل متاحًا للطباعة مرة أخرى من هذا السجل.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="حاسبة الوزن والملصقات" subtitle="أنشئ ملصقًا للسائل أو العطارة أو الحلويات بحسب مبلغ العميل أو الوزن. الطباعة لا تخصم من المخزون؛ الخصم يتم عند مسح الملصق وإتمام البيع." />
      {message && <div className="notice">{message}</div>}
      <section className="settings-section">
        <form className="form-grid" onSubmit={(event) => void createLabel(event)}>
          <Field label="الصنف الموزون">
            <SearchableSelect value={productId} onChange={setProductId} options={weightedProducts.map((item) => ({ value: item.id, label: `${item.nameAr} — ${formatMoney(productDisplayPriceMinor(item))} / ${productUnitLabel(item)}`, searchText: `${item.category} ${item.barcodes.join(" ")}` }))} placeholder={loadingProducts ? "جارٍ تحميل أصناف الكيلو والجرام واللتر والملليلتر…" : "ابحث باسم الصنف أو التصنيف أو الباركود"} required />
          </Field>
          <Field label="طريقة الحساب">
            <select value={mode} onChange={(event) => setMode(event.target.value as "AMOUNT" | "QUANTITY")}>
              <option value="AMOUNT">العميل يريد بمبلغ</option>
              <option value="QUANTITY">أدخل الوزن مباشرة</option>
            </select>
          </Field>
          <Field label={mode === "AMOUNT" ? "مبلغ العميل بالجنيه" : `الكمية بـ${product ? measurementUnitLabel(product.weightUnit) : "الوحدة"}`}>
            <input value={value} onChange={(event) => setValue(event.target.value)} required autoFocus inputMode={mode === "AMOUNT" || !product || !isSmallMeasuredUnit(product.weightUnit) ? "decimal" : "numeric"} dir="ltr" placeholder={mode === "AMOUNT" ? "مثال: 100.00" : product && isSmallMeasuredUnit(product.weightUnit) ? "مثال: 250" : "مثال: 0.250"} />
          </Field>
          <div className="field full hint">{loadingProducts ? "يتم تحميل الأصناف الموزونة والسائلة من الخادم مباشرةً؛ لن يقتصر البحث على أول 60 صنفًا." : product ? `السعر الحالي: ${formatMoney(productDisplayPriceMinor(product))} لكل ${productUnitLabel(product)}. الرصيد: ${productQuantityLabel(product)}.` : weightedProducts.length ? "اكتب في البحث أو اختر صنفًا بالوزن أو السائل لتظهر طريقة الحساب والرصيد." : "لا توجد أصناف مسجلة للبيع بالكيلو أو الجرام أو اللتر أو الملليلتر بعد."}</div>
          <div className="modal-actions full"><button className="primary" disabled={busy || !product}>حفظ ملصق وزن جديد</button></div>
        </form>
      </section>
      <section className="settings-section">
        <h2>الملصقات المحفوظة</h2>
        <p className="hint">يمكنك إعادة الطباعة في أي وقت. الملصق الذي تم بيعه يظهر كمسجل ولا يمكن بيعه مرتين.</p>
        <div className="table-wrap"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الباركود</th><th>الحالة</th><th></th></tr></thead><tbody>
          {labels.map((label) => <tr key={label.barcode}><td>{label.nameAr}</td><td>{isSmallMeasuredUnit(label.weightUnit) ? `${label.qtyMilli} ${measurementUnitLabel(label.weightUnit)}` : `${(label.qtyMilli / 1000).toFixed(3)} ${measurementUnitLabel(label.weightUnit)}`}</td><td>{formatMoney(label.totalMinor)}</td><td className="ltr">{label.barcode}</td><td>{label.usedAt ? "تم البيع" : `جاهز للطباعة — ${label.printCount} مرة`}</td><td><button type="button" disabled={busy} onClick={() => void printLabel(label)}>طباعة</button></td></tr>)}
          {labels.length === 0 && <tr><td colSpan={6}>لا توجد ملصقات محفوظة لهذا الصنف.</td></tr>}
        </tbody></table></div>
      </section>
    </>
  );
}

function ProductsScreen({
  products,
  refresh,
  suggestedBarcode,
  clearSuggestedBarcode = () => undefined,
  canViewCost = false,
  canExport = false,
  editProductQuery = "",
  clearEditProductQuery = () => undefined,
  scannedProductQuery = "",
  clearScannedProductQuery = () => undefined,
  onEditProductByQuery = () => undefined,
  onProductCreated = (barcode: string) =>
    window.dispatchEvent(
      new CustomEvent("nabta:receipt-product-created", { detail: barcode }),
    ),
}: {
  products: CatalogProduct[];
  refresh: () => Promise<CatalogProduct[]>;
  suggestedBarcode?: string;
  clearSuggestedBarcode?: () => void;
  canViewCost?: boolean;
  canExport?: boolean;
  editProductQuery?: string;
  clearEditProductQuery?: () => void;
  scannedProductQuery?: string;
  clearScannedProductQuery?: () => void;
  onEditProductByQuery?: (query: string) => void;
  onProductCreated?: (barcode: string) => void;
}): ReactNode {
  const [show, setShow] = useState(false);
  const [newProductMode, setNewProductMode] = useState<ProductCreationMode>("PIECE");
  const [message, setMessage] = useState("");
  const [barcode, setBarcode] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>(products);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [availabilityFilter, setAvailabilityFilter] = useState<"ALL" | "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK">("ALL");
  const [unitFilter, setUnitFilter] = useState<"ALL" | "PIECE" | "WEIGHT">("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [minimumStock, setMinimumStock] = useState("");
  const [maximumPrice, setMaximumPrice] = useState("");
  const [reviewQueue, setReviewQueue] = useState<CatalogProduct[] | null>(null);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [resultsPage, setResultsPage] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [quickRestockProduct, setQuickRestockProduct] =
    useState<CatalogProduct | null>(null);
  const [quickUpdateProduct, setQuickUpdateProduct] = useState<CatalogProduct | null>(null);
  const [quickSaleUnit, setQuickSaleUnit] = useState<"PIECE" | "PACK" | "BAG" | "KILOGRAM">("PIECE");
  const [editingProduct, setEditingProduct] = useState<CatalogProduct | null>(null);
  const [cartonConversionProduct, setCartonConversionProduct] = useState<CatalogProduct | null>(null);
  const [editingMode, setEditingMode] = useState<ProductCreationMode>("PIECE");
  const [labelPrintProduct, setLabelPrintProduct] = useState<CatalogProduct | null>(null);
  const [productMenu, setProductMenu] = useState<{
    product: CatalogProduct;
    x: number;
    y: number;
  } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const productSearchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingProduct) setEditingMode(productEditorMode(editingProduct));
  }, [editingProduct]);
  useEffect(() => {
    if (!productMenu) return;
    const close = () => setProductMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [productMenu]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      if (event.key === "F2") {
        event.preventDefault();
        productSearchRef.current?.focus();
      } else if ((event.key === "F7" || event.code === "F7") && !editingProduct && !quickUpdateProduct) {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "INPUT" && target !== productSearchRef.current) return;
        event.preventDefault();
        openQuickProductUpdate();
      }
    }
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [editingProduct, quickUpdateProduct, productQuery, searchResults]);
  useEffect(() => {
    const barcode = scannedProductQuery.trim();
    if (!barcode) return;
    setProductQuery(barcode);
    window.setTimeout(() => productSearchRef.current?.focus(), 0);
    clearScannedProductQuery();
  }, [clearScannedProductQuery, scannedProductQuery]);
  useEffect(() => {
    const query = editProductQuery.trim();
    if (!query) return;
    setProductQuery(query);
    void invoke<{ products: CatalogProduct[] }>({
      operation: "catalog.list",
      payload: { query, limit: 10 },
    })
      .then((result) => {
        const exact = result.products.find((product) => product.barcodes.includes(query));
        const candidate = exact ?? (result.products.length === 1 ? result.products[0] : undefined);
        if (candidate) setEditingProduct(candidate);
        else setMessage("لم نتمكن من تحديد صنف واحد للتعديل. امسح الباركود كاملاً ثم اضغط F3.");
      })
      .catch((cause) => setMessage(errorMessage(cause)))
      .finally(clearEditProductQuery);
  }, [clearEditProductQuery, editProductQuery]);
  useEffect(() => {
    const query = productQuery.trim();
    if (!query) {
      setSearchResults(products);
      setIsSearching(false);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const timer = window.setTimeout(() => {
      void invoke<{ products: CatalogProduct[] }>({
        operation: "catalog.list",
        payload: { query },
      })
        .then((result) => {
          if (!cancelled) setSearchResults(result.products);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [productQuery, products]);
  useEffect(() => setResultsPage(0), [availabilityFilter, categoryFilter, maximumPrice, minimumStock, productQuery, products, unitFilter]);
  const productCategories = useMemo(
    () => [...new Set([...products, ...searchResults].map((product) => product.category))].sort((a, b) => a.localeCompare(b, "ar")),
    [products, searchResults],
  );
  const filteredSearchResults = useMemo(() => {
    const minStockMilli = minimumStock.trim() ? qtyFromInput(minimumStock) : null;
    const maxPriceMinor = maximumPrice.trim() ? minorFromInput(maximumPrice) : null;
    return searchResults.filter((product) => {
      if (categoryFilter !== "ALL" && product.category !== categoryFilter) return false;
      if (unitFilter !== "ALL" && product.unitKind !== unitFilter) return false;
      if (availabilityFilter === "IN_STOCK" && product.availableQtyMilli <= 0) return false;
      if (availabilityFilter === "OUT_OF_STOCK" && product.availableQtyMilli > 0) return false;
      if (availabilityFilter === "LOW_STOCK" && !(product.reorderLevelMilli > 0 && product.availableQtyMilli > 0 && product.availableQtyMilli <= product.reorderLevelMilli)) return false;
      if (minStockMilli !== null && product.availableQtyMilli < minStockMilli) return false;
      if (maxPriceMinor !== null && productDisplayPriceMinor(product) > maxPriceMinor) return false;
      return true;
    }).sort((left, right) => {
      const stockOrder = Number(right.availableQtyMilli > 0) - Number(left.availableQtyMilli > 0);
      if (stockOrder !== 0) return stockOrder;
      return left.nameAr.localeCompare(right.nameAr, "ar-EG");
    });
  }, [availabilityFilter, categoryFilter, maximumPrice, minimumStock, searchResults, unitFilter]);
  const searchResultsPageCount = Math.max(
    1,
    Math.ceil(filteredSearchResults.length / PRODUCTS_TABLE_PAGE_SIZE),
  );
  const activeResultsPage = Math.min(resultsPage, searchResultsPageCount - 1);
  const displayedSearchResults = filteredSearchResults.slice(
    activeResultsPage * PRODUCTS_TABLE_PAGE_SIZE,
    (activeResultsPage + 1) * PRODUCTS_TABLE_PAGE_SIZE,
  );
  const productsNeedingNumericBarcode = useMemo(
    () => filteredSearchResults.filter((product) => !hasScannerNumericBarcode(product.barcodes)),
    [filteredSearchResults],
  );

  function resetAdvancedFilters(): void {
    setAvailabilityFilter("ALL");
    setUnitFilter("ALL");
    setCategoryFilter("ALL");
    setMinimumStock("");
    setMaximumPrice("");
  }

  async function startAvailableReview(): Promise<void> {
    try {
      setReviewLoading(true);
      const all: CatalogProduct[] = [];
      let cursor: string | undefined;
      do {
        const page = await invoke<CatalogPage>({ operation: "catalog.list", payload: { limit: 200, ...(cursor ? { cursor } : {}) } });
        all.push(...page.products);
        cursor = page.nextCursor;
      } while (cursor);
      const available = all.filter((product) => product.availableQtyMilli > 0);
      if (available.length === 0) {
        setMessage("لا توجد أصناف متوفرة لمراجعتها الآن.");
        return;
      }
      setReviewQueue(available);
      setReviewIndex(0);
      setEditingProduct(available[0]!);
      setMessage(`بدأت مراجعة ${available.length} صنف متوفر. بعد الحفظ ينتقل النموذج تلقائيًا للصنف التالي.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setReviewLoading(false);
    }
  }

  function openQuickProductUpdate(explicitProduct?: CatalogProduct): void {
    const query = productQuery.trim();
    const exact = searchResults.find((product) => product.barcodes.includes(query));
    const product = explicitProduct ?? exact ?? (searchResults.length === 1 ? searchResults[0] : undefined);
    if (!product) {
      setMessage("ابحث بباركود كامل أو بنتيجة واحدة، ثم اضغط F7 للتعديل السريع.");
      return;
    }
    setQuickSaleUnit(product.unitKind === "WEIGHT" ? "KILOGRAM" : "PIECE");
    setQuickUpdateProduct(product);
  }

  async function quickUpdateProductStock(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!quickUpdateProduct) return;
    const data = new FormData(event.currentTarget);
    try {
      const quantityText = String(data.get("quantity") ?? "").trim();
      const qtyMilli = quickUpdateProduct.unitKind === "WEIGHT"
        ? qtyFromInput(quantityText)
        : Number(quantityText) * 1000;
      if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 0 ||
        (quickUpdateProduct.unitKind === "PIECE" && !Number.isInteger(Number(quantityText)))) {
        throw new Error(quickUpdateProduct.unitKind === "WEIGHT" ? "أدخل كمية بالكيلو صحيحة." : "أدخل عددًا صحيحًا من الوحدات.");
      }
      const totalWholesaleMinor = minorFromInput(String(data.get("totalWholesale") ?? ""));
      const priceMinor = minorFromInput(String(data.get("retailPrice") ?? ""));
      if (qtyMilli <= 0 || totalWholesaleMinor <= 0 || priceMinor <= 0)
        throw new Error("أدخل إجمالي الجملة والكمية وسعر البيع بقيم أكبر من صفر.");
      const unitWholesaleMinor = Math.floor((totalWholesaleMinor * 1000) / qtyMilli);
      await invoke({
        operation: "products.update",
        payload: {
          productId: quickUpdateProduct.id,
          nameAr: quickUpdateProduct.nameAr,
          category: quickUpdateProduct.category,
          description: quickUpdateProduct.description,
          priceMinor,
          wholesalePriceMinor: unitWholesaleMinor,
          purchasePackSize: quickUpdateProduct.purchasePackSize,
          mergeLegacyProducts: false,
          availableQtyMilli: qtyMilli,
          expectedStockVersion: quickUpdateProduct.version,
        },
      });
      await refresh();
      setMessage(`تم تحديث «${quickUpdateProduct.nameAr}» بسعر بيع ${formatMoney(priceMinor)} والكمية المتاحة.`);
      setQuickUpdateProduct(null);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function quickRestock(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!quickRestockProduct) return;
    const data = new FormData(event.currentTarget);
    try {
      const isGramProduct = quickRestockProduct.unitKind === "WEIGHT" && quickRestockProduct.weightUnit === "GRAM";
      const qtyMilli = isGramProduct
        ? Number(String(data.get("quantity")).trim())
        : qtyFromInput(String(data.get("quantity")));
      if (qtyMilli <= 0)
        throw new Error("أدخل كمية أكبر من صفر");
      if (isGramProduct && (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0))
        throw new Error("أدخل عدد الجرامات كعدد صحيح.");
      if (
        quickRestockProduct.unitKind === "PIECE" &&
        qtyMilli % 1000 !== 0
      )
        throw new Error("كمية القطع يجب أن تكون عدداً صحيحاً");
      await invoke({
        operation: "purchases.receive",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          receipt: {
            warehouseId: quickRestockProduct.warehouseId,
            supplierName: String(data.get("supplier")).trim() || "توريد سريع",
            supplyExpensesMinor: 0,
            lines: [
              {
                productId: quickRestockProduct.id,
                qtyMilli,
                unitCostMinor: minorFromInput(String(data.get("cost"))) * (isGramProduct ? 1000 : 1),
                entryUnit: quickRestockProduct.unitKind === "WEIGHT" ? "WEIGHT" : "PIECE",
                costBasis: "UNIT",
                retailPriceMinor: minorFromInput(String(data.get("retailPrice"))) * (isGramProduct ? 1000 : 1),
                ...(canViewCost ? { wholesalePriceMinor: minorFromInput(String(data.get("wholesalePrice"))) * (isGramProduct ? 1000 : 1) } : {}),
                lotCode: String(data.get("lot") || "").trim() || undefined,
                expiresOn: String(data.get("expires") || "") || undefined,
              },
            ],
          },
        },
      });
      await refresh();
      setQuickRestockProduct(null);
      setMessage(`تمت إضافة كمية «${quickRestockProduct.nameAr}» إلى المخزون.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function generateNumericBarcode(product: CatalogProduct): Promise<void> {
    try {
      const generated = await invoke<{ barcode: string; symbology: string }>({
        operation: "products.barcode.generate",
      });
      await invoke({
        operation: "products.barcode.attach",
        payload: { productId: product.id, barcode: generated.barcode },
      });
      await refresh();
      setMessage(`تمت إضافة باركود رقمي EAN-13 للصنف «${product.nameAr}»: ${generated.barcode}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function configurePackaging(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!cartonConversionProduct) return;
    const data = new FormData(event.currentTarget);
    try {
      const cartonCapacityText = String(data.get("cartonCapacity") || "").trim();
      const packageCapacityText = String(data.get("packageCapacity") || "").trim();
      const cartonPriceText = String(data.get("cartonPrice") || "").trim();
      const packagePriceText = String(data.get("packagePrice") || "").trim();
      const cartonEnabled = Boolean(cartonCapacityText || cartonPriceText || String(data.get("cartonBarcode") || "").trim());
      const packageEnabled = Boolean(packageCapacityText || packagePriceText || String(data.get("packageBarcode") || "").trim());
      const cartonCapacity = cartonEnabled ? Number(cartonCapacityText) : 1;
      const packageCapacity = packageEnabled ? Number(packageCapacityText) : 1;
      const cartonPriceMinor = cartonEnabled ? minorFromInput(cartonPriceText || "0") : null;
      const packagePriceMinor = packageEnabled ? minorFromInput(packagePriceText || "0") : 0;
      const cartonBarcode = String(data.get("cartonBarcode") || "").trim();
      const packageBarcode = String(data.get("packageBarcode") || "").trim();
      const unitBarcode = String(data.get("unitBarcode") || "").trim();
      if (cartonEnabled && (!Number.isInteger(cartonCapacity) || cartonCapacity < 2)) throw new Error("سعة الكرتونة يجب أن تكون عددًا صحيحًا لا يقل عن قطعتين.");
      if (cartonEnabled && !cartonPriceMinor) throw new Error("أدخل سعر بيع الكرتونة الكاملة أو اترك بياناتها كلها فارغة.");
      if (packageEnabled && (!Number.isInteger(packageCapacity) || packageCapacity < 2)) throw new Error("سعة العبوة/الكيس يجب أن تكون عددًا صحيحًا لا يقل عن قطعتين.");
      if (packageEnabled && packagePriceMinor <= 0) throw new Error("أدخل سعر بيع العبوة/الكيس أو اترك بياناتها كلها فارغة.");
      if (cartonEnabled && packageEnabled && packageCapacity > cartonCapacity) throw new Error("سعة الكيس لا يمكن أن تكون أكبر من سعة الكرتونة.");
      const barcodeMappings = [
        ...(unitBarcode ? [{ barcode: unitBarcode, saleUnit: "UNIT" as const }] : []),
        ...(packageEnabled && packageBarcode ? [{ barcode: packageBarcode, saleUnit: "PACKAGE" as const }] : []),
        ...(cartonEnabled && cartonBarcode ? [{ barcode: cartonBarcode, saleUnit: "CARTON" as const }] : []),
      ];
      await invoke({
        operation: "products.update",
        payload: {
          productId: cartonConversionProduct.id,
          nameAr: cartonConversionProduct.nameAr,
          category: cartonConversionProduct.category,
          description: cartonConversionProduct.description,
          priceMinor: cartonConversionProduct.priceMinor,
          ...(canViewCost ? { wholesalePriceMinor: cartonConversionProduct.wholesalePriceMinor ?? 0 } : {}),
          purchasePackSize: cartonEnabled ? cartonCapacity : packageEnabled ? packageCapacity : 1,
          cartonPriceMinor,
          cartonContentsUnit: cartonEnabled ? String(data.get("cartonContentsUnit")) as "PIECE" | "BAG" : null,
          retailPackage: packageEnabled ? {
            unitsPerPackage: packageCapacity,
            packagePriceMinor,
            contentsUnit: String(data.get("packageContentsUnit")) as "PIECE" | "BAG",
            label: "PACKAGE" as const,
          } : null,
          barcodeMappings,
          mergeLegacyProducts: true,
          availableQtyMilli: cartonConversionProduct.availableQtyMilli,
          expectedStockVersion: cartonConversionProduct.version,
        },
      });
      await refresh();
      setCartonConversionProduct(null);
      setMessage(`تم حفظ تغليف «${cartonConversionProduct.nameAr}». لم يتغير رصيد المخزون؛ أصبح البيع بالقطعة والكيس والكرتونة من نفس الرصيد.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function fillReference(value: string): Promise<void> {
    const code = value.trim();
    if (!code) return;
    try {
      const reference = await invoke<ProductReference>({
        operation: "products.reference.lookup",
        payload: { barcode: code },
      });
      setBarcode(reference.barcode);
      window.setTimeout(() => {
        const form =
          document.querySelector<HTMLFormElement>(".modal.form-grid");
        const name = document.querySelector<HTMLInputElement>(
          ".modal input[name=nameAr]",
        );
        const category = document.querySelector<HTMLInputElement>(
          ".modal input[name=category]",
        );
        if (name) name.value = reference.nameAr;
        if (category)
          category.value = [reference.category, reference.subcategory]
            .filter(Boolean)
            .join(" — ");
        if (form) {
          let summary = form.querySelector<HTMLElement>(".reference-summary");
          if (!summary) {
            summary = document.createElement("div");
            summary.className = "reference-summary full";
            form.prepend(summary);
          }
          summary.replaceChildren();
          if (reference.imageUrl) {
            const image = document.createElement("img");
            image.className = "reference-image";
            image.src = reference.imageUrl;
            image.alt = reference.nameAr;
            image.addEventListener("error", () => image.remove());
            summary.append(image);
          }
          const text = document.createElement("span");
          text.textContent = [
            "دليل الصنف",
            reference.manufacturer,
            reference.size,
            reference.description,
            reference.notes,
          ]
            .filter(Boolean)
            .join(" • ");
          summary.append(text);
        }
      }, 0);
      const details = [
        reference.manufacturer,
        reference.size,
        reference.description,
      ]
        .filter(Boolean)
        .join(" • ");
      setMessage(
        `تمت تعبئة اسم الصنف وتصنيفه من دليل الأصناف. ${details || "أدخل الكمية وسعري الشراء والبيع فقط."}`,
      );
    } catch {
      setMessage(
        "لا توجد بيانات مرجعية لهذا الباركود؛ أدخل بيانات الصنف يدويًا.",
      );
    }
  }
  useEffect(() => {
    if (suggestedBarcode) {
      setBarcode(suggestedBarcode);
      setNewProductMode("PIECE");
      setShow(true);
      void fillReference(suggestedBarcode);
    }
  }, [suggestedBarcode]);
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const isWeightedMode = newProductMode === "KILOGRAM" || newProductMode === "GRAM" || newProductMode === "LITER" || newProductMode === "MILLILITER";
      const weightUnit = newProductMode === "GRAM" ? "GRAM" : newProductMode === "LITER" ? "LITER" : newProductMode === "MILLILITER" ? "MILLILITER" : "KILOGRAM";
      const unitKind = isWeightedMode ? "WEIGHT" : "PIECE";
      const cartonCount = Number(data.get("openingCartons") || 0);
      const supportsLooseContainerStock = newProductMode === "CARTON" || newProductMode === "PLATE_CARTON";
      const looseUnits = supportsLooseContainerStock ? Number(data.get("openingLooseUnits") || 0) : 0;
      const looseStacks = newProductMode === "PLATE_CARTON" ? Number(data.get("openingLooseStacks") || 0) : 0;
      const stackSize = newProductMode === "PLATE_CARTON" ? Number(data.get("stackSize") || 0) : 0;
      const stacksPerCarton = newProductMode === "PLATE_CARTON" ? Number(data.get("stacksPerCarton") || 0) : 0;
      const purchasePackSize = newProductMode === "CARTON" || newProductMode === "PACKAGE" || newProductMode === "PLATE_CARTON"
        ? newProductMode === "PLATE_CARTON" ? stacksPerCarton * stackSize : Number(data.get("purchasePackSize") || 0)
        : 1;
      const totalContainerUnits = newProductMode === "PLATE_CARTON"
        ? cartonCount * purchasePackSize + looseStacks * stackSize + looseUnits
        : cartonCount * purchasePackSize + looseUnits;
      if (newProductMode !== "PLATE_CARTON" && (newProductMode === "CARTON" || newProductMode === "PACKAGE") &&
        (!Number.isInteger(purchasePackSize) || purchasePackSize < 1 ||
          (supportsLooseContainerStock
            ? (!Number.isFinite(cartonCount) || cartonCount < 0 || !Number.isInteger(cartonCount * 2) || !Number.isInteger(looseUnits) || looseUnits < 0 || looseUnits >= purchasePackSize || !Number.isInteger(totalContainerUnits) || totalContainerUnits < 1)
            : (!Number.isInteger(cartonCount) || cartonCount < 1))))
        throw new Error("أدخل عدد الكراتين والفرط بصورة صحيحة؛ يسمح بنصف كرتونة فقط إذا كان الناتج عدد أكياس/عبوات صحيحًا، والفرط أقل من السعة.");
      if (newProductMode === "PLATE_CARTON") {
        const stackPriceMinor = minorFromInput(String(data.get("stackPrice") || "0"));
        if (!Number.isInteger(cartonCount) || cartonCount < 0 || !Number.isInteger(stacksPerCarton) || stacksPerCarton < 1 || !Number.isInteger(stackSize) || stackSize < 2 || !Number.isInteger(looseStacks) || looseStacks < 0 || looseStacks >= stacksPerCarton || !Number.isInteger(looseUnits) || looseUnits < 0 || looseUnits >= stackSize || !Number.isSafeInteger(totalContainerUnits) || totalContainerUnits < 1 || stackPriceMinor <= 0) {
          throw new Error("أدخل الكراتين والأعمدة والأكواب/الأطباق الفرط بصورة صحيحة. الكرتونة = عدد الأعمدة × سعة العمود.");
        }
      }
      const rawWeightQty = Number(data.get("openingQty") || 0);
      if ((newProductMode === "GRAM" || newProductMode === "MILLILITER") &&
        (!Number.isSafeInteger(rawWeightQty) || rawWeightQty < 0))
        throw new Error("أدخل عدد الجرامات كعدد صحيح.");
      const qtyMilli = newProductMode === "CARTON" || newProductMode === "PACKAGE" || newProductMode === "PLATE_CARTON"
        ? totalContainerUnits * 1000
        : newProductMode === "GRAM" || newProductMode === "MILLILITER"
          ? rawWeightQty
        : qtyFromInput(String(data.get("openingQty") || "0"));
      const cartonTotalCostMinor = newProductMode === "CARTON" || newProductMode === "PACKAGE" || newProductMode === "PLATE_CARTON"
        ? minorFromInput(String(data.get("cartonTotalWholesale") || "0"))
        : undefined;
      const enteredWholesaleMinor = canViewCost
        ? minorFromInput(String(data.get("wholesalePrice") || "0"))
        : 0;
      const wholesalePriceMinor = newProductMode === "CARTON" || newProductMode === "PACKAGE" || newProductMode === "PLATE_CARTON"
        ? Math.floor((cartonTotalCostMinor! * 1000) / qtyMilli)
        : newProductMode === "GRAM" || newProductMode === "MILLILITER"
          ? enteredWholesaleMinor * 1000
          : enteredWholesaleMinor;
      if (qtyMilli > 0 && wholesalePriceMinor <= 0)
        throw new Error("أدخل سعر الجملة أولاً لحفظ كمية متاحة بقيمة صحيحة.");
      const requestedBarcode = String(data.get("unitBarcode") ?? barcode).trim();
      const generatedBarcode = requestedBarcode
        ? undefined
        : await invoke<{ barcode: string; symbology: string }>({ operation: "products.barcode.generate" });
      const createdBarcode = requestedBarcode || generatedBarcode!.barcode;
      const packageBarcode = String(data.get("packageBarcode") ?? "").trim();
      const cartonBarcode = String(data.get("cartonBarcode") ?? "").trim();
      const cartonPriceMinor = newProductMode === "CARTON" || newProductMode === "PLATE_CARTON"
        ? (() => { const value = minorFromInput(String(data.get("cartonPrice") || "0")); return value > 0 ? value : undefined; })()
        : undefined;
      const barcodeMappings = [
        ...(createdBarcode !== packageBarcode && (createdBarcode !== cartonBarcode || !cartonPriceMinor) ? [{ barcode: createdBarcode, saleUnit: "UNIT" as const }] : []),
        ...(packageBarcode ? [{ barcode: packageBarcode, saleUnit: "PACKAGE" as const }] : []),
        ...(cartonBarcode && cartonPriceMinor ? [{ barcode: cartonBarcode, saleUnit: "CARTON" as const }] : []),
      ];
      const enteredPriceMinor = minorFromInput(String(data.get(newProductMode === "CARTON" || newProductMode === "PLATE_CARTON" ? "piecePrice" : newProductMode === "PACKAGE" ? "unitPrice" : "price")));
      const priceMinor = newProductMode === "GRAM" || newProductMode === "MILLILITER"
        ? enteredPriceMinor * 1000
        : enteredPriceMinor;
      const nameAr = String(data.get("nameAr"));
      await invoke({
        operation: "products.create",
        payload: {
          nameAr,
          category: String(data.get("category")),
          unitKind,
          weightUnit,
          priceMinor,
          wholesalePriceMinor,
          purchasePackSize,
          ...(newProductMode === "PACKAGE" ? { retailPackage: { unitsPerPackage: purchasePackSize, packagePriceMinor: minorFromInput(String(data.get("packagePrice") || "")), contentsUnit: String(data.get("packageContentsUnit")) as "PIECE" | "BAG", label: String(data.get("packageLabel")) as "PACKAGE" | "PACKET" } } : {}),
          ...(newProductMode === "PLATE_CARTON" ? { retailPackage: { unitsPerPackage: stackSize, packagePriceMinor: minorFromInput(String(data.get("stackPrice") || "0")), contentsUnit: "PIECE" as const, label: "STACK" as const } } : {}),
          ...(cartonPriceMinor !== undefined ? { cartonPriceMinor } : {}),
          ...(newProductMode === "CARTON" || newProductMode === "PLATE_CARTON" ? { cartonContentsUnit: newProductMode === "PLATE_CARTON" ? "PIECE" as const : String(data.get("cartonContentsUnit")) as "PIECE" | "BAG" } : {}),
          reorderLevelMilli: 0,
          barcodes: barcodeMappings.map((item) => item.barcode),
          barcodeMappings,
          openingQtyMilli: qtyMilli,
          openingUnitCostMinor: qtyMilli > 0 ? wholesalePriceMinor : 0,
          ...(cartonTotalCostMinor !== undefined ? { openingTotalCostMinor: cartonTotalCostMinor } : {}),
        },
      });
      setShow(false);
      setNewProductMode("PIECE");
      setBarcode("");
      clearSuggestedBarcode();
      await refresh();
      setMessage("تم حفظ الصنف والكمية المتاحة، وبقيت في نفس مسار العمل.");
      if (suggestedBarcode) onProductCreated(createdBarcode);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function exportProducts(mode: "PUBLIC" | "INTERNAL"): Promise<void> {
    try {
      const query = productQuery.trim();
      const result = await invoke<{ cancelled: boolean; path?: string; itemCount: number }>({
        operation: "products.export",
        payload: { mode, availableOnly: false, ...(query ? { query } : {}) },
      });
      setMessage(result.cancelled
        ? "تم إلغاء حفظ ملف Excel."
        : `تم حفظ ملف Excel (${result.itemCount} صنف): ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function exportProductSyncWorkbook(): Promise<void> {
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; itemCount: number }>({
        operation: "products.sync-workbook.export",
        payload: { mode: "INTERNAL", availableOnly: false },
      });
      setMessage(result.cancelled
        ? "تم إلغاء حفظ قالب التعديل."
        : `تم حفظ قالب تعديل الأصناف (${result.itemCount} صنف). عدّل الملف ثم استورده من هنا: ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function printSearchedProductLabel(
    product: CatalogProduct,
    barcodeToPrint?: string,
    copies = 1,
    hidePrice = shouldHidePriceOnProductLabel(product),
  ): Promise<void> {
    const barcode = (barcodeToPrint || product.barcodes[0] || "").trim();
    if (!barcode) {
      setMessage("لا يوجد باركود لهذا الصنف لطباعة الملصق.");
      return;
    }
    try {
      const hardware = await invoke<HardwareSettings>({ operation: "hardware.settings.get" });
      if (!hardware.barcodePrinterName) {
        setMessage("اختر طابعة الباركود Xprinter XP-233B من الإعدادات أولًا.");
        return;
      }
      if (hardware.barcodePrinterName === hardware.receiptPrinterName) {
        setMessage("طابعة الباركود وطابعة الإيصالات متطابقتان. اختر طابعتين مختلفتين من الإعدادات.");
        return;
      }
      const result = await printProductLabel(product.nameAr, barcode, product.priceMinor, copies, hidePrice);
      setMessage(`أُرسل ${copies} ملصق لصنف «${product.nameAr}» بالباركود [${barcode}] إلى ${result.printerName}.`);
    } catch (cause) {
      const failure = cause as Partial<ApiFailure>;
      setMessage(
        failure.code === "CLIENT_ERROR"
          ? "تعذر الاتصال بوحدة طباعة الملصقات. افتح الإعدادات واحفظ طابعة الباركود ثم أعد المحاولة."
          : errorMessage(cause),
      );
    }
  }
  async function updateProduct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editingProduct) return;
    const data = new FormData(event.currentTarget);
    try {
      const isPieceMode = editingProduct.unitKind === "PIECE";
      const stackSize = editingMode === "PLATE_CARTON" ? Number(data.get("stackSize")) : 0;
      const stacksPerCarton = editingMode === "PLATE_CARTON" ? Number(data.get("stacksPerCarton")) : 0;
      const purchasePackSize = isPieceMode && editingMode !== "PIECE"
        ? editingMode === "PLATE_CARTON" ? stacksPerCarton * stackSize : Number(data.get("purchasePackSize"))
        : 1;
      if (!Number.isInteger(purchasePackSize) || purchasePackSize < 1) {
        throw new Error("أدخل سعة صحيحة للعبوة أو الكرتونة.");
      }
      const usesContainerStock = isPieceMode && editingMode !== "PIECE";
      const availableQtyMilli = usesContainerStock
        ? (() => {
          const containers = Number(data.get("availableCartons"));
          const looseUnits = Number(data.get("availableLooseUnits"));
          const looseStacks = editingMode === "PLATE_CARTON" ? Number(data.get("availableLooseStacks")) : 0;
          const totalUnits = editingMode === "PLATE_CARTON"
            ? containers * purchasePackSize + looseStacks * stackSize + looseUnits
            : containers * purchasePackSize + looseUnits;
          const invalidFoamStock = editingMode === "PLATE_CARTON" && (!Number.isInteger(containers) || !Number.isInteger(stacksPerCarton) || stacksPerCarton < 1 || !Number.isInteger(stackSize) || stackSize < 2 || !Number.isInteger(looseStacks) || looseStacks < 0 || looseStacks >= stacksPerCarton || !Number.isInteger(looseUnits) || looseUnits < 0 || looseUnits >= stackSize);
          if (!Number.isFinite(containers) || containers < 0 || invalidFoamStock || (editingMode !== "PLATE_CARTON" && (!Number.isInteger(looseUnits) || looseUnits < 0 || looseUnits >= purchasePackSize)) || !Number.isInteger(totalUnits)) {
            throw new Error("أدخل عدد الكراتين والفرط بصورة صحيحة؛ يسمح بنصف كرتونة فقط إذا كان الناتج عدد أكياس/عبوات صحيحًا، والفرط أقل من السعة.");
          }
          return totalUnits * 1000;
        })()
        : editingProduct.unitKind === "WEIGHT" && isSmallMeasuredUnit(editingProduct.weightUnit)
          ? Number(String(data.get("availableQuantity")))
          : qtyFromInput(String(data.get("availableQuantity")));
      if (!Number.isSafeInteger(availableQtyMilli) || availableQtyMilli < 0) {
        throw new Error(isSmallMeasuredUnit(editingProduct.weightUnit) ? `أدخل عدد ${measurementUnitLabel(editingProduct.weightUnit)} كعدد صحيح.` : "أدخل كمية صحيحة.");
      }
      if (editingProduct.unitKind === "PIECE" && availableQtyMilli % 1000 !== 0) {
        throw new Error("كمية صنف القطعة يجب أن تكون عدداً صحيحاً");
      }
      const usesCarton = editingMode === "CARTON" || editingMode === "PLATE_CARTON";
      const enteredCartonPriceMinor = minorFromInput(String(data.get("cartonPrice") || "0"));
      const cartonPriceMinor = isPieceMode ? (usesCarton ? (enteredCartonPriceMinor > 0 ? enteredCartonPriceMinor : null) : null) : undefined;
      const cartonContentsUnit = isPieceMode ? (usesCarton ? (editingMode === "PLATE_CARTON" ? "PIECE" : String(data.get("cartonContentsUnit")) as "PIECE" | "BAG") : null) : undefined;
      if (usesCarton && purchasePackSize < 2) {
        throw new Error("أدخل سعة كرتونة لا تقل عن 2.");
      }
      const retailPackage = editingMode === "PACKAGE"
        ? {
          unitsPerPackage: purchasePackSize,
          packagePriceMinor: minorFromInput(String(data.get("packagePrice"))),
          contentsUnit: String(data.get("packageContentsUnit")) as "PIECE" | "BAG",
          // Older package records did not have a label selector in the edit
          // form.  Keep them editable by falling back to their stored label
          // (and then to the normal package label) instead of sending
          // `"null"` to the API schema.
          label: (String(data.get("packageLabel") ?? "") || editingProduct.retailPackage?.label || "PACKAGE") as "PACKAGE" | "PACKET",
        }
        : editingMode === "PLATE_CARTON"
          ? {
            unitsPerPackage: stackSize,
            packagePriceMinor: minorFromInput(String(data.get("stackPrice"))),
            contentsUnit: "PIECE" as const,
            label: "STACK" as const,
          }
          : null;
      if (retailPackage && (!Number.isInteger(retailPackage.unitsPerPackage) || retailPackage.unitsPerPackage < 2 || retailPackage.unitsPerPackage > purchasePackSize || (editingMode === "PLATE_CARTON" && purchasePackSize % retailPackage.unitsPerPackage !== 0) || retailPackage.packagePriceMinor <= 0)) {
        throw new Error("أدخل محتوى العبوة أو العمود وسعر بيعه بصورة صحيحة.");
      }
      const salePriceField = editingMode === "PACKAGE" ? "unitPrice" : editingMode === "CARTON" || editingMode === "PLATE_CARTON" ? "piecePrice" : "price";
      const enteredPriceMinor = minorFromInput(String(data.get(salePriceField)));
      const packageBarcode = String(data.get("packageBarcode") ?? "").trim();
      const cartonBarcode = String(data.get("cartonBarcode") ?? "").trim();
      const barcodeMappings = isPieceMode && editingMode !== "PIECE" ? [
        ...(packageBarcode ? [{ barcode: packageBarcode, saleUnit: "PACKAGE" as const }] : []),
        ...(cartonBarcode && cartonPriceMinor ? [{ barcode: cartonBarcode, saleUnit: "CARTON" as const }] : []),
      ] : undefined;
      await invoke({
        operation: "products.update",
        payload: {
          productId: editingProduct.id,
          nameAr: String(data.get("nameAr")).trim(),
          category: String(data.get("category")).trim(),
          description: String(data.get("description")).trim(),
          priceMinor: enteredPriceMinor * (isSmallMeasuredUnit(editingProduct.weightUnit) ? 1000 : 1),
          ...(canViewCost ? { wholesalePriceMinor: minorFromInput(String(data.get("wholesalePrice"))) * (isSmallMeasuredUnit(editingProduct.weightUnit) ? 1000 : 1) } : {}),
          purchasePackSize,
          ...(cartonPriceMinor !== undefined ? { cartonPriceMinor } : {}),
          ...(cartonContentsUnit !== undefined ? { cartonContentsUnit } : {}),
          retailPackage,
          ...(barcodeMappings ? { barcodeMappings } : {}),
          mergeLegacyProducts: true,
          availableQtyMilli,
          expectedStockVersion: editingProduct.version,
        },
      });
      await refresh();
      const nextIndex = reviewQueue && reviewQueue[reviewIndex]?.id === editingProduct.id
        ? reviewIndex + 1
        : -1;
      if (reviewQueue && nextIndex >= 0 && nextIndex < reviewQueue.length) {
        setReviewIndex(nextIndex);
        setEditingProduct(reviewQueue[nextIndex]!);
        setMessage(`تم حفظ «${editingProduct.nameAr}». التالي: ${reviewQueue[nextIndex]!.nameAr} (${nextIndex + 1} من ${reviewQueue.length}).`);
      } else {
        setEditingProduct(null);
        if (reviewQueue) {
          setReviewQueue(null);
          setReviewIndex(0);
          setMessage(`اكتملت مراجعة ${reviewQueue.length} صنف متوفر وتم تأكيد التعديلات.`);
        } else {
          setMessage(`تم حفظ بيانات «${editingProduct.nameAr}» وتوثيق أي تعديل في الكمية بحركة جرد.`);
        }
      }
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function archiveProduct(product: CatalogProduct): Promise<void> {
    const confirmed = window.confirm(
      `هل تريد حذف الصنف «${product.nameAr}» من قائمة الأصناف؟\n\nلن تُحذف الفواتير أو الحركات السابقة. لا يمكن حذف الصنف إذا كان له رصيد متاح.`,
    );
    if (!confirmed) return;
    try {
      const result = await invoke<{ purged?: boolean }>({
        operation: "products.archive",
        payload: { productId: product.id },
      });
      await refresh();
      setMessage(result.purged
        ? `تم حذف «${product.nameAr}» نهائياً من قاعدة البيانات لأنه لم يكن له أي حركة أو فاتورة.`
        : `تم إخفاء «${product.nameAr}» مع الاحتفاظ بسجل الحركات السابق. إدخال الباركود نفسه مرة أخرى سيعيد تفعيله ويحدّثه تلقائياً.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function importProducts(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith(".xlsx")) {
        const workbookBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error("تعذر قراءة ملف Excel."));
          reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            const comma = result.indexOf(",");
            if (comma < 0) reject(new Error("تعذر قراءة ملف Excel."));
            else resolve(result.slice(comma + 1));
          };
          reader.readAsDataURL(file);
        });
        const preview = await invoke<{ rowCount: number; errors: string[] }>({
          operation: "products.import-workbook",
          payload: { idempotencyKey: crypto.randomUUID(), workbookBase64, preview: true },
        });
        if (preview.errors.length) {
          setMessage("رفضت المعاينة: " + preview.errors.join(" | "));
          return;
        }
        if (!window.confirm(`تمت معاينة ${preview.rowCount} صفاً من ملف Excel. سيُحدَّث الصنف عند وجود الباركود أو يُنشأ عند كونه جديداً. هل تريد الاستيراد؟`)) return;
        const result = await invoke<{ importedCount: number; createdCount: number; updatedCount: number }>({
          operation: "products.import-workbook",
          payload: { idempotencyKey: crypto.randomUUID(), workbookBase64, preview: false },
        });
        await refresh();
        setMessage(`تم استيراد ${result.importedCount} صفاً: ${result.createdCount} صنف جديد و${result.updatedCount} صنف تم تحديثه بالباركود.`);
        return;
      }
      const csv = await file.text();
      const preview = await invoke<{ rowCount: number; errors: string[] }>({
        operation: "products.import",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          request: { csv, preview: true },
        },
      });
      if (preview.errors.length) {
        setMessage("رفضت المعاينة: " + preview.errors.join(" | "));
        return;
      }
      if (
        !window.confirm(
          "تمت معاينة " + preview.rowCount + " صنف. هل تريد الاستيراد؟",
        )
      )
        return;
      const result = await invoke<{ importedCount: number; createdCount?: number; updatedCount?: number }>({
        operation: "products.import",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          request: { csv, preview: false },
        },
      });
      await refresh();
      setMessage(result.createdCount === undefined
        ? "تم استيراد " + result.importedCount + " صنفاً بعد التحقق."
        : `تم استيراد ${result.importedCount} صفاً: ${result.createdCount} جديد و${result.updatedCount} تم تحديثه بالباركود.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  function openLabelEditor(product: CatalogProduct): void {
    document
      .querySelector<HTMLDialogElement>("#nabta-product-label-editor")
      ?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "nabta-product-label-editor";
    dialog.className = "label-editor";
    const barcode = product.barcodes[0] ?? "";
    const wholesaleInput = canViewCost ? `<label>سعر الجملة الداخلي بالجنيه<input name="wholesalePrice" inputmode="decimal" dir="ltr" required></label>` : "";
    dialog.innerHTML = `<form method="dialog"><header><div><h2></h2><p>يتغير سعر البيع للمبيعات الجديدة فقط؛ الفواتير السابقة لا تتغير.</p></div><button type="button" class="label-editor-close" aria-label="إغلاق">×</button></header><label>سعر البيع بالجنيه<input name="price" inputmode="decimal" dir="ltr" required></label>${wholesaleInput}<label class="label-editor-price-visibility"><input name="showPrice" type="checkbox" ${shouldHidePriceOnProductLabel(product) ? "" : "checked"}> إظهار سعر البيع على الملصق</label><p class="label-editor-code" dir="ltr"></p><footer><button type="button" class="label-editor-save">حفظ السعر</button><button type="button" class="primary label-editor-print">حفظ وطباعة ملصق</button></footer><p class="label-editor-status" role="alert"></p></form>`;
    dialog.querySelector("h2")!.textContent = product.nameAr;
    const price = dialog.querySelector<HTMLInputElement>("input[name=price]")!;
    price.value = (product.priceMinor / 100).toFixed(2);
    const showPrice = dialog.querySelector<HTMLInputElement>("input[name=showPrice]")!;
    const wholesalePrice = dialog.querySelector<HTMLInputElement>("input[name=wholesalePrice]");
    if (wholesalePrice) wholesalePrice.value = ((product.wholesalePriceMinor ?? 0) / 100).toFixed(2);
    dialog.querySelector(".label-editor-code")!.textContent = barcode
      ? `الباركود: ${barcode}`
      : "لا يوجد باركود قابل للطباعة لهذا الصنف";
    const status = dialog.querySelector<HTMLElement>(".label-editor-status")!;
    const close = () => dialog.close();
    const save = async (shouldPrint: boolean): Promise<void> => {
      try {
        const priceMinor = minorFromInput(price.value);
        if (priceMinor <= 0)
          throw new Error("سعر البيع يجب أن يكون أكبر من صفر");
        status.textContent = "جارٍ حفظ السعر…";
        const wholesalePriceMinor = wholesalePrice ? minorFromInput(wholesalePrice.value) : undefined;
        await invoke({
          operation: "products.price.update",
          payload: { productId: product.id, priceMinor, ...(wholesalePriceMinor !== undefined ? { wholesalePriceMinor } : {}) },
        });
        await refresh();
        setMessage(
          `تم تحديث سعر «${product.nameAr}» إلى ${formatMoney(priceMinor)}. الفواتير السابقة لم تتغير.`,
        );
        if (shouldPrint) {
          if (!barcode)
            throw new Error("لا يوجد باركود لهذا الصنف لطباعة الملصق");
          await printProductLabel(product.nameAr, barcode, priceMinor, 1, !showPrice.checked);
        }
        close();
      } catch (cause) {
        status.textContent = errorMessage(cause);
      }
    };
    dialog
      .querySelector(".label-editor-close")!
      .addEventListener("click", close);
    dialog
      .querySelector(".label-editor-save")!
      .addEventListener("click", () => {
        void save(false);
      });
    dialog
      .querySelector(".label-editor-print")!
      .addEventListener("click", () => {
        void save(true);
      });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    price.focus();
    price.select();
  }
  return (
    <>
      <PageHead
        title="الأصناف"
        subtitle="الباركود نص دقيق؛ المخزون يتغير بحركة مسجلة فقط."
        action={
          <div className="actions">
            {canExport && <button onClick={() => void exportProducts("PUBLIC")}>تصدير أسعار Excel</button>}
            {canExport && canViewCost && <button onClick={() => void exportProducts("INTERNAL")}>تصدير جملة Excel</button>}
            {canExport && canViewCost && <button type="button" className="primary" onClick={() => void exportProductSyncWorkbook()}>تصدير قالب جميع المنتجات Excel</button>}
            <button onClick={() => importRef.current?.click()}>
              استيراد Excel / CSV
            </button>
            <button type="button" onClick={() => void startAvailableReview()} disabled={reviewLoading}>
              {reviewLoading ? "جارٍ تجهيز المراجعة…" : "مراجعة المتوفر"}
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
              hidden
              onChange={(event) => void importProducts(event)}
            />
            <button
              className="primary"
              onClick={() => {
                setBarcode("");
                setNewProductMode("PIECE");
                clearSuggestedBarcode();
                setShow(true);
              }}
            >
              إضافة صنف
            </button>
          </div>
        }
      />
      {message && <div className="notice">{message}</div>}
      {productsNeedingNumericBarcode.length > 0 && (
        <div className="notice warning" role="status">
          يوجد {productsNeedingNumericBarcode.length} صنف ظاهر لا يملك باركودًا رقميًا مناسبًا للسكانر. استخدم زر «توليد باركود رقمي» بجانب الصنف؛ لن يُحذف الباركود القديم.
        </div>
      )}
      <section className="panel table-wrap">
        <div className="product-search-toolbar">
          <label className="product-search-field">
            <span>بحث سريع في الأصناف</span>
            <input
              ref={productSearchRef}
              aria-label="ابحث عن صنف بالاسم أو الباركود"
              value={productQuery}
              onChange={(event) => setProductQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setProductQuery("");
                } else if (event.key === "F3") {
                  event.preventDefault();
                  if (productQuery.trim()) onEditProductByQuery(productQuery);
                  else setMessage("ابحث بالباركود أولاً، ثم اضغط F3 لتعديل الصنف.");
                } else if (event.key === "F7" || event.code === "F7") {
                  event.preventDefault();
                  openQuickProductUpdate();
                }
              }}
              placeholder="اكتب اسم الصنف أو امسح الباركود… Esc لمسح | F3 تعديل | F7 سريع"
              autoComplete="off"
            />
          </label>
          <p>
            {isSearching
              ? "جارٍ البحث…"
              : productQuery.trim()
                ? `${filteredSearchResults.length} نتيجة`
                : "ابحث لمعرفة الكمية المتاحة أو إضافة توريد سريع."}
          </p>
        </div>
        <div className="advanced-product-filter-toggle">
          <button type="button" onClick={() => setShowAdvancedFilters((value) => !value)} aria-expanded={showAdvancedFilters}>
            {showAdvancedFilters ? "إخفاء الفلتر المتقدم" : "فلتر متقدم"}
          </button>
          {(availabilityFilter !== "ALL" || unitFilter !== "ALL" || categoryFilter !== "ALL" || minimumStock || maximumPrice) && <button type="button" onClick={resetAdvancedFilters}>مسح الفلاتر</button>}
          <small>{filteredSearchResults.length} نتيجة بعد الفلترة</small>
        </div>
        {showAdvancedFilters && <div className="advanced-product-filters">
          <Field label="الحالة"><select value={availabilityFilter} onChange={(event) => setAvailabilityFilter(event.target.value as "ALL" | "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK")}><option value="ALL">كل الحالات</option><option value="IN_STOCK">متوفر الآن</option><option value="LOW_STOCK">مخزون منخفض</option><option value="OUT_OF_STOCK">غير متوفر</option></select></Field>
          <Field label="نوع الوحدة"><select value={unitFilter} onChange={(event) => setUnitFilter(event.target.value as "ALL" | "PIECE" | "WEIGHT")}><option value="ALL">كل الوحدات</option><option value="PIECE">قطع / باكيت / كرتونة</option><option value="WEIGHT">وزن أو سائل</option></select></Field>
          <Field label="التصنيف"><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="ALL">كل التصنيفات</option>{productCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select></Field>
          <Field label="أقل كمية متاحة"><input value={minimumStock} onChange={(event) => setMinimumStock(event.target.value)} inputMode="decimal" dir="ltr" placeholder="مثال: 10" /></Field>
          <Field label="أقصى سعر بيع"><input value={maximumPrice} onChange={(event) => setMaximumPrice(event.target.value)} inputMode="decimal" dir="ltr" placeholder="مثال: 50.00" /></Field>
        </div>}
        <table className={`products-table ${canViewCost ? "with-cost" : "without-cost"}`}>
          <colgroup>
            <col className="product-name-column" />
            <col className="barcode-column" />
            <col className="unit-column" />
            <col className="retail-price-column" />
            {canViewCost && <col className="wholesale-price-column" />}
            <col className="stock-column" />
            <col className="status-column" />
            <col className="actions-column" />
          </colgroup>
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الباركود</th>
              <th>الوحدة</th>
              <th>السعر</th>
              {canViewCost && <th>سعر الجملة الداخلي</th>}
              <th>المتاح</th>
              <th>الحالة</th>
              <th>إجراءات سريعة</th>
            </tr>
          </thead>
          <tbody>
            {displayedSearchResults.map((product) => {
              const needsNumericBarcode = !hasScannerNumericBarcode(product.barcodes);
              const availability =
                product.availableQtyMilli <= 0
                  ? { label: "غير متوفر", tone: "empty" }
                  : product.reorderLevelMilli > 0 &&
                      product.availableQtyMilli <= product.reorderLevelMilli
                    ? { label: "مخزون منخفض", tone: "low" }
                    : { label: "متوفر", tone: "available" };
              return (
              <tr
                key={product.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setProductMenu({
                    product,
                    x: Math.min(event.clientX, window.innerWidth - 230),
                    y: Math.min(event.clientY, window.innerHeight - 190),
                  });
                }}
              >
                <td className="product-name-cell">
                  <b>{product.nameAr}</b>
                  <small>{product.category}</small>
                </td>
                <td className="barcode-cell ltr">{product.barcodes.join("، ")}</td>
                <td>{productUnitLabel(product)}</td>
                <td>
                  {formatMoney(productDisplayPriceMinor(product))}
                  {product.cartonPriceMinor && <small className="carton-price-note">كرتونة: {formatMoney(product.cartonPriceMinor)}</small>}
                  {product.retailPackage && <small className="carton-price-note">{retailPackageLabel(product)} ({product.retailPackage.unitsPerPackage} {product.retailPackage.contentsUnit === "BAG" ? "أكياس" : "قطع"}): {formatMoney(product.retailPackage.packagePriceMinor)}</small>}
                </td>
                {canViewCost && <td>{formatMoney(product.wholesalePriceMinor ?? 0)}</td>}
                <td>
                  {productQuantityLabel(product)}
                  {product.unitKind === "PIECE" && product.cartonPriceMinor && product.purchasePackSize >= 2 && <small className="carton-price-note">{Math.floor(product.availableQtyMilli / (product.purchasePackSize * 1000))} كرتونة + {(product.availableQtyMilli / 1000) % product.purchasePackSize} {product.cartonContentsUnit === "BAG" ? "كيس" : "قطعة"}</small>}
                </td>
                <td>
                  <span className={`availability ${availability.tone}`}>
                    {availability.label}
                  </span>
                </td>
                <td>
                  <div className="product-row-actions">
                    {product.unitKind === "PIECE" && !product.cartonPriceMinor && (
                      <button
                        type="button"
                        className="label-action carton-convert-action"
                        title="اجعل الصنف يباع كرتونة كاملة أو قطع فرط مع الحفاظ على الرصيد"
                        onClick={() => setCartonConversionProduct(product)}
                      >
                        تحويل لكرتونة
                      </button>
                    )}
                    {needsNumericBarcode && (
                      <button
                        type="button"
                        className="label-action"
                        title="إضافة باركود EAN-13 رقمي قابل للقراءة بالسكانر"
                        onClick={() => void generateNumericBarcode(product)}
                      >
                        توليد باركود رقمي
                      </button>
                    )}
                    <button
                      type="button"
                      className="quick-restock-button"
                      aria-label={`إضافة كمية لـ ${product.nameAr}`}
                      title="إضافة كمية وصلت الآن"
                      onClick={() => setQuickRestockProduct(product)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="label-action"
                      title="تعديل سريع للسعر والكمية — F7"
                      onClick={() => openQuickProductUpdate(product)}
                    >
                      سريع F7
                    </button>
                    <button
                      type="button"
                      className="label-action"
                      onClick={() => openLabelEditor(product)}
                    >
                      سعر / طباعة
                    </button>
                    <button
                      type="button"
                      className="label-action"
                      onClick={() => setLabelPrintProduct(product)}
                    >
                      طباعة ملصق
                    </button>
                    <button
                      type="button"
                      className="product-delete-action"
                      onClick={() => void archiveProduct(product)}
                    >
                      حذف الصنف
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
            {!isSearching && filteredSearchResults.length === 0 && (
              <tr>
                <td colSpan={canViewCost ? 8 : 7} className="table-empty">
                  لا توجد أصناف مطابقة. جرّب الاسم أو الباركود كاملاً.
                </td>
              </tr>
            )}
          </tbody>
        </table>
          {filteredSearchResults.length > PRODUCTS_TABLE_PAGE_SIZE && (
          <nav className="catalog-pagination table-pagination" aria-label="تصفح جدول الأصناف">
            <span>
              عرض {activeResultsPage * PRODUCTS_TABLE_PAGE_SIZE + 1}
              {"–"}
              {Math.min((activeResultsPage + 1) * PRODUCTS_TABLE_PAGE_SIZE, searchResults.length)} من {searchResults.length}
            </span>
            <div>
              <button type="button" disabled={activeResultsPage === 0} onClick={() => setResultsPage((page) => Math.max(0, page - 1))}>
                السابق
              </button>
              <span>{activeResultsPage + 1} / {searchResultsPageCount}</span>
              <button type="button" disabled={activeResultsPage >= searchResultsPageCount - 1} onClick={() => setResultsPage((page) => Math.min(searchResultsPageCount - 1, page + 1))}>
                التالي
              </button>
            </div>
          </nav>
        )}
      </section>
      {productMenu && (
        <div
          className="product-context-menu"
          role="menu"
          dir="rtl"
          aria-label={`\u0625\u062c\u0631\u0627\u0621\u0627\u062a ${productMenu.product.nameAr}`}
          style={{ left: productMenu.x, top: productMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <strong>{productMenu.product.nameAr}</strong>
          <button type="button" role="menuitem" onClick={() => { setEditingProduct(productMenu.product); setProductMenu(null); }}>تعديل بيانات الصنف</button>
          {productMenu.product.unitKind === "PIECE" && <button type="button" role="menuitem" onClick={() => { setCartonConversionProduct(productMenu.product); setProductMenu(null); }}>دمج كرتونة / كيس والباركودات</button>}
          <button type="button" role="menuitem" onClick={() => { setQuickRestockProduct(productMenu.product); setProductMenu(null); }}>+ {"\u0625\u0636\u0627\u0641\u0629 \u0643\u0645\u064a\u0629"}</button>
          <button type="button" role="menuitem" onClick={() => { openLabelEditor(productMenu.product); setProductMenu(null); }}>{"\u0633\u0639\u0631 / \u0637\u0628\u0627\u0639\u0629"}</button>
          <button type="button" role="menuitem" onClick={() => { setLabelPrintProduct(productMenu.product); setProductMenu(null); }}>{"\u0637\u0628\u0627\u0639\u0629 \u0628\u0627\u0631\u0643\u0648\u062f"}</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { void archiveProduct(productMenu.product); setProductMenu(null); }}>{"\u062d\u0630\u0641 \u0627\u0644\u0635\u0646\u0641"}</button>
        </div>
      )}
      {cartonConversionProduct && (
        <div className="modal-backdrop">
          <form className="modal form-grid carton-conversion-modal" onSubmit={(event) => void configurePackaging(event)}>
            <h2 className="full">دمج تغليف «{cartonConversionProduct.nameAr}»</h2>
            <p className="hint full">أدخل فقط مستويات البيع المتاحة لديك. كل الباركودات اختيارية وقابلة للتعديل لاحقًا؛ يظل المخزون رصيدًا واحدًا ولا يُضاف أو يُخصم عند تغيير التغليف.</p>
            <Field label="باركود القطعة / الكيس الفردي (اختياري)"><input name="unitBarcode" inputMode="numeric" dir="ltr" defaultValue={cartonConversionProduct.barcodeMappings?.find((item) => item.saleUnit === "UNIT")?.barcode ?? cartonConversionProduct.barcodes[0] ?? ""} placeholder="اتركه كما هو أو صححه" /></Field>
            <div className="full packaging-section-title">تغليف الكيس أو العبوة — اختياري</div>
            <Field label="محتوى الكيس / العبوة"><select name="packageContentsUnit" defaultValue={cartonConversionProduct.retailPackage?.contentsUnit ?? "PIECE"}><option value="PIECE">قطع</option><option value="BAG">أكياس</option></select></Field>
            <Field label="عدد القطع داخل الكيس / العبوة"><input name="packageCapacity" min="2" step="1" inputMode="numeric" dir="ltr" defaultValue={cartonConversionProduct.retailPackage?.unitsPerPackage ?? ""} placeholder="مثال: 6" /></Field>
            <Field label="سعر البيع العام للكيس / العبوة"><input name="packagePrice" min="0.01" inputMode="decimal" dir="ltr" defaultValue={cartonConversionProduct.retailPackage ? (cartonConversionProduct.retailPackage.packagePriceMinor / 100).toFixed(2) : ""} placeholder="اختياري" /></Field>
            <Field label="باركود الكيس / العبوة"><input name="packageBarcode" inputMode="numeric" dir="ltr" defaultValue={cartonConversionProduct.barcodeMappings?.find((item) => item.saleUnit === "PACKAGE")?.barcode ?? ""} placeholder="اختياري" /></Field>
            <div className="full packaging-section-title">تغليف الكرتونة — اختياري</div>
            <Field label="محتوى الكرتونة"><select name="cartonContentsUnit" defaultValue={cartonConversionProduct.cartonContentsUnit ?? "PIECE"}><option value="PIECE">قطع</option><option value="BAG">أكياس</option></select></Field>
            <Field label="عدد القطع / الأكياس داخل الكرتونة"><input name="cartonCapacity" min="2" step="1" inputMode="numeric" dir="ltr" defaultValue={cartonConversionProduct.cartonPriceMinor ? cartonConversionProduct.purchasePackSize : ""} placeholder="مثال: 24" /></Field>
            <Field label="سعر البيع العام للكرتونة"><input name="cartonPrice" min="0.01" inputMode="decimal" dir="ltr" defaultValue={cartonConversionProduct.cartonPriceMinor ? (cartonConversionProduct.cartonPriceMinor / 100).toFixed(2) : ""} placeholder="اختياري" /></Field>
            <Field label="باركود الكرتونة"><input name="cartonBarcode" inputMode="numeric" dir="ltr" defaultValue={cartonConversionProduct.barcodeMappings?.find((item) => item.saleUnit === "CARTON")?.barcode ?? ""} placeholder="اختياري" /></Field>
            <div className="carton-conversion-preview full">
              الرصيد الحالي: <b>{cartonConversionProduct.availableQtyMilli / 1000}</b> قطعة. عند بيع كيس أو كرتونة سيُخصم محتواها تلقائيًا من هذا الرصيد نفسه.
            </div>
            <div className="modal-actions full"><button type="button" onClick={() => setCartonConversionProduct(null)}>إلغاء</button><button className="primary">حفظ التغليف والباركودات</button></div>
          </form>
        </div>
      )}
      {editingProduct && (
        <div className="modal-backdrop">
          <form className="modal form-grid" onSubmit={(event) => void updateProduct(event)}>
            <h2 className="full">{reviewQueue ? `مراجعة الأصناف المتوفرة — ${reviewIndex + 1} من ${reviewQueue.length}` : "تعديل بيانات الصنف"}</h2>
            {reviewQueue && <p className="hint full">احفظ التعديل للانتقال إلى الصنف التالي. يمكنك إنهاء المراجعة في أي وقت دون تغيير بقية الأصناف.</p>}
            <Field label="اسم الصنف">
              <input name="nameAr" required autoFocus defaultValue={editingProduct.nameAr} />
            </Field>
            <Field label="التصنيف">
              <input name="category" required list="nabta-edit-product-category-options" defaultValue={editingProduct.category} />
            </Field>
            <Field label="طريقة البيع والاستلام">
              <select value={editingMode} onChange={(event) => setEditingMode(event.target.value as ProductCreationMode)} disabled={editingProduct.unitKind === "WEIGHT"}>
                {editingProduct.unitKind === "WEIGHT" ? <>
                  <option value="KILOGRAM">كيلو</option><option value="GRAM">جرام</option><option value="LITER">لتر (منتج سائل)</option><option value="MILLILITER">ملليلتر (منتج سائل)</option>
                </> : <>
            <option value="PIECE">قطعة منفردة</option><option value="PACKAGE">عبوة (تباع عبوة أو فرط)</option><option value="CARTON">كرتونة/علبة (تباع فرط أو كرتونة)</option><option value="PLATE_CARTON">أطباق وفوم (طبق / عمود / كرتونة)</option>
                </>}
              </select>
            </Field>
            <Field label="الباركود">
              <input value={editingProduct.barcodes.join("، ")} dir="ltr" disabled />
            </Field>
            {editingProduct.unitKind === "PIECE" && editingMode !== "PIECE" ? <>
              <Field label={editingMode === "PACKAGE" ? "عدد العبوات الكاملة المتاحة" : editingMode === "PLATE_CARTON" ? "عدد الكراتين المتاحة" : "عدد الكراتين المتاحة (يسمح بـ 0.5)"}>
                <input name="availableCartons" required min="0" step={editingMode === "PACKAGE" || editingMode === "PLATE_CARTON" ? "1" : "0.5"} inputMode="decimal" dir="ltr" defaultValue={Math.floor(editingProduct.availableQtyMilli / (editingProduct.purchasePackSize * 1000)).toString()} />
              </Field>
              {editingMode === "PLATE_CARTON" && <>
                <Field label="عدد الأعمدة الفرط خارج الكراتين"><input name="availableLooseStacks" required min="0" step="1" inputMode="numeric" dir="ltr" defaultValue={Math.floor(((editingProduct.availableQtyMilli / 1000) % editingProduct.purchasePackSize) / (editingProduct.retailPackage?.unitsPerPackage ?? 1)).toString()} /></Field>
              </>}
              <Field label={editingMode === "PLATE_CARTON" ? "عدد الأكواب أو الأطباق الفرط خارج الأعمدة" : `عدد ${editingMode === "PACKAGE" ? (editingProduct.retailPackage?.contentsUnit === "BAG" ? "الأكياس" : "القطع") : (editingProduct.cartonContentsUnit === "BAG" ? "الأكياس" : "القطع")} الفرط خارج ${editingMode === "PACKAGE" ? "العبوات" : "الكراتين"}`}>
                <input name="availableLooseUnits" required min="0" step="1" inputMode="numeric" dir="ltr" defaultValue={(editingMode === "PLATE_CARTON" ? ((editingProduct.availableQtyMilli / 1000) % (editingProduct.retailPackage?.unitsPerPackage ?? 1)) : ((editingProduct.availableQtyMilli / 1000) % editingProduct.purchasePackSize)).toString()} />
              </Field>
              <p className="hint full">الإجمالي يحسب تلقائيًا: عدد الكراتين × سعة الكرتونة + الفرط. مثال: كرتونة سعتها 12 ومعك كرتونة ونصف و3 أكياس: اكتب 1.5 كرتونة و3 فرط. لا تكتب إجمالي القطع في هذه الخانات.</p>
            </> : <Field label={`الكمية المتاحة (${productUnitLabel(editingProduct)})`}>
              <input name="availableQuantity" required inputMode={isSmallMeasuredUnit(editingProduct.weightUnit) ? "numeric" : "decimal"} dir="ltr" defaultValue={(editingProduct.unitKind === "WEIGHT" && isSmallMeasuredUnit(editingProduct.weightUnit) ? editingProduct.availableQtyMilli : editingProduct.availableQtyMilli / 1000).toString()} />
            </Field>}
            {editingProduct.unitKind === "WEIGHT" && <>
              <Field label={`سعر البيع لكل ${productUnitLabel(editingProduct)}`}><input name="price" required inputMode="decimal" dir="ltr" defaultValue={(productDisplayPriceMinor(editingProduct) / 100).toFixed(2)} /></Field>
              {canViewCost && <Field label={`سعر الجملة لكل ${productUnitLabel(editingProduct)}`}><input name="wholesalePrice" required inputMode="decimal" dir="ltr" defaultValue={(productDisplayPriceMinor(editingProduct, editingProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} /></Field>}
              <p className="hint full">وحدة الصنف الموزون ثابتة بعد الحفظ لحماية سجل المخزون والمبيعات.</p>
            </>}
            {editingProduct.unitKind === "PIECE" && editingMode === "PIECE" && <>
              <Field label="سعر البيع للقطعة"><input name="price" required inputMode="decimal" dir="ltr" defaultValue={(editingProduct.priceMinor / 100).toFixed(2)} /></Field>
              {canViewCost && <Field label="سعر الجملة للقطعة"><input name="wholesalePrice" required inputMode="decimal" dir="ltr" defaultValue={((editingProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} /></Field>}
            </>}
            {editingProduct.unitKind === "PIECE" && editingMode === "PACKAGE" && <>
              <Field label="محتوى العبوة"><select name="packageContentsUnit" defaultValue={editingProduct.retailPackage?.contentsUnit ?? "PIECE"}><option value="PIECE">قطع</option><option value="BAG">أكياس</option></select></Field>
              <Field label="شكل البيع الكامل"><select name="packageLabel" defaultValue={editingProduct.retailPackage?.label === "PACKET" ? "PACKET" : "PACKAGE"}><option value="PACKAGE">عبوة</option><option value="PACKET">باكيت (كانز أو زجاجات)</option></select></Field>
              <Field label="عدد القطع / الأكياس داخل العبوة"><input name="purchasePackSize" required min="2" step="1" inputMode="numeric" dir="ltr" defaultValue={editingProduct.retailPackage?.unitsPerPackage ?? editingProduct.purchasePackSize} /></Field>
              <Field label="سعر بيع العبوة"><input name="packagePrice" required min="0.01" inputMode="decimal" dir="ltr" defaultValue={editingProduct.retailPackage ? (editingProduct.retailPackage.packagePriceMinor / 100).toFixed(2) : ""} /></Field>
              <Field label="سعر بيع الكيس أو القطعة (فرط)"><input name="unitPrice" required min="0.01" inputMode="decimal" dir="ltr" defaultValue={(editingProduct.priceMinor / 100).toFixed(2)} /></Field>
              <Field label="باركود العبوة الكامل (اختياري)"><input name="packageBarcode" inputMode="numeric" dir="ltr" defaultValue={editingProduct.barcodeMappings?.find((item) => item.saleUnit === "PACKAGE")?.barcode ?? ""} /></Field>
              <p className="hint full">إذا كان باركود العبوة مسجلاً بالفعل لنفس البضاعة، يُدمج تلقائياً مع الصنف الحالي ويحفظ الرصيد مرة واحدة.</p>
              {canViewCost && <Field label="سعر الجملة للكيس أو القطعة"><input name="wholesalePrice" required inputMode="decimal" dir="ltr" defaultValue={((editingProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} /></Field>}
            </>}
            {editingProduct.unitKind === "PIECE" && editingMode === "CARTON" && <>
              <Field label="محتوى الكرتونة"><select name="cartonContentsUnit" defaultValue={editingProduct.cartonContentsUnit ?? "BAG"}><option value="BAG">أكياس</option><option value="PIECE">قطع</option></select></Field>
              <Field label="سعة الكرتونة"><input name="purchasePackSize" required min="2" step="1" inputMode="numeric" dir="ltr" defaultValue={editingProduct.purchasePackSize} /></Field>
              <Field label="سعر بيع الكرتونة إن كانت تُباع كاملة (اختياري)"><input name="cartonPrice" min="0" inputMode="decimal" dir="ltr" defaultValue={editingProduct.cartonPriceMinor ? (editingProduct.cartonPriceMinor / 100).toFixed(2) : ""} /></Field>
              <Field label="سعر بيع الكيس أو القطعة (فرط)"><input name="piecePrice" required min="0.01" inputMode="decimal" dir="ltr" defaultValue={(editingProduct.priceMinor / 100).toFixed(2)} /></Field>
              <Field label="باركود الكرتونة الكامل (اختياري)"><input name="cartonBarcode" inputMode="numeric" dir="ltr" defaultValue={editingProduct.barcodeMappings?.find((item) => item.saleUnit === "CARTON")?.barcode ?? ""} /></Field>
              <p className="hint full">إذا كان باركود الكرتونة مسجلاً بالفعل لنفس البضاعة، يُدمج تلقائياً مع الصنف الحالي ويحفظ الرصيد مرة واحدة.</p>
              {canViewCost && <Field label="سعر الجملة للكيس أو القطعة"><input name="wholesalePrice" required inputMode="decimal" dir="ltr" defaultValue={((editingProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} /></Field>}
            </>}
            {editingProduct.unitKind === "PIECE" && editingMode === "PLATE_CARTON" && <>
              <Field label="عدد الأعمدة داخل الكرتونة"><input name="stacksPerCarton" required min="1" step="1" inputMode="numeric" dir="ltr" defaultValue={(editingProduct.purchasePackSize / (editingProduct.retailPackage?.unitsPerPackage ?? 1)).toString()} /></Field>
              <Field label="سعة العمود (عدد الأكواب أو الأطباق)"><input name="stackSize" required min="2" step="1" inputMode="numeric" dir="ltr" defaultValue={editingProduct.retailPackage?.unitsPerPackage ?? 2} /></Field>
              <Field label="سعر بيع الكوب أو الطبق"><input name="piecePrice" required min="0.01" inputMode="decimal" dir="ltr" defaultValue={(editingProduct.priceMinor / 100).toFixed(2)} /></Field>
              <Field label="سعر بيع العمود"><input name="stackPrice" required min="0.01" inputMode="decimal" dir="ltr" defaultValue={editingProduct.retailPackage ? (editingProduct.retailPackage.packagePriceMinor / 100).toFixed(2) : ""} /></Field>
              <Field label="باركود الكرتونة الكامل (اختياري)"><input name="cartonBarcode" inputMode="numeric" dir="ltr" defaultValue={editingProduct.barcodeMappings?.find((item) => item.saleUnit === "CARTON")?.barcode ?? ""} /></Field>
              <p className="hint full">يُدمج باركود الكرتونة المسجل مسبقاً تلقائياً مع هذا الصنف عند الحفظ، مع الحفاظ على رصيد المخزون وسجله.</p>
              <Field label="سعر بيع الكرتونة"><input name="cartonPrice" required min="0.01" inputMode="decimal" dir="ltr" defaultValue={editingProduct.cartonPriceMinor ? (editingProduct.cartonPriceMinor / 100).toFixed(2) : ""} /></Field>
              {canViewCost && <Field label="سعر الجملة للطبق"><input name="wholesalePrice" required inputMode="decimal" dir="ltr" defaultValue={((editingProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} /></Field>}
            </>}
            <datalist id="nabta-edit-product-category-options">{[...new Set(products.map((product) => product.category))].sort((a, b) => a.localeCompare(b, "ar")).map((category) => <option key={category} value={category} />)}</datalist>
            <Field label="الوصف">
              <textarea name="description" rows={4} defaultValue={editingProduct.description} />
            </Field>
            <p className="hint full">تعديل الكمية يُسجل تلقائياً كحركة جرد للمراجعة، ولا يغيّر الفواتير السابقة.</p>
            <div className="modal-actions full">
              <button type="button" onClick={() => { setEditingProduct(null); setReviewQueue(null); setReviewIndex(0); }}>{reviewQueue ? "إنهاء المراجعة" : "إلغاء"}</button>
              <button className="primary">{reviewQueue ? "حفظ والانتقال للتالي" : "حفظ التعديلات"}</button>
            </div>
          </form>
        </div>
      )}
      {quickUpdateProduct && (
        <div className="modal-backdrop">
          <form className="modal form-grid" onSubmit={(event) => void quickUpdateProductStock(event)}>
            <h2 className="full">تعديل سريع — {quickUpdateProduct.nameAr}</h2>
            <p className="hint full">F7: اكتب إجمالي ما دُفع للصنف، الكمية المتاحة وسعر البيع فقط. يحسب النظام تكلفة الوحدة تلقائيًا.</p>
            <Field label="وحدة البيع">
              <select
                value={quickSaleUnit}
                onChange={(event) => setQuickSaleUnit(event.target.value as "PIECE" | "PACK" | "BAG" | "KILOGRAM")}
                disabled={quickUpdateProduct.unitKind === "WEIGHT"}
              >
                {quickUpdateProduct.unitKind === "WEIGHT" ? (
                  <option value="KILOGRAM">كيلو</option>
                ) : (
                  <>
                    <option value="PIECE">قطعة</option>
                    <option value="PACK">عبوة</option>
                    <option value="BAG">كيس</option>
                  </>
                )}
              </select>
            </Field>
            <Field label="إجمالي سعر الجملة للكمية (ج.م)">
              <input name="totalWholesale" inputMode="decimal" dir="ltr" autoFocus required />
            </Field>
            <Field label={`الكمية المتاحة (${quickSaleUnit === "KILOGRAM" ? "كيلو" : quickSaleUnit === "PACK" ? "عبوة" : quickSaleUnit === "BAG" ? "كيس" : "قطعة"})`}>
              <input name="quantity" inputMode="decimal" dir="ltr" required />
            </Field>
            <Field label={`سعر البيع لكل ${quickSaleUnit === "KILOGRAM" ? "كيلو" : quickSaleUnit === "PACK" ? "عبوة" : quickSaleUnit === "BAG" ? "كيس" : "قطعة"} (ج.م)`}>
              <input name="retailPrice" inputMode="decimal" dir="ltr" defaultValue={(quickUpdateProduct.priceMinor / 100).toFixed(2)} required />
            </Field>
            <p className="hint full">التعديل في الكمية يُوثّق كحركة جرد للمراجعة، ولا يغيّر الفواتير السابقة.</p>
            <div className="modal-actions full">
              <button type="button" onClick={() => setQuickUpdateProduct(null)}>إلغاء</button>
              <button className="primary">حفظ التعديل السريع</button>
            </div>
          </form>
        </div>
      )}
      {labelPrintProduct && (
        <div className="modal-backdrop">
          <form
            className="modal form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const copies = Number(data.get("copies"));
              if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
                setMessage("أدخل عدداً صحيحاً من 1 إلى 100 نسخة.");
                return;
              }
              const barcode = String(data.get("barcode") || "").trim() || (labelPrintProduct.barcodes[0] ?? "");
              if (!barcode) {
                setMessage("أدخل باركود صالحاً لطباعة الملصق.");
                return;
              }
              const product = labelPrintProduct;
              setLabelPrintProduct(null);
              const hidePrice = data.get("showPrice") !== "on";
              void printSearchedProductLabel(product, barcode, copies, hidePrice);
            }}
          >
            <h2 className="full">طباعة باركود الصنف</h2>
            <div className="full" style={{ background: "rgba(29, 184, 122, 0.08)", border: "1px solid rgba(29, 184, 122, 0.25)", borderRadius: "8px", padding: "12px 16px" }}>
              <div style={{ fontSize: "16px", fontWeight: "bold", color: "var(--nabta-text, #1e293b)", marginBottom: "4px" }}>{labelPrintProduct.nameAr}</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", color: "var(--nabta-text-muted, #64748b)" }}>
                <span>سعر البيع: <strong style={{ color: "var(--nabta-primary, #059669)" }}>{formatMoney(labelPrintProduct.priceMinor)}</strong></span>
                <span>الرصيد: {formatQty(labelPrintProduct.availableQtyMilli, labelPrintProduct.unitKind)}</span>
              </div>
            </div>
            {labelPrintProduct.barcodes.length > 1 ? (
              <Field label="اختر الباركود المراد طباعته">
                <select name="barcode" defaultValue={labelPrintProduct.barcodes[0]} dir="ltr" autoFocus>
                  {labelPrintProduct.barcodes.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="الباركود المسجل للطباعة">
                <input
                  name="barcode"
                  defaultValue={labelPrintProduct.barcodes[0] ?? ""}
                  dir="ltr"
                  required
                  autoFocus
                  title="الباركود الذي سيتم طباعته على الاستيكر"
                />
              </Field>
            )}
            <Field label="عدد النسخ المطلوبة">
              <input name="copies" type="number" min="1" max="100" step="1" defaultValue="1" required dir="ltr" />
            </Field>
            <label className="full" style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", padding: "10px 12px", border: "1px solid var(--nabta-border, #cbd5e1)", borderRadius: "8px" }}>
              <input
                name="showPrice"
                type="checkbox"
                defaultChecked={!shouldHidePriceOnProductLabel(labelPrintProduct)}
                style={{ width: "18px", height: "18px", accentColor: "var(--nabta-primary, #059669)" }}
              />
              <span>
                إظهار سعر البيع على الملصق
                {shouldHidePriceOnProductLabel(labelPrintProduct) && <small style={{ display: "block", color: "var(--nabta-text-muted, #64748b)", marginTop: "3px" }}>مخفى افتراضياً لأصناف الفوم، ويمكنك إظهاره لهذه الطبعة فقط.</small>}
              </span>
            </label>
            <div className="modal-actions full">
              <button type="button" onClick={() => setLabelPrintProduct(null)}>إلغاء</button>
              <button className="primary">طباعة الملصق</button>
            </div>
          </form>
        </div>
      )}
      {show && (
        <div className="modal-backdrop">
          <form
            className="modal form-grid"
            onSubmit={(event) => void create(event)}
          >
            <h2 className="full">إضافة صنف</h2>
            <p className="hint full">
              الباركود {barcode ? <b dir="ltr">{barcode}</b> : "سيُولَّد تلقائيًا عند الحفظ"}. الخيارات المتقدمة تُدار من بطاقة الصنف لاحقًا.
            </p>
            <Field label="الاسم">
              <input name="nameAr" required autoFocus />
            </Field>
            <Field label="التصنيف">
              <input name="category" required list="nabta-product-category-options" placeholder="اكتب أول حرفين لعرض التصنيفات" />
            </Field>
            <Field label="باركود القطعة / الكيس الفردي">
              <input name="unitBarcode" inputMode="numeric" dir="ltr" defaultValue={barcode} placeholder="اتركه فارغًا لتوليد باركود" />
            </Field>
            <Field label="طريقة البيع والاستلام">
              <select value={newProductMode} onChange={(event) => setNewProductMode(event.target.value as ProductCreationMode)}>
                <option value="KILOGRAM">كيلو</option>
                <option value="GRAM">جرام</option>
                <option value="LITER">لتر (منتج سائل)</option>
                <option value="MILLILITER">ملليلتر (منتج سائل)</option>
                <option value="PIECE">قطعة منفردة</option>
                <option value="PACKAGE">عبوة (تباع عبوة أو فرط)</option>
                <option value="CARTON">كرتونة/علبة (تباع فرط أو كرتونة)</option>
                <option value="PLATE_CARTON">أطباق وفوم (طبق / عمود / كرتونة)</option>
              </select>
            </Field>
            {(newProductMode === "KILOGRAM" || newProductMode === "GRAM" || newProductMode === "LITER" || newProductMode === "MILLILITER") && (
              <>
                <Field label={`الكمية المستلمة بـ${measurementUnitLabel(newProductMode === "KILOGRAM" ? "KILOGRAM" : newProductMode === "GRAM" ? "GRAM" : newProductMode === "LITER" ? "LITER" : "MILLILITER")}`}>
                  <input name="openingQty" defaultValue="0" required inputMode={newProductMode === "KILOGRAM" || newProductMode === "LITER" ? "decimal" : "numeric"} dir="ltr" placeholder={newProductMode === "KILOGRAM" || newProductMode === "LITER" ? "مثال: 8 أو 0.250" : "مثال: 8000 أو 250"} />
                </Field>
                <Field label={`سعر البيع لكل ${measurementUnitLabel(newProductMode === "KILOGRAM" ? "KILOGRAM" : newProductMode === "GRAM" ? "GRAM" : newProductMode === "LITER" ? "LITER" : "MILLILITER")}`}>
                  <input name="price" required inputMode="decimal" dir="ltr" />
                </Field>
                {canViewCost && <Field label={`سعر الجملة لكل ${measurementUnitLabel(newProductMode === "KILOGRAM" ? "KILOGRAM" : newProductMode === "GRAM" ? "GRAM" : newProductMode === "LITER" ? "LITER" : "MILLILITER")}`}><input name="wholesalePrice" required defaultValue="0.00" inputMode="decimal" dir="ltr" /></Field>}
                <p className="hint full">يحفظ البرنامج الوزن بالجرام والسوائل بالملليلتر للحساب الدقيق.</p>
              </>
            )}
            {newProductMode === "PIECE" && (
              <>
                <Field label="عدد القطع المستلمة">
                  <input name="openingQty" defaultValue="0" required inputMode="numeric" dir="ltr" />
                </Field>
                <Field label="سعر البيع للقطعة"><input name="price" required inputMode="decimal" dir="ltr" /></Field>
                {canViewCost && <Field label="سعر الجملة للقطعة"><input name="wholesalePrice" required defaultValue="0.00" inputMode="decimal" dir="ltr" /></Field>}
              </>
            )}
            {newProductMode === "CARTON" && (
              <>
                <Field label="عدد الكراتين المتاحة الآن (يسمح بـ 0.5)"><input name="openingCartons" required min="0" step="0.5" inputMode="decimal" dir="ltr" /></Field>
                <Field label="محتوى الكرتونة"><select name="cartonContentsUnit" defaultValue="BAG"><option value="BAG">أكياس</option><option value="PIECE">قطع</option></select></Field>
                <Field label="سعة الكرتونة الواحدة (عدد القطع / العبوات / الأكياس داخلها)"><input name="purchasePackSize" required min="1" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="عدد الأكياس / القطع الفرط خارج الكراتين"><input name="openingLooseUnits" required defaultValue="0" min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="إجمالي سعر الجملة للكراتين المستلمة"><input name="cartonTotalWholesale" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="سعر بيع الكرتونة إن كانت تُباع كاملة (اختياري)"><input name="cartonPrice" min="0" inputMode="decimal" dir="ltr" /></Field>
                <Field label="سعر البيع للقطعة / العبوة / الكيس"><input name="piecePrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
          <Field label="باركود الكرتونة الكامل (اختياري عند بيعها كاملة)"><input name="cartonBarcode" inputMode="numeric" dir="ltr" placeholder="أدخله فقط إذا كانت الكرتونة تباع كاملة" /></Field>
                <p className="hint full">اكتب الكراتين الكاملة أو النصفية ثم الفرط خارجها. مثال: سعة 12، كرتونة ونصف و3 أكياس = 1.5 كرتونة و3 فرط. لا يقبل النظام جزءًا من كيس أو قطعة.</p>
              </>
            )}
            {newProductMode === "PLATE_CARTON" && (
              <>
                <Field label="عدد الكراتين المستلمة"><input name="openingCartons" required min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="عدد الأعمدة داخل الكرتونة (مثال: 40)"><input name="stacksPerCarton" required min="1" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="سعة العمود (عدد الأكواب أو الأطباق)"><input name="stackSize" required min="2" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="عدد الأعمدة الفرط خارج الكراتين"><input name="openingLooseStacks" required defaultValue="0" min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="عدد الأكواب أو الأطباق الفرط خارج الأعمدة"><input name="openingLooseUnits" required defaultValue="0" min="0" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="إجمالي سعر الجملة للكراتين المستلمة"><input name="cartonTotalWholesale" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
                <Field label="سعر بيع الكوب أو الطبق"><input name="piecePrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
                <Field label="سعر بيع العمود"><input name="stackPrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
                <Field label="باركود الكرتونة الكامل (اختياري)"><input name="cartonBarcode" inputMode="numeric" dir="ltr" placeholder="يمسح ويبيع كرتونة كاملة" /></Field>
                <Field label="سعر بيع الكرتونة إن كانت تُباع كاملة (اختياري)"><input name="cartonPrice" min="0" inputMode="decimal" dir="ltr" /></Field>
                <p className="hint full">مثال الأكواب: كرتونة بها 40 عمودًا، وكل عمود 50 كوبًا = 2000 كوب. تبيع الكرتونة أو العمود أو كوبًا/طبقًا مفردًا، ويُخصم دائمًا من نفس رصيد القطع.</p>
              </>
            )}
            {newProductMode === "PACKAGE" && (
              <>
                <Field label="شكل البيع الكامل"><select name="packageLabel" defaultValue="PACKAGE"><option value="PACKAGE">عبوة</option><option value="PACKET">باكيت (كانز أو زجاجات)</option></select></Field>
                <Field label="عدد العبوات المستلمة"><input name="openingCartons" required min="1" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="محتوى العبوة"><select name="packageContentsUnit" defaultValue="PIECE"><option value="PIECE">قطع</option><option value="BAG">أكياس</option></select></Field>
                <Field label="عدد القطع / الأكياس داخل العبوة"><input name="purchasePackSize" required min="2" step="1" inputMode="numeric" dir="ltr" /></Field>
                <Field label="إجمالي سعر الجملة للعبوات المستلمة"><input name="cartonTotalWholesale" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
                <Field label="سعر بيع العبوة"><input name="packagePrice" required min="0.01" inputMode="decimal" dir="ltr" /></Field>
                <Field label="سعر بيع الكيس أو القطعة (فرط)"><input name="unitPrice" required min="0.01" inputMode="decimal" dir="ltr" placeholder="السعر المُعلن للوحدة" /></Field>
                <Field label="باركود العبوة الكامل (اختياري)"><input name="packageBarcode" inputMode="numeric" dir="ltr" placeholder="يمسح ويبيع عبوة كاملة" /></Field>
                <p className="hint full">سعر العبوة الكاملة وسعر الكيس أو القطعة مستقلان؛ اكتب السعر المُعلن لكلٍ منهما. عند البيع تختار عبوة كاملة أو قطعة/كيس فرط.</p>
              </>
            )}
            <datalist id="nabta-product-category-options">
              {[...new Set(products.map((product) => product.category))].sort((a, b) => a.localeCompare(b, "ar")).map((category) => <option key={category} value={category} />)}
            </datalist>
            <div className="modal-actions full">
              <button
                type="button"
                onClick={() => {
                  setShow(false);
                  setNewProductMode("PIECE");
                  clearSuggestedBarcode();
                }}
              >
                إلغاء
              </button>
              <button className="primary">حفظ</button>
            </div>
          </form>
        </div>
      )}
      {quickRestockProduct && (
        <div className="modal-backdrop">
          <form className="modal form-grid quick-restock-form" onSubmit={(event) => void quickRestock(event)}>
            <div className="full modal-title-row">
              <div>
                <h2>إضافة كمية سريعة</h2>
                <p>
                  {quickRestockProduct.nameAr} — تُسجل كاستلام مخزون لحفظ الجرد والتكلفة بدقة.
                </p>
              </div>
            </div>
            <Field label="الكمية التي وصلت الآن">
              <input
                name="quantity"
                required
                autoFocus
                inputMode="decimal"
                dir="ltr"
                placeholder={quickRestockProduct.unitKind === "PIECE" ? "مثال: 12" : quickRestockProduct.weightUnit === "GRAM" ? "مثال: 250" : "مثال: 1.250"}
              />
            </Field>
            <Field label={`تكلفة ${productUnitLabel(quickRestockProduct)} بالجنيه`}>
              <input name="cost" required defaultValue="0.00" inputMode="decimal" dir="ltr" />
            </Field>
            <Field label={`سعر البيع لكل ${productUnitLabel(quickRestockProduct)} بالجنيه`}>
              <input name="retailPrice" required defaultValue={(productDisplayPriceMinor(quickRestockProduct) / 100).toFixed(2)} inputMode="decimal" dir="ltr" />
            </Field>
            {canViewCost && (
              <Field label={`سعر الجملة لكل ${productUnitLabel(quickRestockProduct)} بالجنيه`}>
                <input name="wholesalePrice" required defaultValue={(productDisplayPriceMinor(quickRestockProduct, quickRestockProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} inputMode="decimal" dir="ltr" />
              </Field>
            )}
            <Field label="اسم المورد (اختياري)">
              <input name="supplier" defaultValue="توريد سريع" />
            </Field>
            <Field label="رقم التشغيلة (اختياري)">
              <input name="lot" dir="ltr" />
            </Field>
            <Field label="تاريخ الصلاحية (اختياري)">
              <input name="expires" type="date" dir="ltr" />
            </Field>
            <p className="field-help full">
              أدخل تكلفة الوحدة لحساب المخزون، وسعري الجملة والبيع لتحديث بطاقة الصنف. الكيلو يقبل حتى 3 منازل: 0.125 أو 0.250 أو 0.500 أو 1.000.
            </p>
            <div className="modal-actions full">
              <button type="button" onClick={() => setQuickRestockProduct(null)}>
                إلغاء
              </button>
              <button className="primary">ترحيل الكمية</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

interface SaleLookup {
  sale_id: string;
  invoice_no: string;
  lines: Array<{
    id: string;
    nameAr: string;
    qtyMilli: number;
    returnedQtyMilli: number;
    unitKind: "PIECE" | "WEIGHT";
  }>;
}
interface ExpiryLot {
  lot_id: string;
  name_ar: string;
  unit_kind: "PIECE" | "WEIGHT";
  lot_code: string | null;
  expires_on: string;
  qty_milli: number;
  days_remaining: number;
}

function boundedNumber(value: FormDataEntryValue | null, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

function cairoDateForInput(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function qtyFromInput(value: string): number {
  const normalized = value.trim().replace(/[٫,]/g, ".");
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(normalized);
  if (!match)
    throw new Error("أدخل كمية صحيحة حتى 0.001");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(3, "0"));
  const qty = whole * 1000 + fraction;
  if (!Number.isSafeInteger(qty) || qty < 0)
    throw new Error("الكمية غير صحيحة");
  return qty;
}

function InventoryScreen({
  products,
  shift,
  refresh,
  storeName,
  receiptBranding,
  canViewCost = true,
  suggestedBarcode,
  clearSuggestedBarcode = () => undefined,
  onEditProductByQuery = () => undefined,
}: {
  products: CatalogProduct[];
  shift: Shift | null;
  refresh: () => Promise<CatalogProduct[]>;
  storeName?: string;
  receiptBranding?: ReceiptBranding | undefined;
  canViewCost?: boolean;
  suggestedBarcode?: string;
  clearSuggestedBarcode?: () => void;
  onEditProductByQuery?: (query: string) => void;
}): ReactNode {
  const [initialReceiptDraft] = useState(loadPurchaseReceiptDraft);
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [sale, setSale] = useState<SaleLookup | null>(null);
  const [returnLineId, setReturnLineId] = useState("");
  const [expiry, setExpiry] = useState<ExpiryLot[]>([]);
  const [section, setSection] = useState<
    "receive" | "count" | "returns" | "expiry"
  >("receive");
  const [receiptLines, setReceiptLines] = useState<ReceiptLineDraft[]>(initialReceiptDraft.lines);
  const [receiptBarcode, setReceiptBarcode] = useState("");
  const [receiptSupplier, setReceiptSupplier] = useState(initialReceiptDraft.supplier);
  const [receiptInvoiceNo, setReceiptInvoiceNo] = useState(initialReceiptDraft.invoiceNo);
  const [receiptExpenses, setReceiptExpenses] = useState(initialReceiptDraft.expenses);
  const [receiptIssuedAt, setReceiptIssuedAt] = useState(initialReceiptDraft.issuedAt);
  const [receiptSearchQuery, setReceiptSearchQuery] = useState("");
  const [receiptSearchResults, setReceiptSearchResults] = useState<CatalogProduct[]>([]);
  const [receiptSearchOpen, setReceiptSearchOpen] = useState(false);
  const [receiptSearchBusy, setReceiptSearchBusy] = useState(false);
  const [postingReceipt, setPostingReceipt] = useState(false);
  const [lastReceiptId, setLastReceiptId] = useState("");
  const [priceAlert, setPriceAlert] = useState<PurchasePriceAlert | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [purchaseHistory, setPurchaseHistory] = useState<InvoiceSummaryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<InvoiceDetailResponse | null>(null);
  const [invoiceProducts, setInvoiceProducts] = useState<CatalogProduct[]>([]);
  const [manualReceiptProductName, setManualReceiptProductName] = useState("");
  const [pendingReceiptProduct, setPendingReceiptProduct] = useState<{
    barcode: string;
    lineIndex: number;
    initialName?: string;
  } | null>(null);
  const [auditPeriod, setAuditPeriod] = useState<InventoryReportPeriod>("MONTHLY");
  const [auditReferenceDate, setAuditReferenceDate] = useState(cairoDateForInput);
  const [exportingAudit, setExportingAudit] = useState(false);
  const product = products.find((item) => item.id === productId) ?? products[0];
  const receiptProducts = useMemo(
    () => [
      ...products,
      ...invoiceProducts.filter(
        (invoiceProduct) =>
          !products.some((productItem) => productItem.id === invoiceProduct.id),
      ),
    ],
    [invoiceProducts, products],
  );
  const receiptGoodsMinor = useMemo(
    () => receiptLines.reduce((sum, line) => sum + Math.max(0, minorFromInput(line.cost || "0")), 0),
    [receiptLines],
  );
  const receiptExpensesMinor = useMemo(
    () => Math.max(0, minorFromInput(receiptExpenses || "0")),
    [receiptExpenses],
  );
  const receiptTotalMinor = receiptGoodsMinor + receiptExpensesMinor;
  const receiptIssuedAtLabel = useMemo(
    () => new Date(receiptIssuedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }),
    [receiptIssuedAt],
  );
  useEffect(() => {
    if (!priceAlert) return;
    const timer = window.setTimeout(() => setPriceAlert(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [priceAlert]);
  useEffect(() => {
    localStorage.setItem(PURCHASE_RECEIPT_DRAFT_KEY, JSON.stringify({
      lines: receiptLines,
      supplier: receiptSupplier,
      invoiceNo: receiptInvoiceNo,
      expenses: receiptExpenses,
      issuedAt: receiptIssuedAt,
    } satisfies PurchaseReceiptDraft));
  }, [receiptExpenses, receiptInvoiceNo, receiptIssuedAt, receiptLines, receiptSupplier]);
  useEffect(() => {
    const query = receiptSearchQuery.trim();
    if (query.length < 2) { setReceiptSearchResults([]); setReceiptSearchBusy(false); return; }
    let cancelled = false;
    setReceiptSearchBusy(true);
    const timer = window.setTimeout(() => {
      void invoke<{ products: CatalogProduct[] }>({ operation: "catalog.list", payload: { query, limit: 12 } })
        .then((result) => {
          if (cancelled) return;
          setReceiptSearchResults(result.products);
          setInvoiceProducts((items) => [...items, ...result.products.filter((product) => !items.some((existing) => existing.id === product.id))]);
        })
        .catch((cause) => { if (!cancelled) { setReceiptSearchResults([]); setMessage(errorMessage(cause)); } })
        .finally(() => { if (!cancelled) setReceiptSearchBusy(false); });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [receiptSearchQuery]);
  useEffect(() => {
    if (!productId && products[0]) setProductId(products[0].id);
  }, [productId, products]);
  useEffect(() => {
    void invoke<{ lots: ExpiryLot[] }>({
      operation: "stock.expiry",
      payload: { days: 30 },
    })
      .then((result) => setExpiry(result.lots))
      .catch(() => setExpiry([]));
  }, [products]);

  function addReceiptProduct(productIdToAdd: string): void {
    const selectedProduct = receiptProducts.find((item) => item.id === productIdToAdd);
    const packSize = selectedProduct?.purchasePackSize ?? 1;
    const packaging = {
      entryUnit: selectedProduct?.unitKind === "WEIGHT"
        ? "WEIGHT" as const
        : packSize > 1 ? "CARTON" as const : "PIECE" as const,
      costBasis: selectedProduct?.unitKind === "WEIGHT"
        ? "LINE_TOTAL" as const
        : "LINE_TOTAL" as const,
      unitsPerPackage: String(packSize),
      retail: selectedProduct
        ? (selectedProduct.unitKind === "WEIGHT" && selectedProduct.weightUnit === "GRAM"
          ? (selectedProduct.priceMinor / 100_000).toString()
          : (selectedProduct.priceMinor / 100).toFixed(2))
        : "",
    };
    setReceiptLines((items) => {
      const emptyIndex = items.findIndex(
        (item) => !item.productId && !item.pendingBarcode,
      );
      if (emptyIndex >= 0)
        return items.map((item, index) =>
          index === emptyIndex ? { ...item, productId: productIdToAdd, ...packaging } : item,
        );
      return [
        ...items,
        { productId: productIdToAdd, ...packaging, qty: "", cost: "", lot: "", expires: "" },
      ];
    });
  }

  async function scanReceiptBarcode(value: string): Promise<void> {
    const barcode = value.trim();
    if (!barcode) return;
    let exact = receiptProducts.find((item) => item.barcodes.includes(barcode));
    if (!exact) {
      try {
        const result = await invoke<{ products: CatalogProduct[] }>({
          operation: "catalog.list",
          payload: { query: barcode, limit: 10 },
        });
        exact = result.products.find((item) => item.barcodes.includes(barcode));
        if (exact)
          setInvoiceProducts((items) =>
            items.some((item) => item.id === exact!.id) ? items : [...items, exact!],
          );
      } catch (cause) {
        setMessage(errorMessage(cause));
        return;
      }
    }
    if (exact) {
      addReceiptProduct(exact.id);
      setReceiptBarcode("");
      return;
    }
    setReceiptLines((items) => {
      const emptyIndex = items.findIndex((item) => !item.productId && !item.pendingBarcode);
      if (emptyIndex >= 0)
        return items.map((item, index) =>
          index === emptyIndex ? { ...item, pendingBarcode: barcode } : item,
        );
      return [...items, { productId: "", pendingBarcode: barcode, entryUnit: "PIECE", costBasis: "LINE_TOTAL", unitsPerPackage: "1", qty: "", cost: "", retail: "", lot: "", expires: "" }];
    });
    setReceiptBarcode("");
    setMessage(`الباركود ${barcode} غير مسجل؛ أكمل بياناته من الزر الأصفر داخل الفاتورة.`);
  }

  function chooseReceiptSearchProduct(product: CatalogProduct): void {
    setInvoiceProducts((items) => items.some((item) => item.id === product.id) ? items : [...items, product]);
    addReceiptProduct(product.id);
    setReceiptSearchQuery("");
    setReceiptSearchResults([]);
    setReceiptSearchOpen(false);
  }

  async function addReceiptProductWithoutBarcode(): Promise<void> {
    const name = (receiptSearchQuery.trim() || manualReceiptProductName.trim());
    if (name.length < 2) {
      setMessage("اكتب اسم الصنف أولاً.");
      return;
    }
    try {
      const generated = await invoke<{ barcode: string }>({ operation: "products.barcode.generate" });
      let lineIndex = 0;
      setReceiptLines((items) => {
        const emptyIndex = items.findIndex((item) => !item.productId && !item.pendingBarcode);
        lineIndex = emptyIndex >= 0 ? emptyIndex : items.length;
        const draft = { productId: "", pendingBarcode: generated.barcode, entryUnit: "PIECE" as const, costBasis: "LINE_TOTAL" as const, unitsPerPackage: "1", qty: "", cost: "", retail: "", lot: "", expires: "" };
        return emptyIndex >= 0 ? items.map((item, index) => index === emptyIndex ? { ...item, pendingBarcode: generated.barcode } : item) : [...items, draft];
      });
      setPendingReceiptProduct({ barcode: generated.barcode, lineIndex, initialName: name });
      setManualReceiptProductName("");
      setReceiptSearchQuery("");
      setReceiptSearchResults([]);
      setReceiptSearchOpen(false);
      setMessage("سيُنشأ باركود داخلي تلقائي للصنف عند حفظ بياناته ثم يضاف إلى فاتورة المورد.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function completeReceiptProduct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!pendingReceiptProduct) return;
    const data = new FormData(event.currentTarget);
    try {
      const retailPriceMinor = minorFromInput(String(data.get("price")));
      const wholesalePriceMinor = minorFromInput(String(data.get("wholesalePrice") || "0"));
      const invoiceQty = String(data.get("invoiceQty") || "").trim();
      const selectedEntryUnit = String(data.get("invoiceEntryUnit")) as "PIECE" | "CARTON" | "WEIGHT";
      const unitKind = selectedEntryUnit === "WEIGHT" ? "WEIGHT" : "PIECE";
      const invoiceEntryUnit = selectedEntryUnit;
      const purchasePackSize = unitKind === "WEIGHT" ? 1 : Number(data.get("purchasePackSize") || 1);
      const qtyMilli = invoiceEntryUnit === "CARTON"
        ? Number(invoiceQty) * purchasePackSize * 1000
        : qtyFromInput(invoiceQty);
      const invoiceCost = String(data.get("invoiceCost") || "").trim();
      if (qtyMilli <= 0 || (unitKind === "PIECE" && qtyMilli % 1000 !== 0) || !Number.isSafeInteger(qtyMilli) ||
        !Number.isInteger(purchasePackSize) || purchasePackSize < 1 ||
        (invoiceEntryUnit === "CARTON" && (!Number.isInteger(Number(invoiceQty)) || Number(invoiceQty) < 1)))
        throw new Error("أدخل كمية صحيحة للصنف الجديد داخل فاتورة المورد.");
      if (minorFromInput(invoiceCost) < 0)
        throw new Error("تكلفة الوحدة لا يمكن أن تكون سالبة.");
      const created = await invoke<{ id: string }>({
        operation: "products.create",
        payload: {
          nameAr: String(data.get("nameAr")).trim(),
          category: String(data.get("category")).trim(),
          unitKind,
          weightUnit: "KILOGRAM",
          priceMinor: retailPriceMinor,
          wholesalePriceMinor,
          purchasePackSize,
          reorderLevelMilli: 0,
          barcodes: [pendingReceiptProduct.barcode],
          openingQtyMilli: 0,
          openingUnitCostMinor: 0,
        },
      });
      const catalog = await invoke<{ products: CatalogProduct[] }>({
        operation: "catalog.list",
        payload: { query: pendingReceiptProduct.barcode, limit: 10 },
      });
      const createdProduct = catalog.products.find(
        (item) => item.id === created.id,
      );
      if (!createdProduct)
        throw new Error("تم إنشاء الصنف لكن تعذر تحميله إلى سطر الفاتورة. أعد المحاولة.");
      setInvoiceProducts((items) =>
        items.some((item) => item.id === createdProduct.id)
          ? items
          : [...items, createdProduct],
      );
      await refresh();
      setReceiptLines((items) =>
        items.map((item, index) =>
          index === pendingReceiptProduct.lineIndex
            ? (() => {
              const { pendingBarcode: _pendingBarcode, ...completed } = item;
              return {
                ...completed,
                productId: created.id,
                entryUnit: invoiceEntryUnit,
                costBasis: "LINE_TOTAL",
                unitsPerPackage: String(purchasePackSize),
                qty: invoiceQty,
                cost: invoiceCost,
                retail: String(data.get("price") ?? ""),
              };
            })()
            : item,
        ),
      );
      setMessage("تمت إضافة الصنف وكمية الفاتورة في السطر نفسه. أضف بقية الأصناف ثم رحّل الفاتورة للمورد.");
      setPendingReceiptProduct(null);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  useEffect(() => {
    function receiveBarcode(event: Event): void {
      const barcode = String((event as CustomEvent<string>).detail || "");
      if (!barcode) return;
      setSection("receive");
      void scanReceiptBarcode(barcode);
    }
    window.addEventListener("nabta:inventory-barcode-scan", receiveBarcode);
    return () =>
      window.removeEventListener("nabta:inventory-barcode-scan", receiveBarcode);
  }, [invoiceProducts, products]);

  useEffect(() => {
    const barcode =
      suggestedBarcode || localStorage.getItem(PENDING_RECEIPT_SCAN_KEY) || "";
    if (!barcode) return;
    setSection("receive");
    void scanReceiptBarcode(barcode);
    clearSuggestedBarcode();
    localStorage.removeItem(PENDING_RECEIPT_SCAN_KEY);
  }, [suggestedBarcode]);

  async function checkPurchasePrice(line: ReceiptLineDraft): Promise<void> {
    const item = receiptProducts.find((candidate) => candidate.id === line.productId);
    if (!item || !line.cost.trim() || !line.qty.trim()) return;
    const packageCount = Number(line.qty);
    const unitsPerPackage = Number(line.unitsPerPackage);
    const qtyMilli = line.entryUnit === "CARTON"
      ? packageCount * unitsPerPackage * 1000
      : qtyFromInput(line.qty);
    const goodsMinor = minorFromInput(line.cost);
    if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0 || goodsMinor <= 0) return;

    try {
      const matches = await invoke<{ items: InvoiceSummaryItem[] }>({
        operation: "invoices.list",
        payload: { kind: "PURCHASE", query: item.nameAr, limit: 80 },
      });
      const details = await Promise.all(matches.items.slice(0, 40).map((invoice) =>
        invoke<InvoiceDetailResponse>({ operation: "invoices.get", payload: { kind: "PURCHASE", id: invoice.id } }),
      ));
      const historic = details.flatMap((invoice) => invoice.lines
        .filter((historicLine) => historicLine.productId === item.id)
        .map((historicLine) => ({
          unitCostMinor: historicLine.unitPriceMinor,
          supplierName: invoice.partyName,
          postedAt: invoice.postedAt,
        })));
      const cheapest = historic.reduce<typeof historic[number] | null>(
        (lowest, candidate) => !lowest || candidate.unitCostMinor < lowest.unitCostMinor ? candidate : lowest,
        null,
      );
      const currentUnitCostMinor = Math.floor((goodsMinor * 1000) / qtyMilli);
      if (cheapest && cheapest.unitCostMinor < currentUnitCostMinor) {
        setPriceAlert({
          productName: item.nameAr,
          currentUnitCostMinor,
          cheaperUnitCostMinor: cheapest.unitCostMinor,
          supplierName: cheapest.supplierName,
          postedAt: cheapest.postedAt,
        });
      }
    } catch {
      // Price comparison is advisory. A temporary history lookup error must never block receiving stock.
    }
  }

  async function loadPurchaseHistory(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    try {
      setHistoryLoading(true);
      const result = await invoke<{ items: InvoiceSummaryItem[] }>({
        operation: "invoices.list",
        payload: {
          kind: "PURCHASE",
          ...(historyQuery.trim() ? { query: historyQuery.trim() } : {}),
          ...(historyFrom ? { from: historyFrom } : {}),
          ...(historyTo ? { to: historyTo } : {}),
          limit: 300,
        },
      });
      setPurchaseHistory(result.items);
      setHistoryDetail(null);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openHistoricPurchase(invoice: InvoiceSummaryItem): Promise<void> {
    try {
      const detail = await invoke<InvoiceDetailResponse>({ operation: "invoices.get", payload: { kind: "PURCHASE", id: invoice.id } });
      setHistoryDetail(detail);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function printPurchaseReceipt(detail: InvoiceDetailResponse): Promise<void> {
    await invoke({
      operation: "hardware.purchase-receipt.print",
      payload: {
        storeName: storeName || "نبتة",
        branding: receiptBranding,
        receipt: {
          id: detail.id,
          invoiceNo: detail.invoiceNo,
          supplierName: detail.partyName,
          supplierPhone: detail.partyPhone,
          postedAt: detail.postedAt,
          goodsMinor: detail.subtotalMinor ?? detail.totalMinor,
          supplyExpensesMinor: detail.supplyExpensesMinor,
          totalMinor: detail.totalMinor,
          receiverName: detail.cashierOrReceiverName,
          lines: detail.lines.map((line) => ({
            productId: line.productId,
            nameAr: line.nameAr,
            unitKind: line.unitKind,
            qtyMilli: line.qtyMilli,
            unitCostMinor: line.unitPriceMinor,
            goodsMinor: line.totalMinor,
            lotCode: line.lotCode,
            expiresOn: line.expiresOn,
          })),
        },
      },
    });
  }

  async function receive(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (postingReceipt) return;
    try {
      setPostingReceipt(true);
      const lines = receiptLines.map((line) => {
        if (line.pendingBarcode)
          throw new Error(`أكمل بيانات الصنف الجديد ذو الباركود ${line.pendingBarcode} أولاً.`);
        const item = receiptProducts.find(
          (candidate) => candidate.id === line.productId,
        );
        const packageCount = Number(line.qty);
        const unitsPerPackage = Number(line.unitsPerPackage);
        const qtyMilli = line.entryUnit === "CARTON"
          ? packageCount * unitsPerPackage * 1000
          : qtyFromInput(line.qty);
        if (
          !item ||
          qtyMilli <= 0 ||
          !Number.isSafeInteger(qtyMilli) ||
          (line.entryUnit === "CARTON" &&
            (!Number.isInteger(packageCount) || packageCount < 1 ||
              !Number.isInteger(unitsPerPackage) || unitsPerPackage < 1)) ||
          (item.unitKind === "PIECE" && qtyMilli % 1000 !== 0)
        )
          throw new Error("راجع الصنف والكمية في سطور الاستلام");
        const lineTotalMinor = minorFromInput(line.cost);
        const retailPriceMinor = minorFromInput(line.retail) *
          (item.unitKind === "WEIGHT" && item.weightUnit === "GRAM" ? 1000 : 1);
        if (lineTotalMinor <= 0 || retailPriceMinor <= 0)
          throw new Error("أدخل إجمالي سعر الشراء وسعر بيع الوحدة لكل صنف.");
        const unitCostMinor = Math.floor((lineTotalMinor * 1000) / qtyMilli);
        const wholesalePriceMinor = unitCostMinor *
          (item.unitKind === "WEIGHT" && item.weightUnit === "GRAM" ? 1000 : 1);
        if (!Number.isSafeInteger(wholesalePriceMinor))
          throw new Error("سعر الجملة المحسوب كبير جدًا.");
        return {
          product: item,
          qtyMilli,
          unitCostMinor,
          wholesalePriceMinor,
          entryUnit: line.entryUnit,
          costBasis: "LINE_TOTAL" as const,
          packageCount: line.entryUnit === "CARTON" ? packageCount : undefined,
          unitsPerPackage: line.entryUnit === "CARTON" ? unitsPerPackage : undefined,
          lineTotalMinor,
          retailPriceMinor,
          lotCode: line.lot.trim() || undefined,
          expiresOn: line.expires || undefined,
        };
      });
      if (!lines.length) throw new Error("أضف صنفًا واحدًا على الأقل");
      const posted = await invoke<{ receiptId: string; postedAt?: string }>({
        operation: "purchases.receive",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          receipt: {
            warehouseId: lines[0]!.product.warehouseId,
            supplierName: receiptSupplier.trim(),
            supplierInvoiceNo: receiptInvoiceNo.trim() || undefined,
            supplyExpensesMinor: receiptExpensesMinor,
            lines: lines.map((line) => ({
              productId: line.product.id,
              qtyMilli: line.qtyMilli,
              unitCostMinor: line.unitCostMinor,
              entryUnit: line.entryUnit,
              costBasis: line.costBasis,
              ...(line.entryUnit === "CARTON" ? {
                packageCount: line.packageCount,
                unitsPerPackage: line.unitsPerPackage,
              } : {}),
              lineTotalMinor: line.lineTotalMinor,
              wholesalePriceMinor: line.wholesalePriceMinor,
              retailPriceMinor: line.retailPriceMinor,
              lotCode: line.lotCode,
              expiresOn: line.expiresOn,
            })),
          },
        },
      });
      await refresh();
      setLastReceiptId(posted.receiptId);
      setReceiptIssuedAt(posted.postedAt ?? new Date().toISOString());
      let printStatus = "";
      try {
        const detail = await invoke<InvoiceDetailResponse>({ operation: "invoices.get", payload: { kind: "PURCHASE", id: posted.receiptId } });
        await printPurchaseReceipt(detail);
        printStatus = " وتم إرسال إذن الاستلام إلى طابعة الإيصالات.";
      } catch (printCause) {
        // Posting the receipt is already final and must never be rolled back
        // merely because the printer is off or not configured.
        printStatus = ` لم تُطبع تلقائيًا: ${errorMessage(printCause)} ويمكنك إعادة طباعتها من زر «طباعة إذن الاستلام».`;
      }
      setReceiptLines([EMPTY_RECEIPT_LINE()]);
      setReceiptSupplier("");
      setReceiptInvoiceNo("");
      setReceiptExpenses("0.00");
      localStorage.removeItem(PURCHASE_RECEIPT_DRAFT_KEY);
      setMessage(`تم استلام البضاعة وتحديث سعر الجملة وسعر البيع والدفتر.${printStatus}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setPostingReceipt(false);
    }
  }

  function resetReceiptDraft(): void {
    setReceiptSupplier("");
    setReceiptInvoiceNo("");
    setReceiptExpenses("0.00");
    setReceiptIssuedAt(new Date().toISOString());
    setReceiptBarcode("");
    setLastReceiptId("");
    setReceiptLines([EMPTY_RECEIPT_LINE()]);
    setReceiptSearchQuery("");
    setReceiptSearchResults([]);
    localStorage.removeItem(PURCHASE_RECEIPT_DRAFT_KEY);
    setMessage("مسودة فاتورة توريد جديدة جاهزة.");
  }

  async function printLastReceipt(): Promise<void> {
    if (!lastReceiptId) return;
    try {
      const detail = await invoke<InvoiceDetailResponse>({ operation: "invoices.get", payload: { kind: "PURCHASE", id: lastReceiptId } });
      await printPurchaseReceipt(detail);
      setMessage(`تم إرسال إذن استلام ${detail.invoiceNo} إلى الطابعة.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function postCount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!product) return;
    const data = new FormData(event.currentTarget);
    try {
      const actualQtyMilli = qtyFromInput(String(data.get("actual")));
      if (product.unitKind === "PIECE" && actualQtyMilli % 1000 !== 0)
        throw new Error("صنف القطعة لا يقبل كسراً");
      await invoke({
        operation: "stock.count.post",
        payload: {
          warehouseId: product.warehouseId,
          productId: product.id,
          actualQtyMilli,
          expectedVersion: product.version,
          reason: String(data.get("reason")),
        },
      });
      await refresh();
      setMessage("تم ترحيل فرق الجرد كسجل تصحيحي.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function lookup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const foundSale = await invoke<SaleLookup>({
          operation: "sales.lookup",
          payload: { invoiceNo: String(data.get("invoiceNo")) },
        });
      setSale(foundSale);
      setReturnLineId(foundSale.lines[0]?.id ?? "");
      setMessage("");
    } catch (cause) {
      setSale(null);
      setMessage(errorMessage(cause));
    }
  }

  async function postReturn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!sale || !shift) return;
    const data = new FormData(event.currentTarget);
    const line = sale.lines.find((item) => item.id === returnLineId);
    if (!line) return;
    try {
      const qtyMilli = qtyFromInput(String(data.get("returnQty")));
      if (
        qtyMilli <= 0 ||
        qtyMilli > line.qtyMilli - line.returnedQtyMilli ||
        (line.unitKind === "PIECE" && qtyMilli % 1000 !== 0)
      )
        throw new Error("كمية المرتجع تتجاوز المتبقي أو غير صحيحة");
      await invoke({
        operation: "sales.return",
        payload: {
          saleId: sale.sale_id,
          idempotencyKey: crypto.randomUUID(),
          return: {
            shiftId: shift.id,
            lines: [
              {
                saleLineId: line.id,
                qtyMilli,
                condition: String(data.get("condition")) as
                  | "RESTOCK"
                  | "DAMAGED",
              },
            ],
            reason: String(data.get("reason")),
          },
        },
      });
      setMessage("تم تسجيل المرتجع وربطه بالفاتورة.");
      setSale(null);
      setReturnLineId("");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function exportCurrentInventory(): Promise<void> {
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; itemCount: number }>({
        operation: "inventory.export-xlsx",
      });
      setMessage(
        result.cancelled
          ? "تم إلغاء حفظ ملف Excel."
          : `تم تصدير ${result.itemCount} صنف متاح إلى Excel: ${result.path}`,
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function exportExpiryAlerts(): Promise<void> {
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; itemCount: number }>({
        operation: "stock.expiry.export-xlsx",
        payload: { days: 30 },
      });
      setMessage(result.cancelled
        ? "تم إلغاء حفظ ملف تنبيه الصلاحية."
        : `تم تصدير ${result.itemCount} تشغيلة قريبة من الانتهاء إلى Excel: ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function exportPeriodicInventory(): Promise<void> {
    if (exportingAudit) return;
    setExportingAudit(true);
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; soldItemCount: number; reorderItemCount: number }>({
        operation: "inventory.periodic-export-xlsx",
        payload: { period: auditPeriod, referenceDate: auditReferenceDate },
      });
      setMessage(result.cancelled
        ? "تم إلغاء حفظ ملف الجرد الدوري."
        : `تم تصدير الجرد بنجاح: ${result.soldItemCount} صنف بحركة بيع أو مرتجع، و${result.reorderItemCount} صنفًا ضمن النواقص. ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setExportingAudit(false);
    }
  }

  return (
    <>
      <PageHead
        title="إدارة المخزون"
        subtitle="اختر العملية المطلوبة؛ كل عملية لها مساحة مستقلة وواضحة."
        action={<div className="page-head-actions"><button onClick={() => void exportCurrentInventory()}>تصدير المخزون الحالي</button></div>}
      />
      <section className="inventory-period-export" aria-label="تصدير جرد دوري">
        <div>
          <h2>جرد دوري للمبيعات والنواقص</h2>
          <p>ينشئ ملف Excel مفصّلًا للأصناف المباعة خلال الفترة، والمرتجعات، والرصيد الحالي، وقائمة شراء للأصناف الناقصة.</p>
        </div>
        <label className="field">
          نوع الجرد
          <select value={auditPeriod} onChange={(event) => setAuditPeriod(event.target.value as InventoryReportPeriod)}>
            <option value="MONTHLY">شهري</option>
            <option value="QUARTERLY">ربع سنوي</option>
            <option value="YEARLY">سنوي</option>
          </select>
        </label>
        <label className="field">
          تاريخ مرجعي للفترة
          <input type="date" value={auditReferenceDate} onChange={(event) => setAuditReferenceDate(event.target.value)} />
        </label>
        <button type="button" className="primary" onClick={() => void exportPeriodicInventory()} disabled={exportingAudit}>
          {exportingAudit ? "جارٍ تجهيز ملف الجرد…" : "تصدير الجرد إلى Excel"}
        </button>
      </section>
      <div className="subtabs" role="tablist" aria-label="عمليات المخزون">
        {(
          [
            ["receive", "استلام مشتريات"],
            ["count", "جرد وتصحيح"],
            ["returns", "مرتجع مبيعات"],
            ["expiry", "تنبيه الصلاحية"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={section === id ? "selected" : ""}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {message && (
        <div className="notice compact-notice" role="status">
          {message}
        </div>
      )}
      {section === "receive" && (
        <div className="receipt-scan">
          <Field label="مسح باركود صنف للاستلام">
            <input
              aria-label="مسح باركود صنف للاستلام"
              value={receiptBarcode}
              onChange={(event) => setReceiptBarcode(event.target.value)}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  setReceiptBarcode("");
                } else if (event.key === "F3") {
                  event.preventDefault();
                  if (receiptBarcode.trim()) onEditProductByQuery(receiptBarcode);
                  else setMessage("امسح باركود الصنف أولاً، ثم اضغط F3 لتعديل بياناته.");
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void scanReceiptBarcode(receiptBarcode);
                }
              }}
              placeholder="امسح الباركود ثم Enter — Esc لمسح | F3 لتعديل"
              autoFocus
            />
          </Field>
          <Field label="صنف جديد بلا باركود">
            <div className="inline-field-action">
              <input
                value={manualReceiptProductName}
                onChange={(event) => setManualReceiptProductName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addReceiptProductWithoutBarcode();
                  }
                }}
                placeholder="اكتب اسم الصنف ثم أضِفه للفاتورة"
              />
              <button type="button" onClick={() => void addReceiptProductWithoutBarcode()}>إضافة وتوليد باركود</button>
            </div>
          </Field>
        </div>
      )}
      {section === "count" && (
        <div className="operation-picker">
          <Field label="الصنف">
            <SearchableSelect
              value={product?.id ?? ""}
              onChange={setProductId}
              options={products.map((item) => ({
                value: item.id,
                label: item.nameAr,
                searchText: item.barcodes.join(" "),
              }))}
              placeholder="ابحث باسم الصنف أو باركوده"
            />
          </Field>
        </div>
      )}
      {section === "receive" && (
        <section className="panel operation-panel receipt-panel supplier-invoice-shell">
          <h2>إدخال فاتورة مورد</h2>
          <p className="panel-help">
            أدخل المورد ومصاريف التوريد مرة واحدة، ثم أضف كل الأصناف في الفاتورة
            نفسها. تظل كل السطور تحت المورد الحالي إلى أن ترحّل الفاتورة.
            للكرتونة: اختر هل محتواها قطع أو عبوات أو أكياس، اكتب سعة الكرتونة وإجمالي الكراتين؛ تُحسب تكلفة الوحدة تلقائيًا بدقة.
          </p>
          <div className="supplier-invoice-heading">
            <div>
              <span className="supplier-invoice-eyebrow">المخزن / استلام مشتريات / فاتورة جديدة</span>
              <h2>فاتورة توريد جديدة</h2>
              <p>استلم البضاعة، حدّث أسعارها، وسجّلها في المخزن في معاملة واحدة قابلة للطباعة.</p>
            </div>
            <div className="supplier-invoice-heading-actions">
              <button type="button" className="supplier-invoice-history-toggle" onClick={() => { setHistoryOpen((open) => !open); if (!historyOpen) void loadPurchaseHistory(); }}>سجل الفواتير</button>
              <button type="button" className="supplier-invoice-reset" onClick={resetReceiptDraft}>فاتورة جديدة</button>
            </div>
          </div>
          <form onSubmit={(event) => void receive(event)}>
            <div className="supplier-invoice-workspace">
            <div className="supplier-invoice-main">
            <section className="supplier-invoice-meta">
              <div className="supplier-invoice-panel-head"><h3>بيانات المورد والفاتورة</h3><span>الحقول الأساسية فقط</span></div>
            <div className="form-grid receipt-meta">
              <Field label="المورد">
                <input name="supplier" value={receiptSupplier} onChange={(event) => setReceiptSupplier(event.target.value)} required placeholder="اسم الشركة أو المورد" />
              </Field>
              <Field label="رقم فاتورة المورد">
                <input name="invoice" value={receiptInvoiceNo} onChange={(event) => setReceiptInvoiceNo(event.target.value)} placeholder="مثال: 1620" />
              </Field>
              <Field label="تاريخ ووقت الإدخال">
                <input value={receiptIssuedAtLabel} readOnly aria-label="تاريخ ووقت إدخال الفاتورة تلقائياً" />
              </Field>
              <Field label="مصروفات التوريد">
                <input
                  name="expense"
                  value={receiptExpenses}
                  onChange={(event) => setReceiptExpenses(event.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                />
              </Field>
            </div>
            <p className="supplier-invoice-note">تُراجع صلاحية المخزن والمورد والأسعار داخل خادم نبتة عند ترحيل الفاتورة.</p>
            </section>
            <section className="supplier-invoice-entry">
              <div className="supplier-invoice-entry-head"><div><h3>إضافة الأصناف بسرعة</h3><p>ابحث بالاسم أو بالباركود؛ الصنف المختار يضاف إلى أول سطر فارغ، ويمكنك مواصلة الفاتورة مباشرةً.</p></div><span>لا يلزم باركود للبحث بالاسم</span></div>
              <div className="receipt-product-search">
                <input
                  value={receiptSearchQuery}
                  onFocus={() => setReceiptSearchOpen(true)}
                  onBlur={() => window.setTimeout(() => setReceiptSearchOpen(false), 140)}
                  onChange={(event) => { setReceiptSearchQuery(event.target.value); setReceiptSearchOpen(true); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (receiptSearchResults[0]) chooseReceiptSearchProduct(receiptSearchResults[0]);
                      else if (receiptSearchQuery.trim().length >= 2) void addReceiptProductWithoutBarcode();
                    }
                  }}
                  placeholder="اكتب اسم الصنف أو الباركود — مثال: جبنة رومي"
                  aria-label="بحث وإضافة صنف إلى فاتورة المورد"
                />
                <button type="button" onClick={() => void addReceiptProductWithoutBarcode()} disabled={receiptSearchQuery.trim().length < 2}>+ صنف جديد</button>
                {receiptSearchOpen && receiptSearchQuery.trim().length >= 2 && (
                  <div className="receipt-product-search-results" role="listbox" aria-label="نتائج أصناف فاتورة المورد">
                    {receiptSearchBusy ? <p>جارٍ البحث…</p> : receiptSearchResults.length ? receiptSearchResults.map((product) => (
                      <button key={product.id} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseReceiptSearchProduct(product)}>
                        <span><b>{product.nameAr}</b><small>{product.category} · {productQuantityLabel(product)}</small></span>
                        <strong>{product.unitKind === "WEIGHT" ? "⚖️ وزن" : product.purchasePackSize > 1 ? "📦 قطعة / كرتونة" : "◻️ قطعة"}</strong>
                      </button>
                    )) : <p>لا يوجد صنف مطابق. اضغط «صنف جديد» لإضافته داخل الفاتورة.</p>}
                  </div>
                )}
              </div>
              <div className="supplier-invoice-barcode">{receiptBarcode || "استخدم قارئ الباركود أو الحقل العلوي لإضافة صنف"}</div>
            </section>
            <div className="receipt-sheet">
              <div className="receipt-sheet-head">
                <span>الصنف</span>
                <span>وحدة الاستلام</span>
                <span>الكمية</span>
                <span>محتوى الكرتونة</span>
                <span>سعة الكرتونة</span>
                <span>إجمالي سعر الشراء</span>
                <span>سعر بيع الوحدة</span>
                <span>التشغيلة</span>
                <span>الصلاحية</span>
                <span></span>
              </div>
              {receiptLines.map((line, index) => (
                <div className="receipt-sheet-row" key={index}>
                  {line.pendingBarcode ? (
                    <div className="receipt-pending-product" role="status">
                      <span>صنف جديد: <b dir="ltr">{line.pendingBarcode}</b></span>
                      <button type="button" onClick={() => setPendingReceiptProduct({ barcode: line.pendingBarcode!, lineIndex: index })}>
                        استكمال بيانات الصنف
                      </button>
                    </div>
                  ) : (
                    <SearchableSelect
                      value={line.productId}
                      onChange={(productId) =>
                        setReceiptLines((items) =>
                          items.map((item, itemIndex) =>
                            itemIndex === index
                              ? (() => {
                                const product = receiptProducts.find((candidate) => candidate.id === productId);
                                const packSize = product?.purchasePackSize ?? 1;
                                const { pendingBarcode: _pendingBarcode, ...selected } = item;
                                return {
                                  ...selected,
                                  productId,
                                  entryUnit: product?.unitKind === "WEIGHT" ? "WEIGHT" : packSize > 1 ? "CARTON" : "PIECE",
                                  costBasis: "LINE_TOTAL",
                                  unitsPerPackage: String(packSize),
                                  retail: product
                                    ? (product.unitKind === "WEIGHT" && product.weightUnit === "GRAM"
                                      ? (product.priceMinor / 100_000).toString()
                                      : (product.priceMinor / 100).toFixed(2))
                                    : item.retail,
                                };
                              })()
                              : item,
                          ),
                        )
                      }
                      required
                      options={receiptProducts.map((item) => ({
                        value: item.id,
                        label: item.nameAr,
                        searchText: item.barcodes.join(" "),
                      }))}
                    placeholder="ابحث عن صنف"
                  />
                )}
                  <select
                    value={line.entryUnit}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                              ...item,
                              entryUnit: event.target.value as "PIECE" | "CARTON" | "WEIGHT",
                              costBasis: "LINE_TOTAL",
                            }
                            : item,
                        ),
                      )
                    }
                    aria-label="وحدة استلام الصنف"
                  >
                    {receiptProducts.find((product) => product.id === line.productId)?.unitKind === "WEIGHT" ? (
                      <option value="WEIGHT">كيلو / جرام</option>
                    ) : (
                      <>
                        <option value="PIECE">قطعة</option>
                        <option value="CARTON">كرتونة</option>
                      </>
                    )}
                  </select>
                  <input
                    value={line.qty}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, qty: event.target.value }
                            : item,
                        ),
                      )
                    }
                    inputMode="decimal"
                    placeholder={line.entryUnit === "CARTON" ? "عدد الكراتين" : line.entryUnit === "WEIGHT" ? "كيلو (مثال 8 أو 0.250)" : "عدد القطع"}
                    required
                  />
                  {line.entryUnit === "CARTON" ? (
                    <select
                      value={line.cartonContent ?? "PIECE"}
                      onChange={(event) =>
                        setReceiptLines((items) =>
                          items.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, cartonContent: event.target.value as "PIECE" | "PACK" | "BAG" }
                              : item,
                          ),
                        )
                      }
                      aria-label="نوع محتوى الكرتونة"
                    >
                      <option value="PIECE">قطع</option>
                      <option value="PACK">عبوات</option>
                      <option value="BAG">أكياس</option>
                    </select>
                  ) : (
                    <span className="receipt-static-cell">{line.entryUnit === "WEIGHT" ? "كيلو / جرام" : "قطعة"}</span>
                  )}
                  <input
                    value={line.unitsPerPackage}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, unitsPerPackage: event.target.value }
                            : item,
                        ),
                      )
                    }
                    disabled={line.entryUnit !== "CARTON"}
                    inputMode="numeric"
                    placeholder={line.entryUnit === "CARTON" ? `عدد ${cartonContentLabel(line.cartonContent)} داخل الكرتونة` : "—"}
                    aria-label="سعة الكرتونة"
                    required
                  />
                  <input
                    value={line.cost}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, cost: event.target.value }
                            : item,
                        ),
                      )
                    }
                    inputMode="decimal"
                    placeholder="إجمالي ما دُفع للكمية"
                    aria-label="إجمالي سعر شراء الكمية"
                    onBlur={() => void checkPurchasePrice(line)}
                    required
                  />
                  <input
                    value={line.retail}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, retail: event.target.value }
                            : item,
                        ),
                      )
                    }
                    inputMode="decimal"
                    placeholder={line.entryUnit === "CARTON"
                      ? `سعر بيع ${cartonContentLabel(line.cartonContent)}`
                      : line.entryUnit === "WEIGHT"
                        ? (receiptProducts.find((product) => product.id === line.productId)?.weightUnit === "GRAM" ? "سعر بيع الجرام" : "سعر بيع الكيلو")
                        : "سعر بيع القطعة"}
                    aria-label="سعر بيع الوحدة"
                    required
                  />
                  <input
                    value={line.lot}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, lot: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder="اختياري"
                  />
                  <input
                    value={line.expires}
                    onChange={(event) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, expires: event.target.value }
                            : item,
                        ),
                      )
                    }
                    type="date"
                    aria-label="تاريخ الصلاحية الاختياري"
                  />
                  <button
                    type="button"
                    aria-label="حذف سطر"
                    disabled={receiptLines.length === 1}
                    onClick={() =>
                      setReceiptLines((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="receipt-actions">
              <button
                type="button"
                onClick={() =>
                  setReceiptLines((items) => [
                    ...items,
                    EMPTY_RECEIPT_LINE(),
                  ])
                }
              >
                + إضافة صنف
              </button>
              <button className="primary" disabled={postingReceipt}>{postingReceipt ? "جارٍ تسجيل الفاتورة…" : "حفظ الفاتورة وتحديث المخزن"}</button>
            </div>
            </div>
            <aside className="supplier-invoice-summary" aria-label="ملخص فاتورة التوريد">
              <header><h3>ملخص الفاتورة</h3><p>يتحدث الحساب تلقائيًا مع كل تعديل</p></header>
              <div className="supplier-summary-line"><span>إجمالي الأصناف</span><b>{formatMoney(receiptGoodsMinor)}</b></div>
              <div className="supplier-summary-line"><span>مصروفات التوريد</span><b>{formatMoney(receiptExpensesMinor)}</b></div>
              <div className="supplier-summary-total"><span>إجمالي فاتورة الشراء</span><b>{formatMoney(receiptTotalMinor)}</b><small>جنيه مصري</small></div>
              <div className="supplier-summary-count"><span>{receiptLines.filter((line) => line.productId || line.pendingBarcode).length}</span> أصناف في الفاتورة</div>
              <div className="supplier-summary-date">وقت الإدخال: <b>{receiptIssuedAtLabel}</b></div>
              <button type="button" className="supplier-print" disabled={!lastReceiptId} onClick={() => void printLastReceipt()}>{lastReceiptId ? "طباعة إذن الاستلام" : "احفظ الفاتورة أولًا للطباعة"}</button>
              <p className="supplier-summary-help">تتم الطباعة من الفاتورة التي سجلها الخادم بالفعل؛ لا تُطبع مسودة غير مرحّلة.</p>
            </aside>
            </div>
            {priceAlert && (
              <aside className="purchase-price-alert" role="alert">
                <div>
                  <strong>تنبيه مقارنة سعر الشراء</strong>
                  <p>الصنف <b>{priceAlert.productName}</b> سُجل سابقاً لدى <b>{priceAlert.supplierName}</b> بسعر أقل: {formatMoney(priceAlert.cheaperUnitCostMinor)} للوحدة، بينما السعر الحالي {formatMoney(priceAlert.currentUnitCostMinor)}.</p>
                  <small>{new Date(priceAlert.postedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })} · يغلق تلقائياً بعد 10 ثوانٍ</small>
                </div>
                <button type="button" onClick={() => setPriceAlert(null)} aria-label="إغلاق تنبيه مقارنة السعر">×</button>
              </aside>
            )}
          </form>
        </section>
      )}
      {section === "receive" && historyOpen && (
        <section className="panel purchase-history-panel" aria-label="البحث المتقدم في فواتير التوريد">
          <div className="purchase-history-head">
            <div><span>أرشيف التوريد</span><h2>استرجاع وطباعة أي فاتورة سابقة</h2><p>ابحث برقم الفاتورة أو اسم المورد أو اسم الصنف أو الباركود، ثم اعرض التفاصيل الكاملة أو اطبعها.</p></div>
            <button type="button" onClick={() => setHistoryOpen(false)}>إغلاق السجل</button>
          </div>
          <form className="purchase-history-filters" onSubmit={(event) => void loadPurchaseHistory(event)}>
            <Field label="بحث متقدم"><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="مورد، رقم فاتورة، اسم صنف أو باركود" /></Field>
            <Field label="من تاريخ"><input type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} /></Field>
            <Field label="إلى تاريخ"><input type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} /></Field>
            <button className="primary" disabled={historyLoading}>{historyLoading ? "جارٍ البحث…" : "بحث"}</button>
          </form>
          <div className="purchase-history-grid">
            <div className="purchase-history-list">
              {purchaseHistory.length === 0 ? <p className="empty-state">لا توجد فواتير مطابقة بعد. اضغط «بحث» لاسترجاع السجل.</p> : purchaseHistory.map((invoice) => (
                <button type="button" key={invoice.id} className={historyDetail?.id === invoice.id ? "selected" : ""} onClick={() => void openHistoricPurchase(invoice)}>
                  <b>{invoice.invoiceNo}</b><span>{invoice.partyName}</span><small>{new Date(invoice.postedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })} · {invoice.itemCount} أصناف</small><strong>{formatMoney(invoice.totalMinor)}</strong>
                </button>
              ))}
            </div>
            <div className="purchase-history-detail">
              {!historyDetail ? <p className="empty-state">اختر فاتورة لعرض أصنافها وتفاصيلها.</p> : <>
                <div className="purchase-history-detail-head"><div><h3>{historyDetail.invoiceNo}</h3><p>{historyDetail.partyName} · {new Date(historyDetail.postedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}</p></div><button type="button" className="primary" onClick={() => void printPurchaseReceipt(historyDetail)}>طباعة الفاتورة</button></div>
                <table><thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الشراء</th><th>الإجمالي</th><th>الصلاحية</th></tr></thead><tbody>{historyDetail.lines.map((line) => <tr key={`${historyDetail.id}-${line.productId}`}><td>{line.nameAr}</td><td>{formatQty(line.qtyMilli, line.unitKind)}</td><td>{formatMoney(line.unitPriceMinor)}</td><td>{formatMoney(line.totalMinor)}</td><td>{line.expiresOn ?? "—"}</td></tr>)}</tbody></table>
                <div className="purchase-history-total">إجمالي الفاتورة <b>{formatMoney(historyDetail.totalMinor)}</b></div>
              </>}
            </div>
          </div>
        </section>
      )}
      {section === "count" && (
        <section className="panel operation-panel">
          <h2>جرد وتصحيح</h2>
          <p className="stock-balance">
            الرصيد الحالي:{" "}
            <strong>
              {product
                ? formatQty(product.availableQtyMilli, product.unitKind)
                : "—"}
            </strong>
          </p>
          <form
            className="form-grid"
            onSubmit={(event) => void postCount(event)}
          >
            <Field label="الكمية الفعلية">
              <input name="actual" inputMode="decimal" required />
            </Field>
            <Field label="سبب فرق الجرد">
              <input name="reason" minLength={3} required />
            </Field>
            <button className="primary full">ترحيل فرق الجرد</button>
          </form>
        </section>
      )}
      {section === "returns" && (
        <section className="panel operation-panel">
          <h2>مرتجع مبيعات</h2>
          <p className="panel-help">
            ابحث أولاً برقم الفاتورة، ثم اختر الصنف والكمية المرتجعة.
          </p>
          <form
            className="lookup-form"
            onSubmit={(event) => void lookup(event)}
          >
            <Field label="رقم الفاتورة">
              <input
                name="invoiceNo"
                placeholder="INV-2026-00000001"
                required
                dir="ltr"
              />
            </Field>
            <button type="submit">بحث عن الفاتورة</button>
          </form>
          {sale && (
            <form
              className="form-grid return-form"
              onSubmit={(event) => void postReturn(event)}
            >
              <Field label="السطر">
                <SearchableSelect
                  value={returnLineId}
                  onChange={setReturnLineId}
                  options={sale.lines.map((line) => ({
                    value: line.id,
                    label: `${line.nameAr} — المتبقي ${formatQty(line.qtyMilli - line.returnedQtyMilli, line.unitKind)}`,
                  }))}
                  placeholder="ابحث عن صنف الفاتورة"
                  required
                />
              </Field>
              <Field label="الكمية المرتجعة">
                <input name="returnQty" inputMode="decimal" required />
              </Field>
              <Field label="حالة المرتجع">
                <select name="condition">
                  <option value="RESTOCK">صالح للمخزون</option>
                  <option value="DAMAGED">تالف</option>
                </select>
              </Field>
              <Field label="السبب">
                <input name="reason" minLength={3} required />
              </Field>
              <button className="primary full" disabled={!shift}>
                تسجيل المرتجع
              </button>
            </form>
          )}
        </section>
      )}
      {section === "expiry" && (
        <section className="panel table-wrap operation-panel">
          <div className="section-head">
            <div>
              <h2>تنبيه الصلاحية — 30 يوماً</h2>
              <p className="panel-help">تظهر تلقائيًا كل دفعة تنتهي خلال شهر، بما فيها ما انتهت صلاحيتها بالفعل.</p>
            </div>
            <button type="button" onClick={() => void exportExpiryAlerts()}>
              تصدير Excel
            </button>
          </div>
          {expiry.length === 0 ? (
            <p className="empty-state">لا توجد تشغيلات قريبة من الانتهاء.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>التشغيلة</th>
                  <th>الكمية</th>
                  <th>الصلاحية</th>
                  <th>المتبقي</th>
                </tr>
              </thead>
              <tbody>
                {expiry.map((lot) => (
                  <tr key={lot.lot_id}>
                    <td>{lot.name_ar}</td>
                    <td>{lot.lot_code ?? "—"}</td>
                    <td>{formatQty(lot.qty_milli, lot.unit_kind)}</td>
                    <td>{lot.expires_on}</td>
                    <td>
                      {lot.days_remaining < 0
                        ? "منتهي"
                        : lot.days_remaining + " يوم"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {pendingReceiptProduct && (
        <div className="modal-backdrop" hidden>
          <form className="modal form-grid" onSubmit={(event) => void completeReceiptProduct(event)}>
            <h2 className="full">استكمال صنف جديد داخل الفاتورة</h2>
            <p className="hint full">الباركود الممسوح: <b dir="ltr">{pendingReceiptProduct.barcode}</b>. ستعود مباشرة إلى سطر الفاتورة بعد الحفظ.</p>
            <Field label="اسم الصنف">
              <input name="nameAr" required autoFocus />
            </Field>
            <Field label="التصنيف">
              <input name="category" required list="nabta-receipt-category-options" placeholder="اكتب أول حرفين لعرض التصنيفات" />
            </Field>
            <Field label="سعر البيع">
              <input name="price" required inputMode="decimal" dir="ltr" />
            </Field>
            <Field label="سعر الجملة">
              <input name="wholesalePrice" required defaultValue="0.00" inputMode="decimal" dir="ltr" />
            </Field>
            <Field label="كمية فاتورة المورد">
              <input
                name="invoiceQty"
                required
                min="1"
                inputMode="decimal"
                dir="ltr"
                placeholder="مثال: 12 أو 8 أو 0.250"
              />
            </Field>
              <Field label="وحدة الاستلام">
              <select name="invoiceEntryUnit" defaultValue="CARTON">
                <option value="CARTON">كرتونة</option>
                <option value="PIECE">قطعة</option>
                <option value="WEIGHT">وزن بالكيلو أو الجرام</option>
              </select>
            </Field>
            <Field label="عدد القطع في الكرتونة (يُهمل للوزن)">
              <input
                name="purchasePackSize"
                type="number"
                min="1"
                step="1"
                defaultValue="1"
                required
                dir="ltr"
              />
            </Field>
            <Field label="التكلفة (للكرتونة أو للقطعة أو لكل كيلو)">
              <input
                name="invoiceCost"
                required
                min="0"
                defaultValue="0.00"
                inputMode="decimal"
                dir="ltr"
              />
            </Field>
            <datalist id="nabta-receipt-category-options">
              {[...new Set(products.map((product) => product.category))].sort((a, b) => a.localeCompare(b, "ar")).map((category) => <option key={category} value={category} />)}
            </datalist>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingReceiptProduct(null)}>
                إلغاء
              </button>
              <button className="primary">حفظ والعودة للفاتورة</button>
            </div>
          </form>
        </div>
      )}
      {pendingReceiptProduct && (
        <ProductCreateModal
          barcode={pendingReceiptProduct.barcode}
          initialName={pendingReceiptProduct.initialName ?? ""}
          products={receiptProducts}
          refresh={refresh}
          canViewCost={canViewCost}
          stockTarget="RECEIPT"
          title="استكمال صنف جديد داخل فاتورة المورد"
          description={<>الباركود الممسوح: <b dir="ltr">{pendingReceiptProduct.barcode}</b>. أتمم بطاقة الصنف الكاملة، ثم ستبقى الكمية والتكلفة في نفس سطر فاتورة المورد.</>}
          onClose={() => setPendingReceiptProduct(null)}
          onCreated={async ({ product: createdProduct, entryUnit, quantity, totalCost, retailPrice, purchasePackSize }) => {
            const lineIndex = pendingReceiptProduct.lineIndex;
            setInvoiceProducts((items) => items.some((item) => item.id === createdProduct.id) ? items : [...items, createdProduct]);
            setReceiptLines((items) => items.map((item, index) => {
              if (index !== lineIndex) return item;
              const { pendingBarcode: _pendingBarcode, ...completed } = item;
              return {
                ...completed,
                productId: createdProduct.id,
                entryUnit,
                costBasis: "LINE_TOTAL",
                unitsPerPackage: String(purchasePackSize),
                qty: quantity,
                cost: totalCost,
                retail: retailPrice,
              };
            }));
            setPendingReceiptProduct(null);
            setMessage("تمت إضافة الصنف وبقي في نفس سطر الفاتورة. أضف بقية الأصناف ثم رحّل الاستلام للمورد.");
          }}
        />
      )}
    </>
  );
}

function ReorderListScreen({ storeName }: { storeName: string }): ReactNode {
  const [data, setData] = useState<ReorderListResponse | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"print" | "pdf" | "">("");
  const load = useCallback(async () => {
    try {
      setData(
        await invoke<ReorderListResponse>({ operation: "stock.reorder-list" }),
      );
      setMessage("");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const report = useMemo<ReorderListDocumentRequest | null>(
    () =>
      data
        ? { storeName, generatedAt: data.generatedAt, items: data.items }
        : null,
    [data, storeName],
  );
  const statusLabel: Record<ReorderListItem["status"], string> = {
    OUT_OF_STOCK: "نفد تمامًا",
    BELOW_REORDER: "أقل من الحد",
    AT_REORDER: "وصل للحد",
  };
  const csvCell = (value: string | number) =>
    `"${String(value).replaceAll('"', '""')}"`;
  function exportCsv(): void {
    if (!data) return;
    const rows = [
      [
        "الصنف",
        "التصنيف",
        "الباركود",
        "الرصيد الحالي",
        "حد إعادة الطلب",
        "الكمية المقترحة",
        "الحالة",
      ],
      ...data.items.map((item) => [
        item.nameAr,
        item.category,
        item.barcode ?? "",
        formatQty(item.availableQtyMilli, item.unitKind),
        formatQty(item.reorderLevelMilli, item.unitKind),
        formatQty(item.shortageQtyMilli, item.unitKind),
        statusLabel[item.status],
      ]),
    ];
    const csv =
      "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = "قائمة شراء نبتة.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }
  async function print(): Promise<void> {
    if (!report) return;
    setBusy("print");
    try {
      await invoke({ operation: "reorder-list.print", payload: report });
      setMessage("فُتحت نافذة طباعة قائمة الشراء. اختر طابعة الورق العادية.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function exportPdf(): Promise<void> {
    if (!report) return;
    setBusy("pdf");
    try {
      const result = await invoke<{ cancelled: boolean; path?: string }>({
        operation: "reorder-list.export-pdf",
        payload: report,
      });
      setMessage(
        result.cancelled
          ? "تم إلغاء حفظ PDF."
          : `تم حفظ قائمة الشراء بصيغة PDF في: ${result.path}`,
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  const items = data?.items ?? [];
  return (
    <>
      <PageHead
        title="قائمة الشراء والتنبيهات"
        subtitle="تُحسب من الرصيد الفعلي وحد إعادة الطلب المسجل لكل صنف."
        action={
          <div className="actions">
            <button onClick={() => void load()}>تحديث</button>
            <button onClick={exportCsv} disabled={!data || !items.length}>
              تصدير CSV
            </button>
            <button
              onClick={() => void print()}
              disabled={!report || busy !== ""}
            >
              {busy === "print" ? "جارٍ فتح الطباعة…" : "طباعة A4"}
            </button>
            <button
              className="primary"
              onClick={() => void exportPdf()}
              disabled={!report || busy !== ""}
            >
              {busy === "pdf" ? "جارٍ التصدير…" : "تصدير PDF"}
            </button>
          </div>
        }
      />
      {message && <div className="notice">{message}</div>}
      <div className="reorder-stats">
        <section className="panel reorder-stat critical">
          <small>نفد تمامًا</small>
          <strong>{data?.totals.outOfStock ?? "—"}</strong>
          <span>صنف يحتاج استلامًا قبل البيع</span>
        </section>
        <section className="panel reorder-stat warning">
          <small>أقل من الحد</small>
          <strong>{data?.totals.belowReorder ?? "—"}</strong>
          <span>صنف يُنصح بشرائه الآن</span>
        </section>
        <section className="panel reorder-stat">
          <small>وصل للحد</small>
          <strong>{data?.totals.atReorder ?? "—"}</strong>
          <span>صنف للمراجعة والمتابعة</span>
        </section>
      </div>
      <section className="panel table-wrap reorder-table">
        <div className="panel-title-row">
          <div>
            <h2>ورقة الأصناف المطلوب شراؤها</h2>
            <p className="hint">
              الكمية المقترحة تسد العجز حتى حد إعادة الطلب؛ لا تنشئ أمر شراء
              تلقائيًا.
            </p>
          </div>
          <small>
            {data
              ? `آخر تحديث: ${new Date(data.generatedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`
              : ""}
          </small>
        </div>
        <table>
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الباركود</th>
              <th>الرصيد</th>
              <th>حد الطلب</th>
              <th>الكمية المقترحة</th>
              <th>الحالة</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.productId}>
                <td>
                  <b>{item.nameAr}</b>
                  <small>{item.category}</small>
                </td>
                <td className="ltr">{item.barcode ?? "—"}</td>
                <td>{formatQty(item.availableQtyMilli, item.unitKind)}</td>
                <td>
                  {formatQty(item.reorderLevelMilli, item.unitKind)}
                  {item.smartReorderLevelMilli > 0 && (
                    <small>حد ذكي: {formatQty(item.smartReorderLevelMilli, item.unitKind)} · متوسط البيع اليومي: {formatQty(item.averageDailyDemandMilli, item.unitKind)}</small>
                  )}
                </td>
                <td>
                  <b>{formatQty(item.shortageQtyMilli, item.unitKind)}</b>
                </td>
                <td>
                  <span
                    className={`reorder-status ${item.status.toLowerCase()}`}
                  >
                    {statusLabel[item.status]}
                  </span>
                </td>
              </tr>
            ))}
            {data && !items.length && (
              <tr>
                <td colSpan={6} className="empty-state">
                  لا توجد أصناف وصلت إلى حد إعادة الطلب.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

function InvoicesScreen({
  products,
  storeName,
  receiptBranding,
  refreshProducts,
  user,
}: {
  products: CatalogProduct[];
  storeName: string;
  receiptBranding?: ReceiptBranding | undefined;
  refreshProducts: (query?: string) => Promise<CatalogProduct[]>;
  user: User;
}): ReactNode {
  const branding = receiptBranding ?? {
    logoDataUrl: "",
    receiptPhone: "",
    whatsappPhone: "",
    socialHandle: "",
    receiptFooter: "شكراً لزيارتكم",
  };
  const [invoices, setInvoices] = useState<InvoiceSummaryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [kindFilter, setKindFilter] = useState<InvoiceKind>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(false);
  const actionInProgressRef = useRef(false);

  // New Purchase Receipt state
  const [showNewPurchaseModal, setShowNewPurchaseModal] = useState(false);
  const [suppliers, setSuppliers] = useState<Partner[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [manualSupplierName, setManualSupplierName] = useState("");
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState("");
  const [supplyExpenses, setSupplyExpenses] = useState("");
  const [purchaseLines, setPurchaseLines] = useState<
    Array<{ productId: string; qty: string; cost: string; retail: string; wholesale: string; lot: string; expires: string }>
  >([{ productId: products[0]?.id ?? "", qty: "1", cost: "", retail: products[0] ? (products[0].priceMinor / 100).toFixed(2) : "", wholesale: products[0]?.wholesalePriceMinor !== undefined ? (products[0].wholesalePriceMinor / 100).toFixed(2) : "", lot: "", expires: "" }]);

  const loadSuppliers = useCallback(async () => {
    try {
      const list = await invoke<Partner[]>({ operation: "partners.suppliers.list" });
      setSuppliers(list);
    } catch {
      // Ignored
    }
  }, []);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invoke<{ items: InvoiceSummaryItem[] }>({
        operation: "invoices.list",
        payload: {
          kind: kindFilter,
          ...(searchQuery.trim() ? { query: searchQuery.trim() } : {}),
          ...(fromDate ? { from: fromDate } : {}),
          ...(toDate ? { to: toDate } : {}),
          limit: 300,
        },
      });
      setInvoices(res.items);
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [kindFilter, searchQuery, fromDate, toDate]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    if (showNewPurchaseModal) void loadSuppliers();
  }, [showNewPurchaseModal, loadSuppliers]);

  function applyDatePreset(preset: "today" | "week" | "month" | "all") {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const format = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    if (preset === "all") {
      setFromDate("");
      setToDate("");
    } else if (preset === "today") {
      const str = format(today);
      setFromDate(str);
      setToDate(str);
    } else if (preset === "week") {
      const past = new Date(today);
      past.setDate(past.getDate() - 7);
      setFromDate(format(past));
      setToDate(format(today));
    } else if (preset === "month") {
      const past = new Date(today.getFullYear(), today.getMonth(), 1);
      setFromDate(format(past));
      setToDate(format(today));
    }
  }

  async function viewDetails(item: InvoiceSummaryItem) {
    setDetailLoading(true);
    try {
      const detail = await invoke<InvoiceDetailResponse>({
        operation: "invoices.get",
        payload: { kind: item.kind, id: item.id },
      });
      setSelectedInvoice(detail);
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }

  async function reprintSale(saleId: string) {
    if (actionInProgressRef.current) return;
    actionInProgressRef.current = true;
    setActionInProgress(true);
    try {
      const reprintData = await invoke<SaleResponse & { reprintCount: number }>({
        operation: "sales.reprint",
        payload: { saleId },
      });
      await invoke({
        operation: "hardware.receipt.print",
        payload: {
          storeName,
          branding,
          copies: 1,
          sale: reprintData,
        },
      });
      setMessage(`تمت طباعة الفاتورة رقم ${reprintData.invoiceNo} بالتاريخ القديم بنجاح.`);
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      actionInProgressRef.current = false;
      setActionInProgress(false);
    }
  }

  async function printPurchase(purchaseId: string) {
    if (actionInProgressRef.current) return;
    actionInProgressRef.current = true;
    setActionInProgress(true);
    try {
      const detail = await invoke<InvoiceDetailResponse>({
        operation: "invoices.get",
        payload: { kind: "PURCHASE", id: purchaseId },
      });
      await invoke({
        operation: "hardware.purchase-receipt.print",
        payload: {
          storeName,
          branding,
          receipt: {
            id: detail.id,
            invoiceNo: detail.invoiceNo,
            supplierName: detail.partyName,
            supplierPhone: detail.partyPhone,
            postedAt: detail.postedAt,
            goodsMinor: detail.subtotalMinor ?? detail.totalMinor,
            supplyExpensesMinor: detail.supplyExpensesMinor,
            totalMinor: detail.totalMinor,
            receiverName: detail.cashierOrReceiverName,
            lines: detail.lines.map((l) => ({
              productId: l.productId,
              nameAr: l.nameAr,
              unitKind: l.unitKind,
              qtyMilli: l.qtyMilli,
              unitCostMinor: l.unitPriceMinor,
              goodsMinor: l.totalMinor,
              lotCode: l.lotCode,
              expiresOn: l.expiresOn,
            })),
          },
        },
      });
      setMessage(`تم إرسال إذن توريد ${detail.invoiceNo} بالتاريخ القديم إلى الطابعة.`);
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      actionInProgressRef.current = false;
      setActionInProgress(false);
    }
  }

  async function exportPurchasePdf(purchaseId: string) {
    setActionInProgress(true);
    try {
      const detail = await invoke<InvoiceDetailResponse>({
        operation: "invoices.get",
        payload: { kind: "PURCHASE", id: purchaseId },
      });
      const res = await invoke<{ cancelled: boolean; path?: string }>({
        operation: "invoices.purchase-receipt.export-pdf",
        payload: {
          storeName,
          branding,
          receipt: {
            id: detail.id,
            invoiceNo: detail.invoiceNo,
            supplierName: detail.partyName,
            supplierPhone: detail.partyPhone,
            postedAt: detail.postedAt,
            goodsMinor: detail.subtotalMinor ?? detail.totalMinor,
            supplyExpensesMinor: detail.supplyExpensesMinor,
            totalMinor: detail.totalMinor,
            receiverName: detail.cashierOrReceiverName,
            lines: detail.lines.map((l) => ({
              productId: l.productId,
              nameAr: l.nameAr,
              unitKind: l.unitKind,
              qtyMilli: l.qtyMilli,
              unitCostMinor: l.unitPriceMinor,
              goodsMinor: l.totalMinor,
              lotCode: l.lotCode,
              expiresOn: l.expiresOn,
            })),
          },
        },
      });
      if (!res.cancelled && res.path) {
        setMessage(`تم حفظ ملف PDF للفاتورة في: ${res.path}`);
      }
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setActionInProgress(false);
    }
  }

  async function handleNewPurchaseSubmit(e: FormEvent) {
    e.preventDefault();
    setActionInProgress(true);
    try {
      const supplierName = selectedSupplierId
        ? (suppliers.find((s) => s.id === selectedSupplierId)?.name ?? "")
        : manualSupplierName.trim();

      if (!supplierName) {
        throw new Error("يرجى اختيار مورد أو كتابة اسم المورد");
      }

      const validLines = purchaseLines.filter((l) => l.productId && l.qty && l.cost && l.retail && (!user.permissions.includes("VIEW_COST") || l.wholesale));
      if (validLines.length === 0) {
        throw new Error("يرجى إضافة صنف واحد على الأقل مع الكمية والتكلفة وسعر البيع وسعر الجملة الداخلي");
      }

      const parsedLines = validLines.map((l) => {
        const prod = products.find((p) => p.id === l.productId);
        if (!prod) throw new Error("أحد الأصناف غير موجود");
        const qtyMilli = qtyFromInput(l.qty);
        if (qtyMilli <= 0) throw new Error("الكمية يجب أن تكون أكبر من صفر");
        if (prod.unitKind === "PIECE" && qtyMilli % 1000 !== 0) {
          throw new Error(`الصنف ${prod.nameAr} يباع بالقطعة ولا يقبل كسور`);
        }
        const lineTotalMinor = minorFromInput(l.cost);
        const retailPriceMinor = minorFromInput(l.retail) *
          (prod.unitKind === "WEIGHT" && prod.weightUnit === "GRAM" ? 1000 : 1);
        if (lineTotalMinor <= 0 || retailPriceMinor <= 0)
          throw new Error(`أدخل إجمالي الشراء وسعر البيع للصنف ${prod.nameAr}`);
        return {
          productId: l.productId,
          qtyMilli,
          unitCostMinor: Math.floor((lineTotalMinor * 1000) / qtyMilli),
          entryUnit: prod.unitKind === "WEIGHT" ? "WEIGHT" as const : "PIECE" as const,
          costBasis: "LINE_TOTAL" as const,
          lineTotalMinor,
          retailPriceMinor,
          ...(user.permissions.includes("VIEW_COST") ? { wholesalePriceMinor: minorFromInput(l.wholesale) } : {}),
          lotCode: l.lot.trim() || undefined,
          expiresOn: l.expires || undefined,
        };
      });

      const expensesMinor = supplyExpenses.trim() ? minorFromInput(supplyExpenses) : 0;

      const defaultWarehouseId = products[0]?.warehouseId;
      if (!defaultWarehouseId) {
        throw new Error("لا توجد أصناف في المتجر للاستلام");
      }

      await invoke({
        operation: "purchases.receive",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          receipt: {
            warehouseId: defaultWarehouseId,
            supplierId: selectedSupplierId || undefined,
            supplierName,
            supplierInvoiceNo: supplierInvoiceNo.trim() || undefined,
            supplyExpensesMinor: expensesMinor,
            lines: parsedLines,
          },
        },
      });

      await refreshProducts();
      await loadInvoices();
      setShowNewPurchaseModal(false);
      setManualSupplierName("");
      setSelectedSupplierId("");
      setSupplierInvoiceNo("");
      setSupplyExpenses("");
      setPurchaseLines([{ productId: products[0]?.id ?? "", qty: "1", cost: "", retail: products[0] ? (products[0].priceMinor / 100).toFixed(2) : "", wholesale: products[0]?.wholesalePriceMinor !== undefined ? (products[0].wholesalePriceMinor / 100).toFixed(2) : "", lot: "", expires: "" }]);
      setMessage("تم تسجيل فاتورة التوريد بنجاح وتحديث أرصدة المخزن والمورد فوراً بدون أي تعارض.");
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setActionInProgress(false);
    }
  }

  const salesCount = useMemo(() => invoices.filter((i) => i.kind === "SALE").length, [invoices]);
  const purchasesCount = useMemo(() => invoices.filter((i) => i.kind === "PURCHASE").length, [invoices]);
  const salesTotalMinor = useMemo(
    () => invoices.filter((i) => i.kind === "SALE").reduce((acc, curr) => acc + curr.totalMinor, 0),
    [invoices]
  );
  const purchasesTotalMinor = useMemo(
    () => invoices.filter((i) => i.kind === "PURCHASE").reduce((acc, curr) => acc + curr.totalMinor, 0),
    [invoices]
  );

  return (
    <div className="invoices-shell">
      {message && (
        <div className="banner" onClick={() => setMessage("")} style={{ cursor: "pointer" }}>
          <span>{message}</span>
          <button type="button" onClick={() => setMessage("")}>×</button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="invoice-kpis">
        <div className="invoice-kpi-card">
          <span>إجمالي الفواتير المعروضة</span>
          <b>{invoices.length}</b>
        </div>
        <div className="invoice-kpi-card green">
          <span>فواتير المبيعات ({salesCount})</span>
          <b>{formatMoney(salesTotalMinor)}</b>
        </div>
        <div className="invoice-kpi-card blue">
          <span>فواتير التوريد ({purchasesCount})</span>
          <b>{formatMoney(purchasesTotalMinor)}</b>
        </div>
        <div className="invoice-kpi-card amber">
          <span>صافي حركة الفواتير</span>
          <b>{formatMoney(salesTotalMinor - purchasesTotalMinor)}</b>
        </div>
      </div>

      {/* Toolbar & Filters */}
      <div className="invoice-toolbar">
        <div className="invoice-toolbar-row">
          <div className="invoice-kind-tabs">
            <button
              type="button"
              className={kindFilter === "ALL" ? "active" : ""}
              onClick={() => setKindFilter("ALL")}
            >
              الكل ({invoices.length})
            </button>
            <button
              type="button"
              className={kindFilter === "SALE" ? "active" : ""}
              onClick={() => setKindFilter("SALE")}
            >
              فواتير المبيعات
            </button>
            <button
              type="button"
              className={kindFilter === "PURCHASE" ? "active" : ""}
              onClick={() => setKindFilter("PURCHASE")}
            >
              فواتير التوريد والمشتريات
            </button>
          </div>

          {user.permissions.includes("PURCHASE_RECEIVE") && (
            <button
              type="button"
              className="primary"
              onClick={() => setShowNewPurchaseModal(true)}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <span>+</span>
              <span>تسجيل فاتورة توريد جديدة</span>
            </button>
          )}
        </div>

        <div className="invoice-toolbar-row">
          <div className="invoice-search-box">
            <input
              type="text"
              placeholder="ابحث برقم الفاتورة، أو اسم المشتري، أو اسم المورد..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="invoice-clear-btn"
                onClick={() => setSearchQuery("")}
                title="مسح البحث"
              >
                ✕
              </button>
            )}
          </div>

          <div className="invoice-date-filters">
            <label>
              <span>من:</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </label>
            <label>
              <span>إلى:</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </label>
            <div className="quick-date-buttons">
              <button type="button" onClick={() => applyDatePreset("today")}>اليوم</button>
              <button type="button" onClick={() => applyDatePreset("week")}>أسبوع</button>
              <button type="button" onClick={() => applyDatePreset("month")}>شهر</button>
              <button type="button" onClick={() => applyDatePreset("all")}>الكل</button>
            </div>
            <button
              type="button"
              onClick={() => void loadInvoices()}
              disabled={loading}
              title="تحديث البيانات"
            >
              {loading ? "جاري التحميل..." : "تحديث"}
            </button>
          </div>
        </div>
      </div>

      {/* Table of Invoices */}
      <section className="panel" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div className="table-wrap" style={{ flex: 1, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>نوع الفاتورة</th>
                <th>رقم الفاتورة</th>
                <th>تاريخ الشراء / التوريد القديم</th>
                <th>المشتري / المورد</th>
                <th>الأصناف</th>
                <th>طريقة الدفع / القيد</th>
                <th>الإجمالي</th>
                <th>المسؤول</th>
                <th style={{ textAlign: "center" }}>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const formattedDate = new Intl.DateTimeFormat("ar-EG", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "Africa/Cairo",
                }).format(new Date(inv.postedAt));

                return (
                  <tr key={`${inv.kind}-${inv.id}`}>
                    <td>
                      <span className={`invoice-badge ${inv.kind === "SALE" ? "sale" : "purchase"}`}>
                        {inv.kind === "SALE" ? "فاتورة بيع" : "فاتورة توريد"}
                      </span>
                    </td>
                    <td>
                      <b dir="ltr" style={{ fontFamily: "monospace", fontSize: 13 }}>{inv.invoiceNo}</b>
                    </td>
                    <td>
                      <div className="invoice-original-date">
                        <b>{formattedDate}</b>
                        <small>التاريخ الأصلي للعملية</small>
                      </div>
                    </td>
                    <td>
                      <div>
                        <b>{inv.partyName}</b>
                        {inv.partyPhone && (
                          <div dir="ltr" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                            {inv.partyPhone}
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      <span>{inv.itemCount} صنف</span>
                    </td>
                    <td>
                      <span style={{ fontSize: 12 }}>
                        {inv.kind === "PURCHASE"
                          ? "استلام مخزني"
                          : inv.paymentMethod === "CASH"
                          ? "نقدي"
                          : inv.paymentMethod === "CARD"
                          ? "بطاقة / فيزا"
                          : inv.paymentMethod === "CREDIT"
                          ? "آجل / حساب عميل"
                          : inv.paymentMethod || "نقدي"}
                      </span>
                    </td>
                    <td>
                      <b style={{ color: inv.kind === "SALE" ? "var(--green)" : "#3b82f6" }}>
                        {formatMoney(inv.totalMinor)}
                      </b>
                      {inv.discountMinor > 0 && (
                        <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                          خصم: {formatMoney(inv.discountMinor)}
                        </div>
                      )}
                    </td>
                    <td>
                      <small style={{ color: "var(--ink-muted)" }}>{inv.cashierOrReceiverName}</small>
                    </td>
                    <td>
                      <div className="invoice-table-actions" style={{ justifyContent: "center" }}>
                        <button
                          type="button"
                          onClick={() => void viewDetails(inv)}
                          disabled={detailLoading}
                          title="عرض تفاصيل الأصناف"
                        >
                          تفاصيل
                        </button>
                        {inv.kind === "SALE" ? (
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void reprintSale(inv.id)}
                            disabled={actionInProgress}
                            title="إعادة طباعة الفاتورة بالتاريخ القديم الأصلي"
                          >
                            طباعة
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void printPurchase(inv.id)}
                            disabled={actionInProgress}
                            title="طباعة إذن التوريد بالتاريخ القديم الأصلي"
                          >
                            طباعة
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && invoices.length === 0 && (
                <tr>
                  <td colSpan={9} className="table-empty">
                    لا توجد فواتير مطابقة للبحث أو الفلترة المحددة.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={9} className="table-empty">
                    جاري تحميل الفواتير...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Invoice Details Modal */}
      {selectedInvoice && (
        <div className="modal-backdrop" onClick={() => setSelectedInvoice(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2>
                  {selectedInvoice.kind === "SALE" ? "تفاصيل فاتورة البيع" : "تفاصيل فاتورة التوريد"} (
                  <span dir="ltr">{selectedInvoice.invoiceNo}</span>)
                </h2>
                <p>
                  تاريخ العملية الأصلي:{" "}
                  <b>
                    {new Intl.DateTimeFormat("ar-EG", {
                      dateStyle: "full",
                      timeStyle: "short",
                      timeZone: "Africa/Cairo",
                    }).format(new Date(selectedInvoice.postedAt))}
                  </b>
                </p>
              </div>
              <span className={`invoice-badge ${selectedInvoice.kind === "SALE" ? "sale" : "purchase"}`}>
                {selectedInvoice.kind === "SALE" ? "فاتورة بيع" : "فاتورة توريد"}
              </span>
            </div>

            <div className="invoice-detail-grid">
              <div className="invoice-detail-item">
                <span>{selectedInvoice.kind === "SALE" ? "اسم المشتري (العميل):" : "اسم المورد:"}</span>
                <b>{selectedInvoice.partyName}</b>
              </div>
              <div className="invoice-detail-item">
                <span>رقم الهاتف:</span>
                <b dir="ltr">{selectedInvoice.partyPhone || "غير مسجل"}</b>
              </div>
              <div className="invoice-detail-item">
                <span>المسؤول:</span>
                <b>{selectedInvoice.cashierOrReceiverName}</b>
              </div>
              <div className="invoice-detail-item">
                <span>طريقة الدفع / القيد:</span>
                <b>
                  {selectedInvoice.kind === "PURCHASE"
                    ? "استلام مخزني"
                    : selectedInvoice.paymentMethod === "CASH"
                    ? "نقدي"
                    : selectedInvoice.paymentMethod === "CARD"
                    ? "بطاقة / فيزا"
                    : selectedInvoice.paymentMethod === "CREDIT"
                    ? "آجل / حساب عميل"
                    : selectedInvoice.paymentMethod || "نقدي"}
                </b>
              </div>
              <div className="invoice-detail-item">
                <span>تاريخ التوريد / الشراء القديم:</span>
                <b>
                  {new Intl.DateTimeFormat("ar-EG", {
                    dateStyle: "short",
                    timeStyle: "short",
                    timeZone: "Africa/Cairo",
                  }).format(new Date(selectedInvoice.postedAt))}
                </b>
              </div>
              <div className="invoice-detail-item">
                <span>عدد الأصناف:</span>
                <b>{selectedInvoice.lines.length} صنف</b>
              </div>
            </div>

            <h3 style={{ fontSize: 15, marginBottom: 10 }}>الأصناف المشمولة بالفاتورة:</h3>
            <div className="table-wrap">
              <table className="invoice-lines-table">
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>الكمية</th>
                    <th>{selectedInvoice.kind === "SALE" ? "سعر البيع" : "سعر التكلفة"}</th>
                    <th>الإجمالي</th>
                    {selectedInvoice.kind === "PURCHASE" && <th>رقم التشغيلة</th>}
                    {selectedInvoice.kind === "PURCHASE" && <th>الصلاحية</th>}
                  </tr>
                </thead>
                <tbody>
                  {selectedInvoice.lines.map((line, idx) => (
                    <tr key={`${line.productId}-${idx}`}>
                      <td><b>{line.nameAr}</b></td>
                      <td dir="ltr">{(line.saleUnit === "PACKAGE" || line.saleUnit === "CARTON") && line.packageSize ? `${line.qtyMilli / (line.packageSize * 1000)} ${line.saleUnit === "CARTON" ? "كرتونة" : "عبوة"}` : formatQty(line.qtyMilli, line.unitKind)}</td>
                      <td dir="ltr">{formatMoney(line.unitPriceMinor)}</td>
                      <td dir="ltr"><b>{formatMoney(line.totalMinor)}</b></td>
                      {selectedInvoice.kind === "PURCHASE" && <td dir="ltr">{line.lotCode || "—"}</td>}
                      {selectedInvoice.kind === "PURCHASE" && <td>{line.expiresOn || "—"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="invoice-summary-box">
              <table className="invoice-summary-table">
                <tbody>
                  {selectedInvoice.subtotalMinor !== undefined && selectedInvoice.subtotalMinor !== selectedInvoice.totalMinor && (
                    <tr>
                      <td>إجمالي البضاعة:</td>
                      <td dir="ltr">{formatMoney(selectedInvoice.subtotalMinor)}</td>
                    </tr>
                  )}
                  {selectedInvoice.discountMinor > 0 && (
                    <tr>
                      <td>الخصم:</td>
                      <td dir="ltr">− {formatMoney(selectedInvoice.discountMinor)}</td>
                    </tr>
                  )}
                  {selectedInvoice.supplyExpensesMinor > 0 && (
                    <tr>
                      <td>مصروفات التوريد:</td>
                      <td dir="ltr">+ {formatMoney(selectedInvoice.supplyExpensesMinor)}</td>
                    </tr>
                  )}
                  <tr className="total-row">
                    <td>الإجمالي النهائي:</td>
                    <td dir="ltr">{formatMoney(selectedInvoice.totalMinor)}</td>
                  </tr>
                  {selectedInvoice.paidMinor > 0 && selectedInvoice.kind === "SALE" && (
                    <tr>
                      <td>المدفوع:</td>
                      <td dir="ltr">{formatMoney(selectedInvoice.paidMinor)}</td>
                    </tr>
                  )}
                  {selectedInvoice.changeMinor > 0 && (
                    <tr>
                      <td>الباقي:</td>
                      <td dir="ltr">{formatMoney(selectedInvoice.changeMinor)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="modal-actions">
              {selectedInvoice.kind === "SALE" ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => void reprintSale(selectedInvoice.id)}
                  disabled={actionInProgress}
                >
                  طباعة إيصال الفاتورة (بالتاريخ القديم)
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void printPurchase(selectedInvoice.id)}
                    disabled={actionInProgress}
                  >
                    طباعة إذن التوريد (بالتاريخ القديم)
                  </button>
                  <button
                    type="button"
                    onClick={() => void exportPurchasePdf(selectedInvoice.id)}
                    disabled={actionInProgress}
                  >
                    حفظ PDF
                  </button>
                </>
              )}
              <button type="button" onClick={() => setSelectedInvoice(null)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {/* New Purchase Invoice Modal */}
      {showNewPurchaseModal && (
        <div className="modal-backdrop" onClick={() => setShowNewPurchaseModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title-row">
              <h2>تسجيل فاتورة توريد جديدة</h2>
              <p>تُسجل الفاتورة وتُضاف الأصناف فوراً إلى رصيد المخزن بدون أي تعارض.</p>
            </div>

            <form onSubmit={(e) => void handleNewPurchaseSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="two-columns">
                <Field label="المورد">
                  <select
                    value={selectedSupplierId}
                    onChange={(e) => setSelectedSupplierId(e.target.value)}
                  >
                    <option value="">-- مورد غير مسجل / جديد --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.phone ? `(${s.phone})` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                {!selectedSupplierId && (
                  <Field label="اسم المورد الجديد">
                    <input
                      type="text"
                      required
                      placeholder="مثال: شركة الأهرام للمواد الغذائية"
                      value={manualSupplierName}
                      onChange={(e) => setManualSupplierName(e.target.value)}
                    />
                  </Field>
                )}
              </div>

              <div className="two-columns">
                <Field label="رقم فاتورة المورد (اختياري)">
                  <input
                    type="text"
                    placeholder="مثال: INV-98741"
                    value={supplierInvoiceNo}
                    onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                  />
                </Field>
                <Field label="مصروفات التوريد والنقل (ج.م)">
                  <input
                    type="text"
                    placeholder="0.00"
                    value={supplyExpenses}
                    onChange={(e) => setSupplyExpenses(e.target.value)}
                  />
                </Field>
              </div>

              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <b style={{ fontSize: 14 }}>أصناف فاتورة التوريد:</b>
                  <button
                    type="button"
                    onClick={() =>
                      setPurchaseLines((prev) => [
                        ...prev,
                        { productId: products[0]?.id ?? "", qty: "1", cost: "", retail: products[0] ? (products[0].priceMinor / 100).toFixed(2) : "", wholesale: products[0]?.wholesalePriceMinor !== undefined ? (products[0].wholesalePriceMinor / 100).toFixed(2) : "", lot: "", expires: "" },
                      ])
                    }
                  >
                    + إضافة صنف آخر
                  </button>
                </div>

                {purchaseLines.map((line, index) => (
                  <div key={index} className="lines-builder-row">
                    <Field label="الصنف">
                      <select
                        value={line.productId}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPurchaseLines((prev) =>
                            prev.map((item, i) => {
                              if (i !== index) return item;
                              const selected = products.find((product) => product.id === val);
                              return { ...item, productId: val, retail: selected ? (selected.priceMinor / 100).toFixed(2) : item.retail, wholesale: selected?.wholesalePriceMinor !== undefined ? (selected.wholesalePriceMinor / 100).toFixed(2) : item.wholesale };
                            })
                          );
                        }}
                      >
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.nameAr} ({p.unitKind === "PIECE" ? "قطعة" : "كجم"})
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field label="الكمية">
                      <input
                        type="text"
                        placeholder="الكمية"
                        value={line.qty}
                        required
                        onChange={(e) => {
                          const val = e.target.value;
                          setPurchaseLines((prev) =>
                            prev.map((item, i) => (i === index ? { ...item, qty: val } : item))
                          );
                        }}
                      />
                    </Field>

                    <Field label="إجمالي سعر الشراء للكمية">
                      <input
                        type="text"
                        placeholder="إجمالي ما دُفع (ج.م)"
                        value={line.cost}
                        required
                        onChange={(e) => {
                          const val = e.target.value;
                          setPurchaseLines((prev) =>
                            prev.map((item, i) => (i === index ? { ...item, cost: val } : item))
                          );
                        }}
                      />
                    </Field>

                    <Field label="سعر البيع للجمهور">
                      <input
                        type="text"
                        placeholder="سعر البيع (ج.م)"
                        value={line.retail}
                        required
                        onChange={(e) => {
                          const val = e.target.value;
                          setPurchaseLines((prev) => prev.map((item, i) => (i === index ? { ...item, retail: val } : item)));
                        }}
                      />
                    </Field>

                    {user.permissions.includes("VIEW_COST") && (
                      <Field label="سعر الجملة الداخلي">
                        <input
                          type="text"
                          placeholder="سعر الجملة (ج.م)"
                          value={line.wholesale}
                          required
                          onChange={(e) => {
                            const val = e.target.value;
                            setPurchaseLines((prev) => prev.map((item, i) => (i === index ? { ...item, wholesale: val } : item)));
                          }}
                        />
                      </Field>
                    )}

                    <Field label="رقم التشغيلة (اختياري)">
                      <input
                        type="text"
                        placeholder="LOT"
                        value={line.lot}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPurchaseLines((prev) =>
                            prev.map((item, i) => (i === index ? { ...item, lot: val } : item))
                          );
                        }}
                      />
                    </Field>

                    <Field label="تاريخ الصلاحية (اختياري)">
                      <input
                        type="date"
                        value={line.expires}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPurchaseLines((prev) =>
                            prev.map((item, i) => (i === index ? { ...item, expires: val } : item))
                          );
                        }}
                      />
                    </Field>

                    {purchaseLines.length > 1 && (
                      <button
                        type="button"
                        style={{ height: 42, marginBottom: 2, padding: "0 12px", color: "var(--danger)" }}
                        onClick={() =>
                          setPurchaseLines((prev) => prev.filter((_, i) => i !== index))
                        }
                        title="حذف هذا السطر"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="modal-actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={actionInProgress}
                >
                  {actionInProgress ? "جاري الحفظ والتسجيل..." : "تسجيل الفاتورة وتحديث المخزن"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewPurchaseModal(false)}
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function PartnersScreen({ storeName }: { storeName: string }): ReactNode {
  const [suppliers, setSuppliers] = useState<Partner[]>([]);
  const [customers, setCustomers] = useState<Partner[]>([]);
  const [message, setMessage] = useState("");
  const [section, setSection] = useState<
    "suppliers" | "customers" | "balances" | "statements"
  >("suppliers");
  const [query, setQuery] = useState("");
  const [balanceFilter, setBalanceFilter] = useState<
    "ALL" | "DUE" | "CREDIT" | "ZERO"
  >("ALL");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "SUPPLIER" | "CUSTOMER">(
    "ALL",
  );
  const [exporting, setExporting] = useState(false);
  const [supplierToSettle, setSupplierToSettle] = useState("");
  const [customerToCollect, setCustomerToCollect] = useState("");
  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      invoke<Partner[]>({ operation: "partners.suppliers.list" }),
      invoke<Partner[]>({ operation: "partners.customers.list" }),
    ]);
    setSuppliers(s);
    setCustomers(c);
  }, []);
  useEffect(() => {
    void load().catch((cause) => setMessage(errorMessage(cause)));
  }, [load]);
  useEffect(() => {
    if (supplierToSettle && !suppliers.some((item) => item.id === supplierToSettle)) setSupplierToSettle("");
  }, [suppliers, supplierToSettle]);
  useEffect(() => {
    if (customerToCollect && !customers.some((item) => item.id === customerToCollect)) setCustomerToCollect("");
  }, [customers, customerToCollect]);
  const normalizedQuery = query.trim().toLocaleLowerCase("ar-EG");
  const phoneQuery = query.replace(/\D/g, "");
  const matches = useCallback(
    (item: Partner) => {
      const nameMatches =
        !normalizedQuery ||
        item.name.toLocaleLowerCase("ar-EG").includes(normalizedQuery);
      const phoneMatches =
        phoneQuery.length > 0 &&
        (item.phone ?? "").replace(/\D/g, "").includes(phoneQuery);
      const balanceMatches =
        balanceFilter === "ALL" ||
        (balanceFilter === "DUE" && item.balance_minor > 0) ||
        (balanceFilter === "CREDIT" && item.balance_minor < 0) ||
        (balanceFilter === "ZERO" && item.balance_minor === 0);
      return (nameMatches || phoneMatches) && balanceMatches;
    },
    [normalizedQuery, phoneQuery, balanceFilter],
  );
  const filteredSuppliers = useMemo(
    () => suppliers.filter(matches),
    [suppliers, matches],
  );
  const filteredCustomers = useMemo(
    () => customers.filter(matches),
    [customers, matches],
  );
  const activeRows = useMemo(() => {
    const rows = [
      ...filteredSuppliers.map((item) => ({ type: "SUPPLIER" as const, item })),
      ...filteredCustomers.map((item) => ({ type: "CUSTOMER" as const, item })),
    ];
    return section === "suppliers"
      ? rows.filter((row) => row.type === "SUPPLIER")
      : section === "customers"
        ? rows.filter((row) => row.type === "CUSTOMER")
        : rows.filter((row) => typeFilter === "ALL" || row.type === typeFilter);
  }, [filteredSuppliers, filteredCustomers, section, typeFilter]);
  const filterLabel = `بحث: ${query.trim() || "الكل"} — الرصيد: ${balanceFilter === "ALL" ? "الكل" : balanceFilter === "DUE" ? "مستحق" : balanceFilter === "CREDIT" ? "دائن" : "صفر"}${section === "balances" ? ` — النوع: ${typeFilter === "ALL" ? "الكل" : typeFilter === "SUPPLIER" ? "مورد" : "عميل"}` : ""}`;
  async function createSupplier(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await invoke({
        operation: "partners.suppliers.create",
        payload: {
          name: String(data.get("name")),
          phone: String(data.get("phone") ?? "") || undefined,
          openingBalanceMinor: minorFromInput(
            String(data.get("opening") || "0"),
          ),
        },
      });
      form.reset();
      await load();
      setMessage("تم حفظ المورد.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function createCustomer(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await invoke({
        operation: "partners.customers.create",
        payload: {
          name: String(data.get("name")),
          phone: String(data.get("phone") ?? "") || undefined,
          creditLimitMinor: minorFromInput(String(data.get("limit") || "0")),
          openingBalanceMinor: minorFromInput(
            String(data.get("opening") || "0"),
          ),
        },
      });
      form.reset();
      await load();
      setMessage("تم حفظ العميل.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function settle(
    event: FormEvent<HTMLFormElement>,
    kind: "customer" | "supplier",
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      idempotencyKey,
      payment: {
        partnerId: String(data.get("partnerId")),
        amountMinor: minorFromInput(String(data.get("amount"))),
        note: String(data.get("note")),
      },
    };
    try {
      await invoke(
        kind === "customer"
          ? { operation: "partners.customer.collect", payload }
          : { operation: "partners.supplier.pay", payload },
      );
      form.reset();
      if (kind === "supplier") setSupplierToSettle("");
      else setCustomerToCollect("");
      await load();
      setMessage("تم تسجيل الحركة المالية في الدفتر.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function exportPdf(): Promise<void> {
    setExporting(true);
    try {
      const title =
        section === "suppliers"
          ? "دليل الموردين"
          : section === "customers"
            ? "دليل العملاء"
            : "دليل الموردين والعملاء";
      const report: PartnerListDocumentRequest = {
        storeName,
        title,
        filterLabel,
        generatedAt: new Date().toISOString(),
        items: activeRows.map((row) => ({
          type: row.type,
          name: row.item.name,
          phone: row.item.phone ?? null,
          balanceMinor: row.item.balance_minor,
          creditLimitMinor:
            row.type === "CUSTOMER" ? (row.item.credit_limit_minor ?? 0) : null,
        })),
      };
      const result = await invoke<{ cancelled: boolean; path?: string }>({
        operation: "partners.export-pdf",
        payload: report,
      });
      setMessage(
        result.cancelled
          ? "تم إلغاء حفظ PDF."
          : `تم حفظ القائمة في: ${result.path}`,
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  }
  const directory = (
    <section className="panel table-wrap operation-panel balances-panel partner-directory">
      <div className="panel-title-row">
        <div>
          <h2>
            {section === "suppliers"
              ? "دليل الموردين"
              : section === "customers"
                ? "دليل العملاء"
                : "نتائج الدليل والأرصدة"}
          </h2>
          <p className="hint">
            {activeRows.length} نتيجة مطابقة للبحث والفلاتر الحالية.
          </p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>النوع</th>
            <th>الاسم</th>
            <th>الهاتف</th>
            <th>الرصيد</th>
            <th>الحد</th>
          </tr>
        </thead>
        <tbody>
          {activeRows.map((row) => (
            <tr key={`${row.type}-${row.item.id}`}>
              <td>{row.type === "SUPPLIER" ? "مورد" : "عميل"}</td>
              <td>
                <b>{row.item.name}</b>
              </td>
              <td dir="ltr">{row.item.phone ?? "—"}</td>
              <td>{formatMoney(row.item.balance_minor)}</td>
              <td>
                {row.type === "CUSTOMER"
                  ? formatMoney(row.item.credit_limit_minor ?? 0)
                  : "—"}
              </td>
            </tr>
          ))}
          {activeRows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={5}>
                لا توجد نتائج مطابقة.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
  return (
    <>
      <PageHead
        title="الموردون والعملاء"
        subtitle="ابحث بالاسم أو الهاتف، وأدر الفواتير والمديونيات والسداد من كشف الحساب."
        action={
          <button
            className="primary"
            onClick={() => void exportPdf()}
            disabled={exporting}
          >
            {exporting ? "جارٍ التصدير…" : "تصدير PDF"}
          </button>
        }
      />
      <div className="subtabs" role="tablist" aria-label="إدارة العلاقات">
        {(
          [
            ["suppliers", "الموردون"],
            ["customers", "العملاء"],
            ["balances", "الأرصدة الحالية"],
            ["statements", "كشف الحساب والفواتير"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={section === id ? "selected" : ""}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {section !== "statements" && <section className="panel partner-filters">
        <Field label="بحث بالاسم أو رقم الهاتف">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="مثال: أحمد أو 010…"
            inputMode="search"
            autoComplete="off"
          />
        </Field>
        <Field label="حالة الرصيد">
          <select
            value={balanceFilter}
            onChange={(event) =>
              setBalanceFilter(event.target.value as typeof balanceFilter)
            }
          >
            <option value="ALL">كل الأرصدة</option>
            <option value="DUE">رصيد مستحق</option>
            <option value="CREDIT">رصيد دائن</option>
            <option value="ZERO">رصيد صفر</option>
          </select>
        </Field>
        {section === "balances" && (
          <Field label="نوع الطرف">
            <select
              value={typeFilter}
              onChange={(event) =>
                setTypeFilter(event.target.value as typeof typeFilter)
              }
            >
              <option value="ALL">مورد وعميل</option>
              <option value="SUPPLIER">مورد فقط</option>
              <option value="CUSTOMER">عميل فقط</option>
            </select>
          </Field>
        )}
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setBalanceFilter("ALL");
            setTypeFilter("ALL");
          }}
        >
          مسح الفلاتر
        </button>
      </section>}
      {message && (
        <div className="notice compact-notice" role="status">
          {message}
        </div>
      )}
      {section === "suppliers" && (
        <>
          <div className="operation-grid">
            <section className="panel operation-panel">
              <h2>إضافة مورد</h2>
              <p className="panel-help">
                أنشئ المورد مرة واحدة قبل تسجيل فواتير مشترياته.
              </p>
              <form
                className="form-grid"
                onSubmit={(event) => void createSupplier(event)}
              >
                <Field label="الاسم">
                  <input name="name" required />
                </Field>
                <Field label="الهاتف">
                  <input name="phone" inputMode="tel" />
                </Field>
                <Field label="مبلغ سابق علينا للمورد عند بدء البرنامج (اختياري)">
                  <input
                    name="opening"
                    defaultValue="0"
                    dir="ltr"
                    inputMode="decimal"
                  />
                </Field>
                <button className="primary">حفظ المورد</button>
              </form>
            </section>
            <section className="panel operation-panel">
              <h2>سداد مورد</h2>
              <p className="panel-help">
                يسجل السداد في دفتر المورد ولا يحذف أي حركة سابقة.
              </p>
              <form
                className="form-grid"
                onSubmit={(event) => void settle(event, "supplier")}
              >
                <Field label="المورد">
                  <SearchableSelect
                    name="partnerId"
                    value={supplierToSettle}
                    onChange={setSupplierToSettle}
                    options={suppliers.map((item) => ({
                      value: item.id,
                      label: `${item.name} — ${formatMoney(item.balance_minor)}`,
                      searchText: item.phone ?? "",
                    }))}
                    placeholder="ابحث باسم المورد أو هاتفه"
                    required
                  />
                </Field>
                <Field label="المبلغ">
                  <input name="amount" dir="ltr" inputMode="decimal" required />
                </Field>
                <Field label="السبب">
                  <input name="note" defaultValue="سداد مورد" required />
                </Field>
                <button>تسجيل السداد</button>
              </form>
            </section>
          </div>
          {directory}
        </>
      )}
      {section === "customers" && (
        <>
          <div className="operation-grid">
            <section className="panel operation-panel">
              <h2>إضافة عميل</h2>
              <p className="panel-help">
                حدد حد الائتمان إن كان البيع الآجل مسموحاً لهذا العميل.
              </p>
              <form
                className="form-grid"
                onSubmit={(event) => void createCustomer(event)}
              >
                <Field label="الاسم">
                  <input name="name" required />
                </Field>
                <Field label="الهاتف">
                  <input name="phone" inputMode="tel" />
                </Field>
                <Field label="حد الائتمان">
                  <input
                    name="limit"
                    defaultValue="0"
                    dir="ltr"
                    inputMode="decimal"
                  />
                </Field>
                <Field label="مبلغ سابق على العميل عند بدء البرنامج (اختياري)">
                  <input
                    name="opening"
                    defaultValue="0"
                    dir="ltr"
                    inputMode="decimal"
                  />
                </Field>
                <button className="primary full">حفظ العميل</button>
              </form>
            </section>
            <section className="panel operation-panel">
              <h2>تحصيل من عميل</h2>
              <p className="panel-help">
                يسجل التحصيل في دفتر العميل مع السبب المكتوب.
              </p>
              <form
                className="form-grid"
                onSubmit={(event) => void settle(event, "customer")}
              >
                <Field label="العميل">
                  <SearchableSelect
                    name="partnerId"
                    value={customerToCollect}
                    onChange={setCustomerToCollect}
                    options={customers.map((item) => ({
                      value: item.id,
                      label: `${item.name} — ${formatMoney(item.balance_minor)}`,
                      searchText: item.phone ?? "",
                    }))}
                    placeholder="ابحث باسم العميل أو هاتفه"
                    required
                  />
                </Field>
                <Field label="المبلغ">
                  <input name="amount" dir="ltr" inputMode="decimal" required />
                </Field>
                <Field label="السبب">
                  <input name="note" defaultValue="تحصيل عميل" required />
                </Field>
                <button>تسجيل التحصيل</button>
              </form>
            </section>
          </div>
          {directory}
        </>
      )}
      {section === "balances" && directory}
      {section === "statements" && <PartnerStatementPanel suppliers={suppliers} customers={customers} onChanged={load} />}
    </>
  );
}

interface PartnerDocument {
  id: string;
  partner_kind: "SUPPLIER" | "CUSTOMER";
  reference_no: string | null;
  goods_summary: string;
  goods_minor: number;
  fees_minor: number;
  total_minor: number;
  paid_minor: number;
  remaining_minor: number;
  status: "OPEN" | "PARTIAL" | "SETTLED";
  note: string | null;
  due_on: string | null;
  created_at: string;
  partner_name: string;
}

function PartnerStatementPanel({
  suppliers,
  customers,
  onChanged,
}: {
  suppliers: Partner[];
  customers: Partner[];
  onChanged: () => Promise<void>;
}): ReactNode {
  const [partnerKind, setPartnerKind] = useState<"SUPPLIER" | "CUSTOMER">(
    "SUPPLIER",
  );
  const [partnerId, setPartnerId] = useState("");
  const [documents, setDocuments] = useState<PartnerDocument[]>([]);
  const [selected, setSelected] = useState<PartnerDocument | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const partners = partnerKind === "SUPPLIER" ? suppliers : customers;

  const loadDocuments = useCallback(async () => {
    if (!partnerId) {
      setDocuments([]);
      return;
    }
    const response = await invoke<{ documents: PartnerDocument[] }>({
      operation: "partners.documents.list",
      payload: { partnerKind, partnerId },
    });
    setDocuments(response.documents);
    setSelected((current) =>
      current ? response.documents.find((document) => document.id === current.id) ?? null : null,
    );
  }, [partnerId, partnerKind]);

  useEffect(() => {
    void loadDocuments().catch((cause) => setMessage(errorMessage(cause)));
  }, [loadDocuments]);

  async function createDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!partnerId) {
      setMessage("اختر المورد أو العميل أولاً.");
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await invoke({
        operation: "partners.documents.create",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          document: {
            partnerKind,
            partnerId,
            referenceNo: String(data.get("referenceNo") ?? "").trim() || undefined,
            goodsSummary: String(data.get("goodsSummary") ?? "").trim(),
            goodsMinor: minorFromInput(String(data.get("goodsAmount") ?? "0")),
            feesMinor: minorFromInput(String(data.get("feesAmount") ?? "0")),
            note: String(data.get("note") ?? "").trim() || undefined,
            dueOn: String(data.get("dueOn") ?? "") || undefined,
          },
        },
      });
      form.reset();
      await Promise.all([loadDocuments(), onChanged()]);
      setMessage("تم حفظ الفاتورة في كشف الحساب ودفتر الطرف.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function payDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await invoke({
        operation: "partners.documents.pay",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          payment: {
            documentId: selected.id,
            amountMinor: minorFromInput(String(data.get("paymentAmount") ?? "0")),
            note: String(data.get("paymentNote") ?? "").trim(),
          },
        },
      });
      form.reset();
      await Promise.all([loadDocuments(), onChanged()]);
      setMessage("تم تسجيل السداد وربطه بالفاتورة المحددة.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const selectedPartner = partners.find((partner) => partner.id === partnerId);
  const statusLabel: Record<PartnerDocument["status"], string> = {
    OPEN: "مفتوحة",
    PARTIAL: "مسددة جزئياً",
    SETTLED: "مسددة بالكامل",
  };
  const totalRemaining = documents.reduce(
    (total, document) => total + document.remaining_minor,
    0,
  );

  return (
    <section className="partner-statements">
      <section className="panel statement-selector">
        <Field label="النوع">
          <select
            value={partnerKind}
            onChange={(event) => {
              setPartnerKind(event.target.value as "SUPPLIER" | "CUSTOMER");
              setPartnerId("");
              setSelected(null);
            }}
          >
            <option value="SUPPLIER">مورد — علينا له</option>
            <option value="CUSTOMER">عميل — عليه لنا</option>
          </select>
        </Field>
        <Field label={partnerKind === "SUPPLIER" ? "المورد" : "العميل"}>
          <SearchableSelect
            value={partnerId}
            onChange={(id) => {
              setPartnerId(id);
              setSelected(null);
            }}
            options={partners.map((partner) => ({
              value: partner.id,
              label: `${partner.name}${partner.phone ? ` — ${partner.phone}` : ""}`,
              searchText: partner.phone ?? "",
            }))}
            placeholder="اكتب اسم الطرف أو هاتفه"
            required
          />
        </Field>
        {selectedPartner && (
          <div className="statement-balance">
            <span>رصيد الدفتر الحالي</span>
            <strong>{formatMoney(selectedPartner.balance_minor)}</strong>
          </div>
        )}
      </section>

      {message && <div className="notice compact-notice" role="status">{message}</div>}
      {!partnerId ? (
        <section className="panel empty-state">أضف {partnerKind === "SUPPLIER" ? "مورداً" : "عميلاً"} أو عدّل البحث لاختيار طرف.</section>
      ) : (
        <div className="partner-statement-grid">
          <section className="panel operation-panel statement-create">
            <h2>إضافة فاتورة أو مديونية</h2>
            <p className="panel-help">سجّل البضاعة والرسوم في فاتورة مستقلة حتى يمكن سدادها جزئياً أو بالكامل لاحقاً.</p>
            <form className="form-grid" onSubmit={(event) => void createDocument(event)}>
              <Field label="رقم الفاتورة أو المرجع">
                <input name="referenceNo" maxLength={80} placeholder="اختياري" />
              </Field>
              <Field label="وصف مختصر للبضاعة">
                <input name="goodsSummary" required minLength={3} maxLength={500} placeholder="مثال: 12 كرتونة زيت و6 عبوات سكر" />
              </Field>
              <Field label="قيمة البضاعة">
                <input name="goodsAmount" defaultValue="0" dir="ltr" inputMode="decimal" required />
              </Field>
              <Field label="رسوم إضافية">
                <input name="feesAmount" defaultValue="0" dir="ltr" inputMode="decimal" />
              </Field>
              <Field label="تاريخ الاستحقاق">
                <input name="dueOn" type="date" />
              </Field>
              <Field label="ملاحظة">
                <input name="note" maxLength={250} placeholder="اختياري" />
              </Field>
              <button className="primary full" disabled={busy}>حفظ في كشف الحساب</button>
            </form>
          </section>

          <section className="panel table-wrap statement-documents">
            <div className="panel-title-row">
              <div>
                <h2>فواتير {selectedPartner?.name}</h2>
                <p className="panel-help">إجمالي المتبقي في الفواتير: <b>{formatMoney(totalRemaining)}</b></p>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>المرجع والتفاصيل</th>
                  <th>الإجمالي</th>
                  <th>المسدّد</th>
                  <th>المتبقي</th>
                  <th>الحالة</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <b>{document.reference_no || "بدون رقم"}</b>
                      <small>{document.goods_summary}{document.due_on ? ` — استحقاق ${document.due_on}` : ""}</small>
                    </td>
                    <td>{formatMoney(document.total_minor)}</td>
                    <td>{formatMoney(document.paid_minor)}</td>
                    <td><b>{formatMoney(document.remaining_minor)}</b></td>
                    <td><span className={`document-status ${document.status.toLowerCase()}`}>{statusLabel[document.status]}</span></td>
                    <td>
                      <button
                        type="button"
                        disabled={document.status === "SETTLED" || busy}
                        onClick={() => setSelected(document)}
                      >
                        {document.status === "SETTLED" ? "مكتملة" : "تسجيل سداد"}
                      </button>
                    </td>
                  </tr>
                ))}
                {!documents.length && (
                  <tr><td colSpan={6} className="empty-state">لا توجد فواتير مسجلة لهذا الطرف بعد.</td></tr>
                )}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {selected && (
        <section className="panel operation-panel document-payment">
          <div className="panel-title-row">
            <div>
              <h2>{partnerKind === "SUPPLIER" ? "سداد فاتورة مورد" : "تحصيل فاتورة عميل"}</h2>
              <p className="panel-help">{selected.reference_no || "فاتورة بدون رقم"} — المتبقي {formatMoney(selected.remaining_minor)}. لا يمكن تسجيل مبلغ أكبر من المتبقي.</p>
            </div>
            <button type="button" onClick={() => setSelected(null)}>إلغاء</button>
          </div>
          <form className="form-grid payment-form" onSubmit={(event) => void payDocument(event)}>
            <Field label="المبلغ المسدّد الآن">
              <input name="paymentAmount" defaultValue={(selected.remaining_minor / 100).toFixed(2)} max={(selected.remaining_minor / 100).toFixed(2)} dir="ltr" inputMode="decimal" required />
            </Field>
            <Field label="بيان السداد">
              <input name="paymentNote" defaultValue={partnerKind === "SUPPLIER" ? "سداد فاتورة مورد" : "تحصيل فاتورة عميل"} minLength={3} maxLength={250} required />
            </Field>
            <button className="primary" disabled={busy}>{partnerKind === "SUPPLIER" ? "تسجيل السداد" : "تسجيل التحصيل"}</button>
          </form>
        </section>
      )}
    </section>
  );
}

function cairoMonth(): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}`;
}

function ShiftScreen({
  shift,
  config,
  user,
  canExport,
  refresh,
}: {
  shift: Shift | null;
  config: Config;
  user: User;
  canExport: boolean;
  refresh: () => Promise<void>;
}): ReactNode {
  const [message, setMessage] = useState("");
  const [month, setMonth] = useState(cairoMonth);
  const [history, setHistory] = useState<ShiftHistoryItem[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  async function loadHistory(): Promise<void> {
    setHistoryBusy(true);
    try {
      const response = await invoke<{ items: ShiftHistoryItem[] }>({
        operation: "shifts.history",
        payload: { month },
      });
      setHistory(response.items);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setHistoryBusy(false);
    }
  }
  useEffect(() => { void loadHistory(); }, [month]);
  async function open(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!config.terminalId) return;
    const data = new FormData(event.currentTarget);
    try {
      await invoke({
        operation: "shifts.open",
        payload: {
          terminalId: config.terminalId,
          openingMinor: minorFromInput(String(data.get("opening"))),
        },
      });
      await Promise.all([refresh(), loadHistory()]);
      setMessage(`تم فتح وردية جديدة باسم ${user.displayName}.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function close(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!shift) return;
    const data = new FormData(event.currentTarget);
    try {
      await invoke({
        operation: "shifts.close",
        payload: {
          shiftId: shift.id,
          actualCashMinor: minorFromInput(String(data.get("actual"))),
          ...(String(data.get("note")).trim()
            ? { note: String(data.get("note")).trim() }
            : {}),
          ...(String(data.get("managerUsername"))
            ? {
                managerUsername: String(data.get("managerUsername")),
                managerPassword: String(data.get("managerPassword")),
              }
            : {}),
        },
      });
      await Promise.all([refresh(), loadHistory()]);
      setMessage("تم إغلاق الوردية وتسجيل تفاصيلها في السجل الشهري.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function exportHistory(): Promise<void> {
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; itemCount: number }>({
        operation: "shifts.export-xlsx",
        payload: { month },
      });
      setMessage(result.cancelled ? "تم إلغاء حفظ ملف Excel." : `تم حفظ سجل ${result.itemCount} وردية: ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  return (
    <>
      <PageHead
        title="الوردية"
        subtitle="سجّل فتح وإغلاق الدرج بدقة؛ كل وردية مرتبطة باسم الكاشير وتاريخها."
      />
      {message && <div className="notice">{message}</div>}
      <section className="panel shift-card">
        {shift ? (
          <>
            <span className="tag">مفتوحة باسم {user.displayName}</span>
            <p>النقدية المتوقعة</p>
            <strong>{formatMoney(shift.expectedCashMinor)}</strong>
            <small>بدأت {new Date(shift.openedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}</small>
            <form className="form-grid" onSubmit={(event) => void close(event)}>
              <Field label="العد الفعلي">
                <input name="actual" defaultValue={(shift.expectedCashMinor / 100).toFixed(2)} dir="ltr" required />
              </Field>
              <Field label="اسم المدير عند وجود فرق">
                <input name="managerUsername" />
              </Field>
              <Field label="كلمة مرور المدير">
                <input name="managerPassword" type="password" />
              </Field>
              <Field label="ملاحظة الإغلاق (اختياري)">
                <input name="note" maxLength={250} placeholder="مثال: تم تسليم الدرج للوردية التالية" />
              </Field>
              <button className="primary full">إغلاق الوردية وتسجيل الفرق</button>
            </form>
          </>
        ) : (
          <form className="login-form" onSubmit={(event) => void open(event)}>
            <h2>فتح وردية جديدة</h2>
            <p className="hint">ستُسجل هذه الوردية باسم المستخدم الحالي: <b>{user.displayName}</b>. لفتحها باسم كاشير آخر، سجّل الدخول بحسابه أولًا.</p>
            <Field label="الرصيد الافتتاحي">
              <input name="opening" defaultValue="0.00" dir="ltr" required />
            </Field>
            <button className="primary">فتح الوردية</button>
          </form>
        )}
      </section>
      <section className="panel table-wrap">
        <div className="product-search-toolbar">
          <label className="product-search-field">
            <span>الشهر</span>
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <div className="actions">
            <button type="button" onClick={() => void loadHistory()} disabled={historyBusy}>تحديث السجل</button>
            {canExport && <button type="button" className="primary" onClick={() => void exportHistory()} disabled={historyBusy}>تصدير Excel</button>}
          </div>
        </div>
        <table>
          <thead>
            <tr><th>الكاشير</th><th>الحالة</th><th>وقت الفتح</th><th>وقت الإغلاق</th><th>الافتتاحي</th><th>المتوقع</th><th>الفعلي</th><th>الفرق</th><th>الفواتير</th><th>إجمالي البيع</th><th>ملاحظة</th></tr>
          </thead>
          <tbody>
            {history.map((item) => (
              <tr key={item.id}>
                <td><b>{item.cashierName}</b><small>{item.terminalName}</small></td>
                <td><span className={`availability ${item.status === "OPEN" ? "available" : "empty"}`}>{item.status === "OPEN" ? "مفتوحة" : "مغلقة"}</span></td>
                <td>{new Date(item.openedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}</td>
                <td>{item.closedAt ? new Date(item.closedAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }) : "—"}</td>
                <td>{formatMoney(item.openingMinor)}</td><td>{formatMoney(item.expectedCashMinor)}</td>
                <td>{item.actualCashMinor === null ? "—" : formatMoney(item.actualCashMinor)}</td>
                <td>{item.differenceMinor === null ? "—" : formatMoney(item.differenceMinor)}</td>
                <td>{item.invoiceCount}</td><td>{formatMoney(item.salesTotalMinor)}</td><td>{item.closeNote ?? "—"}</td>
              </tr>
            ))}
            {!historyBusy && history.length === 0 && <tr><td colSpan={11} className="table-empty">لا توجد ورديات مسجلة في هذا الشهر.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ExpensesScreen({
  shift,
  refresh,
}: {
  shift: Shift | null;
  refresh: () => Promise<void>;
}): ReactNode {
  const [message, setMessage] = useState("");
  const [movementType, setMovementType] = useState<"CONSUMPTION" | "EXPENSE" | "DEPOSIT" | "WITHDRAWAL">("CONSUMPTION");
  const [month, setMonth] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(new Date()));
  const [consumptions, setConsumptions] = useState<ShopConsumption[]>([]);
  const [consumptionBusy, setConsumptionBusy] = useState(false);
  const movementLabel =
    movementType === "CONSUMPTION"
      ? "استهلاك المحل"
      : movementType === "EXPENSE"
      ? "مصروف"
      : movementType === "DEPOSIT"
        ? "إيداع في الدرج"
        : "سحب من الدرج";

  const consumptionPeriod = useMemo(() => {
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
  }, [month]);

  const loadConsumptions = useCallback(async (): Promise<void> => {
    setConsumptionBusy(true);
    try {
      const result = await invoke<{ items: ShopConsumption[] }>({ operation: "shop-consumptions.list", payload: consumptionPeriod });
      setConsumptions(result.items);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setConsumptionBusy(false);
    }
  }, [consumptionPeriod]);

  useEffect(() => { void loadConsumptions(); }, [loadConsumptions]);

  async function post(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!shift) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const isConsumption = movementType === "CONSUMPTION";
    const itemName = String(data.get("itemName") ?? "").trim();
    try {
      await invoke({
        operation: "shifts.cash-movement",
        payload: {
          shiftId: shift.id,
          movement: {
            type: isConsumption ? "EXPENSE" : movementType,
            amountMinor: minorFromInput(String(data.get("amount"))),
            reason: isConsumption ? `استهلاك المحل: ${itemName}` : String(data.get("reason")),
            ...(!isConsumption && movementType === "EXPENSE" ? { expenseCategory: String(data.get("expenseCategory") || "مصروفات تشغيل عامة") } : {}),
            ...(isConsumption ? {
              consumption: {
                itemName,
                category: String(data.get("category")),
                quantityNote: String(data.get("quantityNote") ?? "").trim() || undefined,
                supplierName: String(data.get("supplierName") ?? "").trim() || undefined,
                consumedOn: String(data.get("consumedOn")),
                note: String(data.get("note") ?? "").trim() || undefined,
              },
            } : {}),
          },
        },
      });
      form.reset();
      await refresh();
      if (isConsumption) await loadConsumptions();
      setMessage(
        isConsumption
          ? "تم تسجيل استهلاك المحل وخصم قيمته من الدرج. سيظهر ضمن مصروفات التقرير الشهري حسب التاريخ المختار."
          : movementType === "EXPENSE"
          ? "تم تسجيل المصروف وخصمه من النقدية المتوقعة ومن صافي الربح."
          : `تم تسجيل ${movementLabel} وتحديث رصيد الدرج المتوقع.`,
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  return (
    <>
      <PageHead
        title="المصروفات والدرج"
        subtitle="سجل مصروفات التشغيل واستهلاك المحل من الدرج، وستظهر تلقائيًا في التقارير الشهرية."
      />
      {message && <div className="notice">{message}</div>}
      <div className="subtabs" role="tablist" aria-label="حركة الدرج">
        {(
          [
            ["CONSUMPTION", "استهلاك المحل"],
            ["EXPENSE", "مصروف"],
            ["DEPOSIT", "إيداع"],
            ["WITHDRAWAL", "سحب"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={movementType === id}
            className={movementType === id ? "selected" : ""}
            onClick={() => setMovementType(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="panel operation-panel">
        <h2>{movementLabel}</h2>
        {shift ? (
          <>
            <p className="stock-balance">
              النقدية المتوقعة الآن:{" "}
              <strong>{formatMoney(shift.expectedCashMinor)}</strong>
            </p>
            <form className="form-grid" onSubmit={(event) => void post(event)}>
              {movementType === "CONSUMPTION" ? <>
                <Field label="ما الذي اشتراه المحل؟">
                  <input name="itemName" placeholder="مثال: أكياس تغليف أو منظف أرضيات" minLength={2} required />
                </Field>
                <Field label="تصنيف الاستهلاك">
                  <select name="category" defaultValue="مستلزمات تشغيل">
                    <option>مستلزمات تشغيل</option><option>نظافة</option><option>تغليف وأكياس</option><option>كهرباء ومياه</option><option>صيانة</option><option>ضيافة العاملين</option><option>نقل وتوصيل</option><option>أخرى</option>
                  </select>
                </Field>
                <Field label="الكمية أو الوصف">
                  <input name="quantityNote" placeholder="مثال: 3 عبوات أو كرتونة" />
                </Field>
                <Field label="المورد أو مكان الشراء (اختياري)">
                  <input name="supplierName" placeholder="مثال: مكتبة الشيماء" />
                </Field>
                <Field label="تاريخ الشراء للتقارير">
                  <input name="consumedOn" type="date" defaultValue={new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())} required />
                </Field>
                <Field label="المبلغ المسحوب من الدرج بالجنيه">
                  <input name="amount" inputMode="decimal" dir="ltr" required />
                </Field>
                <div className="full"><Field label="ملاحظات (اختياري)">
                  <input name="note" placeholder="رقم إيصال أو تفاصيل إضافية" />
                </Field></div>
                <p className="form-hint full">يسجل نبتة حركة خصم موثقة من الدرج الآن، ويستخدم تاريخ الشراء في التقارير الشهرية.</p>
              </> : <>
                {movementType === "EXPENSE" && <Field label="تصنيف المصروف"><select name="expenseCategory" defaultValue="مصروفات تشغيل عامة"><option>مصروفات تشغيل عامة</option><option>إيجار</option><option>كهرباء ومياه</option><option>إنترنت واتصالات</option><option>نقل وتوصيل</option><option>صيانة</option><option>تسويق</option><option>نظافة وتغليف</option><option>رسوم حكومية</option><option>أخرى</option></select></Field>}
                <Field label="السبب">
                  <input
                    name="reason"
                    placeholder={movementType === "EXPENSE" ? "مثال: إيجار شهر أكتوبر" : "سبب الحركة"}
                    minLength={3}
                    required
                  />
                </Field>
                <Field label="المبلغ بالجنيه">
                  <input name="amount" inputMode="decimal" dir="ltr" required />
                </Field>
              </>}
              <button className="primary full">تسجيل {movementLabel}</button>
            </form>
          </>
        ) : (
          <div className="empty-state">
            افتح وردية أولاً وحدد رصيد الدرج الافتتاحي قبل تسجيل أي حركة.
          </div>
        )}
      </section>
      <section className="panel table-panel">
        <div className="section-head">
          <div><h2>سجل استهلاك المحل</h2><p>تفاصيل المشتريات المسددة من الدرج خلال الشهر المختار.</p></div>
          <input aria-label="شهر استهلاك المحل" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </div>
        <div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>المشتريات</th><th>التصنيف</th><th>الكمية</th><th>المورد</th><th>المبلغ</th><th>سجل بواسطة</th></tr></thead>
          <tbody>{consumptions.map((item) => <tr key={item.id}><td dir="ltr">{item.consumedOn}</td><td><b>{item.itemName}</b>{item.note ? <small>{item.note}</small> : null}</td><td>{item.category}</td><td>{item.quantityNote ?? "—"}</td><td>{item.supplierName ?? "—"}</td><td>{formatMoney(item.amountMinor)}</td><td>{item.cashierName}</td></tr>)}
          {!consumptionBusy && consumptions.length === 0 ? <tr><td className="table-empty" colSpan={7}>لا يوجد استهلاك محل مسجل في هذا الشهر.</td></tr> : null}</tbody></table></div>
      </section>
    </>
  );
}

function SettingsScreen({
  onSettingsChange,
  onDataReset,
  terminalId,
  taxSettings = DEFAULT_TAX_SETTINGS,
  onTaxSettingsChange,
  currentUser,
  onUserUpdated,
}: {
  onSettingsChange: (settings: BranchSettings) => void;
  onDataReset: () => void;
  terminalId?: string | undefined;
  taxSettings?: TaxSettings;
  onTaxSettingsChange?: (settings: TaxSettings) => void;
  currentUser?: User | undefined;
  onUserUpdated?: ((user: User) => void) | undefined;
}): ReactNode {
  type SettingsTab = "store" | "devices" | "payments" | "cloudflare" | "orders" | "management";
  const [settings, setSettings] = useState<BranchSettings | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("store");
  const [taxEnabled, setTaxEnabled] = useState(taxSettings.enabled);
  const [taxRatePercent, setTaxRatePercent] = useState(taxSettings.ratePercent);
  const [pendingLogo, setPendingLogo] = useState<string | null>(null);
  const [hardware, setHardware] = useState<HardwareSettings>(DEFAULT_HARDWARE);
  const [printers, setPrinters] = useState<InstalledPrinter[]>([]);
  const [serialDevices, setSerialDevices] = useState<SerialDevice[]>([]);
  const [message, setMessage] = useState("");
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [customerOrders, setCustomerOrders] = useState<Array<{
    id: string; customerName: string; customerPhone: string; deliveryAddress: string; notes: string | null;
    source: "WEB" | "MESSENGER"; status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FULFILLED";
    subtotalMinor: number; deliveryFeeMinor: number; totalMinor: number; createdAt: string; statusNote: string | null;
    lines: Array<{ productId: string; nameAr: string; unitKind: "PIECE" | "WEIGHT"; saleUnit: "UNIT" | "PACKAGE" | "CARTON"; salePackageSize: number | null; qtyMilli: number; unitPriceMinor: number; lineTotalMinor: number }>;
  }>>([]);
  const [ordersBusy, setOrdersBusy] = useState(false);
  async function refreshCustomerOrders(): Promise<void> {
    setOrdersBusy(true);
    try { setCustomerOrders((await invoke<{ orders: typeof customerOrders }>({ operation: "commerce.orders.list" })).orders); }
    catch (cause) { setMessage(errorMessage(cause)); }
    finally { setOrdersBusy(false); }
  }
  async function printCustomerOrder(order: typeof customerOrders[number]): Promise<void> {
    if (!settings) throw new Error("تعذر تحديد اسم المتجر للطباعة.");
    await invoke({ operation: "hardware.delivery-order.print", payload: {
      storeName: settings.storeName,
      copies: 1,
      order: {
        id: order.id, source: order.source, customerName: order.customerName, customerPhone: order.customerPhone,
        deliveryAddress: order.deliveryAddress, notes: order.notes, createdAt: order.createdAt,
        subtotalMinor: order.subtotalMinor, deliveryFeeMinor: order.deliveryFeeMinor, totalMinor: order.totalMinor,
        lines: order.lines,
      },
    } });
  }
  async function updateCustomerOrder(orderId: string, status: "CONFIRMED" | "CANCELLED"): Promise<void> {
    setOrdersBusy(true);
    try { await invoke({ operation: "commerce.orders.update", payload: { orderId, status } }); await refreshCustomerOrders(); setMessage(status === "CANCELLED" ? "تم إلغاء الطلب وإتاحة الكمية المحجوزة." : "تم تأكيد الطلب. اطبع ورقة التجهيز ثم أصدر الفاتورة النهائية من نقطة البيع عند التسليم الفعلي."); }
    catch (cause) { setMessage(errorMessage(cause)); }
    finally { setOrdersBusy(false); }
  }
  async function confirmAndPrintCustomerOrder(order: typeof customerOrders[number]): Promise<void> {
    setOrdersBusy(true);
    try {
      await invoke({ operation: "commerce.orders.update", payload: { orderId: order.id, status: "CONFIRMED" } });
      await printCustomerOrder(order);
      await refreshCustomerOrders();
      setMessage("تم تأكيد الطلب وطباعة ورقة التجهيز. لم تُسجل فاتورة نهائية ولم يُخصم المخزون.");
    } catch (cause) {
      await refreshCustomerOrders();
      setMessage(`تم تأكيد الطلب، لكن ${errorMessage(cause)}. يمكنك إعادة طباعة ورقة التجهيز من زر الطباعة.`);
    } finally { setOrdersBusy(false); }
  }
  async function refreshDevices(): Promise<void> {
    try {
      const [nextHardware, nextPrinters, nextSerial] = await Promise.all([
        invoke<HardwareSettings>({ operation: "hardware.settings.get" }),
        invoke<InstalledPrinter[]>({ operation: "hardware.printers.list" }),
        invoke<SerialDevice[]>({ operation: "hardware.serial.list" }),
      ]);
      setHardware(nextHardware);
      setPrinters(nextPrinters);
      setSerialDevices(nextSerial);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  useEffect(() => {
    void invoke<BranchSettings>({ operation: "settings.branch.get" })
      .then(setSettings)
      .catch((cause) => setMessage(errorMessage(cause)));
    void refreshDevices();
  }, []);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings) return;
    const data = new FormData(event.currentTarget);
    try {
      const file = data.get("logoFile");
      let logoDataUrl =
        data.get("removeLogo") === "on" ? "" : settings.logoDataUrl;
      if (file instanceof File && file.size > 0)
        logoDataUrl = await readLogoDataUrl(file);
      const next = {
        ...settings,
        storeName: String(data.get("storeName") ?? "").trim(),
        creditSalesEnabled: data.get("credit") === "on",
        preventExpiredSales: data.get("expired") === "on",
        receiptPhone: String(data.get("receiptPhone") ?? "").trim(),
        whatsappPhone: String(data.get("whatsappPhone") ?? "").trim(),
        socialHandle: String(data.get("socialHandle") ?? "").trim(),
        receiptFooter: String(data.get("receiptFooter") ?? "").trim(),
        logoDataUrl,
      };
      await invoke({ operation: "settings.branch.update", payload: next });
      const ownerDisplayName = String(data.get("ownerDisplayName") ?? "").trim();
      if (currentUser && ownerDisplayName && ownerDisplayName !== currentUser.displayName) {
        await invoke({
          operation: "users.update",
          payload: {
            userId: currentUser.id,
            update: {
              displayName: ownerDisplayName,
              role: (currentUser.role as "CASHIER" | "MANAGER" | "OWNER" | "STOCK_KEEPER" | "EXPIRY_CLERK") || "OWNER",
              active: true,
              discountLimitBps: 10000,
            },
          },
        });
        onUserUpdated?.({ ...currentUser, displayName: ownerDisplayName });
      }
      setSettings(next);
      setPendingLogo(null);
      onSettingsChange(next);
      onTaxSettingsChange?.({
        enabled: taxEnabled,
        ratePercent: Number(taxRatePercent) || 0,
      });
      setMessage("تم حفظ هوية المتجر وتصميم الإيصال وإعدادات البيع والضريبة.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function saveHardware(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setDevicesBusy(true);
    const data = new FormData(event.currentTarget);
    const next: HardwareSettings = {
      scannerMode:
        String(data.get("scannerMode")) === "SERIAL" ? "SERIAL" : "HID",
      scannerTerminator:
        String(data.get("scannerTerminator")) === "TAB" ? "TAB" : "ENTER",
      duplicateGuardMs: Math.max(
        40,
        Math.min(1000, Number(data.get("duplicateGuardMs")) || 140),
      ),
      serialPortPath: String(data.get("serialPortPath") ?? "").trim(),
      serialBaudRate: Math.max(
        1200,
        Math.min(230400, Number(data.get("serialBaudRate")) || 9600),
      ),
      barcodePrinterName: String(data.get("barcodePrinterName") ?? "").trim(),
      labelPrintTransport: String(data.get("labelPrintTransport")) === "WINDOWS" ? "WINDOWS" : "TSPL",
      labelPrinterModel: "XP-233B",
      labelDpi: 203,
      labelWidthMm: boundedNumber(data.get("labelWidthMm"), 50, 20, 56),
      labelHeightMm: boundedNumber(data.get("labelHeightMm"), 20, 10, 150),
      labelGapMm: boundedNumber(data.get("labelGapMm"), 2, 0.5, 10),
      labelSpeedMmPerSecond: boundedNumber(data.get("labelSpeedMmPerSecond"), 50.8, 25.4, 127),
      labelDensity: Math.round(boundedNumber(data.get("labelDensity"), 8, 0, 15)),
      labelDirection: Number(data.get("labelDirection") ?? 1) === 0 ? 0 : 1,
      labelBarcodeRenderMode: data.get("labelBarcodeRenderMode") === "NATIVE_TSPL" ? "NATIVE_TSPL" : "RASTER",
      labelOffsetXmm: boundedNumber(data.get("labelOffsetXmm"), 0, -10, 10),
      labelOffsetYmm: boundedNumber(data.get("labelOffsetYmm"), 0, -10, 10),
      labelMediaType: "GAP",
      labelCalibrationConfirmed: data.get("labelCalibrationConfirmed") === "on",
      labelPaperSize: labelPaperSize(String(data.get("labelPaperSize") ?? "")),
      labelTemplate: labelTemplate(String(data.get("labelTemplate") ?? "")),
      receiptPrinterName: String(data.get("receiptPrinterName") ?? "").trim(),
      receiptPaperWidth:
        String(data.get("receiptPaperWidth")) === "58" ? "58" : "80",
      autoPrintReceipt: data.get("autoPrintReceipt") === "on",
      receiptCopies: Math.max(1, Math.min(5, Math.trunc(Number(data.get("receiptCopies")) || 1))),
      cashDrawerEnabled: data.get("cashDrawerEnabled") === "on",
      cashDrawerPin: String(data.get("cashDrawerPin")) === "5" ? "5" : "2",
    };
    try {
      const saved = await invoke<HardwareSettings>({
        operation: "hardware.settings.save",
        payload: next,
      });
      setHardware(saved);
      setMessage("تم حفظ إعدادات الأجهزة لهذا الكاشير.");
    } catch (cause) {
      setMessage(errorMessage(cause));
      try {
        setHardware(await invoke<HardwareSettings>({ operation: "hardware.settings.get" }));
      } catch {
        // Keep the last confirmed settings on screen if the local settings file cannot be read.
      }
    } finally {
      setDevicesBusy(false);
    }
  }
  async function printTest(): Promise<void> {
    setDevicesBusy(true);
    try {
      const result = await invoke<{ printerName: string }>({
        operation: "hardware.receipt.test",
      });
      setMessage(`تم إرسال إيصال الاختبار إلى ${result.printerName}.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setDevicesBusy(false);
    }
  }
  async function printLabelTest(): Promise<void> {
    setDevicesBusy(true);
    try {
      const result = await invoke<{ printerName: string; spoolJobId?: number }>({ operation: "hardware.label.test" });
      setMessage(`قبلت قائمة Windows ملصق الاختبار لطابعة ${result.printerName}${result.spoolJobId ? ` (مهمة رقم ${result.spoolJobId})` : ""}. هذا لا يثبت خروج الورق فعليًا؛ افحص الملصق ثم أكد المعايرة.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setDevicesBusy(false);
    }
  }
  async function calibrateLabelGap(): Promise<void> {
    setDevicesBusy(true);
    try {
      const result = await invoke<{ printerName: string; spoolJobId: number }>({ operation: "hardware.label.calibrate" });
      setMessage(`أُرسل أمر معايرة حساس Gap إلى ${result.printerName} (مهمة Windows رقم ${result.spoolJobId}). لا يحدد هذا الأمر عرض الملصق؛ اطبع ملصق اختبار بعده ثم أكد القياس عمليًا.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setDevicesBusy(false);
    }
  }
  async function restoreHardware(): Promise<void> {
    setDevicesBusy(true);
    try {
      const restored = await invoke<HardwareSettings>({ operation: "hardware.settings.restore" });
      setHardware(restored);
      setMessage("تمت استعادة إعدادات الأجهزة السابقة لهذا الكاشير.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setDevicesBusy(false);
    }
  }
  async function openDrawerTest(): Promise<void> {
    setDevicesBusy(true);
    try {
      const result = await invoke<{ printerName: string }>({ operation: "hardware.drawer.open" });
      setMessage(`تم إرسال أمر فتح الدرج عبر ${result.printerName}.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setDevicesBusy(false);
    }
  }
  async function installBundledDriver(role: "LABEL" | "RECEIPT"): Promise<void> {
    setDevicesBusy(true);
    try {
      await invoke<{ opened: true }>({ operation: "hardware.driver.install", payload: { role } });
      setMessage("فُتح مُثبّت تعريف Xprinter. أكمل خطواته في Windows ثم اضغط تحديث الأجهزة واحفظ اختيار الطابعة.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setDevicesBusy(false);
    }
  }
  return (
    <>
      <PageHead
        title="الإعدادات"
        subtitle="هوية المتجر، تصميم الإيصال، خيارات البيع وأجهزة هذا الكاشير."
      />
      {message && <div className="notice">{message}</div>}
      <nav className="settings-tabs" aria-label="أقسام الإعدادات" role="tablist">
        <button
          id="settings-tab-store"
          type="button"
          role="tab"
          aria-selected={activeTab === "store"}
          aria-controls="settings-panel-store"
          onClick={() => setActiveTab("store")}
        >
          المتجر والإيصال
        </button>
        <button
          id="settings-tab-devices"
          type="button"
          role="tab"
          aria-selected={activeTab === "devices"}
          aria-controls="settings-panel-devices"
          onClick={() => setActiveTab("devices")}
        >
          الأجهزة والطباعة
        </button>
        <button
          id="settings-tab-management"
          type="button"
          role="tab"
          aria-selected={activeTab === "management"}
          aria-controls="settings-panel-management"
          onClick={() => setActiveTab("management")}
        >
          الإدارة والبيانات
        </button>
        <button
          id="settings-tab-payments"
          type="button"
          role="tab"
          aria-selected={activeTab === "payments"}
          aria-controls="settings-panel-payments"
          onClick={() => setActiveTab("payments")}
        >
          المدفوعات والتكاملات
        </button>
        <button id="settings-tab-cloudflare" type="button" role="tab" aria-selected={activeTab === "cloudflare"} aria-controls="settings-panel-cloudflare" onClick={() => setActiveTab("cloudflare")}>
          تطبيق العملاء والاتصال
        </button>
        <button id="settings-tab-orders" type="button" role="tab" aria-selected={activeTab === "orders"} aria-controls="settings-panel-orders" onClick={() => { setActiveTab("orders"); void refreshCustomerOrders(); }}>
          طلبات العملاء
        </button>
      </nav>
      {activeTab === "store" && settings && (
        <section id="settings-panel-store" role="tabpanel" aria-labelledby="settings-tab-store" className="panel operation-panel">
          <h2>هوية المتجر والإيصال</h2>
          <form
            className="settings-form"
            onSubmit={(event) => void save(event)}
          >
            <div style={{ display: "grid", gridTemplateColumns: currentUser ? "1fr 1fr" : "1fr", gap: "14px", marginBottom: "14px" }}>
              <Field label="اسم السوبر ماركت / المتجر">
                <input
                  name="storeName"
                  defaultValue={settings.storeName}
                  minLength={2}
                  maxLength={160}
                  required
                />
              </Field>
              {currentUser && (
                <Field label="اسم المسؤول / المالك">
                  <input
                    name="ownerDisplayName"
                    defaultValue={currentUser.displayName}
                    maxLength={80}
                    placeholder="مثال: أحمد محمد / المدير العام"
                  />
                </Field>
              )}
            </div>
            <div className="receipt-branding-settings">
              <Field label="رقم الهاتف على الإيصال">
                <input name="receiptPhone" defaultValue={settings.receiptPhone} placeholder="01234567890" inputMode="tel" dir="ltr" />
              </Field>
              <Field label="رقم واتساب">
                <input name="whatsappPhone" defaultValue={settings.whatsappPhone} placeholder="01234567890" inputMode="tel" dir="ltr" />
              </Field>
              <Field label="حساب تواصل (اختياري)">
                <input name="socialHandle" defaultValue={settings.socialHandle} placeholder="@store_name" dir="ltr" />
              </Field>
              <Field label="رسالة أسفل الإيصال">
                <input name="receiptFooter" defaultValue={settings.receiptFooter} maxLength={180} />
              </Field>
              <div className="logo-upload">
                <span>شعار المتجر على الإيصال</span>
                {(pendingLogo ?? settings.logoDataUrl) ? <img src={pendingLogo ?? settings.logoDataUrl} alt="معاينة شعار المتجر" /> : <span className="logo-placeholder">شعارك</span>}
                <input name="logoFile" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) { setPendingLogo(null); return; } void readLogoDataUrl(file).then(setPendingLogo).catch((cause) => { event.currentTarget.value = ""; setMessage(errorMessage(cause)); }); }} />
                <label className="remove-logo"><input type="checkbox" name="removeLogo" onChange={(event) => { if (event.currentTarget.checked) setPendingLogo(""); }} /> إزالة الشعار الحالي</label>
                <small>PNG أو JPG أو WebP، بحد أقصى 550 كيلوبايت.</small>
              </div>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                name="credit"
                defaultChecked={settings.creditSalesEnabled}
              />
              <span>
                <b>تفعيل البيع الآجل</b>
                <small>يتطلب اختيار عميل، ويتحقق من حد ائتمانه.</small>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                name="expired"
                defaultChecked={settings.preventExpiredSales}
              />
              <span>
                <b>منع بيع الأصناف المنتهية</b>
                <small>يحمي البيع من تشغيلات منتهية الصلاحية.</small>
              </span>
            </label>
            <div className="tax-settings-card" style={{ marginTop: "1rem", marginBottom: "1rem", padding: "1rem", background: "var(--card-bg, #f8fafc)", borderRadius: "10px", border: "1px solid var(--border-color, #e2e8f0)" }}>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  name="taxEnabled"
                  checked={taxEnabled}
                  onChange={(e) => setTaxEnabled(e.target.checked)}
                />
                <span>
                  <b>تفعيل ضريبة القيمة المضافة (VAT)</b>
                  <small>إضافة سطر الضريبة في شاشة البيع وحسابها على الفاتورة (معطلة افتراضياً لمعظم محلات السوبرماركت).</small>
                </span>
              </label>

              {taxEnabled && (
                <div style={{ marginTop: "0.75rem", maxWidth: "240px" }}>
                  <Field label="نسبة الضريبة (%)">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={taxRatePercent}
                      onChange={(e) => setTaxRatePercent(Number(e.target.value) || 0)}
                      placeholder="14"
                      dir="ltr"
                    />
                  </Field>
                  <small style={{ color: "var(--text-muted, #64748b)", display: "block", marginTop: "4px" }}>
                    النسبة العامة في مصر 14% أو 15%، يمكنك تعديلها أو إيقافها حسب طبيعة النشاط.
                  </small>
                </div>
              )}
            </div>
            <button className="primary">حفظ هوية المتجر والإعدادات</button>
          </form>
        </section>
      )}
      {activeTab === "devices" && <section id="settings-panel-devices" role="tabpanel" aria-labelledby="settings-tab-devices" className="panel operation-panel device-panel">
        <div className="panel-title-row">
          <div>
            <h2>الطابعات والباركود</h2>
            <p className="hint">الإعدادات تحفظ لهذا الجهاز/الكاشير فقط.</p>
          </div>
          <button
            type="button"
            onClick={() => void refreshDevices()}
            disabled={devicesBusy}
          >
            تحديث الأجهزة
          </button>
        </div>
        <form
          className="settings-form device-settings-form"
          onSubmit={(event) => void saveHardware(event)}
        >
          <div className="device-section">
            <h3>قارئ الباركود</h3>
            <div className="two-columns">
              <Field label="طريقة الاتصال">
                <select
                  name="scannerMode"
                  value={hardware.scannerMode}
                  onChange={(event) =>
                    setHardware({
                      ...hardware,
                      scannerMode:
                        event.target.value === "SERIAL" ? "SERIAL" : "HID",
                    })
                  }
                >
                  <option value="HID">
                    USB أو Bluetooth بوضع لوحة المفاتيح
                  </option>
                  <option value="SERIAL">COM / Serial</option>
                </select>
              </Field>
              <Field label="نهاية القراءة">
                <select
                  name="scannerTerminator"
                  defaultValue={hardware.scannerTerminator}
                >
                  <option value="ENTER">Enter</option>
                  <option value="TAB">Tab</option>
                </select>
              </Field>
            </div>
            {hardware.scannerMode === "SERIAL" && (
              <div className="two-columns">
                <Field label="منفذ COM">
                  <SearchableSelect
                    name="serialPortPath"
                    value={hardware.serialPortPath}
                    onChange={(serialPortPath) => setHardware({ ...hardware, serialPortPath })}
                    options={serialDevices.map((device) => ({
                      value: device.path,
                      label: `${device.path}${device.manufacturer ? ` — ${device.manufacturer}` : ""}`,
                      searchText: `${device.serialNumber ?? ""} ${device.vendorId ?? ""} ${device.productId ?? ""}`,
                    }))}
                    placeholder="ابحث عن منفذ COM"
                  />
                </Field>
                <Field label="سرعة الاتصال">
                  <select
                    name="serialBaudRate"
                    defaultValue={String(hardware.serialBaudRate)}
                  >
                    {[9600, 19200, 38400, 57600, 115200].map((speed) => (
                      <option key={speed} value={speed}>
                        {speed}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <Field label="حماية تكرار المسحة (مللي ثانية)">
              <input
                name="duplicateGuardMs"
                defaultValue={hardware.duplicateGuardMs}
                type="number"
                min="40"
                max="1000"
                inputMode="numeric"
                dir="ltr"
              />
            </Field>
            <p className="hint">
              تلتقط نبتة EAN‑13 وEAN‑8 وUPC وCode 128 والباركود الداخلي كنص.
              الحماية تمنع الإشارة السريعة فقط؛ مسح الصنف نفسه بعد لحظة يزيد
              الكمية عمداً.
            </p>
          </div>
          <div className="device-section">
            <h3>معايرة طابعة الباركود — Xprinter XP-233B</h3>
            <div className="two-columns">
              <Field label="طابعة الملصقات في Windows">
                <SearchableSelect
                  name="barcodePrinterName"
                  value={hardware.barcodePrinterName}
                  onChange={(barcodePrinterName) => setHardware({ ...hardware, barcodePrinterName })}
                  options={printers.map((printer) => ({
                    value: printer.name,
                    label: `${printer.displayName || printer.name}${printer.isDefault ? " (الافتراضية)" : ""}`,
                    searchText: `${printer.name} ${printer.description}`,
                  }))}
                  placeholder="Xprinter XP-233B"
                  emptyText="لا توجد طابعات مثبتة في Windows."
                />
              </Field>
              <Field label="مسار طباعة الملصق">
                <select name="labelPrintTransport" value={hardware.labelPrintTransport} onChange={(event) => setHardware({ ...hardware, labelPrintTransport: event.target.value === "WINDOWS" ? "WINDOWS" : "TSPL" })}>
                  <option value="TSPL">TSPL RAW — موصى به لـ XP-233B</option>
                  <option value="WINDOWS">Windows / تعريف الطابعة — توافق فقط</option>
                </select>
              </Field>
            </div>
            <div className="three-columns">
              <Field label="عرض الاستيكر (مم)"><input name="labelWidthMm" type="number" min="20" max="56" step="0.1" value={hardware.labelWidthMm} onChange={(event) => setHardware({ ...hardware, labelWidthMm: boundedNumber(event.target.value, 50, 20, 56), labelCalibrationConfirmed: false })} dir="ltr" /></Field>
              <Field label="ارتفاع الاستيكر (مم)"><input name="labelHeightMm" type="number" min="10" max="150" step="0.1" value={hardware.labelHeightMm} onChange={(event) => setHardware({ ...hardware, labelHeightMm: boundedNumber(event.target.value, 20, 10, 150), labelCalibrationConfirmed: false })} dir="ltr" /></Field>
              <Field label="الفاصل Gap (مم)"><input name="labelGapMm" type="number" min="0.5" max="10" step="0.1" value={hardware.labelGapMm} onChange={(event) => setHardware({ ...hardware, labelGapMm: boundedNumber(event.target.value, 2, 0.5, 10), labelCalibrationConfirmed: false })} dir="ltr" /></Field>
            </div>
            <div className="three-columns">
              <Field label="السرعة (مم/ث)"><input name="labelSpeedMmPerSecond" type="number" min="25.4" max="127" step="0.1" value={hardware.labelSpeedMmPerSecond} onChange={(event) => setHardware({ ...hardware, labelSpeedMmPerSecond: boundedNumber(event.target.value, 50.8, 25.4, 127) })} dir="ltr" /></Field>
              <Field label="الكثافة 0–15"><input name="labelDensity" type="number" min="0" max="15" step="1" value={hardware.labelDensity} onChange={(event) => setHardware({ ...hardware, labelDensity: Math.round(boundedNumber(event.target.value, 8, 0, 15)) })} dir="ltr" /></Field>
              <Field label="المستشعر"><input value="Gap — 203 DPI" readOnly dir="ltr" /></Field>
            </div>
            <div className="two-columns">
              <Field label="اتجاه الطباعة">
                <select name="labelDirection" value={hardware.labelDirection ?? 1} onChange={(event) => setHardware({ ...hardware, labelDirection: Number(event.target.value) as 0 | 1 })}>
                  <option value={1}>طبيعي (DIRECTION 1,0)</option>
                  <option value={0}>معكوس 180° (DIRECTION 0,0)</option>
                </select>
              </Field>
              <Field label="محرك رسم الباركود">
                <select name="labelBarcodeRenderMode" value={hardware.labelBarcodeRenderMode ?? "RASTER"} onChange={(event) => setHardware({ ...hardware, labelBarcodeRenderMode: event.target.value === "NATIVE_TSPL" ? "NATIVE_TSPL" : "RASTER" })}>
                  <option value="RASTER">محرك نقطي موحد (Test B — موصى به ومطابق للمعاينة)</option>
                  <option value="NATIVE_TSPL">باركود TSPL الداخلي (Test A — خطوط الطابعة المدمجة)</option>
                </select>
              </Field>
            </div>
            <div className="two-columns">
              <Field label="إزاحة أفقية X (مم)"><input name="labelOffsetXmm" type="number" min="-10" max="10" step="0.1" value={hardware.labelOffsetXmm} onChange={(event) => setHardware({ ...hardware, labelOffsetXmm: boundedNumber(event.target.value, 0, -10, 10), labelCalibrationConfirmed: false })} dir="ltr" /></Field>
              <Field label="إزاحة رأسية Y (مم)"><input name="labelOffsetYmm" type="number" min="-10" max="10" step="0.1" value={hardware.labelOffsetYmm} onChange={(event) => setHardware({ ...hardware, labelOffsetYmm: boundedNumber(event.target.value, 0, -10, 10), labelCalibrationConfirmed: false })} dir="ltr" /></Field>
            </div>
            {hardware.labelPrintTransport === "WINDOWS" && <div className="two-columns"><Field label="مقاس تعريف Windows"><select name="labelPaperSize" value={hardware.labelPaperSize} onChange={(event) => setHardware({ ...hardware, labelPaperSize: labelPaperSize(event.target.value) })}>{LABEL_PAPER_SIZES.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}</select></Field><Field label="تصميم المسار البديل"><select name="labelTemplate" value={hardware.labelTemplate} onChange={(event) => setHardware({ ...hardware, labelTemplate: labelTemplate(event.target.value) })}>{LABEL_TEMPLATES.filter((template) => template.value !== "MICRO").map((template) => <option key={template.value} value={template.value}>{template.label}</option>)}</select></Field></div>}
            <div className="label-layout-settings">
              <div className="label-preview label-preview-standard" style={{ aspectRatio: `${hardware.labelWidthMm} / ${hardware.labelHeightMm}` }}>
                <b className="label-preview-brand">نبتة</b><span className="label-preview-rule" /><span className="label-preview-bars" aria-label="باركود تجريبي" /><em>6221234567891</em><div className="label-preview-details"><strong>منتج عربي طويل Mixed English</strong><span>١٢٫٥٠ ج.م</span></div>
              </div>
            </div>
            <label className="toggle-row"><input type="checkbox" name="labelCalibrationConfirmed" checked={hardware.labelCalibrationConfirmed} onChange={(event) => setHardware({ ...hardware, labelCalibrationConfirmed: event.currentTarget.checked })} /><span><b>تم قياس ملصق اختبار فعليًا</b><small>لن يسمح نبتة بطباعة أكثر من نسخة أو دفعة حتى تؤكد أن الباركود والسعر والمحاذاة سليمة.</small></span></label>
            <p className="hint">القيم 50 × 20 مم وGap 2 مم قيم بداية تقديرية. أمر معايرة Gap يضبط موضع الفواصل ولا يكتشف عرض الملصق؛ لا تؤكد المعايرة إلا بعد اختبار المقاس بمسطرة وقارئ باركود فعلي.</p>
            <button type="button" onClick={() => void calibrateLabelGap()} disabled={devicesBusy || !hardware.barcodePrinterName || hardware.labelPrintTransport !== "TSPL"}>معايرة حساس Gap</button>
            <button type="button" onClick={() => void printLabelTest()} disabled={devicesBusy || !hardware.barcodePrinterName}>طباعة ملصق اختبار</button>
            <button type="button" onClick={() => void restoreHardware()} disabled={devicesBusy}>استعادة الإعدادات السابقة</button>
            <button type="button" onClick={() => void installBundledDriver("LABEL")} disabled={devicesBusy}>تشغيل تعريف XP-233B المضمّن</button>
          </div>
          <div className="device-section">
            <h3>طابعة الإيصالات الحرارية</h3>
            <div className="two-columns">
              <Field label="طابعة الإيصالات — Xprinter XP-Q808K USB">
                <SearchableSelect
                  name="receiptPrinterName"
                  value={hardware.receiptPrinterName}
                  onChange={(receiptPrinterName) => setHardware({ ...hardware, receiptPrinterName })}
                  options={printers.map((printer) => ({
                    value: printer.name,
                    label: `${printer.displayName || printer.name}${printer.isDefault ? " (الافتراضية)" : ""}`,
                    searchText: `${printer.name} ${printer.description}`,
                  }))}
                  placeholder="ابحث عن طابعة Windows"
                  emptyText="لا توجد طابعات مثبتة في Windows."
                />
              </Field>
              <Field label="مقاس رول الإيصال">
                <select
                  name="receiptPaperWidth"
                  defaultValue={hardware.receiptPaperWidth}
                >
                  <option value="80">80 مم — المقاس الموصى به لـ XP-Q808K (عرض طباعة 72 مم)</option>
                  <option value="58">58 مم — فقط عند تركيب رول 58 مم وتعريفه في Windows</option>
                </select>
              </Field>
            </div>
            <p className="hint">فواتير 80 مم تُنسّق داخل مساحة طباعة آمنة 72 مم، مع خطوط فاصلة وملخص إجمالي واضح، لتفادي قصّ الكلام من الجانبين.</p>
            <p className="hint">إذا ظهر اسم XP-80 أو POS-80 في Windows فهو غالباً تعريف عام لطابعة الإيصالات 80 مم؛ اختَره هنا ثم اطبع اختباراً. يمكن تشغيل التعريف الرسمي المضمّن عند إعداد جهاز جديد.</p>
            <Field label="عدد نسخ إيصال العميل بعد إتمام الدفع">
              <input
                name="receiptCopies"
                type="number"
                min="1"
                max="5"
                step="1"
                value={hardware.receiptCopies}
                onChange={(event) => setHardware({ ...hardware, receiptCopies: Math.max(1, Math.min(5, Math.trunc(Number(event.target.value) || 1))) })}
                dir="ltr"
              />
            </Field>
            <p className="hint">يُطبّق هذا العدد عند تفعيل الطباعة التلقائية بعد البيع. الطباعة اليدوية وإعادة الطباعة تبقيان نسخة واحدة لمنع التكرار غير المقصود.</p>
            <label className="toggle-row">
              <input
                type="checkbox"
                name="autoPrintReceipt"
                checked={hardware.autoPrintReceipt}
                onChange={(event) =>
                  setHardware({
                    ...hardware,
                    autoPrintReceipt: event.currentTarget.checked,
                  })
                }
              />
              <span>
                <b>طباعة الإيصال تلقائياً بعد البيع</b>
                <small>
                  ترسل الفاتورة مباشرة إلى الطابعة المختارة من دون نافذة تأكيد.
                </small>
              </span>
            </label>
            <div className="two-columns">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  name="cashDrawerEnabled"
                  checked={hardware.cashDrawerEnabled}
                  onChange={(event) =>
                    setHardware({
                      ...hardware,
                      cashDrawerEnabled: event.currentTarget.checked,
                    })
                  }
                />
                <span>
                  <b>فتح الدرج تلقائياً بعد طباعة الإيصال</b>
                  <small>الدرج متصل بمنفذ RJ11 في طابعة الإيصالات، وليس جهاز USB مستقلاً.</small>
                </span>
              </label>
              <Field label="نبضة فتح الدرج">
                <select name="cashDrawerPin" defaultValue={hardware.cashDrawerPin}>
                  <option value="2">Pin 2 — الافتراضي</option>
                  <option value="5">Pin 5 — إذا لم يعمل الاختبار</option>
                </select>
              </Field>
            </div>
            <p className="hint">احفظ الإعدادات أولاً، ثم استخدم اختبار فتح الدرج. لا تغيّر النبضة إلى 5 إلا إذا لم يفتح الدرج على 2.</p>
            <button type="button" onClick={() => void installBundledDriver("RECEIPT")} disabled={devicesBusy}>
              تشغيل تعريف طابعة الإيصالات المضمّن
            </button>
            <p className="hint">
              هذه الطابعة مخصصة للإيصالات فقط. يمنع النظام حفظها نفسها كطابعة ملصقات لتفادي خلط ورق الباركود مع الفواتير.
            </p>
            <p className="hint">
              محرك Windows Printer Driver هو الافتراضي ويحافظ على العربية
              للطابعات المثبتة. ESC/POS الخام يختلف حسب موديل واتصال وترميز
              الطابعة، لذلك لا يُفعّل كادعاء عام قبل اختبار موديلك.
            </p>
          </div>
          <div className="modal-actions">
            <button className="primary" disabled={devicesBusy}>
              {devicesBusy ? "جارٍ الحفظ…" : "حفظ إعدادات الأجهزة"}
            </button>
            <button
              type="button"
              onClick={() => void printTest()}
              disabled={devicesBusy || !hardware.receiptPrinterName}
            >
              طباعة اختبار
            </button>
            <button
              type="button"
              onClick={() => void openDrawerTest()}
              disabled={devicesBusy || !hardware.receiptPrinterName}
            >
              اختبار فتح الدرج
            </button>
          </div>
        </form>
      </section>}
      {activeTab === "management" && <div id="settings-panel-management" role="tabpanel" aria-labelledby="settings-tab-management">
        <ManagementPanel onDataReset={onDataReset} currentUser={currentUser} onUserUpdated={onUserUpdated} />
      </div>}
      {activeTab === "payments" && <div id="settings-panel-payments" role="tabpanel" aria-labelledby="settings-tab-payments">
        <PaymentIntegrationPanel currentUser={currentUser} terminalId={terminalId} />
      </div>}
      {activeTab === "cloudflare" && <div id="settings-panel-cloudflare" role="tabpanel" aria-labelledby="settings-tab-cloudflare">
        <CloudflareConnectionPanel currentUser={currentUser} />
      </div>}
      {activeTab === "orders" && <section id="settings-panel-orders" role="tabpanel" aria-labelledby="settings-tab-orders" className="panel operation-panel">
        <div className="panel-title-row"><div><h2>طلبات العملاء أونلاين وماسنجر</h2><p className="hint">كل طلب يُحجز أولًا فقط. بعد مكالمتك للعميل اضغط «تأكيد وطباعة التجهيز»؛ الورقة تشمل الاسم والهاتف والعنوان والأصناف ورسوم التوصيل 20 ج.م، لكنها ليست فاتورة نهائية ولا تخصم المخزون.</p></div><button type="button" onClick={() => void refreshCustomerOrders()} disabled={ordersBusy}>تحديث</button></div>
        <div className="table-wrap"><table><thead><tr><th>المصدر والعميل</th><th>العنوان والتفاصيل</th><th>الإجمالي</th><th>الحالة</th><th>وقت الإرسال</th><th>إجراء</th></tr></thead><tbody>
          {customerOrders.map((order) => <tr key={order.id}><td><small>{order.source === "MESSENGER" ? "ماسنجر" : "المتجر الإلكتروني"}</small><br /><b>{order.customerName}</b><br /><small dir="ltr">{order.customerPhone}</small></td><td>{order.deliveryAddress}{order.notes ? <><br /><small>{order.notes}</small></> : null}<br /><small>{order.lines.length} أصناف</small></td><td><b>{formatMoney(order.totalMinor)}</b><br /><small>أصناف {formatMoney(order.subtotalMinor)} + توصيل {formatMoney(order.deliveryFeeMinor)}</small></td><td>{order.status === "PENDING" ? "بانتظار المراجعة" : order.status === "CONFIRMED" ? "مؤكد ومحجوز" : order.status === "FULFILLED" ? "تم التسليم" : "ملغي"}</td><td>{new Date(order.createdAt).toLocaleString("ar-EG")}</td><td><div className="table-actions">{order.status === "PENDING" && <><button type="button" className="primary" onClick={() => void confirmAndPrintCustomerOrder(order)} disabled={ordersBusy}>تأكيد وطباعة التجهيز</button><button type="button" className="danger" onClick={() => void updateCustomerOrder(order.id, "CANCELLED")} disabled={ordersBusy}>إلغاء</button></>}{order.status === "CONFIRMED" && <><button type="button" onClick={() => void printCustomerOrder(order)} disabled={ordersBusy}>إعادة طباعة التجهيز</button><small>أصدر الفاتورة النهائية من نقطة البيع عند التسليم، ثم سجل التحصيل الفعلي.</small></>}</div></td></tr>)}
          {!customerOrders.length && <tr><td colSpan={6} className="empty">لا توجد طلبات عملاء حتى الآن.</td></tr>}
        </tbody></table></div>
      </section>}
    </>
  );
}

interface PaymentSettingsView {
  provider: "KASHIER" | "FAWRY";
  canEditLive: boolean;
  environments: Array<{
    environment: "TEST" | "LIVE";
    merchantId: string | null;
    webhookUrl: string;
    merchantRedirectUrl: string;
    relayUrl: string;
    receiptPrintEnabled: boolean;
    requestTimeoutMs: number;
    retryLimit: number;
    enabledMethods: unknown[];
    configured: boolean;
  }>;
  devices: Array<{ terminalId: string; serialNo: string; active: boolean }>;
}

const kashierEnabledMethodOptions = [
  ["KASHIER_POS_CARD", "ماكينة Kashier POS — بطاقة وNFC"],
  ["MOBILE_WALLET", "محفظة إلكترونية"],
  ["INSTAPAY_QR", "InstaPay — رمز QR"],
  ["INSTAPAY_R2P", "InstaPay — طلب دفع"],
] as const;

function hasScannerNumericBarcode(barcodes: string[]): boolean {
  return barcodes.some((barcode) => /^\d{8,14}$/.test(barcode));
}

function cartonContentLabel(kind: ReceiptLineDraft["cartonContent"]): string {
  if (kind === "PACK") return "عبوة";
  if (kind === "BAG") return "كيس";
  return "قطعة";
}

function PaymentIntegrationPanel({ currentUser, terminalId }: { currentUser?: User | undefined; terminalId?: string | undefined }): ReactNode {
  const [settings, setSettings] = useState<PaymentSettingsView | null>(null);
  const [provider, setProvider] = useState<"KASHIER" | "FAWRY">("KASHIER");
  const [environment, setEnvironment] = useState<"TEST" | "LIVE">("TEST");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = settings?.environments.find((item) => item.environment === environment);
  const refresh = async (): Promise<void> => {
    try { setSettings(await invoke<PaymentSettingsView>({ operation: "payments.settings.get", payload: { provider } })); }
    catch (cause) { setMessage(errorMessage(cause)); }
  };
  useEffect(() => { void refresh(); }, [provider]);
  const isKashier = provider === "KASHIER";
  const providerName = isKashier ? "Kashier" : "فوري";
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await invoke({ operation: "payments.settings.update", payload: {
        provider,
        environment,
        activateEnvironment: true,
        merchantId: String(data.get("merchantId") ?? "").trim(),
        ...(String(data.get("secretKey") ?? "").trim() ? { secretKey: String(data.get("secretKey")).trim() } : {}),
        ...(String(data.get("apiKey") ?? "").trim() ? { apiKey: String(data.get("apiKey")).trim() } : {}),
        ...(String(data.get("paymentApiKey") ?? "").trim() ? { paymentApiKey: String(data.get("paymentApiKey")).trim() } : {}),
        ...(String(data.get("secureHashKey") ?? "").trim() ? { secureHashKey: String(data.get("secureHashKey")).trim() } : {}),
        ...(String(data.get("relayToken") ?? "").trim() ? { relayToken: String(data.get("relayToken")).trim() } : {}),
        webhookUrl: String(data.get("webhookUrl") ?? "").trim(),
        merchantRedirectUrl: String(data.get("merchantRedirectUrl") ?? "").trim(),
        relayUrl: String(data.get("relayUrl") ?? "").trim(),
        receiptPrintEnabled: data.get("receiptPrintEnabled") === "on",
        requestTimeoutMs: Number(data.get("requestTimeoutMs")) || 30000,
        retryLimit: Number(data.get("retryLimit")) || 0,
        enabledMethods: Array.from(data.getAll("enabledMethods")).map(String) as Array<"KASHIER_POS_CARD" | "FAWRY_REFERENCE" | "ONLINE_CARD" | "MOBILE_WALLET" | "PAYMENT_LINK" | "INSTAPAY_QR" | "INSTAPAY_R2P" | "BANK_INSTALLMENTS" | "BNPL" | "MEEZA_CARD">,
        confirmationPassword: String(data.get("confirmationPassword") ?? ""),
      } });
      setMessage(`تم حفظ إعدادات ${providerName} المشفرة. لا تُعرض المفاتيح المحفوظة مرة أخرى.`);
      await refresh();
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function bindDevice(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await invoke({ operation: "payments.devices.bind", payload: { provider, terminalId: String(data.get("terminalId") ?? "").trim(), serialNo: String(data.get("serialNo") ?? "").trim(), isDefault: true, active: data.get("active") === "on" } });
      setMessage(`تم حفظ بيانات ماكينة ${providerName} لنقطة البيع.`);
      await refresh();
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function testConnection(): Promise<void> {
    setBusy(true);
    try {
      await invoke({ operation: "payments.methods.refresh", payload: { provider } });
      setMessage(isKashier ? "تم الاتصال بـ Kashier واسترجاع وسائل الدفع المتاحة للحساب." : "إعداد فوري مكتمل محليًا ويمكن إنشاء رقم مرجعي عند إدخال بيانات التاجر.");
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function reconcile(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ candidates: number; reconciled: number }>({ operation: "payments.reconcile", payload: { provider } });
      setMessage(`اكتملت المراجعة: ${result.reconciled} من ${result.candidates} طلب دفع.`);
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <section className="panel operation-panel" dir="rtl">
    <h2>المدفوعات والتكاملات</h2>
    <p className="hint">مفاتيح الدفع تحفظ مشفرة في الخادم المحلي ولا تُعرض بعد الحفظ. اجعل Kashier POS هو الخيار الرئيسي للبطاقة وNFC؛ فوري يبقى خيار رقم مرجعي منفصل.</p>
    {message && <div className="notice">{message}</div>}
    <div className="payment-tabs" role="tablist" aria-label="مزود الدفع">
      <button type="button" role="tab" aria-selected={isKashier} className={isKashier ? "selected" : ""} onClick={() => setProvider("KASHIER")} disabled={busy}>Kashier POS — بطاقة وNFC</button>
      <button type="button" role="tab" aria-selected={!isKashier} className={!isKashier ? "selected" : ""} onClick={() => setProvider("FAWRY")} disabled={busy}>فوري — رقم مرجعي</button>
    </div>
    <div className="payment-tabs" role="tablist" aria-label={`بيئة ${providerName}`}>
      {(["TEST", "LIVE"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={environment === value} className={environment === value ? "selected" : ""} onClick={() => setEnvironment(value)} disabled={busy || (value === "LIVE" && !settings?.canEditLive)}>{value === "TEST" ? "وضع الاختبار" : "الوضع الفعلي"}</button>)}
    </div>
    <p className="hint">الحالة: {selected?.configured ? (isKashier ? "مُعدّ ويمكن اختبار ماكينة Kashier" : "مُعدّ ويمكن اختبار إنشـاء رقم فوري المرجعي") : (isKashier ? "يحتاج Merchant ID ومفاتيح Kashier ومفتاح تشفير الخادم" : "يحتاج Merchant Code وSecure Hash Key من فوري ومفتاح تشفير الخادم")}</p>
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <div className="two-columns">
        <Field label={isKashier ? "Kashier Merchant ID" : "Fawry Merchant Code"}><input name="merchantId" required defaultValue={selected?.merchantId ?? ""} dir="ltr" /></Field>
        <Field label="مهلة الاتصال (مللي ثانية)"><input name="requestTimeoutMs" type="number" min="3000" max="60000" defaultValue={selected?.requestTimeoutMs ?? 30000} dir="ltr" /></Field>
        {isKashier ? <>
          <Field label="Kashier Secret Key"><input name="secretKey" type="password" autoComplete="new-password" placeholder="اتركه فارغًا للإبقاء على القيمة الحالية" dir="ltr" /></Field>
          <Field label="Kashier API Key"><input name="apiKey" type="password" autoComplete="new-password" placeholder="اتركه فارغًا للإبقاء على القيمة الحالية" dir="ltr" /></Field>
          <Field label="Kashier Payment API Key"><input name="paymentApiKey" type="password" autoComplete="new-password" placeholder="اتركه فارغًا للإبقاء على القيمة الحالية" dir="ltr" /></Field>
        </> : <Field label="Fawry Secure Hash Key"><input name="secureHashKey" type="password" autoComplete="new-password" placeholder="اتركه فارغًا للإبقاء على القيمة الحالية" dir="ltr" /></Field>}
        <Field label="عدد المحاولات الآمنة"><input name="retryLimit" type="number" min="0" max="3" defaultValue={selected?.retryLimit ?? 0} dir="ltr" /></Field>
        <Field label={`${providerName} Webhook URL`}><input name="webhookUrl" type="url" defaultValue={selected?.webhookUrl ?? ""} placeholder={isKashier ? "https://your-domain/v1/payments/webhooks/kashier/LIVE" : "https://your-domain/v1/payments/webhooks/fawry/LIVE"} dir="ltr" /><small className="hint">ضع رابطًا عامًا HTTPS فقط عند تجهيز Cloudflare Tunnel/Worker؛ لا يستخدمه البرنامج في وضعه المحلي دون إنترنت.</small></Field>
        <Field label="رابط العودة للتوثيق (اختياري)"><input name="merchantRedirectUrl" type="url" defaultValue={selected?.merchantRedirectUrl ?? ""} placeholder="https://..." dir="ltr" /></Field>
        <Field label="رابط وسيط HTTPS اختياري"><input name="relayUrl" type="url" defaultValue={selected?.relayUrl ?? ""} placeholder="https://..." dir="ltr" /></Field>
        <Field label="رمز حماية الوسيط (إن وُجد)"><input name="relayToken" type="password" autoComplete="new-password" placeholder="اتركه فارغًا للإبقاء على القيمة الحالية" dir="ltr" /></Field>
      </div>
      <fieldset><legend>{isKashier ? "وسائل الدفع المفعلة في حساب Kashier" : "وسائل الدفع المفعلة للحساب"}</legend>
        {(isKashier ? kashierEnabledMethodOptions : [['FAWRY_REFERENCE', 'فوري برقم مرجعي (Pay at Fawry)']]).map(([value, label]) => <label key={value} className="toggle-row"><input type="checkbox" name="enabledMethods" value={value} defaultChecked={selected?.enabledMethods.includes(value)} /><span>{label}</span></label>)}
      </fieldset>
      {isKashier && <p className="hint">فعّل المحفظة أو InstaPay هنا فقط إذا كانت ظاهرة كوسائل مفعّلة في حساب Kashier بعد «اختبار الاتصال وتحديث الوسائل». هذه العلامة تحفظ إعداد نبته ولا تمنح صلاحية غير مفعّلة من Kashier.</p>}
      <label className="toggle-row"><input name="receiptPrintEnabled" type="checkbox" defaultChecked={selected?.receiptPrintEnabled ?? true} /><span>{isKashier ? "اطلب طباعة إيصال من ماكينة Kashier" : "اطبع إيصال نبته بعد تأكيد فوري"}</span></label>
      <Field label="كلمة مرور المالك للتأكيد"><input name="confirmationPassword" type="password" required autoComplete="current-password" /></Field>
      <div className="modal-actions"><button className="primary" disabled={busy || currentUser?.role !== "OWNER"}>حفظ إعدادات {providerName}</button><button type="button" disabled={busy || !selected?.configured} onClick={() => void testConnection()}>{isKashier ? "اختبار الاتصال وتحديث الوسائل" : "فحص إعداد فوري"}</button><button type="button" disabled={busy || !selected?.configured} onClick={() => void reconcile()}>مراجعة المدفوعات المعلّقة</button></div>
    </form>
    <hr />
    <h3>{isKashier ? "ربط ماكينة Kashier" : "بيانات ماكينة فوري"}</h3>
    <form className="two-columns" onSubmit={(event) => void bindDevice(event)}>
      <Field label="معرّف نقطة البيع في نبته"><input name="terminalId" required defaultValue={terminalId ?? ""} placeholder="UUID" dir="ltr" /><small className="hint">يُنشأ ويُملأ تلقائيًا لهذا التثبيت.</small></Field>
      <Field label={isKashier ? "Kashier POS Serial Number" : "رقم/معرّف ماكينة فوري"}><input name="serialNo" required dir="ltr" /></Field>
      <label className="toggle-row"><input name="active" type="checkbox" defaultChecked /><span>الماكينة نشطة</span></label>
      <div className="modal-actions"><button className="primary" disabled={busy}>حفظ الربط</button></div>
    </form>
    {!isKashier && <p className="hint">هذه البيانات توثيق للماكينة ونقطة البيع فقط إلى أن تزودنا فوري ببروتوكول ربط مباشر معتمد؛ لن يرسل البرنامج مبالغ للماكينة بطريقة غير موثقة.</p>}
    {settings?.devices.length ? <ul className="hint">{settings.devices.map((device) => <li key={device.terminalId}><span dir="ltr">{device.terminalId}</span> ← <span dir="ltr">{device.serialNo}</span> {device.active ? "(نشطة)" : "(متوقفة)"}</li>)}</ul> : <p className="hint">لم تُربط أي ماكينة بعد.</p>}
  </section>;
}

interface CloudflareConnectionView {
  enabled: boolean;
  autoStart: boolean;
  configured: boolean;
  tunnelTokenConfigured: boolean;
  commerceSecretConfigured: boolean;
  terminalRelaySecretConfigured: boolean;
  terminalRelayUrl: string;
  cloudflaredBundled: boolean;
  publicApiUrl: string;
  cloudCoreUrl: string;
  cloudStoreConfigured: boolean;
  cloudMigrationState: "NOT_STARTED" | "PENDING" | "IMPORTED";
  running: boolean;
}

type CloudMigrationProgressView = {
  phase: string;
  percent: number;
  messageAr: string;
  completedChunks?: number;
  totalChunks?: number;
};

function CloudflareConnectionPanel({ currentUser }: { currentUser?: User | undefined }): ReactNode {
  const [connection, setConnection] = useState<CloudflareConnectionView | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<CloudMigrationProgressView | null>(null);
  const [deviceMode, setDeviceMode] = useState<"PRIMARY" | "SECONDARY">("PRIMARY");
  const refresh = async (): Promise<void> => {
    try {
      const [nextConnection, config] = await Promise.all([
        invoke<CloudflareConnectionView>({ operation: "cloudflare.connection.get" }),
        invoke<Config>({ operation: "config.get" }),
      ]);
      setConnection(nextConnection);
      setDeviceMode(config.deviceMode === "SECONDARY" ? "SECONDARY" : "PRIMARY");
    }
    catch (cause) { setMessage(errorMessage(cause)); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => window.nabta.onCloudMigrationProgress((progress) => setMigrationProgress(progress)), []);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await invoke<CloudflareConnectionView>({
        operation: "cloudflare.connection.update",
        payload: {
          enabled: data.get("enabled") === "on",
          autoStart: data.get("autoStart") === "on",
          ...(String(data.get("tunnelToken") ?? "").trim() ? { tunnelToken: String(data.get("tunnelToken")).trim() } : {}),
          ...(String(data.get("commerceSharedSecret") ?? "").trim() ? { commerceSharedSecret: String(data.get("commerceSharedSecret")).trim() } : {}),
          ...(String(data.get("terminalRelaySharedSecret") ?? "").trim() ? { terminalRelaySharedSecret: String(data.get("terminalRelaySharedSecret")).trim() } : {}),
          terminalRelayUrl: String(data.get("terminalRelayUrl") ?? "").trim(),
          publicApiUrl: String(data.get("publicApiUrl") ?? "").trim(),
        },
      });
      setConnection(result);
      setMessage(result.configured ? "تم حفظ الاتصال وإعادة تشغيل Cloudflare Tunnel تلقائيًا." : "تم حفظ الإعدادات. أدخل رمز النفق ومفتاح تطبيق العملاء لتفعيل الاتصال.");
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function makePrimary(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const pin = String(new FormData(event.currentTarget).get("enrollmentPin") ?? "");
    setBusy(true);
    try {
      await invoke({ operation: "multi-terminal.primary.enable", payload: { enrollmentPin: pin } });
      setDeviceMode("PRIMARY");
      setMessage("تم تعيين هذا الجهاز رئيسيًا. ستبقى قاعدة البيانات هنا، وتستطيع الآن ربط أجهزة الكاشير الأخرى.");
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function joinPrimary(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await invoke({ operation: "multi-terminal.join", payload: {
        serverUrl: String(data.get("serverUrl") ?? "").trim(),
        relayKey: String(data.get("relayKey") ?? "").trim(),
        terminalName: String(data.get("terminalName") ?? "").trim(),
        enrollmentPin: String(data.get("enrollmentPin") ?? "").trim(),
      } });
      setDeviceMode("SECONDARY");
      setMessage("تم ربط هذا الكاشير بالمخزن الموحد. أعد تشغيل نبتة الآن ليستخدم قاعدة بيانات الجهاز الرئيسي.");
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function migrateStoreToCloud(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMigrationProgress({ phase: "STARTING", percent: 0, messageAr: "يتم بدء فحص الاتصال السحابي…" });
    try {
      const result = await invoke<{ storeId: string; recordCount: number; chunkCount: number; status: "IMPORTED" }>({
        operation: "cloud.migration.run",
        payload: {
          cloudUrl: String(data.get("cloudCoreUrl") ?? "").trim(),
          ...(String(data.get("bootstrapKey") ?? "").trim() ? { bootstrapKey: String(data.get("bootstrapKey")).trim() } : {}),
          ownerUsername: String(data.get("ownerUsername") ?? "").trim(),
          ownerCloudPassword: String(data.get("ownerCloudPassword") ?? ""),
        },
      });
      await refresh();
      event.currentTarget.reset();
      setMessage(`اكتمل نسخ ${result.recordCount} سجلًا على ${result.chunkCount} دفعة والتحقق منها في السحابة. النسخة المحلية ما زالت تعمل ولم يتم حذف أي بيانات.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
      setMigrationProgress(null);
    }
    finally { setBusy(false); }
  }
  const canEdit = currentUser?.role === "OWNER";
  return <section className="panel operation-panel" dir="rtl">
    <h2>ربط تطبيق العملاء وCloudflare</h2>
    <p className="hint">الاتصال المحلي يظل يعمل بلا إنترنت. عند التفعيل، يبدأ Cloudflare Tunnel من نفس جهاز نبتة بعد تثبيت البرنامج وعند تسجيل دخول Windows. لا تُعرض المفاتيح المحفوظة مرة أخرى.</p>
    {message && <div className="notice">{message}</div>}
    <p className="hint">الحالة: {connection?.running ? "النفق يعمل الآن" : connection?.configured ? "جاهز وسيبدأ مع نبتة" : "غير مكتمل"} · برنامج Cloudflare: {connection?.cloudflaredBundled ? "مضمّن" : "غير موجود"}</p>
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <div className="two-columns">
        <Field label="رابط تطبيق العملاء العام (اختياري)">
          <input name="publicApiUrl" type="url" defaultValue={connection?.publicApiUrl ?? ""} placeholder="https://market.example.com" dir="ltr" />
        </Field>
        <Field label="رمز Cloudflare Tunnel الجديد">
          <input name="tunnelToken" type="password" autoComplete="new-password" placeholder={connection?.tunnelTokenConfigured ? "اتركه فارغًا للإبقاء على الرمز الحالي" : "ضع Tunnel Token"} dir="ltr" />
        </Field>
        <Field label="مفتاح ربط تطبيق العملاء الجديد">
          <input name="commerceSharedSecret" type="password" autoComplete="new-password" placeholder={connection?.commerceSecretConfigured ? "اتركه فارغًا للإبقاء على المفتاح الحالي" : "ضع المفتاح السري للـ Worker"} dir="ltr" />
        </Field>
        <Field label="رابط كاشيرات نبتة عبر Cloudflare">
          <input name="terminalRelayUrl" type="url" defaultValue={connection?.terminalRelayUrl ?? ""} placeholder="https://pos.example.com" dir="ltr" />
        </Field>
        <Field label="مفتاح أجهزة نبتة الموحد">
          <input name="terminalRelaySharedSecret" type="password" autoComplete="new-password" placeholder={connection?.terminalRelaySecretConfigured ? "اتركه فارغًا للإبقاء على المفتاح الحالي" : "مفتاح Worker الخاص بالكاشيرات"} dir="ltr" />
        </Field>
      </div>
      <label className="toggle-row"><input name="enabled" type="checkbox" defaultChecked={connection?.enabled} disabled={!canEdit || busy} /><span>تفعيل Cloudflare Tunnel لهذا الجهاز الأساسي</span></label>
      <label className="toggle-row"><input name="autoStart" type="checkbox" defaultChecked={connection?.autoStart} disabled={!canEdit || busy} /><span>تشغيل نبتة والاتصال تلقائيًا بعد تسجيل دخول Windows</span></label>
      <p className="hint">عند تغيير Cloudflare: ضع رمز النفق الجديد، وضع نفس مفتاح تطبيق العملاء في سرّ Worker الجديد ثم هنا. لا تفعّل جهازين على نفس النفق في الوقت نفسه.</p>
      <div className="modal-actions"><button className="primary" disabled={!canEdit || busy}>حفظ الاتصال وإعادة التشغيل</button><button type="button" disabled={busy} onClick={() => void refresh()}>تحديث الحالة</button></div>
    </form>
    <details className="panel">
      <summary>نسخ بيانات هذا المتجر إلى نبتة السحابية</summary>
      <p className="hint">يُستخدم هذا من جهاز نبتة الذي عليه البيانات الأصلية فقط. ينشئ نبتة نسخة احتياطية، يختبر استعادتها، ثم يرفع دفعات قابلة للاستكمال ويتحقق من كل جدول. عند التحديث تبقى آخر نسخة سحابية سليمة فعّالة حتى يكتمل التحقق من النسخة الجديدة؛ لا يحذف النسخة المحلية ولا يبدل تشغيل الكاشير تلقائيًا.</p>
      <p className="hint">الحالة: {connection?.cloudMigrationState === "IMPORTED" ? "توجد نسخة سحابية محمية ومتحقق منها. يمكنك تحديثها دون مفتاح التهيئة أو تغيير كلمة مرور المالك." : connection?.cloudMigrationState === "PENDING" ? "تم حفظ بيانات الاستكمال؛ يمكن متابعة النقل من نفس الجهاز." : "لم يُنشأ مخزن سحابي لهذا المتجر بعد."}</p>
      <form className="settings-form" onSubmit={(event) => void migrateStoreToCloud(event)}>
        <div className="two-columns">
          <Field label="رابط نواة نبتة السحابية"><input name="cloudCoreUrl" type="url" required defaultValue={connection?.cloudCoreUrl ?? ""} placeholder="https://nabta-cloud-core.mahmoudnabih989.workers.dev" dir="ltr" /></Field>
          <Field label="مفتاح التهيئة الأول (مرة واحدة فقط)"><input name="bootstrapKey" type="password" autoComplete="new-password" placeholder={connection?.cloudStoreConfigured ? "اتركه فارغًا لإعادة النقل أو الاستكمال" : "المفتاح الذي عيّنته في Cloudflare"} dir="ltr" /></Field>
          <Field label="اسم مستخدم المالك الموجود في نبتة"><input name="ownerUsername" required={!connection?.cloudStoreConfigured || connection?.cloudMigrationState !== "IMPORTED"} autoComplete="username" placeholder={connection?.cloudMigrationState === "IMPORTED" ? "اختياري عند تحديث النسخة" : "مطلوب عند التهيئة"} dir="ltr" /></Field>
          <Field label="كلمة مرور سحابية جديدة للمالك (12 حرفًا على الأقل)"><input name="ownerCloudPassword" type="password" minLength={12} required={!connection?.cloudStoreConfigured || connection?.cloudMigrationState !== "IMPORTED"} autoComplete="new-password" placeholder={connection?.cloudMigrationState === "IMPORTED" ? "اختيارية عند تحديث النسخة" : "مطلوبة عند التهيئة"} dir="ltr" /></Field>
        </div>
        <div className="modal-actions"><button className="primary" disabled={!canEdit || busy || deviceMode !== "PRIMARY"}>{connection?.cloudMigrationState === "PENDING" ? "استكمال النقل للسحابة" : connection?.cloudMigrationState === "IMPORTED" ? "إنشاء نسخة جديدة والتحقق ثم تحديث السحابة" : "إنشاء نسخة والتحقق ثم النقل للسحابة"}</button></div>
      </form>
      {migrationProgress && <div className="cloud-migration-progress" role="status" aria-live="polite">
        <div className="cloud-migration-progress-head"><strong>{migrationProgress.messageAr}</strong><b>{migrationProgress.percent}%</b></div>
        <div className="cloud-migration-progress-track" aria-label={`تقدم النقل ${migrationProgress.percent}%`}><span style={{ width: `${migrationProgress.percent}%` }} /></div>
        {typeof migrationProgress.completedChunks === "number" && typeof migrationProgress.totalChunks === "number" && <small>تمت معالجة {migrationProgress.completedChunks} من {migrationProgress.totalChunks} دفعة.</small>}
      </div>}
    </details>
    <hr />
    <h3>المخزن الموحد والكاشيرات</h3>
    <p className="hint">الحالة الحالية: {deviceMode === "PRIMARY" ? "هذا هو الجهاز الرئيسي وصاحب قاعدة البيانات" : "هذا كاشير متصل بالجهاز الرئيسي"}. لا يُشغّل النفق أو قاعدة بيانات مشتركة على الأجهزة الثانوية.</p>
    {deviceMode !== "PRIMARY" && <form className="two-columns" onSubmit={(event) => void makePrimary(event)}><Field label="رمز تعيين الجهاز الرئيسي"><input name="enrollmentPin" type="password" inputMode="numeric" required /></Field><div className="modal-actions"><button className="primary" disabled={!canEdit || busy}>تعيين هذا الجهاز رئيسيًا</button></div></form>}
    {deviceMode === "PRIMARY" && <details className="panel"><summary>تحويل هذا التثبيت إلى كاشير ثانوي متصل بالجهاز الرئيسي</summary><p className="hint">نفّذ هذا على الجهاز الثاني أو الثالث فقط؛ لا تنفذه على جهاز المخزن الرئيسي. لا يحذف أي بيانات محلية، لكنه يتوقف عن استخدامها بعد الربط.</p><form className="two-columns" onSubmit={(event) => void joinPrimary(event)}>
      <Field label="اسم الكاشير الجديد"><input name="terminalName" required placeholder="كاشير 2" /></Field>
      <Field label="رابط Cloudflare للكاشيرات"><input name="serverUrl" type="url" required defaultValue={connection?.terminalRelayUrl ?? ""} dir="ltr" /></Field>
      <Field label="مفتاح أجهزة نبتة"><input name="relayKey" type="password" required autoComplete="new-password" /></Field>
      <Field label="رمز ربط الجهاز"><input name="enrollmentPin" type="password" inputMode="numeric" required /></Field>
      <div className="modal-actions full"><button className="primary" disabled={!canEdit || busy}>ربط هذا الجهاز ككاشير ثانوي</button></div>
    </form></details>}
  </section>;
}

function ManagementPanel({
  onDataReset,
  currentUser,
  onUserUpdated,
}: {
  onDataReset: () => void;
  currentUser?: User | undefined;
  onUserUpdated?: ((user: User) => void) | undefined;
}): ReactNode {
  type Tab = "users" | "audit" | "backup" | "receipt" | "reset";
  type ManagedUser = {
    id: string;
    displayName: string;
    username: string;
    role: "OWNER" | "MANAGER" | "CASHIER" | "STOCK_KEEPER" | "EXPIRY_CLERK";
    active: boolean;
    discountLimitBps: number;
  };
  type AuditEntry = {
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    reason: string | null;
    metadata: Record<string, unknown>;
    occurredAt: string;
    actorName: string;
    terminalName: string | null;
  };
  type Backup = {
    id: string;
    path: string;
    sha256: string | null;
    size_bytes: number | null;
    status: string;
    completed_at: string | null;
  };
  type BackupPolicy = {
    automaticEnabled: boolean;
    destinationPath: string;
    intervalDays: number;
    retentionDays: number;
    lastAutomaticBackupAt: string | null;
    nextBackupDueAt: string | null;
  };
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [auditRows, setAuditRows] = useState<AuditEntry[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupPolicy, setBackupPolicy] = useState<BackupPolicy | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [nextUsers, nextAudit, nextBackups, nextBackupPolicy] = await Promise.all([
        invoke<{ users: ManagedUser[] }>({ operation: "users.list" }),
        invoke<{ entries: AuditEntry[] }>({
          operation: "audit.list",
          payload: { limit: 100 },
        }),
        invoke<{ backups: Backup[] }>({ operation: "backups.list" }),
        invoke<BackupPolicy>({ operation: "backups.policy.get" }),
      ]);
      setUsers(nextUsers.users);
      setAuditRows(nextAudit.entries);
      setBackups(nextBackups.backups);
      setBackupPolicy(nextBackupPolicy);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function createUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await invoke({
        operation: "users.create",
        payload: {
          displayName: String(data.get("displayName")),
          username: String(data.get("username")),
          password: String(data.get("password")),
          role: String(data.get("role")) as ManagedUser["role"],
          discountLimitBps: Number(data.get("discountLimitBps")) || 0,
        },
      });
      event.currentTarget.reset();
      await refresh();
      setMessage("تم إنشاء المستخدم وصلاحيات دوره.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function saveUser(
    user: ManagedUser,
    form: HTMLFormElement,
  ): Promise<void> {
    setBusy(true);
    const data = new FormData(form);
    try {
      const nextDisplayName = String(data.get("displayName") || user.displayName).trim();
      await invoke({
        operation: "users.update",
        payload: {
          userId: user.id,
          update: {
            displayName: nextDisplayName,
            role: String(data.get("role")) as ManagedUser["role"],
            active: data.get("active") === "on",
            discountLimitBps: Number(data.get("discountLimitBps")) || 0,
            ...(String(data.get("password") ?? "")
              ? { password: String(data.get("password")) }
              : {}),
          },
        },
      });
      if (currentUser && user.id === currentUser.id && nextDisplayName) {
        onUserUpdated?.({ ...currentUser, displayName: nextDisplayName });
      }
      await refresh();
      setMessage("تم حفظ حساب المستخدم وصلاحياته.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function runBackup(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ path: string }>({
        operation: "backups.run",
      });
      await refresh();
      setMessage(`اكتمل النسخ الاحتياطي: ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function chooseBackupDestination(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ cancelled: boolean; path?: string }>({ operation: "backups.choose-destination" });
      if (result.cancelled) {
        setMessage("أُلغي اختيار مكان حفظ النسخة الاحتياطية.");
        return;
      }
      await refresh();
      setMessage(`اكتمل النسخ الاحتياطي في: ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function chooseAutomaticBackupDirectory(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; createdPath?: string }>({
        operation: "backups.choose-automatic-directory",
      });
      if (result.cancelled) {
        setMessage("أُلغي اختيار مجلد النسخ الاحتياطي التلقائي.");
        return;
      }
      await refresh();
      setMessage(result.createdPath
        ? `تم تفعيل النسخ التلقائي وإنشاء نسخة موثقة الآن في: ${result.createdPath}`
        : `تم حفظ مجلد النسخ التلقائي: ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function importBackupFromFile(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ cancelled: boolean; path?: string; schemaVersion?: string }>({ operation: "backups.import-from-file" });
      if (result.cancelled) {
        setMessage("أُلغي اختيار ملف النسخة الاحتياطية.");
        return;
      }
      await refresh();
      setMessage(`تم استيراد النسخة والتحقق منها في بيئة معزولة (إصدار المخطط ${result.schemaVersion}).`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function verifyBackup(backupId: string): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ schemaVersion: string }>({
        operation: "backups.verify",
        payload: { backupId },
      });
      await refresh();
      setMessage(
        `نجح اختبار الاستعادة المعزول للنسخة (الإصدار ${result.schemaVersion}).`,
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function reprint(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const invoiceNo = String(
      new FormData(event.currentTarget).get("invoiceNo") ?? "",
    ).trim();
    try {
      const found = await invoke<{ sale_id: string }>({
        operation: "sales.lookup",
        payload: { invoiceNo },
      });
      const sale = await invoke<SaleResponse>({
        operation: "sales.reprint",
        payload: { saleId: found.sale_id },
      });
      const store = await invoke<{ storeName: string } & ReceiptBranding>({
        operation: "store.info",
      });
      await invoke({
        operation: "hardware.receipt.print",
        payload: { storeName: store.storeName, branding: store, copies: 1, sale },
      });
      await refresh();
      setMessage(`أُعيدت طباعة ${sale.invoiceNo} وسُجلت العملية في التدقيق.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function resetOperationalData(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get("acknowledged") !== "on") {
      setMessage("أكد أنك قرأت نطاق إعادة البدء قبل التنفيذ.");
      return;
    }
    if (!window.confirm("سيُحذف سجل الفواتير والمشتريات والأرباح والعملاء والورديات، مع الاحتفاظ بالأصناف والكميات الحالية. هل تريد المتابعة؟")) return;
    setBusy(true);
    try {
      const result = await invoke<{
        backupPath: string;
        removed: { sales: number; purchases: number; customers: number; shifts: number };
      }>({
        operation: "settings.data-reset",
        payload: { confirmationCode: String(data.get("confirmationCode") ?? "").trim() },
      });
      window.alert(`تم بدء دورة جديدة وحُفظت نسخة احتياطية قبل المسح في:\n${result.backupPath}\n\nتم حذف ${result.removed.sales} فاتورة بيع و${result.removed.purchases} عملية شراء. ستسجل الدخول مرة أخرى الآن.`);
      onDataReset();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel operation-panel management-panel">
      <div className="panel-title-row">
        <div>
          <h2>الإدارة والرقابة</h2>
          <p className="hint">
            إجراءات الإدارة تُسجّل باسم المنفذ والجهاز ولا يمكن حذف سجلها.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          تحديث
        </button>
      </div>
      {message && <div className="notice">{message}</div>}
      <div className="subtabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "users"}
          onClick={() => setTab("users")}
        >
          المستخدمون والصلاحيات
        </button>
        <button
          role="tab"
          aria-selected={tab === "audit"}
          onClick={() => setTab("audit")}
        >
          سجل التدقيق
        </button>
        <button
          role="tab"
          aria-selected={tab === "receipt"}
          onClick={() => setTab("receipt")}
        >
          إعادة الطباعة
        </button>
        <button
          role="tab"
          aria-selected={tab === "backup"}
          onClick={() => setTab("backup")}
        >
          النسخ والاستعادة
        </button>
        <button
          role="tab"
          aria-selected={tab === "reset"}
          onClick={() => setTab("reset")}
        >
          بدء دورة جديدة
        </button>
      </div>
      {tab === "users" && (
        <div className="management-grid">
          <form
            className="form-grid compact-form"
            onSubmit={(event) => void createUser(event)}
          >
            <h3 className="full">إضافة مستخدم</h3>
            <Field label="الاسم">
              <input name="displayName" required />
            </Field>
            <Field label="اسم المستخدم">
              <input name="username" dir="ltr" required />
            </Field>
            <Field label="كلمة المرور">
              <input name="password" type="password" minLength={12} required />
            </Field>
            <Field label="الدور">
              <select name="role">
                <option value="CASHIER">كاشير</option>
                <option value="STOCK_KEEPER">أمين مخزن</option>
                <option value="EXPIRY_CLERK">موظف صلاحية</option>
                <option value="MANAGER">مدير</option>
                <option value="OWNER">مالك</option>
              </select>
            </Field>
            <Field label="حد الخصم (%)">
              <input
                name="discountLimitBps"
                defaultValue="0"
                type="number"
                min="0"
                max="10000"
                step="1"
              />
            </Field>
            <button className="primary full" disabled={busy}>
              إنشاء المستخدم
            </button>
          </form>
          <div className="management-list">
            {users.map((user) => (
              <form
                className="user-row"
                key={user.id}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveUser(user, event.currentTarget);
                }}
              >
                <input
                  name="displayName"
                  defaultValue={user.displayName}
                  required
                  placeholder="الاسم"
                  aria-label={`اسم ${user.displayName}`}
                  style={{ minWidth: 110, padding: "5px 8px" }}
                />
                <small dir="ltr">{user.username}</small>
                <select name="role" defaultValue={user.role}>
                  <option value="OWNER">مالك</option>
                  <option value="MANAGER">مدير</option>
                  <option value="CASHIER">كاشير</option>
                  <option value="STOCK_KEEPER">أمين مخزن</option>
                  <option value="EXPIRY_CLERK">موظف صلاحية</option>
                </select>
                <input
                  name="discountLimitBps"
                  type="number"
                  defaultValue={user.discountLimitBps}
                  min="0"
                  max="10000"
                  aria-label={`حد خصم ${user.displayName}`}
                />
                <label className="toggle-row">
                  <input
                    name="active"
                    type="checkbox"
                    defaultChecked={user.active}
                  />
                  <span>
                    <b>نشط</b>
                  </span>
                </label>
                <input
                  name="password"
                  type="password"
                  placeholder="كلمة جديدة (اختياري)"
                  aria-label={`كلمة مرور جديدة لـ ${user.displayName}`}
                />
                <button disabled={busy}>حفظ</button>
              </form>
            ))}
          </div>
        </div>
      )}
      {tab === "audit" && (
        <div className="audit-list">
          {auditRows.map((entry) => (
            <article key={entry.id} className="audit-row">
              <div>
                <b>{entry.action}</b>
                <small>
                  {entry.actorName}
                  {entry.terminalName ? ` — ${entry.terminalName}` : ""}
                </small>
              </div>
              <div>
                <small>
                  {new Date(entry.occurredAt).toLocaleString("ar-EG", {
                    timeZone: "Africa/Cairo",
                  })}
                </small>
                <p>{entry.reason || entry.entityType}</p>
              </div>
            </article>
          ))}
          {auditRows.length === 0 && (
            <p className="empty">لا توجد عمليات مسجلة بعد.</p>
          )}
        </div>
      )}
      {tab === "receipt" && (
        <form
          className="form-grid compact-form"
          onSubmit={(event) => void reprint(event)}
        >
          <h3 className="full">إعادة طباعة إيصال</h3>
          <Field label="رقم الفاتورة">
            <input
              name="invoiceNo"
              placeholder="INV-2026-00000001"
              dir="ltr"
              required
            />
          </Field>
          <p className="hint full">
            تحتاج طابعة إيصالات مختارة في إعدادات الأجهزة. كل إعادة طباعة تُسجل
            في سجل التدقيق مع عددها.
          </p>
          <button className="primary" disabled={busy}>
            بحث وطباعة الإيصال
          </button>
        </form>
      )}
      {tab === "backup" && (
        <div>
          <div className="backup-actions">
            <div>
              <h3>النسخ الاحتياطي والاستيراد الآمن</h3>
              <p className="hint">
                اختر مكان حفظ النسخة بنفسك، أو اختر ملف نسخة من أي مسار لاستيراده.
                يُفحص الملف المستورد في قاعدة معزولة قبل إضافته للقائمة، ولا تُستبدل
                بيانات المتجر الحية أثناء التشغيل.
              </p>
            </div>
            <div className="backup-action-buttons">
              <div className="automatic-backup-policy">
                <b>النسخ التلقائي المحمي</b>
                <p>ينشئ البرنامج نسخة كاملة ومختبرة كل 3 أيام، ويحذف فقط النسخ التلقائية التي تجاوز عمرها 30 يوماً.</p>
                <small dir="ltr">{backupPolicy?.destinationPath ?? "جارٍ تحميل مسار النسخ…"}</small>
                {backupPolicy?.lastAutomaticBackupAt && (
                  <small>آخر نسخة تلقائية: {new Date(backupPolicy.lastAutomaticBackupAt).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}</small>
                )}
              </div>
              <button type="button" onClick={() => void chooseAutomaticBackupDirectory()} disabled={busy}>
                اختيار مجلد النسخ التلقائي
              </button>
              <button className="primary" type="button" onClick={() => void chooseBackupDestination()} disabled={busy}>
                إنشاء نسخة واختيار مكان الحفظ
              </button>
              <button type="button" onClick={() => void importBackupFromFile()} disabled={busy}>
                استيراد نسخة من ملف
              </button>
              <button type="button" onClick={() => void runBackup()} disabled={busy}>
                إنشاء في المسار الافتراضي
              </button>
            </div>
          </div>
          <div className="audit-list">
            {backups.map((item) => (
              <article key={item.id} className="audit-row">
                <div>
                  <b>{item.status}</b>
                  <small dir="ltr">{item.path}</small>
                </div>
                <div>
                  <small>
                    {item.size_bytes
                      ? `${item.size_bytes.toLocaleString("ar-EG")} bytes`
                      : ""}
                  </small>
                  <p dir="ltr">{item.sha256 ?? ""}</p>
                  <button
                    type="button"
                    onClick={() => void verifyBackup(item.id)}
                    disabled={busy || item.status === "FAILED"}
                  >
                    اختبار الاستعادة
                  </button>
                </div>
              </article>
            ))}
            {backups.length === 0 && (
              <p className="empty">لا توجد نسخ مسجلة بعد.</p>
            )}
          </div>
        </div>
      )}
      {tab === "reset" && (
        <form className="data-reset-panel" onSubmit={(event) => void resetOperationalData(event)}>
          <div>
            <h3>بدء دورة جديدة للمتجر</h3>
            <p>
              يُنشئ نبتة نسخة احتياطية تلقائيًا أولًا، ثم يمسح عمليات الشراء والبيع والفواتير والأرباح والورديات والمصروفات وأسماء العملاء.
            تبقى الأصناف والباركود والأسعار والكميات الحالية في المخزن كما هي.
            يجب ألا تكون هناك وردية مفتوحة.
            تبقى حسابات المستخدمين والموردون وإعدادات البرنامج محفوظة.
          </p>
          <p>بعد التنفيذ ستعود شاشة تسجيل الدخول لتبدأ عملًا جديدًا.</p>
        </div>
        <Field label="الرمز السري لإعادة البدء">
          <input
            name="confirmationCode"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            autoComplete="off"
            required
          />
        </Field>
        <label className="data-reset-acknowledgement">
          <input name="acknowledged" type="checkbox" />
          <span>أفهم أن سجل المعاملات سيُحذف بعد إنشاء النسخة الاحتياطية.</span>
        </label>
        <button className="danger-button" disabled={busy}>
          {busy ? "جارٍ إنشاء النسخة وبدء الدورة…" : "إنشاء نسخة وبدء دورة جديدة"}
        </button>
      </form>
      )}
    </section>
  );
}

function ReportsScreen({
  storeName = "الشيماء",
  shift,
}: {
  storeName?: string;
  shift?: Shift | null;
}): ReactNode {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ComprehensiveReportResponse | null>(null);
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [printing, setPrinting] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await invoke<ComprehensiveReportResponse>({ operation: "reports.comprehensive", payload: { from, to } }));
      setMessage("");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }, [from, to]);
  useEffect(() => {
    void load();
  }, [load]);
  const summary: ReportSummary = {
    netSalesMinor: data?.summary.netSalesMinor ?? 0,
    netCogsMinor: data?.summary.netCogsMinor ?? 0,
    grossProfitMinor: data?.summary.grossProfitMinor ?? 0,
    estimatedNetProfitMinor: data?.summary.estimatedNetProfitMinor ?? 0,
    returnsMinor: data?.summary.returnsMinor ?? 0,
    expensesMinor: data?.summary.expensesMinor ?? 0,
    damagedLossMinor: data?.summary.damagedLossMinor ?? 0,
    invoiceCount: data?.summary.invoiceCount ?? 0,
  };
  const cards: ReadonlyArray<readonly [string, number]> = [
    ["صافي المبيعات", summary.netSalesMinor],
    ["تكلفة المبيعات", summary.netCogsMinor],
    ["مجمل الربح", summary.grossProfitMinor],
    ["صافي الربح التقديري", summary.estimatedNetProfitMinor],
  ];
  const setThisMonth = (): void => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const date = (value: Date) =>
      `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    setFrom(date(start));
    setTo(date(end));
  };
  const setPreviousMonth = (): void => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    const date = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    setFrom(date(start)); setTo(date(end));
  };
  async function printReport(): Promise<void> {
    if (!data) return;
    setPrinting(true);
    try {
      await invoke({
        operation: "reports.print",
        payload: { storeName, from, to, summary },
      });
      setMessage(
        "أُرسل التقرير إلى نافذة الطباعة. اختر طابعة الورق العادية ثم اطبع.",
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setPrinting(false);
    }
  }
  async function exportPdf(): Promise<void> {
    if (!data) return;
    setExporting(true);
    try {
      const result = await invoke<{ cancelled: boolean; path?: string }>({
        operation: "reports.export-pdf",
        payload: { storeName, from, to, summary },
      });
      setMessage(
        result.cancelled
          ? "تم إلغاء حفظ PDF."
          : `تم حفظ التقرير بصيغة PDF في: ${result.path}`,
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  }
  async function exportExcel(): Promise<void> {
    setExportingExcel(true);
    try {
      const result = await invoke<{ cancelled: boolean; path?: string }>({ operation: "reports.export-xlsx", payload: { from, to } });
      setMessage(result.cancelled ? "تم إلغاء حفظ ملف Excel." : `تم حفظ التقرير الشامل بصيغة Excel في: ${result.path}`);
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setExportingExcel(false); }
  }
  const maximumDailySales = Math.max(1, ...(data?.dailySales.map((item) => item.netSalesMinor) ?? [0]));
  const maximumPayment = Math.max(1, ...(data?.paymentMethods.map((item) => item.amountMinor) ?? [0]));
  return (
    <>
      <PageHead
        title="التقارير والأرباح"
        subtitle="اختر الشهر أو أي مدة مخصصة، ثم صدّر تقرير Excel شاملًا بالتحليل والتفاصيل."
      />
      <div className="filters report-actions">
        <Field label="من">
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <Field label="إلى">
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </Field>
        <button onClick={setThisMonth}>هذا الشهر</button>
        <button onClick={setPreviousMonth}>الشهر السابق</button>
        <button onClick={() => void load()}>تحديث</button>
        <button
          className="primary"
          disabled={!data || printing}
          onClick={() => void printReport()}
        >
          {printing ? "جارٍ فتح الطباعة…" : "طباعة A4"}
        </button>
        <button disabled={!data || exporting} onClick={() => void exportPdf()}>
          {exporting ? "جارٍ التصدير…" : "تصدير PDF"}
        </button>
        <button className="primary" disabled={!data || exportingExcel} onClick={() => void exportExcel()}>
          {exportingExcel ? "جارٍ تجهيز Excel…" : "تقرير Excel شامل"}
        </button>
      </div>
      {message && <div className="notice">{message}</div>}
      <div className="stats">
        {cards.map(([label, value]) => (
          <section className="panel stat" key={label}>
            <small>{label}</small>
            <strong>{formatMoney(value)}</strong>
          </section>
        ))}
      </div>
      <section className="panel report-details">
        <p>
          <span>المرتجعات</span>
          <b>{formatMoney(summary.returnsMinor)}</b>
        </p>
        <p>
          <span>المصروفات</span>
          <b>{formatMoney(summary.expensesMinor)}</b>
        </p>
        <p>
          <span>الرواتب</span>
          <b>{formatMoney(data?.summary.payrollMinor ?? 0)}</b>
        </p>
        <p>
          <span>استهلاك المحل</span>
          <b>{formatMoney(data?.summary.shopConsumptionMinor ?? 0)}</b>
        </p>
        <p>
          <span>خسارة مرتجع تالف</span>
          <b>{formatMoney(summary.damagedLossMinor)}</b>
        </p>
        <p>
          <span>عدد الفواتير</span>
          <b>{new Intl.NumberFormat("ar-EG").format(summary.invoiceCount)}</b>
        </p>
        <p><span>قيمة المخزون</span><b>{formatMoney(data?.inventory.inventoryValueMinor ?? 0)}</b></p>
        <p><span>أصناف منخفضة/نافدة</span><b>{data ? `${data.inventory.lowStockCount} / ${data.inventory.outOfStockCount}` : "0 / 0"}</b></p>
      </section>
      {data && <div className="two-columns">
        <section className="panel report-details">
          <h2>اتجاه المبيعات</h2>
          {data.dailySales.length ? data.dailySales.map((item) => <div key={item.date} style={{ display: "grid", gridTemplateColumns: "88px 1fr 110px", gap: 8, alignItems: "center", marginBlock: 9 }}>
            <small dir="ltr">{item.date}</small><span style={{ display: "block", height: 12, borderRadius: 99, background: "#e2e8f0", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${Math.max(3, (item.netSalesMinor / maximumDailySales) * 100)}%`, background: "#059669" }} /></span><b>{formatMoney(item.netSalesMinor)}</b>
          </div>) : <p className="hint">لا توجد مبيعات في الفترة المختارة.</p>}
        </section>
        <section className="panel report-details">
          <h2>وسائل الدفع</h2>
          {data.paymentMethods.length ? data.paymentMethods.map((item) => <div key={item.method} style={{ display: "grid", gridTemplateColumns: "100px 1fr 100px", gap: 8, alignItems: "center", marginBlock: 9 }}>
            <small>{item.method}</small><span style={{ display: "block", height: 12, borderRadius: 99, background: "#e2e8f0", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${Math.max(3, (item.amountMinor / maximumPayment) * 100)}%`, background: "#2563eb" }} /></span><b>{formatMoney(item.amountMinor)}</b>
          </div>) : <p className="hint">لا توجد مدفوعات في الفترة المختارة.</p>}
        </section>
        <section className="panel report-details">
          <h2>أفضل الأصناف</h2>
          {data.topProducts.slice(0, 5).map((item) => <p key={`${item.nameAr}-${item.category}`}><span>{item.nameAr}<small> — {item.category}</small></span><b>{formatMoney(item.netSalesMinor)}</b></p>)}
        </section>
        <section className="panel report-details">
          <h2>تحليل سريع</h2>
          {data.insights.map((insight) => <p key={insight} className="hint">• {insight}</p>)}
        </section>
      </div>}
      <PayrollPanel month={from.slice(0, 7)} shift={shift ?? null} />
    </>
  );
}

function PayrollPanel({ month, shift }: { month: string; shift: Shift | null }): ReactNode {
  type ManagedEmployee = { id: string; displayName: string; active: boolean; role: string };
  type PayrollRow = { id: string; employeeName: string; netMinor: number; paymentMethod: string; paidOn: string };
  const [employees, setEmployees] = useState<ManagedEmployee[]>([]);
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const refresh = useCallback(async () => {
    try {
      const [users, payroll] = await Promise.all([
        invoke<{ users: ManagedEmployee[] }>({ operation: "users.list" }),
        invoke<{ items: PayrollRow[] }>({ operation: "payroll.list", payload: { month } }),
      ]);
      setEmployees(users.users.filter((user) => user.active));
      setRows(payroll.items);
    } catch (cause) { setMessage(errorMessage(cause)); }
  }, [month]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const minor = (name: string): number => Math.max(0, Math.round(Number(form.get(name) || 0) * 100));
    const paymentMethod = String(form.get("paymentMethod")) as "CASH" | "BANK_TRANSFER" | "WALLET";
    setBusy(true);
    try {
      await invoke({ operation: "payroll.create", payload: {
        employeeUserId: String(form.get("employeeUserId")), payrollMonth: month, baseMinor: minor("base"), overtimeMinor: minor("overtime"), bonusMinor: minor("bonus"), deductionMinor: minor("deduction"), advanceMinor: minor("advance"),
        paymentMethod, ...(paymentMethod === "CASH" && shift ? { shiftId: shift.id } : {}), paidOn: String(form.get("paidOn")), note: String(form.get("note") || "") || undefined,
      } });
      event.currentTarget.reset(); setMessage("تم تسجيل الراتب ضمن مصروفات الشهر وسجل التدقيق."); await refresh();
    } catch (cause) { setMessage(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <section className="panel report-details">
    <div className="panel-title-row"><div><h2>الرواتب الشهرية</h2><p>سجّل الاستحقاق والخصومات والسلف. الراتب النقدي يخصم من الدرج المفتوح، والتحويل والمحفظة يظهران في الربح دون تغيير الدرج.</p></div><button type="button" onClick={() => void refresh()} disabled={busy}>تحديث</button></div>
    <form className="two-columns" onSubmit={(event) => void save(event)}>
      <Field label="الموظف"><select name="employeeUserId" required defaultValue=""><option value="" disabled>اختر الموظف</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.displayName} — {employee.role}</option>)}</select></Field>
      <Field label="تاريخ الصرف"><input name="paidOn" type="date" required defaultValue={today} /></Field>
      <Field label="الراتب الأساسي (ج.م)"><input name="base" type="number" min="0" step="0.01" required /></Field>
      <Field label="إضافي / أوفر تايم (ج.م)"><input name="overtime" type="number" min="0" step="0.01" defaultValue="0" /></Field>
      <Field label="مكافأة (ج.م)"><input name="bonus" type="number" min="0" step="0.01" defaultValue="0" /></Field>
      <Field label="خصومات (ج.م)"><input name="deduction" type="number" min="0" step="0.01" defaultValue="0" /></Field>
      <Field label="سلفة مستقطعة (ج.م)"><input name="advance" type="number" min="0" step="0.01" defaultValue="0" /></Field>
      <Field label="طريقة الصرف"><select name="paymentMethod" defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">تحويل بنكي</option><option value="WALLET">محفظة إلكترونية</option><option value="CASH" disabled={!shift}>نقدًا من الدرج{shift ? "" : " — لا توجد وردية مفتوحة"}</option></select></Field>
      <Field label="ملاحظة"><input name="note" maxLength={250} placeholder="اختياري" /></Field>
      <div className="modal-actions"><button className="primary" disabled={busy || employees.length === 0}>{busy ? "جارٍ الحفظ…" : "تسجيل الراتب"}</button></div>
    </form>
    {message && <p className="hint">{message}</p>}
    <div className="table-wrap"><table><thead><tr><th>الموظف</th><th>الصافي</th><th>طريقة الصرف</th><th>التاريخ</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.employeeName}</td><td>{formatMoney(row.netMinor)}</td><td>{row.paymentMethod}</td><td dir="ltr">{row.paidOn}</td></tr>)}{!rows.length && <tr><td colSpan={4} className="empty">لا توجد رواتب مسجلة لهذا الشهر.</td></tr>}</tbody></table></div>
  </section>;
}

function PageHead({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

function Workspace({
  user,
  config,
  onLogout,
  theme,
  onThemeChange,
}: {
  user: User;
  config: Config;
  onLogout: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}): ReactNode {
  const [currentUser, setCurrentUser] = useState<User>(user);
  useEffect(() => {
    setCurrentUser(user);
  }, [user]);
  const [screen, setScreen] = useState<Screen>("pos");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [shift, setShift] = useState<Shift | null>(null);
  const [online, setOnline] = useState(true);
  const [pendingBarcode, setPendingBarcode] = useState("");
  const [resumeAfterProduct, setResumeAfterProduct] =
    useState<"pos" | "inventory" | null>(null);
  const [pendingProductEditQuery, setPendingProductEditQuery] = useState("");
  const [storeName, setStoreName] = useState("الشيماء");
  const [receiptBranding, setReceiptBranding] =
    useState<ReceiptBranding | undefined>(undefined);
  const [reorderAlerts, setReorderAlerts] =
    useState<ReorderListResponse | null>(null);
  const [posMetrics, setPosMetrics] = useState<PosMetricsResponse | null>(null);
  const [taxSettings, setTaxSettings] = useState<TaxSettings>(() => {
    try {
      const raw = localStorage.getItem(TAX_SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return DEFAULT_TAX_SETTINGS;
  });
  const updateTaxSettings = useCallback((next: TaxSettings) => {
    setTaxSettings(next);
    localStorage.setItem(TAX_SETTINGS_KEY, JSON.stringify(next));
  }, []);
  const refreshPosMetrics = useCallback(async (): Promise<PosMetricsResponse | null> => {
    try {
      const res = await invoke<PosMetricsResponse>({ operation: "pos.metrics" });
      setPosMetrics(res);
      return res;
    } catch {
      return null;
    }
  }, []);
  const loadCatalogProducts = useCallback(async (query = "", cursor?: string): Promise<CatalogPage> => {
    const result = await invoke<CatalogPage>({
      operation: "catalog.list",
      payload: { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}), limit: 200 },
    });
    return result;
  }, []);
  const refreshProducts = useCallback(async () => {
    const page = await loadCatalogProducts();
    setProducts(page.products);
    return page.products;
  }, [loadCatalogProducts]);
  const lookupProducts = useCallback(
    async (query: string, cursor?: string) => loadCatalogProducts(query, cursor),
    [loadCatalogProducts],
  );
  const refreshShift = useCallback(async () => {
    const result = await invoke<{ shift: Shift | null }>({
      operation: "shifts.current",
    });
    setShift(result.shift);
  }, []);
  const refreshReorderAlerts = useCallback(async () => {
    if (!user.permissions.includes("STOCK_COUNT")) return;
    try {
      setReorderAlerts(
        await invoke<ReorderListResponse>({ operation: "stock.reorder-list" }),
      );
    } catch {
      setReorderAlerts(null);
    }
  }, [user.permissions]);
  useEffect(() => {
    function receiveScan(event: Event): void {
      const barcode = String((event as CustomEvent<string>).detail || "");
      if (!barcode) return;
      localStorage.setItem(PENDING_RECEIPT_SCAN_KEY, barcode);
      setScreen("inventory");
    }
    function receiveUnknown(event: Event): void {
      const barcode = String((event as CustomEvent<string>).detail || "");
      if (!barcode) return;
      setPendingBarcode(barcode);
      setResumeAfterProduct("inventory");
      setScreen("products");
    }
    function receiptProductCreated(event: Event): void {
      if (!resumeAfterProduct) return;
      const barcode = String((event as CustomEvent<string>).detail || "");
      if (!barcode) return;
      if (resumeAfterProduct === "inventory")
        localStorage.setItem(PENDING_RECEIPT_SCAN_KEY, barcode);
      setResumeAfterProduct(null);
      setScreen(resumeAfterProduct);
    }
    window.addEventListener("nabta:purchase-scan", receiveScan);
    window.addEventListener("nabta:receipt-unknown-barcode", receiveUnknown);
    window.addEventListener(
      "nabta:receipt-product-created",
      receiptProductCreated,
    );
    return () => {
      window.removeEventListener("nabta:purchase-scan", receiveScan);
      window.removeEventListener(
        "nabta:receipt-unknown-barcode",
        receiveUnknown,
      );
      window.removeEventListener(
        "nabta:receipt-product-created",
        receiptProductCreated,
      );
    };
  }, [resumeAfterProduct]);
  const requestProductEdit = useCallback((query: string) => {
    const normalized = query.trim();
    if (!normalized) return;
    setPendingProductEditQuery(normalized);
    setScreen("products");
  }, []);
  useEffect(() => {
    void Promise.all([
      refreshProducts(),
      refreshShift(),
      refreshPosMetrics(),
    ]).catch(() => setOnline(false));
    const timer = window.setInterval(() => {
      void invoke({ operation: "health" })
        .then(() => setOnline(true))
        .catch(() => setOnline(false));
    }, 10_000);
    return () => clearInterval(timer);
  }, [refreshProducts, refreshShift]);
  useEffect(() => {
    void refreshReorderAlerts();
    const timer = window.setInterval(() => void refreshReorderAlerts(), 30_000);
    return () => clearInterval(timer);
  }, [refreshReorderAlerts]);
  useEffect(() => {
    void invoke<{ storeName: string } & ReceiptBranding>({ operation: "store.info" })
      .then((result) => {
        setStoreName(result.storeName);
        setReceiptBranding({
          logoDataUrl: result.logoDataUrl,
          receiptPhone: result.receiptPhone,
          whatsappPhone: result.whatsappPhone,
          socialHandle: result.socialHandle,
          receiptFooter: result.receiptFooter,
        });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    document.title = `${storeName} | نقطة البيع`;
  }, [storeName]);
  async function logout(): Promise<void> {
    try {
      await invoke({ operation: "logout" });
    } finally {
      onLogout();
    }
  }
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [scannedProductQuery, setScannedProductQuery] = useState("");
  const [clockNow, setClockNow] = useState(() => new Date());
  useEffect(() => {
    function routeBarcode(barcode: string): void {
      const normalized = barcode.trim();
      if (!normalized) return;
      if (screen === "pos") {
        window.dispatchEvent(
          new CustomEvent("nabta:pos-barcode-scan", { detail: normalized }),
        );
        return;
      }
      if (screen === "inventory") {
        window.dispatchEvent(
          new CustomEvent("nabta:inventory-barcode-scan", { detail: normalized }),
        );
        return;
      }
      setGlobalSearchQuery(normalized);
      setScannedProductQuery(normalized);
      setScreen("products");
    }

    let buffer = "";
    let startedAt = 0;
    let lastKeyAt = 0;
    function handleHid(event: KeyboardEvent): void {
      if (event.key === "Enter" || event.key === "Tab") {
        if (buffer.length >= 4 && Date.now() - startedAt <= 1_500) {
          const barcode = buffer;
          buffer = "";
          startedAt = 0;
          lastKeyAt = 0;
          event.preventDefault();
          routeBarcode(barcode);
        }
        return;
      }
      if (
        event.key.length !== 1 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const now = Date.now();
      if (!startedAt || now - lastKeyAt > 120) {
        buffer = event.key;
        startedAt = now;
      } else buffer += event.key;
      lastKeyAt = now;
    }

    const unsubscribe = window.nabta.onBarcodeScanned((scan) => {
      routeBarcode(scan.barcode);
    });
    window.addEventListener("keydown", handleHid, true);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", handleHid, true);
    };
  }, [screen]);
  useEffect(() => {
    const timer = setInterval(() => setClockNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const arabicDateStr = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("ar-EG", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(clockNow);
    } catch {
      return clockNow.toLocaleDateString("ar-EG");
    }
  }, [clockNow]);

  const arabicTimeStr = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("ar-EG", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(clockNow);
    } catch {
      return clockNow.toLocaleTimeString("ar-EG");
    }
  }, [clockNow]);

  const roleLabel = useMemo(() => {
    if (currentUser.role === "ADMIN" || currentUser.role === "OWNER") return "مدير المتجر";
    if (currentUser.role === "CASHIER") return "كاشير";
    if (currentUser.role === "STOCK") return "مسؤول مخزون";
    return currentUser.role;
  }, [currentUser.role]);

  const NAV_ICONS: Record<Screen, ReactNode> = {
    "weight-labels": (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16l2 13H2L4 7Z" /><path d="M8 7a4 4 0 0 1 8 0" /><path d="M12 11v5" /><path d="M10 14h4" /></svg>
    ),
    pos: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
    invoices: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="21" r="1.4" />
        <circle cx="20" cy="21" r="1.4" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
    ),
    products: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
    inventory: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
    reorder: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    ),
    partners: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    reports: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    expenses: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
        <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
      </svg>
    ),
    shift: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <rect x="16" y="11" width="6" height="8" rx="1" />
      </svg>
    ),
    settings: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  };

  const nav: Array<{ id: Screen; label: string; testName: string }> = [
    { id: "pos", label: "الرئيسية", testName: "الرئيسية نقطة البيع" },
    { id: "invoices", label: "المبيعات", testName: "المبيعات الفواتير" },
    { id: "products", label: "المنتجات", testName: "المنتجات الأصناف" },
    { id: "weight-labels", label: "حاسبة الوزن", testName: "حاسبة الوزن والملصقات" },
    { id: "inventory", label: "المخزون", testName: "المخزون" },
    ...(user.permissions.includes("PARTNER_MANAGE")
      ? [{ id: "partners" as Screen, label: "العملاء", testName: "العملاء العلاقات" }]
      : []),
    { id: "reports", label: "التقارير", testName: "التقارير" },
    ...(user.permissions.includes("CASH_MOVE")
      ? [{ id: "expenses" as Screen, label: "المصاريف", testName: "المصاريف المصروفات" }]
      : []),
    { id: "shift", label: "الموظفين", testName: "الموظفين الوردية" },
    ...(user.permissions.includes("SETTINGS")
      ? [{ id: "settings" as Screen, label: "الإعدادات", testName: "الإعدادات" }]
      : []),
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-leaf" aria-hidden="true">
            {receiptBranding?.logoDataUrl ? (
              <img
                src={receiptBranding.logoDataUrl}
                alt={storeName || "نبتة"}
              />
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.5 10-10 10Z" />
                <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
              </svg>
            )}
          </span>
          <div className="logo-text">
            <b className="logo-title" title={storeName || "نبتة"}>{storeName || "نبتة"}</b>
            <span className="logo-sub">{storeName ? "نظام نبتة لإدارة المبيعات" : "إدارة مبيعات أسهل"}</span>
          </div>
        </div>
        <nav>
          {nav.map(({ id, label, testName }) => (
            <button
              key={id}
              className={screen === id ? "active" : ""}
              onClick={() => setScreen(id)}
              aria-label={testName}
            >
              <span className="nav-icon">{NAV_ICONS[id]}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-logout">
          <button type="button" onClick={() => void logout()}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: 18, height: 18 }}
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>تسجيل الخروج</span>
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-right-widget">
            <span className="topbar-clock-icon">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: 22, height: 22 }}
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </span>
            <div className="topbar-clock-text">
              <span className="topbar-clock-date">{arabicDateStr}</span>
              <span className="topbar-clock-time">{arabicTimeStr}</span>
            </div>
          </div>

          <div className="topbar-search-wrap">
            <span className="topbar-search-icon">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: 17, height: 17 }}
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              data-testid="global-product-search"
              value={globalSearchQuery}
              onChange={(e) => {
                setGlobalSearchQuery(e.target.value);
                if (screen !== "pos" && screen !== "products") setScreen("pos");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setGlobalSearchQuery("");
                } else if (event.key === "F3") {
                  event.preventDefault();
                  requestProductEdit(globalSearchQuery);
                }
              }}
              placeholder="ابحث عن منتج أو باركود… Esc لمسح | F3 لتعديل"
              aria-label="ابحث عن منتج أو رقم باركود"
            />
          </div>

          <div className="topbar-left-controls">
            <div className="topbar-branch-pill">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: 16, height: 16 }}
              >
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span>{storeName || "فرع الرياض"}</span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: 12, height: 12, color: "#64748b" }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>

            {user.permissions.includes("STOCK_COUNT") && (
              <button
                type="button"
                className="topbar-bell-btn"
                onClick={() => setScreen("reorder")}
                aria-label="فتح تنبيهات النواقص"
                title="تنبيهات النواقص"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 18, height: 18 }}
                >
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {reorderAlerts && reorderAlerts.items.length > 0 && (
                  <span className="topbar-bell-badge">
                    {reorderAlerts.items.length}
                  </span>
                )}
              </button>
            )}

            <div className="topbar-user-chip">
              <div className="topbar-user-avatar">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 18, height: 18 }}
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <div className="topbar-user-info">
                <span className="topbar-user-name">
                  {currentUser.displayName || "المدير العام"}
                </span>
                <span className="topbar-user-role">{roleLabel}</span>
              </div>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: 12, height: 12, color: "#64748b" }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>

            <ThemeToggle theme={theme} onThemeChange={onThemeChange} />

            <span className={online ? "online" : "disconnected"} title={online ? "البيع والبحث يعتمدان على بيانات هذا الجهاز ولا يتوقفان عند فقد الإنترنت." : "خادم البيانات المحلي غير جاهز الآن."}>
              {online ? "البيانات المحلية جاهزة" : "البيانات المحلية غير جاهزة"}
            </span>
          </div>
        </header>
        <main className="content">
          {screen === "pos" && (
            <PosScreen
              products={products}
              shift={shift}
              online={online}
              refreshProducts={refreshProducts}
              lookupProducts={lookupProducts}
              refreshShift={refreshShift}
              storeName={storeName}
              branding={receiptBranding}
              onOpenShift={() => setScreen("shift")}
              canViewCost={user.permissions.includes("VIEW_COST")}
              onEditProductByQuery={requestProductEdit}
              globalSearch={globalSearchQuery}
              posMetrics={posMetrics}
              refreshPosMetrics={refreshPosMetrics}
              taxSettings={taxSettings}
            />
          )}
          {screen === "products" && (
            <ProductsScreen
              products={products}
              refresh={refreshProducts}
              suggestedBarcode={pendingBarcode}
              clearSuggestedBarcode={() => setPendingBarcode("")}
              canViewCost={user.permissions.includes("VIEW_COST")}
              canExport={user.permissions.includes("EXPORT")}
              editProductQuery={pendingProductEditQuery}
              clearEditProductQuery={() => setPendingProductEditQuery("")}
              scannedProductQuery={scannedProductQuery}
              clearScannedProductQuery={() => setScannedProductQuery("")}
              onEditProductByQuery={requestProductEdit}
            />
          )}
          {screen === "weight-labels" && <WeightLabelsScreen products={products} />}
          {screen === "inventory" && (
            <InventoryScreen
              products={products}
              shift={shift}
              refresh={refreshProducts}
              storeName={storeName}
              receiptBranding={receiptBranding}
              canViewCost={user.permissions.includes("VIEW_COST")}
              onEditProductByQuery={requestProductEdit}
            />
          )}
          {screen === "reorder" && <ReorderListScreen storeName={storeName} />}
          {screen === "partners" && <PartnersScreen storeName={storeName} />}
          {screen === "invoices" && (
            <InvoicesScreen
              products={products}
              storeName={storeName}
              receiptBranding={receiptBranding}
              refreshProducts={refreshProducts}
              user={user}
            />
          )}
          {screen === "expenses" && (
            <ExpensesScreen shift={shift} refresh={refreshShift} />
          )}
          {screen === "reports" && <ReportsScreen storeName={storeName} shift={shift} />}
          {screen === "shift" && (
            <ShiftScreen
              shift={shift}
              config={config}
              user={user}
              canExport={user.permissions.includes("EXPORT")}
              refresh={refreshShift}
            />
          )}
          {screen === "settings" && (
            <SettingsScreen
              currentUser={currentUser}
              terminalId={config.terminalId}
              onUserUpdated={setCurrentUser}
              taxSettings={taxSettings}
              onTaxSettingsChange={updateTaxSettings}
              onSettingsChange={(next) => {
                setStoreName(next.storeName);
                setReceiptBranding(next);
              }}
              onDataReset={() => {
                localStorage.removeItem(DRAFT_KEY);
                localStorage.removeItem(PENDING_KEY);
                localStorage.removeItem(PENDING_RECEIPT_SCAN_KEY);
                onLogout();
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function LegacyWorkspace({
  user,
  config,
  onLogout,
}: {
  user: User;
  config: Config;
  onLogout: () => void;
}): ReactNode {
  const [screen, setScreen] = useState<Screen>("pos");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [shift, setShift] = useState<Shift | null>(null);
  const [online, setOnline] = useState(true);
  const [storeName, setStoreName] = useState("الشيماء");
  useEffect(() => {
    void invoke<{ storeName: string }>({ operation: "store.info" }).then((r) => setStoreName(r.storeName)).catch(() => {});
  }, []);
  const loadCatalogProducts = useCallback(async (query = "", cursor?: string): Promise<CatalogPage> => {
    const result = await invoke<CatalogPage>({
      operation: "catalog.list",
      payload: { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}), limit: 200 },
    });
    return result;
  }, []);
  const refreshProducts = useCallback(async () => {
    const page = await loadCatalogProducts();
    setProducts(page.products);
    return page.products;
  }, [loadCatalogProducts]);
  const lookupProducts = useCallback(
    async (query: string, cursor?: string) => loadCatalogProducts(query, cursor),
    [loadCatalogProducts],
  );
  const refreshShift = useCallback(async () => {
    const result = await invoke<{ shift: Shift | null }>({
      operation: "shifts.current",
    });
    setShift(result.shift);
  }, []);
  useEffect(() => {
    void Promise.all([refreshProducts(), refreshShift()]).catch(() =>
      setOnline(false),
    );
    const timer = window.setInterval(() => {
      void invoke({ operation: "health" })
        .then(() => setOnline(true))
        .catch(() => setOnline(false));
    }, 10_000);
    return () => clearInterval(timer);
  }, [refreshProducts, refreshShift]);
  async function logout(): Promise<void> {
    try {
      await invoke({ operation: "logout" });
    } finally {
      onLogout();
    }
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <span className="leaf">⌁</span>
          <div>
            <b>{storeName || "نبتة"}</b>
            <small>{storeName ? "نظام نبتة لإدارة المبيعات" : "متجرك، في مكان واحد"}</small>
          </div>
        </div>
        <nav>
          {(
            [
              ["pos", "نقطة البيع", "◫"],
              ["products", "الأصناف", "◇"],
              ["inventory", "المخزون", "▤"],
              ["invoices", "الفواتير", "≡"],
              ["reports", "التقارير", "▥"],
              ["shift", "الوردية", "◷"],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              className={screen === id ? "active" : ""}
              onClick={() => setScreen(id)}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-user">
          <b>{user.displayName}</b>
          <small>{user.role}</small>
          <button onClick={() => void logout()}>خروج</button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            {screen === "pos"
              ? "نقطة البيع"
              : screen === "products"
                ? "الأصناف"
                : screen === "inventory"
                  ? "المخزون"
                  : screen === "invoices"
                    ? "الفواتير"
                    : screen === "reports"
                      ? "التقارير"
                      : "الوردية"}
          </span>
          <span className={online ? "online" : "disconnected"}>
            ● {online ? "الخادم متصل" : "الخادم غير متاح"}
          </span>
        </header>
        <main className="content">
          {screen === "pos" && (
            <PosScreen
              products={products}
              shift={shift}
              online={online}
              refreshProducts={refreshProducts}
              lookupProducts={lookupProducts}
              refreshShift={refreshShift}
              storeName={storeName}
              onOpenShift={() => setScreen("shift")}
            />
          )}
          {screen === "products" && (
            <ProductsScreen products={products} refresh={refreshProducts} canViewCost={user.permissions.includes("VIEW_COST")} canExport={user.permissions.includes("EXPORT")} />
          )}
          {screen === "inventory" && (
            <InventoryScreen
              products={products}
              shift={shift}
              refresh={refreshProducts}
            />
          )}
          {screen === "invoices" && (
            <InvoicesScreen
              products={products}
              storeName={storeName}
              receiptBranding={{
                logoDataUrl: "",
                receiptPhone: "",
                whatsappPhone: "",
                socialHandle: "",
                receiptFooter: "شكراً لزيارتكم",
              }}
              refreshProducts={refreshProducts}
              user={user}
            />
          )}
          {screen === "reports" && <ReportsScreen />}
          {screen === "shift" && (
            <ShiftScreen
              shift={shift}
              config={config}
              user={user}
              canExport={user.permissions.includes("EXPORT")}
              refresh={refreshShift}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const [user, setUser] = useState<User | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(savedTheme);
  const [config, setConfig] = useState<Config>({
    serverUrl: "http://127.0.0.1:17443",
    certificateFingerprint: "",
  });
  const [bootState, setBootState] = useState<"starting" | "ready" | "error">(
    "starting",
  );
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const restoreBackupAndStart = useCallback(async () => {
    setRecoveryBusy(true);
    try {
      const result = await invoke<{ cancelled: boolean; restored?: boolean }>({ operation: "host.recovery.restore" });
      if (result.restored) setBootAttempt((value) => value + 1);
    } catch (cause) {
      setBootError(errorMessage(cause));
    } finally {
      setRecoveryBusy(false);
    }
  }, []);
  useEffect(() => {
    void invoke<Config>({ operation: "config.get" })
      .then(setConfig)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Browser storage can be disabled without affecting the application.
    }
  }, [theme]);
  useEffect(() => {
    let active = true;
    void (async () => {
      setBootState("starting");
      setBootError("");
      try {
        await invoke({ operation: "host.start" });
        await invoke<Health>({ operation: "health" });
        if (active) setBootState("ready");
      } catch (cause) {
        if (active) {
          setBootError(errorMessage(cause));
          setBootState("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [bootAttempt]);
  // Kept for backwards-compatible source builds; none of these screens is reachable in local mode.
  void ManualConnectionSetup;
  void ConnectionSetup;
  void OwnerSetup;
  void ConnectionSettings;
  if (bootState === "starting")
    return (
      <Centered
        title="جارٍ تجهيز نبتة"
        subtitle="يتم فتح بيانات المتجر المحلية لأول مرة."
      >
        <div className="connection-discovery">
          <div className="spinner" />
          <p>لحظات من فضلك…</p>
        </div>
      </Centered>
    );
  if (bootState === "error")
    return (
      <Centered
        title="تعذر تشغيل بيانات نبتة"
        subtitle="لم يتم فتح البيانات المحلية بعد."
      >
        <div className="connection-discovery">
          <p className="error">{bootError}</p>
          <button
            type="button"
            onClick={() => setBootAttempt((value) => value + 1)}
            disabled={recoveryBusy}
          >
            إعادة المحاولة
          </button>
          <button
            type="button"
            onClick={() => void restoreBackupAndStart()}
            disabled={recoveryBusy}
          >
            {recoveryBusy ? "جارٍ الاستعادة…" : "استعادة نسخة احتياطية وتشغيل"}
          </button>
          <p className="muted">يتم فحص النسخة أولًا، والاحتفاظ بالبيانات الحالية في مجلد منفصل.</p>
        </div>
      </Centered>
    );
  if (!user)
    return (
      <Login
        terminalId={config.terminalId}
        onLogin={setUser}
        theme={theme}
        onThemeChange={setTheme}
      />
    );
  return (
    <Workspace
      user={user}
      config={config}
      onLogout={() => setUser(null)}
      theme={theme}
      onThemeChange={setTheme}
    />
  );
}
