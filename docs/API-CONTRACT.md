# Proposed production API contract (not implemented in this handoff)

API lives on the trusted store server. Shared TypeScript contracts + runtime validation. Integer piastres `amountMinor`; integer milli-units `qtyMilli` (1000 = one piece or one kg depending on product base unit). ISO timestamps UTC, report timezone Africa/Cairo. Products use string IDs and barcode strings. Never accept caller-supplied actor, cost snapshot or total as authoritative.

| Endpoint | Purpose | Invariant |
|---|---|---|
| POST /v1/setup | First owner and store | Allowed once, local setup trust boundary |
| POST /v1/auth/login | Session | Hashed passwords, rate limits, safe tokens |
| POST /v1/auth/logout | Revoke session | Audit, no renderer secrets |
| GET /v1/catalog?query=&category=&cursor= | Search/paginate | Exact barcode path, costs gated |
| POST /v1/products | Create product | Barcode unique, permission, units valid |
| PATCH /v1/products/:id | Change metadata/price | version conflict check, audit; no stock edit |
| POST /v1/shifts | Open shift | One active till shift per policy |
| POST /v1/quotes | Recalculate basket | Server price/cost/permissions, expiring quote/version |
| POST /v1/sales | Post sale | Idempotency, valid quote, stock locks, all-or-nothing |
| GET /v1/sales/:id | Invoice | Immutable snapshot; role filtered |
| GET /v1/operations/:requestId | Resolve uncertain reply | Auth-scoped, distinguishes pending/posted/not-found |
| POST /v1/sales/:id/returns | Partial return | Original remaining quantities/discount/cost, atomic |
| POST /v1/shifts/:id/cash-movements | Cash in/out/expense | Current shift, reason, permission/approval |
| POST /v1/shifts/:id/close | Reconcile actual cash | Server expected, variance, locked closure |
| POST /v1/purchase-receipts | Receive multi-line goods | Lots, costing, ledger and payables |
| POST /v1/supplier-returns | Return purchases | Lot/quantity/cost validation, ledger/payables |
| POST /v1/stock-counts | Record count draft | Base stock version, counted lot/unit |
| POST /v1/stock-counts/:id/post | Approve difference | Reject stale count or recalc with review; ledger |
| GET /v1/stock-movements | Inspect ledger | Filters, pagination and access |
| GET /v1/reports/* | Period reports | Authorized, reconciled, explicit timezone |
| POST /v1/imports/products/preview | Validate file | No write before confirmation |
| POST /v1/imports/:id/commit | Commit validated batch | Exact preview hash, dedup rules, audit |
| POST /v1/backups | Run backup; accepts a chosen destination only from local desktop loopback | Admin only, audited and integrity checked |
| POST /v1/backups/import | Import and isolated-verify an owner-selected PGlite archive | Local desktop loopback only; never overwrites live data |
| GET /v1/health | Connection state | No secrets; separate authenticated diagnostics |

Example `POST /v1/sales`:

```json
{
  "terminalId": "till-1",
  "shiftId": "shift-42",
  "quoteId": "quote-8",
  "lines": [{"productId": "p1", "qtyMilli": 2000}],
  "discountMinor": 1000,
  "payments": [{"method": "cash", "tenderedMinor": 10000}]
}
```

Header `Idempotency-Key` is a unique durable request ID. Server verifies terminal binding, session, shift and quote; normalizes payload for hash. Money allocated to cash sale and change are server computed (tendered is not revenue). Response contains invoice ID/number, server totals, change, snapshots, status, stock versions and timestamp. Complete response recorded in same transaction. Reused key with changed payload -> 409; replay original payload -> original invoice response, no second deduction.

Errors: `{ "code": "INSUFFICIENT_STOCK", "messageAr": "المخزون غير كافٍ", "details": [{"productId":"p1","availableQtyMilli":1000}], "requestId":"..." }`. Never expose database internals. Codes include VALIDATION, AUTH_REQUIRED, FORBIDDEN, SHIFT_CLOSED, PRICE_CHANGED, STOCK_EXPIRED, INSUFFICIENT_STOCK, RETURN_LIMIT, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, SERVER_UNAVAILABLE. Tests assert status and invariants. No retries on validation/auth errors; network retries use same key with bounded backoff and outcome lookup.

Prototype mapping: `engine.js sale/refund/expectedCash` -> backend domain; `app.js` mutations -> typed service adapters; `demo-data.js` -> optional isolated dev seed; `localStorage` -> draft cache only. Do not expose the demo receipt/stock setters as production APIs.
