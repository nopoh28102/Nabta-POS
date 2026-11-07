-- A delivery request is not a posted sale.  Keep its channel and the
-- server-owned delivery fee so staff can review and print a preparation slip
-- before any money or stock is posted through the normal POS flow.
ALTER TABLE customer_orders
  ADD COLUMN source text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB', 'MESSENGER')),
  ADD COLUMN delivery_fee_minor bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0);

-- Migration 027 had a single unnamed cross-column check.  Existing rows have
-- a zero delivery fee and remain valid after replacing it with the explicit
-- total-components invariant.
ALTER TABLE customer_orders DROP CONSTRAINT IF EXISTS customer_orders_check;
ALTER TABLE customer_orders
  ADD CONSTRAINT customer_orders_total_components_check
  CHECK (total_minor = subtotal_minor + delivery_fee_minor);

CREATE INDEX customer_orders_source_created_idx
  ON customer_orders(source, created_at DESC);
