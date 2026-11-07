-- A dedicated expiry employee may register dates but cannot change products,
-- prices, quantities, or purchase receipts. Existing stock keepers retain
-- their current permissions for backwards compatibility.
INSERT INTO role_permissions(role, permission) VALUES
  ('OWNER', 'EXPIRY_REGISTER'),
  ('MANAGER', 'EXPIRY_REGISTER'),
  ('STOCK_KEEPER', 'EXPIRY_REGISTER'),
  ('EXPIRY_CLERK', 'EXPIRY_REGISTER')
ON CONFLICT DO NOTHING;

-- Expiry registration is a reclassification, not a stock increase/decrease.
-- Keep an immutable event ledger for it instead of fabricating a quantity
-- movement with a zero delta (which would break the stock ledger invariant).
CREATE TABLE stock_lot_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  target_lot_id uuid NOT NULL REFERENCES stock_lots(id),
  event_type text NOT NULL CHECK (event_type IN ('EXPIRY_REGISTERED')),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  expires_on date NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (actor_user_id, idempotency_key)
);
CREATE INDEX stock_lot_events_product_time_idx ON stock_lot_events(warehouse_id, product_id, occurred_at DESC, id DESC);
CREATE TRIGGER stock_lot_events_immutable BEFORE UPDATE OR DELETE ON stock_lot_events
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO schema_migrations(version) VALUES ('036_expiry_clerk_permissions_and_lot_events');
