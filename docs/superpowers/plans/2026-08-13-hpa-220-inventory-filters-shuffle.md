# HPA-220 Inventory Filters and Shuffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted All/Corners/Edges/Center inventory filtering and a persisted Shuffle action for all unplaced pieces without introducing a second inventory state owner or changing board undo/redo semantics.

**Architecture:** Finish the tray-organization seam already present in `PuzzleSession`. A small pure gameplay helper owns coordinate classification and candidate shuffling; `PuzzleSession` owns the controlled filter, selection-clearing invariant, validated canonical tray reorder, and persistence through existing V1 fields. `PuzzleInventoryPanel` remains presentation-only, and the puzzle route forwards filter/shuffle callbacks plus the one Hint-to-All coordination rule.

**Tech Stack:** TypeScript, Svelte 5, Vitest browser tests, existing `PuzzleSession` transition engine and V1 local-session persistence.

## Global Constraints

- `PuzzleSession` remains the only canonical gameplay state owner.
- Reuse existing `InventoryFilter`, `PersistedTrayOrganization`, `TrayOrganizationUpdate`, and `trayOrder`; add no parallel inventory model.
- Filters are exactly `all | corners | edges | center`.
- Corners and Edges are mutually exclusive; Center means non-perimeter.
- Shuffle reorders all currently unplaced pieces, independent of the active filter.
- Shuffle persists only the resulting canonical order; do not persist RNG state or add a seed contract.
- Filter/shuffle actions do not enter placement undo/redo and do not start the gameplay timer.
- Do not add staging trays, named collections, preview sizing preferences, analytics, compatibility migrations, an inventory controller/store/view-model, or a generic query/action framework.
- Keep HPA-219's mobile drawer, safe-area behavior, and responsive piece sizing intact.
- Add focused tests only; no new E2E scenario unless implementation exposes behavior that cannot be proven in unit/component/route tests.

---

## File map

**Create**

- `apps/web/src/lib/services/gameplay/inventory.ts` — pure coordinate matching and non-mutating shuffle generation.
- `apps/web/src/lib/services/gameplay/inventory.test.ts` — unit tests for classification and shuffle behavior.

**Modify**

- `apps/web/src/lib/services/gameplay/session/session.ts` — make `set_filter` enforce selection visibility and implement validated `reorder` for the main tray.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — session transition, invariant, and persistence tests.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — controlled filter controls, Shuffle control, and filtered unplaced projection.
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — component behavior/accessibility tests.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — derive filter, dispatch/checkpoint filter and shuffle, and reset to All after a successful Hint.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — route-level Hint/filter integration fence.

**Do not modify by default**

- `apps/web/src/lib/services/gameplay/session/types.ts` — the required types/actions already exist.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — V1 already serializes/validates `trayOrder` and organization filters.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — HPA-220 needs no piece interaction changes.
- `apps/web/src/routes/layout.css` — HPA-219 already owns mobile piece sizing/touch behavior.

---

### Task 1: Add the pure inventory classification and shuffle helpers

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
- Later tasks use `matchesInventoryFilter` in both the session transition and inventory component, and `shufflePieceIds` in the route.

- [ ] **Step 1: Write failing classification tests**

Create `inventory.test.ts` with table-driven cases covering square, rectangular, and degenerate grids. Use coordinate objects only; do not construct image/edge metadata that the classifier does not need.

```ts
import { describe, expect, it } from 'vitest';
import { matchesInventoryFilter, shufflePieceIds } from './inventory';

function matchingFilters(x: number, y: number, cols: number, rows: number) {
  return (['corners', 'edges', 'center'] as const).filter((filter) =>
    matchesInventoryFilter({ correctX: x, correctY: y }, cols, rows, filter)
  );
}

describe('matchesInventoryFilter', () => {
  it('classifies a rectangular perimeter into mutually exclusive corners and edges', () => {
    expect(matchingFilters(0, 0, 4, 3)).toEqual(['corners']);
    expect(matchingFilters(3, 2, 4, 3)).toEqual(['corners']);
    expect(matchingFilters(1, 0, 4, 3)).toEqual(['edges']);
    expect(matchingFilters(0, 1, 4, 3)).toEqual(['edges']);
    expect(matchingFilters(1, 1, 4, 3)).toEqual(['center']);
  });

  it('treats 1x1 as a corner', () => {
    expect(matchingFilters(0, 0, 1, 1)).toEqual(['corners']);
  });

  it('treats one-dimensional endpoints as corners and interior cells as edges', () => {
    expect(matchingFilters(0, 0, 1, 4)).toEqual(['corners']);
    expect(matchingFilters(0, 1, 1, 4)).toEqual(['edges']);
    expect(matchingFilters(0, 3, 1, 4)).toEqual(['corners']);
  });

  it('matches every piece for All', () => {
    expect(matchesInventoryFilter({ correctX: 1, correctY: 1 }, 4, 3, 'all')).toBe(true);
  });
});
```

