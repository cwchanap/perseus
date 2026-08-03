import type { AnalyticsBatchV1 } from '@perseus/types';
import type { AnalyticsTransport } from '../transport';

type AnalyticsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createHttpAnalyticsTransport(options: {
	endpoint: string;
	fetchFn?: AnalyticsFetch;
	sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}): AnalyticsTransport {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	const sendBeacon =
		options.sendBeacon ??
		(typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
			? navigator.sendBeacon.bind(navigator)
			: undefined);

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
			const body = JSON.stringify(batch);
			if (sendBeacon) {
				try {
					if (sendBeacon(options.endpoint, new Blob([body], { type: 'application/json' }))) {
						return true;
					}
				} catch {
					// Fall through to keepalive fetch.
				}
			}

			try {
				void fetchFn(options.endpoint, requestInit(batch, true)).catch(() => {});
				return true;
			} catch {
				return false;
			}
		}
	};
}
