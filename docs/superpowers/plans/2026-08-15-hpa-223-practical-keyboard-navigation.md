# HPA-223 Practical Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the core puzzle flow practical with a keyboard by replacing repeated Tab stops with component-local roving focus and adding one route-owned polite announcer, while preserving visible/shortcut rotation access and reusing existing `PuzzleSession` actions/events.

**Architecture:** `PuzzleToolbar`, `PuzzleBoard`, and `PuzzleInventoryPanel` each own ephemeral focus state. Toolbar and inventory follow the repository's native `addEventListener('keydown', ...)` pattern; board extends its existing native cell keydown. Inventory is intentionally Left/Right-only. `PuzzlePiece` exposes rotation state and keeps only the active piece's Rotate button in sequential Tab order. The route owns announcements and global Escape/Undo/Redo priority. Persistent Reference Escape is handled in the existing route window-key handler; `ReferenceOverlay` remains unchanged.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-hpa-223-practical-keyboard-navigation-design.md`.
- No `PuzzleSession` state/action/event/schema/persistence changes.
- No generic roving-focus helper/action/store/controller/context.
- Do not add a shared `nativeKeydown` action for two small local wrappers.
- Keep pointer/touch/click/drag paths on existing callbacks/session actions.
- Keep responsive toolbar, inventory filters/shuffle/drawer, zoom/pan, and dialog ownership unchanged.
- Keep `$lib/actions/modalFocus`, `ReferenceOverlay.svelte`, and `PuzzleBoardPanel.svelte` unchanged.
- Inventory uses Left/Right only; no DOM column measurement, computed-grid parsing, or partial-row rules.
- Do not announce arrow movement, timer updates, every lifecycle transition, Undo/Redo, or reference activation.
- Keep direct lifecycle cleanup dispatches non-announcing; only explicit cancel uses the announcing cancel helper.
- Keep explicit Pause/Resume announcements because they are part of HPA-223 scope.
- No dependency, Playwright project, fixture family, or broad screen-reader certification work.
- Update current tests directly; no compatibility layer for old DOM/ARIA contracts.

---

## Task 1: Make `PuzzleToolbar` one robust roving Tab stop

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Interfaces:**

- Produces local `ToolbarAction` union and `Record<ToolbarAction, boolean>` availability model.
- No prop/callback changes.

**Produces:** exactly one visible enabled toolbar action in sequential Tab order; wrapping arrows traverse actual rendered actions without delegated-keydown double movement.

- [ ] **Step 1: Add failing semantics and exact-adjacent tests**

Use the existing `renderToolbar()` helper:

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

it('ArrowRight moves to the adjacent visible enabled action exactly once', async () => {
	renderToolbar({ canUndo: false, canRedo: false, referenceAvailable: true });
	const hint = await page.getByRole('button', { name: 'Hint' }).element();
	const reference = await page.getByRole('button', { name: 'Toggle reference' }).element();

	hint.focus();
	hint.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

	expect(document.activeElement).toBe(reference);
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

Expected before implementation: new role/tabindex/arrow assertions fail.

- [ ] **Step 2: Add the closed action type and typed availability**

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

function toolbarTabIndex(action: ToolbarAction): 0 | -1 {
	return activeToolbarAction === action && actionAvailable[action] ? 0 : -1;
}
```

This replaces the old planned free-form/hand-maintained dependency shape. A newly added `ToolbarAction` now forces an availability decision at compile time.

- [ ] **Step 3: Add live-DOM lookup and `focusin` tracking**

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

Keep `offsetParent !== null`; do not copy the 1024px breakpoint into TypeScript.

- [ ] **Step 4: Add the local native arrow listener**

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

Wire `use:toolbarKeyboardAction`, `role="toolbar"`, `aria-label="Puzzle actions"`, `onfocusin={handleToolbarFocusIn}`, a stable `data-toolbar-action`, and `tabindex={toolbarTabIndex('...')}` on every action.

- [ ] **Step 5: Normalize from derived availability + live visibility**

