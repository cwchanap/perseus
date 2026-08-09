import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../schema';
import { createBunDbContext } from '../drivers/bun';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	clearProfileAvatarUrl,
	clearProfileAvatarUrlIfOwned,
	getAvatarTokensByPlayerIds,
	insertPuzzleOwnership,
	deletePuzzleOwnership,
	deletePuzzleStats,
	setPuzzleStatus,
	listPlayerPuzzles,
	recordVersionedCompletion,
	listPlayerStats,
	getPlayerSummary,
	InvalidPlayerStatsCursorError,
	SYSTEM_OWNER_ID
} from '../repositories';

function makeDb(retainedRunLimit?: number) {
	const dataDir = mkdtempSync(join(tmpdir(), 'perseus-repositories-db-'));
	const context = createBunDbContext(dataDir, retainedRunLimit);
	return {
		...context,
		close() {
			context.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	};
}

function currentCompletion(runId: string, elapsedActiveSeconds: number) {
	return {
		version: 1 as const,
		runId,
		resultClass: 'standard_timed' as const,
		elapsedActiveSeconds
	};
}

describe('repositories', () => {
	let helper: ReturnType<typeof makeDb>;

	beforeEach(() => {
		helper = makeDb();
	});

	afterEach(() => {
		helper.close();
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

	it('clearProfileAvatarUrlIfOwned nulls avatarUrl when avatarUpdateToken matches', async () => {
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-url', 1000, 'token-A');
		await clearProfileAvatarUrlIfOwned(helper.db, 'p1', 'token-A');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.avatarUrl).toBeNull();
	});

	it('clearProfileAvatarUrlIfOwned is a no-op when avatarUpdateToken differs (concurrent overwrite)', async () => {
		// Upload B wrote token-B, then a concurrent upload C overwrote with
		// token-C. B's rollback with owner=token-B must NOT clear C's avatar.
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-B', 1000, 'token-B');
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-C', 2000, 'token-C');
		await clearProfileAvatarUrlIfOwned(helper.db, 'p1', 'token-B');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.avatarUrl).toBe('avatar-C');
	});

	it('clearProfileAvatarUrlIfOwned is a no-op when two uploads share the same millisecond but different tokens', async () => {
		// Regression: Date.now() collision. Two concurrent uploads receive
		// the same timestamp (1000) but different UUID tokens. Upload A's
		// live R2 put fails; its rollback must NOT clear upload B's avatar,
		// even though both wrote the same avatarUpdatedAt.
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-A', 1000, 'token-A');
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-B', 1000, 'token-B');
		await clearProfileAvatarUrlIfOwned(helper.db, 'p1', 'token-A');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.avatarUrl).toBe('avatar-B');
	});

	it('clearProfileAvatarUrlIfOwned clears avatar after displayName update changed updatedAt', async () => {
		await updateProfileAvatarUrl(helper.db, 'p1', 'avatar-url', 1000, 'token-X');
		await updateProfileDisplayName(helper.db, 'p1', 'New Name');
		await clearProfileAvatarUrlIfOwned(helper.db, 'p1', 'token-X');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row?.avatarUrl).toBeNull();
		expect(row?.displayName).toBe('New Name');
	});

	it('clearProfileAvatarUrlIfOwned is a no-op when no row exists', async () => {
		// A missing row means there is nothing to roll back; the conditional
		// UPDATE matches zero rows and does not insert a null-avatar stub.
		await clearProfileAvatarUrlIfOwned(helper.db, 'p1', 'token-none');
		const row = await getProfileOverride(helper.db, 'p1');
		expect(row).toBeNull();
	});

	it('getAvatarTokensByPlayerIds returns empty Map for empty input', async () => {
		const result = await getAvatarTokensByPlayerIds(helper.db, []);
		expect(result.size).toBe(0);
	});

	it('getAvatarTokensByPlayerIds returns tokens for players with profiles', async () => {
		await updateProfileAvatarUrl(helper.db, 'p1', 'url-1', 1000, 'token-A');
		await updateProfileAvatarUrl(helper.db, 'p2', 'url-2', 2000, 'token-B');
		const result = await getAvatarTokensByPlayerIds(helper.db, ['p1', 'p2', 'p3']);
		expect(result.get('p1')).toBe('token-A');
		expect(result.get('p2')).toBe('token-B');
		// p3 has no profile row — not in the Map
		expect(result.has('p3')).toBe(false);
	});

	it('getAvatarTokensByPlayerIds returns null for players with null token', async () => {
		// A profile with displayName but no avatar has a null token
		await updateProfileDisplayName(helper.db, 'p1', 'Name');
		const result = await getAvatarTokensByPlayerIds(helper.db, ['p1']);
		expect(result.get('p1')).toBeNull();
	});

	it('getAvatarTokensByPlayerIds chunks >100 players to stay under D1 bound param limit', async () => {
		// Regression: D1 imposes a 100 bound parameter limit per query.
		// Without chunking, a reaper run with >100 distinct players would
		// throw, fail closed, and skip all deletion. This test creates 120
		// players (exceeding the limit) and verifies the merged map contains
		// every player's token. bun:sqlite's default limit is higher than
		// D1's, so this test validates the chunking logic produces a correct
		// merged result rather than triggering the platform limit.
		const playerIds: string[] = [];
		for (let i = 0; i < 120; i++) {
			const id = `player-${i}`;
			playerIds.push(id);
			await updateProfileAvatarUrl(helper.db, id, `url-${i}`, i * 1000, `token-${i}`);
		}
		// Add a few players with no profile row — they should be absent from
		// the map (not mapped to null), matching the single-query behavior.
		playerIds.push('no-profile-1', 'no-profile-2');
		const result = await getAvatarTokensByPlayerIds(helper.db, playerIds);
		expect(result.size).toBe(120);
		for (let i = 0; i < 120; i++) {
			expect(result.get(`player-${i}`)).toBe(`token-${i}`);
		}
		expect(result.has('no-profile-1')).toBe(false);
		expect(result.has('no-profile-2')).toBe(false);
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

	it('enforces Bun versioned quota after existing-run lookup while preserving usage', async () => {
		helper.close();
		helper = makeDb(3);
		const request = {
			version: 1 as const,
			runId: 'run-1',
			resultClass: 'standard_timed' as const,
			elapsedActiveSeconds: 99
		};

		for (let index = 1; index <= 3; index++) {
			expect(
				await recordVersionedCompletion(
					helper.completionWrites,
					'p1',
					'pz1',
					{
						...request,
						runId: `run-${index}`,
						elapsedActiveSeconds: 100 - index
					},
					index * 1_000
				)
			).toEqual({ status: 'recorded', completedAt: index * 1_000 });
		}

		expect(
			await recordVersionedCompletion(
				helper.completionWrites,
				'p1',
				'pz1',
				{ ...request, runId: 'run-4', elapsedActiveSeconds: 1 },
				4_000
			)
		).toEqual({ status: 'quota_exceeded' });
		expect(
			await recordVersionedCompletion(
				helper.completionWrites,
				'p1',
				'pz1',
				{ ...request, runId: 'run-3', elapsedActiveSeconds: 97 },
				9_000
			)
		).toEqual({ status: 'replayed', completedAt: 3_000 });
		expect(
			await recordVersionedCompletion(
				helper.completionWrites,
				'p1',
				'pz1',
				{ ...request, runId: 'run-3', elapsedActiveSeconds: 1 },
				9_000
			)
		).toEqual({ status: 'conflict' });
		expect(await helper.db.select().from(schema.puzzleCompletionRuns)).toHaveLength(3);
		expect(await helper.db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 3 }
		]);
		expect((await helper.db.select().from(schema.puzzleStats))[0].bestTimeSeconds).toBe(97);
	});

	it('gives the Bun tombstone fence precedence over replay and quota outcomes', async () => {
		helper.close();
		helper = makeDb(3);
		const request = {
			version: 1 as const,
			runId: 'run-1',
			resultClass: 'standard_timed' as const,
			elapsedActiveSeconds: 100
		};

		await recordVersionedCompletion(helper.completionWrites, 'p1', 'pz1', request, 1_000);
		for (let index = 2; index <= 3; index++) {
			await recordVersionedCompletion(
				helper.completionWrites,
				'p1',
				'pz2',
				{ ...request, runId: `run-${index}` },
				index * 1_000
			);
		}
		const originalStats = await helper.db.select().from(schema.puzzleStats);
		await helper.db
			.insert(schema.puzzleDeletionTombstones)
			.values({ puzzleId: 'pz1', deletedAt: 4_000 })
			.run();

		expect(
			await recordVersionedCompletion(helper.completionWrites, 'p1', 'pz1', request, 9_000)
		).toEqual({ status: 'tombstoned' });
		expect(
			await recordVersionedCompletion(
				helper.completionWrites,
				'p1',
				'pz1',
				{ ...request, runId: 'run-4' },
				9_000
			)
		).toEqual({ status: 'tombstoned' });
		expect(await helper.db.select().from(schema.puzzleStats)).toEqual(originalStats);
		expect(await helper.db.select().from(schema.playerCompletionUsage)).toEqual([
			{ playerId: 'p1', retainedRuns: 3 }
		]);
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
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz1',
			currentCompletion('summary-pz1', 50)
		);
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pzX',
			currentCompletion('summary-pzX', 50)
		); // a puzzle not owned by p1
		const summary = await getPlayerSummary(helper.db, 'p1');
		expect(summary).toEqual({ puzzlesUploaded: 1, puzzlesSolved: 2, totalCompletions: 2 });
	});

	it('deletePuzzleStats delegates lifecycle finish for every player row on one puzzle', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'perseus-repositories-'));
		const context = createBunDbContext(dataDir);
		try {
			await context.db.insert(schema.puzzleStats).values([
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
			await context.db.insert(schema.puzzleCompletionRuns).values([
				{
					playerId: 'p1',
					runId: 'run-p1-pz1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 50,
					completedAt: 400
				},
				{
					playerId: 'p2',
					runId: 'run-p2-pz1',
					puzzleId: 'pz1',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 30,
					completedAt: 300
				},
				{
					playerId: 'p1',
					runId: 'run-p1-pz2',
					puzzleId: 'pz2',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 40,
					completedAt: 500
				}
			]);

			await deletePuzzleStats(context.completionWrites, 'pz1');

			expect(await context.db.select().from(schema.puzzleStats)).toEqual([
				{
					playerId: 'p1',
					puzzleId: 'pz2',
					bestTimeSeconds: 40,
					totalCompletions: 1,
					firstCompletedAt: 500,
					lastCompletedAt: 500
				}
			]);
			expect(await context.db.select().from(schema.puzzleCompletionRuns)).toEqual([
				{
					playerId: 'p1',
					runId: 'run-p1-pz2',
					puzzleId: 'pz2',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					elapsedActiveSeconds: 40,
					completedAt: 500
				}
			]);
		} finally {
			context.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it('deletePuzzleStats rolls back the baseline delete when the ledger delete fails', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'perseus-repositories-'));
		const context = createBunDbContext(dataDir);
		try {
			await context.db.insert(schema.puzzleStats).values({
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 50,
				totalCompletions: 4,
				firstCompletedAt: 100,
				lastCompletedAt: 400
			});
			await context.db.insert(schema.puzzleCompletionRuns).values({
				playerId: 'p1',
				runId: 'run-p1-pz1',
				puzzleId: 'pz1',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 50,
				completedAt: 400
			});
			const triggerDb = new Database(join(dataDir, 'perseus.db'));
			triggerDb.run(
				"CREATE TRIGGER fail_completion_run_delete BEFORE DELETE ON puzzle_completion_runs BEGIN SELECT RAISE(ABORT, 'forced ledger delete failure'); END"
			);
			triggerDb.close();

			await expect(deletePuzzleStats(context.completionWrites, 'pz1')).rejects.toThrow(
				'forced ledger delete failure'
			);

			expect(await context.db.select().from(schema.puzzleStats)).toHaveLength(1);
			expect(await context.db.select().from(schema.puzzleCompletionRuns)).toHaveLength(1);
		} finally {
			context.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it('listPlayerStats resolves names for system-owned (admin) puzzles', async () => {
		// Admin-created puzzles are mirrored into D1 with a system sentinel
		// owner so the Puzzle Results join can resolve their name. A player who
		// solves such a puzzle should see the name, not a null fallback.
		await insertPuzzleOwnership(helper.db, {
			id: 'adminPz',
			ownerId: SYSTEM_OWNER_ID,
			name: 'Admin Gallery Puzzle',
			pieceCount: 16,
			status: 'ready',
			createdAt: 1
		});
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'adminPz',
			currentCompletion('admin-puzzle', 42)
		);

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

	it('listPlayerStats accepts a bare best-time cursor', async () => {
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz1',
			currentCompletion('cursor-1', 10)
		);
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz2',
			currentCompletion('cursor-2', 20)
		);
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz3',
			currentCompletion('cursor-3', 30)
		);
		// Bare cursors continue to mean strictly greater best time.
		const result = await listPlayerStats(helper.db, 'p1', { limit: 10, cursor: '20' });
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].puzzleId).toBe('pz3');
	});

	it('listPlayerStats rejects a garbage cursor', async () => {
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz1',
			currentCompletion('garbage-cursor', 10)
		);
		await expect(
			listPlayerStats(helper.db, 'p1', { limit: 10, cursor: 'garbage' })
		).rejects.toBeInstanceOf(InvalidPlayerStatsCursorError);
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
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz1',
			currentCompletion('fractional-1', 10)
		);
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz2',
			currentCompletion('fractional-2', 20)
		);
		await recordVersionedCompletion(
			helper.completionWrites,
			'p1',
			'pz3',
			currentCompletion('fractional-3', 30)
		);
		const result = await listPlayerStats(helper.db, 'p1', { limit: 1.5 });
		expect(result.rows).toHaveLength(1);
		expect(result.nextCursor).toBeDefined();
	});
});

