# HPA-223: Practical Keyboard Navigation and Core Announcements — Design

**Linear:** HPA-223  
**Status:** Design for implementation  
**Date:** 2026-08-15

## Context

HPA-223 is the next actionable child of HPA-215. HPA-557 already split the puzzle route into concrete board/inventory/completion components, and the later gameplay UX work has established the current toolbar, mobile tray, inventory filters, completion summary, and persistent Reference behavior.

Current `main` already has the important seams:

- the puzzle route owns the `PuzzleSession` store, global Undo/Redo shortcuts, lifecycle/dialog orchestration, and session events;
- `PuzzleToolbar.svelte` owns the finite toolbar controls;
- `PuzzleBoard.svelte` owns board-cell interaction;
- `PuzzleInventoryPanel.svelte` owns the visible tray while `PuzzlePiece.svelte` owns per-piece selection/rotation;
- dialogs reuse `$lib/actions/modalFocus`;
- persistent Reference is rendered by `PuzzleBoardPanel.svelte`, while `ReferenceOverlay.svelte` already traps/restores focus around its Close button.

The missing work is therefore focus shape and concise feedback, not a new gameplay path. Enter/Space selection and placement already use the same callbacks as pointer/touch, `R` already rotates a focused piece, and Ctrl/Cmd+Z / Ctrl/Cmd+Y already route through the session Undo/Redo handlers.

The current Tab order does not scale because every toolbar action, board cell, visible piece, and per-piece Rotate button is independently tabbable. A large puzzle therefore creates a long sequential navigation path even though the domain already supports practical keyboard actions.

## Goals

1. Make the toolbar one sequential Tab stop with wrapping arrows among currently visible, enabled actions.
2. Make the board one sequential Tab stop with non-wrapping spatial arrows.
3. Make repeated inventory pieces O(1) sequential Tab stops: one active piece root, plus its Rotate button when rotation is enabled; Left/Right moves the active piece through `visiblePieces`.
4. Preserve Enter/Space selection/placement, `R` rotation, visible Rotate-button activation, and existing Undo/Redo shortcuts through existing `PuzzleSession` actions.
5. Expose current piece rotation in the piece accessible name and provide a concise rotation confirmation.
6. Add one route-owned polite live region for selection, accepted/rejected placement, rotation, hint target, explicit pause/resume, and completion.
7. Let Escape end Hold-to-Peek, dismiss persistent Reference, or cancel piece selection with explicit priority in the existing global key handler.
8. Improve board-cell names so an occupied cell identifies the placed piece.
9. Cover the changed components plus one real keyboard gameplay smoke flow.

## Non-goals

- A generic roving-focus library/action/store/controller/context provider.
- High Contrast, Reduce Glow, font-size, motion, or other accessibility preferences.
- Full WCAG certification or manual NVDA/VoiceOver release sign-off.
- Deterministic focus recovery for every future filter, shuffle, viewport/orientation change, modal mutation, or removed item.
- Reworking `modalFocus` or creating a universal dialog system.
- Reordering route DOM so inventory precedes the board.
- Accessibility-specific gameplay state/actions/events/persistence.
- Announcing every arrow move, timer tick, progress update, Undo/Redo mutation, or reference activation.
- Two-dimensional inventory navigation. Left/Right already reaches every visible tray piece; Up/Down can be added later if usage justifies spatial tray navigation.
- Automatically moving board roving focus to a Hint target. The Hint is announced; changing the next board entry point is a separate interaction decision.
- Staging trays, advanced mobile gestures, or HPA-237 work.
- New dependencies, Playwright projects, fixture families, or test frameworks.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Piece select/cancel | `select_piece` / `cancel_selection` | Reuse unchanged |
| Placement | `attempt_placement`; `placement_accepted` / `placement_rejected` | Reuse events for every input mode |
| Rotation | `rotate_piece`; `PuzzlePiece` native `R`; visible Rotate button | Keep both keyboard paths; make only the active piece's Rotate button sequentially tabbable |
| Hint | `use_hint` + `hint_target` | Reuse event for announcement |
| Pause/resume | route lifecycle composition | Keep explicit user-action announcements because HPA-223 requires them |
| Completion | `placement_accepted.completed` + completion dialog | Combine final placement + completion in one message |
| Undo/Redo | route global shortcut owner | Keep unchanged |
| Modal focus | `$lib/actions/modalFocus` | Keep unchanged |
| Persistent Reference | route `handleReferenceToggle()` + existing overlay trap | Handle Escape in the route before the persistent-reference shortcut gate; leave overlay unchanged |
| Toolbar responsive state | CSS + local `moreOpen` | Inspect actual visible buttons with `offsetParent`; no JS breakpoint copy |
| Inventory order/filter | `visiblePieces` | Roving state follows ordered rendered list |
| Native keyboard handling | `PuzzlePiece.interactionAction` / `PuzzleBoard.dropZoneInteraction` | Follow the native-listener pattern locally; do not introduce a shared event-action abstraction |
| Keyboard E2E | `gameplay-interactions.spec.ts` | Add smoke flow beside existing keyboard placement tests |
| Axe/accessibility E2E | `gameplay-accessibility.spec.ts` + `expectLiveRegion()` | Keep accessibility file structural/axe-focused and reuse its helper |
| Fixture completion | `GameplayPage.solveFixture()` | Extend with `skipPlaced` instead of copying the solve loop into a spec |

