import { getDashboard } from '../repositories/dashboard-repository.js';
import { jsonResponse } from '../utils/responses.js';

export async function handleDashboardApi(request, env, url, companyId) {
	if (request.method !== 'GET' || url.pathname !== '/api/dashboard') return null;
	return jsonResponse(await getDashboard(env.DB, {
		from: url.searchParams.get('from'),
		to: url.searchParams.get('to'),
		companyId,
	}));
}
