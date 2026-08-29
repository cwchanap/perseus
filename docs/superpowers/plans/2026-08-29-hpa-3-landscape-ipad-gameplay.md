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
- Package-local mobile TypeScript is authoritative: `cd apps/mobile && bunx tsc --noEmit`. Do not use the known root TypeScript-7 path for this package.

## Planned file ownership

### Shared game core

- `packages/game-core/src/session/types.ts` — narrow viewport action/outcomes.
- `packages/game-core/src/session/session.ts` — validate/clone/apply viewport changes.
- `packages/game-core/src/session/session.test.ts` — action semantics and real serialize/load round trip.

The existing codec already serializes and validates optional `PersistedViewport`; do not edit it or bump `CURRENT_SESSION_SCHEMA_VERSION` unless Task 1 proves that assumption false.

### Mobile pure helpers

- `apps/mobile/app/gameplay/boardViewport.ts` + `.test.ts` — fit geometry, zoom/pan normalization, forward/inverse transform, two-pointer transform.
- `apps/mobile/app/gameplay/trayPieces.ts` + `.test.ts` — filtered unplaced-piece projection and Fisher-Yates shuffle.
- `apps/mobile/app/gameplay/boardViewModel.ts` + `.test.ts` — board-only render records and transformed hit testing.

### Mobile product components

- `Gameplay.svelte` — session construction, dispatch orchestration, persistence boundaries, ephemeral drag/hint/feedback/sheet state.
- `PuzzleCanvas.svelte` — board/reference drawing, transformed hit testing, two-finger viewport gesture, double-tap Fit.
- `PuzzleTray.svelte` — persistent right tray, piece tap/drag, filters, shuffle, selected Rotate.
- `GameplayToolbar.svelte` — Library/Undo/Redo/Hint/Reference/More and concrete expanded rows.
- `MissionSetupSheet.svelte`, `PauseSheet.svelte`, `DiscardSheet.svelte`, `CompletionSheet.svelte` — concrete session surfaces only.
- `apps/mobile/app/app.css` — landscape presentation.
- `apps/mobile/App_Resources/iOS/Info.plist` — iPad landscape-only orientation for HPA-3.
- `apps/mobile/app/library/Downloaded.svelte` — difficulty-aware saved/completed row copy.

---

### Task 1: Give `PuzzleSession` one persisted viewport action

**Files:**
- Modify: `packages/game-core/src/session/types.ts`
- Modify: `packages/game-core/src/session/session.ts`
- Modify: `packages/game-core/src/session/session.test.ts`

**Contract:**

```ts
// PuzzleSessionAction
| { type: 'set_viewport'; viewport: PersistedViewport | null }

// PuzzleSessionOutcome
| { type: 'viewport_changed'; viewport: PersistedViewport | null }
| { type: 'viewport_noop'; reason: 'invalid_viewport' }
```

- [ ] **Step 1: Add failing engine tests**

Add tests beside the existing session state/persistence tests:

```ts
it('stores viewport without making view navigation gameplay activity or history', () => {
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

- [ ] **Step 2: Run the focused test red**

```bash
cd packages/game-core
bunx vitest run src/session/session.test.ts
```

Expected: compile/test failure because the action/outcomes do not exist.

- [ ] **Step 3: Implement the minimal transition**

Add the contract in `types.ts`, dispatch it in `session.ts`, and use exactly one helper:

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

- [ ] **Step 4: Pin the existing codec through a real engine-produced snapshot**

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

Expected: PASS with schema V1 unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/game-core/src/session/types.ts packages/game-core/src/session/session.ts packages/game-core/src/session/session.test.ts
git commit -m "feat(game-core): persist puzzle viewport changes"
```

---

### Task 2: Add pure board viewport math

**Files:**
- Create: `apps/mobile/app/gameplay/boardViewport.ts`
- Create: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Surface:**

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

export interface TwoPointerTransformInput {
  startViewport: PersistedViewport | null;
  startFocusX: number;
  startFocusY: number;
  currentFocusX: number;
  currentFocusY: number;
  scale: number;
}

