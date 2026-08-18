# Gameplay Flow and Puzzle Workspace Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unnecessary Relaxed/Exit dialogs, add explicit saved-progress discard, make the desktop tray wider and resizable, generate fresh starting orientations for rotation-enabled runs, and clearly reveal the piece associated with a hint.

**Architecture:** Keep `PuzzleSession` and its persistence schema unchanged. Compose restore, exit, discard, tray resizing, and hint lifetime in the existing puzzle route; reuse one discard confirmation component from gameplay and the home page; keep orientation generation behind the existing gameplay runtime factory; let `PuzzleInventoryPanel` own drawer opening and DOM scrolling because it owns the tray scroll container.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-08-17-gameplay-flow-workspace-polish-design.md`

## Global Constraints

- Ship all five product changes as one implementation task/PR.
- Do not change `PuzzleSessionState`, session actions/events, persistence schema/version, completion sealing, or gallery validation rules.
- Keep explicit Resume Mission for restored Timed runs.
- Restored Relaxed active/paused runs must enter active gameplay with no popup.
- Exit always saves and navigates to `/`; it never offers Save versus Discard.
- Discard remains confirmed and is exposed only from the Pause/Resume surface and the home Continue on this device panel.
- Do not add per-card discard, server deletion, a saved-progress store, a generic dialog framework, or a generic resizable-panel abstraction.
- Tray width is desktop-only route-local state; do not persist it.
- Keep the `createRotations(puzzleId, pieceIds)` runtime interface and virtual E2E override unchanged.
- Do not test randomness probabilistically; mock the rotation generator.
- A hint may open/scroll the tray and move its roving tab-stop candidate, but must not call `.focus()`, `onSelect`, `onRotate`, or placement callbacks.
- Update current tests directly; do not keep compatibility aliases for `ExitSessionDialog` or its old Save/Discard/Cancel contract.

---

## Task 1: Replace the exit-choice dialog with direct Exit and explicit gameplay Discard

**Files:**

- Create: `apps/web/src/lib/components/DiscardSessionDialog.svelte`
- Delete: `apps/web/src/lib/components/ExitSessionDialog.svelte`
- Modify: `apps/web/src/lib/components/SessionPauseDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- `DiscardSessionDialog` consumes `{ puzzleName: string; onConfirm: () => void; onCancel: () => void }`.
- `SessionPauseDialog` adds `onDiscard: () => void`; all existing props stay unchanged.
- The route-local dialog union becomes `'setup' | 'pause' | 'discard' | null`.
- Exit callers use one `exitToArcade(): void` composition.

**Produces:** every existing Exit entry saves/navigates directly; gameplay has one separate confirmed destructive action.

- [ ] **Step 1: Replace dialog component tests with the new contracts**

Update the Pause fixtures in `SessionDialogs.svelte.test.ts` to include `onDiscard: vi.fn()`. Replace the `ExitSessionDialog` import/tests with `DiscardSessionDialog` and add these failing cases:

```ts
it('forwards Discard from the pause surface', async () => {
	const onDiscard = vi.fn();
	render(SessionPauseDialog, {
		presentation: 'paused',
		mode: 'timed',
		confirmingRestart: false,
		onResume: vi.fn(),
		onRequestRestart: vi.fn(),
		onConfirmRestart: vi.fn(),
		onCancelRestart: vi.fn(),
		onExit: vi.fn(),
		onDiscard
	});

	await page.getByRole('button', { name: 'Discard' }).click();
	expect(onDiscard).toHaveBeenCalledOnce();
});

it('confirms and cancels discard through separate callbacks', async () => {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	render(DiscardSessionDialog, {
		puzzleName: 'Test Mission',
		onConfirm,
		onCancel
	});

	await page.getByRole('button', { name: 'Discard' }).click();
	expect(onConfirm).toHaveBeenCalledOnce();

	const dialog = await page.getByRole('dialog', { name: 'Discard saved progress' }).element();
	dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	expect(onCancel).toHaveBeenCalledOnce();
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
```

Expected before implementation: missing component/import/prop/button failures.

- [ ] **Step 2: Create the discard-only confirmation component**

Adapt the current exit dialog shell, but expose only Cancel and Discard:

```svelte
<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';

	interface Props {
		puzzleName: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { puzzleName, onConfirm, onCancel }: Props = $props();
</script>

<div class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60">
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Discard saved progress"
		tabindex="-1"
		use:modalFocus
		onkeydown={(event) => event.key === 'Escape' && onCancel()}
		class="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			<h2 class="text-lg font-semibold text-gray-900">Discard saved progress?</h2>
			<p class="mt-2 text-sm text-gray-600">
				This permanently removes the saved progress for {puzzleName}.
			</p>
			<div class="mt-6 flex justify-end gap-2">
				<button type="button" onclick={onCancel}>Cancel</button>
				<button type="button" onclick={onConfirm}>Discard</button>
			</div>
		</div>
	</div>
</div>
```

