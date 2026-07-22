/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	commitIdempotencyKey: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deleteOriginalImage: vi.fn(),
	failIdempotencyKey: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	originalImageExists: vi.fn(),
	puzzleExists: vi.fn(),
	releaseIdempotencyKey: vi.fn(),
	reserveIdempotencyKey: vi.fn(),
	uploadOriginalImage: vi.fn()
}));

vi.mock('../../middleware/auth.worker', () => ({
	clearSessionCookie: vi.fn(),
	createSession: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token'),
	requireAuth: async (c: any, next: any) => {
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	},
	revokeSession: vi.fn(),
	setSessionCookie: vi.fn(),
	verifySession: vi.fn()
}));

vi.mock('../../middleware/rate-limit.worker', () => ({
	loginRateLimit: async (_c: any, next: any) => next()
}));

vi.mock('../../services/player-auth.worker', () => ({
	addAllowlistEntry: vi.fn(),
	deleteAllowlistEntry: vi.fn(),
	getPlayerByEmail: vi.fn(),
	listAllowlistEntries: vi.fn(),
	revokePlayerSessionsForEmail: vi.fn()
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...original,
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleStats: vi.fn().mockResolvedValue(undefined),
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		SYSTEM_OWNER_ID: 'system'
	};
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00
]);

function createEnv() {
	return {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		NODE_ENV: 'development',
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn()
		}
	};
}

function createRequest(idempotencyKey: string): Request {
	const formData = new FormData();
	formData.append('name', 'Recovered Puzzle');
	formData.append('pieceCount', '225');
	formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'puzzle.png');
	return new Request('http://localhost/puzzles', {
		method: 'POST',
		headers: {
			cookie: 'session=valid.token',
			'Idempotency-Key': idempotencyKey
		},
		body: formData
	});
}

describe('Admin Worker idempotency helper failures', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns 500 when reclaim re-reservation fails', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockRejectedValueOnce(new Error('re-reserve failed'));
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'failed-puzzle',
			status: 'failed'
		} as any);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('reclaim-key'), createEnv() as any);

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toBe('Failed to re-reserve reclaimed idempotency key');
		expect(storage.reserveIdempotencyKey).toHaveBeenCalledTimes(2);
		expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
	});

	it('returns 500 when a stale committed reservation cannot be released', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'deleted-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);
		vi.mocked(storage.originalImageExists).mockResolvedValue(false);
		vi.mocked(storage.releaseIdempotencyKey).mockRejectedValue(new Error('release failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const responsePromise = admin.fetch(createRequest('release-key'), createEnv() as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toBe('Failed to release stale reservation');
		expect(storage.reserveIdempotencyKey).toHaveBeenCalledTimes(1);
		expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
	});
});
