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
- Preserve current behavior, copy, class semantics, ARIA roles, CSS custom-property contracts, event capture semantics, reduced-motion behavior, and existing `data-testid` values.
- Do not implement HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, or HPA-224 product behavior while extracting components.
- Do not add an unused `announce(message)` prop or `aria-live` region; HPA-223 owns those when it implements a real announcement.
- Keep a route-side placed-piece check for `handlePieceRotate()` even though the inventory panel also computes placed IDs for rendering.
- `PuzzleBoardPanel` derives `hasReference` from `puzzle.hasReference === true`; do not add another prop and do not use `PuzzleToolbar`'s default `true` accidentally.
- Duplicate the small board/inventory panel-header styles rather than creating a reusable panel abstraction.
- New component tests live under `apps/web/src/lib/components/__tests__/` and use the `.svelte.test.ts` suffix.
- Treat `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` as a frozen integration fence. Do not edit or stage it by default.
- Each extraction removes its own imports/helpers/selectors in the same commit. Final verification is not a catch-all cleanup commit.
- Every extraction runs warning-strict Svelte checking and web lint before commit.

## Window ownership after Task 1

| Event / signal | Owner | Required behavior |
| --- | --- | --- |
| `pointermove` for pan | `PuzzleBoardPanel` | normal window handler |
| `pointerup` / `pointercancel` for pan | `PuzzleBoardPanel` | capture phase via `onpointerupcapture` / `onpointercancelcapture` |
| `blur` for pan | `PuzzleBoardPanel` | cancel local pan only |
| board viewport `ResizeObserver` | `PuzzleBoardPanel` | reclamp on viewport-box changes |
| `boardMetrics` changes | `PuzzleBoardPanel` | reclamp current zoom/pan; never reset solely because metrics changed |
| `pointerup` / `pointercancel` for reference hold | route | keep current capture-phase listeners |
| `blur` for reference + selection | route | end reference mode and cancel selection only |
| window `resize` | route | update `viewportWidth` / `viewportHeight` only |
| global `keydown` | route | Undo/Redo unchanged |
| `pagehide` / `visibilitychange` | route | persistence/timer behavior unchanged |
| `interactionBlocked` | route → board panel | route-driven pan cancel when gameplay becomes inert |

After the split, `clearTransientGameplayState()` does not touch pan state. A route transition sets `sessionDialog` or `showCelebration`, `hasSessionModal` becomes true, `interactionBlocked` updates, and the board-panel effect runs `cancelPan()`.

## Reduced-motion ownership after all three extractions

The current single `@media (prefers-reduced-motion: reduce)` block must be split with its markup:

- route keeps `.progress-bar-fill`, `.loading-ring`, `.state-label`, `.err-icon`, `.error-panel`, and its `.arcade-btn:hover` override for the route-owned error action;
- inventory gets `.piece-slot.rejected { box-shadow: none; }`;
- completion gets `.modal-scan-line`, `.modal-box`, `.modal-rank`, and its own `.arcade-btn:hover` override.

`.arcade-btn` is globally styled in `routes/layout.css` and is used by both route and completion markup, so the reduced-motion hover override is intentionally duplicated in those two scoped owners.

## Preflight: prove the warning-clean baseline

Before Task 1, run the existing route tests, warning-strict Svelte check, and lint without changing production code:

```bash
cd apps/web
bunx vitest --run --browser=chromium 'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: all commands pass, the Svelte check reports zero warnings, and the route-test diff is empty. If warning-strict checking fails on untouched base code, investigate that baseline separately rather than hiding unrelated warning cleanup in HPA-557.

## Execution Risks

- **Reset-on-resize regression:** an effect that calls `resetViewport()` normally can track `boardMetrics` through helper reads and reset user zoom on resize. Track only reset signals; run the helper under `untrack`.
- **Stale fit after metric-tier changes:** viewport `ResizeObserver` alone does not cover board-size changes. Add a separate `boardMetrics` effect that calls `recomputeZoomBounds()` under `untrack`.
- **Window-event split drift:** panning and reference hold currently share window listeners. Preserve the capture phase on both pan/reference pointer-up/cancel paths.
- **Fake pan tests:** a small board can clamp every translation to zero. Use deliberately oversized test metrics and assert real non-zero translation before testing reset/block behavior.
- **Scoped/reduced-motion CSS drift:** split the shared media block explicitly and run `svelte-check --fail-on-warnings` after each extraction.
- **Modal behavior drift:** preserve backdrop Escape and inner `modalFocus` as one DOM contract; do not “clean up” event ownership during extraction.
- **Route-test drift:** component extraction should not require route-test changes. Treat any route-test diff as a regression signal, not routine refactor churn.
- **Prop-count pressure:** explicit props are expected. Do not invent a controller/view-model abstraction merely to shorten calls.
- **Accessibility scope creep:** HPA-557 creates component boundaries only. HPA-223 owns the live region, roving focus, and actual announcements.

---

### Task 1: Extract `PuzzleBoardPanel` without changing viewport semantics

**Files:**
- Create: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Verify unchanged: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `Puzzle`, `PlacedPiece[]`, `ResponsivePuzzleBoardMetrics | null`, selected piece ID, hint target, toolbar capabilities, reference-overlay state, image resolver, and route callbacks.
- Produces: board feature composition plus local viewport mechanics. `viewResetVersion: number` requests fit/reset; `interactionBlocked: boolean` cancels local pan when route-owned modal state makes gameplay inert.

- [ ] **Step 1: Write failing board-panel browser tests with real pan bounds**

Create `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts` with the complete fixture below:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoardPanel from '../PuzzleBoardPanel.svelte';
import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
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

const largeMetrics: ResponsivePuzzleBoardMetrics = {
  tier: 'extra-large',
  boardWidth: 2400,
  boardHeight: 1200,
  cellSize: 1200,
  pieceSlotSize: 1200
};

const resizedMetrics: ResponsivePuzzleBoardMetrics = {
  tier: 'large',
  boardWidth: 2200,
  boardHeight: 1100,
  cellSize: 1100,
  pieceSlotSize: 1100
};

function props(overrides: Record<string, unknown> = {}) {
  return {
    puzzle,
    boardMetrics: largeMetrics,
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

function transformOf(element: HTMLElement): string {
  return element.getAttribute('style') ?? '';
}

function translateOf(transform: string): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform);
  if (!match) throw new Error(`Missing translate() in ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function scaleOf(transform: string): number {
  const match = /scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`Missing scale() in ${transform}`);
  return Number(match[1]);
}

async function beginRealPan(pointerId: number): Promise<HTMLElement> {
  await page.getByLabelText('Zoom in').click();
  const board = await page.getByTestId('puzzle-board').element();
  const frame = await page.getByTestId('zoomable-board-frame').element();

  board.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId,
      pointerType: 'mouse',
      button: 0,
      clientX: 100,
      clientY: 100
    })
  );
  window.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      clientX: 180,
      clientY: 150
    })
  );

  await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);
  await expect.poll(() => {
    const { x, y } = translateOf(transformOf(frame));
    return Math.abs(x) + Math.abs(y);
  }).toBeGreaterThan(0);

  return frame;
}

