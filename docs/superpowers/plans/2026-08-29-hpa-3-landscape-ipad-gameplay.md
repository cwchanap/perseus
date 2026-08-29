# HPA-3 Landscape iPad Gameplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship production landscape iPad gameplay on the existing NativeScript offline library with one shared `PuzzleSession`, one board-geometry module, tested lifecycle/persistence policy, and small native stop gates before risky gesture work.

**Architecture:** `PuzzleSession` remains the only gameplay controller. `Gameplay.svelte` stays the composition root, while `boardViewport.ts` is the only board geometry/coordinate source and a tiny `gameplaySessionPolicy.ts` makes entry/suspend/viewport/discard orchestration unit-testable without adding a Svelte test framework. The Canvas, tray, toolbar and sheets remain concrete NativeScript components; no backend, new schema, global store, or generic UI/gesture framework is added.

**Tech Stack:** TypeScript 5.9, NativeScript 9, Svelte Native 1.0, `@nativescript/canvas` 2.1, Vitest 4, `@perseus/game-core`.

**Spec:** `docs/superpowers/specs/2026-08-29-hpa-3-landscape-ipad-gameplay-design.md`

## Global Constraints

- One HPA-3 PR only. Continue on `docs/hpa-3-landscape-ipad-gameplay-plan`; do not create another implementation PR.
- Review each task/stop gate as a separate commit inside this PR; do not squash the whole implementation into one checkpoint.
- Concrete downloaded variant `manifest.puzzle.id` remains gameplay/session/download identity. `familyId` and `difficulty` are presentation metadata only.
- Do not change API routes, D1, Workflows, infrastructure, auth, download-manifest schema, or `CURRENT_SESSION_SCHEMA_VERSION`.
- `PuzzleSession` remains the sole owner of placement validity, lifecycle/mode/time, rotation, history, hints, reference mode, filter/order, and completion sealing.
- Mobile must not expose named/staging tray membership, active tray selection, tray names, rename/remove, multi-select, or clustering.
- HPA-3 is iPad landscape only. HPA-46 owns portrait/live orientation changes. HPA-4 owns auth/account-bound completion submission.
- No mobile controller/global store, generic toolbar/dialog/gesture framework, or broad native E2E framework.
- Package-local mobile TypeScript is authoritative: `cd apps/mobile && bunx tsc --noEmit`.

## Final file ownership

### Shared game core

- Modify `packages/game-core/src/session/types.ts` — persisted viewport unit documentation + narrow action/outcomes.
- Modify `packages/game-core/src/session/session.ts` — validate/clone/apply viewport action.
- Modify `packages/game-core/src/session/session.test.ts` — action semantics + V1 codec round trip.

The codec already serializes/validates `PersistedViewport`; keep it unchanged.

### Mobile pure modules

- Create `apps/mobile/app/gameplay/boardViewport.ts` + `.test.ts` — Canvas surface conversion, fit/zoom/pan transform, screen→Canvas conversion, `cellAt`, two-pointer math, double-tap suppression.
- Modify `apps/mobile/app/gameplay/boardViewModel.ts` + `.test.ts` — draw-record projection over a supplied `BoardTransform`; no fit formula or final `cellAt` ownership.
- Create `apps/mobile/app/gameplay/trayPieces.ts` + `.test.ts` — all-unplaced/visible-unplaced projection and Fisher-Yates policy.
- Create `apps/mobile/app/gameplay/gameplaySessionPolicy.ts` + `.test.ts` — fresh/resume sheet policy, suspend ordering, viewport commit/save gating, discard result.

### Mobile product components

- Modify `Gameplay.svelte` — composition, session wiring, full-bleed drag overlay, ephemeral hint/feedback/sheet state.
- Modify `PuzzleCanvas.svelte` — dynamic backing surface, board/reference drawing, two-pointer touch + tap + doubleTap.
- Create `PuzzleTray.svelte` — persistent scrollable tray, selection, long-press drag arm.
- Create `GameplayToolbar.svelte` — visible controls + concrete More/Reference rows.
- Create `MissionSetupSheet.svelte`, `PauseSheet.svelte`, `DiscardSheet.svelte`, `CompletionSheet.svelte`.
- Modify `apps/mobile/app/app.css`.
- Modify `apps/mobile/App_Resources/iOS/Info.plist` — iPad landscape only.
- Modify `apps/mobile/app/library/Downloaded.svelte` — difficulty-aware copy only.

---

## Task 1: Add one safe persisted viewport action and document its units

**Files:**
- Modify: `packages/game-core/src/session/types.ts`
- Modify: `packages/game-core/src/session/session.ts`
- Modify: `packages/game-core/src/session/session.test.ts`

**Produces:**

