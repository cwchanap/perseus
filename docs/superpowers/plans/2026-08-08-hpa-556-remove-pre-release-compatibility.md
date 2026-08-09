# HPA-556 Remove Pre-Release Gameplay Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete pre-release gameplay persistence and completion compatibility so Perseus supports only the current browser session, local-stat, and completion request contracts.

**Architecture:** Keep the existing `PuzzleSession`, storage adapter, local-stat service, Worker route, repository, and completion-ledger boundaries. Invalid local data is deleted and treated as missing; the completion API accepts one exact-key versioned request; Timed vs Relaxed directly defines elapsed-time semantics. The physical D1 `timing_quality` column/CHECK remains untouched as storage-only history; application drivers write `known` without exposing a timing-quality domain type.

**Tech Stack:** TypeScript, Svelte 5/SvelteKit, Vitest browser tests, Hono/Cloudflare Workers, Drizzle ORM, Cloudflare D1, Bun SQLite, Playwright, Bun/Turborepo.

## Global Constraints

- Keep `RecordPuzzleCompletionV1.version = 1`.
- Keep `CURRENT_SESSION_SCHEMA_VERSION = 1`; do not create a new browser session schema version for this cleanup.
- Completion API validation remains exact-key.
- Current schema-1 session hydration remains field-permissive: ignore obsolete/unknown extra keys, including leftover `timingQuality: 'known'`, while validating all current invariants.
- Missing, malformed, different-schema, or invariant-invalid local session/stat data is disposable and resets to fresh current state.
- Remove compatibility readers/writers rather than replacing them with migration registries, fallback readers, adapters, controllers, or stores.
- Remove `TimingQuality` from domain/API/session contracts instead of preserving a one-value type.
- Keep the physical D1 `timing_quality` column and historical CHECK unchanged; D1/Bun drivers write storage-only `known`.
- Do **not** run `drizzle-kit generate`; do not add or modify any file under `packages/shared/drizzle/`.
- Preserve `PuzzleSession` as the gameplay state owner.
- Do not include HPA-557 route component extraction or HPA-218/HPA-224 feature work.
- Historical `docs/superpowers/` plans/specs are provenance and do not need rewriting.

## Execution Risks

- **Task 4 cross-package blast radius:** the tree is intentionally uncompilable at some uncommitted intermediate points. Keep the final commit atomic, but use package-local and focused browser gates between layers so failures stay attributable.
- **Current schema-1 session reset:** adding exact-key session validation would discard otherwise valid in-flight sessions. Protect the existing permissive behavior with a raw-object regression test.
- **Lockfile drift:** dependency removal must not opportunistically bump unrelated packages. Inspect the `bun.lock` diff before committing Task 1.
- **Accidental D1 migration:** no schema generation is part of HPA-556. The final migration-directory diff must be empty.

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

**Interfaces:**
- Consumes: `CURRENT_SESSION_SCHEMA_VERSION`, `SessionValidationContext`, current `PersistedPuzzleSessionV1`.
- Produces: `SessionLoadResult = { status: 'missing' } | { status: 'loaded'; snapshot: PersistedPuzzleSessionV1 } | { status: 'invalid'; reason: string }`; the storage adapter converts `invalid` into best-effort cleanup plus `missing`.

- [ ] **Step 1: Replace migration/preservation assertions with destructive-reset assertions**

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

Keep current-v1 invariant and round-trip tests. `timingQuality` is removed from current-v1 typed fixtures in Task 4.

