import { AppointmentNotFoundError, ValidationError } from '../domain/errors.js';
import {
	cancelAppointmentAsAdmin,
	listAppointments,
	rescheduleAppointmentAsAdmin,
} from '../repositories/appointments-repository.js';
import { createAppointmentPayment } from '../repositories/payments-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

function serializeAppointment(appointment) {
	const customerName = appointment.patient_name ?? appointment.customer_name ?? '';
	const serviceName = appointment.service_name ?? appointment.service ?? '';
	const startAt = appointment.start_at ?? appointment.date_iso;
	const priceCents = appointment.price_cents == null ? null : Number(appointment.price_cents);
	const paidCents = Number(appointment.paid_cents || 0);
	return {
		...appointment,
		customer_name: customerName,
		patient_name: customerName,
		service_name: serviceName,
		service: serviceName,
		start_at: startAt,
		date_iso: startAt,
		origin: appointment.telegram_user_id ? 'telegram' : 'admin',
		price_cents: priceCents,
		price: priceCents == null ? null : priceCents / 100,
		paid_cents: paidCents,
		paid: paidCents / 100,
		payment_status: paidCents <= 0 ? 'unpaid' : priceCents != null && paidCents >= priceCents ? 'paid' : 'partial',
	};
}

function requireBodyObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ValidationError('La operación de cita debe ser un objeto.');
	}
	return value;
}

export async function handleAppointmentsApi(request, env, url, companyId) {
	if (request.method === 'GET' && url.pathname === '/api/appointments') {
		const includeCancelled = url.searchParams.get('include_cancelled') === 'true';
		const appointments = await listAppointments(env.DB, { includeCancelled, companyId });
		return jsonResponse(appointments.map(serializeAppointment));
	}

	const action = /^\/api\/appointments\/(\d+)\/(cancel|reschedule|payment)$/.exec(url.pathname);
	if (request.method !== 'POST' || !action) return null;
	const appointmentId = Number(action[1]);
	const ownedAppointment = await env.DB.prepare(
		'SELECT id FROM appointments WHERE id = ?1 AND (?2 IS NULL OR company_id = ?2)',
	).bind(appointmentId, companyId).first();
	if (!ownedAppointment) throw new AppointmentNotFoundError();
	if (action[2] === 'cancel') {
		const body = requireBodyObject(await readJsonWithLimit(request, 4_000));
		if (Object.keys(body).length > 0) throw new ValidationError('La cancelación no acepta campos adicionales.');
		return jsonResponse(serializeAppointment(await cancelAppointmentAsAdmin(env.DB, { appointmentId })));
	}
	if (action[2] === 'payment') {
		const body = requireBodyObject(await readJsonWithLimit(request, 4_000));
		const unknownKeys = Object.keys(body).filter((key) => !['payment_date', 'amount', 'payment_method', 'bank', 'notes'].includes(key));
		if (unknownKeys.length) throw new ValidationError('El pago contiene campos no permitidos.');
		const payment = await createAppointmentPayment(env.DB, { ...body, appointment_id: appointmentId });
		if (!payment) throw new AppointmentNotFoundError();
		return jsonResponse(payment, 201);
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
