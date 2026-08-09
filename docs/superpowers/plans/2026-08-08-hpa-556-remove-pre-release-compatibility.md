# HPA-556 Remove Pre-Release Gameplay Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete Perseus's pre-release gameplay persistence and completion compatibility paths so browser state, local stats, and completion submission support only the current contracts.

**Architecture:** Keep the existing `PuzzleSession`, storage adapter, local-stat service, Worker route, repository, and completion-ledger boundaries. Make each boundary current-only: invalid local data is deleted and treated as missing, the API accepts one versioned request, and Timed vs Relaxed directly determines timing semantics. Do not introduce migration infrastructure or perform the HPA-557 route-component split here.

**Tech Stack:** TypeScript, Svelte 5/SvelteKit, Vitest browser tests, Hono/Cloudflare Workers, Drizzle ORM, Cloudflare D1, Bun SQLite, Playwright, Bun/Turborepo.

## Global Constraints

- Keep `RecordPuzzleCompletionV1.version` as the request discriminator.
- Keep `CURRENT_SESSION_SCHEMA_VERSION = 1`; do not add a new browser session schema version for this cleanup.
- Missing, malformed, stale, or unsupported local session/stat data is disposable and must reset to a fresh current state.
- Remove migration readers/adapters instead of replacing them with a migration registry or compatibility framework.
- Remove `TimingQuality` from domain/API/session contracts rather than preserving a one-value abstraction.
- Keep the physical D1 `timing_quality` column for now as an internal storage detail written with the literal `known`; do not create a D1 migration solely to drop it.
- Preserve `PuzzleSession` as the canonical gameplay state owner.
- Do not include HPA-557 component extraction or HPA-218/HPA-224 product changes.
- Historical files under `docs/superpowers/` are provenance; do not rewrite old plans/specs just to remove historical mentions.

---

## File map

### Browser session and route

- `apps/web/src/lib/services/gameplay/session/types.ts` — session/seal/persisted contracts and completion projection.
- `apps/web/src/lib/services/gameplay/session/session.ts` — runtime timing and completion semantics.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — current snapshot serialization, validation, and storage reset behavior.
- `apps/web/src/lib/services/gameplay/session/persistence.test.ts` — run-ID, codec, and adapter behavior.
- `apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts` — current snapshot field invariants.
- `apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts` — current sealed-completion invariants.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — engine timing/sealing behavior.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — route persistence and completion-effect orchestration/presentation.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — route current-only behavior.

### Local stats

- `apps/web/src/lib/services/stats.ts` — current local-stat parsing/write/dedup behavior.
- `apps/web/src/lib/services/__tests__/stats.test.ts` — current-stat behavior and reset tests.

### Shared completion contract and storage

- `packages/types/src/core.ts` — `RecordPuzzleCompletionV1`, UUID run-ID validation, result-class rules.
- `packages/types/src/index.test.ts` — shared request-validator tests.
- `packages/shared/src/completion-writes.ts` — current completion write interfaces and ledger interpretation.
- `packages/shared/src/repositories.ts` — current completion repository entry point.
- `packages/shared/src/drivers/d1.ts` — D1 current ledger writer.
- `packages/shared/src/drivers/bun.ts` — Bun-SQLite current ledger writer used by local/shared tests.
- `packages/shared/src/schema.ts` — logical current constraint for the retained physical `timing_quality` column.
- `packages/shared/src/__tests__/repositories.test.ts` — repository contract tests.
- `packages/shared/src/__tests__/repositories.d1.test.ts` — D1 completion tests.
- `packages/shared/src/__tests__/drivers.test.ts` — Bun driver completion tests.
- `packages/shared/src/__tests__/schema.test.ts` — schema constraint tests.

### Worker endpoint

- `apps/api/src/routes/puzzles.complete.shared.ts` — one current request parser and response mapping.
- `apps/api/src/routes/puzzles.complete.worker.ts` — Worker route calls current repository path only.
- `apps/api/src/routes/puzzles.complete.worker.test.ts` — endpoint validation and write-path tests.

### Integration fixtures/dependencies

