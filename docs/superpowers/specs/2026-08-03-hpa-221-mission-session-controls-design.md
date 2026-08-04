# HPA-221 Mission Session Controls Design

## Status

Revised after YAGNI, persistence, and KISS self-review on 2026-08-04.

## Objective

Add mission setup, deliberate resume, explicit pause, restart/exit controls, and Relaxed presentation without creating another state machine or expanding the architecture beyond the existing `PuzzleSession` contract.

`PuzzleSession` remains the sole owner of lifecycle, mode, timing, run identity, placements, rotation, history, assistance facts, result class, completion sealing, and persisted run state.

## KISS decisions

- Add one setup-only domain action: `configure_setup`.
- Do not add `reopen_setup`, an active-session setup mutator, or an `active -> setup` transition.
- Do not modify `doRestart`. The route composes existing `restart` with `configure_setup` to restore the prior mode/rotation choices.
- Use one bounded schema-v1 validator exception for a configured rotation run that has not recorded activity.
- Keep setup edits and dialog visibility as route-local Svelte state.
- Use one tiny local-storage preferences module, three focused dialog components, and one reusable focus action.
- Keep restart confirmation inside the Pause dialog instead of adding another dialog component.
- Keep four representative E2E flows; test state permutations below the browser layer.

## Existing foundation

The current implementation already provides:

- lifecycle `setup`, `active`, `paused`, `completed`, and `disposed`;
- modes `timed` and `relaxed`;
- persisted active elapsed time and hidden-tab exclusion;
- bounded result classes and timing quality;
- start, pause, resume, restart, and completion transitions;
- new run IDs on restart;
- gameplay gating outside `active`;
- `hasUserActivity` and `isResumable` as the canonical activity/resume signals;
- local/server effects projected from an immutable completion seal;
- deterministic gameplay fixtures and reusable Playwright helpers.

The puzzle route currently auto-starts fresh/setup sessions, lacks the HPA-221 control surfaces, and always presents timed HUD/completion content.

## Ownership

`PuzzleSession` owns run invariants. The puzzle route only:

- reads/writes device preferences;
- chooses the visible dialog;
- keeps an uncommitted setup draft;
- dispatches session actions;
- clears transient route interaction state;
- checkpoints before navigation/teardown;
- navigates to the Arcade.

Dialog visibility, setup drafts, focus, pointer/gesture state, hint/rejection presentation, and reference-overlay state are transient and never serialized.

No coordinator store may mirror lifecycle, mode, progress, or resumability. UI derives those values from `sessionState`.

## Domain change: `configure_setup`

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

It is valid only while lifecycle is `setup` and is the only new pre-start mode/rotation mutator in this ticket.

It atomically:

- sets `mode`;
- sets `elapsedActiveSeconds` to `0` for Timed or `null` for Relaxed;
- leaves `timerStarted` false;
- sets `rotationEnabled`;
- generates or clears the piece-rotation map;
- sets `facts.rotationUsed` from the configured rotation choice;
- recomputes `resultClass`;
- leaves `hasUserActivity` false;
- preserves the current run ID.

The action may be called again while still in setup, for example when the player edits a restored setup run. It must not be valid after `start`.

Do not add `set_mode`, `set_setup_rotation`, setup-aware behavior to `set_rotation_mode`, or another configuration action.

### Eligibility fact invariant

`SessionFacts` is mutable only before meaningful activity:

- `configure_setup` may set or clear `rotationUsed` while lifecycle is `setup` and `hasUserActivity` is false;
- once activity begins, eligibility facts are monotonic and may only move toward less-competitive classes;
- the existing active `set_rotation_mode` behavior remains unchanged: changing rotation marks activity, and enabling it permanently records rotation use.

Update the `SessionFacts` documentation to state this narrow pre-activity exception.

## Persistence compatibility

The current v1 loader rejects `rotationUsed: true` with `hasUserActivity: false`, but that is a valid configured state before the player acts. Without a validator adjustment, setup/active/paused rotation snapshots can be written and then discarded as corrupt on reload.

Add one local predicate equivalent to **pre-activity configured rotation**:

- `rotationUsed` is true;
- rotation is enabled or a valid rotation map exists;
- `hasUserActivity` is false;
- placements and counted-action counters are empty/zero;
- `timerStarted` is false;
- lifecycle is not `completed`;
- no completion seal exists.

The existing cross-field activity rejection permits only that predicate. Counted actions, placements, started timing, or completion facts continue to require `hasUserActivity: true`.

This is a backward-compatible schema-v1 validation adjustment, not a migration or schema bump. Existing result-class, rotation-map, counter, timing-quality, and seal checks remain unchanged.

Add table-driven persistence tests for valid setup/active/paused pre-activity rotation snapshots and invalid near-miss states.

## Device preferences

Use one versioned key:

```text
perseus-gameplay-preferences-v1
```

Payload:

```ts
interface GameplayPreferences {
  mode: 'timed' | 'relaxed';
  rotationEnabled: boolean;
  startImmediately: boolean;
}
```

Defaults are Timed, rotation off, and Start Immediately off.

