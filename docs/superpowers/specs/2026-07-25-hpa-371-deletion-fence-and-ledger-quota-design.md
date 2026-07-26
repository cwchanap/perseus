# HPA-371 Deletion Fence and Ledger Quota Design

- **Issue:** HPA-371
- **Parent design:** `2026-07-25-puzzle-session-foundation-design.md`
- **Date:** 2026-07-25
- **Status:** Approved corrective design

## Objective

Close three Important findings from the final HPA-371 whole-branch review:

1. completion runtime-context initialization can escape the structured internal-error response;
2. a completion paused after its ready-puzzle check can recreate ownership or statistics after
   puzzle deletion finishes;
3. authenticated players can create an unbounded number of permanent ledger rows with distinct
   client-selected run IDs.

The correction preserves indefinite run-ID idempotency, legacy-request compatibility, the
combined statistics model, and Bun/Worker behavioral parity.

## Fixed Product and Data Decisions

- Run IDs remain idempotent indefinitely. There is no time-based ledger expiry.
- Each player may retain at most `100_000` versioned run rows.
- Exact replay and conflicting reuse of an existing run ID remain available at the quota.
- Only a new run above the quota is rejected.
- Legacy `{ timeSeconds }` completions do not consume versioned-run quota.
- Puzzle deletion frees quota by deleting that puzzle's ledger rows.
- A player-account purge must idempotently delete that player's ledger rows and therefore free
  all quota. It must be safe to rerun after a partial purge. This is a contract for a future
  account-purge feature; HPA-371 does not add a purge helper or endpoint.
- A deleted puzzle ID is permanently fenced and cannot be reused.
- The `100_000` limit is intentionally fixed in migration constraints and triggers. Changing it
  requires a later additive migration rather than an environment-only configuration change.
- Tombstoned completions return structured HTTP 404.
- New versioned runs above quota return structured HTTP 429 with:

```json
{
	"error": "completion_quota_exceeded",
	"message": "Completion history limit reached"
}
```

- Runtime database/context initialization failures return the existing structured HTTP 500
  internal-error body.

## Additive Migration

Add migration `0004` with two tables:

```sql
CREATE TABLE puzzle_deletion_tombstones (
	puzzle_id TEXT PRIMARY KEY NOT NULL,
	deleted_at INTEGER NOT NULL
);

CREATE TABLE player_completion_usage (
	player_id TEXT PRIMARY KEY NOT NULL,
	retained_runs INTEGER NOT NULL
		CHECK (retained_runs BETWEEN 0 AND 100000)
);

INSERT INTO player_completion_usage (player_id, retained_runs)
SELECT player_id, COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;
```

`player_completion_usage.retained_runs` is constrained to the inclusive range `0..100_000`.
Within the same migration file, migration `0004` creates both tables, backfills usage from
`puzzle_completion_runs`, and only then creates the enforcement and maintenance triggers.

The migration also installs database triggers with these responsibilities:

- reject inserts or updates to `puzzles`, `puzzle_stats`, and `puzzle_completion_runs` when the
  target puzzle has a deletion tombstone;
- reject a new ledger row when the player is already at `100_000` retained runs, while allowing
  an existing `(player_id, run_id)` to reach normal replay/conflict interpretation;
- increment usage only after a ledger row is actually inserted;
- decrement usage after a ledger row is deleted and remove zero-valued usage rows.

### Migration trigger appendix

Migration `0004` pins the defense-in-depth trigger behavior:

```sql
CREATE TRIGGER guard_puzzles_not_tombstoned_insert
BEFORE INSERT ON puzzles
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;

CREATE TRIGGER guard_puzzles_not_tombstoned_update
BEFORE UPDATE ON puzzles
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;

CREATE TRIGGER guard_puzzle_stats_not_tombstoned_insert
BEFORE INSERT ON puzzle_stats
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;

CREATE TRIGGER guard_puzzle_stats_not_tombstoned_update
BEFORE UPDATE ON puzzle_stats
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;

CREATE TRIGGER guard_puzzle_completion_runs_not_tombstoned_insert
BEFORE INSERT ON puzzle_completion_runs
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;

CREATE TRIGGER guard_puzzle_completion_runs_not_tombstoned_update
BEFORE UPDATE ON puzzle_completion_runs
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;

CREATE TRIGGER guard_puzzle_completion_run_quota
BEFORE INSERT ON puzzle_completion_runs
WHEN NOT EXISTS (
	SELECT 1
	FROM puzzle_completion_runs
	WHERE player_id = NEW.player_id
		AND run_id = NEW.run_id
)
AND COALESCE(
	(
		SELECT retained_runs
		FROM player_completion_usage
		WHERE player_id = NEW.player_id
	),
	0
) >= 100000
BEGIN
	SELECT RAISE(ABORT, 'completion_quota_exceeded');
END;

CREATE TRIGGER increment_player_completion_usage
AFTER INSERT ON puzzle_completion_runs
BEGIN
	INSERT INTO player_completion_usage (player_id, retained_runs)
	VALUES (NEW.player_id, 1)
	ON CONFLICT (player_id) DO UPDATE
	SET retained_runs = retained_runs + 1;
END;

CREATE TRIGGER decrement_player_completion_usage
AFTER DELETE ON puzzle_completion_runs
BEGIN
	UPDATE player_completion_usage
	SET retained_runs = retained_runs - 1
	WHERE player_id = OLD.player_id
		AND retained_runs > 0;

	DELETE FROM player_completion_usage
	WHERE player_id = OLD.player_id
		AND retained_runs = 0;
END;
```

The sentinel strings are stable operator diagnostics only. Authoritative executors do not parse
them into expected 404/429 outcomes; an unexpected trigger abort maps to `internal_error`.

The `(player_id, run_id)` ledger primary key provides the required player-prefix lookup for
quota enforcement. The usage table avoids counting the full ledger on every completion.

SQLite triggers run within their containing statement and transaction. This includes trigger
execution for statements issued through D1's implicit `db.batch()` transaction and through
Bun's explicit SQLite transaction.

Migration `0004` is additive. It does not rename, drop, or rewrite existing columns or tables.

## Puzzle Lifecycle Fence

### Reaper and cleanup-record integration

The D1 tombstone does not replace the existing KV cleanup record. The two records have different
responsibilities:

- the KV cleanup record remains the reaper's durable discovery and retry signal;
- the D1 tombstone is the permanent write fence observed by completion, statistics, and
  ownership writes.

Worker deletion uses this order:

1. **Persist retry discovery:** write the KV cleanup record before destructive work.
2. **Begin deletion:** insert the D1 puzzle tombstone idempotently.
3. **Clean source data:** terminate/tombstone workflow metadata as applicable, delete R2 assets,
   and delete KV metadata using the existing safe ordering.
4. **Finish database cleanup:** require successful atomic removal of `puzzle_stats` and
   `puzzle_completion_runs`, then require successful separate ownership cleanup.
5. **Finish retry state:** delete the KV cleanup record only after every required cleanup step
   succeeds.

Stuck-processing, explicit-cleanup-record, orphan, and admin force-delete paths all converge on
this sequence. Reaper discovery continues to scan KV cleanup records; it does not scan D1
tombstones.

Stuck-processing and orphan discovery paths currently begin without a cleanup record. They must
first create or idempotently ensure that record, before D1 tombstoning or any destructive source
work. Failure to persist it aborts the attempt. The explicit-record and admin force-delete paths
reuse their existing record.

Completion-data and ownership cleanup are no longer best-effort prerequisites for cleanup-record
deletion. If either D1 step fails, the caller retains both the KV cleanup record and permanent
tombstone and reports/requeues a retriable cleanup failure. Existing tests that accept D1
cleanup failure followed by cleanup-record deletion must be inverted.

