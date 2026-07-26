# HPA-371 Versioned Completion and Statistics Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Corrective follow-up:** After this original plan, execute
> [`2026-07-25-hpa-371-deletion-fence-and-ledger-quota-corrections.md`](2026-07-25-hpa-371-deletion-fence-and-ledger-quota-corrections.md)
> before declaring HPA-371 deployable or unblocking HPA-372.

**Goal:** Ship the independently deployable server half of HPA-236: a versioned, idempotent
completion endpoint; an atomic per-run ledger; a combined statistics read model; nullable
standard-best presentation; and legacy-request compatibility.

**Architecture:** Keep the existing `puzzle_stats` rows as the historical standard-best and
pre-ledger count baseline. Store every versioned completion in a new
`puzzle_completion_runs` ledger keyed by `(player_id, run_id)`. Route both API runtimes through
one parser and result interpreter, while concrete D1 and Bun executors provide the atomic
write primitive that the erased `AppDb` type cannot express. Build profile rows and summaries
from the union of historical rows and ledger groups.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Cloudflare D1, `bun:sqlite`, Miniflare, Svelte 5,
Vitest, Bun, Turborepo

## Global Constraints

- Approved design baseline:
  `docs/superpowers/specs/2026-07-25-puzzle-session-foundation-design.md`.
- Linear delivery issue:
  `https://linear.app/cwchanap/issue/HPA-371/foundation-ship-versioned-puzzle-completion-and-statistics-contract`.
- Work only on HPA-371. Do not add `PuzzleSession`, client session persistence, or the v1 web
  completion caller in this plan.
- The final HPA-371 branch must accept both versioned requests and the existing
  `{ timeSeconds }` payload so an already-loaded web bundle remains compatible.
- Keep `puzzle_stats.best_time_seconds` physically `NOT NULL`. Nullability exists only in the
  combined public read model.
- Versioned writes never increment `puzzle_stats.total_completions`; that column remains the
  pre-ledger/legacy baseline.
- A versioned standard best is eligible only when all three facts match:
  `resultClass === 'standard_timed'`, `timingQuality === 'known'`, and
  `elapsedActiveSeconds !== null`.
- The ledger key is `(player_id, run_id)`. Do not include `puzzle_id` in the key.
- Reusing a run ID with different puzzle/result/timing/elapsed facts returns HTTP 409 and
  cannot mutate `puzzle_stats`.
- Exact replay uses the ledger row's original `completed_at`, not the retry time.
- D1 uses one concrete Drizzle D1 `batch()` call. Bun uses one synchronous
  `bun:sqlite` transaction. Do not emulate either with the cross-runtime `AppDb`.
- Maintain the accepted rollout behavior: a legacy request and a versioned request can count
  the same solve twice, and distinct run IDs from concurrent tabs count independently.
- Tabs for indentation, single quotes, no trailing commas, 100-character line width.
- Use `rtk` for shell commands. Use `apply_patch` for source edits.
- Run the focused red test before implementation, then the focused green test after it.
- Every task ends in a commit. Do not combine tasks into one large commit.

---

## File Structure

### New files

