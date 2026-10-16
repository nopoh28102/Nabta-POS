# Local Codex implementation milestones — delivery status

The production workspace is implemented through the trusted sale, returns, purchases, reports, recovery and Windows-shell core. Evidence and remaining pilot work are tracked in [CHECKLIST.md](CHECKLIST.md). The original `frontend/` remains an inspectable reference and is not used as a trust boundary.

The prototype is complete only as a handoff; production milestones below are pending. Finish one vertical slice at a time. Maintain CHECKLIST.md with evidence, commands and known gaps.

## M0 — Inspect and decide — **done**
Read the handoff, check Windows tooling, review current official dependency docs and licenses, inspect the UI, confirm LAN/server assumptions. Record ADRs for centralized PostgreSQL-compatible storage (PGlite embedded by default, external PostgreSQL optional), renderer isolation, costing, rounding and outage behavior. Create a production workspace without deleting frontend reference. Set up typecheck, lint, domain tests and migration tooling.

## M1 — Trusted foundations — **done for core**
Implement schemas/migrations, users/roles, owner setup, sessions, products, units, warehouses, stock balances and immutable movements. Central validation and safe errors. Seed is separate and explicit. Connect readonly catalog to the renderer via typed API adapters. Test migrations, permission enforcement and secrets isolation.

## M2 — Vertical sale slice — **done**
Implement active shifts, quotation/repricing, line snapshots, receipt numbers, stock locks, FEFO allocation and cost snapshot, cash/card bookkeeping and idempotency. Persist sale/lines/payments/movements/audit as one transaction. Adapt existing POS view. Test two clients racing for last unit, rollback injection, duplicate request, stale quote, fractional quantity and rounding boundaries. Save incomplete draft safely; final sales require server availability.

## M3 — Returns, cash and purchases — **done for first release core**
Implement partial/full returns with original discount allocation, mixed payment refund rules, current-shift cash impact, expenses, withdrawals/deposits, closure variance, multi-line goods receipt, supplier returns and weighted costing. Ledger correction rather than deletion. Test historical return, repeat partial returns, refunds rounding to original total, costing with receipts and valid/tampered approval.

## M4 — Stock and reporting — **done for first release core**
Counts/adjustments with approvals, lot expiry policy, write-offs, valuation, low stock/expiry views, accounting period reports with reconciled sales/COGS/expenses/losses, customer/supplier debt if enabled. CSV preview/import validation and safe exports. Test ledger/balance reconciliation, purchase versus expense separation, permissions on costs, Cairo date boundaries and filters.

## M5 — Windows and two tills — **shell and service scripts done; physical hardware/service deployment pending**
Wrap renderer in hardened Electron shell, signed/trusted local API connection, autostart server service, health/status, configuration wizard, safe database credentials, printer adapters and thermal Arabic rendering. Package installer. Test reinstall/upgrade, Arabic receipt, network second terminal, response loss retry and disconnected draft. Record hardware-specific gaps; don't claim tested hardware without running it.

## M6 — Recovery and pilot acceptance — **backup drill done; pilot hardware and LAN acceptance pending**
Scheduled backup retention, encryption where suitable, atomic archive and integrity check, restore into isolated database. Exercise recovery on clean environment. Run end-to-end role and cash reconciliation suites. Provide user/admin manuals, migration/upgrade rollback policy and pilot checklist. Any failed commercial invariant blocks pilot use.

## M7 — Optional extensions
Only after M1–M6: multi-branch transfer, promotions/loyalty, scales and weighted barcodes, delivery, tax connectors. Credit sales, customer collections and supplier payments are included in the first release with explicit ledgers and limits. Each remaining extension needs documented capability state, UI, backend, tests and operational limitations.

## Required delivery evidence
- Run/build/test commands and exact results; screenshot reference comparisons.
- Installer or explicit build artifact explanation, version, prerequisites, SHA256 when useful.
- Restore drill evidence and database schema version.
- One-server/two-terminal run guide and documented outage behavior.
- Permission matrix, setup without default passwords and audit examples.
- Scope statement: implemented, hardware-tested, deferred, external approvals/configuration needed.
