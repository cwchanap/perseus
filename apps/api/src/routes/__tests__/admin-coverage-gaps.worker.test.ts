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

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		beginPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishFamilyFirstClears: vi.fn().mockResolvedValue(undefined),
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false)
	}
}));

vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		commitIdempotencyKey: vi.fn(),
		createPuzzleMetadata: vi.fn().mockResolvedValue(undefined),
		createFamilyMetadata: vi.fn().mockResolvedValue(undefined),
		deleteFamilyMetadata: vi.fn().mockResolvedValue({ success: true }),
		deletePuzzleMetadata: vi.fn().mockResolvedValue({ success: true }),
		deletePuzzleAssets: vi.fn(),
		deleteFamilyCleanupAssets: vi.fn().mockResolvedValue({ success: true, failedKeys: [] }),
		deleteMetadataDO: vi.fn(),
		failIdempotencyKey: vi.fn(),
		getAuthoritativeStatus: vi.fn(),
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		listFamilies: vi.fn(),
		enrichFamilySummary: vi.fn(),
		originalImageExists: vi.fn().mockResolvedValue(false),
		puzzleExists: vi.fn().mockResolvedValue(false),
		releaseIdempotencyKey: vi.fn(),
		reserveIdempotencyKey: vi.fn(),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
		deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../middleware/rate-limit.worker', () => ({
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
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return { ...original, ...sharedMockOverrides };
});

import {
	cleanupRecordMatcher,
	makeFamilyMetadata,
	PIECE_COUNTS_1_1,
	variantIdsForFamily
} from './helpers/family-fixtures';
import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import * as playerAuth from '../../services/player-auth.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

const baseEnv = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	NODE_ENV: 'development',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

