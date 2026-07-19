ALTER TABLE expenses ADD COLUMN source_pending_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_source_pending_id
	ON expenses(source_pending_id) WHERE source_pending_id IS NOT NULL;
