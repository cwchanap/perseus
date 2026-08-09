# HPA-557 Puzzle Route Component Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the puzzle route into a clear composition/orchestration root by extracting board, inventory, and completion presentation into three concrete Svelte components without adding another gameplay state layer.

**Architecture:** `PuzzleSession` remains the only canonical gameplay state owner and `+page.svelte` keeps source loading, persistence, lifecycle, completion effects, auth retry, and global shortcuts. `PuzzleBoardPanel` owns board markup plus ephemeral zoom/pan mechanics, `PuzzleInventoryPanel` owns tray presentation, and `PuzzleCompletionDialog` owns completion presentation. Components communicate with the route through explicit values and callbacks; one route-owned `aria-live` region is exposed through `announce(message)` for future HPA-223 work.

**Tech Stack:** Svelte 5/SvelteKit, TypeScript, `vitest-browser-svelte`, Vitest browser mode, Playwright, Bun/Turborepo.

## Global Constraints

- Extract exactly `PuzzleBoardPanel.svelte`, `PuzzleInventoryPanel.svelte`, and `PuzzleCompletionDialog.svelte`.
- Keep `PuzzleSession` as the only canonical gameplay state owner.
- Keep source loading/disposal, session construction/subscription, persistence checkpoints, completion effects, auth retry, setup/pause/restart/exit orchestration, and global Undo/Redo shortcuts in `+page.svelte`.
- Components may own presentation-local state only; zoom/pan is presentation-local and belongs to `PuzzleBoardPanel`.
- Do not add a controller, view-model object, store, state machine, event bus, context provider, DI layer, generic panel component, or generic dialog framework.
- Preserve current behavior, class semantics, ARIA roles, and existing `data-testid` values.
- Do not implement HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, or HPA-224 product behavior while extracting components.
- Establish exactly one route-owned polite live region and one `announce(message)` callback; do not implement roving focus or an announcement catalog in this ticket.
- Duplicate the small board/inventory panel-header styles rather than creating a reusable panel abstraction.
- Add tests only for behavior that moves behind a component boundary; keep existing route tests as the main integration fence.

## Execution Risks

- **Viewport behavior drift:** zoom/pan changes ownership. Preserve the existing clamp/fit algorithms and add a focused board-panel browser test before removing route state.
- **Scoped CSS drift:** Svelte-scoped styles stop applying when markup moves. Move each selector with its owned markup and preserve class/custom-property names.
- **Modal behavior drift:** move `modalFocus`, roles, labels, Escape handling, and test IDs together with completion markup.
- **Prop-count pressure:** explicit props are expected here. Do not respond by inventing a controller/view-model abstraction.
- **Accessibility scope creep:** HPA-557 creates the one live-region/callback seam only. HPA-223 owns actual roving focus and broader announcements.

---

### Task 1: Extract `PuzzleBoardPanel` and move viewport-local zoom/pan state

