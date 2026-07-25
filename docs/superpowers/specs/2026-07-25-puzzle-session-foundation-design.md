# PuzzleSession Foundation Design

- **Issue:** HPA-236
- **Date:** 2026-07-25
- **Status:** Approved design

## Objective

Extract the puzzle route's run state and transitions into one testable `PuzzleSession` domain
layer. The layer will own lifecycle, timing, placements, rotation, history, counters, result
eligibility, completion idempotency, and versioned device-local persistence before the gameplay
UX workstreams in HPA-218 through HPA-224 add more interaction paths and persisted fields.

The extraction preserves current interaction behavior except for the deliberate product and
persistence changes listed below. It does not add the future mission setup UI, mobile tray,
staging UI, analytics provider, or completion report.

## Product Decisions

The following decisions are fixed for this implementation:

- The existing canonical personal best is available only to eligible `standard_timed` runs.
- `rotation_timed` and `assisted_timed` runs retain a timed run result but do not create or
  overwrite the canonical best.
- `relaxed` and legacy unknown-time runs never create or overwrite a timed best.
- `totalCompletions` counts every completed run, regardless of result class or timing quality.
- Undo/redo history is runtime-only. A restored snapshot becomes the new history baseline.
- The active session remains device-local. Only completion statistics are sent to the server.

### Deliberate Behavior Changes

These changes are part of HPA-236 and must not be treated as extraction regressions:

- Rotation-enabled solves currently write the canonical best; they become `rotation_timed`
  and no longer do so.
- Hint use currently has no best-time effect; it permanently makes a timed run
  `assisted_timed`.
- Resume currently resets the timer to zero and reshuffles the tray; new-schema sessions
  restore known elapsed time and canonical tray order.
- Completion currently has only route-memory guards; the sealed run result now survives
  reload and prevents duplicate local/server accounting.
- Play Again currently deletes the progress key; restart writes a fresh non-resumable session
  snapshot so applicable organization preferences can survive.
- Malformed stats cursors currently degrade to an empty or legacy time-only filter; unknown or
  malformed cursor formats now return `bad_request`.

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
- monotonic rotation/assistance facts needed to derive result eligibility;
- a persisted `hasUserActivity` fact used by resume discovery;
- a sealed completion record plus separate local-stat and server-submission statuses;
- optional/versioned viewport and inventory-organization fields.

The organization extension fields are:

- persisted viewport state when a consuming feature explicitly opts into it;
- inventory filter;
- active tray;
- staging membership;
- tray names.

Fields may be absent until their owning feature is implemented. The codec must preserve
recognized optional fields without requiring the current route to populate them.

Preview size is not PuzzleSession state. HPA-220 defines it as a device-local user preference
that applies across runs, so its owning preference store persists it separately. Components
may consume that preference alongside session state without adding it to the session
serializer.

Fresh run IDs are canonical lowercase UUID v4 strings created with `crypto.randomUUID()`.
The engine receives an injectable ID factory for deterministic tests. Migrated records use
`legacy-${sha256}`, where `sha256` is the 64-character lowercase hexadecimal SHA-256 digest of
the stable canonical JSON form of the legacy payload. Shared run-ID validation accepts exactly
those two shapes. Canonical JSON recursively sorts object keys, preserves array order, omits
undefined object properties, and otherwise uses standard JSON primitive serialization. The
hash includes the original legacy `lastUpdated` value and is computed before migration
normalizes or writes any field, so a failed migration write produces the same run ID on retry.

## Lifecycle and Timing

A fresh session starts in `setup`. To preserve the current no-setup experience, the puzzle
route dispatches `start` immediately after creating a fresh session. Restored `active`,
`paused`, or `completed` lifecycle is not overwritten. HPA-221 can later stop auto-starting
fresh sessions and present the setup UI without changing domain semantics.

Starting a session moves it to `active`, but a new timed session does not begin accumulating
time until its first counted gameplay action. Counted actions match current behavior:

- a placement attempt;
- a piece rotation.

Changing rotation mode, using hints, and ordinary reference viewing do not start the timer.
Enabling rotation still records the monotonic `rotationUsed` fact and changes result class
immediately.

An explicit pause moves `active` to `paused` and checkpoints elapsed time. Resume returns a
paused session to `active`. A hidden tab suspends the clock without changing persisted
lifecycle. Visibility restoration restarts the clock only when the lifecycle is `active` and
the timer had already started. Explicitly paused sessions never auto-resume on visibility.
The clock runs only for `timed` sessions with `known` timing quality; relaxed and legacy
unknown-time sessions keep a null elapsed value.

