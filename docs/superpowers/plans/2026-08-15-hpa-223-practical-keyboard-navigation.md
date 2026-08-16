# HPA-223 Practical Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the core puzzle flow practical with a keyboard by replacing repeated Tab stops with component-local roving focus and adding one route-owned polite announcer, while reusing existing `PuzzleSession` actions/events and modal focus behavior.

**Architecture:** `PuzzleToolbar`, `PuzzleBoard`, and `PuzzleInventoryPanel` each own only ephemeral roving focus. Toolbar and inventory use the repository's existing native `addEventListener('keydown', ...)` pattern for focus-changing keyboard handlers; board extends its existing native cell keydown path. Inventory is intentionally one-dimensional for this ticket: Left/Right traverses `visiblePieces`, with no DOM column measurement. The route remains the composition root for global shortcuts and announcements. Persistent Reference keeps its HPA-222 trap/restoration and only adds Escape dismissal with propagation stopped.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-hpa-223-practical-keyboard-navigation-design.md`.
- No `PuzzleSession` state/action/event/schema/persistence changes.
- No generic roving-focus helper/action/store/controller/context.
- Keep pointer/touch/click/drag paths on existing callbacks/session actions.
- Keep responsive toolbar, inventory filters/shuffle/drawer, zoom/pan, and dialog ownership unchanged.
- Keep `$lib/actions/modalFocus` unchanged.
- Use native keydown listeners for toolbar/inventory focus-changing handlers, matching `PuzzlePiece.interactionAction` and `PuzzleBoard.dropZoneInteraction`.
- Inventory uses Left/Right only; do not add `getBoundingClientRect`, computed-grid parsing, responsive column state, or partial-row rules.
- Do not announce arrow movement, timer updates, every lifecycle transition, or Undo/Redo.
- Keep direct lifecycle cleanup dispatches non-announcing; only explicit cancel uses the announcing cancel helper.
- No new dependency, Playwright project, fixture family, or broad screen-reader certification gate.
- Update current tests directly; no compatibility layer for old DOM/ARIA contracts.

---

## Task 1: Make `PuzzleToolbar` one roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Interfaces:**

- Produces local `ToolbarAction` union and one native toolbar keydown action.
- No prop/callback changes.

**Produces:** one named toolbar Tab stop; wrapping arrows traverse actual visible/enabled actions without delegated-keydown double movement.

- [ ] **Step 1: Add failing toolbar semantics/tab-stop tests**

Use the existing `createToolbarProps()` / `renderToolbar()` helpers:

```ts
it('exposes exactly one visible enabled toolbar tab stop', async () => {
	renderToolbar({ canUndo: false, canRedo: false });
	const toolbar = await page.getByTestId('puzzle-toolbar').element();

	expect(toolbar.getAttribute('role')).toBe('toolbar');
	expect(toolbar.getAttribute('aria-label')).toBe('Puzzle actions');

	const tabbable = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
	).filter((button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0);
	expect(tabbable).toHaveLength(1);
});
```

Add an adjacent-target test. In the component browser's compact layout, Hint and Toggle Reference are both visible primary actions:

```ts
it('ArrowRight moves to the adjacent visible enabled action exactly once', async () => {
	renderToolbar({ canUndo: false, canRedo: false, referenceAvailable: true });
	const hint = await page.getByRole('button', { name: 'Hint' }).element();
	const reference = await page.getByRole('button', { name: 'Toggle reference' }).element();

	hint.focus();
	hint.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

	expect(document.activeElement).toBe(reference);
});
```

Do not assert only `document.activeElement !== hint`; that would let a double-skip regression pass.

Run and expect red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

- [ ] **Step 2: Add a closed toolbar action type**

In `PuzzleToolbar.svelte`:

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

let toolbarElement = $state<HTMLElement | null>(null);
let activeToolbarAction = $state<ToolbarAction>('hint');

