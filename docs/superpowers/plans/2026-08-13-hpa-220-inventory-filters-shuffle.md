# HPA-220 Inventory Filters and Shuffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted All/Corners/Edges/Center filtering and a persisted non-identity Shuffle for all unplaced pieces, using the existing `PuzzleSession` tray-organization seam.

**Architecture:** `inventory.ts` contains only one shared coordinate matcher. `PuzzleSession` owns filter invariants, Hint-to-All, and validated main-tray reorder; the route owns randomness by reusing the existing `shuffleArray()` utility and adding the HPA-220-only identity fallback. `PuzzleInventoryPanel` is a controlled presentation surface and reuses HPA-219's drawer/action styling.

**Tech Stack:** TypeScript, Svelte 5, Vitest browser tests, Playwright mobile smoke, existing `PuzzleSession` V1 persistence.

## Global Constraints

- `PuzzleSession` remains the only canonical gameplay state owner.
- Reuse existing `InventoryFilter`, `PersistedTrayOrganization`, `TrayOrganizationUpdate`, and `trayOrder`.
- Filters are exactly `all | corners | edges | center`.
- Classification uses canonical `correctX` / `correctY`, never `piece.edges`.
- Corners and Edges are mutually exclusive; Center means non-perimeter.
- Successful Hint resets a non-All filter to All inside `doUseHint()` before its existing single `notify()`.
- Shuffle targets every current unplaced ID, not only the visible filter subset.
- Reuse `$lib/utils/shuffle`; do not add a second Fisher–Yates implementation or change shared shuffle semantics.
- The route owns random candidate generation; `PuzzleSession` only validates/applies the candidate.
- With two or more unplaced IDs, the HPA-220 Shuffle action must not return identity order.
- Main-tray reorder preserves placed IDs at their current full-order indices.
- Non-main `reorder` remains `not_implemented` for HPA-237.
- Filter/shuffle actions do not enter placement undo/redo and do not change timer state, rotations, result class, counters, placements, or completion state.
- `N LEFT` remains total unplaced, not filtered-visible count.
- Empty filters remain empty; do not add pinned/hinted preview surfaces.
- Filter/Shuffle controls live inside `#puzzle-inventory-body`, not the HPA-219 header.
- Reuse `.panel-action` and its existing coarse-pointer 44px rule; do not duplicate touch-target CSS.
- Keep the tools in one non-wrapping horizontally scrollable row so the 16rem mobile tray retains piece space.
- Do not add preview-size preferences, staging trays, analytics, schema migration, an inventory store/controller/view-model, or a generic query/action framework.

---

## File map

**Create**

- `apps/web/src/lib/services/gameplay/inventory.ts` — pure shared coordinate matcher only.
- `apps/web/src/lib/services/gameplay/inventory.test.ts` — matcher unit tests.

**Modify**

- `apps/web/src/lib/services/gameplay/session/session.ts` — atomic filter selection clearing, atomic Hint-to-All, validated main-tray reorder.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — session invariant/reorder/persistence tests.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — controlled filter tools, filtered projection, Shuffle button, one-row tools CSS.
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — component behavior and disabled-state tests.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — derive active filter, dispatch filter changes, generate Shuffle candidate with existing `shuffleArray()`.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — route wiring and non-identity fallback test.
- `apps/web/e2e/gameplay-mobile-tap.spec.ts` — extend the existing 390×844 inventory geometry fence; do not add a new scenario.

**Do not modify by default**

- `apps/web/src/lib/services/gameplay/session/types.ts` — required filter/reorder contracts already exist.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — V1 already persists/validates filter + full tray order.
- `apps/web/src/lib/utils/shuffle.ts` — shared fresh/restart shuffle semantics must remain unchanged.
- `apps/web/src/lib/utils/__tests__/shuffle.svelte.test.ts` — no shared utility behavior changes.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — no piece interaction changes.
- `apps/web/src/routes/layout.css` — HPA-219 mobile sizing/touch behavior remains intact.

---

### Task 1: Add the shared coordinate matcher

**Files:**
- Create: `apps/web/src/lib/services/gameplay/inventory.ts`
- Create: `apps/web/src/lib/services/gameplay/inventory.test.ts`

