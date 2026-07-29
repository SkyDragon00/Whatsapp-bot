import { jsonResponse } from '../utils/responses.js';

export async function handleModeratorApi(request, env, url) {
	if (request.method !== 'GET' || url.pathname !== '/api/moderator/companies') {
		return jsonResponse({ ok: false, error: 'Ruta de moderación no encontrada.' }, 404);
	}
	const result = await env.DB.prepare(
		`SELECT companies.id, companies.name, companies.status, companies.created_at,
		        COUNT(users.id) AS admin_count
		 FROM companies
		 LEFT JOIN users ON users.company_id = companies.id AND users.role = 'admin'
		 GROUP BY companies.id
		 ORDER BY companies.created_at DESC, companies.id DESC`,
	).all();
	return jsonResponse({ companies: result.results || [] });
}