| File                                                      | Responsibility                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/api/src/routes/puzzles.complete.shared.ts`          | Shared legacy/v1 request parser and repository-result-to-HTTP mapping                 |
| `packages/shared/src/completion-writes.ts`                | Versioned completion input/result contract, shared predicates, and executor interface |
| `packages/shared/drizzle/0003_puzzle_completion_runs.sql` | Additive ledger migration and required indexes                                        |
| `packages/shared/drizzle/meta/0003_snapshot.json`         | Drizzle schema snapshot generated with migration 0003                                 |

### Main modified files

| File                                                    | Change                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/index.ts`                           | Completion request/response types, bounded values, run-ID/request validators, nullable result contract cutover |
| `packages/types/src/index.test.ts`                      | Contract and validation matrix                                                                                 |
| `packages/shared/src/schema.ts`                         | `puzzleCompletionRuns` table and indexes                                                                       |
| `packages/shared/src/types.ts`                          | Ledger row types and concrete context types where needed                                                       |
| `packages/shared/src/repositories.ts`                   | Legacy write, versioned write interpretation, combined stats/summary read model, cursor v2, companion cleanup  |
| `packages/shared/src/drivers/d1.ts`                     | Preserve concrete D1 client and create D1 batch executor                                                       |
| `packages/shared/src/drivers/bun.ts`                    | Preserve `bun:sqlite` handle and create Bun transaction executor                                               |
| `packages/shared/src/index.ts`                          | Export the completion contract                                                                                 |
| `packages/shared/src/__tests__/schema.test.ts`          | Migration/table/index proof                                                                                    |
| `packages/shared/src/__tests__/repositories.test.ts`    | Bun behavior, combined rows, cursors, cleanup                                                                  |
| `packages/shared/src/__tests__/repositories.d1.test.ts` | Real D1 batch behavior and parity                                                                              |
| `packages/shared/src/__tests__/drivers.test.ts`         | Context construction and atomic failure behavior                                                               |
| `apps/api/src/db.ts`                                    | Cache Bun DB plus completion executor as one context                                                           |
| `apps/api/src/db.worker.ts`                             | Cache concrete D1 DB plus completion executor per environment                                                  |
| `apps/api/src/__tests__/db.worker.test.ts`              | Worker context caching                                                                                         |
| `apps/api/src/routes/puzzles.complete.ts`               | Bun runtime shell for legacy and v1 completion                                                                 |
| `apps/api/src/routes/puzzles.complete.worker.ts`        | Worker runtime shell for legacy and v1 completion                                                              |
| `apps/api/src/routes/puzzles.complete.test.ts`          | Bun status/request matrix                                                                                      |
| `apps/api/src/routes/puzzles.complete.worker.test.ts`   | Worker status/request matrix                                                                                   |
| `apps/api/src/routes/_cross-runtime-drift.test.ts`      | Keep the two runtime shells aligned                                                                            |
| `apps/api/src/routes/player.ts`                         | Combined stats projection and invalid-cursor 400                                                               |
| `apps/api/src/routes/player.worker.ts`                  | Worker equivalent                                                                                              |
| `apps/api/src/routes/player.worker.test.ts`             | Nullable row and cursor error behavior                                                                         |
| `apps/api/src/__tests__/player.test.ts`                 | Bun player route parity                                                                                        |
| `apps/api/src/routes/admin.ts`                          | Bun companion ledger cleanup                                                                                   |
| `apps/api/src/routes/admin.worker.ts`                   | Worker companion ledger cleanup                                                                                |
| `apps/api/src/services/reaper.ts`                       | Ledger cleanup in all three reaper deletion paths                                                              |
| `apps/api/src/services/__tests__/reaper.test.ts`        | Best-effort companion cleanup proof                                                                            |
| `apps/web/src/routes/profile/+page.svelte`              | Rename list and render nullable best safely                                                                    |
| `apps/web/src/routes/profile/page.svelte.test.ts`       | “Puzzle Results” and “No standard time”                                                                        |

---

## Task 1: Add the Shared Versioned Completion Contract

**Files:**

- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/index.test.ts`

**Produces:**

```ts
export const RESULT_CLASSES = [
	'standard_timed',
	'rotation_timed',
	'assisted_timed',
	'relaxed'
] as const;
export type ResultClass = (typeof RESULT_CLASSES)[number];

export const TIMING_QUALITIES = ['known', 'legacy_unknown'] as const;
export type TimingQuality = (typeof TIMING_QUALITIES)[number];

export interface RecordPuzzleCompletionV1 {
	version: 1;
	runId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
}

export type RecordPuzzleCompletionResponse =
	| { ok: true }
	| {
			error: 'bad_request' | 'unauthorized' | 'not_found' | 'run_id_conflict' | 'internal_error';
			message: string;
	  };
```

- [ ] **Step 1: Write the failing validator matrix**

Add table-driven tests to `packages/types/src/index.test.ts` for:

- canonical lowercase UUID v4 run IDs;
- `legacy-` plus exactly 64 lowercase hexadecimal characters;
- uppercase, non-v4, malformed, and padded run IDs;
- every allowed result class and timing quality;
- known `standard_timed`, `rotation_timed`, and `assisted_timed` requests requiring a positive
  integer elapsed time;
- known `relaxed` requiring `elapsedActiveSeconds: null`;
- `legacy_unknown` requiring null elapsed and rejecting `relaxed`;
- zero, negative, fractional, non-finite, over-24-hour, missing, and extra-invalid shapes.

Use an exported guard with the ceiling supplied explicitly:

```ts
expect(isRecordPuzzleCompletionV1(candidate, 86_400)).toBe(expected);
```

- [ ] **Step 2: Run the red test**

Run:

```bash
rtk bun run test:unit --filter=@perseus/types
```

Expected: FAIL because `ResultClass`, `TimingQuality`, `isPuzzleRunId`, and
`isRecordPuzzleCompletionV1` do not exist.

- [ ] **Step 3: Implement the bounded contract**

Add the constants, types, and these public functions in `packages/types/src/index.ts`:

```ts
export function isPuzzleRunId(value: unknown): value is string;

export function isRecordPuzzleCompletionV1(
	value: unknown,
	maxElapsedActiveSeconds: number
): value is RecordPuzzleCompletionV1;
```

The guard must reject unknown/missing fields that affect semantics, validate the exact
cross-field timing rules, and require a finite positive whole-second elapsed value not above
the supplied ceiling.

- [ ] **Step 4: Run the green type tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/types
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/types/src/index.ts packages/types/src/index.test.ts
rtk git commit -m "feat(types): define versioned completion contract"
```

