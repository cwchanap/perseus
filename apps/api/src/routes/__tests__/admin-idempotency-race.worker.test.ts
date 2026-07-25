/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	commitIdempotencyKey: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deleteOriginalImage: vi.fn(),
	failIdempotencyKey: vi.fn(),
	getAuthoritativeStatus: vi.fn(),
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
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
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

	it('returns 409 when the concurrent reclaim winner is still pending (uncommitted)', async () => {
		// A pending reclaim winner has not committed its reservation yet —
		// it may still fail between metadata creation and commit. Returning
		// 200 would tell the loser the upload succeeded while the
		// reservation remains reclaimable. Signal 409 so the client retries;
		// by the next retry the winner will have committed (200 via the main
		// path) or failed (reclaimed).
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
			.mockResolvedValueOnce({
				id: 'winner-puzzle',
				status: 'processing',
				idempotencyKey: 'race-key'
			} as any);

		const response = await admin.fetch(createRequest('race-key'), createEnv() as any);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toMatchObject({
			error: 'conflict',
			message: 'Idempotency key reclaimed by a request that has not committed yet; retry'
		});
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns the concurrent reclaim winner when its reservation is committed and workflow is alive', async () => {
		// A committed winner with processing metadata is only acknowledged
		// after probing workflow liveness. When the workflow is alive
		// (running), the puzzle is in-flight and safe to return as 200.
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'winner-puzzle',
				status: 'committed'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce({
				id: 'winner-puzzle',
				status: 'processing',
				idempotencyKey: 'race-key'
			} as any);

		const response = await admin.fetch(createRequest('race-key'), createEnv() as any);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ id: 'winner-puzzle', status: 'processing' });
		// Regression: idempotencyKey is a server-side dedup secret and must
		// never leak in the 200 reclaim-winner response (the 201 path already
		// stripped it; this branch was missed).
		expect(body).not.toHaveProperty('idempotencyKey');
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns 409 for a committed reclaim winner whose workflow is dead (not ready)', async () => {
		// A committed winner with processing metadata whose workflow has
		// died (errored/terminated) is NOT acknowledged as 200 — the puzzle
		// is stuck and will be reaped. Signal 409 so the client retries;
		// by the next retry the reaper will have cleaned it up and the key
		// will be reclaimable. Mirrors the main existing-reservation path.
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'dead-winner',
				status: 'committed'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce({
				id: 'dead-winner',
				status: 'processing',
				idempotencyKey: 'dead-key'
			} as any);
		vi.mocked(storage.getAuthoritativeStatus).mockResolvedValue('processing');
		const workflow = createWorkflow('errored');

		const response = await admin.fetch(createRequest('dead-key'), createEnv(workflow) as any);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toMatchObject({
			error: 'conflict',
			message: 'Idempotency key reclaimed by a request whose workflow is dead; retry'
		});
		expect(workflow.get).toHaveBeenCalledWith('dead-winner');
		expect(storage.getAuthoritativeStatus).toHaveBeenCalledWith(expect.anything(), 'dead-winner');
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns 200 for a committed reclaim winner whose workflow is dead but DO says ready', async () => {
		// The workflow is dead but the DO (source of truth) says 'ready' —
		// KV is just lagging. The puzzle is valid; return 200. Mirrors the
		// main existing-reservation path's dead+ready branch.
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'ready-winner',
				status: 'committed'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce({
				id: 'ready-winner',
				status: 'processing',
				idempotencyKey: 'ready-key'
			} as any);
		vi.mocked(storage.getAuthoritativeStatus).mockResolvedValue('ready');
		const workflow = createWorkflow('errored');

		const response = await admin.fetch(createRequest('ready-key'), createEnv(workflow) as any);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ id: 'ready-winner', status: 'processing' });
		expect(body).not.toHaveProperty('idempotencyKey');
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns 409 for a committed reclaim winner whose workflow liveness is unknown', async () => {
		// Workflow API unreachable — can't safely acknowledge a processing
		// puzzle whose liveness cannot be verified. Signal 409 so the
		// client retries. Mirrors the main existing-reservation path.
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'unknown-winner',
				status: 'committed'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce({
				id: 'unknown-winner',
				status: 'processing',
				idempotencyKey: 'unknown-key'
			} as any);
		// 'unknown' is the fallback status from probeWorkflowLiveness for
		// unrecognized status strings.
		const workflow = createWorkflow('unknown');

		const response = await admin.fetch(createRequest('unknown-key'), createEnv(workflow) as any);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toMatchObject({
			error: 'conflict',
			message:
				'Idempotency key reclaimed by a processing puzzle; workflow liveness could not be verified, retry'
		});
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns the concurrent reclaim winner immediately when its status is ready', async () => {
		// A 'ready' puzzle means the workflow completed — no liveness probe
		// needed. Return 200 immediately without calling workflow.get.
		vi.mocked(storage.reserveIdempotencyKey)
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'failed-puzzle',
				status: 'committed'
			})
			.mockResolvedValueOnce({
				existing: true,
				puzzleId: 'ready-winner',
				status: 'committed'
			});
		vi.mocked(storage.getPuzzle)
			.mockResolvedValueOnce({ id: 'failed-puzzle', status: 'failed' } as any)
			.mockResolvedValueOnce({
				id: 'ready-winner',
				status: 'ready',
				idempotencyKey: 'ready-key'
			} as any);
		const workflow = createWorkflow('errored');

		const response = await admin.fetch(createRequest('ready-key'), createEnv(workflow) as any);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ id: 'ready-winner', status: 'ready' });
		expect(body).not.toHaveProperty('idempotencyKey');
		// workflow.get should NOT be called — ready status skips liveness probe
		expect(workflow.get).not.toHaveBeenCalled();
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
		expect(storage.originalImageExists).toHaveBeenCalledWith(expect.anything(), 'deleted-winner');
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
