import { hashPassword } from '../auth/passwords.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../config/constants.js';
import { ValidationError } from '../domain/errors.js';
import { normalizeBusinessSettings, requireString } from '../domain/validation.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;

function optionalText(value, label, maximum) {
	return requireString(value, label, { max: maximum, optional: true });
}

export async function registerOnboardingBusiness(db, input) {
	const businessName = requireString(input.business_name, 'El nombre del negocio', { min: 2, max: 120 });
	const username = requireString(input.username, 'El usuario', { min: 3, max: 40 });
	const password = requireString(input.password, 'La contraseña', { min: 8, max: 200 });
	const communicationStyle = requireString(input.communication_style, 'El estilo', { max: 20 });
	if (!USERNAME_PATTERN.test(username)) {
		throw new ValidationError('El usuario solo puede contener letras, números, punto, guion y guion bajo.');
	}
	if (!['formal', 'semiformal', 'friend'].includes(communicationStyle)) {
		throw new ValidationError('El estilo debe ser formal, semiformal o amigo.');
	}
	const paymentMethods = input.payment_methods ?? [];
	if (!Array.isArray(paymentMethods)) throw new ValidationError('Los métodos de pago deben ser una lista.');

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
	const credentials = await hashPassword(password);
	const { businessProfile, ...schedule } = settings;
	try {
		await db.batch([
			db.prepare('INSERT INTO companies (name) VALUES (?1)').bind(businessName),
			db.prepare(
				`INSERT INTO users (company_id, username, password_hash, password_salt, password_iterations, role, must_change_password)
				 VALUES ((SELECT id FROM companies WHERE name = ?1 COLLATE NOCASE), ?2, ?3, ?4, ?5, 'admin', 1)`,
			).bind(businessName, username, credentials.hash, credentials.salt, credentials.iterations),
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
			throw new ValidationError('Ese usuario o negocio ya está registrado.');
		}
		throw error;
	}
	return { businessName, username, mustChangePassword: true };
}
