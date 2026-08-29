# HPA-3 Landscape iPad Gameplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship production landscape iPad gameplay on the existing NativeScript offline library with one shared `PuzzleSession`, one board-geometry module, tested lifecycle/persistence policy, and small native stop gates before risky gesture work.

**Architecture:** `PuzzleSession` remains the only gameplay controller. `Gameplay.svelte` stays the composition root, while `boardViewport.ts` is the only board geometry/coordinate source and a tiny `gameplaySessionPolicy.ts` makes entry/suspend/viewport/discard orchestration unit-testable without adding a Svelte test framework. Canvas, tray, toolbar, and sheets remain concrete NativeScript components; no backend, new schema, global store, or generic UI/gesture framework is added.

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

## Final File Ownership

### Shared game core

- Modify `packages/game-core/src/session/types.ts` — persisted viewport unit documentation + narrow action/outcomes.
- Modify `packages/game-core/src/session/session.ts` — validate/clone/apply viewport action.
- Modify `packages/game-core/src/session/session.test.ts` — action semantics + V1 codec round trip.

The codec already serializes/validates `PersistedViewport`; keep it unchanged.

### Mobile pure modules

- Create `apps/mobile/app/gameplay/boardViewport.ts` + `.test.ts` — Canvas surface conversion, fit/zoom/pan transform, screen→Canvas conversion, `cellAt`, two-pointer math, double-tap suppression.
- Modify `apps/mobile/app/gameplay/boardViewModel.ts` + `.test.ts` — draw-record projection over a supplied `BoardTransform`; no fit formula or final `cellAt` ownership.
- Create `apps/mobile/app/gameplay/trayPieces.ts` + `.test.ts` — all-unplaced/visible-unplaced projection and Fisher-Yates policy over a narrow tray-state input.
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

