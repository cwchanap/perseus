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

1. Make the toolbar one Tab stop with wrapping arrow movement among currently visible, enabled actions.
2. Make the board one Tab stop with non-wrapping spatial arrow movement.
3. Make repeated inventory pieces one Tab stop; Left/Right moves through current `visiblePieces` order without wrapping.
4. Preserve Enter/Space selection/placement, `R` rotation, and existing Undo/Redo shortcuts through existing `PuzzleSession` actions.
5. Add one route-owned polite live region for selection, accepted/rejected placement, hint target, explicit pause/resume, and completion.
6. Let Escape cancel a piece selection, end Hold-to-Peek, or dismiss persistent Reference without new interaction state.
7. Improve concise accessible names for composite regions and board cells.
8. Cover the changed components plus one real keyboard gameplay smoke flow.

## Non-goals

- A generic roving-focus library/action/store/controller/context provider.
- High Contrast, Reduce Glow, font-size, motion, or other accessibility preferences.
- Full WCAG certification or manual NVDA/VoiceOver release sign-off.
- Deterministic focus recovery for every future filter, shuffle, viewport/orientation change, modal mutation, or removed item.
- Reworking `modalFocus`, replacing Reference's existing trap, or creating a universal dialog system.
- Reordering route DOM so inventory precedes the board.
- Accessibility-specific gameplay state/actions/events/persistence.
- Announcing every arrow move, timer tick, progress update, Undo/Redo mutation, or reference activation.
- Two-dimensional inventory navigation. Left/Right already reaches every visible tray piece; Up/Down can be added later in the same local handler if real usage justifies spatial tray navigation.
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
| Inventory order/filter | `visiblePieces` | Roving state follows the ordered rendered list |
| Native keyboard handling | `PuzzlePiece.interactionAction` and `PuzzleBoard.dropZoneInteraction` | Reuse native `addEventListener` pattern for focus-changing keydown handlers |
| Keyboard E2E | `gameplay-interactions.spec.ts` | Add the smoke flow beside existing keyboard placement tests |
| Axe/accessibility E2E | `gameplay-accessibility.spec.ts` | Keep it as the accessibility scan lane; add only structural tab-stop/announcer checks |

No new domain state, persisted field, service, geometry engine, or shared focus abstraction is justified.

## Options considered

### Option A — Component-local roving focus + one route live region (selected)

Toolbar, board, and inventory each own only their ephemeral focus position. The route translates existing outcomes/events into one announcement string.

**Pros:** matches HPA-557 boundaries, changes no domain/persistence contract, keeps keyboard/pointer/touch on the same actions, and is easy to test in existing files.

**Cons:** three components contain small, intentionally different arrow handlers.

That duplication is deliberate:

- toolbar is a wrapping one-dimensional list of currently visible/enabled actions;
- board is a fixed two-dimensional coordinate grid;
- inventory is a filtered/reordered one-dimensional list for this ticket.

A configurable helper would add more abstraction than reuse.

### Option B — Shared roving-focus helper/action

**Rejected:** it would need wrapping, disabled/visibility filtering, coordinate movement, active-id recovery, and callback configuration for different consumers before any repeated abstraction exists.

### Option C — Route-level accessibility/focus controller

**Rejected:** it would couple the route to child DOM details and create another presentation-state layer beside `PuzzleSession`.

### Option D — Add two-dimensional inventory geometry now

Measure `.piece-slot` positions or computed grid tracks so Up/Down can move by rendered columns.

**Rejected for HPA-223:** that is the only new layout/geometry engine in the earlier design, isolated component tests do not receive the route-owned `--piece-slot-size`, and Left/Right already makes every visible piece reachable. Shipping DOM geometry plus partial-row rules is more code and test cost than the first accessibility pass needs.

## Focus model

The goal is not one Tab stop for the whole page. Finite native controls such as Back, inventory filters, Shuffle, drawer toggle, and dialog actions remain normal Tab stops. The change targets repeated/composite controls that cause Tab explosion.

