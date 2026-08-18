import { createExpense } from '../repositories/expenses-repository.js';
import { downloadTelegramFile, sendTelegramMessage } from '../integrations/telegram.js';
import { extractExpense } from './extractor.js';
import { getExpenseBusinessContext } from './business-context.js';

const PENDING_TTL_SECONDS = 60 * 60;
const MEDIA_TTL_SECONDS = 24 * 60 * 60;
const YES = new Set(['si', 'sí', 'confirmar', 'confirmo', 'correcto']);
const NO = new Set(['no', 'cancelar', 'cancelo']);

function pendingKey(id) { return `expense:pending:${id}`; }
function chatPendingKey(chatId) { return `expense:chat:${chatId}`; }
function mediaKey(mediaId) { return `expense:media:${mediaId}`; }

function normalizeReply(text) {
	return text.toLocaleLowerCase('es').trim().replace(/[.!?]/g, '');
}

function shortId() {
	const bytes = crypto.getRandomValues(new Uint8Array(5));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
}

function bytesToBase64(bytes) {
	const view = new Uint8Array(bytes);
	let binary = '';
	for (let offset = 0; offset < view.length; offset += 0x8000) {
		binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

async function prepareInput(route, env, downloadMedia) {
	if (route.type === 'text') return { type: 'text', text: route.text };
	const downloaded = await downloadMedia(route.fileId, env);
	if (route.type === 'audio') {
		return { type: 'audio', mimeType: route.mimeType ?? downloaded.mimeType, base64: bytesToBase64(downloaded.bytes) };
	}
	// Telegram genera variantes JPEG de cada foto. El router elige la mayor que no
	// supera 1280 px, evitando una transformación facturable y otro punto de fallo.
	return { type: 'image', mimeType: route.mimeType ?? downloaded.mimeType ?? 'image/jpeg', base64: bytesToBase64(downloaded.bytes) };
}

async function claimMedia(kv, mediaId) {
	if (!mediaId) return true;
	const key = mediaKey(mediaId);
	if (await kv.get(key)) return false;
	await kv.put(key, 'processing', { expirationTtl: 120 });
	return true;
}

async function completeMedia(kv, mediaId, pendingId) {
	if (mediaId) await kv.put(mediaKey(mediaId), pendingId ?? 'review', { expirationTtl: MEDIA_TTL_SECONDS });
}

export async function handleExpenseConfirmation({
	text, chatId, userId, env, now = new Date(), companyId = null,
	sendMessage = sendTelegramMessage,
}) {
	const reply = normalizeReply(text);
	if (!YES.has(reply) && !NO.has(reply)) return false;
	const pendingId = await env.CONVERSATIONS.get(chatPendingKey(chatId));
	if (!pendingId) return false;
	const pending = await env.CONVERSATIONS.get(pendingKey(pendingId), 'json');
	if (!pending || pending.chatId !== chatId || pending.userId !== userId) {
		await env.CONVERSATIONS.delete(chatPendingKey(chatId));
		await sendMessage(chatId, 'Ese gasto pendiente ya expiró. Envíalo nuevamente.', env);
		return true;
	}
	if (Object.hasOwn(pending, 'companyId') && pending.companyId !== companyId) {
		await Promise.all([env.CONVERSATIONS.delete(pendingKey(pendingId)), env.CONVERSATIONS.delete(chatPendingKey(chatId))]);
		await sendMessage(chatId, 'Ese gasto pendiente pertenece a otra cuenta y fue descartado.', env);
		return true;
	}
	if (NO.has(reply)) {
		await Promise.all([env.CONVERSATIONS.delete(pendingKey(pendingId)), env.CONVERSATIONS.delete(chatPendingKey(chatId))]);
		await sendMessage(chatId, 'Gasto descartado. No se guardó nada.', env);
		return true;
	}
	const expense = await createExpense(env.DB, {
		expense_date: pending.extraction.date ?? pending.localDate,
		description: pending.extraction.description,
		category: pending.extraction.category,
		supplier: pending.extraction.merchant,
		amount_cents: Math.round(pending.extraction.amount * 100),
		payment_method: 'No especificado',
		notes: `Confirmación: ${pendingId}; moneda: ${pending.extraction.currency}; confianza: ${pending.extraction.confidence}`,
	}, { now, companyId });
	await Promise.all([env.CONVERSATIONS.delete(pendingKey(pendingId)), env.CONVERSATIONS.delete(chatPendingKey(chatId))]);
	await sendMessage(chatId, `Gasto #${expense.id} registrado correctamente.`, env);
	return true;
}

export async function processExpenseMessage({
	route, chatId, userId, settings, env, now = new Date(),
	companyId = null,
	sendMessage = sendTelegramMessage, downloadMedia = downloadTelegramFile,
}) {
	if (route.type === 'unsupported') {
		await sendMessage(chatId, 'Solo puedo procesar texto, fotos de facturas/recibos y notas de voz.', env);
		return;
	}
	if (route.type === 'text' && !route.text) {
		await sendMessage(chatId, 'Escribe el monto y la descripción del gasto.', env);
		return;
	}
	if (!(await claimMedia(env.CONVERSATIONS, route.mediaId))) {
		await sendMessage(chatId, 'Ese archivo ya fue procesado. Revisa el gasto pendiente.', env);
		return;
	}
	try {
		const context = getExpenseBusinessContext(env, settings, now);
		const input = await prepareInput(route, env, downloadMedia);
		const extraction = await extractExpense({ apiKey: env.GEMINI_API_KEY, input, context });
		if (!extraction.detected || extraction.needs_review) {
			await completeMedia(env.CONVERSATIONS, route.mediaId, null);
			await sendMessage(chatId, 'No pude identificar un gasto completo. Indica claramente el monto y la descripción.', env);
			return;
		}
		const id = shortId();
		const pending = { id, chatId, userId, companyId, localDate: context.localDate, extraction };
		await Promise.all([
			env.CONVERSATIONS.put(pendingKey(id), JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS }),
			env.CONVERSATIONS.put(chatPendingKey(chatId), id, { expirationTtl: PENDING_TTL_SECONDS }),
		]);
		await completeMedia(env.CONVERSATIONS, route.mediaId, id);
		const merchant = extraction.merchant ? `\nProveedor: ${extraction.merchant}` : '';
		const date = extraction.date ? `\nFecha: ${extraction.date}` : '';
		await sendMessage(
			chatId,
			`Gasto detectado [${id}]\nMonto: ${extraction.currency} ${extraction.amount.toFixed(2)}\nDescripción: ${extraction.description}\nCategoría: ${extraction.category}${merchant}${date}\n\n¿Está correcto? Responde sí o no.`,
			env,
		);
	} catch (error) {
		if (route.mediaId) await env.CONVERSATIONS.delete(mediaKey(route.mediaId));
		throw error;
	}
}
