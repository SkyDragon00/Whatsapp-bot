const emptyParameters = {
	type: 'object',
	properties: {},
	additionalProperties: false,
};

export const TOOL_DECLARATIONS = [
	{
		name: 'get_business_settings',
		description: 'Obtiene horarios, zona horaria, reglas de reserva y preferencias reales del negocio, incluidos contacto, ubicación, pagos y políticas cuando están configurados.',
		parametersJsonSchema: emptyParameters,
	},
	{
		name: 'list_services',
		description: 'Lista los servicios habilitados reales con identificador, duración, descripción y precio.',
		parametersJsonSchema: emptyParameters,
	},
	{
		name: 'find_available_slots',
		description: 'Busca espacios disponibles reales para un servicio en una fecha o rango local del negocio. Si el cliente pide una hora concreta, usa time para comprobar exactamente esa hora.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				service_id: { type: 'integer', description: 'ID del servicio, si ya se conoce.' },
				service_name: { type: 'string', description: 'Nombre del servicio, si todavía no se conoce su ID.' },
				date: { type: 'string', description: 'Fecha local única en formato YYYY-MM-DD.' },
				date_from: { type: 'string', description: 'Primera fecha local inclusiva en formato YYYY-MM-DD.' },
				date_to: { type: 'string', description: 'Última fecha local inclusiva en formato YYYY-MM-DD.' },
				period: { type: 'string', enum: ['mañana', 'tarde', 'noche'] },
				time: { type: 'string', description: 'Hora local exacta solicitada en formato HH:MM. No combinar con period.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'create_appointment',
		description: 'Crea una cita después de que el cliente haya elegido y confirmado un espacio devuelto por find_available_slots.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				customer_name: { type: 'string', description: 'Nombre completo del cliente.' },
				service_id: { type: 'integer', description: 'ID real del servicio.' },
				start_datetime: {
					type: 'string',
					description: 'Valor start_at RFC 3339 exacto devuelto por find_available_slots.',
				},
				phone: { type: 'string', description: 'Teléfono opcional del cliente.' },
			},
			required: ['customer_name', 'service_id', 'start_datetime'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_customer_appointments',
		description: 'Consulta las citas activas asociadas al usuario actual de Telegram.',
		parametersJsonSchema: emptyParameters,
	},
	{
		name: 'cancel_appointment',
		description: 'Cancela una cita del usuario actual después de que este indique cuál desea cancelar.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				appointment_id: { type: 'integer', description: 'ID de la cita obtenido con get_customer_appointments.' },
			},
			required: ['appointment_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'register_payment',
		description: 'Registra un pago recibido de un cliente. Esta operación solo está autorizada cuando la IA está en modo dueño.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				payment_date: { type: 'string', description: 'Fecha local del pago en formato YYYY-MM-DD.' },
				customer_name: { type: 'string', description: 'Nombre del cliente que realizó el pago.' },
				amount: { type: 'number', description: 'Monto pagado en la moneda del negocio, con máximo dos decimales.' },
				payment_method: { type: 'string', description: 'Método de pago, por ejemplo efectivo o transferencia.' },
				notes: { type: 'string', description: 'Detalle o concepto opcional del pago.' },
			},
			required: ['payment_date', 'customer_name', 'amount', 'payment_method'],
			additionalProperties: false,
		},
	},
];

export const ALLOWED_TOOL_NAMES = new Set(TOOL_DECLARATIONS.map((tool) => tool.name));

export function toolDeclarationsForMode(aiMode) {
	return aiMode === 'owner'
		? TOOL_DECLARATIONS
		: TOOL_DECLARATIONS.filter((tool) => tool.name !== 'register_payment');
}
