import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withAdminProtection } from '../src/middleware/admin.js';
import { createAppointment } from '../src/repositories/appointments-repository.js';
import { saveBusinessSettings } from '../src/repositories/settings-repository.js';
import { createService } from '../src/repositories/services-repository.js';

const LOCAL_API = 'http://localhost/api';
let service;

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

describe.sequential('API administrativa', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM appointments'),
			env.DB.prepare('DELETE FROM services'),
			env.DB.prepare('DELETE FROM settings'),
		]);
		await saveBusinessSettings(env.DB, settings());
		service = await createService(env.DB, {
			name: 'Corte clasico',
			description: 'Corte de prueba',
			duration_minutes: 45,
			price_cents: 1250,
			enabled: true,
		});
	});

	it('consulta y actualiza la configuracion completa', async () => {
		const initialResponse = await SELF.fetch(`${LOCAL_API}/settings`);
		expect(initialResponse.status).toBe(200);
		expect(await initialResponse.json()).toMatchObject({
			businessTimezone: 'America/Guayaquil',
			slotIntervalMinutes: 15,
		});

		const updateResponse = await SELF.fetch(`${LOCAL_API}/settings`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(settings({ slotIntervalMinutes: 30, closedDates: ['2026-12-25'] })),
		});
		expect(updateResponse.status).toBe(200);
		expect(await updateResponse.json()).toMatchObject({ slotIntervalMinutes: 30, closedDates: ['2026-12-25'] });
	});

	it('lista, crea y actualiza servicios con precio decimal', async () => {
		const listResponse = await SELF.fetch(`${LOCAL_API}/services`);
		const initialServices = await listResponse.json();
		expect(initialServices[0]).toMatchObject({ name: 'Corte clasico', price: 12.5, enabled: true });

		const createResponse = await SELF.fetch(`${LOCAL_API}/services`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Barba', duration_minutes: 30, price: 8.75, enabled: true }),
		});
		expect(createResponse.status).toBe(201);
		const created = await createResponse.json();
		expect(created).toMatchObject({ price_cents: 875, price: 8.75, enabled: true });

		const updateResponse = await SELF.fetch(`${LOCAL_API}/services/${created.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ duration_minutes: 40, enabled: false }),
		});
		expect(updateResponse.status).toBe(200);
		expect(await updateResponse.json()).toMatchObject({ duration_minutes: 40, enabled: false });
	});

	it('rechaza campos arbitrarios en servicios', async () => {
		const response = await SELF.fetch(`${LOCAL_API}/services`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Invalido', duration_minutes: 30, sql: 'DROP TABLE services' }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
	});

	it('mantiene los aliases que consume el calendario heredado', async () => {
		await createAppointment(
			env.DB,
			{
				telegram_user_id: '1001',
				telegram_chat_id: '2001',
				telegram_username: 'cliente',
				customer_name: 'Cliente API',
				service_id: service.id,
				start_datetime: '2026-07-20T14:00:00.000Z',
				source_update_id: 'api-update-1',
			},
			{ now: new Date('2026-07-14T00:00:00.000Z') },
		);

		const response = await SELF.fetch(`${LOCAL_API}/appointments`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			expect.objectContaining({
				customer_name: 'Cliente API',
				patient_name: 'Cliente API',
				service_name: 'Corte clasico',
				service: 'Corte clasico',
				start_at: '2026-07-20T14:00:00.000Z',
				date_iso: '2026-07-20T14:00:00.000Z',
				end_at: '2026-07-20T14:45:00.000Z',
			}),
		]);
	});

	it('reprograma y cancela mediante endpoints administrativos validados', async () => {
		const created = await createAppointment(
			env.DB,
			{
				telegram_user_id: '1001',
				telegram_chat_id: '2001',
				customer_name: 'Cliente Admin',
				service_id: service.id,
				start_datetime: '2026-07-20T14:00:00.000Z',
				source_update_id: 'admin-actions',
			},
			{ now: new Date('2026-07-14T00:00:00.000Z') },
		);

		const rescheduledResponse = await SELF.fetch(`${LOCAL_API}/appointments/${created.id}/reschedule`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ start_at: '2026-07-20T15:00:00.000Z' }),
		});
		expect(rescheduledResponse.status).toBe(200);
		expect(await rescheduledResponse.json()).toMatchObject({
			start_at: '2026-07-20T15:00:00.000Z',
			end_at: '2026-07-20T15:45:00.000Z',
		});

		const cancelResponse = await SELF.fetch(`${LOCAL_API}/appointments/${created.id}/cancel`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(cancelResponse.status).toBe(200);
		expect(await cancelResponse.json()).toMatchObject({ status: 'cancelled' });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(1);
	});

	it('permite CORS local sin usar wildcard', async () => {
		const response = await SELF.fetch(`${LOCAL_API}/settings`, {
			headers: { Origin: 'http://localhost:3000' },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
		expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
	});

	it('permite el mismo origen publicado sin abrir CORS a terceros', async () => {
		const request = new Request('https://worker.example/api/settings', {
			headers: { Origin: 'https://worker.example', Authorization: 'Bearer test-admin-token' },
		});
		const response = await withAdminProtection(
			request,
			{ ADMIN_API_TOKEN: 'test-admin-token' },
			async () => new Response('ok'),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://worker.example');
	});

	it('responde el preflight local y bloquea origenes no autorizados', async () => {
		const preflight = await SELF.fetch(`${LOCAL_API}/settings`, {
			method: 'OPTIONS',
			headers: { Origin: 'http://127.0.0.1:5500', 'Access-Control-Request-Method': 'PUT' },
		});
		expect(preflight.status).toBe(204);

		const denied = await SELF.fetch(`${LOCAL_API}/settings`, {
			headers: { Origin: 'https://evil.example' },
		});
		expect(denied.status).toBe(403);
		expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	it('falla cerrado fuera de localhost cuando no hay autenticacion configurada', async () => {
		const response = await withAdminProtection(
			new Request('https://worker.example/api/settings'),
			{},
			async () => new Response('ok'),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: 'ADMIN_AUTH_REQUIRED' });
	});

	it('autoriza un entorno publicado con token y origen configurados', async () => {
		const request = new Request('https://worker.example/api/settings', {
			headers: { Origin: 'https://admin.example', Authorization: 'Bearer test-admin-token' },
		});
		const response = await withAdminProtection(
			request,
			{ ADMIN_API_TOKEN: 'test-admin-token', ADMIN_ALLOWED_ORIGINS: 'https://admin.example' },
			async () => new Response('ok'),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example');
	});

	it('rechaza un token administrativo incorrecto', async () => {
		const request = new Request('https://worker.example/api/settings', {
			headers: { Authorization: 'Bearer incorrecto' },
		});
		const response = await withAdminProtection(
			request,
			{ ADMIN_API_TOKEN: 'test-admin-token' },
			async () => new Response('ok'),
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
	});
});
