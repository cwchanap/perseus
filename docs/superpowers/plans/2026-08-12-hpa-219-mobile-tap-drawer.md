# HPA-219 Mobile Tap-to-Place and In-Flow Inventory Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make puzzle play practical at a 390 × 844 phone viewport using the existing selected-piece session state for tap-to-place and an in-flow binary inventory drawer.

**Architecture:** `PuzzleSession` remains the only canonical gameplay state owner. `PuzzlePiece` becomes native click/tap + keyboard + desktop HTML5 drag; `PuzzleBoard` routes native cell activation through the same placement callback as keyboard/drop; `PuzzleBoardPanel` disables/cancels pan while selection is active; `PuzzleInventoryPanel` owns one ephemeral `drawerOpen` boolean. The route keeps board + inventory in the existing `.game-layout` flow below 1024px, so there is no fixed overlay/z-index system. The E2E harness replaces obsolete touch-drag support with `placeWithTap()` and keeps reliable native tap coverage in WebKit.

**Tech Stack:** Svelte 5 runes/actions, TypeScript 5.9, Vitest Browser Mode, Playwright 1.57, Bun 1.3, existing `PuzzleSession`, existing deterministic gameplay E2E harness.

## Global Constraints

- `PuzzleSessionState.selectedPieceId` remains the only selected-piece state.
- Accepted placement clears selection through the existing session transition; rejected placement keeps it through the existing transition.
- Add no route-local selection/touch state, no new session action, no persistence field, and no shared-domain/API change.
- `drawerOpen` is the only new runtime state and stays private to `PuzzleInventoryPanel`.
- Direct touch drag is removed. Do not add drag thresholds, long-press classification, pinch zoom, two-finger pan, haptics, or an input/gesture framework.
- Preserve desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar/wheel zoom, rotation, completion, and session controls.
- Below 1024px, board and inventory remain two rows of the existing route grid. Do not use `position: fixed`, `sticky`, absolute positioning, or gameplay z-index for the inventory.
- Open mobile inventory max-height is `16rem`, border-box including safe-area padding. The existing 1.25rem route gap keeps tray + gap inside the small/medium board calculator's 300px/280px reserve.
- `CANCEL` is visible whenever a piece is selected, including collapsed mobile state.
- Extend the existing global `@media (pointer: coarse)` `.puzzle-piece` rule with `-webkit-user-drag: none`; do not add media-query JS state.
- Reuse `e2e-square-4`, `chromium-mobile` (390 × 844), and `webkit-mobile`.
- Native tap smoke is tagged `@smoke @webkit-critical`; the full HPA-219 completion flow remains Chromium-mobile only.
- Update `apps/web/e2e/README.md` with the supported tap helper in the same E2E commit.
- No fixed sleeps.
- No backward-compatibility wrapper for removed touch-drag behavior.

## File Structure

### Production/layout

