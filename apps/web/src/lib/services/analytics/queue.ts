import {
	ANALYTICS_BATCH_SCHEMA_VERSION,
	ANALYTICS_MAX_BATCH_SIZE,
	type AnalyticsBatchV1,
	type AnalyticsEventV1
} from '@perseus/types';
import type { AnalyticsTransport } from './transport';

export const ANALYTICS_QUEUE_MAX_EVENTS = 100;
export const ANALYTICS_QUEUE_FLUSH_INTERVAL_MS = 1_000;

export interface AnalyticsScheduler {
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
}

export type AnalyticsQueueErrorCode = 'transport_error' | 'queue_overflow';

export interface AnalyticsDeliveryQueue {
	enqueue(event: AnalyticsEventV1): void;
	flush(): Promise<void>;
	flushForPageHide(event: AnalyticsEventV1): boolean;
	dispose(): void;
	readonly size: number;
}

const defaultScheduler: AnalyticsScheduler = {
	setTimeout(callback, milliseconds) {
		return globalThis.setTimeout(callback, milliseconds);
	},
	clearTimeout(handle) {
		globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
	}
};

function createBatch(events: AnalyticsEventV1[]): AnalyticsBatchV1 {
	return {
		schemaVersion: ANALYTICS_BATCH_SCHEMA_VERSION,
		events
	};
}

function requirePositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${name}_must_be_a_positive_integer`);
	}
}

export function createAnalyticsDeliveryQueue(options: {
	transport: AnalyticsTransport;
	scheduler?: AnalyticsScheduler;
	maxEvents?: number;
	maxBatchSize?: number;
	flushIntervalMs?: number;
	onError?: (code: AnalyticsQueueErrorCode) => void;
}): AnalyticsDeliveryQueue {
	const scheduler = options.scheduler ?? defaultScheduler;
	const maxEvents = options.maxEvents ?? ANALYTICS_QUEUE_MAX_EVENTS;
	const maxBatchSize = options.maxBatchSize ?? ANALYTICS_MAX_BATCH_SIZE;
	const flushIntervalMs = options.flushIntervalMs ?? ANALYTICS_QUEUE_FLUSH_INTERVAL_MS;
	requirePositiveInteger(maxEvents, 'max_events');
	requirePositiveInteger(maxBatchSize, 'max_batch_size');
	requirePositiveInteger(flushIntervalMs, 'flush_interval_ms');
	if (maxBatchSize > ANALYTICS_MAX_BATCH_SIZE) {
		throw new RangeError('max_batch_size_exceeds_contract');
	}
	if (maxBatchSize > maxEvents) {
		throw new RangeError('max_batch_size_exceeds_max_events');
	}

	let events: AnalyticsEventV1[] = [];
	let timer: unknown | null = null;
	let activeFlush: Promise<void> | null = null;
	let disposed = false;

	function clearScheduledFlush(): void {
		if (timer === null) return;
		scheduler.clearTimeout(timer);
		timer = null;
	}

	function scheduleFlush(): void {
		if (disposed || events.length === 0 || timer !== null || activeFlush !== null) return;
		timer = scheduler.setTimeout(() => {
			timer = null;
			void flush();
		}, flushIntervalMs);
	}

	function flush(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (activeFlush !== null) return activeFlush;
		clearScheduledFlush();

		activeFlush = (async () => {
			try {
				while (!disposed && events.length > 0) {
					const batchEvents = events.splice(0, maxBatchSize);
					try {
						await options.transport.send(createBatch(batchEvents));
					} catch {
						options.onError?.('transport_error');
						break;
					}
				}
			} finally {
				activeFlush = null;
				if (!disposed && events.length > 0) scheduleFlush();
			}
		})();
		return activeFlush;
	}

	return {
		enqueue(event): void {
			if (disposed) return;
			if (events.length >= maxEvents) {
				events.shift();
				options.onError?.('queue_overflow');
			}
			events.push(event);
			if (events.length >= maxBatchSize) {
				void flush();
			} else {
				scheduleFlush();
			}
		},
		flush,
		flushForPageHide(event): boolean {
			if (disposed || options.transport.sendOnPageHide === undefined) return false;
			const queuedCount = Math.min(events.length, Math.max(0, maxBatchSize - 1));
			const start = events.length - queuedCount;
			const batchEvents = [...events.slice(start), event];
			let accepted: boolean;
			try {
				accepted = options.transport.sendOnPageHide(createBatch(batchEvents));
			} catch {
				options.onError?.('transport_error');
				return false;
			}
			if (!accepted) return false;

			events.splice(start, queuedCount);
			if (events.length === 0) clearScheduledFlush();
			return true;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearScheduledFlush();
			events = [];
		},
		get size(): number {
			return events.length;
		}
	};
}
