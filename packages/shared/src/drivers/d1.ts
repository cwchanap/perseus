import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../schema';
import type { AppDb } from '../types';

interface D1Env {
	DB: D1Database;
}

export function createD1Db(env: D1Env): AppDb {
	// D1 migrations are applied out-of-band via `wrangler d1 migrations apply`.
	return drizzle(env.DB, { schema }) as unknown as AppDb;
}
