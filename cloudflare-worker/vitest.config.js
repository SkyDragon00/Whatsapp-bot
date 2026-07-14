import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations(path.join(projectDirectory, 'migrations'));
	return {
		test: {
			poolOptions: {
				workers: {
					wrangler: { configPath: './wrangler.jsonc' },
					miniflare: {
						bindings: { TEST_MIGRATIONS: migrations },
					},
				},
			},
		},
	};
});
