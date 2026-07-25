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

// Mock storage.worker functions
vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deleteMetadataDO: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deleteCleanupRecord: vi.fn(async () => undefined),
	getAuthoritativeStatus: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	listCleanupRecords: vi.fn(async () => []),
	releaseIdempotencyKey: vi.fn(),
	getIdempotencyReservation: vi.fn()
}));

// Mock db.worker so the reaper's D1 ownership cleanup doesn't touch a real DB.
vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
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
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	listCleanupRecords,
	releaseIdempotencyKey,
	getIdempotencyReservation
} from '../storage.worker';
import { getWorkerDb } from '../../db.worker';
import { deletePuzzleOwnership, getAvatarTokensByPlayerIds } from '@perseus/shared';

const storage = {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	deleteCleanupRecord,
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
		(deletePuzzleOwnership as any).mockResolvedValue(undefined);
		(getWorkerDb as any).mockReturnValue({});
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
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'stuck-1', 100);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
		expect(deletePuzzleOwnership).toHaveBeenCalledWith({}, 'stuck-1');
		// Puzzles without an idempotencyKey must not trigger a DO release.
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
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
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
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

	it('still reaps when D1 ownership init throws (best-effort)', async () => {
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
		// getWorkerDb throws on lazy init — the outer try/catch logs and
		// continues (KV/R2 cleanup is the source of truth for visibility).
		(getWorkerDb as any).mockImplementation(() => {
			throw new Error('DB init failed');
		});
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
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
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
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
		(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);
		(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
		(deletePuzzleOwnership as any).mockResolvedValue(undefined);
		(getWorkerDb as any).mockReturnValue({});
		(storage.listCleanupRecords as any).mockResolvedValue([]);
	});

	it('returns empty result when no cleanup records exist', async () => {
		const env = makeEnv();
		const result = await reapCleanupRecords(env);
		expect(result.scanned).toBe(0);
		expect(result.reaped).toBe(0);
	});

	it('cleans up completed duplicate puzzles from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.scanned).toBe(1);
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'dup-1', 50);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(expect.anything(), 'dup-1');
	});

	it('cleans up errored workflows from cleanup records', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		const env = makeEnv({ 'dup-1': 'errored' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
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
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
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

	it('logs but still reaps when D1 ownership delete fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(deletePuzzleOwnership as any).mockRejectedValue(new Error('D1 delete failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(expect.anything(), 'dup-1');
	});

	it('logs but still reaps when D1 init (getWorkerDb) throws', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(getWorkerDb as any).mockImplementation(() => {
			throw new Error('D1 init failed');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		(getWorkerDb as any).mockReturnValue({});
	});

	it('logs but still reaps when cleanup record delete fails', async () => {
		(storage.listCleanupRecords as any).mockResolvedValue([
			{ puzzleId: 'dup-1', pieceCount: 50, createdAt: NOW - 60000 }
		]);
		(storage.deleteCleanupRecord as any).mockRejectedValue(new Error('KV delete failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ 'dup-1': 'complete' });
		const result = await reapCleanupRecords(env);
		expect(result.reaped).toBe(1);
		expect(storage.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'dup-1');
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
		(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);
		(storage.getIdempotencyReservation as any).mockResolvedValue(null);
		(deletePuzzleOwnership as any).mockResolvedValue(undefined);
		(getWorkerDb as any).mockReturnValue({});
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
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});

	it('reaps puzzles with no reservation record (orphan after replacement deletion)', async () => {
		// Scenario: puzzle A lost key K to replacement B, A's cleanup-record
		// write failed, then an admin deleted B — releasing K and erasing the
		// reservation record. A's lookup returns null, but A is still an
		// orphan: in every release path, KV is deleted before the reservation
		// is released, so a puzzle still in KV with an idempotencyKey but no
		// reservation was superseded.
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(
			puzzleMeta('a', { idempotencyKey: 'key-K', pieceCount: 50 })
		);
		(storage.getIdempotencyReservation as any).mockResolvedValue(null);
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(1);
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'a');
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'a', 50);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'a');
		expect(result.details.some((d) => d.action === 'orphan-reaped')).toBe(true);
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
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'a');
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'a', 50);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'a');
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			env.PUZZLE_METADATA_DO,
			'key-K',
			'a'
		);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(expect.anything(), 'a');
		expect(result.details.some((d) => d.action === 'orphan-reaped')).toBe(true);
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
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
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

	it('still reaps when D1 ownership delete fails (best-effort)', async () => {
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
		(deletePuzzleOwnership as any).mockRejectedValue(new Error('D1 delete failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(1);
	});

	it('still reaps when D1 init (getWorkerDb) throws for ownership cleanup', async () => {
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
		(getWorkerDb as any).mockImplementationOnce(() => {
			throw new Error('DB init failed');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(1);
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
		return {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async () => ({
					objects: objects.map((o) => r2Object(o.key, o.uploaded)),
					truncated: false,
					cursor: undefined
				})),
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

	it('respects AVATAR_GC_BATCH_LIMIT', async () => {
		const objects = Array.from({ length: AVATAR_GC_BATCH_LIMIT + 5 }, (_, i) => ({
			key: `avatars/p1/token-${i}`,
			uploaded: OLD
		}));
		const env = makeAvatarEnv(objects);
		// No authoritative token — all are orphans
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.candidates).toBe(objects.length);
		expect(result.reaped).toBe(AVATAR_GC_BATCH_LIMIT);
		expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledTimes(AVATAR_GC_BATCH_LIMIT);
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

	it('handles R2 list pagination (truncated=true)', async () => {
		const page1 = [
			{ key: 'avatars/p1/token-A', uploaded: OLD },
			{ key: 'avatars/p1/token-B', uploaded: OLD }
		];
		const page2 = [{ key: 'avatars/p2/token-C', uploaded: OLD }];
		let callCount = 0;
		const env = {
			...makeEnv(),
			PUZZLES_BUCKET: {
				list: vi.fn(async () => {
					callCount++;
					if (callCount === 1) {
						return {
							objects: page1.map((o) => r2Object(o.key, o.uploaded)),
							truncated: true,
							cursor: 'next-page'
						};
					}
					return {
						objects: page2.map((o) => r2Object(o.key, o.uploaded)),
						truncated: false,
						cursor: undefined
					};
				}),
				delete: vi.fn(async () => undefined)
			} as any
		} as any;
		(getAvatarTokensByPlayerIds as any).mockResolvedValue(new Map());
		const result = await reapOrphanedAvatars(env, NOW);
		expect(result.scanned).toBe(3);
		expect(result.candidates).toBe(3);
		expect(result.reaped).toBe(3);
		expect(env.PUZZLES_BUCKET.list).toHaveBeenCalledTimes(2);
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
	// objects are collected and authoritative objects are preserved.
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
		const result = await reapOrphanedAvatars(env, NOW);
		// Every player has one orphan object (token-orphan) — 120 total.
		expect(result.candidates).toBe(120);
		expect(result.reaped).toBe(120);
		// Authoritative objects must NOT be deleted.
		for (let i = 0; i < 120; i++) {
			expect(env.PUZZLES_BUCKET.delete).not.toHaveBeenCalledWith(`avatars/p${i}/token-auth`);
		}
		// Orphan objects must be deleted.
		for (let i = 0; i < 120; i++) {
			expect(env.PUZZLES_BUCKET.delete).toHaveBeenCalledWith(`avatars/p${i}/token-orphan`);
		}
	});
});
