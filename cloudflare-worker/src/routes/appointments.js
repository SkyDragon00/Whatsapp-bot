import { ValidationError } from '../domain/errors.js';
import {
	cancelAppointmentAsAdmin,
	listAppointments,
	rescheduleAppointmentAsAdmin,
} from '../repositories/appointments-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

function serializeAppointment(appointment) {
	const customerName = appointment.patient_name ?? appointment.customer_name ?? '';
	const serviceName = appointment.service_name ?? appointment.service ?? '';
	const startAt = appointment.start_at ?? appointment.date_iso;
	return {
		...appointment,
		customer_name: customerName,
		patient_name: customerName,
		service_name: serviceName,
		service: serviceName,
		start_at: startAt,
		date_iso: startAt,
		origin: appointment.telegram_user_id ? 'telegram' : 'admin',
	};
}

function requireBodyObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ValidationError('La operación de cita debe ser un objeto.');
	}
	return value;
}

export async function handleAppointmentsApi(request, env, url) {
	if (request.method === 'GET' && url.pathname === '/api/appointments') {
		const includeCancelled = url.searchParams.get('include_cancelled') === 'true';
		const appointments = await listAppointments(env.DB, { includeCancelled });
		return jsonResponse(appointments.map(serializeAppointment));
	}

	const action = /^\/api\/appointments\/(\d+)\/(cancel|reschedule)$/.exec(url.pathname);
	if (request.method !== 'POST' || !action) return null;
	const appointmentId = Number(action[1]);
	if (action[2] === 'cancel') {
		const body = requireBodyObject(await readJsonWithLimit(request, 4_000));
		if (Object.keys(body).length > 0) throw new ValidationError('La cancelación no acepta campos adicionales.');
		return jsonResponse(serializeAppointment(await cancelAppointmentAsAdmin(env.DB, { appointmentId })));
	}

	const body = requireBodyObject(await readJsonWithLimit(request, 8_000));
	const unknownKeys = Object.keys(body).filter((key) => !['start_at', 'service_id'].includes(key));
	if (unknownKeys.length > 0) throw new ValidationError('La reprogramación contiene campos no permitidos.');
	if (body.start_at === undefined) throw new ValidationError('Debe indicarse la nueva fecha de inicio.');
	return jsonResponse(
		serializeAppointment(
			await rescheduleAppointmentAsAdmin(env.DB, {
				appointmentId,
				startAt: body.start_at,
				serviceId: body.service_id,
			}),
		),
	);
}
