# HPA-219: Mobile Tap-to-Place and Simple Inventory Drawer — Design

**Linear:** HPA-219  
**Status:** Design for implementation  
**Date:** 2026-08-12

## Context

HPA-219 is the next actionable child of HPA-215 after HPA-224. Its blocker, HPA-557, is complete and has already split the puzzle route into concrete board, inventory, and completion components. The current boundaries are therefore ready for a mobile interaction slice without another gameplay controller, store, or UI framework.

The current gameplay stack already contains most of the behavior HPA-219 needs:

- `PuzzleSessionState.selectedPieceId` is the canonical selected-piece state.
- `select_piece` and `cancel_selection` already own selection changes.
- `attempt_placement` already decides accepted vs. rejected placement.
- accepted placement clears `selectedPieceId` when the selected piece was placed;
- rejected placement increments the canonical incorrect-attempt counter and deliberately keeps the selection;
- `PuzzleBoard` already routes keyboard and drag/drop attempts through the same `onPiecePlaced(pieceId, x, y)` callback without pre-validating correctness;
- `PuzzleBoardPanel` already owns ephemeral zoom/pan state and pointer-driven board panning;
- `PuzzleInventoryPanel` already owns inventory markup and receives explicit selection callbacks;
- the deterministic gameplay E2E harness already provides phone-size fixtures, piece/drop-zone locators, and a basic `tapPiece()` helper.

The main mismatch is the existing custom touch-drag implementation in `PuzzlePiece.svelte`. It installs window-level touch listeners, calls `preventDefault()` from `touchstart`/`touchmove`, synthesizes drag/drop events, translates the piece during touch drag, and marks the piece `touch-none`. That path competes directly with HPA-219's required one-finger inventory scrolling and is unnecessary once tap-to-place becomes the supported touch placement path.

## Goals

1. Make phone-sized puzzle play practical with select-then-tap placement.
2. Reuse the existing `PuzzleSession` selection and placement actions exactly as the source of truth.
3. Keep selection after a rejected attempt and clear it after an accepted placement through existing session behavior.
4. Provide one visible Cancel action for clearing selection.
5. Replace the current mobile stacked inventory with a simple two-state bottom drawer while keeping part of the board visible.
6. Allow normal one-finger vertical scrolling inside the mobile inventory.
7. Preserve current desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar zoom, rotation, completion, and session behavior.
8. Remove touch-drag complexity that is no longer needed rather than layering a gesture classifier on top of it.

## Non-goals

- pinch zoom;
- two-finger pan;
- direct touch drag;
- long-press or drag-threshold gesture classification;
- intermediate drawer snap points;
- a generalized bottom-sheet component;
- a global pointer/gesture ownership framework;
- haptics;
- persistence of drawer-open state;
- new `PuzzleSession` actions or state;
- analytics, performance instrumentation, or device-lab certification;
- inventory filters, staging trays, or other HPA-220/HPA-237 work;
- broader accessibility navigation work owned by HPA-223.

Direct touch drag is intentionally removed in this ticket. HPA-219 explicitly treats it as optional, while tap-to-place and normal inventory scrolling are required.

## Options considered

### Option A — Tap-to-place as the primary touch path; remove custom touch drag (recommended)

Use native click/tap activation to select a piece, then click/tap a board cell to call the existing placement callback. Keep HTML5 drag/drop for desktop mouse users and the existing keyboard path. Delete the custom touch-drag implementation so the browser can scroll the inventory normally.

**Pros**

- smallest behavioral model: select, then place;
- reuses canonical `PuzzleSession` state instead of adding touch state;
- removes a sizeable custom touch implementation;
- naturally fixes the current conflict between `preventDefault()`/`touch-none` and inventory scrolling;
- keeps desktop mouse drag and keyboard behavior independent and intact;
- easy to cover with focused component tests and one mobile E2E.

**Cons**

- direct touch drag is no longer available, but it is explicitly optional and not worth preserving at the cost of gesture arbitration.

### Option B — Keep touch drag with movement/long-press thresholds

Distinguish tap, scroll, and drag based on distance or timing, then retain synthetic touch drop behavior.

**Rejected:** this requires a gesture classifier, thresholds, cancellation rules, and additional pointer ownership. It is exactly the kind of complexity HPA-219's guardrails exclude.

