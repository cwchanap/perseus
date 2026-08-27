import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerseusWorkflow } from './index';
import workflowWorker from './index';
import { MAX_IMAGE_BYTES, updateMetadata, padPixelsToTarget, applyMaskAlpha } from './helpers';
import type { PuzzleMetadata } from './types';
import { MAX_IMAGE_DIMENSION } from './types';
import type { Env } from './index';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowParams, PuzzleAspectRatio } from './types';
import {
	PUZZLE_DIFFICULTIES,
	getDifficultyPieceCount,
	getGridDimensionsForAspectRatio
} from './types';

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

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		setPuzzleFamilyStatus: vi.fn().mockResolvedValue(undefined)
	};
});

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
		// One-shot: execute the callback once and propagate its result/error.
		// Cloudflare owns the retry loop; tests assert our config and the
		// callback/outer-catch boundary, not platform attempt counts.
		do: vi.fn(async (_name: string, configOrFn: unknown, maybeFn?: unknown) => {
			const fn =
				typeof configOrFn === 'function'
					? (configOrFn as () => Promise<unknown>)
					: (maybeFn as () => Promise<unknown>);
			return await fn();
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

const familyId = '550e8400-e29b-41d4-a716-446655440000';
const variantIds = {
	easy: '550e8400-e29b-41d4-a716-446655440001',
	normal: '550e8400-e29b-41d4-a716-446655440002',
	hard: '550e8400-e29b-41d4-a716-446655440003'
};

const sampleFamilyMetadata = {
	id: familyId,
	name: 'Test Puzzle',
	aspectRatio: '1:1' as const,
	createdAt: 1700000000000,
	status: 'processing' as const,
	variants: variantIds
};

const sampleMetadata: PuzzleMetadata = {
	id: variantIds.easy,
	familyId,
	difficulty: 'easy',
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

function createFamilyMockKv(options?: { aspectRatio?: PuzzleAspectRatio }) {
	const aspectRatio = options?.aspectRatio ?? '1:1';
	const familyMeta = { ...sampleFamilyMetadata, aspectRatio };
	const variantStore: Record<string, PuzzleMetadata> = {};
	for (const difficulty of PUZZLE_DIFFICULTIES) {
		const variantId = variantIds[difficulty];
		const pieceCount = getDifficultyPieceCount(aspectRatio, difficulty);
		const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, aspectRatio);
		variantStore[variantId] = {
			id: variantId,
			familyId,
			difficulty,
			name: 'Test Puzzle',
			aspectRatio,
			pieceCount,
			gridCols: cols,
			gridRows: rows,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: 1700000000000,
			status: 'processing',
			version: 0,
			pieces: [],
			progress: {
				totalPieces: pieceCount,
				generatedPieces: 0,
				updatedAt: 1700000000000
			}
		};
	}
	return {
		get: vi.fn(async (key: string, type?: string) => {
			if (key === `family:${familyId}`) {
				const value = JSON.stringify(familyMeta);
				return type === 'json' ? JSON.parse(value) : value;
			}
			if (key.startsWith('puzzle:')) {
				const id = key.slice('puzzle:'.length);
				const meta = variantStore[id];
				if (!meta) return null;
				return type === 'json' ? meta : JSON.stringify(meta);
			}
			return null;
		}),
		put: vi.fn(async () => undefined)
	};
}

function totalPiecesForAspectRatio(aspectRatio: PuzzleAspectRatio): number {
	return PUZZLE_DIFFICULTIES.reduce(
		(sum, difficulty) => sum + getDifficultyPieceCount(aspectRatio, difficulty),
		0
	);
}

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
		const workflowFamilyId = familyId;
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
			familyId: familyId,
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;
		const step = createMockStep();
		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
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
		const workflowFamilyId = familyId;
		const oversizedBytes = new ArrayBuffer(MAX_IMAGE_BYTES + 1);
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(oversizedBytes),
			PUZZLE_METADATA: createFamilyMockKv(),
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
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, step)).rejects.toThrow(message);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body).toEqual({
			puzzleId: familyId,
			updates: {
				status: 'failed'
			}
		});
	});

	it('should reject images exceeding MAX_IMAGE_DIMENSION', async () => {
		const workflowFamilyId = familyId;
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
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;
		const step = createMockStep();
		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const message = `Image dimensions ${mockWidth}x${mockHeight} exceed maximum ${MAX_IMAGE_DIMENSION}px`;

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, step)).rejects.toThrow(message);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body).toEqual({
			puzzleId: familyId,
			updates: {
				status: 'failed'
			}
		});
	});

	it('rejects oversized valid-header images via the header pre-check BEFORE Photon decode', async () => {
		// Defense-in-depth: the decode-validate step parses dimensions from
		// the image header before calling PhotonImage.new_from_byteslice,
		// which would allocate the full decoded bitmap in WASM memory. A
		// pathologically large image that bypassed upload validation and
		// landed in R2 must be rejected without the expensive decode.
		//
		// mockWidth/mockHeight stay at 100 so the Photon post-decode check
		// would NOT reject — if this test throws with the header dimensions
		// (5000x5000), the pre-check caught it. PhotonImage.new_from_byteslice
		// must not have been called.
		const workflowFamilyId = familyId;
		// PNG with width=5000 (0x1388), height=5000 — exceeds MAX_IMAGE_DIMENSION (4096).
		// Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4) = 24 bytes.
		const oversizedPngHeader = new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a, // PNG signature
			0x00,
			0x00,
			0x00,
			0x0d, // IHDR chunk length = 13
			0x49,
			0x48,
			0x44,
			0x52, // "IHDR"
			0x00,
			0x00,
			0x13,
			0x88, // width = 5000
			0x00,
			0x00,
			0x13,
			0x88 // height = 5000
		]);
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(oversizedPngHeader.buffer),
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;
		const step = createMockStep();
		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const message = `Image dimensions 5000x5000 exceed maximum ${MAX_IMAGE_DIMENSION}px`;
		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		// Clear the Photon mock call history (vi.restoreAllMocks in afterEach
		// does not clear vi.fn history from module-level vi.mock factories, so
		// counts accumulate across tests in this suite).
		const { PhotonImage } = await import('@cf-wasm/photon');
		vi.mocked(PhotonImage.new_from_byteslice).mockClear();

		await expect(workflow.run(event, step)).rejects.toThrow(message);

		// The pre-check rejected before Photon decoded the bitmap.
		expect(vi.mocked(PhotonImage.new_from_byteslice)).not.toHaveBeenCalled();

		// The failure was mirrored to the DO as a failed status update.
		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body).toEqual({
			puzzleId: familyId,
			updates: {
				status: 'failed'
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
			payload: { familyId: 'not-a-uuid' },
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
			payload: { familyId: '' },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(
			workflow.run(event as WorkflowEvent<WorkflowParams>, createMockStep())
		).rejects.toThrow('Invalid workflow parameters');
	});
});

