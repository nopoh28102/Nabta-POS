import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from "electron";
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from "electron";
import { appendFile, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import dgram from "node:dgram";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { SerialPort } from "serialport";
import bwipjs from "bwip-js";
import electronUpdater from "electron-updater";
import { barcodeSchema, hardwareSettingsSchema, ipcRequestSchema, type ComprehensiveReportResponse, type DeliveryOrderPrintRequest, type DiscoveredServer, type HardwareSettings, type InventoryExcelExportResponse, type InventoryPeriodicExcelExportResponse, type InvoiceDetailResponse, type IpcRequest, type PartnerListDocumentRequest, type ProductExcelExportResponse, type ProductLabelBatchPrintRequest, type ProductLabelPrintRequest, type PurchaseReceiptPrintRequest, type ReceiptPrintRequest, type ReorderListDocumentRequest, type ReportPdfExportRequest, type ShiftHistoryExcelExportResponse } from "@nabta/contracts";
import { createComprehensiveReportWorkbook, createExpiryWorkbook, createInventoryPeriodicWorkbook, createInventoryWorkbook, createProductsWorkbook, createProductSyncWorkbook, createShiftsWorkbook, productSyncWorkbookToCsv, type ExpiryWorkbookData } from "./workbooks.js";
import { createLabelLayout, createLabelRasterHtml, createTsplGapCalibrationJob, createTsplNativeBarcodeJob, createTsplRasterJob, encodeXp233bTsplBitmap, type LabelPrinterProfile } from "./printing/label-engine.js";
import { deliveryOrderHtml, formatQtyForReceipt, purchaseReceiptThermalHtml, receiptHtml } from "./printing/receipt-engine.js";
import { WindowsRawSpooler } from "./printing/raw-spooler.js";

interface DesktopConfig {
  serverUrl: string;
  terminalId?: string;
  certificateFingerprint: string;
  deviceMode?: "PRIMARY" | "SECONDARY";
  terminalRelayKey?: string;
}

interface CloudflareConnection {
  enabled: boolean;
  autoStart: boolean;
  tunnelToken?: string | undefined;
  commerceSharedSecret?: string | undefined;
  terminalRelaySharedSecret?: string | undefined;
  terminalRelayUrl?: string | undefined;
  publicApiUrl?: string | undefined;
  cloudCoreUrl?: string | undefined;
  cloudStoreId?: string | undefined;
  cloudMigrationKey?: string | undefined;
  cloudMigrationId?: string | undefined;
  cloudMigrationState?: "PENDING" | "IMPORTED" | undefined;
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

type CloudMigrationProgress = {
  phase: "CHECKING_DNS" | "CHECKING_CLOUD" | "CREATING_STORE" | "PREPARING" | "STARTING" | "UPLOADING" | "VERIFYING" | "PROTECTING_ACCOUNT" | "COMPLETE";
  percent: number;
  messageAr: string;
  completedChunks?: number;
  totalChunks?: number;
};

const LOCAL_SERVER_PORT = 17443;
const LOCAL_SERVER_URL = `http://127.0.0.1:${LOCAL_SERVER_PORT}`;
const DEFAULT_CLOUD_CORE_URL = "https://nabta-cloud-core.mahmoudnabih989.workers.dev";
const LEGACY_LOCAL_TERMINAL_ID = "00000000-0000-4000-8000-000000000003";
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
let localHostProcess: ReturnType<typeof spawn> | null = null;
let localHostWasReady = false;
let localHostRecoveryAttempts = 0;
let appIsQuitting = false;
let pendingLocalRecoveryArchive: string | null = null;
let cloudflareTunnelProcess: ReturnType<typeof spawn> | null = null;
let cloudflareTunnelRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cloudflareTunnelRetryDelayMs = 5_000;
let cloudReconciliationTimer: ReturnType<typeof setInterval> | null = null;
let mobilePrintQueueTimer: ReturnType<typeof setInterval> | null = null;
let mobilePrintQueueBusy = false;
let cloudMigrationInFlight = false;
const { autoUpdater } = electronUpdater;
let updateCheckStarted = false;

// The local data host is an Electron child process in packaged builds. It must
// never share Chromium's profile/cache with the visible POS window: Windows
// can deny the second process access and the host then exits before PGlite
// finishes initializing. Its profile contains no business data.
if (runEmbeddedServer) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disable-http-cache");
}

/**
 * The local server has two bundled locations in a release build.  The normal
 * location is an Electron extra resource; the unpacked-app copy is a fallback
 * that keeps an offline installation usable even if a packaging tool changes
 * how extra resources are laid out.  Do not download this runtime at startup.
 */
function localRuntimeRoot(): string | null {
  const candidates = [
    resolve(process.resourcesPath, "server-runtime"),
    resolve(process.resourcesPath, "app.asar.unpacked", "server-runtime"),
    // Development runs keep the prepared runtime beside dist-electron.
    resolve(import.meta.dirname, "../server-runtime"),
  ];
  return candidates.find((candidate) =>
    existsSync(resolve(candidate, "runner.mjs"))
    && existsSync(resolve(candidate, "server-bundle.mjs"))
    && existsSync(resolve(candidate, "pglite", "dist", "index.js")),
  ) ?? null;
}

function localDataRoot(): string { return resolve(app.getPath("userData"), "local-data"); }
function cloudflareConnectionPath(): string { return resolve(localDataRoot(), "runtime", "cloudflare-connection.json"); }
function desktopDiagnosticLogPath(): string { return resolve(app.getPath("userData"), "startup-diagnostics.log"); }

/**
 * Startup must remain usable when the local host fails. Keep a short
 * diagnostic record outside the installed application and never include
 * configuration contents, passwords, tokens, or business data in it.
 */
async function recordStartupDiagnostic(scope: string, cause: unknown): Promise<void> {
  try {
    const message = cause instanceof Error ? cause.message : String(cause);
    const safeMessage = message.replace(/[\r\n]+/gu, " ").slice(0, 1_200);
    await mkdir(dirname(desktopDiagnosticLogPath()), { recursive: true });
    await appendFile(
      desktopDiagnosticLogPath(),
      `${new Date().toISOString()} [${scope}] ${safeMessage}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostics are strictly best-effort and must never block POS startup.
  }
}

function bundledCloudflaredPath(): string | null {
  const candidates = [
    resolve(process.resourcesPath, "cloudflared", "cloudflared.exe"),
    resolve(process.resourcesPath, "app.asar.unpacked", "cloudflared", "cloudflared.exe"),
    resolve(import.meta.dirname, "../build/cloudflared/cloudflared.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function defaultCloudflareConnection(): CloudflareConnection {
  return { enabled: false, autoStart: false, publicApiUrl: "", cloudCoreUrl: "" };
}

async function readCloudflareConnection(): Promise<CloudflareConnection> {
  try {
    const value = JSON.parse((await readFile(cloudflareConnectionPath(), "utf8")).replace(/^\uFEFF/, "")) as Partial<CloudflareConnection>;
    return {
      enabled: value.enabled === true,
      autoStart: value.autoStart === true,
      ...(typeof value.tunnelToken === "string" ? { tunnelToken: value.tunnelToken } : {}),
      ...(typeof value.commerceSharedSecret === "string" ? { commerceSharedSecret: value.commerceSharedSecret } : {}),
      ...(typeof value.terminalRelaySharedSecret === "string" ? { terminalRelaySharedSecret: value.terminalRelaySharedSecret } : {}),
      terminalRelayUrl: typeof value.terminalRelayUrl === "string" ? value.terminalRelayUrl : "",
      publicApiUrl: typeof value.publicApiUrl === "string" ? value.publicApiUrl : "",
      cloudCoreUrl: typeof value.cloudCoreUrl === "string" ? value.cloudCoreUrl : "",
      ...(typeof value.cloudStoreId === "string" ? { cloudStoreId: value.cloudStoreId } : {}),
      ...(typeof value.cloudMigrationKey === "string" ? { cloudMigrationKey: value.cloudMigrationKey } : {}),
      ...(typeof value.cloudMigrationId === "string" ? { cloudMigrationId: value.cloudMigrationId } : {}),
      ...(value.cloudMigrationState === "PENDING" || value.cloudMigrationState === "IMPORTED" ? { cloudMigrationState: value.cloudMigrationState } : {}),
    };
  } catch {
    return defaultCloudflareConnection();
  }
}

function cloudflareConnectionView(value: CloudflareConnection): CloudflareConnectionView {
  const cloudflaredBundled = Boolean(bundledCloudflaredPath());
  const tunnelTokenConfigured = Boolean(value.tunnelToken && value.tunnelToken.length >= 32);
  const commerceSecretConfigured = Boolean(value.commerceSharedSecret && value.commerceSharedSecret.length >= 32);
  const terminalRelaySecretConfigured = Boolean(value.terminalRelaySharedSecret && value.terminalRelaySharedSecret.length >= 32);
  return {
    enabled: value.enabled,
    autoStart: value.autoStart,
    configured: value.enabled && tunnelTokenConfigured && commerceSecretConfigured && cloudflaredBundled,
    tunnelTokenConfigured,
    commerceSecretConfigured,
    terminalRelaySecretConfigured,
    terminalRelayUrl: value.terminalRelayUrl ?? "",
    cloudflaredBundled,
    publicApiUrl: value.publicApiUrl ?? "",
    cloudCoreUrl: value.cloudCoreUrl || DEFAULT_CLOUD_CORE_URL,
    cloudStoreConfigured: Boolean(value.cloudCoreUrl && value.cloudStoreId && value.cloudMigrationKey),
    cloudMigrationState: value.cloudMigrationState ?? (value.cloudStoreId && value.cloudMigrationKey ? "PENDING" : "NOT_STARTED"),
    running: Boolean(cloudflareTunnelProcess && !cloudflareTunnelProcess.killed),
  };
}

async function saveCloudflareConnection(update: {
  enabled: boolean;
  autoStart: boolean;
  tunnelToken?: string | undefined;
  commerceSharedSecret?: string | undefined;
  terminalRelaySharedSecret?: string | undefined;
  terminalRelayUrl?: string | undefined;
  publicApiUrl?: string | undefined;
  cloudCoreUrl?: string | undefined;
  cloudStoreId?: string | undefined;
  cloudMigrationKey?: string | undefined;
  cloudMigrationId?: string | undefined;
  cloudMigrationState?: "PENDING" | "IMPORTED" | undefined;
}): Promise<CloudflareConnection> {
  const current = await readCloudflareConnection();
  const next: CloudflareConnection = {
    enabled: update.enabled,
    autoStart: update.autoStart,
    tunnelToken: update.tunnelToken?.trim() || current.tunnelToken,
    commerceSharedSecret: update.commerceSharedSecret?.trim() || current.commerceSharedSecret,
    terminalRelaySharedSecret: update.terminalRelaySharedSecret?.trim() || current.terminalRelaySharedSecret,
    terminalRelayUrl: update.terminalRelayUrl?.trim() ?? current.terminalRelayUrl ?? "",
    publicApiUrl: update.publicApiUrl?.trim() ?? current.publicApiUrl ?? "",
    cloudCoreUrl: update.cloudCoreUrl?.trim() ?? current.cloudCoreUrl ?? "",
    cloudStoreId: update.cloudStoreId?.trim() || current.cloudStoreId,
    cloudMigrationKey: update.cloudMigrationKey?.trim() || current.cloudMigrationKey,
    cloudMigrationId: update.cloudMigrationId?.trim() || current.cloudMigrationId,
    cloudMigrationState: update.cloudMigrationState ?? current.cloudMigrationState,
  };
  if (next.enabled && (!next.tunnelToken || next.tunnelToken.length < 32 || !next.commerceSharedSecret || next.commerceSharedSecret.length < 32)) {
    throw { code: "CLOUDFLARE_CONNECTION_INCOMPLETE", messageAr: "فعّل الاتصال بعد إدخال رمز النفق ومفتاح تطبيق العملاء بطول صحيح." };
  }
  await mkdir(dirname(cloudflareConnectionPath()), { recursive: true });
  await writeFile(cloudflareConnectionPath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return next;
}

async function stopCloudflareTunnel(): Promise<void> {
  if (cloudflareTunnelRetryTimer) clearTimeout(cloudflareTunnelRetryTimer);
  cloudflareTunnelRetryTimer = null;
  cloudflareTunnelRetryDelayMs = 5_000;
  const current = cloudflareTunnelProcess;
  cloudflareTunnelProcess = null;
  if (current && !current.killed) current.kill();
}

/**
 * Cloudflare is an optional remote path.  In particular, a lost Internet
 * connection must never take down the local PGlite host, delay a sale, or
 * make the visible desktop wait.  Retry the tunnel independently and with a
 * bounded backoff; the next successful connection resets the delay.
 */
function scheduleCloudflareTunnelRetry(): void {
  if (appIsQuitting || cloudflareTunnelRetryTimer || process.env.NODE_ENV === "test") return;
  const delay = cloudflareTunnelRetryDelayMs;
  cloudflareTunnelRetryDelayMs = Math.min(cloudflareTunnelRetryDelayMs * 2, 5 * 60_000);
  cloudflareTunnelRetryTimer = setTimeout(() => {
    cloudflareTunnelRetryTimer = null;
    void startCloudflareTunnel().catch((error) => {
      console.error("[nabta-cloudflare] background tunnel retry failed", error);
      scheduleCloudflareTunnelRetry();
    });
  }, delay);
  cloudflareTunnelRetryTimer.unref();
}

async function startCloudflareTunnel(restart = false): Promise<CloudflareConnectionView> {
  if (process.env.NODE_ENV === "test") return cloudflareConnectionView(await readCloudflareConnection());
  if (restart) await stopCloudflareTunnel();
  const connection = await readCloudflareConnection();
  const view = cloudflareConnectionView(connection);
  if (!connection.enabled || !connection.tunnelToken || !view.cloudflaredBundled) return view;
  if (cloudflareTunnelProcess && !cloudflareTunnelProcess.killed) return cloudflareConnectionView(connection);
  const executable = bundledCloudflaredPath();
  if (!executable) return view;
  const child = spawn(executable, ["tunnel", "run", "--token", connection.tunnelToken], { windowsHide: true, stdio: "ignore" });
  cloudflareTunnelProcess = child;
  child.once("error", (error) => {
    console.error("[nabta-cloudflare] tunnel start failed", error);
    if (cloudflareTunnelProcess === child) cloudflareTunnelProcess = null;
    scheduleCloudflareTunnelRetry();
  });
  child.once("exit", (code) => {
    if (cloudflareTunnelProcess === child) cloudflareTunnelProcess = null;
    if (code && code !== 0) console.error(`[nabta-cloudflare] tunnel exited with ${code}`);
    if (!appIsQuitting) scheduleCloudflareTunnelRetry();
  });
  cloudflareTunnelRetryDelayMs = 5_000;
  return cloudflareConnectionView(connection);
}

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
  if (process.env.NODE_ENV === "test") return { serverUrl: "http://127.0.0.1:7443", certificateFingerprint: "" };
  // Each installation receives exactly one terminal identity.  It is stored in
  // userData (outside the app bundle), so updates keep the same local till.
  try {
    const saved = JSON.parse(await readFile(configPath(), "utf8")) as Partial<DesktopConfig>;
    if (typeof saved.terminalId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.terminalId)) {
      if (saved.deviceMode === "SECONDARY" && typeof saved.serverUrl === "string" && /^https:\/\//i.test(saved.serverUrl) && typeof saved.terminalRelayKey === "string" && saved.terminalRelayKey.length >= 32) {
        return { serverUrl: saved.serverUrl, terminalId: saved.terminalId, certificateFingerprint: saved.certificateFingerprint ?? "", deviceMode: "SECONDARY", terminalRelayKey: saved.terminalRelayKey };
      }
      return { serverUrl: LOCAL_SERVER_URL, terminalId: saved.terminalId, certificateFingerprint: "", deviceMode: "PRIMARY" };
    }
  } catch {
    // A first installation has no local identity file yet.
  }
  // Keep an existing installation on its old identity.  Fresh installations
  // have no local database yet and receive a newly generated UUID instead.
  const existingLocalData = existsSync(resolve(app.getPath("userData"), "local-data", "pglite"));
  const created: DesktopConfig = {
    serverUrl: LOCAL_SERVER_URL,
    terminalId: existingLocalData ? LEGACY_LOCAL_TERMINAL_ID : randomUUID(),
    certificateFingerprint: "", deviceMode: "PRIMARY",
  };
  await saveDesktopConfig(created);
  return created;
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
    if (desktopConfig?.deviceMode === "SECONDARY") {
      try {
        const response = await net.fetch(new URL("/v1/health", desktopConfig.serverUrl).toString(), { headers: { "X-Nabta-Terminal-Key": desktopConfig.terminalRelayKey ?? "" } });
        if (!response.ok) throw new Error("remote health failed");
        return;
      } catch {
        throw { code: "REMOTE_PRIMARY_UNAVAILABLE", messageAr: "تعذر الاتصال بالجهاز الرئيسي عبر Cloudflare. تأكد أن الجهاز الرئيسي ونفق Cloudflare يعملان." };
      }
    }
    const healthy = async (): Promise<boolean> => {
      try { return (await net.fetch(`${LOCAL_SERVER_URL}/v1/health`)).ok; }
      catch { return false; }
    };
    if (await healthy()) {
      localHostWasReady = true;
      localHostRecoveryAttempts = 0;
      return;
    }
    if (!desktopConfig?.terminalId) throw { code: "LOCAL_TERMINAL_UNAVAILABLE", messageAr: "تعذر إنشاء معرّف نقطة البيع المحلي. أعد تشغيل البرنامج." };
    if (!localRuntimeRoot()) {
      throw { code: "LOCAL_RUNTIME_MISSING", messageAr: "ملفات بيانات نبتة غير مكتملة. أعد تثبيت البرنامج." };
    }
    const cloudflare = await readCloudflareConnection();
    let startupFailure: Error | null = null;
    let recentServerError = "";
    const recoveryArchive = pendingLocalRecoveryArchive;
    const child = spawn(process.execPath, ["--run-server"], {
      detached: true,
      // The renderer must not depend on a console window. Retain only a
      // short tail of stderr so a failed bundled runtime can be diagnosed.
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // Keep the background Electron host's Chromium profile separate from
        // the foreground app. The actual POS database remains in
        // NABTA_LOCAL_DATA_DIR and is deliberately not moved or recreated.
        NABTA_USER_DATA_DIR: resolve(localDataRoot(), "host-electron-profile"),
        NABTA_LOCAL_MODE: "1",
        NABTA_LOCAL_DATA_DIR: resolve(app.getPath("userData"), "local-data"),
        NABTA_LOCAL_TERMINAL_ID: desktopConfig.terminalId,
        NABTA_LOCAL_PORT: String(LOCAL_SERVER_PORT),
        ...(recoveryArchive ? { NABTA_RECOVERY_ARCHIVE: recoveryArchive } : {}),
        ...(cloudflare.terminalRelaySharedSecret ? { TERMINAL_RELAY_SHARED_SECRET: cloudflare.terminalRelaySharedSecret } : {}),
        // This is deliberately outside the application and live database directories.
        // The owner can copy the resulting archives to an encrypted external drive.
        BACKUP_DIR: resolve(app.getPath("documents"), "Nabta Backups"),
      },
    });
    child.unref();
    localHostProcess = child;
    hostProcessStarted = true;
    child.stderr?.on("data", (chunk: Buffer) => {
      recentServerError = `${recentServerError}${chunk.toString("utf8")}`.slice(-1_200);
    });
    child.once("error", (error) => {
      startupFailure = error;
      void recordStartupDiagnostic("local-host-spawn", error);
    });
    child.once("exit", (code, signal) => {
      const wasReady = localHostWasReady;
      const wasCurrentHost = localHostProcess === child;
      if (!startupFailure) {
        const detail = recentServerError.replace(/[\r\n]+/gu, " ").trim();
        startupFailure = new Error(`embedded host exited before readiness (code=${code ?? "none"}, signal=${signal ?? "none"})${detail ? `: ${detail}` : ""}`);
      }
      if (wasCurrentHost) {
        localHostProcess = null;
        hostProcessStarted = false;
        hostStartPromise = null;
        localHostWasReady = false;
      }
      void recordStartupDiagnostic("local-host-exit", startupFailure);
      // A host that was already serving the POS may be stopped by a transient
      // local service failure. Retry exactly once without touching its data;
      // repeated failures remain visible to the recovery screen instead of
      // looping silently.
      if (wasCurrentHost && wasReady && !appIsQuitting && localHostRecoveryAttempts < 1) {
        localHostRecoveryAttempts += 1;
        setTimeout(() => {
          void startLocalEmbeddedServer().catch((error) => void recordStartupDiagnostic("local-host-auto-restart", error));
        }, 1_500).unref();
      }
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await healthy()) {
        if (recoveryArchive && pendingLocalRecoveryArchive === recoveryArchive) pendingLocalRecoveryArchive = null;
        localHostWasReady = true;
        localHostRecoveryAttempts = 0;
        // The POS is ready as soon as its local host is ready.  Do not tie
        // the cashier to DNS, the Internet, or Cloudflare tunnel startup.
        void startCloudflareTunnel().catch((error) => {
          console.error("[nabta-cloudflare] optional tunnel start deferred", error);
          scheduleCloudflareTunnelRetry();
        });
        return;
      }
      if (startupFailure) {
        hostProcessStarted = false;
        throw {
          code: "LOCAL_DATA_START_FAILED",
          messageAr: "تعذر تشغيل بيانات نبتة المحلية. افتح شاشة المحاولة مرة أخرى، وسجّل التشخيص محفوظ تلقائيًا دون لمس بياناتك.",
        };
      }
      await new Promise<void>((done) => setTimeout(done, 250));
    }
    hostProcessStarted = false;
    throw { code: "LOCAL_DATA_START_FAILED", messageAr: "تعذر تجهيز بيانات نبتة المحلية. أغلق البرنامج ثم افتحه مرة أخرى." };
  })();
  try { await hostStartPromise; }
  catch (error) { hostStartPromise = null; throw error; }
}

async function restartLocalEmbeddedServer(): Promise<void> {
  if (desktopConfig?.deviceMode === "SECONDARY") return;
  const current = localHostProcess;
  localHostProcess = null;
  hostProcessStarted = false;
  localHostWasReady = false;
  hostStartPromise = null;
  if (current && !current.killed) current.kill();
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await startLocalEmbeddedServer();
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
    case "host.recovery.restore": throw new Error("host recovery is handled in the desktop process");
    case "cloudflare.connection.get": throw new Error("Cloudflare connection is handled in the desktop process");
    case "cloudflare.connection.update": throw new Error("Cloudflare connection is handled in the desktop process");
    case "cloud.migration.run": throw new Error("Cloud migration is handled in the desktop process");
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
      if (request.payload.unitKind) params.set("unitKind", request.payload.unitKind);
      if (request.payload.limit) params.set("limit", String(request.payload.limit));
      if (request.payload.cursor) params.set("cursor", request.payload.cursor);
      return { method: "GET", path: `/v1/catalog?${params}` };
    }
    case "products.reference.lookup": return { method: "GET", path: `/v1/product-references/${encodeURIComponent(request.payload.barcode)}` };
    case "products.barcode.generate": return { method: "POST", path: "/v1/product-barcodes/generate" };
    case "products.barcode.attach": return { method: "POST", path: `/v1/products/${request.payload.productId}/barcodes`, body: { barcode: request.payload.barcode } };
    case "weighted-labels.create": return { method: "POST", path: "/v1/weighted-labels", body: request.payload };
    case "weighted-labels.list": return { method: "GET", path: `/v1/weighted-labels${request.payload.productId ? `?productId=${encodeURIComponent(request.payload.productId)}` : ""}` };
    case "weighted-labels.resolve": return { method: "GET", path: `/v1/weighted-labels/${request.payload.barcode}` };
    case "weighted-labels.mark-printed": return { method: "POST", path: "/v1/weighted-labels/printed", body: request.payload };
    case "products.create": return { method: "POST", path: "/v1/products", body: request.payload };
    case "products.price.update": return { method: "PUT", path: `/v1/products/${request.payload.productId}/price`, body: { priceMinor: request.payload.priceMinor, wholesalePriceMinor: request.payload.wholesalePriceMinor } };
    case "products.update": return { method: "PUT", path: `/v1/products/${request.payload.productId}`, body: {
      nameAr: request.payload.nameAr,
      category: request.payload.category,
      description: request.payload.description,
      priceMinor: request.payload.priceMinor,
      wholesalePriceMinor: request.payload.wholesalePriceMinor,
      purchasePackSize: request.payload.purchasePackSize,
      cartonPriceMinor: request.payload.cartonPriceMinor,
      cartonContentsUnit: request.payload.cartonContentsUnit,
      retailPackage: request.payload.retailPackage,
      barcodeMappings: request.payload.barcodeMappings,
      mergeLegacyProducts: request.payload.mergeLegacyProducts,
      availableQtyMilli: request.payload.availableQtyMilli,
      expectedStockVersion: request.payload.expectedStockVersion,
    } };
    case "products.archive": return { method: "DELETE", path: `/v1/products/${request.payload.productId}` };
    case "products.export": {
      const params = new URLSearchParams();
      if (request.payload?.mode) params.set("mode", request.payload.mode);
      if (request.payload?.query) params.set("query", request.payload.query);
      if (request.payload?.availableOnly) params.set("availableOnly", "true");
      for (const productId of request.payload?.productIds ?? []) params.append("productIds", productId);
      const suffix = params.size ? `?${params}` : "";
      return { method: "GET", path: `/v1/products/export-data${suffix}` };
    }
    case "products.sync-workbook.export": {
      const params = new URLSearchParams({ mode: "INTERNAL" });
      if (request.payload?.query) params.set("query", request.payload.query);
      if (request.payload?.availableOnly) params.set("availableOnly", "true");
      for (const productId of request.payload?.productIds ?? []) params.append("productIds", productId);
      return { method: "GET", path: `/v1/products/export-data?${params}` };
    }
    case "products.import-workbook": throw new Error("Workbook imports are handled in the desktop process.");
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
    case "stock.expiry.export-xlsx": return { method: "GET", path: `/v1/stock-expiry?days=${request.payload.days}` };
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
    case "shop-consumptions.list": return { method: "GET", path: `/v1/shop-consumptions?from=${encodeURIComponent(request.payload.from)}&to=${encodeURIComponent(request.payload.to)}` };
    case "payroll.list": return { method: "GET", path: `/v1/payroll?month=${encodeURIComponent(request.payload.month)}` };
    case "payroll.create": return { method: "POST", path: "/v1/payroll", body: request.payload };
    case "financial-periods.list": return { method: "GET", path: "/v1/financial-periods" };
    case "financial-periods.close": return { method: "POST", path: "/v1/financial-periods/close", body: request.payload };
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
    case "payments.settings.get": return { method: "GET", path: `/v1/payments/settings?provider=${encodeURIComponent(request.payload?.provider ?? "KASHIER")}` };
    case "payments.settings.update": return { method: "PUT", path: "/v1/payments/settings", body: request.payload };
    case "payments.devices.list": return { method: "GET", path: `/v1/payments/devices?provider=${encodeURIComponent(request.payload?.provider ?? "KASHIER")}` };
    case "payments.devices.bind": return { method: "PUT", path: "/v1/payments/devices", body: request.payload };
    case "payments.methods.refresh": return { method: "POST", path: "/v1/payments/methods/refresh", body: request.payload };
    case "payments.intents.create": return { method: "POST", path: "/v1/payments/intents", body: request.payload };
    case "payments.intents.get": return { method: "GET", path: `/v1/payments/intents/${request.payload.intentId}` };
    case "payments.intents.verify": return { method: "POST", path: `/v1/payments/intents/${request.payload.intentId}/verify` };
    case "payments.intents.cancel": return { method: "POST", path: `/v1/payments/intents/${request.payload.intentId}/cancel` };
    case "payments.reconcile": return { method: "POST", path: "/v1/payments/reconcile", body: request.payload };
    case "commerce.orders.list": {
      const status = request.payload?.status;
      return { method: "GET", path: `/v1/commerce/admin/orders${status ? `?status=${encodeURIComponent(status)}` : ""}` };
    }
    case "commerce.orders.update": return { method: "PUT", path: `/v1/commerce/admin/orders/${request.payload.orderId}`, body: { status: request.payload.status, ...(request.payload.note ? { note: request.payload.note } : {}) } };
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
    case "reports.summary":
    case "reports.comprehensive": {
      const params = new URLSearchParams(Object.entries(request.payload).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      return { method: "GET", path: `/v1/reports/${request.operation === "reports.summary" ? "summary" : "comprehensive"}?${params}` };
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
    case "reports.export-xlsx":
    case "reorder-list.print":
    case "reorder-list.export-pdf":
    case "partners.export-pdf":
    case "hardware.settings.get":
    case "hardware.settings.save":
    case "hardware.settings.restore":
    case "hardware.printers.list":
    case "hardware.serial.list":
    case "hardware.receipt.print":
    case "hardware.delivery-order.print":
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
    case "config.set":
    case "multi-terminal.join":
    case "multi-terminal.primary.enable": throw new Error("config operation is local");
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

async function exportExpiryXlsx(data: ExpiryWorkbookData): Promise<{ cancelled: boolean; path?: string; itemCount: number }> {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const options = { title: "حفظ تنبيه الصلاحية بصيغة Excel", defaultPath: resolve(app.getPath("documents"), `تنبيه صلاحية نبتة ${date}.xlsx`), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, itemCount: data.lots.length };
  await writeFile(destination.filePath, await createExpiryWorkbook(data));
  return { cancelled: false, path: destination.filePath, itemCount: data.lots.length };
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

async function exportProductSyncWorkbook(data: ProductExcelExportResponse): Promise<{ cancelled: boolean; path?: string; itemCount: number }> {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(data.generatedAt));
  const options = { title: "حفظ قالب تعديل الأصناف", defaultPath: resolve(app.getPath("documents"), `تعديل أصناف ${data.storeName} ${date}.xlsx`), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, itemCount: data.items.length };
  await writeFile(destination.filePath, await createProductSyncWorkbook(data));
  return { cancelled: false, path: destination.filePath, itemCount: data.items.length };
}

async function exportShiftsXlsx(data: ShiftHistoryExcelExportResponse): Promise<{ cancelled: boolean; path?: string; itemCount: number }> {
  const options = { title: "حفظ سجل الورديات بصيغة Excel", defaultPath: resolve(app.getPath("documents"), `ورديات ${data.storeName} ${data.month}.xlsx`), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true, itemCount: data.items.length };
  await writeFile(destination.filePath, await createShiftsWorkbook(data));
  return { cancelled: false, path: destination.filePath, itemCount: data.items.length };
}

async function exportComprehensiveReportXlsx(data: ComprehensiveReportResponse): Promise<{ cancelled: boolean; path?: string }> {
  const options = {
    title: "حفظ التقرير التشغيلي الشامل بصيغة Excel",
    defaultPath: resolve(app.getPath("documents"), `تقرير شامل ${data.storeName} ${data.period.from} - ${data.period.to}.xlsx`),
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  };
  const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  await writeFile(destination.filePath, await createComprehensiveReportWorkbook(data));
  return { cancelled: false, path: destination.filePath };
}

type ApiRoute = ReturnType<typeof apiPath>;

async function callApiRoute(route: ApiRoute, responseType: "json" | "text" = "json"): Promise<unknown> {
  if (!desktopConfig) throw { code: "SERVER_NOT_CONFIGURED", messageAr: "أدخل عنوان خادم المتجر أولًا" };
  const url = new URL(route.path, desktopConfig.serverUrl).toString();
  const headers: Record<string, string> = { Accept: "application/json", ...route.headers };
  if (desktopConfig.deviceMode === "SECONDARY" && desktopConfig.terminalRelayKey) headers["X-Nabta-Terminal-Key"] = desktopConfig.terminalRelayKey;
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

type CloudMigrationManifestView = { migrationId: string; chunkCount: number; recordCount: number; backup: { id: string; sha256: string } };

function reportCloudMigration(progress: CloudMigrationProgress): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("nabta:cloud-migration-progress", progress);
}

function cloudFailureMessage(cause: unknown): string {
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "تعذر العثور على عنوان نبتة السحابي عبر DNS. تحقق من الإنترنت أو DNS على الجهاز ثم أعد المحاولة.";
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return "تعذر الاتصال بخدمة نبتة السحابية في الوقت المحدد. تحقق من الإنترنت أو الحماية على الجهاز ثم أعد المحاولة.";
  return "تعذر الوصول إلى خدمة نبتة السحابية. ستبقى النسخة المحلية سليمة ويمكن استكمال النقل لاحقًا.";
}

async function cloudFetch(url: string, init: Parameters<typeof net.fetch>[1]): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await net.fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    throw { code: "CLOUD_UNAVAILABLE", messageAr: cloudFailureMessage(cause) };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyCloudCore(cloudUrl: string): Promise<string> {
  let base: URL;
  try {
    base = new URL(cloudUrl);
  } catch {
    throw { code: "CLOUD_URL_INVALID", messageAr: "رابط نبتة السحابي غير صحيح." };
  }
  if (base.protocol !== "https:") throw { code: "CLOUD_URL_HTTPS_REQUIRED", messageAr: "رابط نبتة السحابي يجب أن يكون HTTPS." };
  reportCloudMigration({ phase: "CHECKING_DNS", percent: 4, messageAr: "يتم التحقق من DNS للرابط السحابي…" });
  try {
    const addresses = await lookup(base.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) throw new Error("no addresses");
  } catch {
    throw { code: "CLOUD_DNS_UNAVAILABLE", messageAr: "تعذر العثور على رابط نبتة السحابي عبر DNS. تحقق من اتصال الإنترنت وDNS على الجهاز ثم أعد المحاولة." };
  }
  reportCloudMigration({ phase: "CHECKING_CLOUD", percent: 8, messageAr: "يتم اختبار الوصول الآمن إلى نبتة السحابية…" });
  const response = await cloudFetch(new URL("/v1/cloud/health", base).toString(), { method: "GET", headers: { Accept: "application/json" } });
  const health = await response.json().catch(() => null) as { status?: unknown } | null;
  if (!response.ok || health?.status !== "ok") throw { code: "CLOUD_HEALTH_FAILED", messageAr: "الرابط السحابي استجاب لكن خدمة نبتة غير جاهزة. تحقق من Worker ثم أعد المحاولة." };
  return base.toString().replace(/\/$/, "");
}

async function localCloudMigrationRequest(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  if (!desktopConfig || desktopConfig.deviceMode === "SECONDARY" || desktopConfig.serverUrl !== LOCAL_SERVER_URL) {
    throw { code: "CLOUD_MIGRATION_SOURCE_DEVICE_REQUIRED", messageAr: "نفّذ نقل البيانات من جهاز نبتة الذي يحتوي على قاعدة البيانات الأصلية فقط." };
  }
  if (!authToken) throw { code: "AUTH_REQUIRED", messageAr: "سجّل الدخول بحساب المالك قبل نقل البيانات." };
  const response = await net.fetch(new URL(path, LOCAL_SERVER_URL).toString(), {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${authToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw { code: "LOCAL_DATA_UNAVAILABLE", messageAr: "لا يمكن الوصول إلى بيانات نبتة المحلية على هذا الجهاز." }; });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw data ?? { code: "CLOUD_MIGRATION_PREPARE_FAILED", messageAr: "تعذر تجهيز بيانات النقل." };
  return data;
}

async function cloudMigrationRequest(cloudUrl: string, path: string, method: "GET" | "POST", key: string, body?: unknown): Promise<unknown> {
  const base = new URL(cloudUrl);
  if (base.protocol !== "https:") throw { code: "CLOUD_URL_HTTPS_REQUIRED", messageAr: "رابط نبتة السحابي يجب أن يكون HTTPS." };
  const response = await cloudFetch(new URL(path, base).toString(), {
    method,
    headers: { Accept: "application/json", "X-Nabta-Cloud-Migration-Key": key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw data ?? { code: "CLOUD_MIGRATION_UPLOAD_FAILED", messageAr: "رفضت الخدمة السحابية دفعة نقل البيانات." };
  return data;
}

type CloudExpiryMutation = {
  eventId: string;
  operation: "EXPIRY_REGISTERED";
  actorUserId: string;
  idempotencyKey: string;
  payload: { productId: string; qtyMilli: number; expiresOn: string; lotCode?: string | null };
};

/**
 * Keeps the cloud terminal directory in sync with the terminal list embedded
 * in the verified migration snapshot.  It is safe to call repeatedly: the
 * directory performs an UPSERT for every terminal id.  This repairs older
 * imports that finished before the directory write was available, without
 * uploading or changing any sale, inventory, or local database data.
 */
async function repairCloudTerminalDirectory(): Promise<void> {
  if (!authToken || !desktopConfig || desktopConfig.deviceMode === "SECONDARY" || desktopConfig.serverUrl !== LOCAL_SERVER_URL) return;
  const connection = await readCloudflareConnection();
  if (!connection.cloudCoreUrl || !connection.cloudStoreId || !connection.cloudMigrationKey || connection.cloudMigrationState !== "IMPORTED") return;
  await cloudMigrationRequest(
    connection.cloudCoreUrl,
    `/v1/cloud/stores/${connection.cloudStoreId}/terminals/register`,
    "POST",
    connection.cloudMigrationKey,
    {},
  );
}

/**
 * The cloud core deliberately queues only expiry reclassification while the
 * primary Windows device is offline.  Replaying to the normal local endpoint
 * retains all local stock checks and uses the original idempotency key before
 * the cloud event is acknowledged.  A failed replay remains queued safely.
 */
async function reconcileCloudExpiryMutations(): Promise<void> {
  if (!authToken || !desktopConfig || desktopConfig.deviceMode === "SECONDARY" || desktopConfig.serverUrl !== LOCAL_SERVER_URL) return;
  const connection = await readCloudflareConnection();
  if (!connection.cloudCoreUrl || !connection.cloudStoreId || !connection.cloudMigrationKey) return;
  await repairCloudTerminalDirectory();
  const base = `/v1/cloud/stores/${connection.cloudStoreId}/mutations`;
  const pending = await cloudMigrationRequest(connection.cloudCoreUrl, `${base}/pending?after=0&limit=100`, "GET", connection.cloudMigrationKey) as { events?: unknown[]; hasMore?: boolean };
  const events = (pending.events ?? []).filter((candidate): candidate is CloudExpiryMutation => {
    if (!candidate || typeof candidate !== "object") return false;
    const event = candidate as Record<string, unknown>;
    const payload = event.payload as Record<string, unknown> | null;
    return event.operation === "EXPIRY_REGISTERED" && typeof event.eventId === "string" && typeof event.actorUserId === "string"
      && typeof event.idempotencyKey === "string" && Boolean(payload) && typeof payload?.productId === "string"
      && typeof payload?.qtyMilli === "number" && typeof payload?.expiresOn === "string";
  });
  if (events.length === 0) return;
  const appliedEventIds: string[] = [];
  for (const event of events) {
    try {
      await callApiRoute({
        method: "POST",
        path: "/v1/stock-lots/expiry-registration",
        body: event.payload,
        headers: {
          "Idempotency-Key": event.idempotencyKey,
          "X-Nabta-Cloud-Event-Id": event.eventId,
          "X-Nabta-Cloud-Actor-Id": event.actorUserId,
        },
      });
      appliedEventIds.push(event.eventId);
    } catch (error) {
      // Do not acknowledge a partial batch. The cloud durable object keeps
      // it for the next signed-in primary-device reconciliation.
      console.error("[nabta-cloud] expiry reconciliation deferred", error);
      break;
    }
  }
  if (appliedEventIds.length > 0) {
    await cloudMigrationRequest(connection.cloudCoreUrl, `${base}/ack`, "POST", connection.cloudMigrationKey, { eventIds: appliedEventIds });
  }
}

function startCloudReconciliation(): void {
  if (cloudReconciliationTimer || process.env.NODE_ENV === "test") return;
  const run = () => void reconcileCloudExpiryMutations().catch((error) => console.error("[nabta-cloud] expiry reconciliation failed", error));
  run();
  cloudReconciliationTimer = setInterval(run, 60_000);
}

function stopCloudReconciliation(): void {
  if (cloudReconciliationTimer) clearInterval(cloudReconciliationTimer);
  cloudReconciliationTimer = null;
}

function purchasePrintRequestFromInvoice(invoice: InvoiceDetailResponse, storeName: string): PurchaseReceiptPrintRequest {
  if (invoice.kind !== "PURCHASE") throw new Error("A mobile print job must reference a purchase receipt");
  return {
    storeName: storeName.trim().length >= 2 ? storeName : "نبتة",
    receipt: {
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      supplierName: invoice.partyName,
      supplierPhone: invoice.partyPhone,
      postedAt: invoice.postedAt,
      goodsMinor: invoice.subtotalMinor ?? invoice.totalMinor - (invoice.supplyExpensesMinor ?? 0),
      supplyExpensesMinor: invoice.supplyExpensesMinor ?? 0,
      totalMinor: invoice.totalMinor,
      receiverName: invoice.cashierOrReceiverName,
      lines: invoice.lines.map((line) => ({
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
  };
}

function salePrintRequestFromInvoice(invoice: InvoiceDetailResponse, storeName: string): ReceiptPrintRequest {
  if (invoice.kind !== "SALE") throw new Error("A mobile sale print job must reference a sale");
  return {
    storeName: storeName.trim().length >= 2 ? storeName : "نبتة",
    copies: 1,
    sale: {
      saleId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      postedAt: invoice.postedAt,
      subtotalMinor: invoice.subtotalMinor ?? invoice.totalMinor,
      discountMinor: invoice.discountMinor,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      changeMinor: invoice.changeMinor,
      lines: invoice.lines.map((line) => ({
        productId: line.productId,
        nameAr: line.nameAr,
        unitKind: line.unitKind,
        saleUnit: line.saleUnit ?? "UNIT",
        ...(line.packageSize && line.packageSize >= 2 ? { packageSize: line.packageSize } : {}),
        qtyMilli: line.qtyMilli,
        // Invoice details hold the final value per line.  The invoice-level
        // discount remains visible in the receipt summary and is not applied twice.
        unitPriceMinor: line.qtyMilli > 0 ? Math.max(0, Math.round((line.totalMinor * 1000) / line.qtyMilli)) : 0,
        grossMinor: line.totalMinor,
        discountMinor: 0,
        netMinor: line.totalMinor,
        stockVersion: 0,
      })),
    },
  };
}

/** Claim at most one mobile-originated receipt at a time.  A claimed job is
 * finished as PRINTED or FAILED and is never retried in the background, so an
 * unknown printer outcome cannot silently create duplicate paper copies. */
async function processMobilePurchasePrintQueue(): Promise<void> {
  if (mobilePrintQueueBusy || !authToken || !desktopConfig || desktopConfig.deviceMode === "SECONDARY" || desktopConfig.serverUrl !== LOCAL_SERVER_URL) return;
  mobilePrintQueueBusy = true;
  try {
    const claimed = await callApiRoute({ method: "GET", path: "/v1/mobile-print-jobs/next", headers: {} } as ApiRoute) as { job?: { id: string; kind: "PURCHASE" | "SALE" | "WEIGHTED_LABEL"; documentId: string } | null };
    const job = claimed.job;
    if (!job) return;
    try {
      if (job.kind === "WEIGHTED_LABEL") {
        const payload = await callApiRoute({ method: "GET", path: `/v1/weighted-labels/${encodeURIComponent(job.documentId)}`, headers: {} } as ApiRoute) as { label: { barcode: string; nameAr: string; weightUnit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER"; qtyMilli: number; totalMinor: number } };
        const unit = payload.label.weightUnit === "KILOGRAM" ? "كجم" : payload.label.weightUnit === "GRAM" ? "جم" : payload.label.weightUnit === "LITER" ? "لتر" : "مل";
        const quantity = payload.label.weightUnit === "KILOGRAM" || payload.label.weightUnit === "LITER" ? payload.label.qtyMilli / 1000 : payload.label.qtyMilli;
        await printProductLabel({ nameAr: `${payload.label.nameAr} — ${quantity} ${unit}`, barcode: payload.label.barcode, priceMinor: payload.label.totalMinor, copies: 1, hidePrice: false });
        await callApiRoute({ method: "POST", path: "/v1/weighted-labels/printed", body: { barcode: payload.label.barcode }, headers: {} } as ApiRoute);
      } else {
        const [invoice, store] = await Promise.all([
          callApiRoute({ method: "GET", path: `/v1/invoices/${job.kind}/${job.documentId}`, headers: {} } as ApiRoute) as Promise<InvoiceDetailResponse>,
          callApiRoute({ method: "GET", path: "/v1/store-info", headers: {} } as ApiRoute) as Promise<{ storeName?: string }>,
        ]);
        if (job.kind === "PURCHASE") await printPurchaseReceipt(purchasePrintRequestFromInvoice(invoice, store.storeName ?? "نبتة"));
        else await printReceipt(salePrintRequestFromInvoice(invoice, store.storeName ?? "نبتة"));
      }
      await callApiRoute({ method: "POST", path: `/v1/mobile-print-jobs/${job.id}/complete`, body: { printed: true }, headers: {} } as ApiRoute);
    } catch (cause) {
      const value = cause as { code?: unknown; messageAr?: unknown; message?: unknown };
      const errorCode = typeof value?.code === "string" ? value.code : "MOBILE_PRINT_FAILED";
      const errorMessage = typeof value?.messageAr === "string" ? value.messageAr : typeof value?.message === "string" ? value.message : "تعذر إرسال الفاتورة إلى الطابعة";
      try {
        await callApiRoute({ method: "POST", path: `/v1/mobile-print-jobs/${job.id}/complete`, body: { printed: false, errorCode, errorMessage }, headers: {} } as ApiRoute);
      } catch (completeError) {
        console.error("[nabta-print] could not finalize mobile print job", completeError);
      }
      console.error("[nabta-print] mobile document failed", cause);
    }
  } catch (error) {
    console.error("[nabta-print] mobile print queue poll failed", error);
  } finally {
    mobilePrintQueueBusy = false;
  }
}

function startMobilePrintQueue(): void {
  if (mobilePrintQueueTimer || process.env.NODE_ENV === "test") return;
  const run = () => void processMobilePurchasePrintQueue();
  run();
  mobilePrintQueueTimer = setInterval(run, 2_000);
}

function stopMobilePrintQueue(): void {
  if (mobilePrintQueueTimer) clearInterval(mobilePrintQueueTimer);
  mobilePrintQueueTimer = null;
  mobilePrintQueueBusy = false;
}

async function runCloudMigration(input: { cloudUrl: string; bootstrapKey?: string | undefined; ownerUsername?: string | undefined; ownerCloudPassword?: string | undefined }): Promise<{ storeId: string; recordCount: number; chunkCount: number; status: "IMPORTED" }> {
  if (!desktopConfig || desktopConfig.deviceMode === "SECONDARY" || desktopConfig.serverUrl !== LOCAL_SERVER_URL) {
    throw { code: "CLOUD_MIGRATION_SOURCE_DEVICE_REQUIRED", messageAr: "التحديث يجب أن يُثبت ويُشغّل على جهاز نبتة المصدر، ثم تبدأ منه عملية النقل." };
  }
  if (cloudMigrationInFlight) throw { code: "CLOUD_MIGRATION_IN_PROGRESS", messageAr: "يوجد نقل بيانات سحابي جارٍ بالفعل." };
  cloudMigrationInFlight = true;
  try {
  const connection = await readCloudflareConnection();
  const cloudUrl = await verifyCloudCore(input.cloudUrl.trim());
  let storeId = connection.cloudStoreId;
  let migrationKey = connection.cloudMigrationKey;
  // A fresh store (or an interrupted first transfer) needs a cloud account
  // claim. A verified store can refresh its protected replica without asking
  // the owner to change the password on every backup.
  const requiresOwnerClaim = !storeId || !migrationKey || connection.cloudCoreUrl !== cloudUrl || connection.cloudMigrationState !== "IMPORTED";
  if (requiresOwnerClaim && (!input.ownerUsername || !input.ownerCloudPassword)) {
    throw { code: "CLOUD_OWNER_CREDENTIALS_REQUIRED", messageAr: "اكتب اسم مستخدم المالك وكلمة مرور سحابية عند التهيئة أو استكمال أول نقل فقط." };
  }
  if (!storeId || !migrationKey || connection.cloudCoreUrl !== cloudUrl) {
    if (!input.bootstrapKey) throw { code: "CLOUD_BOOTSTRAP_KEY_REQUIRED", messageAr: "أدخل مفتاح تهيئة نبتة السحابية مرة واحدة لإنشاء مخزن هذا المتجر." };
    reportCloudMigration({ phase: "CREATING_STORE", percent: 12, messageAr: "يتم إنشاء مخزن السحابة الآمن لهذا المتجر…" });
    const bootstrap = await cloudFetch(new URL("/v1/cloud/stores/bootstrap", cloudUrl).toString(), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Nabta-Cloud-Bootstrap-Key": input.bootstrapKey },
      body: "{}",
    });
    const data = await bootstrap.json().catch(() => null) as { storeId?: unknown; migrationKey?: unknown } | null;
    if (!bootstrap.ok || typeof data?.storeId !== "string" || typeof data.migrationKey !== "string") throw data ?? { code: "CLOUD_BOOTSTRAP_FAILED", messageAr: "تعذر تهيئة مخزن المتجر في السحابة." };
    storeId = data.storeId;
    migrationKey = data.migrationKey;
    // Persist the per-store key before any upload. If Windows or the network
    // stops later, the same store can resume without creating another one.
    await saveCloudflareConnection({ enabled: connection.enabled, autoStart: connection.autoStart, cloudCoreUrl: cloudUrl, cloudStoreId: storeId, cloudMigrationKey: migrationKey, cloudMigrationState: "PENDING" });
  }
  let manifest: CloudMigrationManifestView | null = null;
  // Resume only an unfinished transfer. Once a transfer is verified, a new
  // request must prepare a fresh local backup rather than silently uploading
  // yesterday's manifest again.
  if (connection.cloudMigrationState === "PENDING" && connection.cloudMigrationId && connection.cloudCoreUrl === cloudUrl) {
    manifest = await localCloudMigrationRequest(`/v1/cloud-migration/${connection.cloudMigrationId}`, "GET").catch(() => null) as CloudMigrationManifestView | null;
  }
  if (!manifest) {
    reportCloudMigration({ phase: "PREPARING", percent: 18, messageAr: "يتم إنشاء نسخة احتياطية محلية والتحقق منها قبل الرفع…" });
    manifest = await localCloudMigrationRequest("/v1/cloud-migration/prepare", "POST", {}) as CloudMigrationManifestView;
    await saveCloudflareConnection({ enabled: connection.enabled, autoStart: connection.autoStart, cloudCoreUrl: cloudUrl, cloudStoreId: storeId, cloudMigrationKey: migrationKey, cloudMigrationId: manifest.migrationId, cloudMigrationState: "PENDING" });
  }
  const cloudBase = `/v1/cloud/stores/${storeId}/migration`;
  reportCloudMigration({ phase: "STARTING", percent: 22, messageAr: "يتم تجهيز دفعات النقل الآمنة…", totalChunks: manifest.chunkCount, completedChunks: 0 });
  const started = await cloudMigrationRequest(cloudUrl, `${cloudBase}/start`, "POST", migrationKey, { manifest }) as { acceptedChunks?: unknown };
  const acceptedChunks = typeof started.acceptedChunks === "number" && Number.isInteger(started.acceptedChunks) ? Math.min(Math.max(0, started.acceptedChunks), manifest.chunkCount) : 0;
  for (let sequence = acceptedChunks; sequence < manifest.chunkCount; sequence += 1) {
    const chunk = await localCloudMigrationRequest(`/v1/cloud-migration/${manifest.migrationId}/chunks/${sequence}`, "GET");
    await cloudMigrationRequest(cloudUrl, `${cloudBase}/chunk`, "POST", migrationKey, chunk);
    const completedChunks = sequence + 1;
    reportCloudMigration({ phase: "UPLOADING", percent: Math.round(25 + (completedChunks / Math.max(1, manifest.chunkCount)) * 65), messageAr: `يتم رفع البيانات: الدفعة ${completedChunks} من ${manifest.chunkCount}`, completedChunks, totalChunks: manifest.chunkCount });
  }
  reportCloudMigration({ phase: "VERIFYING", percent: 92, messageAr: "يتم التحقق من اكتمال كل السجلات في السحابة…", completedChunks: manifest.chunkCount, totalChunks: manifest.chunkCount });
  const finalized = await cloudMigrationRequest(cloudUrl, `${cloudBase}/finalize`, "POST", migrationKey, { migrationId: manifest.migrationId }) as { status?: string };
  if (finalized.status !== "imported") throw { code: "CLOUD_IMPORT_INCOMPLETE", messageAr: "لم يكتمل التحقق من بيانات السحابة؛ لم يتم تغيير تشغيل نبتة المحلي." };
  if (requiresOwnerClaim) {
    reportCloudMigration({ phase: "PROTECTING_ACCOUNT", percent: 97, messageAr: "يتم حماية حساب المالك السحابي…", completedChunks: manifest.chunkCount, totalChunks: manifest.chunkCount });
    await cloudMigrationRequest(cloudUrl, `/v1/cloud/stores/${storeId}/auth/claim`, "POST", migrationKey, { username: input.ownerUsername, password: input.ownerCloudPassword });
  }
  await cloudMigrationRequest(cloudUrl, `/v1/cloud/stores/${storeId}/terminals/register`, "POST", migrationKey, {});
  await saveCloudflareConnection({
    enabled: connection.enabled,
    autoStart: connection.autoStart,
    cloudCoreUrl: cloudUrl,
    cloudStoreId: storeId,
    cloudMigrationKey: migrationKey,
    cloudMigrationId: manifest.migrationId,
    cloudMigrationState: "IMPORTED",
  });
  reportCloudMigration({ phase: "COMPLETE", percent: 100, messageAr: "اكتمل رفع النسخة والتحقق منها؛ أصبحت النسخة السحابية الجديدة هي النسخة المحمية النشطة.", completedChunks: manifest.chunkCount, totalChunks: manifest.chunkCount });
  return { storeId, recordCount: manifest.recordCount, chunkCount: manifest.chunkCount, status: "IMPORTED" };
  } finally {
    cloudMigrationInFlight = false;
  }
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

async function newestRecoveryCheckpoint(): Promise<string | null> {
  const checkpointDir = resolve(app.getPath("documents"), "Nabta Backups", "recovery-checkpoints");
  try {
    const candidates = await Promise.all((await readdir(checkpointDir))
      .filter((name) => /^nabta-startup-.*\.dump$/u.test(name))
      .map(async (name) => {
        const archive = resolve(checkpointDir, name);
        const details = await stat(archive);
        return details.isFile() ? { archive, modifiedAt: details.mtimeMs } : null;
      }));
    return candidates
      .filter((candidate): candidate is { archive: string; modifiedAt: number } => candidate !== null)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.archive ?? null;
  } catch {
    return null;
  }
}

async function restoreLocalDataFromBackup(): Promise<{ cancelled: boolean; restored?: boolean }> {
  const config = desktopConfig ?? await loadDesktopConfig();
  if (config.deviceMode === "SECONDARY") {
    throw { code: "LOCAL_RECOVERY_NOT_AVAILABLE", messageAr: "الاستعادة المحلية متاحة على الجهاز الرئيسي فقط." };
  }
  const checkpoint = await newestRecoveryCheckpoint();
  let archive: string | undefined;
  if (checkpoint) {
    const options: MessageBoxOptions = {
      type: "warning",
      title: "استعادة بيانات نبتة",
      message: "توجد نقطة حماية محلية تم التحقق منها عند آخر تشغيل سليم.",
      detail: "يمكن استعادتها فوراً أو اختيار نسخة احتياطية أخرى. البيانات الحالية لن تُحذف؛ سيُحتفظ بها في مجلد منفصل.",
      buttons: ["استعادة آخر نقطة حماية", "اختيار نسخة أخرى", "إلغاء"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const choice = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (choice.response === 2) return { cancelled: true };
    if (choice.response === 0) archive = checkpoint;
  }
  if (!archive) {
    const options: OpenDialogOptions = {
      title: "اختيار نسخة نبتة الاحتياطية للاستعادة",
      filters: [{ name: "نسخة نبتة الاحتياطية", extensions: ["dump"] }],
      properties: ["openFile"],
    };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
    archive = selected.filePaths[0];
  }
  const confirmation: MessageBoxOptions = {
    type: "warning",
    title: "استعادة بيانات نبتة",
    message: "سيتم استعادة هذه النسخة الاحتياطية وتشغيل البرنامج.",
    detail: "سيتم الاحتفاظ بمجلد البيانات الحالي باسم منفصل ولن يتم حذفه. اختر استعادة فقط إذا كانت هذه النسخة هي الأحدث السليمة.",
    buttons: ["استعادة وتشغيل", "إلغاء"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const answer = mainWindow ? await dialog.showMessageBox(mainWindow, confirmation) : await dialog.showMessageBox(confirmation);
  if (answer.response !== 0) return { cancelled: true };

  pendingLocalRecoveryArchive = archive;
  try {
    await restartLocalEmbeddedServer();
    return { cancelled: false, restored: true };
  } catch (error) {
    // Keep the selected path only for the current recovery attempt.  The
    // next click asks the owner to select and confirm the backup again.
    pendingLocalRecoveryArchive = null;
    throw error;
  }
}

async function callApi(request: IpcRequest): Promise<unknown> {
  if (request.operation === "reports.export-xlsx") {
    const data = await callApiRoute(apiPath({ operation: "reports.comprehensive", payload: request.payload })) as ComprehensiveReportResponse;
    return exportComprehensiveReportXlsx(data);
  }
  if (request.operation === "products.import-workbook") {
    const csv = await productSyncWorkbookToCsv(Buffer.from(request.payload.workbookBase64, "base64"));
    return callApiRoute({ method: "POST", path: "/v1/products/import", body: { csv, preview: request.payload.preview }, headers: { "Idempotency-Key": request.payload.idempotencyKey } });
  }
  const route = apiPath(request);
  const data = await callApiRoute(route);
  if (request.operation === "login") {
    const login = data as { token: string };
    authToken = login.token;
    const config = desktopConfig;
    if (!config) throw { code: "SERVER_NOT_CONFIGURED", messageAr: "أدخل عنوان خادم المتجر أولًا" };
    if (!config.terminalId) await saveDesktopConfig({ ...config, terminalId: request.payload.terminalId });
    startCloudReconciliation();
    startMobilePrintQueue();
    const { token: _token, ...safe } = login;
    return safe;
  }
  if (request.operation === "logout") { authToken = null; stopCloudReconciliation(); stopMobilePrintQueue(); }
  if (request.operation === "setup") {
    const setup = data as { terminalId: string };
    const config = desktopConfig;
    if (!config) throw { code: "SERVER_NOT_CONFIGURED", messageAr: "أدخل عنوان خادم المتجر أولًا" };
    await saveDesktopConfig({ ...config, terminalId: setup.terminalId });
  }
  if (request.operation === "inventory.export-xlsx") return exportInventoryXlsx(data as InventoryExcelExportResponse);
  if (request.operation === "stock.expiry.export-xlsx") return exportExpiryXlsx(data as ExpiryWorkbookData);
  if (request.operation === "inventory.periodic-export-xlsx") return exportInventoryPeriodicXlsx(data as InventoryPeriodicExcelExportResponse);
  if (request.operation === "products.export") return exportProductsXlsx(data as ProductExcelExportResponse);
  if (request.operation === "products.sync-workbook.export") return exportProductSyncWorkbook(data as ProductExcelExportResponse);
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
  // Show the application immediately. The React bootstrap owns retries and
  // can present an actionable Arabic message if the local host is not ready.
  void startLocalEmbeddedServer().catch((error) => {
    console.error("[nabta-host] background startup failed", error);
    void recordStartupDiagnostic("local-host-background", error);
  });
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

/** Fail with an actionable message before silently submitting a receipt to a
 * queue that was removed or renamed in Windows. */
async function requireInstalledReceiptPrinter(printerName: string): Promise<void> {
  const printers = await listInstalledPrinters();
  if (printers.some((printer) => printer.name === printerName)) return;
  throw {
    code: "RECEIPT_PRINTER_UNAVAILABLE",
    messageAr: `طابعة الإيصالات المختارة (${printerName}) غير موجودة في Windows على هذا الجهاز. افتح الإعدادات، حدّث قائمة الطابعات، ثم اختر طابعة الإيصالات واحفظ.`,
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
  const priceMarkup = request.hidePrice ? "" : `<div class="price">${escapeReportHtml(formatReportMoney(request.priceMinor))}</div>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق صنف</title><style>
    @page{size:${width}mm ${height}mm;margin:0}body{margin:0;font-family:Arial,"Segoe UI",sans-serif}.label{box-sizing:border-box;width:${width}mm;height:${height}mm;padding:${tiny ? 1 : 2.5}mm;text-align:center;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center}.name{font-size:${layout.name}px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.price{font-size:${layout.price}px;font-weight:800;margin:${layout.gap}mm 0}.barcode{line-height:0}.barcode svg{width:calc(${width}mm - ${tiny ? 3 : 7}mm);height:${layout.barcode}mm}.code{font-family:monospace;font-size:${layout.code}px;letter-spacing:${tiny ? .1 : .35}px;direction:ltr;line-height:1.15}</style></head><body><section class="label"><div class="name">${escapeReportHtml(request.nameAr)}</div>${priceMarkup}<div class="barcode">${barcode}</div><div class="code">${escapeReportHtml(request.barcode)}</div></section></body></html>`;
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
    ? `<div class="micro-details${request.hidePrice ? " micro-details-no-price" : ""}"><div class="micro-name">${escapeReportHtml(microName)}</div>${request.hidePrice ? "" : `<div class="micro-price" dir="ltr">${(request.priceMinor / 100).toFixed(2)}</div>`}</div><div class="barcode">${barcode}</div>`
    : `<div class="brand">الشيماء</div><div class="rule"></div><div class="barcode">${barcode}</div><div class="code">${escapeReportHtml(request.barcode)}</div><div class="details${request.hidePrice ? " details-no-price" : ""}"><div class="${nameClass}">${escapeReportHtml(request.nameAr)}</div>${request.hidePrice ? "" : `<div class="price">${escapeReportHtml(formatReportMoney(request.priceMinor))}</div>`}</div>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق صنف</title><style>
    @page{size:${width}mm ${height}mm;margin:0}
    *{box-sizing:border-box}body{margin:0;color:#000;background:#fff;font-family:Arial,"Segoe UI",sans-serif}
    .label{width:${width}mm;height:${height}mm;padding:${tiny ? .7 : 2.4}mm ${tiny ? .9 : 3}mm ${tiny ? .8 : 2.25}mm;overflow:hidden;display:flex;flex-direction:column;align-items:stretch;text-align:center;background:#fff}
    .brand{font-size:${tiny ? 6.2 : 9.5}px;font-weight:900;line-height:1.08;letter-spacing:.1px}.rule{height:.28mm;min-height:1px;margin:${tiny ? .35 : .5}mm 0 ${tiny ? .28 : .45}mm;background:#000}
    .barcode{padding:0 ${tiny ? .8 : 2.1}mm;line-height:0;direction:ltr}.barcode svg{display:block;width:100%;height:${layout.barcode}mm}.code{direction:ltr;font-family:Consolas,"Courier New",monospace;font-size:${layout.code}px;font-weight:700;letter-spacing:${tiny ? .05 : .28}px;line-height:1.05;margin-top:${tiny ? .15 : .35}mm}
    .details{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:${tiny ? .7 : 1.2}mm;align-items:center;margin-top:${tiny ? .5 : 1.1}mm;padding:0 ${tiny ? 0 : .7}mm;direction:rtl;text-align:right}.details-no-price{grid-template-columns:minmax(0,1fr)}.details-no-price .name{width:100%}.name{min-width:0;font-size:${layout.name}px;font-weight:800;line-height:1.13;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.name-long{font-size:${layout.longName}px;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.name-extra-long{font-size:${Math.max(4.6, layout.longName - 1)}px}.price{direction:rtl;white-space:nowrap;font-size:${layout.price}px;font-weight:900;line-height:1}
    .micro-label{padding:.35mm .45mm .30mm;gap:.12mm}.micro-label .barcode{padding:0;margin:0}.micro-label .barcode svg{height:${layout.barcode}mm}.micro-details{height:3.45mm;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4mm;align-items:center;direction:rtl;text-align:right}.micro-details-no-price{grid-template-columns:minmax(0,1fr)}.micro-details-no-price .micro-name{width:100%}.micro-name{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:${layout.name}px;font-weight:800;line-height:1.05}.micro-price{white-space:nowrap;font-family:Arial,"Segoe UI",sans-serif;font-size:${layout.price}px;font-weight:900;line-height:1}
    ${wideShort ? `.wide-short-label{padding:1.15mm 2.25mm 1mm}.wide-short-label .brand{font-size:9px;line-height:1}.wide-short-label .rule{margin:.35mm 0 .3mm}.wide-short-label .barcode{padding:0 1.45mm}.wide-short-label .code{font-size:${layout.code}px;margin-top:.2mm}.wide-short-label .details{margin-top:.38mm;padding:0 .25mm;gap:.85mm}.wide-short-label .name{font-weight:900}.wide-short-label .price{font-weight:900}` : ""}
    ${tiny ? ".brand,.rule{display:none}.name{font-size:5.5px}.name-long,.name-extra-long{font-size:4.8px;-webkit-line-clamp:1}" : ""}
  </style></head><body><section class="label${micro ? " micro-label" : ""}${wideShort ? " wide-short-label" : ""}">${labelContents}</section></body></html>`;
}

function normalizeProductLabelPriceVisibility(request: ProductLabelPrintRequest): ProductLabelPrintRequest {
  // Price visibility is selected for each print job in the product label dialog.
  // The renderer may suggest a default (such as hiding foam prices), but the
  // printer must honour the operator's explicit choice for every product.
  return request;
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
      hidePrice: request.hidePrice,
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
  const labelRequest = normalizeProductLabelPriceVisibility(request);
  const profile = currentTsplLabelProfile();
  if (labelRequest.copies > Number.MAX_SAFE_INTEGER && !profile.calibrationConfirmed) {
    throw { code: "LABEL_CALIBRATION_REQUIRED", messageAr: "أكد نجاح ملصق المعايرة عمليًا قبل طباعة أكثر من نسخة أو دفعة من الملصقات." };
  }
  try {
    let payload: Buffer;
    const content = {
      storeName: "نبتة",
      name: labelRequest.nameAr,
      barcode: labelRequest.barcode,
      priceMinor: labelRequest.priceMinor,
      copies: labelRequest.copies,
      hidePrice: labelRequest.hidePrice,
    };
    if (profile.renderMode === "NATIVE_TSPL") {
      const headerRaster = await rasterizeTsplLabel(profile, labelRequest, "HEADER_ONLY");
      payload = createTsplNativeBarcodeJob(profile, content, headerRaster);
    } else {
      const fullRaster = await rasterizeTsplLabel(profile, labelRequest, "FULL");
      payload = createTsplRasterJob(profile, content, fullRaster);
    }
    const result = await labelRawSpooler.submit(printerName, "Nabta TSPL Label", payload);
    await writeLabelPrintLog({
      printerName,
      transport: "TSPL",
      renderMode: profile.renderMode,
      barcode: labelRequest.barcode,
      nameAr: labelRequest.nameAr,
      priceMinor: labelRequest.priceMinor,
      copies: labelRequest.copies,
      hidePrice: labelRequest.hidePrice,
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
  const labelRequest = normalizeProductLabelPriceVisibility(request);
  if (!hardwareSettings.barcodePrinterName) throw { code: "LABEL_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الباركود من الإعدادات أولًا." };
  if (hardwareSettings.barcodePrinterName === hardwareSettings.receiptPrinterName) throw { code: "PRINTER_ROLE_CONFLICT", messageAr: "لا يمكن استخدام الطابعة نفسها للباركود والإيصالات؛ اختر طابعتين منفصلتين." };
  const printerName = hardwareSettings.barcodePrinterName;
  const jobKey = `label:${printerName}:${labelRequest.barcode}:${labelRequest.nameAr}:${labelRequest.priceMinor}:${labelRequest.copies}:${labelRequest.hidePrice ? "without-price" : "with-price"}`;
  return enqueuePrintJob(printerName, jobKey, async () => {
    await requireInstalledLabelPrinter(printerName);
    if (hardwareSettings.labelPrintTransport === "TSPL") return sendTsplLabel(printerName, labelRequest);
    // Media synchronization is started after saving device settings.  Never
    // repeat or await its PowerShell/driver work here: it can take seconds on a
    // busy cashier PC while the Windows queue is already ready to print.
    const labelWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await labelWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(productLabelHtml(labelRequest))}`);
      // Use the queue's own default media rather than forcing Chromium's
      // custom page size.  The latter is rejected by several label drivers even
      // though the same queue prints a Windows test page successfully.
      // Some Windows label drivers reject Electron's `copies > 1` option even
      // though they accept the exact same label with one copy. Submit every
      // requested label as a serialized one-copy job for driver-independent output.
      for (let copyNumber = 1; copyNumber <= labelRequest.copies; copyNumber += 1) {
        const result = await printWebContents(labelWindow, { silent: true, printBackground: true, deviceName: printerName, usePrinterDefaultPageSize: true, margins: { marginType: "none" }, copies: 1 });
        if (!result.success) {
        console.error("[nabta-label] print failed", { printerName, copyNumber, requestedCopies: labelRequest.copies, errorType: result.errorType });
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
  return printProductLabel({ nameAr: "صنف اختبار", barcode: "6221234567891", priceMinor: 1250, copies: 1, hidePrice: false });
}

async function printReceipt(request: ReceiptPrintRequest): Promise<{ printed: true; printerName: string; copies: number }> {
  if (!hardwareSettings.receiptPrinterName) throw { code: "RECEIPT_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الإيصالات من الإعدادات أولاً." };
  const printerName = hardwareSettings.receiptPrinterName;
  return enqueuePrintJob(printerName, `receipt:${printerName}:${request.sale.saleId}:${request.copies}`, async () => {
    await requireInstalledReceiptPrinter(printerName);
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
      return { printed: true, printerName, copies: request.copies };
    } finally {
      if (!receiptWindow.isDestroyed()) receiptWindow.destroy();
    }
  });
}

async function printDeliveryOrder(request: DeliveryOrderPrintRequest): Promise<{ printed: true; printerName: string; copies: number }> {
  if (!hardwareSettings.receiptPrinterName) throw { code: "RECEIPT_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الإيصالات من الإعدادات أولاً." };
  const printerName = hardwareSettings.receiptPrinterName;
  return enqueuePrintJob(printerName, `delivery-order:${printerName}:${request.order.id}:${request.copies}`, async () => {
    const receiptWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await receiptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(deliveryOrderHtml(request, hardwareSettings.receiptPaperWidth))}`);
      const result = await printWebContents(receiptWindow, {
        silent: true,
        printBackground: true,
        deviceName: printerName,
        usePrinterDefaultPageSize: true,
        margins: { marginType: "none" },
        copies: request.copies,
      });
      if (!result.success) throw { code: "DELIVERY_ORDER_PRINT_FAILED", messageAr: result.errorType === "canceled" ? "أُلغيت طباعة ورقة التجهيز." : result.errorType === "timeout" ? "استغرقت طباعة ورقة التجهيز وقتًا أطول من المعتاد." : "تعذر إرسال ورقة التجهيز إلى طابعة الإيصالات." };
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

async function printPurchaseReceipt(request: PurchaseReceiptPrintRequest): Promise<{ printed: true; printerName: string }> {
  if (!hardwareSettings.receiptPrinterName) throw { code: "RECEIPT_PRINTER_NOT_SELECTED", messageAr: "اختر طابعة الإيصالات من الإعدادات أولاً." };
  const printerName = hardwareSettings.receiptPrinterName;
  return enqueuePrintJob(printerName, `purchase:${printerName}:${request.receipt.id}`, async () => {
    await requireInstalledReceiptPrinter(printerName);
    const reportWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(purchaseReceiptThermalHtml(request, hardwareSettings.receiptPaperWidth))}`);
      const result = await printWebContents(reportWindow, { silent: true, printBackground: true, deviceName: printerName, usePrinterDefaultPageSize: true, margins: { marginType: "none" }, copies: 1 });
      if (!result.success) throw { code: "PURCHASE_PRINT_FAILED", messageAr: result.errorType === "timeout" ? "استغرقت الطباعة وقتًا أطول من المعتاد ولم تُرسل محاولة جديدة." : "تعذر إرسال فاتورة التوريد إلى طابعة الإيصالات المختارة." };
      return { printed: true, printerName };
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
    if (request.operation === "host.recovery.restore") return { ok: true, data: await restoreLocalDataFromBackup() };
    if (request.operation === "host.start") {
      if (process.env.NODE_ENV !== "test" && !localRuntimeRoot()) {
        throw { code: "HOST_RUNTIME_MISSING", messageAr: "هذه النسخة لا تحتوي على خادم محلي. أعد تثبيت مثبت نبتة الكامل." };
      }
      await startLocalEmbeddedServer();
      return { ok: true, data: { started: true } };
    }
    if (request.operation === "config.get") return { ok: true, data: desktopConfig ?? await loadDesktopConfig() };
    if (request.operation === "config.set") {
      const current = desktopConfig ?? await loadDesktopConfig();
      const secondary = request.payload.deviceMode === "SECONDARY";
      await saveDesktopConfig({
        serverUrl: secondary ? request.payload.serverUrl : LOCAL_SERVER_URL,
        terminalId: request.payload.terminalId ?? current.terminalId ?? randomUUID(),
        certificateFingerprint: request.payload.certificateFingerprint,
        deviceMode: secondary ? "SECONDARY" : "PRIMARY",
        ...(secondary ? { terminalRelayKey: request.payload.terminalRelayKey ?? current.terminalRelayKey } : {}),
      });
      return { ok: true, data: desktopConfig };
    }
    if (request.operation === "multi-terminal.primary.enable") {
      if (request.payload.enrollmentPin !== "281020") throw { code: "PRIMARY_DEVICE_PIN_INVALID", messageAr: "رمز تعيين الجهاز الرئيسي غير صحيح." };
      const current = desktopConfig ?? await loadDesktopConfig();
      await saveDesktopConfig({ serverUrl: LOCAL_SERVER_URL, terminalId: current.terminalId ?? randomUUID(), certificateFingerprint: "", deviceMode: "PRIMARY" });
      return { ok: true, data: desktopConfig };
    }
    if (request.operation === "multi-terminal.join") {
      const current = desktopConfig ?? await loadDesktopConfig();
      const terminalId = current.terminalId ?? randomUUID();
      const endpoint = new URL("/v1/terminals/enroll", request.payload.serverUrl).toString();
      let response: Response;
      try {
        response = await net.fetch(endpoint, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Nabta-Terminal-Key": request.payload.relayKey },
          body: JSON.stringify({ terminalId, terminalName: request.payload.terminalName, enrollmentPin: request.payload.enrollmentPin }),
        });
      } catch {
        throw { code: "REMOTE_PRIMARY_UNAVAILABLE", messageAr: "تعذر الوصول إلى الجهاز الرئيسي عبر Cloudflare." };
      }
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) throw responseBody ?? { code: "TERMINAL_ENROLL_FAILED", messageAr: "تعذر ربط نقطة البيع بالجهاز الرئيسي." };
      await saveDesktopConfig({ serverUrl: request.payload.serverUrl, terminalId, certificateFingerprint: "", deviceMode: "SECONDARY", terminalRelayKey: request.payload.relayKey });
      return { ok: true, data: { ...desktopConfig, terminalName: request.payload.terminalName } };
    }
    if (request.operation === "cloudflare.connection.get") {
      return { ok: true, data: cloudflareConnectionView(await readCloudflareConnection()) };
    }
    if (request.operation === "cloudflare.connection.update") {
      const next = await saveCloudflareConnection(request.payload);
      if (next.autoStart && process.platform === "win32") app.setLoginItemSettings({ openAtLogin: true });
      if (!next.enabled) await stopCloudflareTunnel();
      await restartLocalEmbeddedServer();
      const status = await startCloudflareTunnel(true);
      return { ok: true, data: status };
    }
    if (request.operation === "cloud.migration.run") {
      return { ok: true, data: await runCloudMigration(request.payload) };
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
    if (request.operation === "hardware.delivery-order.print") return { ok: true, data: await printDeliveryOrder(request.payload) };
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
  void app.whenReady().then(() => {
    const runtime = localRuntimeRoot();
    if (!runtime) throw new Error("Nabta local runtime is missing from this installation");
    return import(pathToFileURL(resolve(runtime, "runner.mjs")).href);
  }).catch((error) => {
    console.error("[nabta-host] embedded server failed", error);
    app.quit();
  });
} else {
  if (process.env.NODE_ENV === "test") console.error("[nabta-e2e] waiting for app readiness");
  void app.whenReady().then(async () => {
    app.setAppUserModelId("eg.nabta.pos");
    // The POS is a focused production application, not a browser shell.  The
    // default Electron File/Edit menu has no customer-facing purpose.
    Menu.setApplicationMenu(null);
    if (process.env.NODE_ENV === "test") console.error("[nabta-e2e] app ready");
    desktopConfig = await loadDesktopConfig();
    const cloudflare = await readCloudflareConnection();
    if (cloudflare.autoStart && process.platform === "win32") app.setLoginItemSettings({ openAtLogin: true });
    await registerProtocol();
    // Do not gate the desktop window on the local host. It is offline-first:
    // the UI appears immediately and starts/retries the bundled data service.
    await createWindow();
    enableReleaseUpdates();
    if (process.env.NODE_ENV === "test") console.error("[nabta-e2e] desktop window created");
  }).catch(async (error) => {
    console.error("[nabta-desktop] startup failed", error);
    await recordStartupDiagnostic("desktop-startup", error);
    const message = "تعذر فتح نبتة قبل تحميل الواجهة. لم يتم حذف أي بيانات. أعد فتح البرنامج، وإن تكرر الأمر أرسل ملف startup-diagnostics.log من بيانات التطبيق.";
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      await dialog.showMessageBox(mainWindow, { type: "error", title: "تعذر بدء نبتة", message, buttons: ["حسنًا"] });
    } else {
      dialog.showErrorBox("تعذر بدء نبتة", message);
    }
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  app.on("before-quit", () => { appIsQuitting = true; void stopSerialScanner(); void stopCloudflareTunnel(); stopCloudReconciliation(); stopMobilePrintQueue(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
