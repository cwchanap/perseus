import { createBunDb } from '@perseus/shared/bun';

let cached: ReturnType<typeof createBunDb> | null = null;

export function getDb() {
	if (!cached) {
		const dataDir = process.env.DATA_DIR || './data';
		cached = createBunDb(dataDir);
	}
	return cached;
}
