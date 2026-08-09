# HPA-557: Split the Puzzle Route into Concrete Feature Components — Design

**Linear:** HPA-557  
**Status:** Design for implementation  
**Date:** 2026-08-09

## Context

`apps/web/src/routes/puzzle/[id]/+page.svelte` is the orchestration point for a puzzle run and also contains most of the gameplay presentation. After HPA-556 removed pre-release compatibility, the route still owns:

- puzzle-source loading and disposal;
- `PuzzleSession` construction, subscription, persistence checkpoints, lifecycle changes, completion effects, and authentication retry;
- global undo/redo shortcuts and route-level page/visibility handling;
- board toolbar composition, reference overlay, board viewport markup, zoom/pan state and pointer handling;
- inventory ordering, piece markup, hint/rejection presentation, rotation and selection wiring;
- completion modal markup, retry presentation, best-time presentation, and modal CSS;
- setup, pause, and exit dialog composition;
- page, HUD, board, inventory, modal, and responsive-layout CSS.

The route already composes focused primitives such as `PuzzleToolbar`, `PuzzleBoard`, `ZoomableBoardFrame`, `ReferenceOverlay`, `GameTimer`, `PuzzlePiece`, `MissionSetupDialog`, `SessionPauseDialog`, and `ExitSessionDialog`. The problem is therefore not missing abstractions; it is that the surrounding feature-level composition still lives in one route file.

HPA-556 is now merged in PR #49, and HPA-563 is complete. HPA-557 is therefore unblocked. It is a useful dependency because HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, and HPA-224 all need a stable feature-level place to extend gameplay UI without returning every change to the route.

## Goals

1. Make `+page.svelte` primarily a gameplay composition/orchestration root.
2. Extract exactly three feature-level components:
   - `PuzzleBoardPanel.svelte`
   - `PuzzleInventoryPanel.svelte`
   - `PuzzleCompletionDialog.svelte`
3. Keep `PuzzleSession` as the only canonical gameplay state owner.
4. Keep source loading, persistence, lifecycle coordination, completion effects, auth retry, and global keyboard shortcuts in the route.
5. Move markup and CSS to the component that visually owns it.
6. Move zoom/pan mechanics into the board panel because they are strictly viewport-local presentation state, while keeping session-changing callbacks in the route.
7. Establish the HPA-223 accessibility boundary now: one route-owned polite live region and one `announce(message)` callback passed to panels, without implementing the broader accessibility ticket.
8. Preserve current behavior, DOM test IDs, and gameplay semantics.

## Non-goals

- no new gameplay controller, store, state machine, event bus, context layer, dependency-injection layer, or generic panel system;
- no redesign of the board, toolbar, inventory, completion modal, setup/pause/exit dialogs, or responsive breakpoints;
- no new persistence or completion behavior;
- no inventory filters/shuffle, mobile drawer, persistent reference mode, responsive-toolbar redesign, S-rank replacement, or roving-focus implementation from downstream tickets;
- no extraction of tiny one-use helpers solely to reduce route line count;
- no generic `Panel`, `GameplayDialog`, or callback-bus abstraction;
- no backward-compatibility work.

## Options considered

### Option A — Three concrete feature wrappers with explicit props/callbacks (recommended)

Extract board, inventory, and completion presentation into the exact components named by the ticket. Keep gameplay/session orchestration in the route. Let the board panel own only its local viewport mechanics; pass every action that mutates `PuzzleSession` or route lifecycle back through explicit callbacks.

**Pros**

- directly matches the six downstream tickets' expected extension points;
- removes the largest markup/CSS collision zones without inventing architecture;
- preserves `PuzzleSession` and the route's proven lifecycle/effect code;
- gives zoom/pan a natural local owner without making it domain state;
- easy to review because each extraction has a clear before/after boundary.

**Cons**

- the panel prop lists are intentionally explicit and somewhat long;
- a small amount of visual panel-header CSS is duplicated between board and inventory rather than generalized.

### Option B — Add one `PuzzleGameplayShell` that owns board, inventory, and completion

Move most gameplay UI under one large feature component and leave the route responsible only for loading/session setup.

**Rejected:** this simply moves the monolith one directory deeper. It also creates pressure to move lifecycle/completion state into the shell or introduce a controller/store to avoid a very large shell API.

### Option C — Extract only board and inventory; leave completion inline

This reduces route size faster and avoids a third component in the first pass.

**Rejected:** HPA-224 is explicitly waiting for a completion component, and the existing modal already follows a concrete dialog pattern. Leaving it inline would preserve one of the major collision zones and immediately require another structural ticket.

## Decision

Use **Option A**.

The extraction is structural, not architectural. The route remains the place where gameplay state changes are coordinated. Components own presentation and presentation-local state only.

## Ownership model

### Route: `apps/web/src/routes/puzzle/[id]/+page.svelte`

The route continues to own:

- puzzle ID resolution, source loading, source cleanup, error/loading state;
- `PuzzleSessionStore` construction/subscription/disposal;
- session persistence and final/periodic checkpoints;
- completion local-stat and server-submission effects;
- authentication-transition retry;
- session setup/pause/restart/exit orchestration;
- global Undo/Redo shortcuts;
- document visibility/page-hide persistence behavior;
- route-level reference-hold session semantics and selection cancellation on window blur;
- session-event presentation values that originate from the engine (`rejectedPiece`, `activeHintPieceId`, `activeHintTarget`) and their existing timeout lifecycle;
- responsive board metrics shared by board and inventory;
- the top-level page/HUD/progress/loading/error layout;
- the two-column `game-layout` composition;
- exactly one polite live region plus `announce(message)`.

The route must not gain a wrapper object that groups all props. Explicit component props are preferable to a new view-model/controller abstraction.

### `PuzzleBoardPanel.svelte`

The board panel owns:

- the `PUZZLE BOARD` panel wrapper and header;
- `PuzzleToolbar` composition;
- `ReferenceOverlay` composition;
- board viewport and canvas markup;
- `ZoomableBoardFrame` and `PuzzleBoard` composition;
- board panel CSS;
- local zoom, min/max zoom, pan offsets, panning state, pointer origin, viewport element, and its `ResizeObserver`;
- board-local window pointer move/up/cancel and blur cleanup;
- recalculating/clamping zoom and pan when the viewport or board metrics change.

The board panel does **not** dispatch to `PuzzleSession` directly. It receives callbacks for Undo, Redo, Hint, reference hold, placement, rotation mode, Pause, and Setup. It receives current session-derived values as props.

The route supplies a monotonically increasing `viewResetVersion: number`. The panel resets to fit-to-view when the puzzle changes or when `viewResetVersion` changes. This replaces route-owned `pendingViewportReset` without introducing an imperative component API.

The route also supplies `interactionBlocked: boolean`. When a session/completion modal opens, the board panel cancels any in-progress pan locally. This keeps `clearTransientGameplayState()` from needing a component ref or shared panning state.

### `PuzzleInventoryPanel.svelte`

The inventory panel owns:

- the `INVENTORY` panel wrapper, remaining-count display, piece grid, and complete message;
- mapping `trayOrder` to puzzle pieces;
- filtering already placed pieces;
- display rotation lookup for inventory pieces;
- `PuzzlePiece` composition;
- inventory panel CSS and hint/rejection visual classes.

The inventory panel does **not** own canonical selection, rotations, tray order, hints, or placement state. Those remain `PuzzleSession`/route values passed as props. It receives `onRotate`, `onSelect`, and `onCancelSelection` callbacks.

No generic collection/panel component is introduced. The few repeated panel-header styles are duplicated intentionally; generalizing two wrappers would be more abstraction than the project currently needs.

### `PuzzleCompletionDialog.svelte`

The completion dialog owns:

- the existing `celebration-modal` dialog/backdrop markup;
- `modalFocus` usage;
- timed versus Relaxed completion presentation;
- final-time/personal-best/new-record/unsaved presentation;
- retry banner and action buttons;
- Escape-to-dismiss handling;
- all completion-modal CSS.

It receives plain presentation values and callbacks from the route. It does not own completion effects, retry policy, local-stat writes, or session restart/navigation logic.

`formatTime` moves with the completion presentation and may be imported by the component directly. The route should not format display strings for it.

## Proposed component interfaces

Exact prop names may be adjusted mechanically during implementation if Svelte typing requires it, but ownership must stay as follows.

### Board panel

```ts
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
  onReferenceDown: (event?: PointerEvent | KeyboardEvent) => void;
  onReferenceUp: (event?: PointerEvent | KeyboardEvent) => void;
  onRotationToggle: () => void;
  onPause: () => void;
  onOpenSetup: () => void;
  announce: (message: string) => void;
}
```

### Inventory panel

```ts
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
  resolveImage: (piece: Pick<PuzzlePiece, 'id'>) => string;
  onRotate: (pieceId: number) => void;
  onSelect: (pieceId: number) => void;
  onCancelSelection: () => void;
  announce: (message: string) => void;
}
```

### Completion dialog

```ts
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

`announce` is a deliberate forward-compatible seam required by HPA-557/HPA-223. HPA-557 does not add the full set of accessibility announcements; the prop is established so HPA-223 can implement panel-local outcomes without pulling UI behavior back into the route. If the prop is otherwise unused during this extraction, the component should keep it explicitly typed and document that it is reserved for HPA-223 rather than inventing a context/event system.

## Live-region boundary

The route renders exactly one region:

```svelte
<div class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
```

and owns:

```ts
let announcement = $state('');