Expose synchronous validated read and best-effort write functions. Missing, corrupt, or unavailable storage falls back to defaults; writes never block play. A future incompatible format gets a new key.

Read preferences once per puzzle-route load. Apply their mode/rotation and auto-start behavior only to a fresh session. A restored setup keeps its persisted run choices, but its Start Immediately checkbox reflects the current device preference and may update it.

Write all three preference values whenever setup is confirmed. Do not add a Svelte preference store, migration registry, account sync, or shared settings platform.

## Entry flows

### Fresh session

1. Create the session in `setup`.
2. Read preferences once.
3. Immediately dispatch `configure_setup` with the preferred mode/rotation so session checkpoints match the displayed choices.
4. If Start Immediately is on, dispatch `start`.
5. Otherwise show Mission Setup with a draft copied from the configured session and the stored Start Immediately value.
6. Expose Open Setup only until existing `hasUserActivity` becomes true.

Unsaved modal edits are not persisted. The canonical setup session always contains the last confirmed run choices.

### Reopen setup before activity

Open Mission Setup over the unchanged active session and make the page behind it inert.

- Cancel/Escape closes the modal without a session action.
- A Start Immediately-only change writes preferences and closes the modal.
- If mode or rotation changes, write all preferences, capture the draft, dispatch existing `restart`, dispatch setup-only `configure_setup`, dispatch `start`, then checkpoint.
- A changed setting may therefore produce a new run ID and tray order. That is acceptable because the replaced run has no activity or completion identity.
- The path disappears as soon as `hasUserActivity` becomes true, including after the existing toolbar rotation toggle is changed.

### Restored setup

Show setup from the persisted mode/rotation and the current device Start Immediately preference. Never auto-start or replace the persisted run from device preferences.

### Restored active

Construct the store from the persisted snapshot, subscribe, immediately dispatch existing `pause`, checkpoint, and show Resume.

Do not rewrite the snapshot or add a migration, resume token, interrupt reason, or lifecycle. The existing clock stores whole seconds, and the immediate pause prevents modal time from accumulating.

### Restored paused

Show the same Resume surface without changing canonical state.

### Restored completed

Preserve the existing completion flow. HPA-221 changes only Relaxed-specific labels and timed-stat visibility. Legacy unknown-time runs retain their existing ineligible timing quality and must not gain timed-best presentation.

## Mission Setup

Show one modal containing:

- puzzle name, piece count, and grid dimensions;
- Timed/Relaxed choice;
- rotation choice with concise explanation that it remains changeable until the first successful placement and then locks;
- input-specific help;
- Start Immediately checkbox;
- Start;
- Return to Arcade.

For mandatory fresh/restored setup, Start dispatches `configure_setup`, writes all preferences, dispatches `start`, and closes the modal.

The existing toolbar rotation toggle remains available after Start until the first successful placement. Once locked, expose the fixed accessible reason “Rotation is locked after the first placement.” Do not build a generic disabled-reason or tooltip system for this ticket.

Escape does not dismiss mandatory setup. Escape dismisses optional pre-activity reopened setup and leaves the run unchanged.

## Pause and resume

Add one private route function:

```ts
function clearTransientGameplayState(): void
```

It clears active reference state/overlay, pointer ownership, selection, hint/rejection presentation and timers, and pan/drag/pointer state. It must not become a manager, service, event bus, or serialized snapshot.

Explicit Pause:

1. clear transient state;
2. dispatch `pause`;
3. checkpoint;
4. show the Pause dialog.

The Pause dialog provides Resume, Restart, and Return to Arcade. If restart needs confirmation, replace the Pause dialog body with a simple confirmation view rather than opening another modal.

Resume dispatches `resume`, closes the dialog, and restores focus to the Pause trigger when possible. Transient interaction state is intentionally not restored.

Document visibility continues to call only `setDocumentHidden(document.hidden)`. It suspends/checkpoints timing without opening Pause or changing lifecycle.

## Restart and replay

Use existing `hasUserActivity` as the only confirmation threshold. Rotation toggles, hints, reference activation, placement attempts, and supported organization changes retain their current activity semantics.

For restart:

1. capture the current mode and rotation choice;
2. if the incomplete run has activity, confirm once within the Pause dialog;
3. dispatch existing `restart` unchanged;
4. dispatch `configure_setup` with the captured choices;
5. checkpoint the configured setup run;
6. show Mission Setup with the current Start Immediately device preference;
7. reset the existing viewport state.

An incomplete run without activity skips confirmation. Completed Play Again uses the same restart/configure sequence without confirmation. Explicit restart/replay always shows setup; Start Immediately applies only to fresh route entry.

No changes are required in `doRestart`; route composition is the single source of HPA-221 choice retention.

## Return to Arcade

- A non-resumable run navigates after a final checkpoint.
- A resumable run shows Save & Exit, Discard & Exit, and Cancel.
- The Exit dialog is the only discard confirmation.
- Save checkpoints then navigates.
- Discard uses the existing best-effort session clear and does not clear preferences or completion statistics.

When Exit is opened from active gameplay, pause first; Cancel resumes gameplay. When opened from the Pause dialog, Cancel returns to Pause. Do not add a general dialog stack to model this two-case return behavior.

