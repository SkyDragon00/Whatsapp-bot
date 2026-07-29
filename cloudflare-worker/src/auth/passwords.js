const DEFAULT_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

function bytesToBase64(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(password, salt, iterations) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits'],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		key,
		KEY_LENGTH_BITS,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derivePassword(password, salt, iterations);
	return {
		hash: bytesToBase64(hash),
		salt: bytesToBase64(salt),
		iterations,
	};
}

export async function verifyPassword(password, encodedHash, encodedSalt, iterations) {
	const actual = await derivePassword(password, base64ToBytes(encodedSalt), iterations);
	const expected = base64ToBytes(encodedHash);
	if (actual.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) difference |= actual[index] ^ expected[index];
	return difference === 0;
}
