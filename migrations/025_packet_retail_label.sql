-- A packet is the customer-facing middle selling level for cans and bottles.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_retail_package_label_check;
ALTER TABLE products
  ADD CONSTRAINT products_retail_package_label_check
  CHECK (retail_package_label IN ('PACKAGE', 'STACK', 'PACKET'));
