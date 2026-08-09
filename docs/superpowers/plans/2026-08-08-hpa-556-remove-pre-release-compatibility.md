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

- **Task 4 cross-package blast radius:** the tree is intentionally uncompilable at some uncommitted intermediate points. Use package-local and focused browser gates between layers, then commit the final Task 4 cut atomically.
- **Current schema-1 session reset:** exact-key session validation would discard valid in-flight sessions that still contain obsolete fields. Protect field-permissive hydration with a raw-object regression test.
- **Lockfile drift:** dependency removal must not opportunistically change unrelated resolutions. Inspect the `bun.lock` diff before committing Task 1.
- **Accidental D1 migration:** no schema generation belongs in HPA-556. The final `packages/shared/drizzle/**` diff must be empty.

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

**Interfaces:**
- Consumes: `CURRENT_SESSION_SCHEMA_VERSION`, `SessionValidationContext`, current `PersistedPuzzleSessionV1`.
- Produces: `SessionLoadResult = { status: 'missing' } | { status: 'loaded'; snapshot: PersistedPuzzleSessionV1 } | { status: 'invalid'; reason: string }`; the storage adapter converts `invalid` into best-effort cleanup plus `missing`.

- [ ] **Step 1: Replace migration/preservation assertions with reset assertions**

Delete persistence tests for legacy hash/tray helpers, v0 migration, and future-schema preservation. Add:

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

- [ ] **Step 2: Run the whole persistence test group and confirm failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence*.test.ts
```

Expected: FAIL because unversioned data still migrates and higher schemas are preserved.

- [ ] **Step 3: Delete the compatibility codec and collapse load results**

In `persistence.ts`, delete `@noble/hashes` imports, `sha256Hex`, `canonicalJson`, `canonicalize`, `legacyRunId`, `fnv1aUtf8`, `mulberry32`, `deterministicLegacyTrayOrder`, `migrateV0toV1`, `parseLegacyLastUpdated`, and future-schema preservation.

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

Keep `loadPersistedSession()` pure. In `createSessionStorageAdapter().loadSession()`:

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

- [ ] **Step 5: Remove route/E2E branches for deleted load results**

In `+page.svelte`:

```ts
const restored = loadResult.status === 'loaded' ? loadResult.snapshot : undefined;
```

Delete `persistenceReadOnly` and checkpoint suppression. In `e2e/gameplay-fixtures/persisted-state.ts` and `e2e/support/gameplay-page.ts`, accept only `loaded` from production validation.

- [ ] **Step 6: Remove `@noble/hashes` and inspect the lockfile diff**

Remove `@noble/hashes` from `apps/web/package.json`, then from the repository root run:

```bash
bun install
git diff -- apps/web/package.json bun.lock
```

Expected: the manifest removes `@noble/hashes`; the lockfile removes only that dependency and entries that become unreachable because of it. No unrelated package additions or version bumps are acceptable.

If unrelated drift appears:

```bash
git restore bun.lock
bun install
git diff -- apps/web/package.json bun.lock
```

If unrelated drift repeats, do not commit Task 1 until the resolution change is understood.

- [ ] **Step 7: Verify and commit Task 1**

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
- Produces: stale/invalid stats reset; local completion write failures reduce to retryable `storage_error`.

- [ ] **Step 1: Add complete reset tests**

Delete legacy/future-schema/`saveCompletionTime` compatibility tests and add:

```ts
it('deletes a JSON primitive instead of reparsing it forever', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(key, '42');

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

it('deletes a higher-schema record', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, puzzleId }));

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});
```

Keep the existing malformed-JSON cleanup assertion and add/retain an unversioned-object cleanup assertion.

- [ ] **Step 2: Run the stats test and confirm failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts
```

Expected: FAIL while legacy/future records are preserved or migrated and primitive JSON survives.

- [ ] **Step 3: Collapse parsing to current valid/invalid behavior**

Delete `parseLegacyRecord`, incompatible-schema preservation, missing-`recordedRunIds` backfill, `saveCompletionTime`, and `incompatible_schema` local results.

Current parsing:

```ts
function parseStoredStats(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
  if (raw.schemaVersion !== CURRENT_STATS_SCHEMA_VERSION) return null;
  return validateV1(raw, puzzleId);
}
```

Primitive cleanup must use the same best-effort removal policy:

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

- [ ] **Step 4: Remove incompatible-stats effect handling and stale test mocks**

Local failure acknowledgement becomes:

```ts
result:
  result.status === 'failed'
    ? { status: 'failed', code: 'storage_error', retryable: true }
    : { status: 'succeeded' }
```

Delete `incompatible_schema` from `CompletionFailureCode`, retry policy, persistence validation, and route handling. In `page.svelte.test.ts`, remove the stale `saveCompletionTime` property from the stats mock.

