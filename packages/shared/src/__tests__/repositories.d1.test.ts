import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Miniflare } from 'miniflare';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { createD1CompletionWriteExecutor, createD1Db, type D1AppDb } from '../drivers/d1';
import { completionFactsMatch, type VersionedCompletionWrite } from '../completion-writes';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	clearProfileAvatarUrl,
	clearProfileAvatarUrlIfOwned,
	getAvatarTokensByPlayerIds,
	recordVersionedCompletion,
	listPlayerStats,
	getPlayerSummary,
	InvalidPlayerStatsCursorError,
	deletePuzzleStats,
	insertPuzzleFamilyOwnership,
	ensurePuzzleFamilyOwnership,
	deletePuzzleFamilyOwnership,
	setPuzzleFamilyStatus,
	listPlayerPuzzleFamilies,
	SYSTEM_OWNER_ID
} from '../repositories';

const PLACEHOLDER_FAMILY_ID = '00000000-0000-4000-8000-000000000001';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../drizzle');
// Load the full Drizzle migration set in numeric order so the test schema
// stays aligned with production. Hardcoding a single migration file would
// silently drift as new numbered migrations are added (the meta/ dir holds
// journal/snapshot files, not .sql, so it's excluded by the filter).
const migrationSql = readdirSync(migrationsDir)
	.filter((f) => /^\d{4}_.*\.sql$/u.test(f))
	.sort()
	.map((f) => readFileSync(join(migrationsDir, f), 'utf-8'))
	.join('\n');

let mf: Miniflare;
let db: D1AppDb;
let d1: D1Database;

beforeAll(async () => {
	mf = new Miniflare({
		modules: [{ type: 'ESModule', path: 'index.js', contents: 'export default {}' }],
		d1Databases: ['DB'],
		compatibilityDate: '2024-12-30'
	});
	d1 = await mf.getD1Database('DB');
	// Split on drizzle's statement-breakpoint marker and execute each
	// statement individually via prepare().run() — miniflare's D1 exec()
	// has edge cases with statement parsing, so we use the lower-level API.
	for (const stmt of migrationSql.split('--> statement-breakpoint')) {
		const trimmed = stmt.trim();
		if (trimmed) await d1.prepare(trimmed).run();
	}
	db = createD1Db({ DB: d1 });
}, 30_000);

afterAll(async () => {
	await mf.dispose();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM puzzle_completion_runs').run();
	await d1.prepare('DELETE FROM puzzle_best_times').run();
	await d1.prepare('DELETE FROM player_difficulty_completions').run();
	await d1.prepare('DELETE FROM player_achievements').run();
	await d1.prepare('DELETE FROM player_variant_mastery').run();
	await d1.prepare('DELETE FROM puzzle_families').run();
	await d1.prepare('DELETE FROM player_profiles').run();
	await d1.prepare('DELETE FROM player_completion_usage').run();
	await d1.prepare('DELETE FROM puzzle_deletion_tombstones').run();
});

function completion(overrides: Partial<RecordPuzzleCompletionV1> = {}): RecordPuzzleCompletionV1 {
	return {
		version: 1,
		runId: 'run-1',
		resultClass: 'standard_timed',
		elapsedActiveSeconds: 100,
		...overrides
	};
}

type StoredRunFixture = {
	playerId: string;
	runId: string;
	puzzleId: string;
	resultClass: 'standard_timed' | 'rotation_timed' | 'assisted_timed' | 'relaxed';
	elapsedActiveSeconds: number | null;
	completedAt: number;
};

async function insertStoredRun(db: D1AppDb, row: StoredRunFixture) {
	await db.run(sql`
		INSERT INTO puzzle_completion_runs
			(player_id, run_id, puzzle_id, family_id, difficulty, result_class,
			 elapsed_active_seconds, hints_used, incorrect_attempts, completed_at)
		VALUES (${row.playerId}, ${row.runId}, ${row.puzzleId}, ${PLACEHOLDER_FAMILY_ID}, 'easy',
			${row.resultClass}, ${row.elapsedActiveSeconds}, 0, 0, ${row.completedAt})
	`);
}

function standardBest(row: {
	playerId: string;
	puzzleId: string;
	bestTimeSeconds: number;
	achievedAt: number;
}) {
	return {
		playerId: row.playerId,
		puzzleId: row.puzzleId,
		familyId: PLACEHOLDER_FAMILY_ID,
		difficulty: 'easy',
		resultClass: 'standard_timed' as const,
		bestTimeSeconds: row.bestTimeSeconds,
		achievedAt: row.achievedAt
	};
}

async function selectRunFacts(db: D1AppDb) {
	return db
		.select({
			playerId: schema.puzzleCompletionRuns.playerId,
			runId: schema.puzzleCompletionRuns.runId,
			puzzleId: schema.puzzleCompletionRuns.puzzleId,
			resultClass: schema.puzzleCompletionRuns.resultClass,
			elapsedActiveSeconds: schema.puzzleCompletionRuns.elapsedActiveSeconds,
			completedAt: schema.puzzleCompletionRuns.completedAt
		})
		.from(schema.puzzleCompletionRuns);
}

