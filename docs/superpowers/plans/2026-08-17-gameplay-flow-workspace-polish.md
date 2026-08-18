# Gameplay Flow and Puzzle Workspace Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unnecessary Relaxed/Exit dialogs, add explicit saved-progress discard, make the desktop tray wider and resizable, generate fresh starting orientations for rotation-enabled runs, and clearly reveal the piece associated with a hint.

**Architecture:** Keep `PuzzleSession` and its persistence schema unchanged. Do one route-level flow pass for restore + exit + gameplay discard; reuse one discard confirmation component from gameplay and home; keep tray interaction route-local but put its numeric clamp in the existing `puzzleLayout.ts`; keep orientation generation behind the current gameplay runtime factory; let `PuzzleInventoryPanel` own drawer opening and DOM reveal; finish with E2E-only integration coverage.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-08-17-gameplay-flow-workspace-polish-design.md`

## Global Constraints

- Ship all five product changes as one implementation PR.
- Do not change `PuzzleSessionState`, session actions/events, persistence schema/version, lifecycle rules, completion sealing, or gallery validation rules.
- Keep explicit `Resume Mission` for restored Timed runs.
- Restored Relaxed active/paused runs enter active gameplay without a popup.
- Exit always settles/saves the session and navigates to `/`; it never offers Save versus Discard.
- Discard remains confirmed and is exposed only from the Pause/Resume surface and the home Continue panel.
- Preserve the existing `discardAndExit()` ordering that stops checkpointing and disposes before `clearSession`.
- Do not add per-card discard, server deletion, a saved-progress store, a generic dialog framework, or a split-pane package/component.
- Tray width is desktop-only route-local state; do not persist it.
- Put only the pure numeric tray clamp in `puzzleLayout.ts`; do not create a general layout manager.
- Extend the existing route window pointer cleanup; do not replace Hold-to-Peek `pointerup`/`pointercancel` behavior and do not add pointer capture.
- Keep `createRotations(puzzleId, pieceIds)` and the virtual E2E override unchanged.
- Do not test randomness probabilistically; mock `generateRandomRotations`.
- Hint reveal may open/scroll the tray and update the roving candidate, but must not call `.focus()`, `onSelect`, `onRotate`, or placement callbacks.
- Remove the 1.8-second hint timeout and update `docs/PRD.md` so product documentation does not restore the old behavior later.
- Update current tests directly; do not keep compatibility aliases for `ExitSessionDialog` or its old Save/Discard/Cancel contract.

---

## Task 1: Do one route flow pass for restore, direct Exit, and gameplay Discard

**Files:**

- Create: `apps/web/src/lib/components/DiscardSessionDialog.svelte`
- Delete: `apps/web/src/lib/components/ExitSessionDialog.svelte`
- Modify: `apps/web/src/lib/components/SessionPauseDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- `DiscardSessionDialog`: `{ puzzleName: string; onConfirm: () => void; onCancel: () => void }`.
- `SessionPauseDialog` adds `onDiscard: () => void`; existing callbacks stay unchanged.
- Route-local `SessionDialog` becomes `'setup' | 'pause' | 'discard' | null`.
- Route uses one `exitToArcade(): void` for all non-destructive exits.
- Route test harness adds `restoredModeState: 'timed' | 'relaxed'` so restore policy is testable instead of hard-coded Timed.

**Produces:** the complete Timed/Relaxed restore table, direct save-and-exit, and a separate confirmed gameplay discard path without touching `PuzzleSession`.

- [ ] **Step 1: Migrate dialog tests before changing production components**

In `SessionDialogs.svelte.test.ts`:

1. Replace `ExitSessionDialog` import/tests with `DiscardSessionDialog`.
2. Add `onDiscard: vi.fn()` to every `SessionPauseDialog` fixture.
3. Add exact tests for Pause forwarding Discard, discard confirm/cancel, Escape cancellation, and the outer full-screen overlay.

Use:

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

it('confirms discard and keeps the full-screen dialog shell', async () => {
	const onConfirm = vi.fn();
	render(DiscardSessionDialog, {
		puzzleName: 'Test Mission',
		onConfirm,
		onCancel: vi.fn()
	});

	const dialog = await page.getByRole('dialog', { name: 'Discard saved progress' }).element();
	expect(dialog.parentElement?.className).toContain('fixed');
	expect(dialog.parentElement?.className).toContain('inset-0');

	await page.getByRole('button', { name: 'Discard' }).click();
	expect(onConfirm).toHaveBeenCalledOnce();
});

