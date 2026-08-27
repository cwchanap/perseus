/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for admin.worker.ts best-effort D1 ownership catch blocks:
 * - getWorkerDb throwing on the ownership insert (line 612)
 * - deletePuzzleFamilyOwnership rejecting during missing-workflow-binding cleanup (line 633)
 * - getWorkerDb throwing during missing-workflow-binding cleanup (line 636)
 * - deletePuzzleFamilyOwnership rejecting during workflow-trigger-failure cleanup (line 671)
 * - getWorkerDb throwing during workflow-trigger-failure cleanup (line 674)
 * - getWorkerDbContext throwing before committed DELETE source mutation
 * - required completion cleanup rejecting after DELETE source mutation
 *
 * Creation rollback ownership paths remain best-effort. Committed admin
 * deletion requires the D1 fence and finish lifecycle to succeed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		write: vi.fn(),
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false),
		beginPuzzleDeletion: vi.fn(async () => undefined),
		finishPuzzleDeletion: vi.fn(async () => undefined)
	}
}));

vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		deletePuzzleAssets: vi.fn(),
		deleteFamilyCleanupAssets: vi.fn().mockResolvedValue({ success: true, failedKeys: [] }),
		deletePuzzleMetadata: vi
			.fn()
			.mockResolvedValue({ success: true })
			.mockResolvedValue({ success: true }),
		createPuzzleMetadata: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined),
		createFamilyMetadata: vi.fn().mockResolvedValue(undefined),
		deleteFamilyMetadata: vi.fn().mockResolvedValue({ success: true }),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined),
		deleteOriginalImage: vi
			.fn()
			.mockResolvedValue({ success: true })
			.mockResolvedValue({ success: true }),
		originalImageExists: vi.fn().mockResolvedValue(false),
		puzzleExists: vi.fn().mockResolvedValue(false),
		listFamilies: vi.fn(),
		enrichFamilySummary: vi.fn(),
		deleteMetadataDO: vi.fn().mockResolvedValue(undefined),
		writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
		deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return { ...original, ...sharedMockOverrides };
});

import {
	cleanupRecordMatcher,
	makeFamilyMetadata,
	PIECE_COUNTS_1_1,
	variantIdsForFamily
} from './helpers/family-fixtures';
import admin from '../admin.worker';
import { getWorkerDb, getWorkerDbContext } from '../../db.worker';
import { deletePuzzleFamilyOwnership } from '@perseus/shared';
import * as storage from '../../services/storage.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

const baseEnv = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

function buildFormData(): FormData {
	const formData = new FormData();
	formData.append('name', 'Coverage Puzzle');
	const blob = new Blob([PNG_HEADER], { type: 'image/png' });
	formData.append('image', blob, 'test.png');
	return formData;
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440002';

describe('Admin Worker - D1 ownership best-effort catch blocks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		// Restore default non-throwing getWorkerDb between tests.
		vi.mocked(getWorkerDb).mockImplementation(() => dbContextMock.db as any);
		vi.mocked(getWorkerDbContext).mockImplementation(() => dbContextMock as any);
		vi.mocked(deletePuzzleFamilyOwnership).mockResolvedValue(undefined as any);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('still returns 201 when getWorkerDb throws on the ownership insert (line 612)', async () => {
		vi.mocked(getWorkerDb).mockImplementation(() => {
			throw new Error('DB init failed');
		});
		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
		};
		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(201);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to init DB for ownership insert'),
			expect.any(Error)
		);
	});

	it('logs when deletePuzzleFamilyOwnership rejects during missing-workflow-binding cleanup (line 633)', async () => {
		// No PUZZLE_WORKFLOW binding → the missing-binding branch runs and
		// attempts to clean up the ownership row just inserted.
		vi.mocked(deletePuzzleFamilyOwnership).mockRejectedValueOnce(new Error('D1 down') as any);
		const mockEnv = { ...baseEnv };
		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(503);
		expect(console.error).toHaveBeenCalledWith(
			'Failed to cleanup ownership after missing workflow binding:',
			expect.any(Error)
		);
	});

	it('still returns 503 when getWorkerDb throws during missing-workflow-binding cleanup (line 636)', async () => {
		// getWorkerDb returns {} for the insert (line 602) but throws when
		// called again for the missing-binding cleanup (line 632).
		let callCount = 0;
		vi.mocked(getWorkerDb).mockImplementation(() => {
			callCount++;
			if (callCount > 1) throw new Error('DB init failed');
			return {} as any;
		});
		const mockEnv = { ...baseEnv };
		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(503);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to init DB for ownership cleanup'),
			expect.any(Error)
		);
	});

	it('logs when deletePuzzleFamilyOwnership rejects during workflow-trigger-failure cleanup (line 671)', async () => {
		vi.mocked(deletePuzzleFamilyOwnership).mockRejectedValueOnce(new Error('D1 down') as any);
		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: {
				create: vi.fn().mockRejectedValue(new Error('Workflow unavailable')),
				get: vi.fn().mockRejectedValue(
					Object.assign(new Error('instance.not_found'), {
						code: 'instance.not_found'
					})
				)
			}
		};
		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			'Failed to cleanup ownership after workflow trigger failure:',
			expect.any(Error)
		);
	});

	it('still returns 500 when getWorkerDb throws during workflow-trigger-failure cleanup (line 674)', async () => {
		let callCount = 0;
		vi.mocked(getWorkerDb).mockImplementation(() => {
			callCount++;
			if (callCount > 1) throw new Error('DB init failed');
			return {} as any;
		});
		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: {
				create: vi.fn().mockRejectedValue(new Error('Workflow unavailable')),
				get: vi.fn().mockRejectedValue(
					Object.assign(new Error('instance.not_found'), {
						code: 'instance.not_found'
					})
				)
			}
		};
		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to init DB for ownership cleanup'),
			expect.any(Error)
		);
	});

	it('returns 500 without source mutation when DELETE fence DB init fails', async () => {
		vi.mocked(getWorkerDbContext).mockImplementation(() => {
			throw new Error('DB init failed');
		});
		vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(VALID_UUID, 'ready'));
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true } as any);
		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		} as any);

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request(`http://localhost/puzzle-family-delete/${VALID_UUID}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to begin fenced cleanup for ${VALID_UUID}`),
			expect.any(Error)
		);
		expect(storage.writeCleanupRecord).toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
	});

	it('returns 500 and retains the record when required completion cleanup rejects', async () => {
		vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(VALID_UUID, 'ready'));
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true } as any);
		vi.mocked(storage.deleteFamilyCleanupAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		} as any);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 stats down')
		);

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request(`http://localhost/puzzle-family-delete/${VALID_UUID}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});
		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to finish fenced cleanup for ${VALID_UUID}`),
			expect.any(Error)
		);
		expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(dbContextMock.db, VALID_UUID);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
	});
});
