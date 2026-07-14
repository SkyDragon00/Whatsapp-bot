import { findAvailableSlots } from '../domain/availability.js';
import { MAX_AVAILABILITY_RANGE_DAYS } from '../config/constants.js';
import { addDaysToLocalDate, parseLocalDate, zonedDateTimeToUtc } from '../domain/datetime.js';
import { AiProtocolError, DomainError, ValidationError } from '../domain/errors.js';
import { requirePositiveInteger, requireString } from '../domain/validation.js';
import {
	cancelAppointment,
	createAppointment,
	getCustomerAppointments,
	listAppointmentsInRange,
} from '../repositories/appointments-repository.js';
import { getBusinessSettings } from '../repositories/settings-repository.js';
import { listServices, resolveService } from '../repositories/services-repository.js';
import { logError } from '../utils/logging.js';
import { ALLOWED_TOOL_NAMES } from './tool-definitions.js';

function requireArguments(value) {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ValidationError('Los argumentos de la herramienta no son válidos.');
	}
	return value;
}

function assertAllowedKeys(args, allowedKeys) {
	const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.includes(key));
	if (unknownKeys.length > 0) throw new ValidationError('La herramienta recibió argumentos no permitidos.');
}

function assertNoArguments(args) {
	assertAllowedKeys(args, []);
}

function serializeService(service) {
	return {
		id: service.id,
		name: service.name,
		description: service.description,
		duration_minutes: service.duration_minutes,
		price: service.price_cents === null ? null : service.price_cents / 100,
		price_cents: service.price_cents,
		enabled: Boolean(service.enabled),
	};
}

function serializeAppointment(appointment) {
	return {
		id: appointment.id,
		customer_name: appointment.patient_name,
		service_id: appointment.service_id,
		service_name: appointment.service_name,
		start_at: appointment.start_at,
		end_at: appointment.end_at,
		status: appointment.status,
		phone: appointment.phone,
	};
}

function validateFindSlotsArguments(rawArgs) {
	const args = requireArguments(rawArgs);
	assertAllowedKeys(args, ['service_id', 'service_name', 'date', 'date_from', 'date_to', 'period']);
	if (args.service_id === undefined && args.service_name === undefined) {
		throw new ValidationError('Debe indicarse el servicio para buscar disponibilidad.');
	}
	if (args.service_id !== undefined && args.service_name !== undefined) {
		throw new ValidationError('Debe indicarse el ID o el nombre del servicio, no ambos.');
	}
	if (args.date !== undefined && (args.date_from !== undefined || args.date_to !== undefined)) {
		throw new ValidationError('Debe indicarse una fecha única o un rango, no ambos.');
	}
	if (args.date === undefined && args.date_from === undefined) {
		throw new ValidationError('Debe indicarse una fecha para buscar disponibilidad.');
	}
	if (args.date_to !== undefined && args.date_from === undefined) {
		throw new ValidationError('Un rango requiere una fecha inicial.');
	}
	if (args.period !== undefined && !['mañana', 'tarde', 'noche'].includes(args.period)) {
		throw new ValidationError('El periodo no es válido.');
	}

	return {
		serviceId: args.service_id === undefined ? undefined : requirePositiveInteger(args.service_id, 'El servicio'),
		serviceName:
			args.service_name === undefined
				? undefined
				: requireString(args.service_name, 'El nombre del servicio', { min: 2, max: 100 }),
		dateFrom: requireString(args.date ?? args.date_from, 'La fecha inicial', { max: 10 }),
		dateTo: requireString(args.date ?? args.date_to ?? args.date_from, 'La fecha final', { max: 10 }),
		period: args.period,
	};
}

