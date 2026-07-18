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
	reservedPuzzleId?: string;
	reservation?: {
		puzzleId: string;
		status: 'pending' | 'committed' | 'failed';
		reservedAt?: number;
	};
}

function createStorage(initial: StorageInit = {}) {
	const store: Record<string, unknown> = {};
	if (initial.puzzleId !== undefined) store['puzzleId'] = initial.puzzleId;
	if (initial.metadata !== undefined) store['metadata'] = initial.metadata;
	if (initial.reservedPuzzleId !== undefined) store['reservedPuzzleId'] = initial.reservedPuzzleId;
	if (initial.reservation !== undefined) store['reservation'] = initial.reservation;

	// Serialize transactions so concurrent callers do not interleave their
	// reads/writes — mirroring a real Durable Object transaction's atomicity.
	// Also propagates the callback's return value (handleReserve returns its
	// reserve result from inside the transaction).
	let txnChain: Promise<unknown> = Promise.resolve();

	return {
		_store: store,
		get: vi.fn(async (key: string) => store[key] ?? null),
		put: vi.fn(async (key: string, value: unknown) => {
			store[key] = value;
		}),
		delete: vi.fn(async (key: string) => {
			delete store[key];
		}),
		transaction: vi.fn(async (fn: () => Promise<unknown>) => {
			const run = txnChain.then(() => fn());
			// Advance the chain regardless of success so one failing txn does
			// not permanently block subsequent ones.
			txnChain = run.then(
				() => undefined,
				() => undefined
			);
			return run;
		})
	};
}

function createKV(metadata: PuzzleMetadata | null = baseMetadata) {
	const expectedKey = metadata ? `puzzle:${metadata.id}` : undefined;
	const store: Record<string, string> = {};
	if (metadata) {
		store[`puzzle:${metadata.id}`] = JSON.stringify(metadata);
	}
	return {
		get: vi.fn(async (key: string, type?: string) => {
			if (expectedKey !== undefined) {
				expect(key).toBe(expectedKey);
			}
			const value = store[key];
			return type === 'json' && value ? JSON.parse(value) : (value ?? null);
		}),
		put: vi.fn(async (key: string, value: string) => {
			store[key] = value;
		}),
		delete: vi.fn(async (key: string) => {
			delete store[key];
		}),
		_store: store
	};
}

interface WorkflowMock {
	status?: InstanceStatus['status'];
	throwOnGet?: boolean;
	throwOnStatus?: boolean;
}

function createWorkflow(mock: WorkflowMock = { status: 'running' }) {
	const statusFn = vi.fn(async () => ({
		status: mock.status ?? 'running',
		...(mock.status === 'errored' ? { error: { name: 'Error', message: 'workflow failed' } } : {})
	}));
	const instance = { status: statusFn };
	const getFn = vi.fn(async () => {
		if (mock.throwOnGet) throw new Error('workflow get failed');
		if (mock.throwOnStatus) {
			return {
				status: vi.fn(async () => {
					throw new Error('workflow status failed');
				})
			};
		}
		return instance;
	});
	return { get: getFn, _statusFn: statusFn, _instance: instance };
}

