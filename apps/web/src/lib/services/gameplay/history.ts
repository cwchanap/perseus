// Undo/redo history helper (transient, in-memory only)

export interface History<T> {
	push(state: T): void;
	undo(): T | undefined;
	redo(): T | undefined;
	canUndo(): boolean;
	canRedo(): boolean;
	getCurrent(): T | undefined;
	clear(): void;
}

export function createHistory<T>(initialState?: T, maxSize = 50): History<T> {
	let states: T[] = initialState !== undefined ? [initialState] : [];
	let currentIndex = initialState !== undefined ? 0 : -1;
	let hasInitialState = initialState !== undefined;
	let hasTrimmed = false;

	return {
		push(state: T): void {
			if (currentIndex < states.length - 1) {
				states = states.slice(0, currentIndex + 1);
			}

			states.push(state);
			currentIndex++;

			if (states.length > maxSize) {
				states = states.slice(states.length - maxSize);
				currentIndex = states.length - 1;
				hasTrimmed = true;
			}
		},

		undo(): T | undefined {
			if (!this.canUndo()) return undefined;
			currentIndex--;
			return currentIndex >= 0 ? states[currentIndex] : undefined;
		},

		redo(): T | undefined {
			if (currentIndex >= states.length - 1) return undefined;
			currentIndex++;
			return states[currentIndex];
		},

		canUndo(): boolean {
			// Can undo if we're beyond the minimum allowed index
			// - If started with initial state: minimum is index 0
			// - If started empty: minimum is index -1 (after first undo, returns undefined)
			// - After trimming: minimum is index 0 (can't go past trimmed history)
			const minIndex = hasInitialState || hasTrimmed ? 0 : -1;
			return currentIndex > minIndex;
		},

		canRedo(): boolean {
			return currentIndex < states.length - 1;
		},

		getCurrent(): T | undefined {
			return currentIndex >= 0 ? states[currentIndex] : undefined;
		},

		clear(): void {
			states = [];
			currentIndex = -1;
			hasInitialState = false;
			hasTrimmed = false;
		}
	};
}
