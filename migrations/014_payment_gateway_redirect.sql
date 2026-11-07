BEGIN;

-- Hosted payment sessions must return to a merchant-controlled HTTPS URL.
-- This is separate from the server-to-server webhook and is never inferred
-- from localhost in a packaged POS installation.
ALTER TABLE payment_provider_settings
  ADD COLUMN IF NOT EXISTS merchant_redirect_url text;

INSERT INTO schema_migrations(version) VALUES ('014_payment_gateway_redirect') ON CONFLICT DO NOTHING;
COMMIT;
