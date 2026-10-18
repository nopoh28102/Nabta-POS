import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from "electron";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import dgram from "node:dgram";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { SerialPort } from "serialport";
import bwipjs from "bwip-js";
import electronUpdater from "electron-updater";
import { barcodeSchema, hardwareSettingsSchema, ipcRequestSchema, type DiscoveredServer, type HardwareSettings, type InventoryExcelExportResponse, type InventoryPeriodicExcelExportResponse, type IpcRequest, type PartnerListDocumentRequest, type ProductExcelExportResponse, type ProductLabelBatchPrintRequest, type ProductLabelPrintRequest, type PurchaseReceiptPrintRequest, type ReceiptPrintRequest, type ReorderListDocumentRequest, type ReportPdfExportRequest, type ShiftHistoryExcelExportResponse } from "@nabta/contracts";
import { createInventoryPeriodicWorkbook, createInventoryWorkbook, createProductsWorkbook, createShiftsWorkbook } from "./workbooks.js";
import { createLabelLayout, createLabelRasterHtml, createTsplGapCalibrationJob, createTsplNativeBarcodeJob, createTsplRasterJob, encodeXp233bTsplBitmap, type LabelPrinterProfile } from "./printing/label-engine.js";
import { formatQtyForReceipt, receiptHtml } from "./printing/receipt-engine.js";
import { WindowsRawSpooler } from "./printing/raw-spooler.js";

interface DesktopConfig {
  serverUrl: string;
  terminalId?: string;
  certificateFingerprint: string;
}

const LOCAL_SERVER_PORT = 17443;
const LOCAL_SERVER_URL = `http://127.0.0.1:${LOCAL_SERVER_PORT}`;
const LOCAL_TERMINAL_ID = "00000000-0000-4000-8000-000000000003";
const LOCAL_CONFIG: DesktopConfig = { serverUrl: LOCAL_SERVER_URL, terminalId: LOCAL_TERMINAL_ID, certificateFingerprint: "" };
const DEFAULT_HARDWARE_SETTINGS: HardwareSettings = hardwareSettingsSchema.parse({});

let mainWindow: BrowserWindow | null = null;
let authToken: string | null = null;
let desktopConfig: DesktopConfig | null = null;
let hardwareSettings: HardwareSettings = DEFAULT_HARDWARE_SETTINGS;
let serialScanner: SerialPort | null = null;
let serialBuffer = "";
let syncedLabelMediaKey: string | null = null;
const labelRawSpooler = new WindowsRawSpooler();
const runEmbeddedServer = process.argv.includes("--run-server");
let hostProcessStarted = false;
let hostStartPromise: Promise<void> | null = null;
const { autoUpdater } = electronUpdater;
let updateCheckStarted = false;

function showUpdateMessage(options: MessageBoxOptions) {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

/**
 * Release artifacts are served from the public GitHub Releases feed embedded
 * by electron-builder.  Updates are deliberately opt-in: a cashier is never
 * interrupted mid-sale and the installed application never contains a token.
 */
function enableReleaseUpdates(): void {
  if (!app.isPackaged || process.env.NODE_ENV === "test" || updateCheckStarted) return;
  updateCheckStarted = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("error", (error) => console.error("[nabta-updater] update check failed", error));
  autoUpdater.on("update-available", async (info) => {
    const response = await showUpdateMessage({
      type: "info",
      title: "تحديث نبتة متاح",
      message: `يتوفر الإصدار ${info.version} من نبتة.`,
      detail: "يمكن تنزيله الآن، وسيظل البرنامج يعمل حتى تختار إعادة التشغيل للتثبيت.",
      buttons: ["تنزيل التحديث", "لاحقًا"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response.response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        console.error("[nabta-updater] update download failed", error);
        await showUpdateMessage({
          type: "error",
          title: "تعذر تنزيل التحديث",
          message: "تعذر تنزيل التحديث الآن. تحقق من اتصال الإنترنت وحاول عند تشغيل البرنامج لاحقًا.",
        });
      }
    }
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const response = await showUpdateMessage({
      type: "info",
      title: "التحديث جاهز للتثبيت",
      message: `تم تنزيل الإصدار ${info.version}.`,
      detail: "سيغلق نبتة ويُعاد تشغيله للتثبيت. بيانات المتجر وقاعدة البيانات المحلية تبقى محفوظة.",
      buttons: ["إعادة التشغيل والتثبيت", "عند الإغلاق لاحقًا"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response.response === 0) autoUpdater.quitAndInstall(false, true);
  });
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => console.error("[nabta-updater] update check failed", error));
  }, 15_000);
}

/**
 * Windows printer drivers (especially thermal Xprinter drivers) accept work
 * asynchronously.  A second IPC call while the first driver call is still
 * pending used to create another hidden window and another spooler job.  Keep
 * one FIFO per destination and coalesce equal in-flight jobs.  This protects
 * every UI entry point, not only the button that happened to start the job.
 */
const printerQueueTails = new Map<string, Promise<void>>();
const activePrintJobs = new Map<string, Promise<unknown>>();

function enqueuePrintJob<T>(printerKey: string, jobKey: string, work: () => Promise<T>): Promise<T> {
  const existing = activePrintJobs.get(jobKey) as Promise<T> | undefined;
  if (existing) return existing;

  const previous = printerQueueTails.get(printerKey) ?? Promise.resolve();
  const scheduled = previous.catch(() => undefined).then(work);
  let settled!: Promise<T>;
  settled = scheduled.finally(() => {
    if (activePrintJobs.get(jobKey) === settled) activePrintJobs.delete(jobKey);
  });
  activePrintJobs.set(jobKey, settled);
  const queueTail = settled.then(() => undefined, () => undefined);
  printerQueueTails.set(printerKey, queueTail);
  void queueTail.finally(() => {
    if (printerQueueTails.get(printerKey) === queueTail) printerQueueTails.delete(printerKey);
  });
  return settled;
}

/** Never leave a cashier waiting forever for a broken Windows spooler call. */
function printWebContents(
  window: BrowserWindow,
  options: Electron.WebContentsPrintOptions,
  timeoutMs = 30_000,
): Promise<{ success: boolean; errorType: string }> {
  return new Promise((resolve) => {
    let complete = false;
    const finish = (result: { success: boolean; errorType: string }) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ success: false, errorType: "timeout" }), timeoutMs);
    try {
      window.webContents.print(options, (success, errorType) => finish({ success, errorType: errorType || "unknown" }));
    } catch {
      finish({ success: false, errorType: "exception" });
    }
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: "nabta", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "nabta-media", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (process.env.NABTA_USER_DATA_DIR) app.setPath("userData", process.env.NABTA_USER_DATA_DIR);
if (process.env.NODE_ENV === "test" && process.env.NABTA_TEST_DEBUG_PORT) {
  console.error(`[nabta-e2e] configuring Chromium debugging on ${process.env.NABTA_TEST_DEBUG_PORT}`);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.NABTA_TEST_DEBUG_PORT);
}

function configPath(): string { return resolve(app.getPath("userData"), "connection.json"); }
function hardwareSettingsPath(): string { return resolve(app.getPath("userData"), "hardware-settings.json"); }
function previousHardwareSettingsPath(): string { return resolve(app.getPath("userData"), "hardware-settings.previous.json"); }
function labelPrintLogPath(): string { return resolve(app.getPath("userData"), "label-print-log.jsonl"); }

async function loadHardwareSettings(): Promise<HardwareSettings> {
  try {
    const raw = JSON.parse(await readFile(hardwareSettingsPath(), "utf8")) as unknown;
    const parsed = hardwareSettingsSchema.parse(raw);
    // The 20 x 10 / 24 x 14 / 30 x 20 entries were introduced before a real
    // XP-233B print was available.  They cannot keep an EAN-13 barcode, its
    // quiet zones, a price, and an Arabic product name reliably readable.
    // Migrate those experimental values rather than continuing to waste media.
    if (["20x10", "24x14", "30x20"].includes(parsed.labelPaperSize)) {
      return { ...parsed, labelPaperSize: "58x30", labelTemplate: "STANDARD" };
    }
    return parsed;
  } catch {
    return DEFAULT_HARDWARE_SETTINGS;
  }
}

