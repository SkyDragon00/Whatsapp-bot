import { ValidationError } from '../domain/errors.js';
import { requireString } from '../domain/validation.js';

const ACTIVE_STATUSES = "('confirmed', 'completed', 'no_show')";

function optionalDate(value, label) {
	const normalized = requireString(value, label, { max: 10, optional: true });
	if (normalized === null) return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
	if (!match) throw new ValidationError(`${label} debe tener el formato AAAA-MM-DD.`);
	const [year, month, day] = match.slice(1).map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
		throw new ValidationError(`${label} no es válida.`);
	}
	return normalized;
}

export async function getOutstandingBalances(db, { customerName } = {}) {
	const normalizedName = requireString(customerName, 'El nombre del cliente', {
		min: 2,
		max: 160,
		optional: true,
	});
	const result = await db.prepare(
		`SELECT
			a.id AS appointment_id,
			a.customer_id,
			COALESCE(c.full_name, a.patient_name) AS customer_name,
			COALESCE(a.service_name, a.service, 'Servicio') AS service_name,
			a.start_at,
			a.status,
			s.price_cents,
			COALESCE(paid.paid_cents, 0) AS paid_cents,
			s.price_cents - COALESCE(paid.paid_cents, 0) AS outstanding_cents
		 FROM appointments a
		 LEFT JOIN customers c ON c.id = a.customer_id
		 JOIN services s ON s.id = a.service_id AND s.price_cents IS NOT NULL
		 LEFT JOIN (
			SELECT appointment_id, SUM(amount_cents) AS paid_cents
			FROM payments GROUP BY appointment_id
		 ) paid ON paid.appointment_id = a.id
		 WHERE a.status IN ${ACTIVE_STATUSES}
		   AND COALESCE(paid.paid_cents, 0) < s.price_cents
		   AND (?1 IS NULL OR COALESCE(c.full_name, a.patient_name) LIKE '%' || ?1 || '%' COLLATE NOCASE)
		 ORDER BY customer_name COLLATE NOCASE, a.start_at DESC, a.id DESC`,
	).bind(normalizedName ?? null).all();

	const people = new Map();
	for (const row of result.results) {
		const key = row.customer_id ? `customer:${row.customer_id}` : `name:${String(row.customer_name).toLocaleLowerCase('es')}`;
		let person = people.get(key);
		if (!person) {
			person = {
				customer_id: row.customer_id,
				customer_name: row.customer_name,
				outstanding_cents: 0,
				appointments: [],
			};
			people.set(key, person);
		}
		const appointment = {
			appointment_id: row.appointment_id,
			service_name: row.service_name,
			start_at: row.start_at,
			status: row.status,
			price_cents: Number(row.price_cents),
			paid_cents: Number(row.paid_cents),
			outstanding_cents: Number(row.outstanding_cents),
		};
		person.outstanding_cents += appointment.outstanding_cents;
		person.appointments.push(appointment);
	}
	const balances = [...people.values()].sort((left, right) =>
		right.outstanding_cents - left.outstanding_cents
		|| left.customer_name.localeCompare(right.customer_name, 'es'));
	return {
		customer_name_filter: normalizedName ?? null,
		people_count: balances.length,
		total_outstanding_cents: balances.reduce((sum, person) => sum + person.outstanding_cents, 0),
		balances,
	};
}

