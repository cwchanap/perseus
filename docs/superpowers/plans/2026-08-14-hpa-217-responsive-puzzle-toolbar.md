# HPA-217 Responsive Puzzle Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing puzzle toolbar compact at 390 × 844 while preserving every current action and existing mobile Pause E2E caller.

**Architecture:** `PuzzleToolbar.svelte` remains the only production presentation owner. Keep its existing props/callbacks, add one private `moreOpen` boolean, keep Undo/Redo/Hint/Reference in the primary row, and put Zoom/Fit/Rotation/Pause/Setup in one secondary container that is inline at ≥1024px and opened by `MORE` below 1024px. Existing E2E Pause callers continue through the same `GameplayPage.pauseMission()` helper, which opens `MORE` only when Pause is hidden.

**Tech Stack:** Svelte 5 runes, TypeScript 5.9, scoped CSS/Tailwind 4 build pipeline, Vitest Browser Mode, Playwright 1.57, Bun 1.3.

## Global Constraints

- Keep the current `PuzzleToolbar` prop/callback signatures unchanged.
- Add exactly one production runtime state value: `let moreOpen = $state(false)` inside `PuzzleToolbar.svelte`.
- Keep Undo, Redo, Hint, and Reference directly reachable below 1024px.
- Put Zoom out, Zoom in, Fit/reset, Rotation, Pause, and Setup in one secondary container; inline on desktop, behind `MORE` below 1024px.
- Preserve Reference pointer/keyboard hold semantics exactly.
- Preserve Rotation `aria-pressed`, disabled state, and `rotation-lock-reason` description.
- Use explicit `'true' | 'false'` strings for `MORE` `aria-expanded` and secondary `data-open`.
- Reuse the existing `max-width: 1023px` / `min-width: 1024px` breakpoint; add no JavaScript media-query state.
- Reuse existing gameplay tokens (`--bg-1`, `--bg-2`, `--border`, `--text-2`, `--accent`, `--accent-glow`, `--font-display`); add no token or shared button abstraction.
- Coarse-pointer toolbar buttons remain at least 44 × 44px.
- The compact secondary panel stays absolute/in-overlay so opening it does not steal board height.
- Keep `z-index: 20` on the secondary panel only. Do not add root toolbar z-index unless rendered hit testing proves a real stacking failure; `.board-wrap { overflow: auto }` is not a stacking context by itself.
- Add no outside-click listener, Escape listener, focus trap, generic menu/popover, action registry, command model, icon dependency, route/store/session state, or shared type.
- Leave `role="toolbar"` / roving tabindex to HPA-223.
- Reuse the existing `pauseMission()` helper; do not add a separate compact/mobile Pause helper.
- Reuse `e2e-square-4`, `IMMEDIATE_START`, `chromium-mobile`, and the existing WebKit-critical session-control case. Add no fixture or Playwright project.
- Do not change `PuzzleBoardPanel.svelte`, route orchestration, `PuzzleSession`, persistence, inventory behavior, board zoom/pan logic, API packages, or package dependencies.

## File Structure

### Production

- Modify `apps/web/src/lib/components/PuzzleToolbar.svelte` — local `moreOpen`, responsive grouping, compact secondary panel, existing-token styling.

### Component test

- Modify `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts` — Setup gating, explicit More state, secondary callback wiring; retain existing callback/Reference/Rotation tests.

### Existing E2E callers

- Modify `apps/web/e2e/support/gameplay-page.ts` — make existing `pauseMission()` open `MORE` when Pause is hidden.
- Modify `apps/web/e2e/gameplay-session-controls.spec.ts` — make the WebKit reachability case use `pauseMission()` instead of directly assuming Pause is visible.

### Rendered acceptance proof

- Modify `apps/web/e2e/gameplay-mobile-tap.spec.ts` — 390 × 844 compact visibility/overflow proof and real click on an opened secondary control.

---

### Task 1: Refactor the concrete toolbar without changing its external contract

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Interfaces:**

- Consumes the existing `Props` interface unchanged.
- Produces local state only: `moreOpen: boolean`.
- Produces stable compact hooks: `aria-label="More puzzle actions"`, `id="puzzle-toolbar-secondary"`, and `data-testid="puzzle-toolbar-secondary"`.
- Produces no exported type, callback, store, service, or route state.

- [ ] **Step 1: Add failing Setup and More-state component tests**

Keep all existing tests. Add:

