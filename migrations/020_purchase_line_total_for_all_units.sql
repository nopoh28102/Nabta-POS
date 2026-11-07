-- A supplier invoice is normally entered using the total actually paid for
-- its line.  Preserve the old per-unit option for API compatibility, while
-- allowing the exact line total for pieces and weighed products as well.
ALTER TABLE purchase_receipt_lines
  DROP CONSTRAINT IF EXISTS purchase_receipt_lines_packaging_check;

ALTER TABLE purchase_receipt_lines
  ADD CONSTRAINT purchase_receipt_lines_packaging_check CHECK (
    (
      entry_unit IN ('PIECE', 'WEIGHT')
      AND package_count IS NULL
      AND units_per_package IS NULL
      AND package_cost_minor IS NULL
      AND (
        (cost_basis = 'UNIT' AND line_total_minor IS NULL)
        OR
        (cost_basis = 'LINE_TOTAL' AND line_total_minor >= 0)
      )
    )
    OR
    (
      entry_unit = 'CARTON'
      AND package_count > 0
      AND units_per_package > 0
      AND (
        (cost_basis = 'PACKAGE' AND package_cost_minor >= 0 AND line_total_minor IS NULL)
        OR
        (cost_basis = 'LINE_TOTAL' AND line_total_minor >= 0 AND package_cost_minor IS NULL)
      )
    )
  );
