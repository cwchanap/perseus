# HPA-557 Puzzle Route Component Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the puzzle route into a clear orchestration/composition root by extracting board, inventory, and completion presentation into three concrete Svelte components without adding another gameplay state layer.

**Architecture:** `PuzzleSession` remains the only canonical gameplay state owner and `+page.svelte` keeps source loading, persistence, lifecycle, completion effects, auth retry, setup/pause/restart/exit orchestration, and global shortcuts. `PuzzleBoardPanel` owns board markup plus ephemeral zoom/pan mechanics, `PuzzleInventoryPanel` owns tray presentation, and `PuzzleCompletionDialog` owns completion presentation. Components use explicit values/callbacks; the route owns one `aria-live` region and passes `announce(message)` to the feature components for future HPA-223 work.

**Tech Stack:** Svelte 5/SvelteKit, TypeScript, `vitest-browser-svelte`, Vitest browser mode, Playwright, Bun/Turborepo.

## Global Constraints

- Extract exactly `PuzzleBoardPanel.svelte`, `PuzzleInventoryPanel.svelte`, and `PuzzleCompletionDialog.svelte`.
- Keep `PuzzleSession` as the only canonical gameplay state owner.
- Keep source loading/disposal, session construction/subscription, persistence checkpoints, completion effects, auth retry, setup/pause/restart/exit orchestration, and global Undo/Redo shortcuts in `+page.svelte`.
- Components may own presentation-local state only; zoom/pan is presentation-local and belongs to `PuzzleBoardPanel`.
- Do not add a controller, view-model object, store, state machine, event bus, context provider, DI layer, generic panel component, or generic dialog framework.
- Preserve current behavior, copy, class semantics, ARIA roles, CSS custom-property contracts, and existing `data-testid` values.
- Do not implement HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, or HPA-224 product behavior while extracting components.
- Establish exactly one route-owned polite live region and one `announce(message)` callback; do not implement roving focus or an announcement catalog in this ticket.
- Duplicate the small board/inventory panel-header styles rather than creating a reusable panel abstraction.
- Add tests only for behavior that moves behind a component boundary; keep existing route tests as the main integration fence.

## Execution Risks

- **Viewport behavior drift:** zoom/pan changes ownership. Preserve the existing clamp/fit algorithms and add a focused board-panel browser test before removing route state.
- **Scoped CSS drift:** Svelte-scoped styles stop applying when markup moves. Move each selector with its owned markup and preserve class/custom-property names.
- **Modal behavior drift:** move `modalFocus`, roles, labels, Escape handling, and test IDs together with completion markup.
- **Prop-count pressure:** explicit props are expected. Do not invent a controller/view-model abstraction merely to shorten calls.
- **Accessibility scope creep:** HPA-557 creates the live-region/callback seam only. HPA-223 owns actual roving focus and outcome announcements.

---

### Task 1: Extract `PuzzleBoardPanel` and viewport-local state

**Files:**
- Create: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Create: `apps/web/src/lib/components/PuzzleBoardPanel.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `Puzzle`, `PlacedPiece[]`, `ResponsivePuzzleBoardMetrics | null`, selected piece ID, hint target, toolbar capabilities, reference-overlay state, image resolver, and route callbacks.
- Produces: board feature composition plus local viewport mechanics; `viewResetVersion: number` is the only route-to-panel reset signal.

- [ ] **Step 1: Write the failing board-panel browser tests**

Create `PuzzleBoardPanel.test.ts`. Use a two-piece puzzle fixture and explicit callback spies. Cover action forwarding and local zoom/pan cleanup.

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoardPanel from './PuzzleBoardPanel.svelte';
import type { Puzzle } from '$lib/types/puzzle';

const image = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

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
    resolveImage: () => image,
    referenceImageUrl: image,
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
    onOpenSetup: vi.fn(),
    announce: vi.fn()
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

- [ ] **Step 2: Run the new test and verify it fails**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/PuzzleBoardPanel.test.ts
```

Expected: FAIL because `PuzzleBoardPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleBoardPanel.svelte` with explicit props**

