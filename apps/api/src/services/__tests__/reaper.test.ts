/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	reapStuckPuzzles,
	reapCleanupRecords,
	reapOrphanedReservations,
	reapOrphanedAvatars,
	REAP_AFTER_MS,
	REAP_BATCH_LIMIT,
	AVATAR_GC_AGE_MS,
	AVATAR_GC_BATCH_LIMIT
} from '../reaper';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		write: vi.fn(),
		beginPuzzleDeletion: vi.fn(async () => undefined),
		finishPuzzleDeletion: vi.fn(async () => undefined)
	}
}));

// Mock storage.worker functions
vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deleteMetadataDO: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deleteCleanupRecord: vi.fn(async () => undefined),
	writeCleanupRecord: vi.fn(async () => undefined),
	getAuthoritativeStatus: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	listCleanupRecords: vi.fn(async () => []),
	releaseIdempotencyKey: vi.fn(),
	getIdempotencyReservation: vi.fn()
}));

// Mock db.worker so the reaper's D1 ownership cleanup doesn't touch a real DB.
vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

// Mock @perseus/shared's deletePuzzleOwnership and getAvatarTokensByPlayerIds
// so they stay no-op spies. getAvatarTokensByPlayerIds is overridden per-test
// via the shared mock object.
vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		deletePuzzleOwnership: vi.fn(async () => undefined),
		getAvatarTokensByPlayerIds: vi.fn(async () => new Map())
	};
});

// Import after mock so the reaper uses the mocked versions
import {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	deleteCleanupRecord,
	writeCleanupRecord,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	listCleanupRecords,
	releaseIdempotencyKey,
	getIdempotencyReservation
} from '../storage.worker';
import { getWorkerDb, getWorkerDbContext } from '../../db.worker';
import { deletePuzzleOwnership, getAvatarTokensByPlayerIds } from '@perseus/shared';

const storage = {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	deleteCleanupRecord,
	writeCleanupRecord,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	listCleanupRecords,
	releaseIdempotencyKey,
	getIdempotencyReservation
} as any;

// Map-backed KV mock so the reaper's cursor persistence (readReaperCursor /
// writeReaperCursor) works in tests without a real KVNamespace. Each
// makeKvMock() call gets a fresh Map, so tests are isolated. For multi-run
// tests that need the cursor to persist between calls, reuse the same env.
function makeKvMock(): KVNamespace {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
		// Expose the store for tests that need to pre-seed or inspect cursors.
		_store: store
	} as any;
}

function makeEnv(workflowStatuses: Record<string, string> = {}) {
	return {
		PUZZLE_METADATA: makeKvMock(),
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: {
			get: vi.fn((id: string) => ({
				status: vi.fn(async () => ({ status: workflowStatuses[id] ?? 'running' }))
			}))
		},
		PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
		DB: {} as D1Database,
		JWT_SECRET: 'test',
		ADMIN_PASSKEY: 'test',
		GOOGLE_CLIENT_ID: '',
		GOOGLE_CLIENT_SECRET: '',
		AUTH_REDIRECT_BASE_URL: '',
		ASSETS: {} as Fetcher
	} as any;
}

const NOW = 1700000000000;
const OLD_PROCESSING = NOW - REAP_AFTER_MS - 1;
const RECENT_PROCESSING = NOW - 1000;
const OLD_READY = NOW - REAP_AFTER_MS - 1;

function puzzleSummary(id: string, status: string, createdAt: number) {
	return {
		id,
		name: `Puzzle ${id}`,
		pieceCount: 100,
		status,
		createdAt,
		progress: { totalPieces: 100, generatedPieces: 0, updatedAt: createdAt }
	};
}

