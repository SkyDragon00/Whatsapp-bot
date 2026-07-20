import { DEFAULT_BUSINESS_SETTINGS } from '../config/constants.js';
import { ValidationError } from './errors.js';
import { isValidIanaTimeZone, parseLocalDate, parseTimeToMinutes, toUtcIso } from './datetime.js';

function cloneDefaultSettings() {
	return JSON.parse(JSON.stringify(DEFAULT_BUSINESS_SETTINGS));
}

function requireObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ValidationError(`${label} debe ser un objeto.`);
	}
	return value;
}

function assertAllowedKeys(value, allowedKeys, label) {
	const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length > 0) throw new ValidationError(`${label} contiene campos no permitidos.`);
}

export function requireString(value, label, { min = 1, max = 255, optional = false } = {}) {
	if (optional && (value === undefined || value === null || value === '')) return null;
	if (typeof value !== 'string') throw new ValidationError(`${label} debe ser texto.`);
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new ValidationError(`${label} debe tener entre ${min} y ${max} caracteres.`);
	}
	return normalized;
}

export function requirePositiveInteger(value, label) {
	const normalized = Number(value);
	if (!Number.isInteger(normalized) || normalized <= 0) {
		throw new ValidationError(`${label} debe ser un entero positivo.`);
	}
	return normalized;
}

export function normalizeBusinessSettings(input) {
	const value = requireObject(input, 'La configuración');
	assertAllowedKeys(
		value,
		new Set([
			'aiMode',
			'appointmentDurationMinutes',
			'businessTimezone',
			'slotIntervalMinutes',
			'minimumBookingNoticeMinutes',
			'maximumAdvanceBookingDays',
			'closedDates',
			'businessHours',
			'businessProfile',
		]),
		'La configuración',
	);
	const duration = Number(value.appointmentDurationMinutes);
	const aiMode = value.aiMode ?? DEFAULT_BUSINESS_SETTINGS.aiMode;
	if (!['client', 'owner'].includes(aiMode)) {
		throw new ValidationError('El modo de IA debe ser cliente o dueño.');
	}
	if (!Number.isInteger(duration) || duration < 15 || duration > 480) {
		throw new ValidationError('La duración predeterminada debe estar entre 15 y 480 minutos.');
	}

	const slotInterval = Number(value.slotIntervalMinutes ?? DEFAULT_BUSINESS_SETTINGS.slotIntervalMinutes);
	if (!Number.isInteger(slotInterval) || slotInterval < 5 || slotInterval > 120) {
		throw new ValidationError('El intervalo de espacios debe estar entre 5 y 120 minutos.');
	}

	const minimumBookingNoticeMinutes = Number(
		value.minimumBookingNoticeMinutes ?? DEFAULT_BUSINESS_SETTINGS.minimumBookingNoticeMinutes,
	);
	if (!Number.isInteger(minimumBookingNoticeMinutes) || minimumBookingNoticeMinutes < 0 || minimumBookingNoticeMinutes > 43_200) {
		throw new ValidationError('La anticipación mínima debe estar entre 0 y 43200 minutos.');
	}

	const maximumAdvanceBookingDays = Number(
		value.maximumAdvanceBookingDays ?? DEFAULT_BUSINESS_SETTINGS.maximumAdvanceBookingDays,
	);
	if (!Number.isInteger(maximumAdvanceBookingDays) || maximumAdvanceBookingDays < 1 || maximumAdvanceBookingDays > 365) {
		throw new ValidationError('El máximo de días futuros debe estar entre 1 y 365.');
	}

	const businessTimezone = requireString(
		value.businessTimezone ?? DEFAULT_BUSINESS_SETTINGS.businessTimezone,
		'La zona horaria',
		{ max: 100 },
	);
	if (!isValidIanaTimeZone(businessTimezone)) {
		throw new ValidationError('La zona horaria no es una zona IANA válida.');
	}

	if (!Array.isArray(value.businessHours) || value.businessHours.length !== 7) {
		throw new ValidationError('Deben configurarse los 7 días de la semana.');
	}

	const hoursByDay = new Map();
	for (const rawEntry of value.businessHours) {
		const entry = requireObject(rawEntry, 'Cada horario');
		const day = Number(entry.day);
		const start = requireString(entry.start, 'La hora de apertura', { max: 5 });
		const end = requireString(entry.end, 'La hora de cierre', { max: 5 });
		const startMinutes = parseTimeToMinutes(start);
		const endMinutes = parseTimeToMinutes(end);

		if (!Number.isInteger(day) || day < 0 || day > 6 || hoursByDay.has(day)) {
			throw new ValidationError('Los días de atención no son válidos.');
		}
		if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
			throw new ValidationError('Cada horario debe tener una apertura anterior al cierre.');
		}

		hoursByDay.set(day, {
			day,
			enabled: Boolean(entry.enabled),
			start,
			end,
		});
	}

	const rawClosedDates = value.closedDates ?? [];
	if (!Array.isArray(rawClosedDates) || rawClosedDates.length > 366) {
		throw new ValidationError('Los días cerrados deben ser una lista válida.');
	}
	const closedDates = [...new Set(rawClosedDates.map((date) => parseLocalDate(date).date))].sort();

	return {
		aiMode,
		appointmentDurationMinutes: duration,
		businessTimezone,
		slotIntervalMinutes: slotInterval,
		minimumBookingNoticeMinutes,
		maximumAdvanceBookingDays,
		closedDates,
		businessHours: Array.from({ length: 7 }, (_, day) => hoursByDay.get(day)),
		businessProfile: normalizeBusinessProfile(value.businessProfile),
	};
}