- [ ] **Step 2: Write failing shuffle tests**

Add deterministic tests proving no input mutation, exact permutation, stable 0/1-item behavior, and the identity-fallback rule for 2+ items.

```ts
describe('shufflePieceIds', () => {
  it('returns a changed permutation without mutating the input', () => {
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

- [ ] **Step 3: Run the new test file and verify it fails because the module does not exist**

Run from `apps/web`:

```bash
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
```

Expected: FAIL because `./inventory` is missing.

- [ ] **Step 4: Implement the minimal pure helper module**

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

Do not add grid validation here; puzzle metadata is already validated by the session/puzzle loaders.

- [ ] **Step 5: Run the helper tests and typecheck**

```bash
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
bun run check
```

Expected: helper tests PASS; Svelte/TypeScript check has 0 errors and 0 warnings.

- [ ] **Step 6: Commit the pure helper slice**

```bash
git add src/lib/services/gameplay/inventory.ts src/lib/services/gameplay/inventory.test.ts
git commit -m "feat(web): add inventory filtering helpers"
```

---

### Task 2: Finish canonical filter and main-tray reorder transitions

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` from Task 1 and the existing `update_tray_organization` action.
- Produces:
  - `set_filter` updates `organization.filter` and clears a selected piece only when the new filter hides it.
  - `reorder` with `trayId: 'main'` accepts only an exact permutation of current unplaced IDs and updates canonical `state.trayOrder`.
  - non-main reorder remains `tray_organization_noop / not_implemented`.
  - invalid main reorder returns `tray_organization_noop / invalid_update` with no mutation/notification.

- [ ] **Step 1: Replace the old `not_implemented` reorder test with failing canonical reorder tests**

In the existing `PuzzleSession tray organization branches` section, replace the HPA-220 placeholder test and add these cases:

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
  }).toEqual(invariant);
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

Use the fixture's actual piece coordinates if its `startedSession()` metadata differs; do not weaken the exact-order assertions.

- [ ] **Step 2: Add failing selection/filter tests**

Add tests beside the existing valid-filter test:

```ts
it('keeps selection when the new filter still contains the selected piece', () => {
  const session = createPuzzleSession({ ...makeOptions({ metadata: makeMetadata(9) }) });
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 0 });

  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  expect(session.getState().selectedPieceId).toBe(0);
});

it('clears selection atomically when the new filter hides the selected piece', () => {
  const session = createPuzzleSession({ ...makeOptions({ metadata: makeMetadata(9) }) });
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

If the existing `makeMetadata(9)` fixture uses a one-column layout, add a local explicit 3x3 `PuzzleMetadata` fixture instead. The assertion must use a true center piece; do not rely on a fixture shape that changes the semantics.

- [ ] **Step 3: Add a failing serialize/load round-trip test for filter plus shuffled tray order**

Use the existing `serializeSession`, `loadPersistedSession`, and `contextFromMetadata` helpers already imported in `session.test.ts`:

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

- [ ] **Step 4: Run the focused session tests and verify the new cases fail**

```bash
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: existing tests remain green; new reorder/selection tests FAIL against the current placeholder behavior.

- [ ] **Step 5: Implement `set_filter` selection clearing and validated main reorder**

Import the Task 1 matcher at the top of `session.ts`:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
```

In `doUpdateTrayOrganization`, keep the existing default organization clone. Update the relevant switch branches along this shape:

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

Add one file-local helper near the tray-organization section; do not export it or create another module:

```ts
function isExactPermutation(candidate: readonly number[], expected: readonly number[]): boolean {
  if (candidate.length !== expected.length) return false;
  const expectedIds = new Set(expected);
  if (expectedIds.size !== expected.length) return false;
  const candidateIds = new Set(candidate);
  return candidateIds.size === candidate.length && candidate.every((pieceId) => expectedIds.has(pieceId));
}
```

Leave the existing post-switch behavior unchanged: assign `state.organization`, set `hasUserActivity = true`, call `notify()`, and return `tray_organization_applied`. Do not call `pushHistory()` or `ensureTimerStarted()`.

- [ ] **Step 6: Run session tests and persistence-focused tests**

```bash
bunx vitest --run --browser \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-fields.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the canonical session behavior**

```bash
git add src/lib/services/gameplay/session/session.ts src/lib/services/gameplay/session/session.test.ts
git commit -m "feat(web): persist inventory filter and shuffle order"
```

---

