# HPA-219: Mobile Tap-to-Place and Simple Inventory Drawer — Design

**Linear:** HPA-219  
**Status:** Design for implementation  
**Date:** 2026-08-12

## Context

HPA-219 is the next actionable child of HPA-215 after HPA-224. HPA-557 is complete, so the puzzle route already composes concrete board and inventory components instead of owning their markup directly.

The existing gameplay domain already provides the required state transitions:

- `PuzzleSessionState.selectedPieceId` is the canonical selection;
- `select_piece` replaces the current selection;
- `cancel_selection` clears it;
- `attempt_placement` is the only placement authority;
- accepted placement clears `selectedPieceId` when that selected piece is placed;
- rejected placement increments the canonical incorrect-attempt counter and retains selection;
- `PuzzleBoard` already routes keyboard and HTML5 drop attempts through `onPiecePlaced(pieceId, x, y)` without pre-validating correctness;
- `PuzzleBoardPanel` owns ephemeral zoom/pan state;
- `PuzzleInventoryPanel` owns inventory markup and receives explicit selection callbacks.

The main mismatch is `PuzzlePiece.svelte`'s custom touch-drag path. It installs window touch listeners, calls `preventDefault()`, synthesizes drag/drop events, translates the piece during touch drag, and applies `touch-none`. That conflicts with HPA-219's required normal one-finger inventory scrolling. Because direct touch drag is explicitly optional, this ticket removes that path instead of adding gesture arbitration.

## Goals

1. Make phone-sized play practical with select-then-tap placement.
2. Reuse the existing `PuzzleSession` selection and placement actions as the only gameplay state transitions.
3. Retain selection after rejection and clear it after successful placement through existing session behavior.
4. Provide a visible Cancel action for pointer/touch deselection.
5. Replace the mobile stacked inventory with one two-state bottom drawer while keeping the board visible.
6. Allow normal one-finger vertical scrolling inside the inventory.
7. Preserve desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar zoom, rotation, completion, and session behavior.
8. Delete obsolete touch-drag complexity rather than supporting two touch interaction systems.

## Non-goals

- pinch zoom or two-finger pan;
- direct touch drag;
- long-press/movement gesture thresholds;
- drawer drag handles, intermediate snap points, or swipe gestures;
- a generalized bottom-sheet component;
- a pointer/gesture ownership framework;
- haptics;
- persisted drawer state;
- new `PuzzleSession` actions/state;
- inventory filters or staging trays;
- analytics, performance instrumentation, or device-lab certification;
- the broader HPA-223 accessibility-navigation work.

## Options considered

### Option A — Tap-to-place as the touch path; remove custom touch drag (selected)

Native click/tap selects a piece. Native click/tap on a board cell routes the selected piece through the existing placement callback. Desktop HTML5 drag/drop and keyboard input remain.

**Why this wins:** it reuses canonical state, removes custom touch code, restores browser scrolling, and requires no gesture classifier.

### Option B — Preserve touch drag with thresholds

Distinguish tap, scroll, and drag by time or movement distance.

**Rejected:** this adds gesture classification, cancellation, pointer ownership, and thresholds that HPA-219 explicitly does not need.

### Option C — Create separate mobile inventory/piece components

Duplicate the interaction surface for mobile.

**Rejected:** this duplicates markup and creates another synchronization boundary around the same `PuzzleSession` state.

## Decision

Use **Option A**.

`PuzzleSession` remains the sole gameplay state owner. The only new state is one component-local `drawerOpen` boolean inside `PuzzleInventoryPanel`. No route controller, store, context, event bus, gesture service, or drawer abstraction is added.

## Piece activation contract

For an unplaced `PuzzlePiece`:

- a native click/tap calls `onSelect(piece.id)`;
- tapping another piece replaces selection through `select_piece`;
- tapping the already-selected piece calls `onSelect(piece.id)` again and leaves it selected;
- Cancel is the explicit pointer/touch deselection path;
- keyboard Enter/Space preserves the current behavior, including deselecting an already-selected piece;
- the rotation button continues to stop propagation so rotate does not also select;
- native HTML5 `dragstart` remains for desktop mouse drag/drop.

`PuzzlePiece` already uses a non-delegated `keydownAction` because a selection-changing Svelte delegated event can be re-entered after a mid-event rerender. Rename that local action to `interactionAction` and attach both native `keydown` and native `click` listeners there. The click listener performs only the pointer/touch selection behavior above. This keeps one native activation per input event without introducing a shared event abstraction.

## Board activation contract

Every board drop zone supports three paths through one `placePiece(pieceId, x, y)` helper:

1. HTML5 drop;
2. keyboard Enter/Space when a piece is selected;
3. native click/tap when a piece is selected.

When `selectedPieceId === null`, click/tap is a no-op.

When selected, click/tap passes `selectedPieceId`, `x`, and `y` to `placePiece()`, which forwards directly to `onPiecePlaced`. `PuzzleBoard` does **not** check correctness, occupancy, or rotation validity before dispatch. `PuzzleSession` remains the only accept/reject authority.

Replace the current delegated per-cell `onkeydown` with a component-local `dropZoneInteractionAction(node, { x, y })` that installs native `click` and `keydown` listeners. It reads the current `selectedPieceId` and invokes `placePiece()` once per activation. The action remains private to `PuzzleBoard.svelte`; do not extract it.

## Selection lifecycle

The UI does not duplicate selection rules:

1. `select_piece` stores/replaces the selected id.
2. A rejected `attempt_placement` keeps that id.
3. An accepted `attempt_placement` clears it when that selected piece is placed.
4. Cancel dispatches `cancel_selection`.

No route-local or component-local selected-piece mirror is added.

## Pan ownership while a piece is selected

`PuzzleBoardPanel` keeps ownership of pan/zoom. Change pan availability to:

```ts
const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
```

Add one effect that cancels an active pan whenever `selectedPieceId` becomes non-null, matching the existing `interactionBlocked` cancellation style.

This guarantees:

- board pointerdown does not start pan while a piece is selected;
- the pan path does not call `preventDefault()` while selected;
- the board's `touch-none`/grab presentation is absent while selected;
- a board tap has one meaning: placement;
- successful placement or Cancel automatically restores pan eligibility when zoom permits it;
- wheel and toolbar zoom remain unchanged.

No pinch zoom or new touch-pan mode is added.

## Inventory drawer design

### State ownership

`PuzzleInventoryPanel` owns exactly one new local value:

```ts
let drawerOpen = $state(true);
```

It is not serialized, lifted to the route, or stored in `PuzzleSession`.

### Desktop behavior

At `min-width: 1024px`:

- preserve the existing static inventory side panel;
- inventory contents are always visible regardless of `drawerOpen`;
- hide the mobile OPEN/COLLAPSE toggle;
- show `CANCEL` in the header whenever `selectedPieceId !== null`;
- keep tray order, sizing, hint/rejection styling, rotation controls, and scrolling unchanged.

### Mobile behavior

Below 1024px, the same `PuzzleInventoryPanel` becomes a fixed bottom drawer:

```css
position: fixed;
inset-inline: 0;
bottom: 0;
z-index: 40;
max-width: 100vw;
box-sizing: border-box;
overflow-x: hidden;
padding-bottom: env(safe-area-inset-bottom);
```

The existing gameplay modal surfaces use `z-index: 50`, so `40` keeps the drawer above normal gameplay content and below dialogs.

When open:

- cap the panel at `max-height: min(42svh, 26rem)`;
- keep the existing `.pieces-grid` as the scrollable flex child with `overflow-y: auto` and `min-height: 0`;
- leave the header visible.

When collapsed:

- hide the inventory body and completion message through the mobile `.collapsed` presentation class;
- keep the header plus bottom safe-area padding visible;
- keep `CANCEL` visible if a piece is selected.

The mobile header adds an ordinary visible `COLLAPSE` / `OPEN` button with:

```text
aria-expanded=<drawerOpen>
aria-controls="puzzle-inventory-body"
```

The scrollable inventory body gets `id="puzzle-inventory-body"`.

No drag handle, snap point, swipe behavior, animation physics, or persisted state is introduced.

The drawer overlays the lower viewport instead of resizing/remounting the board. Toggling it therefore preserves the same `PuzzleBoardPanel` instance and session.

## Normal one-finger inventory scrolling

Delete the custom touch-drag implementation from `PuzzlePiece.svelte`:

- remove `SvelteMap` and touch-only `DataTransfer` construction;
- remove active-touch coordinates and touch translation state;
- remove window `touchmove`, `touchend`, and `touchcancel` listeners;
- remove synthetic `dragover`/`dragleave`/`drop` dispatch;
- remove touch-specific `onDestroy` cleanup;
- remove `ontouchstart`;
- remove `touch-none` from inventory pieces;
- remove touch-drag-only wrapper classes/styles;
- retain native HTML5 `draggable` and `dragstart` behavior for desktop mouse input.

Do not replace this with custom `touch-action` CSS. Browser-default scrolling is the intended mobile behavior.

## Component ownership

### `apps/web/src/lib/components/PuzzlePiece.svelte`

