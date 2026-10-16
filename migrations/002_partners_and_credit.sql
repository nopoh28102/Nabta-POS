BEGIN;

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  phone text,
  opening_balance_minor bigint NOT NULL DEFAULT 0 CHECK (opening_balance_minor >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  phone text,
  credit_limit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),
  opening_balance_minor bigint NOT NULL DEFAULT 0 CHECK (opening_balance_minor >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE purchase_receipts ADD COLUMN supplier_id uuid REFERENCES suppliers(id);
ALTER TABLE sales ADD COLUMN customer_id uuid REFERENCES customers(id);
CREATE INDEX purchase_receipts_supplier_idx ON purchase_receipts(supplier_id, posted_at DESC);
CREATE INDEX sales_customer_idx ON sales(customer_id, posted_at DESC);

CREATE TABLE supplier_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  type text NOT NULL CHECK (type IN ('OPENING', 'PURCHASE', 'PAYMENT', 'RETURN', 'ADJUSTMENT')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  purchase_receipt_id uuid REFERENCES purchase_receipts(id),
  reference_id uuid,
  note text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_ledger_supplier_time_idx ON supplier_ledger(supplier_id, created_at, id);

CREATE TABLE customer_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  type text NOT NULL CHECK (type IN ('OPENING', 'SALE_CREDIT', 'COLLECTION', 'REFUND', 'ADJUSTMENT')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  sale_id uuid REFERENCES sales(id),
  reference_id uuid,
  note text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_ledger_customer_time_idx ON customer_ledger(customer_id, created_at, id);

INSERT INTO role_permissions(role, permission) VALUES
  ('OWNER', 'PARTNER_MANAGE'), ('MANAGER', 'PARTNER_MANAGE'),
  ('OWNER', 'PARTNER_VIEW'), ('MANAGER', 'PARTNER_VIEW'), ('CASHIER', 'PARTNER_VIEW')
ON CONFLICT DO NOTHING;

CREATE TRIGGER supplier_ledger_immutable BEFORE UPDATE OR DELETE ON supplier_ledger
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER customer_ledger_immutable BEFORE UPDATE OR DELETE ON customer_ledger
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO schema_migrations(version) VALUES ('002_partners_and_credit');
COMMIT;
