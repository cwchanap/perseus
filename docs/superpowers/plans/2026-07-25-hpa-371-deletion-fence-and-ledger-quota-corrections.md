# HPA-371 Deletion Fence and Ledger Quota Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final HPA-371 review findings by making puzzle deletion a permanent
database write fence, bounding retained versioned completion history, returning typed
tombstone/quota outcomes in both runtimes, and making every deletion path durably retryable.

**Architecture:** Add an additive Drizzle migration containing permanent puzzle tombstones,
per-player ledger usage, and defense-in-depth triggers. Extend the existing concrete
`CompletionWriteExecutor` so D1 uses conditional statements in one atomic batch and Bun uses
explicit `BEGIN IMMEDIATE` transactions for both legacy and versioned completions. Route Worker
admin/reaper cleanup through a small shared lifecycle helper that persists retry discovery
before fencing and removes it only after source, completion, and ownership cleanup all succeed.

**Tech Stack:** TypeScript, Hono, Drizzle ORM 0.36, Cloudflare D1, Cloudflare KV/R2/Workflows,
`bun:sqlite`, Miniflare, Vitest, Bun, Turborepo

## Global Constraints

- Approved design baselines:
  `docs/superpowers/specs/2026-07-25-puzzle-session-foundation-design.md` and
  `docs/superpowers/specs/2026-07-25-hpa-371-deletion-fence-and-ledger-quota-design.md`.
- Linear delivery issue:
  `https://linear.app/cwchanap/issue/HPA-371/foundation-ship-versioned-puzzle-completion-and-statistics-contract`.
- This is the required corrective phase of the original
  `2026-07-25-hpa-371-versioned-completion-statistics.md` plan. Do not redo already-green
  ledger/read-model/profile work unless a corrective task names it.
- Keep indefinite `(player_id, run_id)` idempotency. Do not expire or prune ledger rows by age.
- Retain at most `100_000` versioned run rows per player. Existing run IDs still reach
  replay/conflict handling at the limit; only a distinct new run returns HTTP 429.
- Legacy `{ timeSeconds }` requests do not consume versioned-run quota.
- A deleted puzzle ID is permanently tombstoned and cannot be reused. Exact replay after deletion
  returns terminal HTTP 404 whether or not its ledger row still exists.
- Expected D1 tombstone/quota outcomes must soft-fail through conditional statements and typed
  interpretation. A defense-in-depth trigger abort is an invariant failure and maps to
  structured HTTP 500.
- Bun completion and deletion transactions that read before writing use explicit
  `BEGIN IMMEDIATE` behavior.
- Worker cleanup performs read-only eligibility/liveness gates first. After deletion is chosen:
  ensure KV cleanup record → insert D1 tombstone → mutate source state → require completion and
  ownership cleanup → delete cleanup record.
- A failed required D1 cleanup retains both the cleanup record and tombstone. The reaper does not
  scan D1 tombstones.
- Migration `0004` is additive and must include `schema.ts`, SQL, journal, snapshot, backfill, all
  triggers, and `--> statement-breakpoint` boundaries.
- Routine quota tests inject a small limit and create matching real ledger rows. Do not insert
  `100_000` rows in every suite.
- HPA-371 does not add account purge, global cross-account quota, puzzle-creation quota, or
  HPA-372 client-session implementation.
- Do not enable the HPA-372 v1 client until it maps `completion_quota_exceeded` and tombstoned
  `not_found` as terminal and non-retryable.
- Tabs for indentation, single quotes, no trailing commas, 100-character line width.
- Prefix every shell command with `rtk`. Use `apply_patch` for source edits.
- Start each behavior with a focused failing test, run it red, implement the smallest change, run
  it green, and commit only that task's files.

---

## File Structure

### New files

