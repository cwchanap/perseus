# HPA-221 Mission Session Controls Design

## Status

Approved for planning on 2026-08-03.

## Objective

Add a concise mission setup experience, deliberate resume, explicit pause, safe restart and exit, and Relaxed mode presentation without introducing a second session controller or expanding the persistence architecture.

The implementation consumes the existing `PuzzleSession` domain introduced by HPA-372. `PuzzleSession` remains the sole owner of lifecycle, mode, timing, run identity, placements, rotation, history, assistance facts, result class, completion sealing, and persisted run state.

## Product decisions

- Setup is one modal surface, never a wizard.
- Fresh runs show setup unless the player previously enabled **Start immediately next time**.
- Returning active or paused runs show a dominant one-action Resume surface.
- Setup can be reopened after immediate start until the first meaningful gameplay action.
- Pause blocks all puzzle interactions and clears transient interaction state.
- Restart returns to setup with the previous mode and rotation choices, but creates a fresh run and clears progress.
- Exit saves a resumable run by default; discard is explicit.
- Relaxed runs use the existing `relaxed` result class and versioned completion API. They may count as completions but never update a canonical timed best.
- HPA-221 adds only the toolbar props it needs. It does not implement HPA-217's generic toolbar architecture.

## Existing foundation

The current code already provides:

- lifecycle values `setup`, `active`, `paused`, `completed`, and `disposed`;
- session modes `timed` and `relaxed`;
- persisted elapsed active time and hidden-tab exclusion;
- bounded result classes and timing quality;
- pause, resume, restart, and completion transitions;
- fresh run IDs on restart;
- gameplay gating outside the active lifecycle;
- local and server completion effects projected from an immutable completion seal;
- deterministic gameplay fixtures, seeded persistence, controlled clocks, and reusable Playwright helpers.

The puzzle route currently auto-starts fresh and restored setup sessions, so the existing setup lifecycle is not visible to the player. It also lacks pause, resume, restart, and exit surfaces and always renders timed HUD/completion content.

## Scope

### Included

- Mission setup modal with puzzle facts, Timed/Relaxed selection, rotation selection, contextual input help, Start, and Start Immediately preference.
- Resume surface for restored active or paused sessions.
- Explicit pause and resume.
- Restart confirmation after meaningful activity.
- Return-to-Arcade save/discard flow.
- Relaxed-mode HUD and completion presentation.
- Focus trapping, predictable Escape behavior, focus restoration, and responsive layout.
- Feature-owned unit, component/route, and representative E2E coverage.

### Excluded

- A second lifecycle state machine or session UX store.
- Cloud-synced preferences or active sessions.
- A generic application settings registry.
- Persisted modal, focus, pointer, drag, or gesture state.
- A new completion endpoint or D1 migration.
- A generalized modal service.
- HPA-217's toolbar grouping, slots, overflow system, or visual redesign.
- HPA-224's complete result report redesign.
- New analytics events unless required by the already-approved analytics contract.

## Architecture

### Ownership boundaries

`PuzzleSession` owns canonical run state and transition invariants.

The puzzle route owns orchestration and external effects:

- load and save device preferences;
- choose which dialog is visible;
- map UI actions to `PuzzleSession` actions;
- clear route-owned transient interactions;
- checkpoint before exit or teardown;
- navigate back to the Arcade.

Dialog visibility, setup drafts, focus state, gesture state, hint highlights, rejection animation, and reference overlay visibility remain transient and are not serialized.

### No additional controller

HPA-221 must not add a coordinator store that mirrors lifecycle, mode, or progress. Route-derived values come directly from `sessionState`. Transient dialog state may use local Svelte state because it has no independent domain behavior and is intentionally discarded on reload.

## Domain changes

Only two new actions are required.

```ts
export type PuzzleSessionAction =
  | {
      type: 'configure_setup';
      mode: SessionMode;
      rotationEnabled: boolean;
    }
  | { type: 'reopen_setup' }
  // existing actions...
```