async function saveHardwareSettings(value: HardwareSettings): Promise<void> {
  await mkdir(dirname(hardwareSettingsPath()), { recursive: true });
  try {
    const previous = await readFile(hardwareSettingsPath(), "utf8");
    await writeFile(previousHardwareSettingsPath(), previous, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The first save has no previous profile to restore.
  }
  await writeFile(hardwareSettingsPath(), JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  hardwareSettings = value;
}

async function restorePreviousHardwareSettings(): Promise<HardwareSettings> {
  try {
    const previous = hardwareSettingsSchema.parse(JSON.parse(await readFile(previousHardwareSettingsPath(), "utf8")) as unknown);
    await saveHardwareSettings(previous);
    await configureSerialScanner(previous);
    return previous;
  } catch {
    throw { code: "HARDWARE_SETTINGS_RESTORE_UNAVAILABLE", messageAr: "لا توجد إعدادات أجهزة سابقة صالحة لاستعادتها على هذا الكاشير." };
  }
}

function sendBarcodeToRenderer(raw: string, source: "SERIAL" | "HID"): void {
  const parsed = barcodeSchema.safeParse(raw.trim());
  if (!parsed.success || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("nabta:barcode-scanned", { barcode: parsed.data, source });
}

function receiveSerialChunk(chunk: Buffer): void {
  serialBuffer += chunk.toString("utf8");
  if (serialBuffer.length > 512) serialBuffer = "";
  const parts = serialBuffer.split(/[\r\n\t]+/u);
  serialBuffer = parts.pop() ?? "";
  for (const value of parts) sendBarcodeToRenderer(value, "SERIAL");
}

async function stopSerialScanner(): Promise<void> {
  const current = serialScanner;
  serialScanner = null;
  serialBuffer = "";
  if (!current?.isOpen) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

async function configureSerialScanner(settings: HardwareSettings): Promise<void> {
  await stopSerialScanner();
  if (settings.scannerMode !== "SERIAL" || !settings.serialPortPath) return;
  const port = new SerialPort({ path: settings.serialPortPath, baudRate: settings.serialBaudRate, autoOpen: false });
  port.on("data", receiveSerialChunk);
  port.on("error", (error) => console.error("[nabta-scanner] serial error", error.message));
  await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
  serialScanner = port;
}

async function loadDesktopConfig(): Promise<DesktopConfig> {
  // Local mode ignores legacy connection files, so the old connection page cannot return.
  if (process.env.NODE_ENV === "test") return { serverUrl: "http://127.0.0.1:7443", certificateFingerprint: "" };
  return LOCAL_CONFIG;
}

async function saveDesktopConfig(value: DesktopConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  desktopConfig = value;
}

async function startLocalEmbeddedServer(): Promise<void> {
  if (hostStartPromise) return hostStartPromise;
  hostStartPromise = (async () => {
    if (process.env.NODE_ENV === "test" || hostProcessStarted) return;
    const healthy = async (): Promise<boolean> => {
      try { return (await net.fetch(`${LOCAL_SERVER_URL}/v1/health`)).ok; }
      catch { return false; }
    };
    if (await healthy()) return;
    if (!existsSync(resolve(process.resourcesPath, "server-runtime", "runner.mjs"))) {
      throw { code: "LOCAL_RUNTIME_MISSING", messageAr: "ملفات بيانات نبتة غير مكتملة. أعد تثبيت البرنامج." };
    }
    const child = spawn(process.execPath, ["--run-server"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        NABTA_LOCAL_MODE: "1",
        NABTA_LOCAL_DATA_DIR: resolve(app.getPath("userData"), "local-data"),
        NABTA_LOCAL_PORT: String(LOCAL_SERVER_PORT),
        // This is deliberately outside the application and live database directories.
        // The owner can copy the resulting archives to an encrypted external drive.
        BACKUP_DIR: resolve(app.getPath("documents"), "Nabta Backups"),
      },
    });
    child.unref();
    hostProcessStarted = true;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await healthy()) return;
      await new Promise<void>((done) => setTimeout(done, 250));
    }
    hostProcessStarted = false;
    throw { code: "LOCAL_DATA_START_FAILED", messageAr: "تعذر تجهيز بيانات نبتة المحلية. أغلق البرنامج ثم افتحه مرة أخرى." };
  })();
  try { await hostStartPromise; }
  catch (error) { hostStartPromise = null; throw error; }
}

function isTrustedSender(frame: Electron.WebFrameMain | null): boolean {
  if (!frame) return false;
  const url = new URL(frame.url);
  return url.protocol === "nabta:" || (process.env.NODE_ENV !== "production" && url.origin === "http://127.0.0.1:5173");
}

function apiPath(request: IpcRequest): { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown; headers?: Record<string, string> } {
  switch (request.operation) {
    case "servers.discover": throw new Error("discovery operation is local");
    case "host.start": throw new Error("host operation is local");
    case "health": return { method: "GET", path: "/v1/health" };
    case "pos.metrics": return { method: "GET", path: "/v1/pos/metrics" };
    case "terminals.discover": return { method: "GET", path: "/v1/discovery/terminals" };
    case "setup": return { method: "POST", path: "/v1/setup", body: request.payload };
    case "login": return { method: "POST", path: "/v1/auth/login", body: request.payload };
    case "logout": return { method: "POST", path: "/v1/auth/logout" };
    case "catalog.list": {
      const params = new URLSearchParams();
      if (request.payload.query) params.set("query", request.payload.query);
      if (request.payload.category) params.set("category", request.payload.category);
      if (request.payload.limit) params.set("limit", String(request.payload.limit));
      if (request.payload.cursor) params.set("cursor", request.payload.cursor);
      return { method: "GET", path: `/v1/catalog?${params}` };
    }
    case "products.reference.lookup": return { method: "GET", path: `/v1/product-references/${encodeURIComponent(request.payload.barcode)}` };
    case "products.barcode.generate": return { method: "POST", path: "/v1/product-barcodes/generate" };
    case "products.create": return { method: "POST", path: "/v1/products", body: request.payload };
    case "products.price.update": return { method: "PUT", path: `/v1/products/${request.payload.productId}/price`, body: { priceMinor: request.payload.priceMinor, wholesalePriceMinor: request.payload.wholesalePriceMinor } };
    case "products.update": return { method: "PUT", path: `/v1/products/${request.payload.productId}`, body: {
      nameAr: request.payload.nameAr,
      description: request.payload.description,
      priceMinor: request.payload.priceMinor,
      wholesalePriceMinor: request.payload.wholesalePriceMinor,
      availableQtyMilli: request.payload.availableQtyMilli,
      expectedStockVersion: request.payload.expectedStockVersion,
    } };
    case "products.archive": return { method: "DELETE", path: `/v1/products/${request.payload.productId}` };
    case "products.export": {
      const params = new URLSearchParams();
      if (request.payload?.mode) params.set("mode", request.payload.mode);
      if (request.payload?.query) params.set("query", request.payload.query);
      for (const productId of request.payload?.productIds ?? []) params.append("productIds", productId);
      const suffix = params.size ? `?${params}` : "";
      return { method: "GET", path: `/v1/products/export-data${suffix}` };
    }
    case "inventory.export-xlsx": return { method: "GET", path: "/v1/inventory/export" };
    case "inventory.periodic-export-xlsx": {
      const params = new URLSearchParams({ period: request.payload.period });
      if (request.payload.referenceDate) params.set("referenceDate", request.payload.referenceDate);
      return { method: "GET", path: `/v1/inventory/periodic-report?${params}` };
    }
    case "products.import": return { method: "POST", path: "/v1/products/import", body: request.payload.request, headers: { "Idempotency-Key": request.payload.idempotencyKey } };
    case "sales.lookup": return { method: "GET", path: `/v1/sales/lookup?invoiceNo=${encodeURIComponent(request.payload.invoiceNo)}` };
    case "sales.return": return { method: "POST", path: `/v1/sales/${request.payload.saleId}/returns`, body: request.payload.return, headers: { "Idempotency-Key": request.payload.idempotencyKey } };
    case "purchases.receive": return { method: "POST", path: "/v1/purchase-receipts", body: request.payload.receipt, headers: { "Idempotency-Key": request.payload.idempotencyKey } };
    case "stock.count.post": return { method: "POST", path: "/v1/stock-counts/post", body: request.payload };
    case "stock.movements": {
      const params = new URLSearchParams();
      if (request.payload.productId) params.set("productId", request.payload.productId);
      return { method: "GET", path: `/v1/stock-movements?${params}` };
    }
    case "stock.expiry": return { method: "GET", path: `/v1/stock-expiry?days=${request.payload.days}` };
    case "stock.reorder-list": return { method: "GET", path: "/v1/stock/reorder-list" };
    case "partners.suppliers.list": return { method: "GET", path: "/v1/partners/suppliers" };
    case "partners.suppliers.create": return { method: "POST", path: "/v1/partners/suppliers", body: request.payload };
    case "partners.customers.list": return { method: "GET", path: "/v1/partners/customers" };
    case "partners.customers.create": return { method: "POST", path: "/v1/partners/customers", body: request.payload };
    case "partners.customer.collect": return { method: "POST", path: "/v1/partners/customer/collect", body: { idempotencyKey: request.payload.idempotencyKey, payment: request.payload.payment } };
    case "partners.supplier.pay": return { method: "POST", path: "/v1/partners/supplier/pay", body: { idempotencyKey: request.payload.idempotencyKey, payment: request.payload.payment } };
    case "partners.documents.list": return { method: "GET", path: `/v1/partners/documents?partnerKind=${request.payload.partnerKind}&partnerId=${request.payload.partnerId}` };
    case "partners.documents.create": return { method: "POST", path: "/v1/partners/documents", body: request.payload, headers: { "Idempotency-Key": request.payload.idempotencyKey } };
    case "partners.documents.pay": return { method: "POST", path: `/v1/partners/documents/${request.payload.payment.documentId}/payments`, body: request.payload, headers: { "Idempotency-Key": request.payload.idempotencyKey } };
    case "shifts.current": return { method: "GET", path: "/v1/shifts/current" };
    case "shifts.open": return { method: "POST", path: "/v1/shifts", body: request.payload };
    case "shifts.cash-movement": return { method: "POST", path: `/v1/shifts/${request.payload.shiftId}/cash-movements`, body: request.payload.movement };
    case "shifts.close": {
      const { shiftId, ...body } = request.payload;
      return { method: "POST", path: `/v1/shifts/${shiftId}/close`, body };
    }
    case "shifts.history": return { method: "GET", path: `/v1/shifts/history?month=${encodeURIComponent(request.payload.month)}` };
    case "shifts.export-xlsx": return { method: "GET", path: `/v1/shifts/export-data?month=${encodeURIComponent(request.payload.month)}` };
    case "store.info": return { method: "GET", path: "/v1/store-info" };
    case "settings.branch.get": return { method: "GET", path: "/v1/settings/branch" };
    case "settings.branch.update": return { method: "PUT", path: "/v1/settings/branch", body: request.payload };
    case "settings.data-reset": return { method: "POST", path: "/v1/settings/data-reset", body: request.payload };
    case "users.list": return { method: "GET", path: "/v1/users" };
    case "users.create": return { method: "POST", path: "/v1/users", body: request.payload };
    case "users.update": return { method: "PUT", path: `/v1/users/${request.payload.userId}`, body: request.payload.update };
    case "audit.list": return { method: "GET", path: `/v1/audit?limit=${request.payload.limit}` };
    case "sales.reprint": return { method: "POST", path: `/v1/sales/${request.payload.saleId}/reprint` };
    case "backups.list": return { method: "GET", path: "/v1/backups" };
    case "backups.policy.get": return { method: "GET", path: "/v1/backups/policy" };
    case "backups.run": return { method: "POST", path: "/v1/backups" };
    case "backups.choose-destination": throw new Error("backup destination is chosen locally");
    case "backups.choose-automatic-directory": throw new Error("automatic backup directory is chosen locally");
    case "backups.import-from-file": throw new Error("backup import file is chosen locally");
    case "backups.verify": return { method: "POST", path: `/v1/backups/${request.payload.backupId}/verify` };
    case "quotes.create": return { method: "POST", path: "/v1/quotes", body: request.payload };
    case "sales.post": return { method: "POST", path: "/v1/sales", body: request.payload.sale, headers: { "Idempotency-Key": request.payload.idempotencyKey } };
    case "operations.get": return { method: "GET", path: `/v1/operations/${request.payload.requestId}` };
    case "reports.summary": {
      const params = new URLSearchParams(Object.entries(request.payload).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      return { method: "GET", path: `/v1/reports/summary?${params}` };
    }
    case "invoices.list": {
      const params = new URLSearchParams();
      if (request.payload.kind) params.set("kind", request.payload.kind);
      if (request.payload.query) params.set("query", request.payload.query);
      if (request.payload.from) params.set("from", request.payload.from);
      if (request.payload.to) params.set("to", request.payload.to);
      if (request.payload.limit) params.set("limit", String(request.payload.limit));
      return { method: "GET", path: `/v1/invoices?${params}` };
    }
    case "invoices.get":
      return { method: "GET", path: `/v1/invoices/${request.payload.kind}/${request.payload.id}` };
    case "reports.print":
    case "reports.export-pdf":
    case "reorder-list.print":
    case "reorder-list.export-pdf":
    case "partners.export-pdf":
    case "hardware.settings.get":
    case "hardware.settings.save":
    case "hardware.settings.restore":
    case "hardware.printers.list":
    case "hardware.serial.list":
    case "hardware.receipt.print":
    case "hardware.receipt.test":
    case "hardware.drawer.open":
    case "hardware.drivers.open-folder":
    case "hardware.driver.install":
    case "hardware.label.print":
    case "hardware.label.test":
    case "hardware.label.calibrate":
    case "hardware.label.batch.print":
    case "hardware.purchase-receipt.print":
    case "invoices.purchase-receipt.export-pdf": throw new Error("desktop hardware operation is local");
    case "config.get":
    case "config.set": throw new Error("config operation is local");
  }
}

function localBroadcastAddresses(): string[] {
  const addresses = new Set(["255.255.255.255", "127.0.0.1"]);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family !== "IPv4" || item.internal || !item.netmask) continue;
      const ip = item.address.split(".").map(Number);
      const mask = item.netmask.split(".").map(Number);
      const broadcast = ip.map((part, index) => (part & mask[index]!) | (255 ^ mask[index]!)).join(".");
      addresses.add(broadcast);
    }
  }
  return [...addresses];
}

async function discoverServers(): Promise<DiscoveredServer[]> {
  const socket = dgram.createSocket("udp4");
  const found = new Map<string, DiscoveredServer>();
  const request = Buffer.from("NABTA_DISCOVER_V1", "utf8");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 1_500);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("message", (message, remote) => {
      try {
        const candidate = JSON.parse(message.toString("utf8")) as Partial<DiscoveredServer>;
        if (candidate.protocol !== "NABTA_DISCOVER_V1" || typeof candidate.apiPort !== "number" || !Number.isInteger(candidate.apiPort)) return;
        const apiPort = candidate.apiPort;
        const host = remote.address;
        const tls = candidate.tls === true;
        const localDevelopment = process.env.NODE_ENV !== "production" && ["127.0.0.1", "localhost"].includes(host);
        if (!tls && !localDevelopment) return;
        const serverUrl = `${tls ? "https" : "http"}://${host}:${apiPort}`;
        found.set(`${host}:${apiPort}`, {
          protocol: "NABTA_DISCOVER_V1", name: candidate.name ?? "نبتة", host, apiPort,
          tls, ...(candidate.certificateFingerprint ? { certificateFingerprint: candidate.certificateFingerprint } : {}), serverUrl,
        });
      } catch { /* Ignore malformed UDP advertisements. */ }
    });
    socket.bind(0, "0.0.0.0", () => {
      try {
        socket.setBroadcast(true);
        for (const address of localBroadcastAddresses()) socket.send(request, 47620, address);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  }).finally(() => { try { socket.close(); } catch { /* already closed */ } });
  return [...found.values()];
}

function escapeSpreadsheetXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function u32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

function zipWorkbook(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const source = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum),
      u32(compressed.length), u32(source.length), u16(name.length), u16(0), name, compressed,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum),
      u32(compressed.length), u32(source.length), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
}

function spreadsheetColumn(index: number): string {
  let value = index;
  let result = "";
  while (value >= 0) {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  }
  return result;
}

