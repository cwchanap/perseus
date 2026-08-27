import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import {
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	playerAchievements,
	playerCompletionUsage,
	playerDifficultyCompletions,
	playerProfiles,
	playerVariantMastery,
	puzzleBestTimes,
	puzzleCompletionRuns,
	puzzleDeletionTombstones,
	puzzleFamilies
} from '../schema';

describe('schema tables', () => {
	it('keeps a drizzle snapshot for every journal entry', () => {
		const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
			entries: Array<{ idx: number; tag: string }>;
		};
		for (const entry of journal.entries) {
			const snapshotPath = `./drizzle/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`;
			expect(existsSync(snapshotPath)).toBe(true);
		}
		const latest = journal.entries[journal.entries.length - 1];
		expect(latest.tag).toBe('0006_puzzle_progression_reset');
		const latestSnapshot = JSON.parse(
			readFileSync('./drizzle/meta/0006_snapshot.json', 'utf8')
		) as {
			prevId: string;
		};
		const previousSnapshot = JSON.parse(
			readFileSync('./drizzle/meta/0005_snapshot.json', 'utf8')
		) as {
			id: string;
		};
		expect(latestSnapshot.prevId).toBe(previousSnapshot.id);
		const snapshotChecks = latestSnapshot as {
			tables: {
				puzzle_best_times: { checkConstraints: Record<string, { value: string }> };
				puzzle_completion_runs: { checkConstraints: Record<string, { value: string }> };
			};
		};
		expect(
			snapshotChecks.tables.puzzle_best_times.checkConstraints.pbt_best_time_seconds_check.value
		).toBe('"puzzle_best_times"."best_time_seconds" BETWEEN 1 AND 86400');
		expect(
			snapshotChecks.tables.puzzle_completion_runs.checkConstraints.pcr_elapsed_active_seconds_check
				.value
		).toContain('BETWEEN 1 AND 86400');
	});

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

	const familyId = '123e4567-e89b-42d3-a456-426614174000';
	const variantId = '223e4567-e89b-42d3-a456-426614174001';

	it('creates progression tables without puzzle_variants or legacy puzzles', () => {
		const { sqlite } = makeDb();
		const tableNames = sqlite
			.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[];
		expect(tableNames.map((table) => table.name)).toEqual(
			expect.arrayContaining([
				'player_achievements',
				'player_completion_usage',
				'player_difficulty_completions',
				'player_profiles',
				'player_variant_mastery',
				'puzzle_best_times',
				'puzzle_completion_runs',
				'puzzle_deletion_tombstones',
				'puzzle_families'
			])
		);
		expect(tableNames.map((table) => table.name)).not.toContain('puzzle_variants');
		expect(tableNames.map((table) => table.name)).not.toContain('puzzles');
		expect(tableNames.map((table) => table.name)).not.toContain('puzzle_stats');
		sqlite.close();
	});

	it('stores completion runs with family/difficulty facts and no timing_quality column', () => {
		const { db, sqlite } = makeDb();
		const columns = sqlite.query("PRAGMA table_info('puzzle_completion_runs')").all() as {
			name: string;
		}[];
		expect(columns.map((column) => column.name)).toEqual([
			'player_id',
			'run_id',
			'puzzle_id',
			'family_id',
			'difficulty',
			'result_class',
			'elapsed_active_seconds',
			'hints_used',
			'incorrect_attempts',
			'completed_at'
		]);
		expect(columns.map((column) => column.name)).not.toContain('timing_quality');

		const run = {
			playerId: 'p1',
			runId: 'run-1',
			puzzleId: variantId,
			familyId,
			difficulty: 'easy',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90,
			hintsUsed: 1,
			incorrectAttempts: 2,
			completedAt: 1
		};
		db.insert(puzzleCompletionRuns).values(run).run();
		expect(
			db.select().from(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.playerId, 'p1')).get()
		).toMatchObject(run);
		sqlite.close();
	});

	it('enforces the bounded completion contract without timing_quality', () => {
		const { db, sqlite } = makeDb();
		const run = {
			playerId: 'p1',
			runId: 'run-1',
			puzzleId: variantId,
			familyId,
			difficulty: 'easy',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90,
			hintsUsed: 0,
			incorrectAttempts: 0,
			completedAt: 1
		};
		const insert = (overrides: Partial<typeof run>) =>
			db
				.insert(puzzleCompletionRuns)
				.values({ ...run, ...overrides })
				.run();

		expect(() => insert({ resultClass: 'invalid' })).toThrow();
		expect(() => insert({ difficulty: 'invalid' })).toThrow();
		expect(() => insert({ elapsedActiveSeconds: undefined })).toThrow();
		expect(() => insert({ hintsUsed: -1 })).toThrow();
		expect(() => insert({ incorrectAttempts: -1 })).toThrow();
		expect(() =>
			insert({
				resultClass: 'relaxed',
				elapsedActiveSeconds: undefined
			})
		).not.toThrow();
		expect(() => insert({ runId: 'run-2', elapsedActiveSeconds: 86_400 })).not.toThrow();
		sqlite.close();
	});

	it('keys puzzle_best_times by player, variant, and competitive mode', () => {
		const { db, sqlite } = makeDb();
		const row = {
			playerId: 'p1',
			puzzleId: variantId,
			familyId,
			difficulty: 'normal',
			resultClass: 'rotation_timed',
			bestTimeSeconds: 75,
			achievedAt: 10
		};
		db.insert(puzzleBestTimes).values(row).run();
		expect(db.select().from(puzzleBestTimes).get()).toMatchObject(row);
		expect(() =>
			db
				.insert(puzzleBestTimes)
				.values({ ...row, resultClass: 'assisted_timed' })
				.run()
		).toThrow();
		expect(() => db.insert(puzzleBestTimes).values(row).run()).toThrow();
		sqlite.close();
	});

	it('awards unique clears once per player/family/difficulty', () => {
		const { db, sqlite } = makeDb();
		const row = {
			playerId: 'p1',
			familyId,
			difficulty: 'hard',
			firstCompletedAt: 100
		};
		db.insert(playerDifficultyCompletions).values(row).run();
		expect(() => db.insert(playerDifficultyCompletions).values(row).run()).toThrow();
		expect(() =>
			db
				.insert(playerDifficultyCompletions)
				.values({ ...row, difficulty: 'easy', firstCompletedAt: 200 })
				.run()
		).not.toThrow();
		sqlite.close();
	});

	it('keys achievements and mastery badges by player and award id', () => {
		const { db, sqlite } = makeDb();
		db.insert(playerAchievements)
			.values({ playerId: 'p1', achievementId: 'first_clear', unlockedAt: 1 })
			.run();
		db.insert(playerVariantMastery)
			.values({ playerId: 'p1', puzzleId: variantId, badge: 'hintless', earnedAt: 2 })
			.run();
		expect(() =>
			db
				.insert(playerAchievements)
				.values({ playerId: 'p1', achievementId: 'first_clear', unlockedAt: 9 })
				.run()
		).toThrow();
		expect(() =>
			db
				.insert(playerVariantMastery)
				.values({ playerId: 'p1', puzzleId: variantId, badge: 'hintless', earnedAt: 9 })
				.run()
		).toThrow();
		sqlite.close();
	});

	it('creates completion ledger indexes in the required column order', () => {
		const { sqlite } = makeDb();
		const indexes = sqlite.query("PRAGMA index_list('puzzle_completion_runs')").all() as {
			name: string;
		}[];
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining([
				'idx_pcr_player_puzzle_completed',
				'idx_pcr_puzzle',
				'idx_pcr_family'
			])
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

			sqlite.exec(`
				INSERT INTO puzzle_completion_runs
					(player_id, run_id, puzzle_id, result_class, timing_quality, elapsed_active_seconds, completed_at)
				VALUES
					('p1', 'p1-run-1', 'pz1', 'standard_timed', 'known', 60, 1),
					('p1', 'p1-run-2', 'pz2', 'standard_timed', 'known', 61, 2),
					('p2', 'p2-run-1', 'pz1', 'standard_timed', 'known', 62, 3),
					('p2', 'p2-run-2', 'pz2', 'standard_timed', 'known', 63, 4),
					('p2', 'p2-run-3', 'pz3', 'standard_timed', 'known', 64, 5);
			`);

			migrate(db, { migrationsFolder: './drizzle' });

			const tableNames = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[];
			expect(tableNames.map((table) => table.name)).toEqual(
				expect.arrayContaining(['player_completion_usage', 'puzzle_deletion_tombstones'])
			);
			expect(tableNames.map((table) => table.name)).not.toContain('puzzles');
			expect(tableNames.map((table) => table.name)).not.toContain('puzzle_stats');

			const triggerNames = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
				.all() as { name: string }[];
			expect(triggerNames.map((trigger) => trigger.name)).toEqual(
				expect.arrayContaining([
					'decrement_player_completion_usage',
					'guard_player_variant_mastery_not_tombstoned_insert',
					'guard_player_variant_mastery_not_tombstoned_update',
					'guard_puzzle_best_times_not_tombstoned_insert',
					'guard_puzzle_best_times_not_tombstoned_update',
					'guard_puzzle_completion_run_quota',
					'guard_puzzle_completion_runs_not_tombstoned_insert',
					'guard_puzzle_completion_runs_not_tombstoned_update',
					'increment_player_completion_usage'
				])
			);

			const usage = db
				.select()
				.from(playerCompletionUsage)
				.orderBy(playerCompletionUsage.playerId)
				.all();
			expect(usage).toEqual([]);
			sqlite.close();
		} finally {
			rmSync(migrationsFolder, { recursive: true, force: true });
		}
	});

	it('exercises the quota-trigger body with a small-threshold trigger and matching rows', () => {
		const { db, sqlite } = makeDb();

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
			puzzleId: variantId,
			familyId,
			difficulty: 'easy',
			resultClass: 'standard_timed' as const,
			elapsedActiveSeconds: 60,
			hintsUsed: 0,
			incorrectAttempts: 0
		};

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

		expect(() =>
			db
				.insert(puzzleCompletionRuns)
				.values({ ...baseRun, runId: 'run-4', completedAt: 4 })
				.run()
		).toThrow(/completion_quota_exceeded/);

		sqlite.exec(`
			INSERT INTO puzzle_completion_runs (
				player_id, run_id, puzzle_id, family_id, difficulty, result_class,
				elapsed_active_seconds, hints_used, incorrect_attempts, completed_at
			)
			VALUES ('p1', 'run-1', '${variantId}', '${familyId}', 'easy', 'standard_timed', 60, 0, 0, 99)
			ON CONFLICT (player_id, run_id) DO NOTHING;
		`);

		expect(
			sqlite.query("SELECT COUNT(*) AS n FROM puzzle_completion_runs WHERE player_id = 'p1'").get()
		).toEqual({ n: 3 });
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
		const destructiveMatches =
			migrationSql.match(/\b(?:ALTER|DROP|RENAME)\s+(?:TABLE|INDEX|TRIGGER)\b/gi) ?? [];
		expect(destructiveMatches).toEqual(['DROP TABLE']);
		expect(migrationSql).toMatch(/DROP TABLE `completion_usage_backfill_guard`/);
		expect(statements).toHaveLength(15);
		expect(triggers).toHaveLength(9);
	});

	it('keeps migration 0005 additive and pins puzzle_families ownership schema', () => {
		const migrationSql = readFileSync('./drizzle/0005_puzzle_families.sql', 'utf8');
		expect(migrationSql).toContain('puzzle_families');
		expect(migrationSql).not.toContain('puzzle_variants');
	});

	it('resets completion usage in migration 0006 while preserving profiles and families', () => {
		const migrationSql = readFileSync('./drizzle/0006_puzzle_progression_reset.sql', 'utf8');
		expect(migrationSql).toContain('DELETE FROM `puzzle_completion_runs`');
		expect(migrationSql).toContain('DELETE FROM `player_completion_usage`');
		expect(migrationSql).toContain('DROP TABLE IF EXISTS `puzzles`');
		expect(migrationSql).toContain('DROP TABLE IF EXISTS `puzzle_stats`');
		expect(migrationSql).toContain('puzzle_best_times');
		expect(migrationSql).toContain('player_difficulty_completions');
		expect(migrationSql).toContain('player_achievements');
		expect(migrationSql).toContain('player_variant_mastery');
		expect(migrationSql).not.toContain('timing_quality');
		expect(migrationSql).not.toContain('puzzle_variants');

		const { db, sqlite } = makeDb();
		db.insert(playerProfiles).values({ playerId: 'p1', displayName: 'Player', updatedAt: 1 }).run();
		db.insert(puzzleFamilies)
			.values({
				id: familyId,
				ownerId: 'p1',
				name: 'Family',
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: 1
			})
			.run();

		const profile = db.select().from(playerProfiles).get();
		const family = db.select().from(puzzleFamilies).get();
		const usage = db.select().from(playerCompletionUsage).all();
		expect(profile?.displayName).toBe('Player');
		expect(family?.name).toBe('Family');
		expect(usage).toEqual([]);
		sqlite.close();
	});

	it('rebuilds exact grouped usage and removes stale zero-ledger rows', () => {
		const { db, sqlite } = makeDb();
		db.insert(puzzleCompletionRuns)
			.values([
				{
					playerId: 'p1',
					runId: 'run-1',
					puzzleId: variantId,
					familyId,
					difficulty: 'easy',
					resultClass: 'standard_timed',
					elapsedActiveSeconds: 60,
					hintsUsed: 0,
					incorrectAttempts: 0,
					completedAt: 1
				},
				{
					playerId: 'p1',
					runId: 'run-2',
					puzzleId: 'pz2',
					familyId,
					difficulty: 'easy',
					resultClass: 'standard_timed',
					elapsedActiveSeconds: 61,
					hintsUsed: 0,
					incorrectAttempts: 0,
					completedAt: 2
				},
				{
					playerId: 'p2',
					runId: 'run-1',
					puzzleId: variantId,
					familyId,
					difficulty: 'easy',
					resultClass: 'standard_timed',
					elapsedActiveSeconds: 62,
					hintsUsed: 0,
					incorrectAttempts: 0,
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
});
