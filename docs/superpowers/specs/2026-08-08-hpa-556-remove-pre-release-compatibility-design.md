# HPA-556: Remove Pre-Release Gameplay Compatibility — Design

**Linear:** HPA-556  
**Status:** Design for implementation  
**Date:** 2026-08-08

## Context

Perseus has no production user data that needs a compatibility rollout, but the gameplay stack still carries several pre-release compatibility paths:

- browser session persistence migrates unversioned v0 snapshots, hashes legacy payloads into deterministic run IDs, creates deterministic legacy tray order, and preserves future schemas in a read-only mode;
- local statistics migrate an older unversioned shape, preserve future schemas, and expose a terminal `incompatible_schema` completion failure;
- `PuzzleSession`, completion seals, and the shared API contract model `TimingQuality = 'known' | 'legacy_unknown'` even though newly-created current sessions do not need that distinction;
- the puzzle route has separate `TIME UNAVAILABLE` and persistence-read-only presentation/orchestration;
- the completion endpoint accepts both the current versioned request and the old `{ timeSeconds }` request, with separate repository and database write paths;
- the web API client still exposes `recordCompletionLegacy`, and the web package keeps `@noble/hashes` only for deterministic legacy session IDs;
- E2E helpers and test fixtures still encode `migrated` / `incompatible` load states and `timingQuality` fields.

HPA-225 and HPA-555, the two explicit blockers for this work, are complete. HPA-556 now unlocks HPA-557 (route component extraction), HPA-218 (gallery progress/Continue), and part of HPA-224 (completion summary).

## Goals

1. Keep exactly one current browser session format, one current local-stat format, and one current completion request contract.
2. Treat missing, malformed, stale, or unsupported local data as disposable: best-effort delete it and start fresh.
3. Remove `legacy_unknown`, the `TimingQuality` domain concept, legacy run IDs, v0 migration, future-schema preservation, and the legacy completion request/write path.
4. Preserve current gameplay behavior for Timed, Relaxed, local-puzzle, and authenticated API-puzzle flows.
5. Make the code that HPA-557 will split smaller before introducing component boundaries.

## Non-goals

- no new schema registry, migration pipeline, compatibility adapter, fallback reader, controller, store, or state machine;
- no new browser session schema version solely for this cleanup;
- no redesign of `PuzzleSession`, completion retry coordination, or gameplay UX;
- no compatibility contract for old API callers;
- no D1 data migration, table rebuild, or compatibility rollout;
- no HPA-557 component extraction and no HPA-218/HPA-224 product work in this ticket.

## Options considered

### Option A — Delete compatibility at the existing boundaries (recommended)

Remove obsolete fields and branches from the current domain/API contracts, make browser persistence reset invalid data, and retain the existing D1 `timing_quality` storage column as an internal implementation detail populated with `known`.

**Pros**

- deletes the most code and state without inventing replacement architecture;
- keeps the public/domain model truthful: Timed vs Relaxed already determines whether elapsed time exists;
- avoids a database-table rebuild whose only benefit would be removing an internal column;
- directly simplifies the puzzle route before HPA-557.

**Cons**

- the physical D1 ledger keeps one redundant column and its historical CHECK until a future schema-changing reason justifies rebuilding that table.

### Option B — Keep `TimingQuality = 'known'` as a one-value type

Delete `legacy_unknown` but retain `timingQuality` throughout state, seals, requests, and persistence.

**Rejected:** this minimizes the diff but preserves an abstraction with no decisions left to model. It also keeps conditionals and plumbing that HPA-556 is intended to remove.

### Option C — Rebuild the D1 completion ledger without `timing_quality`

Remove the domain concept and also rebuild `puzzle_completion_runs` so the physical database matches exactly.

**Rejected for now:** it adds migration/rebuild work and operational risk without product value. A future schema change can remove the redundant column when the rebuild buys something else.

## Decision

Use **Option A**.

The cleanup is deletion-first and stays inside the existing boundaries. `PuzzleSession` remains the canonical gameplay state owner; the route remains responsible for lifecycle/persistence/effect orchestration until HPA-557.

