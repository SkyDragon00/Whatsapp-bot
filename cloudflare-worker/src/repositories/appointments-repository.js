import { ACTIVE_APPOINTMENT_STATUS } from '../config/constants.js';
import { validateAppointmentWindow } from '../domain/availability.js';
import {
	AppointmentConflictError,
	AppointmentNotFoundError,
	AppointmentOwnershipError,
	ValidationError,
} from '../domain/errors.js';
import { addMinutes, getZonedParts, toUtcIso } from '../domain/datetime.js';
import { requirePositiveInteger, requireString, validateCreateAppointmentInput } from '../domain/validation.js';
import { getBusinessSettings } from './settings-repository.js';
import { getServiceById } from './services-repository.js';
import { findOrCreateCustomer } from './customers-repository.js';

export async function listAppointments(db, { includeCancelled = false, limit = 500, companyId = null } = {}) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new ValidationError('El límite de citas no es válido.');
	}
	const filters = ['(?2 IS NULL OR a.company_id = ?2)'];
	if (!includeCancelled) filters.push(`a.status = '${ACTIVE_APPOINTMENT_STATUS}'`);
	const result = await db
		.prepare(
			`SELECT a.*, s.price_cents, COALESCE(SUM(p.amount_cents), 0) AS paid_cents
			 FROM appointments a
			 LEFT JOIN services s ON s.id = a.service_id
			 LEFT JOIN payments p ON p.appointment_id = a.id
			 WHERE ${filters.join(' AND ')}
			 GROUP BY a.id
			 ORDER BY a.start_at, a.id
			 LIMIT ?1`,
		)
		.bind(limit, companyId)
		.all();
	return result.results;
}

export async function findAppointmentsByCustomerName(db, customerName, { limit = 20, companyId = null } = {}) {
	const name = requireString(customerName, 'El nombre del cliente', { min: 2, max: 120 });
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError('El límite de citas no es válido.');
	const result = await db.prepare(
		`SELECT a.id, a.customer_id, a.patient_name, a.service_id, a.service_name, a.service,
		        a.start_at, a.end_at, a.status, a.phone
		 FROM appointments a
		 WHERE a.patient_name LIKE ?1 COLLATE NOCASE AND (?3 IS NULL OR a.company_id = ?3)
		 ORDER BY a.start_at DESC, a.id DESC LIMIT ?2`,
	).bind(`%${name}%`, limit, companyId).all();
	return result.results;
}

export async function listAppointmentsInRange(db, { startAt, endAt, includeCancelled = false, companyId = null }) {
	const start = toUtcIso(startAt, 'El inicio del rango');
	const end = toUtcIso(endAt, 'El final del rango');
	if (start >= end) throw new ValidationError('El rango de fechas no es válido.');
	const statusFilter = includeCancelled ? '' : `AND status = '${ACTIVE_APPOINTMENT_STATUS}'`;
	const result = await db
		.prepare(
			`SELECT * FROM appointments
			 WHERE start_at < ?2 AND end_at > ?1 AND (?3 IS NULL OR company_id = ?3) ${statusFilter}
			 ORDER BY start_at, id`,
		)
		.bind(start, end, companyId)
		.all();
	return result.results;
}

export async function getCustomerAppointments(db, telegramUserId, { includeCancelled = false, limit = 100, companyId = null } = {}) {
	const userId = requireString(telegramUserId, 'El identificador del usuario', { max: 32 });
	if (!/^-?\d+$/.test(userId)) throw new ValidationError('El identificador de Telegram no es válido.');
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError('El límite de citas no es válido.');
	const statusFilter = includeCancelled ? '' : `AND status = '${ACTIVE_APPOINTMENT_STATUS}'`;
	const result = await db
		.prepare(
			`SELECT * FROM appointments
			 WHERE telegram_user_id = ?1 AND (?3 IS NULL OR company_id = ?3) ${statusFilter}
			 ORDER BY start_at, id
			 LIMIT ?2`,
		)
		.bind(userId, limit, companyId)
		.all();
	return result.results;
}

export async function findAppointmentBySourceUpdateId(db, sourceUpdateId) {
	if (!sourceUpdateId) return null;
	return db.prepare('SELECT * FROM appointments WHERE source_update_id = ?1 LIMIT 1').bind(sourceUpdateId).first();
}

