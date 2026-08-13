# HPA-219 Mobile Tap-to-Place and In-Flow Inventory Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make puzzle play practical at a 390 × 844 phone viewport using the existing selected-piece session state for tap-to-place and an in-flow, density-appropriate binary inventory drawer.

**Architecture:** `PuzzleSession` remains the only canonical gameplay state owner. `PuzzlePiece` becomes native click/tap + keyboard + desktop HTML5 drag; `PuzzleBoard` routes native cell activation through the same placement callback as keyboard/drop; `PuzzleBoardPanel` disables/cancels pan while selection is active; `PuzzleInventoryPanel` owns one ephemeral `drawerOpen` boolean and a mobile-only tray preview-size override. The route keeps board + inventory in the existing `.game-layout` flow below 1024px. The deterministic E2E harness replaces obsolete touch-drag support with `placeWithTap()`, proves real large-tray scrolling on Chromium, and keeps reliable tap placement in WebKit-critical coverage.

**Tech Stack:** Svelte 5 runes/actions, TypeScript 5.9, Vitest Browser Mode, Playwright 1.57, Bun 1.3, existing `PuzzleSession`, existing deterministic gameplay E2E harness.

## Global Constraints

- `PuzzleSessionState.selectedPieceId` remains the only selected-piece state.
- Accepted placement clears selection through the existing session transition; rejected placement keeps it through the existing transition.
- Add no route-local selection/touch state, no new session action, no persistence field, and no shared-domain/API change.
- `drawerOpen` is the only new runtime state and stays private to `PuzzleInventoryPanel`.
- Direct touch drag is removed. Do not add drag thresholds, long-press classification, pinch zoom, two-finger pan, haptics, or an input/gesture framework.
- Preserve desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar/wheel zoom, rotation, completion, and session controls.
- Below 1024px, board and inventory remain two rows of the existing route grid. Do not use `position: fixed`, `sticky`, absolute positioning, or gameplay z-index for the inventory.
- Mobile tray preview size is `clamp(3rem, 16vw, 4.5rem)` below 1024px only; desktop continues inheriting the route's board-derived `--piece-slot-size`.
- Open mobile inventory starts with `max-height: 16rem`, but rendered 390 × 844 geometry—not `getHeightReserve()` arithmetic—is authoritative.
- `CANCEL` is visible whenever a piece is selected, including collapsed mobile state.
- Extend the existing global `@media (pointer: coarse)` `.puzzle-piece` rule with `-webkit-user-drag: none`; do not add media-query JS state.
- Do not add computed-style E2E assertions for `overflow-y` or `-webkit-user-drag`; behavior is proven by rendered density/fit and a real browser-level swipe.
- Reuse `e2e-square-4`, `e2e-square-100`, `chromium-mobile` (390 × 844), and `webkit-mobile`; do not add fixtures or projects.
- Native tap smoke is tagged `@smoke @webkit-critical`; the full HPA-219 completion flow remains Chromium-mobile only.
- Update `apps/web/e2e/README.md` with the supported tap helper in the same E2E commit.
- No fixed sleeps.
- No backward-compatibility wrapper for removed touch-drag behavior.

## File Structure

### Production/layout

