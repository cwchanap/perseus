import { createD1CompletionWriteExecutor, createD1Db } from '@perseus/shared/d1';
import type { AppDb, CompletionWriteExecutor } from '@perseus/shared';
import type { Env } from './worker';

export interface ApiDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
}

// Cache the runtime context per-env. The DB binding is stable for the lifetime
// of the worker isolate, so reusing one context avoids per-request allocation
// and keeps its DB and completion executor identities aligned.
const cache = new WeakMap<Env, ApiDbContext>();

export function getWorkerDbContext(env: Env): ApiDbContext {
	let context = cache.get(env);
	if (!context) {
		const db = createD1Db(env);
		context = {
			db,
			completionWrites: createD1CompletionWriteExecutor(db)
		};
		cache.set(env, context);
	}
	return context;
}

export function getWorkerDb(env: Env): AppDb {
	return getWorkerDbContext(env).db;
}