export function createBoardTransform(input: BoardViewportInput): BoardTransform;
export function transformViewportForTwoPointers(
  board: BoardViewportInput,
  gesture: TwoPointerTransformInput
): PersistedViewport | null;
```

- [ ] **Step 1: Write tests first**

Cover these numeric cases:

1. Fit uses `calculateFitZoom()` and centers the board.
2. `cellAt()` maps transformed Canvas points back to canonical cells.
3. `zoom < 1` normalizes to Fit; `zoom > 4` clamps to 4.
4. Fit normalizes pan to `0,0`/`null`.
5. A pure two-finger translation changes pan without zoom.
6. A pure pinch changes zoom while keeping the pinch-center board point stable before clamp.
7. Combined translation + pinch applies from one gesture baseline, not incrementally twice.
8. Pan clamp keeps a board axis centered when the transformed board still fits and prevents dragging an oversized axis completely away.

Example fit assertion:

```ts
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
```

- [ ] **Step 2: Run red**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts
```

Expected: FAIL resolving the new module.

- [ ] **Step 3: Implement the transform**

Use the game-core fit helper and keep persisted pan in **board-cell units**:

```ts
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const fitCellSize = calculateFitZoom(gridCols, gridRows, canvasWidth, canvasHeight);
const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport?.zoom ?? 1));
const cellSize = fitCellSize * zoom;
const panPixelsX = (viewport?.panX ?? 0) * fitCellSize;
const panPixelsY = (viewport?.panY ?? 0) * fitCellSize;
```

A normalized zoom of 1 returns `viewport: null`. All returned non-null viewport values are fresh finite objects.

For two-pointer motion, compute zoom and centroid translation from the gesture-start viewport/geometry every frame. Do not apply a pinch delta and a pan delta independently to already-mutated state.

- [ ] **Step 4: Run green**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts
bunx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add board viewport transform math"
```

---

### Task 3: Move unplaced pieces into the production landscape tray

**Files:**
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Create: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/boardViewModel.ts`
- Modify: `apps/mobile/app/gameplay/boardViewModel.test.ts`
- Modify: `apps/mobile/app/app.css`

**Result:** Fit-only board plus a persistent right tray, with tap placement and cross-view drag placement. Task 4 adds viewport gestures after this path is green.

- [ ] **Step 1: Make the `BoardViewModel` test describe a board-only renderer**

Extend options with `viewport`, route board geometry through `createBoardTransform()`, and prove unplaced pieces no longer produce Canvas draw records:

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

Add one zoomed viewport case to prove `cellAt()` follows transformed board geometry.

- [ ] **Step 2: Run red**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
```

Expected: current temporary tray/fit-only model fails.

- [ ] **Step 3: Refactor `BoardViewModel`**

Delete the horizontal tray record generation and `pieceAt()`. Keep placed-piece jigsaw overdraw using transformed `cellSize`:

```ts
x: transform.boardX + piece.x * transform.cellSize - transform.cellSize * 0.2,
y: transform.boardY + piece.y * transform.cellSize - transform.cellSize * 0.2,
width: transform.cellSize * 1.4,
height: transform.cellSize * 1.4
```

- [ ] **Step 4: Create `PuzzleTray.svelte` with only the placement essentials**

First slice props:

```ts
export let pieceIds: readonly number[];
export let piecePaths: Record<number, string>;
export let selectedPieceId: number | null;
export let onSelectPiece: (pieceId: number) => void;
export let onPieceDragStart: (pieceId: number, screenX: number, screenY: number) => void;
export let onPieceDragMove: (pieceId: number, screenX: number, screenY: number) => void;
export let onPieceDragEnd: (pieceId: number, screenX: number, screenY: number) => void;
```

Use `TouchGestureEventData.getActivePointers()`/`getAllPointers()` and the touched view's `getLocationOnScreen()` to emit screen coordinates in NativeScript DIPs. A tap still calls `onSelectPiece`. Piece touch owns piece dragging; do not turn Canvas one-finger motion into board pan.

Keep the tray vertically scrollable. During an active piece drag, temporarily disable tray scrolling; restore it on up/cancel. No drag service is introduced.

- [ ] **Step 5: Make `PuzzleCanvas.svelte` board-only and expose one screen-to-cell method**

Delete Canvas ownership of unplaced-piece selection/pan. Keep board tap placement.

```ts
export function cellAtScreenPoint(screenX: number, screenY: number): BoardCell | null {
  const origin = canvas?.getLocationOnScreen?.();
  if (!origin || !viewModel) return null;
  const scale = Screen.mainScreen.scale || 1;
  return viewModel.cellAt((screenX - origin.x) * scale, (screenY - origin.y) * scale);
}
```

This is the only cross-view coordinate boundary. Tray stays in DIPs; Canvas converts once to its backing-pixel space.

- [ ] **Step 6: Compose the landscape shell in `Gameplay.svelte`**

Use a flexible board plus a simple `320` DIP tray. Wrap components in native GridLayout children so row/column properties belong to real NativeScript views:

```svelte
<gridLayout columns="*,320" rows="auto,*" class="gameplay-page">
  <gridLayout row="1" col="0" class="gameplay-board-column">
    <PuzzleCanvas bind:this={puzzleCanvas} ... />
  </gridLayout>
  <gridLayout row="1" col="1" class="gameplay-tray-column">
    <PuzzleTray ... />
  </gridLayout>
