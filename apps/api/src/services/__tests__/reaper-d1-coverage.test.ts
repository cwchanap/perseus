/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		write: vi.fn(),
		beginPuzzleDeletion: vi.fn(async () => undefined),
		finishPuzzleDeletion: vi.fn(async () => undefined)
	}
}));

vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deleteMetadataDO: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deleteCleanupRecord: vi.fn(),
	writeCleanupRecord: vi.fn(),
	getAuthoritativeStatus: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	releaseIdempotencyKey: vi.fn()
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		deletePuzzleOwnership: vi.fn()
	};
});

import { reapStuckPuzzles, REAP_AFTER_MS } from '../reaper';
import {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	deleteCleanupRecord,
	writeCleanupRecord,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} from '../storage.worker';
import { deletePuzzleOwnership } from '@perseus/shared';

void releaseIdempotencyKey;

const NOW = 1700000000000;

function makeEnv() {
	return {
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: {
			get: vi.fn(async () => ({
				status: vi.fn(async () => ({ status: 'errored' }))
			}))
		}
	} as any;
}

describe('reaper D1 cleanup coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(listPuzzles as any).mockResolvedValue({
			puzzles: [
				{
					id: 'stuck-puzzle',
					name: 'Stuck Puzzle',
					pieceCount: 0,
					status: 'processing',
					createdAt: NOW - REAP_AFTER_MS - 1
				}
			],
			invalidCount: 0
		} as any);
		(getPuzzle as any).mockResolvedValue({
			id: 'stuck-puzzle',
			name: 'Stuck Puzzle',
			status: 'processing',
			pieceCount: undefined
		} as any);
		(getAuthoritativeStatus as any).mockResolvedValue('processing');
		(deletePuzzleAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(deleteMetadataDO as any).mockResolvedValue(undefined);
		(deletePuzzleMetadata as any).mockResolvedValue({ success: true } as any);
		(deleteCleanupRecord as any).mockResolvedValue(undefined);
		(writeCleanupRecord as any).mockResolvedValue(undefined);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
	});

	it('retains the deletion fence when required D1 ownership deletion rejects', async () => {
		(deletePuzzleOwnership as any).mockRejectedValue(new Error('D1 delete failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv();

		const result = await reapStuckPuzzles(env, NOW);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: 'stuck-puzzle', pieceCount: 0 })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'stuck-puzzle',
			expect.any(Number)
		);
		expect(deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'stuck-puzzle', 0);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(dbContextMock.db, 'stuck-puzzle');
		expect(deleteCleanupRecord).not.toHaveBeenCalled();
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'stuck-puzzle', action: 'd1-finish-failed' })
		);
		expect(consoleSpy).toHaveBeenCalled();
	});
});
