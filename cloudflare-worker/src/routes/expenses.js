import { ValidationError } from '../domain/errors.js';
import { attachExpenseReceipt, createExpense, deleteExpense, listExpenses } from '../repositories/expenses-repository.js';
import { readJsonWithLimit } from '../utils/http.js';
import { jsonResponse } from '../utils/responses.js';
import { receiptResponse, storeReceipt } from '../storage/receipts.js';
import { isTransfer } from '../domain/banking.js';

const ALLOWED_FIELDS = new Set([
	'expense_date',
	'description',
	'category',
	'supplier',
	'amount',
	'payment_method',
	'bank',
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
	return {
		...expense,
		amount: expense.amount_cents / 100,
		receipt_url: expense.receipt_key ? `/api/expenses/${expense.id}/receipt` : null,
	};
}

export async function handleExpensesApi(request, env, url, companyId) {
	if (request.method === 'GET' && url.pathname === '/api/expenses') {
		const expenses = await listExpenses(env.DB, { companyId });
		return jsonResponse(expenses.map(serializeExpense));
	}
	if (request.method === 'POST' && url.pathname === '/api/expenses') {
		const contentType = request.headers.get('content-type') || '';
		let input;
		let receiptFile;
		if (contentType.includes('multipart/form-data')) {
			const form = await request.formData();
			receiptFile = form.get('receipt');
			form.delete('receipt');
			input = normalizeExpenseInput(Object.fromEntries(form.entries()));
		} else {
			input = normalizeExpenseInput(await readJsonWithLimit(request, 32_000));
		}
		if (receiptFile instanceof File && receiptFile.size > 0 && !isTransfer(input.payment_method)) {
			throw new ValidationError('Solo se guardan comprobantes de transferencias bancarias.');
		}
		let expense = await createExpense(env.DB, input, { companyId });
		if (receiptFile instanceof File && receiptFile.size > 0) {
			const receipt = await storeReceipt(env.RECEIPTS, {
				ownerType: 'expenses',
				ownerId: expense.id,
				bytes: receiptFile,
				mimeType: receiptFile.type,
				fileName: receiptFile.name,
			});
			expense = await attachExpenseReceipt(env.DB, expense.id, receipt);
		}
		return jsonResponse(serializeExpense(expense), 201);
	}
	const receiptMatch = /^\/api\/expenses\/(\d+)\/receipt$/.exec(url.pathname);
	if (request.method === 'GET' && receiptMatch) {
		const expense = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?1 AND (?2 IS NULL OR company_id = ?2)').bind(Number(receiptMatch[1]), companyId).first();
		const response = expense
			&& await receiptResponse(env.RECEIPTS, expense.receipt_key, expense.receipt_name, expense.receipt_mime_type);
		return response ?? jsonResponse({ ok: false, error: 'Comprobante no encontrado.' }, 404);
	}
	const match = /^\/api\/expenses\/(\d+)$/.exec(url.pathname);
	if (request.method === 'DELETE' && match) {
		const owned = await env.DB.prepare('SELECT id FROM expenses WHERE id = ?1 AND (?2 IS NULL OR company_id = ?2)').bind(Number(match[1]), companyId).first();
		if (!owned) throw new ValidationError('No se encontrÃ³ el gasto.');
		const deleted = await deleteExpense(env.DB, Number(match[1]));
		if (deleted.receipt_key && env.RECEIPTS) await env.RECEIPTS.delete(deleted.receipt_key);
		return jsonResponse(serializeExpense(deleted));
	}
	return null;
}
