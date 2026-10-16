-- Reference data is intentionally separate from sellable products: a source
-- catalog can describe an item even when no verified retail price is present.
CREATE TABLE IF NOT EXISTS product_reference_catalog (
  barcode text PRIMARY KEY CHECK (length(barcode) BETWEEN 1 AND 80),
  name_ar text NOT NULL CHECK (length(trim(name_ar)) >= 2),
  category text NOT NULL,
  subcategory text NOT NULL DEFAULT '',
  brand text NOT NULL DEFAULT '',
  manufacturer text NOT NULL DEFAULT '',
  size text NOT NULL DEFAULT '',
  flavor text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  image_source_url text NOT NULL DEFAULT '',
  image_asset_path text,
  source_name text NOT NULL DEFAULT '',
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_reference_catalog_name_idx
  ON product_reference_catalog (name_ar);
