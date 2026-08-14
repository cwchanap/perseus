# HPA-220 Inventory Filters and Shuffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted All/Corners/Edges/Center inventory filtering and a persisted Shuffle action for all unplaced pieces without introducing a second inventory state owner or changing board undo/redo semantics.

**Architecture:** Finish the tray-organization seam already present in `PuzzleSession`. One small pure gameplay module owns coordinate matching and candidate shuffling; `PuzzleSession` owns the controlled filter, selection-clearing invariant, validated canonical reorder, and persistence through existing V1 fields. `PuzzleInventoryPanel` stays presentation-only, and the puzzle route forwards filter/shuffle callbacks plus the one Hint-to-All coordination rule.

**Tech Stack:** TypeScript, Svelte 5, Vitest browser tests, existing `PuzzleSession` transition engine and V1 local-session persistence.

## Global Constraints

- `PuzzleSession` remains the only canonical gameplay state owner.
- Reuse existing `InventoryFilter`, `PersistedTrayOrganization`, `TrayOrganizationUpdate`, and `trayOrder`; add no parallel inventory model.
- Filters are exactly `all | corners | edges | center`.
- Corners and Edges are mutually exclusive; Center means non-perimeter.
- Shuffle reorders all currently unplaced pieces, independent of the active filter.
- Shuffle persists only the resulting canonical order; do not persist RNG state or add a seed contract.
- Filter/shuffle actions do not enter placement undo/redo and do not start the gameplay timer.
- Do not add staging trays, named collections, preview-size preferences, analytics, compatibility migrations, an inventory controller/store/view-model, or a generic query/action framework.
- Keep HPA-219's mobile drawer, safe-area behavior, and responsive piece sizing intact.
- Add focused tests only; no new E2E scenario unless implementation exposes browser-only behavior that cannot be proven below E2E.

---

## File Map

**Create**

- `apps/web/src/lib/services/gameplay/inventory.ts` — coordinate matching and non-mutating shuffle generation.
- `apps/web/src/lib/services/gameplay/inventory.test.ts` — focused pure-helper tests.

**Modify**

- `apps/web/src/lib/services/gameplay/session/session.ts` — selection-safe `set_filter` and validated main-tray `reorder`.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — transition, invariant, and persistence tests.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — controlled filter/Shuffle controls and filtered projection.
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — component behavior/accessibility tests.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — derive/dispatch/checkpoint filter and shuffle; Hint reveal coordination.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — one route-level Hint/filter integration fence.

**Do not modify by default**

- `apps/web/src/lib/services/gameplay/session/types.ts` — the required types/actions already exist.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — V1 already serializes and validates `trayOrder` plus organization filters.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — no HPA-220 interaction change is needed.
- `apps/web/src/routes/layout.css` — HPA-219 already owns mobile inventory sizing/touch behavior.

---

### Task 1: Add Pure Inventory Classification and Shuffle Helpers

**Files:**
- Create: `apps/web/src/lib/services/gameplay/inventory.ts`
- Create: `apps/web/src/lib/services/gameplay/inventory.test.ts`

**Interfaces:**
- Consumes: `InventoryFilter` from `$lib/services/gameplay/session/types` and `PuzzlePiece` from `$lib/types/puzzle`.
- Produces:

```ts
export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  gridCols: number,
  gridRows: number,
  filter: InventoryFilter
): boolean;

export function shufflePieceIds(
  pieceIds: readonly number[],
  random?: () => number
): number[];
```

- [ ] **Step 1: Write failing classification tests**

