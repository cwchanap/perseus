import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { createPuzzleSessionStore } from './store';
import type { Clock, PuzzleMetadata, RunIdFactory } from './types';

class ManualClock implements Clock {
	monotonic = 0;
	wall = 0;
	monotonicNow() {
		return this.monotonic;
	}
	wallNow() {
		return this.wall;
	}
	setInterval() {
		return null;
	}
	clearInterval() {}
	advance(ms: number) {
		this.monotonic += ms;
		this.wall += ms;
	}
}

function makeMetadata(pieceCount = 4): PuzzleMetadata {
	return {
		puzzleId: 'pz1',
		source: 'api',
		pieceCount,
		gridCols: 2,
		gridRows: Math.ceil(pieceCount / 2),
		pieces: Array.from({ length: pieceCount }, (_, i) => ({
			id: i,
			correctX: i % 2,
			correctY: Math.floor(i / 2)
		}))
	};
}

const runIdFactory: RunIdFactory = { create: () => 'run-1' };

function makeStore() {
	const clock = new ManualClock();
	return {
		clock,
		store: createPuzzleSessionStore({
			metadata: makeMetadata(),
			runIdFactory,
			clock
		})
	};
}

describe('createPuzzleSessionStore', () => {
	it('exposes the current state to a subscriber immediately', () => {
		const { store } = makeStore();
		expect(get(store).lifecycle).toBe('setup');
	});

	it('emits a notification on an accepted transition', () => {
		const { store } = makeStore();
		let latest = get(store).lifecycle;
		store.subscribe(() => {
			latest = get(store).lifecycle;
		});

		store.dispatch({ type: 'start' });

		expect(latest).toBe('active');
	});

	it('does not notify for a true no-op', () => {
		const { store } = makeStore();
		store.dispatch({ type: 'start' });
		let count = 0;
		store.subscribe(() => count++);
		const before = count;

		store.dispatch({ type: 'start' }); // already active -> no-op

		expect(count).toBe(before);
	});

	it('forwards the dispatch return value', () => {
		const { store } = makeStore();
		expect(store.dispatch({ type: 'start' }).type).toBe('lifecycle_transitioned');
	});

	it('forwards visibility and checkpoint', () => {
		const { clock, store } = makeStore();
		store.dispatch({ type: 'start' });
		store.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		store.setDocumentHidden(true);
		clock.advance(5_000);
		store.checkpointTime();
		store.setDocumentHidden(false);

		expect(get(store).lifecycle).toBe('active');
	});

	it('unsubscribe does not dispose the engine', () => {
		const { store } = makeStore();
		const unsub = store.subscribe(() => {});
		unsub();

		store.dispatch({ type: 'start' });

		expect(get(store).lifecycle).toBe('active');
	});

	it('dispose publishes terminal state and makes further actions inert', () => {
		const { store } = makeStore();
		store.subscribe(() => {});

		store.dispose();

		expect(get(store).lifecycle).toBe('disposed');
		store.dispatch({ type: 'start' });
		expect(get(store).lifecycle).toBe('disposed');
	});
});
