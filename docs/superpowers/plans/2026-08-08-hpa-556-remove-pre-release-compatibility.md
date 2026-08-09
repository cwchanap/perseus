# HPA-556 Remove Pre-Release Gameplay Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete pre-release gameplay persistence and completion compatibility so Perseus supports only the current browser session, local-stat, and completion request contracts.

**Architecture:** Keep the existing `PuzzleSession`, storage adapter, local-stat service, Worker route, repository, and completion-ledger boundaries. Invalid local data is deleted and treated as missing; the API accepts one versioned request; Timed vs Relaxed directly defines elapsed-time semantics. This is a deletion/refactor ticket, not a component extraction or migration-framework ticket.

**Tech Stack:** TypeScript, Svelte 5/SvelteKit, Vitest, Hono/Cloudflare Workers, Drizzle ORM, Cloudflare D1, Bun SQLite, Playwright, Bun/Turborepo.

## Global Constraints

- Keep `RecordPuzzleCompletionV1.version = 1`.
- Keep `CURRENT_SESSION_SCHEMA_VERSION = 1`; do not create a new browser session schema version for this cleanup.
- Missing, malformed, stale, or unsupported local session/stat data is disposable and resets to fresh current state.
- Remove compatibility readers/writers rather than replacing them with migration registries, fallback readers, or adapters.
- Remove `TimingQuality` instead of preserving a one-value type or field.
- Keep the physical D1 `timing_quality` column temporarily as an internal storage detail written with literal `known`; do not create a D1 migration solely to drop it.
- Preserve `PuzzleSession` as the gameplay state owner.
- Do not include HPA-557 route component extraction or HPA-218/HPA-224 feature work.
- Historical `docs/superpowers/` plans/specs are provenance and do not need rewriting.

---

### Task 1: Make browser session persistence current-only

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `CURRENT_SESSION_SCHEMA_VERSION`, `SessionValidationContext`, `PersistedPuzzleSessionV1`.
- Produces: current-v1 load or missing; invalid stored data is best-effort removed by the storage adapter.

- [ ] **Step 1: Replace migration/preservation tests with reset tests**

Delete persistence tests for `canonicalJson`, `sha256Hex`, `legacyRunId`, deterministic legacy tray order, v0 migration, and future-schema preservation. Add:

```ts
it('clears unversioned stored state and reports missing', () => {
  const storage = memoryStorage();
  storage.setItem(
    'puzzle-progress-pz1',
    JSON.stringify({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 10 })
  );
  const adapter = createSessionStorageAdapter({ storage });

  expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
  expect(storage.getItem('puzzle-progress-pz1')).toBeNull();
});

it('clears a different schema version and reports missing', () => {
  const storage = memoryStorage();
  storage.setItem('puzzle-progress-pz1', JSON.stringify({ schemaVersion: 2, puzzleId: 'pz1' }));
  const adapter = createSessionStorageAdapter({ storage });

  expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
  expect(storage.getItem('puzzle-progress-pz1')).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and confirm it fails before implementation**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts
```

Expected: FAIL because unversioned data still migrates and future schemas are preserved.

- [ ] **Step 3: Delete compatibility codec code and make invalid data destructive**

In `persistence.ts`, remove Noble hash imports, canonical JSON/hash helpers, legacy run-ID generation, deterministic legacy tray helpers, `migrateV0toV1`, and legacy timestamp parsing. Only the current schema reaches `validateV1`:

```ts
const record = parsed as Record<string, unknown>;
if (record.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) {
  return { status: 'invalid', reason: 'unsupported_schema_version' };
}
const snapshot = validateV1(record, context);
return snapshot
  ? { status: 'loaded', snapshot }
  : { status: 'invalid', reason: 'cross_field_violation' };
```

Make the storage adapter consume `invalid` as destructive recovery:

```ts
const result = loadPersistedSession(raw, context);
if (result.status !== 'invalid') return result;
try {
  storage.removeItem(progressKey(puzzleId));
} catch (cause) {
  onError?.({ kind: 'remove_error', puzzleId, cause });
}
return { status: 'missing' };
```

