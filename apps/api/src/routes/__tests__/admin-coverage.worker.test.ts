/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for admin.worker.ts
 * Covers metadata deletion failure and catch block paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const mockEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket,
	NODE_ENV: 'development'
};

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Admin Routes - Puzzle deletion error paths', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('returns 500 when metadata deletion fails', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: VALID_UUID,
			name: 'Test Puzzle',
			status: 'ready',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: [],
			version: 0
		} as any);

		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/puzzles/${VALID_UUID}`, {
			method: 'DELETE',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to delete puzzle');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to delete puzzle metadata:'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('returns 500 when deletePuzzleAssets or deletePuzzleMetadata throws', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: VALID_UUID,
			name: 'Test Puzzle',
			status: 'ready',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: [],
			version: 0
		} as any);

		vi.mocked(storage.deletePuzzleMetadata).mockRejectedValue(new Error('Unexpected KV error'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/puzzles/${VALID_UUID}`, {
			method: 'DELETE',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Error deleting puzzle ${VALID_UUID}:`),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});
