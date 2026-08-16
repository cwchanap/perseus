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
- `PuzzleInventoryPanel.svelte` owns the visible tray while `PuzzlePiece.svelte` owns per-piece keyboard selection/rotation;
- dialogs reuse `$lib/actions/modalFocus`;
- persistent Reference is already a modal-like overlay with focus trapping and restoration.

The accessibility problem is therefore mostly DOM focus shape, not missing gameplay behavior. Enter/Space selection and placement already dispatch the same session actions as pointer/touch, `R` already rotates a focused piece, and Ctrl/Cmd+Z / Ctrl/Cmd+Y already route through the existing session Undo/Redo handlers.

The current tab order does not scale:

- every toolbar button is independently tabbable;
- every board cell has `tabindex="0"`;
- every visible puzzle piece has `tabindex="0"`;
- when rotation is enabled, each piece also renders its own tabbable Rotate button.

A 100-piece puzzle therefore creates a long, noisy Tab sequence even though the domain already supports concise keyboard actions.

## Goals

1. Make the toolbar one Tab stop with arrow-key movement among its currently visible, enabled actions.
2. Make the board one Tab stop with arrow-key movement by row/column.
3. Make the repeated inventory pieces one Tab stop with arrow-key movement through the rendered tray grid.
4. Preserve Enter/Space selection/placement, `R` rotation, and existing Undo/Redo shortcuts through the same `PuzzleSession` actions used today.
5. Add one route-owned polite live region for selection, accepted/rejected placement, hint target, pause/resume, and completion.
6. Let Escape cancel an explicit piece selection or close temporary/reference UI without introducing a new interaction state.
7. Improve concise accessible names for board cells and composite regions.
8. Cover the changed component behavior plus one real keyboard gameplay flow.

## Non-goals

- A generic roving-focus library, action, store, controller, context provider, or focus manager.
- High Contrast, Reduce Glow, font-size, motion, or other accessibility preferences.
- Full WCAG certification or manual NVDA/VoiceOver release sign-off.
- Deterministic focus recovery for every future filter, shuffle, viewport/orientation change, modal mutation, or removed item.
- Reworking `modalFocus`, replacing Reference's existing focus trap, or creating one universal dialog system.
- Reordering the route DOM to make inventory precede the board.
- A keyboard-only gameplay state path or accessibility-specific session actions.
- Announcing every arrow-key focus move, timer tick, progress update, Undo/Redo mutation, or reference activation.
- Staging trays, advanced mobile gestures, or any HPA-237 work.
- New dependencies, Playwright projects, fixture families, or accessibility test frameworks.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Piece selection/cancel | `select_piece` / `cancel_selection` | Reuse unchanged |
| Placement | `attempt_placement` and `placement_accepted` / `placement_rejected` events | Reuse unchanged for every input mode |
| Rotation | `rotate_piece`; `PuzzlePiece` already handles `R` | Reuse; remove per-piece Rotate buttons from the Tab sequence |
| Hint | `use_hint` and `hint_target` event | Reuse event for announcement text |
| Pause/resume | route lifecycle composition | Announce only explicit user pause/resume paths |
| Completion | `placement_accepted.completed` + existing completion dialog | Announce final accepted placement as completion; keep dialog behavior unchanged |
| Undo/Redo | route global Ctrl/Cmd shortcuts | Keep unchanged |
| Modal focus | `$lib/actions/modalFocus` | Keep unchanged |
| Persistent reference focus | `ReferenceOverlay.svelte` | Keep trap/restoration; add Escape dismissal only |
| Toolbar responsive state | existing CSS + local `moreOpen` | Roving logic inspects rendered/visible buttons; no JS breakpoint model |
| Inventory order/filter | `visiblePieces` in `PuzzleInventoryPanel` | Roving index follows the already-derived rendered list |
| E2E infrastructure | `gameplay-accessibility.spec.ts` + `GameplayPage` fixture helpers | Extend existing test; no new harness |

No new domain state, persisted field, store, service, or shared focus abstraction is justified.

## Options considered

### Option A — Component-local composite focus + one route live region (selected)

