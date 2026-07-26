import type { ResultClass, TimingQuality } from '@perseus/types';

export interface VersionedCompletionWrite {
	playerId: string;
	puzzleId: string;
	runId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
	receivedAt: number;
}

export interface StoredCompletionFacts {
	puzzleId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
	completedAt: number;
}

export interface CompletionWriteExecution {
	stored: StoredCompletionFacts;
	inserted: boolean;
}

export interface CompletionWriteExecutor {
	write(input: VersionedCompletionWrite): Promise<CompletionWriteExecution>;
	deletePuzzleCompletionData(puzzleId: string): Promise<void>;
}

export type VersionedCompletionResult =
	| { status: 'recorded'; completedAt: number }
	| { status: 'replayed'; completedAt: number }
	| { status: 'conflict' };

export function isCanonicalBest(input: VersionedCompletionWrite): boolean {
	return (
		input.resultClass === 'standard_timed' &&
		input.timingQuality === 'known' &&
		input.elapsedActiveSeconds !== null
	);
}

export function completionFactsMatch(
	input: VersionedCompletionWrite,
	stored: StoredCompletionFacts
): boolean {
	return (
		input.puzzleId === stored.puzzleId &&
		input.resultClass === stored.resultClass &&
		input.timingQuality === stored.timingQuality &&
		input.elapsedActiveSeconds === stored.elapsedActiveSeconds
	);
}

export function interpretVersionedCompletionWrite(
	input: VersionedCompletionWrite,
	stored: StoredCompletionFacts,
	inserted: boolean
): VersionedCompletionResult {
	if (!completionFactsMatch(input, stored)) return { status: 'conflict' };
	return {
		status: inserted ? 'recorded' : 'replayed',
		completedAt: stored.completedAt
	};
}
