ALTER TABLE products
  ADD COLUMN carton_contents_unit text;

ALTER TABLE products
  ADD CONSTRAINT products_carton_contents_unit_check
  CHECK (carton_contents_unit IS NULL OR carton_contents_unit IN ('PIECE', 'BAG'));
