# HPA-222 Persistent Reference Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Hold-to-Peek, add one persistent Reference toggle, and make the existing `PuzzleSession.activeReferenceMode` the canonical reference-presentation state without adding a new store, persistence field, or assistance framework.

**Architecture:** Extend the existing concrete `PuzzleToolbar` / `PuzzleBoardPanel` / route composition. `PuzzleSession` owns active reference mode and scoring/counters; the route owns only DOM hold bookkeeping; `PuzzleBoardPanel` owns only image-load failure presentation state. Reuse `clearTransientGameplayState()` for pause/restart cleanup and clear the runtime mode directly at board completion.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, existing pure `PuzzleSession` tests, Bun.

## Global Constraints

- Follow the approved design: `docs/superpowers/specs/2026-08-15-hpa-222-reference-toggle-design.md`.
- Do not add a store, controller, action registry, popover/menu framework, or assistance abstraction.
- Do not add persisted reference-mode state or change `CURRENT_SESSION_SCHEMA_VERSION`.
- Do not add result classes, analytics, preference persistence, Ghost Reference UI, opacity controls, or image alignment.
- Keep `ReferenceMode = 'hold' | 'toggle' | 'ghost'`; HPA-222 consumes the already-existing `toggle` mode and leaves `ghost` unused.
- Hold and Toggle Reference remain informational. Hint remains the only HPA-222-visible assistance that makes a timed run assisted.
- Keep HPA-217's responsive toolbar grouping and compact `MORE` behavior intact.
- Keep HPA-223 keyboard-grid / Escape / live-region work out of this ticket.
- Prefer focused existing test files. Do not add a new Playwright spec for state semantics already exercised by Vitest Browser Mode.

---

## Task 1: Lock the session-domain contract for informational reference and completion cleanup

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`

### 1.1 Write the failing result-class regression test

- [ ] Add a test near the existing assistance/reference session tests that starts a timed session and proves both existing reference modes are informational:

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

	session.dispatch({ type: 'use_hint' });
	expect(session.getState().resultClass).toBe('assisted_timed');
});
```

- [ ] Also assert the existing activation rule rather than inventing new counter semantics:

```ts
expect(session.getState().counters.referenceActivations).toBe(2);
```

This should already pass and documents the contract HPA-222 relies on.

### 1.2 Write the failing completion cleanup test

- [ ] Add a focused test using a 2-piece session:

```ts
it('clears active reference mode on completion and retained-seal recompletion', () => {
	const session = createPuzzleSession(makeOptions({ metadata: makeMetadata(2) }));
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });

	session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
	expect(session.getState().lifecycle).toBe('completed');
	expect(session.getState().activeReferenceMode).toBeNull();

	session.dispatch({ type: 'undo' });
	expect(session.getState().lifecycle).toBe('active');
	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
	expect(session.getState().activeReferenceMode).toBe('toggle');

	session.dispatch({ type: 'redo' });
	expect(session.getState().lifecycle).toBe('completed');
	expect(session.getState().activeReferenceMode).toBeNull();
});
```

The second half matters because `handleBoardCompletion()` has a retained-seal path that does not call `doComplete()`.

### 1.3 Run the focused test and confirm the cleanup case fails

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected before implementation: the new completion cleanup assertion fails because `activeReferenceMode` survives completion.

### 1.4 Clear runtime reference mode at the single completion boundary

- [ ] In `handleBoardCompletion()` clear the runtime-only mode before branching on an existing seal:

```ts
function handleBoardCompletion() {
	state.activeReferenceMode = null;

	if (state.sealedCompletion) {
		if (state.lifecycle !== 'completed') {
			transitionToInternal('completed');
		}
		return;
	}
	doComplete();
}
```

Do not add a new lifecycle hook or modify persistence. The field is already runtime-only.

### 1.5 Re-run the focused session test

- [ ] Run the same Vitest command and confirm both new tests pass.

### 1.6 Commit

- [ ] Commit:

```bash
git add apps/web/src/lib/services/gameplay/session/session.ts \
  apps/web/src/lib/services/gameplay/session/session.test.ts
git commit -m "fix(web): clear reference mode on completion"
```

---

