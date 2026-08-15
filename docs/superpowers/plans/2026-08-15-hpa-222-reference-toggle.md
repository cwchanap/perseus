# HPA-222 Persistent Reference Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Hold-to-Peek, add one persistent Reference toggle, and make the existing `PuzzleSession.activeReferenceMode` the canonical reference-presentation state without adding a new store, persistence field, or assistance framework.

**Architecture:** Extend the existing concrete `PuzzleToolbar` / `PuzzleBoardPanel` / route composition. `PuzzleSession` owns active reference mode and scoring/counters; the route owns only DOM Hold bookkeeping; `PuzzleBoardPanel` owns only image-load failure state. Every transition into `completed` clears the runtime reference mode in the existing lifecycle primitive. Pause/restart/image failure clear any active reference while the session is still active, while ordinary window blur ends Hold only so a persistent Toggle remains persistent.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, pure `PuzzleSession` tests, existing Playwright Chromium desktop/mobile smoke coverage, Bun.

## Global Constraints

- Follow the approved design: `docs/superpowers/specs/2026-08-15-hpa-222-reference-toggle-design.md`.
- Do not add a store, controller, action registry, popover/menu framework, or assistance abstraction.
- Do not add persisted reference-mode state or change `CURRENT_SESSION_SCHEMA_VERSION`.
- Do not add result classes, analytics, preference persistence, Ghost Reference UI, opacity controls, or image alignment.
- Keep `ReferenceMode = 'hold' | 'toggle' | 'ghost'`; HPA-222 consumes the already-existing `toggle` mode and leaves `ghost` unused.
- Hold and Toggle Reference remain informational. Hint remains the HPA-222-visible assistance that makes a timed run assisted.
- Keep HPA-217's responsive toolbar grouping and compact `MORE` behavior intact.
- Do not add a visible scoring paragraph to the toolbar. Reuse Mission Setup help and a shared screen-reader-only toolbar description.
- Window blur ends Hold only; it must not turn off persistent Toggle.
- Clear any active reference **before** pause/restart/active-exit transitions because `set_reference_mode` is rejected outside active lifecycle.
- Keep the existing `checkpointSession()` after Peek activation, and checkpoint Toggle-on. `activeReferenceMode` itself remains runtime-only, but `referenceActivations` and `hasUserActivity` are persisted.
- Keep HPA-223 keyboard-grid / Escape / live-region work out of this ticket.
- Do not add a new Playwright project or spec. Update and run the existing HPA-217/HPA-219 mobile toolbar smoke caller.

## Risk fences

1. **Redo-to-completed bypasses `handleBoardCompletion()`.** Completion cleanup belongs in `transitionToInternal()` when `to === 'completed'`.
2. **Blur is not lifecycle cleanup.** Use separate Hold-only cleanup and all-mode lifecycle cleanup paths.
3. **Peek + REF add another primary toolbar control.** No permanent help paragraph; update and run `e2e/gameplay-mobile-tap.spec.ts` at 390 × 844.
4. **Reference activation is persisted evidence.** Preserve the Peek-down checkpoint and checkpoint Toggle-on.

---

