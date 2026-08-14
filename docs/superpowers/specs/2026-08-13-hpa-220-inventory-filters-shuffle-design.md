# HPA-220: Inventory Filters and Shuffle — Design

**Linear:** HPA-220  
**Status:** Design for implementation  
**Date:** 2026-08-13

## Context

HPA-220 is the next actionable child of HPA-215. HPA-224 and HPA-219 are complete, HPA-218 has already shipped, and HPA-215 places HPA-220 next in the remaining delivery order. Its structural prerequisite, HPA-557, is complete and already gives the inventory a concrete `PuzzleInventoryPanel` boundary.

The repository already contains most of the domain shape this feature needs:

- `PuzzleSessionState.trayOrder` is the canonical persisted piece order;
- `InventoryFilter` already defines `all | corners | edges | center`;
- `PersistedTrayOrganization.filter` already stores the active filter;
- `update_tray_organization` already accepts `set_filter` and `reorder` updates;
- filter updates already participate in normal session persistence;
- `reorder` deliberately returns `not_implemented`, with the engine test naming HPA-220/HPA-237 as the owner of that seam;
- `PuzzleInventoryPanel` already receives `trayOrder`, placement state, selection state, hint state, and explicit callbacks;
- the route already checkpoints after gameplay actions;
- placement undo/redo owns only placement/rotation history and does not include tray organization.

This means HPA-220 does not need a second inventory store, a query engine, or a new persistence schema. The smallest correct design is to finish the existing tray-organization seam and add filtering controls to the existing inventory panel.

## Goals

1. Add All, Corners, Edges, and Center filters derived from each piece's canonical grid coordinates.
2. Keep the active filter in the existing `PuzzleSession` tray-organization state so it survives a normal session checkpoint/reload.
3. Show only unplaced pieces that match the active filter.
4. Refresh visible pieces automatically after placement, undo, and redo from existing reactive session state.
5. Clear a selected piece atomically when a filter change would hide it.
6. Make Hint return the inventory filter to All only when a hint is actually produced, so the hinted piece remains visible.
7. Add one Shuffle action that reorders all currently unplaced pieces and persists the resulting canonical tray order.
8. Keep Shuffle outside board undo/redo and leave placement, timer, rotation, counters, result class, and completion state untouched.
9. Reuse the mobile drawer and responsive preview sizing added by HPA-219.
10. Keep the implementation small enough to understand without introducing reusable inventory infrastructure for features that do not exist.

## Non-goals

- preview-size preferences;
- staging trays or named collections;
- manual grouping or piece membership editing;
- multi-select;
- automatic image/content clustering;
- selected or hinted floating previews;
- a generic inventory query/filter framework;
- a generic shuffle service;
- cloud synchronization;
- analytics or performance instrumentation;
- a persistence migration or schema-version bump;
- undo/redo for filter or shuffle actions;
- HPA-223 keyboard-navigation work;
- HPA-237 staging-tray behavior.

## Options considered

### Option A — Finish the existing tray-organization seam (recommended)

Use `PuzzleSessionState.organization.filter` as the active filter, implement the existing `reorder` tray-organization update for the main tray, and keep the UI inside `PuzzleInventoryPanel`. Add one small coordinate-classification helper shared by the engine and component plus one small shuffle helper for generating a candidate unplaced order.

**Pros**

- reuses the persistence and action contracts already created for HPA-220;
- no duplicate state owner;
- filter selection and selection clearing can happen atomically in the engine;
- shuffle persists through the existing `trayOrder` field;
- placement undo/redo remains unchanged;
- future HPA-237 can extend tray organization without HPA-220 pre-building its UI.

**Cons**

- changing a filter counts as session activity under the existing tray-organization contract; this is already the repository behavior and is not redesigned here.

### Option B — Keep filter local to `PuzzleInventoryPanel`

Store `activeFilter` with `$state` beside `drawerOpen`, while only Shuffle touches `PuzzleSession`.

