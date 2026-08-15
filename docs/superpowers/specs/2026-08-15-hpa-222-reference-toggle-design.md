# HPA-222: Persistent Reference Toggle — Design

**Linear:** HPA-222  
**Status:** Design for implementation  
**Date:** 2026-08-15

## Context

HPA-222 is the next actionable child of HPA-215. HPA-557 already split the puzzle route into concrete board, toolbar, inventory, and dialog components, and HPA-217 established the current responsive toolbar.

The current code already contains almost all domain support this ticket needs:

- `PuzzleSessionState.activeReferenceMode` is runtime-only and already represents active reference presentation.
- `ReferenceMode` already includes `hold` and `toggle`.
- `set_reference_mode` already counts an activation only when moving from inactive to active.
- Hold and Toggle are informational for result classification; Hint is assisted.
- placement history snapshots exclude `activeReferenceMode`, so undo/redo cannot restore an old reference mode from history.
- persisted session serialization excludes `activeReferenceMode`, so reload never restores an open reference.
- `ReferenceOverlay.svelte` already shows `Reference image unavailable` for a null or failed image and retries on a later activation.

The main architectural gap is the route-local `showReferenceOverlay` boolean. It duplicates `PuzzleSession.activeReferenceMode`. HPA-222 should delete that duplicate and make the existing session field canonical.

## Product constraints

HPA-222 explicitly requires both interactions:

1. preserve the existing **Hold to Peek** behavior;
2. add one persistent **Reference** toggle.

The implementation should simplify around that requirement rather than inventing a generic assistance system.

At 390 px, adding Peek as another always-visible compact-toolbar action would permanently consume more board height. HPA-222 therefore keeps only the persistent `REF` action in the compact primary row and places `PEEK` in the existing `MORE` surface on compact layouts. On desktop, the same secondary container is visible inline, so Peek remains directly available without a second responsive markup tree.

## Goals

1. Keep Hold-to-Peek with pointer and keyboard press/release semantics.
2. Add one persistent Reference toggle that stays active until toggled off or gameplay leaves the active lifecycle.
3. Make `PuzzleSession.activeReferenceMode` the only reference-presentation state.
4. Clear active reference mode inside the session engine whenever gameplay leaves `active`.
5. Preserve current scoring and activation-counter behavior.
6. Keep the compact primary toolbar at its current action count by moving Peek behind `MORE` only on compact layouts.
7. Disable reference actions when the puzzle declares a reference but no reference URL exists.
8. Keep transient image-load failures retryable through the existing overlay error presentation rather than creating a second failure-state subsystem.
9. Explain the scoring distinction using existing setup/help and screen-reader-description surfaces.

## Non-goals

- Ghost Reference UI or opacity controls.
- Aligning a reference image behind the board.
- Progressive hint tiers or an assistance-mode menu.
- New result classes, analytics events, or preference persistence.
- A generic lifecycle-cleanup abstraction.
- A reference preload/retry service.
- A duplicated panel-level image failure state.
- A new Playwright project, fixture family, screenshot suite, or browser matrix.
- Fixing HPA-217's pre-existing production-font versus E2E-font geometry mismatch.
- Backward compatibility for pre-release UI behavior.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Active reference state | `PuzzleSessionState.activeReferenceMode` | Reuse as canonical state |
| Hold/Toggle actions | `set_reference_mode` | Reuse unchanged |
| Activation counter | `SessionCounters.referenceActivations` | Reuse unchanged |
| Result classification | `recomputeResultClass()` | Reuse unchanged |
| Undo/redo history | `PlacementHistoryState` excludes reference mode | Keep unchanged; history cannot resurrect reference UI |
| Persistence | serializer excludes runtime reference mode | Keep unchanged; no schema/version work |
| Lifecycle transition | `transitionToInternal()` | Clear reference for every non-active target |
| Restart | `doRestart()` replaces state with `freshState()` | Already clears reference by construction |
| Hold DOM bookkeeping | route `referencePointerId` / `referenceHoldSource` | Keep route-local |
| Full-image UI | `ReferenceOverlay.svelte` | Reuse unchanged |
| Missing URL | `referenceImageUrl` already available to board panel | Use as a simple disabled condition |
| Failed image | existing overlay unavailable message | Reuse; do not permanently disable after a transient load error |
| Responsive toolbar | existing primary + `MORE` / secondary container | Put REF primary; Peek secondary |
| Scoring help | `MissionSetupDialog.inputHelp` + existing `aria-describedby` pattern | Extend existing surfaces |

No new service, store, schema, controller, asset-health state, package, or generic UI abstraction is justified.

## Options considered

### Option A — Use `activeReferenceMode` as the single source of truth (selected)

Delete `showReferenceOverlay`. Derive overlay visibility and persistent pressed state from the session snapshot. Keep only pointer/keyboard Hold bookkeeping outside the session.

**Pros**

- removes duplicate state;
- reuses the domain contract already present;
- no persistence migration;
- one engine lifecycle rule replaces route ordering constraints;
- undo/redo history cannot resurrect the runtime mode because it is not part of history snapshots.

