# HPA-221 Mission Session Controls Design

## Status

Revised after YAGNI design review on 2026-08-03.

## Objective

Add concise mission setup, deliberate resume, explicit pause, safe restart and exit, and Relaxed mode presentation without creating a second session controller or expanding persistence architecture.

The implementation consumes the existing `PuzzleSession` domain from HPA-372. `PuzzleSession` remains the sole owner of lifecycle, mode, timing, run identity, placements, rotation, history, assistance facts, result class, completion sealing, and persisted run state.

## Product decisions

- Setup is one modal surface, never a wizard.
- Fresh runs show setup unless the player enabled **Start immediately next time**.
- Start Immediately and pre-activity setup reopening remain in v1 because HPA-221 explicitly requires both.
- Reopening setup does not add an `active -> setup` lifecycle transition; the modal opens over the unchanged pre-activity active run.
- Returning active or paused runs show a dominant one-action Resume surface.
- Setup chooses the initial rotation state. The existing toolbar rotation toggle remains available until the first successful placement.
- Existing `hasUserActivity` semantics are the only meaningful-progress threshold. Rotation toggles, hints, reference activation, placement attempts, and organization changes continue to count as activity where the foundation already marks them.
- Pause blocks puzzle interaction and clears transient interaction state.
- Restart returns to setup with the current mode and rotation choices, but creates a fresh run and clears progress.
- Replaying a completed run goes directly to fresh setup without a discard confirmation.
- Exit saves a resumable run by default; discard is explicit and needs no second confirmation.
- Relaxed uses the existing `relaxed` result class and versioned completion path. It may count as a completion but never updates the canonical timed best.
- HPA-221 adds only the toolbar callback props it needs. It does not implement HPA-217's toolbar architecture or a mode-badge redesign.

## Existing foundation

The current code already provides:

- lifecycle values `setup`, `active`, `paused`, `completed`, and `disposed`;
- session modes `timed` and `relaxed`;
- persisted elapsed active time and hidden-tab exclusion;
- bounded result classes and timing quality;
- pause, resume, restart, and completion transitions;
- fresh run IDs on restart;
- gameplay gating outside the active lifecycle;
- `hasUserActivity` and `isResumable` as the canonical progress/resume signals;
- local and server completion effects projected from an immutable completion seal;
- deterministic gameplay fixtures, seeded persistence, controlled clocks, and reusable Playwright helpers.

The puzzle route currently auto-starts fresh and restored setup sessions, so the existing setup lifecycle is not visible. It also lacks pause, resume, restart, and exit surfaces and always renders timed HUD/completion content.

## Scope

### Included

- Mission setup modal with puzzle facts, Timed/Relaxed selection, rotation selection, contextual input help, Start Immediately, Start, and Return to Arcade.
- Resume surface for restored active or paused sessions.
- Explicit pause and resume.
- Restart confirmation for incomplete runs with meaningful activity.
- Return-to-Arcade save/discard flow.
- Relaxed HUD and completion presentation.
- Focus trapping, explicit Escape behavior, focus restoration, and responsive layout.
- Focused unit/component tests and four representative E2E flows.

### Excluded

- A second lifecycle state machine or session UX store.
- An `active -> setup` domain transition.
- Cloud-synced preferences or active sessions.
- A generic application settings registry or reactive preference store.
- A `preferredRotation` session field.
- Persisted modal, focus, pointer, drag, or gesture state.
- A new completion endpoint, transport, or D1 migration.
- A generalized modal service, dialog stack, or design-system dialog rewrite.
- HPA-217's toolbar grouping, slots, overflow system, or visual redesign.
- HPA-224's complete result-report redesign.
- New analytics events or feature flags.
- A session schema version bump.

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

HPA-221 must not add a coordinator store that mirrors lifecycle, mode, or progress. Route-derived values come directly from `sessionState`. Transient dialog state remains local Svelte state because it has no independent domain behavior and is intentionally discarded on reload.

## Domain changes

Only one new action is required.

```ts
export type PuzzleSessionAction =
  | {
      type: 'configure_setup';
      mode: SessionMode;
      rotationEnabled: boolean;
    }
  // existing actions...
```