Import and reuse the existing components and helpers:

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
  announce: (message: string) => void;
}
```

Destructure all props. `announce` is intentionally present for HPA-223 but unused in this extraction; use `void announce;` if the lint/type configuration requires an explicit read.

Move the current board wrapper/header/toolbar/viewport/canvas markup into the component unchanged. Preserve `data-testid="board-viewport"`, `PuzzleToolbar`, `ZoomableBoardFrame`, `PuzzleBoard`, `ReferenceOverlay`, class names, and CSS custom properties.

Move these current route fields into local `$state`: viewport element, `zoom`, `minZoom`, `maxZoom`, `panX`, `panY`, `isPanning`, active pan pointer ID, pointer start coordinates, and pan origins.

Move these helpers without changing algorithms: `getViewportBounds`, `getFitZoom`, `recomputeZoomBounds`, `setView`, `resetViewport`, `handleZoomIn`, `handleZoomOut`, `handleBoardWheel`, board pointer down, window pointer move/up, and panning blur cleanup.

Use component-owned window handlers:

```svelte
<svelte:window
  onpointermove={handleWindowPointerMove}
  onpointerup={handleWindowPointerUp}
  onpointercancel={handleWindowPointerUp}
  onblur={cancelPan}
/>
```

Reset on puzzle/reset-version change once the viewport exists:

```ts
$effect(() => {
  puzzle.id;
  viewResetVersion;
  if (!boardViewportElement) return;
  resetViewport();
});
```

Cancel panning when the route opens any gameplay modal:

```ts
$effect(() => {
  if (interactionBlocked) cancelPan();
});
```

Keep the existing `ResizeObserver` behavior in the panel. Move `.board-panel`, `.panel-header`, `.panel-tag`, `.board-wrap`, and `.board-canvas` selector bodies with the markup.

- [ ] **Step 4: Replace route board markup with `PuzzleBoardPanel`**

Import the panel and replace `pendingViewportReset` with:

```ts
let boardViewResetVersion = $state(0);

function requestBoardViewReset(): void {
  boardViewResetVersion += 1;
}
```

Replace every existing `pendingViewportReset = true` with `requestBoardViewReset()`.

Remove route zoom/pan state/helpers and the route `pointermove` listener. Remove only panning-specific branches from `handleWindowPointerUp`, `handleWindowBlur`, and `clearTransientGameplayState`. Keep route reference-hold pointer-up/cancel/blur logic because it dispatches `set_reference_mode` to `PuzzleSession`.

Replace board markup with:

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
  {announce}
/>
```

Keep `.game-layout` in the route because it owns board/inventory composition.

- [ ] **Step 5: Run board + route regression tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleBoardPanel.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS. Existing responsive sizing, reference hold, panning cleanup, placement, Undo/Redo, Pause/Setup, and Play Again assertions remain green.

- [ ] **Step 6: Commit Task 1**

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
- Consumes: puzzle, tray order, placements, rotations, selection, hint/rejection presentation, board metrics, image resolver, and selection/rotation callbacks.
- Produces: complete inventory presentation; the route no longer maps tray IDs to pieces or renders piece slots.

- [ ] **Step 1: Write failing inventory component tests**

Create `PuzzleInventoryPanel.test.ts` using the same two-piece fixture pattern as Task 1.

Test filtering/count and hint presentation with a valid `PlacedPiece` shape:

```ts
it('renders unplaced pieces and reports the remaining count', async () => {
  render(PuzzleInventoryPanel, {
    puzzle,
    boardMetrics: null,
    trayOrder: [1, 0],
    placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
    rotationEnabled: true,
    pieceRotations: { 0: 0, 1: 90 },
    selectedPieceId: 1,
    activeHintPieceId: 1,
    rejectedPieceId: null,
    resolveImage: () => image,
    onRotate: vi.fn(),
    onSelect: vi.fn(),
    onCancelSelection: vi.fn(),
    announce: vi.fn()
  });

  await expect.element(page.getByText('1 LEFT')).toBeVisible();
  expect(document.querySelector('[data-testid="piece-slot-0"]')).toBeNull();
  const slot = document.querySelector('[data-testid="piece-slot-1"]');
  expect(slot).not.toBeNull();
  expect(slot?.className).toContain('hinted');
});
```

Add a second case with both pieces unplaced and `trayOrder: [1, 0]`; query `[data-testid^="piece-slot-"]` and assert DOM order is `piece-slot-1`, then `piece-slot-0`.