No new domain state, persisted field, geometry engine, or shared focus abstraction is justified.

## Options considered

### Option A — Component-local roving focus + one route live region (selected)

Toolbar, board, and inventory each own only their ephemeral focus position. The route translates existing outcomes/events into one announcement string.

**Pros**

- matches the HPA-557 ownership boundaries;
- changes no domain/persistence contract;
- keeps pointer/touch/keyboard on the same session actions;
- tests stay in existing component/route/E2E files.

**Cons**

- three components contain small, intentionally different arrow handlers.

That duplication is deliberate:

- toolbar is a wrapping one-dimensional list of visible/enabled actions;
- board is a clamped two-dimensional coordinate grid;
- inventory is a filtered/reordered one-dimensional list.

A configurable roving helper would be configuration rather than reuse.

### Option B — Shared roving-focus helper/action

**Rejected:** it would need wrapping, disabled/visibility filtering, coordinates, active-id recovery, and different DOM lookup rules before there is repeated behavior worth abstracting.

A tiny shared `nativeKeydown` action is also deferred. The existing native actions combine click/coordinate behavior, while HPA-223 adds only two new pure-keydown wrappers. A new cross-component action plus its tests saves too little code to justify another shared seam.

### Option C — Route-level accessibility/focus controller

**Rejected:** it would couple the route to child DOM details and create another presentation-state layer beside `PuzzleSession`.

### Option D — Add two-dimensional inventory geometry now

**Rejected:** Left/Right already makes every visible piece reachable. DOM row measurement and partial-row rules are new layout machinery with no acceptance need in the first pass.

## Focus model

The goal is not one Tab stop for the entire page. Finite native controls such as Back, inventory filters, Shuffle, drawer toggle, and dialog actions remain normal Tab stops. The change targets repeated/composite controls that cause Tab explosion.

After HPA-223:

- toolbar: exactly one currently visible, enabled action has `tabindex="0"`;
- board: exactly one cell has `tabindex="0"`;
- inventory piece roots: exactly one visible piece root has `tabindex="0"`;
- when rotation is enabled, only that same active piece's Rotate button also has `tabindex="0"`; every inactive piece's Rotate button is `-1`;
- open dialogs keep their existing trapped native Tab order.

This gives an inventory at most two repeated-control Tab stops regardless of puzzle size, while preserving a visible keyboard-discoverable Rotate action for sighted keyboard users.

Every composite updates its roving state on `focusin` as well as arrow movement. Existing helpers directly call `.focus()` on cells/pieces that may currently have `tabindex="-1"`; direct focus must make that item the composite's next entry point.

Arrow movement never dispatches gameplay state and never enters the live region.

## Native keydown convention

The repository already uses non-delegated listeners for the piece and board interaction handlers because focus/state changes during a delegated key event can be reprocessed after rerender.

HPA-223 follows that existing pattern locally:

- toolbar root: local Svelte action attaches/removes native `keydown`;
- board cells: extend the native `handleKeyDown` already invoked by `dropZoneInteraction`;
- inventory `.pieces-grid`: local Svelte action attaches/removes native `keydown`.

