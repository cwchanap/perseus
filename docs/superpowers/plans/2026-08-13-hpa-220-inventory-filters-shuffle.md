# HPA-220 Inventory Filters and Shuffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted All/Corners/Edges/Center inventory filtering and random Shuffle for all unplaced pieces by finishing the existing `PuzzleSession` tray-organization seams, without creating another inventory state owner or changing placement undo/redo semantics.

**Architecture:** Add one pure coordinate matcher. `PuzzleSession` owns filter visibility invariants, atomic Hint→All, restart filter reset, and exact main-tray reorder validation/application. The route reuses the existing `shuffleArray()` RNG utility and checkpoints actions; `PuzzleInventoryPanel` remains controlled presentation. Existing V1 persistence continues to store `trayOrder` and `organization.filter` with no schema change.

**Tech Stack:** TypeScript, Svelte 5, Vitest browser tests, Playwright Chromium-mobile E2E, existing `PuzzleSession` engine, existing V1 session persistence.

## Global Constraints

- `PuzzleSession` remains the only canonical gameplay state owner.
- Reuse existing `InventoryFilter`, `PersistedTrayOrganization`, `TrayOrganizationUpdate`, `trayOrder`, and `$lib/utils/shuffle`.
- Filters are exactly `all | corners | edges | center`.
- Classification uses `correctX` / `correctY`, never `piece.edges`.
- Corners and Edges are mutually exclusive; Center means non-perimeter.
- `set_filter` persists the filter but does **not** set `hasUserActivity`.
- Successful Hint resets a non-All filter to All inside `doUseHint()` before its existing event/notification.
- Restart resets only `organization.filter` to All while retaining other organization fields.
- Shuffle uses every current unplaced ID, independent of the active filter.
- Reuse `shuffleArray()` exactly; do not add a second Fisher–Yates, RNG parameter, seed, or non-identity helper/fallback.
- Reorder marks activity only if the full canonical `trayOrder` actually changes.
- Shuffle/filter do not enter placement undo/redo and do not start the gameplay timer.
- Non-main reorder remains `not_implemented` for HPA-237.
- Keep HPA-219 drawer, Cancel, safe-area behavior, and mobile preview sizing; raise only the mobile inventory max-height from 16rem to 20rem to pay for the new tools row.
- Do not add preview-size preferences, staging trays, named collections, analytics, compatibility migrations, an inventory store/controller/view-model, or a generic query/action framework.

---

## File map

**Create**

- `apps/web/src/lib/services/gameplay/inventory.ts` — pure coordinate matcher only.
- `apps/web/src/lib/services/gameplay/inventory.test.ts` — matcher tests.

**Modify**

- `apps/web/src/lib/services/gameplay/session/session.ts` — filter activity semantics, atomic selection clear, Hint→All, exact main reorder, restart filter reset.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — session invariants, reorder validation, persistence/history/restart regressions.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — controlled filters, Shuffle, empty-filter state, one-row tools chrome, 20rem mobile cap.
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — component behavior/accessibility/drawer tests.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — derive active filter, dispatch/checkpoint filter changes, reuse `shuffleArray()` for Shuffle, pass controlled props.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — route persistence/wiring and identity-shuffle activity regression.
- `apps/web/e2e/gameplay-mobile-tap.spec.ts` — strengthen existing 390×844 large-inventory geometry fence to require two complete piece rows.

**Do not modify by default**

- `apps/web/src/lib/services/gameplay/session/types.ts` — all required types/actions already exist.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — V1 already serializes/validates `trayOrder` and organization filter.
- `apps/web/src/lib/utils/shuffle.ts` — reuse existing semantics unchanged.
- `apps/web/src/lib/utils/__tests__/shuffle.svelte.test.ts` — HPA-220 adds no shared shuffle behavior.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — no piece interaction change.
- `apps/web/src/routes/layout.css` — HPA-219 touch behavior remains unchanged.

---

### Task 1: Add the shared coordinate matcher

**Files:**
- Create: `apps/web/src/lib/services/gameplay/inventory.ts`
- Create: `apps/web/src/lib/services/gameplay/inventory.test.ts`

**Interfaces:**
- Consumes: `InventoryFilter` from `$lib/services/gameplay/session/types`, `Puzzle` / `PuzzlePiece` from `$lib/types/puzzle`.
- Produces:

```ts
export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  grid: Pick<Puzzle, 'gridCols' | 'gridRows'>,
  filter: InventoryFilter
): boolean;
```

The session passes its state as the structural grid argument; the panel passes `puzzle`. No caller passes adjacent `gridCols, gridRows` numeric arguments.

