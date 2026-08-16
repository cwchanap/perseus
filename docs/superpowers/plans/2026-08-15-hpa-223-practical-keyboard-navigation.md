# HPA-223 Practical Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the core puzzle flow practical with a keyboard by replacing repeated Tab stops with component-local roving focus and adding one route-owned polite announcer, while reusing existing `PuzzleSession` actions/events and modal focus behavior.

**Architecture:** `PuzzleToolbar`, `PuzzleBoard`, and `PuzzleInventoryPanel` each own only ephemeral roving focus. `PuzzlePiece` gains a presentation-only `tabIndex` and keeps `R` rotation. The puzzle route remains the composition root for global shortcuts and announcements. Persistent Reference keeps its HPA-222 trap/restoration and only adds Escape dismissal with propagation stopped.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-hpa-223-practical-keyboard-navigation-design.md`.
- No `PuzzleSession` state/action/event/schema/persistence changes.
- No generic roving-focus helper/action/store/controller/context.
- Keep pointer/touch/click/drag paths on existing callbacks/session actions.
- Keep responsive toolbar, inventory filters/shuffle/drawer, zoom/pan, and dialog ownership unchanged.
- Keep `$lib/actions/modalFocus` unchanged.
- Do not announce arrow movement, timer updates, every lifecycle transition, or Undo/Redo.
- No new dependency, Playwright project, fixture family, or broad screen-reader certification gate.
- Update current tests directly; no compatibility layer for old DOM/ARIA contracts.

---

## Task 1: Make `PuzzleToolbar` one roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Produces:** one named toolbar Tab stop; arrows traverse actual visible/enabled actions.

- [ ] **Step 1: Add failing tests in the existing toolbar suite**

Use the file's existing `createToolbarProps()` helper:

```ts
it('exposes one visible enabled toolbar tab stop', async () => {
	render(PuzzleToolbar, createToolbarProps({ canUndo: false, canRedo: false }));
	const toolbar = await page.getByTestId('puzzle-toolbar').element();

	expect(toolbar.getAttribute('role')).toBe('toolbar');
	expect(toolbar.getAttribute('aria-label')).toBe('Puzzle actions');

	const tabbable = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
	).filter((button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0);
	expect(tabbable).toHaveLength(1);
});
```

Add a second test that focuses the current tab stop, sends `ArrowRight`, and verifies focus moves to another visible enabled action and never lands on disabled Undo/Redo.

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

Expected: new role/tabindex/arrow assertions fail.

- [ ] **Step 2: Add toolbar-local state and focus tracking**

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

`focusin` is required: direct focus/click of an item that previously had `tabindex=-1` must make that item the composite's next Tab entry point.

- [ ] **Step 3: Normalize when props/MORE make the active action unavailable**

Keep the logic local. After DOM updates, inspect `visibleEnabledToolbarButtons()`; if no visible enabled button matches `activeToolbarAction`, set it to the first returned action id.

Make the effect depend on the states that can add/remove/disable actions (`canUndo`, `canRedo`, `rotationToggleDisabled`, `hasReference`, `referenceAvailable`, `referenceToggled`, `canPause`, `canOpenSetup`, `moreOpen`). Do not introduce a JS copy of the 1024px breakpoint.

- [ ] **Step 4: Add arrow traversal**

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

Wire the root:

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

Give every toolbar button a stable `data-toolbar-action` and `tabindex={toolbarTabIndex('...')}`. Keep existing callbacks, pressed/described states, `moreOpen`, and CSS unchanged.

- [ ] **Step 5: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
bun run check

git add src/lib/components/PuzzleToolbar.svelte \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
git commit -m "a11y(web): add roving puzzle toolbar focus"
```

---

## Task 2: Make board cells one spatial roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`

**Produces:** one board-cell Tab stop with spatial arrows; existing click/drag/Enter/Space placement remains unchanged.

- [ ] **Step 1: Add failing roving tests**

Use `createMockPuzzle(10)` for an explicit large-board assertion:

```ts
const puzzle = createMockPuzzle(10);
render(PuzzleBoard, {
	puzzle,
	placedPieces: [],
	onPiecePlaced: vi.fn(),
	resolveImage
});

const board = await page.getByTestId('puzzle-board').element();
const cells = Array.from(board.querySelectorAll<HTMLElement>('[data-testid="drop-zone"]'));
expect(cells).toHaveLength(100);
expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
```

Use a 3x3 puzzle for movement tests. Prove Right then Down moves `(0,0) -> (1,0) -> (1,1)`, and Left/Up at `(0,0)` stays put.

Update old name queries to one-based/status names such as `Row 1, column 2, empty`, and add an occupied-name case.

Keep the existing “wrong cell still calls `onPiecePlaced`” test.

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

- [ ] **Step 2: Add board-local active coordinate + `focusin` tracking**

```ts
let boardElement = $state<HTMLElement | null>(null);
let activeCell = $state({ x: 0, y: 0 });
const puzzleIdentity = $derived(puzzle.id);

$effect(() => {
	void puzzleIdentity;
	activeCell = { x: 0, y: 0 };
});

function handleBoardFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const cell = target.closest<HTMLElement>('[data-testid="drop-zone"]');
	if (!cell) return;
	const x = Number(cell.dataset.x);
	const y = Number(cell.dataset.y);
	if (Number.isInteger(x) && Number.isInteger(y)) activeCell = { x, y };
}
```

This keeps existing E2E helpers that directly call `.focus()` compatible with the roving model.

- [ ] **Step 3: Handle arrows before Enter/Space**

```ts
function moveCellFocus(event: KeyboardEvent, x: number, y: number): boolean {
	const delta = {
		ArrowLeft: { dx: -1, dy: 0 },
		ArrowRight: { dx: 1, dy: 0 },
		ArrowUp: { dx: 0, dy: -1 },
		ArrowDown: { dx: 0, dy: 1 }
	}[event.key];
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

At the top of existing `handleKeyDown`:

```ts
if (moveCellFocus(event, x, y)) return;
```

Keep existing Enter/Space placement logic untouched.

- [ ] **Step 4: Wire semantics/tabindex/names**

Board root:

```svelte
<div
	bind:this={boardElement}
	role="group"
	aria-label="Puzzle board"
	onfocusin={handleBoardFocusIn}
	...
>
```

Each cell remains `role="button"`:

```svelte
tabindex={activeCell.x === x && activeCell.y === y ? 0 : -1}
aria-label={`Row ${y + 1}, column ${x + 1}, ${placedPiece ? 'occupied' : 'empty'}`}
```

Do not add ARIA row wrappers/grid roles or change zero-based `data-x` / `data-y`.

- [ ] **Step 5: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
bun run check

git add src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
git commit -m "a11y(web): add roving puzzle board navigation"
```

---

## Task 3: Make repeated inventory pieces one roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Produces:** one Tab stop across visible repeated pieces; finite inventory tools remain native; `R` stays keyboard rotation.

- [ ] **Step 1: Add failing `PuzzlePiece` tests**

Use the existing `mockPiece`/`resolveImage` fixtures directly:

```ts
it('honors a supplied roving tab index', async () => {
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		tabIndex: -1
	});
	await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '-1');
});
```

For rotation-enabled rendering, assert the root has `aria-keyshortcuts="R"`, the visible `Rotate piece 7` button has `tabindex="-1"`, and existing `R` handling still calls `onRotate(7)`.

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

- [ ] **Step 2: Add `tabIndex` without changing interaction ownership**

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

Root:

```svelte
tabindex={isPlaced ? -1 : tabIndex}
aria-keyshortcuts={rotationEnabled && !isPlaced ? 'R' : undefined}
```

Pointer Rotate button:

```svelte
tabindex="-1"
```

Do not remove the Rotate button or change the existing `R` branch.

- [ ] **Step 3: Add failing inventory-panel roving tests**