describe('player profiles against real D1', () => {
	it('getProfileOverride returns null when absent', async () => {
		expect(await getProfileOverride(db, 'p1')).toBeNull();
	});

	it('updateProfileDisplayName preserves an existing avatarUrl', async () => {
		await updateProfileAvatarUrl(db, 'p1', 'avatar-url');
		await updateProfileDisplayName(db, 'p1', 'Name');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.displayName).toBe('Name');
		expect(row?.avatarUrl).toBe('avatar-url');
	});

	it('updateProfileAvatarUrl preserves an existing displayName', async () => {
		await updateProfileDisplayName(db, 'p1', 'Name');
		await updateProfileAvatarUrl(db, 'p1', 'avatar-url');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.displayName).toBe('Name');
		expect(row?.avatarUrl).toBe('avatar-url');
	});

	it('updateProfileDisplayName resets to null when passed null', async () => {
		await updateProfileDisplayName(db, 'p1', 'A');
		await updateProfileAvatarUrl(db, 'p1', 'u');
		await updateProfileDisplayName(db, 'p1', null);
		const row = await getProfileOverride(db, 'p1');
		expect(row?.displayName).toBeNull();
		expect(row?.avatarUrl).toBe('u');
	});

	it('clearProfileAvatarUrl nulls avatarUrl while preserving displayName', async () => {
		await updateProfileDisplayName(db, 'p1', 'Name');
		await updateProfileAvatarUrl(db, 'p1', 'avatar-url');
		await clearProfileAvatarUrl(db, 'p1');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.avatarUrl).toBeNull();
		expect(row?.displayName).toBe('Name');
	});

	it('clearProfileAvatarUrl on a fresh profile inserts a null-avatar row', async () => {
		await clearProfileAvatarUrl(db, 'p1');
		const row = await getProfileOverride(db, 'p1');
		expect(row).toBeDefined();
		expect(row?.avatarUrl).toBeNull();
	});

	it('clearProfileAvatarUrlIfOwned nulls avatarUrl when avatarUpdateToken matches', async () => {
		await updateProfileAvatarUrl(db, 'p1', 'avatar-url', 1000, 'token-A');
		await clearProfileAvatarUrlIfOwned(db, 'p1', 'token-A');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.avatarUrl).toBeNull();
	});

	it('clearProfileAvatarUrlIfOwned is a no-op when avatarUpdateToken differs (concurrent overwrite)', async () => {
		await updateProfileAvatarUrl(db, 'p1', 'avatar-B', 1000, 'token-B');
		await updateProfileAvatarUrl(db, 'p1', 'avatar-C', 2000, 'token-C');
		await clearProfileAvatarUrlIfOwned(db, 'p1', 'token-B');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.avatarUrl).toBe('avatar-C');
	});

	it('clearProfileAvatarUrlIfOwned is a no-op when two uploads share the same millisecond but different tokens', async () => {
		await updateProfileAvatarUrl(db, 'p1', 'avatar-A', 1000, 'token-A');
		await updateProfileAvatarUrl(db, 'p1', 'avatar-B', 1000, 'token-B');
		await clearProfileAvatarUrlIfOwned(db, 'p1', 'token-A');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.avatarUrl).toBe('avatar-B');
	});

	it('clearProfileAvatarUrlIfOwned clears avatar after displayName update changed updatedAt', async () => {
		await updateProfileAvatarUrl(db, 'p1', 'avatar-url', 1000, 'token-X');
		await updateProfileDisplayName(db, 'p1', 'New Name');
		await clearProfileAvatarUrlIfOwned(db, 'p1', 'token-X');
		const row = await getProfileOverride(db, 'p1');
		expect(row?.avatarUrl).toBeNull();
		expect(row?.displayName).toBe('New Name');
	});

	it('clearProfileAvatarUrlIfOwned is a no-op when no row exists', async () => {
		await clearProfileAvatarUrlIfOwned(db, 'p1', 'token-none');
		const row = await getProfileOverride(db, 'p1');
		expect(row).toBeNull();
	});

	it('getAvatarTokensByPlayerIds returns empty Map for empty input', async () => {
		const result = await getAvatarTokensByPlayerIds(db, []);
		expect(result.size).toBe(0);
	});

	it('getAvatarTokensByPlayerIds returns tokens for players with profiles', async () => {
		await updateProfileAvatarUrl(db, 'p1', 'url-1', 1000, 'token-A');
		await updateProfileAvatarUrl(db, 'p2', 'url-2', 2000, 'token-B');
		const result = await getAvatarTokensByPlayerIds(db, ['p1', 'p2', 'p3']);
		expect(result.get('p1')).toBe('token-A');
		expect(result.get('p2')).toBe('token-B');
		expect(result.has('p3')).toBe(false);
	});

	it('getAvatarTokensByPlayerIds returns null for players with null token', async () => {
		await updateProfileDisplayName(db, 'p1', 'Name');
		const result = await getAvatarTokensByPlayerIds(db, ['p1']);
		expect(result.get('p1')).toBeNull();
	});

	it('getAvatarTokensByPlayerIds chunks >100 players to stay under D1 bound param limit', async () => {
		const playerIds: string[] = [];
		for (let i = 0; i < 120; i++) {
			const id = `player-${i}`;
			playerIds.push(id);
			await updateProfileAvatarUrl(db, id, `url-${i}`, i * 1000, `token-${i}`);
		}
		playerIds.push('no-profile-1', 'no-profile-2');
		const result = await getAvatarTokensByPlayerIds(db, playerIds);
		expect(result.size).toBe(120);
		for (let i = 0; i < 120; i++) {
			expect(result.get(`player-${i}`)).toBe(`token-${i}`);
		}
		expect(result.has('no-profile-1')).toBe(false);
		expect(result.has('no-profile-2')).toBe(false);
	});
});

