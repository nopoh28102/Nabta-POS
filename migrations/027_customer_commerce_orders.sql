-- Customer web orders are requests only.  They never create a sale or deduct
-- stock until a member of staff reviews and fulfils them through Nabta.
CREATE TABLE customer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id uuid NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  customer_name text NOT NULL CHECK (length(trim(customer_name)) >= 2),
  customer_phone text NOT NULL CHECK (length(trim(customer_phone)) >= 6),
  delivery_address text NOT NULL CHECK (length(trim(delivery_address)) >= 5),
  notes text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'FULFILLED')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  status_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subtotal_minor = total_minor)
);
CREATE INDEX customer_orders_status_created_idx ON customer_orders(status, created_at DESC);

CREATE TABLE customer_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_id uuid NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  name_snapshot text NOT NULL,
  unit_kind_snapshot unit_kind NOT NULL,
  sale_unit_snapshot text NOT NULL CHECK (sale_unit_snapshot IN ('UNIT', 'PACKAGE', 'CARTON')),
  sale_package_size_snapshot integer,
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor > 0),
  CHECK (
    (sale_unit_snapshot = 'UNIT' AND sale_package_size_snapshot IS NULL)
    OR (sale_unit_snapshot IN ('PACKAGE', 'CARTON') AND sale_package_size_snapshot >= 2)
  )
);
CREATE INDEX customer_order_lines_order_idx ON customer_order_lines(customer_order_id);
