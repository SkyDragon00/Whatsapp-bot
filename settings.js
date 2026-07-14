const db = require('./db');

const DEFAULT_SETTINGS = {
  appointmentDurationMinutes: 60,
  businessHours: [
    { day: 0, enabled: false, start: '09:00', end: '17:00' },
    { day: 1, enabled: true, start: '09:00', end: '17:00' },
    { day: 2, enabled: true, start: '09:00', end: '17:00' },
    { day: 3, enabled: true, start: '09:00', end: '17:00' },
    { day: 4, enabled: true, start: '09:00', end: '17:00' },
    { day: 5, enabled: true, start: '09:00', end: '17:00' },
    { day: 6, enabled: false, start: '09:00', end: '17:00' },
  ],
};

const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
];

function cloneDefaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function parseTimeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function normalizeSettings(input) {
  const duration = Number(input.appointmentDurationMinutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) {
    throw new Error('La duracion debe estar entre 15 y 480 minutos.');
  }

  if (!Array.isArray(input.businessHours) || input.businessHours.length !== 7) {
    throw new Error('Debes configurar los 7 dias de la semana.');
  }

  const hoursByDay = new Map();

  input.businessHours.forEach((entry) => {
    const day = Number(entry.day);
    const start = entry.start;
    const end = entry.end;
    const enabled = Boolean(entry.enabled);
    const startMinutes = parseTimeToMinutes(start);
    const endMinutes = parseTimeToMinutes(end);

    if (!Number.isInteger(day) || day < 0 || day > 6 || hoursByDay.has(day)) {
      throw new Error('Los dias de atencion no son validos.');
    }

    if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
      throw new Error('Cada horario debe tener una hora de inicio menor a la hora de cierre.');
    }

    hoursByDay.set(day, { day, enabled, start, end });
  });

  return {
    appointmentDurationMinutes: duration,
    businessHours: Array.from({ length: 7 }, (_, day) => hoursByDay.get(day)),
  };
}

function getSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('schedule');
  if (!row) return cloneDefaultSettings();

  try {
    return normalizeSettings(JSON.parse(row.value));
  } catch (error) {
    return cloneDefaultSettings();
  }
}

function saveSettings(input) {
  const settings = normalizeSettings(input);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('schedule', JSON.stringify(settings));
  return settings;
}

function isWithinBusinessHours(date, settings = getSettings()) {
  const dayHours = settings.businessHours.find((entry) => entry.day === date.getDay());
  if (!dayHours || !dayHours.enabled) {
    return { ok: false, reason: 'closed', dayHours };
  }

  const startMinutes = parseTimeToMinutes(dayHours.start);
  const endMinutes = parseTimeToMinutes(dayHours.end);
  const appointmentStart = date.getHours() * 60 + date.getMinutes();
  const appointmentEnd = appointmentStart + settings.appointmentDurationMinutes;

  if (appointmentStart < startMinutes || appointmentEnd > endMinutes) {
    return { ok: false, reason: 'outside_hours', dayHours };
  }

  return { ok: true, dayHours };
}

function formatBusinessHoursForDay(dayHours) {
  if (!dayHours || !dayHours.enabled) return 'cerrado';
  return `${dayHours.start} a ${dayHours.end}`;
}

module.exports = {
  DAY_NAMES,
  getSettings,
  saveSettings,
  isWithinBusinessHours,
  formatBusinessHoursForDay,
};
