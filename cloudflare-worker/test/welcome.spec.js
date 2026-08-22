import { describe, expect, it } from 'vitest';
import { addPaymentMediaReminder, buildClientWelcomeMessage, isPaymentRegistrationRequest } from '../src/conversation/welcome.js';

describe('mensajes iniciales por modo', () => {
	it('presenta todos los servicios activos al cliente', () => {
		const message = buildClientWelcomeMessage([{ name: 'Corte' }, { name: 'Barba' }]);
		expect(message).toContain('agendar una cita');
		expect(message).toContain('- Corte');
		expect(message).toContain('- Barba');
	});

	it('detecta solicitudes de registro de pagos', () => {
		expect(isPaymentRegistrationRequest('Quiero registrar un pago')).toBe(true);
		expect(isPaymentRegistrationRequest('Anota este abono')).toBe(true);
		expect(isPaymentRegistrationRequest('¿Quién tiene pagos pendientes?')).toBe(false);
	});

	it('recuerda al dueño que puede usar voz o imagen sin duplicarlo', () => {
		const result = addPaymentMediaReminder('¿De qué cliente es el pago?');
		expect(result).toContain('por voz');
		expect(result).toContain('con una imagen');
		expect(addPaymentMediaReminder(result)).toBe(result);
	});
});
