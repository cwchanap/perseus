# HPA-223 Practical Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the core puzzle flow practical with a keyboard by replacing repeated Tab stops with component-local roving focus and adding one route-owned polite announcer, while reusing the existing `PuzzleSession` actions/events and modal focus behavior.

**Architecture:** `PuzzleToolbar`, `PuzzleBoard`, and `PuzzleInventoryPanel` each own only their ephemeral roving focus. `PuzzlePiece` accepts a presentation-only `tabIndex` and keeps `R` rotation. The puzzle route remains the gameplay composition root: it keeps global shortcuts and translates existing selection outcomes plus placement/hint events into one live region rendered outside the route's inert gameplay subtree. Persistent Reference keeps its existing local focus trap and only gains Escape dismissal.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-hpa-223-practical-keyboard-navigation-design.md`.
- Keep `PuzzleSession` as the only canonical gameplay state owner. Do not add accessibility session state, actions, events, persistence fields, or schema changes.
- No generic roving-focus action/helper, focus store/controller, context provider, command registry, or accessibility framework.
- Keep pointer/touch/click/drag paths unchanged; keyboard must call the same existing callbacks/session actions.
- Keep inventory filters, shuffle, drawer behavior, responsive toolbar behavior, zoom/pan, and dialog ownership unchanged.
- Keep existing `modalFocus` and Reference focus restoration. Only add Escape dismissal to the persistent Reference overlay.
- Do not announce arrow movement, timer updates, every lifecycle transition, or Undo/Redo.
- Do not turn broad cross-browser/manual screen-reader certification into this ticket's gate.
- No backward-compatibility layer: this is a pre-release DOM/accessibility contract change, so update current tests directly.

---

## Task 1: Make `PuzzleToolbar` one roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Produces:** a named toolbar where exactly one currently visible/enabled action participates in sequential Tab navigation, while arrow keys move among the actual rendered actions.

- [ ] **Step 1: Add failing toolbar semantics/tab-stop tests**

Extend the existing toolbar test defaults; do not create another test component. Add assertions equivalent to:

```ts
it('exposes one visible enabled toolbar tab stop and toolbar semantics', async () => {
	render(PuzzleToolbar, baseProps({ canUndo: false, canRedo: false }));

	const toolbar = await page.getByTestId('puzzle-toolbar').element();
	expect(toolbar.getAttribute('role')).toBe('toolbar');
	expect(toolbar.getAttribute('aria-label')).toBe('Puzzle actions');

	const tabbable = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')).filter(
		(button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0
	);
	expect(tabbable).toHaveLength(1);
});
```

Add a focus-movement test that focuses the current tab stop, dispatches `ArrowRight`, and verifies focus moves to another visible enabled `[data-toolbar-action]`. Include a disabled Undo/Redo case so arrow traversal cannot land on disabled controls.

Run and verify red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

Expected: toolbar role/name and roving tabindex assertions fail on current markup.

- [ ] **Step 2: Add toolbar-local roving state**

Keep the implementation in `PuzzleToolbar.svelte`; do not extract an action/helper.

Use a stable action id on every toolbar button and keep one local active id. `hint` is a safe initial id because it is visible on desktop/compact and is not disabled by the normal Undo/Redo history state.

```ts
let toolbarElement = $state<HTMLElement | null>(null);
let activeToolbarAction = $state('hint');

function visibleEnabledToolbarButtons(): HTMLButtonElement[] {
	if (!toolbarElement) return [];
	return Array.from(
		toolbarElement.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
	).filter((button) => !button.disabled && button.offsetParent !== null);
}

function toolbarTabIndex(action: string): 0 | -1 {
	return activeToolbarAction === action ? 0 : -1;
}

function handleToolbarFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const button = target.closest<HTMLButtonElement>('[data-toolbar-action]');
	const action = button?.dataset.toolbarAction;
	if (action) activeToolbarAction = action;
}
```

