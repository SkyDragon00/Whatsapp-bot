import { ValidationError } from '../domain/errors.js';
import { createService, listServices, updateService } from '../repositories/services-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

const ALLOWED_FIELDS = new Set(['name', 'description', 'duration_minutes', 'price', 'price_cents', 'enabled']);

function normalizeServiceInput(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new ValidationError('El servicio debe ser un objeto.');
	}
	for (const key of Object.keys(input)) {
		if (!ALLOWED_FIELDS.has(key)) throw new ValidationError(`El campo ${key} no está permitido.`);
	}
	if (input.price !== undefined && input.price_cents !== undefined) {
		throw new ValidationError('Indique el precio una sola vez.');
	}

	const normalized = { ...input };
	if (input.price !== undefined) {
		if (input.price === null || input.price === '') {
			normalized.price_cents = null;
		} else {
			const price = Number(input.price);
			const cents = Math.round(price * 100);
			if (!Number.isFinite(price) || price < 0 || Math.abs(price * 100 - cents) > 0.000001) {
				throw new ValidationError('El precio debe tener como máximo dos decimales.');
			}
			normalized.price_cents = cents;
		}
		delete normalized.price;
	}
	return normalized;
}

function serializeService(service) {
	return {
		...service,
		enabled: Boolean(service.enabled),
		price: service.price_cents === null ? null : service.price_cents / 100,
	};
}

export async function handleServicesApi(request, env, url) {
	if (request.method === 'GET' && url.pathname === '/api/services') {
		const services = await listServices(env.DB, { includeDisabled: true });
		return jsonResponse(services.map(serializeService));
	}
	if (request.method === 'POST' && url.pathname === '/api/services') {
		const input = normalizeServiceInput(await readJsonWithLimit(request, 32_000));
		return jsonResponse(serializeService(await createService(env.DB, input)), 201);
	}
	const match = /^\/api\/services\/(\d+)$/.exec(url.pathname);
	if (request.method === 'PUT' && match) {
		const input = normalizeServiceInput(await readJsonWithLimit(request, 32_000));
		return jsonResponse(serializeService(await updateService(env.DB, Number(match[1]), input)));
	}
	return null;
}