The engine and timer presentation share one injected `Clock`/scheduler interface; no residual
UI timer advances independently. Tests can advance that clock deterministically. Persisted
time and live display use whole active seconds and may show `00:00`. A known timed completion
is clamped to at least one second only when sealing the completion/request payload, preserving
the API's current minimum without changing the live display.

Completing the last unique piece moves the session to `completed` and seals a completion
record. Undo may return board state and lifecycle to `active`, matching current behavior, but
the completion record remains sealed. Redo may restore the completed board without emitting
another completion. Time accumulated after that sealed completion cannot replace the sealed
run result. If the player undoes and then makes a fresh placement that completes the board
again, the existing seal makes that crossing a completion no-op: it emits no completion event,
does not resubmit, and does not increment local or server totals.

Restart:

- creates a new UUID v4 run ID with `crypto.randomUUID()`;
- clears placements, selection, active rotation state, history, counters, assistance, and
  completion state;
- generates and persists a fresh canonical tray order;
- retains applicable mode and organization preferences;
- resets `hasUserActivity` to false;
- returns to `setup`, after which the current route immediately starts the new run.

Restart is valid from `active`, `paused`, and `completed`. It returns a typed
`nothing_to_restart` no-op from `setup` and a `disposed` no-op from `disposed`.

Resetting active rotation preserves the current Play Again behavior. A future setup feature
may add a separate preferred-rotation setting without treating the completed run's active
rotation state as that preference.

`disposed` is terminal for one in-memory PuzzleSession instance and represents route/component
unmount, not player abandonment. All actions on that instance become typed no-ops. The route
checkpoints the last resumable state before disposal, so loading the puzzle later constructs a
new instance from that snapshot. The serializer never writes `disposed` as a restorable
lifecycle. HPA-236 requires the `disposed` lifecycle name; clearing or abandoning persisted
progress is a separate storage action.

The current route has no explicit pause control. It wires visibility suspension only;
`pause`/`resume` exist for domain tests and HPA-221 integration but are not dispatched by
today's UI. Therefore this foundation route cannot create a persisted paused session. HPA-221
must add a visible resume path before wiring explicit pause persistence into the route.

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
- Dispatching `use_reference` with `hold` or `toggle` records one deliberate activation but
  does not alter result class in version 1.
- Dispatching `use_reference` with `ghost` records one deliberate activation and makes a timed
  run `assisted_timed`.
- Reference counters increment only on an inactive-to-active mode transition. Repeated
  pointer-down or key-repeat events while the same reference mode is already active do not
  increment again.
- Once rotation or assistance has been used, disabling it or undoing gameplay does not restore
  eligibility. Undo may restore `rotationEnabled` from history, while the non-historical
  `rotationUsed` fact and `rotation_timed` result class remain.
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
	| { type: 'complete' }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'use_hint' }
	| { type: 'use_reference'; mode: ReferenceMode }
	| { type: 'update_tray_organization'; update: TrayOrganizationUpdate }
	| {
			type: 'acknowledge_completion_effect';
			runId: string;
			effect: CompletionEffect;
			outcome: 'succeeded' | 'failed';
	  }
	| { type: 'retry_completion_effects' };

type ReferenceMode = 'hold' | 'toggle' | 'ghost';
type CompletionEffect = 'local_stats' | 'server_submission';
type CompletionEffectStatus = 'pending' | 'succeeded' | 'failed' | 'not_applicable';
type InventoryFilter = 'all' | 'corners' | 'edges' | 'center';
type TrayOrganizationUpdate =
	| { type: 'reorder'; trayId: string; pieceIds: number[] }
	| { type: 'set_filter'; filter: InventoryFilter }
	| { type: 'set_active_tray'; trayId: string }
	| { type: 'move_piece'; pieceId: number; toTrayId: string }
	| { type: 'rename_tray'; trayId: string; name: string }
	| { type: 'remove_tray'; trayId: string };