describe('player stats', () => {
	let helper: ReturnType<typeof makeDb>;

	beforeEach(() => {
		helper = makeDb();
	});

	afterEach(() => {
		helper.close();
	});

	it('combines historical baselines and versioned ledger groups without double-counting', async () => {
		await helper.db.insert(schema.puzzles).values([
			{
				id: 'historical',
				ownerId: 'p1',
				name: 'Historical',
				pieceCount: 4,
				status: 'ready',
				createdAt: 1
			},
			{
				id: 'standard',
				ownerId: SYSTEM_OWNER_ID,
				name: 'Standard',
				pieceCount: 4,
				status: 'ready',
				createdAt: 2
			},
			{
				id: 'overlap',
				ownerId: SYSTEM_OWNER_ID,
				name: 'Overlap',
				pieceCount: 4,
				status: 'ready',
				createdAt: 3
			},
			{
				id: 'variant-a',
				ownerId: SYSTEM_OWNER_ID,
				name: 'Variant A',
				pieceCount: 4,
				status: 'ready',
				createdAt: 4
			},
			{
				id: 'variant-b',
				ownerId: SYSTEM_OWNER_ID,
				name: 'Variant B',
				pieceCount: 4,
				status: 'ready',
				createdAt: 5
			}
		]);
		await helper.db.insert(schema.puzzleStats).values([
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
		await helper.db.insert(schema.puzzleCompletionRuns).values([
			{
				playerId: 'p1',
				runId: 'standard-1',
				puzzleId: 'standard',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 40,
				completedAt: 300
			},
			{
				playerId: 'p1',
				runId: 'overlap-1',
				puzzleId: 'overlap',
				resultClass: 'rotation_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 80,
				completedAt: 100
			},
			{
				playerId: 'p1',
				runId: 'overlap-2',
				puzzleId: 'overlap',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 900
			},
			{
				playerId: 'p1',
				runId: 'variant-a-1',
				puzzleId: 'variant-a',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 600
			},
			{
				playerId: 'p1',
				runId: 'variant-b-1',
				puzzleId: 'variant-b',
				resultClass: 'assisted_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 70,
				completedAt: 400
			},
			{
				playerId: 'p1',
				runId: 'variant-b-2',
				puzzleId: 'variant-b',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 800
			},
			{
				playerId: 'other',
				runId: 'other-1',
				puzzleId: 'variant-a',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 50
			}
		]);

		const result = await listPlayerStats(helper.db, 'p1', { limit: 10 });

		expect(result).toEqual({
			rows: [
				{
					playerId: 'p1',
					puzzleId: 'standard',
					puzzleName: 'Standard',
					bestTimeSeconds: 40,
					totalCompletions: 1,
					firstCompletedAt: 300,
					lastCompletedAt: 300
				},
				{
					playerId: 'p1',
					puzzleId: 'overlap',
					puzzleName: 'Overlap',
					bestTimeSeconds: 60,
					totalCompletions: 5,
					firstCompletedAt: 100,
					lastCompletedAt: 900
				},
				{
					playerId: 'p1',
					puzzleId: 'historical',
					puzzleName: 'Historical',
					bestTimeSeconds: 90,
					totalCompletions: 2,
					firstCompletedAt: 200,
					lastCompletedAt: 500
				},
				{
					playerId: 'p1',
					puzzleId: 'variant-a',
					puzzleName: 'Variant A',
					bestTimeSeconds: null,
					totalCompletions: 1,
					firstCompletedAt: 600,
					lastCompletedAt: 600
				},
				{
					playerId: 'p1',
					puzzleId: 'variant-b',
					puzzleName: 'Variant B',
					bestTimeSeconds: null,
					totalCompletions: 2,
					firstCompletedAt: 400,
					lastCompletedAt: 800
				}
			]
		});
	});

	it('uses the combined solved-group and additive completion formula in the summary', async () => {
		await helper.db.insert(schema.puzzles).values({
			id: 'uploaded',
			ownerId: 'p1',
			name: 'Uploaded',
			pieceCount: 4,
			status: 'ready',
			createdAt: 1
		});
		await helper.db.insert(schema.puzzleStats).values([
			{
				playerId: 'p1',
				puzzleId: 'historical',
				bestTimeSeconds: 90,
				totalCompletions: 2,
				firstCompletedAt: 100,
				lastCompletedAt: 200
			},
			{
				playerId: 'p1',
				puzzleId: 'overlap',
				bestTimeSeconds: 60,
				totalCompletions: 3,
				firstCompletedAt: 300,
				lastCompletedAt: 400
			}
		]);
		await helper.db.insert(schema.puzzleCompletionRuns).values([
			{
				playerId: 'p1',
				runId: 'overlap-1',
				puzzleId: 'overlap',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 500
			},
			{
				playerId: 'p1',
				runId: 'variant-1',
				puzzleId: 'variant',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 600
			},
			{
				playerId: 'p1',
				runId: 'variant-2',
				puzzleId: 'variant',
				resultClass: 'rotation_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 75,
				completedAt: 700
			}
		]);

		expect(await getPlayerSummary(helper.db, 'p1')).toEqual({
			puzzlesUploaded: 1,
			puzzlesSolved: 3,
			totalCompletions: 8
		});
	});

	it('continues v2 and legacy cursors across numeric and null-best groups', async () => {
		await helper.db.insert(schema.puzzleStats).values([
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
		await helper.db.insert(schema.puzzleCompletionRuns).values([
			{
				playerId: 'p1',
				runId: 'null-1',
				puzzleId: 'pz-n1',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 400
			},
			{
				playerId: 'p1',
				runId: 'null-2',
				puzzleId: 'pz-n2',
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 500
			}
		]);

		const first = await listPlayerStats(helper.db, 'p1', { limit: 1.5 });
		expect(first.rows.map((row) => row.puzzleId)).toEqual(['pz-a']);
		expect(first.nextCursor).toBe('v2|0|10|pz-a');

		const numericTie = await listPlayerStats(helper.db, 'p1', {
			limit: 10,
			cursor: 'v2|0|10|pz-a'
		});
		expect(numericTie.rows.map((row) => row.puzzleId)).toEqual(['pz-b', 'pz-c', 'pz-n1', 'pz-n2']);

		const crossToNull = await listPlayerStats(helper.db, 'p1', {
			limit: 10,
			cursor: 'v2|0|20|pz-c'
		});
		expect(crossToNull.rows.map((row) => row.puzzleId)).toEqual(['pz-n1', 'pz-n2']);

		const withinNull = await listPlayerStats(helper.db, 'p1', {
			limit: 10,
			cursor: 'v2|1||pz-n1'
		});
		expect(withinNull.rows.map((row) => row.puzzleId)).toEqual(['pz-n2']);

		const legacyComposite = await listPlayerStats(helper.db, 'p1', {
			limit: 10,
			cursor: '10|pz-a'
		});
		expect(legacyComposite.rows.map((row) => row.puzzleId)).toEqual([
			'pz-b',
			'pz-c',
			'pz-n1',
			'pz-n2'
		]);

		const legacyBare = await listPlayerStats(helper.db, 'p1', {
			limit: 10,
			cursor: '10'
		});
		expect(legacyBare.rows.map((row) => row.puzzleId)).toEqual(['pz-c', 'pz-n1', 'pz-n2']);

		const nullCursor = await listPlayerStats(helper.db, 'p1', { limit: 4 });
		expect(nullCursor.nextCursor).toBe('v2|1||pz-n1');

		const zeroLegacy = await listPlayerStats(helper.db, 'p1', {
			limit: 10,
			cursor: '0'
		});
		expect(zeroLegacy.rows).toHaveLength(5);
	});

	it.each([
		['v2 group-0', 'v2|0|9007199254740991|pz-a'],
		['legacy composite', '9007199254740991|pz-a'],
		['legacy bare', '9007199254740991']
	])('accepts Number.MAX_SAFE_INTEGER in a %s cursor', async (_kind, cursor) => {
		const result = await listPlayerStats(helper.db, 'p1', { limit: 10, cursor });

		expect(result.rows).toEqual([]);
	});

	it.each([
		['v2 group-0', 'v2|0|9007199254740992|pz-a'],
		['legacy composite', '9007199254740992|pz-a'],
		['legacy bare', '9007199254740992']
	])('rejects Number.MAX_SAFE_INTEGER + 1 in a %s cursor', async (_kind, cursor) => {
		await expect(listPlayerStats(helper.db, 'p1', { limit: 10, cursor })).rejects.toBeInstanceOf(
			InvalidPlayerStatsCursorError
		);
	});

	it.each([
		'',
		'garbage',
		'01',
		'-1',
		' 1',
		'1 ',
		'1.5',
		'1e2',
		'NaN',
		'Infinity',
		'10|',
		'|pz-a',
		'10|pz-a|extra',
		'v1|0|10|pz-a',
		'v3|0|10|pz-a',
		'v2|2||pz-a',
		'v2|0||pz-a',
		'v2|0|01|pz-a',
		'v2|0|10|',
		'v2|0|10|pz-a|extra',
		'v2|1|10|pz-a',
		'v2|1||'
	])('rejects malformed player stats cursor %j', async (cursor) => {
		await expect(listPlayerStats(helper.db, 'p1', { limit: 10, cursor })).rejects.toBeInstanceOf(
			InvalidPlayerStatsCursorError
		);
	});
});