## Task 1: Lock the session-domain contract and clear reference mode at every completed entry

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`

**Interfaces:**

- Consumes: existing `PuzzleSessionAction` `{ type: 'set_reference_mode'; mode: ReferenceMode | null }`, existing `transitionToInternal(to: SessionLifecycle)`.
- Produces: invariant that `state.activeReferenceMode === null` whenever lifecycle transitions into `completed`.

### 1.1 Add a contract regression for informational Hold/Toggle scoring

- [ ] Add this test near the existing reference-assistance tests:

```ts
it('keeps hold and toggle reference informational while hint is assisted', () => {
	const session = createPuzzleSession(makeOptions({ metadata: makeMetadata(2) }));
	session.dispatch({ type: 'start' });

	session.dispatch({ type: 'set_reference_mode', mode: 'hold' });
	expect(session.getState().resultClass).toBe('standard_timed');
	session.dispatch({ type: 'set_reference_mode', mode: null });

	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
	expect(session.getState().resultClass).toBe('standard_timed');
	session.dispatch({ type: 'set_reference_mode', mode: null });

	expect(session.getState().counters.referenceActivations).toBe(2);

	session.dispatch({ type: 'use_hint' });
	expect(session.getState().resultClass).toBe('assisted_timed');
});
```

This is **not** a red test. The current implementation should already pass it; it documents the scoring/counter contract the UI work relies on.

### 1.2 Add a failing first-completion cleanup test

- [ ] Add:

```ts
it('clears active reference mode when the board first completes', () => {
	const session = createPuzzleSession(makeOptions({ metadata: makeMetadata(2) }));
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });

	session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });

	expect(session.getState().lifecycle).toBe('completed');
	expect(session.getState().activeReferenceMode).toBeNull();
});
```

### 1.3 Add a failing redo-to-completed cleanup test

- [ ] Add a separate test so the first-completion assertion cannot hide the redo path:

```ts
it('clears active reference mode when redo restores a completed board', () => {
	const session = createPuzzleSession(makeOptions({ metadata: makeMetadata(2) }));
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
	session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
	 expect(session.getState().lifecycle).toBe('completed');

	session.dispatch({ type: 'undo' });
	expect(session.getState().lifecycle).toBe('active');

	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
	expect(session.getState().activeReferenceMode).toBe('toggle');

	session.dispatch({ type: 'redo' });

	expect(session.getState().lifecycle).toBe('completed');
	expect(session.getState().activeReferenceMode).toBeNull();
});
```

Remove the accidental leading space before `expect` if the formatter does not do so automatically.

### 1.4 Run the focused session test before implementation

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected before production change:

- the scoring/counter regression passes;
- the first-completion cleanup test fails because Toggle survives completion;
- the redo cleanup test fails because `doRedo()` enters completed lifecycle directly through `transitionToInternal('completed')`.

### 1.5 Clear the runtime mode in the common completed-lifecycle primitive

- [ ] Update `transitionToInternal()` exactly at the existing lifecycle assignment:

```ts
function transitionToInternal(to: SessionLifecycle) {
	const from = state.lifecycle;
	if (to === 'completed') state.activeReferenceMode = null;
	state.lifecycle = to;
	emit({ type: 'lifecycle', from, to });
}
```

Do not put this only in `handleBoardCompletion()`: `doRedo()` bypasses that helper.

Do not add a lifecycle observer, event subscriber, persisted field, or new action.

### 1.6 Re-run the focused session test

- [ ] Run the same command and confirm all session tests pass.

### 1.7 Commit

- [ ] Commit:

```bash
git add apps/web/src/lib/services/gameplay/session/session.ts \
  apps/web/src/lib/services/gameplay/session/session.test.ts
git commit -m "fix(web): clear reference mode on completion"
```

---

## Task 2: Split toolbar assistance into Peek + persistent Reference without adding toolbar chrome

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Interfaces:**

- Consumes: existing Hold callbacks `onReferenceDown` / `onReferenceUp`.
- Produces: `onReferenceToggle: () => void`, `referenceToggled: boolean`, `referenceAvailable: boolean`; native Peek and Toggle buttons; shared assistance description id `puzzle-assistance-result-help`.

### 2.1 Update toolbar test defaults

- [ ] Extend `createToolbarProps()` with:

```ts
onReferenceToggle: vi.fn(),
referenceToggled: false,
referenceAvailable: true,
```

Keep `hasReference` optional as today.

### 2.2 Rename existing Hold assertions to Peek

- [ ] Replace existing `Reference` hold-control queries with:

```ts
page.getByLabelText('Hold to peek reference')
```

Keep all pointer-down/up/leave, Space/Enter keydown/keyup, and blur callback tests. Those callbacks remain `onReferenceDown` / `onReferenceUp`.

### 2.3 Add failing persistent Toggle tests

- [ ] Add:

```ts
it('calls onReferenceToggle from the persistent Reference button', async () => {
	const onReferenceToggle = vi.fn();
	renderToolbar({ onReferenceToggle });

	await userEvent.click(page.getByLabelText('Toggle reference'));
	expect(onReferenceToggle).toHaveBeenCalledOnce();
});