- [ ] **Step 1: Write the failing matcher tests**

Create `apps/web/src/lib/services/gameplay/inventory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchesInventoryFilter } from './inventory';

const GRID_4X3 = { gridCols: 4, gridRows: 3 };

function matchingFilters(
  correctX: number,
  correctY: number,
  grid: { gridCols: number; gridRows: number }
) {
  return (['corners', 'edges', 'center'] as const).filter((filter) =>
    matchesInventoryFilter({ correctX, correctY }, grid, filter)
  );
}

describe('matchesInventoryFilter', () => {
  it('classifies a non-square perimeter into mutually exclusive corners, edges, and center', () => {
    expect(matchingFilters(0, 0, GRID_4X3)).toEqual(['corners']);
    expect(matchingFilters(3, 2, GRID_4X3)).toEqual(['corners']);
    expect(matchingFilters(1, 0, GRID_4X3)).toEqual(['edges']);
    expect(matchingFilters(0, 1, GRID_4X3)).toEqual(['edges']);
    expect(matchingFilters(1, 1, GRID_4X3)).toEqual(['center']);
  });

  it('treats 1x1 as a corner', () => {
    expect(matchingFilters(0, 0, { gridCols: 1, gridRows: 1 })).toEqual(['corners']);
  });

  it('treats one-dimensional endpoints as corners and interior cells as edges', () => {
    const vertical = { gridCols: 1, gridRows: 4 };
    expect(matchingFilters(0, 0, vertical)).toEqual(['corners']);
    expect(matchingFilters(0, 1, vertical)).toEqual(['edges']);
    expect(matchingFilters(0, 3, vertical)).toEqual(['corners']);

    const horizontal = { gridCols: 4, gridRows: 1 };
    expect(matchingFilters(0, 0, horizontal)).toEqual(['corners']);
    expect(matchingFilters(2, 0, horizontal)).toEqual(['edges']);
    expect(matchingFilters(3, 0, horizontal)).toEqual(['corners']);
  });

  it('matches every piece for All', () => {
    expect(matchesInventoryFilter({ correctX: 1, correctY: 1 }, GRID_4X3, 'all')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
```

Expected: FAIL because `./inventory` does not exist.

- [ ] **Step 3: Implement the matcher only**

Create `apps/web/src/lib/services/gameplay/inventory.ts`:

```ts
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
import type { Puzzle, PuzzlePiece } from '$lib/types/puzzle';

export function matchesInventoryFilter(
  piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
  grid: Pick<Puzzle, 'gridCols' | 'gridRows'>,
  filter: InventoryFilter
): boolean {
  if (filter === 'all') return true;

  const onHorizontalBoundary = piece.correctX === 0 || piece.correctX === grid.gridCols - 1;
  const onVerticalBoundary = piece.correctY === 0 || piece.correctY === grid.gridRows - 1;
  const isCorner = onHorizontalBoundary && onVerticalBoundary;
  const isPerimeter = onHorizontalBoundary || onVerticalBoundary;

  if (filter === 'corners') return isCorner;
  if (filter === 'edges') return isPerimeter && !isCorner;
  return !isPerimeter;
}
```

Do not inspect `piece.edges` and do not add grid validation; puzzle/session metadata already validates grid shape.

- [ ] **Step 4: Run the focused test and warning-strict typecheck**

```bash
bunx vitest --run --browser src/lib/services/gameplay/inventory.test.ts
bun run check
```

Expected: matcher tests PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 5: Commit the pure helper slice**

```bash
git add src/lib/services/gameplay/inventory.ts src/lib/services/gameplay/inventory.test.ts
git commit -m "feat(web): add inventory coordinate filter matcher"
```

---

### Task 2: Finish PuzzleSession filter, Hint, reorder, and restart invariants

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Interfaces:**
- Consumes: `matchesInventoryFilter()` from Task 1 and the existing `update_tray_organization` action.
- Produces:
  - `set_filter` persists filter and clears a hidden selection atomically without setting activity;
  - successful `use_hint` resets a non-All filter to All before the existing event/notify;
  - main `reorder` validates an exact current-unplaced permutation and rewrites only unplaced slots;
  - reorder sets activity only when the full order changes;
  - non-main reorder remains `not_implemented`;
  - restart resets filter to All and retains other organization fields.

- [ ] **Step 1: Add an explicit 3×3 test metadata helper**

In `session.test.ts`, add a helper near `makeMetadata()` so center-piece tests never depend on the existing one-column behavior for odd counts:

