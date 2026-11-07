-- Keep the primary selling unit for weighted products.  Quantities remain
-- stored in milli-kilograms (one gram) so the stock and money calculations
-- remain exact, while the UI can consistently distinguish Gram from Kilogram.
ALTER TABLE products
  ADD COLUMN weight_unit text NOT NULL DEFAULT 'KILOGRAM'
  CHECK (weight_unit IN ('KILOGRAM', 'GRAM'));