**Cons**

- the route still needs DOM bookkeeping for Hold because pointer ids and keyboard press/release are presentation details.

### Option B — Keep `showReferenceOverlay` and add another toggle boolean

**Rejected:** this creates three representations of the same interaction: overlay boolean, toggle boolean, and session mode.

### Option C — Add an assistance controller/menu

**Rejected:** two concrete reference interactions and one Hint action do not justify another abstraction.

### Option D — Drop Peek and ship only Toggle

This is the smallest implementation technically, but it conflicts with HPA-222's explicit scope and acceptance criteria requiring Hold-to-Peek to remain. Do not silently change that product requirement in this design.

## State ownership

The route derives:

```ts
const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
const referenceActive = $derived(activeReferenceMode !== null);
const referenceToggled = $derived(activeReferenceMode === 'toggle');
```

The route retains only DOM Hold bookkeeping:

```ts
let referencePointerId = $state<number | null>(null);
let referenceHoldSource = $state<'pointer' | 'keyboard' | null>(null);
```

There is no `showReferenceOverlay`, `referenceToggled` state variable, persisted reference mode, or panel-level reference failure state.

## Session lifecycle cleanup

Reference presentation is meaningful only during active gameplay. Put that invariant in the existing lifecycle primitive:

```ts
function transitionToInternal(to: SessionLifecycle) {
	const from = state.lifecycle;
	if (to !== 'active') state.activeReferenceMode = null;
	state.lifecycle = to;
	emit({ type: 'lifecycle', from, to });
}
```

This covers explicit pause, first completion, retained-seal recompletion, redo restoring a completed board, and disposal.

Restart does not call `transitionToInternal('setup')`; it replaces the state with `freshState()`, whose `activeReferenceMode` is already null. No route cleanup is needed for restart correctness.

This is preferable to requiring the route to dispatch `set_reference_mode: null` before pause. The engine owns the invariant and there is no ordering footgun.

## Hold-to-Peek interaction

`handleReferenceDown()` no-ops if persistent Toggle is already active, stores pointer/keyboard bookkeeping, dispatches `mode: 'hold'`, and keeps the existing `checkpointSession()` call because entering reference mode persists activation/activity evidence.

Use one Hold-only route helper:

```ts
function clearReferenceHold(): void {
	const shouldClearMode = sessionState?.activeReferenceMode === 'hold';
	referencePointerId = null;
	referenceHoldSource = null;
	if (shouldClearMode) sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
}
```

`handleReferenceUp()` validates pointer source/id then delegates to this helper. Global matching pointer-up delegates to `handleReferenceUp(event)`. Window blur calls `clearReferenceHold()`: Hold ends, persistent Toggle survives.

`clearTransientGameplayState()` no longer owns reference cleanup.

## Persistent Reference toggle

```ts
function handleReferenceToggle(): void {
	if (!sessionStore || sessionState?.lifecycle !== 'active') return;
	const wasInactive = sessionState.activeReferenceMode === null;
	const nextMode = sessionState.activeReferenceMode === 'toggle' ? null : 'toggle';
	referencePointerId = null;
	referenceHoldSource = null;
	sessionStore.dispatch({ type: 'set_reference_mode', mode: nextMode });
	if (wasInactive && nextMode === 'toggle') checkpointSession();
}
```

Supported transitions:

```text
null   -> toggle   counts one activation and checkpoints
toggle -> null     closes persistent reference
hold   -> toggle   switches mode without double-counting
```

The third transition matters for multi-pointer input. Clearing Hold bookkeeping in the Toggle handler prevents the later stale release from affecting Toggle.

Peek is disabled while Toggle is already active because another Hold is redundant.

## Toolbar layout

Keep one markup tree and the HPA-217 responsive container behavior.

### Desktop

The secondary container is inline, so Peek remains directly visible alongside the other actions.

### Compact (<1024 px)

Permanent primary actions stay:

- Undo;
- Redo;
- Hint;
- REF;
- MORE.

Peek moves into the existing secondary container and appears after `MORE` opens. HPA-222 therefore does not increase the compact primary action count.

Do not claim production is single-row at 390 px. The existing E2E harness stubs Google Fonts and does not reproduce production Orbitron metrics exactly; that is pre-existing HPA-217 test debt outside this ticket.

## Toolbar contracts

`PuzzleToolbar.svelte` adds:

```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

Persistent REF is primary with `aria-pressed`, native `disabled`, and `aria-describedby="assistance-scoring-help"`.

Peek keeps existing Hold handlers, moves into the secondary container, uses `aria-label="Hold to peek reference"`, and disables with:

```svelte
disabled={!referenceAvailable || referenceToggled}
```

Hint, Peek, and REF share one screen-reader-only scoring description. No action registry or separate mobile markup.

## Reference availability

### No declared reference

If `puzzle.hasReference !== true`, render neither Peek nor REF.

### Declared reference, null URL

This is deterministic unavailability. Keep both controls present but disabled:

```ts
const referenceAvailable = $derived(
	puzzle.hasReference === true && referenceImageUrl !== null
);
```

### URL exists but image load fails

Do not add `onUnavailable`, `referenceLoadFailed`, keyed `$effect`, or route cleanup.

`ReferenceOverlay.svelte` already renders `Reference image unavailable`. Release Peek or toggle REF off and a later activation retries using its existing local reset behavior. This is preferable to turning a transient network error into permanent silent disablement.

## Assistance/scoring copy

Do not add a visible toolbar paragraph.

Extend Mission Setup help:

> Choose your mode and rotation settings before starting. Hint affects timed results; Peek and Reference do not.

Add one shared `sr-only` toolbar description with the same scoring sentence and attach Hint, Peek, and REF using `aria-describedby`.

## Component boundaries

### `PuzzleToolbar.svelte`
- add persistent REF callback/state;
- rename existing Hold to Peek;
- place Peek in secondary container;
- add shared scoring description.

### `PuzzleBoardPanel.svelte`
- receive `referenceToggled` / `onReferenceToggle`;
- derive `referenceAvailable` from declared reference + URL only;
- keep `ReferenceOverlay` unchanged.

### Puzzle route
- delete `showReferenceOverlay`;
- derive active/toggled state from `PuzzleSession`;
- keep Hold DOM bookkeeping + one Hold-only helper;
- add Toggle handler;
- remove route lifecycle reference cleanup;
- reset Hold bookkeeping during route reuse;
- extend Mission Setup help.

### `PuzzleSession`
- clear reference mode for every non-active lifecycle target.

## Testing strategy

### Session
Reuse current reference-mode tests. Add only pause, first-completion, and redo-to-completed cleanup tests.

### Toolbar/panel
Test REF callback/pressed state, retained Hold semantics, Peek-disabled-while-toggled, missing declared URL disabled state, no-reference absence, scoring `aria-describedby`, and Peek placement in secondary container.

### Route
Test persistent toggle, Toggle-survives-blur, Hold-ends-on-blur, Hold -> Toggle stale-release safety, pause cleanup via engine state, and navigation reset.

### Existing mobile smoke
Update `gameplay-mobile-tap.spec.ts` in the same atomic feature task:

- old `Reference` locator -> `Toggle reference`;
- Peek hidden before `MORE`, visible after;
- >=44 px check loops across visible primary controls;
- existing width/overflow/secondary/inventory fold-fit/density assertions remain.

Run this smoke immediately after the UI/route slice, not only during final verification.

Do not add a single-row/fixed-height assertion because the font-stubbed test environment would encode a false production guarantee.

## File boundaries

### Production
- `apps/web/src/lib/services/gameplay/session/session.ts`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/lib/components/PuzzleToolbar.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`

### Tests
- `apps/web/src/lib/services/gameplay/session/session.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`

### Explicitly unchanged
- `ReferenceOverlay.svelte` and tests;
- persisted session schema/version;
- API/shared completion contracts;
- preferences/analytics/dependencies;
- Playwright projects/fixtures/font stubbing;
- HPA-223 work.

## Risk fences

1. Engine owns all non-active cleanup; no route ordering dependency.
2. Reference mode stays outside history, so undo/redo cannot restore stale reference UI.
3. Hold -> Toggle cannot double-count and stale Hold release cannot close Toggle.
4. Hold-down and inactive -> Toggle still checkpoint activation evidence.
5. Peek is secondary on compact layouts, so HPA-222 does not add a permanent primary action.
6. Transient load errors remain visible/retryable rather than permanently disabling controls.
7. Toolbar props/names and all direct callers/tests land atomically so no committed intermediate state knowingly fails `check`.

## Acceptance mapping

- **Hold to Peek:** retained; direct desktop, under `MORE` compact.
- **Persistent Toggle:** canonical `activeReferenceMode === 'toggle'` drives overlay/pressed state.
- **Lifecycle cleanup:** engine clears on non-active transition; restart fresh state is null.
- **Scoring:** existing result-class logic/tests remain authoritative.
- **Missing URL:** controls disabled.
- **Transient load failure:** existing unavailable message + later retry.
- **Pointer/keyboard:** native Toggle + retained Hold handlers.
- **Focused verification:** existing unit/browser/mobile smoke only.

## Review-resolution notes

The latest review was correct that the previous draft overpaid for image failure, split lifecycle ownership between route and engine, and left a known broken intermediate toolbar contract. Those are fixed here. The review's suggestion to delete Peek was not adopted because current Linear scope explicitly requires it; the lower-cost compromise is to keep Peek in the existing secondary container on compact layouts. The suggested single-row E2E assertion was also not adopted because production already differs from the font-stubbed harness; the structural primary-action-count rule is truthful and the existing fold/overflow checks remain the rendered gate.

## YAGNI checkpoint

Stop once Peek + one persistent Toggle work reliably with the existing session mode. Do not add Ghost UI, opacity, reference preferences, image-health state, generalized retries, assistance controllers, or new responsive/testing infrastructure until a demonstrated need exists.
