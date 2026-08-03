import {
	MAX_COMPLETION_TIME_SECONDS,
	RESULT_CLASSES,
	TIMING_QUALITIES,
	isPuzzleRunId,
	isRecordPuzzleCompletionV1
} from './completion';
import type { ResultClass, TimingQuality } from './completion';
import { MAX_PIECES } from './puzzle-limits';

export const ANALYTICS_EVENT_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_BATCH_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_MAX_BATCH_SIZE = 20;
export const ANALYTICS_MAX_COUNTER = 10_000;
export const ANALYTICS_MAX_MOUNT_TO_FIRST_PLACEMENT_MS =
	MAX_COMPLETION_TIME_SECONDS * 1000;

export const ANALYTICS_AUTHENTICATION_CLASSES = [
	'anonymous',
	'authenticated',
	'unknown'
] as const;
export type AnalyticsAuthenticationClass =
	(typeof ANALYTICS_AUTHENTICATION_CLASSES)[number];

export const ANALYTICS_PUZZLE_SOURCES = ['api', 'local'] as const;
export type AnalyticsPuzzleSource = (typeof ANALYTICS_PUZZLE_SOURCES)[number];

export const ANALYTICS_CONTENT_ORIGINS = [
	'system',
	'player_uploaded',
	'unknown'
] as const;
export type AnalyticsContentOrigin = (typeof ANALYTICS_CONTENT_ORIGINS)[number];

export const ANALYTICS_PIECE_COUNT_BUCKETS = [
	'1-24',
	'25-49',
	'50-99',
	'100-149',
	'150-225',
	'226+'
] as const;
export type AnalyticsPieceCountBucket =
	(typeof ANALYTICS_PIECE_COUNT_BUCKETS)[number];

export const ANALYTICS_ASPECT_BUCKETS = ['square', 'landscape', 'portrait'] as const;
export type AnalyticsAspectBucket = (typeof ANALYTICS_ASPECT_BUCKETS)[number];

export const ANALYTICS_VIEWPORT_CLASSES = ['mobile', 'tablet', 'desktop'] as const;
export type AnalyticsViewportClass = (typeof ANALYTICS_VIEWPORT_CLASSES)[number];

export const ANALYTICS_PRIMARY_INPUTS = [
	'coarse_pointer',
	'fine_pointer',
	'keyboard',
	'unknown'
] as const;
export type AnalyticsPrimaryInput = (typeof ANALYTICS_PRIMARY_INPUTS)[number];

export const ANALYTICS_SESSION_MODES = ['timed', 'relaxed'] as const;
export type AnalyticsSessionMode = (typeof ANALYTICS_SESSION_MODES)[number];

export const ANALYTICS_SESSION_ORIGINS = ['new', 'resumed'] as const;
export type AnalyticsSessionOrigin = (typeof ANALYTICS_SESSION_ORIGINS)[number];

export const ANALYTICS_PROGRESS_BUCKETS = [
	'0',
	'1-24',
	'25-49',
	'50-74',
	'75-99',
	'100'
] as const;
export type AnalyticsProgressBucket = (typeof ANALYTICS_PROGRESS_BUCKETS)[number];

export const ANALYTICS_ASSISTANCE_MODES = [
	'none',
	'hint',
	'reference',
	'ghost_reference',
	'mixed'
] as const;
export type AnalyticsAssistanceMode = (typeof ANALYTICS_ASSISTANCE_MODES)[number];

export const ANALYTICS_REFERENCE_MODES = ['hold', 'toggle', 'ghost'] as const;
export type AnalyticsReferenceMode = (typeof ANALYTICS_REFERENCE_MODES)[number];

export interface AnalyticsClientContextV1 {
	authentication: AnalyticsAuthenticationClass;
	viewportClass: AnalyticsViewportClass;
	primaryInput: AnalyticsPrimaryInput;
}

