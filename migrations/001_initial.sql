BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('OWNER', 'MANAGER', 'CASHIER', 'STOCK_KEEPER');
CREATE TYPE unit_kind AS ENUM ('PIECE', 'WEIGHT');
CREATE TYPE shift_status AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE payment_method AS ENUM ('CASH', 'CARD', 'CREDIT');
CREATE TYPE sale_status AS ENUM ('POSTED');
CREATE TYPE stock_movement_type AS ENUM (
  'OPENING', 'PURCHASE_RECEIPT', 'SALE', 'SALE_RETURN', 'SUPPLIER_RETURN',
  'COUNT_ADJUSTMENT', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT'
);
CREATE TYPE return_condition AS ENUM ('RESTOCK', 'DAMAGED');
CREATE TYPE cash_movement_type AS ENUM ('EXPENSE', 'WITHDRAWAL', 'DEPOSIT');
CREATE TYPE idempotency_status AS ENUM ('PROCESSING', 'COMPLETED');

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  setup_completed boolean NOT NULL DEFAULT false,
  store_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((setup_completed = false) OR (store_name IS NOT NULL AND length(trim(store_name)) >= 2))
);
INSERT INTO system_state (singleton) VALUES (true);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  timezone text NOT NULL DEFAULT 'Africa/Cairo' CHECK (timezone = 'Africa/Cairo'),
  currency_code char(3) NOT NULL DEFAULT 'EGP' CHECK (currency_code = 'EGP'),
  invoice_counter bigint NOT NULL DEFAULT 0 CHECK (invoice_counter >= 0),
  credit_sales_enabled boolean NOT NULL DEFAULT false,
  prevent_expired_sales boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_default_warehouse_per_branch ON warehouses(branch_id) WHERE is_default;

CREATE TABLE terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, name)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(trim(display_name)) >= 2),
  username text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  discount_limit_bps integer NOT NULL DEFAULT 0 CHECK (discount_limit_bps BETWEEN 0 AND 10000),
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_ci_unique ON users(lower(username));

CREATE TABLE role_permissions (
  role user_role NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT INTO role_permissions(role, permission) VALUES
  ('OWNER', 'SALE_POST'), ('OWNER', 'DISCOUNT'), ('OWNER', 'PRODUCT_WRITE'),
  ('OWNER', 'SHIFT_OPEN'), ('OWNER', 'SHIFT_CLOSE'), ('OWNER', 'CASH_MOVE'),
  ('OWNER', 'RETURN_SALE'), ('OWNER', 'PURCHASE_RECEIVE'), ('OWNER', 'STOCK_COUNT'),
  ('OWNER', 'VIEW_COST'), ('OWNER', 'VIEW_PROFIT'), ('OWNER', 'BACKUP'), ('OWNER', 'SETTINGS'), ('OWNER', 'EXPORT'),
  ('MANAGER', 'SALE_POST'), ('MANAGER', 'DISCOUNT'), ('MANAGER', 'PRODUCT_WRITE'),
  ('MANAGER', 'SHIFT_OPEN'), ('MANAGER', 'SHIFT_CLOSE'), ('MANAGER', 'CASH_MOVE'),
  ('MANAGER', 'RETURN_SALE'), ('MANAGER', 'PURCHASE_RECEIVE'), ('MANAGER', 'STOCK_COUNT'),
  ('MANAGER', 'VIEW_COST'), ('MANAGER', 'VIEW_PROFIT'), ('MANAGER', 'EXPORT'),
  ('CASHIER', 'SALE_POST'), ('CASHIER', 'SHIFT_OPEN'), ('CASHIER', 'SHIFT_CLOSE'),
  ('STOCK_KEEPER', 'PRODUCT_WRITE'), ('STOCK_KEEPER', 'PURCHASE_RECEIVE'), ('STOCK_KEEPER', 'STOCK_COUNT');

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar text NOT NULL CHECK (length(trim(name_ar)) >= 2),
  search_name text NOT NULL,
  sku text,
  category text NOT NULL,
  unit_kind unit_kind NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  reorder_level_milli bigint NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (unit_kind <> 'PIECE' OR reorder_level_milli % 1000 = 0)
);
CREATE UNIQUE INDEX products_sku_unique ON products(lower(sku)) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX products_search_name_idx ON products(search_name);

CREATE TABLE product_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  barcode text NOT NULL CHECK (length(barcode) BETWEEN 1 AND 80),
  conversion_qty_milli bigint NOT NULL DEFAULT 1000 CHECK (conversion_qty_milli > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (barcode)
);

CREATE TABLE stock_balances (
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL DEFAULT 0 CHECK (qty_milli >= 0),
  inventory_value_minor bigint NOT NULL DEFAULT 0 CHECK (inventory_value_minor >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, product_id),
  CHECK ((qty_milli = 0 AND inventory_value_minor = 0) OR qty_milli > 0)
);

CREATE TABLE stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  lot_code text,
  expires_on date,
  received_at timestamptz NOT NULL DEFAULT now(),
  qty_milli bigint NOT NULL CHECK (qty_milli >= 0),
  UNIQUE NULLS NOT DISTINCT (warehouse_id, product_id, lot_code, expires_on, received_at)
);
CREATE INDEX stock_lots_fefo_idx ON stock_lots(warehouse_id, product_id, expires_on, received_at) WHERE qty_milli > 0;

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status shift_status NOT NULL DEFAULT 'OPEN',
  opening_minor bigint NOT NULL CHECK (opening_minor >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  expected_cash_minor bigint,
  actual_cash_minor bigint,
  difference_minor bigint,
  close_note text,
  approved_by uuid REFERENCES users(id),
  CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_shift_per_terminal ON shifts(terminal_id) WHERE status = 'OPEN';

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  lines_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (subtotal_minor - discount_minor = total_minor),
  CHECK (expires_at > created_at)
);