/** @deprecated Replaced by the verified ExcelJS writer in workbooks.ts. */
export function inventoryWorkbook(data: InventoryExcelExportResponse): Buffer {
  const inline = (reference: string, value: string, style = 0) => `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeSpreadsheetXml(value)}</t></is></c>`;
  const numeric = (reference: string, value: number, style = 0) => `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  const headers = ["الصنف", "التصنيف", "الباركود", "الكمية المتاحة", "الوحدة", "سعر البيع", "تاريخ الإضافة"];
  const generatedAt = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(data.generatedAt));
  const rows = [
    `<row r="1" ht="30" customHeight="1">${inline("A1", `المخزون الحالي — ${data.storeName}`, 1)}</row>`,
    `<row r="2" ht="22" customHeight="1">${inline("A2", `وقت التصدير: ${generatedAt} | الأصناف المتاحة: ${data.items.length}`, 2)}</row>`,
    `<row r="4" ht="24" customHeight="1">${headers.map((header, index) => inline(`${spreadsheetColumn(index)}4`, header, 3)).join("")}</row>`,
    ...data.items.map((item, index) => {
      const row = index + 5;
      const quantity = item.availableQtyMilli / 1000;
      const unit = item.unitKind === "WEIGHT" ? "كجم" : "قطعة";
      const date = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(new Date(item.createdAt));
      return `<row r="${row}">${inline(`A${row}`, item.nameAr)}${inline(`B${row}`, item.category)}${inline(`C${row}`, item.barcode ?? "—")}${numeric(`D${row}`, quantity, 4)}${inline(`E${row}`, unit)}${numeric(`F${row}`, item.priceMinor / 100, 5)}${inline(`G${row}`, date, 6)}</row>`;
    }),
  ].join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="19"/><cols><col min="1" max="1" width="31" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="4" width="16" customWidth="1"/><col min="5" max="5" width="12" customWidth="1"/><col min="6" max="6" width="15" customWidth="1"/><col min="7" max="7" width="17" customWidth="1"/></cols><sheetData>${rows}</sheetData><mergeCells count="2"><mergeCell ref="A1:G1"/><mergeCell ref="A2:G2"/></mergeCells><autoFilter ref="A4:G${Math.max(data.items.length + 4, 4)}"/></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.00 &quot;ج.م&quot;"/><numFmt numFmtId="165" formatCode="0.###"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF16785F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF5F0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD3E2DC"/></left><right style="thin"><color rgb="FFD3E2DC"/></right><top style="thin"><color rgb="FFD3E2DC"/></top><bottom style="thin"><color rgb="FFD3E2DC"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="0" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>`;
  return zipWorkbook([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView rightToLeft="1"/></bookViews><sheets><sheet name="المخزون الحالي" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
}

async function exportInventoryXlsx(data: InventoryExcelExportResponse): Promise<{ cancelled: boolean; path?: string; itemCount: number }> {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(data.generatedAt));
  const options = { title: "حفظ ملف المخزون بصيغة Excel", defaultPath: resolve(app.getPath("documents"), `مخزون ${data.storeName} ${date}.xlsx`), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, itemCount: data.items.length };
  await writeFile(destination.filePath, await createInventoryWorkbook(data));
  return { cancelled: false, path: destination.filePath, itemCount: data.items.length };
}

async function exportInventoryPeriodicXlsx(data: InventoryPeriodicExcelExportResponse): Promise<{ cancelled: boolean; path?: string; soldItemCount: number; reorderItemCount: number }> {
  const options = {
    title: "حفظ ملف الجرد الدوري بصيغة Excel",
    defaultPath: resolve(app.getPath("documents"), `${data.periodLabel} ${data.storeName} ${data.periodStart} - ${data.periodEnd}.xlsx`),
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, soldItemCount: data.salesItems.length, reorderItemCount: data.reorderItems.length };
  await writeFile(destination.filePath, await createInventoryPeriodicWorkbook(data));
  return { cancelled: false, path: destination.filePath, soldItemCount: data.salesItems.length, reorderItemCount: data.reorderItems.length };
}

/** @deprecated Replaced by the verified ExcelJS writer in workbooks.ts. */
export function productsWorkbook(data: ProductExcelExportResponse): Buffer {
  const inline = (reference: string, value: string, style = 0) => `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeSpreadsheetXml(value)}</t></is></c>`;
  const numeric = (reference: string, value: number, style = 0) => `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  const isInternal = data.mode === "INTERNAL";
  const headers = isInternal
    ? ["الصنف", "التصنيف", "الباركود", "الوحدة", "الكمية المتاحة", "سعر الجملة", "سعر البيع"]
    : ["الصنف", "التصنيف", "الباركود", "الوحدة", "الكمية المتاحة", "سعر البيع"];
  const generatedAt = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(data.generatedAt));
  const lastColumn = spreadsheetColumn(headers.length - 1);
  const title = isInternal ? `قائمة أسعار الجملة — ${data.storeName}` : `قائمة أسعار البيع — ${data.storeName}`;
  const rows = [
    `<row r="1" ht="30" customHeight="1">${inline("A1", title, 1)}</row>`,
    `<row r="2" ht="22" customHeight="1">${inline("A2", `وقت التصدير: ${generatedAt} | عدد الأصناف: ${data.items.length}`, 2)}</row>`,
    `<row r="4" ht="24" customHeight="1">${headers.map((header, index) => inline(`${spreadsheetColumn(index)}4`, header, 3)).join("")}</row>`,
    ...data.items.map((item, index) => {
      const row = index + 5;
      const unit = item.unitKind === "WEIGHT" ? "كجم" : "قطعة";
      const wholesale = isInternal ? numeric(`F${row}`, (item.wholesalePriceMinor ?? 0) / 100, 5) : "";
      const retailColumn = isInternal ? "G" : "F";
      return `<row r="${row}">${inline(`A${row}`, item.nameAr)}${inline(`B${row}`, item.category)}${inline(`C${row}`, item.barcode ?? "—")}${inline(`D${row}`, unit)}${numeric(`E${row}`, item.availableQtyMilli / 1000, 4)}${wholesale}${numeric(`${retailColumn}${row}`, item.priceMinor / 100, 5)}</row>`;
    }),
  ].join("");
  const columnWidths = isInternal
    ? '<col min="1" max="1" width="31" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/><col min="5" max="5" width="16" customWidth="1"/><col min="6" max="7" width="15" customWidth="1"/>'
    : '<col min="1" max="1" width="31" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/><col min="5" max="5" width="16" customWidth="1"/><col min="6" max="6" width="15" customWidth="1"/>';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="19"/><cols>${columnWidths}</cols><sheetData>${rows}</sheetData><mergeCells count="2"><mergeCell ref="A1:${lastColumn}1"/><mergeCell ref="A2:${lastColumn}2"/></mergeCells><autoFilter ref="A4:${lastColumn}${Math.max(data.items.length + 4, 4)}"/></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.00 &quot;ج.م&quot;"/><numFmt numFmtId="165" formatCode="0.###"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF16785F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF5F0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD3E2DC"/></left><right style="thin"><color rgb="FFD3E2DC"/></right><top style="thin"><color rgb="FFD3E2DC"/></top><bottom style="thin"><color rgb="FFD3E2DC"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="0" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>`;
  return zipWorkbook([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView rightToLeft="1"/></bookViews><sheets><sheet name="${isInternal ? "أسعار الجملة" : "أسعار البيع"}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
}

async function exportProductsXlsx(data: ProductExcelExportResponse): Promise<{ cancelled: boolean; path?: string; itemCount: number }> {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(data.generatedAt));
  const label = data.mode === "INTERNAL" ? "قائمة جملة" : "قائمة أسعار";
  const options = { title: "حفظ قائمة الأصناف بصيغة Excel", defaultPath: resolve(app.getPath("documents"), `${label} ${data.storeName} ${date}.xlsx`), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, itemCount: data.items.length };
  await writeFile(destination.filePath, await createProductsWorkbook(data));
  return { cancelled: false, path: destination.filePath, itemCount: data.items.length };
}

async function exportShiftsXlsx(data: ShiftHistoryExcelExportResponse): Promise<{ cancelled: boolean; path?: string; itemCount: number }> {
  const options = { title: "حفظ سجل الورديات بصيغة Excel", defaultPath: resolve(app.getPath("documents"), `ورديات ${data.storeName} ${data.month}.xlsx`), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, itemCount: data.items.length };
  await writeFile(destination.filePath, await createShiftsWorkbook(data));
  return { cancelled: false, path: destination.filePath, itemCount: data.items.length };
}

type ApiRoute = ReturnType<typeof apiPath>;

async function callApiRoute(route: ApiRoute, responseType: "json" | "text" = "json"): Promise<unknown> {
  if (!desktopConfig) throw { code: "SERVER_NOT_CONFIGURED", messageAr: "أدخل عنوان خادم المتجر أولًا" };
  const url = new URL(route.path, desktopConfig.serverUrl).toString();
  const headers: Record<string, string> = { Accept: "application/json", ...route.headers };
  if (route.body !== undefined) headers["Content-Type"] = "application/json";
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let response: Response;
  try {
    response = await net.fetch(url, { method: route.method, headers, ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}) });
  } catch {
    throw { code: "LOCAL_DATA_UNAVAILABLE", messageAr: "بيانات نبتة المحلية غير جاهزة. أغلق البرنامج ثم افتحه مرة أخرى." };
  }
  const data = response.status === 204 ? null : responseType === "text" ? await response.text() : await response.json().catch(() => null);
  if (!response.ok) throw data ?? { code: "SERVER_ERROR", messageAr: "رفض الخادم العملية" };
  return data;
}

