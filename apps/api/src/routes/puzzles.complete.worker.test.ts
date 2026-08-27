import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { CompletionWriteExecutor } from '@perseus/shared';

const { workerDb, completionWrites } = vi.hoisted(() => ({
	workerDb: {},
	completionWrites: {
		write: vi.fn(),
		beginPuzzleDeletion: vi.fn(),
		finishPuzzleDeletion: vi.fn(),
		finishFamilyFirstClears: vi.fn(),
		isPuzzleTombstoned: vi.fn()
	} as unknown as CompletionWriteExecutor
}));

vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => workerDb),
	getWorkerDbContext: vi.fn(() => ({ db: workerDb, completionWrites }))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		recordVersionedCompletion: vi.fn(async () => ({
			status: 'recorded' as const,
			completedAt: 100
		})),
		ensurePuzzleFamilyOwnership: vi.fn(async () => {}),
		SYSTEM_OWNER_ID: actual.SYSTEM_OWNER_ID
	};
});

vi.mock('../services/storage.worker', () => ({
	getPuzzle: vi.fn().mockResolvedValue({
		id: 'pz',
		familyId: '323e4567-e89b-42d3-a456-426614174001',
		difficulty: 'easy',
		name: 'Test Puzzle',
		pieceCount: 4,
		aspectRatio: '4:3',
		createdAt: 100,
		status: 'ready'
	} as never),
	getFamily: vi.fn().mockResolvedValue({
		id: '323e4567-e89b-42d3-a456-426614174001',
		name: 'Test Family',
		aspectRatio: '4:3',
		status: 'ready',
		createdAt: 100,
		variants: {
			easy: 'pz',
			normal: 'pz-normal',
			hard: 'pz-hard'
		}
	})
}));

vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

import complete from '../routes/puzzles.complete.worker';
import * as dbModule from '../db.worker';
import * as playerAuth from '../services/player-auth.worker';
import * as storage from '../services/storage.worker';
import {
	recordVersionedCompletion,
	ensurePuzzleFamilyOwnership,
	SYSTEM_OWNER_ID
} from '@perseus/shared';
import type { RecordPuzzleCompletionV2 } from '@perseus/types';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

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
const DUMMY_ENV = { DB: {} } as never;
const PUZZLE_ID = '123e4567-e89b-42d3-a456-426614174000';
const FAMILY_ID = '323e4567-e89b-42d3-a456-426614174001';
const RUN_ID = '223e4567-e89b-42d3-a456-426614174000';

const VERSIONED_CASES: { name: string; request: RecordPuzzleCompletionV2 }[] = [
	{
		name: 'standard timed',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 91,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	},
	{
		name: 'rotation timed',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'rotation_timed',
			elapsedActiveSeconds: 92,
			hintsUsed: 0,
			incorrectAttempts: 1
		}
	},
	{
		name: 'assisted timed',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'assisted_timed',
			elapsedActiveSeconds: 93,
			hintsUsed: 2,
			incorrectAttempts: 0
		}
	},
	{
		name: 'relaxed',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'relaxed',
			elapsedActiveSeconds: null,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	}
];

