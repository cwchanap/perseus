import { describe, expect, it, vi } from 'vitest';
import {
	ANALYTICS_EVENT_SCHEMA_VERSION,
	ANALYTICS_MAX_BATCH_SIZE,
	type AnalyticsBatchV1,
	type AnalyticsEventV1
} from '@perseus/types';
import {
	ANALYTICS_QUEUE_FLUSH_INTERVAL_MS,
	ANALYTICS_QUEUE_MAX_EVENTS,
	createAnalyticsDeliveryQueue,
	type AnalyticsScheduler
} from './queue';
import type { AnalyticsTransport } from './transport';

function event(occurredAt: number): AnalyticsEventV1 {
	return {
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
		occurredAt
	};
}

function createScheduler() {
	let nextHandle = 1;
	const callbacks = new Map<number, () => void>();
	const scheduler: AnalyticsScheduler = {
		setTimeout(callback) {
			const handle = nextHandle++;
			callbacks.set(handle, callback);
			return handle;
		},
		clearTimeout(handle) {
			callbacks.delete(handle as number);
		}
	};
	return {
		scheduler,
		get size() {
			return callbacks.size;
		},
		runNext() {
			const entry = callbacks.entries().next().value as [number, () => void] | undefined;
			if (!entry) return false;
			callbacks.delete(entry[0]);
			entry[1]();
			return true;
		}
	};
}

