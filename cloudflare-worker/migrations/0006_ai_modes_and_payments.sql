CREATE TABLE IF NOT EXISTS payments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	payment_date TEXT NOT NULL CHECK (payment_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	customer_name TEXT NOT NULL,
	amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
	payment_method TEXT NOT NULL,
	notes TEXT,
	telegram_user_id TEXT NOT NULL,
	telegram_chat_id TEXT NOT NULL,
	telegram_username TEXT,
	source_update_id TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_source_update ON payments(source_update_id)
WHERE source_update_id IS NOT NULL;