describe('PuzzleBoardPanel', () => {
  it('forwards toolbar actions and shows Reference when available', async () => {
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
    await expect.element(page.getByLabelText('Reference')).toBeVisible();
  });

  it('hides Reference when puzzle.hasReference is not true', async () => {
    render(PuzzleBoardPanel, props({ puzzle: { ...puzzle, hasReference: false } }));
    expect(page.getByLabelText('Reference').query()).toBeNull();
  });

  it('starts panning only from the board target, not viewport padding', async () => {
    render(PuzzleBoardPanel, props());
    await page.getByLabelText('Zoom in').click();
    const viewport = await page.getByTestId('board-viewport').element();
    const board = await page.getByTestId('puzzle-board').element();

    viewport.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 11,
        pointerType: 'mouse',
        button: 0,
        clientX: 20,
        clientY: 20
      })
    );
    await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);

    board.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 12,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 100
      })
    );
    await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);
  });

  it('resets real zoom and pan when viewResetVersion changes', async () => {
    const input = props();
    const view = render(PuzzleBoardPanel, input);
    const frame = await page.getByTestId('zoomable-board-frame').element();
    await expect.poll(() => transformOf(frame)).toContain('translate(0px, 0px)');
    const fitTransform = transformOf(frame);

    await beginRealPan(7);
    expect(transformOf(frame)).not.toBe(fitTransform);

    await view.rerender({ ...input, viewResetVersion: 1 });
    await expect.poll(() => transformOf(frame)).toBe(fitTransform);
    expect(translateOf(transformOf(frame))).toEqual({ x: 0, y: 0 });
  });

  it('cancels pan and ignores later pointer moves when interactionBlocked becomes true', async () => {
    const input = props();
    const view = render(PuzzleBoardPanel, input);
    const frame = await beginRealPan(8);

    await view.rerender({ ...input, interactionBlocked: true });
    await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
    const blockedTransform = transformOf(frame);

    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 8,
        pointerType: 'mouse',
        clientX: 260,
        clientY: 220
      })
    );
    await expect.poll(() => transformOf(frame)).toBe(blockedTransform);
  });

  it('reclamps on boardMetrics changes without resetting usable zoom', async () => {
    const input = props();
    const view = render(PuzzleBoardPanel, input);
    const frame = await page.getByTestId('zoomable-board-frame').element();

    await page.getByLabelText('Zoom in').click();
    await expect.poll(() => scaleOf(transformOf(frame))).toBeGreaterThan(0);
    const zoomBeforeResize = scaleOf(transformOf(frame));

    await view.rerender({ ...input, boardMetrics: resizedMetrics });
    await expect.poll(() => scaleOf(transformOf(frame))).toBe(zoomBeforeResize);
  });

  it('ends pan in capture phase even when the target stops bubbling pointerup', async () => {
    render(PuzzleBoardPanel, props());
    await beginRealPan(9);
    const viewport = await page.getByTestId('board-viewport').element();
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
    await beginRealPan(10);
    window.dispatchEvent(new Event('blur'));
    await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
  });
});
```

The oversized metrics are deliberate: the tests must prove non-zero pan before claiming reset/block behavior works.

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser=chromium src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

Expected: FAIL because `../PuzzleBoardPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleBoardPanel.svelte` and separate reset from reclamp triggers**

Use this explicit interface and reuse the existing primitives/helpers:

```ts
import { untrack } from 'svelte';
import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
import PuzzleToolbar from '$lib/components/PuzzleToolbar.svelte';
import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
import ZoomableBoardFrame from '$lib/components/ZoomableBoardFrame.svelte';
import { calculateFitZoom, clampPan, clampZoom } from '$lib/services/gameplay/viewport';
import type { ViewportBounds } from '$lib/services/gameplay/viewport';
import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
import type { PlacedPiece, Puzzle, PuzzlePiece } from '$lib/types/puzzle';

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

Move the existing route viewport state and helper bodies into the component. Preserve capture-phase pan termination:

```svelte
<svelte:window
  onpointermove={handleWindowPointerMove}
  onpointerupcapture={handleWindowPointerUp}
  onpointercancelcapture={handleWindowPointerUp}
  onblur={cancelPan}
/>
```

Use separate effects. Track `boardViewportElement` availability outside `untrack`, but do not let helper internals become dependencies:

```ts
$effect(() => {
  puzzle.id;
  viewResetVersion;
  const viewport = boardViewportElement;
  if (!viewport) return;
  untrack(() => resetViewport());
});

$effect(() => {
  boardMetrics;
  const viewport = boardViewportElement;
  if (!viewport) return;
  untrack(() => recomputeZoomBounds());
});

$effect(() => {
  const viewport = boardViewportElement;
  if (!viewport) return;
  const observer = new ResizeObserver(() => recomputeZoomBounds());
  observer.observe(viewport);
  return () => observer.disconnect();
});

$effect(() => {
  if (interactionBlocked) cancelPan();
});
```

The first effect resets only for puzzle/reset signals or viewport binding. The second replaces today's route resize-path recompute when responsive `boardMetrics` change. The observer handles actual viewport-box changes.

Compose the existing primitives and derive reference availability from the puzzle:

```svelte
<PuzzleToolbar
  onUndo={onUndo}
  onRedo={onRedo}
  onHint={onHint}
  onReferenceDown={onReferenceDown}
  onReferenceUp={onReferenceUp}
  onZoomIn={handleZoomIn}
  onZoomOut={handleZoomOut}
  onResetView={resetViewport}
  onRotationToggle={onRotationToggle}
  onPause={onPause}
  onOpenSetup={onOpenSetup}
  {canOpenSetup}
  {canPause}
  {canUndo}
  {canRedo}
  {rotationEnabled}
  {rotationToggleDisabled}
  hasReference={puzzle.hasReference === true}
/>
```

Keep `ReferenceOverlay` fixed full-screen. Move board-owned selectors into the panel. Copy `.panel-header` / `.panel-tag` for the board while inline inventory still needs the route copy.

- [ ] **Step 4: Replace route board markup and make route resize metrics-only**

Replace `pendingViewportReset` with:

```ts
let boardViewResetVersion = $state(0);

function requestBoardViewReset(): void {
  boardViewResetVersion += 1;
}
```

Replace every current `pendingViewportReset = true` with `requestBoardViewReset()` and delete the route effect that waits for `boardViewportElement`.

Delete route board viewport/zoom/pan state, viewport helper functions, pan pointer-move listener, and panning branches from route pointer-up/blur/`clearTransientGameplayState()`.

Keep capture-phase route `pointerup`/`pointercancel` because reference hold still uses them. Keep route resize metrics-only:

```ts
function handleWindowResize() {
  viewportWidth = window.innerWidth;
  viewportHeight = window.innerHeight;
}
```

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

Keep `.game-layout` in the route. Remove board-only imports and selectors in this task.

- [ ] **Step 5: Run Task 1 regression, warning, lint, and frozen-route-test gates**

```bash
cd apps/web
bunx vitest --run --browser=chromium \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: component + route tests pass, Svelte reports zero warnings, lint passes, and the route test is unchanged.

- [ ] **Step 6: Commit Task 1 without staging the route test**

```bash
git add \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'
git commit -m "refactor: extract puzzle board panel"
```

---

### Task 2: Extract `PuzzleInventoryPanel` and split inventory reduced-motion CSS

**Files:**
- Create: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Verify unchanged: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: puzzle, tray order, placements, rotations, selection, hint/rejection presentation, board metrics, image resolver, and selection/rotation callbacks.
- Produces: complete inventory presentation. The route no longer maps tray IDs to pieces or renders piece slots, but it retains `placedPieceIds`/`isPiecePlaced()` for `handlePieceRotate()`.

Preserve the existing inventory class precedence: when a piece is both hinted and rejected, the
`hinted` presentation wins and the `rejected` class is omitted. A rejected piece receives the
`rejected` presentation when no active hint applies.

- [ ] **Step 1: Write failing inventory component tests with their own fixture**

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

function baseProps() {
  return {
    puzzle,
    boardMetrics: null,
    trayOrder: [1, 0],
    placedPieces: [],
    rotationEnabled: true,
    pieceRotations: { 0: 0 as const, 1: 90 as const },
    selectedPieceId: null,
    activeHintPieceId: null,
    rejectedPieceId: null,
    resolveImage: () => image,
    onRotate: vi.fn(),
    onSelect: vi.fn(),
    onCancelSelection: vi.fn()
  };
}

describe('PuzzleInventoryPanel', () => {
  it('filters placed pieces and preserves hinted precedence', async () => {
    render(PuzzleInventoryPanel, {
      ...baseProps(),
      placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
      selectedPieceId: 1,
      activeHintPieceId: 1,
      rejectedPieceId: 1
    });

    await expect.element(page.getByText('1 LEFT')).toBeVisible();
    expect(document.querySelector('[data-testid="piece-slot-0"]')).toBeNull();
    const slot = document.querySelector('[data-testid="piece-slot-1"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain('hinted');
    expect(slot?.className).not.toContain('rejected');
  });

  it('preserves rejected presentation when no hint is active', async () => {
    render(PuzzleInventoryPanel, {
      ...baseProps(),
      placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
      rejectedPieceId: 1
    });

    const slot = document.querySelector('[data-testid="piece-slot-1"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain('rejected');
    expect(slot?.className).not.toContain('hinted');
  });

  it('renders unplaced pieces in tray order', async () => {
    render(PuzzleInventoryPanel, baseProps());
    const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]'));
    expect(slots.map((slot) => slot.dataset.testid)).toEqual(['piece-slot-1', 'piece-slot-0']);
  });

  it('forwards select, rotate, and cancel selection', async () => {
    const input = baseProps();
    const view = render(PuzzleInventoryPanel, input);

    const piece = await page.getByLabelText('Puzzle piece 1').element();
    piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.onSelect).toHaveBeenCalledWith(1);

    await page.getByLabelText('Rotate piece 1').click();
    expect(input.onRotate).toHaveBeenCalledWith(1);

    await view.rerender({ ...input, selectedPieceId: 1 });
    const selectedPiece = await page.getByLabelText('Puzzle piece 1').element();
    selectedPiece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.onCancelSelection).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser=chromium src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because `../PuzzleInventoryPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleInventoryPanel.svelte` and move inventory CSS**

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
}
```

