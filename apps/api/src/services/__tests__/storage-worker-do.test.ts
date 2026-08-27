/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import {
	getAuthoritativeStatus,
	deleteMetadataDO,
	getIdempotencyReservation
} from '../storage.worker';

describe('getAuthoritativeStatus', () => {
	it('returns the status from the DO /status response', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const status = await getAuthoritativeStatus(doNs, 'puzzle-1');
		expect(status).toBe('ready');
		expect(doNs.idFromName).toHaveBeenCalledWith('puzzle-1');
	});

	it('returns null when DO has no metadata (404)', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Not found', { status: 404 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const status = await getAuthoritativeStatus(doNs, 'puzzle-1');
		expect(status).toBeNull();
	});

	it('throws on unexpected DO error (caller fails closed — does not reap)', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Internal error', { status: 500 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(getAuthoritativeStatus(doNs, 'puzzle-1')).rejects.toThrow();
	});

	it('throws when DO response is missing the status field', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(getAuthoritativeStatus(doNs, 'puzzle-1')).rejects.toThrow(
			'Authoritative status response missing status field'
		);
	});

	it('throws when DO response status is not a string', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ status: 42 }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(getAuthoritativeStatus(doNs, 'puzzle-1')).rejects.toThrow(
			'Authoritative status response missing status field'
		);
	});
});

describe('deleteMetadataDO', () => {
	it('calls the DO /delete endpoint', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await deleteMetadataDO(doNs, 'puzzle-1');
		expect(doNs.idFromName).toHaveBeenCalledWith('puzzle-1');
		expect(stub.fetch).toHaveBeenCalledWith(
			'https://puzzle-metadata/delete',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('throws on DO error', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Internal error', { status: 500 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(deleteMetadataDO(doNs, 'puzzle-1')).rejects.toThrow();
	});
});

describe('getIdempotencyReservation', () => {
	it('returns the reservation when DO responds with a valid reservation object', async () => {
		const stub = {
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							reservation: { puzzleId: 'puzzle-1', status: 'committed', reservedAt: 1700000000 }
						}),
						{ status: 200 }
					)
			)
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const result = await getIdempotencyReservation(doNs, 'key-K');
		expect(doNs.idFromName).toHaveBeenCalledWith('key-K');
		expect(result).toEqual({
			familyId: 'puzzle-1',
			status: 'committed',
			reservedAt: 1700000000
		});
	});

	it('throws on 404 (no special 404 handling — caller catches and treats as null)', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Not found', { status: 404 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(getIdempotencyReservation(doNs, 'key-K')).rejects.toThrow(
			/Failed to read idempotency reservation \(HTTP 404\)/
		);
	});

	it('throws with message from DO error payload when response is not ok', async () => {
		const stub = {
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify({ message: 'Reservation DO is corrupted' }), { status: 500 })
			)
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(getIdempotencyReservation(doNs, 'key-K')).rejects.toThrow(
			'Reservation DO is corrupted'
		);
	});

	it('throws with fallback message when error response body is not JSON', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('plain text error', { status: 500 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(getIdempotencyReservation(doNs, 'key-K')).rejects.toThrow(
			/Failed to read idempotency reservation \(HTTP 500\)/
		);
	});

	it('returns null when response is ok but reservation field is missing', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const result = await getIdempotencyReservation(doNs, 'key-K');
		expect(result).toBeNull();
	});

	it('returns null when reservation.puzzleId is not a string', async () => {
		const stub = {
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify({ reservation: { puzzleId: 42, status: 'committed' } }), {
						status: 200
					})
			)
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const result = await getIdempotencyReservation(doNs, 'key-K');
		expect(result).toBeNull();
	});

	it('returns reservation with unknown status when status is not a string', async () => {
		const stub = {
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify({ reservation: { puzzleId: 'puzzle-1', status: null } }), {
						status: 200
					})
			)
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const result = await getIdempotencyReservation(doNs, 'key-K');
		expect(result).toEqual({ familyId: 'puzzle-1', status: 'unknown' });
	});

	it('omits reservedAt when it is not a number', async () => {
		const stub = {
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({ reservation: { puzzleId: 'puzzle-1', status: 'pending' } }),
						{ status: 200 }
					)
			)
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const result = await getIdempotencyReservation(doNs, 'key-K');
		expect(result).toEqual({ familyId: 'puzzle-1', status: 'pending' });
		expect(result).not.toHaveProperty('reservedAt');
	});

	it('returns null when response body is not valid JSON', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('not json', { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const result = await getIdempotencyReservation(doNs, 'key-K');
		expect(result).toBeNull();
	});
});
