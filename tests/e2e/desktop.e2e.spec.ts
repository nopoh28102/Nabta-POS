import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;

let server: ChildProcess;
let desktop: ElectronApplication;
let page: Page;
let userData: string;
let terminalId: string;
let embeddedDir: string | undefined;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch("http://127.0.0.1:7443/v1/health")).ok) return; } catch { /* retry */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("server did not become ready");
}

async function runMigrations(env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("apps/server/dist/cli/migrate.js")], { cwd: resolve("."), windowsHide: true, env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`migration process exited with ${code}`)));
  });
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await page.waitForTimeout(250);
}

async function ensureDesktopSession(): Promise<void> {
  if (await page.locator(".shell").count()) return;
  const username = page.locator('input[name="username"]');
  const password = page.locator('input[name="password"]');
  await expect(username).toBeVisible({ timeout: 15_000 });
  await username.fill("owner_it");
  await password.fill("Strong-Integration-Password-2026!");
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page.getByRole("heading", { name: "نقطة البيع" })).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
  if (!databaseUrl) embeddedDir = await mkdtemp(resolve(tmpdir(), "nabta-e2e-pglite-"));
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const terminal = await pool.query<{ id: string }>("SELECT id FROM terminals WHERE name = 'كاشير 1' ORDER BY created_at LIMIT 1");
    terminalId = terminal.rows[0]!.id;
    await pool.end();
  }
  const serverEnv = databaseUrl
    ? { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "7443", DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl, SETUP_TOKEN: "integration-setup-token-2026-secure", LOG_LEVEL: "silent" }
    : { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "7443", DATABASE_MODE: "embedded", DATABASE_DIR: embeddedDir!, SETUP_TOKEN: "integration-setup-token-2026-secure", LOG_LEVEL: "silent" };
  if (!databaseUrl) { await runMigrations(serverEnv); }
  server = spawn(process.execPath, [resolve("apps/server/dist/index.js")], {
    cwd: resolve("."), windowsHide: true, env: serverEnv,
    stdio: "ignore",
  });
  await waitForServer();
  if (!databaseUrl) {
    const setup = await fetch("http://127.0.0.1:7443/v1/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: "integration-setup-token-2026-secure", storeName: "متجر نبتة الاختباري", branchName: "الفرع الرئيسي", ownerName: "المالك", username: "owner_it", password: "Strong-Integration-Password-2026!", terminalName: "كاشير 1" }) });
    if (!setup.ok) throw new Error(`setup failed: ${await setup.text()}`);
    terminalId = (await setup.json() as { terminalId: string }).terminalId;
    const login = await fetch("http://127.0.0.1:7443/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner_it", password: "Strong-Integration-Password-2026!", terminalId }) });
    const token = (await login.json() as { token: string }).token;
    await fetch("http://127.0.0.1:7443/v1/shifts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ terminalId, openingMinor: 5_000 }) });
    const products = [
      { nameAr: "جبنة موزونة", category: "ألبان", unitKind: "WEIGHT", priceMinor: 2_500, reorderLevelMilli: 0, barcodes: ["0000000000005"], openingQtyMilli: 20_000, openingUnitCostMinor: 1_500 },
      { nameAr: "منتج تجريبي", category: "اختبار", unitKind: "PIECE", priceMinor: 1_000, reorderLevelMilli: 0, barcodes: ["0000000000002"], openingQtyMilli: 10_000, openingUnitCostMinor: 500 },
      { nameAr: "صنف نافد للتنبيه", category: "اختبار", unitKind: "PIECE", priceMinor: 750, reorderLevelMilli: 2_000, barcodes: ["0000000000007"], openingQtyMilli: 0, openingUnitCostMinor: 0 },
      { nameAr: "صنف توريد سريع للاختبار", category: "اختبار", unitKind: "PIECE", priceMinor: 650, reorderLevelMilli: 0, barcodes: ["0000000000008"], openingQtyMilli: 0, openingUnitCostMinor: 0 },
    ];
    for (const product of products) {
      const response = await fetch("http://127.0.0.1:7443/v1/products", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(product) });
      if (!response.ok) throw new Error(`test product setup failed: ${await response.text()}`);
    }
    const catalogResponse = await fetch("http://127.0.0.1:7443/v1/catalog?query=0000000000008", { headers: { authorization: `Bearer ${token}` } });
    if (!catalogResponse.ok) throw new Error(`test catalog setup failed: ${await catalogResponse.text()}`);
    const catalog = await catalogResponse.json() as { products: Array<{ id: string }> };
    if (catalog.products.length !== 1) throw new Error(`test catalog setup returned ${catalog.products.length} products`);
    await fetch("http://127.0.0.1:7443/v1/partners/suppliers", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "مورد هاتف تجريبي", phone: "01012345678", openingBalanceMinor: 2_500 }) });
    await fetch("http://127.0.0.1:7443/v1/partners/customers", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "عميل هاتف تجريبي", phone: "01198765432", creditLimitMinor: 5_000, openingBalanceMinor: 1_200 }) });
  }
  userData = await mkdtemp(resolve(tmpdir(), "nabta-e2e-"));
  desktop = await electron.launch({
    executablePath: resolve("apps/desktop/node_modules/electron/dist/electron.exe"),
    args: [resolve("apps/desktop")],
    env: { ...process.env, NODE_ENV: "test", NABTA_USER_DATA_DIR: userData },
  });
  page = await desktop.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  if (desktop) await desktop.close();
  if (server && !server.killed) server.kill();
  if (userData) await rm(userData, { recursive: true, force: true });
  if (embeddedDir) await rm(embeddedDir, { recursive: true, force: true });
});