function makeDO(
	storageInit: StorageInit = {},
	kvMetadata: PuzzleMetadata | null = baseMetadata,
	workflowMock: WorkflowMock = { status: 'running' }
) {
	const storage = createStorage(storageInit);
	const kv = createKV(kvMetadata);
	const workflow = createWorkflow(workflowMock);
	const ctx = { storage } as unknown as DurableObjectState;
	const env = {
		PUZZLE_METADATA: kv,
		PUZZLE_WORKFLOW: workflow
	} as unknown as Env;
	const durableObj = new PuzzleMetadataDO(ctx, env as unknown as Env);
	return { durableObj, storage, kv, workflow };
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
	it('returns 405 for GET requests', async () => {
		const { durableObj } = makeDO();
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/update', { method: 'GET' })
		);
		expect(response.status).toBe(405);
	});

	it('returns 404 for wrong path', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, {}, '/wrong-path');
		expect(response.status).toBe(404);
	});

	it('returns 405 for DELETE requests', async () => {
		const { durableObj } = makeDO();
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/update', { method: 'DELETE' })
		);
		expect(response.status).toBe(405);
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
		expect(kv.get).toHaveBeenCalledWith('puzzle:test-puzzle', 'json');
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
		expect((stored as unknown as Record<string, unknown>).progress).toBeUndefined();
		expect((stored as unknown as Record<string, unknown>).error).toBeUndefined();
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
		expect((stored as unknown as Record<string, unknown>).progress).toBeUndefined();
	});

	it('refuses ready → failed transition with 409 and leaves metadata intact', async () => {
		// Guards the finalize/mark-failed race: if finalize committed 'ready'
		// but the workflow's error path then runs mark-failed, the DO must
		// refuse to clobber the good 'ready' state. A 'ready' puzzle is
		// terminal — no remaining processing can legitimately fail.
		const readyMetadata: PuzzleMetadata = {
			...baseMetadata,
			status: 'ready',
			progress: undefined,
			error: undefined
		} as PuzzleMetadata;
		const { durableObj, storage } = makeDO({ metadata: readyMetadata });
		const response = await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'failed', error: { message: 'belated failure' } }
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as { message: string };
		expect(body.message).toMatch(/already ready/i);
		// The stored metadata must be untouched — no downgrade, no version bump.
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.status).toBe('ready');
		expect(stored.version).toBe(readyMetadata.version);
		expect(storage.put).not.toHaveBeenCalledWith('metadata', expect.anything());
	});

	it('still allows idempotent ready → ready re-writes', async () => {
		// The ready → failed guard must not block a benign ready → ready
		// re-write (e.g. finalize retried after a transient response loss).
		const readyMetadata: PuzzleMetadata = {
			...baseMetadata,
			status: 'ready',
			progress: undefined,
			error: undefined
		} as PuzzleMetadata;
		const { durableObj, storage } = makeDO({ metadata: readyMetadata });
		const response = await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'ready' }
		});
		expect(response.status).toBe(200);
		const stored = storage._store['metadata'] as PuzzleMetadata;
		expect(stored.status).toBe('ready');
		expect(stored.version).toBe(readyMetadata.version + 1);
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
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' } as const,
			imagePath: 'pieces/0.png'
		};
		const newPiece = {
			id: 1,
			puzzleId: 'test-puzzle',
			correctX: 1,
			correctY: 0,
			edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' } as const,
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
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' } as const,
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
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' } as const,
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
		const putCall = kv.put.mock.calls[0] as unknown as [string, string] | undefined;
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

describe('PuzzleMetadataDO.fetch - gallery index cache invalidation', () => {
	it('invalidates gallery index when status transitions to ready', async () => {
		const { durableObj, kv } = makeDO({ metadata: baseMetadata });
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'ready' }
		});
		expect(kv.delete).toHaveBeenCalledWith('gallery:sorted-index');
	});

	it('invalidates gallery index when status transitions to failed', async () => {
		const { durableObj, kv } = makeDO({ metadata: baseMetadata });
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { status: 'failed', error: { message: 'Something went wrong' } }
		});
		expect(kv.delete).toHaveBeenCalledWith('gallery:sorted-index');
	});

	it('does not invalidate gallery index for progress-only updates', async () => {
		const { durableObj, kv } = makeDO({ metadata: baseMetadata });
		await postRequest(durableObj, {
			puzzleId: 'test-puzzle',
			updates: { progress: { totalPieces: 4, generatedPieces: 2, updatedAt: Date.now() } }
		});
		expect(kv.delete).not.toHaveBeenCalledWith('gallery:sorted-index');
	});
});

