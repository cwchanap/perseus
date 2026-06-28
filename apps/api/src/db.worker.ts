import { createD1Db } from '@perseus/shared/d1';
import type { Env } from './worker';
import type { AppDb } from '@perseus/shared';

// Cache the drizzle instance per-env. createD1Db only captures the env.DB
// binding reference, which is stable for the lifetime of the worker isolate,
// so reusing one instance avoids per-request allocation overhead and matches
// the Bun runtime's caching in db.ts. The cache is keyed by env identity in
// case the same isolate ever handles multiple env shapes.
const cache = new WeakMap<Env, AppDb>();

export function getWorkerDb(env: Env): AppDb {
	let db = cache.get(env);
	if (!db) {
		db = createD1Db(env);
		cache.set(env, db);
	}
	return db;
}
