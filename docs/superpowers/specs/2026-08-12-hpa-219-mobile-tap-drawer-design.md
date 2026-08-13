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

The route also already owns the responsive board/inventory layout. `puzzleLayout.ts` sizes small and medium boards with fixed vertical headroom, and `+page.svelte` renders board + inventory in one `.game-layout` grid. HPA-219 therefore keeps the tray **in flow** instead of adding a fixed overlay or a second height budget.

A final density constraint matters on phones: `boardMetrics.pieceSlotSize` equals the board cell size. On the 390 × 844 `e2e-square-4` fixture the board is 320px wide, so the inherited slot size is 160px. After route/panel/grid padding, two 160px slots plus the existing gap do not fit in one row; the mobile tray would show roughly one piece per row. HPA-219 therefore decouples **mobile tray preview size** from board cell size while leaving desktop inventory sizing unchanged.

## Goals

1. Make phone-sized puzzle play practical with select-then-tap placement.
2. Reuse `PuzzleSession` selection and placement actions exactly as the source of truth.
3. Keep selection after rejection and clear it after acceptance through existing session behavior.
4. Provide one visible Cancel action for pointer/touch users.
5. Make the existing inventory a binary open/collapsed bottom row on mobile without creating an overlay layout.
6. Show a useful number of tray pieces at once on a 390px phone rather than inheriting large board-cell sizing.
7. Keep the board and tray mounted together in the existing page grid.
8. Allow a real one-finger swipe beginning on a piece to scroll a large mobile inventory.
9. Preserve desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar/wheel zoom, rotation, completion, and session controls.
10. Delete obsolete touch-drag complexity instead of adding gesture arbitration.

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

### Option A — Tap-to-place + in-flow binary tray + mobile preview sizing (recommended)

Use native click/tap to select a piece and native click/tap on a board cell to attempt placement. Keep the tray as the second row of the existing route grid below 1024px. `PuzzleInventoryPanel` owns open/collapsed presentation, its scroll body, and a mobile-only preview-size override.

**Pros**

- reuses the existing `PuzzleSession` and route layout;
- removes the bespoke touch implementation;
- no overlay hit-testing or z-index coordination;
- keeps board and tray in one responsive layout budget;
- shows multiple pieces per row on phone-sized screens;
- preserves desktop mouse drag and keyboard independently;
- requires only one new state value: `drawerOpen`.

**Cons**

- direct touch drag is removed, which is acceptable because it is explicitly optional;
- mobile tray previews no longer equal board cell size, which is desirable for browse density and remains presentation-only.

### Option B — Fixed bottom overlay

Make `PuzzleInventoryPanel` `position: fixed` below 1024px.

**Rejected:** the route already budgets and renders a stacked board + tray. A fixed overlay would create a second, uncoordinated layout system and could cover bottom board cells. It also introduces unnecessary z-index/modal interactions.

### Option C — Keep touch drag with gesture thresholds

Distinguish tap, scroll, and drag using movement/time thresholds.

**Rejected:** this adds gesture classification and cancellation rules that the ticket explicitly avoids.

### Option D — Separate mobile piece/inventory component

Build a second mobile interaction surface.

**Rejected:** duplicates markup and creates another synchronization boundary around canonical selection state.

## Decision

Use **Option A**.

`PuzzleSession` remains the only gameplay state owner. `PuzzlePiece` becomes a simpler native click/tap + keyboard + desktop HTML5 drag input surface. `PuzzleBoard` adds native click/tap placement to its existing keyboard/drop placement path. `PuzzleBoardPanel` suppresses/cancels pan while selection is active. `PuzzleInventoryPanel` owns one local `drawerOpen` boolean plus mobile-only tray sizing. The route remains the responsive board/inventory layout owner and keeps the mobile tray in flow.

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

Removing the custom touch handlers is necessary but not sufficient proof that one-finger tray scrolling works because the piece still carries `draggable={!isPlaced}` for desktop HTML5 drag.

Keep the attribute for desktop/fine-pointer behavior, but extend the existing global `@media (pointer: coarse)` `.puzzle-piece` rule in `apps/web/src/routes/layout.css` with:

```css
-webkit-user-drag: none;
```

This is a CSS-only coarse-pointer guard: no media-query state or input manager is added. Do not add a computed-style assertion for it. The behavior proof is a real browser-level touch swipe on a large deterministic tray whose `scrollTop` must increase.

### Board activation

Each board cell supports one additional native activation:

- no selected piece -> click/tap is a no-op;
- selected piece -> click/tap calls the same local `placePiece()` helper used by keyboard/drop handling;
- the board does not pre-check correctness, occupancy, or rotation.

Use a local non-delegated action for click + keydown. Do **not** pass `{x, y}` as an action parameter; each drop-zone already has `data-x` and `data-y`. The native click/keydown action reads those attributes from its node.

Existing HTML5 `dragover`/`drop` handlers may continue using their existing closure coordinates. The design claim is intentionally narrow: **native click/keydown has no second coordinate channel**; it does not rewrite working desktop drag/drop solely for uniformity.

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

