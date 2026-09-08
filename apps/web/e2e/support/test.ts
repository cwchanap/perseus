// Canonical gameplay E2E test fixture.
//
// Import `test` and `expect` from here for any gameplay E2E test:
//
//   import { test, expect } from '../support/test';
//
// The `gameplayPage` fixture owns a GameplayPage bound to the test's page.
// Its automatic teardown enforces the two post-conditions every gameplay test
// must satisfy: no pending deferred routes / unexpected page errors
// (assertSettled) and no e2e-* request that leaked past the fixture router to
// the real backend (assertNoUnexpectedFixtureRequests).
//
// Existing suites that import from '@playwright/test' directly are unaffected —
// this fixture is opt-in.
import { test as base, expect } from '@playwright/test';
import { GameplayPage } from './gameplay-page';

export const test = base.extend<{ gameplayPage: GameplayPage }>({
	gameplayPage: async ({ page }, use) => {
		const gameplayPage = new GameplayPage(page);
		// Capture the test body error separately so teardown post-conditions
		// can be evaluated and reported alongside (or instead of) it, without
		// an unsafe throw inside the finally block. Both assertions are always
		// evaluated — a throw from the first does not skip the second — and
		// dispose() always runs. If both assertions fail, every failure is
		// preserved in an AggregateError so no diagnostic is silently dropped.
		// assertSettled and assertNoUnexpectedFixtureRequests are no-ops when
		// gotoFixture() was never called, so importing the fixture is always
		// safe.
		let bodyError: unknown = null;
		const teardownFailures: Error[] = [];
		try {
			await use(gameplayPage);
		} catch (err) {
			bodyError = err;
		} finally {
			try {
				gameplayPage.assertSettled();
			} catch (err) {
				teardownFailures.push(err instanceof Error ? err : new Error(String(err)));
			}
			try {
				gameplayPage.assertNoUnexpectedFixtureRequests();
			} catch (err) {
				teardownFailures.push(err instanceof Error ? err : new Error(String(err)));
			}
			gameplayPage.dispose();
		}
		// If the test body threw, surface teardown failures alongside it so
		// neither is silently dropped.
		if (bodyError !== null && teardownFailures.length > 0) {
			const body = bodyError instanceof Error ? bodyError : new Error(String(bodyError));
			throw new AggregateError(
				[body, ...teardownFailures],
				`gameplayPage: test body + ${teardownFailures.length} teardown failure(s)`
			);
		}
		if (bodyError !== null) {
			throw bodyError;
		}
		if (teardownFailures.length === 1) {
			throw teardownFailures[0]!;
		}
		if (teardownFailures.length > 1) {
			throw new AggregateError(
				teardownFailures,
				`gameplayPage teardown: ${teardownFailures.length} post-condition failures`
			);
		}
	}
});

export { expect };
