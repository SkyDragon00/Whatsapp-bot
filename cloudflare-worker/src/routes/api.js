import {
	AppointmentConflictError,
	AppointmentNotFoundError,
	AppointmentOwnershipError,
	ValidationError,
} from '../domain/errors.js';
import { withAdminProtection } from '../middleware/admin.js';
import { logError } from '../utils/logging.js';
import { jsonResponse } from '../utils/responses.js';
import { handleAppointmentsApi } from './appointments.js';
import { handleCustomersApi } from './customers.js';
import { handleDashboardApi } from './dashboard.js';
import { handleExpensesApi } from './expenses.js';
import { handleKnowledgeApi } from './knowledge.js';
import { handleServicesApi } from './services.js';
import { handleSettingsApi } from './settings.js';
import { handleAuthApi } from './auth.js';
import { handleModeratorApi } from './moderator.js';

function safeApiError(error) {
	if (error instanceof ValidationError || error?.message === 'BODY_TOO_LARGE' || error instanceof SyntaxError) {
		return jsonResponse(
			{ ok: false, error: error?.message === 'BODY_TOO_LARGE' ? 'El cuerpo es demasiado grande.' : error.message, code: 'VALIDATION_ERROR' },
			400,
		);
	}
	if (error instanceof AppointmentConflictError) return jsonResponse({ ok: false, error: error.message, code: error.code }, 409);
	if (error instanceof AppointmentOwnershipError) return jsonResponse({ ok: false, error: error.message, code: error.code }, 403);
	if (error instanceof AppointmentNotFoundError) return jsonResponse({ ok: false, error: error.message, code: error.code }, 404);
	if (error?.status === 404) return jsonResponse({ ok: false, error: error.message }, 404);
	return null;
}

async function dispatchApi(request, env, url) {
	let response = null;
	if (url.pathname === '/api/appointments' || url.pathname.startsWith('/api/appointments/')) {
		response = await handleAppointmentsApi(request, env, url);
	}
	else if (url.pathname === '/api/settings') response = await handleSettingsApi(request, env);
	else if (url.pathname === '/api/ai-documents' || url.pathname.startsWith('/api/ai-documents/')) {
		response = await handleKnowledgeApi(request, env, url);
	}
	else if (url.pathname === '/api/expenses' || url.pathname.startsWith('/api/expenses/')) {
		response = await handleExpensesApi(request, env, url);
	}
	else if (url.pathname === '/api/services' || url.pathname.startsWith('/api/services/')) {
		response = await handleServicesApi(request, env, url);
	}
	else if (url.pathname === '/api/customers' || url.pathname.startsWith('/api/customers/')) {
		response = await handleCustomersApi(request, env, url);
	}
	else if (url.pathname === '/api/dashboard') response = await handleDashboardApi(request, env, url);
	return response ?? jsonResponse({ ok: false, error: 'Ruta administrativa no encontrada.' }, 404);
}

export async function handleApiRequest(request, env, url) {
	if (url.pathname.startsWith('/api/auth/')) return handleAuthApi(request, env, url);
	if (url.pathname.startsWith('/api/moderator/')) {
		return withAdminProtection(
			request,
			env,
			async () => handleModeratorApi(request, env, url),
			{ role: 'super_admin' },
		);
	}
	return withAdminProtection(request, env, async () => {
		try {
			return await dispatchApi(request, env, url);
		} catch (error) {
			const safeResponse = safeApiError(error);
			if (safeResponse) return safeResponse;
			logError('admin_api_failed', error, { method: request.method, path: url.pathname });
			return jsonResponse({ ok: false, error: 'Error interno.' }, 500);
		}
	});
}