it('exposes persistent Reference state with aria-pressed', async () => {
	renderToolbar({ referenceToggled: true });
	await expect
		.element(page.getByLabelText('Toggle reference'))
		.toHaveAttribute('aria-pressed', 'true');
});

it('disables Peek while persistent Reference is active', async () => {
	renderToolbar({ referenceToggled: true });
	await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();
});

it('disables both reference controls when the declared reference is unavailable', async () => {
	renderToolbar({ hasReference: true, referenceAvailable: false });
	await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();
	await expect.element(page.getByLabelText('Toggle reference')).toBeDisabled();
});
```

- [ ] Keep `hasReference: false` coverage, but assert both `Hold to peek reference` and `Toggle reference` are absent.

### 2.4 Add failing assistance-description tests

- [ ] Add one shared help-node assertion:

```ts
it('describes assistance scoring without adding visible toolbar help chrome', async () => {
	renderToolbar();

	const help = page.getByText('Hint affects timed results. Peek and Reference do not.');
	await expect.element(help).toBeInTheDocument();
	await expect.element(help).toHaveAttribute('id', 'puzzle-assistance-result-help');

	for (const label of ['Hint', 'Hold to peek reference', 'Toggle reference']) {
		await expect
			.element(page.getByLabelText(label))
			.toHaveAttribute('aria-describedby', 'puzzle-assistance-result-help');
	}
});
```

The help node is screen-reader-only; do **not** assert `toBeVisible()`.

### 2.5 Run the toolbar test and confirm new cases fail

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

### 2.6 Extend only the concrete Props surface

- [ ] Add:

```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

- [ ] Give state props safe defaults for isolated callers:

```ts
referenceToggled = false,
referenceAvailable = true,
```

Do not create an assistance action array, registry, controller, or generic toggle component.

### 2.7 Rename the existing Hold button to Peek and preserve event semantics

- [ ] Keep the existing pointer/keyboard handlers, but change the control to:

```svelte
<button
	type="button"
	aria-label="Hold to peek reference"
	aria-describedby="puzzle-assistance-result-help"
	disabled={!referenceAvailable || referenceToggled}
	onpointerdown={(event) => onReferenceDown(event)}
	onpointerup={(event) => onReferenceUp(event)}
	onpointerleave={(event) => onReferenceUp(event)}
	onkeydown={(event) => {
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			onReferenceDown(event);
		}
	}}
	onkeyup={(event) => {
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			onReferenceUp(event);
		}
	}}
	onblur={() => onReferenceUp()}
	class="arcade-btn-ghost toolbar-button"
>
	PEEK
</button>
```

### 2.8 Add one native persistent Reference button

- [ ] Next to Peek, add:

```svelte
<button
	type="button"
	aria-label="Toggle reference"
	aria-pressed={referenceToggled ? 'true' : 'false'}
	aria-describedby="puzzle-assistance-result-help"
	disabled={!referenceAvailable}
	onclick={onReferenceToggle}
	class="arcade-btn-ghost toolbar-button"
>
	REF
</button>
```

Reuse the existing `[aria-pressed='true']` style already used by Rotation.

### 2.9 Add shared screen-reader-only scoring help and describe Hint

- [ ] Add `aria-describedby="puzzle-assistance-result-help"` to the existing Hint button.

- [ ] Add this node once inside the toolbar root:

```svelte
<span id="puzzle-assistance-result-help" class="sr-only">
	Hint affects timed results. Peek and Reference do not.
</span>
```

Do not add a visible `<p>` or CSS that increases toolbar height.

### 2.10 Re-run the toolbar test

- [ ] Confirm old and new toolbar tests pass, including HPA-217 `MORE` expanded/collapsed tests.

### 2.11 Commit

