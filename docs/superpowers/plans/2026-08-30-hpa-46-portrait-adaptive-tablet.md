# HPA-46 Portrait and Adaptive Tablet UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the completed NativeScript iPad gameplay usable in portrait and preserve the same active puzzle run while rotating between portrait and landscape.

**Architecture:** Keep one mounted `Gameplay.svelte` tree. A tiny feature-local `gameplayLayout.ts` projects actual page size to concrete GridLayout rows/columns. `boardViewport.ts` additionally owns the pure "did the Canvas backing size really change?" decision so `PuzzleCanvas` cancels transient pointer state only on a real resize, never on routine `layoutChanged` refires. Portrait moves the same tray below the same Canvas and adds only a two-height ephemeral drawer; the existing toolbar is measured before any toolbar code is added.

**Tech Stack:** NativeScript 9, `@nativescript-community/svelte-native` ~1.0.30, Svelte ~4.2.20, TypeScript ~5.9, `@nativescript/canvas` 2.x, `@perseus/game-core`, Vitest 4, iOS/iPad.

**Spec:** `docs/superpowers/specs/2026-08-30-hpa-46-portrait-adaptive-tablet-design.md`

## Global Constraints

- One Linear ticket → one PR. Continue implementation on this planning PR/branch.
- `PuzzleSession` remains the only gameplay controller; no mobile store/controller.
- No game-core action or persisted schema change.
- No portrait-specific board/view model/canonical coordinate system.
- Reuse the existing `PuzzleCanvas`, `PuzzleTray`, `GameplayToolbar`, sheets, filesystem session adapter, and downloaded puzzle model.
- Landscape HPA-3 behavior stays unchanged.
- Landscape tray remains `320` DIPs wide.
- Portrait tray is `220` DIPs collapsed / `360` DIPs expanded; expansion is ephemeral.
- `sessionState.viewport` remains persisted user intent. `BoardTransform.viewport` is a render-clamped echo and is never written back because of relayout.
- Real surface resize may cancel an in-flight drag/pinch without committing transient gesture state.
- Do not add speculative compact-toolbar markup. Measure the existing toolbar first.
- No phone optimization, Android release work, Google auth/sync, draggable tray divider, named trays, generic responsive framework, or native E2E framework.
- Do not add a mobile `check`/`lint` task solely for HPA-46. `apps/mobile` currently has only `ios` and `test:unit`; root `bun run check` does not validate these mobile files.

---

## File map

| File                                              | Responsibility in HPA-46                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/mobile/app/gameplay/gameplayLayout.ts`      | New pure page-size → concrete tablet grid projection and safe initial default.   |
| `apps/mobile/app/gameplay/gameplayLayout.test.ts` | Pins default, landscape/portrait/drawer values, invalid inputs.                  |
| `apps/mobile/app/gameplay/boardViewport.ts`       | Adds pure `nextSurfaceMetrics()` beside existing backing-size math.              |
| `apps/mobile/app/gameplay/boardViewport.test.ts`  | Pins real-resize detection and the missing persisted-vs-render clamp invariants. |
| `apps/mobile/app/gameplay/Gameplay.svelte`        | Outer-page size source, adaptive grid, tray cancellation, drawer state.          |
| `apps/mobile/app/gameplay/PuzzleCanvas.svelte`    | Reuses one reset helper on real backing resize without viewport commit.          |
| `apps/mobile/app/gameplay/PuzzleTray.svelte`      | Exposes one narrow active-drag cancel seam and portrait drawer affordance.       |
| `apps/mobile/App_Resources/iOS/Info.plist`        | Enables portrait on iPad.                                                        |

Planned HPA-46 work does **not** touch `GameplayToolbar.svelte`, `app.css`, `apps/mobile/package.json`, game-core, API, workflows, web, downloads, or persistence.

If the Task 2A portrait smoke proves a real toolbar clipping defect, stop and revise this plan before adding toolbar code. The correction must reuse one toolbar markup tree.

---

### Task 1: Pin layout, surface-resize, and viewport contracts

**Files:**

- Create: `apps/mobile/app/gameplay/gameplayLayout.ts`
- Create: `apps/mobile/app/gameplay/gameplayLayout.test.ts`
- Modify: `apps/mobile/app/gameplay/boardViewport.ts`
- Modify: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Interfaces:**

- Produces: `DEFAULT_GAMEPLAY_LAYOUT: GameplayLayout`
- Produces: `createGameplayLayout(widthDip, heightDip, portraitTrayExpanded): GameplayLayout | null`
- Produces: `nextSurfaceMetrics(layoutWidthDip, layoutHeightDip, density, previous): NextSurfaceMetrics | null`
- Does not change placement, viewport persistence, or `PuzzleSession`.

- [ ] **Step 1: Write the failing adaptive-layout tests**

Create `apps/mobile/app/gameplay/gameplayLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_GAMEPLAY_LAYOUT,
	LANDSCAPE_TRAY_WIDTH,
	PORTRAIT_TRAY_COLLAPSED_HEIGHT,
	PORTRAIT_TRAY_EXPANDED_HEIGHT,
	createGameplayLayout
} from './gameplayLayout';

