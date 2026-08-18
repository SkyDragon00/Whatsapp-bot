import { ValidationError } from '../domain/errors.js';
import { requirePositiveInteger, requireString, validateServiceInput } from '../domain/validation.js';

export async function listServices(db, { includeDisabled = false, limit = 100, companyId = null } = {}) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError('El límite de servicios no es válido.');
	const statement = includeDisabled
		? db.prepare('SELECT * FROM services WHERE (?2 IS NULL OR company_id = ?2) ORDER BY enabled DESC, name COLLATE NOCASE LIMIT ?1').bind(limit, companyId)
		: db.prepare('SELECT * FROM services WHERE enabled = 1 AND (?2 IS NULL OR company_id = ?2) ORDER BY name COLLATE NOCASE LIMIT ?1').bind(limit, companyId);
	const result = await statement.all();
	return result.results;
}

export async function getServiceById(db, id, { includeDisabled = false, companyId = null } = {}) {
	const serviceId = requirePositiveInteger(id, 'El servicio');
	const query = includeDisabled
		? 'SELECT * FROM services WHERE id = ?1 AND (?2 IS NULL OR company_id = ?2) LIMIT 1'
		: 'SELECT * FROM services WHERE id = ?1 AND enabled = 1 AND (?2 IS NULL OR company_id = ?2) LIMIT 1';
	return db.prepare(query).bind(serviceId, companyId).first();
}

export async function getServiceByName(db, name, { includeDisabled = false, companyId = null } = {}) {
	const serviceName = requireString(name, 'El nombre del servicio', { min: 2, max: 100 });
	const query = includeDisabled
		? 'SELECT * FROM services WHERE name = ?1 COLLATE NOCASE AND (?2 IS NULL OR company_id = ?2) LIMIT 1'
		: 'SELECT * FROM services WHERE name = ?1 COLLATE NOCASE AND enabled = 1 AND (?2 IS NULL OR company_id = ?2) LIMIT 1';
	return db.prepare(query).bind(serviceName, companyId).first();
}

export async function resolveService(db, { serviceId, serviceName, includeDisabled = false }, { companyId = null } = {}) {
	if (serviceId !== undefined && serviceId !== null) return getServiceById(db, serviceId, { includeDisabled, companyId });
	if (serviceName !== undefined && serviceName !== null) return getServiceByName(db, serviceName, { includeDisabled, companyId });
	throw new ValidationError('Debe indicarse el identificador o el nombre del servicio.');
}

export async function createService(db, input, { companyId = null } = {}) {
	const service = validateServiceInput(input);
	try {
		return await db
			.prepare(
				`INSERT INTO services (name, description, duration_minutes, price_cents, enabled, company_id)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
				 RETURNING *`,
			)
			.bind(service.name, service.description, service.duration_minutes, service.price_cents, service.enabled, companyId)
			.first();
	} catch (error) {
		if (String(error?.message).includes('UNIQUE')) {
			throw new ValidationError('Ya existe un servicio con ese nombre.');
		}
		throw error;
	}
}

export async function updateService(db, id, input, { companyId = null } = {}) {
	const serviceId = requirePositiveInteger(id, 'El servicio');
	const changes = validateServiceInput(input, { partial: true });
	const allowedColumns = ['name', 'description', 'duration_minutes', 'price_cents', 'enabled'];
	const fields = allowedColumns.filter((column) => Object.hasOwn(changes, column));
	const assignments = fields.map((column, index) => `${column} = ?${index + 1}`);
	assignments.push(`updated_at = ?${fields.length + 1}`);
	const values = fields.map((column) => changes[column]);
	values.push(new Date().toISOString(), serviceId, companyId);

	try {
		const updated = await db
			.prepare(
				`UPDATE services
				 SET ${assignments.join(', ')}
				 WHERE id = ?${fields.length + 2}
				   AND (?${fields.length + 3} IS NULL OR company_id = ?${fields.length + 3})
				 RETURNING *`,
			)
			.bind(...values)
			.first();
		if (!updated) throw new ValidationError('No se encontró el servicio.');
		return updated;
	} catch (error) {
		if (String(error?.message).includes('UNIQUE')) {
			throw new ValidationError('Ya existe un servicio con ese nombre.');
		}
		throw error;
	}
}
