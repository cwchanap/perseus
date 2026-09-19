# HPA-466 Selected-Piece Inspection and Placement Feedback — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Improve selected-piece inspection and placement feedback in the existing web puzzle flow without changing gameplay authority, persistence, or backend contracts.

**Architecture:** `PuzzleSession` remains the only gameplay owner. `PuzzleInventoryPanel` derives preview/count UI from current props. `+page.svelte` inspects the existing `attempt_placement` dispatch result and owns one 500 ms ephemeral `placementFeedback`, matching the shipped mobile composition-root pattern. `PuzzleBoard` only renders candidate CSS and prop-driven overlays.

**Tech stack:** Svelte 5, TypeScript, `@perseus/game-core`, Vitest browser tests, existing Playwright gameplay smoke.

## Global constraints

- No new gameplay store/controller/read-model framework.
- No game-core action, event, codec, or persistence changes.
- Keep `onPiecePlaced` void; do not introduce a return contract through the component tree.
- No backend/API/workflow changes.
- No generated image assets.
- No NativeScript implementation work.
- Keep current hint, shuffle, filter persistence, selection, rotation, undo/redo, completion, and live-region semantics.
- Correctness stays exclusively in `PuzzleSession`.
- Reuse `REJECTED_DURATION_MS = 500` for board feedback lifetime.
- One implementation PR; do not split this ticket.

## File map

**Modify**

- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**Do not modify by default**

- `packages/game-core/**`
- `apps/web/src/lib/components/PuzzlePiece.svelte`
- persistence/codec modules;
- backend/mobile production code;
- unrelated E2E specs/helpers.

---

## Task 1: Add a bounded selected-piece preview and truthful filter status

### Files

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

### 1.1 Add failing inventory tests first

Extend the current component suite with tests for:

- selected piece renders a dedicated preview;
- preview copies the existing tab-offset artwork shape instead of a bare cropped image;
- preview rotation follows `pieceRotations`;
- selection clear removes it;
- peek hides it with the existing body;
- All / Corners / Edges / Center remaining counts use unplaced pieces;
- counts update after `placedPieces` changes;
- existing 2×1 Edge/Center cases keep factual `NO PIECES MATCH`;
- a filter kind that exists but is fully placed shows `ALL … PLACED`;
- both empty-state branches expose `SHOW ALL REMAINING`;
- recovery invokes `onFilterChange('all')`;
- the component never auto-switches the active filter.

Explicitly update the current `NO PIECES MATCH` tests instead of deleting/replacing them.

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected before implementation: new assertions fail.

### 1.2 Derive selected piece and filter counts from current props

Reuse `piecesById`, `unplacedPieces`, and `matchesInventoryFilter`.

Add:

- one derived `selectedPiece`;
- one local `remainingCount(filter)`;
- one local `totalCount(filter)` for distinguishing "none exist" from "all placed".

Do not lift these counts into game-core and do not persist them.

### 1.3 Render the preview using existing piece geometry

Inside `.inventory-body`, before the grid:

- render only while `selectedPiece !== null`;
- use a one-`--piece-slot-size` preview box;
- copy the inner `EXPANSION_FACTOR / TAB_RATIO` image framing from existing piece rendering;
- apply `displayedRotation(selectedPiece.id)`;
- mark duplicate artwork `aria-hidden` / empty alt;
- keep Rotate/Cancel in the current header.

Do not render a bare square image.
Do not add a read-only `PuzzlePiece` mode.
Do not create a third piece component.

### 1.4 Add counts without changing header geometry

Keep existing control names as prefixes and add remaining counts to accessible labels, e.g.:

- `All pieces, 7 remaining`
- `Corner pieces, 2 remaining`

A small visible badge is optional only if it fits inside the current fixed control cleanly.

Hard constraints:

- `.inventory-tools` stays non-wrapping;
- do not enlarge the mobile hit-target row to fit text;
- if a visible count causes overflow, use accessible-label-only counts.

### 1.5 Make empty-filter copy truthful

For non-All filters with no visible pieces and an incomplete puzzle:

- `totalCount(activeFilter) === 0` -> keep `NO PIECES MATCH`;
- `totalCount(activeFilter) > 0 && remainingCount(activeFilter) === 0` -> show the matching `ALL … PLACED` copy;
- both branches show `SHOW ALL REMAINING`;
- recovery calls existing `onFilterChange('all')` only when activated.

Keep `ALL PIECES PLACED` unchanged for full completion.

### 1.6 Re-run focused inventory tests

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: pass.

---

## Task 2: Add neutral candidate styling and a prop-driven board feedback overlay

### Files

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`

### 2.1 Add failing board tests

Extend `PuzzleBoard.svelte.test.ts` to prove:

- candidate-enabled state exists only while `selectedPieceId !== null`;
- candidate CSS is restricted to `.cell-empty`;
- occupied cells are not candidates;
- `cell-drop-over` remains the drag-over state rather than also receiving candidate chrome;
- accepted `placementFeedback` prop renders on its exact cell;
- rejected `placementFeedback` prop renders on its exact cell;
- accepted feedback still renders when the target cell is already occupied after canonical state updates;
- placement feedback and hint target can coexist at one cell;
- existing click/keyboard/drag paths still call the void `onPiecePlaced` callback without local correctness logic.

No timer tests belong here; the board does not own feedback lifetime.

### 2.2 Add state-free candidate styling

Mark the board root when a piece is selected:

```svelte
data-candidate-enabled={selectedPieceId !== null ? 'true' : undefined}
```

CSS targets only:

- candidate-enabled board;
- `.cell-empty:hover`;
- `.cell-empty:focus-visible`.

Do not add a candidate-cell Svelte state value.

Because `getCellStyle()` already chooses `cell-drop-over` instead of `cell-empty`, drag-over remains the winner.

### 2.3 Add optional placement feedback prop

Add to `PuzzleBoardPanel` and `PuzzleBoard`:

```ts
placementFeedback?: {
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
} | null;
```

Keep:

```ts
onPiecePlaced: (pieceId: number, x: number, y: number) => void;
```

`PuzzleBoardPanel` only forwards the prop.

### 2.4 Render feedback independently of `getCellStyle`

For the matching cell, render a pointer-events-none `data-testid="placement-feedback"` child similar to `hint-target`.

Do not fold accepted/rejected into `getCellStyle()`; accepted feedback must survive the same render that turns the cell into `cell-occupied`.

Pin layering:

- placed artwork remains visible;
- placement feedback remains visible above the cell/art edge;
- hint target remains visible if it overlaps placement feedback;
- overlay never receives input.

Use distinct accepted/rejected border/background/outline treatment.

### 2.5 Reduced motion

Add/extend CSS so `prefers-reduced-motion: reduce` disables movement/pulse but leaves static feedback visible.

No JS media-query state.

### 2.6 Re-run board tests

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: pass.

---

## Task 3: Own the 500 ms placement feedback at the route composition root

### Files

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

### 3.1 Add failing route tests

Add focused tests proving:

1. accepted placement sets an accepted board overlay at the attempted cell;
2. accepted placement still checkpoints and canonical selection clears;
3. rejected placement sets a rejected board overlay at the attempted cell;
4. rejected placement keeps canonical selection and existing tray-piece rejected state;
5. existing accepted/rejected live-region announcements remain unchanged;
6. a second attempt replaces the first placement feedback;
7. placement feedback clears after **500 ms** using the existing duration;
8. navigation/run reset does not leave stale placement feedback;
9. rotation updates the selected preview from canonical `pieceRotations`;
10. placements update the filter counts from canonical `placedPieces`.

Use the existing fake-timer route pattern already used for rejected-piece timeout coverage.

Do not try to assert an internal `handlePiecePlaced` return value; the callback stays void.

### 3.2 Add route-local feedback next to existing rejected-piece state

Add:

```ts
let placementFeedback = $state<{
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
} | null>(null);

let placementFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;
```

Add small helpers to set/replace and clear feedback.

Use `REJECTED_DURATION_MS` for the timeout. Do not add another duration constant.

### 3.3 Extend `handlePiecePlaced` without changing its callback contract

Keep:

```ts
function handlePiecePlaced(pieceId: number, x: number, y: number) {
  if (!sessionStore) return;

  const result = sessionStore.dispatch({
    type: 'attempt_placement',
    pieceId,
    x,
    y
  });

  if (
    result.type === 'placement' &&
    (result.outcome.status === 'accepted' || result.outcome.status === 'rejected')
  ) {
    showPlacementFeedback(x, y, result.outcome.status);
  }

  checkpointSession();
}
```

No event correlation state.
No return contract through `PuzzleBoard`.
No game-core change.

### 3.4 Pass feedback down and clear stale state

Pass `placementFeedback` through `PuzzleBoardPanel`.

Clear placement feedback:

- on component destroy;
- when direct puzzle navigation resets route-local presentation state;
- when restarting/play-again resets the run, matching other ephemeral gameplay chrome.

Keep route-level `rejectedPiece` and its existing announcement behavior unchanged.

### 3.5 Run focused route tests

```bash
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: pass.

---

## Task 4: Protect the mobile half-sheet budget in the existing smoke

### Files

- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

### 4.1 Extend the existing large-inventory smoke, do not add a new spec

The existing `large mobile inventory scrolls from a swipe starting on a piece @smoke` already owns:

- 390×844 fold fit;
- large inventory;
- two complete piece rows;
- tray scrolling.

Extend that same test (or the adjacent existing mobile-inventory smoke if cleaner):

1. select one tray piece so the new preview is mounted;
2. assert the panel still fits within the viewport;
3. assert the grid still retains two complete piece rows;
4. keep the existing swipe-scroll proof.

If visible count badges break the budget, drop the visible badge and retain count in accessible labels instead of widening/wrapping the header.

No new Playwright spec.

---

## Task 5: Final verification and scope review

### 5.1 Focused unit/component/route tests

From `apps/web`:

```bash
bunx vitest --run --browser   src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts   src/lib/components/__tests__/PuzzleBoard.svelte.test.ts   'src/routes/puzzle/[id]/page.svelte.test.ts'
```

### 5.2 Type/Svelte check

```bash
bun run check
```

Expected: 0 Svelte/TypeScript errors.

### 5.3 Existing gameplay smoke

```bash
bun run test:e2e:smoke
```

The selected-preview half-sheet density assertion lives in the existing smoke suite; do not create another E2E lane.

### 5.4 Scope review

Confirm the implementation does **not** add:

- game-core event/action/codec changes;
- a callback return contract;
- persistence fields;
- generic animation helpers/frameworks;
- new stores/controllers;
- a third piece-rendering abstraction;
- new image assets;
- backend/mobile production work;
- unrelated refactors.

## Implementation checklist

- [ ] 1. Add tab-framed selected preview + remaining counts + truthful exhausted-filter recovery
- [ ] 2. Add neutral candidate CSS + prop-driven board feedback overlay
- [ ] 3. Own/clear 500 ms placement feedback at the route and pin integration tests
- [ ] 4. Extend existing mobile smoke with selected-preview density
- [ ] 5. Run focused tests, `bun run check`, and gameplay smoke

## Risks

- **False empty-state copy:** 2×1 fixtures have no Edge/Center pieces; distinguish zero total from zero remaining.
- **Half-sheet density:** preview is one slot, controls never wrap, selected-state smoke keeps two visible rows.
- **Overlay stacking:** feedback is a child overlay independent of `getCellStyle`; pin coexistence with hint, drag-over, and occupied cells.
- **Duplicate accessibility output:** no new live region; session events remain semantic feedback.
- **Stale feedback:** one replaceable 500 ms route timeout, cleared on navigation/restart/teardown.

## Planning verification

- Planning branch remains documentation-only.
- Current web callbacks remain void.
- Current mobile gameplay already owns placement feedback at the composition root and passes it to the renderer.
- Existing web 2×1 fixtures prove unconditional `ALL EDGES/CENTER PLACED` would be false.
- Current piece rendering uses `EXPANSION_FACTOR / TAB_RATIO`; the preview must reuse that framing.
- Existing mobile smoke already owns fold-fit/two-row tray density and will be extended rather than duplicated.
- No generated art task is required.
