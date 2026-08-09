# HPA-556 Remove Pre-Release Gameplay Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete pre-release gameplay persistence and completion compatibility so Perseus supports only the current browser session, local-stat, and completion request contracts.

**Architecture:** Keep the existing `PuzzleSession`, storage adapter, local-stat service, Worker route, repository, and completion-ledger boundaries. Invalid local data is deleted and treated as missing; the completion API accepts one exact-key versioned request; Timed vs Relaxed directly defines elapsed-time semantics. The physical D1 `timing_quality` column/CHECK remains untouched as storage-only history; application drivers write `known` without exposing a timing-quality domain type.

**Tech Stack:** TypeScript, Svelte 5/SvelteKit, Vitest, Hono/Cloudflare Workers, Drizzle ORM, Cloudflare D1, Bun SQLite, Playwright, Bun/Turborepo.

## Global Constraints

- Keep `RecordPuzzleCompletionV1.version = 1`.
- Keep `CURRENT_SESSION_SCHEMA_VERSION = 1`; do not create a new browser session schema version for this cleanup.
- Completion API validation remains exact-key.
- Current schema-1 session hydration remains field-permissive: ignore obsolete/unknown extra keys, including leftover `timingQuality: 'known'`, while validating all current invariants.
- Missing, malformed, different-schema, or invariant-invalid local session/stat data is disposable and resets to fresh current state.
- Remove compatibility readers/writers rather than replacing them with migration registries, fallback readers, adapters, controllers, or stores.
- Remove `TimingQuality` from domain/API/session contracts instead of preserving a one-value type.
- Keep the physical D1 `timing_quality` column and its historical CHECK unchanged; D1/Bun drivers write storage-only `known`.
- Do **not** run `drizzle-kit generate`; do not add or modify any file under `packages/shared/drizzle/`.
- Preserve `PuzzleSession` as the gameplay state owner.
- Do not include HPA-557 route component extraction or HPA-218/HPA-224 feature work.
- Historical `docs/superpowers/` plans/specs are provenance and do not need rewriting.

---

### Task 1: Make browser session loading current-only

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Test: `apps/web/src/lib/services/gameplay/session/persistence*.test.ts`
- Test: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Test: `apps/web/e2e/support/test-fixture.spec.ts`

**Interfaces:**
- Consumes: `CURRENT_SESSION_SCHEMA_VERSION`, `SessionValidationContext`, `PersistedPuzzleSessionV1`.
- Produces: `SessionLoadResult = { status: 'missing' } | { status: 'loaded'; snapshot: PersistedPuzzleSessionV1 } | { status: 'invalid'; reason: string }`; the storage adapter converts `invalid` into destructive cleanup + `missing`.

- [ ] **Step 1: Replace migration/preservation tests with reset tests**

Delete persistence tests for `canonicalJson`, `sha256Hex`, `legacyRunId`, `fnv1aUtf8`, `mulberry32`, `deterministicLegacyTrayOrder`, v0 migration, and future-schema preservation. Add adapter-level tests:

```ts
it('clears unversioned stored state and reports missing', () => {
  const storage = memoryStorage();
  storage.setItem(
    'puzzle-progress-pz1',
    JSON.stringify({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 10 })
  );
  const adapter = createSessionStorageAdapter({ storage });

  expect(adapter.loadSession('pz1', context)).toEqual({ status: 'missing' });
  expect(storage.getItem('puzzle-progress-pz1')).toBeNull();
});

it('clears a different schema version and reports missing', () => {
  const storage = memoryStorage();
  storage.setItem('puzzle-progress-pz1', JSON.stringify({ schemaVersion: 2, puzzleId: 'pz1' }));
  const adapter = createSessionStorageAdapter({ storage });

  expect(adapter.loadSession('pz1', context)).toEqual({ status: 'missing' });
  expect(storage.getItem('puzzle-progress-pz1')).toBeNull();
});
```

Keep current-v1 invariant/round-trip tests; `timingQuality` is removed from those fixtures in Task 4.

