import { Hono } from 'hono';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import admin from './admin.worker';
import type { Env } from '../worker';
import type { AuthVariables } from '../middleware/auth.worker';

// Mock storage functions
vi.mock('../services/storage.worker', () => ({
	createPuzzleMetadata: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	puzzleExists: vi.fn(),
	uploadOriginalImage: vi.fn(),
	getPuzzle: vi.fn()
}));

// Mock auth functions
vi.mock('../middleware/auth.worker', async () => {
	const actual = await vi.importActual('../middleware/auth.worker');
	return {
		...actual,
		requireAuth: vi.fn((c, next) => next()),
		createSession: vi.fn().mockResolvedValue('mock-session-token'),
		setSessionCookie: vi.fn(),
		clearSessionCookie: vi.fn(),
		getSessionToken: vi.fn(),
		verifySession: vi.fn()
	};
});

// Mock rate limit
vi.mock('../middleware/rate-limit.worker', () => ({
	loginRateLimit: vi.fn((c, next) => next()),
	resetLoginAttempts: vi.fn()
}));

import {
	createPuzzleMetadata,
	deletePuzzleMetadata,
	deletePuzzleAssets,
	uploadOriginalImage,
	getPuzzle
} from '../services/storage.worker';
import { verifySession, getSessionToken, clearSessionCookie } from '../middleware/auth.worker';

// Create mock environment
function createMockEnv(): Env {
	return {
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLE_WORKFLOW: {
			create: vi.fn().mockResolvedValue({ id: 'workflow-123' }),
			get: vi.fn()
		},
		JWT_SECRET: 'test-secret',
		ADMIN_PASSKEY: 'correct-passkey',
		ASSETS: {} as Fetcher
	} as Env;
}

// Create app with admin routes mounted
function createApp() {
	const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
	app.route('/api/admin', admin);
	return app;
}