### `configure_setup`

Valid only while lifecycle is `setup`.

It atomically applies the choices for the current run:

- sets `mode`;
- sets `elapsedActiveSeconds` to `0` for Timed and `null` for Relaxed;
- leaves `timerStarted` false;
- sets `rotationEnabled`;
- generates per-piece rotations when rotation is enabled;
- clears per-piece rotations when rotation is disabled;
- sets `facts.rotationUsed` from the setup choice;
- recomputes `resultClass`;
- keeps `hasUserActivity` false.

Repeated configuration while setup is open is allowed. Setup choices are not meaningful gameplay activity.

### `reopen_setup`

Valid only from `active` when `hasUserActivity` is false.

It:

- stops the clock defensively;
- transitions to `setup`;
- preserves the current run ID, mode, rotation choice, tray order, and other fresh-run state.

It does not act as restart and does not create another run ID.

### Restart adjustment

The existing `restart` action continues to:

- create a fresh run ID;
- clear placements, elapsed time, timer-start state, history, counters, assistance facts, completion state, and selection;
- regenerate the canonical tray order;
- return lifecycle to `setup`.

It additionally retains the previous mode and rotation choice. If rotation remains enabled, restart generates a new rotation mapping for the new run rather than preserving the previous pieces' rotations.

No persisted-session schema version change is required. Lifecycle, mode, rotation, run ID, elapsed time, result class, and progress are already represented.

## Device preferences

Add a small versioned local-storage codec, separate from run persistence.

```ts
interface GameplayPreferencesV1 {
  version: 1;
  mode: 'timed' | 'relaxed';
  rotationEnabled: boolean;
  startImmediately: boolean;
}
```

Recommended key:

```text
perseus-gameplay-preferences-v1
```

Default values are:

- mode: `timed`;
- rotation: disabled;
- start immediately: disabled.

The module exposes synchronous validated read and safe write functions. Malformed data, unavailable storage, or write failures fall back silently to defaults or leave gameplay running. This feature does not need a Svelte store, migration registry, account synchronization, or preference service.

Persist the selected mode and rotation when the player starts a run. Persist `startImmediately` with the same write.

## Entry flows

### Fresh session

1. Create the fresh `PuzzleSession` in `setup`.
2. Read device preferences.
3. Dispatch `configure_setup` with the preferred mode and rotation.
4. If `startImmediately` is false, open Mission Setup.
5. If `startImmediately` is true, dispatch `start` immediately.
6. Until `hasUserActivity` becomes true, expose an Open Setup toolbar action.

### Restored setup session

Show Mission Setup using the persisted run's mode and rotation choices. Device preferences do not overwrite an existing run.

### Restored active session

Normalize the restored snapshot's lifecycle to `paused` before constructing the session store. This avoids briefly starting the restored timer before the Resume surface appears.

Show the Resume surface with:

- Resume as the primary action;
- Restart / Change Settings as a secondary action;
- Return to Arcade as a secondary action.

### Restored paused session

Show the same Resume surface without changing the canonical run state.

### Restored completed session

Preserve the existing completion flow. HPA-221 only changes Relaxed-specific labels and timed-stat visibility.

## Mission Setup surface

The modal contains:

- puzzle name;
- piece count and grid dimensions;
- Timed and Relaxed mode choice;
- rotation toggle with a concise explanation that it locks after the first successful placement;
- input-specific help based on coarse pointer/touch capability;
- Start Immediately Next Time checkbox;
- primary Start action.

The route keeps a local setup draft. Pressing Start dispatches `configure_setup` once with the final draft, saves device preferences, dispatches `start`, and closes the modal.

When setup represents an existing restarted run, previous run choices are preselected.

Escape behavior:

- Fresh mandatory setup does not dismiss with Escape because no playable state exists behind it.
- Reopened optional setup may dismiss with Escape, returning to the unchanged active pre-activity run.