## Task 2: Split toolbar assistance into Peek + persistent Reference

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

### 2.1 Update toolbar test defaults first

- [ ] Extend `createToolbarProps()` with the new concrete inputs:

```ts
onReferenceToggle: vi.fn(),
referenceToggled: false,
referenceAvailable: true,
```

Keep `hasReference` optional as today.

### 2.2 Replace ambiguous Reference-hold assertions with Peek assertions

- [ ] Rename existing hold-control queries from `Reference` to `Hold to peek reference`.
- [ ] Keep all current pointer down/up/leave, Space/Enter, and blur assertions. They should still call only `onReferenceDown` / `onReferenceUp`.

### 2.3 Add failing Toggle and help-copy tests

- [ ] Add tests for:

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

it('explains which assistance affects timed results', async () => {
	renderToolbar();
	await expect
		.element(page.getByText('Hint affects timed results. Peek and Reference do not.'))
		.toBeVisible();
});
```

- [ ] Keep the existing `hasReference: false` coverage, but assert **both** reference controls are absent.

### 2.4 Run the toolbar test and confirm the new cases fail

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

### 2.5 Extend the concrete Props surface

- [ ] Add only these props:

```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

- [ ] Give state props safe local defaults if needed by existing isolated callers:

```ts
referenceToggled = false,
referenceAvailable = true,
```

Do not create an assistance action array/type/registry.

### 2.6 Turn the existing hold button into clearly labeled Peek

- [ ] Keep the existing event handlers unchanged in shape, but use:

```svelte
aria-label="Hold to peek reference"
disabled={!referenceAvailable || referenceToggled}
```

- [ ] Change the short visible text from `REF` to `PEEK`.

### 2.7 Add one native persistent Reference button

- [ ] Next to Peek, add:

```svelte
<button
	type="button"
	aria-label="Toggle reference"
	aria-pressed={referenceToggled ? 'true' : 'false'}
	disabled={!referenceAvailable}
	onclick={onReferenceToggle}
	class="arcade-btn-ghost toolbar-button"
>
	REF
</button>
```

Reuse the existing `[aria-pressed='true']` styling already used by Rotation. Do not add a second active-state style.

### 2.8 Add one concise assistance help line

- [ ] Add visible text inside the existing toolbar root:

```svelte
<p class="assistance-help">Hint affects timed results. Peek and Reference do not.</p>
```

- [ ] Style it locally with existing text/font variables and allow it to wrap. Do not add a tooltip or modal.

### 2.9 Re-run the toolbar test

- [ ] Confirm all old and new toolbar tests pass, including compact `MORE` tests from HPA-217.

### 2.10 Commit

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

### 3.1 Add a failing overlay error-callback test

- [ ] Extend the overlay test with:

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

- [ ] Replace the inline image error assignment with:

```ts
function handleImageError() {
	imageError = true;
	onUnavailable?.();
}
```

and wire `onerror={handleImageError}`.

Do not add retries or preload logic.

### 3.4 Extend board-panel test props and write failing availability tests

- [ ] Add these defaults to the `props()` helper:

```ts
referenceToggled: false,
onReferenceToggle: vi.fn(),
onReferenceUnavailable: vi.fn(),
```

- [ ] Update existing Hold queries to `Hold to peek reference`.
- [ ] Add a test that `puzzle.hasReference === true` plus `referenceImageUrl: null` keeps Peek/Reference rendered but disabled.
- [ ] Add a failed-load test with `referenceActive: true` that dispatches an `error` event on the reference `<img>`, then asserts:
  - `onReferenceUnavailable` was called once;
  - Peek is disabled;
  - Toggle Reference is disabled.

### 3.5 Run the board-panel test and confirm the new cases fail

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

### 3.6 Keep image failure local to `PuzzleBoardPanel`

- [ ] Add the three new external props:

```ts
referenceToggled: boolean;
onReferenceToggle: () => void;
onReferenceUnavailable: () => void;
```

- [ ] Add one panel-local flag and reset key:

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

- [ ] Add the one local failure handler:

```ts
function handleReferenceUnavailable() {
	referenceLoadFailed = true;
	onReferenceUnavailable();
}
```

