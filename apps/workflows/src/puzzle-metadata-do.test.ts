import { describe, it, expect, vi } from 'vitest';
import { PuzzleMetadataDO } from './index';
import type { Env } from './index';
import type { PuzzleMetadata } from './types';

// Mock cloudflare:workers module (same as index.test.ts)
vi.mock('cloudflare:workers', async () => {
	class MockDurableObject {
		protected ctx: DurableObjectState;
		protected env: Record<string, unknown>;

		constructor(state: DurableObjectState, env: Record<string, unknown>) {
			this.ctx = state;
			this.env = env;
		}
	}

	return {
		DurableObject: MockDurableObject,
		WorkflowEntrypoint: class {
			protected env: Record<string, unknown> = {};
			constructor(_ctx: ExecutionContext, env: Record<string, unknown>) {
				this.env = env;
			}
		},
		WorkflowStep: {},
		WorkflowEvent: {}
	};
});

const baseMetadata: PuzzleMetadata = {
	id: 'test-puzzle',
	name: 'Test Puzzle',
	pieceCount: 4,
	gridCols: 2,
	gridRows: 2,
	imageWidth: 200,
	imageHeight: 200,
	createdAt: 1700000000000,
	version: 1,
	status: 'processing',
	pieces: [],
	progress: { totalPieces: 4, generatedPieces: 0, updatedAt: 1700000000000 }
};

interface StorageInit {
	puzzleId?: string;
	metadata?: PuzzleMetadata;
}

function createStorage(initial: StorageInit = {}) {
	const store: Record<string, unknown> = {};
	if (initial.puzzleId !== undefined) store['puzzleId'] = initial.puzzleId;
	if (initial.metadata !== undefined) store['metadata'] = initial.metadata;

	return {
		_store: store,
		get: vi.fn(async (key: string) => store[key] ?? null),
		put: vi.fn(async (key: string, value: unknown) => {
			store[key] = value;
		}),
		transaction: vi.fn(async (fn: () => Promise<void>) => fn())
	};
}

function createKV(metadata: PuzzleMetadata | null = baseMetadata) {
	return {
		get: vi.fn(async () => metadata),
		put: vi.fn(async () => undefined)
	};
}

function makeDO(storageInit: StorageInit = {}, kvMetadata: PuzzleMetadata | null = baseMetadata) {
	const storage = createStorage(storageInit);
	const kv = createKV(kvMetadata);
	const ctx = { storage } as unknown as DurableObjectState;
	const env = { PUZZLE_METADATA: kv } as unknown as Env;
	const durableObj = new PuzzleMetadataDO(ctx, env as unknown as Env);
	return { durableObj, storage, kv };
}