## Pause and resume

Add one route helper:

```ts
function clearTransientGameplayState(): void
```

It clears:

- active reference mode before leaving `active`;
- reference overlay and pointer ownership;
- selected piece;
- active hint target and timeout;
- rejected-piece animation and timeout;
- pan/drag/pointer gesture state.

Explicit pause runs in this order:

1. clear transient gameplay state;
2. dispatch `pause`;
3. open the Pause dialog;
4. checkpoint the paused session.

The page behind setup, resume, pause, and exit dialogs is inert. This blocks route-owned zoom, pan, toolbar, board, and inventory interactions in addition to the engine's lifecycle gating.

Resume dispatches `resume`, closes the dialog, and restores focus to the Pause trigger when possible. Transient selection, references, hints, and gestures are intentionally not restored.

Document visibility continues to call only `setDocumentHidden(document.hidden)`. Hidden tabs suspend active timing and checkpoint, but do not open a modal or change lifecycle to `paused`.

## Restart

Restart uses `sessionState.hasUserActivity` as the single meaningful-progress test.

- Before meaningful activity: restart proceeds without confirmation.
- After meaningful activity: show one destructive confirmation.

On confirmation:

1. clear transient gameplay state;
2. clear any completion presentation for the old run;
3. dispatch `restart`;
4. persist the new setup-state snapshot immediately;
5. open Mission Setup with retained mode and rotation choices;
6. reset the viewport using existing route behavior.

Restart does not clear device preferences.

## Return to Arcade

Replace direct navigation from the gameplay header and pause surface with one route handler.

When the current run is resumable, show:

- **Save & Exit** as the primary action;
- **Discard & Exit** as an explicit destructive action;
- Cancel.

Save & Exit checkpoints time and persistence before navigation.

Discard & Exit clears the persisted session for the puzzle before navigation. It does not clear gameplay preferences or local completion statistics.

When the run has no resumable progress, navigate directly after a final checkpoint.

## Relaxed mode

Relaxed mode reuses the existing session and completion contracts.

- `mode` is `relaxed`.
- `elapsedActiveSeconds` remains `null`.
- `resultClass` is `relaxed`.
- Timed local-best logic remains inapplicable.
- Versioned server completion submission proceeds through the existing sealed-completion effect path.
- The server may count the completion but cannot update the canonical standard timed best.

Presentation rules:

- Setup explains that Relaxed has no timer or timed personal best.
- HUD shows a `RELAXED` mode status instead of elapsed/best time.
- Pause and Resume identify Relaxed mode.
- Completion hides final-time and timed-personal-best content.
- The existing hard-coded timed rank is replaced only for Relaxed with a neutral completion label.

HPA-224 remains responsible for replacing the complete rank/report system for all result classes.

## Toolbar integration

Until HPA-217 is implemented, extend `PuzzleToolbar` with explicit HPA-221 props only:

```ts
onPause: () => void;
onOpenSetup: () => void;
canOpenSetup: boolean;
sessionMode: SessionMode;
```

Do not introduce toolbar slots, command registries, action descriptors, overflow infrastructure, or new visual primitives in this ticket.

The Open Setup action is enabled only while lifecycle is `active` and `hasUserActivity` is false. The Pause action is enabled only while lifecycle is `active`.

## Dialog implementation and accessibility

Add focused components for the three distinct surfaces:

- `MissionSetupDialog.svelte`;
- `SessionPauseDialog.svelte`, also used for restored Resume state;
- `ExitSessionDialog.svelte`.

Extract the existing route-local focus trap into a small reusable Svelte action used by setup, pause/resume, exit, and the existing completion dialog. This is a focus utility, not a modal service.

Required behavior:

- `role="dialog"` and `aria-modal="true"`;
- labelled title and concise description;
- initial focus on the dominant action or first setup control;
- Tab and Shift+Tab containment while modal;
- explicit Escape behavior per surface;
- predictable focus restoration;
- destructive actions named clearly;
- no information conveyed by color alone;
- usable at 390 x 844, tablet, and desktop viewports;
- content remains scrollable within safe-area-aware bounds when browser chrome, orientation, or virtual keyboard reduces available height.

## Error handling

- Preference read/write failure does not block setup or play.
- Session persistence failure continues using the existing resilient adapter behavior.
- Restart's existing run-ID and tray-order validation remains authoritative.
- Navigation occurs only after the route attempts the final checkpoint.
- A failed discard clear does not pretend that progress was removed; stay on the dialog and surface a concise retryable error.
- Completion effect handling is unchanged.

## Testing

### Session unit tests

Cover:

- setup configuration for Timed and Relaxed;
- rotation enable/disable while in setup;
- configuration rejected outside setup;
- reopen setup before activity;
- reopen rejected after activity;
- restart retains mode and rotation choice but creates a new run ID and rotation mapping;
- no schema-version change or persistence regression.

### Preference unit tests

Cover:

- defaults when missing;
- valid round-trip;
- malformed version/value fallback;
- storage read and write exceptions.

### Route/component tests

Cover:

- fresh mandatory setup;
- Start Immediately behavior and pre-activity setup reopening;
- restored active/paused Resume surface;
- pause cleanup and interaction blocking;
- restart confirmation threshold;
- Save & Exit and Discard & Exit;
- Relaxed HUD and completion presentation;
- modal Escape and focus restoration rules;
- rotation lock explanation.

### Representative E2E tests

Use the existing deterministic gameplay fixture and helpers.

1. Fresh Timed run: setup, first meaningful action starts time, explicit pause excludes elapsed time, resume continues.
2. Relaxed run: setup, completion, no timed HUD/best presentation, and completion request uses `relaxed`.
3. Seeded active run: Resume surface, restart confirmation, fresh run ID, cleared progress, retained setup choices.
4. Mobile 390 x 844: setup, pause, restart, exit, focus, and safe-area reachability.

Do not create exhaustive E2E permutations for every unit-level transition. Keep the browser suite focused on integrated behavior.

## Delivery sequence

1. Add and test the two bounded session actions and restart retention.
2. Add and test the device preference codec.
3. Stop route auto-start and implement fresh/restored entry flows.
4. Add reusable focus action and setup/resume/pause/exit dialogs.
5. Wire pause cleanup, restart, and save/discard navigation.
6. Add Relaxed HUD and completion presentation.
7. Extend the toolbar with explicit props.
8. Add route/component and representative E2E coverage.
9. Run web tests, type checking, linting, build, Chromium gameplay tests, and the critical WebKit/mobile checks.

## YAGNI guardrails

The implementation must not add:

- another session state machine;
- another canonical store mirroring `PuzzleSession`;
- a modal manager;
- a preference framework;
- persisted UI/transient state;
- a backend schema change;
- a Relaxed-specific completion transport;
- a toolbar plugin system;
- a feature-flag system;
- unrelated route or design-system refactors.

## Acceptance criteria

- Fresh sessions show one concise setup surface unless Start Immediately is already enabled.
- Setup remains reopenable until the first meaningful gameplay action.
- Restored active/paused sessions show a dominant Resume path.
- Timed sessions restore elapsed active time and exclude explicit pause and hidden-tab time.
- Relaxed sessions never render or write a timed personal best.
- Explicit pause prevents all gameplay interactions and clears transient selection/reference/gesture state.
- Restart creates a new run ID, clears run progress, and retains mode and rotation choices.
- Exit saves resumable progress by default and exposes an explicit discard path.
- Rotation choice is explained before play and remains locked after the first successful placement.
- Dialogs remain usable and focus-safe at mobile, tablet, and desktop sizes.
- Feature-owned automated tests cover the integrated flows without duplicating foundation coverage.