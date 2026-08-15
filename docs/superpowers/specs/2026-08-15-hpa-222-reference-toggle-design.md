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

This covers:

- explicit pause (`active -> paused`);
- first completion (`active -> completed`);
- retained-seal recompletion (`active -> completed`);
- redo restoring a completed board (`active -> completed`);
- disposal (`* -> disposed`).

Restart does not call `transitionToInternal('setup')`; it replaces the state with `freshState()`, whose `activeReferenceMode` is already null. No route cleanup is needed for restart correctness.

This is preferable to requiring the route to dispatch `set_reference_mode: null` before pause. The engine owns the invariant and there is no ordering footgun.

## Hold-to-Peek interaction

### Start Hold

`handleReferenceDown()`:

1. no-ops if the persistent Toggle is already active;
2. stores pointer/keyboard Hold bookkeeping;
3. dispatches `set_reference_mode: 'hold'`;
4. immediately calls `checkpointSession()`.

The checkpoint stays because entering reference mode increments `referenceActivations` and sets `hasUserActivity`, both of which are persisted.

### End Hold

Use one route helper for Hold cleanup only:

```ts
function clearReferenceHold(): void {
	const shouldClearMode = sessionState?.activeReferenceMode === 'hold';
	referencePointerId = null;
	referenceHoldSource = null;

	if (shouldClearMode) {
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}
}
```

`handleReferenceUp()` validates the pointer source/id when required, then delegates to `clearReferenceHold()`.

The global matching pointer-up path also delegates to `handleReferenceUp(event)` rather than duplicating cleanup.

Window blur calls `clearReferenceHold()`. Therefore:

- an active Hold ends on blur;
- a persistent Toggle survives ordinary focus loss.

`clearTransientGameplayState()` no longer owns reference cleanup. Pause/restart/completion/disposal are session lifecycle concerns now.

## Persistent Reference toggle

The Toggle handler is deliberately small:

```ts
function handleReferenceToggle(): void {
	if (!sessionStore || sessionState?.lifecycle !== 'active') return;

	const wasInactive = sessionState.activeReferenceMode === null;
	const nextMode = sessionState.activeReferenceMode === 'toggle' ? null : 'toggle';

	referencePointerId = null;
	referenceHoldSource = null;
	sessionStore.dispatch({ type: 'set_reference_mode', mode: nextMode });

	if (wasInactive && nextMode === 'toggle') {
		checkpointSession();
	}
}
```

The explicit transitions are:

```text
null   -> toggle   counts one activation and checkpoints
toggle -> null     closes the persistent reference
hold   -> toggle   switches mode without double-counting
```

The third transition matters for multi-pointer input: a user can hold Peek and activate Reference with another pointer. `doSetReferenceMode()` already avoids double-counting because the previous mode was non-null. Clearing the Hold bookkeeping in the Toggle handler prevents the later stale release from affecting Toggle.

Peek is disabled while Toggle is already active because another Hold would be redundant.

## Toolbar layout

Keep one markup tree and the existing HPA-217 responsive container behavior.

### Desktop

The secondary container is inline, so users see:

- Undo / Redo;
- Hint / REF;
- Peek;
- Zoom / Fit / Rotation;
- Pause / Setup when available.

### Compact (<1024 px)

Keep the primary row's action count unchanged from HPA-217:

- Undo;
- Redo;
- Hint;
- REF;
- MORE.

Put Peek in the existing secondary container with the other `MORE` actions. This preserves Hold-to-Peek without adding a sixth permanent compact control.

Do not claim HPA-222 makes the production toolbar single-row at 390 px. The existing E2E harness stubs Google Fonts and therefore does not reproduce production Orbitron metrics exactly. That is pre-existing HPA-217 test debt, not a reason to expand this ticket.

HPA-222's structural guarantee is narrower and truthful: it does not increase the compact primary action count.

## Toolbar contracts

`PuzzleToolbar.svelte` adds only:

```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

The existing Hold callbacks remain:

```ts
onReferenceDown: (event?: ReferenceHoldEvent) => void;
onReferenceUp: (event?: ReferenceHoldEvent) => void;
```

The persistent button is primary:

```svelte
<button
	type="button"
	aria-label="Toggle reference"
	aria-pressed={referenceToggled ? 'true' : 'false'}
	aria-describedby="assistance-scoring-help"
	disabled={!referenceAvailable}
	onclick={onReferenceToggle}
	class="arcade-btn-ghost toolbar-button"
>
	REF
</button>
```

The Peek button keeps the existing Hold handlers and becomes part of the secondary container. It uses:

```svelte
aria-label="Hold to peek reference"
aria-describedby="assistance-scoring-help"
disabled={!referenceAvailable || referenceToggled}
```

Hint also references the same screen-reader description.

No action registry or separate mobile markup is added.

## Reference availability

There are three cases.

### Puzzle has no reference

If `puzzle.hasReference !== true`, render neither Peek nor Reference. This is current behavior generalized to the two controls.

### Puzzle declares a reference but resolver returns null

This is deterministic unavailability. Keep the controls present but disabled:

```ts
const referenceAvailable = $derived(
	puzzle.hasReference === true && referenceImageUrl !== null
);
```

`PuzzleBoardPanel` can compute this directly because it already receives both values.

### Image URL exists but the image load fails

Do **not** add `onUnavailable`, `referenceLoadFailed`, a keyed `$effect`, or route cleanup.

`ReferenceOverlay.svelte` already renders `Reference image unavailable` when its image fails. Keep that behavior. The user can release Peek or toggle Reference off and try again later; the overlay's existing local `imageError` reset on a later activation provides the retry.

This is simpler and better for transient network failures than permanently disabling controls for the remainder of the session.

## Assistance/scoring copy

Do not add a wrapping paragraph to the compact toolbar.

Extend the existing Mission Setup help to include the visible rule, for example:

> Choose your mode and rotation settings before starting. Hint affects timed results; Peek and Reference do not.

Add one shared screen-reader-only description in `PuzzleToolbar.svelte`:

```svelte
<span id="assistance-scoring-help" class="sr-only">
	Hint affects timed results. Peek and Reference do not.