Remove `migrated` and `incompatible` from `SessionLoadResult`.

- [ ] **Step 4: Remove route read-only persistence mode**

Delete `persistenceReadOnly` and all checkpoint suppression/reset branches. Restore only loaded state:

```ts
const restored = loadResult.status === 'loaded' ? loadResult.snapshot : undefined;
```

Update route tests so stale persistence produces a fresh playable session instead of a read-only compatibility session.

- [ ] **Step 5: Remove the now-unused web hash dependency**

Delete `@noble/hashes` from `apps/web/package.json`, then regenerate the lockfile:

```bash
cd ../../..
bun install
```

- [ ] **Step 6: Verify and commit**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts src/routes/puzzle/[id]/page.svelte.test.ts
bun run check
cd ../..
git add apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/persistence.ts apps/web/src/lib/services/gameplay/session/persistence.test.ts 'apps/web/src/routes/puzzle/[id]/+page.svelte' 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts' apps/web/package.json bun.lock
git commit -m "refactor: make session persistence current-only"
```

---

### Task 2: Make local statistics current-only

**Files:**
- Modify: `apps/web/src/lib/services/stats.ts`
- Modify: `apps/web/src/lib/services/__tests__/stats.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `PuzzleStatsV1`, `SealedCompletion`, current Web Locks write path.
- Produces: stale stats reset; the only local write failure is retryable `storage_error`.

- [ ] **Step 1: Replace stats compatibility assertions with reset assertions**

Delete legacy stats migration, future-schema preservation, `saveCompletionTime`, and missing-`recordedRunIds` compatibility tests. Add:

```ts
it('deletes an unversioned stats record', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(
    key,
    JSON.stringify({ puzzleId, bestTime: 90, completedAt: '2024-01-01T00:00:00.000Z', totalCompletions: 2 })
  );

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

it('deletes a higher-schema stats record', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, puzzleId, future: true }));

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts
```

Expected: FAIL while legacy/future records are still migrated or preserved.

- [ ] **Step 3: Collapse stats parsing and failure states**

Delete `parseLegacyRecord`, incompatible-schema parsing, `saveCompletionTime`, and `recordedRunIds` fallback seeding. Current parsing becomes:

```ts
function parseStoredStats(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
  if (raw.schemaVersion !== CURRENT_STATS_SCHEMA_VERSION) return null;
  return validateV1(raw, puzzleId);
}
```

Best-effort delete invalid records before treating them as empty. Keep the current run-ID dedup ring and Web Locks behavior.

- [ ] **Step 4: Remove `incompatible_schema` from completion effects**

Delete that code from `CompletionFailureCode`, persistence effect validation, and route acknowledgement. Local failure acknowledgement becomes:

```ts
result:
  result.status === 'failed'
    ? { status: 'failed', code: 'storage_error', retryable: true }
    : { status: 'succeeded' }
```

- [ ] **Step 5: Verify and commit**

```bash
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts src/lib/services/gameplay/session/persistence.validation-completion.test.ts src/routes/puzzle/[id]/page.svelte.test.ts
bun run check
cd ../..
git add apps/web/src/lib/services/stats.ts apps/web/src/lib/services/__tests__/stats.test.ts apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/persistence.ts apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts 'apps/web/src/routes/puzzle/[id]/+page.svelte' 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: reset stale local statistics"
```

---

### Task 3: Remove the legacy server completion path

**Files:**
- Modify: `apps/api/src/routes/puzzles.complete.shared.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`
- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`

**Interfaces:**
- Consumes: current `RecordPuzzleCompletionV1`, `recordVersionedCompletion`, `CompletionWriteExecutor.write`.
- Produces: one request parser and one completion write path; no `writeLegacy` API.

- [ ] **Step 1: Make the Worker test reject `{ timeSeconds }`**

Delete legacy success/tombstone mocks and add:

```ts
it('rejects the removed legacy timeSeconds body', async () => {
  const res = await buildApp().request(
    `/api/puzzles/${PUZZLE_ID}/complete`,
    { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ timeSeconds: 90 }) },
    DUMMY_ENV
  );

  expect(res.status).toBe(400);
  expect(recordVersionedCompletion).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the Worker test and confirm it fails**

