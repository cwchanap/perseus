import {
	ANALYTICS_EVENT_SCHEMA_VERSION,
	ANALYTICS_MAX_COUNTER,
	buildAnalyticsRunEventIdV1,
	isAnalyticsEventInputV1,
	isAnalyticsEventV1,
	type AnalyticsEventInputV1,
	type AnalyticsEventV1,
	type AnalyticsOncePerRunEventInputV1,
	type AnalyticsTrackedOccurrenceEventInputV1,
	type PuzzleExitedIncompleteEventInputV1
} from '@perseus/types';
import {
	createAnalyticsDeliveryQueue,
	type AnalyticsQueueErrorCode,
	type AnalyticsScheduler
} from './queue';
import type { AnalyticsRunLedger } from './run-ledger';
import type { AnalyticsTransport } from './transport';

export type AnalyticsClientErrorCode =
	| 'invalid_input'
	| 'invalid_event_id'
	| 'ledger_storage_unavailable'
	| 'ledger_incompatible_schema'
	| 'transport_failed'
	| 'queue_overflow';

export interface AnalyticsClient {
	track(event: AnalyticsTrackedOccurrenceEventInputV1): void;
	trackOncePerRun(event: AnalyticsOncePerRunEventInputV1): void;
	flushForPageHide(event: PuzzleExitedIncompleteEventInputV1): boolean;
	flush(): Promise<void>;
	dispose(): void;
}

const ONCE_PER_RUN_EVENT_NAMES = new Set<string>([
	'puzzle_opened',
	'first_piece_placed',
	'hint_used',
	'reference_used',
	'puzzle_completed',
	'personal_best_beaten'
]);