Retain the existing safe-area padding and button classes from `ExitSessionDialog.svelte`; do not create shared button/dialog primitives.

- [ ] **Step 3: Add Discard to `SessionPauseDialog`**

Extend `Props` and destructuring with:

```ts
onDiscard: () => void;
```

Render the normal pause/resume action row in this order:

```svelte
<button type="button" onclick={onExit} class={secondaryButtonClass}>Exit</button>
<button type="button" onclick={onDiscard} class={secondaryButtonClass}>Discard</button>
<button type="button" onclick={onRequestRestart} class={secondaryButtonClass}>Restart</button>
<button type="button" onclick={onResume} class={primaryButtonClass}>Resume</button>
```

Do not add Discard to the inline Restart confirmation surface.

- [ ] **Step 4: Add failing route tests for direct Exit and gameplay Discard**

Replace the existing “cancel exit” tests in `page.svelte.test.ts` with:

```ts
it('saves and navigates immediately when the Arcade link is used', async () => {
	await renderPuzzlePage();
	await placePiece(0, 0, 0);
	sessionStorageSpies.saveSession.mockClear();

	await page.getByTestId('back-to-arcade-link').click();

	expect(page.getByRole('dialog', { name: 'Exit Mission' }).query()).toBeNull();
	expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
	expect(vi.mocked(goto)).toHaveBeenCalledWith('/');
});

it('cancels discard back to the same Resume Mission presentation', async () => {
	restoredLifecycleState.value = 'paused';
	setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });
	await renderPuzzlePage();
	await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();

	await page.getByRole('button', { name: 'Discard' }).click();
	await expect.element(page.getByRole('dialog', { name: 'Discard saved progress' })).toBeVisible();
	await page.getByRole('button', { name: 'Cancel' }).click();

	await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	expect(sessionStorageSpies.clearSession).not.toHaveBeenCalled();
});

it('clears the persisted session when gameplay discard is confirmed', async () => {
	await renderPuzzlePage();
	await placePiece(0, 0, 0);
	await page.getByLabelText('More puzzle actions').click();
	await page.getByRole('button', { name: 'Pause mission' }).click();
	await page.getByRole('button', { name: 'Discard' }).click();
	await page.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Discard' })
		.click();

	expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('test-puzzle');
	expect(vi.mocked(goto)).toHaveBeenCalledWith('/');
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected before route implementation: old Exit Mission dialog appears and no Discard action exists on Pause.

- [ ] **Step 5: Simplify route dialog state and exit composition**

In `+page.svelte`:

```ts
type SessionDialog = 'setup' | 'pause' | 'discard' | null;
```

Remove:

- `ExitSessionDialog` import/rendering.
- `exitOrigin`.
- `currentRunIsResumable()`.
- `requestReturnToArcade()`’s modal branch.
- `saveAndExit()`.
- `cancelExit()`.

Add:

```ts
function exitToArcade(): void {
	clearTransientGameplayState();
	if (sessionState?.lifecycle === 'active') {
		sessionStore?.dispatch({ type: 'pause' });
	}
	persistSessionFinal();
	void goto(resolve('/'));
}

function requestDiscard(): void {
	clearTransientGameplayState();
	sessionDialog = 'discard';
}

function cancelDiscard(): void {
	// pausePresentation is intentionally retained, so a restored Timed run
	// returns to Resume Mission while a manual pause returns to Mission Paused.
	sessionDialog = 'pause';
}
```

Keep the existing defensive clear/dispose ordering in `discardAndExit()`.

Retarget all existing non-destructive exit callbacks to `exitToArcade`:

```svelte
onclick={(event) => {
	event.preventDefault();
	exitToArcade();
}}

<MissionSetupDialog onExit={exitToArcade} ... />
<SessionPauseDialog onExit={exitToArcade} onDiscard={requestDiscard} ... />
<PuzzleCompletionDialog onBackToArcade={exitToArcade} ... />
```

Render:

```svelte
{#if sessionDialog === 'discard'}
	<DiscardSessionDialog
		puzzleName={puzzle?.name ?? 'this mission'}
		onConfirm={discardAndExit}
		onCancel={cancelDiscard}
	/>
{/if}
```

- [ ] **Step 6: Verify and commit Task 1**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git add src/lib/components/DiscardSessionDialog.svelte \
  src/lib/components/ExitSessionDialog.svelte \
  src/lib/components/SessionPauseDialog.svelte \
  src/lib/components/__tests__/SessionDialogs.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): simplify exit and add discard flow"
```

---

## Task 2: Add saved-progress Discard to the home Continue panel

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`
- Reuse: `apps/web/src/lib/components/DiscardSessionDialog.svelte`

**Interfaces:**

- Home route stores `discardTarget: GalleryProgress | null`.
- Home deletion uses the existing `SessionStorageAdapter.clearSession(puzzleId)`.
- Progress refresh continues through `discoverGalleryProgress({ serverPuzzles, quickPuzzles })`.

**Produces:** the currently surfaced Continue on this device session can be discarded without entering gameplay.

- [ ] **Step 1: Add a storage-adapter mock and failing home tests**

Add a hoisted spy and persistence mock near the current gallery mocks:

```ts
const sessionStorageSpies = vi.hoisted(() => ({
	clearSession: vi.fn()
}));

vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({
		clearSession: sessionStorageSpies.clearSession
	})
}));
```

Reset `sessionStorageSpies.clearSession` in `beforeEach`. Extend the existing Continue-panel test and add confirm/cancel coverage:

```ts
it('offers Discard beside Continue for the newest saved progress', async () => {
	// Reuse the existing newest-progress setup.
	render(GalleryPage);
	const panel = page.getByTestId('continue-on-device');
	await expect.element(panel.getByRole('link', { name: 'CONTINUE' })).toBeVisible();
	await expect.element(panel.getByRole('button', { name: 'Discard saved progress' })).toBeVisible();
});