async function chooseBackupDestination(): Promise<{ cancelled: boolean; path?: string }> {
  const options: SaveDialogOptions = {
    title: "حفظ نسخة نبتة الاحتياطية",
    defaultPath: resolve(app.getPath("documents"), "Nabta Backups", `nabta-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`),
    filters: [{ name: "نسخة نبتة الاحتياطية", extensions: ["dump"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const backup = await callApiRoute({ method: "POST", path: "/v1/backups", body: { destinationPath: destination.filePath } });
  return { cancelled: false, path: (backup as { path: string }).path };
}

async function chooseAutomaticBackupDirectory(): Promise<{ cancelled: boolean; path?: string; createdPath?: string }> {
  const options: OpenDialogOptions = {
    title: "اختيار مجلد النسخ الاحتياطي التلقائي",
    defaultPath: resolve(app.getPath("documents"), "Nabta Backups"),
    properties: ["openDirectory", "createDirectory"],
  };
  const destination = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (destination.canceled || !destination.filePaths[0]) return { cancelled: true };
  const result = await callApiRoute({
    method: "PUT",
    path: "/v1/backups/policy",
    body: { destinationPath: destination.filePaths[0], automaticEnabled: true },
  }) as { backup?: { path?: string }; policy: { destinationPath: string } };
  return {
    cancelled: false,
    path: result.policy.destinationPath,
    ...(result.backup?.path ? { createdPath: result.backup.path } : {}),
  };
}

async function chooseBackupImport(): Promise<{ cancelled: boolean; path?: string; schemaVersion?: string }> {
  const options: OpenDialogOptions = {
    title: "اختيار نسخة نبتة الاحتياطية للاستيراد",
    filters: [{ name: "نسخة نبتة الاحتياطية", extensions: ["dump"] }],
    properties: ["openFile"],
  };
  const source = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (source.canceled || !source.filePaths[0]) return { cancelled: true };
  const imported = await callApiRoute({ method: "POST", path: "/v1/backups/import", body: { sourcePath: source.filePaths[0] } });
  const result = imported as { path: string; schemaVersion: string };
  return { cancelled: false, path: result.path, schemaVersion: result.schemaVersion };
}

async function callApi(request: IpcRequest): Promise<unknown> {
  const route = apiPath(request);
  const data = await callApiRoute(route);
  if (request.operation === "login") {
    const login = data as { token: string };
    authToken = login.token;
    const config = desktopConfig;
    if (!config) throw { code: "SERVER_NOT_CONFIGURED", messageAr: "أدخل عنوان خادم المتجر أولًا" };
    if (!config.terminalId) await saveDesktopConfig({ ...config, terminalId: request.payload.terminalId });
    const { token: _token, ...safe } = login;
    return safe;
  }
  if (request.operation === "logout") authToken = null;
  if (request.operation === "setup") {
    const setup = data as { terminalId: string };
    const config = desktopConfig;
    if (!config) throw { code: "SERVER_NOT_CONFIGURED", messageAr: "أدخل عنوان خادم المتجر أولًا" };
    await saveDesktopConfig({ ...config, terminalId: setup.terminalId });
  }
  if (request.operation === "inventory.export-xlsx") return exportInventoryXlsx(data as InventoryExcelExportResponse);
  if (request.operation === "inventory.periodic-export-xlsx") return exportInventoryPeriodicXlsx(data as InventoryPeriodicExcelExportResponse);
  if (request.operation === "products.export") return exportProductsXlsx(data as ProductExcelExportResponse);
  if (request.operation === "shifts.export-xlsx") return exportShiftsXlsx(data as ShiftHistoryExcelExportResponse);
  return data;
}

const catalogImageUrlMap = new Map<string, string>();
const failedImageUrlSet = new Set<string>();
let imageSyncRunning = false;

function resolveImageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

async function fetchAndCacheImage(barcode: string, rawUrl: string, catalogRoot: string): Promise<Buffer | null> {
  if (failedImageUrlSet.has(barcode)) return null;
  try {
    const encoded = encodeURI(rawUrl);
    const response = await net.fetch(encoded, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NabtaPOS/1.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      failedImageUrlSet.add(barcode);
      return null;
    }
    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    const mime = resolveImageMime(bytes);
    if (mime === "application/octet-stream") {
      failedImageUrlSet.add(barcode);
      return null;
    }
    const targetFile = resolve(catalogRoot, `${barcode}.img`);
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(targetFile, bytes);
    return bytes;
  } catch {
    failedImageUrlSet.add(barcode);
    return null;
  }
}

async function startCatalogImageBackgroundSync(): Promise<void> {
  if (imageSyncRunning || !desktopConfig) return;
  imageSyncRunning = true;
  try {
    const catalogRoot = resolve(app.getPath("userData"), "blob_storage", "catalog");
    await mkdir(catalogRoot, { recursive: true });

    const endpoint = new URL("/v1/media/catalog-images", desktopConfig.serverUrl).toString();
    const response = await net.fetch(endpoint).catch(() => null);
    if (!response || !response.ok) {
      imageSyncRunning = false;
      return;
    }
    const items = (await response.json()) as Array<{ barcode: string; url: string }>;
    for (const item of items) {
      if (item.barcode && item.url) {
        catalogImageUrlMap.set(item.barcode, item.url);
      }
    }

    const pending: Array<{ barcode: string; url: string }> = [];
    for (const [barcode, url] of catalogImageUrlMap.entries()) {
      const targetFile = resolve(catalogRoot, `${barcode}.img`);
      if (!existsSync(targetFile)) {
        pending.push({ barcode, url });
      }
    }

    if (pending.length === 0) {
      imageSyncRunning = false;
      return;
    }

    const concurrency = 3;
    const worker = async () => {
      while (pending.length > 0) {
        const item = pending.shift();
        if (!item) break;
        await fetchAndCacheImage(item.barcode, item.url, catalogRoot);
        await new Promise((r) => setTimeout(r, 60));
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } catch {
    // Graceful offline fallback
  } finally {
    imageSyncRunning = false;
  }
}

async function registerProtocol(): Promise<void> {
  const rendererRoot = resolve(app.getAppPath(), "dist");
  protocol.handle("nabta", async (request) => {
    const url = new URL(request.url);
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const path = resolve(rendererRoot, `.${requested}`);
    if (path !== rendererRoot && !path.startsWith(`${rendererRoot}${sep}`)) return new Response("Not found", { status: 404 });
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
    try { return new Response(await readFile(path), { headers: { "Content-Type": mime[extname(path)] ?? "application/octet-stream" } }); }
    catch { return new Response("Not found", { status: 404 }); }
  });
  protocol.handle("nabta-media", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "product") return new Response("Not found", { status: 404 });
    const barcode = decodeURIComponent(url.pathname).replace(/^\//, "");
    if (!/^[A-Za-z0-9-]{1,80}$/.test(barcode)) return new Response("Invalid barcode", { status: 400 });
    const catalogRoot = resolve(app.getPath("userData"), "blob_storage", "catalog");
    const path = resolve(catalogRoot, `${barcode}.img`);
    if (!path.startsWith(`${catalogRoot}${sep}`)) return new Response("Not found", { status: 404 });
    try {
      const bytes = await readFile(path);
      const mime = resolveImageMime(bytes);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" } });
    } catch {
      const sourceUrl = catalogImageUrlMap.get(barcode);
      if (sourceUrl) {
        const downloadedBytes = await fetchAndCacheImage(barcode, sourceUrl, catalogRoot);
        if (downloadedBytes) {
          const mime = resolveImageMime(downloadedBytes);
          return new Response(new Uint8Array(downloadedBytes), { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" } });
        }
      }
      return new Response("Not found", { status: 404 });
    }
  });
}

async function createWindow(): Promise<void> {
  desktopConfig = await loadDesktopConfig();
  hardwareSettings = await loadHardwareSettings();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (!desktopConfig || request.hostname !== new URL(desktopConfig.serverUrl).hostname) return callback(-3);
    const expected = desktopConfig.certificateFingerprint.replace(/:/g, "").toUpperCase();
    const actual = request.certificate.fingerprint.replace(/:/g, "").toUpperCase();
    const localOnly = ["127.0.0.1", "localhost"].includes(request.hostname);
    callback(localOnly && !expected ? 0 : expected && expected === actual ? 0 : -2);
  });
  mainWindow = new BrowserWindow({
    width: 1366, height: 768, minWidth: 390, minHeight: 650, show: false,
    backgroundColor: "#0f1117",
    icon: resolve(import.meta.dirname, "../build/icon.png"),
    webPreferences: {
      preload: resolve(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // Windows print discovery can block while the spooler wakes up. Never delay app startup for it.
  void detectAndSavePrinterRoles().catch((error) => console.error("[nabta-printers] automatic role detection failed", error));
  void configureSerialScanner(hardwareSettings).catch((error) => console.error("[nabta-scanner] unable to open configured serial scanner", error));
  void startLocalEmbeddedServer();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("nabta://") && !url.startsWith("http://127.0.0.1:5173")) event.preventDefault();
  });
  await mainWindow.loadURL(process.env.NABTA_DEV_URL ?? "nabta://app/index.html");
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    setTimeout(() => {
      void startCatalogImageBackgroundSync();
    }, 4000);
  });
}

function escapeReportHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatReportMoney(minor: number): string {
  return `${minor < 0 ? "−" : ""}${new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(minor) / 100)} ج.م`;
}

function reportPdfHtml(report: ReportPdfExportRequest): string {
  const metric = (label: string, value: number) => `<section class="metric"><span>${escapeReportHtml(label)}</span><strong>${escapeReportHtml(formatReportMoney(value))}</strong></section>`;
  const row = (label: string, value: string) => `<tr><th>${escapeReportHtml(label)}</th><td>${escapeReportHtml(value)}</td></tr>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير مالي — ${escapeReportHtml(report.storeName)}</title><style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; } body { margin: 0; color: #132923; font-family: Arial, "Segoe UI", sans-serif; font-size: 12pt; }
    header { display:flex; align-items:flex-start; justify-content:space-between; padding-bottom:18px; border-bottom:2px solid #168368; }
    h1 { margin:0; font-size:23pt; } h2 { margin:5px 0 0; font-size:13pt; color:#56706a; font-weight:500; }
    .badge { color:#fff; background:#168368; border-radius:11px; padding:9px 14px; font-weight:700; } .period { margin:18px 0; color:#3d5550; }
    .metrics { display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; margin:18px 0; } .metric { border:1px solid #d8e5e0; border-radius:10px; padding:13px; }
    .metric span { display:block; color:#55706a; font-size:10.5pt; } .metric strong { display:block; margin-top:7px; color:#123d32; font-size:16pt; }
    table { width:100%; border-collapse:collapse; margin-top:18px; } th,td { padding:11px 12px; border-bottom:1px solid #d8e5e0; text-align:right; } th { color:#48625b; font-weight:500; } td { font-weight:700; }
    footer { margin-top:26px; padding-top:12px; border-top:1px solid #d8e5e0; color:#6b817b; font-size:9.5pt; }
  </style></head><body><header><div><h1>${escapeReportHtml(report.storeName)}</h1><h2>تقرير الحسابات والأرباح</h2></div><div class="badge">نبتة</div></header>
  <p class="period">الفترة: <b dir="ltr">${escapeReportHtml(report.from)}</b> إلى <b dir="ltr">${escapeReportHtml(report.to)}</b></p>
  <main class="metrics">${metric("صافي المبيعات", report.summary.netSalesMinor)}${metric("تكلفة المبيعات", report.summary.netCogsMinor)}${metric("مجمل الربح", report.summary.grossProfitMinor)}${metric("صافي الربح التقديري", report.summary.estimatedNetProfitMinor)}</main>
  <table><tbody>${row("المرتجعات", formatReportMoney(report.summary.returnsMinor))}${row("المصروفات", formatReportMoney(report.summary.expensesMinor))}${row("خسارة المرتجع التالف", formatReportMoney(report.summary.damagedLossMinor))}${row("عدد الفواتير", new Intl.NumberFormat("ar-EG").format(report.summary.invoiceCount))}</tbody></table>
  <footer>تم إنشاء هذا التقرير من بيانات نبتة للفترة المحددة. الأرقام بالجنيه المصري.</footer></body></html>`;
}

async function exportReportPdf(report: ReportPdfExportRequest): Promise<{ cancelled: boolean; path?: string }> {
  const options = {
    title: "حفظ التقرير المالي بصيغة PDF",
    defaultPath: resolve(app.getPath("documents"), `تقرير نبتة ${report.from} - ${report.to}.pdf`),
    filters: [{ name: "ملف PDF", extensions: ["pdf"] }],
  };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reportPdfHtml(report))}`);
    const pdf = await reportWindow.webContents.printToPDF({ pageSize: "A4", printBackground: true });
    await writeFile(destination.filePath, pdf);
    return { cancelled: false, path: destination.filePath };
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
}

async function printFinancialReport(report: ReportPdfExportRequest): Promise<{ printed: true }> {
  return enqueuePrintJob("system-print-dialog", `report:${report.from}:${report.to}`, async () => {
    const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reportPdfHtml(report))}`);
      const result = await printWebContents(reportWindow, { silent: false, printBackground: true, pageSize: "A4" });
      if (!result.success) throw { code: "REPORT_PRINT_FAILED", messageAr: result.errorType === "canceled" ? "تم إلغاء الطباعة." : result.errorType === "timeout" ? "استغرقت الطباعة وقتًا أطول من المعتاد ولم تُرسل محاولة جديدة." : "تعذر إرسال التقرير إلى الطابعة." };
      return { printed: true };
    } finally {
      if (!reportWindow.isDestroyed()) reportWindow.destroy();
    }
  });
}

function reorderListHtml(report: ReorderListDocumentRequest): string {
  const statusLabel: Record<(typeof report.items)[number]["status"], string> = {
    OUT_OF_STOCK: "نفد تمامًا",
    BELOW_REORDER: "أقل من الحد",
    AT_REORDER: "وصل للحد",
  };
  const rows = report.items.map((item) => `<tr>
    <td>${escapeReportHtml(item.nameAr)}<small>${escapeReportHtml(item.category)}</small></td>
    <td dir="ltr">${escapeReportHtml(item.barcode ?? "—")}</td>
    <td>${escapeReportHtml(formatQtyForReceipt(item.availableQtyMilli, item.unitKind))}</td>
    <td>${escapeReportHtml(formatQtyForReceipt(item.reorderLevelMilli, item.unitKind))}</td>
    <td><b>${escapeReportHtml(formatQtyForReceipt(item.shortageQtyMilli, item.unitKind))}</b></td>
    <td><span class="status ${item.status.toLowerCase()}">${statusLabel[item.status]}</span></td>
  </tr>`).join("");
  const generatedAt = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(report.generatedAt));
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>قائمة شراء — ${escapeReportHtml(report.storeName)}</title><style>
    @page { size:A4; margin:12mm; } * { box-sizing:border-box; } body { margin:0; color:#132923; font-family:Arial,"Segoe UI",sans-serif; font-size:10.5pt; }
    header { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:14px; border-bottom:2px solid #168368; } h1 { margin:0; font-size:22pt; } p { margin:5px 0; color:#55706a; }
    .badge { color:#fff; background:#168368; border-radius:10px; padding:8px 13px; font-weight:700; } table { width:100%; border-collapse:collapse; margin-top:18px; } th,td { padding:9px 7px; border-bottom:1px solid #d8e5e0; text-align:right; vertical-align:top; } th { color:#48625b; font-weight:700; background:#f1f7f5; } td small { display:block; color:#6b817b; margin-top:3px; } .status { display:inline-block; padding:3px 7px; border-radius:99px; font-size:9pt; font-weight:700; } .out_of_stock { color:#a52d2d; background:#fdeeee; } .below_reorder { color:#875b08; background:#fff3d8; } .at_reorder { color:#3d6472; background:#eaf4f7; } footer { margin-top:20px; padding-top:9px; border-top:1px solid #d8e5e0; color:#6b817b; font-size:9pt; }
  </style></head><body><header><div><h1>${escapeReportHtml(report.storeName)}</h1><p>قائمة الأصناف المطلوب مراجعة شرائها</p><p>وقت الإنشاء: ${escapeReportHtml(generatedAt)}</p></div><div class="badge">نبتة</div></header>
  <table><thead><tr><th>الصنف</th><th>الباركود</th><th>الرصيد</th><th>حد الطلب</th><th>الكمية المقترحة</th><th>الحالة</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">لا توجد أصناف تحتاج إعادة طلب.</td></tr>"}</tbody></table><footer>الكمية المقترحة تسد العجز حتى حد إعادة الطلب المسجل لكل صنف. راجع المورد والكميات قبل إصدار أمر شراء.</footer></body></html>`;
}

async function exportReorderListPdf(report: ReorderListDocumentRequest): Promise<{ cancelled: boolean; path?: string }> {
  const options = { title: "حفظ قائمة الشراء بصيغة PDF", defaultPath: resolve(app.getPath("documents"), "قائمة شراء نبتة.pdf"), filters: [{ name: "ملف PDF", extensions: ["pdf"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reorderListHtml(report))}`);
    await writeFile(destination.filePath, await reportWindow.webContents.printToPDF({ pageSize: "A4", printBackground: true }));
    return { cancelled: false, path: destination.filePath };
  } finally { if (!reportWindow.isDestroyed()) reportWindow.destroy(); }
}

