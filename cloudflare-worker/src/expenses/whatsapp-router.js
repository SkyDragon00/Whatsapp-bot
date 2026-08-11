export function routeWhatsAppMessage(message) {
	if (message?.type === 'text' && typeof message.text?.body === 'string') {
		return { type: 'text', text: message.text.body.trim() };
	}
	if (message?.type === 'image' && message.image?.id) {
		return {
			type: 'image', fileId: message.image.id, mediaId: message.image.id,
			mimeType: message.image.mime_type || 'image/jpeg',
		};
	}
	if (message?.type === 'audio' && message.audio?.id) {
		return {
			type: 'audio', fileId: message.audio.id, mediaId: message.audio.id,
			mimeType: message.audio.mime_type || 'audio/ogg',
		};
	}
	return { type: 'unsupported' };
}
