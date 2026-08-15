# HPA-217 Responsive Puzzle Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing puzzle toolbar compact at 390 × 844 without regressing desktop reachability, interactive contrast, current unit consumers, or existing mobile Pause flows.

**Architecture:** `PuzzleToolbar.svelte` remains the only production presentation owner. Keep its existing props/callbacks, add one private `moreOpen` boolean, keep Undo/Redo/Hint/Reference in the primary row, and put Zoom/Fit/Rotation/Pause/Setup in one secondary container that is inline at ≥1024px and opened by `MORE` below 1024px. Reuse the existing global `.arcade-btn-ghost` base instead of creating another button style. Existing Pause E2E callers continue through the same `GameplayPage.pauseMission()` helper, which opens `MORE` only after the Pause control is attached but CSS-hidden.

**Tech Stack:** Svelte 5 runes, TypeScript 5.9, global/scoped CSS with Tailwind 4 build pipeline, Vitest Browser Mode, Playwright 1.57, Bun 1.3.

## Global Constraints

- Keep the current `PuzzleToolbar` prop/callback signatures unchanged.
- Add exactly one production runtime state value: `let moreOpen = $state(false)` inside `PuzzleToolbar.svelte`.
- Keep Undo, Redo, Hint, and Reference directly reachable below 1024px.
- Put Zoom out, Zoom in, Fit/reset, Rotation, Pause, and Setup in one secondary container: inline on desktop, behind `MORE` below 1024px.
- Accept one extra tap to begin toolbar zoom on mobile; `MORE` stays open for repeated Zoom/Fit actions. Do not add pinch zoom in this ticket.
- Preserve Reference pointer/keyboard hold semantics exactly.
- Preserve Rotation `aria-pressed`, disabled state, and `rotation-lock-reason` description.
- Use explicit `'true' | 'false'` strings for `MORE` `aria-expanded` and secondary `data-open`.
- Reuse the existing `max-width: 1023px` / `min-width: 1024px` breakpoint; add no JavaScript media-query state.
- Reuse global `.arcade-btn-ghost` for the base button appearance. Its resting `--text-1` color is the interactive-control baseline; do not style toolbar buttons with `--text-2`.
- Add no new design token or shared button component.
- Coarse-pointer toolbar buttons must render at least 44 × 44px.
- The compact secondary panel stays absolute/overlay so opening it does not steal board height.
- Keep `z-index: 20` on the secondary panel only. Do not add root toolbar z-index unless rendered hit testing demonstrates an actual stacking failure.
- Add no outside-click listener, Escape listener, focus trap, generic menu/popover, action registry, command model, icon dependency, route/store/session state, or shared type.
- Do not add `role="toolbar"`, `role="group"`, group labels, or roving tabindex; HPA-223 owns broader toolbar keyboard semantics.
- Reuse the existing `pauseMission()` helper; do not add a compact/mobile twin.
- `apps/web/e2e/gameplay-mobile-tap.spec.ts` already exists and already defines `IMMEDIATE_START`, `PROJECT()`, and `isChromiumMobile()`; modify it in place and do not redeclare those helpers.
- Reuse `e2e-square-4` and existing Chromium desktop/mobile + WebKit mobile projects; add no fixture or Playwright project.
- Do not change `PuzzleBoardPanel.svelte` production code, route production orchestration, `PuzzleSession`, persistence, inventory production behavior, board zoom/pan logic, API packages, or package dependencies.

## File Structure

### Production

- Modify `apps/web/src/lib/components/PuzzleToolbar.svelte` — local `moreOpen`, concrete responsive grouping, `.arcade-btn-ghost` reuse, compact secondary panel.

### Unit test

- Modify `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts` — Setup gating, explicit More state, secondary callback wiring; retain existing callback/Reference/Rotation tests.
- Regression-run existing `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts` and `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` via the full web unit suite; edit them only if implementation reveals a real expectation that must change.

### Existing E2E callers

- Modify `apps/web/e2e/support/gameplay-page.ts` — make existing `pauseMission()` wait for Pause attachment, then open `MORE` only when Pause is CSS-hidden.
- Modify `apps/web/e2e/gameplay-session-controls.spec.ts` — make the duplicate WebKit reachability path use `pauseMission()`.

### Existing rendered acceptance file

- Modify `apps/web/e2e/gameplay-mobile-tap.spec.ts` — add one targeted @smoke test with Chromium desktop and mobile branches; mobile branch also proves target size, nested overflow, and real secondary hit testing.

---

### Task 1: Refactor the concrete toolbar and keep all unit consumers green

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
- Regression only unless failures prove otherwise: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- Regression only unless failures prove otherwise: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

