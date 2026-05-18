/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for remaining uncovered lines in admin.worker.ts.
 * Covers: invalid aspect ratio, outer catch block in POST /puzzles,
 * parseImageDimensions error catch, JPEG/WebP dimension parsing,
 * aspectRatiosMatch, non-integer piece count, DELETE metadata failure,
 * logout with no token, and true outer catch in POST.
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
import * as auth from '../../middleware/auth.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

const JPEG_300X300 = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
	0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x01, 0x2c, 0x01, 0x01, 0x11,
	0x00
]);

const JPEG_400X320 = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
	0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x40, 0x01, 0x90, 0x01, 0x01, 0x11,
	0x00
]);

const WEBP_VP8_300X300 = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x01, 0x2c, 0x01
]);

const WEBP_VP8L_300X300 = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
	0x00, 0x00, 0x00, 0x00, 0x2f, 0x2b, 0xc1, 0x4a, 0x00
]);

const WEBP_VP8X_300X300 = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2b, 0x01, 0x00, 0x2b, 0x01, 0x00
]);

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

describe('Admin Worker - parseImageDimensions for JPEG', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('parses JPEG SOF0 dimensions and creates puzzle successfully', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
		};

		const formData = new FormData();
		formData.append('name', 'JPEG Test');
		formData.append('pieceCount', '225');
		const blob = new Blob([JPEG_300X300], { type: 'image/jpeg' });
		formData.append('image', blob, 'test.jpg');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(201);
	});
});

describe('Admin Worker - parseImageDimensions for WebP VP8 (lossy)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('parses WebP VP8 dimensions and creates puzzle successfully', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
		};

		const formData = new FormData();
		formData.append('name', 'WebP VP8 Test');
		formData.append('pieceCount', '225');
		const blob = new Blob([WEBP_VP8_300X300], { type: 'image/webp' });
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(201);
	});
});

describe('Admin Worker - parseImageDimensions for WebP VP8L (lossless)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('parses WebP VP8L dimensions and creates puzzle successfully', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
		};

		const formData = new FormData();
		formData.append('name', 'WebP VP8L Test');
		formData.append('pieceCount', '225');
		const blob = new Blob([WEBP_VP8L_300X300], { type: 'image/webp' });
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(201);
	});
});

describe('Admin Worker - parseImageDimensions for WebP VP8X (extended)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('parses WebP VP8X dimensions and creates puzzle successfully', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
		};

		const formData = new FormData();
		formData.append('name', 'WebP VP8X Test');
		formData.append('pieceCount', '225');
		const blob = new Blob([WEBP_VP8X_300X300], { type: 'image/webp' });
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(201);
	});
});

describe('Admin Worker - aspectRatiosMatch mismatch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('returns 400 when JPEG image dimensions do not match requested aspect ratio', async () => {
		const formData = new FormData();
		formData.append('name', 'Mismatch Test');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		const blob = new Blob([JPEG_400X320], { type: 'image/jpeg' });
		formData.append('image', blob, 'test.jpg');

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
		expect(body.message).toContain('does not match requested ratio');
	});
});

describe('Admin Worker - non-integer piece count', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('returns 400 when pieceCount is not a finite integer', async () => {
		const formData = new FormData();
		formData.append('name', 'Bad Count Test');
		formData.append('pieceCount', 'abc');
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
		expect(body.message).toContain('Invalid piece count');
	});
});

describe('Admin Worker - DELETE metadata deletion failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('returns 500 when deletePuzzleMetadata fails', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
			name: 'Test',
			status: 'completed',
			pieceCount: 100,
			aspectRatio: '1:1',
			gridCols: 10,
			gridRows: 10,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			progress: { totalPieces: 100, generatedPieces: 100, updatedAt: Date.now() },
			pieces: [],
			version: 0
		} as any);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);

		const req = new Request('http://localhost/puzzles/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', {
			method: 'DELETE',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to delete puzzle');
		vi.restoreAllMocks();
	});
});

describe('Admin Worker - logout with no token', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('clears cookie and returns success when no session token is present', async () => {
		vi.mocked(auth.getSessionToken).mockReturnValue(null as any);

		const req = new Request('http://localhost/logout', {
			method: 'POST',
			headers: { cookie: '' }
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(auth.revokeSession).not.toHaveBeenCalled();
		expect(auth.clearSessionCookie).toHaveBeenCalled();
	});
});

describe('Admin Worker - POST true outer catch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('returns 500 when crypto.randomUUID throws', async () => {
		vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			throw new Error('UUID generation failed');
		});

		const formData = new FormData();
		formData.append('name', 'Outer Catch Test');
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to create puzzle');
		vi.restoreAllMocks();
	});
});