async function postRequest(durableObj: PuzzleMetadataDO, body: unknown, path = '/update') {
	return durableObj.fetch(
		new Request(`https://puzzle-metadata${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
}

describe('PuzzleMetadataDO.fetch - routing', () => {
	it('returns 404 for GET requests', async () => {
		const { durableObj } = makeDO();
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/update', { method: 'GET' })
		);
		expect(response.status).toBe(404);
	});

	it('returns 404 for wrong path', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, {}, '/wrong-path');
		expect(response.status).toBe(404);
	});

	it('returns 404 for DELETE requests', async () => {
		const { durableObj } = makeDO();
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/update', { method: 'DELETE' })
		);
		expect(response.status).toBe(404);
	});
});

describe('PuzzleMetadataDO.fetch - body validation', () => {
	it('returns 400 for invalid JSON body', async () => {
		const { durableObj } = makeDO();
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/update', {
				method: 'POST',
				body: 'not valid json'
			})
		);
		expect(response.status).toBe(400);
	});

	it('returns 400 when puzzleId is missing', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { updates: { status: 'ready' } });
		expect(response.status).toBe(400);
	});

	it('returns 400 when updates is missing', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle' });
		expect(response.status).toBe(400);
	});

	it('returns 400 when updates is null', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: null });
		expect(response.status).toBe(400);
	});

	it('returns 400 when updates is an array', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: [] });
		expect(response.status).toBe(400);
	});

	it('returns 400 when puzzleId is not a string', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { puzzleId: 123, updates: {} });
		expect(response.status).toBe(400);
	});
});

describe('PuzzleMetadataDO.fetch - puzzle identity', () => {
	it('stores puzzleId on first request', async () => {
		const { durableObj, storage } = makeDO();
		await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(storage.put).toHaveBeenCalledWith('puzzleId', 'test-puzzle');
	});

	it('accepts subsequent requests with the same puzzleId', async () => {
		const { durableObj } = makeDO({ puzzleId: 'test-puzzle', metadata: baseMetadata });
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(response.status).toBe(200);
	});

	it('returns 403 when puzzleId does not match stored puzzleId', async () => {
		const { durableObj } = makeDO({ puzzleId: 'original-puzzle' });
		const response = await postRequest(durableObj, {
			puzzleId: 'different-puzzle',
			updates: {}
		});
		expect(response.status).toBe(403);
	});

	it('returns 403 error message for puzzle ID mismatch', async () => {
		const { durableObj } = makeDO({ puzzleId: 'original-puzzle' });
		const response = await postRequest(durableObj, { puzzleId: 'other-puzzle', updates: {} });
		const body = (await response.json()) as { message: string };
		expect(body.message).toMatch(/mismatch/i);
	});
});

describe('PuzzleMetadataDO.fetch - metadata resolution', () => {
	it('returns 404 when metadata is not found in storage or KV', async () => {
		const { durableObj } = makeDO({}, null);
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(response.status).toBe(404);
	});

	it('reads metadata from storage when available', async () => {
		const { durableObj } = makeDO({ metadata: baseMetadata });
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(response.status).toBe(200);
	});

	it('reads metadata from KV when not in storage', async () => {
		const { durableObj, kv } = makeDO({}, baseMetadata);
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(kv.get).toHaveBeenCalled();
		expect(response.status).toBe(200);
	});
});

describe('PuzzleMetadataDO.fetch - status transitions', () => {
	it('transitions to ready status and clears progress', async () => {
		const { durableObj, storage } = makeDO({ metadata: baseMetadata });
		const response = await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'ready' }
		});
		expect(response.status).toBe(200);
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.status).toBe('ready');
		expect((stored as Record<string, unknown>).progress).toBeUndefined();
		expect((stored as Record<string, unknown>).error).toBeUndefined();
	});

	it('transitions to failed status and clears progress', async () => {
		const { durableObj, storage } = makeDO({ metadata: baseMetadata });
		const response = await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'failed', error: { message: 'Something went wrong' } }
		});
		expect(response.status).toBe(200);
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.status).toBe('failed');
		expect((stored as Record<string, unknown>).progress).toBeUndefined();
	});

	it('updates processing status without changing status field', async () => {
		const { durableObj, storage } = makeDO({ metadata: baseMetadata });
		const newProgress = { totalPieces: 4, generatedPieces: 2, updatedAt: Date.now() };
		const response = await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { progress: newProgress }
		});
		expect(response.status).toBe(200);
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.status).toBe('processing');
	});
});

describe('PuzzleMetadataDO.fetch - versioning', () => {
	it('increments version on each update', async () => {
		const { durableObj, storage } = makeDO({ metadata: { ...baseMetadata, version: 5 } });
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(response.status).toBe(200);
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.version).toBe(6);
	});

	it('returns updated version in success response', async () => {
		const { durableObj } = makeDO({ metadata: baseMetadata });
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; version: number };
		expect(body.success).toBe(true);
		expect(body.version).toBe(2); // version incremented from 1
	});
});

describe('PuzzleMetadataDO.fetch - piece merging', () => {
	it('adds new pieces to existing pieces', async () => {
		const existingPiece = {
			id: 0,
			puzzleId: 'test-puzzle',
			correctX: 0,
			correctY: 0,
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
			imagePath: 'pieces/0.png'
		};
		const newPiece = {
			id: 1,
			puzzleId: 'test-puzzle',
			correctX: 1,
			correctY: 0,
			edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' },
			imagePath: 'pieces/1.png'
		};
		const { durableObj, storage } = makeDO({
			metadata: { ...baseMetadata, pieces: [existingPiece] }
		});
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { pieces: [newPiece] }
		});
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.pieces).toHaveLength(2);
		expect(stored.pieces.map((p) => p.id)).toContain(0);
		expect(stored.pieces.map((p) => p.id)).toContain(1);
	});

	it('does not duplicate existing pieces', async () => {
		const existingPiece = {
			id: 0,
			puzzleId: 'test-puzzle',
			correctX: 0,
			correctY: 0,
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
			imagePath: 'pieces/0.png'
		};
		const { durableObj, storage } = makeDO({
			metadata: { ...baseMetadata, pieces: [existingPiece] }
		});
		// Send same piece again
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { pieces: [existingPiece] }
		});
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.pieces).toHaveLength(1);
	});

	it('ignores empty pieces array in update', async () => {
		const existingPiece = {
			id: 0,
			puzzleId: 'test-puzzle',
			correctX: 0,
			correctY: 0,
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
			imagePath: 'pieces/0.png'
		};
		const { durableObj, storage } = makeDO({
			metadata: { ...baseMetadata, pieces: [existingPiece] }
		});
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { pieces: [] }
		});
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.pieces).toHaveLength(1);
	});
});

describe('PuzzleMetadataDO.fetch - storage and KV sync', () => {
	it('returns 500 when storage transaction fails', async () => {
		const { durableObj, storage } = makeDO({ metadata: baseMetadata });
		storage.transaction.mockImplementation(async () => {
			throw new Error('Storage failure');
		});
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		expect(response.status).toBe(500);
	});

	it('returns 500 error message when transaction fails', async () => {
		const { durableObj, storage } = makeDO({ metadata: baseMetadata });
		storage.transaction.mockImplementation(async () => {
			throw new Error('Disk full');
		});
		const response = await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: {} });
		const body = (await response.json()) as { message: string };
		expect(body.message).toMatch(/persist/i);
	});

	it('syncs updated metadata to KV after DO update', async () => {
		const { durableObj, kv } = makeDO({ metadata: baseMetadata });
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'ready' }
		});
		expect(kv.put).toHaveBeenCalledWith('puzzle:test-puzzle', expect.any(String));
	});

	it('KV put contains JSON with updated metadata', async () => {
		const { durableObj, kv } = makeDO({ metadata: baseMetadata });
		await postRequest(durableObj, { puzzleId: 'test-puzzle', updates: { status: 'ready' } });
		const putCall = kv.put.mock.calls[0];
		const jsonStr = putCall?.[1] as string;
		const parsed = JSON.parse(jsonStr) as PuzzleMetadata;
		expect(parsed.status).toBe('ready');
		expect(parsed.id).toBe('test-puzzle');
	});

	it('protects puzzle id from being overwritten by updates', async () => {
		const { durableObj, storage } = makeDO({ metadata: baseMetadata });
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { id: 'hacked-id' } as Partial<PuzzleMetadata>
		});
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.id).toBe('test-puzzle');
	});
});