**Files:**
- Create: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Create: `apps/web/src/lib/components/PuzzleBoardPanel.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `Puzzle`, `PlacedPiece[]`, `ResponsivePuzzleBoardMetrics | null`, selected piece ID, hint target, current toolbar capability values, reference-overlay state, image resolver, and route callbacks.
- Produces: a board feature component with local viewport mechanics and a `viewResetVersion: number` input; no canonical gameplay state leaves `PuzzleSession`.

- [ ] **Step 1: Add a focused browser test for the board-panel behavior that will move**

Create `PuzzleBoardPanel.test.ts` with a two-piece puzzle fixture and explicit callback spies. The first tests should fail because `PuzzleBoardPanel.svelte` does not exist yet.

Use this shape:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoardPanel from './PuzzleBoardPanel.svelte';
import type { Puzzle } from '$lib/types/puzzle';

const puzzle: Puzzle = {
  id: 'panel-test',
  name: 'Panel Test',
  pieceCount: 2,
  gridCols: 2,
  gridRows: 1,
  imageWidth: 200,
  imageHeight: 100,
  createdAt: 1704067200000,
  hasReference: true,
  pieces: [
    {
      id: 0,
      puzzleId: 'panel-test',
      correctX: 0,
      correctY: 0,
      imagePath: 'pieces/0.png',
      edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
    },
    {
      id: 1,
      puzzleId: 'panel-test',
      correctX: 1,
      correctY: 0,
      imagePath: 'pieces/1.png',
      edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' }
    }
  ]
};

function props() {
  return {
    puzzle,
    boardMetrics: null,
    placedPieces: [],
    selectedPieceId: null,
    activeHintTarget: null,
    resolveImage: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    referenceImageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    referenceActive: false,
    canUndo: true,
    canRedo: true,
    canOpenSetup: true,
    canPause: true,
    rotationEnabled: false,
    rotationToggleDisabled: false,
    interactionBlocked: false,
    viewResetVersion: 0,
    onPiecePlaced: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onHint: vi.fn(),
    onReferenceDown: vi.fn(),
    onReferenceUp: vi.fn(),
    onRotationToggle: vi.fn(),
    onPause: vi.fn(),
    onOpenSetup: vi.fn()
  };
}

describe('PuzzleBoardPanel', () => {
  it('forwards toolbar actions without owning gameplay state', async () => {
    const input = props();
    render(PuzzleBoardPanel, input);

    await page.getByLabelText('Undo').click();
    await page.getByLabelText('Redo').click();
    await page.getByLabelText('Hint').click();
    await page.getByLabelText('Rotation mode').click();
    await page.getByLabelText('Pause mission').click();
    await page.getByLabelText('Open mission setup').click();

    expect(input.onUndo).toHaveBeenCalledTimes(1);
    expect(input.onRedo).toHaveBeenCalledTimes(1);
    expect(input.onHint).toHaveBeenCalledTimes(1);
    expect(input.onRotationToggle).toHaveBeenCalledTimes(1);
    expect(input.onPause).toHaveBeenCalledTimes(1);
    expect(input.onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it('owns zoom and clears panning on window blur', async () => {
    render(PuzzleBoardPanel, props());

    await page.getByLabelText('Zoom in').click();
    const frame = await page.getByTestId('zoomable-board-frame').element();
    expect(frame.getAttribute('style')).toContain('scale(1.2)');

    const viewport = await page.getByTestId('board-viewport').element();
    viewport.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 7,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 100
      })
    );
    await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);

    window.dispatchEvent(new Event('blur'));
    await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
  });
});
```

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/PuzzleBoardPanel.test.ts
```

Expected: FAIL because `./PuzzleBoardPanel.svelte` does not exist.

- [ ] **Step 3: Create the board panel with explicit props and local viewport state**

Create `PuzzleBoardPanel.svelte`. Import the existing primitives and viewport helpers rather than reimplementing them:

```ts
import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
import PuzzleToolbar from '$lib/components/PuzzleToolbar.svelte';
import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
import ZoomableBoardFrame from '$lib/components/ZoomableBoardFrame.svelte';
import { calculateFitZoom, clampPan, clampZoom } from '$lib/services/gameplay/viewport';
import type { ViewportBounds } from '$lib/services/gameplay/viewport';
import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
import type { PlacedPiece, Puzzle, PuzzlePiece } from '$lib/types/puzzle';

const ZOOM_STEP = 0.2;

type ReferenceHoldEvent = PointerEvent | KeyboardEvent;

