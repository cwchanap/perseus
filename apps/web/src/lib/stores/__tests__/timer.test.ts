import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatTime, createTimerStore } from '../timer';
import type { TimerState } from '../timer';

describe('formatTime', () => {
	it('formats zero as 00:00', () => {
		expect(formatTime(0)).toBe('00:00');
	});

	it('formats seconds under a minute', () => {
		expect(formatTime(45)).toBe('00:45');
	});

	it('formats exactly one minute', () => {
		expect(formatTime(60)).toBe('01:00');
	});

	it('formats minutes and seconds', () => {
		expect(formatTime(125)).toBe('02:05');
	});

	it('pads single-digit seconds', () => {
		expect(formatTime(61)).toBe('01:01');
	});

	it('formats large values', () => {
		expect(formatTime(3661)).toBe('01:01:01');
	});
});

describe('createTimerStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function getState(timer: ReturnType<typeof createTimerStore>): TimerState {
		let state!: TimerState;
		const unsub = timer.subscribe((s) => {
			state = s;
		});
		unsub();
		return state;
	}

	it('starts with elapsed=0 and running=false', () => {
		const timer = createTimerStore();
		const state = getState(timer);
		expect(state.elapsed).toBe(0);
		expect(state.running).toBe(false);
		timer.destroy();
	});

	it('start sets running to true', () => {
		const timer = createTimerStore();
		timer.start();
		expect(getState(timer).running).toBe(true);
		timer.destroy();
	});

	it('increments elapsed each second after start', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(3000);
		expect(getState(timer).elapsed).toBe(3);
		timer.destroy();
	});

	it('pause stops the timer and sets running to false', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(2000);
		timer.pause();
		vi.advanceTimersByTime(2000); // should not tick
		const state = getState(timer);
		expect(state.elapsed).toBe(2);
		expect(state.running).toBe(false);
		timer.destroy();
	});

	it('resume continues counting after pause', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(2000);
		timer.pause();
		timer.resume();
		vi.advanceTimersByTime(3000);
		expect(getState(timer).elapsed).toBe(5);
		timer.destroy();
	});

	it('reset resets elapsed to 0 and stops timer', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(5000);
		timer.reset();
		const state = getState(timer);
		expect(state.elapsed).toBe(0);
		expect(state.running).toBe(false);
		timer.destroy();
	});

	it('start is idempotent when already running', () => {
		const timer = createTimerStore();
		timer.start();
		timer.start(); // should not create a second interval
		vi.advanceTimersByTime(1000);
		expect(getState(timer).elapsed).toBe(1);
		timer.destroy();
	});

	it('pause is a no-op when already stopped', () => {
		const timer = createTimerStore();
		timer.pause(); // noop on initial stopped state
		const state = getState(timer);
		expect(state.running).toBe(false);
		expect(state.elapsed).toBe(0);
		timer.destroy();
	});

	it('destroy stops the interval so timer no longer ticks', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(1000);
		timer.destroy();
		vi.advanceTimersByTime(3000); // should not tick after destroy
		expect(getState(timer).elapsed).toBe(1);
	});

	it('pauses when document becomes hidden', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(2000);

		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));

		const state = getState(timer);
		expect(state.running).toBe(false);

		// Should not tick while hidden
		vi.advanceTimersByTime(2000);
		expect(getState(timer).elapsed).toBe(2);

		Object.defineProperty(document, 'hidden', { value: false, configurable: true });
		timer.destroy();
	});

	it('resumes when document becomes visible again after being hidden while running', () => {
		const timer = createTimerStore();
		timer.start();
		vi.advanceTimersByTime(1000);

		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));

		Object.defineProperty(document, 'hidden', { value: false, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));

		expect(getState(timer).running).toBe(true);

		vi.advanceTimersByTime(2000);
		expect(getState(timer).elapsed).toBe(3);

		timer.destroy();
	});

	it('does not resume on visibility visible if was not running when hidden', () => {
		const timer = createTimerStore();
		// Do NOT start the timer

		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));

		Object.defineProperty(document, 'hidden', { value: false, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));

		expect(getState(timer).running).toBe(false);

		timer.destroy();
	});
});