describe('tombstone-guarded table protection against real D1', () => {
	it('rejects direct inserts and updates for every tombstone-guarded table', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await executor.write({
			playerId: 'p1',
			puzzleId: 'pz1',
			runId: 'run-1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 100,
			receivedAt: 1_000
		});
		await db.insert(schema.playerVariantMastery).values({
			playerId: 'p1',
			puzzleId: 'pz1',
			badge: 'speed',
			earnedAt: 1_500
		});
		await executor.beginPuzzleDeletion('pz1', 2_000);

		await expect(
			db.insert(schema.puzzleBestTimes).values({
				playerId: 'p2',
				puzzleId: 'pz1',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 80,
				achievedAt: 2_000
			})
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db
				.update(schema.puzzleBestTimes)
				.set({ bestTimeSeconds: 50 })
				.where(eq(schema.puzzleBestTimes.puzzleId, 'pz1'))
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db
				.update(schema.puzzleBestTimes)
				.set({ puzzleId: 'pz2' })
				.where(eq(schema.puzzleBestTimes.puzzleId, 'pz1'))
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db.insert(schema.playerVariantMastery).values({
				playerId: 'p2',
				puzzleId: 'pz1',
				badge: 'speed',
				earnedAt: 2_000
			})
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db
				.update(schema.playerVariantMastery)
				.set({ earnedAt: 3_000 })
				.where(eq(schema.playerVariantMastery.puzzleId, 'pz1'))
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db
				.update(schema.playerVariantMastery)
				.set({ puzzleId: 'pz2' })
				.where(eq(schema.playerVariantMastery.puzzleId, 'pz1'))
		).rejects.toThrow('puzzle_deleted');
		await expect(
			d1
				.prepare(
					`
					INSERT INTO puzzle_completion_runs (
						player_id, run_id, puzzle_id, family_id, difficulty, result_class,
						elapsed_active_seconds, hints_used, incorrect_attempts, completed_at
					) VALUES ('p2', 'run-2', 'pz1', ?, 'easy', 'standard_timed', 80, 0, 0, 2000)
				`
				)
				.bind(PLACEHOLDER_FAMILY_ID)
				.run()
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db
				.update(schema.puzzleCompletionRuns)
				.set({ completedAt: 3_000 })
				.where(eq(schema.puzzleCompletionRuns.puzzleId, 'pz1'))
		).rejects.toThrow('puzzle_deleted');
		await expect(
			db
				.update(schema.puzzleCompletionRuns)
				.set({ puzzleId: 'pz2' })
				.where(eq(schema.puzzleCompletionRuns.puzzleId, 'pz1'))
		).rejects.toThrow('puzzle_deleted');
	});
});

describe('completionFactsMatch', () => {
	it('matches stored facts without timing quality', () => {
		const input: VersionedCompletionWrite = {
			playerId: 'p1',
			puzzleId: 'pz1',
			runId: 'run-1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 100,
			receivedAt: 1_000
		};

		// Migration 0003 makes an isolated schema-valid timing mismatch impossible:
		// timing quality determines elapsed nullability. Fabricate stored facts
		// to isolate the comparator.
		expect(
			completionFactsMatch(input, {
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			})
		).toBe(true);
	});
});