export function normalizeBusinessProfile(input = DEFAULT_BUSINESS_SETTINGS.businessProfile) {
	const value = requireObject(input ?? {}, 'El perfil del negocio');
	assertAllowedKeys(
		value,
		new Set([
			'businessName',
			'communicationStyle',
			'preferredTone',
			'greeting',
			'address',
			'contactPhone',
			'cancellationPolicy',
			'arrivalInstructions',
			'generalNotes',
			'acceptedPaymentMethods',
		]),
		'El perfil del negocio',
	);
	const rawPaymentMethods = value.acceptedPaymentMethods ?? [];
	if (!Array.isArray(rawPaymentMethods) || rawPaymentMethods.length > 20) {
		throw new ValidationError('Los métodos de pago deben ser una lista válida.');
	}
	const acceptedPaymentMethods = [
		...new Set(rawPaymentMethods.map((method) => requireString(method, 'Cada método de pago', { max: 50 }))),
	];
	const communicationStyle = value.communicationStyle ?? DEFAULT_BUSINESS_SETTINGS.businessProfile.communicationStyle;
	if (!['formal', 'semiformal', 'friend'].includes(communicationStyle)) {
		throw new ValidationError('El estilo de comunicación debe ser formal, semiformal o amigo.');
	}
	return {
		businessName: requireString(value.businessName, 'El nombre comercial', { max: 120, optional: true }),
		communicationStyle,
		preferredTone: requireString(value.preferredTone, 'El tono preferido', { max: 120, optional: true }),
		greeting: requireString(value.greeting, 'El saludo', { max: 300, optional: true }),
		address: requireString(value.address, 'La dirección', { max: 300, optional: true }),
		contactPhone: requireString(value.contactPhone, 'El teléfono de contacto', { max: 40, optional: true }),
		cancellationPolicy: requireString(value.cancellationPolicy, 'La política de cancelación', { max: 1_000, optional: true }),
		arrivalInstructions: requireString(value.arrivalInstructions, 'Las instrucciones para llegar', { max: 1_000, optional: true }),
		generalNotes: requireString(value.generalNotes, 'Las notas generales', { max: 1_000, optional: true }),
		acceptedPaymentMethods,
	};
}

export function parseStoredBusinessSettings(rawValue, rawProfileValue) {
	if (typeof rawValue !== 'string') return cloneDefaultSettings();
	try {
		const parsed = JSON.parse(rawValue);
		const profile = typeof rawProfileValue === 'string' ? JSON.parse(rawProfileValue) : parsed.businessProfile;
		return normalizeBusinessSettings({ ...cloneDefaultSettings(), ...parsed, businessProfile: profile ?? {} });
	} catch {
		return cloneDefaultSettings();
	}
}

export function validateServiceInput(input, { partial = false } = {}) {
	const value = requireObject(input, 'El servicio');
	const result = {};

	if (!partial || value.name !== undefined) {
		result.name = requireString(value.name, 'El nombre del servicio', { min: 2, max: 100 });
	}
	if (!partial || value.duration_minutes !== undefined) {
		const duration = Number(value.duration_minutes);
		if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
			throw new ValidationError('La duración del servicio debe estar entre 5 y 480 minutos.');
		}
		result.duration_minutes = duration;
	}
	if (!partial || value.description !== undefined) {
		result.description = requireString(value.description, 'La descripción', { max: 500, optional: true });
	}
	if (!partial || value.price_cents !== undefined) {
		if (value.price_cents === undefined || value.price_cents === null || value.price_cents === '') {
			result.price_cents = null;
		} else {
			const price = Number(value.price_cents);
			if (!Number.isInteger(price) || price < 0 || price > 100_000_000) {
				throw new ValidationError('El precio del servicio no es válido.');
			}
			result.price_cents = price;
		}
	}
	if (!partial || value.enabled !== undefined) result.enabled = value.enabled === false || value.enabled === 0 ? 0 : 1;

	if (partial && Object.keys(result).length === 0) {
		throw new ValidationError('Debe indicarse al menos un campo para actualizar.');
	}
	return result;
}

export function validateCreateAppointmentInput(input) {
	const value = requireObject(input, 'La cita');
	const telegramUserId = requireString(value.telegram_user_id, 'El identificador del usuario', { max: 32 });
	const telegramChatId = requireString(value.telegram_chat_id, 'El identificador del chat', { max: 32 });
	if (!/^-?\d+$/.test(telegramUserId) || !/^-?\d+$/.test(telegramChatId)) {
		throw new ValidationError('Los identificadores de Telegram no son válidos.');
	}

	return {
		telegram_user_id: telegramUserId,
		telegram_chat_id: telegramChatId,
		telegram_username: requireString(value.telegram_username, 'El usuario de Telegram', { max: 64, optional: true }),
		patient_name: requireString(value.customer_name ?? value.patient_name, 'El nombre del cliente', { min: 2, max: 120 }),
		service_id: requirePositiveInteger(value.service_id, 'El servicio'),
		start_at: toUtcIso(value.start_datetime ?? value.start_at, 'La fecha de inicio'),
		phone: requireString(value.phone, 'El teléfono', { max: 32, optional: true }),
		source_update_id: requireString(value.source_update_id, 'El identificador de actualización', { max: 64, optional: true }),
	};
}
