-- One generated scale label maps to exactly one print request.  The physical
-- label printer remains attached only to the primary Windows host.
CREATE TABLE mobile_weighted_label_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode text NOT NULL UNIQUE REFERENCES weighted_product_labels(barcode),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED')),
  claimed_by_terminal_id uuid REFERENCES terminals(id),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text
);

CREATE INDEX mobile_weighted_label_print_jobs_queue_idx
  ON mobile_weighted_label_print_jobs(state, requested_at, id);

INSERT INTO schema_migrations(version) VALUES ('039_mobile_weighted_label_print_jobs');
