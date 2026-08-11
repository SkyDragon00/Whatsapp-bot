import {
	CONVERSATION_MAX_MESSAGE_LENGTH,
	CONVERSATION_MAX_MESSAGES,
	CONVERSATION_TTL_SECONDS,
} from '../config/constants.js';

function conversationKey(chatId) {
	return `conversation:${chatId}`;
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
	await kv.delete(conversationKey(chatId));
}
