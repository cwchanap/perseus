import { vi } from 'vitest';

/**
 * Yield real event-loop turns until the code under test has queued its
 * first fake timer, or the tracked promise has settled.
 *
 * `vi.runAllTimersAsync()` and `vi.advanceTimersByTimeAsync()` return
 * immediately when the fake-timer heap is empty, so calling one right
 * after starting `admin.fetch()` races the request preamble: the
 * handler's `c.req.formData()` parse finishes on real event-loop turns
 * (undici streams), and only then reaches the first `setTimeout`. If
 * the drain runs before that timer is queued, the timer never fires
 * and the test hangs for its full timeout. Node ≥24 needs more event-
 * loop turns for the preamble than Node 22, which is why these drains
 * started deadlocking under ubuntu-26.04 runners (Node 24) while
 * passing under ubuntu-24.04 (Node 22). Pump real turns until a timer
 * exists — `advanceTimersByTimeAsync(0)` always yields at least one
 * native macrotask — then drain as usual.
 */
export async function pumpUntilTimerOrSettled(promise: unknown, maxTurns = 1000): Promise<void> {
	let settled = false;
	void Promise.resolve(promise).then(
		() => (settled = true),
		() => (settled = true)
	);
	for (let i = 0; i < maxTurns && !settled && vi.getTimerCount() === 0; i++) {
		await vi.advanceTimersByTimeAsync(0);
	}
}