Add a small normalization function for prop/`moreOpen` changes. It may inspect the DOM after the update and choose the first visible enabled button if the active id disappeared or became disabled. Do not add a JS copy of the 1024px breakpoint.

- [ ] **Step 3: Add arrow traversal over actual visible buttons**

```ts
function handleToolbarKeyDown(event: KeyboardEvent): void {
	if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;

	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const current = target.closest<HTMLButtonElement>('[data-toolbar-action]');
	if (!current) return;

	const items = visibleEnabledToolbarButtons();
	const index = items.indexOf(current);
	if (index < 0 || items.length < 2) return;

	event.preventDefault();
	const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
	const next = items[(index + delta + items.length) % items.length]!;
	activeToolbarAction = next.dataset.toolbarAction ?? activeToolbarAction;
	next.focus();
}
```

Bind the root and add semantics/events:

```svelte
<div
	bind:this={toolbarElement}
	role="toolbar"
	aria-label="Puzzle actions"
	data-testid="puzzle-toolbar"
	onfocusin={handleToolbarFocusIn}
	onkeydown={handleToolbarKeyDown}
	class="puzzle-toolbar"
>
```

Give every toolbar button a stable id such as `undo`, `redo`, `hint`, `reference`, `more`, `zoom-out`, `zoom-in`, `fit`, `rotation`, `peek`, `pause`, `setup`:

```svelte
<button
	data-toolbar-action="hint"
	tabindex={toolbarTabIndex('hint')}
	...
>
```

Do not change callbacks, `aria-pressed`, `aria-describedby`, `moreOpen`, the compact secondary panel, or responsive CSS.

- [ ] **Step 4: Verify toolbar behavior**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
bun run check
```

Also preserve existing tests for MORE disclosure, Reference/Peek, disabled states, rotation state, and callbacks.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/PuzzleToolbar.svelte \
  apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
git commit -m "a11y(web): add roving puzzle toolbar focus"
```

---

## Task 2: Make board cells one spatial roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`

**Produces:** every board cell remains a keyboard/pointer placement target, but only one cell is tabbable and arrows move spatially without dispatching gameplay actions.

- [ ] **Step 1: Update tests for the intended cell contract**

Add failing tests that a 3x3 board renders nine cells but one tab stop:

```ts
const board = await page.getByTestId('puzzle-board').element();
const cells = Array.from(board.querySelectorAll<HTMLElement>('[data-testid="drop-zone"]'));
expect(cells).toHaveLength(9);
expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
```

Add Right/Down navigation from `(0,0)` and a boundary test that Left/Up at `(0,0)` does not wrap. Assert the focused target with existing `data-x` / `data-y` rather than coupling the test to CSS.

Update old accessible-name queries from zero-based `Drop zone at position 1, 0` to the new one-based/status names, for example:

```ts
page.getByRole('button', { name: 'Row 1, column 2, empty' });
```

Add one occupied-name assertion after providing a placed piece.

Keep the existing test that a selected piece's wrong cell still calls `onPiecePlaced`; the board must not start validating correctness.

Run and verify red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

- [ ] **Step 2: Add board-local active coordinate**

In `PuzzleBoard.svelte`:

```ts
let boardElement = $state<HTMLElement | null>(null);
let activeCell = $state({ x: 0, y: 0 });
const puzzleIdentity = $derived(puzzle.id);

$effect(() => {
	void puzzleIdentity;
	activeCell = { x: 0, y: 0 };
});

function cellTabIndex(x: number, y: number): 0 | -1 {
	return activeCell.x === x && activeCell.y === y ? 0 : -1;
}
```

Reset only on puzzle identity. Do not tie the active coordinate to placement history or selection state.

- [ ] **Step 3: Handle spatial arrows before placement keys**

Add a helper local to this component:

```ts
function moveCellFocus(event: KeyboardEvent, x: number, y: number): boolean {
	const deltas: Record<string, { dx: number; dy: number }> = {
		ArrowLeft: { dx: -1, dy: 0 },
		ArrowRight: { dx: 1, dy: 0 },
		ArrowUp: { dx: 0, dy: -1 },
		ArrowDown: { dx: 0, dy: 1 }
	};
	const delta = deltas[event.key];
	if (!delta) return false;

	event.preventDefault();
	const nextX = Math.max(0, Math.min(puzzle.gridCols - 1, x + delta.dx));
	const nextY = Math.max(0, Math.min(puzzle.gridRows - 1, y + delta.dy));
	activeCell = { x: nextX, y: nextY };
	boardElement
		?.querySelector<HTMLElement>(
			`[data-testid="drop-zone"][data-x="${nextX}"][data-y="${nextY}"]`
		)
		?.focus();
	return true;
}
```

At the start of the existing `handleKeyDown`:

```ts
if (moveCellFocus(event, x, y)) return;
```

Then keep the current Enter/Space + selected-piece placement path unchanged.

- [ ] **Step 4: Add group semantics, roving tabindex, and concise names**

Bind/name the board root without creating ARIA row wrappers:

```svelte
<div
	bind:this={boardElement}
	role="group"
	aria-label="Puzzle board"
	...
>
```

Keep each drop zone `role="button"`, `data-x`, `data-y`, click, keydown, drag/drop, and pointer behavior. Replace only its tabindex/name:

```svelte
tabindex={cellTabIndex(x, y)}
aria-label={`Row ${y + 1}, column ${x + 1}, ${placedPiece ? 'occupied' : 'empty'}`}
```

Do not add `role="grid"` without row ownership just to satisfy a naming convention; the spatial keyboard behavior is the product requirement.

- [ ] **Step 5: Verify board behavior**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/components/PuzzleBoard.svelte \
  apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
git commit -m "a11y(web): add roving puzzle board navigation"
```

---

## Task 3: Make inventory pieces one roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Produces:** the bounded inventory header/tools stay native Tab stops, while the repeated visible pieces contribute one Tab stop total; arrow keys move through current visible tray order and `R` stays the keyboard rotation command.

- [ ] **Step 1: Add failing `PuzzlePiece` tab-index/rotation tests**

In the existing `PuzzlePiece` tests, add:

```ts
it('honors a supplied roving tab index', async () => {
	render(PuzzlePiece, { ...baseProps(), tabIndex: -1 });
	await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '-1');
});
```

When rotation is enabled, assert:

- the piece root exposes `aria-keyshortcuts="R"`;
- the visible `Rotate piece ...` button has `tabindex="-1"`;
- dispatching `R` on the piece root still calls the existing `onRotate` callback.

Run the focused test and verify red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

- [ ] **Step 2: Add the presentation-only `tabIndex` prop**

In `PuzzlePiece.svelte`:

```ts
interface Props {
	// existing props...
	tabIndex?: number;
}

let {
	// existing props...
	tabIndex = 0
}: Props = $props();
```

Update only focus metadata:

```svelte
<button
	...
	tabindex="-1"
	aria-label="Rotate piece {piece.id}"
>
```

```svelte
<div
	...
	tabindex={isPlaced ? -1 : tabIndex}
	aria-keyshortcuts={rotationEnabled && !isPlaced ? 'R' : undefined}
>
```

Do not remove the pointer Rotate button and do not change `handleKeyDown`; keyboard rotation still dispatches through the existing `R` branch.

- [ ] **Step 3: Add failing inventory roving tests**

In `PuzzleInventoryPanel.svelte.test.ts`, add a test with at least three visible pieces (use `filterPuzzle` rather than creating another puzzle fixture). Assert exactly one visible `[data-testid="puzzle-piece"]` has `tabIndex === 0`.

Focus that piece, send `ArrowRight`, and assert focus moves to the next piece in the panel's current `visiblePieces` order. Then rerender with a filter or placed-piece set that removes the active piece and assert the remaining visible set again has exactly one tab stop.

Keep existing tests for tray order, filter values, shuffle, drawer state, Cancel, rejected/hinted precedence, and rotations.

Run and verify red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

- [ ] **Step 4: Add panel-local active-piece normalization**

In `PuzzleInventoryPanel.svelte`:

```ts
let piecesGridElement = $state<HTMLElement | null>(null);
let activePieceId = $state<number | null>(null);