Mandatory setup includes Return to Arcade because the inert page behind it is unavailable.

## Relaxed mode

Relaxed reuses existing contracts:

- `mode` and `resultClass` are `relaxed`;
- `elapsedActiveSeconds` is `null`;
- timed local-best logic does not apply;
- server submission uses the existing sealed-completion effect path;
- completion may count but cannot update the standard timed best.

Presentation is limited to:

- setup explanation;
- `RELAXED` in the HUD instead of elapsed/best time;
- mode label in Pause/Resume;
- no final-time or timed-best content on completion;
- a neutral completion label instead of the hard-coded timed rank.

HPA-224 remains responsible for the full completion-report redesign.

## Toolbar and dialogs

Until HPA-217 lands, add only these toolbar props:

```ts
onPause: () => void;
onOpenSetup: () => void;
canOpenSetup: boolean;
```

Do not pass session state, add generic action arrays, or introduce slots, registries, overflow architecture, a generic disabled-reason system, or a mode redesign.

Use three focused components:

- Mission Setup;
- Pause/Resume, including restart confirmation view;
- Exit.

Extract the existing focus trap into one small reusable Svelte action. Reusing it in the existing completion modal should be a mechanical replacement only; do not redesign completion.

Required dialog behavior is limited to correct semantics/labels, initial focus, Tab containment, explicit Escape behavior, predictable focus restoration, clearly named destructive actions, safe-area insets, and scrollable layouts using dynamic viewport height at 390 × 844, tablet, and desktop sizes. Orientation/browser-chrome/virtual-keyboard changes must not hide the primary actions.

## Testing

### Unit tests

Cover:

- Timed/Relaxed setup configuration;
- rotation configuration and result-class truth;
- rejection outside setup;
- pre-activity eligibility mutability versus post-activity monotonicity;
- valid pre-activity rotation persistence and invalid near misses;
- preference defaults, round-trip, corrupt input, and unavailable storage.

### Route/component tests

Cover mandatory setup, Start Immediately/Open Setup, restored setup preference ownership, pause-on-restored-active, legacy-unknown timed-best suppression, transient cleanup, restart confirmation, Play Again, exit save/discard/cancel origins, Relaxed presentation, rotation-lock explanation, and component-level focus/Escape behavior.

### Representative E2E tests

1. Timed setup → first meaningful action → pause excludes time → resume.
2. Relaxed setup → completion classified `relaxed` → no timed-best presentation.
3. Seeded active session → Resume → restart → fresh run ID and cleared progress with retained choices.
4. 390 × 844 smoke for setup, pause, exit/restart reachability, safe-area/dynamic-height usability, and one focus-containment check.

Do not duplicate the complete focus/Escape matrix in E2E or create browser permutations for unit-level state transitions.

## Non-goals and guardrails

The implementation must not add:

- another session state machine or canonical store;
- an active-session setup mutator or `active -> setup` transition;
- separate mode/setup-rotation actions or preferred-rotation state;
- restart-specific domain retention logic;
- a modal manager, dialog stack, or design-system dialog rewrite;
- a preference framework, reactive store, or shared settings package;
- persisted UI/transient state;
- schema v2 or a migration for the validator adjustment;
- backend schema or Relaxed-specific transport changes;
- toolbar plugins, generic action arrays, overflow rewrite, or generic disabled-reason system;
- feature flags or analytics additions;
- HPA-224 completion-report work;
- unrelated route/design-system refactors.

## Acceptance criteria

- Fresh sessions show setup unless Start Immediately is enabled.
- The canonical fresh setup session is configured from device preferences before checkpointing.
- Open Setup is available only before existing `hasUserActivity`.
- Canceling Open Setup leaves the active run unchanged.
- Confirming Open Setup writes all device preferences; changed run settings replace the zero-activity run via restart/configure/start.
- Configured rotation sessions persist/load without false corruption while remaining non-active until actual interaction.
- Eligibility facts are mutable only during setup and monotonic after activity begins.
- Restored setup preserves persisted mode/rotation, shows the device Start Immediately value, and never auto-skips.
- Restored active/paused sessions show Resume without counting modal time.
- Legacy unknown-time runs remain ineligible and receive no timed-best claim.
- Timed sessions exclude pause, control-dialog, and hidden-tab time.
- Relaxed never renders or writes a timed personal best.
- Pause blocks gameplay and clears transient interaction state.
- Existing toolbar rotation remains available until the first successful placement and exposes a fixed accessible lock reason afterward.
- Restart uses existing `hasUserActivity`, leaves `doRestart` unchanged, and reapplies choices through `configure_setup`.
- Completed Play Again opens setup without discard confirmation or Start Immediately auto-skip.
- Exit saves by default, exposes one discard action, and restores the correct prior surface on Cancel.
- Mandatory setup always offers Return to Arcade.
- Dialogs remain safe-area-aware, usable, and focus-safe across mobile, tablet, orientation/browser-chrome changes, and desktop.
- Feature-owned tests cover integrated behavior without duplicating foundation coverage.