function createCapturingTransport(): AnalyticsTransport & { batches: AnalyticsBatchV1[] } {
	const batches: AnalyticsBatchV1[] = [];
	return {
		batches,
		async send(batch) {
			batches.push(batch);
		},
		sendOnPageHide(batch) {
			batches.push(batch);
			return true;
		}
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('bounded analytics delivery queue', () => {
	it('locks the queue constants', () => {
		expect(ANALYTICS_QUEUE_MAX_EVENTS).toBe(100);
		expect(ANALYTICS_QUEUE_FLUSH_INTERVAL_MS).toBe(1_000);
	});

	it('schedules one timer and flushes when it fires', async () => {
		const timer = createScheduler();
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({
			transport,
			scheduler: timer.scheduler
		});

		queue.enqueue(event(1));
		queue.enqueue(event(2));
		expect(queue.size).toBe(2);
		expect(timer.size).toBe(1);
		expect(timer.runNext()).toBe(true);
		await settle();

		expect(queue.size).toBe(0);
		expect(transport.batches.map((batch) => batch.events.map((item) => item.occurredAt))).toEqual([
			[1, 2]
		]);
	});

	it('starts an immediate flush when a full batch is queued', async () => {
		const timer = createScheduler();
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({
			transport,
			scheduler: timer.scheduler,
			maxBatchSize: 3
		});

		queue.enqueue(event(1));
		queue.enqueue(event(2));
		queue.enqueue(event(3));
		await queue.flush();

		expect(timer.size).toBe(0);
		expect(transport.batches[0].events.map((item) => item.occurredAt)).toEqual([1, 2, 3]);
	});

	it('drains multiple batches in order', async () => {
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxBatchSize: 20,
			flushIntervalMs: 60_000
		});
		for (let index = 1; index <= 45; index++) queue.enqueue(event(index));

		await queue.flush();

		expect(transport.batches.map((batch) => batch.events.length)).toEqual([20, 20, 5]);
		expect(
			transport.batches.flatMap((batch) => batch.events.map((item) => item.occurredAt))
		).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
	});

	it('deduplicates concurrent flush calls', async () => {
		const pending = deferred<void>();
		const send = vi.fn(() => pending.promise);
		const queue = createAnalyticsDeliveryQueue({ transport: { send } });
		queue.enqueue(event(1));

		const first = queue.flush();
		const second = queue.flush();
		expect(first).toBe(second);
		expect(send).toHaveBeenCalledTimes(1);

		pending.resolve();
		await first;
		expect(queue.size).toBe(0);
	});

	it('preserves enqueue order while a batch is in flight', async () => {
		const firstSend = deferred<void>();
		const batches: number[][] = [];
		let sendCount = 0;
		const transport: AnalyticsTransport = {
			async send(batch) {
				batches.push(batch.events.map((item) => item.occurredAt));
				sendCount++;
				if (sendCount === 1) await firstSend.promise;
			}
		};
		const queue = createAnalyticsDeliveryQueue({ transport, maxBatchSize: 2 });
		queue.enqueue(event(1));
		queue.enqueue(event(2));
		queue.enqueue(event(3));

		firstSend.resolve();
		await queue.flush();
		expect(batches).toEqual([[1, 2], [3]]);
	});

	it('drops a rejected batch, stops that flush, and keeps remaining events queued', async () => {
		const errors: string[] = [];
		let sends = 0;
		const transport: AnalyticsTransport = {
			async send() {
				sends++;
				throw new Error('rejected');
			}
		};
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxBatchSize: 20,
			flushIntervalMs: 60_000,
			onError: (code) => errors.push(code)
		});
		for (let index = 1; index <= 25; index++) queue.enqueue(event(index));

		await queue.flush();

		expect(sends).toBe(1);
		expect(queue.size).toBe(5);
		expect(errors).toEqual(['transport_error']);
	});

	it('drops the oldest event on overflow and reports it', async () => {
		const pending = deferred<void>();
		const errors: string[] = [];
		const transport: AnalyticsTransport = {
			async send() {
				await pending.promise;
			}
		};
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxEvents: 3,
			maxBatchSize: 3,
			flushIntervalMs: 60_000,
			onError: (code) => errors.push(code)
		});
		for (let index = 1; index <= 7; index++) queue.enqueue(event(index));
		expect(errors).toEqual(['queue_overflow']);
		pending.resolve();
		await queue.flush();
		expect(queue.size).toBe(0);
	});

	it('sends the newest queued tail plus the exit event on page hide', () => {
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxBatchSize: 5,
			flushIntervalMs: 60_000
		});
		queue.enqueue(event(1));
		queue.enqueue(event(2));
		queue.enqueue(event(3));
		queue.enqueue(event(4));

		expect(queue.flushForPageHide(event(5))).toBe(true);
		expect(transport.batches[0].events.map((item) => item.occurredAt)).toEqual([1, 2, 3, 4, 5]);
		expect(queue.size).toBe(0);
	});

	it('keeps queued events when page-hide delivery is unsupported or rejected', () => {
		const queueWithoutSupport = createAnalyticsDeliveryQueue({
			transport: { async send() {} },
			maxBatchSize: 5
		});
		queueWithoutSupport.enqueue(event(1));
		expect(queueWithoutSupport.flushForPageHide(event(2))).toBe(false);
		expect(queueWithoutSupport.size).toBe(1);

		const queueRejected = createAnalyticsDeliveryQueue({
			transport: { async send() {}, sendOnPageHide: () => false },
			maxBatchSize: 5
		});
		queueRejected.enqueue(event(1));
		expect(queueRejected.flushForPageHide(event(2))).toBe(false);
		expect(queueRejected.size).toBe(1);
	});

	it('clears timers and queued events when disposed', async () => {
		const timer = createScheduler();
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({
			transport,
			scheduler: timer.scheduler
		});
		queue.enqueue(event(1));
		queue.dispose();

		expect(queue.size).toBe(0);
		expect(timer.size).toBe(0);
		expect(timer.runNext()).toBe(false);
		await queue.flush();
		expect(transport.batches).toEqual([]);
	});

	it.each([
		['max_events', { maxEvents: 0 }],
		['max_batch_size', { maxBatchSize: 0 }],
		['flush_interval_ms', { flushIntervalMs: 0 }]
	] as const)('rejects a non-positive %s option', (_name, overrides) => {
		expect(() =>
			createAnalyticsDeliveryQueue({ transport: createCapturingTransport(), ...overrides })
		).toThrow(RangeError);
	});

	it('rejects a max batch size that exceeds the contract cap', () => {
		expect(() =>
			createAnalyticsDeliveryQueue({
				transport: createCapturingTransport(),
				maxBatchSize: ANALYTICS_MAX_BATCH_SIZE + 1
			})
		).toThrow(RangeError);
	});

	it('rejects a max batch size that exceeds max events', () => {
		expect(() =>
			createAnalyticsDeliveryQueue({
				transport: createCapturingTransport(),
				maxEvents: 5,
				maxBatchSize: 6
			})
		).toThrow(RangeError);
	});

	it('reports a throwing page-hide transport and keeps queued events', () => {
		const errors: string[] = [];
		const transport: AnalyticsTransport = {
			async send() {},
			sendOnPageHide() {
				throw new Error('beacon failed');
			}
		};
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxBatchSize: 5,
			flushIntervalMs: 60_000,
			onError: (code) => errors.push(code)
		});
		queue.enqueue(event(1));
		expect(queue.flushForPageHide(event(2))).toBe(false);
		expect(queue.size).toBe(1);
		expect(errors).toEqual(['transport_error']);
	});

	it('leaves the unsent tail queued after a partial page-hide flush', () => {
		const pending = deferred<void>();
		const pageHideBatches: AnalyticsBatchV1[] = [];
		const transport: AnalyticsTransport = {
			async send() {
				await pending.promise;
			},
			sendOnPageHide(batch) {
				pageHideBatches.push(batch);
				return true;
			}
		};
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxBatchSize: 3,
			flushIntervalMs: 60_000
		});
		for (let index = 1; index <= 7; index++) queue.enqueue(event(index));
		expect(queue.flushForPageHide(event(8))).toBe(true);
		expect(pageHideBatches[0].events.map((item) => item.occurredAt)).toEqual([6, 7, 8]);
		expect(queue.size).toBe(2);
		pending.resolve();
	});

	it('ignores a second dispose call', async () => {
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({ transport });
		queue.enqueue(event(1));
		queue.dispose();
		queue.dispose();
		expect(queue.size).toBe(0);
		await queue.flush();
		expect(transport.batches).toEqual([]);
	});

	it('does not wedge the queue after an empty manual flush', async () => {
		const transport = createCapturingTransport();
		const queue = createAnalyticsDeliveryQueue({ transport });

		// An empty flush must not leave a settled promise pinned in activeFlush.
		await queue.flush();

		// A subsequent enqueue must still schedule and deliver the event.
		queue.enqueue(event(1));
		await queue.flush();
		expect(transport.batches.map((batch) => batch.events.map((item) => item.occurredAt))).toEqual([
			[1]
		]);
		expect(queue.size).toBe(0);
	});

	it('does not wedge the queue when the transport throws synchronously', async () => {
		const errors: string[] = [];
		let sends = 0;
		const transport: AnalyticsTransport = {
			send() {
				sends++;
				throw new Error('sync throw');
			}
		};
		const queue = createAnalyticsDeliveryQueue({
			transport,
			maxBatchSize: 20,
			flushIntervalMs: 60_000,
			onError: (code) => errors.push(code)
		});
		queue.enqueue(event(1));

		await queue.flush();
		expect(sends).toBe(1);
		expect(errors).toEqual(['transport_error']);
		// activeFlush must be cleared so a later enqueue can flush again.
		const recovering = createCapturingTransport();
		const queue2 = createAnalyticsDeliveryQueue({ transport: recovering });
		queue2.enqueue(event(2));
		await queue2.flush();
		expect(recovering.batches.map((batch) => batch.events.map((item) => item.occurredAt))).toEqual([
			[2]
		]);
	});
});
