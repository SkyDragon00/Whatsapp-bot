import { getZonedParts } from '../domain/datetime.js';

export const DEFAULT_EXPENSE_CATEGORIES = [
	'Insumos', 'Servicios', 'Transporte', 'Alimentación', 'Marketing', 'Mantenimiento', 'Otros',
];

function parseCategories(value) {
	if (typeof value !== 'string') return DEFAULT_EXPENSE_CATEGORIES;
	const categories = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
	return categories.length > 0 ? categories.slice(0, 30) : DEFAULT_EXPENSE_CATEGORIES;
}

export function getExpenseBusinessContext(env, settings, now = new Date()) {
	const currency = /^[A-Z]{3}$/.test(env.BUSINESS_CURRENCY ?? '') ? env.BUSINESS_CURRENCY : 'USD';
	return {
		categories: parseCategories(env.EXPENSE_CATEGORIES),
		currency,
		timezone: settings.businessTimezone,
		localDate: getZonedParts(now, settings.businessTimezone).date,
	};
}
