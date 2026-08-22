import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/passwords.js';
import { DEFAULT_ONBOARDING_PASSWORD, registerOnboardingBusiness } from '../src/onboarding/register-business.js';
import { isExplicitConfirmation } from '../src/ai/tools.js';
import { findUserByPhone } from '../src/repositories/user-identity-repository.js';
import { deriveOnboardingIdentity } from '../src/onboarding/conversation-state.js';

describe.sequential('registro mediante onboarding', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	it('acepta confirmaciones naturales y rechaza negativas', () => {
		expect(isExplicitConfirmation('Listo, todo correcto')).toBe(true);
		expect(isExplicitConfirmation('Sí, confirmo que está bien')).toBe(true);
		expect(isExplicitConfirmation('No, todavía no está correcto')).toBe(false);
	});

	it('mantiene separados el nombre del negocio y el usuario durante la conversación', () => {
		const history = [
			{ role: 'user', text: 'Hola, ayúdame con el onboarding' },
			{ role: 'model', text: 'Dime el nombre de tu negocio.' },
			{ role: 'user', text: 'Griega Madre' },
			{ role: 'model', text: 'Ahora elige un nombre de usuario para el administrador.' },
		];
		expect(deriveOnboardingIdentity(history, 'Myriam')).toEqual({
			businessName: 'Griega Madre', username: 'Myriam',
		});

		const historyWithBadReply = [
			...history,
			{ role: 'user', text: 'Myriam' },
			{ role: 'model', text: 'El nombre del negocio será Myriam. Ahora elige un nombre de usuario.' },
		];
		expect(deriveOnboardingIdentity(
			historyWithBadReply,
			'No no, Griega Madre es el nombre de mi negocio y el de usuario es Myriam',
		)).toEqual({ businessName: 'Griega Madre', username: 'Myriam' });

	});

	it('nunca interpreta un horario como nombre del negocio', () => {
		const history = [
			{ role: 'model', text: 'Para comenzar, ¿cuál es el nombre de tu negocio?' },
			{ role: 'user', text: 'Pet sitter' },
			{ role: 'model', text: 'Ahora indícame el nombre de usuario para el administrador.' },
			{ role: 'user', text: 'Jorge1' },
			{ role: 'model', text: '¿Cuáles son tus días y horarios de atención?' },
			{ role: 'user', text: 'De lunes a viernes, de 8am a 8pm' },
			{ role: 'model', text: '¿Cuál es tu nombre de usuario para el sistema?' },
		];
		expect(deriveOnboardingIdentity(history, 'Jorge1')).toEqual({
			businessName: 'Pet sitter',
			username: 'Jorge1',
		});
	});

	it('conserva ubicación y dirección como el mismo dato durante el onboarding', () => {
		const history = [
			{ role: 'model', text: 'Puedes añadir información opcional, como ubicación o dirección.' },
			{ role: 'user', text: 'Mi ubicación es Av. Amazonas 123, Quito' },
			{ role: 'model', text: 'Perfecto. ¿Deseas añadir algo más?' },
		];
		expect(deriveOnboardingIdentity(history, 'No, eso es todo')).toMatchObject({
			address: 'Av. Amazonas 123, Quito',
		});
		expect(deriveOnboardingIdentity([], 'Dirección: Calle Larga 45, Cuenca')).toMatchObject({
			address: 'Calle Larga 45, Cuenca',
		});
	});

	it('no reemplaza la dirección con la confirmación del resumen', () => {
		const history = [
			{ role: 'model', text: '¿Cuál es la dirección del negocio?' },
			{ role: 'user', text: 'Cumbayá, edificio Artes, piso 5' },
			{
				role: 'model',
				text: 'Dirección: Cumbayá, edificio Artes, piso 5. ¿Es correcta toda esta información para proceder con el registro?',
			},
		];
		expect(deriveOnboardingIdentity(history, 'Correcto')).toMatchObject({
			address: 'Cumbayá, edificio Artes, piso 5',
		});
	});

	it('crea empresa y administrador con cambio de contraseña obligatorio', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const businessName = `Peludos ${suffix}`;
		const username = `ana-${suffix}`;
		const result = await registerOnboardingBusiness(env.DB, {
			business_name: businessName,
			username,
			communication_style: 'friend',
			address: 'Calle principal',
			payment_methods: ['Efectivo', 'Transferencia'],
		}, { ownerPhone: '(+593) 99 777 66 55' });
		expect(result).toEqual({ businessName, username, mustChangePassword: true, servicesCount: 0 });
		const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first();
		expect(user.must_change_password).toBe(1);
		expect(user.phone_e164).toBe('+593997776655');
		await expect(findUserByPhone(env.DB, '593997776655')).resolves.toMatchObject({
			id: user.id,
			company_id: user.company_id,
			username,
			company_name: businessName,
		});
		expect(await verifyPassword(DEFAULT_ONBOARDING_PASSWORD, user.password_hash, user.password_salt, user.password_iterations)).toBe(true);
		const profile = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
			.bind(`company:${user.company_id}:business_profile`).first();
		expect(JSON.parse(profile.value)).toMatchObject({
			businessName,
			communicationStyle: 'semiformal',
			address: 'Calle principal',
			acceptedPaymentMethods: ['Efectivo', 'Transferencia'],
		});
		const service = await env.DB.prepare('SELECT * FROM services WHERE company_id = ?1').bind(user.company_id).first();
		expect(service).toBeNull();
		const schedule = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
			.bind(`company:${user.company_id}:schedule`).first();
		expect(JSON.parse(schedule.value).businessHours).toEqual([
			{ day: 0, enabled: false, start: '09:00', end: '17:00' },
			...Array.from({ length: 5 }, (_, index) => ({ day: index + 1, enabled: true, start: '09:00', end: '17:00' })),
			{ day: 6, enabled: false, start: '09:00', end: '17:00' },
		]);
	});

	it('guarda únicamente los servicios proporcionados', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const result = await registerOnboardingBusiness(env.DB, {
			business_name: `Servicios ${suffix}`,
			username: `serv-${suffix}`,
			communication_style: 'semiformal',
			services: [{ name: 'Barba', description: 'Perfilado de barba', duration_minutes: 15, price: 3.5 }],
		});
		expect(result.servicesCount).toBe(1);
		const user = await env.DB.prepare('SELECT company_id FROM users WHERE username = ?1').bind(`serv-${suffix}`).first();
		const stored = await env.DB.prepare('SELECT * FROM services WHERE company_id = ?1').bind(user.company_id).all();
		expect(stored.results).toEqual([
			expect.objectContaining({ name: 'Barba', description: 'Perfilado de barba', duration_minutes: 15, price_cents: 350 }),
		]);
	});

	it('explica los datos faltantes o inválidos de un servicio', async () => {
		const base = { business_name: `Inválido ${crypto.randomUUID()}`, username: `inv-${crypto.randomUUID().slice(0, 8)}`, communication_style: 'formal' };
		await expect(registerOnboardingBusiness(env.DB, {
			...base, services: [{ name: 'Barba', duration_minutes: 15, price: 5 }],
		})).rejects.toThrow('falta la descripción');
		await expect(registerOnboardingBusiness(env.DB, {
			...base, services: [{ name: 'Barba', description: 'Perfilado', duration_minutes: 2, price: 5 }],
		})).rejects.toThrow('duración del servicio debe estar entre 5 y 480 minutos');
	});

	it('guarda el horario proporcionado y cierra los días omitidos', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		await registerOnboardingBusiness(env.DB, {
			business_name: `Horario ${suffix}`,
			username: `hora-${suffix}`,
			communication_style: 'formal',
			business_hours: [
				{ day: 2, start: '10:00', end: '19:00' },
				{ day: 6, start: '08:30', end: '13:00' },
			],
		});
		const user = await env.DB.prepare('SELECT company_id FROM users WHERE username = ?1').bind(`hora-${suffix}`).first();
		const schedule = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
			.bind(`company:${user.company_id}:schedule`).first();
		const hours = JSON.parse(schedule.value).businessHours;
		expect(hours[2]).toEqual({ day: 2, enabled: true, start: '10:00', end: '19:00' });
		expect(hours[6]).toEqual({ day: 6, enabled: true, start: '08:30', end: '13:00' });
		expect(hours[1].enabled).toBe(false);
	});

	it('explica por qué un horario proporcionado no es válido', async () => {
		const base = { business_name: `Horario inválido ${crypto.randomUUID()}`, username: `bad-${crypto.randomUUID().slice(0, 8)}`, communication_style: 'formal' };
		await expect(registerOnboardingBusiness(env.DB, {
			...base, business_hours: [{ day: 1, start: '09:00' }],
		})).rejects.toThrow('faltan la hora de apertura o de cierre');
		await expect(registerOnboardingBusiness(env.DB, {
			...base, business_hours: [{ day: 1, start: '17:00', end: '09:00' }],
		})).rejects.toThrow('apertura anterior al cierre');
	});

	it('acepta location como alias de address al registrar el negocio', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		await registerOnboardingBusiness(env.DB, {
			business_name: `Ubicación ${suffix}`,
			username: `ubi-${suffix}`,
			communication_style: 'semiformal',
			location: 'Av. República 456, Quito',
		});
		const user = await env.DB.prepare('SELECT company_id FROM users WHERE username = ?1').bind(`ubi-${suffix}`).first();
		const profile = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
			.bind(`company:${user.company_id}:business_profile`).first();
		expect(JSON.parse(profile.value).address).toBe('Av. República 456, Quito');
	});

	it('sugiere tres usuarios similares que no existen cuando el solicitado está ocupado', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const username = `luis-${suffix}`;
		await registerOnboardingBusiness(env.DB, {
			business_name: `Primero ${suffix}`, username, communication_style: 'formal',
		});
		await registerOnboardingBusiness(env.DB, {
			business_name: `Segundo ${suffix}`, username: `${username}_1`, communication_style: 'formal',
		});

		let conflict;
		try {
			await registerOnboardingBusiness(env.DB, {
				business_name: `Tercero ${suffix}`, username, communication_style: 'formal',
			});
		} catch (error) {
			conflict = error;
		}
		expect(conflict).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(conflict.message).toContain(`El usuario "${username}" ya existe.`);
		const suggestions = conflict.message.match(new RegExp(`${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+`, 'g'));
		expect(suggestions).toHaveLength(3);
		expect(suggestions).not.toContain(`${username}_1`);
		for (const suggestion of suggestions) {
			expect(await env.DB.prepare('SELECT id FROM users WHERE username = ?1 COLLATE NOCASE').bind(suggestion).first()).toBeNull();
		}
	});
});
