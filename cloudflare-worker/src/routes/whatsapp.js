import {
	IDEMPOTENCY_DONE_TTL_SECONDS,
	IDEMPOTENCY_PROCESSING_TTL_SECONDS,
	MAX_INCOMING_MESSAGE_LENGTH,
} from '../config/constants.js';
import { runGeminiAgent } from '../ai/gemini.js';
import { transcribeAppointmentAudio } from '../ai/transcription.js';
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
import {
	downloadWhatsAppMedia,
	sendWhatsAppMessage,
	sendWhatsAppTypingIndicator,
} from '../integrations/whatsapp.js';
import { handleExpenseConfirmation, processExpenseMessage } from '../expenses/flow.js';
import { isExplicitExpenseText } from '../expenses/telegram-router.js';
import { routeWhatsAppMessage } from '../expenses/whatsapp-router.js';
import { attachPaymentReceipt } from '../repositories/payments-repository.js';
import { storeReceipt } from '../storage/receipts.js';
import { getKnowledgeContext } from '../repositories/knowledge-repository.js';
import { getBotCompanyId, getBusinessSettings } from '../repositories/settings-repository.js';
import { findUserByPhone } from '../repositories/user-identity-repository.js';
import { listServices } from '../repositories/services-repository.js';
import { logError } from '../utils/logging.js';
import { jsonResponse } from '../utils/responses.js';

const CLIENT_START_MESSAGE =
	'Hola. Soy tu asistente de citas. Puedo mostrarte servicios, horarios disponibles, agendar y cancelar citas.';
const OWNER_START_MESSAGE =
	'Hola. Estoy en modo dueño. Puedo agendar citas para tus clientes y registrar pagos recibidos.';
const ONBOARDING_START_MESSAGE =
	'Hola, te ayudaré a configurar tu negocio. ¿Cuál es el nombre del negocio?';
const CANCEL_MESSAGE = 'Listo, reinicié la conversación actual. Puedes comenzar de nuevo cuando quieras.';
const SAFE_ERROR_MESSAGE = 'Tuve un problema procesando el mensaje. Intenta nuevamente en unos segundos.';
const MAX_WEBHOOK_BYTES = 512_000;

function conversationId(sender) {
	return `whatsapp:${sender}`;
}

export function hasCompletedOnboardingHistory(history = []) {
	return history.some((message) => {
		if (message?.role !== 'model') return false;
		const text = String(message.text ?? '').toLocaleLowerCase('es');
		return /(?:negocio|empresa).{0,160}(?:fue creado|fue registrada|fueron creados|registro (?:ya )?fue completado)/s.test(text)
			|| /(?:fueron creados|registro (?:ya )?fue completado).{0,160}(?:negocio|empresa)/s.test(text);
	});
}

export function authorizeWhatsAppUser(settings, linkedUser) {
	const ownerAuthorized = linkedUser?.role === 'admin' && Number.isInteger(linkedUser.company_id);
	const authorizedSettings = ownerAuthorized
		? { ...settings, onboardingEnabled: false }
		: settings.onboardingEnabled
			? settings
			: { ...settings, aiMode: 'client' };
	return {
		ownerAuthorized,
		settings: authorizedSettings,
	};
}

function idempotencyKey(messageId) {
	return `whatsapp-message:${messageId}`;
}

async function claimMessage(kv, messageId) {
	if (!messageId) return true;
	const key = idempotencyKey(messageId);
	if (await kv.get(key)) return false;
	await kv.put(key, 'processing', { expirationTtl: IDEMPOTENCY_PROCESSING_TTL_SECONDS });
	return true;
}

async function completeMessage(kv, messageId) {
	if (!messageId) return;
	await kv.put(idempotencyKey(messageId), 'done', { expirationTtl: IDEMPOTENCY_DONE_TTL_SECONDS });
}

async function releaseMessage(kv, messageId) {
	if (!messageId) return;
	await kv.delete(idempotencyKey(messageId));
}

