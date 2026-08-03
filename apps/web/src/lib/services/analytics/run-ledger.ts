import {
	ANALYTICS_EVENT_SCHEMA_VERSION,
	isPuzzleRunId,
	type AnalyticsOncePerRunEventInputV1
} from '@perseus/types';

export const ANALYTICS_RUN_LEDGER_KEY = 'perseus-analytics-run-ledger';
export const ANALYTICS_RUN_LEDGER_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_RUN_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const ANALYTICS_RUN_LEDGER_MAX_RUNS = 1_000;
export const ANALYTICS_RUN_LEDGER_MAX_EVENTS_PER_RUN = 6;

export type AnalyticsOncePerRunEventNameV1 =
	AnalyticsOncePerRunEventInputV1['eventName'];

export interface AnalyticsRunLedgerEventV1 {
	eventSchemaVersion: typeof ANALYTICS_EVENT_SCHEMA_VERSION;
	eventName: AnalyticsOncePerRunEventNameV1;
	recordedAt: number;
}

export interface AnalyticsRunLedgerRecordV1 {
	runId: string;
	lastRecordedAt: number;
	events: AnalyticsRunLedgerEventV1[];
}

export interface AnalyticsRunLedgerV1 {
	schemaVersion: typeof ANALYTICS_RUN_LEDGER_SCHEMA_VERSION;
	runs: AnalyticsRunLedgerRecordV1[];
}

export interface AnalyticsRunLedgerMarkInputV1 extends AnalyticsRunLedgerEventV1 {
	runId: string;
}

export type AnalyticsLedgerMarkResult =
	| 'recorded'
	| 'duplicate'
	| 'storage_unavailable'
	| 'incompatible_schema';

export type AnalyticsRunLedgerErrorCode =
	| 'read_error'
	| 'write_error'
	| 'remove_error'
	| 'invalid_record';

export interface AnalyticsRunLedger {
	markIfNew(input: AnalyticsRunLedgerMarkInputV1): AnalyticsLedgerMarkResult;
}

const VALID_EVENT_NAMES = new Set<AnalyticsOncePerRunEventNameV1>([
	'puzzle_opened',
	'first_piece_placed',
	'hint_used',
	'reference_used',
	'puzzle_completed',
	'personal_best_beaten'
]);

const LEDGER_KEYS = ['schemaVersion', 'runs'] as const;
const RUN_KEYS = ['runId', 'lastRecordedAt', 'events'] as const;
const EVENT_KEYS = ['eventSchemaVersion', 'eventName', 'recordedAt'] as const;

type ParsedLedger =
	| { kind: 'valid'; ledger: AnalyticsRunLedgerV1 }
	| { kind: 'incompatible' }
	| { kind: 'invalid' }
	| { kind: 'missing' }
	| { kind: 'read_error' };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEventName(value: unknown): value is AnalyticsOncePerRunEventNameV1 {
	return typeof value === 'string' && VALID_EVENT_NAMES.has(value as AnalyticsOncePerRunEventNameV1);
}

function isMarkInput(value: AnalyticsRunLedgerMarkInputV1): boolean {
	return (
		value.eventSchemaVersion === ANALYTICS_EVENT_SCHEMA_VERSION &&
		isEventName(value.eventName) &&
		isPuzzleRunId(value.runId) &&
		isSafeTimestamp(value.recordedAt)
	);
}

function parseEvent(value: unknown): AnalyticsRunLedgerEventV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, EVENT_KEYS)) return null;
	if (
		value.eventSchemaVersion !== ANALYTICS_EVENT_SCHEMA_VERSION ||
		!isEventName(value.eventName) ||
		!isSafeTimestamp(value.recordedAt)
	) {
		return null;
	}
	return {
		eventSchemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
		eventName: value.eventName,
		recordedAt: value.recordedAt
	};
}

function parseRun(value: unknown): AnalyticsRunLedgerRecordV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, RUN_KEYS)) return null;
	if (
		!isPuzzleRunId(value.runId) ||
		!isSafeTimestamp(value.lastRecordedAt) ||
		!Array.isArray(value.events) ||
		value.events.length < 1 ||
		value.events.length > ANALYTICS_RUN_LEDGER_MAX_EVENTS_PER_RUN
	) {
		return null;
	}

	const events: AnalyticsRunLedgerEventV1[] = [];
	const eventKeys = new Set<string>();
	for (const rawEvent of value.events) {
		const event = parseEvent(rawEvent);
		if (event === null) return null;
		const key = `${event.eventSchemaVersion}:${event.eventName}`;
		if (eventKeys.has(key)) return null;
		eventKeys.add(key);
		events.push(event);
	}

	const lastRecordedAt = Math.max(...events.map((event) => event.recordedAt));
	if (lastRecordedAt !== value.lastRecordedAt) return null;

	return {
		runId: value.runId,
		lastRecordedAt,
		events: events.sort((a, b) => b.recordedAt - a.recordedAt)
	};
}