- Modify `apps/web/src/lib/components/PuzzlePiece.svelte` — delete bespoke touch drag/dead callbacks; add native click selection; retain keyboard + desktop drag payload.
- Modify `apps/web/src/routes/layout.css` — add coarse-pointer `-webkit-user-drag: none` to the existing `.puzzle-piece` media rule.
- Modify `apps/web/src/lib/components/PuzzleBoard.svelte` — native click/keydown action reads `data-x` / `data-y` and routes through `placePiece()`.
- Modify `apps/web/src/lib/components/PuzzleBoardPanel.svelte` — selection-aware pan eligibility/cancellation.
- Modify `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — local drawer state, Cancel, height-capped scroll body, safe-area padding; remains in flow.
- Modify `apps/web/src/routes/puzzle/[id]/+page.svelte` — responsive grid-row CSS only; no route script/session logic.

### Component tests

- Modify `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`.

### E2E/support/docs

- Modify `apps/web/e2e/support/gameplay-page.ts` — remove `dragWithTouch()`, retarget `tapPiece()`, add `placeWithTap()`.
- Modify `apps/web/e2e/gameplay-interactions.spec.ts` — replace touch-drag smoke with Chromium/WebKit tap smoke.
- Create `apps/web/e2e/gameplay-mobile-tap.spec.ts` — 390 × 844 flow including browser-level touch swipe proof.
- Modify `apps/web/e2e/README.md` — document tap placement as supported touch interaction; remove touch-drag guidance.
- Modify `apps/web/playwright.config.ts` — stale comment only; no project behavior change.

### Explicitly unchanged

- `apps/web/src/lib/services/gameplay/session/**`
- `apps/web/src/lib/services/puzzleLayout.ts`
- persistence/statistics/API/shared-domain packages
- deterministic fixture catalog/builders
- route script/session orchestration

---

### Task 1: Simplify `PuzzlePiece` and protect coarse-pointer scrolling

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/routes/layout.css`

**Interfaces:**

- Consumes controlled props: `piece`, `isPlaced`, `resolveImage`, `rotationEnabled`, `rotation`, `onRotate`, `selected`, `onSelect`, `onCancelSelection`.
- Removes unused props: `onDragStart`, `onDragMove`, `onDragEnd`.
- Produces pointer behavior: click/tap on an unplaced piece calls `onSelect(piece.id)` exactly once, including when already selected.
- Preserves keyboard behavior: Enter/Space selects unselected and cancels selected.
- Preserves desktop HTML5 drag payload: `text/plain = piece.id`, `effectAllowed = 'move'`.
- Coarse-pointer CSS disables native user drag without adding JS state.

- [ ] **Step 1: Delete touch-drag-only test scaffolding and add failing click tests**

Remove `makeTouch`, `makeTouchList`, `dispatchTouch`, `appendDropZone`, synthetic-touch tests, `vi.stubGlobal` touch-drag cleanup, and `onDragStart/onDragMove/onDragEnd` assertions.

Add:

```ts
it('calls onSelect exactly once on native click', async () => {
	const onSelect = vi.fn();
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		onSelect
	});

	await page.getByTestId('puzzle-piece').click();

	expect(onSelect).toHaveBeenCalledTimes(1);
	expect(onSelect).toHaveBeenCalledWith(7);
});

it('reselects an already-selected piece instead of pointer-cancelling it', async () => {
	const onSelect = vi.fn();
	const onCancelSelection = vi.fn();
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		selected: true,
		onSelect,
		onCancelSelection
	});

	await page.getByTestId('puzzle-piece').click();

	expect(onSelect).toHaveBeenCalledTimes(1);
	expect(onSelect).toHaveBeenCalledWith(7);
	expect(onCancelSelection).not.toHaveBeenCalled();
});

it('does not select a placed piece on click', async () => {
	const onSelect = vi.fn();
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: true,
		resolveImage,
		onSelect
	});

	await page.getByTestId('puzzle-piece').click({ force: true });

	expect(onSelect).not.toHaveBeenCalled();
});
```

Strengthen rotation:

```ts
it('rotates without selecting the piece', async () => {
	const onRotate = vi.fn();
	const onSelect = vi.fn();
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		rotationEnabled: true,
		onRotate,
		onSelect
	});

	await page.getByRole('button', { name: 'Rotate piece 7' }).click();

	expect(onRotate).toHaveBeenCalledWith(7);
	expect(onSelect).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Update keyboard tests to focus without clicking**

Any keyboard test that currently uses `click()` only to focus would now trigger pointer selection. Replace that setup with native focus:

```ts
const element = await page.getByTestId('puzzle-piece').element();
element.focus();
element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
```

Keep selected Enter/Space cancellation assertions. Remove dead drag-callback assertions.

- [ ] **Step 3: Reduce drag tests to the actual desktop contract**

```ts
it('starts a desktop drag with the piece id in the payload', async () => {
	render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });
	const dataTransfer = new DataTransfer();
	const piece = await page.getByTestId('puzzle-piece').element();

	piece.dispatchEvent(
		new DragEvent('dragstart', {
			bubbles: true,
			cancelable: true,
			dataTransfer
		})
	);

	expect(dataTransfer.getData('text/plain')).toBe('7');
	expect(dataTransfer.effectAllowed).toBe('move');
});
```

Keep the placed-piece no-payload case.

- [ ] **Step 4: Run the component test and verify pointer tests fail**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

Expected: FAIL because click is not yet wired and touch-drag implementation still exists.

- [ ] **Step 5: Remove touch machinery and dead props**

Delete:

```ts
import { onDestroy } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
```

Delete props:

```ts
onDragStart?: (piece: PuzzlePiece) => void;
onDragMove?: (piece: PuzzlePiece, x: number, y: number) => void;
onDragEnd?: (piece: PuzzlePiece, x: number, y: number) => void;
```

Delete all touch-drag state/helpers/listeners/synthetic DataTransfer logic and `onDestroy` cleanup.

Keep only internal desktop drag payload:

```ts
function handleDragStart(event: DragEvent) {
	if (isPlaced || !event.dataTransfer) return;
	event.dataTransfer.setData('text/plain', piece.id.toString());
	event.dataTransfer.effectAllowed = 'move';
}
```

- [ ] **Step 6: Replace `keydownAction` with one non-delegated click + keydown action**

```ts
function handleKeyDown(event: KeyboardEvent) {
	if (isPlaced) return;
	if (rotationEnabled && (event.key === 'r' || event.key === 'R')) {
		event.preventDefault();
		onRotate?.(piece.id);
		return;
	}
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();

	if (selected) onCancelSelection?.();
	else onSelect?.(piece.id);
}

function handleClick() {
	if (isPlaced) return;
	onSelect?.(piece.id);
}

function interactionAction(node: HTMLElement) {
	node.addEventListener('click', handleClick);
	node.addEventListener('keydown', handleKeyDown);
	return {
		destroy() {
			node.removeEventListener('click', handleClick);
			node.removeEventListener('keydown', handleKeyDown);
		}
	};
}
```

Piece markup becomes:

```svelte
<div
	class="puzzle-piece h-full w-full cursor-grab transition-transform select-none hover:scale-105 focus:outline-hidden"
	class:opacity-50={isPlaced}
	class:cursor-not-allowed={isPlaced}
	class:ring-2={selected}
	class:ring-blue-400={selected}
	draggable={!isPlaced}
	ondragstart={handleDragStart}
	use:interactionAction
	role="button"
	...
>
```

Remove `ontouchstart`, `touch-none`, touch-drag classes/transforms, and `.piece-shadow-wrapper.dragging`.

- [ ] **Step 7: Extend the existing coarse-pointer global rule**

In `apps/web/src/routes/layout.css`, keep current 44px targets and add one line:

```css
@media (pointer: coarse) {
	.puzzle-piece {
		min-width: 44px;
		min-height: 44px;
		-webkit-user-drag: none;
	}

	.drop-zone {
		min-width: 44px;
		min-height: 44px;
	}
}
```

Do not add `matchMedia`, pointer state, or a new global selector.

- [ ] **Step 8: Run focused test + package check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  src/lib/components/PuzzlePiece.svelte \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/routes/layout.css
git commit -m "feat(web): make puzzle pieces tap-selectable"
```

---

### Task 2: Add native board tap placement and selection-aware pan

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`

**Interfaces:**

- Consumes existing `selectedPieceId: number | null` and `onPiecePlaced(pieceId, x, y)`.
- Drop-zone native action has **no parameter**; it reads `node.dataset.x` / `node.dataset.y`.
- One click/tap -> one `placePiece()` call when selected; no selection -> no-op.
- `PuzzleBoardPanel.canPanBoard` requires no selection.

- [ ] **Step 1: Add failing board click tests**

```ts
it('routes selected click exactly once without pre-validating correctness', async () => {
	const puzzle = createMockPuzzle(3);
	const onPiecePlaced = vi.fn();
	render(PuzzleBoard, {
		puzzle,
		placedPieces: [],
		onPiecePlaced,
		selectedPieceId: 0,
		resolveImage
	});

	await page.getByRole('button', { name: 'Drop zone at position 1, 0' }).click();

	expect(onPiecePlaced).toHaveBeenCalledTimes(1);
	expect(onPiecePlaced).toHaveBeenCalledWith(0, 1, 0);
});

it('does nothing on cell click without a selected piece', async () => {
	const onPiecePlaced = vi.fn();
	render(PuzzleBoard, {
		puzzle: createMockPuzzle(3),
		placedPieces: [],
		onPiecePlaced,
		selectedPieceId: null,
		resolveImage
	});

	await page.getByRole('button', { name: 'Drop zone at position 0, 0' }).click();
	expect(onPiecePlaced).not.toHaveBeenCalled();
});
```

Retain keyboard and drop tests.

- [ ] **Step 2: Run board suite and verify click path fails**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: FAIL on new click cases.

- [ ] **Step 3: Add local drop-zone action reading existing data attributes**

Keep `placePiece()` and `handleKeyDown()` correctness-free. Add:

```ts
function dropZoneInteraction(node: HTMLElement) {
	function coordinates(): { x: number; y: number } {
		return {
			x: Number(node.dataset.x),
			y: Number(node.dataset.y)
		};
	}

	function handleClick() {
		if (selectedPieceId === null) return;
		const { x, y } = coordinates();
		placePiece(selectedPieceId, x, y);
	}

	function handleKeydown(event: KeyboardEvent) {
		const { x, y } = coordinates();
		handleKeyDown(event, x, y);
	}

	node.addEventListener('click', handleClick);
	node.addEventListener('keydown', handleKeydown);
	return {
		destroy() {
			node.removeEventListener('click', handleClick);
			node.removeEventListener('keydown', handleKeydown);
		}
	};
}
```

Drop-zone markup keeps the existing attributes and uses the action without a parameter:

```svelte
<div
	class="drop-zone ..."
	ondragover={(event) => handleDragOver(event, x, y)}
	ondragleave={handleDragLeave}
	ondrop={(event) => handleDrop(event, x, y)}
	use:dropZoneInteraction
	data-testid="drop-zone"
	data-x={x}
	data-y={y}
	...
>
```

Remove delegated `onkeydown` from the node.

- [ ] **Step 4: Run board suite**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: PASS for click, keyboard, and desktop drop.

- [ ] **Step 5: Add failing pan-selection tests**

Add:

```ts
it('does not start pan while a piece is selected', async () => {
	render(PuzzleBoardPanel, props({ selectedPieceId: 0 }));
	await page.getByLabelText('Zoom in').click();
	const board = await page.getByTestId('puzzle-board').element();

	board.dispatchEvent(new PointerEvent('pointerdown', {
		bubbles: true,
		pointerId: 30,
		pointerType: 'touch',
		button: 0,
		clientX: 100,
		clientY: 100
	}));

	await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
});

it('cancels a real active pan when selection begins', async () => {
	const input = props();
	const view = render(PuzzleBoardPanel, input);
	const frame = await beginRealPan(31);

	await view.rerender({ ...input, selectedPieceId: 0 });
	await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	const transformAfterSelection = transformOf(frame);

	window.dispatchEvent(new PointerEvent('pointermove', {
		pointerId: 31,
		pointerType: 'mouse',
		clientX: 400,
		clientY: 350
	}));

	await expect.poll(() => transformOf(frame)).toBe(transformAfterSelection);
});

it('allows pan again after selection clears', async () => {
	const input = props({ selectedPieceId: 0 });
	const view = render(PuzzleBoardPanel, input);
	await page.getByLabelText('Zoom in').click();
	await view.rerender({ ...input, selectedPieceId: null });
	const board = await page.getByTestId('puzzle-board').element();

	board.dispatchEvent(new PointerEvent('pointerdown', {
		bubbles: true,
		pointerId: 32,
		pointerType: 'mouse',
		button: 0,
		clientX: 100,
		clientY: 100
	}));

	await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 32, pointerType: 'mouse' }));
});
```

- [ ] **Step 6: Run panel suite and verify new cases fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

Expected: FAIL on selection pan cases; existing pan/reset/reclamp tests remain green.

- [ ] **Step 7: Extend existing pan guard/effect**

```ts
const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
```

```ts
$effect(() => {
	if (interactionBlocked || selectedPieceId !== null) cancelPan();
});
```

No other zoom/pan ownership changes.

- [ ] **Step 8: Run both suites + check**

```bash
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/PuzzleBoardPanel.svelte \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
git commit -m "feat(web): add tap-to-place board interaction"
```

---

### Task 3: Add the binary inventory drawer inside the existing route grid

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte` (CSS only)

**Interfaces:**

- Consumes existing `selectedPieceId` and `onCancelSelection`.
- Produces private `let drawerOpen = $state(true)`.
- Produces `data-testid="inventory-drawer-toggle"`, `data-testid="puzzle-inventory-panel"`, `id="puzzle-inventory-body"`.
- Route remains layout owner; inventory remains a normal grid item.

- [ ] **Step 1: Add failing component tests for Cancel and binary state**

```ts
it('shows Cancel only while selected and forwards it', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);

	expect(page.getByRole('button', { name: 'Cancel selected piece' }).query()).toBeNull();
	await view.rerender({ ...input, selectedPieceId: 1 });
	await page.getByRole('button', { name: 'Cancel selected piece' }).click();
	expect(input.onCancelSelection).toHaveBeenCalledOnce();
});

it('starts open and toggles without recreating tray contents', async () => {
	render(PuzzleInventoryPanel, baseProps());
	const toggle = await page.getByTestId('inventory-drawer-toggle').element();

	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	expect(toggle.getAttribute('aria-controls')).toBe('puzzle-inventory-body');
	expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);

	toggle.click();
	await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false');
	expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);

	toggle.click();
	await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true');
	expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);
});

it('keeps Cancel in the header while collapsed', async () => {
	render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
	const toggle = await page.getByTestId('inventory-drawer-toggle').element();
	toggle.click();
	await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false');
	await expect.element(page.getByRole('button', { name: 'Cancel selected piece' })).toBeInTheDocument();
});
```

Keep tray order, placed filtering, hint/rejection, rotation, and all-placed cases.

- [ ] **Step 2: Run inventory suite and verify controls fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because drawer state/toggle/Cancel are absent.

- [ ] **Step 3: Add local drawer state and header controls**

```ts
let drawerOpen = $state(true);
```

Root/header shape:

```svelte
<div class="inventory-panel" class:drawer-open={drawerOpen} data-testid="puzzle-inventory-panel">
	<div class="panel-header">
		<div class="panel-heading">
			<span class="panel-tag">INVENTORY</span>
			<span class="inv-count">{puzzle.pieceCount - placedPieces.length} LEFT</span>
		</div>
		<div class="panel-actions">
			{#if selectedPieceId !== null}
				<button
					type="button"
					class="panel-action"
					aria-label="Cancel selected piece"
					onclick={onCancelSelection}
				>CANCEL</button>
			{/if}
			<button
				type="button"
				class="panel-action drawer-toggle"
				data-testid="inventory-drawer-toggle"
				aria-label={drawerOpen ? 'Collapse inventory' : 'Open inventory'}
				aria-expanded={drawerOpen}
				aria-controls="puzzle-inventory-body"
				onclick={() => (drawerOpen = !drawerOpen)}
			>{drawerOpen ? 'COLLAPSE' : 'OPEN'}</button>
		</div>
	</div>

	<div class="inventory-body" id="puzzle-inventory-body">
		<div class="pieces-grid">
			<!-- existing loop unchanged -->
		</div>
		<!-- existing ALL PIECES PLACED block -->
	</div>
</div>
```

- [ ] **Step 4: Keep the panel in flow and cap the mobile body**

Component CSS:

```css
.inventory-panel {
	box-sizing: border-box;
	max-height: 16rem;
	padding-bottom: env(safe-area-inset-bottom);
	overflow: hidden;
	background: var(--bg-1);
	border: 1px solid var(--border);
	display: flex;
	flex-direction: column;
}

.inventory-body {
	min-height: 0;
	display: flex;
	flex: 1;
	flex-direction: column;
	overflow: hidden;
}

.inventory-panel:not(.drawer-open) .inventory-body {
	display: none;
}

.pieces-grid {
	min-height: 0;
	overflow-y: auto;
	overflow-x: clip;
	flex: 1;
}

.panel-header,
.panel-heading,
.panel-actions {
	display: flex;
	align-items: center;
}

.panel-header {
	justify-content: space-between;
	gap: 0.75rem;
}

.panel-heading {
	min-width: 0;
	gap: 0.75rem;
}

.panel-actions {
	flex: 0 0 auto;
	gap: 0.5rem;
}

@media (min-width: 1024px) {
	.inventory-panel {
		max-height: none;
		padding-bottom: 0;
		overflow: visible;
	}

	.inventory-body,
	.inventory-panel:not(.drawer-open) .inventory-body {
		display: flex;
	}

	.drawer-toggle {
		display: none;
	}
}
```

There is **no** `position`, `inset`, or z-index rule for the inventory.

- [ ] **Step 5: Make the existing route grid explicitly own mobile rows**

In `+page.svelte` CSS, add `min-height: 0` to the existing main content rule:

```css
.puzzle-main {
	flex: 1;
	min-height: 0;
	padding: 1.25rem;
	overflow: auto;
}
```

Update `.game-layout` mobile shape:

```css
.game-layout {
	--piece-slot-size: 4rem;
	--inventory-gap: 0.375rem;
	--inventory-pad: 0.875rem;
	display: grid;
	grid-template-columns: 1fr;
	grid-template-rows: minmax(0, 1fr) auto;
	min-height: 0;
	gap: 1.25rem;
	max-width: min(96rem, calc(100vw - 2rem));
	margin: 0 auto;
}
```

Keep the existing desktop media rule's two columns and explicitly flatten the rows there:

```css
@media (min-width: 1024px) {
	.game-layout {
		grid-template-rows: auto;
		grid-template-columns:
			minmax(0, 1fr)
			minmax(
				17.5rem,
				calc(var(--piece-slot-size) * 3 + var(--inventory-gap) * 2 + var(--inventory-pad) * 2 + 2px)
			);
	}
}
```

Do not change route script logic or `puzzleLayout.ts` reserves.

- [ ] **Step 6: Run inventory suite + check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
```

Expected: PASS with no orphaned scoped CSS warnings.

- [ ] **Step 7: Commit**

```bash
git add \
  src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte'
git commit -m "feat(web): add in-flow mobile inventory drawer"
```

---

### Task 4: Replace touch-drag E2E APIs with cross-browser tap placement

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`
- Create: `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- Modify: `apps/web/e2e/README.md`
- Modify: `apps/web/playwright.config.ts` (comment only)

**Interfaces:**

- Removes `dragWithTouch(pieceId, x, y)` with no deprecated wrapper.
- Retargets `tapPiece(pieceId)` to `pieceSource(pieceId).getByTestId('puzzle-piece')`.
- Produces:

```ts
async placeWithTap(pieceId: number, x: number, y: number): Promise<void>
```

- One-piece tap smoke runs on `chromium-mobile` and `webkit-mobile`.
- Full HPA-219 flow is Chromium-mobile and uses browser-level CDP touch input only for the scroll gesture; tap placement still uses public locator APIs.

- [ ] **Step 1: Replace old touch-drag smoke with a failing tap smoke for both supported mobile engines**

In `gameplay-interactions.spec.ts`:

```ts
const TAP_PROJECTS = new Set(['chromium-mobile', 'webkit-mobile']);
```

Replace touch-drag smoke with:

```ts
test('tap placement places a piece @smoke @webkit-critical', async ({ gameplayPage }) => {
	test.skip(!TAP_PROJECTS.has(PROJECT()), 'tap placement runs on mobile Chromium/WebKit');
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.placeWithTap(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
});
```

Update the file comment from touch drag to tap placement.

- [ ] **Step 2: Create the failing Chromium-mobile feature flow**

Create `apps/web/e2e/gameplay-mobile-tap.spec.ts`:

```ts
import { test, expect } from './support/test';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };
const PROJECT = () => test.info().project.name;

test('mobile tap-to-place and in-flow inventory complete a puzzle @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(PROJECT() !== 'chromium-mobile', 'full HPA-219 flow is chromium-mobile');

	await gameplayPage.gotoFixture({
		seedPreferences: IMMEDIATE_START,
		completion: { kind: 'success' }
	});

	const panel = page.getByTestId('puzzle-inventory-panel');
	const toggle = page.getByTestId('inventory-drawer-toggle');
	const grid = page.locator('.pieces-grid');
	const board = page.getByTestId('puzzle-board');

	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(board).toBeVisible();
	await expect.poll(() => grid.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');

	const panelPosition = await panel.evaluate((element) => getComputedStyle(element).position);
	expect(panelPosition).toBe('static');

	const boardBox = await board.boundingBox();
	const panelBox = await panel.boundingBox();
	expect(boardBox).not.toBeNull();
	expect(panelBox).not.toBeNull();
	expect(panelBox!.y).toBeGreaterThanOrEqual(boardBox!.y + boardBox!.height - 1);

	// Prove a browser-level touch swipe that begins on a piece scrolls the tray.
	const source = gameplayPage.pieceSource(3).getByTestId('puzzle-piece');
	await expect.poll(() => grid.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
	await expect.poll(() => source.evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-user-drag'))).toBe('none');
	const sourceBox = await source.boundingBox();
	expect(sourceBox).not.toBeNull();
	const beforeScroll = await grid.evaluate((element) => element.scrollTop);
	const cdp = await page.context().newCDPSession(page);
	const x = sourceBox!.x + sourceBox!.width / 2;
	const startY = sourceBox!.y + sourceBox!.height / 2;
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x, y: startY, radiusX: 2, radiusY: 2, force: 1 }]
	});
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchMove',
		touchPoints: [{ x, y: startY - 80, radiusX: 2, radiusY: 2, force: 1 }]
	});
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchMove',
		touchPoints: [{ x, y: startY - 140, radiusX: 2, radiusY: 2, force: 1 }]
	});
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await cdp.detach();
	await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeScroll);

	// Restore the tray to the top so deterministic piece taps are visible.
	await grid.evaluate((element) => element.scrollTo({ top: 0 }));

	// Piece 0 belongs at (0, 0); reject it at (1, 1) first.
	await gameplayPage.tapPiece(0);
	const piece0 = gameplayPage.pieceSource(0).getByTestId('puzzle-piece');
	await expect(piece0).toHaveAttribute('data-selected', 'true');
	await gameplayPage.dropZone(1, 1).tap();
	await expect(gameplayPage.pieceSource(0)).toHaveClass(/rejected/);
	await expect(piece0).toHaveAttribute('data-selected', 'true');

	await gameplayPage.placeWithTap(0, 0, 0);
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(board).toBeVisible();
	await expect(toggle).toBeVisible();

	await page.getByRole('button', { name: 'Open inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	for (const piece of gameplayPage.fixture!.pieces.filter((candidate) => candidate.id !== 0)) {
		await gameplayPage.placeWithTap(piece.id, piece.correctX, piece.correctY);
	}

	await expect(page.getByTestId('celebration-modal')).toBeVisible();
	const overflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});
```

This CDP block is deliberately inline and Chromium-only; do not add a general gesture helper for one test.

- [ ] **Step 3: Run new tap specs before helper implementation**

```bash
bunx playwright test \
  e2e/gameplay-interactions.spec.ts \
  e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile --grep 'tap placement|mobile tap-to-place'
```

Expected: FAIL because `placeWithTap()` is not yet defined. The drawer/scroll UI already exists from Task 3; do not describe it as missing here.

- [ ] **Step 4: Replace the touch driver API**

In `GameplayPage`:

```ts
// --- Touch -----------------------------------------------------------------

/** Tap the actual piece control in the tray. */
async tapPiece(pieceId: number): Promise<void> {
	await this.pieceSource(pieceId).getByTestId('puzzle-piece').tap();
}