```ts
it('shows Setup when canOpenSetup is true', async () => {
	renderToolbar({ canOpenSetup: true });
	await expect.element(page.getByLabelText('Open mission setup')).toBeInTheDocument();
});

it('hides Setup when canOpenSetup is false', async () => {
	renderToolbar({ canOpenSetup: false });
	await expect.poll(() => page.getByLabelText('Open mission setup').query()).toBeNull();
});

it('toggles the secondary controls through More with explicit DOM state', async () => {
	renderToolbar({ canPause: true, canOpenSetup: true });

	const more = page.getByLabelText('More puzzle actions');
	const secondary = page.getByTestId('puzzle-toolbar-secondary');

	await expect.element(more).toHaveAttribute('aria-expanded', 'false');
	await expect.element(secondary).toHaveAttribute('data-open', 'false');

	more.element().click();

	await expect.element(more).toHaveAttribute('aria-expanded', 'true');
	await expect.element(secondary).toHaveAttribute('data-open', 'true');

	more.element().click();

	await expect.element(more).toHaveAttribute('aria-expanded', 'false');
	await expect.element(secondary).toHaveAttribute('data-open', 'false');
});

it('keeps a secondary callback wired through the compact container', async () => {
	const onZoomIn = vi.fn();
	renderToolbar({ onZoomIn });

	page.getByLabelText('More puzzle actions').element().click();
	const secondary = page.getByTestId('puzzle-toolbar-secondary').element();
	const zoomIn = secondary.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');

	expect(zoomIn).not.toBeNull();
	zoomIn!.click();
	expect(onZoomIn).toHaveBeenCalledOnce();
});
```

The direct `.element().click()` is intentional because Vitest's normal browser viewport is desktop-sized and CSS hides `MORE`; component tests own markup/state, not responsive layout.

- [ ] **Step 2: Run the focused component test and verify the new tests fail**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

Expected: FAIL because the current component has no `MORE` or secondary state hook.

- [ ] **Step 3: Add the one local presentation state**

In `PuzzleToolbar.svelte`, after current prop destructuring:

```ts
let moreOpen = $state(false);
```

Delete `toolbarButtonClass` and `pressedRotationButtonClass`; styling moves into the scoped style block. Do not alter the `Props` interface or destructured prop names/defaults.

- [ ] **Step 4: Regroup the existing buttons into concrete primary and secondary containers**

Use one copy of each action:

```svelte
<div data-testid="puzzle-toolbar" class="puzzle-toolbar">
	<div class="toolbar-group" role="group" aria-label="History controls">
		<button type="button" aria-label="Undo" disabled={!canUndo} onclick={onUndo} class="toolbar-button">
			UNDO
		</button>
		<button type="button" aria-label="Redo" disabled={!canRedo} onclick={onRedo} class="toolbar-button">
			REDO
		</button>
	</div>

	<div class="toolbar-group" role="group" aria-label="Assistance controls">
		<button type="button" aria-label="Hint" onclick={onHint} class="toolbar-button">HINT</button>

		{#if hasReference}
			<button
				type="button"
				aria-label="Reference"
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
				class="toolbar-button"
			>
				REF
			</button>
		{/if}
	</div>

	<button
		type="button"
		class="toolbar-button more-toggle"
		aria-label="More puzzle actions"
		aria-expanded={moreOpen ? 'true' : 'false'}
		aria-controls="puzzle-toolbar-secondary"
		onclick={() => (moreOpen = !moreOpen)}
	>
		MORE
	</button>

	<div
		id="puzzle-toolbar-secondary"
		data-testid="puzzle-toolbar-secondary"
		data-open={moreOpen ? 'true' : 'false'}
		class="toolbar-secondary"
	>
		<div class="toolbar-group" role="group" aria-label="View controls">
			<button type="button" aria-label="Zoom out" onclick={onZoomOut} class="toolbar-button">−</button>
			<button type="button" aria-label="Zoom in" onclick={onZoomIn} class="toolbar-button">+</button>
			<button type="button" aria-label="Reset view" onclick={onResetView} class="toolbar-button">FIT</button>
			<button
				type="button"
				aria-label="Rotation mode"
				aria-pressed={rotationEnabled ? 'true' : 'false'}
				aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
				disabled={rotationToggleDisabled}
				onclick={onRotationToggle}
				class="toolbar-button"
			>
				ROTATE
			</button>
		</div>

		{#if canPause || canOpenSetup}
			<div class="toolbar-group" role="group" aria-label="Session controls">
				{#if canPause}
					<button type="button" aria-label="Pause mission" onclick={onPause} class="toolbar-button">
						PAUSE
					</button>
				{/if}
				{#if canOpenSetup}
					<button
						type="button"
						aria-label="Open mission setup"
						onclick={onOpenSetup}
						class="toolbar-button"
					>
						SETUP
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if rotationToggleDisabled}
		<span id="rotation-lock-reason" class="sr-only">
			Rotation is locked after the first placement
		</span>
	{/if}
</div>
```