**Interfaces:**
- Consumes: `InventoryFilter` and a piece's canonical `correctX` / `correctY`.
- Produces:

```ts
export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  gridCols: number,
  gridRows: number,
  filter: InventoryFilter
): boolean;
```

- The engine uses it to decide whether a filter hides the selected piece.
- The panel uses it to derive visible unplaced pieces.

- [ ] **Step 1: Write failing classification tests**

Create `apps/web/src/lib/services/gameplay/inventory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchesInventoryFilter } from './inventory';

function matchingSpecificFilters(x: number, y: number, cols: number, rows: number) {
  return (['corners', 'edges', 'center'] as const).filter((filter) =>
    matchesInventoryFilter({ correctX: x, correctY: y }, cols, rows, filter)
  );
}

describe('matchesInventoryFilter', () => {
  it('classifies a rectangular grid from coordinates', () => {
    expect(matchingSpecificFilters(0, 0, 4, 3)).toEqual(['corners']);
    expect(matchingSpecificFilters(3, 2, 4, 3)).toEqual(['corners']);
    expect(matchingSpecificFilters(1, 0, 4, 3)).toEqual(['edges']);
    expect(matchingSpecificFilters(0, 1, 4, 3)).toEqual(['edges']);
    expect(matchingSpecificFilters(1, 1, 4, 3)).toEqual(['center']);
  });

  it('treats 1x1 as one corner', () => {
    expect(matchingSpecificFilters(0, 0, 1, 1)).toEqual(['corners']);
  });

  it('treats one-dimensional endpoints as corners and interior cells as edges', () => {
    expect(matchingSpecificFilters(0, 0, 1, 4)).toEqual(['corners']);
    expect(matchingSpecificFilters(0, 1, 1, 4)).toEqual(['edges']);
    expect(matchingSpecificFilters(0, 3, 1, 4)).toEqual(['corners']);

    expect(matchingSpecificFilters(0, 0, 4, 1)).toEqual(['corners']);
    expect(matchingSpecificFilters(1, 0, 4, 1)).toEqual(['edges']);
    expect(matchingSpecificFilters(3, 0, 4, 1)).toEqual(['corners']);
  });

  it('matches every coordinate for All', () => {
    expect(matchesInventoryFilter({ correctX: 1, correctY: 1 }, 4, 3, 'all')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
```

Expected: FAIL because `./inventory` does not exist.

- [ ] **Step 3: Implement only the matcher**

Create `inventory.ts`:

```ts
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
import type { PuzzlePiece } from '$lib/types/puzzle';

export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  gridCols: number,
  gridRows: number,
  filter: InventoryFilter
): boolean {
  if (filter === 'all') return true;

  const onHorizontalBoundary = piece.correctX === 0 || piece.correctX === gridCols - 1;
  const onVerticalBoundary = piece.correctY === 0 || piece.correctY === gridRows - 1;
  const isCorner = onHorizontalBoundary && onVerticalBoundary;
  const isPerimeter = onHorizontalBoundary || onVerticalBoundary;

  if (filter === 'corners') return isCorner;
  if (filter === 'edges') return isPerimeter && !isCorner;
  return !isPerimeter;
}
```

Do not add shuffle code or RNG injection here.

- [ ] **Step 4: Run the focused test**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/gameplay/inventory.ts \
  apps/web/src/lib/services/gameplay/inventory.test.ts
git commit -m "feat(web): classify inventory pieces"
```

---

### Task 2: Make filter, Hint, and main-tray reorder atomic session behavior

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` from Task 1 and existing `update_tray_organization` actions.
- Produces:
  - `set_filter` clears selection before its single notification when the new filter hides the selected piece;
  - successful `use_hint` resets a non-All filter to All before its existing event/notification;
  - `reorder(main, pieceIds)` accepts only an exact permutation of current unplaced IDs and rewrites only unplaced positions in `state.trayOrder`;
  - non-main reorder remains `not_implemented`.

- [ ] **Step 1: Add an explicit 3×3 metadata fixture for filter tests**