---

## Task 2: Add the Completion Ledger Schema and Migration

**Files:**

- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/__tests__/schema.test.ts`
- Create: `packages/shared/drizzle/0003_puzzle_completion_runs.sql`
- Create: `packages/shared/drizzle/meta/0003_snapshot.json`
- Modify: `packages/shared/drizzle/meta/_journal.json`

**Schema:**

```ts
export const puzzleCompletionRuns = sqliteTable(
	'puzzle_completion_runs',
	{
		playerId: text('player_id').notNull(),
		runId: text('run_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		resultClass: text('result_class').notNull(),
		timingQuality: text('timing_quality').notNull(),
		elapsedActiveSeconds: integer('elapsed_active_seconds'),
		completedAt: integer('completed_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.runId] }),
		playerPuzzleCompletedIdx: index('idx_pcr_player_puzzle_completed').on(
			t.playerId,
			t.puzzleId,
			t.completedAt
		),
		puzzleIdx: index('idx_pcr_puzzle').on(t.puzzleId)
	})
);
```

- [ ] **Step 1: Extend the schema test before adding the table**

In `packages/shared/src/__tests__/schema.test.ts`, add assertions that:

- a valid run can be inserted and read;
- the same `(player_id, run_id)` cannot be inserted twice;
- the same run ID may exist for a different player;
- `PRAGMA index_list('puzzle_completion_runs')` contains
  `idx_pcr_player_puzzle_completed` and `idx_pcr_puzzle`;
- `PRAGMA index_info(...)` reports the composite index columns in the required order.

- [ ] **Step 2: Run the red schema test**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- schema.test.ts
```

Expected: FAIL because the table export and migration do not exist.

- [ ] **Step 3: Add the Drizzle schema and inferred row types**

Add `puzzleCompletionRuns` to `schema.ts`, including database checks that restrict
`result_class`, `timing_quality`, and valid elapsed/null combinations to the same bounded
contract as Task 1. Export `PuzzleCompletionRunRow` and `NewPuzzleCompletionRunRow` from
`packages/shared/src/types.ts`.

- [ ] **Step 4: Generate the named additive migration**

Run:

```bash
cd packages/shared
rtk bunx drizzle-kit generate --name puzzle_completion_runs
```

Expected: creates exactly:

- `drizzle/0003_puzzle_completion_runs.sql`
- `drizzle/meta/0003_snapshot.json`
- a new entry in `drizzle/meta/_journal.json`

Inspect `0003_puzzle_completion_runs.sql`. It must contain the table, composite primary key,
both named indexes, nullable elapsed column, and no destructive statement against existing
tables.

- [ ] **Step 5: Run schema and package checks**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- schema.test.ts
rtk bun run check --filter=@perseus/shared
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/shared/src/schema.ts packages/shared/src/types.ts packages/shared/src/__tests__/schema.test.ts packages/shared/drizzle
rtk git commit -m "feat(shared): add puzzle completion run ledger"
```

---

## Task 3: Define the Atomic Completion Protocol and D1 Batch Executor

**Files:**

- Create: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`

**Interfaces:**

```ts
export interface VersionedCompletionWrite {
	playerId: string;
	puzzleId: string;
	runId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
	receivedAt: number;
}

export interface StoredCompletionFacts {
	puzzleId: string;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	elapsedActiveSeconds: number | null;
	completedAt: number;
}

export interface CompletionWriteExecution {
	stored: StoredCompletionFacts;
	inserted: boolean;
}

export interface CompletionWriteExecutor {
	write(input: VersionedCompletionWrite): Promise<CompletionWriteExecution>;
	deletePuzzleCompletionData(puzzleId: string): Promise<void>;
}

export type VersionedCompletionResult =
	| { status: 'recorded'; completedAt: number }
	| { status: 'replayed'; completedAt: number }
	| { status: 'conflict' };
```

- [ ] **Step 1: Write real-D1 red tests**

Extend `packages/shared/src/__tests__/repositories.d1.test.ts`. Clear
`puzzle_completion_runs` in `beforeEach`, then prove:

- first versioned standard run inserts one ledger row and creates a `puzzle_stats` row with
  `total_completions = 0`;
- exact replay leaves one ledger row and repairs a manually deleted best row using the
  original ledger timestamp;
- replay with a different puzzle, result class, timing quality, or elapsed value returns
  conflict and leaves stats unchanged;
- rotation, assisted, relaxed, and legacy-unknown runs remain ledger-only;
- two distinct run IDs both count;
- forcing the conditional best statement to fail rolls back the ledger insert.

Use the concrete client returned by `createD1Db({ DB: d1 })`; do not cast the test subject to
`AppDb` for executor construction. For rollback proof, install a temporary
`BEFORE INSERT ON puzzle_stats` trigger that raises an error, run one otherwise-valid standard
write, then drop the trigger and assert neither table contains that run.

- [ ] **Step 2: Run the red D1 suite**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- repositories.d1.test.ts
```

Expected: FAIL because the atomic executor and repository entry point do not exist.

- [ ] **Step 3: Implement shared predicates and result interpretation**

In `completion-writes.ts`, add:

```ts
export function isCanonicalBest(input: VersionedCompletionWrite): boolean;
export function completionFactsMatch(
	input: VersionedCompletionWrite,
	stored: StoredCompletionFacts
): boolean;
export function interpretVersionedCompletionWrite(
	input: VersionedCompletionWrite,
	stored: StoredCompletionFacts,
	inserted: boolean
): VersionedCompletionResult;
```

`completionFactsMatch` compares puzzle, result class, timing quality, and elapsed time exactly.
It deliberately ignores `receivedAt`; replays retain `stored.completedAt`.

- [ ] **Step 4: Preserve and export the concrete D1 client**

Change `packages/shared/src/drivers/d1.ts` so `createD1Db` returns its concrete Drizzle D1 type
while remaining assignable at `AppDb` call sites:

```ts
import type { DrizzleD1Database } from 'drizzle-orm/d1';

export type D1AppDb = DrizzleD1Database<typeof schema>;
export function createD1Db(env: D1Env): D1AppDb;
export function createD1CompletionWriteExecutor(db: D1AppDb): CompletionWriteExecutor;
```

The executor must batch a fixed sequence:

1. `INSERT ... ON CONFLICT DO NOTHING` into `puzzle_completion_runs`;
2. read the stored row for `(player_id, run_id)`;
3. conditionally `INSERT ... SELECT ... ON CONFLICT DO UPDATE` the standard best only when the
   stored facts exactly match the request and satisfy the canonical-best predicate.

The conditional upsert selects `completed_at` from the ledger so exact replay repairs use the
original timestamp. The insert path initializes `puzzle_stats.total_completions` to `0`. On
conflict with an existing historical row, update only the minimum best time; preserve its
baseline `total_completions`, `first_completed_at`, and `last_completed_at`. Execute all
statements through one `db.batch([...])`.

For `deletePuzzleCompletionData`, batch the `puzzle_stats` and ledger deletes together.

- [ ] **Step 5: Add the repository entry point**

In `packages/shared/src/repositories.ts`, preserve the current heuristic function as:

```ts
export async function recordLegacyCompletion(
	db: AppDb,
	playerId: string,
	puzzleId: string,
	timeSeconds: number
): Promise<void>;
```

Keep a deprecated `recordCompletion` alias pointing to `recordLegacyCompletion` until Task 7
migrates both route shells. This keeps each intermediate commit buildable; remove the alias in
Task 7 after `rtk rg` proves no caller remains.

Add:

```ts
export async function recordVersionedCompletion(
	executor: CompletionWriteExecutor,
	playerId: string,
	puzzleId: string,
	request: RecordPuzzleCompletionV1,
	receivedAt = Date.now()
): Promise<VersionedCompletionResult>;
```

The repository owns the shared result interpretation. The executor owns only the atomic
driver operation.

- [ ] **Step 6: Run the green D1 suite**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- repositories.d1.test.ts
rtk bun run check --filter=@perseus/shared
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/shared/src/completion-writes.ts packages/shared/src/drivers/d1.ts packages/shared/src/index.ts packages/shared/src/repositories.ts packages/shared/src/__tests__/repositories.d1.test.ts
rtk git commit -m "feat(shared): add atomic D1 completion executor"
```

---

## Task 4: Add the Bun Transaction Executor and Runtime DB Contexts

**Files:**

- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/db.worker.ts`
- Modify: `apps/api/src/__tests__/db.worker.test.ts`

**Contexts:**

```ts
export interface BunDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
	close(): void;
}

