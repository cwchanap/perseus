/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for puzzles.worker.ts
 * Covers piece-out-of-bounds, image not found in R2, and catch block paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import puzzles from '../puzzles.worker';
import * as storage from '../../services/storage.worker';

vi.mock('../../services/storage.worker', async () => {
	const actual = await vi.importActual('../../services/storage.worker');
	return {
		...actual,
		getPuzzle: vi.fn(),
		listPuzzles: vi.fn(),
		getImage: vi.fn()
	};
});

const mockEnv = {
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440001';

function makeReadyPuzzle(pieceCount = 4): any {
	return {
		id: VALID_UUID,
		name: 'Ready Puzzle',
		status: 'ready',
		pieceCount,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 100,
		imageHeight: 100,
		createdAt: Date.now(),
		pieces: Array.from({ length: pieceCount }, (_, i) => ({
			id: i,
			puzzleId: VALID_UUID,
			correctX: i % 2,
			correctY: Math.floor(i / 2),
			imagePath: `puzzles/${VALID_UUID}/pieces/${i}.png`,
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' }
		})),
		version: 1
	};
}

describe('Puzzle Piece Image - additional coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 404 when pieceId >= puzzle.pieceCount', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));

		// pieceId 4 is out of bounds for a 4-piece puzzle (valid range is 0-3)
		const req = new Request(`http://localhost/${VALID_UUID}/pieces/4/image`);
		const res = await puzzles.fetch(req, mockEnv);

		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Piece not found');
	});

	it('returns 404 when piece image is not found in R2 (puzzle ready but image missing)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));
		vi.mocked(storage.getImage).mockResolvedValue(null);

		const req = new Request(`http://localhost/${VALID_UUID}/pieces/0/image`);
		const res = await puzzles.fetch(req, mockEnv);

		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Piece image not found');
	});

	it('returns 500 when getImage throws an unexpected error', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));
		vi.mocked(storage.getImage).mockRejectedValue(new Error('R2 service error'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/${VALID_UUID}/pieces/0/image`);
		const res = await puzzles.fetch(req, mockEnv);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to retrieve piece'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('GET /:id - hasReference derived from R2 head', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns hasReference true when original image exists in R2', async () => {
		const mockHead = vi
			.fn()
			.mockResolvedValue({ size: 1234, httpMetadata: { contentType: 'image/jpeg' } });
		const env = {
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: { head: mockHead } as unknown as R2Bucket
		};
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, env);
		const body = (await res.json()) as any;

		expect(res.status).toBe(200);
		expect(body.hasReference).toBe(true);
		expect(mockHead).toHaveBeenCalledWith(`puzzles/${VALID_UUID}/original`);
	});

	it('returns hasReference false when original image is missing from R2', async () => {
		const mockHead = vi.fn().mockResolvedValue(null);
		const env = {
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: { head: mockHead } as unknown as R2Bucket
		};
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, env);
		const body = (await res.json()) as any;

		expect(res.status).toBe(200);
		expect(body.hasReference).toBe(false);
		expect(mockHead).toHaveBeenCalledWith(`puzzles/${VALID_UUID}/original`);
	});

	it('returns hasReference false when R2 head throws (graceful degradation)', async () => {
		const mockHead = vi.fn().mockRejectedValue(new Error('R2 unavailable'));
		const env = {
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: { head: mockHead } as unknown as R2Bucket
		};
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/${VALID_UUID}`);
		const res = await puzzles.fetch(req, env);

		// R2 failure degrades gracefully: puzzle is still returned with hasReference false
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.hasReference).toBe(false);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to check R2 reference'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('Puzzle Thumbnail - additional coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 500 when getThumbnail throws an unexpected error', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makeReadyPuzzle(4));
		vi.mocked(storage.getImage).mockRejectedValue(new Error('R2 bucket error'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request(`http://localhost/${VALID_UUID}/thumbnail`);
		const res = await puzzles.fetch(req, mockEnv);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');

		consoleSpy.mockRestore();
	});
});
