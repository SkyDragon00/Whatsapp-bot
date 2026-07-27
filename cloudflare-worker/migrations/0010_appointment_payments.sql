ALTER TABLE payments ADD COLUMN appointment_id INTEGER REFERENCES appointments(id);

CREATE INDEX IF NOT EXISTS idx_payments_appointment
ON payments(appointment_id, payment_date, id);
