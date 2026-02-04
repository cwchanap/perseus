import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	updateMetadata,
	PerseusWorkflow,
	MAX_IMAGE_BYTES,
	padPixelsToTarget,
	applyMaskAlpha
} from './index';
import type { PuzzleMetadata } from './types';
import { MAX_IMAGE_DIMENSION } from './types';
import type { Env } from './index';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowParams } from './types';

let mockWidth = 100;
let mockHeight = 100;

vi.mock('@cf-wasm/photon', () => ({
	PhotonImage: {
		new_from_byteslice: vi.fn(() => ({
			get_width: () => mockWidth,
			get_height: () => mockHeight,
			free: vi.fn()
		}))
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
		}))
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
		this.env = env;
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