$effect(() => {
	const ids = visiblePieces.map((piece) => piece.id);
	if (activePieceId !== null && ids.includes(activePieceId)) return;
	activePieceId =
		selectedPieceId !== null && ids.includes(selectedPieceId)
			? selectedPieceId
			: (ids[0] ?? null);
});
```

The first guard is important: after a piece is selected, arrow movement must remain free to move away from that selected id. Do not write an effect that unconditionally assigns `selectedPieceId` on every active-id update.

Add focus tracking at the pieces-grid owner:

```ts
function handlePiecesFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const piece = target.closest<HTMLElement>('[data-testid="puzzle-piece"]');
	const id = Number(piece?.dataset.pieceId);
	if (Number.isInteger(id)) activePieceId = id;
}
```

- [ ] **Step 5: Compute vertical movement from rendered geometry**

Do not copy responsive breakpoints or `--piece-slot-size` formulas into TypeScript.

```ts
function renderedColumnCount(): number {
	if (!piecesGridElement) return 1;
	const slots = Array.from(piecesGridElement.querySelectorAll<HTMLElement>('.piece-slot'));
	if (slots.length <= 1) return 1;

	const firstTop = slots[0]!.getBoundingClientRect().top;
	const nextRow = slots.findIndex(
		(slot, index) => index > 0 && Math.abs(slot.getBoundingClientRect().top - firstTop) > 1
	);
	return nextRow === -1 ? slots.length : nextRow;
}
```

Handle arrows on the `.pieces-grid` bubble phase. Left/Right use `-1/+1`; Up/Down use `-columns/+columns`; clamp to the first/last visible item. Ignore all other keys so `PuzzlePiece` keeps owning Enter/Space/R.

Programmatically focus the next piece root and update `activePieceId`. Do not announce the move.

- [ ] **Step 6: Wire group semantics and roving `PuzzlePiece` props**

```svelte
<div
	bind:this={piecesGridElement}
	class="pieces-grid"
	role="group"
	aria-label="Available puzzle pieces"
	onfocusin={handlePiecesFocusIn}
	onkeydown={handlePiecesKeyDown}
>
```

For each visible piece:

```svelte
<PuzzlePiece
	...
	tabIndex={activePieceId === piece.id ? 0 : -1}
/>
```

Header/filter/shuffle/drawer controls remain unchanged.

- [ ] **Step 7: Verify inventory + piece behavior**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/components/PuzzlePiece.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "a11y(web): add roving inventory piece navigation"
```

---

## Task 4: Add one route announcer and Escape cancellation

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/src/lib/components/ReferenceOverlay.svelte`
- Modify: `apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts`

**Produces:** selection/placement/hint/pause/resume/completion transitions have concise polite announcements from existing session outcomes/events; Escape cancels selection/Hold and dismisses persistent Reference.

- [ ] **Step 1: Add failing Reference Escape test**

In the existing Reference overlay tests, render `active`, `dismissible`, and an `onDismiss` spy. Focus the Close button and dispatch Escape. Expect `onDismiss` once and preserve the existing Tab trap/focus-restoration tests.

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
```

Expected: Escape currently does nothing.

- [ ] **Step 2: Extend the existing overlay keydown handler only**

In `ReferenceOverlay.svelte`:

```ts
function handleOverlayKeyDown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		event.preventDefault();
		onDismiss?.();
		return;
	}
	if (event.key === 'Tab') {
		event.preventDefault();
		closeButtonEl?.focus();
	}
}
```

Do not replace this with `modalFocus`; HPA-222 already owns the overlay's single-control focus behavior.

