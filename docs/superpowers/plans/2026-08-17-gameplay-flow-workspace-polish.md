# Gameplay Flow and Puzzle Workspace Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five gameplay-polish changes in one implementation PR: Relaxed restore without a popup, direct save-and-exit plus explicit Discard, a coherent wider/resizable desktop tray, fresh rotation shuffle, and persistent/revealed hints.

**Architecture:** Keep `PuzzleSession` and persistence unchanged. Do restore/exit/discard in one route pass; let `puzzleLayout.ts` own the complete board↔tray width contract; store requested tray width separately from applied width; keep runtime randomness behind `createRotations`; let the inventory own post-render hint reveal; finish with one default-gate desktop splitter/hint smoke test.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-08-17-gameplay-flow-workspace-polish-design.md`

## Global Constraints

- Ship all five behaviors in one implementation PR.
- No `PuzzleSessionState`, action/event, persistence schema/version, completion-seal, or gallery-validation changes.
- Restored Timed runs keep explicit `Resume Mission`; restored Relaxed active/paused runs enter active gameplay without it.
- Exit always saves and navigates to `/`; it never offers Save versus Discard.
- Discard remains confirmed and is available only from Pause/Resume and the home Continue panel.
- Preserve `discardAndExit()` stop-checkpoint → dispose → clear ordering and its unmount regression.
- No per-card discard, server deletion, saved-progress store, generic dialog framework, split-pane package, or generic layout manager.
- Desktop tray goal is **more visible pieces / less scrolling**, not independently larger thumbnails.
- `puzzleLayout.ts` owns desktop tray constants, initial width derivation, clamp, and board reservation. Do not keep the old three-column board solve in parallel.
- Store requested tray width separately from applied width; viewport clamping must not overwrite the user's request.
- Do not replace existing Hold-to-Peek global `pointerup` / `pointercancel` / blur cleanup and do not add pointer capture.
- Keep `createRotations(puzzleId, pieceIds)` and the virtual E2E override unchanged.
- Do not test randomness probabilistically.
- A rejected hinted-piece placement must retain the hint; only accepted placement clears it.
- Hint reveal must `await tick()` before `scrollIntoView`.
- Hint reveal must not call `.focus()`, `onSelect`, `onRotate`, or placement callbacks.
- Update `docs/PRD.md` for persistent hint lifetime and fresh rotation initialization.
- Update current tests directly; no compatibility aliases for `ExitSessionDialog`.

## Risks to Verify During Implementation

- **Board/tray drift:** changing CSS width without passing the applied tray width into board metrics creates dead space/downscaling.
- **Coarse-puzzle regression:** a fixed 360px default can narrow today's large-piece tray; initial width must preserve the old three-column footprint.
- **Lost user width:** resize-time clamping must be a projection, not a mutation on viewport shrink.
- **Mobile hint no-op:** scrolling before the collapsed drawer rerenders does nothing.
- **Hint consumed by rejection:** clearing before `attempt_placement` violates the new lifetime.
- **False E2E coverage:** an `@smoke` test nested under an `@extended` describe is still excluded by `--grep-invert @extended`.

---

## Task 1: Do one route flow pass for restore, direct Exit, and gameplay Discard

**Files:**

- Create: `apps/web/src/lib/components/DiscardSessionDialog.svelte`
- Delete: `apps/web/src/lib/components/ExitSessionDialog.svelte`
- Modify: `apps/web/src/lib/components/SessionPauseDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- `DiscardSessionDialog`: `{ puzzleName: string; onConfirm: () => void; onCancel: () => void }`
- `SessionPauseDialog` adds `onDiscard: () => void`.
- Route `SessionDialog` becomes `'setup' | 'pause' | 'discard' | null`.
- Route test harness adds `restoredModeState: 'timed' | 'relaxed'`.
- Remove test-only `resumableState` / mocked `isResumable` once `currentRunIsResumable()` is deleted.

**Produces:** complete restore table, direct save-and-exit, and explicit confirmed gameplay Discard with the old Exit suite fully migrated.

- [ ] **Step 1: Migrate dialog component tests**

In `SessionDialogs.svelte.test.ts`:

1. Replace `ExitSessionDialog` import/tests with `DiscardSessionDialog`.
2. Add `onDiscard: vi.fn()` to every `SessionPauseDialog` render.
3. Add exact coverage:

```ts
it('forwards Discard from the pause surface', async () => {
	const onDiscard = vi.fn();
	render(SessionPauseDialog, {
		presentation: 'paused',
		mode: 'timed',
		confirmingRestart: false,
		onResume: vi.fn(),
		onRequestRestart: vi.fn(),
		onConfirmRestart: vi.fn(),
		onCancelRestart: vi.fn(),
		onExit: vi.fn(),
		onDiscard
	});

	await page.getByRole('button', { name: 'Discard' }).click();
	expect(onDiscard).toHaveBeenCalledOnce();
});

it('keeps the full-screen shell and confirms discard', async () => {
	const onConfirm = vi.fn();
	render(DiscardSessionDialog, {
		puzzleName: 'Test Mission',
		onConfirm,
		onCancel: vi.fn()
	});

	const dialog = await page.getByRole('dialog', { name: 'Discard saved progress' }).element();
	expect(dialog.parentElement?.className).toContain('fixed');
	expect(dialog.parentElement?.className).toContain('inset-0');

	await page.getByRole('button', { name: 'Discard' }).click();
	expect(onConfirm).toHaveBeenCalledOnce();
});

it('cancels discard on Escape', async () => {
	const onCancel = vi.fn();
	render(DiscardSessionDialog, {
		puzzleName: 'Test Mission',
		onConfirm: vi.fn(),
		onCancel
	});

	const dialog = await page.getByRole('dialog', { name: 'Discard saved progress' }).element();
	dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	expect(onCancel).toHaveBeenCalledOnce();
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
```

