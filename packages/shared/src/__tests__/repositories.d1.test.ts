import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Miniflare } from 'miniflare';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import * as schema from '../schema';
import { createD1CompletionWriteExecutor, createD1Db, type D1AppDb } from '../drivers/d1';
import { completionFactsMatch, type VersionedCompletionWrite } from '../completion-writes';
import {
	recordVersionedCompletion,
	listPlayerStats,
	getPlayerSummary,
	InvalidPlayerStatsCursorError,
	deletePuzzleStats,
	insertPuzzleOwnership,
	ensurePuzzleOwnership,
	listPlayerPuzzles,
	insertPuzzleFamilyOwnership,
	ensurePuzzleFamilyOwnership,
	deletePuzzleFamilyOwnership,
	setPuzzleFamilyStatus,
	listPlayerPuzzleFamilies,
	SYSTEM_OWNER_ID
} from '../repositories';

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
	await d1.prepare('DELETE FROM puzzle_stats').run();
	await d1.prepare('DELETE FROM puzzles').run();
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
			(player_id, run_id, puzzle_id, result_class, timing_quality, elapsed_active_seconds, completed_at)
		VALUES (${row.playerId}, ${row.runId}, ${row.puzzleId}, ${row.resultClass}, 'known', ${row.elapsedActiveSeconds}, ${row.completedAt})
	`);
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
		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 100,
				totalCompletions: 0,
				firstCompletedAt: 1_000,
				lastCompletedAt: 1_000
			}
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
		expect((await db.select().from(schema.puzzleStats))[0].bestTimeSeconds).toBe(97);
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
		expect(await db.select().from(schema.puzzleStats)).toHaveLength(0);
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
		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 100,
				totalCompletions: 0,
				firstCompletedAt: 1_000,
				lastCompletedAt: 1_000
			}
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
		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 100,
				totalCompletions: 0,
				firstCompletedAt: 1_000,
				lastCompletedAt: 1_000
			}
		]);
	});

	it('replays exactly once and repairs a missing best from the original ledger timestamp', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);
		await d1.prepare('DELETE FROM puzzle_stats').run();

		const result = await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 9_000);

		expect(result).toEqual({ status: 'replayed', completedAt: 1_000 });
		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(1);
		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 100,
				totalCompletions: 0,
				firstCompletedAt: 1_000,
				lastCompletedAt: 1_000
			}
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
			expect(await db.select().from(schema.puzzleStats)).toEqual([
				{
					playerId: 'p1',
					puzzleId: 'pz1',
					bestTimeSeconds: 100,
					totalCompletions: 0,
					firstCompletedAt: 1_000,
					lastCompletedAt: 1_000
				}
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
		expect(await db.select().from(schema.puzzleStats)).toHaveLength(0);
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
		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 80,
				totalCompletions: 0,
				firstCompletedAt: 1_000,
				lastCompletedAt: 1_000
			}
		]);
	});

	it('updates only the best time on a historical stats row', async () => {
		await db.insert(schema.puzzleStats).values({
			playerId: 'p1',
			puzzleId: 'pz1',
			bestTimeSeconds: 120,
			totalCompletions: 7,
			firstCompletedAt: 100,
			lastCompletedAt: 900
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

		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 100,
				totalCompletions: 7,
				firstCompletedAt: 100,
				lastCompletedAt: 900
			}
		]);
	});

	it('rolls back the ledger insert when the conditional best statement fails', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await d1
			.prepare(
				"CREATE TRIGGER fail_puzzle_stats_insert BEFORE INSERT ON puzzle_stats BEGIN SELECT RAISE(ABORT, 'forced best failure'); END"
			)
			.run();
		try {
			await expect(
				recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000)
			).rejects.toThrow();
		} finally {
			await d1.prepare('DROP TRIGGER fail_puzzle_stats_insert').run();
		}

		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(0);
		expect(await db.select().from(schema.puzzleStats)).toHaveLength(0);
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
		expect(await db.select().from(schema.puzzleStats)).toHaveLength(0);
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
		await db.insert(schema.puzzleStats).values([
			{
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 50,
				totalCompletions: 4,
				firstCompletedAt: 100,
				lastCompletedAt: 400
			},
			{
				playerId: 'p2',
				puzzleId: 'pz1',
				bestTimeSeconds: 30,
				totalCompletions: 2,
				firstCompletedAt: 200,
				lastCompletedAt: 300
			},
			{
				playerId: 'p1',
				puzzleId: 'pz2',
				bestTimeSeconds: 40,
				totalCompletions: 1,
				firstCompletedAt: 500,
				lastCompletedAt: 500
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

		expect(await db.select().from(schema.puzzleStats)).toEqual([
			{
				playerId: 'p1',
				puzzleId: 'pz2',
				bestTimeSeconds: 40,
				totalCompletions: 1,
				firstCompletedAt: 500,
				lastCompletedAt: 500
			}
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
		await db.insert(schema.puzzleStats).values({
			playerId: 'p1',
			puzzleId: 'pz1',
			bestTimeSeconds: 50,
			totalCompletions: 4,
			firstCompletedAt: 100,
			lastCompletedAt: 400
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

		expect(await db.select().from(schema.puzzleStats)).toHaveLength(1);
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
	it('combines historical and ledger groups with additive counts and timestamp extrema', async () => {
		await db.insert(schema.puzzles).values({
			id: 'historical',
			ownerId: 'p1',
			name: 'Historical',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		await db.insert(schema.puzzleStats).values([
			{
				playerId: 'p1',
				puzzleId: 'historical',
				bestTimeSeconds: 90,
				totalCompletions: 2,
				firstCompletedAt: 200,
				lastCompletedAt: 500
			},
			{
				playerId: 'p1',
				puzzleId: 'standard',
				bestTimeSeconds: 40,
				totalCompletions: 0,
				firstCompletedAt: 300,
				lastCompletedAt: 300
			},
			{
				playerId: 'p1',
				puzzleId: 'overlap',
				bestTimeSeconds: 60,
				totalCompletions: 3,
				firstCompletedAt: 300,
				lastCompletedAt: 700
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
				totalCompletions: 5,
				firstCompletedAt: 100,
				lastCompletedAt: 900
			},
			{
				puzzleId: 'historical',
				bestTimeSeconds: 90,
				totalCompletions: 2,
				firstCompletedAt: 200,
				lastCompletedAt: 500
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
			puzzlesSolved: 4,
			totalCompletions: 10
		});
	});

	it('paginates numeric ties and null-best rows with v2 and legacy cursors', async () => {
		await db.insert(schema.puzzleStats).values([
			{
				playerId: 'p1',
				puzzleId: 'pz-a',
				bestTimeSeconds: 10,
				totalCompletions: 1,
				firstCompletedAt: 100,
				lastCompletedAt: 100
			},
			{
				playerId: 'p1',
				puzzleId: 'pz-b',
				bestTimeSeconds: 10,
				totalCompletions: 1,
				firstCompletedAt: 200,
				lastCompletedAt: 200
			},
			{
				playerId: 'p1',
				puzzleId: 'pz-c',
				bestTimeSeconds: 20,
				totalCompletions: 1,
				firstCompletedAt: 300,
				lastCompletedAt: 300
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

describe('ensurePuzzleOwnership backfill against real D1', () => {
	it('inserts a system-owned row when none exists, resolving the name in listPlayerStats', async () => {
		// Simulate a completion of a puzzle that has no D1 ownership row (e.g.
		// an admin puzzle whose best-effort ownership insert failed). Without
		// the backfill, listPlayerStats left-joins a missing row and surfaces
		// puzzleName null (the Puzzle Results UI then shows the UUID).
		await ensurePuzzleOwnership(db, {
			id: 'pz-backfill',
			ownerId: SYSTEM_OWNER_ID,
			name: 'Backfill Puzzle',
			pieceCount: 4,
			status: 'ready',
			createdAt: 50
		});
		await recordVersionedCompletion(
			createD1CompletionWriteExecutor(db),
			'p1',
			'pz-backfill',
			completion({ runId: 'backfill-run', elapsedActiveSeconds: 120 })
		);
		const stats = await listPlayerStats(db, 'p1', { limit: 10 });
		expect(stats.rows).toHaveLength(1);
		expect(stats.rows[0].puzzleName).toBe('Backfill Puzzle');
	});

	it('leaves an existing ownership row untouched (ON CONFLICT DO NOTHING)', async () => {
		// A player-owned row already exists for this puzzle.
		await insertPuzzleOwnership(db, {
			id: 'pz-owned',
			ownerId: 'p1',
			name: 'Real Owner Name',
			pieceCount: 9,
			status: 'ready',
			createdAt: 10
		});
		// A completion backfills with a system-owned row, which must NOT
		// clobber the existing player-owned row (or it would vanish from the
		// player's "My Puzzles" list).
		await ensurePuzzleOwnership(db, {
			id: 'pz-owned',
			ownerId: SYSTEM_OWNER_ID,
			name: 'Backfill Name',
			pieceCount: 4,
			status: 'ready',
			createdAt: 999
		});
		const owned = await listPlayerPuzzles(db, 'p1', { limit: 10 });
		expect(owned.rows).toHaveLength(1);
		expect(owned.rows[0].name).toBe('Real Owner Name');
		expect(owned.rows[0].ownerId).toBe('p1');
		expect(owned.rows[0].pieceCount).toBe(9);
	});

	it('is idempotent: a second backfill for the same system row is a no-op', async () => {
		await ensurePuzzleOwnership(db, {
			id: 'pz-sys',
			ownerId: SYSTEM_OWNER_ID,
			name: 'System Puzzle',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		// Second call must not throw (conflict on PK) and must not duplicate.
		await ensurePuzzleOwnership(db, {
			id: 'pz-sys',
			ownerId: SYSTEM_OWNER_ID,
			name: 'System Puzzle',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		const stats = await listPlayerStats(db, 'p1', { limit: 10 });
		expect(stats.rows).toHaveLength(0); // no completions recorded
		// The single system row resolves the name once a completion lands.
		await recordVersionedCompletion(
			createD1CompletionWriteExecutor(db),
			'p1',
			'pz-sys',
			completion({ runId: 'system-run', elapsedActiveSeconds: 60 })
		);
		const after = await listPlayerStats(db, 'p1', { limit: 10 });
		expect(after.rows).toHaveLength(1);
		expect(after.rows[0].puzzleName).toBe('System Puzzle');
	});
});

describe('listPlayerPuzzles composite cursor against real D1', () => {
	it('paginates with (createdAt, id) cursor without skipping rows', async () => {
		for (let i = 0; i < 5; i++) {
			await insertPuzzleOwnership(db, {
				id: `pz${i}`,
				ownerId: 'p1',
				name: `Puzzle ${i}`,
				pieceCount: 4,
				status: 'ready',
				createdAt: i * 10
			});
		}
		const page1 = await listPlayerPuzzles(db, 'p1', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		// Ordered by createdAt DESC
		expect(page1.rows[0].createdAt).toBe(40);
		expect(page1.rows[1].createdAt).toBe(30);

		const page2 = await listPlayerPuzzles(db, 'p1', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.nextCursor).toBeDefined();
		expect(page2.rows[0].createdAt).toBe(20);
		expect(page2.rows[1].createdAt).toBe(10);

		const page3 = await listPlayerPuzzles(db, 'p1', {
			limit: 2,
			cursor: page2.nextCursor!
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();
		expect(page3.rows[0].createdAt).toBe(0);
	});

	it('handles tie-break on equal createdAt via id', async () => {
		// Two puzzles with the same createdAt — cursor must use id as the
		// tiebreaker to avoid skipping or duplicating rows.
		await insertPuzzleOwnership(db, {
			id: 'pzB',
			ownerId: 'p1',
			name: 'B',
			pieceCount: 4,
			status: 'ready',
			createdAt: 100
		});
		await insertPuzzleOwnership(db, {
			id: 'pzA',
			ownerId: 'p1',
			name: 'A',
			pieceCount: 4,
			status: 'ready',
			createdAt: 100
		});
		await insertPuzzleOwnership(db, {
			id: 'pzC',
			ownerId: 'p1',
			name: 'C',
			pieceCount: 4,
			status: 'ready',
			createdAt: 100
		});

		const page1 = await listPlayerPuzzles(db, 'p1', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		// Ordered by createdAt DESC, id DESC
		expect(page1.rows[0].id).toBe('pzC');
		expect(page1.rows[1].id).toBe('pzB');

		const page2 = await listPlayerPuzzles(db, 'p1', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(1);
		expect(page2.rows[0].id).toBe('pzA');
		expect(page2.nextCursor).toBeUndefined();
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
