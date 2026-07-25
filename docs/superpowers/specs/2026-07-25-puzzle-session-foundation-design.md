# PuzzleSession Foundation Design

- **Issue:** HPA-236
- **Date:** 2026-07-25
- **Status:** Approved design

## Objective

Extract the puzzle route's run state and transitions into one testable `PuzzleSession` domain
layer. The layer will own lifecycle, timing, placements, rotation, history, counters, result
eligibility, completion idempotency, and versioned device-local persistence before the gameplay
UX workstreams in HPA-218 through HPA-224 add more interaction paths and persisted fields.

The extraction must preserve the current puzzle experience. It does not add the future mission
setup UI, mobile tray, staging UI, analytics provider, or completion report.

## Product Decisions

The following decisions are fixed for this implementation:

- The existing canonical personal best is available only to eligible `standard_timed` runs.
- `rotation_timed` and `assisted_timed` runs retain a timed run result but do not create or
  overwrite the canonical best.
- `relaxed` and legacy unknown-time runs never create or overwrite a timed best.
- `totalCompletions` counts every completed run, regardless of result class or timing quality.
- Undo/redo history is runtime-only. A restored snapshot becomes the new history baseline.
- The active session remains device-local. Only completion statistics are sent to the server.

## Architecture

The session implementation will live under
`apps/web/src/lib/services/gameplay/session/` in four focused units:

- `types.ts` defines runtime state, persisted state, actions, outcomes, lifecycle, mode,
  counters, timing quality, completion status, and typed events.
- `session.ts` contains the framework-independent transition engine and its invariants.
- `persistence.ts` contains the versioned codec, migrations, validation, and resilient
  local-storage adapter.
- `store.ts` is a thin Svelte-readable wrapper that dispatches actions and exposes state.

`ResultClass` and versioned completion request/response types belong in `@perseus/types`
because the web client and both API runtimes must share the same bounded contract.

The puzzle route remains responsible for:

- resolving and loading API or Quick Puzzle sources;
- rendering and adapting DOM events to session actions;
- pointer, gesture, focus, modal, and temporary animation state;
- board measurements and other DOM-derived viewport constraints;
- local-storage, local-stat, completion-API, and future analytics adapters.

Pure helpers for layout, zoom constraints, jigsaw geometry, rotation math, and hint candidate
selection remain separate from the session engine.

## Runtime State

The runtime session owns:

```ts
type SessionLifecycle = 'setup' | 'active' | 'paused' | 'completed' | 'disposed';
type SessionMode = 'timed' | 'relaxed';
type TimingQuality = 'known' | 'legacy_unknown';
type PuzzleSourceType = 'api' | 'local';
type ResultClass = 'standard_timed' | 'rotation_timed' | 'assisted_timed' | 'relaxed';
```

The complete state contains:

- puzzle ID, source type, and immutable puzzle placement metadata;
- lifecycle, mode, run ID, and `new | resumed` origin;
- elapsed active seconds, timer-started state, and timing quality;
- placed pieces and canonical tray order;
- rotation mode and per-piece rotations;
- selected piece;
- runtime-only undo/redo history;
- hint-use, reference-use, and incorrect-attempt counters;
- assistance facts needed to derive result eligibility;
- a sealed completion record plus separate local-stat and server-submission statuses;
- optional/versioned viewport and inventory-organization fields.

The organization extension fields are:

- persisted viewport state when a consuming feature explicitly opts into it;
- inventory filter;
- preview size;
- active tray;
- staging membership;
- tray names.

Fields may be absent until their owning feature is implemented. The codec must preserve
recognized optional fields without requiring the current route to populate them.

## Lifecycle and Timing

A fresh session starts in `setup`. To preserve the current no-setup experience, the puzzle
route dispatches `start` immediately after creating a fresh session. Restored `active`,
`paused`, or `completed` lifecycle is not overwritten. HPA-221 can later stop auto-starting
fresh sessions and present the setup UI without changing domain semantics.

Starting a session moves it to `active`, but a new timed session does not begin accumulating
time until its first counted gameplay action. Counted actions match current behavior:

- a placement attempt;
- a rotation-mode change;
- a piece rotation.

Hints and ordinary reference viewing do not start the timer in this foundation change.

An explicit pause moves `active` to `paused` and checkpoints elapsed time. Resume returns a
paused session to `active`. A hidden tab suspends the clock without changing persisted
lifecycle. Visibility restoration restarts the clock only when the lifecycle is `active` and
the timer had already started. Explicitly paused sessions never auto-resume on visibility.

The in-process clock uses an injected scheduler/time source so tests can advance it
deterministically. Persisted time is expressed as whole active seconds. A known timed
completion is clamped to at least one second when producing the completion request, preserving
the API's current minimum for very fast small puzzles.

