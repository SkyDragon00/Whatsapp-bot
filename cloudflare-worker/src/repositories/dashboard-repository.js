import { ValidationError } from '../domain/errors.js';

function requireDate(value, label) {
	const normalized = String(value ?? '').trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
	if (!match) throw new ValidationError(`${label} debe tener el formato AAAA-MM-DD.`);
	const [year, month, day] = match.slice(1).map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
		throw new ValidationError(`${label} no es válida.`);
	}
	return normalized;
}

export async function getDashboard(db, { from, to }) {
	const startDate = requireDate(from, 'La fecha inicial');
	const endDate = requireDate(to, 'La fecha final');
	if (startDate > endDate) throw new ValidationError('El período del dashboard no es válido.');

	const appointmentDate = "substr(COALESCE(a.start_at, a.date_iso), 1, 10)";
	const activeStatuses = "('confirmed', 'completed', 'no_show')";
	const [totals, serviceBreakdown, unpaidResult, dailyResult] = await Promise.all([
		db.prepare(
			`SELECT
				(SELECT COALESCE(SUM(amount_cents), 0) FROM payments
				 WHERE payment_date BETWEEN ?1 AND ?2) AS income_cents,
				(SELECT COALESCE(SUM(amount_cents), 0) FROM expenses
				 WHERE expense_date BETWEEN ?1 AND ?2) AS expenses_cents,
				(SELECT COUNT(*) FROM appointments a
				 WHERE ${appointmentDate} BETWEEN ?1 AND ?2 AND a.status IN ${activeStatuses}) AS services_count`,
		).bind(startDate, endDate).first(),
		db.prepare(
			`SELECT
				COALESCE(a.service_name, a.service, 'Servicio') AS service_name,
				COUNT(*) AS appointments,
				COALESCE(SUM(s.price_cents), 0) AS billed_cents,
				COALESCE(SUM(payments.paid_cents), 0) AS paid_cents
			 FROM appointments a
			 LEFT JOIN services s ON s.id = a.service_id
			 LEFT JOIN (
				SELECT appointment_id, SUM(amount_cents) AS paid_cents FROM payments GROUP BY appointment_id
			 ) payments ON payments.appointment_id = a.id
			 WHERE ${appointmentDate} BETWEEN ?1 AND ?2 AND a.status IN ${activeStatuses}
			 GROUP BY COALESCE(a.service_name, a.service, 'Servicio')
			 ORDER BY appointments DESC, service_name COLLATE NOCASE`,
		).bind(startDate, endDate).all(),
		db.prepare(
			`SELECT
				a.id AS appointment_id, a.customer_id, a.patient_name AS customer_name,
				COALESCE(a.service_name, a.service, 'Servicio') AS service_name, a.start_at,
				s.price_cents, COALESCE(payments.paid_cents, 0) AS paid_cents,
				s.price_cents - COALESCE(payments.paid_cents, 0) AS outstanding_cents
			 FROM appointments a
			 JOIN services s ON s.id = a.service_id AND s.price_cents IS NOT NULL
			 LEFT JOIN (
				SELECT appointment_id, SUM(amount_cents) AS paid_cents FROM payments GROUP BY appointment_id
			 ) payments ON payments.appointment_id = a.id
			 WHERE ${appointmentDate} BETWEEN ?1 AND ?2
			   AND a.status IN ${activeStatuses}
			   AND COALESCE(payments.paid_cents, 0) < s.price_cents
			 ORDER BY outstanding_cents DESC, a.start_at DESC, a.id DESC`,
		).bind(startDate, endDate).all(),
		db.prepare(
			`SELECT activity_date AS date,
				SUM(income_cents) AS income_cents,
				SUM(expenses_cents) AS expenses_cents
			 FROM (
				SELECT payment_date AS activity_date, SUM(amount_cents) AS income_cents, 0 AS expenses_cents
				FROM payments WHERE payment_date BETWEEN ?1 AND ?2 GROUP BY payment_date
				UNION ALL
				SELECT expense_date AS activity_date, 0 AS income_cents, SUM(amount_cents) AS expenses_cents
				FROM expenses WHERE expense_date BETWEEN ?1 AND ?2 GROUP BY expense_date
			 )
			 GROUP BY activity_date ORDER BY activity_date`,
		).bind(startDate, endDate).all(),
	]);

	const unpaid = unpaidResult.results;
	const unpaidPeople = new Set(unpaid.map((item) => item.customer_id ? `customer:${item.customer_id}` : `name:${item.customer_name}`)).size;
	const outstandingCents = unpaid.reduce((sum, item) => sum + Number(item.outstanding_cents), 0);
	const incomeCents = Number(totals.income_cents);
	const expensesCents = Number(totals.expenses_cents);
	return {
		period: { from: startDate, to: endDate },
		summary: {
			income_cents: incomeCents,
			expenses_cents: expensesCents,
			profit_cents: incomeCents - expensesCents,
			outstanding_cents: outstandingCents,
			services_count: Number(totals.services_count),
			unpaid_people: unpaidPeople,
		},
		service_breakdown: serviceBreakdown.results,
		daily_activity: dailyResult.results,
		unpaid,
	};
}
