# HPA-222: Persistent Reference Toggle — Design

**Linear:** HPA-222  
**Status:** Design for implementation  
**Date:** 2026-08-15

## Context

HPA-222 is the next actionable child of HPA-215. The earlier gameplay slices through HPA-217 are complete, and HPA-557 already split the puzzle route into concrete board, toolbar, inventory, and dialog components.

The current code already contains almost all domain support this ticket needs:

- `PuzzleSessionState.activeReferenceMode` is the runtime-only field intended to represent active reference presentation.
- `ReferenceMode` already includes `hold` and `toggle`.
- `set_reference_mode` already counts an activation when moving from inactive to active.
- Hold and Toggle are already informational for result classification; Hint and the unused Ghost mode are the assistance paths that can make a timed run assisted.
- `clearTransientGameplayState()` already owns route-local cleanup before pause/restart/active-session exit.
- `ReferenceOverlay.svelte` already owns full-image presentation and local image-error state.
- HPA-217 already compacted the toolbar and established the existing 390 × 844 browser geometry smoke test.

The main architectural gap is that the route also maintains `showReferenceOverlay`, duplicating `PuzzleSessionState.activeReferenceMode`. Adding another route boolean for persistent reference mode would make that duplication worse. HPA-222 should instead finish the existing seam and make the session snapshot canonical.

## Goals

1. Keep the existing press-and-hold reference interaction as **Peek**.
2. Add one persistent **Reference** toggle that remains active until toggled off.
3. Make `PuzzleSession.activeReferenceMode` the single source of truth for active reference presentation.
4. Clear persistent Reference on navigation, explicit pause, restart, completion, and image failure.
5. Let persistent Reference survive ordinary window blur; blur cancels only an in-progress Hold.
6. Preserve current scoring: Hint makes timed results assisted; Peek and Reference do not.
7. Explain that scoring distinction without adding permanent height to the compact toolbar.
8. Make missing or broken reference images non-interactive without breaking gameplay.
9. Keep pointer and keyboard behavior on native buttons with focused tests and the existing mobile toolbar geometry proof.

## Non-goals

- Ghost Reference or opacity controls.
- Aligning a reference image behind the board.
- Progressive hint tiers or an assistance-mode menu.
- New result classes, analytics events, or preference persistence.
- A generic lifecycle-cleanup abstraction.
- A reusable media-loading framework.
- A new Playwright project, fixture family, screenshot suite, or broad browser matrix.
- Backward compatibility for pre-release UI behavior.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Active reference state | `PuzzleSessionState.activeReferenceMode` | Reuse as canonical state |
| Hold/Toggle actions | `set_reference_mode` | Reuse unchanged |
| Activation counter | `SessionCounters.referenceActivations` | Reuse unchanged |
| Result classification | `recomputeResultClass()` | Reuse unchanged; add focused proof |
| Completed lifecycle entry | `transitionToInternal()` | Extend with one `to === 'completed'` runtime cleanup |
| Pause/restart cleanup | `clearTransientGameplayState()` | Extend locally, no new framework |
| Hold blur/release cleanup | existing route hold bookkeeping | Consolidate without clearing Toggle |
| Full-image UI | `ReferenceOverlay.svelte` | Extend with one unavailable callback |
| Toolbar | `PuzzleToolbar.svelte` | Add concrete Peek + pressed Reference controls |
| Assistance explanation | `MissionSetupDialog.inputHelp` + `aria-describedby` pattern | Reuse; do not add a toolbar paragraph |
| Board composition | `PuzzleBoardPanel.svelte` | Own image-load failure presentation state |
| Mobile geometry proof | `e2e/gameplay-mobile-tap.spec.ts` | Update existing query/expectations and rerun |

No new service, store, schema, package, or shared component is justified.

## Options considered

### Option A — Use `activeReferenceMode` as the single source of truth (recommended)

Remove the route-local `showReferenceOverlay` boolean. Derive overlay visibility and Toggle pressed state from the current `PuzzleSession` snapshot. Keep only pointer/keyboard Hold bookkeeping (`referencePointerId` and `referenceHoldSource`) outside the session because those values are DOM-event details, not gameplay state.

**Pros**

- uses the domain seam that already exists;
- removes duplicated assistance state;
- Toggle needs no persistence change because active reference mode is intentionally runtime-only;
- pause/restart cleanup continues through the existing route helper;
- completion cleanup can be made complete with one assignment in the existing lifecycle transition primitive;
- HPA-223 can later add Escape behavior without a second reference-state path.

**Cons**

- touches the route and the session lifecycle transition primitive in addition to toolbar markup;
- requires the existing mobile toolbar smoke caller to be updated because one primary action becomes two.

### Option B — Keep `showReferenceOverlay` and add `referenceToggled`

