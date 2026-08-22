-- Service names are unique inside each business, not across the whole platform.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE services_rebuilt (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL COLLATE NOCASE,
	description TEXT,
	duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
	price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	company_id INTEGER REFERENCES companies(id)
);

INSERT INTO services_rebuilt (
	id, name, description, duration_minutes, price_cents, enabled, created_at, updated_at, company_id
)
SELECT id, name, description, duration_minutes, price_cents, enabled, created_at, updated_at, company_id
FROM services;

DROP TABLE services;
ALTER TABLE services_rebuilt RENAME TO services;

CREATE INDEX idx_services_enabled_name ON services(enabled, name);
CREATE INDEX idx_services_company ON services(company_id, enabled, name);
CREATE UNIQUE INDEX idx_services_company_name
	ON services(company_id, name COLLATE NOCASE) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX idx_services_legacy_name
	ON services(name COLLATE NOCASE) WHERE company_id IS NULL;

PRAGMA defer_foreign_keys = OFF;
