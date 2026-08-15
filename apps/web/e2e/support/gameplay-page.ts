// GameplayPage: the canonical entry point for deterministic gameplay E2E.
//
// gotoFixture() composes the four harness services (fixture router, auth
// persona, API scenario controller, persisted-state controller) behind ONE
// atomic init script and a strict lifecycle order:
//
//   1. fixture lookup        getFixture(id)
//   2. route registration    fixture router (+ persona + completion scenario)
//   3. cookie reset          context.clearCookies()
//   4. optional clock        page.clock.install({ time }) + pauseAt — BEFORE nav
//   5. ONE atomic init script clears/seeds storage and freezes the config
//   6. navigation            page.goto('/puzzle/<id>')
//   7. ready state           puzzle-board visible + expected tray count
//
// The init script is singular on purpose: separate storage and config init
// scripts have an unspecified evaluation order, so seeding the session after
// the app read it (or vice versa) would be non-deterministic. One script does
// clear -> seed -> freeze-config, synchronously, before any app script runs.
import type { Locator, Page } from '@playwright/test';
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
	type AuthPersonaKind,
	type AuthSessionHandle
} from '../gameplay-fixtures/auth-persona';
import {
	createApiScenarioController,
	type ApiScenarioController,
	type CompletionScenario,
	type DeferredHandle
} from '../gameplay-fixtures/api-scenario';
import {
	GAMEPLAY_PREFERENCES_KEY,
	type GameplayPreferences
} from '../../src/lib/services/gameplay/session/preferences';
import { buildSessionValidationContext, progressKey } from '../gameplay-fixtures/persisted-state';
import { createPageDiagnostics, type PageDiagnostics } from './diagnostics';

export interface GotoFixtureOptions {
	/** Fixture to load. Defaults to DEFAULT_FIXTURE_ID ('e2e-square-4'). */
	fixtureId?: GameplayFixtureId;
	/**
	 * Auth persona to install. Defaults to `anonymous` so the harness never
	 * depends on the real API for auth. Pass `authenticated`, `anonymous`,
	 * `deferred-session`, or `failed-session` for the four design personas, or
	 * a full `AuthPersona` object (e.g. `createAuthPersona('failed-session',
	 * { failedStatus: 503 })`).
	 */
	persona?: AuthPersona | AuthPersonaKind;
	/** Validated session snapshot to seed under the production progress key. */
	seedSession?: PersistedPuzzleSessionV1;
	/** Stats record to seed under `puzzle-stats-<id>`. Written verbatim. */
	seedStats?: unknown;
	/**
	 * Device gameplay preferences to seed under the production preferences
	 * key (`perseus-gameplay-preferences-v1`), inside the SAME atomic init
	 * script as the session snapshot so the app reads one deterministic
	 * store on fresh route entry. Omit to leave the store empty — a fresh
	 * session then presents the mandatory Mission Setup dialog. Seed
	 * `{ ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true }` to
	 * auto-start fresh sessions and skip the dialog.
	 */
	seedPreferences?: GameplayPreferences;
	/**
	 * Clock control. `{ startAt }` installs AND pauses Playwright's clock at
	 * `startAt` before navigation, so navigation does not advance it and
	 * performance.now() stays at zero until a test calls page.clock.runFor();
	 * `false` (or omitted) leaves the real wall clock in place.
	 */
	clock?: { startAt: Date } | false;
	/**
	 * Completion scenario to drive POST /complete. Omit to fail any completion
	 * as an undeclared write — the fixture router returns a 403
	 * `undeclared_completion` and diagnostics flags it as a harness violation.
	 */
	completion?: CompletionScenario;
	/**
	 * Expected number of tray pieces once the fixture is ready. Defaults to
	 * fixture.pieceCount (a full tray). Pass the restored count when
	 * seedSession already placed pieces, so the ready-state wait matches the
	 * restored tray instead of the full one.
	 */
	expectedTrayCount?: number;
}