describe('Workflow Execution - Resource Loading', () => {
	afterEach(async () => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
		// vi.restoreAllMocks does not restore vi.fn mocks created in vi.mock
		// factories, so a mockRejectedValue from one test leaks into the next.
		// Reset setPuzzleFamilyStatus to its factory default (resolves undefined).
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		vi.mocked(setPuzzleFamilyStatus).mockReset();
		vi.mocked(setPuzzleFamilyStatus).mockResolvedValue(undefined);
	});

	it('marks puzzle as failed when metadata not found', async () => {
		const workflowFamilyId = familyId;
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
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).rejects.toThrow('not found');

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body.updates.status).toBe('failed');
	});

	it('marks puzzle as failed when original image not found in R2', async () => {
		const workflowFamilyId = familyId;
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
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).rejects.toThrow(
			`Original image not found for family ${workflowFamilyId}`
		);

		expect(stub.fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body.updates.status).toBe('failed');
	});

	it('mirrors the failed status into D1 on mark-failed (keeps stores in sync)', async () => {
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		vi.mocked(setPuzzleFamilyStatus).mockClear();
		const workflowFamilyId = familyId;
		const { namespace } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const nullBucket = {
			get: vi.fn(async () => null), // image not in R2 -> failure path
			put: vi.fn(async () => undefined)
		};
		const env = {
			PUZZLES_BUCKET: nullBucket,
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		const step = createMockStep();
		await expect(workflow.run(event, step)).rejects.toThrow(
			`Original image not found for family ${workflowFamilyId}`
		);

		expect(setPuzzleFamilyStatus).toHaveBeenCalledWith(
			expect.anything(),
			workflowFamilyId,
			'failed'
		);
		expect(step.do).toHaveBeenCalledWith(
			'mirror-family-failed-status-to-d1',
			{
				retries: {
					limit: 3,
					delay: '10 seconds',
					backoff: 'exponential'
				}
			},
			expect.any(Function)
		);
	});

	it('keeps the original processing error authoritative when D1 down', async () => {
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		const workflowFamilyId = familyId;
		const { namespace } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const nullBucket = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => undefined)
		};
		const env = {
			PUZZLES_BUCKET: nullBucket,
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		const step = createMockStep();
		vi.mocked(setPuzzleFamilyStatus).mockReset();
		// One-shot mock: the callback runs once, rejects, and step.do throws
		// so the rejection reaches mirrorPuzzleStatusToD1()'s outer catch.
		vi.mocked(setPuzzleFamilyStatus).mockRejectedValue(new Error('D1 down'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(workflow.run(event, step)).rejects.toThrow(
			`Original image not found for family ${workflowFamilyId}`
		);

		// The D1 mirror callback ran once and rejected; the outer wrapper
		// catch logged the site-aware final error and swallowed it, so the
		// workflow still rejects with the original processing error.
		expect(setPuzzleFamilyStatus).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('D1 mirror mirror-family-failed-status-to-d1 failed'),
			expect.any(Error)
		);
		// Verify no CRITICAL log fired regardless of argument count — the
		// not.toHaveBeenCalledWith matcher only checks calls whose arg count
		// matches the matchers, so a future multi-arg CRITICAL log would slip
		// through. Flatten every argument of every call instead.
		const allErrorArgs = errorSpy.mock.calls.flat() as unknown[];
		expect(allErrorArgs.some((arg) => typeof arg === 'string' && arg.includes('CRITICAL'))).toBe(
			false
		);
	});
});

