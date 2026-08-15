# HPA-222: Persistent Reference Toggle — Design

**Linear:** HPA-222  
**Status:** Design for implementation  
**Date:** 2026-08-15

## Context

HPA-222 is the next actionable child of HPA-215. The earlier gameplay slices through HPA-217 are complete, and HPA-557 already split the puzzle route into concrete board, toolbar, inventory, and dialog components.

The current code already contains almost all domain support this ticket needs:

- `PuzzleSessionState.activeReferenceMode` is the runtime-only source intended to represent active reference presentation.
- `ReferenceMode` already includes `hold` and `toggle`.
- `set_reference_mode` already counts a new activation when transitioning from inactive to active.
- Hold and Toggle are already informational for result classification; only Hint and the unused Ghost mode make a timed run assisted.
- `clearTransientGameplayState()` already clears reference interaction before explicit pause, restart, and active-session exit.
- `ReferenceOverlay.svelte` already owns the full-image presentation.

The main gap is that the route also maintains `showReferenceOverlay`, duplicating the session's active reference state. Adding another boolean for persistent mode would make that duplication worse. HPA-222 should instead finish the existing seam and use the session state directly.

## Goals

1. Keep the existing press-and-hold reference interaction as **Peek**.
2. Add one persistent **Reference** toggle that remains active until toggled off.
3. Make `PuzzleSession.activeReferenceMode` the single source of truth for whether reference presentation is active.
4. Clear persistent reference state on navigation, explicit pause, restart, completion, and image failure.
5. Preserve current scoring: Hint makes timed results assisted; Peek and Reference do not.
6. Make missing or broken reference images non-interactive without breaking gameplay.
7. Explain the scoring distinction with one concise visible help line.
8. Keep pointer and keyboard behavior on native buttons with focused tests only.

## Non-goals

- Ghost Reference or opacity controls.
- Aligning a reference image behind the board.
- Progressive hint tiers or an assistance-mode menu.
- New result classes, analytics events, or preference persistence.
- A generic lifecycle-cleanup abstraction.
- A reusable media-loading framework.
- New Playwright projects, screenshot tests, or a broad browser matrix.
- Backward compatibility for pre-release UI behavior.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Active reference state | `PuzzleSessionState.activeReferenceMode` | Reuse as canonical state |
| Hold/Toggle actions | `set_reference_mode` | Reuse unchanged |
| Activation counter | `SessionCounters.referenceActivations` | Reuse unchanged |
| Result classification | `recomputeResultClass()` | Reuse unchanged; add focused proof |
| Pause/restart cleanup | `clearTransientGameplayState()` | Extend locally, no new framework |
| Full-image UI | `ReferenceOverlay.svelte` | Extend with one unavailable callback |
| Toolbar | `PuzzleToolbar.svelte` | Add one concrete toggle button and help text |
| Board composition | `PuzzleBoardPanel.svelte` | Own image-load failure presentation state |

No new service, store, schema, package, or shared component is justified.

## Options considered

### Option A — Use `activeReferenceMode` as the single source of truth (recommended)

Remove the route-local `showReferenceOverlay` boolean. Derive overlay visibility and toggle pressed state from the current `PuzzleSession` snapshot. Keep only pointer/keyboard hold bookkeeping (`referencePointerId` and `referenceHoldSource`) outside the session because those values are DOM-event details, not gameplay state.

**Pros**

- uses the domain seam that already exists;
- removes duplicated assistance state;
- Toggle does not require persistence changes because active reference mode is intentionally runtime-only;
- pause/restart cleanup continues through the existing route helper;
- HPA-223 can later add Escape behavior without a second state path.

**Cons**

- touches the route and session completion path in addition to toolbar markup.

### Option B — Keep `showReferenceOverlay` and add `referenceToggled`

Treat both values as route-local presentation state and dispatch `set_reference_mode` only for counters/result facts.

**Rejected:** two booleans plus session state create three representations of one interaction. Every lifecycle transition would need synchronization and tests against drift.

### Option C — Add an assistance controller/menu component

Create a reusable controller or menu for Hint, Peek, Toggle, and future modes.

**Rejected:** the ticket explicitly has only two reference interactions and one hint action. A framework would add indirection before a demonstrated second consumer exists.

## Decision

Use **Option A**.

`PuzzleSession.activeReferenceMode` remains runtime-only and becomes the canonical active-mode value used by the route:

