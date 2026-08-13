# HPA-219 Mobile Tap-to-Place and Simple Inventory Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make puzzle play practical at a 390 × 844 phone viewport by using the existing selected-piece session state for tap-to-place and presenting the existing inventory as one binary bottom drawer.

**Architecture:** `PuzzleSession` remains the only canonical gameplay state owner. `PuzzlePiece` becomes a simple native click/tap + keyboard + desktop HTML5 drag input surface; `PuzzleBoard` routes selected-piece click/tap through the same placement callback as keyboard/drop; `PuzzleBoardPanel` disables/cancels pan while selection is active; `PuzzleInventoryPanel` owns one ephemeral `drawerOpen` boolean and responsive drawer CSS. The existing deterministic E2E harness is reused; the obsolete touch-drag helper/smoke path is removed in the same change because direct touch drag is intentionally no longer supported.

**Tech Stack:** Svelte 5 runes/actions, TypeScript 5.9, Vitest Browser Mode, Playwright 1.57, Bun 1.3, existing `PuzzleSession` and deterministic gameplay E2E harness.

## Global Constraints

- `PuzzleSessionState.selectedPieceId` remains the only selected-piece state.
- Accepted placement clears the selected piece through the existing session transition; rejected placement keeps it through the existing session transition.
- Add no route-local mobile/touch state, no new session action, no persistence field, and no shared-domain/API change.
- `drawerOpen` is the only new state and stays private to `PuzzleInventoryPanel`.
- Direct touch drag is removed; do not add long-press, drag thresholds, gesture arbitration, pinch zoom, two-finger pan, haptics, or a generalized input/gesture layer.
- Preserve desktop HTML5 mouse drag/drop, keyboard selection/placement, toolbar/wheel zoom, rotation, completion, and session controls.
- Below 1024px, the inventory is a fixed binary bottom drawer; at/above 1024px, it remains the current static side panel.
- Mobile drawer starts open, caps itself at `min(42svh, 26rem)`, keeps the header visible while collapsed, and respects `env(safe-area-inset-bottom)`.
- `CANCEL` is visible whenever a piece is selected, including when the mobile drawer is collapsed.
- Mobile inventory scrolling uses native browser scrolling; do not call `preventDefault()` from piece touch handlers or add `touch-none` to inventory pieces.
- Reuse `e2e-square-4` and the existing `chromium-mobile` project (390 × 844, `hasTouch: true`, `isMobile: true`).
- Use focused component tests plus one HPA-219 mobile E2E; do not add another fixture, browser project, test controller, or fixed sleep.
- No backward-compatibility shim is required for the removed pre-release touch-drag behavior.

## File Structure

### Production components

- Modify `apps/web/src/lib/components/PuzzlePiece.svelte` — remove bespoke touch drag/dead drag callbacks; add native click/tap selection while keeping keyboard + HTML5 drag.
- Modify `apps/web/src/lib/components/PuzzleBoard.svelte` — route native click/tap on a cell through the existing `placePiece()` helper when a piece is selected.
- Modify `apps/web/src/lib/components/PuzzleBoardPanel.svelte` — make pan unavailable while a piece is selected and cancel active pan when selection begins.
- Modify `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — add local binary drawer state, Cancel action, responsive fixed-bottom presentation, safe-area padding, and native scrolling containment.

### Component tests

- Modify `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`.
- Modify `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`.

### E2E support/tests

- Modify `apps/web/e2e/support/gameplay-page.ts` — remove `dragWithTouch()` and add accepted-placement `placeWithTap()`.
- Modify `apps/web/e2e/gameplay-interactions.spec.ts` — replace the obsolete touch-drag smoke with tap-placement smoke.
- Create `apps/web/e2e/gameplay-mobile-tap.spec.ts` — HPA-219 end-to-end mobile flow.
- Modify `apps/web/playwright.config.ts` — update only the stale chromium-mobile comment from touch-drag wording to tap/mobile-layout wording; no project behavior changes.

### Explicitly unchanged

- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/lib/services/gameplay/session/**`
- persistence/statistics/API/shared-domain packages
- deterministic fixture catalog/builders