| File                                                                 | Responsibility                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/shared/drizzle/0004_puzzle_deletion_fence.sql`             | Add tombstones, usage backfill, fence/quota/maintenance triggers       |
| `packages/shared/drizzle/meta/0004_snapshot.json`                    | Drizzle snapshot containing the two new tables and constraints         |
| `packages/shared/drizzle/maintenance/reconcile_completion_usage.sql` | Atomic operator repair for the derived usage table                     |
| `apps/api/src/services/puzzle-deletion.worker.ts`                    | Shared Worker ensure-fence and required-finish lifecycle operations    |
| `apps/api/src/services/__tests__/puzzle-deletion.worker.test.ts`     | Lifecycle ordering, idempotency, and required-cleanup failure behavior |

### Main modified files

| File                                                               | Change                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/types/src/index.ts`                                      | Add `completion_quota_exceeded` to the shared response union                 |
| `packages/types/src/index.test.ts`                                 | Pin the new response code                                                    |
| `packages/shared/src/schema.ts`                                    | Declare tombstone and usage tables                                           |
| `packages/shared/drizzle/meta/_journal.json`                       | Register migration `0004`                                                    |
| `packages/shared/src/completion-writes.ts`                         | Typed legacy/versioned outcomes, quota constant, lifecycle executor methods  |
| `packages/shared/src/drivers/d1.ts`                                | Conditional versioned/legacy batches and deletion lifecycle                  |
| `packages/shared/src/drivers/bun.ts`                               | Immediate transactions and deletion lifecycle                                |
| `packages/shared/src/repositories.ts`                              | Interpret typed executor results and delegate legacy writes                  |
| `packages/shared/src/__tests__/schema.test.ts`                     | Full migration artifact and trigger proof                                    |
| `packages/shared/src/__tests__/drivers.test.ts`                    | Bun/D1 lifecycle, atomicity, and injected-limit behavior                     |
| `packages/shared/src/__tests__/repositories.test.ts`               | Bun typed legacy/versioned outcomes and usage invariant                      |
| `packages/shared/src/__tests__/repositories.d1.test.ts`            | Real D1 conditional-batch ordering and soft 404/429 behavior                 |
| `apps/api/src/routes/puzzles.complete.shared.ts`                   | Map tombstone/quota results to 404/429                                       |
| `apps/api/src/routes/puzzles.complete.ts`                          | One Bun context inside the structured boundary                               |
| `apps/api/src/routes/puzzles.complete.worker.ts`                   | Worker equivalent and post-decision ownership backfill                       |
| `apps/api/src/routes/puzzles.complete.test.ts`                     | Bun context, legacy 404, quota, and replay matrix                            |
| `apps/api/src/routes/puzzles.complete.worker.test.ts`              | Worker parity                                                                |
| `apps/api/src/routes/_cross-runtime-drift.test.ts`                 | Pin matching response branches                                               |
| `apps/api/src/routes/admin.ts`                                     | Bun tombstone-before-filesystem deletion and required DB finish              |
| `apps/api/src/routes/admin.worker.ts`                              | Worker force-delete lifecycle helper integration                             |
| `apps/api/src/routes/puzzles.ts`                                   | Reject tombstoned generated IDs before source publication                    |
| `apps/api/src/routes/puzzles.worker.ts`                            | Worker equivalent                                                            |
| `apps/api/src/routes/puzzles.test.ts`                              | Bun tombstoned-ID creation rejection                                         |
| `apps/api/src/services/reaper.ts`                                  | Gate → record → fence → source → required-finish flow for all puzzle reapers |
| `apps/api/src/services/__tests__/reaper.test.ts`                   | No premature fence, durable retry, and required finish assertions            |
| `apps/api/src/routes/__tests__/admin.test.ts`                      | Bun deletion and creation regressions                                        |
| `apps/api/src/routes/__tests__/admin.worker.test.ts`               | Worker deletion and creation regressions                                     |
| `apps/api/src/routes/__tests__/admin-coverage.worker.test.ts`      | Worker deletion ordering coverage                                            |
| `apps/api/src/routes/__tests__/admin-coverage-gaps.worker.test.ts` | Worker required-cleanup failure coverage                                     |
| `apps/api/src/routes/__tests__/puzzles.worker.test.ts`             | Worker tombstoned-ID creation rejection                                      |
| `docs/OPERATOR_RUNBOOK.md`                                         | Reconciliation, capacity monitoring, and permanent-tombstone operations      |

---

### Task 1: Add the Shared Quota Contract and Complete Migration 0004

**Files:**

- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/index.test.ts`
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/__tests__/schema.test.ts`
- Create: `packages/shared/drizzle/0004_puzzle_deletion_fence.sql`
- Create: `packages/shared/drizzle/meta/0004_snapshot.json`
- Modify: `packages/shared/drizzle/meta/_journal.json`

**Interfaces:**

- Consumes: existing `puzzleCompletionRuns`, `puzzleStats`, and `puzzles` schema declarations.
- Produces:

```ts
export const puzzleDeletionTombstones: SQLiteTable;
export const playerCompletionUsage: SQLiteTable;
```

and the shared response member:

```ts
{
	error: 'completion_quota_exceeded';
	message: string;
}
```

- [ ] **Step 1: Write failing shared-type and migration tests**

In `packages/types/src/index.test.ts`, add a compile/runtime fixture proving
`completion_quota_exceeded` is accepted by `RecordPuzzleCompletionResponse`.

In `packages/shared/src/__tests__/schema.test.ts`, add tests that:

- migrate a database containing migrations `0000` through `0003`;
- seed several ledger rows for two players before applying `0004`;
- apply `0004` through the same Bun Drizzle migrator used by production;
- assert both new tables, all nine triggers, and the exact usage backfill;
- assert `retained_runs` rejects `-1` and `100_001`;
- assert the SQL contains `100000`, contains no destructive DDL, and has a breakpoint between
  every top-level statement without splitting a trigger body;
- load `meta/_journal.json` and `meta/0004_snapshot.json` and verify the entry/tables exist.

Use these trigger names verbatim:

```text
guard_puzzles_not_tombstoned_insert
guard_puzzles_not_tombstoned_update
guard_puzzle_stats_not_tombstoned_insert
guard_puzzle_stats_not_tombstoned_update
guard_puzzle_completion_runs_not_tombstoned_insert
guard_puzzle_completion_runs_not_tombstoned_update
guard_puzzle_completion_run_quota
increment_player_completion_usage
decrement_player_completion_usage
```

- [ ] **Step 2: Run the focused tests red**

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/shared -- src/__tests__/schema.test.ts
```

Expected: FAIL because the response member, schema declarations, migration, and metadata do not
exist.

- [ ] **Step 3: Declare the schema and generate the migration artifacts**

Add:

```ts
export const puzzleDeletionTombstones = sqliteTable('puzzle_deletion_tombstones', {
	puzzleId: text('puzzle_id').primaryKey(),
	deletedAt: integer('deleted_at').notNull()
});

