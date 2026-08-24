// Default Clock over standard global time/scheduler primitives
// (performance.now, Date.now, setInterval/clearInterval). Tests and
// NativeScript may inject their own Clock instead.
import type { Clock } from './session/types';

export function createDefaultClock(): Clock {
	return {
		monotonicNow: () => performance.now(),
		wallNow: () => Date.now(),
		setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
		clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
	};
}
