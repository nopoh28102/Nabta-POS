import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { buildApp } from "../../apps/server/src/app.js";
import { createEmbeddedDatabase, type Database } from "../../apps/server/src/db.js";
import { runBackup } from "../../apps/server/src/backup.js";
import type { FastifyInstance } from "fastify";

const config = {
  NODE_ENV: "test" as const, HOST: "127.0.0.1", PORT: 7443, DATABASE_MODE: "embedded" as const,
  DATABASE_DIR: "", SETUP_TOKEN: "pglite-setup-token-2026-secure", SESSION_TTL_MINUTES: 480,
  BACKUP_RETENTION_DAYS: 30, DATA_RESET_PIN: "281020", LOG_LEVEL: "silent" as const, BACKUP_DIR: undefined as string | undefined, NABTA_LOCAL_MODE: "1" as const, PG_DUMP_PATH: undefined as string | undefined,
  COMMERCE_API_SHARED_SECRET: "commerce-test-secret-2026-with-at-least-thirty-two-characters",
  TERMINAL_RELAY_SHARED_SECRET: "terminal-relay-test-secret-2026-with-at-least-thirty-two-characters",
  TERMINAL_ENROLLMENT_PIN: "281020",
};

describe("embedded PGlite server", () => {
  let db: Database;
  let app: FastifyInstance;
  let token = "";
  let terminalId = "";
  let shiftId = "";

  beforeAll(async () => {
    config.DATABASE_DIR = await mkdtemp(resolve(tmpdir(), "nabta-pglite-"));
    db = await createEmbeddedDatabase(config.DATABASE_DIR);
    const migrationFiles = (await readdir(resolve(process.cwd(), "migrations"))).filter((file) => file.endsWith(".sql")).sort();
    for (const migrationFile of migrationFiles) await db.exec(await readFile(resolve(process.cwd(), "migrations", migrationFile), "utf8"));
    app = buildApp(config, db, { logger: false });
    await app.ready();
    const setup = await app.inject({ method: "POST", url: "/v1/setup", payload: {
      setupToken: config.SETUP_TOKEN, storeName: "متجر نبتة", branchName: "الفرع الرئيسي", ownerName: "المالك",
      username: "owner_embedded", password: "Embedded-Password-2026!", terminalName: "كاشير 1",
    } });
    expect(setup.statusCode, setup.body).toBe(201);
    terminalId = (setup.json() as { terminalId: string }).terminalId;
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "owner_embedded", password: "Embedded-Password-2026!", terminalId } });
    expect(login.statusCode, login.body).toBe(200);
    token = (login.json() as { token: string }).token;
    const shift = await app.inject({ method: "POST", url: "/v1/shifts", headers: { authorization: `Bearer ${token}` }, payload: { terminalId, openingMinor: 5_000 } });
    expect(shift.statusCode, shift.body).toBe(201);
    shiftId = (shift.json() as { id: string }).id;
  }, 60_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("persists the schema and serves the health endpoint", async () => {
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", setupCompleted: true });
  });

  it("creates a verified, resumable cloud migration snapshot without touching live data", async () => {
    config.BACKUP_DIR = await mkdtemp(resolve(tmpdir(), "nabta-cloud-migration-"));
    const before = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM products");
    const prepared = await app.inject({
      method: "POST",
      url: "/v1/cloud-migration/prepare",
      headers: { authorization: `Bearer ${token}` },
      payload: { chunkBytes: 32 * 1024 },
    });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const manifest = prepared.json() as { migrationId: string; recordCount: number; chunkCount: number; backup: { id: string; sha256: string }; tables: Array<{ name: string; rowCount: number }> };
    expect(manifest.migrationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(manifest.recordCount).toBeGreaterThan(0);
    expect(manifest.chunkCount).toBeGreaterThan(0);
    expect(manifest.backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.tables.some((table) => table.name === "products")).toBe(true);
    const firstChunk = await app.inject({ method: "GET", url: `/v1/cloud-migration/${manifest.migrationId}/chunks/0`, headers: { authorization: `Bearer ${token}` } });
    expect(firstChunk.statusCode, firstChunk.body).toBe(200);
    expect(firstChunk.json()).toMatchObject({ migrationId: manifest.migrationId, sequence: 0 });
    const after = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM products");
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  }, 60_000);

  it("records shop consumption as a drawer expense and includes it in monthly reports", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const month = date.slice(0, 7);
    const movement = await app.inject({
      method: "POST",
      url: `/v1/shifts/${shiftId}/cash-movements`,
      headers,
      payload: {
        type: "EXPENSE", amountMinor: 1_250, reason: "استهلاك المحل: أكياس تغليف",
        consumption: { itemName: "أكياس تغليف", category: "تغليف وأكياس", quantityNote: "3 رزم", supplierName: "مورد الاختبار", consumedOn: date, note: "إيصال نقدي" },
      },
    });
    expect(movement.statusCode, movement.body).toBe(201);
    const listed = await app.inject({ method: "GET", url: `/v1/shop-consumptions?from=${month}-01&to=${date}`, headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json() as { items: Array<{ itemName: string; amountMinor: number }> }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemName: "أكياس تغليف", amountMinor: 1_250 }),
    ]));
    const report = await app.inject({ method: "GET", url: `/v1/reports/summary?from=${month}-01&to=${date}`, headers });
    expect(report.statusCode, report.body).toBe(200);
    expect((report.json() as { expenses_minor: number }).expenses_minor).toBeGreaterThanOrEqual(1_250);
  });

  it("commits a sale and keeps the stock ledger atomic", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "منتج مضمّن", category: "اختبار", unitKind: "PIECE", priceMinor: 1_000, reorderLevelMilli: 0,
      barcodes: ["0000000000999"], wholesalePriceMinor: 650, purchasePackSize: 10, openingQtyMilli: 1_000, openingUnitCostMinor: 500,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
    const generatedBarcode = await app.inject({ method: "POST", url: "/v1/product-barcodes/generate", headers });
    expect(generatedBarcode.statusCode, generatedBarcode.body).toBe(200);
    const numericBarcode = (generatedBarcode.json() as { barcode: string; symbology: string }).barcode;
    expect(numericBarcode).toMatch(/^\d{13}$/);
    expect((generatedBarcode.json() as { symbology: string }).symbology).toBe("EAN13");
    const checksum = [...numericBarcode.slice(0, -1)].reduce(
      (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
    expect(Number(numericBarcode.at(-1))).toBe((10 - (checksum % 10)) % 10);
    const attachedBarcode = await app.inject({
      method: "POST",
      url: `/v1/products/${productId}/barcodes`,
      headers,
      payload: { barcode: numericBarcode },
    });
    expect(attachedBarcode.statusCode, attachedBarcode.body).toBe(201);
    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: { terminalId, shiftId, lines: [{ productId, qtyMilli: 1_000 }], discountMinor: 0 } });
    expect(quote.statusCode, quote.body).toBe(201);
    const quoteData = quote.json() as { quoteId: string; totalMinor: number };
    const sale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000001" }, payload: {
      terminalId, shiftId, quoteId: quoteData.quoteId, payments: [{ method: "CASH", amountMinor: quoteData.totalMinor, tenderedMinor: quoteData.totalMinor }],
    } });
    expect(sale.statusCode, sale.body).toBe(201);
    const balance = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(balance.rows[0]!.qty_milli).toBe(0);
    const retry = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000001" }, payload: {
      terminalId, shiftId, quoteId: quoteData.quoteId, payments: [{ method: "CASH", amountMinor: quoteData.totalMinor, tenderedMinor: quoteData.totalMinor }],
    } });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replay"]).toBe("true");
    const posted = sale.json() as { saleId: string; invoiceNo: string };
    const lookup = await app.inject({ method: "GET", url: `/v1/sales/lookup?invoiceNo=${encodeURIComponent(posted.invoiceNo)}`, headers });
    expect(lookup.statusCode, lookup.body).toBe(200);
    const lookedUp = lookup.json() as { sale_id: string; lines: Array<{ id: string; qtyMilli: number }> };
    expect(lookedUp.sale_id).toBe(posted.saleId);
    const returned = await app.inject({ method: "POST", url: `/v1/sales/${posted.saleId}/returns`, headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000002" }, payload: {
      shiftId, lines: [{ saleLineId: lookedUp.lines[0]!.id, qtyMilli: 1_000, condition: "RESTOCK" }], reason: "اختبار إرجاع",
    } });
    expect(returned.statusCode, returned.body).toBe(201);
    const warehouse = await db.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1", [terminalId]);
    const receipt = await app.inject({ method: "POST", url: "/v1/purchase-receipts", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000003" }, payload: {
      warehouseId: warehouse.rows[0]!.warehouse_id, supplierName: "مورد الاختبار", supplierInvoiceNo: "SUP-1", supplyExpensesMinor: 100,
      lines: [{ productId, qtyMilli: 1_000, unitCostMinor: 600, wholesalePriceMinor: 700, retailPriceMinor: 1_200, lotCode: "LOT-1", expiresOn: "2027-09-30" }],
    } });
    expect(receipt.statusCode, receipt.body).toBe(201);
    const afterReceipt = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(afterReceipt.rows[0]!.qty_milli).toBe(2_000);
    const cartonReceipt = await app.inject({ method: "POST", url: "/v1/purchase-receipts", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000004" }, payload: {
      warehouseId: warehouse.rows[0]!.warehouse_id, supplierName: "مورد الكراتين", supplierInvoiceNo: "SUP-CARTON", supplyExpensesMinor: 0,
      lines: [{ productId, qtyMilli: 20_000, unitCostMinor: 125, entryUnit: "CARTON", costBasis: "LINE_TOTAL", packageCount: 2, unitsPerPackage: 10, lineTotalMinor: 2_501 }],
    } });
    expect(cartonReceipt.statusCode, cartonReceipt.body).toBe(201);
    expect(cartonReceipt.json()).toMatchObject({ goodsMinor: 2_501 });
    const pieceTotalReceipt = await app.inject({ method: "POST", url: "/v1/purchase-receipts", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a5" }, payload: {
      warehouseId: warehouse.rows[0]!.warehouse_id, supplierName: "مورد إجمالي القطع", supplyExpensesMinor: 0,
      lines: [{ productId, qtyMilli: 3_000, unitCostMinor: 333, entryUnit: "PIECE", costBasis: "LINE_TOTAL", lineTotalMinor: 1_001, retailPriceMinor: 1_250 }],
    } });
    expect(pieceTotalReceipt.statusCode, pieceTotalReceipt.body).toBe(201);
    expect(pieceTotalReceipt.json()).toMatchObject({ goodsMinor: 1_001 });
    const cartonBalance = await db.query<{ qty_milli: number; inventory_value_minor: number }>("SELECT qty_milli, inventory_value_minor FROM stock_balances WHERE product_id = $1", [productId]);
    expect(cartonBalance.rows[0]!.qty_milli).toBe(25_000);
    const cartonLine = await db.query<{ entry_unit: string; cost_basis: string; package_count: number; units_per_package: number; line_total_minor: number }>("SELECT entry_unit, cost_basis, package_count, units_per_package, line_total_minor FROM purchase_receipt_lines WHERE receipt_id = $1", [(cartonReceipt.json() as { receiptId: string }).receiptId]);
    expect(cartonLine.rows[0]).toEqual({ entry_unit: "CARTON", cost_basis: "LINE_TOTAL", package_count: 2, units_per_package: 10, line_total_minor: 2_501 });
    const prices = await db.query<{ price_minor: number; wholesale_price_minor: number }>("SELECT price_minor, wholesale_price_minor FROM products WHERE id = $1", [productId]);
    expect(prices.rows[0]).toEqual({ price_minor: 1_250, wholesale_price_minor: 700 });
    const expiry = await app.inject({ method: "GET", url: "/v1/stock-expiry?days=365", headers });
    expect(expiry.statusCode, expiry.body).toBe(200);
    expect((expiry.json() as { lots: Array<{ lot_code: string }> }).lots.some((lot) => lot.lot_code === "LOT-1")).toBe(true);
    const version = await db.query<{ version: number }>("SELECT version FROM stock_balances WHERE product_id = $1", [productId]);
    const count = await app.inject({ method: "POST", url: "/v1/stock-counts/post", headers, payload: {
      warehouseId: warehouse.rows[0]!.warehouse_id, productId, actualQtyMilli: 1_000, expectedVersion: version.rows[0]!.version, reason: "فرق جرد اختباري",
    } });
    expect(count.statusCode, count.body).toBe(201);
  });

  it("posts a one-off cashier item without creating a product or touching stock", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const beforeProducts = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM products");
    const beforeMovements = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM stock_movements");
    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, discountMinor: 0,
      lines: [{ manualNameAr: "جبنة رومي بيع مباشر", manualPriceMinor: 5_000, qtyMilli: 1_000, saleUnit: "UNIT" }],
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    expect(quote.json()).toMatchObject({ totalMinor: 5_000, lines: [expect.objectContaining({ manualItem: true, nameAr: "جبنة رومي بيع مباشر" })] });
    const quoteData = quote.json() as { quoteId: string; totalMinor: number };
    const sale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000ad" }, payload: {
      terminalId, shiftId, quoteId: quoteData.quoteId, payments: [{ method: "CASH", amountMinor: quoteData.totalMinor, tenderedMinor: quoteData.totalMinor }],
    } });
    expect(sale.statusCode, sale.body).toBe(201);
    const [afterProducts, afterMovements] = await Promise.all([
      db.query<{ count: number }>("SELECT count(*)::int AS count FROM products"),
      db.query<{ count: number }>("SELECT count(*)::int AS count FROM stock_movements"),
    ]);
    expect(afterProducts.rows[0]!.count).toBe(beforeProducts.rows[0]!.count);
    expect(afterMovements.rows[0]!.count).toBe(beforeMovements.rows[0]!.count);
  });

  it("enrolls another cashier on the same warehouse only through the protected relay", async () => {
    const remoteTerminalId = "00000000-0000-4000-8000-000000000099";
    const denied = await app.inject({ method: "POST", url: "/v1/terminals/enroll", payload: { terminalId: remoteTerminalId, terminalName: "كاشير 2", enrollmentPin: "281020" } });
    expect(denied.statusCode).toBe(403);
    const enrolled = await app.inject({ method: "POST", url: "/v1/terminals/enroll", headers: { "x-nabta-terminal-relay-key": config.TERMINAL_RELAY_SHARED_SECRET }, payload: { terminalId: remoteTerminalId, terminalName: "كاشير 2", enrollmentPin: "281020" } });
    expect(enrolled.statusCode, enrolled.body).toBe(201);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "owner_embedded", password: "Embedded-Password-2026!", terminalId: remoteTerminalId } });
    expect(login.statusCode, login.body).toBe(200);
  });

  it("registers expiry once without changing the stock balance and records an immutable lot event", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف صلاحية مستقل", category: "اختبار", unitKind: "PIECE", priceMinor: 1_200,
      reorderLevelMilli: 0, barcodes: ["0000000012369"], openingQtyMilli: 5_000, openingUnitCostMinor: 600,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
    const key = "00000000-0000-4000-8000-0000000000e1";
    const payload = { productId, qtyMilli: 2_000, expiresOn: "2027-12-31", lotCode: "EXP-TEST" };
    const first = await app.inject({ method: "POST", url: "/v1/stock-lots/expiry-registration", headers: { ...headers, "idempotency-key": key }, payload });
    expect(first.statusCode, first.body).toBe(201);
    const replay = await app.inject({ method: "POST", url: "/v1/stock-lots/expiry-registration", headers: { ...headers, "idempotency-key": key }, payload });
    expect(replay.statusCode, replay.body).toBe(201);
    const balances = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(balances.rows[0]!.qty_milli).toBe(5_000);
    const events = await db.query<{ qty_milli: number; expires_on: string }>("SELECT qty_milli, expires_on::text FROM stock_lot_events WHERE product_id = $1", [productId]);
    expect(events.rows).toEqual([{ qty_milli: 2_000, expires_on: "2027-12-31" }]);
  });

  it("exposes a protected customer catalogue and records a pending web order without deducting stock", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "منتج طلبات العملاء", category: "طلبات", unitKind: "PIECE", priceMinor: 1_250, reorderLevelMilli: 0,
      barcodes: ["0000000012345"], wholesalePriceMinor: 800, purchasePackSize: 1, openingQtyMilli: 8_000, openingUnitCostMinor: 700,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
    const commerceHeaders = { "x-nabta-commerce-key": config.COMMERCE_API_SHARED_SECRET };
    const blocked = await app.inject({ method: "GET", url: "/v1/commerce/catalog" });
    expect(blocked.statusCode).toBe(401);
    const catalog = await app.inject({ method: "GET", url: "/v1/commerce/catalog?query=طلبات", headers: commerceHeaders });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({
      id: productId, available: true, availableQtyMilli: 8_000, priceMinor: 1_250,
      barcodes: ["0000000012345"],
    })] });
    expect((catalog.json() as { products: Array<Record<string, unknown>> }).products[0]).not.toHaveProperty("imageUrl");
    const customerOrder = {
      clientOrderId: "00000000-0000-4000-8000-00000000c001", customerName: "عميل اختبار", customerPhone: "01000000000",
      deliveryAddress: "القاهرة - عنوان الاختبار", lines: [{ productId, qtyMilli: 2_000, saleUnit: "UNIT" }],
    };
    const saved = await app.inject({ method: "POST", url: "/v1/commerce/orders", headers: commerceHeaders, payload: customerOrder });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json()).toMatchObject({ status: "PENDING", subtotalMinor: 2_500, deliveryFeeMinor: 2_000, totalMinor: 4_500, replayed: false, trackingToken: expect.any(String) });
    const savedOrder = saved.json() as { orderId: string; trackingToken: string };
    const trackingDenied = await app.inject({ method: "GET", url: `/v1/commerce/orders/${savedOrder.orderId}`, headers: commerceHeaders });
    expect(trackingDenied.statusCode).toBe(401);
    const tracked = await app.inject({ method: "GET", url: `/v1/commerce/orders/${savedOrder.orderId}`, headers: { ...commerceHeaders, "x-nabta-order-token": savedOrder.trackingToken } });
    expect(tracked.statusCode, tracked.body).toBe(200);
    expect(tracked.json()).toMatchObject({ id: savedOrder.orderId, status: "PENDING", subtotalMinor: 2_500, deliveryFeeMinor: 2_000, totalMinor: 4_500, lines: [expect.objectContaining({ productId, qtyMilli: 2_000 })] });
    const retry = await app.inject({ method: "POST", url: "/v1/commerce/orders", headers: commerceHeaders, payload: customerOrder });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ status: "PENDING", subtotalMinor: 2_500, deliveryFeeMinor: 2_000, totalMinor: 4_500, replayed: true, trackingToken: savedOrder.trackingToken });
    const balance = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(balance.rows[0]!.qty_milli).toBe(8_000);
    const orders = await app.inject({ method: "GET", url: "/v1/commerce/admin/orders?status=PENDING", headers });
    expect(orders.statusCode, orders.body).toBe(200);
    expect(orders.json()).toMatchObject({ orders: [expect.objectContaining({ customerName: "عميل اختبار", source: "WEB", status: "PENDING", subtotalMinor: 2_500, deliveryFeeMinor: 2_000, totalMinor: 4_500, lines: [expect.objectContaining({ productId, qtyMilli: 2_000 })] })] });

    const messengerOrder = await app.inject({ method: "POST", url: "/v1/commerce/messenger/orders", headers: commerceHeaders, payload: {
      ...customerOrder,
      clientOrderId: "00000000-0000-4000-8000-00000000c002",
    } });
    expect(messengerOrder.statusCode, messengerOrder.body).toBe(201);
    expect(messengerOrder.json()).toMatchObject({ status: "PENDING", deliveryFeeMinor: 2_000, totalMinor: 4_500 });
    const confirmed = await app.inject({ method: "PUT", url: `/v1/commerce/admin/orders/${savedOrder.orderId}`, headers, payload: { status: "CONFIRMED" } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const directFulfillment = await app.inject({ method: "PUT", url: `/v1/commerce/admin/orders/${savedOrder.orderId}`, headers, payload: { status: "FULFILLED" } });
    expect(directFulfillment.statusCode, directFulfillment.body).toBe(409);
    expect(directFulfillment.json()).toMatchObject({ code: "CUSTOMER_ORDER_FINAL_SALE_REQUIRED" });
  });

  it("sells a retail package and its loose contents as separate invoice lines", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "عبوة أكياس اختبار", category: "اختبار", unitKind: "PIECE", priceMinor: 150,
      wholesalePriceMinor: 75, purchasePackSize: 10, reorderLevelMilli: 0, barcodes: ["0000000000889"],
      openingQtyMilli: 20_000, openingUnitCostMinor: 75,
      retailPackage: { unitsPerPackage: 10, packagePriceMinor: 1_000, contentsUnit: "BAG" },
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;

    const catalog = await app.inject({ method: "GET", url: "/v1/catalog?query=%D8%B9%D8%A8%D9%88%D8%A9", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({
      id: productId,
      retailPackage: { unitsPerPackage: 10, packagePriceMinor: 1_000, contentsUnit: "BAG" },
    })] });

    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId,
      lines: [
        { productId, qtyMilli: 10_000, saleUnit: "PACKAGE" },
        { productId, qtyMilli: 1_000, saleUnit: "UNIT" },
      ],
      discountMinor: 0,
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    const quoteData = quote.json() as { quoteId: string; totalMinor: number; lines: Array<{ saleUnit: string; qtyMilli: number; unitPriceMinor: number; grossMinor: number }> };
    expect(quoteData.totalMinor).toBe(1_150);
    expect(quoteData.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ saleUnit: "PACKAGE", packageSize: 10, qtyMilli: 10_000, unitPriceMinor: 1_000, grossMinor: 1_000 }),
      expect.objectContaining({ saleUnit: "UNIT", qtyMilli: 1_000, unitPriceMinor: 150, grossMinor: 150 }),
    ]));

    const sale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a6" }, payload: {
      terminalId, shiftId, quoteId: quoteData.quoteId,
      payments: [{ method: "CASH", amountMinor: quoteData.totalMinor, tenderedMinor: quoteData.totalMinor }],
    } });
    expect(sale.statusCode, sale.body).toBe(201);

    const balance = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(balance.rows[0]!.qty_milli).toBe(9_000);
    const lines = await db.query<{ sale_unit_snapshot: string; sale_package_size_snapshot: number | null; qty_milli: number; unit_price_minor: number }>(
      "SELECT sale_unit_snapshot, sale_package_size_snapshot, qty_milli, unit_price_minor FROM sale_lines WHERE sale_id = $1 ORDER BY sale_unit_snapshot",
      [(sale.json() as { saleId: string }).saleId],
    );
    expect(lines.rows).toEqual([
      { sale_unit_snapshot: "PACKAGE", sale_package_size_snapshot: 10, qty_milli: 10_000, unit_price_minor: 1_000 },
      { sale_unit_snapshot: "UNIT", sale_package_size_snapshot: null, qty_milli: 1_000, unit_price_minor: 150 },
    ]);
    const invoice = await app.inject({ method: "GET", url: `/v1/invoices/SALE/${(sale.json() as { saleId: string }).saleId}`, headers });
    expect(invoice.statusCode, invoice.body).toBe(200);
    expect(invoice.json()).toMatchObject({ lines: expect.arrayContaining([
      expect.objectContaining({ saleUnit: "PACKAGE", packageSize: 10, qtyMilli: 10_000, unitPriceMinor: 1_000, totalMinor: 1_000 }),
    ]) });
  });

  it("converts an existing loose-piece product to carton sales without changing its stock", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "قطع تتحول لكرتونة", category: "اختبار", unitKind: "PIECE", priceMinor: 350,
      wholesalePriceMinor: 200, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["convert-unit-1"], openingQtyMilli: 27_000, openingUnitCostMinor: 200,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const productId = (created.json() as { id: string }).id;
    const before = await db.query<{ qty_milli: number; version: number }>("SELECT qty_milli, version FROM stock_balances WHERE product_id = $1", [productId]);
    const converted = await app.inject({ method: "PUT", url: `/v1/products/${productId}`, headers, payload: {
      productId, nameAr: "قطع تتحول لكرتونة", category: "اختبار", description: "", priceMinor: 350,
      wholesalePriceMinor: 200, purchasePackSize: 12, cartonPriceMinor: 3_900, cartonContentsUnit: "PIECE",
      barcodeMappings: [{ barcode: "convert-carton-1", saleUnit: "CARTON" }],
      retailPackage: null, availableQtyMilli: 27_000, expectedStockVersion: before.rows[0]!.version,
    } });
    expect(converted.statusCode, converted.body).toBe(200);
    const after = await db.query<{ qty_milli: number; version: number }>("SELECT qty_milli, version FROM stock_balances WHERE product_id = $1", [productId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const catalog = await app.inject({ method: "GET", url: "/v1/catalog?query=convert-carton-1", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({ id: productId, purchasePackSize: 12, cartonPriceMinor: 3_900 })] });
    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, discountMinor: 0,
      lines: [{ productId, qtyMilli: 24_000, saleUnit: "CARTON" }, { productId, qtyMilli: 3_000, saleUnit: "UNIT" }],
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    expect((quote.json() as { totalMinor: number }).totalMinor).toBe(8_850);
  });

  it("sells a supplier carton or a loose bag from the same carton stock", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "مقرمشات صندوق بيع", category: "تسالي", unitKind: "PIECE", priceMinor: 500,
      cartonPriceMinor: 5_500, wholesalePriceMinor: 300, purchasePackSize: 12, reorderLevelMilli: 0,
      cartonContentsUnit: "BAG",
      barcodes: ["0000000000667"], openingQtyMilli: 24_000, openingUnitCostMinor: 300,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, discountMinor: 0,
      lines: [
        { productId, qtyMilli: 12_000, saleUnit: "CARTON" },
        { productId, qtyMilli: 1_000, saleUnit: "UNIT" },
      ],
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    const quoteData = quote.json() as { quoteId: string; totalMinor: number; lines: Array<{ saleUnit: string; packageSize?: number; unitPriceMinor: number; grossMinor: number }> };
    expect(quoteData.totalMinor).toBe(6_000);
    expect(quoteData.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ saleUnit: "CARTON", packageSize: 12, unitPriceMinor: 5_500, grossMinor: 5_500 }),
      expect.objectContaining({ saleUnit: "UNIT", unitPriceMinor: 500, grossMinor: 500 }),
    ]));
    const sale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a8" }, payload: {
      terminalId, shiftId, quoteId: quoteData.quoteId,
      payments: [{ method: "CASH", amountMinor: quoteData.totalMinor, tenderedMinor: quoteData.totalMinor }],
    } });
    expect(sale.statusCode, sale.body).toBe(201);
    const balance = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(balance.rows[0]!.qty_milli).toBe(11_000);
    const lines = await db.query<{ sale_unit_snapshot: string; sale_package_size_snapshot: number | null }>(
      "SELECT sale_unit_snapshot, sale_package_size_snapshot FROM sale_lines WHERE sale_id = $1 ORDER BY sale_unit_snapshot",
      [(sale.json() as { saleId: string }).saleId],
    );
    expect(lines.rows).toEqual([
      { sale_unit_snapshot: "CARTON", sale_package_size_snapshot: 12 },
      { sale_unit_snapshot: "UNIT", sale_package_size_snapshot: null },
    ]);
  });

  it("maps package and carton barcodes to their selling units", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "باركودات عبوة وكرتونة", category: "اختبار", unitKind: "PIECE", priceMinor: 150,
      wholesalePriceMinor: 75, purchasePackSize: 12, reorderLevelMilli: 0, cartonPriceMinor: 2_500,
      cartonContentsUnit: "BAG", openingQtyMilli: 36_000, openingUnitCostMinor: 75,
      retailPackage: { unitsPerPackage: 6, packagePriceMinor: 1_000, contentsUnit: "BAG" },
      barcodes: ["unit-barcode-1", "package-barcode-1", "carton-barcode-1"],
      barcodeMappings: [
        { barcode: "unit-barcode-1", saleUnit: "UNIT" },
        { barcode: "package-barcode-1", saleUnit: "PACKAGE" },
        { barcode: "carton-barcode-1", saleUnit: "CARTON" },
      ],
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;

    const catalog = await app.inject({ method: "GET", url: "/v1/catalog?query=carton-barcode-1", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({
      id: productId,
      barcodeMappings: expect.arrayContaining([
        { barcode: "unit-barcode-1", saleUnit: "UNIT" },
        { barcode: "package-barcode-1", saleUnit: "PACKAGE" },
        { barcode: "carton-barcode-1", saleUnit: "CARTON" },
      ]),
    })] });

    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, discountMinor: 0,
      lines: [
        { productId, qtyMilli: 6_000, saleUnit: "PACKAGE" },
        { productId, qtyMilli: 12_000, saleUnit: "CARTON" },
      ],
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    expect(quote.json()).toMatchObject({ totalMinor: 3_500, lines: expect.arrayContaining([
      expect.objectContaining({ saleUnit: "PACKAGE", qtyMilli: 6_000, unitPriceMinor: 1_000 }),
      expect.objectContaining({ saleUnit: "CARTON", qtyMilli: 12_000, unitPriceMinor: 2_500 }),
    ]) });

    const unchangedUnits = await app.inject({ method: "PUT", url: `/v1/products/${productId}`, headers, payload: {
      nameAr: "باركودات عبوة وكرتونة", category: "اختبار", description: "", priceMinor: 150,
      wholesalePriceMinor: 75, purchasePackSize: 12, cartonPriceMinor: 2_500, cartonContentsUnit: "BAG",
      retailPackage: { unitsPerPackage: 6, packagePriceMinor: 1_000, contentsUnit: "BAG" },
      availableQtyMilli: 36_000, expectedStockVersion: 1,
      barcodeMappings: [{ barcode: "package-barcode-1", saleUnit: "PACKAGE" }],
    } });
    expect(unchangedUnits.statusCode, unchangedUnits.body).toBe(200);
    const mappings = await db.query<{ barcode: string; sale_unit: string }>("SELECT barcode, sale_unit FROM product_barcodes WHERE product_id = $1 ORDER BY barcode", [productId]);
    expect(mappings.rows).toEqual([
      { barcode: "package-barcode-1", sale_unit: "PACKAGE" },
      { barcode: "unit-barcode-1", sale_unit: "UNIT" },
    ]);

    const reassignSingleBarcode = await app.inject({ method: "PUT", url: `/v1/products/${productId}`, headers, payload: {
      nameAr: "باركودات عبوة وكرتونة", category: "اختبار", description: "", priceMinor: 150,
      wholesalePriceMinor: 75, purchasePackSize: 12, cartonPriceMinor: 2_500, cartonContentsUnit: "BAG",
      retailPackage: { unitsPerPackage: 6, packagePriceMinor: 1_000, contentsUnit: "BAG" },
      availableQtyMilli: 36_000, expectedStockVersion: 1,
      barcodeMappings: [{ barcode: "unit-barcode-1", saleUnit: "CARTON" }],
    } });
    expect(reassignSingleBarcode.statusCode, reassignSingleBarcode.body).toBe(200);
    const reassignedMappings = await db.query<{ barcode: string; sale_unit: string }>("SELECT barcode, sale_unit FROM product_barcodes WHERE product_id = $1 ORDER BY barcode", [productId]);
    expect(reassignedMappings.rows).toEqual([
      { barcode: "unit-barcode-1", sale_unit: "CARTON" },
    ]);
  });

  it("merges a legacy barcode product into its package product without duplicating stock", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const target = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "الصنف الموحّد", category: "اختبار", unitKind: "PIECE", priceMinor: 125,
      wholesalePriceMinor: 70, purchasePackSize: 6, reorderLevelMilli: 0,
      retailPackage: { unitsPerPackage: 6, packagePriceMinor: 600, contentsUnit: "BAG" },
      barcodes: ["merge-target-unit"], openingQtyMilli: 12_000, openingUnitCostMinor: 70,
    } });
    const source = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "الصنف القديم للعبوة", category: "اختبار", unitKind: "PIECE", priceMinor: 600,
      wholesalePriceMinor: 70, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["merge-legacy-package"], openingQtyMilli: 6_000, openingUnitCostMinor: 70,
    } });
    expect(target.statusCode, target.body).toBe(201);
    expect(source.statusCode, source.body).toBe(201);
    const targetId = (target.json() as { id: string }).id;
    const sourceId = (source.json() as { id: string }).id;
    const merged = await app.inject({ method: "PUT", url: `/v1/products/${targetId}`, headers, payload: {
      nameAr: "الصنف الموحّد", category: "اختبار", description: "", priceMinor: 125,
      wholesalePriceMinor: 70, purchasePackSize: 6, retailPackage: { unitsPerPackage: 6, packagePriceMinor: 600, contentsUnit: "BAG" },
      cartonPriceMinor: null, cartonContentsUnit: null, availableQtyMilli: 12_000, expectedStockVersion: 1,
      barcodeMappings: [{ barcode: "merge-legacy-package", saleUnit: "PACKAGE" }], mergeLegacyProducts: true,
    } });
    expect(merged.statusCode, merged.body).toBe(200);
    const balances = await db.query<{ product_id: string; qty_milli: number; inventory_value_minor: number }>(
      "SELECT product_id, qty_milli, inventory_value_minor FROM stock_balances WHERE product_id = ANY($1::uuid[]) ORDER BY product_id",
      [[sourceId, targetId]],
    );
    expect(balances.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: targetId, qty_milli: 18_000, inventory_value_minor: 1_260 }),
      expect.objectContaining({ product_id: sourceId, qty_milli: 0, inventory_value_minor: 0 }),
    ]));
    const sourceArchived = await db.query<{ active: boolean }>("SELECT active FROM products WHERE id = $1", [sourceId]);
    expect(sourceArchived.rows[0]!.active).toBe(false);
    const lookup = await app.inject({ method: "GET", url: "/v1/catalog?query=merge-legacy-package", headers });
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json()).toMatchObject({ products: [expect.objectContaining({ id: targetId, barcodeMappings: expect.arrayContaining([
      { barcode: "merge-legacy-package", saleUnit: "PACKAGE" },
    ]) })] });
  });

  it("unifies two existing loose and carton barcode products into one corrected product", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const loose = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "مشروب فردي قديم", category: "اختبار", unitKind: "PIECE", priceMinor: 200,
      wholesalePriceMinor: 70, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["force-merge-unit"], openingQtyMilli: 2_000, openingUnitCostMinor: 70,
    } });
    const carton = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "مشروب كرتونة قديم", category: "اختبار", unitKind: "PIECE", priceMinor: 2_000,
      wholesalePriceMinor: 80, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["force-merge-carton"], openingQtyMilli: 12_000, openingUnitCostMinor: 80,
    } });
    expect(loose.statusCode, loose.body).toBe(201);
    expect(carton.statusCode, carton.body).toBe(201);
    const looseId = (loose.json() as { id: string }).id;
    const cartonId = (carton.json() as { id: string }).id;

    const merged = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "مشروب موحد كرتونة 12", category: "مشروبات", unitKind: "PIECE", priceMinor: 300,
      wholesalePriceMinor: 100, purchasePackSize: 12, cartonPriceMinor: 3_300, cartonContentsUnit: "PIECE",
      reorderLevelMilli: 0,
      barcodes: ["force-merge-unit", "force-merge-carton"],
      barcodeMappings: [
        { barcode: "force-merge-unit", saleUnit: "UNIT" },
        { barcode: "force-merge-carton", saleUnit: "CARTON" },
      ],
      openingQtyMilli: 12_000, openingUnitCostMinor: 100, openingTotalCostMinor: 1_200,
    } });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json()).toMatchObject({ id: looseId, merged: true });

    const balances = await db.query<{ product_id: string; qty_milli: number; inventory_value_minor: number }>(
      "SELECT product_id, qty_milli, inventory_value_minor FROM stock_balances WHERE product_id = ANY($1::uuid[]) ORDER BY product_id",
      [[looseId, cartonId]],
    );
    expect(balances.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: looseId, qty_milli: 26_000, inventory_value_minor: 2_300 }),
      expect.objectContaining({ product_id: cartonId, qty_milli: 0, inventory_value_minor: 0 }),
    ]));
    const sourceArchived = await db.query<{ active: boolean }>("SELECT active FROM products WHERE id = $1", [cartonId]);
    expect(sourceArchived.rows[0]!.active).toBe(false);
    const barcodeOwners = await db.query<{ barcode: string; product_id: string; sale_unit: string; conversion_qty_milli: number }>(
      "SELECT barcode, product_id, sale_unit, conversion_qty_milli FROM product_barcodes WHERE barcode = ANY($1::text[]) ORDER BY barcode",
      [["force-merge-carton", "force-merge-unit"]],
    );
    expect(barcodeOwners.rows).toEqual([
      { barcode: "force-merge-carton", product_id: looseId, sale_unit: "CARTON", conversion_qty_milli: 12_000 },
      { barcode: "force-merge-unit", product_id: looseId, sale_unit: "UNIT", conversion_qty_milli: 1_000 },
    ]);
  });

  it("automatically updates an existing product when a carton or package barcode is entered again", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const existing = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "عصير فردي", category: "اختبار", unitKind: "PIECE", priceMinor: 250,
      wholesalePriceMinor: 70, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["barcode-upsert-unit"], openingQtyMilli: 3_000, openingUnitCostMinor: 70,
    } });
    expect(existing.statusCode, existing.body).toBe(201);
    const productId = (existing.json() as { id: string }).id;

    const merged = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "عصير كرتونة 12", category: "مشروبات", unitKind: "PIECE", priceMinor: 300,
      wholesalePriceMinor: 100, purchasePackSize: 12, cartonPriceMinor: 3_300, cartonContentsUnit: "PIECE",
      reorderLevelMilli: 0,
      barcodes: ["barcode-upsert-unit", "barcode-upsert-carton"],
      barcodeMappings: [
        { barcode: "barcode-upsert-unit", saleUnit: "UNIT" },
        { barcode: "barcode-upsert-carton", saleUnit: "CARTON" },
      ],
      openingQtyMilli: 12_000, openingUnitCostMinor: 100, openingTotalCostMinor: 1_200,
    } });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json()).toMatchObject({ id: productId, merged: true });

    const product = await db.query<{ name_ar: string; purchase_pack_size: number; carton_price_minor: number; qty_milli: number; inventory_value_minor: number }>(`
      SELECT p.name_ar, p.purchase_pack_size, p.carton_price_minor, sb.qty_milli, sb.inventory_value_minor
      FROM products p JOIN stock_balances sb ON sb.product_id = p.id
      WHERE p.id = $1
    `, [productId]);
    expect(product.rows[0]).toEqual({
      name_ar: "عصير كرتونة 12", purchase_pack_size: 12, carton_price_minor: 3_300,
      qty_milli: 15_000, inventory_value_minor: 1_410,
    });
    const mappings = await db.query<{ barcode: string; sale_unit: string; conversion_qty_milli: number }>(
      "SELECT barcode, sale_unit, conversion_qty_milli FROM product_barcodes WHERE product_id = $1 ORDER BY barcode",
      [productId],
    );
    expect(mappings.rows).toEqual([
      { barcode: "barcode-upsert-carton", sale_unit: "CARTON", conversion_qty_milli: 12_000 },
      { barcode: "barcode-upsert-unit", sale_unit: "UNIT", conversion_qty_milli: 1_000 },
    ]);
    const mergeMovement = await db.query<{ movement_type: string; qty_delta_milli: number; value_delta_minor: number }>(`
      SELECT movement_type, qty_delta_milli, value_delta_minor
      FROM stock_movements
      WHERE product_id = $1 AND reference_type = 'product_barcode_merge'
    `, [productId]);
    expect(mergeMovement.rows).toEqual([{ movement_type: "COUNT_ADJUSTMENT", qty_delta_milli: 12_000, value_delta_minor: 1_200 }]);
  });

  it("restores an archived barcode product and applies the new product configuration", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف مؤرشف", category: "اختبار", unitKind: "PIECE", priceMinor: 100,
      wholesalePriceMinor: 40, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["archived-barcode-upsert"], openingQtyMilli: 0, openingUnitCostMinor: 0,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const productId = (created.json() as { id: string }).id;
    await db.query("UPDATE products SET active = false WHERE id = $1", [productId]);

    const restored = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف مستعاد كرتونة", category: "اختبار جديد", unitKind: "PIECE", priceMinor: 150,
      wholesalePriceMinor: 60, purchasePackSize: 6, cartonPriceMinor: 800, cartonContentsUnit: "PIECE",
      reorderLevelMilli: 0,
      barcodes: ["archived-barcode-upsert", "archived-carton-upsert"],
      barcodeMappings: [
        { barcode: "archived-barcode-upsert", saleUnit: "UNIT" },
        { barcode: "archived-carton-upsert", saleUnit: "CARTON" },
      ],
      openingQtyMilli: 6_000, openingUnitCostMinor: 60, openingTotalCostMinor: 360,
    } });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ id: productId, merged: true, restored: true });
    const saved = await db.query<{ active: boolean; name_ar: string; qty_milli: number }>(`
      SELECT p.active, p.name_ar, sb.qty_milli
      FROM products p JOIN stock_balances sb ON sb.product_id = p.id
      WHERE p.id = $1
    `, [productId]);
    expect(saved.rows[0]).toEqual({ active: true, name_ar: "صنف مستعاد كرتونة", qty_milli: 6_000 });
  });

  it("permanently deletes an unused product so its barcode can be created again", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "مسودة بلا حركة", category: "اختبار", unitKind: "PIECE", priceMinor: 100,
      wholesalePriceMinor: 0, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["purge-unused-barcode"], openingQtyMilli: 0, openingUnitCostMinor: 0,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const productId = (created.json() as { id: string }).id;
    const deleted = await app.inject({ method: "DELETE", url: `/v1/products/${productId}`, headers });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ id: productId, purged: true, archived: false });
    const remaining = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM products WHERE id = $1", [productId]);
    expect(remaining.rows[0]!.count).toBe(0);
  });

  it("finds a product when the cashier types a close Arabic spelling", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "شيبسي بطاطس بالجبنة", category: "اختبار البحث", unitKind: "PIECE", priceMinor: 100,
      wholesalePriceMinor: 50, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["fuzzy-search-0001"], openingQtyMilli: 1_000, openingUnitCostMinor: 50,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
    const catalog = await app.inject({ method: "GET", url: "/v1/catalog?query=%D8%B4%D8%A8%D8%B3", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({ id: productId })] });
  });

  it("records payroll once, includes it in profit, and protects cash drawer balance", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const employee = await db.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner_embedded'");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const month = date.slice(0, 7);
    const payroll = await app.inject({ method: "POST", url: "/v1/payroll", headers, payload: {
      employeeUserId: employee.rows[0]!.id, payrollMonth: month, baseMinor: 1_000, overtimeMinor: 100,
      bonusMinor: 0, deductionMinor: 50, advanceMinor: 0, paymentMethod: "CASH", shiftId, paidOn: date,
    } });
    expect(payroll.statusCode, payroll.body).toBe(201);
    expect(payroll.json()).toMatchObject({ netMinor: 1_050 });
    const listed = await app.inject({ method: "GET", url: `/v1/payroll?month=${month}`, headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({ items: [expect.objectContaining({ netMinor: 1_050, paymentMethod: "CASH" })] });
    const report = await app.inject({ method: "GET", url: `/v1/reports/comprehensive?from=${date}&to=${date}`, headers });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json()).toMatchObject({ summary: { payrollMinor: 1_050 }, payroll: [expect.objectContaining({ netMinor: 1_050 })] });
  });

  it("receives and sells weighted products in exact grams", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const warehouse = await db.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1", [terminalId]);
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "جبن موزون", category: "أجبان", unitKind: "WEIGHT", weightUnit: "GRAM", priceMinor: 14_500,
      wholesalePriceMinor: 11_250, purchasePackSize: 1, reorderLevelMilli: 0,
      barcodes: ["2091234567896"], openingQtyMilli: 0, openingUnitCostMinor: 0,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
    const catalog = await app.inject({ method: "GET", url: "/v1/catalog?query=%D8%AC%D8%A8%D9%86%20%D9%85%D9%88%D8%B2%D9%88%D9%86", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({ id: productId, weightUnit: "GRAM" })] });
    const weightedCatalog = await app.inject({ method: "GET", url: "/v1/catalog?unitKind=WEIGHT", headers });
    expect(weightedCatalog.statusCode, weightedCatalog.body).toBe(200);
    expect((weightedCatalog.json() as { products: Array<{ id: string; unitKind: string }> }).products).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: productId, unitKind: "WEIGHT" })]),
    );
    expect((weightedCatalog.json() as { products: Array<{ unitKind: string }> }).products.every((item) => item.unitKind === "WEIGHT")).toBe(true);
    for (const [nameAr, weightUnit, barcode] of [
      ["موز بالكيلو", "KILOGRAM", "2091234567801"],
      ["عصير باللتر", "LITER", "2091234567802"],
      ["عطر بالملليلتر", "MILLILITER", "2091234567803"],
    ] as const) {
      const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
        nameAr, category: "اختبار الوحدات", unitKind: "WEIGHT", weightUnit, priceMinor: 10_000,
        wholesalePriceMinor: 5_000, purchasePackSize: 1, reorderLevelMilli: 0,
        barcodes: [barcode], openingQtyMilli: 0, openingUnitCostMinor: 0,
      } });
      expect(created.statusCode, created.body).toBe(201);
    }
    const allWeighted = await app.inject({ method: "GET", url: "/v1/catalog?unitKind=WEIGHT&limit=200", headers });
    expect(allWeighted.statusCode, allWeighted.body).toBe(200);
    expect((allWeighted.json() as { products: Array<{ weightUnit: string }> }).products.map((item) => item.weightUnit)).toEqual(expect.arrayContaining(["KILOGRAM", "GRAM", "LITER", "MILLILITER"]));
    const receipt = await app.inject({ method: "POST", url: "/v1/purchase-receipts", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a7" }, payload: {
      warehouseId: warehouse.rows[0]!.warehouse_id, supplierName: "مورد أجبان", supplyExpensesMinor: 0,
      lines: [{ productId, qtyMilli: 8_000, unitCostMinor: 11_250, entryUnit: "WEIGHT", costBasis: "UNIT" }],
    } });
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(receipt.json()).toMatchObject({ goodsMinor: 90_000 });
    const savedLine = await db.query<{ entry_unit: string; qty_milli: number; goods_minor: number }>(
      "SELECT entry_unit, qty_milli, goods_minor FROM purchase_receipt_lines WHERE receipt_id = $1",
      [(receipt.json() as { receiptId: string }).receiptId],
    );
    expect(savedLine.rows[0]).toEqual({ entry_unit: "WEIGHT", qty_milli: 8_000, goods_minor: 90_000 });
    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, lines: [{ productId, qtyMilli: 250 }], discountMinor: 0,
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    expect(quote.json()).toMatchObject({ totalMinor: 3_625, lines: [expect.objectContaining({ qtyMilli: 250, unitKind: "WEIGHT" })] });

    // Cashiers may enter the final amount directly for loose weighted goods.
    // The receipt amount must remain exactly what was typed, while the
    // derived physical quantity is what reaches the stock ledger.
    const exactAmountQuote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, lines: [{ productId, qtyMilli: 345, enteredTotalMinor: 5_000 }], discountMinor: 0,
    } });
    expect(exactAmountQuote.statusCode, exactAmountQuote.body).toBe(201);
    expect(exactAmountQuote.json()).toMatchObject({ totalMinor: 5_000, lines: [expect.objectContaining({ qtyMilli: 345, grossMinor: 5_000 })] });
    const directPriceSale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000ac" }, payload: {
      terminalId, shiftId, quoteId: (exactAmountQuote.json() as { quoteId: string }).quoteId,
      payments: [{ method: "CASH", amountMinor: 5_000, tenderedMinor: 5_000 }],
    } });
    expect(directPriceSale.statusCode, directPriceSale.body).toBe(201);
    const balanceAfterDirectPrice = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2", [warehouse.rows[0]!.warehouse_id, productId]);
    expect(balanceAfterDirectPrice.rows[0]!.qty_milli).toBe(7_655);
  });

  it("stores a weighed-price label without reducing stock, then consumes it only on sale", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const warehouse = await db.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1", [terminalId]);
    const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "حلاوة ميزان", category: "حلويات", unitKind: "WEIGHT", weightUnit: "GRAM", priceMinor: 10_000,
      wholesalePriceMinor: 6_000, purchasePackSize: 1, reorderLevelMilli: 0, barcodes: ["2091234567889"],
      openingQtyMilli: 3_000, openingUnitCostMinor: 6_000,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const productId = (created.json() as { id: string }).id;
    const label = await app.inject({ method: "POST", url: "/v1/weighted-labels", headers, payload: { productId, mode: "AMOUNT", amountMinor: 10_000 } });
    expect(label.statusCode, label.body).toBe(201);
    const savedLabel = (label.json() as { label: { barcode: string; qtyMilli: number; totalMinor: number } }).label;
    expect(savedLabel).toMatchObject({ qtyMilli: 1_000, totalMinor: 10_000 });
    expect(savedLabel.barcode).toMatch(/^\d{13}$/);
    const untouched = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2", [warehouse.rows[0]!.warehouse_id, productId]);
    expect(untouched.rows[0]!.qty_milli).toBe(3_000);
    const quote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: {
      terminalId, shiftId, discountMinor: 0, lines: [{ productId, qtyMilli: savedLabel.qtyMilli, weightedLabelBarcode: savedLabel.barcode }],
    } });
    expect(quote.statusCode, quote.body).toBe(201);
    expect(quote.json()).toMatchObject({ totalMinor: 10_000, lines: [expect.objectContaining({ weightedLabelBarcode: savedLabel.barcode, unitPriceMinor: 10_000 })] });
    const sale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000019" }, payload: {
      terminalId, shiftId, quoteId: (quote.json() as { quoteId: string }).quoteId, payments: [{ method: "CASH", amountMinor: 10_000, tenderedMinor: 10_000 }],
    } });
    expect(sale.statusCode, sale.body).toBe(201);
    const afterSale = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2", [warehouse.rows[0]!.warehouse_id, productId]);
    expect(afterSale.rows[0]!.qty_milli).toBe(2_000);
    const consumed = await db.query<{ used_sale_id: string | null }>("SELECT used_sale_id FROM weighted_product_labels WHERE barcode = $1", [savedLabel.barcode]);
    expect(consumed.rows[0]!.used_sale_id).toBeTruthy();
  });

  it("creates an opening carton with exact total cost and both retail prices", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "شيبسي كرتونة", category: "تسالي", unitKind: "PIECE", priceMinor: 350,
      cartonPriceMinor: 3_500, wholesalePriceMinor: 125, purchasePackSize: 10,
      reorderLevelMilli: 0, barcodes: ["2091234567000"], openingQtyMilli: 20_000,
      openingUnitCostMinor: 125, openingTotalCostMinor: 2_501,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const productId = (created.json() as { id: string }).id;
    const balance = await db.query<{ qty_milli: number; inventory_value_minor: number }>(
      "SELECT qty_milli, inventory_value_minor FROM stock_balances WHERE product_id = $1",
      [productId],
    );
    expect(balance.rows[0]).toEqual({ qty_milli: 20_000, inventory_value_minor: 2_501 });
    const catalog = await app.inject({ method: "GET", url: "/v1/catalog?query=%D8%B4%D9%8A%D8%A8%D8%B3%D9%8A%20%D9%83%D8%B1%D8%AA%D9%88%D9%86%D8%A9", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [expect.objectContaining({ id: productId, purchasePackSize: 10, priceMinor: 350, cartonPriceMinor: 3_500 })] });
  });

  it("bounds catalogue pages and keeps exact barcode lookup available", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const firstPage = await app.inject({ method: "GET", url: "/v1/catalog?limit=1", headers });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect((firstPage.json() as { products: unknown[] }).products).toHaveLength(1);

    const barcode = await app.inject({
      method: "GET",
      url: "/v1/catalog?query=0000000000999&limit=1",
      headers,
    });
    expect(barcode.statusCode, barcode.body).toBe(200);
    expect(barcode.json()).toMatchObject({
      products: [expect.objectContaining({ barcodes: expect.arrayContaining(["0000000000999"]) })],
    });
  });

  it("serves a 50k-product catalogue through bounded keyset pages", async () => {
    const headers = { authorization: `Bearer ${token}` };
    await db.query(`
      INSERT INTO products (id, name_ar, search_name, category, unit_kind, price_minor, wholesale_price_minor, reorder_level_milli)
      SELECT gen_random_uuid(), 'صنف ضغط ' || lpad(series::text, 5, '0'), 'صنف ضغط ' || lpad(series::text, 5, '0'), 'اختبار ضغط', 'PIECE', 1000, 0, 0
      FROM generate_series(1, 50025) AS series
    `);

    const firstStartedAt = performance.now();
    const first = await app.inject({ method: "GET", url: "/v1/catalog?query=%D8%B5%D9%86%D9%81%20%D8%B6%D8%BA%D8%B7&limit=60", headers });
    expect(first.statusCode, first.body).toBe(200);
    expect(performance.now() - firstStartedAt).toBeLessThan(2_000);
    const firstPage = first.json() as { products: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(firstPage.products).toHaveLength(60);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();

    const second = await app.inject({ method: "GET", url: `/v1/catalog?query=%D8%B5%D9%86%D9%81%20%D8%B6%D8%BA%D8%B7&limit=60&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, headers });
    expect(second.statusCode, second.body).toBe(200);
    const secondPage = second.json() as { products: Array<{ id: string }> };
    expect(secondPage.products).toHaveLength(60);
    expect(secondPage.products.some((product) => firstPage.products.some((previous) => previous.id === product.id))).toBe(false);

    const deepCursorRow = await db.query<{ id: string }>("SELECT id FROM products WHERE name_ar = 'صنف ضغط 49999'");
    const deepCursor = Buffer.from(JSON.stringify({ rank: 1, nameAr: "صنف ضغط 49999", id: deepCursorRow.rows[0]!.id })).toString("base64url");
    const deepStartedAt = performance.now();
    const deep = await app.inject({ method: "GET", url: `/v1/catalog?query=%D8%B5%D9%86%D9%81%20%D8%B6%D8%BA%D8%B7&limit=60&cursor=${encodeURIComponent(deepCursor)}`, headers });
    expect(deep.statusCode, deep.body).toBe(200);
    expect(performance.now() - deepStartedAt).toBeLessThan(2_000);
    const deepPage = deep.json() as { products: Array<{ nameAr: string }>; hasMore: boolean };
    expect(deepPage.products).toHaveLength(26);
    expect(deepPage.products.at(0)?.nameAr).toBe("صنف ضغط 50000");
    expect(deepPage.hasMore).toBe(false);
    // Keep unrelated CSV/backup tests on their compact fixture database.
    await db.query("DELETE FROM products WHERE category = 'اختبار ضغط'");
    await db.exec("VACUUM FULL products");
  }, 60_000);

  it("exports a monthly, quarterly, and yearly inventory audit scoped to the current terminal", async () => {
    const headers = { authorization: `Bearer ${token}` };
    for (const period of ["MONTHLY", "QUARTERLY", "YEARLY"]) {
      const response = await app.inject({ method: "GET", url: `/v1/inventory/periodic-report?period=${period}`, headers });
      expect(response.statusCode, response.body).toBe(200);
      const report = response.json() as {
        period: string; periodStart: string; periodEnd: string;
        salesItems: Array<{ nameAr: string; grossQtyMilli: number; netSalesMinor: number }>;
        reorderItems: unknown[];
        totals: { soldProductCount: number; netSalesMinor: number };
      };
      expect(report.period).toBe(period);
      expect(report.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(report.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(report.salesItems.some((item) => item.nameAr === "منتج مضمّن" && item.grossQtyMilli === 1000)).toBe(true);
      expect(report.totals.soldProductCount).toBe(report.salesItems.length);
      expect(report.totals.netSalesMinor).toBeTypeOf("number");
    }
  });

  it("keeps data after a server restart", async () => {
    await app.close();
    await db.end();
    db = await createEmbeddedDatabase(config.DATABASE_DIR);
    app = buildApp(config, db, { logger: false });
    await app.ready();
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ setupCompleted: true });
  });

  it("builds an accurate purchase list from actual stock and reorder levels", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const empty = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف نافد لإعادة الطلب", category: "اختبار", unitKind: "PIECE", priceMinor: 900,
      reorderLevelMilli: 3_000, barcodes: ["0000000000666"], openingQtyMilli: 0, openingUnitCostMinor: 0,
    } });
    expect(empty.statusCode, empty.body).toBe(201);
    const low = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف منخفض لإعادة الطلب", category: "اختبار", unitKind: "PIECE", priceMinor: 800,
      reorderLevelMilli: 3_000, barcodes: ["0000000000555"], openingQtyMilli: 1_000, openingUnitCostMinor: 400,
    } });
    expect(low.statusCode, low.body).toBe(201);
    const list = await app.inject({ method: "GET", url: "/v1/stock/reorder-list", headers });
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json() as { items: Array<{ productId: string; status: string; availableQtyMilli: number; shortageQtyMilli: number }>; totals: { outOfStock: number; belowReorder: number } };
    expect(body.items).toContainEqual(expect.objectContaining({ productId: (empty.json() as { id: string }).id, status: "OUT_OF_STOCK", availableQtyMilli: 0, shortageQtyMilli: 3_000 }));
    expect(body.items).toContainEqual(expect.objectContaining({ productId: (low.json() as { id: string }).id, status: "BELOW_REORDER", availableQtyMilli: 1_000, shortageQtyMilli: 2_000 }));
    expect(body.totals.outOfStock).toBeGreaterThanOrEqual(1);
    expect(body.totals.belowReorder).toBeGreaterThanOrEqual(1);
  });

  it("derives a smart reorder level from recent net sales without overriding a higher manual level", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف حد ذكي", category: "اختبار", unitKind: "PIECE", priceMinor: 1_000,
      reorderLevelMilli: 0, barcodes: ["0000000000777"], openingQtyMilli: 5_000, openingUnitCostMinor: 500,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const productId = (created.json() as { id: string }).id;
    const warehouse = await db.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1", [terminalId]);
    await db.query("UPDATE stock_balances SET qty_milli = 2_000, inventory_value_minor = 1_000 WHERE warehouse_id = $1 AND product_id = $2", [warehouse.rows[0]!.warehouse_id, productId]);
    await db.query(`
      INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor,
        balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id)
      VALUES ($1, $2, 'SALE', -3_000, -1_500, 2_000, 1_000, 'smart_reorder_test', gen_random_uuid(), (SELECT id FROM users LIMIT 1))
    `, [warehouse.rows[0]!.warehouse_id, productId]);

    const list = await app.inject({ method: "GET", url: "/v1/stock/reorder-list", headers });
    expect(list.statusCode, list.body).toBe(200);
    const item = (list.json() as { items: Array<{ productId: string; reorderLevelMilli: number; smartReorderLevelMilli: number; averageDailyDemandMilli: number; status: string }> }).items.find((candidate) => candidate.productId === productId);
    expect(item).toMatchObject({ reorderLevelMilli: 2_000, smartReorderLevelMilli: 2_000, averageDailyDemandMilli: 108, status: "AT_REORDER" });
  });

  it("manages users and records receipt reprints in the immutable audit log", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/users", headers, payload: {
      displayName: "كاشير الاختبار", username: "cashier_embedded", password: "Cashier-Password-2026!", role: "CASHIER", discountLimitBps: 250,
    } });
    expect(created.statusCode, created.body).toBe(201);
    const userId = (created.json() as { id: string }).id;
    const users = await app.inject({ method: "GET", url: "/v1/users", headers });
    expect(users.statusCode, users.body).toBe(200);
    expect((users.json() as { users: Array<{ id: string; discountLimitBps: number }> }).users).toContainEqual(expect.objectContaining({ id: userId, discountLimitBps: 250 }));
    const changed = await app.inject({ method: "PUT", url: `/v1/users/${userId}`, headers, payload: {
      displayName: "كاشير موقوف", role: "CASHIER", discountLimitBps: 100, active: false,
    } });
    expect(changed.statusCode, changed.body).toBe(200);
    const sale = await db.query<{ id: string }>("SELECT id FROM sales ORDER BY posted_at LIMIT 1");
    // Legacy sales have no package size. Reprinting must omit that optional
    // field instead of sending a null into the desktop receipt contract.
    await db.query("UPDATE sale_lines SET sale_package_size_snapshot = NULL WHERE sale_id = $1", [sale.rows[0]!.id]);
    const reprint = await app.inject({ method: "POST", url: `/v1/sales/${sale.rows[0]!.id}/reprint`, headers });
    expect(reprint.statusCode, reprint.body).toBe(200);
    expect(reprint.json()).toMatchObject({ saleId: sale.rows[0]!.id, reprintCount: 1 });
    expect((reprint.json() as { lines: Array<Record<string, unknown>> }).lines).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ packageSize: null }),
    ]));
    const audit = await app.inject({ method: "GET", url: "/v1/audit?limit=100", headers });
    expect(audit.statusCode, audit.body).toBe(200);
    expect((audit.json() as { entries: Array<{ action: string; entityId: string }> }).entries).toContainEqual(expect.objectContaining({ action: "RECEIPT_REPRINTED", entityId: sale.rows[0]!.id }));
  });

  it("previews, imports and exports validated product CSV", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const csv = "nameAr,category,unitKind,priceMinor,barcode,reorderLevelMilli,openingQtyMilli,openingUnitCostMinor\nصنف CSV,اختبار,PIECE,1250,0000000000777,1000,1000,700";
    const preview = await app.inject({ method: "POST", url: "/v1/products/import", headers, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000004", csv, preview: true } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({ preview: true, rowCount: 1, errors: [] });
    const imported = await app.inject({ method: "POST", url: "/v1/products/import", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000005" }, payload: { csv, preview: false } });
    expect(imported.statusCode, imported.body).toBe(201);
    expect((imported.json() as { importedCount: number }).importedCount).toBe(1);
    const updateCsv = "nameAr,category,unitKind,priceMinor,barcode,reorderLevelMilli,openingQtyMilli,openingUnitCostMinor,wholesalePriceMinor,availableQtyMilli,weightUnit\nصنف CSV محدّث,أسعار,PIECE,1350,0000000000777,2000,9000,800,900,3000,KILOGRAM";
    const updated = await app.inject({ method: "POST", url: "/v1/products/import", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a1" }, payload: { csv: updateCsv, preview: false } });
    expect(updated.statusCode, updated.body).toBe(201);
    expect(updated.json()).toMatchObject({ importedCount: 1, createdCount: 0, updatedCount: 1 });
    const updatedCatalog = await app.inject({ method: "GET", url: "/v1/catalog?query=0000000000777", headers });
    expect(updatedCatalog.statusCode, updatedCatalog.body).toBe(200);
    expect(updatedCatalog.json()).toMatchObject({ products: [expect.objectContaining({ nameAr: "صنف CSV محدّث", category: "أسعار", priceMinor: 1350, wholesalePriceMinor: 900, availableQtyMilli: 3000 })] });
    const advancedHeader = "nameAr,category,unitKind,priceMinor,barcode,reorderLevelMilli,openingQtyMilli,openingUnitCostMinor,wholesalePriceMinor,availableQtyMilli,weightUnit,description,purchasePackSize,cartonPriceMinor,cartonContentsUnit,retailPackageSize,retailPackagePriceMinor,retailPackageContentsUnit,retailPackageLabel,packageBarcode,cartonBarcode,exportedAt,expectedStockVersion";
    const advancedCsv = `${advancedHeader}\nمياه كرتونة,اختبار,PIECE,1000,0000000001998,0,27000,500,500,27000,KILOGRAM,وصف كرتونة,12,18000,BAG,,,,PACKAGE,,0000000001999,2026-10-22T00:00:00.000Z,0`;
    const advancedImported = await app.inject({ method: "POST", url: "/v1/products/import", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a2" }, payload: { csv: advancedCsv, preview: false } });
    expect(advancedImported.statusCode, advancedImported.body).toBe(201);
    const advancedCatalog = await app.inject({ method: "GET", url: "/v1/catalog?query=0000000001998", headers });
    expect(advancedCatalog.statusCode, advancedCatalog.body).toBe(200);
    expect(advancedCatalog.json()).toMatchObject({ products: [expect.objectContaining({ nameAr: "مياه كرتونة", description: "وصف كرتونة", purchasePackSize: 12, cartonPriceMinor: 18000, cartonContentsUnit: "BAG", availableQtyMilli: 27000, barcodeMappings: expect.arrayContaining([{ barcode: "0000000001999", saleUnit: "CARTON" }]) })] });
    const advancedUpdatedCsv = `${advancedHeader}\nمياه كرتونة محدّث,اختبار,PIECE,1100,0000000001998,0,15000,550,550,15000,KILOGRAM,وصف كرتونة محدّث,10,19000,BAG,,,,PACKAGE,,0000000001999,2026-10-22T00:00:00.000Z,1`;
    const advancedUpdated = await app.inject({ method: "POST", url: "/v1/products/import", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a3" }, payload: { csv: advancedUpdatedCsv, preview: false } });
    expect(advancedUpdated.statusCode, advancedUpdated.body).toBe(201);
    const advancedUpdatedCatalog = await app.inject({ method: "GET", url: "/v1/catalog?query=0000000001998", headers });
    expect(advancedUpdatedCatalog.json()).toMatchObject({ products: [expect.objectContaining({ nameAr: "مياه كرتونة محدّث", description: "وصف كرتونة محدّث", priceMinor: 1100, purchasePackSize: 10, cartonPriceMinor: 19000, availableQtyMilli: 15000, barcodeMappings: expect.arrayContaining([{ barcode: "0000000001999", saleUnit: "CARTON" }]) })] });
    const staleWorkbook = await app.inject({ method: "POST", url: "/v1/products/import", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000a4" }, payload: { csv: `${advancedHeader}\nمياه كرتونة محدّث,اختبار,PIECE,1100,0000000001998,0,12000,550,550,12000,KILOGRAM,ملف قديم,10,19000,BAG,,,,PACKAGE,,0000000001999,2026-10-22T00:00:00.000Z,1`, preview: false } });
    expect(staleWorkbook.statusCode, staleWorkbook.body).toBe(409);
    expect(staleWorkbook.json()).toMatchObject({ code: "WORKBOOK_STOCK_STALE" });
    const exported = await app.inject({ method: "GET", url: "/v1/products/export", headers });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain("nameAr,category,unitKind");
    expect(exported.body).toContain("0000000000777");
    const internal = await app.inject({ method: "GET", url: "/v1/products/export?mode=INTERNAL&query=CSV", headers });
    expect(internal.statusCode, internal.body).toBe(200);
    expect(internal.body).toContain("wholesalePriceMinor");
    expect(internal.body).toContain(",900");
    const internalExcelData = await app.inject({ method: "GET", url: "/v1/products/export-data?mode=INTERNAL&query=CSV", headers });
    expect(internalExcelData.statusCode, internalExcelData.body).toBe(200);
    expect(internalExcelData.json()).toMatchObject({
      mode: "INTERNAL",
      items: [expect.objectContaining({ nameAr: "صنف CSV محدّث", wholesalePriceMinor: 900, availableQtyMilli: 3000 })],
    });
  });

  it("tracks supplier and customer balances with idempotent collections", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const supplier = await app.inject({ method: "POST", url: "/v1/partners/suppliers", headers, payload: { name: "مورد تجريبي", openingBalanceMinor: 2_000 } });
    expect(supplier.statusCode, supplier.body).toBe(201);
    const supplierId = (supplier.json() as { id: string }).id;
    const customer = await app.inject({ method: "POST", url: "/v1/partners/customers", headers, payload: { name: "عميل تجريبي", creditLimitMinor: 10_000, openingBalanceMinor: 1_000 } });
    expect(customer.statusCode, customer.body).toBe(201);
    const customerId = (customer.json() as { id: string }).id;
    const collection = await app.inject({ method: "POST", url: "/v1/partners/customer/collect", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000006" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000006", payment: { partnerId: customerId, amountMinor: 250, note: "تحصيل اختبار" } } });
    expect(collection.statusCode, collection.body).toBe(201);
    const replay = await app.inject({ method: "POST", url: "/v1/partners/customer/collect", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000006" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000006", payment: { partnerId: customerId, amountMinor: 250, note: "تحصيل اختبار" } } });
    expect(replay.statusCode, replay.body).toBe(201);
    const balances = await app.inject({ method: "GET", url: "/v1/partners/customers", headers });
    expect(balances.statusCode).toBe(200);
    const row = (balances.json() as Array<{ id: string; balance_minor: number }>).find((item) => item.id === customerId);
    expect(row?.balance_minor).toBe(750);
    await db.query("UPDATE branches SET credit_sales_enabled = true");
    const creditProduct = await app.inject({ method: "POST", url: "/v1/products", headers, payload: { nameAr: "منتج آجل", category: "اختبار", unitKind: "PIECE", priceMinor: 1_000, reorderLevelMilli: 0, barcodes: ["0000000000888"], openingQtyMilli: 1_000, openingUnitCostMinor: 500 } });
    const creditProductId = (creditProduct.json() as { id: string }).id;
    const creditQuote = await app.inject({ method: "POST", url: "/v1/quotes", headers, payload: { terminalId, shiftId, lines: [{ productId: creditProductId, qtyMilli: 1_000 }], discountMinor: 0 } });
    const creditQuoteData = creditQuote.json() as { quoteId: string; totalMinor: number };
    const creditSale = await app.inject({ method: "POST", url: "/v1/sales", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000008" }, payload: { terminalId, shiftId, quoteId: creditQuoteData.quoteId, customerId, payments: [{ method: "CREDIT", amountMinor: creditQuoteData.totalMinor }] } });
    expect(creditSale.statusCode, creditSale.body).toBe(201);
    const payment = await app.inject({ method: "POST", url: "/v1/partners/supplier/pay", headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000007" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000007", payment: { partnerId: supplierId, amountMinor: 500, note: "سداد اختبار" } } });
    expect(payment.statusCode, payment.body).toBe(201);
  });

  it("tracks invoice-level partner debts and prevents overpayment", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const supplier = await app.inject({ method: "POST", url: "/v1/partners/suppliers", headers, payload: { name: "Ù…ÙˆØ±Ø¯ ÙÙˆØ§ØªÙŠØ±", phone: "01012345678", openingBalanceMinor: 0 } });
    expect(supplier.statusCode, supplier.body).toBe(201);
    const supplierId = (supplier.json() as { id: string }).id;
    const createKey = "00000000-0000-4000-8000-000000000009";
    const documentPayload = {
      idempotencyKey: createKey,
      document: { partnerKind: "SUPPLIER", partnerId: supplierId, referenceNo: "SUP-STMT-1", goodsSummary: "Ø²ÙŠØª ÙˆØ³ÙƒØ±", goodsMinor: 10_000, feesMinor: 250, note: "ÙØ§ØªÙˆØ±Ø© Ù…ÙˆØ±Ø¯ Ø§Ø®ØªØ¨Ø§Ø±ÙŠØ©", dueOn: "2026-11-01" },
    };
    const created = await app.inject({ method: "POST", url: "/v1/partners/documents", headers: { ...headers, "idempotency-key": createKey }, payload: documentPayload });
    expect(created.statusCode, created.body).toBe(201);
    const documentId = (created.json() as { documentId: string }).documentId;
    const createReplay = await app.inject({ method: "POST", url: "/v1/partners/documents", headers: { ...headers, "idempotency-key": createKey }, payload: documentPayload });
    expect(createReplay.statusCode, createReplay.body).toBe(201);
    expect((createReplay.json() as { documentId: string }).documentId).toBe(documentId);

    const listed = await app.inject({ method: "GET", url: `/v1/partners/documents?partnerKind=SUPPLIER&partnerId=${supplierId}`, headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json() as { documents: Array<{ id: string; total_minor: number; remaining_minor: number; paid_minor: number }> }).documents).toContainEqual(expect.objectContaining({ id: documentId, total_minor: 10_250, remaining_minor: 10_250, paid_minor: 0 }));

    const paymentKey = "00000000-0000-4000-8000-000000000010";
    const paymentPayload = { idempotencyKey: paymentKey, payment: { documentId, amountMinor: 4_000, note: "Ø³Ø¯Ø§Ø¯ Ø¬Ø²Ø¦ÙŠ" } };
    const partial = await app.inject({ method: "POST", url: `/v1/partners/documents/${documentId}/payments`, headers: { ...headers, "idempotency-key": paymentKey }, payload: paymentPayload });
    expect(partial.statusCode, partial.body).toBe(201);
    expect(partial.json()).toMatchObject({ documentId, remainingMinor: 6_250, status: "PARTIAL" });
    const paymentReplay = await app.inject({ method: "POST", url: `/v1/partners/documents/${documentId}/payments`, headers: { ...headers, "idempotency-key": paymentKey }, payload: paymentPayload });
    expect(paymentReplay.statusCode, paymentReplay.body).toBe(201);
    const overpayment = await app.inject({ method: "POST", url: `/v1/partners/documents/${documentId}/payments`, headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-000000000011" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000011", payment: { documentId, amountMinor: 6_251, note: "Ù…Ø¨Ù„Øº Ø²Ø§Ø¦Ø¯" } } });
    expect(overpayment.statusCode, overpayment.body).toBe(422);

    const after = await app.inject({ method: "GET", url: `/v1/partners/documents?partnerKind=SUPPLIER&partnerId=${supplierId}`, headers });
    expect((after.json() as { documents: Array<{ id: string; remaining_minor: number; paid_minor: number; status: string }> }).documents).toContainEqual(expect.objectContaining({ id: documentId, remaining_minor: 6_250, paid_minor: 4_000, status: "PARTIAL" }));
    const ledger = await db.query<{ amount_minor: number; reference_id: string }>("SELECT amount_minor, reference_id FROM supplier_ledger WHERE supplier_id = $1 AND reference_id = $2 ORDER BY created_at", [supplierId, documentId]);
    expect(ledger.rows).toEqual([{ amount_minor: 10_250, reference_id: documentId }, { amount_minor: -4_000, reference_id: documentId }]);
  });

  it("exports only the current nonzero inventory with price and creation date", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const available = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف Excel متاح", category: "اختبار", unitKind: "PIECE", priceMinor: 1_275,
      reorderLevelMilli: 0, barcodes: ["0000000000444"], openingQtyMilli: 2_000, openingUnitCostMinor: 600,
    } });
    expect(available.statusCode, available.body).toBe(201);
    const empty = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "صنف Excel غير متاح", category: "اختبار", unitKind: "PIECE", priceMinor: 900,
      reorderLevelMilli: 0, barcodes: ["0000000000333"], openingQtyMilli: 0, openingUnitCostMinor: 0,
    } });
    expect(empty.statusCode, empty.body).toBe(201);
    const exported = await app.inject({ method: "GET", url: "/v1/inventory/export", headers });
    expect(exported.statusCode, exported.body).toBe(200);
    const body = exported.json() as { storeName: string; generatedAt: string; items: Array<{ nameAr: string; availableQtyMilli: number; priceMinor: number; createdAt: string }> };
    expect(body.storeName).toBeTruthy();
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toContainEqual(expect.objectContaining({ nameAr: "صنف Excel متاح", availableQtyMilli: 2_000, priceMinor: 1_275, createdAt: expect.any(String) }));
    expect(body.items).not.toContainEqual(expect.objectContaining({ nameAr: "صنف Excel غير متاح" }));
  });

  it("lists invoices across sales and purchases and returns detail with original dates and lines", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const listAll = await app.inject({ method: "GET", url: "/v1/invoices?kind=ALL&limit=300", headers });
    expect(listAll.statusCode, listAll.body).toBe(200);
    const bodyAll = listAll.json() as { items: Array<{ id: string; kind: string; invoiceNo: string; partyName: string; totalMinor: number; postedAt: string }> };
    expect(bodyAll.items.length).toBeGreaterThanOrEqual(2);
    expect(bodyAll.items.some((i) => i.kind === "SALE")).toBe(true);
    expect(bodyAll.items.some((i) => i.kind === "PURCHASE")).toBe(true);

    const listPurchases = await app.inject({ method: "GET", url: "/v1/invoices?kind=PURCHASE", headers });
    expect(listPurchases.statusCode, listPurchases.body).toBe(200);
    const bodyPurchases = listPurchases.json() as { items: Array<{ id: string; kind: string; partyName: string }> };
    expect(bodyPurchases.items.every((i) => i.kind === "PURCHASE")).toBe(true);
    expect(bodyPurchases.items.some((i) => i.partyName === "مورد الاختبار")).toBe(true);

    const purchaseItem = bodyPurchases.items.find((i) => i.partyName === "مورد الاختبار")!;
    const searchRes = await app.inject({ method: "GET", url: `/v1/invoices?query=${encodeURIComponent("مورد الاختبار")}`, headers });
    expect(searchRes.statusCode, searchRes.body).toBe(200);
    const searchBody = searchRes.json() as { items: Array<{ id: string }> };
    expect(searchBody.items.some((i) => i.id === purchaseItem.id)).toBe(true);

    const detailRes = await app.inject({ method: "GET", url: `/v1/invoices/PURCHASE/${purchaseItem.id}`, headers });
    expect(detailRes.statusCode, detailRes.body).toBe(200);
    const detail = detailRes.json() as { id: string; kind: string; partyName: string; postedAt: string; lines: Array<{ nameAr: string; qtyMilli: number }> };
    expect(detail.kind).toBe("PURCHASE");
    expect(detail.partyName).toBe("مورد الاختبار");
    expect(detail.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(detail.lines.length).toBeGreaterThan(0);
    expect(detail.lines[0]!.nameAr).toBe("منتج مضمّن");
  });

  it("creates a verified backup without pg_dump", async () => {
    config.BACKUP_DIR = await mkdtemp(resolve(tmpdir(), "nabta-backup-"));
    const backup = await runBackup(db, config, null);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    const row = await db.query<{ status: string; size_bytes: number }>("SELECT status, size_bytes FROM backup_runs WHERE id = $1", [backup.id]);
    expect(row.rows[0]).toEqual({ status: "COMPLETED", size_bytes: backup.sizeBytes });
    const verification = await app.inject({ method: "POST", url: `/v1/backups/${backup.id}/verify`, headers: { authorization: `Bearer ${token}` } });
    expect(verification.statusCode, verification.body).toBe(200);
    expect(verification.json()).toMatchObject({ verified: true, schemaVersion: "039_mobile_weighted_label_print_jobs" });
  }, 30_000);

  it("rejects a backup whose archived bytes no longer match its recorded checksum", async () => {
    config.BACKUP_DIR = await mkdtemp(resolve(tmpdir(), "nabta-backup-integrity-"));
    const backup = await runBackup(db, config, null);
    await writeFile(backup.path, "tampered backup", "utf8");

    const verification = await app.inject({
      method: "POST",
      url: `/v1/backups/${backup.id}/verify`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(verification.statusCode, verification.body).toBe(422);
    expect(verification.json()).toMatchObject({ code: "RESTORE_VERIFY_FAILED" });

    const row = await db.query<{ status: string; error_message: string | null }>(
      "SELECT status, error_message FROM backup_runs WHERE id = $1",
      [backup.id],
    );
    expect(row.rows[0]).toMatchObject({ status: "FAILED", error_message: expect.stringContaining("backup checksum mismatch") });
  }, 30_000);

  it("saves a backup to an owner-selected path and imports a selected archive safely", async () => {
    config.BACKUP_DIR = await mkdtemp(resolve(tmpdir(), "nabta-managed-backups-"));
    const selectedDirectory = await mkdtemp(resolve(tmpdir(), "nabta-selected-backup-"));
    const selectedPath = resolve(selectedDirectory, "store-copy.dump");
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/v1/backups",
      remoteAddress: "127.0.0.1",
      headers,
      payload: { destinationPath: selectedPath },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ path: selectedPath });
    expect((await stat(selectedPath)).size).toBeGreaterThan(0);

    const imported = await app.inject({
      method: "POST",
      url: "/v1/backups/import",
      remoteAddress: "127.0.0.1",
      headers,
      payload: { sourcePath: selectedPath },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedBody = imported.json() as { path: string; schemaVersion: string };
    expect(importedBody.path).toContain("nabta-imported-");
    expect(importedBody.schemaVersion).toBeTruthy();
    expect((await stat(importedBody.path)).size).toBeGreaterThan(0);

    const remoteAttempt = await app.inject({
      method: "POST",
      url: "/v1/backups",
      remoteAddress: "192.0.2.10",
      headers,
      payload: { destinationPath: resolve(selectedDirectory, "must-not-write.dump") },
    });
    expect(remoteAttempt.statusCode).toBe(403);
  }, 30_000);

  it("stores a verified automatic full backup every three days and removes expired automatic archives", async () => {
    config.BACKUP_DIR = await mkdtemp(resolve(tmpdir(), "nabta-managed-backups-"));
    const automaticDirectory = await mkdtemp(resolve(tmpdir(), "nabta-automatic-backups-"));
    const expired = resolve(automaticDirectory, "nabta-auto-2020-01-01T00-00-00-000Z.dump");
    await writeFile(expired, "expired automatic backup");
    await utimes(expired, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const headers = { authorization: `Bearer ${token}` };

    const saved = await app.inject({
      method: "PUT",
      url: "/v1/backups/policy",
      remoteAddress: "127.0.0.1",
      headers,
      payload: { destinationPath: automaticDirectory, automaticEnabled: true },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const body = saved.json() as { backup: { id: string; path: string } | null; policy: { destinationPath: string; intervalDays: number; retentionDays: number; lastAutomaticBackupAt: string | null } };
    expect(body.policy).toMatchObject({ destinationPath: automaticDirectory, intervalDays: 3, retentionDays: 30 });
    expect(body.backup?.path).toContain("nabta-auto-");
    expect(body.policy.lastAutomaticBackupAt).toBeTruthy();
    expect(await stat(body.backup!.path)).toMatchObject({ size: expect.any(Number) });
    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    const backupRow = await db.query<{ status: string; run_kind: string }>("SELECT status, run_kind FROM backup_runs WHERE id = $1", [body.backup!.id]);
    expect(backupRow.rows[0]).toEqual({ status: "RESTORE_VERIFIED", run_kind: "AUTOMATIC" });

    const policy = await app.inject({ method: "GET", url: "/v1/backups/policy", headers });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json()).toMatchObject({ destinationPath: automaticDirectory, intervalDays: 3, retentionDays: 30 });
  }, 30_000);

  it("builds a comprehensive report from posted operational data", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reports/comprehensive?from=2000-01-01&to=2100-01-01", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json() as { summary: { invoiceCount: number; netSalesMinor: number }; dailySales: unknown[]; paymentMethods: unknown[]; inventory: { activeProductCount: number }; insights: string[] };
    expect(report.summary.invoiceCount).toBeGreaterThan(0);
    expect(report.summary.netSalesMinor).toBeGreaterThan(0);
    expect(report.dailySales.length).toBeGreaterThan(0);
    expect(report.paymentMethods.length).toBeGreaterThan(0);
    expect(report.inventory.activeProductCount).toBeGreaterThan(0);
    expect(report.insights.length).toBeGreaterThan(0);
  });

  it("starts a fresh operating cycle without removing products or their stock", async () => {
    config.BACKUP_DIR = await mkdtemp(resolve(tmpdir(), "nabta-cycle-reset-"));
    const headers = { authorization: `Bearer ${token}` };
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/settings/data-reset",
      headers,
      payload: { confirmationCode: "000000" },
    });
    expect(blocked.statusCode).toBe(403);

    const productState = await db.query<{ products: number; qty: number }>(`
      SELECT (SELECT count(*)::int FROM products WHERE active) AS products,
             (SELECT coalesce(sum(qty_milli), 0)::bigint FROM stock_balances) AS qty
    `);
    const currentShift = await app.inject({ method: "GET", url: "/v1/shifts/current", headers });
    const shift = currentShift.json() as { shift: { id: string; expectedCashMinor: number } | null };
    expect(shift.shift).not.toBeNull();
    const closed = await app.inject({
      method: "POST",
      url: `/v1/shifts/${shift.shift!.id}/close`,
      headers,
      payload: { actualCashMinor: Number(shift.shift!.expectedCashMinor) },
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const reset = await app.inject({
      method: "POST",
      url: "/v1/settings/data-reset",
      headers,
      payload: { confirmationCode: "281020" },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ reset: true, removed: expect.objectContaining({ sales: expect.any(Number), purchases: expect.any(Number), customers: expect.any(Number), shifts: expect.any(Number) }) });

    const remaining = await db.query<{ sales: number; purchases: number; customers: number; customerOrders: number; shifts: number; products: number; qty: number; resetOpenings: number }>(`
      SELECT
        (SELECT count(*)::int FROM sales) AS sales,
        (SELECT count(*)::int FROM purchase_receipts) AS purchases,
        (SELECT count(*)::int FROM customers) AS customers,
        (SELECT count(*)::int FROM customer_orders) AS "customerOrders",
        (SELECT count(*)::int FROM shifts) AS shifts,
        (SELECT count(*)::int FROM products WHERE active) AS products,
        (SELECT coalesce(sum(qty_milli), 0)::bigint FROM stock_balances) AS qty,
        (SELECT count(*)::int FROM stock_movements WHERE reference_type = 'data_reset' AND movement_type = 'OPENING') AS "resetOpenings"
    `);
    expect(remaining.rows[0]).toMatchObject({ sales: 0, purchases: 0, customers: 0, customerOrders: 0, shifts: 0, products: productState.rows[0]!.products, qty: productState.rows[0]!.qty });
    expect(remaining.rows[0]!.resetOpenings).toBeGreaterThan(0);
    const audit = await db.query<{ action: string }>("SELECT action FROM audit_logs WHERE action = 'OPERATIONAL_DATA_RESET' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]).toEqual({ action: "OPERATIONAL_DATA_RESET" });
  }, 30_000);
});
