import {
	MAX_WHATSAPP_MESSAGE_LENGTH,
	WHATSAPP_TIMEOUT_MS,
} from '../config/constants.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';

const MAX_WHATSAPP_MEDIA_BYTES = 20 * 1024 * 1024;

function accessToken(env) {
	return env.WHATSAPP_ACCESS_TOKEN_NEW || env.WHATSAPP_ACCESS_TOKEN;
}

export async function sendWhatsAppMessage(recipient, text, env, { fetchImpl = fetch } = {}) {
	const token = accessToken(env);
	if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN_NOT_CONFIGURED');
	if (!env.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WHATSAPP_PHONE_NUMBER_ID_NOT_CONFIGURED');

	const safeText = String(text).trim().slice(0, MAX_WHATSAPP_MESSAGE_LENGTH)
		|| 'No pude generar una respuesta.';
	const graphVersion = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
	const response = await fetchWithTimeout(
		`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				messaging_product: 'whatsapp',
				recipient_type: 'individual',
				to: recipient,
				type: 'text',
				text: { preview_url: false, body: safeText },
			}),
		},
		WHATSAPP_TIMEOUT_MS,
		fetchImpl,
	);
	const result = await readJsonWithLimit(response, 256_000);
	if (!response.ok || result?.error) {
		const error = new Error(`WHATSAPP_REQUEST_FAILED_${response.status}`);
		error.code = 'WHATSAPP_REQUEST_FAILED';
		throw error;
	}
	return result;
}

export async function downloadWhatsAppMedia(mediaId, env, { fetchImpl = fetch } = {}) {
	const token = accessToken(env);
	if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN_NOT_CONFIGURED');
	const graphVersion = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
	const headers = { Authorization: `Bearer ${token}` };
	const metadataResponse = await fetchWithTimeout(
		`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}`,
		{ headers },
		WHATSAPP_TIMEOUT_MS,
		fetchImpl,
	);
	const metadata = await readJsonWithLimit(metadataResponse, 256_000);
	if (!metadataResponse.ok || !metadata?.url) throw new Error('WHATSAPP_GET_MEDIA_FAILED');
	if (Number(metadata.file_size) > MAX_WHATSAPP_MEDIA_BYTES) throw new Error('WHATSAPP_MEDIA_TOO_LARGE');
	let mediaUrl;
	try {
		mediaUrl = new URL(metadata.url);
	} catch {
		throw new Error('WHATSAPP_MEDIA_URL_INVALID');
	}
	if (mediaUrl.protocol !== 'https:') throw new Error('WHATSAPP_MEDIA_URL_INVALID');
	const mediaResponse = await fetchWithTimeout(
		mediaUrl.toString(),
		{ headers },
		WHATSAPP_TIMEOUT_MS,
		fetchImpl,
	);
	if (!mediaResponse.ok) throw new Error('WHATSAPP_DOWNLOAD_FAILED');
	const bytes = await mediaResponse.arrayBuffer();
	if (bytes.byteLength > MAX_WHATSAPP_MEDIA_BYTES) throw new Error('WHATSAPP_MEDIA_TOO_LARGE');
	return {
		bytes,
		mimeType: metadata.mime_type || mediaResponse.headers.get('content-type'),
		fileName: metadata.filename || null,
	};
}
