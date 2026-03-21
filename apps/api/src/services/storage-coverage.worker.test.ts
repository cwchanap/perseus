/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for storage.worker.ts
 * Covers null KV entries in listPuzzles and R2 batch deletion failures.
 */
import { describe, it, expect, vi } from 'vitest';
import { listPuzzles, deletePuzzleAssets, getImage } from './storage.worker';
import type { PuzzleMetadata } from './storage.worker';

function makePuzzleMetadata(id: string): PuzzleMetadata {
	return {
		id,
		name: 'Test Puzzle',
		status: 'ready',
		pieceCount: 1,
		gridCols: 1,
		gridRows: 1,
		imageWidth: 800,
		imageHeight: 600,
		createdAt: Date.now(),
		version: 1,
		pieces: [
			{
				id: 0,
				puzzleId: id,
				correctX: 0,
				correctY: 0,
				imagePath: `puzzles/${id}/pieces/0.png`,
				edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' }
			}
		]
	};
}

function createKVWithNullEntries(entries: Array<{ key: string; value: string | null }>) {
	return {
		get: vi.fn(async (key: string, type?: string) => {
			const entry = entries.find((e) => e.key === key);
			if (!entry || entry.value === null) return null;
			return type === 'json' ? JSON.parse(entry.value) : entry.value;
		}),
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({
			keys: entries.map((e) => ({ name: e.key })),
			list_complete: true,
			cursor: undefined
		}))
	} as unknown as KVNamespace;
}

describe('listPuzzles - null KV entries', () => {
	it('handles null entries (data corruption) gracefully', async () => {
		const validPuzzle = makePuzzleMetadata('puzzle-1');
		const kv = createKVWithNullEntries([
			{ key: 'puzzle:puzzle-1', value: JSON.stringify(validPuzzle) },
			{ key: 'puzzle:puzzle-missing', value: null } // simulates KV returning null
		]);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await listPuzzles(kv);

		// The valid puzzle should be returned; the null one should be skipped
		expect(result.puzzles).toHaveLength(1);
		expect(result.puzzles[0].id).toBe('puzzle-1');
		expect(result.invalidCount).toBe(1);
		// Should have logged an error about null entries
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('null'));
		consoleSpy.mockRestore();
	});

	it('handles invalid puzzle metadata entries', async () => {
		const kv = createKVWithNullEntries([
			{ key: 'puzzle:bad-puzzle', value: JSON.stringify({ id: 'bad', name: 123 }) } // invalid
		]);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await listPuzzles(kv);

		expect(result.puzzles).toHaveLength(0);
		expect(result.invalidCount).toBe(1);
		consoleSpy.mockRestore();
	});

	it('reports combined null and invalid counts', async () => {
		const kv = createKVWithNullEntries([
			{ key: 'puzzle:null-one', value: null },
			{ key: 'puzzle:null-two', value: null },
			{ key: 'puzzle:invalid-one', value: JSON.stringify({ broken: true }) }
		]);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await listPuzzles(kv);

		expect(result.puzzles).toHaveLength(0);
		expect(result.invalidCount).toBe(3); // 2 null + 1 invalid
		consoleSpy.mockRestore();
	});
});

describe('deletePuzzleAssets - R2 batch failure', () => {
	it('collects failed keys when R2 delete throws', async () => {
		const mockBucket = {
			delete: vi.fn(() => {
				throw new Error('R2 batch delete failed');
			}),
			put: vi.fn(),
			get: vi.fn()
		} as unknown as R2Bucket;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await deletePuzzleAssets(mockBucket, 'puzzle-abc', 2);

		// Should report failure and include all keys in failedKeys
		expect(result.success).toBe(false);
		expect(result.failedKeys.length).toBeGreaterThan(0);
		// original + thumbnail + 2 piece keys = 4 keys in the single batch
		expect(result.failedKeys).toHaveLength(4);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to delete batch for puzzle puzzle-abc'),
			expect.any(Array),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('returns success=true when all R2 deletes succeed', async () => {
		const mockBucket = {
			delete: vi.fn(async () => {}),
			put: vi.fn(),
			get: vi.fn()
		} as unknown as R2Bucket;

		const result = await deletePuzzleAssets(mockBucket, 'puzzle-ok', 0);

		expect(result.success).toBe(true);
		expect(result.failedKeys).toHaveLength(0);
	});

	it('handles more than 1000 keys in multiple batches', async () => {
		let batchCount = 0;
		const mockBucket = {
			delete: vi.fn(async () => {
				batchCount++;
			}),
			put: vi.fn(),
			get: vi.fn()
		} as unknown as R2Bucket;

		// 1001 pieces + original + thumbnail = 1003 total keys -> 2 batches
		const result = await deletePuzzleAssets(mockBucket, 'large-puzzle', 1001);

		expect(result.success).toBe(true);
		expect(batchCount).toBe(2);
	});
});

describe('getImage - R2 errors', () => {
	it('throws when R2 get fails', async () => {
		const mockBucket = {
			get: vi.fn(() => {
				throw new Error('R2 unavailable');
			})
		} as unknown as R2Bucket;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(getImage(mockBucket, 'some/key')).rejects.toThrow('R2 unavailable');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to get image from R2'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('returns null when R2 object does not exist', async () => {
		const mockBucket = {
			get: vi.fn(async () => null)
		} as unknown as R2Bucket;

		const result = await getImage(mockBucket, 'missing/key');
		expect(result).toBeNull();
	});

	it('returns image data and content type when object exists', async () => {
		const data = new Uint8Array([1, 2, 3]).buffer;
		const mockBucket = {
			get: vi.fn(async () => ({
				arrayBuffer: async () => data,
				httpMetadata: { contentType: 'image/png' }
			}))
		} as unknown as R2Bucket;

		const result = await getImage(mockBucket, 'puzzle/piece.png');

		expect(result).not.toBeNull();
		expect(result!.contentType).toBe('image/png');
		expect(result!.data).toBe(data);
	});

	it('uses application/octet-stream as fallback content type', async () => {
		const data = new ArrayBuffer(0);
		const mockBucket = {
			get: vi.fn(async () => ({
				arrayBuffer: async () => data,
				httpMetadata: {}
			}))
		} as unknown as R2Bucket;

		const result = await getImage(mockBucket, 'no-type/key');

		expect(result!.contentType).toBe('application/octet-stream');
	});
});
