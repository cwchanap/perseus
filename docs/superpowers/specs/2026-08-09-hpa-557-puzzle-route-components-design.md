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
- page, HUD, board, inventory, modal, responsive-layout, and reduced-motion CSS.

The route already uses focused primitives such as `PuzzleToolbar`, `PuzzleBoard`, `ZoomableBoardFrame`, `ReferenceOverlay`, `GameTimer`, `PuzzlePiece`, `MissionSetupDialog`, `SessionPauseDialog`, and `ExitSessionDialog`. The missing boundary is feature-level composition around those primitives, not another gameplay framework.

HPA-556 is merged in PR #49 and HPA-563 is complete, so HPA-557 is unblocked. It is the structural dependency for HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, and HPA-224.

## Goals

1. Make `+page.svelte` primarily a gameplay orchestration/composition root.
2. Extract exactly three feature-level components:
   - `PuzzleBoardPanel.svelte`
   - `PuzzleInventoryPanel.svelte`
   - `PuzzleCompletionDialog.svelte`
3. Keep `PuzzleSession` as the only canonical gameplay state owner.
4. Keep source loading, persistence, lifecycle coordination, completion effects, auth retry, responsive metrics, reference-hold semantics, and global keyboard shortcuts in the route.
5. Move markup and CSS to the component that visually owns it, including reduced-motion rules.
6. Move zoom/pan mechanics into the board panel because they are ephemeral viewport presentation, while keeping session-changing callbacks in the route.
7. Preserve current behavior, copy, ARIA semantics, CSS contracts, event capture semantics, reduced-motion behavior, and existing test IDs.
8. Leave HPA-223 accessibility behavior—including the live region and announcement callback—until HPA-223 has a real announcement to emit.

## Non-goals

- no gameplay controller, route store, state machine, event bus, context layer, dependency-injection layer, generic panel system, or view-model wrapper;
- no board, toolbar, inventory, completion, setup/pause/exit, or breakpoint redesign;
- no persistence or completion behavior changes;
- no inventory filters/shuffle, mobile drawer, persistent reference mode, toolbar redesign, S-rank replacement, roving focus, live region, or announcement API from downstream tickets;
- no tiny helper extraction solely to reduce line count;
- no generic `Panel` or `GameplayDialog` abstraction;
- no backward-compatibility work.

## Options considered

### Option A — Three concrete feature wrappers with explicit props/callbacks (recommended)

Extract board, inventory, and completion presentation into the exact components named by the ticket. Keep gameplay/session orchestration in the route. Let the board panel own only viewport-local mechanics; every action that mutates `PuzzleSession` or route lifecycle remains a route callback.

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

**Rejected:** HPA-224 is waiting for a completion boundary, and the modal already matches the existing concrete-dialog pattern. Leaving it inline preserves a major collision zone.

## Decision

Use **Option A**.

The change is structural, not architectural. The route coordinates gameplay state changes. Components own presentation and presentation-local state only.

## Ownership model

### Route

`apps/web/src/routes/puzzle/[id]/+page.svelte` continues to own:

- puzzle source loading/cleanup and loading/error state;
- `PuzzleSessionStore` construction, subscription, disposal, persistence, and lifecycle orchestration;
- completion local-stat and server-submission effects plus auth retry;
- setup/pause/restart/exit orchestration;
- global Undo/Redo, document visibility, and page-hide behavior;
- reference-hold session semantics and selection cancellation on blur;
- responsive board metrics shared by board and inventory;
- engine-originated hint/rejection presentation values and timeout lifecycle;
- a small `placedPieceIds` set used by the route-side `handlePieceRotate()` guard;
- page/HUD/progress/loading/error layout and the two-column `game-layout`;
- route-owned reduced-motion rules for progress/loading/error presentation.

### `PuzzleBoardPanel.svelte`

The board panel owns:

- `PUZZLE BOARD` wrapper/header;
- `PuzzleToolbar`, `ReferenceOverlay`, `ZoomableBoardFrame`, and `PuzzleBoard` composition;
- board viewport/canvas markup and board CSS;
- local zoom/min/max/pan/panning state and pointer origins;
- viewport element and `ResizeObserver`;
- board-local window pointer move/up/cancel and blur cleanup;
- viewport fit/clamp calculations using the existing helpers.

