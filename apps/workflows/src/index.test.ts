import { describe, it, expect, vi } from 'vitest';
import { updateMetadata, getMetadata } from './index';
import type { PuzzleMetadata } from './types';

// Mock KV namespace (simplified for testing)
const createMockKV = () => {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (key: string, type: 'json') => {
			const value = store.get(key);
			if (value && type === 'json') {
				return JSON.parse(value);
			}
			return null;
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
		getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
		delete: vi.fn(async () => {})
	} as unknown as KVNamespace; // Type assertion for mock
};

describe('updateMetadata', () => {
	// Helper to create valid PuzzleMetadata
	const createMockMetadata = (
		id: string,
		overrides: Partial<PuzzleMetadata> = {}
	): PuzzleMetadata => ({
		id,
		name: `Test Puzzle ${id}`,
		pieceCount: 100,
		gridCols: 10,
		gridRows: 10,
		imageWidth: 1920,
		imageHeight: 1080,
		createdAt: Date.now(),
		status: 'processing',
		pieces: [],
		version: 1,
		...overrides
	});

	it('should update puzzle metadata and increment version', async () => {
		const mockKV = createMockKV();
		const puzzleId = 'test-puzzle';
		const initialMetadata = createMockMetadata(puzzleId, { version: 1 });

		// Initialize metadata
		await mockKV.put(`puzzle:${puzzleId}`, JSON.stringify(initialMetadata));

		// Update metadata
		await updateMetadata(mockKV, puzzleId, { status: 'ready' });

		// Verify the update was written
		const updated = await getMetadata(mockKV, puzzleId);
		expect(updated).toBeDefined();
		expect(updated?.status).toBe('ready');
		expect(updated?.version).toBe(2);
		expect(updated?.pieceCount).toBe(100); // Other fields preserved
	});

	it('should throw error if puzzle not found', async () => {
		const mockKV = createMockKV();
		const puzzleId = 'nonexistent-puzzle';

		await expect(updateMetadata(mockKV, puzzleId, { status: 'ready' })).rejects.toThrow(
			`Puzzle ${puzzleId} not found in PUZZLE_METADATA`
		);
	});

	it('should handle version 0 and increment to 1', async () => {
		const mockKV = createMockKV();
		const puzzleId = 'test-puzzle-no-version';
		const initialMetadata = createMockMetadata(puzzleId, { version: 0 });

		// Initialize metadata with version 0
		await mockKV.put(`puzzle:${puzzleId}`, JSON.stringify(initialMetadata));

		// Update metadata
		await updateMetadata(mockKV, puzzleId, { status: 'ready' });

		// Verify version was incremented
		const updated = await getMetadata(mockKV, puzzleId);
		expect(updated?.version).toBe(1);
	});

	it('should merge updates with existing metadata', async () => {
		const mockKV = createMockKV();
		const puzzleId = 'test-puzzle-merge';
		const initialMetadata = createMockMetadata(puzzleId, {
			imageWidth: 1920,
			imageHeight: 1080,
			version: 0
		});

		await mockKV.put(`puzzle:${puzzleId}`, JSON.stringify(initialMetadata));

		// Update with only some fields
		await updateMetadata(mockKV, puzzleId, {
			status: 'ready',
			imageWidth: 3840
		});

		const updated = await getMetadata(mockKV, puzzleId);
		expect(updated?.status).toBe('ready');
		expect(updated?.imageWidth).toBe(3840);
		expect(updated?.imageHeight).toBe(1080); // Preserved
		expect(updated?.pieceCount).toBe(100); // Preserved
		expect(updated?.version).toBe(1);
	});

	it('should write JSON stringified data to KV', async () => {
		const mockKV = createMockKV();
		const puzzleId = 'test-puzzle-write';
		const initialMetadata = createMockMetadata(puzzleId, { version: 0 });

		await mockKV.put(`puzzle:${puzzleId}`, JSON.stringify(initialMetadata));
		const putSpy = vi.spyOn(mockKV, 'put');

		await updateMetadata(mockKV, puzzleId, { status: 'ready' });

		// Verify put was called with JSON string
		expect(putSpy).toHaveBeenCalledWith(
			`puzzle:${puzzleId}`,
			expect.stringContaining('"status":"ready"')
		);
		expect(putSpy).toHaveBeenCalledWith(
			`puzzle:${puzzleId}`,
			expect.stringContaining('"version":1')
		);
	});
});
