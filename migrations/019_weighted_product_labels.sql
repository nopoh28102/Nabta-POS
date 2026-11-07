CREATE TABLE weighted_product_labels (
  barcode text PRIMARY KEY CHECK (barcode ~ '^[0-9]{13}$'),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  print_count integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  last_printed_at timestamptz,
  used_sale_id uuid REFERENCES sales(id),
  used_at timestamptz,
  CHECK ((used_sale_id IS NULL) = (used_at IS NULL))
);
CREATE INDEX weighted_product_labels_product_created_idx ON weighted_product_labels(product_id, created_at DESC);
CREATE INDEX weighted_product_labels_open_idx ON weighted_product_labels(product_id) WHERE used_sale_id IS NULL;

-- Several weighed labels of the same product may legitimately appear on one sale.
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_sale_id_product_id_key;
