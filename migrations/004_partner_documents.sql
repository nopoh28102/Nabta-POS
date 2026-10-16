BEGIN;

CREATE TABLE partner_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_kind text NOT NULL CHECK (partner_kind IN ('SUPPLIER', 'CUSTOMER')),
  supplier_id uuid REFERENCES suppliers(id),
  customer_id uuid REFERENCES customers(id),
  reference_no text,
  goods_summary text NOT NULL CHECK (length(trim(goods_summary)) >= 3),
  goods_minor bigint NOT NULL CHECK (goods_minor >= 0),
  fees_minor bigint NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor > 0 AND total_minor = goods_minor + fees_minor),
  remaining_minor bigint NOT NULL CHECK (remaining_minor >= 0 AND remaining_minor <= total_minor),
  status text NOT NULL CHECK (status IN ('OPEN', 'PARTIAL', 'SETTLED')),
  note text,
  due_on date,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((partner_kind = 'SUPPLIER' AND supplier_id IS NOT NULL AND customer_id IS NULL) OR (partner_kind = 'CUSTOMER' AND customer_id IS NOT NULL AND supplier_id IS NULL))
);
CREATE INDEX partner_documents_supplier_idx ON partner_documents(supplier_id, created_at DESC) WHERE supplier_id IS NOT NULL;
CREATE INDEX partner_documents_customer_idx ON partner_documents(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

CREATE TABLE partner_document_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES partner_documents(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text NOT NULL CHECK (length(trim(note)) >= 3),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  paid_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_document_payments_document_idx ON partner_document_payments(document_id, paid_at DESC);
CREATE TRIGGER partner_document_payments_immutable BEFORE UPDATE OR DELETE ON partner_document_payments
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO schema_migrations(version) VALUES ('004_partner_documents');
COMMIT;
