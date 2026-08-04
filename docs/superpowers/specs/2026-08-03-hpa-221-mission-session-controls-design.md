# HPA-221 Mission Session Controls Design

## Status

Revised after the second YAGNI and persistence review on 2026-08-03.

## Objective

Add concise mission setup, deliberate resume, explicit pause, safe restart and exit, and Relaxed mode presentation without creating a second session controller or expanding the architecture beyond the existing `PuzzleSession` contract.

`PuzzleSession` remains the sole owner of lifecycle, mode, timing, run identity, placements, rotation, history, assistance facts, result class, completion sealing, and persisted run state.

## Product decisions

- Setup is one modal surface, never a wizard.
- Fresh runs show setup unless the player enabled **Start immediately next time**.
- Start Immediately and pre-activity setup reopening remain in v1 because HPA-221 explicitly requires both.
- Reopening setup is route-owned UI over an unchanged pre-activity active run. It does not add an active-session mode mutator or a new lifecycle transition.
- Changing run settings from reopened setup restarts the zero-activity run, then configures and starts the replacement run.
- Returning active or paused runs show a dominant one-action Resume surface.
- Setup chooses the initial rotation state. The existing toolbar rotation toggle remains available until the first successful placement.
- Existing `hasUserActivity` semantics are the only progress and restart-confirmation threshold.
- Pause blocks puzzle interaction and clears transient interaction state.
- Restart returns to setup with the current mode and rotation choices, creates a fresh run, and clears progress.
- Replaying a completed run goes directly to fresh setup without a discard confirmation.
- Exit saves a resumable run by default; discard is explicit and needs no second confirmation.
- Relaxed reuses the existing `relaxed` result class and completion path. It may count as a completion but never updates the canonical timed best.
- HPA-221 adds only the toolbar callbacks it needs. It does not implement HPA-217's toolbar architecture or a mode-badge redesign.

## Existing foundation

The current code already provides:

- lifecycle values `setup`, `active`, `paused`, `completed`, and `disposed`;
- session modes `timed` and `relaxed`;
- persisted elapsed active time and hidden-tab exclusion;
- bounded result classes and timing quality;
- pause, resume, restart, and completion transitions;
- fresh run IDs on restart;
- gameplay gating outside the active lifecycle;
- `hasUserActivity` and `isResumable` as canonical activity/resume signals;
- local and server completion effects projected from an immutable completion seal;
- deterministic gameplay fixtures, seeded persistence, controlled clocks, and reusable Playwright helpers.

The puzzle route currently auto-starts fresh and restored setup sessions, lacks setup/pause/resume/restart/exit surfaces, and always renders timed HUD/completion content.

## Architecture and ownership

`PuzzleSession` owns canonical run state and transition invariants.

The puzzle route owns orchestration and external effects:

- read and write device preferences;
- choose which dialog is visible;
- keep setup edits in a local draft;
- map UI actions to existing or bounded `PuzzleSession` actions;
- clear route-owned transient interactions;
- checkpoint before exit or teardown;
- navigate back to the Arcade.

Dialog visibility, setup drafts, focus state, gesture state, hint highlights, rejection animation, and reference-overlay visibility remain transient and are not serialized.

HPA-221 must not add a coordinator store mirroring lifecycle, mode, or progress. Route-derived values come directly from `sessionState`; transient dialog state remains local Svelte state.

## Domain changes

### `configure_setup`

Add one action:

```ts
export type PuzzleSessionAction =
  | {
      type: 'configure_setup';
      mode: SessionMode;
      rotationEnabled: boolean;
    }
  // existing actions...
```

This is the only new pre-start mode/rotation mutator in HPA-221. Do not also add `set_mode`, `set_setup_rotation`, or setup-aware behavior to `set_rotation_mode`.

It is valid only while lifecycle is `setup`.

It atomically:

- sets `mode`;
- sets `elapsedActiveSeconds` to `0` for Timed and `null` for Relaxed;
- leaves `timerStarted` false;
- sets `rotationEnabled`;
- generates per-piece rotations when rotation is enabled;
- clears per-piece rotations when rotation is disabled;
- sets `facts.rotationUsed` from the final setup choice;
- recomputes `resultClass`;
- keeps `hasUserActivity` false;
- preserves the current run ID.

