# HPA-223: Practical Keyboard Navigation and Core Announcements — Design

**Linear:** HPA-223  
**Status:** Design for implementation  
**Date:** 2026-08-15

## Context

HPA-223 is the next actionable child of HPA-215. Its only explicit blocker, HPA-557, is complete, and the earlier gameplay UX children in the parent delivery order have landed: completion summary, mobile tap/drawer, inventory filters/shuffle, gallery Continue, responsive toolbar, and persistent Reference.

Current `main` already has the right ownership boundaries:

- the puzzle route owns the `PuzzleSession` store, global Undo/Redo shortcuts, lifecycle/dialog orchestration, and session events;
- `PuzzleToolbar.svelte` owns the finite toolbar controls;
- `PuzzleBoard.svelte` owns board-cell interaction;
- `PuzzleInventoryPanel.svelte` owns the visible tray while `PuzzlePiece.svelte` owns per-piece selection/rotation;
- dialogs reuse `$lib/actions/modalFocus`;
- persistent Reference already traps/restores focus around its Close control.

The missing work is mainly DOM focus shape and concise feedback, not new gameplay behavior. Enter/Space selection and placement already reuse the same callbacks as pointer/touch, `R` already rotates a focused piece, and Ctrl/Cmd+Z / Ctrl/Cmd+Y already route through the session Undo/Redo handlers.

The current tab order does not scale because every toolbar action, board cell, visible piece, and per-piece Rotate button is independently tabbable. A 100-piece puzzle therefore creates a long Tab sequence even though the domain already supports practical keyboard actions.

## Goals

1. Make the toolbar one Tab stop with arrow movement among currently visible, enabled actions.
2. Make the board one Tab stop with non-wrapping spatial arrow movement.
3. Make the repeated inventory pieces one Tab stop with arrow movement through current visible tray order/layout.
4. Preserve Enter/Space selection/placement, `R` rotation, and existing Undo/Redo shortcuts through existing `PuzzleSession` actions.
5. Add one route-owned polite live region for selection, accepted/rejected placement, hint target, explicit pause/resume, and completion.
6. Let Escape cancel a piece selection, end Hold-to-Peek, or dismiss persistent Reference without new interaction state.
7. Improve concise accessible names for composite regions and board cells.
8. Cover the changed components plus one real keyboard gameplay E2E.

## Non-goals

- A generic roving-focus library/action/store/controller/context provider.
- High Contrast, Reduce Glow, font-size, motion, or other accessibility preferences.
- Full WCAG certification or manual NVDA/VoiceOver release sign-off.
- Deterministic focus recovery for every future filter, shuffle, viewport/orientation change, modal mutation, or removed item.
- Reworking `modalFocus`, replacing Reference's existing trap, or creating a universal dialog system.
- Reordering route DOM so inventory precedes the board.
- Accessibility-specific gameplay state/actions/events/persistence.
- Announcing every arrow move, timer tick, progress update, Undo/Redo mutation, or reference activation.
- Staging trays, advanced mobile gestures, or HPA-237 work.
- New dependencies, Playwright projects, fixture families, or test frameworks.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Piece select/cancel | `select_piece` / `cancel_selection` | Reuse unchanged |
| Placement | `attempt_placement`; `placement_accepted` / `placement_rejected` | Reuse events for all input modes |
| Rotation | `rotate_piece`; `PuzzlePiece` `R` handler | Keep `R`; remove repeated Rotate buttons from Tab sequence |
| Hint | `use_hint` + `hint_target` | Reuse event for announcement |
| Pause/resume | route lifecycle composition | Announce explicit user actions only |
| Completion | `placement_accepted.completed` + completion dialog | Combine final placement + completion in one message |
| Undo/Redo | route global shortcut owner | Keep unchanged |
| Modal focus | `$lib/actions/modalFocus` | Keep unchanged |
| Persistent Reference | `ReferenceOverlay.svelte` | Keep trap/restoration; add local Escape dismissal |
| Toolbar responsive state | CSS + local `moreOpen` | Inspect actual visible buttons; no JS breakpoint copy |
| Inventory order/filter | `visiblePieces` | Roving state follows rendered list |
| E2E | `gameplay-accessibility.spec.ts` + `GameplayPage` | Extend; no harness |

No new domain state, persisted field, service, or shared focus abstraction is justified.

## Options considered

### Option A — Component-local roving focus + one route live region (selected)

