-- Mobile devices never print directly.  They enqueue one receipt for the
-- signed-in primary desktop, which owns the configured Windows/XPrinter path.
-- A receipt may have at most one mobile-originated print request, preventing
-- accidental duplicate paper copies during retries or weak connectivity.
CREATE TABLE mobile_purchase_receipt_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL UNIQUE REFERENCES purchase_receipts(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED')),
  claimed_by_terminal_id uuid REFERENCES terminals(id),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text
);

CREATE INDEX mobile_purchase_receipt_print_jobs_queue_idx
  ON mobile_purchase_receipt_print_jobs(state, requested_at, id);

INSERT INTO schema_migrations(version) VALUES ('037_mobile_purchase_receipt_print_jobs');
