import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema';
import { createBunDbContext, type BunDbContext } from '../drivers/bun';
import { createD1CompletionWriteExecutor, createD1Db, type D1AppDb } from '../drivers/d1';
import type { CompletionWriteExecutor, VersionedCompletionWrite } from '../completion-writes';
import type { AppDb } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../drizzle');
const migrationSql = readdirSync(migrationsDir)
	.filter((file) => /^\d{4}_.*\.sql$/u.test(file))
	.sort()
	.map((file) => readFileSync(join(migrationsDir, file), 'utf-8'))
	.join('\n');

let mf: Miniflare;
let d1: D1Database;
let d1Db: D1AppDb;
let bunDir: string;
let bunContext: BunDbContext | null;

beforeAll(async () => {
	mf = new Miniflare({
		modules: [{ type: 'ESModule', path: 'index.js', contents: 'export default {}' }],
		d1Databases: ['DB'],
		compatibilityDate: '2024-12-30'
	});
	d1 = await mf.getD1Database('DB');
	for (const statement of migrationSql.split('--> statement-breakpoint')) {
		const trimmed = statement.trim();
		if (trimmed) await d1.prepare(trimmed).run();
	}
	d1Db = createD1Db({ DB: d1 });
}, 30_000);

afterAll(async () => {
	await mf.dispose();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM puzzle_completion_runs').run();
	await d1.prepare('DELETE FROM puzzle_stats').run();
	await d1.prepare('DELETE FROM player_completion_usage').run();
	await d1.prepare('DELETE FROM puzzle_deletion_tombstones').run();
	bunDir = mkdtempSync(join(tmpdir(), 'perseus-bun-driver-'));
	bunContext = createBunDbContext(bunDir);
});

afterEach(() => {
	bunContext?.close();
	bunContext = null;
	rmSync(bunDir, { recursive: true, force: true });
});

function completion(overrides: Partial<VersionedCompletionWrite> = {}): VersionedCompletionWrite {
	return {
		playerId: 'p1',
		puzzleId: 'pz1',
		runId: 'run-1',
		resultClass: 'standard_timed',
		timingQuality: 'known',
		elapsedActiveSeconds: 100,
		receivedAt: 1_000,
		...overrides
	};
}

async function rows(db: AppDb) {
	const ledger = await db.select().from(schema.puzzleCompletionRuns);
	const stats = await db.select().from(schema.puzzleStats);
	return {
		ledger: [...ledger].sort(
			(left, right) =>
				left.playerId.localeCompare(right.playerId) || left.runId.localeCompare(right.runId)
		),
		stats: [...stats].sort(
			(left, right) =>
				left.playerId.localeCompare(right.playerId) || left.puzzleId.localeCompare(right.puzzleId)
		)
	};
}

async function applyWrites(executor: CompletionWriteExecutor, inputs: VersionedCompletionWrite[]) {
	for (const input of inputs) {
		await executor.write(input);
	}
}