function toolbarTabIndex(action: ToolbarAction): 0 | -1 {
	return activeToolbarAction === action ? 0 : -1;
}
```

Every `toolbarTabIndex(...)` call must use a `ToolbarAction` literal. Treat `dataset.toolbarAction` from this component's own markup as `ToolbarAction | undefined`; do not introduce a registry.

- [ ] **Step 3: Add visible/enabled lookup + focusin tracking**

```ts
function visibleEnabledToolbarButtons(): HTMLButtonElement[] {
	if (!toolbarElement) return [];
	return Array.from(
		toolbarElement.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
	).filter((button) => !button.disabled && button.offsetParent !== null);
}

function handleToolbarFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const button = target.closest<HTMLButtonElement>('[data-toolbar-action]');
	const action = button?.dataset.toolbarAction as ToolbarAction | undefined;
	if (action) activeToolbarAction = action;
}
```

`focusin` is required so existing direct `.focus()` helpers and pointer clicks on `tabindex=-1` actions update the composite's next Tab entry point.

- [ ] **Step 4: Add native arrow traversal**

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
	const nextAction = next.dataset.toolbarAction as ToolbarAction | undefined;
	if (nextAction) activeToolbarAction = nextAction;
	next.focus();
}

function toolbarKeyboardAction(node: HTMLElement) {
	node.addEventListener('keydown', handleToolbarKeyDown);
	return {
		destroy() {
			node.removeEventListener('keydown', handleToolbarKeyDown);
		}
	};
}
```

Wire the root with the native action, not delegated `onkeydown`:

```svelte
<div
	bind:this={toolbarElement}
	use:toolbarKeyboardAction
	role="toolbar"
	aria-label="Puzzle actions"
	data-testid="puzzle-toolbar"
	onfocusin={handleToolbarFocusIn}
	class="puzzle-toolbar"
>
```

Give every toolbar button a stable `data-toolbar-action="..."` and typed `tabindex={toolbarTabIndex('...')}`. Keep callbacks, pressed/described states, `moreOpen`, and CSS unchanged.

- [ ] **Step 5: Normalize when the active action becomes unavailable**

Use one local effect that depends on the states that can add/remove/disable actions:

```ts
$effect(() => {
	void canUndo;
	void canRedo;
	void rotationToggleDisabled;
	void hasReference;
	void referenceAvailable;
	void referenceToggled;
	void canPause;
	void canOpenSetup;
	void moreOpen;

	const items = visibleEnabledToolbarButtons();
	if (items.some((button) => button.dataset.toolbarAction === activeToolbarAction)) return;
	const first = items[0]?.dataset.toolbarAction as ToolbarAction | undefined;
	if (first) activeToolbarAction = first;
});
```

Do not copy the 1024px breakpoint into TypeScript. Visibility stays `offsetParent !== null`, matching the existing `modalFocus` approach.

- [ ] **Step 6: Verify and commit**

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
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- Board keeps existing `onPiecePlaced` and `dropZoneInteraction` contract.
- Accessible cell names change to `Row {1-based}, column {1-based}, empty|occupied`.

**Produces:** one board-cell Tab stop with spatial non-wrapping arrows; route integration tests use the new cell-name contract in the same slice.

- [ ] **Step 1: Add failing board roving/name tests**

Use `createMockPuzzle(10)` for the large-board count:

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

Use a 3x3 puzzle to prove exact spatial movement:

```ts
const start = await page.getByRole('button', { name: 'Row 1, column 1, empty' }).element();
const right = await page.getByRole('button', { name: 'Row 1, column 2, empty' }).element();
const down = await page.getByRole('button', { name: 'Row 2, column 2, empty' }).element();

start.focus();
start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
expect(document.activeElement).toBe(right);
right.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
expect(document.activeElement).toBe(down);
```

Also prove Left/Up at `(0,0)` stays on `(0,0)` and add an occupied-name assertion. Keep the existing wrong-cell placement test, changing only its name query.

Run and expect red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

- [ ] **Step 2: Update the route helper before implementation commit**

`page.svelte.test.ts` currently uses the old accessible name in `placeSelectedPieceAt()`. Change that helper in this task, not Task 4:

```ts
async function placeSelectedPieceAt(x: number, y: number) {
	const dropZone = await page
		.getByRole('button', {
			name: new RegExp(`^Row ${y + 1}, column ${x + 1}, `)
		})
		.element();
	dropZone.focus();
	dropZone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
```

The prefix regex preserves role/name coverage while working for both empty and occupied status. Do not defer this locator change to the announcer task.

- [ ] **Step 3: Add board-local active coordinate + focusin tracking**

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

This keeps `GameplayPage.selectAndPlaceWithKeyboard()` and route tests that direct-focus a cell compatible with roving tabindex.

- [ ] **Step 4: Put arrows in the existing native cell keydown handler**

Add a helper:

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

Do not add delegated board `onkeydown`; `dropZoneInteraction` already invokes `handleKeyDown` through a native listener.

- [ ] **Step 5: Wire semantics/tabindex/names**

Board root:

```svelte
<div
	bind:this={boardElement}
	role="group"
	aria-label="Puzzle board"
	data-testid="puzzle-board"
	onfocusin={handleBoardFocusIn}
	...
>
```

Each cell remains `role="button"`:

```svelte
tabindex={activeCell.x === x && activeCell.y === y ? 0 : -1}
aria-label={`Row ${y + 1}, column ${x + 1}, ${placedPiece ? 'occupied' : 'empty'}`}
```

Keep zero-based `data-x` / `data-y`, click, drag/drop, and Enter/Space placement unchanged.

- [ ] **Step 6: Run both board and route suites, then check**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

This gate is required before committing Task 2. The cell-name change must not leave the route suite red until Task 4.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "a11y(web): add roving puzzle board navigation"
```

---

## Task 3: Make repeated inventory pieces one roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**

- `PuzzlePiece` gains optional `tabIndex?: number`.
- Placed pieces still force `tabindex=-1` regardless of supplied value.
- Inventory exposes no new prop/callback.

**Produces:** one Tab stop across visible repeated pieces; Left/Right moves to the exact adjacent visible piece; no inventory geometry engine.

- [ ] **Step 1: Add failing `PuzzlePiece` tests**

Use existing `mockPiece` / `resolveImage`:

```ts
it('honors a supplied roving tab index while unplaced', async () => {
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		tabIndex: -1
	});
	await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '-1');
});

it('placed state still forces tabindex -1', async () => {
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: true,
		resolveImage,
		tabIndex: 0
	});
	await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '-1');
});
```

For rotation-enabled rendering, assert:

```ts
await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('aria-keyshortcuts', 'R');
await expect.element(page.getByRole('button', { name: 'Rotate piece 7' })).toHaveAttribute(
	'tabindex',
	'-1'
);
```

Keep the existing `R` callback test and pointer Rotate callback test.

Run and expect red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

- [ ] **Step 2: Add the presentation-only `tabIndex` prop**

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

Piece root:

```svelte
tabindex={isPlaced ? -1 : tabIndex}
aria-keyshortcuts={rotationEnabled && !isPlaced ? 'R' : undefined}
```

Rotate button:

```svelte
tabindex="-1"
```

Do not remove the Rotate button or change the existing native `R` branch.

- [ ] **Step 3: Add failing inventory roving tests**

Use existing `filterPuzzle` / `baseProps()`. Render several visible pieces and prove exactly one piece root is tabbable:

```ts
const pieces = Array.from(
	document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
);
expect(pieces.filter((piece) => piece.tabIndex === 0)).toHaveLength(1);
```

Add exact adjacent movement:

```ts
const first = pieces[0]!;
const second = pieces[1]!;
first.focus();
first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
expect(document.activeElement).toBe(second);
```

Also prove:

- ArrowLeft on the first visible item stays there;
- direct focus of a `tabindex=-1` piece makes it the active Tab stop via `focusin`;
- rerender with a filter/placement that removes the active id and assert the new visible set again has exactly one Tab stop;
- existing tray order/filter/shuffle/drawer/Cancel/hint/rejection tests remain unchanged.

No Up/Down or layout-geometry test is required.

Run and expect red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

- [ ] **Step 4: Add panel-local active id + focusin tracking**

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

The first guard is required: do not snap back to the selected piece after every arrow press.

- [ ] **Step 5: Add native Left/Right traversal only**

```ts
function handlePiecesKeyDown(event: KeyboardEvent): void {
	if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const current = target.closest<HTMLElement>('[data-testid="puzzle-piece"]');
	const currentId = Number(current?.dataset.pieceId);
	if (!Number.isInteger(currentId)) return;

	const index = visiblePieces.findIndex((piece) => piece.id === currentId);
	if (index < 0) return;
	const nextIndex = event.key === 'ArrowRight' ? index + 1 : index - 1;
	const nextPiece = visiblePieces[nextIndex];
	if (!nextPiece) return;

	event.preventDefault();
	activePieceId = nextPiece.id;
	piecesGridElement
		?.querySelector<HTMLElement>(`[data-testid="puzzle-piece"][data-piece-id="${nextPiece.id}"]`)
		?.focus();
}