async function printReorderList(report: ReorderListDocumentRequest): Promise<{ printed: true }> {
  const key = `reorder:${report.generatedAt}:${report.items.map((item) => item.productId).join(",")}`;
  return enqueuePrintJob("system-print-dialog", key, async () => {
    const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reorderListHtml(report))}`);
      const result = await printWebContents(reportWindow, { silent: false, printBackground: true, pageSize: "A4" });
      if (!result.success) throw { code: "REORDER_PRINT_FAILED", messageAr: result.errorType === "canceled" ? "تم إلغاء الطباعة." : result.errorType === "timeout" ? "استغرقت الطباعة وقتًا أطول من المعتاد ولم تُرسل محاولة جديدة." : "تعذر إرسال قائمة الشراء إلى الطابعة." };
      return { printed: true };
    } finally { if (!reportWindow.isDestroyed()) reportWindow.destroy(); }
  });
}

function partnerListHtml(report: PartnerListDocumentRequest): string {
  const rows = report.items.map((item) => `<tr><td>${item.type === "SUPPLIER" ? "مورد" : "عميل"}</td><td>${escapeReportHtml(item.name)}</td><td dir="ltr">${escapeReportHtml(item.phone ?? "—")}</td><td>${escapeReportHtml(formatReportMoney(item.balanceMinor))}</td><td>${item.type === "CUSTOMER" ? escapeReportHtml(formatReportMoney(item.creditLimitMinor ?? 0)) : "—"}</td></tr>`).join("");
  const generatedAt = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(report.generatedAt));
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeReportHtml(report.title)} — ${escapeReportHtml(report.storeName)}</title><style>
    @page { size:A4; margin:12mm; } * { box-sizing:border-box; } body { margin:0; color:#132923; font-family:Arial,"Segoe UI",sans-serif; font-size:10.5pt; } header { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:14px; border-bottom:2px solid #168368; } h1 { margin:0; font-size:22pt; } p { margin:5px 0; color:#55706a; } .badge { color:#fff; background:#168368; border-radius:10px; padding:8px 13px; font-weight:700; } table { width:100%; border-collapse:collapse; margin-top:18px; } th,td { padding:9px 7px; border-bottom:1px solid #d8e5e0; text-align:right; } th { color:#48625b; font-weight:700; background:#f1f7f5; } footer { margin-top:20px; padding-top:9px; border-top:1px solid #d8e5e0; color:#6b817b; font-size:9pt; }
  </style></head><body><header><div><h1>${escapeReportHtml(report.storeName)}</h1><p>${escapeReportHtml(report.title)}</p><p>الفلاتر: ${escapeReportHtml(report.filterLabel)}</p><p>وقت الإنشاء: ${escapeReportHtml(generatedAt)}</p></div><div class="badge">نبتة</div></header><table><thead><tr><th>النوع</th><th>الاسم</th><th>الهاتف</th><th>الرصيد</th><th>حد الائتمان</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">لا توجد نتائج مطابقة للفلاتر الحالية.</td></tr>"}</tbody></table><footer>هذه القائمة مطابقة لنتائج البحث والفلترة الظاهرة وقت التصدير.</footer></body></html>`;
}

async function exportPartnerListPdf(report: PartnerListDocumentRequest): Promise<{ cancelled: boolean; path?: string }> {
  const options = { title: "حفظ دليل الموردين والعملاء بصيغة PDF", defaultPath: resolve(app.getPath("documents"), `${report.title}.pdf`), filters: [{ name: "ملف PDF", extensions: ["pdf"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(partnerListHtml(report))}`);
    await writeFile(destination.filePath, await reportWindow.webContents.printToPDF({ pageSize: "A4", printBackground: true }));
    return { cancelled: false, path: destination.filePath };
  } finally { if (!reportWindow.isDestroyed()) reportWindow.destroy(); }
}


async function listInstalledPrinters(): Promise<Array<{ name: string; displayName: string; isDefault: boolean; status: number; description: string }>> {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((printer) => {
    const details = printer as typeof printer & { isDefault?: boolean; status?: number };
    return { name: printer.name, displayName: printer.displayName, isDefault: details.isDefault === true, status: details.status ?? 0, description: printer.description };
  });
}

/**
 * Electron requires the Windows *system* queue name for silent printing, not
 * its friendly display name.  A saved queue can become stale after a driver
 * reinstall or when the terminal is moved to another computer, so fail before
 * rendering a label instead of giving the spooler an unusable device name.
 */
async function requireInstalledLabelPrinter(printerName: string): Promise<void> {
  const printers = await listInstalledPrinters();
  if (printers.some((printer) => printer.name === printerName)) return;
  throw {
    code: "LABEL_PRINTER_UNAVAILABLE",
    messageAr: `طابعة الملصقات المختارة (${printerName}) غير موجودة في Windows على هذا الجهاز. افتح الإعدادات، حدّث قائمة الطابعات، ثم اخترها من القائمة واحفظ.`,
  };
}

/** Select the installed printer roles on first run, including generic POS-80 queues. */
async function detectAndSavePrinterRoles(): Promise<void> {
  if (existsSync(hardwareSettingsPath())) return;
  const printers = await listInstalledPrinters();
  const fields = (printer: { name: string; displayName: string; description: string }) => `${printer.name} ${printer.displayName} ${printer.description}`;
  const label = printers.find((printer) => /(?:xp[-\s]?233b|233b|label|barcode)/iu.test(fields(printer)));
  const receipt = printers.find((printer) => printer.name !== label?.name && /(?:xp[-\s]?(?:q?808k|80)|pos[-\s]?80|receipt|thermal)/iu.test(fields(printer)));
  if (!label && !receipt) return;
  await saveHardwareSettings({
    ...hardwareSettings,
    ...(label ? { barcodePrinterName: label.name } : {}),
    ...(receipt ? { receiptPrinterName: receipt.name } : {}),
  });
}

function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exited with ${code ?? "an unknown"} error`)));
  });
}

type LabelMediaDimensions = { widthMicrons: number; heightMicrons: number; driverName: string };

function labelMediaDimensions(size: HardwareSettings["labelPaperSize"]): { widthMm: number; heightMm: number } {
  const [widthMm, heightMm] = size.split("x").map(Number);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) throw new Error("Invalid label media size");
  return { widthMm: widthMm!, heightMm: heightMm! };
}

/** Reads the *actual* driver ticket, not the value cached in the UI. */
async function readLabelPrinterMedia(printerName: string): Promise<LabelMediaDimensions | null> {
  if (process.platform !== "win32") return null;
  const script = `$ErrorActionPreference='Stop'; $printer=Get-Printer -Name $env:NABTA_LABEL_PRINTER -ErrorAction Stop; $xml=(Get-PrintConfiguration -PrinterName $env:NABTA_LABEL_PRINTER -ErrorAction Stop).PrintTicketXml; if($xml -notmatch '(?s)<psf:Feature name="psk:PageMediaSize">.*?<psf:Value xsi:type="xsd:integer">(\\d+)</psf:Value>.*?<psf:Value xsi:type="xsd:integer">(\\d+)</psf:Value>'){ throw 'The Xprinter driver did not expose its selected media size.' }; [pscustomobject]@{widthMicrons=[int]$matches[1];heightMicrons=[int]$matches[2];driverName=[string]$printer.DriverName}|ConvertTo-Json -Compress`;
  try {
    return JSON.parse(await runPowerShell(script, { ...process.env, NABTA_LABEL_PRINTER: printerName })) as LabelMediaDimensions;
  } catch {
    return null;
  }
}

/**
 * Applies the selected media to the Windows queue's DEVMODE.  The Xprinter
 * Seagull-style driver keeps the stock selection in its private DEVMODE, so a
 * normal Electron `pageSize` alone is not enough: the driver would keep the
 * old 3 x 4 inch stock and rescale/crop a 58 x 30 job.  Windows reports these
 * dimensions in 0.001 mm; DEVMODE uses 0.1 mm.
 */
async function applyXprinterLabelMedia(printerName: string, widthMm: number, heightMm: number): Promise<void> {
  const csharp = `using System; using System.Runtime.InteropServices;
public static class NabtaXprinterMedia {
  const int DM_OUT_BUFFER=2, DM_IN_BUFFER=8, DM_ORIENTATION=1, DM_PAPERSIZE=2, DM_PAPERLENGTH=4, DM_PAPERWIDTH=8;
  const uint PRINTER_ACCESS_USE=0x00000008, PRINTER_ACCESS_ADMINISTER=0x00000004;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct PRINTER_DEFAULTS { public string pDatatype; public IntPtr pDevMode; public uint DesiredAccess; }
  [StructLayout(LayoutKind.Sequential)] public struct PRINTER_INFO_8 { public IntPtr pDevMode; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName; public short dmSpecVersion,dmDriverVersion,dmSize,dmDriverExtra; public int dmFields; public short dmOrientation,dmPaperSize,dmPaperLength,dmPaperWidth,dmScale,dmCopies,dmDefaultSource,dmPrintQuality,dmColor,dmDuplex,dmYResolution,dmTTOption,dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName; public short dmLogPixels; public int dmBitsPerPel,dmPelsWidth,dmPelsHeight,dmDisplayFlags,dmDisplayFrequency,dmICMMethod,dmICMIntent,dmMediaType,dmDitherType,dmReserved1,dmReserved2,dmPanningWidth,dmPanningHeight; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string name, out IntPtr handle, ref PRINTER_DEFAULTS defaults);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int DocumentProperties(IntPtr hwnd, IntPtr printer, string name, IntPtr output, IntPtr input, int mode);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool SetPrinter(IntPtr printer, int level, IntPtr info, int command);
  static void Check(bool value) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Apply(string name, short widthTenthsMm, short heightTenthsMm) {
    var defaults=new PRINTER_DEFAULTS { DesiredAccess=PRINTER_ACCESS_USE|PRINTER_ACCESS_ADMINISTER }; IntPtr printer; Check(OpenPrinter(name,out printer,ref defaults));
    int byteCount=DocumentProperties(IntPtr.Zero,printer,name,IntPtr.Zero,IntPtr.Zero,0); if(byteCount<=0) throw new InvalidOperationException("Unable to read Xprinter defaults.");
    IntPtr devMode=Marshal.AllocHGlobal(byteCount); if(DocumentProperties(IntPtr.Zero,printer,name,devMode,IntPtr.Zero,DM_OUT_BUFFER)<0) throw new InvalidOperationException("Unable to load Xprinter defaults.");
    var dm=Marshal.PtrToStructure<DEVMODE>(devMode); dm.dmFields|=DM_ORIENTATION|DM_PAPERSIZE|DM_PAPERWIDTH|DM_PAPERLENGTH; dm.dmOrientation=1; dm.dmPaperSize=0; dm.dmPaperWidth=widthTenthsMm; dm.dmPaperLength=heightTenthsMm; dm.dmFormName=String.Empty; Marshal.StructureToPtr(dm,devMode,false);
    if(DocumentProperties(IntPtr.Zero,printer,name,devMode,devMode,DM_IN_BUFFER|DM_OUT_BUFFER)<0) throw new InvalidOperationException("Xprinter rejected the selected label size.");
    IntPtr info=Marshal.AllocHGlobal(Marshal.SizeOf<PRINTER_INFO_8>()); Marshal.StructureToPtr(new PRINTER_INFO_8 { pDevMode=devMode },info,false); Check(SetPrinter(printer,8,info,0));
    // Do not free DEVMODE here. This particular Xprinter driver can retain the
    // native buffer until its helper process exits; the short-lived PowerShell
    // worker owns it and Windows releases it on exit.
  }
}`;
  const source = Buffer.from(csharp, "utf8").toString("base64");
  const script = "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + source + "')); Add-Type -TypeDefinition $source -ErrorAction Stop; [NabtaXprinterMedia]::Apply($env:NABTA_LABEL_PRINTER,[int16]$env:NABTA_LABEL_WIDTH,[int16]$env:NABTA_LABEL_HEIGHT); Write-Output 'applied'";
  await runPowerShell(script, {
    ...process.env,
    NABTA_LABEL_PRINTER: printerName,
    NABTA_LABEL_WIDTH: String(Math.round(widthMm * 10)),
    NABTA_LABEL_HEIGHT: String(Math.round(heightMm * 10)),
  });
}

/** Synchronizes the XP-233B queue once per media choice and verifies it. */
async function syncLabelPrinterMedia(settings: HardwareSettings): Promise<void> {
  const printerName = settings.barcodePrinterName;
  if (process.platform !== "win32" || !printerName || !/xp[-\s]?233b|233b/iu.test(printerName)) return;
  const { widthMm, heightMm } = settings.labelPrintTransport === "TSPL"
    ? { widthMm: settings.labelWidthMm, heightMm: settings.labelHeightMm }
    : labelMediaDimensions(settings.labelPaperSize);
  const key = `${printerName}|${widthMm}x${heightMm}`;
  if (syncedLabelMediaKey === key) return;
  const expectedWidth = widthMm * 1000;
  const expectedHeight = heightMm * 1000;
  const before = await readLabelPrinterMedia(printerName);
  // A missing queue is normal during first setup and in automated tests. The
  // saved choice will be applied as soon as the named XP-233B exists.
  if (!before) return;
  if (before.widthMicrons !== expectedWidth || before.heightMicrons !== expectedHeight) {
    let applyError: unknown;
    try { await applyXprinterLabelMedia(printerName, widthMm, heightMm); }
    catch (error) { applyError = error; }
    const after = await readLabelPrinterMedia(printerName);
    if (!after || after.widthMicrons !== expectedWidth || after.heightMicrons !== expectedHeight) {
      throw {
        code: "LABEL_MEDIA_SYNC_FAILED",
        messageAr: "تم اختيار المقاس، لكن تعذر مطابقة تعريف Xprinter XP-233B معه تلقائيًا. شغّل تعريف XP-233B المضمّن مرة واحدة ثم احفظ الإعدادات مجددًا.",
        details: applyError,
      };
    }
  }
  syncedLabelMediaKey = key;
}

