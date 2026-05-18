/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for remaining uncovered lines in admin.worker.ts.
 * Covers: invalid aspect ratio, outer catch block in POST /puzzles,
 * and parseImageDimensions error catch.
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

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

describe('Admin Worker - invalid aspect ratio', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('returns 400 when aspectRatio is not a valid ratio', async () => {
		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		formData.append('aspectRatio', '16:9');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid aspect ratio');
	});
});

describe('Admin Worker - outer catch in POST /puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('returns 500 when an unexpected error occurs after image upload succeeds', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockImplementation(() => {
			throw new Error('Unexpected KV failure');
		});
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to create puzzle metadata');
		vi.restoreAllMocks();
	});
});

describe('Admin Worker - parseImageDimensions error catch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('proceeds when parseImageDimensions encounters a truncated PNG header', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
		};

		const pngHeader = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00
		]);

		const formData = new FormData();
		formData.append('name', 'Truncated Test');
		formData.append('pieceCount', '225');
		formData.append('image', new Blob([pngHeader], { type: 'image/png' }), 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(201);
	});
});
