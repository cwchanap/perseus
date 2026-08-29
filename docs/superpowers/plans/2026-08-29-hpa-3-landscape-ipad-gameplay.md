# HPA-3 Landscape iPad Gameplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the production landscape iPad puzzle experience on the existing NativeScript offline library, with transform-aware touch interaction and current web gameplay parity driven by the shared `PuzzleSession`.

**Architecture:** Keep `Gameplay.svelte` as the mobile composition root, `PuzzleSession` as the only gameplay controller, and file-backed sessions as the only mobile save source. Add one narrow shared viewport action, then build concrete mobile board/tray/toolbar/sheet components around it; no backend, new schema, generic UI framework, or second store.

**Tech Stack:** TypeScript 5.9, NativeScript 9, Svelte Native 1.0, `@nativescript/canvas` 2.1, Vitest 4, `@perseus/game-core`.

**Spec:** `docs/superpowers/specs/2026-08-29-hpa-3-landscape-ipad-gameplay-design.md`

## Global Constraints

- One HPA-3 PR only. Continue implementation on `docs/hpa-3-landscape-ipad-gameplay-plan`; do not open a second implementation PR.
- Concrete downloaded variant `manifest.puzzle.id` remains the gameplay/session/download identity. `familyId` and `difficulty` are presentation metadata only.
- Do not change API routes, D1, Workflows, infrastructure, auth, download-manifest schema, or persisted-session schema version.
- `PuzzleSession` remains the sole owner of placement validity, mode/timer, rotation, history, hints, reference mode, filter/order, and completion sealing.
- Mobile must not expose or deliberately mutate named/staging tray membership, active tray selection, tray names, rename/remove, multi-select, or clustering.
- No mobile controller/global store, generic toolbar/dialog/gesture framework, or broad native E2E framework.
- HPA-3 is iPad landscape only. HPA-46 owns portrait and live orientation changes.
- Package-local mobile TypeScript is the authoritative command: `cd apps/mobile && bunx tsc --noEmit`; do not use the known root `bunx tsc --project apps/mobile/tsconfig.json --noEmit` TypeScript-7 path.

---

## File structure

### Shared game core

- `packages/game-core/src/session/types.ts` — add the narrow viewport action/outcomes.
- `packages/game-core/src/session/session.ts` — validate/clone/apply viewport changes without gameplay side effects.
- `packages/game-core/src/session/session.test.ts` — pin action semantics and real serialize/load restoration.

The existing `packages/game-core/src/session/codec.ts` already serializes, validates, and restores optional viewport state. Do not revise the codec or bump `CURRENT_SESSION_SCHEMA_VERSION` unless a failing test proves the existing path insufficient.

### Mobile pure gameplay helpers

- `apps/mobile/app/gameplay/boardViewport.ts` — fit geometry, normalized zoom/pan, transform/inverse-transform, pinch and pan math.
- `apps/mobile/app/gameplay/boardViewport.test.ts` — deterministic transform tests.
- `apps/mobile/app/gameplay/trayPieces.ts` — filtered unplaced-piece projection and Fisher-Yates shuffle helper.
- `apps/mobile/app/gameplay/trayPieces.test.ts` — deterministic projection/shuffle tests.
- `apps/mobile/app/gameplay/boardViewModel.ts` — board-only render records and hit testing using the viewport transform.
- `apps/mobile/app/gameplay/boardViewModel.test.ts` — transformed canonical-cell regression tests.

### Mobile Svelte Native product surfaces

- `apps/mobile/app/gameplay/Gameplay.svelte` — session lifecycle/composition, persistence checkpoints, ephemeral drag/hint/feedback/sheet state, and all engine dispatches.
- `apps/mobile/app/gameplay/PuzzleCanvas.svelte` — board/reference drawing, transformed board hit testing, two-finger viewport gesture, double-tap Fit, board feedback.
- `apps/mobile/app/gameplay/PuzzleTray.svelte` — persistent right tray, piece tap/drag, filters, shuffle, selected Rotate.
- `apps/mobile/app/gameplay/GameplayToolbar.svelte` — Library/Undo/Redo/Hint/Reference/More and concrete expanded action rows.
- `apps/mobile/app/gameplay/MissionSetupSheet.svelte` — Timed/Relaxed + Rotation + Start.
- `apps/mobile/app/gameplay/PauseSheet.svelte` — Resume/Restart/Library/Discard.
- `apps/mobile/app/gameplay/DiscardSheet.svelte` — destructive progress confirmation and inline clear failure.
- `apps/mobile/app/gameplay/CompletionSheet.svelte` — local completion summary projected from `SealedCompletion`.
- `apps/mobile/app/app.css` — concrete landscape toolbar/tray/sheet styling.
- `apps/mobile/App_Resources/iOS/Info.plist` — advertise iPad landscape orientations only for HPA-3.
- `apps/mobile/app/library/Downloaded.svelte` — show variant difficulty beside piece count so saved/completed progress is unambiguous after PR #73.

