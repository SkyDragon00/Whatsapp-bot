import {
	MAX_TELEGRAM_MESSAGE_LENGTH,
	TELEGRAM_TIMEOUT_MS,
} from '../config/constants.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';

export async function sendTelegramMessage(chatId, text, env, { fetchImpl = fetch } = {}) {
	if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
	const safeText = String(text).trim().slice(0, MAX_TELEGRAM_MESSAGE_LENGTH) || 'No pude generar una respuesta.';
	const response = await fetchWithTimeout(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text: safeText }),
		},
		TELEGRAM_TIMEOUT_MS,
		fetchImpl,
	);
	const result = await readJsonWithLimit(response, 256_000);
	if (!response.ok || !result?.ok) {
		const error = new Error(`TELEGRAM_REQUEST_FAILED_${response.status}`);
		error.code = 'TELEGRAM_REQUEST_FAILED';
		throw error;
	}
	return result.result;
}
