// GameplayPage: the canonical entry point for deterministic gameplay E2E.
//
// gotoFixture() composes the four harness services (fixture router, auth
// persona, API scenario controller, persisted-state controller) behind ONE
// atomic init script and a strict lifecycle order:
//
//   1. fixture lookup        getFixture(id)
//   2. route registration    fixture router (+ persona + completion scenario)
//   3. cookie reset          context.clearCookies()
//   4. optional clock        page.clock.install({ time }) — BEFORE navigation
//   5. ONE atomic init script clears/seeds storage and freezes the config
//   6. navigation            page.goto('/puzzle/<id>')
//   7. ready state           puzzle-board visible + expected tray count
//
// The init script is singular on purpose: separate storage and config init
// scripts have an unspecified evaluation order, so seeding the session after
// the app read it (or vice versa) would be non-deterministic. One script does
// clear -> seed -> freeze-config, synchronously, before any app script runs.
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { PersistedPuzzleSessionV1 } from '../../src/lib/services/gameplay/session/types';
import { loadPersistedSession } from '../../src/lib/services/gameplay/session/persistence';
import {
	buildGameplayConfig,
	DEFAULT_FIXTURE_ID,
	getFixture,
	type GameplayFixture,
	type GameplayFixtureId
} from '../gameplay-fixtures/catalog';
import { createFixtureRouter, type FixtureRouter } from '../gameplay-fixtures/fixture-router';
import {
	createAuthPersona,
	type AuthPersona,
	type AuthPersonaKind
} from '../gameplay-fixtures/auth-persona';
import {
	createApiScenarioController,
	type ApiScenarioController,
	type CompletionScenario,
	type DeferredHandle
} from '../gameplay-fixtures/api-scenario';
import { buildSessionValidationContext, progressKey } from '../gameplay-fixtures/persisted-state';
import { createPageDiagnostics, type PageDiagnostics } from './diagnostics';

export interface GotoFixtureOptions {
	/** Fixture to load. Defaults to DEFAULT_FIXTURE_ID ('e2e-square-4'). */
	fixtureId?: GameplayFixtureId;
	/** Auth persona to install. Omit to let the real API answer /api/auth/session. */
	persona?: AuthPersona | AuthPersonaKind;
	/** Validated session snapshot to seed under the production progress key. */
	seedSession?: PersistedPuzzleSessionV1;
	/** Stats record to seed under `puzzle-stats-<id>`. Written verbatim. */
	seedStats?: unknown;
	/**
	 * Clock control. `{ startAt }` installs Playwright's clock before navigation;
	 * `false` (or omitted) leaves the real wall clock in place.
	 */
	clock?: { startAt: Date } | false;
	/** Completion scenario to drive POST /complete. Omit to leave it unmocked. */
	completion?: CompletionScenario;
}

const CONFIG_GLOBAL = '__PERSEUS_E2E_GAMEPLAY_V1__';
const STATS_KEY_PREFIX = 'puzzle-stats-';

export class GameplayPage {
	readonly page: Page;
	readonly diagnostics: PageDiagnostics;
	readonly apiController: ApiScenarioController;
	/** Handle for the most recently installed completion scenario, if deferred. */
	completionHandle: DeferredHandle | null = null;
	/** The fixture loaded by the last gotoFixture() call. */
	fixture: GameplayFixture | null = null;

	private readonly fixtureRouter: FixtureRouter;
	private loaded = false;

	constructor(page: Page) {
		this.page = page;
		this.diagnostics = createPageDiagnostics(page);
		this.fixtureRouter = createFixtureRouter();
		this.apiController = createApiScenarioController();
	}

