import { describe, expect, it } from 'vitest';
import { handleWhatsAppWebJsBridge } from '../src/routes/whatsapp-webjs.js';

function request(body, token) {
	return new Request('https://example.com/whatsapp-webjs', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe('puente de whatsapp-web.js', () => {
	it('requiere el token compartido', async () => {
		const response = await handleWhatsAppWebJsBridge(request({}), { WHATSAPP_WEBJS_TOKEN: 'secreto' });
		expect(response.status).toBe(401);
	});

	it('valida los campos requeridos', async () => {
		const response = await handleWhatsAppWebJsBridge(
			request({ sender: '593999111222@c.us', text: 'Hola' }, 'secreto'),
			{ WHATSAPP_WEBJS_TOKEN: 'secreto' },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it('valida el contenido base64 de una nota de voz', async () => {
		const response = await handleWhatsAppWebJsBridge(
			request({
				sender: '593999111222@c.us',
				messageId: 'audio-1',
				audio: { data: '%%%no-es-base64%%%', mimeType: 'audio/ogg' },
			}, 'secreto'),
			{ WHATSAPP_WEBJS_TOKEN: 'secreto' },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, error: 'Audio inválido o demasiado grande' });
	});
});