it('cancels discard on Escape', async () => {
	const onCancel = vi.fn();
	render(DiscardSessionDialog, {
		puzzleName: 'Test Mission',
		onConfirm: vi.fn(),
		onCancel
	});

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

Expected before implementation: import/prop/label assertions fail.

- [ ] **Step 2: Replace `ExitSessionDialog` with an explicit discard-only copy**

Delete `ExitSessionDialog.svelte`. Create `DiscardSessionDialog.svelte` by copying the existing component shell, not only its inner card. Preserve the full overlay:

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

<div
	class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
	style="padding-top: max(1rem, env(safe-area-inset-top)); padding-right: max(1rem, env(safe-area-inset-right)); padding-bottom: max(1rem, env(safe-area-inset-bottom)); padding-left: max(1rem, env(safe-area-inset-left));"
>
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
				This permanently removes saved progress for {puzzleName}.
			</p>
			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<button type="button" onclick={onCancel}>Cancel</button>
				<button type="button" onclick={onConfirm}>Discard</button>
			</div>
		</div>
	</div>
</div>
```

Reuse the old button class constants while copying; do not introduce shared dialog/button abstractions.

- [ ] **Step 3: Add Discard to `SessionPauseDialog` without changing restart/resume behavior**

Add the callback:

```ts
interface Props {
	presentation: 'resume' | 'paused';
	mode: SessionMode;
	confirmingRestart: boolean;
	onResume: () => void;
	onRequestRestart: () => void;
	onConfirmRestart: () => void;
	onCancelRestart: () => void;
	onExit: () => void;
	onDiscard: () => void;
}
```

On the normal Pause/Resume surface render `Exit`, `Discard`, `Restart`, `Resume`. Keep restart confirmation unchanged.

- [ ] **Step 4: Make the route test snapshot mode configurable and add the restore-table tests**

The route test currently hardcodes `mode: 'timed'`. Add:

```ts
const restoredModeState = vi.hoisted(() => ({
	value: 'timed' as 'timed' | 'relaxed'
}));
```

Use it in the mocked snapshot:

```ts
mode: restoredModeState.value,
elapsedActiveSeconds: restoredModeState.value === 'relaxed' ? null : 0,
resultClass: restoredModeState.value === 'relaxed' ? 'relaxed' : 'standard_timed',
```

Reset it to `timed` in both relevant `beforeEach` blocks.

Add/adjust tests:

```ts
it.each(['active', 'paused'] as const)(
	'restores a %s Relaxed run directly without Resume Mission',
	async (lifecycle) => {
		restoredLifecycleState.value = lifecycle;
		restoredModeState.value = 'relaxed';
		setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

		await renderPuzzlePage();

		await expect.poll(() => page.getByRole('dialog', { name: 'Resume Mission' }).query()).toBeNull();
		await expect.element(page.getByTestId('relaxed-mode-indicator')).toBeVisible();
	}
);

it.each(['active', 'paused'] as const)(
	'keeps Resume Mission for restored %s Timed runs',
	async (lifecycle) => {
		restoredLifecycleState.value = lifecycle;
		restoredModeState.value = 'timed';
		setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });

		await renderPuzzlePage();

		await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	}
);
```

- [ ] **Step 5: Implement restore policy in the same route pass**

Replace the current active/paused restore branch with:

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

Fresh/setup/completed handling stays unchanged.

- [ ] **Step 6: Rewrite the entire old Exit Mission test block, not only three cases**

The current route suite around the old Exit flow contains five contracts that must be migrated together:

1. `saves the session and navigates ... on Save & Exit` → direct Pause `Exit` saves and navigates with no `Exit Mission` dialog.
2. `discards ... on Discard` → Pause `Discard` opens discard confirmation; confirm clears/navigates.
3. `does not re-save ... after Discard` → keep this regression, but enter Discard directly from Pause and confirm through `DiscardSessionDialog`.
4. `resumes the active run when canceling exit from an active origin` → delete this obsolete cancelable-Exit contract; replace with header Arcade direct save+navigate.
5. `returns to the pause dialog when canceling exit from a paused origin` → rewrite as canceling Discard from a restored Timed `Resume Mission` and assert the dialog returns as `Resume Mission`, not `Mission Paused`.

Use representative replacements:

```ts
it('saves and navigates immediately when Exit is chosen from Pause', async () => {
	await renderPuzzlePage();
	await placePiece(0, 0, 0);

	await page.getByLabelText('More puzzle actions').click();
	await page.getByRole('button', { name: 'Pause mission' }).click();
	await page.getByRole('button', { name: 'Exit' }).click();

	expect(page.getByRole('dialog', { name: 'Exit Mission' }).query()).toBeNull();
	expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
	expect(sessionStorageSpies.clearSession).not.toHaveBeenCalled();
	expect(goto).toHaveBeenCalledWith('/');
});

it('cancels discard back to the restored Timed Resume Mission presentation', async () => {
	restoredLifecycleState.value = 'paused';
	restoredModeState.value = 'timed';
	setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });
	await renderPuzzlePage();

	await page.getByRole('button', { name: 'Discard' }).click();
	await page.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Cancel' })
		.click();

	await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
});
```

For the unmount regression, preserve the existing post-confirm sequence exactly:

```ts
expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('test-puzzle');
sessionStorageSpies.saveSession.mockClear();
view.unmount();
expect(sessionStorageSpies.saveSession).not.toHaveBeenCalled();
```

- [ ] **Step 7: Implement direct Exit and confirmed gameplay Discard**

Remove:

- `currentRunIsResumable`
- `exitOrigin`
- `requestReturnToArcade`
- `saveAndExit`
- `cancelExit`
- `'exit'` from `SessionDialog`
- `ExitSessionDialog` import/rendering

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
	sessionDialog = 'discard';
}

function cancelDiscard(): void {
	// Deliberately keep pausePresentation unchanged.
	sessionDialog = 'pause';
}
```

