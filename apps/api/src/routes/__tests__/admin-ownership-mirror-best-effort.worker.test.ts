/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The admin D1 ownership row is a mirror used only to name admin puzzles in
 * player stats; KV metadata is the source of truth for admin puzzle existence
 * (matching the Bun admin path, which treats the mirror as best-effort). When
 * the D1 insert fails (outage / missing binding), the upload must still
 * succeed so a transient D1 issue doesn't take admin puzzle creation down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		deletePuzzleAssets: vi.fn(),
		deleteFamilyCleanupAssets: vi.fn().mockResolvedValue({ success: true, failedKeys: [] }),
		deletePuzzleMetadata: vi.fn().mockResolvedValue({ success: true }),
		createPuzzleMetadata: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined),
		createFamilyMetadata: vi.fn().mockResolvedValue(undefined),
		deleteFamilyMetadata: vi.fn().mockResolvedValue({ success: true }),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		originalImageExists: vi.fn().mockResolvedValue(false).mockResolvedValue({ success: true }),
		puzzleExists: vi.fn().mockResolvedValue(false),
		listFamilies: vi.fn()
	};
});

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({})),
	getWorkerDbContext: vi.fn(() => ({
		db: {},
		completionWrites: { isPuzzleTombstoned: vi.fn().mockResolvedValue(false) }
	}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return { ...original, ...sharedMockOverrides };
});

import admin from '../admin.worker';
import { insertPuzzleFamilyOwnership } from '@perseus/shared';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

const baseEnv = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket,
	PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
};

function buildFormData(): FormData {
	const formData = new FormData();
	formData.append('name', 'Mirror Puzzle');
	const blob = new Blob([PNG_HEADER], { type: 'image/png' });
	formData.append('image', blob, 'test.png');
	return formData;
}

describe('Admin Worker - POST /puzzles D1 ownership mirror is best-effort', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('succeeds (201) when the D1 ownership mirror insert fails', async () => {
		vi.mocked(insertPuzzleFamilyOwnership).mockRejectedValueOnce(new Error('D1 unavailable'));

		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, baseEnv as any);

		// Upload must still succeed: KV metadata is the source of truth for
		// admin puzzles, and the D1 row is only a naming mirror.
		expect(res.status).toBe(201);
		expect(insertPuzzleFamilyOwnership).toHaveBeenCalledTimes(1);
		// The workflow still kicks off despite the mirror failure.
		expect(baseEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledTimes(1);
	});
});
