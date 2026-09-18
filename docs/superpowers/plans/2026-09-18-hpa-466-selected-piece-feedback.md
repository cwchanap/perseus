# HPA-466 Selected-Piece Inspection and Placement Feedback — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Improve selected-piece inspection and placement feedback in the existing web puzzle flow without changing gameplay authority, persistence, or backend contracts.

**Architecture:** Keep `PuzzleSession` as the only gameplay state owner. `PuzzleInventoryPanel` derives preview/count presentation from existing controlled props. `PuzzleBoard` owns only short-lived cell feedback and consumes the authoritative `PlacementOutcome` returned by the existing route callback. Candidate cells are CSS-derived from selection + empty-cell hover/focus.

**Tech stack:** Svelte 5, TypeScript, `@perseus/game-core`, Vitest browser tests, existing Playwright gameplay smoke.

## Global constraints

- No new gameplay store/controller/read-model framework.
- No game-core action, event, codec, or persistence changes.
- No backend/API/workflow changes.
- No new generated image assets.
- No NativeScript parity in this ticket.
- Keep current hint, shuffle, filter persistence, selection, rotation, undo/redo, completion, and accessibility announcement semantics.
- Correctness stays exclusively in `PuzzleSession`.
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

**Do not modify by default**

- `packages/game-core/**`
- `apps/web/src/lib/components/PuzzlePiece.svelte`
- persistence/codec modules;
- E2E support/spec files;
- backend/mobile code.

---

## Task 1: Add selected-piece preview and useful filter status

### Files

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

### 1.1 Pin current behavior with focused failing tests

Extend the existing inventory component suite with tests for:

- selected piece shows a dedicated preview;
- preview image uses the selected piece;
- preview rotation follows `pieceRotations`;
- cancel/selection-clear removes the preview;
- peek hides the preview because the existing body is hidden;
- All / Corners / Edges / Center counts use **unplaced** pieces only;
- counts update when `placedPieces` changes;
- an exhausted non-All filter shows a filter-specific completed message;
- `SHOW ALL REMAINING` invokes `onFilterChange('all')`;
- the component does not automatically change the active filter.

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected before implementation: new assertions fail.

### 1.2 Derive the selected piece locally

Reuse the existing `piecesById` map:

```ts
const selectedPiece = $derived(
  selectedPieceId === null ? null : (piecesById.get(selectedPieceId) ?? null)
);
```

Do not introduce another selected-piece state variable.

### 1.3 Render one read-only preview in the existing body

Add a compact preview before `.pieces-grid`:

- only when `selectedPiece !== null`;
- image source from `resolveImage(selectedPiece)`;
- rotation from `displayedRotation(selectedPiece.id)`;
- no nested Rotate/Cancel buttons;
- no drag or selection semantics;
- supplementary/duplicate artwork should not create noisy accessibility output.

Keep Rotate and Cancel in the existing header actions.

Do not modify `PuzzlePiece.svelte` just to add a preview mode.

### 1.4 Add fixed-filter remaining counts

Use the existing `unplacedPieces` plus `matchesInventoryFilter`.

Keep the implementation local. A small helper such as:

```ts
function remainingCount(filter: InventoryFilter): number {
  return unplacedPieces.filter((piece) =>
    matchesInventoryFilter(piece, puzzle, filter)
  ).length;
}
```

is sufficient.

Expose counts in the four existing filter controls. Ensure accessible labels communicate both filter name and remaining count.

Do not persist counts or add another read model.

### 1.5 Replace the dead-end empty state

When `activeFilter !== 'all'`, `unplacedPieces.length > 0`, and `visiblePieces.length === 0`:

- show `ALL CORNERS PLACED`, `ALL EDGES PLACED`, or `ALL CENTER PIECES PLACED`;
- show one `SHOW ALL REMAINING` button;
- call `onFilterChange('all')` only when the player activates it.

Keep the all-pieces-placed state unchanged.

### 1.6 Keep responsive behavior unchanged

The preview lives inside the existing body:

- desktop: visible with the tray;
- half/full mobile sheet: visible;
- peek: hidden automatically with the rest of the body.

Do not add a second preview surface or new breakpoint logic.

### 1.7 Re-run focused inventory tests

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: pass.

---

## Task 2: Add neutral candidate styling and authoritative placement feedback