### 3.7 Wire overlay and toolbar without moving gameplay state into the panel

- [ ] Pass the error callback to the overlay:

```svelte
<ReferenceOverlay
	imageUrl={referenceImageUrl}
	active={referenceActive}
	onUnavailable={handleReferenceUnavailable}
/>
```

- [ ] Keep `hasReference={puzzle.hasReference === true}` for whether actions exist, and pass:

```svelte
{referenceAvailable}
{referenceToggled}
{onReferenceToggle}
```

Do not let `PuzzleBoardPanel` decide which `ReferenceMode` is active. It only knows Toggle pressed state and whether the image works.

### 3.8 Re-run overlay + board tests

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
```

### 3.9 Commit

- [ ] Commit:

```bash
git add apps/web/src/lib/components/ReferenceOverlay.svelte \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts
git commit -m "fix(web): disable unavailable puzzle references"
```

---

## Task 4: Make the route consume `activeReferenceMode` directly

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

### 4.1 Update the existing Hold route tests first

- [ ] Rename route queries from `Reference` to `Hold to peek reference` while preserving the current cases:
  - visible only during pointer Hold;
  - matching global pointer-up ends Hold;
  - window blur ends pointer Hold;
  - window blur ends keyboard Hold.

These tests protect existing behavior while the route state is simplified.

### 4.2 Add failing persistent Toggle tests

- [ ] Add:

```ts
it('keeps Reference visible until the persistent toggle is turned off', async () => {
	await renderPuzzlePage();

	const toggle = page.getByLabelText('Toggle reference');
	await toggle.click();
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

	await toggle.click();
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
});
```

- [ ] Add an assertion that Peek is disabled while Toggle is on.

### 4.3 Add lifecycle cleanup tests

- [ ] Add a navigation case:
  1. Toggle Reference on.
  2. Change `mockPageStore` to a second puzzle.
  3. Wait for the new mission.
  4. Assert no reference overlay and Toggle is not pressed.

- [ ] Add an explicit-pause case:
  1. Toggle Reference on.
  2. Open `MORE` if needed and click `Pause mission`.
  3. Assert the reference overlay disappeared before/while the pause dialog is open.
  4. Resume.
  5. Assert Toggle is not pressed.

Completion cleanup itself is owned by Task 1's session test; do not duplicate engine internals in the route test.

### 4.4 Add a failing image-error integration test

- [ ] Start Peek so the overlay image exists, dispatch `error` on `Puzzle reference`, then assert:
  - the overlay closes;
  - Peek and Toggle Reference become disabled.

This proves `ReferenceOverlay -> PuzzleBoardPanel -> route -> PuzzleSession` cleanup works end-to-end within Browser Mode.

### 4.5 Run the route test and confirm new cases fail

- [ ] Run:

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

### 4.6 Remove duplicated overlay state

- [ ] Delete:

```ts
let showReferenceOverlay = $state(false);
```

- [ ] After `sessionState`, derive:

```ts
const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
const referenceActive = $derived(activeReferenceMode !== null);
const referenceToggled = $derived(activeReferenceMode === 'toggle');
```

Overlay visibility must now follow the session snapshot only.

### 4.7 Add one local reference cleanup helper

- [ ] Centralize only the existing DOM hold bookkeeping plus the existing session action:

```ts
function clearReferenceInteraction(): void {
	referencePointerId = null;
	referenceHoldSource = null;

	if (sessionState?.lifecycle === 'active' && sessionState.activeReferenceMode !== null) {
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}
}
```

This is not a lifecycle framework. It replaces repeated reference-specific cleanup already present in the route.

### 4.8 Make Hold mode-safe

- [ ] `handleReferenceDown` should no-op when Toggle is already active, then keep the existing pointer/keyboard bookkeeping and dispatch `mode: 'hold'`.
- [ ] `handleReferenceUp` must only clear the session mode when it is still `hold`.
- [ ] When the source is pointer-based, ignore non-pointer or mismatched-pointer-id releases.
- [ ] Reuse `handleReferenceUp(event)` from the global pointer-up handler instead of maintaining a second copy of Hold cleanup.

Representative shape:

```ts
function handleReferenceUp(event?: PointerEvent | KeyboardEvent) {
	if (referenceHoldSource === 'pointer') {
		if (!(event instanceof PointerEvent) || event.pointerId !== referencePointerId) return;
	}

	const shouldClearHold = sessionState?.activeReferenceMode === 'hold';
	referencePointerId = null;
	referenceHoldSource = null;

	if (shouldClearHold) {
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}
}
```

### 4.9 Add the persistent Toggle handler

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

The activation checkpoint preserves `referenceActivations` / `hasUserActivity`. Turning the runtime-only Toggle off does not require an extra persisted write.

### 4.10 Reuse existing transient cleanup

- [ ] In `handleWindowBlur()` replace direct reference mutations with `clearReferenceInteraction()` and keep the existing selection cancellation.
- [ ] In `clearTransientGameplayState()` call `clearReferenceInteraction()` before selection/hint/rejection cleanup.
- [ ] During puzzle teardown/navigation, clear `referencePointerId` and `referenceHoldSource`; `sessionState = null` makes `referenceActive` false automatically.

Do not add an `$effect` that watches lifecycle.

### 4.11 Handle broken-image cleanup

- [ ] Add:

```ts
function handleReferenceUnavailable(): void {
	clearReferenceInteraction();
}
```

This callback is invoked while the session is still active, so the existing `set_reference_mode: null` action closes the canonical mode.

### 4.12 Update `PuzzleBoardPanel` wiring

- [ ] Replace:

```svelte
referenceActive={showReferenceOverlay}
```

with:

```svelte
{referenceActive}
{referenceToggled}
onReferenceToggle={handleReferenceToggle}
onReferenceUnavailable={handleReferenceUnavailable}
```

Keep `referenceImageUrl={source.resolveReferenceImage() ?? null}` unless implementation discovers the resolver has side effects. Do not add caching state merely for style.

### 4.13 Re-run the route test

- [ ] Run the focused route command until all reference, pause, navigation, and existing gameplay tests in that file pass.

### 4.14 Commit

- [ ] Commit:

```bash
git add 'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): wire persistent puzzle reference mode"
```

---

## Task 5: Focused regression and static verification

No new production scope should be added in this task. Fix only regressions caused by Tasks 1–4.

### 5.1 Run all directly affected tests together

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

### 5.2 Run the complete web unit suite

- [ ] Run:

```bash
cd apps/web
bun run test:unit
```

This catches existing callers that still query the old `Reference` accessible name or instantiate the changed component props.

### 5.3 Run Svelte/TypeScript checks

- [ ] Run:

```bash
cd apps/web
bun run check
```

### 5.4 Run formatting/lint checks

- [ ] Run:

```bash
cd apps/web
bun run lint
```

### 5.5 Scope check

- [ ] Confirm the implementation did **not** change:
  - persisted schema/version;
  - API/shared completion types;
  - preferences;
  - analytics;
  - dependencies;
  - Playwright projects/fixtures;
  - HPA-223 keyboard navigation.

- [ ] Confirm the final diff contains only the five production files and five existing test files listed in the design, unless a pre-existing test caller needed a query rename.

### 5.6 Final implementation commit only if verification required a fix

- [ ] If verification produced a small HPA-222 regression fix, commit it separately with a specific message. Otherwise do not create an empty cleanup commit.

---

## Expected implementation shape

The completed feature should have one simple state flow:

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

ReferenceOverlay image error
        |
        v
PuzzleBoardPanel marks image unavailable
        |
        v
route clears set_reference_mode
```

There should be no parallel `showReferenceOverlay` or `referenceToggled` route state after implementation.

## Done criteria

- Peek still works with pointer and keyboard press/release.
- Reference Toggle remains visible until explicitly turned off.
- Toggle uses `aria-pressed` and native keyboard activation.
- Peek is disabled while Toggle is active.
- Hint remains assisted; Peek/Toggle remain standard for timed runs.
- Navigation, explicit pause/restart flow, completion, blur, and image failure cannot leave the reference active.
- Missing/broken reference images cannot keep active controls usable.
- No active reference mode is persisted or restored.
- No new architecture/framework/package was added.
- Focused tests, full web unit tests, `check`, and `lint` pass.
