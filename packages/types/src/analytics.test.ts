import { describe, expect, it } from 'vitest';
import {
	ANALYTICS_BATCH_SCHEMA_VERSION,
	ANALYTICS_EVENT_SCHEMA_VERSION,
	ANALYTICS_MAX_BATCH_SIZE,
	ANALYTICS_MAX_COUNTER,
	ANALYTICS_MAX_MOUNT_TO_FIRST_PLACEMENT_MS,
	buildAnalyticsRunEventIdV1,
	isAnalyticsBatchV1,
	isAnalyticsEventInputV1,
	isAnalyticsEventV1,
	type AnalyticsEventInputV1,
	type AnalyticsEventV1,
	type AnalyticsPuzzleContextV1
} from './analytics';

const runId = '123e4567-e89b-42d3-a456-426614174000';
const galleryEventId = '11111111-1111-4111-8111-111111111111';
const exitEventId = '22222222-2222-4222-8222-222222222222';

function makeContext(
	overrides: Partial<AnalyticsPuzzleContextV1> = {}
): AnalyticsPuzzleContextV1 {
	return {
		authentication: 'unknown',
		viewportClass: 'desktop',
		primaryInput: 'fine_pointer',
		puzzleSource: 'api',
		contentOrigin: 'unknown',
		pieceCountBucket: '150-225',
		aspectBucket: 'landscape',
		sessionMode: 'timed',
		resultClass: 'standard_timed',
		timingQuality: 'known',
		sessionOrigin: 'new',
		rotationUsed: false,
		progressBucket: '0',
		assistanceMode: 'none',
		...overrides
	};
}

function materialize(input: AnalyticsEventInputV1, occurredAt = 1_000): AnalyticsEventV1 {
	const eventId =
		input.eventName === 'gallery_viewed'
			? galleryEventId
			: input.eventName === 'puzzle_exited_incomplete'
				? exitEventId
				: buildAnalyticsRunEventIdV1(input.eventName, input.runId);
	return {
		...input,
		schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
		eventId,
		occurredAt
	} as AnalyticsEventV1;
}

function validInputs(): AnalyticsEventInputV1[] {
	return [
		{
			eventName: 'gallery_viewed',
			runId: null,
			context: {
				authentication: 'unknown',
				viewportClass: 'desktop',
				primaryInput: 'fine_pointer'
			},
			data: null
		},
		{
			eventName: 'puzzle_opened',
			runId,
			context: makeContext(),
			data: null
		},
		{
			eventName: 'first_piece_placed',
			runId,
			context: makeContext({ progressBucket: '1-24' }),
			data: { mountToFirstPlacementMs: 250 }
		},
		{
			eventName: 'hint_used',
			runId,
			context: makeContext({
				resultClass: 'assisted_timed',
				assistanceMode: 'hint'
			}),
			data: null
		},
		{
			eventName: 'reference_used',
			runId,
			context: makeContext({ assistanceMode: 'reference' }),
			data: { referenceMode: 'hold' }
		},
		{
			eventName: 'puzzle_completed',
			runId,
			context: makeContext({ progressBucket: '100' }),
			data: {
				elapsedActiveSeconds: 120,
				hintsUsed: 0,
				referenceActivations: 0,
				countersSaturated: false
			}
		},
		{
			eventName: 'personal_best_beaten',
			runId,
			context: makeContext({ progressBucket: '100' }),
			data: { elapsedActiveSeconds: 120 }
		},
		{
			eventName: 'puzzle_exited_incomplete',
			runId,
			context: makeContext({ progressBucket: '25-49' }),
			data: { elapsedActiveSeconds: 15, placedPieceCount: 80 }
		}
	];
}

describe('analytics v1 constants', () => {
	it('locks schema and delivery limits', () => {
		expect(ANALYTICS_EVENT_SCHEMA_VERSION).toBe(1);
		expect(ANALYTICS_BATCH_SCHEMA_VERSION).toBe(1);
		expect(ANALYTICS_MAX_BATCH_SIZE).toBe(20);
		expect(ANALYTICS_MAX_COUNTER).toBe(10_000);
		expect(ANALYTICS_MAX_MOUNT_TO_FIRST_PLACEMENT_MS).toBe(86_400_000);
	});
});