function buildFormData(): FormData {
	const formData = new FormData();
	formData.append('name', 'Test Puzzle');
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
	return new Request('http://localhost/puzzle-families', {
		method: 'POST',
		headers,
		body: buildFormData()
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
	vi.mocked(storage.deleteMetadataDO).mockResolvedValue(undefined);
	vi.mocked(storage.releaseIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
	vi.mocked(storage.originalImageExists).mockResolvedValue(false);
	vi.mocked(storage.writeCleanupRecord).mockResolvedValue(undefined);
	vi.mocked(storage.getFamily).mockImplementation(async (_kv, id: string) =>
		makeFamilyMetadata(id, 'processing')
	);
}

// Pin Math.random to its midpoint for this suite. Production applies ±20%
// jitter to retry backoffs; the retry-budget tests below assert the expected
// 500 ms base delay, so the jitter must be deterministic. This is a suite-
// local concern (moved out of the global test-setup.ts).
let randomSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
	randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
	randomSpy?.mockRestore();
	randomSpy = undefined;
});

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
			familyId: 'conflict-puzzle'
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

	it('leaves source unchanged and defers to reaper when pre-status read fails', async () => {
		const statusFn = vi.fn().mockRejectedValue(new Error('status API down'));
		const terminateFn = vi.fn();
		const env = setupDeadCommitConflict(statusFn, terminateFn);

		const res = await admin.fetch(createRequest('conflict-pre-status'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(terminateFn).not.toHaveBeenCalled();
		expect(storage.writeCleanupRecord).toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).not.toHaveBeenCalled();
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
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
			familyId: 'committed-puzzle',
			status: 'committed'
		} as any);
		vi.mocked(storage.getFamily).mockResolvedValue(
			makeFamilyMetadata('committed-puzzle', 'processing')
		);
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
		// A valid Idempotency-Key is required for the route to reserve a key,
		// which makes the fail/release reservation cleanup paths reachable.
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'r2-probe-puzzle'
		} as any);
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
		const res = await admin.fetch(createRequest('r2-probe-cleanup-fail'), env);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Failed to upload image');
		// originalCommitted=true and cleanup failed → failReservation path.
		// The reservation is marked failed (not released) so a same-key retry
		// reclaims through the DO's serialized path instead of minting a
		// duplicate alongside the orphaned original.
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'r2-probe-cleanup-fail',
			expect.any(String)
		);
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	});

	it('logs error when R2 probe (originalImageExists) throws', async () => {
		vi.mocked(storage.originalImageExists).mockRejectedValue(new Error('R2 probe failed'));

		const env = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } } as any;
		const res = await admin.fetch(createRequest('r2-probe-throws'), env);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Failed to upload image');
		// originalCommitted stays false (probe threw) → releaseReservation path.
		// The reservation is released so a same-key retry can mint a fresh id.
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'r2-probe-throws',
			expect.any(String)
		);
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
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
			familyId: 'alive-puzzle'
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
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'alive-puzzle',
			variantIdsForFamily('alive-puzzle'),
			PIECE_COUNTS_1_1
		);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'alive-puzzle');
		// Cleanup record written up-front (before terminate), then deleted
		// after every cleanup step succeeds.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('alive-puzzle')
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
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('alive-puzzle')
		);
		// Record written before terminate was called.
		expect(vi.mocked(storage.writeCleanupRecord).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(terminateFn).mock.invocationCallOrder[0]
		);
		// Record must NOT be deleted — the reaper needs it to retry.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).not.toHaveBeenCalled();
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		// A cleanup record must be written up-front so the reaper can retry
		// the DO tombstone and clean up R2/KV on its next run.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('alive-puzzle')
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
		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/alive-puzzle/pieces/0.png']
		});

		const res = await admin.fetch(createRequest('alive-conflict-r2-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('R2 cleanup partial');
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
		// Cleanup record was written up-front and must remain for reaper retry.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('alive-puzzle')
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
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
			familyId: 'dead-puzzle'
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

	it('does not attempt the DO tombstone when terminate fails', async () => {
		const terminateFn = vi.fn().mockRejectedValue(new Error('terminate failed'));
		const statusFn = vi.fn().mockResolvedValue({ status: 'running' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);

		const res = await admin.fetch(createRequest('dead-conflict-do-fail-not-stopped'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('workflow termination pending');
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).not.toHaveBeenCalled();
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		// A cleanup record must be written so the reaper can retry the DO
		// tombstone and clean up R2/KV on its next run.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('dead-puzzle')
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
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dead-puzzle');
		// The cleanup record must NOT be deleted on KV failure — the reaper
		// needs it to retry KV (and R2/DO) cleanup on its next run.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		// D1 ownership cleanup must not run either — the reaper handles it
		// after KV succeeds.
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalled();
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
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'dead-puzzle',
			variantIdsForFamily('dead-puzzle'),
			PIECE_COUNTS_1_1
		);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dead-puzzle');
		// Cleanup record written up-front, then deleted after full success.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('dead-puzzle')
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
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
	});

	it('preserves cleanup record when R2 cleanup fails partially', async () => {
		const terminateFn = vi.fn().mockResolvedValue(undefined);
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running' })
			.mockResolvedValue({ status: 'terminated' });

		const env = setupDeadCommitConflict(terminateFn, statusFn);
		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/dead-puzzle/pieces/0.png']
		});

		const res = await admin.fetch(createRequest('dead-conflict-r2-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('R2 cleanup partial');
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
		// Record written up-front must remain (not deleted) for reaper retry.
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});
});

// ─── DELETE route idempotency release failure ────────────────────────────────

describe('Admin Worker — DELETE /puzzles/:id idempotency release failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 500 and retains cleanup record when idempotency key release fails', async () => {
		const familyId = '550e8400-e29b-41d4-a716-446655440000';
		vi.mocked(storage.getFamily).mockResolvedValue(
			makeFamilyMetadata(familyId, 'ready', { idempotencyKey: 'idem-key-1' })
		);
		vi.mocked(storage.deleteFamilyMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		});
		vi.mocked(storage.releaseIdempotencyKey).mockRejectedValue(new Error('DO unavailable'));

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});
		const res = await admin.fetch(req, { ...baseEnv } as any);
		expect(res.status).toBe(500);
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			baseEnv.PUZZLE_METADATA_DO,
			'idem-key-1',
			familyId
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			`${familyId}-easy`,
			expect.any(Number)
		);
		expect(vi.mocked(storage.deleteMetadataDO).mock.invocationCallOrder[0]).toBeGreaterThan(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		).toBeLessThan(vi.mocked(storage.releaseIdempotencyKey).mock.invocationCallOrder[0]);
		expect(vi.mocked(storage.releaseIdempotencyKey).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(storage.deleteCleanupRecord).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
		);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});
});

// ─── terminateWorkflow catch: workflow.get() throws ──────────────────────────

describe('Admin Worker — terminateAndAwaitStopped workflow.get() throws', () => {
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

	function setupDeadCommitConflictWithGetThrow(getErr: Error) {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'get-throw-puzzle'
		} as any);
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => {
				throw getErr;
			})
		};
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		return {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;
	}

	it('proceeds with cleanup when workflow.get() throws not_found (instance never created)', async () => {
		const notFoundErr = Object.assign(new Error('instance.not_found'), {
			code: 'instance.not_found'
		});
		const env = setupDeadCommitConflictWithGetThrow(notFoundErr);

		const res = await admin.fetch(createRequest('get-not-found'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		// Cleanup proceeds (terminate returns true for not_found) — all
		// assets are cleaned up and the record is deleted.
		expect(body.message).toContain('puzzle cleaned up');
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			env.PUZZLES_BUCKET,
			'get-throw-puzzle',
			variantIdsForFamily('get-throw-puzzle'),
			PIECE_COUNTS_1_1
		);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			'get-throw-puzzle'
		);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			'get-throw-puzzle'
		);
	});

	it('defers to reaper when workflow.get() throws non-not_found error', async () => {
		const env = setupDeadCommitConflictWithGetThrow(new Error('workflow API down'));

		const res = await admin.fetch(createRequest('get-other-err'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		// Liveness is unconfirmed, so cleanup retains the record without fence/source mutation.
		expect(body.message).toContain('workflow termination pending');
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			cleanupRecordMatcher('get-throw-puzzle')
		);
	});
});