Each concrete UI owner manages only its own roving Tab stop. The route translates existing session outcomes/events into one polite announcement string.

**Pros**

- matches the HPA-557 component boundaries;
- keeps focus state ephemeral and presentation-local;
- uses existing session actions/events as the behavior source of truth;
- changes no persistence/API/domain contract;
- easy to test component by component;
- small enough to remove later if the UI is redesigned.

**Cons**

- toolbar, board, and inventory each contain a small amount of local arrow-key code because their navigation rules differ.

That duplication is intentional: toolbar movement is a one-dimensional list of visible enabled actions, board movement is a fixed coordinate grid, and inventory movement is a filtered/reordered responsive grid. A generic helper would need configuration for three different semantics before there is a second consumer of any one semantic.

### Option B — Shared roving-focus action/helper

Create a reusable `$lib/actions/rovingFocus` with orientation, wrapping, disabled filtering, responsive columns, active-id recovery, and callbacks.

**Rejected:** it converts three short, different interaction rules into a configurable mini-framework. HPA-223 does not have enough repeated behavior to justify that abstraction.

### Option C — Route-level accessibility/focus controller

The route would track active toolbar action, inventory piece, board cell, announcements, and focus restoration across child components.

**Rejected:** it breaks the concrete ownership created by HPA-557, couples the route to child DOM details, and creates another presentation state layer beside `PuzzleSession`.

## Focus model

The goal is not “only four focusable elements on the whole page.” Native finite controls such as the Back link, inventory filter buttons, drawer toggle, and dialog actions remain ordinary Tab stops. The change targets repeated/composite controls that cause Tab explosion.

After HPA-223:

- toolbar: exactly one currently visible, enabled toolbar action has `tabindex="0"`;
- board: exactly one board cell has `tabindex="0"`;
- inventory pieces: exactly one visible piece root has `tabindex="0"`;
- per-piece Rotate buttons remain clickable/tappable but use `tabindex="-1"`; keyboard rotation stays on the focused piece via `R`;
- open dialogs retain their existing trapped native Tab order.

Arrow movement never dispatches gameplay state and never enters the live region. It only moves DOM focus and updates component-local roving state.

## Toolbar

`PuzzleToolbar.svelte` becomes a concrete toolbar:

```svelte
<div
	role="toolbar"
	aria-label="Puzzle actions"
	data-testid="puzzle-toolbar"
	class="puzzle-toolbar"
>
```

Keep one local active action key, initially `hint` because Hint is present and enabled during the normal active gameplay surface even when Undo/Redo are disabled.

Every toolbar button receives a stable `data-toolbar-action` and a roving `tabindex`. `focusin` updates the active key. Arrow handling queries only buttons that are both enabled and actually rendered by CSS (`offsetParent !== null`), then focuses the previous/next item. This naturally skips disabled Undo/Redo and compact secondary actions while `MORE` is closed without copying the `1024px` breakpoint into TypeScript.

The existing `moreOpen` state and responsive markup remain unchanged. No focus trap, outside-click behavior, or generic menu model is added.

If a prop change removes/disables the current active action, a small component-local normalization step chooses the first visible enabled action after the DOM update. HPA-223 does not promise special focus restoration when the viewport changes breakpoint while focus is already inside an action that CSS subsequently hides.

## Board

`PuzzleBoard.svelte` keeps the existing visual grid and button semantics. Do not force a new ARIA `grid` tree that would require row wrappers solely for semantics.

The board container becomes a named group:

```svelte
<div role="group" aria-label="Puzzle board" data-testid="puzzle-board">
```

Each existing drop zone remains `role="button"` but only one cell is in the Tab sequence. The component owns an ephemeral active coordinate initialized to `(0, 0)` and reset when puzzle identity changes.

Arrow behavior is spatial and does not wrap:

```text
ArrowLeft  -> x - 1, clamped at 0
ArrowRight -> x + 1, clamped at gridCols - 1
ArrowUp    -> y - 1, clamped at 0
ArrowDown  -> y + 1, clamped at gridRows - 1
```