describe('analytics v1 input validation', () => {
	it.each(validInputs())('accepts $eventName', (input) => {
		expect(isAnalyticsEventInputV1(input)).toBe(true);
	});

	it('accepts auth unknown without dropping the event', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: makeContext({ authentication: 'unknown' }),
				data: null
			})
		).toBe(true);
	});

	it.each([
		{ name: 'unknown event', value: { eventName: 'made_up' } },
		{
			name: 'extra root key',
			value: { ...validInputs()[1], puzzleId: 'forbidden' }
		},
		{
			name: 'extra context key',
			value: {
				...validInputs()[1],
				context: { ...makeContext(), userAgent: 'forbidden' }
			}
		},
		{
			name: 'bad run id',
			value: { ...validInputs()[1], runId: 'not-a-run-id' }
		},
		{
			name: 'bad auth class',
			value: {
				...validInputs()[1],
				context: { ...makeContext(), authentication: 'loading' }
			}
		},
		{
			name: 'relaxed mode with timed result',
			value: {
				...validInputs()[1],
				context: makeContext({ sessionMode: 'relaxed', resultClass: 'standard_timed' })
			}
		},
		{
			name: 'rotation result without rotation fact',
			value: {
				...validInputs()[1],
				context: makeContext({ resultClass: 'rotation_timed', rotationUsed: false })
			}
		},
		{
			name: 'hint result without assisted class',
			value: {
				...validInputs()[3],
				context: makeContext({ assistanceMode: 'hint', resultClass: 'standard_timed' })
			}
		},
		{
			name: 'completion without progress 100',
			value: {
				...validInputs()[5],
				context: makeContext({ progressBucket: '75-99' })
			}
		},
		{
			name: 'completion reference contradiction',
			value: {
				...validInputs()[5],
				context: makeContext({ progressBucket: '100', assistanceMode: 'none' }),
				data: {
					elapsedActiveSeconds: 120,
					hintsUsed: 0,
					referenceActivations: 1,
					countersSaturated: false
				}
			}
		},
		{
			name: 'personal best with rotation',
			value: {
				...validInputs()[6],
				context: makeContext({
					progressBucket: '100',
					rotationUsed: true,
					resultClass: 'rotation_timed'
				})
			}
		},
		{
			name: 'negative placement latency',
			value: {
				...validInputs()[2],
				data: { mountToFirstPlacementMs: -1 }
			}
		},
		{
			name: 'placement latency above cap',
			value: {
				...validInputs()[2],
				data: {
					mountToFirstPlacementMs: ANALYTICS_MAX_MOUNT_TO_FIRST_PLACEMENT_MS + 1
				}
			}
		},
		{
			name: 'counter above cap',
			value: {
				...validInputs()[5],
				data: {
					elapsedActiveSeconds: 120,
					hintsUsed: ANALYTICS_MAX_COUNTER + 1,
					referenceActivations: 0,
					countersSaturated: true
				}
			}
		}
	])('rejects $name', ({ value }) => {
		expect(isAnalyticsEventInputV1(value)).toBe(false);
	});
});

describe('analytics v1 envelope validation', () => {
	it.each(validInputs())('accepts a materialized $eventName envelope', (input) => {
		expect(isAnalyticsEventV1(materialize(input))).toBe(true);
	});

	it('requires deterministic IDs for once-per-run events', () => {
		const event = materialize(validInputs()[1]);
		expect(isAnalyticsEventV1({ ...event, eventId: galleryEventId })).toBe(false);
	});

	it('requires canonical UUID v4 IDs for occurrence events', () => {
		const event = materialize(validInputs()[0]);
		expect(isAnalyticsEventV1({ ...event, eventId: galleryEventId.toUpperCase() })).toBe(false);
	});

	it('rejects unsafe timestamps and extra envelope fields', () => {
		const event = materialize(validInputs()[1]);
		expect(isAnalyticsEventV1({ ...event, occurredAt: -1 })).toBe(false);
		expect(isAnalyticsEventV1({ ...event, receivedAt: 1_001 })).toBe(false);
	});
});

describe('analytics v1 batch validation', () => {
	it('accepts a non-empty bounded batch', () => {
		expect(
			isAnalyticsBatchV1({
				schemaVersion: ANALYTICS_BATCH_SCHEMA_VERSION,
				events: validInputs().slice(0, 2).map((input) => materialize(input))
			})
		).toBe(true);
	});

	it('rejects empty, oversized, wrong-version, and extra-key batches', () => {
		expect(isAnalyticsBatchV1({ schemaVersion: 1, events: [] })).toBe(false);
		expect(
			isAnalyticsBatchV1({
				schemaVersion: 1,
				events: Array.from({ length: ANALYTICS_MAX_BATCH_SIZE + 1 }, () =>
					materialize(validInputs()[1])
				)
			})
		).toBe(false);
		expect(
			isAnalyticsBatchV1({ schemaVersion: 2, events: [materialize(validInputs()[1])] })
		).toBe(false);
		expect(
			isAnalyticsBatchV1({
				schemaVersion: 1,
				events: [materialize(validInputs()[1])],
				puzzleId: 'forbidden'
			})
		).toBe(false);
	});
});

const invalidEventName: AnalyticsEventInputV1 = {
	// @ts-expect-error arbitrary event variants are forbidden
	eventName: 'made_up',
	runId,
	context: makeContext(),
	data: null
};
void invalidEventName;

const invalidProperties: AnalyticsEventInputV1 = {
	eventName: 'puzzle_opened',
	runId,
	context: makeContext(),
	data: null,
	// @ts-expect-error free-form properties are forbidden
	properties: {}
};
void invalidProperties;