Add a callback case that clicks/selects/rotates through the rendered `PuzzlePiece` controls using the same labels/test hooks already used by component/route tests; assert `onSelect`, `onRotate`, and `onCancelSelection` forwarding rather than introducing inventory-owned state.

- [ ] **Step 2: Run the new test and verify it fails**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/PuzzleInventoryPanel.test.ts
```

Expected: FAIL because `PuzzleInventoryPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleInventoryPanel.svelte`**

Use this explicit interface:

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
  announce: (message: string) => void;
}
```

Move route presentation-only mapping into derived values:

```ts
const placedPieceIds = $derived.by(
  () => new Set(placedPieces.map((placement) => placement.pieceId))
);

const piecesById = $derived.by(
  () => new Map(puzzle.pieces.map((piece) => [piece.id, piece] as const))
);

const orderedPieces = $derived(
  trayOrder
    .map((id) => piecesById.get(id))
    .filter((piece): piece is PuzzlePieceModel => piece !== undefined)
);

function displayedRotation(pieceId: number): Rotation {
  return rotationEnabled ? (pieceRotations[pieceId] ?? 0) : 0;
}
```

Move the current inventory wrapper/header/grid/slot markup, remaining count, `PuzzlePiece` composition, hint/rejection classes, and `ALL PIECES PLACED` message unchanged. Preserve `piece-slot-${piece.id}` test IDs.

Move `.inventory-panel`, `.panel-header`, `.panel-tag`, `.inv-count`, `.pieces-grid`, `.piece-slot`, `.complete-msg`, `.complete-icon`, and the existing inventory media query with the markup. `announce` remains an explicit future HPA-223 seam; use `void announce;` only if needed to satisfy lint/type rules.

- [ ] **Step 4: Replace route inventory markup and delete presentation helpers**

Replace the inline inventory with:

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
  {announce}
/>
```

Delete `SvelteMap`, `piecesMap`, `shuffledPieces`, `getDisplayedRotation()`, and `isPiecePlaced()` from the route. Delete route `placedPieceIds` too if it has no remaining route consumer.

Keep `activeHintPieceId`, `activeHintTarget`, `rejectedPiece`, their timeouts, and `handleSessionEvent()` in the route because those values originate from `PuzzleSession` events.

- [ ] **Step 5: Run inventory + route regression tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleInventoryPanel.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS with placement, selection, rotation, hint, rejection, and responsive-layout behavior unchanged.

- [ ] **Step 6: Commit Task 2**

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
- Consumes: plain completion presentation values and route action callbacks.
- Produces: one completion-dialog boundary preserving modal focus, Timed/Relaxed presentation, retry, Escape, Play Again, and Back behavior.

- [ ] **Step 1: Write failing completion-dialog tests**

Create `PuzzleCompletionDialog.test.ts`.

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
    onDismiss,
    announce: vi.fn()
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
    onDismiss: vi.fn(),
    announce: vi.fn()
  });

  await expect.element(page.getByText('MISSION COMPLETE')).toBeVisible();
  expect(page.getByText('S RANK').query()).toBeNull();
  expect(page.getByText('FINAL TIME').query()).toBeNull();
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
});
```

Add a separate assertion for `localStatsFailed: true` showing `new-best-unsaved` and suppressing `NEW RECORD`, plus a Back-to-Arcade callback assertion.

- [ ] **Step 2: Run the new test and verify it fails**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/PuzzleCompletionDialog.test.ts
```

Expected: FAIL because `PuzzleCompletionDialog.svelte` does not exist.

- [ ] **Step 3: Create the dialog by moving current completion presentation**

Use this interface:

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
  announce: (message: string) => void;
}
```

Move the existing backdrop/dialog markup and all completion-modal CSS into the component. Preserve:

- `data-testid="celebration-modal"`;
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`;
- `use:modalFocus`;
- `S RANK` only for Timed mode;
- `FINAL TIME`, `PERSONAL BEST`, `NEW RECORD`, and `UNSAVED` rules;
- `server-retry-banner` and `retry-server-submission` test IDs;
- `PLAY AGAIN` and `BACK TO ARCADE` labels;
- Escape behavior, now calling `onDismiss()`.

Do not move completion effects, retry policy, local stats, restart, or navigation into this component. Keep `announce` typed for HPA-223 without adding new announcements now.

- [ ] **Step 4: Replace the route modal**

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
    {announce}
  />
{/if}
```

