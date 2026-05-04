import { describe, it, expect, vi } from 'vitest';
import {
	getPuzzle,
	createPuzzleMetadata,
	updatePuzzleMetadata,
	deletePuzzleMetadata,
	listPuzzles,
	listPuzzlesPage,
	puzzleExists,
	getOriginalKey,
	getThumbnailKey,
	getPieceKey,
	uploadOriginalImage,
	deleteOriginalImage,
	getImage,
	deletePuzzleAssets,
	acquireLock,
	releaseLock,
	invalidateGalleryIndex,
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
		list: vi.fn(
			async (options?: {
				prefix?: string;
				cursor?: string;
			}): Promise<{
				keys: { name: string }[];
				list_complete: boolean;
				cursor?: string;
			}> => {
				const prefix = options?.prefix || '';
				const keys = Array.from(store.keys())
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name }));
				return { keys, list_complete: true, cursor: undefined };
			}
		),
		_store: store
	};
}

function createMockDurableObjectNamespace(
	handler: (body: { puzzleId?: string; updates?: Partial<PuzzleMetadata> }) => Response = () =>
		new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		})
) {
	const stub = {
		fetch: vi.fn(async (_url: string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(init.body.toString()) : {};
			return handler(body);
		})
	};

	const namespace = {
		idFromName: vi.fn((name: string) => name),
		get: vi.fn(() => stub)
	};

	return { namespace, stub };
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
		status: 'processing',
		version: 0,
		pieces: [],
		progress: {
			totalPieces: 225,
			generatedPieces: 0,
			updatedAt: Date.now()
		}
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

		it('should throw when puzzle metadata is corrupt', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'ready',
				pieceCount: 2,
				gridCols: 1,
				gridRows: 2,
				pieces: []
			};
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1')).rejects.toThrow(
				'Corrupt puzzle metadata for test-puzzle-1'
			);
		});

		it('should throw when processing puzzle includes error', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'processing',
				error: { message: 'Should not be here' }
			};
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1')).rejects.toThrow(
				'Corrupt puzzle metadata for test-puzzle-1'
			);
		});

		it('should throw when failed puzzle includes progress', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'failed',
				error: { message: 'Failed' },
				progress: {
					totalPieces: 225,
					generatedPieces: 10,
					updatedAt: Date.now()
				}
			};
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1')).rejects.toThrow(
				'Corrupt puzzle metadata for test-puzzle-1'
			);
		});

		it('should throw when ready puzzle includes progress or error', async () => {
			const mockKV = createMockKV();
			const samplePiece = {
				id: 0,
				puzzleId: samplePuzzle.id,
				correctX: 0,
				correctY: 0,
				edges: {
					top: 'flat',
					right: 'flat',
					bottom: 'flat',
					left: 'flat'
				},
				imagePath: 'pieces/0.png'
			};
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'ready',
				pieces: Array.from({ length: samplePuzzle.pieceCount }, (_value, index) => ({
					...samplePiece,
					id: index
				})),
				progress: {
					totalPieces: 225,
					generatedPieces: 225,
					updatedAt: Date.now()
				},
				error: { message: 'Should not be here' }
			};
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1')).rejects.toThrow(
				'Corrupt puzzle metadata for test-puzzle-1'
			);
		});
	});

	describe('createPuzzleMetadata', () => {
		it('should store puzzle metadata in KV', async () => {
			const mockKV = createMockKV();

			await createPuzzleMetadata(mockKV as unknown as KVNamespace, samplePuzzle);

			expect(mockKV.put).toHaveBeenCalledWith('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));
		});

		it('should reject puzzle metadata with invalid grid structure', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				gridCols: 14,
				gridRows: 15,
				pieceCount: 225
			};

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, invalidPuzzle)
			).rejects.toThrow('Invalid puzzle metadata structure');
		});

		it('should throw error for empty string puzzle ID', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = { ...samplePuzzle, id: '' };

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, invalidPuzzle)
			).rejects.toThrow('Puzzle ID is required and must be a non-empty string');
		});

		it('should throw error for whitespace-only puzzle ID', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = { ...samplePuzzle, id: '   ' };

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, invalidPuzzle)
			).rejects.toThrow('Puzzle ID is required and must be a non-empty string');
		});

		it('should throw error for empty string puzzle name', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = { ...samplePuzzle, name: '' };

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, invalidPuzzle)
			).rejects.toThrow('Puzzle name is required and must be a non-empty string');
		});

		it('should throw error for whitespace-only puzzle name', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = { ...samplePuzzle, name: '   ' };

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, invalidPuzzle)
			).rejects.toThrow('Puzzle name is required and must be a non-empty string');
		});

		it('should throw error when puzzle already exists (TOCTOU check)', async () => {
			const mockKV = createMockKV();
			// Pre-populate the KV store to simulate existing puzzle
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, samplePuzzle)
			).rejects.toThrow('Puzzle with ID "test-puzzle-1" already exists');
		});
	});

	describe('updatePuzzleMetadata', () => {
		it('should update existing puzzle metadata', async () => {
			const { namespace, stub } = createMockDurableObjectNamespace();

			await updatePuzzleMetadata(namespace as unknown as DurableObjectNamespace, 'test-puzzle-1', {
				status: 'processing'
			});

			expect(stub.fetch).toHaveBeenCalledTimes(1);
			const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
			expect(body).toEqual({
				puzzleId: 'test-puzzle-1',
				updates: { status: 'processing' }
			});
		});

		it('should throw error when puzzle does not exist', async () => {
			const { namespace } = createMockDurableObjectNamespace(() => {
				return new Response(JSON.stringify({ message: 'Puzzle nonexistent not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			});

			await expect(
				updatePuzzleMetadata(namespace as unknown as DurableObjectNamespace, 'nonexistent', {
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

			expect(result.success).toBe(true);
			expect(mockKV.delete).toHaveBeenCalledWith('puzzle:test-puzzle-1');
		});

		it('should invalidate gallery index cache on delete', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));
			mockKV._store.set('gallery:sorted-index', JSON.stringify([{ id: 'test-puzzle-1' }]));

			await deletePuzzleMetadata(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(mockKV.delete).toHaveBeenCalledWith('gallery:sorted-index');
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

			expect(result.puzzles).toEqual([]);
			expect(result.invalidCount).toBe(0);
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

			expect(result.puzzles).toHaveLength(3);
			expect(result.puzzles[0].id).toBe('puzzle-2'); // Most recent first
			expect(result.puzzles[1].id).toBe('puzzle-3');
			expect(result.puzzles[2].id).toBe('puzzle-1');
		});

		it('should return only summary fields', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(samplePuzzle));

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result.puzzles[0]).toEqual({
				id: samplePuzzle.id,
				name: samplePuzzle.name,
				pieceCount: samplePuzzle.pieceCount,
				status: samplePuzzle.status,
				progress: samplePuzzle.progress
			});
		});

		it('should break ties deterministically by id when createdAt is equal', async () => {
			const mockKV = createMockKV();
			const sharedTimestamp = 5000;
			const puzzle1 = { ...samplePuzzle, id: 'puzzle-beta', createdAt: sharedTimestamp };
			const puzzle2 = { ...samplePuzzle, id: 'puzzle-alpha', createdAt: sharedTimestamp };
			const puzzle3 = { ...samplePuzzle, id: 'puzzle-gamma', createdAt: sharedTimestamp };

			mockKV._store.set('puzzle:puzzle-beta', JSON.stringify(puzzle1));
			mockKV._store.set('puzzle:puzzle-alpha', JSON.stringify(puzzle2));
			mockKV._store.set('puzzle:puzzle-gamma', JSON.stringify(puzzle3));

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result.puzzles).toHaveLength(3);
			expect(result.puzzles[0].id).toBe('puzzle-alpha');
			expect(result.puzzles[1].id).toBe('puzzle-beta');
			expect(result.puzzles[2].id).toBe('puzzle-gamma');
		});
	});
});