Enter/Space continues through the existing `placePiece()` path. There is no UI-side correctness check.

Cell names become one-based and status-oriented rather than exposing zero-based implementation coordinates:

```text
Row 1, column 1, empty
Row 1, column 2, occupied
```

The name changes only presentation/tests; `data-x` and `data-y` remain zero-based and unchanged for gameplay code and E2E locators.

## Inventory pieces

`PuzzleInventoryPanel.svelte` owns roving state because it already owns the filtered/reordered `visiblePieces` list.

Add a local `activePieceId`. Normalize only when the current active id is no longer visible:

1. retain the current active id when it still exists;
2. otherwise prefer the selected piece if that piece is visible;
3. otherwise use the first visible piece;
4. use `null` for an empty filtered tray.

This intentionally does not keep snapping focus back to the selected piece after every arrow press.

`PuzzlePiece.svelte` gains one optional presentation prop:

```ts
tabIndex?: number;
```

Its root uses the supplied value for an unplaced piece and defaults to the current `0` behavior for other consumers. The inventory passes `0` only for `activePieceId` and `-1` for every other visible piece.

The existing per-piece Rotate button becomes `tabindex="-1"`. Pointer/touch rotation remains unchanged; keyboard rotation remains the existing `R` handler on the piece root. Add `aria-keyshortcuts="R"` while rotation is enabled so the keyboard affordance is exposed without creating a second Tab stop per piece.

The pieces grid is named as a group (`aria-label="Available puzzle pieces"`). Header actions, All/Corners/Edges/Center/Shuffle, Cancel, and the drawer toggle remain native finite controls.

### Inventory arrow geometry

Left/Right move by one item in `visiblePieces` order.

Up/Down move by the current rendered column count. The panel can derive that count from the rendered `.piece-slot` row geometry or the computed grid tracks; it should inspect the actual DOM rather than duplicating responsive CSS constants in TypeScript. Movement clamps to the first/last valid visible item rather than wrapping.

Component tests should prove the deterministic left/right behavior and active-id normalization. The real 390×844/desktop rendered grid can prove a vertical move in the existing Playwright environment.

## Escape behavior

Escape remains a route-level gameplay shortcut because selection/reference state belongs to the route/session composition.

When no session modal is open:

1. if Hold-to-Peek is active, Escape ends the existing hold via `clearReferenceHold()`;
2. otherwise, if a piece is selected, Escape dispatches the existing `cancel_selection` action;
3. otherwise it does nothing.

Persistent Reference is already a modal-like overlay and the route deliberately blocks gameplay shortcuts while it is toggled. `ReferenceOverlay.svelte` therefore handles Escape locally alongside its existing Tab trap and calls the existing `onDismiss` callback. It does not add another focus system.

Do not add Escape behavior for the compact `MORE` disclosure in this ticket; HPA-217 intentionally left that simple and HPA-223 does not need to turn it into a menu framework.

## Live announcements

### Ownership and DOM placement

Add exactly one route-local state value:

```ts
let gameplayAnnouncement = $state('');
```

and one tiny helper that clears before setting the next message in a microtask so repeating the same semantic message can produce a fresh live-region mutation:

```ts
function announceGameplay(message: string): void {
	gameplayAnnouncement = '';
	queueMicrotask(() => {
		gameplayAnnouncement = message;
	});
}
```

Render one atomic polite region:

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

**The region must be a sibling after/outside `.puzzle-page`, not inside it.** The route currently sets both `inert` and `aria-hidden` on `.puzzle-page` whenever setup/pause/exit/completion UI is open. A live region inside that subtree would be unavailable exactly when pause/resume/completion messages need to be announced.

The announcer itself never receives focus and is not persisted.

### Message sources

Use existing session outcomes/events rather than inferring success from DOM changes.

