import { hashPassword } from '../auth/passwords.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../config/constants.js';
import { ValidationError } from '../domain/errors.js';
import { normalizeBusinessSettings, requireString } from '../domain/validation.js';
import { normalizePhoneE164 } from '../repositories/user-identity-repository.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;
export const DEFAULT_ONBOARDING_PASSWORD = '12345678';

function optionalText(value, label, maximum) {
	return requireString(value, label, { max: maximum, optional: true });
}

export async function suggestAvailableUsernames(db, requestedUsername, count = 3) {
	const suggestions = [];
	let nextSuffix = 1;
	while (suggestions.length < count) {
		const candidates = Array.from({ length: 25 }, () => {
			const suffix = `_${nextSuffix++}`;
			return `${requestedUsername.slice(0, 40 - suffix.length)}${suffix}`;
		});
		const placeholders = candidates.map((_, index) => `?${index + 1}`).join(', ');
		const existing = await db.prepare(
			`SELECT username FROM users WHERE username COLLATE NOCASE IN (${placeholders})`,
		).bind(...candidates).all();
		const occupied = new Set((existing.results || []).map((row) => String(row.username).toLocaleLowerCase('es')));
		for (const candidate of candidates) {
			if (!occupied.has(candidate.toLocaleLowerCase('es'))) suggestions.push(candidate);
			if (suggestions.length === count) break;
		}
	}
	return suggestions;
}

async function usernameConflictError(db, username) {
	const suggestions = await suggestAvailableUsernames(db, username);
	return new ValidationError(
		`El usuario "${username}" ya existe. Puedes usar uno de estos nombres disponibles: ${suggestions.join(', ')}.`,
	);
}

export async function registerOnboardingBusiness(db, input, { ownerPhone = null } = {}) {
	const businessName = requireString(input.business_name, 'El nombre del negocio', { min: 2, max: 120 });
	const username = requireString(input.username, 'El usuario', { min: 3, max: 40 });
	const communicationStyle = requireString(input.communication_style, 'El estilo', { max: 20 });
	if (!USERNAME_PATTERN.test(username)) {
		throw new ValidationError('El usuario solo puede contener letras, números, punto, guion y guion bajo.');
	}
	if (!['formal', 'semiformal', 'friend'].includes(communicationStyle)) {
		throw new ValidationError('El estilo debe ser formal, semiformal o amigo.');
	}
	const paymentMethods = input.payment_methods ?? [];
	if (!Array.isArray(paymentMethods)) throw new ValidationError('Los métodos de pago deben ser una lista.');

	const phoneE164 = ownerPhone === null ? null : normalizePhoneE164(ownerPhone);
	if (ownerPhone !== null && phoneE164 === null) {
		throw new ValidationError('No se pudo validar el número de WhatsApp del dueño.');
	}
	const existingUsername = await db.prepare(
		'SELECT id FROM users WHERE username = ?1 COLLATE NOCASE LIMIT 1',
	).bind(username).first();
	if (existingUsername) throw await usernameConflictError(db, username);
	const existingBusiness = await db.prepare(
		'SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE LIMIT 1',
	).bind(businessName).first();
	if (existingBusiness) throw new ValidationError(`El negocio "${businessName}" ya está registrado.`);

	const settings = normalizeBusinessSettings({
		...DEFAULT_BUSINESS_SETTINGS,
		aiMode: 'owner',
		onboardingEnabled: false,
		businessProfile: {
			...DEFAULT_BUSINESS_SETTINGS.businessProfile,
			businessName,
			communicationStyle,
			address: optionalText(input.address, 'La dirección', 300),
			arrivalInstructions: optionalText(input.arrival_instructions, 'Las instrucciones para llegar', 1_000),
			cancellationPolicy: optionalText(input.cancellation_policy, 'La política de cancelación', 1_000),
			generalNotes: optionalText(input.general_notes, 'Las notas generales', 1_000),
			acceptedPaymentMethods: paymentMethods,
		},
	});
	const credentials = await hashPassword(DEFAULT_ONBOARDING_PASSWORD);
	const { businessProfile, ...schedule } = settings;
	try {
		await db.batch([
			db.prepare('INSERT INTO companies (name) VALUES (?1)').bind(businessName),
			db.prepare(
				`INSERT INTO users (company_id, username, password_hash, password_salt, password_iterations, role, must_change_password, phone_e164)
				 VALUES ((SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE), ?2, ?3, ?4, ?5, 'admin', 1, ?6)`,
			).bind(businessName, username, credentials.hash, credentials.salt, credentials.iterations, phoneE164),
			db.prepare(
				`INSERT INTO settings (key, value) VALUES
				 ('company:' || (SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE) || ':schedule', ?2)`,
			).bind(businessName, JSON.stringify(schedule)),
			db.prepare(
				`INSERT INTO settings (key, value) VALUES
				 ('company:' || (SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE) || ':business_profile', ?2)`,
			).bind(businessName, JSON.stringify(businessProfile)),
		]);
	} catch (error) {
		if (String(error?.message).includes('UNIQUE')) {
			const conflictingUser = await db.prepare(
				'SELECT id FROM users WHERE username = ?1 COLLATE NOCASE LIMIT 1',
			).bind(username).first();
			if (conflictingUser) throw await usernameConflictError(db, username);
			throw new ValidationError(`El negocio "${businessName}" ya está registrado.`);
		}
		throw error;
	}
	return { businessName, username, mustChangePassword: true };
}