- [ ] Commit:

```bash
git add apps/web/src/lib/components/PuzzleToolbar.svelte \
  apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
git commit -m "feat(web): add persistent reference toolbar action"
```

---

## Task 3: Disable reference actions when the image cannot be used

**Files:**

- Modify: `apps/web/src/lib/components/ReferenceOverlay.svelte`
- Modify: `apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`

**Interfaces:**

- `ReferenceOverlay` produces optional `onUnavailable?: () => void` notification.
- `PuzzleBoardPanel` consumes route-derived `referenceToggled` and callbacks, owns `referenceLoadFailed`, and produces `onReferenceUnavailable()` only when the current image fails.

### 3.1 Add a failing overlay error-callback test

- [ ] Add:

```ts
it('notifies its owner when the reference image fails', async () => {
	const onUnavailable = vi.fn();
	render(ReferenceOverlay, {
		imageUrl: '/broken-reference',
		active: true,
		onUnavailable
	});

	const image = await page.getByRole('img', { name: 'Puzzle reference' }).element();
	image.dispatchEvent(new Event('error'));

	expect(onUnavailable).toHaveBeenCalledOnce();
});
```

### 3.2 Run the overlay test and confirm it fails

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
```

### 3.3 Add the minimal overlay callback

- [ ] Extend props:

```ts
interface Props {
	imageUrl?: string | null;
	active: boolean;
	onUnavailable?: () => void;
}
```

- [ ] Destructure `onUnavailable` and add:

```ts
function handleImageError() {
	imageError = true;
	onUnavailable?.();
}
```

- [ ] Wire:

```svelte
onerror={handleImageError}
```

Do not add retries, preloading, or a loader service.

### 3.4 Extend board-panel test defaults

- [ ] Add:

```ts
referenceToggled: false,
onReferenceToggle: vi.fn(),
onReferenceUnavailable: vi.fn(),
```

- [ ] Update existing Hold query from `Reference` to `Hold to peek reference`.

### 3.5 Add failing board availability tests

- [ ] Add a declared-but-missing URL case:

```ts
it('disables reference controls when a declared reference URL is unavailable', async () => {
	render(PuzzleBoardPanel, props({ referenceImageUrl: null }));

	await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();
	await expect.element(page.getByLabelText('Toggle reference')).toBeDisabled();
});
```

- [ ] Add a load-failure case:

```ts
it('marks the current reference unavailable after an image error', async () => {
	const input = props({ referenceActive: true });
	render(PuzzleBoardPanel, input);

	const image = await page.getByRole('img', { name: 'Puzzle reference' }).element();
	image.dispatchEvent(new Event('error'));

	expect(input.onReferenceUnavailable).toHaveBeenCalledOnce();
	await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();
	await expect.element(page.getByLabelText('Toggle reference')).toBeDisabled();
});
```

- [ ] Add a rerender case that fails one URL, rerenders with another puzzle/reference key, and asserts the controls become enabled again.

### 3.6 Run the board-panel test and confirm new cases fail

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

### 3.7 Keep image failure local to `PuzzleBoardPanel`

- [ ] Add the external props:

```ts
referenceToggled: boolean;
onReferenceToggle: () => void;
onReferenceUnavailable: () => void;
```

- [ ] Add local state:

```ts
let referenceLoadFailed = $state(false);
const referenceAssetKey = $derived(`${puzzle.id}:${referenceImageUrl ?? ''}`);

$effect(() => {
	void referenceAssetKey;
	referenceLoadFailed = false;
});

const referenceAvailable = $derived(
	puzzle.hasReference === true && referenceImageUrl !== null && !referenceLoadFailed
);
```

- [ ] Add:

```ts
function handleReferenceUnavailable() {
	referenceLoadFailed = true;
	onReferenceUnavailable();
}
```

### 3.8 Wire overlay and toolbar

- [ ] Pass the callback to the overlay:

```svelte
<ReferenceOverlay
	imageUrl={referenceImageUrl}
	active={referenceActive}
	onUnavailable={handleReferenceUnavailable}