export interface ApiDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
}
```

- [ ] **Step 1: Write Bun parity and rollback tests**

In `packages/shared/src/__tests__/drivers.test.ts`, use a temporary database directory and
prove the same cases as the D1 executor:

- first write and exact replay;
- conflict with no best mutation;
- non-standard ledger-only write;
- conditional-best failure rolls back the ledger insert;
- companion deletion removes both physical tables in one transaction.

Add a parity table that feeds the same inputs to D1 and Bun executors and compares normalized
ledger/stat rows. Use a temporary failing SQLite trigger for rollback proof rather than a mock
that bypasses the real transaction.

- [ ] **Step 2: Run the red driver test**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- drivers.test.ts
```

Expected: FAIL because the Bun context/executor does not exist.

- [ ] **Step 3: Implement the Bun context**

In `packages/shared/src/drivers/bun.ts`:

- retain the existing `Database` handle next to the Drizzle client;
- add `createBunDbContext(dataDir): BunDbContext`;
- implement `CompletionWriteExecutor.write` inside `sqlite.transaction(...)`;
- use the same shared SQL builder/predicates and return shape as D1;
- add `close()` for test cleanup;
- keep `createBunDb(dataDir)` as a compatibility wrapper returning
  `createBunDbContext(dataDir).db` until all callers have migrated.