export interface AnalyticsPuzzleContextV1 extends AnalyticsClientContextV1 {
	puzzleSource: AnalyticsPuzzleSource;
	contentOrigin: AnalyticsContentOrigin;
	pieceCountBucket: AnalyticsPieceCountBucket;
	aspectBucket: AnalyticsAspectBucket;
	sessionMode: AnalyticsSessionMode;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	sessionOrigin: AnalyticsSessionOrigin;
	rotationUsed: boolean;
	progressBucket: AnalyticsProgressBucket;
	assistanceMode: AnalyticsAssistanceMode;
}

export type AnalyticsEventInputV1 =
	| {
			eventName: 'gallery_viewed';
			runId: null;
			context: AnalyticsClientContextV1;
			data: null;
	  }
	| {
			eventName: 'puzzle_opened';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: null;
	  }
	| {
			eventName: 'first_piece_placed';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: { mountToFirstPlacementMs: number };
	  }
	| {
			eventName: 'hint_used';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: null;
	  }
	| {
			eventName: 'reference_used';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: { referenceMode: AnalyticsReferenceMode };
	  }
	| {
			eventName: 'puzzle_completed';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: {
				elapsedActiveSeconds: number | null;
				hintsUsed: number;
				referenceActivations: number;
				countersSaturated: boolean;
			};
	  }
	| {
			eventName: 'personal_best_beaten';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: { elapsedActiveSeconds: number };
	  }
	| {
			eventName: 'puzzle_exited_incomplete';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: {
				elapsedActiveSeconds: number | null;
				placedPieceCount: number;
			};
	  };

type WithAnalyticsMetadata<T> = T extends AnalyticsEventInputV1
	? T & {
			schemaVersion: typeof ANALYTICS_EVENT_SCHEMA_VERSION;
			eventId: string;
			occurredAt: number;
	  }
	: never;

export type AnalyticsEventV1 = WithAnalyticsMetadata<AnalyticsEventInputV1>;

export interface AnalyticsBatchV1 {
	schemaVersion: typeof ANALYTICS_BATCH_SCHEMA_VERSION;
	events: AnalyticsEventV1[];
}

export type AnalyticsEventNameV1 = AnalyticsEventInputV1['eventName'];

export type AnalyticsOncePerRunEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{
		eventName:
			| 'puzzle_opened'
			| 'first_piece_placed'
			| 'hint_used'
			| 'reference_used'
			| 'puzzle_completed'
			| 'personal_best_beaten';
	}
>;

export type AnalyticsTrackedOccurrenceEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{ eventName: 'gallery_viewed' }
>;

export type PuzzleExitedIncompleteEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{ eventName: 'puzzle_exited_incomplete' }
>;

export type AnalyticsDeterministicRunEventNameV1 =
	AnalyticsOncePerRunEventInputV1['eventName'];

const EVENT_INPUT_KEYS = ['eventName', 'runId', 'context', 'data'] as const;
const EVENT_KEYS = [
	'eventName',
	'runId',
	'context',
	'data',
	'schemaVersion',
	'eventId',
	'occurredAt'
] as const;
const CLIENT_CONTEXT_KEYS = ['authentication', 'viewportClass', 'primaryInput'] as const;
const PUZZLE_CONTEXT_KEYS = [
	'authentication',
	'viewportClass',
	'primaryInput',
	'puzzleSource',
	'contentOrigin',
	'pieceCountBucket',
	'aspectBucket',
	'sessionMode',
	'resultClass',
	'timingQuality',
	'sessionOrigin',
	'rotationUsed',
	'progressBucket',
	'assistanceMode'
] as const;