```ts
function makeGridMetadata(gridCols: number, gridRows: number): PuzzleMetadata {
  const pieceCount = gridCols * gridRows;
  return {
    puzzleId: 'pz-grid',
    source: 'api',
    pieceCount,
    gridCols,
    gridRows,
    pieces: Array.from({ length: pieceCount }, (_, id) => ({
      id,
      correctX: id % gridCols,
      correctY: Math.floor(id / gridCols)
    }))
  };
}
```

- [ ] **Step 2: Add failing filter/activity/selection tests**

```ts
it('persists a filter change without marking gameplay activity', () => {
  const session = createPuzzleSession({ ...makeOptions({ metadata: makeGridMetadata(3, 3) }) });
  session.dispatch({ type: 'start' });

  expect(
    session.dispatch({
      type: 'update_tray_organization',
      update: { type: 'set_filter', filter: 'corners' }
    }).type
  ).toBe('tray_organization_applied');

  expect(session.getState().organization?.filter).toBe('corners');
  expect(session.getState().hasUserActivity).toBe(false);
});

it('keeps selection when the new filter still contains it', () => {
  const session = createPuzzleSession({ ...makeOptions({ metadata: makeGridMetadata(3, 3) }) });
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 0 });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  expect(session.getState().selectedPieceId).toBe(0);
});

it('clears selection in the same notification when the new filter hides it', () => {
  const session = createPuzzleSession({ ...makeOptions({ metadata: makeGridMetadata(3, 3) }) });
  session.dispatch({ type: 'start' });
  session.dispatch({ type: 'select_piece', pieceId: 4 });
  const observed: Array<{ filter: string | undefined; selectedPieceId: number | null }> = [];
  const unsubscribe = session.subscribe(() => {
    const state = session.getState();
    observed.push({ filter: state.organization?.filter, selectedPieceId: state.selectedPieceId });
  });

  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });
  unsubscribe();

  expect(observed).toEqual([{ filter: 'corners', selectedPieceId: null }]);
});
```

- [ ] **Step 3: Add the failing atomic Hint→All test**

```ts
it('reveals a successful hint by resetting the filter before the single notification', () => {
  const session = createPuzzleSession({ ...makeOptions({ metadata: makeGridMetadata(3, 3) }) });
  session.dispatch({ type: 'start' });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  const observed: string[] = [];
  const unsubscribe = session.subscribe(() => {
    observed.push(session.getState().organization?.filter ?? 'all');
  });

  const outcome = session.dispatch({ type: 'use_hint' });
  unsubscribe();

  expect(outcome.type).toBe('hint_used');
  expect(observed).toEqual(['all']);
  expect(session.getState().organization?.filter).toBe('all');
});
```

Do not add a route Hint test for this invariant.

- [ ] **Step 4: Replace the reorder placeholder with failing valid/invalid tests**

Use a placed piece so the test proves placed-index preservation:

```ts
it('reorders exactly the current unplaced pieces while keeping placed ids in their full-order slots', () => {
  const { session } = startedSession();
  session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
  const before = session.getState();

  const outcome = session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [3, 0, 2] }
  });

  expect(outcome.type).toBe('tray_organization_applied');
  expect(session.getState().trayOrder).toEqual([3, 1, 0, 2]);
  expect(session.getState().placedPieces).toEqual(before.placedPieces);
  expect(session.getState().elapsedActiveSeconds).toBe(before.elapsedActiveSeconds);
  expect(session.getState().timerStarted).toBe(before.timerStarted);
  expect(session.getState().pieceRotations).toEqual(before.pieceRotations);
  expect(session.getState().counters).toEqual(before.counters);
  expect(session.getState().facts).toEqual(before.facts);
  expect(session.getState().resultClass).toBe(before.resultClass);
  expect(session.getState().canUndo).toBe(before.canUndo);
  expect(session.getState().canRedo).toBe(before.canRedo);
});
```

Use wrapped `it.each` cases so Vitest passes each invalid array as one argument:

```ts
it.each([
  [[0, 2]],
  [[0, 2, 2]],
  [[0, 2, 999]],
  [[0, 1, 2]]
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

The invalid cases respectively cover missing ID, duplicate ID, unknown ID, and a placed ID.

- [ ] **Step 5: Add failing activity/history/restart tests**

```ts
it('does not mark activity for an identity main-tray reorder', () => {
  const { session } = startedSession();
  expect(session.getState().hasUserActivity).toBe(false);

  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [0, 1, 2, 3] }
  });

  expect(session.getState().trayOrder).toEqual([0, 1, 2, 3]);
  expect(session.getState().hasUserActivity).toBe(false);
});

