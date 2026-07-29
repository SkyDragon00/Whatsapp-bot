const SESSION_COOKIE = 'business_session';
const SESSION_SECONDS = 60 * 60 * 24 * 7;

function bytesToHex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenHash(token) {
	return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

function readCookie(request, name) {
	const cookie = request.headers.get('cookie') || '';
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return '';
}

export async function createSession(db, userId) {
	const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
	await db.prepare(
		'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?1, ?2, ?3)',
	).bind(userId, await tokenHash(token), expiresAt).run();
	return {
		token,
		cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
	};
}

export async function getSessionUser(request, db) {
	const token = readCookie(request, SESSION_COOKIE);
	if (!token) return null;
	return db.prepare(
		`SELECT users.id, users.username, users.role, users.company_id, companies.name AS company_name
		 FROM sessions
		 JOIN users ON users.id = sessions.user_id
		 LEFT JOIN companies ON companies.id = users.company_id
		 WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2`,
	).bind(await tokenHash(token), new Date().toISOString()).first();
}

export async function deleteSession(request, db) {
	const token = readCookie(request, SESSION_COOKIE);
	if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await tokenHash(token)).run();
}

export function clearSessionCookie() {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
