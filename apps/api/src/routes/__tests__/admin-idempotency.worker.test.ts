/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	commitIdempotencyKey: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	failIdempotencyKey: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	originalImageExists: vi.fn(),
	puzzleExists: vi.fn(),
	releaseIdempotencyKey: vi.fn(),
	reserveIdempotencyKey: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn()
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

function createWorkflow(status: string | Error = 'running') {
	return {
		create: vi.fn().mockResolvedValue(undefined),
		get: vi.fn(async () => {
			if (status instanceof Error) throw status;
			return {
				status: vi.fn().mockResolvedValue({ status })
			};
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

function mockSuccessfulCreate() {
	vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
	vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
	vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
	vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
}

describe('Admin Worker idempotency recovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSuccessfulCreate();
		vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(storage.releaseIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(storage.originalImageExists).mockResolvedValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('reclaims a failed reservation and creates a replacement puzzle', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: false,
				puzzleId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'failed-puzzle',
			status: 'failed'
		} as any);
		const workflow = createWorkflow();

		const response = await admin.fetch(createRequest('failed-key'), createEnv(workflow) as any);

		expect(response.status).toBe(201);
		const body = (await response.json()) as any;
		expect(body.id).toBe('replacement-puzzle');
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'failed-key',
			'failed-puzzle'
		);
		expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: 'replacement-puzzle', idempotencyKey: 'failed-key' })
		);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { puzzleId: 'replacement-puzzle' }
		});
		expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'failed-key',
			'replacement-puzzle'
		);
	});

	it('reclaims a pending reservation when its original workflow is dead', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'dead-puzzle',
				status: 'pending'
			})
			.mockResolvedValueOnce({
				existing: false,
				puzzleId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'dead-puzzle',
			status: 'processing'
		} as any);
		const workflow = createWorkflow('errored');

		const response = await admin.fetch(createRequest('dead-key'), createEnv(workflow) as any);

		expect(response.status).toBe(201);
		expect(workflow.get).toHaveBeenCalledWith('dead-puzzle');
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'dead-key',
			'dead-puzzle'
		);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { puzzleId: 'replacement-puzzle' }
		});
	});

	it('returns a transient conflict when workflow liveness cannot be checked', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'uncertain-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'uncertain-puzzle',
			status: 'processing'
		} as any);
		const workflow = createWorkflow(new Error('workflow API unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('uncertain-key'), createEnv(workflow) as any);

		expect(response.status).toBe(409);
		const body = (await response.json()) as any;
		expect(body.message).toContain('workflow liveness could not be verified');
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
		expect(workflow.create).not.toHaveBeenCalled();
	});

	it('releases a stale committed reservation after KV and R2 confirm deletion', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'deleted-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: false,
				puzzleId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);
		vi.mocked(storage.originalImageExists).mockResolvedValue(false);
		const workflow = createWorkflow();

		const responsePromise = admin.fetch(createRequest('stale-key'), createEnv(workflow) as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(201);
		expect(storage.getPuzzle).toHaveBeenCalledTimes(5);
		expect(storage.originalImageExists).toHaveBeenCalledWith(expect.anything(), 'deleted-puzzle');
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'stale-key',
			'deleted-puzzle'
		);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { puzzleId: 'replacement-puzzle' }
		});
	});

	it('does not reclaim a committed reservation while its R2 image still exists', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'propagating-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);
		vi.mocked(storage.originalImageExists).mockResolvedValue(true);

		const responsePromise = admin.fetch(createRequest('propagating-key'), createEnv() as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(409);
		const body = (await response.json()) as any;
		expect(body.message).toContain('metadata is still propagating');
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
	});

	it('returns 500 when a failed reservation cannot be marked reclaimable', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'failed-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'failed-puzzle',
			status: 'failed'
		} as any);
		vi.mocked(storage.failIdempotencyKey).mockRejectedValue(
			new Error('Durable Object unavailable')
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('failed-key'), createEnv() as any);

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toBe('Failed to reclaim failed idempotency reservation');
		expect(storage.reserveIdempotencyKey).toHaveBeenCalledTimes(1);
		expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
	});

	it('returns a conflict when the stale reservation R2 probe fails', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'uncertain-deleted-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);
		vi.mocked(storage.originalImageExists).mockRejectedValue(new Error('R2 unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const responsePromise = admin.fetch(createRequest('probe-key'), createEnv() as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(409);
		const body = (await response.json()) as any;
		expect(body.message).toContain('R2 probe failed');
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
	});
});