Do not add `role="toolbar"`; keep only ordinary groups/buttons in this ticket.

- [ ] **Step 5: Add local existing-token responsive styling**

Use the neighboring panel-action visual language without extracting a shared component:

```css
.puzzle-toolbar {
	position: relative;
	display: flex;
	width: 100%;
	min-width: 0;
	box-sizing: border-box;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem 0.75rem;
	padding: 0.75rem;
	background: var(--bg-2);
	border: 1px solid var(--border);
}

.toolbar-group,
.toolbar-secondary {
	display: flex;
	min-width: 0;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}

.toolbar-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-family: var(--font-display);
	font-size: 0.65rem;
	font-weight: 600;
	letter-spacing: 0.08em;
	line-height: 1;
	color: var(--text-2);
	background: var(--bg-1);
	border: 1px solid var(--border);
	padding: 0.45rem 0.65rem;
	white-space: nowrap;
	cursor: pointer;
}

.toolbar-button:hover:not(:disabled),
.toolbar-button:focus-visible {
	color: var(--accent);
	border-color: var(--accent);
}

.toolbar-button:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}

.toolbar-button:disabled {
	cursor: not-allowed;
	opacity: 0.45;
}

.toolbar-button[aria-pressed='true'] {
	color: var(--accent);
	border-color: var(--accent);
	background: var(--accent-glow);
	box-shadow: 0 0 10px var(--accent-glow);
}

.more-toggle {
	display: none;
}

@media (max-width: 1023px) {
	.puzzle-toolbar {
		gap: 0.5rem;
		padding: 0.5rem;
	}

	.more-toggle {
		display: inline-flex;
	}

	.toolbar-secondary {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0;
		z-index: 20;
		display: none;
		width: min(18rem, calc(100vw - 2rem));
		box-sizing: border-box;
		flex-direction: column;
		align-items: stretch;
		gap: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-1);
		border: 1px solid var(--border);
		box-shadow: 0 8px 24px rgb(0 0 0 / 20%);
	}

	.toolbar-secondary[data-open='true'] {
		display: flex;
	}

	.toolbar-secondary .toolbar-group {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.toolbar-secondary .toolbar-button {
		width: 100%;
	}
}

@media (pointer: coarse) {
	.toolbar-button {
		min-width: 44px;
		min-height: 44px;
	}
}
```

Do **not** add `z-index` to `.puzzle-toolbar`. The current `.board-wrap` has no positioned competing z-index; Task 3's real `Zoom in` click is the regression fence for hit testing.

- [ ] **Step 6: Run focused component verification**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit the component slice**

```bash
git add \
  src/lib/components/PuzzleToolbar.svelte \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
git commit -m "feat(web): make puzzle toolbar responsive"
```

---

### Task 2: Preserve existing compact Pause callers

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`

**Interfaces:**

- Keeps the existing `pauseMission(): Promise<Locator>` signature.
- Desktop path remains one Pause click.
- Compact path opens existing `More puzzle actions` only when Pause is hidden.
- Produces no new helper or page-object state.

- [ ] **Step 1: Run the existing Chromium-mobile session-control suite against Task 1 and confirm the compact regression**

From `apps/web`:

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
```

Expected: FAIL when existing `pauseMission()` tries to click the CSS-hidden compact Pause control.

- [ ] **Step 2: Extend the existing `pauseMission()` helper**

Replace the current direct click with:

```ts
async pauseMission(): Promise<Locator> {
	const pause = this.page.getByRole('button', { name: 'Pause mission' });
	if (!(await pause.isVisible())) {
		const more = this.page.getByRole('button', { name: 'More puzzle actions' });
		await expect(more).toBeVisible();
		await more.click();
	}

	await pause.click();
	const dialog = this.page.getByRole('dialog', { name: 'Mission Paused' });
	await expect(dialog).toBeVisible();
	return dialog;
}
```

Do not add a viewport check. Visibility is the presentation contract: desktop Pause is visible; compact Pause is hidden until `MORE` opens.

- [ ] **Step 3: Route the WebKit-critical reachability case through the same helper**

In `gameplay-session-controls.spec.ts`, replace:

```ts
const pause = page.getByRole('button', { name: 'Pause mission' });
await expect(pause).toBeVisible();
await pause.click();
const paused = page.getByRole('dialog', { name: 'Mission Paused' });
await expect(paused).toBeVisible();
```

with:

```ts
const paused = await gameplayPage.pauseMission();
```