- [ ] **Step 2: Run the full persistence test group and confirm the new assertions fail**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence*.test.ts
```

Expected: FAIL because unversioned data still migrates and higher schemas are preserved.

- [ ] **Step 3: Delete session compatibility codec code**

In `persistence.ts` remove:

- `@noble/hashes` imports;
- `sha256Hex`, `canonicalJson`, `canonicalize`, `legacyRunId`;
- `fnv1aUtf8`, `mulberry32`, `deterministicLegacyTrayOrder`;
- `migrateV0toV1`, `parseLegacyLastUpdated`;
- higher-schema `incompatible` handling.

Only schema 1 reaches `validateV1`:

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

Remove `migrated` and `incompatible` from `SessionLoadResult`.

- [ ] **Step 4: Make the storage adapter own destructive recovery**

Keep `loadPersistedSession()` pure. In `createSessionStorageAdapter().loadSession()` convert `invalid` into removal plus `missing`:

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

Do not add a migration or fallback reader.

- [ ] **Step 5: Remove route and E2E-helper branches for deleted load results**

In `+page.svelte`, delete `persistenceReadOnly` and its checkpoint/reset branches. Restore only loaded state:

```ts
const restored = loadResult.status === 'loaded' ? loadResult.snapshot : undefined;
```

In `e2e/gameplay-fixtures/persisted-state.ts` and `e2e/support/gameplay-page.ts`, `seedValid` / `validateSeed` accept only `loaded`:

```ts
const result = loadPersistedSession(json, context);
if (result.status !== 'loaded') {
  const reason = result.status === 'invalid' ? `invalid (${result.reason})` : result.status;
  throw new Error(`snapshot failed production validation: ${reason}`);
}
```

Update route tests so a stale or different-schema persisted value is cleared and a fresh playable session is created.

- [ ] **Step 6: Remove `@noble/hashes` and fence the lockfile diff**

Remove `@noble/hashes` from `apps/web/package.json`, then run from the repository root:

```bash
bun install
git diff -- apps/web/package.json bun.lock
```

Expected: the package manifest removes `@noble/hashes`; `bun.lock` changes are limited to that dependency and entries that become unreachable because of its removal. There must be no unrelated package additions or version bumps.

If unrelated resolution drift appears, do not commit it. Restore `bun.lock`, rerun `bun install` once against the restored lockfile, and re-inspect. If unrelated drift repeats, stop Task 1 and investigate rather than accepting it.

- [ ] **Step 7: Verify Task 1 and commit**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence*.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
bunx playwright test --list --project=chromium-desktop
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

Expected: persistence tests, route tests, web check, and Playwright enumeration pass.

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
- Consumes: `PuzzleStatsV1`, `SealedCompletion`, Web Locks write path.
- Produces: stale/invalid stats reset; the only local write failure reason is retryable `storage_error`.

- [ ] **Step 1: Replace compatibility assertions with complete destructive-reset assertions**

Delete tests for legacy stats migration, future-schema preservation, `saveCompletionTime`, and missing-`recordedRunIds` backfill. Add:

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

it('deletes a JSON primitive instead of reparsing it forever', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(key, '42');

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});
```

Keep the existing malformed-JSON reset assertion as well.

- [ ] **Step 2: Run the focused stats test and confirm failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts
```

Expected: FAIL while legacy/future records are still migrated or preserved and primitive JSON is not deleted.

- [ ] **Step 3: Collapse stats parsing to current valid/invalid behavior**

In `stats.ts`:

- delete `parseLegacyRecord`;
- remove incompatible-schema parsing/preservation;
- require `schemaVersion === CURRENT_STATS_SCHEMA_VERSION`;
- require `recordedRunIds` to be present and internally consistent;
- remove `saveCompletionTime`;
- remove `incompatible_schema` from local failure results;
- route JSON primitives through the same best-effort `removeItem` path used for other invalid records.

Current parser shape:

```ts
function parseStoredStats(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
  if (raw.schemaVersion !== CURRENT_STATS_SCHEMA_VERSION) return null;
  return validateV1(raw, puzzleId);
}
```

Primitive cleanup remains deliberately simple:

```ts
if (!parsed || typeof parsed !== 'object') {
  try {
    localStorage.removeItem(getStorageKey(puzzleId));
  } catch {
    // best-effort cleanup
  }
  return null;
}
```

Keep run-ID dedup and Web Locks behavior unchanged.

- [ ] **Step 4: Remove the terminal incompatible-stats completion branch and stale mocks**

Delete `incompatible_schema` from `CompletionFailureCode`, `isFailureRetryable`, persistence effect validation, and route acknowledgement. Local acknowledgement becomes:

```ts
result:
  result.status === 'failed'
    ? { status: 'failed', code: 'storage_error', retryable: true }
    : { status: 'succeeded' }
```

In `page.svelte.test.ts`, remove the stale `saveCompletionTime` property from the `$lib/services/stats` mock when the shim is deleted.

- [ ] **Step 5: Verify Task 2 and commit**

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

Expected: focused tests and web check pass.

---

### Task 3: Remove the legacy completion request/write path and web client shim

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
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: current `RecordPuzzleCompletionV1`, `recordVersionedCompletion`, `CompletionWriteExecutor.write`.
- Produces: one parser, one server write path, and one web client (`recordCompletion`); no `ParsedCompletionRequest`, legacy result union, `writeLegacy`, `recordLegacyCompletion`, or `recordCompletionLegacy` remains.

- [ ] **Step 1: Make the Worker route reject `{ timeSeconds }`**

Delete legacy success/tombstone test cases and add:

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

- [ ] **Step 3: Collapse parser/result aliases explicitly**

In `puzzles.complete.shared.ts`:

- delete `ParsedCompletionRequest`;
- make `CompletionRequestParseResult.value` a `RecordPuzzleCompletionV1` directly;
- delete `CompletionRouteResult`;
- make `completionResultToResponse(result: VersionedCompletionResult)` accept the current result directly;
- remove the `LegacyCompletionWriteExecution` import.

The parser becomes:

```ts
export type CompletionRequestParseResult =
  | { ok: true; value: RecordPuzzleCompletionV1 }
  | { ok: false; body: RecordPuzzleCompletionResponse; status: 400 };

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

