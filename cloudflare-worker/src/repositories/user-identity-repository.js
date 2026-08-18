export function normalizePhoneE164(value) {
	const raw = String(value ?? '').trim();
	if (!raw) return null;
	const digits = raw.replace(/\D/g, '');
	if (digits.length < 8 || digits.length > 15) return null;
	return `+${digits}`;
}

export async function findUserByPhone(db, phone) {
	const phoneE164 = normalizePhoneE164(phone);
	if (!phoneE164) return null;
	return db.prepare(
		`SELECT users.id, users.username, users.role, users.company_id, users.phone_e164,
		        companies.name AS company_name
		 FROM users
		 JOIN companies ON companies.id = users.company_id
		 WHERE users.phone_e164 = ?1 AND companies.status = 'active'
		 LIMIT 1`,
	).bind(phoneE164).first();
}