**Rejected:** the domain already has a persisted `filter` field and a working `set_filter` action. Creating a second ephemeral filter would leave existing state unused and make selection clearing a UI/route coordination problem.

### Option C — Add an inventory store/controller

Create a separate store for filtering, selection visibility, and shuffle.

**Rejected:** it duplicates canonical session state and violates the ticket's explicit KISS guardrails.

### Option D — Reorder only the currently visible filtered subset

Shuffle only pieces matching the active filter.

**Rejected:** the ticket says Shuffle reorders unplaced pieces. Filter-dependent shuffle semantics are harder to explain and persist, and they make the same button behave differently based on an unrelated view setting.

## Decision

Use **Option A**.

`PuzzleSession` remains the only gameplay-state owner. `organization.filter` is the controlled active filter. `trayOrder` remains the canonical full piece permutation. `PuzzleInventoryPanel` renders the filter controls and the filtered projection. The route forwards callbacks, produces a randomized order for all unplaced pieces, and checkpoints the resulting session state.

Two tiny pure helpers are sufficient:

1. coordinate classification/filter matching;
2. non-mutating Fisher-Yates shuffle of piece IDs.

No registry, filter model, inventory view-model, query engine, second store, event bus, or new persistence type is introduced.

## Inventory classification

Create `apps/web/src/lib/services/gameplay/inventory.ts` with one coordinate matcher:

```ts
export function matchesInventoryFilter(
	piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
	gridCols: number,
	gridRows: number,
	filter: InventoryFilter
): boolean
```

Classification is mutually exclusive for the three non-All filters:

```text
onHorizontalBoundary = correctX === 0 || correctX === gridCols - 1
onVerticalBoundary   = correctY === 0 || correctY === gridRows - 1
corner                = onHorizontalBoundary && onVerticalBoundary
perimeter             = onHorizontalBoundary || onVerticalBoundary

corners -> corner
edges   -> perimeter && !corner
center  -> !perimeter
all     -> true
```

This definition handles every supported rectangular grid without depending on piece-image edge metadata.

Degenerate grids remain deterministic:

- 1x1: the only piece is a Corner;
- 1xN or Nx1: both endpoints are Corners and interior pieces are Edges;
- one-dimensional grids have no Center pieces.

The same matcher is used both by `PuzzleInventoryPanel` and by `PuzzleSession` when deciding whether a filter change hides the selected piece. That prevents the UI and engine from drifting on edge/corner semantics without creating a generic filtering subsystem.

## Filter state and selection behavior

### State ownership

The route derives the active filter directly from session state:

```ts
const activeInventoryFilter = $derived(sessionState?.organization?.filter ?? 'all');
```

`PuzzleInventoryPanel` receives `activeFilter` as a controlled prop and emits `onFilterChange(filter)`.

The route dispatches the existing action:

```ts
sessionStore.dispatch({
	type: 'update_tray_organization',
	update: { type: 'set_filter', filter }
});
checkpointSession();
```

There is no panel-local filter state and no compatibility fallback beyond the existing `organization ?? default organization` behavior in `PuzzleSession`.

### Atomic selection clearing

When handling `set_filter`, `PuzzleSession` updates `organization.filter` and checks the current selected piece using `matchesInventoryFilter` and the engine's canonical metadata.

If the selected piece would be hidden by the new filter, set:

```ts
state.selectedPieceId = null;
```

before the single `notify()` call.

If it still matches, keep the selection unchanged. All never hides a selected unplaced piece.

This belongs in the session transition rather than in an after-render Svelte effect: subscribers never observe an impossible state where the filter hides a still-selected piece, and the behavior remains testable without the DOM.

Placed pieces are already excluded from selection by the existing session rules, so filter logic needs no additional placed-piece special case beyond normal inventory rendering.

## Filter UI

`PuzzleInventoryPanel` gets three new props:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

Keep the existing header focused on inventory identity, remaining count, Cancel, and mobile drawer state. Put the new controls at the top of `#puzzle-inventory-body` in one compact `inventory-tools` row so the HPA-219 phone header does not become crowded.

