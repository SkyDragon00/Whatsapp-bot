-- Every row that belongs to a business carries its company explicitly.
-- Existing production data belongs to Funny Hair.
INSERT OR IGNORE INTO companies (name) VALUES ('Funny Hair');
UPDATE users
SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
WHERE company_id IN (
	SELECT id FROM companies
	WHERE name COLLATE NOCASE IN ('Fuzzy Hair', 'Fuuny Hair')
);
DELETE FROM companies
WHERE name COLLATE NOCASE IN ('Fuzzy Hair', 'Fuuny Hair');

ALTER TABLE services ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE customers ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE appointments ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE expenses ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE payments ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE ai_knowledge_documents ADD COLUMN company_id INTEGER REFERENCES companies(id);

UPDATE services SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
	WHERE company_id IS NULL;
UPDATE customers SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
	WHERE company_id IS NULL;
UPDATE appointments SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
	WHERE company_id IS NULL;
UPDATE expenses SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
	WHERE company_id IS NULL;
UPDATE payments SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
	WHERE company_id IS NULL;
UPDATE ai_knowledge_documents SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
	WHERE company_id IS NULL;

UPDATE users
SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
WHERE username = 'Mario' COLLATE NOCASE AND role = 'admin';

CREATE INDEX IF NOT EXISTS idx_services_company ON services(company_id, enabled, name);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_appointments_company ON appointments(company_id, start_at, status);
CREATE INDEX IF NOT EXISTS idx_expenses_company ON expenses(company_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_ai_documents_company ON ai_knowledge_documents(company_id, created_at DESC);

DROP TRIGGER IF EXISTS appointments_prevent_overlap_insert;
CREATE TRIGGER appointments_prevent_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status = 'confirmed' AND EXISTS (
	SELECT 1 FROM appointments AS existing
	WHERE existing.company_id IS NEW.company_id
	  AND existing.status = 'confirmed'
	  AND existing.start_at < NEW.end_at
	  AND existing.end_at > NEW.start_at
)
BEGIN
	SELECT RAISE(ABORT, 'appointment_overlap');
END;

DROP TRIGGER IF EXISTS appointments_prevent_overlap_update;
CREATE TRIGGER appointments_prevent_overlap_update
BEFORE UPDATE OF start_at, end_at, status ON appointments
WHEN NEW.status = 'confirmed' AND EXISTS (
	SELECT 1 FROM appointments AS existing
	WHERE existing.id <> OLD.id
	  AND existing.company_id IS NEW.company_id
	  AND existing.status = 'confirmed'
	  AND existing.start_at < NEW.end_at
	  AND existing.end_at > NEW.start_at
)
BEGIN
	SELECT RAISE(ABORT, 'appointment_overlap');
END;
