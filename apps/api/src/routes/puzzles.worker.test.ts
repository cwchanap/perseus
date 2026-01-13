import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import puzzles from './puzzles.worker';
import type { Env } from '../worker';

// Mock storage functions
vi.mock('../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	getThumbnailKey: vi.fn((id: string) => `puzzles/${id}/thumbnail.jpg`),
	getPieceKey: vi.fn((id: string, pieceId: number) => `puzzles/${id}/pieces/${pieceId}.png`),
	getImage: vi.fn()
}));

import { getPuzzle, listPuzzles, getImage } from '../services/storage.worker';

// Create mock environment
function createMockEnv(): Env {
	return {
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLE_WORKFLOW: {
			create: vi.fn(),
			get: vi.fn()
		},
		JWT_SECRET: 'test-secret',
		ADMIN_PASSKEY: 'test-passkey',
		ASSETS: {} as Fetcher
	} as Env;
}

// Create app with puzzles routes mounted
function createApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api/puzzles', puzzles);
	return app;
}

// Sample puzzle data
const samplePuzzle = {
	id: 'puzzle-123',
	name: 'Test Puzzle',
	pieceCount: 225,
	gridCols: 15,
	gridRows: 15,
	imageWidth: 1000,
	imageHeight: 800,
	createdAt: Date.now(),
	status: 'ready' as const,
	pieces: []
};

describe('Puzzles Routes', () => {
	let app: ReturnType<typeof createApp>;
	let mockEnv: Env;

	beforeEach(() => {
		vi.clearAllMocks();
		app = createApp();
		mockEnv = createMockEnv();
	});

	describe('GET /api/puzzles', () => {
		it('should return empty array when no puzzles exist', async () => {
			vi.mocked(listPuzzles).mockResolvedValue([]);

			const res = await app.fetch(new Request('http://localhost/api/puzzles'), mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { puzzles: unknown[] };
			expect(body.puzzles).toEqual([]);
		});

		it('should return list of puzzles', async () => {
			const puzzleList = [
				{ id: 'puzzle-1', name: 'Puzzle 1', pieceCount: 225, status: 'ready' as const },
				{ id: 'puzzle-2', name: 'Puzzle 2', pieceCount: 225, status: 'processing' as const }
			];
			vi.mocked(listPuzzles).mockResolvedValue(puzzleList);

			const res = await app.fetch(new Request('http://localhost/api/puzzles'), mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { puzzles: typeof puzzleList };
			expect(body.puzzles).toHaveLength(2);
			expect(body.puzzles[0].name).toBe('Puzzle 1');
		});

		it('should return 500 on error', async () => {
			vi.mocked(listPuzzles).mockRejectedValue(new Error('KV error'));

			const res = await app.fetch(new Request('http://localhost/api/puzzles'), mockEnv);

			expect(res.status).toBe(500);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('internal_error');
		});
	});

	describe('GET /api/puzzles/:id', () => {
		it('should return puzzle details when exists', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(samplePuzzle);

			const res = await app.fetch(new Request('http://localhost/api/puzzles/puzzle-123'), mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as typeof samplePuzzle;
			expect(body.id).toBe('puzzle-123');
			expect(body.name).toBe('Test Puzzle');
		});

		it('should return 404 when puzzle does not exist', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(null);

			const res = await app.fetch(new Request('http://localhost/api/puzzles/nonexistent'), mockEnv);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('not_found');
		});

		it('should return 500 on error', async () => {
			vi.mocked(getPuzzle).mockRejectedValue(new Error('KV error'));

			const res = await app.fetch(new Request('http://localhost/api/puzzles/puzzle-123'), mockEnv);

			expect(res.status).toBe(500);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('internal_error');
		});
	});

	describe('GET /api/puzzles/:id/thumbnail', () => {
		it('should return thumbnail image when exists', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(samplePuzzle);
			vi.mocked(getImage).mockResolvedValue({
				data: new Uint8Array([1, 2, 3, 4]).buffer,
				contentType: 'image/jpeg'
			});

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/thumbnail'),
				mockEnv
			);

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('image/jpeg');
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
		});

		it('should return 404 when puzzle does not exist', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(null);

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/nonexistent/thumbnail'),
				mockEnv
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('not_found');
		});

		it('should return 404 when thumbnail not yet generated', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(samplePuzzle);
			vi.mocked(getImage).mockResolvedValue(null);

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/thumbnail'),
				mockEnv
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { message: string };
			expect(body.message).toBe('Thumbnail not found');
		});
	});

	describe('GET /api/puzzles/:id/pieces/:pieceId/image', () => {
		it('should return piece image when exists', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(samplePuzzle);
			vi.mocked(getImage).mockResolvedValue({
				data: new Uint8Array([1, 2, 3, 4]).buffer,
				contentType: 'image/png'
			});

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/pieces/0/image'),
				mockEnv
			);

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('image/png');
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
		});

		it('should return 400 for invalid piece ID (non-numeric)', async () => {
			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/pieces/abc/image'),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('invalid_piece_id');
		});

		it('should return 400 for negative piece ID', async () => {
			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/pieces/-1/image'),
				mockEnv
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('invalid_piece_id');
		});

		it('should return 404 when puzzle does not exist', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(null);

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/nonexistent/pieces/0/image'),
				mockEnv
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('not_found');
		});

		it('should return 404 when piece ID exceeds piece count', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(samplePuzzle);

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/pieces/300/image'),
				mockEnv
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { message: string };
			expect(body.message).toBe('Piece not found');
		});

		it('should return 404 when piece not yet generated', async () => {
			vi.mocked(getPuzzle).mockResolvedValue(samplePuzzle);
			vi.mocked(getImage).mockResolvedValue(null);

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/pieces/0/image'),
				mockEnv
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { message: string };
			expect(body.message).toBe('Piece image not found');
		});

		it('should return 500 on error', async () => {
			vi.mocked(getPuzzle).mockRejectedValue(new Error('KV error'));

			const res = await app.fetch(
				new Request('http://localhost/api/puzzles/puzzle-123/pieces/0/image'),
				mockEnv
			);

			expect(res.status).toBe(500);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('internal_error');
		});
	});
});
