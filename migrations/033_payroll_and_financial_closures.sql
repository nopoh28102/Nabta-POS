-- Payroll is kept separate from cash-drawer movements: a salary can be paid
-- by cash, bank or wallet, while every entry still contributes to true profit.
CREATE TABLE payroll_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_user_id uuid NOT NULL REFERENCES users(id),
  payroll_month date NOT NULL CHECK (date_trunc('month', payroll_month)::date = payroll_month),
  base_minor bigint NOT NULL CHECK (base_minor >= 0),
  overtime_minor bigint NOT NULL DEFAULT 0 CHECK (overtime_minor >= 0),
  bonus_minor bigint NOT NULL DEFAULT 0 CHECK (bonus_minor >= 0),
  deduction_minor bigint NOT NULL DEFAULT 0 CHECK (deduction_minor >= 0),
  advance_minor bigint NOT NULL DEFAULT 0 CHECK (advance_minor >= 0),
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  payment_method text NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'WALLET')),
  cash_movement_id uuid UNIQUE REFERENCES cash_movements(id),
  paid_on date NOT NULL,
  note text,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_user_id, payroll_month)
);

CREATE INDEX payroll_entries_month_idx ON payroll_entries(payroll_month DESC, paid_on DESC);
CREATE INDEX payroll_entries_employee_idx ON payroll_entries(employee_user_id, payroll_month DESC);

-- A signed month-close snapshot is intentionally append-only.  It records an
-- auditable management acknowledgement; operational corrections remain
-- compensating entries rather than silent edits to old records.
CREATE TABLE financial_period_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month date NOT NULL UNIQUE CHECK (date_trunc('month', period_month)::date = period_month),
  closed_by_user_id uuid NOT NULL REFERENCES users(id),
  summary jsonb NOT NULL,
  note text,
  closed_at timestamptz NOT NULL DEFAULT now()
);
