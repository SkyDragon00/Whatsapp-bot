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
	let onlyCompanyId = null;
	for (const row of result.results) {
		try {
			const match = /^company:(\d+):schedule$/.exec(row.key);
			if (!match) continue;
			onlyCompanyId = Number(match[1]);
			if (JSON.parse(row.value)?.onboardingEnabled === true) {
				return getBusinessSettings(db, { companyId: onlyCompanyId });
			}
		} catch {
			// Ignora configuraciones heredadas o dañadas y conserva el fallback global.
		}
	}
	if (result.results.length === 1 && onlyCompanyId !== null) {
		return getBusinessSettings(db, { companyId: onlyCompanyId });
	}
	return getBusinessSettings(db);
}

export async function updateBotCommunicationStyle(db, communicationStyle) {
	const result = await db.prepare(
		"SELECT key, value FROM settings WHERE key LIKE 'company:%:schedule' ORDER BY key",
	).all();
	let onlyCompanyId = null;
	for (const row of result.results) {
		try {
			const match = /^company:(\d+):schedule$/.exec(row.key);
			if (!match) continue;
			const companyId = Number(match[1]);
			onlyCompanyId = companyId;
			if (JSON.parse(row.value)?.onboardingEnabled !== true) continue;
			const settings = await getBusinessSettings(db, { companyId });
			return saveBusinessSettings(db, {
				...settings,
				businessProfile: { ...settings.businessProfile, communicationStyle },
			}, { companyId });
		} catch {
			// Continúa buscando una empresa activa con configuración válida.
		}
	}
	if (result.results.length === 1 && onlyCompanyId !== null) {
		const settings = await getBusinessSettings(db, { companyId: onlyCompanyId });
		return saveBusinessSettings(db, {
			...settings,
			businessProfile: { ...settings.businessProfile, communicationStyle },
		}, { companyId: onlyCompanyId });
	}
	const settings = await getBusinessSettings(db);
	return saveBusinessSettings(db, {
		...settings,
		businessProfile: { ...settings.businessProfile, communicationStyle },
	});
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