```bash
cd apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
```

Expected: FAIL because the legacy body is still accepted.

- [ ] **Step 3: Collapse parser and route to the versioned request**

`parseCompletionRequest` should return only a validated `RecordPuzzleCompletionV1`:

```ts
export function parseCompletionRequest(value: unknown): CompletionRequestParseResult {
  if (!isRecordPuzzleCompletionV1(value, MAX_COMPLETION_TIME_SECONDS)) {
    return badRequest('Invalid completion request');
  }
  return { ok: true, value };
}
```

The Worker route calls only:

```ts
const result = await recordVersionedCompletion(
  completionWrites,
  session.user.id,
  puzzleId,
  parsed.value
);
```

- [ ] **Step 4: Delete legacy repository/executor/driver code**

Remove `LegacyCompletionWrite`, `LegacyCompletionWriteExecution`, `CompletionWriteExecutor.writeLegacy`, `recordLegacyCompletion`, both driver `writeLegacy` implementations, and the 30-second legacy dedupe constant. Keep current ledger idempotency, tombstones, quota, and best-time writes unchanged.

- [ ] **Step 5: Update shared tests and verify**

At this stage `timingQuality` still exists in the current write contract; leave it until Task 4. Remove only legacy mocks/assertions.

```bash
cd ../../packages/shared
bun --bun vitest run src/__tests__/repositories.test.ts src/__tests__/repositories.d1.test.ts src/__tests__/drivers.test.ts
bun run check
cd ../../apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add apps/api/src/routes/puzzles.complete.shared.ts apps/api/src/routes/puzzles.complete.worker.ts apps/api/src/routes/puzzles.complete.worker.test.ts packages/shared/src/completion-writes.ts packages/shared/src/repositories.ts packages/shared/src/drivers/d1.ts packages/shared/src/drivers/bun.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts packages/shared/src/__tests__/drivers.test.ts
git commit -m "refactor: remove legacy completion writes"
```

---

### Task 4: Remove `TimingQuality` and legacy run IDs end-to-end

**Files:**
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.test.ts`
- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`
- Modify: `packages/shared/src/__tests__/schema.test.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/stats.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts`
- Modify: `apps/web/src/lib/services/__tests__/stats.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `SessionMode`, `ResultClass`, current completion ledger.
- Produces: four-field `RecordPuzzleCompletionV1`; no timing-quality field in runtime/session/API contracts; UUID-v4-only run IDs.

- [ ] **Step 1: Change shared request tests first**

```ts
const timed = {
  version: 1,
  runId: '223e4567-e89b-42d3-a456-426614174000',
  resultClass: 'standard_timed',
  elapsedActiveSeconds: 90
};
const relaxed = {
  version: 1,
  runId: '223e4567-e89b-42d3-a456-426614174000',
  resultClass: 'relaxed',
  elapsedActiveSeconds: null
};

expect(isRecordPuzzleCompletionV1(timed, MAX_COMPLETION_TIME_SECONDS)).toBe(true);
expect(isRecordPuzzleCompletionV1(relaxed, MAX_COMPLETION_TIME_SECONDS)).toBe(true);
expect(isRecordPuzzleCompletionV1({ ...timed, timingQuality: 'known' }, MAX_COMPLETION_TIME_SECONDS)).toBe(false);
expect(isPuzzleRunId(`legacy-${'a'.repeat(64)}`)).toBe(false);
```

Run:

```bash
cd packages/types
bunx vitest run src/index.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Remove the concept from `@perseus/types`**

Delete `TIMING_QUALITIES`/`TimingQuality`, remove the field from `RecordPuzzleCompletionV1`, make `isPuzzleRunId` UUID-v4-only, and validate elapsed time directly from `resultClass`:

```ts
if (completion.resultClass === 'relaxed') {
  return completion.elapsedActiveSeconds === null;
}
return (
  typeof completion.elapsedActiveSeconds === 'number' &&
  Number.isInteger(completion.elapsedActiveSeconds) &&
  completion.elapsedActiveSeconds > 0 &&
  completion.elapsedActiveSeconds <= maxElapsedActiveSeconds
);
```

- [ ] **Step 3: Remove timing quality from session/seal/persistence/stats**

Delete `timingQuality` from `PuzzleSessionState`, `PersistedPuzzleSessionV1`, `SealedCompletion`, clone/hydration/serialization/validation, and completion projection. Clock gating becomes mode-only:

```ts
if (state.mode !== 'timed' || clockRunning) return;
```

Completion timing becomes:

```ts
function sealElapsed(): number | null {
  if (state.mode === 'relaxed') return null;
  return Math.max(1, state.elapsedActiveSeconds ?? 0);
}
```

Standard-best eligibility becomes:

```ts
return seal.resultClass === 'standard_timed' && seal.elapsedActiveSeconds !== null;
```

Delete all `legacy_unknown` test cases.

- [ ] **Step 4: Remove timing quality from public shared write contracts**

Delete it from `VersionedCompletionWrite`, `StoredCompletionFacts`, repository projection, fact matching, and canonical-best logic. Canonical best becomes:

```ts
export function isCanonicalBest(input: VersionedCompletionWrite): boolean {
  return input.resultClass === 'standard_timed' && input.elapsedActiveSeconds !== null;
}
```

Keep the existing physical database column internal in both drivers:

```ts
const CURRENT_TIMING_QUALITY = 'known' as const;
```

Use that literal for inserts, but do not return it in stored facts. Narrow the logical `schema.ts` check to `known`; do not generate a migration.

- [ ] **Step 5: Simplify route presentation and current API tests**

Replace known/unknown timing presentation with mode-only state:

```ts
const showTimedPresentation = $derived(sessionState?.mode === 'timed');
const showRelaxedPresentation = $derived(sessionState?.mode === 'relaxed');
```

Delete `showUnknownTimePresentation` and `TIME UNAVAILABLE`. Update Worker tests to four-field current requests and keep one malformed case showing `timingQuality: 'known'` is rejected as an extra field.

- [ ] **Step 6: Run all affected package gates**

```bash
cd packages/types
bun run test:unit
cd ../shared
bun --bun vitest run src/__tests__/repositories.test.ts src/__tests__/repositories.d1.test.ts src/__tests__/drivers.test.ts src/__tests__/schema.test.ts
bun run check
cd ../../apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
bun run check
cd ../web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts src/lib/services/gameplay/session/persistence.test.ts src/lib/services/gameplay/session/persistence.validation-fields.test.ts src/lib/services/gameplay/session/persistence.validation-completion.test.ts src/lib/services/__tests__/stats.test.ts src/routes/puzzle/[id]/page.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ../..
git add packages/types/src/core.ts packages/types/src/index.test.ts packages/shared/src/completion-writes.ts packages/shared/src/repositories.ts packages/shared/src/drivers/d1.ts packages/shared/src/drivers/bun.ts packages/shared/src/schema.ts packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts packages/shared/src/__tests__/drivers.test.ts packages/shared/src/__tests__/schema.test.ts apps/api/src/routes/puzzles.complete.worker.test.ts apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/session.ts apps/web/src/lib/services/gameplay/session/persistence.ts apps/web/src/lib/services/stats.ts 'apps/web/src/routes/puzzle/[id]/+page.svelte' apps/web/src/lib/services/gameplay/session/session.test.ts apps/web/src/lib/services/gameplay/session/persistence.test.ts apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts apps/web/src/lib/services/__tests__/stats.test.ts 'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: remove legacy timing quality"
```

---

### Task 5: Delete compatibility-only integration fixtures and assertions

