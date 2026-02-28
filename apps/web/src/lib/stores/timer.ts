import { writable, type Readable } from 'svelte/store';

export interface TimerState {
	elapsed: number;
	running: boolean;
}

export interface TimerStore extends Readable<TimerState> {
	start: () => void;
	pause: () => void;
	resume: () => void;
	reset: () => void;
	destroy: () => void;
}

export function formatTime(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function createTimerStore(): TimerStore {
	const { subscribe, set, update } = writable<TimerState>({
		elapsed: 0,
		running: false
	});

	let intervalId: ReturnType<typeof setInterval> | null = null;
	let wasRunningBeforeHidden = false;

	function tick() {
		update((state) => ({
			...state,
			elapsed: state.elapsed + 1
		}));
	}

	function startInterval() {
		if (intervalId !== null) return;
		intervalId = setInterval(tick, 1000);
	}

	function stopInterval() {
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}
	}

	function handleVisibilityChange() {
		if (document.hidden) {
			update((state) => {
				wasRunningBeforeHidden = state.running;
				if (state.running) {
					stopInterval();
					return { ...state, running: false };
				}
				return state;
			});
		} else {
			if (wasRunningBeforeHidden) {
				wasRunningBeforeHidden = false;
				update((state) => {
					startInterval();
					return { ...state, running: true };
				});
			}
		}
	}

	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', handleVisibilityChange);
	}

	function start() {
		update((state) => {
			if (state.running) return state;
			startInterval();
			return { ...state, running: true };
		});
	}

	function pause() {
		update((state) => {
			if (!state.running) return state;
			stopInterval();
			return { ...state, running: false };
		});
	}

	function resume() {
		start();
	}

	function reset() {
		stopInterval();
		wasRunningBeforeHidden = false;
		set({ elapsed: 0, running: false });
	}

	function destroy() {
		stopInterval();
		wasRunningBeforeHidden = false;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
	}

	return {
		subscribe,
		start,
		pause,
		resume,
		reset,
		destroy
	};
}
