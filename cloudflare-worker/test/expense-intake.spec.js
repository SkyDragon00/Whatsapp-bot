import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractExpense } from '../src/expenses/extractor.js';
import { buildExpenseSystemPrompt } from '../src/expenses/jit-prompt.js';
import { buildExpenseResponseSchema } from '../src/expenses/response-schema.js';
import { isExplicitExpenseText, routeTelegramMessage } from '../src/expenses/telegram-router.js';
import { handleExpenseConfirmation } from '../src/expenses/flow.js';

const context = {
	categories: ['Insumos', 'Otros'], currency: 'USD', timezone: 'America/Guayaquil', localDate: '2026-07-19',
};

describe('ingreso confirmado de gastos', () => {
	beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM expenses').run();
		await env.CONVERSATIONS.delete('expense:chat:8001');
		await env.CONVERSATIONS.delete('expense:pending:A1B2C3D4');
	});

	it('enruta por tipo sin inferencia', () => {
		expect(routeTelegramMessage({ text: 'Gasté 5' })).toMatchObject({ type: 'text' });
		expect(routeTelegramMessage({ photo: [
			{ file_id: 'small', width: 320, height: 600 },
			{ file_id: 'suitable', file_unique_id: 'unique', width: 800, height: 1200 },
			{ file_id: 'too-large', width: 1600, height: 2400 },
		] })).toMatchObject({ type: 'image', fileId: 'suitable', mediaId: 'unique', width: 800, height: 1200 });
		expect(routeTelegramMessage({ voice: { file_id: 'voice', file_unique_id: 'v1' } })).toMatchObject({ type: 'audio', mediaId: 'v1' });
		expect(routeTelegramMessage({ sticker: { file_id: 'sticker' } })).toEqual({ type: 'unsupported' });
	});

	it('separa de forma determinista un gasto textual de una solicitud de cita', () => {
		expect(isExplicitExpenseText('Registra gasto de una silla, costó 200')).toBe(true);
		expect(isExplicitExpenseText('Compré insumos por 35')).toBe(true);
		expect(isExplicitExpenseText('Quiero un corte de barba mañana a las 11')).toBe(false);
	});

	it('construye solo las instrucciones JIT del tipo recibido', () => {
		const prompt = buildExpenseSystemPrompt({ type: 'audio', ...context });
		expect(prompt).toContain('nota de voz');
		expect(prompt).toContain('Insumos, Otros');
		expect(prompt).not.toContain('factura o recibo de la imagen');
		expect(buildExpenseResponseSchema(context.categories).properties.category.enum).toEqual(context.categories);
	});

	it('hace una sola llamada con JSON schema e inlineData', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			candidates: [{ content: { parts: [{ text: JSON.stringify({
				detected: true, amount: 12.5, currency: 'USD', description: 'Taxi', category: 'Otros',
				merchant: null, date: null, confidence: 0.9, needs_review: false,
			}) }] } }],
		}), { headers: { 'Content-Type': 'application/json' } }));
		const result = await extractExpense({
			apiKey: 'test', input: { type: 'audio', mimeType: 'audio/ogg', base64: 'AA==' }, context, fetchImpl,
		});
		expect(result).toMatchObject({ detected: true, amount: 12.5, description: 'Taxi' });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'audio/ogg', data: 'AA==' } });
		expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
		expect(body.generationConfig.responseSchema.required).toContain('needs_review');
		expect(body.generationConfig.responseSchema.additionalProperties).toBeUndefined();
		expect(body.generationConfig.responseSchema.properties.amount).toMatchObject({ type: 'number', nullable: true });
		expect(body.tools).toBeUndefined();
	});

	it('escribe en D1 solamente después del si y consume el pendiente', async () => {
		const pending = {
			id: 'A1B2C3D4', chatId: '8001', userId: '7001', localDate: '2026-07-19',
			extraction: { amount: 20, currency: 'USD', description: 'Papel', category: 'Insumos', merchant: 'Tienda', date: null, confidence: 0.95 },
		};
		await env.CONVERSATIONS.put('expense:pending:A1B2C3D4', JSON.stringify(pending), { expirationTtl: 3600 });
		await env.CONVERSATIONS.put('expense:chat:8001', 'A1B2C3D4', { expirationTtl: 3600 });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM expenses').first('count')).toBe(0);
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await handleExpenseConfirmation({ text: 'sí', chatId: '8001', userId: '7001', env })).toBe(true);
		const stored = await env.DB.prepare('SELECT * FROM expenses').first();
		expect(stored).toMatchObject({ description: 'Papel', amount_cents: 2000 });
		expect(stored.notes).toContain('Confirmación: A1B2C3D4');
		expect(await env.CONVERSATIONS.get('expense:pending:A1B2C3D4')).toBeNull();
		vi.unstubAllGlobals();
	});
});
