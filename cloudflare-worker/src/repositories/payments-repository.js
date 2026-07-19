import { ValidationError } from '../domain/errors.js';
import { requireString } from '../domain/validation.js';

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
