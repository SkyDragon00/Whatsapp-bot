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
				communicationStyle: 'friend',
				address: 'Calle de prueba',
				paymentMethods: 'Efectivo, Transferencia',
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

		const settings = await env.DB.prepare('SELECT key, value FROM settings WHERE key IN (?1, ?2)')
			.bind(`company:${created.user.companyId}:schedule`, `company:${created.user.companyId}:business_profile`).all();
		const saved = Object.fromEntries(settings.results.map((row) => [row.key.split(':').at(-1), JSON.parse(row.value)]));
		expect(saved.schedule.aiMode).toBe('owner');
		expect(saved.business_profile).toMatchObject({
			businessName: `Negocio ${suffix}`,
			communicationStyle: 'friend',
			address: 'Calle de prueba',
			acceptedPaymentMethods: ['Efectivo', 'Transferencia'],
		});
	});

	it('exige el estilo de comunicación durante el onboarding', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ businessName: `Sin estilo ${suffix}`, username: `nostyle-${suffix}`, password: 'password-seguro' }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining('formal') });
	});

	it('obliga a reemplazar la contraseña temporal creada por chat', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const username = `forced-${suffix}`;
		const registration = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				businessName: `Forzado ${suffix}`, username, password: 'temporal-123', communicationStyle: 'formal',
			}),
		});
		const registered = await registration.json();
		await env.DB.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?1').bind(registered.user.id).run();
		const login = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password: 'temporal-123' }),
		});
		expect(await login.clone().json()).toMatchObject({ user: { mustChangePassword: true } });
		const changed = await SELF.fetch(`${ORIGIN}/api/auth/change-password`, {
			method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie(login) },
			body: JSON.stringify({ password: 'definitiva-456', confirmation: 'definitiva-456' }),
		});
		expect(changed.status).toBe(200);
		const relogin = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password: 'definitiva-456' }),
		});
		expect(await relogin.json()).toMatchObject({ user: { mustChangePassword: false } });
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

	it('muestra el propietario y permite al super admin eliminar la empresa y sus datos', async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const businessName = `Empresa eliminable ${suffix}`;
		const username = `delete-${suffix}`;
		const registration = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ businessName, username, password: 'password-seguro', communicationStyle: 'formal' }),
		});
		const registered = await registration.json();
		const companyId = registered.user.companyId;
		const phone = `+59398${suffix.replace(/[^0-9]/g, '').padEnd(7, '0').slice(0, 7)}`;
		await env.DB.prepare('UPDATE users SET phone_e164 = ?1 WHERE company_id = ?2').bind(phone, companyId).run();

		const adminLogin = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'admin', password: 'admin' }),
		});
		const cookie = sessionCookie(adminLogin);
		const companiesResponse = await SELF.fetch(`${ORIGIN}/api/moderator/companies`, { headers: { Cookie: cookie } });
		const companies = (await companiesResponse.json()).companies;
		expect(companies).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: companyId, name: businessName, owner_username: username, owner_phone: phone }),
		]));

		const forbidden = await SELF.fetch(`${ORIGIN}/api/moderator/companies/${companyId}`, { method: 'DELETE' });
		expect(forbidden.status).toBe(403);

		const deleted = await SELF.fetch(`${ORIGIN}/api/moderator/companies/${companyId}`, {
			method: 'DELETE', headers: { Cookie: cookie },
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ ok: true, deletedCompany: { id: companyId, name: businessName } });
		expect(await env.DB.prepare('SELECT id FROM companies WHERE id = ?1').bind(companyId).first()).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM users WHERE company_id = ?1').bind(companyId).first()).toBeNull();
		expect((await env.DB.prepare("SELECT key FROM settings WHERE key LIKE ('company:' || ?1 || ':%')").bind(companyId).all()).results).toHaveLength(0);

		const missing = await SELF.fetch(`${ORIGIN}/api/moderator/companies/${companyId}`, {
			method: 'DELETE', headers: { Cookie: cookie },
		});
		expect(missing.status).toBe(404);
	});
});
