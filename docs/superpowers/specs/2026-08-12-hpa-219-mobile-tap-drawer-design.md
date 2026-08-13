# HPA-219: Mobile Tap-to-Place and In-Flow Inventory Drawer — Design

**Linear:** HPA-219  
**Status:** Design for implementation  
**Date:** 2026-08-12

## Context

HPA-219 is the next actionable child of HPA-215 after HPA-224. HPA-557 is complete and already split the puzzle route into concrete board, inventory, and completion components, so this ticket can stay inside the existing gameplay boundaries.

The current domain already owns the behavior needed for select-then-place:

- `PuzzleSessionState.selectedPieceId` is the canonical selection;
- `select_piece` and `cancel_selection` own selection changes;
- `attempt_placement` is the only accept/reject authority;
- accepted placement clears the selected piece when that piece is placed;
- rejected placement increments the canonical incorrect-attempt counter and keeps selection;
- `PuzzleBoard` already routes keyboard/drop attempts through `onPiecePlaced(pieceId, x, y)` without UI-side correctness checks;
- `PuzzleBoardPanel` already owns ephemeral zoom/pan state;
- `PuzzleInventoryPanel` already owns inventory markup and receives selection/cancel callbacks.

The current touch path is the mismatch. `PuzzlePiece.svelte` installs window-level touch listeners, prevents default touch movement, translates the piece, synthesizes drag/drop events, and exposes `onDragStart` / `onDragMove` / `onDragEnd` callbacks that have no production consumer. That machinery conflicts with the ticket's required one-finger inventory scrolling and is unnecessary once tap-to-place is the supported touch path.

A second layout mismatch was found during review. The route already sizes small/medium boards with 300px/280px of vertical reserve and renders board + inventory in one `.game-layout` grid. Making the inventory `position: fixed` would create an independent overlay budget on top of that existing reserve and could cover board cells. HPA-219 therefore keeps the tray **in flow** and makes the existing route grid the responsive layout owner.

## Goals

1. Make phone-sized puzzle play practical with select-then-tap placement.
2. Reuse `PuzzleSession` selection and placement actions exactly as the source of truth.
3. Keep selection after rejection and clear it after acceptance through existing session behavior.
4. Provide one visible Cancel action for pointer/touch users.
5. Make the existing inventory a binary open/collapsed bottom row on mobile without creating an overlay layout.
6. Keep the board and tray mounted together in the existing page grid.
7. Allow a real one-finger swipe starting on a piece to scroll the mobile inventory.
8. Preserve desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar/wheel zoom, rotation, completion, and session controls.
9. Delete obsolete touch-drag complexity instead of adding gesture arbitration.

## Non-goals

- pinch zoom;
- two-finger pan;
- direct touch drag;
- long-press or distance-threshold gesture classification;
- intermediate drawer snap points;
- a generalized bottom-sheet component;
- a global pointer/gesture ownership framework;
- haptics;
- persistence of drawer-open state;
- new `PuzzleSession` actions/state;
- analytics or performance instrumentation;
- inventory filters/staging trays (HPA-220/HPA-237);
- broader accessibility navigation work (HPA-223);
- physical-device certification.

Direct touch drag is intentionally removed. HPA-219 makes tap-to-place the supported touch placement path.

## Options considered

### Option A — Tap-to-place + in-flow binary tray (recommended)

Use native click/tap to select a piece and native click/tap on a board cell to attempt placement. Keep the tray as the second row of the existing route grid below 1024px; `PuzzleInventoryPanel` owns only open/collapsed presentation and its scroll body.

**Pros**

- reuses the existing `PuzzleSession` and route layout;
- removes the bespoke touch implementation;
- no overlay hit-testing or z-index coordination;
- keeps the board and tray as one responsive layout budget;
- preserves desktop mouse drag and keyboard independently;
- requires only one new state value: `drawerOpen`.

**Cons**

- direct touch drag is removed, which is acceptable because it is explicitly optional.

### Option B — Fixed bottom overlay

Make `PuzzleInventoryPanel` `position: fixed` below 1024px.

**Rejected:** the route and `puzzleLayout.ts` already reserve vertical space for a stacked tray. A fixed overlay would create a second, uncoordinated layout system and could cover the bottom board cells. It also introduces unnecessary z-index/modal interactions.

### Option C — Keep touch drag with gesture thresholds

Distinguish tap, scroll, and drag using movement/time thresholds.

**Rejected:** this adds gesture classification and cancellation rules that the ticket explicitly avoids.

### Option D — Separate mobile piece/inventory component

