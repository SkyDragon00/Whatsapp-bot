import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearConversation, loadConversation, saveConversation } from '../src/conversation/store.js';

const chatId = 'conversation-test-chat';

describe('memoria conversacional en KV', () => {
	beforeEach(async () => {
		await clearConversation(env.CONVERSATIONS, chatId);
	});

	it('limita el historial reciente y elimina secretos comunes', async () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			role: index % 2 === 0 ? 'user' : 'model',
			text: index === 19 ? 'api_key=valor-super-secreto' : `mensaje ${index}`,
		}));
		await saveConversation(env.CONVERSATIONS, chatId, messages);

		const stored = await loadConversation(env.CONVERSATIONS, chatId);
		expect(stored).toHaveLength(16);
		expect(stored[0].text).toBe('mensaje 4');
		expect(stored.at(-1).text).toContain('[secreto omitido]');
		expect(stored.at(-1).text).not.toContain('valor-super-secreto');
	});

	it('permite limpiar la conversacion', async () => {
		await saveConversation(env.CONVERSATIONS, chatId, [{ role: 'user', text: 'hola' }]);
		await clearConversation(env.CONVERSATIONS, chatId);
		expect(await loadConversation(env.CONVERSATIONS, chatId)).toEqual([]);
	});
});
