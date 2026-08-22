import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeToolSafely } from '../src/ai/tools.js';
import { toolDeclarationsForMode } from '../src/ai/tool-definitions.js';
import {
	getBotBusinessSettings,
	getBusinessSettings,
	getOnboardingCompanyId,
	saveBusinessSettings,
} from '../src/repositories/settings-repository.js';
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
			env.DB.prepare('DELETE FROM customers'),
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

	it('usa el servicio confirmado por nombre aunque Gemini envíe un ID incorrecto', async () => {
		const otherService = await createService(env.DB, {
			name: 'Mega relax', duration_minutes: 120, price_cents: 12000, enabled: true,
		});
		const result = await executeToolSafely('create_appointment', {
			customer_name: 'Pepe Juanes',
			service_id: 999999,
			start_datetime: '2026-07-20T14:00:00.000Z',
		}, {
			...context(),
			appointmentState: { serviceName: 'Mega relax' },
		});

		expect(result.ok).toBe(true);
		expect(result.data.appointment).toMatchObject({
			customer_name: 'Pepe Juanes', service_id: otherService.id, service_name: 'Mega relax',
		});
	});

	it('corrige una hora local que Gemini envió erróneamente como UTC', async () => {
		const result = await executeToolSafely(
			'create_appointment',
			{
				customer_name: 'Cliente Hora Local',
				service_id: service.id,
				start_datetime: '2026-07-20T09:00:00.000Z',
			},
			context(),
		);

		expect(result.ok).toBe(true);
		expect(result.data.appointment.start_at).toBe('2026-07-20T14:00:00.000Z');
	});

	it('bloquea herramientas de dueno cuando WhatsApp no reconoce el numero', async () => {
		const result = await executeToolSafely('get_expense_summary', {}, {
			...context(),
			ownerAuthorized: false,
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'VALIDATION_ERROR' },
		});
		expect(result.error.message).toContain('no está autorizado');
	});

	it('permite cambiar la personalidad desde el chat solo en modo dueño', async () => {
		const clientTools = toolDeclarationsForMode('client').map((tool) => tool.name);
		const ownerTools = toolDeclarationsForMode('owner').map((tool) => tool.name);
		expect(clientTools).not.toContain('set_communication_style');
		expect(ownerTools).toContain('set_communication_style');

		const initial = await getBusinessSettings(env.DB);
		await saveBusinessSettings(env.DB, { ...initial, aiMode: 'client' });
		const denied = await executeToolSafely('set_communication_style', { style: 'friend' }, context());
		expect(denied).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });

		const current = await getBusinessSettings(env.DB);
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const changed = await executeToolSafely('set_communication_style', { style: 'friend' }, context());
		expect(changed).toEqual({ ok: true, data: { communicationStyle: 'friend' } });
		expect((await getBotBusinessSettings(env.DB)).businessProfile.communicationStyle).toBe('friend');
	});

	it('sincroniza el estilo con la empresa web aunque el onboarding esté desactivado', async () => {
		const company = await env.DB.prepare("INSERT INTO companies (name) VALUES ('Empresa estilo chat') RETURNING id").first();
		const globalSettings = await getBusinessSettings(env.DB);
		await saveBusinessSettings(env.DB, {
			...globalSettings,
			aiMode: 'owner',
			onboardingEnabled: false,
			businessProfile: { ...globalSettings.businessProfile, communicationStyle: 'formal' },
		}, { companyId: company.id });

		const changed = await executeToolSafely('set_communication_style', { style: 'friend' }, context());
		expect(changed).toEqual({ ok: true, data: { communicationStyle: 'friend' } });
		expect((await getBusinessSettings(env.DB, { companyId: company.id })).businessProfile.communicationStyle).toBe('friend');
		expect((await getBusinessSettings(env.DB)).businessProfile.communicationStyle).toBe('semiformal');
	});

	it('usa en el bot el estilo de la empresa activa aunque existan otras empresas', async () => {
		const activeCompany = await env.DB.prepare("INSERT INTO companies (name) VALUES ('Empresa WhatsApp') RETURNING id").first();
		const otherCompany = await env.DB.prepare("INSERT INTO companies (name) VALUES ('Otra empresa') RETURNING id").first();
		const baseSettings = await getBusinessSettings(env.DB);
		await saveBusinessSettings(env.DB, {
			...baseSettings,
			businessProfile: { ...baseSettings.businessProfile, communicationStyle: 'formal' },
		}, { companyId: activeCompany.id });
		await saveBusinessSettings(env.DB, {
			...baseSettings,
			businessProfile: { ...baseSettings.businessProfile, communicationStyle: 'friend' },
		}, { companyId: otherCompany.id });
		await createService(env.DB, {
			name: 'Servicio de WhatsApp',
			duration_minutes: 30,
			price_cents: 1500,
			enabled: true,
		}, { companyId: activeCompany.id });

		expect((await getBotBusinessSettings(env.DB)).businessProfile.communicationStyle).toBe('formal');

		const changed = await executeToolSafely('set_communication_style', { style: 'semiformal' }, context());
		expect(changed).toEqual({ ok: true, data: { communicationStyle: 'semiformal' } });
		expect((await getBusinessSettings(env.DB, { companyId: activeCompany.id })).businessProfile.communicationStyle).toBe('semiformal');
		expect((await getBusinessSettings(env.DB, { companyId: otherCompany.id })).businessProfile.communicationStyle).toBe('friend');
	});

	it('prioriza la empresa con onboarding para los contactos nuevos', async () => {
		const clientCompany = await env.DB.prepare("INSERT INTO companies (name) VALUES ('Empresa clientes') RETURNING id").first();
		const onboardingCompany = await env.DB.prepare("INSERT INTO companies (name) VALUES ('Empresa onboarding') RETURNING id").first();
		const baseSettings = await getBusinessSettings(env.DB);
		await saveBusinessSettings(env.DB, {
			...baseSettings,
			onboardingEnabled: false,
			businessProfile: { ...baseSettings.businessProfile, communicationStyle: 'friend' },
		}, { companyId: clientCompany.id });
		await createService(env.DB, {
			name: 'Servicio activo', duration_minutes: 30, price_cents: 1000, enabled: true,
		}, { companyId: clientCompany.id });
		await saveBusinessSettings(env.DB, {
			...baseSettings,
			aiMode: 'owner',
			onboardingEnabled: true,
			businessProfile: { ...baseSettings.businessProfile, communicationStyle: 'formal' },
		}, { companyId: onboardingCompany.id });

		expect(await getOnboardingCompanyId(env.DB)).toBe(onboardingCompany.id);
		expect(await getBotBusinessSettings(env.DB)).toMatchObject({
			aiMode: 'owner',
			onboardingEnabled: true,
			businessProfile: { communicationStyle: 'formal' },
		});
	});

	it('impide registrar pagos en modo cliente', async () => {
		const result = await executeToolSafely('register_payment', {
			appointment_id: 1,
			payment_date: '2026-07-14',
			amount: 25.5,
			payment_method: 'Efectivo',
			billing_type: 'consumer_final',
		}, context());

		expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM payments').first('count')).toBe(0);
	});

	it('impide crear una cita de cliente antes de su confirmación explícita', async () => {
		const current = await getBusinessSettings(env.DB);
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'client' });
		const args = {
			customer_name: 'Cliente Audio',
			service_id: service.id,
			start_datetime: '2026-07-20T14:00:00.000Z',
		};

		const denied = await executeToolSafely('create_appointment', args, {
			...context(),
			userMessage: 'Quiero agendar mañana a las nueve',
		});
		expect(denied).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM appointments').first('count')).toBe(0);

		const confirmed = await executeToolSafely('create_appointment', args, {
			...context(),
			userMessage: 'Sí, todo está correcto',
		});
		expect(confirmed.ok).toBe(true);
	});

	it('registra pagos con trazabilidad de Telegram en modo dueño', async () => {
		const current = await (await SELF.fetch('http://localhost/api/settings')).json();
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const appointment = await executeToolSafely('create_appointment', {
			customer_name: 'Cliente Dos',
			service_id: service.id,
			start_datetime: '2026-07-20T14:00:00.000Z',
		}, context());
		const found = await executeToolSafely('find_customer_appointments', { customer_name: 'Cliente Dos' }, context());
		expect(found.data.appointments).toEqual([
			expect.objectContaining({ id: appointment.data.appointment.id, service_id: service.id }),
		]);
		const result = await executeToolSafely('register_payment', {
			appointment_id: appointment.data.appointment.id,
			payment_date: '2026-07-14',
			amount: 40,
			payment_method: 'Transferencia',
			bank: 'Pichincha',
			billing_type: 'consumer_final',
			notes: 'Abono',
		}, context());

		expect(result).toMatchObject({
			ok: true,
			data: { payment: {
				customer_name: 'Cliente Dos', service_name: 'Servicio Fase 3',
				amount: 40, payment_method: 'Transferencia', bank: 'Pichincha', billing_type: 'consumer_final',
				cedula_ruc: '9999999999999', address: 'Quito', phone: '029999999',
			} },
		});
		const stored = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(result.data.payment.id).first();
		expect(stored).toMatchObject({
			appointment_id: appointment.data.appointment.id,
			telegram_user_id: '7001', telegram_chat_id: '8001', source_update_id: 'telegram:update:phase3-test',
		});
		const customer = await env.DB.prepare('SELECT * FROM customers WHERE full_name = ?1').bind('Cliente Dos').first();
		expect(customer).toMatchObject({ cedula_ruc: '9999999999999', address: 'Quito', phone: '029999999' });
	});

	it('exige datos del cliente para pagos mayores de 50 dólares y los guarda', async () => {
		const current = await (await SELF.fetch('http://localhost/api/settings')).json();
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const appointment = await executeToolSafely('create_appointment', {
			customer_name: 'Cliente Factura',
			service_id: service.id,
			start_datetime: '2026-07-20T14:00:00.000Z',
		}, context());
		const appointmentId = appointment.data.appointment.id;
		const rejected = await executeToolSafely('register_payment', {
			appointment_id: appointmentId, payment_date: '2026-07-14', amount: 50.01,
			payment_method: 'Efectivo', billing_type: 'consumer_final',
		}, context());
		expect(rejected).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM payments').first('count')).toBe(0);

		const accepted = await executeToolSafely('register_payment', {
			appointment_id: appointmentId, payment_date: '2026-07-14', amount: 75,
			payment_method: 'Transferencia', bank: 'Produbanco', billing_type: 'customer_data',
			cedula_ruc: '1712345678', address: 'Av. Siempre Viva 123', phone: '0991234567',
		}, { ...context(), sourceUpdateId: 'telegram:update:with-data' });
		expect(accepted.ok).toBe(true);
		const customer = await env.DB.prepare('SELECT * FROM customers WHERE full_name = ?1').bind('Cliente Factura').first();
		expect(customer).toMatchObject({
			cedula_ruc: '1712345678', address: 'Av. Siempre Viva 123', phone: '0991234567',
		});
	});

	it('consulta todas las deudas y la deuda de un cliente específico en modo dueño', async () => {
		const current = await (await SELF.fetch('http://localhost/api/settings')).json();
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const ana = await executeToolSafely('create_appointment', {
			customer_name: 'Ana Pendiente',
			service_id: service.id,
			start_datetime: '2026-07-20T14:00:00.000Z',
		}, { ...context(), sourceUpdateId: 'debt-ana' });
		const luis = await executeToolSafely('create_appointment', {
			customer_name: 'Luis Pendiente',
			service_id: service.id,
			start_datetime: '2026-07-21T14:00:00.000Z',
		}, { ...context(), sourceUpdateId: 'debt-luis' });
		await env.DB.prepare(
			`INSERT INTO payments (
				appointment_id, payment_date, customer_name, amount_cents, payment_method,
				telegram_user_id, telegram_chat_id, created_at
			 ) VALUES (?1, '2026-07-14', 'Ana Pendiente', 500, 'Efectivo', '7001', '8001', CURRENT_TIMESTAMP)`,
		).bind(ana.data.appointment.id).run();

		const all = await executeToolSafely('get_outstanding_balances', {}, context());
		expect(all).toMatchObject({
			ok: true,
			data: {
				people_count: 2,
				total_outstanding_cents: 3500,
				balances: [
					expect.objectContaining({ customer_name: 'Luis Pendiente', outstanding_cents: 2000 }),
					expect.objectContaining({ customer_name: 'Ana Pendiente', outstanding_cents: 1500 }),
				],
			},
		});

		const specific = await executeToolSafely('get_outstanding_balances', { customer_name: 'Ana' }, context());
		expect(specific.data).toMatchObject({
			people_count: 1,
			total_outstanding_cents: 1500,
			balances: [expect.objectContaining({
				customer_name: 'Ana Pendiente',
				appointments: [expect.objectContaining({
					price_cents: 2000,
					paid_cents: 500,
					outstanding_cents: 1500,
				})],
			})],
		});
		expect(luis.ok).toBe(true);
	});

	it('resume gastos por período, categoría y búsqueda en modo dueño', async () => {
		const current = await (await SELF.fetch('http://localhost/api/settings')).json();
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO expenses (
					expense_date, description, category, supplier, amount_cents, payment_method
				 ) VALUES ('2026-07-02', 'Almuerzo del equipo', 'Alimentación', 'Cafetería', 1250, 'Efectivo')`,
			),
			env.DB.prepare(
				`INSERT INTO expenses (
					expense_date, description, category, supplier, amount_cents, payment_method
				 ) VALUES ('2026-07-10', 'Compra de snacks', 'Alimentación', 'Mercado', 750, 'Efectivo')`,
			),
			env.DB.prepare(
				`INSERT INTO expenses (
					expense_date, description, category, supplier, amount_cents, payment_method
				 ) VALUES ('2026-06-30', 'Taxi', 'Transporte', 'Cooperativa', 500, 'Efectivo')`,
			),
		]);

		const month = await executeToolSafely('get_expense_summary', {
			date_from: '2026-07-01',
			date_to: '2026-07-31',
		}, context());
		expect(month).toMatchObject({
			ok: true,
			data: {
				expense_count: 2,
				total_cents: 2000,
				first_date: '2026-07-02',
				last_date: '2026-07-10',
				by_category: [{ category: 'Alimentación', expense_count: 2, total_cents: 2000 }],
			},
		});

		const food = await executeToolSafely('get_expense_summary', {
			category: 'Alimentación',
			search: 'snacks',
		}, context());
		expect(food.data).toMatchObject({
			expense_count: 1,
			total_cents: 750,
			expenses: [expect.objectContaining({ description: 'Compra de snacks', amount_cents: 750 })],
		});
	});

	it('compara ingresos cobrados, gastos y saldos de citas en modo dueño', async () => {
		const current = await (await SELF.fetch('http://localhost/api/settings')).json();
		await saveBusinessSettings(env.DB, { ...current, aiMode: 'owner' });
		const appointment = await executeToolSafely('create_appointment', {
			customer_name: 'Cliente Balance', service_id: service.id,
			start_datetime: '2026-07-20T14:00:00.000Z',
		}, context());
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO payments (
					appointment_id, payment_date, customer_name, amount_cents, payment_method,
					telegram_user_id, telegram_chat_id
				 ) VALUES (?1, '2026-07-20', 'Cliente Balance', 800, 'Efectivo', '1001', '2001')`,
			).bind(appointment.data.appointment.id),
			env.DB.prepare(
				`INSERT INTO expenses (
					expense_date, description, category, amount_cents, payment_method
				 ) VALUES ('2026-07-21', 'Insumos', 'Insumos', 300, 'Efectivo')`,
			),
		]);
		const result = await executeToolSafely('get_financial_summary', {
			date_from: '2026-07-01', date_to: '2026-07-31',
		}, context());
		expect(result).toMatchObject({
			ok: true,
			data: {
				income_cents: 800,
				expenses_cents: 300,
				net_cents: 500,
				payment_count: 1,
				expense_count: 1,
				appointments: {
					count: 1,
					expected_cents: 2000,
					outstanding_cents: 1200,
					partial_count: 1,
					paid_count: 0,
					unpaid_count: 0,
				},
			},
		});
	});
});