describe('PuzzleMetadataDO.fetch - /reserve (idempotency)', () => {
	it('stores pending reservation on first reserve and returns existing: false', async () => {
		const { durableObj, storage } = makeDO();
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: 'abc123',
				puzzleId: 'puzzle-uuid-1'
			},
			'/reserve'
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			existing: boolean;
			puzzleId: string;
			status: string;
		};
		expect(body.existing).toBe(false);
		expect(body.puzzleId).toBe('puzzle-uuid-1');
		expect(body.status).toBe('pending');
		expect(storage.put).toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({
				puzzleId: 'puzzle-uuid-1',
				status: 'pending',
				reservedAt: expect.any(Number)
			})
		);
		expect(storage.put).toHaveBeenCalledWith('reservedPuzzleId', 'puzzle-uuid-1');
	});

	it('returns existing: true with original puzzleId on second reserve', async () => {
		const { durableObj } = makeDO({
			reservation: {
				puzzleId: 'original-uuid',
				status: 'pending',
				reservedAt: Date.now()
			}
		});
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: 'abc123',
				puzzleId: 'different-uuid'
			},
			'/reserve'
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			existing: boolean;
			puzzleId: string;
			status: string;
		};
		expect(body.existing).toBe(true);
		expect(body.puzzleId).toBe('original-uuid');
		expect(body.status).toBe('pending');
	});

	it('allows re-reserve after failed reservation', async () => {
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'failed-uuid', status: 'failed' }
		});
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: 'abc123',
				puzzleId: 'retry-uuid'
			},
			'/reserve'
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { existing: boolean; puzzleId: string };
		expect(body.existing).toBe(false);
		expect(body.puzzleId).toBe('retry-uuid');
		expect(storage.put).toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({
				puzzleId: 'retry-uuid',
				status: 'pending',
				reservedAt: expect.any(Number)
			})
		);
	});

	it('reclaims stale pending reservation older than TTL when no live puzzle', async () => {
		const staleAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago
		// kvMetadata null → getMetadata returns null → safe to reclaim
		const { durableObj, storage } = makeDO(
			{
				reservation: {
					puzzleId: 'stale-uuid',
					status: 'pending',
					reservedAt: staleAt
				}
			},
			null
		);
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: 'abc123',
				puzzleId: 'fresh-uuid'
			},
			'/reserve'
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { existing: boolean; puzzleId: string };
		expect(body.existing).toBe(false);
		expect(body.puzzleId).toBe('fresh-uuid');
		expect(storage.put).toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({
				puzzleId: 'fresh-uuid',
				status: 'pending',
				reservedAt: expect.any(Number)
			})
		);
	});

	it('promotes stale pending to committed when live puzzle still exists', async () => {
		// Commit-failure path: metadata was written but reservation stayed
		// pending until TTL. Reclaiming would mint a duplicate — promote instead.
		const staleAt = Date.now() - 10 * 60 * 1000;
		const liveMeta: PuzzleMetadata = {
			...baseMetadata,
			id: 'live-stale-uuid',
			status: 'processing'
		};
		const { durableObj, storage } = makeDO(
			{
				reservation: {
					puzzleId: 'live-stale-uuid',
					status: 'pending',
					reservedAt: staleAt
				}
			},
			liveMeta
		);
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: 'abc123',
				puzzleId: 'would-be-duplicate'
			},
			'/reserve'
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			existing: boolean;
			puzzleId: string;
			status: string;
		};
		expect(body.existing).toBe(true);
		expect(body.puzzleId).toBe('live-stale-uuid');
		expect(body.status).toBe('committed');
		expect(storage.put).toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({
				puzzleId: 'live-stale-uuid',
				status: 'committed'
			})
		);
	});

	it('returns 409 (not reclaim) when KV metadata lookup throws for stale pending', async () => {
		// A transient KV error during the stale-pending metadata lookup must
		// NOT fall through to reclaim — that would mint a duplicate of a live
		// puzzle whose metadata was momentarily unreadable. Fail closed: 409.
		const staleAt = Date.now() - 10 * 60 * 1000;
		const liveMeta: PuzzleMetadata = {
			...baseMetadata,
			id: 'kv-error-uuid',
			status: 'processing'
		};
		const { durableObj, kv, storage } = makeDO(
			{
				reservation: {
					puzzleId: 'kv-error-uuid',
					status: 'pending',
					reservedAt: staleAt
				}
			},
			liveMeta
		);
		// Force kv.get to throw a transient KV error.
		(kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('KV internal error'));
		const response = await postRequest(
			durableObj,
			{ idempotencyKey: 'abc123', puzzleId: 'fresh-uuid' },
			'/reserve'
		);
		expect(response.status).toBe(409);
		// Must NOT reclaim — reservation should not be overwritten with a new pending.
		expect(storage.put).not.toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({ puzzleId: 'fresh-uuid', status: 'pending' })
		);
	});

	it('fails stale-pending reservation when workflow status is errored', async () => {
		// Metadata exists (processing) but the workflow errored — the puzzle
		// is stuck. Promoting would return it as 200 forever. Per policy,
		// mark the reservation failed so a retry reclaims and creates fresh.
		const staleAt = Date.now() - 10 * 60 * 1000;
		const liveMeta: PuzzleMetadata = {
			...baseMetadata,
			id: 'stuck-errored-uuid',
			status: 'processing'
		};
		const { durableObj, storage } = makeDO(
			{
				reservation: {
					puzzleId: 'stuck-errored-uuid',
					status: 'pending',
					reservedAt: staleAt
				}
			},
			liveMeta,
			{ status: 'errored' }
		);
		const response = await postRequest(
			durableObj,
			{ idempotencyKey: 'abc123', puzzleId: 'would-be-duplicate' },
			'/reserve'
		);
		expect(response.status).toBe(409);
		// Reservation marked failed so a retry can reclaim.
		expect(storage.put).toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({
				puzzleId: 'stuck-errored-uuid',
				status: 'failed'
			})
		);
		// Must NOT mint a duplicate.
		expect(storage.put).not.toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({ puzzleId: 'would-be-duplicate', status: 'pending' })
		);
	});

	it('fails stale-pending reservation when workflow was never created (unknown)', async () => {
		// The scenario from the review: createPuzzleMetadata succeeded but
		// PUZZLE_WORKFLOW.create never ran (process died). Workflow instance
		// status is unknown. Must not promote the stuck processing puzzle.
		const staleAt = Date.now() - 10 * 60 * 1000;
		const liveMeta: PuzzleMetadata = {
			...baseMetadata,
			id: 'no-workflow-uuid',
			status: 'processing'
		};
		const { durableObj, storage } = makeDO(
			{
				reservation: {
					puzzleId: 'no-workflow-uuid',
					status: 'pending',
					reservedAt: staleAt
				}
			},
			liveMeta,
			{ status: 'unknown' }
		);
		const response = await postRequest(
			durableObj,
			{ idempotencyKey: 'abc123', puzzleId: 'would-be-duplicate' },
			'/reserve'
		);
		expect(response.status).toBe(409);
		expect(storage.put).toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({
				puzzleId: 'no-workflow-uuid',
				status: 'failed'
			})
		);
	});

	it('returns 409 when workflow status check throws', async () => {
		// If PUZZLE_WORKFLOW.get() or .status() throws, fail closed: 409.
		// Don't promote (might be stuck) and don't reclaim (might be live).
		const staleAt = Date.now() - 10 * 60 * 1000;
		const liveMeta: PuzzleMetadata = {
			...baseMetadata,
			id: 'wf-throw-uuid',
			status: 'processing'
		};
		const { durableObj, storage } = makeDO(
			{
				reservation: {
					puzzleId: 'wf-throw-uuid',
					status: 'pending',
					reservedAt: staleAt
				}
			},
			liveMeta,
			{ throwOnGet: true }
		);
		const response = await postRequest(
			durableObj,
			{ idempotencyKey: 'abc123', puzzleId: 'would-be-duplicate' },
			'/reserve'
		);
		expect(response.status).toBe(409);
		// Must NOT modify the reservation when unsure.
		expect(storage.put).not.toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({ status: 'committed' })
		);
		expect(storage.put).not.toHaveBeenCalledWith(
			'reservation',
			expect.objectContaining({ puzzleId: 'would-be-duplicate' })
		);
	});

	it('does not reclaim fresh pending reservation within TTL', async () => {
		const recentAt = Date.now() - 30_000; // 30 seconds ago
		const { durableObj } = makeDO({
			reservation: {
				puzzleId: 'fresh-pending-uuid',
				status: 'pending',
				reservedAt: recentAt
			}
		});
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: 'abc123',
				puzzleId: 'other-uuid'
			},
			'/reserve'
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			existing: boolean;
			puzzleId: string;
			status: string;
		};
		expect(body.existing).toBe(true);
		expect(body.puzzleId).toBe('fresh-pending-uuid');
		expect(body.status).toBe('pending');
	});

	it('owner-checked commit transitions pending to committed', async () => {
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' }
		});
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/commit');
		expect(response.status).toBe(200);
		expect(storage.put).toHaveBeenCalledWith('reservation', {
			puzzleId: 'puzzle-uuid-1',
			status: 'committed'
		});
	});

	it('rejects commit from non-owner', async () => {
		const { durableObj } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' }
		});
		const response = await postRequest(durableObj, { puzzleId: 'other-uuid' }, '/commit');
		expect(response.status).toBe(409);
	});

	it('owner-checked release deletes reservation', async () => {
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' },
			reservedPuzzleId: 'puzzle-uuid-1'
		});
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/release');
		expect(response.status).toBe(200);
		expect(storage.delete).toHaveBeenCalledWith('reservation');
		expect(storage.delete).toHaveBeenCalledWith('reservedPuzzleId');
	});

	it('owner-checked fail marks reservation failed', async () => {
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' }
		});
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/fail');
		expect(response.status).toBe(200);
		expect(storage.put).toHaveBeenCalledWith('reservation', {
			puzzleId: 'puzzle-uuid-1',
			status: 'failed'
		});
	});

	it('returns 400 when idempotencyKey is missing', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-1' }, '/reserve');
		expect(response.status).toBe(400);
	});

	it('returns 400 when puzzleId is missing', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { idempotencyKey: 'abc123' }, '/reserve');
		expect(response.status).toBe(400);
	});

	it('returns 400 when idempotencyKey is empty', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(
			durableObj,
			{
				idempotencyKey: '  ',
				puzzleId: 'puzzle-1'
			},
			'/reserve'
		);
		expect(response.status).toBe(400);
	});

	it('returns 400 for invalid JSON body', async () => {
		const { durableObj } = makeDO();
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/reserve', {
				method: 'POST',
				body: 'not valid json'
			})
		);
		expect(response.status).toBe(400);
	});

	it('serializes concurrent reserves so exactly one caller wins the claim', async () => {
		// Two /reserve calls for the same key race. Because handleReserve
		// performs its read-decide-write inside storage.transaction (and the
		// mock serializes transactions), exactly one caller must win and the
		// other must observe the winner's reservation — no duplicate claim.
		// Without the transaction wrapper, both would read null and both would
		// return existing:false, so this test guards that regression.
		const { durableObj } = makeDO();
		const [r1, r2] = await Promise.all([
			postRequest(durableObj, { idempotencyKey: 'k', puzzleId: 'puzzle-a' }, '/reserve'),
			postRequest(durableObj, { idempotencyKey: 'k', puzzleId: 'puzzle-b' }, '/reserve')
		]);
		const b1 = (await r1.json()) as { existing: boolean; puzzleId: string };
		const b2 = (await r2.json()) as { existing: boolean; puzzleId: string };

		const winners = [b1, b2].filter((b) => b.existing === false);
		expect(winners.length).toBe(1);
		const winnerId = winners[0].puzzleId;
		expect(['puzzle-a', 'puzzle-b']).toContain(winnerId);

		const loser = [b1, b2].find((b) => b.existing === true)!;
		expect(loser.puzzleId).toBe(winnerId);
	});
});

