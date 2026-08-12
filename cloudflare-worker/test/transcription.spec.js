import { describe, expect, it, vi } from 'vitest';
import { transcribeAppointmentAudio } from '../src/ai/transcription.js';

describe('transcripción de citas por audio', () => {
	it('envía el audio a Gemini y devuelve únicamente la transcripción', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			candidates: [{ content: { parts: [{ text: 'Quiero un corte mañana a las diez.' }] } }],
		}), { headers: { 'Content-Type': 'application/json' } }));

		const transcript = await transcribeAppointmentAudio({
			apiKey: 'test',
			bytes: new Uint8Array([1, 2, 3]).buffer,
			mimeType: 'audio/ogg',
			fetchImpl,
		});

		expect(transcript).toBe('Quiero un corte mañana a las diez.');
		const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'audio/ogg', data: 'AQID' });
		expect(body.systemInstruction.parts[0].text).toContain('Transcribe fielmente');
		expect(body.tools).toBeUndefined();
	});
});