The wrappers remain local because their navigation semantics differ. Tests assert the exact adjacent destination, not merely that focus changed.

## Toolbar

`PuzzleToolbar.svelte` becomes a concrete named toolbar:

```svelte
<div role="toolbar" aria-label="Puzzle actions" data-testid="puzzle-toolbar">
```

Use a closed local action type:

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
```

Centralize prop-derived availability in a typed derived record rather than a hand-maintained `void prop` dependency list:

```ts
const actionAvailable = $derived<Record<ToolbarAction, boolean>>({
	undo: canUndo,
	redo: canRedo,
	hint: true,
	reference: hasReference && referenceAvailable,
	more: true,
	'zoom-out': true,
	'zoom-in': true,
	fit: true,
	rotation: !rotationToggleDisabled,
	peek: hasReference && referenceAvailable && !referenceToggled,
	pause: canPause,
	setup: canOpenSetup
});
```

`toolbarTabIndex(action)` returns `0` only when the action is both active and available. This prevents a stale active id from leaving `tabindex="0"` on a disabled control.

Every button gets `data-toolbar-action`. `focusin` updates the active action. Native arrow handling queries only controls that are enabled and actually visible (`offsetParent !== null`), then moves to the adjacent control. Left/Up move backward; Right/Down move forward; toolbar navigation wraps.

A local normalization effect reads `actionAvailable` plus `moreOpen`, inspects current live DOM visibility, and chooses the first visible/enabled action when the active id is no longer usable. No breakpoint is copied into TypeScript.

A table-driven component test toggles every current prop that can add/remove/disable an action and reasserts exactly one visible enabled toolbar Tab stop. `Record<ToolbarAction, boolean>` also forces new action IDs to make an explicit availability decision at compile time.

The existing primary/secondary markup, callbacks, and CSS remain. Deterministic focus recovery at the exact instant a viewport crosses the CSS breakpoint remains outside this ticket's orientation guardrail.

## Board

Keep the current visual grid and button semantics. Do not create an ARIA `grid` tree requiring row wrappers solely for semantics.

Name the board as a group:

```svelte
<div role="group" aria-label="Puzzle board" data-testid="puzzle-board">
```

Each drop zone stays `role="button"`, but only one is tabbable. The component owns an ephemeral active `(x, y)`, initialized to `(0, 0)` and reset on puzzle identity change. `focusin` updates the active coordinate.

Arrow behavior is spatial and non-wrapping:

```text
Left  -> x - 1 when available
Right -> x + 1 when available
Up    -> y - 1 when available
Down  -> y + 1 when available
```

At an edge, focus stays on the current cell. Put this branch at the top of the existing native `handleKeyDown`; Enter/Space then continues through `placePiece()` with no UI-side correctness filter.

Cell names become one-based and identify the occupant:

```text
Row 1, column 1, empty
Row 1, column 2, occupied by puzzle piece 7
```

`data-x` / `data-y` stay zero-based and unchanged for gameplay/E2E locators.

The route helper `placeSelectedPieceAt()` currently queries the old name. Update that locator in the same board slice so Task 2 remains independently green.

Hints are announced but do not mutate `activeCell`. Automatically changing the board's next Tab entry point is useful-looking but is a separate focus policy and is deferred.

## Inventory pieces and rotation

`PuzzleInventoryPanel.svelte` owns `activePieceId` because it already owns filtered/reordered `visiblePieces`.

Normalize only when the active id is no longer visible:

1. keep it when still visible;
2. otherwise prefer the selected piece if visible;
3. otherwise choose the first visible piece;
4. use `null` when none are visible.

Do not snap back to the selected piece after every arrow press.

`PuzzlePiece.svelte` gains:

```ts
tabIndex?: 0 | -1;
```

The root defaults to today's `0` for other consumers, while placed pieces always force `-1`. Inventory passes `0` only to `activePieceId`, `-1` to the other visible pieces.

Rotation stays discoverable in two ways:

- the existing root `R` shortcut remains and exposes `aria-keyshortcuts="R"` when rotatable;
- the visible Rotate button receives `tabindex={tabIndex}` instead of a hard-coded `-1`, so only the active piece's Rotate button joins sequential Tab order.

Expose current rotation in the piece name:

```text
Puzzle piece 7, upright
Puzzle piece 7, rotated 90 degrees
```

When rotation mode is off, keep the existing shorter `Puzzle piece 7` name.

The route uses the existing `piece_rotated` dispatch outcome to announce `Puzzle piece {id} rotated.`. No new session event or rotation helper is needed; the updated piece name carries the exact resulting angle.

Name `.pieces-grid` as `role="group" aria-label="Available puzzle pieces"`.

Inventory arrows are intentionally one-dimensional:

```text
ArrowLeft  -> previous item in visiblePieces when one exists
ArrowRight -> next item in visiblePieces when one exists
```

No wrapping, Up/Down, DOM geometry, CSS-variable reads, or partial-row logic.

## Escape behavior

Keep all gameplay Escape priority in the existing route-level `handleWindowKeyDown`.

After the existing `hasSessionModal` gate, handle in this order:

1. if `event.key === 'Escape' && referenceToggled`, prevent default, call existing `handleReferenceToggle()`, return;
2. if Escape and Hold-to-Peek is active, prevent default, call `clearReferenceHold()`, return;
3. if Escape and a piece is selected, prevent default, call the explicit announcing cancel handler, return;
4. then apply the existing persistent-reference gate for all other gameplay shortcuts;
5. then existing Undo/Redo detection.

This ordering removes the race without adding an Escape branch or propagation dependency to `ReferenceOverlay.svelte`. The overlay remains owned/rendered through `PuzzleBoardPanel`; HPA-223 does not modify either component for Escape.

`clearTransientGameplayState()` keeps its direct `cancel_selection` dispatch. Pause/restart/exit cleanup must not speak `Selection canceled.`.

Do not make Escape close compact `MORE`.

## Live announcements

### Ownership and placement

Add one route-local string and direct synchronous assignment:

```ts
let gameplayAnnouncement = $state('');

