import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = 'http://localhost';

function sessionCookie(response) {
	return response.headers.get('set-cookie')?.split(';')[0] || '';
}

describe.sequential('usuarios y moderación', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	it('crea el super admin solicitado y permite iniciar sesión', async () => {
		const response = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'admin', password: 'admin' }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			user: { username: 'admin', role: 'super_admin', companyId: null },
		});
		expect(sessionCookie(response)).toContain('business_session=');
	});

	it('registra negocios como administradores y conserva la sesión', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				businessName: `Negocio ${suffix}`,
				username: `user-${suffix}`,
				password: 'password-seguro',
			}),
		});
		expect(response.status).toBe(201);
		const created = await response.json();
		expect(created.user).toMatchObject({ role: 'admin', companyName: `Negocio ${suffix}` });

		const me = await SELF.fetch(`${ORIGIN}/api/auth/me`, {
			headers: { Cookie: sessionCookie(response) },
		});
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ user: { username: `user-${suffix}`, role: 'admin' } });
	});

	it('reserva la lista de empresas para el super admin', async () => {
		const adminLogin = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'admin', password: 'admin' }),
		});
		const moderator = await SELF.fetch(`${ORIGIN}/api/moderator/companies`, {
			headers: { Cookie: sessionCookie(adminLogin) },
		});
		expect(moderator.status).toBe(200);
		expect(await moderator.json()).toMatchObject({
			companies: expect.arrayContaining([expect.objectContaining({ name: 'Funny Hair' })]),
		});

		const forbidden = await SELF.fetch(`${ORIGIN}/api/moderator/companies`);
		expect(forbidden.status).toBe(403);
	});
});