Toolbar, board, and inventory each own only their ephemeral focus position. The route translates existing outcomes/events into one announcement string.

**Pros:** matches HPA-557 boundaries, changes no domain/persistence contract, keeps keyboard/pointer/touch on the same actions, and is easy to test in existing files.

**Cons:** three components contain small arrow handlers.

That duplication is intentional. Toolbar navigation is a one-dimensional list of visible enabled actions; board navigation is a fixed coordinate grid; inventory navigation is filtered/reordered and responsive. A configurable helper would add more abstraction than reuse.

### Option B — Shared roving-focus helper/action

**Rejected:** it would need orientation, wrapping, disabled filtering, responsive columns, active-id recovery, and callback configuration for three different consumers before any repeated abstraction exists.

### Option C — Route-level accessibility/focus controller

**Rejected:** it would couple the route to child DOM details and create another presentation-state layer beside `PuzzleSession`.

## Focus model

The goal is not one Tab stop for the whole page. Finite native controls such as Back, inventory filters, Shuffle, drawer toggle, and dialog actions remain normal Tab stops. The change targets repeated/composite controls that cause Tab explosion.

After HPA-223:

- toolbar: exactly one currently visible, enabled action has `tabindex="0"`;
- board: exactly one cell has `tabindex="0"`;
- repeated inventory pieces: exactly one visible piece root has `tabindex="0"`;
- per-piece Rotate buttons remain clickable/tappable but use `tabindex="-1"`; keyboard rotation remains `R` on the piece root;
- open dialogs keep their existing trapped native Tab order.

Every composite updates its roving state on `focusin` as well as arrow movement. This matters because existing tests/helpers and pointer users may directly focus/click an item that currently has `tabindex="-1"`; that focused item must become the composite's next Tab entry point.

Arrow movement never dispatches gameplay state and never enters the live region.

## Toolbar

`PuzzleToolbar.svelte` becomes a concrete named toolbar:

```svelte
<div role="toolbar" aria-label="Puzzle actions" data-testid="puzzle-toolbar">
```

Keep one local active action id, initially `hint` because Hint is visible in both layouts and is not disabled by empty Undo/Redo history.

Every toolbar button gets a stable `data-toolbar-action` plus roving `tabindex`. `focusin` updates the active id. Arrow handling queries only buttons that are enabled and actually visible (`offsetParent !== null`), then focuses the previous/next item. This naturally skips disabled history actions and compact secondary controls while `MORE` is closed without duplicating the 1024px breakpoint in TypeScript.

The existing primary/secondary markup, `moreOpen`, callbacks, and CSS remain. No menu framework, focus trap, outside-click behavior, or command registry is added.

When props/`moreOpen` remove or disable the active action, a small local normalization picks the first visible enabled action after the DOM update. Deterministic recovery for a focused secondary control exactly while the viewport crosses the responsive breakpoint remains outside this ticket's explicit orientation/focus-recovery guardrail.

## Board

Keep the current visual grid and button semantics. Do not create an ARIA `grid` tree that would require row wrappers solely to satisfy structure.

Name the board as a group:

```svelte
<div role="group" aria-label="Puzzle board" data-testid="puzzle-board">
```

Each drop zone stays `role="button"` but only one is tabbable. The component owns an ephemeral active `(x, y)`, initialized to `(0, 0)` and reset on puzzle identity change. `focusin` on any cell updates that coordinate.

Arrow behavior is spatial and does not wrap:

```text
Left  -> x - 1 when a left cell exists
Right -> x + 1 when a right cell exists
Up    -> y - 1 when an upper cell exists
Down  -> y + 1 when a lower cell exists
```

At an edge, focus stays on the current cell. Enter/Space continues through the existing `placePiece()` path with no UI-side correctness filter.

Cell names become one-based/status-oriented:

```text
Row 1, column 1, empty
Row 1, column 2, occupied
```

`data-x` / `data-y` remain zero-based and unchanged for gameplay/E2E locators.

## Inventory pieces

`PuzzleInventoryPanel.svelte` owns `activePieceId` because it already owns filtered/reordered `visiblePieces`.

Normalize only when the current active id is no longer visible:

1. keep it when still visible;
2. otherwise prefer the selected piece if visible;
3. otherwise choose the first visible piece;
4. use `null` when no pieces are visible.

Do not unconditionally snap the roving id back to `selectedPieceId`; that would make arrow movement impossible while a selection exists.

