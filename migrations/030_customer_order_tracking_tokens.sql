-- A customer receives this opaque token only after creating an order.  It lets
-- the public storefront display that order's state without exposing customer
-- names, addresses, phone numbers, or the store's administrative endpoints.
ALTER TABLE customer_orders
  ADD COLUMN tracking_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX customer_orders_tracking_token_idx
  ON customer_orders(tracking_token);