This deliberately makes placement mode win over pan. On a zoomed board, reaching an off-screen cell may require **Cancel -> pan -> reselect -> place**. That is an accepted HPA-219 tradeoff: adding simultaneous pan + selected-piece gesture arbitration would reintroduce the complexity this ticket is deleting, and the rule is one local `$derived` away from revision if real use later proves the tradeoff poor.

Wheel and toolbar zoom remain available; no pinch zoom is added.

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

### Mobile tray preview size

Below 1024px, inventory preview size must not inherit the board-cell size. Scope the override only to the mobile breakpoint:

```css
@media (max-width: 1023px) {
	.inventory-panel {
		--piece-slot-size: clamp(3rem, 16vw, 4.5rem);
	}
}
```

At 390px, `16vw` is 62.4px. With the current inventory gap/padding, four slots fit comfortably in the usable grid width; five need not. The exact acceptance proof is not this arithmetic—it is the rendered E2E requirement that at least four slot boxes are fully inside the open grid's visible client rectangle on `e2e-square-4`.

Do not set `--piece-slot-size: initial` at the desktop breakpoint. The custom property is already supplied by the parent `.game-layout`; scoping the override to `max-width: 1023px` lets desktop inherit the existing board-derived value naturally.

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

The open mobile panel starts with a `16rem` maximum height (including safe-area padding via border-box sizing):

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

The `16rem` value is a candidate cap, **not a proof that the complete page fits**. `getHeightReserve()` only constrains board sizing; it does not formally allocate the tray row. The authoritative target-viewport proof is rendered geometry: on 390 × 844, the open inventory panel bottom must be at or above the viewport bottom. If that fails, tighten the local tray/layout sizing in HPA-219 rather than weakening the assertion.

No overlay padding compensation is needed because the tray consumes its own grid row.

### Desktop layout

At `min-width: 1024px`:

- keep the route's existing two-column grid unchanged;
- clear the mobile inventory max-height/safe-area padding;
- inventory body is always visible regardless of the last mobile `drawerOpen` value;
- hide the OPEN/COLLAPSE toggle;
- keep Cancel visible while selected;
- keep inheriting the route's board-derived `--piece-slot-size`.

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
- use one local native action that reads `data-x` / `data-y` for click/keydown;
- retain existing drag/drop closure coordinates;
- no correctness filtering.

### `PuzzleBoardPanel.svelte`

- gate pan on `selectedPieceId === null`;
- cancel an active pan when selection begins;
- preserve existing zoom/reset/reclamp/capture/blur behavior.

### `PuzzleInventoryPanel.svelte`

- add local `drawerOpen`;
- add Cancel + mobile open/collapse controls;
- own mobile tray preview sizing, height-capped scroll body, and safe-area padding;
- remain in normal document/grid flow.

### `+page.svelte`

The route has one intentional presentation change: below 1024px, `.game-layout` explicitly owns board row + inventory row. Desktop columns remain unchanged. No gameplay/session orchestration changes are allowed.

### `layout.css`

Extend the existing coarse-pointer `.puzzle-piece` rule with `-webkit-user-drag: none` so supported touch behavior is scroll + tap rather than native drag.

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
- keeps the piece in the tray;
- keeps `data-selected="true"` on the selected piece;
- allows immediate retry on another cell.

The transient `.rejected` shake class is **not** an E2E contract. The route clears that presentation after 500ms, so mobile E2E uses durable selection/tray state instead of racing the animation timer.

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

It follows the existing `selectAndPlaceWithKeyboard` shape: activate the piece, prove selection, activate the target, and wait for an accepted piece's tray slot to detach. Tests that use the helper pair it with `expectPiecePlaced(pieceId, x, y)` when verifying the final board location.

### Cross-browser smoke

Native tap is now a supported interaction method. Per `e2e/README.md`, it must be verified on Chromium and then kept in reliable WebKit-critical coverage.

The one-piece tap smoke is tagged both `@smoke` and `@webkit-critical`, and runs only on:

- `chromium-mobile`;
- `webkit-mobile`.

The broader HPA-219 390 × 844 flow remains Chromium-mobile; WebKit does not need the whole completion flow duplicated.

### Layout proof owned by the layout task

Task 3 adds the geometry/scroll tests in the same commit as the in-flow drawer so layout does not ship one commit before its risk is exercised.

At 390 × 844 with `e2e-square-4`:

- open inventory panel bottom is `<= viewport height`;
- at least four unplaced slot boxes are fully inside the visible `.pieces-grid` client rectangle;
- board remains visible.

A separate layout-only check uses the existing `e2e-square-100` fixture at the same Chromium-mobile viewport. It performs one browser-level touch swipe beginning on a puzzle piece and requires `.pieces-grid.scrollTop` to increase. The 100-piece fixture is used because the corrected 4-piece tray should fit without scrolling; manufacturing overflow in the completion fixture would contradict the density goal.