```ts
// PuzzleSessionAction
| { type: 'set_viewport'; viewport: PersistedViewport | null }

// PuzzleSessionOutcome
| { type: 'viewport_changed'; viewport: PersistedViewport | null }
| { type: 'viewport_noop'; reason: 'invalid_viewport' }
```

- [ ] **Step 1: Pin portable persisted units on the shared type**

Replace the reserved-field comment with:

```ts
/**
 * Portable persisted viewport units.
 * `zoom` is a multiplier over fit-to-viewport cell scale (`1` = Fit).
 * `panX`/`panY` are offsets in fit-cell units, positive right/down.
 * App UIs may clamp their usable range but must preserve these units.
 */
export interface PersistedViewport {
  zoom: number;
  panX: number;
  panY: number;
}
```

Do not change the shape or schema version.

- [ ] **Step 2: Add failing transition tests**

```ts
it('stores viewport without changing gameplay activity, history, or result class', () => {
  const session = createPuzzleSession(makeOptions());
  session.dispatch({ type: 'start' });
  const before = session.getState();

  expect(session.dispatch({
    type: 'set_viewport',
    viewport: { zoom: 2, panX: 1.25, panY: -0.5 }
  })).toEqual({
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
  { zoom: 1, panX: Number.POSITIVE_INFINITY, panY: 0 },
  { zoom: 1, panX: 0, panY: Number.NEGATIVE_INFINITY }
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

- [ ] **Step 3: Run red**

```bash
cd packages/game-core
bunx vitest run src/session/session.test.ts
```

Expected: compile/test failure because the action/outcomes do not exist.

- [ ] **Step 4: Implement the minimal transition**

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

Wire `case 'set_viewport'` in `dispatch`. Do not call `ensureTimerStarted()`, `pushHistory()`, or mutate `hasUserActivity`.

- [ ] **Step 5: Pin a real engine -> V1 codec round trip**

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

- [ ] **Step 6: Run game-core gate and commit**

```bash
bun run --cwd packages/game-core test:unit
git add packages/game-core/src/session/types.ts packages/game-core/src/session/session.ts packages/game-core/src/session/session.test.ts
git commit -m "feat(game-core): persist puzzle viewport changes"
```

---

## Task 2: Create the single board geometry module and reuse it from BoardViewModel

**Files:**
- Create: `apps/mobile/app/gameplay/boardViewport.ts`
- Create: `apps/mobile/app/gameplay/boardViewport.test.ts`
- Modify: `apps/mobile/app/gameplay/boardViewModel.ts`
- Modify: `apps/mobile/app/gameplay/boardViewModel.test.ts`

**Produces:**

```ts
export interface CanvasSurfaceMetrics {
  layoutWidthDip: number;
  layoutHeightDip: number;
  backingWidth: number;
  backingHeight: number;
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
): { width: number; height: number } | null;

export function screenPointToCanvas(
  screenX: number,
  screenY: number,
  originXDip: number,
  originYDip: number,
  metrics: CanvasSurfaceMetrics
): { x: number; y: number } | null;

export function createBoardTransform(input: {
  canvasWidth: number;
  canvasHeight: number;
  gridCols: number;
  gridRows: number;
  viewport: PersistedViewport | null;
}): BoardTransform;

export function transformViewportForTwoPointers(...): PersistedViewport | null;
```

- [ ] **Step 1: Write discriminating geometry tests**

```ts
it('fits a 2x2 board into 800x600 with paddingFactor 1', () => {
  const transform = createBoardTransform({
    canvasWidth: 800,
    canvasHeight: 600,
    gridCols: 2,
    gridRows: 2,
    viewport: null
  });

  expect(transform.fitCellSize).toBe(300);
  expect(transform.cellSize).toBe(300);
  expect(transform.boardX).toBe(100);
  expect(transform.boardY).toBe(0);
  expect(transform.cellAt(100, 0)).toEqual({ x: 0, y: 0 });
  expect(transform.cellAt(699, 599)).toEqual({ x: 1, y: 1 });
});

it('maps screen DIPs into the Canvas backing surface', () => {
  expect(screenPointToCanvas(356, 242, 100, 50, {
    layoutWidthDip: 512,
    layoutHeightDip: 384,
    backingWidth: 1024,
    backingHeight: 768
  })).toEqual({ x: 512, y: 384 });
});
```

Also cover zero/invalid dimensions, transformed inverse `cellAt`, zoom clamp `1..4`, Fit -> `null`, pan clamp, pure two-pointer translation, focal pinch, and combined pinch+translation from one baseline.

- [ ] **Step 2: Run red**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts app/gameplay/boardViewModel.test.ts
```

Expected: new module missing and current BoardViewModel still owns a second fit formula.

- [ ] **Step 3: Implement `boardViewport.ts` with explicit no-padding Fit**

