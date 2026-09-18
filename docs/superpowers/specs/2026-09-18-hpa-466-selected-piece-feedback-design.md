# HPA-466: Selected-Piece Inspection and Placement Feedback — Design

**Linear:** HPA-466  
**Status:** Design for implementation  
**Date:** 2026-09-18

## Context

HPA-466 is the next actionable Perseus ticket: it is High priority, unblocked, and directly improves the core web puzzle loop without requiring backend, persistence, or game-core changes.

The current implementation already has the seams this polish needs:

- `PuzzleInventoryPanel.svelte` owns the tray, selection presentation, rotation controls, fixed filters, and empty-filter message.
- `PuzzleBoard.svelte` owns board-cell hover/drag/focus behavior and routes every placement attempt to the parent without pre-validating correctness.
- `+page.svelte` is the composition root and keeps `PuzzleSession` as the only gameplay state owner.
- `attempt_placement` returns `PuzzleSessionOutcome { type: 'placement', outcome: PlacementOutcome }`, so the board can receive an authoritative accepted/rejected result without adding coordinates to game-core events.
- placement accepted/rejected announcements already come from session events and remain the semantic accessibility feedback.
- rejected tray pieces already have a short presentation-only shake/highlight.

This ticket should finish the visible interaction loop around those seams, not create another gameplay controller, store, animation system, or persistence shape.

## Goals

1. Show a larger selected-piece preview while the tray body is open.
2. Keep the preview synchronized with the selected piece's current displayed rotation.
3. Keep Rotate and Cancel outside the artwork.
4. Show remaining counts for All / Corners / Edges / Center.
5. Replace the dead-end filtered-empty state with an explicit "show all remaining" recovery action.
6. Give an empty board cell a neutral candidate affordance on hover/focus while a piece is selected.
7. Give accepted and rejected placement attempts short, distinct board-cell feedback.
8. Keep rejected selection intact so another cell can be tried immediately.
9. Preserve current session, persistence, hint, rotation, shuffle, keyboard, and completion semantics.
10. Respect reduced-motion without removing the visible accepted/rejected state.

## Non-goals

- correctness previews, magnetic snap, auto-place, neighbor suggestions, or automatic rotation;
- changing `PuzzleSession`, its codec, events, counters, scoring, or completion rules;
- a generic interaction/animation framework;
- a second selected-piece state owner;
- a reusable preview framework or a new piece-rendering component solely for this ticket;
- responsive tray redesign or a selected-piece surface outside the open tray;
- audio, haptics, generated art, backend work, or NativeScript parity;
- changing shuffle semantics or tray ordering.

## Options considered

### Option A — Keep all polish on the existing presentation seams (selected)

Use the current controlled inventory props, return the existing authoritative `PlacementOutcome` through the board callback, and keep all transient visual feedback inside `PuzzleBoard`.

**Pros**

- smallest code surface;
- no new state owner;
- no game-core or schema change;
- every placement path already passes through `PuzzleBoard`;
- accepted/rejected feedback stays tied to the exact attempted cell without extending session events;
- easy to remove or tune later.

**Cons**

- the board callback becomes result-returning instead of fire-and-forget;
- the panel continues to forward that callback type.

### Option B — Add attempted-cell state to the route and correlate session events

Valid, but unnecessary. The ticket allows route-local attempted-cell state because current events omit coordinates, yet `dispatch()` already returns the authoritative `PlacementOutcome`. Adding pending-attempt state would be more moving parts for the same result.

### Option C — Add coordinates to `placement_accepted` / `placement_rejected` events

Rejected. That widens game-core and its event contract for presentation-only feedback.

### Option D — Add a generic animation/feedback controller

Rejected. Two short-lived cell treatments do not justify a framework.

## Decision

Use **Option A**.

The domain remains authoritative. The presentation simply consumes the existing placement result and derives all other UI from current props.

## Selected-piece preview

`PuzzleInventoryPanel` already has:

- `piecesById`;
- `selectedPieceId`;
- `pieceRotations`;
- `rotationEnabled`;
- `resolveImage`;
- header-level Rotate and Cancel actions.

Add one derived selected piece:

```ts
const selectedPiece = $derived(
  selectedPieceId === null ? null : (piecesById.get(selectedPieceId) ?? null)
);
```

Render a compact preview inside `.inventory-body`, before the scrollable pieces grid, only when `selectedPiece !== null`.

The preview:

- uses `resolveImage(selectedPiece)`;
- applies `displayedRotation(selectedPiece.id)`;
- is read-only and supplementary;
- does not duplicate Rotate or Cancel controls;
- disappears automatically when selection clears after accepted placement or explicit cancel;
- is naturally hidden in the existing mobile `peek` state because the body is already hidden.

Do not reuse interactive `PuzzlePiece` for the preview. Its button/drag semantics are appropriate for selectable tray pieces, not a read-only inspection surface. A simple image preview is smaller and avoids adding a "read-only PuzzlePiece" mode.

## Filter counts and exhausted-filter recovery

Continue deriving from canonical unplaced pieces.

