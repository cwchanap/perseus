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
	getSessionToken: vi.fn(() => 'valid-token'),
	revokeSession: vi.fn()
}));

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import * as auth from '../../middleware/auth.worker';

// Valid PNG magic bytes header for test blobs
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

describe('Admin Routes - JSON Parsing', () => {
	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
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
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
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

describe('Admin Routes - Passkey Validation', () => {
	describe('POST /login', () => {
		it('should return 500 when ADMIN_PASSKEY is missing from environment', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: undefined,
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: 'any-passkey' })
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('Server configuration error');
		});

		it('should return 400 for empty passkey string', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: '' })
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Passkey is required');
		});

		it('should return 401 for whitespace-only passkey', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: '   ' })
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(401);
			const body = (await res.json()) as any;
			expect(body.error).toBe('unauthorized');
			expect(body.message).toBe('Invalid passkey');
		});

		it('should handle unicode characters in constant-time comparison', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-🔐-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: 'test-🔐-passkey' })
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.success).toBe(true);
		});
	});
});

describe('Admin Routes - Workflow Trigger Cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('POST /puzzles', () => {
		it('should reject pieceCount with trailing characters', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225abc');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid piece count');
		});

		it('should cleanup both metadata and image when workflow.create() fails', async () => {
			// Mock successful image upload
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			// Mock successful metadata creation
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			// Mock successful cleanup operations
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});

			// Create mock environment with workflow that throws
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockRejectedValue(new Error('Workflow service unavailable'))
				}
			};

			// Create form data
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			// Verify 500 response
			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toBe('Failed to start puzzle processing');

			// Verify both cleanup operations were called
			expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(1);
			expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
		});
	});
});

describe('Admin Routes - Magic Bytes Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('POST /puzzles', () => {
		it('should reject file with spoofed MIME type but invalid magic bytes', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			// File claims to be PNG but has invalid magic bytes
			const blob = new Blob(['fake image data'], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid file type');
		});

		it('should accept file with valid JPEG magic bytes', async () => {
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockResolvedValue(undefined)
				}
			};

			// Valid JPEG magic bytes
			const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([jpegHeader], { type: 'image/jpeg' });
			formData.append('image', blob, 'test.jpg');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			// Should successfully accept the valid JPEG
			expect(res.status).toBe(201);
		});
	});
});
