-- Customer names are unique inside each business, not across the whole platform.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE customers_rebuilt (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	first_name TEXT NOT NULL,
	last_name TEXT NOT NULL,
	full_name TEXT NOT NULL COLLATE NOCASE,
	telegram_user_id TEXT,
	telegram_chat_id TEXT,
	telegram_username TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	cedula_ruc TEXT,
	address TEXT,
	phone TEXT,
	company_id INTEGER REFERENCES companies(id)
);

INSERT INTO customers_rebuilt (
	id, first_name, last_name, full_name, telegram_user_id, telegram_chat_id,
	telegram_username, created_at, updated_at, cedula_ruc, address, phone, company_id
)
SELECT id, first_name, last_name, full_name, telegram_user_id, telegram_chat_id,
	telegram_username, created_at, updated_at, cedula_ruc, address, phone, company_id
FROM customers;

DROP TABLE customers;
ALTER TABLE customers_rebuilt RENAME TO customers;

CREATE INDEX idx_customers_name ON customers(last_name COLLATE NOCASE, first_name COLLATE NOCASE);
CREATE INDEX idx_customers_telegram_user ON customers(telegram_user_id);
CREATE INDEX idx_customers_company ON customers(company_id, last_name, first_name);
CREATE UNIQUE INDEX idx_customers_company_full_name
	ON customers(company_id, full_name COLLATE NOCASE) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX idx_customers_legacy_full_name
	ON customers(full_name COLLATE NOCASE) WHERE company_id IS NULL;

PRAGMA defer_foreign_keys = OFF;