</gridLayout>
```

`Gameplay.svelte` derives unplaced IDs from `trayOrder - placedPieces`. On drag end:

1. ask `puzzleCanvas.cellAtScreenPoint(screenX, screenY)`;
2. if null, clear ephemeral drag and return without dispatch;
3. otherwise call the same `attemptPlacement(pieceId, cell)` used by tap placement.

- [ ] **Step 7: Lock only iPad to landscape**

Change `UISupportedInterfaceOrientations~ipad` to:

```xml
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
```

Leave the phone block unchanged. Validate syntax with:

```bash
plutil -lint apps/mobile/App_Resources/iOS/Info.plist
```

- [ ] **Step 8: Run gates and real launch**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
plutil -lint apps/mobile/App_Resources/iOS/Info.plist
```

Then launch the established iPad simulator:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Verify: board majority column, persistent right tray, tap-piece/tap-cell works, drag tray->board works, release outside board does not increment incorrect attempts.

- [ ] **Step 9: Commit**

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

**NativeScript API:** use the installed gesture surface: `touch` exposes active pointers, and `doubleTap` is a built-in gesture. Treat a two-pointer touch as one combined transform so pinch and centroid pan cannot double-apply.

- [ ] **Step 1: Finish pure two-pointer tests**

Pin tests for scale-only, centroid-only, combined motion, and clamps through `transformViewportForTwoPointers()`.

- [ ] **Step 2: Run tests red/green around any missing math**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewport.test.ts
```

- [ ] **Step 3: Add one two-pointer gesture owner in Canvas**

On the first `touch` event with exactly two active pointers, capture:

- starting viewport;
- centroid in Canvas backing coordinates;
- pointer distance.

On move with two pointers, calculate current centroid/distance and project a transient viewport from the start baseline. Redraw immediately but do not write the session on every frame.

When the gesture ends/cancels below two pointers, emit:

```ts
export let onViewportCommit: (viewport: PersistedViewport | null) => void;
```

`doubleTap` emits `null` for Fit. One-pointer Canvas movement never pans the board.

- [ ] **Step 4: Dispatch viewport at the persistence boundary**

In `Gameplay.svelte`:

```ts
function commitViewport(viewport: PersistedViewport | null): void {
  if (!session) return;
  const outcome = session.dispatch({ type: 'set_viewport', viewport });
  if (outcome.type === 'viewport_changed') persist();
}
```

Pass `sessionState.viewport` back to Canvas. Restored sessions therefore paint the persisted transform immediately.

- [ ] **Step 5: Verify transformed placement**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

On iPad: zoom/pan, then verify both tap-cell and tray drag release still map to correct canonical cells. Fit must lead to `viewport === null` in the saved state.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/gameplay/PuzzleCanvas.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/boardViewport.ts apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "feat(mobile): add puzzle zoom pan and fit"
```

---

### Task 5: Replace auto-start with setup, pause, restart, discard, and correct lifecycle timing

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/MissionSetupSheet.svelte`
- Create: `apps/mobile/app/gameplay/PauseSheet.svelte`
- Create: `apps/mobile/app/gameplay/DiscardSheet.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Remove the HPA-1 automatic start/resume dispatch**

Replace the current unconditional startup behavior with route-local entry state:

```ts
let sheet: 'setup' | 'pause' | 'discard' | null = null;

if (session) {
  if (!restored) {
    sheet = 'setup';
  } else if (restored.lifecycle === 'paused') {
    sheet = 'pause';
  } else if (restored.lifecycle === 'active') {
    // Hydration does not automatically create a live clock interval.
    // This re-arms it only when timerStarted/mode/lifecycle require it.
    session.setDocumentHidden(false);
  }
}
```

This explicit `setDocumentHidden(false)` is load-bearing for timed active resumes: the current engine hydrates state but starts a clock interval only through `resume`, visibility re-entry, or first timer-starting gameplay action.

- [ ] **Step 2: Add `MissionSetupSheet.svelte`**

Expose only Timed/Relaxed, Rotation On/Off, Start, Library. On Start:

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