/>
```

- [ ] Keep:

```svelte
hasReference={puzzle.hasReference === true}
```

for whether controls exist, and pass:

```svelte
{referenceAvailable}
{referenceToggled}
{onReferenceToggle}
```

The panel must not own or infer `ReferenceMode`; it only knows whether the Toggle is pressed and whether the asset is usable.

### 3.9 Re-run overlay + board tests

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

### 3.10 Commit

- [ ] Commit:

```bash
git add apps/web/src/lib/components/ReferenceOverlay.svelte \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
git commit -m "fix(web): disable unavailable puzzle references"
```

---

## Task 4: Make the route consume `activeReferenceMode` directly and preserve Hold/Toggle lifecycle semantics

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- Consumes: `sessionState.activeReferenceMode`, `set_reference_mode`, `checkpointSession()`, existing route lifecycle helpers.
- Produces: derived `referenceActive` / `referenceToggled`, `handleReferenceToggle()`, Hold-only cleanup, all-mode transient cleanup, image-unavailable cleanup.

### 4.1 Rename existing Hold route queries first

- [ ] Change existing route tests from `Reference` to `Hold to peek reference` while preserving:

- pointer Hold shows overlay only while held;
- matching global pointer-up ends Hold;
- mismatched pointer-up does not end Hold;
- window blur ends pointer Hold;
- window blur ends keyboard Hold.

Do not change the behavioral assertions yet.

### 4.2 Add a failing persistent Toggle test

- [ ] Add:

```ts
it('keeps Reference visible until the persistent toggle is turned off', async () => {
	await renderPuzzlePage();

	const toggle = page.getByLabelText('Toggle reference');
	await toggle.click();
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect.element(page.getByTestId('reference-overlay')).toBeVisible();
	await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();

	await toggle.click();
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
});
```

### 4.3 Add the key blur regression: Toggle survives focus loss

- [ ] Add:

```ts
it('keeps persistent Reference active across window blur', async () => {
	await renderPuzzlePage();

	const toggle = page.getByLabelText('Toggle reference');
	await toggle.click();
	await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

	window.dispatchEvent(new Event('blur'));

	await expect.element(page.getByTestId('reference-overlay')).toBeVisible();
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
});
```

This test intentionally differs from the existing Hold-blur tests.

### 4.4 Add lifecycle cleanup tests for navigation and pause

- [ ] Navigation test:

1. Toggle Reference on.
2. Change `mockPageStore` to a second valid puzzle.
3. Wait for the new mission heading.
4. Assert `reference-overlay` is absent.
5. Assert `Toggle reference` has `aria-pressed="false"` for the new session.

- [ ] Explicit pause test:

1. Toggle Reference on.
2. Open `More puzzle actions` if required by the test viewport.
3. Click `Pause mission`.
4. Assert the overlay is absent while the pause dialog is visible.
5. Resume.
6. Assert Toggle is no longer pressed.

Completion cleanup is owned by Task 1; do not duplicate engine internals here.

### 4.5 Add a failing image-error integration test

- [ ] Add:

1. Start Peek so the overlay image exists.
2. Dispatch `error` on the `Puzzle reference` image.
3. Assert the overlay closes.
4. Assert Peek and Toggle Reference are disabled.
5. Inspect the latest checkpointed/session state only as needed to prove the route cleared the active mode; do not introduce a route-only reference boolean for the test.

### 4.6 Extend an existing setup test with visible scoring help

- [ ] In the fresh mandatory-setup test, add:

```ts
await expect
	.element(
		page.getByText(
			'Choose your mode and rotation settings before starting. Hints affect timed results; Peek and Reference do not.'
		)
	)
	.toBeVisible();
