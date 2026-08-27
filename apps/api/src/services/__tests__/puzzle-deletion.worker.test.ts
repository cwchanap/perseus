import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUZZLE_DIFFICULTIES } from '@perseus/types';

const mocks = vi.hoisted(() => ({
	writeCleanupRecord: vi.fn(),
	deleteCleanupRecord: vi.fn(),
	beginPuzzleDeletion: vi.fn(),
	finishPuzzleDeletion: vi.fn(),
	finishFamilyFirstClears: vi.fn(),
	deletePuzzleFamilyOwnership: vi.fn(),
	deleteMetadataDO: vi.fn(),
	deleteFamilyCleanupAssets: vi.fn(),
	deleteFamilyMetadata: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	db: {}
}));

vi.mock('../storage.worker', () => ({
	writeCleanupRecord: mocks.writeCleanupRecord,
	deleteCleanupRecord: mocks.deleteCleanupRecord,
	deleteMetadataDO: mocks.deleteMetadataDO,
	deleteFamilyCleanupAssets: mocks.deleteFamilyCleanupAssets,
	deleteFamilyMetadata: mocks.deleteFamilyMetadata,
	deletePuzzleMetadata: mocks.deletePuzzleMetadata
}));

vi.mock('../../db.worker', () => ({
	getWorkerDbContext: vi.fn(() => ({
		db: mocks.db,
		completionWrites: {
			beginPuzzleDeletion: mocks.beginPuzzleDeletion,
			finishPuzzleDeletion: mocks.finishPuzzleDeletion,
			finishFamilyFirstClears: mocks.finishFamilyFirstClears
		}
	}))
}));

vi.mock('@perseus/shared', () => ({
	deletePuzzleFamilyOwnership: mocks.deletePuzzleFamilyOwnership
}));

import {
	ensureWorkerPuzzleDeletionFence,
	finishWorkerPuzzleDeletion,
	executeFamilySourceDeletion
} from '../puzzle-deletion.worker';
import type { Env } from '../../worker';
import type { CleanupRecord } from '../storage.worker';

const env = {
	PUZZLE_METADATA: {},
	PUZZLES_BUCKET: {},
	PUZZLE_METADATA_DO: {}
} as Env;