Expected before implementation: missing import/prop/button/dialog failures.

- [ ] **Step 2: Replace `ExitSessionDialog` with a discard-only copy**

Copy the existing outer shell verbatim: fixed full-screen scrim, z-index, safe-area padding, `modalFocus`, `aria-modal`, Escape cancellation.

The new component contract:

```svelte
<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';

	interface Props {
		puzzleName: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { puzzleName, onConfirm, onCancel }: Props = $props();
</script>
```

The inner copy is:

```svelte
<div
	role="dialog"
	aria-modal="true"
	aria-label="Discard saved progress"
	tabindex="-1"
	use:modalFocus
	onkeydown={(event) => event.key === 'Escape' && onCancel()}
	...
>
	<h2>Discard saved progress?</h2>
	<p>This permanently removes saved progress for {puzzleName}.</p>
	<button type="button" onclick={onCancel}>Cancel</button>
	<button type="button" onclick={onConfirm}>Discard</button>
</div>
```

Reuse the existing button classes locally. Do not extract a generic confirm component.

- [ ] **Step 3: Add Discard to `SessionPauseDialog`**

Add `onDiscard` to `Props` and `$props()`.

Normal Pause/Resume action row becomes:

```text
Exit | Discard | Restart | Resume
```

Do not add Discard to the inline Restart confirmation surface.

- [ ] **Step 4: Make restored mode configurable in the route test harness**

Near `restoredLifecycleState`:

```ts
const restoredModeState = vi.hoisted(() => ({
	value: 'timed' as 'timed' | 'relaxed'
}));
```

Use:

```ts
mode: restoredModeState.value,
elapsedActiveSeconds: restoredModeState.value === 'relaxed' ? null : 0,
resultClass: restoredModeState.value === 'relaxed' ? 'relaxed' : 'standard_timed',
```

Reset to `timed` in both suite `beforeEach` blocks.

Remove `resumableState` and mocked `isResumable` after the production route no longer calls it.

- [ ] **Step 5: Add the full restore-table tests**

```ts
it.each(['active', 'paused'] as const)(
	'restores a %s Relaxed run without Resume Mission',
	async (lifecycle) => {
		restoredLifecycleState.value = lifecycle;
		restoredModeState.value = 'relaxed';
		setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

		await renderPuzzlePage();

		await expect
			.poll(() => page.getByRole('dialog', { name: 'Resume Mission' }).query())
			.toBeNull();
		await expect.element(page.getByTestId('relaxed-mode-indicator')).toBeVisible();
	}
);

it.each(['active', 'paused'] as const)(
	'keeps Resume Mission for restored %s Timed runs',
	async (lifecycle) => {
		restoredLifecycleState.value = lifecycle;
		restoredModeState.value = 'timed';
		setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

		await renderPuzzlePage();

		await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	}
);
```

- [ ] **Step 6: Implement the route restore table**

Replace the current generic active/paused restore branch:

```ts
} else if (restored.lifecycle === 'active') {
	if (restored.mode === 'timed') {
		store.dispatch({ type: 'pause' });
		checkpointSession();
		pausePresentation = 'resume';
		sessionDialog = 'pause';
	}
} else if (restored.lifecycle === 'paused') {
	if (restored.mode === 'relaxed') {
		store.dispatch({ type: 'resume' });
		checkpointSession();
	} else {
		pausePresentation = 'resume';
		sessionDialog = 'pause';
	}
}
```

Fresh/setup/completed handling stays unchanged.

- [ ] **Step 7: Rewrite all five old Exit Mission route tests**

Migrate the current block as a unit:

1. Save & Exit → Pause `Exit` saves+navigates immediately.
2. Discard-from-Exit → Pause `Discard` → confirmation → clear+navigate.
3. Keep the unmount-after-discard no-resave regression.
4. Delete obsolete cancelable Arcade Exit; replace with header direct Exit.
5. Cancel Discard from restored Timed `Resume Mission` must return to `Resume Mission`, not `Mission Paused`.

Representative direct Exit:

```ts
it('saves and navigates immediately when Exit is chosen from Pause', async () => {
	await renderPuzzlePage();
	await placePiece(0, 0, 0);
	sessionStorageSpies.saveSession.mockClear();

	await page.getByLabelText('More puzzle actions').click();
	await page.getByRole('button', { name: 'Pause mission' }).click();
	await page.getByRole('button', { name: 'Exit' }).click();

	expect(page.getByRole('dialog', { name: 'Exit Mission' }).query()).toBeNull();
	expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
	expect(sessionStorageSpies.clearSession).not.toHaveBeenCalled();
	expect(goto).toHaveBeenCalledWith('/');
});
```

Representative cancel:

```ts
it('cancels discard back to restored Timed Resume Mission', async () => {
	restoredLifecycleState.value = 'paused';
	restoredModeState.value = 'timed';
	setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

	await renderPuzzlePage();
	await page.getByRole('button', { name: 'Discard' }).click();
	await page
		.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Cancel' })
		.click();

	await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
});
```

Keep the existing regression tail unchanged:

```ts
expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('test-puzzle');
sessionStorageSpies.saveSession.mockClear();
view.unmount();
expect(sessionStorageSpies.saveSession).not.toHaveBeenCalled();
```

- [ ] **Step 8: Implement direct Exit and gameplay Discard**

Remove:

- `ExitSessionDialog` import/rendering
- `'exit'` dialog state
- `exitOrigin`
- `currentRunIsResumable`
- `requestReturnToArcade`
- `saveAndExit`
- `cancelExit`

Add:

```ts
function exitToArcade(): void {
	clearTransientGameplayState();
	if (sessionState?.lifecycle === 'active') {
		sessionStore?.dispatch({ type: 'pause' });
	}
	persistSessionFinal();
	void goto(resolve('/'));
}

function requestDiscard(): void {
	sessionDialog = 'discard';
}

function cancelDiscard(): void {
	// Preserve 'resume' vs 'paused'.
	sessionDialog = 'pause';
}
```

Keep `discardAndExit()` ordering unchanged.

Retarget header/setup/pause/completion safe Exit callbacks to `exitToArcade`.

Render:

```svelte
{#if sessionDialog === 'discard'}
	<DiscardSessionDialog
		puzzleName={puzzle?.name ?? 'this mission'}
		onConfirm={discardAndExit}
		onCancel={cancelDiscard}
	/>
{/if}
```

- [ ] **Step 9: Verify Task 1**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git grep -n 'ExitSessionDialog\|Save & Exit' -- src || true
git grep -n "sessionDialog === 'exit'" -- 'src/routes/puzzle/[id]/+page.svelte' || true
```

Negative tests may still mention the accessible name `Exit Mission` to prove absence.

Commit:

```bash
git add src/lib/components/DiscardSessionDialog.svelte \
  src/lib/components/ExitSessionDialog.svelte \
  src/lib/components/SessionPauseDialog.svelte \
  src/lib/components/__tests__/SessionDialogs.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): simplify restore exit and discard flow"
```

---

## Task 2: Add confirmed Discard to the home Continue panel

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`
- Reuse: `apps/web/src/lib/components/DiscardSessionDialog.svelte`

**Interfaces:**

- `discardTarget: GalleryProgress | null`
- Existing `createSessionStorageAdapter().clearSession`.
- Existing `discoverGalleryProgress()` remains the progress authority.

**Produces:** home can discard the surfaced resumable run, with the underlying page inert during confirmation.

- [ ] **Step 1: Add failing home tests**

Mock one storage adapter with `clearSession`.

Add:

```ts
it('makes main inert while home discard confirmation is open', async () => {
	render(GalleryPage);
	await page.getByRole('button', { name: 'Discard saved progress' }).click();

	const main = document.querySelector('main')!;
	expect(main.hasAttribute('inert')).toBe(true);
	expect(main.getAttribute('aria-hidden')).toBe('true');
	await expect.element(page.getByRole('dialog', { name: 'Discard saved progress' })).toBeVisible();
});
```

Add confirm:

```ts
it('clears and rediscovers progress after confirmed home discard', async () => {
	mockedDiscoverGalleryProgress
		.mockReturnValueOnce({ byPuzzleId: new Map([['p1', progress]]), newest: progress })
		.mockReturnValue({ byPuzzleId: new Map(), newest: null });

	render(GalleryPage);
	await page.getByRole('button', { name: 'Discard saved progress' }).click();
	await page
		.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Discard' })
		.click();

	expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('p1');
	await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
});
```

Add Cancel: no clear, `<main>` loses inert/`aria-hidden`, Continue remains.

- [ ] **Step 2: Add route-local target and confirm handler**

```ts
const sessionStorageAdapter = createSessionStorageAdapter();
let discardTarget = $state<GalleryProgress | null>(null);

function confirmDiscardProgress(): void {
	const target = discardTarget;
	if (!target) return;

	sessionStorageAdapter.clearSession(target.puzzleId);
	discardTarget = null;
	localProgress = discoverGalleryProgress({
		serverPuzzles: puzzles,
		quickPuzzles
	});
}
```

Keep the existing reactive discovery effect; do not create a store.

- [ ] **Step 3: Render modal outside inert `<main>`**

```svelte
<main
	inert={discardTarget !== null}
	aria-hidden={discardTarget !== null}
	...existing classes...
>
```

Beside `CONTINUE`:

```svelte
<button
	type="button"
	aria-label="Discard saved progress"
	onclick={() => (discardTarget = localProgress.newest)}
>
	DISCARD
</button>
```

After `</main>`:

```svelte
{#if discardTarget}
	<DiscardSessionDialog
		puzzleName={discardTarget.name}
		onConfirm={confirmDiscardProgress}
		onCancel={() => (discardTarget = null)}
	/>
{/if}
```

- [ ] **Step 4: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
bun run check

git add src/routes/+page.svelte src/routes/page.svelte.test.ts
git commit -m "feat(web): add home progress discard"
```

---

## Task 3: Make `puzzleLayout.ts` own one board↔tray sizing model and add the resizer

**Files:**

- Modify: `apps/web/src/lib/services/puzzleLayout.ts`
- Modify: `apps/web/src/lib/services/puzzleLayout.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

Export constants:

```ts
export const DESKTOP_TRAY_MIN_WIDTH = 300;
export const DESKTOP_TRAY_BASE_WIDTH = 360;
export const DESKTOP_BOARD_MIN_WIDTH = 480;
export const DESKTOP_TRAY_SEPARATOR_WIDTH = 20;
```

Add:

```ts
export function getDefaultPuzzleTrayWidth(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize
): number;

export function clampTrayWidth(layoutWidth: number, requestedWidth: number): number;
```

Change:

```ts
getResponsivePuzzleBoardMetrics(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize,
	trayWidth: number
): ResponsivePuzzleBoardMetrics;
```

**Produces:** initial tray is never narrower than the new 360px baseline or prior three-column footprint, applied tray width directly informs board metrics, requested width survives temporary viewport shrink, and splitter interaction composes with reference cleanup.

- [ ] **Step 1: Add failing layout-helper tests**

Update imports to include the new helpers/constants.

Dense default:

```ts
it('widens dense desktop trays beyond the old 17.5rem minimum', () => {
	const dense = {
		imageWidth: 1500,
		imageHeight: 1500,
		gridCols: 15,
		gridRows: 15
	};

	expect(getDefaultPuzzleTrayWidth(dense, { width: 1280, height: 900 }))
		.toBe(DESKTOP_TRAY_BASE_WIDTH);
});
```

Coarse default:

```ts
it('does not narrow a coarse three-column tray to 360px', () => {
	const coarse = {
		imageWidth: 1200,
		imageHeight: 900,
		gridCols: 4,
		gridRows: 3
	};

	// Preferred board width is 720, so preferred cell is 180.
	// Existing tray chrome is 42px: 3 * 180 + 42 = 582.
	expect(getDefaultPuzzleTrayWidth(coarse, { width: 1280, height: 900 })).toBe(582);
});
```

Clamp:

```ts
it('clamps the requested tray against board and tray minimums', () => {
	expect(clampTrayWidth(1000, 200)).toBe(300);
	expect(clampTrayWidth(1000, 700)).toBe(500);
	expect(clampTrayWidth(760, 360)).toBe(300);
});
```

Actual reservation:

```ts
it('reduces board width when the applied desktop tray is wider', () => {
	const puzzle = {
		imageWidth: 1200,
		imageHeight: 900,
		gridCols: 4,
		gridRows: 3
	};
	const viewport = { width: 1280, height: 900 };

	const narrowTray = getResponsivePuzzleBoardMetrics(puzzle, viewport, 360);
	const wideTray = getResponsivePuzzleBoardMetrics(puzzle, viewport, 580);

	expect(wideTray.boardWidth).toBeLessThan(narrowTray.boardWidth);
});
```

Run:

```bash
cd apps/web
bunx vitest --run src/lib/services/puzzleLayout.test.ts
```

- [ ] **Step 2: Replace the circular desktop solve**

Add constants:

```ts
export const DESKTOP_TRAY_MIN_WIDTH = 300;
export const DESKTOP_TRAY_BASE_WIDTH = 360;
export const DESKTOP_BOARD_MIN_WIDTH = 480;
export const DESKTOP_TRAY_SEPARATOR_WIDTH = 20;

const DESKTOP_TRAY_TARGET_COLUMNS = 3;
const DESKTOP_TRAY_CHROME_WIDTH = 42;
```

Extract the existing non-side-panel preferred width calculation:

```ts
function getPreferredBoardWidth(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize
): { tier: PuzzleBoardViewportTier; width: number } {
	const tier = getPuzzleBoardViewportTier(viewport.width);
	const gridCols = Math.max(1, puzzle.gridCols);
	const gridRows = Math.max(1, puzzle.gridRows);
	const imageAspect = puzzle.imageWidth / Math.max(1, puzzle.imageHeight);
	const targetLongEdge = TIER_LONG_EDGE[tier];
	const targetWidth = imageAspect >= 1 ? targetLongEdge : targetLongEdge * imageAspect;
	const viewportWidthCap = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		viewport.width - getWidthReserve(tier)
	);
	const viewportHeightCap = Math.max(
		MIN_BOARD_CELL_SIZE * gridRows,
		viewport.height - getHeightReserve(tier)
	);
	return {
		tier,
		width: Math.max(
			MIN_BOARD_CELL_SIZE * gridCols,
			Math.min(targetWidth, viewportWidthCap, viewportHeightCap * imageAspect)
		)
	};
}
```

Default tray:

```ts
export function getDefaultPuzzleTrayWidth(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize
): number {
	const { width } = getPreferredBoardWidth(puzzle, viewport);
	const cellSize = width / Math.max(1, puzzle.gridCols);
	return Math.max(
		DESKTOP_TRAY_BASE_WIDTH,
		cellSize * DESKTOP_TRAY_TARGET_COLUMNS + DESKTOP_TRAY_CHROME_WIDTH
	);
}
```

Clamp:

```ts
export function clampTrayWidth(layoutWidth: number, requestedWidth: number): number {
	const maxTrayWidth = Math.max(
		DESKTOP_TRAY_MIN_WIDTH,
		layoutWidth - DESKTOP_BOARD_MIN_WIDTH - DESKTOP_TRAY_SEPARATOR_WIDTH
	);
	return Math.min(
		Math.max(requestedWidth, DESKTOP_TRAY_MIN_WIDTH),
		maxTrayWidth
	);
}
```

Board metrics:

```ts
export function getResponsivePuzzleBoardMetrics(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize,
	trayWidth: number
): ResponsivePuzzleBoardMetrics {
	const { tier, width: preferredWidth } = getPreferredBoardWidth(puzzle, viewport);
	const gridCols = Math.max(1, puzzle.gridCols);
	const imageAspect = puzzle.imageWidth / Math.max(1, puzzle.imageHeight);

	const viewportWidthCap = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		viewport.width - getWidthReserve(tier)
	);
	const desktopWidthCap =
		tier === 'small' || tier === 'medium'
			? Number.POSITIVE_INFINITY
			: Math.max(
					MIN_BOARD_CELL_SIZE * gridCols,
					viewportWidthCap - trayWidth - DESKTOP_TRAY_SEPARATOR_WIDTH
				);

	const boardWidth = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		Math.min(preferredWidth, desktopWidthCap)
	);
	...
}
```

Delete `DESKTOP_SIDE_PANEL_COLUMNS`, `DESKTOP_LAYOUT_RESERVE`, and `1 + DESKTOP_SIDE_PANEL_COLUMNS / gridCols`.

Keep current rounding/height/cell return behavior.

- [ ] **Step 3: Update every metrics caller/test to pass tray width**

The only production caller is the puzzle route. Update `puzzleLayout.test.ts` and route tests to pass a desktop tray width explicitly.

