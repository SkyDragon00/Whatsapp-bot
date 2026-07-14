import {
	ACTIVE_APPOINTMENT_STATUS,
	DEFAULT_MAX_AVAILABLE_SLOTS,
	MAX_AVAILABILITY_RANGE_DAYS,
} from '../config/constants.js';
import { ValidationError } from './errors.js';
import {
	addDaysToLocalDate,
	addMinutes,
	getWeekdayForLocalDate,
	getZonedParts,
	minutesToTime,
	parseLocalDate,
	parseTimeToMinutes,
	zonedDateTimeToUtc,
} from './datetime.js';
import { normalizeBusinessSettings } from './validation.js';

const PERIODS = {
	morning: [0, 12 * 60],
	'mañana': [0, 12 * 60],
	afternoon: [12 * 60, 18 * 60],
	tarde: [12 * 60, 18 * 60],
	night: [18 * 60, 24 * 60],
	noche: [18 * 60, 24 * 60],
};

export function intervalsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
	return firstStart < secondEnd && firstEnd > secondStart;
}

export function validateAppointmentWindow({ startAt, endAt, settings, now = new Date() }) {
	const normalizedSettings = normalizeBusinessSettings(settings);
	const start = new Date(startAt);
	const end = new Date(endAt);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
		return { ok: false, reason: 'invalid_interval' };
	}
	if (start <= now) return { ok: false, reason: 'past' };

	const startLocal = getZonedParts(start, normalizedSettings.businessTimezone);
	const endLocal = getZonedParts(end, normalizedSettings.businessTimezone);
	const earliestStart = now.getTime() + normalizedSettings.minimumBookingNoticeMinutes * 60_000;
	if (start.getTime() < earliestStart) return { ok: false, reason: 'minimum_notice' };
	const latestLocalDate = addDaysToLocalDate(
		getZonedParts(now, normalizedSettings.businessTimezone).date,
		normalizedSettings.maximumAdvanceBookingDays,
	);
	if (startLocal.date > latestLocalDate) return { ok: false, reason: 'too_far_in_future' };
	if (startLocal.date !== endLocal.date) return { ok: false, reason: 'crosses_day' };
	if (normalizedSettings.closedDates.includes(startLocal.date)) return { ok: false, reason: 'closed_date' };

	const dayHours = normalizedSettings.businessHours.find((entry) => entry.day === startLocal.weekday);
	if (!dayHours?.enabled) return { ok: false, reason: 'closed_day', dayHours };

	const opening = parseTimeToMinutes(dayHours.start);
	const closing = parseTimeToMinutes(dayHours.end);
	const appointmentStart = startLocal.hour * 60 + startLocal.minute;
	const appointmentEnd = endLocal.hour * 60 + endLocal.minute;
	if (startLocal.second !== 0 || start.getUTCMilliseconds() !== 0) {
		return { ok: false, reason: 'unaligned_time', dayHours };
	}
	if ((appointmentStart - opening) % normalizedSettings.slotIntervalMinutes !== 0) {
		return { ok: false, reason: 'unaligned_slot', dayHours };
	}
	if (appointmentStart < opening || appointmentEnd > closing) {
		return { ok: false, reason: 'outside_hours', dayHours };
	}
	return { ok: true, dayHours };
}

function normalizePeriod(period) {
	if (period === undefined || period === null || period === '') return null;
	if (typeof period !== 'string' || !PERIODS[period.toLowerCase()]) {
		throw new ValidationError('El periodo debe ser mañana, tarde o noche.');
	}
	return PERIODS[period.toLowerCase()];
}

function activeIntervals(appointments) {
	return appointments
		.filter((appointment) => appointment.status === ACTIVE_APPOINTMENT_STATUS)
		.map((appointment) => ({
			start: new Date(appointment.start_at).getTime(),
			end: new Date(appointment.end_at).getTime(),
		}))
		.filter((appointment) => Number.isFinite(appointment.start) && Number.isFinite(appointment.end));
}

export function findAvailableSlots({
	dateFrom,
	dateTo = dateFrom,
	period,
	serviceDurationMinutes,
	settings,
	appointments = [],
	now = new Date(),
	maxSlots = DEFAULT_MAX_AVAILABLE_SLOTS,
}) {
	parseLocalDate(dateFrom);
	parseLocalDate(dateTo);
	const duration = Number(serviceDurationMinutes);
	if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
		throw new ValidationError('La duración del servicio no es válida.');
	}
	if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 50) {
		throw new ValidationError('El límite de espacios no es válido.');
	}

	const normalizedSettings = normalizeBusinessSettings(settings);
	const periodRange = normalizePeriod(period);
	const days = [];
	let cursor = dateFrom;
	for (let index = 0; index < MAX_AVAILABILITY_RANGE_DAYS; index += 1) {
		if (cursor > dateTo) break;
		days.push(cursor);
		cursor = addDaysToLocalDate(cursor, 1);
	}
	if (days.length === 0 || days.at(-1) !== dateTo) {
		throw new ValidationError(`El rango debe estar ordenado y no superar ${MAX_AVAILABILITY_RANGE_DAYS} días.`);
	}

	const occupied = activeIntervals(appointments);
	const slots = [];
	const earliestStartMs = now.getTime() + normalizedSettings.minimumBookingNoticeMinutes * 60_000;
	const latestLocalDate = addDaysToLocalDate(
		getZonedParts(now, normalizedSettings.businessTimezone).date,
		normalizedSettings.maximumAdvanceBookingDays,
	);
	for (const localDate of days) {
		if (localDate > latestLocalDate) continue;
		if (normalizedSettings.closedDates.includes(localDate)) continue;
		const weekday = getWeekdayForLocalDate(localDate);
		const dayHours = normalizedSettings.businessHours.find((entry) => entry.day === weekday);
		if (!dayHours?.enabled) continue;

		const opening = parseTimeToMinutes(dayHours.start);
		const closing = parseTimeToMinutes(dayHours.end);
		for (let minute = opening; minute + duration <= closing; minute += normalizedSettings.slotIntervalMinutes) {
			if (periodRange && (minute < periodRange[0] || minute >= periodRange[1])) continue;
			const localTime = minutesToTime(minute);
			const startAt = zonedDateTimeToUtc(localDate, localTime, normalizedSettings.businessTimezone);
			const endAt = addMinutes(startAt, duration);
			const startMs = new Date(startAt).getTime();
			const endMs = new Date(endAt).getTime();
			if (startMs <= now.getTime() || startMs < earliestStartMs) continue;
			if (occupied.some((entry) => intervalsOverlap(startMs, endMs, entry.start, entry.end))) continue;

			slots.push({
				start_at: startAt,
				end_at: endAt,
				local_date: localDate,
				local_time: localTime,
				timezone: normalizedSettings.businessTimezone,
			});
			if (slots.length >= maxSlots) return slots;
		}
	}
	return slots;
}
