import { ValidationError } from '../domain/errors.js';
import { deleteCustomer, findOrCreateCustomer, getCustomerWithHistory, listCustomers, updateCustomer, validateCustomerInput } from '../repositories/customers-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

export async function handleCustomersApi(request, env, url) {
	if (request.method === 'GET' && url.pathname === '/api/customers') return jsonResponse(await listCustomers(env.DB));
	if (request.method === 'POST' && url.pathname === '/api/customers') {
		const input = validateCustomerInput(await readJsonWithLimit(request, 4_000));
		return jsonResponse(await findOrCreateCustomer(env.DB, input), 201);
	}
	const detail = /^\/api\/customers\/(\d+)$/.exec(url.pathname);
	if (detail) {
		const customerId = Number(detail[1]);
		let customer = null;
		if (request.method === 'GET') customer = await getCustomerWithHistory(env.DB, customerId);
		else if (request.method === 'PUT') customer = await updateCustomer(env.DB, customerId, await readJsonWithLimit(request, 4_000));
		else if (request.method === 'DELETE') customer = await deleteCustomer(env.DB, customerId);
		else return null;
		if (!customer) throw Object.assign(new ValidationError('No se encontró el cliente.'), { status: 404 });
		return jsonResponse(customer);
	}
	return null;
}