- `apps/web/e2e/gameplay-fixtures/persisted-state.ts` — current persisted-session fixture only.
- `apps/web/e2e/gameplay-infrastructure.spec.ts` — persistence integration assertions.
- `apps/web/e2e/gameplay-session-controls.spec.ts` — current restore/session-control assertions.
- `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts` — current fixture contract assertions.
- `apps/web/package.json` — remove `@noble/hashes` after legacy hashing is deleted.
- `bun.lock` — generated lockfile update via `bun install`.

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
- Consumes: `CURRENT_SESSION_SCHEMA_VERSION = 1`, `SessionValidationContext`, current `PersistedPuzzleSessionV1`.
- Produces: `SessionLoadResult = { status: 'missing' } | { status: 'loaded'; snapshot: PersistedPuzzleSessionV1 } | { status: 'invalid'; reason: string }`; `SessionStorageAdapter.loadSession()` converts invalid storage to `missing` after best-effort cleanup.

- [ ] **Step 1: Replace migration/preservation tests with destructive-reset tests**

In `persistence.test.ts`, delete imports/tests for `canonicalJson`, `sha256Hex`, `legacyRunId`, `fnv1aUtf8`, `mulberry32`, and `deterministicLegacyTrayOrder`. Add adapter-level tests using the existing `memoryStorage` and `ctx` fixtures:

```ts
it('clears an unversioned stored session and reports it as missing', () => {
  const storage = memoryStorage();
  storage.setItem(
    'puzzle-progress-pz1',
    JSON.stringify({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 10 })
  );

  const adapter = createSessionStorageAdapter({ storage });
  expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
  expect(storage.getItem('puzzle-progress-pz1')).toBeNull();
});

it('clears a different schema version and reports it as missing', () => {
  const storage = memoryStorage();
  storage.setItem(
    'puzzle-progress-pz1',
    JSON.stringify({ schemaVersion: 2, puzzleId: 'pz1' })
  );

  const adapter = createSessionStorageAdapter({ storage });
  expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
  expect(storage.getItem('puzzle-progress-pz1')).toBeNull();
});
```

Keep the existing current-v1 round-trip and invariant tests.

- [ ] **Step 2: Run the focused persistence test and confirm the new reset assertions fail**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts
```

Expected: FAIL because unversioned data still migrates and future schemas are still preserved.

- [ ] **Step 3: Delete the compatibility codec and make the adapter clear invalid data**

In `persistence.ts`:

- remove `@noble/hashes` imports and `sha256Hex`, `canonicalJson`, `canonicalize`, `legacyRunId`;
- remove deterministic legacy tray-order helpers and `migrateV0toV1`/`parseLegacyLastUpdated`;
- change `loadPersistedSession` so only `schemaVersion === CURRENT_SESSION_SCHEMA_VERSION` reaches `validateV1`; absent, older, and higher versions return `invalid`;
- keep `validateV1` as the current hydration invariant boundary;
- make `createSessionStorageAdapter().loadSession()` clear an invalid record and return `missing`.

The load branch should reduce to this shape:

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

And the adapter recovery should be explicit:

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

Update `SessionLoadResult` and comments in `types.ts` to remove `migrated` and `incompatible`.

- [ ] **Step 4: Remove the route's future-schema read-only mode**

In `+page.svelte`, delete `persistenceReadOnly`, its reset logic, and checkpoint suppression. Restore only the loaded case:

```ts
const restored = loadResult.status === 'loaded' ? loadResult.snapshot : undefined;
```

`checkpointSession()` becomes:

```ts
function checkpointSession() {
  if (!sessionStore || !sessionState || !puzzle) return;
  if (sessionState.lifecycle === 'disposed') return;
  const serialized = serializeSession(sessionState);
  if (serialized) sessionStorageAdapter.saveSession(puzzle.id, serialized);
}
```

Update route tests that asserted read-only preservation so a stale snapshot is instead cleared and a fresh playable session is constructed.

- [ ] **Step 5: Remove the now-unused hash dependency through Bun**

Delete `@noble/hashes` from `apps/web/package.json`, then run:

```bash
bun install
```

Do not hand-edit `bun.lock`.

- [ ] **Step 6: Run browser unit/check gates**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts src/routes/puzzle/[id]/page.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test.ts \
  apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts \
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
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: current `PuzzleStatsV1`, `SealedCompletion`, Web Locks write path.
- Produces: local-stat failure is only retryable storage failure; no `incompatible_schema` completion-effect code exists.

- [ ] **Step 1: Rewrite stats compatibility tests as reset tests**

Delete tests for legacy unversioned migration, future-schema preservation, `saveCompletionTime`, and absent-`recordedRunIds` backfill. Add current-only assertions:

```ts
it('deletes an unversioned stats record instead of migrating it', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(
    key,
    JSON.stringify({ puzzleId, bestTime: 90, completedAt: '2024-01-01T00:00:00.000Z', totalCompletions: 2 })
  );

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

it('deletes a higher-schema stats record instead of preserving it', () => {
  const key = `puzzle-stats-${puzzleId}`;
  localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, puzzleId, future: true }));

  expect(getStats(puzzleId)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});
