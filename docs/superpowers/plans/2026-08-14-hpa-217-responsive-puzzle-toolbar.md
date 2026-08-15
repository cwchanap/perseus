# HPA-217 Responsive Puzzle Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing puzzle toolbar compact and consistent on 390 × 844 phone layouts while preserving every current action through the existing `PuzzleToolbar` props/callbacks.

**Architecture:** Keep `PuzzleToolbar.svelte` as the only presentation owner. Preserve its external prop surface, add one private `moreOpen` boolean, keep Undo/Redo/Hint/Reference in the primary row, and move Zoom/Fit/Rotation/Pause/Setup into one secondary container that is inline at ≥1024px and opened by `MORE` below 1024px. Reuse the existing gameplay CSS variables and prove rendered compact behavior with the existing Chromium-mobile E2E fixture.

**Tech Stack:** Svelte 5 runes, TypeScript 5.9, scoped CSS/Tailwind 4 build pipeline, Vitest Browser Mode, Playwright 1.57, Bun 1.3.

## Global Constraints

- Keep the current `PuzzleToolbar` props/callback signatures unchanged.
- Add exactly one runtime state value: `let moreOpen = $state(false)` inside `PuzzleToolbar.svelte`.
- Keep Undo, Redo, Hint, and Reference directly reachable below 1024px.
- Put Zoom out, Zoom in, Fit/reset, Rotation, Pause, and Setup in one secondary container; it stays inline on desktop and sits behind `MORE` below 1024px.
- Preserve Reference pointer/keyboard hold semantics exactly; HPA-217 must not turn Reference into a toggle.
- Preserve Rotation `aria-pressed`, disabled state, and the `rotation-lock-reason` description.
- `MORE` is a normal button with `aria-label="More puzzle actions"`, `aria-expanded`, and `aria-controls="puzzle-toolbar-secondary"`.
- Do not add outside-click listeners, Escape listeners, focus traps, a generic menu/popover component, action registry, command model, icon dependency, route state, store state, or shared types.
- Reuse `--bg-1`, `--bg-2`, `--border`, `--text-2`, `--accent`, `--accent-glow`, and `--font-display`; add no design tokens.
- Reuse the existing `max-width: 1023px` gameplay breakpoint; do not add JavaScript media-query state.
- Coarse-pointer toolbar buttons must have at least 44 × 44px targets.
- Reuse `e2e-square-4`, `IMMEDIATE_START`, and `chromium-mobile` at 390 × 844; add no fixture, Playwright project, or page-object helper.
- Do not change `PuzzleBoardPanel.svelte`, route orchestration, `PuzzleSession`, persistence, inventory behavior, board zoom/pan logic, API packages, or package dependencies.

## File Structure

- Modify `apps/web/src/lib/components/PuzzleToolbar.svelte` — responsive grouping, local `moreOpen`, compact secondary panel, existing-variable styling.
- Modify `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts` — Setup gating and compact overflow state/wiring while retaining the existing callback/Reference/Rotation coverage.
- Modify `apps/web/e2e/gameplay-mobile-tap.spec.ts` — one 390 × 844 rendered toolbar visibility/overflow proof.

---

### Task 1: Refactor the concrete toolbar without changing its external contract

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

**Interfaces:**

- Consumes the existing `Props` interface unchanged.
- Produces local state only: `moreOpen: boolean`.
- Produces stable compact controls: `aria-label="More puzzle actions"` and `id="puzzle-toolbar-secondary"`.
- Produces no new exported type, callback, store, service, or route state.

- [ ] **Step 1: Add failing component tests for Setup gating and compact overflow state**

In `PuzzleToolbar.svelte.test.ts`, keep the existing tests and add:

```ts
it('shows Setup when canOpenSetup is true', async () => {
	renderToolbar({ canOpenSetup: true });

	await expect.element(page.getByLabelText('Open mission setup')).toBeInTheDocument();
});

it('hides Setup when canOpenSetup is false', async () => {
	renderToolbar({ canOpenSetup: false });

	await expect.poll(() => page.getByLabelText('Open mission setup').query()).toBeNull();
});

it('toggles the compact secondary controls through More', async () => {
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

it('keeps secondary callbacks wired through the compact container', async () => {
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

The direct `.element().click()` is intentional: Vitest's normal desktop viewport hides the compact `MORE` button with CSS, while this test owns the component state/markup contract. Playwright owns real compact visibility in Task 2.

- [ ] **Step 2: Run the focused component test and verify the new tests fail**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

Expected: the new tests fail because `MORE`, `puzzle-toolbar-secondary`, and Setup gating coverage do not yet exist in the current shape.

- [ ] **Step 3: Add the one local presentation state and remove utility-class constants**

In `PuzzleToolbar.svelte`, after the existing prop destructuring add:

```ts
let moreOpen = $state(false);
```

Delete the current `toolbarButtonClass` and `pressedRotationButtonClass` string constants. Styling moves to the component's scoped `<style>` block so it can use the same CSS variables as the neighboring gameplay panels.

Do not alter the `Props` interface or destructured prop names/defaults.

- [ ] **Step 4: Regroup the existing controls into one primary row and one secondary container**

Use this concrete structure. Keep the Reference event handlers exactly as shown so hold-to-peek semantics do not change:

```svelte
<div data-testid="puzzle-toolbar" class="puzzle-toolbar">
	<div class="toolbar-group" role="group" aria-label="History controls">
		<button
			type="button"
			aria-label="Undo"
			disabled={!canUndo}
			onclick={onUndo}
			class="toolbar-button"
		>
			UNDO
		</button>
		<button
			type="button"
			aria-label="Redo"
			disabled={!canRedo}
			onclick={onRedo}
			class="toolbar-button"
		>
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
		aria-expanded={moreOpen}
		aria-controls="puzzle-toolbar-secondary"
		onclick={() => (moreOpen = !moreOpen)}
	>
		MORE
	</button>

	<div
		id="puzzle-toolbar-secondary"
		data-testid="puzzle-toolbar-secondary"
		data-open={moreOpen}
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

Keep `onPause` / `onOpenSetup` optional exactly as today; the existing boolean gates guarantee the corresponding button is rendered only when the callback is meaningful.

- [ ] **Step 5: Add local variable-based desktop/compact styling**

Add this scoped style and adjust only if formatter ordering requires it:

```css
.puzzle-toolbar {
	position: relative;
	display: flex;
	min-width: 0;
	width: 100%;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem 0.75rem;
	box-sizing: border-box;
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

.toolbar-secondary {
	gap: 0.75rem;
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
	transition:
		color 0.15s ease,
		border-color 0.15s ease,
		background 0.15s ease,
		box-shadow 0.15s ease;
}

.toolbar-button:hover:not(:disabled) {
	color: var(--accent);
	border-color: var(--accent);
}

.toolbar-button:focus-visible {
	color: var(--accent);
	border-color: var(--accent);
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

Do not move this CSS into `layout.css` or create a shared button component. The style is specific to this toolbar.

- [ ] **Step 6: Run the focused component suite and package type check**

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

### Task 2: Prove the compact toolbar at the existing 390 × 844 mobile viewport

**Files:**

- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**Interfaces:**

- Consumes existing `IMMEDIATE_START`, `gameplayPage.gotoFixture()`, `chromium-mobile`, and the default `e2e-square-4` fixture.
- Produces no helper, fixture, project, or production API.
- Proves actual CSS visibility/geometry that Task 1's component tests intentionally do not emulate.

- [ ] **Step 1: Add the mobile toolbar E2E acceptance test**

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

	await expect(page.getByRole('button', { name: 'Zoom out' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Reset view' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Rotation mode' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Pause mission' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Open mission setup' })).toBeHidden();

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reset view' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotation mode' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Pause mission' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open mission setup' })).toBeVisible();

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
	await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden();
});
```

`IMMEDIATE_START` keeps the fixture active with no user activity, so both `canPause` and `canOpenSetup` are true before the test performs any gameplay action.

- [ ] **Step 2: Run the new mobile acceptance case after Task 1**

From `apps/web`:

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-mobile \
  --grep "mobile toolbar keeps primary actions visible"
```

Expected: PASS with the Task 1 component implementation. The same test would fail against current `main` because `main` has no `MORE` control, which makes it a useful regression fence without requiring a deliberately red intermediate commit.

- [ ] **Step 3: Run the focused HPA-217 verification set**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
bun run check
bun run lint
```

Expected: PASS. Do not add WebKit/tablet runs solely for HPA-217; the ticket asks for one representative phone layout and the broader suites remain available on demand.

- [ ] **Step 4: Commit the rendered mobile proof**

```bash
git add e2e/gameplay-mobile-tap.spec.ts
git commit -m "test(web): cover responsive puzzle toolbar"
```

## Implementation completion criteria

HPA-217 is complete when:

- the `PuzzleToolbar` external prop surface is unchanged;
- Undo/Redo/Hint/Reference remain directly visible at 390 × 844;
- `MORE` controls one compact secondary panel below 1024px;
- Zoom/Fit/Rotation/Pause/Setup are inline at desktop widths and hidden behind `MORE` at compact widths;
- Reference hold behavior and Rotation pressed/disabled semantics still pass component tests;
- the toolbar and opened secondary panel remain inside the 390px viewport with no document horizontal overflow;
- no route/store/domain/shared API/dependency changes are present;
- the focused Vitest, Chromium-mobile E2E, `check`, and `lint` commands pass.
