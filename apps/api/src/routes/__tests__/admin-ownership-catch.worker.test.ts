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
		finishPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishFamilyFirstClears: vi.fn().mockResolvedValue(undefined)
	}
}));

vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		deletePuzzleAssets: vi.fn(),
		deleteFamilyCleanupAssets: vi.fn().mockResolvedValue({ success: true, failedKeys: [] }),
		deletePuzzleMetadata: vi.fn().mockResolvedValue({ success: true }),
		createPuzzleMetadata: vi.fn().mockResolvedValue(undefined),
		createFamilyMetadata: vi.fn().mockResolvedValue(undefined),
		deleteFamilyMetadata: vi.fn().mockResolvedValue({ success: true }),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		listFamilies: vi.fn(),
		enrichFamilySummary: vi.fn(),
		originalImageExists: vi.fn().mockResolvedValue(false),
		puzzleExists: vi.fn().mockResolvedValue(false),
		releaseIdempotencyKey: vi.fn(),
		deleteMetadataDO: vi.fn().mockResolvedValue(undefined),
		writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
		deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		deletePuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

import { makeFamilyMetadata } from './helpers/family-fixtures';
import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import { deletePuzzleFamilyOwnership } from '@perseus/shared';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const baseEnv = {
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
		vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(VALID_UUID, 'ready'));
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true } as any);
		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		} as any);
		vi.mocked(deletePuzzleFamilyOwnership).mockRejectedValueOnce(new Error('D1 unavailable'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request(`http://localhost/puzzle-family-delete/${VALID_UUID}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		for (const difficulty of ['easy', 'normal', 'hard'] as const) {
			expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
				`${VALID_UUID}-${difficulty}`,
				expect.any(Number)
			);
		}
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).not.toHaveBeenCalled();
		expect(deletePuzzleFamilyOwnership).toHaveBeenCalledTimes(1);
		expect(consoleSpy).toHaveBeenCalledWith(
			`Failed to finish fenced cleanup for ${VALID_UUID}:`,
			expect.any(Error)
		);
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledTimes(1);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});