Do not use the existing `makeMetadata(9)` helper if it produces a one-column grid. Add a local fixture in `session.test.ts`:

```ts
function makeThreeByThreeMetadata(): PuzzleMetadata {
  return {
    puzzleId: 'pz1',
    source: 'api',
    pieceCount: 9,
    gridCols: 3,
    gridRows: 3,
    pieces: Array.from({ length: 9 }, (_, id) => ({
      id,
      correctX: id % 3,
      correctY: Math.floor(id / 3)
    }))
  };
}
```

- [ ] **Step 2: Write failing atomic selection/filter tests**

```ts
it('keeps selection when the new filter still contains the selected piece', () => {
  const session = createPuzzleSession(makeOptions({ metadata: makeThreeByThreeMetadata() }));
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 0 });

  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  expect(session.getState().selectedPieceId).toBe(0);
});

it('clears selection in the same filter transition when the new filter hides it', () => {
  const session = createPuzzleSession(makeOptions({ metadata: makeThreeByThreeMetadata() }));
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 4 });

  let notifications = 0;
  session.subscribe(() => notifications++);

  const outcome = session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  expect(outcome.type).toBe('tray_organization_applied');
  expect(session.getState().organization?.filter).toBe('corners');
  expect(session.getState().selectedPieceId).toBeNull();
  expect(notifications).toBe(1);
});
```

- [ ] **Step 3: Write a failing Hint-to-All single-notification test**

```ts
it('reveals a successful hint by resetting the filter to All before one notification', () => {
  const session = createPuzzleSession(makeOptions({ metadata: makeThreeByThreeMetadata() }));
  session.dispatch({ type: 'start' });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  let notifications = 0;
  session.subscribe(() => notifications++);

  const outcome = session.dispatch({ type: 'use_hint' });

  expect(outcome.type).toBe('hint_used');
  expect(session.getState().organization?.filter).toBe('all');
  expect(session.getState().counters.hintsUsed).toBe(1);
  expect(notifications).toBe(1);
});
```

Do not test this as two route dispatches; that behavior must not exist.

- [ ] **Step 4: Replace the placeholder reorder test with failing main-tray validation tests**

Use the existing four-piece session fixture. Place piece `1`, whose canonical cell is `(1, 0)`, then prove a valid reorder preserves its full-order slot:

```ts
it('reorders only unplaced positions in the main tray', () => {
  const { session } = startedSession();
  session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
  const before = session.getState();
  const invariants = {
    placedPieces: before.placedPieces,
    elapsedActiveSeconds: before.elapsedActiveSeconds,
    timerStarted: before.timerStarted,
    rotationEnabled: before.rotationEnabled,
    pieceRotations: before.pieceRotations,
    counters: before.counters,
    facts: before.facts,
    resultClass: before.resultClass,
    canUndo: before.canUndo,
    canRedo: before.canRedo
  };

  const outcome = session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [3, 0, 2] }
  });

  expect(outcome.type).toBe('tray_organization_applied');
  expect(session.getState().trayOrder).toEqual([3, 1, 0, 2]);
  expect({
    placedPieces: session.getState().placedPieces,
    elapsedActiveSeconds: session.getState().elapsedActiveSeconds,
    timerStarted: session.getState().timerStarted,
    rotationEnabled: session.getState().rotationEnabled,
    pieceRotations: session.getState().pieceRotations,
    counters: session.getState().counters,
    facts: session.getState().facts,
    resultClass: session.getState().resultClass,
    canUndo: session.getState().canUndo,
    canRedo: session.getState().canRedo
  }).toEqual(invariants);
});

it.each([
  [0, 2],
  [0, 2, 2],
  [0, 2, 999],
  [0, 1, 2]
])('rejects invalid main-tray unplaced reorder %j', (pieceIds) => {
  const { session } = startedSession();
  session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
  const before = session.getState().trayOrder.slice();

  expect(
    session.dispatch({
      type: 'update_tray_organization',
      update: { type: 'reorder', trayId: 'main', pieceIds }
    })
  ).toEqual({ type: 'tray_organization_noop', reason: 'invalid_update' });
  expect(session.getState().trayOrder).toEqual(before);
});

it('leaves non-main reorder for HPA-237', () => {
  const { session } = startedSession();

  expect(
    session.dispatch({
      type: 'update_tray_organization',
      update: { type: 'reorder', trayId: 'group-a', pieceIds: [3, 2, 1, 0] }
    })
  ).toEqual({ type: 'tray_organization_noop', reason: 'not_implemented' });
});
```