const record: CleanupRecord = {
	familyId: 'family-1',
	variantIds: {
		easy: 'variant-easy',
		normal: 'variant-normal',
		hard: 'variant-hard'
	},
	pieceCounts: {
		easy: 16,
		normal: 49,
		hard: 100
	},
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
		mocks.finishFamilyFirstClears.mockResolvedValue(undefined);
		mocks.deletePuzzleFamilyOwnership.mockResolvedValue(undefined);
		mocks.deleteMetadataDO.mockResolvedValue(undefined);
		mocks.deleteFamilyCleanupAssets.mockResolvedValue({ success: true, failedKeys: [] });
		mocks.deleteFamilyMetadata.mockResolvedValue({ success: true });
		mocks.deletePuzzleMetadata.mockResolvedValue({ success: true });
	});

	it('writes the cleanup record before beginning D1 deletion fences for all variants', async () => {
		await ensureWorkerPuzzleDeletionFence(env, record, 1_700_000_000_123);

		expect(mocks.writeCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, record);
		for (const difficulty of PUZZLE_DIFFICULTIES) {
			expect(mocks.beginPuzzleDeletion).toHaveBeenCalledWith(
				record.variantIds[difficulty],
				1_700_000_000_123
			);
		}
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
		expect(mocks.beginPuzzleDeletion).toHaveBeenCalledTimes(PUZZLE_DIFFICULTIES.length * 2);
	});

	it('deletes family ownership, finishes all variant fences, then the cleanup record', async () => {
		await finishWorkerPuzzleDeletion(env, record);

		expect(mocks.deletePuzzleFamilyOwnership).toHaveBeenCalledWith(mocks.db, 'family-1');
		for (const difficulty of PUZZLE_DIFFICULTIES) {
			expect(mocks.finishPuzzleDeletion).toHaveBeenCalledWith(record.variantIds[difficulty]);
		}
		expect(mocks.finishFamilyFirstClears).toHaveBeenCalledWith('family-1');
		expect(mocks.deleteCleanupRecord).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'family-1');
		expect(mocks.deletePuzzleFamilyOwnership.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.finishPuzzleDeletion.mock.invocationCallOrder[0]
		);
		expect(
			mocks.finishPuzzleDeletion.mock.invocationCallOrder[PUZZLE_DIFFICULTIES.length - 1]
		).toBeLessThan(mocks.finishFamilyFirstClears.mock.invocationCallOrder[0]);
		expect(mocks.finishFamilyFirstClears.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deleteCleanupRecord.mock.invocationCallOrder[0]
		);
	});

	it('does not delete the record when variant completion cleanup fails after ownership', async () => {
		mocks.finishPuzzleDeletion.mockRejectedValueOnce(new Error('completion cleanup failed'));

		await expect(finishWorkerPuzzleDeletion(env, record)).rejects.toThrow(
			'completion cleanup failed'
		);

		expect(mocks.deletePuzzleFamilyOwnership).toHaveBeenCalledOnce();
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('does not delete the record when ownership cleanup fails', async () => {
		mocks.deletePuzzleFamilyOwnership.mockRejectedValueOnce(new Error('ownership cleanup failed'));

		await expect(finishWorkerPuzzleDeletion(env, record)).rejects.toThrow(
			'ownership cleanup failed'
		);

		expect(mocks.finishPuzzleDeletion).not.toHaveBeenCalled();
		expect(mocks.finishFamilyFirstClears).not.toHaveBeenCalled();
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('rejects record deletion failure after database cleanups complete', async () => {
		mocks.deleteCleanupRecord.mockRejectedValueOnce(new Error('record delete failed'));

		await expect(finishWorkerPuzzleDeletion(env, record)).rejects.toThrow('record delete failed');

		expect(mocks.deletePuzzleFamilyOwnership).toHaveBeenCalledOnce();
		expect(mocks.finishPuzzleDeletion).toHaveBeenCalledTimes(PUZZLE_DIFFICULTIES.length);
	});
});

describe('executeFamilySourceDeletion reservation release order', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deleteCleanupRecord.mockResolvedValue(undefined);
		mocks.finishPuzzleDeletion.mockResolvedValue(undefined);
		mocks.finishFamilyFirstClears.mockResolvedValue(undefined);
		mocks.deletePuzzleFamilyOwnership.mockResolvedValue(undefined);
		mocks.deleteMetadataDO.mockResolvedValue(undefined);
		mocks.deleteFamilyCleanupAssets.mockResolvedValue({ success: true, failedKeys: [] });
		mocks.deleteFamilyMetadata.mockResolvedValue({ success: true });
		mocks.deletePuzzleMetadata.mockResolvedValue({ success: true });
	});

	it('finishes all variants before reservation release and record deletion', async () => {
		const release = vi.fn(async () => undefined);

		const result = await executeFamilySourceDeletion(env, record, release);

		expect(result).toEqual({ ok: true });
		for (const difficulty of PUZZLE_DIFFICULTIES) {
			expect(mocks.finishPuzzleDeletion).toHaveBeenCalledWith(record.variantIds[difficulty]);
		}
		expect(release).toHaveBeenCalledOnce();
		expect(mocks.finishPuzzleDeletion.mock.invocationCallOrder.at(-1)).toBeLessThan(
			release.mock.invocationCallOrder[0]
		);
		expect(release.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deleteCleanupRecord.mock.invocationCallOrder[0]
		);
	});

	it('retains the cleanup record when reservation release fails', async () => {
		const release = vi.fn(async () => {
			throw new Error('DO unavailable');
		});

		const result = await executeFamilySourceDeletion(env, record, release);

		expect(result).toEqual({ ok: false, step: 'release', error: expect.any(Error) });
		expect(mocks.finishPuzzleDeletion).toHaveBeenCalledTimes(PUZZLE_DIFFICULTIES.length);
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});

	it('reports a kv-family failure when family metadata deletion fails', async () => {
		const kvError = new Error('family KV delete failed');
		mocks.deleteFamilyMetadata.mockResolvedValueOnce({ success: false, error: kvError });

		const result = await executeFamilySourceDeletion(
			env,
			record,
			vi.fn(async () => undefined)
		);

		expect(result).toEqual({ ok: false, step: 'kv-family', error: kvError });
		expect(mocks.deletePuzzleMetadata).not.toHaveBeenCalled();
		expect(mocks.deleteCleanupRecord).not.toHaveBeenCalled();
	});
});
