# HPA-557: Split the Puzzle Route into Concrete Feature Components — Design

**Linear:** HPA-557  
**Status:** Design for implementation  
**Date:** 2026-08-09

## Context

`apps/web/src/routes/puzzle/[id]/+page.svelte` is both the gameplay orchestration root and the owner of most puzzle presentation. After HPA-556 removed pre-release compatibility, the route still combines:

- puzzle-source loading and cleanup;
- `PuzzleSession` construction, subscription, persistence, lifecycle, completion effects, and authentication retry;
- global shortcuts and page/visibility handling;
- board toolbar, reference overlay, viewport markup, zoom/pan mechanics, and board composition;
- inventory ordering, piece markup, hint/rejection presentation, rotation, and selection wiring;
- completion modal markup, timing/best-time presentation, retry presentation, and modal CSS;
- setup, pause, and exit dialog composition;
- page, HUD, board, inventory, modal, and responsive-layout CSS.

The route already uses focused primitives such as `PuzzleToolbar`, `PuzzleBoard`, `ZoomableBoardFrame`, `ReferenceOverlay`, `GameTimer`, `PuzzlePiece`, `MissionSetupDialog`, `SessionPauseDialog`, and `ExitSessionDialog`. The problem is not missing infrastructure. The missing boundary is the feature-level composition around those primitives.

HPA-556 is merged in PR #49 and HPA-563 is complete, so HPA-557 is unblocked. HPA-557 is also the structural dependency for HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, and HPA-224.

## Goals

1. Make `+page.svelte` primarily a gameplay orchestration/composition root.
2. Extract exactly three feature-level components:
   - `PuzzleBoardPanel.svelte`
   - `PuzzleInventoryPanel.svelte`
   - `PuzzleCompletionDialog.svelte`
3. Keep `PuzzleSession` as the only canonical gameplay state owner.
4. Keep source loading, persistence, lifecycle coordination, completion effects, auth retry, and global keyboard shortcuts in the route.
5. Move markup and CSS to the component that visually owns it.
6. Move zoom/pan mechanics into the board panel because they are ephemeral viewport presentation, while keeping session-changing callbacks in the route.
7. Establish the HPA-223 boundary now: one route-owned polite live region and one `announce(message)` callback passed to the three feature components.
8. Preserve current behavior, copy, ARIA semantics, CSS contracts, and existing test IDs.

## Non-goals

- no gameplay controller, route store, state machine, event bus, context layer, dependency-injection layer, generic panel system, or view-model wrapper;
- no board, toolbar, inventory, completion, setup/pause/exit, or breakpoint redesign;
- no persistence or completion behavior changes;
- no inventory filters/shuffle, mobile drawer, persistent reference mode, toolbar redesign, S-rank replacement, or roving-focus implementation from downstream tickets;
- no tiny helper extraction solely to reduce line count;
- no generic `Panel` or `GameplayDialog` abstraction;
- no backward-compatibility work.

## Options considered

### Option A — Three concrete feature wrappers with explicit props/callbacks (recommended)

Extract board, inventory, and completion presentation into the exact components named by the ticket. Keep gameplay/session orchestration in the route. Let the board panel own only its viewport-local mechanics; every action that mutates `PuzzleSession` or route lifecycle remains a route callback.

**Pros**

- gives every blocked gameplay ticket an obvious extension point;
- removes the major markup/CSS collision zones without replacement architecture;
- preserves the proven `PuzzleSession` and route lifecycle/effect code;
- gives zoom/pan a natural local owner without making it domain state;
- easy to review because each extraction has a clear boundary.

**Cons**

- prop lists are intentionally explicit and somewhat long;
- board/inventory share a small amount of panel-header styling rather than gaining a generic panel abstraction.

### Option B — Add one `PuzzleGameplayShell`

Move board, inventory, and completion into one large shell and leave only loading/session setup in the route.

**Rejected:** this moves the monolith rather than splitting it, and pressures the code toward a controller/store just to make the shell API manageable.

### Option C — Extract only board and inventory

Leave the completion modal inline for a later ticket.

