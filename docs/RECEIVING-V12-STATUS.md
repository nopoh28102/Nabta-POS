# Nabta Dokany 1.2.0 — supplier receiving

Date: 2026-11-02

- Rebuilt the supplier receiving flow with a Nabta RTL identity: supplier and invoice card, camera/manual search, live totals, optional expiry, and a single central print request after posting.
- Existing barcodes open the current product card rather than new-product registration. The barcode mapping selects the initial carton, bag, or loose unit; weighted products select kilogram entry.
- Carton and bag barcodes are optional for a new configured product. Missing values are generated uniquely by the trusted Android bridge during saving and do not block the clerk.
- Each existing product card can scan or replace carton/bag barcodes and opens the complete product editor for prices, carton capacity, package capacity, barcodes, and stock-safe edits.
- Mixed cartons, bags, and loose units are represented in one receipt card and posted as one exact-total product line. Carton-only entries retain carton metadata. This prevents duplicate product lines while retaining correct stock and financial totals.

Verification completed:

- `node --check apps/nabta-dokany/app/src/main/assets/receive-v12.js`
- Android `:app:assembleDebug --no-daemon --console=plain`
- `pnpm --filter @nabta/contracts build`
- `pnpm --filter @nabta/server typecheck`
- `pnpm --filter @nabta/desktop typecheck`

The full integration suite exceeded the local 124-second command limit and should be run in CI or with a longer local timeout.
