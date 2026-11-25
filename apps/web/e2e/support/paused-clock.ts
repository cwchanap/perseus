import type { Page } from '@playwright/test';

const PAUSE_LEAD_MS = 3_600_000;

/**
 * Install and pause Playwright's clock before navigation.
 *
 * Installation and pausing are separate browser round-trips. Install at
 * `startAt`, pause at `startAt` plus one virtual hour so real time elapsed
 * between the two calls cannot make the pause target past, then reset the wall
 * clock to `startAt`. After initialization, `Date.now()` is exactly `startAt`
 * and `performance.timeOrigin` is the install time; `performance.now()` is a
 * frozen monotonic baseline whose numeric value tests must not assume.
 *
 * Typed against only the clock operations it uses so contract tests can
 * delegate to the real page clock while observing the install/pause sequence.
 */
export async function initializePausedClock(
	clock: Pick<Page['clock'], 'install' | 'pauseAt' | 'setSystemTime'>,
	startAt: Date
): Promise<void> {
	await clock.install({ time: startAt });
	await clock.pauseAt(new Date(startAt.getTime() + PAUSE_LEAD_MS));
	await clock.setSystemTime(startAt);
}
