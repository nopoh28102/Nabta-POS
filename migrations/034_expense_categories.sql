ALTER TABLE cash_movements
  ADD COLUMN expense_category text NOT NULL DEFAULT 'مصروفات تشغيل عامة';

CREATE INDEX cash_movements_expense_category_idx ON cash_movements(expense_category, occurred_at DESC)
  WHERE type = 'EXPENSE';