Render four explicit buttons rather than an action registry:

- ALL
- CORNERS
- EDGES
- CENTER

Each button:

- has an accessible name such as `Show all pieces` or `Show corner pieces`;
- uses `aria-pressed={activeFilter === filter}`;
- calls `onFilterChange()` directly;
- uses existing CSS variables and compact visual styling;
- reaches the existing 44px minimum target inside the coarse-pointer media query.

A separate `SHUFFLE` button calls `onShuffle` and is disabled when fewer than two unplaced pieces remain.

The displayed `N LEFT` count continues to mean **total unplaced pieces**, not count in the active filter. Changing the meaning of the existing progress count when switching views would be surprising and unnecessary.

When the mobile drawer is collapsed, the body—including filter/shuffle controls—remains hidden by the existing drawer behavior. Cancel stays in the header exactly as HPA-219 designed it.

## Visible-piece projection

Keep the panel's current canonical ordering pipeline and make the filter explicit:

```text
trayOrder
  -> resolve IDs to puzzle pieces
  -> remove placed pieces
  -> apply active filter
  -> render
```

Do not sort by coordinates or piece IDs after filtering. Filtering preserves the current canonical `trayOrder` so Shuffle has an immediate visible effect and resume renders the same order.

Because `placedPieces`, `trayOrder`, and `activeFilter` are controlled props derived from `sessionState`, placement/undo/redo automatically recompute the visible list. No placement event subscription or inventory cache is added.

## Hint reveal behavior

`PuzzleSession.doUseHint()` remains responsible only for selecting a hint target and counting assistance. It should not know that one UI surface has a filter.

The route already owns the hint presentation bridge (`hint_target` -> `activeHintPieceId` / board target), so it also owns the minimal coordination needed to reveal that piece:

1. dispatch `use_hint`;
2. inspect the returned outcome;
3. only when the outcome is `hint_used`, dispatch `set_filter('all')` if the active filter is not already All;
4. checkpoint once after the action sequence.

If Hint returns `hint_noop` because every piece is placed or gameplay is unavailable, leave the user's filter unchanged.

Returning to All is deliberately simpler than adding a pinned hinted-piece preview or temporarily violating the active filter.

## Shuffle behavior

### Candidate generation

Add to `inventory.ts`:

```ts
export function shufflePieceIds(
	pieceIds: readonly number[],
	random: () => number = Math.random
): number[]
```

Use a non-mutating Fisher-Yates shuffle. Return a fresh array. Empty and one-item inputs retain their natural order.

For two or more pieces, if the generated permutation happens to equal the input, swap the first two output entries. A user pressing Shuffle should observe a reorder when a reorder is possible, and this small deterministic fallback avoids adding retries or probabilistic tests.

The route computes **all currently unplaced IDs in canonical tray order**, not only pieces visible under the active filter, then calls `shufflePieceIds()` and dispatches:

```ts
{
	type: 'update_tray_organization',
	update: {
		type: 'reorder',
		trayId: 'main',
		pieceIds: shuffledUnplacedIds
	}
}
```

If fewer than two pieces remain, the UI disables Shuffle and no dispatch is needed.

### Canonical reorder transition

HPA-220 implements `reorder` only for `trayId === 'main'`. HPA-237 owns future tray-specific ordering semantics.

The engine validates that `update.pieceIds` is an exact permutation of the current unplaced piece IDs:

- same length;
- no duplicates;
- every ID is a known piece;
- no placed piece is included;
- every currently unplaced piece appears exactly once.

Any mismatch returns:

```ts
{ type: 'tray_organization_noop', reason: 'invalid_update' }
```

A non-main `trayId` continues to return `not_implemented` so HPA-220 does not invent staging-tray semantics.

After validation, rebuild the full canonical `state.trayOrder` by walking the old order:

- placed IDs stay in their existing full-order positions;
- each unplaced slot consumes the next ID from the new unplaced permutation.

Example:

```text
old full order:       [5, 2, 9, 1]
placed:               {2}
new unplaced order:   [1, 5, 9]
new full order:       [1, 2, 5, 9]
```

This keeps `trayOrder` a complete puzzle-piece permutation, which matches the existing persistence validator and restart/session contract, while only changing the relative order the inventory can display.

The reorder transition then:

- sets `state.trayOrder`;
- sets `state.hasUserActivity = true` under the existing tray-organization policy;
- emits one normal state notification;
- returns `tray_organization_applied`.

It must **not**:

- call `pushHistory()`;
- start or checkpoint the gameplay clock;
- alter placements;
- alter per-piece rotations or rotation mode;
- alter selected piece;
- alter counters/facts/result class;
- alter completion state;
- change `canUndo` or `canRedo`.

This is what keeps Shuffle separate from board undo/redo.

## Persistence

No schema work is required.

`serializeSession()` already persists:

- `trayOrder` as a full copied array;
- `organization` when present.

The V1 loader already validates both canonical tray order and the four organization filter values. HPA-220 therefore uses the existing current schema directly.

No migration, dual-write, fallback field, compatibility adapter, or schema-version bump is added. Pre-release incompatible data may continue to be discarded by the current validator.

## Component and file boundaries

### `apps/web/src/lib/services/gameplay/inventory.ts`

New small pure helper module:

- `matchesInventoryFilter()` owns the coordinate classification rule;
- `shufflePieceIds()` owns non-mutating candidate-order generation.

It has no Svelte, storage, session, or DOM dependencies.

### `apps/web/src/lib/services/gameplay/inventory.test.ts`

Focused unit coverage for classification and shuffle permutations.

### `apps/web/src/lib/services/gameplay/session/session.ts`

Finish the existing tray-organization seam:

- `set_filter` atomically clears a now-hidden selection;
- `reorder(main, pieceIds)` validates and applies an exact unplaced permutation;
- no placement-history integration.

### `apps/web/src/lib/services/gameplay/session/session.test.ts`

Extend the existing tray-organization tests with selection/filter and reorder invariants plus serialize/load persistence proof.

### `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`

Own only presentation/projection:

- controlled filter prop;
- explicit filter buttons;
- Shuffle button;
- unplaced + filtered projection;
- existing drawer and responsive sizing remain unchanged.

### `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

Cover filtered rendering, pressed state, callbacks, disabled Shuffle, and compatibility with the drawer/selection presentation.

### `apps/web/src/routes/puzzle/[id]/+page.svelte`

Small orchestration changes only:

- derive current filter from `PuzzleSessionState.organization`;
- dispatch/checkpoint filter changes;
- generate and dispatch a shuffled unplaced order;
- reset filter to All after a successful Hint outcome;
- pass the controlled props/callbacks to `PuzzleInventoryPanel`.

No new route state is introduced.

### `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

Add only the route-level behavior that cannot be proven below the route: successful Hint while filtered returns to All and leaves the hinted inventory piece visible. Existing component/session tests own the rest.

## Data flow

### Filtering

```text
Filter button
  -> PuzzleInventoryPanel.onFilterChange(filter)
  -> route handleInventoryFilterChange(filter)
  -> PuzzleSession update_tray_organization(set_filter)
      -> organization.filter = filter
      -> clear selectedPieceId if matcher says it is hidden
  -> session subscription
  -> PuzzleInventoryPanel receives activeFilter + selectedPieceId
  -> derived visible pieces update
```

### Shuffle

```text
Shuffle button
  -> PuzzleInventoryPanel.onShuffle()
  -> route reads sessionState.trayOrder + placedPieces
  -> shufflePieceIds(all unplaced ids)
  -> PuzzleSession update_tray_organization(reorder main)
      -> validate exact unplaced permutation
      -> rebuild canonical full trayOrder
  -> checkpointSession()
  -> persisted V1 trayOrder
  -> panel rerenders in new order
```

### Hint reveal

```text
Hint toolbar action
  -> PuzzleSession use_hint
  -> outcome hint_used(pieceId)
  -> route sets filter All when needed
  -> existing hint_target event drives highlight/board target
  -> checkpoint once
  -> hinted piece is visible in All
```