- [ ] **Step 2: Run the full persistence test group and confirm the new assertions fail**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence*.test.ts
```

Expected: FAIL because unversioned data still migrates and higher schemas are still preserved.

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

Make the adapter consume invalid data as recovery:

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

- [ ] **Step 4: Remove route and E2E-helper branches for removed load results**

In `+page.svelte`, delete `persistenceReadOnly` and all checkpoint suppression/reset branches. Restore only loaded state:

```ts
const restored = loadResult.status === 'loaded' ? loadResult.snapshot : undefined;
```

In both `e2e/gameplay-fixtures/persisted-state.ts` and `e2e/support/gameplay-page.ts`, `seedValid`/`validateSeed` accept only `loaded`:

```ts
const result = loadPersistedSession(json, context);
if (result.status !== 'loaded') {
  const reason = result.status === 'invalid' ? `invalid (${result.reason})` : result.status;
  throw new Error(`snapshot failed production validation: ${reason}`);
}
```

Update route tests so a stale/different-schema stored value is cleared and a fresh playable session is created.

- [ ] **Step 5: Remove the now-unused web hash dependency**

Delete `@noble/hashes` from `apps/web/package.json`, then regenerate the lockfile:

```bash
cd ../..
bun install
```

Do not hand-edit `bun.lock`.

- [ ] **Step 6: Verify unit + E2E support compilation**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence*.test.ts 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
bunx playwright test --list --project=chromium-desktop
```

Expected: all persistence tests pass; Svelte/TypeScript check passes; Playwright can enumerate the suite with the narrowed load-result union.

- [ ] **Step 7: Commit**

```bash
cd ../..
git add apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts' \
  apps/web/e2e/gameplay-fixtures/persisted-state.ts \
  apps/web/e2e/support/gameplay-page.ts \
  apps/web/package.json bun.lock
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
- Produces: stale stats reset; the only local write failure reason is retryable `storage_error`.

- [ ] **Step 1: Replace stats compatibility assertions with destructive-reset assertions**

Delete legacy stats migration, future-schema preservation, `saveCompletionTime`, and missing-`recordedRunIds` fallback tests. Add:

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

- [ ] **Step 2: Run the focused stats test and confirm failure**

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

Best-effort delete invalid records before treating them as empty. Keep current run-ID dedup and Web Locks behavior.

- [ ] **Step 4: Remove `incompatible_schema` from completion effects**

Delete that code from `CompletionFailureCode`, `isFailureRetryable`, persistence effect validation, and route acknowledgement. Local failure acknowledgement becomes:

```ts
result:
  result.status === 'failed'
    ? { status: 'failed', code: 'storage_error', retryable: true }
    : { status: 'succeeded' }
```

- [ ] **Step 5: Verify and commit**

```bash
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts \
  src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
cd ../..
git add apps/web/src/lib/services/stats.ts \
  apps/web/src/lib/services/__tests__/stats.test.ts \
  apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: reset stale local statistics"
```

---

### Task 3: Remove the legacy completion request/write path, including the web client shim

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
- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`

**Interfaces:**
- Consumes: current `RecordPuzzleCompletionV1`, `recordVersionedCompletion`, `CompletionWriteExecutor.write`.
- Produces: one request parser, one server write path, and one web client method (`recordCompletion`); no `writeLegacy` or `recordCompletionLegacy` API remains.

- [ ] **Step 1: Make the Worker route test reject `{ timeSeconds }`**

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

- [ ] **Step 2: Run the Worker test and confirm failure**

```bash
cd apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
```

Expected: FAIL because the legacy body is still accepted.

- [ ] **Step 3: Collapse parser and route to the current request**

`parseCompletionRequest` returns only `RecordPuzzleCompletionV1`:

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

- [ ] **Step 5: Delete the web legacy POST shim at the same boundary**

Remove from `apps/web/src/lib/services/api.ts`:

```ts
export async function recordCompletionLegacy(puzzleId: string, timeSeconds: number): Promise<void> {
  return postCompletion(puzzleId, { timeSeconds });
}
```

Delete its tests. Keep/adjust the current `recordCompletion` test so it asserts the versioned request body exactly.

- [ ] **Step 6: Verify API/shared/web client and commit**

At this stage the current request still has `timingQuality`; Task 4 removes it atomically.

```bash
cd ../../packages/shared
bun --bun vitest run src/__tests__/repositories.test.ts src/__tests__/repositories.d1.test.ts src/__tests__/drivers.test.ts
bun run check
cd ../../apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
bun run check
cd ../web
bunx vitest --run --browser src/lib/services/__tests__/api.test.ts
bun run check
cd ../..
git add apps/api/src/routes/puzzles.complete.shared.ts \
  apps/api/src/routes/puzzles.complete.worker.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts \
  packages/shared/src/completion-writes.ts \
  packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts \
  packages/shared/src/drivers/bun.ts \
  packages/shared/src/__tests__/repositories.test.ts \
  packages/shared/src/__tests__/repositories.d1.test.ts \
  packages/shared/src/__tests__/drivers.test.ts \
  apps/web/src/lib/services/api.ts \
  apps/web/src/lib/services/__tests__/api.test.ts
git commit -m "refactor: remove legacy completion writes"
```

