/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage gap tests for admin.worker.ts.
 * Covers:
 * - probeWorkflowLiveness error paths (pre-status, post-status, poll, deadline)
 * - player-allowlist error catches (GET/POST/DELETE)
 * - committed processing reservation DO status check
 * - R2 probe after upload error (originalCommitted paths)
 * - alive-commit conflict cleanup (terminate, tombstone, R2, KV failures)
 * - dead-commit conflict cleanup (DO tombstone fail, metadata cleanup fail)
 * - DELETE route idempotency release failure
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	commitIdempotencyKey: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deleteMetadataDO: vi.fn(),
	failIdempotencyKey: vi.fn(),
	getAuthoritativeStatus: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	originalImageExists: vi.fn().mockResolvedValue(false),
	puzzleExists: vi.fn().mockResolvedValue(false),
	releaseIdempotencyKey: vi.fn(),
	reserveIdempotencyKey: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn(),
	writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
	deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
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
	loginRateLimit: async (_c: any, next: any) => next(),
	__resetRateLimitStore: vi.fn()
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
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return { ...original, ...sharedMockOverrides };
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import * as playerAuth from '../../services/player-auth.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00
]);

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	NODE_ENV: 'development',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

function buildFormData(): FormData {
	const formData = new FormData();
	formData.append('name', 'Test Puzzle');
	formData.append('pieceCount', '225');
	const blob = new Blob([PNG_HEADER], { type: 'image/png' });
	formData.append('image', blob, 'test.png');
	return formData;
}

function createRequest(idempotencyKey?: string): Request {
	const headers: Record<string, string> = {
		cookie: 'session=valid.token'
	};
	if (idempotencyKey) {
		headers['Idempotency-Key'] = idempotencyKey;
	}
	return new Request('http://localhost/puzzles', {
		method: 'POST',
		headers,
		body: buildFormData()
	});
}

function mockSuccessfulCreate() {
	vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
	vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
	vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
	vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
	vi.mocked(storage.deletePuzzleAssets).mockResolvedValue({ success: true, failedKeys: [] });
	vi.mocked(storage.deleteMetadataDO).mockResolvedValue(undefined);
	vi.mocked(storage.releaseIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.originalImageExists).mockResolvedValue(false);
	vi.mocked(storage.writeCleanupRecord).mockResolvedValue(undefined);
}

function makeProcessingPuzzle(id: string): any {
	return {
		id,
		name: 'Processing Puzzle',
		pieceCount: 225,
		gridCols: 15,
		gridRows: 15,
		imageWidth: 3840,
		imageHeight: 3840,
		createdAt: 1700000000000,
		status: 'processing',
		aspectRatio: '1:1',
		version: 1,
		pieces: [],
		progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 1700000000000 }
	};
}

// ─── player-allowlist error catches ──────────────────────────────────────────

describe('Admin Worker — player-allowlist error catches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('GET /player-allowlist returns 500 when listAllowlistEntries throws', async () => {
		vi.mocked(playerAuth.listAllowlistEntries).mockRejectedValue(new Error('KV unavailable'));

		const req = new Request('http://localhost/player-allowlist', {
			method: 'GET',
			headers: { cookie: 'session=valid.token' }
		});
		const res = await admin.fetch(req, { ...baseEnv } as any);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to list player allowlist');
	});

	it('POST /player-allowlist returns 500 when addAllowlistEntry throws non-Invalid email', async () => {
		vi.mocked(playerAuth.addAllowlistEntry).mockRejectedValue(new Error('KV write failed'));

		const req = new Request('http://localhost/player-allowlist', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ email: 'test@example.com' })
		});
		const res = await admin.fetch(req, { ...baseEnv } as any);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to add player allowlist entry');
	});

	it('DELETE /player-allowlist/:email returns 500 when delete throws non-Invalid email', async () => {
		vi.mocked(playerAuth.revokePlayerSessionsForEmail).mockResolvedValue(undefined);
		vi.mocked(playerAuth.deleteAllowlistEntry).mockRejectedValue(new Error('KV delete failed'));

		const req = new Request('http://localhost/player-allowlist/test@example.com', {
			method: 'DELETE',
			headers: { cookie: 'session=valid.token' }
		});
		const res = await admin.fetch(req, { ...baseEnv } as any);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to delete player allowlist entry');
	});
});

