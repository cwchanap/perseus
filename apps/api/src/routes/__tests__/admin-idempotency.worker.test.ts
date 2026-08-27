/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
		deleteMetadataDO: vi.fn(),
		failIdempotencyKey: vi.fn(),
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		listFamilies: vi.fn(),
		enrichFamilySummary: vi.fn(),
		originalImageExists: vi.fn(),
		puzzleExists: vi.fn(),
		releaseIdempotencyKey: vi.fn(),
		reserveIdempotencyKey: vi.fn(),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
		deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../services/player-auth.worker', () => ({
	addAllowlistEntry: vi.fn(),
	deleteAllowlistEntry: vi.fn(),
	getPlayerByEmail: vi.fn(),
	listAllowlistEntries: vi.fn(),
	revokePlayerSessionsForEmail: vi.fn()
}));

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		beginPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishFamilyFirstClears: vi.fn().mockResolvedValue(undefined),
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false)
	}
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return { ...original, ...sharedMockOverrides };
});

import {
	makeFamilyMetadata,
	PIECE_COUNTS_1_1,
	variantIdsForFamily
} from './helpers/family-fixtures';
import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
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
	formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'puzzle.png');

	return new Request('http://localhost/puzzle-families', {
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
	vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
	vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
	vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
	vi.mocked(storage.deleteFamilyMetadata).mockResolvedValue({ success: true });
	vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
	vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({ success: true, failedKeys: [] });
	vi.mocked(storage.getFamily).mockImplementation(async (_kv, id: string) =>
		makeFamilyMetadata(id, 'processing')
	);
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
				familyId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: false,
				familyId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'failed-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'failed',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
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
		expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: 'replacement-puzzle' })
		);
		expect(storage.createPuzzleMetadata).toHaveBeenCalledTimes(3);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { familyId: 'replacement-puzzle' }
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
				familyId: 'dead-puzzle',
				status: 'pending'
			})
			.mockResolvedValueOnce({
				existing: false,
				familyId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'dead-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'processing',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
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
			params: { familyId: 'replacement-puzzle' }
		});
	});

	it.each(['queued', 'paused', 'waiting', 'waitingForPause', 'rollingBack'])(
		'treats a %s workflow as alive and commits the pending reservation instead of reclaiming',
		async (status) => {
			vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
				existing: true,
				familyId: 'live-puzzle',
				status: 'pending'
			});
			vi.mocked(storage.getFamily).mockResolvedValue({
				id: 'live-puzzle',
				name: 'Live Puzzle',
				pieceCount: 225,
				status: 'processing',
				aspectRatio: '1:1',
				gridCols: 15,
				gridRows: 15,
				imageWidth: 3840,
				imageHeight: 3840,
				createdAt: 1700000000000,
				pieces: [],
				version: 1,
				progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 1700000000000 }
			} as any);
			const workflow = createWorkflow(status);

			const response = await admin.fetch(createRequest('live-key'), createEnv(workflow) as any);

			expect(response.status).toBe(200);
			expect(workflow.get).toHaveBeenCalledWith('live-puzzle');
			expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
				expect.anything(),
				'live-key',
				'live-puzzle'
			);
			expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
			expect(workflow.create).not.toHaveBeenCalled();
		}
	);

	it('reclaims a pending reservation when the workflow instance does not exist (not_found)', async () => {
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				familyId: 'orphaned-puzzle',
				status: 'pending'
			})
			.mockResolvedValueOnce({
				existing: false,
				familyId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'orphaned-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'processing',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
		} as any);
		// Cloudflare's WorkflowBinding.get() throws an error whose code is
		// `instance.not_found` when the instance was never created.
		const notFoundError = new Error('instance.not_found');
		(notFoundError as any).code = 'instance.not_found';
		const workflow = createWorkflow(notFoundError);

		const response = await admin.fetch(createRequest('orphan-key'), createEnv(workflow) as any);

		expect(response.status).toBe(201);
		expect(workflow.get).toHaveBeenCalledWith('orphaned-puzzle');
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'orphan-key',
			'orphaned-puzzle'
		);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { familyId: 'replacement-puzzle' }
		});
	});

	it('returns a transient conflict when workflow liveness cannot be checked', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'uncertain-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'uncertain-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'processing',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
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

	it('does not probe liveness or reclaim a FRESH pending reservation (original still in flight)', async () => {
		// P1 fix: when the reservation is pending but FRESH (within
		// RESERVATION_PENDING_TTL_MS), the original create is likely still
		// in flight — metadata written but PUZZLE_WORKFLOW.create not yet
		// reached. A liveness probe would report instance.not_found (the
		// workflow hasn't been created yet), and reclaiming would start a
		// duplicate workflow while the original continues. Return 409 so
		// the client retries after the original has had time to commit.
		const freshAt = Date.now() - 10_000; // 10 seconds ago — well within 5 min TTL
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'in-flight-puzzle',
			status: 'pending',
			reservedAt: freshAt
		});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'in-flight-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'processing',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
		} as any);
		const workflow = createWorkflow('errored'); // would be "dead" if probed

		const response = await admin.fetch(createRequest('fresh-key'), createEnv(workflow) as any);

		expect(response.status).toBe(409);
		const body = (await response.json()) as any;
		expect(body.message).toBe('A request with this Idempotency-Key is already in progress');
		// Must NOT probe liveness — the workflow instance doesn't exist yet
		// because the original hasn't called PUZZLE_WORKFLOW.create.
		expect(workflow.get).not.toHaveBeenCalled();
		// Must NOT fail or reclaim the reservation.
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
		expect(storage.commitIdempotencyKey).not.toHaveBeenCalled();
		expect(workflow.create).not.toHaveBeenCalled();
	});

	it('probes and reclaims a STALE pending reservation (older than TTL)', async () => {
		// Stale pending (reservedAt older than 5 min TTL) — the original
		// create's commit failed. Probe liveness and reclaim if dead.
		const staleAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				familyId: 'stale-dead-puzzle',
				status: 'pending',
				reservedAt: staleAt
			})
			.mockResolvedValueOnce({
				existing: false,
				familyId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'stale-dead-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'processing',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
		} as any);
		const workflow = createWorkflow('errored');

		const response = await admin.fetch(createRequest('stale-key'), createEnv(workflow) as any);

		expect(response.status).toBe(201);
		expect(workflow.get).toHaveBeenCalledWith('stale-dead-puzzle');
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'stale-key',
			'stale-dead-puzzle'
		);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { familyId: 'replacement-puzzle' }
		});
	});

	it('releases a stale committed reservation after KV and R2 confirm deletion', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				familyId: 'deleted-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: false,
				familyId: 'replacement-puzzle',
				status: 'pending'
			});
		vi.mocked(storage.getFamily).mockResolvedValue(null);
		vi.mocked(storage.originalImageExists).mockResolvedValue(false);
		const workflow = createWorkflow();

		const responsePromise = admin.fetch(createRequest('stale-key'), createEnv(workflow) as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(201);
		expect(storage.getFamily).toHaveBeenCalledTimes(5);
		expect(storage.originalImageExists).toHaveBeenCalledWith(expect.anything(), 'deleted-puzzle');
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'stale-key',
			'deleted-puzzle'
		);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'replacement-puzzle',
			params: { familyId: 'replacement-puzzle' }
		});
	});

	it('does not reclaim a committed reservation while its R2 image still exists', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'propagating-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getFamily).mockResolvedValue(null);
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
			familyId: 'failed-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getFamily).mockResolvedValue({
			id: 'failed-puzzle',
			name: 'Test Family',
			aspectRatio: '1:1',
			status: 'failed',
			variants: {
				easy: '423e4567-e89b-42d3-a456-426614174010',
				normal: '523e4567-e89b-42d3-a456-426614174011',
				hard: '623e4567-e89b-42d3-a456-426614174012'
			},
			createdAt: 1000
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
			familyId: 'uncertain-deleted-puzzle',
			status: 'committed'
		});
		vi.mocked(storage.getFamily).mockResolvedValue(null);
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

	it('terminates the orphaned workflow and cleans up when commit fails because the reservation was reclaimed', async () => {
		// Simulate: original create succeeds, but a retry reclaimed the
		// reservation while the original was creating the workflow. The
		// commit fails with 409 ("Cannot commit reservation in status
		// failed" or "Reservation owned by another puzzle").
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		const terminateFn = vi.fn().mockResolvedValue(undefined);
		// Status transitions: 'running' on liveness probe, then 'terminated'
		// after terminate() is called (polled by terminateAndAwaitStopped).
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: statusFn,
				terminate: terminateFn
			}))
		};
		const env = createEnv(workflow as any);

		// Commit fails on all 3 attempts with 409
		(storage.commitIdempotencyKey as any).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteFamilyCleanupAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);

		const response = await admin.fetch(createRequest('fence-key-1'), env as any);

		// Should return 500 (client retries, gets the retry's puzzle)
		expect(response.status).toBe(500);
		// Workflow must be terminated
		expect(terminateFn).toHaveBeenCalled();
		// Metadata and all R2 assets (original + thumbnail + pieces) must
		// be cleaned up — not just the original, since the workflow may
		// have already produced a thumbnail or partial pieces.
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'puzzle-1');
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'puzzle-1',
			variantIdsForFamily('puzzle-1'),
			PIECE_COUNTS_1_1
		);
	});

	it('does not mutate source state when terminate() fails — defers to reaper instead', async () => {
		// Regression: if terminate() rejects, a live workflow can still write
		// thumbnails/pieces to R2 after the cleanup sweep. Leave all source
		// state intact until the reaper confirms the workflow is stopped and
		// establishes the permanent D1 deletion fence.
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		const terminateFn = vi.fn().mockRejectedValue(new Error('terminate failed'));
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: vi.fn().mockResolvedValue({ status: 'running' }),
				terminate: terminateFn
			}))
		};
		const env = createEnv(workflow as any);

		(storage.commitIdempotencyKey as any).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteFamilyCleanupAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('fence-key-term-fail'), env as any);

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		// R2 assets must NOT be deleted — the workflow is still live
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		// KV metadata must NOT be deleted — the reaper needs it to find the puzzle
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it.each(['complete', 'errored', 'terminated'])(
		'cleans up without calling terminate() when workflow is already %s (pre-status check)',
		async (preStatus) => {
			// Regression: Cloudflare's terminate() throws on already-terminal
			// instances. Without reading status first, a workflow that completed
			// between the create() error and cleanup would throw, return false,
			// and defer to the reaper — but the reaper skips 'complete'
			// workflows, leaving a duplicate completed puzzle permanently
			// orphaned. The fix reads status BEFORE calling terminate() and
			// returns true immediately for terminal states.
			(storage.reserveIdempotencyKey as any).mockResolvedValue({
				existing: false,
				familyId: 'puzzle-1'
			});
			(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

			const terminateFn = vi.fn().mockResolvedValue(undefined);
			const statusFn = vi.fn().mockResolvedValue({ status: preStatus });
			const workflow = {
				create: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(async () => ({
					status: statusFn,
					terminate: terminateFn
				}))
			};
			const env = createEnv(workflow as any);

			(storage.commitIdempotencyKey as any).mockRejectedValue(
				new Error('Cannot committed reservation in status failed')
			);
			(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
			(storage.deleteFamilyCleanupAssets as any).mockResolvedValue({
				success: true,
				failedKeys: []
			});
			(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const response = await admin.fetch(createRequest(`fence-key-pre-${preStatus}`), env as any);

			expect(response.status).toBe(500);
			// terminate() must NOT be called — the workflow is already terminal
			expect(terminateFn).not.toHaveBeenCalled();
			// Status was read once (the pre-check) and returned true immediately
			expect(statusFn).toHaveBeenCalledTimes(1);
			// Cleanup proceeds — R2 and KV are deleted
			expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
				env.PUZZLES_BUCKET,
				'puzzle-1',
				variantIdsForFamily('puzzle-1'),
				PIECE_COUNTS_1_1
			);
			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'puzzle-1');
		}
	);

	it('cleans up when terminate() throws but re-read status is terminal (race window)', async () => {
		// Regression: the workflow transitioned to terminal between the
		// pre-check and the terminate() call. terminate() throws, but the
		// re-read status confirms the workflow is stopped — safe for cleanup.
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		const terminateFn = vi.fn().mockRejectedValue(new Error('already terminated'));
		// First call (pre-check): 'running'. Second call (re-read after throw): 'terminated'
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValueOnce({ status: 'terminated' });
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: statusFn,
				terminate: terminateFn
			}))
		};
		const env = createEnv(workflow as any);

		(storage.commitIdempotencyKey as any).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteFamilyCleanupAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('fence-key-race'), env as any);

		expect(response.status).toBe(500);
		// terminate() was called (and threw)
		expect(terminateFn).toHaveBeenCalled();
		// Status was read twice: pre-check + re-read after throw
		expect(statusFn).toHaveBeenCalledTimes(2);
		// Cleanup proceeds — the re-read confirmed terminal
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'puzzle-1',
			variantIdsForFamily('puzzle-1'),
			PIECE_COUNTS_1_1
		);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'puzzle-1');
	});

	it('preserves KV when R2 deletion fails in commit-conflict cleanup (reaper retries)', async () => {
		// Regression: if R2 deletion fails during commit-conflict cleanup,
		// the failed keys would become invisible orphans if KV metadata were
		// deleted. Preserve KV so the reaper can retry R2 cleanup on its
		// next run. The DO is already tombstoned.
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: statusFn,
				terminate: terminateFn
			}))
		};
		const env = createEnv(workflow as any);

		(storage.commitIdempotencyKey as any).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		// R2 deletion partially fails
		(storage.deleteFamilyCleanupAssets as any).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/puzzle-1/pieces/0.png']
		});
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('fence-key-r2-fail'), env as any);

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toContain('R2 cleanup partial');
		// DO is tombstoned (first step)
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'puzzle-1');
		// R2 deletion was attempted
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'puzzle-1',
			variantIdsForFamily('puzzle-1'),
			PIECE_COUNTS_1_1
		);
		// KV metadata must NOT be deleted — preserved for reaper retry
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
	});

	it('retains metadata and reservation when workflow create fails but workflow is alive (ambiguous failure)', async () => {
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		// create() throws (timeout), but the workflow was actually created
		// — get().status() returns 'running'
		const workflow = {
			create: vi.fn().mockRejectedValue(new Error('RPC timeout')),
			get: vi.fn(async () => ({
				status: vi.fn().mockResolvedValue({ status: 'running' }),
				terminate: vi.fn()
			}))
		};
		const env = createEnv(workflow as any);

		// Commit should be called (workflow is alive, so we retain + commit)
		(storage.commitIdempotencyKey as any).mockResolvedValue(undefined);

		const response = await admin.fetch(createRequest('ambiguous-key-1'), env as any);

		// Should return 500 (client retries, hits existing-puzzle branch)
		expect(response.status).toBe(500);
		// Must NOT delete metadata or image — workflow is alive
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
		expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
		// Must NOT release the reservation — commit it instead
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'ambiguous-key-1',
			'puzzle-1'
		);
	});

	it('cleans up and releases when workflow create fails and workflow is dead', async () => {
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		// create() throws, and the workflow was NOT created — get() throws not_found
		const notFoundError = new Error('instance.not_found');
		(notFoundError as any).code = 'instance.not_found';
		const workflow = {
			create: vi.fn().mockRejectedValue(new Error('create failed')),
			get: vi.fn(async () => {
				throw notFoundError;
			})
		};
		const env = createEnv(workflow as any);

		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteOriginalImage as any).mockResolvedValue({ success: true });
		(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);

		const response = await admin.fetch(createRequest('dead-key-1'), env as any);

		expect(response.status).toBe(500);
		// Should clean up (workflow was not created)
		expect(storage.deletePuzzleMetadata).toHaveBeenCalled();
		expect(storage.deleteOriginalImage).toHaveBeenCalled();
		expect(storage.releaseIdempotencyKey).toHaveBeenCalled();
	});

	it('retains metadata and returns 500 when workflow create fails and liveness is unknown', async () => {
		(storage.reserveIdempotencyKey as any).mockResolvedValue({
			existing: false,
			familyId: 'puzzle-1'
		});
		(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

		// create() throws, and the workflow API is unreachable (not not_found)
		const workflow = {
			create: vi.fn().mockRejectedValue(new Error('RPC timeout')),
			get: vi.fn(async () => {
				throw new Error('workflow API down');
			})
		};
		const env = createEnv(workflow as any);

		const response = await admin.fetch(createRequest('unknown-key-1'), env as any);

		expect(response.status).toBe(500);
		// Must NOT clean up — liveness unknown, fail closed
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
		expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	});
});
