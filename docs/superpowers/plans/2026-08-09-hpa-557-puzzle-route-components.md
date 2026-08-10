# HPA-557 Puzzle Route Component Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the puzzle route into a clear orchestration/composition root by extracting board, inventory, and completion presentation into three concrete Svelte components without adding another gameplay state layer.

**Architecture:** `PuzzleSession` remains the only canonical gameplay state owner and `+page.svelte` keeps source loading, persistence, lifecycle, completion effects, auth retry, setup/pause/restart/exit orchestration, reference-hold semantics, responsive metrics, and global shortcuts. `PuzzleBoardPanel` owns board markup plus ephemeral zoom/pan mechanics, `PuzzleInventoryPanel` owns tray presentation, and `PuzzleCompletionDialog` owns the current celebration DOM/presentation contract. Components use explicit values/callbacks; HPA-557 does not prebuild the HPA-223 live-region/announcement seam.

**Tech Stack:** Svelte 5/SvelteKit, TypeScript, `vitest-browser-svelte`, Vitest browser mode, Playwright, Bun/Turborepo.

## Global Constraints

- Extract exactly `PuzzleBoardPanel.svelte`, `PuzzleInventoryPanel.svelte`, and `PuzzleCompletionDialog.svelte`.
- Keep `PuzzleSession` as the only canonical gameplay state owner.
- Keep source loading/disposal, session construction/subscription, persistence checkpoints, completion effects, auth retry, setup/pause/restart/exit orchestration, reference-hold session semantics, responsive board metrics, and global Undo/Redo shortcuts in `+page.svelte`.
- Components may own presentation-local state only; zoom/pan is presentation-local and belongs to `PuzzleBoardPanel`.
- Do not add a controller, view-model object, store, state machine, event bus, context provider, DI layer, generic panel component, or generic dialog framework.
- Preserve current behavior, copy, class semantics, ARIA roles, CSS custom-property contracts, event capture semantics, and existing `data-testid` values.
- Do not implement HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, or HPA-224 product behavior while extracting components.
- Do not add an unused `announce(message)` prop or `aria-live` region; HPA-223 owns those when it implements a real announcement.
- Keep a route-side placed-piece check for `handlePieceRotate()` even though the inventory panel also computes placed IDs for rendering.
- Duplicate the small board/inventory panel-header styles rather than creating a reusable panel abstraction.
- New component tests live under `apps/web/src/lib/components/__tests__/` and use the `.svelte.test.ts` suffix.
- Each extraction removes its own imports/helpers/selectors in the same commit. Final verification is not a catch-all cleanup commit.

## Window ownership after Task 1

| Event / signal | Owner | Required behavior |
| --- | --- | --- |
| `pointermove` for pan | `PuzzleBoardPanel` | normal window handler |
| `pointerup` / `pointercancel` for pan | `PuzzleBoardPanel` | capture phase via `onpointerupcapture` / `onpointercancelcapture` |
| `blur` for pan | `PuzzleBoardPanel` | cancel local pan only |
| board viewport `ResizeObserver` | `PuzzleBoardPanel` | fit/clamp zoom and pan |
| `pointerup` / `pointercancel` for reference hold | route | keep current capture-phase listeners |
| `blur` for reference + selection | route | end reference mode and cancel selection only |
| window `resize` | route | update `viewportWidth` / `viewportHeight` only |
| global `keydown` | route | Undo/Redo unchanged |
| `pagehide` / `visibilitychange` | route | persistence/timer behavior unchanged |
| `interactionBlocked` | route → board panel | route-driven pan cancel when gameplay becomes inert |

After the split, `clearTransientGameplayState()` does not touch pan state. A route transition sets `sessionDialog` or `showCelebration`, `hasSessionModal` becomes true, `interactionBlocked` updates, and the board-panel effect runs `cancelPan()`.

## Execution Risks

- **Window-event split drift:** panning and reference hold currently share window listeners. Preserve the ownership table above and the capture phase on both pan/reference pointer-up/cancel paths.
- **Viewport boundary drift:** `viewResetVersion` and `interactionBlocked` are new cross-component contracts. Test both before deleting route pan state.
- **Scoped CSS drift:** Svelte-scoped styles stop applying when markup moves. Move selectors with owned markup in the same extraction commit.
- **Modal behavior drift:** preserve backdrop Escape and inner `modalFocus` as one DOM contract; do not “clean up” event ownership during extraction.
- **Prop-count pressure:** explicit props are expected. Do not invent a controller/view-model abstraction merely to shorten calls.
- **Accessibility scope creep:** HPA-557 creates component boundaries only. HPA-223 owns the live region, roving focus, and actual announcements.