### Option C — Add a separate mobile piece/inventory component

Build a second interaction surface for mobile while leaving the existing inventory untouched.

**Rejected:** this duplicates piece/inventory markup and creates another synchronization boundary around canonical selection state for no product benefit.

## Decision

Use **Option A**.

`PuzzleSession` remains the only gameplay state owner. `PuzzlePiece` becomes a simpler input surface that supports native click/tap selection, HTML5 mouse drag, and the current keyboard behavior. `PuzzleBoard` adds native click/tap placement to its existing keyboard/drop placement path. `PuzzleBoardPanel` suppresses panning while a piece is selected so a board tap has one unambiguous meaning. `PuzzleInventoryPanel` owns one local, non-persisted `drawerOpen` boolean and its responsive presentation.

No route controller, gesture service, drawer store, or new domain type is introduced.

## Interaction contract

### Piece activation

For an unplaced inventory piece:

- a native pointer click/tap calls `onSelect(piece.id)`;
- tapping a different piece replaces the canonical selection through `select_piece`;
- tapping the already-selected piece keeps it selected; Cancel is the explicit pointer/touch deselection action;
- keyboard Enter/Space keeps its existing behavior, including the existing keyboard ability to deselect the currently selected piece;
- rotation controls continue to stop propagation so rotating a piece does not also select it;
- HTML5 `dragstart` remains available for desktop mouse drag/drop.

Use one native listener path for click/keyboard activation rather than adding another delegated toggle handler. The existing `PuzzlePiece` comment documents a Svelte 5 delegated-event re-render edge case for selection toggles; extend that local non-delegated interaction action instead of introducing a global event abstraction.

### Board activation

Every board cell gets one additional placement activation:

- when `selectedPieceId === null`, click/tap is a no-op;
- when `selectedPieceId !== null`, click/tap routes `selectedPieceId`, `x`, and `y` through the same local `placePiece()` helper already used by keyboard/drop handling;
- `PuzzleBoard` does not check whether the cell is correct, occupied, or rotation-valid before calling `onPiecePlaced`;
- the session engine remains the only accept/reject authority.

Keep keyboard Enter/Space and HTML5 drop using that same `placePiece()` function. A local per-cell native interaction action may attach click and keydown together so one DOM activation produces one session attempt even if the resulting dispatch immediately re-renders selection/rejection state. Do not extract this into a shared input framework.

### Selection lifecycle

Do not add route-local selection bookkeeping.

The existing session contract is the feature contract:

1. `select_piece` stores the selected id.
2. `attempt_placement` rejection keeps the selection.
3. `attempt_placement` acceptance clears the selection when that selected piece is accepted.
4. explicit Cancel dispatches `cancel_selection`.
5. selecting another piece replaces the selected id.

The UI should present this state; it must not reproduce these rules in component-local state.

### Pan ownership while selected

`PuzzleBoardPanel` already owns zoom and pan. Keep that ownership, but make pan availability depend on selection:

```ts
const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
```

Consequences:

- while a piece is selected, board pointerdown does not start pan and does not call `preventDefault()` through the pan path;
- a tap reaches the board-cell placement handler unambiguously;
- the `touch-none`/grab presentation attached to pannable board state is absent while selected;
- successful placement or Cancel clears selection through the session and automatically re-enables pan when zoom permits it;
- wheel zoom and toolbar zoom remain available; HPA-219 adds no pinch zoom.

If selection becomes non-null during an active pan, cancel the current pan in the same local effect style already used for `interactionBlocked`. Do not allow a stale active pan to survive into placement mode.

## Mobile inventory drawer

### State ownership

`PuzzleInventoryPanel` owns exactly one new local state value:

```ts
let drawerOpen = $state(true);
```

It is presentation-only:

- not serialized;
- not stored in `PuzzleSession`;
- not lifted to the route;
- not exposed through a generic drawer API.

A fresh component starts open for discoverability.

### Desktop presentation

At the existing desktop breakpoint (`min-width: 1024px`):

- preserve the current static inventory side panel;
- the inventory body is always visible regardless of the local mobile `drawerOpen` value;
- hide the mobile drawer toggle;
- show the selection Cancel action in the header whenever a piece is selected;
- keep the current tray order, piece sizing, rotation controls, hint/rejection styling, and scrolling behavior.

### Mobile presentation

