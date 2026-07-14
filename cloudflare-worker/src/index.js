import { handleTelegramWebhook } from './routes/telegram.js';
import { handleApiRequest } from './routes/api.js';
import { logError } from './utils/logging.js';
import { jsonResponse } from './utils/responses.js';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		try {
			if (url.pathname.startsWith('/api/')) {
				return await handleApiRequest(request, env, url);
			}

			if (request.method === 'GET' && url.pathname === '/health') {
				return jsonResponse({
					ok: true,
					message: 'Asistente de citas funcionando',
					bindings: {
						database: Boolean(env.DB),
						conversations: Boolean(env.CONVERSATIONS),
						telegramToken: Boolean(env.TELEGRAM_BOT_TOKEN),
						geminiKey: Boolean(env.GEMINI_API_KEY),
					},
				});
			}

			if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
				return await handleTelegramWebhook(request, env, ctx);
			}

			if ((request.method === 'GET' || request.method === 'HEAD') && env.ASSETS) {
				return env.ASSETS.fetch(request);
			}

			return jsonResponse({ ok: false, error: 'Ruta no encontrada' }, 404);
		} catch (error) {
			logError('worker_request_failed', error, { method: request.method, path: url.pathname });
			return jsonResponse({ ok: false, error: 'Error interno' }, 500);
		}
	},
};
