import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
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
	const db = drizzle(sqlite, { schema });
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

	it('listPlayerPuzzles isolates players (no cross-player leak on pagination)', async () => {
		// Two players with interleaved createdAt values. Pagination by cursor
		// must NOT drop the ownerId filter (regression guard).
		for (let i = 0; i < 3; i++) {
			await insertPuzzleOwnership(helper.db, {
				id: `a${i}`,
				ownerId: 'alice',
				name: `A${i}`,
				pieceCount: 4,
				status: 'ready',
				createdAt: i * 10
			});
			await insertPuzzleOwnership(helper.db, {
				id: `b${i}`,
				ownerId: 'bob',
				name: `B${i}`,
				pieceCount: 4,
				status: 'ready',
				createdAt: i * 10 + 1
			});
		}
		const page1 = await listPlayerPuzzles(helper.db, 'alice', { limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.rows.every((r) => r.ownerId === 'alice')).toBe(true);
		expect(page1.nextCursor).toBeDefined();
		const page2 = await listPlayerPuzzles(helper.db, 'alice', {
			limit: 2,
			cursor: page1.nextCursor!
		});
		expect(page2.rows).toHaveLength(1);
		expect(page2.rows.every((r) => r.ownerId === 'alice')).toBe(true);
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