### `configure_setup`

This is the only new pre-activity mode/rotation mutator in HPA-221. Do not also add `set_mode`, `set_setup_rotation`, or setup-aware behavior to the existing `set_rotation_mode` action.

It is valid only when either:

- lifecycle is `setup`; or
- lifecycle is `active`, `hasUserActivity` is false, and `timerStarted` is false.

The second case supports reopening setup after Start Immediately without changing lifecycle.

The action atomically:

- sets `mode`;
- sets `elapsedActiveSeconds` to `0` for Timed and `null` for Relaxed;
- keeps `timerStarted` false;
- sets `rotationEnabled`;
- generates per-piece rotations when rotation is enabled;
- clears per-piece rotations when rotation is disabled;
- sets `facts.rotationUsed` from the final setup choice;
- recomputes `resultClass`;
- keeps `hasUserActivity` false;
- preserves the existing run ID.

Repeated configuration is allowed while the setup modal is open. A Timed/Relaxed flip correctly resets the pre-activity elapsed representation, and changing the setup draft does not create a new run.

After play starts, the existing `set_rotation_mode` action remains unchanged:

- it is available only while active and before the first placement;
- changing it marks `hasUserActivity` true;
- enabling it permanently marks rotation use for result eligibility;
- the existing placement lock remains authoritative.

### Restart adjustment

The existing `restart` action continues to:

- create a fresh run ID;
- clear placements, elapsed time, timer-start state, history, counters, assistance facts, completion state, and selection;
- regenerate the canonical tray order;
- return lifecycle to `setup`.

It additionally retains the current run's mode and rotation choice. If rotation remains enabled, restart generates a new rotation mapping for the new run rather than preserving the old mapping.

Do not add a preferred-rotation field or couple device preferences into the engine. Device defaults and current-run retention remain separate concerns.

No persisted-session schema version change is required. Lifecycle, mode, rotation, run ID, elapsed time, result class, and progress are already represented.

## Device preferences

Add a small versioned local-storage codec separate from run persistence.

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

Defaults:

- mode: `timed`;
- rotation: disabled;
- start immediately: disabled.

The module exposes synchronous validated read and safe write functions. Missing, malformed, or unavailable storage falls back to defaults; write failure never blocks play.

Read preferences once on fresh puzzle entry and write the final values when the player starts a run. Do not introduce a Svelte store, migration registry, account synchronization, shared preference package, or reactive coupling to the session.

## Entry flows

### Fresh session

1. Create the fresh `PuzzleSession` in `setup`.
2. Read device preferences once.
3. Dispatch `configure_setup` with preferred mode and rotation.
4. If Start Immediately is false, open Mission Setup.
5. If Start Immediately is true, dispatch `start` immediately.
6. Until `hasUserActivity` becomes true, expose Open Setup in the toolbar.

### Pre-activity setup reopening

Open the setup modal over the unchanged active session. The page behind it is inert.

- Confirm: dispatch `configure_setup` with the final draft, save preferences, and close the modal. Do not dispatch `start` because lifecycle is already active.
- Escape/Cancel: discard the local draft and close the modal without dispatching any session action.
- This path is forbidden after `hasUserActivity` becomes true.

### Restored setup session

Show Mission Setup using the persisted run's mode and rotation. Device preferences, including Start Immediately, never overwrite or bypass an existing setup run.

### Restored active session

Create a route-local copy of the restored snapshot with lifecycle changed from `active` to `paused` before constructing the session store. This prevents the restored timer from starting before Resume appears.

Checkpoint the normalized paused state immediately after store setup.

This is route-only normalization. Do not add a lifecycle, persistence migration, interrupt-reason enum, or resume token.

Show the Resume surface with:

- Resume as the primary action;
- Restart / Change Settings as a secondary action;
- Return to Arcade as a secondary action.

### Restored paused session

Show the same Resume surface without changing canonical run data.

### Restored completed session

Preserve the existing completion flow. HPA-221 changes only Relaxed-specific labels and timed-stat visibility.

## Mission Setup surface

The modal contains:

- puzzle name;
- piece count and grid dimensions;
- Timed and Relaxed choice;
- rotation toggle with a concise explanation;
- input-specific help based on coarse-pointer/touch capability;
- Start Immediately Next Time checkbox;
- primary Start action;
- secondary Return to Arcade action.

Setup sets the initial rotation state. After Start, the toolbar rotation toggle remains available until the first successful placement, preserving current behavior.

Escape behavior:

- Fresh or restored mandatory setup does not dismiss with Escape because no playable state exists behind it.
- Optional pre-activity reopened setup dismisses with Escape and leaves the active run unchanged.

## Pause and resume

Add one private route helper:

```ts
function clearTransientGameplayState(): void
```

It clears:

- active reference mode and overlay;
- reference pointer ownership;
- selected piece;
- active hint target and timeout;
- rejected-piece animation and timeout;
- pan/drag/pointer gesture state.

Do not promote this helper into a manager, event bus, serialized snapshot, or shared gameplay service.

Explicit pause runs in this order:

1. clear transient gameplay state;
2. dispatch `pause`;
3. open the Pause dialog;
4. checkpoint the paused session.

Opening Exit or a destructive restart confirmation from active play uses the same existing pause transition so decision time does not count. Cancel returns to the Pause surface rather than silently resuming.

The page behind setup, resume, pause, restart-confirmation, and exit dialogs is inert. This blocks route-owned zoom, pan, toolbar, board, and inventory interactions in addition to engine lifecycle gating.

Resume dispatches `resume`, closes the dialog, and restores focus to the Pause trigger when possible. Transient selection, references, hints, and gestures are intentionally not restored.

Document visibility continues to call only `setDocumentHidden(document.hidden)`. Hidden tabs suspend active timing and checkpoint, but do not open a modal or change lifecycle to `paused`.

## Restart and replay

Use `sessionState.hasUserActivity` without introducing a second progress flag.

This intentionally inherits existing activity semantics: a rotation toggle, hint, reference activation, placement attempt, or supported organization change can require confirmation even when no piece has been placed.

- Active or paused incomplete run without activity: restart directly.
- Active or paused incomplete run with activity: show one destructive confirmation.
- Completed run launched through Play Again: restart directly and open setup; no discard warning.

After restart:

1. clear transient gameplay state and old completion presentation;
2. dispatch `restart`;
3. persist the new setup-state snapshot immediately;
4. open Mission Setup with retained mode and rotation;
5. reset the viewport using existing route behavior.

Restart does not clear or reread device preferences.

## Return to Arcade

Replace direct navigation from the gameplay header and pause surface with one route handler.

When `isResumable` is true, show:

- **Save & Exit** as the primary action;
- **Discard & Exit** as the destructive action;
- Cancel.

The Exit dialog itself is the discard confirmation; do not add another confirmation step.

Save & Exit checkpoints time and persistence before navigation.

Discard & Exit uses the existing best-effort session-storage adapter to clear the puzzle's active session before navigation. It does not clear gameplay preferences or local completion statistics. Storage unavailability does not introduce a new blocking error flow in this ticket.

When the run is not resumable, including mandatory setup with no activity, navigate directly after a final checkpoint. Return to Arcade must remain available inside mandatory setup because the inert page behind the modal is not interactive.

## Relaxed mode

Relaxed reuses the existing session and completion contracts.

- `mode` is `relaxed`.
- `elapsedActiveSeconds` remains `null`.
- `resultClass` is `relaxed`.
- Timed local-best logic remains inapplicable.
- Versioned server completion submission uses the existing sealed-completion effect path.
- The server may count the completion but cannot update the canonical standard timed best.

Presentation rules:

- Setup explains that Relaxed has no timer or timed personal best.
- HUD shows `RELAXED` instead of elapsed/best time.
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
```

Do not pass the whole session state, add generic `ToolbarAction[]`, introduce slots/registries/overflow infrastructure, or redesign mode presentation here. Relaxed status belongs in the existing HUD.

Open Setup is enabled only while lifecycle is `active` and `hasUserActivity` is false. Pause is enabled only while lifecycle is `active`.

## Dialog implementation and accessibility

Add focused components for the distinct product surfaces:

- `MissionSetupDialog.svelte`;
- `SessionPauseDialog.svelte`, also used for restored Resume;
- `ExitSessionDialog.svelte`.

A small restart confirmation may remain local to the route or pause surface; do not create a dialog framework solely to share it.

Extract the existing route-local focus trap into a small reusable Svelte action used by setup, pause/resume, exit, and the existing completion dialog. This is a focus utility, not a modal service.

Required behavior:

- correct dialog semantics and labels;
- initial focus on the dominant action or first setup control;
- Tab containment while modal;
- explicit Escape behavior per surface;
- predictable focus restoration;
- clearly named destructive actions;
- usable at 390 x 844, tablet, and desktop sizes;
- scrollable content within safe-area-aware bounds when available height shrinks.

## Error handling

- Preference read/write failure does not block setup or play.
- Session persistence and discard remain best-effort through the existing resilient adapter.
- Restart's existing run-ID and tray-order validation remains authoritative.
- Navigation occurs only after the route attempts the final checkpoint or discard clear.
- Completion effect handling is unchanged.

## Testing

### Session unit tests

Cover:

- Timed and Relaxed configuration in setup;
- configuration in active pre-activity state;
- rejection after activity or timer start;
- setup rotation enable/disable and result-class truth;
- repeated configuration without activity or a new run ID;
- restart retaining mode/rotation while creating a new run ID and rotation mapping;
- serialization remains schema version 1.

### Preference unit tests

Cover defaults, valid round-trip, one corrupt record, and one storage exception path.

### Route/component tests

Cover fresh mandatory setup, Start Immediately with optional reopening/dismissal, restored setup ignoring preferences, restored Resume normalization, pause cleanup, restart threshold, Play Again, save/discard exit, Relaxed presentation, and component-level Escape/focus rules.

### Representative E2E tests

Use the existing deterministic gameplay fixture and helpers.

1. Fresh Timed run: setup, first meaningful action starts time, explicit pause excludes elapsed time, resume continues.
2. Relaxed run: setup, completion, no timed HUD/best presentation, and completion request uses `relaxed`.
3. Seeded active run: Resume, restart confirmation, fresh run ID, cleared progress, retained choices.
4. Mobile 390 x 844 smoke: setup, pause, exit/restart reachability, and one focus-containment check.

Do not duplicate the full Escape/focus matrix in E2E or build exhaustive browser permutations for unit-level transitions.

## YAGNI guardrails

The implementation must not add:

- another session state machine or canonical store;
- an `active -> setup` general transition;
- separate mode and setup-rotation actions;
- a `preferredRotation` session field;
- a modal manager, dialog stack, or design-system dialog rewrite;
- a preference framework, reactive preference store, or shared preferences package;
- persisted UI/transient state;
- a backend schema change or Relaxed-specific completion transport;
- a toolbar plugin system, generic action array, or overflow rewrite;
- a feature-flag system;
- analytics events "while here";
- HPA-224 completion-report work;
- a session schema v2;
- unrelated route or design-system refactors.

## Acceptance criteria

- Fresh sessions show one concise setup surface unless Start Immediately is enabled.
- Start Immediately users can reopen setup only before `hasUserActivity`, without changing lifecycle or run ID.
- Restored setup runs ignore device preferences and Start Immediately.
- Restored active/paused sessions show a dominant Resume path without starting active time first.
- Timed sessions restore elapsed active time and exclude explicit pause, control-dialog, and hidden-tab time.
- Relaxed sessions never render or write a timed personal best.
- Explicit pause prevents gameplay interactions and clears transient selection/reference/gesture state.
- Setup chooses initial rotation; the existing toolbar toggle remains available until the first successful placement.
- Restart uses existing `hasUserActivity`, creates a new run ID, clears run progress, and retains mode/rotation choices.
- Completed Play Again opens fresh setup without a discard confirmation.
- Exit saves resumable progress by default and exposes one explicit discard action.
- Mandatory setup always offers Return to Arcade.
- Dialogs remain usable and focus-safe at mobile, tablet, and desktop sizes.
- Feature-owned automated tests cover the integrated flows without duplicating foundation coverage.
