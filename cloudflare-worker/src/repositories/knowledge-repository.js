import { ValidationError } from '../domain/errors.js';
import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 100_000;
export const MAX_KNOWLEDGE_TOTAL_BYTES = 500_000;
export const MAX_PDF_SOURCE_BYTES = 2_000_000;

const ALLOWED_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf']);

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

function decodePdfBase64(value) {
	if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_PDF_SOURCE_BYTES / 3) * 4 + 4) {
		throw new ValidationError('El PDF no es valido o supera el maximo de 2 MB.');
	}
	try {
		const binary = atob(value);
		if (!binary || binary.length > MAX_PDF_SOURCE_BYTES) throw new Error('PDF_SIZE');
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('PDF_SIGNATURE');
		return bytes;
	} catch {
		throw new ValidationError('El PDF no es valido o supera el maximo de 2 MB.');
	}
}

async function extractPdfContent(base64) {
	const bytes = decodePdfBase64(base64);
	try {
		const pdf = await getDocumentProxy(bytes);
		const { text } = await extractText(pdf, { mergePages: true });
		return text;
	} catch {
		throw new ValidationError('No se pudo leer el PDF. Verifica que no este danado o protegido con contrasena.');
	}
}

async function normalizeDocument(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('El documento no es valido.');
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
	if (!name || name.length > 180) throw new ValidationError('El nombre del documento no es valido.');
	if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new ValidationError('Solo se aceptan archivos PDF, TXT, Markdown, CSV o JSON.');
	const rawContent = mimeType === 'application/pdf' ? await extractPdfContent(input.content) : input.content;
	const content = typeof rawContent === 'string' ? rawContent.replace(/\0/g, '').trim() : '';
	const sizeBytes = new TextEncoder().encode(content).byteLength;
	if (!content) throw new ValidationError('El documento esta vacio.');
	if (sizeBytes > MAX_KNOWLEDGE_DOCUMENT_BYTES) throw new ValidationError('El texto extraido de cada documento puede pesar como maximo 100 KB.');
	return { name, mimeType, content, sizeBytes };
}

export async function listKnowledgeDocuments(db, { companyId = null } = {}) {
	const result = await withKnowledgeSchema(db, () => db.prepare(
		`SELECT id, name, mime_type, size_bytes, created_at, updated_at
		 FROM ai_knowledge_documents
		 WHERE (?1 IS NULL OR company_id = ?1)
		 ORDER BY created_at DESC, id DESC`,
	).bind(companyId).all());
	return result.results;
}

export async function getKnowledgeContext(db) {
	const result = await withKnowledgeSchema(db, () => db
		.prepare('SELECT id, name, content FROM ai_knowledge_documents ORDER BY created_at, id')
		.all());
	return result.results;
}

export async function createKnowledgeDocument(db, input, { companyId = null } = {}) {
	const document = await normalizeDocument(input);
	const currentBytes = await withKnowledgeSchema(db, () => db
		.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM ai_knowledge_documents WHERE (?1 IS NULL OR company_id = ?1)')
		.bind(companyId)
		.first('total'));
	if (Number(currentBytes) + document.sizeBytes > MAX_KNOWLEDGE_TOTAL_BYTES) {
		throw new ValidationError('Los documentos de contexto no pueden superar 500 KB en total.');
	}
	return withKnowledgeSchema(db, () => db.prepare(
		`INSERT INTO ai_knowledge_documents (name, mime_type, content, size_bytes, company_id)
		 VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, name, mime_type, size_bytes, created_at, updated_at`,
	).bind(document.name, document.mimeType, document.content, document.sizeBytes, companyId).first());
}

export async function deleteKnowledgeDocument(db, id, { companyId = null } = {}) {
	const numericId = Number(id);
	if (!Number.isInteger(numericId) || numericId <= 0) throw new ValidationError('El documento no es valido.');
	const result = await withKnowledgeSchema(db, () => db
		.prepare('DELETE FROM ai_knowledge_documents WHERE id = ?1 AND (?2 IS NULL OR company_id = ?2) RETURNING id')
		.bind(numericId, companyId)
		.first());
	if (!result) {
		const error = new Error('Documento no encontrado.');
		error.status = 404;
		throw error;
	}
	return { ok: true, id: numericId };
}
