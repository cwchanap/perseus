import type { AppDb, CompletionWriteExecutor } from '@perseus/shared';
import { createBunDbContext } from '@perseus/shared/bun';

export interface ApiDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
}

let cached: ReturnType<typeof createBunDbContext> | null = null;

export function getDbContext(): ApiDbContext {
	if (!cached) {
		const dataDir = process.env.DATA_DIR || './data';
		cached = createBunDbContext(dataDir);
	}
	return cached;
}

export function getDb(): AppDb {
	return getDbContext().db;
}