- [ ] **Step 5: Verify and commit Task 2**

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
- Produces: one parser, one result type, one server write path, and one web client (`recordCompletion`).

- [ ] **Step 1: Make the Worker route reject `{ timeSeconds }`**

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

Expected: FAIL because the legacy body is accepted.

- [ ] **Step 3: Collapse parser/result aliases explicitly**

Delete `ParsedCompletionRequest`. Retype `CompletionRequestParseResult.value` directly:

```ts
export type CompletionRequestParseResult =
  | { ok: true; value: RecordPuzzleCompletionV1 }
  | { ok: false; body: RecordPuzzleCompletionResponse; status: 400 };
```

Delete `CompletionRouteResult` and make:

```ts
export function completionResultToResponse(
  result: VersionedCompletionResult
): CompletionResultResponse {
  // existing current-result mapping
}
```

The parser becomes:

```ts
export function parseCompletionRequest(value: unknown): CompletionRequestParseResult {
  if (!isRecordPuzzleCompletionV1(value, MAX_COMPLETION_TIME_SECONDS)) {
    return badRequest('Invalid completion request');
  }
  return { ok: true, value };
}
```

The Worker route calls `recordVersionedCompletion(..., parsed.value)` directly.

- [ ] **Step 4: Delete legacy repository/executor/driver code**

Remove `LegacyCompletionWrite`, `LegacyCompletionWriteExecution`, `CompletionWriteExecutor.writeLegacy`, `recordLegacyCompletion`, both `writeLegacy` implementations, the 30-second legacy dedupe constant, and legacy-only tests.

- [ ] **Step 5: Delete the web shim and its stale page mock**

Remove `recordCompletionLegacy` from `apps/web/src/lib/services/api.ts` and its API tests. Keep the current `recordCompletion` test and assert its request body exactly.

Also remove this dead property from the route API mock:

```ts
recordCompletionLegacy: vi.fn(() => Promise.resolve()),
```

- [ ] **Step 6: Verify and commit Task 3**

The current request still carries `timingQuality` until Task 4.