function parseHex(value) {
	if (!/^[a-f0-9]{64}$/i.test(value)) return null;
	return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

async function hasValidSignature(rawBody, signatureHeader, appSecret) {
	if (!appSecret) return true;
	if (!signatureHeader?.startsWith('sha256=')) return false;
	const signature = parseHex(signatureHeader.slice(7));
	if (!signature) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(appSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	return crypto.subtle.verify('HMAC', key, signature, rawBody);
}

function extractMessages(payload) {
	if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return [];
	const messages = [];
	for (const entry of payload.entry) {
		for (const change of entry?.changes || []) {
			const value = change?.value;
			if (!Array.isArray(value?.messages)) continue;
			const names = new Map(
				(value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name || null]),
			);
			for (const message of value.messages) {
				if (!message?.from || !message?.id) continue;
				messages.push({ ...message, profileName: names.get(message.from) || null });
			}
		}
	}
	return messages;
}

export function handleWhatsAppVerification(request, env, url = new URL(request.url)) {
	const mode = url.searchParams.get('hub.mode');
	const token = url.searchParams.get('hub.verify_token');
	const challenge = url.searchParams.get('hub.challenge');
	if (mode === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN) {
		return new Response(challenge || '', { status: 200 });
	}
	return new Response('Forbidden', { status: 403 });
}

export async function processWhatsAppMessage({ message, env, now = new Date() }) {
	const recipient = String(message.from);
	const linkedUser = await findUserByPhone(env.DB, recipient);
	const platformSettings = await getBusinessSettings(env.DB);
	const platformOnboardingEnabled = platformSettings.onboardingEnabled === true;
	const companyId = linkedUser?.company_id
		?? (platformOnboardingEnabled ? null : await getBotCompanyId(env.DB));
	const businessSettings = !linkedUser && platformOnboardingEnabled
		? platformSettings
		: await getBusinessSettings(env.DB, { companyId });
	const authorization = authorizeWhatsAppUser(businessSettings, linkedUser);
	const { ownerAuthorized, settings } = authorization;
	const channelId = conversationId(recipient);
	const route = routeWhatsAppMessage(message);
	let text = route.type === 'text' ? route.text : '';
	if (route.type === 'text' && !text) return;
	if (text.length > MAX_INCOMING_MESSAGE_LENGTH) {
		await sendWhatsAppMessage(recipient, 'El mensaje es demasiado largo. Envíalo de forma más breve.', env);
		return;
	}
	try {
		await sendWhatsAppTypingIndicator(message.id, env);
	} catch (error) {
		logError('whatsapp_typing_indicator_failed', error, { identity: message.id });
	}
	if (route.type === 'image') {
		const pendingKey = `pending-payment-receipt:${recipient}`;
		const pending = await env.CONVERSATIONS.get(pendingKey, 'json');
		if (pending?.paymentId && !ownerAuthorized) await env.CONVERSATIONS.delete(pendingKey);
		if (pending?.paymentId && ownerAuthorized) {
			const pendingPayment = await env.DB.prepare(
				'SELECT id, payment_method FROM payments WHERE id = ?1 AND company_id IS ?2 LIMIT 1',
			).bind(pending.paymentId, companyId).first();
			if (pendingPayment?.payment_method?.trim().toLocaleLowerCase('es') === 'transferencia') {
				const media = await downloadWhatsAppMedia(route.fileId, env);
				const receipt = await storeReceipt(env.RECEIPTS, {
					ownerType: 'payments', ownerId: pending.paymentId, bytes: media.bytes,
					mimeType: media.mimeType || route.mimeType,
					fileName: media.fileName || `comprobante-whatsapp-${message.id}.jpg`,
				});
				const payment = await attachPaymentReceipt(env.DB, pending.paymentId, receipt);
				if (!payment) throw new Error('PENDING_PAYMENT_NOT_FOUND');
				await env.CONVERSATIONS.delete(pendingKey);
				await sendWhatsAppMessage(recipient, 'Listo, guardé el comprobante en el pago de la transferencia.', env);
				return;
			}
			await env.CONVERSATIONS.delete(pendingKey);
		}
	}

	const command = route.type === 'text' ? text.split(/\s+/, 1)[0].toLowerCase() : '';
	if (command === '/start' || command === '/cancelar') {
		await Promise.all([
			clearConversation(env.CONVERSATIONS, channelId),
			env.CONVERSATIONS.delete(`pending-payment-receipt:${recipient}`),
		]);
		if (command === '/cancelar') {
			await sendWhatsAppMessage(recipient, CANCEL_MESSAGE, env);
			return;
		}
		const startMessage = settings.onboardingEnabled
			? ONBOARDING_START_MESSAGE
			: settings.aiMode === 'owner'
				? OWNER_START_MESSAGE
				: buildClientWelcomeMessage(await listServices(env.DB, { limit: 100, companyId }));
		const conversationMode = settings.onboardingEnabled ? 'onboarding' : 'normal';
		await saveConversation(env.CONVERSATIONS, channelId, [
			{ role: 'model', text: startMessage },
		], { mode: conversationMode });
		await sendWhatsAppMessage(recipient, startMessage, env);
		return;
	}

	const sendMessage = (chatId, body, targetEnv) => sendWhatsAppMessage(chatId, body, targetEnv);
	if (ownerAuthorized && route.type === 'text' && await handleExpenseConfirmation({
		text, chatId: recipient, userId: recipient, env, now, companyId, sendMessage,
	})) return;
	if (ownerAuthorized && settings.aiMode === 'owner' && (route.type !== 'text' || isExplicitExpenseText(text))) {
		await processExpenseMessage({
			route, chatId: recipient, userId: recipient, companyId,
			settings, env, now, sendMessage, downloadMedia: downloadWhatsAppMedia,
		});
		return;
	}
	if (settings.aiMode === 'client' && route.type === 'audio') {
		const media = await downloadWhatsAppMedia(route.fileId, env);
		text = await transcribeAppointmentAudio({
			apiKey: env.GEMINI_API_KEY,
			bytes: media.bytes,
			mimeType: route.mimeType || media.mimeType,
		});
	}
	if (route.type !== 'text' && !(settings.aiMode === 'client' && route.type === 'audio')) {
		await sendWhatsAppMessage(recipient, 'El registro de gastos solo está disponible en modo dueño.', env);
		return;
	}
	const conversationMode = settings.onboardingEnabled ? 'onboarding' : 'normal';
	let [history, storedAppointmentState] = await Promise.all([
		loadConversation(env.CONVERSATIONS, channelId, { mode: conversationMode }),
		loadAppointmentState(env.CONVERSATIONS, channelId),
	]);
	if (!settings.onboardingEnabled && settings.aiMode === 'client' && history.length === 0) {
		const welcomeMessage = buildClientWelcomeMessage(await listServices(env.DB, { limit: 100, companyId }));
		await saveConversation(env.CONVERSATIONS, channelId, [
			{ role: 'user', text }, { role: 'model', text: welcomeMessage },
		], { mode: conversationMode });
		await sendWhatsAppMessage(recipient, welcomeMessage, env);
		return;
	}
	if (settings.onboardingEnabled && !linkedUser && hasCompletedOnboardingHistory(history)) {
		await clearConversation(env.CONVERSATIONS, channelId);
		history = [];
		storedAppointmentState = {};
	}
	const appointmentState = settings.onboardingEnabled
		? {}
		: deriveAppointmentState(history, text, storedAppointmentState);
	const ambiguousHourReply = settings.onboardingEnabled
		? null
		: buildAmbiguousHourReply(text, settings.businessHours);
	if (ambiguousHourReply) {
		await Promise.all([
			saveConversation(env.CONVERSATIONS, channelId, [
				...history,
				{ role: 'user', text },
				{ role: 'model', text: ambiguousHourReply },
			], { mode: conversationMode }),
			saveAppointmentState(env.CONVERSATIONS, channelId, appointmentState),
		]);
		await sendWhatsAppMessage(recipient, ambiguousHourReply, env);
		return;
	}
	const onboardingIdentity = settings.onboardingEnabled ? deriveOnboardingIdentity(history, text) : {};
	let knowledgeDocuments = [];
	try {
		knowledgeDocuments = await getKnowledgeContext(env.DB, { companyId });
	} catch (error) {
		logError('knowledge_context_unavailable', error, { identity: message.id, channel: 'whatsapp' });
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
			companyId,
			appointmentState,
			linkedUser,
			ownerAuthorized,
			onboardingIdentity,
			whatsappPhone: recipient,
			userMessage: text,
			// Las tablas existentes conservan estos nombres por compatibilidad con Telegram.
			telegram: { chatId: recipient, userId: recipient, username: message.profileName },
			sourceUpdateId: `whatsapp:${message.id}`,
		},
	});
	if (ownerAuthorized && settings.aiMode === 'owner' && isPaymentRegistrationRequest(text)) {
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
		saveConversation(env.CONVERSATIONS, channelId, updatedHistory, { mode: conversationMode }),
		saveAppointmentState(env.CONVERSATIONS, channelId, updatedAppointmentState),
	]);
	await sendWhatsAppMessage(recipient, responseText, env);
}