describe('Workflow Execution - D1 ready mirror is best-effort', () => {
	afterEach(async () => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
		// vi.restoreAllMocks does not restore vi.fn mocks created in vi.mock
		// factories, so a mockRejectedValue from one test leaks into the next.
		// Reset setPuzzleFamilyStatus to its factory default (resolves undefined).
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		vi.mocked(setPuzzleFamilyStatus).mockReset();
		vi.mocked(setPuzzleFamilyStatus).mockResolvedValue(undefined);
	});

	it('keeps DO status ready and does NOT mark-failed when the D1 ready mirror throws', async () => {
		const workflowFamilyId = familyId;

		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			familyId: familyId,
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		// Force the D1 ready mirror to reject. The one-shot mock runs the
		// callback once and propagates the rejection to
		// mirrorPuzzleStatusToD1()'s outer catch. The old code ran the mirror
		// inside the finalize step.do, so this throw would land in the catch
		// and run mark-failed, overwriting 'ready' with 'failed'. The split
		// must keep the DO 'ready' and merely log the D1 failure.
		const step = createMockStep();
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		vi.mocked(setPuzzleFamilyStatus).mockReset();
		vi.mocked(setPuzzleFamilyStatus).mockRejectedValue(new Error('D1 down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// Workflow must complete despite the D1 mirror failure.
		await expect(workflow.run(event, step)).resolves.toBeUndefined();

		// The D1 ready mirror callback ran once and rejected; the outer
		// wrapper catch logged and swallowed it, best-effort.
		expect(setPuzzleFamilyStatus).toHaveBeenCalledTimes(1);
		expect(setPuzzleFamilyStatus).toHaveBeenCalledWith(
			expect.anything(),
			workflowFamilyId,
			'ready'
		);
		// mark-failed must NOT have run — no 'failed' status written anywhere.
		expect(setPuzzleFamilyStatus).not.toHaveBeenCalledWith(
			expect.anything(),
			workflowFamilyId,
			'failed'
		);

		// The last DO updateMetadata must be 'ready', not 'failed'.
		const calls = stub.fetch.mock.calls;
		const lastBody = JSON.parse((calls[calls.length - 1]?.[1]?.body as string | undefined) ?? '{}');
		expect(lastBody.updates.status).toBe('ready');

		// The D1 mirror is an explicitly bounded durable step.
		expect(step.do).toHaveBeenCalledWith(
			'mirror-family-ready-status-to-d1',
			{
				retries: {
					limit: 3,
					delay: '10 seconds',
					backoff: 'exponential'
				}
			},
			expect.any(Function)
		);

		// The D1 mirror failure was logged with its site.
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('D1 mirror mirror-family-ready-status-to-d1 failed'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
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
			const workflowFamilyId = familyId;
			const { setPuzzleFamilyStatus } = await import('@perseus/shared');
			vi.mocked(setPuzzleFamilyStatus).mockClear();

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
				PUZZLE_METADATA: createFamilyMockKv(),
				PUZZLE_METADATA_DO: alwaysFailingDO as unknown as DurableObjectNamespace,
				PUZZLE_WORKFLOW: {} as Workflow
			} as unknown as Env;

			const workflow = new TestWorkflow();
			workflow.setEnv(env);

			const event: WorkflowEvent<WorkflowParams> = {
				payload: { familyId },
				timestamp: new Date(),
				instanceId: 'test-retry-instance'
			};

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// Set up the rejection handler before advancing timers to avoid unhandled rejection.
			const assertionPromise = expect(workflow.run(event, createMockStep())).rejects.toThrow(
				`Original image not found for family ${workflowFamilyId}`
			);

			// Advance timers to flush the exponential-backoff sleeps (100 ms + 200 ms)
			await vi.runAllTimersAsync();
			await assertionPromise;

			// No terminal D1 mirror is allowed when the authoritative DO status is
			// unreconciled after mark-failed retry exhaustion.
			expect(setPuzzleFamilyStatus).not.toHaveBeenCalled();

			// CRITICAL error must have been logged after all retries failed.
			// The log call uses a single string argument (no second arg).
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining(`CRITICAL: Failed to mark family ${workflowFamilyId} as failed`)
			);

			consoleSpy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Workflow Execution - mark-failed already-ready reconciliation', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('reconciles D1 to ready and skips CRITICAL when the DO refuses ready → failed (409)', async () => {
		const workflowFamilyId = familyId;
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		vi.mocked(setPuzzleFamilyStatus).mockClear();

		// DO returns 409 for a failed-status update (simulating the DO's
		// ready → failed refusal after finalize already committed 'ready'),
		// and 200 for every other update (dimensions, progress, ready).
		const { namespace } = createMockDurableObjectNamespace((body) => {
			if (body.updates?.status === 'failed') {
				return new Response(
					JSON.stringify({
						message: `Puzzle ${familyId} is already ready; refusing transition to failed`
					}),
					{ status: 409 }
				);
			}
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		});

		// null bucket → "image not found" in decode-validate → catch → mark-failed
		const env = {
			PUZZLES_BUCKET: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
			PUZZLE_METADATA: createFamilyMockKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-already-ready'
		};

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const step = createMockStep();
		await expect(workflow.run(event, step)).rejects.toThrow(
			`Original image not found for family ${workflowFamilyId}`
		);

		// mark-failed hit the 409 already-ready path: it must reconcile D1 to
		// 'ready' (the puzzle's true terminal state), never 'failed'.
		expect(setPuzzleFamilyStatus).toHaveBeenCalledWith(
			expect.anything(),
			workflowFamilyId,
			'ready'
		);
		expect(setPuzzleFamilyStatus).not.toHaveBeenCalledWith(
			expect.anything(),
			workflowFamilyId,
			'failed'
		);
		expect(step.do).toHaveBeenCalledWith(
			'reconcile-family-already-ready-status-to-d1',
			{
				retries: {
					limit: 3,
					delay: '10 seconds',
					backoff: 'exponential'
				}
			},
			expect.any(Function)
		);

		// No CRITICAL log — the puzzle is in the desired terminal state, so
		// the retry-exhaustion alarm must not fire. Check every argument of
		// every call (not just single-arg calls) so a future multi-arg
		// CRITICAL log cannot slip through the matcher.
		const allErrorArgs = errorSpy.mock.calls.flat() as unknown[];
		expect(allErrorArgs.some((arg) => typeof arg === 'string' && arg.includes('CRITICAL'))).toBe(
			false
		);
		// A warn surfaces the already-ready skip so the race is observable.
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already ready'));

		errorSpy.mockRestore();
		warnSpy.mockRestore();
	});
});

