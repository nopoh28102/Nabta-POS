-- Make every imported reference-catalog row available as a real sellable product.
-- Rows without a declared price remain at zero until the owner supplies one.
-- The sale routes explicitly reject an unset (zero) selling price.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_minor_check;
ALTER TABLE products
  ADD CONSTRAINT products_price_minor_nonnegative CHECK (price_minor >= 0);

WITH inserted_products AS (
  INSERT INTO products (
    name_ar,
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
