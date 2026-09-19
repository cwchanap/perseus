# HPA-466 Selected-Piece Inspection and Placement Feedback — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Improve selected-piece inspection and placement feedback in the existing web puzzle flow without changing gameplay authority, persistence, or backend contracts.

**Architecture:** `PuzzleSession` remains the only gameplay owner. The existing selected tray slot expands 2×2 rather than adding a duplicate preview surface. `+page.svelte` owns one 500 ms `placementFeedback {pieceId,x,y,kind}` derived from the existing dispatch result; `rejectedPiece` derives from it. `PuzzleBoard` only renders a prop-driven overlay plus CSS-only candidate state.

**Tech stack:** Svelte 5, TypeScript, `@perseus/game-core`, Vitest browser tests, existing Playwright gameplay smoke.

## Global constraints

- No new gameplay store/controller/read-model framework.
- No game-core action, event, codec, or persistence changes.
- Keep `onPiecePlaced` void.
- No separate preview surface or duplicate piece artwork.
- No new `PieceArtwork` extraction in this ticket.
- No backend/API/workflow changes.
- No generated image assets.
- No NativeScript implementation work.
- Keep current hint, shuffle, filter persistence, selection, rotation, undo/redo, completion, and live-region semantics.
- Correctness stays exclusively in `PuzzleSession`.
- Reuse `REJECTED_DURATION_MS = 500`.
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
- unrelated E2E specs/helpers;
- new shared artwork component.

---

## Task 1: Enlarge the selected tray slot and make filter status explicit

### Files

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

### 1.1 Add failing inventory tests first

Extend the existing component suite with tests for:

- selected piece slot enters an expanded 2×2 state;
- selected slot's rendered dimensions are materially larger than an unselected slot;
- the same `PuzzlePiece` instance/interaction path remains in use;
- rotation still updates the selected enlarged piece;
- cancel/selection clear removes the expanded state;
- peek hides the tray body/grid as before;
- All / Corners / Edges / Center each show a visible remaining-count badge;
- accessible labels retain their current prefix and include remaining count;
- counts update after `placedPieces` changes;
- existing 2×1 Edge/Center cases keep factual `NO PIECES MATCH`;
- an existing filter kind with zero remaining shows `ALL … PLACED`;
- both empty-state branches show `SHOW ALL REMAINING`;
- recovery invokes `onFilterChange('all')`;
- no filter auto-switch occurs.

Explicitly update the current `NO PIECES MATCH` tests instead of deleting/replacing them.

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected before implementation: new assertions fail.

### 1.2 Expand the selected slot in the existing grid

Reuse the current `piece-slot` and `PuzzlePiece` markup.

When `selectedPieceId === piece.id`, apply one presentation class/data attribute that:

- spans 2 columns and 2 rows;
- expands the slot to the size of those two tracks plus the existing gap;
- leaves all selection/rotation/drag/keyboard behavior inside `PuzzlePiece` unchanged.

Do not add a second image or preview container.
Do not modify `PuzzlePiece.svelte`.
Do not extract a shared artwork component.

Pin the 2×2 math against existing `--piece-slot-size` and `--inventory-gap`; do not invent a new preview-size preference.

### 1.3 Derive filter counts locally

Reuse `unplacedPieces` and `matchesInventoryFilter`.

Add:

- `remainingCount(filter)`;
- `totalCount(filter)`.

No persistence/read model/game-core change.

### 1.4 Render fixed-size visible count badges

Every filter button (All, Corners, Edges, Center) gets one compact absolutely-positioned numeric badge.

Requirements:

- button width/height stay unchanged;
- `.inventory-tools` remains non-wrapping;
- badge has `pointer-events: none`;
- count 0 is shown, not omitted;
- accessible label also includes the count.

At 1024–1279, non-All counts appear in the existing filter popup when it is opened; do not add another summary-count state.

### 1.5 Make empty-filter copy truthful

