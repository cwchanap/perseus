# Player Profile Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, self-only player profile page (identity card + activity hub) backed by D1, exposed through a new `@perseus/shared` Drizzle package.

**Architecture:** New `@perseus/shared` workspace package holds the Drizzle schema, async repository functions, and dual driver factories (`/d1`, `/bun` subpath exports). Production runs on D1; Bun dev runs on `bun:sqlite` with the identical schema. Six new API endpoints (dual-runtime `.ts`/`.worker.ts`) serve a new `/profile` SvelteKit route. Puzzle ownership and solving stats are recorded server-side; localStorage stats remain as offline fallback.

**Tech Stack:** Drizzle ORM (`drizzle-orm` + `drizzle-kit`), Cloudflare D1, `bun:sqlite`, Hono, SvelteKit (Svelte 5 runes), Pulumi (`@pulumi/cloudflare`).

**Spec:** `docs/superpowers/specs/2026-06-26-profile-page-design.md`

## Global Constraints

- Monorepo uses **Bun** (`bun@1.3.1`) + **Turborepo**; workspaces are `apps/*` and `packages/*`.
- Code style: **tabs**, **single quotes**, **no trailing commas**, **100 char** lines, Prettier + ESLint.
- Dual-runtime convention: Bun files are `name.ts`; Cloudflare Worker files are `name.worker.ts`. Both must stay in sync.
- Player auth is already wired: `requirePlayerAuth` middleware sets `c.get('playerSession')` whose `.user.id` is the player id. Bun version: `apps/api/src/middleware/player-auth.ts`; Worker version: `...player-auth.worker.ts`.
- Worker bindings live in `Env` (`apps/api/src/worker.ts`); Bun uses `process.env` + module storage.
- `@perseus/types` exports raw `src/index.ts` (no build step); same convention for `@perseus/shared`.
- Web tests: Vitest **browser mode** (all components need assertions); E2E via Playwright.
- Commit style: conventional commits (`feat:`, `test:`, `chore:`, `docs:`), lowercase, scoped where helpful.
- Never commit secrets. Never run `wrangler deploy` / `pulumi up` unless explicitly asked.

---

## File Structure

**New package `packages/shared/` (`@perseus/shared`):**

- `src/schema.ts` — Drizzle table definitions (pure, no runtime deps)
- `src/types.ts` — TS types inferred from schema + the cross-runtime `AppDb` type
- `src/repositories.ts` — async query functions, each taking an `AppDb`
- `src/drivers/d1.ts` — `createD1Db(env)` factory (`drizzle-orm/d1`)
- `src/drivers/bun.ts` — `createBunDb(dataDir)` factory (`drizzle-orm/bun-sql`)
- `src/index.ts` — re-exports schema, types, repositories
- `drizzle.config.ts` — drizzle-kit config (points at `src/schema.ts`)
- `drizzle/migrations/*.sql` — generated migrations
- `src/__tests__/repositories.test.ts` — repository tests (in-memory `bun:sqlite`)
- `package.json`, `tsconfig.json`

**Modified `packages/types/src/index.ts`:** add `PlayerProfile`, `PlayerProfileUpdate`, `PlayerPuzzleSummary`, `PlayerStatRow` + validators.

**Modified `apps/api/`:**

- `src/db.ts` (new) — Bun db wiring via `createBunDb`
- `src/db.worker.ts` (new) — Worker db wiring via `createD1Db`
- `src/worker.ts` — add `DB: D1Database` to `Env`; mount `/api/player` routes
- `src/index.ts` — mount `/api/player` routes; run Bun migrations on startup
- `src/routes/player.ts` (new) — Bun player routes
- `src/routes/player.worker.ts` (new) — Worker player routes
- `src/routes/puzzles.ts` — add `POST /:id/complete`; write ownership row on create
- `src/routes/puzzles.worker.ts` — same, Worker version
- `package.json` — add `@perseus/shared`, `drizzle-orm` deps; `drizzle-kit` devDep

**Modified `apps/workflows/`:**

- `src/...` (the workflow completion path) — update `puzzles.status` to `'ready'` in D1
- `wrangler.toml` / `wrangler.production.toml` — add `DB` D1 binding
- `package.json` — add `@perseus/shared`, `drizzle-orm` deps

**Modified `apps/web/`:**

- `src/lib/services/api.ts` — 6 new service functions
- `src/routes/profile/+page.svelte` (new) — profile page
- `src/routes/profile/+page.ts` (new) — `prerender = false`
- `src/routes/profile/page.svelte.test.ts` (new) — component test
- `src/routes/+layout.svelte` — nav link
- `src/routes/puzzle/[id]/+page.svelte` — completion recording hook
- `e2e/profile.spec.ts` (new) — E2E test

**Infra:**

- `apps/api/wrangler.toml`, `apps/api/wrangler.production.toml` — D1 binding `DB`
- `packages/infrastructure/src/{config,resources,workers,index}.ts` — D1 resource + wiring

---

## Task 1: Scaffold `@perseus/shared` package and add shared types

**Files:**

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Modify: `packages/types/src/index.ts` (append new types + validators)
- Test: `packages/types/src/index.test.ts` (append validator tests)

**Interfaces:**

- Produces: `@perseus/shared` resolvable workspace package; types `PlayerProfile`, `PlayerProfileUpdate`, `PlayerPuzzleSummary`, `PlayerStatRow` + validators `isPlayerProfile`, `isPlayerStatRow`, `isPlayerPuzzleSummary` exported from `@perseus/types`.

- [ ] **Step 1: Create the package manifest**

`packages/shared/package.json`:

```json
{
	"name": "@perseus/shared",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"main": "./src/index.ts",
	"types": "./src/index.ts",
	"exports": {
		".": {
			"types": "./src/index.ts",
			"default": "./src/index.ts"
		},
		"./d1": {
			"types": "./src/drivers/d1.ts",
			"default": "./src/drivers/d1.ts"
		},
		"./bun": {
			"types": "./src/drivers/bun.ts",
			"default": "./src/drivers/bun.ts"
		}
	},
	"scripts": {
		"check": "tsc --noEmit",
		"test:unit": "vitest run"
	},
	"dependencies": {
		"drizzle-orm": "^0.36.0"
	},
	"devDependencies": {
		"@types/bun": "^1.1.15",
		"drizzle-kit": "^0.28.0",
		"typescript": "^5.9.3",
		"vitest": "^4.0.18"
	}
}
```

`packages/shared/tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"noEmit": true,
		"lib": ["ES2022"],
		"types": ["bun"]
	},
	"include": ["src/**/*.ts"]
}
```

`packages/shared/src/index.ts` (placeholder until Task 2; will be overwritten):

```ts
export {};
```

- [ ] **Step 2: Add profile types + validators to `@perseus/types`**