describe('Lock Operations', () => {
	describe('acquireLock', () => {
		it('should return error status when KV fails', async () => {
			const mockKV = {
				get: vi.fn(() => {
					throw new Error('KV connection failed');
				})
			} as unknown as KVNamespace;

			const result = await acquireLock(mockKV, 'lock:test-lock', 5000);

			expect(result.status).toBe('error');
			if (result.status === 'error') {
				expect(result.error.message).toBe('KV connection failed');
			}
		});

		it('should return held status when lock is already held', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('lock:test-lock', 'existing-token');

			const result = await acquireLock(mockKV as unknown as KVNamespace, 'lock:test-lock', 5000);

			expect(result.status).toBe('held');
		});

		it('should return acquired status with token on success', async () => {
			const mockKV = createMockKV();

			const result = await acquireLock(mockKV as unknown as KVNamespace, 'lock:test-lock', 5000);

			expect(result.status).toBe('acquired');
			if (result.status === 'acquired') {
				expect(result.token).toBeTruthy();
				expect(typeof result.token).toBe('string');
			}
		});

		it('should set expiration TTL on lock', async () => {
			const mockKV = createMockKV();
			await acquireLock(mockKV as unknown as KVNamespace, 'lock:test-lock', 5000);

			// Verify put was called with expirationTtl
			expect(mockKV.put).toHaveBeenCalledWith(
				'lock:test-lock',
				expect.any(String),
				expect.objectContaining({
					expirationTtl: expect.any(Number)
				})
			);
		});
	});

	describe('releaseLock', () => {
		it('should delete lock when token matches and return true', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('lock:test-lock', 'token-123');

			const result = await releaseLock(
				mockKV as unknown as KVNamespace,
				'lock:test-lock',
				'token-123'
			);

			expect(result).toBe(true);
			expect(mockKV._store.has('lock:test-lock')).toBe(false);
			expect(mockKV.delete).toHaveBeenCalledWith('lock:test-lock');
		});

		it('should not delete lock when token does not match and return false', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('lock:test-lock', 'token-123');
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await releaseLock(
				mockKV as unknown as KVNamespace,
				'lock:test-lock',
				'token-456'
			);

			expect(result).toBe(false);
			// Lock should still exist
			expect(mockKV._store.get('lock:test-lock')).toBe('token-123');
			// Delete should not have been called
			expect(mockKV.delete).not.toHaveBeenCalled();
			// Warning should have been logged
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it('should not delete lock when lock does not exist and return false', async () => {
			const mockKV = createMockKV();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await releaseLock(
				mockKV as unknown as KVNamespace,
				'lock:test-lock',
				'token-123'
			);

			expect(result).toBe(false);
			expect(mockKV.delete).not.toHaveBeenCalled();
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it('should throw when KV get fails', async () => {
			const mockKV = {
				get: vi.fn(() => {
					throw new Error('KV error');
				})
			} as unknown as KVNamespace;

			await expect(releaseLock(mockKV, 'lock:test-lock', 'token-123')).rejects.toThrow('KV error');
		});

		it('should throw when lock release fails', async () => {
			const mockKV = {
				get: vi.fn(() => Promise.resolve('token-123')),
				delete: vi.fn(() => {
					throw new Error('KV delete failed');
				})
			} as unknown as KVNamespace;

			await expect(releaseLock(mockKV, 'lock:test-lock', 'token-123')).rejects.toThrow(
				'KV delete failed'
			);
		});
	});
});

// Mock R2Bucket
function createMockR2Bucket() {
	const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
	return {
		put: vi.fn(
			async (
				key: string,
				data: ArrayBuffer,
				options?: { httpMetadata?: { contentType: string } }
			) => {
				store.set(key, {
					data,
					contentType: options?.httpMetadata?.contentType || 'application/octet-stream'
				});
			}
		),
		get: vi.fn(async (key: string) => {
			const item = store.get(key);
			if (!item) return null;
			return {
				arrayBuffer: async () => item.data,
				httpMetadata: { contentType: item.contentType }
			};
		}),
		delete: vi.fn(async (keys: string | string[]) => {
			const keysArray = Array.isArray(keys) ? keys : [keys];
			for (const key of keysArray) {
				store.delete(key);
			}
		}),
		_store: store
	};
}

describe('R2 Asset Operations', () => {
	describe('uploadOriginalImage', () => {
		it('should upload image with correct key and content type', async () => {
			const mockBucket = createMockR2Bucket();
			const imageData = new ArrayBuffer(100);

			await uploadOriginalImage(
				mockBucket as unknown as R2Bucket,
				'puzzle-123',
				imageData,
				'image/jpeg'
			);

			expect(mockBucket.put).toHaveBeenCalledWith('puzzles/puzzle-123/original', imageData, {
				httpMetadata: { contentType: 'image/jpeg' }
			});
		});
	});

	describe('getImage', () => {
		it('should return image data and content type when exists', async () => {
			const mockBucket = createMockR2Bucket();
			const imageData = new Uint8Array([1, 2, 3, 4]).buffer;
			mockBucket._store.set('puzzles/puzzle-123/thumbnail.jpg', {
				data: imageData,
				contentType: 'image/jpeg'
			});

			const result = await getImage(
				mockBucket as unknown as R2Bucket,
				'puzzles/puzzle-123/thumbnail.jpg'
			);

			expect(result).not.toBeNull();
			expect(result?.contentType).toBe('image/jpeg');
			expect(result?.data).toEqual(imageData);
		});

		it('should return null when image does not exist', async () => {
			const mockBucket = createMockR2Bucket();

			const result = await getImage(mockBucket as unknown as R2Bucket, 'nonexistent');

			expect(result).toBeNull();
		});
	});

	describe('deleteOriginalImage', () => {
		it('should delete original image and return true', async () => {
			const mockBucket = createMockR2Bucket();
			mockBucket._store.set('puzzles/puzzle-123/original', {
				data: new ArrayBuffer(100),
				contentType: 'image/jpeg'
			});

			const result = await deleteOriginalImage(mockBucket as unknown as R2Bucket, 'puzzle-123');

			expect(result.success).toBe(true);
			expect(mockBucket.delete).toHaveBeenCalledWith('puzzles/puzzle-123/original');
			expect(mockBucket._store.has('puzzles/puzzle-123/original')).toBe(false);
		});

		it('should return false and log error on delete failure', async () => {
			const mockBucket = {
				delete: vi.fn(() => {
					throw new Error('R2 delete failed');
				})
			} as unknown as R2Bucket;

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await deleteOriginalImage(mockBucket, 'puzzle-123');

			expect(result.success).toBe(false);
			expect(result.error).toBeInstanceOf(Error);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to delete original image'),
				expect.any(Error)
			);

			consoleErrorSpy.mockRestore();
		});
	});

	describe('deletePuzzleAssets', () => {
		it('should delete original, thumbnail, and all piece images', async () => {
			const mockBucket = createMockR2Bucket();
			const pieceCount = 4;

			await deletePuzzleAssets(mockBucket as unknown as R2Bucket, 'puzzle-123', pieceCount);

			// Should have been called with all keys
			expect(mockBucket.delete).toHaveBeenCalled();
			const deleteCall = mockBucket.delete.mock.calls[0][0] as string[];
			expect(deleteCall).toContain('puzzles/puzzle-123/original');
			expect(deleteCall).toContain('puzzles/puzzle-123/thumbnail.jpg');
			expect(deleteCall).toContain('puzzles/puzzle-123/pieces/0.png');
			expect(deleteCall).toContain('puzzles/puzzle-123/pieces/1.png');
			expect(deleteCall).toContain('puzzles/puzzle-123/pieces/2.png');
			expect(deleteCall).toContain('puzzles/puzzle-123/pieces/3.png');
		});

		it('should batch delete when piece count exceeds 1000', async () => {
			const mockBucket = createMockR2Bucket();
			const pieceCount = 1500; // Will need 2 batches

			await deletePuzzleAssets(mockBucket as unknown as R2Bucket, 'puzzle-123', pieceCount);

			// Should have been called twice (2 batches)
			expect(mockBucket.delete).toHaveBeenCalledTimes(2);

			// First batch should have 1000 items
			const firstBatch = mockBucket.delete.mock.calls[0][0] as string[];
			expect(firstBatch.length).toBe(1000);

			// Second batch should have remaining items (1502 total - 1000 = 502)
			// 1500 pieces + original + thumbnail = 1502 total
			const secondBatch = mockBucket.delete.mock.calls[1][0] as string[];
			expect(secondBatch.length).toBe(502);
		});
	});
});