Below 1024px, render the same component as a viewport-fixed bottom drawer:

- `position: fixed` with `inset-inline: 0` and `bottom: 0`;
- width constrained by the viewport rather than route/grid width;
- z-index above ordinary gameplay content but below modal surfaces;
- open drawer `max-height: min(42svh, 26rem)` so more than half of the viewport remains uncovered by the inventory itself;
- collapsed drawer shows only the header plus bottom safe-area space;
- open/collapsed is binary; no drag handle, snap points, swipe-to-dismiss, or animated physics;
- the header remains visible in both states;
- a visible `COLLAPSE` / `OPEN` button toggles the local state;
- the toggle exposes `aria-expanded={drawerOpen}` and `aria-controls="puzzle-inventory-body"`;
- the inventory body keeps `overflow-y: auto` and receives a stable `id="puzzle-inventory-body"`;
- the panel includes `env(safe-area-inset-bottom)` below its interactive content;
- the fixed panel uses border-box sizing and clips its own horizontal overflow so it cannot increase document `scrollWidth`.

Do not resize or remount the board when the drawer toggles. The drawer overlays the lower portion of the viewport; the board session and board component remain mounted and unchanged.

### Header controls

Keep `INVENTORY` and the existing remaining-piece count. Add a compact header action group:

- `CANCEL` appears whenever `selectedPieceId !== null` and calls the existing `onCancelSelection` callback;
- the drawer toggle appears only in the mobile layout;
- both controls are ordinary buttons with visible labels; no icon-only affordance is required.

Cancel remains available while the drawer is collapsed so a player cannot get stuck in placement mode.

## Normal mobile scrolling

Remove the custom touch-drag path from `PuzzlePiece.svelte`:

- remove window `touchmove`, `touchend`, and `touchcancel` listeners;
- remove synthetic `DataTransfer` construction and synthetic drag/drop dispatch;
- remove touch translation state and touch-drag z-index/pointer-event classes;
- remove `ontouchstart` and `touch-none` from the inventory piece;
- remove touch-drag-only CSS and cleanup code;
- keep native HTML5 `draggable`/`dragstart` for desktop mouse behavior.

With no touchstart/touchmove `preventDefault()`, a vertical finger movement inside `.pieces-grid` remains a native scroll gesture. A stationary tap still produces the click used for selection.

Do not add `touch-action` tuning unless a focused browser test demonstrates a concrete need; browser-default scrolling is the desired baseline.

## Component boundaries

### `apps/web/src/lib/components/PuzzlePiece.svelte`

Owns per-piece input and visual presentation.

Changes:

- delete bespoke touch-drag state/helpers/listeners;
- retain HTML5 drag handling;
- extend the existing native interaction action to support click/tap selection;
- keep keyboard selection/deselection and rotation behavior unchanged;
- selected styling still comes only from the controlled `selected` prop.

### `apps/web/src/lib/components/PuzzleBoard.svelte`

Owns cell-level placement input.

Changes:

- route click/tap on a cell through `placePiece(selectedPieceId, x, y)` when selected;
- preserve keyboard and desktop drop paths;
- keep all correctness decisions outside the component;
- prefer one local native cell-interaction action for click + keydown rather than duplicating state-changing delegated handlers.

### `apps/web/src/lib/components/PuzzleBoardPanel.svelte`

Owns zoom/pan interaction.

Changes:

- include `selectedPieceId === null` in `canPanBoard`;
- cancel an active pan when selection becomes non-null;
- preserve all existing reset/reclamp, pointer-capture, blur, interaction-blocked, wheel, and toolbar behavior.

### `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`

Owns drawer presentation.

Changes:

- add local `drawerOpen` state;
- add Cancel and mobile open/collapse controls to the header;
- make the existing panel fixed/binary below 1024px and static at/above 1024px;
- keep one scrollable pieces grid and existing piece rendering; do not create separate mobile markup.

### `apps/web/src/routes/puzzle/[id]/+page.svelte`

No new behavior or state is planned.

The route already passes canonical `selectedPieceId`, `onSelect`, `onCancelSelection`, and `onPiecePlaced` through the extracted components. HPA-219 should not lift drawer state or add another touch orchestration path to the route. Only touch the route if implementation reveals a concrete CSS containment issue that cannot be owned by the extracted component; such a change must remain presentation-only.

