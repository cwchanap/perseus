import { describe, expect, it, vi } from 'vitest';
import {
	commitIdempotencyKey,
	failIdempotencyKey,
	originalImageExists,
	releaseIdempotencyKey,
	reserveIdempotencyKey
} from './storage.worker';

const FAMILY_ID = '123e4567-e89b-42d3-a456-426614174001';

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
						familyId: FAMILY_ID,
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
			FAMILY_ID
		);

		expect(namespace.idFromName).toHaveBeenCalledWith('request-1');
		expect(result).toEqual({
			existing: false,
			familyId: FAMILY_ID,
			status: 'pending'
		});
		expect(stub.fetch).toHaveBeenCalledWith('https://puzzle-metadata/reserve', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				idempotencyKey: 'request-1',
				familyId: FAMILY_ID
			})
		});
	});

	it('rejects a successful reserve response without a family id', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ existing: true, status: 'pending' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', FAMILY_ID)
		).rejects.toThrow('Reserve response missing familyId');
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
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', FAMILY_ID)
		).rejects.toThrow('reservation conflict');
	});

	it('sends commit, fail, and release lifecycle transitions', async () => {
		const { namespace, stub } = createMockDurableObjectNamespace(
			() => new Response(null, { status: 204 })
		);
		const durableNamespace = namespace as unknown as DurableObjectNamespace;

		await commitIdempotencyKey(durableNamespace, 'request-1', FAMILY_ID);
		await failIdempotencyKey(durableNamespace, 'request-1', FAMILY_ID);
		await releaseIdempotencyKey(durableNamespace, 'request-1', FAMILY_ID);

		expect(stub.fetch.mock.calls.map(([url]) => url)).toEqual([
			'https://puzzle-metadata/commit',
			'https://puzzle-metadata/fail',
			'https://puzzle-metadata/release'
		]);
		for (const [, init] of stub.fetch.mock.calls) {
			expect(init).toEqual({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ familyId: FAMILY_ID })
			});
		}
	});

	it('treats missing fail and release reservations as successful cleanup', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() => new Response(null, { status: 404 })
		);
		const durableNamespace = namespace as unknown as DurableObjectNamespace;

		await expect(
			failIdempotencyKey(durableNamespace, 'request-1', FAMILY_ID)
		).resolves.toBeUndefined();
		await expect(
			releaseIdempotencyKey(durableNamespace, 'request-1', FAMILY_ID)
		).resolves.toBeUndefined();
	});

	it('does not ignore a missing reservation when committing', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() => new Response(null, { status: 404 })
		);

		await expect(
			commitIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', FAMILY_ID)
		).rejects.toThrow('Failed to commit idempotency key (HTTP 404)');
	});
});

describe('originalImageExists', () => {
	it('returns true when R2 contains the original image object', async () => {
		const bucket = {
			head: vi.fn(async () => ({ key: `families/${FAMILY_ID}/original` }))
		};

		await expect(originalImageExists(bucket as unknown as R2Bucket, FAMILY_ID)).resolves.toBe(true);
		expect(bucket.head).toHaveBeenCalledWith(`families/${FAMILY_ID}/original`);
	});

	it('returns false when the original image object is absent', async () => {
		const bucket = {
			head: vi.fn(async () => null)
		};

		await expect(originalImageExists(bucket as unknown as R2Bucket, FAMILY_ID)).resolves.toBe(
			false
		);
	});

	it('propagates R2 head errors instead of swallowing them as "absent"', async () => {
		const bucket = {
			head: vi.fn(async () => {
				throw new Error('R2 unavailable');
			})
		};

		await expect(originalImageExists(bucket as unknown as R2Bucket, FAMILY_ID)).rejects.toThrow(
			'R2 unavailable'
		);
	});
});
