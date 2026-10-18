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

  it("commits a sale and keeps the stock ledger atomic", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const product = await app.inject({ method: "POST", url: "/v1/products", headers, payload: {
      nameAr: "منتج مضمّن", category: "اختبار", unitKind: "PIECE", priceMinor: 1_000, reorderLevelMilli: 0,
      barcodes: ["0000000000999"], wholesalePriceMinor: 650, openingQtyMilli: 1_000, openingUnitCostMinor: 500,
    } });
    expect(product.statusCode, product.body).toBe(201);
    const productId = (product.json() as { id: string }).id;
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
    const prices = await db.query<{ price_minor: number; wholesale_price_minor: number }>("SELECT price_minor, wholesale_price_minor FROM products WHERE id = $1", [productId]);
    expect(prices.rows[0]).toEqual({ price_minor: 1_200, wholesale_price_minor: 700 });
    const expiry = await app.inject({ method: "GET", url: "/v1/stock-expiry?days=365", headers });
    expect(expiry.statusCode, expiry.body).toBe(200);
    expect((expiry.json() as { lots: Array<{ lot_code: string }> }).lots.some((lot) => lot.lot_code === "LOT-1")).toBe(true);
    const version = await db.query<{ version: number }>("SELECT version FROM stock_balances WHERE product_id = $1", [productId]);
    const count = await app.inject({ method: "POST", url: "/v1/stock-counts/post", headers, payload: {
      warehouseId: warehouse.rows[0]!.warehouse_id, productId, actualQtyMilli: 1_000, expectedVersion: version.rows[0]!.version, reason: "فرق جرد اختباري",
    } });
    expect(count.statusCode, count.body).toBe(201);
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
    const reprint = await app.inject({ method: "POST", url: `/v1/sales/${sale.rows[0]!.id}/reprint`, headers });
    expect(reprint.statusCode, reprint.body).toBe(200);
    expect(reprint.json()).toMatchObject({ saleId: sale.rows[0]!.id, reprintCount: 1 });
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
    const exported = await app.inject({ method: "GET", url: "/v1/products/export", headers });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain("nameAr,category,unitKind");
    expect(exported.body).toContain("0000000000777");
    const internal = await app.inject({ method: "GET", url: "/v1/products/export?mode=INTERNAL&query=CSV", headers });
    expect(internal.statusCode, internal.body).toBe(200);
    expect(internal.body).toContain("wholesalePriceMinor");
    expect(internal.body).toContain(",700");
    const internalExcelData = await app.inject({ method: "GET", url: "/v1/products/export-data?mode=INTERNAL&query=CSV", headers });
    expect(internalExcelData.statusCode, internalExcelData.body).toBe(200);
    expect(internalExcelData.json()).toMatchObject({
      mode: "INTERNAL",
      items: [expect.objectContaining({ nameAr: "صنف CSV", wholesalePriceMinor: 700, availableQtyMilli: 1000 })],
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
    expect(verification.json()).toMatchObject({ verified: true, schemaVersion: "010_automatic_backup_policy" });
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

    const remaining = await db.query<{ sales: number; purchases: number; customers: number; shifts: number; products: number; qty: number; resetOpenings: number }>(`
      SELECT
        (SELECT count(*)::int FROM sales) AS sales,
        (SELECT count(*)::int FROM purchase_receipts) AS purchases,
        (SELECT count(*)::int FROM customers) AS customers,
        (SELECT count(*)::int FROM shifts) AS shifts,
        (SELECT count(*)::int FROM products WHERE active) AS products,
        (SELECT coalesce(sum(qty_milli), 0)::bigint FROM stock_balances) AS qty,
        (SELECT count(*)::int FROM stock_movements WHERE reference_type = 'data_reset' AND movement_type = 'OPENING') AS "resetOpenings"
    `);
    expect(remaining.rows[0]).toMatchObject({ sales: 0, purchases: 0, customers: 0, shifts: 0, products: productState.rows[0]!.products, qty: productState.rows[0]!.qty });
    expect(remaining.rows[0]!.resetOpenings).toBeGreaterThan(0);
    const audit = await db.query<{ action: string }>("SELECT action FROM audit_logs WHERE action = 'OPERATIONAL_DATA_RESET' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]).toEqual({ action: "OPERATIONAL_DATA_RESET" });
  }, 30_000);
});
