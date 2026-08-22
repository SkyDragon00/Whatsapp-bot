import { jsonResponse } from '../utils/responses.js';
import { getBusinessSettings, saveBusinessSettings } from '../repositories/settings-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { clearConversation } from '../conversation/store.js';

export async function listModeratorCompanies(db) {
	const result = await db.prepare(
		`SELECT companies.id, companies.name, companies.status, companies.created_at,
		        COUNT(users.id) AS admin_count,
		        (SELECT owner.username FROM users AS owner
		         WHERE owner.company_id = companies.id AND owner.role = 'admin'
		         ORDER BY owner.id LIMIT 1) AS owner_username,
		        (SELECT owner.phone_e164 FROM users AS owner
		         WHERE owner.company_id = companies.id AND owner.role = 'admin'
		         ORDER BY owner.id LIMIT 1) AS owner_phone
		 FROM companies
		 LEFT JOIN users ON users.company_id = companies.id AND users.role = 'admin'
		 GROUP BY companies.id
		 ORDER BY companies.created_at DESC, companies.id DESC`,
	).all();
	return result.results || [];
}

export async function deleteModeratorCompany(db, companyId) {
	const company = await db.prepare('SELECT id, name FROM companies WHERE id = ?1 LIMIT 1').bind(companyId).first();
	if (!company) return null;
	const owners = await db.prepare(
		"SELECT phone_e164 FROM users WHERE company_id = ?1 AND phone_e164 IS NOT NULL AND TRIM(phone_e164) <> ''",
	).bind(companyId).all();

	await db.batch([
		db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?1)').bind(companyId),
		db.prepare(
			'DELETE FROM payments WHERE company_id = ?1 OR appointment_id IN (SELECT id FROM appointments WHERE company_id = ?1)',
		).bind(companyId),
		db.prepare('DELETE FROM appointments WHERE company_id = ?1').bind(companyId),
		db.prepare('DELETE FROM expenses WHERE company_id = ?1').bind(companyId),
		db.prepare('DELETE FROM ai_knowledge_documents WHERE company_id = ?1').bind(companyId),
		db.prepare('DELETE FROM services WHERE company_id = ?1').bind(companyId),
		db.prepare('DELETE FROM customers WHERE company_id = ?1').bind(companyId),
		db.prepare('DELETE FROM users WHERE company_id = ?1').bind(companyId),
		db.prepare("DELETE FROM settings WHERE key LIKE ('company:' || ?1 || ':%')").bind(companyId),
		db.prepare('DELETE FROM companies WHERE id = ?1').bind(companyId),
	]);
	return {
		...company,
		ownerPhones: (owners.results || []).map((owner) => owner.phone_e164),
	};
}

export async function handleModeratorApi(request, env, url) {
	if (url.pathname === '/api/moderator/ai-settings') {
		const settings = await getBusinessSettings(env.DB);
		if (request.method === 'GET') return jsonResponse({
			onboardingEnabled: settings.onboardingEnabled === true,
			firstStepsEnabled: settings.firstStepsEnabled === true,
		});
		if (request.method === 'PUT') {
			const input = await readJsonWithLimit(request, 1_000);
			if (input.onboardingEnabled !== undefined && typeof input.onboardingEnabled !== 'boolean') {
				return jsonResponse({ ok: false, error: 'El modo onboarding debe estar encendido o apagado.' }, 400);
			}
			if (input.firstStepsEnabled !== undefined && typeof input.firstStepsEnabled !== 'boolean') {
				return jsonResponse({ ok: false, error: 'Primeros pasos debe estar encendido o apagado.' }, 400);
			}
			if (input.onboardingEnabled === undefined && input.firstStepsEnabled === undefined) {
				return jsonResponse({ ok: false, error: 'No se recibió una configuración válida.' }, 400);
			}
			const saved = await saveBusinessSettings(env.DB, {
				...settings,
				onboardingEnabled: input.onboardingEnabled ?? settings.onboardingEnabled,
				firstStepsEnabled: input.firstStepsEnabled ?? settings.firstStepsEnabled,
			});
			return jsonResponse({
				onboardingEnabled: saved.onboardingEnabled,
				firstStepsEnabled: saved.firstStepsEnabled,
			});
		}
	}
	if (request.method === 'GET' && url.pathname === '/api/moderator/companies') {
		return jsonResponse({ companies: await listModeratorCompanies(env.DB) });
	}
	const companyMatch = /^\/api\/moderator\/companies\/(\d+)$/.exec(url.pathname);
	if (request.method === 'DELETE' && companyMatch) {
		const company = await deleteModeratorCompany(env.DB, Number(companyMatch[1]));
		if (!company) return jsonResponse({ ok: false, error: 'La empresa no existe.' }, 404);
		await Promise.all(company.ownerPhones.flatMap((phone) => {
			const digits = String(phone).replace(/\D/g, '');
			if (!digits) return [];
			return [
				clearConversation(env.CONVERSATIONS, `whatsapp:${digits}`),
				env.CONVERSATIONS.delete(`pending-payment-receipt:${digits}`),
			];
		}));
		return jsonResponse({
			ok: true,
			deletedCompany: { id: company.id, name: company.name },
		});
	}
	return jsonResponse({ ok: false, error: 'Ruta de moderación no encontrada.' }, 404);
}