function piecesGridKeyboardAction(node: HTMLElement) {
	node.addEventListener('keydown', handlePiecesKeyDown);
	return {
		destroy() {
			node.removeEventListener('keydown', handlePiecesKeyDown);
		}
	};
}
```

Do not add Up/Down, `getBoundingClientRect`, CSS-variable reads, or column calculations.

- [ ] **Step 6: Wire group + roving prop**

```svelte
<div
	bind:this={piecesGridElement}
	use:piecesGridKeyboardAction
	class="pieces-grid"
	role="group"
	aria-label="Available puzzle pieces"
	onfocusin={handlePiecesFocusIn}
>
```

Pass the roving value:

```svelte
<PuzzlePiece
	...
	tabIndex={activePieceId === piece.id ? 0 : -1}
/>
```

Header/tools remain native finite controls.

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

**Interfaces:**

- No new session event/action.
- Route consumes existing dispatch outcomes plus `placement_accepted`, `placement_rejected`, and `hint_target` events.
- `ReferenceOverlay` reuses existing `onDismiss`.

**Produces:** concise announcements from existing outcomes/events; one Escape closes one active interaction layer.

- [ ] **Step 1: Add failing Reference Escape coverage**

Render persistent (`active + dismissible`) Reference with `onDismiss` plus an outer/window keydown spy. Focus Close, dispatch Escape, and assert:

```ts
expect(onDismiss).toHaveBeenCalledOnce();
expect(outerKeydown).not.toHaveBeenCalled();
```

Keep existing Tab trap/restoration tests.

Run and expect red:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
```

- [ ] **Step 2: Extend the existing overlay keydown handler**

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

Stopping propagation prevents one Escape from closing persistent Reference and then canceling a still-selected piece underneath.

- [ ] **Step 3: Add failing route-announcement tests**

In `page.svelte.test.ts`, cover:

1. announcer `role=status`, `aria-live=polite`, `aria-atomic=true`;
2. announcer is not a descendant of `.puzzle-page`;
3. explicit select -> `Puzzle piece 0 selected.`;
4. explicit cancel -> `Selection canceled.`;
5. accepted placement -> `Puzzle piece 0 placed.`;
6. wrong slot -> `Puzzle piece 0 does not fit there.`;
7. non-upright -> `Puzzle piece 0 must be upright.`;
8. Hint -> one-based target message;
9. explicit toolbar Pause -> `Mission paused.`;
10. Resume -> `Mission resumed.`;
11. final accepted placement includes `Puzzle complete.` exactly once;
12. Escape ends Hold before canceling selection;
13. Escape cancels selection when Hold is inactive;
14. existing Ctrl/Cmd Undo/Redo tests stay green.

Use polling/DOM assertions because the announcer clears then sets in a microtask; no fixed sleeps.

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 4: Add one route-local announcer outside `.puzzle-page`**

```ts
let gameplayAnnouncement = $state('');

function announceGameplay(message: string): void {
	gameplayAnnouncement = '';
	queueMicrotask(() => {
		gameplayAnnouncement = message;
	});
}
```

Render as a sibling of `.puzzle-page` and the existing dialogs:

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

