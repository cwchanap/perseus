# HPA-220: Inventory Filters and Shuffle — Design

**Linear:** HPA-220  
**Status:** Design for implementation  
**Date:** 2026-08-13

## Context

HPA-220 adds four inventory filters and one Shuffle action. The repository already contains the intended seams:

- `PuzzleSessionState.trayOrder` is the canonical persisted piece order;
- `InventoryFilter` already defines `all | corners | edges | center`;
- `PersistedTrayOrganization.filter` already stores the active filter;
- `update_tray_organization` already accepts `set_filter` and `reorder`;
- `reorder` deliberately returns `not_implemented` for HPA-220/HPA-237;
- `PuzzleInventoryPanel` is already the concrete inventory presentation boundary;
- the route already checkpoints gameplay/session actions;
- `shuffleArray()` already implements and tests the repository's Fisher–Yates shuffle and is already used by fresh/restart tray ordering.

HPA-220 should finish those seams rather than introduce a second inventory model, a second shuffle implementation, or route-only coordination for behavior that is a session invariant.

## Goals

1. Add **All**, **Corners**, **Edges**, and **Center** inventory filters derived from canonical piece coordinates.
2. Show only unplaced pieces matching the active filter.
3. Keep the active filter in the existing persisted `organization.filter` field.
4. Clear a selected piece atomically when a filter change hides it.
5. Reset the filter to **All** atomically when a hint succeeds so the hinted piece is visible to every `use_hint` caller.
6. Shuffle every unplaced piece, independent of the active filter.
7. Persist the resulting canonical `trayOrder`, preserving already-placed IDs in their current full-order positions.
8. Guarantee that Shuffle changes order whenever at least two unplaced pieces remain.
9. Keep filtering/shuffling outside placement undo/redo and avoid changing timing, rotations, result class, counters, placements, or completion state.
10. Keep HPA-219 drawer behavior and mobile density intact.

## Non-goals

- staging trays, named trays, manual grouping, or multi-select;
- image-content clustering;
- preview-size preferences;
- a generic inventory query/action engine;
- a new inventory store/controller/view-model;
- a new shuffle utility or RNG abstraction;
- persistence schema changes or compatibility migration;
- cloud synchronization or analytics;
- broad accessibility work owned by HPA-223.

## Decision

Finish the existing `PuzzleSession` tray-organization seam.

The implementation has four responsibilities:

1. one pure `matchesInventoryFilter()` helper shared by the engine and inventory panel;
2. session-owned filter invariants, hint reveal, and main-tray reorder validation;
3. controlled filter/Shuffle controls inside `PuzzleInventoryPanel`;
4. route-owned randomness for Shuffle using the existing `shuffleArray()` utility.

No other gameplay state owner is added.

## Coordinate classification

Classification uses each piece's canonical `correctX` / `correctY` plus `gridCols` / `gridRows`. Do not classify from `piece.edges`: degenerate grids such as `1 × N` can have multiple flat visual edges without being corners.

Use one shared helper:

```ts
export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  gridCols: number,
  gridRows: number,
  filter: InventoryFilter
): boolean;
```

Definitions:

- `all`: every piece;
- `corners`: on both a horizontal and vertical boundary;
- `edges`: on exactly the perimeter but not a corner;
- `center`: not on the perimeter.

The categories are mutually exclusive except `all`, which matches everything.

Degenerate grids remain coordinate-driven:

- `1 × 1`: the single piece is a corner;
- `1 × N` / `N × 1`: endpoints are corners and interior cells are edges;
- there is no Center cell unless a coordinate is off every perimeter boundary.

## Filter ownership and atomic selection clearing

The active filter remains canonical session state:

```ts
const activeFilter = sessionState?.organization?.filter ?? 'all';
```

`PuzzleInventoryPanel` receives it as a controlled prop. It does not keep a local filter copy.

`doUpdateTrayOrganization({ type: 'set_filter' })` owns the visibility invariant. Before its single existing `notify()`:

1. assign the new filter to the copied organization;
2. if `selectedPieceId !== null`, resolve that piece from `pieceById`;
3. if the selected piece does not match the new filter, set `selectedPieceId = null`;
4. commit `state.organization`, mark activity, and notify once.