```

These organization variants establish the invariant-preserving domain boundary. HPA-220 and
HPA-237 own the UI, naming constraints, and availability rules for their respective variants.

`attempt_placement` is the sole placement entry point. The session validates:

- lifecycle permits gameplay;
- the piece exists and is not already placed;
- target coordinates are finite integers within the puzzle grid and match the piece's
  canonical coordinates exactly;
- rotation is upright when rotation mode requires it;
- the mutation preserves placement uniqueness.

An accepted final placement invokes the same guarded `complete` transition exposed in the
action union. Dispatching `complete` directly is a no-op unless every unique piece is validly
placed and the run has no completion seal, so it cannot bypass placement validation.
`complete` remains public because it is part of the HPA-236 action contract; the full-board
guard, rather than caller privacy, is the safety boundary.

The outcome is a bounded accepted or rejected value. Rejection reasons distinguish real
gameplay failures such as wrong slot or non-upright rotation from disabled lifecycle,
duplicate, or malformed programmatic requests. Only real gameplay rejection increments the
incorrect-attempt counter. A duplicate request—such as one from stale keyboard state—is a
silent no-op because the UI should already prevent it; it is not counted as a player mistake.
Wrong-slot and non-upright outcomes count once and emit the rejection event used by the route's
temporary animation. Unknown pieces, invalid coordinates, duplicates, and disallowed
lifecycle are non-counting no-ops.

Mouse, direct drag, future touch tap-to-place, and keyboard interaction translate into this
same action. No input path may directly edit placements or invoke completion.

History snapshots cover placements, per-piece rotations, and rotation-mode state, matching
current behavior. Selection, counters, `rotationUsed`, assistance class, and sealed completion
facts are not rolled back.

The transition engine never partially mutates state. Invalid user actions return typed no-op
or rejection outcomes. Construction may throw only when programmer-supplied puzzle metadata
violates required invariants.

## Typed Events and External Effects

The engine exposes typed events through an injected callback and imports no analytics
provider. Events include lifecycle changes, selection, placement acceptance/rejection,
rotation, undo/redo, hint/reference use, restart, completion, and completion-effect requests,
failures, and successes.

Once-per-run events are guarded by persisted session facts:

- completion atomically seals a record keyed by run ID before emitting;
- undo/redo cannot clear that seal;
- retries reuse the same run ID;
- an acknowledgement must match the active run ID;
- delayed responses from an earlier run are ignored.

The route adapter responds to the completion event by:

1. comparing against the loaded local standard best and computing the in-memory completion
   presentation;
2. recording the run in local stats once;
3. submitting API-puzzle completions to the server;
4. acknowledging each effect's success or failure to the session using the run ID;
5. opening the existing transient celebration UI.

Quick Puzzle completion remains local and is acknowledged without an API request.

The sealed completion stores separate local-stat and server statuses using
`pending | succeeded | failed | not_applicable`. Local status is `pending` for every new
completion. Server status is `pending` for API sources and `not_applicable` for Quick Puzzles.
`retry_completion_effects` re-emits only pending/failed effects for the same seal; local
`lastRecordedRunId` and the server ledger make those retries idempotent. A retry moves a
failed effect back to `pending` before emitting its request. A matching acknowledgement then
moves `pending` to `succeeded` or `failed`; acknowledgements for another run or a terminal
effect are no-ops.

Hydrating a sealed completion automatically retries each pending/failed applicable effect
once. There is no periodic background retry in this foundation. Failure leaves the completion
sealed, does not block celebration, and is reported through a typed error hook. An in-memory
new-best result remains available for the current celebration even when its local-stat write
fails; the UI must not claim that the best persisted successfully.

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
- run counters, `hasUserActivity`, and monotonic rotation/assistance facts;
- result class;
- sealed completion, local-stat status, and server-submission status, when present;
- recognized optional organization fields;
- numeric `lastUpdated` in epoch milliseconds.

For a fresh known timed run, `elapsedActiveSeconds` is `0` even before the timer starts.
`null` is reserved for relaxed sessions and legacy unknown-time sessions. A
`legacy_unknown` run keeps `elapsedActiveSeconds: null` for its lifetime; this design chooses
not to manufacture or display a partial post-migration solve time.

The serializer is an allowlist projection. It cannot include selection, history, pointers,
drag/gesture state, focus, dialogs, modal visibility, active hint highlighting, rejection
animation, DOM elements, measurements, or clock handles.

Timer changes are checkpointed periodically rather than writing local storage every second.
Persistence also runs immediately after meaningful gameplay actions, explicit pause,
visibility suspension, completion, and restart, plus best-effort on page exit.

The persistence module exports `isResumable(snapshot)`. It returns true only when lifecycle is
`active` or `paused`, no completion seal exists, and `hasUserActivity` is true. Counted
placement attempts, accepted piece rotations, rotation-mode changes, hint/reference
activations, and tray-organization mutations set `hasUserActivity`; malformed, duplicate, or
otherwise silent no-op actions do not. Fresh start and restart reset it. `setup`, untouched
auto-started sessions, and sealed-complete snapshots are never offered by Continue Mission.

The serializer remains linear in piece count and excludes history. Tests cover a representative
225-piece snapshot and storage quota exceptions; a quota failure reports through the error
hook and does not block the in-memory session.

## Legacy Migration

An unversioned progress record is legacy version 0. Migration requires the resolved puzzle
and source as validation context and produces version 1 deterministically:

- mode becomes `timed`;
- `elapsedActiveSeconds` becomes `null`;
- timing quality becomes `legacy_unknown`;
- timer-started is true when the legacy record contains any placement or a non-zero piece
  rotation; rotation mode alone does not imply that the current timer had started;
- source comes from the resolved puzzle source;
- missing tray order is generated by sorting numeric piece IDs ascending, then applying
  Fisher-Yates using a Mulberry32 PRNG seeded with the 32-bit FNV-1a hash of the UTF-8 puzzle
  ID string;
- the run ID is `legacy-` plus the lowercase SHA-256 digest of stable canonical legacy JSON;
- missing counters become zero;
- `hasUserActivity` is true when the legacy record contains a placement, enabled rotation
  mode, or a non-zero piece rotation; otherwise it is false;
- rotation fields use the current compatibility defaults;
- result class reflects known rotation state;
- origin becomes `resumed`;
- lifecycle becomes `completed` only if every unique puzzle piece is validly placed,
  otherwise `active`;
- an existing ISO `lastUpdated` is converted to epoch milliseconds; a missing or invalid
  value becomes `0` so migration never manufactures false recency.

Legacy unknown-time runs remain untimed for the rest of that run. They can count as a
completion and submit a null time, but they cannot create a canonical best. Restart creates a
new known-time run with a UUID v4 run ID and normal timing.

The migrated payload is written back best-effort. A failed write does not stop hydration or
play. Because legacy records did not persist tray order, the first migrated load deliberately
uses the new deterministic order rather than reproducing the unrecorded random order from the
player's previous page load.

## Validation and Compatibility

Every load validates:

- supported schema version;
- matching puzzle ID and source;
- a restorable lifecycle, excluding `disposed`;
- lifecycle, mode, result class, timing quality, monotonic rotation/assistance facts, and their
  cross-field consistency;
- finite non-negative whole-second elapsed time and finite non-negative timestamp values;
- a canonical lowercase UUID v4 or `legacy-` followed by exactly 64 lowercase hexadecimal
  characters;
- unique, known, in-bounds placements;
- a tray order containing every piece exactly once;
- valid rotation values and known piece IDs;
- non-negative integer counters;
- boolean `hasUserActivity`;
- completion/run consistency, including that effect statuses exist only for a seal, local
  status is never `not_applicable`, and server status is `not_applicable` only for local
  sources;
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
standard best and historical completion count, with no recorded run ID. Both
`standardBestCompletedAt` and `lastCompletedAt` use epoch milliseconds; migration parses the
existing ISO `completedAt` string into that unit.

Recording a sealed run always increments `totalCompletions` once. Only an eligible
`standard_timed` completion may create or improve `standardBestTime`. UI consumers expose the
standard best through the existing `getBestTime` compatibility function and render no best
badge when the value is null. `lastRecordedRunId` makes retrying or rehydrating the current
completed session idempotent without retaining an unbounded local run history. This is safe
because each puzzle has one persisted active/latest session key; restart replaces that
snapshot before a later run can complete.

Local and server statistics are independent mirrors of a completion. Temporary divergence is
acceptable when one write succeeds and the other fails. Device-local gallery/session UI reads
local stats; authenticated profile views read server stats. The session can retry either
failed effect while its completion record remains available, and hydration automatically
attempts each pending/failed applicable effect once. This foundation does not reconcile local
stats from the server or server stats from local storage.

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

type RecordPuzzleCompletionResponse =
	| { ok: true }
	| { error: 'bad_request'; message: string }
	| { error: 'unauthorized'; message: string }
	| { error: 'run_id_conflict'; message: string };
```