- [ ] **Step 3: Add failing route announcement tests before implementation**

Extend `page.svelte.test.ts` using its current puzzle/session mocks and real route handlers. Cover at least:

1. the announcer exists with `role="status"`, `aria-live="polite"`, `aria-atomic="true"`;
2. the announcer is **not** a descendant of `.puzzle-page`, so `inert` / `aria-hidden` cannot silence it while a dialog opens;
3. selecting a piece -> `Puzzle piece 0 selected.`;
4. explicit cancel -> `Selection canceled.`;
5. accepted placement -> `Puzzle piece 0 placed.`;
6. wrong-slot rejection -> `Puzzle piece 0 does not fit there.`;
7. non-upright rejection -> `Puzzle piece 0 must be upright.` in a rotation fixture/state;
8. Hint -> one-based row/column target message;
9. toolbar Pause -> `Mission paused.`;
10. Resume -> `Mission resumed.`;
11. final accepted placement -> message includes `Puzzle complete.` once;
12. Escape with a selected piece clears selection and announces cancellation;
13. existing Ctrl/Cmd+Z / Ctrl/Cmd+Y route tests remain green.

Because the announcer clears then sets in a microtask, use existing async browser assertions/`expect.poll` rather than fixed sleeps.

Run and verify red:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 4: Add one route-local announcer helper**

Near other route-local presentation state:

```ts
let gameplayAnnouncement = $state('');

function announceGameplay(message: string): void {
	gameplayAnnouncement = '';
	queueMicrotask(() => {
		gameplayAnnouncement = message;
	});
}
```

Do not create a store/service or persist the value.

Render the one region **after/outside** the closing `.puzzle-page` element and before/alongside the dialog components:

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

Do not place it inside `.puzzle-page`: that subtree is currently `inert={hasSessionModal}` and `aria-hidden={hasSessionModal}`.

- [ ] **Step 5: Announce explicit selection/cancel outcomes**

Use the existing dispatch outcome instead of assuming the action succeeded:

```ts
function handleSelectPiece(id: number) {
	const outcome = sessionStore?.dispatch({ type: 'select_piece', pieceId: id });
	if (outcome?.type === 'selection_changed' && outcome.pieceId === id) {
		announceGameplay(`Puzzle piece ${id} selected.`);
	}
}

function handleCancelSelection() {
	const hadSelection = currentSelectedPieceId !== null;
	const outcome = sessionStore?.dispatch({ type: 'cancel_selection' });
	if (hadSelection && outcome?.type === 'selection_changed' && outcome.pieceId === null) {
		announceGameplay('Selection canceled.');
	}
}
```

Keep lifecycle cleanup using direct `cancel_selection` dispatch so opening Pause does not emit a misleading “Selection canceled” immediately before “Mission paused.”

- [ ] **Step 6: Translate existing session events into placement/hint announcements**

Add these branches to `handleSessionEvent` without changing the event contract:

```ts
if (event.type === 'placement_accepted') {
	announceGameplay(
		event.completed
			? `Puzzle piece ${event.pieceId} placed. Puzzle complete.`
			: `Puzzle piece ${event.pieceId} placed.`
	);
} else if (event.type === 'placement_rejected') {
	announceGameplay(
		event.reason === 'non_upright'
			? `Puzzle piece ${event.pieceId} must be upright.`
			: `Puzzle piece ${event.pieceId} does not fit there.`
	);
	// keep existing rejected-piece visual timeout
} else if (event.type === 'hint_target') {
	if (event.pieceId !== null && event.target) {
		announceGameplay(
			`Hint: puzzle piece ${event.pieceId} goes to row ${event.target.y + 1}, column ${event.target.x + 1}.`
		);
	}
	// keep existing hint visual behavior
}
```

Preserve all existing completion-effect/lifecycle/visual branches. Do **not** add another `completion_sealed` announcement because the final `placement_accepted` event already includes `completed: true` before sealing.

