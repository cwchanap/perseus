import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../schema';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	clearProfileAvatarUrl,
	insertPuzzleOwnership,
	deletePuzzleOwnership,
	deletePuzzleStats,
	setPuzzleStatus,
	listPlayerPuzzles,
	recordCompletion,
	listPlayerStats,
	getPlayerSummary,
	SYSTEM_OWNER_ID
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

	it('clearProfileAvatarUrl nulls avatarUrl while preserving displayName', async () => {
		await updateProfileDisplayName(helper.db, 'p1', 'Name');
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-url');
		await clearProfileAvatarUrl(helper.db, 'p1');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.avatarUrl).toBeNull();
		expect(row?.displayName).toBe('Name');
	});

	it('clearProfileAvatarUrl on a fresh profile inserts a null-avatar row', async () => {
		await clearProfileAvatarUrl(helper.db, 'p1');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row).toBeDefined();
		expect(row?.avatarUrl).toBeNull();
	});

	it('insertPuzzleOwnership + list/count', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			category: 'Animals',
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
		const list = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(list.rows).toHaveLength(2);
		expect(list.rows[0].id).toBe('pz2'); // newest first
		expect((await getPlayerSummary(helper.db, 'p1')).puzzlesUploaded).toBe(2);
	});

	it('list/count include processing, ready, and failed', async () => {
		// All three statuses appear in the player's list and count. A
		// 'processing' puzzle is an in-flight upload: puzzles.worker.ts writes
		// the ownership row with status 'processing' before starting the
		// workflow, and PuzzleCard.svelte renders it as a non-clickable card
		// with a PROCESSING… overlay, so it must stay visible to its owner
		// until it reaches a terminal state.
		await insertPuzzleOwnership(helper.db, {
			id: 'pzProcessing',
			ownerId: 'p1',
			name: 'Generating',
			pieceCount: 4,
			status: 'processing',
			createdAt: 10
		});
		await insertPuzzleOwnership(helper.db, {
			id: 'pzReady',
			ownerId: 'p1',
			name: 'Ready',
			pieceCount: 9,
			status: 'ready',
			createdAt: 20
		});
		await insertPuzzleOwnership(helper.db, {
			id: 'pzFailed',
			ownerId: 'p1',
			name: 'Failed',
			pieceCount: 16,
			status: 'failed',
			createdAt: 30
		});
		const list = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(list.rows.map((r) => r.id)).toEqual(['pzFailed', 'pzReady', 'pzProcessing']);
		expect((await getPlayerSummary(helper.db, 'p1')).puzzlesUploaded).toBe(3);
		// Flipping the processing puzzle to ready keeps it visible in both views.
		await setPuzzleStatus(helper.db, 'pzProcessing', 'ready');
		const list2 = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(list2.rows.map((r) => r.id)).toEqual(['pzFailed', 'pzReady', 'pzProcessing']);
		expect((await getPlayerSummary(helper.db, 'p1')).puzzlesUploaded).toBe(3);
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
		expect((await getPlayerSummary(helper.db, 'p1')).puzzlesUploaded).toBe(1);
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
			status: 'ready',
			createdAt: 20
		});
		await setPuzzleStatus(helper.db, 'pz1', 'failed');
		const rows = (await listPlayerPuzzles(helper.db, 'p1', { limit: 10 })).rows;
		const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
		// pz1 flipped to failed; pz2 untouched at ready. Both appear.
		expect(byId).toEqual({ pz1: 'failed', pz2: 'ready' });
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

	it('deletePuzzleStats removes all players stat rows for a puzzle', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		await insertPuzzleOwnership(helper.db, {
			id: 'pz2',
			ownerId: 'p1',
			name: 'Dog',
			pieceCount: 9,
			status: 'ready',
			createdAt: 2
		});
		await recordCompletion(helper.db, 'p1', 'pz1', 50);
		await recordCompletion(helper.db, 'p2', 'pz1', 30);
		await recordCompletion(helper.db, 'p1', 'pz2', 40);

		await deletePuzzleStats(helper.db, 'pz1');

		const p1Stats = await listPlayerStats(helper.db, 'p1', { limit: 10 });
		const p2Stats = await listPlayerStats(helper.db, 'p2', { limit: 10 });
		// Only pz2's stat row remains for p1; p2's stats are fully cleared.
		expect(p1Stats.rows).toHaveLength(1);
		expect(p1Stats.rows[0].puzzleId).toBe('pz2');
		expect(p2Stats.rows).toHaveLength(0);
	});

	it('listPlayerStats resolves names for system-owned (admin) puzzles', async () => {
		// Admin-created puzzles are mirrored into D1 with a system sentinel
		// owner so the Best Times join can resolve their name. A player who
		// solves such a puzzle should see the name, not a null fallback.
		await insertPuzzleOwnership(helper.db, {
			id: 'adminPz',
			ownerId: SYSTEM_OWNER_ID,
			name: 'Admin Gallery Puzzle',
			pieceCount: 16,
			status: 'ready',
			createdAt: 1
		});
		await recordCompletion(helper.db, 'p1', 'adminPz', 42);

		const { rows } = await listPlayerStats(helper.db, 'p1', { limit: 10 });
		expect(rows).toHaveLength(1);
		expect(rows[0].puzzleName).toBe('Admin Gallery Puzzle');
		// System-owned row must not leak into the player's own puzzle list/count.
		expect((await getPlayerSummary(helper.db, 'p1')).puzzlesUploaded).toBe(0);
		const own = await listPlayerPuzzles(helper.db, 'p1', { limit: 10 });
		expect(own.rows).toHaveLength(0);
	});

	it('listPlayerPuzzles malformed cursor falls back to timestamp-only filter', async () => {
		for (let i = 0; i < 3; i++) {
			await insertPuzzleOwnership(helper.db, {
				id: `pz${i}`,
				ownerId: 'p1',
				name: `N${i}`,
				pieceCount: 4,
				status: 'ready',
				createdAt: i * 10
			});
		}
		// Malformed cursor with no '|' separator: falls back to treating the
		// whole string as a createdAt timestamp. "10" → rows with createdAt < 10.
		const result = await listPlayerPuzzles(helper.db, 'p1', { limit: 10, cursor: '10' });
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].id).toBe('pz0');
	});

	it('listPlayerPuzzles garbage cursor returns no rows', async () => {
		await insertPuzzleOwnership(helper.db, {
			id: 'pz1',
			ownerId: 'p1',
			name: 'Cat',
			pieceCount: 4,
			status: 'ready',
			createdAt: 10
		});
		// Non-numeric, no separator → sql`false` → no rows match.
		const result = await listPlayerPuzzles(helper.db, 'p1', { limit: 10, cursor: 'garbage' });
		expect(result.rows).toHaveLength(0);
	});

	it('listPlayerStats malformed cursor falls back to bestTime-only filter', async () => {
		await recordCompletion(helper.db, 'p1', 'pz1', 10);
		await recordCompletion(helper.db, 'p1', 'pz2', 20);
		await recordCompletion(helper.db, 'p1', 'pz3', 30);
		// Malformed cursor with no '|' separator: falls back to treating the
		// whole string as a bestTimeSeconds value. Stats are ordered ASC, so
		// "after" means strictly greater. "20" → rows with bestTime > 20.
		const result = await listPlayerStats(helper.db, 'p1', { limit: 10, cursor: '20' });
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].puzzleId).toBe('pz3');
	});

	it('listPlayerStats garbage cursor returns no rows', async () => {
		await recordCompletion(helper.db, 'p1', 'pz1', 10);
		// Non-numeric, no separator → sql`false` → no rows match.
		const result = await listPlayerStats(helper.db, 'p1', { limit: 10, cursor: 'garbage' });
		expect(result.rows).toHaveLength(0);
	});

	it('listPlayerPuzzles floors fractional limits to an integer', async () => {
		// A fractional limit (e.g. from ?limit=1.5) must be floored before
		// binding to SQL LIMIT, otherwise SQLite/D1 rejects the non-integer
		// with a datatype error. 1.5 floors to 1, so only one row is returned.
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
		const result = await listPlayerPuzzles(helper.db, 'p1', { limit: 1.5 });
		expect(result.rows).toHaveLength(1);
		expect(result.nextCursor).toBeDefined();
	});

	it('listPlayerStats floors fractional limits to an integer', async () => {
		await recordCompletion(helper.db, 'p1', 'pz1', 10);
		await recordCompletion(helper.db, 'p1', 'pz2', 20);
		await recordCompletion(helper.db, 'p1', 'pz3', 30);
		const result = await listPlayerStats(helper.db, 'p1', { limit: 1.5 });
		expect(result.rows).toHaveLength(1);
		expect(result.nextCursor).toBeDefined();
	});
});