/** Select via tap, place at (x, y), and wait for an accepted placement. */
async placeWithTap(pieceId: number, x: number, y: number): Promise<void> {
	const piece = this.pieceSource(pieceId).getByTestId('puzzle-piece');
	await piece.tap();
	await expect(piece).toHaveAttribute('data-selected', 'true');
	await this.dropZone(x, y).tap();
	await expect(this.page.getByTestId(`piece-slot-${pieceId}`)).toHaveCount(0);
}
```

Delete all of `dragWithTouch()` including synthetic touch objects/events and its diagnostic `Unable to preventDefault` allowlist. No compatibility alias.

- [ ] **Step 5: Update E2E README**

In `apps/web/e2e/README.md`, under **Cross-input and dialog extension rules**, document current placement helpers:

```md
Current placement helpers:

- `placeWithMouse(pieceId, x, y)` — desktop HTML5 drag/drop; extended coverage.
- `selectAndPlaceWithKeyboard(pieceId, x, y, key)` — keyboard selection/placement.
- `placeWithTap(pieceId, x, y)` — supported mobile touch placement; kept in Chromium smoke and WebKit-critical coverage.

Direct touch drag is not a supported gameplay interaction after HPA-219; do not add or call `dragWithTouch()`.
```

Keep the existing rule that new interaction methods are verified Chromium first and retained in WebKit when reliable.

- [ ] **Step 6: Update stale Playwright comment only**

Change:

```ts
// Touch + mobile viewport semantics: the harness touch-drag and
// touch-layout paths only render under a touch-capable context.
```

To:

```ts
// Touch + mobile viewport semantics: tap interaction and mobile-layout
// paths run under a touch-capable context.
```

No config behavior change.

- [ ] **Step 7: Run Chromium feature + Chromium tap smoke**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-interactions.spec.ts --project=chromium-mobile --grep 'tap placement'
```

