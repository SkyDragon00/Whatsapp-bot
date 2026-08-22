const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function hasDayPeriod(text) {
	return /\b(?:a\.?\s*m\.?|p\.?\s*m\.?|de\s+la\s+(?:mañana|tarde|noche|madrugada)|al\s+mediod[ií]a)\b/i.test(text);
}

export function findAmbiguousAppointmentHour(text) {
	const value = String(text ?? '').trim();
	if (!value || hasDayPeriod(value)) return null;

	const match = /\b(?:a|para)\s+la(?:s)?\s+(1[0-2]|[1-9])(?::([0-5]\d))?\b/i.exec(value)
		?? /^(1[0-2]|[1-9])(?::([0-5]\d))?(?:\s*(?:en\s+punto))?[.!?]?$/i.exec(value);
	if (!match) return null;

	return `${match[1].padStart(2, '0')}:${match[2] ?? '00'}`;
}

export function formatBusinessHoursForChat(businessHours = []) {
	return businessHours
		.map((entry) => `${DAY_NAMES[entry.day] ?? `día ${entry.day}`} ${entry.enabled ? `de ${entry.start} a ${entry.end}` : 'cerrado'}`)
		.join('; ');
}

export function buildAmbiguousHourReply(text, businessHours) {
	const time = findAmbiguousAppointmentHour(text);
	if (!time) return null;
	const hour = Number(time.slice(0, 2));
	const minutes = time.slice(3);
	const displayTime = `${hour}:${minutes}`;
	return `¿Te refieres a las ${displayTime} AM o ${displayTime} PM? El horario de atención del local es: ${formatBusinessHoursForChat(businessHours)}.`;
}