Bun has no KV cleanup-record dependency. It inserts the D1/SQLite tombstone first, then performs
filesystem cleanup and database cleanup. Repeating the admin operation resumes cleanup.

If KV cleanup-record creation or begin-deletion tombstoning fails, destructive source deletion
does not start. The Worker retains a successfully created KV record so the reaper can retry the
D1 tombstone. Once the tombstone succeeds, deletion is committed: a later source-cleanup failure
leaves both the tombstone and retry signal in place. Repeating begin or finish operations is
idempotent.

All Bun admin, Worker admin, and reaper deletion paths use the same executor lifecycle
operations. Ownership deletion remains a separate cleanup operation, but its database trigger
prevents a paused completion from recreating ownership after the tombstone exists.

Creation paths reject a tombstoned puzzle ID before publishing source metadata. Server-generated
puzzle IDs remain random; this check formalizes the permanent no-reuse rule rather than relying
only on collision probability. The `puzzles` insert/update trigger is therefore a formal
invariant guard, not mitigation for a realistically probable UUID collision.

`puzzle_deletion_tombstones.deleted_at` is permanent audit metadata for operator diagnostics,
cleanup-age inspection, and incident reconstruction. It is not a retention deadline, and no
automatic tombstone pruning is allowed.

## Completion Write Protocol

Both concrete executors perform tombstone and quota decisions inside the same database
transaction as completion writes.

### Enforcement model

Expected tombstone and quota outcomes come from explicit executor decisions:

- Bun starts a write-locking `BEGIN IMMEDIATE` transaction before reading tombstone, existing
  run, or usage state, then branches and writes within that transaction.
- D1 encodes the tombstone and usage preconditions in an atomic conditional
  `INSERT ... SELECT` inside one `db.batch()` transaction. Companion read statements in the same
  batch return the stored run, tombstone, and usage state needed for typed interpretation.

The D1 insert follows this logical SQL shape:

```sql
INSERT INTO puzzle_completion_runs (
	player_id,
	run_id,
	puzzle_id,
	result_class,
	timing_quality,
	elapsed_active_seconds,
	completed_at
)
SELECT ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = ?
)
AND (
	EXISTS (
		SELECT 1
		FROM puzzle_completion_runs
		WHERE player_id = ?
			AND run_id = ?
	)
	OR COALESCE(
		(
			SELECT retained_runs
			FROM player_completion_usage
			WHERE player_id = ?
		),
		0
	) < ?
)
ON CONFLICT (player_id, run_id) DO NOTHING;
```

The same D1 batch reads the input puzzle's tombstone, the stored run, and the player's usage.
After the batch succeeds, a pure interpreter applies tombstone → replay/conflict → quota →
recorded precedence using those reads and the insert's `meta.changes`. Expected 404/429 outcomes
therefore soft-fail without invoking a trigger. A trigger abort rolls back the batch and maps to 500. Production binds the shared `100_000` constant; tests may inject a smaller executor limit
without changing the migration's hard upper-bound trigger.

The database triggers are defense in depth for future or out-of-band writers. A tombstone or
quota trigger firing in the authoritative executor path indicates that its transactional
pre-check invariant was violated; it maps to structured `internal_error`, not to an expected
404 or 429 result.

The quota guard in the migration appendix allows an existing run ID to reach replay/conflict
handling even when the player is at the limit. SQLite evaluates `BEFORE INSERT` before
`ON CONFLICT DO NOTHING`, so its explicit existing-run lookup is required. The executor's
conditional insert and the trigger independently preserve the same rule.

For a versioned request:

1. check whether the puzzle is tombstoned;
2. read an existing `(player_id, run_id)` row;
3. if it exists, return replay or conflict using the existing exact-facts rules;
4. if it does not exist, enforce the retained-run quota;
5. insert the ledger row and update usage;
6. conditionally maintain the canonical standard best.

The result precedence is:

1. tombstoned puzzle;
2. existing-run replay or conflict;
3. quota rejection for a new run;
4. recorded completion.

