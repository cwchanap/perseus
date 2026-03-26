import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerseusWorkflow } from './index';
import workflowWorker from './index';
import { MAX_IMAGE_BYTES, updateMetadata, padPixelsToTarget, applyMaskAlpha } from './helpers';
import type { PuzzleMetadata } from './types';
import { MAX_IMAGE_DIMENSION } from './types';
import type { Env } from './index';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowParams } from './types';

// Mock cloudflare:workers module
vi.mock('cloudflare:workers', async () => {
	// Base DurableObject class mock
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

let mockWidth = 100;
let mockHeight = 100;
let photonInstances: Array<{ free: ReturnType<typeof vi.fn> }> = [];

class PhotonImageMock {
	private width: number;
	private height: number;
	private pixels: Uint8Array;
	free: ReturnType<typeof vi.fn>;

	constructor(pixels?: Uint8Array, width?: number, height?: number) {
		this.width = width ?? mockWidth;
		this.height = height ?? mockHeight;
		this.pixels = pixels ?? new Uint8Array(this.width * this.height * 4);
		this.free = vi.fn();
	}

	get_width() {
		return this.width;
	}

	get_height() {
		return this.height;
	}

	get_raw_pixels() {
		return this.pixels;
	}

	get_bytes() {
		return this.pixels;
	}

	get_bytes_jpeg() {
		return new Uint8Array([1, 2, 3]);
	}
}

vi.mock('@cf-wasm/photon', () => ({
	PhotonImage: Object.assign(PhotonImageMock, {
		new_from_byteslice: vi.fn((bytes?: Uint8Array) => {
			const width = (bytes as { __width?: number } | undefined)?.__width ?? mockWidth;
			const height = (bytes as { __height?: number } | undefined)?.__height ?? mockHeight;
			const image = new PhotonImageMock(undefined, width, height);
			photonInstances.push(image);
			return image;
		})
	}),
	crop: vi.fn((_image: PhotonImageMock, x: number, y: number, x2: number, y2: number) => {
		const image = new PhotonImageMock(undefined, x2 - x, y2 - y);
		photonInstances.push(image);
		return image;
	}),
	resize: vi.fn((_image: PhotonImageMock, width: number, height: number) => {
		const image = new PhotonImageMock(undefined, width, height);
		photonInstances.push(image);
		return image;
	}),
	SamplingFilter: {
		Lanczos3: 3
	}
}));

vi.mock('@cf-wasm/resvg', () => ({
	Resvg: class {
		private width: number;
		private height: number;

		constructor(svg: string, options?: { fitTo?: { value?: number } }) {
			this.width = options?.fitTo?.value ?? 1;
			const match = svg.match(/height="(\d+)"/u);
			this.height = match ? Number(match[1]) : this.width;
		}

		render() {
			return {
				asPng: () => {
					const bytes = new Uint8Array(this.width * this.height * 4);
					(bytes as { __width?: number }).__width = this.width;
					(bytes as { __height?: number }).__height = this.height;
					return bytes;
				}
			};
		}
	}
}));

function createMockDurableObjectNamespace(
	handler: (body: { puzzleId?: string; updates?: Partial<PuzzleMetadata> }) => Response
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

function createMockBucket(bytes: ArrayBuffer) {
	return {
		get: vi.fn(async () => ({
			arrayBuffer: vi.fn(async () => bytes)
		})),
		put: vi.fn(async () => undefined)
	};
}

function createMockKv(metadata: PuzzleMetadata) {
	return {
		get: vi.fn(async () => metadata)
	};
}

function createMockStep(): WorkflowStep {
	return {
		do: vi.fn(async (_name: string, configOrFn: unknown, maybeFn?: unknown) => {
			const fn =
				typeof configOrFn === 'function'
					? (configOrFn as () => Promise<unknown>)
					: (maybeFn as () => Promise<unknown>);
			return fn();
		}),
		sleep: vi.fn(async () => undefined),
		sleepUntil: vi.fn(async () => undefined),
		waitForEvent: vi.fn(async () => ({
			payload: {},
			timestamp: new Date(),
			type: 'event'
		}))
	} as WorkflowStep;
}

class TestWorkflow extends PerseusWorkflow {
	constructor() {
		super({} as ExecutionContext, {} as Env);
	}

	setEnv(env: Env) {
		this.setEnvOnWorkflow(env);
	}
}

const sampleMetadata: PuzzleMetadata = {
	id: '550e8400-e29b-41d4-a716-446655440000',
	name: 'Test Puzzle',
	pieceCount: 4,
	gridCols: 2,
	gridRows: 2,
	imageWidth: 100,
	imageHeight: 100,
	createdAt: 1700000000000,
	status: 'processing',
	version: 0,
	pieces: [],
	progress: {
		totalPieces: 4,
		generatedPieces: 0,
		updatedAt: 1700000000000
	}
};

describe('updateMetadata', () => {
	afterEach(() => {
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('should forward update requests to durable object', async () => {
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const puzzleId = 'test-puzzle';
		const updates: Partial<PuzzleMetadata> = { status: 'ready', imageWidth: 3840 };

		await updateMetadata(namespace as unknown as DurableObjectNamespace, puzzleId, updates);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body).toEqual({ puzzleId, updates });
	});

	it('should surface durable object errors', async () => {
		const puzzleId = 'nonexistent-puzzle';
		const { namespace } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ message: `Puzzle ${puzzleId} not found` }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		});

		await expect(
			updateMetadata(namespace as unknown as DurableObjectNamespace, puzzleId, {
				status: 'ready'
			})
		).rejects.toThrow(`Puzzle ${puzzleId} not found`);
	});

	it('uses generic HTTP error message when response body has no message field', async () => {
		const puzzleId = 'no-message-puzzle';
		const { namespace } = createMockDurableObjectNamespace(() => {
			// Response without a 'message' field — exercises the ?? fallback in updateMetadata
			return new Response(JSON.stringify({ error: 'internal error' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		});

		await expect(
			updateMetadata(namespace as unknown as DurableObjectNamespace, puzzleId, {
				status: 'ready'
			})
		).rejects.toThrow(`Failed to update puzzle ${puzzleId} (HTTP 500)`);
	});

	it('frees the source image after generating a row of pieces', async () => {
		const puzzleId = sampleMetadata.id;
		const minimalMetadata: PuzzleMetadata = {
			...sampleMetadata,
			pieceCount: 1,
			gridCols: 1,
			gridRows: 1
		};
		const { namespace } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createMockKv(minimalMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;
		const step = createMockStep();
		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await workflow.run(event, step);

		const sourceImage = photonInstances[4];
		expect(sourceImage?.free).toHaveBeenCalled();
	});
});

describe('image masking helpers', () => {
	it('pads piece pixels into target dimensions with offsets', () => {
		const sourcePixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
		const padded = padPixelsToTarget(sourcePixels, 2, 1, 4, 3, 1, 1);

		expect(padded).toHaveLength(4 * 3 * 4);
		const start = (1 * 4 + 1) * 4;
		expect(padded.slice(start, start + 8)).toEqual(sourcePixels);
	});

	it('copies mask alpha into piece pixels', () => {
		const piecePixels = new Uint8Array([10, 10, 10, 0, 20, 20, 20, 0]);
		const maskPixels = new Uint8Array([0, 0, 0, 200, 0, 0, 0, 100]);

		applyMaskAlpha(piecePixels, maskPixels);

		expect(piecePixels[3]).toBe(200);
		expect(piecePixels[7]).toBe(100);
	});
});

describe('Workflow Execution - Image Validation', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('should reject images exceeding MAX_IMAGE_BYTES', async () => {
		const puzzleId = sampleMetadata.id;
		const oversizedBytes = new ArrayBuffer(MAX_IMAGE_BYTES + 1);
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(oversizedBytes),
			PUZZLE_METADATA: createMockKv(sampleMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;
		const step = createMockStep();
		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const message =
			`Image size ${MAX_IMAGE_BYTES + 1} bytes exceeds maximum ${MAX_IMAGE_BYTES} bytes. ` +
			'Please use a smaller image.';

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, step)).rejects.toThrow(message);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body).toEqual({
			puzzleId,
			updates: {
				status: 'failed',
				error: { message }
			}
		});
	});

	it('should reject images exceeding MAX_IMAGE_DIMENSION', async () => {
		const puzzleId = sampleMetadata.id;
		mockWidth = MAX_IMAGE_DIMENSION + 1;
		mockHeight = MAX_IMAGE_DIMENSION + 2;
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createMockKv(sampleMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;
		const step = createMockStep();
		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const message = `Image dimensions ${mockWidth}x${mockHeight} exceed maximum ${MAX_IMAGE_DIMENSION}px`;

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, step)).rejects.toThrow(message);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body).toEqual({
			puzzleId,
			updates: {
				status: 'failed',
				error: { message }
			}
		});
	});
});

