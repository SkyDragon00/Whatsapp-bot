CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	content TEXT NOT NULL,
	size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 100000),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_documents_created
	ON ai_knowledge_documents(created_at DESC, id DESC);
