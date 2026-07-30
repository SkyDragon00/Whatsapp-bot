import { jsonResponse } from '../utils/responses.js';
import { getSessionUser } from '../auth/sessions.js';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ADMIN_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ADMIN_HEADERS = 'Content-Type, Authorization';

function isLocalHostname(hostname) {
	return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function configuredOrigins(env) {
	return String(env.ADMIN_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

function isAllowedOrigin(origin, env, requestUrl) {
	if (!origin) return true;
	try {
		const url = new URL(origin);
		if (url.origin === new URL(requestUrl).origin) return true;
		if (isLocalHostname(url.hostname)) return true;
		return configuredOrigins(env).includes(url.origin);
	} catch {
		return false;
	}
}

function corsHeaders(origin) {
	if (!origin) return {};
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': ADMIN_METHODS,
		'Access-Control-Allow-Headers': ADMIN_HEADERS,
		'Access-Control-Max-Age': '600',
		Vary: 'Origin',
	};
}

function withHeaders(response, headers) {
	const mergedHeaders = new Headers(response.headers);
	for (const [name, value] of Object.entries(headers)) mergedHeaders.set(name, value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: mergedHeaders,
	});
}

async function hashToken(value) {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function tokensMatch(received, expected) {
	const [receivedHash, expectedHash] = await Promise.all([hashToken(received), hashToken(expected)]);
	let difference = 0;
	for (let index = 0; index < expectedHash.length; index += 1) {
		difference |= receivedHash[index] ^ expectedHash[index];
	}
	return difference === 0;
}

async function authorizeAdminRequest(request, env) {
	const sessionUser = await getSessionUser(request, env.DB);
	if (sessionUser) return { ok: true, user: sessionUser };
	if (isLocalHostname(new URL(request.url).hostname)) {
		return { ok: true, user: { role: 'admin', company_id: null, localDevelopment: true } };
	}
	const expectedToken = typeof env.ADMIN_API_TOKEN === 'string' ? env.ADMIN_API_TOKEN.trim() : '';
	if (!expectedToken) {
		return {
			ok: false,
			response: jsonResponse(
				{ ok: false, error: 'La API administrativa no está habilitada en este entorno.', code: 'ADMIN_AUTH_REQUIRED' },
				503,
			),
		};
	}

	const authorization = request.headers.get('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(authorization);
	if (!match || !(await tokensMatch(match[1], expectedToken))) {
		return {
			ok: false,
			response: jsonResponse({ ok: false, error: 'No autorizado.', code: 'UNAUTHORIZED' }, 401, {
				'WWW-Authenticate': 'Bearer',
			}),
		};
	}
	return { ok: true };
}

/** Protege y aplica CORS a todas las rutas administrativas. */
export async function withAdminProtection(request, env, handler, options = {}) {
	const origin = request.headers.get('origin');
	if (!isAllowedOrigin(origin, env, request.url)) {
		return jsonResponse({ ok: false, error: 'Origen no permitido.', code: 'CORS_ORIGIN_DENIED' }, 403);
	}
	const headers = corsHeaders(origin);
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

	const authorization = await authorizeAdminRequest(request, env);
	if (!authorization.ok) return withHeaders(authorization.response, headers);
	if (options.role && authorization.user?.role !== options.role) {
		return withHeaders(jsonResponse({ ok: false, error: 'No tienes permiso para acceder a esta página.', code: 'FORBIDDEN' }, 403), headers);
	}
	return withHeaders(await handler(authorization.user), headers);
}