This must not sit inside `.puzzle-page`, which is already `inert` + `aria-hidden` while setup/pause/exit/completion UI is open.

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

Keep `clearTransientGameplayState()` on its existing **direct** `sessionStore?.dispatch({ type: 'cancel_selection' })`. Do not route Pause/restart/exit cleanup through `handleCancelSelection()`, or Pause can speak a misleading `Selection canceled.` before `Mission paused.`.

- [ ] **Step 6: Announce placement/hint from existing session events**

Extend `handleSessionEvent` without changing the event contract:

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
	// preserve existing rejected-piece timeout
} else if (event.type === 'hint_target') {
	if (event.pieceId !== null && event.target) {
		announceGameplay(
			`Hint: puzzle piece ${event.pieceId} goes to row ${event.target.y + 1}, column ${event.target.x + 1}.`
		);
	}
	// preserve existing hint presentation
}
```

Preserve completion-effect/lifecycle handling. Do not separately announce `completion_sealed`; the final `placement_accepted` already carries `completed: true`.

- [ ] **Step 7: Announce explicit Pause/Resume only**

Inside `openPauseDialog`, capture the existing pause dispatch outcome when lifecycle is active:

```ts
const outcome = sessionStore?.dispatch({ type: 'pause' });
checkpointSession();
if (
	presentation === 'paused' &&
	outcome?.type === 'lifecycle_transitioned' &&
	outcome.to === 'paused'
) {
	announceGameplay('Mission paused.');
}
```

Keep restored-route pause orchestration unchanged and non-announcing.

In `resumeSession`:

```ts
const outcome = sessionStore?.dispatch({ type: 'resume' });
if (outcome?.type === 'lifecycle_transitioned' && outcome.to === 'active') {
	announceGameplay('Mission resumed.');
}
restartConfirmation = false;
sessionDialog = null;
```

- [ ] **Step 8: Add Escape before Undo/Redo detection**

Preserve the existing `hasSessionModal` and persistent-Reference gates. Then:

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

Hold has priority: the first Escape ends Peek without also canceling selection. Persistent Reference handles Escape inside its overlay and stops propagation.

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

## Task 5: Prove the real keyboard flow in the correct lane and run final gates

**Files:**

- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`
- Modify: `apps/web/e2e/gameplay-accessibility.spec.ts`

**Produces:** one Chromium smoke keyboard flow beside existing keyboard interaction tests, while the existing accessibility file remains the axe/structural lane.

- [ ] **Step 1: Add the keyboard core flow to `gameplay-interactions.spec.ts`**

Import the deterministic fixture catalog so completion can skip already-placed pieces without hard-coding coordinates:

```ts
import { getFixture } from './gameplay-fixtures/catalog';
```

Add the new test beside, but **outside**, the existing `keyboard @webkit-critical` describe so it carries only `@smoke`:

```ts
test('keyboard core flow uses logical regions and announcements @smoke', async ({
	gameplayPage,
	page
}) => {
	const fixture = getFixture('e2e-square-4');
	await gameplayPage.gotoFixture({
		fixtureId: fixture.id,
		seedPreferences: IMMEDIATE_START
	});
	// assertions below
});
```

Do not put this test under `accessibility @a11y`, and do not add `@webkit-critical` unless a later change explicitly runs/proves that lane.

Before implementation is complete, run and expect the old many-tab-stop behavior to fail:

```bash
cd apps/web
bunx playwright test e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop \
  --grep "keyboard core flow"
```

- [ ] **Step 2: Prove tab-stop counts and exact adjacent arrows**

```ts
const toolbar = page.getByTestId('puzzle-toolbar');
const board = page.getByTestId('puzzle-board');
const inventory = page.getByTestId('puzzle-inventory-panel');

await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
await expect(board.locator('[data-testid="drop-zone"][tabindex="0"]:visible')).toHaveCount(1);
await expect(inventory.locator('[data-testid="puzzle-piece"][tabindex="0"]:visible')).toHaveCount(1);
```

Focus `Return to arcade`, press Tab, and assert focus enters the toolbar's single tab stop. Press Tab again and assert focus enters the board's single tab stop; it must not traverse every toolbar action/cell.