- [ ] **Step 4: Delete the legacy repository/executor/driver path**

Remove:

- `LegacyCompletionWrite`;
- `LegacyCompletionWriteExecution`;
- `CompletionWriteExecutor.writeLegacy`;
- `recordLegacyCompletion`;
- both driver `writeLegacy` implementations;
- the 30-second legacy dedupe constant and legacy-only tests.

Keep versioned ledger idempotency, tombstones, quota, and best-time behavior unchanged.

- [ ] **Step 5: Delete the web legacy POST shim and stale route mock property**

Remove from `apps/web/src/lib/services/api.ts`:

```ts
export async function recordCompletionLegacy(puzzleId: string, timeSeconds: number): Promise<void> {
  return postCompletion(puzzleId, { timeSeconds });
}
```

Delete its API tests. Keep the current `recordCompletion` test and assert its request body exactly.

Also remove `recordCompletionLegacy` from the `$lib/services/api` mock factory in `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`; a dead mock property will not fail the route test but would fail the residue fence later.

- [ ] **Step 6: Verify Task 3 and commit**

At this stage the current request still carries `timingQuality`; Task 4 removes it.

```bash
cd ../../packages/shared
bun --bun vitest run src/__tests__/repositories.test.ts \
  src/__tests__/repositories.d1.test.ts \
  src/__tests__/drivers.test.ts
bun run check

cd ../../apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
bun run check

cd ../web
bunx vitest --run --browser src/lib/services/__tests__/api.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
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
  apps/web/src/lib/services/__tests__/api.test.ts \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor: remove legacy completion writes"
```

Expected: shared, API, and web-client focused gates pass.

---

### Task 4: Remove `TimingQuality` and legacy run IDs end-to-end

**Files:**
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
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/stats.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.edge.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.fallback-storage.test.ts`
- Modify: `apps/web/src/lib/services/__tests__/stats.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/support/test-fixture.spec.ts`
- Modify: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`

**Intentionally unchanged physical storage files:**
- `packages/shared/src/schema.ts`
- `packages/shared/src/__tests__/schema.test.ts`
- `packages/shared/drizzle/**`

**Interfaces:**
- Produces: four-field `RecordPuzzleCompletionV1`; UUID-v4-only run IDs; no timing-quality field in domain/API/session contracts; drivers write storage-only `'known'`.

- [ ] **Step 1: Write the four-field request/UUID tests first**

Update `packages/types/src/index.test.ts` so current requests omit `timingQuality`:

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

Assert:

- both shapes validate;
- a timed request with `null` elapsed fails;
- Relaxed with non-null elapsed fails;
- a request carrying `timingQuality: 'known'` fails exact-key validation;
- `legacy-${'a'.repeat(64)}` fails `isPuzzleRunId`;
- UUID v4 succeeds.

Run:

```bash
cd packages/types
bun run test:unit
```

Expected: FAIL before the four-field validator/UUID change.

- [ ] **Step 2: Cut the public completion request to four fields, but temporarily retain the timing-quality export**

In `packages/types/src/core.ts`:

- remove `timingQuality` from `RecordPuzzleCompletionV1`;
- make `isPuzzleRunId` UUID-v4-only;
- update `isRecordPuzzleCompletionV1` to exactly four keys and derive elapsed rules from `resultClass`;
- **temporarily keep** `TimingQuality` / `TIMING_QUALITIES` exported during the uncommitted Task 4 sequence so current web persistence can still execute its red tests before Step 5.

Run:

```bash
bun run test:unit
```

Expected: PASS for `@perseus/types` request/UUID behavior.

Do not commit this intermediate state.

- [ ] **Step 3: Remove timing quality from the shared completion contract and use storage-only `known`**

In `packages/shared/src/completion-writes.ts` and `repositories.ts`:

- remove timing quality from `VersionedCompletionWrite` and `StoredCompletionFacts`;
- remove it from conflict matching;
- make canonical-best logic depend only on standard-timed + non-null elapsed;
- stop projecting it from `RecordPuzzleCompletionV1`.