function announceGameplay(message: string): void {
	gameplayAnnouncement = message;
}
```

Do not clear then restore in a microtask. HPA-223 needs deterministic current status text; repeated identical-message forcing is not an acceptance requirement and can be solved later in one place if real assistive-technology testing demonstrates the need.

Render one atomic polite region as a sibling of `.puzzle-page` and the existing dialogs:

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

It must be outside `.puzzle-page`, which becomes `inert` + `aria-hidden` while session/completion dialogs are open.

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
| successful `rotate_piece` | `Puzzle piece {id} rotated.` |
| non-null `hint_target` | `Hint: puzzle piece {id} goes to row {y+1}, column {x+1}.` |
| explicit user Pause | `Mission paused.` |
| explicit Resume | `Mission resumed.` |

Pause/Resume remain because they are explicit HPA-223 requirements. The pause dialog is useful redundant context, not a reason to silently narrow the ticket. Formal AT timing/certification remains deferred by the issue's non-goals.

Selection/cancel/rotation messages come from existing dispatch outcomes. Placement/hint messages come from `handleSessionEvent`. No new session event/action is added.

Do not separately announce `completion_sealed`: the final `placement_accepted` already carries `completed: true` before sealing.

Do not announce restored/internal lifecycle transitions.

## Data flow

```text
Enter / Space / R / Rotate button / Ctrl(Cmd)+Z/Y / Escape
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

Pointer/touch continue through the same callbacks/session actions, so shared placement/hint/rotation paths provide the same feedback.

## Component boundaries

### `PuzzleToolbar.svelte`

Toolbar role/name, `ToolbarAction`, typed derived availability, one active action, focusin tracking, native wrapping arrows over visible enabled actions.

### `PuzzleBoard.svelte`

One active coordinate, focusin tracking, spatial arrows, one-based empty/occupied-by-piece names. Preserve click/drag/drop/Enter/Space and zero-based data coordinates.

### `PuzzleInventoryPanel.svelte`

One `activePieceId`, focusin tracking, native non-wrapping Left/Right through `visiblePieces`, normalization only when active id disappears.

### `PuzzlePiece.svelte`

Optional `0 | -1` `tabIndex`; active Rotate button shares that roving index; root `R` remains; accessible name exposes rotation.

### Puzzle route