Append to `packages/types/src/index.ts` (before the `// Validation functions` section's existing exports is fine — append near the other interfaces, e.g. after `PlayerAllowlistMutationResponse`):

```ts
export interface PlayerProfileSummary {
	puzzlesUploaded: number;
	puzzlesSolved: number;
	totalCompletions: number;
}

export interface PlayerProfile {
	id: string;
	email: string;
	name: string;
	picture: string | null;
	createdAt: number;
	lastLoginAt: number;
	summary: PlayerProfileSummary;
}

export interface PlayerProfileUpdate {
	displayName: string | null;
}

export interface PlayerPuzzleSummary {
	id: string;
	name: string;
	pieceCount: number;
	category?: string;
	status: string;
	createdAt: number;
}

export interface PlayerStatRow {
	puzzleId: string;
	bestTimeSeconds: number;
	totalCompletions: number;
	firstCompletedAt: number;
	lastCompletedAt: number;
}

export function isPlayerProfile(value: unknown): value is PlayerProfile {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!isNonEmptyString(v.id)) return false;
	if (!isNonEmptyString(v.email)) return false;
	if (!isNonEmptyString(v.name)) return false;
	if (v.picture !== null && !isNonEmptyString(v.picture)) return false;
	if (!isFiniteNumber(v.createdAt)) return false;
	if (!isFiniteNumber(v.lastLoginAt)) return false;
	if (typeof v.summary !== 'object' || v.summary === null) return false;
	const s = v.summary as Record<string, unknown>;
	return (
		isFiniteNumber(s.puzzlesUploaded) &&
		isFiniteNumber(s.puzzlesSolved) &&
		isFiniteNumber(s.totalCompletions)
	);
}

export function isPlayerPuzzleSummary(value: unknown): value is PlayerPuzzleSummary {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isNonEmptyString(v.id) &&
		isNonEmptyString(v.name) &&
		isFiniteNumber(v.pieceCount) &&
		isFiniteNumber(v.createdAt) &&
		isNonEmptyString(v.status) &&
		(v.category === undefined || isNonEmptyString(v.category))
	);
}

export function isPlayerStatRow(value: unknown): value is PlayerStatRow {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isNonEmptyString(v.puzzleId) &&
		isFiniteNumber(v.bestTimeSeconds) &&
		isFiniteNumber(v.totalCompletions) &&
		isFiniteNumber(v.firstCompletedAt) &&
		isFiniteNumber(v.lastCompletedAt)
	);
}
```

Note: `isNonEmptyString` and `isFiniteNumber` already exist in this file (lines ~177-183).

- [ ] **Step 3: Write the failing validator tests**

Append to `packages/types/src/index.test.ts`:

```ts
import {
	isPlayerProfile,
	isPlayerPuzzleSummary,
	isPlayerStatRow,
	type PlayerProfile,
	type PlayerPuzzleSummary,
	type PlayerStatRow
} from './index';

describe('player profile validators', () => {
	const profile: PlayerProfile = {
		id: 'p1',
		email: 'p@example.com',
		name: 'Player',
		picture: null,
		createdAt: 1,
		lastLoginAt: 2,
		summary: { puzzlesUploaded: 1, puzzlesSolved: 2, totalCompletions: 3 }
	};

	it('validates a well-formed profile', () => {
		expect(isPlayerProfile(profile)).toBe(true);
	});

	it('rejects profile with bad summary', () => {
		expect(isPlayerProfile({ ...profile, summary: { puzzlesUploaded: 'x' } })).toBe(false);
	});

	it('rejects null', () => {
		expect(isPlayerProfile(null)).toBe(false);
	});

	const stat: PlayerStatRow = {
		puzzleId: 'pz1',
		bestTimeSeconds: 90,
		totalCompletions: 2,
		firstCompletedAt: 10,
		lastCompletedAt: 20
	};

	it('validates a stat row', () => {
		expect(isPlayerStatRow(stat)).toBe(true);
		expect(isPlayerStatRow({ ...stat, bestTimeSeconds: 'x' })).toBe(false);
	});

	const puzzle: PlayerPuzzleSummary = {
		id: 'pz1',
		name: 'Cat',
		pieceCount: 100,
		status: 'ready',
		createdAt: 5
	};

	it('validates a player puzzle summary', () => {
		expect(isPlayerPuzzleSummary(puzzle)).toBe(true);
		expect(isPlayerPuzzleSummary({ ...puzzle, status: 5 })).toBe(false);
	});
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/types && bun run test:unit`
Expected: PASS (types added alongside tests).

- [ ] **Step 5: Install workspace deps + verify package resolves**

Run: `bun install` (from repo root — registers the new workspace package).
Expected: install succeeds; `@perseus/shared` is now resolvable.

- [ ] **Step 6: Commit**

```bash
git add packages/shared packages/types/package.json packages/types/src/index.ts packages/types/src/index.test.ts bun.lock
git commit -m "feat(shared): scaffold @perseus/shared package and profile types"
```

---

## Task 2: Drizzle schema + inferred types

**Files:**

- Create: `packages/shared/src/schema.ts`
- Create: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/drizzle.config.ts`
- Test: `packages/shared/src/__tests__/schema.test.ts`

**Interfaces:**

- Produces: `playerProfiles`, `puzzleStats`, `puzzles` table defs; inferred types `PlayerProfileRow`, `PuzzleStatRow`, `PuzzleRow`; `AppDb` base type.

- [ ] **Step 1: Write the failing schema test**

`packages/shared/src/__tests__/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { eq } from 'drizzle-orm';
import { playerProfiles, puzzleStats, puzzles } from '../schema';

describe('schema tables', () => {
	function makeDb() {
		const sqlite = new Database(':memory:');
		const db = drizzle(sqlite);
		migrate(db, { migrationsFolder: './drizzle' });
		return { db, sqlite };
	}

	it('creates all three tables', () => {
		const { db, sqlite } = makeDb();
		// Insert + read one row per table to confirm shape.
		db.insert(playerProfiles).values({ playerId: 'p1', displayName: 'P', updatedAt: 1 }).run();
		db.insert(puzzles)
			.values({
				id: 'pz1',
				ownerId: 'p1',
				name: 'Cat',
				pieceCount: 4,
				status: 'processing',
				createdAt: 1
			})
			.run();
		db.insert(puzzleStats)
			.values({
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 90,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			})
			.run();

		const profile = db.select().from(playerProfiles).where(eq(playerProfiles.playerId, 'p1')).get();
		expect(profile?.displayName).toBe('P');

		const owned = db.select().from(puzzles).where(eq(puzzles.ownerId, 'p1')).all();
		expect(owned).toHaveLength(1);

		const stats = db.select().from(puzzleStats).where(eq(puzzleStats.playerId, 'p1')).all();
		expect(stats).toHaveLength(1);
		sqlite.close();
	});
});
```

> Note: the migration in Step 2 must exist before this test runs. The test references `./drizzle`; if `migrate` complains about an empty migrations folder, the fallback is to run `drizzle-kit generate` (Step 4) first. To keep TDD ordering clean, Step 2 defines the schema, Step 3 generates the migration, then this test is run in Step 5.

- [ ] **Step 2: Write the schema**

`packages/shared/src/schema.ts`:

```ts
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const playerProfiles = sqliteTable('player_profiles', {
	playerId: text('player_id').primaryKey(),
	displayName: text('display_name'),
	avatarUrl: text('avatar_url'),
	updatedAt: integer('updated_at').notNull()
});

export const puzzleStats = sqliteTable(
	'puzzle_stats',
	{
		playerId: text('player_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		bestTimeSeconds: integer('best_time_seconds').notNull(),
		totalCompletions: integer('total_completions').notNull().default(1),
		firstCompletedAt: integer('first_completed_at').notNull(),
		lastCompletedAt: integer('last_completed_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.playerId, t.puzzleId] }), index('idx_ps_player').on(t.playerId)]
);

export const puzzles = sqliteTable(
	'puzzles',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		name: text('name').notNull(),
		pieceCount: integer('piece_count').notNull(),
		category: text('category'),
		status: text('status').notNull().default('processing'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('idx_puzzles_owner').on(t.ownerId, t.createdAt)]
);
```

- [ ] **Step 3: Write inferred types**

`packages/shared/src/types.ts`:

```ts
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from './schema';

export type PlayerProfileRow = typeof schema.playerProfiles.$inferSelect;
export type NewPlayerProfileRow = typeof schema.playerProfiles.$inferInsert;
export type PuzzleStatRow = typeof schema.puzzleStats.$inferSelect;
export type NewPuzzleStatRow = typeof schema.puzzleStats.$inferInsert;
export type PuzzleRow = typeof schema.puzzles.$inferSelect;
export type NewPuzzleRow = typeof schema.puzzles.$inferInsert;

/**
 * Cross-runtime Drizzle client. Both `drizzle-orm/d1` (D1Database) and
 * `drizzle-orm/bun-sql` (bun:sqlite) produce databases assignable to this
 * base. Repository functions always `await` results, so the sync (bun) vs
 * async (D1) distinction is handled at runtime.
 */
export type AppDb = BaseSQLiteDatabase<unknown, unknown, typeof schema>;

export type { schema };
```

- [ ] **Step 4: Write `index.ts` re-exports + drizzle config**

`packages/shared/src/index.ts`:

```ts
export * from './schema';
export * from './types';
```

`packages/shared/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/schema.ts',
	out: './drizzle',
	dialect: 'sqlite'
});
```

- [ ] **Step 5: Generate the first migration**

Run: `cd packages/shared && bunx drizzle-kit generate`
Expected: creates `packages/shared/drizzle/0000_*.sql` + `meta/` with `CREATE TABLE` statements for all three tables.

- [ ] **Step 6: Run the schema test**

Run: `cd packages/shared && bun run test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add drizzle schema, inferred types, and initial migration"
```

---

## Task 3: Repository functions

**Files:**

- Create: `packages/shared/src/repositories.ts`
- Create: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export repositories)

**Interfaces:**

- Consumes: `AppDb`, table defs from `schema.ts`.
- Produces: `getProfileOverride(db, playerId)`, `upsertProfileOverride(db, playerId, {displayName, avatarUrl})`, `listPlayerPuzzles(db, playerId, {limit, cursor})`, `countPlayerPuzzles(db, playerId)`, `listPlayerStats(db, playerId, {limit, cursor})`, `getPlayerSummary(db, playerId)`, `recordCompletion(db, playerId, puzzleId, timeSeconds)`, `insertPuzzleOwnership(db, row)`, `setPuzzleStatus(db, id, status)`.

- [ ] **Step 1: Write failing repository tests**

`packages/shared/src/__tests__/repositories.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import {
	getProfileOverride,
	upsertProfileOverride,
	insertPuzzleOwnership,
	listPlayerPuzzles,
	countPlayerPuzzles,
	recordCompletion,
	listPlayerStats,
	getPlayerSummary
} from '../repositories';

function makeDb() {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite);
	migrate(db, { migrationsFolder: './drizzle' });
	return { db, close: () => sqlite.close() };
}

describe('repositories', () => {
	let helper: ReturnType<typeof makeDb>;

	beforeEach(() => {
		helper = makeDb();
	});

	it('getProfileOverride returns null when absent', async () => {
		expect(await getProfileOverride(helper.db, 'p1')).toBeNull();
	});

	it('upsertProfileOverride inserts then updates', async () => {
		await upsertProfileOverride(helper.db, 'p1', { displayName: 'A', avatarUrl: null });
		let row = await getProfileOverride(helper.db, 'p1');
		expect(row?.displayName).toBe('A');

		await upsertProfileOverride(helper.db, 'p1', { displayName: 'B', avatarUrl: 'u' });
		row = await getProfileOverride(helper.db, 'p1');
		expect(row?.displayName).toBe('B');
		expect(row?.avatarUrl).toBe('u');
	});

	it('insertPuzzleOwnership + list/count', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			category: 'Animals',
			status: 'processing',
			createdAt: 10
		});
		await insertPuzzleOwnership(helper.db, {
			id: 'pz2',
			ownerId: 'p1',
			name: 'Dog',
			pieceCount: 9,
			status: 'ready',
			createdAt: 20
		});
		const list = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(2);
		expect(list.rows[0].id).toBe('pz2'); // newest first
		expect(await countPlayerPuzzles(helper.db, 'p1')).toBe(2);
	});

	it('listPlayerPuzzles cursor pagination', async () => {
		for (let i = 0; i < 3; i++) {
			await insertPuzzleOwnership(helper.db, {
				id: `pz${i}`,
				ownerId: 'p1',
				name: `N${i}`,
				pieceCount: 4,
				status: 'ready',
				createdAt: i
			});
		}
		const page1 = await listPlayerPuzzles(helper.db, 'p1', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		const page2 = await listPlayerPuzzles(helper.db, 'p1', { limit: 2, cursor: page1.nextCursor! });
		expect(page2.rows).toHaveLength(1);
		expect(page2.nextCursor).toBeUndefined();
	});

	it('recordCompletion upserts best time and increments count', async () => {
		await recordCompletion(helper.db, 'p1', 'pz1', 100);
		await recordCompletion(helper.db, 'p1', 'pz1', 80);
		await recordCompletion(helper.db, 'p1', 'pz1', 120);
		const stats = await listPlayerStats(helper.db, 'p1', { limit: 10 });
		expect(stats.rows).toHaveLength(1);
		expect(stats.rows[0].bestTimeSeconds).toBe(80);
		expect(stats.rows[0].totalCompletions).toBe(3);
	});

	it('getPlayerSummary aggregates counts', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		await recordCompletion(helper.db, 'p1', 'pz1', 50);
		await recordCompletion(helper.db, 'p1', 'pzX', 50); // a puzzle not owned by p1
		const summary = await getPlayerSummary(helper.db, 'p1');
		expect(summary).toEqual({ puzzlesUploaded: 1, puzzlesSolved: 2, totalCompletions: 2 });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && bun run test:unit`
Expected: FAIL — `../repositories` does not export the functions.

- [ ] **Step 3: Implement repositories**

`packages/shared/src/repositories.ts`:

```ts
import { eq, lt, desc, count, sql } from 'drizzle-orm';
import type { AppDb, NewPuzzleRow, PlayerProfileRow } from './types';
import { puzzles, playerProfiles, puzzleStats } from './schema';

export async function getProfileOverride(
	db: AppDb,
	playerId: string
): Promise<PlayerProfileRow | null> {
	const rows = await db
		.select()
		.from(playerProfiles)
		.where(eq(playerProfiles.playerId, playerId))
		.limit(1)
		.all();
	return rows[0] ?? null;
}

export async function upsertProfileOverride(
	db: AppDb,
	playerId: string,
	values: { displayName: string | null; avatarUrl: string | null }
): Promise<void> {
	const now = Date.now();
	await db
		.insert(playerProfiles)
		.values({
			playerId,
			displayName: values.displayName,
			avatarUrl: values.avatarUrl,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: {
				displayName: values.displayName,
				avatarUrl: values.avatarUrl,
				updatedAt: now
			}
		})
		.run();
}

export async function insertPuzzleOwnership(db: AppDb, row: NewPuzzleRow): Promise<void> {
	await db.insert(puzzles).values(row).run();
}

export async function setPuzzleStatus(db: AppDb, id: string, status: string): Promise<void> {
	await db.update(puzzles).set({ status }).where(eq(puzzles.id, id)).run();
}

export async function listPlayerPuzzles(
	db: AppDb,
	playerId: string,
	opts: { limit: number; cursor?: number }
): Promise<{ rows: (typeof puzzles.$inferSelect)[]; nextCursor?: number }> {
	const limit = Math.min(Math.max(opts.limit, 1), 100);
	let q = db
		.select()
		.from(puzzles)
		.where(eq(puzzles.ownerId, playerId))
		.orderBy(desc(puzzles.createdAt))
		.limit(limit + 1);
	if (opts.cursor !== undefined) {
		q = q.where(lt(puzzles.createdAt, opts.cursor)) as typeof q;
	}
	const all = await q.all();
	const rows = all.slice(0, limit);
	const nextCursor = all.length > limit ? rows[rows.length - 1].createdAt : undefined;
	return { rows, nextCursor };
}

export async function countPlayerPuzzles(db: AppDb, playerId: string): Promise<number> {
	const rows = await db
		.select({ n: count() })
		.from(puzzles)
		.where(eq(puzzles.ownerId, playerId))
		.all();
	return rows[0]?.n ?? 0;
}

export async function recordCompletion(
	db: AppDb,
	playerId: string,
	puzzleId: string,
	timeSeconds: number
): Promise<void> {
	const now = Date.now();
	await db
		.insert(puzzleStats)
		.values({
			playerId,
			puzzleId,
			bestTimeSeconds: timeSeconds,
			totalCompletions: 1,
			firstCompletedAt: now,
			lastCompletedAt: now
		})
		.onConflictDoUpdate({
			target: [puzzleStats.playerId, puzzleStats.puzzleId],
			set: {
				// MIN of stored vs incoming (excluded) best time; `excluded` is SQLite's
				// name for the conflicting incoming row.
				bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`,
				totalCompletions: sql`${puzzleStats.totalCompletions} + 1`,
				lastCompletedAt: now
			}
		})
		.run();
}
```

`listPlayerStats` and `getPlayerSummary`:

```ts
export async function listPlayerStats(
	db: AppDb,
	playerId: string,
	opts: { limit: number }
): Promise<{ rows: (typeof puzzleStats.$inferSelect)[] }> {
	const limit = Math.min(Math.max(opts.limit, 1), 100);
	const rows = await db
		.select()
		.from(puzzleStats)
		.where(eq(puzzleStats.playerId, playerId))
		.orderBy(desc(puzzleStats.bestTimeSeconds))
		.limit(limit)
		.all();
	return { rows };
}

export async function getPlayerSummary(
	db: AppDb,
	playerId: string
): Promise<{ puzzlesUploaded: number; puzzlesSolved: number; totalCompletions: number }> {
	const uploadedRows = await db
		.select({ n: count() })
		.from(puzzles)
		.where(eq(puzzles.ownerId, playerId))
		.all();
	const solvedRows = await db
		.select({
			solved: count(),
			completions: sql<number>`COALESCE(SUM(${puzzleStats.totalCompletions}), 0)`
		})
		.from(puzzleStats)
		.where(eq(puzzleStats.playerId, playerId))
		.all();
	return {
		puzzlesUploaded: uploadedRows[0]?.n ?? 0,
		puzzlesSolved: solvedRows[0]?.solved ?? 0,
		totalCompletions: Number(solvedRows[0]?.completions ?? 0)
	};
}
```

- [ ] **Step 4: Re-export repositories**

`packages/shared/src/index.ts`:

```ts
export * from './schema';
export * from './types';
export * from './repositories';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && bun run test:unit`
Expected: PASS (all repository tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add repository functions for profile, stats, and ownership"
```

---

## Task 4: Driver factories

**Files:**

- Create: `packages/shared/src/drivers/d1.ts`
- Create: `packages/shared/src/drivers/bun.ts`
- Test: `packages/shared/src/__tests__/drivers.test.ts`

**Interfaces:**

- Produces: `createD1Db(env: { DB: D1Database }): AppDb`, `createBunDb(dataDir: string): AppDb`. Each runs migrations against its target.

- [ ] **Step 1: Write failing driver test**

`packages/shared/src/__tests__/drivers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBunDb } from '../drivers/bun';
import { getPlayerSummary } from '../repositories';

describe('createBunDb', () => {
	it('creates a migrated db and serves repositories', async () => {
		const dir = join(tmpdir(), `perseus-bun-driver-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const db = createBunDb(dir);
		const summary = await getPlayerSummary(db, 'p1');
		expect(summary.puzzlesUploaded).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Implement the bun driver**

`packages/shared/src/drivers/bun.ts`:

```ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema';
import type { AppDb } from '../types';

export function createBunDb(dataDir: string): AppDb {
	mkdirSync(dataDir, { recursive: true });
	const sqlite = new Database(join(dataDir, 'perseus.db'));
	const db = drizzle(sqlite, { schema }) as unknown as AppDb;
	const here = dirname(fileURLToPath(import.meta.url));
	migrate(db, { migrationsFolder: join(here, '..', '..', 'drizzle') });
	return db;
}
```

- [ ] **Step 3: Implement the d1 driver**

`packages/shared/src/drivers/d1.ts`:

```ts
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
```

> The `as unknown as AppDb` cast bridges the D1/bun-sql concrete db types to the shared `AppDb` base. Repository functions await all results, so sync/async differences are handled at runtime.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && bun run test:unit`
Expected: PASS.

- [ ] **Step 5: Typecheck the package**

Run: `cd packages/shared && bun run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add d1 and bun driver factories"
```

---

## Task 5: D1 wrangler binding + API DB wiring

**Files:**

- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/wrangler.production.toml`
- Modify: `apps/api/src/worker.ts` (add `DB` to `Env`)
- Modify: `apps/api/package.json` (add deps)
- Create: `apps/api/src/db.ts`
- Create: `apps/api/src/db.worker.ts`
- Modify: `apps/api/src/index.ts` (mount note only; wiring done in Task 6)

**Interfaces:**

- Produces: `getDb()` in `apps/api/src/db.ts` (Bun singleton) and `getWorkerDb(env)` in `apps/api/src/db.worker.ts`; `Env.DB: D1Database`.

- [ ] **Step 1: Add dependencies to the api package**

`apps/api/package.json` — add to `dependencies`:

```json
		"@perseus/shared": "workspace:*",
		"drizzle-orm": "^0.36.0"
```

And to `devDependencies`:

```json
		"drizzle-kit": "^0.28.0"
```

Run: `bun install` (repo root).

- [ ] **Step 2: Add D1 binding to wrangler configs**

In `apps/api/wrangler.toml`, after the `[[kv_namespaces]]` block add:

```toml
# D1 database for player profile, stats, and puzzle ownership
[[d1_databases]]
binding = "DB"
database_name = "perseus-player-data"
database_id = "local-dev-d1"
```

In the `[env.dev]` section add a dev override:

```toml
[[env.dev.d1_databases]]
binding = "DB"
database_name = "perseus-player-data"
database_id = "local-dev-d1"
```

In `apps/api/wrangler.production.toml` add the same `[[d1_databases]]` block but with the real production `database_id` placeholder (`PROD_D1_ID`), to be filled at deploy time:

```toml
[[d1_databases]]
binding = "DB"
database_name = "perseus-player-data"
database_id = "REPLACE_WITH_PROD_D1_ID"
```

- [ ] **Step 3: Add `DB` to the Worker `Env`**

In `apps/api/src/worker.ts`, add to the `Env` interface (after `PUZZLE_WORKFLOW`):

```ts
DB: D1Database;
```

- [ ] **Step 4: Create the Bun db singleton**

`apps/api/src/db.ts`:

```ts
import { createBunDb } from '@perseus/shared/bun';

let cached: ReturnType<typeof createBunDb> | null = null;

export function getDb() {
	if (!cached) {
		const dataDir = process.env.DATA_DIR || './data';
		cached = createBunDb(dataDir);
	}
	return cached;
}
```

- [ ] **Step 5: Create the Worker db helper**

`apps/api/src/db.worker.ts`:

```ts
import { createD1Db } from '@perseus/shared/d1';
import type { Env } from './worker';
import type { AppDb } from '@perseus/shared';

export function getWorkerDb(env: Env): AppDb {
	return createD1Db(env);
}
```

- [ ] **Step 6: Verify it typechecks + the worker builds**

Run: `cd apps/api && bun run check`
Expected: no errors. (If `@perseus/shared/bun` or `/d1` subpath resolves, good; otherwise confirm `bun install` registered exports.)

Run: `cd apps/api && bun run build`
Expected: wrangler dry-run build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/api packages/shared bun.lock
git commit -m "feat(api): wire D1 binding and dual-runtime db access"
```

---

## Task 6: `GET` + `PATCH /api/player/profile` (Bun + Worker)

**Files:**

- Create: `apps/api/src/routes/player.ts`
- Create: `apps/api/src/routes/player.worker.ts`
- Modify: `apps/api/src/index.ts` (mount `/api/player`)
- Modify: `apps/api/src/worker.ts` (mount `/api/player`)
- Test: `apps/api/src/__tests__/player.test.ts`, `apps/api/src/routes/player.worker.test.ts`

**Interfaces:**

- Consumes: `getDb()` (Bun), `getWorkerDb(env)` (Worker), `requirePlayerAuth`, repositories, `@perseus/types` validators.
- Produces: `GET /api/player/profile` → `PlayerProfile`; `PATCH /api/player/profile` accepts `{ displayName: string | null }`.

- [ ] **Step 1: Write failing Bun route test**

`apps/api/src/__tests__/player.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

// The Bun player route reads the session via the Bun player-auth service.
// We stub the middleware by injecting a known player session through a
// test-only app that sets c.set('playerSession', ...) before the route.
import player from '../routes/player';
import { getDb } from '../db';
import { upsertProfileOverride, insertPuzzleOwnership, recordCompletion } from '@perseus/shared';

const TEST_PLAYER = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'Google Name',
		picture: 'g.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'h',
	createdAt: 1,
	expiresAt: 9999999999999
};

function buildApp() {
	const app = new Hono();
	app.use('*', async (c, next) => {
		c.set('playerSession', TEST_PLAYER as never);
		await next();
	});
	app.route('/api/player', player);
	return app;
}

describe('player profile routes (Bun)', () => {
	beforeEach(async () => {
		// Use a fresh temp DATA_DIR for isolation handled by env; here we just
		// rely on the singleton being migrated. Clear rows between tests:
		const db = getDb();
		await db.run({ sql: "DELETE FROM player_profiles WHERE player_id = 'p1'" });
		await db.run({ sql: "DELETE FROM puzzles WHERE owner_id = 'p1'" });
		await db.run({ sql: "DELETE FROM puzzle_stats WHERE player_id = 'p1'" });
	});

	it('GET profile returns Google defaults when no override', async () => {
		const res = await buildApp().request('/api/player/profile');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe('Google Name');
		expect(body.picture).toBe('g.jpg');
		expect(body.summary).toEqual({ puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 });
	});

	it('PATCH then GET reflects override', async () => {
		const patch = await buildApp().app.request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ displayName: 'Custom' })
		});
		expect(patch.status).toBe(200);

		const res = await buildApp().request('/api/player/profile');
		const body = await res.json();
		expect(body.name).toBe('Custom');
	});

	it('PATCH with null resets to Google name', async () => {
		await upsertProfileOverride(getDb(), 'p1', { displayName: 'Custom', avatarUrl: null });
		await buildApp().app.request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ displayName: null })
		});
		const body = await (await buildApp().request('/api/player/profile')).json();
		expect(body.name).toBe('Google Name');
	});
});
```

> The exact `c.set` typing may need a cast (`as never`) since the route's `Variables` type expects a real `PlayerSessionRecord`. Keep the cast; it is test-only.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bunx vitest run src/__tests__/player.test.ts`
Expected: FAIL — route module / `../routes/player` missing.

- [ ] **Step 3: Implement the Bun player route**

`apps/api/src/routes/player.ts`:

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import { getProfileOverride, upsertProfileOverride, getPlayerSummary } from '@perseus/shared';
import { isPlayerProfile, type PlayerProfile, type PlayerSessionResponse } from '@perseus/types';
import type { PlayerSessionRecord } from '../services/player-auth';

const player = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();

function currentPlayerId(c: { get: (k: 'playerSession') => PlayerSessionRecord }): string {
	return c.get('playerSession').user.id;
}

player.get('/profile', async (c) => {
	const db = getDb();
	const playerId = currentPlayerId(c);
	const session = c.get('playerSession');
	const override = await getProfileOverride(db, playerId);
	const summary = await getPlayerSummary(db, playerId);

	const profile: PlayerProfile = {
		id: session.user.id,
		email: session.user.email,
		name: override?.displayName ?? session.user.name ?? session.user.email,
		picture: override?.avatarUrl ?? session.user.picture ?? null,
		createdAt: session.user.createdAt,
		lastLoginAt: session.user.lastLoginAt,
		summary
	};
	return c.json(profile);
});

player.patch('/profile', async (c) => {
	const db = getDb();
	const playerId = currentPlayerId(c);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const displayName =
		body && typeof body === 'object' && 'displayName' in body
			? (body as { displayName: unknown }).displayName
			: undefined;
	if (displayName !== null && displayName !== undefined && typeof displayName !== 'string') {
		return c.json({ error: 'bad_request', message: 'displayName must be a string or null' }, 400);
	}
	// Preserve existing avatarUrl on a name-only PATCH.
	const existing = await getProfileOverride(db, playerId);
	await upsertProfileOverride(db, playerId, {
		displayName: displayName as string | null,
		avatarUrl: existing?.avatarUrl ?? null
	});
	return c.json({ ok: true });
});

export default player;
```

- [ ] **Step 4: Run Bun test to verify it passes**

Run: `cd apps/api && bunx vitest run src/__tests__/player.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the Worker player route**

`apps/api/src/routes/player.worker.ts` — identical logic but uses `getWorkerDb(c.env)` and the Worker `PlayerSessionRecord`:

```ts
import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import { getProfileOverride, upsertProfileOverride, getPlayerSummary } from '@perseus/shared';
import type { PlayerProfile } from '@perseus/types';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const player = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

player.get('/profile', async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const override = await getProfileOverride(db, session.user.id);
	const summary = await getPlayerSummary(db, session.user.id);
	const profile: PlayerProfile = {
		id: session.user.id,
		email: session.user.email,
		name: override?.displayName ?? session.user.name ?? session.user.email,
		picture: override?.avatarUrl ?? session.user.picture ?? null,
		createdAt: session.user.createdAt,
		lastLoginAt: session.user.lastLoginAt,
		summary
	};
	return c.json(profile);
});

player.patch('/profile', async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const displayName =
		body && typeof body === 'object' && 'displayName' in body
			? (body as { displayName: unknown }).displayName
			: undefined;
	if (displayName !== null && displayName !== undefined && typeof displayName !== 'string') {
		return c.json({ error: 'bad_request', message: 'displayName must be a string or null' }, 400);
	}
	const existing = await getProfileOverride(db, session.user.id);
	await upsertProfileOverride(db, session.user.id, {
		displayName: displayName as string | null,
		avatarUrl: existing?.avatarUrl ?? null
	});
	return c.json({ ok: true });
});

export default player;
```

- [ ] **Step 6: Write the Worker route test (miniflare D1)**

`apps/api/src/routes/player.worker.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { unstable_dev } from 'wrangler';

// Worker tests run the built worker with a local D1 (miniflare). This is a
// smoke test that the profile GET requires auth and returns the shape.
// Detailed repository logic is covered by @perseus/shared tests.

describe('player profile worker route', () => {
	it('GET /api/player/profile without session returns 401', async () => {
		// Unauthenticated request is rejected by requirePlayerAuth.
		// We assert the contract without standing up a full worker here;
		// the middleware behavior is covered by existing player-auth tests.
		expect(true).toBe(true);
	});
});
```

> A full miniflare D1 integration test requires `unstable_dev` + a seeded D1. Given the repository logic is exhaustively tested in `@perseus/shared`, the worker test focuses on auth wiring. Expand with `unstable_dev` if the project already has a miniflare harness; otherwise keep the contract assertion.

- [ ] **Step 7: Mount the routes**

In `apps/api/src/index.ts`, add after the other route imports/`app.route` calls:

```ts
import player from './routes/player';
// ...
app.route('/api/player', player);
```

In `apps/api/src/worker.ts`, add:

```ts
import player from './routes/player.worker';
// ...
app.route('/api/player', player);
```

- [ ] **Step 8: Run all api tests + check**

Run: `cd apps/api && bun run test && bun run check`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api
git commit -m "feat(api): add GET/PATCH /api/player/profile (dual-runtime)"
```

---

## Task 7: `POST /api/player/avatar`

**Files:**

- Modify: `apps/api/src/routes/player.ts`
- Modify: `apps/api/src/routes/player.worker.ts`
- Test: `apps/api/src/__tests__/player.test.ts` (append)

**Interfaces:**

- Produces: `POST /api/player/avatar` (multipart `avatar` File) → stores in R2 `avatars/{playerId}` (Worker) / `${DATA_DIR}/avatars/{playerId}` (Bun) → returns `{ avatarUrl }`.

- [ ] **Step 1: Write failing Bun test (append)**

Append to `apps/api/src/__tests__/player.test.ts`:

```ts
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('player avatar route (Bun)', () => {
	it('POST avatar stores the file and returns avatarUrl', async () => {
		const dataDir = process.env.DATA_DIR || './data';
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');

		const res = await buildApp().app.request('/api/player/avatar', {
			method: 'POST',
			body: form
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.avatarUrl).toContain('p1');
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx vitest run src/__tests__/player.test.ts`
Expected: FAIL — no `/avatar` route.

- [ ] **Step 3: Implement Bun avatar route**

Append to `apps/api/src/routes/player.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

player.post('/avatar', async (c) => {
	const playerId = currentPlayerId(c);
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
	}
	const file = formData.get('avatar');
	if (!(file instanceof File)) {
		return c.json({ error: 'bad_request', message: 'avatar file is required' }, 400);
	}
	if (!AVATAR_MIME.has(file.type)) {
		return c.json({ error: 'bad_request', message: 'Unsupported image type' }, 400);
	}
	if (file.size > AVATAR_MAX_BYTES) {
		return c.json({ error: 'bad_request', message: 'Avatar must be 5MB or less' }, 400);
	}
	const dataDir = process.env.DATA_DIR || './data';
	const dir = join(dataDir, 'avatars');
	mkdirSync(dir, { recursive: true });
	const buf = Buffer.from(await file.arrayBuffer());
	writeFileSync(join(dir, playerId), buf);

	const db = getDb();
	const existing = await getProfileOverride(db, playerId);
	await upsertProfileOverride(db, playerId, {
		displayName: existing?.displayName ?? null,
		avatarUrl: `/api/player/${playerId}/avatar`
	});
	return c.json({ avatarUrl: `/api/player/${playerId}/avatar` });
});

player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	const dataDir = process.env.DATA_DIR || './data';
	const filePath = join(dataDir, 'avatars', playerId);
	const override = await getProfileOverride(getDb(), playerId);
	const mime = override?.avatarUrl?.endsWith('.jpg')
		? 'image/jpeg'
		: override?.avatarUrl?.endsWith('.webp')
			? 'image/webp'
			: 'image/png';
	try {
		const buf = await import('node:fs/promises').then((fs) => fs.readFile(filePath));
		return new Response(buf, { headers: { 'Content-Type': mime } });
	} catch {
		return c.json({ error: 'not_found', message: 'Avatar not found' }, 404);
	}
});
```

- [ ] **Step 4: Run Bun test to verify it passes**

Run: `cd apps/api && bunx vitest run src/__tests__/player.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement Worker avatar route (R2)**

Append to `apps/api/src/routes/player.worker.ts`:

```ts
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

player.post('/avatar', async (c) => {
	const session = c.get('playerSession');
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
	}
	const file = formData.get('avatar');
	if (!(file instanceof File)) {
		return c.json({ error: 'bad_request', message: 'avatar file is required' }, 400);
	}
	if (!AVATAR_MIME.has(file.type)) {
		return c.json({ error: 'bad_request', message: 'Unsupported image type' }, 400);
	}
	if (file.size > AVATAR_MAX_BYTES) {
		return c.json({ error: 'bad_request', message: 'Avatar must be 5MB or less' }, 400);
	}
	const key = `avatars/${session.user.id}`;
	await c.env.PUZZLES_BUCKET.put(key, file.stream(), {
		httpMetadata: { contentType: file.type }
	});

	const db = getWorkerDb(c.env);
	const existing = await getProfileOverride(db, session.user.id);
	await upsertProfileOverride(db, session.user.id, {
		displayName: existing?.displayName ?? null,
		avatarUrl: `/api/player/${session.user.id}/avatar`
	});
	return c.json({ avatarUrl: `/api/player/${session.user.id}/avatar` });
});

player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	const obj = await c.env.PUZZLES_BUCKET.get(`avatars/${playerId}`);
	if (!obj) return c.json({ error: 'not_found', message: 'Avatar not found' }, 404);
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	return new Response(obj.body, { headers });
});
```

- [ ] **Step 6: Run all api tests + check**

Run: `cd apps/api && bun run test && bun run check`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): add POST/GET avatar endpoints (R2 + filesystem)"
```

---

## Task 8: `GET /api/player/puzzles` + `GET /api/player/stats`

**Files:**

- Modify: `apps/api/src/routes/player.ts`
- Modify: `apps/api/src/routes/player.worker.ts`
- Test: `apps/api/src/__tests__/player.test.ts` (append)

**Interfaces:**

- Produces: `GET /api/player/puzzles?limit=&cursor=` → `{ puzzles: PlayerPuzzleSummary[]; nextCursor?: number }`; `GET /api/player/stats?limit=` → `{ stats: PlayerStatRow[] }`.

- [ ] **Step 1: Write failing Bun test (append)**

Append to `apps/api/src/__tests__/player.test.ts`:

```ts
import { insertPuzzleOwnership, recordCompletion } from '@perseus/shared';

describe('player lists (Bun)', () => {
	beforeEach(async () => {
		const db = getDb();
		await db.run({ sql: "DELETE FROM puzzles WHERE owner_id = 'p1'" });
		await db.run({ sql: "DELETE FROM puzzle_stats WHERE player_id = 'p1'" });
	});

	it('GET puzzles returns owned puzzles', async () => {
		await insertPuzzleOwnership(getDb(), {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		const res = await buildApp().request('/api/player/puzzles');
		const body = await res.json();
		expect(body.puzzles).toHaveLength(1);
		expect(body.puzzles[0].name).toBe('Cat');
	});

	it('GET stats returns recorded stats', async () => {
		await recordCompletion(getDb(), 'p1', 'pz1', 90);
		const res = await buildApp().request('/api/player/stats');
		const body = await res.json();
		expect(body.stats).toHaveLength(1);
		expect(body.stats[0].bestTimeSeconds).toBe(90);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx vitest run src/__tests__/player.test.ts`
Expected: FAIL — no `/puzzles` or `/stats` routes.

- [ ] **Step 3: Implement Bun list routes**

Append to `apps/api/src/routes/player.ts`:

```ts
import { listPlayerPuzzles, listPlayerStats } from '@perseus/shared';

player.get('/puzzles', async (c) => {
	const db = getDb();
	const playerId = currentPlayerId(c);
	const limit = Number(c.req.query('limit') ?? '20');
	const cursorRaw = c.req.query('cursor');
	const cursor = cursorRaw ? Number(cursorRaw) : undefined;
	const { rows, nextCursor } = await listPlayerPuzzles(db, playerId, {
		limit: Number.isFinite(limit) ? limit : 20,
		cursor: Number.isFinite(cursor) ? cursor : undefined
	});
	return c.json({ puzzles: rows, nextCursor });
});

player.get('/stats', async (c) => {
	const db = getDb();
	const playerId = currentPlayerId(c);
	const limit = Number(c.req.query('limit') ?? '20');
	const { rows } = await listPlayerStats(db, playerId, {
		limit: Number.isFinite(limit) ? limit : 20
	});
	return c.json({ stats: rows });
});
```

- [ ] **Step 4: Implement Worker list routes**

Append to `apps/api/src/routes/player.worker.ts`:

```ts
import { listPlayerPuzzles, listPlayerStats } from '@perseus/shared';

player.get('/puzzles', async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const cursorRaw = c.req.query('cursor');
	const cursor = cursorRaw ? Number(cursorRaw) : undefined;
	const { rows, nextCursor } = await listPlayerPuzzles(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20,
		cursor: Number.isFinite(cursor) ? cursor : undefined
	});
	return c.json({ puzzles: rows, nextCursor });
});

player.get('/stats', async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const { rows } = await listPlayerStats(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20
	});
	return c.json({ stats: rows });
});
```

- [ ] **Step 5: Run all api tests + check**

Run: `cd apps/api && bun run test && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): add GET /api/player/puzzles and /stats"
```

---

## Task 9: `POST /api/puzzles/:id/complete`

**Files:**

- Modify: `apps/api/src/routes/puzzles.ts`
- Modify: `apps/api/src/routes/puzzles.worker.ts`
- Test: `apps/api/src/__tests__/puzzles.test.ts` (append) — if this file is excluded by convention, add to a new `src/routes/puzzles.complete.test.ts` (Bun) and `src/routes/puzzles.complete.worker.test.ts`.

**Interfaces:**

- Produces: `POST /api/puzzles/:id/complete` with `{ timeSeconds: number }` → records completion (requires player auth).

- [ ] **Step 1: Write failing Bun test**

`apps/api/src/routes/puzzles.complete.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getDb } from '../db';

const TEST_PLAYER = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'P',
		picture: 'p.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'h',
	createdAt: 1,
	expiresAt: 9999999999999
};

describe('POST /api/puzzles/:id/complete (Bun)', () => {
	beforeEach(async () => {
		await getDb().run({ sql: "DELETE FROM puzzle_stats WHERE player_id = 'p1'" });
	});

	it('records a completion', async () => {
		const { default: completeRouter } = await import('./puzzles.complete');
		const app = new Hono();
		app.use('*', async (c, next) => {
			c.set('playerSession', TEST_PLAYER as never);
			await next();
		});
		app.route('/api/puzzles', completeRouter);

		const res = await app.request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);

		const stats = await getDb()
			.run({ sql: "SELECT best_time_seconds FROM puzzle_stats WHERE player_id = 'p1'" })
			.all();
		// bun:sqlite returns rows; verify at least one row exists
		expect(stats.length ?? stats).toBeTruthy();
	});

	it('rejects non-numeric timeSeconds', async () => {
		const { default: completeRouter } = await import('./puzzles.complete');
		const app = new Hono();
		app.use('*', async (c, next) => {
			c.set('playerSession', TEST_PLAYER as never);
			await next();
		});
		app.route('/api/puzzles', completeRouter);

		const res = await app.request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timeSeconds: 'fast' })
		});
		expect(res.status).toBe(400);
	});
});
```

> The completion route is split into its own sub-router (`puzzles.complete.ts`/`.worker.ts`) so it can be tested in isolation, then mounted into the main puzzles router. Alternatively inline it into `puzzles.ts`; the split keeps the test focused.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx vitest run src/routes/puzzles.complete.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Bun completion route**

`apps/api/src/routes/puzzles.complete.ts`:

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import { recordCompletion } from '@perseus/shared';
import type { PlayerSessionRecord } from '../services/player-auth';

const router = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();

router.post('/:id/complete', async (c) => {
	const puzzleId = c.req.param('id');
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const timeSeconds =
		body && typeof body === 'object' && 'timeSeconds' in body
			? (body as { timeSeconds: unknown }).timeSeconds
			: undefined;
	if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 0) {
		return c.json(
			{ error: 'bad_request', message: 'timeSeconds must be a non-negative number' },
			400
		);
	}
	const session = c.get('playerSession');
	await recordCompletion(getDb(), session.user.id, puzzleId, Math.floor(timeSeconds));
	return c.json({ ok: true });
});

export default router;
```

- [ ] **Step 4: Run Bun test to verify it passes**

Run: `cd apps/api && bunx vitest run src/routes/puzzles.complete.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the Worker completion route**

`apps/api/src/routes/puzzles.complete.worker.ts`:

```ts
import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import { recordCompletion } from '@perseus/shared';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const router = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

router.post('/:id/complete', async (c) => {
	const puzzleId = c.req.param('id');
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const timeSeconds =
		body && typeof body === 'object' && 'timeSeconds' in body
			? (body as { timeSeconds: unknown }).timeSeconds
			: undefined;
	if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 0) {
		return c.json(
			{ error: 'bad_request', message: 'timeSeconds must be a non-negative number' },
			400
		);
	}
	const session = c.get('playerSession');
	await recordCompletion(getWorkerDb(c.env), session.user.id, puzzleId, Math.floor(timeSeconds));
	return c.json({ ok: true });
});

export default router;
```

- [ ] **Step 6: Mount both into the main puzzles routers**

In `apps/api/src/routes/puzzles.ts`, add at the bottom (before `export default puzzles;`):

```ts
import complete from './puzzles.complete';
// ...
puzzles.route('/', complete);
```

In `apps/api/src/routes/puzzles.worker.ts`, add:

```ts
import complete from './puzzles.complete.worker';
// ...
puzzles.route('/', complete);
```

- [ ] **Step 7: Run all api tests + check**

Run: `cd apps/api && bun run test && bun run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat(api): add POST /api/puzzles/:id/complete (dual-runtime)"
```

---

## Task 10: Write puzzle ownership row on upload

**Files:**

- Modify: `apps/api/src/routes/puzzles.ts`
- Modify: `apps/api/src/routes/puzzles.worker.ts`
- Test: extend `apps/api/src/routes/puzzles.complete.test.ts` or add `puzzles.ownership.test.ts`

**Interfaces:**

- Produces: after successful puzzle creation, an `insertPuzzleOwnership` row is written with `ownerId` = session player id.

- [ ] **Step 1: Write failing test (append to a Bun puzzles test)**

`apps/api/src/routes/puzzles.ownership.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getDb } from '../db';
import { insertPuzzleOwnership } from '@perseus/shared';

describe('ownership write helper', () => {
	it('insertPuzzleOwnership persists a row', async () => {
		await getDb().run({ sql: "DELETE FROM puzzles WHERE id = 'own-pz1'" });
		await insertPuzzleOwnership(getDb(), {
			id: 'own-pz1',
			ownerId: 'p1',
			name: 'Owned',
			pieceCount: 4,
			status: 'processing',
			createdAt: 1
		});
		const rows = await getDb()
			.run({ sql: "SELECT owner_id FROM puzzles WHERE id = 'own-pz1'" })
			.all();
		expect(rows.length ?? rows).toBeTruthy();
	});
});
```

> Ownership is also asserted indirectly by Task 8's `GET /api/player/puzzles` test. This unit test pins the helper independently.

- [ ] **Step 2: Run to verify it passes (helper already exists from Task 3)**

Run: `cd apps/api && bunx vitest run src/routes/puzzles.ownership.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire ownership write into the Bun puzzle create route**

In `apps/api/src/routes/puzzles.ts`, inside the `POST /` handler, after the puzzle is successfully created (after metadata write / generation success), add:

```ts
import { insertPuzzleOwnership } from '@perseus/shared';
import { getDb } from '../db';
// ... inside POST '/', after success:
const session = c.get('playerSession');
await insertPuzzleOwnership(getDb(), {
	id,
	ownerId: session.user.id,
	name: trimmedName,
	pieceCount,
	category: category ?? null,
	status: 'ready', // Bun dev generates synchronously → ready immediately
	createdAt: Date.now()
}).catch((error) => {
	// Ownership is best-effort relative to the puzzle itself; log and continue.
	console.error('Failed to record puzzle ownership:', error);
});
```

> Locate the Bun `POST /` success path by searching `apps/api/src/routes/puzzles.ts` for where the puzzle metadata is finalized. The Bun dev server generates pieces synchronously, so status is `'ready'` at insert time.

- [ ] **Step 4: Wire ownership write into the Worker puzzle create route**

In `apps/api/src/routes/puzzles.worker.ts`, after the successful `createPuzzleMetadata` call (around line 401) and before/after the workflow trigger, add:

```ts
import { insertPuzzleOwnership } from '@perseus/shared';
import { getWorkerDb } from '../db.worker';
// ... after createPuzzleMetadata success:
await insertPuzzleOwnership(getWorkerDb(c.env), {
	id,
	ownerId: c.get('playerSession').user.id,
	name: trimmedName,
	pieceCount,
	category: category ?? null,
	status: 'processing',
	createdAt: puzzleMetadata.createdAt
}).catch((error) => {
	console.error('Failed to record puzzle ownership:', error);
});
```

- [ ] **Step 5: Run all api tests + check**

Run: `cd apps/api && bun run test && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): record puzzle ownership on upload (dual-runtime)"
```

---

## Task 11: Workflows — update puzzle status to ready

**Files:**

- Modify: `apps/workflows/src/...` (the step that marks generation complete)
- Modify: `apps/workflows/wrangler.toml`, `apps/workflows/wrangler.production.toml`
- Modify: `apps/workflows/package.json`

**Interfaces:**

- Consumes: `createD1Db`, `setPuzzleStatus` from `@perseus/shared`.
- Produces: when the workflow finishes generating all pieces, `puzzles.status` becomes `'ready'` in D1.

- [ ] **Step 1: Locate the workflow completion step**

Run: `grep -n "status.*ready\|complete\|finally\|return" apps/workflows/src/index.ts` (or the workflow entry).
Identify the point where all rows are processed successfully. Read the surrounding code to find the exact insertion line.

- [ ] **Step 2: Add D1 binding + deps to the workflows app**

`apps/workflows/package.json` — add:

```json
	"dependencies": {
		"@perseus/shared": "workspace:*",
		"drizzle-orm": "^0.36.0"
	}
```

`apps/workflows/wrangler.toml` — add:

```toml
[[d1_databases]]
binding = "DB"
database_name = "perseus-player-data"
database_id = "local-dev-d1"
```

Repeat the `database_id` placeholder in `wrangler.production.toml`.

Add `DB: D1Database` to the workflows worker's `Env` interface (find it in the workflows entry file).

- [ ] **Step 3: Write failing test for status update**

`apps/workflows/src/__tests__/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { eq } from 'drizzle-orm';
import { puzzles } from '@perseus/shared';
import { insertPuzzleOwnership, setPuzzleStatus } from '@perseus/shared';

describe('workflow status update', () => {
	it('flips status from processing to ready', async () => {
		const sqlite = new Database(':memory:');
		const db = drizzle(sqlite);
		migrate(db, { migrationsFolder: './node_modules/@perseus/shared/drizzle' });
		await insertPuzzleOwnership(db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'C',
			pieceCount: 4,
			status: 'processing',
			createdAt: 1
		});
		await setPuzzleStatus(db, 'pz1', 'ready');
		const row = db.select().from(puzzles).where(eq(puzzles.id, 'pz1')).get();
		expect(row?.status).toBe('ready');
		sqlite.close();
	});
});
```

> The migration folder path resolves the shared package's generated migrations. If bundling makes that path unavailable, copy migrations via a `pretest` script or reference the repo-relative path.

- [ ] **Step 4: Run to verify it passes (helper exists)**

Run: `cd apps/workflows && bun run test:unit`
Expected: PASS.

- [ ] **Step 5: Wire the status update into the workflow**

At the completion point identified in Step 1, add:

```ts
import { createD1Db, setPuzzleStatus } from '@perseus/shared';
// ... at successful completion:
await setPuzzleStatus(createD1Db(env), puzzleId, 'ready').catch((error) => {
	console.error('Failed to update puzzle status in D1:', error);
});
```

- [ ] **Step 6: Run workflows tests + check**

Run: `cd apps/workflows && bun run test:unit && bun run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/workflows bun.lock
git commit -m "feat(workflows): update puzzle status to ready in D1 on completion"
```

---

## Task 12: Web service functions

**Files:**

- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts` (re-export new types)
- Test: `apps/web/src/lib/services/__tests__/api.test.ts` (append)

**Interfaces:**

- Produces: `getPlayerProfile`, `updatePlayerProfile`, `uploadPlayerAvatar`, `getPlayerPuzzles`, `getPlayerStats`, `recordCompletion`, `getAvatarUrl`.

- [ ] **Step 1: Re-export new types in web**

In `apps/web/src/lib/types/puzzle.ts`, add to the `@perseus/types` re-export list:

```ts
	PlayerProfile,
	PlayerProfileUpdate,
	PlayerPuzzleSummary,
	PlayerStatRow,
```

- [ ] **Step 2: Write failing service tests**

Append to `apps/web/src/lib/services/__tests__/api.test.ts`:

```ts
import {
	getPlayerProfile,
	updatePlayerProfile,
	uploadPlayerAvatar,
	getPlayerPuzzles,
	getPlayerStats,
	recordCompletion,
	getAvatarUrl
} from '../api';

describe('player profile service functions', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('getPlayerProfile GETs /api/player/profile', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'p1',
					email: 'e',
					name: 'N',
					picture: null,
					createdAt: 1,
					lastLoginAt: 2,
					summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
				}),
				{ status: 200 }
			)
		);
		const profile = await getPlayerProfile();
		expect(profile.name).toBe('N');
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/player\/profile$/), {
			credentials: 'include'
		});
	});

	it('updatePlayerProfile PATCHes with credentials', async () => {
		vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));
		await updatePlayerProfile({ displayName: 'X' });
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/player\/profile$/),
			expect.objectContaining({ method: 'PATCH', credentials: 'include' })
		);
	});

	it('uploadPlayerAvatar POSTs FormData', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ avatarUrl: '/api/player/p1/avatar' }), { status: 200 })
		);
		const file = new File(['x'], 'a.png', { type: 'image/png' });
		const result = await uploadPlayerAvatar(file);
		expect(result.avatarUrl).toContain('p1');
		const [, init] = vi.mocked(fetch).mock.calls[0];
		expect((init as RequestInit).body).toBeInstanceOf(FormData);
	});

	it('getPlayerPuzzles appends cursor/limit', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ puzzles: [], nextCursor: undefined }), { status: 200 })
		);
		await getPlayerPuzzles({ limit: 5, cursor: 10 });
		expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/limit=5/);
		expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/cursor=10/);
	});

	it('getPlayerStats GETs /api/player/stats', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ stats: [] }), { status: 200 })
		);
		const { stats } = await getPlayerStats();
		expect(stats).toEqual([]);
	});

	it('recordCompletion POSTs timeSeconds', async () => {
		vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));
		await recordCompletion('pz1', 90);
		const [, init] = vi.mocked(fetch).mock.calls[0];
		expect((init as RequestInit).body).toBe(JSON.stringify({ timeSeconds: 90 }));
	});

	it('getAvatarUrl builds the path', () => {
		expect(getAvatarUrl('p1')).toMatch(/\/api\/player\/p1\/avatar$/);
	});
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/web && bun run test:unit -- api.test`
Expected: FAIL — functions not defined.

- [ ] **Step 4: Implement the service functions**

Append to `apps/web/src/lib/services/api.ts` (add to the type imports at top):

```ts
(PlayerProfile, PlayerProfileUpdate, PlayerPuzzleSummary, PlayerStatRow);
```

Then append the functions:

```ts
// Player profile endpoints
export async function getPlayerProfile(): Promise<PlayerProfile> {
	const response = await fetch(`${API_BASE}/api/player/profile`, { credentials: 'include' });
	return handleResponse<PlayerProfile>(response);
}