test("connects, logs in, scans weighted goods, posts and prints an Arabic receipt", async () => {
  await ensureDesktopSession();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await mkdir(resolve("docs/previews"), { recursive: true });
  for (const [width, height, name] of [[1366, 768, "production-pos-1366.png"], [1920, 1080, "production-pos-1920.png"], [390, 844, "production-pos-390.png"]] as const) {
    await setWindowSize(width, height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: resolve("docs/previews", name), fullPage: true });
  }
  await setWindowSize(1366, 768);
  await page.keyboard.press("F2");
  await expect(page.getByPlaceholder(/الباركود/)).toBeFocused();
  await page.getByPlaceholder(/الباركود/).fill("0000000000005");
  await page.getByPlaceholder(/الباركود/).press("Enter");
  await expect(page.getByRole("heading", { name: "ماذا تريد أن تبدأ؟" })).toBeVisible();
  await page.getByRole("button", { name: "فاتورة بيع" }).click();
  await page.getByLabel("كمية بالكيلو").fill("0.375");
  await page.getByRole("button", { name: "إضافة للسلة" }).click();
  await expect(page.locator(".cart-line").filter({ hasText: "جبنة موزونة" })).toContainText("٠٫٣٧٥ كجم");
  await page.keyboard.press("F4");
  await expect(page.getByRole("heading", { name: "تأكيد الدفع" })).toBeVisible();
  await page.getByRole("button", { name: "إصدار الفاتورة" }).click();
  await expect(page.locator(".receipt")).toContainText("INV-");
  await page.emulateMedia({ media: "print" });
  expect(await page.locator(".receipt").evaluate((element) => getComputedStyle(element).width)).toMatch(/302|80mm/);
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "إغلاق" }).click();
});

test("persists the day theme after the desktop window reloads", async () => {
  await ensureDesktopSession();
  const toggle = page.locator(".theme-toggle").first();
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await ensureDesktopSession();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const reloadedToggle = page.locator(".theme-toggle").first();
  await reloadedToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keeps the full catalog visible after a barcode lookup outside the local cache", async () => {
  await ensureDesktopSession();
  const barcode = "0000000000010";
  const nameAr = "صنف اختبار مسح خارج الذاكرة";
  const created = await page.evaluate(async ({ barcode: newBarcode, name }) =>
    window.nabta.invoke({
      operation: "products.create",
      payload: {
        nameAr: name,
        category: "اختبار",
        unitKind: "PIECE",
        priceMinor: 1_100,
        reorderLevelMilli: 0,
        barcodes: [newBarcode],
        openingQtyMilli: 2_000,
        openingUnitCostMinor: 600,
      },
    }),
  { barcode, name: nameAr });
  expect(created).toMatchObject({ ok: true });

  const catalogCardsBeforeScan = await page.locator(".product-card").count();
  expect(catalogCardsBeforeScan).toBeGreaterThan(1);
  const scanner = page.getByPlaceholder(/الباركود/);
  await scanner.fill(barcode);
  await scanner.press("Enter");
  if (await page.getByRole("heading", { name: "ماذا تريد أن تبدأ؟" }).count()) {
    await page.getByRole("button", { name: "فاتورة بيع" }).click();
  }
  const scannedLine = page.locator(".cart-line").filter({ hasText: nameAr });
  await expect(scannedLine).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(catalogCardsBeforeScan);

  await scannedLine.getByRole("button", { name: "حذف الصنف" }).click();
  await expect(scannedLine).toHaveCount(0);
  await page.reload();
});