async function finishClaimedMessage({ message, env, processMessage }) {
	try {
		await processMessage({ message, env });
		await completeMessage(env.CONVERSATIONS, message.id);
	} catch (error) {
		logError('whatsapp_message_failed', error, { identity: message.id });
		try {
			await sendWhatsAppMessage(String(message.from), SAFE_ERROR_MESSAGE, env);
			await completeMessage(env.CONVERSATIONS, message.id);
		} catch (sendError) {
			logError('whatsapp_error_message_failed', sendError, { identity: message.id });
			await releaseMessage(env.CONVERSATIONS, message.id);
		}
	}
}

export async function handleWhatsAppWebhook(
	request,
	env,
	ctx,
	{ processMessage = processWhatsAppMessage } = {},
) {
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
		return jsonResponse({ ok: false, error: 'Solicitud demasiado grande' }, 413);
	}

	let rawBody;
	let payload;
	try {
		rawBody = await request.arrayBuffer();
		if (rawBody.byteLength > MAX_WEBHOOK_BYTES) {
			return jsonResponse({ ok: false, error: 'Solicitud demasiado grande' }, 413);
		}
		if (!(await hasValidSignature(
			rawBody,
			request.headers.get('x-hub-signature-256'),
			env.META_APP_SECRET,
		))) {
			return jsonResponse({ ok: false, error: 'Firma inválida' }, 401);
		}
		payload = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return jsonResponse({ ok: false, error: 'Solicitud inválida' }, 400);
	}

	let accepted = 0;
	let duplicates = 0;
	for (const message of extractMessages(payload)) {
		if (!(await claimMessage(env.CONVERSATIONS, message.id))) {
			duplicates += 1;
			continue;
		}
		accepted += 1;
		ctx.waitUntil(finishClaimedMessage({ message, env, processMessage }));
	}
	return jsonResponse({ ok: true, accepted, duplicates });
}