export const playerCompletionUsage = sqliteTable(
	'player_completion_usage',
	{
		playerId: text('player_id').primaryKey(),
		retainedRuns: integer('retained_runs').notNull()
	},
	(t) => ({
		retainedRunsCheck: check('pcu_retained_runs_check', sql`${t.retainedRuns} BETWEEN 0 AND 100000`)
	})
);
```

Generate the SQL, journal entry, and snapshot:

```bash
rtk bunx drizzle-kit generate --config packages/shared/drizzle.config.ts --name puzzle_deletion_fence --breakpoints
```

Verify the command produced exactly
`packages/shared/drizzle/0004_puzzle_deletion_fence.sql`, registered
`0004_puzzle_deletion_fence` in the journal, and created `meta/0004_snapshot.json`. Stop and
resolve the unexpected migration index before editing if any earlier uncommitted migration
already occupies `0004`.

- [ ] **Step 4: Complete the migration SQL**

After the two generated `CREATE TABLE` statements, add the usage backfill before any trigger:

```sql
INSERT INTO player_completion_usage (player_id, retained_runs)
SELECT player_id, COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;
```

Add the nine triggers from the approved design. The decrement body must be exactly safe under
missing/zero drift:

```sql
UPDATE player_completion_usage
SET retained_runs = retained_runs - 1
WHERE player_id = OLD.player_id
	AND retained_runs > 0;

DELETE FROM player_completion_usage
WHERE player_id = OLD.player_id
	AND retained_runs = 0;
```

The quota trigger must exempt an existing `(player_id, run_id)` before comparing the counter to
`100000`. Put `--> statement-breakpoint` between every top-level table, backfill, and trigger
statement; never put it inside `BEGIN ... END`.

- [ ] **Step 5: Run the focused tests green**

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/shared -- src/__tests__/schema.test.ts
rtk bun run check --filter=@perseus/types
rtk bun run check --filter=@perseus/shared
```

Expected: PASS. The Bun migration test proves that no multi-statement chunk silently half-applies.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/types/src/index.ts packages/types/src/index.test.ts packages/shared/src/schema.ts packages/shared/src/__tests__/schema.test.ts packages/shared/drizzle/0004_puzzle_deletion_fence.sql packages/shared/drizzle/meta/0004_snapshot.json packages/shared/drizzle/meta/_journal.json
rtk git commit -m "feat(shared): add completion quota and deletion fence schema"
```

---

### Task 2: Make D1 Completion Writes Soft-Fail with Typed Outcomes

**Files:**

- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`

**Interfaces:**

- Consumes: `puzzleDeletionTombstones` and `playerCompletionUsage` from Task 1.
- Produces:

```ts
export interface LegacyCompletionWrite {
	playerId: string;
	puzzleId: string;
	timeSeconds: number;
	receivedAt: number;
}

export const MAX_RETAINED_COMPLETION_RUNS = 100_000;

export type VersionedCompletionWriteExecution =
	| { status: 'stored'; stored: StoredCompletionFacts; inserted: boolean }
	| { status: 'tombstoned' }
	| { status: 'quota_exceeded' };

export type LegacyCompletionWriteExecution = { status: 'recorded' } | { status: 'tombstoned' };

export type VersionedCompletionResult =
	| { status: 'recorded'; completedAt: number }
	| { status: 'replayed'; completedAt: number }
	| { status: 'conflict' }
	| { status: 'tombstoned' }
	| { status: 'quota_exceeded' };
```

The factory accepts a test-only effective limit while production defaults to `100_000`:

```ts
createD1CompletionWriteExecutor(
	db: D1AppDb,
	retainedRunLimit?: number
): CompletionWriteExecutor;
```

- [ ] **Step 1: Write the failing real-D1 behavior matrix**

In `repositories.d1.test.ts`, construct the executor with a limit of `3` and create matching
ledger rows. Cover:

- first insert returns stored/inserted and usage `1`;
- exact replay returns stored/not-inserted and does not change usage;
- changed facts return conflict and do not change usage or best;
- third distinct run is accepted and fourth returns quota without mutation;
- replay/conflict still work at three retained rows;
- a tombstone returns tombstoned for first write, exact replay, and changed-facts reuse;
- a tombstoned exact standard replay leaves the existing `puzzle_stats` row unchanged and does
  not abort the batch;
- deleting a run decrements usage; deleting under a missing/zero usage row never creates a
  negative count;
- concurrent final-capacity batches admit only the remaining capacity;
- a forced trigger/invariant failure rolls the batch back and rejects rather than becoming a
  typed 404/429.

