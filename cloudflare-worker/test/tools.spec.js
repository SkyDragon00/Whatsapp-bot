import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeToolSafely } from '../src/ai/tools.js';
import { saveBusinessSettings } from '../src/repositories/settings-repository.js';
import { createService } from '../src/repositories/services-repository.js';

const now = new Date('2026-07-14T00:00:00.000Z');
let service;

const context = () => ({
	env,
	now,
	telegram: { userId: '7001', chatId: '8001', username: 'cliente' },
	sourceUpdateId: 'telegram:update:phase3-test',
});

describe.sequential('herramientas controladas del backend', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM appointments'),
			env.DB.prepare('DELETE FROM payments'),
			env.DB.prepare('DELETE FROM expenses'),
			env.DB.prepare('DELETE FROM services'),
			env.DB.prepare('DELETE FROM settings'),
		]);
		await saveBusinessSettings(env.DB, {
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
		});
		service = await createService(env.DB, {
			name: 'Servicio Fase 3',
			duration_minutes: 60,
			price_cents: 2000,
			enabled: true,
		});
	});

	it('busca espacios usando D1 y la zona horaria configurada', async () => {
		const result = await executeToolSafely(
			'find_available_slots',
			{ service_id: service.id, date: '2026-07-20', period: 'mañana' },
			context(),
		);

		expect(result.ok).toBe(true);
		expect(result.data.service.id).toBe(service.id);
		expect(result.data.slots[0]).toMatchObject({
			local_date: '2026-07-20',
			local_time: '09:00',
			start_at: '2026-07-20T14:00:00.000Z',
		});
	});

	it('consulta directamente una hora exacta aunque no aparezca entre los primeros espacios', async () => {
		const result = await executeToolSafely(
			'find_available_slots',
			{ service_id: service.id, date: '2026-07-20', time: '15:00' },
			context(),
		);

		expect(result).toMatchObject({
			ok: true,
			data: {
				slots: [{ local_date: '2026-07-20', local_time: '15:00', start_at: '2026-07-20T20:00:00.000Z' }],
			},
		});
	});

	it('usa inmediatamente el horario y las preferencias guardadas por la API', async () => {
		const response = await SELF.fetch('http://localhost/api/settings', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				appointmentDurationMinutes: 60,
				businessTimezone: 'America/Guayaquil',
				slotIntervalMinutes: 15,
				minimumBookingNoticeMinutes: 0,
				maximumAdvanceBookingDays: 31,
				closedDates: [],
				businessHours: [
					{ day: 0, enabled: false, start: '09:00', end: '17:00' },
					{ day: 1, enabled: true, start: '10:00', end: '17:00' },
					{ day: 2, enabled: true, start: '09:00', end: '17:00' },
					{ day: 3, enabled: true, start: '09:00', end: '17:00' },
					{ day: 4, enabled: true, start: '09:00', end: '17:00' },
					{ day: 5, enabled: true, start: '09:00', end: '17:00' },
					{ day: 6, enabled: false, start: '09:00', end: '17:00' },
				],
				businessProfile: { businessName: 'Estetica D1', acceptedPaymentMethods: ['Efectivo'] },
			}),
		});
		expect(response.status).toBe(200);

		const availability = await executeToolSafely(
			'find_available_slots',
			{ service_id: service.id, date: '2026-07-20' },
			context(),
		);
		expect(availability.data.slots[0].local_time).toBe('10:00');

		const settingsResult = await executeToolSafely('get_business_settings', {}, context());
		expect(settingsResult.data.businessProfile).toMatchObject({
			businessName: 'Estetica D1',
			acceptedPaymentMethods: ['Efectivo'],
		});
	});

	it('inyecta la identidad de Telegram al crear una cita', async () => {
		const result = await executeToolSafely(
			'create_appointment',
			{
				customer_name: 'Cliente Herramienta',
				service_id: service.id,
				start_datetime: '2026-07-20T14:00:00.000Z',
			},
			context(),
		);

		expect(result.ok).toBe(true);
		const stored = await env.DB.prepare('SELECT * FROM appointments WHERE id = ?1').bind(result.data.appointment.id).first();
		expect(stored).toMatchObject({ telegram_user_id: '7001', telegram_chat_id: '8001' });
		const response = await SELF.fetch('http://localhost/api/appointments');
		const appointments = await response.json();
		expect(appointments).toEqual([
			expect.objectContaining({ id: result.data.appointment.id, origin: 'telegram' }),
		]);
	});

	it('rechaza argumentos adicionales aunque Gemini los genere', async () => {
		const result = await executeToolSafely(
			'create_appointment',
			{
				customer_name: 'Cliente Herramienta',
				service_id: service.id,
				start_datetime: '2026-07-20T14:00:00.000Z',
				telegram_user_id: 'usuario-falso',
			},
			context(),
		);

		expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(0);
	});

	it('rechaza identificadores de servicio ambiguos', async () => {
		const result = await executeToolSafely(
			'find_available_slots',
			{ service_id: service.id, service_name: service.name, date: '2026-07-20' },
			context(),
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
	});

	it('impide registrar pagos en modo cliente', async () => {
		const result = await executeToolSafely('register_payment', {
			payment_date: '2026-07-14',
			customer_name: 'Cliente Uno',
			amount: 25.5,
			payment_method: 'Efectivo',
		}, context());

		expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM payments').first('count')).toBe(0);
	});

	it('registra pagos con trazabilidad de Telegram en modo dueño', async () => {
		const current = await (await SELF.fetch('http://localhost/api/settings')).json();
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const result = await executeToolSafely('register_payment', {
			payment_date: '2026-07-14',
			customer_name: 'Cliente Dos',
			amount: 40,
			payment_method: 'Transferencia',
			notes: 'Abono',
		}, context());

		expect(result).toMatchObject({
			ok: true,
			data: { payment: { customer_name: 'Cliente Dos', amount: 40, payment_method: 'Transferencia' } },
		});
		const stored = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(result.data.payment.id).first();
		expect(stored).toMatchObject({ telegram_user_id: '7001', telegram_chat_id: '8001', source_update_id: 'telegram:update:phase3-test' });
	});

});