For a legacy request, the executor checks the same tombstone inside the transaction before
updating the historical `puzzle_stats` baseline. Legacy writes retain their current flooring,
best-time, count, and timestamp semantics.

Database triggers provide defense in depth for any ownership or statistics caller outside the
primary executor path. Database-specific trigger strings are not exposed through route
responses.

### Usage counter integrity

The required invariant is:

```text
player_completion_usage.retained_runs
	= COUNT(puzzle_completion_runs) grouped by player_id
```

Executor tests assert this invariant after every write, replay, conflict, quota, deletion, and
rollback sequence.

The post-insert trigger creates a missing usage row at `1` or increments the existing row only
after a ledger row was actually inserted. The post-delete trigger decrements an existing row,
deletes it when the value reaches zero, and safely does nothing if the usage row is already
missing. It must never synthesize a negative counter.

The operator runbook includes an idempotent reconciliation procedure that, inside one
write-blocking transaction:

1. reports any player whose actual ledger count exceeds the supported limit;
2. clears `player_completion_usage`;
3. rebuilds it with:

```sql
INSERT INTO player_completion_usage (player_id, retained_runs)
SELECT player_id, COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;
```

The procedure aborts without changing counters when an actual count exceeds `100_000`; it does
not silently prune indefinitely idempotent run IDs.

## API and Runtime Contexts

The shared completion response contract adds:

```ts
{
	error: 'completion_quota_exceeded';
	message: string;
}
```

HPA-371 adds this value to `RecordPuzzleCompletionResponse` in `@perseus/types`. Client effect
classification treats `completion_quota_exceeded` as terminal and non-retryable. A tombstoned
`not_found` response is also terminal. HPA-372 must add both classifications before enabling
the versioned completion caller in production. The current HPA-371 web caller remains legacy
and cannot receive the versioned quota response.

Shared result mapping returns:

- tombstoned: 404 `not_found`;
- quota exceeded: 429 `completion_quota_exceeded`;
- exact replay or first record: 200;
- changed-facts reuse: 409 `run_id_conflict`;
- unexpected context/executor/database failure: structured 500 `internal_error`.

Both route shells acquire only the runtime database context needed by the parsed request kind,
and do so inside the structured internal-error boundary. Auth, puzzle-readiness checks, and
runtime-specific metadata lookup remain outside that write boundary and retain their current
status mapping.

Concretely, the legacy branch calls `getDb()` and the versioned branch calls `getDbContext()`
inside the same `try/catch` that maps failures through `completionInternalErrorResponse`. The
Worker branch does the equivalent with `getWorkerDb()` or `getWorkerDbContext()`. A request must
not initialize the context used only by the other request kind.

The best-effort ownership backfill remains, but a tombstone trigger makes it unable to recreate
ownership. The authoritative completion result still determines the route response.

## Failure and Retry Semantics

- Tombstone insertion failure aborts deletion before destructive source mutation; a previously
  written KV cleanup record is retained for retry.
- A failure after tombstone insertion does not reactivate the puzzle or remove the fence.
- Retried deletion operations reuse the existing tombstone and continue cleanup.
- Completion attempts racing after the tombstone return 404 and cannot create ownership,
  baseline, ledger, or usage rows.
- Completion writes serialized before the tombstone are removed by the later finish-deletion
  transaction.
- Exact replay after deletion is the deliberate exception to indefinite replay success: it
  returns structured 404 whether or not finish-deletion has already removed the ledger row.
  Clients classify it as terminal and do not retry it indefinitely.
- Stats reads are not filtered by the tombstone. During the begin-to-finish window an existing
  stats row may remain visible but is frozen against further mutation; it disappears when
  finish-deletion succeeds. This transient or retry-length visibility is accepted.
- Exact replay at quota remains 200; changed-facts reuse remains 409; a distinct new run returns 429.
- Usage counters change only with successful ledger insertion/deletion in the same transaction.

