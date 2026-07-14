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

INSERT OR IGNORE INTO settings (key, value)
VALUES (
	'schedule',
	'{"appointmentDurationMinutes":60,"businessTimezone":"America/Guayaquil","slotIntervalMinutes":15,"closedDates":[],"businessHours":[{"day":0,"enabled":false,"start":"09:00","end":"17:00"},{"day":1,"enabled":true,"start":"09:00","end":"17:00"},{"day":2,"enabled":true,"start":"09:00","end":"17:00"},{"day":3,"enabled":true,"start":"09:00","end":"17:00"},{"day":4,"enabled":true,"start":"09:00","end":"17:00"},{"day":5,"enabled":true,"start":"09:00","end":"17:00"},{"day":6,"enabled":false,"start":"09:00","end":"17:00"}]}'
);

UPDATE settings
SET value = json_set(
	value,
	'$.businessTimezone', COALESCE(json_extract(value, '$.businessTimezone'), 'America/Guayaquil'),
	'$.slotIntervalMinutes', COALESCE(json_extract(value, '$.slotIntervalMinutes'), 15),
	'$.closedDates', COALESCE(json_extract(value, '$.closedDates'), json('[]'))
)
WHERE key = 'schedule' AND json_valid(value);

INSERT OR IGNORE INTO services (name, duration_minutes, enabled)
SELECT DISTINCT
	service,
	COALESCE(
		CAST((SELECT json_extract(value, '$.appointmentDurationMinutes') FROM settings WHERE key = 'schedule') AS INTEGER),
		60
	),
	1
FROM appointments
WHERE trim(service) <> '';

INSERT OR IGNORE INTO services (name, description, duration_minutes, price_cents, enabled)
VALUES
	('Corte de cabello', 'Corte y acabado personalizado.', 45, 1500, 1),
	('Manicure', 'Cuidado y esmaltado de manos.', 60, 1200, 1),
	('Tratamiento facial', 'Limpieza y cuidado facial básico.', 75, 2500, 1);

ALTER TABLE appointments ADD COLUMN service_id INTEGER REFERENCES services(id);
ALTER TABLE appointments ADD COLUMN service_name TEXT;
ALTER TABLE appointments ADD COLUMN start_at TEXT;
ALTER TABLE appointments ADD COLUMN end_at TEXT;
ALTER TABLE appointments ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'
	CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show'));
ALTER TABLE appointments ADD COLUMN phone TEXT;
ALTER TABLE appointments ADD COLUMN updated_at TEXT;
ALTER TABLE appointments ADD COLUMN source_update_id TEXT;

UPDATE appointments
SET
	service_id = (
		SELECT id FROM services WHERE services.name = appointments.service COLLATE NOCASE LIMIT 1
	),
	service_name = service,
	start_at = strftime('%Y-%m-%dT%H:%M:%fZ', date_iso),
	end_at = strftime(
		'%Y-%m-%dT%H:%M:%fZ',
		date_iso,
		printf(
			'+%d minutes',
			COALESCE(
				CAST((SELECT json_extract(value, '$.appointmentDurationMinutes') FROM settings WHERE key = 'schedule') AS INTEGER),
				60
			)
		)
	),
	updated_at = COALESCE(created_at, CURRENT_TIMESTAMP)
WHERE start_at IS NULL;
