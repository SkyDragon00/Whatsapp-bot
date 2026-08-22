import {
	GEMINI_MAX_TOOL_ITERATIONS,
	GEMINI_MAX_TOOL_CALLS,
	GEMINI_MODEL,
	GEMINI_TIMEOUT_MS,
} from '../config/constants.js';
import { AiProtocolError } from '../domain/errors.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';
import { logEvent } from '../utils/logging.js';
import { TOOL_DECLARATIONS } from './tool-definitions.js';
import { executeToolSafely, isAllowedToolName, isExplicitConfirmation } from './tools.js';

const BUSINESS_LOGIN_URL = 'https://cloudflare-worker.domenica-escobar-moyano.workers.dev/';

function historyToContents(history, userMessage) {
	const contents = history.map((message) => ({
		role: message.role,
		parts: [{ text: message.text }],
	}));
	contents.push({ role: 'user', parts: [{ text: userMessage }] });
	return contents;
}

function sanitizeProviderText(value, maxLength = 500) {
	if (typeof value !== 'string') return undefined;
	return value
		.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[secret omitted]')
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email omitted]')
		.replace(/\+?\d[\d\s().-]{7,}\d/g, '[number omitted]')
		.replace(/\b(api[_ -]?key|token|authorization)\s*[:=]\s*\S+/gi, '$1=[secret omitted]')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maxLength);
}

function sanitizeIdentifier(value) {
	if (typeof value !== 'string') return undefined;
	return value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 128) || undefined;
}

function functionCallNamesFromContents(contents) {
	return contents.flatMap((content) =>
		Array.isArray(content?.parts)
			? content.parts.map((part) => sanitizeIdentifier(part?.functionCall?.name)).filter(Boolean)
			: [],
	);
}

function requestMetadata(contents, iteration, toolDeclarations = TOOL_DECLARATIONS) {
	return {
		iteration: iteration + 1,
		contentsCount: contents.length,
		toolNames: toolDeclarations.map((tool) => tool.name),
		functionCallNames: functionCallNamesFromContents(contents),
	};
}

async function requestGemini({ apiKey, systemPrompt, contents, fetchImpl, iteration, diagnostics, toolDeclarations }) {
	if (!apiKey) throw new Error('GEMINI_API_KEY_NOT_CONFIGURED');
	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
	const metadata = requestMetadata(contents, iteration, toolDeclarations);
	if (diagnostics) logEvent('info', 'gemini_iteration_started', metadata);
	const response = await fetchWithTimeout(
		endpoint,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey,
			},
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: systemPrompt }] },
				contents,
				tools: [{ functionDeclarations: toolDeclarations }],
				toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
				generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
				store: false,
			}),
		},
		GEMINI_TIMEOUT_MS,
		fetchImpl,
	);
	const result = await readJsonWithLimit(response, 1_000_000);
	if (!response.ok) {
		const googleError = result?.error && typeof result.error === 'object' ? result.error : {};
		logEvent('error', 'gemini_request_failed', {
			...metadata,
			httpStatus: response.status,
			googleErrorStatus: sanitizeIdentifier(googleError.status),
			googleErrorCode:
				typeof googleError.code === 'number'
					? googleError.code
					: sanitizeIdentifier(googleError.code),
			googleErrorMessage: sanitizeProviderText(googleError.message),
		});
		const error = new Error(`GEMINI_REQUEST_FAILED_${response.status}`);
		error.code = 'GEMINI_REQUEST_FAILED';
		error.status = response.status;
		throw error;
	}
	return result;
}

async function requestGeminiWithRetry(options) {
	try {
		return await requestGemini(options);
	} catch (error) {
		const retryableStatus = error?.status === 429 || error?.status >= 500;
		const retryableNetworkError = error?.code !== 'GEMINI_REQUEST_FAILED' && !(error instanceof AiProtocolError);
		if (!retryableStatus && !retryableNetworkError) throw error;
		if (options.diagnostics) {
			logEvent('info', 'gemini_request_retry', {
				...requestMetadata(options.contents, options.iteration, options.toolDeclarations),
				httpStatus: error?.status,
			});
		}
		return requestGemini(options);
	}
}

function getCandidateContent(result) {
	const content = result?.candidates?.[0]?.content;
	if (!content || !Array.isArray(content.parts)) {
		throw new AiProtocolError('Gemini no devolvió contenido utilizable.');
	}
	return { ...content, role: 'model' };
}

function extractText(content) {
	return content.parts
		.map((part) => (typeof part.text === 'string' ? part.text : ''))
		.join('')
		.trim();
}