Create `inventory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchesInventoryFilter, shufflePieceIds } from './inventory';

function matchingFilters(x: number, y: number, cols: number, rows: number) {
  return (['corners', 'edges', 'center'] as const).filter((filter) =>
    matchesInventoryFilter({ correctX: x, correctY: y }, cols, rows, filter)
  );
}

describe('matchesInventoryFilter', () => {
  it('classifies rectangular corners, edges, and center exclusively', () => {
    expect(matchingFilters(0, 0, 4, 3)).toEqual(['corners']);
    expect(matchingFilters(3, 2, 4, 3)).toEqual(['corners']);
    expect(matchingFilters(1, 0, 4, 3)).toEqual(['edges']);
    expect(matchingFilters(0, 1, 4, 3)).toEqual(['edges']);
    expect(matchingFilters(1, 1, 4, 3)).toEqual(['center']);
  });

  it('treats 1x1 as a corner', () => {
    expect(matchingFilters(0, 0, 1, 1)).toEqual(['corners']);
  });

  it('treats one-dimensional endpoints as corners and interiors as edges', () => {
    expect(matchingFilters(0, 0, 1, 4)).toEqual(['corners']);
    expect(matchingFilters(0, 1, 1, 4)).toEqual(['edges']);
    expect(matchingFilters(0, 3, 1, 4)).toEqual(['corners']);
    expect(matchingFilters(0, 2, 1, 4)).not.toContain('center');
  });

  it('matches every piece for All', () => {
    expect(matchesInventoryFilter({ correctX: 1, correctY: 1 }, 4, 3, 'all')).toBe(true);
  });
});
```

- [ ] **Step 2: Write failing shuffle tests**

Append:

```ts
describe('shufflePieceIds', () => {
  it('returns a changed exact permutation without mutating the input', () => {
    const input = [1, 2, 3, 4] as const;
    const result = shufflePieceIds(input, () => 0.999999);

    expect(input).toEqual([1, 2, 3, 4]);
    expect(result).not.toBe(input);
    expect([...result].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(result).not.toEqual(input);
  });

  it('keeps zero and one item stable', () => {
    expect(shufflePieceIds([], () => 0)).toEqual([]);
    expect(shufflePieceIds([7], () => 0)).toEqual([7]);
  });
});
```

- [ ] **Step 3: Run the new test file and confirm the red state**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
```

Expected: FAIL because `./inventory` does not exist.

- [ ] **Step 4: Implement the minimal helper module**

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

export function shufflePieceIds(
  pieceIds: readonly number[],
  random: () => number = Math.random
): number[] {
  const shuffled = [...pieceIds];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  if (
    shuffled.length > 1 &&
    shuffled.every((pieceId, index) => pieceId === pieceIds[index])
  ) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  }

  return shuffled;
}
```

Do not add grid validation here; puzzle/session metadata already owns those invariants.

- [ ] **Step 5: Run helper tests and warning-strict check**

```bash
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
bun run check
```

Expected: PASS; `svelte-check` reports 0 errors and 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/gameplay/inventory.ts src/lib/services/gameplay/inventory.test.ts
git commit -m "feat(web): add inventory filtering helpers"
```

---

### Task 2: Finish Canonical Filter and Main-Tray Reorder Transitions

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` from Task 1 and the existing `update_tray_organization` action.
- Produces:
  - `set_filter` changes `organization.filter` and clears selection only when the new filter hides it.
  - `reorder` with `trayId: 'main'` accepts an exact permutation of current unplaced IDs and rewrites canonical `trayOrder`.
  - non-main reorder remains `tray_organization_noop / not_implemented` for HPA-237.
  - invalid main reorder returns `tray_organization_noop / invalid_update` without mutation.

- [ ] **Step 1: Add an explicit 3x3 metadata fixture for filter-selection tests**

Near `makeMetadata()` in `session.test.ts`, add:

```ts
function makeThreeByThreeMetadata(): PuzzleMetadata {
  return {
    puzzleId: 'pz-grid',
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

This fixture is required because the existing odd-count `makeMetadata()` intentionally uses one column and cannot prove a true Center piece.

- [ ] **Step 2: Add failing filter-selection tests**

Add beside the existing tray-organization filter test:

```ts
it('keeps selection when the new filter contains the selected piece', () => {
  const session = createPuzzleSession(makeOptions({ metadata: makeThreeByThreeMetadata() }));
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 0 });

  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  expect(session.getState().organization?.filter).toBe('corners');
  expect(session.getState().selectedPieceId).toBe(0);
});