/** Sends the standard ESC/POS drawer pulse as a RAW spool job to the receipt queue. */
async function sendCashDrawerPulse(printerName: string, pin: "2" | "5"): Promise<void> {
  if (process.platform !== "win32") throw { code: "CASH_DRAWER_UNSUPPORTED", messageAr: "فتح الدرج مدعوم على Windows فقط." };
  const csharp = `using System; using System.Runtime.InteropServices;
public static class NabtaRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool OpenPrinter(string pPrinterName, out IntPtr hPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOC_INFO_1 di);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr hPrinter, byte[] bytes, int count, out int written);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Send(string printer, byte pin) { IntPtr handle; Check(OpenPrinter(printer, out handle, IntPtr.Zero)); try { var doc = new DOC_INFO_1 { pDocName="Nabta cash drawer", pDataType="RAW" }; if (StartDocPrinter(handle, 1, doc) == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); try { Check(StartPagePrinter(handle)); try { byte[] bytes = new byte[] { 0x1B, 0x70, pin, 25, 250 }; int written; Check(WritePrinter(handle, bytes, bytes.Length, out written)); if (written != bytes.Length) throw new InvalidOperationException("Incomplete drawer command"); } finally { EndPagePrinter(handle); } } finally { EndDocPrinter(handle); } } finally { ClosePrinter(handle); } }
}`;
  const source = Buffer.from(csharp, "utf8").toString("base64");
  const script = "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + source + "')); Add-Type -TypeDefinition $source -ErrorAction Stop; [NabtaRawPrinter]::Send($env:NABTA_DRAWER_PRINTER,[byte]$env:NABTA_DRAWER_PIN)";
  try {
    await runPowerShell(script, { ...process.env, NABTA_DRAWER_PRINTER: printerName, NABTA_DRAWER_PIN: pin === "2" ? "0" : "1" });
  } catch (cause) {
    console.error("[nabta-drawer] unable to pulse cash drawer", cause);
    throw { code: "CASH_DRAWER_OPEN_FAILED", messageAr: "تعذر إرسال أمر فتح الدرج. تأكد من توصيل RJ11 بطابعة الإيصالات ومن اختيار النبضة الصحيحة (2 أو 5)." };
  }
}

async function openCashDrawer(): Promise<{ opened: true; printerName: string }> {
  if (!hardwareSettings.receiptPrinterName) throw { code: "RECEIPT_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الإيصالات أولاً قبل اختبار الدرج." };
  await sendCashDrawerPulse(hardwareSettings.receiptPrinterName, hardwareSettings.cashDrawerPin);
  return { opened: true, printerName: hardwareSettings.receiptPrinterName };
}

function bundledDriversDirectory(): string {
  return app.isPackaged ? resolve(process.resourcesPath, "drivers") : resolve(import.meta.dirname, "../build/drivers");
}

function bundledDriverPath(role: "LABEL" | "RECEIPT"): string {
  return resolve(bundledDriversDirectory(), role === "LABEL" ? "Xprinter_Label_Driver_2024.2.exe" : "Xprinter_Receipt_Driver_2025.12.22.01.exe");
}

async function openBundledDriver(role: "LABEL" | "RECEIPT"): Promise<{ opened: true }> {
  const path = bundledDriverPath(role);
  if (!existsSync(path)) throw { code: "BUNDLED_DRIVER_MISSING", messageAr: "ملف تعريف الطابعة غير موجود داخل البرنامج. أعد تثبيت نبتة." };
  const error = await shell.openPath(path);
  if (error) throw { code: "BUNDLED_DRIVER_OPEN_FAILED", messageAr: "تعذر فتح ملف تعريف الطابعة. تأكد من صلاحية Windows." };
  return { opened: true };
}

async function listSerialPorts(): Promise<Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }>> {
  const ports = await SerialPort.list();
  return ports.map((port) => ({ path: port.path, ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}), ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}), ...(port.vendorId ? { vendorId: port.vendorId } : {}), ...(port.productId ? { productId: port.productId } : {}) }));
}

const code39Patterns: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn", F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn", K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn", P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn", U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn", Z: "nwwnwnnnn",
  "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", $: "nwnwnwnnn", "/": "nwnwnnnwn", "+": "nwnnnwnwn", "%": "nnnwnwnwn", "*": "nwnnwnwnn",
};

function code39Svg(value: string): string {
  const symbols = `*${value.toUpperCase()}*`;
  let cursor = 10;
  const bars: string[] = [];
  for (const symbol of symbols) {
    const pattern = code39Patterns[symbol];
    if (!pattern) throw { code: "LABEL_BARCODE_UNSUPPORTED", messageAr: "يتضمن الباركود حرفًا غير مدعوم لطباعة ملصق Code 39." };
    for (let index = 0; index < pattern.length; index += 1) {
      const width = pattern[index] === "w" ? 5 : 2;
      if (index % 2 === 0) bars.push(`<rect x="${cursor}" y="0" width="${width}" height="70"/>`);
      cursor += width;
    }
    cursor += 2;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cursor + 10} 70">${bars.join("")}</svg>`;
}

