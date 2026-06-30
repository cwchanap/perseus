/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage test for admin.worker.ts DELETE /puzzles/:id ownership delete
 * catch block (line 691).
 *
 * The ownership delete is best-effort: when deletePuzzleOwnership rejects,
 * the route logs the error but still proceeds with R2 asset deletion and
 * returns the final result (204 or 207).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn(),
	listPuzzles: vi.fn()
}));

vi.mock('../../middleware/auth.worker', () => ({
	verifySession: vi.fn(),
	requireAuth: async (c: any, next: any) => {
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	},
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token'),
	revokeSession: vi.fn()
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import { deletePuzzleOwnership } from '@perseus/shared';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440001';

describe('Admin Worker - DELETE /puzzles/:id ownership delete catch (line 691)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs but does not fail when deletePuzzleOwnership rejects', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: VALID_UUID,
			name: 'Ready Puzzle',
			status: 'ready',
			pieceCount: 4
		} as any);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true } as any);
		vi.mocked(storage.deletePuzzleAssets).mockResolvedValue({
			success: true,
			failedKeys: []
		} as any);
		vi.mocked(deletePuzzleOwnership).mockRejectedValueOnce(new Error('D1 unavailable'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request(`http://localhost/puzzles/${VALID_UUID}`, {
			method: 'DELETE',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		// Ownership delete failure is non-fatal: deletion still succeeds (204)
		expect(res.status).toBe(204);
		expect(deletePuzzleOwnership).toHaveBeenCalledTimes(1);
		expect(consoleSpy).toHaveBeenCalledWith(
			`Failed to delete ownership row for puzzle ${VALID_UUID}:`,
			expect.any(Error)
		);
		// R2 asset deletion still ran after the ownership catch
		expect(storage.deletePuzzleAssets).toHaveBeenCalledTimes(1);
		consoleSpy.mockRestore();
	});
});
