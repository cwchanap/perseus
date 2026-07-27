// Thin Svelte Readable wrapper around one PuzzleSession engine instance.
//
// The wrapper adapts the engine's framework-neutral subscribe to Svelte's
// Readable contract and forwards dispatch/visibility/checkpoint/dispose. It
// performs no persistence or fetch behavior itself.

import { readable, type Readable } from 'svelte/store';
import { createPuzzleSession, type PuzzleSession } from './session';
import type {
	CreatePuzzleSessionOptions,
	PuzzleSessionAction,
	PuzzleSessionOutcome,
	PuzzleSessionState
} from './types';

export interface PuzzleSessionStore extends Readable<Readonly<PuzzleSessionState>> {
	dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
	setDocumentHidden(hidden: boolean): void;
	checkpointTime(): void;
	dispose(): void;
}

export function createPuzzleSessionStore(options: CreatePuzzleSessionOptions): PuzzleSessionStore {
	const engine: PuzzleSession = createPuzzleSession(options);

	const readableStore = readable<Readonly<PuzzleSessionState>>(engine.getState(), (set) => {
		set(engine.getState());
		const unsubscribe = engine.subscribe(() => set(engine.getState()));
		return unsubscribe;
	});

	return {
		subscribe: readableStore.subscribe,
		dispatch: (action) => engine.dispatch(action),
		setDocumentHidden: (hidden) => engine.setDocumentHidden(hidden),
		checkpointTime: () => engine.checkpointTime(),
		dispose: () => engine.dispose()
	};
}
