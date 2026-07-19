export function buildExpenseResponseSchema(categories) {
	return {
		type: 'object',
		properties: {
			detected: { type: 'boolean', description: 'True solo si el contenido describe un gasto.' },
			amount: { type: 'number', nullable: true, minimum: 0, description: 'Monto total del gasto.' },
			currency: { type: 'string', description: 'Código ISO 4217 de la moneda.' },
			description: { type: 'string', description: 'Concepto breve y específico del gasto.' },
			category: { type: 'string', enum: categories, description: 'Una categoría válida del negocio.' },
			merchant: { type: 'string', nullable: true, description: 'Comercio o proveedor, si está disponible.' },
			date: { type: 'string', nullable: true, format: 'date', description: 'Fecha YYYY-MM-DD, si está disponible.' },
			confidence: { type: 'number', minimum: 0, maximum: 1 },
			needs_review: { type: 'boolean', description: 'True si falta monto o descripción.' },
		},
		required: [
			'detected', 'amount', 'currency', 'description', 'category', 'merchant', 'date',
			'confidence', 'needs_review',
		],
	};
}