it('marks activity when main-tray reorder changes the canonical order', () => {
  const { session } = startedSession();
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [3, 2, 1, 0] }
  });
  expect(session.getState().hasUserActivity).toBe(true);
});

it('does not let placement undo or redo revert a shuffled tray order', () => {
  const { session } = startedSession();
  session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'reorder', trayId: 'main', pieceIds: [3, 0, 2] }
  });
  const shuffled = session.getState().trayOrder.slice();

  session.dispatch({ type: 'undo' });
  expect(session.getState().trayOrder).toEqual(shuffled);
  session.dispatch({ type: 'redo' });
  expect(session.getState().trayOrder).toEqual(shuffled);
});

it('restarts with All while retaining other organization fields', () => {
  const { session } = startedSession();
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'rename_tray', trayId: 'future', name: 'Future' }
  });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_active_tray', trayId: 'future' }
  });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'corners' }
  });

  session.dispatch({ type: 'restart' });

  expect(session.getState().organization).toEqual({
    filter: 'all',
    activeTray: 'future',
    membership: {},
    names: { future: 'Future' }
  });
});
```

- [ ] **Step 6: Add a failing serialize/load round-trip for filter-only state**

```ts
it('round-trips a filter-only organization without fabricating activity', () => {
  const metadata = makeGridMetadata(3, 3);
  const session = createPuzzleSession({ ...makeOptions({ metadata }) });
  session.dispatch({ type: 'start' });
  session.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter: 'edges' }
  });

  const snapshot = serializeSession(session.getState(), 123)!;
  expect(snapshot.hasUserActivity).toBe(false);
  expect(snapshot.organization?.filter).toBe('edges');

  const loaded = loadPersistedSession(JSON.stringify(snapshot), contextFromMetadata(metadata));
  expect(loaded.status).toBe('loaded');
  if (loaded.status === 'loaded') {
    expect(loaded.snapshot.hasUserActivity).toBe(false);
    expect(loaded.snapshot.organization?.filter).toBe('edges');
  }
});
```

- [ ] **Step 7: Run the focused session tests and verify they fail against current behavior**

```bash
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected failures include: filter sets activity, Hint leaves filter unchanged, reorder is `not_implemented`, and restart retains non-All filter.

- [ ] **Step 8: Implement the session changes minimally**

At the top of `session.ts`, import:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
```

In `doUseHint()`, after `resultClass` is recomputed and before `hint_target` emit/notify:

```ts
if (state.organization && state.organization.filter !== 'all') {
  state.organization = { ...state.organization, filter: 'all' };
}
```

In `doUpdateTrayOrganization()`:

- keep the existing setup lifecycle guard;
- for `set_filter`, assign the new filter, clear a hidden selected piece using the shared matcher, assign `state.organization`, notify once, and return **without** setting activity;
- for `reorder`, handle it before the common organization tail:

```ts
case 'reorder': {
  if (update.trayId !== 'main') {
    return { type: 'tray_organization_noop', reason: 'not_implemented' };
  }

  const placedIds = new Set(state.placedPieces.map((placement) => placement.pieceId));
  const currentUnplacedIds = state.trayOrder.filter((id) => !placedIds.has(id));
  if (update.pieceIds.length !== currentUnplacedIds.length) {
    return { type: 'tray_organization_noop', reason: 'invalid_update' };
  }

  const expected = new Set(currentUnplacedIds);
  for (const id of update.pieceIds) {
    if (!expected.delete(id)) {
      return { type: 'tray_organization_noop', reason: 'invalid_update' };
    }
  }
  if (expected.size !== 0) {
    return { type: 'tray_organization_noop', reason: 'invalid_update' };
  }

  let nextIndex = 0;
  const nextTrayOrder = state.trayOrder.map((id) =>
    placedIds.has(id) ? id : update.pieceIds[nextIndex++]!
  );
  const changed = nextTrayOrder.some((id, index) => id !== state.trayOrder[index]);
  state.trayOrder = nextTrayOrder;
  if (changed) state.hasUserActivity = true;
  notify();
  return { type: 'tray_organization_applied', update };
}
```

For `set_filter`, use:

```ts
case 'set_filter': {
  organization.filter = update.filter;
  if (state.selectedPieceId !== null) {
    const selected = pieceById.get(state.selectedPieceId);
    if (selected && !matchesInventoryFilter(selected, state, update.filter)) {
      state.selectedPieceId = null;
    }
  }
  state.organization = organization;
  notify();
  return { type: 'tray_organization_applied', update };
}
```

Leave the shared `state.hasUserActivity = true` tail for the other existing organization mutations.

In `doRestart()`, replace whole-object filter retention with:

```ts
state.organization = retainedOrganization
  ? { ...retainedOrganization, filter: 'all' }
  : null;