it('clears selection when the new filter hides the selected piece', () => {
  const session = createPuzzleSession(makeOptions({ metadata: makeThreeByThreeMetadata() }));
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 4 });

  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  expect(session.getState().organization?.filter).toBe('corners');
  expect(session.getState().selectedPieceId).toBeNull();
});
```

- [ ] **Step 3: Replace the existing HPA-220 `not_implemented` main-reorder test with failing canonical reorder tests**

The default `startedSession()` uses four pieces in a 2x2 grid and canonical initial order `[0, 1, 2, 3]`. Piece 1's correct coordinate is `(1, 0)`.

```ts
it('reorders exactly the current unplaced pieces in the main tray', () => {
  const { session } = startedSession();
  session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });

  const before = session.getState();
  const invariant = {
    placedPieces: before.placedPieces,
    elapsedActiveSeconds: before.elapsedActiveSeconds,
    timerStarted: before.timerStarted,
    rotationEnabled: before.rotationEnabled,
    pieceRotations: before.pieceRotations,
    counters: before.counters,
    facts: before.facts,
    resultClass: before.resultClass,
    sealedCompletion: before.sealedCompletion,
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
    sealedCompletion: session.getState().sealedCompletion,
    canUndo: session.getState().canUndo,
    canRedo: session.getState().canRedo
  }).toEqual(invariant);
  expect(session.getState().hasUserActivity).toBe(true);
});