Subscribers must never observe a state where the selected piece is already hidden by the active filter.

Changing to a filter that still contains the selected piece keeps selection.

## Hint reveal is a session invariant

`doUseHint()` already owns successful hint selection, hint counters/facts, the `hint_target` event, and the single state notification. Therefore Hint-to-All belongs there, not in the route.

On a successful hint, before the existing `emit()` / `notify()`:

```ts
if (state.organization?.filter !== undefined && state.organization.filter !== 'all') {
  state.organization = { ...state.organization, filter: 'all' };
}
```

Do not call `doUpdateTrayOrganization()` from `doUseHint()`: that would create a second notification.

The route's `handleHint()` remains exactly one `use_hint` dispatch followed by the existing checkpoint.

This deliberately uses the coarse rule "successful Hint returns to All." Preferring a hinted piece already visible in the current filter is deferred until demonstrated need.

## Shuffle ownership

### Randomness stays outside the engine

The route owns the random candidate order, matching the existing split where runtime code creates fresh/restart tray orders and `PuzzleSession` validates retained state.

Reuse:

```ts
import { shuffleArray } from '$lib/utils/shuffle';
```

Do not add `shufflePieceIds()` and do not change `shuffleArray()`. Changing the shared utility to force non-identity would also change fresh/restart tray behavior.

### Candidate set

Shuffle always uses **all current unplaced IDs in canonical tray order**, not only the pieces visible under the active filter:

```ts
const unplacedPieceIds = sessionState.trayOrder.filter((id) => !placedPieceIds.has(id));
```

For zero or one unplaced piece, the UI disables Shuffle and the handler is a no-op guard.

For two or more:

```ts
const shuffled = shuffleArray(unplacedPieceIds);
if (shuffled.every((id, index) => id === unplacedPieceIds[index])) {
  [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
}
```

The identity fallback exists only at this HPA-220 call site.

Then dispatch:

```ts
{
  type: 'update_tray_organization',
  update: { type: 'reorder', trayId: 'main', pieceIds: shuffled }
}
```

No RNG seed/state is persisted.

## Main-tray reorder semantics

`PuzzleSession` validates; it never generates random order.

For `reorder`:

1. any `trayId !== 'main'` remains `tray_organization_noop / not_implemented` for HPA-237;
2. compute the current unplaced IDs from canonical `state.trayOrder` and `state.placedPieces`;
3. require `update.pieceIds` to be an exact permutation of those unplaced IDs: same length, no duplicates, no unknown IDs, no placed IDs, no omissions;
4. if invalid, return `tray_organization_noop / invalid_update` without mutation or notification;
5. if valid, rebuild `state.trayOrder` by replacing only unplaced slots with the supplied order while leaving placed IDs at their current indices;
6. set `hasUserActivity = true`;
7. notify once and return `tray_organization_applied`.

Example:

```text
current full trayOrder: [0, 1, 2, 3]
placed:                 {1}
Shuffle candidate:      [3, 0, 2]
next full trayOrder:    [3, 1, 0, 2]
```

The placed ID `1` stays in slot 1.

The reorder branch does not create or alter `state.organization`; the filter/membership/name metadata is unrelated to random ordering. The existing serializer already persists `trayOrder`.

Shuffle does not call `pushHistory()`. Placement undo/redo state and availability remain unchanged.

## Inventory panel

`PuzzleInventoryPanel` gains only controlled props/callbacks:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

The panel already receives puzzle metadata, `trayOrder`, and `placedPieces`, so it derives:

```ts
const unplacedPieces = orderedPieces.filter((piece) => !placedPieceIds.has(piece.id));
const visiblePieces = unplacedPieces.filter((piece) =>
  matchesInventoryFilter(piece, puzzle.gridCols, puzzle.gridRows, activeFilter)
);
```

The count remains total unplaced:

```text
N LEFT
```

It does not change to the filtered result count.

An empty filter renders an empty pieces grid. Do not add a special preview/pinned-result surface.

### Controls

Inside `#puzzle-inventory-body`, before `.pieces-grid`, add one `.inventory-tools` row containing:

- ALL
- CORNERS
- EDGES
- CENTER
- SHUFFLE