describe('PuzzleMetadataDO.fetch - /commit /fail /release transition edge cases', () => {
	it('returns 400 for invalid commit payload (missing puzzleId)', async () => {
		const { durableObj } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' }
		});
		const response = await postRequest(durableObj, {}, '/commit');
		expect(response.status).toBe(400);
	});

	it('returns 400 for commit payload with empty puzzleId', async () => {
		const { durableObj } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' }
		});
		const response = await postRequest(durableObj, { puzzleId: '  ' }, '/commit');
		expect(response.status).toBe(400);
	});

	it('returns 400 for invalid JSON body on commit', async () => {
		const { durableObj } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'pending' }
		});
		const response = await durableObj.fetch(
			new Request('https://puzzle-metadata/commit', {
				method: 'POST',
				body: 'not valid json'
			})
		);
		expect(response.status).toBe(400);
	});

	it('returns 404 when committing against a DO with no reservation', async () => {
		const { durableObj } = makeDO();
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/commit');
		expect(response.status).toBe(404);
		const body = (await response.json()) as { message: string };
		expect(body.message).toMatch(/no reservation/i);
	});

	it('allows committed → failed reclaim after workflow marked puzzle failed', async () => {
		// A committed reservation whose workflow later marked the puzzle
		// failed must be demotable to failed so a retry can reclaim the key
		// and create a replacement. The admin retry path calls /fail on the
		// committed reservation before re-reserving with a new puzzleId.
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'committed' }
		});
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/fail');
		expect(response.status).toBe(200);
		expect(storage.put).toHaveBeenCalledWith('reservation', {
			puzzleId: 'puzzle-uuid-1',
			status: 'failed'
		});
	});

	it('allows committed → released cleanup after puzzle deletion', async () => {
		// A committed reservation must be releasable after an admin deletes
		// the puzzle so the key can be reused. Without this, a deleted seeded
		// puzzle permanently maps its key to the deleted ID.
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'committed' },
			reservedPuzzleId: 'puzzle-uuid-1'
		});
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/release');
		expect(response.status).toBe(200);
		expect(storage.delete).toHaveBeenCalledWith('reservation');
		expect(storage.delete).toHaveBeenCalledWith('reservedPuzzleId');
	});

	it('rejects committed → committed-via-fail with 409 for non-owner', async () => {
		// Owner check still applies: a non-owner cannot fail a committed
		// reservation even though committed → failed is now allowed.
		const { durableObj } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'committed' }
		});
		const response = await postRequest(durableObj, { puzzleId: 'other-uuid' }, '/fail');
		expect(response.status).toBe(409);
		const body = (await response.json()) as { message: string };
		expect(body.message).toMatch(/owned by another/i);
	});

	it('idempotent commit returns success without rewriting when already committed', async () => {
		const { durableObj, storage } = makeDO({
			reservation: { puzzleId: 'puzzle-uuid-1', status: 'committed' }
		});
		const response = await postRequest(durableObj, { puzzleId: 'puzzle-uuid-1' }, '/commit');
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; status: string };
		expect(body.success).toBe(true);
		expect(body.status).toBe('committed');
		// No new write — the idempotent branch returns before storage.put.
		expect(storage.put).not.toHaveBeenCalledWith('reservation', expect.anything());
	});

	it('reads legacy reservedPuzzleId (plain string) when no reservation object exists', async () => {
		// Pre-rollout DO instances stored only a plain puzzleId string under
		// 'reservedPuzzleId'. readReservation must treat that as a committed
		// reservation so a post-rollout commit/fail/release still resolves it.
		const { durableObj } = makeDO({ reservedPuzzleId: 'legacy-puzzle-uuid' });
		const response = await postRequest(durableObj, { puzzleId: 'legacy-puzzle-uuid' }, '/commit');
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; status: string };
		// Legacy reservations are read back as 'committed', so a commit hits the
		// idempotent same-status branch.
		expect(body.success).toBe(true);
		expect(body.status).toBe('committed');
	});
});