export async function getAppointmentById(db, appointmentId) {
	const id = requirePositiveInteger(appointmentId, 'La cita');
	return db.prepare('SELECT * FROM appointments WHERE id = ?1 LIMIT 1').bind(id).first();
}

export async function createAppointment(db, input, { now = new Date(), companyId = undefined } = {}) {
	const appointment = validateCreateAppointmentInput(input);
	const serviceCompany = companyId === undefined
		? await db.prepare('SELECT company_id FROM services WHERE id = ?1').bind(appointment.service_id).first()
		: null;
	const effectiveCompanyId = companyId === undefined ? (serviceCompany?.company_id ?? null) : companyId;
	if (appointment.source_update_id) {
		const existing = await findAppointmentBySourceUpdateId(db, appointment.source_update_id);
		if (existing) return existing;
	}
	const customer = await findOrCreateCustomer(db, {
		full_name: appointment.patient_name,
		telegram_user_id: appointment.telegram_user_id,
		telegram_chat_id: appointment.telegram_chat_id,
		telegram_username: appointment.telegram_username,
		phone: appointment.phone,
	}, { now, companyId: effectiveCompanyId });

	const [service, settings] = await Promise.all([
		getServiceById(db, appointment.service_id, { companyId: effectiveCompanyId }),
		getBusinessSettings(db, { companyId: effectiveCompanyId }),
	]);
	if (!service) throw new ValidationError('El servicio no existe o está deshabilitado.');

	const endAt = addMinutes(appointment.start_at, service.duration_minutes);
	const windowValidation = validateAppointmentWindow({
		startAt: appointment.start_at,
		endAt,
		settings,
		now,
	});
	if (!windowValidation.ok) {
		throw new ValidationError(`El horario solicitado no es válido: ${windowValidation.reason}.`);
	}

	const localStart = getZonedParts(appointment.start_at, settings.businessTimezone);
	const dateText = `${localStart.date} ${localStart.time}`;
	const timestamp = now.toISOString();

	try {
		const created = await db
			.prepare(
				`INSERT INTO appointments (
					telegram_user_id, telegram_chat_id, telegram_username, patient_name,
					service_id, service, service_name, date_text, date_iso,
					start_at, end_at, status, phone, created_at, updated_at, source_update_id, customer_id, company_id
				)
				SELECT
					?1, ?2, ?3, ?4,
					s.id, s.name, s.name, ?5, ?6,
					?7, ?8, '${ACTIVE_APPOINTMENT_STATUS}', ?9, ?10, ?10, ?11, ?13, ?14
				FROM services AS s
				WHERE s.id = ?12
					AND s.enabled = 1
					AND (?14 IS NULL OR s.company_id = ?14)
					AND NOT EXISTS (
						SELECT 1 FROM appointments AS existing
						WHERE existing.status = '${ACTIVE_APPOINTMENT_STATUS}'
							AND existing.company_id IS ?14
							AND existing.start_at < ?8
							AND existing.end_at > ?7
					)
				RETURNING *`,
			)
			.bind(
				appointment.telegram_user_id,
				appointment.telegram_chat_id,
				appointment.telegram_username,
				appointment.patient_name,
				dateText,
				appointment.start_at,
				appointment.start_at,
				endAt,
				appointment.phone,
				timestamp,
				appointment.source_update_id,
				appointment.service_id,
				customer.id,
				effectiveCompanyId,
			)
			.first();

		if (!created) throw new AppointmentConflictError();
		return created;
	} catch (error) {
		const message = String(error?.message ?? '');
		if (appointment.source_update_id) {
			const existing = await findAppointmentBySourceUpdateId(db, appointment.source_update_id);
			if (existing) return existing;
		}
		if (message.includes('appointment_overlap') || error instanceof AppointmentConflictError) {
			throw new AppointmentConflictError();
		}
		throw error;
	}
}

