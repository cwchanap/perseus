/**
 * Contract test: the Worker client's reserveIdempotencyKey parser and the
 * PuzzleMetadataDO /reserve response shape must agree. Handler tests mock the
 * client return type; DO tests prove the DO — nothing else enforces they match.
 *
 * This file drives the REAL reserveIdempotencyKey client against fixtures that
 * mirror the DO's Response.json payloads (see apps/workflows
 * PuzzleMetadataDO.handleReserve), using the same mocked-DO-namespace pattern
 * as storage-idempotency.worker.test.ts. If the client's parser drifts from the
 * DO's response shape, these tests fail instead of a hand-copied parser
 * silently passing.
 */
import { describe, it, expect, vi } from 'vitest';
import { reserveIdempotencyKey } from './storage.worker';

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

/** Fixtures matching PuzzleMetadataDO.handleReserve Response.json(...) shapes. */
const DO_RESERVE_FIXTURES = [
	{
		name: 'first claim',
		body: { existing: false, puzzleId: 'new-uuid', status: 'pending' as const }
	},
	{
		name: 'existing pending',
		body: { existing: true, puzzleId: 'held-uuid', status: 'pending' as const }
	},
	{
		name: 'existing committed',
		body: { existing: true, puzzleId: 'committed-uuid', status: 'committed' as const }
	},
	{
		name: 'promoted stale-pending',
		body: { existing: true, puzzleId: 'live-uuid', status: 'committed' as const }
	}
] as const;

describe('reserveIdempotencyKey client ↔ DO contract', () => {
	for (const fixture of DO_RESERVE_FIXTURES) {
		it(`parses DO ${fixture.name} response`, async () => {
			const { namespace, stub } = createMockDurableObjectNamespace(
				() =>
					new Response(JSON.stringify(fixture.body), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
			);

			const result = await reserveIdempotencyKey(
				namespace as unknown as DurableObjectNamespace,
				'request-1',
				fixture.body.puzzleId
			);

			expect(namespace.idFromName).toHaveBeenCalledWith('request-1');
			expect(stub.fetch).toHaveBeenCalledWith('https://puzzle-metadata/reserve', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					idempotencyKey: 'request-1',
					puzzleId: fixture.body.puzzleId
				})
			});
			expect(result).toEqual({
				existing: fixture.body.existing,
				puzzleId: fixture.body.puzzleId,
				status: fixture.body.status
			});
		});
	}

	it('rejects a response missing puzzleId (client throw path)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ existing: true, status: 'pending' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', 'p1')
		).rejects.toThrow(/missing puzzleId/);
	});

	it('treats missing existing as false (first-claim without the field)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ puzzleId: 'p1', status: 'pending' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		const result = await reserveIdempotencyKey(
			namespace as unknown as DurableObjectNamespace,
			'request-1',
			'p1'
		);

		expect(result.existing).toBe(false);
		expect(result.puzzleId).toBe('p1');
	});

	it('omits status when DO does not send one (legacy)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ existing: true, puzzleId: 'legacy' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		const result = await reserveIdempotencyKey(
			namespace as unknown as DurableObjectNamespace,
			'request-1',
			'legacy'
		);

		expect(result.status).toBeUndefined();
		expect(result.existing).toBe(true);
	});

	it('surfaces a DO error response (non-ok status)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ message: 'reservation conflict' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', 'p1')
		).rejects.toThrow('reservation conflict');
	});
});
