// Thin Svelte Readable wrapper around one PuzzleSession engine instance.
//
// The wrapper adapts the engine's framework-neutral subscribe to Svelte's
// Readable contract and forwards dispatch/visibility/checkpoint/dispose. It
// performs no persistence or fetch behavior itself.
//
// A plain subscriber Set is used instead of svelte/store's readable() to avoid
// forcing synchronous Svelte 5 flushes during event dispatch. The legacy
// readable() set() integrates with Svelte's internal scheduler and can trigger
// mid-event re-renders that cause Svelte 5 event delegation to fire handlers
// twice. By calling subscribers directly, $state writes from subscribe
// callbacks are batched normally (deferred to the next microtask), preventing
// stale-handler double-fire.

import { type Readable } from 'svelte/store';
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
	const subscribers = new Set<(value: Readonly<PuzzleSessionState>) => void>();

	let currentSnapshot = engine.getState();

	engine.subscribe(() => {
		currentSnapshot = engine.getState();
		for (const subscriber of subscribers) {
			subscriber(currentSnapshot);
		}
	});

	return {
		subscribe(callback: (value: Readonly<PuzzleSessionState>) => void) {
			callback(currentSnapshot);
			subscribers.add(callback);
			return () => {
				subscribers.delete(callback);
			};
		},
		dispatch: (action) => engine.dispatch(action),
		setDocumentHidden: (hidden) => engine.setDocumentHidden(hidden),
		checkpointTime: () => engine.checkpointTime(),
		dispose: () => engine.dispose()
	};
}