`PuzzlePiece.svelte` gains one optional presentation prop:

```ts
tabIndex?: number;
```

The root defaults to today's `0` for other consumers. Inventory passes `0` only to `activePieceId`, `-1` to other visible pieces. The Rotate button becomes `tabindex="-1"`; pointer/touch rotation remains unchanged, while the existing root `R` handler remains the keyboard command and gains `aria-keyshortcuts="R"` while rotatable.

Name `.pieces-grid` as `role="group" aria-label="Available puzzle pieces"`. Header controls and All/Corners/Edges/Center/Shuffle remain finite native controls.

### Inventory arrow geometry

- Left/Right: adjacent item in current `visiblePieces` order; no wrap.
- Up/Down: same visual column when a corresponding row exists.
- If the next row is partial, Down may land on that row's last item when the same column is absent.
- If there is no row in the requested vertical direction, focus stays put.

Read current rendered slot geometry/tracks at key time; do not mirror responsive breakpoints or piece-size formulas in TypeScript. Component tests own deterministic horizontal movement/normalization; rendered Playwright coverage can prove vertical movement.

## Escape behavior

The route remains the global gameplay shortcut owner when no session modal is open:

1. active Hold-to-Peek -> Escape calls existing `clearReferenceHold()` and leaves any selected piece selected;
2. otherwise selected piece -> Escape dispatches existing `cancel_selection`;
3. otherwise no-op.

Persistent Reference is already modal-like and the route intentionally blocks gameplay shortcuts while toggled. `ReferenceOverlay.svelte` handles Escape locally, calls existing `onDismiss`, and **stops propagation** so the same Escape cannot dismiss Reference and then also cancel an underlying selected piece if route-derived `referenceToggled` updates synchronously.

Do not make Escape close compact `MORE`; HPA-217 intentionally kept that disclosure simple.

## Live announcements

### Ownership and placement

Add one route-local string and helper:

```ts
let gameplayAnnouncement = $state('');

function announceGameplay(message: string): void {
	gameplayAnnouncement = '';
	queueMicrotask(() => {
		gameplayAnnouncement = message;
	});
}
```

Render one atomic polite status region:

```svelte
<div
	class="sr-only"
	role="status"
	aria-live="polite"
	aria-atomic="true"
	data-testid="gameplay-announcer"
>
	{gameplayAnnouncement}
</div>
```

**It must be outside `.puzzle-page`.** The route sets both `inert` and `aria-hidden` on `.puzzle-page` whenever setup/pause/exit/completion UI is open. A live region inside that subtree would disappear from the accessibility tree exactly when pause/completion feedback is needed.

### Message sources

Use existing outcomes/events, never DOM inference:

| Source | Announcement |
| --- | --- |
| successful explicit `select_piece` | `Puzzle piece {id} selected.` |
| explicit cancel | `Selection canceled.` |
| accepted placement | `Puzzle piece {id} placed.` |
| final accepted placement | `Puzzle piece {id} placed. Puzzle complete.` |
| rejected `wrong_slot` | `Puzzle piece {id} does not fit there.` |
| rejected `non_upright` | `Puzzle piece {id} must be upright.` |
| non-null `hint_target` | `Hint: puzzle piece {id} goes to row {y+1}, column {x+1}.` |
| explicit user Pause | `Mission paused.` |
| explicit Resume | `Mission resumed.` |

Do not separately announce `completion_sealed`: `PuzzleSession` emits `placement_accepted` with `completed: true` before sealing, so one final message can carry both facts.

Do not announce restored/internal lifecycle transitions. The restored-run `Resume Mission` dialog already communicates that state and should not be narrated as a fresh user pause.

Arrow movement needs no announcement because focus + accessible name already communicates the newly focused action/cell/piece.

## Data flow

```text
Enter / Space / R / Ctrl(Cmd)+Z/Y / Escape
                  |
                  v
existing component/route callback
                  |
                  v
PuzzleSession.dispatch(existing action)
                  |
          outcome / existing event
                  |
                  v
        route announceGameplay()
                  |
                  v
       one polite live region

Arrow keys -> component-local focus only
```

Pointer and touch continue through the same callbacks/session actions, so shared placement/hint events also drive announcements for those input modes.

## Component boundaries

### `PuzzleToolbar.svelte`

Toolbar role/name, one local active action, focusin tracking, arrows over visible enabled buttons. Preserve responsive behavior and callbacks.