it.each([
  [0, 2],
  [0, 2, 2],
  [0, 2, 999],
  [0, 1, 2]
])('rejects invalid main-tray reorder %j', (pieceIds) => {
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

- [ ] **Step 4: Add a failing serialize/load round-trip test**

Use the already imported `serializeSession`, `loadPersistedSession`, and `contextFromMetadata`:

```ts
it('round-trips the active filter and shuffled canonical tray order', () => {
  const metadata = makeMetadata(4);
  const session = createPuzzleSession(makeOptions({ metadata }));
  session.dispatch({ type: 'start' });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'edges' }
  });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [3, 1, 0, 2] }
  });

  const serialized = serializeSession(session.getState(), 1234);
  expect(serialized).not.toBeNull();
  const loaded = loadPersistedSession(JSON.stringify(serialized), contextFromMetadata(metadata));

  expect(loaded.status).toBe('loaded');
  if (loaded.status !== 'loaded') throw new Error('expected loaded session');
  expect(loaded.snapshot.trayOrder).toEqual([3, 1, 0, 2]);
  expect(loaded.snapshot.organization?.filter).toBe('edges');
});
```

- [ ] **Step 5: Run the focused session test and confirm the new red cases**

```bash
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: new selection/reorder tests FAIL against the current placeholder behavior.

- [ ] **Step 6: Implement atomic `set_filter` selection clearing**

Import:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
```

Change the `set_filter` branch in `doUpdateTrayOrganization` to:

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

Keep one existing post-switch `notify()`; do not add a second selection notification.

- [ ] **Step 7: Implement exact main-tray reorder validation and mutation**

Add one file-local helper near the tray-organization section:

```ts
function isExactPermutation(candidate: readonly number[], expected: readonly number[]): boolean {
  if (candidate.length !== expected.length) return false;
  const expectedIds = new Set(expected);
  const candidateIds = new Set(candidate);
  return (
    expectedIds.size === expected.length &&
    candidateIds.size === candidate.length &&
    candidate.every((pieceId) => expectedIds.has(pieceId))
  );
}
```

Replace only the `reorder` branch:

```ts
case 'reorder': {
  if (update.trayId !== 'main') {
    return { type: 'tray_organization_noop', reason: 'not_implemented' };
  }

  const placedIds = new Set(state.placedPieces.map((piece) => piece.pieceId));
  const expectedUnplaced = state.trayOrder.filter((pieceId) => !placedIds.has(pieceId));
  if (!isExactPermutation(update.pieceIds, expectedUnplaced)) {
    return { type: 'tray_organization_noop', reason: 'invalid_update' };
  }

  let nextUnplacedIndex = 0;
  state.trayOrder = state.trayOrder.map((pieceId) =>
    placedIds.has(pieceId) ? pieceId : update.pieceIds[nextUnplacedIndex++]
  );
  break;
}
```

Leave the existing common success tail intact: assign `state.organization`, set `hasUserActivity = true`, notify once, and return `tray_organization_applied`. Do not call `pushHistory()`, `ensureTimerStarted()`, or mutate any other gameplay field.

- [ ] **Step 8: Run session and persistence gates**

```bash
bunx vitest --run --browser \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-fields.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/services/gameplay/session/session.ts src/lib/services/gameplay/session/session.test.ts
git commit -m "feat(web): persist inventory filter and shuffle order"
```

---

### Task 3: Add Controlled Filter and Shuffle Controls to the Inventory Panel

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` and `InventoryFilter`.
- Adds component props:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

- [ ] **Step 1: Add a 3x3 component fixture and extend `baseProps()`**

Keep the current two-piece fixture for existing tests. Add:

```ts
const gridPuzzle: Puzzle = {
  id: 'inventory-grid-test',
  name: 'Inventory Grid Test',
  pieceCount: 9,
  gridCols: 3,
  gridRows: 3,
  imageWidth: 300,
  imageHeight: 300,
  createdAt: 1704067200000,
  pieces: Array.from({ length: 9 }, (_, id) => ({
    id,
    puzzleId: 'inventory-grid-test',
    correctX: id % 3,
    correctY: Math.floor(id / 3),
    imagePath: `pieces/${id}.png`,
    edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' }
  }))
};
```

Extend `baseProps()` with:

```ts
activeFilter: 'all' as const,
onFilterChange: vi.fn(),
onShuffle: vi.fn()
```

- [ ] **Step 2: Add failing filtered-render and reactive-placement tests**

```ts
it('renders only unplaced pieces in the active filter while preserving tray order', async () => {
  render(PuzzleInventoryPanel, {
    ...baseProps(),
    puzzle: gridPuzzle,
    trayOrder: [8, 4, 1, 0, 3, 2, 5, 6, 7],
    placedPieces: [{ pieceId: 8, x: 2, y: 2 }],
    activeFilter: 'edges'
  });

  const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]'));
  expect(slots.map((slot) => slot.dataset.testid)).toEqual([
    'piece-slot-1',
    'piece-slot-3',
    'piece-slot-5',
    'piece-slot-7'
  ]);
  await expect.element(page.getByText('8 LEFT')).toBeVisible();
});

it('refreshes filtered results when placement state changes', async () => {
  const input = {
    ...baseProps(),
    puzzle: gridPuzzle,
    trayOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    activeFilter: 'edges' as const
  };
  const view = render(PuzzleInventoryPanel, input);
  await expect.element(page.getByTestId('piece-slot-1')).toBeInTheDocument();

  await view.rerender({ ...input, placedPieces: [{ pieceId: 1, x: 1, y: 0 }] });
  expect(page.getByTestId('piece-slot-1').query()).toBeNull();

  await view.rerender({ ...input, placedPieces: [] });
  await expect.element(page.getByTestId('piece-slot-1')).toBeInTheDocument();
});
```

The second test represents the same prop transitions produced by placement and undo/redo; no inventory event subscription is needed.

- [ ] **Step 3: Add failing filter-control and Shuffle tests**

```ts
it('exposes active filter state and forwards filter changes', async () => {
  const input = { ...baseProps(), activeFilter: 'corners' as const };
  render(PuzzleInventoryPanel, input);

  await expect
    .element(page.getByRole('button', { name: 'Show corner pieces' }))
    .toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Show center pieces' }).click();
  expect(input.onFilterChange).toHaveBeenCalledWith('center');
});

it('forwards Shuffle with at least two unplaced pieces', async () => {
  const input = baseProps();
  render(PuzzleInventoryPanel, input);
  await page.getByRole('button', { name: 'Shuffle unplaced pieces' }).click();
  expect(input.onShuffle).toHaveBeenCalledOnce();
});

it('disables Shuffle with one unplaced piece regardless of the active filter', async () => {
  render(PuzzleInventoryPanel, {
    ...baseProps(),
    placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
    activeFilter: 'corners'
  });
  await expect
    .element(page.getByRole('button', { name: 'Shuffle unplaced pieces' }))
    .toBeDisabled();
});
```

Keep all current Cancel, rejected/hinted, rotation, and drawer tests unchanged as regressions.

- [ ] **Step 4: Run the component test and confirm the red state**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because the new props/controls are not implemented.

- [ ] **Step 5: Add controlled props and derived visible pieces**

In `PuzzleInventoryPanel.svelte`, import:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
```

Extend `Props` and `$props()` with `activeFilter`, `onFilterChange`, and `onShuffle`.

After `orderedPieces`, add:

```ts
const unplacedPieces = $derived(
  orderedPieces.filter((piece) => !placedPieceIds.has(piece.id))
);

const visiblePieces = $derived(
  unplacedPieces.filter((piece) =>
    matchesInventoryFilter(piece, puzzle.gridCols, puzzle.gridRows, activeFilter)
  )
);

const canShuffle = $derived(unplacedPieces.length > 1);
```

Render `visiblePieces` directly instead of wrapping every slot in the current placed-piece `#if`.

- [ ] **Step 6: Add one explicit tools row**

At the top of `.inventory-body`, before `.pieces-grid`:

```svelte
<div class="inventory-tools">
  <div class="filter-actions" role="group" aria-label="Inventory filter">
    <button type="button" aria-label="Show all pieces" aria-pressed={activeFilter === 'all'} onclick={() => onFilterChange('all')}>ALL</button>
    <button type="button" aria-label="Show corner pieces" aria-pressed={activeFilter === 'corners'} onclick={() => onFilterChange('corners')}>CORNERS</button>
    <button type="button" aria-label="Show edge pieces" aria-pressed={activeFilter === 'edges'} onclick={() => onFilterChange('edges')}>EDGES</button>
    <button type="button" aria-label="Show center pieces" aria-pressed={activeFilter === 'center'} onclick={() => onFilterChange('center')}>CENTER</button>
  </div>
  <button
    type="button"
    aria-label="Shuffle unplaced pieces"
    disabled={!canShuffle}
    onclick={onShuffle}
  >
    SHUFFLE
  </button>
</div>
```

Use one local class shared by these five buttons, but do not create a filter registry or a new component. Style with existing CSS variables. The row may wrap; it must not force horizontal overflow. Under the existing coarse-pointer media query, give the new buttons `min-height: 44px`.

Keep the existing header count as total unplaced pieces and keep the existing drawer hide/show behavior unchanged.

- [ ] **Step 7: Run focused component tests and check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
```

Expected: PASS and 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add src/lib/components/PuzzleInventoryPanel.svelte src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "feat(web): add inventory filter and shuffle controls"
```

---

### Task 4: Wire Filters, Shuffle, and Hint Reveal Through the Puzzle Route

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `InventoryFilter`, `shufflePieceIds()`, existing session dispatch/checkpoint helpers, and Task 3's component props.
- Produces:
  - derived `activeInventoryFilter`;
  - `handleInventoryFilterChange(filter)`;
  - `handleShuffleInventory()`;
  - successful Hint resets a non-All filter to All before the single checkpoint.

- [ ] **Step 1: Add the failing route Hint/filter integration test**

The existing `renderPuzzlePage()` helper already stubs the default 2x1 puzzle, renders, and awaits board visibility. In a 2x1 grid both pieces are Corners, so Edges produces an intentionally empty inventory.

Add near the current Hint tests:

```ts
it('returns a filtered inventory to All after a successful hint', async () => {
  await renderPuzzlePage();

  await page.getByRole('button', { name: 'Show edge pieces' }).click();
  await expect
    .element(page.getByRole('button', { name: 'Show edge pieces' }))
    .toHaveAttribute('aria-pressed', 'true');
  expect(page.getByTestId('piece-slot-0').query()).toBeNull();
  expect(page.getByTestId('piece-slot-1').query()).toBeNull();

  await page.getByRole('button', { name: 'Hint' }).click();

  await expect
    .element(page.getByRole('button', { name: 'Show all pieces' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect.element(page.getByTestId('piece-slot-0')).toBeInTheDocument();
});
```

The current deterministic tray order is `[0, 1]`, so the existing hint service selects piece 0 first. Keep the assertion specific to piece 0.

- [ ] **Step 2: Run the route test and confirm the red state**

```bash
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: FAIL at the missing filter controls/required component props.

- [ ] **Step 3: Derive the controlled filter and add the filter handler**

Extend the existing session-types import with `InventoryFilter` and add:

```ts
import { shufflePieceIds } from '$lib/services/gameplay/inventory';
```

Near the other session-derived values:

```ts
const activeInventoryFilter = $derived(sessionState?.organization?.filter ?? 'all');
```

Add:

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

Do not add route-local `$state` for the filter.

- [ ] **Step 4: Add Shuffle orchestration over all unplaced IDs**

Use the route's existing `placedPieceIds` derived set:

```ts
function handleShuffleInventory() {
  if (!sessionStore || !sessionState) return;

  const unplacedPieceIds = sessionState.trayOrder.filter(
    (pieceId) => !placedPieceIds.has(pieceId)
  );
  if (unplacedPieceIds.length < 2) return;

  sessionStore.dispatch({
    type: 'update_tray_organization',
    update: {
      type: 'reorder',
      trayId: 'main',
      pieceIds: shufflePieceIds(unplacedPieceIds)
    }
  });
  checkpointSession();
}
```

Do not apply `activeInventoryFilter` when building `unplacedPieceIds`.

- [ ] **Step 5: Make successful Hint reveal its target through All**

Replace the current `handleHint()` body with:

```ts
function handleHint() {
  if (!sessionStore) return;

  const outcome = sessionStore.dispatch({ type: 'use_hint' });
  if (outcome.type === 'hint_used' && activeInventoryFilter !== 'all') {
    sessionStore.dispatch({
      type: 'update_tray_organization',
      update: { type: 'set_filter', filter: 'all' }
    });
  }
  checkpointSession();
}
```

Do not reset the filter for `hint_noop`.

- [ ] **Step 6: Pass the controlled props into `PuzzleInventoryPanel`**

Add exactly:

```svelte
activeFilter={activeInventoryFilter}
onFilterChange={handleInventoryFilterChange}
onShuffle={handleShuffleInventory}
```

Keep existing selection/rotation/hint/rejection props unchanged.

- [ ] **Step 7: Run the four focused suites together**

```bash
bunx vitest --run --browser \
  src/lib/services/gameplay/inventory.test.ts \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/puzzle/[id]/+page.svelte src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): wire inventory filters and shuffle"
