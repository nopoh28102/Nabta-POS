-- Product purchase packaging is separate from the stock unit.  Stock remains
-- measured in thousandths of the base unit, while a supplier invoice can state
-- cartons and the system expands them to pieces atomically when posting.
ALTER TABLE products
  ADD COLUMN purchase_pack_size integer NOT NULL DEFAULT 1
  CHECK (purchase_pack_size >= 1 AND purchase_pack_size <= 100000);

ALTER TABLE purchase_receipt_lines
  ADD COLUMN entry_unit text NOT NULL DEFAULT 'PIECE'
  CHECK (entry_unit IN ('PIECE', 'CARTON')),
  ADD COLUMN cost_basis text NOT NULL DEFAULT 'UNIT'
  CHECK (cost_basis IN ('UNIT', 'PACKAGE', 'LINE_TOTAL')),
  ADD COLUMN package_count integer,
  ADD COLUMN units_per_package integer,
  ADD COLUMN package_cost_minor bigint,
  ADD COLUMN line_total_minor bigint;

ALTER TABLE purchase_receipt_lines
  ADD CONSTRAINT purchase_receipt_lines_packaging_check CHECK (
    (entry_unit = 'PIECE' AND cost_basis = 'UNIT' AND package_count IS NULL AND units_per_package IS NULL AND package_cost_minor IS NULL AND line_total_minor IS NULL)
    OR
    (entry_unit = 'CARTON' AND package_count > 0 AND units_per_package > 0 AND (
      (cost_basis = 'PACKAGE' AND package_cost_minor >= 0 AND line_total_minor IS NULL)
      OR
      (cost_basis = 'LINE_TOTAL' AND line_total_minor >= 0 AND package_cost_minor IS NULL)
    ))
  );
