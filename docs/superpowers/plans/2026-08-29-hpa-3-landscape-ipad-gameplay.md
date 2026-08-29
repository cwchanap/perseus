# HPA-3 Landscape iPad Gameplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the production landscape iPad puzzle experience on the existing NativeScript offline library, with layout-derived Canvas sizing, transform-aware touch interaction, and current gameplay parity driven by the shared `PuzzleSession`.

**Architecture:** Keep `Gameplay.svelte` as the mobile composition root, `PuzzleSession` as the only gameplay controller, and file-backed sessions as the only mobile save source. Add one narrow shared viewport action, keep Canvas/gesture/coordinate math mobile-local and pure, and build concrete landscape tray/toolbar/sheet components around the existing engine; no backend, new schema, generic UI framework, or second store.

**Tech Stack:** TypeScript 5.9, NativeScript 9, Svelte Native 1.0, `@nativescript/canvas` 2.1, Vitest 4, `@perseus/game-core`.

**Spec:** `docs/superpowers/specs/2026-08-29-hpa-3-landscape-ipad-gameplay-design.md`

## Global Constraints

- One HPA-3 PR only. Continue implementation on `docs/hpa-3-landscape-ipad-gameplay-plan`; do not open a second implementation PR.
- Concrete downloaded variant `manifest.puzzle.id` remains gameplay/session/download identity. `familyId` and `difficulty` are presentation metadata only.
- Do not change API routes, D1, Workflows, infrastructure, auth, download-manifest schema, or persisted-session schema version.
- `PuzzleSession` remains the sole owner of placement validity, lifecycle/mode/time, rotation, history, hints, reference mode, filter/order, and completion sealing.
- Mobile must not expose named/staging tray membership, active tray selection, tray names, rename/remove, multi-select, or clustering.
- No mobile controller/global store, generic toolbar/dialog/gesture framework, or broad native E2E framework.
- HPA-3 is iPad landscape only. HPA-46 owns portrait and live orientation changes.
- Package-local mobile TypeScript is authoritative: `cd apps/mobile && bunx tsc --noEmit`.
- Review tasks as separate commits inside this one PR; do not squash the implementation into one unreviewable checkpoint.

## Planned file ownership

### Shared game core

- `packages/game-core/src/session/types.ts` — narrow viewport action/outcomes.
- `packages/game-core/src/session/session.ts` — validate/clone/apply viewport changes.
- `packages/game-core/src/session/session.test.ts` — viewport transition semantics + serialize/load round trip.

The existing V1 codec already serializes `viewport` and rejects non-finite values and `zoom <= 0`. Keep the schema and codec unchanged; `doSetViewport()` mirrors that numeric predicate so engine-produced state can never poison the next load.

### Mobile pure helpers

- `apps/mobile/app/gameplay/boardViewport.ts` + `.test.ts` — layout-DIP/backing-pixel sizing, screen-to-canvas conversion, fit/zoom/pan transform, two-pointer math, double-tap Fit eligibility.
- `apps/mobile/app/gameplay/trayPieces.ts` + `.test.ts` — Fisher-Yates order policy first; later extend with filtered unplaced projection.
- `apps/mobile/app/gameplay/boardViewModel.ts` + `.test.ts` — board-only render records and transformed hit testing.

### Mobile product components

- `Gameplay.svelte` — session construction/dispatch, persistence, drag overlay, ephemeral hint/feedback/sheet state.
- `PuzzleCanvas.svelte` — layout-derived Canvas backing size, board/reference drawing, Canvas gestures, transformed hit testing.
- `PuzzleTray.svelte` — persistent right tray and piece touch.
- `GameplayToolbar.svelte` — visible controls plus concrete More/Reference rows.
- `MissionSetupSheet.svelte`, `PauseSheet.svelte`, `DiscardSheet.svelte`, `CompletionSheet.svelte` — concrete HPA-3 sheets.
- `apps/mobile/app/app.css` — landscape presentation.
- `apps/mobile/App_Resources/iOS/Info.plist` — iPad landscape-only orientation.
- `apps/mobile/app/library/Downloaded.svelte` — difficulty-aware row copy only.

---

### Task 1: Give `PuzzleSession` one safe persisted viewport action

**Files:**
- Modify: `packages/game-core/src/session/types.ts`
- Modify: `packages/game-core/src/session/session.ts`
- Modify: `packages/game-core/src/session/session.test.ts`

**Interfaces:**

