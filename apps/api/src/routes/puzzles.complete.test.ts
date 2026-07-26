import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const { legacyDb, completionWrites } = vi.hoisted(() => ({
	legacyDb: {},
	completionWrites: {
		write: vi.fn(),
		deletePuzzleCompletionData: vi.fn()
	}
}));

vi.mock('../db', () => ({
	getDb: vi.fn(() => legacyDb),
	getDbContext: vi.fn(() => ({ db: legacyDb, completionWrites }))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const completions = new Map<string, number[]>();
	return {
		...actual,
		__completions: completions,
		recordLegacyCompletion: vi.fn(
			async (db: unknown, playerId: string, _puzzleId: string, time: number) => {
				const arr = completions.get(playerId) ?? [];
				arr.push(time);
				completions.set(playerId, arr);
			}
		),
		recordVersionedCompletion: vi.fn(async () => ({
			status: 'recorded' as const,
			completedAt: 100
		})),
		// Stub the backfill so it doesn't hit the mock DB ({}). The route calls
		// this best-effort before either completion repository.
		ensurePuzzleOwnership: vi.fn(async () => {}),
		SYSTEM_OWNER_ID: actual.SYSTEM_OWNER_ID
	};
});

vi.mock('../services/storage', () => ({
	getPuzzle: vi.fn().mockResolvedValue({
		id: 'pz',
		name: 'Test Puzzle',
		pieceCount: 4,
		createdAt: 100,
		status: 'ready'
	} as never)
}));

vi.mock('./puzzle-ready', () => ({
	isPuzzleReady: vi.fn().mockReturnValue(true)
}));

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import complete from '../routes/puzzles.complete';
import * as playerAuth from '../services/player-auth';
import * as storage from '../services/storage';
import * as puzzleReady from './puzzle-ready';
import {
	recordLegacyCompletion,
	recordVersionedCompletion,
	ensurePuzzleOwnership,
	SYSTEM_OWNER_ID
} from '@perseus/shared';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
import type { PlayerSessionRecord } from '../services/player-auth';

const TEST_PLAYER: PlayerSessionRecord = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'P',
		picture: 'p.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'h',
	createdAt: 1,
	expiresAt: 9999999999999
};

const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };
// A valid UUIDv4 (puzzle IDs are crypto.randomUUID()); 'pz1' is rejected by the
// format check, so tests that exercise the happy path use this instead.
const PUZZLE_ID = '123e4567-e89b-42d3-a456-426614174000';
const RUN_ID = '223e4567-e89b-42d3-a456-426614174000';

const VERSIONED_CASES: { name: string; request: RecordPuzzleCompletionV1 }[] = [
	{
		name: 'known standard timed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 91
		}
	},
	{
		name: 'known rotation timed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'rotation_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 92
		}
	},
	{
		name: 'known assisted timed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'assisted_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 93
		}
	},
	{
		name: 'known relaxed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'relaxed',
			timingQuality: 'known',
			elapsedActiveSeconds: null
		}
	},
	{
		name: 'legacy-unknown standard timed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'legacy_unknown',
			elapsedActiveSeconds: null
		}
	},
	{
		name: 'legacy-unknown rotation timed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'rotation_timed',
			timingQuality: 'legacy_unknown',
			elapsedActiveSeconds: null
		}
	},
	{
		name: 'legacy-unknown assisted timed',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'assisted_timed',
			timingQuality: 'legacy_unknown',
			elapsedActiveSeconds: null
		}
	}
];