---

### Task 1: Extract `PuzzleBoardPanel` and viewport-local state

**Files:**
- Create: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `Puzzle`, `PlacedPiece[]`, `ResponsivePuzzleBoardMetrics | null`, selected piece ID, hint target, toolbar capabilities, reference-overlay state, image resolver, and route callbacks.
- Produces: board feature composition plus local viewport mechanics. `viewResetVersion: number` requests fit/reset; `interactionBlocked: boolean` cancels local pan when route-owned modal state makes gameplay inert.

- [ ] **Step 1: Write failing board-panel browser tests**

Create `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoardPanel from '../PuzzleBoardPanel.svelte';
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

function props(overrides: Partial<Record<string, unknown>> = {}) {
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
    ...overrides
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

    expect(input.onUndo).toHaveBeenCalledOnce();
    expect(input.onRedo).toHaveBeenCalledOnce();
    expect(input.onHint).toHaveBeenCalledOnce();
    expect(input.onRotationToggle).toHaveBeenCalledOnce();
    expect(input.onPause).toHaveBeenCalledOnce();
    expect(input.onOpenSetup).toHaveBeenCalledOnce();
  });

  it('resets the viewport when viewResetVersion changes', async () => {
    const input = props();
    const view = render(PuzzleBoardPanel, input);
    const frame = await page.getByTestId('zoomable-board-frame').element();

    await expect.poll(() => frame.getAttribute('style')).toContain('translate(0px, 0px)');
    const fitTransform = frame.getAttribute('style');

    await page.getByLabelText('Zoom in').click();
    await expect.poll(() => frame.getAttribute('style')).not.toBe(fitTransform);

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
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 7,
        pointerType: 'mouse',
        clientX: 130,
        clientY: 120
      })
    );

    await view.rerender({ ...input, viewResetVersion: 1 });
    await expect.poll(() => frame.getAttribute('style')).toBe(fitTransform);
  });

  it('cancels panning when interactionBlocked becomes true', async () => {
    const input = props();
    const view = render(PuzzleBoardPanel, input);
    await page.getByLabelText('Zoom in').click();

    const viewport = await page.getByTestId('board-viewport').element();
    viewport.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 8,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 100
      })
    );
    await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);

    await view.rerender({ ...input, interactionBlocked: true });
    await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
  });

  it('ends pan in capture phase even when the target stops bubbling pointerup', async () => {
    render(PuzzleBoardPanel, props());
    await page.getByLabelText('Zoom in').click();

    const viewport = await page.getByTestId('board-viewport').element();
    viewport.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 9,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 100
      })
    );
    await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);

    viewport.addEventListener('pointerup', (event) => event.stopPropagation(), { once: true });
    viewport.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 9,
        pointerType: 'mouse',
        button: 0
      })
    );

    await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
  });

  it('cancels panning on window blur', async () => {
    render(PuzzleBoardPanel, props());
    await page.getByLabelText('Zoom in').click();

    const viewport = await page.getByTestId('board-viewport').element();
    viewport.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 10,
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

The transform test intentionally records the actual initial fit transform; it must not assume the isolated viewport always starts at `scale(1)`.

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

Expected: FAIL because `../PuzzleBoardPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleBoardPanel.svelte` with explicit props and local viewport state**

Start with this interface and the existing primitives/helpers:

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

Move these route fields into local `$state`: `boardViewportElement`, `zoom`, `minZoom`, `maxZoom`, `panX`, `panY`, `isPanning`, `activePanPointerId`, pointer-start coordinates, and pan origins. Move the existing bodies of `getViewportBounds`, `getFitZoom`, `recomputeZoomBounds`, `setView`, `resetViewport`, `handleZoomIn`, `handleZoomOut`, `handleBoardWheel`, `handleBoardPointerDown`, `handleWindowPointerMove`, and pan-specific pointer-up logic.

Use a local cancel helper:

```ts
function cancelPan(): void {
  isPanning = false;
  activePanPointerId = null;
}

