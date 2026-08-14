# HPA-220: Inventory Filters and Shuffle — Design

**Linear:** HPA-220  
**Status:** Design for implementation  
**Date:** 2026-08-13

## Context

HPA-220 is the next actionable child of HPA-215. HPA-557 already extracted `PuzzleInventoryPanel`, HPA-219 established the mobile drawer and responsive tray sizing, and the current `PuzzleSession` contract already contains the state seams this feature needs:

- `PuzzleSessionState.trayOrder` is the canonical persisted full tray order;
- `InventoryFilter` already defines `all | corners | edges | center`;
- `PersistedTrayOrganization.filter` already stores the active filter;
- `update_tray_organization` already accepts `set_filter` and `reorder`;
- `reorder` deliberately returns `not_implemented`, with HPA-220/HPA-237 named as the future owners;
- session persistence already serializes and validates `trayOrder` plus the optional organization object;
- `PuzzleInventoryPanel` already receives canonical order, placement, selection, hint, and explicit callbacks;
- `$lib/utils/shuffle.ts` already provides the Fisher–Yates implementation used for initial and restart tray order.

This ticket finishes those seams. It does not add a second inventory model, a new store/controller, a schema version, or another shuffle implementation.

## Goals

1. Add **All**, **Corners**, **Edges**, and **Center** filters derived from canonical piece coordinates.
2. Render only unplaced pieces matching the active filter while keeping `N LEFT` as the total unplaced count.
3. Keep filter state persisted in the existing `organization.filter` field.
4. Clear a selected piece atomically when a new filter hides it.
5. Make a successful Hint atomically return the active filter to All before the existing Hint notification.
6. Shuffle every currently unplaced piece, regardless of the active filter, and persist the resulting full tray order.
7. Preserve placed-piece positions in the full `trayOrder` while reordering the unplaced slots.
8. Keep filter changes out of gameplay-activity semantics; a filter-only session must not lock Mission Setup, trigger restart confirmation, or become resumable progress.
9. Reset the active filter to All on restart while preserving the rest of the organization object for future HPA-237 use.
10. Keep filter/shuffle outside placement undo/redo, timing, scoring/result class, counters, rotations, and completion state.
11. Keep the HPA-219 mobile drawer usable after adding filter controls, with room for at least two rows of piece previews on a 390×844 phone when the inventory is large.
12. Show a small empty-filter message instead of an unexplained blank tray.

## Non-goals

- preview-size preferences;
- staging trays, named collections, manual grouping, or multi-select;
- image-content clustering;
- pinned selected/hinted previews;
- a generic inventory query/action framework;
- a new inventory store, controller, or view-model;
- schema migrations or compatibility work;
- analytics or performance instrumentation;
- changing initial/restart shuffle semantics;
- guaranteeing that a random Shuffle visibly changes every active filtered subset;
- broad accessibility work owned by HPA-223.

## Options considered

### Option A — Finish the current session seams (recommended)

Use one pure coordinate matcher, the existing filter/reorder actions, the existing persisted organization/filter field, and the existing `shuffleArray()` utility. Keep `PuzzleSession` as the validation/state owner and the route as the RNG edge.

**Pros**

- smallest change surface;
- no new persistence shape;
- no duplicated randomization algorithm;
- session invariants stay atomic;
- follows the existing explicit-props/callbacks component architecture.

**Cons**

- `update_tray_organization` continues to contain HPA-237 branches that remain unused here;
- random Shuffle is allowed to return the same ordering, which is normal Fisher–Yates behavior.

### Option B — Add a dedicated inventory store/controller

Rejected. It would duplicate `PuzzleSession` selection, tray order, and persistence responsibilities.

### Option C — Add a generalized tray/query framework

Rejected. Four fixed filters and one shuffle action do not justify a registry, query DSL, command model, or extension system.

### Option D — Guarantee a distinct shuffle with another helper

Rejected for HPA-220. A “distinct full order” guarantee does not guarantee that a filtered projection changes, and making the guarantee filter-aware adds policy and complexity that the ticket does not require. Reuse the existing unbiased shuffle and accept the possibility of identity.

## Decision

Use **Option A**.

The implementation has one new pure module, `services/gameplay/inventory.ts`, containing only the coordinate matcher. `PuzzleSession` owns filter visibility invariants, Hint→All, restart filter reset, and exact main-tray reorder validation/application. The route owns random Shuffle generation through the existing `shuffleArray()`. `PuzzleInventoryPanel` remains controlled presentation.