For each fixed filter, count:

```ts
unplacedPieces.filter((piece) => matchesInventoryFilter(piece, puzzle, filter)).length
```

No new read model or store is needed.

Presentation:

- All: total unplaced count;
- Corners / Edges / Center: unplaced count in that filter;
- counts update automatically after successful placement;
- active-filter semantics and persisted filter state remain unchanged.

When:

- the puzzle is not complete;
- `activeFilter !== 'all'`; and
- `visiblePieces.length === 0`;

replace `NO PIECES MATCH` with:

- a factual exhausted label such as `ALL CORNERS PLACED`;
- one `SHOW ALL REMAINING` button calling the existing `onFilterChange('all')`.

Do not auto-switch filters.

## Neutral candidate cells

No candidate-cell state is required.

When `selectedPieceId !== null`, mark the board as candidate-enabled. CSS can then style only empty cells on:

- `:hover`;
- `:focus-visible`.

The candidate treatment must remain neutral: it says "this cell can be attempted", never "this is correct".

Existing drag-over styling remains separate and can keep its current behavior.

## Accepted/rejected placement feedback

The board already owns the attempted coordinates for click, keyboard, and drag/drop. Change the placement callback contract from fire-and-forget to returning the existing authoritative result:

```ts
type PlacementCallback = (
  pieceId: number,
  x: number,
  y: number
) => PlacementOutcome | void;
```

`+page.svelte` keeps all gameplay mutation ownership:

```ts
function handlePiecePlaced(pieceId: number, x: number, y: number) {
  if (!sessionStore) return;

  const result = sessionStore.dispatch({
    type: 'attempt_placement',
    pieceId,
    x,
    y
  });

  checkpointSession();

  return result.type === 'placement' ? result.outcome : undefined;
}
```

`PuzzleBoard` consumes only that returned result:

- accepted -> short accepted cell state;
- rejected -> short rejected cell state;
- noop -> no feedback.

This does not move correctness into the component: `PuzzleSession` still decides the outcome.

Keep one board-local feedback value:

```ts
type PlacementFeedback = {
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
};
```

A new attempt replaces the prior feedback. Clear it after a short fixed duration and on component teardown.

The existing route-level rejected-piece state remains responsible for the tray-piece rejection treatment and accessibility announcement. The board feedback is additive presentation only.

## Visual behavior

### Accepted

Use a brief settle/pulse style on the target cell / placed-piece area:

- positive but restrained;
- no large overlay over the artwork;
- no confetti or particle layer.

### Rejected

Use a clearly different attempted-cell treatment:

- brief border/background emphasis;
- no correctness leak before the attempt;
- selected piece remains selected because that is already current session behavior.

### Reduced motion

Under `prefers-reduced-motion: reduce`:

- disable movement/pulse animation;
- keep the accepted/rejected border/background state visible for the same short feedback interval.

The state must remain perceivable even when animation is removed.

## Accessibility

- the selected preview is supplementary; existing accessible piece names and selection/rotation announcements remain authoritative;
- do not add duplicate live-region text for visual feedback;
- candidate styling must include `:focus-visible`, not hover only;
- candidate/accepted/rejected states must differ by more than color alone where practical (border/outline/box-shadow pattern);
- existing placement accepted/rejected live-region announcements remain unchanged;
- filter buttons should expose remaining counts in accessible labels without forcing screen readers to parse decorative count chrome.

## File map

**Modify**

- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Do not modify by default**

- `packages/game-core/**`
- gameplay session persistence / codec files;
- `PuzzlePiece.svelte`;
- E2E helpers/specs;
- backend / API / workflow code;
- mobile code.

## Test strategy

### Inventory component

Prove:

- selecting a piece shows one larger preview;
- rotation updates the preview;
- cancel removes it;
- successful-placement prop changes remove it naturally;
- counts are based on unplaced pieces for all four filters;
- exhausted filtered state shows the filter-specific completion copy and `SHOW ALL REMAINING`;
- recovery calls `onFilterChange('all')`;
- peek still hides the body/preview without creating another surface.

### Board component

Prove:

- selected + empty cell exposes candidate styling on focus/hover state;
- unselected board does not expose candidate styling;
- callback accepted result produces accepted-cell feedback;
- callback rejected result produces rejected-cell feedback;
- noop produces neither;
- a new attempt replaces old feedback;
- rejected attempt does not clear selection (selection remains controlled by props);
- existing keyboard/click/drag routing still forwards all attempts without correctness prevalidation.

### Route integration

Prove:

- `handlePiecePlaced` returns the session's `PlacementOutcome` while still checkpointing;
- accepted placement clears the selected preview through canonical session state;
- rejected placement keeps the selected piece and existing tray rejection/announcement behavior.

No new E2E coverage is required by default; the existing gameplay interaction smoke remains the final regression gate.

## Delivery guardrail

One implementation PR for HPA-466. This planning branch and draft PR are the same branch/PR that implementation will continue on.

Do not split the ticket into separate preview, filter, or placement-feedback PRs.