### `PuzzleBoard.svelte`

One local active coordinate, focusin tracking, spatial arrows, concise one-based names. Preserve click/drag/drop/Enter/Space and zero-based data coordinates.

### `PuzzleInventoryPanel.svelte`

One local `activePieceId`, focusin tracking, arrow movement through `visiblePieces`, DOM-derived vertical geometry, normalization only when active id disappears.

### `PuzzlePiece.svelte`

Optional `tabIndex`; pointer Rotate removed from normal Tab order; existing `R` rotation retained/exposed via `aria-keyshortcuts`.

### Puzzle route

Single announcement string/helper; selection/cancel outcomes; placement/hint events; explicit pause/resume; Escape for Hold/selection; announcer outside inert subtree; existing Undo/Redo unchanged.

### `ReferenceOverlay.svelte`

Escape -> prevent default, stop propagation, existing `onDismiss`; preserve current Tab trap/focus restoration.

## Testing strategy

### Component/route tests

- `PuzzleToolbar.svelte.test.ts`: toolbar role/name, exactly one visible enabled tab stop, arrows move/skip disabled/hidden actions, existing callbacks/MORE stay green.
- `PuzzleBoard.svelte.test.ts`: many cells but one tab stop, focusin updates active cell, Right/Down + edge behavior, Enter/Space still routes attempts, one-based empty/occupied names.
- `PuzzlePiece.svelte.test.ts`: supplied `tabIndex`, Rotate `tabindex=-1`, `aria-keyshortcuts=R`, existing `R` callback.
- `PuzzleInventoryPanel.svelte.test.ts`: one repeated piece tab stop, focusin updates active id, Left/Right, active-id normalization after filtering/placement, existing filter/shuffle/drawer behavior.
- `ReferenceOverlay.svelte.test.ts`: Escape dismisses and does not bubble; existing Tab trap/restoration stays green.
- puzzle route test: announcer polite/atomic/outside inert subtree; selection/cancel/accepted/rejected/hint/final completion/pause/resume; Escape selection; existing Undo/Redo.

### One real keyboard E2E

Extend `apps/web/e2e/gameplay-accessibility.spec.ts`. Put `@smoke` in the new test title while keeping it under the existing `accessibility @a11y` describe. One source test then participates in the normal Chromium smoke selection and the existing accessibility lane.

On `e2e-square-4`, prove:

1. one visible toolbar action, one board cell, and one repeated inventory piece are tabbable;
2. Tab enters toolbar then board without traversing every toolbar action/cell;
3. toolbar, board, and inventory arrows move focus;
4. Enter/Space selects/places through the real session;
5. wrong placement announces rejection;
6. Escape cancels selection;
7. Ctrl+Z/Ctrl+Y still undo/redo;
8. Hint announces its target;
9. existing keyboard helper completes remaining pieces;
10. completion dialog appears and final live text includes `Puzzle complete.`.

Do not emulate responsive layout in component tests or add another E2E fixture/harness.

## Risks and deliberate limits

- **Viewport crosses toolbar breakpoint while a hidden secondary action is focused:** normal initial layouts and MORE changes are covered; deterministic orientation recovery is deferred by ticket scope.
- **Inventory filter/shuffle changes visible geometry:** preserve active id when possible; otherwise choose selected/first for the next Tab entry. Do not force-focus replacement nodes after every mutation.
- **Live-region noise:** only the explicit table above is announced.
- **Reference Escape double action:** stop propagation in the overlay so one key closes one UI layer.

## Acceptance mapping

- Keyboard select/place/cancel/undo/redo/complete: existing actions + E2E.
- Large puzzle avoids one Tab stop per piece/cell: roving count assertions are independent of collection size; board test can use the existing 10×10 helper case for explicit 100-cell coverage.
- Concise announcements: route tests + representative E2E.
- Pointer/touch/keyboard share outcomes: no new domain path; shared events drive placement/hint announcements.
- Accessible names/modal focus: named composites/cells; existing modal systems preserved.
- Focused tests + one keyboard E2E: existing files only.

## Scope summary

HPA-223 is an accessibility behavior pass over existing seams, not an accessibility architecture project. Expected production changes stay in `PuzzleToolbar`, `PuzzleBoard`, `PuzzlePiece`, `PuzzleInventoryPanel`, `ReferenceOverlay`, and the puzzle route. `PuzzleSession` needs no new action, state, event, schema, or persistence work.