Single direct announcement string/helper; selection/cancel/rotation outcomes; placement/hint events; explicit pause/resume; ordered Escape handling including persistent Reference; existing Undo/Redo unchanged.

### `ReferenceOverlay.svelte` / `PuzzleBoardPanel.svelte`

No HPA-223 change. Existing trap/restoration and Close callback remain; route handles Escape before its persistent-reference shortcut gate.

### E2E support

`GameplayPage.solveFixture({ skipPlaced: true })` extends the existing solver helper for partial progress. `gameplay-accessibility.spec.ts` reuses `expectLiveRegion()`.

## Testing strategy

### Component/route tests

- `PuzzleToolbar.svelte.test.ts`: toolbar role/name; exact adjacent movement; table-driven prop changes pin exactly one visible enabled toolbar Tab stop.
- `PuzzleBoard.svelte.test.ts`: 100 cells but one Tab stop; focusin; Right/Down + edges; Enter/Space; one-based empty and `occupied by puzzle piece N` names.
- `PuzzlePiece.svelte.test.ts`: supplied `tabIndex`; placed forces `-1`; active Rotate button follows `tabIndex`; rotation-aware name; `aria-keyshortcuts=R`; existing `R` and pointer Rotate callbacks.
- `PuzzleInventoryPanel.svelte.test.ts`: one active piece root, no inactive Rotate button in Tab order, exact Left/Right, focusin, active-id normalization.
- puzzle route test: announcer role/polite/atomic/outside inert subtree; select/cancel/accepted/rejected/rotation/hint/pause/resume/final completion; persistent Reference Escape, Hold priority, selection Escape; existing Undo/Redo.
- `ReferenceOverlay.svelte.test.ts`: unchanged.

### Keyboard smoke

Add one `@smoke` flow to `gameplay-interactions.spec.ts`, outside the `@webkit-critical` describe. Prove logical Tab shape, exact arrows, selection/rejection/Escape, rotation visibility/state, accepted placement, Undo/Redo, Hint, and completion.

Extend `GameplayPage.solveFixture()` with `skipPlaced` and reuse it instead of copying the fixture loop.

### Accessibility scan lane

Keep `gameplay-accessibility.spec.ts` as axe/structural coverage. Add tab-stop counts and call existing `expectLiveRegion(page.getByTestId('gameplay-announcer'), 'polite')`; do not hand-roll the helper or add `@smoke` to the `@a11y` describe.

## Risks and deliberate limits

- **Repeated identical live text:** direct assignment does not force a mutation when the exact same text is already present. That is not in current acceptance; if manual AT testing later proves it matters, fix the single announcer seam with an evidence-backed technique.
- **Pause/Resume AT timing:** the dialog and status region provide redundant semantics. Automated coverage verifies DOM/status behavior; formal AT certification remains deferred.
- **Viewport crossing toolbar breakpoint while a hidden secondary action is focused:** initial layouts and prop/MORE changes are covered; deterministic orientation recovery is deferred.
- **Inventory filtering/shuffle:** retain active id when possible; otherwise choose selected/first for the next entry. Do not force-focus replacement nodes after every mutation.
- **Rotation mode:** current angle is exposed in the active piece name; the visible active Rotate control remains keyboard reachable; `R` remains an additional shortcut.

## Acceptance mapping

- Keyboard select/place/cancel/undo/redo/complete: existing session actions + smoke.
- Large puzzle avoids one Tab stop per piece/cell: toolbar/board/piece roving; active Rotate adds at most one extra inventory Tab stop, independent of piece count.
- Selection, placement, rotation, hint, pause/resume, completion feedback: one route status region over existing outcomes/events.
- Pointer/touch/keyboard share outcomes: no new domain path.
- Accessible names/modal behavior: named composites; piece rotation; occupant-identifying cells; existing modal systems preserved.
- Focused tests + one keyboard E2E: existing test infrastructure only.

## Scope summary

HPA-223 remains an accessibility behavior pass over existing seams, not an accessibility architecture project. Expected production changes stay in `PuzzleToolbar`, `PuzzleBoard`, `PuzzlePiece`, `PuzzleInventoryPanel`, and the puzzle route. `ReferenceOverlay`, `PuzzleBoardPanel`, `PuzzleSession`, persistence, API/shared types, and dependencies remain unchanged.