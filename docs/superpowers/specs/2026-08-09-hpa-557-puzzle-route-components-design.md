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
- session-event presentation values originating from the engine (`rejectedPiece`, `activeHintPieceId`, `activeHintTarget`) and their timeout lifecycle;
- responsive board metrics shared by board and inventory;
- a small `placedPieceIds` derived set used by the route-side `handlePieceRotate()` guard;
- top-level page/HUD/progress/loading/error layout;
- the two-column `game-layout` composition;
- route-owned reduced-motion rules for progress/loading/error presentation.

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
- recalculating and clamping zoom/pan after viewport or board-metric changes.

The board panel never dispatches to `PuzzleSession`. It receives callbacks for Undo, Redo, Hint, reference hold, placement, rotation mode, Pause, and Setup.

The route supplies a monotonically increasing `viewResetVersion`. The panel resets to fit-to-view only when the puzzle identity changes, `viewResetVersion` changes, or a new viewport element is bound. This replaces route-owned `pendingViewportReset` without an imperative component API.

The route also supplies `interactionBlocked`. When a session/completion modal opens, the panel cancels an in-progress pan locally. This avoids component refs or shared panning state.

`ReferenceOverlay` moves inside `PuzzleBoardPanel` as a composition child, but its existing fixed full-screen DOM contract remains unchanged (`fixed inset-0` with no non-fixed replacement wrapper).

`PuzzleBoardPanel` derives toolbar reference availability from the existing puzzle prop:

```svelte
<PuzzleToolbar
  ...
  hasReference={puzzle.hasReference === true}
/>
```

Do not add a separate `hasReference` prop and do not rely on `PuzzleToolbar`'s default `true`, because API puzzles without a reference must continue hiding the Reference action.

### `PuzzleInventoryPanel.svelte`

The inventory panel owns:

- the `INVENTORY` wrapper/header, remaining count, piece grid, and complete message;
- its own local mapping of `trayOrder` to puzzle pieces;
- its own local filtering set for placed pieces;
- display-rotation lookup;
- `PuzzlePiece` composition;
- inventory CSS and hint/rejection visual classes;
- the reduced-motion rule that removes rejected-piece glow.

Canonical selection, rotations, tray order, hints, and placement stay in `PuzzleSession`/route values passed as props. The panel receives `onRotate`, `onSelect`, and `onCancelSelection` callbacks.

The route still retains its own small `placedPieceIds` set because `handlePieceRotate()` must reject rotation for already placed pieces before dispatching to `PuzzleSession`.

No generic collection/panel component is added. Duplicating the small board/inventory header styles is cheaper and clearer at two consumers.

### `PuzzleCompletionDialog.svelte`

The completion dialog owns the current celebration presentation exactly as it exists today:

- the backdrop remains `data-testid="celebration-modal"`, `role="presentation"`, and owns the Escape key handler;
- the inner box remains `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`, and owns `use:modalFocus`;
- Timed versus Relaxed presentation;
- final-time, personal-best, new-record, and unsaved presentation;
- retry banner and actions;
- completion-modal CSS;
- completion-owned reduced-motion rules for scan line, modal entrance, rank animation, and completion buttons.

It receives plain presentation values and callbacks. It does not own completion effects, retry policy, local-stat writes, session restart, or navigation.

`formatTime` moves with the dialog because it is display formatting used only by completion presentation.

Do not “clean up” Escape handling by moving it from the backdrop to the dialog during this extraction. HPA-557 preserves the current DOM/event contract.

## Component interfaces

Use these explicit interfaces; do not group them into controller/view-model props.

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

## Window ownership after the split

The split must preserve the current dual use of window events for panning and reference hold. Svelte 5 capture handlers use the `...capture` event-attribute suffix, so the board panel uses capture handlers for pan termination instead of silently changing the current listener phase.

| Event / signal | Owner after HPA-557 | Required behavior |
| --- | --- | --- |
| `pointermove` for pan | `PuzzleBoardPanel` | normal window handler |
| `pointerup` / `pointercancel` for pan | `PuzzleBoardPanel` | capture phase (`onpointerupcapture` / `onpointercancelcapture`) |
| `blur` for pan | `PuzzleBoardPanel` | cancel local pan only |
| board viewport `ResizeObserver` | `PuzzleBoardPanel` | recompute fit/min/max and clamp zoom/pan when viewport box changes |
| `boardMetrics` changes | `PuzzleBoardPanel` | recompute bounds and clamp current zoom/pan without resetting to fit |
| `pointerup` / `pointercancel` for reference hold | route | keep current capture-phase listeners |
| `blur` for reference + selection | route | end reference mode and cancel selection only |
| window `resize` | route | update `viewportWidth` / `viewportHeight` for `boardMetrics` only; do not call board zoom helpers |
| global `keydown` | route | Undo/Redo unchanged |
| `pagehide` / `visibilitychange` | route | persistence/timer behavior unchanged |
| `interactionBlocked` | route → board panel | route-driven pan-cancel signal when a dialog/celebration makes gameplay inert |