For arrows, assert exact destinations:

```ts
const hint = page.getByRole('button', { name: 'Hint' });
const reference = page.getByRole('button', { name: 'Toggle reference' });
await hint.focus();
await page.keyboard.press('ArrowRight');
await expect(reference).toBeFocused();

const cell00 = gameplayPage.dropZone(0, 0);
const cell10 = gameplayPage.dropZone(1, 0);
await cell00.focus();
await page.keyboard.press('ArrowRight');
await expect(cell10).toBeFocused();
```

For inventory, capture the visible piece roots in DOM order, focus the first, press ArrowRight, and assert the second is focused. This proves the planned one-dimensional behavior; there is no Up/Down geometry test.

- [ ] **Step 3: Prove selection, rejection, and Escape announcements**

Direct-focus a known visible piece root, press Enter, and assert both selected state and live text:

```ts
const firstPiece = inventory.locator('[data-testid="puzzle-piece"]:visible').first();
const pieceId = Number(await firstPiece.getAttribute('data-piece-id'));
await firstPiece.focus();
await page.keyboard.press('Enter');
await expect(firstPiece).toHaveAttribute('data-selected', 'true');
await expect(page.getByTestId('gameplay-announcer')).toContainText(
	`Puzzle piece ${pieceId} selected.`
);
```

Use `fixture.pieces` to choose a cell that is not that piece's correct coordinate, activate it with Enter, and assert the durable rejection announcement instead of the 500ms shake class.

Press Escape and assert selection clears plus `Selection canceled.`.

- [ ] **Step 4: Prove accepted placement + existing Undo/Redo**

Use the chosen fixture piece's canonical coordinates:

```ts
const piece = fixture.pieces.find((candidate) => candidate.id === pieceId)!;
await gameplayPage.selectAndPlaceWithKeyboard(piece.id, piece.correctX, piece.correctY);
await gameplayPage.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
await expect(page.getByTestId('gameplay-announcer')).toContainText(
	`Puzzle piece ${piece.id} placed.`
);
```

Then:

```ts
await page.keyboard.press('Control+z');
await expect(gameplayPage.pieceSource(piece.id)).toBeVisible();
await page.keyboard.press('Control+y');
await gameplayPage.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
```

Route unit tests keep the platform-specific Ctrl/Cmd variants; smoke uses the existing Chromium Ctrl path.

- [ ] **Step 5: Prove Hint + completion without re-solving the placed piece**

Keyboard-activate Hint and assert the announcer matches the one-based target format.

Complete only pieces whose tray slots remain:

```ts
for (const remaining of fixture.pieces) {
	if ((await gameplayPage.pieceSource(remaining.id).count()) === 0) continue;
	await gameplayPage.selectAndPlaceWithKeyboard(
		remaining.id,
		remaining.correctX,
		remaining.correctY
	);
	await gameplayPage.expectPiecePlaced(
		remaining.id,
		remaining.correctX,
		remaining.correctY
	);
}
```

Assert the completion dialog is visible and the announcer contains `Puzzle complete.`.

- [ ] **Step 6: Keep `gameplay-accessibility.spec.ts` structural/axe-focused**

In the existing active-gameplay `@a11y` test, before `assertPageAccessible(...)`, add only:

```ts
await expect(
	page.getByTestId('puzzle-toolbar').locator('[data-toolbar-action][tabindex="0"]:visible')
).toHaveCount(1);
await expect(
	page.getByTestId('puzzle-board').locator('[data-testid="drop-zone"][tabindex="0"]:visible')
).toHaveCount(1);
await expect(
	page
		.getByTestId('puzzle-inventory-panel')
		.locator('[data-testid="puzzle-piece"][tabindex="0"]:visible')
).toHaveCount(1);
await expect(page.getByTestId('gameplay-announcer')).toHaveAttribute('aria-live', 'polite');
```

Do not add `@smoke` to this file. Its parent `accessibility @a11y` describe selects Chromium desktop/tablet and WebKit-mobile in `test:e2e:a11y`; keeping the keyboard smoke elsewhere prevents an unrun WebKit obligation from being created accidentally.

