import { ValidationError } from '../domain/errors.js';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function safeExtension(mimeType) {
	return {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'application/pdf': 'pdf',
	}[mimeType];
}

export function validateReceipt({ size, mimeType }) {
	if (!ALLOWED_MIME_TYPES.has(mimeType)) {
		throw new ValidationError('El comprobante debe ser JPG, PNG, WebP o PDF.');
	}
	if (!Number.isInteger(size) || size < 1 || size > MAX_RECEIPT_BYTES) {
		throw new ValidationError('El comprobante debe pesar máximo 5 MB.');
	}
}

export async function storeReceipt(bucket, { ownerType, ownerId, bytes, mimeType, fileName }) {
	if (!bucket) throw new ValidationError('El almacenamiento de comprobantes no está configurado.');
	const size = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.size;
	validateReceipt({ size, mimeType });
	const key = `${ownerType}/${ownerId}/${crypto.randomUUID()}.${safeExtension(mimeType)}`;
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: mimeType },
		customMetadata: { fileName: String(fileName || 'comprobante').slice(0, 180) },
	});
	return { key, name: String(fileName || 'comprobante').slice(0, 180), mimeType };
}

export async function receiptResponse(bucket, key, fileName, mimeType) {
	if (!bucket || !key) return null;
	const object = await bucket.get(key);
	if (!object) return null;
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Content-Type', mimeType || headers.get('Content-Type') || 'application/octet-stream');
	headers.set('Content-Disposition', `inline; filename="${String(fileName || 'comprobante').replace(/["\r\n]/g, '')}"`);
	headers.set('Cache-Control', 'private, no-store');
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(object.body, { headers });
}