test("keeps an unfinished draft through a renderer reload and keyboard navigation", async () => {
  await ensureDesktopSession();
  await page.getByPlaceholder(/الباركود/).fill("0000000000002");
  await page.getByPlaceholder(/الباركود/).press("Enter");
  await page.getByRole("button", { name: "فاتورة بيع" }).click();
  await expect(page.locator(".cart-line")).toHaveCount(1);
  await page.reload();
  await page.locator('input[name="username"]').fill("owner_it");
  await page.locator('input[name="password"]').fill("Strong-Integration-Password-2026!");
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page.locator(".cart-line")).toHaveCount(1);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
});

test("opens working products and reports screens without horizontal overflow", async () => {
  await ensureDesktopSession();
  for (const name of ["الأصناف", "التقارير"] as const) {
    await page.getByRole("button", { name }).click();
    await expect(page.getByRole("heading", { name: name === "التقارير" ? "التقارير والأرباح" : name })).toBeVisible();
    if (name === "التقارير") {
      await expect(page.getByRole("button", { name: "هذا الشهر" })).toBeVisible();
      await expect(page.getByRole("button", { name: "طباعة A4" })).toBeVisible();
      await expect(page.getByRole("button", { name: "تصدير PDF" })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("loads invoices through the desktop query bridge without a validation error", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الفواتير" }).click();
  await expect(page.locator(".invoices-shell")).toBeVisible();
  await expect(page.locator(".invoice-kpis")).toBeVisible();
  await expect(page.getByRole("button", { name: /تسجيل فاتورة توريد جديدة/ })).toBeVisible();
  await expect(page.locator(".banner")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("searches products by barcode and records a quick stock arrival", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الأصناف" }).click();
  const search = page.getByLabel("ابحث عن صنف بالاسم أو الباركود");
  await search.fill("0000000000008");
  const row = page.locator(".table-wrap tbody tr").filter({ hasText: "صنف توريد سريع للاختبار" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("غير متوفر");
  await row.getByRole("button", { name: "إضافة كمية لـ صنف توريد سريع للاختبار" }).click();
  await expect(page.getByRole("heading", { name: "إضافة كمية سريعة" })).toBeVisible();
  await page.getByLabel("الكمية التي وصلت الآن").fill("4");
  await page.getByLabel("تكلفة الوحدة بالجنيه").fill("5.00");
  await page.getByRole("button", { name: "ترحيل الكمية" }).click();
  await expect(page.locator(".notice")).toContainText("تمت إضافة كمية");
  await expect(row.locator(".availability")).toHaveText("متوفر");
});

test("opens actions for the selected product through right click", async () => {
  await ensureDesktopSession();
  if (!await page.locator(".product-search-field input").count()) {
    await page.locator("nav button").nth(1).click();
  }
  const search = page.locator(".product-search-field input");
  await search.fill("0000000000008");
  const row = page.locator(".table-wrap tbody tr").filter({ hasText: "0000000000008" });
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  const menu = page.locator(".product-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(5);
  await expect(menu.getByRole("menuitem", { name: "تعديل بيانات الصنف" })).toBeVisible();
  await menu.getByRole("menuitem", { name: /إضافة كمية/ }).click();
  const restock = page.locator(".quick-restock-form");
  await expect(restock).toBeVisible();
  await restock.getByRole("button").first().click();
  await expect(restock).toHaveCount(0);

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "تعديل بيانات الصنف" }).click();
  await expect(page.getByRole("heading", { name: "تعديل بيانات الصنف" })).toBeVisible();
  await page.locator('textarea[name="description"]').fill("وصف اختبار محفوظ");
  await page.locator('input[name="availableQuantity"]').fill("3");
  await page.getByRole("button", { name: "حفظ التعديلات" }).click();
  await expect(page.locator(".notice")).toContainText("تم حفظ بيانات");

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "طباعة باركود" }).click();
  await expect(page.getByRole("heading", { name: "طباعة باركود الصنف" })).toBeVisible();
  await expect(page.locator('input[name="copies"]')).toHaveValue("1");
  await page.getByRole("button", { name: "إلغاء" }).last().click();
});

test("shows reorder alerts and a printable purchase list from stock thresholds", async () => {
  await ensureDesktopSession();
  const alertBell = page.getByRole("button", { name: "فتح تنبيهات النواقص" });
  await expect(alertBell).toBeVisible();
  await expect(alertBell).toContainText("1");
  await alertBell.click();
  await expect(page.getByRole("heading", { name: "قائمة الشراء والتنبيهات" })).toBeVisible();
  await expect(page.locator(".reorder-table")).toContainText("صنف نافد للتنبيه");
  await expect(page.locator(".reorder-table")).toContainText("نفد تمامًا");
  await expect(page.getByRole("button", { name: "طباعة A4" })).toBeVisible();
  await expect(page.getByRole("button", { name: "تصدير PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "تصدير CSV" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("separates inventory and partner operations into compact tabs without overflow", async () => {
  await ensureDesktopSession();
  await setWindowSize(1366, 768);
  await page.getByRole("button", { name: "المخزون" }).click();
  await expect(page.getByRole("heading", { name: "إدارة المخزون" })).toBeVisible();
  await expect(page.getByRole("button", { name: "تصدير المخزون إلى Excel" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "استلام مشتريات" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "جرد وتصحيح" }).click();
  await expect(page.getByRole("heading", { name: "جرد وتصحيح" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole("button", { name: "العلاقات" }).click();
  await expect(page.getByRole("heading", { name: "الموردون والعملاء" })).toBeVisible();
  const partnerSearch = page.getByLabel("بحث بالاسم أو رقم الهاتف");
  await partnerSearch.fill("01012345678");
  await expect(page.locator(".partner-directory")).toContainText("مورد هاتف تجريبي");
  await expect(page.getByRole("button", { name: "تصدير PDF" })).toBeVisible();
  await page.getByRole("tab", { name: "الأرصدة الحالية" }).click();
    await expect(page.getByRole("heading", { name: "نتائج الدليل والأرصدة" })).toBeVisible();
  await partnerSearch.fill("01198765432");
  await expect(page.locator(".partner-directory")).toContainText("عميل هاتف تجريبي");
  await page.getByLabel("حالة الرصيد").selectOption("DUE");
  await expect(page.locator(".partner-directory")).toContainText("عميل هاتف تجريبي");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("searches and selects a supplier from the results instead of a long list", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "العلاقات" }).click();
  await page.getByRole("tab", { name: "الموردون" }).click();
  const supplierField = page.getByLabel("المورد");
  await supplierField.fill("01012345678");
  const option = page.getByRole("option", { name: /مورد هاتف تجريبي/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator('input[name="partnerId"]')).toHaveValue(/.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("routes an unknown barcode into a prefilled product form and exposes store operations", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "نقطة البيع" }).click();
  await page.locator(".search input").fill("0796554992983");
  await page.locator(".search input").press("Enter");
  await expect(page.locator(".scanner-modal")).toBeVisible();
  if (await page.getByRole("heading", { name: "ماذا تريد أن تبدأ؟" }).count()) {
    await page.getByRole("button", { name: "فاتورة بيع" }).click();
  }
  await expect(page.getByRole("heading", { name: "باركود غير مسجل" })).toBeVisible();
  await page.getByRole("button", { name: "إضافة صنف جديد" }).click();
  await expect(page.getByRole("heading", { name: "الأصناف" })).toBeVisible();
  await expect(page.locator("input[name=barcode]")).toHaveValue("0796554992983");
  await expect(page.locator("input[name=nameAr]")).toHaveValue("NEOPRET ANTI-HAIR LOSS SHAMPOO");
  await expect(page.locator(".reference-summary")).toContainText("Shafe-Med");
  await page.locator(".modal-backdrop .modal-actions button").first().click();

  await page.getByRole("button", { name: "المصروفات" }).click();
  await expect(page.getByRole("heading", { name: "المصروفات والدرج" })).toBeVisible();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الإعدادات" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "السكانر والطابعة" })).toBeVisible();
  await expect(page.locator('select[name="scannerMode"]')).toHaveValue("HID");
  await expect(page.locator('select[name="scannerTerminator"]')).toHaveValue("ENTER");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("asks for sale or goods receipt before the first scan and routes receipt scans to its sheet", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "نقطة البيع" }).click();
  await page.evaluate(() => localStorage.removeItem("nabta-cart-draft-v1"));
  await page.reload();
  await ensureDesktopSession();
  await page.locator(".search input").fill("0000000000002");
  await page.locator(".search input").press("Enter");
  await expect(page.getByRole("heading", { name: "ماذا تريد أن تبدأ؟" })).toBeVisible();
  await page.getByRole("button", { name: "إدخال / استلام سلع" }).click();
  await expect(page.getByRole("heading", { name: "إدارة المخزون" })).toBeVisible();
  await expect(page.getByLabel("مسح باركود صنف للاستلام")).toBeVisible();
  await expect(page.locator(".receipt-sheet-row .searchable-select > input").first()).toHaveValue(/.+/);
});

test("generates a fresh internal barcode for a product without a supplier barcode", async () => {
  await page.getByRole("button", { name: "الأصناف" }).click();
  await page.getByRole("button", { name: "إضافة صنف" }).click();
  await expect(page.getByRole("button", { name: "توليد باركود داخلي فريد" })).toBeVisible();
  await page.getByRole("button", { name: "توليد باركود داخلي فريد" }).click();
  const barcode = page.locator("input[name=barcode]");
  await expect(barcode).toHaveValue(/^NABTA-[0-9A-F]{12}$/);
  const first = await barcode.inputValue();
  await page.getByRole("button", { name: "توليد باركود داخلي فريد" }).click();
  await expect(barcode).not.toHaveValue(first);
  await page.locator(".modal-actions button").first().click();
});

test("updates an existing product price from its label editor without changing the workflow", async () => {
  await page.getByRole("button", { name: "الأصناف" }).click();
  await page.getByLabel("ابحث عن صنف بالاسم أو الباركود").fill("منتج تجريبي");
  const row = page.locator(".table-wrap tbody tr").filter({ hasText: "منتج تجريبي" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "سعر / طباعة" }).click();
  const editor = page.locator("#nabta-product-label-editor");
  await expect(editor).toBeVisible();
  await editor.getByLabel("سعر البيع بالجنيه").fill("13.50");
  await editor.getByRole("button", { name: "حفظ السعر" }).click();
  await expect(editor).toHaveCount(0);
  await expect(row).toContainText("١٣٫٥٠");
});

test("persists receipt branding and uses the store name in the interface and receipt", async () => {
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  const storeName = page.locator("input[name=storeName]");
  await expect(storeName).toBeVisible();
  await storeName.fill("سوبر نبتة التجريبي");
  await page.getByLabel("رقم الهاتف على الإيصال").fill("01012345678");
  await page.getByLabel("رقم واتساب").fill("01198765432");
  await page.getByLabel("حساب تواصل (اختياري)").fill("@nabta_test");
  await page.getByLabel("رسالة أسفل الإيصال").fill("شكراً لزيارتكم وننتظركم دائماً");
  await page.getByRole("button", { name: "حفظ هوية المتجر والإعدادات" }).click();
  await expect(page.locator(".sidebar .logo b")).toHaveText("سوبر نبتة التجريبي");
  await expect.poll(() => page.title()).toContain("سوبر نبتة التجريبي");

  await page.getByRole("button", { name: "نقطة البيع" }).click();
  await page.locator(".search input").fill("0000000000002");
  await page.locator(".search input").press("Enter");
  await page.getByRole("button", { name: "فاتورة بيع" }).click();
  await page.keyboard.press("F4");
  await page.getByRole("button", { name: "إصدار الفاتورة" }).click();
  await expect(page.locator("#receipt h2")).toHaveText("سوبر نبتة التجريبي");
  await page.getByRole("button", { name: "إغلاق" }).click();

  await page.reload();
  await ensureDesktopSession();
  await expect(page.locator(".sidebar .logo b")).toHaveText("سوبر نبتة التجريبي");
  await page.getByRole("button", { name: "الإعدادات" }).click();
  await expect(page.getByLabel("رقم الهاتف على الإيصال")).toHaveValue("01012345678");
  await expect(page.getByLabel("رقم واتساب")).toHaveValue("01198765432");
  await expect(page.getByLabel("حساب تواصل (اختياري)")).toHaveValue("@nabta_test");
});

test("persists settings checkboxes after save and reload", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();

  const credit = page.getByRole("checkbox", { name: "تفعيل البيع الآجل" });
  const expired = page.getByRole("checkbox", { name: "منع بيع الأصناف المنتهية" });
  await credit.check();
  await expired.check();
  await page.getByRole("button", { name: "حفظ هوية المتجر والإعدادات" }).click();
  await expect(page.getByText("تم حفظ هوية المتجر وتصميم الإيصال وإعدادات البيع.")).toBeVisible();

  await page.reload();
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "تفعيل البيع الآجل" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "منع بيع الأصناف المنتهية" })).toBeChecked();

  const automaticReceipt = page.locator("input[name=autoPrintReceipt]");
  const automaticDrawer = page.locator("input[name=cashDrawerEnabled]");
  await automaticReceipt.check();
  await automaticDrawer.check();
    await page.locator("select[name=labelPaperSize]").selectOption("58x30");
    await expect(page.locator("select[name=labelTemplate]")).toHaveValue("STANDARD");
  await page.getByRole("button", { name: "حفظ إعدادات الأجهزة" }).click();
  await expect(page.getByText("تم حفظ إعدادات الأجهزة لهذا الكاشير.")).toBeVisible();

  const savedHardware = JSON.parse(await readFile(resolve(userData, "hardware-settings.json"), "utf8")) as { autoPrintReceipt: boolean; cashDrawerEnabled: boolean; labelPaperSize: string; labelTemplate: string };
  expect(savedHardware.autoPrintReceipt).toBe(true);
  expect(savedHardware.cashDrawerEnabled).toBe(true);
    expect(savedHardware.labelPaperSize).toBe("58x30");
    expect(savedHardware.labelTemplate).toBe("STANDARD");

  await page.reload();
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await expect(page.locator("input[name=autoPrintReceipt]")).toBeChecked();
  await expect(page.locator("input[name=cashDrawerEnabled]")).toBeChecked();
    await expect(page.locator("select[name=labelPaperSize]")).toHaveValue("58x30");
    await expect(page.locator("select[name=labelTemplate]")).toHaveValue("STANDARD");
});

test("shows the selected-path backup and safe import controls in settings", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await page.getByRole("tab", { name: "النسخ والاستعادة" }).click();
  await expect(page.getByRole("heading", { name: "النسخ الاحتياطي والاستيراد الآمن" })).toBeVisible();
  await expect(page.getByRole("button", { name: "اختيار مجلد النسخ التلقائي" })).toBeVisible();
  await expect(page.getByText("ينشئ البرنامج نسخة كاملة ومختبرة كل 3 أيام", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "إنشاء نسخة واختيار مكان الحفظ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "استيراد نسخة من ملف" })).toBeVisible();
  await expect(page.getByText("لا تُستبدل بيانات المتجر الحية أثناء التشغيل.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("shows the owner guarded fresh-cycle reset controls in settings", async () => {
  await ensureDesktopSession();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الإعدادات" })).toBeVisible();
  await page.getByRole("tab", { name: "بدء دورة جديدة" }).click();
  await expect(page.getByRole("heading", { name: "بدء دورة جديدة للمتجر" })).toBeVisible();
  await page.getByRole("textbox", { name: "الرمز السري لإعادة البدء" }).fill("000000");
  await page.getByLabel("أفهم أن سجل المعاملات سيُحذف بعد إنشاء النسخة الاحتياطية.").check();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "إنشاء نسخة وبدء دورة جديدة" }).click();
  await expect(page.getByText("الرمز السري غير صحيح")).toBeVisible();
});
