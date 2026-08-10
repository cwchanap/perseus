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
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
```

Expected: PASS with zero Svelte warnings. If the warning-strict command fails on untouched base code, stop and confirm the baseline before folding unrelated warning cleanup into HPA-557.

Also confirm the route integration test is untouched before implementation begins:

```bash
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: exit 0.

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

Create `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`:

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

function props(overrides = {}) {
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
  const viewport = await page.getByTestId('board-viewport').element();
  const frame = await page.getByTestId('zoomable-board-frame').element();

  viewport.dispatchEvent(
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
  it('forwards toolbar actions and derives reference availability from the puzzle', async () => {
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
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

Expected: FAIL because `../PuzzleBoardPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleBoardPanel.svelte` and separate reset from reclamp triggers**

Import and reuse the existing primitives and viewport helpers. Import `untrack` from Svelte:

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

Move route viewport fields and the existing helper bodies into the component. Keep the existing algorithms for `getViewportBounds`, `getFitZoom`, `recomputeZoomBounds`, `setView`, `resetViewport`, zoom buttons/wheel, and pointer panning.

Use a local pan cancel helper:

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

Preserve capture for pan termination:

```svelte
<svelte:window
  onpointermove={handleWindowPointerMove}
  onpointerupcapture={handleWindowPointerUp}
  onpointercancelcapture={handleWindowPointerUp}
  onblur={cancelPan}
/>
```

Use three distinct reactive concerns. Track only the intended triggers outside `untrack`:

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

The first effect must **not** track `boardMetrics` through `resetViewport()`. The second effect is the panel-side replacement for today's `handleWindowResize() -> recomputeZoomBounds()` behavior when responsive board metrics change. The observer handles viewport-box changes.

Compose the existing board primitives and pass reference availability explicitly from the puzzle:

```svelte
<ReferenceOverlay imageUrl={referenceImageUrl} active={referenceActive} />

<PuzzleToolbar
  ...
  hasReference={puzzle.hasReference === true}
/>
```

Keep `ReferenceOverlay` fixed full-screen. Move board-owned selectors into the panel. Copy `.panel-header` / `.panel-tag` for the board; the route temporarily retains those selectors for the still-inline inventory.

- [ ] **Step 4: Replace route board markup and make route resize metrics-only**

Replace `pendingViewportReset` with:

```ts
let boardViewResetVersion = $state(0);

function requestBoardViewReset(): void {
  boardViewResetVersion += 1;
}
```

Replace every current `pendingViewportReset = true` with `requestBoardViewReset()` and delete the route effect that waits for `boardViewportElement`.

Delete route board viewport/zoom/pan state, `canPanBoard`, viewport helper functions, `ZOOM_STEP`, board-only viewport imports, and the route `pointermove` listener. Keep capture-phase route `pointerup`/`pointercancel` listeners because reference hold still uses them.

Route handlers reduce to reference/selection/metrics responsibilities:

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

Remove pan fields from `clearTransientGameplayState()`. Modal-driven pan cleanup now happens only through `interactionBlocked={hasSessionModal}`.

Replace board markup with `PuzzleBoardPanel` using the design interface. Keep `.game-layout` in the route.

Remove board-only imports and selectors in this same task.

- [ ] **Step 5: Run Task 1 regression, warning, lint, and frozen-route-test gates**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS, zero Svelte warnings, and zero route-test diff.

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

- [ ] **Step 1: Write failing inventory component tests**

Create `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` using a two-piece puzzle. Cover:

```ts
it('filters placed pieces and preserves hint/rejection presentation', async () => {
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
```

Add the existing keyboard/click forwarding case for select, rotate, and cancel selection using `Puzzle piece 1` and `Rotate piece 1` labels.

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because `../PuzzleInventoryPanel.svelte` does not exist.

- [ ] **Step 3: Create `PuzzleInventoryPanel.svelte`**

Use the design interface and panel-local presentation derivations:

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

Move `.inventory-panel`, `.panel-header`, `.panel-tag`, `.inv-count`, `.pieces-grid`, `.piece-slot`, `.complete-msg`, `.complete-icon`, and the 640–1023px inventory media query into the component.

Also move the inventory part of reduced motion into the component:

```css
@media (prefers-reduced-motion: reduce) {
  .piece-slot.rejected {
    box-shadow: none;
  }
}
```

Remove only that rule from the route's reduced-motion block. Route loading/error and completion rules remain until their owners move.

- [ ] **Step 4: Replace route inventory markup but retain route rotation safety**

Replace inline inventory with `PuzzleInventoryPanel` using the design interface.

Delete route `SvelteMap`, `piecesMap`, `shuffledPieces`, and `getDisplayedRotation()`. Remove the route `PuzzlePiece` import and inventory-owned selectors in this same task.

Keep this route-side safety path:

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

Keep hint/rejection event state and timeout lifecycle in the route.

- [ ] **Step 5: Run Task 2 regression, warning, lint, and frozen-route-test gates**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS, zero warnings, zero route-test diff.

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

- [ ] **Step 1: Write failing completion-dialog tests**

Create `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts` with these cases:

```ts
it('preserves backdrop Escape, inner dialog focus, and current actions', async () => {
  const input = timedProps();
  render(PuzzleCompletionDialog, input);

  const backdrop = await page.getByTestId('celebration-modal').element();
  const dialog = backdrop.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  await expect.poll(() => dialog?.contains(document.activeElement)).toBe(true);

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
```

Keep this as a dedicated `PuzzleCompletionDialog.svelte.test.ts`; HPA-224 will extend this surface later.

- [ ] **Step 2: Run the new test and verify the missing-component failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: FAIL because `../PuzzleCompletionDialog.svelte` does not exist.

- [ ] **Step 3: Create the dialog by moving the current completion DOM as-is**

Use the design interface. Keep current node ownership exactly:

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
    <!-- existing completion contents with route values replaced by props -->
  </div>
</div>
```

Move current completion modal selectors with the markup. Preserve visible copy and test IDs.

Move completion-specific reduced-motion rules into the dialog:

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

The route **keeps its own** `.arcade-btn:hover` reduced-motion rule because `RETURN TO ARCADE` on the route error panel still uses the global `.arcade-btn` class.

Do not move completion effects, retry policy, local stats, restart, or navigation into the component.

- [ ] **Step 4: Replace route completion markup and remove completion residue now**

Replace the celebration block with `PuzzleCompletionDialog` using the design interface.

Remove route `modalFocus` and completion-only `formatTime` imports. Remove completion selectors and only the completion-owned reduced-motion rules from the route. Leave route loading/error reduced-motion rules intact.

- [ ] **Step 5: Run Task 3 regression, warning, lint, and frozen-route-test gates**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
cd ../..
git diff --exit-code -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS, zero warnings, zero route-test diff.

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

From repository root:

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

Confirm manually:

- route `handleWindowResize()` updates only viewport dimensions;
- route pointer-up/cancel listeners still use capture for reference hold;
- `handlePieceRotate()` still checks placed-piece membership;
- `PuzzleBoardPanel` uses `puzzle.hasReference === true` for toolbar reference availability;
- board reset effect uses `untrack(resetViewport)` and the separate metrics effect uses `untrack(recomputeZoomBounds)`;
- route reduced motion still covers route loading/error selectors and error `.arcade-btn:hover`;
- inventory reduced motion owns rejected-piece glow removal;
- completion reduced motion owns modal animations and its button-hover override.

- [ ] **Prove the route integration test never changed**

```bash
git diff --exit-code main...HEAD -- 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: exit 0. Any diff requires explicit review before implementation is considered complete.

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

- [ ] **Run web-scoped unit, warning-strict check, lint, and build gates**

From repository root:

```bash
bun run test:unit --filter=@perseus/web
```

Then:

```bash
cd apps/web
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
bun run build
```

Expected: PASS with zero warnings. A full root `bun run build` is optional unless implementation unexpectedly touches shared packages.

- [ ] **Run gameplay smoke E2E**

```bash
cd apps/web
bun run test:e2e:smoke
```

Expected: PASS. No new broad E2E matrix is required because HPA-557 preserves behavior.

- [ ] **Verify the final diff is structural and clean**

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
- `boardMetrics` reclamps without becoming a reset trigger;
- route retains capture-phase reference termination and the placed-piece rotation guard;
- reference availability still comes from `puzzle.hasReference === true`;
- reduced-motion rules are present in the correct route/inventory/completion owners;
- completion backdrop/inner-dialog Escape/focus contract and existing test IDs/copy remain unchanged;
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