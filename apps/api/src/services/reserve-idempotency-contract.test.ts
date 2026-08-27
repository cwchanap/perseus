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

const NEW_FAMILY = '123e4567-e89b-42d3-a456-426614174001';
const HELD_FAMILY = '223e4567-e89b-42d3-a456-426614174002';
const COMMITTED_FAMILY = '323e4567-e89b-42d3-a456-426614174003';
const LIVE_FAMILY = '423e4567-e89b-42d3-a456-426614174004';

/** Fixtures matching PuzzleMetadataDO.handleReserve Response.json(...) shapes. */
const DO_RESERVE_FIXTURES = [
	{
		name: 'first claim',
		familyId: NEW_FAMILY,
		body: {
			existing: false,
			familyId: NEW_FAMILY,
			puzzleId: NEW_FAMILY,
			status: 'pending' as const
		}
	},
	{
		name: 'existing pending',
		familyId: HELD_FAMILY,
		body: {
			existing: true,
			familyId: HELD_FAMILY,
			puzzleId: HELD_FAMILY,
			status: 'pending' as const
		}
	},
	{
		name: 'existing committed',
		familyId: COMMITTED_FAMILY,
		body: {
			existing: true,
			familyId: COMMITTED_FAMILY,
			puzzleId: COMMITTED_FAMILY,
			status: 'committed' as const
		}
	},
	{
		name: 'promoted stale-pending',
		familyId: LIVE_FAMILY,
		body: {
			existing: true,
			familyId: LIVE_FAMILY,
			puzzleId: LIVE_FAMILY,
			status: 'committed' as const
		}
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
				fixture.familyId
			);

			expect(namespace.idFromName).toHaveBeenCalledWith('request-1');
			expect(stub.fetch).toHaveBeenCalledWith('https://puzzle-metadata/reserve', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					idempotencyKey: 'request-1',
					familyId: fixture.familyId
				})
			});
			expect(result).toEqual({
				existing: fixture.body.existing,
				familyId: fixture.familyId,
				status: fixture.body.status
			});
		});
	}

	it('rejects a response missing familyId (client throw path)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ existing: true, status: 'pending' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', NEW_FAMILY)
		).rejects.toThrow(/missing familyId/);
	});

	it('treats missing existing as false (first-claim without the field)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ familyId: NEW_FAMILY, status: 'pending' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		const result = await reserveIdempotencyKey(
			namespace as unknown as DurableObjectNamespace,
			'request-1',
			NEW_FAMILY
		);

		expect(result.existing).toBe(false);
		expect(result.familyId).toBe(NEW_FAMILY);
	});

	it('omits status when DO does not send one (legacy)', async () => {
		const { namespace } = createMockDurableObjectNamespace(
			() =>
				new Response(JSON.stringify({ existing: true, familyId: LIVE_FAMILY }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		const result = await reserveIdempotencyKey(
			namespace as unknown as DurableObjectNamespace,
			'request-1',
			LIVE_FAMILY
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
			reserveIdempotencyKey(namespace as unknown as DurableObjectNamespace, 'request-1', NEW_FAMILY)
		).rejects.toThrow('reservation conflict');
	});
});