Completing the last unique piece moves the session to `completed` and seals a completion
record. Undo may return board state and lifecycle to `active`, matching current behavior, but
the completion record remains sealed. Redo may restore the completed board without emitting
another completion. Time accumulated after that sealed completion cannot replace the sealed
run result.

Restart:

- creates a new cryptographically random run ID;
- clears placements, selection, active rotation state, history, counters, assistance, and
  completion state;
- generates and persists a fresh canonical tray order;
- retains applicable mode and organization preferences;
- returns to `setup`, after which the current route immediately starts the new run.

Resetting active rotation preserves the current Play Again behavior. A future setup feature
may add a separate preferred-rotation setting without treating the completed run's active
rotation state as that preference.

`disposed` is terminal. All gameplay actions become typed no-ops after disposal. Disposal is
runtime-only: the route checkpoints the last resumable state before disposal, and the
serializer never writes `disposed` as a restorable lifecycle.

## Result Classification

Timed result classes can only become less competitive during a run:

```text
standard_timed -> rotation_timed -> assisted_timed
```

Rules:

- A timed run starts as `standard_timed` unless restored state already has a less competitive
  class.
- Enabling rotation makes a standard run `rotation_timed`.
- Using a hint or future Ghost Reference makes any timed run `assisted_timed`.
- Ordinary hold/toggle reference viewing does not alter result class in version 1.
- Once assisted, disabling a mode or undoing gameplay does not restore eligibility.
- A relaxed run remains `relaxed`.
- Restoring a session preserves its stored class; subsequent assistance may still downgrade it.

Canonical-best eligibility requires all of:

- result class is `standard_timed`;
- timing quality is `known`;
- elapsed active time is present;
- the run has a sealed completion.

The server derives eligibility from the bounded request fields. It does not accept a
client-provided boolean eligibility override.

## Action Contract and Invariants

The public action contract includes:

```ts
type PuzzleSessionAction =
	| { type: 'start' }
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'restart' }
	| { type: 'dispose' }
	| { type: 'select_piece'; pieceId: number }
	| { type: 'cancel_selection' }
	| { type: 'set_rotation_mode'; enabled: boolean }
	| { type: 'rotate_piece'; pieceId: number }
	| { type: 'attempt_placement'; pieceId: number; x: number; y: number }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'use_hint' }
	| { type: 'use_reference'; mode: ReferenceMode }
	| { type: 'update_tray_organization'; update: TrayOrganizationUpdate }
	| { type: 'retry_completion_submission' };
```

`attempt_placement` is the sole placement entry point. The session validates:

- lifecycle permits gameplay;
- the piece exists and is not already placed;
- target coordinates match the piece's canonical coordinates;
- rotation is upright when rotation mode requires it;
- the mutation preserves placement uniqueness.

The outcome is a bounded accepted or rejected value. Rejection reasons distinguish real
gameplay failures such as wrong slot or non-upright rotation from disabled lifecycle,
duplicate, or malformed programmatic requests. Only real gameplay rejection increments the
incorrect-attempt counter.

Mouse, direct drag, future touch tap-to-place, and keyboard interaction translate into this
same action. No input path may directly edit placements or invoke completion.

History snapshots cover placements, per-piece rotations, and rotation-mode state, matching
current behavior. Selection, counters, assistance class, and sealed completion facts are not
rolled back.

The transition engine never partially mutates state. Invalid user actions return typed no-op
or rejection outcomes. Construction may throw only when programmer-supplied puzzle metadata
violates required invariants.

## Typed Events and External Effects

The engine exposes typed events through an injected callback and imports no analytics
provider. Events include lifecycle changes, selection, placement acceptance/rejection,
rotation, undo/redo, hint/reference use, restart, completion, submission failure, and
submission success.

Once-per-run events are guarded by persisted session facts:

- completion atomically seals a record keyed by run ID before emitting;
- undo/redo cannot clear that seal;
- retries reuse the same run ID;
- an acknowledgement must match the active run ID;
- delayed responses from an earlier run are ignored.

The route adapter responds to the completion event by:

1. recording the run in local stats once;
2. submitting API-puzzle completions to the server;
3. acknowledging success or failure to the session using the run ID;
4. opening the existing transient celebration UI.

Quick Puzzle completion remains local and is acknowledged without an API request.

A server failure leaves the completion sealed and retryable. It does not undo local
completion or block celebration. A local-storage or local-stat failure is reported through a
typed error hook but never blocks play.

## Persisted Session Schema

The existing `puzzle-progress-${puzzleId}` key remains in use. Its new payload has
`schemaVersion: 1`.

The serialized projection contains:

- schema version;
- puzzle ID and source;
- lifecycle, mode, run ID, and new/resumed origin;
- `elapsedActiveSeconds: number | null`;
- timing quality and timer-started state;
- placed pieces and canonical tray order;
- rotation mode and piece rotations;
- run counters and assistance facts;
- result class;
- sealed completion, local-stat status, and server-submission status, when present;
- recognized optional organization fields;
- numeric `lastUpdated` in epoch milliseconds.