Mobile/small/medium tests can pass `DESKTOP_TRAY_BASE_WIDTH`; the function ignores it for those tiers.

- [ ] **Step 4: Add failing route tests for requested/applied behavior**

Add a test that stubs the layout measurement and verifies keyboard resizing:

```ts
it('applies keyboard tray resizing against measured layout width', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	const separator = await page.getByTestId('tray-resizer').element();

	Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 1000 });
	window.dispatchEvent(new Event('resize'));

	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('376px');
});
```

Add request-preservation:

```ts
it('restores the requested tray width after layout shrink and re-widen', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	let width = 1100;
	Object.defineProperty(layout, 'clientWidth', {
		configurable: true,
		get: () => width
	});

	const separator = await page.getByTestId('tray-resizer').element();
	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('600px');

	width = 900;
	window.dispatchEvent(new Event('resize'));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('400px');

	width = 1100;
	window.dispatchEvent(new Event('resize'));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('600px');
});
```

Add board coupling:

```ts
it('recomputes board metrics from the applied tray width', async () => {
	await renderPuzzlePage();
	const before = document.querySelector<HTMLElement>('.board-canvas')!
		.style.getPropertyValue('--board-width');

	const separator = await page.getByTestId('tray-resizer').element();
	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));

	await expect
		.poll(() =>
			document.querySelector<HTMLElement>('.board-canvas')!
				.style.getPropertyValue('--board-width')
		)
		.not.toBe(before);
});
```

Keep/add pointer-ID and mobile hidden tests. Keep existing Hold-to-Peek pointer-release tests unchanged as regression coverage.

- [ ] **Step 5: Add route requested/applied state and layout measurement**

Import helpers/constants.

Add:

```ts
let gameLayoutElement = $state<HTMLElement | null>(null);
let gameLayoutWidth = $state(0);
let requestedTrayWidth = $state(DESKTOP_TRAY_BASE_WIDTH);
let trayResizePointerId = $state<number | null>(null);
let trayResizeStartX = $state(0);
let trayResizeStartWidth = $state(DESKTOP_TRAY_BASE_WIDTH);

const appliedTrayWidth = $derived(
	gameLayoutWidth > 0
		? clampTrayWidth(gameLayoutWidth, requestedTrayWidth)
		: requestedTrayWidth
);
```

Observe the layout rather than mutating request state during window resize:

```ts
$effect(() => {
	const layout = gameLayoutElement;
	if (!layout) return;

	const update = () => {
		gameLayoutWidth = layout.clientWidth;
	};
	update();

	const observer = new ResizeObserver(update);
	observer.observe(layout);
	return () => observer.disconnect();
});
```

When a new puzzle is loaded:

```ts
requestedTrayWidth = getDefaultPuzzleTrayWidth(loadedPuzzle, {
	width: viewportWidth,
	height: viewportHeight
});
```

Board metrics:

```ts
const boardMetrics = $derived(
	puzzle
		? getResponsivePuzzleBoardMetrics(
				puzzle,
				{ width: viewportWidth, height: viewportHeight },
				appliedTrayWidth
			)
		: null
);
```

User-driven setters clamp **at the current measured width** but viewport measurement changes do not rewrite the request:

```ts
function setRequestedTrayWidth(width: number): void {
	if (gameLayoutWidth <= 0) return;
	requestedTrayWidth = clampTrayWidth(gameLayoutWidth, width);
}

function currentMaxTrayWidth(): number {
	if (gameLayoutWidth <= 0) return Math.max(DESKTOP_TRAY_MIN_WIDTH, appliedTrayWidth);
	return clampTrayWidth(gameLayoutWidth, Number.POSITIVE_INFINITY);
}
```

- [ ] **Step 6: Compose splitter pointer cleanup**

Add one global listener:

```ts
window.addEventListener('pointermove', handleWindowPointerMove);
```

Remove it on destroy.

Extend existing `handleWindowPointerUp`:

```ts
function handleWindowPointerUp(event: PointerEvent) {
	if (referenceHoldSource === 'pointer' && referencePointerId === event.pointerId) {
		clearReferenceHold();
	}
	if (trayResizePointerId === event.pointerId) {
		trayResizePointerId = null;
	}
}
```

Add:

```ts
function handleWindowPointerMove(event: PointerEvent): void {
	if (trayResizePointerId !== event.pointerId) return;
	const deltaX = event.clientX - trayResizeStartX;
	setRequestedTrayWidth(trayResizeStartWidth - deltaX);
}

function handleTrayResizePointerDown(event: PointerEvent): void {
	if (event.pointerType === 'mouse' && event.button !== 0) return;
	trayResizePointerId = event.pointerId;
	trayResizeStartX = event.clientX;
	trayResizeStartWidth = requestedTrayWidth;
}
```

Extend existing `handleWindowBlur()` with:

```ts
trayResizePointerId = null;
```

Do not call `setPointerCapture`.

Keyboard:

```ts
function handleTrayResizeKeyDown(event: KeyboardEvent): void {
	switch (event.key) {
		case 'ArrowLeft':
			event.preventDefault();
			setRequestedTrayWidth(appliedTrayWidth + 16);
			break;
		case 'ArrowRight':
			event.preventDefault();
			setRequestedTrayWidth(appliedTrayWidth - 16);
			break;
		case 'Home':
			event.preventDefault();
			setRequestedTrayWidth(DESKTOP_TRAY_MIN_WIDTH);
			break;
		case 'End':
			event.preventDefault();
			setRequestedTrayWidth(currentMaxTrayWidth());
			break;
	}
}
```

- [ ] **Step 7: Render the coherent split**

Bind `.game-layout`.

Crucially, keep tray width outside the board-metrics conditional:

```svelte
<div
	bind:this={gameLayoutElement}
	class="game-layout"
	data-board-tier={currentBoardMetrics?.tier}
	style={`--tray-width: ${appliedTrayWidth}px; --tray-resizer-width: ${DESKTOP_TRAY_SEPARATOR_WIDTH}px; ${
		currentBoardMetrics
			? `--board-width: ${currentBoardMetrics.boardWidth}px; --board-height: ${currentBoardMetrics.boardHeight}px; --board-cell-size: ${currentBoardMetrics.cellSize}px; --piece-slot-size: ${currentBoardMetrics.pieceSlotSize}px;`
			: ''
	}`}
>
```

Between board and inventory:

```svelte
<div
	class="tray-resizer"
	data-testid="tray-resizer"
	role="separator"
	aria-label="Resize puzzle tray"
	aria-orientation="vertical"
	aria-valuemin={DESKTOP_TRAY_MIN_WIDTH}
	aria-valuemax={Math.round(currentMaxTrayWidth())}
	aria-valuenow={Math.round(appliedTrayWidth)}
	tabindex="0"
	onpointerdown={handleTrayResizePointerDown}
	onkeydown={handleTrayResizeKeyDown}
></div>
```

Desktop CSS:

```css
@media (min-width: 1024px) {
	.game-layout {
		grid-template-columns:
			minmax(0, 1fr)
			var(--tray-resizer-width)
			var(--tray-width);
		column-gap: 0;
	}

	.tray-resizer {
		display: block;
		cursor: col-resize;
		touch-action: none;
	}
}

@media (max-width: 1023px) {
	.tray-resizer {
		display: none;
	}
}
```

The 20px separator replaces the old 1.25rem column gap. Do not double-count a gap.

Do not change `PuzzleInventoryPanel` slot-size formula in this task.

- [ ] **Step 8: Verify Task 3**

```bash
cd apps/web
bunx vitest --run src/lib/services/puzzleLayout.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Commit:

```bash
git add src/lib/services/puzzleLayout.ts \
  src/lib/services/puzzleLayout.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): add coherent resizable puzzle tray"
```

---

## Task 4: Generate fresh rotation orientations per configured run

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/runtime.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.test.ts`

**Interfaces:** `createRotations(puzzleId, pieceIds)` stays unchanged.

**Produces:** each setup/restart calls the existing unseeded generator; non-empty all-upright results are bumped.

- [ ] **Step 1: Mock `generateRandomRotations`**

Hoist:

```ts
const rotationsMock = vi.hoisted(() =>
	vi.fn((ids: number[]) =>
		Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 90 : 0]))
	)
);

vi.mock('$lib/services/gameplay/rotation', () => ({
	generateRandomRotations: rotationsMock
}));
```

Reset in `beforeEach`.

Replace the deterministic-seed assertion with:

```ts
it('requests fresh rotations on every production call', () => {
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1]);

	runtime.createRotations('puzzle-1', [0, 1]);
	runtime.createRotations('puzzle-1', [0, 1]);

	expect(rotationsMock).toHaveBeenCalledTimes(2);
});
```

All-upright:

```ts
it('bumps the first piece when generated rotations are all upright', () => {
	rotationsMock.mockReturnValueOnce({ 0: 0, 1: 0, 2: 0 });
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);

	expect(runtime.createRotations('puzzle-1', [0, 1, 2])).toEqual({
		0: 90,
		1: 0,
		2: 0
	});
});
```

Keep valid-rotation and virtual-override tests. Do **not** add a clone-artifact test.

- [ ] **Step 2: Simplify only `buildRotations`**

```ts
function buildRotations(
	_puzzleId: string,
	pieceIds: readonly number[]
): Record<number, Rotation> {
	const rotations = generateRandomRotations([...pieceIds]);

	if (pieceIds.length > 0 && pieceIds.every((pieceId) => rotations[pieceId] === 0)) {
		rotations[pieceIds[0]!] = 90;
	}

	return rotations;
}
```

Delete the hash/seed loop. Do not touch `rotation.ts`, session code, runtime types, or virtual override.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/web
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bun run check

