-- Keep deep catalogue browsing fast.  The API uses a keyset cursor rather
-- than OFFSET, so every page can resume directly from the last product.
CREATE INDEX IF NOT EXISTS products_active_catalog_order_idx
  ON products(name_ar, id) WHERE active;

CREATE INDEX IF NOT EXISTS products_active_category_catalog_order_idx
  ON products(category, name_ar, id) WHERE active;
