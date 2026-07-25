/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleStats: vi.fn().mockResolvedValue(undefined),
		insertPuzzleOwnership: vi.fn(),
		SYSTEM_OWNER_ID: 'system'
	};
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import { insertPuzzleOwnership } from '@perseus/shared';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
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
			create: vi.fn().mockResolvedValue(undefined)
		}
	};
}

function createRequest(idempotencyKey: string): Request {
	const formData = new FormData();
	formData.append('name', 'Cleanup Puzzle');
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

describe('Admin Worker final cleanup coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			puzzleId: 'new-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(storage.releaseIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(insertPuzzleOwnership as any).mockResolvedValue(undefined);
	});

	it('keeps puzzle creation successful when the best-effort D1 insert rejects', async () => {
		vi.mocked(insertPuzzleOwnership as any).mockRejectedValue(new Error('D1 unavailable'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('d1-key'), createEnv() as any);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ id: 'new-puzzle' });
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to record admin puzzle ownership for new-puzzle:',
			expect.any(Error)
		);
	});

	it('falls back to marking the reservation failed when release also fails', async () => {
		vi.mocked(storage.uploadOriginalImage).mockRejectedValue(new Error('R2 unavailable'));
		vi.mocked(storage.releaseIdempotencyKey).mockRejectedValue(new Error('DO release unavailable'));
		vi.mocked(storage.failIdempotencyKey).mockRejectedValue(new Error('DO fail unavailable'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('cleanup-key'), createEnv() as any);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: 'internal_error',
			message: 'Failed to upload image'
		});
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'cleanup-key',
			'new-puzzle'
		);
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'cleanup-key',
			'new-puzzle'
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to mark idempotency reservation failed:',
			expect.any(Error)
		);
	});
});