export async function getExpenseSummary(db, { dateFrom, dateTo, category, search } = {}) {
	const from = optionalDate(dateFrom, 'La fecha inicial');
	const to = optionalDate(dateTo, 'La fecha final');
	if (from && to && from > to) throw new ValidationError('El período de gastos no es válido.');
	const normalizedCategory = requireString(category, 'La categoría', { max: 80, optional: true });
	const normalizedSearch = requireString(search, 'La búsqueda', { max: 120, optional: true });
	const bindings = [from, to, normalizedCategory, normalizedSearch];
	const filters = `
		(?1 IS NULL OR expense_date >= ?1)
		AND (?2 IS NULL OR expense_date <= ?2)
		AND (?3 IS NULL OR category LIKE '%' || ?3 || '%' COLLATE NOCASE)
		AND (?4 IS NULL OR (
			category LIKE '%' || ?4 || '%' COLLATE NOCASE
			OR description LIKE '%' || ?4 || '%' COLLATE NOCASE
			OR supplier LIKE '%' || ?4 || '%' COLLATE NOCASE
			OR notes LIKE '%' || ?4 || '%' COLLATE NOCASE
		))`;
	const [totals, categories, recent] = await Promise.all([
		db.prepare(
			`SELECT COUNT(*) AS expense_count, COALESCE(SUM(amount_cents), 0) AS total_cents,
			 MIN(expense_date) AS first_date, MAX(expense_date) AS last_date
			 FROM expenses WHERE ${filters}`,
		).bind(...bindings).first(),
		db.prepare(
			`SELECT category, COUNT(*) AS expense_count, SUM(amount_cents) AS total_cents
			 FROM expenses WHERE ${filters}
			 GROUP BY category ORDER BY total_cents DESC, category COLLATE NOCASE`,
		).bind(...bindings).all(),
		db.prepare(
			`SELECT id, expense_date, description, category, supplier, amount_cents, payment_method, bank
			 FROM expenses WHERE ${filters}
			 ORDER BY expense_date DESC, id DESC LIMIT 50`,
		).bind(...bindings).all(),
	]);
	return {
		filters: {
			date_from: from,
			date_to: to,
			category: normalizedCategory,
			search: normalizedSearch,
		},
		expense_count: Number(totals.expense_count),
		total_cents: Number(totals.total_cents),
		first_date: totals.first_date,
		last_date: totals.last_date,
		by_category: categories.results.map((row) => ({
			...row,
			expense_count: Number(row.expense_count),
			total_cents: Number(row.total_cents),
		})),
		expenses: recent.results.map((row) => ({ ...row, amount_cents: Number(row.amount_cents) })),
		results_limited: Number(totals.expense_count) > recent.results.length,
	};
}

export async function getFinancialSummary(db, { dateFrom, dateTo } = {}) {
	const from = optionalDate(dateFrom, 'La fecha inicial');
	const to = optionalDate(dateTo, 'La fecha final');
	if (from && to && from > to) throw new ValidationError('El período financiero no es válido.');
	const bindings = [from, to];
	const [income, expenses, appointments] = await Promise.all([
		db.prepare(
			`SELECT COUNT(*) AS payment_count, COALESCE(SUM(amount_cents), 0) AS income_cents
			 FROM payments
			 WHERE (?1 IS NULL OR payment_date >= ?1) AND (?2 IS NULL OR payment_date <= ?2)`,
		).bind(...bindings).first(),
		db.prepare(
			`SELECT COUNT(*) AS expense_count, COALESCE(SUM(amount_cents), 0) AS expenses_cents
			 FROM expenses
			 WHERE (?1 IS NULL OR expense_date >= ?1) AND (?2 IS NULL OR expense_date <= ?2)`,
		).bind(...bindings).first(),
		db.prepare(
			`WITH appointment_income AS (
				SELECT a.id, s.price_cents, COALESCE(SUM(p.amount_cents), 0) AS paid_cents
				FROM appointments a
				LEFT JOIN services s ON s.id = a.service_id
				LEFT JOIN payments p ON p.appointment_id = a.id
				WHERE a.status IN ${ACTIVE_STATUSES}
				  AND (?1 IS NULL OR substr(a.start_at, 1, 10) >= ?1)
				  AND (?2 IS NULL OR substr(a.start_at, 1, 10) <= ?2)
				GROUP BY a.id
			 )
			 SELECT COUNT(*) AS appointment_count,
				COALESCE(SUM(price_cents), 0) AS expected_cents,
				COALESCE(SUM(MAX(COALESCE(price_cents, 0) - paid_cents, 0)), 0) AS outstanding_cents,
				SUM(CASE WHEN paid_cents <= 0 THEN 1 ELSE 0 END) AS unpaid_count,
				SUM(CASE WHEN paid_cents > 0 AND (price_cents IS NULL OR paid_cents < price_cents) THEN 1 ELSE 0 END) AS partial_count,
				SUM(CASE WHEN price_cents IS NOT NULL AND paid_cents >= price_cents THEN 1 ELSE 0 END) AS paid_count
			 FROM appointment_income`,
		).bind(...bindings).first(),
	]);
	const incomeCents = Number(income.income_cents);
	const expensesCents = Number(expenses.expenses_cents);
	return {
		filters: { date_from: from, date_to: to },
		income_cents: incomeCents,
		expenses_cents: expensesCents,
		net_cents: incomeCents - expensesCents,
		payment_count: Number(income.payment_count),
		expense_count: Number(expenses.expense_count),
		appointments: {
			count: Number(appointments.appointment_count),
			expected_cents: Number(appointments.expected_cents),
			outstanding_cents: Number(appointments.outstanding_cents),
			paid_count: Number(appointments.paid_count),
			partial_count: Number(appointments.partial_count),
			unpaid_count: Number(appointments.unpaid_count),
		},
	};
}
