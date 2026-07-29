import { ValidationError } from '../domain/errors.js';
import { requirePositiveInteger, requireString } from '../domain/validation.js';
import { requireBankForPayment } from '../domain/banking.js';

function requireExpenseDate(value) {
	const normalized = requireString(value, 'La fecha del gasto', { max: 10 });
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
	if (!match) throw new ValidationError('La fecha del gasto debe tener el formato AAAA-MM-DD.');
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
		throw new ValidationError('La fecha del gasto no es válida.');
	}
	return normalized;
}

function validateExpenseInput(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new ValidationError('El gasto debe ser un objeto.');
	}
	const amountCents = Number(input.amount_cents);
	if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 1_000_000_000) {
		throw new ValidationError('El monto del gasto no es válido.');
	}
	return {
		expense_date: requireExpenseDate(input.expense_date),
		description: requireString(input.description, 'La descripción', { min: 2, max: 200 }),
		category: requireString(input.category, 'La categoría', { min: 2, max: 80 }),
		supplier: requireString(input.supplier, 'El proveedor', { max: 150, optional: true }),
		amount_cents: amountCents,
		payment_method: requireString(input.payment_method, 'El método de pago', { min: 2, max: 60 }),
		bank: requireBankForPayment(input.payment_method, input.bank),
		document_type: requireString(input.document_type, 'El tipo de comprobante', { max: 60, optional: true }),
		document_number: requireString(input.document_number, 'El número de comprobante', { max: 100, optional: true }),
		notes: requireString(input.notes, 'Las notas', { max: 1_000, optional: true }),
	};
}

export async function listExpenses(db, { limit = 500 } = {}) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new ValidationError('El límite de gastos no es válido.');
	}
	const result = await db
		.prepare('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC LIMIT ?1')
		.bind(limit)
		.all();
	return result.results;
}

export async function createExpense(db, input, { now = new Date() } = {}) {
	const expense = validateExpenseInput(input);
	return db
		.prepare(
			`INSERT INTO expenses (
				expense_date, description, category, supplier, amount_cents,
				payment_method, bank, document_type, document_number, notes, created_at, updated_at
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
			 RETURNING *`,
		)
		.bind(
			expense.expense_date,
			expense.description,
			expense.category,
			expense.supplier,
			expense.amount_cents,
			expense.payment_method,
			expense.bank,
			expense.document_type,
			expense.document_number,
			expense.notes,
			now.toISOString(),
		)
		.first();
}

export async function attachExpenseReceipt(db, expenseId, receipt) {
	return db.prepare(
		`UPDATE expenses SET receipt_key = ?2, receipt_name = ?3, receipt_mime_type = ?4, updated_at = ?5
		 WHERE id = ?1 AND LOWER(TRIM(payment_method)) = 'transferencia' RETURNING *`,
	).bind(expenseId, receipt.key, receipt.name, receipt.mimeType, new Date().toISOString()).first();
}

export async function deleteExpense(db, expenseId) {
	const id = requirePositiveInteger(expenseId, 'El gasto');
	const deleted = await db.prepare('DELETE FROM expenses WHERE id = ?1 RETURNING *').bind(id).first();
	if (!deleted) throw new ValidationError('No se encontró el gasto.');
	return deleted;
}
