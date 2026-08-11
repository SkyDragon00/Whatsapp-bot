import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker actual', () => {
	it('mantiene deshabilitado el puente heredado de whatsapp-web.js', async () => {
		const response = await SELF.fetch('https://example.com/whatsapp-webjs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sender: '593999111222', text: 'Hola', messageId: 'legacy-1' }),
		});
		expect(response.status).toBe(404);
	});

	it('conserva operativo el endpoint de estado', async () => {
		const response = await SELF.fetch('http://example.com/health');
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, message: 'Asistente de citas funcionando' });
	});

	it('sirve el dashboard con una API base configurable y sin depender de Express', async () => {
		const response = await SELF.fetch('http://example.com/');
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(html).toContain('window.APPOINTMENTS_API_BASE_URL');
		expect(html).toContain("'http://127.0.0.1:8787'");
		expect(html).toContain("credentials: 'include'");
		expect(html).toContain('Registrar negocio');
		expect(html).not.toContain('localhost:3000');
	});
});