```

Also change the mixed eligibility test so it covers assisted and Relaxed only; `legacy_unknown` is removed in Task 4.

- [ ] **Step 2: Run the focused stats test and confirm reset tests fail**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts
```

Expected: FAIL because legacy/future records are still migrated or preserved.

- [ ] **Step 3: Collapse stats parsing to current valid or invalid**

In `stats.ts`:

- delete `parseLegacyRecord`;
- replace `ParsedStats` with current valid/invalid only;
- require `schemaVersion === CURRENT_STATS_SCHEMA_VERSION`;
- require `recordedRunIds` to be present and valid; remove the fallback from `lastRecordedRunId`;
- on invalid/mismatched data, best-effort remove the key and use `freshStats(puzzleId)` for a write;
- remove `incompatible_schema` from `LocalStatsFailureReason` and `RecordLocalCompletionResult`;
- remove deprecated `saveCompletionTime`.

Keep the current run-ID dedup ring and Web Locks failure behavior. The parser branch should be direct:

```ts
function parseStoredStats(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
  if (raw.schemaVersion !== CURRENT_STATS_SCHEMA_VERSION) return null;
  return validateV1(raw, puzzleId);
}
```

- [ ] **Step 4: Remove the terminal incompatible-stats completion branch**

Delete `'incompatible_schema'` from `CompletionFailureCode`, `isFailureRetryable`, effect validation, and route acknowledgement. The route's local failure branch becomes:

```ts
result:
  result.status === 'failed'
    ? { status: 'failed', code: 'storage_error', retryable: true }
    : { status: 'succeeded' }
```

- [ ] **Step 5: Run focused tests/check**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/__tests__/stats.test.ts \
  src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  src/routes/puzzle/[id]/page.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/services/stats.ts \
  apps/web/src/lib/services/__tests__/stats.test.ts \
  apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "refactor: reset stale local statistics"
```

---

### Task 3: Remove the legacy server completion request/write path

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
- Consumes: existing `RecordPuzzleCompletionV1`, `recordVersionedCompletion`, `CompletionWriteExecutor.write`.
- Produces: `parseCompletionRequest(value)` validates one current request; `CompletionWriteExecutor` has no `writeLegacy`; Worker route always invokes `recordVersionedCompletion`.

- [ ] **Step 1: Make the Worker test require rejection of `{ timeSeconds }`**

Delete legacy-success/tombstone tests and legacy mocks. Add:

```ts
it('rejects the removed legacy timeSeconds body', async () => {
  const res = await buildApp().request(
    `/api/puzzles/${PUZZLE_ID}/complete`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ timeSeconds: 90 })
    },
    DUMMY_ENV
  );

  expect(res.status).toBe(400);
  expect(recordVersionedCompletion).not.toHaveBeenCalled();
});
```

Keep current versioned success, validation, tombstone, replay/conflict/quota, auth, and ownership-backfill coverage.

- [ ] **Step 2: Run the Worker test and verify the legacy request still succeeds**

Run:

```bash
cd apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
```

Expected: FAIL because `{ timeSeconds }` is still accepted.

- [ ] **Step 3: Collapse the request parser and Worker route**

In `puzzles.complete.shared.ts`, replace `ParsedCompletionRequest` with the current request itself:

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

In `puzzles.complete.worker.ts`, delete the legacy import/conditional and call only:

```ts
const result = await recordVersionedCompletion(
  completionWrites,
  session.user.id,
  puzzleId,
  parsed.value
);
```

- [ ] **Step 4: Delete legacy write interfaces and driver implementations**

Remove from shared code:

```ts
// delete these concepts entirely
LegacyCompletionWrite
LegacyCompletionWriteExecution
CompletionWriteExecutor.writeLegacy
recordLegacyCompletion
```

Delete the D1/Bun legacy upsert functions and `COMPLETION_DEDUPE_WINDOW_MS`. Keep `write`, deletion fencing, quota accounting, current run-id idempotency, and canonical-best updates unchanged.

- [ ] **Step 5: Update shared tests to current write-only executors**

Remove `writeLegacy` mocks/tests and assert executors expose/use only the current write contract. For example, repository tests should construct:

```ts
const executor: CompletionWriteExecutor = {
  write: vi.fn(async () => ({
    status: 'stored',
    stored: {
      puzzleId: 'puzzle-1',
      resultClass: 'standard_timed',
      timingQuality: 'known',
      elapsedActiveSeconds: 90,
      completedAt: 1_000
    },
    inserted: true
  })),
  beginPuzzleDeletion: vi.fn(async () => {}),
  finishPuzzleDeletion: vi.fn(async () => {}),
  isPuzzleTombstoned: vi.fn(async () => false)
};
```

`timingQuality` remains temporarily in the current contract until Task 4; do not invent a replacement in this task.

- [ ] **Step 6: Run shared/API gates**

Run:

```bash
cd packages/shared
bun --bun vitest run src/__tests__/repositories.test.ts src/__tests__/repositories.d1.test.ts src/__tests__/drivers.test.ts
bun run check

