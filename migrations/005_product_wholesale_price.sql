-- A private reference price used by the owner for wholesale/internal pricing.
-- It is deliberately separate from inventory valuation and historical purchase costs.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS wholesale_price_minor bigint NOT NULL DEFAULT 0
  CHECK (wholesale_price_minor >= 0);