- [ ] **Step 5: Add a failing persistence round-trip test**

Use the existing `serializeSession`, `loadPersistedSession`, and `contextFromMetadata` helpers:

```ts
it('round-trips the active filter and canonical shuffled tray order', () => {
  const metadata = makeMetadata(4);
  const session = createPuzzleSession(makeOptions({ metadata }));
  session.dispatch({ type: 'start' });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'edges' }
  });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [3, 2, 1, 0] }
  });

  const serialized = serializeSession(session.getState(), 123);
  expect(serialized).not.toBeNull();

  const loaded = loadPersistedSession(
    JSON.stringify(serialized),
    contextFromMetadata(metadata)
  );

  expect(loaded.status).toBe('loaded');
  if (loaded.status !== 'loaded') return;
  expect(loaded.snapshot.organization?.filter).toBe('edges');
  expect(loaded.snapshot.trayOrder).toEqual([3, 2, 1, 0]);
});
```

- [ ] **Step 6: Run the focused session tests and confirm they fail on current behavior**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: the new filter/hint/reorder cases FAIL before implementation.

- [ ] **Step 7: Implement atomic filter clearing and Hint-to-All**

Import the matcher in `session.ts`:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
```

In `set_filter`, after setting the copied filter and before the common commit/notify:

```ts
case 'set_filter': {
  organization.filter = update.filter;
  if (state.selectedPieceId !== null) {
    const selectedPiece = pieceById.get(state.selectedPieceId);
    if (
      selectedPiece &&
      !matchesInventoryFilter(selectedPiece, state.gridCols, state.gridRows, update.filter)
    ) {
      state.selectedPieceId = null;
    }
  }
  break;
}
```

In `doUseHint()`, after updating hint counters/facts/result class and before `emit({ type: 'hint_target', ... })`:

```ts
if (state.organization && state.organization.filter !== 'all') {
  state.organization = { ...state.organization, filter: 'all' };
}
```

Do not call `doUpdateTrayOrganization()` from `doUseHint()`.

- [ ] **Step 8: Implement exact main-tray unplaced reorder with an early return**

Inside the `reorder` branch, keep non-main behavior deferred and do not assign the copied `organization` for a reorder:

```ts
case 'reorder': {
  if (update.trayId !== 'main') {
    return { type: 'tray_organization_noop', reason: 'not_implemented' };
  }

  const placedIds = new Set(state.placedPieces.map((placement) => placement.pieceId));
  const currentUnplaced = state.trayOrder.filter((id) => !placedIds.has(id));

  if (update.pieceIds.length !== currentUnplaced.length) {
    return { type: 'tray_organization_noop', reason: 'invalid_update' };
  }

  const remaining = new Set(currentUnplaced);
  for (const id of update.pieceIds) {
    if (!remaining.delete(id)) {
      return { type: 'tray_organization_noop', reason: 'invalid_update' };
    }
  }
  if (remaining.size !== 0) {
    return { type: 'tray_organization_noop', reason: 'invalid_update' };
  }

  let nextUnplacedIndex = 0;
  state.trayOrder = state.trayOrder.map((id) =>
    placedIds.has(id) ? id : update.pieceIds[nextUnplacedIndex++]!
  );
  state.hasUserActivity = true;
  notify();
  return { type: 'tray_organization_applied', update };
}
```

This branch intentionally returns before `state.organization = organization`, so random ordering persists through `trayOrder` only.

Do not call `pushHistory()` and do not start the clock.

- [ ] **Step 9: Run the focused session tests**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/services/gameplay/session/session.ts \
  apps/web/src/lib/services/gameplay/session/session.test.ts
git commit -m "feat(web): enforce inventory session invariants"
```

---

### Task 3: Add controlled filter and Shuffle controls to the inventory panel

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` and canonical session props.
- Adds props:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

- Produces one controlled tools row inside `#puzzle-inventory-body`.