Do not use an async callback inside `bun:sqlite`'s synchronous transaction.

- [ ] **Step 4: Cache one context per runtime**

Update:

```ts
// apps/api/src/db.ts
export function getDbContext(): ApiDbContext;
export function getDb(): AppDb;

// apps/api/src/db.worker.ts
export function getWorkerDbContext(env: Env): ApiDbContext;
export function getWorkerDb(env: Env): AppDb;
```

`getDb()` and `getWorkerDb()` remain compatibility projections from their cached contexts.
The worker cache remains a `WeakMap<Env, ApiDbContext>`.

- [ ] **Step 5: Run focused and API type checks**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- drivers.test.ts
rtk bun run test --filter=@perseus/api -- db.worker.test.ts
rtk bun run check --filter=@perseus/shared
rtk bun run check --filter=@perseus/api
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/shared/src/drivers/bun.ts packages/shared/src/__tests__/drivers.test.ts apps/api/src/db.ts apps/api/src/db.worker.ts apps/api/src/__tests__/db.worker.test.ts
rtk git commit -m "feat(api): provide runtime completion write contexts"
```

---

## Task 5: Build the Combined Stats Read Model and Cursor v2

**Files:**

- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`

**Cursor contract:**

```text
v2|0|<bestTimeSeconds>|<puzzleId>
v2|1||<puzzleId>
```

Legacy accepted forms:

```text
<bestTimeSeconds>|<puzzleId>
<bestTimeSeconds>
```

- [ ] **Step 1: Write the combined read-model red tests**

Add repository tests covering:

- a historical-only row;
- a versioned standard run with baseline `0`;
- a variant-only ledger group with `bestTimeSeconds: null`;
- historical baseline plus ledger count;
- minimum first-completed and maximum last-completed timestamps across both sources;
- variant-only timestamps from the ledger;
- a new `getCombinedPlayerSummary` using the same solved-group and total formula;
- standard rows ordered first by best time then puzzle ID;
- null rows ordered after standard rows by puzzle ID.

- [ ] **Step 2: Write the cursor red tests**

Cover:

- v2 group-0 to group-0;
- v2 group-0 crossing into group-1;
- v2 group-1 continuation;
- legacy composite crossing into all remaining null rows;
- legacy bare time using `bestTimeSeconds > cursorTime` and then all null rows;
- ties on best time and puzzle ID;
- malformed numbers, empty IDs, extra separators, and unknown versions.

Malformed cursors must throw a dedicated exported `InvalidPlayerStatsCursorError`; they must
not silently return an empty page.

- [ ] **Step 3: Run the red repository suites**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- repositories.test.ts repositories.d1.test.ts
```

Expected: FAIL under the historical-only query and legacy cursor implementation.

- [ ] **Step 4: Implement the union query behind an additive repository entry point**

Add `listCombinedPlayerStats` around a CTE with these logical stages:

1. aggregate ledger by player and puzzle (`COUNT`, `MIN(completed_at)`,
   `MAX(completed_at)`);
2. full logical union of historical groups and ledger groups;
3. left join `puzzle_stats` for nullable standard best/baseline;
4. left join `puzzles` for display name;
5. compute:

```text
totalCompletions =
	COALESCE(puzzle_stats.total_completions, 0) + COALESCE(ledger.count, 0)
firstCompletedAt = MIN(non-null historical first, non-null ledger first)
lastCompletedAt = MAX(non-null historical last, non-null ledger last)
sortGroup = CASE WHEN best_time_seconds IS NULL THEN 1 ELSE 0 END
```

Return `bestTimeSeconds: number | null`. Keep the limit clamp and fetch `limit + 1`.
Leave the current `listPlayerStats` in place until Task 6 atomically switches the public
type/API/UI contract; this avoids breaking downstream packages in an intermediate commit.

- [ ] **Step 5: Implement strict cursor parsing**

Export or isolate a pure parser returning:

```ts
type PlayerStatsCursor =
	| { version: 2; group: 0; bestTimeSeconds: number; puzzleId: string }
	| { version: 2; group: 1; puzzleId: string }
	| { version: 1; kind: 'composite'; bestTimeSeconds: number; puzzleId: string }
	| { version: 1; kind: 'bare'; bestTimeSeconds: number };