describe('recordVersionedCompletion against real D1', () => {
	it('stores a first run, replays it exactly, and keeps usage stable on conflict', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		const input: VersionedCompletionWrite = {
			playerId: 'p1',
			puzzleId: 'pz1',
			runId: 'run-1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 100,
			receivedAt: 1_000
		};

		expect(await executor.write(input)).toEqual({
			status: 'stored',
			stored: {
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			},
			inserted: true
		});
		expect(await db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 1 }
		]);

		expect(await executor.write({ ...input, receivedAt: 9_000 })).toEqual({
			status: 'stored',
			stored: {
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			},
			inserted: false
		});
		expect(
			await recordVersionedCompletion(
				executor,
				'p1',
				'pz1',
				completion({ elapsedActiveSeconds: 50 }),
				10_000
			)
		).toEqual({ status: 'conflict' });
		expect(await db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 1 }
		]);
		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 100, achievedAt: 1_000 })
		]);
	});

	it('admits the third run, rejects the fourth, and preserves replay semantics at quota', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		for (let index = 1; index <= 3; index++) {
			expect(
				await recordVersionedCompletion(
					executor,
					'p1',
					'pz1',
					completion({
						runId: `run-${index}`,
						elapsedActiveSeconds: 100 - index
					}),
					index * 1_000
				)
			).toEqual({ status: 'recorded', completedAt: index * 1_000 });
		}

		expect(
			await recordVersionedCompletion(
				executor,
				'p1',
				'pz1',
				completion({ runId: 'run-4', elapsedActiveSeconds: 1 }),
				4_000
			)
		).toEqual({ status: 'quota_exceeded' });
		expect(
			await recordVersionedCompletion(
				executor,
				'p1',
				'pz1',
				completion({ runId: 'run-3', elapsedActiveSeconds: 97 }),
				9_000
			)
		).toEqual({ status: 'replayed', completedAt: 3_000 });
		expect(
			await recordVersionedCompletion(
				executor,
				'p1',
				'pz1',
				completion({ runId: 'run-3', elapsedActiveSeconds: 1 }),
				9_000
			)
		).toEqual({ status: 'conflict' });
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(3);
		expect(await db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 3 }
		]);
		expect((await db.select().from(schema.puzzleBestTimes))[0].bestTimeSeconds).toBe(97);
	});

	it('returns tombstoned for first write, exact retry, and changed-facts reuse', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		await db
			.insert(schema.puzzleDeletionTombstones)
			.values({ puzzleId: 'pz1', deletedAt: 500 })
			.run();

		expect(await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000)).toEqual({
			status: 'tombstoned'
		});
		expect(await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 2_000)).toEqual({
			status: 'tombstoned'
		});
		expect(
			await recordVersionedCompletion(
				executor,
				'p1',
				'pz1',
				completion({ elapsedActiveSeconds: 50 }),
				3_000
			)
		).toEqual({ status: 'tombstoned' });
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(0);
		expect(await db.select().from(schema.playerCompletionUsage)).toHaveLength(0);
		expect(await db.select().from(schema.puzzleBestTimes)).toHaveLength(0);
	});

	it('leaves the canonical best unchanged when an exact replay is tombstoned', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);
		await db
			.insert(schema.puzzleDeletionTombstones)
			.values({ puzzleId: 'pz1', deletedAt: 2_000 })
			.run();

		expect(await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 9_000)).toEqual({
			status: 'tombstoned'
		});
		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 100, achievedAt: 1_000 })
		]);
	});

	it('admits only one concurrent run at the final retained-run capacity', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		await executor.write({
			playerId: 'p1',
			puzzleId: 'pz1',
			runId: 'run-1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 100,
			receivedAt: 1_000
		});
		await executor.write({
			playerId: 'p1',
			puzzleId: 'pz1',
			runId: 'run-2',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90,
			receivedAt: 2_000
		});

		const outcomes = await Promise.all([
			executor.write({
				playerId: 'p1',
				puzzleId: 'pz1',
				runId: 'run-3',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 80,
				receivedAt: 3_000
			}),
			executor.write({
				playerId: 'p1',
				puzzleId: 'pz1',
				runId: 'run-4',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 70,
				receivedAt: 4_000
			})
		]);

		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['quota_exceeded', 'stored']);
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(3);
		expect(await db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 3 }
		]);
	});

	it('records the first standard timed run in the ledger and creates a zero-baseline best', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		const result = await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);

		expect(result).toEqual({ status: 'recorded', completedAt: 1_000 });
		expect(await selectRunFacts(db)).toEqual([
			{
				playerId: 'p1',
				runId: 'run-1',
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			}
		]);
		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 100, achievedAt: 1_000 })
		]);
	});

	it('replays exactly once and repairs a missing best from the original ledger timestamp', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);
		await d1.prepare('DELETE FROM puzzle_best_times').run();

		const result = await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 9_000);

		expect(result).toEqual({ status: 'replayed', completedAt: 1_000 });
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(1);
		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 100, achievedAt: 1_000 })
		]);
	});

	it.each([
		{
			name: 'puzzle',
			puzzleId: 'pz-other',
			request: completion()
		},
		{
			name: 'result class',
			puzzleId: 'pz1',
			request: completion({ resultClass: 'rotation_timed' })
		},
		{
			name: 'elapsed value',
			puzzleId: 'pz1',
			request: completion({ elapsedActiveSeconds: 101 })
		}
	])(
		'rejects a replay with a different $name without changing stats',
		async ({ puzzleId, request }) => {
			const executor = createD1CompletionWriteExecutor(db);
			await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);

			const result = await recordVersionedCompletion(executor, 'p1', puzzleId, request, 2_000);

			expect(result).toEqual({ status: 'conflict' });
			expect(await selectRunFacts(db)).toEqual([
				{
					playerId: 'p1',
					runId: 'run-1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					elapsedActiveSeconds: 100,
					completedAt: 1_000
				}
			]);
			expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
				standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 100, achievedAt: 1_000 })
			]);
		}
	);

	it.each([
		completion({
			runId: 'rotation',
			resultClass: 'rotation_timed',
			elapsedActiveSeconds: 110
		}),
		completion({
			runId: 'assisted',
			resultClass: 'assisted_timed',
			elapsedActiveSeconds: 120
		}),
		completion({
			runId: 'relaxed',
			resultClass: 'relaxed',
			elapsedActiveSeconds: null
		})
	])('keeps non-canonical run $runId in the ledger only', async (request) => {
		const executor = createD1CompletionWriteExecutor(db);

		expect(await recordVersionedCompletion(executor, 'p1', 'pz1', request, 1_000)).toEqual({
			status: 'recorded',
			completedAt: 1_000
		});
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(1);
		expect(await db.select().from(schema.puzzleBestTimes)).toHaveLength(0);
	});

	it('records distinct run IDs independently while preserving the zero legacy baseline', async () => {
		const executor = createD1CompletionWriteExecutor(db);

		await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);
		await recordVersionedCompletion(
			executor,
			'p1',
			'pz1',
			completion({ runId: 'run-2', elapsedActiveSeconds: 80 }),
			2_000
		);

		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(2);
		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 80, achievedAt: 2_000 })
		]);
	});

	it('updates only the best time when a faster standard run lands', async () => {
		await db.insert(schema.puzzleBestTimes).values({
			playerId: 'p1',
			puzzleId: 'pz1',
			familyId: PLACEHOLDER_FAMILY_ID,
			difficulty: 'easy',
			resultClass: 'standard_timed',
			bestTimeSeconds: 120,
			achievedAt: 900
		});
		const executor = createD1CompletionWriteExecutor(db);

		await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);
		await recordVersionedCompletion(
			executor,
			'p1',
			'pz1',
			completion({ runId: 'run-slower', elapsedActiveSeconds: 140 }),
			2_000
		);

		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz1', bestTimeSeconds: 100, achievedAt: 1_000 })
		]);
	});

	it('rolls back the ledger insert when the conditional best statement fails', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await d1
			.prepare(
				"CREATE TRIGGER fail_puzzle_best_times_insert BEFORE INSERT ON puzzle_best_times BEGIN SELECT RAISE(ABORT, 'forced best failure'); END"
			)
			.run();
		try {
			await expect(
				recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000)
			).rejects.toThrow();
		} finally {
			await d1.prepare('DROP TRIGGER fail_puzzle_best_times_insert').run();
		}

		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(0);
		expect(await db.select().from(schema.puzzleBestTimes)).toHaveLength(0);
		expect(await db.select().from(schema.playerCompletionUsage)).toHaveLength(0);
	});

	it('rejects a zero-change versioned write without a tombstone or quota', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		await d1
			.prepare(
				'CREATE TRIGGER ignore_completion_run_insert BEFORE INSERT ON puzzle_completion_runs BEGIN SELECT RAISE(IGNORE); END'
			)
			.run();
		try {
			await expect(
				recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000)
			).rejects.toThrow(
				'Completion ledger write returned no stored row without tombstone or quota'
			);
		} finally {
			await d1.prepare('DROP TRIGGER ignore_completion_run_insert').run();
		}

		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(0);
		expect(await db.select().from(schema.puzzleBestTimes)).toHaveLength(0);
		expect(await db.select().from(schema.playerCompletionUsage)).toHaveLength(0);
		expect(await db.select().from(schema.puzzleDeletionTombstones)).toHaveLength(0);
	});

	it('decrements usage on deletion and never creates a negative missing or zero row', async () => {
		const executor = createD1CompletionWriteExecutor(db, 3);
		await recordVersionedCompletion(executor, 'p1', 'pz1', completion({ runId: 'p1-pz1' }), 1_000);
		await recordVersionedCompletion(executor, 'p1', 'pz2', completion({ runId: 'p1-pz2' }), 2_000);

		await deletePuzzleStats(executor, 'pz1');
		expect(await db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 1 }
		]);

		await d1.prepare("DELETE FROM player_completion_usage WHERE player_id = 'p1'").run();
		await deletePuzzleStats(executor, 'pz2');
		expect(await db.select().from(schema.playerCompletionUsage)).toHaveLength(0);

		await recordVersionedCompletion(executor, 'p2', 'pz3', completion({ runId: 'p2-pz3' }), 3_000);
		await d1
			.prepare("UPDATE player_completion_usage SET retained_runs = 0 WHERE player_id = 'p2'")
			.run();
		await deletePuzzleStats(executor, 'pz3');
		expect(await db.select().from(schema.playerCompletionUsage)).toHaveLength(0);
	});

	it('deletePuzzleStats delegates lifecycle finish for every player row on one puzzle', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await db.insert(schema.puzzleBestTimes).values([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 50,
				achievedAt: 400
			},
			{
				playerId: 'p2',
				puzzleId: 'pz1',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 30,
				achievedAt: 300
			},
			{
				playerId: 'p1',
				puzzleId: 'pz2',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 40,
				achievedAt: 500
			}
		]);
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'run-p1-pz1',
			puzzleId: 'pz1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 50,
			completedAt: 400
		});
		await insertStoredRun(db, {
			playerId: 'p2',
			runId: 'run-p2-pz1',
			puzzleId: 'pz1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 30,
			completedAt: 300
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'run-p1-pz2',
			puzzleId: 'pz2',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 40,
			completedAt: 500
		});

		await deletePuzzleStats(executor, 'pz1');

		expect(await db.select().from(schema.puzzleBestTimes)).toEqual([
			standardBest({ playerId: 'p1', puzzleId: 'pz2', bestTimeSeconds: 40, achievedAt: 500 })
		]);
		expect(await selectRunFacts(db)).toEqual([
			{
				playerId: 'p1',
				runId: 'run-p1-pz2',
				puzzleId: 'pz2',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 40,
				completedAt: 500
			}
		]);
	});

	it('deletePuzzleStats rolls back the baseline delete when the ledger delete fails', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await db.insert(schema.puzzleBestTimes).values({
			playerId: 'p1',
			puzzleId: 'pz1',
			familyId: PLACEHOLDER_FAMILY_ID,
			difficulty: 'easy',
			resultClass: 'standard_timed',
			bestTimeSeconds: 50,
			achievedAt: 400
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'run-p1-pz1',
			puzzleId: 'pz1',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 50,
			completedAt: 400
		});
		await d1
			.prepare(
				"CREATE TRIGGER fail_completion_run_delete BEFORE DELETE ON puzzle_completion_runs BEGIN SELECT RAISE(ABORT, 'forced ledger delete failure'); END"
			)
			.run();
		try {
			await expect(deletePuzzleStats(executor, 'pz1')).rejects.toThrow(
				'forced ledger delete failure'
			);
		} finally {
			await d1.prepare('DROP TRIGGER fail_completion_run_delete').run();
		}

		expect(await db.select().from(schema.puzzleBestTimes)).toHaveLength(1);
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(1);
	});
});

