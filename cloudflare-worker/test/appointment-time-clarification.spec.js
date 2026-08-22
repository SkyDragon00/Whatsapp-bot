import { describe, expect, it } from 'vitest';
import {
	buildAmbiguousHourReply,
	findAmbiguousAppointmentHour,
} from '../src/domain/appointment-time-clarification.js';
import { DEFAULT_BUSINESS_HOURS } from '../src/config/constants.js';

describe('aclaración de horas de citas', () => {
	it.each([
		['Dame a las 9, a nombre de Bob Patiño', '09:00'],
		['Quiero para la 1:30', '01:30'],
		['9', '09:00'],
	])('detecta una hora ambigua en %s', (text, expected) => {
		expect(findAmbiguousAppointmentHour(text)).toBe(expected);
	});

	it.each([
		'Dame a las 9 AM',
		'Dame a las 9 pm',
		'Dame a las 9 de la mañana',
		'Dame a las 9 de la noche',
		'Dame a las 21:00',
	])('no bloquea una hora inequívoca en %s', (text) => {
		expect(findAmbiguousAppointmentHour(text)).toBeNull();
	});

	it('pregunta AM o PM e informa el horario real del local', () => {
		const reply = buildAmbiguousHourReply('Dame a las 9, a nombre de Bob Patiño', DEFAULT_BUSINESS_HOURS);
		expect(reply).toContain('¿Te refieres a las 9:00 AM o 9:00 PM?');
		expect(reply).toContain('lunes de 09:00 a 17:00');
		expect(reply).toContain('domingo cerrado');
	});
});