function handleWindowPointerUp(event: PointerEvent): void {
  if (activePanPointerId !== event.pointerId) return;
  cancelPan();
}
```

Use Svelte 5 window handlers with capture preserved for pan termination:

```svelte
<svelte:window
  onpointermove={handleWindowPointerMove}
  onpointerupcapture={handleWindowPointerUp}
  onpointercancelcapture={handleWindowPointerUp}
  onblur={cancelPan}
/>
```

Keep the current viewport `ResizeObserver` inside the panel. Reset when puzzle identity or reset version changes:

```ts
$effect(() => {
  puzzle.id;
  viewResetVersion;
  if (!boardViewportElement) return;
  resetViewport();
});

$effect(() => {
  if (interactionBlocked) cancelPan();
});
```

Move the current board wrapper/header/toolbar/viewport/canvas markup into the component. Preserve `data-testid="board-viewport"`, `PuzzleToolbar`, `ZoomableBoardFrame`, `PuzzleBoard`, class names, and CSS custom properties. Move `ReferenceOverlay` into the panel as the same fixed full-screen component; do not wrap or restyle it into a non-fixed board-local overlay.

Move board-owned selectors into the component. Copy `.panel-header` / `.panel-tag` there for the board; the route temporarily retains its copy only because inline inventory still consumes it until Task 2.

- [ ] **Step 4: Replace route board markup and split window ownership exactly**

In `+page.svelte`, import `PuzzleBoardPanel` and replace `pendingViewportReset` with:

```ts
let boardViewResetVersion = $state(0);

function requestBoardViewReset(): void {
  boardViewResetVersion += 1;
}
```

Replace every current `pendingViewportReset = true` with `requestBoardViewReset()` and delete the route effect that waits for `boardViewportElement`.

Delete route board viewport/zoom/pan state, `canPanBoard`, viewport helper functions, `ZOOM_STEP`, board-only viewport imports, and the route `pointermove` listener. Keep the existing capture-phase `pointerup`/`pointercancel` route listeners because reference hold still uses them.

Reduce the route handlers to reference/selection responsibilities:

```ts
function handleWindowPointerUp(event: PointerEvent) {
  if (referenceHoldSource !== 'pointer' || referencePointerId !== event.pointerId) return;

  showReferenceOverlay = false;
  referencePointerId = null;
  referenceHoldSource = null;
  sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
}

function handleWindowBlur() {
  if (referenceHoldSource !== null) {
    sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
  }
  showReferenceOverlay = false;
  referencePointerId = null;
  referenceHoldSource = null;
  sessionStore?.dispatch({ type: 'cancel_selection' });
}

function handleWindowResize() {
  viewportWidth = window.innerWidth;
  viewportHeight = window.innerHeight;
}
```

Remove pan cleanup from `clearTransientGameplayState()`. Modal-driven pan cleanup now happens only through `interactionBlocked={hasSessionModal}` after `sessionDialog` or `showCelebration` changes.

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
/>
```

Keep `.game-layout` in the route because it owns board/inventory composition.

Remove board-only route imports and selectors in this same task. Do not leave them for final cleanup.

- [ ] **Step 5: Run board + route regression tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS. Existing responsive sizing, reference hold, panning/selection blur cleanup, placement, Undo/Redo, Pause/Setup, and Play Again assertions remain green.

- [ ] **Step 6: Commit Task 1**

```bash
git add \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle board panel"
```

---

### Task 2: Extract `PuzzleInventoryPanel` without weakening route rotation guards

**Files:**
- Create: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: puzzle, tray order, placements, rotations, selection, hint/rejection presentation, board metrics, image resolver, and selection/rotation callbacks.
- Produces: complete inventory presentation. The route no longer maps tray IDs to pieces or renders piece slots, but it retains `placedPieceIds`/`isPiecePlaced()` for `handlePieceRotate()`.

- [ ] **Step 1: Write failing inventory component tests**

