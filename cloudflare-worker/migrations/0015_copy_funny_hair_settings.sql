INSERT OR IGNORE INTO settings (key, value)
SELECT
	'company:' || companies.id || ':' || settings.key,
	settings.value
FROM settings
CROSS JOIN companies
WHERE settings.key IN ('schedule', 'business_profile')
  AND companies.name = 'Funny Hair' COLLATE NOCASE;