describe('Workflow Execution - Multi-piece Grid', () => {
	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('completes all three 1:1 difficulty variants and marks family ready', async () => {
		const aspectRatio: PuzzleAspectRatio = '1:1';
		const easyCount = getDifficultyPieceCount(aspectRatio, 'easy');
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createFamilyMockKv({ aspectRatio }),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).resolves.toBeUndefined();

		const calls = stub.fetch.mock.calls;
		const lastBody = JSON.parse((calls[calls.length - 1]?.[1]?.body as string | undefined) ?? '{}');
		expect(lastBody.puzzleId).toBe(familyId);
		expect(lastBody.updates.status).toBe('ready');

		const allPieces = calls.flatMap((c: [string, RequestInit?]) => {
			const b = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
			return b.updates?.pieces ?? [];
		});
		expect(allPieces).toHaveLength(totalPiecesForAspectRatio(aspectRatio));

		const easyPieces = allPieces.filter(
			(p: { puzzleId?: string }) => p.puzzleId === variantIds.easy
		);
		expect(easyPieces).toHaveLength(easyCount);
	});

	it('generates portrait 3:4 grids for all difficulties', async () => {
		const aspectRatio: PuzzleAspectRatio = '3:4';
		const portraitCount = getDifficultyPieceCount(aspectRatio, 'normal');
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createFamilyMockKv({ aspectRatio }),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).resolves.toBeUndefined();

		const normalPieces = stub.fetch.mock.calls
			.flatMap((c: [string, RequestInit?]) => {
				const b = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
				return (b.updates?.pieces as Array<{ puzzleId?: string }> | undefined) ?? [];
			})
			.filter((p) => p.puzzleId === variantIds.normal);
		expect(normalPieces).toHaveLength(portraitCount);
	});

	it('marks family failed when family metadata is missing from KV', async () => {
		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: { get: vi.fn(async () => null) },
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow
		} as unknown as Env;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-instance'
		};

		await expect(workflow.run(event, createMockStep())).rejects.toThrow('not found');

		const body = JSON.parse((stub.fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? '{}');
		expect(body.puzzleId).toBe(familyId);
		expect(body.updates.status).toBe('failed');
	});
});