### Task 3: Add controlled filter and Shuffle controls to `PuzzleInventoryPanel`

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` from Task 1 and `InventoryFilter` from session types.
- New component props:
  ```ts
  activeFilter: InventoryFilter;
  onFilterChange: (filter: InventoryFilter) => void;
  onShuffle: () => void;
  ```
- Produces: controlled filter/shuffle presentation only; no local filter state.

- [ ] **Step 1: Expand the component test puzzle to a real 3x3 classification fixture**

The current 2x1 test puzzle cannot exercise Center. Replace or add a dedicated 3x3 puzzle fixture whose IDs map row-major to coordinates `0..8`. Keep the existing two-piece fixture for tests whose exact current assumptions are useful.

Add a helper:

```ts
const gridPuzzle: Puzzle = {
  ...puzzle,
  id: 'inventory-grid-test',
  name: 'Inventory Grid Test',
  pieceCount: 9,
  gridCols: 3,
  gridRows: 3,
  imageWidth: 300,
  imageHeight: 300,
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

Edge image metadata is intentionally irrelevant; the new classifier uses coordinates.

- [ ] **Step 2: Add failing controlled-filter rendering/accessibility tests**

Extend `baseProps()` with `activeFilter: 'all'`, `onFilterChange: vi.fn()`, and `onShuffle: vi.fn()` after the component interface is updated. Add tests:

```ts
it('renders only unplaced pieces in the active coordinate filter and keeps tray order', async () => {
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
  expect(page.getByTestId('piece-slot-4').query()).toBeNull();
  await expect.element(page.getByText('8 LEFT')).toBeVisible();
});

it('exposes the active filter with aria-pressed and forwards filter changes', async () => {
  const input = { ...baseProps(), activeFilter: 'corners' as const };
  render(PuzzleInventoryPanel, input);

  await expect
    .element(page.getByRole('button', { name: 'Show corner pieces' }))
    .toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Show center pieces' }).click();
  expect(input.onFilterChange).toHaveBeenCalledWith('center');
});
```

- [ ] **Step 3: Add failing Shuffle availability/callback tests**

```ts
it('forwards Shuffle while at least two unplaced pieces remain', async () => {
  const input = baseProps();
  render(PuzzleInventoryPanel, input);

  await page.getByRole('button', { name: 'Shuffle unplaced pieces' }).click();
  expect(input.onShuffle).toHaveBeenCalledOnce();
});

it('disables Shuffle with one unplaced piece regardless of active filter', async () => {
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

Keep the existing drawer tests; they are a regression fence for HPA-219.

- [ ] **Step 4: Run the component test and verify the new props/controls fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because the component has no filter/shuffle interface yet.

- [ ] **Step 5: Add the controlled props and filtered derived projection**

In `PuzzleInventoryPanel.svelte`, import `InventoryFilter` and `matchesInventoryFilter`, then extend `Props`:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

Keep `drawerOpen` as the only local state. Replace the render-time placed-piece `#if` with explicit derived projections:

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

Render `visiblePieces` directly. The existing total remaining count stays `puzzle.pieceCount - placedPieces.length`.

- [ ] **Step 6: Add the explicit filter and Shuffle controls**

At the top of `.inventory-body`, before `.pieces-grid`, add one non-generic tools row:

```svelte
<div class="inventory-tools" aria-label="Inventory filter">
  <div class="filter-actions" role="group" aria-label="Inventory filter">
    <button type="button" aria-label="Show all pieces" aria-pressed={activeFilter === 'all'} onclick={() => onFilterChange('all')}>ALL</button>
    <button type="button" aria-label="Show corner pieces" aria-pressed={activeFilter === 'corners'} onclick={() => onFilterChange('corners')}>CORNERS</button>
    <button type="button" aria-label="Show edge pieces" aria-pressed={activeFilter === 'edges'} onclick={() => onFilterChange('edges')}>EDGES</button>
    <button type="button" aria-label="Show center pieces" aria-pressed={activeFilter === 'center'} onclick={() => onFilterChange('center')}>CENTER</button>
  </div>
  <button type="button" aria-label="Shuffle unplaced pieces" disabled={!canShuffle} onclick={onShuffle}>SHUFFLE</button>
</div>
```

Use a shared local class for these five buttons if desired, but do not create an action registry or new component solely to render four filters.

Style the tools row with existing `--bg-*`, `--border`, `--text-*`, and `--accent` variables. It must wrap rather than horizontally overflow. Under `@media (pointer: coarse)`, give tool buttons `min-height: 44px`. Preserve all existing drawer/mobile/desktop CSS.

- [ ] **Step 7: Run the focused component suite and warning-strict check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
```

Expected: PASS and 0 warnings.

- [ ] **Step 8: Commit the inventory presentation slice**

```bash
git add src/lib/components/PuzzleInventoryPanel.svelte src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "feat(web): add inventory filter and shuffle controls"
```

---

### Task 4: Wire controlled filters, Shuffle, and Hint reveal through the puzzle route

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `InventoryFilter`, `shufflePieceIds()`, existing session dispatch/checkpoint functions, and Task 3's new `PuzzleInventoryPanel` props.
- Produces:
  - route-derived `activeInventoryFilter`;
  - `handleInventoryFilterChange(filter)`;
  - `handleShuffleInventory()`;
  - successful Hint resets a non-All filter to All before the single checkpoint.

- [ ] **Step 1: Add the failing route integration test for Hint reveal**

Use the route test's default 2x1 puzzle: both pieces are Corners, so selecting Edges intentionally produces an empty inventory. Then Hint must return to All and expose the hinted piece.

Add a test near the existing Hint route tests:

```ts
it('returns a filtered inventory to All after a successful hint so the hinted piece is visible', async () => {
  vi.mocked(fetchPuzzle).mockResolvedValue(createMockPuzzle());
  renderPuzzlePage();

  await expect.element(page.getByTestId('puzzle-inventory-panel')).toBeVisible();
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

If the existing deterministic hint helper selects piece 1 rather than piece 0, assert the actual hinted slot. The test must prove that the inventory was empty under Edges first and visible under All after Hint; do not merely assert button callbacks.

- [ ] **Step 2: Run the route test and verify it fails at the missing filter control**

```bash
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: FAIL because the route does not yet pass Task 3's required props.

- [ ] **Step 3: Derive the controlled filter and add the filter handler**

Extend the session-type import with `InventoryFilter` and import `shufflePieceIds`:

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

Do not add `$state` for the filter.

- [ ] **Step 4: Add Shuffle orchestration over all unplaced IDs**

Use the route's existing canonical `placedPieceIds` derived set:

```ts
function handleShuffleInventory() {
  if (!sessionStore || !sessionState) return;
  const unplacedPieceIds = sessionState.trayOrder.filter((pieceId) => !placedPieceIds.has(pieceId));
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

Do not filter `unplacedPieceIds` by `activeInventoryFilter`.

- [ ] **Step 5: Make successful Hint reveal its target through All**

Change `handleHint()` from fire-and-forget dispatch to outcome-aware coordination:

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

- [ ] **Step 7: Run route, component, session, and helper tests together**

```bash
bunx vitest --run --browser \
  src/lib/services/gameplay/inventory.test.ts \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the route integration slice**

```bash
git add src/routes/puzzle/[id]/+page.svelte src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): wire inventory filters and shuffle"
```

---

### Task 5: Run the final HPA-220 validation gates

**Files:**
- No planned production changes. Only fix issues directly caused by HPA-220 if a gate fails.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: evidence that HPA-220 is ready for review without broadening scope.

- [ ] **Step 1: Run the full web unit/browser suite**

From the repository root:

```bash
bun run test:unit --filter=@perseus/web
```

Expected: PASS with existing coverage reporting; do not add tests solely to chase unrelated global coverage.

- [ ] **Step 2: Run warning-strict Svelte/TypeScript checks**

```bash
bun run check --filter=@perseus/web
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Run lint and production build**

```bash
bun run lint --filter=@perseus/web
bun run build --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 4: Verify the implementation stayed inside the intended architecture**

Run:

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD
```

Expected implementation file set is limited to the seven source/test files named in this plan plus these two planning documents. No session schema version, migration, new store/controller/view-model, E2E harness, staging-tray UI, or responsive-size preference should appear.

- [ ] **Step 5: Inspect the final diff for the acceptance invariants**

Confirm directly from the diff/tests:

```text
[ ] corners / edges / center are mutually exclusive coordinate classes
[ ] filter state comes from PuzzleSession organization.filter
[ ] hidden selection clears inside set_filter before notify
[ ] Hint resets to All only on hint_used
[ ] Shuffle input is every unplaced ID, not the active filtered subset
[ ] main reorder validates an exact unplaced permutation
[ ] placed IDs stay anchored in the full trayOrder
[ ] reorder does not push placement history or start/checkpoint the timer
[ ] current V1 serializer/validator is reused without schema changes
[ ] HPA-219 drawer/responsive sizing remains intact
```

- [ ] **Step 6: Commit only if validation required a directly scoped correction**

If all gates pass with a clean worktree, do not create an empty verification commit. If a scoped fix was necessary:

```bash
git add <only-the-HPA-220-files-that-were-fixed>
git commit -m "fix(web): tighten inventory filter and shuffle behavior"
```

Do not bundle unrelated cleanup discovered during validation.