```

Use the existing `MissionSetupDialog.inputHelp` surface; do not add a toolbar paragraph.

### 4.7 Run the route test before implementation

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: renamed Hold tests may fail until toolbar work is present if tasks are run out of order; the new Toggle/blur/lifecycle/image-error tests fail until route wiring is implemented.

### 4.8 Remove duplicated overlay state and derive presentation from the session

- [ ] Delete:

```ts
let showReferenceOverlay = $state(false);
```

- [ ] Add derived values beside other session-derived state:

```ts
const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
const referenceActive = $derived(activeReferenceMode !== null);
const referenceToggled = $derived(activeReferenceMode === 'toggle');
```

Overlay visibility and pressed state must now follow the session snapshot only.

### 4.9 Add two distinct cleanup helpers

- [ ] Add a Hold-only helper:

```ts
function clearReferenceHold(): void {
	referencePointerId = null;
	referenceHoldSource = null;

	if (
		sessionState?.lifecycle === 'active' &&
		sessionState.activeReferenceMode === 'hold'
	) {
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}
}
```

- [ ] Add an all-mode helper for deliberate lifecycle/image cleanup:

```ts
function clearActiveReference(): void {
	referencePointerId = null;
	referenceHoldSource = null;

	if (
		sessionState?.lifecycle === 'active' &&
		sessionState.activeReferenceMode !== null
	) {
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}
}
```

Do not merge these helpers: their difference is the persistent Toggle contract.

### 4.10 Make Peek mode-safe and preserve the activation checkpoint

- [ ] Replace `handleReferenceDown` with:

```ts
function handleReferenceDown(event?: PointerEvent | KeyboardEvent) {
	if (!sessionStore || sessionState?.lifecycle !== 'active') return;
	if (sessionState.activeReferenceMode === 'toggle') return;

	const isPointerEvent = event instanceof PointerEvent;
	referenceHoldSource = isPointerEvent ? 'pointer' : 'keyboard';
	referencePointerId = isPointerEvent ? event.pointerId : null;
	sessionStore.dispatch({ type: 'set_reference_mode', mode: 'hold' });
	checkpointSession();
}
```

The final `checkpointSession()` is required; do not drop it during refactoring.

- [ ] Replace `handleReferenceUp` with pointer/source validation followed by Hold-only cleanup:

```ts
function handleReferenceUp(event?: PointerEvent | KeyboardEvent) {
	if (referenceHoldSource === null) return;

	if (referenceHoldSource === 'pointer') {
		if (!(event instanceof PointerEvent) || event.pointerId !== referencePointerId) return;
	}

	clearReferenceHold();
}
```

A stale release cannot clear Toggle because `clearReferenceHold()` only dispatches null for `mode === 'hold'`.

### 4.11 Reuse the Hold-up path for global pointer-up

- [ ] Replace the duplicated global cleanup body with:

```ts
function handleWindowPointerUp(event: PointerEvent) {
	handleReferenceUp(event);
}
```

The pointer-id check remains inside `handleReferenceUp()`.

### 4.12 Keep blur Hold-only

- [ ] Replace the reference part of `handleWindowBlur()` with:

```ts
function handleWindowBlur() {
	if (referenceHoldSource !== null) {
		clearReferenceHold();
	}
	sessionStore?.dispatch({ type: 'cancel_selection' });
}
```

Do not call `clearActiveReference()` from blur. A Toggle must remain active.

### 4.13 Add the persistent Toggle handler

- [ ] Add:

```ts
function handleReferenceToggle(): void {
	if (!sessionStore || sessionState?.lifecycle !== 'active') return;

	referencePointerId = null;
	referenceHoldSource = null;
	const nextMode = sessionState.activeReferenceMode === 'toggle' ? null : 'toggle';
	sessionStore.dispatch({ type: 'set_reference_mode', mode: nextMode });

	if (nextMode !== null) checkpointSession();
}
```

Toggle-on checkpoints persisted activation/activity evidence. Toggle-off is runtime-only and does not need another write.

### 4.14 Extend existing transient cleanup for all active reference modes

- [ ] In `clearTransientGameplayState()` call:

```ts
clearActiveReference();
```

before the existing selection/hint/rejection cleanup.

- [ ] Remove old `showReferenceOverlay` mutations and the `referenceHoldSource !== null` conditional dispatch from that helper.

This helper runs before pause/restart/active-exit transitions, while `set_reference_mode` is still accepted.

### 4.15 Clear Hold bookkeeping on puzzle route reuse

- [ ] When tearing down the prior puzzle/session during `loadPuzzle`, set:

```ts
referencePointerId = null;
referenceHoldSource = null;
```

The route already sets `sessionState = null`; that automatically makes derived `referenceActive` false. Do not dispatch to a disposed session merely to clear a runtime-only mode.

### 4.16 Handle broken-image cleanup with the all-mode helper

- [ ] Add:

```ts
function handleReferenceUnavailable(): void {
	clearActiveReference();
}
```

This callback arrives while lifecycle is still active, so it can clear Hold or Toggle before the broken overlay disappears.

### 4.17 Update `PuzzleBoardPanel` wiring

- [ ] Replace route-local overlay state with:

```svelte
<PuzzleBoardPanel
	...
	referenceImageUrl={source.resolveReferenceImage() ?? null}
	{referenceActive}
	{referenceToggled}
	...
	onReferenceDown={handleReferenceDown}
	onReferenceUp={handleReferenceUp}
	onReferenceToggle={handleReferenceToggle}
	onReferenceUnavailable={handleReferenceUnavailable}
	...