Use panel-local presentation derivations:

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

Move inventory markup and its normal responsive selectors. Move this reduced-motion rule too:

```css
@media (prefers-reduced-motion: reduce) {
  .piece-slot.rejected {
    box-shadow: none;
  }
}
```

Remove only the inventory rule from the route media block.

- [ ] **Step 4: Replace route inventory markup but retain route rotation safety**

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

Delete route `SvelteMap`, `piecesMap`, `shuffledPieces`, `getDisplayedRotation()`, `PuzzlePiece` import, and inventory-owned selectors.

Keep route rotation safety exactly:

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

- [ ] **Step 5: Run Task 2 regression, warning, lint, and frozen-route-test gates**

```bash
cd apps/web
bunx vitest --run --browser=chromium \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: component + route tests pass, Svelte reports zero warnings, lint passes, and the route test is unchanged.

- [ ] **Step 6: Commit Task 2 without staging the route test**

```bash
git add \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'
git commit -m "refactor: extract puzzle inventory panel"
```

---

### Task 3: Extract `PuzzleCompletionDialog` and split completion reduced-motion CSS

**Files:**
- Create: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Verify unchanged: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: plain completion presentation values and route action callbacks.
- Produces: one completion-dialog boundary preserving the existing backdrop Escape handler, inner `modalFocus`, Timed/Relaxed presentation, retry, Play Again, and Back behavior.

- [ ] **Step 1: Write failing completion-dialog tests with their own props helper**

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
    render(PuzzleCompletionDialog, { ...timedProps(), localStatsFailed: true });
    await expect.element(page.getByTestId('new-best-unsaved')).toBeVisible();
    expect(page.getByText('NEW RECORD').query()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser=chromium src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: FAIL because `../PuzzleCompletionDialog.svelte` does not exist.

- [ ] **Step 3: Create the dialog by moving current DOM/CSS as-is**

Use this explicit interface:

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

Keep Escape on the backdrop and `use:modalFocus` on the inner dialog:

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
    <!-- Copy the existing completion contents verbatim, replacing route state references with these props. -->
  </div>
</div>
```

Move completion selectors and this reduced-motion subset into the dialog:

```css
@media (prefers-reduced-motion: reduce) {
  .modal-scan-line,
  .modal-box,
  .modal-rank {
    animation: none;
  }

  .arcade-btn:hover {
    box-shadow: none;
    text-shadow: none;
  }
}
```

The route keeps its own `.arcade-btn:hover` reduced-motion override because the route error surface still renders `RETURN TO ARCADE` with the global `.arcade-btn` class.

- [ ] **Step 4: Replace route completion markup and remove completion residue now**

Replace the celebration block with:

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

Remove route `modalFocus`, completion-only `formatTime`, completion selectors, and only the completion-owned reduced-motion rules. Keep route loading/error reduced-motion rules intact.

- [ ] **Step 5: Run Task 3 regression, warning, lint, and frozen-route-test gates**

```bash
cd apps/web
bunx vitest --run --browser=chromium \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: component + route tests pass, Svelte reports zero warnings, lint passes, and the route test is unchanged.

- [ ] **Step 6: Commit Task 3 without staging the route test**

```bash
git add \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
  apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'