```ts
// PuzzleSessionAction
| { type: 'set_viewport'; viewport: PersistedViewport | null }

// PuzzleSessionOutcome
| { type: 'viewport_changed'; viewport: PersistedViewport | null }
| { type: 'viewport_noop'; reason: 'invalid_viewport' }
```

- [ ] **Step 1: Add failing viewport-action tests**

Add focused tests beside the existing session tests:

```ts
it('stores viewport without making navigation gameplay activity or history', () => {
  const session = createPuzzleSession(makeOptions());
  session.dispatch({ type: 'start' });
  const before = session.getState();

  expect(
    session.dispatch({
      type: 'set_viewport',
      viewport: { zoom: 2, panX: 1.25, panY: -0.5 }
    })
  ).toEqual({
    type: 'viewport_changed',
    viewport: { zoom: 2, panX: 1.25, panY: -0.5 }
  });

  const after = session.getState();
  expect(after.viewport).toEqual({ zoom: 2, panX: 1.25, panY: -0.5 });
  expect(after.hasUserActivity).toBe(before.hasUserActivity);
  expect(after.canUndo).toBe(before.canUndo);
  expect(after.canRedo).toBe(before.canRedo);
  expect(after.resultClass).toBe(before.resultClass);
});

it.each([
  { zoom: 0, panX: 0, panY: 0 },
  { zoom: -1, panX: 0, panY: 0 },
  { zoom: Number.NaN, panX: 0, panY: 0 },
  { zoom: 1, panX: Number.POSITIVE_INFINITY, panY: 0 }
])('rejects a viewport the V1 codec would reject: %o', (viewport) => {
  const session = createPuzzleSession(makeOptions());
  session.dispatch({ type: 'start' });
  const before = session.getState().viewport;

  expect(session.dispatch({ type: 'set_viewport', viewport })).toEqual({
    type: 'viewport_noop',
    reason: 'invalid_viewport'
  });
  expect(session.getState().viewport).toEqual(before);
});

it('clears viewport for Fit', () => {
  const session = createPuzzleSession(makeOptions());
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'set_viewport', viewport: { zoom: 2, panX: 1, panY: 1 } });

  expect(session.dispatch({ type: 'set_viewport', viewport: null })).toEqual({
    type: 'viewport_changed',
    viewport: null
  });
  expect(session.getState().viewport).toBeNull();
});
```

- [ ] **Step 2: Run the focused test red**

```bash
cd packages/game-core
bunx vitest run src/session/session.test.ts
```

Expected: compile/test failure because the action/outcomes do not exist.

- [ ] **Step 3: Implement the minimal transition**

Add the contract in `types.ts`, dispatch it in `session.ts`, and mirror the codec's numeric domain exactly:

```ts
function doSetViewport(viewport: PersistedViewport | null): PuzzleSessionOutcome {
  if (
    viewport !== null &&
    (!Number.isFinite(viewport.zoom) ||
      viewport.zoom <= 0 ||
      !Number.isFinite(viewport.panX) ||
      !Number.isFinite(viewport.panY))
  ) {
    return { type: 'viewport_noop', reason: 'invalid_viewport' };
  }

  state.viewport = viewport ? { ...viewport } : null;
  notify();
  return {
    type: 'viewport_changed',
    viewport: state.viewport ? { ...state.viewport } : null
  };
}
```

Do not call `ensureTimerStarted()`, `pushHistory()`, or set `hasUserActivity`.

- [ ] **Step 4: Pin a real engine -> V1 codec round trip**

```ts
const metadata = makeMetadata();
const session = createPuzzleSession(makeOptions({ metadata }));
session.dispatch({ type: 'start' });
session.dispatch({
  type: 'set_viewport',
  viewport: { zoom: 1.75, panX: 0.5, panY: -1 }
});

const snapshot = serializeSession(session.getState(), 1234);
expect(snapshot?.viewport).toEqual({ zoom: 1.75, panX: 0.5, panY: -1 });
expect(loadPersistedSession(JSON.stringify(snapshot), contextFromMetadata(metadata))).toMatchObject({
  status: 'loaded',
  snapshot: { viewport: { zoom: 1.75, panX: 0.5, panY: -1 } }
});
```

- [ ] **Step 5: Run the full game-core gate**

```bash
bun run --cwd packages/game-core test:unit
```

