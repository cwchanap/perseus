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

	it('keeps migration 0004 additive and safely breakpoint-delimited', () => {
		const migrationSql = readFileSync('./drizzle/0004_puzzle_deletion_fence.sql', 'utf8');
		const statements = migrationSql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		const triggers = statements.filter((statement) => statement.startsWith('CREATE TRIGGER'));

		expect(migrationSql).toContain('100000');
		expect(migrationSql).not.toMatch(/\b(?:ALTER|DROP|RENAME)\s+(?:TABLE|INDEX|TRIGGER)\b/i);
		expect(statements).toHaveLength(12);
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
});