// ─── terminateAndAwaitStopped error paths ────────────────────────────────────

describe('Admin Worker — terminateAndAwaitStopped error paths via dead-commit conflict', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		mockSuccessfulCreate();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Helper: set up a dead-commit conflict (create succeeds, commit fails with
	// conflict) that triggers terminateAndAwaitStopped.
	function setupDeadCommitConflict(
		statusFn: ReturnType<typeof vi.fn>,
		terminateFn: ReturnType<typeof vi.fn>
	) {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			puzzleId: 'conflict-puzzle'
		} as any);
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: statusFn,
				terminate: terminateFn
			}))
		};
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		return {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;
	}

	it('tombstones DO and defers to reaper when pre-status read fails', async () => {
		const statusFn = vi.fn().mockRejectedValue(new Error('status API down'));
		const terminateFn = vi.fn();
		const env = setupDeadCommitConflict(statusFn, terminateFn);

		const res = await admin.fetch(createRequest('conflict-pre-status'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(terminateFn).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'conflict-puzzle'
		);
		expect(storage.writeCleanupRecord).toHaveBeenCalled();
	});

	it('tombstones DO and defers to reaper when post-status re-read fails after terminate threw', async () => {
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // pre-check
			.mockRejectedValueOnce(new Error('re-read failed')); // re-read after terminate threw
		const terminateFn = vi.fn().mockRejectedValue(new Error('already terminated'));
		const env = setupDeadCommitConflict(statusFn, terminateFn);

		const res = await admin.fetch(createRequest('conflict-post-status'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(terminateFn).toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});

	it('tombstones DO and defers to reaper when poll status fails after terminate succeeds', async () => {
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // pre-check
			.mockRejectedValueOnce(new Error('poll failed')); // poll after terminate
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const env = setupDeadCommitConflict(statusFn, terminateFn);

		const res = await admin.fetch(createRequest('conflict-poll-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(terminateFn).toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});

	it('tombstones DO and defers to reaper when workflow does not stop within deadline', async () => {
		vi.useFakeTimers();
		const statusFn = vi.fn().mockResolvedValue({ status: 'running' });
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const env = setupDeadCommitConflict(statusFn, terminateFn);

		const resPromise = admin.fetch(createRequest('conflict-deadline'), env);
		// Advance past the poll timeout (30s default)
		await vi.advanceTimersByTimeAsync(35000);
		const res = await resPromise;

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(terminateFn).toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});
});

// ─── committed processing reservation DO status check ────────────────────────

describe('Admin Worker — committed processing reservation DO status check', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		mockSuccessfulCreate();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function setupCommittedProcessing(workflowStatus: string) {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			puzzleId: 'committed-puzzle',
			status: 'committed'
		} as any);
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeProcessingPuzzle('committed-puzzle'));
		const workflow = {
			get: vi.fn(async () => ({
				status: vi.fn().mockResolvedValue({ status: workflowStatus }),
				terminate: vi.fn()
			}))
		};
		return {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;
	}

	it('returns 200 when DO authoritative status is ready (KV lag)', async () => {
		vi.mocked(storage.getAuthoritativeStatus).mockResolvedValue('ready');
		const env = setupCommittedProcessing('errored');
		const res = await admin.fetch(createRequest('committed-ready'), env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.id).toBe('committed-puzzle');
	});

	it('returns 409 when DO authoritative status is not ready', async () => {
		vi.mocked(storage.getAuthoritativeStatus).mockResolvedValue('processing');
		const env = setupCommittedProcessing('errored');
		const res = await admin.fetch(createRequest('committed-processing'), env);
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow is dead');
	});

	it('returns 409 when DO authoritative status is null (tombstoned)', async () => {
		vi.mocked(storage.getAuthoritativeStatus).mockResolvedValue(null);
		const env = setupCommittedProcessing('errored');
		const res = await admin.fetch(createRequest('committed-null'), env);
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow is dead');
	});

	it('returns 409 when getAuthoritativeStatus throws', async () => {
		vi.mocked(storage.getAuthoritativeStatus).mockRejectedValue(new Error('DO unavailable'));
		const env = setupCommittedProcessing('errored');
		const res = await admin.fetch(createRequest('committed-throw'), env);
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.message).toContain('status could not be verified');
	});

	it('returns 409 when committed liveness is unknown', async () => {
		const env = setupCommittedProcessing('running');
		// Override workflow to throw non-not_found error → liveness unknown
		env.PUZZLE_WORKFLOW.get = vi.fn(async () => {
			throw new Error('workflow API down');
		});
		const res = await admin.fetch(createRequest('committed-unknown'), env);
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow liveness could not be verified');
	});
});

// ─── R2 probe after upload error ─────────────────────────────────────────────

describe('Admin Worker — R2 probe after upload error', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		mockSuccessfulCreate();
		vi.mocked(storage.uploadOriginalImage).mockRejectedValue(new Error('R2 upload failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('fails reservation when originalImageExists returns true and cleanup fails', async () => {
		vi.mocked(storage.originalImageExists).mockResolvedValue(true);
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 delete failed')
		} as any);

		const env = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } } as any;
		const res = await admin.fetch(createRequest(), env);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Failed to upload image');
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
	});

	it('logs error when R2 probe (originalImageExists) throws', async () => {
		vi.mocked(storage.originalImageExists).mockRejectedValue(new Error('R2 probe failed'));

		const env = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } } as any;
		const res = await admin.fetch(createRequest(), env);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Failed to upload image');
		// originalCommitted stays false → releaseReservation path
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	});
});