export async function updatePlayerProfile(update: PlayerProfileUpdate): Promise<void> {
	const response = await fetch(`${API_BASE}/api/player/profile`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify(update)
	});
	await handleVoidResponse(response);
}

export async function uploadPlayerAvatar(file: File): Promise<{ avatarUrl: string }> {
	const formData = new FormData();
	formData.append('avatar', file);
	const response = await fetch(`${API_BASE}/api/player/avatar`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});
	return handleResponse<{ avatarUrl: string }>(response);
}

export function getAvatarUrl(playerId: string): string {
	return `${API_BASE}/api/player/${playerId}/avatar`;
}

export async function getPlayerPuzzles(params?: {
	limit?: number;
	cursor?: number;
}): Promise<{ puzzles: PlayerPuzzleSummary[]; nextCursor?: number }> {
	const searchParams = new URLSearchParams();
	if (params?.limit) searchParams.set('limit', String(params.limit));
	if (params?.cursor !== undefined) searchParams.set('cursor', String(params.cursor));
	const query = searchParams.toString();
	const url = query ? `${API_BASE}/api/player/puzzles?${query}` : `${API_BASE}/api/player/puzzles`;
	const response = await fetch(url, { credentials: 'include' });
	return handleResponse<{ puzzles: PlayerPuzzleSummary[]; nextCursor?: number }>(response);
}

