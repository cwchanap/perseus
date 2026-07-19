/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn()
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
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
	deletePuzzleMetadata,
	getPuzzle,
	listPuzzles
} from '../storage.worker';
import { deletePuzzleOwnership } from '@perseus/shared';

const NOW = 1700000000000;

function makeEnv() {
	return {
		PUZZLE_METADATA: {} as KVNamespace,
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
		vi.mocked(listPuzzles).mockResolvedValue({
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
		vi.mocked(getPuzzle).mockResolvedValue({
			id: 'stuck-puzzle',
			name: 'Stuck Puzzle',
			status: 'processing',
			pieceCount: undefined
		} as any);
		vi.mocked(deletePuzzleAssets).mockResolvedValue({ success: true, failedKeys: [] });
		vi.mocked(deletePuzzleMetadata).mockResolvedValue({ success: true } as any);
	});

	it('still reaps when the best-effort D1 ownership deletion rejects', async () => {
		vi.mocked(deletePuzzleOwnership).mockRejectedValue(new Error('D1 delete failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv();

		const result = await reapStuckPuzzles(env, NOW);

		expect(result.reaped).toBe(1);
		expect(deletePuzzleAssets).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'stuck-puzzle', 0);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Reaper: failed to delete D1 ownership for stuck-puzzle:',
			expect.any(Error)
		);
	});
});