After HPA-223:

- toolbar: exactly one currently visible, enabled action has `tabindex="0"`;
- board: exactly one cell has `tabindex="0"`;
- repeated inventory pieces: exactly one visible piece root has `tabindex="0"`;
- per-piece Rotate buttons remain clickable/tappable but use `tabindex="-1"`; keyboard rotation remains `R` on the piece root;
- open dialogs keep their existing trapped native Tab order.

Every composite updates its roving state on `focusin` as well as arrow movement. This matters because existing `GameplayPage.selectAndPlaceWithKeyboard()` and route/component tests directly call `.focus()` on nodes that may currently have `tabindex="-1"`; the directly focused item must become the composite's next Tab entry point.

Arrow movement never dispatches gameplay state and never enters the live region.

## Native keydown convention

The repository already avoids Svelte-delegated keydown for focus-changing/re-rendering piece and board interactions. `PuzzlePiece.interactionAction` and `PuzzleBoard.dropZoneInteraction` attach native listeners with `addEventListener` because a mid-event Svelte 5 rerender can otherwise re-invoke a delegated handler.

HPA-223 follows that established pattern:

- toolbar root: a small local Svelte action attaches/removes native `keydown`; `focusin` still updates the active action;
- board cells: extend the existing native `handleKeyDown` called by `dropZoneInteraction`; do not add a second board key listener;
- inventory `.pieces-grid`: a small local Svelte action attaches/removes native `keydown`; `focusin` still updates `activePieceId`.

Tests assert the **adjacent expected item**, not merely that focus changed, so a double-skip regression cannot pass unnoticed.

## Toolbar

`PuzzleToolbar.svelte` becomes a concrete named toolbar:

```svelte
<div role="toolbar" aria-label="Puzzle actions" data-testid="puzzle-toolbar">
```

Use a closed local action type, not untyped strings:

```ts
type ToolbarAction =
	| 'undo'
	| 'redo'
	| 'hint'
	| 'reference'
	| 'more'
	| 'zoom-out'
	| 'zoom-in'
	| 'fit'
	| 'rotation'
	| 'peek'
	| 'pause'
	| 'setup';

let activeToolbarAction = $state<ToolbarAction>('hint');
```

Every toolbar button gets a stable `data-toolbar-action` plus roving `tabindex`. `toolbarTabIndex()` accepts only `ToolbarAction`, and values read back from `dataset.toolbarAction` are treated as that same closed union.

`focusin` updates the active id. Native arrow handling queries only buttons that are enabled and actually visible (`offsetParent !== null`), then focuses the adjacent item. Left/Up move backward; Right/Down move forward; toolbar movement wraps. This naturally skips disabled history actions and compact secondary controls while `MORE` is closed without duplicating the 1024px breakpoint in TypeScript.

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

At an edge, focus stays on the current cell. Put this branch at the top of the existing native `handleKeyDown`; Enter/Space then continues through the current `placePiece()` path with no UI-side correctness filter.

Cell names become one-based/status-oriented:

```text
Row 1, column 1, empty
Row 1, column 2, occupied
```

`data-x` / `data-y` remain zero-based and unchanged for gameplay/E2E locators.

The route integration helper `placeSelectedPieceAt()` currently queries `Drop zone at position {x}, {y}`. Update that locator in the same board slice as the accessible-name change so Task 2 remains independently green; announcer-specific route tests still belong to the later route slice.

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

The root defaults to today's `0` for other consumers, while placed pieces still force `-1`. Inventory passes `0` only to `activePieceId`, `-1` to other visible pieces. The Rotate button becomes `tabindex="-1"`; pointer/touch rotation remains unchanged, while the existing root `R` handler remains the keyboard command and gains `aria-keyshortcuts="R"` while rotatable.

Name `.pieces-grid` as `role="group" aria-label="Available puzzle pieces"`. Header controls and All/Corners/Edges/Center/Shuffle remain finite native controls.