For non-All filters with no visible pieces and an incomplete puzzle:

- `totalCount(activeFilter) === 0` -> `NO PIECES MATCH`;
- `totalCount(activeFilter) > 0 && remainingCount(activeFilter) === 0` -> matching `ALL … PLACED`;
- both show `SHOW ALL REMAINING`;
- recovery calls existing `onFilterChange('all')` only when activated.

Keep `ALL PIECES PLACED` unchanged for full completion.

### 1.6 Re-run focused inventory tests

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: pass.

---

## Task 2: Add touch-visible candidate state and explicitly stacked board feedback

### Files

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`

### 2.1 Add failing board tests against observable behavior

Extend `PuzzleBoard.svelte.test.ts` to prove:

- `data-candidate-enabled` exists only while `selectedPieceId !== null`;
- an empty cell's computed candidate styling changes while selected even without hover;
- occupied cells keep `cell-occupied` and do not receive baseline candidate styling;
- drag-over still produces `cell-drop-over`;
- accepted `placementFeedback` prop renders on the exact cell;
- rejected `placementFeedback` prop renders on the exact cell;
- accepted feedback renders even after the target cell becomes occupied;
- placement feedback and hint target can coexist;
- computed placement-feedback z-index exceeds the placed image z-index;
- computed hint-target z-index exceeds placement-feedback z-index;
- existing click/keyboard/drag paths still call void `onPiecePlaced` without local correctness checks.

Do not assert raw stylesheet text.

### 2.2 Add baseline + emphasized candidate CSS

Mark the board root:

```svelte
data-candidate-enabled={selectedPieceId !== null ? 'true' : undefined}
```

Add:

- subtle neutral baseline style for candidate-enabled `.cell-empty`;
- stronger neutral style for candidate-enabled `.cell-empty:hover` and `:focus-visible`.

Do not add candidate state.

Keep `getCellStyle()` unchanged so `cell-drop-over` remains exclusive and wins naturally.

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

### 2.4 Render feedback independently of cell classes

For the matching cell render a pointer-events-none `data-testid="placement-feedback"` child.

Do not add accepted/rejected to `getCellStyle()`.

Pin z-levels:

```ts
const overlayBaseZ = puzzle.gridRows * puzzle.gridCols;
placementFeedback z-index = overlayBaseZ + 1;
hint target z-index = overlayBaseZ + 2;
```

This keeps feedback above every placed piece/tab and the hint above feedback.

Use distinct accepted/rejected outline/background treatments.

### 2.5 Reduced motion

Under `prefers-reduced-motion: reduce`, disable movement/pulse while keeping static feedback styling.

No JS motion-query state.

### 2.6 Re-run board tests

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: pass.

---

## Task 3: Collapse route rejection + board feedback to one state/timer

### Files

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

### 3.1 Add failing route tests

Add focused tests proving:

1. accepted placement sets `{pieceId,x,y,kind:'accepted'}`;
2. accepted placement still checkpoints and canonical selection clears;
3. rejected placement sets `{pieceId,x,y,kind:'rejected'}`;
4. rejected placement keeps canonical selection;
5. derived rejected piece still drives the existing tray shake;
6. placement-rejected session event still emits the existing announcement;
7. a second attempt replaces the first feedback/timer;
8. feedback clears after **500 ms**;
9. navigation/restart does not leave stale feedback;
10. rotation still updates the same enlarged selected `PuzzlePiece`;
11. placements update filter counts from canonical `placedPieces`.

Use the existing fake-timer route pattern already used for rejection timeout coverage.

### 3.2 Replace duplicate route visual state

Replace:

- `rejectedPiece` state;
- `rejectedPieceTimeout`.

With:

```ts
let placementFeedback = $state<{
  pieceId: number;
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
} | null>(null);

let placementFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

