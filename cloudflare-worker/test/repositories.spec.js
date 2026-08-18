import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentConflictError, AppointmentOwnershipError } from '../src/domain/errors.js';
import {
	cancelAppointmentAsAdmin,
	cancelAppointment,
	createAppointment,
	getCustomerAppointments,
	rescheduleAppointmentAsAdmin,
} from '../src/repositories/appointments-repository.js';
import { saveBusinessSettings } from '../src/repositories/settings-repository.js';
import { createService } from '../src/repositories/services-repository.js';

const testNow = new Date('2026-07-14T00:00:00.000Z');
let service;

function businessSettings() {
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
	};
}

function appointmentInput(overrides = {}) {
	return {
		telegram_user_id: '1001',
		telegram_chat_id: '2001',
		telegram_username: 'cliente_demo',
		customer_name: 'Cliente Demo',
		service_id: service.id,
		start_datetime: '2026-07-20T14:00:00.000Z',
		phone: '+593999999999',
		source_update_id: 'update-1',
		...overrides,
	};
}

describe.sequential('repositorios D1', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM appointments'),
			env.DB.prepare('DELETE FROM services'),
			env.DB.prepare('DELETE FROM settings'),
		]);
		await saveBusinessSettings(env.DB, businessSettings());
		service = await createService(env.DB, {
			name: 'Corte de prueba',
			description: 'Servicio usado por las pruebas.',
			duration_minutes: 60,
			price_cents: 1500,
			enabled: true,
		});
	});

	it('crea una cita valida y conserva los campos heredados', async () => {
		const created = await createAppointment(env.DB, appointmentInput(), { now: testNow });

		expect(created).toMatchObject({
			telegram_user_id: '1001',
			patient_name: 'Cliente Demo',
			service: 'Corte de prueba',
			service_name: 'Corte de prueba',
			date_iso: '2026-07-20T14:00:00.000Z',
			start_at: '2026-07-20T14:00:00.000Z',
			end_at: '2026-07-20T15:00:00.000Z',
			status: 'confirmed',
		});
	});

	it('permite el mismo nombre de cliente en empresas diferentes', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const firstCompany = await env.DB.prepare('INSERT INTO companies (name) VALUES (?1) RETURNING id')
			.bind(`Empresa A ${suffix}`).first();
		const secondCompany = await env.DB.prepare('INSERT INTO companies (name) VALUES (?1) RETURNING id')
			.bind(`Empresa B ${suffix}`).first();
		await Promise.all([
			saveBusinessSettings(env.DB, businessSettings(), { companyId: firstCompany.id }),
			saveBusinessSettings(env.DB, businessSettings(), { companyId: secondCompany.id }),
		]);
		const firstService = await createService(env.DB, {
			name: `Masaje A ${suffix}`, duration_minutes: 60, price_cents: 2000, enabled: true,
		}, { companyId: firstCompany.id });
		const secondService = await createService(env.DB, {
			name: `Masaje B ${suffix}`, duration_minutes: 60, price_cents: 2000, enabled: true,
		}, { companyId: secondCompany.id });

		const first = await createAppointment(env.DB, appointmentInput({
			customer_name: 'Patricio Estrella', service_id: firstService.id, source_update_id: `company-a-${suffix}`,
		}), { now: testNow, companyId: firstCompany.id });
		const second = await createAppointment(env.DB, appointmentInput({
			customer_name: 'Patricio Estrella', service_id: secondService.id, source_update_id: `company-b-${suffix}`,
		}), { now: testNow, companyId: secondCompany.id });

		expect(first.customer_id).not.toBe(second.customer_id);
		const customers = await env.DB.prepare(
			"SELECT company_id FROM customers WHERE full_name = 'Patricio Estrella' ORDER BY company_id",
		).all();
		expect(customers.results.map((customer) => customer.company_id)).toEqual([firstCompany.id, secondCompany.id]);
	});

	it('acepta IDs largos de mensajes de WhatsApp como clave de idempotencia', async () => {
		const sourceUpdateId = `whatsapp:wamid.${'A'.repeat(180)}`;
		const created = await createAppointment(
			env.DB,
			appointmentInput({ source_update_id: sourceUpdateId }),
			{ now: testNow },
		);
		const retry = await createAppointment(
			env.DB,
			appointmentInput({ source_update_id: sourceUpdateId }),
			{ now: testNow },
		);

		expect(created.source_update_id).toBe(sourceUpdateId);
		expect(retry.id).toBe(created.id);
	});

	it('rechaza un intento de doble reserva', async () => {
		await createAppointment(env.DB, appointmentInput(), { now: testNow });

		await expect(
			createAppointment(
				env.DB,
				appointmentInput({ telegram_user_id: '1002', source_update_id: 'update-2' }),
				{ now: testNow },
			),
		).rejects.toBeInstanceOf(AppointmentConflictError);
	});

	it('permite una cita consecutiva que empieza al terminar la anterior', async () => {
		await createAppointment(env.DB, appointmentInput(), { now: testNow });
		const consecutive = await createAppointment(
			env.DB,
			appointmentInput({ start_datetime: '2026-07-20T15:00:00.000Z', source_update_id: 'update-2' }),
			{ now: testNow },
		);

		expect(consecutive.start_at).toBe('2026-07-20T15:00:00.000Z');
	});

	it('el trigger de D1 bloquea solapamientos aunque se omita el repositorio', async () => {
		await createAppointment(env.DB, appointmentInput(), { now: testNow });

		await expect(
			env.DB
				.prepare(
					`INSERT INTO appointments (
						telegram_user_id, telegram_chat_id, patient_name, service, date_text, date_iso,
						service_id, service_name, start_at, end_at, status, updated_at
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'confirmed', ?11)`,
				)
				.bind(
					'1002',
					'2002',
					'Otro Cliente',
					service.name,
					'2026-07-20 09:30',
					'2026-07-20T14:30:00.000Z',
					service.id,
					service.name,
					'2026-07-20T14:30:00.000Z',
					'2026-07-20T15:30:00.000Z',
					testNow.toISOString(),
				)
				.run(),
		).rejects.toThrow(/appointment_overlap/);
	});

	it('reutiliza la cita cuando se repite el mismo update de origen', async () => {
		const first = await createAppointment(env.DB, appointmentInput(), { now: testNow });
		const retry = await createAppointment(env.DB, appointmentInput(), { now: testNow });

		expect(retry.id).toBe(first.id);
		const appointments = await getCustomerAppointments(env.DB, '1001');
		expect(appointments).toHaveLength(1);
	});

	it('hace idempotentes dos creaciones concurrentes del mismo update', async () => {
		const [first, second] = await Promise.all([
			createAppointment(env.DB, appointmentInput(), { now: testNow }),
			createAppointment(env.DB, appointmentInput(), { now: testNow }),
		]);

		expect(second.id).toBe(first.id);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(1);
	});

	it('permite solo una de dos reservas simultaneas distintas para el mismo horario', async () => {
		const attempts = await Promise.allSettled([
			createAppointment(env.DB, appointmentInput({ source_update_id: 'concurrent-1' }), { now: testNow }),
			createAppointment(
				env.DB,
				appointmentInput({ telegram_user_id: '1002', source_update_id: 'concurrent-2' }),
				{ now: testNow },
			),
		]);
		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(1);
	});

	it('usa exactamente la duracion de 90 minutos del servicio', async () => {
		const longService = await createService(env.DB, {
			name: 'Servicio largo',
			duration_minutes: 90,
			enabled: true,
		});
		const created = await createAppointment(
			env.DB,
			appointmentInput({ service_id: longService.id, source_update_id: 'long-service' }),
			{ now: testNow },
		);
		expect(created.end_at).toBe('2026-07-20T15:30:00.000Z');
	});

	it('conserva el instante UTC al cambiar la zona horaria del negocio', async () => {
		await saveBusinessSettings(env.DB, {
			...businessSettings(),
			businessTimezone: 'America/New_York',
		});
		const created = await createAppointment(
			env.DB,
			appointmentInput({ start_datetime: '2026-07-20T13:00:00.000Z', source_update_id: 'timezone-change' }),
			{ now: testNow },
		);
		expect(created.start_at).toBe('2026-07-20T13:00:00.000Z');
		expect(created.end_at).toBe('2026-07-20T14:00:00.000Z');
	});

	it('impide reservar un servicio deshabilitado', async () => {
		await env.DB.prepare('UPDATE services SET enabled = 0 WHERE id = ?1').bind(service.id).run();
		await expect(createAppointment(env.DB, appointmentInput(), { now: testNow })).rejects.toThrow(/deshabilitado/);
	});

	it('reprograma validando otra vez horario y conflictos', async () => {
		const first = await createAppointment(env.DB, appointmentInput(), { now: testNow });
		await createAppointment(
			env.DB,
			appointmentInput({
				telegram_user_id: '1002',
				start_datetime: '2026-07-20T16:00:00.000Z',
				source_update_id: 'occupied-reschedule',
			}),
			{ now: testNow },
		);

		await expect(
			rescheduleAppointmentAsAdmin(env.DB, {
				appointmentId: first.id,
				startAt: '2026-07-20T16:30:00.000Z',
				now: testNow,
			}),
		).rejects.toBeInstanceOf(AppointmentConflictError);

		const updated = await rescheduleAppointmentAsAdmin(env.DB, {
			appointmentId: first.id,
			startAt: '2026-07-20T17:00:00.000Z',
			now: testNow,
		});
		expect(updated).toMatchObject({
			start_at: '2026-07-20T17:00:00.000Z',
			end_at: '2026-07-20T18:00:00.000Z',
			status: 'confirmed',
		});
	});

	it('cancela administrativamente sin eliminar la fila', async () => {
		const created = await createAppointment(env.DB, appointmentInput(), { now: testNow });
		const cancelled = await cancelAppointmentAsAdmin(env.DB, { appointmentId: created.id, now: testNow });
		expect(cancelled.status).toBe('cancelled');
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(1);
	});

	it('impide cancelar una cita perteneciente a otro usuario', async () => {
		const created = await createAppointment(env.DB, appointmentInput(), { now: testNow });

		await expect(
			cancelAppointment(env.DB, {
				appointmentId: created.id,
				telegramUserId: '9999',
				now: testNow,
			}),
		).rejects.toBeInstanceOf(AppointmentOwnershipError);

		const stored = await env.DB.prepare('SELECT status FROM appointments WHERE id = ?1').bind(created.id).first();
		expect(stored.status).toBe('confirmed');
	});
});
