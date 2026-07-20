import { ValidationError } from '../domain/errors.js';

export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 100_000;
export const MAX_KNOWLEDGE_TOTAL_BYTES = 500_000;

const ALLOWED_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

function isMissingKnowledgeTable(error) {
	return typeof error?.message === 'string'
		&& error.message.toLowerCase().includes('no such table')
		&& error.message.includes('ai_knowledge_documents');
}

async function ensureKnowledgeSchema(db) {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				content TEXT NOT NULL,
				size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 100000),
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_ai_knowledge_documents_created
			 ON ai_knowledge_documents(created_at DESC, id DESC)`,
		),
	]);
}

async function withKnowledgeSchema(db, operation) {
	try {
		return await operation();
	} catch (error) {
		if (!isMissingKnowledgeTable(error)) throw error;
		await ensureKnowledgeSchema(db);
		return operation();
	}
}

function normalizeDocument(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('El documento no es valido.');
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
	const content = typeof input.content === 'string' ? input.content.replace(/\0/g, '').trim() : '';
	const sizeBytes = new TextEncoder().encode(content).byteLength;
	if (!name || name.length > 180) throw new ValidationError('El nombre del documento no es valido.');
	if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new ValidationError('Solo se aceptan archivos TXT, Markdown, CSV o JSON.');
	if (!content) throw new ValidationError('El documento esta vacio.');
	if (sizeBytes > MAX_KNOWLEDGE_DOCUMENT_BYTES) throw new ValidationError('Cada documento puede pesar como maximo 100 KB.');
	return { name, mimeType, content, sizeBytes };
}

export async function listKnowledgeDocuments(db) {
	const result = await withKnowledgeSchema(db, () => db.prepare(
		`SELECT id, name, mime_type, size_bytes, created_at, updated_at
		 FROM ai_knowledge_documents ORDER BY created_at DESC, id DESC`,
	).all());
	return result.results;
}

export async function getKnowledgeContext(db) {
	const result = await withKnowledgeSchema(db, () => db
		.prepare('SELECT id, name, content FROM ai_knowledge_documents ORDER BY created_at, id')
		.all());
	return result.results;
}

export async function createKnowledgeDocument(db, input) {
	const document = normalizeDocument(input);
	const currentBytes = await withKnowledgeSchema(db, () => db
		.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM ai_knowledge_documents')
		.first('total'));
	if (Number(currentBytes) + document.sizeBytes > MAX_KNOWLEDGE_TOTAL_BYTES) {
		throw new ValidationError('Los documentos de contexto no pueden superar 500 KB en total.');
	}
	return withKnowledgeSchema(db, () => db.prepare(
		`INSERT INTO ai_knowledge_documents (name, mime_type, content, size_bytes)
		 VALUES (?1, ?2, ?3, ?4) RETURNING id, name, mime_type, size_bytes, created_at, updated_at`,
	).bind(document.name, document.mimeType, document.content, document.sizeBytes).first());
}

export async function deleteKnowledgeDocument(db, id) {
	const numericId = Number(id);
	if (!Number.isInteger(numericId) || numericId <= 0) throw new ValidationError('El documento no es valido.');
	const result = await withKnowledgeSchema(db, () => db
		.prepare('DELETE FROM ai_knowledge_documents WHERE id = ?1 RETURNING id')
		.bind(numericId)
		.first());
	if (!result) {
		const error = new Error('Documento no encontrado.');
		error.status = 404;
		throw error;
	}
	return { ok: true, id: numericId };
}