```bash
cd ../../packages/shared
bun run check
bun run test:unit

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

**Intentionally unchanged:**
- `packages/shared/src/schema.ts`
- `packages/shared/src/__tests__/schema.test.ts`
- `packages/shared/drizzle/**`

**Interfaces:**
- Produces: four-field `RecordPuzzleCompletionV1`, UUID-v4-only run IDs, no timing-quality domain/API/session field, and storage-only `'known'` writes.

- [ ] **Step 1: Write the four-field request/UUID tests first**

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

Assert both validate; timed+`null` fails; Relaxed+non-null fails; extra `timingQuality` fails exact-key validation; legacy hash IDs fail; UUID v4 succeeds.

Run:

```bash
cd packages/types
bun run test:unit
```

Expected: FAIL before the request/UUID implementation changes.

- [ ] **Step 2: Implement the four-field request and UUID-only run IDs**

In `packages/types/src/core.ts`, remove `timingQuality` from `RecordPuzzleCompletionV1`, make `isPuzzleRunId` UUID-v4-only, and validate exactly `version`, `runId`, `resultClass`, `elapsedActiveSeconds`.

Temporarily keep `TimingQuality` / `TIMING_QUALITIES` exported during Steps 2–4 so the still-unmodified web persistence module can execute behavioral red tests. This export is deleted in Step 5 before the Task 4 commit.

```bash
bun run test:unit
```

Expected: PASS for current request/UUID behavior.

- [ ] **Step 3: Remove timing quality from the shared completion contract**

Remove it from `VersionedCompletionWrite`, `StoredCompletionFacts`, conflict matching, repository projection, and canonical-best logic. D1/Bun drivers write the physical column directly:

```ts
timingQuality: 'known'
```

Do not change `schema.ts`, `schema.test.ts`, or migrations.

```bash
cd ../../packages/shared
bun run check
bun run test:unit
```

Expected: PASS against the existing migration-defined CHECK.

- [ ] **Step 4: Add session-side behavioral red tests before changing the engine**

Keep production session code unchanged for this step. Add assertions that compile against the current types but describe the post-cut shape:

```ts
expect(createPuzzleSession(options).getState()).not.toHaveProperty('timingQuality');

const request = completionRequestFromSeal(makeSeal({ timingQuality: 'known' }));
expect(request).toEqual({
  version: 1,
  runId: RUN_ID,
  resultClass: 'standard_timed',
  elapsedActiveSeconds: 90
});
```

Add the field-permissive hydration regression using a raw object:

```ts
it('ignores obsolete timingQuality on a current schema-1 snapshot', () => {
  const raw = { ...validSnapshot(), timingQuality: 'known' } as Record<string, unknown>;
  const result = loadPersistedSession(JSON.stringify(raw), context);

  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') throw new Error('expected loaded snapshot');
  expect(result.snapshot).not.toHaveProperty('timingQuality');
});
```

Also add a serializer assertion using the existing current `makeState()` helper:

```ts
expect(serializeSession(makeState())).not.toHaveProperty('timingQuality');
```

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session*.test.ts \
  src/lib/services/gameplay/session/persistence*.test.ts
```

Expected: FAIL on the new behavioral assertions, not on unresolved imports.

- [ ] **Step 5: Cut the web session domain/runtime, then remove the temporary type export**

Remove `timingQuality` from state, seals, persisted snapshots, cloning, hydration, completion projection, clock gates, `sealElapsed`, persistence validation, local-stats eligibility, and typed session test fixtures.

Keep the raw extra-field regression from Step 4. Once no web/shared consumer imports it, delete `TimingQuality` and `TIMING_QUALITIES` from `packages/types/src/core.ts`.

Run the immediate internal gate before touching route/E2E fixtures:

```bash
cd ../../packages/types
bun run test:unit

cd ../../apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session*.test.ts \
  src/lib/services/gameplay/session/persistence*.test.ts \
  src/lib/services/__tests__/stats.test.ts
```

Expected: PASS. Fix session/domain failures before continuing.

- [ ] **Step 6: Update route/API tests and remaining E2E fixtures after the session core is green**

Remove remaining timing-quality references from Worker tests, web API tests, route presentation/tests, persisted-state fixtures, `gameplay-page.ts`, `test-fixture.spec.ts`, gameplay infrastructure/session-control tests, and harness-service payload assertions.

Delete `showUnknownTimePresentation` and `TIME UNAVAILABLE`; presentation is Timed vs Relaxed only.

```bash
bun run check
bunx playwright test --list --project=chromium-desktop
```

Expected: web check passes and the E2E suite enumerates.

- [ ] **Step 7: Run smoke and commit the atomic Task 4 cut**

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

---

### Task 5: Prove active compatibility residue is gone without changing physical D1 history

**Files:**
- Verify unchanged: `packages/shared/src/schema.ts`
- Verify unchanged: `packages/shared/src/__tests__/schema.test.ts`
- Verify unchanged: `packages/shared/drizzle/**`
- Verify active runtime/tests under `apps/` and `packages/`.

**Interfaces:**
- Consumes: current-only contracts from Tasks 1–4.
- Produces: explicit evidence that compatibility names are gone except intentional physical-storage history.

- [ ] **Step 1: Remove stale active comments/fixture wording**

Delete or rewrite active comments in `apps/` / `packages/` that still claim migration, future-schema preservation, legacy completion, or unknown-time support. Do not rewrite historical `docs/superpowers/` provenance.

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

- [ ] **Step 3: Prove `timingQuality` remains only at the physical-storage boundary**

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

Expected: exit 0.

- [ ] **Step 4: Assert no D1 migration was generated**

```bash
git diff --exit-code main...HEAD -- packages/shared/drizzle
```

Expected: exit 0.

- [ ] **Step 5: Verify the old completion body is gone from live client/server paths**

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

- [ ] **Step 6: Commit active wording cleanup only when needed**

If Step 1 changed tracked files, stage only tracked changes under active source trees and commit them:

```bash
git add -u -- apps packages
git diff --cached --quiet || git commit -m "docs: remove stale gameplay compatibility wording"
```

If Step 1 changed nothing, the command creates no commit.

---

### Task 6: Run the full repository gate

**Files:**
- Verify the whole repository.
- Verify no `packages/shared/drizzle/**` changes.

**Interfaces:**
- Consumes: completed HPA-556 implementation tree.
- Produces: merge-readiness evidence for the implementation PR.

- [ ] **Step 1: Run workspace type, lint, unit, and build gates**

```bash
bun run check
bun run lint
bun run test:unit
bun run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Re-run gameplay smoke**

```bash
cd apps/web
bun run test:e2e:smoke
cd ../..
```

Expected: smoke passes.

- [ ] **Step 3: Re-run residue, migration, and whitespace fences**

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

Expected: residue scan emits nothing; both git checks exit 0.

- [ ] **Step 4: Inspect the final change shape**

```bash
git status --short
git diff --stat main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: clean working tree, deletion/refactor-focused diff, no migration files, and focused task commits.

- [ ] **Step 5: Record implementation evidence in the implementation PR**

The implementation PR description must state:

- which compatibility paths were deleted;
- the final request/session/stat contracts;
- the permissive same-v1 extra-field hydration rule;
- the intentionally retained physical D1 `timing_quality`/CHECK;
- exact validation commands and outcomes;
- confirmation that `packages/shared/drizzle/**` is unchanged.
