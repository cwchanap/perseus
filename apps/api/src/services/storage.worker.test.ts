import { describe, it, expect, vi } from 'vitest';
import {
	getPuzzle,
	getFamily,
	createPuzzleMetadata,
	createFamilyMetadata,
	updatePuzzleMetadata,
	deletePuzzleMetadata,
	deleteFamilyMetadata,
	listPuzzles,
	listPuzzlesPage,
	listFamiliesPage,
	listFamilies,
	enrichFamilySummary,
	puzzleExists,
	getOriginalKey,
	getThumbnailKey,
	getPieceKey,
	getFamilyOriginalKey,
	getFamilyThumbnailKey,
	uploadOriginalImage,
	deleteOriginalImage,
	deleteFamilySharedAssets,
	deleteVariantPieceAssets,
	getImage,
	deleteFamilyCleanupAssets,
	invalidateGalleryIndex,
	resolveVariantReferenceKey,
	writeCleanupRecord,
	listCleanupRecords,
	deleteCleanupRecord,
	buildFamilyMetadata,
	type PuzzleMetadata
} from './storage.worker';
import type { PuzzleFamilyMetadata } from '@perseus/types';

const TEST_FAMILY_ID = '223e4567-e89b-42d3-a456-426614174000';
const TEST_VARIANT_ID = '323e4567-e89b-42d3-a456-426614174001';
const FAMILY_VARIANT_IDS = {
	easy: '423e4567-e89b-42d3-a456-426614174010',
	normal: '523e4567-e89b-42d3-a456-426614174011',
	hard: '623e4567-e89b-42d3-a456-426614174012'
};

function makeReadyFamily(overrides: Partial<PuzzleFamilyMetadata> = {}): PuzzleFamilyMetadata {
	const id = overrides.id ?? '223e4567-e89b-42d3-a456-426614174099';
	return {
		id,
		name: overrides.name ?? 'Test Family',
		aspectRatio: overrides.aspectRatio ?? '1:1',
		createdAt: overrides.createdAt ?? 1000,
		status: overrides.status ?? 'ready',
		variants: overrides.variants ?? FAMILY_VARIANT_IDS,
		...overrides
	};
}

function storeFamily(
	kv: ReturnType<typeof createMockKV>,
	overrides: Partial<PuzzleFamilyMetadata> = {}
): PuzzleFamilyMetadata {
	const family = makeReadyFamily(overrides);
	kv._store.set(`family:${family.id}`, JSON.stringify(family));
	return family;
}

function pageFamilyId(n: number): string {
	const suffix = String(n).padStart(12, '0');
	return `523e4567-e89b-42d3-a456-${suffix}`;
}