- Consumes the existing `Props` interface unchanged.
- Produces local state only: `moreOpen: boolean`.
- Produces stable compact hooks: `aria-label="More puzzle actions"`, `id="puzzle-toolbar-secondary"`, and `data-testid="puzzle-toolbar-secondary"`.
- Reuses global `.arcade-btn-ghost`; scoped `.toolbar-button` is only a modifier.
- Produces no exported type, callback, store, service, route state, ARIA toolbar/group abstraction, or shared style primitive.

- [ ] **Step 1: Add failing Setup and More-state component tests**

Keep all existing tests and add:

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

The direct DOM click is intentional only in these component-state tests: the Vitest browser viewport is desktop-oriented and CSS hides `MORE`; rendered breakpoint/actionability belongs to Task 3.

- [ ] **Step 2: Run the focused toolbar test and verify the new cases fail**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
```

Expected: FAIL because current `PuzzleToolbar` has no `MORE` / secondary disclosure state.

- [ ] **Step 3: Add the single local presentation state**

After current prop destructuring:

```ts
let moreOpen = $state(false);
```

Delete the current `toolbarButtonClass` and `pressedRotationButtonClass` string constants. Do not change `Props` or any callback/state names.

- [ ] **Step 4: Regroup the existing buttons without adding ARIA group wrappers**

Use visual groups only. Keep the existing Reference event handlers unchanged:

```svelte
<div data-testid="puzzle-toolbar" class="puzzle-toolbar">
	<div class="toolbar-group">
		<button
			type="button"
			aria-label="Undo"
			disabled={!canUndo}
			onclick={onUndo}
			class="arcade-btn-ghost toolbar-button"
		>
			UNDO
		</button>
		<button
			type="button"
			aria-label="Redo"
			disabled={!canRedo}
			onclick={onRedo}
			class="arcade-btn-ghost toolbar-button"
		>
			REDO
		</button>
	</div>

	<div class="toolbar-group">
		<button
			type="button"
			aria-label="Hint"
			onclick={onHint}
			class="arcade-btn-ghost toolbar-button"
		>
			HINT
		</button>

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
				class="arcade-btn-ghost toolbar-button"
			>
				REF
			</button>
		{/if}
	</div>

	<button
		type="button"
		class="arcade-btn-ghost toolbar-button more-toggle"
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
		<div class="toolbar-group">
			<button type="button" aria-label="Zoom out" onclick={onZoomOut} class="arcade-btn-ghost toolbar-button">−</button>
			<button type="button" aria-label="Zoom in" onclick={onZoomIn} class="arcade-btn-ghost toolbar-button">+</button>
			<button type="button" aria-label="Reset view" onclick={onResetView} class="arcade-btn-ghost toolbar-button">FIT</button>
			<button
				type="button"
				aria-label="Rotation mode"
				aria-pressed={rotationEnabled ? 'true' : 'false'}
				aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
				disabled={rotationToggleDisabled}
				onclick={onRotationToggle}
				class="arcade-btn-ghost toolbar-button"
			>
				ROTATE
			</button>
		</div>

		{#if canPause || canOpenSetup}
			<div class="toolbar-group">
				{#if canPause}
					<button
						type="button"
						aria-label="Pause mission"
						onclick={onPause}
						class="arcade-btn-ghost toolbar-button"
					>
						PAUSE
					</button>
				{/if}
				{#if canOpenSetup}
					<button
						type="button"
						aria-label="Open mission setup"
						onclick={onOpenSetup}
						class="arcade-btn-ghost toolbar-button"
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

Do not add `role="toolbar"` or `role="group"` in HPA-217.

- [ ] **Step 5: Add only toolbar-specific scoped styling**

Reuse `.arcade-btn-ghost` for font, base border/background, resting `--text-1`, hover `--text-0`, cursor, uppercase, and transition. Add only the local modifier/layout rules:

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
	padding: 0.45rem 0.65rem;
	line-height: 1;
	white-space: nowrap;
}

.toolbar-button:focus-visible {
	color: var(--text-0);
	border-color: var(--accent);
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}

.toolbar-button:disabled {
	cursor: not-allowed;
	opacity: 0.45;
}

.toolbar-button:disabled:hover {
	color: var(--text-1);
	border-color: var(--border);
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

Do **not** override resting button text with `--text-2`. Do **not** add root toolbar z-index. Task 3's real `Zoom in` click owns the hit-testing proof.

- [ ] **Step 6: Run the full web unit regression and type check**

From `apps/web`:

```bash
bun run test:unit
bun run check
```

Expected: PASS, including current `PuzzleToolbar`, `PuzzleBoardPanel`, and route page tests that action-check Zoom/Pause/Setup on the desktop browser test surface.

If any existing consumer fails because a secondary control is unexpectedly CSS-hidden in the Vitest tester, diagnose that rendered viewport before changing assertions; do not bypass actionability with raw DOM clicks outside the dedicated toolbar state tests.

- [ ] **Step 7: Commit the production/unit slice**

```bash
git add \
  src/lib/components/PuzzleToolbar.svelte \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts
git commit -m "feat(web): make puzzle toolbar responsive"
```

If Step 6 demonstrates that an existing consumer test genuinely needs an expectation update, include only that proven test file in this same commit.

---

### Task 2: Preserve current Pause callers with a retry-safe helper

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`

**Interfaces:**

- Keeps `pauseMission(): Promise<Locator>` unchanged.
- Waits for the conditional Pause element to attach before snapshotting CSS visibility.
- Desktop path remains one Pause click.
- Compact path opens the existing `More puzzle actions`, waits for Pause to become visible, then clicks it.
- Produces no new helper, viewport branch, or page-object state.

- [ ] **Step 1: Confirm Task 1 breaks the current Chromium-mobile Pause path**

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
```

Expected: FAIL because current `pauseMission()` directly clicks compact CSS-hidden Pause.

- [ ] **Step 2: Make `pauseMission()` wait before choosing the presentation branch**

Replace the direct Pause click with:

```ts
async pauseMission(): Promise<Locator> {
	const pause = this.page.getByRole('button', { name: 'Pause mission' });
	const more = this.page.getByRole('button', { name: 'More puzzle actions' });

	await expect(pause).toBeAttached();
	if (!(await pause.isVisible())) {
		await expect(more).toBeVisible();
		await more.click();
		await expect(pause).toBeVisible();
	}

	await pause.click();
	const dialog = this.page.getByRole('dialog', { name: 'Mission Paused' });
	await expect(dialog).toBeVisible();
	return dialog;
}
```

Do not use an immediate `pause.isVisible()` before attachment. Do not use `pause.or(more)` here: after HPA-217 both controls exist in the DOM, so an `or()` locator can resolve multiple elements even when one is CSS-hidden.

- [ ] **Step 3: Route the duplicate WebKit reachability path through the same helper**

Replace:

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

Keep the existing Resume assertions unchanged.

- [ ] **Step 4: Run the current Chromium-mobile session-control suite**

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
```

Expected: PASS.

- [ ] **Step 5: Run the whole existing WebKit-critical slice**

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts \
  --project=webkit-mobile \
  --grep "@webkit-critical"
```

Expected: PASS. Multiple tagged tests call `pauseMission()`, so do not narrow this to the one WebKit-specific title.

- [ ] **Step 6: Commit the E2E caller-compatibility slice**

```bash
git add \
  e2e/support/gameplay-page.ts \
  e2e/gameplay-session-controls.spec.ts
git commit -m "test(web): follow compact toolbar for pause"
```

---

### Task 3: Prove desktop/phone layout, touch targets, nested overflow, and hit testing

**Files:**

- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**Interfaces:**

- This file already imports `DEFAULT_GAMEPLAY_PREFERENCES` and defines `IMMEDIATE_START`, `PROJECT()`, and `isChromiumMobile()`; reuse them exactly.
- Consumes existing `gameplayPage.gotoFixture()` and default `e2e-square-4` fixture.
- Adds no helper, fixture, project, or production API.
- Proves CSS behavior on both `chromium-desktop` and `chromium-mobile`; its other pre-existing mobile tests remain unchanged.

- [ ] **Step 1: Add one responsive toolbar @smoke test to the existing file**

Add near the top of `gameplay-mobile-tap.spec.ts` after the existing helper declarations:

```ts
test('puzzle toolbar is direct on desktop and compact on phone @smoke', async ({
	gameplayPage,
	page
}) => {
	const project = PROJECT();
	test.skip(
		project !== 'chromium-desktop' && project !== 'chromium-mobile',
		'toolbar responsive proof uses Chromium desktop/mobile'
	);

	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });

	const more = page.getByRole('button', { name: 'More puzzle actions' });
	const zoomIn = page.getByRole('button', { name: 'Zoom in' });
	const pause = page.getByRole('button', { name: 'Pause mission' });
	const setup = page.getByRole('button', { name: 'Open mission setup' });

	if (project === 'chromium-desktop') {
		await expect(more).toBeHidden();
		await expect(zoomIn).toBeVisible();
		await expect(pause).toBeVisible();
		await expect(setup).toBeVisible();
		return;
	}

	const viewport = page.viewportSize();
	expect(viewport).toEqual({ width: 390, height: 844 });

	const toolbar = page.getByTestId('puzzle-toolbar');
	const toolbarBox = await toolbar.boundingBox();
	expect(toolbarBox).not.toBeNull();
	expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
	expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewport!.width);

	await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Redo' })).toBeVisible();
	const hint = page.getByRole('button', { name: 'Hint' });
	await expect(hint).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reference' })).toBeVisible();
	await expect(more).toBeVisible();
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	const hintBox = await hint.boundingBox();
	expect(hintBox).not.toBeNull();
	expect(hintBox!.width).toBeGreaterThanOrEqual(44);
	expect(hintBox!.height).toBeGreaterThanOrEqual(44);

	await expect(zoomIn).toBeHidden();
	await expect(pause).toBeHidden();
	await expect(setup).toBeHidden();

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(zoomIn).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reset view' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotation mode' })).toBeVisible();
	await expect(pause).toBeVisible();
	await expect(setup).toBeVisible();

	// Actionability is the stacking proof. This fails if the board covers the panel.
	await zoomIn.click();

	const secondaryBox = await page.getByTestId('puzzle-toolbar-secondary').boundingBox();
	expect(secondaryBox).not.toBeNull();
	expect(secondaryBox!.x).toBeGreaterThanOrEqual(0);
	expect(secondaryBox!.x + secondaryBox!.width).toBeLessThanOrEqual(viewport!.width);

	const documentOverflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth
	}));
	expect(documentOverflow.scrollWidth).toBeLessThanOrEqual(documentOverflow.clientWidth);

	const mainOverflow = await page.locator('.puzzle-main').evaluate((element) => ({
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth
	}));
	expect(mainOverflow.scrollWidth).toBeLessThanOrEqual(mainOverflow.clientWidth);

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(zoomIn).toBeHidden();
});
```

`IMMEDIATE_START` keeps a fresh active run with no user activity, so Pause and Setup are both available before the test performs gameplay actions.

- [ ] **Step 2: Run the new responsive test on both Chromium branches**

```bash
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-desktop \
  --project=chromium-mobile \
  --grep "puzzle toolbar is direct on desktop and compact on phone"
```

Expected: PASS on both projects. Desktop proves `MORE` is CSS-hidden and secondary actions remain direct; mobile proves the compact branch.

- [ ] **Step 3: Run the complete HPA-217 verification set**

```bash
bun run test:unit
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-mobile-tap.spec.ts \
  --project=chromium-desktop \
  --grep "puzzle toolbar is direct on desktop and compact on phone"
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-mobile
bunx playwright test e2e/gameplay-session-controls.spec.ts \
  --project=webkit-mobile \
  --grep "@webkit-critical"
bun run check
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Commit the rendered responsive proof**

```bash
git add e2e/gameplay-mobile-tap.spec.ts
git commit -m "test(web): cover responsive puzzle toolbar"
```

## Implementation Completion Criteria

HPA-217 is complete when:

- `PuzzleToolbar`'s external prop surface is unchanged;
- its only new production state is local `moreOpen`;
- buttons reuse `.arcade-btn-ghost`, so resting interactive text stays at `--text-1` rather than regressing to `--text-2`;
- visual grouping adds no premature ARIA toolbar/group structure;
- Undo/Redo/Hint/Reference stay directly visible at 390 × 844;
- Zoom/Fit/Rotation/Pause/Setup are inline on desktop and behind `MORE` below 1024px;
- mobile toolbar zoom is explicitly accepted as one extra tap, with `MORE` remaining open for repeated view actions;
- `aria-expanded` and `data-open` use explicit `'true' | 'false'` strings;
- current desktop/mobile `pauseMission()` callers remain valid without a new helper;
- `pauseMission()` waits for Pause attachment before using a visibility snapshot;
- the existing WebKit-critical Pause callers follow the same compact path;
- the full web unit suite stays green, including current board-panel and route toolbar consumers;
- Chromium desktop proves `MORE` hidden + secondary actions direct;
- Chromium mobile proves 44 × 44 primary targets, toolbar/panel width, document/main no-horizontal-overflow, and secondary disclosure;
- Playwright successfully clicks `Zoom in` through the opened panel, proving it is not covered;
- no root toolbar z-index, `PuzzleBoardPanel` production change, route/store/domain/shared API/dependency change, or new abstraction is present;
- the verification commands above pass.