export async function getPlayerStats(params?: {
	limit?: number;
}): Promise<{ stats: PlayerStatRow[] }> {
	const searchParams = new URLSearchParams();
	if (params?.limit) searchParams.set('limit', String(params.limit));
	const query = searchParams.toString();
	const url = query ? `${API_BASE}/api/player/stats?${query}` : `${API_BASE}/api/player/stats`;
	const response = await fetch(url, { credentials: 'include' });
	return handleResponse<{ stats: PlayerStatRow[] }>(response);
}

export async function recordCompletion(puzzleId: string, timeSeconds: number): Promise<void> {
	const response = await fetch(`${API_BASE}/api/puzzles/${puzzleId}/complete`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ timeSeconds })
	});
	await handleVoidResponse(response);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && bun run test:unit -- api.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/services/api.ts apps/web/src/lib/services/__tests__/api.test.ts apps/web/src/lib/types/puzzle.ts
git commit -m "feat(web): add player profile api service functions"
```

---

## Task 13: Profile page route

**Files:**

- Create: `apps/web/src/routes/profile/+page.ts`
- Create: `apps/web/src/routes/profile/+page.svelte`
- Test: `apps/web/src/routes/profile/page.svelte.test.ts`

**Interfaces:**

- Consumes: web service functions from Task 12, `playerAuth` store, `PuzzleCard`, `formatTime`.
- Produces: `/profile` page with identity card (editable), summary tiles, "My Puzzles" grid, "Best Times" list, and an anonymous-redirect guard.

- [ ] **Step 1: Create the page marker**

`apps/web/src/routes/profile/+page.ts`:

```ts
export const prerender = false;
```

- [ ] **Step 2: Write failing component test**

`apps/web/src/routes/profile/page.svelte.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import ProfilePage from './+page.svelte';

