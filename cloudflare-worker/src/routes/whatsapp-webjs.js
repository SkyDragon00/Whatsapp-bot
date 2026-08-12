import { MAX_INCOMING_MESSAGE_LENGTH } from '../config/constants.js';
import { runGeminiAgent } from '../ai/gemini.js';
import { transcribeAppointmentAudio } from '../ai/transcription.js';
import { buildSystemPrompt } from '../ai/system-prompt.js';
import { toolDeclarationsForMode } from '../ai/tool-definitions.js';
import { clearConversation, loadConversation, saveConversation } from '../conversation/store.js';
import { getKnowledgeContext } from '../repositories/knowledge-repository.js';
import { getBotBusinessSettings } from '../repositories/settings-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { logError } from '../utils/logging.js';
import { jsonResponse } from '../utils/responses.js';

const CLIENT_START_MESSAGE =
	'Hola. Soy tu asistente de citas. Puedo mostrarte servicios, horarios disponibles, agendar y cancelar citas.';
const OWNER_START_MESSAGE =
	'Hola. Estoy en modo dueño. Puedo agendar citas para tus clientes y registrar pagos recibidos.';
const ONBOARDING_START_MESSAGE =
	'Hola. Soy un asistente de inteligencia artificial y te ayudaré a configurar tu negocio. Empecemos: ¿cuál es el nombre de tu negocio?';
const CANCEL_MESSAGE = 'Listo, reinicié la conversación actual. Puedes comenzar de nuevo cuando quieras.';

function bearerToken(request) {
	const authorization = request.headers.get('authorization') || '';
	return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function processWhatsAppWebJsMessage({ sender, text, audio, messageId, profileName, env, now = new Date() }) {
	const channelId = `whatsapp:${sender}`;
	if (text.length > MAX_INCOMING_MESSAGE_LENGTH) {
		return 'El mensaje es demasiado largo. Envíalo de forma más breve.';
	}

	const command = text ? text.split(/\s+/, 1)[0].toLowerCase() : '';
	if (command === '/start' || command === '/cancelar') {
		await clearConversation(env.CONVERSATIONS, channelId);
		if (command === '/cancelar') return CANCEL_MESSAGE;
		const settings = await getBotBusinessSettings(env.DB);
		return settings.onboardingEnabled
			? ONBOARDING_START_MESSAGE
			: settings.aiMode === 'owner' ? OWNER_START_MESSAGE : CLIENT_START_MESSAGE;
	}

	const settings = await getBotBusinessSettings(env.DB);
	if (audio) {
		if (settings.aiMode !== 'client') {
			return 'Las notas de voz para solicitar citas están disponibles en modo cliente.';
		}
		text = await transcribeAppointmentAudio({
			apiKey: env.GEMINI_API_KEY,
			bytes: audio.bytes,
			mimeType: audio.mimeType,
		});
	}
	const conversationMode = settings.onboardingEnabled ? 'onboarding' : 'normal';
	const history = await loadConversation(env.CONVERSATIONS, channelId, { mode: conversationMode });
	let knowledgeDocuments = [];
	try {
		knowledgeDocuments = await getKnowledgeContext(env.DB);
	} catch (error) {
		logError('knowledge_context_unavailable', error, { identity: messageId, channel: 'whatsapp-webjs' });
	}

	const responseText = await runGeminiAgent({
		apiKey: env.GEMINI_API_KEY,
		systemPrompt: buildSystemPrompt({ settings, knowledgeDocuments, now }),
		toolDeclarations: toolDeclarationsForMode(settings.aiMode, settings.onboardingEnabled),
		history,
		userMessage: text,
		diagnostics: env.GEMINI_DIAGNOSTICS === 'true',
		toolContext: {
			env,
			now,
			userMessage: text,
			telegram: { chatId: sender, userId: sender, username: profileName },
			sourceUpdateId: `whatsapp-webjs:${messageId}`,
		},
	});

	await saveConversation(env.CONVERSATIONS, channelId, [
		...history,
		{ role: 'user', text },
		{ role: 'model', text: responseText },
	], { mode: conversationMode });
	return responseText;
}

export async function handleWhatsAppWebJsBridge(request, env) {
	if (!env.WHATSAPP_WEBJS_TOKEN || bearerToken(request) !== env.WHATSAPP_WEBJS_TOKEN) {
		return jsonResponse({ ok: false, error: 'No autorizado' }, 401);
	}

	let payload;
	try {
		payload = await readJsonWithLimit(request, 14_000_000);
	} catch {
		return jsonResponse({ ok: false, error: 'Solicitud inválida' }, 400);
	}

	const sender = typeof payload?.sender === 'string' ? payload.sender.replace(/\D/g, '') : '';
	let text = typeof payload?.text === 'string' ? payload.text.trim() : '';
	const messageId = typeof payload?.messageId === 'string' ? payload.messageId.slice(0, 256) : '';
	const profileName = typeof payload?.profileName === 'string' ? payload.profileName.slice(0, 160) : null;
	let audio = null;
	if (payload?.audio && typeof payload.audio.data === 'string') {
		try {
			const binary = atob(payload.audio.data);
			if (binary.length > 10 * 1024 * 1024) throw new Error('AUDIO_TOO_LARGE');
			audio = {
				bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer,
				mimeType: typeof payload.audio.mimeType === 'string' ? payload.audio.mimeType.slice(0, 100) : 'audio/ogg',
			};
		} catch {
			return jsonResponse({ ok: false, error: 'Audio inválido o demasiado grande' }, 400);
		}
	}
	if (!sender || (!text && !audio) || !messageId) {
		return jsonResponse({ ok: false, error: 'Faltan sender, mensaje o messageId' }, 400);
	}

	const reply = await processWhatsAppWebJsMessage({ sender, text, audio, messageId, profileName, env });
	return jsonResponse({ ok: true, reply });
}
