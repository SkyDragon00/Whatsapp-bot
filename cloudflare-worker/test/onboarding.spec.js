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

		const completedHistory = [
			...historyWithBadReply,
			{ role: 'user', text: 'No no, Griega Madre es el nombre de mi negocio y el de usuario es Myriam' },
			{ role: 'model', text: 'Elige el estilo de comunicación: formal, semiformal o amigo.' },
		];
		expect(deriveOnboardingIdentity(completedHistory, 'Semiformal')).toEqual({
			businessName: 'Griega Madre', username: 'Myriam', communicationStyle: 'semiformal',
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
		expect(result).toEqual({ businessName, username, mustChangePassword: true });
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
			communicationStyle: 'friend',
			address: 'Calle principal',
			acceptedPaymentMethods: ['Efectivo', 'Transferencia'],
		});
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