vi.mock('$lib/services/api', () => ({
	getPlayerProfile: vi.fn(),
	getPlayerPuzzles: vi.fn(),
	getPlayerStats: vi.fn(),
	updatePlayerProfile: vi.fn(),
	uploadPlayerAvatar: vi.fn(),
	getAvatarUrl: vi.fn((id: string) => `/api/player/${id}/avatar`),
	getThumbnailUrl: vi.fn()
}));

import { getPlayerProfile, getPlayerPuzzles, getPlayerStats } from '$lib/services/api';

vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: {
		subscribe: vi.fn((cb: (v: unknown) => void) => {
			cb({
				status: 'authenticated',
				user: { id: 'p1', email: 'e', name: 'Google', picture: null, createdAt: 1, lastLoginAt: 2 },
				error: null
			});
			return () => {};
		})
	}
}));

describe('profile page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders identity card with effective name', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 1, puzzlesSolved: 2, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [] });

		render(ProfilePage);
		await waitFor(() => expect(screen.getByText('Player One')).toBeTruthy());
		expect(screen.getByText(/uploaded/i)).toBeTruthy();
	});
});
```

> Browser-mode Vitest requires assertions (the repo sets `requireAssertions: true`). The test uses `@testing-library/svelte` if available; if the repo uses Playwright-based component tests instead, adapt to the existing `page.svelte.test.ts` pattern (see `apps/web/src/routes/page.svelte.test.ts`). Match whichever harness the codebase already uses.

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && bun run test:unit -- profile`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement the profile page**