- [ ] **Step 2: Run the D1 suite red**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/repositories.d1.test.ts
```

Expected: FAIL because the executor still performs an unconditional insert, requires a stored
row, and has no tombstone/quota results.

- [ ] **Step 3: Extend the pure completion contracts**

Update `CompletionWriteExecutor.write` to return `VersionedCompletionWriteExecution`. Change
`interpretVersionedCompletionWrite` to accept the execution union:

```ts
export function interpretVersionedCompletionWrite(
	input: VersionedCompletionWrite,
	execution: VersionedCompletionWriteExecution
): VersionedCompletionResult {
	if (execution.status !== 'stored') return { status: execution.status };
	if (!completionFactsMatch(input, execution.stored)) return { status: 'conflict' };
	return {
		status: execution.inserted ? 'recorded' : 'replayed',
		completedAt: execution.stored.completedAt
	};
}
```

Validate an injected effective limit as a positive integer not above
`MAX_RETAINED_COMPLETION_RUNS`.

- [ ] **Step 4: Implement the ordered conditional D1 batch**

Build these five statements in this exact order:

```text
1. conditional ledger INSERT ... SELECT ... ON CONFLICT DO NOTHING
2. tombstone SELECT for input.puzzleId
3. stored-run SELECT for (playerId, runId)
4. usage SELECT for playerId
5. canonical-best INSERT ... SELECT ... ON CONFLICT DO UPDATE
```

The ledger insert must encode:

```sql
WHERE NOT EXISTS (
	SELECT 1 FROM puzzle_deletion_tombstones WHERE puzzle_id = ?
)
AND (
	EXISTS (
		SELECT 1 FROM puzzle_completion_runs
		WHERE player_id = ? AND run_id = ?
	)
	OR COALESCE(
		(SELECT retained_runs FROM player_completion_usage WHERE player_id = ?),
		0
	) < ?
)
```

Add the same `NOT EXISTS` tombstone predicate to the canonical-best inner `SELECT`. After the
batch, interpret in this order:

```ts
if (tombstoneRows.length > 0) return { status: 'tombstoned' };
if (storedRows[0]) {
	return {
		status: 'stored',
		stored: toStoredFacts(storedRows[0]),
		inserted: insertResult.meta.changes === 1
	};
}
if ((usageRows[0]?.retainedRuns ?? 0) >= retainedRunLimit) {
	return { status: 'quota_exceeded' };
}
throw new Error('Completion ledger write returned no stored row without tombstone or quota');
```

Do not parse trigger error text.

- [ ] **Step 5: Add the conditional D1 legacy write**

Extend `CompletionWriteExecutor` with:

```ts
writeLegacy(input: LegacyCompletionWrite): Promise<LegacyCompletionWriteExecution>;
```

Implement one D1 batch containing:

1. the existing baseline upsert expressed as
   `INSERT ... SELECT ... WHERE NOT EXISTS (tombstone) ON CONFLICT DO UPDATE`;
2. a tombstone read.

Return tombstoned when the row exists. Return recorded when the upsert changes one row. A
zero-change result without a tombstone is an invariant failure.

Change `recordLegacyCompletion` to accept the executor and delegate to `writeLegacy`.

- [ ] **Step 6: Run the D1 and shared driver suites green**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/repositories.d1.test.ts src/__tests__/drivers.test.ts
rtk bun run check --filter=@perseus/shared
```

Expected: PASS, including exact tombstoned replay remaining 404-capable instead of triggering a
batch rollback.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/shared/src/completion-writes.ts packages/shared/src/drivers/d1.ts packages/shared/src/repositories.ts packages/shared/src/__tests__/repositories.d1.test.ts packages/shared/src/__tests__/drivers.test.ts
rtk git commit -m "feat(shared): soft-fail D1 completion fences and quota"
```

---

### Task 3: Add Bun Immediate Writes and Route-Level 404/429 Parity

**Files:**

- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`
- Modify: `apps/api/src/routes/puzzles.complete.shared.ts`
- Modify: `apps/api/src/routes/puzzles.complete.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.ts`
- Modify: `apps/api/src/routes/puzzles.complete.test.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`
- Modify: `apps/api/src/routes/_cross-runtime-drift.test.ts`

**Interfaces:**

- Consumes: typed executor/repository results from Task 2.
- Produces:

```ts
type CompletionRouteResult = VersionedCompletionResult | LegacyCompletionWriteExecution;

function completionResultToResponse(result: CompletionRouteResult): {
	body: RecordPuzzleCompletionResponse;
	status: 200 | 404 | 409 | 429;
};
```

with shared HTTP mapping:

```text
tombstoned -> 404 { error: 'not_found', message: 'Puzzle not found' }
quota_exceeded -> 429 {
	error: 'completion_quota_exceeded',
	message: 'Completion history limit reached'
}
```

- [ ] **Step 1: Write the failing Bun executor tests**

Create a Bun context with an effective limit of `3`. Test the same legacy/versioned matrix as D1,
including exact replay/conflict at quota, tombstone precedence, usage invariants, and rollback
after an injected statement failure.

Spy or expose the transaction wrapper sufficiently to prove the write path calls the
`bun:sqlite` transaction's `.immediate(...)` variant rather than the deferred default.

- [ ] **Step 2: Write the failing route parity tests**

For both route suites, cover:

- context factory throws before either request kind writes → structured 500;
- legacy completion races with a tombstone → structured 404 and no baseline mutation;
- versioned first write/replay/conflict retain 200/200/409;
- new versioned run at the effective limit → structured 429;
- exact replay at quota remains 200;
- exact replay after tombstone remains 404;
- tombstoned/quota responses never depend on trigger error text;
- ownership backfill is not called for tombstoned results;
- ownership backfill remains best-effort after every non-tombstoned result.

Update the cross-runtime drift test to require identical 404 and 429 branches.

- [ ] **Step 3: Run the focused tests red**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/repositories.test.ts src/__tests__/drivers.test.ts
rtk bun run test --filter=@perseus/api -- src/routes/puzzles.complete.test.ts src/routes/puzzles.complete.worker.test.ts src/routes/_cross-runtime-drift.test.ts
```

Expected: FAIL because Bun is deferred, legacy bypasses the executor, context initialization
escapes the route catch, and response mapping lacks quota/tombstone outcomes.

- [ ] **Step 4: Implement the Bun write protocol**

Create versioned and legacy synchronous transaction functions, then invoke their immediate
variants:

```ts
const writeVersionedTransaction = sqlite.transaction(writeVersioned);
const writeLegacyTransaction = sqlite.transaction(writeLegacy);

