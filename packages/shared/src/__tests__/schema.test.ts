import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { playerProfiles, puzzleCompletionRuns, puzzleStats, puzzles } from '../schema';

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
});