async function findSlots(args, context) {
	const input = validateFindSlotsArguments(args);
	const parsedStart = parseLocalDate(input.dateFrom);
	const parsedEnd = parseLocalDate(input.dateTo);
	const rangeDays =
		(Date.UTC(parsedEnd.year, parsedEnd.month - 1, parsedEnd.day) -
			Date.UTC(parsedStart.year, parsedStart.month - 1, parsedStart.day)) /
		86_400_000;
	if (rangeDays < 0 || rangeDays >= MAX_AVAILABILITY_RANGE_DAYS) {
		throw new ValidationError(`El rango no puede superar ${MAX_AVAILABILITY_RANGE_DAYS} días.`);
	}
	const [service, settings] = await Promise.all([
		resolveService(context.env.DB, {
			serviceId: input.serviceId,
			serviceName: input.serviceName,
		}),
		getBusinessSettings(context.env.DB),
	]);
	if (!service) throw new ValidationError('El servicio no existe o está deshabilitado.');

	const rangeStart = zonedDateTimeToUtc(input.dateFrom, '00:00', settings.businessTimezone);
	const rangeEnd = zonedDateTimeToUtc(addDaysToLocalDate(input.dateTo, 1), '00:00', settings.businessTimezone);
	const appointments = await listAppointmentsInRange(context.env.DB, {
		startAt: rangeStart,
		endAt: rangeEnd,
	});
	const slots = findAvailableSlots({
		dateFrom: input.dateFrom,
		dateTo: input.dateTo,
		period: input.period,
		serviceDurationMinutes: service.duration_minutes,
		settings,
		appointments,
		now: context.now,
	});

	return { service: serializeService(service), slots };
}

async function createAppointmentTool(rawArgs, context) {
	const args = requireArguments(rawArgs);
	assertAllowedKeys(args, ['customer_name', 'service_id', 'start_datetime', 'phone']);
	const created = await createAppointment(
		context.env.DB,
		{
			telegram_user_id: context.telegram.userId,
			telegram_chat_id: context.telegram.chatId,
			telegram_username: context.telegram.username,
			customer_name: args.customer_name,
			service_id: args.service_id,
			start_datetime: args.start_datetime,
			phone: args.phone,
			source_update_id: context.sourceUpdateId,
		},
		{ now: context.now },
	);
	return { appointment: serializeAppointment(created) };
}

async function cancelAppointmentTool(rawArgs, context) {
	const args = requireArguments(rawArgs);
	assertAllowedKeys(args, ['appointment_id']);
	const appointment = await cancelAppointment(context.env.DB, {
		appointmentId: args.appointment_id,
		telegramUserId: context.telegram.userId,
		now: context.now,
	});
	return { appointment: serializeAppointment(appointment) };
}

export function isAllowedToolName(name) {
	return typeof name === 'string' && ALLOWED_TOOL_NAMES.has(name);
}

export async function executeTool(name, rawArgs, context) {
	if (!isAllowedToolName(name)) throw new AiProtocolError('Gemini intentó usar una herramienta desconocida.');
	const args = requireArguments(rawArgs);

	switch (name) {
		case 'get_business_settings': {
			assertNoArguments(args);
			return getBusinessSettings(context.env.DB);
		}
		case 'list_services': {
			assertNoArguments(args);
			const services = await listServices(context.env.DB, { limit: 50 });
			return { services: services.map(serializeService) };
		}
		case 'find_available_slots':
			return findSlots(args, context);
		case 'create_appointment':
			return createAppointmentTool(args, context);
		case 'get_customer_appointments': {
			assertNoArguments(args);
			const appointments = await getCustomerAppointments(context.env.DB, context.telegram.userId, { limit: 20 });
			return { appointments: appointments.map(serializeAppointment) };
		}
		case 'cancel_appointment':
			return cancelAppointmentTool(args, context);
		default:
			throw new AiProtocolError();
	}
}

export async function executeToolSafely(name, args, context) {
	try {
		return { ok: true, data: await executeTool(name, args, context) };
	} catch (error) {
		if (error instanceof AiProtocolError) throw error;
		if (error instanceof DomainError) {
			return { ok: false, error: { code: error.code, message: error.message } };
		}
		logError('tool_execution_failed', error, { tool: name });
		return {
			ok: false,
			error: { code: 'INTERNAL_TOOL_ERROR', message: 'No se pudo completar la operación.' },
		};
	}
}