const MALFORMED_VERSIONED_CASES: { name: string; request: unknown }[] = [
	{
		name: 'unsupported version never falls back to timeSeconds',
		request: { version: 1, timeSeconds: 90 }
	},
	{
		name: 'missing run ID',
		request: {
			version: 2,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	},
	{
		name: 'unknown result class',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'unknown',
			elapsedActiveSeconds: 90,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	},
	{
		name: 'timed result with null elapsed time',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: null,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	},
	{
		name: 'fractional active time',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90.7,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	},
	{
		name: 'active time above the legacy ceiling',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 86_401,
			hintsUsed: 0,
			incorrectAttempts: 0
		}
	},
	{
		name: 'negative hints used',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90,
			hintsUsed: -1,
			incorrectAttempts: 0
		}
	},
	{
		name: 'extra field',
		request: {
			version: 2,
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 90,
			hintsUsed: 0,
			incorrectAttempts: 0,
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

describe('POST /api/puzzles/:id/complete (Worker)', () => {
	beforeEach(() => {
		vi.mocked(dbModule.getWorkerDb).mockReset();
		vi.mocked(dbModule.getWorkerDb).mockReturnValue(workerDb as never);
		vi.mocked(dbModule.getWorkerDbContext).mockReset();
		vi.mocked(dbModule.getWorkerDbContext).mockReturnValue({
			db: workerDb,
			completionWrites
		} as never);
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: PUZZLE_ID,
			familyId: FAMILY_ID,
			difficulty: 'easy',
			name: 'Test Puzzle',
			pieceCount: 4,
			aspectRatio: '4:3',
			createdAt: 100,
			status: 'ready'
		} as never);
		vi.mocked(storage.getPuzzle).mockClear();
		vi.mocked(recordVersionedCompletion).mockReset();
		vi.mocked(recordVersionedCompletion).mockResolvedValue({
			status: 'recorded',
			completedAt: 100
		});
		vi.mocked(ensurePuzzleFamilyOwnership).mockClear();
	});

	it('rejects the removed legacy timeSeconds body', async () => {
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ timeSeconds: 90 }) },
			DUMMY_ENV
		);

		expect(res.status).toBe(400);
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('backfills a system-owned family row after recording the completion', async () => {
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		expect(ensurePuzzleFamilyOwnership).toHaveBeenCalledWith(expect.anything(), {
			id: FAMILY_ID,
			ownerId: SYSTEM_OWNER_ID,
			name: 'Test Puzzle',
			aspectRatio: '4:3',
			status: 'ready',
			createdAt: 100
		});
		const backfillOrder = vi.mocked(ensurePuzzleFamilyOwnership).mock.invocationCallOrder[0];
		const recordOrder = vi.mocked(recordVersionedCompletion).mock.invocationCallOrder[0];
		expect(backfillOrder).toBeGreaterThan(recordOrder);
		expect(dbModule.getWorkerDbContext).toHaveBeenCalledOnce();
	});

	it('still records the completion when the family ownership backfill fails (best-effort)', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(ensurePuzzleFamilyOwnership).mockRejectedValueOnce(new Error('D1 down'));
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		expect(recordVersionedCompletion).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('includes the puzzle category in the family ownership backfill when present', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: PUZZLE_ID,
			familyId: FAMILY_ID,
			difficulty: 'easy',
			name: 'Categorized Puzzle',
			pieceCount: 4,
			aspectRatio: '4:3',
			createdAt: 100,
			status: 'ready',
			category: 'nature'
		} as never);
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		expect(ensurePuzzleFamilyOwnership).toHaveBeenCalledWith(expect.anything(), {
			id: FAMILY_ID,
			ownerId: SYSTEM_OWNER_ID,
			name: 'Categorized Puzzle',
			aspectRatio: '4:3',
			category: 'nature',
			status: 'ready',
			createdAt: 100
		});
	});

	it('rejects a malformed puzzle id with 400', async () => {
		const res = await buildApp().request(
			'/api/puzzles/not-a-uuid/complete',
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		expect(storage.getPuzzle).not.toHaveBeenCalled();
	});

	it('rejects a non-v4 UUID with 400', async () => {
		const res = await buildApp().request(
			'/api/puzzles/123e4567-e89b-12d3-a456-426614174000/complete',
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
	});

	it('returns 404 when the puzzle does not exist', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(404);
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('returns 404 when the puzzle is not ready', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
			id: PUZZLE_ID,
			familyId: FAMILY_ID,
			difficulty: 'easy',
			name: 'Test Puzzle',
			pieceCount: 4,
			createdAt: 100,
			status: 'processing'
		} as never);
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(404);
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('returns 500 with a structured error when getPuzzle throws (corrupt metadata)', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(storage.getPuzzle).mockRejectedValueOnce(new Error('Corrupt metadata'));
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to retrieve puzzle');
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('rejects invalid JSON body with 400', async () => {
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: 'not-json'
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'bad_request' });
	});

	it('requires authentication', async () => {
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(401);
	});

	it.each(VERSIONED_CASES)('records $name without rewriting fields', async ({ request }) => {
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(recordVersionedCompletion).toHaveBeenCalledWith(
			workerDb,
			completionWrites,
			'p1',
			PUZZLE_ID,
			request,
			{ familyId: FAMILY_ID, difficulty: 'easy' }
		);
	});

	it('returns 200 for an exact versioned replay', async () => {
		vi.mocked(recordVersionedCompletion).mockResolvedValueOnce({
			status: 'replayed',
			completedAt: 50
		});
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(ensurePuzzleFamilyOwnership).toHaveBeenCalledOnce();
	});

	it('returns structured 409 for a versioned run ID conflict', async () => {
		vi.mocked(recordVersionedCompletion).mockResolvedValueOnce({ status: 'conflict' });
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'run_id_conflict' });
		expect(ensurePuzzleFamilyOwnership).toHaveBeenCalledOnce();
	});

	it('returns structured 429 for a new versioned run at quota', async () => {
		vi.mocked(recordVersionedCompletion).mockResolvedValueOnce({ status: 'quota_exceeded' });
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			error: 'completion_quota_exceeded',
			message: 'Completion history limit reached'
		});
		expect(ensurePuzzleFamilyOwnership).toHaveBeenCalledOnce();
	});

	it('returns structured 404 when variant is ready but parent family failed', async () => {
		vi.mocked(storage.getFamily).mockResolvedValueOnce({
			id: FAMILY_ID,
			name: 'Failed Family',
			aspectRatio: '4:3',
			status: 'failed',
			createdAt: 100,
			variants: { easy: PUZZLE_ID, normal: 'pz-normal', hard: 'pz-hard' }
		} as never);

		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found', message: 'Puzzle not found' });
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
	});

	it('returns structured 404 for a versioned replay fenced by a tombstone', async () => {
		vi.mocked(recordVersionedCompletion).mockResolvedValueOnce({ status: 'tombstoned' });
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found', message: 'Puzzle not found' });
		expect(ensurePuzzleFamilyOwnership).not.toHaveBeenCalled();
	});

	it('returns structured 500 when Worker context acquisition fails', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(dbModule.getWorkerDbContext).mockImplementationOnce(() => {
			throw new Error('context unavailable');
		});

		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: 'internal_error',
			message: 'Failed to record completion'
		});
		expect(dbModule.getWorkerDb).not.toHaveBeenCalled();
		expect(recordVersionedCompletion).not.toHaveBeenCalled();
		expect(ensurePuzzleFamilyOwnership).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it.each(MALFORMED_VERSIONED_CASES)(
		'rejects malformed versioned request: $name',
		async ({ request }) => {
			const res = await buildApp().request(
				`/api/puzzles/${PUZZLE_ID}/complete`,
				{
					method: 'POST',
					headers: jsonHeaders(),
					body: JSON.stringify(request)
				},
				DUMMY_ENV
			);

			expect(res.status).toBe(400);
			expect(storage.getPuzzle).not.toHaveBeenCalled();
			expect(recordVersionedCompletion).not.toHaveBeenCalled();
		}
	);

	it('returns structured 500 when the versioned executor fails', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(recordVersionedCompletion).mockRejectedValueOnce(new Error('executor failed'));
		const res = await buildApp().request(
			`/api/puzzles/${PUZZLE_ID}/complete`,
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(VERSIONED_CASES[0].request)
			},
			DUMMY_ENV
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: 'internal_error' });
		consoleSpy.mockRestore();
	});
});