```ts
const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
const referenceActive = $derived(activeReferenceMode !== null);
const referenceToggled = $derived(activeReferenceMode === 'toggle');
```

The route keeps only event bookkeeping needed to end a pointer/keyboard hold safely:

```ts
let referencePointerId = $state<number | null>(null);
let referenceHoldSource = $state<'pointer' | 'keyboard' | null>(null);
```

There is no new persisted field and no schema version change.

## Interaction model

### Peek

The existing Reference hold button becomes clearly labeled **Peek**.

- Pointer down: dispatch `set_reference_mode: 'hold'`.
- Matching pointer up / leave / window pointer-up: dispatch `set_reference_mode: null`.
- Space/Enter keydown: start Hold.
- Matching keyup or blur: end Hold.
- Peek is disabled while persistent Reference is already toggled on because holding an already-visible image is redundant.

The route only clears the session mode on release when the active mode is still `hold`. This prevents an old release event from turning off a persistent Toggle that replaced the Hold.

### Reference toggle

Add one native button:

```svelte
<button
	type="button"
	aria-label="Toggle reference"
	aria-pressed={referenceToggled ? 'true' : 'false'}
	disabled={!referenceAvailable}
	onclick={onReferenceToggle}
>
	REF
</button>
```

Clicking it performs exactly one of two transitions:

```text
null -> toggle
toggle -> null
```

The toggle is not persisted. A restored session therefore never reopens the reference image automatically.

### Help text

Show one short visible line in the toolbar:

> Hint affects timed results. Peek and Reference do not.

This is enough to explain the assistance distinction without adding tooltips, a help modal, or a rules panel.

## Result classification and counters

No scoring implementation changes are required.

The existing engine already computes:

```ts
if (state.mode === 'relaxed') return 'relaxed';
if (state.facts.hintUsed || state.facts.ghostReferenceUsed) return 'assisted_timed';
if (state.facts.rotationUsed) return 'rotation_timed';
return 'standard_timed';
```

`hold` and `toggle` therefore remain informational. HPA-222 adds a focused regression test proving that both modes keep a timed run standard while Hint changes it to assisted.

`referenceActivations` keeps the current transition rule: entering any non-null reference mode from `null` counts one activation. Turning Toggle off does not add another activation.

## Lifecycle cleanup

### Navigation

Puzzle navigation already tears down the prior session and sets `sessionState = null` before constructing the next one. Because overlay visibility is derived from `activeReferenceMode`, the reference disappears automatically when the prior session is removed.

The route also clears `referencePointerId` and `referenceHoldSource` while tearing down a puzzle so stale DOM-event bookkeeping cannot cross route reuse.

### Explicit pause and restart

Keep using `clearTransientGameplayState()`. Replace its direct `showReferenceOverlay` mutation with one small reference helper that:

1. clears hold bookkeeping; and
2. dispatches `set_reference_mode: null` while the session is active.

No lifecycle observer or generic cleanup registry is added.

### Completion

Completion is the one lifecycle path that can happen directly inside the engine while reference mode is active. Clear `state.activeReferenceMode` at the start of `handleBoardCompletion()`.

Doing this there covers both:

- the first completion seal; and
- undo-then-recomplete, where a retained seal skips `doComplete()`.

This prevents a toggled reference from reappearing if a completed run is later undone back to active.

### Blur

Window blur keeps its current behavior: cancel a Hold/Toggle reference interaction and cancel piece selection. It reuses the same local reference-clear helper.

## Missing and failed reference images

There are two distinct cases.

### No reference exists

If `puzzle.hasReference !== true`, do not render Peek/Reference actions. This preserves the current clean absence behavior.

### Metadata says reference exists, but it is unavailable

`PuzzleBoardPanel.svelte` owns a small `referenceLoadFailed` presentation flag because it renders both the overlay and toolbar. Reference availability is:

```ts
const referenceAvailable = $derived(
	puzzle.hasReference === true && referenceImageUrl !== null && !referenceLoadFailed
);
```

When `referenceImageUrl` changes for a new puzzle, reset `referenceLoadFailed`.

`ReferenceOverlay.svelte` gains one optional callback:

```ts
onUnavailable?: () => void;
```

Its `<img onerror>` marks its existing local error state and calls the callback. `PuzzleBoardPanel` then:

1. marks the current reference unavailable;
2. disables Peek/Reference controls; and
3. asks the route to clear the active reference mode.

