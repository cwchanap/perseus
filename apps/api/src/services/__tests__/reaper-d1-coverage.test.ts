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
	deleteFamilyCleanupAssets: vi.fn(),
	deleteMetadataDO: vi.fn(),
	deleteFamilyMetadata: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deleteCleanupRecord: vi.fn(),
	writeCleanupRecord: vi.fn(),
	getAuthoritativeStatus: vi.fn(),
	getFamily: vi.fn(),
	listFamilies: vi.fn(),
	releaseIdempotencyKey: vi.fn(),
	buildCleanupRecordFromFamily: vi.fn(
		(family: { id: string; variants?: Record<string, string> }) => ({
			familyId: family.id,
			variantIds: family.variants ?? {
				easy: `${family.id}-easy`,
				normal: `${family.id}-normal`,
				hard: `${family.id}-hard`
			},
			pieceCounts: { easy: 16, normal: 49, hard: 100 },
			createdAt: Date.now()
		})
	)
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		deletePuzzleFamilyOwnership: vi.fn()
	};
});

import { reapStuckPuzzles, REAP_AFTER_MS } from '../reaper';
import {
	deleteFamilyCleanupAssets,
	deleteMetadataDO,
	deleteFamilyMetadata,
	deletePuzzleMetadata,
	deleteCleanupRecord,
	writeCleanupRecord,
	getAuthoritativeStatus,
	getFamily,
	listFamilies,
	releaseIdempotencyKey
} from '../storage.worker';
import { deletePuzzleFamilyOwnership } from '@perseus/shared';

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
		(listFamilies as any).mockResolvedValue({
			families: [
				{
					id: 'stuck-puzzle',
					name: 'Stuck Puzzle',
					status: 'processing',
					createdAt: NOW - REAP_AFTER_MS - 1,
					aspectRatio: '1:1'
				}
			],
			invalidCount: 0
		} as any);
		(getFamily as any).mockResolvedValue({
			id: 'stuck-puzzle',
			name: 'Stuck Puzzle',
			status: 'processing',
			createdAt: NOW - REAP_AFTER_MS - 1,
			aspectRatio: '1:1',
			variants: {
				easy: 'stuck-puzzle-easy',
				normal: 'stuck-puzzle-normal',
				hard: 'stuck-puzzle-hard'
			}
		} as any);
		(getAuthoritativeStatus as any).mockResolvedValue('processing');
		(deleteFamilyCleanupAssets as any).mockResolvedValue({ success: true, failedKeys: [] });
		(deleteMetadataDO as any).mockResolvedValue(undefined);
		(deleteFamilyMetadata as any).mockResolvedValue({ success: true } as any);
		(deletePuzzleMetadata as any).mockResolvedValue({ success: true } as any);
		(deleteCleanupRecord as any).mockResolvedValue(undefined);
		(writeCleanupRecord as any).mockResolvedValue(undefined);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
	});

	it('retains the deletion fence when required D1 ownership deletion rejects', async () => {
		(deletePuzzleFamilyOwnership as any).mockRejectedValue(new Error('D1 delete failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = makeEnv();

		const result = await reapStuckPuzzles(env, NOW);

		expect(result.reaped).toBe(0);
		expect(result.errors).toBe(1);
		expect(writeCleanupRecord).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.objectContaining({ familyId: 'stuck-puzzle' })
		);
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
			'stuck-puzzle-easy',
			expect.any(Number)
		);
		expect(deleteFamilyCleanupAssets).toHaveBeenCalled();
		expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(dbContextMock.db, 'stuck-puzzle');
		expect(deleteCleanupRecord).not.toHaveBeenCalled();
		expect(result.details).toContainEqual(
			expect.objectContaining({ puzzleId: 'stuck-puzzle', action: 'd1-finish-failed' })
		);
		expect(consoleSpy).toHaveBeenCalled();
	});
});