## Coordinate classification

Classification uses `correctX` / `correctY`, never `piece.edges`. Edge metadata describes jigsaw connector shapes, not canonical board position; a one-column interior piece can have multiple flat sides and still not be a corner.

The matcher takes a grid object instead of two adjacent numeric parameters so `gridRows` and `gridCols` cannot be accidentally swapped at call sites:

```ts
export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  grid: Pick<Puzzle, 'gridCols' | 'gridRows'>,
  filter: InventoryFilter
): boolean
```

Rules:

- `all`: every piece;
- `corners`: on both a horizontal and vertical boundary;
- `edges`: on either boundary but not a corner;
- `center`: not on any boundary.

These rules intentionally make the categories mutually exclusive.

Degenerate grids are explicit:

- `1×1`: the single piece is a corner;
- `1×N` / `N×1`: the two endpoints are corners and interior cells are edges;
- there is no Center piece in a one-dimensional grid.

The same matcher is imported by the session and inventory panel. Do not copy classification logic.

## Filter state and activity semantics

The active filter remains canonical session state through `organization.filter`.

`set_filter`:

1. clone/create the existing organization value;
2. set `organization.filter`;
3. if `selectedPieceId !== null`, look up that piece and run `matchesInventoryFilter()` against the new filter;
4. clear `selectedPieceId` only when the piece becomes hidden;
5. assign the organization;
6. **do not set `hasUserActivity`**;
7. notify once.

This is intentionally different from the other organization mutations. A filter is a presentation preference, not puzzle progress. Marking it as activity would currently:

- hide Mission Setup via `canOpenSetup`;
- make restart require confirmation;
- make `isResumable()` advertise a Continue session with no gameplay progress.

Persistence already serializes `organization` independently of `hasUserActivity`, so a filter-only snapshot can round-trip while remaining non-resumable.

Other existing organization branches retain their current activity semantics. HPA-220 only changes `set_filter` and `reorder` behavior.

## Hint → All is a session invariant

A successful `use_hint` already owns candidate choice, hint counters/facts, the `hint_target` event, and one `notify()`.

Before the existing `hint_target` event and `notify()`:

```ts
if (state.organization && state.organization.filter !== 'all') {
  state.organization = { ...state.organization, filter: 'all' };
}
```

Do not call `doUpdateTrayOrganization()` from `doUseHint()` and do not dispatch a second `set_filter` from the route. Subscribers must observe one state transition where the hinted piece and All filter are already consistent.

If there is no hint candidate (`all_placed`), the filter is unchanged because no hint was produced.

The Hint strategy remains coarse: always reveal through All. Preferring a hinted piece already visible under the current filter is deferred until demonstrated useful.

## Shuffle semantics

### Randomization owner

The route owns RNG, matching the existing boundary used for initial/restart tray order.

```ts
const unplacedPieceIds = sessionState.trayOrder.filter((id) => !placedPieceIds.has(id));
const shuffled = shuffleArray([...unplacedPieceIds]);
sessionStore.dispatch({
  type: 'update_tray_organization',
  update: { type: 'reorder', trayId: 'main', pieceIds: shuffled }
});
checkpointSession();
```

`shuffleArray()` currently accepts a mutable-array parameter even though it returns a copy, so the route supplies a shallow copy rather than changing the shared utility signature.

The route does not add another Fisher–Yates implementation, an RNG parameter, a seed, or an identity-swap fallback.

`shuffleArray()` may return the same order. HPA-220 defines Shuffle as a random permutation request, not a guarantee that every active filtered projection changes. This is especially relevant under a non-All filter: the full canonical order may change while the visible subset keeps the same relative order, and HPA-220 intentionally does not add filter-aware reshuffle policy.

The Shuffle control is disabled when fewer than two unplaced pieces remain.

### Session validation and full-order rewrite

For `reorder`:

- only `trayId === 'main'` is implemented;
- non-main reorder remains `tray_organization_noop / not_implemented` for HPA-237;
- supplied `pieceIds` must be an exact permutation of all currently unplaced IDs: same count, no duplicate, no placed ID, no unknown/missing ID;
- validation completes before mutating state;
- invalid input returns `invalid_update` with no state mutation and no notification;
- valid input rewrites only the unplaced slots of the full `state.trayOrder` in order, leaving every placed ID at its existing full-order index.

Example:

```text
current full order:   [3, 1, 0, 2]
placed:               {1}
shuffle payload:      [2, 3, 0]
next full order:      [2, 1, 3, 0]
```