const CONFIG_GLOBAL = '__PERSEUS_E2E_GAMEPLAY_V1__';
const STATS_KEY_PREFIX = 'puzzle-stats-';

export class GameplayPage {
	readonly page: Page;
	readonly diagnostics: PageDiagnostics;
	readonly apiController: ApiScenarioController;
	/** Handle for the most recently installed completion scenario, if deferred. */
	completionHandle: DeferredHandle | null = null;
	/** Handle for a deferred-session auth persona, if installed. */
	authHandle: AuthSessionHandle | null = null;
	/** The fixture loaded by the last gotoFixture() call. */
	fixture: GameplayFixture | null = null;

	private readonly fixtureRouter: FixtureRouter;
	private loaded = false;
	private loading = false;

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
	 *
	 * One-shot: a second call (or an overlapping call while the first is still
	 * in flight) throws. gotoFixture installs an atomic init script and fixture
	 * routes; re-running it would stack duplicate init scripts and routes and
	 * wait on a stale ready state.
	 */
	async gotoFixture(options: GotoFixtureOptions = {}): Promise<void> {
		if (this.loading) {
			throw new Error(
				'gotoFixture: already in progress — overlapping calls would install ' +
					'duplicate init scripts and fixture routes and race the ready-state wait'
			);
		}
		if (this.loaded) {
			throw new Error(
				'gotoFixture: fixture already loaded — a second call would install ' +
					'duplicate init scripts and fixture routes and wait on a stale ready ' +
					'state. Start a fresh test (or page) for another navigation.'
			);
		}
		this.loading = true;
		// Set the one-shot loaded guard before attempting loadFixture: a
		// failed attempt leaves routes/init scripts installed on the page, so
		// a retry would stack duplicates. Marking loaded upfront blocks retries
		// regardless of outcome, while still letting assertSettled()/assert
		// NoUnexpectedFixtureRequests() run their post-load validation.
		this.loaded = true;
		try {
			await this.loadFixture(options);
		} finally {
			this.loading = false;
		}
	}

