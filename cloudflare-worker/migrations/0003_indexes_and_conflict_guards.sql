CREATE INDEX IF NOT EXISTS idx_appointments_active_range
ON appointments(status, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_appointments_telegram_user
ON appointments(telegram_user_id, status, start_at);

CREATE INDEX IF NOT EXISTS idx_services_enabled_name
ON services(enabled, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_source_update
ON appointments(source_update_id)
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