Use:

```ts
const fitCellSize = calculateFitZoom(
  gridCols,
  gridRows,
  canvasWidth,
  canvasHeight,
  1
);
```

Persisted pan remains in fit-cell units. `zoom === 1` normalizes to Fit/`null`; UI clamp is `1..4`.

`screenPointToCanvas()` converts through actual backing/layout ratios, not a second letterboxing formula.

- [ ] **Step 4: Make BoardViewModel consume the transform**

Change the factory to:

```ts
export function createBoardViewModel(transform: BoardTransform): BoardViewModel;
```

Remove its `calculateFitZoom()` call and remove `cellAt()` from the view-model interface. Canvas callers use `transform.cellAt()`.

For this task only, keep the current temporary unplaced-piece draw records and `pieceAt()` so Task 3A can use the already-working HPA-1 drag path as the native surface oracle. Task 3B deletes both.

Placed records use the supplied transform:

```ts
x: transform.boardX + piece.x * transform.cellSize - transform.cellSize * 0.2,
y: transform.boardY + piece.y * transform.cellSize - transform.cellSize * 0.2,
width: transform.cellSize * 1.4,
height: transform.cellSize * 1.4
```

- [ ] **Step 5: Run green and commit**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts app/gameplay/boardViewModel.test.ts
bunx tsc --noEmit
cd ../..
git add apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts apps/mobile/app/gameplay/boardViewModel.ts apps/mobile/app/gameplay/boardViewModel.test.ts
git commit -m "refactor(mobile): centralize board viewport geometry"
```

---

## Task 3A: Prove the dynamic Canvas surface before changing interaction ownership

**Files:**
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`

**Consumes:** `backingSizeFromLayout`, `screenPointToCanvas`, `createBoardTransform`, `createBoardViewModel(transform)`.

**Stop condition:** Do not start Task 3B if the installed Canvas cannot keep layout size stable while its backing `width/height` follow layout DIPs × density, or if first post-layout paint/hit-testing is unreliable.

- [ ] **Step 1: Replace fixed surface sizing but keep the existing HPA-1 interaction path**

Delete `CANVAS_WIDTH = 700` / `CANVAS_HEIGHT = 800` and the old letterboxing `toCanvasPoint()` helper.

Keep `on:pan`, `pointFromPan`, temporary in-Canvas unplaced records, and `pieceAt()` for this checkpoint only.

Add layout-driven surface state:

```ts
let surfaceMetrics: CanvasSurfaceMetrics | null = null;
let transform: BoardTransform | null = null;
let firstPaintScheduled = false;

function syncSurface(args: any): void {
  const view = args.object ?? canvas;
  const size = view?.getActualSize?.();
  const density = Screen.mainScreen.scale || 1;
  if (!size) return;

  const backing = backingSizeFromLayout(size.width, size.height, density);
  if (!backing) return;

  canvas.width = backing.width;
  canvas.height = backing.height;
  surfaceMetrics = {
    layoutWidthDip: size.width,
    layoutHeightDip: size.height,
    backingWidth: backing.width,
    backingHeight: backing.height
  };
  transform = createBoardTransform({
    canvasWidth: backing.width,
    canvasHeight: backing.height,
    gridCols: sessionState.gridCols,
    gridRows: sessionState.gridRows,
    viewport: sessionState.viewport
  });
  viewModel = createBoardViewModel(transform);

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

Use `<canvas on:loaded={syncSurface} on:layoutChanged={syncSurface} ...>` and stretch it to the board cell. The first non-zero layout + next JS turn replaces the old fixed 100 ms delay.

- [ ] **Step 2: Route all local gesture points through one conversion**

Where the existing pan/tap path gets a screen/local point, convert using `screenPointToCanvas()` and the current `surfaceMetrics`. Do not retain the old `(viewSize - displayWidth) / 2` compensation.

- [ ] **Step 3: Run package checks**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

- [ ] **Step 4: Run the iPad surface gate**

Launch the established simulator:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Record:

1. board Canvas visually fills its current container;
2. actual layout DIPs and backing pixel dimensions;
3. first paint succeeds after first non-zero layout without the old 100 ms delay;
4. existing tap placement works at device density;
5. existing in-Canvas drag works at device density;
6. a relayout/relaunch recreates the same correct hit geometry.

If backing width/height feed back into layout size or first paint still fails, stop and revise this task only. Do not build the external tray on an unproven surface.

- [ ] **Step 5: Commit the proven surface checkpoint**

```bash
git add apps/mobile/app/gameplay/PuzzleCanvas.svelte
git commit -m "feat(mobile): make puzzle canvas layout driven"
```

---

## Task 3B: Add the persistent tray and visible cross-view drag, then delete legacy Canvas drag

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

**Result:** dynamic Fit-only Canvas + scrollable right tray + tap placement + long-press cross-view drag overlay. No Canvas `on:pan` remains.

- [ ] **Step 1: Add one tray-order/projection helper**

```ts
export function unplacedPieceIds(state: Readonly<PuzzleSessionState>): number[];