In D1/Bun drivers, write the retained physical column directly:

```ts
timingQuality: 'known'
```

Do not change `schema.ts`, `schema.test.ts`, or migrations. Update shared tests to current interface inputs while retaining assertions for the physical storage column only where needed.

Run:

```bash
cd ../../packages/shared
bun run check
bun run test:unit
```

Expected: PASS for `@perseus/shared` against the existing migration-defined CHECK.

- [ ] **Step 4: Prepare web session-side behavioral tests before changing the engine**

Keep the current runtime implementation untouched for this step. Add/adjust tests so they compile against the current session types but assert the post-cut behavior:

```ts
expect(createPuzzleSession(options).getState()).not.toHaveProperty('timingQuality');
```

For serialization/projection, build the currently-required input but assert the output does not carry the field:

```ts
const snapshot = serializeSession(makeState({ timingQuality: 'known' }));
expect(snapshot).not.toHaveProperty('timingQuality');

const request = completionRequestFromSeal(makeSeal({ timingQuality: 'known' }));
expect(request).toEqual({
  version: 1,
  runId: RUN_ID,
  resultClass: 'standard_timed',
  elapsedActiveSeconds: 90
});
```

Add the permissive-hydration regression with a raw object so TypeScript does not hide the obsolete extra field:

```ts
it('ignores obsolete timingQuality on a current schema-1 snapshot', () => {
  const raw = { ...validSnapshot(), timingQuality: 'known' } as Record<string, unknown>;
  const result = loadPersistedSession(JSON.stringify(raw), context);

  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') throw new Error('expected loaded snapshot');
  expect(serializeSession(hydrateForTest(result.snapshot))).not.toHaveProperty('timingQuality');
});
```

Use the existing session/persistence fixture helpers rather than introducing `hydrateForTest` if no such helper exists; the important assertion is load succeeds and the next production serialization omits the obsolete key.

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session*.test.ts \
  src/lib/services/gameplay/session/persistence*.test.ts
```

Expected: FAIL on the new behavioral assertions while the engine/serializer still publishes timing quality. The failure should be behavioral, not an unresolved-import/type failure.

- [ ] **Step 5: Remove timing quality from the web session domain/runtime, then remove the temporary shared type export**

Update session/domain code:

- remove `timingQuality` from `PuzzleSessionState`, `SealedCompletion`, `PersistedPuzzleSessionV1`, cloning, hydration, and `completionRequestFromSeal`;
- remove `TIMING_QUALITY_SET` and all timing-quality validation branches from persistence;
- make timed/Relaxed clock behavior depend only on `mode`;
- make `sealElapsed()` return `null` only for Relaxed and a positive elapsed value for timed modes;
- update local-stats standard-best eligibility to standard-timed + non-null elapsed;
- remove timing quality from session-side typed fixture builders and edge/storage/fallback/completion validation tests;
- keep the raw obsolete-field hydration test from Step 4.

After the last web/session import is removed, delete `TimingQuality` and `TIMING_QUALITIES` from `packages/types/src/core.ts`.

Run the immediate internal gate **before editing route/E2E fixtures**:

```bash
cd ../../packages/types
bun run test:unit

cd ../../apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session*.test.ts \
  src/lib/services/gameplay/session/persistence*.test.ts \
  src/lib/services/__tests__/stats.test.ts
```

Expected: PASS. If this fails, fix the session/domain cut before touching the route or E2E support layer.

- [ ] **Step 6: Update route, API tests, and E2E fixtures/support after the session core is green**

Remove remaining timing-quality references from:

- Worker current request tests;
- web API current request tests;
- route presentation/effects and route tests;
- `buildMinimalSeed()` and other persisted-state fixtures;
- `gameplay-page.ts` seeded-session helpers;
- `test-fixture.spec.ts`, gameplay infrastructure/session-control tests, and harness-service payload assertions.

Delete `showUnknownTimePresentation` and `TIME UNAVAILABLE`; presentation becomes Timed vs Relaxed only.

Run:

```bash
bun run check
bunx playwright test --list --project=chromium-desktop
```

Expected: web/Svelte/TypeScript check passes and the complete E2E suite enumerates with current contract types.

- [ ] **Step 7: Run contract smoke and commit the atomic Task 4 cut**

```bash
bun run test:e2e:smoke
cd ../..

git add packages/types/src/core.ts packages/types/src/index.test.ts \
  packages/shared/src/completion-writes.ts packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts packages/shared/src/drivers/bun.ts \
  packages/shared/src/__tests__/repositories.test.ts \
  packages/shared/src/__tests__/repositories.d1.test.ts \
  packages/shared/src/__tests__/drivers.test.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts \
  apps/web/src/lib/services apps/web/src/routes/puzzle apps/web/e2e