CREATE TABLE idempotency_requests (
  user_id uuid NOT NULL REFERENCES users(id),
  key uuid NOT NULL,
  payload_hash char(64) NOT NULL,
  status idempotency_status NOT NULL DEFAULT 'PROCESSING',
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, key),
  CHECK ((status = 'PROCESSING' AND response_body IS NULL) OR (status = 'COMPLETED' AND response_body IS NOT NULL))
);

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
  invoice_no text NOT NULL,
  status sale_status NOT NULL DEFAULT 'POSTED',
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, invoice_no),
  CHECK (subtotal_minor - discount_minor = total_minor)
);

CREATE TABLE sale_lines (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  product_id uuid NOT NULL REFERENCES products(id),
  name_snapshot text NOT NULL,
  unit_kind_snapshot unit_kind NOT NULL,
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  gross_minor bigint NOT NULL CHECK (gross_minor >= 0),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  returned_qty_milli bigint NOT NULL DEFAULT 0 CHECK (returned_qty_milli >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  returned_cost_minor bigint NOT NULL DEFAULT 0 CHECK (returned_cost_minor >= 0),
  CHECK (gross_minor - discount_minor = net_minor),
  CHECK (returned_qty_milli <= qty_milli),
  CHECK (refunded_minor <= net_minor),
  CHECK (returned_cost_minor <= cost_minor),
  UNIQUE (sale_id, product_id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id),
  method payment_method NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  tendered_minor bigint,
  change_minor bigint NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
  reference text,
  CHECK (tendered_minor IS NULL OR tendered_minor >= amount_minor)
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  movement_type stock_movement_type NOT NULL,
  qty_delta_milli bigint NOT NULL CHECK (qty_delta_milli <> 0),
  value_delta_minor bigint NOT NULL,
  balance_qty_milli bigint NOT NULL CHECK (balance_qty_milli >= 0),
  balance_value_minor bigint NOT NULL CHECK (balance_value_minor >= 0),
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((balance_qty_milli = 0 AND balance_value_minor = 0) OR balance_qty_milli > 0)
);
CREATE INDEX stock_movements_product_time_idx ON stock_movements(warehouse_id, product_id, occurred_at, id);

CREATE TABLE sale_lot_allocations (
  sale_line_id uuid NOT NULL REFERENCES sale_lines(id),
  lot_id uuid NOT NULL REFERENCES stock_lots(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  returned_qty_milli bigint NOT NULL DEFAULT 0 CHECK (returned_qty_milli BETWEEN 0 AND qty_milli),
  PRIMARY KEY (sale_line_id, lot_id)
);

CREATE TABLE sale_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  total_refund_minor bigint NOT NULL CHECK (total_refund_minor > 0),
  cost_reversal_minor bigint NOT NULL CHECK (cost_reversal_minor >= 0),
  posted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sale_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES sale_returns(id),
  sale_line_id uuid NOT NULL REFERENCES sale_lines(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  condition return_condition NOT NULL,
  refund_minor bigint NOT NULL CHECK (refund_minor >= 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0)
);

CREATE TABLE refund_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES sale_returns(id),
  method payment_method NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0)
);

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  type cash_movement_type NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  approved_by uuid REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  supplier_name text NOT NULL,
  supplier_invoice_no text,
  goods_minor bigint NOT NULL CHECK (goods_minor >= 0),
  supply_expenses_minor bigint NOT NULL CHECK (supply_expenses_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  user_id uuid NOT NULL REFERENCES users(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (goods_minor + supply_expenses_minor = total_minor)
);

CREATE TABLE purchase_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES purchase_receipts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  goods_minor bigint NOT NULL CHECK (goods_minor >= 0),
  allocated_expense_minor bigint NOT NULL CHECK (allocated_expense_minor >= 0),
  inventory_value_minor bigint NOT NULL CHECK (inventory_value_minor >= 0),
  lot_id uuid REFERENCES stock_lots(id)
);

CREATE TABLE stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  product_id uuid NOT NULL REFERENCES products(id),
  expected_qty_milli bigint NOT NULL CHECK (expected_qty_milli >= 0),
  actual_qty_milli bigint NOT NULL CHECK (actual_qty_milli >= 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  value_delta_minor bigint NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  user_id uuid NOT NULL REFERENCES users(id),
  approved_by uuid NOT NULL REFERENCES users(id),
  posted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  terminal_id uuid REFERENCES terminals(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time_idx ON audit_logs(occurred_at DESC, id DESC);

CREATE TABLE backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid REFERENCES users(id),
  path text NOT NULL,
  sha256 char(64),
  size_bytes bigint,
  status text NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'RESTORE_VERIFIED')),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable ledger row';
END;
$$;

CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_lines_no_delete BEFORE DELETE ON sale_lines
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_returns_no_delete BEFORE DELETE ON sale_returns
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO schema_migrations(version) VALUES ('001_initial');
COMMIT;