const LOWERCASE_UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RESULT_CLASS_SET = new Set<string>(RESULT_CLASSES);
const TIMING_QUALITY_SET = new Set<string>(TIMING_QUALITIES);
const AUTHENTICATION_SET = new Set<string>(ANALYTICS_AUTHENTICATION_CLASSES);
const PUZZLE_SOURCE_SET = new Set<string>(ANALYTICS_PUZZLE_SOURCES);
const CONTENT_ORIGIN_SET = new Set<string>(ANALYTICS_CONTENT_ORIGINS);
const PIECE_COUNT_BUCKET_SET = new Set<string>(ANALYTICS_PIECE_COUNT_BUCKETS);
const ASPECT_BUCKET_SET = new Set<string>(ANALYTICS_ASPECT_BUCKETS);
const VIEWPORT_CLASS_SET = new Set<string>(ANALYTICS_VIEWPORT_CLASSES);
const PRIMARY_INPUT_SET = new Set<string>(ANALYTICS_PRIMARY_INPUTS);
const SESSION_MODE_SET = new Set<string>(ANALYTICS_SESSION_MODES);
const SESSION_ORIGIN_SET = new Set<string>(ANALYTICS_SESSION_ORIGINS);
const PROGRESS_BUCKET_SET = new Set<string>(ANALYTICS_PROGRESS_BUCKETS);
const ASSISTANCE_MODE_SET = new Set<string>(ANALYTICS_ASSISTANCE_MODES);
const REFERENCE_MODE_SET = new Set<string>(ANALYTICS_REFERENCE_MODES);
const DETERMINISTIC_EVENT_NAME_SET = new Set<string>([
	'puzzle_opened',
	'first_piece_placed',
	'hint_used',
	'reference_used',
	'puzzle_completed',
	'personal_best_beaten'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= min &&
		value <= max
	);
}

function isEnumValue(value: unknown, values: Set<string>): value is string {
	return typeof value === 'string' && values.has(value);
}

function isClientContextV1(value: unknown): value is AnalyticsClientContextV1 {
	if (!isRecord(value) || !hasExactKeys(value, CLIENT_CONTEXT_KEYS)) return false;
	return (
		isEnumValue(value.authentication, AUTHENTICATION_SET) &&
		isEnumValue(value.viewportClass, VIEWPORT_CLASS_SET) &&
		isEnumValue(value.primaryInput, PRIMARY_INPUT_SET)
	);
}

function isPuzzleContextV1(value: unknown): value is AnalyticsPuzzleContextV1 {
	if (!isRecord(value) || !hasExactKeys(value, PUZZLE_CONTEXT_KEYS)) return false;
	if (
		!isEnumValue(value.authentication, AUTHENTICATION_SET) ||
		!isEnumValue(value.viewportClass, VIEWPORT_CLASS_SET) ||
		!isEnumValue(value.primaryInput, PRIMARY_INPUT_SET) ||
		!isEnumValue(value.puzzleSource, PUZZLE_SOURCE_SET) ||
		!isEnumValue(value.contentOrigin, CONTENT_ORIGIN_SET) ||
		!isEnumValue(value.pieceCountBucket, PIECE_COUNT_BUCKET_SET) ||
		!isEnumValue(value.aspectBucket, ASPECT_BUCKET_SET) ||
		!isEnumValue(value.sessionMode, SESSION_MODE_SET) ||
		!isEnumValue(value.resultClass, RESULT_CLASS_SET) ||
		!isEnumValue(value.timingQuality, TIMING_QUALITY_SET) ||
		!isEnumValue(value.sessionOrigin, SESSION_ORIGIN_SET) ||
		typeof value.rotationUsed !== 'boolean' ||
		!isEnumValue(value.progressBucket, PROGRESS_BUCKET_SET) ||
		!isEnumValue(value.assistanceMode, ASSISTANCE_MODE_SET)
	) {
		return false;
	}

	const sessionMode = value.sessionMode as AnalyticsSessionMode;
	const resultClass = value.resultClass as ResultClass;
	const timingQuality = value.timingQuality as TimingQuality;
	const rotationUsed = value.rotationUsed;
	const assistanceMode = value.assistanceMode as AnalyticsAssistanceMode;

	if (sessionMode === 'relaxed') {
		if (resultClass !== 'relaxed' || timingQuality !== 'known') return false;
	} else if (resultClass === 'relaxed') {
		return false;
	}

	if (resultClass === 'rotation_timed' && !rotationUsed) return false;
	if (sessionMode === 'timed' && rotationUsed && resultClass === 'standard_timed') return false;

	const qualifyingAssistance =
		assistanceMode === 'hint' ||
		assistanceMode === 'ghost_reference' ||
		assistanceMode === 'mixed';
	if (sessionMode === 'timed' && qualifyingAssistance && resultClass !== 'assisted_timed') {
		return false;
	}
	if (
		sessionMode === 'timed' &&
		resultClass === 'assisted_timed' &&
		!qualifyingAssistance
	) {
		return false;
	}

	if (timingQuality === 'legacy_unknown' && resultClass === 'relaxed') return false;

	return true;
}