Create `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleInventoryPanel from '../PuzzleInventoryPanel.svelte';
import type { Puzzle } from '$lib/types/puzzle';

const image = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const puzzle: Puzzle = {
  id: 'inventory-test',
  name: 'Inventory Test',
  pieceCount: 2,
  gridCols: 2,
  gridRows: 1,
  imageWidth: 200,
  imageHeight: 100,
  createdAt: 1704067200000,
  pieces: [
    {
      id: 0,
      puzzleId: 'inventory-test',
      correctX: 0,
      correctY: 0,
      imagePath: 'pieces/0.png',
      edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
    },
    {
      id: 1,
      puzzleId: 'inventory-test',
      correctX: 1,
      correctY: 0,
      imagePath: 'pieces/1.png',
      edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' }
    }
  ]
};

describe('PuzzleInventoryPanel', () => {
  it('filters placed pieces, keeps tray order, and renders hint/rejection state', async () => {
    render(PuzzleInventoryPanel, {
      puzzle,
      boardMetrics: null,
      trayOrder: [1, 0],
      placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
      rotationEnabled: true,
      pieceRotations: { 0: 0, 1: 90 },
      selectedPieceId: 1,
      activeHintPieceId: 1,
      rejectedPieceId: 1,
      resolveImage: () => image,
      onRotate: vi.fn(),
      onSelect: vi.fn(),
      onCancelSelection: vi.fn()
    });

    await expect.element(page.getByText('1 LEFT')).toBeVisible();
    expect(document.querySelector('[data-testid="piece-slot-0"]')).toBeNull();
    const slot = document.querySelector('[data-testid="piece-slot-1"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain('hinted');
    expect(slot?.className).toContain('rejected');
  });

  it('renders unplaced pieces in tray order', async () => {
    render(PuzzleInventoryPanel, {
      puzzle,
      boardMetrics: null,
      trayOrder: [1, 0],
      placedPieces: [],
      rotationEnabled: false,
      pieceRotations: {},
      selectedPieceId: null,
      activeHintPieceId: null,
      rejectedPieceId: null,
      resolveImage: () => image,
      onRotate: vi.fn(),
      onSelect: vi.fn(),
      onCancelSelection: vi.fn()
    });

    const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]'));
    expect(slots.map((slot) => slot.dataset.testid)).toEqual(['piece-slot-1', 'piece-slot-0']);
  });

  it('forwards select, rotate, and cancel selection', async () => {
    const onRotate = vi.fn();
    const onSelect = vi.fn();
    const onCancelSelection = vi.fn();
    const input = {
      puzzle,
      boardMetrics: null,
      trayOrder: [1, 0],
      placedPieces: [],
      rotationEnabled: true,
      pieceRotations: { 1: 90 },
      selectedPieceId: null,
      activeHintPieceId: null,
      rejectedPieceId: null,
      resolveImage: () => image,
      onRotate,
      onSelect,
      onCancelSelection
    };
    const view = render(PuzzleInventoryPanel, input);

    const piece = await page.getByLabelText('Puzzle piece 1').element();
    piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith(1);

    await page.getByLabelText('Rotate piece 1').click();
    expect(onRotate).toHaveBeenCalledWith(1);

    await view.rerender({ ...input, selectedPieceId: 1 });
    const selectedPiece = await page.getByLabelText('Puzzle piece 1').element();
    selectedPiece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCancelSelection).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because `../PuzzleInventoryPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleInventoryPanel.svelte`**

Use this interface and panel-local presentation derivations:

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

Move `.inventory-panel`, `.panel-header`, `.panel-tag`, `.inv-count`, `.pieces-grid`, `.piece-slot`, `.complete-msg`, `.complete-icon`, and the inventory media query into the component.

- [ ] **Step 4: Replace route inventory markup and remove only presentation helpers**

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
/>
```

Delete route `SvelteMap`, `piecesMap`, `shuffledPieces`, and `getDisplayedRotation()`. Remove the route `PuzzlePiece` import and inventory-owned selectors in this same task.

**Keep** the existing route-side set and guard:

```ts
const placedPieceIds = $derived.by(
  () => new Set(placedPieces.map((placement) => placement.pieceId))
);

function isPiecePlaced(pieceId: number): boolean {
  return placedPieceIds.has(pieceId);
}

function handlePieceRotate(pieceId: number) {
  if (!sessionStore || !rotationEnabled || isPiecePlaced(pieceId)) return;
  sessionStore.dispatch({ type: 'rotate_piece', pieceId });
  checkpointSession();
}
```

Keep `activeHintPieceId`, `activeHintTarget`, `rejectedPiece`, their timeouts, and `handleSessionEvent()` in the route because those values originate from `PuzzleSession` events.

- [ ] **Step 5: Run inventory + route regression tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS with placement, selection, rotation, hint, rejection, and responsive-layout behavior unchanged.

- [ ] **Step 6: Commit Task 2**