describe('listPlayerStats composite cursor against real D1', () => {
	it('paginates with (bestTimeSeconds, puzzleId) cursor without skipping rows', async () => {
		// Insert 5 current completions with distinct best times.
		for (let i = 0; i < 5; i++) {
			await recordVersionedCompletion(
				createD1CompletionWriteExecutor(db),
				'p1',
				`pz${i}`,
				completion({ runId: `cursor-${i}`, elapsedActiveSeconds: 100 + i * 10 }),
				1_000 + i
			);
		}
		const page1 = await listPlayerStats(db, 'p1', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		// Ordered by bestTimeSeconds ASC
		expect(page1.rows[0].bestTimeSeconds).toBe(100);
		expect(page1.rows[1].bestTimeSeconds).toBe(110);

		const page2 = await listPlayerStats(db, 'p1', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.nextCursor).toBeDefined();
		expect(page2.rows[0].bestTimeSeconds).toBe(120);
		expect(page2.rows[1].bestTimeSeconds).toBe(130);

		const page3 = await listPlayerStats(db, 'p1', {
			limit: 2,
			cursor: page2.nextCursor!
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();
		expect(page3.rows[0].bestTimeSeconds).toBe(140);
	});

	it('handles tie-break on equal bestTimeSeconds via puzzleId', async () => {
		// Two puzzles with the same best time — cursor must use puzzleId
		// as the tiebreaker to avoid skipping or duplicating rows.
		const executor = createD1CompletionWriteExecutor(db);
		await recordVersionedCompletion(
			executor,
			'p1',
			'pzB',
			completion({ runId: 'tie-b', elapsedActiveSeconds: 100 }),
			1_000
		);
		await recordVersionedCompletion(
			executor,
			'p1',
			'pzA',
			completion({ runId: 'tie-a', elapsedActiveSeconds: 100 }),
			2_000
		);
		await recordVersionedCompletion(
			executor,
			'p1',
			'pzC',
			completion({ runId: 'tie-c', elapsedActiveSeconds: 100 }),
			3_000
		);

		const page1 = await listPlayerStats(db, 'p1', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		// Ordered by bestTimeSeconds ASC, puzzleId ASC
		expect(page1.rows[0].puzzleId).toBe('pzA');
		expect(page1.rows[1].puzzleId).toBe('pzB');

		const page2 = await listPlayerStats(db, 'p1', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(1);
		expect(page2.rows[0].puzzleId).toBe('pzC');
		expect(page2.nextCursor).toBeUndefined();
	});
});

describe('player stats against real D1', () => {
	it('aggregates ledger runs with standard bests and family upload counts', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-uploaded',
			ownerId: 'p1',
			name: 'Uploaded Family',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 1
		});
		await db.insert(schema.puzzleBestTimes).values([
			{
				playerId: 'p1',
				puzzleId: 'standard',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 40,
				achievedAt: 300
			},
			{
				playerId: 'p1',
				puzzleId: 'overlap',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 60,
				achievedAt: 700
			}
		]);
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'standard-1',
			puzzleId: 'standard',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 40,
			completedAt: 300
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'overlap-1',
			puzzleId: 'overlap',
			resultClass: 'rotation_timed',
			elapsedActiveSeconds: 80,
			completedAt: 100
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'overlap-2',
			puzzleId: 'overlap',
			resultClass: 'relaxed',
			elapsedActiveSeconds: null,
			completedAt: 900
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'variant-1',
			puzzleId: 'variant',
			resultClass: 'relaxed',
			elapsedActiveSeconds: null,
			completedAt: 400
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'variant-2',
			puzzleId: 'variant',
			resultClass: 'assisted_timed',
			elapsedActiveSeconds: 70,
			completedAt: 800
		});

		const result = await listPlayerStats(db, 'p1', { limit: 10 });

		expect(
			result.rows.map(
				({ puzzleId, bestTimeSeconds, totalCompletions, firstCompletedAt, lastCompletedAt }) => ({
					puzzleId,
					bestTimeSeconds,
					totalCompletions,
					firstCompletedAt,
					lastCompletedAt
				})
			)
		).toEqual([
			{
				puzzleId: 'standard',
				bestTimeSeconds: 40,
				totalCompletions: 1,
				firstCompletedAt: 300,
				lastCompletedAt: 300
			},
			{
				puzzleId: 'overlap',
				bestTimeSeconds: 60,
				totalCompletions: 2,
				firstCompletedAt: 100,
				lastCompletedAt: 900
			},
			{
				puzzleId: 'variant',
				bestTimeSeconds: null,
				totalCompletions: 2,
				firstCompletedAt: 400,
				lastCompletedAt: 800
			}
		]);
		expect(await getPlayerSummary(db, 'p1')).toEqual({
			puzzlesUploaded: 1,
			puzzlesSolved: 3,
			totalCompletions: 5
		});
	});

	it('paginates numeric ties and null-best rows with v2 and legacy cursors', async () => {
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'timed-a',
			puzzleId: 'pz-a',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 10,
			completedAt: 100
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'timed-b',
			puzzleId: 'pz-b',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 10,
			completedAt: 200
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'timed-c',
			puzzleId: 'pz-c',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 20,
			completedAt: 300
		});
		await db.insert(schema.puzzleBestTimes).values([
			{
				playerId: 'p1',
				puzzleId: 'pz-a',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 10,
				achievedAt: 100
			},
			{
				playerId: 'p1',
				puzzleId: 'pz-b',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 10,
				achievedAt: 200
			},
			{
				playerId: 'p1',
				puzzleId: 'pz-c',
				familyId: PLACEHOLDER_FAMILY_ID,
				difficulty: 'easy',
				resultClass: 'standard_timed',
				bestTimeSeconds: 20,
				achievedAt: 300
			}
		]);
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'null-1',
			puzzleId: 'pz-n1',
			resultClass: 'relaxed',
			elapsedActiveSeconds: null,
			completedAt: 400
		});
		await insertStoredRun(db, {
			playerId: 'p1',
			runId: 'null-2',
			puzzleId: 'pz-n2',
			resultClass: 'relaxed',
			elapsedActiveSeconds: null,
			completedAt: 500
		});

		const first = await listPlayerStats(db, 'p1', { limit: 1 });
		expect(first.rows.map((row) => row.puzzleId)).toEqual(['pz-a']);
		expect(first.nextCursor).toBe('v2|0|10|pz-a');
		expect(
			(
				await listPlayerStats(db, 'p1', {
					limit: 10,
					cursor: first.nextCursor
				})
			).rows.map((row) => row.puzzleId)
		).toEqual(['pz-b', 'pz-c', 'pz-n1', 'pz-n2']);
		expect(
			(
				await listPlayerStats(db, 'p1', {
					limit: 10,
					cursor: 'v2|0|20|pz-c'
				})
			).rows.map((row) => row.puzzleId)
		).toEqual(['pz-n1', 'pz-n2']);
		expect(
			(
				await listPlayerStats(db, 'p1', {
					limit: 10,
					cursor: 'v2|1||pz-n1'
				})
			).rows.map((row) => row.puzzleId)
		).toEqual(['pz-n2']);
		expect(
			(
				await listPlayerStats(db, 'p1', {
					limit: 10,
					cursor: '10|pz-a'
				})
			).rows.map((row) => row.puzzleId)
		).toEqual(['pz-b', 'pz-c', 'pz-n1', 'pz-n2']);
		expect(
			(
				await listPlayerStats(db, 'p1', {
					limit: 10,
					cursor: '10'
				})
			).rows.map((row) => row.puzzleId)
		).toEqual(['pz-c', 'pz-n1', 'pz-n2']);
		expect((await listPlayerStats(db, 'p1', { limit: 4 })).nextCursor).toBe('v2|1||pz-n1');
	});

	it.each([
		['v2 group-0', 'v2|0|9007199254740991|pz-a'],
		['legacy composite', '9007199254740991|pz-a'],
		['legacy bare', '9007199254740991']
	])('accepts Number.MAX_SAFE_INTEGER in a %s cursor against D1', async (_kind, cursor) => {
		const result = await listPlayerStats(db, 'p1', { limit: 10, cursor });

		expect(result.rows).toEqual([]);
	});

	it.each([
		['v2 group-0', 'v2|0|9007199254740992|pz-a'],
		['legacy composite', '9007199254740992|pz-a'],
		['legacy bare', '9007199254740992']
	])('rejects Number.MAX_SAFE_INTEGER + 1 in a %s cursor against D1', async (_kind, cursor) => {
		await expect(listPlayerStats(db, 'p1', { limit: 10, cursor })).rejects.toBeInstanceOf(
			InvalidPlayerStatsCursorError
		);
	});

	it.each([
		'',
		'garbage',
		'01',
		'-1',
		'1.5',
		'1e2',
		'10|',
		'10|pz-a|extra',
		'v3|0|10|pz-a',
		'v2|2||pz-a',
		'v2|0||pz-a',
		'v2|0|10|',
		'v2|1|10|pz-a',
		'v2|1||'
	])('rejects malformed player stats cursor %j against D1', async (cursor) => {
		await expect(listPlayerStats(db, 'p1', { limit: 10, cursor })).rejects.toBeInstanceOf(
			InvalidPlayerStatsCursorError
		);
	});
});