This is intentionally not a preload service, retry system, or generalized asset-health layer. A later navigation to a different reference URL gets a fresh attempt.

## Component contracts

### `PuzzleToolbar.svelte`

Keep the current concrete button structure. Add only:

```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

Retain `hasReference` to decide whether reference actions exist at all.

The existing `onReferenceDown` / `onReferenceUp` callbacks remain for Peek.

### `PuzzleBoardPanel.svelte`

Add:

```ts
referenceToggled: boolean;
onReferenceToggle: () => void;
onReferenceUnavailable: () => void;
```

Keep `referenceImageUrl` and `referenceActive` as presentation inputs. The panel owns only image-load failure state, not gameplay reference mode.

### `ReferenceOverlay.svelte`

Add the optional `onUnavailable` callback and invoke it on image load failure.

No generic loading/error component is extracted.

## Accessibility and keyboard behavior

- Peek and Reference remain native `<button type="button">` controls.
- Peek keeps explicit Space/Enter press-and-release behavior because its semantics are hold-based.
- Reference uses native button activation and exposes persistent state with `aria-pressed`.
- Disabled reference controls use native `disabled`.
- Existing toolbar focus styles continue to apply.
- Escape-to-cancel and roving toolbar/grid navigation remain HPA-223 work.

## Testing strategy

Use the existing Vitest Browser Mode and pure session tests. No new Playwright test is necessary for this ticket because HPA-222 changes interaction/state semantics, not responsive geometry.

### Session tests

Prove:

- Hold and Toggle leave a timed run `standard_timed`.
- Hint changes the run to `assisted_timed`.
- Completion clears `activeReferenceMode` on first completion and retained-seal recompletion.

### Toolbar tests

Prove:

- Peek retains pointer and Space/Enter hold callbacks.
- Reference Toggle calls its callback and exposes `aria-pressed`.
- Peek is disabled while Toggle is active.
- both controls are disabled when a declared reference is unavailable;
- controls are absent when the puzzle has no reference;
- help copy is present.

### Overlay / board-panel tests

Prove:

- image error calls `onUnavailable`;
- board-panel failure state disables reference actions;
- a new reference URL resets the failure state.

### Route tests

Prove:

- Toggle opens the overlay until toggled off;
- Hold still shows only while held;
- navigation clears a toggled reference;
- explicit pause clears a toggled reference;
- image failure clears the active session mode through the board callback path.

## File boundaries

### Production

- `apps/web/src/lib/services/gameplay/session/session.ts`
  - clear runtime reference mode at board completion.
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
  - derive active/toggled presentation from `sessionState.activeReferenceMode`;
  - add Toggle handler;
  - consolidate existing reference cleanup around the session action;
  - remove `showReferenceOverlay`.
- `apps/web/src/lib/components/PuzzleToolbar.svelte`
  - label Hold as Peek;
  - add persistent Reference button and concise help text;
  - expose availability/pressed state.
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
  - track only reference image failure;
  - pass availability/Toggle state to toolbar;
  - forward image-unavailable cleanup.
- `apps/web/src/lib/components/ReferenceOverlay.svelte`
  - notify its owner when the image fails.

### Tests

- `apps/web/src/lib/services/gameplay/session/session.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

### Explicitly unchanged

- persisted session schema/version;
- API and completion contracts;
- local statistics format;
- gameplay preferences;
- inventory and board placement logic;
- Playwright fixtures/projects;
- dependencies and global design tokens.

## Acceptance mapping

- **Hold to Peek continues to work:** existing hold path retained and renamed clearly.
- **Toggle stays open until off:** `activeReferenceMode === 'toggle'` drives overlay + pressed state.
- **Lifecycle cleanup:** existing route cleanup handles pause/restart/navigation; session completion clears the canonical mode.
- **Hint assisted, reference informational:** existing result-class implementation plus focused regression tests.
- **Missing/failed images safe:** absent controls when no reference; disabled controls and active-mode cleanup on URL/image failure.
- **Pointer and keyboard:** native Toggle activation plus retained Hold keyboard handlers.
- **Focused tests:** existing unit/browser test files only; no new framework or broad browser gate.

## YAGNI checkpoint

HPA-222 should stop once Peek + one Toggle work reliably and the scoring distinction is clear. Ghost modes, opacity, reference preferences, generalized asset retries, and assistance menus remain deferred until a concrete product need appears.
