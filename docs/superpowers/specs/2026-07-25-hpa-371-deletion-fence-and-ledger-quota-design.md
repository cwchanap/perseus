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
- A player-account purge must delete that player's ledger rows and therefore free all quota.
- A deleted puzzle ID is permanently fenced and cannot be reused.
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
);
```

`player_completion_usage.retained_runs` is constrained to the inclusive range
`0..100_000`. Migration `0004` backfills it from `puzzle_completion_runs` before enabling
enforcement.

The migration also installs database triggers with these responsibilities:

- reject inserts or updates to `puzzles`, `puzzle_stats`, and `puzzle_completion_runs` when the
  target puzzle has a deletion tombstone;
- reject a new ledger row when the player is already at `100_000` retained runs, while allowing
  an existing `(player_id, run_id)` to reach normal replay/conflict interpretation;
- increment usage only after a ledger row is actually inserted;
- decrement usage after a ledger row is deleted and remove zero-valued usage rows.

The `(player_id, run_id)` ledger primary key provides the required player-prefix lookup for
quota enforcement. The usage table avoids counting the full ledger on every completion.

Migration `0004` is additive. It does not rename, drop, or rewrite existing columns or tables.

## Puzzle Lifecycle Fence

Puzzle deletion becomes a two-stage database/source lifecycle:

1. **Begin deletion:** insert the puzzle tombstone idempotently before mutating KV, R2,
   filesystem metadata, Durable Object state, ownership, or completion data.
2. **Finish deletion:** perform the existing source-of-truth cleanup, then atomically remove
   `puzzle_stats` and `puzzle_completion_runs`. Keep the tombstone permanently.

If the begin-deletion write fails, source deletion does not start. Once the tombstone succeeds,
deletion is committed: a later source-cleanup failure leaves the tombstone in place and the
existing retry/reaper path continues cleanup. Repeating begin or finish operations is
idempotent.

All Bun admin, Worker admin, and reaper deletion paths use the same executor lifecycle
operations. Ownership deletion remains a separate cleanup operation, but its database trigger
prevents a paused completion from recreating ownership after the tombstone exists.

Creation paths reject a tombstoned puzzle ID before publishing source metadata. Server-generated
puzzle IDs remain random; this check formalizes the permanent no-reuse rule rather than relying
only on collision probability.

## Completion Write Protocol

Both concrete executors perform tombstone and quota decisions inside the same database
transaction as completion writes.

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
primary executor path. Concrete executors translate the trigger's stable sentinel failures into
typed deleted/quota outcomes rather than exposing database-specific error strings to routes.

## API and Runtime Contexts

The shared completion response contract adds:

```ts
{
	error: 'completion_quota_exceeded';
	message: string;
}
```

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

The best-effort ownership backfill remains, but a tombstone trigger makes it unable to recreate
ownership. The authoritative completion result still determines the route response.

## Failure and Retry Semantics

- Tombstone insertion failure aborts deletion before source mutation.
- A failure after tombstone insertion does not reactivate the puzzle or remove the fence.
- Retried deletion operations reuse the existing tombstone and continue cleanup.
- Completion attempts racing after the tombstone return 404 and cannot create ownership,
  baseline, ledger, or usage rows.
- Completion writes serialized before the tombstone are removed by the later finish-deletion
  transaction.
- Exact replay at quota remains 200; changed-facts reuse remains 409; a distinct new run returns 429.
- Usage counters change only with successful ledger insertion/deletion in the same transaction.

## Testing

### Schema and migration

- migration `0004` applies after `0000` through `0003`;
- existing ledger rows backfill exact per-player usage;
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
- run `100_000` is accepted and run `100_001` is rejected;
- replay/conflict still work at `100_000`;
- ledger deletion decrements usage and removes a zero usage row;
- concurrent final-capacity writes admit at most the remaining capacity;
- any statement failure rolls back ledger and usage changes together.

### Routes and callers

- Bun and Worker context initialization failures return structured 500;
- tombstoned requests return structured 404 in both runtimes;
- quota rejection returns structured 429 in both runtimes;
- auth, readiness, legacy compatibility, replay, and conflict behavior remain unchanged;
- admin and all reaper paths begin the fence before source deletion;
- a fence failure prevents source deletion;
- post-fence source failures retain retryable deletion state;
- creation rejects a tombstoned ID before source publication;
- runtime drift tests pin the same result mapping.

### Full verification

Reapply local migrations and rerun:

- types, shared, API, and web suites;
- repository-wide check and lint;
- production build;
- `git diff --check`;
- additive-migration/deploy-order audit;
- authenticated legacy/v1/replay/conflict smoke;
- a tombstone race smoke and a quota-boundary repository smoke.

## Rollout

Migration `0004` must be applied before publishing the Worker version that writes tombstones or
usage counters. The existing subsequent-deploy workflow already has this ordering. The
documented first-deploy gap remains unchanged: a brand-new stack must receive all migrations
before DB-backed routes are considered available.

No production data exists for HPA-371 yet, so the migration backfill is principally a safety
property for local/pre-production databases and future cherry-pick ordering.

## Non-Goals

- Time-based ledger pruning.
- Reusing a deleted puzzle ID.
- Public leaderboard anti-cheat.
- Cross-player or IP-based completion throttling in addition to the retained-run quota.
- Moving all puzzle lifecycle state into a Durable Object.
- Changing HPA-372 client persistence or `PuzzleSession` behavior.