describe('reapStuckPuzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(storage.deletePuzzleAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		(storage.writeCleanupRecord as any).mockResolvedValue(undefined);
		(deletePuzzleOwnership as any).mockResolvedValue(undefined);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
		(getWorkerDbContext as any).mockReturnValue(dbContextMock);
	});

	it('returns empty result when no puzzles exist', async () => {
		(storage.listPuzzles as any).mockResolvedValue({ puzzles: [], invalidCount: 0 });
		const env = makeEnv();
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.scanned).toBe(0);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
	});

	it('skips puzzles that are not processing', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('ready-1', 'ready', OLD_READY)],
			invalidCount: 0
		});
		const env = makeEnv();
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
		expect(env.PUZZLE_WORKFLOW.get).not.toHaveBeenCalled();
	});

	it('skips recently-created processing puzzles (within threshold)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('recent-1', 'processing', RECENT_PROCESSING)],
			invalidCount: 0
		});
		const env = makeEnv();
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
		expect(env.PUZZLE_WORKFLOW.get).not.toHaveBeenCalled();
	});

	it('skips stuck processing puzzles whose workflow is still running', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'running' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});

	it('reaps stuck processing puzzles whose workflow errored', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, {
			puzzleId: 'stuck-1',
			pieceCount: 100,
			createdAt: expect.any(Number)
		});
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'stuck-1',
			expect.any(Number)
		);
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'stuck-1', 100);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
		expect(getWorkerDbContext).toHaveBeenCalledWith(env);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(dbContextMock.db, 'stuck-1');
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith('stuck-1');
		expect((storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect((storage.writeCleanupRecord as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		).toBeLessThan((storage.deleteMetadataDO as any).mock.invocationCallOrder[0]);
		// Puzzles without an idempotencyKey must not trigger a DO release.
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	});

	it('retains the fence and retries when required D1 finish fails after source cleanup', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		dbContextMock.completionWrites.finishPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 completion cleanup failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });

		const firstResult = await reapStuckPuzzles(env, NOW);

		expect(firstResult.reaped).toBe(0);
		expect(firstResult.errors).toBe(1);
		expect(firstResult.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'stuck-1', action: 'd1-finish-failed' })
		);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'stuck-1', pieceCount: 100 })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'stuck-1',
			expect.any(Number)
		);
		expect((storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);

		const secondResult = await reapStuckPuzzles(env, NOW);

		expect(secondResult.reaped).toBe(1);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
		consoleSpy.mockRestore();
	});

	it('retains stuck record and tombstone when required ownership cleanup fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(deletePuzzleOwnership as any).mockRejectedValueOnce(new Error('D1 ownership cleanup failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });

		const result = await reapStuckPuzzles(env, NOW);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'stuck-1' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'stuck-1',
			expect.any(Number)
		);
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'stuck-1', action: 'd1-finish-failed' })
		);

		const retryResult = await reapStuckPuzzles(env, NOW);

		expect(retryResult.reaped).toBe(1);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
	});

	it('releases the DO reservation for a reaped puzzle that carries an idempotencyKey', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100,
			idempotencyKey: 'reap-key'
		});
		(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, {
			puzzleId: 'stuck-1',
			pieceCount: 100,
			idempotencyKey: 'reap-key',
			createdAt: expect.any(Number)
		});
		// Regression: best-effort release after KV delete so the reservation
		// doesn't dangle on the dead puzzleId forever.
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'reap-key',
			'stuck-1'
		);
	});

	it('continues reaping when the DO reservation release throws (best-effort)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100,
			idempotencyKey: 'reap-key'
		});
		(storage.releaseIdempotencyKey as any).mockRejectedValue(new Error('DO unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		// KV delete still counts as reaped; DO release failure is logged,
		// not fatal — operator force-release is the backstop.
		expect(result.reaped).toBe(1);
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'stuck-1', action: 'do-release-failed' })
		);
	});

	it('reaps stuck processing puzzles whose workflow terminated', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'terminated' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
	});

	it('skips stuck processing puzzles whose workflow status is unknown (liveness unverifiable)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'unknown' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(deletePuzzleOwnership).not.toHaveBeenCalled();
	});

	it('skips stuck processing puzzles whose workflow completed (KV lag, not orphan)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'complete' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(deletePuzzleOwnership).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'skip-complete-kv-lag')).toBe(true);
	});

	it('skips puzzles whose status changed between list and re-read', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		// getPuzzle returns 'ready' — status changed since the list
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'ready',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(env.PUZZLE_WORKFLOW.get).not.toHaveBeenCalled();
	});

	it('counts errors when workflow status check throws', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv();
		env.PUZZLE_WORKFLOW.get = vi.fn(() => {
			throw new Error('workflow API down');
		});
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('preserves KV metadata when R2 asset deletion throws (retry on next scan)', async () => {
		// Regression: if R2 deletion fails, the failed keys would become
		// invisible orphans if KV metadata were deleted. Preserve KV so the
		// next reaper run retries R2 cleanup. The DO is already tombstoned,
		// so the next run's getAuthoritativeStatus returns null (proceed).
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.deletePuzzleAssets as any).mockRejectedValue(new Error('R2 error'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(deletePuzzleOwnership).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'r2-delete-failed')).toBe(true);
	});

	it('processes multiple stuck puzzles in one run', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [
				puzzleSummary('stuck-1', 'processing', OLD_PROCESSING),
				puzzleSummary('stuck-2', 'processing', OLD_PROCESSING),
				puzzleSummary('recent-1', 'processing', RECENT_PROCESSING),
				puzzleSummary('ready-1', 'ready', OLD_READY)
			],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockImplementation(async (kv: any, id: string) => ({
			id,
			status: 'processing',
			name: `Puzzle ${id}`,
			pieceCount: 100
		}));
		const env = makeEnv({ 'stuck-1': 'errored', 'stuck-2': 'terminated' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.scanned).toBe(4);
		expect(result.candidates).toBe(2);
		expect(result.reaped).toBe(2);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(2);
	});

	it('skips puzzles with unrecognized workflow status string', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv({ 'stuck-1': 'flummoxed' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it.each(['queued', 'paused', 'waiting', 'waitingForPause', 'rollingBack'])(
		'skips puzzles whose workflow is in active status %s',
		async (status) => {
			(storage.listPuzzles as any).mockResolvedValue({
				puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
				invalidCount: 0
			});
			(storage.getPuzzle as any).mockResolvedValue({
				id: 'stuck-1',
				status: 'processing',
				name: 'Puzzle stuck-1',
				pieceCount: 100
			});
			const env = makeEnv({ 'stuck-1': status });
			const result = await reapStuckPuzzles(env, NOW);
			expect(result.candidates).toBe(1);
			expect(result.reaped).toBe(0);
			expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		}
	);

	it('reaps puzzles whose workflow instance was never created (not_found)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		const env = makeEnv();
		const notFoundError = new Error('instance.not_found');
		(notFoundError as any).code = 'instance.not_found';
		env.PUZZLE_WORKFLOW.get = vi.fn(() => {
			throw notFoundError;
		});
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(1);
		expect(env.PUZZLE_WORKFLOW.get).toHaveBeenCalledWith('stuck-1');
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'stuck-1' })
		);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
	});

	it('does not begin D1 deletion or mutate source when cleanup-record bootstrap fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.writeCleanupRecord as any).mockRejectedValue(new Error('KV record write failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });

		const result = await reapStuckPuzzles(env, NOW);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('counts errors when KV metadata deletion fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		// deletePuzzleMetadata never throws — it returns { success: false, error }.
		// Mocking mockRejectedValue would test an impossible code path (the old
		// test passed only because it mocked a throw that the production code
		// can never produce). Mock the real failure shape so the .success
		// branch is exercised.
		(storage.deletePuzzleMetadata as any).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'kv-delete-failed')).toBe(true);
	});

	it('counts errors on unexpected per-puzzle exception', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		// getPuzzle throws — triggers the outer per-puzzle catch
		(storage.getPuzzle as any).mockRejectedValue(new Error('unexpected'));
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'error')).toBe(true);
	});

	it('preserves KV metadata when some R2 assets fail to delete (retry on next scan)', async () => {
		// Regression: partial R2 failure must NOT delete KV/D1 — the failed
		// keys would become invisible orphans. Preserve KV so the next reaper
		// run retries R2 cleanup.
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.deletePuzzleAssets as any).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/stuck-1/pieces/0.png', 'puzzles/stuck-1/pieces/1.png']
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'r2-delete-partial')).toBe(true);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(deletePuzzleOwnership).not.toHaveBeenCalled();
	});

	it('does not mutate stuck source when D1 begin initialization throws', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(getWorkerDbContext as any).mockImplementation(() => {
			throw new Error('DB init failed');
		});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		(getWorkerDbContext as any).mockReturnValue(dbContextMock);
	});

	it('skips reaping when DO authoritative status is ready (workflow errored but finalize committed)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		// DO says 'ready' — finalize committed before the workflow errored
		(storage.getAuthoritativeStatus as any).mockResolvedValue('ready');
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'skip-do-ready')).toBe(true);
	});

	it('still reaps when DO authoritative status is processing (genuinely stuck)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.getAuthoritativeStatus as any).mockResolvedValue('processing');
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
	});

	it('still reaps when DO has no metadata (404 — truly orphaned)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.getAuthoritativeStatus as any).mockResolvedValue(null);
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
	});

	it('skips reaping when DO status check throws (fail closed)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.getAuthoritativeStatus as any).mockRejectedValue(new Error('DO down'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'do-status-check-failed')).toBe(true);
	});

	it('tombstones the DO before deleting KV metadata', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.getAuthoritativeStatus as any).mockResolvedValue('processing');
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'stuck-1');
		const doOrder = (storage.deleteMetadataDO as any).mock.invocationCallOrder[0];
		const kvOrder = (storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0];
		expect(doOrder).toBeLessThan(kvOrder);
	});

	it('does not delete KV when DO tombstone fails (retry on next scan)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.getAuthoritativeStatus as any).mockResolvedValue('processing');
		(storage.deleteMetadataDO as any).mockRejectedValue(new Error('DO unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'stuck-1' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'stuck-1',
			expect.any(Number)
		);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(deletePuzzleOwnership).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'do-tombstone-failed')).toBe(true);
	});

	it('does not delete D1 ownership when KV metadata deletion fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue({
			id: 'stuck-1',
			status: 'processing',
			name: 'Puzzle stuck-1',
			pieceCount: 100
		});
		(storage.getAuthoritativeStatus as any).mockResolvedValue('processing');
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		(storage.deletePuzzleMetadata as any).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(deletePuzzleOwnership).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'kv-delete-failed')).toBe(true);
	});
});