```

---

### Task 5: Run Final HPA-220 Validation Gates

**Files:**
- No planned production changes. Fix only issues directly caused by HPA-220 if a gate fails.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: merge-readiness evidence without broadening scope.

- [ ] **Step 1: Run the full web unit/browser suite**

From `apps/web`:

```bash
bun run test:unit
```

Expected: PASS. Do not add unrelated tests merely to alter aggregate coverage.

- [ ] **Step 2: Run check, lint, and build**

```bash
bun run check
bun run lint
bun run build
```

Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 3: Verify diff scope and whitespace**

From the repository root:

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD
```

Expected implementation scope is the eight source/test paths in this plan plus the two planning documents. No session-schema version, migration, new store/controller/view-model, E2E harness, staging-tray UI, or preview-size preference should appear.

- [ ] **Step 4: Review the acceptance invariants directly in the final diff/tests**

```text
[ ] corners / edges / center are mutually exclusive coordinate classes
[ ] filter state comes from PuzzleSession organization.filter
[ ] hidden selection clears inside set_filter before the single notify
[ ] placement/undo/redo refresh filtered results through controlled props
[ ] Hint resets to All only on hint_used
[ ] Shuffle input is every unplaced ID, not the active filtered subset
[ ] main reorder validates an exact unplaced permutation
[ ] placed IDs stay anchored in the full trayOrder
[ ] reorder does not push placement history or start/checkpoint the timer
[ ] V1 serializer/validator is reused without schema changes
[ ] HPA-219 drawer and responsive sizing remain intact
```

- [ ] **Step 5: Commit only a directly scoped correction if validation found one**

If the worktree is already clean and all gates pass, create no verification commit. If HPA-220 itself needed a correction:

```bash
git add <only-the-HPA-220-files-that-were-corrected>
git commit -m "fix(web): tighten inventory filter and shuffle behavior"
```

Do not bundle unrelated cleanup discovered during validation.