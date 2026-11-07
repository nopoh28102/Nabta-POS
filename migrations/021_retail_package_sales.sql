-- Retail packages are sold from the same base-unit stock as loose pieces.
-- The package price is stored independently so a package can have a promotion
-- price that is not necessarily units_per_package × loose-piece price.
ALTER TABLE products
  ADD COLUMN retail_package_size integer,
  ADD COLUMN retail_package_price_minor bigint,
  ADD COLUMN retail_package_unit text;

ALTER TABLE products
  ADD CONSTRAINT products_retail_package_check CHECK (
    (retail_package_size IS NULL AND retail_package_price_minor IS NULL AND retail_package_unit IS NULL)
    OR (
      retail_package_size >= 2
      AND retail_package_size <= 100000
      AND retail_package_price_minor > 0
      AND retail_package_unit IN ('PIECE', 'BAG')
    )
  );

-- A sale may contain the same SKU both as a loose unit and as a full package.
ALTER TABLE sale_lines
  ADD COLUMN sale_unit_snapshot text NOT NULL DEFAULT 'UNIT'
  CHECK (sale_unit_snapshot IN ('UNIT', 'PACKAGE'));

ALTER TABLE sale_lines
  ADD COLUMN sale_package_size_snapshot integer,
  ADD CONSTRAINT sale_lines_package_snapshot_check CHECK (
    (sale_unit_snapshot = 'UNIT' AND sale_package_size_snapshot IS NULL)
    OR (sale_unit_snapshot = 'PACKAGE' AND sale_package_size_snapshot >= 2)
  );

ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_sale_id_product_id_key;
ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_sale_product_unit_unique UNIQUE (sale_id, product_id, sale_unit_snapshot);
