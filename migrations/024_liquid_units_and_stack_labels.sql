-- Measured stock is stored in thousandths: grams for weight and millilitres
-- for liquids.  This keeps litre pricing and inventory exact without floats.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_weight_unit_check;
ALTER TABLE products
  ADD CONSTRAINT products_weight_unit_check
  CHECK (weight_unit IN ('KILOGRAM', 'GRAM', 'LITER', 'MILLILITER'));

-- A retail package can be named a stack/column for foam and disposable plates.
-- It is still deducted from the same base-piece inventory as loose sale.
ALTER TABLE products
  ADD COLUMN retail_package_label text NOT NULL DEFAULT 'PACKAGE'
  CHECK (retail_package_label IN ('PACKAGE', 'STACK'));