- Modify `apps/web/src/lib/components/PuzzlePiece.svelte` — delete bespoke touch drag/dead callbacks; add native click selection; retain keyboard + desktop drag payload.
- Modify `apps/web/src/routes/layout.css` — add coarse-pointer `-webkit-user-drag: none` to the existing `.puzzle-piece` rule.
- Modify `apps/web/src/lib/components/PuzzleBoard.svelte` — native click/keydown action reads existing `data-x` / `data-y` and routes through `placePiece()`; existing drag/drop closures remain.
- Modify `apps/web/src/lib/components/PuzzleBoardPanel.svelte` — selection-aware pan eligibility/cancellation.
- Modify `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — local drawer state, Cancel, mobile preview sizing, height-capped scroll body, safe-area padding; remains in flow.
- Modify `apps/web/src/routes/puzzle/[id]/+page.svelte` — responsive grid-row CSS only; no route script/session logic.

### Component tests

- Modify `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`.

### E2E/support/docs

- Create `apps/web/e2e/gameplay-mobile-tap.spec.ts` in Task 3 with layout/density/scroll tests, then extend it in Task 4 with the completion flow.
- Modify `apps/web/e2e/support/gameplay-page.ts` — remove `dragWithTouch()`, retarget `tapPiece()`, add `placeWithTap()`.
- Modify `apps/web/e2e/gameplay-interactions.spec.ts` — replace touch-drag smoke with Chromium/WebKit tap smoke.
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

Strengthen rotation activation:

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

Expected: FAIL because click is not yet wired and the old touch implementation still exists.

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

Delete all touch-drag state/helpers/listeners/synthetic `DataTransfer` logic and `onDestroy` cleanup.

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

Do not add a component/E2E computed-style assertion for this property. Task 3's large-tray swipe is the behavior proof.

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
- The new drop-zone native action has **no parameter**; its click/keydown path reads `node.dataset.x` / `node.dataset.y`.
- Existing HTML5 drag/drop handlers keep their current `(x, y)` closure parameters.
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

Retain keyboard and desktop drop tests.

- [ ] **Step 2: Run board suite and verify click path fails**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: FAIL on the new click cases.

- [ ] **Step 3: Add local drop-zone action reading the existing dataset**

Keep `placePiece()` and `handleKeyDown()` correctness-free. Add:

```ts
function dropZoneInteraction(node: HTMLElement) {
	function coordinates(): { x: number; y: number } | null {
		const x = Number(node.dataset.x);
		const y = Number(node.dataset.y);
		if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
		return { x, y };
	}

	function handleClick() {
		if (selectedPieceId === null) return;
		const cell = coordinates();
		if (!cell) return;
		placePiece(selectedPieceId, cell.x, cell.y);
	}

	function handleNativeKeyDown(event: KeyboardEvent) {
		const cell = coordinates();
		if (!cell) return;
		handleKeyDown(event, cell.x, cell.y);
	}

	node.addEventListener('click', handleClick);
	node.addEventListener('keydown', handleNativeKeyDown);
	return {
		destroy() {
			node.removeEventListener('click', handleClick);
			node.removeEventListener('keydown', handleNativeKeyDown);
		}
	};
}
```

Apply it without an action parameter:

```svelte
<div
	class="drop-zone ..."
	ondragover={(e) => handleDragOver(e, x, y)}
	ondragleave={handleDragLeave}
	ondrop={(e) => handleDrop(e, x, y)}
	use:dropZoneInteraction
	data-testid="drop-zone"
	data-x={x}
	data-y={y}
	...
>
```

Remove delegated `onkeydown`. Do not rewrite the working drag/drop coordinate closures solely for uniformity.

- [ ] **Step 4: Run the board suite**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: PASS for native click, keyboard, and desktop drop.

- [ ] **Step 5: Add failing selection-aware pan tests**

```ts
it('does not start pan while a piece is selected', async () => {
	render(PuzzleBoardPanel, props({ selectedPieceId: 0 }));
	await page.getByLabelText('Zoom in').click();
	const board = await page.getByTestId('puzzle-board').element();

	board.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 30,
			pointerType: 'touch',
			button: 0,
			clientX: 100,
			clientY: 100
		})
	);

	await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
});

it('cancels a real active pan when selection begins', async () => {
	const input = props();
	const view = render(PuzzleBoardPanel, input);
	const frame = await beginRealPan(31);

	await view.rerender({ ...input, selectedPieceId: 0 });
	await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	const selectedTransform = transformOf(frame);

	window.dispatchEvent(
		new PointerEvent('pointermove', {
			pointerId: 31,
			pointerType: 'mouse',
			clientX: 400,
			clientY: 350
		})
	);

	await expect.poll(() => transformOf(frame)).toBe(selectedTransform);
});

