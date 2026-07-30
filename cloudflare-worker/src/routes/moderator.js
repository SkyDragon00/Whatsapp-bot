import { jsonResponse } from '../utils/responses.js';

export async function listModeratorCompanies(db) {
	const result = await db.prepare(
		`SELECT companies.id, companies.name, companies.status, companies.created_at,
		        COUNT(users.id) AS admin_count
		 FROM companies
		 LEFT JOIN users ON users.company_id = companies.id AND users.role = 'admin'
		 GROUP BY companies.id
		 ORDER BY companies.created_at DESC, companies.id DESC`,
	).all();
	return result.results || [];
}

export async function handleModeratorApi(request, env, url) {
	if (request.method !== 'GET' || url.pathname !== '/api/moderator/companies') {
		return jsonResponse({ ok: false, error: 'Ruta de moderación no encontrada.' }, 404);
	}
	return jsonResponse({ companies: await listModeratorCompanies(env.DB) });
}
