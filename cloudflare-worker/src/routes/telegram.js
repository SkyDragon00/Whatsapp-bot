import {
	IDEMPOTENCY_DONE_TTL_SECONDS,
	IDEMPOTENCY_PROCESSING_TTL_SECONDS,
	MAX_INCOMING_MESSAGE_LENGTH,
} from '../config/constants.js';
import { runGeminiAgent } from '../ai/gemini.js';
import { buildSystemPrompt } from '../ai/system-prompt.js';
import { toolDeclarationsForMode } from '../ai/tool-definitions.js';
import {
	clearConversation,
	loadAppointmentState,
	loadConversation,
	saveAppointmentState,
	saveConversation,
} from '../conversation/store.js';
import { deriveAppointmentState } from '../conversation/appointment-state.js';
import { addPaymentMediaReminder, buildClientWelcomeMessage, isPaymentRegistrationRequest } from '../conversation/welcome.js';
import { buildAmbiguousHourReply } from '../domain/appointment-time-clarification.js';
import { deriveOnboardingIdentity } from '../onboarding/conversation-state.js';
import { downloadTelegramFile, sendTelegramMessage } from '../integrations/telegram.js';
import { attachPaymentReceipt } from '../repositories/payments-repository.js';
import { storeReceipt } from '../storage/receipts.js';
import { handleExpenseConfirmation, processExpenseMessage } from '../expenses/flow.js';
import { isExplicitExpenseText, routeTelegramMessage } from '../expenses/telegram-router.js';
import { getBotBusinessSettings, getBotCompanyId } from '../repositories/settings-repository.js';
import { listServices } from '../repositories/services-repository.js';
import { getKnowledgeContext } from '../repositories/knowledge-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { logError } from '../utils/logging.js';
import { jsonResponse } from '../utils/responses.js';

const CLIENT_START_MESSAGE =
	'Hola. Soy tu asistente de citas. Puedo mostrarte servicios, horarios disponibles, agendar y cancelar citas.';
const OWNER_START_MESSAGE =
	'Hola. Estoy en modo dueño. Puedo agendar citas para tus clientes y registrar pagos recibidos o gastos del negocio.';
const ONBOARDING_START_MESSAGE =
	'Hola, te ayudaré a configurar tu negocio. ¿Cuál es el nombre del negocio?';
const CANCEL_MESSAGE = 'Listo, reinicié la conversación actual. Puedes comenzar de nuevo cuando quieras.';
const SAFE_ERROR_MESSAGE = 'Tuve un problema procesando el mensaje. Intenta nuevamente en unos segundos.';

function commandFromText(text) {
	const firstToken = text.trim().split(/\s+/, 1)[0].toLowerCase();
	return firstToken.split('@', 1)[0];
}

function getUpdateIdentity(update, message) {
	if (Number.isInteger(update.update_id)) return `update:${update.update_id}`;
	if (Number.isInteger(message.message_id)) return `message:${message.chat.id}:${message.message_id}`;
	return null;
}

function idempotencyKey(identity) {
	return `telegram-update:${identity}`;
}

async function claimUpdate(kv, identity) {
	if (!identity) return true;
	const key = idempotencyKey(identity);
	if (await kv.get(key)) return false;
	await kv.put(key, 'processing', { expirationTtl: IDEMPOTENCY_PROCESSING_TTL_SECONDS });
	return true;
}

async function completeUpdate(kv, identity) {
	if (!identity) return;
	await kv.put(idempotencyKey(identity), 'done', { expirationTtl: IDEMPOTENCY_DONE_TTL_SECONDS });
}

async function releaseUpdate(kv, identity) {
	if (!identity) return;
	await kv.delete(idempotencyKey(identity));
}

