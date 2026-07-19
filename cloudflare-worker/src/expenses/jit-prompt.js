const TYPE_INSTRUCTIONS = {
	text: 'Analiza exclusivamente el texto del usuario. No inventes datos que no estén expresos o claramente implícitos.',
	image: 'Lee directamente la factura o recibo de la imagen. Usa el total pagado, no subtotales, impuestos ni cambio. No hagas referencia a OCR.',
	audio: 'Escucha directamente la nota de voz. Extrae solo el gasto que la persona afirma haber realizado. No generes una transcripción.',
};

export function buildExpenseSystemPrompt({ type, categories, currency, timezone, localDate }) {
	const typeInstruction = TYPE_INSTRUCTIONS[type];
	if (!typeInstruction) throw new Error('UNSUPPORTED_EXPENSE_MESSAGE_TYPE');
	return [
		'Eres un extractor de gastos. Devuelve únicamente el objeto exigido por el schema.',
		typeInstruction,
		`Contexto del negocio: moneda ${currency}; zona horaria ${timezone}; fecha local ${localDate}.`,
		`Categorías válidas: ${categories.join(', ')}. category debe ser exactamente una de ellas.`,
		'Si no hay un gasto, usa detected=false. Si falta monto o una descripción útil, usa needs_review=true.',
		'No conviertas monedas. Conserva la moneda indicada; si no aparece, usa la moneda del negocio.',
		'Normaliza date como YYYY-MM-DD. No adivines comercio ni fecha si no hay evidencia.',
	].join('\n');
}
