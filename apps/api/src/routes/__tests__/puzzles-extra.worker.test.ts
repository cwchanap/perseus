/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for puzzles.worker.ts
 * Covers missing branches: null puzzle, missing thumbnail/piece images, out-of-bounds piece IDs,
 * success paths for GET /:id, and error path for GET /.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import puzzles from '../puzzles.worker';
import * as storage from '../../services/storage.worker';

vi.mock('../../services/storage.worker');

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

const readyPuzzle = {
	id: VALID_UUID,
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
};

const mockEnv = {
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {
		head: vi.fn().mockResolvedValue(null)
	} as unknown as R2Bucket
};

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.mocked(storage.getPuzzle).mockReset();
	vi.mocked(storage.listPuzzles).mockReset();
	vi.mocked(storage.getImage).mockReset();
	mockEnv.PUZZLES_BUCKET.head = vi.fn().mockResolvedValue(null);
});

afterEach(() => {
	consoleSpy.mockRestore();
});

describe('GET / - error path', () => {
	it('should return 500 when listPuzzles throws', async () => {
		vi.mocked(storage.listPuzzles).mockRejectedValueOnce(new Error('KV unavailable'));

		const req = new Request('http://localhost/');
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(500);
		expect(body.error).toBe('internal_error');
	});
});

describe('GET /:id - additional branches', () => {
	it('should return 404 when puzzle is not found (null)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('should return 200 with puzzle data for a ready puzzle', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(readyPuzzle as any);
		(mockEnv.PUZZLES_BUCKET.head as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			size: 1024,
			httpMetadata: { contentType: 'image/jpeg' }
		});

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(200);
		expect(body.id).toBe(VALID_UUID);
		expect(body.name).toBe('Test Puzzle');
		expect(body.hasReference).toBe(true);
	});

	it('should return 200 with hasReference false when no original in R2', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(readyPuzzle as any);
		(mockEnv.PUZZLES_BUCKET.head as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(200);
		expect(body.hasReference).toBe(false);
	});

	it('should return 500 when getPuzzle throws', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValueOnce(new Error('KV error'));

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(500);
		expect(body.error).toBe('internal_error');
	});
});

describe('GET /:id/thumbnail - additional branches', () => {
	it('should return 404 when puzzle is not found (null)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);

		const req = new Request(`http://localhost/${VALID_UUID}/thumbnail`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('should return 404 when thumbnail image is missing for a ready puzzle', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(readyPuzzle as any);
		vi.mocked(storage.getImage).mockResolvedValueOnce(null);

		const req = new Request(`http://localhost/${VALID_UUID}/thumbnail`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('Thumbnail not found');
	});

	it('should return 500 when getPuzzle throws in thumbnail route', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValueOnce(new Error('KV failure'));

		const req = new Request(`http://localhost/${VALID_UUID}/thumbnail`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(500);
		expect(body.error).toBe('internal_error');
	});
});

describe('GET /:id/pieces/:pieceId/image - additional branches', () => {
	it('should return 404 when puzzle is not found (null)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);

		const req = new Request(`http://localhost/${VALID_UUID}/pieces/0/image`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('should return 404 when pieceId >= puzzle.pieceCount', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(readyPuzzle as any);

		// pieceCount is 4, so pieceId=4 is out of bounds
		const req = new Request(`http://localhost/${VALID_UUID}/pieces/4/image`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('Piece not found');
	});

	it('should return 404 when piece image is missing for a ready puzzle', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(readyPuzzle as any);
		vi.mocked(storage.getImage).mockResolvedValueOnce(null);

		const req = new Request(`http://localhost/${VALID_UUID}/pieces/0/image`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('Piece image not found');
	});

	it('should return 500 when getPuzzle throws in piece route', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValueOnce(new Error('Storage failure'));

		const req = new Request(`http://localhost/${VALID_UUID}/pieces/0/image`);
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(500);
		expect(body.error).toBe('internal_error');
	});
});