// In the executor methods:
return writeVersionedTransaction.immediate(input);
return writeLegacyTransaction.immediate(input);
```

Inside each transaction, read the tombstone before mutation. For a new versioned run, check
usage after the existing-run lookup and before insertion. Return typed expected outcomes; never
throw for tombstone/quota.

Allow `createBunDbContext(dataDir, retainedRunLimit?)` to inject the same bounded test limit as
D1 while production defaults to `100_000`.

- [ ] **Step 5: Move both route shells to one context boundary**

Use this structure in Bun and Worker:

```ts
try {
	const { db, completionWrites } = getDbContext(); // Worker: getWorkerDbContext(c.env)
	const result =
		parsed.value.kind === 'legacy'
			? await recordLegacyCompletion(
					completionWrites,
					session.user.id,
					puzzleId,
					parsed.value.timeSeconds
				)
			: await recordVersionedCompletion(
					completionWrites,
					session.user.id,
					puzzleId,
					parsed.value.request
				);

	const response = completionResultToResponse(result);
	if (response.status !== 404) {
		await ensurePuzzleOwnership(db, ownershipRow).catch(logOwnershipFailure);
	}
	return c.json(response.body, response.status);
} catch (error) {
	return structuredCompletion500(c, puzzleId, error);
}
```

Do not call `getDb()`/`getWorkerDb()` before the `try`. Keep auth, JSON parsing, source metadata
lookup, and readiness mapping outside this database-write boundary.

- [ ] **Step 6: Run focused tests green**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/repositories.test.ts src/__tests__/drivers.test.ts
rtk bun run test --filter=@perseus/api -- src/routes/puzzles.complete.test.ts src/routes/puzzles.complete.worker.test.ts src/routes/_cross-runtime-drift.test.ts
rtk bun run check --filter=@perseus/api
```

Expected: PASS with Bun/Worker status and mutation parity.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/shared/src/drivers/bun.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/drivers.test.ts apps/api/src/routes/puzzles.complete.shared.ts apps/api/src/routes/puzzles.complete.ts apps/api/src/routes/puzzles.complete.worker.ts apps/api/src/routes/puzzles.complete.test.ts apps/api/src/routes/puzzles.complete.worker.test.ts apps/api/src/routes/_cross-runtime-drift.test.ts
rtk git commit -m "feat(api): return typed completion fence and quota outcomes"
```

---

### Task 4: Add Idempotent Puzzle Deletion Lifecycle Primitives and Creation Guards

**Files:**

- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `apps/api/src/routes/puzzles.ts`
- Modify: `apps/api/src/routes/puzzles.worker.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/routes/puzzles.test.ts`
- Modify: `apps/api/src/routes/__tests__/puzzles.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin.worker.test.ts`

**Interfaces:**

- Consumes: tombstone table from Task 1 and concrete contexts from Tasks 2–3.
- Produces:

```ts
interface CompletionWriteExecutor {
	// completion methods from Tasks 2–3
	beginPuzzleDeletion(puzzleId: string, deletedAt: number): Promise<void>;
	finishPuzzleDeletion(puzzleId: string): Promise<void>;
	isPuzzleTombstoned(puzzleId: string): Promise<boolean>;
}
```

`finishPuzzleDeletion` atomically deletes `puzzle_stats` and
`puzzle_completion_runs`. Ownership remains a required separate repository delete in Worker
cleanup callers.

- [ ] **Step 1: Write failing lifecycle tests against Bun and D1**

Run the same contract against both executors:

- begin inserts one permanent tombstone and is idempotent without changing original
  `deleted_at`;
- finish deletes baseline and ledger rows together and usage triggers free quota;
- finish is idempotent when rows are already gone;
- a forced second delete failure rolls the entire finish operation back;
- completion serialized before begin is removed by finish;
- completion after begin returns tombstoned and cannot recreate stats/ledger;
- `isPuzzleTombstoned` returns false/true around begin;
- inserts/updates to `puzzles`, `puzzle_stats`, and ledger are rejected by triggers after begin.

- [ ] **Step 2: Run lifecycle tests red**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/drivers.test.ts src/__tests__/repositories.test.ts src/__tests__/repositories.d1.test.ts
```

Expected: FAIL because lifecycle methods do not exist.

- [ ] **Step 3: Implement D1 and Bun lifecycle methods**

D1 begin is one idempotent insert:

```sql
INSERT INTO puzzle_deletion_tombstones (puzzle_id, deleted_at)
VALUES (?, ?)
ON CONFLICT (puzzle_id) DO NOTHING;
```

D1 finish remains one `db.batch()` containing stats delete followed by ledger delete.

Bun begin may be a single autocommit insert. Bun finish uses an explicit immediate transaction:

```ts
const finishPuzzleDeletionTransaction = sqlite.transaction((puzzleId: string) => {
	db.delete(puzzleStats).where(eq(puzzleStats.puzzleId, puzzleId)).run();
	db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.puzzleId, puzzleId)).run();
});

// In finishPuzzleDeletion:
finishPuzzleDeletionTransaction.immediate(puzzleId);
```

Keep `deletePuzzleStats` as a compatibility delegate to `finishPuzzleDeletion` until all callers
move.

- [ ] **Step 4: Write tombstoned-ID creation tests**

For player and admin creation in Bun and Worker, force the generated UUID to an existing
tombstone. Assert:

- structured HTTP 500 `{ error: 'internal_error', message: 'Failed to allocate puzzle ID' }`;
- no KV/filesystem metadata, R2 original, workflow, or ownership row is published;
- a non-tombstoned generated ID retains existing behavior.