export function visibleUnplacedPieceIds(
  state: Readonly<PuzzleSessionState>,
  pieces: SessionPuzzleSpec['pieces']
): number[];

export function shuffleIds(
  ids: readonly number[],
  random: () => number = Math.random
): number[];

export function shuffledUnplacedPieceIds(
  state: Readonly<PuzzleSessionState>,
  random: () => number = Math.random
): number[];
```

The Fisher-Yates implementation intentionally duplicates the tiny web helper because mobile depends only on game-core/types and tray-order creation is an app/runtime seam.

Tests prove:

- inputs are not mutated;
- injected RNG is deterministic;
- placed pieces are excluded;
- visible projection honors All/Corners/Edges/Center through `matchesInventoryFilter`;
- `shuffledUnplacedPieceIds()` always contains **all** unplaced IDs even when the active filter is Corners/Edges/Center.

```bash
cd apps/mobile
bunx vitest run app/gameplay/trayPieces.test.ts
```

- [ ] **Step 2: Use one shuffle policy for fresh and restarted runs**

In `Gameplay.svelte` session construction:

```ts
const freshOrder = shuffleIds(spec.pieces.map((piece) => piece.id));

createPuzzleSession({
  ...,
  initialTrayOrder: freshOrder,
  createTrayOrder: () => shuffleIds(spec.pieces.map((piece) => piece.id))
});
```

Do not remove the all-zero `createRotations` override yet; Task 5 removes it together with setup behavior.

- [ ] **Step 3: Create a scrollable `PuzzleTray.svelte` with an explicit drag-arm rule**

Use the high-level NativeScript `longPress` gesture to arm drag; ordinary movement before recognition remains tray scrolling.

```svelte
<scrollView bind:this={trayScroll} isScrollEnabled={!dragArmed}>
  <!-- piece views -->
</scrollView>
```

For a piece:

- tap -> `onSelectPiece(pieceId)`;
- `longPress` state `began` -> set `dragArmed=true`, disable ScrollView, call `onPieceDragStart`;
- while armed, `touch move` -> `onPieceDragMove`;
- `touch up/cancel` -> `onPieceDragEnd`, clear arm, restore scrolling.

Do not invent a custom long-press duration. If the installed recognizer cannot coexist with ScrollView, the native gate below stops the task before further gesture work.

- [ ] **Step 4: Make Gameplay own a full-bleed drag overlay**

Keep one ephemeral drag record:

```ts
interface ActivePieceDrag {
  pieceId: number;
  screenX: number;
  screenY: number;
}
let activePieceDrag: ActivePieceDrag | null = null;
```

Render one overlay image in a top full-page GridLayout layer spanning board + tray. Position it in screen DIPs. The tray does not draw outside its column; Canvas does not draw the in-flight tray piece.

On drag end:

1. call `puzzleCanvas.cellAtScreenPoint(screenX, screenY)`;
2. null -> clear overlay, no dispatch;
3. cell -> call the same `attemptPlacement(pieceId, cell)` as tap placement;
4. clear overlay.

- [ ] **Step 5: Make Canvas board-only and delete the legacy drag path**

Delete together:

- `<canvas on:pan={onPan}>`;
- `onPan`;
- `pointFromPan`;
- `draggingPieceId`/drag offsets/drag coordinates;
- `BoardViewModel.pieceAt()`;
- temporary unplaced Canvas records.

Expose:

```ts
export function cellAtScreenPoint(screenX: number, screenY: number): BoardCell | null {
  const origin = canvas?.getLocationOnScreen?.();
  if (!origin || !surfaceMetrics || !transform) return null;
  const point = screenPointToCanvas(
    screenX,
    screenY,
    origin.x,
    origin.y,
    surfaceMetrics
  );
  return point ? transform.cellAt(point.x, point.y) : null;
}
```

BoardViewModel final interface now only projects draw records from the supplied transform.

- [ ] **Step 6: Compose the landscape layout and lock iPad orientation**

Use a full-page layered GridLayout with `columns="*,320"`; board left, tray right, drag overlay above both. Do not add a resizable divider.

Change only `UISupportedInterfaceOrientations~ipad` to landscape left/right and validate:

```bash
plutil -lint apps/mobile/App_Resources/iOS/Info.plist
```

- [ ] **Step 7: Run automated gates**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
plutil -lint apps/mobile/App_Resources/iOS/Info.plist
```

- [ ] **Step 8: Run a Hard-variant tray/drag stop gate**

