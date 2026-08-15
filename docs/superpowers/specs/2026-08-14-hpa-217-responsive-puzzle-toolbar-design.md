# HPA-217: Responsive Puzzle Toolbar — Design

**Linear:** HPA-217  
**Status:** Design for implementation  
**Date:** 2026-08-14

## Context

HPA-217 is the next actionable child of HPA-215. The higher-priority gameplay work ahead of it in the epic is complete, and its only explicit blocker, HPA-557, has already split the puzzle route into focused feature components.

That leaves a clean seam:

- `PuzzleBoardPanel.svelte` owns the board viewport and renders `PuzzleToolbar.svelte`;
- `PuzzleToolbar.svelte` already receives every action and state bit through explicit props/callbacks;
- no toolbar state belongs in `PuzzleSession` or the route;
- HPA-219 already pins the phone layout to the viewport and makes the board panel shrink within the mobile page;
- HPA-220 already uses the repository's panel/action visual language and CSS variables in `PuzzleInventoryPanel.svelte`.

The remaining problem is presentation. `PuzzleToolbar.svelte` currently renders all controls into one wrapping flex row with raw gray/white/indigo utility styling. At phone widths the controls wrap into a tall block, consume scarce board height, and do not distinguish frequent puzzle actions from view/session actions.

There is no icon library in the web app, so this ticket should not add one just to shorten the toolbar.

## Goals

1. Keep every current toolbar action and callback contract unchanged.
2. Make the toolbar compact and readable at the existing mobile breakpoint below 1024px.
3. Keep the most common puzzle actions directly reachable on phone layouts.
4. Put lower-frequency view/session actions behind one local `MORE` control on phone layouts.
5. Group related actions clearly on desktop without introducing a toolbar framework.
6. Reuse the existing panel/action CSS variables rather than adding a design-token layer or icon dependency.
7. Preserve native button keyboard behavior, existing route keyboard shortcuts, Reference hold behavior, disabled states, and Rotation pressed state.
8. Prove the 390 × 844 gameplay layout does not horizontally overflow and that the compact overflow controls are reachable.

## Non-goals

- a reusable application-wide toolbar or command system;
- an action registry, command metadata array, slot/group API, or menu framework;
- new keyboard shortcuts or roving-toolbar keyboard navigation (HPA-223);
- persistent Reference mode or assistance semantics (HPA-222);
- tooltips;
- an icon package;
- a general popover/dropdown primitive;
- changes to `PuzzleSession`, route orchestration, persistence, APIs, inventory behavior, or board interaction;
- outside-click/Escape dismissal machinery for the compact action panel;
- backward-compatibility work for pre-release UI behavior.

## Options considered

### Option A — One concrete toolbar + CSS breakpoint + one local `moreOpen` boolean (recommended)

Keep one copy of every action in `PuzzleToolbar.svelte`. The frequent controls stay in the main row. The existing secondary controls live in one secondary container that is inline on desktop and becomes a small anchored panel below 1024px. A single local `moreOpen` boolean controls that panel only on compact layouts.

**Pros**

- one action/callback instance, so no duplicate accessible controls;
- no media-query listener or route state;
- no registry or generic menu component;
- desktop and mobile share the same markup and semantics;
- easy to test with the existing component and mobile E2E suites;
- HPA-222/HPA-223 can edit the same concrete component later.

**Cons**

- adds one ephemeral UI boolean;
- the compact panel remains open until `MORE` is toggled again, which is intentionally simpler than adding dismissal infrastructure.

### Option B — Keep flex-wrap and only shrink padding/text

Keep every control visible and rely on tighter spacing.

**Rejected:** this does not satisfy the ticket's requested compact secondary-action menu and still scales poorly as existing conditional Pause/Setup controls appear.

### Option C — Render from an action registry and generic overflow menu

Represent every action as metadata and render desktop/mobile groups from a shared command list.

**Rejected:** this is exactly the abstraction HPA-217 says not to build. Ten concrete buttons do not justify a command model.

### Option D — Render different desktop/mobile trees using `matchMedia`

Track viewport mode in JavaScript and conditionally render separate layouts.

**Rejected:** the route already uses CSS breakpoints for board/inventory layout. Adding media-query state and listeners to the toolbar creates unnecessary runtime state and duplicated presentation paths.

## Decision

Use **Option A**.

`PuzzleToolbar.svelte` remains the sole owner of toolbar presentation. Its external props stay unchanged. It gains exactly one local state value:

```ts
let moreOpen = $state(false);
```

No route, store, service, or shared type changes are needed.

## Action grouping

### Primary actions

These remain directly reachable at every width:

- Undo
- Redo
- Hint
- Reference, when the puzzle has one

These are the actions most closely tied to the current solve loop. Visible labels may stay short (`UNDO`, `REDO`, `HINT`, `REF`) while the existing accessible labels remain descriptive.

### Secondary actions

These remain inline on desktop and move behind `MORE` below 1024px:

**View**

- Zoom out
- Zoom in
- Fit/reset view
- Rotation mode

**Session**

- Pause, when `canPause`
- Setup, when `canOpenSetup`

This keeps the phone toolbar focused while preserving every current action with one extra tap at most.

## Component contract

Keep the existing `Props` interface unchanged:

```ts
interface Props {
	onUndo: () => void;
	onRedo: () => void;
	onHint: () => void;
	onReferenceDown: (event?: ReferenceHoldEvent) => void;
	onReferenceUp: (event?: ReferenceHoldEvent) => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onResetView: () => void;
	onRotationToggle: () => void;
	onPause?: () => void;
	onOpenSetup?: () => void;
	canOpenSetup?: boolean;
	canPause?: boolean;
	canUndo: boolean;
	canRedo: boolean;
	rotationEnabled: boolean;
	rotationToggleDisabled?: boolean;
	hasReference?: boolean;
}
```

Do not create an `Action` type, `ToolbarGroup` type, callback map, or derived command list.

## Markup and state

The component becomes three concrete pieces inside one root:

```text
PuzzleToolbar
├── primary groups
│   ├── history: Undo / Redo
│   └── assistance: Hint / Reference
├── MORE button (compact layouts only)
└── secondary controls
    ├── view: Zoom out / Zoom in / Fit / Rotation
    └── session: Pause / Setup when available
```

The `MORE` button is a normal `<button type="button">` with:

```svelte
aria-label="More puzzle actions"
aria-expanded={moreOpen}
aria-controls="puzzle-toolbar-secondary"
```

Clicking it only toggles `moreOpen`.

The secondary container has a stable id and a test hook:

```svelte
id="puzzle-toolbar-secondary"
data-testid="puzzle-toolbar-secondary"
data-open={moreOpen}
```

At desktop widths it is visible regardless of `moreOpen`; the `MORE` button is hidden. Below 1024px it is hidden when `moreOpen` is false and displayed as the anchored compact panel when true.

Do not add outside-click listeners, focus traps, global window handlers, or Escape state. The panel contains ordinary buttons, is not modal, and can be closed by pressing `MORE` again. Keeping it open is also useful for repeated zoom actions.

## Existing interaction semantics to preserve

### Undo / Redo

Keep native `disabled={!canUndo}` / `disabled={!canRedo}` and the existing callbacks.

### Reference

Preserve the current hold-to-peek behavior exactly:

- pointer down -> `onReferenceDown`;
- pointer up / pointer leave / blur -> `onReferenceUp`;
- Space/Enter keydown -> `onReferenceDown`;
- matching keyup -> `onReferenceUp`.

HPA-217 must not convert Reference into a toggle; HPA-222 owns persistent reference mode.

### Rotation

Keep:

```svelte
aria-pressed={rotationEnabled ? 'true' : 'false'}
aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
disabled={rotationToggleDisabled}
```

Keep one `rotation-lock-reason` screen-reader description. No visual tooltip is added.

### Pause / Setup

Keep the existing conditional rendering. HPA-217 only changes where these controls appear on compact layouts.

## Responsive layout

Reuse the existing gameplay breakpoint:

```css
@media (max-width: 1023px) { ... }
```

Do not introduce a second JavaScript breakpoint.

### Desktop (1024px and wider)

- root toolbar is a wrapping flex row;
- history, assistance, view, and session controls are visually grouped;
- secondary controls are static/in-flow;
- `MORE` is hidden;
- `moreOpen` has no effect on desktop visibility.

### Compact layout (below 1024px)

- history + assistance remain in the main wrapping row;
- `MORE` is visible;
- secondary controls are removed from normal flow when closed;
- when open, the secondary container is positioned from the right edge of the toolbar and uses a small two-column grid;
- panel width is capped so it cannot exceed the viewport:

```css
width: min(18rem, calc(100vw - 2rem));
```

- the root and groups keep `min-width: 0` and wrapping enabled;
- the panel may overlay the board temporarily; it must not create a new page-width budget or push the inventory drawer horizontally.

A small local z-index is acceptable for this anchored panel. This is not a reusable overflow-sheet system.

## Visual styling

Replace the raw gray/white/indigo toolbar palette with the same existing variables used by the neighboring gameplay panels:

- `--bg-1`
- `--bg-2`
- `--border`
- `--text-2`
- `--accent`
- `--accent-glow`
- `--font-display`

The button style stays local to `PuzzleToolbar.svelte` and should mirror the compact `panel-action` language already used by `PuzzleInventoryPanel.svelte`:

```css
.toolbar-button {
	font-family: var(--font-display);
	font-size: 0.65rem;
	font-weight: 600;
	letter-spacing: 0.08em;
	color: var(--text-2);
	background: var(--bg-1);
	border: 1px solid var(--border);
	padding: 0.45rem 0.65rem;
	white-space: nowrap;
}

.toolbar-button:hover:not(:disabled),
.toolbar-button:focus-visible {
	color: var(--accent);
	border-color: var(--accent);
}

.toolbar-button[aria-pressed='true'] {
	color: var(--accent);
	border-color: var(--accent);
	background: var(--accent-glow);
	box-shadow: 0 0 10px var(--accent-glow);
}
```

Use a visible focus outline. Disabled controls remain visibly disabled and non-clickable.

Do not extract these styles to a shared component or token file in this ticket.

## Touch targets

Match the existing coarse-pointer gameplay convention:

```css
@media (pointer: coarse) {
	.toolbar-button {
		min-width: 44px;
		min-height: 44px;
	}
}
```

This keeps phone controls practical without inflating desktop buttons.

## File boundaries

### `apps/web/src/lib/components/PuzzleToolbar.svelte`

- add `moreOpen`;
- regroup the existing controls;
- add the compact `MORE` button and secondary panel;
- convert styling to existing gameplay CSS variables;
- keep the prop/callback surface unchanged;
- keep all Reference and Rotation semantics.

### `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

- retain existing action/callback tests;
- add Setup gating coverage;
- add `MORE` expanded/collapsed state coverage;
- verify a secondary action is still wired after opening the compact panel;
- keep Rotation disabled/pressed coverage and Reference hold coverage.

### `apps/web/e2e/gameplay-mobile-tap.spec.ts`

Add one focused Chromium-mobile layout test using the existing 390 × 844 fixture and `IMMEDIATE_START` preferences:

- toolbar is fully within viewport width;
- document has no horizontal overflow;
- Undo, Redo, Hint, Reference, and `MORE` are visible;
- Zoom/Fit/Rotation/Pause/Setup are not visible before `MORE` opens;
- clicking `MORE` exposes those secondary actions;
- clicking `MORE` again hides them.

No new fixture, Playwright project, page object, or E2E helper is needed.

### Explicitly unchanged

- `PuzzleBoardPanel.svelte` prop wiring;
- puzzle route script/session orchestration;
- `PuzzleSession` domain and persistence;
- inventory behavior;
- board zoom/pan implementation;
- API/shared packages;
- global design tokens;
- package dependencies.

## Testing strategy

### Component tests

Use the existing Vitest Browser Mode test file as the fast behavior contract. It owns callback wiring, conditional controls, Reference hold events, Rotation state, and the new `MORE` toggle state.

The component test does not need to emulate CSS viewport layout. It verifies the component state/markup contract; Playwright owns rendered mobile visibility.

### Mobile E2E

Use the existing `chromium-mobile` project at 390 × 844. This is the rendered proof for compact visibility and overflow.

The test should inspect actual element visibility before/after `MORE`, then assert:

```ts
const overflow = await page.evaluate(() => ({
	scrollWidth: document.documentElement.scrollWidth,
	innerWidth: window.innerWidth
}));
expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
```

Do not add screenshot/golden testing or a browser matrix for this ticket.

## Acceptance mapping

- **All current actions remain available:** unchanged prop surface + component callback tests.
- **Desktop and phone usable without horizontal overflow:** CSS-first layout + 390 × 844 Playwright geometry/overflow proof.
- **Common phone actions directly reachable:** Undo, Redo, Hint, Reference remain in the primary row.
- **Secondary actions in one menu:** one local `MORE` control reveals view/session actions below 1024px.
- **Accessible names / toggle / disabled state:** existing labels retained, `MORE` gets `aria-expanded`/`aria-controls`, Rotation keeps `aria-pressed`, disabled controls stay native `disabled`.
- **No new global state or abstraction:** only `PuzzleToolbar.moreOpen` is added.
- **Focused tests:** one component test file plus one focused mobile E2E case.

## Future compatibility with adjacent tickets

HPA-222 can add persistent Reference state by editing the existing assistance group without changing this responsive architecture. HPA-223 can improve keyboard navigation/announcements later without first dismantling a command registry or generic toolbar abstraction.

No extension point is added specifically for either future ticket.