Expected: PASS.

- [ ] **Step 8: Run WebKit-critical tap smoke**

```bash
bunx playwright test e2e/gameplay-interactions.spec.ts --project=webkit-mobile --grep 'tap placement'
```

Expected: PASS without the old touch-drag console-error allowlist.

- [ ] **Step 9: Commit**

```bash
git add \
  e2e/support/gameplay-page.ts \
  e2e/gameplay-interactions.spec.ts \
  e2e/gameplay-mobile-tap.spec.ts \
  e2e/README.md \
  playwright.config.ts
git commit -m "test(web): cover mobile tap-to-place flow"
```

---

### Task 5: Run the complete HPA-219 verification fence

**Files:** No source changes expected. Formatting-only changes belong in their owning implementation commit.

- [ ] **Step 1: Run all four focused component suites**

From `apps/web`:

```bash
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run required Chromium smoke**

```bash
bun run test:e2e:smoke
```

Expected: PASS; mobile HPA-219 flow runs on chromium-mobile and skips desktop where explicitly gated.

- [ ] **Step 3: Run WebKit-critical lane**

```bash
bun run test:e2e:webkit
```

Expected: PASS with tap placement included through `@webkit-critical`.

- [ ] **Step 4: Run type/Svelte validation**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Run formatting + lint**

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 6: Build web package**

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 7: Verify diff scope**

From repo root:

```bash
git diff --name-only origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected implementation files, besides planning docs:

```text
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/routes/layout.css
apps/web/src/lib/components/PuzzleBoard.svelte
apps/web/src/lib/components/PuzzleBoardPanel.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/routes/puzzle/[id]/+page.svelte
apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
apps/web/e2e/support/gameplay-page.ts
apps/web/e2e/gameplay-interactions.spec.ts
apps/web/e2e/gameplay-mobile-tap.spec.ts
apps/web/e2e/README.md
apps/web/playwright.config.ts
```

`+page.svelte` must contain CSS/layout changes only. There must be no changes under:

```text
apps/web/src/lib/services/gameplay/session/
packages/
apps/api/
```

- [ ] **Step 8: Verify deletion goal / no touch-drag compatibility remains**

```bash
git grep -n 'dragWithTouch\|handleWindowTouchMove\|createDataTransfer\|SvelteMap' -- apps/web || true
```

Expected: no implementation/test-harness matches.

Inspect piece diff:

```bash
git diff origin/main...HEAD -- apps/web/src/lib/components/PuzzlePiece.svelte
```

Confirm touch machinery was deleted rather than replaced with a second gesture path.

- [ ] **Step 9: Confirm clean worktree**

```bash
git status --short
```

Expected: clean.

## Plan Self-Review

### Spec coverage

- Piece tap selection: Task 1.
- Selected-piece pointer reselect + explicit Cancel: Tasks 1/3.
- Board tap canonical placement: Task 2.
- Rejection retains / acceptance clears: existing domain, proven Task 4.
- Selection suppresses/cancels pan: Task 2.
- Binary in-flow inventory: Task 3.
- No overlay/z-index second layout: Task 3 + E2E geometry assertion.
- One-finger tray scroll: Task 1 coarse CSS + Task 4 browser-level swipe/`scrollTop` proof.
- Safe area: Task 3.
- No horizontal overflow: Task 4.
- Desktop drag/keyboard/zoom/rotation/completion preserved: Tasks 1/2 + Task 5 lanes.
- WebKit supported tap path: Task 4 + Task 5.
- E2E documentation current: Task 4.
- No global gameplay state/gesture framework: all state ownership unchanged.