```bash
git add \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle inventory panel"
```

---

### Task 3: Extract `PuzzleCompletionDialog` with the current DOM/focus/Escape contract intact

**Files:**
- Create: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: plain completion presentation values and route action callbacks.
- Produces: one completion-dialog boundary preserving the existing backdrop Escape handler, inner `modalFocus`, Timed/Relaxed presentation, retry, Play Again, and Back behavior.

- [ ] **Step 1: Write failing completion-dialog tests**

Create `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleCompletionDialog from '../PuzzleCompletionDialog.svelte';

function timedProps() {
  return {
    puzzleName: 'Test Mission',
    timed: true,
    elapsedSeconds: 75,
    bestTime: 75,
    isNewBest: true,
    localStatsFailed: false,
    serverSubmissionRetryable: true,
    onRetryServerSubmission: vi.fn(),
    onPlayAgain: vi.fn(),
    onBackToArcade: vi.fn(),
    onDismiss: vi.fn()
  };
}

describe('PuzzleCompletionDialog', () => {
  it('preserves backdrop Escape, inner dialog focus, and current actions', async () => {
    const input = timedProps();
    render(PuzzleCompletionDialog, input);

    const backdrop = await page.getByTestId('celebration-modal').element();
    const dialog = backdrop.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    await expect.poll(() => dialog?.contains(document.activeElement)).toBe(true);

    await expect.element(page.getByText('S RANK')).toBeVisible();
    await expect.element(page.getByText('FINAL TIME')).toBeVisible();
    await expect.element(page.getByText('NEW RECORD')).toBeVisible();

    await page.getByTestId('retry-server-submission').click();
    await page.getByRole('button', { name: 'PLAY AGAIN' }).click();
    await page.getByRole('button', { name: 'BACK TO ARCADE' }).click();
    expect(input.onRetryServerSubmission).toHaveBeenCalledOnce();
    expect(input.onPlayAgain).toHaveBeenCalledOnce();
    expect(input.onBackToArcade).toHaveBeenCalledOnce();

    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.onDismiss).toHaveBeenCalledOnce();
  });

  it('omits timed statistics for Relaxed completions', async () => {
    render(PuzzleCompletionDialog, {
      ...timedProps(),
      puzzleName: 'Relaxed Mission',
      timed: false,
      elapsedSeconds: 0,
      bestTime: null,
      isNewBest: false,
      serverSubmissionRetryable: false
    });

    await expect.element(page.getByText('MISSION COMPLETE')).toBeVisible();
    expect(page.getByText('S RANK').query()).toBeNull();
    expect(page.getByText('FINAL TIME').query()).toBeNull();
    expect(page.getByText('PERSONAL BEST').query()).toBeNull();
  });

  it('shows UNSAVED instead of NEW RECORD when the local best write failed', async () => {
    render(PuzzleCompletionDialog, {
      ...timedProps(),
      localStatsFailed: true
    });

    await expect.element(page.getByTestId('new-best-unsaved')).toBeVisible();
    expect(page.getByText('NEW RECORD').query()).toBeNull();
  });
});
```

This uses a dedicated test file under the existing `__tests__/*.svelte.test.ts` convention. Keep it separate from `SessionDialogs.svelte.test.ts` because HPA-224 will extend this completion-specific surface.

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: FAIL because `../PuzzleCompletionDialog.svelte` does not exist.

- [ ] **Step 3: Create the dialog by moving the current completion DOM as-is**

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
}
```

Preserve the current node ownership exactly:

```svelte
<div
  class="modal-backdrop"
  data-testid="celebration-modal"
  role="presentation"
  onkeydown={(event) => event.key === 'Escape' && onDismiss()}
>
  <div
    class="modal-box"
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-title"
    use:modalFocus
  >
    <!-- move the existing completion contents here unchanged -->
  </div>
</div>
```

Move the existing Timed/Relaxed fields, retry banner, `PLAY AGAIN` / `BACK TO ARCADE` actions, scan line, and all completion-modal CSS into this component. Preserve all visible copy, current class names, `celebration-modal`, `new-best-unsaved`, `server-retry-banner`, and `retry-server-submission` test IDs.

Do not move completion effects, retry policy, local stats, restart, or navigation into this component.

- [ ] **Step 4: Replace route completion markup and remove its residue now**

Replace the route modal with:

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

Remove route `modalFocus` and completion-only `formatTime` imports. Remove completion-modal selectors from the route in this same task. Keep `showCelebration`, completion-effect handlers, best-time updates, retry policy, Play Again, and navigation/session orchestration in the route.

- [ ] **Step 5: Run completion + route regression tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Expected: PASS, including stale-effect, retry, Timed/Relaxed, Escape, Play Again, and local/API-source coverage.

- [ ] **Step 6: Commit Task 3**

```bash
git add \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
  apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: extract puzzle completion dialog"
