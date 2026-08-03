import type { AnalyticsBatchV1 } from '@perseus/types';
import type { AnalyticsTransport } from '../transport';

type AnalyticsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createHttpAnalyticsTransport(options: {
	endpoint: string;
	fetchFn?: AnalyticsFetch;
}): AnalyticsTransport {
	const fetchFn = options.fetchFn ?? globalThis.fetch;

	function requestInit(batch: AnalyticsBatchV1, keepalive = false): RequestInit {
		return {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'omit',
			cache: 'no-store',
			...(keepalive ? { keepalive: true } : {}),
			body: JSON.stringify(batch)
		};
	}

	return {
		async send(batch): Promise<void> {
			const response = await fetchFn(options.endpoint, requestInit(batch));
			if (!response.ok) throw new Error('analytics_transport_failed');
		},
		sendOnPageHide(batch): boolean {
			try {
				void fetchFn(options.endpoint, requestInit(batch, true)).catch(() => {});
				return true;
			} catch {
				return false;
			}
		}
	};
}
