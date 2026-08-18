import { describe, expect, it, vi } from 'vitest';
import { runGeminiAgent } from '../src/ai/gemini.js';
import { AiProtocolError } from '../src/domain/errors.js';

function geminiResponse(parts) {
	return new Response(
		JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	);
}

describe('bucle de herramientas de Gemini', () => {
	it('no anuncia una cita hasta que create_appointment confirma la escritura', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(geminiResponse([{ text: 'Listo, tu cita quedó confirmada.' }]))
			.mockResolvedValueOnce(geminiResponse([{ functionCall: {
				name: 'create_appointment',
				args: { customer_name: 'María Hanchett', service_id: 4, start_datetime: '2026-08-20T15:00:00.000Z' },
			} }]));
		const executeToolResult = vi.fn().mockResolvedValue({
			ok: true,
			data: { appointment: { id: 81, customer_name: 'María Hanchett', service_name: 'Corte Barba' } },
		});

		const result = await runGeminiAgent({
			apiKey: 'test-key',
			systemPrompt: 'Prompt',
			history: [{ role: 'model', text: '¿Está todo correcto? Confírmame para dejar la cita agendada.' }],
			userMessage: 'Sí', toolContext: {}, fetchImpl, executeToolResult,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(executeToolResult).toHaveBeenCalledWith('create_appointment', expect.any(Object), {});
		expect(result).toContain('registrada correctamente en la agenda');
	});

	it('informa el fallo de escritura sin afirmar que la cita fue confirmada', async () => {
		const result = await runGeminiAgent({
			apiKey: 'test-key', systemPrompt: 'Prompt', userMessage: 'Sí', toolContext: {},
			fetchImpl: vi.fn().mockResolvedValue(geminiResponse([{ functionCall: {
				name: 'create_appointment', args: { customer_name: 'María', service_id: 4, start_datetime: '2026-08-20T15:00:00.000Z' },
			} }])),
			executeToolResult: vi.fn().mockResolvedValue({ ok: false, error: { message: 'El horario ya no está disponible.' } }),
		});

		expect(result).toContain('No pude agendar la cita');
		expect(result).toContain('no quedó confirmada');
	});

	it('solo anuncia el alta de onboarding cuando la herramienta confirma la escritura', async () => {
		const call = geminiResponse([{ functionCall: {
			name: 'register_business_from_onboarding',
			args: { business_name: 'Peludos Amigos', username: 'Ana', communication_style: 'friend' },
		} }]);
		const successFetch = vi.fn().mockResolvedValue(call);
		const success = await runGeminiAgent({
			apiKey: 'test-key', systemPrompt: 'Prompt', userMessage: 'Listo, todo correcto', toolContext: {},
			fetchImpl: successFetch,
			executeToolResult: vi.fn().mockResolvedValue({ ok: true, data: { businessName: 'Peludos Amigos', username: 'Ana' } }),
		});
		expect(success).toContain('fueron creados correctamente');
		expect(success).toContain('12345678');
		expect(successFetch).toHaveBeenCalledTimes(1);

		const failure = await runGeminiAgent({
			apiKey: 'test-key', systemPrompt: 'Prompt', userMessage: 'Listo, todo correcto', toolContext: {},
			fetchImpl: vi.fn().mockImplementation(() => Promise.resolve(geminiResponse([{ functionCall: {
				name: 'register_business_from_onboarding', args: {},
			} }]))),
			executeToolResult: vi.fn().mockResolvedValue({ ok: false, error: { message: 'Ese usuario ya existe.' } }),
		});
		expect(failure).toContain('No pude crear la cuenta');
		expect(failure).toContain('todavía no intentes iniciar sesión');
	});

	it('integra usuario, list_services, functionResponse y respuesta final en orden', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				geminiResponse([
					{
						functionCall: { id: 'services-call-1', name: 'list_services', args: {} },
						thoughtSignature: 'firma-servicios',
					},
				]),
			)
			.mockResolvedValueOnce(geminiResponse([{ text: 'Claro. Primero elige uno de nuestros servicios.' }]));
		const toolResponse = {
			ok: true,
			data: { services: [{ id: 1, name: 'Corte', duration_minutes: 45 }] },
		};
		const executeToolResult = vi.fn().mockResolvedValue(toolResponse);

		const result = await runGeminiAgent({
			apiKey: 'test-key',
			systemPrompt: 'Prompt de prueba',
			userMessage: 'Quiero agendar una cita',
			toolContext: {},
			fetchImpl,
			executeToolResult,
		});

		expect(result).toBe('Claro. Primero elige uno de nuestros servicios.');
		expect(executeToolResult).toHaveBeenCalledWith('list_services', {}, {});
		expect(fetchImpl.mock.calls[0][0]).toBe(
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
		);

		const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
		expect(secondBody.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
		expect(secondBody.contents[0]).toEqual({
			role: 'user',
			parts: [{ text: 'Quiero agendar una cita' }],
		});
		expect(secondBody.contents[1].parts[0]).toMatchObject({
			functionCall: { id: 'services-call-1', name: 'list_services', args: {} },
			thoughtSignature: 'firma-servicios',
		});
		expect(secondBody.contents[2]).toEqual({
			role: 'user',
			parts: [
				{
					functionResponse: {
						id: 'services-call-1',
						name: 'list_services',
						response: toolResponse,
					},
				},
			],
		});
	});

	it('ejecuta una herramienta y devuelve su resultado al modelo', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				geminiResponse([{ functionCall: { id: 'call-1', name: 'list_services', args: {} }, thoughtSignature: 'firma' }]),
			)
			.mockResolvedValueOnce(geminiResponse([{ text: 'Tenemos corte y manicure.' }]));
		const executeToolResult = vi.fn().mockResolvedValue({
			ok: true,
			data: { services: [{ id: 1, name: 'Corte' }] },
		});

		const result = await runGeminiAgent({
			apiKey: 'test-key',
			systemPrompt: 'Prompt de prueba',
			history: [],
			userMessage: '¿Qué servicios tienen?',
			toolContext: {},
			fetchImpl,
			executeToolResult,
		});

		expect(result).toBe('Tenemos corte y manicure.');
		expect(executeToolResult).toHaveBeenCalledWith('list_services', {}, {});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(firstBody.tools[0].functionDeclarations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'list_services',
					parametersJsonSchema: expect.objectContaining({ additionalProperties: false }),
				}),
			]),
		);
		expect(firstBody.tools[0].functionDeclarations.every((declaration) => declaration.parameters === undefined)).toBe(true);
		const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
		expect(secondBody.contents.at(-2).parts[0]).toMatchObject({
			functionCall: { name: 'list_services' },
			thoughtSignature: 'firma',
		});
		expect(secondBody.contents.at(-1).parts[0]).toMatchObject({
			functionResponse: { id: 'call-1', name: 'list_services', response: { ok: true } },
		});
	});

	it('rechaza herramientas fuera de la lista permitida', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			geminiResponse([{ functionCall: { name: 'execute_sql', args: { sql: 'SELECT 1' } } }]),
		);
		const executeToolResult = vi.fn();

		await expect(
			runGeminiAgent({
				apiKey: 'test-key',
				systemPrompt: 'Prompt',
				userMessage: 'Haz una consulta',
				toolContext: {},
				fetchImpl,
				executeToolResult,
			}),
		).rejects.toBeInstanceOf(AiProtocolError);
		expect(executeToolResult).not.toHaveBeenCalled();
	});

	it('detiene ciclos infinitos despues del maximo configurado', async () => {
		const fetchImpl = vi.fn().mockImplementation(() =>
			Promise.resolve(geminiResponse([{ functionCall: { name: 'get_business_settings', args: {} } }])),
		);

		await expect(
			runGeminiAgent({
				apiKey: 'test-key',
				systemPrompt: 'Prompt',
				userMessage: 'Consulta',
				toolContext: {},
				fetchImpl,
				executeToolResult: vi.fn().mockResolvedValue({ ok: true, data: {} }),
			}),
		).rejects.toBeInstanceOf(AiProtocolError);
		expect(fetchImpl).toHaveBeenCalledTimes(5);
	});

	it('limita llamadas paralelas aunque ocurran en una sola ronda', async () => {
		const calls = Array.from({ length: 9 }, () => ({
			functionCall: { name: 'get_business_settings', args: {} },
		}));
		const executeToolResult = vi.fn();

		await expect(
			runGeminiAgent({
				apiKey: 'test-key',
				systemPrompt: 'Prompt',
				userMessage: 'Consulta',
				toolContext: {},
				fetchImpl: vi.fn().mockResolvedValue(geminiResponse(calls)),
				executeToolResult,
			}),
		).rejects.toBeInstanceOf(AiProtocolError);
		expect(executeToolResult).not.toHaveBeenCalled();
	});

	it('registra errores de Google sanitizados sin prompts ni secretos', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: 400,
						status: 'INVALID_ARGUMENT',
						message: 'Invalid payload for user@example.com using api_key=AIzaSecretValueThatMustBeRemoved12345',
					},
				}),
				{ status: 400, headers: { 'Content-Type': 'application/json' } },
			),
		);

		await expect(
			runGeminiAgent({
				apiKey: 'test-key',
				systemPrompt: 'Prompt que no debe registrarse',
				userMessage: 'Dato personal que no debe registrarse',
				toolContext: {},
				fetchImpl,
				diagnostics: true,
			}),
		).rejects.toMatchObject({ code: 'GEMINI_REQUEST_FAILED', status: 400 });

		const entries = errorLog.mock.calls.map(([value]) => JSON.parse(value));
		const diagnostic = entries.find((entry) => entry.event === 'gemini_request_failed');
		expect(diagnostic).toMatchObject({
			httpStatus: 400,
			googleErrorStatus: 'INVALID_ARGUMENT',
			googleErrorCode: 400,
			contentsCount: 1,
			functionCallNames: [],
			iteration: 1,
		});
		expect(diagnostic.toolNames).toContain('list_services');
		expect(diagnostic.googleErrorMessage).toContain('[email omitted]');
		const serializedLog = JSON.stringify(diagnostic);
		expect(serializedLog).not.toContain('AIzaSecretValue');
		expect(serializedLog).not.toContain('Dato personal');
		expect(serializedLog).not.toContain('Prompt que');

		errorLog.mockRestore();
		infoLog.mockRestore();
	});
});