cd ../../apps/api
bunx vitest run src/routes/puzzles.complete.worker.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/puzzles.complete.shared.ts \
  apps/api/src/routes/puzzles.complete.worker.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts \
  packages/shared/src/completion-writes.ts \
  packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts \
  packages/shared/src/drivers/bun.ts \
  packages/shared/src/__tests__/repositories.test.ts \
  packages/shared/src/__tests__/repositories.d1.test.ts \
  packages/shared/src/__tests__/drivers.test.ts
git commit -m "refactor: remove legacy completion writes"
```

---

### Task 4: Remove `TimingQuality` and legacy run IDs end-to-end

**Files:**
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.test.ts`
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

**Interfaces:**
- Consumes: `SessionMode`, `ResultClass`, current completion ledger.
- Produces: `RecordPuzzleCompletionV1` has `{ version, runId, resultClass, elapsedActiveSeconds }`; `SealedCompletion`/session state/persistence have no `timingQuality`; `isPuzzleRunId` accepts UUID v4 only.

- [ ] **Step 1: Change shared contract tests first**

In `packages/types/src/index.test.ts`, make the accepted request cases exactly:

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
expect(
  isRecordPuzzleCompletionV1({ ...timed, timingQuality: 'known' }, MAX_COMPLETION_TIME_SECONDS)
).toBe(false);
expect(isPuzzleRunId(`legacy-${'a'.repeat(64)}`)).toBe(false);
```

Keep exact-key validation, result-class validation, positive integer elapsed validation, and max-time validation.

- [ ] **Step 2: Run the types test and verify removed fields are still accepted/required**

Run:

```bash
cd packages/types
bunx vitest run src/index.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Remove `TimingQuality` from `@perseus/types`**

In `core.ts`:

- delete `TIMING_QUALITIES` and `TimingQuality`;
- remove `timingQuality` from `RecordPuzzleCompletionV1`;
- make `PUZZLE_RUN_ID_REGEX` UUID-v4-only;
- validate four exact request keys;
- enforce Relaxed/null vs timed/positive-integer timing directly from `resultClass`.

The current validator should end with:

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

- [ ] **Step 4: Remove timing quality from the browser session model**

Delete `timingQuality` from `PuzzleSessionState`, `PersistedPuzzleSessionV1`, `SealedCompletion`, hydration/clone/serialization/validation, and `completionRequestFromSeal`.

In `session.ts`, clock gating becomes mode-only:

```ts
function startClock() {
  if (disposed || state.mode !== 'timed' || clockRunning) return;
  monotonicStart = clock.monotonicNow();
  tickHandle = clock.setInterval(() => checkpointTime(), 1000);
  clockRunning = true;
}
```

And completion timing becomes:

```ts
function sealElapsed(): number | null {
  if (state.mode === 'relaxed') return null;
  return Math.max(1, state.elapsedActiveSeconds ?? 0);
}
```

