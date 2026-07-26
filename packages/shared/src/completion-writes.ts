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

export interface LegacyCompletionWrite {
	playerId: string;
	puzzleId: string;
	timeSeconds: number;
	receivedAt: number;
}

export interface StoredCompletionFacts {
	puzzleId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
	completedAt: number;
}

export const MAX_RETAINED_COMPLETION_RUNS = 100_000;

export type VersionedCompletionWriteExecution =
	| { status: 'stored'; stored: StoredCompletionFacts; inserted: boolean }
	| { status: 'tombstoned' }
	| { status: 'quota_exceeded' };

export type LegacyCompletionWriteExecution = { status: 'recorded' } | { status: 'tombstoned' };

export interface CompletionWriteExecutor {
	write(input: VersionedCompletionWrite): Promise<VersionedCompletionWriteExecution>;
	writeLegacy(input: LegacyCompletionWrite): Promise<LegacyCompletionWriteExecution>;
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
	execution: VersionedCompletionWriteExecution
): VersionedCompletionResult {
	if (execution.status !== 'stored') return { status: execution.status };
	if (!completionFactsMatch(input, execution.stored)) return { status: 'conflict' };
	return {
		status: execution.inserted ? 'recorded' : 'replayed',
		completedAt: execution.stored.completedAt
	};
}