### Review findings resolved

1. **Fixed overlay rejected:** inventory stays in route grid; route CSS is now intentionally in scope.
2. **Scrolling proof strengthened:** coarse pointer uses the existing CSS media block to suppress native user drag, and Chromium-mobile drives browser-level touch input to prove `scrollTop` changes.
3. **Harness contract fixed:** `placeWithTap` replaces `dragWithTouch`, tap smoke is WebKit-critical, `tapPiece` targets the real piece control, README is updated.
4. **Duplicate coordinate channel removed:** drop-zone action has no parameter and reads existing `data-x`/`data-y`.
5. **Stale sequencing text removed:** Task 4 assumes Tasks 1–3 are already applied; its expected pre-helper failure is only missing `placeWithTap`.

### Placeholder scan

No `TBD`, `TODO`, deferred implementation placeholder, generic “handle errors,” or unspecified test step remains.

### Type/interface consistency

- `placeWithTap(pieceId: number, x: number, y: number): Promise<void>` is defined once in Task 4.
- `selectedPieceId` remains `number | null` end to end.
- `onPiecePlaced(pieceId: number, x: number, y: number): void` is unchanged.
- `drawerOpen` is private component state.
- drop-zone coordinates have one DOM source: `data-x` / `data-y`.

## Execution Handoff

When implementation starts, prefer **Subagent-Driven Development** so each implementation task gets a fresh review gate. Inline execution with `superpowers:executing-plans` is the alternative. Do not combine HPA-219 with HPA-220 filters/shuffle or HPA-217 toolbar work.
