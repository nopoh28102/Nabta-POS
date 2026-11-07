-- A cashier may add an unregistered one-off item to a single invoice.
-- It has no catalogue or stock identity, so product_id is intentionally NULL.
ALTER TABLE sale_lines
  ALTER COLUMN product_id DROP NOT NULL;