const MALFORMED_VERSIONED_CASES: { name: string; request: unknown }[] = [
	{
		name: 'unsupported version never falls back to timeSeconds',
		request: { version: 2, timeSeconds: 90 }
	},
	{
		name: 'missing run ID',
		request: {
			version: 1,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 90
		}
	},
	{
		name: 'unknown result class',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'unknown',
			timingQuality: 'known',
			elapsedActiveSeconds: 90
		}
	},
	{
		name: 'legacy-unknown relaxed result',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'relaxed',
			timingQuality: 'legacy_unknown',
			elapsedActiveSeconds: null
		}
	},
	{
		name: 'known timed result with null timing',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: null
		}
	},
	{
		name: 'fractional active time',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 90.7
		}
	},
	{
		name: 'active time above the legacy ceiling',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 86_401
		}
	},
	{
		name: 'extra field',
		request: {
			version: 1,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 90,
			timeSeconds: 90
		}
	}
];

function buildApp() {
	const app = new Hono();
	app.route('/api/puzzles', complete);
	return app;
}

function jsonHeaders() {
	return { 'Content-Type': 'application/json', ...AUTH_COOKIE };
}

describe('POST /api/puzzles/:id/complete (Bun)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: PUZZLE_ID,
			name: 'Test Puzzle',
			pieceCount: 4,
			createdAt: 100,
			status: 'ready'
		} as never);
		vi.mocked(puzzleReady.isPuzzleReady).mockReturnValue(true);
		// Reset call history on every asserted mock so each test only reflects
		// its own requests (the not.toHaveBeenCalled() assertions depend on this).
		vi.mocked(storage.getPuzzle).mockClear();
		vi.mocked(puzzleReady.isPuzzleReady).mockClear();
		vi.mocked(recordLegacyCompletion).mockClear();
		vi.mocked(recordVersionedCompletion).mockReset();
		vi.mocked(recordVersionedCompletion).mockResolvedValue({
			status: 'recorded',
			completedAt: 100
		});
		vi.mocked(ensurePuzzleOwnership).mockClear();
	});

	it('records an exact legacy completion through the legacy repository', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(recordLegacyCompletion).toHaveBeenCalledWith(legacyDb, 'p1', PUZZLE_ID, 90);
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('backfills a system-owned puzzle row before recording the completion', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);
		// The backfill is invoked with a system-owned row built from the loaded
		// puzzle metadata, so listPlayerStats can later resolve the name.
		expect(ensurePuzzleOwnership).toHaveBeenCalledWith(expect.anything(), {
			id: PUZZLE_ID,
			ownerId: SYSTEM_OWNER_ID,
			name: 'Test Puzzle',
			pieceCount: 4,
			status: 'ready',
			createdAt: 100
		});
		// Backfill must happen before the stat write so a missing row never
		// coexists with a recorded completion.
		const backfillOrder = vi.mocked(ensurePuzzleOwnership).mock.invocationCallOrder[0];
		const recordOrder = vi.mocked(recordLegacyCompletion).mock.invocationCallOrder[0];
		expect(backfillOrder).toBeLessThan(recordOrder);
	});

	it('still records the completion when the ownership backfill fails (best-effort)', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(ensurePuzzleOwnership).mockRejectedValueOnce(new Error('D1 down'));
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);
		expect(recordLegacyCompletion).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('includes the puzzle category in the ownership backfill when present', async () => {
		// Covers the `puzzle.category ? { category } : {}` true branch: a
		// puzzle with a category must propagate it into the backfilled row so
		// listPlayerStats can surface it.
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: PUZZLE_ID,
			name: 'Categorized Puzzle',
			pieceCount: 4,
			createdAt: 100,
			status: 'ready',
			category: 'nature'
		} as never);
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);
		expect(ensurePuzzleOwnership).toHaveBeenCalledWith(expect.anything(), {
			id: PUZZLE_ID,
			ownerId: SYSTEM_OWNER_ID,
			name: 'Categorized Puzzle',
			pieceCount: 4,
			category: 'nature',
			status: 'ready',
			createdAt: 100
		});
	});

	it('rejects a malformed puzzle id with 400', async () => {
		const res = await buildApp().request('/api/puzzles/not-a-uuid/complete', {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(400);
		expect(storage.getPuzzle).not.toHaveBeenCalled();
	});

	it('rejects a non-v4 UUID with 400', async () => {
		// UUIDv1 (version digit is 1, not 4)
		const res = await buildApp().request(
			'/api/puzzles/123e4567-e89b-12d3-a456-426614174000/complete',
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify({ timeSeconds: 90 })
			}
		);
		expect(res.status).toBe(400);
	});

	it('returns 404 when the puzzle does not exist', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(404);
		expect(recordLegacyCompletion).not.toHaveBeenCalled();
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('returns 500 with a structured error when getPuzzle throws (corrupt metadata)', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(storage.getPuzzle).mockRejectedValueOnce(new Error('Corrupt JSON'));
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to retrieve puzzle');
		expect(recordLegacyCompletion).not.toHaveBeenCalled();
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('returns 404 when the puzzle is not ready', async () => {
		vi.mocked(puzzleReady.isPuzzleReady).mockReturnValueOnce(false);
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(404);
		expect(recordLegacyCompletion).not.toHaveBeenCalled();
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('rejects non-numeric timeSeconds', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 'fast' })
		});
		expect(res.status).toBe(400);
	});

	it('rejects missing timeSeconds', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({})
		});
		expect(res.status).toBe(400);
	});

	it('rejects legacy compatibility input with extra fields', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90, resultClass: 'standard_timed' })
		});
		expect(res.status).toBe(400);
		expect(recordLegacyCompletion).not.toHaveBeenCalled();
	});

	it('rejects negative timeSeconds', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: -5 })
		});
		expect(res.status).toBe(400);
	});

	it('rejects timeSeconds above the 24h sanity ceiling', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 24 * 60 * 60 + 1 })
		});
		expect(res.status).toBe(400);
		expect(storage.getPuzzle).not.toHaveBeenCalled();
	});

	it('rejects invalid JSON body with 400', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: 'not-json'
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({ error: 'bad_request' });
	});

	it('requires authentication', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(401);
	});

	it('floors fractional timeSeconds', async () => {
		await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90.7 })
		});
		expect(recordLegacyCompletion).toHaveBeenCalledWith(legacyDb, 'p1', PUZZLE_ID, 90);
	});

	it.each(VERSIONED_CASES)('records $name without rewriting fields', async ({ request }) => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify(request)
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(recordVersionedCompletion).toHaveBeenCalledWith(
			completionWrites,
			'p1',
			PUZZLE_ID,
			request
		);
		expect(recordLegacyCompletion).not.toHaveBeenCalled();
	});

	it('returns 200 for an exact versioned replay', async () => {
		vi.mocked(recordVersionedCompletion).mockResolvedValueOnce({
			status: 'replayed',
			completedAt: 50
		});
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify(VERSIONED_CASES[0].request)
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns structured 409 for a versioned run ID conflict', async () => {
		vi.mocked(recordVersionedCompletion).mockResolvedValueOnce({ status: 'conflict' });
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify(VERSIONED_CASES[0].request)
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'run_id_conflict' });
	});

	it.each(MALFORMED_VERSIONED_CASES)(
		'rejects malformed versioned request: $name',
		async ({ request }) => {
			const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(request)
			});

			expect(res.status).toBe(400);
			expect(storage.getPuzzle).not.toHaveBeenCalled();
			expect(recordLegacyCompletion).not.toHaveBeenCalled();
			expect(recordVersionedCompletion).not.toHaveBeenCalled();
		}
	);

	it('returns structured 500 when the legacy repository fails', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(recordLegacyCompletion).mockRejectedValueOnce(new Error('legacy write failed'));
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: 'internal_error' });
		consoleSpy.mockRestore();
	});

	it('returns structured 500 when the versioned executor fails', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(recordVersionedCompletion).mockRejectedValueOnce(new Error('executor failed'));
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify(VERSIONED_CASES[0].request)
		});

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: 'internal_error' });
		consoleSpy.mockRestore();
	});
});
