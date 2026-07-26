/**
 * Cross-runtime drift guard: runs the same request against the Bun and
 * Cloudflare Worker route implementations and asserts equivalent behavior.
 *
 * The API has parallel implementations for two runtimes (player.ts vs
 * player.worker.ts, admin.ts vs admin.worker.ts). Shared logic lives in
 * @perseus/shared and @perseus/types, but the route handlers themselves are
 * duplicated and can silently drift — e.g. one runtime gaining a validation
 * guard the other lacks. This test pins invariants that must hold in BOTH
 * runtimes so a future edit to one without the other fails here.
 *
 * Currently covers:
 *  - Avatar upload dimension cap (MAX_AVATAR_DIMENSION): both runtimes reject
 *    an image whose header dimensions exceed the cap with the same 400 shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { CompletionWriteExecutor } from '@perseus/shared';

// --- Mocks shared by both runtimes ---------------------------------------

const completionWrites = vi.hoisted(
	() =>
		({
			write: vi.fn(),
			writeLegacy: vi.fn(),
			beginPuzzleDeletion: vi.fn(),
			finishPuzzleDeletion: vi.fn(),
			isPuzzleTombstoned: vi.fn()
		}) as unknown as CompletionWriteExecutor
);

// Both route modules resolve their DB through a runtime-specific singleton
// that loads a runtime-only SQLite builtin. Mock both so neither loads under
// vitest/node.
vi.mock('../db', () => ({
	getDb: vi.fn(() => ({})),
	getDbContext: vi.fn(() => ({ db: {}, completionWrites }))
}));
vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({})),
	getWorkerDbContext: vi.fn(() => ({ db: {}, completionWrites }))
}));

// Shared repositories: keep the real image utilities (sniffImageType,
// parseImageDimensions, validateImageEndMarker) so the dimension cap is
// exercised against real header parsing. Override only the profile/list
// repositories with in-memory stubs so neither route touches a real DB.
vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		getProfileOverride: vi.fn(() => null),
		updateProfileDisplayName: vi.fn(() => undefined),
		updateProfileAvatarUrl: vi.fn(() => undefined),
		clearProfileAvatarUrl: vi.fn(async () => undefined),
		clearProfileAvatarUrlIfOwned: vi.fn(async () => undefined),
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		})),
		listPlayerPuzzles: vi.fn(async () => ({ rows: [], nextCursor: undefined })),
		listPlayerStats: vi.fn(async () => ({ rows: [] })),
		recordLegacyCompletion: vi.fn(async () => ({ status: 'recorded' as const })),
		recordVersionedCompletion: vi.fn(async () => ({
			status: 'recorded' as const,
			completedAt: 100
		})),
		ensurePuzzleOwnership: vi.fn(async () => undefined)
	};
});

// Auth: each runtime has its own session resolver. Mock both to resolve a
// fixed test player so requirePlayerAuth passes end-to-end.
vi.mock('../services/player-auth', () => ({ getPlayerSession: vi.fn() }));
vi.mock('../services/player-auth.worker', () => ({ getPlayerSession: vi.fn() }));
vi.mock('../services/storage', () => ({ getPuzzle: vi.fn() }));
vi.mock('../services/storage.worker', () => ({ getPuzzle: vi.fn() }));
vi.mock('./puzzle-ready', () => ({ isPuzzleReady: vi.fn() }));

import playerBun from './player';
import playerWorker from './player.worker';
import completionBun from './puzzles.complete';
import completionWorker from './puzzles.complete.worker';
import * as playerAuthBun from '../services/player-auth';
import * as playerAuthWorker from '../services/player-auth.worker';
import * as storageBun from '../services/storage';
import * as storageWorker from '../services/storage.worker';
import * as puzzleReady from './puzzle-ready';
import * as completionShared from './puzzles.complete.shared';
import {
	recordLegacyCompletion,
	recordVersionedCompletion,
	ensurePuzzleOwnership
} from '@perseus/shared';
import type { PlayerSessionRecord } from '../services/player-auth';
import type { Env } from '../worker';

const TEST_PLAYER: PlayerSessionRecord = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'Google Name',
		picture: 'g.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'h',
	createdAt: 1,
	expiresAt: 9999999999999
};

const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };
const PUZZLE_ID = '123e4567-e89b-42d3-a456-426614174000';
const VERSIONED_REQUEST = {
	version: 1,
	runId: '223e4567-e89b-42d3-a456-426614174000',
	resultClass: 'standard_timed',
	timingQuality: 'known',
	elapsedActiveSeconds: 90
} as const;

// Minimal PNG with width=600, height=600 (exceeds MAX_AVATAR_DIMENSION=512).
// PNG signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4) +
// IEND chunk (12) = 36 bytes. parseImageDimensions reads bytes 16–24 for
// dimensions; the dimension cap fires before validateImageEndMarker, so the
// IEND chunk is included only to keep the rejection unambiguously about dims.
function oversizedPngBytes(): Uint8Array {
	// width=600 (0x00000258), height=600 — exceeds MAX_AVATAR_DIMENSION (512).
	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a, // PNG signature
		0x00,
		0x00,
		0x00,
		0x0d, // IHDR chunk length = 13
		0x49,
		0x48,
		0x44,
		0x52, // "IHDR"
		0x00,
		0x00,
		0x02,
		0x58, // width = 600
		0x00,
		0x00,
		0x02,
		0x58, // height = 600
		0x00,
		0x00,
		0x00,
		0x00,
		0x49,
		0x45,
		0x4e,
		0x44,
		0xae,
		0x42,
		0x60,
		0x82 // IEND
	]);
}

function avatarRequest(): Request {
	const form = new FormData();
	form.append('avatar', new Blob([oversizedPngBytes()], { type: 'image/png' }), 'big.png');
	return new Request('http://localhost/api/player/avatar', {
		method: 'POST',
		headers: AUTH_COOKIE,
		body: form
	});
}

describe('cross-runtime drift: avatar dimension cap (Bun ↔ Worker)', () => {
	beforeEach(() => {
		vi.mocked(playerAuthBun.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		vi.mocked(playerAuthWorker.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('Bun runtime rejects oversized avatar dimensions with 400', async () => {
		const app = new Hono();
		app.route('/api/player', playerBun);
		const res = await app.request(avatarRequest(), {});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('bad_request');
		expect(body.message).toMatch(/512px or less/i);
	});

	it('Worker runtime rejects oversized avatar dimensions with 400', async () => {
		const app = new Hono<{
			Bindings: Env;
			Variables: { playerSession: PlayerSessionRecord };
		}>();
		app.route('/api/player', playerWorker);
		// The Worker route reads c.env.PUZZLES_BUCKET, but the dimension cap
		// fires before any R2 access, so a minimal env is sufficient.
		const env = { PUZZLES_BUCKET: {} as R2Bucket } as unknown as Env;
		const res = await app.request(avatarRequest(), {}, env);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('bad_request');
		expect(body.message).toMatch(/512px or less/i);
	});

	it('both runtimes return the same error shape for oversized dimensions', async () => {
		const bunApp = new Hono();
		bunApp.route('/api/player', playerBun);
		const workerApp = new Hono<{
			Bindings: Env;
			Variables: { playerSession: PlayerSessionRecord };
		}>();
		workerApp.route('/api/player', playerWorker);
		const env = { PUZZLES_BUCKET: {} as R2Bucket } as unknown as Env;

		const [bunRes, workerRes] = await Promise.all([
			bunApp.request(avatarRequest(), {}),
			workerApp.request(avatarRequest(), {}, env)
		]);

		expect(bunRes.status).toBe(workerRes.status);
		const bunBody = (await bunRes.json()) as { error: string; message: string };
		const workerBody = (await workerRes.json()) as { error: string; message: string };
		expect(bunBody.error).toBe(workerBody.error);
		expect(bunBody.message).toBe(workerBody.message);
	});
});

function buildCompletionApps() {
	const bun = new Hono();
	bun.route('/api/puzzles', completionBun);
	const worker = new Hono<{
		Bindings: Env;
		Variables: { playerSession: PlayerSessionRecord };
	}>();
	worker.route('/api/puzzles', completionWorker);
	return { bun, worker };
}

async function postCompletionToBoth(
	body: unknown,
	headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...AUTH_COOKIE
	}
) {
	const { bun, worker } = buildCompletionApps();
	const init = {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	};
	const env = { DB: {}, PUZZLE_METADATA: {} } as unknown as Env;
	return Promise.all([
		bun.request(`/api/puzzles/${PUZZLE_ID}/complete`, init),
		worker.request(`/api/puzzles/${PUZZLE_ID}/complete`, init, env)
	]);
}

describe('cross-runtime drift: completion route (Bun ↔ Worker)', () => {
	beforeEach(() => {
		vi.mocked(playerAuthBun.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		vi.mocked(playerAuthWorker.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		vi.mocked(storageBun.getPuzzle).mockResolvedValue({
			id: PUZZLE_ID,
			name: 'Test Puzzle',
			pieceCount: 4,
			createdAt: 100,
			status: 'ready'
		} as never);
		vi.mocked(storageWorker.getPuzzle).mockResolvedValue({
			id: PUZZLE_ID,
			name: 'Test Puzzle',
			pieceCount: 4,
			createdAt: 100,
			status: 'ready'
		} as never);
		vi.mocked(puzzleReady.isPuzzleReady).mockReturnValue(true);
		vi.mocked(recordLegacyCompletion).mockReset();
		vi.mocked(recordLegacyCompletion).mockResolvedValue({ status: 'recorded' });
		vi.mocked(recordVersionedCompletion).mockReset();
		vi.mocked(recordVersionedCompletion).mockResolvedValue({
			status: 'recorded',
			completedAt: 100
		});
		vi.mocked(ensurePuzzleOwnership).mockClear();
	});

	it.each([
		{ name: 'legacy accepted', body: { timeSeconds: 90 }, status: 200 },
		{ name: 'versioned accepted', body: VERSIONED_REQUEST, status: 200 },
		{
			name: 'invalid versioned input does not fall back to legacy',
			body: { version: 2, timeSeconds: 90 },
			status: 400
		}
	])('keeps the $name response code aligned', async ({ body, status }) => {
		const responses = await postCompletionToBoth(body);
		expect(responses.map((response) => response.status)).toEqual([status, status]);
	});

	it('routes both runtimes through the shared parser and result mapper', async () => {
		const parserSpy = vi.spyOn(completionShared, 'parseCompletionRequest');
		const resultSpy = vi.spyOn(completionShared, 'completionResultToResponse');
		const responses = await postCompletionToBoth(VERSIONED_REQUEST);

		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(parserSpy).toHaveBeenCalledTimes(2);
		expect(resultSpy).toHaveBeenCalledTimes(2);
		parserSpy.mockRestore();
		resultSpy.mockRestore();
	});

	it('keeps replay and conflict response codes and bodies aligned', async () => {
		vi.mocked(recordVersionedCompletion)
			.mockResolvedValueOnce({ status: 'replayed', completedAt: 50 })
			.mockResolvedValueOnce({ status: 'replayed', completedAt: 50 });
		const replayResponses = await postCompletionToBoth(VERSIONED_REQUEST);
		expect(replayResponses.map((response) => response.status)).toEqual([200, 200]);
		expect(await Promise.all(replayResponses.map((response) => response.json()))).toEqual([
			{ ok: true },
			{ ok: true }
		]);

		vi.mocked(recordVersionedCompletion)
			.mockResolvedValueOnce({ status: 'conflict' })
			.mockResolvedValueOnce({ status: 'conflict' });
		const conflictResponses = await postCompletionToBoth(VERSIONED_REQUEST);
		expect(conflictResponses.map((response) => response.status)).toEqual([409, 409]);
		const conflictBodies = await Promise.all(conflictResponses.map((response) => response.json()));
		expect(conflictBodies[0]).toEqual(conflictBodies[1]);
		expect(conflictBodies[0]).toMatchObject({ error: 'run_id_conflict' });
	});

	it.each([
		{
			name: 'tombstone',
			outcome: { status: 'tombstoned' as const },
			status: 404,
			body: { error: 'not_found', message: 'Puzzle not found' }
		},
		{
			name: 'quota',
			outcome: { status: 'quota_exceeded' as const },
			status: 429,
			body: {
				error: 'completion_quota_exceeded',
				message: 'Completion history limit reached'
			}
		}
	])('keeps the versioned $name branch aligned', async ({ outcome, status, body }) => {
		vi.mocked(recordVersionedCompletion)
			.mockResolvedValueOnce(outcome)
			.mockResolvedValueOnce(outcome);

		const responses = await postCompletionToBoth(VERSIONED_REQUEST);

		expect(responses.map((response) => response.status)).toEqual([status, status]);
		expect(await Promise.all(responses.map((response) => response.json()))).toEqual([body, body]);
	});

	it('keeps structured repository failure responses aligned', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const internalErrorSpy = vi.spyOn(completionShared, 'completionInternalErrorResponse');
		vi.mocked(recordVersionedCompletion)
			.mockRejectedValueOnce(new Error('Bun write failed'))
			.mockRejectedValueOnce(new Error('Worker write failed'));
		const responses = await postCompletionToBoth(VERSIONED_REQUEST);
		expect(responses.map((response) => response.status)).toEqual([500, 500]);
		const bodies = await Promise.all(responses.map((response) => response.json()));
		expect(bodies[0]).toEqual(bodies[1]);
		expect(bodies[0]).toMatchObject({ error: 'internal_error' });
		expect(internalErrorSpy).toHaveBeenCalledTimes(2);
		internalErrorSpy.mockRestore();
		consoleSpy.mockRestore();
	});
});