const rejectedPiece = $derived(
  placementFeedback?.kind === 'rejected' ? placementFeedback.pieceId : null
);
```

Add one clear helper and one replace/show helper using `REJECTED_DURATION_MS`.

### 3.3 Extend `handlePiecePlaced` without changing callback contract

Keep `handlePiecePlaced` void:

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
    showPlacementFeedback(pieceId, x, y, result.outcome.status);
  }

  checkpointSession();
}
```

No event-correlation state.
No callback return.
No game-core change.

### 3.4 Reduce the rejection event handler to semantics

Keep the existing `placement_rejected` live-region announcement.

Delete its visual-state/timer mutation; the dispatch call site now owns the one visual feedback state for both accepted and rejected outcomes.

### 3.5 Pass/clear the one feedback state

Pass `placementFeedback` through `PuzzleBoardPanel`.

Clear it:

- on component destroy;
- on direct puzzle navigation reset;
- on Play Again/restart when the run resets.

Do not add separate tray/board clear paths.

### 3.6 Run focused route tests

```bash
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: pass.

---

## Task 4: Protect selected-state mobile layout in the existing smoke

### Files

- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

### 4.1 Extend the existing large-inventory smoke

Do not add a spec.

In the current `large mobile inventory scrolls from a swipe starting on a piece @smoke` path:

1. capture an unselected slot size;
2. select one piece so its slot expands 2×2;
3. assert the selected slot is materially larger than the unselected baseline;
4. assert the panel still fits 390×844;
5. retain the current two-row grid-height budget assertion;
6. keep the swipe-scroll proof.

If selection changes the first slot used for the current geometry calculation, select/capture locators deliberately so the assertion compares one expanded slot with a normal one rather than assuming index 0 remains normal.

---

## Task 5: Final verification and scope review

### 5.1 Focused component + route tests

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

No new E2E lane/spec.

### 5.4 Scope review

Confirm the implementation does **not** add:

- game-core event/action/codec changes;
- a callback return contract;
- persistence fields;
- a duplicate preview surface;
- generic animation helpers/frameworks;
- new stores/controllers;
- new shared artwork abstraction;
- new image assets;
- backend/mobile production work;
- unrelated refactors.

## Implementation checklist

- [ ] 1. Expand selected tray slot 2×2 + visible filter badges + truthful empty-state recovery
- [ ] 2. Add touch-visible candidate CSS + explicitly stacked prop-driven board feedback
- [ ] 3. Collapse tray rejection and board feedback to one 500 ms route state/timer
- [ ] 4. Extend existing mobile smoke with selected-slot magnification/layout proof
- [ ] 5. Run focused tests, `bun run check`, and gameplay smoke

## Risks

- **Selected-grid reflow:** pin 2×2 geometry plus existing roving-focus/selection behavior.
- **Touch candidate visibility:** baseline state is visible without hover; hover/focus only strengthens it.
- **False empty-state copy:** distinguish zero total matches from zero remaining.
- **Header density:** count badges overlay fixed controls and cannot grow/wrap the row.
- **Feedback desync:** one state/timer drives both tray rejection and board feedback.
- **Overlay stacking:** placement/hint z-levels are explicit and above all placed artwork.
- **Duplicate accessibility output:** no new live region or duplicate selected-piece node.
- **Stale feedback:** one replaceable 500 ms timer, cleared on navigation/restart/teardown.

## Planning verification

- Planning branch remains documentation-only.
- Current web callbacks remain void.
- `attempt_placement` is dispatched from the route placement path, which already has piece ID + coordinates and receives the authoritative result.
- Existing rejection visual state and proposed board feedback share the same 500 ms lifetime and can be unified.
- Existing selected tray pieces already use the exact artwork/rotation path needed for magnification; no third framing copy is necessary.
- Current mobile filter buttons are fixed 2.75rem controls; overlay badges can add visible counts without changing row geometry.
- Current mobile gameplay smoke already owns fold-fit/two-row tray density and will be extended rather than duplicated.
- No generated art task is required.
