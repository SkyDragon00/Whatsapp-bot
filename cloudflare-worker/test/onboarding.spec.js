import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/passwords.js';
import { registerOnboardingBusiness } from '../src/onboarding/register-business.js';
import { isExplicitConfirmation } from '../src/ai/tools.js';

describe.sequential('registro mediante onboarding', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	it('acepta confirmaciones naturales y rechaza negativas', () => {
		expect(isExplicitConfirmation('Listo, todo correcto')).toBe(true);
		expect(isExplicitConfirmation('Sí, confirmo que está bien')).toBe(true);
		expect(isExplicitConfirmation('No, todavía no está correcto')).toBe(false);
	});

	it('crea empresa y administrador con cambio de contraseña obligatorio', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const businessName = `Peludos ${suffix}`;
		const username = `ana-${suffix}`;
		const result = await registerOnboardingBusiness(env.DB, {
			business_name: businessName,
			username,
			password: 'temporal-123',
			communication_style: 'friend',
			address: 'Calle principal',
			payment_methods: ['Efectivo', 'Transferencia'],
		});
		expect(result).toEqual({ businessName, username, mustChangePassword: true });
		const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first();
		expect(user.must_change_password).toBe(1);
		expect(await verifyPassword('temporal-123', user.password_hash, user.password_salt, user.password_iterations)).toBe(true);
		const profile = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
			.bind(`company:${user.company_id}:business_profile`).first();
		expect(JSON.parse(profile.value)).toMatchObject({
			businessName,
			communicationStyle: 'friend',
			address: 'Calle principal',
			acceptedPaymentMethods: ['Efectivo', 'Transferencia'],
		});
	});
});
