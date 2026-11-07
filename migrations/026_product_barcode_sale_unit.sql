ALTER TABLE product_barcodes
  ADD COLUMN IF NOT EXISTS sale_unit text NOT NULL DEFAULT 'UNIT'
  CHECK (sale_unit IN ('UNIT', 'PACKAGE', 'CARTON'));

UPDATE product_barcodes SET sale_unit = 'UNIT' WHERE sale_unit IS NULL;
