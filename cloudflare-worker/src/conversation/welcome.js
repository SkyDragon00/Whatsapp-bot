export function buildClientWelcomeMessage(services = []) {
	const names = services.map((service) => String(service?.name ?? '').trim()).filter(Boolean);
	const serviceList = names.length
		? names.map((name) => `- ${name}`).join('\n')
		: '- Por el momento no hay servicios disponibles.';
	return `¡Hola! Puedo ayudarte a agendar una cita para cualquiera de estos servicios:\n${serviceList}\n\n¿Cuál te interesa?`;
}

export function isPaymentRegistrationRequest(text = '') {
	const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
	return /\b(?:registr(?:ar|o|ame)|anot(?:ar|a)|report(?:ar|a)|ingres(?:ar|a)|carg(?:ar|a))\b.{0,50}\b(?:un\s+)?(?:pago|abono)\b/.test(normalized)
		|| /\b(?:pago|abono)\b.{0,50}\b(?:registr(?:ar|o|ame)|anot(?:ar|a)|report(?:ar|a)|ingres(?:ar|a)|carg(?:ar|a))\b/.test(normalized);
}

export function addPaymentMediaReminder(responseText) {
	const response = String(responseText ?? '').trim();
	if (/\bvoz\b/i.test(response) && /\b(?:imagen|foto)\b/i.test(response)) return response;
	return `${response}\n\nRecuerda: también puedes registrar el pago enviándolo por voz o con una imagen.`.trim();
}