```

Do not add `trayOrder` to `PlacementHistoryState` and do not call `pushHistory()` from filter/reorder.

- [ ] **Step 9: Run the session tests and persistence-focused files**

```bash
bunx vitest --run --browser \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-fields.test.ts
bun run check
```

Expected: all focused tests PASS; check is clean.

- [ ] **Step 10: Commit the canonical session behavior**

```bash
git add src/lib/services/gameplay/session/session.ts src/lib/services/gameplay/session/session.test.ts
git commit -m "feat(web): add inventory filter and reorder session behavior"
```

---

### Task 3: Add controlled inventory filters, Shuffle, empty state, and mobile budget

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte` (prop/callback wiring required so the production route remains typecheckable)

**Interfaces:**
- `PuzzleInventoryPanel` consumes:

```ts
activeFilter: InventoryFilter;
onFilterChange: (filter: InventoryFilter) => void;
onShuffle: () => void;
```

- The route supplies those controlled values/callbacks; no panel-local filter/shuffle state is introduced.

- [ ] **Step 1: Add a 3×3 component fixture and failing filter tests**

In `PuzzleInventoryPanel.svelte.test.ts`, add a `filterPuzzle` with nine pieces whose `correctX/correctY` cover a 3×3 grid. Reuse the existing image data URI and minimal edge objects; edges are not classification inputs.

Add:

```ts
it('renders only unplaced pieces matching the controlled filter while keeping total LEFT', async () => {
  render(PuzzleInventoryPanel, {
    ...baseProps(),
    puzzle: filterPuzzle,
    trayOrder: filterPuzzle.pieces.map((piece) => piece.id),
    placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
    activeFilter: 'corners'
  });

  await expect.element(page.getByText('8 LEFT')).toBeVisible();
  expect(page.getByTestId('piece-slot-0').query()).toBeNull();
  await expect.element(page.getByTestId('piece-slot-2')).toBeVisible();
  await expect.element(page.getByTestId('piece-slot-6')).toBeVisible();
  await expect.element(page.getByTestId('piece-slot-8')).toBeVisible();
  expect(page.getByTestId('piece-slot-4').query()).toBeNull();
});
```

- [ ] **Step 2: Add failing control/accessibility tests**

Extend `baseProps()` with:

```ts
activeFilter: 'all' as const,
onFilterChange: vi.fn(),
onShuffle: vi.fn()
```

Add:

```ts
it('forwards all four filter values and exposes pressed state', async () => {
  const input = baseProps();
  render(PuzzleInventoryPanel, input);

  await page.getByRole('button', { name: 'All pieces' }).click();
  await page.getByRole('button', { name: 'Corner pieces' }).click();
  await page.getByRole('button', { name: 'Edge pieces' }).click();
  await page.getByRole('button', { name: 'Center pieces' }).click();

  expect(input.onFilterChange.mock.calls.map(([filter]) => filter)).toEqual([
    'all',
    'corners',
    'edges',
    'center'
  ]);
  await expect.element(page.getByRole('button', { name: 'All pieces' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

it('forwards Shuffle and disables it with fewer than two unplaced pieces', async () => {
  const input = baseProps();
  const view = render(PuzzleInventoryPanel, input);
  const shuffle = page.getByRole('button', { name: 'Shuffle pieces' });

  await shuffle.click();
  expect(input.onShuffle).toHaveBeenCalledOnce();

  await view.rerender({
    ...input,
    placedPieces: [{ pieceId: 0, x: 0, y: 0 }]
  });
  await expect.element(shuffle).toBeDisabled();
});
```

- [ ] **Step 3: Add failing empty-filter and drawer-ownership tests**

```ts
it('shows a clear empty-filter message when unplaced pieces exist but none match', async () => {
  render(PuzzleInventoryPanel, {
    ...baseProps(),
    activeFilter: 'center'
  });
  await expect.element(page.getByText('NO PIECES MATCH')).toBeVisible();
  expect(page.getByText('ALL PIECES PLACED').query()).toBeNull();
});

it('keeps the tools inside the collapsible drawer body on one non-wrapping row', async () => {
  render(PuzzleInventoryPanel, baseProps());
  const tools = document.querySelector<HTMLElement>('#puzzle-inventory-body .inventory-tools');
  expect(tools).not.toBeNull();
  const style = getComputedStyle(tools!);
  expect(style.flexWrap).toBe('nowrap');
  expect(style.overflowX).toBe('auto');

  await page.getByRole('button', { name: 'Collapse inventory' }).click();
  const body = document.querySelector<HTMLElement>('#puzzle-inventory-body')!;
  await expect.poll(() => getComputedStyle(body).display).toBe('none');
});
```