it('clears and refreshes the newest progress after confirmed discard', async () => {
	mockedDiscoverGalleryProgress
		.mockReturnValueOnce({ byPuzzleId: new Map([['p1', progress]]), newest: progress })
		.mockReturnValue({ byPuzzleId: new Map(), newest: null });

	render(GalleryPage);
	await page.getByRole('button', { name: 'Discard saved progress' }).click();
	await page.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Discard' })
		.click();

	expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('p1');
	await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
});

it('keeps progress when home discard is canceled', async () => {
	render(GalleryPage);
	await page.getByRole('button', { name: 'Discard saved progress' }).click();
	await page.getByRole('button', { name: 'Cancel' }).click();

	expect(sessionStorageSpies.clearSession).not.toHaveBeenCalled();
	await expect.element(page.getByTestId('continue-on-device')).toBeVisible();
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
```

Expected before implementation: no home Discard button/dialog and no storage clear.

- [ ] **Step 2: Add route-local discard state and refresh helper**

In `+page.svelte` import:

```ts
import DiscardSessionDialog from '$lib/components/DiscardSessionDialog.svelte';
import { createSessionStorageAdapter } from '$lib/services/gameplay/session/persistence';
```

Add:

```ts
const sessionStorageAdapter = createSessionStorageAdapter();
let discardTarget = $state<GalleryProgress | null>(null);

function refreshLocalProgress(): void {
	localProgress = discoverGalleryProgress({
		serverPuzzles: puzzles,
		quickPuzzles
	});
}

function confirmDiscardProgress(): void {
	if (!discardTarget) return;
	sessionStorageAdapter.clearSession(discardTarget.puzzleId);
	discardTarget = null;
	refreshLocalProgress();
}
```

Have the existing progress `$effect` call `refreshLocalProgress()` after reading `puzzles` and `quickPuzzles`; keep those reads explicit so the effect remains reactive:

```ts
$effect(() => {
	void puzzles;
	void quickPuzzles;
	refreshLocalProgress();
});
```

- [ ] **Step 3: Render the home action and shared confirmation**

In the Continue panel, keep `CONTINUE` as the primary link and add:

```svelte
<button
	type="button"
	aria-label="Discard saved progress"
	onclick={() => (discardTarget = localProgress.newest)}
	class="border border-(--hot) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em] text-(--hot) uppercase"
>
	DISCARD
</button>
```

Make the page inert while confirmation is open:

```svelte
<main inert={discardTarget !== null} aria-hidden={discardTarget !== null} ...>
```

Render the shared dialog after `</main>`:

```svelte
{#if discardTarget}
	<DiscardSessionDialog
		puzzleName={discardTarget.name}
		onConfirm={confirmDiscardProgress}
		onCancel={() => (discardTarget = null)}
	/>
{/if}
```

- [ ] **Step 4: Verify and commit Task 2**

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
bun run check

git add src/routes/+page.svelte src/routes/page.svelte.test.ts
git commit -m "feat(web): add home progress discard"
```

---

## Task 3: Add a wider, accessible desktop tray resizer

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- Route-local constants: `DEFAULT_TRAY_WIDTH_PX = 360`, `MIN_TRAY_WIDTH_PX = 300`, `MIN_BOARD_WIDTH_PX = 480`, `TRAY_RESIZER_WIDTH_PX = 20`, `TRAY_RESIZE_STEP_PX = 16`.
- The `.game-layout` inline style exposes `--tray-width` in addition to existing board metrics.
- The separator exposes `data-testid="tray-resizer"` and numeric ARIA values.

**Produces:** pointer and keyboard tray resizing on desktop without persistence or mobile layout changes.

- [ ] **Step 1: Add failing route tests for width, keyboard, and pointer semantics**

Add tests beside the existing responsive sizing test:

```ts
it('starts with a 360px tray and exposes an accessible separator', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	const separator = page.getByTestId('tray-resizer');

	expect(layout.style.getPropertyValue('--tray-width').trim()).toBe('360px');
	await expect.element(separator).toHaveAttribute('role', 'separator');
	await expect.element(separator).toHaveAttribute('aria-orientation', 'vertical');
	await expect.element(separator).toHaveAttribute('aria-valuemin', '300');
	await expect.element(separator).toHaveAttribute('aria-valuenow', '360');
});

it('resizes the tray with separator keyboard controls', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	const separator = await page.getByTestId('tray-resizer').element();

	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('376px');

	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('300px');
});

it('uses only the active pointer while resizing the tray', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	const separator = await page.getByTestId('tray-resizer').element();

	separator.dispatchEvent(
		new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 700, button: 0 })
	);
	window.dispatchEvent(
		new PointerEvent('pointermove', { bubbles: true, pointerId: 8, clientX: 650 })
	);
	expect(layout.style.getPropertyValue('--tray-width').trim()).toBe('360px');

	window.dispatchEvent(
		new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 650 })
	);
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('410px');

	window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected before implementation: missing separator and `--tray-width`.

- [ ] **Step 2: Add the route-local width model and clamp**

Add:

```ts
const DEFAULT_TRAY_WIDTH_PX = 360;
const MIN_TRAY_WIDTH_PX = 300;
const MIN_BOARD_WIDTH_PX = 480;
const TRAY_RESIZER_WIDTH_PX = 20;
const TRAY_RESIZE_STEP_PX = 16;

let gameLayoutElement = $state<HTMLElement | null>(null);
let trayWidth = $state(DEFAULT_TRAY_WIDTH_PX);
let trayResizePointerId = $state<number | null>(null);
let trayResizeStartX = $state(0);
let trayResizeStartWidth = $state(DEFAULT_TRAY_WIDTH_PX);

function maximumTrayWidth(): number {
	const layoutWidth = gameLayoutElement?.clientWidth ?? 0;
	if (layoutWidth <= 0) return Math.max(MIN_TRAY_WIDTH_PX, trayWidth);
	return Math.max(
		MIN_TRAY_WIDTH_PX,
		layoutWidth - MIN_BOARD_WIDTH_PX - TRAY_RESIZER_WIDTH_PX
	);
}

function setTrayWidth(width: number): void {
	trayWidth = Math.min(maximumTrayWidth(), Math.max(MIN_TRAY_WIDTH_PX, width));
}
```

At the end of `handleWindowResize()`, call `setTrayWidth(trayWidth)` after updating viewport dimensions.

- [ ] **Step 3: Add pointer and keyboard handlers**

```ts
function handleTrayResizePointerDown(event: PointerEvent): void {
	if (event.button !== 0) return;
	event.preventDefault();
	trayResizePointerId = event.pointerId;
	trayResizeStartX = event.clientX;
	trayResizeStartWidth = trayWidth;
}

function handleTrayResizePointerMove(event: PointerEvent): void {
	if (trayResizePointerId !== event.pointerId) return;
	setTrayWidth(trayResizeStartWidth - (event.clientX - trayResizeStartX));
}

function handleTrayResizePointerUp(event: PointerEvent): void {
	if (trayResizePointerId !== event.pointerId) return;
	trayResizePointerId = null;
}

function handleTrayResizeKeyDown(event: KeyboardEvent): void {
	if (event.key === 'ArrowLeft') {
		event.preventDefault();
		setTrayWidth(trayWidth + TRAY_RESIZE_STEP_PX);
	} else if (event.key === 'ArrowRight') {
		event.preventDefault();
		setTrayWidth(trayWidth - TRAY_RESIZE_STEP_PX);
	} else if (event.key === 'Home') {
		event.preventDefault();
		setTrayWidth(MIN_TRAY_WIDTH_PX);
	} else if (event.key === 'End') {
		event.preventDefault();
		setTrayWidth(maximumTrayWidth());
	}
}
```

Register/remove `pointermove`, `pointerup`, and `pointercancel` with the route’s existing window listeners. Clear `trayResizePointerId` in `handleWindowBlur()` and on teardown.

- [ ] **Step 4: Render and style the separator**

Bind the layout and append the width variable without replacing existing board variables:

```svelte
<div
	bind:this={gameLayoutElement}
	class="game-layout"
	style={`--tray-width: ${trayWidth}px; ${existingBoardMetricStyle}`}
>
	<PuzzleBoardPanel ... />
	<div
		class="tray-resizer"
		data-testid="tray-resizer"
		role="separator"
		aria-label="Resize puzzle tray"
		aria-orientation="vertical"
		aria-valuemin={MIN_TRAY_WIDTH_PX}
		aria-valuemax={maximumTrayWidth()}
		aria-valuenow={Math.round(trayWidth)}
		tabindex="0"
		onpointerdown={handleTrayResizePointerDown}
		onkeydown={handleTrayResizeKeyDown}
	></div>
	<PuzzleInventoryPanel ... />
</div>
```

Use the existing mobile grid unchanged. Replace only the desktop columns:

```css
.tray-resizer {
	display: none;
}

@media (min-width: 1024px) {
	.game-layout {
		grid-template-columns: minmax(0, 1fr) 20px var(--tray-width);
		column-gap: 0;
	}

	.tray-resizer {
		display: block;
		position: relative;
		cursor: col-resize;
		touch-action: none;
	}

	.tray-resizer::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		width: 1px;
		background: var(--border);
	}

	.tray-resizer:hover::before,
	.tray-resizer:focus-visible::before {
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
	}
}
```

- [ ] **Step 5: Verify and commit Task 3**

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git add 'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): add resizable puzzle tray"
```

---

## Task 4: Generate fresh, visibly scrambled starting orientations

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/runtime.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.test.ts`

**Interfaces:**

- Keep `GameplayRuntimeDependencies.createRotations(puzzleId, pieceIds)` unchanged.
- Production `buildRotations(_puzzleId, pieceIds)` returns a complete `Record<number, Rotation>`.

**Produces:** each rotation-enabled setup/restart makes a fresh generator call; a non-empty result cannot be entirely upright.

- [ ] **Step 1: Mock the rotation generator and replace deterministic-seed tests**

Add a hoisted generator mock before importing `runtime.ts`:

```ts
const rotationMock = vi.hoisted(() =>
	vi.fn<(pieceIds: number[]) => Record<number, Rotation>>()
);

vi.mock('$lib/services/gameplay/rotation', () => ({
	generateRandomRotations: rotationMock
}));
```

Reset it in `beforeEach`:

```ts
rotationMock.mockReset();
rotationMock.mockImplementation((ids) =>
	Object.fromEntries(ids.map((id) => [id, 90])) as Record<number, Rotation>
);
```

Replace “createRotations is deterministic” with:

```ts
it('requests a fresh rotation mapping for every run configuration', () => {
	rotationMock
		.mockReturnValueOnce({ 0: 0, 1: 90 })
		.mockReturnValueOnce({ 0: 180, 1: 270 });
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1]);

	expect(runtime.createRotations('puzzle-1', [0, 1])).toEqual({ 0: 0, 1: 90 });
	expect(runtime.createRotations('puzzle-1', [0, 1])).toEqual({ 0: 180, 1: 270 });
	expect(rotationMock).toHaveBeenCalledTimes(2);
});

