import { GEMINI_EXPENSE_TIMEOUT_MS, GEMINI_MODEL } from '../config/constants.js';
import { AiProtocolError } from '../domain/errors.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';
import { logEvent } from '../utils/logging.js';
import { buildExpenseSystemPrompt } from './jit-prompt.js';
import { buildExpenseResponseSchema } from './response-schema.js';

function sanitizeProviderMessage(value) {
	if (typeof value !== 'string') return undefined;
	return value
		.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[secret omitted]')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 500);
}

function contentPart(input) {
	if (input.type === 'text') return { text: input.text };
	return { inlineData: { mimeType: input.mimeType, data: input.base64 } };
}

function validateExtraction(value, context) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiProtocolError('Respuesta de gasto inválida.');
	const category = context.categories.includes(value.category) ? value.category : 'Otros';
	const amount = value.amount === null ? null : Number(value.amount);
	const description = typeof value.description === 'string' ? value.description.trim().slice(0, 200) : '';
	const detected = value.detected === true;
	const validAmount = Number.isFinite(amount) && amount > 0 && amount <= 10_000_000;
	return {
		detected,
		amount: validAmount ? Math.round(amount * 100) / 100 : null,
		currency: /^[A-Z]{3}$/.test(value.currency) ? value.currency : context.currency,
		description,
		category: context.categories.includes(category) ? category : context.categories.at(-1),
		merchant: typeof value.merchant === 'string' && value.merchant.trim() ? value.merchant.trim().slice(0, 150) : null,
		date: /^\d{4}-\d{2}-\d{2}$/.test(value.date ?? '') ? value.date : null,
		confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
		needs_review: value.needs_review === true || !detected || !validAmount || description.length < 2,
	};
}

export async function extractExpense({ apiKey, input, context, fetchImpl = fetch }) {
	if (!apiKey) throw new Error('GEMINI_API_KEY_NOT_CONFIGURED');
	const response = await fetchWithTimeout(
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: buildExpenseSystemPrompt({ type: input.type, ...context }) }] },
				contents: [{ role: 'user', parts: [contentPart(input)] }],
				generationConfig: {
					temperature: 0.1,
					maxOutputTokens: 400,
					responseMimeType: 'application/json',
					responseSchema: buildExpenseResponseSchema(context.categories),
				},
				store: false,
			}),
		},
		GEMINI_EXPENSE_TIMEOUT_MS,
		fetchImpl,
	);
	const result = await readJsonWithLimit(response, 500_000);
	if (!response.ok) {
		const providerError = result?.error && typeof result.error === 'object' ? result.error : {};
		logEvent('error', 'gemini_expense_request_failed', {
			httpStatus: response.status,
			providerStatus: typeof providerError.status === 'string' ? providerError.status.slice(0, 80) : undefined,
			providerCode: typeof providerError.code === 'number' ? providerError.code : undefined,
			providerMessage: sanitizeProviderMessage(providerError.message),
		});
		const error = new Error(`GEMINI_EXPENSE_REQUEST_FAILED_${response.status}`);
		error.code = 'GEMINI_EXPENSE_REQUEST_FAILED';
		error.status = response.status;
		throw error;
	}
	const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
	if (!text) throw new AiProtocolError('Gemini no devolvió el gasto estructurado.');
	try {
		return validateExtraction(JSON.parse(text), context);
	} catch (error) {
		if (error instanceof AiProtocolError) throw error;
		throw new AiProtocolError('Gemini devolvió JSON inválido.');
	}
}
