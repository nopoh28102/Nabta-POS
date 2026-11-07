-- Web orders reserve stock immediately. They are released on cancellation
-- and converted into an auditable transfer-out with reference_type
-- customer_order only when delivery is explicitly marked fulfilled by an
-- authorised staff member. Reusing the existing stock movement enum keeps
-- this forward migration compatible with the embedded PGlite runtime.

CREATE TABLE customer_order_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_id uuid NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_order_id, product_id)
);
CREATE INDEX customer_order_reservations_active_idx
  ON customer_order_reservations(warehouse_id, product_id, created_at)
  WHERE released_at IS NULL;