	/**
	 * Load a deterministic fixture following the strict lifecycle order. Resolves
	 * once the puzzle board is visible and the expected number of tray pieces are
	 * present. Never uses a fixed delay — only Playwright auto-waiting locators.
	 */
	async gotoFixture(options: GotoFixtureOptions = {}): Promise<void> {
		const fixtureId = options.fixtureId ?? DEFAULT_FIXTURE_ID;
		const fixture = getFixture(fixtureId);
		this.fixture = fixture;

		// --- Stage 2: route registration ----------------------------------------
		await this.fixtureRouter.install(this.page);
		if (options.completion) {
			this.completionHandle = await this.apiController.install(
				this.page,
				fixtureId,
				options.completion
			);
			this.diagnostics.setCompletion(fixtureId, options.completion);
		} else {
			this.completionHandle = null;
			this.diagnostics.setCompletion(undefined, undefined);
		}
		if (options.persona) {
			const persona =
				typeof options.persona === 'string' ? createAuthPersona(options.persona) : options.persona;
			await persona.install(this.page);
		}

		// --- Stage 3: cookie reset ----------------------------------------------
		await this.page.context().clearCookies();

		// --- Stage 4: optional clock install (BEFORE navigation) ----------------
		if (options.clock && typeof options.clock === 'object') {
			await this.page.clock.install({ time: options.clock.startAt });
		}

		// --- Stage 5: ONE atomic init script ------------------------------------
		// Validate the session snapshot in Node (same guarantee as
		// PersistedStateController.seedValid: a snapshot the production codec
		// rejects is never planted), then inline clear/seed/freeze into a single
		// script so evaluation order is fully specified.
		const sessionJson = options.seedSession
			? this.validateSeed(fixtureId, options.seedSession)
			: null;
		const statsJson = options.seedStats !== undefined ? JSON.stringify(options.seedStats) : null;
		const statsKey = `${STATS_KEY_PREFIX}${fixtureId}`;
		const configJson = JSON.stringify(buildGameplayConfig(fixture));

		await this.page.addInitScript(
			(args: {
				progressKey: string;
				sessionJson: string | null;
				statsKey: string;
				statsJson: string | null;
				configJson: string;
				configGlobal: string;
			}) => {
				try {
					localStorage.clear();
				} catch {
					/* storage may be unavailable pre-navigation */
				}
				try {
					sessionStorage.clear();
				} catch {
					/* same */
				}
				if (args.sessionJson) {
					try {
						localStorage.setItem(args.progressKey, args.sessionJson);
					} catch {
						/* ignore quota/access errors */
					}
				}
				if (args.statsJson) {
					try {
						localStorage.setItem(args.statsKey, args.statsJson);
					} catch {
						/* ignore quota/access errors */
					}
				}
				const deepFreeze = (value: unknown): void => {
					if (value === null || typeof value !== 'object') return;
					Object.freeze(value);
					if (Array.isArray(value)) {
						for (const item of value) deepFreeze(item);
					} else {
						for (const child of Object.values(value as Record<string, unknown>)) {
							deepFreeze(child);
						}
					}
				};
				const config = JSON.parse(args.configJson);
				deepFreeze(config);
				Object.defineProperty(window as unknown as Record<string, unknown>, args.configGlobal, {
					value: config,
					writable: false,
					configurable: false,
					enumerable: true
				});
			},
			{
				progressKey: progressKey(fixtureId),
				sessionJson,
				statsKey,
				statsJson,
				configJson,
				configGlobal: CONFIG_GLOBAL
			}
		);

		// --- Stage 6: navigation ------------------------------------------------
		await this.page.goto(`/puzzle/${fixtureId}`);

		// --- Stage 7: ready state -----------------------------------------------
		await this.expectReady(fixture);

		this.loaded = true;
	}

	/** Wait for the board and the full tray to render. No fixed delays. */
	async expectReady(
		fixture: GameplayFixture = this.fixture ?? getFixture(DEFAULT_FIXTURE_ID)
	): Promise<void> {
		await expect(this.page.getByTestId('puzzle-board')).toBeVisible();
		await expect(this.page.locator('[data-testid^="piece-slot-"]')).toHaveCount(fixture.pieceCount);
	}

	/**
	 * Assert no pending deferred routes / unreleased API scenarios remain, and
	 * that the page experienced no unexpected console/page/request errors.
	 */
	assertSettled(): void {
		if (!this.loaded) return;
		this.apiController.assertClean();
		this.diagnostics.assertNoUnexpectedErrors();
	}

	/** Assert no e2e-* request leaked past the fixture router to the backend. */
	assertNoUnexpectedFixtureRequests(): void {
		if (!this.loaded) return;
		this.diagnostics.assertNoUnexpectedFixtureRequests();
	}

	dispose(): void {
		this.diagnostics.dispose();
	}

	/**
	 * Validate a session snapshot against the production codec and return its
	 * canonical JSON. Throws (and plants nothing) if the codec rejects it.
	 */
	private validateSeed(fixtureId: GameplayFixtureId, snapshot: PersistedPuzzleSessionV1): string {
		const context = buildSessionValidationContext(fixtureId);
		const json = JSON.stringify(snapshot);
		const result = loadPersistedSession(json, context);
		if (result.status !== 'loaded' && result.status !== 'migrated') {
			const reason =
				result.status === 'invalid'
					? `invalid (${result.reason})`
					: result.status === 'incompatible'
						? `incompatible (schemaVersion=${result.schemaVersion})`
						: result.status;
			throw new Error(`gotoFixture seedSession: snapshot failed production validation: ${reason}`);
		}
		return json;
	}
}