Keep the current `discardAndExit()` disposal/checkpoint ordering unchanged.

Retarget all safe exits:

```svelte
<a
	href={resolve('/')}
	onclick={(event) => {
		event.preventDefault();
		exitToArcade();
	}}
>
```

```svelte
<MissionSetupDialog ... onExit={exitToArcade} />
<SessionPauseDialog ... onExit={exitToArcade} onDiscard={requestDiscard} />
<PuzzleCompletionDialog ... onBackToArcade={exitToArcade} />
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

- [ ] **Step 8: Verify Task 1 and remove the stale Exit contract**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git grep -n 'ExitSessionDialog\|Save & Exit\|Exit Mission' -- src || true
```

Expected: tests/check pass and the grep has no old production/test contract.

Commit:

```bash
git add src/lib/components/DiscardSessionDialog.svelte \
  src/lib/components/ExitSessionDialog.svelte \
  src/lib/components/SessionPauseDialog.svelte \
  src/lib/components/__tests__/SessionDialogs.svelte.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): simplify restore exit and discard flow"
```

---

## Task 2: Add confirmed Discard to the home Continue panel

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`
- Reuse: `apps/web/src/lib/components/DiscardSessionDialog.svelte`

**Interfaces:**

- Home route adds `discardTarget: GalleryProgress | null`.
- Home uses the existing `SessionStorageAdapter.clearSession(puzzleId)`.
- `discoverGalleryProgress({ serverPuzzles, quickPuzzles })` remains the only progress-discovery authority.

**Produces:** the currently surfaced Continue session can be explicitly discarded without entering gameplay, and underlying page controls are inaccessible while confirmation is open.

- [ ] **Step 1: Add failing home discard/inert tests**

Add a persistence mock:

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

Add tests using the existing newest-progress fixture:

```ts
it('offers Discard beside Continue for newest saved progress', async () => {
	// Seed mockedDiscoverGalleryProgress with newest progress first.
	render(GalleryPage);
	const panel = page.getByTestId('continue-on-device');
	await expect.element(panel.getByRole('link', { name: 'CONTINUE' })).toBeVisible();
	await expect.element(panel.getByRole('button', { name: 'Discard saved progress' })).toBeVisible();
});

it('makes main inert while home discard confirmation is open', async () => {
	render(GalleryPage);
	await page.getByRole('button', { name: 'Discard saved progress' }).click();

	const main = document.querySelector('main')!;
	expect(main.hasAttribute('inert')).toBe(true);
	expect(main.getAttribute('aria-hidden')).toBe('true');
	await expect.element(page.getByRole('dialog', { name: 'Discard saved progress' })).toBeVisible();
});