Do not assert computed `overflow-y` or computed `-webkit-user-drag`. The swipe result is the behavior proof.

### Mobile completion flow

At 390 × 844 using `e2e-square-4`:

1. load a fresh start-immediately run;
2. drawer starts open and board is visible;
3. tap a piece and wrong cell; prove the tray slot remains and the piece remains selected;
4. tap the correct cell; prove selection clears, slot detaches, and the placed image is in the correct target;
5. collapse the in-flow drawer; board stays mounted/visible and Cancel/toggle header remains available;
6. reopen;
7. complete remaining pieces via `placeWithTap`, pairing every placement with `expectPiecePlaced`;
8. existing completion dialog appears;
9. document has no horizontal overflow;
10. normal automatic fixture diagnostics pass.

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

Coarse-pointer scrolling is proven by the large-fixture E2E swipe rather than by a media-query/computed-style assertion.

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

Responsive density, viewport fit, and real scrolling are E2E-owned and land with the layout task.

## Risks and mitigations

### Mobile tray degenerates to one-piece rows

**Mitigation:** mobile-only `--piece-slot-size: clamp(3rem, 16vw, 4.5rem)` plus rendered square-4 density assertion requiring at least four fully visible slots.

### Open tray extends below the phone viewport

**Mitigation:** keep tray in flow, cap it locally, and require `panelBottom <= viewportHeight` in Task 3's Chromium-mobile layout test. Treat that rendered check—not `getHeightReserve()` arithmetic—as authoritative.

### Inventory swipe is stolen by drag behavior

**Mitigation:** delete bespoke touch drag, add coarse-pointer `-webkit-user-drag: none`, then prove a browser-level swipe starting on a piece increases scrollTop on the 100-piece fixture.

### Tap starts board pan

**Mitigation:** `canPanBoard` requires `selectedPieceId === null`; selection also cancels active pan. The Cancel -> pan -> reselect tradeoff on zoomed boards is explicitly accepted for this ticket.

### Rejected tap is flaky in E2E

**Mitigation:** assert durable facts—slot still present and piece still selected—instead of the 500ms `.rejected` class.

### Tap helper masks wrong-cell rendering

**Mitigation:** placement flows call `expectPiecePlaced(pieceId, x, y)` after accepted `placeWithTap()` calls.

### Desktop regression

**Mitigation:** desktop breakpoint keeps the current side-panel sizing and layout; existing HTML5 drag, keyboard, zoom/pan, rotation, and completion tests remain.

## KISS / YAGNI guardrails

- `PuzzleSession` remains the only canonical gameplay state owner.
- `drawerOpen` is the only new runtime state.
- No route state for drawer or mobile placement.
- No gesture classifier, bottom-sheet primitive, input manager, or event bus.
- Remove obsolete touch drag instead of supporting two competing touch modes.
- Reuse the existing route grid and 1024px breakpoint.
- Reuse deterministic E2E fixtures; square-4 covers the completion flow and square-100 covers scroll behavior only.
- No `puzzleLayout.ts` change is required.
- No backward-compatibility path or feature flag is needed for this pre-release project.

## Acceptance-criteria mapping

| HPA-219 criterion | Design coverage |
| --- | --- |
| Phone player selects/places without distant dragging | native piece tap + board-cell tap |
| Success clears selection once | existing accepted-placement session contract + mobile E2E |
| Rejection keeps selection | existing rejection contract + durable selected/tray assertions |
| Inventory opens/collapses | one private `drawerOpen` boolean |
| Inventory shows useful phone density | mobile-only slot-size override + >= 4 visible square-4 slots |
| Inventory scrolls normally | touch drag removed + coarse user-drag suppression + real 100-piece swipe |
| Bottom safe area respected | component-owned safe-area padding |
| Board/tray fit target viewport | in-flow grid + Task 3 panel-bottom geometry assertion |
| Board session preserved | same component instances/domain state; presentation-only collapse |
| Desktop drag/keyboard/zoom/completion preserved | existing paths retained and regression-tested |
| No global state/gesture framework | local actions/state and existing grid only |
| Focused component + Chromium mobile E2E | four focused suites + layout checks + square-4 feature flow |
| Supported tap path retained in WebKit | `@webkit-critical` one-piece tap smoke |

## Expected implementation scope

Production/layout files:

- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — CSS/layout only
- `apps/web/src/routes/layout.css` — coarse-pointer rule only

Test/support/docs files:

- `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/e2e/support/gameplay-page.ts`
- `apps/web/e2e/gameplay-interactions.spec.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- `apps/web/e2e/README.md`
- `apps/web/playwright.config.ts` — comment only

Explicitly unchanged:

- `apps/web/src/lib/services/puzzleLayout.ts`
- `apps/web/src/lib/services/gameplay/session/**`
- persistence/statistics/API/shared-domain packages
- deterministic fixture catalog/builders

The implementation deletes more interaction machinery than it adds and introduces exactly one new runtime state value.