describe('reapCleanupRecords', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(storage.deletePuzzleAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteCleanupRecord as any).mockResolvedValue(undefined);
		(storage.writeCleanupRecord as any).mockResolvedValue(undefined);
		(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		(deletePuzzleOwnership as any).mockResolvedValue(undefined);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
		(getWorkerDbContext as any).mockReturnValue(dbContextMock);
		(storage.listCleanupRecords as any).mockResolvedValue([]);
	});

	it('returns empty result when no cleanup records exist', async () => {
		const env = makeEnv();
		const result = await reapCleanupRecords(env);
		expect(result.scanned).toBe(0);
		expect(result.reaped).toBe(0);
	});

	it('cleans up completed duplicate puzzles from cleanup records', async () => {
		const record = { puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 };
		(storage.listCleanupRecords as any).mockResolvedValue([record]);
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.scanned).toBe(1);
		expect(result.reaped).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, record);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'dup-1',
			expect.any(Number)
		);
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'dup-1', 50);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
		expect(getWorkerDbContext).toHaveBeenCalledWith(env);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(dbContextMock.db, 'dup-1');
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith('dup-1');
		expect((storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect((storage.writeCleanupRecord as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		).toBeLessThan((storage.deleteMetadataDO as any).mock.invocationCallOrder[0]);
	});

	it('retains the cleanup record and retries when required D1 finish fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 completion cleanup failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });

		const firstResult = await reapCleanupRecords(env);

		expect(firstResult.reaped).toBe(0);
		expect(firstResult.errors).toBe(1);
		expect(firstResult.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'dup-1', action: 'cleanup-d1-finish-failed' })
		);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, {
			puzzleId: 'dup-1',
			pieceCount: 50,
			createdAt: NOW - 60000
		});
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'dup-1',
			expect.any(Number)
		);
		expect((storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);

		const secondResult = await reapCleanupRecords(env);

		expect(secondResult.reaped).toBe(1);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
		consoleSpy.mockRestore();
	});

	it('cleans up errored workflows from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'errored' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		expect(env.PUZZLE_WORKFLOW.get).toHaveBeenCalledWith('dup-1');
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'dup-1' })
		);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
	});

	it('cleans up terminated workflows from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'terminated' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
	});

	it('cleans up not_found workflows from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv();
		const notFoundError = new Error('instance.not_found');
		(notFoundError as any).code = 'instance.not_found';
		env.PUZZLE_WORKFLOW.get = vi.fn(() => {
			throw notFoundError;
		});
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		expect(env.PUZZLE_WORKFLOW.get).toHaveBeenCalledWith('dup-1');
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'dup-1' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'dup-1',
			expect.any(Number)
		);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
	});

	it('skips running workflows from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'running' });
		const result = await reapCleanupRecords(env);
		expect(result.scanned).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('skips unknown-status workflows from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'unknown' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('releases idempotency key when cleanup record has one', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{
				puzzleId: 'dup-1',
				pieceCount: 50,
				idempotencyKey: 'idem-key-1',
				createdAt: NOW - 60000
			}
		]);
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'idem-key-1',
			'dup-1'
		);
	});

	it('preserves KV and cleanup record when R2 deletion fails partially', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(storage.deletePuzzleAssets as any).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/dup-1/original']
		});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('preserves cleanup record when KV deletion fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(storage.deletePuzzleMetadata as any).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('skips when workflow status check fails with non-not_found error', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv();
		env.PUZZLE_WORKFLOW.get = vi.fn(async () => {
			throw new Error('workflow API down');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await reapCleanupRecords(env);
		expect(result.scanned).toBe(1);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('does not begin D1 deletion or mutate source when record re-ensure fails', async () => {
		const record = { puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 };
		(storage.listCleanupRecords as any).mockResolvedValue([record]);
		(storage.writeCleanupRecord as any).mockRejectedValue(new Error('KV record write failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });

		const result = await reapCleanupRecords(env);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, record);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('preserves KV when R2 deletion throws', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(storage.deletePuzzleAssets as any).mockRejectedValue(new Error('R2 connection failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('logs but still reaps when idempotency key release fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{
				puzzleId: 'dup-1',
				pieceCount: 50,
				idempotencyKey: 'idem-1',
				createdAt: NOW - 60000
			}
		]);
		(storage.releaseIdempotencyKey as any).mockRejectedValue(new Error('DO unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'idem-1',
			'dup-1'
		);
	});

	it('retains record and tombstone when required ownership cleanup fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(deletePuzzleOwnership as any).mockRejectedValueOnce(new Error('D1 delete failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(expect.anything(), 'dup-1');
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'dup-1',
			expect.any(Number)
		);
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'dup-1', action: 'cleanup-d1-finish-failed' })
		);

		const retryResult = await reapCleanupRecords(env);

		expect(retryResult.reaped).toBe(1);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
	});

	it('does not mutate source when D1 begin initialization throws', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(getWorkerDbContext as any).mockImplementation(() => {
			throw new Error('D1 init failed');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		(getWorkerDbContext as any).mockReturnValue(dbContextMock);
	});

	it('does not count success when required cleanup-record deletion fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(storage.deleteCleanupRecord as any).mockRejectedValue(new Error('KV delete failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'dup-1', action: 'cleanup-d1-finish-failed' })
		);
	});

	it('catches unexpected errors and records them as cleanup-error', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		// Make deletePuzzleMetadata throw a non-R2 error to trigger the outer catch
		(storage.deletePuzzleMetadata as any).mockImplementation(() => {
			throw new Error('unexpected catastrophic failure');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		const detail = result.details.find((d) => d.action === 'cleanup-error');
		expect(detail).toBeDefined();
		expect(detail?.error).toContain('unexpected catastrophic failure');
	});

	it('tombstones the DO before deleting R2/KV (idempotent re-tombstone)', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		// deleteMetadataDO must be called before deletePuzzleAssets.
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'dup-1');
		expect(storage.deletePuzzleAssets).toHaveBeenCalled();
	});

	it('preserves R2/KV and cleanup record when DO tombstone fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(storage.deleteMetadataDO as any).mockRejectedValue(new Error('DO unreachable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'dup-1' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'dup-1',
			expect.any(Number)
		);
		// R2 and KV must NOT be deleted — a live DO can resurrect metadata.
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		// The failure must be recorded with the tombstone-failed action.
		const detail = result.details.find((d) => d.action === 'cleanup-do-tombstone-failed');
		expect(detail).toBeDefined();
		expect(detail?.error).toContain('DO unreachable');
	});
});

