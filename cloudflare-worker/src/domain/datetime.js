import { ValidationError } from './errors.js';

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidIanaTimeZone(timeZone) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
		return true;
	} catch {
		return false;
	}
}

export function parseTimeToMinutes(value) {
	if (typeof value !== 'string') return null;
	const match = TIME_PATTERN.exec(value);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

export function minutesToTime(totalMinutes) {
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseLocalDate(value) {
	if (typeof value !== 'string') throw new ValidationError('La fecha debe usar el formato YYYY-MM-DD.');
	const match = LOCAL_DATE_PATTERN.exec(value);
	if (!match) throw new ValidationError('La fecha debe usar el formato YYYY-MM-DD.');
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const check = new Date(Date.UTC(year, month - 1, day));
	if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
		throw new ValidationError('La fecha indicada no existe.');
	}
	return { date: value, year, month, day };
}

export function addDaysToLocalDate(value, days) {
	const parsed = parseLocalDate(value);
	const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function getWeekdayForLocalDate(value) {
	const parsed = parseLocalDate(value);
	return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

export function toUtcIso(value, label = 'La fecha') {
	if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
		throw new ValidationError(`${label} debe ser una fecha RFC 3339 con zona horaria.`);
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} no es válida.`);
	return date.toISOString();
}

export function addMinutes(isoValue, minutes) {
	const date = new Date(isoValue);
	return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export function getZonedParts(value, timeZone) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new ValidationError('No se pudo convertir la fecha.');
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		weekday: 'short',
		hourCycle: 'h23',
	});
	const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
		weekday: WEEKDAYS[parts.weekday],
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}`,
	};
}

export function zonedDateTimeToUtc(localDate, localTime, timeZone) {
	const parsedDate = parseLocalDate(localDate);
	const totalMinutes = parseTimeToMinutes(localTime);
	if (totalMinutes === null) throw new ValidationError('La hora debe usar el formato HH:MM.');
	if (!isValidIanaTimeZone(timeZone)) throw new ValidationError('La zona horaria no es válida.');

	const targetHour = Math.floor(totalMinutes / 60);
	const targetMinute = totalMinutes % 60;
	const targetAsUtc = Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day, targetHour, targetMinute, 0, 0);
	let candidate = targetAsUtc;

	for (let index = 0; index < 4; index += 1) {
		const parts = getZonedParts(new Date(candidate), timeZone);
		const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
		const difference = targetAsUtc - representedAsUtc;
		candidate += difference;
		if (difference === 0) break;
	}

	const verified = getZonedParts(new Date(candidate), timeZone);
	if (verified.date !== localDate || verified.hour !== targetHour || verified.minute !== targetMinute) {
		throw new ValidationError('La hora local no existe en la zona horaria configurada.');
	}
	return new Date(candidate).toISOString();
}