```ts
$effect(() => {
	void actionAvailable;
	void moreOpen;

	const items = visibleEnabledToolbarButtons();
	if (items.some((button) => button.dataset.toolbarAction === activeToolbarAction)) return;
	const first = items[0]?.dataset.toolbarAction as ToolbarAction | undefined;
	if (first) activeToolbarAction = first;
});
```

No list of individual `void canUndo; void canRedo; ...` reads.

- [ ] **Step 6: Add a table-driven prop invariant test**

Use `it.each` so each current add/remove/disable condition independently proves one visible enabled Tab stop:

```ts
it.each([
	['undo disabled', { canUndo: false }],
	['redo disabled', { canRedo: false }],
	['reference unavailable', { referenceAvailable: false }],
	['reference absent', { hasReference: false }],
	['peek disabled by toggle', { referenceToggled: true }],
	['rotation locked', { rotationToggleDisabled: true }],
	['pause absent', { canPause: false }],
	['setup absent', { canOpenSetup: false }]
] as const)('keeps one visible enabled tab stop when %s', async (_name, overrides) => {
	renderToolbar({ canUndo: true, canRedo: true, canPause: true, canOpenSetup: true, ...overrides });
	const toolbar = await page.getByTestId('puzzle-toolbar').element();
	const tabbable = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
	).filter((button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0);
	expect(tabbable).toHaveLength(1);
});
```

Keep/extend the existing `MORE` tests so opening/closing the compact secondary container also reasserts the invariant.

- [ ] **Step 7: Verify and commit**

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

- Board keeps existing `onPiecePlaced` and `dropZoneInteraction` contracts.
- Accessible names become `Row N, column M, empty` or `Row N, column M, occupied by puzzle piece ID`.

**Produces:** one board-cell Tab stop with non-wrapping spatial arrows; route integration uses the new name contract in the same slice.

- [ ] **Step 1: Add failing large-board, movement, and name tests**

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

For a 3x3 puzzle, prove `(0,0) -> (1,0) -> (1,1)` with Right then Down and prove Left/Up at `(0,0)` stays put.

Add exact names:

```ts
await expect
	.element(page.getByRole('button', { name: 'Row 1, column 1, empty' }))
	.toBeInTheDocument();
```

With `{ pieceId: 0, x: 0, y: 0 }` placed:

```ts
await expect
	.element(page.getByRole('button', { name: 'Row 1, column 1, occupied by puzzle piece 0' }))
	.toBeInTheDocument();
```

Keep the existing wrong-cell placement test, changing only its name query.

- [ ] **Step 2: Update the route helper immediately**

Change `page.svelte.test.ts::placeSelectedPieceAt()` in this task:

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

Do not defer this locator change to Task 4.

- [ ] **Step 3: Add board-local active coordinate + `focusin`**

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

Do not move `activeCell` when a Hint arrives.

- [ ] **Step 4: Extend the existing native cell keydown**

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
		?.querySelector<HTMLElement>(`[data-testid="drop-zone"][data-x="${nextX}"][data-y="${nextY}"]`)
		?.focus();
	return true;
}
```

At the top of existing `handleKeyDown`:

```ts
if (moveCellFocus(event, x, y)) return;
```

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

Cell:

```svelte
tabindex={activeCell.x === x && activeCell.y === y ? 0 : -1}
aria-label={`Row ${y + 1}, column ${x + 1}, ${
	placedPiece ? `occupied by puzzle piece ${placedPiece.pieceId}` : 'empty'
}`}
```

Keep zero-based `data-x` / `data-y`, click, drag/drop, and Enter/Space placement unchanged.

- [ ] **Step 6: Run board + route suites before committing**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "a11y(web): add roving puzzle board navigation"
```

---

## Task 3: Make inventory roving while preserving practical rotation access

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**

- `PuzzlePiece` gains optional `tabIndex?: 0 | -1`.
- Placed piece roots still force `-1`.
- Active unplaced Rotate button uses the same supplied roving index.

**Produces:** one active piece root, plus at most its one Rotate button, in sequential Tab order; exact Left/Right moves the active piece; rotation angle is exposed in the piece name.

- [ ] **Step 1: Add failing `PuzzlePiece` tests**

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

For rotation mode:

```ts
render(PuzzlePiece, {
	piece: mockPiece,
	isPlaced: false,
	resolveImage,
	rotationEnabled: true,
	rotation: 90,
	tabIndex: 0,
	onRotate: vi.fn()
});

await expect
	.element(page.getByTestId('puzzle-piece'))
	.toHaveAttribute('aria-label', 'Puzzle piece 7, rotated 90 degrees');
await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('aria-keyshortcuts', 'R');
await expect
	.element(page.getByRole('button', { name: 'Rotate piece 7' }))
	.toHaveAttribute('tabindex', '0');
```

Add a rotation `0` case expecting `Puzzle piece 7, upright`, and a `tabIndex: -1` case proving the Rotate button also becomes `-1`. Keep existing `R` and pointer Rotate callback tests.

- [ ] **Step 2: Add the presentation-only roving prop and rotation name**

```ts
interface Props {
	// existing props...
	tabIndex?: 0 | -1;
}

let {
	// existing props...
	tabIndex = 0
}: Props = $props();

const accessibleName = $derived(
	rotationEnabled && !isPlaced
		? rotation === 0
			? `Puzzle piece ${piece.id}, upright`
			: `Puzzle piece ${piece.id}, rotated ${rotation} degrees`
		: `Puzzle piece ${piece.id}`
);
```

Root:

```svelte
tabindex={isPlaced ? -1 : tabIndex}
aria-label={accessibleName}
aria-keyshortcuts={rotationEnabled && !isPlaced ? 'R' : undefined}
```

Existing Rotate button:

```svelte
tabindex={tabIndex}
```

Do not remove the visible Rotate button or change the existing native `R` branch.

- [ ] **Step 3: Add failing inventory roving/O(1) tests**

Use existing `filterPuzzle` / `baseProps()`:

```ts
const pieces = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]'));
expect(pieces.filter((piece) => piece.tabIndex === 0)).toHaveLength(1);
```

With rotation enabled, assert only one Rotate button is sequentially tabbable:

```ts
const rotateButtons = Array.from(
	document.querySelectorAll<HTMLButtonElement>('[data-testid="rotate-piece-button"]')
);
expect(rotateButtons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
```

Add exact adjacent movement:

```ts
const first = pieces[0]!;
const second = pieces[1]!;
first.focus();
first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
expect(document.activeElement).toBe(second);
```

Also prove first-item ArrowLeft stays put, direct focus makes a `-1` piece active, and filtering/placement that removes the active id restores exactly one active piece root.

- [ ] **Step 4: Add panel-local active id + `focusin`**

```ts
let piecesGridElement = $state<HTMLElement | null>(null);
let activePieceId = $state<number | null>(null);

$effect(() => {
	const ids = visiblePieces.map((piece) => piece.id);
	if (activePieceId !== null && ids.includes(activePieceId)) return;
	activePieceId =
		selectedPieceId !== null && ids.includes(selectedPieceId) ? selectedPieceId : (ids[0] ?? null);
});

function handlePiecesFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const slot = target.closest<HTMLElement>('.piece-slot');
	const piece = slot?.querySelector<HTMLElement>('[data-testid="puzzle-piece"]');
	const id = Number(piece?.dataset.pieceId);
	if (Number.isInteger(id)) activePieceId = id;
}
```

Using the slot lets focus on either the active root or its sibling Rotate button keep the same active piece.

- [ ] **Step 5: Add native Left/Right traversal only**

```ts
function handlePiecesKeyDown(event: KeyboardEvent): void {
	if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const slot = target.closest<HTMLElement>('.piece-slot');
	const current = slot?.querySelector<HTMLElement>('[data-testid="puzzle-piece"]');
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

The existing Rotate button stops keydown propagation, so arrow traversal is owned by focused piece roots; Tab still reaches the active Rotate button.

No Up/Down or geometry code.

- [ ] **Step 6: Wire the group + roving prop**

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

Pass:

```svelte
<PuzzlePiece ... tabIndex={activePieceId === piece.id ? 0 : -1} />
```

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
git commit -m "a11y(web): keep rotation reachable in roving inventory"
```

---