export function legacyProductLabelHtml(request: ProductLabelPrintRequest): string {
  const [width, height] = hardwareSettings.labelPaperSize.split("x");
  const barcode = code39Svg(request.barcode);
  const tiny = Number(width) <= 30 || Number(height) <= 20;
  const layout = hardwareSettings.labelTemplate === "PRICE_FOCUS"
    ? { name: tiny ? 6.5 : 9, price: tiny ? 9 : 18, barcode: tiny ? 7 : 12, code: tiny ? 5.5 : 7, gap: tiny ? .3 : .8 }
    : hardwareSettings.labelTemplate === "COMPACT"
      ? { name: tiny ? 6 : 8, price: tiny ? 7 : 11, barcode: tiny ? 7 : 11, code: tiny ? 5 : 6.5, gap: tiny ? .2 : .5 }
      : { name: tiny ? 6.5 : 11, price: tiny ? 8 : 13, barcode: tiny ? 7 : 14, code: tiny ? 5.5 : 8, gap: tiny ? .3 : 1 };
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق صنف</title><style>
    @page{size:${width}mm ${height}mm;margin:0}body{margin:0;font-family:Arial,"Segoe UI",sans-serif}.label{box-sizing:border-box;width:${width}mm;height:${height}mm;padding:${tiny ? 1 : 2.5}mm;text-align:center;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center}.name{font-size:${layout.name}px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.price{font-size:${layout.price}px;font-weight:800;margin:${layout.gap}mm 0}.barcode{line-height:0}.barcode svg{width:calc(${width}mm - ${tiny ? 3 : 7}mm);height:${layout.barcode}mm}.code{font-family:monospace;font-size:${layout.code}px;letter-spacing:${tiny ? .1 : .35}px;direction:ltr;line-height:1.15}</style></head><body><section class="label"><div class="name">${escapeReportHtml(request.nameAr)}</div><div class="price">${escapeReportHtml(formatReportMoney(request.priceMinor))}</div><div class="barcode">${barcode}</div><div class="code">${escapeReportHtml(request.barcode)}</div></section></body></html>`;
}

function isValidEan13(value: string): boolean {
  if (!/^\d{13}$/u.test(value)) return false;
  let total = 0;
  for (let index = 0; index < 12; index += 1) total += Number(value[index]) * (index % 2 === 0 ? 1 : 3);
  return (10 - (total % 10)) % 10 === Number(value[12]);
}

function productBarcodeSvg(value: string, heightMm: number): string {
  try {
    const svg = bwipjs.toSVG({
      // EAN-13 is the normal retail symbology for a verified 13-digit product
      // barcode. It prints with fewer, more regular bars than Code 128 on a
      // short shelf label. Internal/alphanumeric codes remain Code 128.
      bcid: isValidEan13(value) ? "ean13" : "code128",
      text: value,
      includetext: false,
      height: heightMm,
      scaleX: 2,
      scaleY: 2,
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: "FFFFFF",
      barcolor: "000000",
    });
    // bwip-js preserves its very wide natural aspect ratio by default.  The
    // label gives it a deliberate physical height, so stretch only vertically
    // to make the bars darker and easier to scan on 50 × 30 mm media.
    return svg.replace("<svg ", '<svg preserveAspectRatio="none" ');
  } catch {
    throw { code: "LABEL_BARCODE_UNSUPPORTED", messageAr: "تعذر إنشاء باركود قابل للمسح لهذا الصنف." };
  }
}

/**
 * The Sheimaa layout reserves two separate quiet zones: one inside the label
 * around the barcode and another at the physical label edge.  This keeps the
 * barcode readable after a printer calibration tolerance of about 1 mm.
 */
function productLabelHtml(request: ProductLabelPrintRequest): string {
  const [width, height] = hardwareSettings.labelPaperSize.split("x");
  const widthMm = Number(width);
  const heightMm = Number(height);
  const micro = widthMm <= 20 && heightMm <= 10;
  const tiny = widthMm <= 30 || heightMm <= 25;
  const wideShort = widthMm >= 55 && widthMm <= 60 && heightMm >= 29 && heightMm <= 31;
  const layout = micro
    ? { name: 4.7, longName: 4.2, price: 8, barcode: 5.15, code: 0 }
    : hardwareSettings.labelTemplate === "PRICE_FOCUS"
      ? { name: tiny ? 6 : 8.4, longName: tiny ? 5.2 : 7, price: tiny ? 8 : 14.5, barcode: tiny ? 5.8 : 10.8, code: tiny ? 5 : 6.4 }
      : hardwareSettings.labelTemplate === "COMPACT"
        ? { name: tiny ? 5.8 : 7.4, longName: tiny ? 5 : 6.2, price: tiny ? 6.8 : 9.5, barcode: tiny ? 5.8 : 9.6, code: tiny ? 4.8 : 5.8 }
        : { name: tiny ? 6 : wideShort ? 9 : 8.6, longName: tiny ? 5.2 : wideShort ? 7.3 : 7.1, price: tiny ? 7.5 : wideShort ? 13.5 : 12.5, barcode: tiny ? 6.2 : wideShort ? 10.1 : 11.2, code: tiny ? 5 : wideShort ? 5.8 : 6.2 };
  const nameClass = request.nameAr.length > 78 ? "name name-extra-long" : request.nameAr.length > 40 ? "name name-long" : "name";
  const barcode = productBarcodeSvg(request.barcode, layout.barcode);
  const microName = request.nameAr.length > 13 ? `${request.nameAr.slice(0, 12)}…` : request.nameAr;
  const labelContents = micro
    ? `<div class="micro-details"><div class="micro-name">${escapeReportHtml(microName)}</div><div class="micro-price" dir="ltr">${(request.priceMinor / 100).toFixed(2)}</div></div><div class="barcode">${barcode}</div>`
    : `<div class="brand">الشيماء</div><div class="rule"></div><div class="barcode">${barcode}</div><div class="code">${escapeReportHtml(request.barcode)}</div><div class="details"><div class="${nameClass}">${escapeReportHtml(request.nameAr)}</div><div class="price">${escapeReportHtml(formatReportMoney(request.priceMinor))}</div></div>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق صنف</title><style>
    @page{size:${width}mm ${height}mm;margin:0}
    *{box-sizing:border-box}body{margin:0;color:#000;background:#fff;font-family:Arial,"Segoe UI",sans-serif}
    .label{width:${width}mm;height:${height}mm;padding:${tiny ? .7 : 2.4}mm ${tiny ? .9 : 3}mm ${tiny ? .8 : 2.25}mm;overflow:hidden;display:flex;flex-direction:column;align-items:stretch;text-align:center;background:#fff}
    .brand{font-size:${tiny ? 6.2 : 9.5}px;font-weight:900;line-height:1.08;letter-spacing:.1px}.rule{height:.28mm;min-height:1px;margin:${tiny ? .35 : .5}mm 0 ${tiny ? .28 : .45}mm;background:#000}
    .barcode{padding:0 ${tiny ? .8 : 2.1}mm;line-height:0;direction:ltr}.barcode svg{display:block;width:100%;height:${layout.barcode}mm}.code{direction:ltr;font-family:Consolas,"Courier New",monospace;font-size:${layout.code}px;font-weight:700;letter-spacing:${tiny ? .05 : .28}px;line-height:1.05;margin-top:${tiny ? .15 : .35}mm}
    .details{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:${tiny ? .7 : 1.2}mm;align-items:center;margin-top:${tiny ? .5 : 1.1}mm;padding:0 ${tiny ? 0 : .7}mm;direction:rtl;text-align:right}.name{min-width:0;font-size:${layout.name}px;font-weight:800;line-height:1.13;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.name-long{font-size:${layout.longName}px;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.name-extra-long{font-size:${Math.max(4.6, layout.longName - 1)}px}.price{direction:rtl;white-space:nowrap;font-size:${layout.price}px;font-weight:900;line-height:1}
    .micro-label{padding:.35mm .45mm .30mm;gap:.12mm}.micro-label .barcode{padding:0;margin:0}.micro-label .barcode svg{height:${layout.barcode}mm}.micro-details{height:3.45mm;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4mm;align-items:center;direction:rtl;text-align:right}.micro-name{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:${layout.name}px;font-weight:800;line-height:1.05}.micro-price{white-space:nowrap;font-family:Arial,"Segoe UI",sans-serif;font-size:${layout.price}px;font-weight:900;line-height:1}
    ${wideShort ? `.wide-short-label{padding:1.15mm 2.25mm 1mm}.wide-short-label .brand{font-size:9px;line-height:1}.wide-short-label .rule{margin:.35mm 0 .3mm}.wide-short-label .barcode{padding:0 1.45mm}.wide-short-label .code{font-size:${layout.code}px;margin-top:.2mm}.wide-short-label .details{margin-top:.38mm;padding:0 .25mm;gap:.85mm}.wide-short-label .name{font-weight:900}.wide-short-label .price{font-weight:900}` : ""}
    ${tiny ? ".brand,.rule{display:none}.name{font-size:5.5px}.name-long,.name-extra-long{font-size:4.8px;-webkit-line-clamp:1}" : ""}
  </style></head><body><section class="label${micro ? " micro-label" : ""}${wideShort ? " wide-short-label" : ""}">${labelContents}</section></body></html>`;
}

function currentTsplLabelProfile(): LabelPrinterProfile {
  return {
    model: hardwareSettings.labelPrinterModel,
    dpi: hardwareSettings.labelDpi,
    widthMm: hardwareSettings.labelWidthMm,
    heightMm: hardwareSettings.labelHeightMm,
    gapMm: hardwareSettings.labelGapMm,
    speedMmPerSecond: hardwareSettings.labelSpeedMmPerSecond,
    density: hardwareSettings.labelDensity,
    direction: hardwareSettings.labelDirection ?? 1,
    offsetXmm: hardwareSettings.labelOffsetXmm,
    offsetYmm: hardwareSettings.labelOffsetYmm,
    mediaType: hardwareSettings.labelMediaType,
    renderMode: hardwareSettings.labelBarcodeRenderMode ?? "RASTER",
    calibrationConfirmed: hardwareSettings.labelCalibrationConfirmed,
  };
}

function monochromeTsplBitmap(bitmap: Buffer, width: number, height: number): Buffer {
  const bytesPerRow = Math.ceil(width / 8);
  const result = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      // Electron native images use four bytes per pixel.  The average works for
      // either BGRA or RGBA and avoids a platform-specific channel assumption.
      const luminance = (bitmap[index]! + bitmap[index + 1]! + bitmap[index + 2]!) / 3;
      // In TSPL wire format: 1 = Black dot (heated ink), 0 = White dot (unheated background)
      if (luminance < 180) result[y * bytesPerRow + Math.floor(x / 8)]! |= 0x80 >> (x % 8);
    }
  }
  return result;
}

function translateMonochromeTsplBitmap(source: Buffer, width: number, height: number, offsetX: number, offsetY: number): Buffer {
  if (offsetX === 0 && offsetY === 0) return source;
  const bytesPerRow = Math.ceil(width / 8);
  const translated = Buffer.alloc(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((source[y * bytesPerRow + Math.floor(x / 8)]! & (0x80 >> (x % 8))) === 0) continue;
      const targetX = x + offsetX;
      const targetY = y + offsetY;
      if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) continue;
      translated[targetY * bytesPerRow + Math.floor(targetX / 8)]! |= 0x80 >> (targetX % 8);
    }
  }
  return translated;
}

async function rasterizeTsplLabel(profile: LabelPrinterProfile, request: ProductLabelPrintRequest, mode: "FULL" | "HEADER_ONLY" = "FULL"): Promise<Buffer> {
  const layout = createLabelLayout(profile, request.barcode);
  const targetWidth = layout.widthDots;
  const targetHeight = mode === "HEADER_ONLY" ? layout.text.height : layout.heightDots;
  const textWindow = new BrowserWindow({
    show: false,
    width: targetWidth,
    height: targetHeight,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await textWindow.webContents.setZoomFactor(1);
    await textWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createLabelRasterHtml(profile, {
      storeName: "نبتة",
      name: request.nameAr,
      barcode: request.barcode,
      priceMinor: request.priceMinor,
      copies: request.copies,
    }, mode === "FULL"))}`);
    const captured = await textWindow.webContents.capturePage({ x: 0, y: 0, width: targetWidth, height: targetHeight });
    const normalized = captured.resize({ width: targetWidth, height: targetHeight, quality: "best" });
    const actual = normalized.getSize();
    if (actual.width !== targetWidth || actual.height !== targetHeight) throw new Error("Unable to rasterize the calibrated label dimensions");
    const raster = monochromeTsplBitmap(normalized.toBitmap(), targetWidth, targetHeight);
    const shiftedInkBitmap = translateMonochromeTsplBitmap(
      raster, targetWidth, targetHeight,
      Math.round((profile.offsetXmm * profile.dpi) / 25.4),
      Math.round((profile.offsetYmm * profile.dpi) / 25.4),
    );
    // Explicitly false: Do NOT invert bits. In TSPL, 0 is white paper and 1 is black ink.
    return encodeXp233bTsplBitmap(shiftedInkBitmap, false);
  } finally {
    if (!textWindow.isDestroyed()) textWindow.destroy();
  }
}

async function writeLabelPrintLog(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(labelPrintLogPath()), { recursive: true });
    await appendFile(labelPrintLogPath(), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("[nabta-label] unable to write local print log", error);
  }
}

async function sendTsplLabel(printerName: string, request: ProductLabelPrintRequest): Promise<{ printed: true; printerName: string; spoolJobId: number }> {
  const profile = currentTsplLabelProfile();
  if (request.copies > 1 && !profile.calibrationConfirmed) {
    throw { code: "LABEL_CALIBRATION_REQUIRED", messageAr: "أكد نجاح ملصق المعايرة عمليًا قبل طباعة أكثر من نسخة أو دفعة من الملصقات." };
  }
  try {
    let payload: Buffer;
    const content = {
      storeName: "نبتة",
      name: request.nameAr,
      barcode: request.barcode,
      priceMinor: request.priceMinor,
      copies: request.copies,
    };
    if (profile.renderMode === "NATIVE_TSPL") {
      const headerRaster = await rasterizeTsplLabel(profile, request, "HEADER_ONLY");
      payload = createTsplNativeBarcodeJob(profile, content, headerRaster);
    } else {
      const fullRaster = await rasterizeTsplLabel(profile, request, "FULL");
      payload = createTsplRasterJob(profile, content, fullRaster);
    }
    const result = await labelRawSpooler.submit(printerName, "Nabta TSPL Label", payload);
    await writeLabelPrintLog({
      printerName,
      transport: "TSPL",
      renderMode: profile.renderMode,
      barcode: request.barcode,
      nameAr: request.nameAr,
      priceMinor: request.priceMinor,
      copies: request.copies,
      status: "SPOOLED",
      jobId: result.jobId,
      bytes: result.bytesWritten,
    });
    return { printed: true, printerName, spoolJobId: result.jobId };
  } catch (error) {
    await writeLabelPrintLog({
      printerName,
      transport: "TSPL",
      barcode: request.barcode,
      nameAr: request.nameAr,
      status: "FAILED",
      error: error instanceof Error ? error.message : "unknown",
    });
    const message = error instanceof Error ? error.message : "تعذر تجهيز مهمة TSPL";
    throw { code: "TSPL_LABEL_PRINT_FAILED", messageAr: `تعذر إرسال مهمة الملصق إلى قائمة Windows RAW: ${message}` };
  }
}

async function calibrateTsplLabel(printerName: string): Promise<{ submitted: true; printerName: string; spoolJobId: number }> {
  const profile = currentTsplLabelProfile();
  try {
    const result = await labelRawSpooler.submit(printerName, "Nabta XP-233B Gap Calibration", createTsplGapCalibrationJob(profile));
    await writeLabelPrintLog({ printerName, transport: "TSPL", status: "GAP_CALIBRATION_SPOOLED", jobId: result.jobId, bytes: result.bytesWritten });
    return { submitted: true, printerName, spoolJobId: result.jobId };
  } catch (error) {
    await writeLabelPrintLog({ printerName, transport: "TSPL", status: "GAP_CALIBRATION_FAILED", error: error instanceof Error ? error.message : "unknown" });
    throw { code: "TSPL_CALIBRATION_FAILED", messageAr: "تعذر إرسال أمر معايرة Gap إلى طابعة الملصقات. تحقق من اتصال الطابعة وتعريف Windows." };
  }
}

async function printProductLabel(request: ProductLabelPrintRequest): Promise<{ printed: true; printerName: string }> {
  if (!hardwareSettings.barcodePrinterName) throw { code: "LABEL_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الباركود من الإعدادات أولًا." };
  if (hardwareSettings.barcodePrinterName === hardwareSettings.receiptPrinterName) throw { code: "PRINTER_ROLE_CONFLICT", messageAr: "لا يمكن استخدام الطابعة نفسها للباركود والإيصالات؛ اختر طابعتين منفصلتين." };
  const printerName = hardwareSettings.barcodePrinterName;
  const jobKey = `label:${printerName}:${request.barcode}:${request.nameAr}:${request.priceMinor}:${request.copies}`;
  return enqueuePrintJob(printerName, jobKey, async () => {
    await requireInstalledLabelPrinter(printerName);
    if (hardwareSettings.labelPrintTransport === "TSPL") return sendTsplLabel(printerName, request);
    // Media synchronization is started after saving device settings.  Never
    // repeat or await its PowerShell/driver work here: it can take seconds on a
    // busy cashier PC while the Windows queue is already ready to print.
    const labelWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await labelWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(productLabelHtml(request))}`);
      // Use the queue's own default media rather than forcing Chromium's
      // custom page size.  The latter is rejected by several label drivers even
      // though the same queue prints a Windows test page successfully.
      const result = await printWebContents(labelWindow, { silent: true, printBackground: true, deviceName: printerName, usePrinterDefaultPageSize: true, margins: { marginType: "none" }, copies: request.copies });
      if (!result.success) {
        console.error("[nabta-label] print failed", { printerName, errorType: result.errorType });
        const reason = result.errorType.toLocaleLowerCase();
        throw {
          code: "LABEL_PRINT_FAILED",
          messageAr: reason.includes("invalid printer settings")
            ? "إعدادات طابعة الملصقات غير صالحة. اضبط في تعريف Windows مقاس الرول نفسه المختار في نبتة، ثم أعد المحاولة."
            : reason.includes("cancel")
              ? "أُلغيت طباعة الملصق."
              : result.errorType === "timeout"
                ? "استغرقت الطباعة وقتًا أطول من المعتاد ولم تُرسل محاولة جديدة."
                : "تعذر إرسال الملصق لطابعة الباركود المختارة. تحقق من أن الطابعة متصلة وغير معلّقة في قائمة طباعة Windows.",
        };
      }
      return { printed: true, printerName };
    } finally { if (!labelWindow.isDestroyed()) labelWindow.destroy(); }
  });
}

async function printProductLabelBatch(request: ProductLabelBatchPrintRequest): Promise<{ printedCount: number; printerName: string }> {
  if (!hardwareSettings.barcodePrinterName) throw { code: "LABEL_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الباركود من الإعدادات أولًا." };
  if (hardwareSettings.labelPrintTransport !== "TSPL") throw { code: "LABEL_BATCH_REQUIRES_TSPL", messageAr: "طباعة الدفعات تتطلب اختيار مسار TSPL لطابعة XP-233B." };
  if (!hardwareSettings.labelCalibrationConfirmed) throw { code: "LABEL_CALIBRATION_REQUIRED", messageAr: "أكد نجاح ملصق المعايرة عمليًا قبل طباعة دفعة من الملصقات." };
  const printerName = hardwareSettings.barcodePrinterName;
  return enqueuePrintJob(printerName, `label-batch:${printerName}:${JSON.stringify(request.labels)}`, async () => {
    await requireInstalledLabelPrinter(printerName);
    let printedCount = 0;
    for (const label of request.labels) {
      await sendTsplLabel(printerName, label);
      printedCount += label.copies;
    }
    return { printedCount, printerName };
  });
}

async function printProductLabelTest(): Promise<{ printed: true; printerName: string }> {
  return printProductLabel({ nameAr: "صنف اختبار", barcode: "6221234567891", priceMinor: 1250, copies: 1 });
}

async function printReceipt(request: ReceiptPrintRequest): Promise<{ printed: true; printerName: string; copies: number }> {
  if (!hardwareSettings.receiptPrinterName) throw { code: "RECEIPT_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الإيصالات من الإعدادات أولاً." };
  const printerName = hardwareSettings.receiptPrinterName;
  return enqueuePrintJob(printerName, `receipt:${printerName}:${request.sale.saleId}:${request.copies}`, async () => {
    const receiptWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await receiptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(receiptHtml(request, hardwareSettings.receiptPaperWidth))}`);
      const result = await printWebContents(receiptWindow, {
        silent: true,
        printBackground: true,
        deviceName: printerName,
        usePrinterDefaultPageSize: true,
        margins: { marginType: "none" },
        copies: request.copies,
      });
      if (!result.success) throw { code: "RECEIPT_PRINT_FAILED", messageAr: result.errorType === "canceled" ? "أُلغيت طباعة الإيصال." : result.errorType === "timeout" ? "استغرقت الطباعة وقتًا أطول من المعتاد ولم تُرسل محاولة جديدة." : "تعذر إرسال الإيصال للطابعة المختارة. تحقق من تعريف الطابعة وورقها." };
      if (hardwareSettings.cashDrawerEnabled) {
        void sendCashDrawerPulse(printerName, hardwareSettings.cashDrawerPin)
          .catch((error) => console.error("[nabta-drawer] receipt printed but drawer command failed", error));
      }
      return { printed: true, printerName, copies: request.copies };
    } finally {
      if (!receiptWindow.isDestroyed()) receiptWindow.destroy();
    }
  });
}

