import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { clearSessionCookie, createSession, deleteSession, getSessionUser } from '../auth/sessions.js';
import { jsonResponse } from '../utils/responses.js';
import { listModeratorCompanies } from './moderator.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;

function cleanText(value, maximum) {
	return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

async function readJson(request) {
	try {
		return await request.json();
	} catch {
		return {};
	}
}

async function ensureSuperAdmin(db) {
	const existing = await db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").first();
	if (existing) return;
	const password = await hashPassword('admin');
	await db.prepare(
		`INSERT INTO users (company_id, username, password_hash, password_salt, password_iterations, role)
		 VALUES (NULL, 'admin', ?1, ?2, ?3, 'super_admin')`,
	).bind(password.hash, password.salt, password.iterations).run();
	await db.prepare("INSERT OR IGNORE INTO companies (name) VALUES ('Funny Hair')").run();
	await db.prepare(
		`UPDATE users
		 SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
		 WHERE company_id IN (
		 	SELECT id FROM companies
		 	WHERE name COLLATE NOCASE IN ('Fuzzy Hair', 'Fuuny Hair')
		 )`,
	).run();
	await db.prepare(
		"DELETE FROM companies WHERE name COLLATE NOCASE IN ('Fuzzy Hair', 'Fuuny Hair')",
	).run();
	await db.prepare(
		`UPDATE users
		 SET company_id = (SELECT id FROM companies WHERE name = 'Funny Hair' COLLATE NOCASE LIMIT 1)
		 WHERE username = 'Mario' COLLATE NOCASE AND role = 'admin'`,
	).run();
}

function publicUser(user) {
	return {
		id: user.id,
		username: user.username,
		role: user.role,
		companyId: user.company_id ?? null,
		companyName: user.company_name ?? null,
	};
}

export async function handleAuthApi(request, env, url) {
	if (request.method === 'POST' && url.pathname === '/api/auth/register') {
		const body = await readJson(request);
		const businessName = cleanText(body.businessName, 120);
		const username = cleanText(body.username, 40);
		const password = typeof body.password === 'string' ? body.password : '';
		if (businessName.length < 2 || !USERNAME_PATTERN.test(username) || password.length < 8) {
			return jsonResponse({
				ok: false,
				error: 'Ingresa un negocio válido, un usuario de al menos 3 caracteres y una contraseña de al menos 8 caracteres.',
			}, 400);
		}
		const credentials = await hashPassword(password);
		try {
			const company = await env.DB.prepare(
				'INSERT INTO companies (name) VALUES (?1) RETURNING id, name',
			).bind(businessName).first();
			const user = await env.DB.prepare(
				`INSERT INTO users (company_id, username, password_hash, password_salt, password_iterations, role)
				 VALUES (?1, ?2, ?3, ?4, ?5, 'admin') RETURNING id, username, role, company_id`,
			).bind(company.id, username, credentials.hash, credentials.salt, credentials.iterations).first();
			const session = await createSession(env.DB, user.id);
			return jsonResponse({ ok: true, user: publicUser({ ...user, company_name: company.name }) }, 201, {
				'Set-Cookie': session.cookie,
			});
		} catch (error) {
			if (String(error?.message).includes('UNIQUE')) {
				return jsonResponse({ ok: false, error: 'Ese usuario o negocio ya está registrado.' }, 409);
			}
			throw error;
		}
	}

	if (request.method === 'POST' && url.pathname === '/api/auth/login') {
		await ensureSuperAdmin(env.DB);
		const body = await readJson(request);
		const username = cleanText(body.username, 40);
		const user = await env.DB.prepare(
			`SELECT users.*, companies.name AS company_name
			 FROM users LEFT JOIN companies ON companies.id = users.company_id
			 WHERE users.username = ?1 COLLATE NOCASE`,
		).bind(username).first();
		const password = typeof body.password === 'string' ? body.password : '';
		if (!user || !(await verifyPassword(password, user.password_hash, user.password_salt, user.password_iterations))) {
			return jsonResponse({ ok: false, error: 'Usuario o contraseña incorrectos.' }, 401);
		}
		const session = await createSession(env.DB, user.id);
		return jsonResponse({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': session.cookie });
	}

	if (request.method === 'GET' && url.pathname === '/api/auth/me') {
		const user = await getSessionUser(request, env.DB);
		if (!user) return jsonResponse({ ok: false, error: 'No autorizado.' }, 401);
		const response = { ok: true, user: publicUser(user) };
		if (user.role === 'super_admin') response.companies = await listModeratorCompanies(env.DB);
		return jsonResponse(response);
	}

	if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
		await deleteSession(request, env.DB);
		return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
	}

	return jsonResponse({ ok: false, error: 'Ruta de autenticación no encontrada.' }, 404);
}
