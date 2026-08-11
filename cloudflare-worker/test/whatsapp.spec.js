import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	handleWhatsAppVerification,
	handleWhatsAppWebhook,
} from '../src/routes/whatsapp.js';
import { sendWhatsAppMessage } from '../src/integrations/whatsapp.js';

const message = {
	from: '593999111222',
	id: 'wamid.test-1',
	timestamp: '1785300000',
	type: 'text',
	text: { body: 'Hola' },
};

function webhookRequest(payload = {
	object: 'whatsapp_business_account',
	entry: [{
		changes: [{
			field: 'messages',
			value: {
				contacts: [{ wa_id: message.from, profile: { name: 'Ana' } }],
				messages: [message],
			},
		}],
	}],
}) {
	return new Request('https://example.com/whatsapp-webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
}

describe('webhook de WhatsApp', () => {
	const webhookEnv = () => ({
		CONVERSATIONS: env.CONVERSATIONS,
		META_APP_SECRET: undefined,
	});

	beforeEach(async () => {
		await env.CONVERSATIONS.delete('whatsapp-message:wamid.test-1');
	});

	it('acepta el challenge únicamente con el verify token correcto', () => {
		const localEnv = { WHATSAPP_VERIFY_TOKEN: 'token-seguro' };
		const valid = new Request(
			'https://example.com/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=token-seguro&hub.challenge=12345',
		);
		const invalid = new Request(
			'https://example.com/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345',
		);

		expect(handleWhatsAppVerification(valid, localEnv).status).toBe(200);
		expect(handleWhatsAppVerification(invalid, localEnv).status).toBe(403);
	});

	it('responde inmediatamente y procesa el mensaje en segundo plano', async () => {
		const processMessage = vi.fn().mockResolvedValue(undefined);
		const ctx = createExecutionContext();
		const response = await handleWhatsAppWebhook(webhookRequest(), webhookEnv(), ctx, { processMessage });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, accepted: 1 });
		await waitOnExecutionContext(ctx);
		expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({
			message: expect.objectContaining({ id: 'wamid.test-1', profileName: 'Ana' }),
		}));
	});

	it('no procesa dos veces el mismo mensaje', async () => {
		const processMessage = vi.fn().mockResolvedValue(undefined);
		const firstContext = createExecutionContext();
		await handleWhatsAppWebhook(webhookRequest(), webhookEnv(), firstContext, { processMessage });
		await waitOnExecutionContext(firstContext);

		const secondContext = createExecutionContext();
		const second = await handleWhatsAppWebhook(webhookRequest(), webhookEnv(), secondContext, { processMessage });
		await waitOnExecutionContext(secondContext);

		expect(await second.json()).toMatchObject({ ok: true, accepted: 0, duplicates: 1 });
		expect(processMessage).toHaveBeenCalledTimes(1);
	});

	it('ignora notificaciones de estado sin tratarlas como mensajes', async () => {
		const processMessage = vi.fn();
		const ctx = createExecutionContext();
		const response = await handleWhatsAppWebhook(webhookRequest({
			object: 'whatsapp_business_account',
			entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.status' }] } }] }],
		}), webhookEnv(), ctx, { processMessage });
		await waitOnExecutionContext(ctx);

		expect(await response.json()).toMatchObject({ ok: true, accepted: 0 });
		expect(processMessage).not.toHaveBeenCalled();
	});

	it('prioriza el token nuevo al enviar mensajes con Meta', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			messaging_product: 'whatsapp',
			messages: [{ id: 'wamid.sent' }],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } }));

		await sendWhatsAppMessage(message.from, 'Hola', {
			WHATSAPP_ACCESS_TOKEN_NEW: 'token-nuevo',
			WHATSAPP_ACCESS_TOKEN: 'token-anterior',
			WHATSAPP_PHONE_NUMBER_ID: '123456789',
		}, { fetchImpl });

		expect(fetchImpl).toHaveBeenCalledWith(
			'https://graph.facebook.com/v23.0/123456789/messages',
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: 'Bearer token-nuevo' }),
			}),
		);
	});
});