## Error and invalid-update behavior

This is local gameplay state, so failures are deterministic no-ops rather than user-facing error dialogs.

- Invalid reorder permutation -> `tray_organization_noop / invalid_update`, no mutation, no notification.
- Non-main reorder -> `tray_organization_noop / not_implemented`, preserving HPA-237's future scope.
- Hint no-op -> filter unchanged.
- Filter with zero matches -> valid empty inventory grid; no synthetic fallback to All.
- Shuffle with fewer than two unplaced pieces -> disabled UI, no action.

No retry, toast, telemetry, or exception layer is added.

## Testing strategy

### Pure helper tests

Prove:

- rectangular corners, edges, and center are mutually exclusive;
- square and non-square grids classify correctly;
- 1x1 and 1xN/Nx1 behavior is deterministic;
- All matches every valid piece;
- shuffle does not mutate input;
- shuffle returns an exact permutation;
- 0/1-item inputs stay stable;
- 2+ items produce a changed order even when the injected RNG would otherwise return the identity permutation.

### Session tests

Prove:

- filter update persists through `organization.filter`;
- a matching selected piece survives filter change;
- a hidden selected piece is cleared atomically;
- main reorder accepts an exact permutation of current unplaced IDs;
- duplicate/missing/unknown/placed IDs are rejected;
- non-main reorder remains `not_implemented`;
- placed positions in the full canonical `trayOrder` remain anchored while unplaced order changes;
- reorder leaves placement history flags, timer fields, placements, rotations, counters, facts, result class, and completion state unchanged;
- serialize -> load round-trip preserves the shuffled tray order and active filter.

### Component tests

Prove:

- All/Corners/Edges/Center render the expected unplaced slots in canonical tray order;
- placed pieces remain absent under every filter;
- active filter exposes `aria-pressed=true`;
- filter buttons call the explicit callback;
- Shuffle calls its callback when at least two unplaced pieces remain;
- Shuffle is disabled with zero or one unplaced piece;
- remaining count still reports total unplaced pieces;
- existing Cancel and drawer behavior remain intact.

### Route test

One integration fence is enough:

- begin with a non-All filter;
- invoke Hint;
- verify the route dispatches/reflects All after a real hint and the hinted slot is present/highlighted.

Do not add a new E2E scenario for this ticket unless implementation uncovers browser-only behavior. Classification, persistence, and shuffle are deterministic unit/component concerns, and HPA-219 already established the phone inventory geometry/scroll contract.

## KISS / YAGNI guardrails

- `PuzzleSession` stays the sole canonical gameplay state owner.
- Reuse `InventoryFilter`, `PersistedTrayOrganization`, `TrayOrganizationUpdate`, and `trayOrder`; do not add parallel models.
- No inventory store/controller/view-model.
- No generic action registry for four filter buttons.
- No generic filter/query engine.
- No staging-tray semantics in `reorder` beyond `main`.
- No persistence migration or compatibility layer.
- No undo/redo integration for view filtering or shuffle.
- No random seed/state persistence; only the resulting order is canonical and persisted.
- No new responsive sizing preference; keep HPA-219 sizing.
- No unrelated toolbar, board, accessibility, or visual redesign.

## Acceptance mapping

- **Corner, Edge, Center classification:** one shared coordinate matcher with unit tests.
- **Only unplaced pieces and reactive refresh:** panel projection derives from controlled `placedPieces`, `trayOrder`, and filter props.
- **Selection clearing:** atomic `set_filter` transition in `PuzzleSession`.
- **Hint reveal:** successful route Hint returns filter to All.
- **Shuffle persistence:** existing `reorder(main)` action updates canonical `trayOrder`; existing V1 serializer persists it.
- **No gameplay side effects:** reorder never touches placement history, clock, rotation, result, counters, or completion.
- **Focused tests:** pure helper + session + component + one route integration fence; no new framework or broad E2E matrix.