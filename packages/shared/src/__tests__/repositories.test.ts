import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../schema';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	insertPuzzleOwnership,
	deletePuzzleOwnership,
	setPuzzleStatus,
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

	it('updateProfileDisplayName preserves an existing avatarUrl', async () => {
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-url');
		await updateProfileDisplayName(helper.db, 'p1', 'Name');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.displayName).toBe('Name');
		expect(row?.avatarUrl).toBe('avatar-url');
	});

	it('updateProfileAvatarUrl preserves an existing displayName', async () => {
		await updateProfileDisplayName(helper.db, 'p1', 'Name');
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-url');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.displayName).toBe('Name');
		expect(row?.avatarUrl).toBe('avatar-url');
	});

	it('updateProfileDisplayName resets to null when passed null', async () => {
		await updateProfileDisplayName(helper.db, 'p1', 'A');
		await updateProfileAvatarUrl(helper.db, 'p1', 'u');
		await updateProfileDisplayName(helper.db, 'p1', null);
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.displayName).toBeNull();
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

	it('deletePuzzleOwnership removes only the targeted row', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'ready',
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
		await deletePuzzleOwnership(helper.db, 'pz1');
		const list = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(1);
		expect(list.rows[0].id).toBe('pz2');
		expect(await countPlayerPuzzles(helper.db, 'p1')).toBe(1);
	});

	it('setPuzzleStatus updates the status of an existing puzzle', async () => {
		// Used in production by the workflows app to flip processing -> ready/failed.
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'processing',
			createdAt: 10
		});
		await setPuzzleStatus(helper.db, 'pz1', 'ready');
		const list = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(1);
		expect(list.rows[0].status).toBe('ready');
	});

	it('setPuzzleStatus only touches the targeted puzzle', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'processing',
			createdAt: 10
		});
		await insertPuzzleOwnership(helper.db, {
			id: 'pz2',
			ownerId: 'p1',
			name: 'Dog',
			pieceCount: 9,
			status: 'processing',
			createdAt: 20
		});
		await setPuzzleStatus(helper.db, 'pz1', 'failed');
		const rows = (await listPlayerPuzzles(helper.db, 'p1', { limit: 10 })).rows;
		const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
		expect(byId).toEqual({ pz1: 'failed', pz2: 'processing' });
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

	it('recordCompletion upserts best time and increments count for spaced solves', async () => {
		// Spaced beyond the dedupe window, each submission is a distinct solve:
		// the count increments and best time tracks the MIN across all of them.
		vi.useFakeTimers();
		try {
			await recordCompletion(helper.db, 'p1', 'pz1', 100);
			vi.advanceTimersByTime(31_000);
			await recordCompletion(helper.db, 'p1', 'pz1', 80);
			vi.advanceTimersByTime(31_000);
			await recordCompletion(helper.db, 'p1', 'pz1', 120);
			const stats = await listPlayerStats(helper.db, 'p1', { limit: 10 });
			expect(stats.rows).toHaveLength(1);
			expect(stats.rows[0].bestTimeSeconds).toBe(80); // MIN of 100, 80, 120
			expect(stats.rows[0].totalCompletions).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('recordCompletion dedupes rapid retries within the window', async () => {
		// A rapid re-POST (e.g. after a lost response or a double-tap) within the
		// dedupe window must NOT inflate the count, but its time is still
		// considered for the best-time MIN.
		vi.useFakeTimers();
		try {
			await recordCompletion(helper.db, 'p1', 'pz1', 100);
			// No time advanced — these are immediate retries.
			await recordCompletion(helper.db, 'p1', 'pz1', 80);
			await recordCompletion(helper.db, 'p1', 'pz1', 120);
			const stats = await listPlayerStats(helper.db, 'p1', { limit: 10 });
			expect(stats.rows).toHaveLength(1);
			expect(stats.rows[0].bestTimeSeconds).toBe(80); // MIN still applied
			expect(stats.rows[0].totalCompletions).toBe(1); // deduped, not 3
		} finally {
			vi.useRealTimers();
		}
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