## Testing

### Schema and migration

- migration `0004` applies after `0000` through `0003`;
- existing ledger rows backfill exact per-player usage;
- usage backfill precedes trigger creation in the same migration file;
- tombstone and usage constraints reject invalid data;
- all triggers exist and use the required tables/indexes;
- migration contains no destructive DDL.

### Executor behavior

Run the same cases against real Bun SQLite and real D1:

- tombstoned legacy and versioned writes are rejected without mutation;
- a completion paused after readiness cannot write after begin deletion;
- writes serialized before begin deletion are removed by finish deletion;
- ownership, baseline, ledger, and usage rows cannot be recreated after deletion;
- begin and finish deletion are idempotent;
- usage increments only for a new ledger row;
- exact replay and conflict do not change usage;
- the quota trigger's existing-run exemption works with `ON CONFLICT DO NOTHING`;
- the final available run is accepted and the next distinct run is rejected;
- replay/conflict still work at the effective limit;
- ledger deletion decrements usage and removes a zero usage row;
- deleting a ledger row when its usage row is missing does not create a negative counter;
- usage/ledger reconciliation holds after every executor sequence;
- concurrent final-capacity writes admit at most the remaining capacity;
- any statement failure rolls back ledger and usage changes together.

Routine Bun/D1 executor suites inject a small limit and create the matching small number of real
ledger rows so the usage invariant remains true. Migration tests inspect that the production
constant is `100_000`, then exercise the exact quota-trigger body with an equivalent
small-threshold trigger and matching rows. They do not insert `100_000` rows in every suite.

### Routes and callers

- Bun and Worker context initialization failures return structured 500;
- tombstoned requests return structured 404 in both runtimes;
- quota rejection returns structured 429 in both runtimes;
- auth, readiness, legacy compatibility, replay, and conflict behavior remain unchanged;
- admin and all reaper paths begin the fence before source deletion;
- stuck-processing and orphan paths ensure a cleanup record before beginning deletion;
- a fence failure prevents source deletion;
- post-fence source failures retain retryable deletion state;
- completion-data or ownership cleanup failure retains the cleanup record and tombstone;
- cleanup-record deletion never follows a failed required D1 cleanup;
- Worker paths retain both the KV cleanup record and D1 tombstone until cleanup succeeds;
- creation rejects a tombstoned ID before source publication;
- exact replay of a tombstoned puzzle returns terminal 404;
- the shared response union includes terminal `completion_quota_exceeded`;
- runtime drift tests pin the same result mapping.

### Full verification

Reapply local migrations and rerun:

- types, shared, API, and web suites;
- repository-wide check and lint;
- production build;
- `git diff --check`;
- additive-migration/deploy-order audit;
- operator-runbook reconciliation procedure validation;
- authenticated legacy/v1/replay/conflict smoke;
- a tombstone race smoke and a quota-boundary repository smoke.

## Rollout

Migration `0004` must be applied before publishing the Worker version that writes tombstones or
usage counters. The existing subsequent-deploy workflow already has this ordering. The
documented first-deploy gap remains unchanged: a brand-new stack must receive all migrations
before DB-backed routes are considered available.

During a mixed-version deployment window, an old Worker that writes after migration `0004` may
hit a tombstone trigger and return its existing structured generic 500 rather than the new typed 404. The fence still prevents mutation. This brief status-parity gap is accepted until the new
Worker version has replaced old instances.

No production data exists for HPA-371 yet, so the migration backfill is principally a safety
property for local/pre-production databases and future cherry-pick ordering.

## Non-Goals

- Time-based ledger pruning.
- Reusing a deleted puzzle ID.
- Public leaderboard anti-cheat.
- Cross-player or IP-based completion throttling in addition to the retained-run quota.
- Moving all puzzle lifecycle state into a Durable Object.
- Implementing HPA-372 client persistence or `PuzzleSession` behavior. Updating its contract
  dependency and terminal-failure plan is required before implementation begins.
