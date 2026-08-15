# HPA-217: Responsive Puzzle Toolbar — Design

**Linear:** HPA-217  
**Status:** Design for implementation  
**Date:** 2026-08-14

## Context

HPA-217 is the next actionable child of HPA-215. Current `main` already has the boundaries this ticket needs:

- `PuzzleBoardPanel.svelte` owns the board viewport and renders `PuzzleToolbar.svelte`;
- `PuzzleToolbar.svelte` receives every action/state bit through explicit props and callbacks;
- `PuzzleInventoryPanel.svelte` already owns private `drawerOpen = $state(true)` presentation state and exposes its disclosure with `aria-expanded` / `aria-controls`;
- the puzzle route pins `.puzzle-page` to `100vh` / `100dvh` below 1024px so the board can shrink within the mobile viewport;
- `apps/web/e2e/gameplay-mobile-tap.spec.ts` already exists and already defines `IMMEDIATE_START`, `PROJECT()`, and `isChromiumMobile()`;
- `layout.css` already ships `.arcade-btn-ghost`, the existing display-font ghost-button treatment used elsewhere in the app.

The remaining problem is presentation. `PuzzleToolbar.svelte` renders every action in one wrapping row. On phone layouts that spends scarce board height on view/session actions that do not need to be permanently visible.

There is also an existing integration constraint: mobile session-control E2E tests call `GameplayPage.pauseMission()`, and that helper directly clicks the visible Pause button. The WebKit-critical reachability case also directly assumes Pause is visible. Moving Pause behind `MORE` therefore requires a small compatibility edit in the existing test harness; leaving Pause in the primary row only to avoid that edit would be the wrong product cut.

## Goals

1. Keep every current `PuzzleToolbar` prop/callback unchanged.
2. Keep Undo, Redo, Hint, and Reference directly reachable below 1024px.
3. Put Zoom out, Zoom in, Fit/reset, Rotation, Pause, and Setup behind one local `MORE` control below 1024px.
4. Keep those same secondary controls inline on desktop.
5. Add only one production state value: private `moreOpen` inside `PuzzleToolbar.svelte`.
6. Reuse `.arcade-btn-ghost` and existing gameplay tokens instead of hand-rolling another base button style.
7. Keep resting interactive text at the existing `--text-1` contrast level; do not use low-contrast `--text-2` for toolbar controls.
8. Preserve Reference hold behavior, Rotation pressed/disabled semantics, native button keyboard behavior, and route keyboard shortcuts.
9. Keep current desktop/mobile Pause callers working through the existing `pauseMission()` helper.
10. Prove both desktop and 390 × 844 responsive branches with rendered Playwright assertions.
11. Prove the opened compact panel is actually hit-testable with a real secondary-control click.
12. Prove the mobile primary target size and both document/main horizontal-overflow boundaries.

## Non-goals

- a reusable toolbar, action registry, command model, slot/group API, or menu framework;
- a new popover/dropdown primitive;
- JavaScript `matchMedia` state;
- an icon dependency;
- outside-click, Escape, or focus-trap behavior;
- `role="toolbar"`, ARIA `role="group"` wrappers, or roving tabindex; HPA-223 owns broader keyboard/toolbar semantics;
- pinch zoom or gesture arbitration;
- changes to `PuzzleSession`, route/session state, persistence, APIs, inventory behavior, board zoom/pan behavior, or package dependencies;
- a shared button component or new design tokens;
- backward compatibility for pre-release UI behavior.

## Options considered

### Option A — One concrete toolbar + CSS breakpoint + one local `moreOpen` boolean (chosen)

Keep one copy of every action in `PuzzleToolbar.svelte`. Primary controls stay in normal flow. Secondary controls stay in one container that is inline on desktop and becomes an anchored panel below 1024px.

**Why:** one callback instance per action, no duplicate accessible tree, no media-query listener, no registry, and one obvious future edit site.

### Option B — Keep flex-wrap and only shrink controls

Rejected. It still spends vertical board space on every lower-frequency action and does not satisfy the ticket's compact secondary-action requirement.

### Option C — Registry / generic overflow component

Rejected. Ten concrete buttons do not justify a command abstraction or reusable menu primitive.

### Option D — Separate desktop/mobile render trees

Rejected. The route already uses CSS breakpoints; JavaScript viewport state would duplicate presentation paths and add runtime state for no product value.

## Decision

Use Option A.

`PuzzleToolbar.svelte` remains the only production file that changes. Its `Props` interface stays unchanged and it gains exactly one local state value:

```ts
let moreOpen = $state(false);
```

The existing E2E helper/specs change only because they are callers of the presentation being changed.

## Action grouping

