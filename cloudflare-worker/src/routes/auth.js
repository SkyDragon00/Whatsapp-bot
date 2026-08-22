import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { clearSessionCookie, createSession, deleteSession, getSessionUser } from '../auth/sessions.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../config/constants.js';
import { normalizeBusinessSettings } from '../domain/validation.js';
import { jsonResponse } from '../utils/responses.js';
import { listModeratorCompanies } from './moderator.js';
import { getBusinessSettings } from '../repositories/settings-repository.js';

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
		mustChangePassword: Boolean(user.must_change_password),
	};
}

export async function handleAuthApi(request, env, url) {
	if (request.method === 'POST' && url.pathname === '/api/auth/register') {
		const body = await readJson(request);
		const businessName = cleanText(body.businessName, 120);
		const username = cleanText(body.username, 40);
		const password = typeof body.password === 'string' ? body.password : '';
		const communicationStyle = cleanText(body.communicationStyle, 20);
		if (businessName.length < 2 || !USERNAME_PATTERN.test(username) || password.length < 8) {
			return jsonResponse({
				ok: false,
				error: 'Ingresa un negocio válido, un usuario de al menos 3 caracteres y una contraseña de al menos 8 caracteres.',
			}, 400);
		}
		if (!['formal', 'semiformal', 'friend'].includes(communicationStyle)) {
			return jsonResponse({ ok: false, error: 'Elige si el asistente hablará de forma formal, semiformal o como amigo.' }, 400);
		}
		const settings = normalizeBusinessSettings({
			...DEFAULT_BUSINESS_SETTINGS,
			aiMode: 'owner',
			businessProfile: {
				...DEFAULT_BUSINESS_SETTINGS.businessProfile,
				businessName,
				communicationStyle,
				address: cleanText(body.address, 300),
				arrivalInstructions: cleanText(body.arrivalInstructions, 1_000),
				cancellationPolicy: cleanText(body.cancellationPolicy, 1_000),
				generalNotes: cleanText(body.generalNotes, 1_000),
				acceptedPaymentMethods: cleanText(body.paymentMethods, 1_000)
					.split(',').map((method) => method.trim()).filter(Boolean),
			},
		});
		const credentials = await hashPassword(password);
		const { businessProfile, ...schedule } = settings;
		try {
			await env.DB.batch([
				env.DB.prepare('INSERT INTO companies (name) VALUES (?1)').bind(businessName),
				env.DB.prepare(
				`INSERT INTO users (company_id, username, password_hash, password_salt, password_iterations, role)
				 VALUES ((SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE), ?2, ?3, ?4, ?5, 'admin')`,
				).bind(businessName, username, credentials.hash, credentials.salt, credentials.iterations),
				env.DB.prepare(
					`INSERT INTO settings (key, value)
					 VALUES ('company:' || (SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE) || ':schedule', ?2)`,
				).bind(businessName, JSON.stringify(schedule)),
				env.DB.prepare(
					`INSERT INTO settings (key, value)
					 VALUES ('company:' || (SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE) || ':business_profile', ?2)`,
				).bind(businessName, JSON.stringify(businessProfile)),
			]);
			const user = await env.DB.prepare(
				`SELECT users.id, users.username, users.role, users.company_id, companies.name AS company_name
				 FROM users JOIN companies ON companies.id = users.company_id WHERE users.username = ?1 COLLATE NOCASE`,
			).bind(username).first();
			const session = await createSession(env.DB, user.id);
			return jsonResponse({ ok: true, user: publicUser(user) }, 201, {
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
		const platformSettings = await getBusinessSettings(env.DB);
		return jsonResponse({
			ok: true,
			user: publicUser(user),
			firstStepsEnabled: user.role !== 'super_admin' && platformSettings.firstStepsEnabled === true,
		}, 200, { 'Set-Cookie': session.cookie });
	}

	if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
		const sessionUser = await getSessionUser(request, env.DB);
		if (!sessionUser) return jsonResponse({ ok: false, error: 'No autorizado.' }, 401);
		const body = await readJson(request);
		const password = typeof body.password === 'string' ? body.password : '';
		const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
		if (password.length < 8) {
			return jsonResponse({ ok: false, error: 'La nueva contraseña debe tener al menos 8 caracteres.' }, 400);
		}
		if (password !== confirmation) {
			return jsonResponse({ ok: false, error: 'Las contraseñas no coinciden.' }, 400);
		}
		const credentials = await hashPassword(password);
		await env.DB.prepare(
			`UPDATE users SET password_hash = ?1, password_salt = ?2, password_iterations = ?3,
			 must_change_password = 0 WHERE id = ?4`,
		).bind(credentials.hash, credentials.salt, credentials.iterations, sessionUser.id).run();
		return jsonResponse({ ok: true });
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
