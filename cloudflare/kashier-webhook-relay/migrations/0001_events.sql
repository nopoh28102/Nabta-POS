CREATE TABLE IF NOT EXISTS kashier_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  environment TEXT NOT NULL CHECK (environment IN ('TEST', 'LIVE')),
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  merchant_order_id TEXT,
  transaction_id TEXT,
  signature TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  UNIQUE(environment, event_key)
);
CREATE INDEX IF NOT EXISTS kashier_events_pending_idx ON kashier_events(environment, delivered_at, id);