## Data flow

Tap-to-place uses the existing chain:

```text
PuzzlePiece click/tap
    -> PuzzleInventoryPanel.onSelect(pieceId)
    -> route handleSelectPiece(pieceId)
    -> PuzzleSession select_piece
    -> PuzzleSessionState.selectedPieceId
    -> PuzzleBoardPanel.selectedPieceId
    -> PuzzleBoard.selectedPieceId

PuzzleBoard cell click/tap
    -> PuzzleBoard.placePiece(selectedPieceId, x, y)
    -> PuzzleBoardPanel.onPiecePlaced(pieceId, x, y)
    -> route placement handler
    -> PuzzleSession attempt_placement
        -> rejected: selectedPieceId retained
        -> accepted: selectedPieceId cleared
```

There is no second touch-specific placement state or callback.

## Rejection and completion behavior

A rejected mobile tap must behave exactly like existing keyboard/drop rejection:

- the attempt reaches `PuzzleSession`;
- `incorrectAttempts` increments once for a counted rejection;
- the route receives the existing `placement_rejected` event and drives the current temporary rejected-piece presentation;
- selection remains on the attempted piece;
- the player can immediately tap another board cell.

An accepted mobile tap:

- adds the canonical placement;
- clears selection through existing session logic;
- removes the placed piece from the inventory through existing derived rendering;
- preserves completion sealing/effects when the final piece is placed.

Do not add mobile-specific rejection messages, retries, or completion handling.

## Testing strategy

### `PuzzlePiece` component tests

Update `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts` to:

1. prove native click calls `onSelect(piece.id)` for an unplaced piece;
2. prove clicking an already-selected piece still calls `onSelect(piece.id)` and does not call `onCancelSelection`;
3. preserve existing Enter/Space select/deselect tests;
4. preserve HTML5 `dragstart` payload behavior;
5. delete the touch-drag helper/test matrix that exercises synthetic touch movement/drop because that behavior is intentionally removed;
6. keep rotation-button propagation coverage so rotate does not trigger selection.

### `PuzzleBoard` component tests

Update `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts` to:

1. prove a click on a drop zone routes the selected piece and coordinates to `onPiecePlaced` exactly once;
2. use a wrong coordinate in that test to prove the board does not pre-filter correctness;
3. prove click does nothing when no piece is selected;
4. retain keyboard and desktop drag/drop coverage.

### `PuzzleBoardPanel` component tests

Update `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts` to:

1. zoom above fit, render with a selected piece, pointerdown the board, and prove pan does not start;
2. begin a real non-zero pan, rerender with `selectedPieceId` non-null, and prove the active pan is canceled and later pointer moves do not change the transform;
3. rerender with selection cleared and prove normal pan can start again;
4. retain the existing reset/reclamp, capture-phase pointer-up, blur, interaction-blocked, wheel, and toolbar tests.

### `PuzzleInventoryPanel` component tests

Update `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` to:

1. prove Cancel appears only when selected and calls `onCancelSelection`;
2. prove the drawer starts open;
3. prove the mobile toggle changes `aria-expanded` / root drawer state open -> collapsed -> open;
4. prove collapsing does not remove or recreate the piece data model; the same tray contents remain available when reopened;
5. retain tray order, placed-piece filtering, hint/rejection precedence, rotation, and all-pieces-placed coverage.

Component tests should assert state/attributes rather than depend on a specific browser-test viewport for CSS media-query visibility. The mobile E2E owns the actual responsive-layout assertion.

### Deterministic mobile E2E

Add one feature-owned Chromium test, preferably `apps/web/e2e/gameplay-mobile-tap.spec.ts`, using the existing `e2e-square-4` fixture with a 390 × 844 touch-capable viewport.

The scenario should:

1. load a fresh standard-timed run with setup skipped through existing seeded gameplay preferences;
2. verify the inventory drawer is open and the board remains visibly present above/behind it;
3. tap a piece, then tap a wrong board cell;
4. verify the piece remains selected and the rejected presentation appears;
5. tap the correct cell and verify the piece leaves the tray / selection clears;
6. collapse the drawer and verify the board remains usable plus the drawer header remains available;
7. reopen the drawer;
8. complete the remaining small-fixture pieces through tap-to-place;
9. verify the existing completion dialog appears;
10. assert `document.documentElement.scrollWidth <= window.innerWidth` at the mobile viewport as the horizontal-overflow fence;
11. call the existing diagnostics settlement checks.