---

### Task 1: Give `PuzzleSession` a narrow persisted viewport action

**Files:**
- Modify: `packages/game-core/src/session/types.ts`
- Modify: `packages/game-core/src/session/session.ts`
- Modify: `packages/game-core/src/session/session.test.ts`

**Interfaces:**
- Consumes: existing `PersistedViewport`, `PuzzleSessionAction`, `PuzzleSessionOutcome`, serializer/loader.
- Produces: `set_viewport` dispatch with `viewport_changed | viewport_noop`, available to mobile through the existing `@perseus/game-core` wildcard export.

- [ ] **Step 1: Add failing action-semantic tests**

Append focused tests beside other display/persistence actions in `session.test.ts`:

```ts
it('stores viewport without turning view navigation into gameplay activity or history', () => {
  const session = createPuzzleSession(makeOptions());
  session.dispatch({ type: 'start' });

  const before = session.getState();
  const outcome = session.dispatch({
    type: 'set_viewport',
    viewport: { zoom: 2, panX: 1.25, panY: -0.5 }
  });
  const after = session.getState();

  expect(outcome).toEqual({
    type: 'viewport_changed',
    viewport: { zoom: 2, panX: 1.25, panY: -0.5 }
  });
  expect(after.viewport).toEqual({ zoom: 2, panX: 1.25, panY: -0.5 });
  expect(after.hasUserActivity).toBe(before.hasUserActivity);
  expect(after.canUndo).toBe(before.canUndo);
  expect(after.canRedo).toBe(before.canRedo);
  expect(after.resultClass).toBe(before.resultClass);
});

it('clears viewport for Fit and rejects non-finite values', () => {
  const session = createPuzzleSession(makeOptions());
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'set_viewport', viewport: { zoom: 2, panX: 1, panY: 1 } });

  expect(session.dispatch({ type: 'set_viewport', viewport: null })).toEqual({
    type: 'viewport_changed',
    viewport: null
  });
  expect(session.getState().viewport).toBeNull();

  expect(
    session.dispatch({
      type: 'set_viewport',
      viewport: { zoom: Number.NaN, panX: 0, panY: 0 }
    })
  ).toEqual({ type: 'viewport_noop', reason: 'invalid_viewport' });
  expect(session.getState().viewport).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify it fails on the missing action**

Run:

```bash
bun run --cwd packages/game-core test:unit -- src/session/session.test.ts
```

Expected: TypeScript/test failure because `set_viewport` and the two new outcomes are not in the contract.

- [ ] **Step 3: Add the contract and minimal engine transition**

In `types.ts`, extend the action/outcome unions exactly:

```ts
| { type: 'set_viewport'; viewport: PersistedViewport | null }
```

```ts
| { type: 'viewport_changed'; viewport: PersistedViewport | null }
| { type: 'viewport_noop'; reason: 'invalid_viewport' }
```

In `session.ts`, route `set_viewport` through one helper:

```ts
function doSetViewport(viewport: PersistedViewport | null): PuzzleSessionOutcome {
  if (
    viewport !== null &&
    (!Number.isFinite(viewport.zoom) ||
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

- [ ] **Step 4: Pin the existing codec round trip through the real engine state**

Add a round-trip assertion using the existing `serializeSession`, `loadPersistedSession`, and `contextFromMetadata` helpers:

```ts
const metadata = makeMetadata();
const session = createPuzzleSession(makeOptions({ metadata }));
session.dispatch({ type: 'start' });
session.dispatch({ type: 'set_viewport', viewport: { zoom: 1.75, panX: 0.5, panY: -1 } });

const snapshot = serializeSession(session.getState(), 1234);
expect(snapshot?.viewport).toEqual({ zoom: 1.75, panX: 0.5, panY: -1 });
expect(loadPersistedSession(JSON.stringify(snapshot), contextFromMetadata(metadata))).toMatchObject({
  status: 'loaded',
  snapshot: { viewport: { zoom: 1.75, panX: 0.5, panY: -1 } }
});
```

- [ ] **Step 5: Run the game-core gate**

Run:

```bash
bun run --cwd packages/game-core test:unit
```

Expected: PASS with the existing schema version unchanged.

- [ ] **Step 6: Commit the shared seam**

```bash
git add packages/game-core/src/session/types.ts packages/game-core/src/session/session.ts packages/game-core/src/session/session.test.ts
git commit -m "feat(game-core): persist puzzle viewport changes"
```

---

### Task 2: Add pure viewport transform math

**Files:**
- Create: `apps/mobile/app/gameplay/boardViewport.ts`
- Create: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Interfaces:**
- Consumes: `PersistedViewport`, grid dimensions, Canvas backing dimensions.
- Produces: one normalized transform used by `BoardViewModel` and `PuzzleCanvas` in later tasks.

Define this mobile-local surface:

```ts
export interface BoardViewportInput {
  canvasWidth: number;
  canvasHeight: number;
  gridCols: number;
  gridRows: number;
  viewport: PersistedViewport | null;
}

export interface BoardTransform {
  cellSize: number;
  boardX: number;
  boardY: number;
  boardWidth: number;
  boardHeight: number;
  viewport: PersistedViewport | null;
  cellAt(canvasX: number, canvasY: number): { x: number; y: number } | null;
}

export function createBoardTransform(input: BoardViewportInput): BoardTransform;
export function zoomViewportAt(
  input: BoardViewportInput,
  focusX: number,
  focusY: number,
  scaleFromGestureStart: number,
  startViewport: PersistedViewport | null
): PersistedViewport | null;
export function panViewportBy(
  input: BoardViewportInput,
  deltaCanvasX: number,
  deltaCanvasY: number,
  startViewport: PersistedViewport | null
): PersistedViewport | null;
```

- [ ] **Step 1: Write failing transform tests**

Cover fit, restored viewport, inverse hit testing, zoom bounds, pinch anchoring, and pan clamp. Use numeric examples rather than snapshots:

```ts
it('uses Fit as zoom 1 with centered board and canonical inverse hit testing', () => {
  const transform = createBoardTransform({
    canvasWidth: 800,
    canvasHeight: 600,
    gridCols: 4,
    gridRows: 3,
    viewport: null
  });

  expect(transform.cellSize).toBe(200);
  expect(transform.boardX).toBe(0);
  expect(transform.boardY).toBe(0);
  expect(transform.cellAt(399, 199)).toEqual({ x: 1, y: 0 });
});

it('clamps zoom to 1..4 and normalizes Fit pan to zero', () => {
  expect(
    createBoardTransform({
      canvasWidth: 800,
      canvasHeight: 600,
      gridCols: 4,
      gridRows: 3,
      viewport: { zoom: 0.25, panX: 20, panY: 20 }
    }).viewport
  ).toBeNull();
});
```

Use a second case with a portrait-ish board inside a wide Canvas to prove the fitting axis remains centered and a zoomed board can pan only on the oversized axis.

- [ ] **Step 2: Run the new test and verify it fails because the module does not exist**

```bash
bun run --cwd apps/mobile test:unit -- app/gameplay/boardViewport.test.ts
```

Expected: FAIL resolving `./boardViewport`.

- [ ] **Step 3: Implement the smallest transform module**

Use `calculateFitZoom()` from game-core for the base fit cell size. Persist `panX/panY` in **cell units** and convert to backing pixels only inside the transform:

```ts
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport?.zoom ?? 1));
const fitCellSize = calculateFitZoom(gridCols, gridRows, canvasWidth, canvasHeight);
const cellSize = fitCellSize * zoom;
const panPixelsX = (viewport?.panX ?? 0) * fitCellSize;
const panPixelsY = (viewport?.panY ?? 0) * fitCellSize;
```

Normalize `zoom <= 1` to `null`. Clamp each pan axis using the transformed board extent and viewport center; do not allow blank space past both opposing board edges. Return a fresh viewport object after pinch/pan calculations.

- [ ] **Step 4: Run the pure mobile tests**

```bash
bun run --cwd apps/mobile test:unit -- app/gameplay/boardViewport.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the pure transform**

```bash
git add apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add board viewport transform math"
```

---

### Task 3: Replace the temporary Canvas tray with the landscape shell and right tray

**Files:**
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Create: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/boardViewModel.ts`
- Modify: `apps/mobile/app/gameplay/boardViewModel.test.ts`
- Modify: `apps/mobile/app/app.css`

**Interfaces:**
- Consumes: `BoardTransform`, current `PuzzleSessionState`, existing installed piece paths.
- Produces: landscape board + persistent tray, tap placement and cross-view drag placement. No viewport gestures yet; Fit remains the transform default until Task 4.

- [ ] **Step 1: Update the `BoardViewModel` test to describe a board-only renderer**

Replace the old fitted-only assertion with transformed board records and remove expectations that unplaced pieces have Canvas tray coordinates:

```ts
const vm = createBoardViewModel({
  canvasWidth: 800,
  canvasHeight: 600,
  gridCols: 2,
  gridRows: 2,
  viewport: null
});

expect(vm.cellAt(250, 150)).toEqual({ x: 0, y: 0 });
expect(vm.state(state).drawRecords.every((record) => record.placed)).toBe(true);
```

Add one `viewport: { zoom: 2, panX: 0.5, panY: 0 }` case that proves `cellAt` uses the transformed geometry.

- [ ] **Step 2: Run the focused test and verify the current API/temporary tray fails it**

```bash
bun run --cwd apps/mobile test:unit -- app/gameplay/boardViewModel.test.ts
```

Expected: FAIL because `viewport` is not consumed and unplaced Canvas records still exist.

- [ ] **Step 3: Refactor `BoardViewModel` to board-only geometry**

Use `createBoardTransform()` for `cellAt` and placed-piece draw records. Delete the in-Canvas horizontal tray layout and `pieceAt()` entirely.

Keep the existing jigsaw overdraw factor for placed piece PNGs:

```ts
x: transform.boardX + piece.x * transform.cellSize - transform.cellSize * 0.2,
y: transform.boardY + piece.y * transform.cellSize - transform.cellSize * 0.2,
width: transform.cellSize * 1.4,
height: transform.cellSize * 1.4
```

- [ ] **Step 4: Create a concrete right-side `PuzzleTray.svelte`**

The first version needs only remaining pieces, selected highlight, tap selection, and screen-coordinate drag callbacks. Use NativeScript `TouchGestureEventData` pointer coordinates plus `getLocationOnScreen()`; keep coordinates in NativeScript DIPs until the Canvas boundary.

Expose:

```ts
export let pieceIds: readonly number[];
export let piecePaths: Record<number, string>;
export let selectedPieceId: number | null;
export let onSelectPiece: (pieceId: number) => void;
export let onPieceDragStart: (pieceId: number, screenX: number, screenY: number) => void;
export let onPieceDragMove: (pieceId: number, screenX: number, screenY: number) => void;
export let onPieceDragEnd: (pieceId: number, screenX: number, screenY: number) => void;
```

Do not add filter/shuffle/rotate controls yet; Task 6 adds them after placement is green.

- [ ] **Step 5: Make `PuzzleCanvas.svelte` board-only and expose screen-to-cell conversion**

Delete Canvas selection/piece-drag ownership. Keep board taps for selected-piece placement.

Export one component method used only by `Gameplay.svelte`:

```ts
export function cellAtScreenPoint(screenX: number, screenY: number): BoardCell | null {
  const origin = canvas?.getLocationOnScreen?.();
  if (!origin || !viewModel) return null;
  const localDipX = screenX - origin.x;
  const localDipY = screenY - origin.y;
  const scale = Screen.mainScreen.scale || 1;
  return viewModel.cellAt(localDipX * scale, localDipY * scale);
}
```

Keep the existing Canvas tap conversion on the same backing-pixel convention so tap and cross-view drag end in the same `cellAt` path.

- [ ] **Step 6: Compose the landscape shell in `Gameplay.svelte`**

Use a simple GridLayout with a flexible board column and a fixed practical tray column; start with `320` DIPs for the tray rather than a resizing system:

```svelte
<gridLayout columns="*,320" rows="auto,*" class="gameplay-page">
  <gridLayout row="1" col="0" class="gameplay-board-column">
    <PuzzleCanvas bind:this={puzzleCanvas} ... />
  </gridLayout>
  <PuzzleTray row="1" col="1" ... />
</gridLayout>
```

`Gameplay.svelte` derives unplaced IDs from `sessionState.trayOrder - placedPieces`, coordinates ephemeral drag state, calls `puzzleCanvas.cellAtScreenPoint()` on drag end, and dispatches the existing `attemptPlacement()` helper.

Release outside the board returns without dispatching; wrong/non-upright cells use the engine rejection path.

- [ ] **Step 7: Lock iPad to landscape for the HPA-3 slice**

Change only `UISupportedInterfaceOrientations~ipad` to:

```xml
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
```

Leave the phone orientation block alone. HPA-46 will re-enable portrait.

- [ ] **Step 8: Run mobile unit/type/style gates and a real landscape launch**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
bunx prettier --check apps/mobile/app apps/mobile/App_Resources/iOS/Info.plist
```

Then launch the already-used iPad simulator:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Verify the board occupies the majority column, the tray is persistent on the right, tapping a tray piece then a cell works, dragging from tray to the board works, and releasing outside the board does not increment incorrect attempts.

- [ ] **Step 9: Commit the landscape placement slice**

```bash
git add apps/mobile/App_Resources/iOS/Info.plist apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape board and puzzle tray"
```

---

### Task 4: Add pinch zoom, two-finger pan, Fit, and viewport persistence

**Files:**
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/boardViewport.ts`
- Modify: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Interfaces:**
- Consumes: Task 1 `set_viewport`, Task 2 transform helpers, NativeScript `TouchGestureEventData.getActivePointers()`, `doubleTap`.
- Produces: normalized persisted viewport and transform-aware placement.

- [ ] **Step 1: Extend pure tests for a combined two-pointer transform**

Add a helper that applies both distance scaling and centroid translation from one gesture baseline:

```ts
export interface TwoPointerTransformInput {
  startViewport: PersistedViewport | null;
  startFocusX: number;
  startFocusY: number;
  currentFocusX: number;
  currentFocusY: number;
  scale: number;
}

export function transformViewportForTwoPointers(
  board: BoardViewportInput,
  gesture: TwoPointerTransformInput
): PersistedViewport | null;
```

Test scale-only, centroid-only, combined scale+move, and clamping. This is preferable to independently applying pinch and pan recognizers and double-counting the same two-finger motion.

- [ ] **Step 2: Run the viewport tests red, implement the helper, run green**

```bash
bun run --cwd apps/mobile test:unit -- app/gameplay/boardViewport.test.ts
```

- [ ] **Step 3: Add the Canvas two-pointer gesture owner**

Use NativeScript `touch` for two-pointer ownership and `doubleTap` for Fit. On the first event with two active pointers, capture:

- starting viewport;
- pointer centroid in Canvas backing coordinates;
- pointer distance.

On move with two pointers, compute current centroid/distance and call `transformViewportForTwoPointers`. Update local drawing immediately without persisting every frame.

When the gesture ends/cancels below two active pointers, call one callback:

```ts
export let onViewportCommit: (viewport: PersistedViewport | null) => void;
```

Double-tap calls `onViewportCommit(null)` and redraws Fit.

Ignore one-pointer Canvas moves for panning. Piece dragging is owned by `PuzzleTray`.

- [ ] **Step 4: Dispatch and persist viewport only at gesture boundaries**

In `Gameplay.svelte`:

```ts
function commitViewport(viewport: PersistedViewport | null): void {
  if (!session) return;
  const outcome = session.dispatch({ type: 'set_viewport', viewport });
  if (outcome.type === 'viewport_changed') persist();
}
```

Pass `sessionState.viewport` to the Canvas. Restored sessions therefore paint with the persisted transform immediately.

- [ ] **Step 5: Verify transform-aware placement after viewport changes**

Run:

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

On iPad, zoom/pan and then verify both tap-cell and tray-drag release map to the correct canonical cell. Fit must return to `viewport === null` after the next save.

- [ ] **Step 6: Commit viewport interaction**

```bash
git add apps/mobile/app/gameplay/PuzzleCanvas.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add puzzle zoom pan and fit"
```

---

### Task 5: Replace auto-start with setup, explicit pause, restart, discard, and correct app lifecycle

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/MissionSetupSheet.svelte`
- Create: `apps/mobile/app/gameplay/PauseSheet.svelte`
- Create: `apps/mobile/app/gameplay/DiscardSheet.svelte`
- Modify: `apps/mobile/app/app.css`

**Interfaces:**
- Consumes: existing `configure_setup`, `start`, `pause`, `resume`, `restart`, `SessionStorageAdapter.clearSession`.
- Produces: concrete session-control sheets and correct suspend ordering. No new game-core lifecycle action.

- [ ] **Step 1: Remove the HPA-1 automatic start/resume block**

Replace:

```ts
session.dispatch({ type: restored?.lifecycle === 'paused' ? 'resume' : 'start' });
```

with entry orchestration:

```ts
let sheet: 'setup' | 'pause' | 'discard' | null = null;

if (session) {
  if (!restored) {
    sheet = 'setup';
  } else if (restored.lifecycle === 'paused') {
    sheet = 'pause';
  }
}
```

An active restored snapshot stays active. A paused restored snapshot stays paused.

- [ ] **Step 2: Add the concrete setup sheet**

`MissionSetupSheet.svelte` accepts a draft `{ mode, rotationEnabled }` and callbacks. It contains only Timed/Relaxed, Rotation On/Off, Start, and Library.

On Start:

```ts
session.dispatch({ type: 'configure_setup', mode: draft.mode, rotationEnabled: draft.rotationEnabled });
session.dispatch({ type: 'start' });
persist();
sheet = null;
```

Delete the `createRotations: ids => all-zero` override from `createPuzzleSession()` so game-core's real production rotation generator is used.

- [ ] **Step 3: Add Pause/Resume and restart semantics**

Explicit Pause:

```ts
const outcome = session.dispatch({ type: 'pause' });
if (outcome.type === 'lifecycle_transitioned') {
  persist();
  sheet = 'pause';
}
```

Restart stores the current mode/rotation as the setup draft, confirms when `hasUserActivity`, dispatches `restart`, persists the fresh setup state, then opens setup. Start subsequently runs `configure_setup + start`.

Do not build a generic modal component.

- [ ] **Step 4: Add explicit discard confirmation**

`DiscardSheet.svelte` calls back to `Gameplay.svelte`. The parent clears the real variant session key:

```ts
function confirmDiscard(): void {
  if (!storage.clearSession(spec.puzzleId)) {
    discardError = 'Unable to discard saved progress.';
    return;
  }
  onExit();
}
```

Keep the sheet open on failure.

- [ ] **Step 5: Fix background checkpoint ordering**

Change suspend handling to:

```ts
function onSuspend(): void {
  if (!session) return;
  session.setDocumentHidden(true);
  saveCurrentSnapshot();
}

function onResume(): void {
  session?.setDocumentHidden(false);
}
```

Split `persist()` if necessary so `saveCurrentSnapshot()` does not call `checkpointTime()` a second time after `setDocumentHidden(true)`. Explicit Pause remains lifecycle `paused`; backgrounding never changes the sheet.

- [ ] **Step 6: Verify the lifecycle journey on iPad**

Check:

1. START opens setup instead of immediately running.
2. Rotation On creates non-zero randomized orientations for at least one repeated run when randomness produces them.
3. explicit Pause survives app background/foreground;
4. an active timed run backgrounded for several seconds does not accrue those hidden seconds;
5. returning from background does not open Pause unless the user explicitly paused;
6. restarting returns to setup with prior mode/rotation selected;
7. discard removes the session and returns to Downloaded.

Then run:

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

- [ ] **Step 7: Commit session controls**

```bash
git add apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/MissionSetupSheet.svelte apps/mobile/app/gameplay/PauseSheet.svelte apps/mobile/app/gameplay/DiscardSheet.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add mission session controls"
```

---

### Task 6: Add toolbar, filters/shuffle, rotation, hints, and all reference modes

**Files:**
- Create: `apps/mobile/app/gameplay/GameplayToolbar.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/trayPieces.ts`
- Create: `apps/mobile/app/gameplay/trayPieces.test.ts`
- Modify: `apps/mobile/app/app.css`

**Interfaces:**
- Consumes: existing `canUndo/canRedo`, `rotate_piece`, `set_rotation_mode`, `use_hint`, `set_reference_mode`, `update_tray_organization`, `hint_target` event, `matchesInventoryFilter`.
- Produces: touch-oriented parity without a mobile rules copy.

- [ ] **Step 1: Write pure tray projection/shuffle tests**

`trayPieces.ts` should expose:

```ts
export function visibleUnplacedPieceIds(
  state: Readonly<PuzzleSessionState>,
  pieces: SessionPuzzleSpec['pieces']
): number[];

export function shuffleIds(ids: readonly number[], random: () => number = Math.random): number[];
```

Tests must prove:

- placed IDs never appear;
- `all/corners/edges/center` reuse `matchesInventoryFilter` rather than local edge rules;
- input order/array is not mutated;
- injected random makes Fisher-Yates deterministic.

Run red then green:

```bash
bun run --cwd apps/mobile test:unit -- app/gameplay/trayPieces.test.ts
```

- [ ] **Step 2: Add the concrete top toolbar**

Visible row: Library, puzzle name + difficulty, timer, Undo, Redo, Hint, Reference, More.

`GameplayToolbar.svelte` takes booleans/callbacks; it does not dispatch directly. `More` expands an inline row with exactly Fit, Rotation, Pause, Restart, Discard.

Disable Undo/Redo from `sessionState.canUndo/canRedo`; disable Rotation toggle once the engine would reject it (placed pieces > 0); keep Pause active only in active lifecycle.

- [ ] **Step 3: Wire undo/redo/filter/shuffle/selected Rotate through the engine**

Use these existing dispatch shapes, followed by `persist()` when state changes:

```ts
session.dispatch({ type: 'undo' });
session.dispatch({ type: 'redo' });
session.dispatch({ type: 'rotate_piece', pieceId: sessionState.selectedPieceId });
session.dispatch({
  type: 'update_tray_organization',
  update: { type: 'set_filter', filter }
});
session.dispatch({
  type: 'update_tray_organization',
  update: { type: 'reorder', trayId: 'main', pieceIds: shuffleIds(unplacedIds) }
});
```

`PuzzleTray` renders only the filtered unplaced projection and one Rotate control; no per-piece Rotate overlay.

- [ ] **Step 4: Wire hint presentation from `PuzzleSession` events**

Pass `onEvent` when constructing the session. On `hint_target`, set ephemeral `hintPieceId` and `hintTarget`. Do not persist this UI state.

The Canvas draws a distinct hint target outline. The tray highlights the hinted piece. Clear the hint after `placement_accepted` for that piece; another hint replaces it. Let the existing engine reset a non-All filter to All.

- [ ] **Step 5: Add all three reference modes with one concrete Reference row**

The toolbar's Reference button expands Hold to Peek / Toggle / Ghost.

Dispatch exactly:

```ts
session.dispatch({ type: 'set_reference_mode', mode: 'hold' }); // touch down
session.dispatch({ type: 'set_reference_mode', mode: null });   // touch up/cancel
session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
session.dispatch({ type: 'set_reference_mode', mode: 'ghost' });
```

Toggle/ghost tapping the already-active mode dispatches `null`. Persist after engine-owned reference activations/counters change; the active mode itself remains runtime-only per the codec.

Load `launch.install.referencePath` once in `PuzzleCanvas.svelte` when present. Draw ghost behind pieces at low opacity; draw hold/toggle as a stronger board-aligned overlay. When there is no `referencePath`, hide/disable the Reference action and do not fetch anything.

- [ ] **Step 6: Add short accepted/rejected board feedback**

Store only ephemeral `{ cell, kind: 'accepted' | 'rejected' }` in `Gameplay.svelte` from placement outcomes/events. Pass it to Canvas for a green/red cell flash; clear with one short timeout. Keep hint outline separate and persistent until consumed.

Do not add animation/sound frameworks.

- [ ] **Step 7: Run parity-focused mobile gates**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
bunx prettier --check apps/mobile/app
```

On iPad verify Undo/Redo, Hint, all four filters, Shuffle, selected Rotate, Hold/Toggle/Ghost Reference, Fit, Pause, Restart and Discard all mutate/project the shared session correctly.

- [ ] **Step 8: Commit gameplay parity controls**

```bash
git add apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape gameplay controls"
```

---

### Task 7: Add local completion sheet, Downloaded variant clarity, and the final offline iPad gate

**Files:**
- Create: `apps/mobile/app/gameplay/CompletionSheet.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/library/Downloaded.svelte`
- Modify: `apps/mobile/app/app.css`

**Interfaces:**
- Consumes: `PuzzleSessionEvent.completion_sealed`, `SealedCompletion`, `manifest.puzzle.difficulty`, existing Downloaded protected-progress classification.
- Produces: durable local completion presentation and final HPA-3 acceptance evidence. No HPA-4 auth/server submission work.

- [ ] **Step 1: Show a concrete completion sheet from the sealed completion**

On `completion_sealed`, persist immediately and set the sheet seal. Render only stable local facts:

```ts
interface CompletionSheetProps {
  puzzleName: string;
  difficulty: PuzzleDifficulty;
  seal: SealedCompletion;
  onBackToLibrary: () => void;
}
```

Display difficulty, Timed/Relaxed result, elapsed time when non-null, hints, incorrect attempts, rotation enabled/used, and Back to Library.

Do **not** call completion APIs, add an outbox, or surface pending `serverSubmission` state. HPA-4 owns account-bound server submission.

- [ ] **Step 2: Make Downloaded rows unambiguous after family difficulty**

Reuse `getDifficultyLabel()` from `familyGallery.ts` and change the detail copy from:

```text
16 PIECES
```

to:

```text
EASY · 16 PIECES
```

Keep all existing `none | resumable | protected | invalid` action behavior unchanged.

- [ ] **Step 3: Run all automated gates before native acceptance**

```bash
bun run --cwd packages/game-core test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bun run check
bun run lint
```

All must pass before claiming the native gate.

- [ ] **Step 4: Prepare one real downloaded Easy variant**

Run the local API using the repository's normal development command and download one ready Easy family variant through the mobile Gallery. Confirm its finalized `downloads/<variantId>/manifest.json`, reference when available, and piece files exist before disabling/stopping network/API access.

Do not add a special HPA-3 fixture or backend route.

- [ ] **Step 5: Execute the landscape iPad offline smoke**

Using the existing NativeScript iPad simulator/device workflow, record the exact device/runtime versions and verify this journey after the package is downloaded and the API/network is unavailable:

1. Downloaded row shows difficulty and START.
2. START opens setup; choose a mode/rotation and enter gameplay.
3. Tap-place one piece.
4. Cross-view drag-place one piece.
5. Release one piece outside the board and verify no incorrect-attempt increment.
6. Pinch zoom and two-finger pan; inspect the session file after a gesture end and confirm finite `viewport` values.
7. Exit/relaunch Resume and confirm the same viewport and placements restore.
8. Fit and confirm the next saved snapshot omits `viewport`.
9. Exercise Rotate, all filters, Shuffle, Hint, Hold/Toggle/Ghost Reference, Undo and Redo.
10. Explicitly Pause and Resume.
11. Background an active timed run for at least five seconds; foreground and verify hidden time was not added and no new Pause sheet appeared.
12. Complete the variant offline and verify the completion sheet.
13. Return to Downloaded and verify `COMPLETED PROGRESS` with no Start/Resume until explicit Discard Progress.

If the current simulator/XCUITest path cannot reliably inject pinch/two-finger motion, document those two physical gestures as manual PASS/PENDING evidence instead of adding a new native automation framework. Automated `boardViewport.test.ts` still gates the transform math.

- [ ] **Step 6: Perform the final scope sweep**

Run:

```bash
git diff --name-only main...HEAD
rg "activeTray|membership|rename_tray|remove_tray|move_piece" apps/mobile/app/gameplay
rg "fetch\(|/api/|CompletionOutbox|AuthService" apps/mobile/app/gameplay
```

Expected:

- changed production code is confined to game-core viewport ownership, mobile gameplay/library presentation, iPad orientation, and planning docs;
- no mobile manual-tray mutation is introduced;
- no gameplay network/auth/outbox path is introduced.

- [ ] **Step 7: Commit completion/polish evidence changes**

```bash
git add apps/mobile/app/gameplay/CompletionSheet.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/library/Downloaded.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add offline completion summary"
```

- [ ] **Step 8: Update the existing draft PR rather than opening another one**

Update its body with:

- task checklist for Tasks 1–7;
- automated gate results;
- iPad device/runtime and native smoke evidence;
- any explicitly manual multi-touch acceptance status;
- confirmation that HPA-46/HPA-4 remain out of scope.

When implementation and the recorded gate are complete, mark this same PR ready for review.