export interface TwoPointerTransformInput {
  startViewport: PersistedViewport | null;
  startFocusX: number;
  startFocusY: number;
  currentFocusX: number;
  currentFocusY: number;
  scale: number;
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

export function createBoardTransform(input: BoardViewportInput): BoardTransform;

export function transformViewportForTwoPointers(
  board: BoardViewportInput,
  gesture: TwoPointerTransformInput
): PersistedViewport | null;
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

Also add explicit assertions for zero/invalid surface dimensions, transformed inverse `cellAt`, zoom clamp `1..4`, Fit -> `null`, pan clamp, pure two-pointer translation, focal pinch, and combined pinch+translation from one start baseline.

- [ ] **Step 2: Run red**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts app/gameplay/boardViewModel.test.ts
```

Expected: the new module is missing and current BoardViewModel still owns a second fit formula.

- [ ] **Step 3: Implement `boardViewport.ts` with explicit no-padding Fit**

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

```ts
export function createBoardViewModel(transform: BoardTransform): BoardViewModel;
```

Remove its `calculateFitZoom()` call and remove `cellAt()` from the view-model interface. Canvas callers use `transform.cellAt()`.

For this task only, keep temporary unplaced-piece draw records and `pieceAt()` so Task 3A can use the known HPA-1 drag path as the native surface oracle. Task 3B deletes both.

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

**Stop condition:** Do not start Task 3B if the installed Canvas cannot keep layout size stable while backing `width/height` follow layout DIPs × density, or if first post-layout paint/hit-testing is unreliable.

- [ ] **Step 1: Replace fixed surface sizing but keep the existing HPA-1 interaction path**

Delete `CANVAS_WIDTH = 700` / `CANVAS_HEIGHT = 800` and old letterboxing `toCanvasPoint()`.

Keep `on:pan`, `pointFromPan`, temporary in-Canvas unplaced records, and `pieceAt()` for this checkpoint only.

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

Use this full temporary markup:

```svelte
<canvas
  bind:this={canvas}
  horizontalAlignment="stretch"
  verticalAlignment="stretch"
  backgroundColor="#111820"
  on:loaded={syncSurface}
  on:layoutChanged={syncSurface}
  on:tap={onTap}
  on:pan={onPan}
/>
```

The first non-zero layout + next JS turn replaces the old fixed 100 ms delay.

- [ ] **Step 2: Route all local gesture points through one conversion**

The existing tap/pan path must use `screenPointToCanvas()` + `surfaceMetrics`. Remove `(viewSize - displayWidth) / 2` letterboxing compensation.

- [ ] **Step 3: Run package checks**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

- [ ] **Step 4: Run the iPad surface gate**

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Record:

1. Canvas fills its current container;
2. actual layout DIPs and backing pixel dimensions;
3. first paint succeeds after first non-zero layout without the old 100 ms delay;
4. existing tap placement works at device density;
5. existing in-Canvas drag works at device density;
6. relaunch/relayout recreates correct hit geometry.

If backing width/height feed back into layout size or first paint still fails, stop and revise this task only.

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

- [ ] **Step 1: Add narrow tray state and pure order/projection helpers**

```ts
export type TrayProjectionState = Pick<
  PuzzleSessionState,
  'placedPieces' | 'trayOrder' | 'organization' | 'gridCols' | 'gridRows'
>;

export function unplacedPieceIds(state: TrayProjectionState): number[];

export function visibleUnplacedPieceIds(
  state: TrayProjectionState,
  pieces: SessionPuzzleSpec['pieces']
): number[];

export function shuffleIds(
  ids: readonly number[],
  random: () => number = Math.random
): number[];

export function shuffledUnplacedPieceIds(
  state: TrayProjectionState,
  random: () => number = Math.random
): number[];
```

The Fisher-Yates implementation intentionally duplicates the tiny web helper because mobile depends only on game-core/types and tray-order creation is an app/runtime seam.

Use this explicit regression state in `trayPieces.test.ts`:

```ts
const pieces = Array.from({ length: 9 }, (_, id) => ({
  id,
  correctX: id % 3,
  correctY: Math.floor(id / 3)
}));

const state: TrayProjectionState = {
  gridCols: 3,
  gridRows: 3,
  trayOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  placedPieces: [{ pieceId: 4, x: 1, y: 1 }],
  organization: {
    filter: 'corners',
    activeTray: 'main',
    membership: {},
    names: {}
  }
};

expect(visibleUnplacedPieceIds(state, pieces)).toEqual([0, 2, 6, 8]);
expect(new Set(shuffledUnplacedPieceIds(state, () => 0.25))).toEqual(
  new Set([0, 1, 2, 3, 5, 6, 7, 8])
);
```

Also prove input arrays are not mutated and injected RNG is deterministic.

- [ ] **Step 2: Use one shuffle policy for fresh and restarted runs**

Set these exact session-construction fields:

```ts
initialTrayOrder: shuffleIds(spec.pieces.map((piece) => piece.id)),
createTrayOrder: () => shuffleIds(spec.pieces.map((piece) => piece.id))
```

Do not remove the all-zero `createRotations` override yet; Task 5 removes it with setup behavior.

- [ ] **Step 3: Create a scrollable `PuzzleTray.svelte` with explicit drag arming**

```svelte
<scrollView bind:this={trayScroll} isScrollEnabled={!dragArmed}>
  <stackLayout>
    <!-- render piece views from visible piece IDs -->
  </stackLayout>
</scrollView>
```

For each piece:

- tap -> `onSelectPiece(pieceId)`;
- `longPress` state `began` -> `dragArmed=true`, ScrollView disabled, `onPieceDragStart`;
- armed `touch move` -> `onPieceDragMove`;
- armed `touch up/cancel` -> `onPieceDragEnd`, clear arm, restore scrolling.

Do not invent a custom duration. If NativeScript high-level longPress cannot coexist with ScrollView, Task 3B stops before viewport gestures.

- [ ] **Step 4: Make Gameplay own a full-bleed drag overlay**

```ts
interface ActivePieceDrag {
  pieceId: number;
  screenX: number;
  screenY: number;
}

let activePieceDrag: ActivePieceDrag | null = null;
```

Render one overlay image above board + tray in a full-page GridLayout. On drag end:

1. `puzzleCanvas.cellAtScreenPoint(screenX, screenY)`;
2. null -> clear overlay, no dispatch;
3. cell -> call existing `attemptPlacement(pieceId, cell)`;
4. clear overlay.

- [ ] **Step 5: Make Canvas board-only and delete the legacy drag path**

Delete together: `on:pan`, `onPan`, `pointFromPan`, Canvas drag offsets/coordinates, `BoardViewModel.pieceAt()`, and temporary unplaced Canvas draw records.

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

BoardViewModel final interface is draw projection only.

- [ ] **Step 6: Compose landscape layout and lock iPad orientation**

Use one layered page GridLayout with board/tray `columns="*,320"` and the drag overlay above both. No resizable divider.

Set `UISupportedInterfaceOrientations~ipad` to landscape left/right only and run:

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

- [ ] **Step 8: Run the Hard-variant tray/drag stop gate**

Download a Hard variant (100–108 pieces). Verify on iPad:

1. tray genuinely scrolls;
2. normal vertical scroll does not start drag;
3. long-press arms drag without scrolling;
4. overlay stays visible across the column boundary;
5. outside release is a no-op;
6. correct-cell release reaches `attempt_placement` and places the piece.

If longPress + ScrollView is unreliable, stop and choose the smallest local alternative; do not introduce a generic gesture subsystem.

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

- [ ] **Step 1: Add the Fit-suppression helper**

```ts
export function canFitOnDoubleTap(
  selectedPieceId: number | null,
  nowMs: number,
  suppressFitUntilMs: number
): boolean {
  return selectedPieceId === null && nowMs >= suppressFitUntilMs;
}
```

A placement tap advances `suppressFitUntilMs` past the platform double-tap callback so an accepted placement cannot clear selection and then trigger Fit. More -> Fit Board is always available while a piece remains selected. Do not delay every placement tap.

Add tests for unselected/unsuppressed true, selected false, and suppression-window false.

- [ ] **Step 2: Add transient viewport redraw wiring**

```ts
let transientViewport: PersistedViewport | null | undefined = undefined;

$: effectiveViewport =
  transientViewport !== undefined ? transientViewport : sessionState.viewport;

$: if (surfaceReady && sessionState) {
  rebuildTransform(effectiveViewport);
  draw();
}
```

`undefined` means no active gesture; `null` remains a valid transient Fit value.

- [ ] **Step 3: Add final Canvas gesture markup**

```svelte
<canvas
  bind:this={canvas}
  horizontalAlignment="stretch"
  verticalAlignment="stretch"
  on:loaded={syncSurface}
  on:layoutChanged={syncSurface}
  on:touch={onTouch}
  on:tap={onTap}
  on:doubleTap={onDoubleTap}
/>
```

No `on:pan` remains.

On exactly two active pointers: first frame captures start viewport/centroid/distance; move derives `transientViewport` from that start baseline through `transformViewportForTwoPointers`; end/cancel emits one viewport commit and clears transient state. One-finger Canvas movement is a no-op.

- [ ] **Step 4: Emit one commit boundary**

```ts
export let onViewportCommit: (viewport: PersistedViewport | null) => void;
```

For this task, Gameplay dispatches `set_viewport` and saves only after `viewport_changed`. Task 5 moves that policy into the tested helper with no behavior change.

- [ ] **Step 5: Run tests + Hard gesture spot-check**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

On Hard verify pinch, centroid pan, Fit, zoomed/panned tap-cell mapping, zoomed/panned tray-drop mapping, and no `place -> Fit` conflict. Record manual multi-touch evidence if automation is unreliable.

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
it('maps fresh/active/paused entry without dispatching an active restore', () => {
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

- [ ] **Step 2: Implement the four helpers with the signatures above**

```ts
export function entrySheetFor(
  restored: Pick<PersistedPuzzleSessionV1, 'lifecycle'> | undefined
): EntrySheet {
  if (!restored) return 'setup';
  return restored.lifecycle === 'paused' ? 'pause' : null;
}

export function suspendSession(
  session: Pick<PuzzleSession, 'setDocumentHidden'>,
  save: () => void
): void {
  session.setDocumentHidden(true);
  save();
}

export function commitViewport(
  session: Pick<PuzzleSession, 'dispatch'>,
  viewport: PersistedViewport | null,
  save: () => void
): PuzzleSessionOutcome {
  const outcome = session.dispatch({ type: 'set_viewport', viewport });
  if (outcome.type === 'viewport_changed') save();
  return outcome;
}

export function discardProgress(
  storage: Pick<SessionStorageAdapter, 'clearSession'>,
  puzzleId: string
): boolean {
  return storage.clearSession(puzzleId);
}
```

- [ ] **Step 3: Run policy tests**

```bash
cd apps/mobile
bunx vitest run app/gameplay/gameplaySessionPolicy.test.ts
```

- [ ] **Step 4: Remove HPA-1 auto-start/resume and use `entrySheetFor()`**

```ts
let sheet: 'setup' | 'pause' | 'discard' | null = entrySheetFor(restored);
```

Delete the current unconditional `session.dispatch({ type: restored?.lifecycle === 'paused' ? 'resume' : 'start' })`.

For an active restored snapshot, do nothing on entry: `createPuzzleSession()` already starts the active timed clock when required.

- [ ] **Step 5: Add setup and drop the all-zero rotation override**

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

Remove the mobile all-zero `createRotations` option so game-core default rotation generation is used.

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

Restart confirms when `hasUserActivity`, dispatches `restart`, saves setup state immediately, and reopens setup seeded with previous mode/rotation. `createTrayOrder` produces the fresh shuffled order.

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

- [ ] **Step 8: Route suspend and viewport commit through tested policy**

```ts
function onSuspend(): void {
  if (!session) return;
  suspendSession(session, saveCurrentSnapshot);
}

function onResume(): void {
  session?.setDocumentHidden(false);
}
```

`saveCurrentSnapshot()` serializes/saves without another checkpoint. Replace Task 4’s inline viewport commit with `commitViewport(session, viewport, saveCurrentSnapshot)`.

- [ ] **Step 9: Run gates and commit**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../..
git add apps/mobile/app/gameplay/gameplaySessionPolicy.ts apps/mobile/app/gameplay/gameplaySessionPolicy.test.ts apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/MissionSetupSheet.svelte apps/mobile/app/gameplay/PauseSheet.svelte apps/mobile/app/gameplay/DiscardSheet.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add tested mission session controls"
```

Native spot-check: fresh -> Setup; active restore -> gameplay without entry dispatch; paused restore -> Pause; Pause/Resume; hidden time excluded; Restart -> setup; failed discard stays on sheet.

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

- [ ] **Step 1: Keep Shuffle on all unplaced IDs**

The Task 3B Corners regression remains the contract. The action must dispatch:

```ts
session.dispatch({
  type: 'update_tray_organization',
  update: {
    type: 'reorder',
    trayId: 'main',
    pieceIds: shuffledUnplacedPieceIds(sessionState)
  }
});
```

Never pass `visibleUnplacedPieceIds(...)` to `reorder`.

- [ ] **Step 2: Add `GameplayToolbar.svelte`**

Visible: Library, puzzle name + `getDifficultyLabel(difficulty)`, timer, Undo, Redo, Hint, Reference, More. More expands exactly Fit Board, Rotation On/Off, Pause, Restart, Discard. Component receives state/callback props and never dispatches directly.

- [ ] **Step 3: Wire engine-owned actions**

```ts
session.dispatch({ type: 'undo' });
session.dispatch({ type: 'redo' });
session.dispatch({ type: 'rotate_piece', pieceId: selectedPieceId });
session.dispatch({ type: 'use_hint' });
session.dispatch({
  type: 'update_tray_organization',
  update: { type: 'set_filter', filter }
});
```

Save state-changing outcomes. Tray exposes remaining count, four filters, Shuffle, selected highlight, and one selected Rotate action.

- [ ] **Step 4: Wire hint presentation from existing events**

On `hint_target`, store ephemeral `hintPieceId`/`hintTarget`. On accepted placement of that piece, clear both. Later hint replaces both. Engine remains responsible for filter reset to All.

- [ ] **Step 5: Add Reference row**

```ts
session.dispatch({ type: 'set_reference_mode', mode: 'hold' });
session.dispatch({ type: 'set_reference_mode', mode: null });
session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
session.dispatch({ type: 'set_reference_mode', mode: 'ghost' });
```

Hold uses touch down/up/cancel. Toggle/Ghost tap again -> `null`. Use only `launch.install.referencePath`; no path means no reference affordance/network fallback.

- [ ] **Step 6: Add short placement feedback**

```ts
let placementFeedback: {
  cell: BoardCell;
  kind: 'accepted' | 'rejected';
} | null = null;
```

Set/replace one short timeout. Canvas draws success/reject feedback; hint target is separate. Do not create a reducer/animation framework.

- [ ] **Step 7: Run gates and commit**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
git add apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape gameplay controls"
```

Native spot-check on Hard/Easy: Undo/Redo, Hint, all filters, Shuffle under non-All filter, selected Rotate, Hold/Toggle/Ghost, More -> Fit, Pause/Restart/Discard.

---

## Task 7: Add local completion and execute Hard stress + Easy full offline acceptance

**Files:**
- Create: `apps/mobile/app/gameplay/CompletionSheet.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/library/Downloaded.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Show the immutable local completion seal**

```ts
interface CompletionSheetProps {
  puzzleName: string;
  difficulty: PuzzleDifficulty;
  seal: SealedCompletion;
  onBackToLibrary: () => void;
}
```

On `completion_sealed`, save immediately and show puzzle/difficulty, Timed/Relaxed, elapsed time when non-null, hints, incorrect attempts, rotation enabled/used, Back to Library. No completion API, auth, outbox, achievements, leaderboard, or second local completion store.

- [ ] **Step 2: Match Gallery difficulty casing in Downloaded**

```svelte
<label
  text={`${getDifficultyLabel(row.install.manifest.puzzle.difficulty)} · ${row.install.manifest.puzzle.pieceCount} PIECES`}
/>
```

This intentionally renders `Easy · 16 PIECES`. Keep the existing progress action matrix unchanged.

- [ ] **Step 3: Run all automated gates**

```bash
bun run --cwd packages/game-core test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bun run check
bun run lint
```

- [ ] **Step 4: Prepare two real downloaded variants**

Download one Hard variant for 100–108-piece stress and one Easy variant for full completion. Confirm both finalized package directories/manifests, then stop the API/disable network for gameplay acceptance.

- [ ] **Step 5: Execute the Hard stress path offline**

Verify tray scrolling, normal-scroll vs long-press-drag separation, visible overlay across columns, outside-drop no-op, transform-aware valid drop, pinch, two-finger pan, Fit, and zoomed/panned tap+drag cell resolution. Do **not** require a 100–108-piece solve.

- [ ] **Step 6: Execute the Easy full journey offline**

Verify:

1. row shows difficulty + START;
2. setup mode/rotation;
3. initial tray order shuffled, not canonical sorted IDs;
4. tap and cross-view drag placement;
5. outside drop leaves incorrect attempts unchanged;
6. viewport persists/restores;
7. Rotate, all filters, Shuffle, Hint, Hold/Toggle/Ghost, Undo/Redo;
8. Pause/Resume;
9. background active timed run ≥5 seconds; hidden time excluded and no Pause sheet forced;
10. finish offline and see completion sheet;
11. Downloaded becomes `COMPLETED PROGRESS` with no Start/Resume until explicit Discard Progress.

If simulator/XCUITest cannot reliably inject pinch/two-finger motion, record explicit manual evidence instead of adding native E2E infrastructure.

- [ ] **Step 7: Perform final scope sweep**

```bash
git diff --name-only main...HEAD
rg "activeTray|membership|rename_tray|remove_tray|move_piece" apps/mobile/app/gameplay
rg "fetch\(|/api/|CompletionOutbox|AuthService" apps/mobile/app/gameplay
rg "calculateFitZoom" apps/mobile/app/gameplay
rg "on:pan|pointFromPan|pieceAt\(" apps/mobile/app/gameplay/PuzzleCanvas.svelte apps/mobile/app/gameplay/boardViewModel.ts
```

Expected: only `boardViewport.ts` calls `calculateFitZoom` in mobile gameplay; no legacy Canvas pan/piece hit path; no manual tray organization feature; no gameplay auth/network/outbox path.

- [ ] **Step 8: Commit and update this same draft PR**

```bash
git add apps/mobile/app/gameplay/CompletionSheet.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/library/Downloaded.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add offline completion summary"
```

Update PR #74 with Task 1–7/3A/3B state, automated outputs, NativeScript/Xcode/iPad versions, surface gate, Hard stress evidence, Easy full-journey evidence, and any explicit manual multi-touch evidence. Mark this PR ready only after those gates are complete.

---

## Final Self-Review Checklist

- One `PuzzleSession`; no mobile controller/store.
- One `boardViewport.ts` fit/cell geometry source.
- `boardViewModel.ts` is draw projection only in final state.
- V1 viewport schema unchanged; persisted units documented.
- Task 3A proves Canvas backing/first-paint behavior before Task 3B removes the known-working interaction path.
- Task 3B proves Hard tray scrolling vs long-press drag before viewport gestures.
- Entry/suspend/viewport/discard policy has normal unit tests.
- Shuffle operates on all unplaced pieces, not filtered subset.
- Hard tests density/scroll/zoom stress; Easy tests complete offline lifecycle.
- No HPA-46/HPA-4/backend/schema/framework scope leakage.