export async function processTelegramUpdate({ update, message, identity, env, now = new Date() }) {
	const chatId = String(message.chat.id);
	const userId = String(message.from?.id ?? message.chat.id);
	const username = typeof message.from?.username === 'string' ? message.from.username : null;
	const text = typeof message.text === 'string' ? message.text.trim() : '';
	const route = routeTelegramMessage(message);
	if (route.type === 'image') {
		const pendingKey = `pending-payment-receipt:${chatId}`;
		const pending = await env.CONVERSATIONS.get(pendingKey, 'json');
		if (pending?.paymentId) {
			const pendingPayment = await env.DB.prepare(
				'SELECT id, payment_method FROM payments WHERE id = ?1 LIMIT 1',
			).bind(pending.paymentId).first();
			if (pendingPayment && pendingPayment.payment_method.trim().toLocaleLowerCase('es') === 'transferencia') {
				const media = await downloadTelegramFile(route.fileId, env);
				const receipt = await storeReceipt(env.RECEIPTS, {
					ownerType: 'payments',
					ownerId: pending.paymentId,
					bytes: media.bytes,
					mimeType: media.mimeType || route.mimeType,
					fileName: `comprobante-telegram-${message.message_id}.jpg`,
				});
				const payment = await attachPaymentReceipt(env.DB, pending.paymentId, receipt);
				if (!payment) throw new Error('PENDING_PAYMENT_NOT_FOUND');
				await env.CONVERSATIONS.delete(pendingKey);
				await sendTelegramMessage(chatId, 'Listo, guardé el comprobante en el pago de la transferencia.', env);
				return;
			}
			await env.CONVERSATIONS.delete(pendingKey);
		}
	}

	if (route.type === 'unsupported') {
		await processExpenseMessage({ route, chatId, userId, settings: null, env, now });
		return;
	}
	if (text.length > MAX_INCOMING_MESSAGE_LENGTH) {
		await sendTelegramMessage(chatId, 'El mensaje es demasiado largo. Envíalo de forma más breve.', env);
		return;
	}

	const command = route.type === 'text' ? commandFromText(text) : '';
	if (command === '/start') {
		await Promise.all([
			clearConversation(env.CONVERSATIONS, chatId),
			env.CONVERSATIONS.delete(`pending-payment-receipt:${chatId}`),
		]);
		const settings = await getBotBusinessSettings(env.DB);
		const startMessage = settings.onboardingEnabled
			? ONBOARDING_START_MESSAGE
			: settings.aiMode === 'owner'
				? OWNER_START_MESSAGE
				: buildClientWelcomeMessage(await listServices(env.DB, { limit: 100, companyId: await getBotCompanyId(env.DB) }));
		const conversationMode = settings.onboardingEnabled ? 'onboarding' : 'normal';
		await saveConversation(env.CONVERSATIONS, chatId, [
			{ role: 'model', text: startMessage },
		], { mode: conversationMode });
		await sendTelegramMessage(chatId, startMessage, env);
		return;
	}
	if (command === '/cancelar') {
		await Promise.all([
			clearConversation(env.CONVERSATIONS, chatId),
			env.CONVERSATIONS.delete(`pending-payment-receipt:${chatId}`),
		]);
		await sendTelegramMessage(chatId, CANCEL_MESSAGE, env);
		return;
	}
	const settings = await getBotBusinessSettings(env.DB);
	const conversationMode = settings.onboardingEnabled ? 'onboarding' : 'normal';
	if (route.type === 'text' && await handleExpenseConfirmation({ text, chatId, userId, env, now })) return;
	if (settings.aiMode === 'owner' && (route.type !== 'text' || isExplicitExpenseText(text))) {
		await processExpenseMessage({ route, chatId, userId, settings, env, now });
		return;
	}
	if (route.type !== 'text') {
		await sendTelegramMessage(chatId, 'El registro de gastos solo está disponible en modo dueño.', env);
		return;
	}

	const [history, storedAppointmentState] = await Promise.all([
		loadConversation(env.CONVERSATIONS, chatId, { mode: conversationMode }),
		loadAppointmentState(env.CONVERSATIONS, chatId),
	]);
	if (!settings.onboardingEnabled && settings.aiMode === 'client' && history.length === 0) {
		const companyId = await getBotCompanyId(env.DB);
		const welcomeMessage = buildClientWelcomeMessage(await listServices(env.DB, { limit: 100, companyId }));
		await saveConversation(env.CONVERSATIONS, chatId, [
			{ role: 'user', text }, { role: 'model', text: welcomeMessage },
		], { mode: conversationMode });
		await sendTelegramMessage(chatId, welcomeMessage, env);
		return;
	}
	const appointmentState = settings.onboardingEnabled
		? {}
		: deriveAppointmentState(history, text, storedAppointmentState);
	const ambiguousHourReply = settings.onboardingEnabled
		? null
		: buildAmbiguousHourReply(text, settings.businessHours);
	if (ambiguousHourReply) {
		await Promise.all([
			saveConversation(env.CONVERSATIONS, chatId, [
				...history,
				{ role: 'user', text },
				{ role: 'model', text: ambiguousHourReply },
			], { mode: conversationMode }),
			saveAppointmentState(env.CONVERSATIONS, chatId, appointmentState),
		]);
		await sendTelegramMessage(chatId, ambiguousHourReply, env);
		return;
	}
	const onboardingIdentity = settings.onboardingEnabled ? deriveOnboardingIdentity(history, text) : {};
	let knowledgeDocuments = [];
	try {
		knowledgeDocuments = await getKnowledgeContext(env.DB);
	} catch (error) {
		// Los documentos enriquecen las respuestas, pero nunca deben tumbar el flujo principal del bot.
		logError('knowledge_context_unavailable', error, { identity });
	}
	let responseText = await runGeminiAgent({
		apiKey: env.GEMINI_API_KEY,
		systemPrompt: buildSystemPrompt({
			settings, knowledgeDocuments, now,
			onboardingIdentity,
			appointmentState,
		}),
		toolDeclarations: toolDeclarationsForMode(settings.aiMode, settings.onboardingEnabled),
		history,
		userMessage: text,
		diagnostics: env.GEMINI_DIAGNOSTICS === 'true',
		toolContext: {
			env,
			now,
			appointmentState,
			onboardingIdentity,
			userMessage: text,
			telegram: { chatId, userId, username },
			sourceUpdateId: identity ? `telegram:${identity}` : null,
		},
	});
	if (settings.aiMode === 'owner' && isPaymentRegistrationRequest(text)) {
		responseText = addPaymentMediaReminder(responseText);
	}

	const updatedHistory = [
		...history,
		{ role: 'user', text },
		{ role: 'model', text: responseText },
	];
	const updatedAppointmentState = /^Listo\. La cita\b.*quedó registrada correctamente/si.test(responseText)
		? {}
		: deriveAppointmentState(updatedHistory, '', appointmentState);
	await Promise.all([
		saveConversation(env.CONVERSATIONS, chatId, updatedHistory, { mode: conversationMode }),
		saveAppointmentState(env.CONVERSATIONS, chatId, updatedAppointmentState),
	]);
	await sendTelegramMessage(chatId, responseText, env);
}