describe('puzzle family ownership against real D1', () => {
	it('insertPuzzleFamilyOwnership + listPlayerPuzzleFamilies', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam1',
			ownerId: 'p1',
			name: 'Cat Family',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 10
		});
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam2',
			ownerId: 'p2',
			name: 'Other Family',
			aspectRatio: '4:3',
			status: 'ready',
			createdAt: 20
		});
		const list = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(1);
		expect(list.rows[0].name).toBe('Cat Family');
		expect(list.rows[0].aspectRatio).toBe('1:1');
	});

	it('lists processing, ready, and failed families for the owner', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-ready',
			ownerId: 'p1',
			name: 'Ready',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 1
		});
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-processing',
			ownerId: 'p1',
			name: 'Processing',
			aspectRatio: '3:4',
			status: 'processing',
			createdAt: 2
		});
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-failed',
			ownerId: 'p1',
			name: 'Failed',
			aspectRatio: '4:3',
			status: 'failed',
			createdAt: 3
		});
		const list = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(3);
		expect(list.rows.map((row) => row.status)).toEqual(['failed', 'processing', 'ready']);
	});

	it('setPuzzleFamilyStatus updates mirrored status', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-status',
			ownerId: 'p1',
			name: 'Status Family',
			aspectRatio: '1:1',
			status: 'processing',
			createdAt: 1
		});
		await setPuzzleFamilyStatus(db, 'fam-status', 'ready');
		const list = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10 });
		expect(list.rows[0].status).toBe('ready');
	});

	it('deletePuzzleFamilyOwnership removes the row', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-delete',
			ownerId: 'p1',
			name: 'Delete Me',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 1
		});
		await deletePuzzleFamilyOwnership(db, 'fam-delete');
		const list = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(0);
	});

	it('ensurePuzzleFamilyOwnership leaves an existing row untouched (ON CONFLICT DO NOTHING)', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam-owned',
			ownerId: 'p1',
			name: 'Real Owner Name',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 10
		});
		await ensurePuzzleFamilyOwnership(db, {
			id: 'fam-owned',
			ownerId: SYSTEM_OWNER_ID,
			name: 'Backfill Name',
			aspectRatio: '4:3',
			status: 'failed',
			createdAt: 999
		});
		const owned = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10 });
		expect(owned.rows).toHaveLength(1);
		expect(owned.rows[0].name).toBe('Real Owner Name');
		expect(owned.rows[0].ownerId).toBe('p1');
		expect(owned.rows[0].aspectRatio).toBe('1:1');
	});
});

