import { ValidationError } from '../domain/errors.js';
import { requirePositiveInteger, requireString } from '../domain/validation.js';

function requirePaymentDate(value) {
	const normalized = requireString(value, 'La fecha del pago', { max: 10 });
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
	if (!match) throw new ValidationError('La fecha del pago debe tener el formato AAAA-MM-DD.');
	const [year, month, day] = match.slice(1).map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
		throw new ValidationError('La fecha del pago no es válida.');
	}
	return normalized;
}

export async function createPayment(db, input, { now = new Date() } = {}) {
	const amountCents = Math.round(Number(input.amount) * 100);
	if (!Number.isFinite(Number(input.amount)) || amountCents < 1 || Math.abs(Number(input.amount) * 100 - amountCents) > 0.000001) {
		throw new ValidationError('El monto debe ser mayor que cero y tener máximo dos decimales.');
	}
	return db.prepare(
		`INSERT INTO payments (
			payment_date, customer_name, amount_cents, payment_method, notes,
			telegram_user_id, telegram_chat_id, telegram_username, source_update_id, created_at
		 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
		 RETURNING *`,
	).bind(
		requirePaymentDate(input.payment_date),
		requireString(input.customer_name, 'El nombre del cliente', { min: 2, max: 120 }),
		amountCents,
		requireString(input.payment_method, 'El método de pago', { min: 2, max: 60 }),
		requireString(input.notes, 'Las notas', { max: 1_000, optional: true }),
		requireString(input.telegram_user_id, 'El identificador del usuario', { max: 32 }),
		requireString(input.telegram_chat_id, 'El identificador del chat', { max: 32 }),
		requireString(input.telegram_username, 'El usuario de Telegram', { max: 64, optional: true }),
		requireString(input.source_update_id, 'El identificador de actualización', { max: 64, optional: true }),
		now.toISOString(),
	).first();
}

export async function createAppointmentPayment(db, input, { now = new Date() } = {}) {
	const appointmentId = requirePositiveInteger(input.appointment_id, 'La cita');
	const appointment = await db.prepare(
		`SELECT a.*, s.price_cents, COALESCE(SUM(p.amount_cents), 0) AS paid_cents
		 FROM appointments a
		 LEFT JOIN services s ON s.id = a.service_id
		 LEFT JOIN payments p ON p.appointment_id = a.id
		 WHERE a.id = ?1 GROUP BY a.id`,
	).bind(appointmentId).first();
	if (!appointment) return null;
	if (appointment.price_cents === null) throw new ValidationError('El servicio de esta cita no tiene precio configurado.');

	const amountCents = Math.round(Number(input.amount) * 100);
	if (!Number.isFinite(Number(input.amount)) || amountCents < 1 || Math.abs(Number(input.amount) * 100 - amountCents) > 0.000001) {
		throw new ValidationError('El monto debe ser mayor que cero y tener máximo dos decimales.');
	}
	await db.prepare(
		`INSERT INTO payments (
			appointment_id, payment_date, customer_name, amount_cents, payment_method, notes,
			telegram_user_id, telegram_chat_id, telegram_username, created_at
		 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	).bind(
		appointmentId, requirePaymentDate(input.payment_date), appointment.patient_name, amountCents,
		requireString(input.payment_method, 'El método de pago', { min: 2, max: 60 }),
		requireString(input.notes, 'Las notas', { max: 1_000, optional: true }),
		appointment.telegram_user_id, appointment.telegram_chat_id, appointment.telegram_username, now.toISOString(),
	).run();

	const paidCents = Number(appointment.paid_cents) + amountCents;
	return {
		appointment_id: appointmentId,
		price_cents: Number(appointment.price_cents),
		paid_cents: paidCents,
		payment_status: paidCents >= Number(appointment.price_cents) ? 'paid' : 'partial',
	};
}

const CONSUMER_FINAL_DATA = Object.freeze({
	cedula_ruc: '9999999999999',
	address: 'Quito',
	phone: '029999999',
});

export async function createOwnerChatPayment(db, input, { now = new Date() } = {}) {
	const appointmentId = requirePositiveInteger(input.appointment_id, 'La cita');
	const amountCents = Math.round(Number(input.amount) * 100);
	if (!Number.isFinite(Number(input.amount)) || amountCents < 1 || Math.abs(Number(input.amount) * 100 - amountCents) > 0.000001) {
		throw new ValidationError('El monto debe ser mayor que cero y tener máximo dos decimales.');
	}
	const billingType = requireString(input.billing_type, 'El tipo de facturación', { max: 20 });
	if (!['consumer_final', 'customer_data'].includes(billingType)) {
		throw new ValidationError('El tipo de facturación no es válido.');
	}
	if (billingType === 'consumer_final' && amountCents > 5_000) {
		throw new ValidationError('Los pagos mayores de $50 deben registrarse obligatoriamente con los datos del cliente.');
	}
	const fiscalData = billingType === 'consumer_final'
		? CONSUMER_FINAL_DATA
		: {
			cedula_ruc: requireString(input.cedula_ruc, 'La cédula o RUC', { max: 20 }),
			address: requireString(input.address, 'La dirección', { max: 300 }),
			phone: requireString(input.phone, 'El teléfono', { max: 32 }),
		};
	const appointment = await db.prepare(
		`SELECT a.id, a.customer_id, a.patient_name, a.service_id, a.service_name, a.service
		 FROM appointments a WHERE a.id = ?1 LIMIT 1`,
	).bind(appointmentId).first();
	if (!appointment) throw new ValidationError('No se encontró la cita seleccionada.');
	if (!appointment.customer_id) throw new ValidationError('La cita seleccionada no tiene un cliente asociado.');

	const timestamp = now.toISOString();
	await db.batch([
		db.prepare('UPDATE customers SET cedula_ruc = ?2, address = ?3, phone = ?4, updated_at = ?5 WHERE id = ?1')
			.bind(appointment.customer_id, fiscalData.cedula_ruc, fiscalData.address, fiscalData.phone, timestamp),
		db.prepare(
			`INSERT INTO payments (
				appointment_id, payment_date, customer_name, amount_cents, payment_method, notes,
				telegram_user_id, telegram_chat_id, telegram_username, source_update_id, created_at
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
		).bind(
			appointmentId, requirePaymentDate(input.payment_date), appointment.patient_name, amountCents,
			requireString(input.payment_method, 'El método de pago', { min: 2, max: 60 }),
			requireString(input.notes, 'Las notas', { max: 1_000, optional: true }),
			requireString(input.telegram_user_id, 'El identificador del usuario', { max: 32 }),
			requireString(input.telegram_chat_id, 'El identificador del chat', { max: 32 }),
			requireString(input.telegram_username, 'El usuario de Telegram', { max: 64, optional: true }),
			requireString(input.source_update_id, 'El identificador de actualización', { max: 64, optional: true }),
			timestamp,
		),
	]);
	const payment = input.source_update_id
		? await db.prepare('SELECT * FROM payments WHERE source_update_id = ?1 LIMIT 1').bind(input.source_update_id).first()
		: await db.prepare('SELECT * FROM payments WHERE appointment_id = ?1 ORDER BY id DESC LIMIT 1').bind(appointmentId).first();
	return {
		...payment,
		service_id: appointment.service_id,
		service_name: appointment.service_name ?? appointment.service,
		billing_type: billingType,
		...fiscalData,
	};
}