async function finishClaimedUpdate({ update, message, identity, env, processUpdate }) {
	try {
		await processUpdate({ update, message, identity, env });
		await completeUpdate(env.CONVERSATIONS, identity);
	} catch (error) {
		logError('telegram_update_failed', error, { identity });
		try {
			await sendTelegramMessage(String(message.chat.id), SAFE_ERROR_MESSAGE, env);
			await completeUpdate(env.CONVERSATIONS, identity);
		} catch (sendError) {
			logError('telegram_error_message_failed', sendError, { identity });
			await releaseUpdate(env.CONVERSATIONS, identity);
		}
	}
}

export async function handleTelegramWebhook(
	request,
	env,
	ctx,
	{ processUpdate = processTelegramUpdate } = {},
) {
	let update;
	try {
		update = await readJsonWithLimit(request, 256_000);
	} catch {
		return jsonResponse({ ok: false, error: 'Solicitud inválida' }, 400);
	}

	const message = update?.message;
	if (!message?.chat?.id) return jsonResponse({ ok: true });
	const identity = getUpdateIdentity(update, message);
	if (!(await claimUpdate(env.CONVERSATIONS, identity))) {
		return jsonResponse({ ok: true, duplicate: true });
	}

	ctx.waitUntil(finishClaimedUpdate({ update, message, identity, env, processUpdate }));
	return jsonResponse({ ok: true });
}
