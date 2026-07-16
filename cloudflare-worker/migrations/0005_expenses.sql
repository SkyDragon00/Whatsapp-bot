CREATE TABLE IF NOT EXISTS expenses (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	expense_date TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	description TEXT NOT NULL,
	category TEXT NOT NULL,
	supplier TEXT,
	amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
	payment_method TEXT NOT NULL,
	document_type TEXT,
	document_number TEXT,
	notes TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category COLLATE NOCASE);