Repeated configuration in `setup` is allowed and does not mint another run ID.

### Pre-activity eligibility invariant

`SessionFacts` is currently documented as monotonic. HPA-221 narrows that invariant explicitly:

- before meaningful activity, `configure_setup` may revise `rotationUsed` in either direction so the final setup choice remains truthful;
- once `hasUserActivity` becomes true, eligibility facts remain monotonic and may only move toward less-competitive result classes;
- the existing active `set_rotation_mode` behavior remains unchanged: enabling rotation marks activity and permanently sets `rotationUsed`.

Update the `SessionFacts` documentation to state this pre-activity exception rather than leaving the existing invariant silently false.

### Restart adjustment

The existing restart already retains `mode` and organization. HPA-221 adds only rotation-choice retention.

Restart continues to:

- create a fresh run ID;
- clear placements, elapsed time, timer-start state, history, counters, assistance facts, completion state, and selection;
- regenerate canonical tray order;
- return lifecycle to `setup`.

It additionally retains `rotationEnabled`. When retained rotation is enabled, restart generates a fresh rotation mapping and establishes the matching pre-activity `rotationUsed` and `resultClass` state.

Do not add a `preferredRotation` field or couple device preferences into the engine. Device defaults and current-run restart retention remain separate concerns.

## Persistence compatibility

No schema-version bump is required, but a validator change is required.

Today the v1 loader rejects every snapshot where `rotationUsed` is true and `hasUserActivity` is false. That rule conflicts with valid setup-configured and restarted rotation runs, which must remain non-active until the player actually interacts.

Relax validation only for a bounded **pre-activity configured rotation** state:

- `rotationUsed` is true;
- `rotationEnabled` or a valid rotation map is present;
- `hasUserActivity` is false;
- placements and all counted-action counters are empty/zero;
- `timerStarted` is false;
- there is no sealed completion;
- lifecycle is `setup`, `active`, or `paused`.

Counted actions, placements, started timing, or completion facts must still require `hasUserActivity: true`. Existing corruption checks for result class, rotations, counters, seals, and timing quality remain authoritative.

This is a backward-compatible validation-contract adjustment inside schema v1, not a migration or schema v2.

Add focused persistence tests proving that valid setup/active/paused pre-activity rotation snapshots round-trip, while rotation or counted-action facts paired with false activity outside that bounded state remain rejected.

## Device preferences

Use one versioned local-storage key:

```text
perseus-gameplay-preferences-v1
```

The payload does not repeat the version:

```ts
interface GameplayPreferences {
  mode: 'timed' | 'relaxed';
  rotationEnabled: boolean;
  startImmediately: boolean;
}
```

Defaults:

- mode: `timed`;
- rotation: disabled;
- start immediately: disabled.

The module exposes synchronous validated read and safe write functions. Missing, malformed, or unavailable storage falls back to defaults; write failure never blocks play.

Read preferences once on fresh puzzle entry and write final values when the player starts or confirms setup. Do not introduce a Svelte store, migration registry, account synchronization, shared preference package, or reactive session coupling. A future incompatible format uses a new key.

## Entry flows

### Fresh session

1. Create the fresh session in `setup`.
2. Read device preferences once.
3. If Start Immediately is false, open Mission Setup with the preferences as its draft.
4. If Start Immediately is true, dispatch `configure_setup`, then `start`.
5. Until `hasUserActivity` becomes true, expose Open Setup in the toolbar.

### Pre-activity setup reopening

Open the setup modal over the unchanged active session and make the page behind it inert.

- Escape/Cancel discards the local draft and closes the modal without a session action.
- If mode and rotation are unchanged, save any preference-only change and close the modal.
- If mode or rotation changed, dispatch `restart`, `configure_setup`, then `start`; checkpoint the replacement run.
- A settings change therefore creates a new run ID and may regenerate tray order. This is acceptable because the replaced run has no meaningful activity or completion identity.
- This path is unavailable as soon as existing `hasUserActivity` becomes true. A toolbar rotation toggle therefore closes the Open Setup window, matching the current activity contract.

### Restored setup session

