import { ValidationError } from '../domain/errors.js';

function optionalDate(value, label) {
	if (!value) return null;
	const parsed = new Date(`${value}T00:00:00Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
		throw new ValidationError(`${label} no es válida.`);
	}
	return value;
}

function optionalSearch(value, label) {
	if (!value) return null;
	const normalized = value.trim();
	if (!normalized || normalized.length > 120) throw new ValidationError(`${label} no es válido.`);
	return `%${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export async function listIncomeAppointments(db, filters = {}) {
	const from = optionalDate(filters.from, 'La fecha inicial');
	const to = optionalDate(filters.to, 'La fecha final');
	if (from && to && from > to) throw new ValidationError('El rango de fechas no es válido.');
	const customer = optionalSearch(filters.customer, 'El cliente');
	const service = optionalSearch(filters.service, 'El servicio');
	const paymentStatus = filters.status || null;
	if (paymentStatus && !['paid', 'partial', 'unpaid'].includes(paymentStatus)) {
		throw new ValidationError('El estado de pago no es válido.');
	}
	const result = await db.prepare(
		`WITH income AS (
			SELECT a.id, a.patient_name AS customer_name,
				COALESCE(a.service_name, a.service, 'Servicio') AS service_name,
				a.start_at, a.status AS appointment_status, s.price_cents,
				COALESCE(SUM(p.amount_cents), 0) AS paid_cents
			FROM appointments a
			LEFT JOIN services s ON s.id = a.service_id
			LEFT JOIN payments p ON p.appointment_id = a.id
			WHERE (?1 IS NULL OR substr(a.start_at, 1, 10) >= ?1)
				AND (?2 IS NULL OR substr(a.start_at, 1, 10) <= ?2)
				AND (?3 IS NULL OR a.patient_name LIKE ?3 ESCAPE '\\' COLLATE NOCASE)
				AND (?4 IS NULL OR COALESCE(a.service_name, a.service, '') LIKE ?4 ESCAPE '\\' COLLATE NOCASE)
				AND (?6 IS NULL OR a.company_id = ?6)
			GROUP BY a.id
		)
		SELECT *,
			CASE WHEN paid_cents <= 0 THEN 'unpaid'
				WHEN price_cents IS NOT NULL AND paid_cents >= price_cents THEN 'paid'
				ELSE 'partial' END AS payment_status,
			MAX(COALESCE(price_cents, 0) - paid_cents, 0) AS outstanding_cents
		FROM income
		WHERE (?5 IS NULL OR CASE WHEN paid_cents <= 0 THEN 'unpaid'
			WHEN price_cents IS NOT NULL AND paid_cents >= price_cents THEN 'paid'
			ELSE 'partial' END = ?5)
		ORDER BY start_at DESC, id DESC LIMIT 500`,
	).bind(from, to, customer, service, paymentStatus, filters.companyId ?? null).all();
	const appointments = result.results;
	return {
		summary: {
			expected_cents: appointments.reduce((sum, item) => sum + Number(item.price_cents || 0), 0),
			paid_cents: appointments.reduce((sum, item) => sum + Number(item.paid_cents || 0), 0),
			outstanding_cents: appointments.reduce((sum, item) => sum + Number(item.outstanding_cents || 0), 0),
			appointments: appointments.length,
		},
		appointments,
	};
}