Validation requires:

- `relaxed` requests to use `timingQuality: 'known'` and
  `elapsedActiveSeconds: null`;
- every `legacy_unknown` request to use `elapsedActiveSeconds: null` and a timed result class;
- known non-relaxed requests to provide a positive finite whole-second time within the existing
  maximum;
- a bounded result class and timing quality;
- a valid run ID.

Invalid JSON, fields, or timing combinations return HTTP 400. Authentication failure remains
HTTP 401. Reusing a run ID with different completion facts returns HTTP 409 with
`run_id_conflict`. Both Bun and Worker routes use one shared validator and repository contract;
their runtime shells only supply auth, puzzle lookup, and database adapters.

For a versioned request, the server upserts a canonical best only when
`resultClass === 'standard_timed'`, `timingQuality === 'known'`, and
`elapsedActiveSeconds !== null`. The sealed-completion fact is a client/session invariant; a
valid versioned completion request represents that sealed result at the server boundary.
Checking result class alone is never sufficient.

The server trusts the authenticated client's reported result class and assistance facts. The
bounded validator rejects internally inconsistent payloads but cannot prove that a client did
not lie. Public leaderboard anti-cheat remains a non-goal, and the impact is limited to the
player's own statistics.

For deployment compatibility, the endpoint also accepts the existing `{ timeSeconds }`
request. It records that request through the legacy standard-timed path, including the
existing rapid-retry deduplication. This supports already-loaded clients while the new web
bundle rolls out. Legacy requests continue incrementing the historical baseline field;
versioned requests use the run ledger and never increment that baseline.