Use the existing `filterPuzzle` and `baseProps()` helpers. Render enough visible pieces to assert exactly one `[data-testid="puzzle-piece"]` has `tabIndex === 0`.

Focus the current piece, send `ArrowRight`, and verify the next piece in current visible order receives focus. Rerender with a filter/placement that removes that active id and assert the new visible set again has exactly one Tab stop.

Keep existing tray order/filter/shuffle/drawer/Cancel/hint/rejection tests.

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

- [ ] **Step 4: Add panel-local active id + focus tracking**

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

function handlePiecesFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const piece = target.closest<HTMLElement>('[data-testid="puzzle-piece"]');
	const id = Number(piece?.dataset.pieceId);
	if (Number.isInteger(id)) activePieceId = id;
}
```

The first guard is required: do not reset to the selected id after every arrow press.

- [ ] **Step 5: Derive current columns from rendered slots**

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

Handle keydown on `.pieces-grid` after the piece root's native listener bubbles:

- Left/Right -> previous/next visible item when present.
- Up -> `index - columns` when >= 0; otherwise stay.
- Down -> `index + columns` when present; if a next partial row exists but the same column does not, use the final item in that row; if no next row exists, stay.
- Ignore all non-arrow keys so `PuzzlePiece` keeps Enter/Space/R.

Update `activePieceId` and focus the target piece root. Do not announce focus moves.

- [ ] **Step 6: Wire group + roving prop**

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

```svelte
<PuzzlePiece
	...
	tabIndex={activePieceId === piece.id ? 0 : -1}
/>
```

Header/tools stay unchanged.

- [ ] **Step 7: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check

git add src/lib/components/PuzzlePiece.svelte \
  src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "a11y(web): add roving inventory piece navigation"
```

---

## Task 4: Add one route announcer and Escape cancellation

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/src/lib/components/ReferenceOverlay.svelte`
- Modify: `apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts`

**Produces:** concise announcements from existing outcomes/events; one Escape closes one active interaction layer.

- [ ] **Step 1: Add failing Reference Escape coverage**

Render persistent (`active + dismissible`) Reference with an `onDismiss` spy, focus its Close button, press Escape, and assert:

- `onDismiss` called once;
- the event does not bubble to an outer/window keydown spy.

Keep existing Tab trap/restoration tests.

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
```

- [ ] **Step 2: Extend the current overlay keydown handler**

```ts
function handleOverlayKeyDown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		onDismiss?.();
		return;
	}
	if (event.key === 'Tab') {
		event.preventDefault();
		closeButtonEl?.focus();
	}
}
```

Stopping propagation prevents the same Escape from dismissing Reference and then canceling a still-selected underlying piece if route-derived state updates synchronously.

- [ ] **Step 3: Add failing route-announcement tests**

In `page.svelte.test.ts`, cover:

1. announcer is `role=status`, polite, atomic;
2. announcer is not inside `.puzzle-page`;
3. explicit select -> `Puzzle piece 0 selected.`;
4. explicit cancel -> `Selection canceled.`;
5. accepted placement -> `Puzzle piece 0 placed.`;
6. wrong-slot rejection -> `Puzzle piece 0 does not fit there.`;
7. non-upright rejection -> `Puzzle piece 0 must be upright.`;
8. Hint -> one-based row/column message;
9. explicit toolbar Pause -> `Mission paused.`;
10. Resume -> `Mission resumed.`;
11. final accepted placement includes `Puzzle complete.` once;
12. Escape cancels selection;
13. existing Ctrl/Cmd Undo/Redo tests remain green.

Use async polling/assertions because the announcer intentionally clears then sets in a microtask; no fixed sleeps.

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 4: Add one route-local announcer outside the inert subtree**

```ts
let gameplayAnnouncement = $state('');

function announceGameplay(message: string): void {
	gameplayAnnouncement = '';
	queueMicrotask(() => {
		gameplayAnnouncement = message;
	});
}
```

Render after/outside `.puzzle-page`:

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