interface Props {
  puzzle: Puzzle;
  boardMetrics: ResponsivePuzzleBoardMetrics | null;
  placedPieces: PlacedPiece[];
  selectedPieceId: number | null;
  activeHintTarget: { x: number; y: number } | null;
  resolveImage: (piece: Pick<PuzzlePiece, 'id'>) => string;
  referenceImageUrl: string | null;
  referenceActive: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canOpenSetup: boolean;
  canPause: boolean;
  rotationEnabled: boolean;
  rotationToggleDisabled: boolean;
  interactionBlocked: boolean;
  viewResetVersion: number;
  onPiecePlaced: (pieceId: number, x: number, y: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onHint: () => void;
  onReferenceDown: (event?: ReferenceHoldEvent) => void;
  onReferenceUp: (event?: ReferenceHoldEvent) => void;
  onRotationToggle: () => void;
  onPause: () => void;
  onOpenSetup: () => void;
}
```

Move the current board wrapper/header/toolbar/viewport/canvas markup into this component unchanged. Keep `data-testid="board-viewport"`, the current class names, `PuzzleToolbar`, `ZoomableBoardFrame`, `PuzzleBoard`, and `ReferenceOverlay` wiring.

Move these existing route concepts into the component as local `$state`: viewport element, `zoom`, `minZoom`, `maxZoom`, `panX`, `panY`, `isPanning`, active pan pointer ID, pointer start coordinates, and pan origins.

Move these existing route helpers without changing their algorithms: `getViewportBounds`, `getFitZoom`, `recomputeZoomBounds`, `setView`, `resetViewport`, `handleZoomIn`, `handleZoomOut`, `handleBoardWheel`, panning pointer down/move/up, and panning blur cleanup.

Use Svelte window handlers instead of keeping route registrations for panning:

```svelte
<svelte:window
  onpointermove={handleWindowPointerMove}
  onpointerup={handleWindowPointerUp}
  onpointercancel={handleWindowPointerUp}
  onblur={cancelPan}
/>
```

Use an effect to reset the view when the puzzle identity or reset version changes:

```ts
$effect(() => {
  puzzle.id;
  viewResetVersion;
  if (!boardViewportElement) return;
  resetViewport();
});
```

Use another effect to cancel panning when the route becomes modal/inert:

```ts
$effect(() => {
  if (interactionBlocked) cancelPan();
});
```

Keep the existing `ResizeObserver` behavior inside the component.

Move `.board-panel`, `.panel-header`, `.panel-tag`, `.board-wrap`, and `.board-canvas` selector bodies from the route into this component. Preserve all current values.

- [ ] **Step 4: Replace route board markup with the component**

In `+page.svelte`:

1. import `PuzzleBoardPanel`;
2. replace `pendingViewportReset` with:

```ts
let boardViewResetVersion = $state(0);

function requestBoardViewReset(): void {
  boardViewResetVersion += 1;
}
```

3. replace each existing `pendingViewportReset = true` with `requestBoardViewReset()`;
4. remove route panning/zoom state and helpers moved into the component;
5. remove the route `pointermove` listener and panning branches from `handleWindowPointerUp`, `handleWindowBlur`, and `clearTransientGameplayState`;
6. keep reference-hold pointer-up/blur logic in the route because it dispatches `set_reference_mode` to `PuzzleSession`;
7. replace current board markup with:

```svelte
<PuzzleBoardPanel
  puzzle={currentPuzzle}
  boardMetrics={currentBoardMetrics}
  {placedPieces}
  selectedPieceId={currentSelectedPieceId}
  {activeHintTarget}
  resolveImage={puzzleSource!.resolvePieceImage}
  referenceImageUrl={puzzleSource?.resolveReferenceImage() ?? null}
  referenceActive={showReferenceOverlay}
  {canUndo}
  {canRedo}
  {canOpenSetup}
  {canPause}
  {rotationEnabled}
  rotationToggleDisabled={isRotationToggleLocked()}
  interactionBlocked={hasSessionModal}
  viewResetVersion={boardViewResetVersion}
  onPiecePlaced={handlePiecePlaced}
  onUndo={handleUndo}
  onRedo={handleRedo}
  onHint={handleHint}
  onReferenceDown={handleReferenceDown}
  onReferenceUp={handleReferenceUp}
  onRotationToggle={handleRotationToggle}
  onPause={handleToolbarPause}
  onOpenSetup={() => showMissionSetup(false)}
/>
```

Keep `.game-layout` in the route; it composes board and inventory and owns the two-column responsive relationship.

- [ ] **Step 5: Run board and route tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleBoardPanel.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS. Existing route assertions for responsive board sizing, reference hold, panning cleanup, placement, Undo/Redo, Pause/Setup, and Play Again remain green.

- [ ] **Step 6: Commit the board extraction**

```bash
git add \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleBoardPanel.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle board panel"
```

---

### Task 2: Extract `PuzzleInventoryPanel`

**Files:**
- Create: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Create: `apps/web/src/lib/components/PuzzleInventoryPanel.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: puzzle, tray order, placements, rotations, selection, hint/rejection presentation, piece-size metrics, image resolver, and selection/rotation callbacks.
- Produces: the complete inventory presentation boundary; route no longer maps tray IDs to pieces or renders piece slots.

- [ ] **Step 1: Write focused inventory component tests**

Create `PuzzleInventoryPanel.test.ts` using the same two-piece fixture pattern as Task 1. Test the behavior that moves from the route:

```ts
it('renders unplaced pieces in tray order and reports the remaining count', async () => {
  render(PuzzleInventoryPanel, {
    puzzle,
    boardMetrics: null,
    trayOrder: [1, 0],
    placedPieces: [{ pieceId: 0, x: 0, y: 0, rotation: 0 }],
    rotationEnabled: true,
    pieceRotations: { 0: 0, 1: 90 },
    selectedPieceId: 1,
    activeHintPieceId: 1,
    rejectedPieceId: null,
    resolveImage: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    onRotate: vi.fn(),
    onSelect: vi.fn(),
    onCancelSelection: vi.fn()
  });

  await expect.element(page.getByText('1 LEFT')).toBeVisible();
  expect(document.querySelector('[data-testid="piece-slot-0"]')).toBeNull();
  const slot = document.querySelector('[data-testid="piece-slot-1"]');
  expect(slot).not.toBeNull();
  expect(slot?.className).toContain('hinted');
});
```

Add a second test with both pieces unplaced and `trayOrder: [1, 0]`; assert the DOM order of `[data-testid^="piece-slot-"]` is `piece-slot-1`, then `piece-slot-0`.

- [ ] **Step 2: Run the new inventory test and verify it fails**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/PuzzleInventoryPanel.test.ts
```

Expected: FAIL because `PuzzleInventoryPanel.svelte` does not exist.

- [ ] **Step 3: Create the inventory component and move presentation-derived helpers**

Create `PuzzleInventoryPanel.svelte` with this prop surface:

```ts
import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
import type { Rotation } from '$lib/types/gameplay';
import type { PlacedPiece, Puzzle, PuzzlePiece as PuzzlePieceModel } from '$lib/types/puzzle';

interface Props {
  puzzle: Puzzle;
  boardMetrics: ResponsivePuzzleBoardMetrics | null;
  trayOrder: number[];
  placedPieces: PlacedPiece[];
  rotationEnabled: boolean;
  pieceRotations: Record<number, Rotation>;
  selectedPieceId: number | null;
  activeHintPieceId: number | null;
  rejectedPieceId: number | null;
  resolveImage: (piece: Pick<PuzzlePieceModel, 'id'>) => string;
  onRotate: (pieceId: number) => void;
  onSelect: (pieceId: number) => void;
  onCancelSelection: () => void;
}
```

Move the route's presentation-only piece mapping into derived values:

```ts
const placedPieceIds = $derived.by(
  () => new Set(placedPieces.map((placement) => placement.pieceId))
);

const piecesById = $derived.by(
  () => new Map(puzzle.pieces.map((piece) => [piece.id, piece] as const))
);

const orderedPieces = $derived(
  trayOrder.map((id) => piecesById.get(id)).filter((piece): piece is PuzzlePieceModel => piece !== undefined)
);

function displayedRotation(pieceId: number): Rotation {
  return rotationEnabled ? (pieceRotations[pieceId] ?? 0) : 0;
}
```

Move the current inventory header, piece grid, piece-slot markup, `PuzzlePiece` composition, remaining count, and `ALL PIECES PLACED` message into this component. Preserve `piece-slot-${piece.id}` test IDs and all current hint/rejection classes.

Move `.inventory-panel`, `.panel-header`, `.panel-tag`, `.inv-count`, `.pieces-grid`, `.piece-slot`, `.complete-msg`, and `.complete-icon` selector bodies into the component. Preserve the current media query and CSS custom-property usage.

- [ ] **Step 4: Replace route inventory markup and delete presentation helpers**

In `+page.svelte`, replace the current inventory block with:

```svelte
<PuzzleInventoryPanel
  puzzle={currentPuzzle}
  boardMetrics={currentBoardMetrics}
  trayOrder={sessionState?.trayOrder ?? []}
  {placedPieces}
  {rotationEnabled}
  {pieceRotations}
  selectedPieceId={currentSelectedPieceId}
  {activeHintPieceId}
  rejectedPieceId={rejectedPiece}
  resolveImage={puzzleSource!.resolvePieceImage}
  onRotate={handlePieceRotate}
  onSelect={handleSelectPiece}
  onCancelSelection={handleCancelSelection}
/>
```

Delete route `SvelteMap`, `piecesMap`, `shuffledPieces`, `getDisplayedRotation()`, and `isPiecePlaced()`. Keep `placedPieceIds` only if another route behavior still uses it; otherwise delete it too.

Do not move `activeHintPieceId`, `activeHintTarget`, `rejectedPiece`, their timeouts, or `handleSessionEvent()`: those values originate from `PuzzleSession` events and remain route orchestration.

- [ ] **Step 5: Run inventory and route tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleInventoryPanel.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS with the existing placement/selection/rotation/hint/rejection behavior unchanged.

- [ ] **Step 6: Commit the inventory extraction**

```bash
git add \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle inventory panel"
```

---

### Task 3: Extract `PuzzleCompletionDialog`

**Files:**
- Create: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Create: `apps/web/src/lib/components/PuzzleCompletionDialog.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: plain completion presentation values and action callbacks.
- Produces: one concrete completion-dialog boundary with current modal focus, retry, Timed/Relaxed, Escape, Play Again, and Back behavior.

- [ ] **Step 1: Write completion-dialog tests before moving the modal**

Create `PuzzleCompletionDialog.test.ts` with callback spies.

Timed-mode case:

```ts
it('renders timed completion state and forwards actions', async () => {
  const onRetryServerSubmission = vi.fn();
  const onPlayAgain = vi.fn();
  const onBackToArcade = vi.fn();
  const onDismiss = vi.fn();

  render(PuzzleCompletionDialog, {
    puzzleName: 'Test Mission',
    timed: true,
    elapsedSeconds: 75,
    bestTime: 75,
    isNewBest: true,
    localStatsFailed: false,
    serverSubmissionRetryable: true,
    onRetryServerSubmission,
    onPlayAgain,
    onBackToArcade,
    onDismiss
  });

  await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
  await expect.element(page.getByText('S RANK')).toBeVisible();
  await expect.element(page.getByText('FINAL TIME')).toBeVisible();
  await expect.element(page.getByText('NEW RECORD')).toBeVisible();

  await page.getByTestId('retry-server-submission').click();
  await page.getByRole('button', { name: 'PLAY AGAIN' }).click();
  expect(onRetryServerSubmission).toHaveBeenCalledTimes(1);
  expect(onPlayAgain).toHaveBeenCalledTimes(1);

  const modal = await page.getByTestId('celebration-modal').element();
  modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
```

Relaxed-mode case:

```ts
it('omits timed statistics for Relaxed completions', async () => {
  render(PuzzleCompletionDialog, {
    puzzleName: 'Relaxed Mission',
    timed: false,
    elapsedSeconds: 0,
    bestTime: null,
    isNewBest: false,
    localStatsFailed: false,
    serverSubmissionRetryable: false,
    onRetryServerSubmission: vi.fn(),
    onPlayAgain: vi.fn(),
    onBackToArcade: vi.fn(),
    onDismiss: vi.fn()
  });

  await expect.element(page.getByText('MISSION COMPLETE')).toBeVisible();
  expect(page.getByText('S RANK').query()).toBeNull();
  expect(page.getByText('FINAL TIME').query()).toBeNull();
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
});
```

- [ ] **Step 2: Run the new dialog test and verify it fails**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/PuzzleCompletionDialog.test.ts
```

Expected: FAIL because `PuzzleCompletionDialog.svelte` does not exist.

- [ ] **Step 3: Create the dialog by moving the current completion modal verbatim**

Create `PuzzleCompletionDialog.svelte` with:

```ts
import { modalFocus } from '$lib/actions/modalFocus';
import { formatTime } from '$lib/stores/timer';

interface Props {
  puzzleName: string;
  timed: boolean;
  elapsedSeconds: number;
  bestTime: number | null;
  isNewBest: boolean;
  localStatsFailed: boolean;
  serverSubmissionRetryable: boolean;
  onRetryServerSubmission: () => void;
  onPlayAgain: () => void;
  onBackToArcade: () => void;
  onDismiss: () => void;
}
```

Move the existing `celebration-modal` backdrop/dialog markup and all modal selector bodies from `+page.svelte` into this component. Preserve:

- `data-testid="celebration-modal"`;
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`;
- `use:modalFocus`;
- `S RANK` only when `timed`;
- `FINAL TIME`, `PERSONAL BEST`, `NEW RECORD`, and `UNSAVED` behavior;
- `server-retry-banner` and `retry-server-submission` test IDs;
- `PLAY AGAIN` and `BACK TO ARCADE` labels;
- Escape behavior, now calling `onDismiss()`.

- [ ] **Step 4: Replace the route modal with the component**

In `+page.svelte`, replace the inline modal with:

```svelte
{#if showCelebration}
  <PuzzleCompletionDialog
    puzzleName={puzzle?.name ?? ''}
    timed={showTimedPresentation}
    elapsedSeconds={timerState.elapsed}
    {bestTime}
    {isNewBest}
    {localStatsFailed}
    {serverSubmissionRetryable}
    onRetryServerSubmission={handleRetryServerSubmission}
    onPlayAgain={handlePlayAgain}
    onBackToArcade={requestReturnToArcade}
    onDismiss={() => (showCelebration = false)}
  />
{/if}
```

Remove route imports for `modalFocus` and `formatTime` if no other route code uses them. Do not move `showCelebration`, completion effects, best-time updates, retry policy, `handlePlayAgain`, or navigation/session logic into the dialog.

- [ ] **Step 5: Run dialog and route tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleCompletionDialog.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS, including existing stale-effect, retry, Timed/Relaxed, Escape, Play Again, and local/API-source route coverage.

- [ ] **Step 6: Commit the completion extraction**

```bash
git add \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle completion dialog"
```

---

### Task 4: Lock the composition boundary, add the single live region, and run final regression gates

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: the three extracted components.
- Produces: final HPA-557 boundary: one route-owned `announce(message)` callback/live region passed to every feature component, plus a route containing orchestration and top-level composition rather than board/inventory/completion presentation.

- [ ] **Step 1: Add a route regression for the single live-region boundary**

In `page.svelte.test.ts`, add:

```ts
it('owns exactly one polite gameplay live region', async () => {
  await renderPuzzlePage();

  const liveRegions = document.querySelectorAll('[aria-live="polite"]');
  expect(liveRegions).toHaveLength(1);
  expect(liveRegions[0]?.getAttribute('data-testid')).toBe('gameplay-announcer');
});
```

Run it before implementation:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: FAIL because the route does not yet render `gameplay-announcer`.

- [ ] **Step 2: Add one route-owned announcer and pass the callback to all three panels**

Add to `+page.svelte`:

```ts
let announcement = $state('');

function announce(message: string): void {
  announcement = message;
}
```

Render exactly one region inside the route page, outside the feature panels:

```svelte
<div
  class="sr-only"
  aria-live="polite"
  aria-atomic="true"
  data-testid="gameplay-announcer"
>
  {announcement}
</div>
```

Add this prop to each component interface:

```ts
announce: (message: string) => void;
```

Pass `{announce}` to `PuzzleBoardPanel`, `PuzzleInventoryPanel`, and `PuzzleCompletionDialog`.

HPA-557 does not yet add new announcement calls. Keep the callback explicit for HPA-223. If TypeScript/ESLint flags the destructured prop as unused in a component, keep the intent local and explicit:

```ts
void announce;
```

Do not introduce Svelte context or a shared announcer store to avoid one unused prop.

- [ ] **Step 3: Perform route residue cleanup**

After all three components are present, inspect `+page.svelte` and delete only presentation residue made obsolete by the extraction.

The route should no longer import these primitives directly:

```text
PuzzleBoard
PuzzlePiece
PuzzleToolbar
ZoomableBoardFrame
ReferenceOverlay
modalFocus
SvelteMap
formatTime
```

The route should no longer contain selector blocks for:

```text
.board-panel
.board-wrap
.board-canvas
.inventory-panel
.inv-count
.pieces-grid
.piece-slot
.complete-msg
.complete-icon
.modal-backdrop
.modal-box
.modal-scan-line
.modal-rank
.modal-title
.modal-stats
.modal-stat
.modal-server-retry
.modal-actions
```

`+page.svelte` should retain page/HUD/progress/loading/error styles and `.game-layout` because it still owns top-level composition.

Keep route `handlePiecePlaced`, Hint/Undo/Redo, reference/rotation/selection callbacks, completion-effect handlers, setup/pause/restart/exit orchestration, persistence, and global shortcut logic.

- [ ] **Step 4: Run all focused component and route browser tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleBoardPanel.test.ts \
  src/lib/components/PuzzleInventoryPanel.test.ts \
  src/lib/components/PuzzleCompletionDialog.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS.

- [ ] **Step 5: Run workspace/unit/build regression gates**

From repository root:

```bash
bun run test:unit --filter=@perseus/web
bun run build
```

Expected: PASS.

Run the normal lint gate as well:

```bash
bun run lint
```

Expected: PASS. If a prior local Worker run has left ignored/generated `apps/workflows/.wrangler/tmp` files that make the root lint wrapper complain, do not modify source to accommodate generated artifacts; remove/clean the generated local temp output and rerun lint.

- [ ] **Step 6: Run gameplay smoke E2E**

```bash
cd apps/web
bun run test:e2e:smoke
```

Expected: PASS with current gameplay smoke cases; no new broad E2E scenarios are required because HPA-557 is behavior-preserving.

- [ ] **Step 7: Verify the final diff stays structural**

From repository root:

```bash
git diff --stat main...HEAD
git diff -- 'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte
```

Confirm:

- exactly three new feature components exist;
- no new store/controller/context/event-bus/helper framework exists;
- `PuzzleSession` types/store/engine were not changed merely to support extraction;
- no downstream feature behavior was added;
- route-owned lifecycle/persistence/effect logic is still in the route;
- existing test IDs and visual copy remain unchanged.

- [ ] **Step 8: Commit the final boundary cleanup**

```bash
git add \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: finalize puzzle route composition boundary"
```

## Final acceptance checklist

- [ ] `+page.svelte` primarily composes page/HUD, `PuzzleBoardPanel`, `PuzzleInventoryPanel`, `PuzzleCompletionDialog`, and the existing setup/pause/exit dialogs.
- [ ] `PuzzleSession` remains the only canonical gameplay state owner.
- [ ] Route still owns puzzle load/dispose, session lifecycle, persistence, completion effects, auth retry, and global shortcuts.
- [ ] Board panel owns board markup plus local zoom/pan mechanics.
- [ ] Inventory panel owns tray mapping/filtering and piece presentation.
- [ ] Completion dialog owns completion presentation and modal focus/dismissal behavior.
- [ ] Exactly one route-level polite live region exists and one `announce(message)` callback is passed to all panels.
- [ ] Existing route/component tests pass without weakening behavior assertions.
- [ ] Web unit/check/build gates and gameplay smoke E2E pass.
- [ ] No HPA-217/HPA-219/HPA-220/HPA-222/HPA-223/HPA-224 product behavior is implemented early.