describe('Admin Routes', () => {
	let app: ReturnType<typeof createApp>;
	let mockEnv: Env;

	beforeEach(() => {
		vi.clearAllMocks();
		app = createApp();
		mockEnv = createMockEnv();
	});

	describe('POST /api/admin/login', () => {
		it('should return 400 when passkey is missing', async () => {
			const res = await app.fetch(
				new Request('http://localhost/api/admin/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({})
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('bad_request');
		});

		it('should return 401 for invalid passkey', async () => {
			const res = await app.fetch(
				new Request('http://localhost/api/admin/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ passkey: 'wrong-passkey' })
				}),
				mockEnv
			);

			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('unauthorized');
		});

		it('should return success for valid passkey', async () => {
			const res = await app.fetch(
				new Request('http://localhost/api/admin/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ passkey: 'correct-passkey' })
				}),
				mockEnv
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { success: boolean };
			expect(body.success).toBe(true);
		});
	});

	describe('POST /api/admin/logout', () => {
		it('should return success and clear cookie', async () => {
			const res = await app.fetch(
				new Request('http://localhost/api/admin/logout', {
					method: 'POST'
				}),
				mockEnv
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { success: boolean };
			expect(body.success).toBe(true);
			expect(clearSessionCookie).toHaveBeenCalled();
		});
	});

	describe('GET /api/admin/session', () => {
		it('should return authenticated: false when no token', async () => {
			vi.mocked(getSessionToken).mockReturnValue(undefined);

			const res = await app.fetch(new Request('http://localhost/api/admin/session'), mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { authenticated: boolean };
			expect(body.authenticated).toBe(false);
		});

		it('should return authenticated: true for valid session', async () => {
			vi.mocked(getSessionToken).mockReturnValue('valid-token');
			vi.mocked(verifySession).mockResolvedValue({
				userId: 'admin',
				username: 'admin',
				role: 'admin',
				iat: Date.now(),
				exp: Date.now() + 100000
			});

			const res = await app.fetch(new Request('http://localhost/api/admin/session'), mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { authenticated: boolean };
			expect(body.authenticated).toBe(true);
		});

		it('should clear cookie and return false for invalid session', async () => {
			vi.mocked(getSessionToken).mockReturnValue('invalid-token');
			vi.mocked(verifySession).mockResolvedValue(null);

			const res = await app.fetch(new Request('http://localhost/api/admin/session'), mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { authenticated: boolean };
			expect(body.authenticated).toBe(false);
			expect(clearSessionCookie).toHaveBeenCalled();
		});
	});

	describe('POST /api/admin/puzzles', () => {
		it('should return 400 when name is missing', async () => {
			const formData = new FormData();
			formData.append('pieceCount', '225');

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string; message: string };
			expect(body.error).toBe('bad_request');
			expect(body.message).toBe('Name is required');
		});

		it('should return 400 when name is too long', async () => {
			const formData = new FormData();
			formData.append('name', 'a'.repeat(256));
			formData.append('pieceCount', '225');

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { message: string };
			expect(body.message).toBe('Name must be at most 255 characters');
		});

		it('should return 400 when pieceCount is missing', async () => {
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { message: string };
			expect(body.message).toBe('Piece count is required');
		});

		it('should return 400 for invalid piece count', async () => {
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '100'); // Only 225 allowed

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { message: string };
			expect(body.message).toContain('Only 225 pieces allowed');
		});

		it('should return 400 when image is missing', async () => {
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { message: string };
			expect(body.message).toBe('Image file is required');
		});

		it('should return 400 for invalid file type', async () => {
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			formData.append('image', new File(['test'], 'test.gif', { type: 'image/gif' }));

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { message: string };
			expect(body.message).toContain('Invalid file type');
		});

		it('should create puzzle successfully with valid data', async () => {
			vi.mocked(createPuzzleMetadata).mockResolvedValue(undefined);
			vi.mocked(uploadOriginalImage).mockResolvedValue(undefined);

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			formData.append('image', new File(['test-image-data'], 'test.jpg', { type: 'image/jpeg' }));

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles', {
					method: 'POST',
					body: formData
				}),
				mockEnv
			);

			expect(res.status).toBe(201);
			const body = (await res.json()) as { id: string; name: string; status: string };
			expect(body.name).toBe('Test Puzzle');
			expect(body.status).toBe('processing');
			expect(createPuzzleMetadata).toHaveBeenCalled();
			expect(uploadOriginalImage).toHaveBeenCalled();
		});
	});

	describe('DELETE /api/admin/puzzles/:id', () => {
		it('should return 404 when puzzle does not exist', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(null);

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles/nonexistent', {
					method: 'DELETE'
				}),
				mockEnv
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('not_found');
		});

		it('should delete puzzle and return 204', async () => {
			vi.mocked(getPuzzle).mockResolvedValue({
				id: 'puzzle-123',
				name: 'Test',
				pieceCount: 225,
				gridCols: 15,
				gridRows: 15,
				imageWidth: 1000,
				imageHeight: 800,
				createdAt: Date.now(),
				status: 'ready',
				version: 0,
				pieces: []
			});
			vi.mocked(deletePuzzleAssets).mockResolvedValue({ success: true, failedKeys: [] });
			vi.mocked(deletePuzzleMetadata).mockResolvedValue(true);

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles/puzzle-123', {
					method: 'DELETE'
				}),
				mockEnv
			);

			expect(res.status).toBe(204);
			expect(deletePuzzleAssets).toHaveBeenCalled();
			expect(deletePuzzleMetadata).toHaveBeenCalled();
		});

		it('should return 500 when deletion fails', async () => {
			vi.mocked(getPuzzle).mockResolvedValue({
				id: 'puzzle-123',
				name: 'Test',
				pieceCount: 225,
				gridCols: 15,
				gridRows: 15,
				imageWidth: 1000,
				imageHeight: 800,
				createdAt: Date.now(),
				status: 'ready',
				version: 0,
				pieces: []
			});
			vi.mocked(deletePuzzleAssets).mockResolvedValue({ success: true, failedKeys: [] });
			vi.mocked(deletePuzzleMetadata).mockResolvedValue(false);

			const res = await app.fetch(
				new Request('http://localhost/api/admin/puzzles/puzzle-123', {
					method: 'DELETE'
				}),
				mockEnv
			);

			expect(res.status).toBe(500);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('internal_error');
		});
	});
});
