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
	source_update_id TEXT
);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value)
VALUES
	('schedule', '{"appointmentDurationMinutes":60,"businessTimezone":"America/Guayaquil","slotIntervalMinutes":15,"minimumBookingNoticeMinutes":0,"maximumAdvanceBookingDays":31,"closedDates":[],"businessHours":[{"day":0,"enabled":false,"start":"09:00","end":"17:00"},{"day":1,"enabled":true,"start":"09:00","end":"17:00"},{"day":2,"enabled":true,"start":"09:00","end":"17:00"},{"day":3,"enabled":true,"start":"09:00","end":"17:00"},{"day":4,"enabled":true,"start":"09:00","end":"17:00"},{"day":5,"enabled":true,"start":"09:00","end":"17:00"},{"day":6,"enabled":false,"start":"09:00","end":"17:00"}]}'),
	('business_profile', '{"businessName":null,"preferredTone":null,"greeting":null,"address":null,"contactPhone":null,"cancellationPolicy":null,"arrivalInstructions":null,"generalNotes":null,"acceptedPaymentMethods":[]}');

CREATE INDEX IF NOT EXISTS idx_appointments_date_iso ON appointments(date_iso);
CREATE INDEX IF NOT EXISTS idx_appointments_active_range ON appointments(status, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_appointments_telegram_user ON appointments(telegram_user_id, status, start_at);
CREATE INDEX IF NOT EXISTS idx_services_enabled_name ON services(enabled, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_source_update ON appointments(source_update_id)
WHERE source_update_id IS NOT NULL;

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
