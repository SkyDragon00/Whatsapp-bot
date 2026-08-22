export const DEFAULT_BUSINESS_TIMEZONE = 'America/Guayaquil';
export const ACTIVE_APPOINTMENT_STATUS = 'confirmed';
export const DEFAULT_SLOT_INTERVAL_MINUTES = 15;
export const DEFAULT_APPOINTMENT_DURATION_MINUTES = 60;
export const DEFAULT_MINIMUM_BOOKING_NOTICE_MINUTES = 0;
export const DEFAULT_MAXIMUM_ADVANCE_BOOKING_DAYS = 31;
export const MAX_AVAILABILITY_RANGE_DAYS = 31;
export const DEFAULT_MAX_AVAILABLE_SLOTS = 12;
export const GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_MAX_TOOL_ITERATIONS = 5;
export const GEMINI_MAX_TOOL_CALLS = 8;
export const GEMINI_TIMEOUT_MS = 15_000;
export const GEMINI_EXPENSE_TIMEOUT_MS = 25_000;
export const TELEGRAM_TIMEOUT_MS = 8_000;
export const MAX_TELEGRAM_MESSAGE_LENGTH = 4_000;
export const WHATSAPP_TIMEOUT_MS = 8_000;
export const MAX_WHATSAPP_MESSAGE_LENGTH = 4_096;
export const MAX_INCOMING_MESSAGE_LENGTH = 2_000;
export const CONVERSATION_TTL_SECONDS = 6 * 60 * 60;
export const CONVERSATION_MAX_MESSAGES = 16;
export const CONVERSATION_MAX_MESSAGE_LENGTH = 1_500;
export const IDEMPOTENCY_PROCESSING_TTL_SECONDS = 2 * 60;
export const IDEMPOTENCY_DONE_TTL_SECONDS = 24 * 60 * 60;

export const DEFAULT_BUSINESS_HOURS = [
	{ day: 0, enabled: false, start: '09:00', end: '17:00' },
	{ day: 1, enabled: true, start: '09:00', end: '17:00' },
	{ day: 2, enabled: true, start: '09:00', end: '17:00' },
	{ day: 3, enabled: true, start: '09:00', end: '17:00' },
	{ day: 4, enabled: true, start: '09:00', end: '17:00' },
	{ day: 5, enabled: true, start: '09:00', end: '17:00' },
	{ day: 6, enabled: false, start: '09:00', end: '17:00' },
];

export const DEFAULT_BUSINESS_SETTINGS = {
	aiMode: 'owner',
	onboardingEnabled: false,
	firstStepsEnabled: false,
	appointmentDurationMinutes: DEFAULT_APPOINTMENT_DURATION_MINUTES,
	businessTimezone: DEFAULT_BUSINESS_TIMEZONE,
	slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
	minimumBookingNoticeMinutes: DEFAULT_MINIMUM_BOOKING_NOTICE_MINUTES,
	maximumAdvanceBookingDays: DEFAULT_MAXIMUM_ADVANCE_BOOKING_DAYS,
	closedDates: [],
	businessHours: DEFAULT_BUSINESS_HOURS,
	businessProfile: {
		businessName: null,
		communicationStyle: 'semiformal',
		preferredTone: null,
		greeting: null,
		address: null,
		contactPhone: null,
		cancellationPolicy: null,
		arrivalInstructions: null,
		generalNotes: null,
		acceptedPaymentMethods: [],
	},
};
