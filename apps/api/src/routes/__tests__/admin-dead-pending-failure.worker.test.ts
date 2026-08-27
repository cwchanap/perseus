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
		deletePuzzleMetadata: vi.fn().mockResolvedValue({ success: true }),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		failIdempotencyKey: vi.fn(),
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		listPuzzles: vi.fn(),
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
	formData.append('name', 'Dead Pending Puzzle');
	formData.append('pieceCount', '225');
	formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'puzzle.png');
	return new Request('http://localhost/puzzles', {
		method: 'POST',
		headers: {
			cookie: 'session=valid.token',
			'Idempotency-Key': 'dead-pending-key'
		},
		body: formData
	});
}

describe('Admin Worker dead pending reclaim failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const staleAt = Date.now() - 10 * 60 * 1000;
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'dead-pending-puzzle',
			status: 'pending',
			reservedAt: staleAt
		});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'dead-pending-puzzle',
			name: 'Dead Pending Family',
			aspectRatio: '1:1',
			status: 'processing',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
		} as any);
		vi.mocked(storage.failIdempotencyKey).mockRejectedValue(new Error('DO unavailable'));
	});

	it('returns 500 when the dead pending reservation cannot be failed', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const workflow = {
			get: vi.fn().mockResolvedValue({
				status: vi.fn().mockResolvedValue({ status: 'errored' })
			}),
			create: vi.fn()
		};
		const env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: workflow
		};

		const response = await admin.fetch(createRequest(), env as any);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: 'internal_error',
			message: 'Failed to reclaim dead pending reservation'
		});
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'dead-pending-key',
			'dead-pending-puzzle'
		);
		expect(workflow.create).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to fail dead pending reservation on retry:',
			expect.any(Error)
		);
	});
});