// ─── alive-commit conflict cleanup ───────────────────────────────────────────

describe('Admin Worker — alive-commit conflict cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		mockSuccessfulCreate();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function setupAliveCommitConflict(
		terminateFn: ReturnType<typeof vi.fn>,
		statusFn: ReturnType<typeof vi.fn>
	) {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			puzzleId: 'alive-puzzle'
		} as any);
		// create() throws (ambiguous), but workflow is alive
		const workflow = {
			create: vi.fn().mockRejectedValue(new Error('RPC timeout')),
			get: vi.fn(async () => ({
				status: statusFn,
				terminate: terminateFn
			}))
		};
		// commit fails with conflict
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		return {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;
	}

	it('terminates orphaned workflow and cleans up when alive-commit conflict occurs', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // probeWorkflowLiveness
			.mockResolvedValueOnce({ status: 'running' }) // terminateAndAwaitStopped pre-check
			.mockResolvedValue({ status: 'terminated' }); // terminateAndAwaitStopped poll

		const env = setupAliveCommitConflict(terminateFn, statusFn);
		const res = await admin.fetch(createRequest('alive-conflict-1'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('puzzle cleaned up');
		expect(terminateFn).toHaveBeenCalled();
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'alive-puzzle');
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'alive-puzzle',
			225
		);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'alive-puzzle');
		// Cleanup record written up-front (before terminate), then deleted
		// after every cleanup step succeeds.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'alive-puzzle' })
		);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'alive-puzzle');
		// Record is written BEFORE any terminate/tombstone/R2/KV work.
		expect(vi.mocked(storage.writeCleanupRecord).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(terminateFn).mock.invocationCallOrder[0]
		);
	});

	it('writes cleanup record BEFORE terminate, and preserves it when terminate fails', async () => {
		const terminateFn = vi.fn().mockRejectedValue(new Error('terminate failed'));
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // probeWorkflowLiveness
			.mockResolvedValueOnce({ status: 'running' }); // terminateAndAwaitStopped pre-check

		const env = setupAliveCommitConflict(terminateFn, statusFn);
		const res = await admin.fetch(createRequest('alive-conflict-term-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'alive-puzzle');
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'alive-puzzle' })
		);
		// Record written before terminate was called.
		expect(vi.mocked(storage.writeCleanupRecord).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(terminateFn).mock.invocationCallOrder[0]
		);
		// Record must NOT be deleted — the reaper needs it to retry.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});

	it('returns 500 when DO tombstone fails after terminate succeeds', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // probeWorkflowLiveness
			.mockResolvedValueOnce({ status: 'running' }) // terminateAndAwaitStopped pre-check
			.mockResolvedValue({ status: 'terminated' }); // poll

		const env = setupAliveCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deleteMetadataDO).mockRejectedValue(new Error('DO delete failed'));

		const res = await admin.fetch(createRequest('alive-conflict-do-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('DO tombstone failed');
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		// A cleanup record must be written up-front so the reaper can retry
		// the DO tombstone and clean up R2/KV on its next run.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'alive-puzzle' })
		);
		// Record must NOT be deleted — the reaper needs it.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('preserves KV and cleanup record when R2 cleanup fails partially', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // probeWorkflowLiveness
			.mockResolvedValueOnce({ status: 'running' }) // terminateAndAwaitStopped pre-check
			.mockResolvedValue({ status: 'terminated' }); // poll

		const env = setupAliveCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deletePuzzleAssets).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/alive-puzzle/pieces/0.png']
		});

		const res = await admin.fetch(createRequest('alive-conflict-r2-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('R2 cleanup partial');
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		// Cleanup record was written up-front and must remain for reaper retry.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'alive-puzzle' })
		);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('preserves cleanup record and reports KV failure when metadata cleanup fails', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' }) // probeWorkflowLiveness
			.mockResolvedValueOnce({ status: 'running' }) // terminateAndAwaitStopped pre-check
			.mockResolvedValue({ status: 'terminated' }); // poll

		const env = setupAliveCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);

		const res = await admin.fetch(createRequest('alive-conflict-meta-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		// Must NOT claim "puzzle cleaned up" — KV deletion failed and the
		// reaper needs to retry. The old behavior logged and continued,
		// claiming success while KV metadata lingered.
		expect(body.message).toContain('KV metadata cleanup failed');
		expect(body.message).not.toContain('puzzle cleaned up');
		// Cleanup record must NOT be deleted — the reaper needs it.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('aborts cleanup and returns 500 when up-front cleanup record write fails', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		// First call: probeWorkflowLiveness → 'running' (alive), so the
		// code enters the alive-commit conflict branch. The helper aborts
		// at writeCleanupRecord before reaching terminate, so no further
		// status calls are needed.
		const statusFn = vi.fn().mockResolvedValueOnce({ status: 'running' });

		const env = setupAliveCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.writeCleanupRecord).mockRejectedValueOnce(new Error('KV transient'));

		const res = await admin.fetch(createRequest('alive-conflict-record-write-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('failed to record durable cleanup state');
		// No termination, tombstone, or asset cleanup attempted — without
		// a durable record, proceeding risks stranding orphans the reaper
		// cannot recover.
		expect(terminateFn).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});
});