A versioned completion followed by a stale tab's legacy request can count the same solve once
in the ledger and once in the historical baseline. The legacy path retains its existing
30-second heuristic, but it cannot correlate a request that has no run ID with the ledger
perfectly. This rare, self-scoped double count is an accepted rollout risk; compatibility is
preferred to rejecting already-loaded clients.

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

The ledger key is `(player_id, run_id)`. Puzzle ID is deliberately not part of that key, so a
run cannot be retargeted to another puzzle.

If a run ID already exists, puzzle ID, result class, timing quality, and elapsed time must
exactly match the ledger row. An exact replay continues idempotently and safely re-evaluates
the conditional best upsert, repairing an absent or stale best row if one predates this atomic
repository path. That repair reuses the ledger's original completion timestamp rather than
treating the retry as a later completion. Reusing a run ID with different facts returns
`conflict` and performs no stats mutation; callers cannot launder an assisted run into a
standard best by changing a retry payload.

The ledger insert/check and conditional best upsert form one atomic repository operation. The
Worker adapter executes the statements in one D1 batch; the Bun adapter uses a SQLite
transaction. The D1 sequence inserts-or-ignores the ledger row, reads the stored facts, and
performs the best upsert through a predicate that matches both the request and stored ledger
row. The caller inspects the stored facts to distinguish an exact replay from HTTP 409
conflict. Any statement failure rolls back the write unit.

Only a versioned request satisfying the full canonical-best predicate may insert or update
`puzzle_stats`. Rotation, assisted, relaxed, and legacy-unknown runs are ledger-only and never
create a `puzzle_stats` row. When a player's first eligible standard completion creates that
row, it explicitly initializes the historical baseline `totalCompletions` field to `0`; the
new run is already counted by the ledger.

`deletePuzzleStats` becomes a companion cleanup operation that atomically deletes both
`puzzle_stats` and completion-ledger rows for the puzzle ID. Existing admin deletion and reaper
paths continue calling that helper, so deleted puzzles cannot leave ledger-only totals or
summary/list disagreement. Repository, admin-route, and reaper tests cover the companion
cleanup and its existing best-effort caller behavior.

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
- new pagination cursors use `v2|0|<bestTimeSeconds>|<puzzleId>` for standard-best rows and
  `v2|1||<puzzleId>` for null-best rows. Sort group `0` precedes group `1`.

The stats cursor is independently versioned from the completion request. During rollout, the
parser continues accepting the current `<bestTimeSeconds>|<puzzleId>` composite cursor and
the older bare `<bestTimeSeconds>` fallback, mapping both to sort group `0`. It strictly
validates recognized legacy and `v2` shapes; malformed or unknown versions return
`bad_request` instead of silently changing pagination semantics.

The player summary's puzzles-solved and total-completion counts use the same combined read
model so profile tiles and stat rows cannot disagree.

The nullable-best contract changes `PlayerStatRow`, `isPlayerStatRow`, both player route
projections, profile tests, and the profile UI in this ticket. The profile list is labeled
**Puzzle Results**; rows with no standard best render **No standard time** and never pass null
to `formatTime`. Gallery cards continue omitting the best badge when no standard best exists.

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

The implementation remains one HPA-236 branch/PR but uses independently verified delivery
layers:

1. session engine and route action wiring while retaining the legacy completion payload;
2. versioned session persistence and local statistics;
3. additive D1 migration, atomic completion repository, API v1, combined read model, and
   profile/validator updates;
4. removal of compatibility route state after the full regression gate.

The additive D1 migration must run before publishing Worker code that writes the ledger, using
the repository's existing deploy ordering.

The route's current timer store, global selection store, history instance, completion token,
completion boolean, placements, rotations, tray order, and counters are removed from the
gameplay path after their session-backed replacements are covered.

Completion presentation remains transient. Reloading a completed snapshot preserves the
completion seal and prevents resubmission, but does not automatically reopen the current
celebration modal. Any record with a sealed completion is excluded from future Continue
Mission discovery even if undo changed its lifecycle back to `active`; it may be cleaned up by
that feature's retention policy.

Gallery progress and future Continue Mission consumers call the shared `isResumable` helper;
they do not infer progress from key existence or lifecycle alone.

## Testing

### Pure session tests

Cover:

- lifecycle transition matrix and invalid-action no-ops;
- new and restored timing;
- placement and piece rotation starting the timer;
- rotation-mode toggles not starting the timer while immediately changing result class;
- explicit pause/resume;
- hidden-tab suspension without explicit-pause auto-resume;
- disposal, including that no serializable `disposed` snapshot is produced;
- selection and cancellation;
- accepted placement and the counting/non-counting rejection matrix, including non-integer
  coordinates;
- rotation requirements;
- undo/redo boundaries, including restoring `rotationEnabled` without clearing
  `rotationUsed`;
- counter behavior across undo/redo;
- reference counters incrementing only on inactive-to-active transitions;
- result-class monotonicity;
- `hasUserActivity` transitions and restart with a new run ID, false activity, and retained
  mode/organization preferences;
- exactly-once completion;
- undo followed by a fresh final placement remaining completion-idempotent;
- duplicate placement remaining a non-counting no-op;
- direct completion remaining guarded by full-board state;
- independent local/server completion-effect status transitions;
- retry, one-shot hydration retry, and stale acknowledgement behavior;
- in-memory best presentation surviving a failed local-stat write without claiming
  persistence.

### Codec and storage tests

Cover:

- version 1 round trip;
- allowlisted serialization and transient-field exclusion;
- representative 225-piece round trip, linear-size behavior, and history exclusion;
- `isResumable` across lifecycle, activity, and completion-seal combinations;
- deterministic migration with numeric piece-ID sorting, UTF-8 FNV-1a seeding, and stable tray
  order;
- `legacy-<sha256>` generation from the original canonical legacy JSON, including
  `lastUpdated`, and validator round trip;
- unknown elapsed time and best ineligibility;
- malformed JSON and malformed fields;
- future version handling;
- puzzle/source mismatch;
- placement/tray/rotation/activity/effect-status cross-field validation;
- rejection of persisted `disposed`;
- timer restoration;
- storage read/write and quota exceptions.

### Local stats, API, and D1 tests

Cover:

- local-stat migration;
- all-class completion totals;
- standard-only best creation and improvement;
- null best for variant-only completion history;
- run-ledger idempotency;
- conflicting payload reuse of one run ID being rejected without stats mutation;
- atomic rollback when any ledger/best statement fails;
- repeated eligible-best upsert safety;
- `standard_timed` plus `legacy_unknown` remaining ledger-only;
- non-standard completion never creating a `puzzle_stats` row;
- legacy request compatibility;
- accepted legacy/versioned rollout double-count limitation;
- request validation for every result class and timing quality;
- HTTP 400/401/409 response mapping;
- player summary and stat-row consistency;
- nullable-best ordering and pagination;
- legacy and version 2 cursor parsing plus malformed-version rejection;
- nullable `PlayerStatRow` validation and **No standard time** profile rendering;
- companion ledger cleanup through repository, admin, and reaper paths;
- Bun/Worker route parity.

### Route regression tests

Prove that mouse, touch-oriented component events, and keyboard dispatch the same domain
actions. Retain coverage for:

- Undo and Redo;
- Hint and Reference;
- Zoom and Fit;
- Rotation, including toggle parity that does not start the timer;
- saved-progress resume;
- sealed-session hydration retrying each failed applicable completion effect once;
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
- Multi-tab session coordination. Concurrent tabs for the same puzzle retain today's
  last-write-wins local-storage behavior.
- Automatic reconciliation between device-local and server completion statistics.