it('allows pan again after selection clears', async () => {
	const input = props({ selectedPieceId: 0 });
	const view = render(PuzzleBoardPanel, input);
	await page.getByLabelText('Zoom in').click();
	await view.rerender({ ...input, selectedPieceId: null });
	const board = await page.getByTestId('puzzle-board').element();

	board.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 32,
			pointerType: 'mouse',
			button: 0,
			clientX: 100,
			clientY: 100
		})
	);

	await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 32, pointerType: 'mouse' }));
});
```

- [ ] **Step 6: Run board-panel suite and verify the new cases fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

Expected: selected-piece pan cases FAIL while existing reset/reclamp tests remain green.

- [ ] **Step 7: Make pan eligibility/cancellation selection-aware**

```ts
const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
```

Extend the existing cancellation effect:

```ts
$effect(() => {
	if (interactionBlocked || selectedPieceId !== null) cancelPan();
});
```

Do not change wheel zoom, toolbar zoom, reset/reclamp, capture-phase pointer-up, blur cleanup, or viewport ownership.

- [ ] **Step 8: Run both focused suites + package check**

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

### Task 3: Add the in-flow, density-appropriate mobile inventory and verify its layout in the same commit

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte` — CSS only
- Create: `apps/web/e2e/gameplay-mobile-tap.spec.ts` — layout/density/scroll tests only in this task

**Interfaces:**

- Consumes existing `selectedPieceId` and `onCancelSelection` props.
- Produces one private state value: `let drawerOpen = $state(true)`.
- Produces `data-testid="puzzle-inventory-panel"`, `data-testid="inventory-drawer-toggle"`, and `id="puzzle-inventory-body"`.
- Below 1024px only, overrides `--piece-slot-size` with `clamp(3rem, 16vw, 4.5rem)`.
- Desktop naturally inherits the parent `.game-layout` `--piece-slot-size`; do not reset it with `initial`.
- Route script remains unchanged; route CSS owns mobile board/inventory rows.
- Task 3 owns its own target-viewport geometry proof before the layout commit lands.

- [ ] **Step 1: Add failing Cancel/drawer component tests**

```ts
it('shows Cancel only while a piece is selected and forwards it', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);

	expect(page.getByRole('button', { name: 'Cancel selected piece' }).query()).toBeNull();

	await view.rerender({ ...input, selectedPieceId: 1 });
	await page.getByRole('button', { name: 'Cancel selected piece' }).click();
	expect(input.onCancelSelection).toHaveBeenCalledOnce();
});

it('starts open and toggles binary state without changing tray contents', async () => {
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

Keep current tray-order, filtering, hint/rejection precedence, rotation, and all-pieces-placed tests.

- [ ] **Step 2: Run inventory suite and verify controls fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because drawer state/toggle/header Cancel do not exist.

- [ ] **Step 3: Add local drawer state + header controls**

Add only:

```ts
let drawerOpen = $state(true);
```

Use one rendering tree:

```svelte
<div
	class="inventory-panel"
	class:drawer-open={drawerOpen}
	data-testid="puzzle-inventory-panel"
>
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
				>
					CANCEL
				</button>
			{/if}
			<button
				type="button"
				class="panel-action drawer-toggle"
				data-testid="inventory-drawer-toggle"
				aria-label={drawerOpen ? 'Collapse inventory' : 'Open inventory'}
				aria-expanded={drawerOpen}
				aria-controls="puzzle-inventory-body"
				onclick={() => (drawerOpen = !drawerOpen)}
			>
				{drawerOpen ? 'COLLAPSE' : 'OPEN'}
			</button>
		</div>
	</div>

	<div class="inventory-body" id="puzzle-inventory-body">
		<div class="pieces-grid">
			<!-- existing piece loop unchanged -->
		</div>
		<!-- existing ALL PIECES PLACED block stays in this body -->
	</div>
