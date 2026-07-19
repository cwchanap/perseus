import { describe, expect, it, vi } from 'vitest';
import {
	commitIdempotencyKey,
	failIdempotencyKey,
	originalImageExists,
	releaseIdempotencyKey,
	reserveIdempotencyKey
} from './storage.worker';

function createMockDurableObjectNamespace(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
	const stub = {
		fetch: vi.fn(handler)
	};
	const namespace = {
		idFromName: vi.fn((name: string) => name),
		get: vi.fn(() => stub)
	};

	return { namespace, stub };
}

describe('worker idempotency storage operations', () => {
	it('reserves an idempotency key through the keyed Durable Object', async () => {
		const { namespace, stub } = createMockDurableObjectNamespace(
			() =>
				new Response(
					JSON.stringify({
						existing: false,
						puzzleId: 'puzzle-1',
						status: 'pending'
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
		);

		const result = await reserveIdempotencyKey(
			namespace as unknown as DurableObjectNamespace,
			'request-1',
			'puzzle-1'
		);

		expect(namespace.idFromName).toHaveBeenCalledWith('request-1');
		expect(result).toEqual({
			existing: false,
			puzzleId: 'puzzle-1',
			status: 'pending'
		});
		expect(stub.fetch).toHaveBeenCalledWith('https://puzzle-metadata/reserve', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				idempotencyKey: 'request-1',
				puzzleId: 'puzzle-1'
			})
		});
	});

	it('rejects a successful reserve response without a puzzle id', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ existing: true, status: 'pending' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', 'puzzle-1')
		).rejects.toThrow('Reserve response missing puzzleId');
	});

	it('surfaces the Durable Object reserve error message', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ message: 'reservation conflict' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', 'puzzle-1')
		).rejects.toThrow('reservation conflict');
	});

	it('sends commit, fail, and release lifecycle transitions', async () => {
		const { namespace, stub } = createMockDurableObjectNamespace(
			() => new Response(null, { status: 204 })
		);
		const durableNamespace = namespace as unknown as DurableObjectNamespace;

		await commitIdempotencyKey(durableNamespace, 'request-1', 'puzzle-1');
		await failIdempotencyKey(durableNamespace, 'request-1', 'puzzle-1');
		await releaseIdempotencyKey(durableNamespace, 'request-1', 'puzzle-1');

		expect(stub.fetch.mock.calls.map(([url]) => url)).toEqual([
			'https://puzzle-metadata/commit',
			'https://puzzle-metadata/fail',
			'https://puzzle-metadata/release'
		]);
		for (const [, init] of stub.fetch.mock.calls) {
			expect(init).toEqual({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ puzzleId: 'puzzle-1' })
			});
		}
	});

	it('treats missing fail and release reservations as successful cleanup', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() => new Response(null, { status: 404 })
		);
		const durableNamespace = namespace as unknown as DurableObjectNamespace;

		await expect(
			failIdempotencyKey(durableNamespace, 'request-1', 'puzzle-1')
		).resolves.toBeUndefined();
		await expect(
			releaseIdempotencyKey(durableNamespace, 'request-1', 'puzzle-1')
		).resolves.toBeUndefined();
	});

	it('does not ignore a missing reservation when committing', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() => new Response(null, { status: 404 })
		);

		await expect(
			commitIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', 'puzzle-1')
		).rejects.toThrow('Failed to commit idempotency key (HTTP 404)');
	});
});

describe('originalImageExists', () => {
	it('returns true when R2 contains the original image object', async () => {
		const bucket = {
			head: vi.fn(async () => ({ key: 'puzzles/puzzle-1/original' }))
		};

		await expect(originalImageExists(bucket as unknown as R2Bucket, 'puzzle-1')).resolves.toBe(
			true
		);
		expect(bucket.head).toHaveBeenCalledWith('puzzles/puzzle-1/original');
	});

	it('returns false when the original image object is absent', async () => {
		const bucket = {
			head: vi.fn(async () => null)
		};

		await expect(
			originalImageExists(bucket as unknown as R2Bucket, 'missing-puzzle')
		).resolves.toBe(false);
		expect(bucket.head).toHaveBeenCalledWith('puzzles/missing-puzzle/original');
	});

	it('propagates R2 head errors instead of swallowing them as "absent"', async () => {
		// Contract: a transient R2 `head` failure must NOT be interpreted as
		// "object gone" — callers use the result to decide whether to release
		// an idempotency reservation, and treating a transient failure as
		// absent would mint a duplicate of a live puzzle. The error must
		// propagate so callers can return 409 (transient) for a client retry.
		const r2Error = new Error('R2 internal error');
		const bucket = {
			head: vi.fn(async () => {
				throw r2Error;
			})
		};

		await expect(originalImageExists(bucket as unknown as R2Bucket, 'puzzle-1')).rejects.toThrow(
			r2Error
		);
		expect(bucket.head).toHaveBeenCalledWith('puzzles/puzzle-1/original');
	});
});
