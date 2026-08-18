ALTER TABLE users ADD COLUMN phone_e164 TEXT;

UPDATE users
SET phone_e164 = '+593996133200'
WHERE username = 'Mario' COLLATE NOCASE
  AND company_id = (
	SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_e164
	ON users(phone_e164) WHERE phone_e164 IS NOT NULL;