function announce(message: string): void {
  announcement = message;
}
```

No second live region belongs inside a panel or dialog. HPA-223 can later refine repeat-message behavior if needed; HPA-557 only establishes ownership and the callback seam.

## Viewport reset flow

Current route-local `pendingViewportReset` couples session lifecycle to board DOM availability. Replace it with a simple value flow:

1. route owns `boardViewResetVersion` initialized to `0`;
2. successful puzzle load increments it after session construction;
3. restart/reconfigure paths increment it where they currently set `pendingViewportReset = true`;
4. `PuzzleBoardPanel` reacts to puzzle identity and `viewResetVersion` and resets when its viewport element exists;
5. the panel's `ResizeObserver` recomputes bounds after layout changes.

This is not persisted and does not become gameplay state.

## Route cleanup after extraction

Once the three components are wired, remove route-only presentation imports and state/helpers that no longer belong there:

- `modalFocus`, `PuzzleBoard`, `PuzzlePiece`, `PuzzleToolbar`, `ZoomableBoardFrame`, `ReferenceOverlay`, and `SvelteMap` imports;
- board viewport element, zoom/min/max/pan/panning pointer fields, panning helper functions, and pointer-move listener;
- inventory `piecesMap`, `shuffledPieces`, `getDisplayedRotation()`, and `isPiecePlaced()` helpers;
- completion modal markup and modal CSS;
- board/inventory CSS moved to their components.

Keep route helpers that still change domain/session state, including `handlePiecePlaced`, `handleHint`, `handleUndo`, `handleRedo`, `handleReferenceDown`, `handleReferenceUp`, `handleRotationToggle`, `handlePieceRotate`, and selection callbacks.

## Testing strategy

This is a behavior-preserving extraction, so existing route tests remain the main integration fence. Add focused component tests only for behavior that actually moves behind a component boundary.

### Board panel tests

Cover:

- existing board/toolbar test IDs remain present;
- toolbar callbacks are forwarded;
- placement callback is forwarded from `PuzzleBoard`;
- zoom-in changes `ZoomableBoardFrame` transform;
- `viewResetVersion` restores fit/reset pan;
- window blur or `interactionBlocked` cancels the `is-panning` presentation.

### Inventory panel tests

Cover:

- tray order determines rendered piece order;
- placed pieces are omitted and remaining count is correct;
- current selection/rotation state is passed to `PuzzlePiece`;
- hint/rejection classes stay on the expected piece slot;
- select/rotate/cancel callbacks still forward.

### Completion dialog tests

Cover:

- Timed mode renders rank, final time, personal best, new-record/unsaved presentation;
- Relaxed mode omits timed fields;
- retry banner forwards retry action;
- Escape calls `onDismiss`;
- Play Again and Back to Arcade callbacks forward;
- `celebration-modal` and existing test IDs remain unchanged.

### Route regression tests

Run the existing `page.svelte.test.ts` suite unchanged wherever possible. Update test internals only if component extraction changes query timing or module boundaries; do not weaken behavior assertions.

Key existing behavior that must remain covered includes responsive sizing, reference hold, panning cleanup, selection cleanup on blur, timed/Relaxed completion, retry behavior, stale completion-effect protection, Play Again, setup/pause/exit flows, and local versus API puzzle completion semantics.

### E2E

Run the existing gameplay smoke suite after the extraction. HPA-557 adds no new end-to-end behavior, so no broad new E2E matrix is required.

## Risks and mitigations

- **Too many props tempt a controller/view-model abstraction.** Mitigation: accept explicit props/callbacks; this is a composition boundary, not a new state layer.
- **Moving zoom/pan can subtly change pointer cleanup.** Mitigation: add a focused board-panel browser test and keep existing route blur/panning tests as integration coverage.
- **Scoped CSS can change layout when markup moves.** Mitigation: move each selector with its markup, preserve class names/custom-property contracts/test IDs, and run the responsive route test plus gameplay smoke E2E.
- **Completion extraction can accidentally change modal focus or dismissal.** Mitigation: keep `modalFocus`, role/ARIA attributes, `celebration-modal`, and Escape behavior verbatim in the new component; add a focused component test.
- **HPA-223 scope creep.** Mitigation: add one route live region and `announce` prop only. Do not add roving-focus logic, announcement catalogs, accessibility preferences, or a context provider.
- **Generic panel abstraction creep.** Mitigation: duplicate the small board/inventory header styles rather than creating a reusable panel component before there are three real consumers.

## Acceptance mapping

- Route primarily composes feature components: board/inventory/completion markup and CSS leave `+page.svelte`.
- Lifecycle/persistence/completion/auth semantics remain route-owned and unchanged.
- Board/inventory/completion visual changes have one obvious component file.
- `PuzzleSession` remains the sole canonical gameplay state owner; panel-local zoom/pan is ephemeral presentation only.
- One route live region exists; `announce(message)` is passed to panels; future roving focus belongs inside each panel.
- Existing focused/unit/component tests and gameplay smoke pass; new tests cover only moved component behavior.
- HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, and HPA-224 each have a concrete component boundary to extend.

## Implementation boundary

HPA-557 should land as one implementation PR with small reviewable commits. It should not implement any downstream gameplay feature while extracting the route. The success condition is a smaller, easier-to-change composition root—not a new gameplay architecture.