Every control reuses the existing `.panel-action` class. Do not duplicate the existing coarse-pointer `min-height: 44px` rule.

Filter buttons use `aria-pressed` for the controlled active filter. Shuffle is disabled when `unplacedPieces.length <= 1`.

The tool row is one non-wrapping horizontal row:

```css
.inventory-tools {
  display: flex;
  flex-wrap: nowrap;
  flex-shrink: 0;
  gap: 0.5rem;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
}

.inventory-tools .panel-action {
  flex: 0 0 auto;
}
```

Horizontal scrolling is acceptable on narrow phones; vertical wrapping is not, because the HPA-219 panel is capped at 16rem and must retain useful tray space.

Keep the HPA-219 header unchanged: `INVENTORY`, `N LEFT`, Cancel, and Open/Collapse stay there. Because tools live inside `#puzzle-inventory-body`, collapsing the drawer hides the tools along with the pieces.

Do not change mobile slot sizing, safe-area handling, or drawer state.

## Route wiring

The route does only the orchestration it uniquely owns:

```ts
const activeInventoryFilter = $derived(sessionState?.organization?.filter ?? 'all');
```

`handleFilterChange(filter)` dispatches `set_filter` and checkpoints.

`handleShuffle()`:

1. derives all current unplaced IDs from canonical tray order;
2. returns when fewer than two remain;
3. calls existing `shuffleArray()`;
4. applies the local identity swap if needed;
5. dispatches main-tray `reorder`;
6. checkpoints.

`handleHint()` remains unchanged: one `use_hint` dispatch plus checkpoint. There is no route Hint-to-All follow-up.

## Persistence

No persistence code or schema version changes are required.

Existing V1 persistence already serializes and validates:

- full `trayOrder`;
- optional `organization.filter`.

HPA-220 persists no random seed, RNG state, visible-subset order, alternate tray model, or compatibility data.

## Testing strategy

Use five focused TDD slices:

1. pure coordinate matcher tests, including rectangular and degenerate grids;
2. `PuzzleSession` tests for atomic filter selection clearing, atomic Hint-to-All, main-tray exact-permutation validation, placed-slot preservation, persistence round-trip, and no placement-history/timing changes;
3. `PuzzleInventoryPanel` browser tests for controlled filtering, empty filters, total `N LEFT`, callback wiring, `aria-pressed`, drawer ownership, and Shuffle disabled at 0–1 unplaced;
4. route browser test for filter/shuffle wiring and the non-identity fallback by mocking `Math.random` so the existing Fisher–Yates returns identity;
5. extend the existing HPA-219 390×844 mobile smoke geometry fence so the new non-wrapping tools row still leaves the panel in viewport with at least four visible tray slots.

No new E2E framework or separate scenario is required. The existing mobile drawer test is the correct geometry regression fence.

## Acceptance criteria

- [ ] All/Corners/Edges/Center classification is coordinate-derived and mutually exclusive apart from All.
- [ ] `1 × 1`, `1 × N`, and `N × 1` grids classify correctly.
- [ ] Filters show only unplaced matching pieces and react naturally to placement/undo/redo state updates.
- [ ] A filter change that hides selection clears it before the transition's single notification.
- [ ] A successful Hint resets a non-All filter to All inside `doUseHint()` before its single notification.
- [ ] Shuffle always targets all unplaced IDs, independent of the active filter.
- [ ] With at least two unplaced pieces, Shuffle cannot leave the order unchanged.
- [ ] Main-tray reorder accepts only an exact unplaced permutation and preserves placed IDs in their full-order slots.
- [ ] Non-main reorder remains `not_implemented` for HPA-237.
- [ ] Shuffle does not change placements, timer state, rotations, result class, counters, completion state, or placement undo/redo.
- [ ] Active filter and canonical tray order survive the existing V1 persistence round trip.
- [ ] `N LEFT` remains total unplaced, and empty filters remain empty.
- [ ] Filter/Shuffle controls live inside the drawer body, reuse `.panel-action`, and do not duplicate coarse-pointer touch CSS.
- [ ] At 390×844 the tools remain one row and the existing inventory fit/density smoke contract still passes.
- [ ] No new store/controller/query engine, schema migration, sizing preference, or staging-tray behavior is introduced.
