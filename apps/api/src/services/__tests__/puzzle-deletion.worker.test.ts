import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	writeCleanupRecord: vi.fn(),
	deleteCleanupRecord: vi.fn(),
	beginPuzzleDeletion: vi.fn(),
	finishPuzzleDeletion: vi.fn(),
	deletePuzzleOwnership: vi.fn(),
	db: {}
}));

vi.mock('../storage.worker', () => ({
	writeCleanupRecord: mocks.writeCleanupRecord,
	deleteCleanupRecord: mocks.deleteCleanupRecord
}));

vi.mock('../../db.worker', () => ({
	getWorkerDbContext: vi.fn(() => ({
		db: mocks.db,
		completionWrites: {
			beginPuzzleDeletion: mocks.beginPuzzleDeletion,
			finishPuzzleDeletion: mocks.finishPuzzleDeletion
		}
	}))
}));

vi.mock('@perseus/shared', () => ({
	deletePuzzleOwnership: mocks.deletePuzzleOwnership
}));

import {
	ensureWorkerPuzzleDeletionFence,
	finishWorkerPuzzleDeletion
} from '../puzzle-deletion.worker';
import type { Env } from '../../worker';
import type { CleanupRecord } from '../storage.worker';

const env = {
	PUZZLE_METADATA: {}
} as Env;

const record: CleanupRecord = {
	puzzleId: 'puzzle-1',
	pieceCount: 16,
	idempotencyKey: 'upload-1',
	createdAt: 1_700_000_000_000
};

describe('Worker puzzle deletion lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.writeCleanupRecord.mockResolvedValue(undefined);
		mocks.deleteCleanupRecord.mockResolvedValue(undefined);
		mocks.beginPuzzleDeletion.mockResolvedValue(undefined);
		mocks.finishPuzzleDeletion.mockResolvedValue(undefined);
		mocks.deletePuzzleOwnership.mockResolvedValue(undefined);
	});

	it('writes the cleanup record before beginning the D1 deletion fence', async () => {
		await ensureWorkerPuzzleDeletionFence(env, record, 1_700_000_000_123);

		expect(mocks.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, record);
		expect(mocks.beginPuzzleDeletion).toHaveBeenCalledWith('puzzle-1', 1_700_000_000_123);
		expect(mocks.writeCleanupRecord.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.beginPuzzleDeletion.mock.invocationCallOrder[0]
		);
	});

	it('does not begin D1 deletion when the cleanup record write fails', async () => {
		mocks.writeCleanupRecord.mockRejectedValueOnce(new Error('KV unavailable'));

		await expect(ensureWorkerPuzzleDeletionFence(env, record, 1_700_000_000_123)).rejects.toThrow(
			'KV unavailable'
		);

		expect(mocks.beginPuzzleDeletion).not.toHaveBeenCalled();
	});

	it('retains the written cleanup record when beginning D1 deletion fails', async () => {
		mocks.beginPuzzleDeletion.mockRejectedValueOnce(new Error('D1 unavailable'));

		await expect(ensureWorkerPuzzleDeletionFence(env, record, 1_700_000_000_123)).rejects.toThrow(
			'D1 unavailable'
		);

		expect(mocks.writeCleanupRecord).toHaveBeenCalledOnce();
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('safely repeats the record write and D1 begin on retries', async () => {
		await ensureWorkerPuzzleDeletionFence(env, record, 1_700_000_000_123);
		await ensureWorkerPuzzleDeletionFence(env, record, 1_700_000_000_123);

		expect(mocks.writeCleanupRecord).toHaveBeenCalledTimes(2);
		expect(mocks.beginPuzzleDeletion).toHaveBeenCalledTimes(2);
		expect(mocks.writeCleanupRecord).toHaveBeenNthCalledWith(2, env.PUZZLE_METADATA, record);
		expect(mocks.beginPuzzleDeletion).toHaveBeenNthCalledWith(2, 'puzzle-1', 1_700_000_000_123);
	});

	it('finishes completion data, ownership, then the cleanup record', async () => {
		await finishWorkerPuzzleDeletion(env, 'puzzle-1');

		expect(mocks.finishPuzzleDeletion).toHaveBeenCalledWith('puzzle-1');
		expect(mocks.deletePuzzleOwnership).toHaveBeenCalledWith(mocks.db, 'puzzle-1');
		expect(mocks.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'puzzle-1');
		expect(mocks.finishPuzzleDeletion.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deletePuzzleOwnership.mock.invocationCallOrder[0]
		);
		expect(mocks.deletePuzzleOwnership.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deleteCleanupRecord.mock.invocationCallOrder[0]
		);
	});

	it('does not delete ownership or the record when completion cleanup fails', async () => {
		mocks.finishPuzzleDeletion.mockRejectedValueOnce(new Error('completion cleanup failed'));

		await expect(finishWorkerPuzzleDeletion(env, 'puzzle-1')).rejects.toThrow(
			'completion cleanup failed'
		);

		expect(mocks.deletePuzzleOwnership).not.toHaveBeenCalled();
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('does not delete the record when ownership cleanup fails', async () => {
		mocks.deletePuzzleOwnership.mockRejectedValueOnce(new Error('ownership cleanup failed'));

		await expect(finishWorkerPuzzleDeletion(env, 'puzzle-1')).rejects.toThrow(
			'ownership cleanup failed'
		);

		expect(mocks.finishPuzzleDeletion).toHaveBeenCalledOnce();
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('rejects record deletion failure after both database cleanups complete', async () => {
		mocks.deleteCleanupRecord.mockRejectedValueOnce(new Error('record delete failed'));

		await expect(finishWorkerPuzzleDeletion(env, 'puzzle-1')).rejects.toThrow(
			'record delete failed'
		);

		expect(mocks.finishPuzzleDeletion).toHaveBeenCalledOnce();
		expect(mocks.deletePuzzleOwnership).toHaveBeenCalledOnce();
	});
});
