import {
	MAX_WHATSAPP_MESSAGE_LENGTH,
	WHATSAPP_TIMEOUT_MS,
} from '../config/constants.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';

export async function sendWhatsAppMessage(recipient, text, env, { fetchImpl = fetch } = {}) {
	const accessToken = env.WHATSAPP_ACCESS_TOKEN_NEW || env.WHATSAPP_ACCESS_TOKEN;
	if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN_NOT_CONFIGURED');
	if (!env.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WHATSAPP_PHONE_NUMBER_ID_NOT_CONFIGURED');

	const safeText = String(text).trim().slice(0, MAX_WHATSAPP_MESSAGE_LENGTH)
		|| 'No pude generar una respuesta.';
	const graphVersion = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
	const response = await fetchWithTimeout(
		`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
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