```

The continuation predicate for both legacy forms must include every group-1 row. Encode only
v2 cursors for new responses.

- [ ] **Step 6: Align summary aggregation**

Add `getCombinedPlayerSummary` so:

- `puzzlesSolved` counts distinct player/puzzle groups from the historical/ledger union;
- `totalCompletions` sums historical baselines plus ledger counts;
- upload counting remains unchanged.

- [ ] **Step 7: Run focused read-model tests**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- repositories.test.ts repositories.d1.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/shared/src/repositories.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts
rtk git commit -m "feat(stats): build combined completion read model"
```

---

## Task 6: Cut Over the Public Stats API and Nullable Profile Presentation

**Files:**

- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/index.test.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `apps/api/src/routes/player.ts`
- Modify: `apps/api/src/routes/player.worker.ts`
- Modify: `apps/api/src/routes/player.worker.test.ts`
- Modify: `apps/api/src/__tests__/player.test.ts`
- Modify: `apps/web/src/routes/profile/+page.svelte`
- Modify: `apps/web/src/routes/profile/page.svelte.test.ts`

- [ ] **Step 1: Write the nullable shared-type red tests**

Change the `PlayerStatRow` fixtures in `packages/types/src/index.test.ts` to prove:

- finite numeric standard best is valid;
- null standard best is valid;
- missing, undefined, string, NaN, and infinite best values are invalid.

- [ ] **Step 2: Write the player-route cutover red tests**

For both Bun and Worker route tests, cover:

- variant-only row projects `bestTimeSeconds: null`;
- profile summary matches combined list totals;
- v2 cursor is forwarded;
- malformed/unknown cursor returns structured HTTP 400;
- unrelated database errors are not mislabeled as bad cursors.

- [ ] **Step 3: Write the red profile test**

Add a profile fixture containing:

```ts
{
	puzzleId: 'variant-only',
	puzzleName: 'Variant Result',
	bestTimeSeconds: null,
	totalCompletions: 2,
	firstCompletedAt: 100,
	lastCompletedAt: 200
}
```

Assert:

- the section heading is `Puzzle Results`;
- the row shows `No standard time`;
- `formatTime` is never invoked with null;
- a numeric best still renders using the current format;
- a gallery/card best badge is absent when its input is null.

