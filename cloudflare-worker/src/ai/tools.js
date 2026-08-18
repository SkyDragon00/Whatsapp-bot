import { findAvailableSlots } from '../domain/availability.js';
import { MAX_AVAILABILITY_RANGE_DAYS } from '../config/constants.js';
import { addDaysToLocalDate, getZonedParts, parseLocalDate, parseTimeToMinutes, zonedDateTimeToUtc } from '../domain/datetime.js';
import { AiProtocolError, DomainError, ValidationError } from '../domain/errors.js';
import { requirePositiveInteger, requireString } from '../domain/validation.js';
import {
	cancelAppointment,
	createAppointment,
	findAppointmentsByCustomerName,
	getCustomerAppointments,
	listAppointmentsInRange,
} from '../repositories/appointments-repository.js';
import { getBotBusinessSettings, getBusinessSettings, updateBotCommunicationStyle } from '../repositories/settings-repository.js';
import { createOwnerChatPayment } from '../repositories/payments-repository.js';
import { isTransfer } from '../domain/banking.js';
import { getExpenseSummary, getFinancialSummary, getOutstandingBalances } from '../repositories/financial-repository.js';
import { listServices, resolveService } from '../repositories/services-repository.js';
import { logError } from '../utils/logging.js';
import { ALLOWED_TOOL_NAMES } from './tool-definitions.js';
import { registerOnboardingBusiness } from '../onboarding/register-business.js';

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

function requireOwnerAuthorization(context) {
	if (context.ownerAuthorized === false) {
		throw new ValidationError('Este número de teléfono no está autorizado como dueño de la empresa.');
	}
}

export function isExplicitConfirmation(message) {
	const normalized = String(message ?? '').trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	if (/\b(no|incorrecto|aun no|todavia no)\b/.test(normalized)) return false;
	return /\b(si|confirmo|correcto|esta bien|todo esta bien|de acuerdo|adelante|procede|listo)\b/.test(normalized);
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
	assertAllowedKeys(args, ['service_id', 'service_name', 'date', 'date_from', 'date_to', 'period', 'time']);
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
	if (args.period !== undefined && args.time !== undefined) {
		throw new ValidationError('Debe indicarse una hora exacta o un periodo, no ambos.');
	}
	const time = args.time === undefined ? undefined : requireString(args.time, 'La hora exacta', { max: 5 });
	if (time !== undefined && parseTimeToMinutes(time) === null) {
		throw new ValidationError('La hora exacta debe usar el formato HH:MM.');
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
		time,
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
		}, { companyId: context.companyId }),
		getBusinessSettings(context.env.DB, { companyId: context.companyId }),
	]);
	if (!service) throw new ValidationError('El servicio no existe o está deshabilitado.');

	const rangeStart = zonedDateTimeToUtc(input.dateFrom, '00:00', settings.businessTimezone);
	const rangeEnd = zonedDateTimeToUtc(addDaysToLocalDate(input.dateTo, 1), '00:00', settings.businessTimezone);
	const appointments = await listAppointmentsInRange(context.env.DB, {
		startAt: rangeStart,
		endAt: rangeEnd,
		companyId: context.companyId,
	});
	const slots = findAvailableSlots({
		dateFrom: input.dateFrom,
		dateTo: input.dateTo,
		period: input.period,
		time: input.time,
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
	const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
	if (settings.aiMode === 'client' && !isExplicitConfirmation(context.userMessage)) {
		throw new ValidationError('Antes de agendar, muestra todos los datos de la cita y espera una confirmación explícita del cliente.');
	}
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
		{ now: context.now, companyId: context.companyId },
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
		companyId: context.companyId,
	});
	return { appointment: serializeAppointment(appointment) };
}

async function registerPaymentTool(rawArgs, context) {
	requireOwnerAuthorization(context);
	const args = requireArguments(rawArgs);
	assertAllowedKeys(args, ['appointment_id', 'payment_date', 'amount', 'payment_method', 'bank', 'billing_type', 'cedula_ruc', 'address', 'phone', 'notes']);
	const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
	if (settings.aiMode !== 'owner') {
		throw new ValidationError('Registrar pagos solo está disponible en modo dueño.');
	}
	const payment = await createOwnerChatPayment(context.env.DB, {
		...args,
		telegram_user_id: context.telegram.userId,
		telegram_chat_id: context.telegram.chatId,
		telegram_username: context.telegram.username,
		source_update_id: context.sourceUpdateId,
	}, { now: context.now, companyId: context.companyId });
	if (isTransfer(payment.payment_method)) {
		await context.env.CONVERSATIONS.put(
			`pending-payment-receipt:${context.telegram.chatId}`,
			JSON.stringify({ paymentId: payment.id }),
			{ expirationTtl: 86_400 },
		);
	}
	return {
		payment: {
			id: payment.id,
			payment_date: payment.payment_date,
			customer_name: payment.customer_name,
			appointment_id: payment.appointment_id,
			service_id: payment.service_id,
			service_name: payment.service_name,
			amount: payment.amount_cents / 100,
			payment_method: payment.payment_method,
			bank: payment.bank,
			awaiting_receipt: isTransfer(payment.payment_method),
			billing_type: payment.billing_type,
			cedula_ruc: payment.cedula_ruc,
			address: payment.address,
			phone: payment.phone,
			notes: payment.notes,
		},
	};
}