Delete the current all-zero `createRotations` override so `PuzzleSession` uses the existing production random-rotation generator when rotation is enabled.

Do not add a mobile preference store in HPA-3.

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

`PauseSheet.svelte` also exposes Restart, Library and Discard.

- [ ] **Step 4: Add Restart without a rules copy**

Seed the setup draft from current `mode`/`rotationEnabled`. If `hasUserActivity`, show an inline restart confirmation state in the concrete Pause/More flow. On confirmation:

```ts
session.dispatch({ type: 'restart' });
persist();
sheet = 'setup';
```

The next Start does `configure_setup + start`. Fresh engine state resets viewport to Fit and the filter to All under existing restart semantics.

- [ ] **Step 5: Add concrete Discard confirmation**

`DiscardSheet.svelte` calls the parent. Clear the real variant session and exit only on success:

```ts
function confirmDiscard(): void {
  if (!storage.clearSession(spec.puzzleId)) {
    discardError = 'Unable to discard saved progress.';
    return;
  }
  onExit();
}
```

No generic dialog/error layer.

- [ ] **Step 6: Fix suspend ordering**

Do not serialize before the engine stops/checkpoints the clock:

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

If needed, split the old `persist()` into `checkpointAndSave()` and `saveCurrentSnapshot()` so suspend does not checkpoint twice. Backgrounding never changes `sheet`; an explicitly paused lifecycle stays paused.

- [ ] **Step 7: Verify on iPad**

Check new Start -> setup; active timed resume continues ticking; paused resume stays paused; explicit Pause persists; hidden time does not accrue; foreground does not create a Pause sheet; Restart returns to setup with prior choices; Discard clears the save.

Run:

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/gameplay/MissionSetupSheet.svelte apps/mobile/app/gameplay/PauseSheet.svelte apps/mobile/app/gameplay/DiscardSheet.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add mission session controls"
```

---

### Task 6: Add toolbar parity, filters/shuffle, rotation, hints, and all reference modes

**Files:**
- Create: `apps/mobile/app/gameplay/GameplayToolbar.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/trayPieces.ts`
- Create: `apps/mobile/app/gameplay/trayPieces.test.ts`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Test filtered unplaced projection and shuffle**

```ts
export function visibleUnplacedPieceIds(
  state: Readonly<PuzzleSessionState>,
  pieces: SessionPuzzleSpec['pieces']
): number[];

export function shuffleIds(
  ids: readonly number[],
  random: () => number = Math.random
): number[];
```

Tests prove placed IDs never appear; All/Corners/Edges/Center call the existing `matchesInventoryFilter`; input arrays are not mutated; injected randomness makes Fisher-Yates deterministic.

```bash
cd apps/mobile
bunx vitest run app/gameplay/trayPieces.test.ts
```

- [ ] **Step 2: Add `GameplayToolbar.svelte`**

Visible: Library, puzzle name+difficulty, timer, Undo, Redo, Hint, Reference, More.

`More` expands one concrete row with exactly: Fit Board, Rotation On/Off, Pause, Restart, Discard.

The component receives state/callback props and does not dispatch directly. Disable Undo/Redo from engine flags; lock rotation toggle after placements; gate Pause by active lifecycle.

- [ ] **Step 3: Wire engine-owned tray controls**

Use existing actions, then persist state-changing outcomes:

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

`PuzzleTray` shows remaining count, four filters, Shuffle, selection, and one selected-piece Rotate action. It does not expose `activeTray`, membership or names.

- [ ] **Step 4: Wire hint presentation from the existing event**

Construct the session with `onEvent`. On `hint_target`, store ephemeral `hintPieceId` and `hintTarget`. The engine already resets a non-All filter to All. Highlight the hinted tray piece and board cell; clear when that piece gets `placement_accepted` or a later hint replaces it.

Do not serialize hint presentation state.

- [ ] **Step 5: Implement the three reference modes in one concrete row**

Reference expands: Hold to Peek, Toggle, Ghost.

```ts
session.dispatch({ type: 'set_reference_mode', mode: 'hold' }); // touch down
session.dispatch({ type: 'set_reference_mode', mode: null });   // up/cancel
session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
session.dispatch({ type: 'set_reference_mode', mode: 'ghost' });
```

Tapping the currently active Toggle/Ghost sends `null`. Persist after activation counters/facts change; active mode itself stays runtime-only.

Load only `launch.install.referencePath`. No path means the Reference action is hidden/disabled and there is no network fallback.

Canvas layering:

- Ghost: board-aligned reference behind pieces, low opacity.
- Hold/Toggle: stronger board-aligned overlay while pieces remain visible.

- [ ] **Step 6: Add short placement feedback**

Keep only ephemeral `{ cell, kind: 'accepted' | 'rejected' }` plus a short timeout. Canvas draws green/red target feedback. Hint target remains distinct until consumed/replaced.

- [ ] **Step 7: Run gates + native parity spot-check**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bunx prettier --check apps/mobile/app
```

