import { ValidationError } from '../domain/errors.js';
import { requirePositiveInteger, requireString } from '../domain/validation.js';

function normalizeNamePart(value, label) {
	return requireString(value, label, { min: 2, max: 80 }).replace(/\s+/g, ' ');
}

export function splitCustomerName(fullName) {
	const normalized = requireString(fullName, 'El nombre completo del cliente', { min: 3, max: 160 }).replace(/\s+/g, ' ');
	const separator = normalized.indexOf(' ');
	if (separator < 1 || separator === normalized.length - 1) throw new ValidationError('Indica el nombre y el apellido del cliente.');
	return { first_name: normalized.slice(0, separator), last_name: normalized.slice(separator + 1), full_name: normalized };
}

export function validateCustomerInput(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('El cliente debe ser un objeto.');
	if (Object.keys(input).some((key) => !['first_name', 'last_name', 'cedula_ruc', 'address', 'phone'].includes(key))) throw new ValidationError('El cliente contiene campos no permitidos.');
	const firstName = normalizeNamePart(input.first_name, 'El nombre');
	const lastName = normalizeNamePart(input.last_name, 'El apellido');
	return {
		first_name: firstName,
		last_name: lastName,
		full_name: `${firstName} ${lastName}`,
		cedula_ruc: requireString(input.cedula_ruc, 'La cédula o RUC', { max: 20, optional: true }),
		address: requireString(input.address, 'La dirección', { max: 300, optional: true }),
		phone: requireString(input.phone, 'El teléfono', { max: 32, optional: true }),
	};
}

export async function findOrCreateCustomer(db, input, { now = new Date() } = {}) {
	const name = input.full_name ? splitCustomerName(input.full_name) : validateCustomerInput(input);
	const timestamp = now.toISOString();
	await db.prepare(
		`INSERT INTO customers (first_name, last_name, full_name, cedula_ruc, address, phone, telegram_user_id, telegram_chat_id, telegram_username, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
		 ON CONFLICT(full_name) DO UPDATE SET telegram_user_id = COALESCE(excluded.telegram_user_id, customers.telegram_user_id),
		 telegram_chat_id = COALESCE(excluded.telegram_chat_id, customers.telegram_chat_id),
		 telegram_username = COALESCE(excluded.telegram_username, customers.telegram_username),
		 cedula_ruc = COALESCE(excluded.cedula_ruc, customers.cedula_ruc),
		 address = COALESCE(excluded.address, customers.address),
		 phone = COALESCE(customers.phone, excluded.phone), updated_at = excluded.updated_at`,
	).bind(
		name.first_name, name.last_name, name.full_name,
		name.cedula_ruc ?? input.cedula_ruc ?? null,
		name.address ?? input.address ?? null,
		name.phone ?? input.phone ?? null,
		input.telegram_user_id ?? null, input.telegram_chat_id ?? null,
		input.telegram_username ?? null, timestamp,
	).run();
	return db.prepare('SELECT * FROM customers WHERE full_name = ?1 COLLATE NOCASE LIMIT 1').bind(name.full_name).first();
}

export async function listCustomers(db) {
	const result = await db.prepare(
		`SELECT c.*, COUNT(a.id) AS appointment_count, MAX(a.start_at) AS last_appointment_at
		 FROM customers c LEFT JOIN appointments a ON a.customer_id = c.id
		 GROUP BY c.id ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`,
	).all();
	return result.results;
}

export async function getCustomerWithHistory(db, customerId) {
	const id = requirePositiveInteger(customerId, 'El cliente');
	const customer = await db.prepare('SELECT * FROM customers WHERE id = ?1 LIMIT 1').bind(id).first();
	if (!customer) return null;
	const history = await db.prepare(
		`SELECT a.id, a.service_id, a.service_name, a.service, a.start_at, a.end_at, a.status,
		        a.phone, a.telegram_username, a.created_at, s.price_cents,
		        COALESCE(SUM(p.amount_cents), 0) AS paid_cents
		 FROM appointments a
		 LEFT JOIN services s ON s.id = a.service_id
		 LEFT JOIN payments p ON p.appointment_id = a.id
		 WHERE a.customer_id = ?1
		 GROUP BY a.id
		 ORDER BY a.start_at DESC, a.id DESC`,
	).bind(id).all();
	return { ...customer, appointments: history.results };
}

export async function updateCustomer(db, customerId, input, { now = new Date() } = {}) {
	const id = requirePositiveInteger(customerId, 'El cliente');
	const name = validateCustomerInput(input);
	const existing = await db.prepare('SELECT id FROM customers WHERE id = ?1 LIMIT 1').bind(id).first();
	if (!existing) return null;
	try {
		await db.batch([
			db.prepare('UPDATE customers SET first_name = ?2, last_name = ?3, full_name = ?4, cedula_ruc = ?5, address = ?6, phone = ?7, updated_at = ?8 WHERE id = ?1')
				.bind(id, name.first_name, name.last_name, name.full_name, name.cedula_ruc, name.address, name.phone, now.toISOString()),
			db.prepare('UPDATE appointments SET patient_name = ?2, updated_at = ?3 WHERE customer_id = ?1')
				.bind(id, name.full_name, now.toISOString()),
		]);
	} catch (error) {
		if (String(error?.message ?? '').includes('UNIQUE constraint failed')) {
			throw new ValidationError('Ya existe un cliente con ese nombre y apellido.');
		}
		throw error;
	}
	return getCustomerWithHistory(db, id);
}

export async function deleteCustomer(db, customerId, { now = new Date() } = {}) {
	const id = requirePositiveInteger(customerId, 'El cliente');
	const existing = await db.prepare('SELECT * FROM customers WHERE id = ?1 LIMIT 1').bind(id).first();
	if (!existing) return null;
	await db.batch([
		db.prepare('UPDATE appointments SET customer_id = NULL, updated_at = ?2 WHERE customer_id = ?1').bind(id, now.toISOString()),
		db.prepare('DELETE FROM customers WHERE id = ?1').bind(id),
	]);
	return existing;
}