Expected: PASS with `CURRENT_SESSION_SCHEMA_VERSION === 1` unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/game-core/src/session/types.ts packages/game-core/src/session/session.ts packages/game-core/src/session/session.test.ts
git commit -m "feat(game-core): persist puzzle viewport changes"
```

---

### Task 2: Add pure Canvas surface + board viewport math

**Files:**
- Create: `apps/mobile/app/gameplay/boardViewport.ts`
- Create: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Interfaces:**

```ts
export interface CanvasSurfaceMetrics {
  layoutWidthDip: number;
  layoutHeightDip: number;
  backingWidth: number;
  backingHeight: number;
}

export interface BoardViewportInput {
  canvasWidth: number;
  canvasHeight: number;
  gridCols: number;
  gridRows: number;
  viewport: PersistedViewport | null;
}

export interface BoardTransform {
  fitCellSize: number;
  cellSize: number;
  boardX: number;
  boardY: number;
  boardWidth: number;
  boardHeight: number;
  viewport: PersistedViewport | null;
  cellAt(canvasX: number, canvasY: number): { x: number; y: number } | null;
}

export function backingSizeFromLayout(
  widthDip: number,
  heightDip: number,
  density: number
): { width: number; height: number };

export function screenPointToCanvas(
  screenX: number,
  screenY: number,
  originXDip: number,
  originYDip: number,
  metrics: CanvasSurfaceMetrics
): { x: number; y: number } | null;

export function createBoardTransform(input: BoardViewportInput): BoardTransform;
export function transformViewportForTwoPointers(...): PersistedViewport | null;
export function canFitOnDoubleTap(
  selectedPieceId: number | null,
  nowMs: number,
  suppressFitUntilMs: number
): boolean;
```

- [ ] **Step 1: Write the surface/transform tests once**

Cover all risky math here; Task 4 must not duplicate the same two-pointer cases.

```ts
it('derives backing pixels from rendered DIPs', () => {
  expect(backingSizeFromLayout(512, 384, 2)).toEqual({ width: 1024, height: 768 });
});

it('maps a screen-DIP point into the backing surface', () => {
  expect(
    screenPointToCanvas(356, 242, 100, 50, {
      layoutWidthDip: 512,
      layoutHeightDip: 384,
      backingWidth: 1024,
      backingHeight: 768
    })
  ).toEqual({ x: 512, y: 384 });
});

it('fits 4x3 into 800x600 with no internal padding', () => {
  const transform = createBoardTransform({
    canvasWidth: 800,
    canvasHeight: 600,
    gridCols: 4,
    gridRows: 3,
    viewport: null
  });

  expect(transform.fitCellSize).toBe(200);
  expect(transform.cellSize).toBe(200);
  expect(transform.boardX).toBe(0);
  expect(transform.boardY).toBe(0);
  expect(transform.cellAt(399, 199)).toEqual({ x: 1, y: 0 });
});
```

Also cover:

1. invalid/zero surface metrics -> `null`/safe size rejection;
2. transformed `cellAt()` inverse mapping;
3. `zoom < 1` -> Fit, `zoom > 4` -> 4;
4. Fit -> `viewport: null` and zero pan;
5. pure centroid translation;
6. pure pinch preserving the board point under focus before clamp;
7. combined pinch + translation from one gesture-start baseline;
8. pan clamp for fitting and oversized axes;
9. `canFitOnDoubleTap(null, now, 0) === true` and selected/suppressed cases are false.

- [ ] **Step 2: Run red**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts
```

Expected: FAIL resolving the new module.

- [ ] **Step 3: Implement surface conversion + explicit fit factor**

`backingSizeFromLayout()` uses finite positive DIP dimensions/density and `Math.round()`.

`screenPointToCanvas()` computes local DIPs first and rejects outside points before converting by the actual backing/layout ratios:

```ts
const localX = screenX - originXDip;
const localY = screenY - originYDip;
if (localX < 0 || localY < 0 || localX >= layoutWidthDip || localY >= layoutHeightDip) {
  return null;
}
return {
  x: localX * (backingWidth / layoutWidthDip),
  y: localY * (backingHeight / layoutHeightDip)
};
```

Fit must call:

```ts
const fitCellSize = calculateFitZoom(
  gridCols,
  gridRows,
  canvasWidth,
  canvasHeight,
  1
);
```

Do not use the helper's default `0.9` in the production mobile board path.

- [ ] **Step 4: Implement one two-pointer transform**

Persisted pan stays in board-cell units. Derive zoom + centroid translation from the gesture-start viewport/geometry every frame. Do not separately apply pinch and pan deltas to the already-mutated viewport.

Mobile clamp is `1..4`; normalized zoom 1 returns `null`.