## Task 4: Add one route announcer and ordered Escape handling

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- No new session action/event.
- Consumes existing selection/rotation dispatch outcomes plus `placement_accepted`, `placement_rejected`, and `hint_target` events.
- Reuses existing `handleReferenceToggle()`; `ReferenceOverlay` is unchanged.

**Produces:** one synchronous status string outside the inert subtree; one Escape closes exactly the highest-priority gameplay layer.

- [ ] **Step 1: Add failing announcer structure/message tests**

In `page.svelte.test.ts`, cover:

1. announcer `role=status`, `aria-live=polite`, `aria-atomic=true`;
2. announcer is not a descendant of `.puzzle-page`;
3. select -> `Puzzle piece 0 selected.`;
4. explicit cancel -> `Selection canceled.`;
5. accepted placement -> `Puzzle piece 0 placed.`;
6. wrong slot -> `Puzzle piece 0 does not fit there.`;
7. non-upright -> `Puzzle piece 0 must be upright.`;
8. successful rotation -> `Puzzle piece 0 rotated.`;
9. Hint -> one-based target message;
10. explicit toolbar Pause -> `Mission paused.`;
11. Resume -> `Mission resumed.`;
12. final accepted placement includes `Puzzle complete.` once;
13. persistent Reference Escape closes Reference but preserves an underlying selection;
14. Hold Escape ends Hold before selection cancel;
15. plain Escape cancels selection;
16. existing Ctrl/Cmd Undo/Redo tests remain green;
17. two consecutive identical outcomes (e.g. repeated rotation) bump `data-announcement-revision` on `gameplay-announcer` so the live region re-announces unchanged text.

Announcements are direct assignments; use ordinary awaited DOM assertions, not timing-specific microtask polling.

- [ ] **Step 2: Add one direct route-local announcer outside `.puzzle-page`**

```ts
let gameplayAnnouncement = $state('');
let gameplayAnnouncementRevision = $state(0);

function announceGameplay(message: string): void {
	gameplayAnnouncement = message;
	gameplayAnnouncementRevision += 1;
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
	data-announcement-revision={gameplayAnnouncementRevision}
>
	{#key gameplayAnnouncementRevision}{gameplayAnnouncement}{/key}
</div>
```

Do not clear then restore via `queueMicrotask`. Repeated identical messages are forced to re-announce by bumping `gameplayAnnouncementRevision` on every `announceGameplay` call and wrapping the content in a `{#key}` block on that value, so Svelte replaces the content node and assistive technology re-reads it even when the text is unchanged. The forcing lives in this one announcer seam; no call site needs special handling.

- [ ] **Step 3: Announce explicit selection/cancel through outcomes**

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

Keep `clearTransientGameplayState()` on its direct non-announcing `cancel_selection` dispatch.

- [ ] **Step 4: Announce rotation from the existing dispatch outcome**

Change `handlePieceRotate` only enough to consume the existing result:

```ts
function handlePieceRotate(pieceId: number) {
	if (!sessionStore || !rotationEnabled || isPiecePlaced(pieceId)) return;
	const outcome = sessionStore.dispatch({ type: 'rotate_piece', pieceId });
	if (outcome.type === 'piece_rotated') {
		announceGameplay(`Puzzle piece ${pieceId} rotated.`);
	}
	checkpointSession();
}
```

No new rotation event or angle helper. `PuzzlePiece`'s accessible name exposes the exact angle after state updates.

- [ ] **Step 5: Announce placement/hint from existing session events**

Extend `handleSessionEvent` without changing its event contract:

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

Do not separately announce `completion_sealed`.

- [ ] **Step 6: Keep explicit Pause/Resume announcements**

Inside active user Pause:

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

Keep restored-route pause orchestration non-announcing.

In `resumeSession`:

```ts
const outcome = sessionStore?.dispatch({ type: 'resume' });
restartConfirmation = false;
sessionDialog = null;
if (outcome?.type === 'lifecycle_transitioned' && outcome.to === 'active') {
	announceGameplay('Mission resumed.');
}
```

The status region is outside the inert page. HPA-223 explicitly requires pause/resume feedback; do not cut these rows merely because the dialog also supplies context.

- [ ] **Step 7: Put persistent Reference Escape in `handleWindowKeyDown`**

