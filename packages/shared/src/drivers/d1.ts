import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../schema';
import type { AppDb } from '../types';

interface D1Env {
	DB: D1Database;
}

export function createD1Db(env: D1Env): AppDb {
	// Migrations live in packages/shared/drizzle and are applied by:
	//   - CI:  the "Apply D1 migrations" step in deploy-infrastructure.yml
	//          (runs `bun run db:migrate` after Pulumi provisions the DB), or
	//   - manually: `bun run db:migrate` (remote) / `db:migrate:local` (dev).
	return drizzle(env.DB, { schema }) as unknown as AppDb;
}
