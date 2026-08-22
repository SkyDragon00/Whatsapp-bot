function cleanValue(value) {
	return String(value ?? '')
		.replace(/\*+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[.,;:!?]+$/, '')
		.slice(0, 160);
}

function capture(text, pattern) {
	const match = pattern.exec(text);
	return match ? cleanValue(match[1]) : null;
}

function applyMessage(state, message, previousMessage = null) {
	const text = String(message?.text ?? '');
	if (!text) return;

	const labelledCustomer = capture(text, /(?:^|\n)\s*(?:[-*]\s*)?\**cliente\**\s*:\**\s*([^\n]+)/i);
	const namedCustomer = message.role === 'user'
		? capture(text, /\b(?:a\s+nombre\s+de|nombre\s*:|el\s+cliente\s+es)\s+([^,;\n]+)/i)
		: null;
	const directCustomer = message.role === 'user'
		&& /(?:qu[eé]\s+nombre|a\s+nombre\s+de\s+qui[eé]n|nombre\s+del\s+cliente)/i.test(previousMessage?.text ?? '')
		&& /^[\p{L}][\p{L}\s.'-]{1,119}$/u.test(text.trim())
		? cleanValue(text)
		: null;
	if (labelledCustomer || namedCustomer || directCustomer) {
		state.customerName = labelledCustomer || namedCustomer || directCustomer;
	}

	const service = capture(text, /(?:^|\n)\s*(?:[-*]\s*)?\**servicio\**\s*:\**\s*([^\n]+)/i)
		?? capture(text, /disponibilidad\s+para\s+\*+([^*\n]+)\*+/i);
	if (service) state.serviceName = service;

	const price = capture(text, /(?:^|\n)\s*(?:[-*]\s*)?\**precio\**\s*:\**\s*([^\n]+)/i);
	if (price) state.price = price;

	const date = capture(text, /(?:^|\n)\s*(?:[-*]\s*)?\**fecha\**\s*:\**\s*([^\n]+)/i);
	if (date) state.date = date;

	const time = capture(text, /(?:^|\n)\s*(?:[-*]\s*)?\**hora\**\s*:\**\s*((?:[01]\d|2[0-3]):[0-5]\d)/i);
	if (time) state.time = time;
}

export function deriveAppointmentState(history = [], userMessage = '', existingState = {}) {
	const state = { ...existingState };
	const messages = [
		...history,
		...(userMessage ? [{ role: 'user', text: userMessage }] : []),
	];
	for (let index = 0; index < messages.length; index += 1) {
		applyMessage(state, messages[index], messages[index - 1]);
	}
	return state;
}
