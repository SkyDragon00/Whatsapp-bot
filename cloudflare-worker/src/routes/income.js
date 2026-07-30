import { listIncomeAppointments } from '../repositories/income-repository.js';
import { jsonResponse } from '../utils/responses.js';

export async function handleIncomeApi(request, env, url, companyId) {
	if (request.method !== 'GET' || url.pathname !== '/api/income') return null;
	return jsonResponse(await listIncomeAppointments(env.DB, {
		from: url.searchParams.get('from'),
		to: url.searchParams.get('to'),
		customer: url.searchParams.get('customer'),
		service: url.searchParams.get('service'),
		status: url.searchParams.get('status'),
		companyId,
	}));
}