It never dispatches to `PuzzleSession`; session-changing actions remain explicit route callbacks.

`ReferenceOverlay` remains fixed full-screen after moving inside this composition wrapper.

Reference availability is derived from the puzzle rather than added as another prop:

```svelte
<PuzzleToolbar
  ...
  hasReference={puzzle.hasReference === true}
/>
```

This preserves the current behavior for puzzles without reference images instead of falling through to `PuzzleToolbar`'s default `true`.

### `PuzzleInventoryPanel.svelte`

The inventory panel owns:

- `INVENTORY` wrapper/header, remaining count, grid, slots, and complete message;
- local tray-ID-to-piece mapping and placed-piece filtering;
- display-rotation lookup and `PuzzlePiece` composition;
- inventory CSS, hint/rejection visual classes, and rejected-piece reduced-motion rule.

Canonical selection, rotations, tray order, hint/rejection facts, and placements remain route/session values passed as props.

The route intentionally keeps its own placed-piece membership check for the rotation guard even though the panel has another local set for rendering.

### `PuzzleCompletionDialog.svelte`

The completion dialog owns the current celebration presentation exactly:

- backdrop keeps `data-testid="celebration-modal"`, `role="presentation"`, and Escape handling;
- inner box keeps `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`, and `use:modalFocus`;
- Timed/Relaxed fields, final time, personal best, new-record/unsaved presentation;
- retry banner and actions;
- completion CSS and completion reduced-motion rules.

It receives presentation values and callbacks only. Completion effects, retry policy, stats writes, restart, and navigation remain route-owned.

## Component interfaces