- [ ] **Step 7: Run the new smoke on both automatic Chromium targets**

```bash
cd apps/web
bunx playwright test e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop \
  --project=chromium-mobile \
  --grep "keyboard core flow"
```

This exercises compact-toolbar visibility filtering on Chromium mobile without creating a second test.

- [ ] **Step 8: Run focused component/route suites**

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

- [ ] **Step 9: Run normal repository gates**

```bash
cd apps/web
bun run test:unit
bun run test:e2e:smoke
bun run check
bun run lint
bun run build
```

`test:e2e:a11y` remains the existing manual/pre-release lane; it is not a required HPA-223 implementation gate. The structural assertions added there will run whenever that lane is invoked.

- [ ] **Step 10: Scope review**

Expected production files:

```text
apps/web/src/lib/components/PuzzleToolbar.svelte
apps/web/src/lib/components/PuzzleBoard.svelte
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/lib/components/ReferenceOverlay.svelte
apps/web/src/routes/puzzle/[id]/+page.svelte
```

Expected test files:

```text
apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
apps/web/e2e/gameplay-interactions.spec.ts
apps/web/e2e/gameplay-accessibility.spec.ts
```

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

Confirm absent from the diff:

```text
renderedColumnCount
getBoundingClientRect inventory column math
shared roving-focus helper/action
route accessibility/focus controller
new accessibility session state
```

- [ ] **Step 11: Commit E2E changes**

```bash
git add e2e/gameplay-interactions.spec.ts e2e/gameplay-accessibility.spec.ts
git commit -m "test(web): cover practical keyboard puzzle flow"
```

If final verification needs a production fix, make a specific regression-fix commit instead of folding unrelated cleanup into the E2E commit.

## Final review checklist

```text
Toolbar: ToolbarAction union; one visible enabled Tab stop; focusin updates active
Toolbar arrows: native listener; wrapping; exact adjacent target; disabled/hidden skipped
Board: 100 cells => one Tab stop; existing native keydown owns spatial arrows; bounds clamp
Board names: one-based empty/occupied; route helper updated in Task 2
Inventory: one repeated piece Tab stop; Left/Right only; no column/row geometry engine
Inventory arrows: native listener; exact adjacent target; active-id normalization
Rotate: pointer button remains; tabindex=-1; R remains keyboard command
Escape: Hold closes first; selection cancels; persistent Reference stops propagation + dismisses
Announcements: select / cancel / accepted / rejected / hint / pause / resume / complete
Lifecycle cleanup: direct cancel_selection remains non-announcing
Live region: exactly one, polite + atomic, outside inert .puzzle-page
Undo/Redo: existing Ctrl/Cmd shortcuts unchanged
E2E lanes: keyboard @smoke in gameplay-interactions; a11y file stays axe/structural
Dialogs: existing modalFocus unchanged
No generic focus/accessibility framework and no domain/persistence work
```

## Review-resolution notes

The supplied review was validated against current `main` and the planning branch. All five findings are actionable:

1. Removed inventory Up/Down and the planned `renderedColumnCount()`/partial-row geometry. Left/Right already reaches every `visiblePieces` item and is fully testable in the component suite.
2. Replaced delegated toolbar/inventory `onkeydown` with local native-listener actions, matching the existing `PuzzlePiece`/`PuzzleBoard` pattern. Tests now require the adjacent target, not merely a different target.
3. Moved the route's `placeSelectedPieceAt()` accessible-name update into Task 2 and added the route suite to Task 2's gate, so the board-label commit is independently green.
4. Moved the keyboard `@smoke` flow to `gameplay-interactions.spec.ts`. `gameplay-accessibility.spec.ts` remains the axe lane and receives only tab-stop/live-region structural assertions.
5. Added a closed `ToolbarAction` union so the roving state/tabindex calls are type-checked rather than free-form strings.

The overall architecture remains Option A: concrete component-local focus plus one route announcer, with no session/persistence work and no shared focus framework.