After extraction, `clearTransientGameplayState()` no longer touches pan fields because those fields do not exist in the route. For pause/exit/setup/celebration transitions, the route changes `sessionDialog` or `showCelebration`; `hasSessionModal` updates; `interactionBlocked` flows to the board panel; the board panel effect calls `cancelPan()`.

## Viewport reset and reclamp semantics

Reset-to-fit and resize/reclamp are different operations and must not share one reactive trigger.

Svelte effects track reactive values read synchronously by called functions. Therefore an effect that calls `resetViewport()` normally would also subscribe to `boardMetrics`, `zoom`, or other state read by the helper. Use `untrack` around the helper body while deliberately tracking only the trigger signals outside it.

The reset effect tracks puzzle identity, reset version, and viewport availability, then performs the reset untracked:

```ts
import { untrack } from 'svelte';

$effect(() => {
  puzzle.id;
  viewResetVersion;
  const viewport = boardViewportElement;
  if (!viewport) return;
  untrack(() => resetViewport());
});
```

The metrics effect tracks `boardMetrics` and viewport availability, then recomputes/clamps the current view untracked:

```ts
$effect(() => {
  boardMetrics;
  const viewport = boardViewportElement;
  if (!viewport) return;
  untrack(() => recomputeZoomBounds());
});
```

The existing viewport `ResizeObserver` also calls `recomputeZoomBounds()` when the viewport box changes.

Consequences:

- puzzle load/restart can explicitly reset to fit;
- changing responsive metrics because the window resized does **not** discard the user's zoom level;
- a board-size/tier change still updates `minZoom`, `maxZoom`, and pan bounds even if the viewport element's own box did not change;
- a newly bound viewport still initializes correctly because `boardViewportElement` is tracked outside `untrack`.

`boardViewResetVersion` is not persisted and never enters `PuzzleSession`.

## Reduced-motion CSS ownership

The current single `@media (prefers-reduced-motion: reduce)` block spans markup that will belong to different Svelte components. Split it with the markup rather than leaving orphaned scoped selectors in the route.

After HPA-557:

- **Route keeps:** `.progress-bar-fill`, `.loading-ring`, `.state-label`, `.err-icon`, `.error-panel`, and its `.arcade-btn:hover` override for the route-owned error action.
- **Inventory panel gets:** `.piece-slot.rejected { box-shadow: none; }`.
- **Completion dialog gets:** `.modal-scan-line`, `.modal-box`, `.modal-rank`, and a completion-local `.arcade-btn:hover` reduced-motion override.

`.arcade-btn` is globally styled in `routes/layout.css` and is used both by the route error surface and the completion dialog, so the reduced-motion hover override is intentionally present in both owners after the split.

Use `svelte-check --fail-on-warnings` during each extraction. Svelte's unused-selector warning catches route selectors left behind after markup moves. This does not prove every moved selector arrived in its new owner, so the explicit reduced-motion split above remains required.

## HPA-223 boundary is deferred, not prebuilt

HPA-557 does not add an unused `announce()` prop or empty `aria-live` region. HPA-223 will add the single route-owned polite live region when it introduces the first actual announcement, then pass callbacks to the concrete components that need them. The three-component split gives HPA-223 stable extension points without requiring dead API surface now.

Roving focus remains panel-local when HPA-223 is implemented; global shortcuts remain route-owned.

## Incremental cleanup rule

Each extraction task removes its own route residue in the same commit:

- board task removes board markup, board-only imports, viewport/pan state and helpers, pan listener branches, and board-owned CSS;
- inventory task removes inventory markup, `SvelteMap`/piece-order/display helpers that become panel-local, `PuzzlePiece` route import, inventory CSS, and its reduced-motion rule; it keeps the route-side placed-piece rotation guard;
- completion task removes completion markup, `modalFocus`/completion-only `formatTime` route imports, completion CSS, and completion reduced-motion rules.

The final verification pass is an inventory check, not a catch-all cleanup commit. If residue remains, fix it in the task that owns it before that task is considered complete.

## Testing strategy