git add src/lib/services/gameplay/runtime.ts src/lib/services/gameplay/runtime.test.ts
git commit -m "feat(web): randomize rotation setup per run"
```

---

## Task 5: Keep hints until success and reveal the tray piece after render

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `docs/PRD.md`

**Interfaces:** existing `activeHintPieceId` / `activeHintTarget`; no session hint action/event changes.

**Produces:** persistent hint survives rejection, clears on accepted placement, opens/reveals after DOM update, and uses one gold cue.

- [ ] **Step 1: Add route tests that pin lifetime**

Rejected attempt retains hint:

```ts
it('keeps the hint after a rejected placement of the hinted piece', async () => {
	await renderPuzzlePage();
	await selectPiece(1);
	await page.getByLabelText('Hint').click();

	await placeSelectedPieceAt(0, 0); // wrong slot for piece 1

	await expect.element(page.getByTestId('piece-slot-1')).toHaveAttribute('data-hinted', 'true');
	await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
	await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-y', '0');
});
```

Accepted placement clears:

```ts
it('clears the hint only after the hinted piece is accepted', async () => {
	await renderPuzzlePage();
	await selectPiece(1);
	await page.getByLabelText('Hint').click();

	await placeSelectedPieceAt(1, 0);

	await expect.poll(() => page.getByTestId('hint-target').query()).toBeNull();
	expect(page.getByTestId('piece-slot-1').query()).toBeNull();
});
```

Also assert:

- hint remains beyond 1.8s with fake timers;
- second hint replaces first;
- Pause clears;
- navigation clears;
- existing Undo/Redo hint-preservation test stays green.

- [ ] **Step 2: Move hint clearing from attempt to accepted event**

Delete from `handlePiecePlaced`:

```ts
if (activeHintPieceId === pieceId) {
	clearHintTarget();
}
```

Extend `placement_accepted` event handling:

```ts
} else if (event.type === 'placement_accepted') {
	if (activeHintPieceId === event.pieceId) {
		clearHintTarget();
	}
	announceGameplay(
		event.completed
			? `Puzzle piece ${event.pieceId} placed. Puzzle complete.`
			: `Puzzle piece ${event.pieceId} placed.`
	);
```

Do not clear in `placement_rejected`.

- [ ] **Step 3: Remove timeout state**

Delete:

- `HINT_DURATION_MS`
- `hintTimeout`
- all hint `clearTimeout` branches
- timeout scheduling from `showHintTarget`.

Keep:

```ts
function clearHintTarget(): void {
	activeHintPieceId = null;
	activeHintTarget = null;
}

function showHintTarget(pieceId: number, target: { x: number; y: number }): void {
	activeHintPieceId = pieceId;
	activeHintTarget = target;
}
```

- [ ] **Step 4: Add an inventory test that proves scroll happens after the drawer is visible**

In test setup, replace `scrollIntoView` with a function that captures visibility at call time:

```ts
let drawerDisplayAtScroll = '';

const scrollIntoView = vi.fn(function (this: HTMLElement) {
	const body = this.closest<HTMLElement>('.inventory-body');
	drawerDisplayAtScroll = body ? getComputedStyle(body).display : '';
});
```

Test:

```ts
it('opens the drawer before scrolling the hinted piece into view', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);

	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	await view.rerender({ ...input, activeHintPieceId: 1 });

	await expect
		.element(page.getByTestId('inventory-drawer-toggle'))
		.toHaveAttribute('aria-expanded', 'true');
	await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

	expect(drawerDisplayAtScroll).not.toBe('none');
	expect(input.onSelect).not.toHaveBeenCalled();
});
```

Add/keep roving candidate without focus:

```ts
const focusedBefore = document.activeElement;
await view.rerender({ ...input, activeHintPieceId: 0 });
const hinted = await page.getByLabelText('Puzzle piece 0').element();

await expect.poll(() => hinted.tabIndex).toBe(0);
expect(document.activeElement).toBe(focusedBefore);
```

- [ ] **Step 5: Implement post-render reveal**

In `PuzzleInventoryPanel.svelte`:

```ts
import { tick } from 'svelte';
```

Add:

```ts
async function revealHintedPiece(pieceId: number): Promise<void> {
	drawerOpen = true;
	activePieceId = pieceId;
	await tick();

	if (activeHintPieceId !== pieceId) return;

	piecesGridElement
		?.querySelector<HTMLElement>(`[data-testid="piece-slot-${pieceId}"]`)
		?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

$effect(() => {
	const pieceId = activeHintPieceId;
	if (pieceId !== null) void revealHintedPiece(pieceId);
});
```

No `.focus()` and no callbacks.

On hinted slot:

```svelte
data-hinted={activeHintPieceId === piece.id ? 'true' : undefined}
```

Render `HINT` badge and use `var(--gold)` / `var(--gold-glow)`. Keep hinted precedence over rejected.

- [ ] **Step 6: Align board target styling**

Keep test IDs/coordinates. Replace hard-coded amber target treatment with `--gold` / `--gold-glow`. No board hint-selection logic.

- [ ] **Step 7: Update PRD**

Update both `1.8 s` hint descriptions to persistent tray-piece + board-target behavior.

Replace `seeded random init` with fresh randomized setup/restart orientation while restored orientation persists.

- [ ] **Step 8: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git grep -n '1\.8 s\|1\.8s\|seeded random init' -- ../../docs/PRD.md || true
```

Expected grep: no stale wording.

Commit:

```bash
git add src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts' \
  ../../docs/PRD.md
git commit -m "feat(web): reveal persistent hint relationship"
```

---

## Task 6: Add E2E coverage that actually runs in the default gate

**Files:**

- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-large-fixtures.spec.ts`

**Interfaces:**

- Reuse `GameplayPage.pauseMission()` and `readPersistedSession()`.
- Use `IMMEDIATE_START` for any fresh interaction test.
- Keep deterministic fixture/runtime overrides.

**Produces:** flow E2E plus one desktop splitter/hint smoke test selected by the automatic non-extended gate.

- [ ] **Step 1: Rewrite restored Relaxed E2E**

Existing restored Relaxed+rotation flow:

```ts
await gameplayPage.gotoFixture({ seedSession: seeded });

await expect(page.getByRole('dialog', { name: 'Resume Mission' })).toHaveCount(0);
await expect(page.getByTestId('relaxed-mode-indicator')).toBeVisible();

await gameplayPage.pauseMission();
await page
	.getByRole('dialog', { name: 'Mission Paused' })
	.getByRole('button', { name: 'Restart' })
	.click();
```

Keep Restart assertions for choices, fresh run ID, placements, and restart tray order.

Keep/add restored Timed coverage that still expects `Resume Mission`.

- [ ] **Step 2: Add direct Exit and Pause Discard smoke cases**

In `gameplay-session-controls.spec.ts`, define:

```ts
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = {
	...DEFAULT_GAMEPLAY_PREFERENCES,
	startImmediately: true
};
```

Direct Exit:

```ts
test('Exit saves progress and returns home without a choice dialog @smoke', async ({
	gameplayPage,
	page
}) => {
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);

	await page.getByTestId('back-to-arcade-link').click();

	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('dialog', { name: 'Exit Mission' })).toHaveCount(0);
	const persisted = await gameplayPage.readPersistedSession();
	expect(persisted?.placedPieces).toEqual([{ pieceId: 0, x: 0, y: 0 }]);
});
```

Discard:

```ts
test('Pause Discard removes saved progress after confirmation @smoke', async ({
	gameplayPage,
	page
}) => {
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
	await gameplayPage.pauseMission();

	await page.getByRole('button', { name: 'Discard' }).click();
	await page
		.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Discard' })
		.click();

	await expect(page).toHaveURL(/\/$/);
	expect(await gameplayPage.readPersistedSession()).toBeNull();
});
```

- [ ] **Step 3: Add a non-extended desktop splitter/hint smoke test**

`gameplay-large-fixtures.spec.ts` currently wraps its normal tests in:

```ts
test.describe('large fixtures @extended', ...)
```

Do **not** place the smoke test inside that describe.

After the extended describe closes, add a new describe without `@extended`:

```ts
test.describe('gameplay workspace polish smoke', () => {
	test('desktop tray drag and hint reveal @smoke', async ({
		gameplayPage,
		page
	}, testInfo) => {
		test.skip(
			testInfo.project.name !== 'chromium-desktop',
			'desktop-only split layout'
		);

		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-100',
			seedPreferences: IMMEDIATE_START
		});

		const layout = page.locator('.game-layout');
		const separator = page.getByTestId('tray-resizer');
		const before = await layout.evaluate((element) =>
			getComputedStyle(element).getPropertyValue('--tray-width').trim()
		);

		const box = await separator.boundingBox();
		expect(box).not.toBeNull();
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
		await page.mouse.down();
		await page.mouse.move(box!.x - 80, box!.y + box!.height / 2);
		await page.mouse.up();

		const after = await layout.evaluate((element) =>
			getComputedStyle(element).getPropertyValue('--tray-width').trim()
		);
		expect(after).not.toBe(before);

		await page.getByLabel('Puzzle piece 99', { exact: true }).click();
		await page.locator('.pieces-grid').evaluate((element) => {
			element.scrollTop = 0;
		});

		await page.getByRole('button', { name: 'Hint' }).click();

		const slot = page.getByTestId('piece-slot-99');
		await expect(slot).toHaveAttribute('data-hinted', 'true');
		await expect(slot).toBeInViewport();
		await expect(page.getByTestId('hint-target')).toBeVisible();
	});
});
```

Because the parent describe has no `@extended`, this test is selectable by:

- `test:e2e` (`--grep-invert @extended`)
- `test:e2e:smoke` (`--grep @smoke`)

Mobile smoke projects skip it before interaction.

- [ ] **Step 4: Verify and commit E2E**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile

# Prove the non-extended automatic selection path.
bunx playwright test e2e/gameplay-large-fixtures.spec.ts \
  --project=chromium-desktop \
  --grep-invert @extended \
  --grep 'desktop tray drag and hint reveal'

# Prove smoke selection too.
bunx playwright test e2e/gameplay-large-fixtures.spec.ts \
  --project=chromium-desktop \
  --grep @smoke \
  --grep 'desktop tray drag and hint reveal'
```