Inventory arrow behavior is intentionally one-dimensional for HPA-223:

```text
ArrowLeft  -> previous item in visiblePieces when one exists
ArrowRight -> next item in visiblePieces when one exists
```

Movement does not wrap. Up/Down are ignored and remain available for a later spatial enhancement. No `getBoundingClientRect`, computed-grid parsing, responsive-column state, or partial-row rule is introduced.

## Escape behavior

The route remains the global gameplay shortcut owner when no session modal is open:

1. active Hold-to-Peek -> Escape calls existing `clearReferenceHold()` and leaves any selected piece selected;
2. otherwise selected piece -> Escape dispatches existing `cancel_selection` through the explicit announcing cancel handler;
3. otherwise no-op.

`clearTransientGameplayState()` keeps its direct `cancel_selection` dispatch. It must **not** call the announcing cancel helper, because Pause/restart/exit cleanup should not speak `Selection canceled.` immediately before the actual lifecycle message.

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

Render one atomic polite status region as a sibling of `.puzzle-page` and the existing dialogs:

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

**It must be outside `.puzzle-page`.** The route sets both `inert` and `aria-hidden` on `.puzzle-page` whenever setup/pause/exit/completion UI is open. A live region inside that subtree would disappear from the accessibility tree exactly when pause/completion feedback is needed. HPA-557 explicitly deferred this region to HPA-223.

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

Selection/cancel messages come from the return value of the existing dispatch calls. Placement/hint messages come from `handleSessionEvent`; `placement_accepted` is already emitted by `PuzzleSession` and currently needs no domain change.

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

Toolbar role/name, closed `ToolbarAction` union, one local active action, focusin tracking, native keydown action, wrapping arrows over visible enabled buttons. Preserve responsive behavior and callbacks.

### `PuzzleBoard.svelte`

One local active coordinate, focusin tracking, spatial arrows inside the existing native cell keydown handler, concise one-based names. Preserve click/drag/drop/Enter/Space and zero-based data coordinates.

### `PuzzleInventoryPanel.svelte`

One local `activePieceId`, focusin tracking, native grid keydown action, Left/Right through `visiblePieces`, normalization only when active id disappears. No DOM column measurement.

### `PuzzlePiece.svelte`

Optional `tabIndex`; placed still forces `-1`; pointer Rotate removed from normal Tab order; existing `R` rotation retained/exposed via `aria-keyshortcuts`.

### Puzzle route

Single announcement string/helper; selection/cancel outcomes; placement/hint events; explicit pause/resume; Escape for Hold/selection; announcer outside inert subtree; existing Undo/Redo unchanged. Lifecycle cleanup keeps direct non-announcing selection cancellation.

### `ReferenceOverlay.svelte`

Escape -> prevent default, stop propagation, existing `onDismiss`; preserve current Tab trap/focus restoration.

## Testing strategy

### Component/route tests

- `PuzzleToolbar.svelte.test.ts`: toolbar role/name, exactly one visible enabled tab stop, native arrows move to the **adjacent expected action** and skip disabled/hidden actions, existing callbacks/MORE stay green.
- `PuzzleBoard.svelte.test.ts`: many cells but one tab stop, focusin updates active cell, Right/Down + edge behavior through existing native listener, Enter/Space still routes attempts, one-based empty/occupied names.
- `page.svelte.test.ts` in the board slice: update `placeSelectedPieceAt()` to the new one-based empty-cell name so the board commit leaves the route suite green.
- `PuzzlePiece.svelte.test.ts`: supplied `tabIndex`, placed override, Rotate `tabindex=-1`, `aria-keyshortcuts=R`, existing `R` callback.
- `PuzzleInventoryPanel.svelte.test.ts`: one repeated piece tab stop, focusin updates active id, adjacent Left/Right, active-id normalization after filtering/placement, existing filter/shuffle/drawer behavior.
- `ReferenceOverlay.svelte.test.ts`: Escape dismisses and does not bubble; existing Tab trap/restoration stays green.
- puzzle route announcer tests: polite/atomic/outside inert subtree; selection/cancel/accepted/rejected/hint/final completion/pause/resume; Escape selection; existing Undo/Redo.