export function isAllowedToolName(name) {
	return typeof name === 'string' && ALLOWED_TOOL_NAMES.has(name);
}

export async function executeTool(name, rawArgs, context) {
	if (!isAllowedToolName(name)) throw new AiProtocolError('Gemini intentó usar una herramienta desconocida.');
	const args = requireArguments(rawArgs);

	switch (name) {
		case 'register_business_from_onboarding': {
			assertAllowedKeys(args, ['business_name', 'username', 'communication_style', 'address', 'arrival_instructions', 'cancellation_policy', 'general_notes', 'payment_methods']);
			const settings = await getBotBusinessSettings(context.env.DB);
			if (!settings.onboardingEnabled) throw new ValidationError('El modo onboarding está desactivado.');
			if (!isExplicitConfirmation(context.userMessage)) {
				throw new ValidationError('Antes de registrar, muestra el resumen y espera una confirmación explícita del usuario.');
			}
			return registerOnboardingBusiness(context.env.DB, {
				...args,
				...(context.onboardingIdentity?.businessName ? { business_name: context.onboardingIdentity.businessName } : {}),
				...(context.onboardingIdentity?.username ? { username: context.onboardingIdentity.username } : {}),
				...(context.onboardingIdentity?.communicationStyle ? { communication_style: context.onboardingIdentity.communicationStyle } : {}),
			}, { ownerPhone: context.whatsappPhone ?? null });
		}
		case 'get_business_settings': {
			assertNoArguments(args);
			return getBusinessSettings(context.env.DB, { companyId: context.companyId });
		}
		case 'set_communication_style': {
			requireOwnerAuthorization(context);
			assertAllowedKeys(args, ['style']);
			const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
			if (settings.aiMode !== 'owner') {
				throw new ValidationError('Cambiar la personalidad solo está disponible en modo dueño.');
			}
			const style = requireString(args.style, 'El estilo de comunicación', { max: 20 });
			if (!['formal', 'semiformal', 'friend'].includes(style)) {
				throw new ValidationError('El estilo debe ser formal, semiformal o amigo.');
			}
			const updated = await updateBotCommunicationStyle(context.env.DB, style, { companyId: context.companyId });
			return { communicationStyle: updated.businessProfile.communicationStyle };
		}
		case 'list_services': {
			assertNoArguments(args);
			const services = await listServices(context.env.DB, { limit: 50, companyId: context.companyId });
			return { services: services.map(serializeService) };
		}
		case 'find_available_slots':
			return findSlots(args, context);
		case 'create_appointment':
			return createAppointmentTool(args, context);
		case 'get_customer_appointments': {
			assertNoArguments(args);
			const appointments = await getCustomerAppointments(context.env.DB, context.telegram.userId, { limit: 20, companyId: context.companyId });
			return { appointments: appointments.map(serializeAppointment) };
		}
		case 'find_customer_appointments': {
			requireOwnerAuthorization(context);
			assertAllowedKeys(args, ['customer_name']);
			const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
			if (settings.aiMode !== 'owner') throw new ValidationError('Buscar citas de clientes solo está disponible en modo dueño.');
			const appointments = await findAppointmentsByCustomerName(context.env.DB, args.customer_name, { companyId: context.companyId });
			return { appointments: appointments.map(serializeAppointment) };
		}
		case 'get_outstanding_balances': {
			requireOwnerAuthorization(context);
			assertAllowedKeys(args, ['customer_name']);
			const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
			if (settings.aiMode !== 'owner') {
				throw new ValidationError('Consultar deudas solo está disponible en modo dueño.');
			}
			return getOutstandingBalances(context.env.DB, { customerName: args.customer_name, companyId: context.companyId });
		}
		case 'get_expense_summary': {
			requireOwnerAuthorization(context);
			assertAllowedKeys(args, ['date_from', 'date_to', 'category', 'search']);
			const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
			if (settings.aiMode !== 'owner') {
				throw new ValidationError('Consultar gastos solo está disponible en modo dueño.');
			}
			return getExpenseSummary(context.env.DB, {
				dateFrom: args.date_from,
				dateTo: args.date_to,
				category: args.category,
				search: args.search,
				companyId: context.companyId,
			});
		}
		case 'get_financial_summary': {
			requireOwnerAuthorization(context);
			assertAllowedKeys(args, ['date_from', 'date_to']);
			const settings = await getBusinessSettings(context.env.DB, { companyId: context.companyId });
			if (settings.aiMode !== 'owner') {
				throw new ValidationError('Consultar el resumen financiero solo está disponible en modo dueño.');
			}
			return getFinancialSummary(context.env.DB, {
				dateFrom: args.date_from,
				dateTo: args.date_to,
				companyId: context.companyId,
			});
		}
		case 'cancel_appointment':
			return cancelAppointmentTool(args, context);
		case 'register_payment':
			return registerPaymentTool(args, context);
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