function parseLedger(value: unknown): ParsedLedger {
	if (!isRecord(value) || !Object.hasOwn(value, 'schemaVersion')) return { kind: 'invalid' };
	if (!Number.isInteger(value.schemaVersion)) return { kind: 'invalid' };
	if ((value.schemaVersion as number) > ANALYTICS_RUN_LEDGER_SCHEMA_VERSION) {
		return { kind: 'incompatible' };
	}
	if (
		value.schemaVersion !== ANALYTICS_RUN_LEDGER_SCHEMA_VERSION ||
		!hasExactKeys(value, LEDGER_KEYS) ||
		!Array.isArray(value.runs) ||
		value.runs.length > ANALYTICS_RUN_LEDGER_MAX_RUNS
	) {
		return { kind: 'invalid' };
	}

	const runs: AnalyticsRunLedgerRecordV1[] = [];
	const runIds = new Set<string>();
	for (const rawRun of value.runs) {
		const run = parseRun(rawRun);
		if (run === null || runIds.has(run.runId)) return { kind: 'invalid' };
		runIds.add(run.runId);
		runs.push(run);
	}

	return {
		kind: 'valid',
		ledger: {
			schemaVersion: ANALYTICS_RUN_LEDGER_SCHEMA_VERSION,
			runs: runs.sort((a, b) => b.lastRecordedAt - a.lastRecordedAt)
		}
	};
}

function readLedger(
	storage: Storage,
	onError: ((code: AnalyticsRunLedgerErrorCode) => void) | undefined
): ParsedLedger {
	let raw: string | null;
	try {
		raw = storage.getItem(ANALYTICS_RUN_LEDGER_KEY);
	} catch {
		onError?.('read_error');
		return { kind: 'read_error' };
	}
	if (raw === null) return { kind: 'missing' };

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { kind: 'invalid' };
	}
	return parseLedger(value);
}

function recoverInvalidRecord(
	storage: Storage,
	onError: ((code: AnalyticsRunLedgerErrorCode) => void) | undefined
): void {
	onError?.('invalid_record');
	try {
		storage.removeItem(ANALYTICS_RUN_LEDGER_KEY);
	} catch {
		onError?.('remove_error');
	}
}

function emptyLedger(): AnalyticsRunLedgerV1 {
	return {
		schemaVersion: ANALYTICS_RUN_LEDGER_SCHEMA_VERSION,
		runs: []
	};
}

function cloneLedger(ledger: AnalyticsRunLedgerV1): AnalyticsRunLedgerV1 {
	return {
		schemaVersion: ANALYTICS_RUN_LEDGER_SCHEMA_VERSION,
		runs: ledger.runs.map((run) => ({
			runId: run.runId,
			lastRecordedAt: run.lastRecordedAt,
			events: run.events.map((event) => ({ ...event }))
		}))
	};
}

export function createAnalyticsRunLedger(options?: {
	storage?: Storage;
	onError?: (code: AnalyticsRunLedgerErrorCode) => void;
}): AnalyticsRunLedger {
	const storage =
		options?.storage ??
		(typeof localStorage !== 'undefined' ? localStorage : undefined);
	const onError = options?.onError;

	return {
		markIfNew(input): AnalyticsLedgerMarkResult {
			if (storage === undefined || !isMarkInput(input)) return 'storage_unavailable';

			const parsed = readLedger(storage, onError);
			if (parsed.kind === 'read_error') return 'storage_unavailable';
			if (parsed.kind === 'incompatible') return 'incompatible_schema';
			if (parsed.kind === 'invalid') recoverInvalidRecord(storage, onError);

			const ledger =
				parsed.kind === 'valid' ? cloneLedger(parsed.ledger) : emptyLedger();
			const oldestRetainedAt = input.recordedAt - ANALYTICS_RUN_LEDGER_RETENTION_MS;
			ledger.runs = ledger.runs.filter((run) => run.lastRecordedAt >= oldestRetainedAt);

			let run = ledger.runs.find((candidate) => candidate.runId === input.runId);
			if (
				run?.events.some(
					(event) =>
						event.eventSchemaVersion === input.eventSchemaVersion &&
						event.eventName === input.eventName
				)
			) {
				return 'duplicate';
			}

			const nextEvent: AnalyticsRunLedgerEventV1 = {
				eventSchemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
				eventName: input.eventName,
				recordedAt: input.recordedAt
			};
			if (run === undefined) {
				run = {
					runId: input.runId,
					lastRecordedAt: input.recordedAt,
					events: [nextEvent]
				};
				ledger.runs.push(run);
			} else {
				run.events.push(nextEvent);
				run.events.sort((a, b) => b.recordedAt - a.recordedAt);
				run.events = run.events.slice(0, ANALYTICS_RUN_LEDGER_MAX_EVENTS_PER_RUN);
				run.lastRecordedAt = Math.max(run.lastRecordedAt, input.recordedAt);
			}

			ledger.runs.sort((a, b) => b.lastRecordedAt - a.lastRecordedAt);
			ledger.runs = ledger.runs.slice(0, ANALYTICS_RUN_LEDGER_MAX_RUNS);

			try {
				storage.setItem(ANALYTICS_RUN_LEDGER_KEY, JSON.stringify(ledger));
			} catch {
				onError?.('write_error');
				return 'storage_unavailable';
			}
			return 'recorded';
		}
	};
}