Build a second mobile interaction surface.

**Rejected:** duplicates markup and creates another synchronization boundary around canonical selection state.

## Decision

Use **Option A**.

`PuzzleSession` remains the only gameplay state owner. `PuzzlePiece` becomes a simpler native click/tap + keyboard + desktop HTML5 drag input surface. `PuzzleBoard` adds native click/tap placement to its existing keyboard/drop placement path. `PuzzleBoardPanel` suppresses/cancels pan while selection is active. `PuzzleInventoryPanel` owns one local `drawerOpen` boolean. The route remains the responsive board/inventory layout owner and keeps the mobile tray in flow.

No route controller, gesture service, bottom-sheet primitive, drawer store, or domain type is introduced.

## Interaction contract

### Piece activation

For an unplaced inventory piece:

- native click/tap calls `onSelect(piece.id)` exactly once;
- tapping another piece replaces the canonical selection through `select_piece`;
- tapping the already-selected piece keeps it selected; pointer/touch deselection uses the visible Cancel action;
- keyboard Enter/Space keeps its existing toggle behavior, including deselecting the selected piece;
- rotation controls stop propagation so rotation does not also select;
- desktop/fine-pointer HTML5 drag remains supported.

Use one local non-delegated Svelte action for click + keydown. The component already uses a non-delegated keydown action because a state-changing delegated event can re-enter after a synchronous rerender; extending that local pattern keeps one native event -> one session action.

### Coarse-pointer drag suppression

Removing the custom touch handlers is not enough proof that one-finger tray scrolling works. The piece still carries `draggable={!isPlaced}` for desktop HTML5 drag.

Keep that attribute for desktop/fine-pointer behavior, but extend the existing global `@media (pointer: coarse)` `.puzzle-piece` rule in `apps/web/src/routes/layout.css` with:

```css
-webkit-user-drag: none;
```

This is a CSS-only coarse-pointer guard: no media-query state or input manager is added. The mobile E2E must additionally perform a browser-level touch swipe beginning on a piece and observe inventory `scrollTop` increasing. Computed `overflow-y` alone is not acceptance proof.

### Board activation

Each board cell supports one additional native activation:

- no selected piece -> click/tap is a no-op;
- selected piece -> click/tap calls the same local `placePiece()` helper used by keyboard/drop handling;
- the board does not pre-check correctness, occupancy, or rotation.

Use a local non-delegated action for click + keydown. Do **not** pass `{x, y}` as an action parameter; each drop-zone already has `data-x` and `data-y`. The action reads those attributes from its node and forwards them to the existing handlers. This avoids another coordinate channel and avoids action-parameter identity churn.

### Selection lifecycle

Do not add UI-local selection bookkeeping.

1. `select_piece` stores the selected id.
2. rejected `attempt_placement` keeps the selection.
3. accepted `attempt_placement` clears the selected id when that piece is accepted.
4. Cancel dispatches `cancel_selection`.
5. selecting another piece replaces the selected id.

### Pan ownership while selected

`PuzzleBoardPanel` remains the zoom/pan owner.

```ts
const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
```

Extend the existing pan-cancel effect:

```ts
$effect(() => {
	if (interactionBlocked || selectedPieceId !== null) cancelPan();
});
```

Consequences:

- selected-piece board taps do not start pan;
- selection beginning during an active pan cancels it;
- accepted placement or Cancel automatically restores pan eligibility when zoom permits;
- wheel and toolbar zoom stay available;
- no pinch zoom is added.

## Mobile inventory drawer

### State ownership

`PuzzleInventoryPanel` owns exactly one new state value:

```ts
let drawerOpen = $state(true);
```

It is presentation-only: not serialized, not lifted to the route, and not generalized.

### Header controls

Keep `INVENTORY` and the remaining-piece count. Add a compact action group:

- `CANCEL` appears whenever `selectedPieceId !== null` and calls `onCancelSelection`;
- `OPEN` / `COLLAPSE` controls `drawerOpen` below 1024px;
- toggle exposes `aria-expanded` and `aria-controls="puzzle-inventory-body"`;
- Cancel remains available when the drawer is collapsed.

### Mobile layout ownership

Below 1024px the tray stays **in the existing `.game-layout` flow**.

Route-owned layout:

```css
.puzzle-main {
	min-height: 0;
}

.game-layout {
	grid-template-columns: 1fr;
	grid-template-rows: minmax(0, 1fr) auto;
	min-height: 0;
}
```

`PuzzleInventoryPanel` does **not** use `position: fixed`, `sticky`, or absolute positioning and does not set a gameplay z-index.

