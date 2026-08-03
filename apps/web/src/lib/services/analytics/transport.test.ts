import { describe, expect, it, vi } from 'vitest';
import {
	ANALYTICS_BATCH_SCHEMA_VERSION,
	ANALYTICS_EVENT_SCHEMA_VERSION,
	type AnalyticsBatchV1,
	type AnalyticsEventV1
} from '@perseus/types';
import { createHttpAnalyticsTransport } from './transports/http';
import { createMemoryAnalyticsTransport } from './transports/memory';
import { createNoopAnalyticsTransport } from './transports/noop';

const event: AnalyticsEventV1 = {
	eventName: 'gallery_viewed',
	runId: null,
	context: {
		authentication: 'unknown',
		viewportClass: 'desktop',
		primaryInput: 'fine_pointer'
	},
	data: null,
	schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
	eventId: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
	occurredAt: 1_000
};

function batch(...events: AnalyticsEventV1[]): AnalyticsBatchV1 {
	return {
		schemaVersion: ANALYTICS_BATCH_SCHEMA_VERSION,
		events
	};
}

describe('HTTP analytics transport', () => {
	it('posts the exact JSON batch without credentials or cache', async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 202 }));
		const transport = createHttpAnalyticsTransport({
			endpoint: '/api/analytics/events',
			fetchFn
		});

		await transport.send(batch(event));

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(fetchFn).toHaveBeenCalledWith('/api/analytics/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'omit',
			cache: 'no-store',
			body: JSON.stringify(batch(event))
		});
	});

	it('supports a cross-origin endpoint without changing the request policy', async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
		const transport = createHttpAnalyticsTransport({
			endpoint: 'http://localhost:4690/api/analytics/events',
			fetchFn
		});
		await transport.send(batch(event));
		expect(fetchFn).toHaveBeenCalledWith(
			'http://localhost:4690/api/analytics/events',
			expect.objectContaining({ credentials: 'omit' })
		);
	});

	it('throws a bounded generic error for non-2xx responses without reading a body', async () => {
		const json = vi.fn();
		const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json }) as unknown as Response);
		const transport = createHttpAnalyticsTransport({
			endpoint: '/api/analytics/events',
			fetchFn
		});
		await expect(transport.send(batch(event))).rejects.toThrow('analytics_transport_failed');
		expect(json).not.toHaveBeenCalled();
	});

	it('sends a keepalive fetch with credentials omitted on page-hide', () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 202 }));
		const transport = createHttpAnalyticsTransport({
			endpoint: '/api/analytics/events',
			fetchFn
		});

		expect(transport.sendOnPageHide?.(batch(event))).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(fetchFn).toHaveBeenCalledWith('/api/analytics/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'omit',
			cache: 'no-store',
			keepalive: true,
			body: JSON.stringify(batch(event))
		});
	});

	it('swallows async fetch errors during page-hide delivery', async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error('page terminated');
		});
		const transport = createHttpAnalyticsTransport({
			endpoint: '/api/analytics/events',
			fetchFn
		});

		expect(transport.sendOnPageHide?.(batch(event))).toBe(true);
		expect(fetchFn).toHaveBeenCalledWith('/api/analytics/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'omit',
			cache: 'no-store',
			keepalive: true,
			body: JSON.stringify(batch(event))
		});
		await Promise.resolve();
	});

	it('uses the default fetch when none is injected for page-hide', () => {
		const transport = createHttpAnalyticsTransport({
			endpoint: '/api/analytics/events'
		});
		expect(transport.sendOnPageHide?.(batch(event))).toBe(true);
	});

	it('returns false when the page-hide fetch throws synchronously', () => {
		const fetchFn = vi.fn(() => {
			throw new Error('fetch unavailable');
		});
		const transport = createHttpAnalyticsTransport({
			endpoint: '/api/analytics/events',
			fetchFn
		});
		expect(transport.sendOnPageHide?.(batch(event))).toBe(false);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});

describe('memory analytics transport', () => {
	it('captures copies, supports page-hide, and resets deterministically', async () => {
		const transport = createMemoryAnalyticsTransport();
		await transport.send(batch(event));
		expect(transport.sendOnPageHide?.(batch({ ...event, occurredAt: 2_000 }))).toBe(true);
		expect(transport.getEvents()).toEqual([event, { ...event, occurredAt: 2_000 }]);

		const copy = transport.getEvents() as AnalyticsEventV1[];
		copy.length = 0;
		expect(transport.getEvents()).toHaveLength(2);

		transport.reset();
		expect(transport.getEvents()).toEqual([]);
	});

	it('fails exactly the next normal send', async () => {
		const transport = createMemoryAnalyticsTransport();
		transport.failNextSend(new Error('expected failure'));
		await expect(transport.send(batch(event))).rejects.toThrow('expected failure');
		await expect(transport.send(batch(event))).resolves.toBeUndefined();
		expect(transport.getEvents()).toEqual([event]);
	});
});

describe('no-op analytics transport', () => {
	it('accepts normal and page-hide delivery without side effects', async () => {
		const transport = createNoopAnalyticsTransport();
		await expect(transport.send(batch(event))).resolves.toBeUndefined();
		expect(transport.sendOnPageHide?.(batch(event))).toBe(true);
	});
});