- [ ] **Step 1: Extend the component test fixture with controlled callbacks**

Update `baseProps()`:

```ts
activeFilter: 'all' as const,
onFilterChange: vi.fn(),
onShuffle: vi.fn(),
```

Add a local 3×3 puzzle fixture whose IDs map row-major to canonical coordinates. The visual `edges` values may be static test data; classification assertions must depend only on coordinates.

- [ ] **Step 2: Write failing filter projection tests**

For the 3×3 fixture, rerender the controlled `activeFilter` prop and assert:

```ts
// All: 9 visible
expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(9);

// Corners: ids 0,2,6,8
// Edges: ids 1,3,5,7
// Center: id 4
```

Also place one corner and prove:

- it is absent from every filter because only unplaced pieces render;
- `N LEFT` reports `8 LEFT`, even when Center shows only one piece.

Add a case where the active filter has no matching unplaced pieces and assert the pieces grid is empty without a new pinned/preview message.

- [ ] **Step 3: Write failing callback/accessibility tests**

Assert:

```ts
await page.getByRole('button', { name: 'CORNERS' }).click();
expect(input.onFilterChange).toHaveBeenCalledWith('corners');

await page.getByRole('button', { name: 'SHUFFLE' }).click();
expect(input.onShuffle).toHaveBeenCalledOnce();
```

Rerender with `activeFilter: 'edges'` and assert the EDGES button has `aria-pressed="true"` while the others are false.

- [ ] **Step 4: Write failing Shuffle disabled tests**

Prove Shuffle is:

- enabled with 2+ unplaced pieces;
- disabled with exactly 1 unplaced piece;
- disabled with 0 unplaced pieces.

Do not disable Shuffle because a filter happens to show 0 or 1 piece; the button depends on total unplaced count.

- [ ] **Step 5: Write a failing drawer-ownership test for the tools row**

Add `data-testid="inventory-tools"` to the planned row and assert it is visible while open and not visible after the existing drawer toggle collapses `#puzzle-inventory-body`. Cancel must remain in the header exactly as HPA-219 already tests.

- [ ] **Step 6: Run the component test and confirm the new cases fail**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because the new props/controls/projection do not exist.

- [ ] **Step 7: Implement the controlled projection**

Import:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
```

Add the controlled props and derive:

```ts
const unplacedPieces = $derived(
  orderedPieces.filter((piece) => !placedPieceIds.has(piece.id))
);

const visiblePieces = $derived(
  unplacedPieces.filter((piece) =>
    matchesInventoryFilter(piece, puzzle.gridCols, puzzle.gridRows, activeFilter)
  )
);
```

Render `visiblePieces` directly; remove the inner `#if !placedPieceIds.has(piece.id)` branch because unplaced filtering is now explicit.

Keep the existing `N LEFT` calculation based on total placements.

- [ ] **Step 8: Add the tools row inside `#puzzle-inventory-body`**

Before `.pieces-grid`:

```svelte
<div class="inventory-tools" data-testid="inventory-tools">
  {#each ['all', 'corners', 'edges', 'center'] as filter}
    <button
      type="button"
      class="panel-action"
      aria-pressed={activeFilter === filter}
      onclick={() => onFilterChange(filter)}
    >
      {filter.toUpperCase()}
    </button>
  {/each}

  <button
    type="button"
    class="panel-action"
    disabled={unplacedPieces.length <= 1}
    onclick={onShuffle}
  >
    SHUFFLE
  </button>
</div>
```

If Svelte/TypeScript widens the array to `string[]`, define a typed script constant instead:

```ts
const inventoryFilters: readonly InventoryFilter[] = ['all', 'corners', 'edges', 'center'];
```

Do not move Shuffle into the header unless the existing 390×844 smoke geometry fails after the non-wrapping row is implemented.

- [ ] **Step 9: Reuse `.panel-action`; add only row/pressed/disabled styling**

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

.panel-action[aria-pressed='true'] {
  color: var(--accent);
  border-color: var(--accent);
}

