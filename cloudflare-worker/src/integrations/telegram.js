import {
	MAX_TELEGRAM_MESSAGE_LENGTH,
	TELEGRAM_TIMEOUT_MS,
} from '../config/constants.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';

const MAX_TELEGRAM_MEDIA_BYTES = 20 * 1024 * 1024;

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

export async function downloadTelegramFile(fileId, env, { fetchImpl = fetch } = {}) {
	if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
	const metadataResponse = await fetchWithTimeout(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
		{},
		TELEGRAM_TIMEOUT_MS,
		fetchImpl,
	);
	const metadata = await readJsonWithLimit(metadataResponse, 256_000);
	if (!metadataResponse.ok || !metadata?.ok || !metadata.result?.file_path) throw new Error('TELEGRAM_GET_FILE_FAILED');
	if (Number(metadata.result.file_size) > MAX_TELEGRAM_MEDIA_BYTES) throw new Error('TELEGRAM_MEDIA_TOO_LARGE');
	const fileResponse = await fetchWithTimeout(
		`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${metadata.result.file_path}`,
		{},
		TELEGRAM_TIMEOUT_MS,
		fetchImpl,
	);
	if (!fileResponse.ok) throw new Error('TELEGRAM_DOWNLOAD_FAILED');
	const bytes = await fileResponse.arrayBuffer();
	if (bytes.byteLength > MAX_TELEGRAM_MEDIA_BYTES) throw new Error('TELEGRAM_MEDIA_TOO_LARGE');
	return { bytes, mimeType: fileResponse.headers.get('content-type') };
}
