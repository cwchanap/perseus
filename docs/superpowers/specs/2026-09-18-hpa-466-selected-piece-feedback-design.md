# HPA-466: Selected-Piece Inspection and Placement Feedback — Design

**Linear:** HPA-466  
**Status:** Design for implementation  
**Date:** 2026-09-18

## Context

HPA-466 is the next actionable Perseus ticket: it is High priority, unblocked, and improves the core web puzzle loop without backend, persistence, or game-core work.

Current code already provides the required seams:

- `PuzzleInventoryPanel.svelte` owns tray presentation, selection chrome, rotation controls, fixed filters, and the empty-filter state.
- `PuzzleBoard.svelte` owns board-cell hover/drag/focus presentation and forwards placement attempts without pre-validating correctness.
- `+page.svelte` is the composition root and `PuzzleSession` remains the only gameplay authority.
- `attempt_placement` already returns the authoritative placement outcome to the composition root.
- placement accepted/rejected session events already own the live-region announcements.
- the route already owns a 500 ms rejected-piece presentation state.
- mobile already uses the same composition-root placement-feedback pattern needed here.

The implementation should extend those patterns rather than create a new callback contract, duplicated preview surface, or animation layer.

## Goals

1. Make the currently selected tray piece materially easier to inspect.
2. Keep the enlarged selected piece synchronized with its displayed rotation.
3. Keep Rotate and Cancel outside the artwork.
4. Show remaining unplaced counts for All / Corners / Edges / Center without changing the filter-row geometry.
5. Replace a dead-end filtered-empty state with truthful copy plus one explicit `SHOW ALL REMAINING` recovery action.
6. Make board candidate state visible on mouse, keyboard, **and touch** after a piece is selected.
7. Give accepted and rejected attempts short, distinct board-cell feedback.
8. Keep rejected selection intact for immediate retry.
9. Preserve current session, persistence, hint, rotation, shuffle, keyboard, and completion semantics.
10. Respect reduced motion while keeping feedback visible.

## Non-goals

- correctness previews, magnetic snap, auto-place, neighboring-piece suggestions, or automatic rotation;
- changes to `PuzzleSession`, game-core events/actions/codecs, scoring, or completion rules;
- a generic feedback/animation framework;
- a second selected-piece state owner;
- a new generic piece-artwork abstraction solely for this ticket;
- responsive tray redesign or a second floating selected-piece surface;
- audio, haptics, generated art, backend work, or NativeScript parity;
- changing shuffle semantics or tray ordering.

## Selected-piece inspection: enlarge the existing selected slot

Do **not** add a second preview above the tray.

A separate preview capped at one `--piece-slot-size` would duplicate the exact same artwork at the exact same size while consuming the mobile half-sheet's vertical budget. Instead, enlarge the selected tray slot itself.

When `selectedPieceId === piece.id`:

- the existing `.piece-slot` spans **2 columns × 2 rows**;
- the existing interactive `PuzzlePiece` expands with the slot, so its current tab framing, rotation, selection semantics, keyboard behavior, and image source are reused automatically;
- Rotate and Cancel remain in the header, not over the artwork;
- no duplicate `<img>`, no second surface, and no additional accessibility node are introduced;
- cancel or successful placement returns the grid to normal because canonical selection clears.

The DOM order remains unchanged; CSS grid may reposition the selected item to satisfy the 2×2 span, but roving focus still follows the existing piece IDs/DOM order.

The mobile grid keeps its existing scroll container. Selection is transient, so magnification may reduce the number of other pieces simultaneously visible without changing the sheet height.

### Why no `PieceArtwork.svelte` extraction

The prior separate-preview plan would have created a third hand-maintained copy of the `EXPANSION_FACTOR / TAB_RATIO` geometry. The 2×2 selected-slot design removes that new copy entirely by reusing `PuzzlePiece`.

The existing `PuzzlePiece` / placed-board geometry duplication remains unchanged. Extracting it now would be standalone cleanup unrelated to HPA-466, so defer it until another real consumer/change makes that refactor pay for itself.

## Filter counts

Reuse `unplacedPieces + matchesInventoryFilter`. Keep counts local to the panel.

For each fixed filter derive:

- **total kind count** from all `puzzle.pieces`;
- **remaining kind count** from `unplacedPieces`.

Every filter button gets a compact visible numeric badge for its remaining count:

- All;
- Corners;
- Edges;
- Center.

The badge is absolutely positioned inside the existing fixed button box, so it does **not** change button width, the 2.75rem mobile hit target, or `.inventory-tools` wrapping.

Accessible labels also include the count while preserving their existing prefixes, e.g. `All pieces, 7 remaining`, `Corner pieces, 2 remaining`.

At the 1024–1279 disclosure layout, the non-All badges are visible when the existing filter menu is opened; no extra summary badge/state is needed.

## Truthful empty-filter recovery

When a non-All active filter has zero visible pieces while the puzzle is not complete:

1. if the puzzle contains **zero pieces of that kind**, keep the factual `NO PIECES MATCH` message;
2. if the puzzle contains that kind but its remaining count is zero, show:
   - `ALL CORNERS PLACED`
   - `ALL EDGES PLACED`
   - `ALL CENTER PIECES PLACED`
3. in both cases expose one `SHOW ALL REMAINING` action using existing `onFilterChange('all')`.

Do not auto-switch filters.

This preserves truthful behavior for the existing 2×1 fixtures, where every piece is a corner and Edge/Center never existed.

## Candidate-cell affordance

No candidate-cell Svelte state is required.

When `selectedPieceId !== null`, set `data-candidate-enabled` on the board.

Touch needs a persistent selected-state cue, so candidate styling has two levels:

1. **Baseline** — every `.cell-empty` gets a subtle neutral border/inset treatment while the board is candidate-enabled.
2. **Emphasis** — `:hover` and `:focus-visible` strengthen that neutral treatment for mouse/keyboard users.

The baseline never encodes correctness: every empty cell receives the same styling.

Existing `getCellStyle()` remains authoritative for occupancy/drag state:

- occupied cells are not `.cell-empty`, so they get no candidate treatment;
- `cell-drop-over` remains exclusive from `cell-empty`, so drag-over wins naturally.

## One route-owned placement feedback state

Collapse tray rejection and board feedback into one route-local value:

```ts
type PlacementFeedback = {
  pieceId: number;
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
};

let placementFeedback = $state<PlacementFeedback | null>(null);
let placementFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

const rejectedPiece = $derived(
  placementFeedback?.kind === 'rejected' ? placementFeedback.pieceId : null
);
```

There is no separate `rejectedPiece` state or `rejectedPieceTimeout`.

`handlePiecePlaced(pieceId, x, y)` remains a **void** callback:

1. dispatch `attempt_placement`;
2. inspect the returned `PuzzleSessionOutcome`;
3. when status is accepted/rejected, replace `placementFeedback`;
4. start/restart one timeout using existing `REJECTED_DURATION_MS = 500`;
5. checkpoint exactly as today.

The `placement_rejected` session-event handler keeps only its existing live-region announcement. It no longer owns visual state.

This is safe because web dispatches `attempt_placement` from the single composition-root placement path; the call site already knows piece ID + attempted coordinates + authoritative outcome together.

Clear the one feedback/timer on the same route transitions that currently clear other transient gameplay chrome: direct puzzle navigation/reset, play-again/restart, and component teardown.

## Board feedback overlay

`PuzzleBoard` receives:

```ts
placementFeedback?: {
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
} | null;
```

For the matching cell it renders one pointer-events-none `data-testid="placement-feedback"` child, analogous to the existing hint overlay.

Do **not** fold placement feedback into `getCellStyle()`:

- accepted feedback must still render after the target becomes `cell-occupied`;
- rejected feedback is separate from candidate/drop-over classes;
- hint and placement feedback can coexist.

### Explicit stacking

Placed piece wrappers use z-index values from 1 through `gridRows * gridCols`.

Pin overlay levels explicitly:

- placement feedback: `gridRows * gridCols + 1`;
- hint target: `gridRows * gridCols + 2`.

That keeps accepted feedback above placed artwork and neighboring tabs while keeping a simultaneous hint marker above the placement effect.

Both overlays remain pointer-events-none.

## Reduced motion

Under `prefers-reduced-motion: reduce`:

- disable shake/pulse/movement animation;
- preserve static accepted/rejected outline/background for the same 500 ms state lifetime.

No JS motion-query state.

## Accessibility

