CREATE TABLE IF NOT EXISTS appointments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	telegram_user_id TEXT NOT NULL,
	telegram_chat_id TEXT NOT NULL,
	telegram_username TEXT,
	patient_name TEXT NOT NULL,
	service TEXT NOT NULL,
	date_text TEXT NOT NULL,
	date_iso TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_date_iso
ON appointments(date_iso);
