import { describe, it, expect, vi } from 'vitest';
import { updateMetadata } from './index';
import type { PuzzleMetadata } from './types';

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
