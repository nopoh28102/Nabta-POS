CREATE TABLE backup_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  automatic_enabled boolean NOT NULL DEFAULT true,
  destination_path text,
  interval_days integer NOT NULL DEFAULT 3 CHECK (interval_days BETWEEN 1 AND 31),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO backup_policy(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE backup_runs
  ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'MANUAL'
    CHECK (run_kind IN ('MANUAL', 'AUTOMATIC', 'RESET'));

CREATE INDEX IF NOT EXISTS backup_runs_automatic_completed_idx
  ON backup_runs(run_kind, completed_at DESC)
  WHERE run_kind = 'AUTOMATIC' AND status IN ('COMPLETED', 'RESTORE_VERIFIED');

INSERT INTO schema_migrations(version) VALUES ('010_automatic_backup_policy')
ON CONFLICT (version) DO NOTHING;
