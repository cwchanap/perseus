import type { PuzzleDifficulty, ResultClass } from '@perseus/types';

export interface VersionedCompletionWrite {
	playerId: string;
	puzzleId: string;
	familyId: string;
	difficulty: PuzzleDifficulty;
	runId: string;
	resultClass: ResultClass;
	elapsedActiveSeconds: number | null;
	hintsUsed: number;
	incorrectAttempts: number;
	receivedAt: number;
}

export interface StoredCompletionFacts {
	puzzleId: string;
	familyId: string;
	difficulty: PuzzleDifficulty;
	resultClass: ResultClass;
	elapsedActiveSeconds: number | null;
	hintsUsed: number;
	incorrectAttempts: number;
	completedAt: number;
}

export const MAX_RETAINED_COMPLETION_RUNS = 100_000;

export type VersionedCompletionWriteExecution =
	| { status: 'stored'; stored: StoredCompletionFacts; inserted: boolean }
	| { status: 'tombstoned' }
	| { status: 'quota_exceeded' };

export interface CompletionWriteExecutor {
	write(input: VersionedCompletionWrite): Promise<VersionedCompletionWriteExecution>;
	beginPuzzleDeletion(puzzleId: string, deletedAt: number): Promise<void>;
	finishPuzzleDeletion(puzzleId: string): Promise<void>;
	isPuzzleTombstoned(puzzleId: string): Promise<boolean>;
}

export type VersionedCompletionResult =
	| { status: 'recorded'; completedAt: number }
	| { status: 'replayed'; completedAt: number }
	| { status: 'conflict' }
	| { status: 'tombstoned' }
	| { status: 'quota_exceeded' };

export function isCanonicalBest(input: VersionedCompletionWrite): boolean {
	return (
		(input.resultClass === 'standard_timed' || input.resultClass === 'rotation_timed') &&
		input.elapsedActiveSeconds !== null
	);
}

export function completionFactsMatch(
	input: VersionedCompletionWrite,
	stored: StoredCompletionFacts
): boolean {
	return (
		input.puzzleId === stored.puzzleId &&
		input.familyId === stored.familyId &&
		input.difficulty === stored.difficulty &&
		input.resultClass === stored.resultClass &&
		input.elapsedActiveSeconds === stored.elapsedActiveSeconds &&
		input.hintsUsed === stored.hintsUsed &&
		input.incorrectAttempts === stored.incorrectAttempts
	);
}

export function interpretVersionedCompletionWrite(
	input: VersionedCompletionWrite,
	execution: VersionedCompletionWriteExecution
): VersionedCompletionResult {
	if (execution.status !== 'stored') return { status: execution.status };
	if (!completionFactsMatch(input, execution.stored)) return { status: 'conflict' };
	return {
		status: execution.inserted ? 'recorded' : 'replayed',
		completedAt: execution.stored.completedAt
	};
}