Keep its existing Resume assertions afterward. This still proves Pause reachability on WebKit, now through the actual compact path.

- [ ] **Step 4: Run the existing Chromium-mobile session-control suite**

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
```

Expected: PASS.

- [ ] **Step 5: Run the focused WebKit reachability case**

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts \
  --project=webkit-mobile \
  --grep "webkit-mobile: setup dialog and Pause action reachable"
```

Expected: PASS. This is existing targeted WebKit-critical coverage, not a new browser matrix.

- [ ] **Step 6: Commit the E2E caller compatibility slice**

```bash
git add \
  e2e/support/gameplay-page.ts \
  e2e/gameplay-session-controls.spec.ts
git commit -m "test(web): follow compact toolbar for pause"
```

---

### Task 3: Prove compact toolbar geometry and real secondary hit testing

**Files:**

- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**Interfaces:**

- Consumes existing `IMMEDIATE_START`, `gameplayPage.gotoFixture()`, `chromium-mobile`, and default `e2e-square-4` fixture.
- Produces no helper, fixture, project, or production API.
- Proves actual CSS visibility/geometry and that an opened secondary control is not covered by the board.

- [ ] **Step 1: Add the 390 × 844 toolbar acceptance test**

Add near the top of `gameplay-mobile-tap.spec.ts`:

```ts
test('mobile toolbar keeps primary actions visible and secondary actions in More @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(!isChromiumMobile(), 'mobile toolbar layout proof uses chromium-mobile');
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });

	const viewport = page.viewportSize();
	expect(viewport).toEqual({ width: 390, height: 844 });

	const toolbar = page.getByTestId('puzzle-toolbar');
	const toolbarBox = await toolbar.boundingBox();
	expect(toolbarBox).not.toBeNull();
	expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
	expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewport!.width);

	await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Redo' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Hint' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reference' })).toBeVisible();

	const more = page.getByRole('button', { name: 'More puzzle actions' });
	await expect(more).toBeVisible();
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Pause mission' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Open mission setup' })).toBeHidden();

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');

	const zoomIn = page.getByRole('button', { name: 'Zoom in' });
	await expect(zoomIn).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reset view' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotation mode' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Pause mission' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open mission setup' })).toBeVisible();

	// This is intentionally a real Playwright click, not just toBeVisible().
	// If the absolute panel paints underneath the board, actionability fails.
	await zoomIn.click();

	const secondaryBox = await page.getByTestId('puzzle-toolbar-secondary').boundingBox();
	expect(secondaryBox).not.toBeNull();
	expect(secondaryBox!.x).toBeGreaterThanOrEqual(0);
	expect(secondaryBox!.x + secondaryBox!.width).toBeLessThanOrEqual(viewport!.width);

	const overflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(zoomIn).toBeHidden();
});
```

`IMMEDIATE_START` keeps the fixture active with no user activity, so `canPause` and `canOpenSetup` are both true before gameplay changes the session.

- [ ] **Step 2: Run the new acceptance case after Tasks 1–2**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile \
  --grep "mobile toolbar keeps primary actions visible"
```

Expected: PASS. The test also proves the opened panel's real hit target through the `Zoom in` click.

- [ ] **Step 3: Run the complete focused HPA-217 verification set**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-session-controls.spec.ts \
  --project=webkit-mobile \
  --grep "webkit-mobile: setup dialog and Pause action reachable"
bun run check
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Commit the rendered acceptance proof**

```bash
git add e2e/gameplay-mobile-tap.spec.ts
git commit -m "test(web): cover responsive puzzle toolbar"
```

## Implementation completion criteria

HPA-217 is complete when:

- `PuzzleToolbar`'s external prop surface is unchanged;
- its only new production state is local `moreOpen`;
- Undo/Redo/Hint/Reference stay directly visible at 390 × 844;
- Zoom/Fit/Rotation/Pause/Setup are inline on desktop and behind `MORE` below 1024px;
- `aria-expanded` and `data-open` use explicit `'true' | 'false'` strings;
- existing desktop/mobile `pauseMission()` callers remain valid without a new helper;
- the existing WebKit-critical Pause reachability case follows the compact path;
- Reference hold behavior and Rotation pressed/disabled semantics remain covered;
- the toolbar and opened panel fit the 390px viewport with no document horizontal overflow;
- Playwright successfully clicks `Zoom in` through the opened panel, proving it is not covered;
- no `PuzzleBoardPanel`, route/store/domain/shared API/dependency changes are present;
- the focused Vitest, Chromium-mobile toolbar/session-control E2E, targeted WebKit case, `check`, and `lint` commands pass.
