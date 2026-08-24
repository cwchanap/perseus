// Persistence controls for deterministic gameplay E2E.
//
// The puzzle page stores resumable progress in `localStorage` under the
// production key `puzzle-progress-<puzzleId>` (see
// `src/lib/services/gameplay/session/persistence.ts`). The PersistedStateController
// seeds that store deterministically:
//
//   - `seedValid` runs the snapshot through the PRODUCTION codec
//     (`loadPersistedSession`) and refuses to write anything the codec rejects,
//     so a test can never silently plant a state the app would ignore.
//   - `seedRaw` bypasses validation entirely, writing arbitrary bytes for
//     corruption tests.
//
// Fresh Playwright contexts already isolate storage per test; `resetSameContext`
// clears cookies plus both browser stores for the rarer case where a test must
// reuse one context, and `freshContext` opens a brand-new isolated context.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
	loadPersistedSession,
	validationContextFrom,
	type PersistedPuzzleSessionV1,
	type SessionPuzzleSpec,
	type SessionValidationContext
} from '@perseus/game-core';
import { getFixture, type GameplayFixtureId } from './catalog';

/** Canonical localStorage key prefix used by the production persistence layer. */
export const PROGRESS_KEY_PREFIX = 'puzzle-progress-';

/** The exact localStorage key the puzzle page reads for `puzzleId`. */
export function progressKey(puzzleId: string): string {
	return `${PROGRESS_KEY_PREFIX}${puzzleId}`;
}

/**
 * Build the production `SessionValidationContext` for a fixture: the piece ids,
 * grid, and canonical placement coordinates the codec validates against.
 */
export function buildSessionValidationContext(
	fixtureId: GameplayFixtureId
): SessionValidationContext {
	const fixture = getFixture(fixtureId);
	const spec: SessionPuzzleSpec = {
		puzzleId: fixture.fixtureId,
		source: 'api',
		pieceCount: fixture.pieceCount,
		gridCols: fixture.cols,
		gridRows: fixture.rows,
		pieces: fixture.pieces.map((piece) => ({
			id: piece.id,
			correctX: piece.correctX,
			correctY: piece.correctY
		}))
	};
	return validationContextFrom(spec);
}

/**
 * A minimal, fully-valid `PersistedPuzzleSessionV1` for a fixture: a fresh
 * active timed standard run with no placements. Fields are constructed in a
 * fixed order so `JSON.stringify` is byte-stable across calls (deterministic).
 */
export function buildMinimalSeed(fixtureId: GameplayFixtureId): PersistedPuzzleSessionV1 {
	const fixture = getFixture(fixtureId);
	return {
		schemaVersion: 1,
		puzzleId: fixture.fixtureId,
		source: 'api',
		lifecycle: 'active',
		mode: 'timed',
		runId: fixture.seedRunId,
		origin: 'new',
		elapsedActiveSeconds: 0,
		timerStarted: false,
		placedPieces: [],
		trayOrder: [...fixture.initialTrayOrder],
		rotationEnabled: false,
		pieceRotations: {},
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: false,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		lastUpdated: 1710000000000
	};
}

export interface PersistedStateController {
	/**
	 * Validate `snapshot` against the production codec for `fixtureId`, then
	 * write its canonical JSON to localStorage. Rejects (and writes nothing) if
	 * the codec rejects the snapshot. Returns the exact string written.
	 */
	seedValid(
		page: Page,
		fixtureId: GameplayFixtureId,
		snapshot: PersistedPuzzleSessionV1
	): Promise<string>;
	/** Write `rawJson` verbatim, bypassing all validation for corruption tests. */
	seedRaw(page: Page, puzzleId: string, rawJson: string): Promise<void>;
	/** Read the current localStorage value for `puzzleId` (or null). */
	read(page: Page, puzzleId: string): Promise<string | null>;
	/** Remove the localStorage value for `puzzleId`. */
	clear(page: Page, puzzleId: string): Promise<void>;
	/** Clear cookies + localStorage + sessionStorage in the page's own context. */
	resetSameContext(page: Page): Promise<void>;
	/** Open a brand-new isolated browser context. */
	freshContext(browser: Browser): Promise<BrowserContext>;
}

export function createPersistedStateController(): PersistedStateController {
	return {
		async seedValid(page, fixtureId, snapshot) {
			const context = buildSessionValidationContext(fixtureId);
			const json = JSON.stringify(snapshot);
			const result = loadPersistedSession(json, context);
			if (result.status !== 'loaded') {
				const reason = result.status === 'invalid' ? `invalid (${result.reason})` : result.status;
				throw new Error(`seedValid: snapshot failed production validation: ${reason}`);
			}
			const key = progressKey(fixtureId);
			await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
				key,
				value: json
			});
			return json;
		},

		async seedRaw(page, puzzleId, rawJson) {
			const key = progressKey(puzzleId);
			await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
				key,
				value: rawJson
			});
		},

		async read(page, puzzleId) {
			return page.evaluate((key) => localStorage.getItem(key), progressKey(puzzleId));
		},

		async clear(page, puzzleId) {
			await page.evaluate((key) => localStorage.removeItem(key), progressKey(puzzleId));
		},

		async resetSameContext(page) {
			await page.context().clearCookies();
			await page.evaluate(() => {
				localStorage.clear();
				sessionStorage.clear();
			});
		},

		async freshContext(browser) {
			return browser.newContext();
		}
	};
}