function isRunEventBase(
	value: Record<string, unknown>
): value is Record<string, unknown> & {
	runId: string;
	context: AnalyticsPuzzleContextV1;
} {
	return isPuzzleRunId(value.runId) && isPuzzleContextV1(value.context);
}

function isNull(value: unknown): value is null {
	return value === null;
}

function isFirstPlacementData(
	value: unknown
): value is { mountToFirstPlacementMs: number } {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['mountToFirstPlacementMs']) &&
		isSafeIntegerInRange(
			value.mountToFirstPlacementMs,
			0,
			ANALYTICS_MAX_MOUNT_TO_FIRST_PLACEMENT_MS
		)
	);
}

function isReferenceData(value: unknown): value is { referenceMode: AnalyticsReferenceMode } {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['referenceMode']) &&
		isEnumValue(value.referenceMode, REFERENCE_MODE_SET)
	);
}

function isCompletionData(
	value: unknown
): value is Extract<AnalyticsEventInputV1, { eventName: 'puzzle_completed' }>['data'] {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			'elapsedActiveSeconds',
			'hintsUsed',
			'referenceActivations',
			'countersSaturated'
		]) &&
		(value.elapsedActiveSeconds === null ||
			isSafeIntegerInRange(
				value.elapsedActiveSeconds,
				1,
				MAX_COMPLETION_TIME_SECONDS
			)) &&
		isSafeIntegerInRange(value.hintsUsed, 0, ANALYTICS_MAX_COUNTER) &&
		isSafeIntegerInRange(value.referenceActivations, 0, ANALYTICS_MAX_COUNTER) &&
		typeof value.countersSaturated === 'boolean' &&
		(!value.countersSaturated ||
			value.hintsUsed === ANALYTICS_MAX_COUNTER ||
			value.referenceActivations === ANALYTICS_MAX_COUNTER)
	);
}

function isPersonalBestData(value: unknown): value is { elapsedActiveSeconds: number } {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['elapsedActiveSeconds']) &&
		isSafeIntegerInRange(value.elapsedActiveSeconds, 1, MAX_COMPLETION_TIME_SECONDS)
	);
}

function isIncompleteExitData(value: unknown): value is {
	elapsedActiveSeconds: number | null;
	placedPieceCount: number;
} {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['elapsedActiveSeconds', 'placedPieceCount']) &&
		(value.elapsedActiveSeconds === null ||
			isSafeIntegerInRange(
				value.elapsedActiveSeconds,
				0,
				MAX_COMPLETION_TIME_SECONDS
			)) &&
		isSafeIntegerInRange(value.placedPieceCount, 0, MAX_PIECES)
	);
}

function completionContextMatchesCounters(
	context: AnalyticsPuzzleContextV1,
	data: Extract<AnalyticsEventInputV1, { eventName: 'puzzle_completed' }>['data']
): boolean {
	if (data.referenceActivations > 0) {
		if (context.assistanceMode === 'none' || context.assistanceMode === 'hint') return false;
	} else if (
		context.assistanceMode === 'reference' ||
		context.assistanceMode === 'ghost_reference' ||
		context.assistanceMode === 'mixed'
	) {
		return false;
	}

	if (data.hintsUsed > 0) {
		if (context.assistanceMode !== 'hint' && context.assistanceMode !== 'mixed') return false;
	} else if (context.assistanceMode === 'hint' || context.assistanceMode === 'mixed') {
		return false;
	}

	return true;
}

function completionTimingIsValid(
	runId: string,
	context: AnalyticsPuzzleContextV1,
	elapsedActiveSeconds: number | null
): boolean {
	return isRecordPuzzleCompletionV1(
		{
			version: 1,
			runId,
			resultClass: context.resultClass,
			timingQuality: context.timingQuality,
			elapsedActiveSeconds
		},
		MAX_COMPLETION_TIME_SECONDS
	);
}