describe('listPuzzlesPage', () => {
	function makeReadyPuzzle(overrides: Partial<PuzzleMetadata> = {}): PuzzleMetadata {
		const puzzle = {
			id: 'p-default',
			name: 'Test Puzzle',
			pieceCount: 225,
			gridCols: 15,
			gridRows: 15,
			imageWidth: 1000,
			imageHeight: 800,
			createdAt: 1000,
			status: 'ready',
			version: 0,
			pieces: [],
			...overrides
		} as PuzzleMetadata;

		if (puzzle.status === 'ready' && puzzle.pieces.length !== puzzle.pieceCount) {
			puzzle.pieces = Array.from({ length: puzzle.pieceCount }, (_value, index) => ({
				id: index,
				puzzleId: puzzle.id,
				correctX: index % puzzle.gridCols,
				correctY: Math.floor(index / puzzle.gridCols),
				edges: {
					top: 'flat',
					right: 'flat',
					bottom: 'flat',
					left: 'flat'
				},
				imagePath: `pieces/${index}.png`
			}));
		}

		return puzzle;
	}

	it('returns empty result when no puzzles exist', async () => {
		const kv = createMockKV();
		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20
		});
		expect(result).toEqual({ puzzles: [], total: 0, offset: 0, limit: 20 });
		expect(result).not.toHaveProperty('nextCursor');
	});

	it('excludes non-ready puzzles', async () => {
		const kv = createMockKV();
		kv._store.set('puzzle:r1', JSON.stringify(makeReadyPuzzle({ id: 'r1', status: 'ready' })));
		kv._store.set(
			'puzzle:p1',
			JSON.stringify(
				makeReadyPuzzle({
					id: 'p1',
					status: 'processing',
					progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 0 }
				} as unknown as PuzzleMetadata)
			)
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('r1');
	});

	it('returns correct page slice', async () => {
		const kv = createMockKV();
		for (let i = 0; i < 5; i++) {
			kv._store.set(
				`puzzle:p${i}`,
				JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
			);
		}

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 2, limit: 2 });
		expect(result.total).toBe(5);
		expect(result.puzzles).toHaveLength(2);
		expect(result.offset).toBe(2);
		expect(result.limit).toBe(2);
	});

	it('filters by q — case-insensitive substring on name', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Mountain Forest' }))
		);
		kv._store.set('puzzle:b', JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Ocean View' })));

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			q: 'FOREST',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
	});

	it('filters by category', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'A', category: 'Nature' }))
		);
		kv._store.set(
			'puzzle:b',
			JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'B', category: 'Art' }))
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			category: 'Nature',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
	});

	it('combines q and category filters', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Mountain Forest', category: 'Nature' }))
		);
		kv._store.set(
			'puzzle:b',
			JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Mountain Art', category: 'Art' }))
		);
		kv._store.set(
			'puzzle:c',
			JSON.stringify(makeReadyPuzzle({ id: 'c', name: 'Ocean View', category: 'Nature' }))
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			q: 'mountain',
			category: 'Nature',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
	});

	it('returns empty puzzles when offset exceeds total', async () => {
		const kv = createMockKV();
		kv._store.set('puzzle:p1', JSON.stringify(makeReadyPuzzle({ id: 'p1' })));

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 100, limit: 20 });
		expect(result.total).toBe(1);
		expect(result.puzzles).toHaveLength(0);
	});

	it('breaks ties deterministically by id when createdAt is equal', async () => {
		const kv = createMockKV();
		const sharedTimestamp = 5000;
		kv._store.set(
			'puzzle:p-beta',
			JSON.stringify(makeReadyPuzzle({ id: 'p-beta', name: 'Beta', createdAt: sharedTimestamp }))
		);
		kv._store.set(
			'puzzle:p-alpha',
			JSON.stringify(makeReadyPuzzle({ id: 'p-alpha', name: 'Alpha', createdAt: sharedTimestamp }))
		);
		kv._store.set(
			'puzzle:p-gamma',
			JSON.stringify(makeReadyPuzzle({ id: 'p-gamma', name: 'Gamma', createdAt: sharedTimestamp }))
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result.total).toBe(3);
		expect(result.puzzles[0].id).toBe('p-alpha');
		expect(result.puzzles[1].id).toBe('p-beta');
		expect(result.puzzles[2].id).toBe('p-gamma');
	});

	it('fetches all keys across multiple KV list pages', async () => {
		const kv = createMockKV();
		kv._store.set('puzzle:a', JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Alpha' })));
		kv._store.set('puzzle:b', JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Beta' })));

		let callCount = 0;
		kv.list.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return { keys: [{ name: 'puzzle:a' }], list_complete: false, cursor: 'cursor1' };
			}
			return { keys: [{ name: 'puzzle:b' }], list_complete: true, cursor: undefined };
		});

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result.total).toBe(2);
		expect(kv.list).toHaveBeenCalledTimes(2);
		const ids = result.puzzles.map((p) => p.id).sort();
		expect(ids).toEqual(['a', 'b']);
	});

	it('caches the sorted index after first call and reads from cache on subsequent calls', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Alpha', createdAt: 100 }))
		);
		kv._store.set(
			'puzzle:b',
			JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Beta', createdAt: 200 }))
		);

		// First call — should trigger full scan and write the cache
		const result1 = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result1.total).toBe(2);
		expect(kv.list).toHaveBeenCalledTimes(1);
		expect(kv.put).toHaveBeenCalledWith(
			'gallery:sorted-index',
			expect.any(String),
			expect.objectContaining({ expirationTtl: 60 })
		);

		// Second call — should read from cache, no additional kv.list calls
		const result2 = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 1 });
		expect(result2.total).toBe(2);
		expect(result2.puzzles).toHaveLength(1);
		expect(kv.list).toHaveBeenCalledTimes(1); // still 1, not 2
	});

	it('returns results even when cache write fails', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Alpha', createdAt: 100 }))
		);

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		kv.put.mockImplementation(async (key: string, _value?: string) => {
			if (key === 'gallery:sorted-index') {
				throw new Error('KV write quota exceeded');
			}
		});

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });

		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to write gallery index cache:',
			expect.any(Error)
		);

		consoleSpy.mockRestore();
	});

	it('rebuilds cache when cached value is not an array', async () => {
		const kv = createMockKV();
		kv._store.set('gallery:sorted-index', JSON.stringify({ corrupted: true })); // non-array JSON
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Alpha', createdAt: 100 }))
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result.total).toBe(1);
		expect(kv.list).toHaveBeenCalledTimes(1); // fell through to full scan
	});

	it('logs a console error for null KV entries and excludes them from results', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const kv = createMockKV();
		kv._store.set('puzzle:good', JSON.stringify(makeReadyPuzzle({ id: 'good' })));

		// Force kv.get to return null for puzzle:missing even though list returns its key
		const originalGet = kv.get.getMockImplementation() ?? (async () => null);
		kv.get.mockImplementation(async (key: string, type?: string) => {
			if (key === 'puzzle:missing') return null;
			return originalGet(key, type);
		});
		kv._store.set('puzzle:missing', 'placeholder'); // ensures list sees the key

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });

		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('good');
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('null'));

		consoleSpy.mockRestore();
	});

	describe('cursor-based pagination', () => {
		it('returns nextCursor when there are more items', async () => {
			const kv = createMockKV();
			for (let i = 0; i < 5; i++) {
				kv._store.set(
					`puzzle:p${i}`,
					JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
				);
			}

			const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 2
			});
			expect(result.puzzles).toHaveLength(2);
			expect(result.nextCursor).toBeDefined();
			expect(result.total).toBe(5);
		});

		it('does not return nextCursor on last page', async () => {
			const kv = createMockKV();
			kv._store.set('puzzle:p0', JSON.stringify(makeReadyPuzzle({ id: 'p0', createdAt: 0 })));
			kv._store.set('puzzle:p1', JSON.stringify(makeReadyPuzzle({ id: 'p1', createdAt: 1 })));

			const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 20
			});
			expect(result.puzzles).toHaveLength(2);
			expect(result).not.toHaveProperty('nextCursor');
		});

		it('does not return nextCursor when result count equals limit', async () => {
			const kv = createMockKV();
			// Exactly 3 items with limit=3 — no next page should be signaled
			for (let i = 0; i < 3; i++) {
				kv._store.set(
					`puzzle:p${i}`,
					JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
				);
			}

			const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 3
			});
			expect(result.puzzles).toHaveLength(3);
			expect(result).not.toHaveProperty('nextCursor');
		});

		it('fetches next page using cursor', async () => {
			const kv = createMockKV();
			for (let i = 0; i < 5; i++) {
				kv._store.set(
					`puzzle:p${i}`,
					JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
				);
			}

			// Page 1
			const page1 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 2
			});
			expect(page1.puzzles).toHaveLength(2);
			expect(page1.nextCursor).toBeDefined();

			// Page 2 using cursor
			const page2 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 2,
				cursor: page1.nextCursor
			});
			expect(page2.puzzles).toHaveLength(2);
			// Should not duplicate any items from page 1
			const page1Ids = new Set(page1.puzzles.map((p) => p.id));
			for (const p of page2.puzzles) {
				expect(page1Ids.has(p.id)).toBe(false);
			}

			// Page 3 using cursor
			const page3 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 2,
				cursor: page2.nextCursor
			});
			expect(page3.puzzles).toHaveLength(1);
			expect(page3).not.toHaveProperty('nextCursor');
		});

		it('cursor works with category filter', async () => {
			const kv = createMockKV();
			kv._store.set(
				'puzzle:a',
				JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'A', category: 'Nature', createdAt: 100 }))
			);
			kv._store.set(
				'puzzle:b',
				JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'B', category: 'Nature', createdAt: 200 }))
			);
			kv._store.set(
				'puzzle:c',
				JSON.stringify(makeReadyPuzzle({ id: 'c', name: 'C', category: 'Art', createdAt: 300 }))
			);

			const page1 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 1,
				category: 'Nature'
			});
			expect(page1.puzzles).toHaveLength(1);
			expect(page1.puzzles[0].id).toBe('b'); // newest first

			const page2 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 1,
				category: 'Nature',
				cursor: page1.nextCursor
			});
			expect(page2.puzzles).toHaveLength(1);
			expect(page2.puzzles[0].id).toBe('a');
		});

		it('cursor works with search query', async () => {
			const kv = createMockKV();
			kv._store.set(
				'puzzle:a',
				JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Mountain Forest', createdAt: 100 }))
			);
			kv._store.set(
				'puzzle:b',
				JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Mountain Lake', createdAt: 200 }))
			);
			kv._store.set(
				'puzzle:c',
				JSON.stringify(makeReadyPuzzle({ id: 'c', name: 'Ocean View', createdAt: 300 }))
			);

			const page1 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 1,
				q: 'mountain'
			});
			expect(page1.puzzles[0].id).toBe('b');

			const page2 = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 1,
				q: 'mountain',
				cursor: page1.nextCursor
			});
			expect(page2.puzzles[0].id).toBe('a');
		});

		it('treats invalid cursor as offset 0', async () => {
			const kv = createMockKV();
			kv._store.set('puzzle:a', JSON.stringify(makeReadyPuzzle({ id: 'a', createdAt: 100 })));

			const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 20,
				cursor: 'not-valid-base64!!!'
			});
			expect(result.puzzles).toHaveLength(1);
		});

		it('cursor tokens are URL-safe (no + / = characters)', async () => {
			const kv = createMockKV();
			for (let i = 0; i < 5; i++) {
				kv._store.set(
					`puzzle:p${i}`,
					JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
				);
			}

			const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 2
			});
			expect(result.nextCursor).toBeDefined();
			// Cursor should be Base64URL-encoded: no +, /, or = characters
			expect(result.nextCursor).not.toMatch(/[+/=]/);
		});

		it('decodes legacy standard-Base64 cursors for backward compatibility', async () => {
			const kv = createMockKV();
			for (let i = 0; i < 5; i++) {
				kv._store.set(
					`puzzle:p${i}`,
					JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
				);
			}

			// Manually create a standard Base64 cursor (old format)
			const legacyCursor = btoa(JSON.stringify({ createdAt: 3, id: 'p3' }));

			const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
				offset: 0,
				limit: 20,
				cursor: legacyCursor
			});
			// Cursor points after p3 (createdAt=3). In DESC order, remaining are p2, p1, p0.
			expect(result.puzzles).toHaveLength(3);
			expect(result.puzzles.map((p) => p.id)).toEqual(['p2', 'p1', 'p0']);
		});
	});
});

describe('invalidateGalleryIndex', () => {
	it('deletes the gallery index cache key', async () => {
		const kv = createMockKV();
		kv._store.set('gallery:sorted-index', JSON.stringify([{ id: 'a' }]));

		await invalidateGalleryIndex(kv as unknown as KVNamespace);

		expect(kv.delete).toHaveBeenCalledWith('gallery:sorted-index');
		expect(kv._store.has('gallery:sorted-index')).toBe(false);
	});

	it('does not throw when delete fails', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const kv = {
			delete: vi.fn(async () => {
				throw new Error('KV error');
			})
		} as unknown as KVNamespace;

		await expect(invalidateGalleryIndex(kv)).resolves.toBeUndefined();
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});
