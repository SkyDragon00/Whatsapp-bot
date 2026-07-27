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

function textPdfBase64(text) {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xrefOffset = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
	return btoa(pdf);
}

describe.sequential('API administrativa', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM payments'),
			env.DB.prepare('DELETE FROM appointments'),
			env.DB.prepare('DELETE FROM customers'),
			env.DB.prepare('DELETE FROM ai_knowledge_documents'),
			env.DB.prepare('DELETE FROM expenses'),
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

	it('administra documentos de referencia para la IA', async () => {
		const createResponse = await SELF.fetch(`${LOCAL_API}/ai-documents`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'preguntas-frecuentes.md',
				mimeType: 'text/markdown',
				content: 'La garantia tiene una vigencia de 30 dias.',
			}),
		});
		expect(createResponse.status).toBe(201);
		const created = await createResponse.json();
		expect(created).toMatchObject({ name: 'preguntas-frecuentes.md', mime_type: 'text/markdown' });

		const listResponse = await SELF.fetch(`${LOCAL_API}/ai-documents`);
		expect(await listResponse.json()).toEqual([expect.objectContaining({ id: created.id, size_bytes: expect.any(Number) })]);

		const deleteResponse = await SELF.fetch(`${LOCAL_API}/ai-documents/${created.id}`, { method: 'DELETE' });
		expect(deleteResponse.status).toBe(200);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM ai_knowledge_documents').first('count')).toBe(0);
	});

	it('extrae y guarda el texto de documentos PDF', async () => {
		const response = await SELF.fetch(`${LOCAL_API}/ai-documents`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'manual.pdf',
				mimeType: 'application/pdf',
				content: textPdfBase64('Garantia PDF de 90 dias'),
			}),
		});
		expect(response.status).toBe(201);
		const created = await response.json();
		expect(created).toMatchObject({ name: 'manual.pdf', mime_type: 'application/pdf' });
		const stored = await env.DB.prepare('SELECT content FROM ai_knowledge_documents WHERE id = ?1').bind(created.id).first();
		expect(stored.content).toContain('Garantia PDF de 90 dias');
		await SELF.fetch(`${LOCAL_API}/ai-documents/${created.id}`, { method: 'DELETE' });
	});

	it('rechaza documentos vacios, no soportados, PDF invalidos o demasiado grandes', async () => {
		for (const body of [
			{ name: 'vacio.txt', mimeType: 'text/plain', content: '' },
			{ name: 'manual.exe', mimeType: 'application/octet-stream', content: 'datos' },
			{ name: 'manual.pdf', mimeType: 'application/pdf', content: btoa('no es un PDF') },
			{ name: 'grande.txt', mimeType: 'text/plain', content: 'x'.repeat(100_001) },
		]) {
			const response = await SELF.fetch(`${LOCAL_API}/ai-documents`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
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

	it('registra, lista y elimina gastos con sus datos completos', async () => {
		const createResponse = await SELF.fetch(`${LOCAL_API}/expenses`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				expense_date: '2026-07-15',
				description: 'Compra de insumos',
				category: 'Insumos',
				supplier: 'Proveedor local',
				amount: 42.75,
				payment_method: 'Transferencia',
				document_type: 'Factura',
				document_number: '001-001-000012345',
				notes: 'Material para la semana',
			}),
		});
		expect(createResponse.status).toBe(201);
		const created = await createResponse.json();
		expect(created).toMatchObject({
			expense_date: '2026-07-15',
			description: 'Compra de insumos',
			category: 'Insumos',
			supplier: 'Proveedor local',
			amount_cents: 4275,
			amount: 42.75,
			payment_method: 'Transferencia',
			document_type: 'Factura',
			document_number: '001-001-000012345',
			notes: 'Material para la semana',
		});

		const listResponse = await SELF.fetch(`${LOCAL_API}/expenses`);
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toEqual([expect.objectContaining({ id: created.id, amount: 42.75 })]);

		const deleteResponse = await SELF.fetch(`${LOCAL_API}/expenses/${created.id}`, { method: 'DELETE' });
		expect(deleteResponse.status).toBe(200);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM expenses').first('count')).toBe(0);
	});

	it('rechaza gastos con monto, fecha o campos no validos', async () => {
		for (const body of [
			{ expense_date: '2026-02-30', description: 'Gasto inválido', category: 'Otros', amount: 10, payment_method: 'Efectivo' },
			{ expense_date: '2026-07-15', description: 'Gasto inválido', category: 'Otros', amount: 0, payment_method: 'Efectivo' },
			{ expense_date: '2026-07-15', description: 'Gasto inválido', category: 'Otros', amount: 10, payment_method: 'Efectivo', sql: 'DROP TABLE expenses' },
		]) {
			const response = await SELF.fetch(`${LOCAL_API}/expenses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
		}
	});

	it('resume ingresos, gastos, servicios y clientes con pagos pendientes', async () => {
		const appointment = await env.DB.prepare(
			`INSERT INTO appointments (
				telegram_user_id, telegram_chat_id, patient_name, service, service_id, service_name,
				date_text, date_iso, start_at, end_at, status, created_at, customer_id
			 ) VALUES ('100', '100', 'Ana Pérez', ?1, ?2, ?1, '2026-07-15 10:00',
			 '2026-07-15T15:00:00.000Z', '2026-07-15T15:00:00.000Z', '2026-07-15T15:45:00.000Z',
			 'completed', CURRENT_TIMESTAMP, NULL) RETURNING id`,
		).bind(service.name, service.id).first();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO payments (
					appointment_id, payment_date, customer_name, amount_cents, payment_method,
					telegram_user_id, telegram_chat_id
				 ) VALUES (?1, '2026-07-15', 'Ana Pérez', 500, 'Efectivo', '100', '100')`,
			).bind(appointment.id),
			env.DB.prepare(
				`INSERT INTO expenses (
					expense_date, description, category, amount_cents, payment_method
				 ) VALUES ('2026-07-16', 'Insumos', 'Insumos', 300, 'Efectivo')`,
			),
		]);

		const response = await SELF.fetch(`${LOCAL_API}/dashboard?from=2026-07-01&to=2026-07-31`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			summary: {
				income_cents: 500,
				expenses_cents: 300,
				profit_cents: 200,
				outstanding_cents: 750,
				services_count: 1,
				unpaid_people: 1,
			},
			service_breakdown: [expect.objectContaining({ service_name: 'Corte clasico', appointments: 1 })],
			daily_activity: [
				{ date: '2026-07-15', income_cents: 500, expenses_cents: 0 },
				{ date: '2026-07-16', income_cents: 0, expenses_cents: 300 },
			],
			unpaid: [expect.objectContaining({ customer_name: 'Ana Pérez', outstanding_cents: 750 })],
		});
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

	it('registra abonos por cita y calcula sin pagar, parcial y pagado', async () => {
		const appointment = await createAppointment(env.DB, {
			telegram_user_id: '7101', telegram_chat_id: '7201', customer_name: 'Cliente Pagos',
			service_id: service.id, start_datetime: '2026-07-20T14:00:00.000Z', source_update_id: 'appointment-payment',
		}, { now: new Date('2026-07-14T00:00:00.000Z') });

		let appointments = await (await SELF.fetch(`${LOCAL_API}/appointments`)).json();
		expect(appointments[0]).toMatchObject({ payment_status: 'unpaid', price_cents: 1250, paid_cents: 0 });

		const partialResponse = await SELF.fetch(`${LOCAL_API}/appointments/${appointment.id}/payment`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ payment_date: '2026-07-20', amount: 5, payment_method: 'Efectivo' }),
		});
		expect(partialResponse.status).toBe(201);
		expect(await partialResponse.json()).toMatchObject({ payment_status: 'partial', paid_cents: 500 });

		await SELF.fetch(`${LOCAL_API}/appointments/${appointment.id}/payment`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ payment_date: '2026-07-20', amount: 7.5, payment_method: 'Transferencia' }),
		});
		appointments = await (await SELF.fetch(`${LOCAL_API}/appointments`)).json();
		expect(appointments[0]).toMatchObject({ payment_status: 'paid', paid_cents: 1250 });

		const customer = await (await SELF.fetch(`${LOCAL_API}/customers/${appointment.customer_id}`)).json();
		expect(customer.appointments[0]).toMatchObject({ price_cents: 1250, paid_cents: 1250 });
	});

	it('crea clientes manualmente y conserva el historial creado desde Telegram', async () => {
		const manualResponse = await SELF.fetch(`${LOCAL_API}/customers`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				first_name: 'Ana María', last_name: 'Pérez López',
				cedula_ruc: '1712345678', address: 'Av. Principal 123', phone: '0991234567',
			}),
		});
		expect(manualResponse.status).toBe(201);
		expect(await manualResponse.json()).toMatchObject({
			full_name: 'Ana María Pérez López',
			cedula_ruc: '1712345678', address: 'Av. Principal 123', phone: '0991234567',
		});

		const appointment = await createAppointment(env.DB, {
			telegram_user_id: '3001', telegram_chat_id: '4001', telegram_username: 'ana',
			customer_name: 'Ana María Pérez López', service_id: service.id,
			start_datetime: '2026-07-20T14:00:00.000Z', source_update_id: 'customer-history',
		}, { now: new Date('2026-07-14T00:00:00.000Z') });
		expect(appointment.customer_id).toBeTypeOf('number');

		const customersResponse = await SELF.fetch(`${LOCAL_API}/customers`);
		const customers = await customersResponse.json();
		expect(customers).toEqual([expect.objectContaining({ full_name: 'Ana María Pérez López', appointment_count: 1 })]);

		const detailResponse = await SELF.fetch(`${LOCAL_API}/customers/${customers[0].id}`);
		expect(await detailResponse.json()).toMatchObject({
			telegram_username: 'ana',
			appointments: [expect.objectContaining({ id: appointment.id, service_name: 'Corte clasico' })],
		});
	});

	it('edita y elimina clientes sin borrar sus citas', async () => {
		const appointment = await createAppointment(env.DB, {
			telegram_user_id: '5001', telegram_chat_id: '6001', customer_name: 'Bob Esponja',
			service_id: service.id, start_datetime: '2026-07-20T14:00:00.000Z', source_update_id: 'customer-actions',
		}, { now: new Date('2026-07-14T00:00:00.000Z') });

		const updateResponse = await SELF.fetch(`${LOCAL_API}/customers/${appointment.customer_id}`, {
			method: 'PUT', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				first_name: 'Roberto', last_name: 'Esponja',
				cedula_ruc: '0999999999001', address: 'Fondo de Bikini', phone: '0987654321',
			}),
		});
		expect(updateResponse.status).toBe(200);
		expect(await updateResponse.json()).toMatchObject({
			full_name: 'Roberto Esponja', cedula_ruc: '0999999999001',
			address: 'Fondo de Bikini', phone: '0987654321',
		});
		expect(await env.DB.prepare('SELECT patient_name FROM appointments WHERE id = ?1').bind(appointment.id).first('patient_name')).toBe('Roberto Esponja');

		const deleteResponse = await SELF.fetch(`${LOCAL_API}/customers/${appointment.customer_id}`, { method: 'DELETE' });
		expect(deleteResponse.status).toBe(200);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM customers').first('count')).toBe(0);
		expect(await env.DB.prepare('SELECT customer_id FROM appointments WHERE id = ?1').bind(appointment.id).first('customer_id')).toBeNull();
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(1);
	});

	it('reprograma y cancela mediante endpoints administrativos validados', async () => {
		const created = await createAppointment(
			env.DB,
			{
				telegram_user_id: '1001',
				telegram_chat_id: '2001',
				customer_name: 'Cliente Admin',
				service_id: service.id,
				start_datetime: '2026-08-03T14:00:00.000Z',
				source_update_id: 'admin-actions',
			},
			{ now: new Date('2026-07-14T00:00:00.000Z') },
		);

		const rescheduledResponse = await SELF.fetch(`${LOCAL_API}/appointments/${created.id}/reschedule`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ start_at: '2026-08-03T15:00:00.000Z' }),
		});
		const rescheduledBody = await rescheduledResponse.json();
		expect(rescheduledBody).toMatchObject({
			start_at: '2026-08-03T15:00:00.000Z',
			end_at: '2026-08-03T15:45:00.000Z',
		});
		expect(rescheduledResponse.status).toBe(200);

		const cancelResponse = await SELF.fetch(`${LOCAL_API}/appointments/${created.id}/cancel`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		const cancelBody = await cancelResponse.json();
		expect(cancelBody).toMatchObject({ status: 'cancelled' });
		expect(cancelResponse.status).toBe(200);
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
