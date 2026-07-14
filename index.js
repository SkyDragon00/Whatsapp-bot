const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chrono = require('chrono-node');
const db = require('./db');
const { startServer } = require('./server');
const {
  DAY_NAMES,
  getSettings,
  isWithinBusinessHours,
  formatBusinessHoursForDay,
} = require('./settings');

const client = new Client({
  authStrategy: new LocalAuth(),
});

// Guarda el progreso de cada usuario: { step, data: { name, service, date_text, date_iso } }
const conversationState = new Map();

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('Escanea este QR con tu WhatsApp (Dispositivos vinculados)');
});

client.on('ready', () => {
  console.log('✅ Bot conectado y listo');
  startServer();
});

client.on('message', async (msg) => {
  const from = msg.from;
  const text = msg.body.trim();
  const state = conversationState.get(from);

  // ===== INICIO DEL FLUJO =====
  if (!state && /cita|agendar|reservar/i.test(text)) {
    conversationState.set(from, { step: 'nombre', data: {} });
    await msg.reply('¡Claro! Vamos a agendar tu cita 📋\n\n¿Cuál es el *nombre y apellido* del paciente?');
    return;
  }

  if (!state) {
    await msg.reply('Hola, ¿cómo estás? Si quieres agendar una cita, dime "quiero agendar una cita".');
    return;
  }

  // ===== PASO 1: NOMBRE =====
  if (state.step === 'nombre') {
    // Validamos que tenga al menos nombre y apellido (2 palabras)
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await msg.reply('Necesito el *nombre y apellido* completo del paciente. Ej: "Juan Pérez"');
      return;
    }
    state.data.name = text;
    state.step = 'servicio';
    await msg.reply('Perfecto. ¿Cuál es el *servicio* que desea agendar?');
    return;
  }

  // ===== PASO 2: SERVICIO =====
  if (state.step === 'servicio') {
    if (text.length < 3) {
      await msg.reply('Por favor dime el *servicio* que se va a agendar (ej: "Consulta general", "Limpieza dental", etc.)');
      return;
    }
    state.data.service = text;
    state.step = 'fecha';
    await msg.reply('¿Qué *día y hora* te gustaría agendar? (ej: "mañana a las 3pm" o "15 de julio a las 10am")');
    return;
  }

  // ===== PASO 3: FECHA/HORA =====
  if (state.step === 'fecha') {
    const parsedDate = chrono.es.parseDate(text, new Date(), { forwardDate: true });

    if (!parsedDate) {
      await msg.reply('No logré entender esa fecha 😕 Intenta algo como "mañana a las 3pm" o "15 de julio a las 10am"');
      return;
    }

    state.data.date_text = text;
    state.data.date_iso = parsedDate.toISOString();

    const settings = getSettings();
    const hoursValidation = isWithinBusinessHours(parsedDate, settings);
    if (!hoursValidation.ok) {
      const dayName = DAY_NAMES[parsedDate.getDay()];
      const hoursText = formatBusinessHoursForDay(hoursValidation.dayHours);
      await msg.reply(
        `No puedo agendar esa cita porque el horario de ${dayName} es ${hoursText} y cada cita dura ${settings.appointmentDurationMinutes} minutos.\n\nPor favor dime otra fecha u hora dentro del horario de atencion.`
      );
      return;
    }

    // Validación final: nos aseguramos que TODOS los datos estén completos
    const { name, service, date_iso } = state.data;
    if (!name || !service || !date_iso) {
      conversationState.delete(from);
      await msg.reply('❌ No pude agendar la cita por falta de datos. Por favor empieza de nuevo escribiendo "quiero agendar una cita".');
      return;
    }

    // Todo completo -> guardamos
    db.prepare(
      `INSERT INTO appointments (phone, patient_name, service, date_text, date_iso) VALUES (?, ?, ?, ?, ?)`
    ).run(from, name, service, state.data.date_text, date_iso);

    conversationState.delete(from);

    const fechaLegible = parsedDate.toLocaleString('es-EC', {
      dateStyle: 'full',
      timeStyle: 'short',
    });

    await msg.reply(
      `✅ Cita confirmada:\n\n👤 *Paciente:* ${name}\n🩺 *Servicio:* ${service}\n📅 *Fecha:* ${fechaLegible}`
    );
    return;
  }
});

client.initialize();