function hasPendingAppointmentConfirmation(history, userMessage) {
	if (!isExplicitConfirmation(userMessage)) return false;
	const lastModelMessage = [...history].reverse().find((message) => message.role === 'model')?.text ?? '';
	const normalized = lastModelMessage.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	return /(confirm|todo correcto|proceder).{0,180}(cita|agend)|(cita|agend).{0,180}(confirm|todo correcto|proceder)/.test(normalized);
}

function appointmentSuccessMessage(data) {
	const appointment = data?.appointment ?? {};
	const customer = appointment.customer_name ? ` para ${appointment.customer_name}` : '';
	const service = appointment.service_name ? ` (${appointment.service_name})` : '';
	return `Listo. La cita${customer}${service} quedó registrada correctamente en la agenda.`;
}

export async function runGeminiAgent({
	apiKey,
	systemPrompt,
	history = [],
	userMessage,
	toolContext,
	fetchImpl = fetch,
	executeToolResult = executeToolSafely,
	diagnostics = false,
	toolDeclarations = TOOL_DECLARATIONS,
}) {
	const contents = historyToContents(history, userMessage);
	let totalToolCalls = 0;
	const pendingAppointmentConfirmation = hasPendingAppointmentConfirmation(history, userMessage);
	let appointmentRetryRequested = false;

	for (let iteration = 0; iteration < GEMINI_MAX_TOOL_ITERATIONS; iteration += 1) {
		const result = await requestGeminiWithRetry({ apiKey, systemPrompt, contents, fetchImpl, iteration, diagnostics, toolDeclarations });
		const modelContent = getCandidateContent(result);
		const functionCalls = modelContent.parts
			.map((part) => part.functionCall)
			.filter(Boolean);
		if (diagnostics) {
			logEvent('info', 'gemini_iteration_completed', {
				...requestMetadata(contents, iteration, toolDeclarations),
				functionCallNames: functionCalls.map((call) => sanitizeIdentifier(call.name)).filter(Boolean),
			});
		}

		if (functionCalls.length === 0) {
			const text = extractText(modelContent);
			if (!text) throw new AiProtocolError('Gemini devolvió una respuesta vacía.');
			if (pendingAppointmentConfirmation && !appointmentRetryRequested) {
				appointmentRetryRequested = true;
				contents.push(modelContent);
				contents.push({
					role: 'user',
					parts: [{ text: 'La cita todavía no está registrada. Debes llamar ahora a create_appointment con los datos ya confirmados. No afirmes que fue creada sin ejecutar la herramienta.' }],
				});
				continue;
			}
			if (pendingAppointmentConfirmation) {
				return 'No pude registrar la cita en la agenda. No quedó confirmada; por favor inténtalo nuevamente.';
			}
			return text;
		}
		totalToolCalls += functionCalls.length;
		if (totalToolCalls > GEMINI_MAX_TOOL_CALLS) {
			throw new AiProtocolError('Gemini superó el límite de herramientas permitido.');
		}

		contents.push(modelContent);
		const responseParts = [];
		for (const functionCall of functionCalls) {
			if (!isAllowedToolName(functionCall.name)) {
				throw new AiProtocolError('Gemini intentó usar una herramienta desconocida.');
			}
			const response = await executeToolResult(functionCall.name, functionCall.args ?? {}, toolContext);
			if (functionCall.name === 'create_appointment') {
				if (response?.ok && response.data?.appointment?.id) return appointmentSuccessMessage(response.data);
				const message = response?.error?.message || 'No se pudo completar el registro.';
				return `No pude agendar la cita: ${message} La cita no quedó confirmada.`;
			}
			if (functionCall.name === 'register_business_from_onboarding') {
				if (response?.ok) {
					const businessName = response.data?.businessName || 'tu negocio';
					const username = response.data?.username || 'tu usuario';
					return `Listo. El negocio ${businessName} y el usuario ${username} fueron creados correctamente. Ya puedes iniciar sesión con la clave temporal 12345678. Por seguridad, la página te pedirá cambiarla antes de entrar al panel.\n\nIngresa aquí para iniciar sesión: ${BUSINESS_LOGIN_URL}`;
				}
				const message = response?.error?.message || 'No se pudo completar el registro.';
				return `No pude crear la cuenta: ${message} Revisa los datos e inténtalo nuevamente; todavía no intentes iniciar sesión.`;
			}
			responseParts.push({
				functionResponse: {
					...(functionCall.id ? { id: functionCall.id } : {}),
					name: functionCall.name,
					response,
				},
			});
		}
		contents.push({ role: 'user', parts: responseParts });
	}

	throw new AiProtocolError('Gemini superó el límite de herramientas permitido.');
}