- [ ] **Step 5: Add pre-publication creation guards**

After generating the puzzle ID and before the first source metadata/file/R2 write, call:

```ts
if (await completionWrites.isPuzzleTombstoned(puzzleId)) {
	return c.json({ error: 'internal_error', message: 'Failed to allocate puzzle ID' }, 500);
}
```

The ID is server-generated, so this is an allocation invariant failure rather than a client
conflict. Keep all four creation paths behaviorally aligned. Database triggers remain defense in
depth if a future writer skips this check.

- [ ] **Step 6: Run lifecycle and creation suites green**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/drivers.test.ts src/__tests__/repositories.test.ts src/__tests__/repositories.d1.test.ts
rtk bun run test --filter=@perseus/api -- src/routes/puzzles.test.ts src/routes/__tests__/puzzles.worker.test.ts src/routes/__tests__/admin.test.ts src/routes/__tests__/admin.worker.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/shared/src/completion-writes.ts packages/shared/src/drivers/d1.ts packages/shared/src/drivers/bun.ts packages/shared/src/repositories.ts packages/shared/src/__tests__/drivers.test.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts apps/api/src/routes/puzzles.ts apps/api/src/routes/puzzles.worker.ts apps/api/src/routes/admin.ts apps/api/src/routes/admin.worker.ts apps/api/src/routes/puzzles.test.ts apps/api/src/routes/__tests__/puzzles.worker.test.ts apps/api/src/routes/__tests__/admin.test.ts apps/api/src/routes/__tests__/admin.worker.test.ts
rtk git commit -m "feat(shared): fence deleted puzzle lifecycle writes"
```

---

### Task 5: Make Worker Admin Deletion Durable Through Required D1 Finish

**Files:**

- Create: `apps/api/src/services/puzzle-deletion.worker.ts`
- Create: `apps/api/src/services/__tests__/puzzle-deletion.worker.test.ts`
- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/routes/__tests__/admin.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-coverage.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-coverage-gaps.worker.test.ts`

**Interfaces:**

- Consumes: `CompletionWriteExecutor.beginPuzzleDeletion` and `finishPuzzleDeletion` from
  Task 4, plus existing cleanup-record and ownership repositories.
- Produces:

```ts
export async function ensureWorkerPuzzleDeletionFence(
	env: Env,
	record: CleanupRecord,
	deletedAt?: number
): Promise<void>;

export async function finishWorkerPuzzleDeletion(env: Env, puzzleId: string): Promise<void>;
```

`ensureWorkerPuzzleDeletionFence` persists the record before inserting the tombstone.
`finishWorkerPuzzleDeletion` requires completion cleanup, then ownership cleanup, then cleanup
record deletion.

- [ ] **Step 1: Write the helper tests red**

Cover:

- cleanup record write occurs before D1 begin;
- cleanup-record failure prevents begin and all source work;
- begin failure retains the successfully written record;
- repeated ensure calls are idempotent;
- finish calls completion cleanup, ownership cleanup, then record deletion;
- completion failure prevents ownership and record deletion;
- ownership failure prevents record deletion while leaving completion cleanup safely repeatable;
- record-delete failure rejects after all database cleanup, so the next retry can finish.

- [ ] **Step 2: Run the helper tests red**

```bash
rtk bun run test --filter=@perseus/api -- src/services/__tests__/puzzle-deletion.worker.test.ts
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the lifecycle helper**

Use:

```ts
export async function ensureWorkerPuzzleDeletionFence(
	env: Env,
	record: CleanupRecord,
	deletedAt = Date.now()
): Promise<void> {
	await writeCleanupRecord(env.PUZZLE_METADATA, record);
	await getWorkerDbContext(env).completionWrites.beginPuzzleDeletion(record.puzzleId, deletedAt);
}