Treat both values as route-local presentation state and dispatch `set_reference_mode` only for counters/result facts.

**Rejected:** two booleans plus session state create three representations of one interaction. Every lifecycle transition would need synchronization and tests against drift.

### Option C — Add an assistance controller/menu component

Create a reusable controller or menu for Hint, Peek, Toggle, and future modes.

**Rejected:** the ticket has two reference interactions and one Hint action. A framework adds indirection before a demonstrated second consumer exists.

## Decision

Use **Option A**.

`PuzzleSession.activeReferenceMode` remains runtime-only and becomes the canonical active-mode value used by the route:

```ts
const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
const referenceActive = $derived(activeReferenceMode !== null);
const referenceToggled = $derived(activeReferenceMode === 'toggle');
```

The route keeps only event bookkeeping needed to end a pointer/keyboard Hold safely:

```ts
let referencePointerId = $state<number | null>(null);
let referenceHoldSource = $state<'pointer' | 'keyboard' | null>(null);
```

There is no new persisted field and no schema version change.

## Interaction model

### Peek

The existing Reference hold button becomes clearly labeled **Peek**.

- Pointer down dispatches `set_reference_mode: 'hold'`.
- The successful Hold activation keeps the existing `checkpointSession()` call because `referenceActivations` and `hasUserActivity` are persisted evidence even though `activeReferenceMode` itself is runtime-only.
- Matching pointer up / pointer leave / matching global pointer-up ends Hold.
- Space/Enter keydown starts Hold; matching keyup ends it.
- Window blur ends Hold.
- Peek is disabled while persistent Reference is toggled on because holding an already-visible image is redundant.

A Hold release only dispatches `mode: null` when the session is still in `hold`. A stale release event must never turn off a later persistent Toggle.

### Persistent Reference

Add one native button:

```svelte
<button
	type="button"
	aria-label="Toggle reference"
	aria-pressed={referenceToggled ? 'true' : 'false'}
	aria-describedby="puzzle-assistance-result-help"
	disabled={!referenceAvailable}
	onclick={onReferenceToggle}
>
	REF
</button>
```

Clicking it performs exactly one of two intended steady-state transitions:

```text
null -> toggle
toggle -> null
```

Toggle-on checkpoints the session so the activation counter / activity evidence is promptly persisted. Toggle-off does not need another write because the active mode is runtime-only.

The Toggle is not persisted. A restored session therefore never reopens the reference image automatically.

### Blur semantics

Persistent Reference means persistent across ordinary focus loss. Window blur therefore has two different responsibilities:

- if a pointer/keyboard Hold is in progress, end that Hold and dispatch `set_reference_mode: null` while the session is active;
- if `activeReferenceMode === 'toggle'`, leave it alone;
- continue cancelling piece selection as the route does today.

Do not reuse the lifecycle cleanup helper from pause/restart on blur. That helper intentionally clears both Hold and Toggle.

## Assistance explanation

HPA-217 intentionally keeps the primary mobile toolbar compact. Adding a wrapping paragraph beside the new fifth primary action would consume board height on every puzzle and work against that design.

Reuse existing surfaces instead:

1. Extend `MissionSetupDialog`'s existing visible `inputHelp` copy to include the scoring rule:

   > Choose your mode and rotation settings before starting. Hints affect timed results; Peek and Reference do not.

2. Add one shared screen-reader-only explanation in `PuzzleToolbar.svelte`:

```svelte
<span id="puzzle-assistance-result-help" class="sr-only">
	Hint affects timed results. Peek and Reference do not.
</span>
```

3. Point Hint, Peek, and persistent Reference at that text with `aria-describedby="puzzle-assistance-result-help"`.

This satisfies the ticket's clear assistance labeling without permanent toolbar chrome, tooltips, or a help modal.

## Result classification and counters

No scoring implementation changes are required.

The existing engine already computes:

```ts
if (state.mode === 'relaxed') return 'relaxed';
if (state.facts.hintUsed || state.facts.ghostReferenceUsed) return 'assisted_timed';
if (state.facts.rotationUsed) return 'rotation_timed';
return 'standard_timed';
```

`hold` and `toggle` therefore remain informational. Add a regression test that exercises Hold, Toggle, and Hint together, but treat the Hold/Toggle assertions as an existing contract test rather than pretending they are newly failing behavior.

`referenceActivations` keeps its current rule: entering any non-null reference mode from `null` counts one activation. Turning Toggle off does not add another activation.

## Lifecycle cleanup

### Navigation

Puzzle navigation already tears down the prior session and sets `sessionState = null` before constructing the next one. Because overlay visibility is derived from `activeReferenceMode`, the reference disappears automatically when the prior session is removed.

