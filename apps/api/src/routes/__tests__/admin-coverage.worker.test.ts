/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for admin.worker.ts
 * Covers metadata deletion failure and catch block paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
	const original = await importOriginal<typeof import('@perseus/shared')>();
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return { ...original, ...sharedMockOverrides };
});

import { cleanupRecordMatcher, makeFamilyMetadata } from './helpers/family-fixtures';
import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const mockEnv = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
	PUZZLES_BUCKET: {} as R2Bucket,
	NODE_ENV: 'development'
};

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Admin Routes - Puzzle deletion error paths', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('returns 500 when metadata deletion fails', async () => {
		vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(VALID_UUID, 'ready'));

		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		});
		vi.mocked(storage.deleteFamilyMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/puzzle-family-delete/${VALID_UUID}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('KV metadata cleanup failed, reaper will retry');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to delete metadata for '),
			expect.any(Error)
		);
		// Cleanup record written so the reaper retries KV deletion.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			cleanupRecordMatcher(VALID_UUID)
		);
		consoleSpy.mockRestore();
	});

	it('returns 500 when deletePuzzleAssets or deletePuzzleMetadata throws', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: VALID_UUID,
			name: 'Test Puzzle',
			status: 'ready',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: [],
			version: 0
		} as any);

		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		});
		vi.mocked(storage.deletePuzzleMetadata).mockRejectedValue(new Error('Unexpected KV error'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/puzzle-family-delete/${VALID_UUID}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Error deleting puzzle ${VALID_UUID}:`),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});
