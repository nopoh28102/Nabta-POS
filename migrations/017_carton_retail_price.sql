-- A carton can have its own advertised retail price while stock and ordinary
-- POS sales continue to use the base-piece price.
ALTER TABLE products
  ADD COLUMN carton_price_minor bigint;

ALTER TABLE products
  ADD CONSTRAINT products_carton_price_minor_check
  CHECK (carton_price_minor IS NULL OR carton_price_minor > 0);
