/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for storage.worker.ts.
 * Covers:
 * - createPuzzleMetadata: version is provided but not a number (line 138)
 * - deletePuzzleMetadata: catch with non-Error thrown (lines 189-191)
 * - listPuzzles: multi-page KV result (list_complete=false path, line 208)
 */
import { describe, it, expect, vi } from 'vitest';
import {
	acquireLock,
	createPuzzleMetadata,
	deletePuzzleMetadata,
	deleteOriginalImage,
	listPuzzles,
	updatePuzzleMetadata
} from './storage.worker';
import type { PuzzleMetadata } from '@perseus/types';

function makePuzzle(overrides?: Partial<PuzzleMetadata>): PuzzleMetadata {
	return {
		id: crypto.randomUUID(),
		name: 'Test Puzzle',
		status: 'ready',
		pieceCount: 1,
		gridCols: 1,
		gridRows: 1,
		imageWidth: 800,
		imageHeight: 600,
		createdAt: Date.now(),
		version: 0,
		pieces: [
			{
				id: 0,
				puzzleId: 'test',
				correctX: 0,
				correctY: 0,
				imagePath: 'puzzles/test/pieces/0.png',
				edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' }
			}
		],
		...overrides
	} as PuzzleMetadata;
}

describe('createPuzzleMetadata - version undefined defaults to 0 (line 149, ?? operator)', () => {
	it('sets version to 0 when puzzle.version is undefined', async () => {
		const puzzle = makePuzzle();
		delete (puzzle as any).version; // Remove version to test ?? 0 branch

		const kv = {
			get: vi.fn().mockResolvedValue(null), // No existing puzzle
			put: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn(),
			list: vi.fn()
		} as unknown as KVNamespace;

		await createPuzzleMetadata(kv, puzzle);

		// Verify the stored value has version=0
		expect(kv.put).toHaveBeenCalledOnce();
		const storedJson = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const stored = JSON.parse(storedJson);
		expect(stored.version).toBe(0);
	});
});

describe('createPuzzleMetadata - invalid pieceCount (line 135)', () => {
	it('throws when pieceCount is zero or negative', async () => {
		const puzzle = makePuzzle({ pieceCount: 0 });
		const kv = {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn(),
			delete: vi.fn(),
			list: vi.fn()
		} as unknown as KVNamespace;

		await expect(createPuzzleMetadata(kv, puzzle)).rejects.toThrow(
			'Puzzle pieceCount is required and must be a positive number'
		);
	});
});

describe('createPuzzleMetadata - version is provided but not a number (line 138)', () => {
	it('throws when version is provided but not a number', async () => {
		const puzzle = makePuzzle({ version: 'not-a-number' as any });
		const kv = {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn(),
			delete: vi.fn(),
			list: vi.fn()
		} as unknown as KVNamespace;

		await expect(createPuzzleMetadata(kv, puzzle)).rejects.toThrow(
			'Puzzle version must be a number if provided'
		);
	});
});

describe('deletePuzzleMetadata - catch block (lines 189-191)', () => {
	it('wraps non-Error thrown in catch as an Error', async () => {
		const kv = {
			get: vi.fn(),
			put: vi.fn(),
			delete: vi.fn().mockRejectedValue('string error'),
			list: vi.fn()
		} as unknown as KVNamespace;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await deletePuzzleMetadata(kv, 'test-id');
		consoleSpy.mockRestore();

		expect(result.success).toBe(false);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error!.message).toBe('string error');
	});

	it('preserves Error instance in catch (true branch of instanceof)', async () => {
		const kv = {
			get: vi.fn(),
			put: vi.fn(),
			delete: vi.fn().mockRejectedValue(new Error('kv delete error')),
			list: vi.fn()
		} as unknown as KVNamespace;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await deletePuzzleMetadata(kv, 'test-id');
		consoleSpy.mockRestore();

		expect(result.success).toBe(false);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error!.message).toBe('kv delete error');
	});
});