describe('listPlayerPuzzleFamilies composite cursor against real D1', () => {
	it('paginates with (createdAt, id) cursor without skipping rows', async () => {
		for (let i = 0; i < 5; i++) {
			await insertPuzzleFamilyOwnership(db, {
				id: `fam${i}`,
				ownerId: 'p1',
				name: `Family ${i}`,
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: i * 10
			});
		}
		const page1 = await listPlayerPuzzleFamilies(db, 'p1', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		expect(page1.rows[0].createdAt).toBe(40);
		expect(page1.rows[1].createdAt).toBe(30);

		const page2 = await listPlayerPuzzleFamilies(db, 'p1', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.nextCursor).toBeDefined();
		expect(page2.rows[0].createdAt).toBe(20);
		expect(page2.rows[1].createdAt).toBe(10);

		const page3 = await listPlayerPuzzleFamilies(db, 'p1', {
			limit: 2,
			cursor: page2.nextCursor!
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();
		expect(page3.rows[0].createdAt).toBe(0);
	});

	it('isolates players (no cross-player leak on pagination)', async () => {
		for (let i = 0; i < 3; i++) {
			await insertPuzzleFamilyOwnership(db, {
				id: `alice-fam${i}`,
				ownerId: 'alice',
				name: `Alice ${i}`,
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: i
			});
			await insertPuzzleFamilyOwnership(db, {
				id: `bob-fam${i}`,
				ownerId: 'bob',
				name: `Bob ${i}`,
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: i + 100
			});
		}
		const page1 = await listPlayerPuzzleFamilies(db, 'alice', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.rows.every((row) => row.ownerId === 'alice')).toBe(true);

		const page2 = await listPlayerPuzzleFamilies(db, 'alice', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(1);
		expect(page2.rows[0].ownerId).toBe('alice');
	});

	it('malformed cursor falls back to timestamp-only filter', async () => {
		for (let i = 0; i < 3; i++) {
			await insertPuzzleFamilyOwnership(db, {
				id: `fam${i}`,
				ownerId: 'p1',
				name: `Family ${i}`,
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: i * 10
			});
		}
		const result = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10, cursor: '10' });
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].id).toBe('fam0');
	});

	it('garbage cursor returns no rows', async () => {
		await insertPuzzleFamilyOwnership(db, {
			id: 'fam1',
			ownerId: 'p1',
			name: 'Family',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 1
		});
		const result = await listPlayerPuzzleFamilies(db, 'p1', { limit: 10, cursor: 'garbage' });
		expect(result.rows).toHaveLength(0);
	});

	it('floors fractional limits to an integer', async () => {
		for (let i = 0; i < 3; i++) {
			await insertPuzzleFamilyOwnership(db, {
				id: `fam${i}`,
				ownerId: 'p1',
				name: `Family ${i}`,
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: i
			});
		}
		const result = await listPlayerPuzzleFamilies(db, 'p1', { limit: 1.5 });
		expect(result.rows).toHaveLength(1);
	});
});