describe('reapOrphanedReservations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(storage.deletePuzzleAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		(storage.writeCleanupRecord as any).mockResolvedValue(undefined);
		(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);
		(storage.getIdempotencyReservation as any).mockResolvedValue(null);
		(deletePuzzleOwnership as any).mockResolvedValue(undefined);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
		(getWorkerDbContext as any).mockReturnValue(dbContextMock);
	});

	function puzzleMeta(id: string, overrides: Partial<Record<string, unknown>> = {}) {
		return {
			id,
			name: `Puzzle ${id}`,
			pieceCount: 100,
			status: 'ready',
			createdAt: OLD_READY,
			progress: { totalPieces: 100, generatedPieces: 100, updatedAt: OLD_READY },
			...overrides
		};
	}

	it('returns empty result when no puzzles carry an idempotencyKey', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(puzzleMeta('a'));
		const env = makeEnv();
		const result = await reapOrphanedReservations(env);
		expect(result.scanned).toBe(1);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
		expect(storage.getIdempotencyReservation).not.toHaveBeenCalled();
	});

	it('skips puzzles that are the current reservation owner (not orphans)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(puzzleMeta('a', { idempotencyKey: 'key-K' }));
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'a',
			status: 'committed'
		});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('skips puzzles with no reservation record (fail closed — operator review)', async () => {
		// A missing reservation record is NOT a durable orphan signal: it can
		// result from DO state loss, a release that followed KV deletion (the
		// codebase's normal deletion ordering), or an operational action.
		// Reaping on null alone risks destroying a healthy completed puzzle
		// whose reservation record is simply absent — an irreversible
		// mistake. The reaper skips and logs a distinct action so operators
		// can review and force-delete true orphans via the runbook. A
		// positive ownership mismatch (separate test) remains sufficient
		// evidence for reaping.
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue(null);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'skip-null-reservation')).toBe(true);
	});

	it('skips orphaned puzzles whose workflow is still alive', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { status: 'processing', idempotencyKey: 'key-K' })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		const env = makeEnv({ a: 'running' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	// Regression for the durability gap: a failed writeCleanupRecord must
	// NOT permanently strand a completed orphan. Steps mirror the reviewer's
	// scenario:
	//   1. Request A starts workflow A under idempotency key K.
	//   2. Request B reclaims K for puzzle B (reservation DO now maps K -> b).
	//   3. A's cleanup-record write fails (no cleanup record in KV).
	//   4. Workflow A reaches 'complete' (KV shows ready).
	//   5. A later scheduled reconciliation (this reaper) removes puzzle A.
	it('reaps a completed orphan whose idempotency key was reclaimed by a retry', async () => {
		// Step 1 + 4: puzzle A exists in KV as ready, workflow complete.
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		// Step 2: the reservation DO for key-K now points at puzzle b (the
		// retry's replacement), proving A lost its reservation.
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		// Step 3 is implicit: no cleanup record exists (listCleanupRecords
		// defaults to []), so the cleanup-record reaper cannot reach A.
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);

		// Step 5: A is fully reaped.
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, {
			puzzleId: 'a',
			pieceCount: 50,
			idempotencyKey: 'key-K',
			createdAt: expect.any(Number)
		});
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'a',
			expect.any(Number)
		);
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'a');
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'a', 50);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'a');
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'key-K',
			'a'
		);
		expect(getWorkerDbContext).toHaveBeenCalledWith(env);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(dbContextMock.db, 'a');
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith('a');
		expect((storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect((storage.writeCleanupRecord as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		).toBeLessThan((storage.deleteMetadataDO as any).mock.invocationCallOrder[0]);
		expect(result.details.some((d) => d.action === 'orphan-reaped')).toBe(true);
	});

	it('retains the fence and retries an orphan when required D1 finish fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		dbContextMock.completionWrites.finishPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 completion cleanup failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });

		const firstResult = await reapOrphanedReservations(env);

		expect(firstResult.reaped).toBe(0);
		expect(firstResult.errors).toBe(1);
		expect(firstResult.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'a', action: 'orphan-d1-finish-failed' })
		);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'a', idempotencyKey: 'key-K' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'a',
			expect.any(Number)
		);
		expect((storage.deletePuzzleMetadata as any).mock.invocationCallOrder[0]).toBeLessThan(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);

		const secondResult = await reapOrphanedReservations(env);

		expect(secondResult.reaped).toBe(1);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'a');
		consoleSpy.mockRestore();
	});

	it('reaps an orphan whose workflow is dead (errored)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { status: 'processing', idempotencyKey: 'key-K', pieceCount: 30 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		const env = makeEnv({ a: 'errored' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'a', 30);
	});

	it('reaps an orphan whose workflow instance was never created (not_found)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'processing', OLD_PROCESSING)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { status: 'processing', idempotencyKey: 'key-K' })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'pending'
		});
		const env = makeEnv();
		const notFoundError = new Error('instance.not_found');
		(notFoundError as any).code = 'instance.not_found';
		env.PUZZLE_WORKFLOW.get = vi.fn(() => {
			throw notFoundError;
		});
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(1);
		expect(env.PUZZLE_WORKFLOW.get).toHaveBeenCalledWith('a');
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'a', idempotencyKey: 'key-K' })
		);
	});

	it('does not begin D1 deletion or mutate source when orphan record bootstrap fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(storage.writeCleanupRecord as any).mockRejectedValue(new Error('KV record write failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });

		const result = await reapOrphanedReservations(env);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('preserves KV when R2 deletion fails partially on an orphan', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(storage.deletePuzzleAssets as any).mockResolvedValue({
			success: false,
			failedKeys: ['puzzles/a/original']
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'orphan-r2-delete-partial')).toBe(true);
	});

	it('preserves R2/KV when DO tombstone fails on an orphan', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(puzzleMeta('a', { idempotencyKey: 'key-K' }));
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(storage.deleteMetadataDO as any).mockRejectedValue(new Error('DO unreachable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'a', idempotencyKey: 'key-K' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'a',
			expect.any(Number)
		);
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'orphan-do-tombstone-failed')).toBe(true);
	});

	it('records orphan-reservation-check-failed when reservation lookup throws', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(puzzleMeta('a', { idempotencyKey: 'key-K' }));
		(storage.getIdempotencyReservation as any).mockImplementation(() => {
			throw new Error('DO RPC blew up');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'orphan-reservation-check-failed')).toBe(true);
	});

	it('respects REAP_BATCH_LIMIT on orphan candidates', async () => {
		const summaries = Array.from({ length: REAP_BATCH_LIMIT + 5 }, (_, i) =>
			puzzleSummary(`p${i}`, 'ready', OLD_READY)
		);
		(storage.listPuzzles as any).mockResolvedValue({ puzzles: summaries, invalidCount: 0 });
		(storage.getPuzzle as any).mockImplementation((_: KVNamespace, id: string) =>
			Promise.resolve(puzzleMeta(id, { idempotencyKey: `key-${id}` }))
		);
		(storage.getIdempotencyReservation as any).mockImplementation(
			(_: DurableObjectNamespace, key: string) =>
				Promise.resolve({ puzzleId: key.replace('key-', 'other-'), status: 'committed' })
		);
		const env = makeEnv();
		// All workflows complete so all candidates are reaped.
		env.PUZZLE_WORKFLOW.get = vi.fn(() => ({
			status: vi.fn(async () => ({ status: 'complete' }))
		}));
		const result = await reapOrphanedReservations(env);
		expect(result.candidates).toBe(summaries.length);
		expect(result.reaped).toBe(REAP_BATCH_LIMIT);
	});

	// Regression: mismatches must be collected in deterministic input
	// (catalog) order, NOT asynchronous completion order. Under the old
	// shared-array-push approach, a fast subset of mismatches that
	// resolved first would occupy the first REAP_BATCH_LIMIT slots on
	// every run, starving slower mismatches that appeared earlier in the
	// catalog. This test makes later-catalog DO lookups resolve BEFORE
	// earlier-catalog ones and asserts the batch still covers the
	// earliest catalog mismatches (p0..p49), not the fastest-resolving
	// ones (p50..p54).
	it('collects mismatches in input order, not async completion order', async () => {
		const summaries = Array.from({ length: REAP_BATCH_LIMIT + 5 }, (_, i) =>
			puzzleSummary(`p${i}`, 'ready', OLD_READY)
		);
		(storage.listPuzzles as any).mockResolvedValue({ puzzles: summaries, invalidCount: 0 });
		(storage.getPuzzle as any).mockImplementation((_: KVNamespace, id: string) =>
			Promise.resolve(puzzleMeta(id, { idempotencyKey: `key-${id}` }))
		);
		// Delay earlier-catalog lookups so later-catalog ones resolve
		// first. If mismatches were collected in async completion order,
		// the batch would cover p50..p54 plus the fastest of p0..p49.
		// Input-order collection covers p0..p49 regardless of resolution
		// timing.
		(storage.getIdempotencyReservation as any).mockImplementation(
			(_: DurableObjectNamespace, key: string) => {
				const idx = Number(key.replace('key-p', ''));
				const delay = (REAP_BATCH_LIMIT + 5 - idx) * 5;
				return new Promise((resolve) =>
					setTimeout(() => resolve({ puzzleId: `other-${idx}`, status: 'committed' }), delay)
				);
			}
		);
		const env = makeEnv();
		env.PUZZLE_WORKFLOW.get = vi.fn(() => ({
			status: vi.fn(async () => ({ status: 'complete' }))
		}));
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(REAP_BATCH_LIMIT);
		// The reaped batch is the first REAP_BATCH_LIMIT catalog entries
		// (p0..p49), proving input-order collection — NOT the
		// fastest-resolving ones (p50..p54). Asserting the set (sorted)
		// rather than call order, since the destructive phase also
		// dispatches via Promise.all and invocation order within the
		// batch is not guaranteed.
		const reapedIds = (
			vi.mocked(storage.deletePuzzleMetadata).mock.calls as Array<[unknown, string]>
		)
			.map((c) => c[1] as string)
			.sort();
		const expected = Array.from({ length: REAP_BATCH_LIMIT }, (_, i) => `p${i}`).sort();
		expect(reapedIds).toEqual(expected);
		// p50..p54 were NOT reaped (deferred to the next run).
		expect(reapedIds).not.toContain(`p${REAP_BATCH_LIMIT}`);
	});

	// Regression: the source catalog is sorted newest-first (listPuzzles).
	// With the old batch-first approach, the same newest REAP_BATCH_LIMIT
	// healthy puzzles would be selected every run, all confirmed as valid
	// owners, and an older orphan at position 51+ would never be examined.
	// The fix determines mismatches BEFORE applying the batch limit.
	it('does not starve older orphans behind newer healthy owners', async () => {
		const summaries = Array.from({ length: REAP_BATCH_LIMIT + 1 }, (_, i) =>
			puzzleSummary(`p${i}`, 'ready', OLD_READY - i)
		);
		(storage.listPuzzles as any).mockResolvedValue({ puzzles: summaries, invalidCount: 0 });
		(storage.getPuzzle as any).mockImplementation((_: KVNamespace, id: string) =>
			Promise.resolve(puzzleMeta(id, { idempotencyKey: `key-${id}` }))
		);
		// The first REAP_BATCH_LIMIT puzzles are healthy current owners.
		// The last puzzle (p50) is an orphan — its key was reclaimed by a
		// retry that minted a replacement.
		(storage.getIdempotencyReservation as any).mockImplementation(
			(_: DurableObjectNamespace, key: string) => {
				const id = key.replace('key-', '');
				if (id === `p${REAP_BATCH_LIMIT}`) {
					return Promise.resolve({ puzzleId: 'other-replacement', status: 'committed' });
				}
				return Promise.resolve({ puzzleId: id, status: 'committed' });
			}
		);
		const env = makeEnv();
		env.PUZZLE_WORKFLOW.get = vi.fn(() => ({
			status: vi.fn(async () => ({ status: 'complete' }))
		}));
		const result = await reapOrphanedReservations(env);
		// Only the orphan (p50) is a mismatch — it must be reaped despite
		// being at position 51 in the newest-first catalog. Under the old
		// batch-first code, result.reaped would be 0 (starved indefinitely).
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			`p${REAP_BATCH_LIMIT}`
		);
		// The healthy owners must NOT be reaped.
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(1);
	});

	it('records orphan-meta-read-failed when getPuzzle throws during candidate scan', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockRejectedValue(new Error('KV read blew up'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.candidates).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'orphan-meta-read-failed')).toBe(true);
	});

	it('skips orphan when workflow status check throws with non-not_found error', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		const statusError = new Error('workflow RPC unavailable');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv();
		env.PUZZLE_WORKFLOW.get = vi.fn(() => {
			throw statusError;
		});
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'orphan-skip')).toBe(true);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	});

	it('skips orphan with unrecognized workflow status string', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		// 'glitched' is not in ACTIVE_WORKFLOW_STATUSES, DEAD_WORKFLOW_STATUSES,
		// or equal to 'complete' — hits the else branch (lines 796-799).
		const env = makeEnv({ a: 'glitched' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(storage.writeCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('preserves KV when R2 deletion throws on an orphan', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(storage.deletePuzzleAssets as any).mockRejectedValue(new Error('R2 connection lost'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(result.details.some((d) => d.action === 'orphan-r2-delete-failed')).toBe(true);
	});

	it('records orphan-kv-delete-failed when KV metadata deletion fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(storage.deletePuzzleMetadata as any).mockResolvedValue({
			success: false,
			error: 'KV write timeout'
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'orphan-kv-delete-failed')).toBe(true);
	});

	it('still reaps when idempotency key release fails (best-effort)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(storage.releaseIdempotencyKey as any).mockRejectedValue(new Error('DO release failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(1);
		expect(result.details.some((d) => d.action === 'orphan-reaped')).toBe(true);
	});

	it('retains orphan record and tombstone when required ownership cleanup fails', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(deletePuzzleOwnership as any).mockRejectedValueOnce(new Error('D1 delete failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'a',
			expect.any(Number)
		);
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'a', action: 'orphan-d1-finish-failed' })
		);

		const retryResult = await reapOrphanedReservations(env);

		expect(retryResult.reaped).toBe(1);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'a');
	});

	it('does not mutate orphan source when D1 begin initialization throws', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		(getWorkerDbContext as any).mockImplementationOnce(() => {
			throw new Error('DB init failed');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('records orphan-error on unexpected per-candidate exception', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue({
			puzzleId: 'b',
			status: 'committed'
		});
		// The KV delete call (line 860) is NOT inside an inner try/catch —
		// a synchronous throw from deletePuzzleMetadata escapes to the
		// outer catch at the batch callback level.
		(storage.deletePuzzleMetadata as any).mockImplementation(() => {
			throw new Error('Synchronous KV explosion');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'orphan-error')).toBe(true);
	});

	// Regression: without a persisted cursor, mismatches.slice(0,
	// REAP_BATCH_LIMIT) always selects the same first N candidates. If those
	// N persistently fail (DO tombstone error, R2 delete failure, etc.),
	// they occupy the batch every run and later candidates are NEVER visited
	// — permanently starved behind the same noisy prefix. The persisted
	// cursor advances by the page size regardless of individual success, so
	// later candidates are eventually reached.
	//
	// This test creates REAP_BATCH_LIMIT + 5 mismatches. The first
	// REAP_BATCH_LIMIT (p0..p49) always fail at the DO tombstone step. The
	// remaining 5 (p50..p54) succeed. Two runs share the same env (so the
	// cursor persists in the KV mock):
	//   Run 1: cursor=0 → batch=p0..p49 → all fail → cursor advances to 50
	//   Run 2: cursor=50 → batch wraps (p50..p54, p0..p44) → p50..p54
	//          succeed, p0..p44 fail → p50..p54 are reaped
	// Under the old slice(0, LIMIT) code, run 2 would select p0..p49 again
	// and p50..p54 would never be visited.
	it('advances cursor past persistently-failing candidates (no starvation)', async () => {
		const summaries = Array.from({ length: REAP_BATCH_LIMIT + 5 }, (_, i) =>
			puzzleSummary(`p${i}`, 'ready', OLD_READY)
		);
		(storage.listPuzzles as any).mockResolvedValue({ puzzles: summaries, invalidCount: 0 });
		(storage.getPuzzle as any).mockImplementation((_: KVNamespace, id: string) =>
			Promise.resolve(puzzleMeta(id, { idempotencyKey: `key-${id}` }))
		);
		// All candidates are mismatches (key belongs to a different puzzleId).
		(storage.getIdempotencyReservation as any).mockImplementation(
			(_: DurableObjectNamespace, key: string) =>
				Promise.resolve({ puzzleId: `other-${key}`, status: 'committed' })
		);
		// All workflows are complete so candidates pass the workflow check.
		const env = makeEnv();
		env.PUZZLE_WORKFLOW.get = vi.fn(() => ({
			status: vi.fn(async () => ({ status: 'complete' }))
		}));
		// DO tombstone fails for p0..p49 (persistently undeletable) but
		// succeeds for p50..p54.
		(storage.deleteMetadataDO as any).mockImplementation(
			(_: DurableObjectNamespace, id: string) => {
				const idx = Number(id.replace('p', ''));
				if (idx < REAP_BATCH_LIMIT) {
					return Promise.reject(new Error('DO tombstone always fails'));
				}
				return Promise.resolve();
			}
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		// Run 1: cursor=0, batch=p0..p49, all fail at DO tombstone.
		const result1 = await reapOrphanedReservations(env);
		expect(result1.reaped).toBe(0);
		expect(result1.errors).toBe(REAP_BATCH_LIMIT);
		// Cursor should have advanced to 50.
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		expect(kvStore.get('reaper:cursor:orphaned-reservations')).toBe('50');

		// Clear mock call history so run 2 assertions are isolated.
		vi.mocked(storage.deletePuzzleMetadata).mockClear();

		// Run 2: cursor=50, batch wraps to include p50..p54 first.
		const result2 = await reapOrphanedReservations(env);
		// p50..p54 should be reaped (5 candidates beyond the first batch).
		expect(result2.reaped).toBe(5);
		const reapedIds = (
			vi.mocked(storage.deletePuzzleMetadata).mock.calls as Array<[unknown, string]>
		)
			.map((c) => c[1])
			.sort();
		const expected = Array.from({ length: 5 }, (_, i) => `p${REAP_BATCH_LIMIT + i}`).sort();
		expect(reapedIds).toEqual(expected);
	});
});

describe('reapOrphanedAvatars', () => {
	const NOW = 1700000000000;
	const OLD = NOW - AVATAR_GC_AGE_MS - 1;
	const RECENT = NOW - 1000;

	function r2Object(key: string, uploadedMs: number) {
		return { key, uploaded: new Date(uploadedMs), size: 1024, etag: 'etag-' + key };
	}

	function makeAvatarEnv(objects: Array<{ key: string; uploaded: number }>) {
		const deleteFn = vi.fn(async () => undefined);
		const allObjects = objects.map((o) => r2Object(o.key, o.uploaded));
		// Simulate R2 list pagination: honor `limit` and `cursor`, returning
		// a truncated page with a continuation cursor when more objects
		// remain. The cursor is a numeric offset string, which is sufficient
		// for tests — the reaper treats it as opaque.
		return {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async (opts: { limit?: number; cursor?: string } = {}) => {
					const limit = opts.limit ?? 1000;
					const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;
					const slice = allObjects.slice(offset, offset + limit);
					const nextOffset = offset + slice.length;
					const truncated = nextOffset < allObjects.length && slice.length === limit;
					return {
						objects: slice,
						truncated,
						cursor: truncated ? String(nextOffset) : undefined
					};
				}),
				delete: deleteFn
			} as any
		} as any;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		(getWorkerDb as any).mockReturnValue({});
	});

	it('returns empty result when no avatar objects exist', async () => {
		const env = makeAvatarEnv([]);
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.scanned).toBe(0);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
	});

	it('skips legacy unversioned keys (avatars/{playerId})', async () => {
		const env = makeAvatarEnv([{ key: 'avatars/player-1', uploaded: OLD }]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.scanned).toBe(1);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalled();
	});

	it('deletes versioned object whose token is not authoritative and is old enough', async () => {
		const env = makeAvatarEnv([
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/p1/token-B', uploaded: OLD }
		]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map([['p1', 'token-A']]));
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.scanned).toBe(2);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(1);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledWith('avatars/p1/token-B');
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalledWith('avatars/p1/token-A');
	});

	it('preserves the authoritative token object', async () => {
		const env = makeAvatarEnv([{ key: 'avatars/p1/token-A', uploaded: OLD }]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map([['p1', 'token-A']]));
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalled();
	});

	it('skips recent objects below the age threshold', async () => {
		const env = makeAvatarEnv([{ key: 'avatars/p1/token-orphan', uploaded: RECENT }]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map([['p1', 'token-A']]));
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.candidates).toBe(0);
		expect(result.reaped).toBe(0);
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalled();
	});

	it('deletes all versioned objects for a player with no D1 profile row', async () => {
		// Player has no profile override in D1 — all versioned objects are
		// orphans. This covers the case where the profile was deleted or the
		// D1 row was never created.
		const env = makeAvatarEnv([
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/p1/token-B', uploaded: OLD }
		]);
		// D1 returns an empty Map (no row for p1)
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.candidates).toBe(2);
		expect(result.reaped).toBe(2);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledTimes(2);
	});

	it('fails closed when D1 is unavailable (no deletes)', async () => {
		const env = makeAvatarEnv([{ key: 'avatars/p1/token-A', uploaded: OLD }]);
		(getAvatarTokensByPlayerIds as any).mockRejectedValue(new Error('D1 down'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'avatar-gc-d1-unavailable')).toBe(true);
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalled();
	});

	// Regression: the cursor must NOT advance when D1 rejects. The reaper
	// lists one page per run and persists the R2 list cursor in KV between
	// runs. If the cursor were persisted before the D1 authority lookup,
	// a transient D1 outage would cause the reaper to skip the entire page
	// until the R2 scan wrapped all the way around — on a large or
	// continuously growing bucket, that delay is unbounded. Retaining the
	// cursor means the next run retries the same page once D1 recovers.
	it('retains the R2 cursor when D1 rejects (truncated page, cursor unchanged)', async () => {
		// Pre-seed a cursor so we can detect any advance. Use a truncated
		// page so the reaper would persist a new cursor if it advanced.
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async (opts: { cursor?: string } = {}) => ({
					objects: [
						r2Object(`avatars/p1/token-${opts.cursor ?? 'seed'}`, OLD),
						r2Object('avatars/p1/token-B', OLD)
					],
					truncated: true,
					cursor: 'next-page'
				})),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		const seededCursor = 'seeded-cursor';
		kvStore.set('reaper:cursor:orphaned-avatars-r2', seededCursor);
		(getAvatarTokensByPlayerIds as any).mockRejectedValue(new Error('D1 down'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await reapOrphanedAvatars(env, NOW);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'avatar-gc-d1-unavailable')).toBe(true);
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalled();
		// The cursor must be unchanged — the same page will be retried on
		// the next run once D1 recovers.
		expect(kvStore.get('reaper:cursor:orphaned-avatars-r2')).toBe(seededCursor);
		// And the reaper must NOT have called list with the would-be next
		// cursor — only the seeded cursor.
		expect(env.PUZZLES_BUCKET.list).toHaveBeenCalledTimes(1);
		expect(env.PUZZLES_BUCKET.list).toHaveBeenCalledWith({
			prefix: 'avatars/',
			cursor: seededCursor,
			limit: AVATAR_GC_BATCH_LIMIT
		});
	});

	// Regression: after D1 recovers, the retained cursor must cause the
	// reaper to revisit the same page and process its orphans. This
	// verifies the recovery path the retained cursor enables.
	it('retries the same page on the next run after D1 recovers', async () => {
		const listCalls: Array<{ cursor?: string }> = [];
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async (opts: { cursor?: string } = {}) => {
					listCalls.push(opts);
					return {
						objects: [
							r2Object('avatars/p1/token-orphan', OLD),
							r2Object('avatars/p1/token-auth', OLD)
						],
						truncated: true,
						cursor: 'next-page'
					};
				}),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		const seededCursor = 'seeded-cursor';
		kvStore.set('reaper:cursor:orphaned-avatars-r2', seededCursor);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		// Run 1: D1 rejects — cursor must be retained.
		(getAvatarTokensByPlayerIds as any).mockRejectedValueOnce(new Error('D1 down'));
		const result1 = await reapOrphanedAvatars(env, NOW);
		expect(result1.reaped).toBe(0);
		expect(result1.errors).toBe(1);
		expect(kvStore.get('reaper:cursor:orphaned-avatars-r2')).toBe(seededCursor);

		// Run 2: D1 recovers — same page is revisited and orphans are reaped.
		(getAvatarTokensByPlayerIds as any).mockResolvedValueOnce(new Map([['p1', 'token-auth']]));
		const result2 = await reapOrphanedAvatars(env, NOW);
		expect(result2.reaped).toBe(1);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledWith('avatars/p1/token-orphan');
		// Both runs listed with the same seeded cursor — the second run
		// retried the same page, not the next one.
		expect(listCalls).toHaveLength(2);
		expect(listCalls[0]?.cursor).toBe(seededCursor);
		expect(listCalls[1]?.cursor).toBe(seededCursor);
		// After successful processing, the cursor advances.
		expect(kvStore.get('reaper:cursor:orphaned-avatars-r2')).toBe('next-page');
	});

	it('handles multiple players with mixed authoritative/orphan tokens', async () => {
		const env = makeAvatarEnv([
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/p1/token-B', uploaded: OLD },
			{ key: 'avatars/p2/token-C', uploaded: OLD },
			{ key: 'avatars/p2/token-D', uploaded: OLD }
		]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(
			new Map([
				['p1', 'token-A'],
				['p2', 'token-D']
			])
		);
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.candidates).toBe(2);
		expect(result.reaped).toBe(2);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledWith('avatars/p1/token-B');
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledWith('avatars/p2/token-C');
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalledWith('avatars/p1/token-A');
		expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalledWith('avatars/p2/token-D');
	});

	it('respects AVATAR_GC_BATCH_LIMIT (bounds list + deletes per run)', async () => {
		// More orphans than AVATAR_GC_BATCH_LIMIT. The reaper lists one page
		// of AVATAR_GC_BATCH_LIMIT objects per run and processes every
		// eligible orphan in that page, so the first run reaps exactly
		// AVATAR_GC_BATCH_LIMIT and persists the R2 cursor for the rest.
		const objects = Array.from({ length: AVATAR_GC_BATCH_LIMIT + 5 }, (_, i) => ({
			key: `avatars/p1/token-${i}`,
			uploaded: OLD
		}));
		const env = makeAvatarEnv(objects);
		// No authoritative token — all are orphans
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.scanned).toBe(AVATAR_GC_BATCH_LIMIT);
		expect(result.candidates).toBe(AVATAR_GC_BATCH_LIMIT);
		expect(result.reaped).toBe(AVATAR_GC_BATCH_LIMIT);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledTimes(AVATAR_GC_BATCH_LIMIT);
		// The list must be bounded by AVATAR_GC_BATCH_LIMIT.
		expect(env.PUZZLES_BUCKET.list).toHaveBeenCalledWith({
			prefix: 'avatars/',
			cursor: undefined,
			limit: AVATAR_GC_BATCH_LIMIT
		});
		// Remaining objects → cursor persisted for the next run.
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		expect(kvStore.has('reaper:cursor:orphaned-avatars-r2')).toBe(true);
	});

	it('handles R2 delete failure gracefully (records error, continues)', async () => {
		const env = makeAvatarEnv([
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/p1/token-B', uploaded: OLD }
		]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		env.PUZZLES_BUCKET.delete = vi.fn(async (key: string) => {
			if (key === 'avatars/p1/token-A') throw new Error('R2 delete failed');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.reaped).toBe(1);
		expect(result.errors).toBe(1);
		expect(result.details.some((d) => d.action === 'avatar-gc-delete-failed')).toBe(true);
	});

	it('lists one page per run and persists the cursor when truncated', async () => {
		// A truncated page must persist the R2 cursor so the next run
		// resumes. The reaper must make exactly ONE list call per run —
		// listing multiple pages per run would re-introduce the starvation
		// gap (R2 cursor advancing past unprocessed orphans).
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async () => ({
					objects: [r2Object('avatars/p1/token-A', OLD)],
					truncated: true,
					cursor: 'next-page'
				})),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(env.PUZZLES_BUCKET.list).toHaveBeenCalledTimes(1);
		expect(result.scanned).toBe(1);
		expect(result.reaped).toBe(1);
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		expect(kvStore.get('reaper:cursor:orphaned-avatars-r2')).toBe('next-page');
	});

	it('processes every orphan in a truncated page before advancing the cursor', async () => {
		// A truncated page with multiple orphans: every orphan in the page
		// must be deleted in this run. The cursor advances only past this
		// one page, so none of these orphans are deferred to a future sweep.
		const page = [
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/p1/token-B', uploaded: OLD },
			{ key: 'avatars/p2/token-C', uploaded: OLD }
		];
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async () => ({
					objects: page.map((o) => r2Object(o.key, o.uploaded)),
					truncated: true,
					cursor: 'next-page'
				})),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.scanned).toBe(3);
		expect(result.candidates).toBe(3);
		expect(result.reaped).toBe(3);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledTimes(3);
		// Cursor persisted for the next page.
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		expect(kvStore.get('reaper:cursor:orphaned-avatars-r2')).toBe('next-page');
	});

	it('resumes R2 listing from the persisted cursor on the next run', async () => {
		// Pre-seed the cursor so the first list call receives it. Verify
		// the reaper passes the stored cursor (and the limit) to R2.list.
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async (opts: { cursor?: string }) => ({
					objects: [r2Object(`avatars/p1/token-${opts.cursor ?? 'start'}`, OLD)],
					truncated: false,
					cursor: undefined
				})),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		kvStore.set('reaper:cursor:orphaned-avatars-r2', 'resumed-cursor');
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		await reapOrphanedAvatars(env, NOW);
		expect(env.PUZZLES_BUCKET.list).toHaveBeenCalledWith({
			prefix: 'avatars/',
			cursor: 'resumed-cursor',
			limit: AVATAR_GC_BATCH_LIMIT
		});
		// Listing completed (truncated=false) → cursor must be cleared.
		expect(kvStore.has('reaper:cursor:orphaned-avatars-r2')).toBe(false);
	});

	it('clears the R2 cursor when the page is not truncated', async () => {
		// A single non-truncated page completes the sweep for this run. The
		// cursor must be cleared so the next run starts a fresh sweep.
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async () => ({
					objects: [r2Object('avatars/p1/token-A', OLD)],
					truncated: false,
					cursor: undefined
				})),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		await reapOrphanedAvatars(env, NOW);
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		expect(kvStore.has('reaper:cursor:orphaned-avatars-r2')).toBe(false);
	});

	it('skips malformed keys (not avatars/{playerId}/{token})', async () => {
		const env = makeAvatarEnv([
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/', uploaded: OLD },
			{ key: 'avatars/p1/', uploaded: OLD },
			{ key: 'avatars/p1/token/A/extra', uploaded: OLD }
		]);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		// Only avatars/p1/token-A is a valid versioned key
		expect(result.scanned).toBe(4);
		expect(result.candidates).toBe(1);
		expect(result.reaped).toBe(1);
	});

	// Regression: D1 imposes a 100 bound parameter limit per query. Without
	// chunking in getAvatarTokensByPlayerIds, a reaper run with >100 distinct
	// players would throw, fail closed (catch block returns early), and skip
	// all deletion — so orphaned avatar objects would accumulate indefinitely.
	// The chunking fix is unit-tested in repositories.test.ts; this test
	// verifies the reaper correctly handles >100 players end-to-end: orphaned
	// objects are collected and authoritative objects are preserved. The list
	// is bounded to AVATAR_GC_BATCH_LIMIT per run, so a full sweep requires
	// multiple runs (240 objects / 200 per run = 2 runs).
	it('handles >100 distinct players (orphans collected, authoritative preserved)', async () => {
		const objects: Array<{ key: string; uploaded: number }> = [];
		const authoritativeMap = new Map<string, string | null>();
		for (let i = 0; i < 120; i++) {
			const playerId = `p${i}`;
			objects.push({ key: `avatars/${playerId}/token-auth`, uploaded: OLD });
			objects.push({ key: `avatars/${playerId}/token-orphan`, uploaded: OLD });
			authoritativeMap.set(playerId, 'token-auth');
		}
		const env = makeAvatarEnv(objects);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(authoritativeMap);
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		// Run the reaper repeatedly until the sweep completes (cursor cleared).
		// Each run lists one page of AVATAR_GC_BATCH_LIMIT objects and
		// processes every eligible orphan in that page.
		let totalReaped = 0;
		let runs = 0;
		while (runs < 10) {
			const result = await reapOrphanedAvatars(env, NOW);
			totalReaped += result.reaped;
			runs++;
			if (!kvStore.has('reaper:cursor:orphaned-avatars-r2')) break;
		}
		// Every player has one orphan object (token-orphan) — 120 total,
		// reaped across 2 runs (200 objects then 40).
		expect(runs).toBe(2);
		expect(totalReaped).toBe(120);
		// Authoritative objects must NOT be deleted.
		for (let i = 0; i < 120; i++) {
			expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalledWith(`avatars/p${i}/token-auth`);
		}
		// Orphan objects must be deleted.
		for (let i = 0; i < 120; i++) {
			expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledWith(`avatars/p${i}/token-orphan`);
		}
	});

	// Regression: the previous two-cursor design listed up to 10 R2 pages per
	// run but only deleted 200 orphans via a separate numeric cursor. The R2
	// cursor advanced past the entire window, so unselected orphans in that
	// window were not revisited until the full scan wrapped — and the numeric
	// cursor was then applied to a different orphan array, starving them
	// indefinitely. This test verifies the single-cursor fix: with more
	// orphans than fit in one page, every orphan is reaped across successive
	// runs, with no orphan left behind regardless of position in the bucket.
	it('reaps every orphan across multiple pages (no starvation)', async () => {
		// 3 full pages of orphans (AVATAR_GC_BATCH_LIMIT each) + a partial
		// page. All are orphans (no authoritative token).
		const totalObjects = AVATAR_GC_BATCH_LIMIT * 3 + 7;
		const objects = Array.from({ length: totalObjects }, (_, i) => ({
			key: `avatars/p${i}/token-${i}`,
			uploaded: OLD
		}));
		const env = makeAvatarEnv(objects);
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const kvStore = (env.PUZZLE_METADATA as any)._store as Map<string, string>;
		const deletedKeys = new Set<string>();
		env.PUZZLES_BUCKET.delete = vi.fn(async (key: string) => {
			deletedKeys.add(key);
		});
		// Run the reaper repeatedly until the sweep completes.
		let runs = 0;
		while (runs < 10) {
			await reapOrphanedAvatars(env, NOW);
			runs++;
			if (!kvStore.has('reaper:cursor:orphaned-avatars-r2')) break;
		}
		// 4 runs: 3 full pages + 1 partial page.
		expect(runs).toBe(4);
		// Every orphan must be deleted — no starvation.
		expect(deletedKeys.size).toBe(totalObjects);
		for (let i = 0; i < totalObjects; i++) {
			expect(deletedKeys.has(`avatars/p${i}/token-${i}`)).toBe(true);
		}
	});
});
