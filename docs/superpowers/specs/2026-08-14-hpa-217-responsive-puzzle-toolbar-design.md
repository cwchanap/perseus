# HPA-217: Responsive Puzzle Toolbar — Design

**Linear:** HPA-217  
**Status:** Design for implementation  
**Date:** 2026-08-14

## Context

HPA-217 is the next actionable child of HPA-215. HPA-557 already split the puzzle route into focused feature components, so the toolbar has a clean existing seam:

- `PuzzleBoardPanel.svelte` owns the board viewport and renders `PuzzleToolbar.svelte`;
- `PuzzleToolbar.svelte` already receives every action and state bit through explicit props/callbacks;
- `PuzzleInventoryPanel.svelte` already demonstrates the intended local `$state` + `aria-expanded` / `aria-controls` pattern for compact presentation;
- HPA-219 pins the mobile page to the viewport and gives the board panel a shrinking layout;
- HPA-220 already uses the repository's existing gameplay tokens for compact panel actions.

The remaining problem is presentation. `PuzzleToolbar.svelte` renders every action into one wrapping row. On phone layouts that makes the toolbar tall and spends board height on lower-frequency view/session actions.

There is one existing integration constraint the toolbar-only view misses: mobile session-control E2E tests already call `GameplayPage.pauseMission()`, and that helper directly clicks the visible Pause button. The WebKit-critical session-control case also directly asserts that Pause is visible. Moving Pause behind `MORE` therefore requires a small test-harness compatibility edit; leaving Pause in the primary row solely to avoid that edit would be the wrong product trade-off.

## Goals

1. Keep every current `PuzzleToolbar` prop/callback unchanged.
2. Keep Undo, Redo, Hint, and Reference directly reachable below 1024px.
3. Put Zoom out, Zoom in, Fit/reset, Rotation, Pause, and Setup behind one local `MORE` control below 1024px.
4. Keep the same secondary controls inline on desktop.
5. Use one private `moreOpen` boolean, matching the inventory drawer's local presentation-state pattern.
6. Reuse the existing gameplay CSS variables and 44px coarse-pointer target convention.
7. Preserve Reference hold behavior, Rotation pressed/disabled semantics, native button keyboard behavior, and route keyboard shortcuts.
8. Keep existing mobile Pause E2E callers working through the existing `pauseMission()` helper.
9. Prove at 390 × 844 that the toolbar has no horizontal overflow and the opened secondary controls are actually clickable.

## Non-goals

- a reusable toolbar, action registry, command model, slot/group framework, or menu framework;
- a new popover/dropdown primitive;
- JavaScript `matchMedia` state;
- an icon dependency;
- outside-click, Escape, or focus-trap behavior;
- `role="toolbar"` or roving tabindex (HPA-223 owns broader keyboard accessibility);
- changes to `PuzzleSession`, route/session state, persistence, APIs, inventory behavior, board zoom/pan behavior, or package dependencies;
- a shared button component or new design tokens;
- backward compatibility for pre-release UI behavior.

## Options considered

### Option A — One concrete toolbar + CSS breakpoint + one local `moreOpen` boolean (chosen)

Keep one copy of every action in `PuzzleToolbar.svelte`. Primary controls stay in the normal row. Secondary controls stay in one container that is inline on desktop and becomes an anchored compact panel below 1024px.

**Why:** one callback instance per action, no duplicate accessible tree, no media-query listener, no registry, and one obvious future edit site for HPA-222/HPA-223.

### Option B — Keep flex-wrap and only shrink controls

Rejected. It still spends vertical board space on every lower-frequency action and does not satisfy the ticket's compact-menu requirement.

### Option C — Registry / generic overflow component

Rejected. Ten concrete buttons do not justify a command abstraction or reusable menu primitive.

### Option D — Separate desktop/mobile render trees

Rejected. The route already uses CSS breakpoints; JavaScript viewport state would duplicate presentation paths and add runtime state for no product value.

## Decision

Use Option A.

`PuzzleToolbar.svelte` remains the only production file that changes. Its external `Props` interface stays unchanged and it gains exactly one local state value:

```ts
let moreOpen = $state(false);
```

The existing E2E helper and session-control spec also change so their compact Pause call sites follow the new presentation.

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

At `min-width: 1024px`, secondary controls remain visible inline. At `max-width: 1023px`, they are hidden until `MORE` opens.

## Markup and local state

The component stays concrete:

```text
PuzzleToolbar
├── History group: Undo / Redo
├── Assistance group: Hint / Reference
├── MORE button (compact only)
└── Secondary
    ├── View group: Zoom out / Zoom in / Fit / Rotation
    └── Session group: Pause / Setup
```

`MORE` is a normal button:

```svelte
<button
	type="button"
	aria-label="More puzzle actions"
	aria-expanded={moreOpen ? 'true' : 'false'}
	aria-controls="puzzle-toolbar-secondary"
	onclick={() => (moreOpen = !moreOpen)}
>
	MORE
</button>
```

The secondary container uses explicit string state as well:

```svelte
<div
	id="puzzle-toolbar-secondary"
	data-testid="puzzle-toolbar-secondary"
	data-open={moreOpen ? 'true' : 'false'}
>
	...
</div>
```

Using explicit `'true' | 'false'` strings keeps the DOM contract deterministic and matches the existing Rotation `aria-pressed` style.

No outside-click or Escape handling is added. The panel can be closed with `MORE`; leaving it open is useful for repeated zoom actions.

## Existing semantics to preserve

### Reference

Reference remains hold-to-peek:

- pointer down -> `onReferenceDown`;
- pointer up / pointer leave / blur -> `onReferenceUp`;
- Space/Enter keydown -> `onReferenceDown`;
- matching keyup -> `onReferenceUp`.

HPA-222 owns persistent Reference mode.

### Rotation

Keep the current state contract:

```svelte
aria-pressed={rotationEnabled ? 'true' : 'false'}
aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
disabled={rotationToggleDisabled}
```

### Pause / Setup

Keep existing conditional rendering and callbacks. HPA-217 changes only compact reachability.

## Responsive styling

Reuse the route/gameplay breakpoint already used elsewhere:

```css
@media (max-width: 1023px) { ... }
@media (min-width: 1024px) { ... }
```

No JavaScript breakpoint state is added.

Copy the neighboring inventory panel-action visual language locally into `PuzzleToolbar.svelte` using existing tokens such as `--bg-1`, `--bg-2`, `--border`, `--text-2`, `--accent`, `--accent-glow`, and `--font-display`. Do not extract a shared button.

At coarse pointers, every toolbar button keeps at least a 44 × 44px target.

### Compact secondary panel

Below 1024px:

- `MORE` is visible;
- the closed secondary container is `display: none`;
- the open secondary container is `position: absolute` below/right of the toolbar;
- width is capped with `min(18rem, calc(100vw - 2rem))`;
- the panel uses a small two-column grid for controls;
- the panel overlays the board rather than expanding normal flow and stealing board height.

Keep the secondary panel's local `z-index: 20`.

`PuzzleBoardPanel.svelte` currently places `.board-wrap` after `.board-toolbar` and gives `.board-wrap` `overflow: auto`. `overflow: auto` creates a scroll container/block formatting context, not a stacking context by itself. With no competing positioned/z-indexed `.board-wrap`, the positioned secondary panel's own z-index is sufficient; adding a second z-index to `.puzzle-toolbar` is not justified by the current CSS.

The rendered E2E must nevertheless click an opened secondary control (`Zoom in`). That is the authoritative hit-testing proof: if future/current stacking causes the panel to be covered, Playwright's click fails even if `toBeVisible()` still passes.

## Existing Pause test callers

### `GameplayPage.pauseMission()`

Keep one helper; do not add a second compact helper. Extend the existing method:

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

Desktop callers still click Pause directly because it is visible. Compact callers open `MORE` first. The helper remains the single current/future Pause entry point.

### WebKit-critical session-control case

Replace its duplicate direct Pause lookup/click with `await gameplayPage.pauseMission()`. This keeps the explicit WebKit reachability coverage while following the same compact path.

## File boundaries

### Production

- `apps/web/src/lib/components/PuzzleToolbar.svelte`
  - local `moreOpen`;
  - concrete primary/secondary grouping;
  - explicit string `aria-expanded` / `data-open`;
  - existing-token styling;
  - compact absolute secondary panel;
  - unchanged props and callbacks.

### Component test

- `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
  - retain callback, Reference, Rotation, and conditional-control coverage;
  - add Setup gating;
  - add deterministic `MORE` expanded/collapsed DOM-state coverage;
  - verify a secondary callback remains wired.

### Existing E2E callers

- `apps/web/e2e/support/gameplay-page.ts`
  - teach existing `pauseMission()` to open `MORE` only when Pause is hidden.

- `apps/web/e2e/gameplay-session-controls.spec.ts`
  - route the WebKit reachability case through `pauseMission()` instead of assuming Pause is directly visible.

### Mobile toolbar acceptance proof

- `apps/web/e2e/gameplay-mobile-tap.spec.ts`
  - 390 × 844 compact visibility and horizontal-overflow proof;
  - open `MORE` and click `Zoom in` so stacking/hit testing is exercised;
  - close `MORE` and verify secondary controls hide again.

### Explicitly unchanged

- `PuzzleBoardPanel.svelte` markup/CSS/prop wiring;
- puzzle route orchestration;
- `PuzzleSession` domain and persistence;
- inventory behavior;
- board zoom/pan implementation;
- global design tokens;
- package dependencies.

## Testing strategy

### Vitest Browser Mode

`PuzzleToolbar.svelte.test.ts` owns markup/state/callback behavior. It does not emulate CSS layout.

### Chromium mobile

`gameplay-mobile-tap.spec.ts` owns 390 × 844 rendered compact visibility, width, and secondary hit testing.

`gameplay-session-controls.spec.ts --project=chromium-mobile` is a required regression check because existing smoke tests call `pauseMission()` on mobile.

### WebKit mobile

The existing WebKit-critical session-control reachability case is updated to use the helper. Run that focused case after changing the test so the new compact path is proven on the browser that owns the assertion; this is targeted existing coverage, not a new browser matrix.

## Acceptance mapping

- **All actions remain available:** unchanged props + component callback tests.
- **Phone primary actions stay direct:** rendered Chromium-mobile assertions.
- **Secondary actions use one compact surface:** local `MORE` + one secondary container.
- **Pause callers remain valid:** updated `pauseMission()` + Chromium-mobile session-control suite + targeted WebKit case.
- **No horizontal overflow:** rendered 390 × 844 document/toolbar geometry.
- **Opened panel is usable, not just visible:** Playwright clicks `Zoom in` after opening `MORE`.
- **Accessible state:** explicit string `aria-expanded` / `data-open`; existing Rotation pressed/disabled semantics retained.
- **No new framework/state owner:** one local `moreOpen`; no registry, store, route state, or shared component.