	private async loadFixture(options: GotoFixtureOptions): Promise<void> {
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
		// Default to the anonymous persona so the harness never depends on
		// the real API for auth (per the HPA-226 design: "The default persona
		// is anonymous"). A test that needs a different persona passes it
		// explicitly.
		const personaSpec: AuthPersona | AuthPersonaKind = options.persona ?? 'anonymous';
		const persona = typeof personaSpec === 'string' ? createAuthPersona(personaSpec) : personaSpec;
		this.authHandle = await persona.install(this.page);
		// Declare the auth persona so diagnostics expects its outcome on
		// /api/auth/session: requires the auth-persona provenance marker (so a
		// real-backend leak cannot masquerade as the persona), narrowly allows
		// the configured failure status / cancel abort, and allowlists the
		// page's auth-failure console errors.
		this.diagnostics.setAuthPersona(persona.kind, persona.failedStatus);

		// --- Stage 3: cookie reset ----------------------------------------------
		await this.page.context().clearCookies();

		// --- Stage 4: optional clock install + pause (BEFORE navigation) --------
		// Pausing immediately after install freezes the clock at startAt so
		// navigation (and everything up to the first user action) does not
		// advance performance.now(). A test advances time explicitly via
		// page.clock.runFor(). Navigation with a paused clock is safe: pages do
		// not need advancing time to initialize, and fetch is clock-independent.
		if (options.clock && typeof options.clock === 'object') {
			await this.page.clock.install({ time: options.clock.startAt });
			await this.page.clock.pauseAt(options.clock.startAt);
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
		const preferencesJson = options.seedPreferences
			? JSON.stringify(options.seedPreferences)
			: null;
		const configJson = JSON.stringify(buildGameplayConfig(fixture));

		await this.page.addInitScript(
			(args: {
				progressKey: string;
				sessionJson: string | null;
				statsKey: string;
				statsJson: string | null;
				preferencesKey: string;
				preferencesJson: string | null;
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
				if (args.preferencesJson) {
					try {
						localStorage.setItem(args.preferencesKey, args.preferencesJson);
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
				preferencesKey: GAMEPLAY_PREFERENCES_KEY,
				preferencesJson,
				configJson,
				configGlobal: CONFIG_GLOBAL
			}
		);

		// --- Stage 6: navigation ------------------------------------------------
		await this.page.goto(`/puzzle/${fixtureId}`);

		// --- Stage 7: ready state -----------------------------------------------
		await this.expectReady(fixture, options.expectedTrayCount);
	}

	/**
	 * Wait for the board to render and the tray to hold `expectedTrayCount`
	 * pieces (defaults to the fixture's full tray). No fixed delays.
	 */
	async expectReady(
		fixture: GameplayFixture = this.fixture ?? getFixture(DEFAULT_FIXTURE_ID),
		expectedTrayCount: number = fixture.pieceCount
	): Promise<void> {
		await expect(this.page.getByTestId('puzzle-board')).toBeVisible();
		await expect(this.page.locator('[data-testid^="piece-slot-"]')).toHaveCount(expectedTrayCount);
	}

	// --- Interaction helpers ---------------------------------------------------

	/** Locate the tray piece source (slot) by piece ID. */
	pieceSource(pieceId: number): Locator {
		return this.page.getByTestId(`piece-slot-${pieceId}`);
	}

	/** Locate the board drop-zone at grid coordinates (x, y). */
	dropZone(x: number, y: number): Locator {
		return this.page.locator(`[data-testid="drop-zone"][data-x="${x}"][data-y="${y}"]`);
	}

	// --- Mouse -----------------------------------------------------------------

	/**
	 * Place a piece via mouse HTML5 drag-and-drop. Uses Playwright's dragTo()
	 * as the primary path. On browsers where dragTo() does not produce a drop
	 * event for HTML5 DnD (e.g. WebKit, mobile Chromium), falls back to
	 * dispatching the DnD event sequence directly. The drop's outcome is then
	 * verified: a placed piece's tray slot detaches, an engine-rejected drop
	 * (e.g. an occupied or wrong slot) shakes the piece and is accepted as
	 * handled, and a drop that never registered throws an enriched error with
	 * source/target bounding boxes.
	 */
	async placeWithMouse(pieceId: number, x: number, y: number): Promise<void> {
		const source = this.pieceSource(pieceId);
		const target = this.dropZone(x, y);
		await source.waitFor({ state: 'visible' });
		await target.waitFor({ state: 'visible' });
		const sourceBox = await source.boundingBox();
		const targetBox = await target.boundingBox();

		let placed = false;
		try {
			await source.dragTo(target);
			// Verify the drop registered — on some browsers dragTo() does not
			// produce a drop event for HTML5 DnD.
			placed = await this.isSlotGone(pieceId);
		} catch {
			// dragTo() threw — will try fallback.
		}

		if (!placed) {
			try {
				await this.dispatchDnDFallback(pieceId, x, y);
				const outcome = await this.awaitPlacementOutcome(pieceId);
				if (outcome === 'ignored') {
					throw new Error(
						`piece ${pieceId} did not detach and the engine signalled no ` +
							`rejection after the fallback drop onto (${x}, ${y})`
					);
				}
			} catch (fallbackErr) {
				throw this.enrichDragError(fallbackErr, sourceBox, targetBox);
			}
		}
	}

	// --- Keyboard --------------------------------------------------------------

	/**
	 * Select a piece via keyboard, then place it at (x, y). Verifies the piece
	 * is selected before activating the target drop-zone.
	 *
	 * Defaults to Enter; pass 'Space' to test Space selection/placement.
	 */
	async selectAndPlaceWithKeyboard(
		pieceId: number,
		x: number,
		y: number,
		key: 'Enter' | 'Space' = 'Enter'
	): Promise<void> {
		const piece = this.pieceSource(pieceId).getByTestId('puzzle-piece');
		await piece.focus();
		await piece.press(key);
		// Verify selection before activating the target.
		await expect(piece).toHaveAttribute('data-selected', 'true');
		const target = this.dropZone(x, y);
		await target.focus();
		await target.press(key);
	}

	/**
	 * Solve the current fixture via keyboard: select each piece and place it in
	 * its correct board cell, verifying each placement. The fixture must be
	 * ready (see gotoFixture).
	 */
	async solveFixture(): Promise<void> {
		const fixture = this.fixture ?? getFixture(DEFAULT_FIXTURE_ID);
		for (const piece of fixture.pieces) {
			await this.selectAndPlaceWithKeyboard(piece.id, piece.correctX, piece.correctY);
			await this.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
		}
	}

	// --- Touch -----------------------------------------------------------------

	/** Tap the actual piece control in the tray. */
	async tapPiece(pieceId: number): Promise<void> {
		await this.pieceSource(pieceId).getByTestId('puzzle-piece').tap();
	}

	/**
	 * Select a piece via tap and attempt accepted placement at (x, y).
	 * The caller uses expectPiecePlaced when it needs to prove board location.
	 */
	async placeWithTap(pieceId: number, x: number, y: number): Promise<void> {
		const piece = this.pieceSource(pieceId).getByTestId('puzzle-piece');
		await piece.tap();
		await expect(piece).toHaveAttribute('data-selected', 'true');
		await this.dropZone(x, y).tap();
		await expect(this.page.getByTestId(`piece-slot-${pieceId}`)).toHaveCount(0);
	}

	// --- Placement assertions --------------------------------------------------

	/**
	 * Assert a piece is placed at (x, y): the tray slot is gone and the
	 * drop-zone shows the placed-piece image.
	 */
	async expectPiecePlaced(pieceId: number, x: number, y: number): Promise<void> {
		await expect(this.page.getByTestId(`piece-slot-${pieceId}`)).toHaveCount(0);
		await expect(this.dropZone(x, y).locator('img[alt="Placed piece"]')).toBeVisible();
	}

	// --- Dialog base -----------------------------------------------------------

	/** Wait for a dialog with the given accessible name to appear. */
	async waitForDialog(name: string | RegExp): Promise<Locator> {
		const dialog = this.page.getByRole('dialog', { name });
		await expect(dialog).toBeVisible();
		return dialog;
	}

	/** Assert the dialog's initial focus landed on the target element. */
	async expectDialogInitialFocus(dialog: Locator, target: Locator): Promise<void> {
		await expect(target).toBeFocused();
		// The focused element must be a descendant of the dialog under test: a
		// stale locator that resolves to an element inside a different dialog
		// (e.g. one left open by an earlier step) would otherwise satisfy the
		// focus assertion.
		const contained = await dialog.evaluate(
			(dialogEl, focusedEl) => dialogEl.contains(focusedEl),
			await target.elementHandle()
		);
		expect(contained).toBe(true);
	}

	/** Click a visible action button inside the dialog by accessible name. */
	async activateDialogAction(dialog: Locator, name: string | RegExp): Promise<void> {
		await dialog.getByRole('button', { name }).click();
	}

	/** Dismiss the dialog via Escape or an accessible visible close button. */
	async dismissDialog(dialog: Locator, method: 'escape' | 'visible-close-button'): Promise<void> {
		if (method === 'escape') {
			// Ensure focus is inside the dialog so the Escape keydown propagates
			// through the dialog container's delegated Escape handler.
			await dialog.getByRole('button').first().focus();
			await this.page.keyboard.press('Escape');
		} else {
			await dialog.getByRole('button', { name: /close/i }).click();
		}
	}

	// --- Mission session controls ----------------------------------------------

	/** Locate the Mission Setup dialog. */
	missionSetupDialog(): Locator {
		return this.page.getByRole('dialog', { name: 'Mission Setup' });
	}

	/**
	 * Configure and start a mission from the Mission Setup dialog. Options
	 * only touch controls whose value is specified, so a dialog pre-filled
	 * with retained choices (e.g. after a restart) keeps them by default.
	 * Resolves once the dialog has closed.
	 */
	async startMission(
		options: {
			mode?: 'timed' | 'relaxed';
			rotationEnabled?: boolean;
			startImmediately?: boolean;
		} = {}
	): Promise<void> {
		const dialog = this.missionSetupDialog();
		await expect(dialog).toBeVisible();
		if (options.mode) {
			await dialog.getByLabel(options.mode === 'timed' ? 'Timed' : 'Relaxed').check();
		}
		if (options.rotationEnabled !== undefined) {
			await dialog.getByLabel('Enable rotation').setChecked(options.rotationEnabled);
		}
		if (options.startImmediately !== undefined) {
			await dialog.getByLabel('Start immediately next time').setChecked(options.startImmediately);
		}
		await dialog.getByRole('button', { name: 'Start Mission' }).click();
		await expect(dialog).not.toBeVisible();
	}

	/**
	 * Pause the active run via the toolbar Pause button. Returns the pause
	 * dialog (accessible name 'Mission Paused').
	 */
	async pauseMission(): Promise<Locator> {
		// The compact toolbar hides Pause inside a display:none panel until
		// 'More puzzle actions' opens it; role locators skip display:none
		// subtrees entirely, so resolve by label with includeHidden to keep
		// the locator attached while CSS-hidden.
		const pause = this.page.getByLabel('Pause mission', { includeHidden: true });
		const more = this.page.getByRole('button', { name: 'More puzzle actions' });

		await expect(pause).toBeAttached();
		if (!(await pause.isVisible())) {
			await expect(more).toBeVisible();
			await more.click();
			await expect(pause).toBeVisible();
		}

		await pause.click();
		const dialog = this.page.getByRole('dialog', { name: 'Mission Paused' });
		await expect(dialog).toBeVisible();
		return dialog;
	}

	/**
	 * Resume a paused run — either a user-initiated toolbar pause ('Mission
	 * Paused') or a restored run awaiting explicit re-engagement ('Resume
	 * Mission'). Resolves once the dialog has closed.
	 */
	async resumeMission(): Promise<void> {
		const dialog = this.page.getByRole('dialog', {
			name: /^(Mission Paused|Resume Mission)$/
		});
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Resume' }).click();
		await expect(dialog).not.toBeVisible();
	}

	/**
	 * Read the currently persisted session snapshot for the loaded fixture
	 * from localStorage, or null when the canonical progress key is absent.
	 */
	async readPersistedSession(): Promise<PersistedPuzzleSessionV1 | null> {
		const fixtureId = this.fixture?.fixtureId ?? DEFAULT_FIXTURE_ID;
		const raw = await this.page.evaluate(
			(key: string) => localStorage.getItem(key),
			progressKey(fixtureId)
		);
		return raw === null ? null : (JSON.parse(raw) as PersistedPuzzleSessionV1);
	}

	// --- Lifecycle -------------------------------------------------------------

	/**
	 * Assert no pending deferred routes / unreleased API scenarios / unreleased
	 * auth sessions remain, and that the page experienced no unexpected
	 * console/page/request errors.
	 */
	assertSettled(): void {
		if (!this.loaded) return;
		this.apiController.assertClean();
		this.assertAuthClean();
		this.diagnostics.assertNoUnexpectedErrors();
	}

	/** Throw if a deferred-session persona has a pending held route. */
	private assertAuthClean(): void {
		if (this.authHandle && this.authHandle.pendingCount > 0) {
			throw new Error(
				`AuthPersona teardown: ${this.authHandle.pendingCount} deferred session route(s) still pending — call release() or cancel() on gameplayPage.authHandle`
			);
		}
	}

	/** Assert no e2e-* request leaked past the fixture router to the backend. */
	assertNoUnexpectedFixtureRequests(): void {
		if (!this.loaded) return;
		this.diagnostics.assertNoUnexpectedFixtureRequests();
	}

	dispose(): void {
		this.diagnostics.dispose();
	}

	/** Wrap a drag error with source/target bounding boxes for diagnostics. */
	private enrichDragError(
		err: unknown,
		sourceBox: { x: number; y: number; width: number; height: number } | null,
		targetBox: { x: number; y: number; width: number; height: number } | null
	): Error {
		const msg = err instanceof Error ? err.message : String(err);
		return new Error(
			`placeWithMouse failed: ${msg}\n` +
				`  source bounds: ${JSON.stringify(sourceBox)}\n` +
				`  target bounds: ${JSON.stringify(targetBox)}`
		);
	}

	/**
	 * Dispatch the HTML5 DnD event sequence (dragover + drop) directly on the
	 * target drop-zone. Used when Playwright's dragTo() does not produce a drop
	 * event (e.g. on WebKit or mobile Chromium).
	 */
	private async dispatchDnDFallback(pieceId: number, x: number, y: number): Promise<void> {
		await this.dropZone(x, y).evaluate((target, pid) => {
			const dt = new DataTransfer();
			dt.setData('text/plain', String(pid));
			dt.dropEffect = 'move';
			dt.effectAllowed = 'move';
			target.dispatchEvent(
				new DragEvent('dragover', {
					bubbles: true,
					cancelable: true,
					dataTransfer: dt
				})
			);
			target.dispatchEvent(
				new DragEvent('drop', {
					bubbles: true,
					cancelable: true,
					dataTransfer: dt
				})
			);
		}, pieceId);
	}

	/** True once the piece's tray slot has detached (i.e. the piece is placed). */
	private async isSlotGone(pieceId: number): Promise<boolean> {
		return this.page
			.getByTestId(`piece-slot-${pieceId}`)
			.waitFor({ state: 'detached', timeout: 1500 })
			.then(() => true)
			.catch(() => false);
	}

	/**
	 * Classify the engine's response to a dispatched drop. The engine answers
	 * synchronously: a placed piece's tray slot detaches, a rejected drop
	 * shakes the slot via the `.rejected` class for REJECTED_DURATION_MS
	 * (500ms) before the piece returns to the tray, and an unhandled drop
	 * changes nothing. Detachment and rejection are watched concurrently so a
	 * rejection is not missed after the detach wait times out.
	 */
	private async awaitPlacementOutcome(pieceId: number): Promise<'placed' | 'rejected' | 'ignored'> {
		const slot = this.pieceSource(pieceId);
		const placed = this.isSlotGone(pieceId);
		const rejected = expect
			.poll(() => slot.evaluate((el) => el.classList.contains('rejected')), {
				timeout: 1500,
				intervals: [100]
			})
			.toBe(true)
			.then(() => true)
			.catch(() => false);
		const [wasPlaced, wasRejected] = await Promise.all([placed, rejected]);
		if (wasPlaced) return 'placed';
		if (wasRejected) return 'rejected';
		// The drop never registered: the slot stayed attached and the engine
		// never signalled a rejection. Report it as an error at the call site.
		return 'ignored';
	}

	/**
	 * Validate a session snapshot against the production codec and return its
	 * canonical JSON. Throws (and plants nothing) if the codec rejects it.
	 */
	private validateSeed(fixtureId: GameplayFixtureId, snapshot: PersistedPuzzleSessionV1): string {
		const context = buildSessionValidationContext(fixtureId);
		const json = JSON.stringify(snapshot);
		const result = loadPersistedSession(json, context);
		if (result.status !== 'loaded') {
			const reason = result.status === 'invalid' ? `invalid (${result.reason})` : result.status;
			throw new Error(`gotoFixture seedSession: snapshot failed production validation: ${reason}`);
		}
		return json;
	}
}