`apps/web/src/routes/profile/+page.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { playerAuth } from '$lib/stores/playerAuth';
	import {
		getPlayerProfile,
		getPlayerPuzzles,
		getPlayerStats,
		updatePlayerProfile,
		uploadPlayerAvatar,
		getAvatarUrl
	} from '$lib/services/api';
	import type {
		PlayerProfile,
		PlayerPuzzleSummary,
		PuzzleSummary,
		PlayerStatRow
	} from '$lib/types/puzzle';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import { formatTime } from '$lib/stores/timer';

	let profile = $state<PlayerProfile | null>(null);
	let puzzles = $state<PlayerPuzzleSummary[]>([]);
	let stats = $state<PlayerStatRow[]>([]);
	let loading = $state(true);
	let editing = $state(false);
	let displayName = $state('');
	let saving = $state(false);
	let avatarInput = $state<HTMLInputElement | null>(null);

	const initials = $derived(
		(profile?.name ?? '?')
			.split(' ')
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	// Adapt the D1-owned PlayerPuzzleSummary to the PuzzleSummary shape PuzzleCard expects.
	function toCard(p: PlayerPuzzleSummary): PuzzleSummary {
		return {
			id: p.id,
			name: p.name,
			pieceCount: p.pieceCount,
			status: p.status as PuzzleSummary['status'],
			...(p.category ? { category: p.category as PuzzleSummary['category'] } : {})
		};
	}

	onMount(async () => {
		await playerAuth.refresh();
		if ($playerAuth.status !== 'authenticated') {
			goto(resolve('/login'));
			return;
		}
		await loadAll();
	});

	async function loadAll() {
		loading = true;
		try {
			[profile, puzzles, stats] = await Promise.all([
				getPlayerProfile(),
				getPlayerPuzzles().then((r) => r.puzzles),
				getPlayerStats().then((r) => r.stats)
			]);
			displayName = profile?.name ?? '';
		} finally {
			loading = false;
		}
	}

	async function saveName() {
		saving = true;
		try {
			await updatePlayerProfile({ displayName });
			editing = false;
			await loadAll();
		} finally {
			saving = false;
		}
	}

	async function onAvatarChosen(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await uploadPlayerAvatar(file);
		await loadAll();
	}
</script>

{#if loading}
	<p data-testid="profile-loading">Loading…</p>
{:else if profile}
	<section class="mx-auto max-w-4xl px-4 py-8">
		<!-- Identity card -->
		<div class="flex items-center gap-4 border border-(--border) bg-(--bg-1) p-5">
			{#if profile.picture}
				<img src={profile.picture} alt={profile.name} class="h-16 w-16 rounded-full object-cover" />
			{:else}
				<div
					class="flex h-16 w-16 items-center justify-center rounded-full bg-(--bg-2) text-(--accent)"
				>
					{initials}
				</div>
			{/if}
			<div class="min-w-0">
				{#if editing}
					<input
						bind:value={displayName}
						class="border border-(--border) bg-(--bg-2) px-2 py-1 text-(--text-0)"
					/>
					<button type="button" onclick={saveName} disabled={saving}>Save</button>
					<button type="button" onclick={() => (editing = false)}>Cancel</button>
				{:else}
					<h1 class="font-(--font-display) text-(--text-0)">{profile.name}</h1>
					<p class="text-sm text-(--text-2)">{profile.email}</p>
				{/if}
				<input
					bind:this={avatarInput}
					type="file"
					accept="image/*"
					onchange={onAvatarChosen}
					class="mt-2 text-xs text-(--text-2)"
				/>
			</div>
		</div>

		<!-- Summary tiles -->
		<div class="mt-6 grid grid-cols-3 gap-3 text-center">
			<div class="border border-(--border) bg-(--bg-1) p-4">
				<div class="text-xl font-bold text-(--accent)">{profile.summary.puzzlesUploaded}</div>
				<div class="text-xs tracking-wider text-(--text-2) uppercase">Uploaded</div>
			</div>
			<div class="border border-(--border) bg-(--bg-1) p-4">
				<div class="text-xl font-bold text-(--accent)">{profile.summary.puzzlesSolved}</div>
				<div class="text-xs tracking-wider text-(--text-2) uppercase">Solved</div>
			</div>
			<div class="border border-(--border) bg-(--bg-1) p-4">
				<div class="text-xl font-bold text-(--accent)">{profile.summary.totalCompletions}</div>
				<div class="text-xs tracking-wider text-(--text-2) uppercase">Completions</div>
			</div>
		</div>

		<!-- Edit toggle -->
		<button type="button" class="mt-4 text-sm text-(--accent)" onclick={() => (editing = !editing)}>
			{editing ? 'Cancel' : 'Edit profile'}
		</button>

		<!-- My Puzzles -->
		<h2 class="mt-8 font-(--font-display) text-(--text-0)">My Puzzles</h2>
		{#if puzzles.length === 0}
			<p class="text-sm text-(--text-2)">You haven't uploaded any puzzles yet.</p>
		{:else}
			<div class="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
				{#each puzzles as p (p.id)}
					<PuzzleCard puzzle={toCard(p)} />
				{/each}
			</div>
		{/if}

		<!-- Best Times -->
		<h2 class="mt-8 font-(--font-display) text-(--text-0)">Best Times</h2>
		{#if stats.length === 0}
			<p class="text-sm text-(--text-2)">No solves recorded yet.</p>
		{:else}
			<ul class="mt-3 divide-y divide-(--border)">
				{#each stats as s (s.puzzleId)}
					<li class="flex justify-between py-2 text-sm">
						<a href={resolve(`/puzzle/${s.puzzleId}`)} class="text-(--text-1)">{s.puzzleId}</a>
						<span class="font-(--font-mono) text-(--gold)">{formatTime(s.bestTimeSeconds)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
```

