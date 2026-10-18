-- Keep the startup page and the usual prefix search index-backed.  The
-- catalogue endpoint deliberately returns a bounded page, so these indexes
-- improve response time without making the renderer hold every product.
CREATE INDEX IF NOT EXISTS products_active_name_ar_idx
  ON products(name_ar) WHERE active;

CREATE INDEX IF NOT EXISTS products_active_search_name_prefix_idx
  ON products(search_name text_pattern_ops) WHERE active;

CREATE INDEX IF NOT EXISTS products_active_category_search_name_prefix_idx
  ON products(category, search_name text_pattern_ops) WHERE active;

CREATE INDEX IF NOT EXISTS product_barcodes_product_id_idx
  ON product_barcodes(product_id);