export async function finishWorkerPuzzleDeletion(env: Env, puzzleId: string): Promise<void> {
	const { db, completionWrites } = getWorkerDbContext(env);
	await completionWrites.finishPuzzleDeletion(puzzleId);
	await deletePuzzleOwnership(db, puzzleId);
	await deleteCleanupRecord(env.PUZZLE_METADATA, puzzleId);
}
```

Do not catch-and-log required database failures inside this helper.

- [ ] **Step 4: Write admin force-delete ordering tests red**

Pin:

- authorized request may write its cleanup record before termination/liveness work;
- a read-only liveness deferral that does not commit deletion creates no D1 tombstone;
- immediately before the first destructive source call, D1 begin has succeeded;
- D1 begin failure prevents DO/R2/KV mutation;
- source failure leaves record+tombstone;
- required completion or ownership failure leaves record+tombstone and returns retriable 500;
- cleanup record is deleted only after source and both database cleanups succeed.

- [ ] **Step 5: Integrate Worker admin deletion**

Preserve the current workflow termination and status policy. At the point the route commits to
destructive cleanup:

```text
existing/read-only gates
→ ensureWorkerPuzzleDeletionFence
→ deleteMetadataDO
→ deletePuzzleAssets
→ deletePuzzleMetadata
→ best-effort idempotency release
→ finishWorkerPuzzleDeletion
```

Remove `.catch(log)` wrappers around completion/ownership cleanup. Do not increment a successful
deletion result before `finishWorkerPuzzleDeletion` resolves.

- [ ] **Step 6: Run helper and admin tests green**

```bash
rtk bun run test --filter=@perseus/api -- src/services/__tests__/puzzle-deletion.worker.test.ts src/routes/__tests__/admin.worker.test.ts src/routes/__tests__/admin-coverage.worker.test.ts src/routes/__tests__/admin-coverage-gaps.worker.test.ts
rtk bun run check --filter=@perseus/api
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/api/src/services/puzzle-deletion.worker.ts apps/api/src/services/__tests__/puzzle-deletion.worker.test.ts apps/api/src/routes/admin.worker.ts apps/api/src/routes/__tests__/admin.worker.test.ts apps/api/src/routes/__tests__/admin-coverage.worker.test.ts apps/api/src/routes/__tests__/admin-coverage-gaps.worker.test.ts
rtk git commit -m "fix(api): make Worker puzzle deletion durably retryable"
```

---

### Task 6: Converge Every Reaper Path Without Prematurely Fencing Live Puzzles

**Files:**

- Modify: `apps/api/src/services/reaper.ts`
- Modify: `apps/api/src/services/__tests__/reaper.test.ts`
- Reuse: `apps/api/src/services/puzzle-deletion.worker.ts`

**Interfaces:**

- Consumes: the Worker lifecycle helper from Task 5.
- Produces: one consistent commit sequence for `reapStuckPuzzles`, `reapCleanupRecords`, and
  `reapOrphanedReservations`.

- [ ] **Step 1: Invert the old best-effort cleanup tests**

Replace tests such as “still reaps a cleanup record when atomic completion cleanup fails” with
assertions that:

- `result.reaped` does not increment;
- `deleteCleanupRecord` is not called;
- the D1 tombstone remains;
- the existing cleanup record remains discoverable;
- the next pass retries and succeeds idempotently.

Add the same assertions for ownership failure.

- [ ] **Step 2: Add read-only gate and record-bootstrap tests**

For cleanup-record, stuck, and orphan paths, cover:

- workflow status lookup failure, alive status, and unknown status do not insert a new D1
  tombstone or mutate source state;
- stuck `complete`/authoritatively ready skip remains unfenced;
- orphan owner-match/null-reservation skip remains unfenced;
- workflow-not-found is treated as stopped using `puzzleId` as the instance key;
- once stopped/eligible, stuck writes
  `{ puzzleId, pieceCount, idempotencyKey?, createdAt }` before D1 begin;
- orphan writes the same record with its required idempotency key before D1 begin;
- cleanup-record reaper reuses the existing record;
- record write failure prevents D1 begin and source mutation;
- source failure after D1 begin retains record+tombstone.

- [ ] **Step 3: Run the reaper suite red**

```bash
rtk bun run test --filter=@perseus/api -- src/services/__tests__/reaper.test.ts
```

Expected: FAIL because stuck/orphan lack records, D1 cleanup is best-effort, and success is counted
before required finish.

- [ ] **Step 4: Refactor each path after its existing eligibility gates**

Keep each path's current evidence rules. Only after the workflow is confirmed stopped and the
puzzle is selected for deletion, run:

```ts
await ensureWorkerPuzzleDeletionFence(env, {
	puzzleId,
	pieceCount,
	...(idempotencyKey ? { idempotencyKey } : {}),
	createdAt: Date.now()
});
```

Then preserve the existing safe source order:

```text
deleteMetadataDO → deletePuzzleAssets → deletePuzzleMetadata
```

After successful source cleanup, keep idempotency release best-effort and require:

```ts
await finishWorkerPuzzleDeletion(env, puzzleId);
```

Increment `reaped` and emit the success detail only after finish resolves. On finish failure,
increment `errors`, emit a distinct retriable D1-finish detail, and preserve the cleanup record.

- [ ] **Step 5: Run the reaper suite green**

```bash
rtk bun run test --filter=@perseus/api -- src/services/__tests__/reaper.test.ts
rtk bun run check --filter=@perseus/api
```

Expected: PASS with no deletion path able to lose its only retry signal.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/api/src/services/reaper.ts apps/api/src/services/__tests__/reaper.test.ts
rtk git commit -m "fix(api): fence and retry every reaper deletion"
```

---

### Task 7: Add Usage Reconciliation and Capacity Operations

**Files:**

- Create: `packages/shared/drizzle/maintenance/reconcile_completion_usage.sql`
- Modify: `packages/shared/src/__tests__/schema.test.ts`
- Modify: `docs/OPERATOR_RUNBOOK.md`

**Interfaces:**

- Consumes: usage/ledger invariant from Task 1.
- Produces: tested operator preflight, atomic repair, and capacity-monitoring procedure.

- [ ] **Step 1: Write the failing reconciliation tests**

Load the maintenance SQL in `schema.test.ts` and prove:

- it clears stale usage rows and rebuilds exact grouped counts;
- players with zero ledger rows have no usage row;
- running it twice is idempotent;
- a player whose actual count exceeds `100_000` aborts without changing the existing usage table;
- statement execution is atomic;
- a missing usage row does not prevent later ledger deletion.

- [ ] **Step 2: Run the schema test red**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/schema.test.ts
```

Expected: FAIL because the maintenance SQL does not exist.

- [ ] **Step 3: Add the guarded maintenance SQL**

Use a guard table inside the same atomic maintenance execution so an oversized actual group
aborts before counters change:

```sql
CREATE TABLE completion_usage_reconcile_guard (
	retained_runs INTEGER NOT NULL
		CHECK (retained_runs BETWEEN 0 AND 100000)
);

INSERT INTO completion_usage_reconcile_guard (retained_runs)
SELECT COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;

DELETE FROM player_completion_usage;