A valid reorder compares the next full order with the current one. Set `hasUserActivity = true` only when at least one full-order position actually changed. An identity shuffle therefore does not fabricate resumable progress.

`reorder` must not call `pushHistory()`.

The placement history snapshot currently contains only:

- `placedPieces`;
- `pieceRotations`;
- `rotationEnabled`.

That is the intended boundary. Do not add `trayOrder` to placement history as part of HPA-220: Undo/Redo placement actions refresh the filtered projection from canonical placement state but never revert a shuffle.

## Restart semantics

Restart currently retains the organization object. HPA-220 keeps that future-facing behavior but resets only its active filter:

```ts
state.organization = retainedOrganization
  ? { ...retainedOrganization, filter: 'all' }
  : null;
```

This preserves future tray membership/names/active-tray fields while preventing a new run from reopening under a stale Corners/Edges/Center filter with a near-empty-looking inventory.

Configure Setup after restart does not overwrite organization, so the All reset survives the route's existing restart flow.

## Inventory panel

### Controlled props

Add:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

The component owns no filter or shuffle state.

### Projection

Derive:

1. pieces in canonical `trayOrder`;
2. remove placed pieces;
3. filter with `matchesInventoryFilter(piece, puzzle, activeFilter)`.

Placement, Undo, and Redo already change the `placedPieces` prop, so the projection refreshes without another store or effect.

`N LEFT` remains `puzzle.pieceCount - placedPieces.length`, independent of the active filter.

### Controls

Inside `#puzzle-inventory-body`, before `.pieces-grid`, render one `.inventory-tools` row:

- ALL
- CORNERS
- EDGES
- CENTER
- SHUFFLE

All five controls reuse the component's existing `.panel-action` class, including its coarse-pointer 44px minimum target. Do not duplicate that rule.

Filter buttons expose `aria-pressed`. Shuffle is disabled with 0–1 unplaced pieces.

The row is one line, `flex-wrap: nowrap`, with `overflow-x: auto`. It disappears with the existing drawer body when collapsed. Cancel and Open/Collapse stay in the HPA-219 header.

### Empty filter

When unplaced pieces remain but the active filter matches none, render:

```text
NO PIECES MATCH
```

This is a simple in-body status line, not a pinned preview or secondary inventory surface. When all pieces are placed, keep the existing `ALL PIECES PLACED` message instead.

## Mobile drawer budget

The existing mobile panel is capped at `16rem`. Adding a 44px tool row plus its padding reduces the piece grid enough that the existing four-piece smoke can still pass while certifying only one visible row.

HPA-220 makes the density cost explicit and raises the mobile cap to **20rem**:

```css
@media (max-width: 1023px) {
  .inventory-panel {
    --piece-slot-size: clamp(3rem, 16vw, 4.5rem);
    max-height: 20rem;
  }
}
```

Desktop remains unchanged because the existing `min-width: 1024px` rule removes the max-height.

The authoritative mobile proof uses the existing 390×844 Chromium-mobile E2E and the existing `e2e-square-100` large inventory fixture. It must prove both:

1. the inventory panel bottom is at or above the viewport bottom;
2. after subtracting `.pieces-grid` vertical padding, its available content height fits at least **two complete piece rows plus one row gap**.

The existing four-piece density assertion remains useful for horizontal density, but it is not the height-budget fence.

No preview-size preference is added.

## Route wiring

The route derives:

```ts
const activeInventoryFilter = $derived<InventoryFilter>(
  sessionState?.organization?.filter ?? 'all'
);
```

Filter callback:

```ts
function handleInventoryFilterChange(filter: InventoryFilter) {
  sessionStore?.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter }
  });
  checkpointSession();
}
```

Shuffle callback:

- collect all unplaced IDs from canonical full tray order;
- if fewer than two remain, no-op defensively;
- pass a shallow copy to existing `shuffleArray()`;
- dispatch one main-tray `reorder`;
- checkpoint.

`handleHint()` remains exactly dispatch + checkpoint. There is no route-level Hint/filter coordination.

## Persistence

No schema change.

Existing V1 fields already persist:

- `trayOrder`;
- optional `organization.filter`.

Tests prove:

- a filter-only snapshot round-trips with `hasUserActivity === false`;
- a changed shuffle order round-trips;
- an identity reorder does not fabricate activity;
- restart returns the filter to All.

## Testing strategy

### Pure helper