Download a Hard variant (100–108 pieces) while the API is available. On iPad verify:

1. the 320 DIP tray genuinely scrolls through many pieces;
2. ordinary vertical scrolling does not start a piece drag;
3. long-press arms a drag without scrolling;
4. the overlay remains visible after crossing out of the tray column;
5. release outside the board is a no-op;
6. release on the correct board cell reaches `attempt_placement` and places the piece.

If long-press + ScrollView cannot coexist reliably with the high-level NativeScript recognizers, stop and choose the smallest local alternative. Do not create a generic gesture subsystem.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/App_Resources/iOS/Info.plist apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape puzzle tray and drag overlay"
```

---

## Task 4: Add two-pointer viewport navigation, transient redraw, and conflict-free Fit

**Files:**
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/boardViewport.ts`
- Modify: `apps/mobile/app/gameplay/boardViewport.test.ts`

- [ ] **Step 1: Finish the pure gesture contract**

Keep all two-pointer numeric cases in `boardViewport.test.ts`; do not repeat them in another task.

Add one pure Fit guard:

```ts
export function canFitOnDoubleTap(
  selectedPieceId: number | null,
  nowMs: number,
  suppressFitUntilMs: number
): boolean {
  return selectedPieceId === null && nowMs >= suppressFitUntilMs;
}
```

A placement tap sets `suppressFitUntilMs` far enough past the platform double-tap callback to prevent `place -> Fit`. More -> Fit Board remains available while a piece stays selected; do not delay every placement tap.

- [ ] **Step 2: Add transient viewport redraw wiring**

In `PuzzleCanvas.svelte`:

```ts
let transientViewport: PersistedViewport | null | undefined = undefined;

$: effectiveViewport =
  transientViewport !== undefined ? transientViewport : sessionState.viewport;

$: if (surfaceReady && transform && sessionState) {
  rebuildTransform(effectiveViewport);
  draw();
}
```

`undefined` means no active gesture; `null` remains a valid transient Fit state.

- [ ] **Step 3: Add the final Canvas gesture markup and handlers**

Final Canvas includes:

```svelte
<canvas
  bind:this={canvas}
  on:loaded={syncSurface}
  on:layoutChanged={syncSurface}
  on:touch={onTouch}
  on:tap={onTap}
  on:doubleTap={onDoubleTap}
/>
```

No `on:pan` remains.

On exactly two active pointers:

- first frame -> capture start viewport, start centroid and distance;
- move -> derive `transientViewport` from the start baseline through `transformViewportForTwoPointers()`;
- pointer count drops below two/up/cancel -> emit one viewport commit and clear transient state.

One-finger Canvas movement is a no-op.

- [ ] **Step 4: Emit one commit boundary**

For now expose:

```ts
export let onViewportCommit: (viewport: PersistedViewport | null) => void;
```

`Gameplay.svelte` dispatches `set_viewport` and persists only on `viewport_changed`. Task 5 moves that small policy into the tested helper without changing behavior.

`doubleTap` commits `null` only when `canFitOnDoubleTap(...)` returns true.

- [ ] **Step 5: Run tests and Hard gesture spot-check**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

On the already-downloaded Hard variant verify:

- pinch zoom;
- two-finger centroid pan;
- Fit;
- a zoomed/panned tap resolves the correct canonical cell;
- a zoomed/panned tray drag drop resolves the correct canonical cell;
- placement followed by native double-tap callback does not cause Fit.

If multi-touch injection is unreliable, record manual evidence rather than adding E2E infrastructure.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/gameplay/PuzzleCanvas.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add puzzle zoom pan and fit"
```

---

## Task 5: Extract the tiny session policy and add setup/pause/restart/discard

**Files:**
- Create: `apps/mobile/app/gameplay/gameplaySessionPolicy.ts`
- Create: `apps/mobile/app/gameplay/gameplaySessionPolicy.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/MissionSetupSheet.svelte`
- Create: `apps/mobile/app/gameplay/PauseSheet.svelte`
- Create: `apps/mobile/app/gameplay/DiscardSheet.svelte`
- Modify: `apps/mobile/app/app.css`

**Produces:** framework-free policy only, not a controller/store.

```ts
export type EntrySheet = 'setup' | 'pause' | null;

export function entrySheetFor(
  restored: Pick<PersistedPuzzleSessionV1, 'lifecycle'> | undefined
): EntrySheet;

export function suspendSession(
  session: Pick<PuzzleSession, 'setDocumentHidden'>,
  save: () => void
): void;

export function commitViewport(
  session: Pick<PuzzleSession, 'dispatch'>,
  viewport: PersistedViewport | null,
  save: () => void
): PuzzleSessionOutcome;