INSERT INTO player_completion_usage (player_id, retained_runs)
SELECT player_id, COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;

DROP TABLE completion_usage_reconcile_guard;
```

The test must execute the whole file as one transaction. A failed guard insert rolls back the
guard-table creation and leaves no maintenance artifact behind.

- [ ] **Step 4: Document the operator procedure**

Add to `docs/OPERATOR_RUNBOOK.md`:

1. pause/disable completion writes for the maintenance window;
2. run a read-only report:

```sql
SELECT player_id, COUNT(*) AS retained_runs
FROM puzzle_completion_runs
GROUP BY player_id
HAVING COUNT(*) > 100000;
```

3. abort and investigate if any row is returned;
4. execute the checked-in reconciliation SQL:

```bash
rtk bunx wrangler d1 execute perseus-player-data --remote --config apps/api/wrangler.production.toml --file packages/shared/drizzle/maintenance/reconcile_completion_usage.sql
```

5. verify this mismatch query returns no rows:

```sql
SELECT actual.player_id, actual.retained_runs, usage.retained_runs
FROM (
	SELECT player_id, COUNT(*) AS retained_runs
	FROM puzzle_completion_runs
	GROUP BY player_id
) AS actual
LEFT JOIN player_completion_usage AS usage
	ON usage.player_id = actual.player_id
WHERE usage.retained_runs IS NULL
	OR usage.retained_runs != actual.retained_runs
UNION ALL
SELECT usage.player_id, 0, usage.retained_runs
FROM player_completion_usage AS usage
LEFT JOIN puzzle_completion_runs AS runs
	ON runs.player_id = usage.player_id
WHERE runs.player_id IS NULL;
```

6. resume writes only after verification;
7. monitor D1 `databaseSizeBytes`, ledger row count, tombstone row count, and growth trend;
8. escalate before reaching the active plan's D1 size limit; never prune tombstones without a
   replacement permanent no-reuse mechanism.

- [ ] **Step 5: Run the maintenance tests green**

```bash
rtk bun run test --filter=@perseus/shared -- src/__tests__/schema.test.ts
rtk bunx prettier --check docs/OPERATOR_RUNBOOK.md
rtk git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/shared/drizzle/maintenance/reconcile_completion_usage.sql packages/shared/src/__tests__/schema.test.ts docs/OPERATOR_RUNBOOK.md
rtk git commit -m "docs: add completion usage reconciliation runbook"
```

---

### Task 8: Apply Migration 0004 and Verify HPA-371 Acceptance

**Files:**

- Modify only files that own a newly discovered acceptance defect.

**Interfaces:**

- Consumes: all preceding tasks.
- Produces: a deployable HPA-371 server contract that unblocks HPA-372.

- [ ] **Step 1: Recreate the local migration boundary**

Apply the repository's local D1 migration command and rerun the fresh in-memory migration proof
from Task 1:

```bash
rtk bun --cwd apps/api run db:migrate:local
rtk bun run test --filter=@perseus/shared -- src/__tests__/schema.test.ts
```

Expected: migration `0004` applies completely in both paths and is idempotently recorded.

- [ ] **Step 2: Run all focused contract suites**

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/shared
rtk bun run test --filter=@perseus/api
rtk bun run test:unit --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 3: Run repository-wide static and build gates**

```bash
rtk bun run check
rtk bun run lint
rtk bun run build
rtk git diff --check
```

Expected: PASS.

- [ ] **Step 4: Run authenticated completion and deletion smokes**

Against local development data, verify:

```text
legacy first write -> 200
versioned first write -> 200
exact replay -> 200
changed-facts reuse -> 409
small injected quota boundary -> 429
begin deletion racing a paused completion -> completion 404, no resurrection
exact replay after begin deletion -> 404
failed source/D1 finish -> cleanup record+tombstone retained
retry finish -> cleanup record removed only after all required cleanup
```

Record the commands and results in the implementation handoff; do not commit credentials or
temporary data.

- [ ] **Step 5: Audit migration and rollout safety**

Confirm:

- deploy workflow applies `0004` before new Worker code on existing stacks;
- first-deploy runbook still requires migrations before DB-backed routes;
- old Workers may briefly surface trigger-backed 500 instead of typed 404/429;
- no non-additive DDL exists;
- every creation and deletion path uses the permanent no-reuse fence;
- HPA-372 remains blocked until this gate is deployed and its terminal error mapping is green.

- [ ] **Step 6: Resolve any acceptance defect at its owning task**

For each failure, return to the task that owns it, add a focused failing test, make the smallest
fix, rerun that task's green command, and commit with:

```bash
rtk git commit -m "fix: close HPA-371 corrective acceptance gap"
```

Use the owning task's exact staging list. Do not create a catch-all commit or stage unrelated
workspace changes. If no files changed, do not create an empty commit.

- [ ] **Step 7: Request final whole-branch review**

Review the complete branch against both approved design documents, `main`, the live HPA-371
acceptance criteria, and the HPA-372 dependency. Fix only still-valid findings through focused
red/green cycles.

- [ ] **Step 8: Declare HPA-371 ready**

HPA-371 is ready only when:

- all focused and repository-wide commands pass;
- both runtimes return typed 404/429 without trigger parsing;
- no deletion path can mutate source before its permanent fence;
- no required D1 failure can delete the cleanup record;
- usage equals real ledger count after every tested sequence;
- migration artifacts and deploy ordering are complete;
- HPA-372's plan and Linear issue name the terminal error dependency.
