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
  DiscoveredServer,
  HardwareSettings,
  InvoiceDetailResponse,
  InvoiceKind,
  InvoiceSummaryItem,
  PartnerListDocumentRequest,
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

type Screen =
  | "pos"
  | "products"
  | "inventory"
  | "reorder"
  | "partners"
  | "invoices"
  | "reports"
  | "shift"
  | "expenses"
  | "settings";
interface Config {
  serverUrl: string;
  terminalId?: string;
  certificateFingerprint: string;
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
}
interface ReceiptLineDraft {
  productId: string;
  qty: string;
  cost: string;
  lot: string;
  expires: string;
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
  labelPaperSize: "58x30",
  labelTemplate: "STANDARD",
  receiptPrinterName: "Xprinter XP-Q808K USB",
  receiptPaperWidth: "80",
  autoPrintReceipt: false,
  cashDrawerEnabled: false,
  cashDrawerPin: "2",
};

function savedTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
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
  if (/^NABTA-[A-Z0-9-]+$/i.test(barcode)) return "باركود داخلي";
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
): Promise<{ printerName: string }> {
  return invoke({
    operation: "hardware.label.print",
    payload: { nameAr: name, barcode, priceMinor, copies },
  });
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

function PosScreen({
  products,
  shift,
  online,
  refreshProducts,
  lookupProducts,
  refreshShift,
  storeName,
  branding,
  onOpenShift,
  onUnregisteredBarcode = () => undefined,
  onPurchaseScan = (barcode: string) =>
    window.dispatchEvent(
      new CustomEvent("nabta:purchase-scan", { detail: barcode }),
    ),
}: {
  products: CatalogProduct[];
  shift: Shift | null;
  online: boolean;
  /** Reloads the complete cached catalog after a stock-changing operation. */
  refreshProducts: () => Promise<CatalogProduct[]>;
  /** Looks up a barcode without replacing the on-screen catalog. */
  lookupProducts: (query: string) => Promise<CatalogProduct[]>;
  refreshShift: () => Promise<void>;
  storeName: string;
  branding?: ReceiptBranding | undefined;
  onOpenShift: () => void;
  onUnregisteredBarcode?: (barcode: string) => void;
  onPurchaseScan?: (barcode: string) => void;
}): ReactNode {
  const [cart, setCart] = useState<CartLine[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "[]") as CartLine[];
    } catch {
      return [];
    }
  });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("الكل");
  const [catalogPage, setCatalogPage] = useState(0);
  const [discount, setDiscount] = useState("0.00");
  const [dialog, setDialog] = useState<{
    quote: QuoteResponse;
    method: "CASH" | "CARD" | "MIXED" | "CREDIT";
  } | null>(null);
  const [customers, setCustomers] = useState<Partner[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [weightTarget, setWeightTarget] = useState<CatalogProduct | null>(null);
  const [weightInput, setWeightInput] = useState("0.250");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<SaleResponse | null>(null);
  const [unknownBarcode, setUnknownBarcode] = useState("");
  const [pendingScan, setPendingScan] = useState("");
  const [salesSheetOpen, setSalesSheetOpen] = useState(() => cart.length > 0);
  const [hardware, setHardware] = useState<HardwareSettings>(DEFAULT_HARDWARE);
  const [paymentPreparing, setPaymentPreparing] = useState(false);
  const [salePosting, setSalePosting] = useState(false);
  const [receiptPrinting, setReceiptPrinting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const scanHandlerRef = useRef<
    (barcode: string, source: "HID" | "SERIAL") => Promise<void>
  >(async () => undefined);
  const recentScanRef = useRef<{ barcode: string; at: number } | null>(null);
  // Refs change synchronously, unlike React state.  They close the small gap
  // between two very fast clicks before the disabled button is re-rendered.
  const paymentPreparingRef = useRef(false);
  const salePostingRef = useRef(false);
  const receiptPrintingRef = useRef(false);
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(cart));
  }, [cart]);
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
  // A cashier can scan and edit the cart while the local catalog contains
  // thousands of items.  Filtering belongs only to catalog inputs; without
  // this memo the same full scan runs again for every cart, payment and modal
  // state update, which makes the register feel sluggish.
  const visible = useMemo(
    () =>
      products.filter(
        (product) =>
          (category === "الكل" || product.category === category) &&
          (!query ||
            [product.nameAr, ...product.barcodes].some((value) =>
              value.includes(query),
            )),
      ),
    [category, products, query],
  );
  const catalogPageCount = Math.max(
    1,
    Math.ceil(visible.length / POS_GRID_PAGE_SIZE),
  );
  const activeCatalogPage = Math.min(catalogPage, catalogPageCount - 1);
  const visiblePage = visible.slice(
    activeCatalogPage * POS_GRID_PAGE_SIZE,
    (activeCatalogPage + 1) * POS_GRID_PAGE_SIZE,
  );
  useEffect(() => setCatalogPage(0), [query, category]);
  const subtotal = cart.reduce(
    (sum, line) =>
      sum + Math.round((line.product.priceMinor * line.qtyMilli) / 1000),
    0,
  );

  function addWithQty(product: CatalogProduct, qtyMilli: number): void {
    if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) {
      setNotice("الكمية غير صحيحة");
      return;
    }
    setCart((current) => {
      const found = current.find((line) => line.product.id === product.id);
      const nextQty = (found?.qtyMilli ?? 0) + qtyMilli;
      if (nextQty > product.availableQtyMilli) {
        setNotice("المخزون الظاهر غير كافٍ؛ سيعيد الخادم التحقق عند الإتمام");
        return current;
      }
      return found
        ? current.map((line) =>
            line.product.id === product.id
              ? { ...line, qtyMilli: nextQty }
              : line,
          )
        : [...current, { product, qtyMilli }];
    });
  }

  function add(product: CatalogProduct): void {
    setSalesSheetOpen(true);
    if (product.unitKind === "WEIGHT") {
      setWeightTarget(product);
      setWeightInput("0.250");
      return;
    }
    addWithQty(product, 1000);
  }

  function changeCartQty(product: CatalogProduct, direction: 1 | -1): void {
    const delta = product.unitKind === "WEIGHT" ? 250 : 1000;
    setCart((current) =>
      current.flatMap((line) => {
        if (line.product.id !== product.id) return [line];
        const nextQty = line.qtyMilli + direction * delta;
        return nextQty > 0 && nextQty <= product.availableQtyMilli
          ? [{ ...line, qtyMilli: nextQty }]
          : nextQty <= 0
            ? []
            : [line];
      }),
    );
  }

  function confirmWeight(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!weightTarget) return;
    const normalized = weightInput
      .trim()
      .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace("٫", ".");
    if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) {
      setNotice("اكتب وزنًا حتى 0.001 كجم");
      return;
    }
    addWithQty(weightTarget, Math.round(Number(normalized) * 1000));
    setWeightTarget(null);
  }

  async function addSaleBarcode(barcode: string): Promise<boolean> {
    let exact = products.find((product) => product.barcodes.includes(barcode));
    if (!exact)
      exact = (await lookupProducts(barcode)).find((product) =>
        product.barcodes.includes(barcode),
      );
    if (exact) {
      add(exact);
      setQuery("");
      playScanTone("known");
      return true;
    }
    playScanTone("unknown");
    setUnknownBarcode(barcode);
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
    setNotice(`تمت قراءة ${barcodeKind(normalized)}: ${normalized}`);
    if (!salesSheetOpen && cart.length === 0) {
      setPendingScan(normalized);
      return;
    }
    await addSaleBarcode(normalized);
  }

  async function scan(): Promise<void> {
    const barcode = query.trim();
    if (!barcode) return;
    setQuery("");
    await handleBarcode(barcode, "HID");
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
          lines: cart.map((line) => ({
            productId: line.product.id,
            qtyMilli: line.qtyMilli,
          })),
        },
      });
      const changed = quote.lines.some(
        (line) =>
          cart.find((cartLine) => cartLine.product.id === line.productId)
            ?.product.priceMinor !== line.unitPriceMinor,
      );
      if (
        changed &&
        !window.confirm(
          "تغير سعر صنف واحد أو أكثر. راجع الإجمالي الجديد ثم وافق للمتابعة.",
        )
      )
        return;
      setCustomerId(customers[0]?.id ?? "");
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
      const payments =
        dialog.method === "CASH"
          ? [
              {
                method: "CASH" as const,
                amountMinor: dialog.quote.totalMinor,
                tenderedMinor: minorFromInput(String(data.get("received"))),
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
      setReceipt(sale);
      setDiscount("0.00");
      if (hardware.autoPrintReceipt && hardware.receiptPrinterName) {
        void printReceiptForSale(sale, false).catch((cause) =>
          setNotice(
            `تم تسجيل الفاتورة، لكن تعذرت طباعتها: ${errorMessage(cause)}`,
          ),
        );
      }
      await Promise.all([refreshProducts(), refreshShift()]);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      salePostingRef.current = false;
      setSalePosting(false);
    }
  }

  useEffect(() => {
    scanHandlerRef.current = handleBarcode;
  });

  useEffect(() => {
    let buffer = "";
    let startedAt = 0;
    let lastKeyAt = 0;
    const terminator = hardware.scannerTerminator === "ENTER" ? "Enter" : "Tab";
    function isEditable(target: EventTarget | null): boolean {
      const element = target instanceof HTMLElement ? target : null;
      return Boolean(
        element?.closest("input, textarea, select, [contenteditable='true']"),
      );
    }
    function handleHid(event: KeyboardEvent): void {
      if (isEditable(event.target)) return;
      if (event.key === terminator && buffer.length >= 4) {
        const barcode = buffer;
        const elapsed = Date.now() - startedAt;
        buffer = "";
        startedAt = 0;
        lastKeyAt = 0;
        if (elapsed <= 1_500) {
          event.preventDefault();
          void scanHandlerRef.current(barcode, "HID");
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
      void scanHandlerRef.current(scan.barcode, scan.source);
    });
    window.addEventListener("keydown", handleHid, true);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", handleHid, true);
    };
  }, [hardware.scannerTerminator]);

  async function printReceiptForSale(sale: SaleResponse, announce = true): Promise<void> {
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
        payload: { storeName, branding, sale },
      });
      if (announce) setNotice(`أُرسل الإيصال إلى ${hardware.receiptPrinterName}.`);
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
      if (event.key === "F2") {
        event.preventDefault();
        searchRef.current?.focus();
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
      <PageHead
        title="نقطة البيع"
        subtitle="امسح الباركود، راجع السلة، ثم اترك الخادم يتحقق ويصدر الفاتورة."
      />
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
      <div className="pos-layout">
        <section className="catalog-area">
          <div className="search">
            <span>⌁</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key ===
                  (hardware.scannerTerminator === "ENTER" ? "Enter" : "Tab")
                ) {
                  event.preventDefault();
                  void scan();
                }
              }}
              placeholder="ابحث بالاسم أو امسح الباركود… F2"
              autoFocus
            />
          </div>
          <div className="tabs">
            {categories.map((item) => (
              <button
                key={item}
                className={category === item ? "selected" : ""}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="product-grid">
            {visiblePage.map((product) => (
              <button
                key={product.id}
                className="product-card"
                onClick={() => add(product)}
                disabled={product.availableQtyMilli <= 0}
              >
                <span className="stock">
                  {formatQty(product.availableQtyMilli, product.unitKind)}
                </span>
                <span className="product-art">
                  {product.unitKind === "WEIGHT" ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
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
                    >
                      <rect x="2" y="7" width="20" height="14" rx="2" />
                      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                    </svg>
                  )}
                  {product.imageBarcode && (
                    <img
                      className="product-image"
                      src={`nabta-media://product/${encodeURIComponent(product.imageBarcode)}`}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                </span>
                <b>{product.nameAr}</b>
                <small>{product.category}</small>
                <strong>
                  {formatMoney(product.priceMinor)}
                  {product.unitKind === "WEIGHT" ? " / كجم" : ""}
                </strong>
              </button>
            ))}
          </div>
          {visible.length > POS_GRID_PAGE_SIZE && (
            <nav className="catalog-pagination" aria-label="تصفح الأصناف">
              <span>
                عرض {activeCatalogPage * POS_GRID_PAGE_SIZE + 1}
                {"–"}
                {Math.min((activeCatalogPage + 1) * POS_GRID_PAGE_SIZE, visible.length)} من {visible.length}
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
        <aside className="cart panel">
          <header>
            <div>
              <h2>الفاتورة الحالية</h2>
              <small>{shift ? "الوردية مفتوحة" : "افتح وردية للبدء"}</small>
            </div>
            <span className="tag">{cart.length} أصناف</span>
          </header>
          <div className="cart-lines">
            {cart.length === 0 ? (
              <div className="empty">
                امسح باركودًا أو أضف أول صنف من القائمة.
              </div>
            ) : (
              <div className="cart-sheet">
                <div className="cart-sheet-head">
                  <span>الصنف</span>
                  <span>الكمية</span>
                  <span>سعر الوحدة</span>
                  <span>الإجمالي</span>
                </div>
                {cart.map((line) => (
                  <div className="cart-line" key={line.product.id}>
                    <div className="cart-product">
                      <b>{line.product.nameAr}</b>
                      <button
                        aria-label="حذف الصنف"
                        onClick={() =>
                          setCart((items) =>
                            items.filter(
                              (item) => item.product.id !== line.product.id,
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                    <div className="quantity-actions">
                      <button
                        aria-label="تقليل الكمية"
                        onClick={() => changeCartQty(line.product, -1)}
                      >
                        −
                      </button>
                      <span>
                        {formatQty(line.qtyMilli, line.product.unitKind)}
                      </span>
                      <button
                        aria-label="زيادة الكمية"
                        onClick={() => changeCartQty(line.product, 1)}
                      >
                        +
                      </button>
                    </div>
                    <span>{formatMoney(line.product.priceMinor)}</span>
                    <strong>
                      {formatMoney(
                        Math.round(
                          (line.product.priceMinor * line.qtyMilli) / 1000,
                        ),
                      )}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="cart-summary">
            <p>
              <span>إجمالي الأصناف</span>
              <b>{formatMoney(subtotal)}</b>
            </p>
            <Field label="خصم الفاتورة">
              <input
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
                inputMode="decimal"
                dir="ltr"
              />
            </Field>
            <p className="payable">
              <span>المطلوب</span>
              <strong>
                {formatMoney(
                  Math.max(
                    0,
                    subtotal -
                      (() => {
                        try {
                          return minorFromInput(discount);
                        } catch {
                          return 0;
                        }
                      })(),
                  ),
                )}
              </strong>
            </p>
            <button
              className={`primary checkout${shift ? "" : " open-shift-checkout"}`}
              disabled={!online || cart.length === 0 || paymentPreparing || salePosting}
              onClick={() => {
                if (!shift) {
                  onOpenShift();
                  return;
                }
                void preparePayment();
              }}
            >
              {paymentPreparing ? "جارٍ تجهيز الدفع..." : shift ? "إتمام البيع" : "فتح وردية للمتابعة"} <kbd>F4</kbd>
            </button>
          </div>
        </aside>
      </div>
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
                  onPurchaseScan(barcode);
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
                  onUnregisteredBarcode(unknownBarcode);
                  setUnknownBarcode("");
                }}
              >
                إضافة صنف جديد
              </button>
            </div>
          </section>
        </div>
      )}
      {weightTarget && (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={confirmWeight}>
            <h2>كمية موزونة</h2>
            <p className="hint">
              {weightTarget.nameAr} — أدخل الكمية بالكيلو حتى 0.001.
            </p>
            <Field label="الكمية بالكيلو">
              <input
                aria-label="كمية بالكيلو"
                value={weightInput}
                onChange={(event) => setWeightInput(event.target.value)}
                inputMode="decimal"
                dir="ltr"
                autoFocus
                required
              />
            </Field>
            <div className="modal-actions">
              <button type="button" onClick={() => setWeightTarget(null)}>
                إلغاء
              </button>
              <button className="primary">إضافة للسلة</button>
            </div>
          </form>
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
                onClick={() => setDialog({ ...dialog, method: "CASH" })}
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
              <Field label="المبلغ المستلم">
                <input
                  name="received"
                  defaultValue={(dialog.quote.totalMinor / 100).toFixed(2)}
                  inputMode="decimal"
                  dir="ltr"
                  required
                />
              </Field>
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
            <p className="hint">
              البطاقة هنا تسجيل محاسبي فقط؛ والآجل يخضع لحد ائتمان العميل.
            </p>
            <div className="modal-actions">
              <button type="button" disabled={salePosting} onClick={() => setDialog(null)}>
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

function ProductsScreen({
  products,
  refresh,
  suggestedBarcode,
  clearSuggestedBarcode = () => undefined,
  canViewCost = false,
  canExport = false,
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
  onProductCreated?: (barcode: string) => void;
}): ReactNode {
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState("");
  const [barcode, setBarcode] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>(products);
  const [resultsPage, setResultsPage] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [quickRestockProduct, setQuickRestockProduct] =
    useState<CatalogProduct | null>(null);
  const [editingProduct, setEditingProduct] = useState<CatalogProduct | null>(null);
  const [labelPrintProduct, setLabelPrintProduct] = useState<CatalogProduct | null>(null);
  const [productMenu, setProductMenu] = useState<{
    product: CatalogProduct;
    x: number;
    y: number;
  } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
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
  useEffect(() => setResultsPage(0), [productQuery, products]);
  const searchResultsPageCount = Math.max(
    1,
    Math.ceil(searchResults.length / PRODUCTS_TABLE_PAGE_SIZE),
  );
  const activeResultsPage = Math.min(resultsPage, searchResultsPageCount - 1);
  const displayedSearchResults = searchResults.slice(
    activeResultsPage * PRODUCTS_TABLE_PAGE_SIZE,
    (activeResultsPage + 1) * PRODUCTS_TABLE_PAGE_SIZE,
  );

  async function quickRestock(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!quickRestockProduct) return;
    const data = new FormData(event.currentTarget);
    try {
      const qtyMilli = qtyFromInput(String(data.get("quantity")));
      if (qtyMilli <= 0)
        throw new Error("أدخل كمية أكبر من صفر");
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
                unitCostMinor: minorFromInput(String(data.get("cost"))),
                retailPriceMinor: minorFromInput(String(data.get("retailPrice"))),
                ...(canViewCost ? { wholesalePriceMinor: minorFromInput(String(data.get("wholesalePrice"))) } : {}),
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
  async function generateBarcode(): Promise<void> {
    try {
      const result = await invoke<{
        barcode: string;
        symbology: string;
        scope: string;
      }>({ operation: "products.barcode.generate" });
      setBarcode(result.barcode);
      setMessage("تم توليد باركود داخلي فريد. يمكنك طباعته بعد حفظ الصنف.");
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
      setShow(true);
      void fillReference(suggestedBarcode);
    }
  }, [suggestedBarcode]);
  useEffect(() => {
    function scanBarcodeInForm(event: KeyboardEvent): void {
      const target = event.target as HTMLInputElement | null;
      if (show && event.key === "Enter" && target?.name === "barcode") {
        event.preventDefault();
        void fillReference(target.value);
      }
    }
    document.addEventListener("keydown", scanBarcodeInForm);
    return () => document.removeEventListener("keydown", scanBarcodeInForm);
  }, [show]);
  useEffect(() => {
    if (!show) return;
    const timer = window.setTimeout(() => {
      const field = document
        .querySelector<HTMLElement>(".modal input[name=barcode]")
        ?.closest(".field");
      if (!field || field.querySelector(".barcode-generate")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "barcode-generate";
      button.textContent = "توليد باركود داخلي فريد";
      const click = () => {
        void generateBarcode();
      };
      button.addEventListener("click", click);
      field.append(button);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [show]);
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const unitKind = String(data.get("unitKind")) as "PIECE" | "WEIGHT";
      const qtyMilli = qtyFromInput(String(data.get("openingQty")));
      const openingUnitCostMinor = minorFromInput(
        String(data.get("openingCost")),
      );
      const createdBarcode = String(data.get("barcode"));
      const priceMinor = minorFromInput(String(data.get("price")));
      const wholesalePriceMinor = canViewCost
        ? minorFromInput(String(data.get("wholesalePrice")))
        : openingUnitCostMinor;
      const nameAr = String(data.get("nameAr"));
      await invoke({
        operation: "products.create",
        payload: {
          nameAr,
          category: String(data.get("category")),
          unitKind,
          priceMinor,
          wholesalePriceMinor,
          reorderLevelMilli: qtyFromInput(String(data.get("reorder"))),
          barcodes: [createdBarcode],
          openingQtyMilli: qtyMilli,
          openingUnitCostMinor,
        },
      });
      setShow(false);
      setBarcode("");
      clearSuggestedBarcode();
      await refresh();
      setMessage("تم حفظ الصنف والرصيد الافتتاحي في دفتر المخزون.");
      if (suggestedBarcode) onProductCreated(createdBarcode);
      if (
        createdBarcode.startsWith("NABTA-") &&
        window.confirm(
          "تم حفظ الباركود الداخلي. هل تريد طباعة ملصق الصنف الآن؟",
        )
      )
        void printProductLabel(nameAr, createdBarcode, priceMinor).catch((cause) =>
          setMessage(errorMessage(cause)),
        );
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function exportProducts(mode: "PUBLIC" | "INTERNAL", productIds = searchResults.map((product) => product.id)): Promise<void> {
    try {
      if (!productIds.length) throw new Error("لا توجد أصناف مطابقة لتصديرها");
      const result = await invoke<{ cancelled: boolean; path?: string; itemCount: number }>({ operation: "products.export", payload: { mode, productIds } });
      setMessage(result.cancelled
        ? "تم إلغاء حفظ ملف Excel."
        : `تم حفظ ملف Excel (${result.itemCount} صنف): ${result.path}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }
  async function printSearchedProductLabel(product: CatalogProduct, copies = 1): Promise<void> {
    const barcode = product.barcodes[0];
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
      const result = await printProductLabel(product.nameAr, barcode, product.priceMinor, copies);
      setMessage(`أُرسل ${copies} ملصق لصنف «${product.nameAr}» إلى ${result.printerName}.`);
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
      const availableQtyMilli = qtyFromInput(String(data.get("availableQuantity")));
      if (editingProduct.unitKind === "PIECE" && availableQtyMilli % 1000 !== 0) {
        throw new Error("كمية صنف القطعة يجب أن تكون عدداً صحيحاً");
      }
      await invoke({
        operation: "products.update",
        payload: {
          productId: editingProduct.id,
          nameAr: String(data.get("nameAr")).trim(),
          description: String(data.get("description")).trim(),
          priceMinor: minorFromInput(String(data.get("price"))),
          ...(canViewCost ? { wholesalePriceMinor: minorFromInput(String(data.get("wholesalePrice"))) } : {}),
          availableQtyMilli,
          expectedStockVersion: editingProduct.version,
        },
      });
      await refresh();
      setEditingProduct(null);
      setMessage(`تم حفظ بيانات «${editingProduct.nameAr}» وتوثيق أي تعديل في الكمية بحركة جرد.`);
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
      await invoke({
        operation: "products.archive",
        payload: { productId: product.id },
      });
      await refresh();
      setMessage(`تم حذف «${product.nameAr}» من قائمة الأصناف مع الاحتفاظ بسجل الحركات السابق.`);
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
      const result = await invoke<{ importedCount: number }>({
        operation: "products.import",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          request: { csv, preview: false },
        },
      });
      await refresh();
      setMessage("تم استيراد " + result.importedCount + " صنفاً بعد التحقق.");
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
    dialog.innerHTML = `<form method="dialog"><header><div><h2></h2><p>يتغير سعر البيع للمبيعات الجديدة فقط؛ الفواتير السابقة لا تتغير.</p></div><button type="button" class="label-editor-close" aria-label="إغلاق">×</button></header><label>سعر البيع بالجنيه<input name="price" inputmode="decimal" dir="ltr" required></label>${wholesaleInput}<p class="label-editor-code" dir="ltr"></p><footer><button type="button" class="label-editor-save">حفظ السعر</button><button type="button" class="primary label-editor-print">حفظ وطباعة ملصق</button></footer><p class="label-editor-status" role="alert"></p></form>`;
    dialog.querySelector("h2")!.textContent = product.nameAr;
    const price = dialog.querySelector<HTMLInputElement>("input[name=price]")!;
    price.value = (product.priceMinor / 100).toFixed(2);
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
          await printProductLabel(product.nameAr, barcode, priceMinor);
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
            <button onClick={() => importRef.current?.click()}>
              استيراد CSV
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => void importProducts(event)}
            />
            <button
              className="primary"
              onClick={() => {
                setBarcode("");
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
      <section className="panel table-wrap">
        <div className="product-search-toolbar">
          <label className="product-search-field">
            <span>بحث سريع في الأصناف</span>
            <input
              aria-label="ابحث عن صنف بالاسم أو الباركود"
              value={productQuery}
              onChange={(event) => setProductQuery(event.target.value)}
              placeholder="اكتب اسم الصنف أو امسح الباركود…"
              autoComplete="off"
            />
          </label>
          <p>
            {isSearching
              ? "جارٍ البحث…"
              : productQuery.trim()
                ? `${searchResults.length} نتيجة`
                : "ابحث لمعرفة الكمية المتاحة أو إضافة توريد سريع."}
          </p>
        </div>
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
                <td>{product.unitKind === "PIECE" ? "قطعة" : "كيلو"}</td>
                <td>{formatMoney(product.priceMinor)}</td>
                {canViewCost && <td>{formatMoney(product.wholesalePriceMinor ?? 0)}</td>}
                <td>
                  {formatQty(product.availableQtyMilli, product.unitKind)}
                </td>
                <td>
                  <span className={`availability ${availability.tone}`}>
                    {availability.label}
                  </span>
                </td>
                <td>
                  <div className="product-row-actions">
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
            {!isSearching && searchResults.length === 0 && (
              <tr>
                <td colSpan={canViewCost ? 8 : 7} className="table-empty">
                  لا توجد أصناف مطابقة. جرّب الاسم أو الباركود كاملاً.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {searchResults.length > PRODUCTS_TABLE_PAGE_SIZE && (
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
          <button type="button" role="menuitem" onClick={() => { setQuickRestockProduct(productMenu.product); setProductMenu(null); }}>+ {"\u0625\u0636\u0627\u0641\u0629 \u0643\u0645\u064a\u0629"}</button>
          <button type="button" role="menuitem" onClick={() => { openLabelEditor(productMenu.product); setProductMenu(null); }}>{"\u0633\u0639\u0631 / \u0637\u0628\u0627\u0639\u0629"}</button>
          <button type="button" role="menuitem" onClick={() => { setLabelPrintProduct(productMenu.product); setProductMenu(null); }}>{"\u0637\u0628\u0627\u0639\u0629 \u0628\u0627\u0631\u0643\u0648\u062f"}</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { void archiveProduct(productMenu.product); setProductMenu(null); }}>{"\u062d\u0630\u0641 \u0627\u0644\u0635\u0646\u0641"}</button>
        </div>
      )}
      {editingProduct && (
        <div className="modal-backdrop">
          <form className="modal form-grid" onSubmit={(event) => void updateProduct(event)}>
            <h2 className="full">تعديل بيانات الصنف</h2>
            <Field label="اسم الصنف">
              <input name="nameAr" required autoFocus defaultValue={editingProduct.nameAr} />
            </Field>
            <Field label="الباركود">
              <input value={editingProduct.barcodes.join("، ")} dir="ltr" disabled />
            </Field>
            <Field label="سعر البيع المعلن">
              <input name="price" required inputMode="decimal" dir="ltr" defaultValue={(editingProduct.priceMinor / 100).toFixed(2)} />
            </Field>
            {canViewCost && (
              <Field label="سعر الجملة الداخلي">
                <input name="wholesalePrice" required inputMode="decimal" dir="ltr" defaultValue={((editingProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} />
              </Field>
            )}
            <Field label={`الكمية المتاحة (${editingProduct.unitKind === "PIECE" ? "قطعة" : "كيلو"})`}>
              <input name="availableQuantity" required inputMode="decimal" dir="ltr" defaultValue={(editingProduct.availableQtyMilli / 1000).toString()} />
            </Field>
            <Field label="الوصف">
              <textarea name="description" rows={4} defaultValue={editingProduct.description} />
            </Field>
            <p className="hint full">تعديل الكمية يُسجل تلقائياً كحركة جرد للمراجعة، ولا يغيّر الفواتير السابقة.</p>
            <div className="modal-actions full">
              <button type="button" onClick={() => setEditingProduct(null)}>إلغاء</button>
              <button className="primary">حفظ التعديلات</button>
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
              const copies = Number(new FormData(event.currentTarget).get("copies"));
              if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
                setMessage("أدخل عدداً صحيحاً من 1 إلى 100 نسخة.");
                return;
              }
              const product = labelPrintProduct;
              setLabelPrintProduct(null);
              void printSearchedProductLabel(product, copies);
            }}
          >
            <h2 className="full">طباعة باركود الصنف</h2>
            <p className="full">{labelPrintProduct.nameAr}</p>
            <Field label="عدد النسخ المطلوبة">
              <input name="copies" type="number" min="1" max="100" step="1" defaultValue="1" required autoFocus dir="ltr" />
            </Field>
            <div className="modal-actions full">
              <button type="button" onClick={() => setLabelPrintProduct(null)}>إلغاء</button>
              <button className="primary">طباعة</button>
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
            <Field label="الاسم">
              <input name="nameAr" required autoFocus />
            </Field>
            <Field label="الباركود">
              <input
                name="barcode"
                required
                dir="ltr"
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
              />
            </Field>
            <Field label="التصنيف">
              <input name="category" required />
            </Field>
            <Field label="الوحدة">
              <select name="unitKind">
                <option value="PIECE">قطعة</option>
                <option value="WEIGHT">كيلو</option>
              </select>
            </Field>
            <Field label="سعر البيع">
              <input name="price" required inputMode="decimal" dir="ltr" />
            </Field>
            {canViewCost && (
              <Field label="سعر الجملة الداخلي">
                <input name="wholesalePrice" required defaultValue="0.00" inputMode="decimal" dir="ltr" />
              </Field>
            )}
            <Field label="حد الطلب">
              <input
                name="reorder"
                defaultValue="0"
                required
                inputMode="decimal"
                dir="ltr"
              />
            </Field>
            <Field label="كمية افتتاحية">
              <input
                name="openingQty"
                defaultValue="0"
                required
                inputMode="decimal"
                dir="ltr"
              />
            </Field>
            <Field label="تكلفة الوحدة الافتتاحية">
              <input
                name="openingCost"
                defaultValue="0.00"
                required
                inputMode="decimal"
                dir="ltr"
              />
            </Field>
            <div className="modal-actions full">
              <button
                type="button"
                onClick={() => {
                  setShow(false);
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
                placeholder={quickRestockProduct.unitKind === "PIECE" ? "مثال: 12" : "مثال: 1.250"}
              />
            </Field>
            <Field label="تكلفة الوحدة بالجنيه">
              <input name="cost" required defaultValue="0.00" inputMode="decimal" dir="ltr" />
            </Field>
            <Field label="سعر البيع للجمهور بالجنيه">
              <input name="retailPrice" required defaultValue={(quickRestockProduct.priceMinor / 100).toFixed(2)} inputMode="decimal" dir="ltr" />
            </Field>
            {canViewCost && (
              <Field label="سعر الجملة الداخلي بالجنيه">
                <input name="wholesalePrice" required defaultValue={((quickRestockProduct.wholesalePriceMinor ?? 0) / 100).toFixed(2)} inputMode="decimal" dir="ltr" />
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
  suggestedBarcode,
  clearSuggestedBarcode = () => undefined,
  onUnregisteredReceiptBarcode = (barcode: string) =>
    window.dispatchEvent(
      new CustomEvent("nabta:receipt-unknown-barcode", { detail: barcode }),
    ),
}: {
  products: CatalogProduct[];
  shift: Shift | null;
  refresh: () => Promise<CatalogProduct[]>;
  suggestedBarcode?: string;
  clearSuggestedBarcode?: () => void;
  onUnregisteredReceiptBarcode?: (barcode: string) => void;
}): ReactNode {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [sale, setSale] = useState<SaleLookup | null>(null);
  const [returnLineId, setReturnLineId] = useState("");
  const [expiry, setExpiry] = useState<ExpiryLot[]>([]);
  const [section, setSection] = useState<
    "receive" | "count" | "returns" | "expiry"
  >("receive");
  const [receiptLines, setReceiptLines] = useState<ReceiptLineDraft[]>([
    { productId: "", qty: "", cost: "", lot: "", expires: "" },
  ]);
  const [receiptBarcode, setReceiptBarcode] = useState("");
  const [unknownReceiptBarcode, setUnknownReceiptBarcode] = useState("");
  const product = products.find((item) => item.id === productId) ?? products[0];
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
    setReceiptLines((items) => {
      const emptyIndex = items.findIndex((item) => !item.productId);
      if (emptyIndex >= 0)
        return items.map((item, index) =>
          index === emptyIndex ? { ...item, productId: productIdToAdd } : item,
        );
      return [
        ...items,
        { productId: productIdToAdd, qty: "", cost: "", lot: "", expires: "" },
      ];
    });
  }

  function scanReceiptBarcode(value: string): void {
    const barcode = value.trim();
    if (!barcode) return;
    const exact = products.find((item) => item.barcodes.includes(barcode));
    if (exact) {
      addReceiptProduct(exact.id);
      setReceiptBarcode("");
      return;
    }
    setUnknownReceiptBarcode(barcode);
  }

  useEffect(() => {
    const barcode =
      suggestedBarcode || localStorage.getItem(PENDING_RECEIPT_SCAN_KEY) || "";
    if (!barcode) return;
    setSection("receive");
    scanReceiptBarcode(barcode);
    clearSuggestedBarcode();
    localStorage.removeItem(PENDING_RECEIPT_SCAN_KEY);
  }, [suggestedBarcode]);

  async function receive(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const lines = receiptLines.map((line) => {
        const item = products.find(
          (candidate) => candidate.id === line.productId,
        );
        const qtyMilli = qtyFromInput(line.qty);
        if (
          !item ||
          qtyMilli <= 0 ||
          (item.unitKind === "PIECE" && qtyMilli % 1000 !== 0)
        )
          throw new Error("راجع الصنف والكمية في سطور الاستلام");
        return {
          product: item,
          qtyMilli,
          unitCostMinor: minorFromInput(line.cost),
          lotCode: line.lot.trim() || undefined,
          expiresOn: line.expires || undefined,
        };
      });
      if (!lines.length) throw new Error("أضف صنفًا واحدًا على الأقل");
      await invoke({
        operation: "purchases.receive",
        payload: {
          idempotencyKey: crypto.randomUUID(),
          receipt: {
            warehouseId: lines[0]!.product.warehouseId,
            supplierName: String(data.get("supplier")),
            supplierInvoiceNo: String(data.get("invoice") ?? "") || undefined,
            supplyExpensesMinor: minorFromInput(
              String(data.get("expense") || "0"),
            ),
            lines: lines.map((line) => ({
              productId: line.product.id,
              qtyMilli: line.qtyMilli,
              unitCostMinor: line.unitCostMinor,
              lotCode: line.lotCode,
              expiresOn: line.expiresOn,
            })),
          },
        },
      });
      await refresh();
      setReceiptLines([
        { productId: "", qty: "", cost: "", lot: "", expires: "" },
      ]);
      setMessage("تم استلام البضاعة وتحديث التكلفة والدفتر.");
      event.currentTarget.reset();
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

  return (
    <>
      <PageHead
        title="إدارة المخزون"
        subtitle="اختر العملية المطلوبة؛ كل عملية لها مساحة مستقلة وواضحة."
        action={<button onClick={() => void exportCurrentInventory()}>تصدير المخزون إلى Excel</button>}
      />
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
                if (event.key === "Enter") {
                  event.preventDefault();
                  scanReceiptBarcode(receiptBarcode);
                }
              }}
              placeholder="امسح الباركود ثم Enter"
              autoFocus
            />
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
        <section className="panel operation-panel receipt-panel">
          <h2>استلام مشتريات</h2>
          <p className="panel-help">
            أدخل المورد ومصاريف التوريد مرة واحدة، ثم أضف كل الأصناف في الفاتورة
            نفسها.
          </p>
          <form onSubmit={(event) => void receive(event)}>
            <div className="form-grid receipt-meta">
              <Field label="المورد">
                <input name="supplier" required />
              </Field>
              <Field label="رقم فاتورة المورد">
                <input name="invoice" />
              </Field>
              <Field label="مصروفات التوريد">
                <input
                  name="expense"
                  defaultValue="0.00"
                  inputMode="decimal"
                  dir="ltr"
                />
              </Field>
            </div>
            <div className="receipt-sheet">
              <div className="receipt-sheet-head">
                <span>الصنف</span>
                <span>الكمية</span>
                <span>تكلفة الوحدة</span>
                <span>التشغيلة</span>
                <span>الصلاحية</span>
                <span></span>
              </div>
              {receiptLines.map((line, index) => (
                <div className="receipt-sheet-row" key={index}>
                  <SearchableSelect
                    value={line.productId}
                    onChange={(productId) =>
                      setReceiptLines((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, productId }
                            : item,
                        ),
                      )
                    }
                    required
                    options={products.map((item) => ({
                      value: item.id,
                      label: item.nameAr,
                      searchText: item.barcodes.join(" "),
                    }))}
                    placeholder="ابحث عن صنف"
                  />
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
                    placeholder="الكمية"
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
                    placeholder="التكلفة"
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
                    { productId: "", qty: "", cost: "", lot: "", expires: "" },
                  ])
                }
              >
                + إضافة صنف
              </button>
              <button className="primary">ترحيل الاستلام</button>
            </div>
          </form>
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
          <h2>تنبيه الصلاحية — 30 يوماً</h2>
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
      {unknownReceiptBarcode && (
        <div className="modal-backdrop">
          <section className="modal scanner-modal">
            <span className="scanner-icon">⌁</span>
            <h2>باركود غير مسجل</h2>
            <p>
              هذا الباركود غير موجود في قائمة الأصناف. أضفه أولاً ثم سيعود
              تلقائيًا إلى إذن الاستلام.
            </p>
            <div className="modal-actions">
              <button onClick={() => setUnknownReceiptBarcode("")}>
                إلغاء
              </button>
              <button
                className="primary"
                onClick={() => {
                  onUnregisteredReceiptBarcode(unknownReceiptBarcode);
                  setUnknownReceiptBarcode("");
                }}
              >
                إضافة صنف جديد
              </button>
            </div>
          </section>
        </div>
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
                <td>{formatQty(item.reorderLevelMilli, item.unitKind)}</td>
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
        return {
          productId: l.productId,
          qtyMilli,
          unitCostMinor: minorFromInput(l.cost),
          retailPriceMinor: minorFromInput(l.retail),
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
                      <td dir="ltr">{formatQty(line.qtyMilli, line.unitKind)}</td>
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

                    <Field label="سعر التكلفة للوحدة">
                      <input
                        type="text"
                        placeholder="التكلفة (ج.م)"
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
  const [movementType, setMovementType] = useState<
    "EXPENSE" | "DEPOSIT" | "WITHDRAWAL"
  >("EXPENSE");
  const movementLabel =
    movementType === "EXPENSE"
      ? "مصروف"
      : movementType === "DEPOSIT"
        ? "إيداع في الدرج"
        : "سحب من الدرج";
  async function post(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!shift) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await invoke({
        operation: "shifts.cash-movement",
        payload: {
          shiftId: shift.id,
          movement: {
            type: movementType,
            amountMinor: minorFromInput(String(data.get("amount"))),
            reason: String(data.get("reason")),
          },
        },
      });
      form.reset();
      await refresh();
      setMessage(
        movementType === "EXPENSE"
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
        subtitle="سجل الإيجار والكهرباء والرواتب، أو صحّح النقدية بإيداع وسحب موثقين."
      />
      {message && <div className="notice">{message}</div>}
      <div className="subtabs" role="tablist" aria-label="حركة الدرج">
        {(
          [
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
              <Field label="السبب">
                <input
                  name="reason"
                  placeholder={
                    movementType === "EXPENSE"
                      ? "مثال: إيجار شهر أكتوبر"
                      : "سبب الحركة"
                  }
                  minLength={3}
                  required
                />
              </Field>
              <Field label="المبلغ بالجنيه">
                <input name="amount" inputMode="decimal" dir="ltr" required />
              </Field>
              <button className="primary full">تسجيل {movementLabel}</button>
            </form>
          </>
        ) : (
          <div className="empty-state">
            افتح وردية أولاً وحدد رصيد الدرج الافتتاحي قبل تسجيل أي حركة.
          </div>
        )}
      </section>
    </>
  );
}

function SettingsScreen({
  onSettingsChange,
  onDataReset,
}: {
  onSettingsChange: (settings: BranchSettings) => void;
  onDataReset: () => void;
}): ReactNode {
  const [settings, setSettings] = useState<BranchSettings | null>(null);
  const [pendingLogo, setPendingLogo] = useState<string | null>(null);
  const [hardware, setHardware] = useState<HardwareSettings>(DEFAULT_HARDWARE);
  const [printers, setPrinters] = useState<InstalledPrinter[]>([]);
  const [serialDevices, setSerialDevices] = useState<SerialDevice[]>([]);
  const [message, setMessage] = useState("");
  const [devicesBusy, setDevicesBusy] = useState(false);
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
      setSettings(next);
      setPendingLogo(null);
      onSettingsChange(next);
      setMessage("تم حفظ هوية المتجر وتصميم الإيصال وإعدادات البيع.");
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
      labelPaperSize: labelPaperSize(String(data.get("labelPaperSize") ?? "")),
      labelTemplate: labelTemplate(String(data.get("labelTemplate") ?? "")),
      receiptPrinterName: String(data.get("receiptPrinterName") ?? "").trim(),
      receiptPaperWidth:
        String(data.get("receiptPaperWidth")) === "58" ? "58" : "80",
      autoPrintReceipt: data.get("autoPrintReceipt") === "on",
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
      const result = await invoke<{ printerName: string }>({ operation: "hardware.label.test" });
      setMessage(`تم إرسال ملصق الاختبار إلى ${result.printerName}.`);
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
      {settings && (
        <section className="panel operation-panel">
          <h2>هوية المتجر والإيصال</h2>
          <form
            className="settings-form"
            onSubmit={(event) => void save(event)}
          >
            <Field label="اسم السوبر ماركت">
              <input
                name="storeName"
                defaultValue={settings.storeName}
                minLength={2}
                maxLength={160}
                required
              />
            </Field>
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
            <button className="primary">حفظ هوية المتجر والإعدادات</button>
          </form>
        </section>
      )}
      <section className="panel operation-panel device-panel">
        <div className="panel-title-row">
          <div>
            <h2>السكانر والطابعة</h2>
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
            <h3>طابعة ملصقات الباركود</h3>
            <div className="two-columns">
              <Field label="طابعة الملصقات — Xprinter XP-233B">
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
              <Field label="مقاس الملصق">
                <select
                  name="labelPaperSize"
                  value={hardware.labelPaperSize}
                  onChange={(event) => {
                    const selectedSize = labelPaperSize(event.target.value);
                    setHardware({
                      ...hardware,
                      labelPaperSize: selectedSize,
                      labelTemplate: hardware.labelTemplate === "MICRO" ? "STANDARD" : hardware.labelTemplate,
                    });
                  }}
                >
                  {LABEL_PAPER_SIZES.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
                </select>
              </Field>
            </div>
            <div className="label-layout-settings">
              <Field label="تصميم الملصق">
                <select
                  name="labelTemplate"
                  value={hardware.labelTemplate}
                  onChange={(event) => setHardware({ ...hardware, labelTemplate: labelTemplate(event.target.value) })}
                >
                  {LABEL_TEMPLATES.filter((template) => template.value !== "MICRO").map((template) => <option key={template.value} value={template.value}>{template.label} — {template.description}</option>)}
                </select>
              </Field>
              <div className={`label-preview label-preview-${hardware.labelTemplate.toLowerCase()}`} style={{ aspectRatio: hardware.labelPaperSize.replace("x", " / ") }}>
                <b className="label-preview-brand">الشيماء</b>
                <span className="label-preview-rule" />
                <span className="label-preview-bars" aria-label="باركود تجريبي" />
                <em>123456789012</em>
                <div className="label-preview-details"><strong>صنف تجريبي باسم طويل</strong><span>١٢٫٥٠ ج.م</span></div>
              </div>
            </div>
            <p className="hint">
              اختر مقاس الرول فقط ثم احفظ: نبتة يطابقه تلقائيًا مع تعريف Xprinter XP-233B قبل الطباعة. هذه القائمة تستبعد المقاسات الصغيرة التي لا تحفظ مساحة أمان كافية لباركود التجزئة.
            </p>
            <button
              type="button"
              onClick={() => void printLabelTest()}
              disabled={devicesBusy || !hardware.barcodePrinterName}
            >
              طباعة ملصق اختبار
            </button>
            <button type="button" onClick={() => void installBundledDriver("LABEL")} disabled={devicesBusy}>
              تشغيل تعريف XP-233B المضمّن
            </button>
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
      </section>
      <ManagementPanel onDataReset={onDataReset} />
    </>
  );
}

function ManagementPanel({ onDataReset }: { onDataReset: () => void }): ReactNode {
  type Tab = "users" | "audit" | "backup" | "receipt" | "reset";
  type ManagedUser = {
    id: string;
    displayName: string;
    username: string;
    role: "OWNER" | "MANAGER" | "CASHIER" | "STOCK_KEEPER";
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
      await invoke({
        operation: "users.update",
        payload: {
          userId: user.id,
          update: {
            displayName: String(data.get("displayName")),
            role: String(data.get("role")) as ManagedUser["role"],
            active: data.get("active") === "on",
            discountLimitBps: Number(data.get("discountLimitBps")) || 0,
            ...(String(data.get("password") ?? "")
              ? { password: String(data.get("password")) }
              : {}),
          },
        },
      });
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
        payload: { storeName: store.storeName, branding: store, sale },
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
                <b>{user.displayName}</b>
                <small dir="ltr">{user.username}</small>
                <select name="role" defaultValue={user.role}>
                  <option value="OWNER">مالك</option>
                  <option value="MANAGER">مدير</option>
                  <option value="CASHIER">كاشير</option>
                  <option value="STOCK_KEEPER">أمين مخزن</option>
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
}: {
  storeName?: string;
}): ReactNode {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(
        await invoke({ operation: "reports.summary", payload: { from, to } }),
      );
      setMessage("");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }, [from, to]);
  useEffect(() => {
    void load();
  }, [load]);
  const number = (key: string) => Number(data?.[key] ?? 0);
  const summary: ReportSummary = {
    netSalesMinor: number("net_sales_minor"),
    netCogsMinor: number("net_cogs_minor"),
    grossProfitMinor: number("gross_profit_minor"),
    estimatedNetProfitMinor: number("estimated_net_profit_minor"),
    returnsMinor: number("returns_minor"),
    expensesMinor: number("expenses_minor"),
    damagedLossMinor: number("damaged_loss_minor"),
    invoiceCount: number("invoice_count"),
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
  return (
    <>
      <PageHead
        title="التقارير والأرباح"
        subtitle="الفلاتر تعمل بتوقيت القاهرة، والأرقام قابلة للمصالحة مع الدفاتر."
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
          <span>خسارة مرتجع تالف</span>
          <b>{formatMoney(summary.damagedLossMinor)}</b>
        </p>
        <p>
          <span>عدد الفواتير</span>
          <b>{new Intl.NumberFormat("ar-EG").format(summary.invoiceCount)}</b>
        </p>
      </section>
    </>
  );
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
  const [screen, setScreen] = useState<Screen>("pos");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [shift, setShift] = useState<Shift | null>(null);
  const [online, setOnline] = useState(true);
  const [pendingBarcode, setPendingBarcode] = useState("");
  const [resumeReceiptAfterProduct, setResumeReceiptAfterProduct] =
    useState(false);
  const [storeName, setStoreName] = useState("الشيماء");
  const [receiptBranding, setReceiptBranding] =
    useState<ReceiptBranding | undefined>(undefined);
  const [reorderAlerts, setReorderAlerts] =
    useState<ReorderListResponse | null>(null);
  const loadCatalogProducts = useCallback(async (query = "") => {
    const result = await invoke<{ products: CatalogProduct[] }>({
      operation: "catalog.list",
      payload: { ...(query ? { query } : {}) },
    });
    return result.products;
  }, []);
  const refreshProducts = useCallback(async () => {
    const nextProducts = await loadCatalogProducts();
    setProducts(nextProducts);
    return nextProducts;
  }, [loadCatalogProducts]);
  const lookupProducts = useCallback(
    async (query: string) => loadCatalogProducts(query),
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
      setResumeReceiptAfterProduct(true);
      setScreen("products");
    }
    function receiptProductCreated(event: Event): void {
      if (!resumeReceiptAfterProduct) return;
      const barcode = String((event as CustomEvent<string>).detail || "");
      if (!barcode) return;
      localStorage.setItem(PENDING_RECEIPT_SCAN_KEY, barcode);
      setResumeReceiptAfterProduct(false);
      setScreen("inventory");
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
  }, [resumeReceiptAfterProduct]);
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
  const NAV_ICONS: Record<Screen, ReactNode> = {
    pos: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    products: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </svg>
    ),
    inventory: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 8h14M5 12h14M5 16h6" />
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
    ),
    reorder: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 3h2l2.5 12.5h10.8l2-8H7" />
        <circle cx="10" cy="20" r="1.4" />
        <circle cx="17" cy="20" r="1.4" />
      </svg>
    ),
    partners: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    expenses: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
    reports: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    shift: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
    invoices: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    settings: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  };
  const nav: Array<[Screen, string]> = [
    ["pos", "نقطة البيع"],
    ["products", "الأصناف"],
    ["inventory", "المخزون"],
    ...(user.permissions.includes("STOCK_COUNT")
      ? [["reorder", "قائمة الشراء"] as [Screen, string]]
      : []),
    ...(user.permissions.includes("PARTNER_MANAGE")
      ? [["partners", "العلاقات"] as [Screen, string]]
      : []),
    ["invoices", "الفواتير"],
    ...(user.permissions.includes("CASH_MOVE")
      ? [["expenses", "المصروفات"] as [Screen, string]]
      : []),
    ["reports", "التقارير"],
    ["shift", "الوردية"],
    ...(user.permissions.includes("SETTINGS")
      ? [["settings", "الإعدادات"] as [Screen, string]]
      : []),
  ];
  const title = nav.find(([id]) => id === screen)?.[1] ?? "نبتة";
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <span className="leaf" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: 22, height: 22 }}
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
              <path d="M8 12h8M12 8v8" />
            </svg>
          </span>
          <div>
            <b>{storeName}</b>
            <small>متجرك، في مكان واحد</small>
          </div>
        </div>
        <nav>
          {nav.map(([id, label]) => (
            <button
              key={id}
              className={screen === id ? "active" : ""}
              onClick={() => setScreen(id)}
            >
              <span className="nav-icon">{NAV_ICONS[id]}</span>
              <span>{label}</span>
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
          <span>{title}</span>
          <div className="topbar-actions">
            <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
            {user.permissions.includes("STOCK_COUNT") && (
              <button
                type="button"
                className={`notification-bell ${reorderAlerts?.totals.outOfStock ? "critical" : ""}`}
                onClick={() => setScreen("reorder")}
                aria-label="فتح تنبيهات النواقص"
              >
                <span aria-hidden="true">🔔</span>
                <span>تنبيهات المخزون</span>
                {reorderAlerts && reorderAlerts.items.length > 0 && (
                  <b>{reorderAlerts.items.length}</b>
                )}
              </button>
            )}
            <span className={online ? "online" : "disconnected"}>
              {online ? "النظام يعمل" : "النظام غير جاهز"}
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
              onUnregisteredBarcode={(barcode) => {
                setPendingBarcode(barcode);
                setScreen("products");
              }}
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
            />
          )}
          {screen === "inventory" && (
            <InventoryScreen
              products={products}
              shift={shift}
              refresh={refreshProducts}
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
          {screen === "reports" && <ReportsScreen storeName={storeName} />}
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
  const loadCatalogProducts = useCallback(async (query = "") => {
    const result = await invoke<{ products: CatalogProduct[] }>({
      operation: "catalog.list",
      payload: { ...(query ? { query } : {}) },
    });
    return result.products;
  }, []);
  const refreshProducts = useCallback(async () => {
    const nextProducts = await loadCatalogProducts();
    setProducts(nextProducts);
    return nextProducts;
  }, [loadCatalogProducts]);
  const lookupProducts = useCallback(
    async (query: string) => loadCatalogProducts(query),
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
            <b>نبتة</b>
            <small>متجرك، في مكان واحد</small>
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
              storeName="نبتة"
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
              storeName="نبتة"
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
    terminalId: "00000000-0000-4000-8000-000000000003",
    certificateFingerprint: "",
  });
  const [bootState, setBootState] = useState<"starting" | "ready" | "error">(
    "starting",
  );
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
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
          >
            إعادة المحاولة
          </button>
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