- [ ] **Step 5: Run green**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts
bunx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add board viewport coordinate math"
```

---

### Task 3: Ship the real landscape surface, right tray, and visible cross-view drag

**Files:**
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Create: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Create: `apps/mobile/app/gameplay/trayPieces.ts`
- Create: `apps/mobile/app/gameplay/trayPieces.test.ts`
- Modify: `apps/mobile/app/gameplay/boardViewModel.ts`
- Modify: `apps/mobile/app/gameplay/boardViewModel.test.ts`
- Modify: `apps/mobile/app/app.css`

**Result:** Fit-only dynamic Canvas + persistent right tray + tap/cross-view drag placement. Task 4 adds viewport gestures after this foundation is proven on-device.

- [ ] **Step 1: Make BoardViewModel board-only**

Write/extend tests first:

```ts
const vm = createBoardViewModel({
  canvasWidth: 800,
  canvasHeight: 600,
  gridCols: 2,
  gridRows: 2,
  viewport: null
});

expect(vm.state(state).drawRecords.every((record) => record.placed)).toBe(true);
expect(vm.cellAt(200, 150)).toEqual({ x: 0, y: 0 });
```

Add one zoomed case. Then delete horizontal tray records and `pieceAt()` from `boardViewModel.ts`.

Placed-piece drawing still derives from `BoardTransform`:

```ts
x: transform.boardX + piece.x * transform.cellSize - transform.cellSize * 0.2,
y: transform.boardY + piece.y * transform.cellSize - transform.cellSize * 0.2,
width: transform.cellSize * 1.4,
height: transform.cellSize * 1.4
```

Run:

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
```

- [ ] **Step 2: Create the shared mobile shuffle policy before constructing sessions**

Start `trayPieces.ts` with:

```ts
export function shuffleIds(
  ids: readonly number[],
  random: () => number = Math.random
): number[] {
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}
```

Tests prove input is untouched and injected randomness is deterministic.

Use it immediately in `Gameplay.svelte`:

```ts
const pieceIds = spec.pieces.map((piece) => piece.id);

createPuzzleSession({
  ...,
  initialTrayOrder: shuffleIds(pieceIds),
  createTrayOrder: () => shuffleIds(pieceIds)
  // no createRotations override
});
```

Delete the HPA-1 all-zero `createRotations` override so the engine default owns rotation generation.

- [ ] **Step 3: Make `PuzzleCanvas.svelte` fill its layout cell**

Delete:

- `CANVAS_WIDTH` / `CANVAS_HEIGHT`;
- HPA-1 unplaced-piece drag fields;
- `pointFromPan()`;
- `onPan()`;
- `on:pan={onPan}`;
- piece selection from Canvas.

Keep Canvas board-only and stretched. On `loaded` and `layoutChanged`, synchronize backing size from actual rendered DIP size:

```ts
function syncSurface(): void {
  if (!canvas) return;
  const size = canvas.getActualSize?.();
  if (!size) return;

  const next = backingSizeFromLayout(
    Number(size.width),
    Number(size.height),
    Screen.mainScreen.scale || 1
  );

  if (Number(canvas.width) !== next.width) canvas.width = next.width;
  if (Number(canvas.height) !== next.height) canvas.height = next.height;
  rebuildViewModel(next.width, next.height);
}
```

Guard identical sizes so `layoutChanged` cannot create a loop.

The Canvas markup has no hard-coded backing constants and no pan recognizer:

```svelte
<canvas
  bind:this={canvas}
  horizontalAlignment="stretch"
  verticalAlignment="stretch"
  on:loaded={syncSurface}
  on:layoutChanged={syncSurface}
  on:tap={onTap}
/>
```

- [ ] **Step 4: Expose the single cross-view screen-to-cell method**

Delete the old letterboxing `toCanvasPoint()` formula. Use the pure helper for both cross-view conversion and Canvas event conversion.

```ts
export function cellAtScreenPoint(screenX: number, screenY: number): BoardCell | null {
  const origin = canvas?.getLocationOnScreen?.();
  const size = canvas?.getActualSize?.();
  if (!origin || !size || !viewModel) return null;

  const point = screenPointToCanvas(screenX, screenY, origin.x, origin.y, {
    layoutWidthDip: Number(size.width),
    layoutHeightDip: Number(size.height),
    backingWidth: Number(canvas.width),
    backingHeight: Number(canvas.height)
  });
  return point ? viewModel.cellAt(point.x, point.y) : null;
}
```

There is no second `(screen-origin)*scale` path.

- [ ] **Step 5: Create `PuzzleTray.svelte`**

