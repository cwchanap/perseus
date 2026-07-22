/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { getAuthoritativeStatus, deleteMetadataDO } from '../storage.worker';

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