Current persisted validation should require timed sessions to carry a whole-number elapsed value and Relaxed sessions to carry `null`; delete all `legacy_unknown` branches.

- [ ] **Step 5: Collapse local best eligibility to result class + elapsed**

In `stats.ts`:

```ts
function isEligibleStandardBest(seal: SealedCompletion): boolean {
  return seal.resultClass === 'standard_timed' && seal.elapsedActiveSeconds !== null;
}
```

Update test `makeSeal()` fixtures to omit `timingQuality`; remove the legacy-unknown case entirely.

- [ ] **Step 6: Remove timing quality from public shared write interfaces while retaining the physical D1 column**

In `completion-writes.ts`, remove `timingQuality` from `VersionedCompletionWrite` and `StoredCompletionFacts`; `completionFactsMatch` no longer compares it; canonical best becomes:

```ts
export function isCanonicalBest(input: VersionedCompletionWrite): boolean {
  return input.resultClass === 'standard_timed' && input.elapsedActiveSeconds !== null;
}
```

In `repositories.ts`, do not project a timing field from the API request.

In both drivers, keep satisfying the existing non-null database column internally:

```ts
// physical storage detail only; not part of VersionedCompletionWrite
const CURRENT_TIMING_QUALITY = 'known' as const;
```

Use `CURRENT_TIMING_QUALITY` when inserting `puzzleCompletionRuns`; do not include `timingQuality` in `StoredCompletionFacts`. Narrow `schema.ts`'s logical check to `known` and simplify elapsed constraints so Relaxed is null and all timed classes are integer `1..MAX_COMPLETION_TIME_SECONDS`.

Do **not** generate a D1 migration in this ticket.

- [ ] **Step 7: Remove timing-quality presentation and update current request tests**

In `+page.svelte`:

```ts
const showTimedPresentation = $derived(sessionState?.mode === 'timed');
const showRelaxedPresentation = $derived(sessionState?.mode === 'relaxed');
```

Replace `showKnownTimedPresentation` with `showTimedPresentation`; delete `showUnknownTimePresentation` and `TIME UNAVAILABLE` rendering/logic.

Update Worker route cases to the four-field request shape and delete all legacy-unknown cases. Keep an explicit malformed case showing that a request containing `timingQuality: 'known'` is rejected as an extra field.

- [ ] **Step 8: Run all directly affected unit/check gates**

Run:

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
bunx vitest --run --browser \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-fields.test.ts \
  src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  src/lib/services/__tests__/stats.test.ts \
  src/routes/puzzle/[id]/page.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/types/src/core.ts packages/types/src/index.test.ts \
  packages/shared/src/completion-writes.ts packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts packages/shared/src/drivers/bun.ts packages/shared/src/schema.ts \
  packages/shared/src/__tests__/repositories.test.ts packages/shared/src/__tests__/repositories.d1.test.ts \
  packages/shared/src/__tests__/drivers.test.ts packages/shared/src/__tests__/schema.test.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts \
  apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/session.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/stats.ts \
  apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/lib/services/gameplay/session/session.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts \
  apps/web/src/lib/services/__tests__/stats.test.ts \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "refactor: remove legacy timing quality"
```

---

### Task 5: Delete compatibility-only integration fixtures and assertions

**Files:**
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Modify: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`
- Modify as needed: compatibility-only comments/tests under `apps/` and `packages/` found by the residue scan below.

**Interfaces:**
- Consumes: current four-field completion request, current persisted session without `timingQuality`, destructive stale-state reset behavior.
- Produces: E2E fixtures can create only current snapshots; no test suite advertises migration/read-only/unknown-time behavior.

- [ ] **Step 1: Update the canonical persisted E2E fixture**

Remove `timingQuality` from current fixture objects and delete any helper mode that manufactures legacy/future persisted sessions. A current timed fixture should contain:

```ts
{
  schemaVersion: 1,
  puzzleId,
  source: 'api',
  lifecycle: 'active',
  mode: 'timed',
  runId,
  origin: 'resumed',
  elapsedActiveSeconds: 12,
  timerStarted: true,
  // existing current placement/tray/counter/fact fields remain unchanged
}
```

- [ ] **Step 2: Replace compatibility E2E assertions with one destructive-reset assertion**