---

### Task 1: Simplify `PuzzlePiece` into native tap/click + keyboard + desktop drag

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`

**Interfaces:**

- Consumes existing controlled props: `piece`, `isPlaced`, `resolveImage`, `rotationEnabled`, `rotation`, `onRotate`, `selected`, `onSelect`, `onCancelSelection`.
- Removes unused callback props: `onDragStart`, `onDragMove`, `onDragEnd`. Repository search shows no production consumer; their only live references are inside `PuzzlePiece` and its tests.
- Produces native pointer contract: clicking/tapping an unplaced piece calls `onSelect(piece.id)` exactly once even when that piece is already selected.
- Preserves keyboard contract: Enter/Space selects an unselected piece and cancels an already-selected piece.
- Preserves HTML5 drag contract: `dragstart` writes `piece.id` to `text/plain` and sets `effectAllowed = 'move'`.

- [ ] **Step 1: Delete touch-drag-only test scaffolding and add failing native-click tests**

Remove `afterEach`, `makeTouch`, `makeTouchList`, `dispatchTouch`, `appendDropZone`, the two synthetic touch-drag tests, and any `vi.stubGlobal` cleanup that is now unused.

Add pointer tests under `selection state`:

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

it('keeps pointer selection explicit: clicking an already-selected piece selects again instead of cancelling', async () => {
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

Add the native scrolling regression fence:

```ts
it('does not prevent the browser default touchstart gesture', async () => {
	render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });
	const piece = await page.getByTestId('puzzle-piece').element();
	const event = new Event('touchstart', { bubbles: true, cancelable: true });

	piece.dispatchEvent(event);

	expect(event.defaultPrevented).toBe(false);
});
```

Strengthen rotation activation so it cannot accidentally select:

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

- [ ] **Step 2: Update keyboard tests so focus does not trigger the new click behavior**

Every keyboard test that currently uses `await el.click()` only to obtain focus must use DOM focus instead:

```ts
const el = await page.getByTestId('puzzle-piece').element();
el.focus();
el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
```

Keep these assertions:

```ts
expect(onSelect).toHaveBeenCalledWith(7);
```

For an already-selected piece, keep:

```ts
expect(onCancelSelection).toHaveBeenCalledOnce();
```

Remove all `onDragStart` expectations from keyboard tests; it has no production consumer and is not gameplay state.

- [ ] **Step 3: Reduce desktop drag tests to the actual public behavior**

Keep the unplaced-piece payload case but remove callback assertions:

```ts
it('starts a desktop drag with the piece id in the drag payload', async () => {
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

Keep the placed-piece case and assert only that no payload is written.

- [ ] **Step 4: Run the focused test and verify the new pointer contract fails**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

Expected: FAIL because click does not yet call `onSelect`, and the old touch handler still prevents default.

- [ ] **Step 5: Remove the bespoke touch-drag state, imports, helpers, and dead callback props**

Delete these imports:

```ts
import { onDestroy } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
```

Delete these props from `Props` and `$props()` destructuring:

```ts
onDragStart?: (piece: PuzzlePiece) => void;
onDragMove?: (piece: PuzzlePiece, x: number, y: number) => void;
onDragEnd?: (piece: PuzzlePiece, x: number, y: number) => void;
```

Delete all touch-drag state and helpers:

```ts
isTouchDragging
touchTranslateX
touchTranslateY
activeTouchId
startClientX
startClientY
lastClientX
lastClientY
activeDropZone
touchListenersAttached
getTouchById
getDropZoneAtPoint
createDataTransfer
dispatchSyntheticDragEvent
cleanupTouchListeners
resetTouchDragState
handleWindowTouchMove
handleWindowTouchEnd
handleTouchStart
onDestroy(...)
```

Keep `handleDragStart`, but make it internal-only:

```ts
function handleDragStart(event: DragEvent) {
	if (isPlaced || !event.dataTransfer) return;

	event.dataTransfer.setData('text/plain', piece.id.toString());
	event.dataTransfer.effectAllowed = 'move';
}
```

- [ ] **Step 6: Replace `keydownAction` with one local non-delegated interaction action**

Keep the existing keyboard semantics, but remove the dead `onDragStart` call:

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

	if (selected) {
		onCancelSelection?.();
	} else {
		onSelect?.(piece.id);
	}
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

Use the action on the piece element:

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

Remove:

```svelte
ontouchstart={handleTouchStart}
class:cursor-grabbing={isTouchDragging}
touch-none
```

Make the outer wrapper static again:

```svelte
<div class="puzzle-piece-wrapper relative h-full w-full">
```

Remove `class:dragging={isTouchDragging}` and delete the `.piece-shadow-wrapper.dragging` CSS rule.

The rotate button may drop its touch-drag-only `ontouchstart={stopRotateEventPropagation}` hook; keep its existing click/keyboard behavior.

- [ ] **Step 7: Run the focused test and package check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
bun run check
```

Expected: PASS with no Svelte warnings about removed props/listeners.

- [ ] **Step 8: Commit the self-contained piece-input simplification**

```bash
git add \
  src/lib/components/PuzzlePiece.svelte \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
git commit -m "feat(web): make puzzle pieces tap-selectable"
```

---

### Task 2: Add board tap placement and make pan selection-aware

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`

**Interfaces:**

- Consumes existing `selectedPieceId: number | null` and `onPiecePlaced(pieceId, x, y)`.
- Produces one cell activation rule: click/tap calls `placePiece(selectedPieceId, x, y)` exactly once when selected; otherwise no-op.
- `PuzzleBoard` still does no correctness/rotation pre-validation.
- `PuzzleBoardPanel.canPanBoard` becomes true only when `selectedPieceId === null` and zoom exceeds fit.
- Selection beginning during an active pan cancels that pan immediately.

- [ ] **Step 1: Add failing selected-cell click tests to `PuzzleBoard.svelte.test.ts`**

Add a wrong-coordinate test so it proves the board does not pre-filter:

```ts
it('routes a selected-piece click attempt exactly once without pre-validating correctness', async () => {
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

it('does nothing on cell click when no piece is selected', async () => {
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

Keep the existing keyboard and drag/drop tests unchanged.

- [ ] **Step 2: Run the board test and verify click placement fails**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: FAIL because drop zones have keyboard/drop handlers only.

- [ ] **Step 3: Put click + keydown on one local native drop-zone action**

Keep the existing `placePiece()` helper unchanged. Replace delegated per-cell `onkeydown` with a local action:

```ts
function dropZoneInteraction(node: HTMLElement, coords: { x: number; y: number }) {
	const handleClick = () => {
		if (selectedPieceId === null) return;
		placePiece(selectedPieceId, coords.x, coords.y);
	};
	const handleKeydown = (event: KeyboardEvent) => {
		handleKeyDown(event, coords.x, coords.y);
	};

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

Apply it to each drop zone:

```svelte
<div
	class="drop-zone ..."
	ondragover={(e) => handleDragOver(e, x, y)}
	ondragleave={handleDragLeave}
	ondrop={(e) => handleDrop(e, x, y)}
	use:dropZoneInteraction={{ x, y }}
	data-testid="drop-zone"
	...
>
```

Do not add cell correctness, occupancy, or rotation checks; session dispatch remains authoritative.

- [ ] **Step 4: Run the board test and verify all three input paths pass**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: PASS for native click, keyboard, and desktop drop.

- [ ] **Step 5: Add failing selection-aware pan tests**

Add to `PuzzleBoardPanel.svelte.test.ts`:

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
```

Add active-pan cancellation and stale-move fencing:

```ts
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
```

Add re-enable coverage:

```ts
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

- [ ] **Step 6: Run the board-panel suite and verify the new tests fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

Expected: the selected-piece pan cases FAIL while existing pan/reset/reclamp tests stay green.

- [ ] **Step 7: Make `canPanBoard` and pan cleanup selection-aware**

Change the derived pan guard:

```ts
const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
```

Extend the existing interaction-block effect rather than adding another ownership layer:

```ts
$effect(() => {
	if (interactionBlocked || selectedPieceId !== null) cancelPan();
});
```

Do not change wheel zoom, toolbar zoom, reset/reclamp, capture-phase pointer-up, blur cleanup, or viewport ownership.

- [ ] **Step 8: Run both focused suites and package check**

```bash
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit board tap placement and pan arbitration together**

```bash
git add \
  src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleBoard.svelte.test.ts \
  src/lib/components/PuzzleBoardPanel.svelte \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
git commit -m "feat(web): add tap-to-place board interaction"
```

---

### Task 3: Turn `PuzzleInventoryPanel` into a binary mobile drawer with explicit Cancel

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**

- Consumes existing `selectedPieceId` and `onCancelSelection` props.
- Produces one private state value: `let drawerOpen = $state(true)`.
- Produces mobile toggle selector: `data-testid="inventory-drawer-toggle"`.
- Produces body anchor: `id="puzzle-inventory-body"`.
- Keeps exactly one inventory rendering tree; no separate mobile component/markup.
- Desktop body is always visible even if mobile `drawerOpen` was previously false.

- [ ] **Step 1: Add failing Cancel and drawer-state component tests**

Add Cancel coverage:

```ts
it('shows Cancel only while a piece is selected and forwards it', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);

	expect(page.getByRole('button', { name: 'Cancel selected piece' }).query()).toBeNull();

	await view.rerender({ ...input, selectedPieceId: 1 });
	await page.getByRole('button', { name: 'Cancel selected piece' }).click();
	expect(input.onCancelSelection).toHaveBeenCalledOnce();
});
```

Add binary drawer-state coverage without depending on the component-test viewport's media-query result:

```ts
it('starts open and toggles the binary drawer state without changing tray contents', async () => {
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
```

Prove Cancel remains in the header after collapse:

```ts
it('keeps Cancel available when the selected mobile drawer state is collapsed', async () => {
	render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
	const toggle = await page.getByTestId('inventory-drawer-toggle').element();
	toggle.click();
	await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false');

	await expect.element(page.getByRole('button', { name: 'Cancel selected piece' })).toBeInTheDocument();
});
```

Keep all current tray-order, placed-piece filtering, hint/rejection precedence, rotation, and all-pieces-placed tests.

- [ ] **Step 2: Run the focused inventory test and verify the new controls fail**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because there is no drawer state/toggle or header Cancel button.

- [ ] **Step 3: Add the one local drawer state and header action group**

Add only:

```ts
let drawerOpen = $state(true);
```

Change the panel/header skeleton to:

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
		<!-- existing ALL PIECES PLACED block stays here -->
	</div>
</div>
```

Do not lift `drawerOpen` to the route and do not add a prop/callback for it.

- [ ] **Step 4: Add mobile-first drawer layout while preserving desktop side-panel behavior**

Use the existing 1024px breakpoint. The key CSS should be:

```css
.inventory-panel {
	position: fixed;
	inset-inline: 0;
	bottom: 0;
	z-index: 40;
	box-sizing: border-box;
	width: 100%;
	max-height: min(42svh, 26rem);
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

.panel-action {
	border: 1px solid var(--border);
	padding: 0.3rem 0.5rem;
	background: var(--bg-2);
	font-family: var(--font-mono);
	font-size: 0.55rem;
	letter-spacing: 0.1em;
	color: var(--text-1);
}

@media (min-width: 1024px) {
	.inventory-panel {
		position: static;
		inset: auto;
		z-index: auto;
		width: auto;
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

Preserve existing piece-grid sizing variables, tray order, rejected/hinted styling, and reduced-motion rules. Do not add a drag handle, transform animation, body scroll lock, or route padding compensation.

- [ ] **Step 5: Run the inventory suite and warning-strict package check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bun run check
```

Expected: PASS. `svelte-check` must report no orphaned scoped selector after wrapping the body.

- [ ] **Step 6: Commit the inventory drawer independently**

```bash
git add \
  src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "feat(web): add mobile puzzle inventory drawer"
```

---

### Task 4: Replace obsolete touch-drag E2E coverage with tap placement and add the HPA-219 mobile flow

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`
- Create: `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- Modify: `apps/web/playwright.config.ts` (comment only)

**Interfaces:**

- Removes obsolete helper: `dragWithTouch(pieceId, x, y)`.
- Keeps `tapPiece(pieceId)` but targets the nested `puzzle-piece` control explicitly.
- Produces accepted-placement helper:

```ts
async placeWithTap(pieceId: number, x: number, y: number): Promise<void>
```

- `placeWithTap` selects through the rendered UI, asserts selection, taps the target, and waits for that tray slot to detach. It is intentionally for accepted placements only.
- Rejected placement stays inline in the HPA-219 test because rejection keeps the slot attached and selected.
- Existing automatic `gameplayPage` teardown remains the diagnostics/fixture settlement fence.

- [ ] **Step 1: Replace the old touch-drag smoke expectation before changing the helper**

In `gameplay-interactions.spec.ts`, change the top comment from `supported touch drag` to `tap placement` and replace:

```ts
test('touch drag places a piece @smoke (chromium-mobile)', async ({ gameplayPage }) => {
	test.skip(PROJECT() !== 'chromium-mobile', 'touch drag tested on chromium-mobile');
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.dragWithTouch(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
});
```

with:

```ts
test('tap placement places a piece @smoke (chromium-mobile)', async ({ gameplayPage }) => {
	test.skip(PROJECT() !== 'chromium-mobile', 'tap placement tested on chromium-mobile');
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.placeWithTap(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
});
```

- [ ] **Step 2: Add the failing HPA-219 mobile feature test**

Create `apps/web/e2e/gameplay-mobile-tap.spec.ts`:

```ts
import { test, expect } from './support/test';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };
const PROJECT = () => test.info().project.name;

test('mobile tap-to-place and inventory drawer complete a puzzle @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(PROJECT() !== 'chromium-mobile', 'HPA-219 mobile flow requires chromium-mobile');

	await gameplayPage.gotoFixture({
		seedPreferences: IMMEDIATE_START,
		completion: { kind: 'success' }
	});

	const drawer = page.getByTestId('puzzle-inventory-panel');
	const toggle = page.getByTestId('inventory-drawer-toggle');
	const grid = page.locator('.pieces-grid');

	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	await expect.poll(() => grid.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');

	const viewport = page.viewportSize();
	expect(viewport).toEqual({ width: 390, height: 844 });
	const drawerBox = await drawer.boundingBox();
	expect(drawerBox).not.toBeNull();
	expect(drawerBox!.height).toBeLessThanOrEqual(Math.min(844 * 0.42, 26 * 16) + 1);

	// Piece 0 belongs at (0, 0); first try (1, 1) to prove rejection keeps selection.
	await gameplayPage.tapPiece(0);
	const piece0 = gameplayPage.pieceSource(0).getByTestId('puzzle-piece');
	await expect(piece0).toHaveAttribute('data-selected', 'true');
	await gameplayPage.dropZone(1, 1).tap();
	await expect(gameplayPage.pieceSource(0)).toHaveClass(/rejected/);
	await expect(piece0).toHaveAttribute('data-selected', 'true');

	// Accepted placement clears the canonical selection and removes the slot.
	await gameplayPage.placeWithTap(0, 0, 0);
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	await expect(toggle).toBeVisible();

	await page.getByRole('button', { name: 'Open inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	const fixture = gameplayPage.fixture!;
	for (const piece of fixture.pieces.filter((candidate) => candidate.id !== 0)) {
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

Do not call `gameplayPage.assertSettled()` manually; importing `test` from `./support/test` runs `assertSettled()` and `assertNoUnexpectedFixtureRequests()` automatically during teardown.

- [ ] **Step 3: Run the two mobile specs and verify they fail on the missing tap helper/current UI**

From `apps/web`:

```bash
bunx playwright test \
  e2e/gameplay-interactions.spec.ts \
  e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile --grep 'tap placement|mobile tap-to-place'
```

Expected: FAIL because `placeWithTap()` does not exist yet and the drawer UI is unavailable until Tasks 1–3 are applied.

- [ ] **Step 4: Remove `dragWithTouch()` and add the minimal accepted-placement tap helper**

In `GameplayPage`, keep the touch section small:

```ts
// --- Touch -----------------------------------------------------------------

/** Tap the actual piece control in the tray. */
async tapPiece(pieceId: number): Promise<void> {
	await this.pieceSource(pieceId).getByTestId('puzzle-piece').tap();
}

/**
 * Select a piece via tap and place it at (x, y). This helper is for accepted
 * placements: it waits for the tray slot to detach after tapping the target.
 */
async placeWithTap(pieceId: number, x: number, y: number): Promise<void> {
	const piece = this.pieceSource(pieceId).getByTestId('puzzle-piece');
	await piece.tap();
	await expect(piece).toHaveAttribute('data-selected', 'true');
	await this.dropZone(x, y).tap();
	await expect(this.page.getByTestId(`piece-slot-${pieceId}`)).toHaveCount(0);
}
```

Delete the entire existing `dragWithTouch()` implementation, including its synthetic `Touch`, `TouchEvent`, and diagnostic allowlist behavior. Do not preserve a deprecated wrapper.

- [ ] **Step 5: Update the stale Playwright project comment only**

In `apps/web/playwright.config.ts`, change:

```ts
// Touch + mobile viewport semantics: the harness touch-drag and
// touch-layout paths only render under a touch-capable context.
```

To:

```ts
// Touch + mobile viewport semantics: tap interaction and mobile-layout
// paths are exercised under a touch-capable context.
```

Do not change viewport, projects, device presets, retries, or web-server configuration.

- [ ] **Step 6: Run the dedicated feature E2E**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
```

Expected: PASS at 390 × 844 with rejection retention, accepted clearing, drawer collapse/open, completion, no horizontal overflow, and clean automatic diagnostics teardown.

- [ ] **Step 7: Run the existing interaction smoke on chromium-mobile**

```bash
bunx playwright test e2e/gameplay-interactions.spec.ts --project=chromium-mobile --grep @smoke
```

Expected: PASS with tap placement replacing the removed direct-touch-drag smoke.

- [ ] **Step 8: Commit E2E support and feature coverage**

```bash
git add \
  e2e/support/gameplay-page.ts \
  e2e/gameplay-interactions.spec.ts \
  e2e/gameplay-mobile-tap.spec.ts \
  playwright.config.ts
git commit -m "test(web): cover mobile tap-to-place flow"
```

---

### Task 5: Run the complete HPA-219 verification fence

**Files:** No source changes expected. If a verification command changes files through formatting, inspect and include only HPA-219-scope formatting fixes in the corresponding earlier commit rather than creating a generic cleanup commit.

**Interfaces:** Verifies that the four component boundaries, tap E2E, desktop regression paths, static analysis, formatting/lint, and production build agree with the design.

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

- [ ] **Step 2: Run the required gameplay smoke matrix**

```bash
bun run test:e2e:smoke
```

Expected: PASS. The HPA-219 scenario runs on `chromium-mobile`; desktop executions of the explicitly mobile-only case skip cleanly.

- [ ] **Step 3: Run type/Svelte validation**

```bash
bun run check
```

Expected: PASS with no warnings/errors.

- [ ] **Step 4: Run formatting + lint**

```bash
bun run lint
```

Expected: PASS. If Prettier reports formatting only, run `bunx prettier --write` on the listed HPA-219 files, amend the owning commit, and rerun this command.

- [ ] **Step 5: Build the web package**

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 6: Verify the implementation scope did not leak into route/domain/persistence/API code**

From repo root:

```bash
git diff --name-only origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected implementation files (besides the planning docs):

```text
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleBoard.svelte
apps/web/src/lib/components/PuzzleBoardPanel.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
apps/web/e2e/support/gameplay-page.ts
apps/web/e2e/gameplay-interactions.spec.ts
apps/web/e2e/gameplay-mobile-tap.spec.ts
apps/web/playwright.config.ts
```

There must be no changes under:

```text
apps/web/src/routes/puzzle/[id]/
apps/web/src/lib/services/gameplay/session/
packages/
apps/api/
```

- [ ] **Step 7: Inspect the final diff for the KISS deletion goal**

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- apps/web/src/lib/components/PuzzlePiece.svelte
```

Confirm `PuzzlePiece.svelte` has deleted the touch listener/synthetic drag machinery rather than adding a second touch mode. Search must return no production/test harness implementation references:

```bash
git grep -n 'dragWithTouch\|handleWindowTouchMove\|createDataTransfer\|SvelteMap' -- apps/web || true
```

Expected: no matches, except historical planning documents if the grep scope is broadened beyond `apps/web`.

- [ ] **Step 8: Confirm no uncommitted implementation changes remain**

```bash
git status --short
```

Expected: clean working tree.

## Plan Self-Review

### Spec coverage

- Tap piece -> selected: Task 1.
- Tap selected piece -> explicit reselect, not pointer toggle: Task 1.
- Tap board cell -> canonical placement attempt: Task 2.
- Reject keeps selection / success clears through existing domain: Task 4 E2E proves the live route/session path; no duplicate UI state is added.
- Selection suppresses/cancels pan: Task 2.
- Explicit Cancel: Task 3.
- Binary open/collapsed inventory: Task 3.
- Board remains mounted/visible while drawer overlays: Task 4 E2E.
- One-finger inventory scrolling: Task 1 removes default prevention/touch-none; Task 3 preserves `overflow-y: auto`; Task 4 verifies computed overflow.
- Bottom safe area: Task 3.
- No horizontal overflow: Task 3 containment + Task 4 E2E assertion.
- Desktop mouse drag, keyboard, zoom/pan, rotation, completion: Tasks 1–2 retain component regression tests; Task 5 smoke/build/check fence catches route-level regressions.
- Completion through tap-to-place: Task 4.
- No global state/gesture framework: all tasks stay in existing component/harness boundaries.

### Required cleanup discovered while planning

The current E2E suite contains a `dragWithTouch()` smoke test/helper. Because the approved design intentionally removes direct touch drag, Task 4 removes that obsolete helper and converts the existing smoke to tap placement. Leaving it would be contradictory dead compatibility work and would guarantee a failing smoke test.

`PuzzlePiece`'s optional `onDragStart`, `onDragMove`, and `onDragEnd` callbacks also have no production consumer. Task 1 removes them with the touch-drag implementation rather than preserving a dead component API.

### Placeholder scan

No `TBD`, `TODO`, deferred implementation placeholder, generic “handle errors,” or unspecified test step remains in this plan.

### Type/interface consistency

- `placeWithTap(pieceId: number, x: number, y: number): Promise<void>` is defined once in Task 4 and used by both mobile E2E suites.
- `selectedPieceId` remains `number | null` end to end.
- `onPiecePlaced(pieceId: number, x: number, y: number): void` remains unchanged.
- `drawerOpen` is private component state and is not added to any prop/domain interface.
- `inventory-drawer-toggle`, `puzzle-inventory-panel`, and `puzzle-inventory-body` names are consistent across component tests and E2E.

## Execution Handoff

When implementation starts, prefer **Subagent-Driven Development** so each of the four implementation tasks receives a fresh review gate. The alternative is **Inline Execution** with `superpowers:executing-plans` and checkpoints after each task. Do not combine HPA-219 with HPA-220 filters/shuffle or HPA-217 toolbar work.