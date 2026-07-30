import { createKnowledgeDocument, deleteKnowledgeDocument, listKnowledgeDocuments } from '../repositories/knowledge-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

export async function handleKnowledgeApi(request, env, url, companyId) {
	if (url.pathname === '/api/ai-documents') {
		if (request.method === 'GET') return jsonResponse(await listKnowledgeDocuments(env.DB, { companyId }));
		if (request.method === 'POST') {
			const input = await readJsonWithLimit(request, 2_700_000);
			return jsonResponse(await createKnowledgeDocument(env.DB, input, { companyId }), 201);
		}
	}
	const match = /^\/api\/ai-documents\/(\d+)$/.exec(url.pathname);
	if (match && request.method === 'DELETE') return jsonResponse(await deleteKnowledgeDocument(env.DB, match[1], { companyId }));
	return null;
}