// ─── dead-commit conflict cleanup error paths ────────────────────────────────

describe('Admin Worker — dead-commit conflict cleanup error paths', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		mockSuccessfulCreate();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function setupDeadCommitConflict(
		terminateFn: ReturnType<typeof vi.fn>,
		statusFn: ReturnType<typeof vi.fn>
	) {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			puzzleId: 'dead-puzzle'
		} as any);
		// create() succeeds
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: statusFn,
				terminate: terminateFn
			}))
		};
		// commit fails with conflict
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		return {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;
	}

	it('logs when DO tombstone fails after terminate fails', async () => {
		const terminateFn = vi.fn().mockRejectedValue(new Error('terminate failed'));
		const statusFn = vi.fn().mockResolvedValue({ status: 'running' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deleteMetadataDO).mockRejectedValue(new Error('DO delete failed'));

		const res = await admin.fetch(createRequest('dead-conflict-do-fail-not-stopped'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		// DO tombstone was attempted but failed — logged, not fatal
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'dead-puzzle');
		// R2 assets not deleted
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});

	it('returns 500 when DO tombstone fails after terminate succeeds', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deleteMetadataDO).mockRejectedValue(new Error('DO delete failed'));

		const res = await admin.fetch(createRequest('dead-conflict-do-fail-stopped'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('DO tombstone failed');
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		// A cleanup record must be written so the reaper can retry the DO
		// tombstone and clean up R2/KV on its next run.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'dead-puzzle' })
		);
	});

	it('returns 500 and preserves cleanup record when KV metadata cleanup fails', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);

		const res = await admin.fetch(createRequest('dead-conflict-meta-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('KV metadata cleanup failed');
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dead-puzzle');
		// The cleanup record must NOT be deleted on KV failure — the reaper
		// needs it to retry KV (and R2/DO) cleanup on its next run.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		// D1 ownership cleanup must not run either — the reaper handles it
		// after KV succeeds.
		expect(storage.deletePuzzleAssets).toHaveBeenCalled();
	});

	it('deletes cleanup record and reports cleaned up on full success', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		// All cleanup operations succeed (default mocks from mockSuccessfulCreate).

		const res = await admin.fetch(createRequest('dead-conflict-full-success'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('puzzle cleaned up');
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'dead-puzzle');
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'dead-puzzle', 225);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dead-puzzle');
		// Cleanup record written up-front, then deleted after full success.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'dead-puzzle' })
		);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dead-puzzle');
	});

	it('aborts cleanup and returns 500 when up-front cleanup record write fails', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi.fn().mockResolvedValue({ status: 'terminated' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.writeCleanupRecord).mockRejectedValueOnce(new Error('KV transient'));

		const res = await admin.fetch(createRequest('dead-conflict-record-write-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('failed to record durable cleanup state');
		// No termination, tombstone, or asset cleanup attempted — without a
		// durable record, proceeding risks stranding orphans the reaper
		// cannot recover.
		expect(terminateFn).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('preserves cleanup record when R2 cleanup fails partially', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deletePuzzleAssets).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/dead-puzzle/pieces/0.png']
		});

		const res = await admin.fetch(createRequest('dead-conflict-r2-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('R2 cleanup partial');
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		// Record written up-front must remain (not deleted) for reaper retry.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});
});

// ─── DELETE route idempotency release failure ────────────────────────────────

describe('Admin Worker — DELETE /puzzles/:id idempotency release failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs but returns 204 when idempotency key release fails', async () => {
		const puzzleId = '550e8400-e29b-41d4-a716-446655440000';
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: puzzleId,
			name: 'Test',
			pieceCount: 4,
			status: 'ready',
			idempotencyKey: 'idem-key-1'
		} as any);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deletePuzzleAssets).mockResolvedValue({ success: true, failedKeys: [] });
		vi.mocked(storage.releaseIdempotencyKey).mockRejectedValue(new Error('DO unavailable'));

		const req = new Request(`http://localhost/puzzles/${puzzleId}`, {
			method: 'DELETE',
			headers: { cookie: 'session=valid.token' }
		});
		const res = await admin.fetch(req, { ...baseEnv } as any);
		expect(res.status).toBe(204);
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			baseEnv.PUZZLE_METADATA_DO,
			'idem-key-1',
			puzzleId
		);
	});
});
