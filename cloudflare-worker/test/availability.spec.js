import { describe, expect, it } from 'vitest';
import { findAvailableSlots, intervalsOverlap, validateAppointmentWindow } from '../src/domain/availability.js';
import { zonedDateTimeToUtc } from '../src/domain/datetime.js';

function settings(overrides = {}) {
	return {
		appointmentDurationMinutes: 60,
		businessTimezone: 'America/Guayaquil',
		slotIntervalMinutes: 15,
		closedDates: [],
		businessHours: [
			{ day: 0, enabled: false, start: '09:00', end: '17:00' },
			{ day: 1, enabled: true, start: '09:00', end: '17:00' },
			{ day: 2, enabled: true, start: '09:00', end: '17:00' },
			{ day: 3, enabled: true, start: '09:00', end: '17:00' },
			{ day: 4, enabled: true, start: '09:00', end: '17:00' },
			{ day: 5, enabled: true, start: '09:00', end: '17:00' },
			{ day: 6, enabled: false, start: '09:00', end: '17:00' },
		],
		...overrides,
	};
}

const now = new Date('2026-07-14T00:00:00.000Z');

describe('zona horaria y horario comercial', () => {
	it('convierte una hora local de Guayaquil a UTC', () => {
		expect(zonedDateTimeToUtc('2026-07-20', '09:00', 'America/Guayaquil')).toBe('2026-07-20T14:00:00.000Z');
	});

	it('acepta una cita dentro del horario abierto', () => {
		const result = validateAppointmentWindow({
			startAt: '2026-07-20T14:00:00.000Z',
			endAt: '2026-07-20T15:00:00.000Z',
			settings: settings(),
			now,
		});
		expect(result.ok).toBe(true);
	});

	it('rechaza una cita que termina despues del cierre', () => {
		const result = validateAppointmentWindow({
			startAt: '2026-07-20T21:30:00.000Z',
			endAt: '2026-07-20T22:30:00.000Z',
			settings: settings(),
			now,
		});
		expect(result).toMatchObject({ ok: false, reason: 'outside_hours' });
	});

	it('rechaza inicios fuera de la cuadricula configurada', () => {
		const result = validateAppointmentWindow({
			startAt: '2026-07-20T14:10:00.000Z',
			endAt: '2026-07-20T15:10:00.000Z',
			settings: settings(),
			now,
		});
		expect(result).toMatchObject({ ok: false, reason: 'unaligned_slot' });
	});

	it('rechaza un dia semanal sin atencion y una fecha cerrada explicita', () => {
		const sunday = validateAppointmentWindow({
			startAt: '2026-07-19T14:00:00.000Z',
			endAt: '2026-07-19T15:00:00.000Z',
			settings: settings(),
			now,
		});
		const closedDate = validateAppointmentWindow({
			startAt: '2026-07-20T14:00:00.000Z',
			endAt: '2026-07-20T15:00:00.000Z',
			settings: settings({ closedDates: ['2026-07-20'] }),
			now,
		});
		expect(sunday.reason).toBe('closed_day');
		expect(closedDate.reason).toBe('closed_date');
	});

	it('aplica anticipacion minima y maximo de dias futuros', () => {
		const noticeSettings = settings({ minimumBookingNoticeMinutes: 60 });
		const slots = findAvailableSlots({
			dateFrom: '2026-07-20',
			serviceDurationMinutes: 30,
			settings: noticeSettings,
			now: new Date('2026-07-20T13:30:00.000Z'),
			maxSlots: 50,
		});
		expect(slots[0].local_time).toBe('09:30');

		const tooFar = findAvailableSlots({
			dateFrom: '2026-07-16',
			serviceDurationMinutes: 30,
			settings: settings({ maximumAdvanceBookingDays: 1 }),
			now,
			maxSlots: 50,
		});
		expect(tooFar).toEqual([]);
	});
});

describe('conflictos y disponibilidad', () => {
	it('detecta conflictos exactos y parciales', () => {
		const start = Date.parse('2026-07-20T14:00:00.000Z');
		const end = Date.parse('2026-07-20T15:00:00.000Z');
		expect(intervalsOverlap(start, end, start, end)).toBe(true);
		expect(intervalsOverlap(start, end, start - 30 * 60_000, start + 30 * 60_000)).toBe(true);
		expect(intervalsOverlap(start, end, end - 30 * 60_000, end + 30 * 60_000)).toBe(true);
	});

	it('permite citas consecutivas sin solapamiento', () => {
		const start = Date.parse('2026-07-20T14:00:00.000Z');
		const end = Date.parse('2026-07-20T15:00:00.000Z');
		expect(intervalsOverlap(start, end, end, end + 60 * 60_000)).toBe(false);
	});

	it('excluye todos los espacios que chocan parcial o totalmente con una cita', () => {
		const slots = findAvailableSlots({
			dateFrom: '2026-07-20',
			serviceDurationMinutes: 60,
			settings: settings(),
			appointments: [
				{
					status: 'confirmed',
					start_at: '2026-07-20T15:00:00.000Z',
					end_at: '2026-07-20T16:00:00.000Z',
				},
			],
			now,
			maxSlots: 50,
		});

		expect(slots.some((slot) => slot.local_time === '09:15')).toBe(false);
		expect(slots.some((slot) => slot.local_time === '10:00')).toBe(false);
		expect(slots.some((slot) => slot.local_time === '11:00')).toBe(true);
	});

	it('respeta la duracion propia de cada servicio', () => {
		const shortSlots = findAvailableSlots({
			dateFrom: '2026-07-20',
			serviceDurationMinutes: 30,
			settings: settings(),
			now,
			maxSlots: 50,
		});
		const longSlots = findAvailableSlots({
			dateFrom: '2026-07-20',
			serviceDurationMinutes: 120,
			settings: settings(),
			now,
			maxSlots: 50,
		});

		expect(shortSlots.length).toBeGreaterThan(longSlots.length);
		expect(longSlots.at(-1).local_time).toBe('15:00');
	});

	it('filtra periodos usando la hora local del negocio', () => {
		const periodSettings = settings({
			slotIntervalMinutes: 60,
			businessHours: settings().businessHours.map((day) =>
				day.day === 1 ? { ...day, start: '09:00', end: '20:00' } : day,
			),
		});
		const morning = findAvailableSlots({
			dateFrom: '2026-07-20',
			period: 'mañana',
			serviceDurationMinutes: 60,
			settings: periodSettings,
			now,
			maxSlots: 50,
		});
		const afternoon = findAvailableSlots({
			dateFrom: '2026-07-20',
			period: 'tarde',
			serviceDurationMinutes: 60,
			settings: periodSettings,
			now,
			maxSlots: 50,
		});

		expect(morning.map((slot) => slot.local_time)).toEqual(['09:00', '10:00', '11:00']);
		expect(afternoon.map((slot) => slot.local_time)).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
	});
});
