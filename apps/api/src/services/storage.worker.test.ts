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
	uploadOriginalImage,
	deleteOriginalImage,
	getImage,
	deletePuzzleAssets,
	acquireLock,
	releaseLock,
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
		list: vi.fn(async (options?: { prefix?: string; cursor?: string }) => {
			const prefix = options?.prefix || '';
			const keys = Array.from(store.keys())
				.filter((k) => k.startsWith(prefix))
				.map((name) => ({ name }));
			return { keys, list_complete: true, cursor: undefined };
		}),
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

		it('should return null when puzzle metadata is invalid', async () => {
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
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

			const result = await getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(result).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(
				'Invalid puzzle metadata for test-puzzle-1:',
				invalidPuzzle
			);
			errorSpy.mockRestore();
		});

		it('should return null when failed puzzle includes progress', async () => {
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
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

			const result = await getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(result).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(
				'Invalid puzzle metadata for test-puzzle-1:',
				invalidPuzzle
			);
			errorSpy.mockRestore();
		});

		it('should return null when ready puzzle includes progress or error', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'ready',
				pieces: new Array(samplePuzzle.pieceCount).fill(samplePuzzle.pieces[0] ?? null),
				progress: {
					totalPieces: 225,
					generatedPieces: 225,
					updatedAt: Date.now()
				},
				error: { message: 'Should not be here' }
			};
			mockKV._store.set('puzzle:test-puzzle-1', JSON.stringify(invalidPuzzle));
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

			const result = await getPuzzle(mockKV as unknown as KVNamespace, 'test-puzzle-1');

			expect(result).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(
				'Invalid puzzle metadata for test-puzzle-1:',
				invalidPuzzle
			);
			errorSpy.mockRestore();
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
				progress: samplePuzzle.progress
			});
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
		it('should delete lock when token matches', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('lock:test-lock', 'token-123');

			await releaseLock(mockKV as unknown as KVNamespace, 'lock:test-lock', 'token-123');

			expect(mockKV._store.has('lock:test-lock')).toBe(false);
			expect(mockKV.delete).toHaveBeenCalledWith('lock:test-lock');
		});

		it('should not delete lock when token does not match', async () => {
			const mockKV = createMockKV();
			mockKV._store.set('lock:test-lock', 'token-123');
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await releaseLock(mockKV as unknown as KVNamespace, 'lock:test-lock', 'token-456');

			// Lock should still exist
			expect(mockKV._store.get('lock:test-lock')).toBe('token-123');
			// Delete should not have been called
			expect(mockKV.delete).not.toHaveBeenCalled();
			// Warning should have been logged
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it('should not delete lock when lock does not exist', async () => {
			const mockKV = createMockKV();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await releaseLock(mockKV as unknown as KVNamespace, 'lock:test-lock', 'token-123');

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