describe('deleteOriginalImage - catch block (line 292)', () => {
	it('wraps non-Error thrown in catch as an Error', async () => {
		const bucket = {
			delete: vi.fn().mockRejectedValue('bucket string error'),
			get: vi.fn(),
			put: vi.fn()
		} as unknown as R2Bucket;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await deleteOriginalImage(bucket, 'test-id');
		consoleSpy.mockRestore();

		expect(result.success).toBe(false);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error!.message).toBe('bucket string error');
	});

	it('preserves Error instance in catch (true branch of instanceof)', async () => {
		const bucket = {
			delete: vi.fn().mockRejectedValue(new Error('r2 delete error')),
			get: vi.fn(),
			put: vi.fn()
		} as unknown as R2Bucket;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await deleteOriginalImage(bucket, 'test-id');
		consoleSpy.mockRestore();

		expect(result.success).toBe(false);
		expect(result.error!.message).toBe('r2 delete error');
	});
});

describe('updatePuzzleMetadata - non-ok response (line 175)', () => {
	function makeDoNamespace(fetchResponse: Response): DurableObjectNamespace {
		const stub = {
			fetch: vi.fn().mockResolvedValue(fetchResponse)
		} as unknown as DurableObjectStub;
		return {
			idFromName: vi.fn().mockReturnValue('do-id'),
			get: vi.fn().mockReturnValue(stub)
		} as unknown as DurableObjectNamespace;
	}

	it('throws with payload message when response is not ok and body has message', async () => {
		const response = new Response(JSON.stringify({ message: 'DO update failed' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
		const metadataDO = makeDoNamespace(response);

		await expect(
			updatePuzzleMetadata(metadataDO, 'test-puzzle-id', { status: 'ready' })
		).rejects.toThrow('DO update failed');
	});

	it('throws with fallback message when response is not ok and body is unparseable', async () => {
		const response = new Response('not-json', {
			status: 503,
			headers: { 'Content-Type': 'text/plain' }
		});
		const metadataDO = makeDoNamespace(response);

		await expect(
			updatePuzzleMetadata(metadataDO, 'test-puzzle-id', { status: 'ready' })
		).rejects.toThrow('Failed to update puzzle test-puzzle-id (HTTP 503)');
	});
});

describe('acquireLock - catch block (line 72)', () => {
	it('wraps non-Error thrown in catch as an Error', async () => {
		const kv = {
			get: vi.fn().mockRejectedValue('lock error string'),
			put: vi.fn(),
			delete: vi.fn()
		} as unknown as KVNamespace;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await acquireLock(kv, 'lock-key', 60000);
		consoleSpy.mockRestore();

		expect(result.status).toBe('error');
		if (result.status === 'error') {
			expect(result.error).toBeInstanceOf(Error);
			expect(result.error.message).toBe('lock error string');
		}
	});

	it('preserves Error instance in catch (true branch of instanceof)', async () => {
		const kv = {
			get: vi.fn().mockRejectedValue(new Error('kv lock error')),
			put: vi.fn(),
			delete: vi.fn()
		} as unknown as KVNamespace;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await acquireLock(kv, 'lock-key', 60000);
		consoleSpy.mockRestore();

		expect(result.status).toBe('error');
		if (result.status === 'error') {
			expect(result.error.message).toBe('kv lock error');
		}
	});
});

describe('listPuzzles - multi-page KV results (line 208)', () => {
	it('follows cursor when list_complete is false', async () => {
		const page1Puzzle = makePuzzle({ id: 'puzzle-1' });
		const page2Puzzle = makePuzzle({ id: 'puzzle-2' });

		const listMock = vi
			.fn()
			.mockResolvedValueOnce({
				keys: [{ name: 'puzzle:puzzle-1' }],
				list_complete: false,
				cursor: 'cursor-token-abc'
			})
			.mockResolvedValueOnce({
				keys: [{ name: 'puzzle:puzzle-2' }],
				list_complete: true,
				cursor: undefined
			});

		const getMock = vi.fn().mockImplementation(async (key: string) => {
			if (key === 'puzzle:puzzle-1') return page1Puzzle;
			if (key === 'puzzle:puzzle-2') return page2Puzzle;
			return null;
		});

		const kv = {
			get: getMock,
			put: vi.fn(),
			delete: vi.fn(),
			list: listMock
		} as unknown as KVNamespace;

		const { puzzles } = await listPuzzles(kv);

		// Both pages should be fetched
		expect(listMock).toHaveBeenCalledTimes(2);
		// Second call should pass the cursor
		expect(listMock).toHaveBeenNthCalledWith(2, { prefix: 'puzzle:', cursor: 'cursor-token-abc' });
		// Both puzzles should appear in results
		expect(puzzles).toHaveLength(2);
	});
});