/>
```

Keep the existing resolver call unless implementation proves it has side effects; do not introduce caching state just for style.

### 4.18 Extend Mission Setup's existing visible help text

- [ ] Change:

```svelte
inputHelp="Choose your mode and rotation settings before starting."
```

to:

```svelte
inputHelp="Choose your mode and rotation settings before starting. Hints affect timed results; Peek and Reference do not."
```

Do not add another paragraph to the toolbar or route layout.

### 4.19 Re-run the route test

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Confirm Hold, Toggle, blur, navigation, pause, image-error, setup-help, and existing gameplay cases pass.

### 4.20 Commit

- [ ] Commit:

```bash
git add 'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): wire persistent puzzle reference mode"
```

---

## Task 5: Update the existing mobile toolbar smoke caller and run the full verification fence

**Files:**

- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

No new production scope, Playwright project, fixture, or test file is added here.

### 5.1 Update the existing HPA-217 toolbar smoke test before running verification

- [ ] In `puzzle toolbar is direct on desktop and compact on phone @smoke`, replace the old single Reference assertion:

```ts
await expect(page.getByRole('button', { name: 'Reference' })).toBeVisible();
```

with concrete Peek + Toggle locators:

```ts
const peek = page.getByRole('button', { name: 'Hold to peek reference' });
const referenceToggle = page.getByRole('button', { name: 'Toggle reference' });
await expect(peek).toBeVisible();
await expect(referenceToggle).toBeVisible();
```

- [ ] Keep Undo, Redo, Hint, and `MORE` visible assertions unchanged.

### 5.2 Keep coarse-pointer target proof on the new primary controls

- [ ] Replace the single Hint geometry check with a loop over the assistance controls:

```ts
for (const control of [hint, peek, referenceToggle]) {
	const box = await control.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeGreaterThanOrEqual(44);
	expect(box!.height).toBeGreaterThanOrEqual(44);
}
```

This uses the existing 390 × 844 Chromium-mobile proof. Do not add a new geometry helper unless the existing file already has one worth reusing.

### 5.3 Preserve all existing overflow and secondary-panel assertions

- [ ] Do not remove these existing checks:

- toolbar box remains inside the viewport;
- secondary actions are hidden until `MORE` opens;
- Zoom/Fit/Rotation/Pause/Setup are actionable after `MORE` opens;
- secondary panel remains inside the viewport;
- `document.documentElement` has no horizontal overflow;
- `.puzzle-main` has no horizontal overflow;
- closing `MORE` hides secondary actions again.

No visible assistance paragraph should be present to consume additional toolbar height.

### 5.4 Run all directly affected Vitest files together

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

### 5.5 Run the existing responsive/mobile E2E spec in its existing projects

- [ ] Run:

```bash
cd apps/web
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-desktop \
  --project=chromium-mobile
