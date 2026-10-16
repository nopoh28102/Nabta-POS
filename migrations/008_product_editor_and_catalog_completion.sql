-- Full product-card editing needs a first-class description field.  Keeping
-- it on products (rather than only in the import reference table) means an
-- owner can maintain a product that was not imported from a catalog as well.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- Complete older installations where the catalog references were imported
-- before the "make every reference sellable" requirement was introduced.
-- Barcode uniqueness is the source of truth: names may legitimately repeat
-- across flavours or package sizes.
WITH inserted_products AS (
  INSERT INTO products (
    name_ar,
    description,
    search_name,
    sku,
    category,
    unit_kind,
    price_minor,
    wholesale_price_minor,
    reorder_level_milli
  )
  SELECT
    reference.name_ar,
    reference.description,
    lower(regexp_replace(trim(reference.name_ar), '[[:space:]]+', ' ', 'g')),
    'CATALOG:' || reference.barcode,
    reference.category,
    'PIECE',
    0,
    0,
    0
  FROM product_reference_catalog AS reference
  LEFT JOIN product_barcodes AS barcode ON barcode.barcode = reference.barcode
  WHERE barcode.barcode IS NULL
  RETURNING id, sku
), inserted_barcodes AS (
  INSERT INTO product_barcodes(product_id, barcode)
  SELECT id, substring(sku FROM 9)
  FROM inserted_products
  RETURNING product_id
), catalog_products AS (
  SELECT barcode.product_id
  FROM product_reference_catalog AS reference
  JOIN product_barcodes AS barcode ON barcode.barcode = reference.barcode
  UNION
  SELECT product_id FROM inserted_barcodes
)
INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version)
SELECT warehouse.id, catalog_products.product_id, 0, 0, 0
FROM catalog_products
CROSS JOIN LATERAL (
  SELECT id FROM warehouses WHERE is_default ORDER BY created_at LIMIT 1
) AS warehouse
ON CONFLICT (warehouse_id, product_id) DO NOTHING;