function makeVariantMeta(id: string, createdAt: number): PuzzleMetadata {
	return {
		id,
		familyId: TEST_FAMILY_ID,
		difficulty: 'hard',
		name: 'Test Puzzle',
		pieceCount: 100,
		gridCols: 10,
		gridRows: 10,
		imageWidth: 1000,
		imageHeight: 800,
		createdAt,
		status: 'processing',
		version: 0,
		pieces: [],
		progress: { totalPieces: 100, generatedPieces: 0, updatedAt: createdAt }
	};
}

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
			expect(getOriginalKey('family-123')).toBe('families/family-123/original');
		});
	});

	describe('getThumbnailKey', () => {
		it('should return correct path for thumbnail', () => {
			expect(getThumbnailKey('family-123')).toBe('families/family-123/thumbnail.jpg');
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
		id: TEST_VARIANT_ID,
		familyId: TEST_FAMILY_ID,
		difficulty: 'hard',
		name: 'Test Puzzle',
		pieceCount: 100,
		gridCols: 10,
		gridRows: 10,
		imageWidth: 1000,
		imageHeight: 800,
		createdAt: Date.now(),
		status: 'processing',
		version: 0,
		pieces: [],
		progress: {
			totalPieces: 100,
			generatedPieces: 0,
			updatedAt: Date.now()
		}
	};

	describe('getPuzzle', () => {
		it('should return puzzle metadata when exists', async () => {
			const mockKV = createMockKV();
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(samplePuzzle));

			const result = await getPuzzle(mockKV as unknown as KVNamespace, TEST_VARIANT_ID);

			expect(result).toEqual(samplePuzzle);
			expect(mockKV.get).toHaveBeenCalledWith(`puzzle:${TEST_VARIANT_ID}`, 'json');
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
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, TEST_VARIANT_ID)).rejects.toThrow(
				`Corrupt puzzle metadata for ${TEST_VARIANT_ID}`
			);
		});

		it('should throw when processing puzzle includes error', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'processing',
				error: { message: 'Should not be here' }
			};
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, TEST_VARIANT_ID)).rejects.toThrow(
				`Corrupt puzzle metadata for ${TEST_VARIANT_ID}`
			);
		});

		it('should throw when failed puzzle includes progress', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				status: 'failed',
				error: { message: 'Failed' },
				progress: {
					totalPieces: 100,
					generatedPieces: 10,
					updatedAt: Date.now()
				}
			};
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, TEST_VARIANT_ID)).rejects.toThrow(
				`Corrupt puzzle metadata for ${TEST_VARIANT_ID}`
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
					totalPieces: 100,
					generatedPieces: 100,
					updatedAt: Date.now()
				},
				error: { message: 'Should not be here' }
			};
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(invalidPuzzle));

			await expect(getPuzzle(mockKV as unknown as KVNamespace, TEST_VARIANT_ID)).rejects.toThrow(
				`Corrupt puzzle metadata for ${TEST_VARIANT_ID}`
			);
		});
	});

	describe('createPuzzleMetadata', () => {
		it('should store puzzle metadata in KV', async () => {
			const mockKV = createMockKV();

			await createPuzzleMetadata(mockKV as unknown as KVNamespace, samplePuzzle);

			expect(mockKV.put).toHaveBeenCalledWith(
				`puzzle:${TEST_VARIANT_ID}`,
				JSON.stringify(samplePuzzle)
			);
		});

		it('should reject puzzle metadata with invalid grid structure', async () => {
			const mockKV = createMockKV();
			const invalidPuzzle = {
				...samplePuzzle,
				gridCols: 14,
				gridRows: 10,
				pieceCount: 100
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
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(samplePuzzle));

			await expect(
				createPuzzleMetadata(mockKV as unknown as KVNamespace, samplePuzzle)
			).rejects.toThrow(`Puzzle with ID "${TEST_VARIANT_ID}" already exists`);
		});
	});

	describe('updatePuzzleMetadata', () => {
		it('should update existing puzzle metadata', async () => {
			const { namespace, stub } = createMockDurableObjectNamespace();

			await updatePuzzleMetadata(
				namespace as unknown as DurableObjectNamespace,
				'TEST_VARIANT_ID',
				{
					status: 'processing'
				}
			);

			expect(stub.fetch).toHaveBeenCalledTimes(1);
			const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
			expect(body).toEqual({
				puzzleId: 'TEST_VARIANT_ID',
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
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(samplePuzzle));

			const result = await deletePuzzleMetadata(mockKV as unknown as KVNamespace, TEST_VARIANT_ID);

			expect(result.success).toBe(true);
			expect(mockKV.delete).toHaveBeenCalledWith(`puzzle:${TEST_VARIANT_ID}`);
		});

		it('should invalidate gallery index cache on delete', async () => {
			const mockKV = createMockKV();
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(samplePuzzle));
			mockKV._store.set('gallery:sorted-index', JSON.stringify([{ id: 'TEST_VARIANT_ID' }]));

			await deletePuzzleMetadata(mockKV as unknown as KVNamespace, TEST_VARIANT_ID);

			expect(mockKV.delete).toHaveBeenCalledWith('gallery:sorted-index');
		});
	});

	describe('puzzleExists', () => {
		it('should return true when puzzle exists', async () => {
			const mockKV = createMockKV();
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(samplePuzzle));

			const result = await puzzleExists(mockKV as unknown as KVNamespace, TEST_VARIANT_ID);

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
			const puzzle1 = makeVariantMeta('723e4567-e89b-42d3-a456-426614174001', 1000);
			const puzzle2 = makeVariantMeta('823e4567-e89b-42d3-a456-426614174002', 3000);
			const puzzle3 = makeVariantMeta('933e4567-e89b-42d3-a456-426614174003', 2000);

			mockKV._store.set(`puzzle:${puzzle1.id}`, JSON.stringify(puzzle1));
			mockKV._store.set(`puzzle:${puzzle2.id}`, JSON.stringify(puzzle2));
			mockKV._store.set(`puzzle:${puzzle3.id}`, JSON.stringify(puzzle3));

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result.puzzles).toHaveLength(3);
			expect(result.puzzles[0].id).toBe(puzzle2.id); // Most recent first
			expect(result.puzzles[1].id).toBe(puzzle3.id);
			expect(result.puzzles[2].id).toBe(puzzle1.id);
		});

		it('should return only summary fields', async () => {
			const mockKV = createMockKV();
			mockKV._store.set(`puzzle:${TEST_VARIANT_ID}`, JSON.stringify(samplePuzzle));

			const result = await listPuzzles(mockKV as unknown as KVNamespace);

			expect(result.puzzles[0]).toEqual({
				id: samplePuzzle.id,
				name: samplePuzzle.name,
				pieceCount: samplePuzzle.pieceCount,
				status: samplePuzzle.status,
				progress: samplePuzzle.progress,
				createdAt: samplePuzzle.createdAt
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

describe('Family metadata operations', () => {
	it('throws when family metadata is corrupt', async () => {
		const kv = createMockKV();
		kv._store.set(
			`family:${TEST_FAMILY_ID}`,
			JSON.stringify({ id: TEST_FAMILY_ID, name: 'Corrupt' })
		);

		await expect(getFamily(kv as unknown as KVNamespace, TEST_FAMILY_ID)).rejects.toThrow(
			`Corrupt family metadata for ${TEST_FAMILY_ID}`
		);
	});

	it('throws for an empty family ID', async () => {
		const kv = createMockKV();
		const family = makeReadyFamily({ id: '' });

		await expect(createFamilyMetadata(kv as unknown as KVNamespace, family)).rejects.toThrow(
			'Family ID is required and must be a non-empty string'
		);
	});

	it('throws for a whitespace-only family ID', async () => {
		const kv = createMockKV();
		const family = makeReadyFamily({ id: '   ' });

		await expect(createFamilyMetadata(kv as unknown as KVNamespace, family)).rejects.toThrow(
			'Family ID is required and must be a non-empty string'
		);
	});

	it('throws for an empty family name', async () => {
		const kv = createMockKV();
		const family = makeReadyFamily({ id: pageFamilyId(70), name: '' });

		await expect(createFamilyMetadata(kv as unknown as KVNamespace, family)).rejects.toThrow(
			'Family name is required and must be a non-empty string'
		);
	});

	it('throws when a family ID already exists', async () => {
		const kv = createMockKV();
		const family = storeFamily(kv, { id: pageFamilyId(71) });

		await expect(createFamilyMetadata(kv as unknown as KVNamespace, family)).rejects.toThrow(
			`Family with ID "${family.id}" already exists`
		);
	});

	it('throws for invalid family metadata structure', async () => {
		const kv = createMockKV();
		const family = makeReadyFamily({
			id: pageFamilyId(72),
			variants: { ...FAMILY_VARIANT_IDS, hard: 'not-a-uuid' }
		});

		await expect(createFamilyMetadata(kv as unknown as KVNamespace, family)).rejects.toThrow(
			'Invalid family metadata structure'
		);
	});

	it('stores a valid family and exposes it to getFamily', async () => {
		const kv = createMockKV();
		const family = makeReadyFamily({ id: pageFamilyId(73) });

		await createFamilyMetadata(kv as unknown as KVNamespace, family);

		expect(kv._store.get(`family:${family.id}`)).toBe(JSON.stringify(family));
		await expect(getFamily(kv as unknown as KVNamespace, family.id)).resolves.toEqual(family);
	});

	it('deletes family metadata and invalidates the gallery index', async () => {
		const kv = createMockKV();
		storeFamily(kv, { id: TEST_FAMILY_ID });
		kv._store.set('gallery:sorted-index', JSON.stringify([{ id: TEST_FAMILY_ID }]));

		const result = await deleteFamilyMetadata(kv as unknown as KVNamespace, TEST_FAMILY_ID);

		expect(result).toEqual({ success: true });
		expect(kv.delete).toHaveBeenNthCalledWith(1, `family:${TEST_FAMILY_ID}`);
		expect(kv.delete).toHaveBeenNthCalledWith(2, 'gallery:sorted-index');
		expect(kv._store.has(`family:${TEST_FAMILY_ID}`)).toBe(false);
		expect(kv._store.has('gallery:sorted-index')).toBe(false);
	});

	it('returns a failure when deleting family metadata fails', async () => {
		const kv = createMockKV();
		const deleteError = new Error('KV delete failed');
		kv.delete.mockRejectedValueOnce(deleteError);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await deleteFamilyMetadata(kv as unknown as KVNamespace, TEST_FAMILY_ID);

		expect(result.success).toBe(false);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error).toBe(deleteError);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to delete family metadata for ${TEST_FAMILY_ID}`),
			deleteError
		);
		consoleSpy.mockRestore();
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
				TEST_FAMILY_ID,
				imageData,
				'image/jpeg'
			);

			expect(mockBucket.put).toHaveBeenCalledWith(
				`families/${TEST_FAMILY_ID}/original`,
				imageData,
				{
					httpMetadata: { contentType: 'image/jpeg' }
				}
			);
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
			mockBucket._store.set(`families/${TEST_FAMILY_ID}/original`, {
				data: new ArrayBuffer(100),
				contentType: 'image/jpeg'
			});

			const result = await deleteOriginalImage(mockBucket as unknown as R2Bucket, TEST_FAMILY_ID);

			expect(result.success).toBe(true);
			expect(mockBucket.delete).toHaveBeenCalledWith(`families/${TEST_FAMILY_ID}/original`);
			expect(mockBucket._store.has(`families/${TEST_FAMILY_ID}/original`)).toBe(false);
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

	describe('deleteFamilySharedAssets', () => {
		it('deletes the family original and thumbnail assets', async () => {
			const mockBucket = createMockR2Bucket();
			const familyId = 'family-shared';
			const keys = [getFamilyOriginalKey(familyId), getFamilyThumbnailKey(familyId)];

			const result = await deleteFamilySharedAssets(mockBucket as unknown as R2Bucket, familyId);

			expect(result).toEqual({ success: true, failedKeys: [] });
			expect(mockBucket.delete).toHaveBeenCalledWith(keys);
		});
	});

	describe('deleteVariantPieceAssets', () => {
		it('deletes every piece key from zero through the piece count', async () => {
			const mockBucket = createMockR2Bucket();
			const variantId = 'variant-pieces';
			const keys = [
				getPieceKey(variantId, 0),
				getPieceKey(variantId, 1),
				getPieceKey(variantId, 2)
			];

			const result = await deleteVariantPieceAssets(
				mockBucket as unknown as R2Bucket,
				variantId,
				3
			);

			expect(result).toEqual({ success: true, failedKeys: [] });
			expect(mockBucket.delete).toHaveBeenCalledWith(keys);
		});

		it('returns failed piece keys when R2 deletion fails', async () => {
			const mockBucket = createMockR2Bucket();
			const variantId = 'variant-failure';
			const keys = [getPieceKey(variantId, 0), getPieceKey(variantId, 1)];
			mockBucket.delete.mockRejectedValueOnce(new Error('R2 delete failed'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await deleteVariantPieceAssets(
				mockBucket as unknown as R2Bucket,
				variantId,
				2
			);

			expect(result).toEqual({ success: false, failedKeys: keys });
			expect(mockBucket.delete).toHaveBeenCalledWith(keys);
			consoleSpy.mockRestore();
		});
	});

	describe('deleteFamilyCleanupAssets', () => {
		it('deletes family original/thumbnail under familyId and pieces under each variant id', async () => {
			const mockBucket = createMockR2Bucket();
			const familyId = 'family-abc';
			const variantIds = {
				easy: 'variant-easy',
				normal: 'variant-normal',
				hard: 'variant-hard'
			};
			const pieceCounts = { easy: 2, normal: 1, hard: 1 };

			await deleteFamilyCleanupAssets(
				mockBucket as unknown as R2Bucket,
				familyId,
				variantIds,
				pieceCounts
			);

			expect(mockBucket.delete).toHaveBeenCalled();
			const deleteCall = mockBucket.delete.mock.calls[0][0] as string[];
			expect(deleteCall).toContain(getFamilyOriginalKey(familyId));
			expect(deleteCall).toContain(getFamilyThumbnailKey(familyId));
			expect(deleteCall).not.toContain(getFamilyOriginalKey(variantIds.easy));
			expect(deleteCall).not.toContain(getFamilyThumbnailKey(variantIds.easy));
			expect(deleteCall).toContain(getPieceKey(variantIds.easy, 0));
			expect(deleteCall).toContain(getPieceKey(variantIds.easy, 1));
			expect(deleteCall).toContain(getPieceKey(variantIds.normal, 0));
			expect(deleteCall).toContain(getPieceKey(variantIds.hard, 0));
		});

		it('should batch delete when total key count exceeds 1000', async () => {
			const mockBucket = createMockR2Bucket();
			const variantIds = {
				easy: 'variant-easy',
				normal: 'variant-normal',
				hard: 'variant-hard'
			};
			const pieceCounts = { easy: 500, normal: 500, hard: 2 };

			await deleteFamilyCleanupAssets(
				mockBucket as unknown as R2Bucket,
				'family-abc',
				variantIds,
				pieceCounts
			);

			expect(mockBucket.delete).toHaveBeenCalledTimes(2);
			const firstBatch = mockBucket.delete.mock.calls[0][0] as string[];
			expect(firstBatch.length).toBe(1000);
			const secondBatch = mockBucket.delete.mock.calls[1][0] as string[];
			expect(secondBatch.length).toBe(4);
		});
	});
});

describe('listFamilies', () => {
	it('scans the family: KV prefix (not puzzle:)', async () => {
		const kv = createMockKV();
		const familyA = pageFamilyId(1);
		const familyB = pageFamilyId(2);
		storeFamily(kv, { id: familyA, name: 'Alpha', createdAt: 2000 });
		storeFamily(kv, { id: familyB, name: 'Beta', createdAt: 1000 });
		kv._store.set('puzzle:orphan-variant', JSON.stringify(makeVariantMeta('orphan-variant', 3000)));

		const result = await listFamilies(kv as unknown as KVNamespace);

		expect(kv.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'family:' }));
		expect(result.families).toHaveLength(2);
		expect(result.families.map((f) => f.id)).toEqual([familyA, familyB]);
		expect(result.invalidCount).toBe(0);
	});

	it('handles paginated results, null entries, invalid metadata, and tied timestamps', async () => {
		const kv = createMockKV();
		const familyA = pageFamilyId(60);
		const familyB = pageFamilyId(61);
		const nullKey = 'family:missing';
		const invalidKey = 'family:invalid';
		storeFamily(kv, { id: familyA, name: 'Alpha', createdAt: 5000 });
		storeFamily(kv, { id: familyB, name: 'Beta', createdAt: 5000 });
		kv._store.set(invalidKey, JSON.stringify({ id: 'invalid', name: 'Invalid' }));
		kv.list.mockImplementation(async (options) => {
			if (options?.cursor === 'page-2') {
				return {
					keys: [{ name: invalidKey }, { name: `family:${familyB}` }],
					list_complete: true
				};
			}
			return {
				keys: [{ name: `family:${familyA}` }, { name: nullKey }],
				list_complete: false,
				cursor: 'page-2'
			};
		});
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await listFamilies(kv as unknown as KVNamespace);

		expect(kv.list).toHaveBeenCalledTimes(2);
		expect(result.families.map((family) => family.id)).toEqual([familyA, familyB]);
		expect(result.invalidCount).toBe(2);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('keys returned null'));
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Invalid family metadata'),
			expect.objectContaining({ id: 'invalid' })
		);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 invalid entries out of 4'));
		consoleSpy.mockRestore();
	});
});

describe('listPuzzlesPage', () => {
	it('returns empty result when no families exist', async () => {
		const kv = createMockKV();
		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20
		});
		expect(result).toEqual({ puzzles: [], total: 0, offset: 0, limit: 20 });
		expect(result).not.toHaveProperty('nextCursor');
	});

	it('excludes non-ready families', async () => {
		const kv = createMockKV();
		const readyId = pageFamilyId(1);
		storeFamily(kv, { id: readyId, status: 'ready' });
		storeFamily(kv, { id: pageFamilyId(2), status: 'processing' });

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe(readyId);
	});

	it('returns correct page slice', async () => {
		const kv = createMockKV();
		for (let i = 0; i < 5; i++) {
			storeFamily(kv, { id: pageFamilyId(i), name: 'Puzzle ' + i, createdAt: i });
		}

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 2, limit: 2 });
		expect(result.total).toBe(5);
		expect(result.puzzles).toHaveLength(2);
		expect(result.offset).toBe(2);
		expect(result.limit).toBe(2);
	});

	it('filters by q — case-insensitive substring on name', async () => {
		const kv = createMockKV();
		const forestId = pageFamilyId(10);
		storeFamily(kv, { id: forestId, name: 'Mountain Forest' });
		storeFamily(kv, { id: pageFamilyId(11), name: 'Ocean View' });

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			q: 'FOREST',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe(forestId);
	});

	it('filters by category', async () => {
		const kv = createMockKV();
		const natureId = pageFamilyId(20);
		storeFamily(kv, { id: natureId, name: 'A', category: 'Nature' });
		storeFamily(kv, { id: pageFamilyId(21), name: 'B', category: 'Art' });

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			category: 'Nature',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe(natureId);
	});

	it('caches the sorted index after first call and reads from cache on subsequent calls', async () => {
		const kv = createMockKV();
		storeFamily(kv, { id: pageFamilyId(30), name: 'Alpha', createdAt: 100 });
		storeFamily(kv, { id: pageFamilyId(31), name: 'Beta', createdAt: 200 });

		const result1 = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result1.total).toBe(2);
		expect(kv.list).toHaveBeenCalledTimes(1);
		expect(kv.put).toHaveBeenCalledWith(
			'gallery:sorted-index',
			expect.any(String),
			expect.objectContaining({ expirationTtl: 60 })
		);

		const result2 = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 1 });
		expect(result2.total).toBe(2);
		expect(result2.puzzles).toHaveLength(1);
		expect(kv.list).toHaveBeenCalledTimes(1);
	});

	it('returns nextCursor when there are more items', async () => {
		const kv = createMockKV();
		for (let i = 0; i < 3; i++) {
			storeFamily(kv, { id: pageFamilyId(40 + i), createdAt: i });
		}

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 2
		});
		expect(result.puzzles).toHaveLength(2);
		expect(result.nextCursor).toBeDefined();
	});

	it('returns families when rebuilding a paginated index and its cache write fails', async () => {
		const kv = createMockKV();
		const familyA = pageFamilyId(80);
		const familyB = pageFamilyId(81);
		const nullKey = 'family:missing-gallery';
		const invalidKey = 'family:invalid-gallery';
		storeFamily(kv, { id: familyA, name: 'Alpha', createdAt: 2000 });
		storeFamily(kv, { id: familyB, name: 'Beta', createdAt: 1000 });
		kv._store.set(invalidKey, JSON.stringify({ id: 'invalid-gallery', name: 'Invalid' }));
		kv.list.mockImplementation(async (options) => {
			if (options?.cursor === 'gallery-page-2') {
				return {
					keys: [{ name: invalidKey }, { name: `family:${familyB}` }],
					list_complete: true
				};
			}
			return {
				keys: [{ name: `family:${familyA}` }, { name: nullKey }],
				list_complete: false,
				cursor: 'gallery-page-2'
			};
		});
		await invalidateGalleryIndex(kv as unknown as KVNamespace);
		kv.put.mockImplementation(async (key, value) => {
			if (key === 'gallery:sorted-index') throw new Error('KV cache write failed');
			kv._store.set(key, value);
		});
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await listFamiliesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20
		});

		expect(kv.list).toHaveBeenCalledTimes(2);
		expect(result.total).toBe(2);
		expect(result.families.map((family) => family.id)).toEqual([familyA, familyB]);
		expect(kv.put).toHaveBeenCalledWith(
			'gallery:sorted-index',
			expect.any(String),
			expect.objectContaining({ expirationTtl: 60 })
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('buildGalleryIndex: 1 keys returned null')
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('buildGalleryIndex: 1 invalid metadata entries')
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to write gallery index cache:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('Family summaries and variant references', () => {
	it('mixes stored and synthesized variants for a processing family', async () => {
		const kv = createMockKV();
		const family = makeReadyFamily({ id: TEST_FAMILY_ID, status: 'processing' });
		const realVariant = {
			...makeVariantMeta(family.variants.hard, 2000),
			familyId: family.id,
			status: 'processing' as const
		};
		kv._store.set(`puzzle:${realVariant.id}`, JSON.stringify(realVariant));

		const summary = await enrichFamilySummary(kv as unknown as KVNamespace, family);

		expect(summary.variants.hard).toEqual({
			id: family.variants.hard,
			difficulty: 'hard',
			pieceCount: 100,
			status: 'processing'
		});
		expect(summary.variants.normal).toEqual({
			id: family.variants.normal,
			difficulty: 'normal',
			pieceCount: 49,
			status: 'processing'
		});
		expect(summary.variants.easy).toEqual({
			id: family.variants.easy,
			difficulty: 'easy',
			pieceCount: 16,
			status: 'processing'
		});
	});

	it('resolves a stored variant to its family original and unknown variants to null', async () => {
		const kv = createMockKV();
		const variant = makeVariantMeta(TEST_VARIANT_ID, 1000);
		kv._store.set(`puzzle:${variant.id}`, JSON.stringify(variant));

		expect(await resolveVariantReferenceKey(kv as unknown as KVNamespace, TEST_VARIANT_ID)).toBe(
			`families/${TEST_FAMILY_ID}/original`
		);
		expect(
			await resolveVariantReferenceKey(kv as unknown as KVNamespace, 'unknown-variant')
		).toBeNull();
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

function makeCleanupRecord(
	familyId = 'f1e4567-e89b-42d3-a456-426614174000',
	overrides: Partial<{
		variantIds: Record<'easy' | 'normal' | 'hard', string>;
		pieceCounts: Record<'easy' | 'normal' | 'hard', number>;
		idempotencyKey: string;
		createdAt: number;
	}> = {}
) {
	return {
		familyId,
		variantIds: overrides.variantIds ?? FAMILY_VARIANT_IDS,
		pieceCounts: overrides.pieceCounts ?? { easy: 16, normal: 49, hard: 100 },
		createdAt: overrides.createdAt ?? 1700000000000,
		...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {})
	};
}

describe('cleanup records', () => {
	it('writeCleanupRecord writes JSON to the cleanup: prefix key', async () => {
		const kv = createMockKV();
		const record = makeCleanupRecord();
		await writeCleanupRecord(kv as unknown as KVNamespace, record);
		expect(kv.put).toHaveBeenCalledWith(`cleanup:${record.familyId}`, JSON.stringify(record));
	});

	it('writeCleanupRecord writes with idempotencyKey when provided', async () => {
		const kv = createMockKV();
		const record = makeCleanupRecord('f2e4567-e89b-42d3-a456-426614174001', {
			idempotencyKey: 'key-1'
		});
		await writeCleanupRecord(kv as unknown as KVNamespace, record);
		expect(kv.put).toHaveBeenCalledWith(`cleanup:${record.familyId}`, JSON.stringify(record));
	});

	it('listCleanupRecords returns all cleanup records', async () => {
		const kv = createMockKV();
		const record1 = makeCleanupRecord('f1e4567-e89b-42d3-a456-426614174010');
		const record2 = makeCleanupRecord('f2e4567-e89b-42d3-a456-426614174011', {
			idempotencyKey: 'key-1',
			createdAt: 1700000000001
		});
		kv._store.set(`cleanup:${record1.familyId}`, JSON.stringify(record1));
		kv._store.set(`cleanup:${record2.familyId}`, JSON.stringify(record2));

		const records = await listCleanupRecords(kv as unknown as KVNamespace);
		expect(records).toHaveLength(2);
		expect(records).toContainEqual(record1);
		expect(records).toContainEqual(record2);
	});

	it('listCleanupRecords skips entries without familyId', async () => {
		const kv = createMockKV();
		const good = makeCleanupRecord();
		kv._store.set(`cleanup:${good.familyId}`, JSON.stringify(good));
		kv._store.set('cleanup:bad', JSON.stringify({ foo: 'bar' }));

		const records = await listCleanupRecords(kv as unknown as KVNamespace);
		expect(records).toHaveLength(1);
		expect(records[0].familyId).toBe(good.familyId);
	});

	it('listCleanupRecords rejects missing variant IDs or invalid familyId', async () => {
		const kv = createMockKV();
		const good = makeCleanupRecord('a1e4567-e89b-42d3-a456-426614174020');
		kv._store.set(`cleanup:${good.familyId}`, JSON.stringify(good));
		kv._store.set(
			'cleanup:num',
			JSON.stringify({
				familyId: 123,
				variantIds: FAMILY_VARIANT_IDS,
				pieceCounts: { easy: 16, normal: 49, hard: 100 },
				createdAt: 0
			})
		);
		kv._store.set(
			'cleanup:partial',
			JSON.stringify({
				familyId: 'b1e4567-e89b-42d3-a456-426614174021',
				variantIds: { easy: FAMILY_VARIANT_IDS.easy },
				pieceCounts: { easy: 16, normal: 49, hard: 100 },
				createdAt: 0
			})
		);
		kv._store.set(
			'cleanup:empty',
			JSON.stringify({
				familyId: '',
				variantIds: FAMILY_VARIANT_IDS,
				pieceCounts: { easy: 16, normal: 49, hard: 100 },
				createdAt: 0
			})
		);

		const records = await listCleanupRecords(kv as unknown as KVNamespace);
		expect(records).toHaveLength(1);
		expect(records[0].familyId).toBe(good.familyId);
	});

	it('listCleanupRecords rejects non-finite pieceCounts per difficulty', async () => {
		const kv = createMockKV();
		const good = makeCleanupRecord('c1e4567-e89b-42d3-a456-426614174030');
		kv._store.set(`cleanup:${good.familyId}`, JSON.stringify(good));
		kv._store.set(
			'cleanup:nan',
			JSON.stringify({
				familyId: 'd1e4567-e89b-42d3-a456-426614174031',
				variantIds: FAMILY_VARIANT_IDS,
				pieceCounts: { easy: NaN, normal: 49, hard: 100 },
				createdAt: 0
			})
		);
		kv._store.set(
			'cleanup:str',
			JSON.stringify({
				familyId: 'e1e4567-e89b-42d3-a456-426614174032',
				variantIds: FAMILY_VARIANT_IDS,
				pieceCounts: { easy: '16', normal: 49, hard: 100 },
				createdAt: 0
			})
		);

		const records = await listCleanupRecords(kv as unknown as KVNamespace);
		expect(records).toHaveLength(1);
		expect(records[0].familyId).toBe(good.familyId);
	});

	it('listCleanupRecords handles paginated KV list results', async () => {
		const record1 = makeCleanupRecord('f1e4567-e89b-42d3-a456-426614174040');
		const record2 = makeCleanupRecord('f2e4567-e89b-42d3-a456-426614174041', {
			createdAt: 1
		});
		const store = new Map<string, string>();
		store.set(`cleanup:${record1.familyId}`, JSON.stringify(record1));
		store.set(`cleanup:${record2.familyId}`, JSON.stringify(record2));

		let listCall = 0;
		const kv = {
			get: vi.fn(async (key: string, type?: string) => {
				const value = store.get(key);
				if (!value) return null;
				return type === 'json' ? JSON.parse(value) : value;
			}),
			list: vi.fn(
				async (): Promise<{
					keys: { name: string }[];
					list_complete: boolean;
					cursor?: string;
				}> => {
					listCall++;
					if (listCall === 1) {
						return {
							keys: [{ name: `cleanup:${record1.familyId}` }],
							list_complete: false,
							cursor: 'next-page'
						};
					}
					return { keys: [{ name: `cleanup:${record2.familyId}` }], list_complete: true };
				}
			)
		} as unknown as KVNamespace;

		const records = await listCleanupRecords(kv);
		expect(records).toHaveLength(2);
		expect(kv.list).toHaveBeenCalledTimes(2);
	});

	it('listCleanupRecords filters a record with a non-string idempotency key', async () => {
		const kv = createMockKV();
		const invalidRecord = makeCleanupRecord('f3e4567-e89b-42d3-a456-426614174050', {
			idempotencyKey: 'key-to-corrupt'
		});
		const validRecord = makeCleanupRecord('f4e4567-e89b-42d3-a456-426614174051');
		await writeCleanupRecord(kv as unknown as KVNamespace, invalidRecord);
		await writeCleanupRecord(kv as unknown as KVNamespace, validRecord);

		const stored = JSON.parse(kv._store.get(`cleanup:${invalidRecord.familyId}`) ?? '{}') as {
			idempotencyKey?: unknown;
		};
		stored.idempotencyKey = 42;
		kv._store.set(`cleanup:${invalidRecord.familyId}`, JSON.stringify(stored));

		const records = await listCleanupRecords(kv as unknown as KVNamespace);

		expect(records).toEqual([validRecord]);
	});

	it('deleteCleanupRecord deletes the cleanup: prefix key', async () => {
		const kv = createMockKV();
		const record = makeCleanupRecord();
		kv._store.set(`cleanup:${record.familyId}`, JSON.stringify(record));

		await deleteCleanupRecord(kv as unknown as KVNamespace, record.familyId);
		expect(kv.delete).toHaveBeenCalledWith(`cleanup:${record.familyId}`);
		expect(kv._store.has(`cleanup:${record.familyId}`)).toBe(false);
	});
});

describe('listPuzzlesPage — cursor fallback', () => {
	it('falls back to isAfterCursor when cursor item is not in the filtered set', async () => {
		const kv = createMockKV();
		const p1 = pageFamilyId(50);
		const p2 = pageFamilyId(51);
		const p3 = pageFamilyId(52);
		storeFamily(kv, { id: p1, createdAt: 3000 });
		storeFamily(kv, { id: p2, createdAt: 2000 });
		storeFamily(kv, { id: p3, createdAt: 1000 });

		const cursor = btoa(JSON.stringify({ createdAt: 2500, id: 'deleted-mid' }));
		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20,
			cursor
		});

		const ids = result.puzzles.map((p) => p.id);
		expect(ids).toContain(p2);
		expect(ids).toContain(p3);
		expect(ids).not.toContain(p1);
	});
});

describe('listFamiliesPage — cursor handling', () => {
	it('continues after a valid cursor for an existing family', async () => {
		const kv = createMockKV();
		const firstId = pageFamilyId(90);
		const middleId = pageFamilyId(91);
		const lastId = pageFamilyId(92);
		storeFamily(kv, { id: firstId, createdAt: 5000 });
		storeFamily(kv, { id: middleId, createdAt: 5000 });
		storeFamily(kv, { id: lastId, createdAt: 5000 });
		await invalidateGalleryIndex(kv as unknown as KVNamespace);
		const cursor = btoa(JSON.stringify({ createdAt: 5000, id: middleId }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		const result = await listFamiliesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20,
			cursor
		});

		expect(result.total).toBe(3);
		expect(result.families.map((family) => family.id)).toEqual([lastId]);
	});

	it('uses the ID tie-break when a same-time cursor is filtered out', async () => {
		const kv = createMockKV();
		const firstId = pageFamilyId(93);
		const cursorId = pageFamilyId(94);
		const lastId = pageFamilyId(95);
		storeFamily(kv, { id: firstId, createdAt: 6000, status: 'ready' });
		storeFamily(kv, { id: cursorId, createdAt: 6000, status: 'processing' });
		storeFamily(kv, { id: lastId, createdAt: 6000, status: 'ready' });
		await invalidateGalleryIndex(kv as unknown as KVNamespace);
		const cursor = btoa(JSON.stringify({ createdAt: 6000, id: cursorId }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		const result = await listFamiliesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20,
			cursor
		});

		expect(result.total).toBe(2);
		expect(result.families.map((family) => family.id)).toEqual([lastId]);
	});

	it('treats a cursor with an invalid JSON shape as no cursor', async () => {
		const kv = createMockKV();
		const firstId = pageFamilyId(96);
		storeFamily(kv, { id: firstId, createdAt: 2000 });
		storeFamily(kv, { id: pageFamilyId(97), createdAt: 1000 });
		await invalidateGalleryIndex(kv as unknown as KVNamespace);
		const cursor = btoa('{"x":12}').replace(/=+$/, '');
		expect(cursor.length % 4).toBe(3);

		const result = await listFamiliesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 1,
			cursor
		});

		expect(result.families.map((family) => family.id)).toEqual([firstId]);
	});

	it('treats an undecodable cursor as no cursor', async () => {
		const kv = createMockKV();
		const firstId = pageFamilyId(98);
		storeFamily(kv, { id: firstId, createdAt: 2000 });
		storeFamily(kv, { id: pageFamilyId(99), createdAt: 1000 });
		await invalidateGalleryIndex(kv as unknown as KVNamespace);

		const result = await listFamiliesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 1,
			cursor: 'not-base64!'
		});

		expect(result.families.map((family) => family.id)).toEqual([firstId]);
	});
});

describe('listPuzzles — invalid metadata in gallery index', () => {
	it('logs invalid metadata entries during listPuzzles scan', async () => {
		const kv = createMockKV();
		const validId = '823e4567-e89b-42d3-a456-426614174060';
		const valid = makeVariantMeta(validId, 1000);
		kv._store.set(`puzzle:${validId}`, JSON.stringify(valid));
		kv._store.set('puzzle:invalid', JSON.stringify({ id: 'invalid', foo: 'bar' }));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await listPuzzles(kv as unknown as KVNamespace);
		expect(result.puzzles).toHaveLength(1);
		expect(result.puzzles[0].id).toBe(validId);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('invalid entries'));
		consoleSpy.mockRestore();
	});
});

describe('buildFamilyMetadata', () => {
	it('includes idempotencyKey on the family record when provided', () => {
		const family = buildFamilyMetadata({
			familyId: TEST_FAMILY_ID,
			name: 'Test Family',
			aspectRatio: '1:1',
			createdAt: 1000,
			variantIds: FAMILY_VARIANT_IDS,
			idempotencyKey: 'upload-key-1'
		});

		expect(family.idempotencyKey).toBe('upload-key-1');
	});

	it('omits idempotencyKey when not provided', () => {
		const family = buildFamilyMetadata({
			familyId: TEST_FAMILY_ID,
			name: 'Test Family',
			aspectRatio: '1:1',
			createdAt: 1000,
			variantIds: FAMILY_VARIANT_IDS
		});

		expect('idempotencyKey' in family).toBe(false);
	});
});