describe('Family workflow checkpoint names', () => {
	const familyId = '550e8400-e29b-41d4-a716-446655440000';
	const variantIds = {
		easy: '550e8400-e29b-41d4-a716-446655440001',
		normal: '550e8400-e29b-41d4-a716-446655440002',
		hard: '550e8400-e29b-41d4-a716-446655440003'
	};

	const familyMetadata = {
		id: familyId,
		name: 'Test Family',
		aspectRatio: '4:3' as const,
		createdAt: 1700000000000,
		status: 'processing' as const,
		variants: variantIds
	};

	function createFamilyKv() {
		const variantStore: Record<string, PuzzleMetadata> = {};
		for (const difficulty of ['easy', 'normal', 'hard'] as const) {
			const variantId = variantIds[difficulty];
			variantStore[variantId] = {
				id: variantId,
				familyId,
				difficulty,
				name: 'Test Family',
				aspectRatio: '4:3',
				pieceCount: difficulty === 'easy' ? 12 : difficulty === 'normal' ? 48 : 108,
				gridCols: difficulty === 'easy' ? 4 : difficulty === 'normal' ? 8 : 12,
				gridRows: difficulty === 'easy' ? 3 : difficulty === 'normal' ? 6 : 9,
				imageWidth: 0,
				imageHeight: 0,
				createdAt: 1700000000000,
				status: 'processing',
				version: 0,
				pieces: [],
				progress: {
					totalPieces: difficulty === 'easy' ? 12 : difficulty === 'normal' ? 48 : 108,
					generatedPieces: 0,
					updatedAt: 1700000000000
				}
			};
		}
		return {
			get: vi.fn(async (key: string, type?: string) => {
				if (key === `family:${familyId}`) {
					const value = JSON.stringify(familyMetadata);
					return type === 'json' ? JSON.parse(value) : value;
				}
				if (key.startsWith('puzzle:')) {
					const id = key.slice('puzzle:'.length);
					const meta = variantStore[id];
					if (!meta) return null;
					return type === 'json' ? meta : JSON.stringify(meta);
				}
				return null;
			}),
			put: vi.fn(async () => undefined)
		};
	}

	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('uses difficulty-qualified checkpoint names for three variants', async () => {
		const { namespace } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const env = {
			PUZZLES_BUCKET: createMockBucket(new ArrayBuffer(8)),
			PUZZLE_METADATA: createFamilyKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow,
			DB: {} as D1Database
		} as unknown as Env;

		const stepNames: string[] = [];
		const step = {
			do: vi.fn(async (name: string, configOrFn: unknown, maybeFn?: unknown) => {
				stepNames.push(name);
				const fn =
					typeof configOrFn === 'function'
						? (configOrFn as () => Promise<unknown>)
						: (maybeFn as () => Promise<unknown>);
				return await fn();
			}),
			sleep: vi.fn(async () => undefined),
			sleepUntil: vi.fn(async () => undefined),
			waitForEvent: vi.fn(async () => ({
				payload: {},
				timestamp: new Date(),
				type: 'event'
			}))
		} as WorkflowStep;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-family-instance'
		};

		await workflow.run(event, step);

		expect(stepNames).toContain('generate-easy-row-0');
		expect(stepNames).toContain('finalize-easy');
		expect(stepNames).toContain('generate-normal-row-0');
		expect(stepNames).toContain('finalize-normal');
		expect(stepNames).toContain('generate-hard-row-0');
		expect(stepNames).toContain('finalize-hard');
		expect(stepNames).toContain('finalize-family');

		const rowNames = stepNames.filter(
			(name) => name.startsWith('generate-') && name.includes('-row-')
		);
		const uniqueRowNames = new Set(rowNames);
		expect(uniqueRowNames.size).toBe(rowNames.length);
	});
});

