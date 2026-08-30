// Framework-free session policy for the mobile gameplay screen: four
// deterministic helpers only. No Svelte, no NativeScript, no state.
import type {
	PersistedPuzzleSessionV1,
	PersistedViewport,
	PuzzleSession,
	PuzzleSessionOutcome,
	SessionStorageAdapter
} from '@perseus/game-core';

export type EntrySheet = 'setup' | 'pause' | null;

/** Fresh run -> setup; active restore -> gameplay directly; paused -> pause. */
export function entrySheetFor(
	restored: Pick<PersistedPuzzleSessionV1, 'lifecycle'> | undefined
): EntrySheet {
	if (!restored) return 'setup';
	return restored.lifecycle === 'paused' ? 'pause' : null;
}

/** Background ordering is load-bearing: hide first (engine stops the clock), then save. */
export function suspendSession(
	session: Pick<PuzzleSession, 'setDocumentHidden'>,
	save: () => void
): void {
	session.setDocumentHidden(true);
	save();
}

/** Dispatches set_viewport and persists only an accepted change. */
export function commitViewport(
	session: Pick<PuzzleSession, 'dispatch'>,
	viewport: PersistedViewport | null,
	save: () => void
): PuzzleSessionOutcome {
	const outcome = session.dispatch({ type: 'set_viewport', viewport });
	if (outcome.type === 'viewport_changed') save();
	return outcome;
}

/** Clears the persisted session; the boolean is the storage adapter's own result. */
export function discardProgress(
	storage: Pick<SessionStorageAdapter, 'clearSession'>,
	puzzleId: string
): boolean {
	return storage.clearSession(puzzleId);
}