## Current-only contracts

### Completion request

`RecordPuzzleCompletionV1` remains version-discriminated but becomes:

```ts
interface RecordPuzzleCompletionV1 {
  version: 1;
  runId: string;
  resultClass: ResultClass;
  elapsedActiveSeconds: number | null;
}
```

Rules:

- `runId` is a current UUID v4 only; `legacy-<sha256>` IDs are no longer accepted;
- `relaxed` requires `elapsedActiveSeconds === null`;
- timed result classes require a positive integer elapsed value up to `MAX_COMPLETION_TIME_SECONDS`;
- the validator remains exact-key: old requests carrying `timeSeconds`, `timingQuality`, missing `version`, or any extra field are rejected with `400 bad_request`.

The `version: 1` discriminator remains because it is the cheap mechanism for rejecting stale API payloads. HPA-556 does not create a new request version merely because a pre-release field was removed.

The web client surface becomes current-only at the same time: `recordCompletionLegacy` is deleted with the server legacy path so there is no surviving caller that can still emit `{ timeSeconds }`.

### PuzzleSession and persisted session

Remove `TimingQuality` from:

- runtime `PuzzleSessionState`;
- `SealedCompletion`;
- `PersistedPuzzleSessionV1`;
- session serialization/hydration and completion projection.

Timing semantics become direct:

- **Timed:** elapsed time is a whole-number value and the clock can run while lifecycle is active;
- **Relaxed:** elapsed time is `null` and no timer runs.

`CURRENT_SESSION_SCHEMA_VERSION` stays `1`, as required by HPA-556. The loader supports only that current version and current invariants. It does not migrate missing-schema data and does not preserve higher/lower/otherwise unsupported schemas.

**Current-v1 hydration remains field-permissive.** Session validation is not an exact-key API validator. A schema-1 snapshot may contain obsolete/unknown extra properties, including a leftover `timingQuality: 'known'` written by the immediately previous build. The loader stops reading that property, validates only the fields/invariants it still owns, and the next serialization omits it. This is not a migration pipeline or compatibility adapter; it preserves the existing non-exact-key validator behavior while removing the concept from runtime state.

The storage adapter owns destructive recovery:

1. read `puzzle-progress-<id>`;
2. parse and validate the current schema against the resolved puzzle identity/piece layout;
3. if valid, return it;
4. if malformed or unsupported, best-effort remove the key and report no restored session;
5. the route constructs a fresh session normally.

This removes `migrated` / `incompatible` load states and removes the route's `persistenceReadOnly` branch. E2E support helpers that seed/inspect persisted sessions must follow the same current-only result shape.

Validation continues protecting live invariants that matter for safe hydration: puzzle/source identity, valid lifecycle/mode/UUID run ID, current piece IDs and canonical cells, tray permutation, rotation state, counters/facts, result class consistency, completion seal/effect consistency, and optional organization/viewport shapes. HPA-556 removes compatibility-specific validation, not the invariant boundary itself.

### Local statistics

Keep the existing current `PuzzleStatsV1` schema and run-ID dedup ring, but remove compatibility behavior:

- no unversioned legacy stats conversion;
- no future-schema preservation;
- no fallback seeding for omitted current fields such as `recordedRunIds`;
- no `incompatible_schema` result;
- no deprecated `saveCompletionTime` shim.

Any stored record that is not the current valid shape is best-effort deleted and treated as empty stats. The normal Web Locks behavior remains: current writes are still serialized when possible, and storage/lock failures remain retryable `storage_error` failures.

### Server completion write path

The Worker completion route validates one current request and calls `recordVersionedCompletion` directly.

Delete:

- `ParsedCompletionRequest.kind` legacy/versioned branching;
- `recordLegacyCompletion`;
- `LegacyCompletionWrite` / `LegacyCompletionWriteExecution`;
- `CompletionWriteExecutor.writeLegacy`;
- D1/Bun driver legacy stats upsert and its 30-second dedupe heuristic;
- `recordCompletionLegacy` from the web API service;
- legacy-only route/client/repository/driver tests.

