import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	playerCompletionUsage,
	playerProfiles,
	puzzleCompletionRuns,
	puzzleDeletionTombstones,
	puzzleStats,
	puzzles
} from '../schema';

describe('schema tables', () => {
	function makeDb() {
		const sqlite = new Database(':memory:');
		const db = drizzle(sqlite);
		migrate(db, { migrationsFolder: './drizzle' });
		return { db, sqlite };
	}

	function reconcileCompletionUsage(sqlite: Database) {
		const reconciliationSql = readFileSync(
			'./drizzle/maintenance/reconcile_completion_usage.sql',
			'utf8'
		);
		const statements = reconciliationSql
			.split(';')
			.map((statement) => statement.trim())
			.filter(Boolean);

		try {
			for (const statement of statements) {
				sqlite.run(statement);
			}
		} catch (error) {
			try {
				sqlite.exec('ROLLBACK;');
			} catch {
				// Transaction may have already been rolled back by SQLite
			}
			throw error;
		}
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

	it('stores completion runs with a player-scoped run ID', () => {
		const { db, sqlite } = makeDb();
		const run = {
			playerId: 'p1',
			runId: 'run-1',
			puzzleId: 'pz1',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 90,
			completedAt: 1
		};
		db.insert(puzzleCompletionRuns).values(run).run();

		const stored = db
			.select()
			.from(puzzleCompletionRuns)
			.where(eq(puzzleCompletionRuns.playerId, 'p1'))
			.get();
		expect(stored).toMatchObject(run);

		expect(() => db.insert(puzzleCompletionRuns).values(run).run()).toThrow();
		expect(() =>
			db
				.insert(puzzleCompletionRuns)
				.values({ ...run, playerId: 'p2' })
				.run()
		).not.toThrow();
		sqlite.close();
	});

	it('enforces the bounded completion contract', () => {
		const { db, sqlite } = makeDb();
		const run = {
			playerId: 'p1',
			runId: 'run-1',
			puzzleId: 'pz1',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 90,
			completedAt: 1
		};
		const insert = (overrides: Partial<typeof run>) =>
			db
				.insert(puzzleCompletionRuns)
				.values({ ...run, ...overrides })
				.run();

		expect(() => insert({ resultClass: 'invalid' })).toThrow();
		expect(() => insert({ timingQuality: 'invalid' })).toThrow();
		expect(() => insert({ elapsedActiveSeconds: undefined })).toThrow();
		expect(() => insert({ elapsedActiveSeconds: 0 })).toThrow();
		expect(() => insert({ elapsedActiveSeconds: 1.5 })).toThrow();
		expect(() => insert({ elapsedActiveSeconds: 86_401 })).toThrow();
		expect(() => insert({ resultClass: 'relaxed' })).toThrow();
		expect(() => insert({ timingQuality: 'legacy_unknown' })).toThrow();
		expect(() =>
			insert({
				resultClass: 'relaxed',
				timingQuality: 'legacy_unknown',
				elapsedActiveSeconds: undefined
			})
		).toThrow();
		expect(() =>
			insert({
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: undefined
			})
		).not.toThrow();
		expect(() =>
			insert({
				runId: 'run-2',
				resultClass: 'rotation_timed',
				timingQuality: 'legacy_unknown',
				elapsedActiveSeconds: undefined
			})
		).not.toThrow();
		expect(() => insert({ runId: 'run-3', elapsedActiveSeconds: 86_400 })).not.toThrow();
		sqlite.close();
	});

	it('creates completion ledger indexes in the required column order', () => {
		const { sqlite } = makeDb();
		const indexes = sqlite.query("PRAGMA index_list('puzzle_completion_runs')").all() as {
			name: string;
		}[];
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining(['idx_pcr_player_puzzle_completed', 'idx_pcr_puzzle'])
		);

		const compositeIndex = sqlite
			.query("PRAGMA index_info('idx_pcr_player_puzzle_completed')")
			.all() as { name: string }[];
		expect(compositeIndex.map((column) => column.name)).toEqual([
			'player_id',
			'puzzle_id',
			'completed_at'
		]);
		sqlite.close();
	});

	it('applies the deletion fence and quota migration with a complete backfill', () => {
		const migrationsFolder = mkdtempSync(join(tmpdir(), 'perseus-migrations-'));
		const metaFolder = join(migrationsFolder, 'meta');
		mkdirSync(metaFolder);

		try {
			const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
				entries: { idx: number }[];
			};
			journal.entries = journal.entries.filter((entry) => entry.idx <= 3);
			writeFileSync(join(metaFolder, '_journal.json'), JSON.stringify(journal));

			for (const migration of [
				'0000_true_fantastic_four.sql',
				'0001_avatar_updated_at.sql',
				'0002_avatar_update_token.sql',
				'0003_puzzle_completion_runs.sql'
			]) {
				cpSync(join('./drizzle', migration), join(migrationsFolder, migration));
			}

			const sqlite = new Database(':memory:');
			const db = drizzle(sqlite);
			migrate(db, { migrationsFolder });

			const preMigrationTables = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[];
			expect(preMigrationTables.map((table) => table.name)).not.toContain(
				'player_completion_usage'
			);

			db.insert(puzzleCompletionRuns)
				.values([
					{
						playerId: 'p1',
						runId: 'p1-run-1',
						puzzleId: 'pz1',
						resultClass: 'standard_timed',
						timingQuality: 'known',
						elapsedActiveSeconds: 60,
						completedAt: 1
					},
					{
						playerId: 'p1',
						runId: 'p1-run-2',
						puzzleId: 'pz2',
						resultClass: 'standard_timed',
						timingQuality: 'known',
						elapsedActiveSeconds: 61,
						completedAt: 2
					},
					{
						playerId: 'p2',
						runId: 'p2-run-1',
						puzzleId: 'pz1',
						resultClass: 'standard_timed',
						timingQuality: 'known',
						elapsedActiveSeconds: 62,
						completedAt: 3
					},
					{
						playerId: 'p2',
						runId: 'p2-run-2',
						puzzleId: 'pz2',
						resultClass: 'standard_timed',
						timingQuality: 'known',
						elapsedActiveSeconds: 63,
						completedAt: 4
					},
					{
						playerId: 'p2',
						runId: 'p2-run-3',
						puzzleId: 'pz3',
						resultClass: 'standard_timed',
						timingQuality: 'known',
						elapsedActiveSeconds: 64,
						completedAt: 5
					}
				])
				.run();

			migrate(db, { migrationsFolder: './drizzle' });

			const tableNames = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[];
			expect(tableNames.map((table) => table.name)).toEqual(
				expect.arrayContaining(['player_completion_usage', 'puzzle_deletion_tombstones'])
			);

			const triggerNames = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
				.all() as { name: string }[];
			expect(triggerNames.map((trigger) => trigger.name)).toEqual([
				'decrement_player_completion_usage',
				'guard_puzzle_completion_run_quota',
				'guard_puzzle_completion_runs_not_tombstoned_insert',
				'guard_puzzle_completion_runs_not_tombstoned_update',
				'guard_puzzle_stats_not_tombstoned_insert',
				'guard_puzzle_stats_not_tombstoned_update',
				'guard_puzzles_not_tombstoned_insert',
				'guard_puzzles_not_tombstoned_update',
				'increment_player_completion_usage'
			]);
			const updateTriggerSql = sqlite
				.query(
					"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%not_tombstoned_update' ORDER BY name"
				)
				.all() as { name: string; sql: string }[];
			expect(updateTriggerSql).toHaveLength(3);
			for (const trigger of updateTriggerSql) {
				expect(trigger.sql).toContain('OLD.');
				expect(trigger.sql).toContain('NEW.');
				expect(trigger.sql).toContain('puzzle_deletion_tombstones');
			}

			const usage = db
				.select()
				.from(playerCompletionUsage)
				.orderBy(playerCompletionUsage.playerId)
				.all();
			expect(usage).toEqual([
				{ playerId: 'p1', retainedRuns: 2 },
				{ playerId: 'p2', retainedRuns: 3 }
			]);

			expect(() =>
				db.insert(playerCompletionUsage).values({ playerId: 'negative', retainedRuns: -1 }).run()
			).toThrow();
			expect(() =>
				db
					.insert(playerCompletionUsage)
					.values({ playerId: 'over-limit', retainedRuns: 100_001 })
					.run()
			).toThrow();
			expect(() =>
				db
					.insert(puzzleDeletionTombstones)
					.values({ puzzleId: 'deleted-puzzle', deletedAt: 1 })
					.run()
			).not.toThrow();
			sqlite.close();
		} finally {
			rmSync(migrationsFolder, { recursive: true, force: true });
		}
	});

	it('exercises the quota-trigger body with a small-threshold trigger and matching rows', () => {
		const { db, sqlite } = makeDb();

		// Replace the production trigger (threshold 100_000) with an
		// equivalent small-threshold trigger (threshold 3) so the body
		// can be exercised without inserting 100_000 rows.
		sqlite.exec('DROP TRIGGER guard_puzzle_completion_run_quota;');
		sqlite.exec(`
			CREATE TRIGGER guard_puzzle_completion_run_quota
			BEFORE INSERT ON puzzle_completion_runs
			WHEN NOT EXISTS (
				SELECT 1
				FROM puzzle_completion_runs
				WHERE player_id = NEW.player_id
					AND run_id = NEW.run_id
			)
			AND COALESCE(
				(
					SELECT retained_runs
					FROM player_completion_usage
					WHERE player_id = NEW.player_id
				),
				0
			) >= 3
			BEGIN
				SELECT RAISE(ABORT, 'completion_quota_exceeded');
			END;
		`);

		const baseRun = {
			playerId: 'p1',
			puzzleId: 'pz1',
			resultClass: 'standard_timed' as const,
			timingQuality: 'known' as const,
			elapsedActiveSeconds: 60
		};

		// Insert 3 distinct runs — the increment trigger keeps usage in sync.
		for (let i = 1; i <= 3; i++) {
			expect(() =>
				db
					.insert(puzzleCompletionRuns)
					.values({ ...baseRun, runId: `run-${i}`, completedAt: i })
					.run()
			).not.toThrow();
		}
		expect(
			sqlite.query("SELECT retained_runs FROM player_completion_usage WHERE player_id = 'p1'").get()
		).toEqual({ retained_runs: 3 });

		// A 4th distinct run fires the trigger body: RAISE(ABORT).
		expect(() =>
			db
				.insert(puzzleCompletionRuns)
				.values({ ...baseRun, runId: 'run-4', completedAt: 4 })
				.run()
		).toThrow(/completion_quota_exceeded/);

		// The rejected insert did not create a row or change usage.
		expect(
			sqlite.query("SELECT COUNT(*) AS n FROM puzzle_completion_runs WHERE player_id = 'p1'").get()
		).toEqual({ n: 3 });
		expect(
			sqlite.query("SELECT retained_runs FROM player_completion_usage WHERE player_id = 'p1'").get()
		).toEqual({ retained_runs: 3 });

		// Existing-run exemption: a duplicate run_id at quota does NOT fire
		// the trigger (the WHEN NOT EXISTS clause is false) and succeeds via
		// ON CONFLICT DO NOTHING — matching the executor's replay path.
		sqlite.exec(`
			INSERT INTO puzzle_completion_runs (
				player_id, run_id, puzzle_id, result_class,
				timing_quality, elapsed_active_seconds, completed_at
			)
			VALUES ('p1', 'run-1', 'pz1', 'standard_timed', 'known', 60, 99)
			ON CONFLICT (player_id, run_id) DO NOTHING;
		`);

		// No new row, no usage increment — the replay is a no-op.
		expect(
			sqlite.query("SELECT COUNT(*) AS n FROM puzzle_completion_runs WHERE player_id = 'p1'").get()
		).toEqual({ n: 3 });
		expect(
			sqlite.query("SELECT retained_runs FROM player_completion_usage WHERE player_id = 'p1'").get()
		).toEqual({ retained_runs: 3 });

		sqlite.close();
	});

	it('keeps migration 0004 additive and safely breakpoint-delimited', () => {
		const migrationSql = readFileSync('./drizzle/0004_puzzle_deletion_fence.sql', 'utf8');
		const statements = migrationSql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		const triggers = statements.filter((statement) => statement.startsWith('CREATE TRIGGER'));

		expect(migrationSql).toContain('100000');
		// No destructive ops on existing tables/indexes/triggers. The only
		// DROP TABLE allowed is the temp backfill guard created earlier in
		// the same migration (self-contained, not an existing asset).
		const destructiveMatches =
			migrationSql.match(/\b(?:ALTER|DROP|RENAME)\s+(?:TABLE|INDEX|TRIGGER)\b/gi) ?? [];
		expect(destructiveMatches).toEqual(['DROP TABLE']);
		expect(migrationSql).toMatch(/DROP TABLE `completion_usage_backfill_guard`/);
		expect(statements).toHaveLength(15);
		expect(triggers).toHaveLength(9);
		expect(triggers.every((trigger) => trigger.includes('BEGIN') && trigger.endsWith('END;'))).toBe(
			true
		);

		const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
			entries: { idx: number; tag: string }[];
		};
		const snapshot = JSON.parse(readFileSync('./drizzle/meta/0004_snapshot.json', 'utf8')) as {
			tables: Record<string, unknown>;
		};
		expect(journal.entries).toContainEqual({
			idx: 4,
			version: '6',
			when: expect.any(Number),
			tag: '0004_puzzle_deletion_fence',
			breakpoints: true
		});
		expect(snapshot.tables).toHaveProperty('player_completion_usage');
		expect(snapshot.tables).toHaveProperty('puzzle_deletion_tombstones');
	});

	it('aborts migration 0004 backfill when a player exceeds the retained_runs cap and leaves no guard table', () => {
		// Apply 0000-0003 only, then load 100001 runs for one player before
		// running 0004. The guard-table preflight must abort before the real
		// usage table is touched, and the temp guard must not survive.
		const migrationsFolder = mkdtempSync(join(tmpdir(), 'migrations-oversize-'));
		try {
			const metaDir = join(migrationsFolder, 'meta');
			mkdirSync(metaDir, { recursive: true });
			const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
				entries: { idx: number }[];
			};
			journal.entries = journal.entries.filter((entry) => entry.idx <= 3);
			writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journal));
			for (const migration of [
				'0000_true_fantastic_four.sql',
				'0001_avatar_updated_at.sql',
				'0002_avatar_update_token.sql',
				'0003_puzzle_completion_runs.sql'
			]) {
				cpSync(join('./drizzle', migration), join(migrationsFolder, migration));
			}

			const sqlite = new Database(':memory:');
			const db = drizzle(sqlite);
			migrate(db, { migrationsFolder });

			// Insert 100001 distinct runs for one player via raw batched
			// exec (drizzle's parameterized insert would exceed SQLite's
			// 32766-variable limit for a single statement).
			sqlite.exec('BEGIN');
			for (let batchStart = 0; batchStart <= 100_000; batchStart += 500) {
				const batchEnd = Math.min(batchStart + 500, 100_001);
				const values: string[] = [];
				for (let i = batchStart; i < batchEnd; i++) {
					values.push(`('over','run-${i}','pz','standard_timed','known',1,${i})`);
				}
				sqlite.exec(
					`INSERT INTO puzzle_completion_runs ` +
						`(player_id, run_id, puzzle_id, result_class, timing_quality, ` +
						`elapsed_active_seconds, completed_at) VALUES ${values.join(',')};`
				);
			}
			sqlite.exec('COMMIT');

			// Running 0004 must throw because the guard-table INSERT violates
			// the retained_runs CHECK (100001 > 100000). The sync dialect
			// wraps each migrate() call in BEGIN/COMMIT, so the failed
			// migration rolls back every 0004 statement — neither the real
			// usage table nor the guard survives.
			expect(() => migrate(db, { migrationsFolder: './drizzle' })).toThrow();

			const tables = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[];
			expect(tables.map((t) => t.name)).not.toContain('completion_usage_backfill_guard');
			expect(tables.map((t) => t.name)).not.toContain('player_completion_usage');
			sqlite.close();
		} finally {
			rmSync(migrationsFolder, { recursive: true, force: true });
		}
	});

	it('rebuilds exact grouped usage and removes stale zero-ledger rows', () => {
		const { db, sqlite } = makeDb();
		db.insert(puzzleCompletionRuns)
			.values([
				{
					playerId: 'p1',
					runId: 'run-1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 60,
					completedAt: 1
				},
				{
					playerId: 'p1',
					runId: 'run-2',
					puzzleId: 'pz2',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 61,
					completedAt: 2
				},
				{
					playerId: 'p2',
					runId: 'run-1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 62,
					completedAt: 3
				}
			])
			.run();
		sqlite.run("UPDATE player_completion_usage SET retained_runs = 99 WHERE player_id = 'p1'");
		db.insert(playerCompletionUsage).values({ playerId: 'stale', retainedRuns: 1 }).run();

		reconcileCompletionUsage(sqlite);

		expect(
			db.select().from(playerCompletionUsage).orderBy(playerCompletionUsage.playerId).all()
		).toEqual([
			{ playerId: 'p1', retainedRuns: 2 },
			{ playerId: 'p2', retainedRuns: 1 }
		]);
		sqlite.close();
	});

	it('is idempotent when it rebuilds completion usage twice', () => {
		const { db, sqlite } = makeDb();
		db.insert(puzzleCompletionRuns)
			.values({
				playerId: 'p1',
				runId: 'run-1',
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 60,
				completedAt: 1
			})
			.run();

		reconcileCompletionUsage(sqlite);
		const firstRebuild = db.select().from(playerCompletionUsage).all();
		reconcileCompletionUsage(sqlite);

		expect(db.select().from(playerCompletionUsage).all()).toEqual(firstRebuild);
		sqlite.close();
	});

	it('rolls back an oversized reconciliation before changing usage or leaving a guard table', () => {
		const { db, sqlite } = makeDb();
		db.insert(playerCompletionUsage).values({ playerId: 'unchanged', retainedRuns: 4 }).run();
		sqlite.exec('DROP TRIGGER guard_puzzle_completion_run_quota;');
		sqlite.exec('DROP TRIGGER increment_player_completion_usage;');
		sqlite.exec(`
			WITH RECURSIVE run_numbers(value) AS (
				VALUES(1)
				UNION ALL
				SELECT value + 1 FROM run_numbers WHERE value < 100001
			)
			INSERT INTO puzzle_completion_runs (
				player_id,
				run_id,
				puzzle_id,
				result_class,
				timing_quality,
				elapsed_active_seconds,
				completed_at
			)
			SELECT
				'oversized',
				'run-' || value,
				'pz1',
				'relaxed',
				'known',
				NULL,
				value
			FROM run_numbers;
		`);
		expect(
			sqlite
				.query(
					"SELECT COUNT(*) AS retained_runs FROM puzzle_completion_runs WHERE player_id = 'oversized'"
				)
				.get()
		).toEqual({ retained_runs: 100_001 });

		expect(() => reconcileCompletionUsage(sqlite)).toThrow(/CHECK constraint failed/);
		expect(db.select().from(playerCompletionUsage).all()).toEqual([
			{ playerId: 'unchanged', retainedRuns: 4 }
		]);
		expect(
			sqlite
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'completion_usage_reconcile_guard'"
				)
				.all()
		).toEqual([]);
		sqlite.close();
	});

	it('allows ledger deletion when a player has no usage row', () => {
		const { db, sqlite } = makeDb();
		db.insert(puzzleCompletionRuns)
			.values({
				playerId: 'p1',
				runId: 'run-1',
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 60,
				completedAt: 1
			})
			.run();
		db.delete(playerCompletionUsage).where(eq(playerCompletionUsage.playerId, 'p1')).run();

		expect(() =>
			db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.playerId, 'p1')).run()
		).not.toThrow();
		expect(db.select().from(puzzleCompletionRuns).all()).toEqual([]);
		expect(db.select().from(playerCompletionUsage).all()).toEqual([]);
		sqlite.close();
	});

	it('keeps migration 0005 additive and pins puzzle_families ownership schema', () => {
		const migrationSql = readFileSync('./drizzle/0005_puzzle_families.sql', 'utf8');
		const statements = migrationSql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);

		expect(migrationSql).toContain('puzzle_families');
		expect(migrationSql).toContain('owner_id');
		expect(migrationSql).toContain('aspect_ratio');
		expect(migrationSql).not.toContain('piece_count');
		expect(migrationSql).not.toContain('puzzle_variants');
		const destructiveMatches =
			migrationSql.match(/\b(?:ALTER|DROP|RENAME)\s+(?:TABLE|INDEX|TRIGGER)\b/gi) ?? [];
		expect(destructiveMatches).toEqual([]);

		const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
			entries: { idx: number; tag: string }[];
		};
		const snapshot = JSON.parse(readFileSync('./drizzle/meta/0005_snapshot.json', 'utf8')) as {
			tables: Record<string, unknown>;
		};
		expect(journal.entries).toContainEqual({
			idx: 5,
			version: '6',
			when: expect.any(Number),
			tag: '0005_puzzle_families',
			breakpoints: true
		});
		expect(snapshot.tables).toHaveProperty('puzzle_families');
		expect(statements.length).toBeGreaterThan(0);
	});
});