</div>
```

Do not lift `drawerOpen` to the route.

- [ ] **Step 4: Add in-flow mobile CSS and decouple tray preview size**

Keep existing visual variables and add/adjust:

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

@media (max-width: 1023px) {
	.inventory-panel {
		--piece-slot-size: clamp(3rem, 16vw, 4.5rem);
	}
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

Do **not** write `--piece-slot-size: initial` on desktop; the mobile override simply does not apply there, so inheritance from `.game-layout` remains intact.

- [ ] **Step 5: Make the existing route grid own the mobile two-row layout**

In `+page.svelte` CSS only:

```css
.puzzle-main {
	min-height: 0;
	flex: 1;
	padding: 1.25rem;
	overflow: auto;
}

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

Keep the existing `@media (min-width: 1024px)` two-column rule unchanged. Do not add fixed/sticky positioning or z-index.

- [ ] **Step 6: Add the Task-3 layout E2E before committing the CSS**

Create `apps/web/e2e/gameplay-mobile-tap.spec.ts`:

```ts
import { test, expect } from './support/test';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };
const PROJECT = () => test.info().project.name;

function isChromiumMobile(): boolean {
	return PROJECT() === 'chromium-mobile';
}

test('mobile inventory fits the viewport and shows four tray slots @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(!isChromiumMobile(), 'mobile layout proof uses chromium-mobile');
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });

	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	const panel = page.getByTestId('puzzle-inventory-panel');
	const grid = page.locator('.pieces-grid');
	const viewport = page.viewportSize();
	const panelBox = await panel.boundingBox();
	const gridBox = await grid.boundingBox();

	expect(viewport).toEqual({ width: 390, height: 844 });
	expect(panelBox).not.toBeNull();
	expect(gridBox).not.toBeNull();
	expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport!.height);

	const slots = page.locator('[data-testid^="piece-slot-"]');
	const slotCount = await slots.count();
	let fullyVisible = 0;
	for (let index = 0; index < slotCount; index += 1) {
		const box = await slots.nth(index).boundingBox();
		if (
			box &&
			box.x >= gridBox!.x - 1 &&
			box.y >= gridBox!.y - 1 &&
			box.x + box.width <= gridBox!.x + gridBox!.width + 1 &&
			box.y + box.height <= gridBox!.y + gridBox!.height + 1
		) {
			fullyVisible += 1;
		}
	}

	expect(fullyVisible).toBeGreaterThanOrEqual(4);
});

test('large mobile inventory scrolls from a swipe starting on a piece @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(!isChromiumMobile(), 'browser-level touch swipe uses Chromium CDP');
	await gameplayPage.gotoFixture({
		fixtureId: 'e2e-square-100',
		seedPreferences: IMMEDIATE_START
	});

	const grid = page.locator('.pieces-grid');
	const firstPieceId = gameplayPage.fixture!.initialTrayOrder[0]!;
	const piece = gameplayPage.pieceSource(firstPieceId).getByTestId('puzzle-piece');
	const pieceBox = await piece.boundingBox();
	const gridBox = await grid.boundingBox();
	expect(pieceBox).not.toBeNull();
	expect(gridBox).not.toBeNull();

	const before = await grid.evaluate((element) => element.scrollTop);
	const x = pieceBox!.x + pieceBox!.width / 2;
	const startY = pieceBox!.y + pieceBox!.height / 2;
	const endY = Math.max(gridBox!.y + 16, startY - 140);
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x, y: startY, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
		});
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x, y: (startY + endY) / 2, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
		});
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x, y: endY, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
		});
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} finally {
		await cdp.detach();
	}

	await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
});
```

The 4-piece fixture proves density + fit. The 100-piece fixture proves scroll because a corrected 4-piece tray should no longer need scrolling.

Do not add computed-style checks for `overflowY` or `webkitUserDrag`.

- [ ] **Step 7: Run component + layout verification**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
```

Expected: component tests PASS; both 390 × 844 layout tests PASS, including `panelBottom <= 844`, at least four visible square-4 slots, and real 100-piece swipe scrolling.

If the panel-bottom assertion fails, adjust the HPA-219 local tray/layout sizing before committing. Do not weaken or delete the geometry assertion.

- [ ] **Step 8: Commit the self-verifying layout slice**

```bash
git add \
  src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  e2e/gameplay-mobile-tap.spec.ts