describe('createBunDbContext', () => {
	it('records the first run and replays it with the original stored timestamp', async () => {
		const context = bunContext!;
		const first = await context.completionWrites.write(completion());
		await context.db.delete(schema.puzzleStats).run();
		const replay = await context.completionWrites.write(completion({ receivedAt: 9_000 }));

		expect(first).toEqual({
			status: 'stored',
			stored: {
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			},
			inserted: true
		});
		expect(replay).toEqual({
			status: 'stored',
			stored: {
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			},
			inserted: false
		});
		expect(await rows(context.db)).toEqual({
			ledger: [
				{
					playerId: 'p1',
					runId: 'run-1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 100,
					completedAt: 1_000
				}
			],
			stats: [
				{
					playerId: 'p1',
					puzzleId: 'pz1',
					bestTimeSeconds: 100,
					totalCompletions: 0,
					firstCompletedAt: 1_000,
					lastCompletedAt: 1_000
				}
			]
		});
	});

	it('returns stored facts for a conflicting replay without mutating the best', async () => {
		const context = bunContext!;
		await context.completionWrites.write(completion());

		const conflict = await context.completionWrites.write(
			completion({ elapsedActiveSeconds: 50, receivedAt: 2_000 })
		);

		expect(conflict).toEqual({
			status: 'stored',
			stored: {
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 100,
				completedAt: 1_000
			},
			inserted: false
		});
		expect((await rows(context.db)).stats).toEqual([
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

	it('updates only the best on a historical stats row without incrementing its baseline', async () => {
		const context = bunContext!;
		await context.db
			.insert(schema.puzzleStats)
			.values({
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 120,
				totalCompletions: 7,
				firstCompletedAt: 100,
				lastCompletedAt: 900
			})
			.run();

		await context.completionWrites.write(completion());
		await context.completionWrites.write(
			completion({
				runId: 'run-slower',
				elapsedActiveSeconds: 140,
				receivedAt: 2_000
			})
		);

		expect((await rows(context.db)).stats).toEqual([
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

	it('keeps a non-standard completion in the ledger only', async () => {
		const context = bunContext!;

		await context.completionWrites.write(
			completion({
				runId: 'rotation',
				resultClass: 'rotation_timed',
				elapsedActiveSeconds: 120
			})
		);

		expect(await rows(context.db)).toEqual({
			ledger: [
				{
					playerId: 'p1',
					runId: 'rotation',
					puzzleId: 'pz1',
					resultClass: 'rotation_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 120,
					completedAt: 1_000
				}
			],
			stats: []
		});
	});

	it('rolls back the ledger insert when the conditional best write fails', async () => {
		const context = bunContext!;
		const triggerDb = new Database(join(bunDir, 'perseus.db'));
		triggerDb.run(
			"CREATE TRIGGER fail_puzzle_stats_insert BEFORE INSERT ON puzzle_stats BEGIN SELECT RAISE(ABORT, 'forced best failure'); END"
		);
		triggerDb.close();

		await expect(context.completionWrites.write(completion())).rejects.toThrow(
			'forced best failure'
		);

		expect(await rows(context.db)).toEqual({ ledger: [], stats: [] });
	});

	it('deletes ledger and stats rows for one puzzle while retaining companion data', async () => {
		const context = bunContext!;
		await applyWrites(context.completionWrites, [
			completion(),
			completion({
				puzzleId: 'pz2',
				runId: 'run-2',
				elapsedActiveSeconds: 80,
				receivedAt: 2_000
			})
		]);

		await context.completionWrites.deletePuzzleCompletionData('pz1');

		expect(await rows(context.db)).toEqual({
			ledger: [
				{
					playerId: 'p1',
					runId: 'run-2',
					puzzleId: 'pz2',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 80,
					completedAt: 2_000
				}
			],
			stats: [
				{
					playerId: 'p1',
					puzzleId: 'pz2',
					bestTimeSeconds: 80,
					totalCompletions: 0,
					firstCompletedAt: 2_000,
					lastCompletedAt: 2_000
				}
			]
		});
	});

	it('rolls back the stats deletion when the companion ledger deletion fails', async () => {
		const context = bunContext!;
		await context.completionWrites.write(completion());
		const triggerDb = new Database(join(bunDir, 'perseus.db'));
		triggerDb.run(
			"CREATE TRIGGER fail_completion_run_delete BEFORE DELETE ON puzzle_completion_runs BEGIN SELECT RAISE(ABORT, 'forced ledger delete failure'); END"
		);
		triggerDb.close();

		await expect(context.completionWrites.deletePuzzleCompletionData('pz1')).rejects.toThrow(
			'forced ledger delete failure'
		);

		expect((await rows(context.db)).stats).toHaveLength(1);
		expect((await rows(context.db)).ledger).toHaveLength(1);
	});

	it('closes its owned SQLite handle', () => {
		const context = bunContext!;
		context.close();
		bunContext = null;

		expect(() => context.db.select().from(schema.puzzleStats).all()).toThrow();
	});
});

describe('completion write driver parity', () => {
	it.each([0, -1, 1.5, 100_001, Number.NaN])(
		'rejects invalid D1 retained-run limit $limit',
		(limit) => {
			expect(() => createD1CompletionWriteExecutor(d1Db, limit)).toThrow(RangeError);
		}
	);

	it.each([
		{
			name: 'first write and exact replay',
			inputs: [completion(), completion({ receivedAt: 9_000 })]
		},
		{
			name: 'conflicting replay',
			inputs: [completion(), completion({ elapsedActiveSeconds: 50, receivedAt: 2_000 })]
		},
		{
			name: 'non-standard ledger-only write',
			inputs: [
				completion({
					runId: 'rotation',
					resultClass: 'rotation_timed',
					elapsedActiveSeconds: 120
				})
			]
		},
		{
			name: 'distinct canonical runs preserve baseline and minimum best',
			inputs: [
				completion(),
				completion({
					runId: 'run-2',
					elapsedActiveSeconds: 80,
					receivedAt: 2_000
				})
			]
		}
	])('matches normalized D1 rows for $name', async ({ inputs }) => {
		const context = bunContext!;
		await applyWrites(createD1CompletionWriteExecutor(d1Db), inputs);
		await applyWrites(context.completionWrites, inputs);

		expect(await rows(context.db)).toEqual(await rows(d1Db));
	});
});