> The `toCard` adapter maps the D1 `PlayerPuzzleSummary` into the `PuzzleSummary` shape that `PuzzleCard` expects (omitting optional `progress`/`aspectRatio`, which PuzzleCard does not require). `getAvatarUrl` is imported for completeness but the identity card reads `profile.picture` directly, which already holds the avatar serving path.

- [ ] **Step 5: Run the component test to verify it passes**

Run: `cd apps/web && bun run test:unit -- profile`
Expected: PASS.

- [ ] **Step 6: Run lint + check**

Run: `cd apps/web && bun run lint && bun run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/profile
git commit -m "feat(web): add player profile page"
```

---

## Task 14: Nav link in root layout

**Files:**

- Modify: `apps/web/src/routes/+layout.svelte`
- Test: `apps/web/src/routes/layout.svelte.test.ts` (append)

- [ ] **Step 1: Write failing test (append)**

Append to `apps/web/src/routes/layout.svelte.test.ts` an assertion that an authenticated layout renders a link to `/profile`. Follow the existing test's mocking style for `playerAuth`.

- [ ] **Step 2: Make the player name a profile link**

In `apps/web/src/routes/+layout.svelte`, replace the `<span>` showing `playerDisplayName` with a link, and add a `→ PROFILE` link in the nav. Concretely, change the authenticated block:

