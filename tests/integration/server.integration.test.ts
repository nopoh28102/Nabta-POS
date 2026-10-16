import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../apps/server/src/app.js";
import { createDatabase, type Database } from "../../apps/server/src/db.js";
import type { FastifyInstance } from "fastify";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

interface Session { token: string; terminalId: string; shiftId: string; }
let db: Database;
let app: FastifyInstance;
let owner1: Session;
let owner2: Session;

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> { return { authorization: `Bearer ${token}`, ...extra }; }

async function login(username: string, password: string, terminalId: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username, password, terminalId } });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { token: string }).token;
}

async function createProduct(token: string, name: string, barcode: string, qtyMilli: number, valueMinor: number, priceMinor = 1_000, unitKind: "PIECE" | "WEIGHT" = "PIECE"): Promise<string> {
  const openingUnitCostMinor = qtyMilli === 0 ? 0 : Number((BigInt(valueMinor) * 1_000n) / BigInt(qtyMilli));
  const response = await app.inject({ method: "POST", url: "/v1/products", headers: headers(token), payload: {
    nameAr: name, category: "اختبار", unitKind, priceMinor, reorderLevelMilli: 0, barcodes: [barcode], openingQtyMilli: qtyMilli, openingUnitCostMinor,
  } });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function quote(session: Session, productId: string, qtyMilli: number, discountMinor = 0): Promise<{ quoteId: string; totalMinor: number; lines: Array<{ lineId: string }> }> {
  const response = await app.inject({ method: "POST", url: "/v1/quotes", headers: headers(session.token), payload: { terminalId: session.terminalId, shiftId: session.shiftId, lines: [{ productId, qtyMilli }], discountMinor } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

async function postSale(session: Session, quoteId: string, totalMinor: number, key = randomUUID(), extraHeaders: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/v1/sales", headers: headers(session.token, { "idempotency-key": key, ...extraHeaders }), payload: { terminalId: session.terminalId, shiftId: session.shiftId, quoteId, payments: [{ method: "CASH", amountMinor: totalMinor, tenderedMinor: totalMinor }] } });
}

run("trusted PostgreSQL sale invariants", () => {
  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    app = buildApp({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: 7443, DATABASE_URL: databaseUrl!, SETUP_TOKEN: "integration-setup-token-2026-secure", SESSION_TTL_MINUTES: 480, BACKUP_RETENTION_DAYS: 30, DATA_RESET_PIN: "281020", LOG_LEVEL: "silent" }, db, { logger: false });
    await app.ready();
  });

  afterAll(async () => { await app.close(); await db.end(); });

  it("creates the owner exactly once without default credentials", async () => {
    const setup = await app.inject({ method: "POST", url: "/v1/setup", payload: { setupToken: "integration-setup-token-2026-secure", storeName: "متجر اختبار نبتة", branchName: "الفرع الرئيسي", ownerName: "مالك الاختبار", username: "owner_it", password: "Strong-Integration-Password-2026!", terminalName: "كاشير 1" } });
    expect(setup.statusCode, setup.body).toBe(201);
    const terminalId = (setup.json() as { terminalId: string }).terminalId;
    const token = await login("owner_it", "Strong-Integration-Password-2026!", terminalId);
    const secondSetup = await app.inject({ method: "POST", url: "/v1/setup", payload: { setupToken: "integration-setup-token-2026-secure", storeName: "آخر", branchName: "فرع", ownerName: "مالك", username: "other", password: "Another-Password-2026!", terminalName: "كاشير" } });
    expect(secondSetup.statusCode).toBe(409);
    const terminal2 = await app.inject({ method: "POST", url: "/v1/terminals", headers: headers(token), payload: { name: "كاشير 2" } });
    expect(terminal2.statusCode, terminal2.body).toBe(201);
    const terminal2Id = (terminal2.json() as { id: string }).id;
    const token2 = await login("owner_it", "Strong-Integration-Password-2026!", terminal2Id);
    const shift1 = await app.inject({ method: "POST", url: "/v1/shifts", headers: headers(token), payload: { terminalId, openingMinor: 5_000 } });
    const shift2 = await app.inject({ method: "POST", url: "/v1/shifts", headers: headers(token2), payload: { terminalId: terminal2Id, openingMinor: 7_000 } });
    expect(shift1.statusCode, shift1.body).toBe(201); expect(shift2.statusCode, shift2.body).toBe(201);
    owner1 = { token, terminalId, shiftId: (shift1.json() as { id: string }).id };
    owner2 = { token: token2, terminalId: terminal2Id, shiftId: (shift2.json() as { id: string }).id };
  }, 20_000);

  it("allows only one of two tills to sell the final unit", async () => {
    const productId = await createProduct(owner1.token, "آخر قطعة", "0000000000001", 1_000, 500);
    const [quote1, quote2] = await Promise.all([quote(owner1, productId, 1_000), quote(owner2, productId, 1_000)]);
    const responses = await Promise.all([postSale(owner1, quote1.quoteId, quote1.totalMinor), postSale(owner2, quote2.quoteId, quote2.totalMinor)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const balance = await db.query<{ qty_milli: number }>("SELECT qty_milli FROM stock_balances WHERE product_id = $1", [productId]);
    expect(balance.rows[0]!.qty_milli).toBe(0);
    const sales = await db.query<{ count: number }>("SELECT count(*)::bigint AS count FROM sale_lines WHERE product_id = $1", [productId]);
    expect(sales.rows[0]!.count).toBe(1);
  });

  it("returns one invoice for concurrent retries with the same idempotency key", async () => {
    const productId = await createProduct(owner1.token, "تكرار آمن", "0000000000002", 2_000, 1_000);
    const priced = await quote(owner1, productId, 1_000);
    const key = randomUUID();
    const [first, retry] = await Promise.all([postSale(owner1, priced.quoteId, priced.totalMinor, key), postSale(owner1, priced.quoteId, priced.totalMinor, key)]);
    expect(first.statusCode, first.body).toBe(201); expect(retry.statusCode, retry.body).toBe(201);
    expect((first.json() as { saleId: string }).saleId).toBe((retry.json() as { saleId: string }).saleId);
    expect([first.headers["idempotent-replay"], retry.headers["idempotent-replay"]].sort()).toEqual(["false", "true"]);
    const conflictingQuote = await quote(owner1, productId, 1_000);
    const conflict = await postSale(owner1, conflictingQuote.quoteId, conflictingQuote.totalMinor, key);
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rolls back invoice, idempotency and stock after an injected failure", async () => {
    const productId = await createProduct(owner1.token, "اختبار التراجع", "0000000000003", 1_000, 400);
    const priced = await quote(owner1, productId, 1_000);
    const key = randomUUID();
    const failed = await postSale(owner1, priced.quoteId, priced.totalMinor, key, { "x-nabta-test-fail": "after-sale-header" });
    expect(failed.statusCode).toBe(500);
    const state = await db.query<{ sales: number; qty: number; requests: number }>(`
      SELECT (SELECT count(*) FROM sales WHERE quote_id = $1)::bigint AS sales,
             (SELECT qty_milli FROM stock_balances WHERE product_id = $2)::bigint AS qty,
             (SELECT count(*) FROM idempotency_requests WHERE key = $3)::bigint AS requests
    `, [priced.quoteId, productId, key]);
    expect(state.rows[0]).toEqual({ sales: 0, qty: 1_000, requests: 0 });
  });

  it("handles discounted repeated partial returns without exceeding the original", async () => {
    const productId = await createProduct(owner1.token, "مرتجع جزئي", "0000000000004", 3_000, 180, 100);
    const priced = await quote(owner1, productId, 3_000, 1);
    expect(priced.totalMinor).toBe(299);
    const posted = await postSale(owner1, priced.quoteId, priced.totalMinor);
    expect(posted.statusCode, posted.body).toBe(201);
    const sale = posted.json() as { saleId: string; lines: Array<{ lineId: string }> };
    let refunded = 0;
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({ method: "POST", url: `/v1/sales/${sale.saleId}/returns`, headers: headers(owner1.token, { "idempotency-key": randomUUID() }), payload: { shiftId: owner1.shiftId, lines: [{ saleLineId: sale.lines[0]!.lineId, qtyMilli: 1_000, condition: "RESTOCK" }], reason: `مرتجع اختبار رقم ${index + 1}` } });
      expect(response.statusCode, response.body).toBe(201);
      refunded += (response.json() as { totalRefundMinor: number }).totalRefundMinor;
    }
    expect(refunded).toBe(299);
    const extra = await app.inject({ method: "POST", url: `/v1/sales/${sale.saleId}/returns`, headers: headers(owner1.token, { "idempotency-key": randomUUID() }), payload: { shiftId: owner1.shiftId, lines: [{ saleLineId: sale.lines[0]!.lineId, qtyMilli: 1_000, condition: "RESTOCK" }], reason: "تجاوز مرفوض" } });
    expect(extra.statusCode).toBe(409);
    expect((extra.json() as { code: string }).code).toBe("RETURN_LIMIT");
    const line = await db.query<{ returned_qty_milli: number; refunded_minor: number }>("SELECT returned_qty_milli, refunded_minor FROM sale_lines WHERE id = $1", [sale.lines[0]!.lineId]);
    expect(line.rows[0]).toEqual({ returned_qty_milli: 3_000, refunded_minor: 299 });
  });

  it("prices a 0.375 kg weighted sale and snapshots cost from the server", async () => {
    const productId = await createProduct(owner1.token, "جبنة موزونة", "0000000000005", 3_750, 46_875, 16_000, "WEIGHT");
    const priced = await quote(owner1, productId, 375);
    expect(priced.totalMinor).toBe(6_000);
    const posted = await postSale(owner1, priced.quoteId, priced.totalMinor);
    expect(posted.statusCode, posted.body).toBe(201);
    const saleId = (posted.json() as { saleId: string }).saleId;
    const line = await db.query<{ cost_minor: number; qty_milli: number }>("SELECT cost_minor, qty_milli FROM sale_lines WHERE sale_id = $1", [saleId]);
    expect(line.rows[0]).toEqual({ cost_minor: 4_688, qty_milli: 375 });
  });

  it("enforces backend permissions even when called directly", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/users", headers: headers(owner1.token), payload: { displayName: "كاشير اختبار", username: "cashier_it", password: "Cashier-Integration-2026!", role: "CASHIER", discountLimitBps: 0 } });
    expect(created.statusCode, created.body).toBe(201);
    const cashierToken = await login("cashier_it", "Cashier-Integration-2026!", owner1.terminalId);
    const forbidden = await app.inject({ method: "POST", url: "/v1/products", headers: headers(cashierToken), payload: { nameAr: "ممنوع", category: "اختبار", unitKind: "PIECE", priceMinor: 100, reorderLevelMilli: 0, barcodes: ["forbidden"], openingQtyMilli: 0, openingValueMinor: 0 } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("reconciles invoices and stock ledger with no mismatches", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reports/reconciliation?from=2026-01-01&to=2027-12-31", headers: headers(owner1.token) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true, invoiceMismatches: [], stockMismatches: [] });
  });
});
