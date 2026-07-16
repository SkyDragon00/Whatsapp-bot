import { ValidationError } from '../domain/errors.js';
import { createExpense, deleteExpense, listExpenses } from '../repositories/expenses-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';

const ALLOWED_FIELDS = new Set([
	'expense_date',
	'description',
	'category',
	'supplier',
	'amount',
	'payment_method',
	'document_type',
	'document_number',
	'notes',
]);

function normalizeExpenseInput(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new ValidationError('El gasto debe ser un objeto.');
	}
	for (const key of Object.keys(input)) {
		if (!ALLOWED_FIELDS.has(key)) throw new ValidationError(`El campo ${key} no está permitido.`);
	}
	const amount = Number(input.amount);
	const amountCents = Math.round(amount * 100);
	if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - amountCents) > 0.000001) {
		throw new ValidationError('El monto debe ser mayor que cero y tener máximo dos decimales.');
	}
	return { ...input, amount_cents: amountCents };
}

function serializeExpense(expense) {
	return { ...expense, amount: expense.amount_cents / 100 };
}

export async function handleExpensesApi(request, env, url) {
	if (request.method === 'GET' && url.pathname === '/api/expenses') {
		const expenses = await listExpenses(env.DB);
		return jsonResponse(expenses.map(serializeExpense));
	}
	if (request.method === 'POST' && url.pathname === '/api/expenses') {
		const input = normalizeExpenseInput(await readJsonWithLimit(request, 32_000));
		return jsonResponse(serializeExpense(await createExpense(env.DB, input)), 201);
	}
	const match = /^\/api\/expenses\/(\d+)$/.exec(url.pathname);
	if (request.method === 'DELETE' && match) {
		return jsonResponse(serializeExpense(await deleteExpense(env.DB, Number(match[1]))));
	}
	return null;
}