const EVENT_INPUT_KEYS = ['eventName', 'runId', 'context', 'data'] as const;
const COMPLETION_DATA_KEYS = [
	'elapsedActiveSeconds',
	'hintsUsed',
	'referenceActivations',
	'countersSaturated'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOncePerRunEventName(
	value: AnalyticsEventInputV1['eventName']
): value is AnalyticsOncePerRunEventInputV1['eventName'] {
	return ONCE_PER_RUN_EVENT_NAMES.has(value);
}

function cloneInput<T extends AnalyticsEventInputV1>(input: T): T {
	return {
		eventName: input.eventName,
		runId: input.runId,
		context: { ...input.context },
		data: input.data === null ? null : { ...input.data }
	} as T;
}

function normalizeCompletionCounters(input: unknown): unknown {
	if (
		!isRecord(input) ||
		!hasExactKeys(input, EVENT_INPUT_KEYS) ||
		input.eventName !== 'puzzle_completed' ||
		!isRecord(input.data) ||
		!hasExactKeys(input.data, COMPLETION_DATA_KEYS) ||
		!isNonNegativeSafeInteger(input.data.hintsUsed) ||
		!isNonNegativeSafeInteger(input.data.referenceActivations) ||
		typeof input.data.countersSaturated !== 'boolean'
	) {
		return input;
	}

	const hintsUsed = Math.min(input.data.hintsUsed, ANALYTICS_MAX_COUNTER);
	const referenceActivations = Math.min(input.data.referenceActivations, ANALYTICS_MAX_COUNTER);
	return {
		eventName: input.eventName,
		runId: input.runId,
		context: input.context,
		data: {
			elapsedActiveSeconds: input.data.elapsedActiveSeconds,
			hintsUsed,
			referenceActivations,
			countersSaturated:
				input.data.countersSaturated ||
				input.data.hintsUsed > ANALYTICS_MAX_COUNTER ||
				input.data.referenceActivations > ANALYTICS_MAX_COUNTER
		}
	};
}

function defaultCreateEventId(): string {
	return globalThis.crypto.randomUUID();
}

export function createAnalyticsClient(options: {
	transport: AnalyticsTransport;
	ledger: AnalyticsRunLedger;
	now?: () => number;
	createEventId?: () => string;
	strictValidation: boolean;
	scheduler?: AnalyticsScheduler;
	onError?: (code: AnalyticsClientErrorCode) => void;
}): AnalyticsClient {
	const now = options.now ?? Date.now;
	const createEventId = options.createEventId ?? defaultCreateEventId;

	function rejectValidation(code: 'invalid_input' | 'invalid_event_id'): false {
		if (options.strictValidation) throw new TypeError(code);
		options.onError?.(code);
		return false;
	}

	function reportQueueError(code: AnalyticsQueueErrorCode): void {
		options.onError?.(code === 'transport_error' ? 'transport_failed' : 'queue_overflow');
	}

	const queue = createAnalyticsDeliveryQueue({
		transport: options.transport,
		scheduler: options.scheduler,
		onError: reportQueueError
	});

	// Facade-level disposed flag. The private queue drops events silently once
	// disposed, but without this guard trackOncePerRun would still materialize
	// an event and call ledger.markIfNew(), consuming a once-per-run mark that
	// a later client sharing the same ledger would then suppress as a
	// duplicate. Every tracking/page-hide method must bail out before any
	// validation, materialization, clock/UUID access, or ledger write.
	let disposed = false;

	function readOccurredAt(): number | null {
		let occurredAt: number;
		try {
			occurredAt = now();
		} catch {
			rejectValidation('invalid_input');
			return null;
		}
		if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
			rejectValidation('invalid_input');
			return null;
		}
		return occurredAt;
	}

	function materializeOccurrence(input: unknown): AnalyticsEventV1 | null {
		if (!isAnalyticsEventInputV1(input)) {
			rejectValidation('invalid_input');
			return null;
		}
		const occurredAt = readOccurredAt();
		if (occurredAt === null) return null;

		let eventId: string;
		try {
			eventId = createEventId();
		} catch {
			rejectValidation('invalid_event_id');
			return null;
		}
		const event = {
			...cloneInput(input),
			schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
			eventId,
			occurredAt
		};
		if (!isAnalyticsEventV1(event)) {
			rejectValidation('invalid_event_id');
			return null;
		}
		return event;
	}

	function materializeOncePerRun(
		input: unknown
	): { event: AnalyticsEventV1; eventName: AnalyticsOncePerRunEventInputV1['eventName'] } | null {
		const normalized = normalizeCompletionCounters(input);
		if (
			!isAnalyticsEventInputV1(normalized) ||
			!isOncePerRunEventName(normalized.eventName) ||
			typeof normalized.runId !== 'string'
		) {
			rejectValidation('invalid_input');
			return null;
		}
		const occurredAt = readOccurredAt();
		if (occurredAt === null) return null;
		const validatedEventName = normalized.eventName;
		const event = {
			...cloneInput(normalized),
			schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
			eventId: buildAnalyticsRunEventIdV1(validatedEventName, normalized.runId),
			occurredAt
		};
		if (!isAnalyticsEventV1(event)) {
			rejectValidation('invalid_input');
			return null;
		}
		return { event, eventName: validatedEventName };
	}

	return {
		track(input): void {
			if (disposed) return;
			if (!isRecord(input) || input.eventName !== 'gallery_viewed') {
				rejectValidation('invalid_input');
				return;
			}
			const event = materializeOccurrence(input);
			if (event !== null) queue.enqueue(event);
		},
		trackOncePerRun(input): void {
			if (disposed) return;
			const materialized = materializeOncePerRun(input);
			if (materialized === null) return;
			const { event, eventName } = materialized;
			if (typeof event.runId !== 'string') return;

			let result;
			try {
				result = options.ledger.markIfNew({
					eventSchemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
					eventName,
					runId: event.runId,
					recordedAt: event.occurredAt
				});
			} catch {
				options.onError?.('ledger_storage_unavailable');
				return;
			}

			if (result === 'recorded') {
				queue.enqueue(event);
			} else if (result === 'storage_unavailable') {
				options.onError?.('ledger_storage_unavailable');
			} else if (result === 'incompatible_schema') {
				options.onError?.('ledger_incompatible_schema');
			} else if (result === 'invalid_input') {
				options.onError?.('invalid_input');
			}
		},
		flushForPageHide(input): boolean {
			if (disposed) return false;
			if (!isRecord(input) || input.eventName !== 'puzzle_exited_incomplete') {
				rejectValidation('invalid_input');
				return false;
			}
			const event = materializeOccurrence(input);
			return event !== null && queue.flushForPageHide(event);
		},
		flush(): Promise<void> {
			if (disposed) return Promise.resolve();
			return queue.flush();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			queue.dispose();
		}
	};
}
