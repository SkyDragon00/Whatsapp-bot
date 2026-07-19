export function routeTelegramMessage(message) {
	if (typeof message.text === 'string') return { type: 'text', text: message.text.trim() };
	if (Array.isArray(message.photo) && message.photo.length > 0) {
		const ordered = [...message.photo].sort((left, right) =>
			Math.max(left.width ?? 0, left.height ?? 0) - Math.max(right.width ?? 0, right.height ?? 0));
		const photo = ordered.filter((item) => Math.max(item.width ?? 0, item.height ?? 0) <= 1280).at(-1)
			?? ordered[0];
		return {
			type: 'image', fileId: photo.file_id, mediaId: photo.file_unique_id ?? photo.file_id,
			mimeType: 'image/jpeg', width: photo.width, height: photo.height,
		};
	}
	const audio = message.voice ?? message.audio;
	if (audio?.file_id) {
		return {
			type: 'audio', fileId: audio.file_id, mediaId: audio.file_unique_id ?? audio.file_id,
			mimeType: audio.mime_type ?? (message.voice ? 'audio/ogg' : 'audio/mpeg'),
		};
	}
	return { type: 'unsupported' };
}

export function isExplicitExpenseText(text) {
	if (typeof text !== 'string') return false;
	const normalized = text.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	return /\b(gasto|gaste|gastamos|compra|compre|compramos|pague|pagamos|costo|factura|recibo)\b/.test(normalized);
}
