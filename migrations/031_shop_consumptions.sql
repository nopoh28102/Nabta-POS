-- Detailed operating purchases paid from the cash drawer.  The linked cash movement
-- remains the source of truth for the drawer; this table adds reportable item detail.
CREATE TABLE shop_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_movement_id uuid NOT NULL UNIQUE REFERENCES cash_movements(id),
  item_name text NOT NULL CHECK (length(trim(item_name)) >= 2),
  category text NOT NULL CHECK (length(trim(category)) >= 2),
  quantity_note text,
  supplier_name text,
  consumed_on date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shop_consumptions_date_idx ON shop_consumptions(consumed_on DESC, created_at DESC);