Remove route `modalFocus` and `formatTime` imports if they have no remaining route consumer. Keep `showCelebration`, completion-effect handlers, best-time updates, retry policy, Play Again, and navigation/session orchestration in the route.

- [ ] **Step 5: Run completion + route regression tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/PuzzleCompletionDialog.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS, including stale-effect, retry, Timed/Relaxed, Escape, Play Again, and local/API-source coverage.

- [ ] **Step 6: Commit Task 3**

```bash
git add \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle completion dialog"
```

---

### Task 4: Lock the composition and accessibility boundary

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: the three extracted components.
- Produces: the final HPA-557 boundary: one route-owned live region/`announce` callback plus a route containing orchestration and top-level composition rather than board/inventory/completion presentation.

- [ ] **Step 1: Add a failing single-live-region regression**

In `page.svelte.test.ts`:

```ts
it('owns exactly one polite gameplay live region', async () => {
  await renderPuzzlePage();

  const liveRegions = document.querySelectorAll('[aria-live="polite"]');
  expect(liveRegions).toHaveLength(1);
  expect(liveRegions[0]?.getAttribute('data-testid')).toBe('gameplay-announcer');
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: FAIL because `gameplay-announcer` does not exist yet.

- [ ] **Step 2: Add the route-owned announcer**

Add:

```ts
let announcement = $state('');

function announce(message: string): void {
  announcement = message;
}
```

Render exactly one live region inside the route page and outside the three feature components:

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

Ensure `{announce}` is passed to `PuzzleBoardPanel`, `PuzzleInventoryPanel`, and `PuzzleCompletionDialog`. Do not render a second live region in any component and do not add actual new announcement behavior in HPA-557.

- [ ] **Step 3: Perform route presentation-residue cleanup**

`+page.svelte` should no longer import these presentation primitives directly:

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

It should no longer contain selector blocks owned by the extracted components, including:

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

Keep page/HUD/progress/loading/error styles and `.game-layout` in the route. Keep all route session/lifecycle/persistence/effect/global-shortcut helpers.

- [ ] **Step 4: Run focused component and route tests**

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

- [ ] **Step 5: Run web/workspace regression gates**

From repository root:

```bash
bun run test:unit --filter=@perseus/web
bun run build
bun run lint
```

Expected: PASS. If an ignored/generated `apps/workflows/.wrangler/tmp` directory from a prior local Worker run interferes with the root lint wrapper, clean that generated temp output and rerun; do not change source to accommodate generated artifacts.

- [ ] **Step 6: Run gameplay smoke E2E**

```bash
cd apps/web
bun run test:e2e:smoke
```

Expected: PASS. No new broad E2E matrix is required because HPA-557 preserves behavior.

- [ ] **Step 7: Verify the final diff remains structural**

From repository root:

```bash
git diff --stat main...HEAD
git diff -- \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte
```

Confirm all of the following:

- exactly three new feature components exist;
- no controller/store/context/event-bus/view-model framework was added;
- `PuzzleSession` engine/store/types were not changed merely to support the extraction;
- no downstream feature behavior was added;
- lifecycle/persistence/completion/auth logic remains in the route;
- existing test IDs and visible copy remain unchanged.

- [ ] **Step 8: Commit Task 4**

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
- [ ] Route still owns puzzle loading/disposal, session lifecycle, persistence, completion effects, auth retry, and global shortcuts.
- [ ] Board panel owns board markup plus local zoom/pan mechanics.
- [ ] Inventory panel owns tray mapping/filtering and piece presentation.
- [ ] Completion dialog owns completion presentation and modal focus/dismissal behavior.
- [ ] Exactly one route-level polite live region exists and `announce(message)` is passed to all three feature components.
- [ ] Existing route/component tests pass without weakening behavior assertions.
- [ ] Web unit/check/build/lint gates and gameplay smoke E2E pass.
- [ ] No HPA-217/HPA-219/HPA-220/HPA-222/HPA-223/HPA-224 product behavior is implemented early.