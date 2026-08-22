import {
	CONVERSATION_MAX_MESSAGE_LENGTH,
	CONVERSATION_MAX_MESSAGES,
	CONVERSATION_TTL_SECONDS,
} from '../config/constants.js';

function conversationKey(chatId) {
	return `conversation:${chatId}`;
}

function appointmentStateKey(chatId) {
	return `appointment-state:${chatId}`;
}

function sanitizeText(value) {
	return String(value)
		.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[secreto omitido]')
		.replace(/\b(token|api[_ -]?key|secret)\s*[:=]\s*\S+/gi, '$1=[secreto omitido]')
		.slice(0, CONVERSATION_MAX_MESSAGE_LENGTH);
}

function normalizeMessages(messages) {
	if (!Array.isArray(messages)) return [];
	return messages
		.filter((message) => message && (message.role === 'user' || message.role === 'model'))
		.map((message) => ({ role: message.role, text: sanitizeText(message.text) }))
		.filter((message) => message.text.length > 0)
		.slice(-CONVERSATION_MAX_MESSAGES);
}

export async function loadConversation(kv, chatId, { mode } = {}) {
	const stored = await kv.get(conversationKey(chatId), 'json');
	if (mode !== undefined && stored?.mode !== mode) return [];
	return normalizeMessages(stored?.messages);
}

export async function saveConversation(kv, chatId, messages, { mode } = {}) {
	const normalized = normalizeMessages(messages);
	await kv.put(
		conversationKey(chatId),
		JSON.stringify({ messages: normalized, ...(mode === undefined ? {} : { mode }), updatedAt: new Date().toISOString() }),
		{ expirationTtl: CONVERSATION_TTL_SECONDS },
	);
	return normalized;
}

export async function clearConversation(kv, chatId) {
	await Promise.all([
		kv.delete(conversationKey(chatId)),
		kv.delete(appointmentStateKey(chatId)),
	]);
}

export async function loadAppointmentState(kv, chatId) {
	const stored = await kv.get(appointmentStateKey(chatId), 'json');
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
	return Object.fromEntries(
		['customerName', 'serviceName', 'price', 'date', 'time']
			.filter((key) => typeof stored[key] === 'string' && stored[key].trim())
			.map((key) => [key, stored[key].trim().slice(0, 160)]),
	);
}

export async function saveAppointmentState(kv, chatId, state) {
	await kv.put(
		appointmentStateKey(chatId),
		JSON.stringify(state),
		{ expirationTtl: CONVERSATION_TTL_SECONDS },
	);
}
