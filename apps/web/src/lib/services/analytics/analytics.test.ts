import { describe, expect, it } from 'vitest';
import {
	ANALYTICS_EVENT_SCHEMA_VERSION,
	ANALYTICS_MAX_COUNTER,
	buildAnalyticsRunEventIdV1,
	type AnalyticsEventInputV1,
	type AnalyticsPuzzleContextV1
} from '@perseus/types';
import { createAnalyticsClient } from './analytics';
import type {
	AnalyticsLedgerMarkResult,
	AnalyticsRunLedger,
	AnalyticsRunLedgerMarkInputV1
} from './run-ledger';
import type { AnalyticsScheduler } from './queue';
import { createMemoryAnalyticsTransport } from './transports/memory';

const runId = '123e4567-e89b-42d3-a456-426614174000';
const occurrenceId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function context(overrides: Partial<AnalyticsPuzzleContextV1> = {}): AnalyticsPuzzleContextV1 {
	return {
		authentication: 'unknown',
		viewportClass: 'desktop',
		primaryInput: 'fine_pointer',
		puzzleSource: 'api',
		contentOrigin: 'unknown',
		pieceCountBucket: '150-225',
		aspectBucket: 'landscape',
		sessionMode: 'timed',
		resultClass: 'standard_timed',
		timingQuality: 'known',
		sessionOrigin: 'new',
		rotationUsed: false,
		progressBucket: '0',
		assistanceMode: 'none',
		...overrides
	};
}

function galleryInput(): Extract<AnalyticsEventInputV1, { eventName: 'gallery_viewed' }> {
	return {
		eventName: 'gallery_viewed',
		runId: null,
		context: {
			authentication: 'unknown',
			viewportClass: 'desktop',
			primaryInput: 'fine_pointer'
		},
		data: null
	};
}

function openedInput(): Extract<AnalyticsEventInputV1, { eventName: 'puzzle_opened' }> {
	return {
		eventName: 'puzzle_opened',
		runId,
		context: context(),
		data: null
	};
}

function createLedger(result: AnalyticsLedgerMarkResult = 'recorded') {
	const marks: AnalyticsRunLedgerMarkInputV1[] = [];
	const ledger: AnalyticsRunLedger = {
		markIfNew(input) {
			marks.push(input);
			return result;
		}
	};
	return { ledger, marks };
}

