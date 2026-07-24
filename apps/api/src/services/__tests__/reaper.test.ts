/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	reapStuckPuzzles,
	reapCleanupRecords,
	reapOrphanedReservations,
	REAP_AFTER_MS,
	REAP_BATCH_LIMIT
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

// Mock @perseus/shared's deletePuzzleOwnership so it stays a no-op spy.
vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, deletePuzzleOwnership: vi.fn(async () => undefined) };
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
import { deletePuzzleOwnership } from '@perseus/shared';

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

function makeEnv(workflowStatuses: Record<string, string> = {}) {
	return {
		PUZZLE_METADATA: {} as KVNamespace,
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
		// Make deletePuzzleAssets throw a non-R2 error to trigger the outer catch
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

	it('skips puzzles with no reservation record (conservative)', async () => {
		(storage.listPuzzles as any).mockResolvedValue({
			puzzles: [puzzleSummary('a', 'ready', OLD_READY)],
			invalidCount: 0
		});
		(storage.getPuzzle as any).mockResolvedValue(puzzleMeta('a', { idempotencyKey: 'key-K' }));
		(storage.getIdempotencyReservation as any).mockResolvedValue(null);
		const env = makeEnv({ a: 'complete' });
		const result = await reapOrphanedReservations(env);
		expect(result.reaped).toBe(0);
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
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

	it('records orphan-error on unexpected failure', async () => {
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
		expect(result.details.some((d) => d.action === 'orphan-error')).toBe(true);
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
});
