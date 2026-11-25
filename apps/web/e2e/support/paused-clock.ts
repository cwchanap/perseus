import type { Page } from '@playwright/test';

const PAUSE_LEAD_MS = 3_600_000;

/**
 * Install and pause Playwright's clock before navigation.
 *
 * Installation and pausing are separate browser round-trips. Install one
 * virtual hour before `startAt` so real time elapsed between the two calls is
 * absorbed when `pauseAt` fast-forwards to the requested wall time. After the
 * pause, `Date.now()` is exactly `startAt`; `performance.now()` is a frozen
 * monotonic baseline whose numeric value tests must not assume.
 *
 * Typed against only the clock operations it uses so contract tests can
 * delegate to the real page clock while observing the install/pause sequence.
 */
export async function initializePausedClock(
	clock: Pick<Page['clock'], 'install' | 'pauseAt'>,
	startAt: Date
): Promise<void> {
	await clock.install({ time: new Date(startAt.getTime() - PAUSE_LEAD_MS) });
	await clock.pauseAt(startAt);
}