it('forces one piece to 90 degrees when a non-empty mapping is all upright', () => {
	rotationMock.mockReturnValue({ 0: 0, 1: 0, 2: 0 });
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);

	expect(runtime.createRotations('puzzle-1', [0, 1, 2])).toEqual({
		0: 90,
		1: 0,
		2: 0
	});
});

it('leaves an empty rotation mapping empty', () => {
	rotationMock.mockReturnValue({});
	const runtime = createGameplayRuntimeDependencies('puzzle-1', []);
	expect(runtime.createRotations('puzzle-1', [])).toEqual({});
});
```

Keep the existing override-path test proving that production generator/shuffle functions are not called.

Run:

```bash
cd apps/web
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
```

Expected before implementation: the second call is deterministic from the puzzle hash and all-zero output stays upright.

- [ ] **Step 2: Remove the deterministic puzzle hash from production rotations**

Replace `buildRotations` with:

```ts
function buildRotations(
	_puzzleId: string,
	pieceIds: readonly number[]
): Record<number, Rotation> {
	const rotations = { ...generateRandomRotations([...pieceIds]) };

	if (
		pieceIds.length > 0 &&
		pieceIds.every((pieceId) => rotations[pieceId] === 0)
	) {
		rotations[pieceIds[0]!] = 90;
	}

	return rotations;
}
```

Delete the local hash loop only. Do not change `rotation.ts`, `PuzzleSession`, `runtime.types.ts`, or the virtual override.

- [ ] **Step 3: Verify and commit Task 4**

```bash
cd apps/web
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bun run check