Show Mission Setup using persisted mode and rotation. Device preferences, including Start Immediately, never overwrite or bypass an existing setup run.

### Restored active session

Construct the store from the persisted snapshot without rewriting it. Immediately after subscribing, dispatch the existing `pause` action, checkpoint the paused state, and show Resume.

The brief construction-time timer interval is stopped by `pause`; whole-second checkpointing prevents sub-second modal time from being added. Do not add a snapshot-normalization path, lifecycle, migration, resume token, or interruption-reason enum.

### Restored paused session

Show the same Resume surface without changing canonical run data.

### Restored completed session

Preserve the existing completion flow. HPA-221 changes only Relaxed-specific labels and timed-stat visibility.

## Mission Setup

The modal contains:

- puzzle name;
- piece count and grid dimensions;
- Timed and Relaxed choice;
- rotation toggle with concise lock/result-class explanation;
- input-specific help;
- Start Immediately Next Time checkbox;
- primary Start action;
- secondary Return to Arcade action.

For mandatory fresh/restored setup, Start dispatches `configure_setup`, writes preferences, dispatches `start`, and closes the modal.

Setup sets the initial rotation state. After Start, the existing toolbar rotation toggle remains available until the first successful placement.

Escape behavior:

- fresh or restored mandatory setup does not dismiss with Escape;
- optional pre-activity reopened setup dismisses with Escape and leaves the active run unchanged.

## Pause and resume

Add one private route helper:

```ts
function clearTransientGameplayState(): void
```

It clears active reference state/overlay, reference pointer ownership, selection, hint/rejection timeouts and presentation, and pan/drag/pointer gesture state.

Do not promote this helper into a manager, event bus, serialized snapshot, or shared gameplay service.

Explicit pause:

1. clear transient gameplay state;
2. dispatch `pause`;
3. open the Pause dialog;
4. checkpoint the paused session.

Opening Exit or destructive restart confirmation from active play uses the same pause transition so decision time does not count. Cancel returns to the Pause surface rather than silently resuming.

The page behind setup, resume, pause, restart-confirmation, and exit dialogs is inert. Resume dispatches `resume`, closes the dialog, and restores focus to the Pause trigger when possible. Transient interaction state is intentionally not restored.

Document visibility continues to call only `setDocumentHidden(document.hidden)`. Hidden tabs suspend active timing and checkpoint but do not open a modal or change lifecycle.

## Restart and replay

Use existing `hasUserActivity` without introducing another progress flag. This intentionally inherits current activity semantics: rotation toggle, hint, reference activation, placement attempt, or supported organization change can require confirmation even without a placed piece.

- Active or paused incomplete run without activity: restart directly.
- Active or paused incomplete run with activity: show one destructive confirmation.
- Completed Play Again: restart directly and open setup; no discard warning.

After restart, persist the new setup-state snapshot immediately, open Mission Setup with retained mode/rotation, and reset the existing viewport state. Restart does not clear or reread device preferences.

## Return to Arcade

When `isResumable` is true, show:

- **Save & Exit** as primary;
- **Discard & Exit** as destructive;
- Cancel.

The Exit dialog itself is the discard confirmation. Save checkpoints before navigation. Discard uses the existing best-effort session clear and does not clear preferences or local completion statistics.

When the run is not resumable, including mandatory setup with no activity, navigate directly after a final checkpoint. Return to Arcade must remain available inside mandatory setup because the inert page behind it is not interactive.

## Relaxed mode

Relaxed reuses existing session and completion contracts:

- `mode` and `resultClass` are `relaxed`;
- `elapsedActiveSeconds` remains `null`;
- timed local-best logic is inapplicable;
- server completion submission uses the existing sealed-completion effect path;
- the completion may count but cannot update the standard timed best.

Presentation:

- Setup explains that Relaxed has no timer or timed personal best.
- HUD shows `RELAXED` instead of elapsed/best time.
- Pause and Resume identify Relaxed mode.
- Completion hides final-time and timed-personal-best content.
- The hard-coded timed rank is replaced only for Relaxed with a neutral completion label.

HPA-224 remains responsible for the complete result-report redesign.

## Toolbar and dialogs

Until HPA-217 lands, extend `PuzzleToolbar` only with:

```ts
onPause: () => void;
onOpenSetup: () => void;
canOpenSetup: boolean;
```

Do not pass the whole session state, add generic action arrays, introduce slots/registries/overflow infrastructure, or redesign mode presentation. Relaxed status stays in the HUD.

Add focused setup, pause/resume, and exit components. A small restart confirmation may remain route-local. Extract the existing focus trap into a small reusable action, not a modal service.

Required behavior is limited to correct dialog semantics, initial focus, Tab containment, explicit Escape behavior, predictable focus restoration, clearly named destructive actions, and usable scrollable layouts at 390 × 844, tablet, and desktop sizes.

## Testing

### Session and persistence unit tests

Cover:

- Timed and Relaxed setup configuration;
- rotation enable/disable and result-class truth in setup;
- configuration rejected outside setup;
- repeated setup configuration without activity or a new run ID;
- restart retaining rotation while existing mode retention remains unchanged;
- valid pre-activity rotation snapshots loading in setup/active/paused lifecycle;
- corrupt counted-action or completed snapshots still rejected when activity is false;
- serialization remaining schema version 1.

### Preference tests

Cover defaults, valid round-trip, one corrupt record, and one storage exception path.

### Route/component tests

Cover mandatory setup, Start Immediately with pre-activity reopening, restored setup ignoring preferences, restored active pause-on-load, pause cleanup, restart threshold, Play Again, save/discard exit, Relaxed presentation, and component-level Escape/focus rules.

### Representative E2E tests

1. Fresh Timed run: setup, first meaningful action starts time, pause excludes time, resume continues.
2. Relaxed run: setup, completion, no timed HUD/best presentation, request classified `relaxed`.
3. Seeded active run: Resume, restart confirmation, fresh run ID, cleared progress, retained choices.
4. Mobile 390 × 844 smoke: setup, pause, exit/restart reachability, and one focus-containment check.

Do not duplicate the full Escape/focus matrix in E2E or build exhaustive browser permutations for unit-level transitions.

## Non-goals and YAGNI guardrails

The implementation must not add:

- another session state machine or canonical store;
- an active-session mode/rotation setup mutator;
- a general `active -> setup` transition;
- separate mode and setup-rotation actions;
- a `preferredRotation` session field;
- a modal manager, dialog stack, or design-system dialog rewrite;
- a preference framework, reactive preference store, shared preferences package, or duplicate payload version;
- persisted UI/transient state;
- a persistence schema v2 or migration for this validator adjustment;
- a backend schema change or Relaxed-specific completion transport;
- a toolbar plugin system, generic action array, or overflow rewrite;
- feature flags or analytics events "while here";
- HPA-224 completion-report work;
- unrelated route or design-system refactors.

## Acceptance criteria

- Fresh sessions show one concise setup surface unless Start Immediately is enabled.
- Start Immediately users can reopen setup only before `hasUserActivity`.
- Canceling reopened setup leaves the current active run unchanged.
- Changing mode/rotation in reopened setup replaces the zero-activity run through restart/configure/start; run-ID stability is not required.
- Setup-configured rotation sessions persist and load without being classified as corrupt while remaining non-active until actual interaction.
- Eligibility facts are mutable only during pre-activity setup and monotonic after activity begins.
- Restored setup runs ignore device preferences and Start Immediately.
- Restored active/paused sessions show a dominant Resume path without counting modal time.
- Timed sessions restore elapsed active time and exclude pause, control-dialog, and hidden-tab time.
- Relaxed sessions never render or write a timed personal best.
- Explicit pause prevents gameplay interactions and clears transient selection/reference/gesture state.
- Setup chooses initial rotation; the existing toolbar toggle remains available until the first successful placement.
- Restart uses existing `hasUserActivity`, creates a new run ID, clears run progress, and adds only rotation retention beyond current behavior.
- Completed Play Again opens fresh setup without a discard confirmation.
- Exit saves resumable progress by default and exposes one explicit discard action.
- Mandatory setup always offers Return to Arcade.
- Dialogs remain usable and focus-safe across mobile, tablet, and desktop.
- Feature-owned automated tests cover integrated flows without duplicating foundation coverage.