`inventory.test.ts` covers:

- rectangular corner/edge/center classification;
- one-dimensional endpoints/interiors;
- 1×1;
- All;
- the grid-object signature on a non-square grid.

### PuzzleSession

Focused session tests cover:

- filter update persists but does not mark activity;
- selection retained when visible;
- selection cleared atomically when hidden;
- successful Hint resets a non-All filter to All before the single subscriber notification;
- restart resets filter to All while preserving the other organization fields;
- valid main reorder preserves placed indices and non-tray state;
- identity reorder leaves activity unchanged;
- invalid permutations are rejected without mutation;
- non-main reorder remains not implemented;
- filter + shuffled tray order serialize/load correctly;
- placement Undo/Redo does not revert tray order.

### Component

Focused component tests cover:

- filtered unplaced projection;
- all four filter callback values;
- `aria-pressed` state;
- Shuffle callback and disabled state at 0–1 unplaced;
- `N LEFT` stays total unplaced;
- empty filter shows `NO PIECES MATCH`;
- completed inventory still shows `ALL PIECES PLACED`;
- tools live inside the drawer body and disappear when collapsed;
- existing Cancel/header behavior remains unchanged.

### Route

Focused route tests cover only route-owned behavior:

- controlled filter derived from session state;
- filter callback dispatch + checkpoint without activity;
- changed Shuffle uses all unplaced IDs and checkpoints the new order;
- identity Shuffle leaves `hasUserActivity` false.

Hint→All stays a session test, not a route coordination test.

### Mobile E2E

Extend the existing HPA-219 Chromium-mobile test on `e2e-square-100` to assert the real two-row grid-height budget and panel fit at 390×844. Keep the existing four-piece horizontal-density assertion.

## Acceptance criteria

- [ ] All/Corners/Edges/Center classification is coordinate-based and mutually exclusive for supported square, rectangular, and one-dimensional grids.
- [ ] Filters render only matching unplaced pieces and update automatically after placement, Undo, and Redo.
- [ ] `N LEFT` remains total unplaced.
- [ ] A filter change atomically clears a selected piece only when the piece becomes hidden.
- [ ] Filter changes persist but do not mark `hasUserActivity` or create resumable progress by themselves.
- [ ] Successful Hint atomically resets a non-All filter to All inside `PuzzleSession` before its existing notification.
- [ ] Restart resets the active filter to All while retaining other organization fields.
- [ ] Shuffle uses the existing `shuffleArray()` and all currently unplaced IDs, independent of the active filter.
- [ ] Main-tray reorder accepts only an exact permutation of current unplaced IDs and preserves placed IDs at their existing full-order indices.
- [ ] A reorder marks activity only when the full canonical tray order actually changes.
- [ ] A random identity Shuffle is valid and does not fabricate gameplay activity.
- [ ] Shuffle/reorder does not change placements, timer, rotations, result class, counters, completion state, or placement Undo/Redo history.
- [ ] Non-main reorder remains `not_implemented` for HPA-237.
- [ ] Empty filters show `NO PIECES MATCH`; all-placed state keeps its existing completion copy.
- [ ] Filter/Shuffle controls reuse `.panel-action` and stay inside the collapsible drawer body.
- [ ] At 390×844, a large open inventory fits in the viewport and preserves vertical room for at least two complete piece rows.
- [ ] No new store/controller/query framework, schema migration, preview-size preference, or second shuffle implementation is introduced.

## Risks and mitigations

### Filter accidentally becomes gameplay progress

Mitigation: `set_filter` explicitly leaves `hasUserActivity` unchanged and has a regression test.

### Hint exposes a target hidden by the current filter

Mitigation: reset filter to All inside the successful Hint transition before the existing event/notify.

### Reorder corrupts canonical tray order

Mitigation: exact current-unplaced permutation validation before mutation; placed IDs remain in their existing full-order slots.

### Undo later starts reverting Shuffle

Mitigation: keep `trayOrder` out of `PlacementHistoryState` and add a test proving Undo/Redo leaves shuffled order intact.

### Mobile tools consume the drawer

Mitigation: one non-wrapping horizontally scrolling tool row, mobile cap raised to 20rem, and the existing 390×844 large-inventory test asserts two complete piece rows of vertical budget.

### Random shuffle appears unchanged

Mitigation: accept standard Fisher–Yates identity as valid random behavior and avoid marking activity when the full canonical order is unchanged. Do not add filter-aware reshuffle policy until real usage demonstrates a need.
