-- Keep migration 015 immutable because it has already shipped in a Windows
-- installer.  Weighted products are stored in kilograms (thousandths) and
-- are received at a per-kilogram cost, without carton metadata.
ALTER TABLE purchase_receipt_lines
  DROP CONSTRAINT purchase_receipt_lines_entry_unit_check;

ALTER TABLE purchase_receipt_lines
  ADD CONSTRAINT purchase_receipt_lines_entry_unit_check
  CHECK (entry_unit IN ('PIECE', 'CARTON', 'WEIGHT'));

ALTER TABLE purchase_receipt_lines
  DROP CONSTRAINT purchase_receipt_lines_packaging_check;

ALTER TABLE purchase_receipt_lines
  ADD CONSTRAINT purchase_receipt_lines_packaging_check CHECK (
    (entry_unit IN ('PIECE', 'WEIGHT') AND cost_basis = 'UNIT' AND package_count IS NULL AND units_per_package IS NULL AND package_cost_minor IS NULL AND line_total_minor IS NULL)
    OR
    (entry_unit = 'CARTON' AND package_count > 0 AND units_per_package > 0 AND (
      (cost_basis = 'PACKAGE' AND package_cost_minor >= 0 AND line_total_minor IS NULL)
      OR
      (cost_basis = 'LINE_TOTAL' AND line_total_minor >= 0 AND package_cost_minor IS NULL)
    ))
  );