On iPad verify Undo/Redo, Hint, all filters, Shuffle, selected Rotate, Hold/Toggle/Ghost, Fit, Pause, Restart, Discard.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/gameplay apps/mobile/app/app.css
git commit -m "feat(mobile): add landscape gameplay controls"
```

---

### Task 7: Add local completion sheet and execute the final offline iPad gate

**Files:**
- Create: `apps/mobile/app/gameplay/CompletionSheet.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/library/Downloaded.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Present the immutable local completion seal**

On `completion_sealed`, save immediately and show a concrete sheet projected from `SealedCompletion` + downloaded metadata:

```ts
interface CompletionSheetProps {
  puzzleName: string;
  difficulty: PuzzleDifficulty;
  seal: SealedCompletion;
  onBackToLibrary: () => void;
}
```

Display puzzle/difficulty, Timed or Relaxed result, elapsed time when non-null, hints, incorrect attempts, rotation enabled/used, Back to Library.

Do not call completion APIs, add auth, add an outbox, or build a second local stats database. The sealed session itself is the HPA-3 durable local completion state; HPA-4 owns account-bound submission.

- [ ] **Step 2: Clarify variant difficulty in Downloaded**

Reuse `getDifficultyLabel()` from `familyGallery.ts` and change row copy from `16 PIECES` to `EASY · 16 PIECES`. Keep the existing `none | resumable | protected | invalid` action matrix untouched.

- [ ] **Step 3: Run all automated gates**

```bash
bun run --cwd packages/game-core test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../.. && bun run check
bun run lint
```

All must pass before native acceptance is claimed.

- [ ] **Step 4: Download one real Easy variant, then remove the network dependency**

Run the normal local API, download one ready Easy family variant through Gallery, and confirm the finalized package exists. Then stop the API/disable networking for the gameplay journey. Do not add an HPA-3 backend route or permanent special fixture.

- [ ] **Step 5: Execute the landscape iPad offline smoke**

Record NativeScript/Xcode/iPad simulator versions and verify:

1. Downloaded row shows difficulty and START.
2. START opens setup; choose mode/rotation.
3. Tap-place one piece.
4. Cross-view drag-place one piece.
5. Release outside board; incorrect attempts stay unchanged.
6. Pinch zoom and two-finger pan; saved session gets finite viewport values.
7. Exit/relaunch Resume; placements and viewport restore and an active timed clock continues.
8. Fit; next saved snapshot omits viewport.
9. Exercise Rotate, all filters, Shuffle, Hint, Hold/Toggle/Ghost Reference, Undo, Redo.
10. Explicit Pause/Resume.
11. Background an active timed run for at least five seconds; hidden time is excluded and no unwanted Pause sheet appears.
12. Finish the variant offline and see the completion sheet.
13. Return to Downloaded; row is `COMPLETED PROGRESS` and has no Start/Resume until explicit Discard Progress.

If the current simulator/XCUITest path cannot reliably inject pinch/two-finger motion, record those two physical gestures as explicit manual PASS/PENDING evidence instead of adding a new native automation framework. `boardViewport.test.ts` remains the automated math gate.

- [ ] **Step 6: Perform the final scope sweep**

```bash
git diff --name-only main...HEAD
rg "activeTray|membership|rename_tray|remove_tray|move_piece" apps/mobile/app/gameplay
rg "fetch\(|/api/|CompletionOutbox|AuthService" apps/mobile/app/gameplay
```

Expected: no manual-tray feature and no gameplay network/auth/outbox path. Production changes stay inside the narrow game-core viewport seam, mobile gameplay/library presentation, and iPad orientation.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/gameplay/CompletionSheet.svelte apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/library/Downloaded.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add offline completion summary"
```

- [ ] **Step 8: Update this same draft PR**

Add Task 1–7 completion state, automated gate output, native device/runtime details, native smoke evidence, and any explicitly manual multi-touch evidence to the existing PR body. Do not open another PR. Mark this PR ready only after implementation and the acceptance ledger are complete.