Keep explicit props; do not group them into a view model.

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
}
```

## Window ownership

| Event / signal | Owner after HPA-557 | Required behavior |
| --- | --- | --- |
| pan `pointermove` | board panel | normal window handler |
| pan `pointerup` / `pointercancel` | board panel | capture phase (`onpointerupcapture` / `onpointercancelcapture`) |
| pan blur | board panel | cancel local pan only |
| viewport `ResizeObserver` | board panel | recompute/clamp on viewport-box changes |
| `boardMetrics` changes | board panel | recompute/clamp current view; do not reset merely because metrics changed |
| reference `pointerup` / `pointercancel` | route | keep capture phase |
| reference + selection blur | route | end reference mode/cancel selection |
| window `resize` | route | update viewport width/height metrics only |
| global `keydown` | route | Undo/Redo unchanged |
| `pagehide` / `visibilitychange` | route | persistence/timer unchanged |
| `interactionBlocked` | route → board panel | cancel pan when route modal state makes gameplay inert |

After extraction, `clearTransientGameplayState()` has no pan fields. Route modal state updates `interactionBlocked`, which is the sole lifecycle-to-panel pan-cancel signal.

## Viewport reset versus reclamp

Reset-to-fit and resize/reclamp are separate operations.

Svelte `$effect` tracks reactive values read synchronously, including reads made by synchronously called helpers. If a reset effect calls `resetViewport()` normally, the helper's reads can accidentally subscribe the effect to `boardMetrics`, causing window-size metric changes to reset user zoom.

Use `untrack` around the helper body while explicitly tracking the intended signals and viewport availability:

```ts
import { untrack } from 'svelte';

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
```

The viewport `ResizeObserver` separately calls `recomputeZoomBounds()` when the element's box changes.

This preserves four behaviors:

- puzzle/reset events intentionally reset to fit;
- responsive metric changes do not discard a usable user zoom;
- board-size/tier changes refresh min/max/pan bounds even if the viewport element box did not change;
- a newly bound viewport initializes because the element is tracked outside `untrack`.

`boardViewResetVersion` remains presentation-only and is never persisted.

## Reduced-motion CSS ownership

The current `@media (prefers-reduced-motion: reduce)` block spans future owners. Split it explicitly:

- **Route:** `.progress-bar-fill`, `.loading-ring`, `.state-label`, `.err-icon`, `.error-panel`, and route error `.arcade-btn:hover`.
- **Inventory:** `.piece-slot.rejected`.
- **Completion:** `.modal-scan-line`, `.modal-box`, `.modal-rank`, and completion `.arcade-btn:hover`.

`.arcade-btn` is global and appears in both route error and completion markup, so the reduced-motion hover override is intentionally duplicated in those scoped owners.

Run `svelte-check --fail-on-warnings` after each extraction. Unused-selector warnings catch CSS left behind, while the explicit ownership list protects against moved markup that accidentally loses a selector.

## HPA-223 stays deferred

HPA-557 adds no dead `announce()` prop and no empty `aria-live` region. HPA-223 will add the single route live region and panel-local keyboard/roving-focus behavior when it implements actual announcements.

## Incremental cleanup rule

Each extraction removes its own route residue in the same commit:

- board: board markup/imports, viewport/pan state/helpers/listener branches, board CSS;
- inventory: inventory markup, `SvelteMap`/ordering/display helpers, `PuzzlePiece` import, inventory CSS/reduced-motion rule, while retaining the route rotation guard;
- completion: completion markup, `modalFocus` and completion-only `formatTime`, completion CSS/reduced-motion rules.

No generic fourth cleanup commit. Final verification only inventories ownership and runs gates.

## Testing strategy

`apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` is a frozen integration fence. Run it after every extraction but do not edit or stage it by default. Any change requires explicit justification because this ticket is behavior-preserving.

New component tests use `apps/web/src/lib/components/__tests__/*.svelte.test.ts`.

### Board panel

Use deliberately oversized board metrics so panning cannot clamp to zero. Cover:

- toolbar callbacks and reference visibility from `puzzle.hasReference`;
- real non-zero pan after zoom;
- `viewResetVersion` restoring fit and zero pan after real movement;
- `interactionBlocked` cancelling pan and preventing later pointer moves from changing transform;
- `boardMetrics` change preserving the current zoom when it is still within new bounds;
- capture-phase pan termination and blur cleanup.

### Inventory panel

Cover tray order, placed filtering/count, selection/rotation pass-through, hint/rejection classes, and callbacks.

### Completion dialog

Cover Timed/Relaxed presentation, new-record/unsaved state, retry/actions, backdrop Escape, inner focus ownership, and existing test IDs.

### Per-task gates

Every extraction runs:

```bash
cd apps/web
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
```

The flag is verification-only; do not change the package script for HPA-557.

### Final gates

- focused component + unchanged route browser tests;
- `bun run test:unit --filter=@perseus/web`;
- warning-strict Svelte check;
- web lint/build;
- gameplay smoke E2E;
- `git diff --exit-code main...HEAD -- apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`.

Full monorepo build remains optional unless implementation unexpectedly touches shared packages.

## Risks and mitigations

- **Reset-on-resize:** separate reset trigger effect from metrics reclamp and use `untrack`.
- **Stale fit after tier changes:** react directly to `boardMetrics` in addition to `ResizeObserver`.
- **Fake pan coverage:** use oversized metrics and assert non-zero translation.
- **Event phase drift:** preserve capture for pan and reference termination.
- **Scoped/reduced-motion CSS drift:** split the media block explicitly and fail on warnings.
- **Missing reference guard:** derive from `puzzle.hasReference === true` in the panel.
- **Route-test drift:** keep the integration test unchanged by default.
- **Completion focus/dismissal drift:** preserve backdrop Escape + inner `modalFocus` exactly.
- **Long prop lists:** accept explicit props rather than adding a view model.
- **HPA-223 scope creep:** do not prebuild announcement APIs.

## Acceptance mapping

- route becomes a composition/orchestration root;
- `PuzzleSession` remains the sole canonical gameplay owner;
- board/inventory/completion each gain one concrete extension point;
- board window/pan state is local while route reference/global/persistence events remain route-owned;
- puzzle/reset signals reset, while metric/viewport changes reclamp without gratuitous reset;
- reference availability remains correct;
- reduced-motion behavior survives component scoping;
- route integration tests remain unchanged by default;
- warning-strict checks and per-task lint fence CSS/format drift;
- no HPA-223 seam or downstream gameplay feature ships early.

## Implementation boundary

HPA-557 lands as one implementation PR with three reviewable extraction commits followed by verification. Success is a smaller, easier-to-change composition root, not a new gameplay architecture.