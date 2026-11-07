-- A supplier carton can also be sold intact.  It consumes its contained
-- pieces from the same stock balance, but keeps a distinct carton price.
ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_sale_unit_snapshot_check;

ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_sale_unit_snapshot_check
  CHECK (sale_unit_snapshot IN ('UNIT', 'PACKAGE', 'CARTON'));

ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_package_snapshot_check;

ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_package_snapshot_check CHECK (
    (sale_unit_snapshot = 'UNIT' AND sale_package_size_snapshot IS NULL)
    OR (sale_unit_snapshot IN ('PACKAGE', 'CARTON') AND sale_package_size_snapshot >= 2)
  );