The serializer is an allowlist projection. It cannot include selection, history, pointers,
drag/gesture state, focus, dialogs, modal visibility, active hint highlighting, rejection
animation, DOM elements, measurements, or clock handles.

Timer changes are checkpointed periodically rather than writing local storage every second.
Persistence also runs immediately after meaningful gameplay actions, explicit pause,
visibility suspension, completion, and restart, plus best-effort on page exit.

## Legacy Migration

An unversioned progress record is legacy version 0. Migration requires the resolved puzzle
and source as validation context and produces version 1 deterministically:

- mode becomes `timed`;
- `elapsedActiveSeconds` becomes `null`;
- timing quality becomes `legacy_unknown`;
- timer-started is true when the legacy record contains any placement, has rotation enabled,
  or contains a non-zero piece rotation; otherwise it is false;
- source comes from the resolved puzzle source;
- missing tray order is generated by sorting piece IDs, then applying a stable
  puzzle-ID-seeded shuffle;
- the run ID is derived from a stable hash of the canonical legacy payload and receives a
  reserved `legacy-` prefix;
- missing counters become zero;
- rotation fields use the current compatibility defaults;
- result class reflects known rotation state;
- origin becomes `resumed`;
- lifecycle becomes `completed` only if every unique puzzle piece is validly placed,
  otherwise `active`;
- an existing ISO `lastUpdated` is converted to epoch milliseconds; a missing or invalid
  value becomes `0` so migration never manufactures false recency.

Legacy unknown-time runs may continue accumulating post-migration active time for display,
but their timing quality remains `legacy_unknown` for that run. They can count as a
completion and submit a nullable time, but they cannot create a canonical best.

The migrated payload is written back best-effort. A failed write does not stop hydration or
play.

## Validation and Compatibility

Every load validates:

- supported schema version;
- matching puzzle ID and source;
- lifecycle, mode, result class, timing quality, and their cross-field consistency;
- finite non-negative elapsed time and timestamp values;
- run ID shape;
- unique, known, in-bounds placements;
- a tray order containing every piece exactly once;
- valid rotation values and known piece IDs;
- non-negative integer counters;
- completion/run consistency;
- optional organization fields when present.

Malformed records return a typed invalid status and are ignored; the next valid session
checkpoint may replace them. Records with a future schema version return an incompatible
status and put that session in persistence-read-only mode, so an older client cannot overwrite
newer data. Play remains available in memory in both cases. Future Continue Mission work
excludes invalid and incompatible records. The codec never partially hydrates invalid data.

## Local Statistics

The existing `puzzle-stats-${puzzleId}` key migrates to a versioned local-stat shape:

```ts
interface PuzzleStatsV1 {
	schemaVersion: 1;
	puzzleId: string;
	standardBestTime: number | null;
	standardBestCompletedAt: number | null;
	totalCompletions: number;
	lastCompletedAt: number;
	lastRecordedRunId: string | null;
}
```

Existing unversioned `bestTime`, `completedAt`, and `totalCompletions` values migrate as a
standard best and historical completion count, with no recorded run ID.

Recording a sealed run always increments `totalCompletions` once. Only an eligible
`standard_timed` completion may create or improve `standardBestTime`. UI consumers expose the
standard best through the existing `getBestTime` compatibility function and render no best
badge when the value is null. `lastRecordedRunId` makes retrying or rehydrating the current
completed session idempotent without retaining an unbounded local run history. This is safe
because each puzzle has one persisted active/latest session key; restart replaces that
snapshot before a later run can complete.

## Completion API

The new shared request is versioned:

```ts
interface RecordPuzzleCompletionV1 {
	version: 1;
	runId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
}
```

Validation requires:

- `relaxed` requests to use `elapsedActiveSeconds: null`;
- every `legacy_unknown` request to use `elapsedActiveSeconds: null`;
- known timed requests to provide a finite whole-second time within the existing maximum;
- a bounded result class and timing quality;
- a valid run ID.

Both Bun and Worker routes use one shared validator and repository contract.

For deployment compatibility, the endpoint also accepts the existing `{ timeSeconds }`
request. It records that request through the legacy standard-timed path, including the
existing rapid-retry deduplication. This supports already-loaded clients while the new web
bundle rolls out. Legacy requests continue incrementing the historical baseline field;
versioned requests use the run ledger and never increment that baseline.

## D1 Completion and Stats Model

The D1 change is additive. A new completion-run ledger stores:

- player ID and run ID as a unique key;
- puzzle ID;
- result class;
- timing quality;
- nullable elapsed active seconds;
- completion timestamp.

`puzzle_stats` remains the canonical standard-best table. Existing rows are treated as:

- an eligible historical standard best;
- a pre-ledger historical `totalCompletions` baseline;
- historical first/last completion timestamps.

New versioned completions are inserted into the run ledger idempotently. New completion
totals are calculated as the historical baseline plus ledgered runs. Eligible standard runs
also upsert the canonical best using minimum-time semantics; that upsert is safe to repeat
independently of whether the ledger insert was new. Versioned runs do not increment the
historical baseline field.

This avoids changing the physical `best_time_seconds NOT NULL` column. The public profile/stat
read model instead starts from the union of historical stats and ledgered completions, then
left-joins the standard-best row. Consequently:

- `bestTimeSeconds` becomes `number | null` in public shared types;
- a player can have completions without a standard best;
- totals include all result classes;
- gallery/profile surfaces display a best only when it exists;
- sorting puts rows with standard bests in the existing ascending order and defines a stable
  placement for null-best rows: standard-best rows sort first by ascending time, followed by
  null-best rows, with puzzle ID as the tiebreaker in both groups;
- pagination cursors encode `(hasStandardBest, bestTimeSeconds, puzzleId)` so nullable-best
  ordering remains stable across pages.

The player summary's puzzles-solved and total-completion counts use the same combined read
model so profile tiles and stat rows cannot disagree.

## Route Integration

Puzzle loading follows this sequence:

1. Resolve and load the API or Quick Puzzle source.
2. Load, migrate, and validate persisted session state using that puzzle as context.
3. Create one `PuzzleSession` store from the snapshot or fresh defaults.
4. Subscribe to state/events for persistence, stats, API completion, and future analytics.
5. Bind route/component props to session-derived state.

The extraction proceeds behavior-by-behavior:

1. hydration and persisted projection;
2. selection and placement;
3. rotation and history;
4. timing and lifecycle;
5. hints, reference facts, and counters;
6. completion and local/server statistics;
7. removal of obsolete route-owned stores and booleans.

The route's current timer store, global selection store, history instance, completion token,
completion boolean, placements, rotations, tray order, and counters are removed from the
gameplay path after their session-backed replacements are covered.

Completion presentation remains transient. Reloading a completed snapshot preserves the
completion seal and prevents resubmission, but does not automatically reopen the current
celebration modal. Any record with a sealed completion is excluded from future Continue
Mission discovery even if undo changed its lifecycle back to `active`; it may be cleaned up by
that feature's retention policy.

## Testing

### Pure session tests

Cover:

- lifecycle transition matrix and invalid-action no-ops;
- new and restored timing;
- first-action timer start;
- explicit pause/resume;
- hidden-tab suspension without explicit-pause auto-resume;
- disposal;
- selection and cancellation;
- accepted and rejected placement;
- rotation requirements;
- undo/redo boundaries;
- counter behavior across undo/redo;
- result-class monotonicity;
- restart with new run ID and retained preferences;
- exactly-once completion;
- retry and stale acknowledgement behavior.

### Codec and storage tests

Cover:

- version 1 round trip;
- allowlisted serialization and transient-field exclusion;
- deterministic migration of representative legacy records;
- unknown elapsed time and best ineligibility;
- malformed JSON and malformed fields;
- future version handling;
- puzzle/source mismatch;
- placement/tray/rotation validation;
- timer restoration;
- storage read/write exceptions.

### Local stats, API, and D1 tests

Cover:

- local-stat migration;
- all-class completion totals;
- standard-only best creation and improvement;
- null best for variant-only completion history;
- run-ledger idempotency;
- repeated eligible-best upsert safety;
- legacy request compatibility;
- request validation for every result class and timing quality;
- player summary and stat-row consistency;
- nullable-best ordering and pagination;
- Bun/Worker route parity.

### Route regression tests

Prove that mouse, touch-oriented component events, and keyboard dispatch the same domain
actions. Retain coverage for:

- Undo and Redo;
- Hint and Reference;
- Zoom and Fit;
- Rotation;
- saved-progress resume;
- Quick Puzzle local-only completion;
- completion modal and delayed API callbacks;
- storage and API failure behavior.

## Verification

During extraction, run focused session, codec, stats, repository, API-route, and puzzle-route
tests. Before completion, run:

- the full web unit suite;
- API and shared package suites;
- repository type checking;
- linting;
- production build;
- existing gameplay E2E coverage.

No browser-visible redesign is part of this foundation ticket, so validation is
source/test-driven unless a regression requires a browser reproduction.

## Non-Goals

- Cloud synchronization of active sessions.
- Public leaderboard anti-cheat.
- A new toolbar, mobile tray, staging interface, or completion report.
- The HPA-221 mission setup/pause UI.
- The HPA-222 reference-mode UI.
- Choosing or importing an analytics provider.
- Separate personal bests for rotation or assisted result classes.
