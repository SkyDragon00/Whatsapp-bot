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

	it('pide AM o PM para horas ambiguas e informa el horario del local', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, aiMode: 'client' },
		});
		expect(prompt).toContain('Una hora expresada solamente con un número del 1 al 12');
		expect(prompt).toContain('Pregunta si se refiere a AM o PM');
		expect(prompt).toContain('en esa misma respuesta, indica el horario de atención del día solicitado');
		expect(prompt).toContain('lunes: 09:00 a 17:00');
		expect(prompt).toContain('domingo: cerrado');
	});

	it('conserva los datos recopilados de la cita y prohíbe volver a pedirlos', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, aiMode: 'client' },
			appointmentState: {
				customerName: 'Bart Simpson',
				serviceName: 'Corte Barba',
				price: '$5',
				date: '21 de agosto de 2026',
				time: '09:00',
			},
		});
		expect(prompt).toContain('DATOS DE LA CITA YA RECOPILADOS');
		expect(prompt).toContain('Nombre del cliente: "Bart Simpson"');
		expect(prompt).toContain('Nunca vuelvas a pedir un campo presente');
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
				businessName: 'Griega Madre', username: 'Myriam', communicationStyle: 'semiformal', address: 'Av. Central 10',
			},
		});
		expect(prompt).toContain('No preguntes ni solicites una contraseña');
		expect(prompt).toContain('clave temporal 12345678');
		expect(prompt).toContain('tres alternativas disponibles');
		expect(prompt).not.toContain('nombre del negocio, usuario, contraseña');
		expect(prompt).toContain('Nombre de usuario: "Myriam"');
		expect(prompt).toContain('El estilo de comunicación es siempre semiformal');
		expect(prompt).toContain('ESTILO SEMIFORMAL');
		expect(prompt).toContain('Dirección o ubicación: "Av. Central 10"');
		expect(prompt).toContain('Trata "ubicación" y "dirección" como el mismo dato');
		expect(prompt).toContain('Nunca vuelvas a preguntar por un campo que aparece en esta lista');
		const onboardingTool = TOOL_DECLARATIONS.find((tool) => tool.name === 'register_business_from_onboarding');
		expect(onboardingTool.parametersJsonSchema.required).not.toContain('password');
		expect(onboardingTool.parametersJsonSchema.properties).not.toHaveProperty('password');
		expect(onboardingTool.parametersJsonSchema.properties).not.toHaveProperty('communication_style');
	});

	it('acepta horarios en onboarding y documenta el horario predeterminado', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, onboardingEnabled: true },
		});
		expect(prompt).toContain('Solicita únicamente estos cuatro bloques');
		expect(prompt).toContain('business_hours');
		expect(prompt).toContain('apertura igual o posterior al cierre');
	});

	it('mantiene el onboarding breve y no pregunta por datos adicionales', () => {
		const prompt = buildSystemPrompt({
			settings: { ...DEFAULT_BUSINESS_SETTINGS, onboardingEnabled: true },
		});
		expect(prompt).toContain('nombre del negocio, nombre de usuario, horario de atención y servicio');
		expect(prompt).toContain('Nunca vuelvas a pedir, confirmar de forma aislada ni explicar un dato');
		expect(prompt).toContain('No sugieras ni preguntes por dirección');
		expect(prompt).toContain('Si el usuario ofrece espontáneamente información adicional');
		expect(prompt).not.toContain('Indica que puede adjuntar un PDF');
	});
});
