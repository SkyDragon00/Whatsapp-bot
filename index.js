const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const workerUrl = String(process.env.WHATSAPP_ASSISTANT_URL || '').replace(/\/$/, '');
const bridgeToken = process.env.WHATSAPP_WEBJS_TOKEN || '';

if (!workerUrl || !bridgeToken) {
  console.error('Configura WHATSAPP_ASSISTANT_URL y WHATSAPP_WEBJS_TOKEN antes de iniciar el bot.');
  process.exitCode = 1;
} else {
  const client = new Client({ authStrategy: new LocalAuth() });

  client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escanea este QR con tu WhatsApp (Dispositivos vinculados)');
  });

  client.on('ready', () => console.log('Bot de WhatsApp conectado al asistente virtual'));

  client.on('message', async (msg) => {
    if (msg.fromMe || msg.from === 'status@broadcast' || msg.from.endsWith('@g.us')) return;
    const text = typeof msg.body === 'string' ? msg.body.trim() : '';
    if (!text) return;

    try {
      const contact = await msg.getContact();
      const response = await fetch(`${workerUrl}/whatsapp-webjs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridgeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: msg.from,
          messageId: msg.id?._serialized || `${msg.from}:${msg.timestamp}`,
          profileName: contact.pushname || contact.name || null,
          text,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (result.reply) await msg.reply(result.reply);
    } catch (error) {
      console.error('No se pudo procesar el mensaje con el asistente:', error.message);
      await msg.reply('Tuve un problema procesando el mensaje. Intenta nuevamente en unos segundos.');
    }
  });

  client.on('auth_failure', (message) => console.error('Falló la autenticación de WhatsApp:', message));
  client.on('disconnected', (reason) => console.warn('WhatsApp se desconectó:', reason));
  client.initialize();
}