git commit -m "refactor: remove timing quality compatibility"
```

Expected: smoke passes against the Worker/local-D1 backend using the new four-field request and storage-only `known` writes.

---

### Task 5: Prove active compatibility residue is gone without touching physical D1 history

**Files:**
- Verify unchanged: `packages/shared/src/schema.ts`
- Verify unchanged: `packages/shared/src/__tests__/schema.test.ts`
- Verify unchanged: `packages/shared/drizzle/**`
- Verify active runtime/tests under `apps/` and `packages/`.

**Interfaces:**
- Consumes: current-only contracts from Tasks 1–4.
- Produces: explicit evidence that compatibility names are gone except intentional physical-storage history.

- [ ] **Step 1: Remove stale active comments/fixture wording**

Delete or rewrite active comments that still claim migration/future-schema/legacy completion support. Do not rewrite historical `docs/superpowers/` provenance.

- [ ] **Step 2: Run the broad active-code residue scan**

```bash
rg -n \
  'recordCompletionLegacy|TimingQuality|TIMING_QUALITIES|legacyRunId|writeLegacy|recordLegacyCompletion|saveCompletionTime|persistenceReadOnly|incompatible_schema|canonicalJson|sha256Hex|fnv1aUtf8|mulberry32|deterministicLegacyTrayOrder|showUnknownTimePresentation|TIME UNAVAILABLE' \
  apps packages \
  --glob '!packages/shared/drizzle/**' \
  --glob '!packages/shared/src/schema.ts' \
  --glob '!packages/shared/src/__tests__/schema.test.ts'
```

Expected: no output.

- [ ] **Step 3: Prove `timingQuality` exists only at the intentional physical-storage boundary**

```bash
actual="$(rg -l 'timingQuality|legacy_unknown' packages/shared/src apps packages/types/src \
  --glob '!docs/**' | sort -u)"
expected="$(printf '%s\n' \
  packages/shared/src/__tests__/schema.test.ts \
  packages/shared/src/drivers/bun.ts \
  packages/shared/src/drivers/d1.ts \
  packages/shared/src/schema.ts | sort)"
test "$actual" = "$expected"
```

Expected: exit 0. Any additional file is an unremoved application/test compatibility consumer.

- [ ] **Step 4: Assert no database migration was generated**

```bash
git diff --exit-code main...HEAD -- packages/shared/drizzle
```

Expected: exit 0.

- [ ] **Step 5: Verify the old completion body cannot survive in current client/server paths**

```bash
rg -n 'timeSeconds' \
  apps/api/src/routes/puzzles.complete.shared.ts \
  apps/api/src/routes/puzzles.complete.worker.ts \
  apps/web/src/lib/services/api.ts \
  packages/shared/src/completion-writes.ts \
  packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts \
  packages/shared/src/drivers/bun.ts
```

Expected: no output.

- [ ] **Step 6: Commit active wording/fence cleanup if files changed**

If Step 1 changed active files:

```bash
git add <the exact active files changed in Step 1>
git commit -m "docs: remove stale gameplay compatibility wording"
```

If Step 1 required no file changes, do not create an empty commit.

---

### Task 6: Run the full repository gate and hand off to implementation review

**Files:**
- Verify the whole repository.
- Verify no `packages/shared/drizzle/**` changes.

**Interfaces:**
- Consumes: completed HPA-556 implementation tree.
- Produces: merge-readiness evidence for the implementation PR.

- [ ] **Step 1: Run workspace type, lint, unit, and build gates**

From the repository root:

```bash
bun run check
bun run lint
bun run test:unit
bun run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Re-run current gameplay smoke**

```bash
cd apps/web
bun run test:e2e:smoke
cd ../..
```

Expected: smoke passes.

- [ ] **Step 3: Re-run residue and migration fences**

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

Expected: residue command emits nothing; migration diff and whitespace diff checks exit 0.

- [ ] **Step 4: Inspect the final change shape**

```bash
git status --short
git diff --stat main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: clean working tree, deletion/refactor-focused diff, no migration files, and focused task commits.

- [ ] **Step 5: Implementation handoff**

Summarize in the implementation PR:

- deleted compatibility paths;
- current request/session/stat contracts;
- permissive same-v1 extra-field hydration rule;
- intentionally retained physical D1 `timing_quality`/CHECK;
- exact validation commands and results;
- confirmation that `packages/shared/drizzle/**` is unchanged.