export function buildAnalyticsRunEventIdV1(
	eventName: AnalyticsDeterministicRunEventNameV1,
	runId: string
): string {
	return `analytics:${ANALYTICS_EVENT_SCHEMA_VERSION}:${eventName}:${runId}`;
}

export function isAnalyticsEventInputV1(value: unknown): value is AnalyticsEventInputV1 {
	if (!isRecord(value) || !hasExactKeys(value, EVENT_INPUT_KEYS)) return false;

	switch (value.eventName) {
		case 'gallery_viewed':
			return value.runId === null && isClientContextV1(value.context) && isNull(value.data);
		case 'puzzle_opened':
			return isRunEventBase(value) && isNull(value.data);
		case 'first_piece_placed':
			return (
				isRunEventBase(value) &&
				value.context.progressBucket !== '0' &&
				isFirstPlacementData(value.data)
			);
		case 'hint_used':
			return (
				isRunEventBase(value) &&
				(value.context.assistanceMode === 'hint' ||
					value.context.assistanceMode === 'mixed') &&
				isNull(value.data)
			);
		case 'reference_used': {
			if (!isRunEventBase(value) || !isReferenceData(value.data)) return false;
			if (value.data.referenceMode === 'ghost') {
				return (
					value.context.assistanceMode === 'ghost_reference' ||
					value.context.assistanceMode === 'mixed'
				);
			}
			return (
				value.context.assistanceMode === 'reference' ||
				value.context.assistanceMode === 'mixed'
			);
		}
		case 'puzzle_completed': {
			if (
				!isRunEventBase(value) ||
				value.context.progressBucket !== '100' ||
				!isCompletionData(value.data)
			) {
				return false;
			}
			return (
				completionTimingIsValid(
					value.runId,
					value.context,
					value.data.elapsedActiveSeconds
				) && completionContextMatchesCounters(value.context, value.data)
			);
		}
		case 'personal_best_beaten':
			return (
				isRunEventBase(value) &&
				value.context.sessionMode === 'timed' &&
				value.context.resultClass === 'standard_timed' &&
				value.context.timingQuality === 'known' &&
				value.context.rotationUsed === false &&
				value.context.progressBucket === '100' &&
				value.context.assistanceMode === 'none' &&
				isPersonalBestData(value.data)
			);
		case 'puzzle_exited_incomplete':
			return isRunEventBase(value) && isIncompleteExitData(value.data);
		default:
			return false;
	}
}

function isDeterministicEventName(
	value: AnalyticsEventNameV1
): value is AnalyticsDeterministicRunEventNameV1 {
	return DETERMINISTIC_EVENT_NAME_SET.has(value);
}

export function isAnalyticsEventV1(value: unknown): value is AnalyticsEventV1 {
	if (!isRecord(value) || !hasExactKeys(value, EVENT_KEYS)) return false;
	if (
		value.schemaVersion !== ANALYTICS_EVENT_SCHEMA_VERSION ||
		!isSafeIntegerInRange(value.occurredAt, 0, Number.MAX_SAFE_INTEGER)
	) {
		return false;
	}

	const input = {
		eventName: value.eventName,
		runId: value.runId,
		context: value.context,
		data: value.data
	};
	if (!isAnalyticsEventInputV1(input) || typeof value.eventId !== 'string') return false;

	if (isDeterministicEventName(input.eventName)) {
		return (
			typeof input.runId === 'string' &&
			value.eventId === buildAnalyticsRunEventIdV1(input.eventName, input.runId)
		);
	}
	return LOWERCASE_UUID_V4.test(value.eventId);
}

export function isAnalyticsBatchV1(value: unknown): value is AnalyticsBatchV1 {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['schemaVersion', 'events']) &&
		value.schemaVersion === ANALYTICS_BATCH_SCHEMA_VERSION &&
		Array.isArray(value.events) &&
		value.events.length >= 1 &&
		value.events.length <= ANALYTICS_MAX_BATCH_SIZE &&
		value.events.every(isAnalyticsEventV1)
	);
}
