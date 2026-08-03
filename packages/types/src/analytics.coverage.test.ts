import { describe, expect, it } from 'vitest';
import {
	ANALYTICS_EVENT_SCHEMA_VERSION,
	buildAnalyticsRunEventIdV1,
	isAnalyticsEventInputV1,
	isAnalyticsEventV1,
	type AnalyticsPuzzleContextV1
} from './analytics';

const runId = '123e4567-e89b-42d3-a456-426614174000';

function context(overrides: Partial<AnalyticsPuzzleContextV1> = {}): AnalyticsPuzzleContextV1 {
	return {
		authentication: 'anonymous',
		viewportClass: 'mobile',
		primaryInput: 'coarse_pointer',
		puzzleSource: 'local',
		contentOrigin: 'player_uploaded',
		pieceCountBucket: '1-24',
		aspectBucket: 'square',
		sessionMode: 'timed',
		resultClass: 'standard_timed',
		timingQuality: 'known',
		sessionOrigin: 'resumed',
		rotationUsed: false,
		progressBucket: '100',
		assistanceMode: 'none',
		...overrides
	};
}

describe('analytics validator branch coverage', () => {
	it('rejects a full-shape unknown event variant', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'unknown_event',
				runId,
				context: context(),
				data: null
			})
		).toBe(false);
	});

	it('validates Ghost Reference against cumulative assistance', () => {
		const valid = {
			eventName: 'reference_used',
			runId,
			context: context({
				resultClass: 'assisted_timed',
				assistanceMode: 'ghost_reference'
			}),
			data: { referenceMode: 'ghost' }
		};
		expect(isAnalyticsEventInputV1(valid)).toBe(true);
		expect(
			isAnalyticsEventInputV1({
				...valid,
				context: context({ assistanceMode: 'reference' })
			})
		).toBe(false);
	});

	it('rejects completion assistance that contradicts zero counters', () => {
		const base = {
			eventName: 'puzzle_completed',
			runId,
			data: {
				elapsedActiveSeconds: 30,
				hintsUsed: 0,
				referenceActivations: 0,
				countersSaturated: false
			}
		};
		expect(
			isAnalyticsEventInputV1({
				...base,
				context: context({ assistanceMode: 'reference' })
			})
		).toBe(false);
		expect(
			isAnalyticsEventInputV1({
				...base,
				context: context({
					resultClass: 'assisted_timed',
					assistanceMode: 'hint'
				})
			})
		).toBe(false);
	});

	it('rejects positive hint counts without matching assistance context', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_completed',
				runId,
				context: context(),
				data: {
					elapsedActiveSeconds: 30,
					hintsUsed: 1,
					referenceActivations: 0,
					countersSaturated: false
				}
			})
		).toBe(false);
	});

	it('rejects a non-string deterministic envelope ID', () => {
		expect(
			isAnalyticsEventV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({ progressBucket: '0' }),
				data: null,
				schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
				eventId: 123,
				occurredAt: 1
			})
		).toBe(false);
	});

	it('builds a deterministic ID for a valid run event', () => {
		expect(buildAnalyticsRunEventIdV1('puzzle_opened', runId)).toBe(
			`analytics:1:puzzle_opened:${runId}`
		);
	});

	it('rejects a relaxed result class paired with a timed session mode', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({ sessionMode: 'timed', resultClass: 'relaxed' }),
				data: null
			})
		).toBe(false);
	});

	it('rejects an assisted result class without qualifying assistance', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({ resultClass: 'assisted_timed', assistanceMode: 'none' }),
				data: null
			})
		).toBe(false);
	});

	it('rejects a relaxed session with a non-relaxed result class', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({
					sessionMode: 'relaxed',
					resultClass: 'standard_timed',
					timingQuality: 'known'
				}),
				data: null
			})
		).toBe(false);
	});

	it('rejects a relaxed session with legacy_unknown timing quality', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({
					sessionMode: 'relaxed',
					resultClass: 'relaxed',
					timingQuality: 'legacy_unknown'
				}),
				data: null
			})
		).toBe(false);
	});

	it('rejects a timed session with rotation but standard_timed result class', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({
					sessionMode: 'timed',
					resultClass: 'standard_timed',
					rotationUsed: true
				}),
				data: null
			})
		).toBe(false);
	});

	it('rejects a legacy_unknown timing quality paired with a relaxed result class', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_opened',
				runId,
				context: context({
					sessionMode: 'timed',
					resultClass: 'relaxed',
					timingQuality: 'legacy_unknown'
				}),
				data: null
			})
		).toBe(false);
	});

	it('accepts a completion event with null elapsedActiveSeconds', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_completed',
				runId,
				context: context({
					sessionMode: 'relaxed',
					resultClass: 'relaxed',
					timingQuality: 'known',
					progressBucket: '100',
					assistanceMode: 'none'
				}),
				data: {
					elapsedActiveSeconds: null,
					hintsUsed: 0,
					referenceActivations: 0,
					countersSaturated: false
				}
			})
		).toBe(true);
	});

	it('accepts a saturated completion event via hintsUsed alone', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_completed',
				runId,
				context: context({
					progressBucket: '100',
					assistanceMode: 'hint',
					resultClass: 'assisted_timed'
				}),
				data: {
					elapsedActiveSeconds: 60,
					hintsUsed: 10_000,
					referenceActivations: 0,
					countersSaturated: true
				}
			})
		).toBe(true);
	});

	it('accepts a completion event with reference activations and a reference assistance mode', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_completed',
				runId,
				context: context({
					progressBucket: '100',
					assistanceMode: 'ghost_reference',
					resultClass: 'assisted_timed'
				}),
				data: {
					elapsedActiveSeconds: 60,
					hintsUsed: 0,
					referenceActivations: 3,
					countersSaturated: false
				}
			})
		).toBe(true);
	});

	it('accepts a completion event with hints used and a hint assistance mode', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_completed',
				runId,
				context: context({
					progressBucket: '100',
					assistanceMode: 'hint',
					resultClass: 'assisted_timed'
				}),
				data: {
					elapsedActiveSeconds: 60,
					hintsUsed: 2,
					referenceActivations: 0,
					countersSaturated: false
				}
			})
		).toBe(true);
	});

	it('accepts a hint_used event with a mixed assistance mode', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'hint_used',
				runId,
				context: context({ assistanceMode: 'mixed', resultClass: 'assisted_timed' }),
				data: null
			})
		).toBe(true);
	});

	it('rejects a reference_used event whose data is not reference data', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'reference_used',
				runId,
				context: context({ assistanceMode: 'reference', resultClass: 'assisted_timed' }),
				data: null
			})
		).toBe(false);
	});

	it('accepts a reference_used event with a non-ghost mode and mixed assistance', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'reference_used',
				runId,
				context: context({ assistanceMode: 'mixed', resultClass: 'assisted_timed' }),
				data: { referenceMode: 'hold' }
			})
		).toBe(true);
	});

	it('rejects an event whose client context fails validation', () => {
		expect(
			isAnalyticsEventV1({
				eventSchemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
				eventId: buildAnalyticsRunEventIdV1('puzzle_opened', runId),
				eventName: 'puzzle_opened',
				runId,
				occurredAt: 1_000,
				context: { ...context(), authentication: 'unknown' as never },
				data: null
			})
		).toBe(false);
	});

	it('rejects a gallery_viewed event with a non-record context', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'gallery_viewed',
				runId: null,
				context: null,
				data: null
			})
		).toBe(false);
	});

	it('rejects a completion event with out-of-range hintsUsed', () => {
		expect(
			isAnalyticsEventInputV1({
				eventName: 'puzzle_completed',
				runId,
				context: context({
					progressBucket: '100',
					assistanceMode: 'hint',
					resultClass: 'assisted_timed'
				}),
				data: {
					elapsedActiveSeconds: 60,
					hintsUsed: -1,
					referenceActivations: 0,
					countersSaturated: false
				}
			})
		).toBe(false);
	});
});
