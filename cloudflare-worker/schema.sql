-- Snapshot del esquema final. Para bases existentes, aplica los archivos de migrations/ en orden.
CREATE TABLE IF NOT EXISTS services (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL COLLATE NOCASE UNIQUE,
	description TEXT,
	duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
	price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	first_name TEXT NOT NULL,
	last_name TEXT NOT NULL,
	full_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
	cedula_ruc TEXT,
	address TEXT,
	phone TEXT,
	telegram_user_id TEXT,
	telegram_chat_id TEXT,
	telegram_username TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	telegram_user_id TEXT NOT NULL,
	telegram_chat_id TEXT NOT NULL,
	telegram_username TEXT,
	patient_name TEXT NOT NULL,
	service TEXT NOT NULL,
	date_text TEXT NOT NULL,
	date_iso TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	service_id INTEGER REFERENCES services(id),
	service_name TEXT,
	start_at TEXT,
	end_at TEXT,
	status TEXT NOT NULL DEFAULT 'confirmed'
		CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
	phone TEXT,
	updated_at TEXT,
	source_update_id TEXT,
	customer_id INTEGER REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

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
	source_pending_id TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	appointment_id INTEGER REFERENCES appointments(id),
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

CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	content TEXT NOT NULL,
	size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 100000),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (key, value)
VALUES
	('schedule', '{"appointmentDurationMinutes":60,"businessTimezone":"America/Guayaquil","slotIntervalMinutes":15,"minimumBookingNoticeMinutes":0,"maximumAdvanceBookingDays":31,"closedDates":[],"businessHours":[{"day":0,"enabled":false,"start":"09:00","end":"17:00"},{"day":1,"enabled":true,"start":"09:00","end":"17:00"},{"day":2,"enabled":true,"start":"09:00","end":"17:00"},{"day":3,"enabled":true,"start":"09:00","end":"17:00"},{"day":4,"enabled":true,"start":"09:00","end":"17:00"},{"day":5,"enabled":true,"start":"09:00","end":"17:00"},{"day":6,"enabled":false,"start":"09:00","end":"17:00"}]}'),
	('business_profile', '{"businessName":null,"communicationStyle":"semiformal","preferredTone":null,"greeting":null,"address":null,"contactPhone":null,"cancellationPolicy":null,"arrivalInstructions":null,"generalNotes":null,"acceptedPaymentMethods":[]}');

CREATE INDEX IF NOT EXISTS idx_appointments_date_iso ON appointments(date_iso);
CREATE INDEX IF NOT EXISTS idx_appointments_active_range ON appointments(status, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_appointments_telegram_user ON appointments(telegram_user_id, status, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_id, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(last_name COLLATE NOCASE, first_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_customers_telegram_user ON customers(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_services_enabled_name ON services(enabled, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_source_update ON appointments(source_update_id)
WHERE source_update_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_source_pending_id
	ON expenses(source_pending_id) WHERE source_pending_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments(appointment_id, payment_date, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_source_update ON payments(source_update_id)
WHERE source_update_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_documents_created
	ON ai_knowledge_documents(created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS appointments_validate_interval_insert
BEFORE INSERT ON appointments
WHEN
	NEW.status = 'confirmed'
	AND (
		NEW.service_id IS NULL
		OR NEW.service_name IS NULL
		OR NEW.start_at IS NULL
		OR NEW.end_at IS NULL
		OR NEW.start_at >= NEW.end_at
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid_appointment_interval');
END;

CREATE TRIGGER IF NOT EXISTS appointments_prevent_overlap_insert
BEFORE INSERT ON appointments
WHEN
	NEW.status = 'confirmed'
	AND EXISTS (
		SELECT 1
		FROM appointments AS existing
		WHERE existing.status = 'confirmed'
			AND existing.start_at < NEW.end_at
			AND existing.end_at > NEW.start_at
	)
BEGIN
	SELECT RAISE(ABORT, 'appointment_overlap');
END;

CREATE TRIGGER IF NOT EXISTS appointments_validate_interval_update
BEFORE UPDATE OF service_id, service_name, start_at, end_at, status ON appointments
WHEN
	NEW.status = 'confirmed'
	AND (
		NEW.service_id IS NULL
		OR NEW.service_name IS NULL
		OR NEW.start_at IS NULL
		OR NEW.end_at IS NULL
		OR NEW.start_at >= NEW.end_at
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid_appointment_interval');
END;

CREATE TRIGGER IF NOT EXISTS appointments_prevent_overlap_update
BEFORE UPDATE OF start_at, end_at, status ON appointments
WHEN
	NEW.status = 'confirmed'
	AND EXISTS (
		SELECT 1
		FROM appointments AS existing
		WHERE existing.id <> OLD.id
			AND existing.status = 'confirmed'
			AND existing.start_at < NEW.end_at
			AND existing.end_at > NEW.start_at
	)
BEGIN
	SELECT RAISE(ABORT, 'appointment_overlap');
END;