- [ ] **Step 4: Run the component test and verify it fails for missing props/controls/projection**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 5: Implement the controlled projection and controls**

In `PuzzleInventoryPanel.svelte` import:

```ts
import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
```

Add required props and destructure them.

Replace the render-time placed check with explicit derived lists:

```ts
const unplacedPieces = $derived(
  orderedPieces.filter((piece) => !placedPieceIds.has(piece.id))
);

const visiblePieces = $derived(
  unplacedPieces.filter((piece) => matchesInventoryFilter(piece, puzzle, activeFilter))
);
```

Inside `#puzzle-inventory-body`, before `.pieces-grid`, add:

```svelte
<div class="inventory-tools" data-testid="inventory-tools">
  <button
    type="button"
    class="panel-action"
    aria-label="All pieces"
    aria-pressed={activeFilter === 'all'}
    onclick={() => onFilterChange('all')}
  >ALL</button>
  <button
    type="button"
    class="panel-action"
    aria-label="Corner pieces"
    aria-pressed={activeFilter === 'corners'}
    onclick={() => onFilterChange('corners')}
  >CORNERS</button>
  <button
    type="button"
    class="panel-action"
    aria-label="Edge pieces"
    aria-pressed={activeFilter === 'edges'}
    onclick={() => onFilterChange('edges')}
  >EDGES</button>
  <button
    type="button"
    class="panel-action"
    aria-label="Center pieces"
    aria-pressed={activeFilter === 'center'}
    onclick={() => onFilterChange('center')}
  >CENTER</button>
  <button
    type="button"
    class="panel-action"
    aria-label="Shuffle pieces"
    disabled={unplacedPieces.length <= 1}
    onclick={onShuffle}
  >SHUFFLE</button>
</div>
```

Render `visiblePieces` directly in the existing slot markup.

After `.pieces-grid`, add the empty state only when there are unplaced pieces but no visible matches:

```svelte
{#if unplacedPieces.length > 0 && visiblePieces.length === 0}
  <div class="filter-empty-msg" data-testid="inventory-filter-empty">NO PIECES MATCH</div>
{/if}
```

Keep the existing all-placed message for `unplacedPieces.length === 0`.

- [ ] **Step 6: Reuse `.panel-action` and add only tools/empty-state layout CSS**

Do not duplicate the coarse-pointer min-height rule.

Add:

```css
.inventory-tools {
  display: flex;
  flex-wrap: nowrap;
  flex-shrink: 0;
  gap: 0.5rem;
  overflow-x: auto;
  padding: 0.5rem 0.875rem;
  border-bottom: 1px solid var(--border);
}

.inventory-tools .panel-action {
  flex: 0 0 auto;
}

.filter-empty-msg {
  flex-shrink: 0;
  padding: 0.75rem;
  border-top: 1px solid var(--border);
  font-family: var(--font-display);
  font-size: 0.6rem;
  letter-spacing: 0.15em;
  text-align: center;
  color: var(--text-2);
}
```

In the existing mobile media block, add the explicit larger cap:

```css
@media (max-width: 1023px) {
  .inventory-panel {
    --piece-slot-size: clamp(3rem, 16vw, 4.5rem);
    max-height: 20rem;
  }
}
```

Do not change the desktop rule that removes max-height.

- [ ] **Step 7: Wire required props through the route so the branch typechecks**

In `+page.svelte`, import:

```ts
import { shuffleArray } from '$lib/utils/shuffle';
import type { InventoryFilter } from '$lib/services/gameplay/session/types';
```

Add:

```ts
const activeInventoryFilter = $derived<InventoryFilter>(
  sessionState?.organization?.filter ?? 'all'
);

function handleInventoryFilterChange(filter: InventoryFilter) {
  if (!sessionStore) return;
  sessionStore.dispatch({
    type: 'update_tray_organization',
    update: { type: 'set_filter', filter }
  });
  checkpointSession();
}

function handleInventoryShuffle() {
  if (!sessionStore || !sessionState) return;
  const unplacedPieceIds = sessionState.trayOrder.filter((id) => !placedPieceIds.has(id));
  if (unplacedPieceIds.length <= 1) return;
  sessionStore.dispatch({
    type: 'update_tray_organization',
    update: {
      type: 'reorder',
      trayId: 'main',
      pieceIds: shuffleArray([...unplacedPieceIds])
    }
  });
  checkpointSession();
}
```

`shuffleArray()` currently accepts a mutable array, so pass a shallow copy. Do **not** modify `handleHint()`.