Also clear `referencePointerId` and `referenceHoldSource` during route reuse so stale DOM-event bookkeeping cannot cross puzzles.

### Explicit pause, restart, and active-session exit

Extend the existing route-local transient cleanup so it clears **any** active reference mode while the session is still active:

1. clear Hold bookkeeping;
2. if `sessionState.lifecycle === 'active'` and `activeReferenceMode !== null`, dispatch `set_reference_mode: null`;
3. continue the existing selection/hint/rejection cleanup;
4. only then perform the pause/restart/exit lifecycle transition.

The ordering matters because `doSetReferenceMode()` rejects the action once lifecycle is no longer `active`.

This remains one concrete route helper, not a lifecycle registry.

### Completion

`handleBoardCompletion()` is not the only path into completed lifecycle. `doRedo()` can restore a completed board with a retained completion seal and calls `transitionToInternal('completed')` directly.

Therefore clear the runtime-only reference mode at the actual common lifecycle entry:

```ts
function transitionToInternal(to: SessionLifecycle) {
	const from = state.lifecycle;
	if (to === 'completed') state.activeReferenceMode = null;
	state.lifecycle = to;
	emit({ type: 'lifecycle', from, to });
}
```

That single assignment covers:

- first completion through `doComplete()`;
- retained-seal re-placement through `handleBoardCompletion()`;
- redo-to-completed through `doRedo()`.

No new lifecycle hook or observer is added.

### Window blur

Blur is **not** a completed/pause/restart lifecycle transition. It only ends an in-progress Hold and leaves persistent Toggle active.

## Missing and failed reference images

There are two distinct cases.

### No reference exists

If `puzzle.hasReference !== true`, do not render Peek/Reference actions. This preserves the current clean absence behavior.

### Metadata says reference exists, but it is unavailable

`PuzzleBoardPanel.svelte` owns a small `referenceLoadFailed` presentation flag because it renders both overlay and toolbar. Reference availability is:

```ts
const referenceAvailable = $derived(
	puzzle.hasReference === true && referenceImageUrl !== null && !referenceLoadFailed
);
```

When the puzzle/reference URL changes, reset `referenceLoadFailed`.

`ReferenceOverlay.svelte` gains one optional callback:

```ts
onUnavailable?: () => void;
```

Its `<img onerror>` marks its existing local error state and calls the callback. `PuzzleBoardPanel` then:

1. marks the current reference unavailable;
2. disables Peek/Reference controls; and
3. asks the route to clear the active reference mode.

Image failure is one of the deliberate lifecycle-like cleanup cases: clear both Hold and Toggle while the session is still active.

This is intentionally not a preload service, retry system, or generalized asset-health layer. A later puzzle/reference URL gets a fresh attempt.

## Component contracts

### `PuzzleToolbar.svelte`

Keep the current concrete button structure. Add only:

```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

Retain `hasReference` to decide whether reference actions exist at all.

The existing `onReferenceDown` / `onReferenceUp` callbacks remain for Peek. Add the shared `aria-describedby` help text, but no visible toolbar paragraph.

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

### Puzzle route

The route:

- removes `showReferenceOverlay`;
- derives `referenceActive` / `referenceToggled` from the session snapshot;
- keeps pointer/keyboard Hold bookkeeping;
- keeps two small cleanup intents distinct: **end Hold only** vs **clear any active reference**;
- extends Mission Setup's existing visible help text.

## Accessibility and keyboard behavior

- Peek and Reference remain native `<button type="button">` controls.
- Peek keeps explicit Space/Enter press-and-release behavior because its semantics are hold-based.
- Reference uses native button activation and exposes persistent state with `aria-pressed`.
- Hint, Peek, and Reference share concise `aria-describedby` scoring guidance.
- Disabled reference controls use native `disabled`.
- Existing toolbar focus styles continue to apply.
- Escape-to-cancel and roving toolbar/grid navigation remain HPA-223 work.

## Testing strategy

Use the existing pure session tests, Vitest Browser Mode tests, and the already-existing HPA-217 mobile toolbar smoke test. Do not add a new Playwright project or new geometry suite.

### Session tests

Prove:

- Hold and Toggle leave a timed run `standard_timed` while Hint changes it to `assisted_timed`; this is a contract regression and should already pass before production changes.
- First completion clears `activeReferenceMode`.
- Undo followed by Toggle followed by redo-to-completed also clears `activeReferenceMode`.

The redo case is required because redo enters completed lifecycle directly through `transitionToInternal()`.

### Toolbar tests

Prove:

- Peek retains pointer and Space/Enter Hold callbacks.
- persistent Reference calls its callback and exposes `aria-pressed`.
- Peek is disabled while Toggle is active.
- both controls are disabled when a declared reference is unavailable;
- controls are absent when the puzzle has no reference;
- Hint/Peek/Reference point at the shared concise assistance description;
- HPA-217 `MORE` behavior remains unchanged.

### Overlay / board-panel tests

Prove:

- image error calls `onUnavailable`;
- board-panel failure state disables reference actions;
- a new reference URL resets failure state.

### Route tests

Prove:

- Toggle opens the overlay until toggled off;
- Toggle survives `window.blur`;
- Hold still ends on pointer/key release and blur;
- navigation clears a toggled reference;
- explicit pause clears a toggled reference;
- image failure clears the active session mode through the board callback path;
- the Peek activation path still checkpoints persisted activity/counter state;
- Mission Setup contains the concise visible scoring explanation.

### Existing mobile toolbar smoke test

Update `apps/web/e2e/gameplay-mobile-tap.spec.ts` rather than creating a new spec:

- replace the old single `Reference` query with `Hold to peek reference` and `Toggle reference`;
- assert both primary controls are visible at 390 × 844;
- keep the existing toolbar-width, 44 px target, secondary-panel, document-overflow, and main-overflow assertions;
- run the existing spec in Chromium desktop and mobile during final verification.

This is the geometry proof HPA-217 already paid for and protects the new fifth primary action from regressing compact layout.

## File boundaries

### Production

- `apps/web/src/lib/services/gameplay/session/session.ts`
  - clear runtime reference mode whenever lifecycle enters `completed`.
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
  - derive active/toggled presentation from `sessionState.activeReferenceMode`;
  - add Toggle handler;
  - separate Hold-only blur/release cleanup from all-mode lifecycle cleanup;
  - preserve Peek-down checkpointing;
  - remove `showReferenceOverlay`;
  - extend Mission Setup's existing visible help copy.
- `apps/web/src/lib/components/PuzzleToolbar.svelte`
  - label Hold as Peek;
  - add persistent Reference button;
  - expose availability/pressed state;
  - add shared screen-reader scoring description without a visible paragraph.
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
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`