Commit:

```bash
git add e2e/gameplay-session-controls.spec.ts e2e/gameplay-large-fixtures.spec.ts
git commit -m "test(web): cover gameplay polish flows"
```

---

## Final Verification

- [ ] **Step 1: Review scope**

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- \
  apps/web/src/lib/components \
  apps/web/src/lib/services/puzzleLayout.ts \
  apps/web/src/lib/services/puzzleLayout.test.ts \
  apps/web/src/lib/services/gameplay/runtime.ts \
  apps/web/src/lib/services/gameplay/runtime.test.ts \
  apps/web/src/routes \
  apps/web/e2e \
  docs/PRD.md
```

Expected: no session schema, backend, dependency, generic split-pane, or unrelated refactor.

- [ ] **Step 2: Run focused unit/browser gate**

```bash
cd apps/web
bunx vitest --run src/lib/services/puzzleLayout.test.ts
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser src/routes/page.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

- [ ] **Step 3: Run E2E gates**

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-large-fixtures.spec.ts \
  --project=chromium-desktop \
  --grep-invert @extended \
  --grep 'desktop tray drag and hint reveal'
```

- [ ] **Step 4: Check stale contracts**

```bash
git grep -n 'ExitSessionDialog\|Save & Exit' -- apps/web/src || true
git grep -n "sessionDialog === 'exit'" -- 'apps/web/src/routes/puzzle/[id]/+page.svelte' || true
git grep -n '1\.8 s\|1\.8s\|seeded random init' -- docs/PRD.md || true
git grep -n 'DESKTOP_SIDE_PANEL_COLUMNS\|DESKTOP_LAYOUT_RESERVE' -- apps/web/src/lib/services/puzzleLayout.ts || true
```

Expected: no output from all four.

- [ ] **Step 5: Manual desktop smoke that catches layout coupling**

```text
1. Open a dense puzzle and confirm the initial tray is visibly wider than the old narrow sidebar.
2. Open a coarse/low-piece-count puzzle and confirm the default tray is not narrower than the previous three-column presentation.
3. Drag the separator wider and verify both tray width and board rendered width change without unused board-panel dead space.
4. Resize the browser narrower, then wider, and confirm the tray returns to the user's requested width.
5. Start a Relaxed rotation-enabled puzzle; confirm mixed starting orientations.
6. Place one piece, Exit, and confirm home navigation with saved Continue state and no exit popup.
7. Continue the Relaxed run with no Resume popup.
8. Pause, open Discard, cancel, and confirm the same pause presentation returns.
9. Request a hint, intentionally place that piece in a wrong cell, and confirm the hint remains.
10. Place the hinted piece correctly and confirm both tray and board hint markers clear.
11. Collapse the mobile drawer, request a hint, and confirm it opens and scrolls the hinted piece into view.
12. Discard from home and confirm the Continue panel recomputes.
```