Extend `apps/web/e2e/support/gameplay-page.ts` with one small accepted-placement helper:

```ts
async placeWithTap(pieceId: number, x: number, y: number): Promise<void>
```

It should tap the piece, tap the target drop zone, then wait for the accepted piece's tray slot to detach. Keep rejected-attempt setup inline in the feature test because rejection deliberately does not satisfy that helper's accepted-placement postcondition.

Do not add a new fixture, test controller, browser matrix, or arbitrary timeout.

## Implementation sequencing constraints

The implementation plan should keep the change in independently reviewable slices without creating temporary architecture:

1. simplify `PuzzlePiece` and establish click/tap selection while preserving mouse/keyboard contracts;
2. add board tap placement and selection-aware pan behavior;
3. add the binary mobile inventory drawer and Cancel action;
4. add the single deterministic mobile E2E and minimal accepted `placeWithTap()` helper;
5. run focused component/E2E tests plus package typecheck/lint before final validation.

Do not add temporary dual touch implementations merely to make intermediate commits compile. The custom touch-drag path can be removed in the same task that introduces click/tap selection.

## Risks and mitigations

### A tap accidentally becomes board pan

**Mitigation:** `canPanBoard` is false while `selectedPieceId` is non-null, and an in-progress pan is canceled when selection appears.

### A rejected tap dispatches twice after a reactive rerender

**Mitigation:** use a local native cell listener path for click/keydown and a focused exact-once callback test; do not stack separate delegated click handlers around the same cell.

### Inventory scrolling still gets blocked by piece input

**Mitigation:** remove custom touch listeners, touch `preventDefault()`, piece translation, and `touch-none`; verify real mobile scrolling/layout in the Chromium mobile E2E rather than introducing a new gesture policy.

### Drawer state leaks into gameplay state

**Mitigation:** keep `drawerOpen` private to `PuzzleInventoryPanel`; no route prop/store/persistence field exists.

### Mobile drawer covers the whole puzzle

**Mitigation:** cap open height at `min(42svh, 26rem)` and verify the board remains visible in the 390 × 844 E2E.

### Desktop drag or keyboard behavior regresses

**Mitigation:** keep existing HTML5 drag and non-delegated keyboard handling, and retain their focused component tests. The responsive drawer CSS only changes presentation below 1024px.

## KISS / YAGNI guardrails

- `PuzzleSession` remains the only canonical gameplay state owner.
- One `drawerOpen` boolean is the only new state.
- No new store, controller, context, event bus, input manager, gesture classifier, bottom-sheet primitive, or view model.
- Remove obsolete touch-drag code instead of supporting two competing touch placement modes.
- Reuse the existing 1024px layout breakpoint.
- Reuse current board/inventory components and explicit callbacks.
- Reuse the deterministic E2E fixture/harness; one feature scenario is enough.
- No backward-compatibility path or mobile feature flag is required for this pre-release hobby project.

## Acceptance-criteria mapping

| HPA-219 criterion | Design coverage |
| --- | --- |
| Phone player can select and place without dragging between distant regions | native piece tap + board-cell tap-to-place |
| Success clears selection once | existing `PuzzleSession` accepted-placement behavior |
| Rejection keeps selection | existing `PuzzleSession` rejected-placement behavior |
| Inventory opens/collapses | one local `drawerOpen` boolean and header toggle |
| Inventory scrolls normally | custom touch drag / `preventDefault()` / `touch-none` removed |
| Bottom safe area respected | mobile drawer includes `env(safe-area-inset-bottom)` |
| Board session preserved | drawer only changes local CSS/presentation; board remains mounted |
| Desktop drag/keyboard/zoom/completion preserved | existing paths retained and regression-tested |
| No global state/gesture framework | explicit component-local changes only |
| Focused component + Chromium mobile E2E | four focused component suites + one 390 × 844 feature E2E |

## Expected production scope

The implementation should normally touch only:

- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`

Plus their focused tests and the feature E2E/helper files. `+page.svelte`, the session engine, persistence, API, and shared domain packages should remain unchanged unless a concrete implementation finding demonstrates that this design's existing contracts are inaccurate.