First-slice props:

```ts
export let pieceIds: readonly number[];
export let piecePaths: Record<number, string>;
export let selectedPieceId: number | null;
export let onSelectPiece: (pieceId: number) => void;
export let onPieceDragStart: (pieceId: number, screenX: number, screenY: number) => void;
export let onPieceDragMove: (pieceId: number, screenX: number, screenY: number) => void;
export let onPieceDragEnd: (pieceId: number, screenX: number, screenY: number) => void;
```

Use NativeScript touch pointers + `getLocationOnScreen()` to emit screen DIPs. The tray stays scrollable when idle; disable scrolling only for the active piece drag and restore it on up/cancel.

- [ ] **Step 6: Compose the landscape shell and full-bleed drag overlay**

Use one flexible board + 320 DIP tray:

```svelte
<gridLayout bind:this={gameplayRoot} columns="*,320" rows="auto,*" class="gameplay-page">
  <gridLayout row="1" col="0" class="gameplay-board-column">
    <PuzzleCanvas bind:this={puzzleCanvas} ... />
  </gridLayout>
  <gridLayout row="1" col="1" class="gameplay-tray-column">
    <PuzzleTray ... />
  </gridLayout>

  {#if activeDrag}
    <gridLayout
      row="1"
      col="0"
      colSpan="2"
      isUserInteractionEnabled={false}
      class="gameplay-drag-layer"
    >
      <image
        src={piecePaths[activeDrag.pieceId]}
        width={activeDrag.sizeDip}
        height={activeDrag.sizeDip}
        translateX={activeDrag.localX}
        translateY={activeDrag.localY}
      />
    </gridLayout>
  {/if}
</gridLayout>
```

`Gameplay.svelte` converts the drag's screen DIP point relative to `gameplayRoot.getLocationOnScreen()` for overlay presentation only. Placement still goes through `PuzzleCanvas.cellAtScreenPoint()`.

On drag end:

1. remove/schedule removal of the overlay;
2. ask Canvas for the canonical cell;
3. no cell -> no dispatch/no incorrect attempt;
4. cell -> call the same `attemptPlacement(pieceId, cell)` used by tap placement.

The Canvas never learns about in-flight tray-drag drawing.

- [ ] **Step 7: Lock iPad to landscape**

Change only `UISupportedInterfaceOrientations~ipad` to LandscapeLeft + LandscapeRight. Keep phone orientations unchanged.

```bash
plutil -lint apps/mobile/App_Resources/iOS/Info.plist
```

- [ ] **Step 8: Run automated gates**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
plutil -lint apps/mobile/App_Resources/iOS/Info.plist
```

- [ ] **Step 9: Run the Task 3 iPad stop gate**

Launch the established iPad simulator and verify before starting Task 4:

- Canvas DIP size fills the board column;
- backing width/height track rendered size and are no longer 700×800;
- board uses the available limiting axis with the explicit `paddingFactor=1` fit;
- tap piece -> tap cell works;
- cross-view drag overlay remains visible across the tray/board boundary;
- drag release maps to the correct cell at device density;
- outside release does not increment incorrect attempts.

If Canvas backing assignment changes the view's layout size instead of only its backing resolution on the installed plugin version, stop here and use the plugin-supported backing-size path; do not restore fixed dimensions or letterboxing.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/App_Resources/iOS/Info.plist apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape board and puzzle tray"
```

---

### Task 4: Add two-pointer viewport navigation and conflict-free Fit

**Files:**
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/boardViewport.ts`
- Modify: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Consumes:** Task 2's already-tested transform/surface/two-pointer math and Task 3's dynamic board-only Canvas.

- [ ] **Step 1: Add only the missing double-tap precedence tests**

Do **not** repeat Task 2's pinch/centroid/clamp cases.

```ts
expect(canFitOnDoubleTap(null, 1000, 0)).toBe(true);
expect(canFitOnDoubleTap(4, 1000, 0)).toBe(false);
expect(canFitOnDoubleTap(null, 1000, 1200)).toBe(false);
```

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts
```

- [ ] **Step 2: Make `touch` the only viewport-navigation owner**

On first touch state with exactly two active pointers, capture:

- session viewport at gesture start;
- centroid in Canvas backing coordinates;
- pointer distance.

On two-pointer move, compute current centroid/distance, derive a transient viewport from the saved baseline, and redraw without persisting every frame.

When the gesture ends/cancels below two pointers:

```ts
export let onViewportCommit: (viewport: PersistedViewport | null) => void;
```

