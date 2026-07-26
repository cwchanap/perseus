import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from '../schema';
import { createD1CompletionWriteExecutor, createD1Db, type D1AppDb } from '../drivers/d1';
import { completionFactsMatch, type VersionedCompletionWrite } from '../completion-writes';
import {
	recordCompletion,
	recordVersionedCompletion,
	listPlayerStats,
	insertPuzzleOwnership,
	ensurePuzzleOwnership,
	listPlayerPuzzles,
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
	await d1.prepare('DELETE FROM player_profiles').run();
});

function completion(overrides: Partial<RecordPuzzleCompletionV1> = {}): RecordPuzzleCompletionV1 {
	return {
		version: 1,
		runId: 'run-1',
		resultClass: 'standard_timed',
		timingQuality: 'known',
		elapsedActiveSeconds: 100,
		...overrides
	};
}

describe('completionFactsMatch', () => {
	it('rejects stored facts that differ only in timing quality', () => {
		const input: VersionedCompletionWrite = {
			playerId: 'p1',
			puzzleId: 'pz1',
			runId: 'run-1',
			resultClass: 'standard_timed',
			timingQuality: 'known',
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
				timingQuality: 'legacy_unknown',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			})
		).toBe(false);
	});
});

describe('recordVersionedCompletion against real D1', () => {
	it('records the first standard timed run in the ledger and creates a zero-baseline best', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		const result = await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);

		expect(result).toEqual({ status: 'recorded', completedAt: 1_000 });
		expect(await db.select().from(schema.puzzleCompletionRuns)).toEqual([
			{
				playerId: 'p1',
				runId: 'run-1',
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
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
			name: 'timing quality',
			puzzleId: 'pz1',
			request: completion({ timingQuality: 'legacy_unknown', elapsedActiveSeconds: null })
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
			expect(await db.select().from(schema.puzzleCompletionRuns)).toEqual([
				{
					playerId: 'p1',
					runId: 'run-1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					timingQuality: 'known',
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
		}),
		completion({
			runId: 'legacy',
			timingQuality: 'legacy_unknown',
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
	});

	it('deletes puzzle stats and ledger rows together through the executor', async () => {
		const executor = createD1CompletionWriteExecutor(db);
		await recordVersionedCompletion(executor, 'p1', 'pz1', completion(), 1_000);

		await executor.deletePuzzleCompletionData('pz1');

		expect(await db.select().from(schema.puzzleCompletionRuns)).toHaveLength(0);
		expect(await db.select().from(schema.puzzleStats)).toHaveLength(0);
	});
});

describe('recordCompletion against real D1', () => {
	it('inserts a new stat row on first completion', async () => {
		await recordCompletion(db, 'p1', 'pz1', 100);
		const stats = await listPlayerStats(db, 'p1', { limit: 10 });
		expect(stats.rows).toHaveLength(1);
		expect(stats.rows[0].bestTimeSeconds).toBe(100);
		expect(stats.rows[0].totalCompletions).toBe(1);
	});

	it('upserts: tracks MIN best time and increments count for spaced solves', async () => {
		vi.useFakeTimers();
		try {
			await recordCompletion(db, 'p1', 'pz1', 100);
			vi.advanceTimersByTime(31_000);
			await recordCompletion(db, 'p1', 'pz1', 80);
			vi.advanceTimersByTime(31_000);
			await recordCompletion(db, 'p1', 'pz1', 120);
			const stats = await listPlayerStats(db, 'p1', { limit: 10 });
			expect(stats.rows).toHaveLength(1);
			expect(stats.rows[0].bestTimeSeconds).toBe(80); // MIN of 100, 80, 120
			expect(stats.rows[0].totalCompletions).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('dedupes rapid retries within the 30s window (onConflictDoUpdate raw SQL)', async () => {
		vi.useFakeTimers();
		try {
			await recordCompletion(db, 'p1', 'pz1', 100);
			// No time advanced — these are immediate retries.
			await recordCompletion(db, 'p1', 'pz1', 80);
			await recordCompletion(db, 'p1', 'pz1', 120);
			const stats = await listPlayerStats(db, 'p1', { limit: 10 });
			expect(stats.rows).toHaveLength(1);
			expect(stats.rows[0].bestTimeSeconds).toBe(80); // MIN still applied
			expect(stats.rows[0].totalCompletions).toBe(1); // deduped, not 3
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('listPlayerStats composite cursor against real D1', () => {
	it('paginates with (bestTimeSeconds, puzzleId) cursor without skipping rows', async () => {
		vi.useFakeTimers();
		try {
			// Insert 5 completions with distinct best times.
			for (let i = 0; i < 5; i++) {
				await recordCompletion(db, 'p1', `pz${i}`, 100 + i * 10);
				vi.advanceTimersByTime(31_000);
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
		} finally {
			vi.useRealTimers();
		}
	});

	it('handles tie-break on equal bestTimeSeconds via puzzleId', async () => {
		vi.useFakeTimers();
		try {
			// Two puzzles with the same best time — cursor must use puzzleId
			// as the tiebreaker to avoid skipping or duplicating rows.
			await recordCompletion(db, 'p1', 'pzB', 100);
			vi.advanceTimersByTime(31_000);
			await recordCompletion(db, 'p1', 'pzA', 100);
			vi.advanceTimersByTime(31_000);
			await recordCompletion(db, 'p1', 'pzC', 100);

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
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('ensurePuzzleOwnership backfill against real D1', () => {
	it('inserts a system-owned row when none exists, resolving the name in listPlayerStats', async () => {
		// Simulate a completion of a puzzle that has no D1 ownership row (e.g.
		// an admin puzzle whose best-effort ownership insert failed). Without
		// the backfill, listPlayerStats left-joins a missing row and surfaces
		// puzzleName null (the Best Times UI then shows the UUID).
		await ensurePuzzleOwnership(db, {
			id: 'pz-legacy',
			ownerId: SYSTEM_OWNER_ID,
			name: 'Legacy Puzzle',
			pieceCount: 4,
			status: 'ready',
			createdAt: 50
		});
		await recordCompletion(db, 'p1', 'pz-legacy', 120);
		const stats = await listPlayerStats(db, 'p1', { limit: 10 });
		expect(stats.rows).toHaveLength(1);
		expect(stats.rows[0].puzzleName).toBe('Legacy Puzzle');
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
		await recordCompletion(db, 'p1', 'pz-sys', 60);
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