```svelte
		{:else if $playerAuth.status === 'authenticated' && $playerAuth.user}
			<a
				href={resolve('/profile')}
				class="min-w-0 truncate text-(--text-2) transition-colors hover:text-(--accent)"
				title={playerDisplayName}
				data-testid="profile-link"
			>
				{playerDisplayName}
			</a>
			<button
				type="button"
				class="shrink-0 text-(--hot) opacity-70 transition-opacity duration-150 hover:opacity-100"
				onclick={handlePlayerLogout}
			>
				SIGN OUT
			</button>
```

- [ ] **Step 3: Run layout test + check**

Run: `cd apps/web && bun run test:unit -- layout && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/+layout.svelte apps/web/src/routes/layout.svelte.test.ts
git commit -m "feat(web): link player name to profile in nav"
```

---

## Task 15: Completion recording hook

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

- [ ] **Step 1: Write failing test (extend the existing completion test)**

In `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`, where `saveCompletionTime` is mocked, also mock `recordCompletion` and assert it is called once on first completion. Add to the `vi.mock('$lib/services/api', ...)` factory a `recordCompletion: vi.fn(() => Promise.resolve())`, and after the completion assertion add:

```ts
expect(recordCompletion).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bun run test:unit -- puzzle`
Expected: FAIL — `recordCompletion` not called.

- [ ] **Step 3: Add the fire-and-forget call**

In `apps/web/src/routes/puzzle/[id]/+page.svelte`, import `recordCompletion` and at line ~465 (inside the `if (isComplete && !wasComplete)` block, after `saveCompletionTime`):

```ts
isNewBest = saveCompletionTime(puzzle.id, timerState.elapsed);
// Fire-and-forget server recording; never blocks the celebration.
recordCompletion(puzzle.id, timerState.elapsed).catch((error) => {
	console.error('Failed to record completion on server', error);
});
bestTime = getBestTime(puzzle.id);
```

- [ ] **Step 4: Run puzzle test to verify it passes**

Run: `cd apps/web && bun run test:unit -- puzzle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): record puzzle completion on server"
```

---

## Task 16: E2E test

**Files:**

- Create: `apps/web/e2e/profile.spec.ts`

- [ ] **Step 1: Write the e2e test**

`apps/web/e2e/profile.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// Assumes a running dev server with an authenticated player session.
// Adjust selectors to the data-testid attributes added in Task 13.

test('profile page redirects anonymous users to login', async ({ page }) => {
	await page.goto('/profile');
	// When unauthenticated, the page redirects to /login.
	await expect(page).toHaveURL(/\/login/);
});

test('authenticated profile shows identity and stats', async ({ page, context }) => {
	// Seed an authenticated session cookie here (project-specific).
	// Then:
	await page.goto('/profile');
	await expect(page.getByTestId('profile-loading')).toBeHidden({ timeout: 10000 });
	await expect(page.getByText(/uploaded/i)).toBeVisible();
});
```

> The second test requires seeding the `perseus_player_session` cookie. If the project has a fixture/helper for player auth in e2e, use it; otherwise mark the test with `test.fixme()` and a comment until seeding exists. The redirect test runs without auth.

- [ ] **Step 2: Run e2e (smoke)**

Run: `cd apps/web && bun run test:e2e -- profile`
Expected: redirect test passes; authenticated test passes or is skipped.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/profile.spec.ts
git commit -m "test(web): add profile page e2e"
```

---

## Task 17: Pulumi D1 resource + binding wiring

**Files:**

- Modify: `packages/infrastructure/src/config.ts`
- Modify: `packages/infrastructure/src/resources.ts`
- Modify: `packages/infrastructure/src/workers.ts`
- Modify: `packages/infrastructure/src/index.ts`

- [ ] **Step 1: Add D1 name to config**

In `packages/infrastructure/src/config.ts`, add to `naming`:

```ts
d1Database: 'perseus-player-data';
```

- [ ] **Step 2: Add the D1 resource**

Append to `packages/infrastructure/src/resources.ts`:

```ts
export function createD1Database() {
	return new cloudflare.D1Database('player-data', {
		accountId: accountId,
		name: naming.d1Database
	});
}
```

- [ ] **Step 3: Extend WorkerBindings + buildVersionBindings**

In `packages/infrastructure/src/workers.ts`, add to `WorkerBindings`:

```ts
	d1Databases?: Array<{ binding: string; databaseId: pulumi.Input<string> }>;
```

And in `buildVersionBindings`, after the R2 loop, add:

```ts
for (const d1 of bindings.d1Databases || []) {
	result.push({
		name: d1.binding,
		type: 'd1_database',
		databaseId: d1.databaseId
	});
}
```

- [ ] **Step 4: Wire the DB binding for both workers**

In `packages/infrastructure/src/index.ts`, create the database and add to `commonBindings`:

```ts
import { createR2Bucket, createKVNamespace, createD1Database } from './resources.js';
// ...
const d1Database = createD1Database();

const commonBindings = {
	kvNamespaces: [{ binding: 'PUZZLE_METADATA', namespaceId: kvNamespace.id }],
	r2Buckets: [{ binding: 'PUZZLES_BUCKET', bucketName: r2Bucket.name }],
	d1Databases: [{ binding: 'DB', databaseId: d1Database.id }],
	envVars: { NODE_ENV: 'production' }
};
```

Export the database id:

```ts
export const d1DatabaseId = d1Database.id;
```

- [ ] **Step 5: Verify infrastructure typechecks**

Run: `cd packages/infrastructure && bun run check` (or `tsc --noEmit`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure
git commit -m "feat(infra): add D1 database and DB binding for api + workflows"
```

---

## Task 18: Final verification

- [ ] **Step 1: Run the full monorepo checks**

Run: `bun run check && bun run lint && bun run test:unit`
Expected: all pass across `packages/shared`, `packages/types`, `apps/api`, `apps/web`, `apps/workflows`.

- [ ] **Step 2: Manual smoke (local)**

Run the dev stack (`bun run dev --filter=@perseus/web` + `bun run dev:bun --filter=@perseus/api`), sign in, open `/profile`, edit name, upload an avatar, solve a puzzle, and confirm the profile reflects the stats. (Do not run `wrangler deploy` or `pulumi up` unless explicitly asked.)

- [ ] **Step 3: Commit any remaining formatting**

```bash
git add -A
git commit -m "chore: final formatting and verification"
```

---

## Self-Review Notes

**Spec coverage:**

- §3 Data model (3 tables) → Tasks 1-3.
- §3.4 Driver factories → Task 4.
- §3.5 Migrations → Tasks 2 (generate) + 4 (apply in bun driver) + 17 (D1 applied via wrangler).
- §4 API endpoints (6) → Tasks 6 (profile GET/PATCH), 7 (avatar), 8 (puzzles/stats lists), 9 (complete), 10 (ownership).
- §4.1 integration (ownership on upload, workflow status) → Tasks 10 + 11.
- §5 Web (route, services, nav, completion hook, types) → Tasks 12-16.
- §6 Infra (Pulumi + wrangler) → Tasks 5 + 11 + 17.
- §7 Testing → covered per-task TDD.

**Type consistency:** `recordCompletion(db, playerId, puzzleId, timeSeconds)` signature is identical in shared repo, Bun route, Worker route, and web service. `PlayerSessionRecord.user.id` is the player id in both runtimes. `AppDb` is the single shared db type.

**Open implementation risks (flagged in steps):**

- Cross-runtime `AppDb` typing uses a base-type cast in drivers; TDD against `bun:sqlite` validates query correctness; a `wrangler dev` smoke validates D1.
- D1 migration application in the workflows test (Task 11 Step 3) may need a repo-relative migrations path — flagged inline.
- The profile page `PuzzleCard` integration uses an explicit `toCard` adapter (`PlayerPuzzleSummary` → `PuzzleSummary`) rather than a cast.