One-finger move remains a no-op. The old `pan` recognizer must already be absent from Task 3.

- [ ] **Step 3: Give placement precedence over Fit when selection existed**

Keep tap placement immediate. When a tap begins while a piece is selected, suppress Fit for the following iPad double-tap recognition window:

```ts
const FIT_SUPPRESSION_MS = 350;
let suppressFitUntil = 0;

function onTap(event: TapGestureEventData): void {
  const selected = sessionState.selectedPieceId;
  if (selected === null) return;
  suppressFitUntil = Date.now() + FIT_SUPPRESSION_MS;
  const cell = cellFromCanvasTap(event);
  if (cell) onAttemptPlacement(selected, cell);
}

function onDoubleTap(): void {
  if (!canFitOnDoubleTap(sessionState.selectedPieceId, Date.now(), suppressFitUntil)) return;
  onViewportCommit(null);
}
```

This keeps no-selection double-tap as Fit while preventing `place -> Fit` when a platform emits tap before doubleTap. Do not delay every placement tap and do not add a generic recognizer arbiter.

- [ ] **Step 4: Dispatch viewport only at the persistence boundary**

```ts
function commitViewport(viewport: PersistedViewport | null): void {
  if (!session) return;
  const outcome = session.dispatch({ type: 'set_viewport', viewport });
  if (outcome.type === 'viewport_changed') persist();
}
```

Pass `sessionState.viewport` back to Canvas so restore paints the saved transform immediately.

- [ ] **Step 5: Run automated + native interaction gates**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

On iPad verify:

- pinch zoom and centroid pan combine correctly;
- tap placement still maps correctly after zoom/pan;
- tray drag release still maps correctly after zoom/pan;
- no one-finger board pan occurs;
- double-tap with no selection Fits and saves `viewport === null`;
- a selected-piece double-tap sequence never both places and Fits.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/gameplay/PuzzleCanvas.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add puzzle zoom pan and fit"
```

---

### Task 5: Replace HPA-1 auto-start with real setup/pause/restart/discard lifecycle

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/MissionSetupSheet.svelte`
- Create: `apps/mobile/app/gameplay/PauseSheet.svelte`
- Create: `apps/mobile/app/gameplay/DiscardSheet.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Delete the current automatic `start`/`resume` dispatch**

Current HPA-1 code dispatches `resume` for paused restore and `start` otherwise. Replace it with presentation-only entry state:

```ts
let sheet: 'setup' | 'pause' | 'discard' | null = null;

if (session) {
  if (!restored) {
    sheet = 'setup';
  } else if (restored.lifecycle === 'paused') {
    sheet = 'pause';
  }
  // active restored sessions need no dispatch here.
}
```

Do **not** call `start`, `resume`, or initial `setDocumentHidden(false)` for an active restored session. `createPuzzleSession()` already starts its clock during construction when restored state is active + timed + `timerStarted`.

- [ ] **Step 2: Add `MissionSetupSheet.svelte`**

Expose Timed/Relaxed, Rotation On/Off, Start, Library.

Start:

```ts
session.dispatch({
  type: 'configure_setup',
  mode: setupDraft.mode,
  rotationEnabled: setupDraft.rotationEnabled
});
session.dispatch({ type: 'start' });
persist();
sheet = null;
```

No mobile preference store. Rotation generation already uses the engine default after Task 3 removed the override.

- [ ] **Step 3: Add explicit Pause/Resume**

```ts
function pauseSession(): void {
  const outcome = session?.dispatch({ type: 'pause' });
  if (outcome?.type !== 'lifecycle_transitioned') return;
  persist();
  sheet = 'pause';
}

function resumeSession(): void {
  const outcome = session?.dispatch({ type: 'resume' });
  if (outcome?.type === 'lifecycle_transitioned') {
    persist();
    sheet = null;
  }
}
```

Pause sheet also exposes Restart, Library, Discard.

- [ ] **Step 4: Add Restart without a rules copy**

Seed setup draft from current `mode`/`rotationEnabled`. Confirm when `hasUserActivity` is true.

```ts
session.dispatch({ type: 'restart' });
persist();
sheet = 'setup';
```

The next Start does `configure_setup + start`. `createTrayOrder()` from Task 3 reshuffles the fresh run. Engine restart resets viewport to Fit and filter to All.

- [ ] **Step 5: Add concrete Discard**

```ts
function confirmDiscard(): void {
  if (!storage.clearSession(spec.puzzleId)) {
    discardError = 'Unable to discard saved progress.';
    return;
  }
  onExit();
}
```

Stay on the sheet if removal fails. No generic dialog/error layer.

- [ ] **Step 6: Fix suspend ordering**

Split checkpoint-and-save from save-only so suspend does not serialize stale elapsed time or checkpoint twice:

```ts
function saveCurrentSnapshot(): void {
  if (!session) return;
  const snapshot = serializeSession(session.getState());
  if (snapshot) storage.saveSession(spec.puzzleId, snapshot);
}