- simplify input by deleting bespoke touch drag;
- rename/extend the local native interaction action for click + keyboard;
- keep controlled selected styling, rotation, and HTML5 drag.

### `apps/web/src/lib/components/PuzzleBoard.svelte`

- add click/tap placement through `dropZoneInteractionAction`;
- keep keyboard/drop placement through the same `placePiece()` helper;
- keep correctness outside the component.

### `apps/web/src/lib/components/PuzzleBoardPanel.svelte`

- make `canPanBoard` selection-aware;
- cancel active pan when selection becomes non-null;
- keep current reset/reclamp, capture-phase pointer-up, blur, wheel, toolbar, and modal-blocking behavior.

### `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`

- add `drawerOpen`;
- add header Cancel and mobile OPEN/COLLAPSE controls;
- use the existing markup as a static desktop panel and fixed binary mobile drawer;
- keep one pieces grid rather than separate mobile markup.

### `apps/web/src/routes/puzzle/[id]/+page.svelte`

No HPA-219 production changes are planned. The route already passes `selectedPieceId`, `onSelect`, `onCancelSelection`, and `onPiecePlaced` through the extracted components. If implementation proves the route must change, revise this design before adding route-owned behavior.

## Data flow

```text
PuzzlePiece click/tap
  -> PuzzleInventoryPanel.onSelect(pieceId)
  -> route handleSelectPiece(pieceId)
  -> PuzzleSession select_piece
  -> PuzzleSessionState.selectedPieceId
  -> PuzzleBoardPanel / PuzzleBoard props

PuzzleBoard cell click/tap
  -> dropZoneInteractionAction
  -> placePiece(selectedPieceId, x, y)
  -> PuzzleBoardPanel.onPiecePlaced
  -> route placement handler
  -> PuzzleSession attempt_placement
     -> rejected: selection retained
     -> accepted: selection cleared
```

There is no second touch-specific state path.

## Rejection and completion behavior

A rejected tap must use existing behavior:

- one `attempt_placement` reaches `PuzzleSession`;
- `incorrectAttempts` increments once for a counted rejection;
- the route receives `placement_rejected` and drives the current rejected-piece presentation;
- selection remains;
- the player may immediately tap another cell.

An accepted tap:

- adds the canonical placement;
- clears selection through session logic;
- removes the placed piece from the inventory via existing derived rendering;
- preserves existing completion sealing/effects when the final piece is placed.

No mobile-specific rejection or completion state is added.

## Testing strategy

### `PuzzlePiece.svelte.test.ts`

Update `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts` to prove:

1. native click calls `onSelect(piece.id)` for an unplaced piece;
2. clicking an already-selected piece still calls `onSelect(piece.id)` and does not call `onCancelSelection`;
3. Enter/Space selection/deselection remains unchanged;
4. HTML5 `dragstart` payload behavior remains;
5. a cancelable `touchstart` on the piece is no longer default-prevented;
6. rotation-button activation does not select the piece.

Delete the touch-drag helper/test matrix that exercises synthetic touch movement/drop, because that behavior is intentionally removed.

### `PuzzleBoard.svelte.test.ts`

Update `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts` to prove:

1. selected-piece click on a wrong-coordinate cell calls `onPiecePlaced(pieceId, x, y)` exactly once;
2. click does nothing when no piece is selected;
3. existing keyboard and desktop drag/drop paths still pass.

Using a wrong coordinate deliberately proves that the board does not pre-filter correctness.

### `PuzzleBoardPanel.svelte.test.ts`

Update `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts` to prove:

1. after zooming above fit, board pointerdown does not start pan when `selectedPieceId` is non-null;
2. an already-active non-zero pan is canceled when rerendered with a selected piece;
3. later pointer moves do not change the transform after that cancellation;
4. clearing selection restores normal pan initiation.

Retain all existing reset/reclamp, capture-phase pointer-up, blur, interaction-blocked, wheel, and toolbar regression tests.

### `PuzzleInventoryPanel.svelte.test.ts`

Update `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` to prove:

1. `CANCEL` appears only while a piece is selected and calls `onCancelSelection`;
2. drawer state starts open;
3. the toggle changes `aria-expanded` open -> collapsed -> open;
4. tray contents remain the same after collapsing and reopening;
5. existing tray-order, placed filtering, hint/rejection precedence, rotation, and completion-message tests remain.

Component tests assert attributes/state rather than relying on their test browser viewport to evaluate responsive CSS. Actual mobile layout is covered by E2E.

### Mobile E2E