function createScheduler() {
	const callbacks: Array<() => void> = [];
	const scheduler: AnalyticsScheduler = {
		setTimeout(callback) {
			callbacks.push(callback);
			return callback;
		},
		clearTimeout(handle) {
			const index = callbacks.indexOf(handle as () => void);
			if (index >= 0) callbacks.splice(index, 1);
		}
	};
	return {
		scheduler,
		runNext() {
			callbacks.shift()?.();
		},
		get size() {
			return callbacks.length;
		}
	};
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('analytics client facade', () => {
	it('materializes and queues a transient event with injected time and UUID', async () => {
		const transport = createMemoryAnalyticsTransport();
		const { ledger, marks } = createLedger();
		const client = createAnalyticsClient({
			transport,
			ledger,
			now: () => 1_000,
			createEventId: () => occurrenceId,
			strictValidation: true
		});

		client.track(galleryInput());
		await client.flush();

		expect(marks).toEqual([]);
		expect(transport.getEvents()).toEqual([
			{
				...galleryInput(),
				schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
				eventId: occurrenceId,
				occurredAt: 1_000
			}
		]);
	});

	it('marks and queues a deterministic once-per-run event', async () => {
		const transport = createMemoryAnalyticsTransport();
		const { ledger, marks } = createLedger();
		const client = createAnalyticsClient({
			transport,
			ledger,
			now: () => 2_000,
			createEventId: () => occurrenceId,
			strictValidation: true
		});

		client.trackOncePerRun(openedInput());
		await client.flush();

		expect(marks).toEqual([
			{
				eventSchemaVersion: 1,
				eventName: 'puzzle_opened',
				runId,
				recordedAt: 2_000
			}
		]);
		expect(transport.getEvents()[0]).toMatchObject({
			eventId: buildAnalyticsRunEventIdV1('puzzle_opened', runId),
			occurredAt: 2_000
		});
	});

	it.each(['duplicate'] as const)('silently suppresses ledger result %s', async (result) => {
		const transport = createMemoryAnalyticsTransport();
		const { ledger } = createLedger(result);
		const errors: string[] = [];
		const client = createAnalyticsClient({
			transport,
			ledger,
			strictValidation: true,
			onError: (code) => errors.push(code)
		});
		client.trackOncePerRun(openedInput());
		await client.flush();
		expect(transport.getEvents()).toEqual([]);
		expect(errors).toEqual([]);
	});

	it.each([
		['storage_unavailable', 'ledger_storage_unavailable'],
		['incompatible_schema', 'ledger_incompatible_schema']
	] as const)('reports ledger result %s as %s', async (result, expected) => {
		const transport = createMemoryAnalyticsTransport();
		const { ledger } = createLedger(result);
		const errors: string[] = [];
		const client = createAnalyticsClient({
			transport,
			ledger,
			strictValidation: false,
			onError: (code) => errors.push(code)
		});
		client.trackOncePerRun(openedInput());
		await client.flush();
		expect(transport.getEvents()).toEqual([]);
		expect(errors).toEqual([expected]);
	});

	it('clamps completion counters and records saturation without losing completion', async () => {
		const transport = createMemoryAnalyticsTransport();
		const { ledger } = createLedger();
		const client = createAnalyticsClient({
			transport,
			ledger,
			now: () => 3_000,
			strictValidation: true
		});

		client.trackOncePerRun({
			eventName: 'puzzle_completed',
			runId,
			context: context({
				progressBucket: '100',
				resultClass: 'assisted_timed',
				assistanceMode: 'mixed'
			}),
			data: {
				elapsedActiveSeconds: 60,
				hintsUsed: ANALYTICS_MAX_COUNTER + 5,
				referenceActivations: ANALYTICS_MAX_COUNTER + 7,
				countersSaturated: false
			}
		});
		await client.flush();

		expect(transport.getEvents()[0]).toMatchObject({
			data: {
				elapsedActiveSeconds: 60,
				hintsUsed: ANALYTICS_MAX_COUNTER,
				referenceActivations: ANALYTICS_MAX_COUNTER,
				countersSaturated: true
			}
		});
	});

	it('throws for invalid input in strict mode and reports then drops in product mode', async () => {
		const invalid = { ...openedInput(), runId: 'bad-run-id' };
		const strict = createAnalyticsClient({
			transport: createMemoryAnalyticsTransport(),
			ledger: createLedger().ledger,
			strictValidation: true
		});
		expect(() => strict.trackOncePerRun(invalid as ReturnType<typeof openedInput>)).toThrow(
			TypeError
		);

		const transport = createMemoryAnalyticsTransport();
		const errors: string[] = [];
		const product = createAnalyticsClient({
			transport,
			ledger: createLedger().ledger,
			strictValidation: false,
			onError: (code) => errors.push(code)
		});
		product.trackOncePerRun(invalid as ReturnType<typeof openedInput>);
		await product.flush();
		expect(transport.getEvents()).toEqual([]);
		expect(errors).toEqual(['invalid_input']);
	});

	it('reports an invalid generated occurrence ID separately', async () => {
		const transport = createMemoryAnalyticsTransport();
		const errors: string[] = [];
		const client = createAnalyticsClient({
			transport,
			ledger: createLedger().ledger,
			createEventId: () => 'NOT-A-UUID',
			strictValidation: false,
			onError: (code) => errors.push(code)
		});
		client.track(galleryInput());
		await client.flush();
		expect(transport.getEvents()).toEqual([]);
		expect(errors).toEqual(['invalid_event_id']);
	});

	it('reports unsafe timestamps as invalid input', async () => {
		const transport = createMemoryAnalyticsTransport();
		const errors: string[] = [];
		const client = createAnalyticsClient({
			transport,
			ledger: createLedger().ledger,
			now: () => -1,
			strictValidation: false,
			onError: (code) => errors.push(code)
		});
		client.track(galleryInput());
		await client.flush();
		expect(errors).toEqual(['invalid_input']);
		expect(transport.getEvents()).toEqual([]);
	});

	it('creates a fresh page-hide occurrence and sends it immediately', () => {
		const transport = createMemoryAnalyticsTransport();
		const { ledger } = createLedger();
		let nextId = 0;
		const ids = ['abcdefab-cdef-4abc-8def-abcdefabcdef', 'bcdefabc-defa-4bcd-9efa-bcdefabcdefa'];
		const client = createAnalyticsClient({
			transport,
			ledger,
			now: () => 4_000,
			createEventId: () => ids[nextId++],
			strictValidation: true
		});
		const exitInput = {
			eventName: 'puzzle_exited_incomplete',
			runId,
			context: context({ progressBucket: '25-49' }),
			data: { elapsedActiveSeconds: 30, placedPieceCount: 80 }
		} as const;

		expect(client.flushForPageHide(exitInput)).toBe(true);
		expect(client.flushForPageHide(exitInput)).toBe(true);
		expect(transport.getEvents().map((item) => item.eventId)).toEqual(ids);
	});

	it('wires the injected scheduler to the private queue', async () => {
		const transport = createMemoryAnalyticsTransport();
		const timer = createScheduler();
		const client = createAnalyticsClient({
			transport,
			ledger: createLedger().ledger,
			scheduler: timer.scheduler,
			now: () => 5_000,
			createEventId: () => occurrenceId,
			strictValidation: true
		});
		client.track(galleryInput());
		expect(timer.size).toBe(1);
		timer.runNext();
		await settle();
		expect(transport.getEvents()).toHaveLength(1);
	});

	it('isolates transport failures behind a bounded error code', async () => {
		const transport = createMemoryAnalyticsTransport();
		transport.failNextSend();
		const errors: string[] = [];
		const client = createAnalyticsClient({
			transport,
			ledger: createLedger().ledger,
			createEventId: () => occurrenceId,
			strictValidation: false,
			onError: (code) => errors.push(code)
		});
		client.track(galleryInput());
		await expect(client.flush()).resolves.toBeUndefined();
		expect(errors).toEqual(['transport_failed']);
	});

	it('disposes the private queue and ignores later events', async () => {
		const transport = createMemoryAnalyticsTransport();
		const client = createAnalyticsClient({
			transport,
			ledger: createLedger().ledger,
			createEventId: () => occurrenceId,
			strictValidation: true
		});
		client.dispose();
		client.track(galleryInput());
		await client.flush();
		expect(transport.getEvents()).toEqual([]);
	});
});
