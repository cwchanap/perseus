import type { AnalyticsBatchV1, AnalyticsEventV1 } from '@perseus/types';
import type { AnalyticsTransport } from '../transport';

export interface MemoryAnalyticsTransport extends AnalyticsTransport {
	getEvents(): readonly AnalyticsEventV1[];
	reset(): void;
	failNextSend(error?: Error): void;
}

function cloneEvent(event: AnalyticsEventV1): AnalyticsEventV1 {
	return JSON.parse(JSON.stringify(event)) as AnalyticsEventV1;
}

export function createMemoryAnalyticsTransport(): MemoryAnalyticsTransport {
	let events: AnalyticsEventV1[] = [];
	let nextError: Error | null = null;

	function capture(batch: AnalyticsBatchV1): void {
		events.push(...batch.events.map(cloneEvent));
	}

	return {
		async send(batch): Promise<void> {
			if (nextError) {
				const error = nextError;
				nextError = null;
				throw error;
			}
			capture(batch);
		},
		sendOnPageHide(batch): boolean {
			capture(batch);
			return true;
		},
		getEvents(): readonly AnalyticsEventV1[] {
			return events.map(cloneEvent);
		},
		reset(): void {
			events = [];
			nextError = null;
		},
		failNextSend(error = new Error('analytics_transport_failed')): void {
			nextError = error;
		}
	};
}
