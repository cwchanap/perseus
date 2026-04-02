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
	const hasInitialState = initialState !== undefined;
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
			if (currentIndex <= 0) {
				// At index 0 or below
				if (hasInitialState && !hasTrimmed && states.length === 1) {
					// Still at untouched initial state
					return false;
				}
				if (hasTrimmed) {
					// Can't go past trimmed history
					return false;
				}
				// Started empty, can go to -1
				return currentIndex === 0;
			}
			return true;
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
			hasTrimmed = false;
		}
	};
}