export async function cancelAppointment(db, { appointmentId, telegramUserId, now = new Date(), companyId = null }) {
	const id = requirePositiveInteger(appointmentId, 'La cita');
	const userId = requireString(telegramUserId, 'El identificador del usuario', { max: 32 });
	if (!/^-?\d+$/.test(userId)) throw new ValidationError('El identificador de Telegram no es válido.');

	const cancelled = await db
		.prepare(
			`UPDATE appointments
			 SET status = 'cancelled', updated_at = ?3
			 WHERE id = ?1 AND telegram_user_id = ?2 AND (?4 IS NULL OR company_id = ?4) AND status = '${ACTIVE_APPOINTMENT_STATUS}'
			 RETURNING *`,
		)
		.bind(id, userId, now.toISOString(), companyId)
		.first();
	if (cancelled) return cancelled;

	const existing = await db.prepare('SELECT * FROM appointments WHERE id = ?1 AND (?2 IS NULL OR company_id = ?2) LIMIT 1').bind(id, companyId).first();
	if (!existing) throw new AppointmentNotFoundError();
	if (existing.telegram_user_id !== userId) throw new AppointmentOwnershipError();
	return existing;
}

export async function cancelAppointmentAsAdmin(db, { appointmentId, now = new Date() }) {
	const id = requirePositiveInteger(appointmentId, 'La cita');
	const cancelled = await db
		.prepare(
			`UPDATE appointments
			 SET status = 'cancelled', updated_at = ?2
			 WHERE id = ?1 AND status = '${ACTIVE_APPOINTMENT_STATUS}'
			 RETURNING *`,
		)
		.bind(id, now.toISOString())
		.first();
	if (cancelled) return cancelled;
	const existing = await getAppointmentById(db, id);
	if (!existing) throw new AppointmentNotFoundError();
	return existing;
}

export async function rescheduleAppointmentAsAdmin(
	db,
	{ appointmentId, startAt, serviceId, now = new Date() },
) {
	const id = requirePositiveInteger(appointmentId, 'La cita');
	const normalizedStartAt = toUtcIso(startAt, 'La nueva fecha de inicio');
	const existing = await getAppointmentById(db, id);
	if (!existing) throw new AppointmentNotFoundError();
	if (existing.status !== ACTIVE_APPOINTMENT_STATUS) {
		throw new ValidationError('Solo se pueden reprogramar citas confirmadas.');
	}
	const normalizedServiceId = serviceId === undefined ? existing.service_id : requirePositiveInteger(serviceId, 'El servicio');
	const [service, settings] = await Promise.all([
		getServiceById(db, normalizedServiceId),
		getBusinessSettings(db),
	]);
	if (!service) throw new ValidationError('El servicio no existe o está deshabilitado.');

	const endAt = addMinutes(normalizedStartAt, service.duration_minutes);
	const windowValidation = validateAppointmentWindow({ startAt: normalizedStartAt, endAt, settings, now });
	if (!windowValidation.ok) {
		throw new ValidationError(`El horario solicitado no es válido: ${windowValidation.reason}.`);
	}
	const localStart = getZonedParts(normalizedStartAt, settings.businessTimezone);
	const dateText = `${localStart.date} ${localStart.time}`;

	try {
		const updated = await db
			.prepare(
				`UPDATE appointments
				 SET service_id = ?2, service = ?3, service_name = ?3,
				     date_text = ?4, date_iso = ?5, start_at = ?5, end_at = ?6, updated_at = ?7
				 WHERE id = ?1
				   AND status = '${ACTIVE_APPOINTMENT_STATUS}'
				   AND NOT EXISTS (
				     SELECT 1 FROM appointments AS occupied
				     WHERE occupied.id <> ?1
				       AND occupied.company_id IS appointments.company_id
				       AND occupied.status = '${ACTIVE_APPOINTMENT_STATUS}'
				       AND occupied.start_at < ?6
				       AND occupied.end_at > ?5
				   )
				 RETURNING *`,
			)
			.bind(id, service.id, service.name, dateText, normalizedStartAt, endAt, now.toISOString())
			.first();
		if (!updated) throw new AppointmentConflictError();
		return updated;
	} catch (error) {
		if (String(error?.message ?? '').includes('appointment_overlap') || error instanceof AppointmentConflictError) {
			throw new AppointmentConflictError();
		}
		throw error;
	}
}
