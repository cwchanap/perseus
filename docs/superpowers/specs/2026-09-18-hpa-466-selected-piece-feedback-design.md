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
- `attempt_placement` already returns an authoritative placement outcome to the composition root.
- placement accepted/rejected session events already own the live-region announcements.
- web already keeps the rejected tray-piece effect as route-owned ephemeral presentation state.
- mobile already uses the same lean pattern needed here: `Gameplay.svelte` derives a short-lived `placementFeedback` from `dispatch()`, while `PuzzleCanvas.svelte` only renders the overlay.

The implementation should extend those patterns rather than introduce a new callback contract, state owner, or animation layer.

## Goals

1. Add a dedicated selected-piece inspection surface while the tray body is open.
2. Keep that preview synchronized with the selected piece's displayed rotation.
3. Keep Rotate and Cancel outside the artwork.
4. Show remaining unplaced counts for All / Corners / Edges / Center without expanding the header layout.
5. Replace a dead-end filtered-empty state with truthful copy plus one explicit `SHOW ALL REMAINING` recovery action.
6. Give empty cells a neutral candidate affordance on hover/focus while a piece is selected.
7. Give accepted and rejected attempts short, distinct board-cell feedback.
8. Keep rejected selection intact for immediate retry.
9. Preserve current session, persistence, hint, rotation, shuffle, keyboard, and completion semantics.
10. Respect reduced motion while keeping feedback visible.

## Non-goals

- correctness previews, magnetic snap, auto-place, neighboring-piece suggestions, or automatic rotation;
- changes to `PuzzleSession`, game-core events/actions/codecs, scoring, or completion rules;
- a generic feedback/animation framework;
- a second selected-piece state owner;
- a read-only mode on `PuzzlePiece` or a third generic piece-rendering component;
- responsive tray redesign or a second floating preview surface;
- audio, haptics, generated art, backend work, or NativeScript parity;
- changing shuffle semantics or tray ordering.

## Reuse decisions

### Selected piece

Extend the existing `piecesById` projection in `PuzzleInventoryPanel.svelte`:

```ts
const selectedPiece = $derived(
  selectedPieceId === null ? null : (piecesById.get(selectedPieceId) ?? null)
);
```

No second selected-piece state.

### Preview rotation

Reuse `displayedRotation(pieceId)`.

### Preview artwork framing

Do **not** render a bare square `<img>`. Puzzle piece PNGs are rendered at `EXPANSION_FACTOR` with negative `TAB_RATIO` offsets in both `PuzzlePiece.svelte` and placed board pieces so tabs are visible and aligned.

The preview copies only that inner non-interactive visual framing:

- base box: one `--piece-slot-size` square;
- inner artwork: `EXPANSION_FACTOR * 100%`;
- left/top: `-TAB_RATIO * 100%`;
- rotation applied to the visual wrapper;
- `aria-hidden="true"` / empty alt because selection and rotation are already announced elsewhere.

Do not reuse the interactive `PuzzlePiece` button/drag wrapper and do not create another shared piece component for one extra web consumer.

The dedicated preview is intentionally capped to one slot. On the 300 px mobile half-sheet, a larger unbounded preview would consume the grid budget HPA-220 already protects.

### Per-filter counts

Extend `unplacedPieces + matchesInventoryFilter`. Keep this local to the web panel; there is only one consumer.

Counts may render as a tiny badge only if they fit the current fixed control without changing the header geometry. The accessible label must always include the count, while preserving the current name prefix, e.g. `All pieces, 7 remaining`, `Corner pieces, 2 remaining`.

Do not wrap `.inventory-tools` or enlarge the fixed mobile hit targets just to show number text. If the visible badge does not fit cleanly, keep the count in the accessible label only.

### Placement feedback owner

Reuse the mobile composition-root pattern.

`+page.svelte` owns:

```ts
type PlacementFeedback = {
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
};

let placementFeedback = $state<PlacementFeedback | null>(null);
```

`handlePiecePlaced(pieceId, x, y)` remains a **void** callback:

1. dispatch `attempt_placement`;
2. inspect the returned `PuzzleSessionOutcome`;
3. when status is accepted/rejected, set `placementFeedback`;
4. checkpoint exactly as today.

`PuzzleBoardPanel` only forwards the optional prop. `PuzzleBoard` only renders it.

Do not change `onPiecePlaced` to return `PlacementOutcome | void`.

### Feedback duration

Reuse the existing web `REJECTED_DURATION_MS = 500`. Do not add a second duration constant and do not import/share mobile's separate 800 ms value.

One replaceable route-local placement-feedback timeout clears the overlay after 500 ms. Clear it on route teardown and when puzzle/run reset paths clear other transient gameplay chrome.

## Selected-piece preview

Render the preview inside `.inventory-body`, before `.pieces-grid`, only when `selectedPiece !== null`.

Behavior:

- uses the real selected piece artwork with the existing tab-offset framing;
- follows `displayedRotation(selectedPiece.id)`;
- no buttons or pointer semantics over the image;
- selection cancel removes it via canonical props;
- accepted placement removes it when `PuzzleSession` clears canonical selection;
- mobile `peek` hides it automatically because the body is already hidden.

No new breakpoint or persistent selected-piece surface.

## Filter counts and truthful empty states

For each fixed filter derive:

- **total kind count** from all `puzzle.pieces`;
- **remaining kind count** from `unplacedPieces`.

This distinction matters for degenerate/small puzzle shapes.

When a non-All active filter has zero visible pieces while the puzzle is not complete:

1. if the puzzle contains **zero pieces of that kind**, keep the factual `NO PIECES MATCH` message;
2. if the puzzle contains that kind but its remaining count is zero, show:
   - `ALL CORNERS PLACED`
   - `ALL EDGES PLACED`
   - `ALL CENTER PIECES PLACED`
3. in both cases expose one `SHOW ALL REMAINING` action using existing `onFilterChange('all')`.

Do not auto-switch filters.

This preserves truthful behavior for the existing 2×1 fixtures, where every piece is a corner and Edge/Center never existed.

## Neutral candidate cells

No candidate-cell state is required.

When `selectedPieceId !== null`, mark the board candidate-enabled and style only `.cell-empty` on:

- `:hover`;
- `:focus-visible`.

Because `getCellStyle()` makes `cell-drop-over` exclusive from `cell-empty`, existing drag-over styling wins automatically. Candidate styling never appears on occupied cells and never indicates correctness.

## Accepted/rejected board feedback

`PuzzleBoard` receives:

```ts
placementFeedback?: {
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
} | null;
```

For the matching cell it renders one presentation-only `data-testid="placement-feedback"` overlay, analogous to the existing hint overlay.

Rules:

- accepted feedback can render even after the cell becomes `cell-occupied`;
- rejected feedback renders on the attempted cell while canonical selection remains unchanged;
- feedback is independent of `getCellStyle()`, so candidate/drop-over class selection is not overloaded;
- hint overlay stays its own child and must remain visible when both hint and placement feedback target the same cell;
- the placement overlay is pointer-events-none and gets an explicit stacking rule so it does not swallow input or accidentally disappear behind placed artwork;
- a newer attempt replaces the older placement feedback at the route.

The board does not own timers and does not inspect placement correctness.

## Reduced motion

Under `prefers-reduced-motion: reduce`:

- disable shake/pulse/movement animation;
- preserve static accepted/rejected outline/background for the same 500 ms state lifetime.

No JS motion-query state is required for this ticket.

## Accessibility

- preview artwork is supplementary and hidden from the accessibility tree;
- existing piece names, selection announcements, rotation announcements, and placement accepted/rejected live-region text stay authoritative;
- candidate styling includes `:focus-visible`, not hover only;
- candidate/accepted/rejected feedback differs through outline/border/shape treatment, not hue alone;
- filter accessible labels keep their existing name prefix and add remaining count;
- `SHOW ALL REMAINING` is a real button and does not change the filter until activated.

## Layout budget

HPA-466 must not regress the current mobile tray guarantees:

- `.inventory-tools` remains non-wrapping;
- the preview is capped to one `--piece-slot-size`;
- counts do not force header wrapping;
- the 390×844 half sheet remains within the viewport;
- the large-inventory grid retains the existing two-complete-row budget even with a selection/preview present.

If visible count badges cannot satisfy that budget, keep counts accessible-only rather than widening the controls.

## File map

**Modify**

- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts` — extend the existing mobile tray smoke; do not add a new spec.

**Do not modify by default**

- `packages/game-core/**`
- gameplay persistence / codec modules;
- `PuzzlePiece.svelte`;
- backend / workflow code;
- mobile code.

## Test strategy

### Inventory component

Prove:

- selected piece renders one dedicated tab-framed preview;
- preview rotation follows canonical `pieceRotations`;
- selection clear removes the preview;
- peek hides the existing body/preview;
- counts are remaining-unplaced counts for all fixed filters;
- 2×1 Edge/Center filters keep `NO PIECES MATCH` and still expose recovery;
- a filter kind that existed but is fully placed shows `ALL … PLACED`;
- recovery calls `onFilterChange('all')` without auto-switching.

Update the existing `NO PIECES MATCH` tests explicitly rather than replacing their semantic coverage.

### Board component

Prove:

- candidate marker is present only while selected;
- candidate CSS targets `.cell-empty` only;
- `cell-drop-over` remains a distinct exclusive state;
- prop-driven accepted/rejected feedback renders at the requested cell;
- hint and placement feedback can coexist;
- occupied-cell accepted feedback still renders;
- existing keyboard/click/drag paths remain void callbacks with no local correctness checks.

No board fake timer is needed because the board does not own timeout state.

### Route integration

Prove:

- accepted dispatch sets accepted `placementFeedback`, checkpoints, and canonical selection clears;
- rejected dispatch sets rejected `placementFeedback`, keeps selection, and keeps existing tray rejection + announcement behavior;
- a second attempt replaces the first placement feedback/timer;
- feedback clears after exactly the existing 500 ms duration;
- route navigation/run reset clears stale feedback;
- rotation updates the preview via canonical state;
- placements update filter counts via canonical placed pieces.

### Existing mobile smoke

Extend the existing large-inventory half-sheet smoke to select a piece so the preview is mounted, then keep the existing fold-fit/two-row assertions.

Do not add another E2E spec.

## Risks and fences

1. **False exhausted copy** — distinguish zero total matches from zero remaining matches.
2. **Half-sheet density** — one-slot preview; non-wrapping tools; selected-state mobile smoke keeps two rows.
3. **Overlay stacking** — feedback is independent of `getCellStyle`; hint, drop-over, placed artwork, and feedback coexist with explicit layering.
4. **Duplicate semantic feedback** — do not add another live region; existing session-event announcements remain the source.
5. **Stale transient state** — reuse the route's 500 ms lifetime and clear feedback on navigation/restart/teardown.

## Delivery guardrail

One implementation PR for HPA-466. This planning branch and draft PR remain the implementation branch/PR.

Do not split preview, tray status, and placement feedback into separate PRs.
