const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth(), // guarda la sesión, no pide QR cada vez
});

// Cuando se genera el QR, lo mostramos en la terminal
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('Escanea este QR con tu WhatsApp (Dispositivos vinculados)');
});

client.on('ready', () => {
  console.log('✅ Bot conectado y listo');
});

// Aquí está la lógica: responde a CUALQUIER mensaje
client.on('message', async (msg) => {
  console.log(`Mensaje recibido de ${msg.from}: ${msg.body}`);
  await msg.reply('Hola, ¿cómo estás?');
});

client.initialize();