describe('Workflow Execution - Parameter Validation', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('throws for non-UUID puzzleId', async () => {
		const workflow = new TestWorkflow();
		workflow.setEnv({} as Env);

		const event = {
			payload: { puzzleId: 'not-a-uuid' },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(
			workflow.run(event as WorkflowEvent<WorkflowParams>, createMockStep())
		).rejects.toThrow('Invalid workflow parameters');
	});

	it('throws for empty puzzleId', async () => {
		const workflow = new TestWorkflow();
		workflow.setEnv({} as Env);

		const event = {
			payload: { puzzleId: '' },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(
			workflow.run(event as WorkflowEvent<WorkflowParams>, createMockStep())
		).rejects.toThrow('Invalid workflow parameters');
	});
});

describe('Workflow Execution - Resource Loading', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('marks puzzle as failed when metadata not found', async () => {
		const puzzleId = sampleMetadata.id;
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: { get: vi.fn(async () => null) }, // not found
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).rejects.toThrow('not found');

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body.updates.status).toBe('failed');
	});

	it('marks puzzle as failed when original image not found in R2', async () => {
		const puzzleId = sampleMetadata.id;
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const nullBucket = {
			get: vi.fn(async () => null), // image not in R2
			put: vi.fn(async () => undefined)
		};
		const env = {
			PUZZLES_BUCKET: nullBucket,
			PUZZLE_METADATA: createMockKv(sampleMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).rejects.toThrow(
			`Original image not found for puzzle ${puzzleId}`
		);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body.updates.status).toBe('failed');
	});
});