This placement is mandatory because `.puzzle-page` is `inert` + `aria-hidden` whenever session/completion dialogs are open.

- [ ] **Step 5: Announce explicit selection/cancel via dispatch outcomes**

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

Keep lifecycle cleanup (`clearTransientGameplayState`) on direct `cancel_selection` dispatch so Pause does not announce a misleading cancel immediately before the pause message.

- [ ] **Step 6: Announce placement/hint from existing session events**

Add branches without changing event types:

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
	// preserve existing rejection visual timeout
} else if (event.type === 'hint_target') {
	if (event.pieceId !== null && event.target) {
		announceGameplay(
			`Hint: puzzle piece ${event.pieceId} goes to row ${event.target.y + 1}, column ${event.target.x + 1}.`
		);
	}
	// preserve existing hint visuals
}
```

Keep completion effects/lifecycle branches. Do not separately announce `completion_sealed` because final `placement_accepted` already carries `completed: true` before sealing.

- [ ] **Step 7: Announce explicit Pause/Resume only**

Capture the user pause outcome inside `openPauseDialog` when lifecycle is active. After checkpoint, announce `Mission paused.` only when `presentation === 'paused'` and the dispatch actually transitioned to paused.

In `resumeSession`:

```ts
const outcome = sessionStore?.dispatch({ type: 'resume' });
if (outcome?.type === 'lifecycle_transitioned' && outcome.to === 'active') {
	announceGameplay('Mission resumed.');
}
```

Do not announce route-entry restoration pauses/internal lifecycle changes.

- [ ] **Step 8: Add Escape before Undo/Redo detection in the existing window handler**

Preserve current modal and `referenceToggled` gates. Then:

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

Hold has priority so the first Escape ends Peek without also canceling selection. Persistent Toggle is handled by the overlay and does not bubble.

- [ ] **Step 9: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git add src/lib/components/ReferenceOverlay.svelte \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "a11y(web): announce core puzzle interactions"
```

---

## Task 5: Prove the real keyboard flow and run final gates

**Files:**

- Modify: `apps/web/e2e/gameplay-accessibility.spec.ts`

No new page-object helper is planned; use existing `GameplayPage` locators/helpers unless repeated behavior clearly belongs there.

- [ ] **Step 1: Add one failing E2E under the existing accessibility describe**

```ts
test('keyboard core flow uses logical regions and announcements @smoke', async ({
	gameplayPage,
	page
}) => {
	await gameplayPage.gotoFixture({
		fixtureId: 'e2e-square-4',
		seedPreferences: IMMEDIATE_START
	});
	// flow below
});
```

The parent describe already contains `@a11y`; `@smoke` in this test title lets one source test participate in both existing selections.

Before production changes are complete:

```bash
cd apps/web
bunx playwright test e2e/gameplay-accessibility.spec.ts \
  --project=chromium-desktop \
  --grep "keyboard core flow"
```

Expected: old many-tab-stop behavior fails.

- [ ] **Step 2: Prove tab-stop counts + region entry**

```ts
const toolbar = page.getByTestId('puzzle-toolbar');
const board = page.getByTestId('puzzle-board');
const inventory = page.getByTestId('puzzle-inventory-panel');

await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
await expect(board.locator('[data-testid="drop-zone"][tabindex="0"]:visible')).toHaveCount(1);
await expect(inventory.locator('[data-testid="puzzle-piece"][tabindex="0"]:visible')).toHaveCount(1);
```

Focus `Return to arcade`, press Tab, assert focus enters the toolbar's one tab stop. Press Tab again and assert focus enters the board's one tab stop; it must not traverse each toolbar action/cell.

Send a toolbar arrow and assert focus changes but stays inside toolbar. Send a board arrow and assert `data-x`/`data-y` move spatially.

- [ ] **Step 3: Prove inventory arrow + selection/rejection/Escape**

Focus the inventory's current roving piece, press `ArrowRight`, and verify a different piece root is focused.

