CREATE TABLE IF NOT EXISTS customers (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	first_name TEXT NOT NULL,
	last_name TEXT NOT NULL,
	full_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
	telegram_user_id TEXT,
	telegram_chat_id TEXT,
	telegram_username TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE appointments ADD COLUMN customer_id INTEGER REFERENCES customers(id);

INSERT OR IGNORE INTO customers (first_name, last_name, full_name, telegram_user_id, telegram_chat_id, telegram_username)
SELECT CASE WHEN instr(trim(patient_name), ' ') > 0 THEN substr(trim(patient_name), 1, instr(trim(patient_name), ' ') - 1) ELSE trim(patient_name) END,
	CASE WHEN instr(trim(patient_name), ' ') > 0 THEN trim(substr(trim(patient_name), instr(trim(patient_name), ' ') + 1)) ELSE '-' END,
	trim(patient_name), telegram_user_id, telegram_chat_id, telegram_username
FROM appointments WHERE trim(patient_name) <> '' GROUP BY trim(patient_name) COLLATE NOCASE;

UPDATE appointments SET customer_id = (
	SELECT customers.id FROM customers WHERE customers.full_name = trim(appointments.patient_name) COLLATE NOCASE LIMIT 1
) WHERE customer_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(last_name COLLATE NOCASE, first_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_customers_telegram_user ON customers(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_id, start_at DESC);
