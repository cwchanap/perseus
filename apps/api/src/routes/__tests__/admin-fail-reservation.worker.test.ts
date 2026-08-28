/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		commitIdempotencyKey: vi.fn(),
		createPuzzleMetadata: vi.fn().mockResolvedValue(undefined),
		createFamilyMetadata: vi.fn().mockResolvedValue(undefined),
		deleteFamilyMetadata: vi.fn().mockResolvedValue({ success: true }),
		deletePuzzleAssets: vi.fn(),
		deleteFamilyCleanupAssets: vi.fn().mockResolvedValue({ success: true, failedKeys: [] }),
		deletePuzzleMetadata: vi.fn().mockResolvedValue({ success: true }),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		failIdempotencyKey: vi.fn(),
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		listFamilies: vi.fn(),
		enrichFamilySummary: vi.fn(),
		originalImageExists: vi.fn(),
		puzzleExists: vi.fn(),
		releaseIdempotencyKey: vi.fn(),
		reserveIdempotencyKey: vi.fn(),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../services/player-auth.worker', () => ({
	addAllowlistEntry: vi.fn(),
	deleteAllowlistEntry: vi.fn(),
	getPlayerByEmail: vi.fn(),
	listAllowlistEntries: vi.fn(),
	revokePlayerSessionsForEmail: vi.fn()
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({})),
	getWorkerDbContext: vi.fn(() => ({
		db: {},
		completionWrites: { isPuzzleTombstoned: vi.fn().mockResolvedValue(false) }
	}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...original,
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		deletePuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleStats: vi.fn().mockResolvedValue(undefined),
		insertPuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined),
		SYSTEM_OWNER_ID: 'system'
	};
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

function createRequest(): Request {
	const formData = new FormData();
	formData.append('name', 'Orphan Puzzle');
	formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'puzzle.png');
	return new Request('http://localhost/puzzle-families', {
		method: 'POST',
		headers: {
			cookie: 'session=valid.token',
			'Idempotency-Key': 'orphan-key'
		},
		body: formData
	});
}

describe('Admin Worker failed reservation fallback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'orphan-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockRejectedValue(new Error('KV unavailable'));
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 cleanup unavailable')
		});
		vi.mocked(storage.failIdempotencyKey).mockRejectedValue(new Error('DO fail unavailable'));
	});

	it('logs when an orphaned reservation cannot be marked failed', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const response = await admin.fetch(createRequest(), env as any);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: 'internal_error',
			message: 'Failed to create puzzle metadata'
		});
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'orphan-key',
			'orphan-puzzle'
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to mark idempotency reservation failed:',
			expect.any(Error)
		);
	});
});