Keep the existing `hasSessionModal` gate first. Then handle Escape before the existing `if (referenceToggled) return` gate:

```ts
if (event.key === 'Escape' && referenceToggled) {
	event.preventDefault();
	handleReferenceToggle();
	return;
}

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

if (referenceToggled) return;
```

This makes priority explicit and leaves `ReferenceOverlay.svelte` untouched.

- [ ] **Step 8: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git add 'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "a11y(web): announce core puzzle interactions"
```

---

## Task 5: Prove the real keyboard flow and reuse existing E2E support

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`
- Modify: `apps/web/e2e/gameplay-accessibility.spec.ts`

**Produces:** one Chromium smoke keyboard flow beside existing keyboard interaction tests; accessibility file stays axe/structural; partial fixture completion reuses `GameplayPage.solveFixture()`.

- [ ] **Step 1: Extend `solveFixture()` instead of copying its loop**

Change the helper compatibly:

```ts
async solveFixture(options: { skipPlaced?: boolean } = {}): Promise<void> {
	const fixture = this.fixture ?? getFixture(DEFAULT_FIXTURE_ID);
	for (const piece of fixture.pieces) {
		if (options.skipPlaced && (await this.pieceSource(piece.id).count()) === 0) continue;
		await this.selectAndPlaceWithKeyboard(piece.id, piece.correctX, piece.correctY);
		await this.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
	}
}
```

Existing callers require no changes.

- [ ] **Step 2: Add the keyboard core smoke to `gameplay-interactions.spec.ts`**

Import `getFixture`:

```ts
import { getFixture } from './gameplay-fixtures/catalog';
```

Add beside, but outside, the existing `keyboard @webkit-critical` describe:

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

There is no Task-5 “expect red before implementation” step: Tasks 1–4 have already implemented the behavior by this point.

- [ ] **Step 3: Prove logical Tab shape and exact arrows**

```ts
const toolbar = page.getByTestId('puzzle-toolbar');
const board = page.getByTestId('puzzle-board');
const inventory = page.getByTestId('puzzle-inventory-panel');

await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
await expect(board.locator('[data-testid="drop-zone"][tabindex="0"]:visible')).toHaveCount(1);
await expect(inventory.locator('[data-testid="puzzle-piece"][tabindex="0"]:visible')).toHaveCount(
	1
);
```

Focus `Return to arcade`, press Tab, and assert the toolbar's one active action receives focus. Press Tab again and assert focus reaches the board's one active cell without traversing every toolbar action/cell.

Exact arrows:

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

For inventory, focus the first visible piece root, press ArrowRight, and assert the second visible root receives focus. No Up/Down test.

- [ ] **Step 4: Prove selection, rejection, Escape, accepted placement, Undo/Redo**

Use a known visible piece from `fixture.pieces`. Focus its root, press Enter, and assert selected state plus `Puzzle piece N selected.`.

Activate a known wrong cell and assert `Puzzle piece N does not fit there.`; use the durable announcer, not the 500ms shake class.

Press Escape and assert selection clears plus `Selection canceled.`.

Select/place the same piece at its canonical coordinates, assert placement and `Puzzle piece N placed.`. Then:

```ts
await page.keyboard.press('Control+z');
await expect(gameplayPage.pieceSource(piece.id)).toBeVisible();
await page.keyboard.press('Control+y');
await gameplayPage.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
```

Route unit tests retain Ctrl/Cmd variants.

- [ ] **Step 5: Prove Hint + completion via the extended helper**

Keyboard-activate Hint and assert the one-based target message.

Then:

```ts
await gameplayPage.solveFixture({ skipPlaced: true });
```

Assert the completion dialog is visible and `gameplay-announcer` contains `Puzzle complete.`.

Rotation reachability/state stays in focused component + route tests; do not turn this smoke into a rotation-mode solve matrix.

- [ ] **Step 6: Reuse `expectLiveRegion()` in the existing a11y test**

`gameplay-accessibility.spec.ts` already imports `expectLiveRegion`. In active gameplay, add only structural counts and:

```ts
await expectLiveRegion(page.getByTestId('gameplay-announcer'), 'polite');
```

