BEGIN;

-- CARD predates the provider integration and remains an explicitly manual
-- accounting entry.  Kashier-backed methods are recorded separately so an
-- HTTP response can never be mistaken for a settled card payment.
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'KASHIER_POS_CARD';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'ONLINE_CARD';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'MOBILE_WALLET';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'PAYMENT_LINK';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'INSTAPAY_QR';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'INSTAPAY_R2P';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'BANK_INSTALLMENTS';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'BNPL';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'MEEZA_CARD';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'OTHER_MANUAL_TRANSFER';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'MIXED_PAYMENT';

CREATE TYPE payment_intent_status AS ENUM (
  'CREATED', 'AWAITING_CUSTOMER', 'PROCESSING', 'PENDING_CONFIRMATION',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'RECONCILIATION_REQUIRED',
  'REFUND_PENDING', 'REFUNDED'
);

CREATE TABLE payment_provider_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('KASHIER')),
  environment text NOT NULL CHECK (environment IN ('TEST', 'LIVE')),
  merchant_id text,
  encrypted_credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_url text,
  relay_url text,
  receipt_print_enabled boolean NOT NULL DEFAULT true,
  request_timeout_ms integer NOT NULL DEFAULT 30000 CHECK (request_timeout_ms BETWEEN 3000 AND 60000),
  retry_limit integer NOT NULL DEFAULT 0 CHECK (retry_limit BETWEEN 0 AND 3),
  enabled_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, environment)
);

CREATE TABLE payment_device_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  provider text NOT NULL CHECK (provider IN ('KASHIER')),
  serial_no text NOT NULL CHECK (length(trim(serial_no)) BETWEEN 3 AND 160),
  is_default boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, serial_no)
);
-- A cashier lane can retain an inactive spare terminal, but only one active
-- default terminal may be selected for each provider at that lane.
CREATE UNIQUE INDEX payment_device_bindings_one_default_idx
  ON payment_device_bindings(terminal_id, provider)
  WHERE is_default AND active;

CREATE TABLE payment_provider_runtime (
  provider text PRIMARY KEY CHECK (provider IN ('KASHIER')),
  active_environment text NOT NULL CHECK (active_environment IN ('TEST', 'LIVE')) DEFAULT 'TEST',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payment_provider_runtime(provider, active_environment) VALUES ('KASHIER', 'TEST') ON CONFLICT DO NOTHING;

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  method payment_method NOT NULL,
  provider text NOT NULL CHECK (provider IN ('KASHIER', 'MANUAL')),
  status payment_intent_status NOT NULL DEFAULT 'CREATED',
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'EGP',
  merchant_order_id text NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL,
  provider_session_id text,
  provider_payment_link_id text,
  provider_transaction_id text,
  provider_order_id text,
  device_serial_no text,
  checkout_url text,
  expires_at timestamptz NOT NULL,
  sale_id uuid REFERENCES sales(id),
  failure_code text,
  failure_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(user_id, idempotency_key),
  CHECK ((status = 'SUCCEEDED' AND completed_at IS NOT NULL) OR (status <> 'SUCCEEDED'))
);
CREATE INDEX payment_intents_terminal_status_idx ON payment_intents(terminal_id, status, created_at DESC);
CREATE UNIQUE INDEX payment_intents_provider_transaction_unique ON payment_intents(provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE payment_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_intent_id, product_id)
);
CREATE INDEX payment_reservations_active_idx ON payment_reservations(product_id, warehouse_id, expires_at) WHERE released_at IS NULL;

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  operation text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('STARTED', 'ACCEPTED', 'FAILED', 'TIMED_OUT')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(payment_intent_id, attempt_no),
  UNIQUE(payment_intent_id, idempotency_key)
);

CREATE TABLE payment_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('KASHIER')),
  environment text NOT NULL CHECK (environment IN ('TEST', 'LIVE')),
  event_type text NOT NULL,
  provider_event_key text NOT NULL,
  merchant_order_id text,
  provider_transaction_id text,
  signature_valid boolean NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  UNIQUE(provider, environment, provider_event_key)
);
CREATE INDEX payment_provider_events_order_idx ON payment_provider_events(merchant_order_id, received_at DESC);

CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  idempotency_key uuid NOT NULL UNIQUE,
  provider_refund_id text UNIQUE,
  status payment_intent_status NOT NULL DEFAULT 'REFUND_PENDING',
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_message text
);

CREATE TABLE payment_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('KASHIER')),
  environment text NOT NULL CHECK (environment IN ('TEST', 'LIVE')),
  requested_by uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE payment_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_intent_id uuid REFERENCES payment_intents(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_audit_log_intent_idx ON payment_audit_log(payment_intent_id, occurred_at DESC);

CREATE TRIGGER payment_audit_log_immutable BEFORE UPDATE OR DELETE ON payment_audit_log
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO schema_migrations(version) VALUES ('013_payment_integration') ON CONFLICT DO NOTHING;
COMMIT;