### Primary at every width

- Undo
- Redo
- Hint
- Reference, when available

### Secondary

**View**

- Zoom out
- Zoom in
- Fit/reset view
- Rotation mode

**Session**

- Pause, when `canPause`
- Setup, when `canOpenSetup`

At `min-width: 1024px`, secondary controls are visible inline. At `max-width: 1023px`, they are hidden until `MORE` opens.

The grouping wrappers are visual `<div class="toolbar-group">` elements only. Do not add `role="group"` / group labels while `role="toolbar"` and roving navigation are intentionally deferred to HPA-223.

## Mobile zoom trade-off

The current mobile board has wheel/toolbar zoom and pointer pan, but no pinch-zoom gesture. HPA-217 deliberately makes toolbar zoom one extra tap on compact layouts:

1. open `MORE`;
2. use Zoom out / Zoom in / Fit as needed;
3. keep `MORE` open for repeated zoom operations, or close it to inspect the unobscured board.

This is accepted because keeping all zoom controls permanently visible would work against the ticket's board-height goal. `FIT` stays with the other view controls rather than becoming a fifth primary action that can force another wrapped row. Pinch zoom remains deferred under HPA-215 until actual use demonstrates the need; it is not silently assigned to HPA-222 or HPA-223.

## Disclosure state

`MORE` is a normal button:

```svelte
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
```

The secondary container uses explicit string state:

```svelte
<div
	id="puzzle-toolbar-secondary"
	data-testid="puzzle-toolbar-secondary"
	data-open={moreOpen ? 'true' : 'false'}
	class="toolbar-secondary"
>
	...
</div>
```

This follows the existing inventory drawer's local disclosure-state ownership while using explicit `'true' | 'false'` strings for deterministic DOM assertions.

No outside-click or Escape handling is added. The panel can be closed with `MORE`; leaving it open is intentionally useful for repeated zoom actions.

## Existing semantics to preserve

### Reference

Reference remains hold-to-peek:

- pointer down -> `onReferenceDown`;
- pointer up / pointer leave / blur -> `onReferenceUp`;
- Space/Enter keydown -> `onReferenceDown`;
- matching keyup -> `onReferenceUp`.

HPA-222 owns persistent Reference mode.

### Rotation

Keep:

```svelte
aria-pressed={rotationEnabled ? 'true' : 'false'}
aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
disabled={rotationToggleDisabled}
```

### Pause / Setup

Keep the existing conditional rendering and callbacks. HPA-217 changes only compact reachability.

## Styling and contrast

Reuse the existing global `.arcade-btn-ghost` base:

```svelte
class="arcade-btn-ghost toolbar-button"
```

That existing class already provides the display font, uppercase treatment, border, transparent background, cursor/transition, resting `--text-1` color, and `--text-0` hover color. HPA-217 should not duplicate those declarations in scoped CSS.

This matters for interactive contrast. Current tokens are:

- `--text-2: #505080` on `--bg-1: #0a0a18` ≈ 2.62:1;
- `--text-1: #8888bb` on `--bg-1: #0a0a18` ≈ 5.88:1.

`--text-2` remains suitable for intentionally subdued metadata, but HPA-217 does not extend that treatment to primary buttons. Resting toolbar labels inherit `--text-1`; hover/focus use the existing stronger text treatment, and pressed Rotation may use `--accent`.

Scoped `.toolbar-button` CSS contains only toolbar-specific behavior: compact padding/layout, visible focus, disabled treatment, pressed treatment, coarse-pointer 44 × 44 minimums, and `width: 100%` inside the compact secondary grid.

Do not extract another shared button.

## Responsive styling

Reuse the existing breakpoint:

```css
@media (max-width: 1023px) { ... }
@media (min-width: 1024px) { ... }
```

No JavaScript breakpoint state is added.

### Desktop

- `MORE` is `display: none`;
- primary and secondary controls stay inline/flex-wrapped inside the toolbar;
- Zoom/Fit/Rotation/Pause/Setup remain directly visible;
- local `moreOpen` does not affect secondary visibility.

### Compact secondary panel

Below 1024px:

- `MORE` is visible;
- the closed secondary container is `display: none`;
- the open secondary container is `position: absolute` below/right of the toolbar;
- width is capped with `min(18rem, calc(100vw - 2rem))`;
- controls use a small two-column grid;
- the panel overlays the board instead of expanding normal flow and stealing board height;
- the panel itself keeps local `z-index: 20`.

Do **not** add a z-index to the root toolbar. `.board-wrap { overflow: auto }` is a scroll container/block formatting context, not a stacking context by itself, and current `.board-wrap` has no positioned competing z-index. A real Playwright click on opened `Zoom in` is the regression fence for actual hit testing.