Where an existing infrastructure/session-controls test injects a future or unversioned snapshot to verify preservation/unknown time, replace it with one test that injects stale JSON and verifies the route starts a fresh current session and rewrites/clears the stale entry after gameplay begins.

Use the existing E2E localStorage fixture mechanism; the assertion should be equivalent to:

```ts
const stored = await page.evaluate((key) => localStorage.getItem(key), `puzzle-progress-${puzzleId}`);
expect(stored === null || JSON.parse(stored).schemaVersion === 1).toBe(true);
```

Do not add separate migration cases for every obsolete shape.

- [ ] **Step 3: Run fixture/unit and focused E2E tests**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
bun run build:e2e
bunx playwright test e2e/gameplay-infrastructure.spec.ts e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 4: Scan runtime/tests for compatibility residues**

Run from repository root:

```bash
rg -n "legacyRunId|legacy_unknown|writeLegacy|recordLegacyCompletion|saveCompletionTime|persistenceReadOnly|incompatible_schema|canonicalJson|sha256Hex" apps packages
```

Expected: no hits. Historical `docs/superpowers/` are intentionally excluded from this scan.

Then verify there is no legacy completion-body parser left:

```bash
rg -n "timeSeconds" apps/api/src/routes/puzzles.complete.* packages/shared/src
```

Expected: no legacy completion-path hits. `bestTimeSeconds` and other unrelated names elsewhere are not part of this check.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/gameplay-fixtures/persisted-state.ts \
  apps/web/e2e/gameplay-infrastructure.spec.ts \
  apps/web/e2e/gameplay-session-controls.spec.ts \
  apps/web/e2e/gameplay-fixtures/harness-services.spec.ts
git commit -m "test: drop gameplay compatibility fixtures"
```

---

### Task 6: Run repository-wide quality gates and review scope

**Files:**
- Modify only files required by formatter/linter/type/test failures caused by Tasks 1–5.

**Interfaces:**
- Consumes: all HPA-556 changes.
- Produces: a mergeable implementation PR with current-only gameplay persistence/completions and no HPA-557 feature work.

- [ ] **Step 1: Run formatting/lint/type checks**

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

- [ ] **Step 3: Run gameplay smoke E2E on desktop and mobile**

```bash
cd apps/web
bun run test:e2e:smoke
```

Expected: PASS.

- [ ] **Step 4: Verify the final diff contains no compatibility architecture and no unrelated component extraction**

```bash
git diff main...HEAD --stat
git diff main...HEAD -- apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/lib/services/gameplay/session \
  apps/web/src/lib/services/stats.ts \
  apps/api/src/routes/puzzles.complete.shared.ts \
  apps/api/src/routes/puzzles.complete.worker.ts \
  packages/types/src/core.ts \
  packages/shared/src/completion-writes.ts \
  packages/shared/src/repositories.ts \
  packages/shared/src/drivers/d1.ts \
  packages/shared/src/drivers/bun.ts
```

Review requirement: changes should be deletions/simplifications plus focused current-only tests. Reject any new migration registry, compatibility adapter, route component extraction, new state owner, or D1 migration that only drops `timing_quality`.

- [ ] **Step 5: Commit any gate-driven fixes only if necessary**

If the gates required a source/test formatting or correctness fix, commit exactly those files:

```bash
git add <files changed to make the gates pass>
git commit -m "chore: finish HPA-556 cleanup"
```

If the working tree is already clean, do not create an empty commit.

---

## Completion checklist

Before marking HPA-556 done, verify all of the following are true:

- browser runtime has no v0 migration, legacy hash/run-ID path, future-schema preservation, or read-only persistence mode;
- local stats support only the current shape and stale records are deleted;
- `TimingQuality` and `legacy_unknown` are absent from active runtime/tests;
- `RecordPuzzleCompletionV1.version` and `CURRENT_SESSION_SCHEMA_VERSION` remain `1`;
- completion endpoint rejects `{ timeSeconds }` and current requests with removed/extra fields;
- shared completion executor has no `writeLegacy` path;
- Timed, Relaxed, local puzzle, authenticated API completion, replay/conflict/quota, and retry behavior remain covered;
- no data migration or compatibility framework was added;
- HPA-557 component extraction remains separate work.