Add `apps/web/e2e/gameplay-mobile-tap.spec.ts` using the existing `e2e-square-4` deterministic fixture at **390 × 844** with touch enabled.

The single Chromium feature scenario must:

1. seed the existing start-immediately gameplay preference and load a fresh standard-timed run;
2. verify the drawer starts open, `.pieces-grid` computes to `overflow-y: auto`, and the puzzle board is visible;
3. tap a piece and then a wrong board cell;
4. verify the piece remains selected and current rejected presentation appears;
5. tap its correct cell and verify the tray slot detaches / selection clears;
6. collapse the drawer and verify the board remains visible/usable while the drawer header remains available;
7. reopen the drawer;
8. complete the remaining three pieces through tap-to-place;
9. verify the existing completion dialog appears;
10. assert `document.documentElement.scrollWidth <= window.innerWidth`;
11. run the existing fixture diagnostics settlement assertions.

Extend `apps/web/e2e/support/gameplay-page.ts` with exactly one accepted-placement helper:

```ts
async placeWithTap(pieceId: number, x: number, y: number): Promise<void>
```

It taps the piece, taps the target drop zone, and waits for the accepted piece's tray slot to detach. Keep the rejected-attempt setup inline in the HPA-219 feature test because rejection intentionally does not satisfy this helper's accepted-placement postcondition.

Do not add a fixture, test controller, new browser matrix, or fixed sleep.

## Implementation sequence

The implementation plan should use these reviewable slices:

1. simplify `PuzzlePiece` and add native click/tap selection while retaining desktop drag and keyboard behavior;
2. add board click/tap placement plus selection-aware pan cancellation;
3. add the binary mobile inventory drawer and Cancel action;
4. add the single deterministic mobile E2E and minimal `placeWithTap()` helper;
5. run focused component/E2E checks plus package typecheck/lint/build validation.

The touch-drag removal and click/tap selection land together. Do not keep temporary dual touch implementations between commits.

## Risks and mitigations

### Tap starts board pan

**Mitigation:** `canPanBoard` requires `selectedPieceId === null`; selection also cancels any existing pan.

### Rejected tap dispatches twice after rerender

**Mitigation:** native `dropZoneInteractionAction` installs one click listener, and the component test asserts exactly one callback.

### Inventory scrolling remains blocked

**Mitigation:** remove touch listeners, touch `preventDefault()`, touch translation, and `touch-none`; add a focused non-default-prevention test and keep the inventory body as an explicit overflow container.

### Drawer state leaks into gameplay

**Mitigation:** `drawerOpen` stays private to `PuzzleInventoryPanel` and is neither a prop nor persisted state.

### Drawer hides too much board

**Mitigation:** open height is capped at `min(42svh, 26rem)` and verified at 390 × 844.

### Drawer overlays a modal

**Mitigation:** drawer uses `z-index: 40`; existing gameplay dialogs use `z-index: 50`.

### Desktop regression

**Mitigation:** desktop breakpoint keeps the static side panel and focused tests retain HTML5 drag, keyboard, zoom/pan, rotation, and completion contracts.

## KISS / YAGNI guardrails

- `PuzzleSession` remains the only canonical gameplay state owner.
- `drawerOpen` is the only new state.
- No route state for the drawer or mobile placement.
- No gesture classifier, bottom-sheet primitive, input manager, or event bus.
- Remove obsolete touch drag instead of supporting two competing touch modes.
- Reuse the existing 1024px breakpoint and extracted components.
- Reuse the deterministic E2E fixture/harness.
- No backward-compatibility path or feature flag is needed for this pre-release project.

## Acceptance-criteria mapping

| HPA-219 criterion | Design coverage |
| --- | --- |
| Phone player selects/places without distant dragging | piece tap + board-cell tap |
| Success clears selection once | existing accepted-placement session contract |
| Rejection keeps selection | existing rejected-placement session contract |
| Inventory opens/collapses | one local `drawerOpen` boolean |
| Inventory scrolls normally | bespoke touch drag/default prevention removed; overflow container retained |
| Bottom safe area respected | `env(safe-area-inset-bottom)` on mobile drawer |
| Board session preserved | drawer changes presentation only; board remains mounted |
| Desktop drag/keyboard/zoom/completion preserved | existing paths retained and regression-tested |
| No global state/gesture framework | component-local explicit changes only |
| Focused component + Chromium mobile E2E | four focused suites + one 390 × 844 scenario |

## Expected implementation scope

Production files:

- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/lib/components/PuzzleBoard.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`

Test/support files:

- `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/e2e/support/gameplay-page.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`

The session engine, persistence, API, shared domain packages, and puzzle route remain unchanged by this design.