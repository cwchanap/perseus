export { createAnalyticsClient } from './analytics';
export type { AnalyticsClient, AnalyticsClientErrorCode } from './analytics';

export {
	buildAnalyticsClientContextV1,
	buildAnalyticsPuzzleContextV1,
	classifyAspectBucket,
	classifyAssistanceMode,
	classifyPieceCountBucket,
	classifyPrimaryInput,
	classifyProgressBucket,
	classifyViewportClass,
	resolveAuthenticationClass,
	resolveContentOrigin
} from './context';
export type { AnalyticsAuthStatus, AssistanceUsageSnapshot, PrimaryInputSnapshot } from './context';

export { createAnalyticsRunLedger } from './run-ledger';
export type {
	AnalyticsLedgerMarkResult,
	AnalyticsRunLedger,
	AnalyticsRunLedgerErrorCode,
	AnalyticsRunLedgerMarkInputV1
} from './run-ledger';

export type { AnalyticsTransport } from './transport';
export { createHttpAnalyticsTransport } from './transports/http';
export { createMemoryAnalyticsTransport, type MemoryAnalyticsTransport } from './transports/memory';
export { createNoopAnalyticsTransport } from './transports/noop';