async function printReceiptTest(): Promise<{ printed: true; printerName: string; copies: number }> {
  return printReceipt({ storeName: "نبتة — اختبار الطابعة", copies: 1, sale: {
    saleId: "00000000-0000-4000-8000-000000000001", invoiceNo: "TEST-RECEIPT", postedAt: new Date().toISOString(), subtotalMinor: 1250, discountMinor: 0, totalMinor: 1250, paidMinor: 1250, changeMinor: 0,
    lines: [{ productId: "00000000-0000-4000-8000-000000000002", nameAr: "إيصال اختبار", unitKind: "PIECE", qtyMilli: 1000, unitPriceMinor: 1250, grossMinor: 1250, discountMinor: 0, netMinor: 1250, stockVersion: 0 }],
  } });
}

function purchaseReceiptHtml(request: PurchaseReceiptPrintRequest): string {
  const { receipt, storeName } = request;
  const rows = receipt.lines.map((line) => `<tr>
    <td>${escapeReportHtml(line.nameAr)}</td>
    <td dir="ltr">${escapeReportHtml(formatQtyForReceipt(line.qtyMilli, line.unitKind))}</td>
    <td dir="ltr">${escapeReportHtml(formatReportMoney(line.unitCostMinor))}</td>
    <td dir="ltr">${escapeReportHtml(formatReportMoney(line.goodsMinor))}</td>
    <td dir="ltr">${escapeReportHtml(line.lotCode || "—")}</td>
    <td>${escapeReportHtml(line.expiresOn || "—")}</td>
  </tr>`).join("");
  const postedAtFormatted = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(receipt.postedAt));
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>فاتورة توريد — ${escapeReportHtml(receipt.invoiceNo)}</title><style>
    @page { size:A4; margin:12mm; } * { box-sizing:border-box; } body { margin:0; color:#132923; font-family:Arial,"Segoe UI",sans-serif; font-size:10.5pt; }
    header { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:14px; border-bottom:2px solid #168368; } h1 { margin:0; font-size:20pt; } p { margin:4px 0; color:#55706a; }
    .badge { color:#fff; background:#168368; border-radius:10px; padding:8px 13px; font-weight:700; }
    .meta-grid { display:grid; grid-template-columns: repeat(2, 1fr); gap:10px; margin-top:16px; background:#f4f9f7; padding:12px; border-radius:8px; }
    .meta-item { display:flex; gap:8px; } .meta-item b { color:#168368; }
    table { width:100%; border-collapse:collapse; margin-top:18px; } th,td { padding:8px 6px; border-bottom:1px solid #d8e5e0; text-align:right; font-size:10pt; } th { color:#48625b; font-weight:700; background:#f1f7f5; }
    .totals { margin-top:18px; display:flex; justify-content:flex-end; } .totals-table { width:320px; border-collapse:collapse; } .totals-table td { padding:6px 8px; border-bottom:1px solid #e1ece8; } .grand-total { font-weight:800; font-size:12pt; color:#168368; }
    footer { margin-top:28px; padding-top:12px; border-top:1px solid #d8e5e0; color:#6b817b; font-size:9pt; display:flex; justify-content:space-between; }
  </style></head><body>
    <header>
      <div>
        <h1>${escapeReportHtml(storeName)}</h1>
        <p>فاتورة توريد بضاعة / إذن استلام مخزني</p>
        <p>تاريخ التوريد الأصلي: <b>${escapeReportHtml(postedAtFormatted)}</b></p>
      </div>
      <div class="badge">نبتة POS</div>
    </header>
    <div class="meta-grid">
      <div class="meta-item"><span>رقم الفاتورة / الإذن:</span><b dir="ltr">${escapeReportHtml(receipt.invoiceNo)}</b></div>
      <div class="meta-item"><span>اسم المورد:</span><b>${escapeReportHtml(receipt.supplierName)}</b></div>
      <div class="meta-item"><span>هاتف المورد:</span><span dir="ltr">${escapeReportHtml(receipt.supplierPhone || "—")}</span></div>
      <div class="meta-item"><span>مسؤول الاستلام:</span><b>${escapeReportHtml(receipt.receiverName)}</b></div>
    </div>
    <table>
      <thead>
        <tr>
          <th>الصنف</th>
          <th>الكمية</th>
          <th>سعر التكلفة</th>
          <th>الإجمالي</th>
          <th>رقم التشغيلة</th>
          <th>الصلاحية</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="totals">
      <table class="totals-table">
        <tr><td>إجمالي البضاعة:</td><td dir="ltr">${escapeReportHtml(formatReportMoney(receipt.goodsMinor))}</td></tr>
        <tr><td>مصروفات التوريد:</td><td dir="ltr">${escapeReportHtml(formatReportMoney(receipt.supplyExpensesMinor))}</td></tr>
        <tr class="grand-total"><td>الإجمالي الكلي:</td><td dir="ltr">${escapeReportHtml(formatReportMoney(receipt.totalMinor))}</td></tr>
      </table>
    </div>
    <footer>
      <div>تم استلام الأصناف وقيدها بالمخزن وفق الأصول المحاسبية.</div>
      <div>توقيع المستلم: ..............................</div>
    </footer>
  </body></html>`;
}

async function exportPurchaseReceiptPdf(request: PurchaseReceiptPrintRequest): Promise<{ cancelled: boolean; path?: string }> {
  const options = { title: "حفظ فاتورة التوريد بصيغة PDF", defaultPath: resolve(app.getPath("documents"), `فاتورة-توريد-${request.receipt.invoiceNo}.pdf`), filters: [{ name: "ملف PDF", extensions: ["pdf"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(purchaseReceiptHtml(request))}`);
    await writeFile(destination.filePath, await reportWindow.webContents.printToPDF({ pageSize: "A4", printBackground: true }));
    return { cancelled: false, path: destination.filePath };
  } finally { if (!reportWindow.isDestroyed()) reportWindow.destroy(); }
}

async function printPurchaseReceipt(request: PurchaseReceiptPrintRequest): Promise<{ printed: true }> {
  return enqueuePrintJob("system-print-dialog", `purchase:${request.receipt.id}`, async () => {
    const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(purchaseReceiptHtml(request))}`);
      const result = await printWebContents(reportWindow, { silent: false, printBackground: true, pageSize: "A4" });
      if (!result.success) throw { code: "PURCHASE_PRINT_FAILED", messageAr: result.errorType === "canceled" ? "تم إلغاء الطباعة." : result.errorType === "timeout" ? "استغرقت الطباعة وقتًا أطول من المعتاد ولم تُرسل محاولة جديدة." : "تعذر إرسال فاتورة التوريد إلى الطابعة." };
      return { printed: true };
    } finally { if (!reportWindow.isDestroyed()) reportWindow.destroy(); }
  });
}

ipcMain.handle("nabta:invoke", async (event, unknownRequest: unknown) => {
  try {
    if (!isTrustedSender(event.senderFrame)) throw { code: "UNTRUSTED_RENDERER", messageAr: "مصدر الطلب غير موثوق" };
    const request = ipcRequestSchema.parse(unknownRequest);
    if (request.operation === "servers.discover") return { ok: true, data: await discoverServers() };
    if (request.operation === "backups.choose-destination") return { ok: true, data: await chooseBackupDestination() };
    if (request.operation === "backups.choose-automatic-directory") return { ok: true, data: await chooseAutomaticBackupDirectory() };
    if (request.operation === "backups.import-from-file") return { ok: true, data: await chooseBackupImport() };
    if (request.operation === "host.start") {
      if (process.env.NODE_ENV !== "test" && !existsSync(resolve(process.resourcesPath, "server-runtime", "runner.mjs"))) {
        throw { code: "HOST_RUNTIME_MISSING", messageAr: "هذه النسخة لا تحتوي على خادم محلي. أعد تثبيت مثبت نبتة الكامل." };
      }
      await startLocalEmbeddedServer();
      return { ok: true, data: { started: true } };
    }
    if (request.operation === "config.get") return { ok: true, data: desktopConfig ?? LOCAL_CONFIG };
    if (request.operation === "config.set") {
      await saveDesktopConfig(LOCAL_CONFIG);
      return { ok: true, data: desktopConfig };
    }
    if (request.operation === "reports.print") return { ok: true, data: await printFinancialReport(request.payload) };
    if (request.operation === "reports.export-pdf") return { ok: true, data: await exportReportPdf(request.payload) };
    if (request.operation === "reorder-list.print") return { ok: true, data: await printReorderList(request.payload) };
    if (request.operation === "reorder-list.export-pdf") return { ok: true, data: await exportReorderListPdf(request.payload) };
    if (request.operation === "partners.export-pdf") return { ok: true, data: await exportPartnerListPdf(request.payload) };
    if (request.operation === "hardware.settings.get") return { ok: true, data: hardwareSettings };
    if (request.operation === "hardware.settings.save") {
      if (request.payload.barcodePrinterName && request.payload.barcodePrinterName === request.payload.receiptPrinterName) {
        throw { code: "PRINTER_ROLE_CONFLICT", messageAr: "اختر طابعة مختلفة للباركود وأخرى للإيصالات حتى لا تختلط المهام." };
      }
      await saveHardwareSettings(request.payload);
      try { await configureSerialScanner(request.payload); }
      catch (error) { throw { code: "SERIAL_CONNECT_FAILED", messageAr: `تم حفظ الإعدادات، لكن تعذر فتح منفذ ${request.payload.serialPortPath}. تحقق من المنفذ وأنه غير مستخدم من برنامج آخر.`, details: error }; }
      // Some Windows Xprinter drivers take several seconds to wake the spooler
      // or open their private DEVMODE.  Saving a cashier preference must never
      // leave the Settings screen frozen.  The exact selected media is still
      // synchronized (and verified) immediately before every label print.
      void syncLabelPrinterMedia(request.payload).catch((error) => {
        console.error("[nabta-label-media] background synchronization failed", error);
      });
      return { ok: true, data: hardwareSettings };
    }
    if (request.operation === "hardware.settings.restore") return { ok: true, data: await restorePreviousHardwareSettings() };
    if (request.operation === "hardware.printers.list") return { ok: true, data: await listInstalledPrinters() };
    if (request.operation === "hardware.serial.list") return { ok: true, data: await listSerialPorts() };
    if (request.operation === "hardware.receipt.print") return { ok: true, data: await printReceipt(request.payload) };
    if (request.operation === "hardware.receipt.test") return { ok: true, data: await printReceiptTest() };
    if (request.operation === "hardware.drawer.open") return { ok: true, data: await openCashDrawer() };
    if (request.operation === "hardware.drivers.open-folder") {
      const error = await shell.openPath(bundledDriversDirectory());
      if (error) throw { code: "BUNDLED_DRIVERS_OPEN_FAILED", messageAr: "تعذر فتح مجلد تعريفات الطابعات." };
      return { ok: true, data: { opened: true } };
    }
    if (request.operation === "hardware.driver.install") return { ok: true, data: await openBundledDriver(request.payload.role) };
    if (request.operation === "hardware.label.print") return { ok: true, data: await printProductLabel(request.payload) };
    if (request.operation === "hardware.label.test") return { ok: true, data: await printProductLabelTest() };
    if (request.operation === "hardware.label.calibrate") {
      if (!hardwareSettings.barcodePrinterName) throw { code: "LABEL_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الملصقات من الإعدادات أولًا." };
      await requireInstalledLabelPrinter(hardwareSettings.barcodePrinterName);
      if (hardwareSettings.labelPrintTransport !== "TSPL") throw { code: "TSPL_NOT_SELECTED", messageAr: "اختر مسار TSPL لطابعة XP-233B قبل معايرة Gap." };
      return { ok: true, data: await calibrateTsplLabel(hardwareSettings.barcodePrinterName) };
    }
    if (request.operation === "hardware.label.batch.print") return { ok: true, data: await printProductLabelBatch(request.payload) };
    if (request.operation === "hardware.purchase-receipt.print") return { ok: true, data: await printPurchaseReceipt(request.payload) };
    if (request.operation === "invoices.purchase-receipt.export-pdf") return { ok: true, data: await exportPurchaseReceiptPdf(request.payload) };
    return { ok: true, data: await callApi(request) };
  } catch (cause) {
    const candidate = cause as { code?: unknown; messageAr?: unknown; message?: unknown; issues?: unknown };
    return {
      ok: false,
      error: {
        code: typeof candidate?.code === "string" ? candidate.code : "DESKTOP_ERROR",
        messageAr: typeof candidate?.messageAr === "string" ? candidate.messageAr : typeof candidate?.message === "string" ? candidate.message : "تعذر تنفيذ العملية",
        ...(candidate?.issues ? { details: candidate.issues } : {}),
      },
    };
  }
});

if (runEmbeddedServer) {
  void app.whenReady().then(() => import(pathToFileURL(resolve(process.resourcesPath, "server-runtime", "runner.mjs")).href)).catch((error) => {
    console.error("[nabta-host] embedded server failed", error);
    app.quit();
  });
} else {
  if (process.env.NODE_ENV === "test") console.error("[nabta-e2e] waiting for app readiness");
  void app.whenReady().then(async () => {
    app.setAppUserModelId("eg.nabta.pos");
    if (process.env.NODE_ENV === "test") console.error("[nabta-e2e] app ready");
    await registerProtocol();
    await createWindow();
    enableReleaseUpdates();
    if (process.env.NODE_ENV === "test") console.error("[nabta-e2e] desktop window created");
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  app.on("before-quit", () => { void stopSerialScanner(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