// ─── cleanupOrphanedWorkflow: required record deletion ───────────────────────

describe('Admin Worker — required cleanup record delete failure retains retry state', () => {
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

	it('retains retry state when deleteCleanupRecord throws', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'record-del-puzzle'
		} as any);
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(async () => ({
				status: vi.fn().mockResolvedValue({ status: 'errored' }),
				terminate: vi.fn().mockResolvedValue(undefined)
			}))
		};
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(
			new Error('Cannot committed reservation in status failed')
		);
		// All cleanup steps succeed, but the final record delete throws.
		vi.mocked(storage.deleteCleanupRecord).mockRejectedValue(new Error('KV transient'));

		const env = {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;

		const res = await admin.fetch(createRequest('record-del-fail'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('required cleanup failed');
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalled();
		expect(storage.deleteFamilyMetadata).toHaveBeenCalled();
		for (const difficulty of ['easy', 'normal', 'hard'] as const) {
			expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
				`record-del-puzzle-${difficulty}`,
				expect.any(Number)
			);
			expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith(
				`record-del-puzzle-${difficulty}`
			);
		}
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(
			baseEnv.PUZZLE_METADATA,
			'record-del-puzzle'
		);
	});
});

// ─── R2 probe after upload error: releaseReservation when cleanup succeeds ──

describe('Admin Worker — R2 probe releaseReservation after cleanup success', () => {
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

	it('releases reservation when originalImageExists is true and deleteOriginalImage succeeds', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'probe-release-puzzle'
		} as any);
		vi.mocked(storage.originalImageExists).mockResolvedValue(true);
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });

		const env = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } } as any;
		const res = await admin.fetch(createRequest('probe-release-key'), env);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Failed to upload image');
		// releaseReservation was called (not failReservation) because the
		// committed original was successfully deleted.
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'probe-release-key',
			expect.any(String)
		);
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
	});
});

// ─── ambiguous alive create: transient commit failure (non-conflict) ─────────

describe('Admin Worker — ambiguous alive create transient commit failure', () => {
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

	it('logs and returns 500 when commit fails with non-conflict error after ambiguous alive create', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'alive-transient-puzzle'
		} as any);
		const workflow = {
			create: vi.fn().mockRejectedValue(new Error('RPC timeout')),
			get: vi.fn(async () => ({
				status: vi.fn().mockResolvedValue({ status: 'running' }),
				terminate: vi.fn()
			}))
		};
		// commit fails with a transient (non-conflict) error
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(new Error('DO unreachable'));

		const env = {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;

		const res = await admin.fetch(createRequest('alive-transient'), env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('Workflow creation was ambiguous');
		// Reservation is retained (not released or failed) — the client
		// should retry to commit or hit the existing-puzzle branch.
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
		// No cleanup attempted — workflow may still be alive.
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
	});
});

// ─── idempotency KV retry budget exceeded ─────────────────────────────────────

describe('Admin Worker — idempotency KV retry budget exceeded', () => {
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

	it('breaks out of KV retry loop when budget is exceeded', async () => {
		vi.useFakeTimers();
		// A committed reservation whose puzzle metadata is missing (deleted
		// with a failed release). getPuzzle always returns null.
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'deleted-puzzle',
			status: 'committed'
		} as any);
		// getPuzzle returns null AND jumps the system clock forward by
		// 5000ms on each call, so the budget check (3000ms) triggers on
		// the first iteration of the retry loop.
		vi.mocked(storage.getFamily).mockImplementation(async () => {
			vi.setSystemTime(Date.now() + 5000);
			return null;
		});
		// R2 probe: original image is gone → release and re-reserve.
		vi.mocked(storage.originalImageExists).mockResolvedValue(false);
		// The re-reserve (probeReleaseAndRereclaimOrFail) wins.
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValueOnce({
			existing: true,
			familyId: 'deleted-puzzle',
			status: 'committed'
		} as any);
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValueOnce({
			existing: false,
			familyId: 'budget-puzzle'
		} as any);
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
		const workflow = {
			create: vi.fn().mockResolvedValue(undefined)
		};
		const env = {
			...baseEnv,
			PUZZLE_WORKFLOW: workflow
		} as any;

		const fetchPromise = admin.fetch(createRequest('budget-key'), env);
		// Advance through the initial 500ms setTimeout. The getPuzzle
		// mock then jumps the clock forward by 5000ms, so the budget
		// check (Date.now() - retryStart >= 3000) triggers immediately
		// on the first for-loop iteration, breaking out.
		await vi.advanceTimersByTimeAsync(500);
		const res = await fetchPromise;

		// The request should eventually succeed (201) after the budget
		// break releases the stale reservation and re-reserves.
		expect(res.status).toBe(201);
	});
});