This is behavior-preserving, so `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` remains a frozen integration fence. New component tests follow the existing convention under `apps/web/src/lib/components/__tests__/` with the `.svelte.test.ts` suffix.

Do not edit the route test by default. Any route-test change is evidence that the extraction changed a public DOM/behavior contract and must be justified explicitly before it is staged.

### Board panel

Use board metrics larger than the browser test viewport so panning is physically possible. Test:

- current toolbar/board test IDs remain present and callbacks forward;
- the Reference action is hidden when `puzzle.hasReference !== true`;
- zoom changes `ZoomableBoardFrame` transform without assuming the initial fit scale is exactly `1`;
- pointer movement produces a non-zero translate while panning;
- after real zoom/pan, incrementing `viewResetVersion` restores the original fit transform and zero pan;
- setting `interactionBlocked=true` cancels an active pan, and subsequent pointer moves do not change the transform;
- changing `boardMetrics` reclamps the current view rather than resetting it to fit;
- window blur cancels panning;
- capture-phase pointer-up/cancel wiring is preserved.

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
- Escape is dispatched on `celebration-modal` and calls `onDismiss`;
- the inner role=`dialog` remains a child of the backdrop and retains `modalFocus`;
- Play Again and Back to Arcade forward;
- existing modal/test IDs remain unchanged.

### Per-task compiler/lint gate

Every extraction runs:

```bash
cd apps/web
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-kit sync
PUBLIC_API_BASE=${PUBLIC_API_BASE:-} bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run lint
```

The `--fail-on-warnings` flag is a one-off verification flag; HPA-557 does not need to change the package script.

### Verification scope

Primary final gates are web-scoped because HPA-557 changes only web presentation:

- focused component + unchanged route browser tests;
- `bun run test:unit --filter=@perseus/web`;
- the warning-strict Svelte check above;
- `cd apps/web && bun run lint && bun run build`;
- `cd apps/web && bun run test:e2e:smoke`.

A full monorepo build is optional unless implementation unexpectedly touches shared packages.

## Risks and mitigations

- **Reset-on-resize regression:** separate explicit reset triggers from `boardMetrics` reclamping; use `untrack` so helper internals do not become effect dependencies.
- **Stale fit after metric-tier changes:** react to `boardMetrics` directly in the panel in addition to the viewport `ResizeObserver`.
- **Window-event split drift:** preserve the ownership table above, including capture-phase pan/reference pointer-up handling and route resize becoming metrics-only.
- **Fake pan tests:** use oversized metrics and assert a non-zero translate before testing reset/block behavior.
- **Scoped/reduced-motion CSS drift:** split the shared media block explicitly and run `svelte-check --fail-on-warnings` after each extraction.
- **Completion focus/dismissal drift:** preserve backdrop Escape + inner `modalFocus` DOM contract exactly and test Escape on `celebration-modal`.
- **Route-test drift:** keep the route integration test unchanged by default; do not silently weaken assertions to accommodate extraction mistakes.
- **Long prop lists:** keep explicit props; do not introduce a view-model/controller merely to shorten component calls.
- **HPA-223 scope creep:** do not prebuild dead announcement/live-region APIs; add them only when HPA-223 implements real behavior.
- **Generic abstraction creep:** duplicate the small panel-header styles rather than generalize two consumers.

## Acceptance mapping

- route primarily composes board, inventory, completion, and existing session-dialog components;
- lifecycle, persistence, completion, authentication, reference-hold, responsive-metric, and global-shortcut semantics remain route-owned and unchanged;
- board/inventory/completion changes each have one obvious component file;
- no new global state or duplicated gameplay-domain state is introduced;
- board viewport mechanics and pan window events are panel-owned while reference/global/persistence window events remain route-owned;
- `viewResetVersion` resets intentionally, while `boardMetrics` changes only reclamp the existing view;
- reduced-motion behavior remains intact across route, inventory, and completion owners;
- toolbar reference availability still derives from `puzzle.hasReference === true`;
- route integration tests remain unchanged by default;
- HPA-223 can add one route live region and component callbacks later without reshaping ownership, but HPA-557 ships no dead accessibility seam;
- focused component/route tests, warning-strict Svelte checks, lint, and gameplay smoke pass;
- HPA-217, HPA-219, HPA-220, HPA-222, HPA-223, and HPA-224 each have a concrete component boundary to extend.

## Implementation boundary

HPA-557 lands as one implementation PR with three small reviewable extraction commits followed by verification. It must not implement downstream gameplay features while extracting the route. Success is a smaller, easier-to-change composition root, not a new gameplay architecture.