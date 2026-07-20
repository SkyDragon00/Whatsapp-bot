import { describe, expect, it, vi } from 'vitest';
import { getKnowledgeContext } from '../src/repositories/knowledge-repository.js';

describe('repositorio de documentos de IA', () => {
	it('crea el esquema faltante y deja continuar al bot', async () => {
		let schemaExists = false;
		const db = {
			prepare: vi.fn((sql) => ({
				sql,
				async all() {
					if (!schemaExists) throw new Error('D1_ERROR: no such table: ai_knowledge_documents');
					return { results: [] };
				},
			})),
			batch: vi.fn(async () => {
				schemaExists = true;
			}),
		};

		await expect(getKnowledgeContext(db)).resolves.toEqual([]);
		expect(db.batch).toHaveBeenCalledTimes(1);
	});

	it('no oculta errores de D1 que no sean una tabla faltante', async () => {
		const db = {
			prepare: () => ({ all: async () => { throw new Error('D1_ERROR: database unavailable'); } }),
		};
		await expect(getKnowledgeContext(db)).rejects.toThrow('database unavailable');
	});
});
