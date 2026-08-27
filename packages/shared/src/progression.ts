import type { ResultClass } from '@perseus/types';

export type MasteryBadge = 'hintless' | 'flawless' | 'rotation_clear';

export const ACHIEVEMENT_IDS = {
	first_clear: 'first_clear',
	getting_started: 'getting_started',
	puzzle_regular: 'puzzle_regular',
	full_set: 'full_set',
	hard_mode: 'hard_mode',
	hard_veteran: 'hard_veteran',
	hintless: 'hintless',
	flawless: 'flawless',
	rotation_clear: 'rotation_clear'
} as const;

export type AchievementId = (typeof ACHIEVEMENT_IDS)[keyof typeof ACHIEVEMENT_IDS];

export const ACHIEVEMENT_POINTS: Record<AchievementId, number> = {
	first_clear: 25,
	getting_started: 50,
	puzzle_regular: 100,
	full_set: 75,
	hard_mode: 50,
	hard_veteran: 100,
	hintless: 25,
	flawless: 25,
	rotation_clear: 25
};

export interface AchievementSnapshot {
	uniqueClears: number;
	hardClears: number;
	hasFullSetOnAnyFamily: boolean;
	hasHintlessMastery: boolean;
	hasFlawlessMastery: boolean;
	hasRotationClearMastery: boolean;
}

export function masteryForCompletion(input: {
	hintsUsed: number;
	incorrectAttempts: number;
	resultClass: ResultClass;
}): MasteryBadge[] {
	const badges: MasteryBadge[] = [];
	if (input.hintsUsed === 0) badges.push('hintless');
	if (input.incorrectAttempts === 0) badges.push('flawless');
	if (input.resultClass === 'rotation_timed') badges.push('rotation_clear');
	return badges;
}

export function evaluateAchievements(snapshot: AchievementSnapshot): AchievementId[] {
	const earned: AchievementId[] = [];
	if (snapshot.uniqueClears >= 1) earned.push(ACHIEVEMENT_IDS.first_clear);
	if (snapshot.uniqueClears >= 5) earned.push(ACHIEVEMENT_IDS.getting_started);
	if (snapshot.uniqueClears >= 15) earned.push(ACHIEVEMENT_IDS.puzzle_regular);
	if (snapshot.hasFullSetOnAnyFamily) earned.push(ACHIEVEMENT_IDS.full_set);
	if (snapshot.hardClears >= 1) earned.push(ACHIEVEMENT_IDS.hard_mode);
	if (snapshot.hardClears >= 5) earned.push(ACHIEVEMENT_IDS.hard_veteran);
	if (snapshot.hasHintlessMastery) earned.push(ACHIEVEMENT_IDS.hintless);
	if (snapshot.hasFlawlessMastery) earned.push(ACHIEVEMENT_IDS.flawless);
	if (snapshot.hasRotationClearMastery) earned.push(ACHIEVEMENT_IDS.rotation_clear);
	return earned;
}
