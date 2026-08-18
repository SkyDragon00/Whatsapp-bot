import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	authorizeWhatsAppUser,
	handleWhatsAppVerification,
	handleWhatsAppWebhook,
} from '../src/routes/whatsapp.js';
import {
	downloadWhatsAppMedia,
	sendWhatsAppMessage,
	sendWhatsAppTypingIndicator,
} from '../src/integrations/whatsapp.js';
import { findUserByPhone, normalizePhoneE164 } from '../src/repositories/user-identity-repository.js';

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

	it('resuelve el numero de WhatsApp al usuario y empresa vinculados', async () => {
		const first = vi.fn().mockResolvedValue({
			username: 'Mario', company_id: 7, company_name: 'Funny Hair', phone_e164: '+593996133200',
		});
		const bind = vi.fn().mockReturnValue({ first });
		const db = { prepare: vi.fn().mockReturnValue({ bind }) };

		expect(normalizePhoneE164('(+593) 996-133-200')).toBe('+593996133200');
		await expect(findUserByPhone(db, '593996133200')).resolves.toMatchObject({
			username: 'Mario', company_id: 7, company_name: 'Funny Hair',
		});
		expect(bind).toHaveBeenCalledWith('+593996133200');
	});

	it('degrada a cliente a los numeros no reconocidos', () => {
		const settings = { aiMode: 'owner', onboardingEnabled: false };
		expect(authorizeWhatsAppUser(settings, null)).toEqual({
			ownerAuthorized: false,
			settings: { aiMode: 'client', onboardingEnabled: false },
		});
		expect(authorizeWhatsAppUser(settings, { role: 'admin', company_id: 7 })).toEqual({
			ownerAuthorized: true,
			settings,
		});
	});

	it('permite el onboarding a un numero nuevo cuando esta activado', () => {
		const settings = { aiMode: 'owner', onboardingEnabled: true };
		expect(authorizeWhatsAppUser(settings, null)).toEqual({
			ownerAuthorized: false,
			settings,
		});
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

	it('marca el mensaje como leído y muestra el indicador de escritura', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}));

		await sendWhatsAppTypingIndicator('wamid.incoming', {
			WHATSAPP_ACCESS_TOKEN_NEW: 'token-nuevo',
			WHATSAPP_PHONE_NUMBER_ID: '123456789',
		}, { fetchImpl });

		expect(fetchImpl).toHaveBeenCalledWith(
			'https://graph.facebook.com/v23.0/123456789/messages',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ Authorization: 'Bearer token-nuevo' }),
				body: JSON.stringify({
					messaging_product: 'whatsapp',
					status: 'read',
					message_id: 'wamid.incoming',
					typing_indicator: { type: 'text' },
				}),
			}),
		);
	});

	it('descarga medios de Meta usando el token nuevo en ambas solicitudes', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				url: 'https://lookaside.fbsbx.com/whatsapp/media-test',
				mime_type: 'image/jpeg',
				file_size: 4,
			}), { headers: { 'Content-Type': 'application/json' } }))
			.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
				headers: { 'Content-Type': 'image/jpeg' },
			}));

		const result = await downloadWhatsAppMedia('media-123', {
			WHATSAPP_ACCESS_TOKEN_NEW: 'token-nuevo',
			WHATSAPP_ACCESS_TOKEN: 'token-anterior',
		}, { fetchImpl });

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[0][0]).toBe('https://graph.facebook.com/v23.0/media-123');
		expect(fetchImpl.mock.calls[1][0]).toBe('https://lookaside.fbsbx.com/whatsapp/media-test');
		for (const call of fetchImpl.mock.calls) {
			expect(call[1].headers).toMatchObject({ Authorization: 'Bearer token-nuevo' });
		}
		expect(result.mimeType).toBe('image/jpeg');
		expect([...new Uint8Array(result.bytes)]).toEqual([1, 2, 3, 4]);
	});
});