- enlarging the existing selected slot adds no duplicate accessibility node;
- existing piece name, selection, rotation, and placement announcements remain authoritative;
- candidate state is visible without hover and gets stronger `:focus-visible` treatment;
- candidate/accepted/rejected feedback differs through border/outline/shape treatment, not hue alone;
- filter buttons keep their existing accessible-name prefixes and add remaining count;
- `SHOW ALL REMAINING` is a real button and changes filter only when activated.

## Layout budget

HPA-466 must not regress current mobile tray guarantees:

- `.inventory-tools` remains non-wrapping;
- filter badges are overlays and do not alter control geometry;
- the selected item enlarges **inside the existing scroll grid**, not as a new flex sibling above it;
- the 390×844 half sheet remains within the viewport;
- the large-inventory grid retains its existing two-row height budget and remains scrollable while a 2×2 selected item is present.

## File map

**Modify**

- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts` — extend existing smoke; do not add a new spec.

**Do not modify by default**

- `packages/game-core/**`
- gameplay persistence / codec modules;
- `PuzzlePiece.svelte`;
- backend / workflow code;
- mobile production code;
- new shared piece-artwork component.

## Test strategy

### Inventory component

Prove observable behavior:

- selected piece's slot gets the expanded state and its rendered dimensions/grid span increase;
- selected piece still uses the existing `PuzzlePiece`, rotation, select/cancel, and roving-focus semantics;
- selection clear removes the expanded state;
- peek hides the existing body/grid as today;
- every fixed filter exposes a visible remaining-count badge plus count-bearing accessible label;
- counts update after `placedPieces` changes;
- 2×1 Edge/Center filters keep `NO PIECES MATCH`;
- a filter kind that existed but is fully placed shows `ALL … PLACED`;
- both empty-state branches expose recovery;
- recovery calls `onFilterChange('all')` without auto-switching.

### Board component

Test behavior, not stylesheet source:

- `data-candidate-enabled` exists only while selected;
- selected + empty cell has a different computed baseline border/background/box-shadow than the same cell when unselected;
- occupied and `cell-drop-over` class behavior remains unchanged;
- prop-driven accepted/rejected feedback renders at the requested cell;
- accepted feedback still renders when the cell is occupied;
- placement and hint overlays coexist;
- computed placement-feedback z-index exceeds placed artwork;
- computed hint z-index exceeds placement-feedback z-index;
- click/keyboard/drag paths remain void callbacks with no local correctness checks.

### Route integration

Prove:

- accepted dispatch sets `placementFeedback {pieceId,x,y,'accepted'}`, checkpoints, and canonical selection clears;
- rejected dispatch sets `placementFeedback {pieceId,x,y,'rejected'}`, keeps selection, and derived `rejectedPiece` drives the existing tray shake;
- the placement-rejected event still announces but no longer owns a second visual timer/state;
- a second attempt replaces the first feedback/timer;
- feedback clears after exactly 500 ms;
- navigation/restart/teardown clears stale feedback;
- rotation keeps working through the same selected `PuzzlePiece`;
- placements update filter counts from canonical state.

### Existing mobile smoke

Extend the current large-inventory 390×844 smoke:

1. select a piece so it expands to 2×2;
2. assert the panel still fits the viewport;
3. assert the scroll grid still has the existing two-row height budget;
4. assert the expanded selected slot is materially larger than an unselected slot;
5. keep the current swipe-scroll proof.

No new E2E spec.

## Risks and fences

1. **Selected-grid reflow** — pin 2×2 span/dimensions and existing roving-focus semantics in component tests.
2. **Touch candidate visibility** — baseline candidate style is persistent while selected; hover/focus only strengthens it.
3. **False exhausted copy** — distinguish zero total matches from zero remaining matches.
4. **Header density** — badges are absolutely positioned inside fixed controls; no row wrap or width growth.
5. **Feedback desync** — one `placementFeedback` state/timer drives both tray rejection and board feedback.
6. **Overlay stacking** — placement/hint z-levels are explicitly above all placed pieces and ordered relative to each other.
7. **Duplicate semantic feedback** — no new live region; session events remain the semantic source.
8. **Stale transient state** — one replaceable 500 ms timer, cleared on navigation/restart/teardown.

## Delivery guardrail

One implementation PR for HPA-466. This planning branch and draft PR remain the implementation branch/PR.

Do not split selected-slot magnification, tray status, and placement feedback into separate PRs.
