function cleanValue(value, maximum = 120) {
	return String(value ?? '').trim().replace(/[.!]+$/, '').trim().slice(0, maximum) || null;
}

function explicitValues(text) {
	const value = String(text ?? '').trim();
	const clarified = /(?:(?:no)[,.\s]*)*(.+?)\s+es\s+(?:el\s+)?nombre\s+de\s+mi\s+(?:negocio|empresa)\s+y\s+(?:el\s+)?(?:de\s+)?usuario\s+es\s+([a-zA-Z0-9._-]+)/i.exec(value);
	if (clarified) return { businessName: cleanValue(clarified[1]), username: cleanValue(clarified[2]) };
	const combined = /(?:negocio|empresa)\s+(?:es|se llama)\s+(.+?)\s+y\s+(?:el\s+)?(?:nombre\s+de\s+)?usuario\s+(?:es|ser[aá])\s+([a-zA-Z0-9._-]+)/i.exec(value);
	if (combined) return { businessName: cleanValue(combined[1]), username: cleanValue(combined[2]) };
	const business = /(?:mi\s+)?(?:negocio|empresa)\s+(?:es|se llama)\s+(.+?)(?:[,.]|$)/i.exec(value);
	const username = /(?:mi\s+)?(?:nombre\s+de\s+)?usuario\s+(?:es|ser[aá])\s+([a-zA-Z0-9._-]+)/i.exec(value);
	const address = /(?:mi\s+)?(?:ubicaci[oó]n|direcci[oó]n)\s*(?::|es|queda\s+en|est[aá]\s+en)?\s+(.+?)(?:\n|$)/i.exec(value);
	return {
		...(business ? { businessName: cleanValue(business[1]) } : {}),
		...(username ? { username: cleanValue(username[1]) } : {}),
		...(address ? { address: cleanValue(address[1], 300) } : {}),
	};
}

function requestedField(modelText) {
	const normalized = String(modelText ?? '').toLocaleLowerCase('es');
	// Un resumen puede mencionar todos los campos, pero la respuesta siguiente es
	// una confirmacion y nunca debe reemplazar ninguno de sus valores.
	if (/(?:es|est[aá])\s+correct[ao]|todo\s+(?:est[aá]\s+)?correcto|confirm(?:a|ar|as|e)|proceder\s+con\s+el\s+registro/.test(normalized)) return null;
	if (/ubicaci[oó]n|direcci[oó]n|d[oó]nde\s+(?:est[aá]n|se\s+ubican|queda)/.test(normalized)) return 'address';
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
		if (corrections.address) state.address = corrections.address;
		// El onboarding usa siempre el estilo semiformal.
		if (!corrections.businessName && !corrections.username && !corrections.address && pendingField) {
			const fieldValue = cleanValue(message.text, pendingField === 'address' ? 300 : 120);
			if (fieldValue) state[pendingField] = fieldValue;
		}
		pendingField = null;
	}
	return state;
}