**Files:**
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Modify: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`

**Interfaces:**
- Consumes: current persisted session and four-field completion request.
- Produces: E2E suite covers current restore/reset behavior only.

- [ ] **Step 1: Remove timing quality and compatibility fixture modes**

A current timed persisted fixture contains `schemaVersion`, identity, lifecycle, mode, UUID run ID, elapsed seconds, timer state, placements/tray/rotations/counters/facts, result class, effect seal when present, and timestamp — but no `timingQuality`.

- [ ] **Step 2: Replace compatibility E2E coverage with one reset case**

Use the existing localStorage fixture mechanism to inject stale JSON, load the puzzle route, start/interact with the fresh run, and verify stale data is gone or replaced by schema 1 current data:

```ts
const stored = await page.evaluate(
  (key) => localStorage.getItem(key),
  `puzzle-progress-${puzzleId}`
);
expect(stored === null || JSON.parse(stored).schemaVersion === 1).toBe(true);
```

Do not add separate cases for every obsolete pre-release shape.

- [ ] **Step 3: Run focused integration tests**

```bash
cd apps/web
bun run build:e2e
bunx playwright test e2e/gameplay-infrastructure.spec.ts e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 4: Scan active code/tests for compatibility residue**

From repository root:

```bash
cd ../..
rg -n "legacyRunId|legacy_unknown|writeLegacy|recordLegacyCompletion|saveCompletionTime|persistenceReadOnly|incompatible_schema|canonicalJson|sha256Hex" apps packages
rg -n "timeSeconds" apps/api/src/routes/puzzles.complete.shared.ts apps/api/src/routes/puzzles.complete.worker.ts packages/shared/src
```

Expected: no hits. Historical `docs/superpowers/` are intentionally outside this scan.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/gameplay-fixtures/persisted-state.ts apps/web/e2e/gameplay-infrastructure.spec.ts apps/web/e2e/gameplay-session-controls.spec.ts apps/web/e2e/gameplay-fixtures/harness-services.spec.ts
git commit -m "test: drop gameplay compatibility fixtures"
```

---

### Task 6: Run repository-wide quality gates and scope review

**Files:**
- No planned source changes. If a gate fails because Tasks 1–5 are incomplete, return to the task that owns the failing file and fix it there before completing Task 6.

**Interfaces:**
- Consumes: all HPA-556 changes.
- Produces: clean, mergeable current-only implementation with no unrelated feature work.

- [ ] **Step 1: Run type/lint gates**

```bash
bun run check
bun run lint
```

Expected: PASS.

- [ ] **Step 2: Run all unit tests**

```bash
bun run test:unit
```

Expected: PASS.

- [ ] **Step 3: Run gameplay smoke E2E**

```bash
cd apps/web
bun run test:e2e:smoke
cd ../..
```

Expected: PASS on configured Chromium desktop/mobile projects.

- [ ] **Step 4: Review final scope**

```bash
git diff main...HEAD --stat
git diff --check main...HEAD
rg -n "legacyRunId|legacy_unknown|writeLegacy|recordLegacyCompletion|saveCompletionTime|persistenceReadOnly|incompatible_schema|canonicalJson|sha256Hex" apps packages
git status --short
```

Expected:

- compatibility residue scan prints nothing;
- `git diff --check` prints nothing;
- working tree is clean;
- diff contains deletion/simplification and focused tests only;
- no migration registry, fallback reader, new state owner, HPA-557 component split, or D1 migration whose only purpose is dropping `timing_quality`.

Do not create an empty final commit.

---

## Completion checklist

- browser runtime has no v0 migration, legacy hash/run-ID path, future-schema preservation, or read-only persistence mode;
- local stats support only the current shape and stale records are deleted;
- `TimingQuality` / `legacy_unknown` are absent from active runtime/tests;
- `RecordPuzzleCompletionV1.version` and `CURRENT_SESSION_SCHEMA_VERSION` remain `1`;
- completion endpoint rejects `{ timeSeconds }` and requests carrying removed fields;
- shared completion executor has no `writeLegacy` path;
- Timed, Relaxed, local puzzle, authenticated API completion, replay/conflict/quota, and retry behavior remain covered;
- no data migration or compatibility framework was added;
- HPA-557 component extraction remains separate work.