The current run ledger remains the source of idempotency and conflict detection.

## D1 `timing_quality` storage boundary

The domain/API field disappears, but this ticket does **not** rebuild `puzzle_completion_runs` and does **not** rewrite its checked-in database schema.

For current writes:

- D1 and Bun-SQLite driver input contracts no longer accept timing quality;
- each driver writes the storage-only literal `known` into the existing non-null column;
- stored completion facts and repository interfaces no longer expose the column;
- canonical-best logic is simply `resultClass === 'standard_timed' && elapsedActiveSeconds !== null`.

The existing `packages/shared/src/schema.ts` representation and `packages/shared/drizzle/**` migrations continue to describe the physical database, including the historical CHECK that permits `legacy_unknown`. That physical allowance is not reachable through the current application contract after HPA-556 and is intentionally left alone to avoid a table rebuild.

**Migration fence:** do not run `drizzle-kit generate`, do not add or modify any file under `packages/shared/drizzle/`, and verify the implementation diff for that directory is empty. A future schema-changing ticket may remove the storage column and historical CHECK together.

## Route simplification

The puzzle route returns to two presentation modes:

- **Timed:** show timer and timed completion statistics;
- **Relaxed:** show Relaxed presentation without a timer.

Delete:

- `showUnknownTimePresentation` / `TIME UNAVAILABLE` behavior;
- future-schema `persistenceReadOnly` state and checkpoint suppression;
- the local-stat `incompatible_schema` acknowledgement branch.

Current completion retry behavior remains unchanged for actual storage/network/auth/server failures.

## Dependency and fixture cleanup

After legacy run hashing is deleted, `@noble/hashes` has no live code consumer in `apps/web`. Remove it from `apps/web/package.json` and update `bun.lock` with `bun install` rather than hand-editing the lockfile.

Update all live current-contract consumers in the same work rather than relying on final cleanup discovery. This includes:

- web API client/tests;
- session test fixtures and edge/storage tests;
- route tests;
- E2E persisted-state fixtures and support helpers that branch on load-result variants.

Historical `docs/superpowers/` plans/specs remain provenance and do not need rewriting. Active runtime/test residue scans exclude those historical documents and the intentionally retained physical D1 schema/migrations where appropriate.

## Testing strategy

Use existing tests as the behavior fence, but delete compatibility-only assertions instead of replacing them with a migration framework.

Focused replacement assertions:

- shared type validator accepts current timed/Relaxed requests and rejects `{ timeSeconds }`, legacy run IDs, and requests carrying removed fields;
- session storage loads a valid current snapshot, deletes malformed/unsupported stored data, and starts fresh;
- a valid schema-1 snapshot containing obsolete `timingQuality: 'known'` still hydrates, while its next serialized snapshot omits `timingQuality`;
- local stats load current records, delete unsupported records, preserve run-ID dedup, and report only real storage failures;
- Worker completion route rejects legacy request bodies and stores current requests through the versioned ledger only;
- web API tests prove the legacy client method is gone and the current four-field request is emitted;
- route tests cover current Timed/Relaxed presentation and fresh fallback after stale local persistence;
- persistence test files run as a group after the load-result changes;
- current gameplay smoke E2E runs once immediately after the atomic `TimingQuality` cut, then again in final verification.

The atomic type removal follows this caller checklist so no layer is forgotten:

1. `@perseus/types`: request shape, validator, UUID-only run IDs, `TIMING_QUALITIES` removal;
2. `@perseus/shared`: write/fact interfaces, best/conflict logic, driver storage literal, repository callers;
3. web session domain: state, seal, persistence, hydration, clock gating, completion projection;
4. local stats eligibility;
5. route presentation/effects;
6. unit and E2E fixtures/support code.

No tests are added for hypothetical future migration behavior.

## Implementation boundaries

HPA-556 should land as one implementation PR with small commits. It should not extract components or add abstraction layers while deleting compatibility. Once merged, HPA-557 can split board/inventory/completion UI against a simpler route and current-only persistence model.
