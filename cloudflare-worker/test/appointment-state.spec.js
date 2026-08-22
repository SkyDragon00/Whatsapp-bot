import { describe, expect, it } from 'vitest';
import { deriveAppointmentState } from '../src/conversation/appointment-state.js';

describe('estado persistente de una cita por chat', () => {
	it('conserva el nombre dado antes de aclarar AM o PM', () => {
		const firstState = deriveAppointmentState([], 'Ponle para las 9, a nombre de Bart Simpson');
		expect(firstState).toMatchObject({ customerName: 'Bart Simpson' });

		const history = [
			{ role: 'user', text: 'Ponle para las 9, a nombre de Bart Simpson' },
			{ role: 'model', text: '¿Te refieres a las 9:00 AM o 9:00 PM?' },
		];
		expect(deriveAppointmentState(history, 'AM', firstState)).toMatchObject({
			customerName: 'Bart Simpson',
		});
	});

	it('recupera todos los campos de un resumen y acepta una corrección posterior', () => {
		const summary = `Aquí tienes el resumen de la cita:
* **Cliente:** Bart Simpson
* **Servicio:** Corte Barba
* **Precio:** $5
* **Fecha:** 21 de agosto de 2026
* **Hora:** 09:00`;
		const state = deriveAppointmentState([{ role: 'model', text: summary }], 'Nombre: Lisa Simpson');
		expect(state).toEqual({
			customerName: 'Lisa Simpson',
			serviceName: 'Corte Barba',
			price: '$5',
			date: '21 de agosto de 2026',
			time: '09:00',
		});
	});

	it('entiende un nombre directo cuando el bot acaba de pedirlo', () => {
		const history = [{ role: 'model', text: '¿A qué nombre debo agendar la cita?' }];
		expect(deriveAppointmentState(history, 'Bart Simpson')).toMatchObject({
			customerName: 'Bart Simpson',
		});
	});
});