git commit -m "refactor: extract puzzle completion dialog"
```

---

## Final verification — no cleanup commit

The three extraction commits should already contain all owned cleanup. If this pass finds residue, amend/fix the extraction task that owns it rather than creating a generic fourth cleanup commit.

- [ ] **Verify route/component ownership inventory**

```bash
rg -n \
  'import PuzzleBoard from|import PuzzlePiece from|import PuzzleToolbar from|import ZoomableBoardFrame from|import ReferenceOverlay from|modalFocus|SvelteMap|formatTime' \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'

rg -n \
  'boardViewportElement|minZoom|maxZoom|panX|panY|isPanning|activePanPointerId|handleWindowPointerMove|recomputeZoomBounds|resetViewport' \
  'apps/web/src/routes/puzzle/[id]/+page.svelte'

rg -n \
  'announce|gameplay-announcer|aria-live' \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte
```

Expected: no matches.

Confirm manually that:

- route resize updates only viewport dimensions;
- route reference pointer-up/cancel remains capture-phase;
- route rotation still rejects placed pieces;
- board toolbar reference availability uses `puzzle.hasReference === true`;
- board reset and metrics effects use `untrack` as specified;
- route/inventory/completion each retain their correct reduced-motion subset.

- [ ] **Prove the route integration test never changed**

```bash
git diff --exit-code main...HEAD -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: exit 0.

- [ ] **Run focused component + route browser tests**

```bash
cd apps/web
bunx vitest --run --browser=chromium \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Run web-scoped unit, warning-strict check, lint, and build gates**

```bash
cd ../..
bun run test:unit --filter=@perseus/web
cd apps/web
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
bun run build
```

Expected: PASS with zero warnings. A full root `bun run build` is optional unless implementation unexpectedly touches shared packages.

- [ ] **Run gameplay smoke E2E**

```bash
bun run test:e2e:smoke
```

Expected: PASS. No new broad E2E matrix is required because HPA-557 preserves behavior.

- [ ] **Verify the final diff is structural and clean**

```bash
cd ../..
git diff --check
git diff --stat main...HEAD
git diff -- \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/PuzzleCompletionDialog.svelte
```

Confirm:

- exactly three new feature components exist;
- new component tests use `apps/web/src/lib/components/__tests__/*.svelte.test.ts`;
- no new gameplay state/framework layer exists;
- no HPA-223 live-region seam or downstream feature behavior was added;
- board metrics reclamp without becoming a reset trigger;
- reference availability is preserved;
- reduced-motion rules are split correctly;
- completion Escape/focus/test-ID contract is unchanged;
- route integration tests are unchanged.

## Final acceptance checklist

- [ ] `+page.svelte` primarily composes page/HUD, `PuzzleBoardPanel`, `PuzzleInventoryPanel`, `PuzzleCompletionDialog`, and the existing setup/pause/exit dialogs.
- [ ] `PuzzleSession` remains the only canonical gameplay state owner.
- [ ] Route still owns puzzle loading/disposal, session lifecycle, persistence, completion effects, auth retry, reference-hold semantics, responsive metrics, placed-piece rotation guard, and global shortcuts.
- [ ] Board panel owns board markup plus local zoom/pan mechanics and capture-phase pan pointer-up/cancel handling.
- [ ] Reset-to-fit reacts only to puzzle/reset triggers; `boardMetrics` changes reclamp without resetting usable zoom.
- [ ] Inventory panel owns tray mapping/filtering and piece presentation.
- [ ] Completion dialog owns completion presentation while preserving backdrop Escape + inner `modalFocus` behavior.
- [ ] `PuzzleBoardPanel` derives reference availability from the puzzle and hides the action when no reference exists.
- [ ] Reduced-motion behavior survives the CSS split across route, inventory, and completion.
- [ ] No unused `announce` prop or route live region is introduced; HPA-223 remains deferred.
- [ ] Each extraction commit removes its own presentation residue.
- [ ] `page.svelte.test.ts` remains unchanged.
- [ ] Focused tests prove real pan/reset/block behavior, not only class toggles.
- [ ] Warning-strict Svelte checks and per-task lint pass.
- [ ] Web unit/build gates and gameplay smoke E2E pass.
- [ ] No HPA-217/HPA-219/HPA-220/HPA-222/HPA-223/HPA-224 product behavior is implemented early.