git add src/lib/services/gameplay/runtime.ts \
  src/lib/services/gameplay/runtime.test.ts
git commit -m "feat(web): randomize starting piece rotations"
```

---

## Task 5: Keep hints visible and reveal the exact tray piece

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- No prop changes: continue using `activeHintPieceId` and `activeHintTarget`.
- Inventory slot adds `data-hinted="true"` while active and a `data-testid="hint-piece-badge"` marker.
- Route removes all hint-timeout state; `clearHintTarget()` becomes synchronous state cleanup only.

**Produces:** the drawer opens and scrolls to a strongly marked hinted piece; the matching target stays marked until placement/replacement/lifecycle cleanup.

- [ ] **Step 1: Add failing inventory reveal tests**

Add `tick`-safe scroll coverage to `PuzzleInventoryPanel.svelte.test.ts`:

```ts
it('opens, marks, and scrolls the hinted piece into view without selecting or focusing it', async () => {
	const scrollIntoView = vi.fn();
	const original = HTMLElement.prototype.scrollIntoView;
	Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
		configurable: true,
		value: scrollIntoView
	});

	try {
		const input = baseProps();
		const view = render(PuzzleInventoryPanel, input);
		await page.getByRole('button', { name: 'Collapse inventory' }).click();

		await view.rerender({ ...input, activeHintPieceId: 1 });

		await expect
			.element(page.getByTestId('inventory-drawer-toggle'))
			.toHaveAttribute('aria-expanded', 'true');
		await expect.element(page.getByTestId('piece-slot-1')).toHaveAttribute('data-hinted', 'true');
		await expect.element(page.getByTestId('hint-piece-badge')).toHaveTextContent('HINT');
		await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
			block: 'nearest',
			inline: 'nearest'
		}));
		expect(input.onSelect).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(
			await page.getByLabelText('Puzzle piece 1').element()
		);
	} finally {
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
			configurable: true,
			value: original
		});
	}
});
```

Keep the existing hinted-over-rejected precedence assertion and extend it to `data-hinted` plus the badge.

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected before implementation: drawer remains collapsed, no badge/data attribute, and no scroll call.

- [ ] **Step 2: Let the inventory own reveal timing**

Import `tick`:

```ts
import { tick } from 'svelte';
```

Add:

```ts
async function revealHintedPiece(pieceId: number): Promise<void> {
	drawerOpen = true;
	activePieceId = pieceId;
	await tick();
	if (activeHintPieceId !== pieceId) return;

	piecesGridElement
		?.querySelector<HTMLElement>(`[data-testid="piece-slot-${pieceId}"]`)
		?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

$effect(() => {
	const pieceId = activeHintPieceId;
	if (pieceId !== null) void revealHintedPiece(pieceId);
});
```

Do not focus the slot or dispatch any callback.

Update the slot:

```svelte
<div
	class:hinted={activeHintPieceId === piece.id}
	data-hinted={activeHintPieceId === piece.id ? 'true' : undefined}
	data-testid={`piece-slot-${piece.id}`}
>
	{#if activeHintPieceId === piece.id}
		<span class="hint-piece-badge" data-testid="hint-piece-badge" aria-hidden="true">HINT</span>
	{/if}
	<PuzzlePiece ... />
</div>
```

Use route tokens rather than a new shared style:

```css
.piece-slot {
	position: relative;
}

.piece-slot.hinted {
	border-color: var(--gold);
	box-shadow: 0 0 18px var(--gold-glow);
}

.hint-piece-badge {
	position: absolute;
	top: 0.2rem;
	left: 0.2rem;
	z-index: 2;
	padding: 0.1rem 0.25rem;
	background: var(--bg-0);
	border: 1px solid var(--gold);
	color: var(--gold);
	font-family: var(--font-mono);
	font-size: 0.45rem;
	letter-spacing: 0.12em;
}
```

- [ ] **Step 3: Remove timeout-based hint dismissal from the route**

Delete:

- `HINT_DURATION_MS`.
- `hintTimeout` state.
- All `clearTimeout(hintTimeout)` teardown branches.
- The timeout creation in `showHintTarget()`.

Keep:

```ts
function clearHintTarget(): void {
	activeHintPieceId = null;
	activeHintTarget = null;
}

function showHintTarget(pieceId: number, target: { x: number; y: number }): void {
	activeHintPieceId = pieceId;
	activeHintTarget = target;
}
```

Do not clear on selection. Preserve existing cleanup from successful hinted placement, `clearTransientGameplayState`, puzzle navigation, restart, and teardown.

- [ ] **Step 4: Align board target styling and add route lifetime tests**

In `PuzzleBoard.svelte`, keep `data-testid="hint-target"` and coordinates, but replace the amber-only treatment with the same gold token language:

```svelte
<div
	class="pointer-events-none absolute inset-1 rounded-md border-2 border-(--gold) bg-[rgba(255,190,0,0.22)] [box-shadow:0_0_18px_var(--gold-glow)]"
	data-testid="hint-target"
	...
></div>
```

Extend the existing route hint test:

```ts
it('keeps the piece and target hint until the hinted piece is placed', async () => {
	await renderPuzzlePage();
	await selectPiece(1);
	await page.getByLabelText('Hint').click();

	await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
	await expect.element(page.getByTestId('piece-slot-1')).toHaveAttribute('data-hinted', 'true');

	// Selecting/rotating unrelated UI and flushing microtasks does not clear it.
	await Promise.resolve();
	await Promise.resolve();
	await expect.element(page.getByTestId('hint-target')).toBeVisible();

	await placeSelectedPieceAt(1, 0);
	await expect.poll(() => page.getByTestId('hint-target').query()).toBeNull();
	expect(page.getByTestId('piece-slot-1').query()).toBeNull();
});

it('clears an active hint when the run is paused', async () => {
	await renderPuzzlePage();
	await selectPiece(1);
	await page.getByLabelText('Hint').click();

	await page.getByLabelText('More puzzle actions').click();
	await page.getByRole('button', { name: 'Pause mission' }).click();
	await expect.element(page.getByRole('dialog', { name: 'Mission Paused' })).toBeVisible();
	expect(page.getByTestId('hint-target').query()).toBeNull();
});
```

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 5: Verify and commit Task 5**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git add src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/PuzzleBoard.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): reveal hinted puzzle pieces"
```

---

## Task 6: Apply mode-specific restore policy and cover the complete user flow in Playwright

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-large-fixtures.spec.ts`

**Interfaces:**

- Route tests add `restoredModeState.value: 'timed' | 'relaxed'` to their persisted-snapshot mock.
- Gameplay page object adds `exitToArcade()` and `discardPausedMission()` helpers.
- No new fixture IDs or runtime override fields.

**Produces:** Relaxed continue bypasses Resume Mission; focused E2E protects exit/discard, desktop resizing, and hint reveal.

- [ ] **Step 1: Add a configurable restored mode to route tests**

Near `restoredLifecycleState` add:

```ts
const restoredModeState = vi.hoisted(() => ({
	value: 'timed' as 'timed' | 'relaxed'
}));
```

Use it in the mocked persisted snapshot:

```ts
mode: restoredModeState.value,
elapsedActiveSeconds: restoredModeState.value === 'timed' ? 0 : null,
resultClass: restoredModeState.value === 'timed' ? 'standard_timed' : 'relaxed',
```

Reset it to `timed` in both test-suite `beforeEach` blocks.

Add failing entry tests:

```ts
it.each(['active', 'paused'] as const)(
	'enters a restored Relaxed %s run without Resume Mission',
	async (lifecycle) => {
		restoredModeState.value = 'relaxed';
		restoredLifecycleState.value = lifecycle;
		setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

		await renderPuzzlePage();

		expect(page.getByRole('dialog', { name: 'Resume Mission' }).query()).toBeNull();
		await expect.element(page.getByTestId('relaxed-mode-indicator')).toBeVisible();
	}
);

it.each(['active', 'paused'] as const)(
	'keeps explicit Resume Mission for a restored Timed %s run',
	async (lifecycle) => {
		restoredModeState.value = 'timed';
		restoredLifecycleState.value = lifecycle;
		setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

		await renderPuzzlePage();
		await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	}
);
```

Run:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected before implementation: both Relaxed cases still open Resume Mission.

- [ ] **Step 2: Branch restored route entry by mode**

Replace the current restored active/paused block with:

```ts
} else if (restored.lifecycle === 'active') {
	if (restored.mode === 'timed') {
		store.dispatch({ type: 'pause' });
		checkpointSession();
		pausePresentation = 'resume';
		sessionDialog = 'pause';
	}
} else if (restored.lifecycle === 'paused') {
	if (restored.mode === 'relaxed') {
		store.dispatch({ type: 'resume' });
		checkpointSession();
	} else {
		pausePresentation = 'resume';
		sessionDialog = 'pause';
	}
}
```

Do not call `resume` for restored active Relaxed runs; they are already active. Do not change the completed/setup branches.

- [ ] **Step 3: Add focused page-object helpers**

In `gameplay-page.ts` add:

```ts
async exitToArcade(): Promise<void> {
	await this.page.getByTestId('back-to-arcade-link').click();
	await expect(this.page).toHaveURL(/\/$/);
	await expect(this.page.getByRole('dialog', { name: 'Exit Mission' })).toHaveCount(0);
}

async discardPausedMission(): Promise<void> {
	const pause = this.page.getByRole('dialog', {
		name: /^(Mission Paused|Resume Mission)$/
	});
	await expect(pause).toBeVisible();
	await pause.getByRole('button', { name: 'Discard' }).click();
	const discard = this.page.getByRole('dialog', { name: 'Discard saved progress' });
	await expect(discard).toBeVisible();
	await discard.getByRole('button', { name: 'Discard' }).click();
	await expect(this.page).toHaveURL(/\/$/);
}
```

Keep `pauseMission()` and `resumeMission()` unchanged.

- [ ] **Step 4: Update session-control E2E for Relaxed continue, direct Exit, and Discard**

In the existing restored Relaxed+rotation test, remove the initial Resume expectation/call. Assert direct entry, then manually pause before Restart:

```ts
await gameplayPage.gotoFixture({ seedSession: seeded });
await expect(page.getByRole('dialog', { name: 'Resume Mission' })).toHaveCount(0);
await expect(page.getByTestId('relaxed-mode-indicator')).toBeVisible();

await gameplayPage.pauseMission();
await page.getByRole('dialog', { name: 'Mission Paused' })
	.getByRole('button', { name: 'Restart' })
	.click();
```

Add:

```ts
test('Exit saves progress and returns home without a choice dialog @smoke', async ({
	gameplayPage
}) => {
	await gameplayPage.gotoFixture();
	await gameplayPage.startMission();
	await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);

	await gameplayPage.exitToArcade();
	const persisted = await gameplayPage.readPersistedSession();
	expect(persisted?.placedPieces).toEqual([{ pieceId: 0, x: 0, y: 0 }]);
});

