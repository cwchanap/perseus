import type { AnalyticsBatchV1 } from '@perseus/types';

export interface AnalyticsTransport {
	send(batch: AnalyticsBatchV1): Promise<void>;
	sendOnPageHide?(batch: AnalyticsBatchV1): boolean;
}
