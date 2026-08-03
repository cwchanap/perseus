import { describe, expect, it } from 'vitest';
import {
	ANALYTICS_EVENT_SCHEMA_VERSION,
	buildAnalyticsRunEventIdV1,
	isAnalyticsEventInputV1,
	isAnalyticsEventV1,
	type AnalyticsPuzzleContextV1
} from './analytics';

const runId = '123e4567-e89b-42d3-a456-426614174000';

function context(
	overrides: Partial<AnalyticsPuzzleContextV1> = {}
): AnalyticsPuzzleContextV1 {
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
});