- [ ] **Step 4: Run the red contract, route, and web tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/api -- player.test.ts player.worker.test.ts
rtk bun run test:unit --filter=@perseus/web -- profile/page.svelte.test.ts PuzzleCard.svelte.test.ts
```

Expected: FAIL because the public type/route still require a numeric best and the UI still says
`Best Times`.

- [ ] **Step 5: Switch the public shared type**

Change:

```ts
bestTimeSeconds: number;
```

to:

```ts
bestTimeSeconds: number | null;
```

Update `isPlayerStatRow` to accept only a finite number or null. Do not accept `undefined`.

- [ ] **Step 6: Switch both player routes to the combined model**

Replace their stats/summary repository calls with `listCombinedPlayerStats` and
`getCombinedPlayerSummary`. Catch only `InvalidPlayerStatsCursorError` around the stats list
and return:

```ts
{ error: 'bad_request', message: 'Invalid stats cursor' }
```

with status 400. Do not convert unrelated database errors to 400.

After every production/test caller is migrated, remove the old historical-only
`listPlayerStats`/`getPlayerSummary` implementations and rename the combined functions back to
those established public names. Update the Task 5 repository tests in the same edit. Use
`rtk rg` to prove there is no stale combined/legacy function name.

- [ ] **Step 7: Implement nullable presentation**

Rename the heading and use an explicit branch:

```svelte
{#if s.bestTimeSeconds === null}
	<span class="shrink-0 text-xs text-(--text-2)">No standard time</span>
{:else}
	<span class="shrink-0 font-(--font-mono) text-(--gold)">
		{formatTime(s.bestTimeSeconds)}
	</span>
{/if}
```

Do not coerce null to zero. Preserve the completion count and deleted-puzzle-name fallback.

- [ ] **Step 8: Run the green contract, repository, route, and web tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/shared -- repositories.test.ts repositories.d1.test.ts
rtk bun run test --filter=@perseus/api -- player.test.ts player.worker.test.ts
rtk bun run test:unit --filter=@perseus/web -- profile/page.svelte.test.ts PuzzleCard.svelte.test.ts
rtk bun run check --filter=@perseus/types
rtk bun run check --filter=@perseus/api
rtk bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
rtk git add packages/types/src/index.ts packages/types/src/index.test.ts packages/shared/src/repositories.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts apps/api/src/routes/player.ts apps/api/src/routes/player.worker.ts apps/api/src/routes/player.worker.test.ts apps/api/src/__tests__/player.test.ts apps/web/src/routes/profile/+page.svelte apps/web/src/routes/profile/page.svelte.test.ts apps/web/src/lib/components/PuzzleCard.svelte apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts
rtk git commit -m "feat(stats): expose nullable puzzle results"
```

If `PuzzleCard.svelte` needs no change, omit it and its test from `git add`.

---

## Task 7: Share Completion Parsing and Upgrade Both API Routes

**Files:**

- Create: `apps/api/src/routes/puzzles.complete.shared.ts`
- Modify: `apps/api/src/routes/puzzles.complete.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.ts`
- Modify: `apps/api/src/routes/puzzles.complete.test.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`
- Modify: `apps/api/src/routes/_cross-runtime-drift.test.ts`

**Parser result:**

```ts
export type ParsedCompletionRequest =
	| { kind: 'legacy'; timeSeconds: number }
	| { kind: 'versioned'; request: RecordPuzzleCompletionV1 };

export type CompletionRequestParseResult =
	| { ok: true; value: ParsedCompletionRequest }
	| { ok: false; body: RecordPuzzleCompletionResponse; status: 400 };
```

- [ ] **Step 1: Expand both route test matrices**

For Bun and Worker, add:

- every valid v1 result/timing combination;
- exact replay returning 200;
- repository conflict returning structured 409 `run_id_conflict`;
- malformed v1 fields/timing returning 400;
- legacy `{ timeSeconds }` still calling `recordLegacyCompletion`;
- invalid JSON 400;
- unauthenticated 401;
- missing/non-ready puzzle 404;
- metadata lookup failure 500;
- executor/repository failure structured 500;
- versioned inputs passed without accidental legacy flooring or rewriting.

Retain the existing legacy ceiling and fractional-floor tests.

- [ ] **Step 2: Run the red route suites**

Run:

```bash
rtk bun run test --filter=@perseus/api -- puzzles.complete.test.ts puzzles.complete.worker.test.ts
```

Expected: FAIL because the route accepts only `{ timeSeconds }`.

- [ ] **Step 3: Implement the shared parser and interpreter**

In `puzzles.complete.shared.ts`:

- detect versioned input only when `version` is present;
- validate v1 using `isRecordPuzzleCompletionV1(value, 86_400)`;
- otherwise validate the exact legacy `{ timeSeconds }` compatibility path;
- floor only legacy fractional seconds;
- expose `completionResultToResponse` mapping `conflict` to 409 and accepted/replayed to 200;
- expose a structured internal-error response helper used by both shells.

Do not let an invalid object containing `version` fall back to legacy parsing.

- [ ] **Step 4: Upgrade the Bun route**

After auth and puzzle readiness checks:

- keep best-effort ownership backfill unchanged;
- call `recordLegacyCompletion(getDb(), ...)` for legacy input;
- call `recordVersionedCompletion(getDbContext().completionWrites, ...)` for v1;
- catch repository/executor failures and return structured HTTP 500;
- return HTTP 409 on conflict.

- [ ] **Step 5: Upgrade the Worker route**

Mirror the Bun flow using:

```ts
getWorkerDb(c.env);
getWorkerDbContext(c.env).completionWrites;
```

Keep runtime-specific puzzle lookup in the shell. Do not duplicate parsing or result mapping.

- [ ] **Step 6: Remove the temporary legacy alias**

After both route shells import `recordLegacyCompletion`, remove the deprecated
`recordCompletion` alias from `packages/shared/src/repositories.ts`. Run:

```bash
rtk rg -n "\brecordCompletion\b" apps/api packages/shared
```

Expected: only intentional test descriptions or the web client's separately scoped API method
remain; no shared-repository import uses the old name.

- [ ] **Step 7: Strengthen the runtime drift test**

Update `_cross-runtime-drift.test.ts` to assert both routers import the shared parser, use the
same response codes, and keep only storage/auth/runtime-context differences.

- [ ] **Step 8: Run route, drift, and type checks**

Run:

```bash
rtk bun run test --filter=@perseus/api -- puzzles.complete.test.ts puzzles.complete.worker.test.ts _cross-runtime-drift.test.ts
rtk bun run check --filter=@perseus/api
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
rtk git add packages/shared/src/repositories.ts apps/api/src/routes/puzzles.complete.shared.ts apps/api/src/routes/puzzles.complete.ts apps/api/src/routes/puzzles.complete.worker.ts apps/api/src/routes/puzzles.complete.test.ts apps/api/src/routes/puzzles.complete.worker.test.ts apps/api/src/routes/_cross-runtime-drift.test.ts
rtk git commit -m "feat(api): accept idempotent versioned completions"
```

---

## Task 8: Make Puzzle Deletion Remove Ledger and Baseline Atomically

**Files:**

- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/services/reaper.ts`
- Modify: `apps/api/src/routes/__tests__/admin.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin.worker.test.ts`
- Modify: `apps/api/src/services/__tests__/reaper.test.ts`

- [ ] **Step 1: Write repository cleanup red tests**

Seed one puzzle with:

- a historical `puzzle_stats` row;
- ledger rows for multiple players;
- unrelated stats and ledger rows for another puzzle.

Call the companion cleanup and assert both target tables are empty for that puzzle while
unrelated rows remain. Inject a second-delete failure and assert the first delete rolls back.
Run this against both Bun and D1 executors.

- [ ] **Step 2: Write caller red tests**

For Bun admin, Worker admin, and all three reaper cleanup paths, assert:

- they call the executor-backed companion cleanup;
- failure remains logged/best-effort after source-of-truth puzzle deletion;
- no caller performs a separate non-atomic ledger delete.

- [ ] **Step 3: Run the red focused suites**

Run:

```bash
rtk bun run test --filter=@perseus/shared -- repositories.test.ts repositories.d1.test.ts
rtk bun run test --filter=@perseus/api -- admin.test.ts admin.worker.test.ts reaper.test.ts
```

Expected: FAIL because `deletePuzzleStats` currently deletes only `puzzle_stats`.

- [ ] **Step 4: Replace the cleanup implementation**

Keep the public repository name for caller clarity:

```ts
export async function deletePuzzleStats(
	executor: CompletionWriteExecutor,
	puzzleId: string
): Promise<void> {
	await executor.deletePuzzleCompletionData(puzzleId);
}
```

Update admin/reaper call sites to obtain the cached runtime context and pass
`completionWrites`. Keep ownership-row deletion separate because it has different
best-effort/source-of-truth semantics.

- [ ] **Step 5: Run the green cleanup suites**

Run the commands from Step 3.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/shared/src/repositories.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts apps/api/src/routes/admin.ts apps/api/src/routes/admin.worker.ts apps/api/src/services/reaper.ts apps/api/src/routes/__tests__/admin.test.ts apps/api/src/routes/__tests__/admin.worker.test.ts apps/api/src/services/__tests__/reaper.test.ts
rtk git commit -m "fix(stats): delete completion ledger with puzzle stats"
```

---

## Task 9: Apply the Migration and Verify the Independently Deployable Server

**Files:**

- Modify only files required by failures found during verification.

- [ ] **Step 1: Apply all local D1 migrations**

Run:

```bash
cd apps/api
rtk bun run db:migrate:local
```

Expected: migration `0003_puzzle_completion_runs` applies successfully after migrations
0000–0002.

- [ ] **Step 2: Run package suites**

From the repository root:

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/shared
rtk bun run test --filter=@perseus/api
rtk bun run test:unit --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 3: Run repository-wide static validation**

```bash
rtk bun run check
rtk bun run lint
rtk bun run build
rtk git diff --check
```

Expected: PASS with no formatting errors or production-build regression.

- [ ] **Step 4: Audit the migration/deploy boundary**

Confirm:

- `.github/workflows/deploy-infrastructure.yml` still applies additive D1 migrations before
  publishing subsequent Worker versions;
- the new SQL contains no rename/drop/destructive statement;
- Worker code never accesses the ledger before migration application in that workflow;
- the existing first-deploy caveat in `CLAUDE.md`/operator docs remains accurate.

No workflow edit is needed if these checks pass.

- [ ] **Step 5: Run a compatibility smoke test**

Against the local API with migrations applied, submit:

1. one authenticated legacy `{ "timeSeconds": 10 }` request;
2. one authenticated v1 standard request;
3. an exact replay of the v1 request;
4. a conflicting reuse of the same run ID.

Verify status sequence `200, 200, 200, 409`, one ledger row, and combined total
`legacy baseline + 1`.

- [ ] **Step 6: Resolve verification failures at their owning task**

If verification found a defect, return to the task that owns that behavior, add a focused
failing test, make the smallest fix, rerun its green command, and use that task's exact staging
list. Use commit message `fix(api): close HPA-371 verification gap`. Do not create a catch-all
verification commit or stage unrelated workspace changes. If no files changed, do not create
an empty commit.

- [ ] **Step 7: Record the deploy gate**

HPA-371 is ready to merge/deploy only when:

- all commands above pass;
- migration 0003 is present and additive;
- legacy and v1 requests both pass;
- profile null-best rows render safely;
- Bun and Worker route tests prove the same status mapping.

HPA-372 must not start consuming the v1 endpoint until this gate is deployed.
