import type { AnalyticsTransport } from '../transport';

export function createNoopAnalyticsTransport(): AnalyticsTransport {
	return {
		async send(): Promise<void> {},
		sendOnPageHide(): boolean {
			return true;
		}
	};
}