## Existing Pause test callers

Keep one `GameplayPage.pauseMission()` helper. Make its visibility decision retry-safe by first waiting for the conditional Pause button to exist:

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

Waiting for attachment prevents an early render snapshot from sending desktop through the compact branch. It also avoids `pause.or(more)` strict-locator ambiguity because both controls exist in the DOM after HPA-217, even though one is CSS-hidden on desktop.

Replace the WebKit-specific duplicate Pause lookup/click with `await gameplayPage.pauseMission()` so all existing Pause flows use the same entry point.

## File boundaries

### Production

- `apps/web/src/lib/components/PuzzleToolbar.svelte`
  - local `moreOpen`;
  - concrete primary/secondary grouping;
  - `.arcade-btn-ghost` + small scoped modifier;
  - explicit string disclosure state;
  - compact absolute secondary panel;
  - unchanged props/callbacks.

### Unit tests

- `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
  - retain callback, Reference, Rotation, and conditional-control coverage;
  - add Setup gating, More state, and secondary callback wiring.

Existing `PuzzleBoardPanel.svelte.test.ts` and route `page.svelte.test.ts` are also regression consumers because they click/assert controls that remain visible on desktop. They do not need edits unless the implementation reveals a real assertion issue, but Task 1 runs the full web unit suite before committing.

### Existing E2E callers

- `apps/web/e2e/support/gameplay-page.ts`
  - update existing `pauseMission()`; no new helper.
- `apps/web/e2e/gameplay-session-controls.spec.ts`
  - route the duplicate WebKit Pause path through `pauseMission()`.

### Existing responsive E2E file

- `apps/web/e2e/gameplay-mobile-tap.spec.ts`
  - **modify the existing file**; do not create it or redeclare its existing `IMMEDIATE_START`, `PROJECT()`, or `isChromiumMobile()` helpers;
  - add one targeted @smoke test that exercises `chromium-desktop` and `chromium-mobile` branches;
  - mobile branch proves compact visibility, 44px targets, document/main horizontal overflow, secondary geometry, and real Zoom-in hit testing;
  - desktop branch proves `MORE` is hidden and secondary controls are directly visible.

### Explicitly unchanged

- `PuzzleBoardPanel.svelte` production markup/CSS/prop wiring;
- puzzle route production orchestration;
- `PuzzleSession` domain and persistence;
- inventory production behavior;
- board zoom/pan implementation;
- global design tokens and `.arcade-btn-ghost` definition;
- package dependencies.

## Testing strategy

### Unit regression

Run the full web unit suite after the toolbar markup/style change. This covers the direct toolbar test plus existing `PuzzleBoardPanel` and route tests that action-check Zoom/Pause/Setup controls in the desktop test viewport.

### Chromium responsive proof

The new toolbar test in existing `gameplay-mobile-tap.spec.ts` runs on both:

- `chromium-desktop`: `MORE` hidden; Zoom/Pause/Setup visible inline;
- `chromium-mobile` at 390 × 844: primary actions + `MORE` visible; secondary controls hidden until disclosure opens.

On mobile it also:

- checks a primary button's rendered width/height are each at least 44px;
- clicks `Zoom in` after opening `MORE` to prove actionability/stacking;
- checks both `document.documentElement` and `.puzzle-main` for horizontal overflow.

### Session-control regression

Run `gameplay-session-controls.spec.ts` on Chromium mobile because existing @smoke flows call `pauseMission()`.

Run the full existing `@webkit-critical` slice on WebKit mobile rather than grepping one title; multiple tagged tests call `pauseMission()`.

## Acceptance mapping

- **All actions remain available:** unchanged props + full unit regression + rendered desktop/mobile checks.
- **Phone primary actions stay direct:** Chromium-mobile assertions.
- **Secondary actions use one compact surface:** local `MORE` + one secondary container.
- **Desktop stays direct:** Chromium-desktop rendered assertion.
- **Pause callers remain valid:** retry-safe existing helper + Chromium-mobile session suite + WebKit-critical slice.
- **No horizontal overflow:** document and `.puzzle-main` mobile checks.
- **Touch target convention:** rendered primary button is at least 44 × 44px on Chromium mobile.
- **Opened panel is usable, not merely visible:** real `Zoom in` click.
- **Interactive contrast does not regress:** reuse `.arcade-btn-ghost` (`--text-1`) instead of new `--text-2` button styling.
- **Accessible disclosure state:** explicit string `aria-expanded` / `data-open`; existing Rotation semantics retained.
- **No new framework/state owner:** one local `moreOpen`; no registry, store, route state, or shared component.