export function discardProgress(
  storage: Pick<SessionStorageAdapter, 'clearSession'>,
  puzzleId: string
): boolean;
```

- [ ] **Step 1: Write policy tests before moving Svelte wiring**

```ts
it('maps fresh/active/paused entry without dispatching a restored active run', () => {
  expect(entrySheetFor(undefined)).toBe('setup');
  expect(entrySheetFor({ lifecycle: 'active' })).toBeNull();
  expect(entrySheetFor({ lifecycle: 'paused' })).toBe('pause');
});

it('hides before save on suspend', () => {
  const calls: string[] = [];
  suspendSession(
    { setDocumentHidden: (hidden) => calls.push(`hidden:${hidden}`) },
    () => calls.push('save')
  );
  expect(calls).toEqual(['hidden:true', 'save']);
});

it('saves only an accepted viewport change', () => {
  let saves = 0;
  const changed = commitViewport(
    { dispatch: () => ({ type: 'viewport_changed', viewport: null }) },
    null,
    () => saves++
  );
  expect(changed.type).toBe('viewport_changed');
  expect(saves).toBe(1);

  const invalid = commitViewport(
    { dispatch: () => ({ type: 'viewport_noop', reason: 'invalid_viewport' }) },
    { zoom: 0, panX: 0, panY: 0 },
    () => saves++
  );
  expect(invalid.type).toBe('viewport_noop');
  expect(saves).toBe(1);
});

it('returns the storage discard result unchanged', () => {
  expect(discardProgress({ clearSession: () => false }, 'pz1')).toBe(false);
  expect(discardProgress({ clearSession: () => true }, 'pz1')).toBe(true);
});
```

- [ ] **Step 2: Implement the four helpers**

```ts
export function entrySheetFor(restored): EntrySheet {
  if (!restored) return 'setup';
  return restored.lifecycle === 'paused' ? 'pause' : null;
}

export function suspendSession(session, save): void {
  session.setDocumentHidden(true);
  save();
}

export function commitViewport(session, viewport, save): PuzzleSessionOutcome {
  const outcome = session.dispatch({ type: 'set_viewport', viewport });
  if (outcome.type === 'viewport_changed') save();
  return outcome;
}

export function discardProgress(storage, puzzleId): boolean {
  return storage.clearSession(puzzleId);
}
```

- [ ] **Step 3: Run policy tests**

```bash
cd apps/mobile
bunx vitest run app/gameplay/gameplaySessionPolicy.test.ts
```

- [ ] **Step 4: Remove HPA-1 auto-start/resume and use `entrySheetFor()`**

After creating/subscribing the session:

```ts
let sheet: 'setup' | 'pause' | 'discard' | null = entrySheetFor(restored);

if (!restored) {
  // wait for setup Start
} else if (restored.lifecycle === 'active') {
  // intentionally no start/resume/setDocumentHidden dispatch here;
  // createPuzzleSession() already starts an active timed restored clock.
}
```

Delete the current unconditional:

```ts
session.dispatch({ type: restored?.lifecycle === 'paused' ? 'resume' : 'start' });
```

- [ ] **Step 5: Add setup and drop the all-zero rotation override**

Setup Start:

```ts
session.dispatch({
  type: 'configure_setup',
  mode: setupDraft.mode,
  rotationEnabled: setupDraft.rotationEnabled
});
session.dispatch({ type: 'start' });
saveCurrentSnapshot();
sheet = null;
```

Remove the mobile `createRotations: ids => all-zero` option so game-core default rotation generation is used.

- [ ] **Step 6: Add explicit Pause/Resume and Restart**

```ts
function pauseSession(): void {
  const outcome = session?.dispatch({ type: 'pause' });
  if (outcome?.type !== 'lifecycle_transitioned') return;
  saveCurrentSnapshot();
  sheet = 'pause';
}

function resumeSession(): void {
  const outcome = session?.dispatch({ type: 'resume' });
  if (outcome?.type !== 'lifecycle_transitioned') return;
  saveCurrentSnapshot();
  sheet = null;
}
```

Restart confirms when `hasUserActivity`, dispatches `restart`, saves setup state immediately, and reopens setup seeded with previous mode/rotation. The session’s `createTrayOrder` now produces a fresh shuffled order.

- [ ] **Step 7: Add concrete Discard**

```ts
function confirmDiscard(): void {
  if (!discardProgress(storage, spec.puzzleId)) {
    discardError = 'Unable to discard saved progress.';
    return;
  }
  onExit();
}
```

No generic dialog/error layer.

- [ ] **Step 8: Fix lifecycle wiring through the tested helper**

```ts
function onSuspend(): void {
  if (!session) return;
  suspendSession(session, saveCurrentSnapshot);
}

