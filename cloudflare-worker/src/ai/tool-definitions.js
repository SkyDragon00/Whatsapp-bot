const emptyParameters = {
	type: 'object',
	properties: {},
	additionalProperties: false,
};

export const TOOL_DECLARATIONS = [
	{
		name: 'register_business_from_onboarding',
		description: 'Crea el negocio y su usuario administrador únicamente después de que el usuario confirme explícitamente que el resumen final es correcto.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				business_name: { type: 'string' },
				username: { type: 'string' },
				password: { type: 'string' },
				communication_style: { type: 'string', enum: ['formal', 'semiformal', 'friend'] },
				address: { type: 'string' },
				arrival_instructions: { type: 'string' },
				cancellation_policy: { type: 'string' },
				general_notes: { type: 'string' },
				payment_methods: { type: 'array', items: { type: 'string' } },
			},
			required: ['business_name', 'username', 'password', 'communication_style'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_business_settings',
		description: 'Obtiene horarios, zona horaria, reglas de reserva y preferencias reales del negocio, incluidos contacto, ubicación, pagos y políticas cuando están configurados.',
		parametersJsonSchema: emptyParameters,
	},
	{
		name: 'set_communication_style',
		description: 'Cambia y guarda la personalidad del bot. Úsala cuando el dueño pida hablar en modo formal, semiformal o amigo. Solo está disponible en modo dueño.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				style: {
					type: 'string',
					enum: ['formal', 'semiformal', 'friend'],
					description: 'Personalidad solicitada: formal, semiformal o friend para modo amigo.',
				},
			},
			required: ['style'],
			additionalProperties: false,
		},
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
		name: 'find_customer_appointments',
		description: 'Busca las citas de un cliente por nombre para que el dueño identifique el servicio específico al que corresponde un pago.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				customer_name: { type: 'string', description: 'Nombre completo o parcial del cliente.' },
			},
			required: ['customer_name'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_outstanding_balances',
		description: 'Consulta saldos pendientes reales. Sin nombre devuelve todas las personas que deben; con customer_name devuelve la deuda de ese cliente.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				customer_name: { type: 'string', description: 'Nombre completo o parcial opcional del cliente.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'get_expense_summary',
		description: 'Consulta cuánto se gastó usando filtros opcionales de fechas, categoría o texto. Solo está disponible en modo dueño.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				date_from: { type: 'string', description: 'Fecha inicial inclusiva YYYY-MM-DD.' },
				date_to: { type: 'string', description: 'Fecha final inclusiva YYYY-MM-DD.' },
				category: { type: 'string', description: 'Categoría registrada, por ejemplo Alimentación, Transporte o Marketing.' },
				search: { type: 'string', description: 'Texto opcional a buscar en categoría, descripción, proveedor o notas.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'register_payment',
		description: 'Registra un pago para una cita y servicio específicos. Solo está autorizada en modo dueño.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				appointment_id: { type: 'integer', description: 'ID de la cita elegida mediante find_customer_appointments.' },
				payment_date: { type: 'string', description: 'Fecha local del pago en formato YYYY-MM-DD.' },
				amount: { type: 'number', description: 'Monto pagado en la moneda del negocio, con máximo dos decimales.' },
				payment_method: { type: 'string', description: 'Método de pago, por ejemplo efectivo o transferencia.' },
				bank: {
					type: 'string',
					enum: ['Austro', 'Bolivariano', 'Guayaquil', 'Internacional', 'Pacífico', 'Pichincha', 'Produbanco'],
					description: 'Banco obligatorio cuando payment_method es Transferencia.',
				},
				billing_type: { type: 'string', enum: ['consumer_final', 'customer_data'], description: 'Tipo de facturación.' },
				cedula_ruc: { type: 'string', description: 'Cédula o RUC, obligatorio al facturar con datos.' },
				address: { type: 'string', description: 'Dirección, obligatoria al facturar con datos.' },
				phone: { type: 'string', description: 'Teléfono, obligatorio al facturar con datos.' },
				notes: { type: 'string', description: 'Detalle o concepto opcional del pago.' },
			},
			required: ['appointment_id', 'payment_date', 'amount', 'payment_method', 'billing_type'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_financial_summary',
		description: 'Compara ingresos cobrados, gastos y resultado neto, y resume citas pagadas, parciales, sin pagar y por cobrar para un período. Solo disponible en modo dueño.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				date_from: { type: 'string', description: 'Fecha inicial inclusiva YYYY-MM-DD.' },
				date_to: { type: 'string', description: 'Fecha final inclusiva YYYY-MM-DD.' },
			},
			additionalProperties: false,
		},
	},
];

export const ALLOWED_TOOL_NAMES = new Set(TOOL_DECLARATIONS.map((tool) => tool.name));

export function toolDeclarationsForMode(aiMode, onboardingEnabled = false) {
	if (onboardingEnabled) return TOOL_DECLARATIONS.filter((tool) => tool.name === 'register_business_from_onboarding');
	const normalTools = TOOL_DECLARATIONS.filter((tool) => tool.name !== 'register_business_from_onboarding');
	return aiMode === 'owner'
		? normalTools
		: normalTools.filter((tool) => ![
			'set_communication_style',
			'find_customer_appointments',
			'get_outstanding_balances',
			'get_expense_summary',
			'get_financial_summary',
			'register_payment',
		].includes(tool.name));
}