Pass to `PuzzleInventoryPanel`:

```svelte
activeFilter={activeInventoryFilter}
onFilterChange={handleInventoryFilterChange}
onShuffle={handleInventoryShuffle}
```

- [ ] **Step 8: Run component tests and typecheck**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
```

Expected: component tests PASS; check clean.

- [ ] **Step 9: Commit the controlled inventory UI slice**

```bash
git add \
  src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte'
git commit -m "feat(web): add inventory filters and shuffle controls"
```

---

### Task 4: Prove route persistence, Shuffle RNG reuse, and no fake progress

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes the production route wiring from Task 3.
- Produces integration fences that prove filter checkpoints remain non-activity and Shuffle uses current tray order through the existing session/persistence path.

The route-test `saveSession` mock receives the real serializer output because the existing persistence mock delegates `serializeSession()` to production. Assert the second positional argument of the latest `saveSession(puzzleId, snapshot)` call.

- [ ] **Step 1: Add a failing filter persistence test**

Use the existing two-piece route fixture; both pieces are corners, so `EDGES` gives a deterministic empty projection:

```ts
it('persists a filter without locking setup or creating gameplay activity', async () => {
  await renderPuzzlePage();
  sessionStorageSpies.saveSession.mockClear();

  await page.getByRole('button', { name: 'Edge pieces' }).click();

  await expect.element(page.getByText('NO PIECES MATCH')).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Open mission setup' })).toBeVisible();
  expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
  const snapshot = sessionStorageSpies.saveSession.mock.calls.at(-1)?.[1];
  expect(snapshot).toMatchObject({
    hasUserActivity: false,
    organization: { filter: 'edges' }
  });
});
```

- [ ] **Step 2: Add a deterministic changed-Shuffle integration test**

Temporarily replace `Math.random` inside the test only. With two unplaced IDs and `Math.random = () => 0`, the existing Fisher–Yates swaps them:

```ts
it('shuffles all unplaced ids through the existing Fisher-Yates path and checkpoints', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    await renderPuzzlePage();
    sessionStorageSpies.saveSession.mockClear();

    const before = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]')
    ).map((slot) => slot.dataset.testid);
    expect(before).toEqual(['piece-slot-0', 'piece-slot-1']);

    await page.getByRole('button', { name: 'Shuffle pieces' }).click();

    await expect.poll(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]')).map(
        (slot) => slot.dataset.testid
      )
    ).toEqual(['piece-slot-1', 'piece-slot-0']);

    const snapshot = sessionStorageSpies.saveSession.mock.calls.at(-1)?.[1];
    expect(snapshot).toMatchObject({ trayOrder: [1, 0], hasUserActivity: true });
  } finally {
    Math.random = originalRandom;
  }
});
```

- [ ] **Step 3: Add an identity-Shuffle regression proving no fabricated activity**

With two items and `Math.random = () => 0.999999`, Fisher–Yates picks index 1 and leaves the order unchanged. HPA-220 deliberately accepts this random identity and must not turn it into fake progress:

```ts
it('accepts a random identity shuffle without fabricating resumable activity', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    await renderPuzzlePage();
    sessionStorageSpies.saveSession.mockClear();

    await page.getByRole('button', { name: 'Shuffle pieces' }).click();

    const snapshot = sessionStorageSpies.saveSession.mock.calls.at(-1)?.[1];
    expect(snapshot).toMatchObject({ trayOrder: [0, 1], hasUserActivity: false });
  } finally {
    Math.random = originalRandom;
  }
});
```

This test is HPA-220-specific; do not add `0.999999` behavior to the shared shuffle utility tests.

- [ ] **Step 4: Run the focused route and component/session fences**

```bash
bunx vitest --run --browser \
  'src/routes/puzzle/[id]/page.svelte.test.ts' \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/services/gameplay/inventory.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the route integration tests**

```bash
git add 'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "test(web): cover inventory filter and shuffle route wiring"
```

---

### Task 5: Strengthen the real 390×844 mobile geometry fence and run final gates

**Files:**
- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**Interfaces:**
- Extends the existing HPA-219 `e2e-square-100` Chromium-mobile scroll test.
- Proves the new tools row does not consume the large-inventory drawer: panel fits viewport and the piece grid retains two complete rows of usable vertical content.

- [ ] **Step 1: Extend the existing large-inventory test with a concrete two-row budget**

After `gotoFixture({ fixtureId: 'e2e-square-100', ... })`, before the swipe, add:

```ts
const panel = page.getByTestId('puzzle-inventory-panel');
const viewport = page.viewportSize();
const panelBox = await panel.boundingBox();
const firstSlotBox = await page.locator('[data-testid^="piece-slot-"]').first().boundingBox();
expect(viewport).toEqual({ width: 390, height: 844 });
expect(panelBox).not.toBeNull();
expect(firstSlotBox).not.toBeNull();
expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport!.height);

const gridBudget = await grid.evaluate((element) => {
  const style = getComputedStyle(element);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const rowGap = Number.parseFloat(style.rowGap) || 0;
  return {
    contentHeight: element.clientHeight - paddingTop - paddingBottom,
    rowGap
  };
});

expect(gridBudget.contentHeight).toBeGreaterThanOrEqual(
  firstSlotBox!.height * 2 + gridBudget.rowGap
);
```

Keep the existing scroll gesture and `scrollTop` assertion. Keep the existing four-piece test as the horizontal-density proof; do not treat it as the vertical budget proof.

- [ ] **Step 2: Prove the new geometry assertion detects the old 16rem regression**

Temporarily change the mobile `max-height` in `PuzzleInventoryPanel.svelte` from `20rem` back to `16rem` **without committing it**, then run:

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile \
  --grep "large mobile inventory"
```

Expected: FAIL on the two-row content-height assertion.

Restore `max-height: 20rem` immediately.

- [ ] **Step 3: Run the same test with the intended 20rem cap**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile \
  --grep "large mobile inventory"
```

Expected: PASS, including the existing real touch-swipe scroll assertion.

If the old 16rem cap does not fail the new assertion, the assertion is not sensitive enough: do not weaken the requirement or commit. Refine the assertion so it measures the same two-row rendered content budget, then repeat the 16rem-fail/20rem-pass proof. Do not add a new layout framework or preview-size preference.

- [ ] **Step 4: Run the full focused feature set**

```bash
bunx vitest --run --browser \
  src/lib/services/gameplay/inventory.test.ts \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS with zero failures.

- [ ] **Step 5: Run project static/build gates**

```bash
bun run check
bun run lint
bun run build
```

Expected: all commands exit 0; Svelte check has no errors/warnings.

- [ ] **Step 6: Run the existing Chromium smoke lane**

```bash
bun run test:e2e:smoke
```

Expected: smoke suite passes with only the repository's explicitly expected skips.

- [ ] **Step 7: Verify scope and no forbidden duplication**

From repository root:

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD
rg "shufflePieceIds|shuffleDistinct|preview.*size|piece.*size.*preference" apps/web/src
```

Expected:

- diff check clean;
- changed source/test files are limited to the HPA-220 file map above;
- no `shufflePieceIds` / `shuffleDistinct` helper exists;
- no preview-size preference was introduced.

Also inspect `PlacementHistoryState` in `session.ts` and confirm it still contains only `placedPieces`, `pieceRotations`, and `rotationEnabled` — **not `trayOrder`**.

- [ ] **Step 8: Commit the geometry regression fence**

```bash
git add e2e/gameplay-mobile-tap.spec.ts
git commit -m "test(web): protect mobile inventory filter budget"
```

---

## Implementation completion checklist

Before marking HPA-220 ready for review, verify each requirement directly:

- [ ] coordinate matcher shared by engine and panel;
- [ ] no classification from connector edges;
- [ ] filter-only state persists with `hasUserActivity === false`;
- [ ] Mission Setup remains available after a filter-only action;
- [ ] selected piece clears atomically only when hidden by a filter;
- [ ] successful Hint resets filter to All inside one session transition;
- [ ] restart resets filter to All while retaining other organization fields;
- [ ] route reuses existing `shuffleArray()` and has no second Fisher–Yates;
- [ ] identity random shuffle is allowed and does not fabricate activity;
- [ ] changed reorder marks activity;
- [ ] exact main-unplaced permutation validation rejects missing/duplicate/unknown/placed IDs;
- [ ] placed IDs keep their full-order indices;
- [ ] non-main reorder remains not implemented;
- [ ] placement Undo/Redo never reverts shuffled tray order;
- [ ] empty filter shows `NO PIECES MATCH`;
- [ ] `N LEFT` remains total unplaced;
- [ ] filter/Shuffle controls reuse `.panel-action` inside the drawer body;
- [ ] mobile cap is 20rem only below 1024px; desktop behavior unchanged;
- [ ] 390×844 large-inventory E2E proves panel fit plus two complete piece rows;
- [ ] the geometry test is demonstrated to fail under the old 16rem cap and pass at 20rem;
- [ ] no new inventory store/controller/query framework, schema version, preview-size preference, or shuffle helper was added.