test('Discard from Pause clears progress and returns home @smoke', async ({
	gameplayPage
}) => {
	await gameplayPage.gotoFixture();
	await gameplayPage.startMission();
	await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
	await gameplayPage.pauseMission();

	await gameplayPage.discardPausedMission();
	expect(await gameplayPage.readPersistedSession()).toBeNull();
});
```

- [ ] **Step 5: Add desktop layout and hint-reveal E2E to the existing large-fixture spec**

Add two `@extended` tests and skip non-desktop projects locally inside each test:

```ts
test('desktop tray separator widens the inventory @extended', async ({ gameplayPage, page }) => {
	test.skip(!test.info().project.name.endsWith('-desktop'), 'desktop split layout only');
	await gameplayPage.gotoFixture({ fixtureId: 'e2e-square-100' });

	const tray = page.getByTestId('puzzle-inventory-panel');
	const separator = page.getByTestId('tray-resizer');
	await expect(separator).toBeVisible();
	const before = await tray.boundingBox();
	if (!before) throw new Error('Inventory panel has no bounding box');

	await separator.dragTo(separator, {
		sourcePosition: { x: 10, y: 100 },
		targetPosition: { x: 0, y: 100 }
	});
	await expect.poll(async () => (await tray.boundingBox())?.width ?? 0).toBeGreaterThan(before.width);
});
```

If Playwright’s same-locator `dragTo` does not move the pointer far enough, replace only the interaction with `page.mouse.move/down/move/up` using the separator bounding box; keep the width assertion.

Hint reveal:

```ts
test('hint reveals and marks an offscreen tray piece @extended', async ({ gameplayPage, page }) => {
	test.skip(!test.info().project.name.endsWith('-desktop'), 'desktop scroll assertion');
	await gameplayPage.gotoFixture({ fixtureId: 'e2e-square-100' });

	const pieceId = 99;
	await page
		.locator(`[data-testid="puzzle-piece"][data-piece-id="${pieceId}"]`)
		.evaluate((element) => (element as HTMLElement).click());
	await page.getByRole('button', { name: 'Hint' }).click();

	const slot = page.getByTestId(`piece-slot-${pieceId}`);
	await expect(slot).toHaveAttribute('data-hinted', 'true');
	await expect(slot.getByTestId('hint-piece-badge')).toHaveText('HINT');
	await expect(page.getByTestId('hint-target')).toBeVisible();

	const revealed = await slot.evaluate((element) => {
		const container = element.closest('.pieces-grid');
		if (!container) return false;
		const slotRect = element.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		return slotRect.top >= containerRect.top && slotRect.bottom <= containerRect.bottom;
	});
	expect(revealed).toBe(true);
});
```

- [ ] **Step 6: Run focused verification**

```bash
cd apps/web
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser src/routes/page.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-large-fixtures.spec.ts --project=chromium-desktop \
  --grep 'tray separator|hint reveals'
