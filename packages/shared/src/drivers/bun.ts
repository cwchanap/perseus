import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema';
import type { AppDb } from '../types';

export function createBunDb(dataDir: string): AppDb {
	mkdirSync(dataDir, { recursive: true });
	const sqlite = new Database(join(dataDir, 'perseus.db'));
	const db = drizzle(sqlite, { schema });
	const here = dirname(fileURLToPath(import.meta.url));
	migrate(db, { migrationsFolder: join(here, '..', '..', 'drizzle') });
	return db as unknown as AppDb;
}
