/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage test for required ownership cleanup in admin.worker.ts
 * DELETE /puzzles/:id.
 *
 * Ownership cleanup is required after source deletion. A failure returns a
 * retriable 500 and retains the cleanup record and D1 tombstone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		beginPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishPuzzleDeletion: vi.fn().mockResolvedValue(undefined)
	}
}));

vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn(),
	listPuzzles: vi.fn(),
	originalImageExists: vi.fn().mockResolvedValue(false),
	puzzleExists: vi.fn().mockResolvedValue(false),
	releaseIdempotencyKey: vi.fn(),
	deleteMetadataDO: vi.fn().mockResolvedValue(undefined),
	writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
	deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('../../middleware/auth.worker', () => ({
	verifySession: vi.fn(),
	requireAuth: async (c: any, next: any) => {
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	},
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token'),
	revokeSession: vi.fn()
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import { deletePuzzleOwnership } from '@perseus/shared';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440001';

describe('Admin Worker - DELETE /puzzles/:id required ownership cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns retriable 500 and retains the cleanup record when ownership rejects', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: VALID_UUID,
			name: 'Ready Puzzle',
			status: 'ready',
			pieceCount: 4
		} as any);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true } as any);
		vi.mocked(storage.deletePuzzleAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		} as any);
		vi.mocked(deletePuzzleOwnership).mockRejectedValueOnce(new Error('D1 unavailable'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request(`http://localhost/puzzle-delete/${VALID_UUID}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			VALID_UUID,
			expect.any(Number)
		);
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith(VALID_UUID);
		expect(deletePuzzleOwnership).toHaveBeenCalledTimes(1);
		expect(consoleSpy).toHaveBeenCalledWith(
			`Error deleting puzzle ${VALID_UUID}:`,
			expect.any(Error)
		);
		expect(storage.deletePuzzleAssets).toHaveBeenCalledTimes(1);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});
