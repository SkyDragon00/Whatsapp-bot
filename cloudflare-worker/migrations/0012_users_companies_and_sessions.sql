CREATE TABLE IF NOT EXISTS companies (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL COLLATE NOCASE UNIQUE,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	company_id INTEGER REFERENCES companies(id),
	username TEXT NOT NULL COLLATE NOCASE UNIQUE,
	password_hash TEXT NOT NULL,
	password_salt TEXT NOT NULL,
	password_iterations INTEGER NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('admin', 'super_admin')),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (
		(role = 'super_admin' AND company_id IS NULL)
		OR (role = 'admin' AND company_id IS NOT NULL)
	)
);

CREATE TABLE IF NOT EXISTS sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