function persist(): void {
  session?.checkpointTime();
  saveCurrentSnapshot();
}

function onSuspend(): void {
  if (!session) return;
  session.setDocumentHidden(true); // stopClock() checkpoints first
  saveCurrentSnapshot();
}

function onResume(): void {
  session?.setDocumentHidden(false);
}
```

Backgrounding never changes `sheet`.

- [ ] **Step 7: Verify lifecycle behavior**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

On iPad check:

- Start opens Setup;
- active timed restore continues ticking without an entry dispatch;
- active timed snapshot with `timerStarted=false` stays untimed until a timer-starting action;
- paused restore stays paused;
- explicit Pause persists;
- hidden time is excluded;
- foreground creates no Pause sheet;
- Restart reopens Setup and gets a fresh shuffled tray;
- Discard clears the real variant save.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/MissionSetupSheet.svelte apps/mobile/app/gameplay/PauseSheet.svelte apps/mobile/app/gameplay/DiscardSheet.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add mission session controls"
```

---

### Task 6: Add toolbar parity, filters/shuffle, rotation, hints, reference, and feedback

**Files:**
- Create: `apps/mobile/app/gameplay/GameplayToolbar.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/trayPieces.ts`
- Modify: `apps/mobile/app/gameplay/trayPieces.test.ts`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Extend `trayPieces.ts` with filtered unplaced projection**

```ts
export function visibleUnplacedPieceIds(
  state: Readonly<PuzzleSessionState>,
  pieces: SessionPuzzleSpec['pieces']
): number[] {
  const placed = new Set(state.placedPieces.map((piece) => piece.pieceId));
  const filter = state.organization?.filter ?? 'all';
  const byId = new Map(pieces.map((piece) => [piece.id, piece]));

  return state.trayOrder.filter((id) => {
    if (placed.has(id)) return false;
    const piece = byId.get(id);
    return piece ? matchesInventoryFilter(piece, state, filter) : false;
  });
}
```

Tests pin All/Corners/Edges/Center and placed-piece removal. Existing Task 3 shuffle tests remain.

```bash
cd apps/mobile
bunx vitest run app/gameplay/trayPieces.test.ts
```

- [ ] **Step 2: Add `GameplayToolbar.svelte`**

Visible: Library, puzzle name+difficulty, timer, Undo, Redo, Hint, Reference, More.

More expands exactly: Fit Board, Rotation On/Off, Pause, Restart, Discard.

Component receives props/callbacks only; it does not own or dispatch gameplay state. Disable Undo/Redo from engine flags; lock rotation mode after placements; gate Pause by active lifecycle.

- [ ] **Step 3: Wire engine-owned controls**

Use existing actions and persist state-changing outcomes:

```ts
session.dispatch({ type: 'undo' });
session.dispatch({ type: 'redo' });
session.dispatch({ type: 'rotate_piece', pieceId: selectedPieceId });
session.dispatch({
  type: 'update_tray_organization',
  update: { type: 'set_filter', filter }
});
session.dispatch({
  type: 'update_tray_organization',
  update: { type: 'reorder', trayId: 'main', pieceIds: shuffleIds(unplacedIds) }
});
```

PuzzleTray shows remaining count, four filters, Shuffle, selection, hint highlight, and one selected-piece Rotate action.

- [ ] **Step 4: Wire hints from existing engine events**

Construct the session with `onEvent`. On `hint_target`, keep only ephemeral `hintPieceId` + `hintTarget`. Engine already resets filter to All. Clear the presentation when the hinted piece receives `placement_accepted` or a later hint replaces it.

- [ ] **Step 5: Add the three reference modes**

Reference row: Hold to Peek, Toggle, Ghost.

All dispatch existing `set_reference_mode`; active mode is runtime-only while counters/facts stay engine-owned. Load only `launch.install.referencePath`; no file means no Reference affordance/network fallback.

Canvas layering:

- Ghost behind pieces at low opacity;
- Hold/Toggle as stronger board-aligned reference while pieces remain visible.

