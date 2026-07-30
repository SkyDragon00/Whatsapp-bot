import { getBusinessSettings, saveBusinessSettings } from '../repositories/settings-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

export async function handleSettingsApi(request, env, companyId) {
	if (request.method === 'GET') return jsonResponse(await getBusinessSettings(env.DB, { companyId }));
	if (request.method === 'PUT') {
		const input = await readJsonWithLimit(request, 32_000);
		return jsonResponse(await saveBusinessSettings(env.DB, input, { companyId }));
	}
	return null;
}
