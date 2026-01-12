import { describe, it, expect, vi } from 'vitest';
import {
	getPuzzle,
	createPuzzleMetadata,
	updatePuzzleMetadata,
	deletePuzzleMetadata,
	listPuzzles,
	puzzleExists,
	getOriginalKey,
	getThumbnailKey,
	getPieceKey,
	type PuzzleMetadata
} from './storage.worker';

// Mock KVNamespace
function createMockKV() {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (key: string, type?: string) => {
			const value = store.get(key);
			if (!value) return null;
			return type === 'json' ? JSON.parse(value) : value;
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
		list: vi.fn(async (options?: { prefix?: string }) => {
			const prefix = options?.prefix || '';
			const keys = Array.from(store.keys())
				.filter((k) => k.startsWith(prefix))
				.map((name) => ({ name }));
			return { keys };
		}),
		_store: store
	};
}

describe('Storage Key Helpers', () => {
	describe('getOriginalKey', () => {
		it('should return correct path for original image', () => {
			expect(getOriginalKey('puzzle-123')).toBe('puzzles/puzzle-123/original');
		});
	});

	describe('getThumbnailKey', () => {
		it('should return correct path for thumbnail', () => {
			expect(getThumbnailKey('puzzle-123')).toBe('puzzles/puzzle-123/thumbnail.jpg');
		});
	});

	describe('getPieceKey', () => {
		it('should return correct path for piece', () => {
			expect(getPieceKey('puzzle-123', 0)).toBe('puzzles/puzzle-123/pieces/0.png');
			expect(getPieceKey('puzzle-123', 42)).toBe('puzzles/puzzle-123/pieces/42.png');
		});
	});
});

describe('KV Metadata Operations', () => {
	const samplePuzzle: PuzzleMetadata = {
		id: 'test-puzzle-1',
		name: 'Test Puzzle',
		pieceCount: 225,
		gridCols: 15,
		gridRows: 15,
		imageWidth: 1000,
		imageHeight: 800,
		createdAt: Date.now(),
		status: 'ready',
		pieces: []
	};

	describe('getPuzzle', () => {
		it('should return puzzle metadata when exists', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			const result = await getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(result).toEqual(samplePuzzle);
			expect(mockKV.get).toHaveBeenCalledWith('puzzle:test-puzzle-1', 'json');
		});

		it('should return null when puzzle does not exist', async () => {
			const mockKV = createMockKV();

			const result = await getPuzzle(mockKV as unknown as KVNamespace, 'nonexistent');

			expect(result).toBeNull();
		});
	});

	describe('createPuzzleMetadata', () => {
		it('should store puzzle metadata in KV', async () => {
			const mockKV = createMockKV();

			await createPuzzleMetadata(mockKV as unknown as KVNamespace, samplePuzzle);

			expect(mockKV.put).toHaveBeenCalledWith('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));
		});
	});

	describe('updatePuzzleMetadata', () => {
		it('should update existing puzzle metadata', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			await updatePuzzleMetadata(mockKV as unknown as KVNamespace, 'test-puzzle-1', {
				status: 'processing'
			});

			const stored = JSON.parse(mockKV._store.get('puzzle:test-puzzle-1')!);
			expect(stored.status).toBe('processing');
			expect(stored.name).toBe('Test Puzzle');
		});

		it('should throw error when puzzle does not exist', async () => {
			const mockKV = createMockKV();

			await expect(
				updatePuzzleMetadata(mockKV as unknown as KVNamespace, 'nonexistent', {
					status: 'ready'
				})
			).rejects.toThrow('Puzzle nonexistent not found');
		});
	});

	describe('deletePuzzleMetadata', () => {
		it('should delete puzzle metadata from KV', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			const result = await deletePuzzleMetadata(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(result).toBe(true);
			expect(mockKV.delete).toHaveBeenCalledWith('puzzle:test-puzzle-1');
		});
	});

	describe('puzzleExists', () => {
		it('should return true when puzzle exists', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			const result = await puzzleExists(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(result).toBe(true);
		});

		it('should return false when puzzle does not exist', async () => {
			const mockKV = createMockKV();

			const result = await puzzleExists(mockKV as unknown as KVNamespace, 'nonexistent');

			expect(result).toBe(false);
		});
	});

	describe('listPuzzles', () => {
		it('should return empty array when no puzzles exist', async () => {
			const mockKV = createMockKV();

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result).toEqual([]);
		});

		it('should return puzzle summaries sorted by createdAt descending', async () => {
			const mockKV = createMockKV();
			const puzzle1 = { ...samplePuzzle, id: 'puzzle-1', createdAt: 1000 };
			const puzzle2 = { ...samplePuzzle, id: 'puzzle-2', createdAt: 3000 };
			const puzzle3 = { ...samplePuzzle, id: 'puzzle-3', createdAt: 2000 };

			mockKV._store.set('puzzle:puzzle-1', JSON.stringify(puzzle1));
			mockKV._store.set('puzzle:puzzle-2', JSON.stringify(puzzle2));
			mockKV._store.set('puzzle:puzzle-3', JSON.stringify(puzzle3));

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result).toHaveLength(3);
			expect(result[0].id).toBe('puzzle-2'); // Most recent first
			expect(result[1].id).toBe('puzzle-3');
			expect(result[2].id).toBe('puzzle-1');
		});

		it('should return only summary fields', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result[0]).toEqual({
				id: samplePuzzle.id,
				name: samplePuzzle.name,
				pieceCount: samplePuzzle.pieceCount,
				status: samplePuzzle.status,
				progress: undefined
			});
		});
	});
});
