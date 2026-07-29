import { ValidationError } from './errors.js';
import { requireString } from './validation.js';

export const TRANSFER_BANKS = Object.freeze([
	'Austro',
	'Bolivariano',
	'Guayaquil',
	'Internacional',
	'Pacífico',
	'Pichincha',
	'Produbanco',
]);

export function isTransfer(paymentMethod) {
	return typeof paymentMethod === 'string'
		&& paymentMethod.trim().toLocaleLowerCase('es') === 'transferencia';
}

export function requireBankForPayment(paymentMethod, value) {
	if (!isTransfer(paymentMethod)) return null;
	const bank = requireString(value, 'El banco', { max: 40 });
	if (!TRANSFER_BANKS.includes(bank)) {
		throw new ValidationError('Selecciona un banco válido para la transferencia.');
	}
	return bank;
}
