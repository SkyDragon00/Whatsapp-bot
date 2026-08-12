import { GEMINI_MODEL, GEMINI_TIMEOUT_MS, MAX_INCOMING_MESSAGE_LENGTH } from '../config/constants.js';
import { AiProtocolError } from '../domain/errors.js';
import { fetchWithTimeout, readJsonWithLimit } from '../utils/http.js';

function bytesToBase64(bytes) {
	const view = new Uint8Array(bytes);
	let binary = '';
	for (let offset = 0; offset < view.length; offset += 0x8000) {
		binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

export async function transcribeAppointmentAudio({ apiKey, bytes, mimeType, fetchImpl = fetch }) {
	if (!apiKey) throw new Error('GEMINI_API_KEY_NOT_CONFIGURED');
	const response = await fetchWithTimeout(
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: 'Transcribe fielmente esta nota de voz en español. Devuelve solamente lo que dijo la persona, sin explicaciones, suposiciones ni formato adicional.' }] },
				contents: [{ role: 'user', parts: [{ inlineData: {
					mimeType: mimeType || 'audio/ogg',
					data: bytesToBase64(bytes),
				} }] }],
				generationConfig: { temperature: 0, maxOutputTokens: 600 },
				store: false,
			}),
		},
		GEMINI_TIMEOUT_MS,
		fetchImpl,
	);
	const result = await readJsonWithLimit(response, 500_000);
	if (!response.ok) throw new Error(`GEMINI_TRANSCRIPTION_FAILED_${response.status}`);
	const transcript = result?.candidates?.[0]?.content?.parts
		?.map((part) => typeof part.text === 'string' ? part.text : '')
		.join('')
		.trim();
	if (!transcript) throw new AiProtocolError('No se pudo transcribir la nota de voz.');
	return transcript.slice(0, MAX_INCOMING_MESSAGE_LENGTH);
}