```

Expected: all focused unit/browser/E2E checks pass; mobile session controls retain reachable Pause and direct Exit behavior.

- [ ] **Step 7: Commit E2E and restore-policy coverage**

```bash
git add 'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts' \
  e2e/support/gameplay-page.ts \
  e2e/gameplay-session-controls.spec.ts \
  e2e/gameplay-large-fixtures.spec.ts
git commit -m "test(web): cover gameplay polish flows"
```

---

## Final Verification

- [ ] **Step 1: Review the diff for scope**

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- \
  apps/web/src/lib/components \
  apps/web/src/lib/services/gameplay/runtime.ts \
  apps/web/src/lib/services/gameplay/runtime.test.ts \
  apps/web/src/routes \
  apps/web/e2e
```

Expected production changes are limited to the puzzle route, home route, three dialog/inventory/board components, and runtime rotation factory. There must be no session schema, backend, dependency, or unrelated refactor diff.

- [ ] **Step 2: Run the complete focused gate once more**

```bash
cd apps/web
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser src/routes/page.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-large-fixtures.spec.ts --project=chromium-desktop \
  --grep 'tray separator|hint reveals'
```

- [ ] **Step 3: Confirm acceptance behavior manually in one desktop browser pass**

```text
1. Start a Relaxed rotation-enabled puzzle and confirm pieces begin in mixed orientations.
2. Place one piece, Exit, and confirm the home page shows Continue without an exit popup.
3. Continue the Relaxed run and confirm no Resume Mission popup appears.
4. Pause, cancel Discard, and confirm the same Pause dialog returns.
5. Drag and keyboard-resize the desktop tray.
6. Request a hint with an offscreen piece and confirm both tray piece and board target are obvious.
7. Exit, use home Discard, confirm, and verify the Continue panel refreshes.
```

- [ ] **Step 4: Confirm no placeholders or stale exit contract remain**

```bash
git grep -nE 'TBD|TODO|implement later' -- \
  docs/superpowers/specs/2026-08-17-gameplay-flow-workspace-polish-design.md \
  docs/superpowers/plans/2026-08-17-gameplay-flow-workspace-polish.md

git grep -n 'ExitSessionDialog\|Save & Exit\|sessionDialog === .exit.' -- apps/web/src || true
```

Expected: no plan placeholders and no production references to the deleted exit-choice dialog.