**Rejected:** HPA-224 is explicitly waiting for a completion boundary, and the modal already matches the existing concrete dialog pattern. Leaving it inline preserves a major collision zone.

## Decision

Use **Option A**.

The change is structural, not architectural. The route coordinates gameplay state changes. Components own presentation and presentation-local state only.

## Ownership model

### Route: `apps/web/src/routes/puzzle/[id]/+page.svelte`

The route continues to own:

- puzzle ID resolution, source loading, source cleanup, loading/error state;
- `PuzzleSessionStore` construction, subscription, and disposal;
- session persistence and periodic/final checkpoints;
- completion local-stat and server-submission effects;
- authentication-transition retry;
- session setup/pause/restart/exit orchestration;
- global Undo/Redo shortcuts;
- document visibility and page-hide persistence;
- reference-hold session semantics and selection cancellation on window blur;
- session-event presentation values originating from the engine (`rejectedPiece`, `activeHintPieceId`, `activeHintTarget`) and their existing timeout lifecycle;
- responsive board metrics shared by board and inventory;
- top-level page/HUD/progress/loading/error layout;
- the two-column `game-layout` composition;
- exactly one polite live region and the `announce(message)` callback.

Do not replace explicit component props with a route view-model object.

### `PuzzleBoardPanel.svelte`

The board panel owns:

- the `PUZZLE BOARD` wrapper/header;
- `PuzzleToolbar` composition;
- `ReferenceOverlay` composition;
- board viewport and canvas markup;
- `ZoomableBoardFrame` and `PuzzleBoard` composition;
- board-panel CSS;
- local zoom, min/max zoom, pan offsets, panning state, pointer origins, viewport element, and `ResizeObserver`;
- board-local window pointer move/up/cancel and blur cleanup;
- recalculating and clamping zoom/pan after viewport changes.

The board panel never dispatches to `PuzzleSession`. It receives callbacks for Undo, Redo, Hint, reference hold, placement, rotation mode, Pause, and Setup.

The route supplies a monotonically increasing `viewResetVersion`. The panel resets to fit-to-view when the puzzle changes or `viewResetVersion` changes. This replaces route-owned `pendingViewportReset` without an imperative component API.

The route also supplies `interactionBlocked`. When a session/completion modal opens, the panel cancels an in-progress pan locally. This avoids component refs or shared panning state.

### `PuzzleInventoryPanel.svelte`

The inventory panel owns:

- the `INVENTORY` wrapper/header, remaining count, piece grid, and complete message;
- mapping `trayOrder` to puzzle pieces;
- filtering placed pieces;
- display-rotation lookup;
- `PuzzlePiece` composition;
- inventory CSS and hint/rejection visual classes.

Canonical selection, rotations, tray order, hints, and placement stay in `PuzzleSession`/route values passed as props. The panel receives `onRotate`, `onSelect`, and `onCancelSelection` callbacks.

No generic collection/panel component is added. Duplicating the small board/inventory header styles is cheaper and clearer at two consumers.

### `PuzzleCompletionDialog.svelte`

The completion dialog owns:

- existing `celebration-modal` markup;
- `modalFocus` usage;
- Timed versus Relaxed completion presentation;
- final-time, personal-best, new-record, and unsaved presentation;
- retry banner and actions;
- Escape-to-dismiss handling;
- completion-modal CSS.

It receives plain presentation values and callbacks. It does not own completion effects, retry policy, local-stat writes, session restart, or navigation.

`formatTime` moves with the dialog because it is display formatting used only by completion presentation.

## Component interfaces

Use these prop names unless an existing imported type requires only a mechanical type annotation change. Do not change ownership or replace them with grouped controller/view-model props.

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

The `announce` prop is the only accessibility seam introduced by HPA-557. HPA-223 will later add panel-local roving focus and actual outcome announcements. HPA-557 does not add an announcer store, context provider, preferences, or announcement catalog.

## Live-region boundary

The route renders exactly one region:

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

and owns:

```ts
let announcement = $state('');

function announce(message: string): void {
  announcement = message;
}
```

No panel or dialog renders another live region.

## Viewport reset flow

Replace route-local `pendingViewportReset` with a simple value flow:

1. route owns `boardViewResetVersion = 0`;
2. successful puzzle load increments it after session construction;
3. restart/reconfigure paths increment it where they currently set `pendingViewportReset = true`;
4. `PuzzleBoardPanel` reacts to puzzle identity and `viewResetVersion` once its viewport exists;
5. the panel's `ResizeObserver` recomputes bounds on layout changes.

This value is not persisted and never enters `PuzzleSession`.

## Route cleanup after extraction

Once the three components are wired, remove presentation imports/state/helpers that no longer belong in the route:

- `modalFocus`, `PuzzleBoard`, `PuzzlePiece`, `PuzzleToolbar`, `ZoomableBoardFrame`, `ReferenceOverlay`, `SvelteMap`, and completion-only `formatTime` imports;
- board viewport element, zoom/min/max/pan/panning fields, panning helpers, and pointer-move listener;
- inventory piece map/order/display-rotation/placed-check helpers;
- completion modal markup and modal CSS;
- board/inventory CSS moved to their components.

Keep route helpers that still mutate or coordinate domain/session state, including piece placement, Hint/Undo/Redo, reference hold, rotation, selection, completion effects, session setup/pause/restart/exit, persistence, and global shortcuts.

## Testing strategy

This is behavior-preserving, so existing route tests remain the main integration fence. Add focused component tests only for behavior that moves behind a component boundary.

### Board panel

Test:

- current toolbar/board test IDs remain present;
- toolbar and placement callbacks forward;
- zoom changes `ZoomableBoardFrame` transform;
- `viewResetVersion` restores fit/reset pan;
- window blur and `interactionBlocked` cancel panning.

### Inventory panel

Test:

- tray order controls rendered order;
- placed pieces are omitted and remaining count is correct;
- selection/rotation state reaches `PuzzlePiece`;
- hint/rejection classes stay on the expected slot;
- select/rotate/cancel callbacks forward.

### Completion dialog

Test:

- Timed mode renders rank, final time, personal best, and new-record/unsaved presentation;
- Relaxed mode omits timed fields;
- retry action forwards;
- Escape calls `onDismiss`;
- Play Again and Back to Arcade forward;
- existing modal/test IDs remain unchanged.

### Route regression

Keep the existing `page.svelte.test.ts` suite intact wherever possible. Do not weaken assertions merely because markup moved. Existing coverage should continue to fence responsive sizing, reference hold, panning cleanup, selection cleanup on blur, Timed/Relaxed completion, retry behavior, stale completion-effect protection, Play Again, setup/pause/exit flows, and local-versus-API completion semantics.

### E2E

Run the existing gameplay smoke suite. HPA-557 adds no behavior, so no new broad cross-browser matrix is required.

## Risks and mitigations

- **Long prop lists:** keep explicit props; do not introduce a view-model/controller merely to shorten component calls.
- **Viewport behavior drift:** preserve existing fit/clamp algorithms and add a focused board-panel browser test before deleting route viewport state.
- **Scoped CSS drift:** move selectors with owned markup and preserve class/custom-property names.
- **Completion focus/dismissal drift:** move `modalFocus`, roles/ARIA, `celebration-modal`, and Escape handling together; add a focused dialog test.
- **HPA-223 scope creep:** create only the live-region/callback seam. No roving focus or announcement logic here.
- **Generic abstraction creep:** duplicate the small panel-header styles rather than generalize two consumers.

## Acceptance mapping

- route primarily composes board, inventory, completion, and existing session-dialog components;
- lifecycle, persistence, completion, and authentication semantics remain route-owned and unchanged;
- board/inventory/completion changes each have one obvious component file;
- no new global state or duplicated gameplay-domain state is introduced;
- route owns one live region and passes `announce(message)` to the feature components; future roving focus stays panel-local;
- focused component/route tests and gameplay smoke pass;
- HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, and HPA-224 each have a concrete component boundary to extend.

## Implementation boundary

HPA-557 lands as one implementation PR with small reviewable commits. It must not implement downstream gameplay features while extracting the route. Success is a smaller, easier-to-change composition root, not a new gameplay architecture.