describe('Family workflow status rollup when one difficulty fails', () => {
	const familyId = '550e8400-e29b-41d4-a716-446655440000';
	const variantIds = {
		easy: '550e8400-e29b-41d4-a716-446655440001',
		normal: '550e8400-e29b-41d4-a716-446655440002',
		hard: '550e8400-e29b-41d4-a716-446655440003'
	};

	const familyMetadata = {
		id: familyId,
		name: 'Test Family',
		aspectRatio: '1:1' as const,
		createdAt: 1700000000000,
		status: 'processing' as const,
		variants: variantIds
	};

	function createFamilyKv() {
		const variantStore: Record<string, PuzzleMetadata> = {};
		for (const difficulty of ['easy', 'normal', 'hard'] as const) {
			const variantId = variantIds[difficulty];
			const pieceCount = getDifficultyPieceCount('1:1', difficulty);
			const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, '1:1');
			variantStore[variantId] = {
				id: variantId,
				familyId,
				difficulty,
				name: 'Test Family',
				aspectRatio: '1:1',
				pieceCount,
				gridCols: cols,
				gridRows: rows,
				imageWidth: 0,
				imageHeight: 0,
				createdAt: 1700000000000,
				status: 'processing',
				version: 0,
				pieces: [],
				progress: {
					totalPieces: pieceCount,
					generatedPieces: 0,
					updatedAt: 1700000000000
				}
			};
		}
		return {
			get: vi.fn(async (key: string, type?: string) => {
				if (key === `family:${familyId}`) {
					const value = JSON.stringify(familyMetadata);
					return type === 'json' ? JSON.parse(value) : value;
				}
				if (key.startsWith('puzzle:')) {
					const id = key.slice('puzzle:'.length);
					const meta = variantStore[id];
					if (!meta) return null;
					return type === 'json' ? meta : JSON.stringify(meta);
				}
				return null;
			}),
			put: vi.fn(async () => undefined)
		};
	}

	afterEach(() => {
		mockWidth = 100;
		mockHeight = 100;
		photonInstances = [];
		vi.restoreAllMocks();
	});

	it('continues sibling difficulties, keeps their assets, and marks family failed', async () => {
		const { setPuzzleFamilyStatus } = await import('@perseus/shared');
		vi.mocked(setPuzzleFamilyStatus).mockClear();

		const putKeys: string[] = [];
		const bucket = createMockBucket(new ArrayBuffer(8));
		bucket.put = vi.fn(async (...args: unknown[]) => {
			putKeys.push(String(args[0]));
		});

		const { namespace, stub } = createMockDurableObjectNamespace(() => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});

		const env = {
			PUZZLES_BUCKET: bucket,
			PUZZLE_METADATA: createFamilyKv(),
			PUZZLE_METADATA_DO: namespace as unknown as DurableObjectNamespace,
			PUZZLE_WORKFLOW: {} as Workflow,
			DB: {} as D1Database
		} as unknown as Env;

		const stepNames: string[] = [];
		const step = {
			do: vi.fn(async (name: string, configOrFn: unknown, maybeFn?: unknown) => {
				stepNames.push(name);
				if (name === 'generate-easy-row-0') {
					throw new Error('easy generation failed');
				}
				const fn =
					typeof configOrFn === 'function'
						? (configOrFn as () => Promise<unknown>)
						: (maybeFn as () => Promise<unknown>);
				return await fn();
			}),
			sleep: vi.fn(async () => undefined),
			sleepUntil: vi.fn(async () => undefined),
			waitForEvent: vi.fn(async () => ({
				payload: {},
				timestamp: new Date(),
				type: 'event'
			}))
		} as WorkflowStep;

		const workflow = new TestWorkflow();
		workflow.setEnv(env);

		const event: WorkflowEvent<WorkflowParams> = {
			payload: { familyId },
			timestamp: new Date(),
			instanceId: 'test-family-rollup'
		};

		await expect(workflow.run(event, step)).resolves.toBeUndefined();

		expect(stepNames).toContain('mark-easy-failed');
		expect(stepNames).toContain('generate-normal-row-0');
		expect(stepNames).toContain('finalize-normal');
		expect(stepNames).toContain('generate-hard-row-0');
		expect(stepNames).toContain('finalize-hard');
		expect(stepNames).toContain('finalize-family');
		expect(stepNames).not.toContain('finalize-easy');

		const familyFinalizeBody = JSON.parse(
			(stub.fetch.mock.calls.find((c: [string, RequestInit?]) => {
				const body = JSON.parse((c[1]?.body as string | undefined) ?? '{}');
				return body.puzzleId === familyId && body.updates?.status === 'failed';
			})?.[1]?.body as string | undefined) ?? '{}'
		);
		expect(familyFinalizeBody.updates.status).toBe('failed');

		const normalPiecePuts = putKeys.filter(
			(key) => key.includes(`/pieces/`) && key.includes(variantIds.normal)
		);
		const hardPiecePuts = putKeys.filter(
			(key) => key.includes(`/pieces/`) && key.includes(variantIds.hard)
		);
		expect(normalPiecePuts.length).toBeGreaterThan(0);
		expect(hardPiecePuts.length).toBeGreaterThan(0);

		expect(setPuzzleFamilyStatus).toHaveBeenCalledWith(expect.anything(), familyId, 'failed');
		expect(step.do).toHaveBeenCalledWith(
			'mirror-family-failed-status-to-d1',
			{
				retries: {
					limit: 3,
					delay: '10 seconds',
					backoff: 'exponential'
				}
			},
			expect.any(Function)
		);
	});
});
