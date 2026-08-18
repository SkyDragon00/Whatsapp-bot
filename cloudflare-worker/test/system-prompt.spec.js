import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/ai/system-prompt.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/config/constants.js';
import { TOOL_DECLARATIONS } from '../src/ai/tool-definitions.js';

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
		['formal', 'ESTILO FORMAL', 'Usa "usted"', 'No uses emojis bajo ninguna circunstancia'],
		['semiformal', 'ESTILO SEMIFORMAL', 'Puedes usar "tú"', 'nunca uses más de un emoji por mensaje'],
		['friend', 'ESTILO AMIGO', '"preciosa"', 'incluye varios emojis apropiados en cada mensaje'],
	])('aplica el estilo de comunicacion %s', (communicationStyle, label, instruction, emojiInstruction) => {
		const settings = {
			...DEFAULT_BUSINESS_SETTINGS,
			businessProfile: { ...DEFAULT_BUSINESS_SETTINGS.businessProfile, communicationStyle },
		};
		const prompt = buildSystemPrompt({ settings });
		expect(prompt).toContain(label);
		expect(prompt).toContain(instruction);
		expect(prompt).toContain(emojiInstruction);
	});

	it('explica las reglas fiscales de pagos en modo dueño', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, aiMode: 'owner' },
		});
		expect(prompt).toContain('find_customer_appointments');
		expect(prompt).toContain('set_communication_style');
		expect(prompt).toContain('RUC 9999999999999');
		expect(prompt).toContain('mayor de $50');
		expect(prompt).toContain('get_financial_summary');
		expect(prompt).toContain('income_cents');
		expect(prompt).toContain('cédula/RUC, dirección y teléfono');
	});

	it('exige un resumen y confirmación posterior antes de agendar', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, aiMode: 'client' },
		});
		expect(prompt).toContain('resumen claro con nombre, servicio, precio, fecha, hora');
		expect(prompt).toContain('No llames create_appointment en el mismo turno');
		expect(prompt).toContain('confirmación explícita posterior');
	});

	it('obliga a informar el precio cuando el cliente elige un servicio', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, aiMode: 'client' },
		});
		expect(prompt).toContain('En cuanto el cliente elija o confirme un servicio');
		expect(prompt).toContain('indica en la misma respuesta el precio configurado');
		expect(prompt).toContain('Si el servicio no tiene precio configurado, dilo claramente');
	});

	it('no solicita contraseña durante onboarding y explica la clave temporal automática', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, onboardingEnabled: true },
			onboardingIdentity: {
				businessName: 'Griega Madre', username: 'Myriam', communicationStyle: 'semiformal',
			},
		});
		expect(prompt).toContain('No preguntes ni solicites una contraseña');
		expect(prompt).toContain('clave temporal 12345678');
		expect(prompt).toContain('tres alternativas disponibles');
		expect(prompt).not.toContain('nombre del negocio, usuario, contraseña');
		expect(prompt).toContain('Nombre de usuario: "Myriam"');
		expect(prompt).toContain('Estilo de comunicación: "semiformal"');
		expect(prompt).toContain('Nunca vuelvas a preguntar por un campo que aparece en esta lista');
		const onboardingTool = TOOL_DECLARATIONS.find((tool) => tool.name === 'register_business_from_onboarding');
		expect(onboardingTool.parametersJsonSchema.required).not.toContain('password');
		expect(onboardingTool.parametersJsonSchema.properties).not.toHaveProperty('password');
	});
});