Then direct-focus a known small-fixture piece (focusin makes it the active piece), press Enter/Space, and assert selected state + `Puzzle piece N selected.`.

Keyboard-activate a known wrong board cell and assert `Puzzle piece N does not fit there.`. Press Escape and assert selection clears + `Selection canceled.`. Use durable state/announcer assertions, not the 500ms shake class.

- [ ] **Step 4: Prove accepted placement + existing Undo/Redo**

Select a known `e2e-square-4` piece, focus a board cell, use board arrows to its correct coordinate, and press Enter/Space. Verify with `gameplayPage.expectPiecePlaced()` and accepted-placement announcement.

Press `Control+z`, assert the piece returns to tray. Press `Control+y`, assert it is placed again. Platform-specific Ctrl/Cmd variants remain covered by route unit tests.

- [ ] **Step 5: Prove Hint + completion**

Keyboard-activate Hint and assert the one-based target message.

Complete only the remaining unplaced pieces using existing `gameplayPage.selectAndPlaceWithKeyboard()` calls; do not call `solveFixture()` after one piece is already placed because it attempts every fixture piece.

Assert completion dialog visible and final live text includes `Puzzle complete.`.

- [ ] **Step 6: Run the new E2E on both automatic Chromium targets**

```bash
cd apps/web
bunx playwright test e2e/gameplay-accessibility.spec.ts \
  --project=chromium-desktop \
  --project=chromium-mobile \
  --grep "keyboard core flow"
```

The mobile project still exposes Playwright keyboard input; this verifies compact toolbar visibility filtering without a second test.

- [ ] **Step 7: Run focused component/route suites**

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

- [ ] **Step 8: Run normal repository gates**

```bash
cd apps/web
bun run test:unit
bun run test:e2e:smoke
bun run check
bun run lint
bun run build
```

Do not add `test:e2e:a11y` as a required per-ticket cross-browser gate. The new test remains selectable by that existing manual lane through its parent `@a11y` describe.

- [ ] **Step 9: Scope review**

Expected production files:

```text
apps/web/src/lib/components/PuzzleToolbar.svelte
apps/web/src/lib/components/PuzzleBoard.svelte
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/lib/components/ReferenceOverlay.svelte
apps/web/src/routes/puzzle/[id]/+page.svelte
```

Expected tests are their existing component/route tests plus `apps/web/e2e/gameplay-accessibility.spec.ts`.

Confirm unchanged:

```text
PuzzleSession state/action/event contracts
session persistence/schema/version
API/shared types
analytics/preferences
modalFocus.ts
Playwright projects/fixture catalog
HPA-237 staging trays
```

- [ ] **Step 10: Commit E2E**

```bash
git add e2e/gameplay-accessibility.spec.ts
git commit -m "test(web): cover practical keyboard puzzle flow"
```

If final verification needs a production fix, make a specific regression-fix commit instead of folding unrelated cleanup into the E2E commit.

## Final review checklist

```text
Toolbar: one visible enabled Tab stop; focusin updates active; arrows skip disabled/hidden
Board: 100 cells => one Tab stop; focusin updates active; spatial arrows stay in bounds
Inventory: one repeated piece Tab stop; finite tools remain native; focusin + arrows work
Rotate: pointer button remains; tabindex=-1; R remains keyboard command
Escape: Hold closes first; selection cancels; persistent Reference stops propagation + dismisses
Announcements: select / cancel / accepted / rejected / hint / pause / resume / complete
Live region: exactly one, polite + atomic, outside inert .puzzle-page
Undo/Redo: existing Ctrl/Cmd shortcuts unchanged
Dialogs: existing modalFocus unchanged
No generic focus/accessibility framework and no domain/persistence work
```

## Why this is the intended size

HPA-223 is the final active gameplay UX child in HPA-215's current sequence. The repository already owns the hard parts—keyboard-capable session actions, session events, concrete feature components, modal focus, and deterministic E2E fixtures. This plan adds focus shape and feedback at those seams instead of building another accessibility architecture.