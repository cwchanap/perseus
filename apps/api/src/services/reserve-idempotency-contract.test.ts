/**
 * Contract test: the Worker client's reserveIdempotencyKey parser and the
 * PuzzleMetadataDO /reserve response shape must agree. Handler tests mock the
 * client return type; DO tests prove the DO — nothing else enforces they match.
 *
 * This file re-implements the client's parse against fixtures that mirror the
 * DO's Response.json payloads (see apps/workflows PuzzleMetadataDO.handleReserve).
 */
import { describe, it, expect } from 'vitest';
import type { IdempotencyReservationStatus } from './storage.worker';

/** Mirrors storage.worker.ts reserveIdempotencyKey response parsing. */
function parseReserveResponse(payload: unknown): {
	existing: boolean;
	puzzleId: string;
	status?: IdempotencyReservationStatus;
} {
	const result = payload as {
		existing?: boolean;
		puzzleId?: string;
		status?: IdempotencyReservationStatus;
	};
	if (typeof result.puzzleId !== 'string') {
		throw new Error('Reserve response missing puzzleId');
	}
	return {
		existing: !!result.existing,
		puzzleId: result.puzzleId,
		...(result.status ? { status: result.status } : {})
	};
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
		it(`parses DO ${fixture.name} response`, () => {
			const parsed = parseReserveResponse(fixture.body);
			expect(parsed.puzzleId).toBe(fixture.body.puzzleId);
			expect(parsed.existing).toBe(fixture.body.existing);
			expect(parsed.status).toBe(fixture.body.status);
		});
	}

	it('rejects a response missing puzzleId (client throw path)', () => {
		expect(() => parseReserveResponse({ existing: true, status: 'pending' })).toThrow(
			/missing puzzleId/
		);
	});

	it('treats missing existing as false (first-claim without the field)', () => {
		const parsed = parseReserveResponse({ puzzleId: 'p1', status: 'pending' });
		expect(parsed.existing).toBe(false);
		expect(parsed.puzzleId).toBe('p1');
	});

	it('omits status when DO does not send one (legacy)', () => {
		const parsed = parseReserveResponse({ existing: true, puzzleId: 'legacy' });
		expect(parsed.status).toBeUndefined();
		expect(parsed.existing).toBe(true);
	});
});
