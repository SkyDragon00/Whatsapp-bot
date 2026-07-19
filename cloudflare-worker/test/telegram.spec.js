import {
	createExecutionContext,
	applyD1Migrations,
	env,
	waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConversation, saveConversation } from '../src/conversation/store.js';
import { handleTelegramWebhook, processTelegramUpdate } from '../src/routes/telegram.js';
import { saveBusinessSettings } from '../src/repositories/settings-repository.js';

const update = {
	update_id: 990001,
	message: {
		message_id: 101,
		chat: { id: 8001 },
		from: { id: 7001, username: 'cliente' },
		text: 'Hola',
	},
};

function requestForUpdate() {
	return new Request('https://example.com/telegram-webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(update),
	});
}

describe('webhook de Telegram', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});
	beforeEach(async () => {
		await env.CONVERSATIONS.delete('telegram-update:update:990001');
		await env.CONVERSATIONS.delete('conversation:8001');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('responde antes de finalizar el procesamiento en segundo plano', async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const processUpdate = vi.fn(() => gate);
		const ctx = createExecutionContext();

		const response = await handleTelegramWebhook(requestForUpdate(), env, ctx, { processUpdate });
		expect(response.status).toBe(200);
		expect(processUpdate).toHaveBeenCalledTimes(1);

		release();
		await waitOnExecutionContext(ctx);
	});

	it('no procesa dos veces el mismo update_id', async () => {
		const processUpdate = vi.fn().mockResolvedValue(undefined);
		const firstContext = createExecutionContext();
		const firstResponse = await handleTelegramWebhook(requestForUpdate(), env, firstContext, { processUpdate });
		await waitOnExecutionContext(firstContext);

		const secondContext = createExecutionContext();
		const secondResponse = await handleTelegramWebhook(requestForUpdate(), env, secondContext, { processUpdate });
		await waitOnExecutionContext(secondContext);

		expect(firstResponse.status).toBe(200);
		expect(await secondResponse.json()).toMatchObject({ ok: true, duplicate: true });
		expect(processUpdate).toHaveBeenCalledTimes(1);
	});

	it.each([
		['start', '/start'],
		['cancelar', '/cancelar'],
	])('el comando %s limpia el historial', async (_label, command) => {
		await saveConversation(env.CONVERSATIONS, '8001', [{ role: 'user', text: 'mensaje anterior' }]);
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchImpl);

		await processTelegramUpdate({
			update,
			message: { ...update.message, text: command },
			identity: 'update:990001',
			env,
		});

		expect(await loadConversation(env.CONVERSATIONS, '8001')).toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('presenta las capacidades de pagos al iniciar en modo dueno', async () => {
		const settings = await (await env.DB.prepare("SELECT value FROM settings WHERE key = 'schedule'").first()).value;
		const current = JSON.parse(settings);
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchImpl);

		await processTelegramUpdate({ update, message: { ...update.message, text: '/start' }, identity: 'owner-start', env });

		const telegramBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(telegramBody.text).toContain('registrar pagos');
	});
});
