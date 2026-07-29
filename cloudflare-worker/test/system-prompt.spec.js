import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/ai/system-prompt.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/config/constants.js';

describe('prompt del asistente', () => {
	it('incluye documentos y obliga a reconocer cuando falta informacion', () => {
		const prompt = buildSystemPrompt({
			settings: DEFAULT_BUSINESS_SETTINGS,
			knowledgeDocuments: [{ name: 'manual.txt', content: 'La garantia dura 30 dias.' }],
			now: new Date('2026-07-19T12:00:00.000Z'),
		});
		expect(prompt).toContain('DOCUMENTO: manual.txt');
		expect(prompt).toContain('La garantia dura 30 dias.');
		expect(prompt).toContain('no sabes');
		expect(prompt).toContain('No completes huecos');
	});

	it.each([
		['formal', 'ESTILO FORMAL', 'Usa "usted"'],
		['semiformal', 'ESTILO SEMIFORMAL', 'Puedes usar "tú"'],
		['friend', 'ESTILO AMIGO', '"preciosa"'],
	])('aplica el estilo de comunicacion %s', (communicationStyle, label, instruction) => {
		const settings = {
			...DEFAULT_BUSINESS_SETTINGS,
			businessProfile: { ...DEFAULT_BUSINESS_SETTINGS.businessProfile, communicationStyle },
		};
		const prompt = buildSystemPrompt({ settings });
		expect(prompt).toContain(label);
		expect(prompt).toContain(instruction);
	});

	it('explica las reglas fiscales de pagos en modo dueño', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, aiMode: 'owner' },
		});
		expect(prompt).toContain('find_customer_appointments');
		expect(prompt).toContain('RUC 9999999999999');
		expect(prompt).toContain('mayor de $50');
		expect(prompt).toContain('get_financial_summary');
		expect(prompt).toContain('income_cents');
		expect(prompt).toContain('cédula/RUC, dirección y teléfono');
	});
});