describe('Default export fetch handler', () => {
	it('returns 404 Not Found for all HTTP requests', async () => {
		const response = await workflowWorker.fetch(
			new Request('https://example.com/anything'),
			{} as Env
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not Found');
	});

	it('returns 404 for POST requests too', async () => {
		const response = await workflowWorker.fetch(
			new Request('https://example.com/api/data', { method: 'POST' }),
			{} as Env
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not Found');
	});
});

describe('Workflow Execution - mark-failed retry exhaustion', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('logs CRITICAL and rethrows when all mark-failed retries fail', async () => {
		vi.useFakeTimers();
		try {
			const puzzleId = sampleMetadata.id;

			// DO always returns 500 → updateMetadata throws on every attempt
			const alwaysFailingDO = {
				idFromName: vi.fn(() => 'test-id'),
				get: vi.fn(() => ({
					fetch: vi.fn(
						async () =>
							new Response(JSON.stringify({ message: 'DO unavailable' }), {
								status: 500
							})
					)
				}))
			};

			const env = {
				// null bucket triggers "image not found" → enters catch → triggers mark-failed
				PUZZLES_BUCKET: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
				PUZZLE_METADATA: createMockKv(sampleMetadata),
				PUZZLE_METADATA_DO: alwaysFailingDO as unknown as DurableObjectNamespace,
				PUZZLE_WORKFLOW: {} as Workflow
			} as unknown as Env;

			const workflow = new TestWorkflow();
			workflow.setEnv(env);

			const event: WorkflowEvent<WorkflowParams> = {
				payload: { puzzleId },
				timestamp: new Date(),
				instanceId: 'test-retry-instance'
			};

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// Set up the rejection handler before advancing timers to avoid unhandled rejection.
			const assertionPromise = expect(workflow.run(event, createMockStep())).rejects.toThrow(
				`Original image not found for puzzle ${puzzleId}`
			);

			// Advance timers to flush the exponential-backoff sleeps (100 ms + 200 ms)
			await vi.runAllTimersAsync();
			await assertionPromise;

			// CRITICAL error must have been logged after all retries failed.
			// The log call uses a single string argument (no second arg).
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining(`CRITICAL: Failed to mark puzzle ${puzzleId} as failed`)
			);

			consoleSpy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Workflow Execution - Multi-piece Grid', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('completes successfully for a 2x2 (4-piece) puzzle exercising edge helpers', async () => {
		const fourPieceMetadata: PuzzleMetadata = {
			...sampleMetadata,
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2
		};
		const puzzleId = fourPieceMetadata.id;

		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createMockKv(fourPieceMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).resolves.toBeUndefined();

		// Final DO call should mark puzzle as ready
		const calls = stub.fetch.mock.calls;
		const lastBody = JSON.parse((calls[calls.length - 1]?.[1]?.body as string | undefined) ?? '{}');
		expect(lastBody.updates.status).toBe('ready');

		// Piece uploads: row updates each send cols (2) pieces; 2 rows * 2 cols = 4 total
		const allPieces = calls.flatMap((c: [string, RequestInit?]) => {
			const b = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
			return b.updates?.pieces ?? [];
		});
		expect(allPieces).toHaveLength(fourPieceMetadata.pieceCount);
	});

	it('completes successfully for a 3x3 (9-piece) puzzle covering non-border edge types', async () => {
		const ninePieceMetadata: PuzzleMetadata = {
			...sampleMetadata,
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3
		};
		const puzzleId = ninePieceMetadata.id;

		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createMockKv(ninePieceMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).resolves.toBeUndefined();

		// Final DO call should mark puzzle as ready
		const calls = stub.fetch.mock.calls;
		const lastBody = JSON.parse((calls[calls.length - 1]?.[1]?.body as string | undefined) ?? '{}');
		expect(lastBody.updates.status).toBe('ready');

		// Piece uploads: row updates each send cols (3) pieces; 3 rows * 3 cols = 9 total
		const allPieces = calls.flatMap((c: [string, RequestInit?]) => {
			const b = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
			return b.updates?.pieces ?? [];
		});
		expect(allPieces).toHaveLength(ninePieceMetadata.pieceCount);
	});

	it('completes for a 2x3 (6-piece) non-square puzzle exercising getGridDimensions', async () => {
		// 6 pieces: getGridDimensions(6) → rows=2, cols=3 (non-square path)
		const sixPieceMetadata: PuzzleMetadata = {
			...sampleMetadata,
			pieceCount: 6,
			gridCols: 3,
			gridRows: 2
		};
		const puzzleId = sixPieceMetadata.id;

		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createMockKv(sixPieceMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).resolves.toBeUndefined();

		const calls = stub.fetch.mock.calls;
		const lastBody = JSON.parse((calls[calls.length - 1]?.[1]?.body as string | undefined) ?? '{}');
		expect(lastBody.updates.status).toBe('ready');

		// All 6 pieces should be generated across 2 rows × 3 cols
		const allPieces = calls.flatMap((c: [string, RequestInit?]) => {
			const b = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
			return b.updates?.pieces ?? [];
		});
		expect(allPieces).toHaveLength(sixPieceMetadata.pieceCount);
	});

	it('completes for a 1x7 (7-piece) puzzle where getGridDimensions falls back to 1 row', async () => {
		// 7 is prime: getGridDimensions(7) → rows=1, cols=7
		const sevenPieceMetadata: PuzzleMetadata = {
			...sampleMetadata,
			pieceCount: 7,
			gridCols: 7,
			gridRows: 1
		};
		const puzzleId = sevenPieceMetadata.id;

		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createMockKv(sevenPieceMetadata),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { puzzleId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).resolves.toBeUndefined();

		const calls = stub.fetch.mock.calls;
		const lastBody = JSON.parse((calls[calls.length - 1]?.[1]?.body as string | undefined) ?? '{}');
		expect(lastBody.updates.status).toBe('ready');

		// All 7 pieces should be generated in a single row
		const allPieces = calls.flatMap((c: [string, RequestInit?]) => {
			const b = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
			return b.updates?.pieces ?? [];
		});
		expect(allPieces).toHaveLength(sevenPieceMetadata.pieceCount);
	});
});