| Event/action | Announcement |
| --- | --- |
| successful explicit `select_piece` | `Puzzle piece {id} selected.` |
| explicit cancel | `Selection canceled.` |
| `placement_accepted`, not complete | `Puzzle piece {id} placed.` |
| `placement_accepted`, complete | `Puzzle piece {id} placed. Puzzle complete.` |
| `placement_rejected: wrong_slot` | `Puzzle piece {id} does not fit there.` |
| `placement_rejected: non_upright` | `Puzzle piece {id} must be upright.` |
| non-null `hint_target` | `Hint: puzzle piece {id} goes to row {y+1}, column {x+1}.` |
| explicit toolbar/user pause | `Mission paused.` |
| explicit Resume action | `Mission resumed.` |

Do not separately announce `completion_sealed`: `PuzzleSession` emits `placement_accepted` with `completed: true` before sealing the completion, so the final accepted-placement message can include completion without two competing live updates.

Do not announce internal/restored lifecycle transitions. A restored active session is intentionally paused on route entry and already presents a `Resume Mission` dialog; treating that orchestration as a new user pause would be noisy.

Do not announce arrow movement. Focus and each control's accessible name already communicate the focused object.

## Accessible names and shortcuts

Keep existing useful control names (`Undo`, `Redo`, `Hint`, `Toggle reference`, `Hold to peek reference`, `Pause mission`, and so on).

Add/adjust only where the repeated composite semantics need clarity:

- toolbar: `role="toolbar"`, `aria-label="Puzzle actions"`;
- board container: `role="group"`, `aria-label="Puzzle board"`;
- board cells: `Row N, column M, empty|occupied`;
- inventory pieces group: `aria-label="Available puzzle pieces"`;
- focused rotatable piece: existing `Puzzle piece {id}` plus `aria-keyshortcuts="R"`.

Selection continues to use `aria-pressed`/`aria-grabbed`; no duplicated “selected” text is required in the accessible name.

## Data flow

```text
Toolbar / Inventory / Board keyboard input
        |
        | Enter / Space / R / Ctrl(Cmd)+Z/Y / Escape
        v
existing route callbacks or PuzzlePiece handler
        |
        v
PuzzleSession.dispatch(existing action)
        |
        +--> canonical state/outcome
        |
        +--> existing session event ----------------------+
                                                         |
                                                         v
                                               route announceGameplay()
                                                         |
                                                         v
                                           one polite live region

Arrow keys
   |
   +--> component-local roving focus only
        (no PuzzleSession dispatch, no announcement)
```

Pointer and touch continue using the same existing callbacks/session actions, so the announcement layer automatically covers accepted/rejected placements and hints regardless of input method.

## Component boundaries

### `PuzzleToolbar.svelte`

- add toolbar semantics;
- keep one local active action key;
- make buttons roving Tab stops;
- arrows traverse visible enabled toolbar buttons;
- preserve `moreOpen`, callbacks, and responsive CSS.

### `PuzzleBoard.svelte`

- own one active board coordinate;
- rove Tab through cells with non-wrapping spatial arrows;
- improve cell names;
- preserve click, drag/drop, Enter/Space, `data-x`, and `data-y` behavior.

### `PuzzleInventoryPanel.svelte`

- own `activePieceId` for `visiblePieces`;
- arrows move through the rendered piece grid;
- normalize a removed/filtered active id without a focus-recovery framework;
- pass roving `tabIndex` to `PuzzlePiece`.

### `PuzzlePiece.svelte`

- accept optional `tabIndex`;
- keep `R` rotation;
- expose `aria-keyshortcuts="R"` while rotatable;
- remove the pointer Rotate button from normal Tab order.

### Puzzle route

- own the single announcement string/helper;
- translate explicit selection/cancel outcomes and existing placement/hint events into messages;
- announce explicit user pause/resume;
- add Escape cancellation for Hold/selection;
- render live region outside the inert gameplay subtree;
- keep global Undo/Redo behavior unchanged.

### `ReferenceOverlay.svelte`

- extend the existing local keydown handler with Escape -> `onDismiss`;
- preserve its existing focus capture/trap/restoration.

## Testing strategy

### Component tests

`PuzzleToolbar.svelte.test.ts`:

- one visible enabled toolbar button has `tabindex="0"`;
- toolbar role/name are present;
- arrow navigation moves focus and skips disabled/hidden actions;
- existing callbacks and MORE behavior remain valid.

