/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the storage and auth modules before importing admin
vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn()
}));

vi.mock('../../middleware/auth.worker', () => ({
	verifySession: vi.fn(),
	requireAuth: async (c: any, next: any) => {
		// Simulate successful authentication
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	},
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token')
}));

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import * as auth from '../../middleware/auth.worker';

describe('Admin Routes - JSON Parsing', () => {
	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret',
		RATE_LIMIT_KV: {} as KVNamespace
	};

	describe('POST /login', () => {
		it('should return 400 for malformed JSON', async () => {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: '{invalid json}'
			});

			const res = await admin.fetch(req, mockEnv);

			// Verify status code first
			expect(res.status).toBe(400);

			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid JSON');
		});

		it('should return 400 for missing Content-Type', async () => {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'cf-connecting-ip': '127.0.0.1'
				},
				body: 'not json'
			});

			const res = await admin.fetch(req, mockEnv);

			// Verify status code
			expect(res.status).toBe(400);

			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
		});
	});
});

describe('Admin Routes - Puzzle Deletion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('DELETE /puzzles/:id', () => {
		it('should return 207 when some assets fail to delete', async () => {
			// Mock getPuzzle to return a valid puzzle
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: '550e8400-e29b-41d4-a716-446655440000',
				name: 'Test Puzzle',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			});

			// Mock deletePuzzleAssets to return partial failure
			(storage.deletePuzzleAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				failedKeys: ['puzzles/test-puzzle/pieces/0.png', 'puzzles/test-puzzle/pieces/1.png']
			});

			// Mock deletePuzzleMetadata to return success
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});

			// Mock auth to allow the request
			(auth.verifySession as ReturnType<typeof vi.fn>).mockResolvedValue({
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket
			};

			const req = new Request('http://localhost/puzzles/550e8400-e29b-41d4-a716-446655440000', {
				method: 'DELETE',
				headers: {
					cookie: 'session=valid.token'
				}
			});

			const res = await admin.fetch(req, mockEnv);

			// Should return 207
			expect(res.status).toBe(207);

			const body = (await res.json()) as any;
			expect(body.success).toBe(false);
			expect(body.partialSuccess).toBe(true);
			expect(body.warning).toBe('Puzzle metadata deleted but some assets failed to delete');
			expect(body.failedAssets).toEqual([
				'puzzles/test-puzzle/pieces/0.png',
				'puzzles/test-puzzle/pieces/1.png'
			]);
		});
	});
});
