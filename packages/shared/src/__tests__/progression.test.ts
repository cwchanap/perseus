import { describe, it, expect } from 'vitest';
import {
	masteryForCompletion,
	evaluateAchievements,
	ACHIEVEMENT_IDS,
	type AchievementSnapshot
} from '../progression';

describe('masteryForCompletion', () => {
	it('awards hintless, flawless, and rotation_clear for a perfect rotation run', () => {
		expect(
			masteryForCompletion({
				hintsUsed: 0,
				incorrectAttempts: 0,
				resultClass: 'rotation_timed'
			})
		).toEqual(['hintless', 'flawless', 'rotation_clear']);
	});

	it('awards only hintless when hints are zero but attempts are not', () => {
		expect(
			masteryForCompletion({
				hintsUsed: 0,
				incorrectAttempts: 2,
				resultClass: 'standard_timed'
			})
		).toEqual(['hintless']);
	});

	it('awards only flawless when attempts are zero but hints were used', () => {
		expect(
			masteryForCompletion({
				hintsUsed: 1,
				incorrectAttempts: 0,
				resultClass: 'assisted_timed'
			})
		).toEqual(['flawless']);
	});

	it('awards no badges when hints and attempts were used on a standard run', () => {
		expect(
			masteryForCompletion({
				hintsUsed: 1,
				incorrectAttempts: 1,
				resultClass: 'standard_timed'
			})
		).toEqual([]);
	});

	it('awards no badges on a relaxed run with zero hints and attempts', () => {
		expect(
			masteryForCompletion({
				hintsUsed: 0,
				incorrectAttempts: 0,
				resultClass: 'relaxed'
			})
		).toEqual(['hintless', 'flawless']);
	});
});

function snapshot(overrides: Partial<AchievementSnapshot> = {}): AchievementSnapshot {
	return {
		uniqueClears: 0,
		hardClears: 0,
		hasFullSetOnAnyFamily: false,
		hasHintlessMastery: false,
		hasFlawlessMastery: false,
		hasRotationClearMastery: false,
		...overrides
	};
}

describe('evaluateAchievements', () => {
	it.each([
		{ uniqueClears: 0, expected: [] as string[] },
		{ uniqueClears: 1, expected: [ACHIEVEMENT_IDS.first_clear] },
		{ uniqueClears: 4, expected: [ACHIEVEMENT_IDS.first_clear] },
		{
			uniqueClears: 5,
			expected: [ACHIEVEMENT_IDS.first_clear, ACHIEVEMENT_IDS.getting_started]
		},
		{
			uniqueClears: 14,
			expected: [ACHIEVEMENT_IDS.first_clear, ACHIEVEMENT_IDS.getting_started]
		},
		{
			uniqueClears: 15,
			expected: [
				ACHIEVEMENT_IDS.first_clear,
				ACHIEVEMENT_IDS.getting_started,
				ACHIEVEMENT_IDS.puzzle_regular
			]
		}
	])(
		'unlocks clear-count achievements at uniqueClears=$uniqueClears',
		({ uniqueClears, expected }) => {
			expect(evaluateAchievements(snapshot({ uniqueClears }))).toEqual(expected);
		}
	);

	it.each([
		{ hardClears: 0, expected: [] as string[] },
		{ hardClears: 1, expected: [ACHIEVEMENT_IDS.hard_mode] },
		{ hardClears: 4, expected: [ACHIEVEMENT_IDS.hard_mode] },
		{ hardClears: 5, expected: [ACHIEVEMENT_IDS.hard_mode, ACHIEVEMENT_IDS.hard_veteran] }
	])('unlocks hard achievements at hardClears=$hardClears', ({ hardClears, expected }) => {
		expect(evaluateAchievements(snapshot({ hardClears }))).toEqual(expected);
	});

	it('unlocks full_set when any family has all three difficulties', () => {
		expect(evaluateAchievements(snapshot({ hasFullSetOnAnyFamily: true }))).toEqual([
			ACHIEVEMENT_IDS.full_set
		]);
	});

	it('unlocks mastery achievements from snapshot flags', () => {
		expect(
			evaluateAchievements(
				snapshot({
					hasHintlessMastery: true,
					hasFlawlessMastery: true,
					hasRotationClearMastery: true
				})
			)
		).toEqual([ACHIEVEMENT_IDS.hintless, ACHIEVEMENT_IDS.flawless, ACHIEVEMENT_IDS.rotation_clear]);
	});

	it('combines all nine achievements when every predicate is satisfied', () => {
		expect(
			evaluateAchievements(
				snapshot({
					uniqueClears: 15,
					hardClears: 5,
					hasFullSetOnAnyFamily: true,
					hasHintlessMastery: true,
					hasFlawlessMastery: true,
					hasRotationClearMastery: true
				})
			)
		).toEqual([
			ACHIEVEMENT_IDS.first_clear,
			ACHIEVEMENT_IDS.getting_started,
			ACHIEVEMENT_IDS.puzzle_regular,
			ACHIEVEMENT_IDS.full_set,
			ACHIEVEMENT_IDS.hard_mode,
			ACHIEVEMENT_IDS.hard_veteran,
			ACHIEVEMENT_IDS.hintless,
			ACHIEVEMENT_IDS.flawless,
			ACHIEVEMENT_IDS.rotation_clear
		]);
	});
});