git commit -m "feat(web): add mobile puzzle inventory drawer"
```

---

### Task 4: Replace obsolete touch-drag E2E support with cross-browser tap placement and complete the mobile flow

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`
- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- Modify: `apps/web/e2e/README.md`
- Modify: `apps/web/playwright.config.ts` — comment only

**Interfaces:**

- Removes `dragWithTouch(pieceId, x, y)` with no compatibility wrapper.
- Keeps `tapPiece(pieceId)` but targets the nested `puzzle-piece` control explicitly.
- Produces accepted-placement helper:

```ts
async placeWithTap(pieceId: number, x: number, y: number): Promise<void>
```

- `placeWithTap` selects through the rendered UI, asserts selection, taps the target, and waits for that tray slot to detach.
- Tests pair accepted calls with `expectPiecePlaced(pieceId, x, y)` when board location matters.
- Rejected placement stays inline because rejection intentionally keeps the slot attached and selected.

- [ ] **Step 1: Replace the obsolete touch-drag smoke with the new cross-browser contract**

In `gameplay-interactions.spec.ts`, replace the old Chromium-only touch-drag test with:

```ts
test('tap placement places a piece @smoke @webkit-critical', async ({ gameplayPage }) => {
	const project = PROJECT();
	test.skip(
		project !== 'chromium-mobile' && project !== 'webkit-mobile',
		'tap placement is retained on mobile Chromium and WebKit'
	);

	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.placeWithTap(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
});
```

Update the file header from supported touch drag to tap placement.

- [ ] **Step 2: Extend the existing Task-3 mobile spec with the feature flow**

Append:

```ts
test('mobile tap-to-place and drawer complete a puzzle @smoke', async ({ gameplayPage, page }) => {
	test.skip(!isChromiumMobile(), 'HPA-219 feature flow uses chromium-mobile');
	await gameplayPage.gotoFixture({
		seedPreferences: IMMEDIATE_START,
		completion: { kind: 'success' }
	});

	const toggle = page.getByTestId('inventory-drawer-toggle');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('puzzle-board')).toBeVisible();

	// Piece 0 belongs at (0, 0); reject it at (1, 1).
	await gameplayPage.tapPiece(0);
	const piece0 = gameplayPage.pieceSource(0).getByTestId('puzzle-piece');
	await expect(piece0).toHaveAttribute('data-selected', 'true');
	await gameplayPage.dropZone(1, 1).tap();

	// Durable rejection contract: the slot stays and selection stays.
	await expect(gameplayPage.pieceSource(0)).toBeVisible();
	await expect(piece0).toHaveAttribute('data-selected', 'true');

	// Retrying the selected piece at its real cell succeeds and clears selection.
	await gameplayPage.placeWithTap(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);

	// Prove Cancel remains available in the collapsed header.
	await gameplayPage.tapPiece(1);
	await expect(gameplayPage.pieceSource(1).getByTestId('puzzle-piece')).toHaveAttribute(
		'data-selected',
		'true'
	);
	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	await page.getByRole('button', { name: 'Cancel selected piece' }).click();
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Open inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	const fixture = gameplayPage.fixture!;
	for (const piece of fixture.pieces.filter((candidate) => candidate.id !== 0)) {
		await gameplayPage.placeWithTap(piece.id, piece.correctX, piece.correctY);
		await gameplayPage.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
	}

	await expect(page.getByTestId('celebration-modal')).toBeVisible();
	const overflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});
```

Do **not** assert `.rejected`; its 500ms timer makes that an animation race. Do **not** repeat the computed-style assertions removed in Task 3.

- [ ] **Step 3: Run the tap specs and verify the missing helper fails**

From `apps/web` after Tasks 1–3:

```bash
bunx playwright test \
  e2e/gameplay-interactions.spec.ts \
  e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile --grep 'tap placement|mobile tap-to-place'
```

Expected: FAIL because `placeWithTap()` does not exist yet. The Task-3 layout tests themselves are already green.