### Files

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`

### 2.1 Add failing board tests first

Extend `PuzzleBoard.svelte.test.ts` to prove:

- candidate-enabled state exists only while `selectedPieceId !== null`;
- occupied cells are not candidate cells;
- focus-visible/hover candidate presentation is correctness-neutral;
- an accepted callback result marks the attempted cell accepted;
- a rejected callback result marks the attempted cell rejected;
- a noop result creates no accepted/rejected feedback;
- a later attempt replaces earlier feedback;
- existing click, keyboard, and drag/drop paths still forward every attempt without local correctness checks.

Use fake timers for the short feedback lifetime rather than sleeping in tests.

### 2.2 Make candidate styling state-free

Mark the board root when a piece is selected, for example:

```svelte
data-candidate-enabled={selectedPieceId !== null ? 'true' : undefined}
```

Use CSS selectors to style empty cells on hover/focus only when that marker is present.

Do not store a "candidate cell" in Svelte state.

Keep existing drag-over state separate.

### 2.3 Return `PlacementOutcome` through the existing callback

Import the existing `PlacementOutcome` type where needed.

Change the callback contract through `PuzzleBoardPanel` / `PuzzleBoard`:

```ts
onPiecePlaced: (
  pieceId: number,
  x: number,
  y: number
) => PlacementOutcome | void;
```

In `+page.svelte`:

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

Important:

- do not infer correctness in the board;
- do not add coordinates to session events;
- keep current placement event announcements untouched.

### 2.4 Keep short-lived feedback inside `PuzzleBoard`

Add one component-local value:

```ts
type PlacementFeedback = {
  x: number;
  y: number;
  kind: 'accepted' | 'rejected';
};
```

When an interaction path invokes `onPiecePlaced`:

1. receive the authoritative result;
2. accepted -> set accepted feedback for that cell;
3. rejected -> set rejected feedback for that cell;
4. noop/void -> no feedback;
5. clear/restart one short timeout.

All three interaction paths should use the same small helper rather than duplicating result handling.

Clear the timeout on component teardown.

### 2.5 Add restrained styles

Accepted:

- subtle settle/pulse;
- positive outline/background;
- do not cover the placed artwork.

Rejected:

- distinct attempted-cell emphasis;
- no pre-attempt correctness signal.

Candidate:

- neutral outline;
- include `:focus-visible`;
- do not rely solely on hue.

Reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  /* disable movement/pulse animation, keep static feedback styling */
}
```

The class/state should remain visible for the normal short interval even when animation is disabled.

### 2.6 Re-run focused board tests

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: pass.

---

## Task 3: Pin route integration and canonical selection behavior

### Files

- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Production code from Tasks 1-2 only unless a test exposes a real missing seam.

### 3.1 Add route-level regression tests

Add focused tests proving:

1. accepted placement still checkpoints and returns the session placement result to the board path;
2. accepted placement clears canonical selection, which removes the inventory preview;
3. rejected placement keeps canonical selection;
4. rejected placement still drives the existing tray-piece rejection state;
5. accepted/rejected live-region announcements remain unchanged;
6. rotation updates the selected preview through canonical `pieceRotations`;
7. placing pieces updates filter counts because counts derive from `placedPieces`.

Do not test CSS animation timing again at route level; keep that in the board component suite.

### 3.2 Run focused route tests

```bash
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: pass.

---

## Task 4: Final verification and cleanup

### 4.1 Run the focused component + route set together

From `apps/web`:

```bash
bunx vitest --run --browser   src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts   src/lib/components/__tests__/PuzzleBoard.svelte.test.ts   'src/routes/puzzle/[id]/page.svelte.test.ts'
```

### 4.2 Type/Svelte check

```bash
bun run check
```

Expected: 0 Svelte/TypeScript errors.

### 4.3 Existing gameplay smoke

No new E2E spec is required by default. Run the current smoke suite as the behavioral regression gate:

```bash
bun run test:e2e:smoke
```

If a focused smoke failure reveals that the new feedback changed interaction timing or selectors, fix the production behavior or existing selector; do not create a parallel interaction path.

### 4.4 Scope review before marking ready

Confirm the diff contains only the planned presentation/wiring/test files and documentation.

Explicitly reject any accidental additions of:

- game-core event/schema changes;
- persistence fields;
- generic animation helpers/frameworks;
- new stores/controllers;
- new image assets;
- backend/mobile work;
- unrelated refactors.

## Implementation checklist

- [ ] 1. Add selected-piece preview + remaining counts + exhausted-filter recovery
- [ ] 2. Add neutral candidate styling + authoritative accepted/rejected cell feedback
- [ ] 3. Pin route integration and canonical selection/rotation/count behavior
- [ ] 4. Run focused tests, `bun run check`, and existing gameplay smoke

## Planning verification

- Planning branch is documentation-only.
- Current main already exposes all required state through existing component props.
- `PuzzleSession.dispatch(attempt_placement)` already returns the authoritative `PlacementOutcome`; no game-core change is needed.
- Placement accepted/rejected events already own live announcements; visual feedback does not need another semantic channel.
- Existing inventory and board component suites provide the right focused test homes.
- No generated art task is required for HPA-466.