---

### Task 4: Remove `TimingQuality` and legacy run IDs end-to-end

This is one atomic cross-package commit. Intermediate root builds may be broken while consumers are being updated; use the package-local gates below after each boundary, then commit only after all layers pass.

**Files — shared/public contract:**
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.test.ts`
- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/__tests__/repositories.test.ts`
- Modify: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `packages/shared/src/__tests__/drivers.test.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`

**Files — web session/runtime:**
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/stats.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.edge.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.fallback-storage.test.ts`
- Modify: `apps/web/src/lib/services/__tests__/stats.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Files — E2E contract fixtures/support:**
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Modify: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`
- Test: `apps/web/e2e/support/test-fixture.spec.ts`

**Intentionally unchanged physical storage files:**
- `packages/shared/src/schema.ts`
- `packages/shared/src/__tests__/schema.test.ts`
- `packages/shared/drizzle/**`

**Interfaces:**
- Produces four-field `RecordPuzzleCompletionV1`.
- Produces UUID-v4-only `isPuzzleRunId`.
- `PuzzleSessionState`, `PersistedPuzzleSessionV1`, and `SealedCompletion` have no `timingQuality`.
- Shared completion write/fact interfaces have no `timingQuality`; D1/Bun drivers fill the existing storage column with `'known'` internally.

- [ ] **Step 1: Write shared contract red tests**

Update `packages/types/src/index.test.ts` so the current request shape is:

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
```

Add rejections:

```ts
expect(isRecordPuzzleCompletionV1({ ...timed, timingQuality: 'known' }, 86_400)).toBe(false);
expect(isPuzzleRunId(`legacy-${'a'.repeat(64)}`)).toBe(false);
```

Run:

```bash
cd packages/types
bun run test:unit
```

Expected: FAIL until the contract is changed.

- [ ] **Step 2: Change `@perseus/types` and prove that package independently**

In `core.ts`:

- delete `TIMING_QUALITIES` and `TimingQuality`;
- remove `timingQuality` from `RecordPuzzleCompletionV1`;
- make `isPuzzleRunId` UUID-v4-only;
- make `isRecordPuzzleCompletionV1` exact-key over `version`, `runId`, `resultClass`, `elapsedActiveSeconds`;
- encode timing validity solely from `resultClass`.

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

Run:

```bash
bun run test:unit
```

Expected: PASS for `@perseus/types`.

- [ ] **Step 3: Remove timing quality from shared write interfaces, but not the physical schema**

In `completion-writes.ts` and `repositories.ts`, remove timing quality from `VersionedCompletionWrite` and `StoredCompletionFacts`, `completionFactsMatch`, and canonical-best logic.

In both D1/Bun drivers, keep the existing table column internal:

```ts
timingQuality: 'known'
```

Do not export a new one-value `TimingQuality` type. Do not modify `schema.ts` or `schema.test.ts`; they describe/test the checked-in physical schema created by migrations.

Update shared repository/driver tests to send the new input shape and expect current behavior. Then run:

```bash
cd ../shared
bun run check
bun run test:unit
```

Expected: PASS for `@perseus/shared` while the physical migration/schema remains unchanged.

- [ ] **Step 4: Remove timing quality from API and web domain/runtime**

Update the Worker request tests and web API test to the four-field request.

In web session code:

- remove the field from `PuzzleSessionState`, `PersistedPuzzleSessionV1`, `SealedCompletion`, serialization, hydration, and `completionRequestFromSeal`;
- change clock gates from `mode === 'timed' && timingQuality === 'known'` to `mode === 'timed'`;
- make sealing return `null` only for Relaxed mode;
- remove timing-quality checks from local best eligibility;
- delete `showUnknownTimePresentation` and `TIME UNAVAILABLE`; presentation is Timed vs Relaxed only.

Representative engine simplification:

```ts
function sealElapsed(): number | null {
  if (state.mode === 'relaxed') return null;
  return Math.max(1, state.elapsedActiveSeconds ?? 0);
}
```

- [ ] **Step 5: Protect current schema-1 hydration from accidental exact-key validation**

Add a persistence regression test using a raw object so TypeScript does not hide the obsolete field:

```ts
it('ignores obsolete timingQuality on current schema-1 hydration', () => {
  const raw = { ...validSnapshot(), timingQuality: 'known' } as Record<string, unknown>;
  const result = loadPersistedSession(JSON.stringify(raw), context);

  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') throw new Error('expected loaded snapshot');
  expect(result.snapshot).not.toHaveProperty('timingQuality');
  expect(JSON.parse(JSON.stringify(result.snapshot))).not.toHaveProperty('timingQuality');
});
```

Do **not** add an exact-key check to session `validateV1`. Unknown extra keys remain ignored; missing/wrong current fields and cross-field invariant failures still reset.

- [ ] **Step 6: Update every remaining fixture/caller in the known blast radius**

Remove `timingQuality` from:

- `persistence.test-fixtures.ts` `validSnapshot()` / seal builders;
- `session.edge.test.ts` restored snapshots;
- persistence validation-storage/fallback/fields/completion tests;
- session/stats/route tests;
- deterministic E2E persisted-state builders and gameplay session-control/infrastructure fixtures.

Keep `apps/web/e2e/support/test-fixture.spec.ts` as an integration assertion over `buildMinimalSeed`; it should require no direct timing-quality field once the helper is current-only.

- [ ] **Step 7: Run package and web gates, then smoke E2E immediately**

```bash
cd packages/types
bun run test:unit
cd ../shared
bun run check
bun run test:unit
cd ../../apps/api
bun run check
bunx vitest run src/routes/puzzles.complete.worker.test.ts
cd ../web
bun run check
bunx vitest --run --browser src/lib/services/__tests__/api.test.ts \
  src/lib/services/__tests__/stats.test.ts \
  src/lib/services/gameplay/session/session*.test.ts \
  src/lib/services/gameplay/session/persistence*.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run test:e2e:smoke
```

Expected: current Timed and Relaxed browser flows, local completion, and current authenticated completion fixtures remain green after the four-field contract cut.

- [ ] **Step 8: Commit the atomic cut**

```bash
cd ../..
git add packages/types/src/core.ts packages/types/src/index.test.ts \
  packages/shared/src/completion-writes.ts packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts packages/shared/src/drivers/bun.ts \
  packages/shared/src/__tests__/repositories.test.ts \
  packages/shared/src/__tests__/repositories.d1.test.ts \
  packages/shared/src/__tests__/drivers.test.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts \
  apps/web/src/lib/services/__tests__/api.test.ts \
  apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/session.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts \
  apps/web/src/lib/services/gameplay/session/session.test.ts \
  apps/web/src/lib/services/gameplay/session/session.edge.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.fallback-storage.test.ts \
  apps/web/src/lib/services/stats.ts apps/web/src/lib/services/__tests__/stats.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts' \
  apps/web/e2e/gameplay-fixtures/persisted-state.ts \
  apps/web/e2e/gameplay-infrastructure.spec.ts \
  apps/web/e2e/gameplay-session-controls.spec.ts \
  apps/web/e2e/gameplay-fixtures/harness-services.spec.ts
git commit -m "refactor: remove timing-quality compatibility"
```

---

### Task 5: Clean active compatibility wording and prove residue is intentional

**Files:**
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Test: `apps/web/e2e/support/test-fixture.spec.ts`
- Verify unchanged: `packages/shared/src/schema.ts`
- Verify unchanged: `packages/shared/src/__tests__/schema.test.ts`
- Verify unchanged: `packages/shared/drizzle/**`

**Interfaces:**
- Consumes: current-only session/completion contracts from Tasks 1–4.
- Produces: no compatibility shims outside the explicitly retained physical D1 storage representation.

- [ ] **Step 1: Update E2E fixture comments to current-only terminology**

In `persisted-state.ts`, change comments that describe raw seeding as “migration/corruption” to “stale-schema/corruption”. Keep `seedRaw`; it remains useful for proving invalid data resets.

- [ ] **Step 2: Run the full active-code compatibility residue scan**

Run from repository root:

```bash
rg -n \
  'recordCompletionLegacy|TimingQuality|TIMING_QUALITIES|legacyRunId|writeLegacy|recordLegacyCompletion|saveCompletionTime|persistenceReadOnly|incompatible_schema|canonicalJson|sha256Hex|fnv1aUtf8|mulberry32|deterministicLegacyTrayOrder|showUnknownTimePresentation|TIME UNAVAILABLE' \
  apps packages \
  --glob '!packages/shared/drizzle/**' \
  --glob '!packages/shared/src/schema.ts' \
  --glob '!packages/shared/src/__tests__/schema.test.ts'
```

Expected: no output.

Check the old completion-body field only at the former completion surfaces:

```bash
rg -n '\btimeSeconds\b' \
  apps/api/src/routes/puzzles.complete.shared.ts \
  apps/api/src/routes/puzzles.complete.worker.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts \
  apps/web/src/lib/services/api.ts \
  apps/web/src/lib/services/__tests__/api.test.ts \
  packages/shared/src/completion-writes.ts \
  packages/shared/src/repositories.ts \
  packages/shared/src/drivers
```

Expected: no output.

- [ ] **Step 3: Assert the only remaining physical timing-quality references are storage-boundary files**

```bash
actual="$(rg -l 'timingQuality|legacy_unknown' apps packages \
  --glob '!packages/shared/drizzle/**' | sort)"
expected="$(printf '%s\n' \
  packages/shared/src/__tests__/schema.test.ts \
  packages/shared/src/drivers/bun.ts \
  packages/shared/src/drivers/d1.ts \
  packages/shared/src/schema.ts | sort)"
test "$actual" = "$expected"
```

Expected: exit 0. Any additional file is an unremoved domain/test compatibility consumer.

- [ ] **Step 4: Assert no database migration was generated**

```bash
git diff --exit-code main...HEAD -- packages/shared/drizzle
```

Expected: exit 0 with no diff.

- [ ] **Step 5: Run the fixture integration test and commit comment cleanup**

```bash
cd apps/web
bun run test:e2e -- e2e/support/test-fixture.spec.ts --project=chromium-desktop --retries=0
cd ../..
git add apps/web/e2e/gameplay-fixtures/persisted-state.ts
git commit -m "test: align gameplay fixtures with current persistence"
```

---

### Task 6: Final repository verification

**Files:**
- No planned source changes. This task is a clean-tree verification gate.

**Interfaces:**
- Consumes: implementation commits from Tasks 1–5.
- Produces: evidence that current-only contracts work across types, shared storage, API, web, and browser smoke without a D1 migration.

- [ ] **Step 1: Run workspace static/build gates**

```bash
bun run check
bun run lint
bun run build
```

Expected: all packages pass.

- [ ] **Step 2: Run workspace unit tests**

```bash
bun run test:unit
```

Expected: all package unit suites pass.

- [ ] **Step 3: Run current gameplay browser smoke again**

```bash
cd apps/web
bun run test:e2e:smoke
cd ../..
```

Expected: smoke suite passes against the Worker backend with current Timed/Relaxed completion contracts.

- [ ] **Step 4: Re-run residue and migration fences**

```bash
rg -n \
  'recordCompletionLegacy|TimingQuality|TIMING_QUALITIES|legacyRunId|writeLegacy|recordLegacyCompletion|saveCompletionTime|persistenceReadOnly|incompatible_schema|canonicalJson|sha256Hex|fnv1aUtf8|mulberry32|deterministicLegacyTrayOrder|showUnknownTimePresentation|TIME UNAVAILABLE' \
  apps packages \
  --glob '!packages/shared/drizzle/**' \
  --glob '!packages/shared/src/schema.ts' \
  --glob '!packages/shared/src/__tests__/schema.test.ts'
git diff --exit-code main...HEAD -- packages/shared/drizzle
git diff --check
```

Expected: residue grep prints nothing; D1 migration diff and whitespace check both exit 0.

- [ ] **Step 5: Require a clean implementation worktree**

```bash
git status --short
```

Expected: no output. Do not create a verification-only commit.

---

## Implementation result

When all six tasks are complete:

- browser session/stat persistence supports one current shape and resets stale data;
- current schema-1 session hydration tolerates obsolete extra keys but never reads or rewrites `timingQuality`;
- the web client and Worker endpoint expose only the current versioned completion request;
- `TimingQuality`, `legacy_unknown`, legacy run IDs, legacy write APIs, future-schema read-only mode, and compatibility-only helpers/tests are gone from application/domain code;
- the D1 physical `timing_quality` column/CHECK remains untouched, with only storage drivers writing `known`;
- `packages/shared/drizzle/**` is unchanged;
- HPA-557 can proceed against a smaller current-only route/domain surface.