- [ ] **Step 4: Remove `dragWithTouch()` and add the minimal tap helper**

Replace the touch section in `GameplayPage` with:

```ts
// --- Touch -----------------------------------------------------------------

/** Tap the actual piece control in the tray. */
async tapPiece(pieceId: number): Promise<void> {
	await this.pieceSource(pieceId).getByTestId('puzzle-piece').tap();
}

/**
 * Select a piece via tap and attempt accepted placement at (x, y).
 * The caller uses expectPiecePlaced when it needs to prove board location.
 */
async placeWithTap(pieceId: number, x: number, y: number): Promise<void> {
	const piece = this.pieceSource(pieceId).getByTestId('puzzle-piece');
	await piece.tap();
	await expect(piece).toHaveAttribute('data-selected', 'true');
	await this.dropZone(x, y).tap();
	await expect(this.page.getByTestId(`piece-slot-${pieceId}`)).toHaveCount(0);
}
```

Delete the entire `dragWithTouch()` implementation, including synthetic `Touch`, `TouchEvent`, and diagnostic allowlist behavior. Do not preserve a deprecated wrapper.

- [ ] **Step 5: Update E2E README and the stale Playwright comment**

In `e2e/README.md`, keep the existing cross-input extension rules and update touch examples/guidance to say:

```markdown
Supported touch placement uses `GameplayPage.placeWithTap(pieceId, x, y)`.
`tapPiece(pieceId)` targets the rendered puzzle-piece control for tests that
need to inspect rejection/selection before choosing another board cell.
Direct synthetic touch drag is no longer a supported interaction path.
```

Ensure the README still says new reliable touch methods stay in WebKit-critical coverage.

In `playwright.config.ts`, change only the stale comment to:

```ts
// Touch + mobile viewport semantics: tap interaction and mobile-layout
// paths are exercised under a touch-capable context.
```

Do not change projects/device settings.

- [ ] **Step 6: Run Chromium mobile feature/smoke**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-interactions.spec.ts --project=chromium-mobile --grep @smoke
```

Expected: PASS. The feature flow proves durable rejection selection, correct-cell placement for every accepted piece, drawer Cancel/open/collapse, completion, and no horizontal overflow.

- [ ] **Step 7: Run WebKit-critical tap coverage**

```bash
bunx playwright test e2e/gameplay-interactions.spec.ts --project=webkit-mobile --grep @webkit-critical
```

Expected: PASS, including the one-piece native tap placement.

- [ ] **Step 8: Commit**

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

**Files:** No source changes expected. If formatting changes files, inspect and amend the owning implementation commit rather than creating a generic cleanup commit.

**Interfaces:** Verifies component contracts, target-viewport density/fit/scroll, cross-browser tap placement, desktop regression paths, static analysis, formatting/lint, and production build.

- [ ] **Step 1: Run all four focused component suites together**

From `apps/web`:

```bash
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the dedicated Chromium mobile layout + feature suite**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
```

Expected: PASS, including:

- square-4 panel bottom inside 844px viewport;
- at least four fully visible square-4 tray slots;
- square-100 real swipe increases tray `scrollTop`;
- rejection keeps slot + selection;
- every accepted completion placement is verified at its target cell.

- [ ] **Step 3: Run required Chromium smoke and WebKit-critical lanes**

```bash
bun run test:e2e:smoke
bun run test:e2e:webkit
```

Expected: PASS. The native tap smoke runs on `chromium-mobile` and `webkit-mobile`; explicitly mobile-only feature/layout cases skip cleanly on unrelated projects.

- [ ] **Step 4: Run type/Svelte validation**

```bash
bun run check
```

Expected: PASS with no warnings/errors.

- [ ] **Step 5: Run formatting + lint**

```bash
bun run lint
```

Expected: PASS. If Prettier reports formatting only, format the listed HPA-219 files, amend their owning commit, and rerun.

- [ ] **Step 6: Build the web package**

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 7: Verify implementation scope**

From repo root:

```bash
git diff --name-only origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected implementation files besides planning docs:

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

There must be no changes under:

```text
apps/web/src/lib/services/gameplay/session/
apps/web/src/lib/services/puzzleLayout.ts
packages/
apps/api/
```

The `+page.svelte` diff must be CSS/layout-only; no route script/session orchestration changes.

- [ ] **Step 8: Verify deletion goal and no dual touch path remains**

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- apps/web/src/lib/components/PuzzlePiece.svelte
git grep -n 'dragWithTouch\|handleWindowTouchMove\|createDataTransfer\|SvelteMap' -- apps/web || true
```

Expected: no implementation/harness matches for removed direct-touch-drag machinery.

- [ ] **Step 9: Confirm clean working tree**

```bash
git status --short
```

Expected: clean.

## Plan Self-Review

### Spec coverage

- Tap piece -> selected: Task 1.
- Tap selected piece -> explicit reselect, not pointer toggle: Task 1.
- Tap board cell -> canonical placement attempt: Task 2.
- Native click/keydown uses existing `data-x` / `data-y`; existing drag/drop closures stay untouched: Task 2.
- Reject keeps selection / success clears through existing domain: Task 4 E2E.
- Selection suppresses/cancels pan: Task 2.
- Zoomed-board Cancel -> pan -> reselect tradeoff is documented rather than hidden.
- Explicit Cancel: Task 3 component + Task 4 collapsed-header flow.
- Binary open/collapsed inventory: Task 3.
- Useful mobile tray density: Task 3 mobile-only slot-size override + >=4 visible square-4 slots.
- Board/tray fit 390 × 844: Task 3 panel-bottom geometry assertion.
- One-finger large-tray scrolling: Task 1 removes custom touch drag, Task 3 proves square-100 browser-level swipe increases scrollTop.
- No tautological computed-style E2E assertions remain.
- Bottom safe area: Task 3.
- Desktop mouse drag, keyboard, zoom/pan, rotation, completion: Tasks 1–2 retain component regression tests; Task 5 smoke/build/check fence.
- Completion through tap-to-place: Task 4, with `expectPiecePlaced` after every accepted placement.
- No global state/gesture framework: all tasks stay in existing component/route/harness boundaries.
- Supported native tap path retained in WebKit: Task 4 + Task 5.

### Review resolutions embedded in the plan

- The fixed overlay remains rejected; inventory stays in flow.
- Mobile tray preview size is decoupled from board cell size below 1024px.
- Desktop does not use `--piece-slot-size: initial`; the mobile override is simply scoped out at desktop widths.
- Layout Task 3 is self-verifying through real Chromium-mobile geometry/density/scroll tests before it commits.
- The corrected 4-piece tray is expected not to scroll, so square-100 is used solely for the real swipe proof.
- Rejection E2E uses durable tray/selection state, not the 500ms `.rejected` class.
- Native click/keydown reads dataset coordinates; the plan no longer claims drag/drop shares that source.
- Computed `overflow-y` / `-webkit-user-drag` assertions are absent.
- Final completion placements are paired with `expectPiecePlaced`.

### Placeholder scan

No `TBD`, `TODO`, deferred implementation placeholder, generic “handle errors,” or unspecified test step remains.

### Type/interface consistency

- `placeWithTap(pieceId: number, x: number, y: number): Promise<void>` is defined once in Task 4.
- `selectedPieceId` remains `number | null` end to end.
- `onPiecePlaced(pieceId: number, x: number, y: number): void` remains unchanged.
- `drawerOpen` is private component state and is not added to any prop/domain interface.
- `inventory-drawer-toggle`, `puzzle-inventory-panel`, and `puzzle-inventory-body` names are consistent across component tests and E2E.
- `e2e-square-4` owns density/fit/completion; `e2e-square-100` owns scroll proof only.

## Execution Handoff

When implementation starts, prefer **Subagent-Driven Development** so each implementation task receives a fresh review gate. The alternative is **Inline Execution** with `superpowers:executing-plans` and checkpoints after each task. Do not combine HPA-219 with HPA-220 filters/shuffle or HPA-217 toolbar work.