</span>
```

Attach Hint, Peek, and Reference with `aria-describedby`.

## Component boundaries

### `PuzzleToolbar.svelte`

- keep concrete buttons;
- add persistent REF state/callback;
- rename the existing Hold action to Peek;
- put Peek in the secondary container so compact layouts keep the existing primary count;
- reuse existing `aria-pressed` styling;
- add shared sr-only scoring description.

### `PuzzleBoardPanel.svelte`

- receive `referenceToggled` and `onReferenceToggle`;
- derive `referenceAvailable` only from `puzzle.hasReference` + `referenceImageUrl`;
- pass Toggle/Hold props to the toolbar;
- keep `ReferenceOverlay` unchanged.

### Puzzle route

- remove `showReferenceOverlay`;
- derive active/toggled presentation from `sessionState.activeReferenceMode`;
- add Toggle handler;
- retain Hold bookkeeping and one Hold-only cleanup helper;
- remove reference cleanup from `clearTransientGameplayState()`;
- reset stale Hold bookkeeping during puzzle teardown/reuse;
- extend Mission Setup help text.

### `PuzzleSession`

- clear `activeReferenceMode` for every non-active lifecycle target.

### `ReferenceOverlay.svelte`

Unchanged.

## Testing strategy

### Session tests

Reuse the existing reference-mode tests for:

- Hold is informational;
- Toggle activation counts once;
- Hold -> Toggle does not double-count;
- Ghost remains assisted.

Add only lifecycle coverage that does not already exist:

- Toggle clears on pause;
- Toggle clears on first completion;
- Toggle clears when redo restores completed lifecycle.

### Toolbar / panel tests

Prove:

- REF calls the new callback and exposes `aria-pressed`;
- Peek retains pointer and Space/Enter Hold behavior;
- Peek is disabled while Toggle is active;
- both controls are absent when `hasReference` is false;
- both controls are disabled when a declared reference URL is null;
- shared scoring description is attached to Hint/Peek/Reference;
- Peek remains in the secondary toolbar container.

Do not add overlay failure callback tests because `ReferenceOverlay.svelte` is unchanged.

### Route tests

Prove:

- Toggle opens/closes the overlay from session state;
- Toggle survives window blur;
- Hold still ends on blur;
- Hold -> Toggle keeps the Toggle active after the original Hold release;
- pause clears Toggle through the session lifecycle rule;
- navigation cannot carry reference presentation or Hold bookkeeping into the next puzzle.

### Existing mobile smoke

Update `apps/web/e2e/gameplay-mobile-tap.spec.ts` in the same change as the accessible-name/layout edit:

- replace the old single `Reference` locator with `Toggle reference`;
- verify `Hold to peek reference` is hidden before `MORE` and visible after `MORE` opens;
- loop the existing >=44 px target check across the visible compact primary controls;
- keep the existing toolbar width, document overflow, secondary-panel actionability, inventory fold-fit, and inventory-row assertions.

Run this smoke immediately after the toolbar/route slice, not only at final verification.

Do not add a single-row or fixed-pixel-height assertion: production already differs from the font-stubbed E2E harness, so such an assertion would encode a false production guarantee. Keeping Peek out of the compact primary row avoids creating the regression structurally.

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

- `ReferenceOverlay.svelte` and its tests;
- persisted session schema/version;
- API/shared completion contracts;
- local statistics format;
- gameplay preferences;
- inventory and placement logic;
- Playwright projects/fixtures/support font stubbing;
- dependencies and global design tokens.

## Risk fences

1. **Lifecycle invariant:** engine clears reference mode for all non-active transitions; no route ordering dependency.
2. **History:** reference mode remains outside placement history, so undo/redo never restores an old mode.
3. **Hold -> Toggle:** stale Hold release cannot turn off Toggle and does not double-count activation.
4. **Persistence:** Hold-down and inactive -> Toggle activation still checkpoint immediately.
5. **Compact layout:** Peek is secondary on compact layouts, so HPA-222 does not add a permanent primary action.
6. **Image failure:** transient image load errors remain visible and retryable instead of becoming permanent silent disablement.
7. **Task atomicity:** the toolbar prop/name change and every direct caller/test update land in one task so intermediate commits pass `check`.

## Acceptance mapping

- **Hold to Peek continues to work:** existing Hold path retained; Peek is direct on desktop and under `MORE` on compact.
- **Toggle stays open until off:** `activeReferenceMode === 'toggle'` drives overlay and pressed state.
- **Lifecycle cleanup:** session clears reference whenever lifecycle leaves active; restart creates fresh null state.
- **Hint assisted, reference informational:** existing result-class implementation/tests remain authoritative.
- **Missing reference safe:** absent controls when no reference; disabled controls when declared URL is null.
- **Transient failed load safe:** existing overlay shows unavailable and allows a later retry.
- **Pointer and keyboard:** native Toggle + retained Hold handlers.
- **Focused tests:** existing unit/browser/mobile smoke files only.

## YAGNI checkpoint

Stop once Peek + one persistent Toggle are reliable using the existing session mode. Do not add Ghost UI, opacity, reference preferences, image-health state, generalized retries, assistance controllers, or new responsive/testing infrastructure until there is a demonstrated need.