.panel-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
```

Do not add another `@media (pointer: coarse)` rule. The existing `.panel-action` rule already provides the 44px touch target.

- [ ] **Step 10: Run the focused component test**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "feat(web): add inventory filter controls"
```

---

### Task 4: Wire persisted filters and route-owned Shuffle

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: existing `shuffleArray()` and Task-2/3 session/component contracts.
- Produces:
  - route-derived `activeInventoryFilter`;
  - `handleInventoryFilterChange(filter)`;
  - `handleInventoryShuffle()` with local non-identity fallback.
- `handleHint()` remains one dispatch + checkpoint with no filter glue.

- [ ] **Step 1: Write a failing route wiring test for filter and Shuffle**

Use the existing default two-piece route fixture and `renderPuzzlePage()` helper.

The default 2×1 puzzle has two corner pieces. Assert:

1. clicking CENTER removes both tray slots;
2. clicking ALL restores them;
3. `N LEFT` remains `2 LEFT` throughout;
4. Shuffle changes `[0, 1]` to `[1, 0]` when `Math.random` is forced to a value that makes the existing Fisher–Yates return identity.

Example core of the test:

```ts
await renderPuzzlePage();

await page.getByRole('button', { name: 'CENTER' }).click();
await expect.poll(() => document.querySelectorAll('[data-testid^="piece-slot-"]').length).toBe(0);
await expect.element(page.getByText('2 LEFT')).toBeVisible();

await page.getByRole('button', { name: 'ALL' }).click();
await expect.poll(() => document.querySelectorAll('[data-testid^="piece-slot-"]').length).toBe(2);

const originalRandom = Math.random;
Math.random = () => 0.999999;
try {
  await page.getByRole('button', { name: 'SHUFFLE' }).click();
  await expect.poll(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]'))
      .map((slot) => slot.dataset.testid)
  ).toEqual(['piece-slot-1', 'piece-slot-0']);
} finally {
  Math.random = originalRandom;
}

expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
```

The `0.999999` mock makes the existing two-item Fisher–Yates choose index 1, producing identity `[0, 1]`; HPA-220's local fallback must then swap the first two IDs.

Do not add a route Hint-to-All test. Task 2 owns that invariant at the engine boundary.

- [ ] **Step 2: Run the route test and confirm it fails before wiring**

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: the new filter/shuffle UI flow FAILS.

- [ ] **Step 3: Import existing shuffle and filter type**

In `+page.svelte`:

```ts
import { shuffleArray } from '$lib/utils/shuffle';
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
```

Fold `InventoryFilter` into the existing session-types import if preferred.

- [ ] **Step 4: Derive the controlled active filter**

Near other session-derived state:

```ts
const activeInventoryFilter = $derived(sessionState?.organization?.filter ?? 'all');
```

- [ ] **Step 5: Add the filter dispatch/checkpoint handler**

```ts
function handleInventoryFilterChange(filter: InventoryFilter) {
  if (!sessionStore) return;
  sessionStore.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter }
  });
  checkpointSession();
}
```

- [ ] **Step 6: Add route-owned Shuffle with the identity fallback**

```ts
function handleInventoryShuffle() {
  if (!sessionStore || !sessionState) return;

  const unplacedPieceIds = sessionState.trayOrder.filter((id) => !placedPieceIds.has(id));
  if (unplacedPieceIds.length <= 1) return;

  const shuffled = shuffleArray(unplacedPieceIds);
  if (shuffled.every((id, index) => id === unplacedPieceIds[index])) {
    [shuffled[0], shuffled[1]] = [shuffled[1]!, shuffled[0]!];
  }

  sessionStore.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: shuffled }
  });
  checkpointSession();
}
```

Do not inject RNG into the engine and do not add another shuffle helper.

- [ ] **Step 7: Keep Hint route code unchanged**

The final route must still be:

```ts
function handleHint() {
  if (!sessionStore) return;
  sessionStore.dispatch({ type: 'use_hint' });
  checkpointSession();
}
```

Delete any planned/temporary second `set_filter` dispatch.

- [ ] **Step 8: Pass the controlled props to `PuzzleInventoryPanel`**

Add:

```svelte
activeFilter={activeInventoryFilter}
onFilterChange={handleInventoryFilterChange}
onShuffle={handleInventoryShuffle}
```

Keep every HPA-219 drawer/selection/rotation prop unchanged.

- [ ] **Step 9: Run route + session + component focused tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/inventory.test.ts \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): wire inventory shuffle"
```

---

### Task 5: Preserve the HPA-219 390×844 drawer geometry and run final gates

**Files:**
- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**Interfaces:**
- Consumes: the existing `mobile inventory fits the viewport and shows four tray slots @smoke` test.
- Produces: no new E2E scenario; strengthens that existing test so HPA-220's tool row cannot consume the tray vertically.

- [ ] **Step 1: Extend the existing mobile geometry test before running it**

In the existing 390×844 test, add the tools locator and assert the row does not wrap vertically:

```ts
const tools = page.getByTestId('inventory-tools');
const toolMetrics = await tools.evaluate((element) => {
  const style = getComputedStyle(element);
  return {
    flexWrap: style.flexWrap,
    overflowX: style.overflowX,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  };
});

expect(toolMetrics.flexWrap).toBe('nowrap');
expect(['auto', 'scroll']).toContain(toolMetrics.overflowX);
expect(toolMetrics.scrollHeight).toBeLessThanOrEqual(toolMetrics.clientHeight + 1);
```

Keep the existing assertions unchanged:

- viewport is exactly `390 × 844`;
- panel bottom is inside the viewport;
- at least four tray slots are fully visible.

Those existing assertions are the real regression proof that the new control row did not consume too much of the 16rem tray.

- [ ] **Step 2: Run only the strengthened mobile geometry smoke**

```bash
cd apps/web
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile \
  --grep 'mobile inventory fits the viewport and shows four tray slots'
```

Expected: PASS.

If this geometry test fails because the five controls consume too much vertical space, keep the four filters in `.inventory-tools` and move only SHUFFLE into the existing `.panel-actions` header beside Cancel/Open. Do not add preview sizing preferences and do not allow the filter tools to wrap.

- [ ] **Step 3: Run warning-strict type/Svelte checking**

```bash
cd apps/web
bun run check
```

Expected: 0 errors and 0 warnings.

- [ ] **Step 4: Run focused browser tests again as the implementation fence**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/inventory.test.ts \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Run lint and production build**

```bash
cd apps/web
bun run lint
bun run build
```

Expected: both commands exit 0.

- [ ] **Step 6: Run the existing Chromium smoke lane**

```bash
cd apps/web
bun run test:e2e:smoke
```

Expected: no unexpected failures. This covers the already-shipping mobile drawer flow plus desktop smoke without adding a new HPA-220 E2E suite.

- [ ] **Step 7: Run scope/residue checks**

From repository root:

```bash
git diff --check main...HEAD

git diff --name-only main...HEAD | grep -E \
  'session/types\.ts|session/persistence\.ts|lib/utils/shuffle\.ts|routes/layout\.css' \
  && echo 'Unexpected out-of-scope file changed' && exit 1 || true

rg 'shufflePieceIds|preview.?size|staging tray|inventory store|inventory controller' \
  apps/web/src/lib apps/web/src/routes/puzzle || true
```

Expected:

- `git diff --check` is clean;
- the protected no-change files are absent from the diff;
- no duplicated shuffle helper or deferred architecture was introduced.

- [ ] **Step 8: Commit the strengthened regression fence**

```bash
git add apps/web/e2e/gameplay-mobile-tap.spec.ts
git commit -m "test(web): preserve mobile inventory density"
```

---

## Final implementation shape

After these five slices:

- `inventory.ts` contains only `matchesInventoryFilter()`;
- `PuzzleSession` atomically owns filter visibility, Hint-to-All, and main-tray reorder validation;
- `PuzzleInventoryPanel` owns only controlled presentation and the one-row filter/Shuffle chrome;
- the route derives filter state, checkpoints changes, and uses existing `shuffleArray()` plus the local identity fallback;
- V1 persistence, shared shuffle semantics, HPA-219 drawer sizing, placement history, and HPA-237 staging-tray scope remain unchanged.
