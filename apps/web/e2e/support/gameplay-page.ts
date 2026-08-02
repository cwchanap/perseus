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
	 * dispatching the DnD event sequence directly. On failure, attaches
	 * source/target bounding boxes for diagnostics.
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
			placed = await this.page
				.getByTestId(`piece-slot-${pieceId}`)
				.waitFor({ state: 'detached', timeout: 1500 })
				.then(() => true)
				.catch(() => false);
		} catch {
			// dragTo() threw — will try fallback.
		}

		if (!placed) {
			try {
				await this.dispatchDnDFallback(pieceId, x, y);
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

	// --- Touch -----------------------------------------------------------------

	/** Tap a piece in the tray (basic touch interaction). */
	async tapPiece(pieceId: number): Promise<void> {
		await this.pieceSource(pieceId).tap();
	}

	/**
	 * Drag a piece to (x, y) using dispatched TouchEvents. The puzzle's touch
	 * handler listens for touchstart on the piece element and touchmove/touchend
	 * on window; this method dispatches that exact sequence from locator
	 * coordinates so the handler's synthetic-DragEvent drop path is exercised.
	 */
	async dragWithTouch(pieceId: number, x: number, y: number): Promise<void> {
		const source = this.pieceSource(pieceId);
		const target = this.dropZone(x, y);
		await source.waitFor({ state: 'visible' });
		await target.waitFor({ state: 'visible' });
		const sourceBox = await source.boundingBox();
		const targetBox = await target.boundingBox();
		if (!sourceBox || !targetBox) {
			throw new Error(
				`dragWithTouch: missing bounds — source=${JSON.stringify(sourceBox)}, target=${JSON.stringify(targetBox)}`
			);
		}
		// Dispatched touch events trigger Svelte 5's delegated ontouchstart,
		// which Chrome treats as passive at the document level. The handler's
		// preventDefault logs a benign console warning; allowlist it so the
		// diagnostics teardown does not mistake it for a regression.
		this.diagnostics.expectConsoleError('Unable to preventDefault');
		await this.page.evaluate(
			(data: { pieceId: number; sx: number; sy: number; tx: number; ty: number }) => {
				const { pieceId, sx, sy, tx, ty } = data;
				const pieceEl = document.querySelector(
					`[data-testid="piece-slot-${pieceId}"] [data-testid="puzzle-piece"]`
				) as HTMLElement | null;
				if (!pieceEl) {
					throw new Error(`dragWithTouch: piece element not found for piece ${pieceId}`);
				}

				const makeTouch = (cx: number, cy: number): Touch =>
					new Touch({
						identifier: 0,
						target: pieceEl,
						clientX: cx,
						clientY: cy,
						pageX: cx,
						pageY: cy,
						screenX: cx,
						screenY: cy,
						radiusX: 1,
						radiusY: 1,
						force: 1
					});

				const dispatch = (
					type: 'touchstart' | 'touchmove' | 'touchend',
					target: Element | Window,
					cx: number,
					cy: number
				): void => {
					const touch = makeTouch(cx, cy);
					const ended = type === 'touchend';
					const ev = new TouchEvent(type, {
						touches: ended ? [] : [touch],
						targetTouches: ended ? [] : [touch],
						changedTouches: [touch],
						bubbles: true,
						cancelable: true
					});
					target.dispatchEvent(ev);
				};

				// 1. touchstart on the piece element → starts the touch drag.
				dispatch('touchstart', pieceEl, sx, sy);
				// 2. touchmove via window listener → tracks + highlights drop zone.
				const midX = sx + (tx - sx) / 2;
				const midY = sy + (ty - sy) / 2;
				dispatch('touchmove', window, midX, midY);
				dispatch('touchmove', window, tx, ty);
				// 3. touchend via window listener → synthesizes drop on the zone.
				dispatch('touchend', window, tx, ty);
			},
			{
				pieceId,
				sx: sourceBox.x + sourceBox.width / 2,
				sy: sourceBox.y + sourceBox.height / 2,
				tx: targetBox.x + targetBox.width / 2,
				ty: targetBox.y + targetBox.height / 2
			}
		);
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

	// --- Lifecycle -------------------------------------------------------------

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
