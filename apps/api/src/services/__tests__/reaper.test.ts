/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reapStuckPuzzles, REAP_AFTER_MS } from '../reaper';

// Mock storage.worker functions
vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	releaseIdempotencyKey: vi.fn()
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
	deletePuzzleMetadata,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} from '../storage.worker';
import { getWorkerDb } from '../../db.worker';
import { deletePuzzleOwnership } from '@perseus/shared';

const storage = {
	deletePuzzleAssets,
	deletePuzzleMetadata,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
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

	it('reaps stuck processing puzzles whose workflow is unknown (never created)', async () => {
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
		expect(result.reaped).toBe(1);
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

	it('still deletes KV metadata when R2 asset deletion fails', async () => {
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
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		expect(result.reaped).toBe(1);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
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

	it('records a partial-failure detail when some R2 assets fail to delete', async () => {
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
		const env = makeEnv({ 'stuck-1': 'errored' });
		const result = await reapStuckPuzzles(env, NOW);
		// KV + D1 cleanup still proceeds — R2 partial failure is best-effort.
		expect(result.reaped).toBe(1);
		expect(result.details.some((d) => d.action === 'r2-delete-partial')).toBe(true);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
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
});