describe('createGameplayLayout', () => {
	it('exports the existing HPA-3 landscape layout as the safe initial default', () => {
		expect(DEFAULT_GAMEPLAY_LAYOUT).toEqual({
			mode: 'landscape',
			rows: '*',
			columns: `*,${LANDSCAPE_TRAY_WIDTH}`,
			trayRow: 0,
			trayColumn: 1
		});
	});

	it('keeps the right tray in landscape', () => {
		expect(createGameplayLayout(1194, 834, false)).toEqual(DEFAULT_GAMEPLAY_LAYOUT);
	});

	it('uses the collapsed bottom tray in portrait', () => {
		expect(createGameplayLayout(834, 1194, false)).toEqual({
			mode: 'portrait',
			rows: `*,${PORTRAIT_TRAY_COLLAPSED_HEIGHT}`,
			columns: '*',
			trayRow: 1,
			trayColumn: 0
		});
	});

	it('expands only the portrait tray height', () => {
		expect(createGameplayLayout(834, 1194, true)?.rows).toBe(`*,${PORTRAIT_TRAY_EXPANDED_HEIGHT}`);
		expect(createGameplayLayout(1194, 834, true)).toEqual(DEFAULT_GAMEPLAY_LAYOUT);
	});

	it('returns null for non-renderable sizes', () => {
		expect(createGameplayLayout(0, 1194, false)).toBeNull();
		expect(createGameplayLayout(834, Number.NaN, false)).toBeNull();
	});
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run:

```bash
bun run --cwd apps/mobile test:unit -- gameplayLayout.test.ts
```

Expected: FAIL resolving `./gameplayLayout`.

- [ ] **Step 3: Implement the feature-local layout projection**

Create `apps/mobile/app/gameplay/gameplayLayout.ts`:

```ts
export const LANDSCAPE_TRAY_WIDTH = 320;
export const PORTRAIT_TRAY_COLLAPSED_HEIGHT = 220;
export const PORTRAIT_TRAY_EXPANDED_HEIGHT = 360;

export type GameplayLayoutMode = 'landscape' | 'portrait';

export interface GameplayLayout {
	mode: GameplayLayoutMode;
	rows: string;
	columns: string;
	trayRow: number;
	trayColumn: number;
}

export const DEFAULT_GAMEPLAY_LAYOUT: GameplayLayout = {
	mode: 'landscape',
	rows: '*',
	columns: `*,${LANDSCAPE_TRAY_WIDTH}`,
	trayRow: 0,
	trayColumn: 1
};

export function createGameplayLayout(
	widthDip: number,
	heightDip: number,
	portraitTrayExpanded: boolean
): GameplayLayout | null {
	if (
		!Number.isFinite(widthDip) ||
		!Number.isFinite(heightDip) ||
		widthDip <= 0 ||
		heightDip <= 0
	) {
		return null;
	}

	if (heightDip > widthDip) {
		const trayHeight = portraitTrayExpanded
			? PORTRAIT_TRAY_EXPANDED_HEIGHT
			: PORTRAIT_TRAY_COLLAPSED_HEIGHT;
		return {
			mode: 'portrait',
			rows: `*,${trayHeight}`,
			columns: '*',
			trayRow: 1,
			trayColumn: 0
		};
	}

	return DEFAULT_GAMEPLAY_LAYOUT;
}
```

Do not add breakpoints, device classes, toolbar flags, drawer-mode flags, platform checks, or a responsive-layout registry.

- [ ] **Step 4: Add failing pure tests for Canvas backing-size change detection**

Extend the import in `boardViewport.test.ts` to include `nextSurfaceMetrics`, then add:

```ts
describe('nextSurfaceMetrics', () => {
	it('does not treat the first valid layout as a resize', () => {
		expect(nextSurfaceMetrics(512, 384, 2, null)).toEqual({
			metrics: {
				layoutWidthDip: 512,
				layoutHeightDip: 384,
				backingWidth: 1024,
				backingHeight: 768
			},
			backingChanged: false
		});
	});

	it('does not reset pointers for an identical layoutChanged refire', () => {
		const previous = {
			layoutWidthDip: 512,
			layoutHeightDip: 384,
			backingWidth: 1024,
			backingHeight: 768
		};

		expect(nextSurfaceMetrics(512, 384, 2, previous)?.backingChanged).toBe(false);
	});

	it('reports a real backing resize after the surface was established', () => {
		const previous = {
			layoutWidthDip: 512,
			layoutHeightDip: 384,
			backingWidth: 1024,
			backingHeight: 768
		};

		expect(nextSurfaceMetrics(600, 384, 2, previous)).toEqual({
			metrics: {
				layoutWidthDip: 600,
				layoutHeightDip: 384,
				backingWidth: 1200,
				backingHeight: 768
			},
			backingChanged: true
		});
	});

	it('rejects non-renderable surface input', () => {
		expect(nextSurfaceMetrics(0, 384, 2, null)).toBeNull();
		expect(nextSurfaceMetrics(512, 384, 0, null)).toBeNull();
	});
});
```

Run:

```bash
bun run --cwd apps/mobile test:unit -- boardViewport.test.ts
```

Expected: FAIL because `nextSurfaceMetrics` is not exported.

- [ ] **Step 5: Implement `nextSurfaceMetrics` next to the existing surface math**

In `boardViewport.ts`, add:

```ts
export interface NextSurfaceMetrics {
	metrics: CanvasSurfaceMetrics;
	backingChanged: boolean;
}

export function nextSurfaceMetrics(
	layoutWidthDip: number,
	layoutHeightDip: number,
	density: number,
	previous: CanvasSurfaceMetrics | null
): NextSurfaceMetrics | null {
	const backing = backingSizeFromLayout(layoutWidthDip, layoutHeightDip, density);
	if (!backing) return null;

	const metrics: CanvasSurfaceMetrics = {
		layoutWidthDip,
		layoutHeightDip,
		backingWidth: Math.round(backing.width),
		backingHeight: Math.round(backing.height)
	};

	return {
		metrics,
		backingChanged:
			previous !== null &&
			(previous.backingWidth !== metrics.backingWidth ||
				previous.backingHeight !== metrics.backingHeight)
	};
}
```

Keep `backingSizeFromLayout()` unchanged; the new helper composes it and owns the one rounding point used by `PuzzleCanvas`.

- [ ] **Step 6: Add only the missing persisted-vs-render viewport assertions**

Add one test to `boardViewport.test.ts`:

```ts
it('keeps persisted pan intent while a narrower aspect clamps only the render projection', () => {
	const viewport = { zoom: 2, panX: 0, panY: 1 };
	const puzzle = { gridCols: 4, gridRows: 3, viewport };

	const landscape = createBoardTransform({
		...puzzle,
		canvasWidth: 1000,
		canvasHeight: 700
	});
	const portrait = createBoardTransform({
		...puzzle,
		canvasWidth: 700,
		canvasHeight: 1000
	});
	const landscapeAgain = createBoardTransform({
		...puzzle,
		canvasWidth: 1000,
		canvasHeight: 700
	});

	expect(landscape.viewport).toEqual(viewport);
	expect(portrait.viewport?.zoom).toBe(2);
	expect(portrait.viewport?.panX).toBe(0);
	expect(portrait.viewport?.panY).toBeCloseTo(1 / 7);
	expect(viewport).toEqual({ zoom: 2, panX: 0, panY: 1 });
	expect(landscapeAgain.viewport).toEqual(viewport);
});
```

This extends existing clamp/fixed-point coverage rather than replacing or duplicating it.

- [ ] **Step 7: Run the complete mobile unit suite**

Run:

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 8: Commit the pure contracts**

```bash
git add apps/mobile/app/gameplay/gameplayLayout.ts \
  apps/mobile/app/gameplay/gameplayLayout.test.ts \
  apps/mobile/app/gameplay/boardViewport.ts \
  apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "test(mobile): pin adaptive surface contracts"
```

---

### Task 2A: Prove one-tree runtime reflow before building portrait polish

**Files:**

- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`

**Interfaces:**

- Consumes: `DEFAULT_GAMEPLAY_LAYOUT`, `createGameplayLayout()` from Task 1.
- Produces: one mounted Canvas/tray tree moving between right-panel landscape and bottom-panel portrait.
- Does not add the drawer affordance or resize-cancellation code yet.

- [ ] **Step 1: Enable iPad portrait**

In `UISupportedInterfaceOrientations~ipad`, use exactly:

```xml
<array>
  <string>UIInterfaceOrientationPortrait</string>
  <string>UIInterfaceOrientationPortraitUpsideDown</string>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
```

Declare all four iPad orientations so the app remains eligible for Split View / Slide Over multitasking (no `UIRequiresFullScreen` opt-out), which is what makes the outer-page window-size adaptivity reachable. Upside-down portrait reuses the portrait layout because the grid is dimension-driven, so it needs no separate UX. Do not alter the existing phone orientation array.

- [ ] **Step 2: Seed one safe layout and measure the outer page grid**

In `Gameplay.svelte`, extend the NativeScript import and add the layout helper import:

```ts
import { Application, Screen } from '@nativescript/core';
import { DEFAULT_GAMEPLAY_LAYOUT, createGameplayLayout } from './gameplayLayout';
```

Add component state:

```ts
let portraitTrayExpanded = false;
let pageWidthDip = Screen.mainScreen.widthDIPs;
let pageHeightDip = Screen.mainScreen.heightDIPs;
let gameplayLayout =
	createGameplayLayout(pageWidthDip, pageHeightDip, portraitTrayExpanded) ??
	DEFAULT_GAMEPLAY_LAYOUT;

function onGameplayLayoutChanged(args: any): void {
	const size = args.object?.getActualSize?.();
	if (!size || size.width <= 0 || size.height <= 0) return;
	if (size.width === pageWidthDip && size.height === pageHeightDip) return;

	const next = createGameplayLayout(size.width, size.height, portraitTrayExpanded);
	if (!next) return;

	pageWidthDip = size.width;
	pageHeightDip = size.height;
	gameplayLayout = next;
}
```

The default is only an initial safe value. Later invalid/zero events keep the last valid `gameplayLayout`.

- [ ] **Step 3: Attach `layoutChanged` to the outer page, not the toolbar-dependent content grid**

Change the existing outer gameplay grid to:

```svelte
<gridLayout
  bind:this={page}
  backgroundColor="#111820"
  on:layoutChanged={onGameplayLayoutChanged}
>
```

Keep the existing inner `rows="auto,*"` toolbar/content structure.

- [ ] **Step 4: Make only the content grid adaptive while keeping one Canvas and one tray**

Replace the fixed `columns="*,320"` content grid with:

```svelte
<gridLayout row={1} rows={gameplayLayout.rows} columns={gameplayLayout.columns}>
	<gridLayout row={0} col={0}>
		<PuzzleCanvas
			bind:this={puzzleCanvas}
			{sessionState}
			piecePaths={launch.install.piecePaths}
			referencePath={launch.install.referencePath}
			referenceMode={sessionState.activeReferenceMode}
			{hintTarget}
			{placementFeedback}
			onAttemptPlacement={attemptPlacement}
			onViewportCommit={commitViewport}
		/>
	</gridLayout>

	<gridLayout row={gameplayLayout.trayRow} col={gameplayLayout.trayColumn}>
		<PuzzleTray
			{sessionState}
			pieces={spec.pieces}
			piecePaths={launch.install.piecePaths}
			{hintPieceId}
			onSelectPiece={selectPiece}
			onPieceDragStart={startPieceDrag}
			onPieceDragMove={movePieceDrag}
			onPieceDragEnd={endPieceDrag}
			onPieceDragCancel={cancelPieceDrag}
			onSetFilter={setTrayFilter}
			onShuffle={shuffleTray}
			onRotateSelected={rotateSelected}
		/>
	</gridLayout>
</gridLayout>
```

Do not change `GameplayToolbar.svelte` in this task.

- [ ] **Step 5: Run the unit suite before the native gate**

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 6: Run the native reflow stop gate now**

From `apps/mobile`:

```bash
bunx ns run ios --no-hmr --justlaunch
```

On the target iPad simulator/device:

1. open/resume a puzzle in landscape;
2. place/select at least one piece;
3. rotate to portrait;
4. confirm the same run, placement, selected state, Canvas content, and tray contents remain present;
5. exercise Library, Undo, Redo, Hint, Reference, More, and the More menu at portrait width;
6. rotate back to landscape and confirm the existing HPA-3 layout returns.

**Stop condition:** if runtime `row`/`col` changes remount or break the Canvas/tray, stop HPA-46 here. Replace dynamic child-placement attributes with the smallest imperative GridLayout/native-view property update on the same views. Do not proceed to Task 2B/2C and do not duplicate portrait markup.

**Toolbar stop condition:** if a toolbar action or More/Reference item actually clips or becomes unreachable in the supported portrait target, stop and revise the design/plan before adding toolbar code. Do not implement the previously proposed duplicate compact toolbar.

- [ ] **Step 7: Commit the proven adaptive composition**

```bash
git add apps/mobile/App_Resources/iOS/Info.plist \
  apps/mobile/app/gameplay/Gameplay.svelte
git commit -m "feat(mobile): adapt gameplay grid for portrait"
```

---

### Task 2B: Cancel stale gesture state only on real resize

**Files:**

- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`

**Interfaces:**

- Consumes: `nextSurfaceMetrics()` from Task 1.
- Produces: `PuzzleTray.cancelActiveDrag(): void`.
- Preserves: no viewport commit on resize, existing screen-DIP drop path, existing native cancel semantics.

- [ ] **Step 1: Extract the existing Canvas reset body into one no-commit helper**

In `PuzzleCanvas.svelte`, replace the duplicated run-change reset body with:

```ts
function resetPointerGestureWithoutCommit(): void {
	gesture = null;
	transientViewport = undefined;
	lastPointerPoints = [null, null];
	activePointerCount = 0;
}
```

Then keep the existing run-change behavior as:

```ts
$: if (sessionState && sessionState.runId !== lastRunId) {
	resetPointerGestureWithoutCommit();
	lastRunId = sessionState.runId;
}
```

Do not change the existing touch `cancel` semantics in this task.

- [ ] **Step 2: Make `syncSurface()` consume the tested surface helper**

Extend the `boardViewport` import with `nextSurfaceMetrics`.

Replace the local `backingSizeFromLayout`/rounding block in `syncSurface()` with:

```ts
function syncSurface(args: any): void {
	const view = args.object ?? canvas;
	const size = view?.getActualSize?.();
	const density = Screen.mainScreen.scale || 1;
	if (!size) return;

	const next = nextSurfaceMetrics(size.width, size.height, density, surfaceMetrics);
	if (!next) return;

	if (next.backingChanged) {
		resetPointerGestureWithoutCommit();
	}

	canvas.width = next.metrics.backingWidth;
	canvas.height = next.metrics.backingHeight;
	surfaceMetrics = next.metrics;

	rebuildTransform(next.backingChanged ? sessionState.viewport : effectiveViewport);

	if (!firstPaintScheduled) {
		firstPaintScheduled = true;
		setTimeout(() => {
			surfaceReady = true;
			draw();
		}, 0);
	} else if (surfaceReady) {
		draw();
	}
}
```

Remove the now-unused `backingSizeFromLayout` import from `PuzzleCanvas.svelte`.

The `sessionState.viewport` branch is deliberate: Svelte reactive `effectiveViewport` does not synchronously recompute just because `transientViewport` was cleared inside this function.

- [ ] **Step 3: Reuse the tray's existing native-cancel body through one exported method**

In `PuzzleTray.svelte`, add:

```ts
export function cancelActiveDrag(): void {
	if (!dragArmed) return;
	dragArmed = false;
	onPieceDragCancel();
}
```

Then change only the existing touch-cancel branch to reuse it:

```ts
} else if (args.action === 'cancel') {
  cancelActiveDrag();
}
```

Do not copy the cancellation body into a second helper/module.

- [ ] **Step 4: Cancel an armed tray drag when the outer page really changes size**

In `Gameplay.svelte`, bind the existing tray instance:

```ts
let puzzleTray: any = null;
```

```svelte
<PuzzleTray bind:this={puzzleTray} ... />
```

Update `onGameplayLayoutChanged` so it cancels the local drag before applying a real new page size:

```ts
function onGameplayLayoutChanged(args: any): void {
	const size = args.object?.getActualSize?.();
	if (!size || size.width <= 0 || size.height <= 0) return;
	if (size.width === pageWidthDip && size.height === pageHeightDip) return;

	const next = createGameplayLayout(size.width, size.height, portraitTrayExpanded);
	if (!next) return;

	puzzleTray?.cancelActiveDrag?.();
	pageWidthDip = size.width;
	pageHeightDip = size.height;
	gameplayLayout = next;
}
```

This uses the page-size change to clean tray-local drag state; Canvas independently uses its actual backing-size change to clean multi-pointer state.

- [ ] **Step 5: Run the automated surface tests and full mobile unit suite**

```bash
bun run --cwd apps/mobile test:unit -- boardViewport.test.ts
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 6: Verify pinch still works after a completed rotation**

Run/keep the iPad app open and exercise:

1. pinch/zoom successfully in landscape;
2. lift all fingers;
3. rotate to portrait;
4. perform a new pinch immediately;
5. rotate back and perform another new pinch;
6. confirm no rotation itself writes a new session viewport beyond normal completed gesture commits.

If practical, also rotate while a pinch or tray drag is active and verify the gesture simply cancels without leaving tray scrolling disabled or the next pinch broken.

- [ ] **Step 7: Commit resize cancellation**

```bash
git add apps/mobile/app/gameplay/PuzzleCanvas.svelte \
  apps/mobile/app/gameplay/PuzzleTray.svelte \
  apps/mobile/app/gameplay/Gameplay.svelte
git commit -m "fix(mobile): reset gestures on gameplay resize"
```

---

### Task 2C: Add the portrait bottom drawer and finish acceptance

**Files:**

- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`

**Interfaces:**

- Reuses `GameplayLayout.mode`; derives portrait/drawer behavior from `mode === 'portrait'`.
- Adds presentation props: `drawerMode`, `drawerExpanded`, `onToggleDrawer`.
- Does not change filters, order, tile size, long-press drag ownership, toolbar, or persistence.

- [ ] **Step 1: Add one drawer toggle that recomputes the current layout from the last valid page size**

In `Gameplay.svelte`:

```ts
function togglePortraitTray(): void {
	portraitTrayExpanded = !portraitTrayExpanded;
	const next = createGameplayLayout(pageWidthDip, pageHeightDip, portraitTrayExpanded);
	if (next) gameplayLayout = next;
}
```

The value stays in memory across orientation changes but is never persisted.

- [ ] **Step 2: Pass derived drawer presentation to the existing tray**

Add to the existing `PuzzleTray` call:

```svelte
drawerMode={gameplayLayout.mode === 'portrait'}
drawerExpanded={portraitTrayExpanded}
onToggleDrawer={togglePortraitTray}
```

Do not add a second `drawerMode` field to `GameplayLayout`.

- [ ] **Step 3: Add the portrait-only affordance without changing the tray body**

In `PuzzleTray.svelte`, add:

```ts
export let drawerMode = false;
export let drawerExpanded = false;
export let onToggleDrawer: () => void = () => {};

$: headerColumns = drawerMode ? 'auto,*,auto,auto,auto' : 'auto,*,auto,auto';
$: shuffleColumn = drawerMode ? 3 : 2;
$: rotateColumn = drawerMode ? 4 : 3;
```

Replace only the header GridLayout with:

```svelte
<gridLayout row={0} class="tray-header" columns={headerColumns}>
	<label
		col={0}
		text={`REMAINING ${remainingCount}`}
		class="tray-count"
		verticalAlignment="middle"
	/>
	{#if drawerMode}
		<button
			col={2}
			text={drawerExpanded ? 'LESS PIECES' : 'MORE PIECES'}
			class="tray-action"
			on:tap={onToggleDrawer}
		/>
	{/if}
	<button col={shuffleColumn} text="SHUFFLE" class="tray-action" on:tap={onShuffle} />
	<button
		col={rotateColumn}
		text="ROTATE"
		class={canRotate ? 'tray-action' : 'tray-action-disabled'}
		isEnabled={canRotate}
		on:tap={onRotateSelected}
	/>
</gridLayout>
```

Keep the existing filter row, ScrollView, WrapLayout, tile size, tap selection, longPress, and touch handlers unchanged.

- [ ] **Step 4: Run the complete mobile unit suite**

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

Do **not** list root `bun run check` as evidence for this task; mobile has no `check` script and the `.svelte` changes have no dedicated automated checker in the current repo.

- [ ] **Step 5: Run the final native iPad acceptance journey**

From `apps/mobile`:

```bash
bunx ns run ios --no-hmr --justlaunch
```

Exercise this exact journey:

1. start/open or resume a downloaded puzzle in portrait;
2. confirm the existing toolbar, More menu, and Reference menu are fully reachable without clipping;
3. collapse and expand the bottom tray;
4. select and place a piece in portrait;
5. set a non-All tray filter;
6. pinch/zoom, lift fingers, rotate to landscape, then immediately verify a new pinch works;
7. confirm the same run, placed piece, filter, selection where applicable, timer/lifecycle, and persisted viewport intent remain;
8. verify the existing HPA-3 right tray and toolbar in landscape;
9. rotate back to portrait and verify another new pinch works;
10. long-press drag one tray piece onto the board in portrait;
11. background the app for several seconds, foreground it, and confirm HPA-3 timing/session behavior remains unchanged.

If the existing toolbar fails Step 2, stop before shipping and update the design/plan with evidence from the failing width. Any correction must reflow the one existing toolbar/menu tree; do not fork portrait markup.

- [ ] **Step 6: Re-run mobile unit tests after any acceptance fixes**

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit the drawer/final HPA-46 slice**

```bash
git add apps/mobile/app/gameplay/Gameplay.svelte \
  apps/mobile/app/gameplay/PuzzleTray.svelte
git commit -m "feat(mobile): finish portrait tray layout"
```

---

## Final review checklist

Before marking HPA-46 ready for review:

- [ ] Diff stays within the HPA-46 adaptive tablet slice plus its docs.
- [ ] `PuzzleSession` construction still happens once in `Gameplay.svelte`; orientation does not reload/recreate it.
- [ ] Exactly one `PuzzleCanvas` and one `PuzzleTray` exist in gameplay markup.
- [ ] Outer page size, not toolbar-reduced inner content size, chooses portrait vs landscape.
- [ ] Landscape still uses the HPA-3 `320` DIP right tray.
- [ ] Portrait uses one bottom tray with `220`/`360` DIP states.
- [ ] Drawer expansion is not persisted and is not duplicated inside `GameplayLayout`.
- [ ] `nextSurfaceMetrics()` proves first layout/identical refire/real resize behavior.
- [ ] A real Canvas resize resets transient multi-pointer state without `onViewportCommit`.
- [ ] Tray active drag is canceled through the existing `onPieceDragCancel` path when page size changes.
- [ ] `sessionState.viewport` remains persisted intent; render-clamped `BoardTransform.viewport` is never written back on relayout.
- [ ] No orientation-specific viewport/schema field exists.
- [ ] Existing toolbar remains unchanged unless native evidence forced a separately reviewed single-tree reflow.
- [ ] iPad plist declares all four orientations (portrait, upside-down portrait, both landscapes) to remain multitasking-eligible; no `UIRequiresFullScreen` opt-out.
- [ ] `bun run --cwd apps/mobile test:unit` passes.
- [ ] NativeScript iOS build/smoke covers one-tree reflow, portrait toolbar reachability, drawer, pinch after rotate, portrait drag placement, and background/foreground.
- [ ] PR body records native evidence and any measured deviation from `220`/`360` tray heights.
