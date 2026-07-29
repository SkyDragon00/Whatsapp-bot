ALTER TABLE expenses ADD COLUMN bank TEXT;
ALTER TABLE expenses ADD COLUMN receipt_key TEXT;
ALTER TABLE expenses ADD COLUMN receipt_name TEXT;
ALTER TABLE expenses ADD COLUMN receipt_mime_type TEXT;

ALTER TABLE payments ADD COLUMN bank TEXT;
ALTER TABLE payments ADD COLUMN receipt_key TEXT;
ALTER TABLE payments ADD COLUMN receipt_name TEXT;
ALTER TABLE payments ADD COLUMN receipt_mime_type TEXT;