- [ ] **Step 7: Announce explicit pause/resume only**

In the active user pause path, after a successful `pause` dispatch/checkpoint:

```ts
if (presentation === 'paused') announceGameplay('Mission paused.');
```

In `resumeSession`, use the existing resume outcome and announce only a real transition back to active:

```ts
const outcome = sessionStore?.dispatch({ type: 'resume' });
if (outcome?.type === 'lifecycle_transitioned' && outcome.to === 'active') {
	announceGameplay('Mission resumed.');
}
```

Do not announce route-entry restoration pauses or internal lifecycle changes.

- [ ] **Step 8: Add Escape to the existing global shortcut owner**

Keep the existing modal and persistent-Reference gates. Before Undo/Redo detection:

```ts
if (event.key === 'Escape') {
	if (sessionState?.activeReferenceMode === 'hold') {
		event.preventDefault();
		clearReferenceHold();
		return;
	}
	if (currentSelectedPieceId !== null) {
		event.preventDefault();
		handleCancelSelection();
		return;
	}
}
```

Persistent Toggle remains gated out of the route handler and is dismissed by `ReferenceOverlay`'s local Escape handler. Do not make Escape close MORE in this task.

- [ ] **Step 9: Run focused route/overlay verification**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/components/ReferenceOverlay.svelte \
  apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "a11y(web): announce core puzzle interactions"
```

---

## Task 5: Prove the real keyboard flow and run final gates

**Files:**

- Modify: `apps/web/e2e/gameplay-accessibility.spec.ts`

No new page-object helper is required unless the test exposes repeated setup that already belongs in `GameplayPage`.

- [ ] **Step 1: Add one failing keyboard core-flow E2E**

Add one test under the existing `accessibility @a11y` describe and include `@smoke` in this test's title, e.g.:

```ts
test('keyboard core flow uses logical regions and announcements @smoke', async ({
	gameplayPage,
	page
}) => {
	await gameplayPage.gotoFixture({
		fixtureId: 'e2e-square-4',
		seedPreferences: IMMEDIATE_START
	});
	// assertions below
});
```

This keeps one source test while letting the current automatic `@smoke` lane and manual `@a11y` lane select it independently.

Before implementation is complete, run the new test and confirm it fails on the old many-tab-stop behavior:

```bash
cd apps/web
bunx playwright test e2e/gameplay-accessibility.spec.ts \
  --project=chromium-desktop \
  --grep "keyboard core flow"
```

- [ ] **Step 2: Prove Tab-stop counts and region entry**

With the real rendered fixture:

```ts
const toolbar = page.getByTestId('puzzle-toolbar');
const board = page.getByTestId('puzzle-board');
const inventory = page.getByTestId('puzzle-inventory-panel');