The open mobile panel is height-capped at `16rem` (including its safe-area padding via border-box sizing). With the existing 1.25rem grid gap, that stays within the small/medium board calculator's 300px/280px vertical reserve rather than adding a second budget.

The component owns:

```css
.inventory-panel {
	box-sizing: border-box;
	max-height: 16rem;
	padding-bottom: env(safe-area-inset-bottom);
	overflow: hidden;
}

.inventory-body {
	min-height: 0;
	display: flex;
	flex: 1;
	flex-direction: column;
	overflow: hidden;
}

.inventory-panel:not(.drawer-open) .inventory-body {
	display: none;
}

.pieces-grid {
	min-height: 0;
	overflow-y: auto;
	overflow-x: clip;
	flex: 1;
}
```

No overlay padding compensation is needed because the tray consumes its own grid row.

### Desktop layout

At `min-width: 1024px`:

- keep the route's existing two-column grid unchanged;
- clear the mobile inventory max-height/safe-area padding;
- inventory body is always visible regardless of the last mobile `drawerOpen` value;
- hide the OPEN/COLLAPSE toggle;
- keep Cancel visible while selected.

## Component boundaries

### `PuzzlePiece.svelte`

- delete touch listener/synthetic-drop/translation state;
- delete unused `onDragStart`, `onDragMove`, `onDragEnd` props;
- extend the local native action to click + keydown;
- keep internal desktop drag payload handling;
- keep controlled selected styling and rotation behavior.

### `PuzzleBoard.svelte`

- route native click/tap through `placePiece()` when selected;
- preserve keyboard and desktop drop paths;
- use one local action that reads `data-x` / `data-y` from the drop-zone node;
- no correctness filtering.

### `PuzzleBoardPanel.svelte`

- gate pan on `selectedPieceId === null`;
- cancel an active pan when selection begins;
- preserve existing zoom/reset/reclamp/capture/blur behavior.

### `PuzzleInventoryPanel.svelte`

- add local `drawerOpen`;
- add Cancel + mobile open/collapse controls;
- own the height-capped scroll body and safe-area padding;
- remain in normal document/grid flow.

### `+page.svelte`

The route now has one intentional presentation change: below 1024px, `.game-layout` explicitly owns board row + inventory row. Desktop columns remain unchanged. No gameplay/session orchestration changes are allowed.

### `layout.css`

Extend the existing coarse-pointer `.puzzle-piece` rule with `-webkit-user-drag: none` so the supported touch path is scrolling + tap, not browser-native drag.

## Data flow

```text
PuzzlePiece click/tap
    -> PuzzleInventoryPanel.onSelect(pieceId)
    -> route handleSelectPiece(pieceId)
    -> PuzzleSession select_piece
    -> PuzzleSessionState.selectedPieceId

PuzzleBoard drop-zone click/tap
    -> native action reads data-x/data-y
    -> PuzzleBoard.placePiece(selectedPieceId, x, y)
    -> route onPiecePlaced
    -> PuzzleSession attempt_placement
        -> rejected: selection retained
        -> accepted: selection cleared
```

There is no touch-specific placement state.

## Rejection and completion behavior

Rejected tap:

- reaches `PuzzleSession` once;
- increments `incorrectAttempts` once for a counted rejection;
- uses the existing rejected-piece presentation;
- keeps selection;
- allows immediate retry on another cell.

Accepted tap:

- adds the canonical placement;
- clears selection through session logic;
- removes the placed piece from inventory through existing derived rendering;
- preserves completion sealing/effects.

No mobile-specific rejection/completion state is added.

## E2E contract

### GameplayPage

Remove `dragWithTouch()` completely. Retarget `tapPiece(pieceId)` to the actual nested `[data-testid="puzzle-piece"]` control, then add:

```ts
async placeWithTap(pieceId: number, x: number, y: number): Promise<void>
```

It follows the existing `selectAndPlaceWithKeyboard` shape: activate the piece, prove selection, activate the target, and wait for an accepted piece's tray slot to detach.

### Cross-browser smoke

Native tap is now a supported interaction method. Per `e2e/README.md`, it must be verified on Chromium and then kept in reliable WebKit-critical coverage.

The one-piece tap smoke is tagged both `@smoke` and `@webkit-critical`, and runs only on:

- `chromium-mobile`;
- `webkit-mobile`.

The broader HPA-219 390x844 flow remains Chromium-mobile for the required feature scenario; WebKit does not need the entire completion flow duplicated.

### Mobile feature flow

At 390x844 using `e2e-square-4`:

1. load a fresh start-immediately run;
2. drawer starts open and board is visible;
3. perform a browser-level touch swipe beginning on an inventory piece and prove `.pieces-grid.scrollTop` increases;
4. tap a piece and wrong cell; prove rejected presentation and selection retention;
5. tap the correct cell; prove selection clears and slot detaches;
6. collapse the in-flow drawer; board stays mounted/visible and Cancel/toggle header remains available;
7. reopen;
8. complete remaining pieces via `placeWithTap`;
9. existing completion dialog appears;
10. document has no horizontal overflow;
11. normal automatic fixture diagnostics pass.

The swipe proof is intentionally local to the Chromium feature test; it does not become a general gesture helper.

### Documentation

Update `apps/web/e2e/README.md` in the same E2E commit so it documents tap placement as the supported touch interaction and no longer directs future tests toward deleted `dragWithTouch()` behavior.

## Testing strategy

### `PuzzlePiece.svelte.test.ts`

Prove:

- native click calls `onSelect` exactly once;
- selected-piece click reselects, not pointer-cancels;
- placed piece does not select;
- Enter/Space behavior is unchanged;
- desktop `dragstart` payload remains;
- rotation activation does not select;
- obsolete touch-drag unit matrix is deleted.

Coarse-pointer scrolling is proven in E2E rather than pretending a component test can validate media-query/touch scrolling semantics.

### `PuzzleBoard.svelte.test.ts`

Prove:

- selected click on a wrong coordinate forwards exactly once;
- no selection -> click no-op;
- keyboard/drop remain.

### `PuzzleBoardPanel.svelte.test.ts`

Prove:

- selected piece prevents pan initiation;
- selection cancels real active pan;
- stale pointer moves do not continue pan;
- clearing selection restores pan.

### `PuzzleInventoryPanel.svelte.test.ts`

Prove:

- Cancel only appears while selected and forwards callback;
- drawer starts open and toggles binary state;
- collapsed/open state does not recreate/change tray contents;
- existing tray order/filter/hint/rejection/rotation/completion-message behavior remains.

Responsive geometry/real scrolling is E2E-owned.

## Risks and mitigations

### Board cell hidden by inventory

**Mitigation:** inventory is an in-flow grid row, not a fixed overlay. Open height is capped inside the same vertical budget used by board sizing.

### Tap starts board pan

**Mitigation:** pan requires `selectedPieceId === null` and selection cancels active pan.

### Rejected tap dispatches twice after rerender

**Mitigation:** board and piece click/keydown use local non-delegated actions; focused tests assert exactly one callback.

### Inventory swipe starts native drag instead of scroll

**Mitigation:** existing coarse-pointer CSS disables native user drag, bespoke touch prevention is removed, and mobile E2E performs a browser-level touch swipe from a piece and checks `scrollTop`.

### Drawer state leaks into gameplay

**Mitigation:** `drawerOpen` stays private to `PuzzleInventoryPanel`.

### Desktop regression

**Mitigation:** desktop route columns remain unchanged; fine-pointer HTML5 drag, keyboard, zoom/pan, rotation, and completion retain focused/smoke coverage.

## Expected implementation scope

Production:

- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte` (layout CSS only)
- `apps/web/src/routes/layout.css` (existing coarse-pointer rule only)

Tests/support/docs:

- four existing component suites for the components above;
- `apps/web/e2e/support/gameplay-page.ts`;
- `apps/web/e2e/gameplay-interactions.spec.ts`;
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`;
- `apps/web/e2e/README.md`;
- `apps/web/playwright.config.ts` (comment only).

Explicitly unchanged:

- `apps/web/src/lib/services/gameplay/session/**`;
- persistence/statistics/API/shared-domain packages;
- deterministic fixture catalog/builders;
- route script/session orchestration.

## Acceptance mapping

| HPA-219 criterion | Design coverage |
| --- | --- |
| Select/place on phone without long-distance dragging | tap piece + tap cell while board/tray share in-flow layout |
| Success clears selection once | existing session acceptance |
| Rejection keeps selection | existing session rejection |
| Inventory opens/collapses | local `drawerOpen` |
| Inventory scrolls normally | touch machinery removed + coarse user-drag suppression + browser-level swipe E2E |
| Bottom safe area respected | inventory border-box safe-area padding |
| Board session preserved | board and tray remain mounted in same route grid |
| Desktop drag/keyboard/zoom/completion preserved | existing paths retained/tested |
| No global state/gesture framework | explicit local changes only |
| Focused components + mobile E2E | four suites + Chromium 390x844 + WebKit tap smoke |
