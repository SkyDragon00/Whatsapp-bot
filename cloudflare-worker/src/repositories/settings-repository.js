import { DEFAULT_BUSINESS_SETTINGS } from '../config/constants.js';
import { normalizeBusinessSettings, parseStoredBusinessSettings } from '../domain/validation.js';

function settingKey(companyId, key) {
	return companyId == null ? key : `company:${companyId}:${key}`;
}

export async function getBusinessSettings(db, { companyId = null } = {}) {
	const scheduleKey = settingKey(companyId, 'schedule');
	const profileKey = settingKey(companyId, 'business_profile');
	const result = await db
		.prepare('SELECT key, value FROM settings WHERE key IN (?1, ?2)')
		.bind(scheduleKey, profileKey)
		.all();
	const values = new Map(result.results.map((row) => [row.key, row.value]));
	if (!values.has(scheduleKey)) return JSON.parse(JSON.stringify(DEFAULT_BUSINESS_SETTINGS));
	return parseStoredBusinessSettings(values.get(scheduleKey), values.get(profileKey));
}

export async function getBotBusinessSettings(db) {
	const result = await db.prepare(
		"SELECT key, value FROM settings WHERE key LIKE 'company:%:schedule' ORDER BY key",
	).all();
	for (const row of result.results) {
		try {
			if (JSON.parse(row.value)?.onboardingEnabled !== true) continue;
			const match = /^company:(\d+):schedule$/.exec(row.key);
			if (match) return getBusinessSettings(db, { companyId: Number(match[1]) });
		} catch {
			// Ignora configuraciones heredadas o dañadas y conserva el fallback global.
		}
	}
	return getBusinessSettings(db);
}

export async function saveBusinessSettings(db, input, { companyId = null } = {}) {
	const settings = normalizeBusinessSettings(input);
	const { businessProfile, ...schedule } = settings;
	await db.batch([
		db.prepare(
			`INSERT INTO settings (key, value)
			 VALUES (?1, ?2)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
			.bind(settingKey(companyId, 'schedule'), JSON.stringify(schedule)),
		db.prepare(
			`INSERT INTO settings (key, value)
			 VALUES (?1, ?2)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
			.bind(settingKey(companyId, 'business_profile'), JSON.stringify(businessProfile)),
	]);
	return settings;
}
