import { hashPassword } from '../auth/passwords.js';
import { DEFAULT_BUSINESS_HOURS, DEFAULT_BUSINESS_SETTINGS } from '../config/constants.js';
import { ValidationError } from '../domain/errors.js';
import { normalizeBusinessSettings, requireString, validateServiceInput } from '../domain/validation.js';
import { normalizePhoneE164 } from '../repositories/user-identity-repository.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;
export const DEFAULT_ONBOARDING_PASSWORD = '12345678';

function optionalText(value, label, maximum) {
	return requireString(value, label, { max: maximum, optional: true });
}

function normalizeOnboardingServices(input) {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw new ValidationError('Los servicios deben enviarse como una lista.');
	if (input.length > 50) throw new ValidationError('No se pueden registrar más de 50 servicios durante el onboarding.');
	const services = input.map((rawService, index) => {
		const position = `El servicio ${index + 1}`;
		if (!rawService || typeof rawService !== 'object' || Array.isArray(rawService)) {
			throw new ValidationError(`${position} no es válido: debe incluir nombre, descripción, duración en minutos y precio.`);
		}
		const labels = { name: 'el nombre', description: 'la descripción', duration_minutes: 'la duración en minutos', price: 'el precio' };
		for (const field of Object.keys(labels)) {
			if (rawService[field] === undefined || rawService[field] === null || rawService[field] === '') {
				throw new ValidationError(`${position} no está completo: falta ${labels[field]}.`);
			}
		}
		const price = Number(rawService.price);
		if (!Number.isFinite(price) || price < 0 || price > 1_000_000 || Math.round(price * 100) !== price * 100) {
			throw new ValidationError(`${position} tiene un precio no válido: debe ser un valor entre 0 y 1.000.000 con máximo dos decimales.`);
		}
		try {
			return validateServiceInput({
				name: rawService.name,
				description: rawService.description,
				duration_minutes: rawService.duration_minutes,
				price_cents: Math.round(price * 100),
				enabled: true,
			});
		} catch (error) {
			if (error instanceof ValidationError) throw new ValidationError(`${position} no es válido: ${error.message}`);
			throw error;
		}
	});
	const names = new Set();
	for (const service of services) {
		const name = service.name.toLocaleLowerCase('es');
		if (names.has(name)) throw new ValidationError(`El servicio "${service.name}" está repetido.`);
		names.add(name);
	}
	return services;
}

function normalizeOnboardingHours(input) {
	if (input === undefined) return DEFAULT_BUSINESS_HOURS.map((entry) => ({ ...entry }));
	if (!Array.isArray(input)) throw new ValidationError('El horario debe enviarse como una lista de días.');
	if (input.length === 0) throw new ValidationError('El horario no puede estar vacío. Indica al menos un día de atención.');
	const days = new Map();
	for (const entry of input) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new ValidationError('Cada día del horario debe indicar día, hora de apertura y hora de cierre.');
		}
		const day = Number(entry.day);
		if (!Number.isInteger(day) || day < 0 || day > 6) {
			throw new ValidationError('El día del horario no es válido: usa 0 para domingo hasta 6 para sábado.');
		}
		if (days.has(day)) throw new ValidationError(`El día ${day} aparece repetido en el horario.`);
		if (entry.start === undefined || entry.end === undefined) {
			throw new ValidationError(`El horario del día ${day} está incompleto: faltan la hora de apertura o de cierre.`);
		}
		days.set(day, { day, enabled: true, start: entry.start, end: entry.end });
	}
	const businessHours = Array.from({ length: 7 }, (_, day) => days.get(day) ?? {
		day, enabled: false, start: '09:00', end: '17:00',
	});
	try {
		return normalizeBusinessSettings({ ...DEFAULT_BUSINESS_SETTINGS, businessHours }).businessHours;
	} catch (error) {
		if (error instanceof ValidationError) throw new ValidationError(`El horario no es válido: ${error.message}`);
		throw error;
	}
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
	const communicationStyle = 'semiformal';
	if (!USERNAME_PATTERN.test(username)) {
		throw new ValidationError('El usuario solo puede contener letras, números, punto, guion y guion bajo.');
	}
	const paymentMethods = input.payment_methods ?? [];
	if (!Array.isArray(paymentMethods)) throw new ValidationError('Los métodos de pago deben ser una lista.');
	const services = normalizeOnboardingServices(input.services);
	const businessHours = normalizeOnboardingHours(input.business_hours);

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
		businessHours,
		businessProfile: {
			...DEFAULT_BUSINESS_SETTINGS.businessProfile,
			businessName,
			communicationStyle,
			address: optionalText(input.address ?? input.location, 'La dirección o ubicación', 300),
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
			...services.map((service) => db.prepare(
				`INSERT INTO services (name, description, duration_minutes, price_cents, enabled, company_id)
				 VALUES (?1, ?2, ?3, ?4, ?5, (SELECT id FROM companies WHERE name = ?6 COLLATE NOCASE))`,
			).bind(service.name, service.description, service.duration_minutes, service.price_cents, service.enabled, businessName)),
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
	return { businessName, username, mustChangePassword: true, servicesCount: services.length };
}
