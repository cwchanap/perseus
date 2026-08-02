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
		try {
			await use(gameplayPage);
		} finally {
			// Enforce post-conditions, then release listeners. The nesting
			// guarantees both assertions are evaluated (a throw from the first
			// does not skip the second) and dispose() always runs even when a
			// post-condition throws. assertSettled and
			// assertNoUnexpectedFixtureRequests are no-ops when gotoFixture() was
			// never called, so importing the fixture is always safe.
			try {
				gameplayPage.assertSettled();
			} finally {
				try {
					gameplayPage.assertNoUnexpectedFixtureRequests();
				} finally {
					gameplayPage.dispose();
				}
			}
		}
	}
});

export { expect };
