BEGIN;

-- FawryPay reference-number transactions are settled by Fawry and must not
-- be recorded as a generic, manually confirmed card payment.
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'FAWRY_REFERENCE';

ALTER TABLE payment_provider_settings DROP CONSTRAINT IF EXISTS payment_provider_settings_provider_check;
ALTER TABLE payment_provider_settings ADD CONSTRAINT payment_provider_settings_provider_check CHECK (provider IN ('KASHIER', 'FAWRY'));
ALTER TABLE payment_device_bindings DROP CONSTRAINT IF EXISTS payment_device_bindings_provider_check;
ALTER TABLE payment_device_bindings ADD CONSTRAINT payment_device_bindings_provider_check CHECK (provider IN ('KASHIER', 'FAWRY'));
ALTER TABLE payment_provider_runtime DROP CONSTRAINT IF EXISTS payment_provider_runtime_provider_check;
ALTER TABLE payment_provider_runtime ADD CONSTRAINT payment_provider_runtime_provider_check CHECK (provider IN ('KASHIER', 'FAWRY'));
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check CHECK (provider IN ('KASHIER', 'FAWRY', 'MANUAL'));
ALTER TABLE payment_provider_events DROP CONSTRAINT IF EXISTS payment_provider_events_provider_check;
ALTER TABLE payment_provider_events ADD CONSTRAINT payment_provider_events_provider_check CHECK (provider IN ('KASHIER', 'FAWRY'));
ALTER TABLE payment_reconciliation_runs DROP CONSTRAINT IF EXISTS payment_reconciliation_runs_provider_check;
ALTER TABLE payment_reconciliation_runs ADD CONSTRAINT payment_reconciliation_runs_provider_check CHECK (provider IN ('KASHIER', 'FAWRY'));

INSERT INTO payment_provider_runtime(provider, active_environment) VALUES ('FAWRY', 'TEST') ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('028_fawry_payment_integration') ON CONFLICT DO NOTHING;
COMMIT;
