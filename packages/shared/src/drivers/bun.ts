import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema';
import type { AppDb } from '../types';

export function createBunDb(dataDir: string): AppDb {
	mkdirSync(dataDir, { recursive: true });
	const sqlite = new Database(join(dataDir, 'perseus.db'));
	const db = drizzle(sqlite, { schema });
	const here = dirname(fileURLToPath(import.meta.url));
	// Two layouts resolve to the drizzle migrations folder:
	//   - Bundled (apps/api/dist/index.js): build:bun copies migrations to
	//     dist/drizzle, which sits next to the bundle.
	//   - Unbundled dev (this source file): migrations live at
	//     packages/shared/drizzle, two levels up from packages/shared/src/drivers.
	const bundledMigrations = join(here, 'drizzle');
	const sourceMigrations = join(here, '..', '..', 'drizzle');
	const migrationsFolder = existsSync(bundledMigrations) ? bundledMigrations : sourceMigrations;
	migrate(db, { migrationsFolder });
	return db as unknown as AppDb;
}