function onResume(): void {
  session?.setDocumentHidden(false);
}
```

`saveCurrentSnapshot()` serializes/saves without a second checkpoint; `setDocumentHidden(true)` already checkpoints the active clock before save.

Replace Task 4’s inline viewport commit with `commitViewport(session, viewport, saveCurrentSnapshot)`.

- [ ] **Step 9: Run gates and commit**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../..
git add apps/mobile/app/gameplay/gameplaySessionPolicy.ts apps/mobile/app/gameplay/gameplaySessionPolicy.test.ts apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/MissionSetupSheet.svelte apps/mobile/app/gameplay/PauseSheet.svelte apps/mobile/app/gameplay/DiscardSheet.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add tested mission session controls"
```

Native spot-check: fresh -> Setup; active restore -> gameplay without entry dispatch; paused restore -> Pause; explicit Pause/Resume; hidden time excluded; Restart -> setup; failed discard stays on sheet.

---

## Task 6: Add toolbar parity, filters/shuffle, rotation, hints, reference, and feedback

**Files:**
- Create: `apps/mobile/app/gameplay/GameplayToolbar.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/trayPieces.ts`
- Modify: `apps/mobile/app/gameplay/trayPieces.test.ts`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Lock the filtered-vs-complete shuffle contract**

Add/keep a regression:

```ts
it('shuffles every unplaced id even while Corners is visible', () => {
  const state = makeState({ filter: 'corners' });
  expect(visibleUnplacedPieceIds(state, pieces).length).toBeLessThan(unplacedPieceIds(state).length);
  expect(new Set(shuffledUnplacedPieceIds(state, () => 0.25))).toEqual(
    new Set(unplacedPieceIds(state))
  );
});
```

The Shuffle action must dispatch `shuffledUnplacedPieceIds(sessionState)`, never the filtered visible list.

- [ ] **Step 2: Add `GameplayToolbar.svelte`**

Visible: Library, puzzle name + `getDifficultyLabel(difficulty)`, timer, Undo, Redo, Hint, Reference, More.

More expands exactly: Fit Board, Rotation On/Off, Pause, Restart, Discard.

The component receives state/callback props; it does not dispatch directly.

- [ ] **Step 3: Wire engine-owned actions**

Use existing actions and save state-changing outcomes:

```ts
session.dispatch({ type: 'undo' });
session.dispatch({ type: 'redo' });
session.dispatch({ type: 'rotate_piece', pieceId: selectedPieceId });
session.dispatch({ type: 'use_hint' });
session.dispatch({
  type: 'update_tray_organization',
  update: { type: 'set_filter', filter }
});
session.dispatch({
  type: 'update_tray_organization',
  update: {
    type: 'reorder',
    trayId: 'main',
    pieceIds: shuffledUnplacedPieceIds(sessionState)
  }
});
```

`PuzzleTray` exposes remaining count, All/Corners/Edges/Center, Shuffle, selected highlight, and one selected Rotate action.

- [ ] **Step 4: Wire hint presentation from existing session events**

Construct session with `onEvent`. On `hint_target`, store ephemeral `hintPieceId`/`hintTarget`. On accepted placement of that piece, clear both. A later hint replaces both. The engine remains responsible for resetting a non-All filter to All.

- [ ] **Step 5: Add Reference row**

Reference actions:

```ts
session.dispatch({ type: 'set_reference_mode', mode: 'hold' });
session.dispatch({ type: 'set_reference_mode', mode: null });
session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
session.dispatch({ type: 'set_reference_mode', mode: 'ghost' });
```

Hold uses touch down/up/cancel. Toggle/Ghost tap again -> `null`. Persist after counted/fact-changing activations; active reference mode itself remains runtime-only.

Use only `launch.install.referencePath`; no path means no reference affordance/network fallback.

- [ ] **Step 6: Add short placement feedback**

Keep only:

```ts
let placementFeedback: {
  cell: BoardCell;
  kind: 'accepted' | 'rejected';
} | null = null;
```

Set/replace one short timeout; Canvas draws success/reject cell feedback. Hint target remains a separate persistent outline. No reducer/animation framework.

- [ ] **Step 7: Run gates and commit**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
git add apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape gameplay controls"
```

Native spot-check on Hard/Easy variants: Undo/Redo, Hint, all filters, Shuffle under a non-All filter, selected Rotate, Hold/Toggle/Ghost, More -> Fit, Pause/Restart/Discard.

---

## Task 7: Add local completion and execute Hard stress + Easy full offline acceptance

**Files:**
- Create: `apps/mobile/app/gameplay/CompletionSheet.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/library/Downloaded.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Show the immutable local completion seal**

On `completion_sealed`, save immediately and show:

```ts
interface CompletionSheetProps {
  puzzleName: string;
  difficulty: PuzzleDifficulty;
  seal: SealedCompletion;
  onBackToLibrary: () => void;
}
```