### Keyboard smoke lane

Add one `@smoke` keyboard core-flow test to `apps/web/e2e/gameplay-interactions.spec.ts`, beside the existing keyboard placement coverage but **not** under an `@a11y` describe. It runs in the normal Chromium desktop/mobile smoke lane only.

On `e2e-square-4`, prove:

1. one visible toolbar action, one board cell, and one repeated inventory piece are tabbable;
2. Tab enters toolbar then board without traversing every toolbar action/cell;
3. toolbar moves to the adjacent expected action; board arrows move spatially; inventory Left/Right moves to the adjacent piece;
4. Enter/Space selects/places through the real session;
5. wrong placement announces rejection;
6. Escape cancels selection;
7. Ctrl+Z/Ctrl+Y still undo/redo;
8. Hint announces its target;
9. existing keyboard helper completes remaining pieces;
10. completion dialog appears and final live text includes `Puzzle complete.`.

### Existing accessibility lane

Keep `apps/web/e2e/gameplay-accessibility.spec.ts` as the axe/accessibility surface. In its current active-gameplay test, add only structural assertions that:

- toolbar has one visible `tabindex="0"` action;
- board has one visible `tabindex="0"` cell;
- inventory has one visible `tabindex="0"` repeated piece;
- `gameplay-announcer` exists with polite live-region semantics.

Do not put the keyboard smoke flow under the `accessibility @a11y` describe; otherwise it implicitly joins the Chromium desktop/tablet + WebKit-mobile accessibility lane even when the implementation task only runs smoke.

## Risks and deliberate limits

- **Viewport crosses toolbar breakpoint while a hidden secondary action is focused:** normal initial layouts and MORE changes are covered; deterministic orientation recovery is deferred by ticket scope.
- **Inventory filter/shuffle removes the active piece:** preserve the active id when possible; otherwise choose selected/first for the next Tab entry. No spatial tray geometry is maintained.
- **Svelte delegated keydown reruns after focus/state mutation:** toolbar and inventory use native listeners; board extends its existing native cell listener. Adjacent-target tests catch double-skip behavior.
- **Route test contract changes with board names:** update `placeSelectedPieceAt()` in the same board task, not later.
- **Live-region noise:** only the explicit table above is announced; internal cleanup retains direct dispatches.
- **Reference Escape double action:** stop propagation in the overlay so one key closes one UI layer.
- **Test-lane leakage:** keyboard smoke lives in `gameplay-interactions.spec.ts`; axe structural checks stay in `gameplay-accessibility.spec.ts`.

## Acceptance mapping

- Keyboard select/place/cancel/undo/redo/complete: existing actions + smoke E2E.
- Large puzzle avoids one Tab stop per piece/cell: roving count assertions are independent of collection size; board test uses a 10×10 case for explicit 100-cell coverage.
- Inventory keyboard reachability: Left/Right traverses every visible piece in `visiblePieces` order; spatial Up/Down is deferred under YAGNI.
- Concise announcements: route tests + representative smoke flow.
- Pointer/touch/keyboard share outcomes: no new domain path; shared events drive placement/hint announcements.
- Accessible names/modal focus: named composites/cells; existing modal systems preserved.
- Focused tests + one keyboard E2E: existing files only.

## Scope summary

HPA-223 is an accessibility behavior pass over existing seams, not an accessibility architecture project. Expected production changes stay in `PuzzleToolbar`, `PuzzleBoard`, `PuzzlePiece`, `PuzzleInventoryPanel`, `ReferenceOverlay`, and the puzzle route. `PuzzleSession` needs no new action, state, event, schema, or persistence work. The revised design intentionally removes inventory column measurement and keeps the new keyboard smoke in the repository's existing interaction lane.