```

---

## Final verification — no cleanup commit

The three extraction commits should already contain all owned cleanup. If this pass finds residue, amend/fix the extraction task that owns it rather than creating a generic fourth cleanup commit.

- [ ] **Verify route/component ownership inventory**

From repository root:

```bash
rg -n \
  'import (PuzzleBoard|PuzzlePiece|PuzzleToolbar|ZoomableBoardFrame|ReferenceOverlay)|modalFocus|SvelteMap|formatTime' \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'

rg -n \
  'boardViewportElement|minZoom|maxZoom|panX|panY|isPanning|activePanPointerId|handleWindowPointerMove|recomputeZoomBounds' \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'

rg -n \
  'announce|gameplay-announcer|aria-live' \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte
```

Expected: no matches. `PuzzleBoardPanel`, `PuzzleInventoryPanel`, and `PuzzleCompletionDialog` imports themselves are allowed; the first pattern intentionally targets the old direct primitives.

Confirm manually that route `handleWindowResize()` updates only viewport dimensions, route pointer-up/cancel listeners still use capture for reference hold, and `handlePieceRotate()` still checks placed-piece membership before dispatch.

- [ ] **Run focused component + route browser tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Run web-scoped unit/check/lint/build gates**

From repository root:

```bash
bun run test:unit --filter=@perseus/web
```

Then:

```bash
cd apps/web
bun run check
bun run lint
bun run build
```

Expected: PASS. Do not make HPA-557 depend on unrelated package build failures; a full root `bun run build` is optional unless implementation unexpectedly touches shared packages.

- [ ] **Run gameplay smoke E2E**

```bash
cd apps/web
bun run test:e2e:smoke
```

Expected: PASS. No new broad E2E matrix is required because HPA-557 preserves behavior.

- [ ] **Verify the final diff is structural and clean**

From repository root:

```bash
git diff --check
git diff --stat main...HEAD
git diff -- \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte
```

Confirm all of the following:

- exactly three new feature components exist;
- new component tests use `apps/web/src/lib/components/__tests__/*.svelte.test.ts`;
- no controller/store/context/event-bus/view-model framework was added;
- `PuzzleSession` engine/store/types were not changed merely to support extraction;
- no HPA-223 live region/announcement seam was added early;
- no downstream feature behavior was added;
- lifecycle/persistence/completion/auth/reference/global-shortcut logic remains in the route;
- board panel owns pan/zoom and capture-phase pan termination;
- route retains capture-phase reference termination and the placed-piece rotation guard;
- completion backdrop/inner-dialog Escape/focus contract and existing test IDs/copy remain unchanged.

## Final acceptance checklist

- [ ] `+page.svelte` primarily composes page/HUD, `PuzzleBoardPanel`, `PuzzleInventoryPanel`, `PuzzleCompletionDialog`, and the existing setup/pause/exit dialogs.
- [ ] `PuzzleSession` remains the only canonical gameplay state owner.
- [ ] Route still owns puzzle loading/disposal, session lifecycle, persistence, completion effects, auth retry, reference-hold semantics, responsive metrics, placed-piece rotation guard, and global shortcuts.
- [ ] Board panel owns board markup plus local zoom/pan mechanics and capture-phase pan pointer-up/cancel handling.
- [ ] Inventory panel owns tray mapping/filtering and piece presentation.
- [ ] Completion dialog owns completion presentation while preserving backdrop Escape + inner `modalFocus` behavior.
- [ ] No unused `announce` prop or route live region is introduced; HPA-223 remains deferred.
- [ ] Each extraction commit removes its own presentation residue.
- [ ] Existing route/component tests pass without weakening behavior assertions.
- [ ] Web unit/check/lint/build gates and gameplay smoke E2E pass.
- [ ] No HPA-217/HPA-219/HPA-220/HPA-222/HPA-223/HPA-224 product behavior is implemented early.