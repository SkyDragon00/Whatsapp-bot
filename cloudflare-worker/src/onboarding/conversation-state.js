function cleanValue(value) {
	return String(value ?? '').trim().replace(/[.!]+$/, '').trim().slice(0, 120) || null;
}

function communicationStyle(value) {
	const normalized = String(value ?? '').trim().toLocaleLowerCase('es');
	if (/\bsemiformal\b/.test(normalized)) return 'semiformal';
	if (/\bformal\b/.test(normalized)) return 'formal';
	if (/\b(amigo|amiga|friend)\b/.test(normalized)) return 'friend';
	return null;
}

function explicitValues(text) {
	const value = String(text ?? '').trim();
	const clarified = /(?:(?:no)[,.\s]*)*(.+?)\s+es\s+(?:el\s+)?nombre\s+de\s+mi\s+(?:negocio|empresa)\s+y\s+(?:el\s+)?(?:de\s+)?usuario\s+es\s+([a-zA-Z0-9._-]+)/i.exec(value);
	if (clarified) return { businessName: cleanValue(clarified[1]), username: cleanValue(clarified[2]) };
	const combined = /(?:negocio|empresa)\s+(?:es|se llama)\s+(.+?)\s+y\s+(?:el\s+)?(?:nombre\s+de\s+)?usuario\s+(?:es|ser[aá])\s+([a-zA-Z0-9._-]+)/i.exec(value);
	if (combined) return { businessName: cleanValue(combined[1]), username: cleanValue(combined[2]) };
	const business = /(?:mi\s+)?(?:negocio|empresa)\s+(?:es|se llama)\s+(.+?)(?:[,.]|$)/i.exec(value);
	const username = /(?:mi\s+)?(?:nombre\s+de\s+)?usuario\s+(?:es|ser[aá])\s+([a-zA-Z0-9._-]+)/i.exec(value);
	return {
		...(business ? { businessName: cleanValue(business[1]) } : {}),
		...(username ? { username: cleanValue(username[1]) } : {}),
	};
}

function requestedField(modelText) {
	const normalized = String(modelText ?? '').toLocaleLowerCase('es');
	if (/estilo\s+de\s+comunicaci[oó]n|formal.*semiformal.*amigo/.test(normalized)) return 'communicationStyle';
	if (/nombre\s+de\s+usuario|usuario\s+para\s+el\s+administrador|usuario\s+administrador/.test(normalized)) return 'username';
	if (/nombre\s+(?:de\s+tu|del)\s+(?:negocio|empresa)|c[oó]mo\s+se\s+llama\s+(?:tu|el)\s+(?:negocio|empresa)/.test(normalized)) return 'businessName';
	return null;
}

export function deriveOnboardingIdentity(history = [], userMessage = '') {
	const state = {};
	let pendingField = null;
	for (const message of [...history, { role: 'user', text: userMessage }]) {
		if (message.role === 'model') {
			pendingField = requestedField(message.text);
			continue;
		}
		if (message.role !== 'user') continue;
		const corrections = explicitValues(message.text);
		if (corrections.businessName) state.businessName = corrections.businessName;
		if (corrections.username) state.username = corrections.username;
		const correctedStyle = /estilo|comunicaci[oó]n/i.test(message.text) ? communicationStyle(message.text) : null;
		if (correctedStyle) state.communicationStyle = correctedStyle;
		if (!corrections.businessName && !corrections.username && pendingField) {
			const fieldValue = pendingField === 'communicationStyle'
				? communicationStyle(message.text)
				: cleanValue(message.text);
			if (fieldValue) state[pendingField] = fieldValue;
		}
		pendingField = null;
	}
	return state;
}