it('clears and rediscovers progress after confirmed home discard', async () => {
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
```

Also cover Cancel: no clear, main becomes interactive again, Continue remains.

- [ ] **Step 2: Add route-local target and one storage adapter**

Import:

```ts
import DiscardSessionDialog from '$lib/components/DiscardSessionDialog.svelte';
import { createSessionStorageAdapter } from '$lib/services/gameplay/session/persistence';
import {
	discoverGalleryProgress,
	type GalleryProgress,
	type GalleryProgressDiscovery
} from '$lib/services/gameplay/galleryProgress';
```

Add:

```ts
const sessionStorageAdapter = createSessionStorageAdapter();
let discardTarget = $state<GalleryProgress | null>(null);

function confirmDiscardProgress(): void {
	const target = discardTarget;
	if (!target) return;

	sessionStorageAdapter.clearSession(target.puzzleId);
	discardTarget = null;
	localProgress = discoverGalleryProgress({
		serverPuzzles: puzzles,
		quickPuzzles
	});
}
```

Keep the existing reactive discovery effect; do not create a second store or validation path.

- [ ] **Step 3: Make the existing `<main>` inert and render the modal after it**

Change the actual page root:

```svelte
<main
	inert={discardTarget !== null}
	aria-hidden={discardTarget !== null}
	class="...existing classes..."
>
```

Add beside `CONTINUE`:

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

After the closing `</main>`, not inside it:

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

## Task 3: Add the desktop tray resizer with a pure clamp and composed pointer cleanup

**Files:**

- Modify: `apps/web/src/lib/services/puzzleLayout.ts`
- Modify: `apps/web/src/lib/services/puzzleLayout.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- New pure helper:

```ts
export interface TrayWidthClampOptions {
	layoutWidth: number;
	requestedWidth: number;
	minTrayWidth: number;
	minBoardWidth: number;
	separatorWidth: number;
}

export function clampTrayWidth(options: TrayWidthClampOptions): number;
```

- Route constants: `DEFAULT_TRAY_WIDTH_PX = 360`, `MIN_TRAY_WIDTH_PX = 300`, `MIN_BOARD_WIDTH_PX = 480`, `TRAY_RESIZER_WIDTH_PX = 20`, `TRAY_RESIZE_STEP_PX = 16`.
- Separator: `data-testid="tray-resizer"`, vertical `role="separator"`, numeric ARIA values.

**Produces:** desktop-only pointer/keyboard resizing with explicit numeric rules, resize reclamping, and no regression to the existing Hold-to-Peek pointer-release path.

- [ ] **Step 1: Add failing pure clamp tests first**

In `puzzleLayout.test.ts`:

```ts
describe('clampTrayWidth', () => {
	const base = {
		minTrayWidth: 300,
		minBoardWidth: 480,
		separatorWidth: 20
	};

	it('keeps the tray at least 300px', () => {
		expect(
			clampTrayWidth({ ...base, layoutWidth: 1000, requestedWidth: 200 })
		).toBe(300);
	});

	it('preserves the 480px board floor when the layout can satisfy both minimums', () => {
		// 1000 - 480 - 20 = 500 max tray.
		expect(
			clampTrayWidth({ ...base, layoutWidth: 1000, requestedWidth: 700 })
		).toBe(500);
	});

	it('documents the infeasible-width policy: tray minimum wins below 800px', () => {
		// 760 cannot satisfy 300 tray + 480 board + 20 separator.
		expect(
			clampTrayWidth({ ...base, layoutWidth: 760, requestedWidth: 360 })
		).toBe(300);
	});
});
```

Run:

```bash
cd apps/web
bunx vitest --run src/lib/services/puzzleLayout.test.ts
```

Expected: `clampTrayWidth` does not exist.

- [ ] **Step 2: Implement the small pure helper in `puzzleLayout.ts`**

Add beside existing responsive metrics:

```ts
export interface TrayWidthClampOptions {
	layoutWidth: number;
	requestedWidth: number;
	minTrayWidth: number;
	minBoardWidth: number;
	separatorWidth: number;
}

export function clampTrayWidth({
	layoutWidth,
	requestedWidth,
	minTrayWidth,
	minBoardWidth,
	separatorWidth
}: TrayWidthClampOptions): number {
	const feasibleMax = layoutWidth - minBoardWidth - separatorWidth;
	const maxTrayWidth = Math.max(minTrayWidth, feasibleMax);
	return Math.min(Math.max(requestedWidth, minTrayWidth), maxTrayWidth);
}
```

The route, not this helper, guards zero/unmeasured DOM width.

- [ ] **Step 3: Add failing route tests for measured keyboard resize, pointer IDs, reclamp, and mobile hiding**

Add near the existing responsive layout tests:

```ts
it('resizes the tray by keyboard using a measured layout width', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 1000 });
	const separator = await page.getByTestId('tray-resizer').element();

	expect(layout.style.getPropertyValue('--tray-width').trim()).toBe('360px');
	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('376px');

	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('500px');
});

it('ignores pointermove from a non-active resize pointer', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 1000 });
	const separator = await page.getByTestId('tray-resizer').element();

	separator.dispatchEvent(
		new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 700, button: 0 })
	);
	window.dispatchEvent(
		new PointerEvent('pointermove', { bubbles: true, pointerId: 8, clientX: 650 })
	);

	expect(layout.style.getPropertyValue('--tray-width').trim()).toBe('360px');
});

it('reclamps the tray when the measured layout shrinks', async () => {
	await renderPuzzlePage();
	const layout = document.querySelector<HTMLElement>('.game-layout')!;
	let layoutWidth = 1100;
	Object.defineProperty(layout, 'clientWidth', {
		configurable: true,
		get: () => layoutWidth
	});
	const separator = await page.getByTestId('tray-resizer').element();

	separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('600px');

	layoutWidth = 900;
	window.dispatchEvent(new Event('resize'));
	await expect.poll(() => layout.style.getPropertyValue('--tray-width').trim()).toBe('400px');
});
```

For mobile, render with `window.innerWidth = 390`, dispatch resize, and assert the separator has `display: none`; do not add a mobile resize behavior.

Keep the existing route tests that release Hold-to-Peek on matching global `pointerup`/`pointercancel`; they are regression coverage for handler composition.

- [ ] **Step 4: Add route-local tray state and measurement helpers**

Import `clampTrayWidth` and add:

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

function measuredGameLayoutWidth(): number | null {
	const width = gameLayoutElement?.clientWidth ?? 0;
	return width > 0 ? width : null;
}

function maximumTrayWidth(): number {
	const layoutWidth = measuredGameLayoutWidth();
	if (layoutWidth === null) return Math.max(MIN_TRAY_WIDTH_PX, trayWidth);
	return Math.max(
		MIN_TRAY_WIDTH_PX,
		layoutWidth - MIN_BOARD_WIDTH_PX - TRAY_RESIZER_WIDTH_PX
	);
}

function setTrayWidth(requestedWidth: number): void {
	const layoutWidth = measuredGameLayoutWidth();
	if (layoutWidth === null) return;
	trayWidth = clampTrayWidth({
		layoutWidth,
		requestedWidth,
		minTrayWidth: MIN_TRAY_WIDTH_PX,
		minBoardWidth: MIN_BOARD_WIDTH_PX,
		separatorWidth: TRAY_RESIZER_WIDTH_PX
	});
}
```

Extend `handleWindowResize()` after viewport dimensions update:

```ts
setTrayWidth(trayWidth);
```

- [ ] **Step 5: Compose resize pointer state into existing window handlers**

Add only one new global listener:

```ts
window.addEventListener('pointermove', handleWindowPointerMove);
```

Remove it in `onDestroy`.

Do not replace the existing capture-phase `pointerup` / `pointercancel`. Extend their handler:

```ts
function handleWindowPointerUp(event: PointerEvent) {
	if (referenceHoldSource === 'pointer' && referencePointerId === event.pointerId) {
		clearReferenceHold();
	}
	if (trayResizePointerId === event.pointerId) {
		trayResizePointerId = null;
	}
}
```

Add:

```ts
function handleWindowPointerMove(event: PointerEvent): void {
	if (trayResizePointerId !== event.pointerId) return;
	const deltaX = event.clientX - trayResizeStartX;
	setTrayWidth(trayResizeStartWidth - deltaX);
}

function handleTrayResizePointerDown(event: PointerEvent): void {
	if (event.pointerType === 'mouse' && event.button !== 0) return;
	trayResizePointerId = event.pointerId;
	trayResizeStartX = event.clientX;
	trayResizeStartWidth = trayWidth;
}
```

Extend, do not replace, `handleWindowBlur()`:

```ts
trayResizePointerId = null;
```

Keep existing reference-hold and selection cleanup in that function. Do not call `setPointerCapture`.

- [ ] **Step 6: Render the separator and change only desktop grid sizing**

Bind the layout and expose width:

```svelte
<div
	bind:this={gameLayoutElement}
	class="game-layout"
	style={`--tray-width: ${trayWidth}px; --tray-resizer-width: ${TRAY_RESIZER_WIDTH_PX}px; ...existing board variables...`}
>
	<PuzzleBoardPanel ... />

	<div
		class="tray-resizer"
		data-testid="tray-resizer"
		role="separator"
		aria-label="Resize puzzle tray"
		aria-orientation="vertical"
		aria-valuemin={MIN_TRAY_WIDTH_PX}
		aria-valuemax={Math.round(maximumTrayWidth())}
		aria-valuenow={Math.round(trayWidth)}
		tabindex="0"
		onpointerdown={handleTrayResizePointerDown}
		onkeydown={handleTrayResizeKeyDown}
	></div>

	<PuzzleInventoryPanel ... />
</div>
```

Keyboard handler:

```ts
function handleTrayResizeKeyDown(event: KeyboardEvent): void {
	switch (event.key) {
		case 'ArrowLeft':
			event.preventDefault();
			setTrayWidth(trayWidth + TRAY_RESIZE_STEP_PX);
			break;
		case 'ArrowRight':
			event.preventDefault();
			setTrayWidth(trayWidth - TRAY_RESIZE_STEP_PX);
			break;
		case 'Home':
			event.preventDefault();
			setTrayWidth(MIN_TRAY_WIDTH_PX);
			break;
		case 'End':
			event.preventDefault();
			setTrayWidth(maximumTrayWidth());
			break;
	}
}
```

Desktop CSS:

```css
@media (min-width: 1024px) {
	.game-layout {
		grid-template-columns: minmax(0, 1fr) var(--tray-resizer-width) var(--tray-width);
		column-gap: 0;
	}

	.tray-resizer {
		display: flex;
		cursor: col-resize;
		touch-action: none;
	}
}

@media (max-width: 1023px) {
	.tray-resizer {
		display: none;
	}
}
```

The 20px separator is the spacing/hit area; do not leave the old desktop column gap unaccounted for in the clamp math.

- [ ] **Step 7: Verify and commit Task 3**

```bash
cd apps/web
bunx vitest --run src/lib/services/puzzleLayout.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git add src/lib/services/puzzleLayout.ts \
  src/lib/services/puzzleLayout.test.ts \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): add resizable desktop puzzle tray"
```

---

## Task 4: Generate fresh rotation orientations per configured run

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/runtime.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.test.ts`

**Interfaces:**

- Keep `GameplayRuntimeDependencies.createRotations(puzzleId, pieceIds)` unchanged.
- Production `buildRotations` still returns `Record<number, Rotation>`.

**Produces:** fresh production orientation generation on each setup/restart while deterministic E2E continues through the virtual override.

- [ ] **Step 1: Replace deterministic-seed tests with a mocked rotation generator**

Add a hoisted generator mock before importing `runtime`:

```ts
const rotationsMock = vi.hoisted(() =>
	vi.fn((ids: number[]) =>
		Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 90 : 0]))
	)
);

vi.mock('$lib/services/gameplay/rotation', () => ({
	generateRandomRotations: rotationsMock
}));
```

Reset it in `beforeEach`.

Replace the old “same puzzle id is deterministic” test with:

```ts
it('requests a fresh rotation mapping on every production call', () => {
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);

	runtime.createRotations('puzzle-1', [0, 1, 2]);
	runtime.createRotations('puzzle-1', [0, 1, 2]);

	expect(rotationsMock).toHaveBeenCalledTimes(2);
	expect(rotationsMock).toHaveBeenNthCalledWith(1, [0, 1, 2]);
	expect(rotationsMock).toHaveBeenNthCalledWith(2, [0, 1, 2]);
});

it('bumps the first piece to 90 when generation returns all upright', () => {
	rotationsMock.mockReturnValueOnce({ 0: 0, 1: 0, 2: 0 });
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);

	expect(runtime.createRotations('puzzle-1', [0, 1, 2])).toEqual({
		0: 90,
		1: 0,
		2: 0
	});
});

it('returns a clone of the generated rotation record', () => {
	const generated = { 0: 90 as const, 1: 180 as const };
	rotationsMock.mockReturnValueOnce(generated);
	const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1]);

	const result = runtime.createRotations('puzzle-1', [0, 1]);
	expect(result).toEqual(generated);
	expect(result).not.toBe(generated);
});
```

Keep existing valid-rotation and override-path coverage.

- [ ] **Step 2: Simplify only `buildRotations`**

Remove the puzzle-derived hash/seed code and implement:

```ts
function buildRotations(
	_puzzleId: string,
	pieceIds: readonly number[]
): Record<number, Rotation> {
	const rotations = generateRandomRotations([...pieceIds]);

	if (pieceIds.length > 0 && pieceIds.every((pieceId) => rotations[pieceId] === 0)) {
		rotations[pieceIds[0]!] = 90;
	}

	return { ...rotations };
}
```

Do not change `runtime.types.ts`, session code, persistence, or E2E runtime override.

- [ ] **Step 3: Verify and commit Task 4**

```bash
cd apps/web
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bun run check

git add src/lib/services/gameplay/runtime.ts src/lib/services/gameplay/runtime.test.ts
git commit -m "feat(web): randomize rotation setup per run"
```

---

## Task 5: Keep hints visible and reveal the corresponding tray piece

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `docs/PRD.md`

**Interfaces:**

- No session hint action/event changes.
- `PuzzleInventoryPanel` keeps current props; `activeHintPieceId` drives drawer/reveal/roving presentation.
- `activeHintPieceId` and `activeHintTarget` remain route-local.

**Produces:** one persistent visual relationship between the hinted tray piece and board target, with no focus/selection side effect and no stale PRD lifetime.

- [ ] **Step 1: Add failing inventory reveal tests**

Stub `scrollIntoView` in `PuzzleInventoryPanel.svelte.test.ts`:

```ts
const scrollIntoView = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
```

Add:

```ts
it('opens the drawer and reveals the hinted piece without selecting or focusing it', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);

	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	const focusedBefore = document.activeElement;

	await view.rerender({ ...input, activeHintPieceId: 1 });

	await expect.element(page.getByRole('button', { name: 'Collapse inventory' })).toBeVisible();
	await expect.element(page.getByTestId('piece-slot-1')).toHaveAttribute('data-hinted', 'true');
	await expect.element(page.getByTestId('hint-piece-badge')).toHaveTextContent('HINT');
	expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
	expect(input.onSelect).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(focusedBefore);
});

it('makes the hinted piece the roving candidate without moving focus', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);
	const first = await page.getByLabelText('Puzzle piece 1').element();
	first.focus();

	await view.rerender({ ...input, activeHintPieceId: 0 });
	const hinted = await page.getByLabelText('Puzzle piece 0').element();

	await expect.poll(() => hinted.tabIndex).toBe(0);
	expect(document.activeElement).toBe(first);
});
```

Keep the existing hinted-over-rejected precedence test and update expected classes/data attributes.

- [ ] **Step 2: Remove the route timer and make hint lifetime explicit**

Delete:

- `HINT_DURATION_MS`
- `hintTimeout`
- all `clearTimeout(hintTimeout)` branches
- timeout scheduling in `showHintTarget`

Keep:

```ts
function clearHintTarget() {
	activeHintPieceId = null;
	activeHintTarget = null;
}

function showHintTarget(pieceId: number, target: { x: number; y: number }) {
	activeHintPieceId = pieceId;
	activeHintTarget = target;
}
```

Existing cleanup already clears the hint on successful placement of that piece, transient lifecycle cleanup, puzzle navigation, and teardown. Add/adjust route tests to prove:

- hint remains after advancing fake timers beyond 1.8 seconds;
- a second hint replaces the first;
- placing the hinted piece clears both tray and board markers;
- Pause clears it;
- navigation clears it.

Do not clear hints on Undo/Redo or selection alone; existing keyboard-shortcut coverage already expects hint state to survive Undo/Redo.

- [ ] **Step 3: Reveal the hinted tray slot in `PuzzleInventoryPanel`**

Add an effect after the existing active-piece normalization:

```ts
$effect(() => {
	const pieceId = activeHintPieceId;
	if (pieceId === null) return;

	drawerOpen = true;
	activePieceId = pieceId;

	piecesGridElement
		?.querySelector<HTMLElement>(`[data-testid="piece-slot-${pieceId}"]`)
		?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
```

Do not call `.focus()`.

Update the slot markup:

```svelte
<div
	class:hinted={activeHintPieceId === piece.id}
	data-testid={`piece-slot-${piece.id}`}
	data-hinted={activeHintPieceId === piece.id ? 'true' : undefined}
>
	{#if activeHintPieceId === piece.id}
		<span class="hint-piece-badge" data-testid="hint-piece-badge" aria-hidden="true">HINT</span>
	{/if}
	<PuzzlePiece ... />
</div>
```

Use existing tokens:

```css
.piece-slot.hinted {
	border-color: var(--gold);
	box-shadow: 0 0 14px var(--gold-glow);
}

.hint-piece-badge {
	position: absolute;
	top: 0.2rem;
	right: 0.2rem;
	z-index: 2;
	color: var(--gold);
	background: var(--bg-0);
	border: 1px solid var(--gold);
}
```

Ensure `.piece-slot` is positioned for the badge.

- [ ] **Step 4: Align the board target to the same gold cue**

In `PuzzleBoard.svelte`, replace the amber-only hint target treatment with a stable class using `var(--gold)` / `var(--gold-glow)`. Keep `data-testid="hint-target"`, `data-x`, and `data-y` unchanged so route/E2E selectors remain stable.

No hint-selection logic belongs in the board.

- [ ] **Step 5: Update `docs/PRD.md` in the same implementation commit**

Update the document date/version per the repo’s normal convention, then replace both stale 1.8-second descriptions:

Current scope bullet:

```text
Hint system (highlights the target cell for the selected or next unplaced piece for 1.8 s)
```

becomes the equivalent of:

```text
Hint system (reveals/highlights the selected or next unplaced tray piece and its target cell until placement, replacement, or gameplay lifecycle cleanup)
```

Gameplay requirement row:

```text
board cell glows for 1.8 s
```

becomes the same persistent tray-piece + board-target contract.

Also replace `seeded random init` in the Piece rotation row with wording that reflects fresh randomized orientation at setup/restart while restored state persists.

- [ ] **Step 6: Verify and commit Task 5**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check

git grep -n '1\.8 s\|1\.8s\|seeded random init' -- ../../docs/PRD.md || true
```

Expected grep: no stale wording.

Commit:

```bash
git add src/lib/components/PuzzleInventoryPanel.svelte \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/lib/components/PuzzleBoard.svelte \
  'src/routes/puzzle/[id]/+page.svelte' \
  'src/routes/puzzle/[id]/page.svelte.test.ts' \
  ../../docs/PRD.md
git commit -m "feat(web): reveal persistent hint relationship"
```

---

## Task 6: Update E2E only after component/route behavior is green

**Files:**

- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-large-fixtures.spec.ts`

**Interfaces:**

- Reuse `GameplayPage.pauseMission()`; do not add a second Pause helper.
- Reuse `IMMEDIATE_START` already defined in `gameplay-large-fixtures.spec.ts` for any resizer/hint interaction case.
- Keep existing deterministic fixture/runtime overrides.

**Produces:** integration coverage that can actually interact with the active page and verifies the changed contracts end-to-end.

- [ ] **Step 1: Rewrite the restored Relaxed session-control E2E**

The existing restored Relaxed + rotation test currently expects `Resume Mission`. Change it so route entry is already active:

```ts
await gameplayPage.gotoFixture({ seedSession: seeded });

await expect(page.getByRole('dialog', { name: 'Resume Mission' })).toHaveCount(0);
await expect(page.getByTestId('relaxed-mode-indicator')).toBeVisible();

// Pause manually before exercising Restart.
await gameplayPage.pauseMission();
await page.getByRole('dialog', { name: 'Mission Paused' })
	.getByRole('button', { name: 'Restart' })
	.click();
```

Keep the existing assertions that Restart retains Relaxed + rotation choices, produces a fresh run ID, clears placements, and uses the restart tray order.

Keep/add a restored Timed case that still expects `Resume Mission` before play.

- [ ] **Step 2: Add direct Exit and confirmed Pause Discard E2E cases**

Direct Exit:

```ts
test('Exit saves progress and returns to the arcade without a choice dialog @smoke', async ({
	gameplayPage,
	page
}) => {
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);

	await page.getByTestId('back-to-arcade-link').click();

	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('dialog', { name: 'Exit Mission' })).toHaveCount(0);
	const persisted = await gameplayPage.readPersistedSession();
	expect(persisted?.placedPieces).toHaveLength(1);
});
```

If `IMMEDIATE_START` is not currently imported in this spec, define the same small preferences constant from `DEFAULT_GAMEPLAY_PREFERENCES` rather than opening setup in this test.

Discard:

```ts
test('Pause Discard removes saved progress after confirmation @smoke', async ({
	gameplayPage,
	page
}) => {
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
	await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
	await gameplayPage.pauseMission();

	await page.getByRole('button', { name: 'Discard' }).click();
	await page.getByRole('dialog', { name: 'Discard saved progress' })
		.getByRole('button', { name: 'Discard' })
		.click();

	await expect(page).toHaveURL(/\/$/);
	expect(await gameplayPage.readPersistedSession()).toBeNull();
});
```

- [ ] **Step 3: Add one chromium-desktop-only large-fixture resizer + hint test that starts the run**

Use the existing `IMMEDIATE_START`; without it, mandatory Mission Setup makes the page inert.

```ts
test('desktop tray resizer and hint reveal stay usable @extended', async ({
	gameplayPage,
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop-only resizer behavior');

	await gameplayPage.gotoFixture({
		fixtureId: 'e2e-square-100',
		seedPreferences: IMMEDIATE_START
	});

	const layout = page.locator('.game-layout');
	const separator = page.getByTestId('tray-resizer');
	const before = await layout.evaluate((element) =>
		getComputedStyle(element).getPropertyValue('--tray-width').trim()
	);

	const box = await separator.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.mouse.down();
	await page.mouse.move(box!.x - 80, box!.y + box!.height / 2);
	await page.mouse.up();

	const after = await layout.evaluate((element) =>
		getComputedStyle(element).getPropertyValue('--tray-width').trim()
	);
	expect(after).not.toBe(before);
	await expect(page.getByTestId('puzzle-board')).toBeVisible();

	// Select a late piece, then deliberately move the tray away from it.
	await page.getByLabel('Puzzle piece 99', { exact: true }).click();
	await page.locator('.pieces-grid').evaluate((element) => {
		element.scrollTop = 0;
	});

	await page.getByLabel('Hint').click();
	await expect(page.getByTestId('piece-slot-99')).toHaveAttribute('data-hinted', 'true');
	await expect(page.getByTestId('piece-slot-99')).toBeInViewport();
	await expect(page.getByTestId('hint-target')).toBeVisible();
});
```

The selected-piece hint path is existing policy; this E2E only proves reveal/presentation.

- [ ] **Step 4: Run focused E2E gates and commit**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-large-fixtures.spec.ts --project=chromium-desktop \
  --grep 'desktop tray resizer and hint reveal'

git add e2e/gameplay-session-controls.spec.ts e2e/gameplay-large-fixtures.spec.ts
git commit -m "test(web): cover gameplay polish flows"
```

---

## Final Verification

- [ ] **Step 1: Review the implementation diff for scope**

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- \
  apps/web/src/lib/components \
  apps/web/src/lib/services/puzzleLayout.ts \
  apps/web/src/lib/services/puzzleLayout.test.ts \
  apps/web/src/lib/services/gameplay/runtime.ts \
  apps/web/src/lib/services/gameplay/runtime.test.ts \
  apps/web/src/routes \
  apps/web/e2e \
  docs/PRD.md
```

Expected production changes are limited to the puzzle/home routes, discard/pause/inventory/board components, the small puzzle-layout clamp, runtime rotation factory, E2E specs, and PRD wording. There must be no session schema, backend, dependency, generic split-pane, or unrelated refactor diff.

- [ ] **Step 2: Run the complete focused gate**

```bash
cd apps/web
bunx vitest --run src/lib/services/puzzleLayout.test.ts
bunx vitest --run src/lib/services/gameplay/runtime.test.ts
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
bunx vitest --run --browser src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
bunx vitest --run --browser src/routes/page.svelte.test.ts
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-large-fixtures.spec.ts --project=chromium-desktop \
  --grep 'desktop tray resizer and hint reveal'
```

- [ ] **Step 3: Confirm stale contracts are gone**

```bash
git grep -n 'ExitSessionDialog\|Save & Exit\|Exit Mission' -- apps/web/src || true
git grep -n '1\.8 s\|1\.8s\|seeded random init' -- docs/PRD.md || true
```

Expected: both commands return no stale contract.

- [ ] **Step 4: Manually smoke one desktop flow**

```text
1. Start a Relaxed rotation-enabled puzzle and confirm pieces begin in mixed orientations.
2. Place one piece, Exit, and confirm navigation home occurs without an Exit popup.
3. Continue the Relaxed run and confirm no Resume Mission popup appears.
4. Pause, open Discard, cancel, and confirm Mission Paused returns unchanged.
5. Drag and keyboard-resize the tray; shrink the viewport and confirm the tray reclamps.
6. Request a hint with an offscreen piece and confirm both tray piece and board target remain marked.
7. Exit, use home Discard, confirm, and verify the Continue panel refreshes.
```
