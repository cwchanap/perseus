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

function createWorkflow(status = 'running') {
	return {
		create: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue({
			status: vi.fn().mockResolvedValue({ status })
		})
	};
}

function createEnv(workflow = createWorkflow()) {
	return {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		NODE_ENV: 'development',
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: workflow
	};
}

function createRequest(idempotencyKey: string): Request {
	const formData = new FormData();
	formData.append('name', 'Race Puzzle');
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

function mockCreateSuccess() {
	vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
	vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
	vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.releaseIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.originalImageExists).mockResolvedValue(false);
}

describe('Admin Worker idempotency reclaim races', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateSuccess();
	});

	it('returns the concurrent reclaim winner when its puzzle is live', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'winner-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce({ id: 'winner-puzzle', status: 'processing' } as any);

		const response = await admin.fetch(createRequest('race-key'), createEnv() as any);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: 'winner-puzzle', status: 'processing' });
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns a conflict when another reclaim winner has no live metadata', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'winner-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce(null);

		const response = await admin.fetch(createRequest('race-key'), createEnv() as any);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: 'conflict',
			message: 'Idempotency key reclaimed by another request'
		});
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('nested-reclaims a concurrent committed winner whose puzzle was deleted', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'deleted-winner',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: false,
				puzzleId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce(null);

		const response = await admin.fetch(createRequest('nested-key'), createEnv() as any);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ id: 'replacement-puzzle' });
		expect(storage.originalImageExists).toHaveBeenCalledWith(
			expect.anything(),
			'deleted-winner'
		);
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'nested-key',
			'deleted-winner'
		);
	});

	it('treats a completed pending workflow as alive', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'completed-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'completed-puzzle',
			status: 'processing'
		} as any);
		const workflow = createWorkflow('complete');

		const response = await admin.fetch(createRequest('complete-key'), createEnv(workflow) as any);

		expect(response.status).toBe(200);
		expect(workflow.get).toHaveBeenCalledWith('completed-puzzle');
		expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'complete-key',
			'completed-puzzle'
		);
	});
});