- [ ] **Step 6: Add short placement feedback**

Keep one ephemeral `{ cell, kind: 'accepted' | 'rejected' }` plus timeout. Canvas draws green/red target feedback; hint target remains distinct until consumed/replaced.

- [ ] **Step 7: Run gates + native spot-check**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
```

On iPad verify Undo/Redo, Hint, all filters, user Shuffle, selected Rotate, Hold/Toggle/Ghost, Fit, Pause, Restart, Discard.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape gameplay controls"
```

---

### Task 7: Add local completion and execute the final offline iPad gate

**Files:**
- Create: `apps/mobile/app/gameplay/CompletionSheet.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/library/Downloaded.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Present the immutable local completion seal**

On completion, persist immediately and show a concrete sheet from `SealedCompletion` + downloaded metadata:

```ts
interface CompletionSheetProps {
  puzzleName: string;
  difficulty: PuzzleDifficulty;
  seal: SealedCompletion;
  onBackToLibrary: () => void;
}
```

Display puzzle/difficulty, Timed/Relaxed, elapsed time when non-null, hints, incorrect attempts, rotation enabled/used, Back to Library.

Do not call completion APIs, add auth/outbox, or build another local stats database.

- [ ] **Step 2: Reuse the existing difficulty label in Downloaded**

Import `getDifficultyLabel()` from `familyGallery.ts` and change row copy to e.g. `EASY · 16 PIECES`. Keep the existing `none | resumable | protected | invalid` action matrix unchanged.

- [ ] **Step 3: Run automated gates**

```bash
bun run --cwd packages/game-core test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bun run check
bun run lint
```

All must pass before native acceptance is claimed.

- [ ] **Step 4: Download one real Easy variant, then remove network/API dependency**

Run the normal local API, download one ready Easy family variant through Gallery, verify the package finalized, then stop the API/disable networking for the gameplay journey. Do not add an HPA-3 backend route or permanent special fixture.

- [ ] **Step 5: Execute the landscape iPad offline smoke**

Record NativeScript/Xcode/iPad simulator versions and verify:

1. Downloaded row shows difficulty and START.
2. START opens Setup; choose mode/rotation.
3. Canvas fills the board column and backing size matches layout density.
4. Fresh tray order is shuffled rather than canonical sorted IDs.
5. Tap-place one piece.
6. Cross-view drag overlay stays visible and drag-place succeeds.
7. Outside release does not change incorrect-attempt count.
8. Pinch zoom + two-finger pan persist finite positive viewport data.
9. After zoom/pan, both tap and tray-drag still map to correct canonical cells.
10. No-selection double-tap Fits; selected-piece tap sequence never also Fits.
11. Exit/relaunch Resume restores placements + viewport; active timed restore continues without an entry dispatch.
12. Fit causes the next snapshot to omit viewport.
13. Exercise Rotate, all filters, Shuffle, Hint, Hold/Toggle/Ghost, Undo, Redo.
14. Explicit Pause/Resume.
15. Background active timed play for at least five seconds; hidden time is excluded and no unwanted Pause sheet appears.
16. Finish offline and see the completion sheet.
17. Return to Downloaded; row is `COMPLETED PROGRESS` and has no Start/Resume until explicit Discard Progress.

If multi-touch injection is unreliable, record pinch/two-finger pan as explicit manual PASS/PENDING evidence instead of adding a native E2E framework. `boardViewport.test.ts` remains the automated math gate.

- [ ] **Step 6: Perform the final scope sweep**

```bash
git diff --name-only main...HEAD
rg "activeTray|membership|rename_tray|remove_tray|move_piece" apps/mobile/app/gameplay
rg "fetch\(|/api/|CompletionOutbox|AuthService" apps/mobile/app/gameplay
rg "CANVAS_WIDTH|CANVAS_HEIGHT|on:pan|pointFromPan|pieceAt\(" apps/mobile/app/gameplay
```

Expected:

- no manual-tray feature;
- no gameplay network/auth/outbox path;
- no fixed HPA-1 Canvas backing constants;
- no legacy Canvas pan/unplaced-piece drag path.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/gameplay/CompletionSheet.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/library/Downloaded.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add offline completion summary"
```

- [ ] **Step 8: Update this same draft PR**

Record Task 1–7 completion state, automated gate output, native device/runtime details, Task 3 surface/drag stop-gate evidence, final offline smoke evidence, and any explicitly manual multi-touch evidence. Do not open another PR. Mark this PR ready only after implementation and the acceptance ledger are complete.