```

This is required because the accessible name changes and extra primary control directly affect the existing smoke caller and 390 × 844 geometry.

### 5.6 Run the complete web unit suite

- [ ] Run:

```bash
cd apps/web
bun run test:unit
```

This catches other existing callers that still query the old `Reference` accessible name or instantiate changed component props.

### 5.7 Run Svelte/TypeScript checks

- [ ] Run:

```bash
cd apps/web
bun run check
```

### 5.8 Run formatting/lint checks

- [ ] Run:

```bash
cd apps/web
bun run lint
```

### 5.9 Scope check

- [ ] Confirm the implementation did **not** change:

- persisted schema/version;
- API/shared completion types;
- gameplay preferences schema;
- analytics;
- dependencies;
- Playwright projects/fixtures;
- HPA-223 keyboard navigation/live regions.

- [ ] Confirm the expected diff is limited to these production files:

```text
apps/web/src/lib/services/gameplay/session/session.ts
apps/web/src/lib/components/PuzzleToolbar.svelte
apps/web/src/lib/components/PuzzleBoardPanel.svelte
apps/web/src/lib/components/ReferenceOverlay.svelte
apps/web/src/routes/puzzle/[id]/+page.svelte
```

and these existing test callers:

```text
apps/web/src/lib/services/gameplay/session/session.test.ts
apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
apps/web/e2e/gameplay-mobile-tap.spec.ts
```

A different existing caller may need only an accessible-name/prop update if the full unit suite exposes one; do not broaden the feature to justify unrelated edits.

### 5.10 Commit the E2E caller update / verification fix

- [ ] If `gameplay-mobile-tap.spec.ts` was not already included in an earlier implementation commit, commit it separately:

```bash
git add apps/web/e2e/gameplay-mobile-tap.spec.ts
git commit -m "test(web): cover persistent reference toolbar layout"
```

If verification required another small HPA-222 regression fix, commit that fix separately with a specific message. Do not create an empty cleanup commit.

---

## Expected implementation shape

The completed feature should have one canonical state flow:

```text
Toolbar Peek / Reference
        |
        v
route dispatches set_reference_mode
        |
        v
PuzzleSession.activeReferenceMode
        |
        +----> route derives overlay active / toggle pressed
        |
        +----> existing counters + result class

Hold release / window blur
        |
        v
clearReferenceHold()  -- clears only mode === 'hold'

Pause / restart / active exit / image failure
        |
        v
clearActiveReference() -- clears hold or toggle while lifecycle is active

Any lifecycle entry -> completed
        |
        v
transitionToInternal() clears activeReferenceMode

ReferenceOverlay image error
        |
        v
PuzzleBoardPanel marks current image unavailable
        |
        v
route clearActiveReference()
```

There must be no parallel `showReferenceOverlay` or route-local persistent `referenceToggled` state after implementation.

## Done criteria

- Peek still works with pointer and keyboard press/release.
- Peek activation still checkpoints `referenceActivations` / `hasUserActivity`.
- Persistent Reference remains visible until explicitly turned off, including across ordinary window blur.
- Persistent Reference uses `aria-pressed` and native keyboard activation.
- Peek is disabled while Toggle is active.
- Hint remains assisted; Peek/Toggle remain standard for timed runs.
- Navigation, explicit pause/restart/active-exit, completion (including redo-to-completed), and image failure cannot leave the reference active.
- Missing/broken reference images cannot keep reference actions usable.
- Mission Setup visibly explains scoring, and Hint/Peek/Reference share concise screen-reader guidance without a visible toolbar paragraph.
- No active reference mode is persisted or restored.
- The existing 390 × 844 mobile toolbar smoke test passes with both Peek and Toggle present and without horizontal overflow.
- No new architecture/framework/package/Playwright project was added.
- Focused Vitest files, existing mobile/desktop E2E spec, full web unit tests, `check`, and `lint` pass.
