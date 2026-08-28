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
import { makeFamilyMetadata } from './helpers/family-fixtures';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

function createWorkflow(status = 'running') {
	return {
		create: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue({
			status: vi.fn().mockResolvedValue({ status }),
			terminate: vi.fn().mockResolvedValue(undefined)
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
	formData.append('name', 'Commit Puzzle');
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

describe('Admin Worker idempotency commit handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns 500 when the initial idempotency reservation fails', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockRejectedValue(new Error('reserve unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await admin.fetch(createRequest('reserve-key'), createEnv() as any);

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toBe('Failed to reserve idempotency key');
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns an existing processing puzzle when its pending workflow is alive', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'existing-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.getFamily).mockResolvedValue(
			makeFamilyMetadata('existing-puzzle', 'processing')
		);
		vi.mocked(storage.commitIdempotencyKey).mockResolvedValue(undefined);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const workflow = createWorkflow('running');

		const response = await admin.fetch(createRequest('alive-key'), createEnv(workflow) as any);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.id).toBe('existing-puzzle');
		// Regression: idempotencyKey is a server-side dedup secret and must
		// not leak in the liveness=alive 200 response (this branch was
		// previously returning raw metadata).
		expect(body.idempotencyKey).toBeUndefined();
		expect(workflow.get).toHaveBeenCalledWith('existing-puzzle');
		expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'alive-key',
			'existing-puzzle'
		);
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns 409 when committing the alive pending reservation fails', async () => {
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: true,
			familyId: 'existing-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.getFamily).mockResolvedValue(
			makeFamilyMetadata('existing-puzzle', 'processing')
		);
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValueOnce(new Error('DO write failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const workflow = createWorkflow('running');

		const response = await admin.fetch(createRequest('alive-key'), createEnv(workflow) as any);

		expect(response.status).toBe(409);
		const body = (await response.json()) as any;
		expect(body.message).toBe('Idempotency-Key in flight; reservation commit failed, retry');
		expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
	});

	it('returns 500 after all post-create idempotency commit retries fail transiently', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'new-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(new Error('commit unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const workflow = createWorkflow();

		const responsePromise = admin.fetch(createRequest('commit-key'), createEnv(workflow) as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toBe('Failed to commit idempotency reservation; retry');
		expect(storage.commitIdempotencyKey).toHaveBeenCalledTimes(3);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'new-puzzle',
			params: { familyId: 'new-puzzle' }
		});
		// Transient failure: retain workflow and assets for client retry
		expect(workflow.get).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
	});

	it('returns 500 from orphan cleanup when a commit conflict winner has no family metadata', async () => {
		vi.useFakeTimers();
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'new-puzzle',
			status: 'pending'
		});
		// Conflict-shaped failure: the reservation was reclaimed by a retry,
		// so the route attempts orphaned-workflow cleanup. The family KV row
		// is missing (already reaped), so cleanup aborts with 500.
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(
			new Error('Idempotency key owned by another puzzle')
		);
		vi.mocked(storage.getFamily).mockResolvedValue(null);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const workflow = createWorkflow();

		const responsePromise = admin.fetch(createRequest('conflict-key'), createEnv(workflow) as any);
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.message).toContain(
			'Idempotency reservation was reclaimed by a retry; family metadata missing'
		);
		expect(storage.commitIdempotencyKey).toHaveBeenCalledTimes(3);
	});

	it('fails (not releases) the reservation when an error reaches the outer catch after workflow.create() succeeds', async () => {
		// Defensive guard: if a future refactor lets an error escape between
		// PUZZLE_WORKFLOW.create() and the 201 return, the outer catch must
		// FAIL the reservation (not release it) so a concurrent retry reclaims
		// through the DO's serialized path instead of minting a duplicate
		// workflow alongside the already-started one.
		vi.mocked(storage.reserveIdempotencyKey).mockResolvedValue({
			existing: false,
			familyId: 'guard-puzzle',
			status: 'pending'
		});
		vi.mocked(storage.commitIdempotencyKey).mockRejectedValue(new Error('commit unavailable'));
		vi.mocked(storage.releaseIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(storage.failIdempotencyKey).mockResolvedValue(undefined);
		// Make the first console.error (inside the commit retry catch) throw,
		// escaping the inline catch to the outer catch — simulates an
		// unexpected error after workflow.create() succeeded.
		vi.spyOn(console, 'error')
			.mockImplementationOnce(() => {
				throw new Error('console.error escaped');
			})
			.mockImplementation(() => {});
		const workflow = createWorkflow();

		const response = await admin.fetch(createRequest('guard-key'), createEnv(workflow) as any);

		expect(response.status).toBe(500);
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			expect.anything(),
			'guard-key',
			'guard-puzzle'
		);
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	});
});