Do not hand-roll `aria-live` assertions and do not add `@smoke` to the `accessibility @a11y` describe.

- [ ] **Step 7: Run the new smoke on automatic Chromium targets**

```bash
cd apps/web
bunx playwright test e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop \
  --project=chromium-mobile \
  --grep "keyboard core flow"
```

- [ ] **Step 8: Run focused suites**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
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

Do not add `test:e2e:a11y` as a per-ticket cross-browser gate. The structural a11y changes remain in its existing manual lane.

- [ ] **Step 10: Scope review and commit**

Expected production files:

```text
apps/web/src/lib/components/PuzzleToolbar.svelte
apps/web/src/lib/components/PuzzleBoard.svelte
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/routes/puzzle/[id]/+page.svelte
```

Expected test/support changes:

```text
apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
apps/web/e2e/support/gameplay-page.ts
apps/web/e2e/gameplay-interactions.spec.ts
apps/web/e2e/gameplay-accessibility.spec.ts
```

Confirm unchanged:

```text
PuzzleSession state/action/event contracts
session persistence/schema/version
ReferenceOverlay.svelte
PuzzleBoardPanel.svelte
modalFocus.ts
API/shared types
analytics/preferences
Playwright projects/fixture catalog
HPA-237 staging trays
```

Commit E2E/support changes:

```bash
git add e2e/support/gameplay-page.ts \
  e2e/gameplay-interactions.spec.ts \
  e2e/gameplay-accessibility.spec.ts
git commit -m "test(web): cover practical keyboard puzzle flow"
```

If final verification requires a production fix, make a specific regression-fix commit rather than folding unrelated cleanup into the E2E commit.

## Final review checklist

```text
Toolbar: typed availability; one visible enabled Tab stop; exact wrapping arrows
Board: 100 cells => one Tab stop; spatial arrows; occupant-identifying names
Inventory: one active piece root; at most one active Rotate button; Left/Right only
Rotation: visible Rotate remains keyboard reachable; R remains; angle in piece name; rotate announcement
Escape: Reference Toggle -> Hold -> selection priority in route; overlay unchanged
Announcements: select / cancel / accepted / rejected / rotation / hint / pause / resume / complete
Live region: one direct status string, polite + atomic, outside inert .puzzle-page
Undo/Redo: existing shortcuts unchanged
Dialogs: modalFocus unchanged
E2E: smoke in gameplay-interactions; a11y file uses expectLiveRegion; solveFixture reused
No shared focus/native-keydown framework and no domain/persistence work
```

## Review-resolution notes

The latest review was directionally correct but not every recommendation fits the current ticket:

- **Accepted:** replace clear+microtask with direct announcer assignment. WAI-ARIA allows AT to combine live-region changes, so the prior microtask technique was not a reliable contract. Repeated-identical-message forcing is handled in the single announcer seam via a monotonic `gameplayAnnouncementRevision` plus a `{#key}` block on the live region's content, so consecutive identical messages re-announce without per-call-site work.
- **Accepted:** keep rotation practically keyboard accessible. Only the active piece's Rotate button follows the roving `tabIndex`; piece names expose angle/upright state; successful rotation gets a concise announcement.
- **Accepted:** replace the toolbar's hand-maintained effect dependency list with typed derived availability plus a table-driven invariant test.
- **Accepted:** handle persistent Reference Escape in the existing route window-key owner before the reference gate; `ReferenceOverlay` and `PuzzleBoardPanel` stay unchanged.
- **Not adopted:** deleting Pause/Resume announcements. HPA-223 explicitly includes them; the existing pause/resume dialogs are redundant context, not permission to narrow acceptance silently.
- **Accepted:** occupied cells identify the placed piece.
- **Deferred:** moving board roving focus to the Hint target. It changes focus-entry policy and is not needed for the announced-hint acceptance criterion.
- **Accepted:** reuse `expectLiveRegion` and extend `solveFixture({ skipPlaced: true })`; remove the impossible Task-5 red framing.
- **Not adopted:** new shared `nativeKeydown` action. Only two new pure-keydown wrappers share that shape, while existing native actions also own click/coordinate behavior; a shared seam would not materially simplify this ticket.