Display puzzle/difficulty, Timed or Relaxed, elapsed time when non-null, hints, incorrect attempts, rotation enabled/used, Back to Library.

No completion API, auth, outbox, achievements, leaderboard, or second local completion store.

- [ ] **Step 2: Match Gallery difficulty casing in Downloaded**

Reuse `getDifficultyLabel()` directly:

```svelte
<label
  text={`${getDifficultyLabel(row.install.manifest.puzzle.difficulty)} · ${row.install.manifest.puzzle.pieceCount} PIECES`}
/>
```

This intentionally renders `Easy · 16 PIECES`, matching Gallery rather than inventing uppercase difficulty copy. Keep the existing progress action matrix unchanged.

- [ ] **Step 3: Run all automated gates**

```bash
bun run --cwd packages/game-core test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bun run check
bun run lint
```

All must pass before native acceptance is claimed.

- [ ] **Step 4: Prepare two real downloaded variants**

With the local API available, download:

- one Hard variant for 100–108-piece tray/viewport stress;
- one Easy variant for the complete offline solve.

Confirm both finalized package directories/manifests exist, then stop the API/disable network for gameplay acceptance.

- [ ] **Step 5: Execute the Hard stress path offline**

Verify:

1. tray scrolls through 100–108 pieces;
2. normal scroll does not arm drag;
3. long-press arms drag and overlay crosses the column boundary visibly;
4. outside drop is no-op;
5. transform-aware valid drop works;
6. pinch zoom and two-finger pan work on the dense board;
7. Fit restores viewport default;
8. zoomed/panned tap and drag resolve correct canonical cells.

This path does **not** require solving 100–108 pieces.

- [ ] **Step 6: Execute the Easy full journey offline**

Verify:

1. Downloaded row shows difficulty and START;
2. START opens setup; choose mode/rotation;
3. initial tray order is shuffled rather than canonical sorted IDs;
4. tap-place and cross-view drag-place;
5. outside drop leaves incorrect attempts unchanged;
6. persist/restore viewport;
7. Rotate, All/Corners/Edges/Center, Shuffle, Hint, Hold/Toggle/Ghost, Undo/Redo;
8. explicit Pause/Resume;
9. background active timed run ≥5 seconds; hidden time excluded and no Pause sheet is forced;
10. finish the puzzle offline and see completion sheet;
11. return to Downloaded; row is `COMPLETED PROGRESS` with no Start/Resume until explicit Discard Progress.

If current simulator/XCUITest cannot reliably inject pinch/two-finger motion, record those gestures as explicit manual PASS/PENDING evidence instead of adding native E2E infrastructure.

- [ ] **Step 7: Perform final scope sweep**

```bash
git diff --name-only main...HEAD
rg "activeTray|membership|rename_tray|remove_tray|move_piece" apps/mobile/app/gameplay
rg "fetch\(|/api/|CompletionOutbox|AuthService" apps/mobile/app/gameplay
rg "calculateFitZoom" apps/mobile/app/gameplay
rg "on:pan|pointFromPan|pieceAt\(" apps/mobile/app/gameplay/PuzzleCanvas.svelte apps/mobile/app/gameplay/boardViewModel.ts
```

Expected:

- only `boardViewport.ts` may call `calculateFitZoom` in mobile gameplay;
- no legacy Canvas pan/in-canvas piece hit path remains;
- no manual tray organization feature;
- no gameplay auth/network/outbox path.

- [ ] **Step 8: Commit and update the same draft PR**

```bash
git add apps/mobile/app/gameplay/CompletionSheet.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/library/Downloaded.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add offline completion summary"
```

Update PR #74 with Task 1–7/3A/3B completion state, automated outputs, iPad/Xcode/NativeScript versions, surface gate, Hard stress evidence, Easy full-journey evidence, and any explicit manual multi-touch evidence. Mark this same PR ready only after those gates are complete.

---

## Final self-review checklist

Before implementation begins, the executor should verify the plan still satisfies these invariants:

- one `PuzzleSession`, no mobile controller/store;
- one `boardViewport.ts` fit/cell geometry source;
- `boardViewModel.ts` is draw projection only in final state;
- V1 viewport schema unchanged and shared units documented;
- Task 3A proves Canvas backing/first-paint behavior before Task 3B removes the known-working interaction path;
- Task 3B proves Hard tray scrolling vs long-press drag before viewport gestures;
- load-bearing entry/suspend/viewport/discard policy has normal unit tests;
- shuffle always operates on all unplaced pieces, not the filtered subset;
- Hard tests density/scroll/zoom stress, Easy tests complete offline lifecycle;
- no HPA-46/HPA-4/backend/schema/framework scope leakage.