`PuzzleBoard.svelte.test.ts`:

- N cells render but only one has `tabindex="0"`;
- Right/Down move focus to the expected coordinate;
- edge arrows clamp;
- Enter/Space still route every selected placement attempt to `onPiecePlaced`;
- names are one-based and report empty/occupied.

`PuzzlePiece.svelte.test.ts` / `PuzzleInventoryPanel.svelte.test.ts`:

- supplied `tabIndex` is honored;
- per-piece Rotate is not an additional Tab stop and `R` still rotates;
- one visible piece is tabbable;
- Left/Right move focus through current visible order;
- filtering/removing the active piece normalizes the roving id;
- existing selection/filter/shuffle/drawer behavior remains unchanged.

`ReferenceOverlay.svelte.test.ts`:

- Escape dismisses a persistent overlay;
- existing Tab trap and focus restoration remain covered.

Puzzle route tests:

- announcer is polite/atomic and outside the inert page subtree;
- explicit selection/cancel messages;
- accepted/rejected/hint messages from real session events;
- final placement includes `Puzzle complete` once;
- toolbar pause and Resume messages;
- Escape cancels a selected piece;
- Ctrl/Cmd Undo/Redo remain unchanged.

### One real keyboard E2E

Extend `apps/web/e2e/gameplay-accessibility.spec.ts`; do not create a new spec/harness. Give the new test `@smoke` in its title while it remains under the existing `@a11y` describe block, so the same test participates in the automatic Chromium smoke lane and the broader manual accessibility lane.

On `e2e-square-4`, prove:

1. one visible toolbar action, one board cell, and one repeated inventory piece are tabbable;
2. Tab reaches the toolbar and then the board without visiting every toolbar button/cell;
3. a toolbar arrow and board arrow move focus;
4. inventory arrow navigation changes the active piece;
5. Enter/Space selects and attempts placement through the real session;
6. a wrong placement produces the rejection announcement;
7. Escape cancels selection;
8. Ctrl+Z/Ctrl+Y still undo/redo an accepted placement;
9. Hint produces a concise target announcement;
10. the remaining pieces complete through existing keyboard helpers;
11. the completion dialog appears and the live region contains the final completion message.

Do not emulate CSS layout in component tests or add a second E2E fixture family.

## Risks and deliberate limits

### Active toolbar item hidden by a later viewport breakpoint change

Normal initial desktop/mobile rendering and MORE disclosure are covered. Deterministic recovery for a focused secondary action while the viewport crosses the CSS breakpoint is explicitly outside HPA-223's guardrail on orientation/focus recovery. Do not add a resize focus manager solely for this case.

### Inventory grid column changes

Read actual rendered geometry/tracks at key time. Do not mirror media-query breakpoints or piece-size formulas in TypeScript.

### Filter/shuffle removes or moves the active item

Preserve the active piece by id when it is still visible; otherwise choose selected/first visible for the next Tab entry. Do not force-focus a replacement node after every mutation.

### Live-region noise

Only announce user-meaningful state transitions listed above. Focus movement itself supplies cell/action names; no arrow announcement is needed.

## Acceptance mapping

- Keyboard select/place/cancel/undo/redo/complete: existing session actions plus the E2E flow.
- No one Tab stop per piece/cell: component + E2E tabindex-count assertions.
- Selection/placement/hint/pause/resume/completion announcements: route tests + E2E representative flow.
- Same pointer/touch/keyboard outcomes: no new domain action path; placement/hint announcements come from shared session events.
- Accessible names/modal behavior: concise region/cell names; existing `modalFocus` and Reference trap retained.
- Focused tests + one keyboard E2E: existing component/route suites plus one extension to `gameplay-accessibility.spec.ts`.

## Scope summary

This is an accessibility behavior pass over existing seams, not an accessibility architecture project. The expected production changes stay in the toolbar, board, inventory/piece, Reference overlay, and puzzle route. `PuzzleSession` itself needs no new action, state, event, persistence field, or schema change.