await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
await expect(board.locator('[data-testid="drop-zone"][tabindex="0"]:visible')).toHaveCount(1);
await expect(inventory.locator('[data-testid="puzzle-piece"][tabindex="0"]:visible')).toHaveCount(1);
```

Focus `Return to arcade`, press Tab, and assert focus enters the toolbar's one tab stop. Press Tab once more and assert focus enters the board's one tab stop; it must not visit every toolbar button.

Use an arrow inside the toolbar and assert focus stays within the toolbar but changes action. Use Right/Down on the board and assert `data-x`/`data-y` change spatially.

- [ ] **Step 3: Exercise inventory arrow, selection, rejection, and Escape**

Programmatically focus the inventory's current one tab stop (the focus itself is not the behavior under test; subsequent keys are). Press `ArrowRight` and verify a different piece root is focused, proving the real rendered tray navigation.

Then focus a known fixture piece, press Enter/Space, and assert both its selected state and the polite announcer text.

Attempt a known wrong board cell with the keyboard and assert:

```text
Puzzle piece N does not fit there.
```

Press Escape and assert the selection clears plus `Selection canceled.` appears. Do not assert on the 500ms visual rejection class; use durable session/announcement state.

- [ ] **Step 4: Prove accepted placement + Undo/Redo still share the existing path**

Select a known `e2e-square-4` piece and use board arrows to its correct cell, then press Enter/Space. Use `gameplayPage.expectPiecePlaced()` for the durable board assertion and check the accepted-placement announcement.

Press `Control+z` and assert the piece returns to the tray. Press `Control+y` and assert it is placed again. Keep the existing platform-aware Ctrl/Cmd behavior in route unit tests; Chromium E2E may use Control.

- [ ] **Step 5: Prove Hint and completion announcements**

Keyboard-activate the existing Hint button and assert the announcer matches the one-based target form:

```text
Hint: puzzle piece N goes to row R, column C.
```

Complete the remaining `e2e-square-4` pieces with existing `GameplayPage.selectAndPlaceWithKeyboard()` calls. Do not write a second solving helper.

Assert the completion dialog appears and the announcer's final text includes:

```text
Puzzle complete.
```

This one test is the acceptance proof; component/route tests own exhaustive arrow/message branches.

- [ ] **Step 6: Run the new E2E on both automatic Chromium targets**

```bash
cd apps/web
bunx playwright test e2e/gameplay-accessibility.spec.ts \
  --project=chromium-desktop \
  --project=chromium-mobile \
  --grep "keyboard core flow"
```

The mobile project still has a real keyboard through Playwright; this verifies compact toolbar visibility filtering without inventing a second test.

- [ ] **Step 7: Run focused component/route suites together**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 8: Run repository gates**

```bash
cd apps/web
bun run test:unit
bun run test:e2e:smoke
bun run check
bun run lint
bun run build
```

Do not add `test:e2e:a11y` as a required per-ticket cross-browser gate. The new test already remains selectable by that existing manual lane because its parent describe contains `@a11y`.

- [ ] **Step 9: Scope review**

Expected production files only:

```text
apps/web/src/lib/components/PuzzleToolbar.svelte
apps/web/src/lib/components/PuzzleBoard.svelte
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/lib/components/ReferenceOverlay.svelte
apps/web/src/routes/puzzle/[id]/+page.svelte
```

Expected tests stay in their corresponding existing component/route files plus `apps/web/e2e/gameplay-accessibility.spec.ts`.

Confirm no changes to:

```text
PuzzleSession action/state/event contracts
session persistence/schema/version
API/shared types
analytics/preferences
modalFocus.ts
Playwright projects/fixtures
HPA-237 staging-tray work
```

- [ ] **Step 10: Commit the E2E**

```bash
git add apps/web/e2e/gameplay-accessibility.spec.ts
git commit -m "test(web): cover practical keyboard puzzle flow"
```

If final verification requires a production fix, make a specific regression-fix commit instead of folding unrelated cleanup into the E2E commit.

## Review checklist

Before marking implementation ready:

```text
Toolbar: one visible enabled Tab stop; arrows skip disabled/hidden controls
Board: one Tab stop; spatial arrows clamp; Enter/Space still call onPiecePlaced
Inventory: one repeated piece Tab stop; tools remain native; R still rotates
Rotate button: pointer-visible, tabindex=-1
Escape: Hold -> close; selection -> cancel; persistent Reference -> overlay dismiss
Announcements: selection / cancel / accepted / rejected / hint / pause / resume / completion
Live region: exactly one, polite + atomic, outside .puzzle-page inert subtree
Undo/Redo: unchanged Ctrl/Cmd shortcuts
Dialogs: existing modalFocus unchanged
No generic focus/accessibility framework or domain/persistence change
```

## Why this is the intended size

HPA-223 is the final active gameplay UX child in HPA-215's current order. The repository already has keyboard-capable domain actions and concrete feature components; the missing work is focus shape and concise feedback. Keeping roving state inside the three UI owners and announcements in the route completes that seam with six production files, existing tests, and one E2E—without paying for an abstraction that the project does not yet need.