### Explicitly unchanged

- persisted session schema/version;
- API and completion contracts;
- local statistics format;
- gameplay preferences schema;
- inventory and board placement logic;
- Playwright projects/fixtures;
- dependencies and global design tokens.

## Implementation risks and verification fences

### 1. Missing a completed-lifecycle entry

**Risk:** clearing only inside `handleBoardCompletion()` misses redo-to-completed and can leave the canonical overlay active over the completion dialog.

**Fence:** clear `activeReferenceMode` inside `transitionToInternal()` when `to === 'completed'`, and keep an explicit redo completion test.

### 2. Treating blur like pause

**Risk:** an all-mode cleanup helper on `window.blur` makes the persistent Toggle non-persistent across tab/app focus changes.

**Fence:** blur ends Hold only; pause/restart/navigation/image failure clear any active mode.

### 3. Compact toolbar regression

**Risk:** Peek + REF add a fifth primary control; permanent help text would add even more height and can regress the 390 × 844 toolbar budget.

**Fence:** no visible toolbar paragraph; update and run the existing mobile toolbar smoke geometry test.

### 4. Losing persisted activation evidence

**Risk:** removing route-local overlay state while refactoring Hold can accidentally drop the existing `checkpointSession()` after activation, so `referenceActivations` / `hasUserActivity` may lag until another checkpoint.

**Fence:** keep `checkpointSession()` on Peek-down and Toggle-on; add/retain route assertions around the saved snapshot where practical.

## Acceptance mapping

- **Hold to Peek continues to work:** existing Hold path retained, renamed clearly, and activation checkpoint preserved.
- **Toggle stays open until off:** `activeReferenceMode === 'toggle'` drives overlay + pressed state and survives blur.
- **Lifecycle cleanup:** route cleanup handles pause/restart/navigation/image failure; the session transition primitive clears every completed entry.
- **Hint assisted, reference informational:** existing result-class implementation plus focused contract regression.
- **Clear assistance labeling:** visible Mission Setup help plus shared screen-reader toolbar guidance, with no permanent toolbar-height cost.
- **Missing/failed images safe:** absent controls when no reference; disabled controls and active-mode cleanup on URL/image failure.
- **Pointer and keyboard:** native Toggle activation plus retained Hold keyboard handlers.
- **Responsive toolbar remains safe:** existing HPA-217 browser geometry smoke test is updated and rerun.
- **Focused scope:** existing unit/browser/E2E files only; no new framework or browser project.

## YAGNI checkpoint

HPA-222 should stop once Peek + one persistent Toggle work reliably, scoring is explained through existing surfaces, and the existing mobile toolbar geometry remains healthy. Ghost modes, opacity, reference preferences, generalized asset retries, assistance menus, and additional accessibility-navigation infrastructure remain deferred until a concrete product need appears.
