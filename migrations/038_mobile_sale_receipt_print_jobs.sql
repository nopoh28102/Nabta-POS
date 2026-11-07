-- A mobile sale may request exactly one receipt from the configured primary
-- Windows device.  It is created in the same transaction as the sale so a
-- network retry cannot print a second copy.
CREATE TABLE mobile_sale_receipt_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE REFERENCES sales(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED')),
  claimed_by_terminal_id uuid REFERENCES terminals(id),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text
);

CREATE INDEX mobile_sale_receipt_print_jobs_queue_idx
  ON mobile_sale_receipt_print_jobs(state, requested_at, id);

INSERT INTO schema_migrations(version) VALUES ('038_mobile_sale_receipt_print_jobs');
