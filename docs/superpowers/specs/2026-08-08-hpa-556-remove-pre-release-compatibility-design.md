# HPA-556: Remove Pre-Release Gameplay Compatibility — Design

**Linear:** HPA-556  
**Status:** Design for implementation  
**Date:** 2026-08-08

## Context

Perseus has no production user data that needs a compatibility rollout, but the gameplay stack still carries pre-release compatibility paths:

- browser session persistence migrates unversioned v0 snapshots, hashes legacy payloads into deterministic run IDs, creates deterministic legacy tray order, and preserves future schemas in a read-only mode;
- local statistics migrate an older unversioned shape, preserve future schemas, and expose a terminal `incompatible_schema` completion failure;
- `PuzzleSession`, completion seals, and the shared API contract model `TimingQuality = 'known' | 'legacy_unknown'` even though current sessions no longer need that distinction;
- the puzzle route has separate `TIME UNAVAILABLE` and persistence-read-only presentation/orchestration;
- the completion endpoint accepts both the current versioned request and the old `{ timeSeconds }` request, with separate repository and database write paths;
- the web API client still exposes `recordCompletionLegacy`, and the web package keeps `@noble/hashes` only for deterministic legacy session IDs;
- E2E helpers and test fixtures still encode `migrated` / `incompatible` load states and `timingQuality` fields.

HPA-225 and HPA-555, the two explicit blockers for this work, are complete. HPA-556 now unlocks HPA-557 (route component extraction), HPA-218 (gallery progress/Continue), and part of HPA-224 (completion summary).

## Goals

1. Keep exactly one current browser session format, one current local-stat format, and one current completion request contract.
2. Treat missing, malformed, stale, unsupported, or invariant-invalid local data as disposable: best-effort delete it and start fresh.
3. Remove `legacy_unknown`, the `TimingQuality` domain concept, legacy run IDs, v0 migration, future-schema preservation, and the legacy completion request/write path.
4. Preserve current Timed, Relaxed, local-puzzle, and authenticated API-puzzle behavior.
5. Make the code that HPA-557 will split smaller before introducing component boundaries.

## Non-goals

- no schema registry, migration pipeline, compatibility adapter, fallback reader, controller, store, or state machine;
- no new browser session schema version solely for this cleanup;
- no redesign of `PuzzleSession`, completion retry coordination, or gameplay UX;
- no compatibility contract for old API callers;
- no D1 data migration, table rebuild, or compatibility rollout;
- no HPA-557 component extraction and no HPA-218/HPA-224 product work in this ticket.

## Options considered

### Option A — Delete compatibility at the existing boundaries (recommended)

Remove obsolete fields and branches from the current domain/API contracts, make browser persistence reset invalid data, and retain the existing D1 `timing_quality` storage column as an internal implementation detail populated with `known`.

**Pros**

- deletes the most code and state without replacement architecture;
- keeps the public/domain model truthful: Timed vs Relaxed already determines whether elapsed time exists;
- avoids a database-table rebuild whose only benefit would be removing an internal column;
- directly simplifies the puzzle route before HPA-557.

**Cons**

- the physical D1 ledger keeps one redundant column and its historical CHECK until a future schema-changing reason justifies rebuilding that table.

### Option B — Keep `TimingQuality = 'known'` as a one-value type

Delete `legacy_unknown` but retain `timingQuality` throughout state, seals, requests, and persistence.

**Rejected:** this preserves an abstraction with no decisions left to model and keeps plumbing that HPA-556 exists to remove.

### Option C — Rebuild the D1 completion ledger without `timing_quality`

Remove the domain concept and rebuild `puzzle_completion_runs` so the physical database matches exactly.

**Rejected:** the retained CHECK already accepts exactly the current shapes when drivers write `known`: Relaxed with `NULL` elapsed time, or a timed result class with an integer elapsed time in range. Rebuilding the table buys no current behavior.

## Decision

Use **Option A**.

The cleanup is deletion-first and stays inside existing boundaries. `PuzzleSession` remains the canonical gameplay state owner; the route remains responsible for lifecycle, persistence, and completion-effect orchestration until HPA-557.

## Current-only contracts

### Completion request

`RecordPuzzleCompletionV1` stays version-discriminated but becomes:

```ts
interface RecordPuzzleCompletionV1 {
  version: 1;
  runId: string;
  resultClass: ResultClass;
  elapsedActiveSeconds: number | null;
}
```

Rules:

- `runId` is UUID v4 only; `legacy-<sha256>` IDs are rejected;
- `relaxed` requires `elapsedActiveSeconds === null`;
- timed result classes require a positive integer elapsed value up to `MAX_COMPLETION_TIME_SECONDS`;
- the API validator remains exact-key: `{ timeSeconds }`, `timingQuality`, missing `version`, or any extra field is rejected with `400 bad_request`.

`version: 1` remains because it is the cheap discriminator for rejecting stale API payloads. HPA-556 does not invent version 2 merely because a pre-release field is deleted.

The web client becomes current-only at the same boundary: delete `recordCompletionLegacy`, its unit coverage, and stale route-test mock properties that reference it.

The Worker parser surface also collapses rather than retaining one-member compatibility aliases: `ParsedCompletionRequest` and `CompletionRouteResult` are deleted, `CompletionRequestParseResult.value` is `RecordPuzzleCompletionV1`, and `completionResultToResponse` consumes `VersionedCompletionResult` directly.

### PuzzleSession and persisted session

Remove `TimingQuality` from runtime `PuzzleSessionState`, `SealedCompletion`, `PersistedPuzzleSessionV1`, serialization/hydration, and completion projection.

Timing semantics become direct:

- **Timed:** elapsed time is a whole-number value and the clock can run while lifecycle is active;
- **Relaxed:** elapsed time is `null` and no timer runs.

`CURRENT_SESSION_SCHEMA_VERSION` stays `1`. The loader supports only schema 1 and current invariants. It does not migrate missing-schema data and does not preserve higher/lower schemas.

**Current-v1 hydration remains field-permissive.** Session validation is not an exact-key API validator. A schema-1 snapshot may contain obsolete/unknown extra properties, including `timingQuality: 'known'` from the immediately previous build. The loader stops reading that property, validates the current fields/invariants it still owns, and returns a current snapshot without the obsolete key. Normal serialization therefore omits it on the next checkpoint.

The storage adapter owns destructive recovery:

1. read `puzzle-progress-<id>`;
2. parse and validate schema 1 against the resolved puzzle identity and piece layout;
3. return a valid snapshot;
4. best-effort delete malformed, different-schema, or invariant-invalid data and report no restored session;
5. let the route construct a fresh session normally.

This removes `migrated` / `incompatible` load states and the route's `persistenceReadOnly` branch. E2E helpers that seed persisted sessions must use the same current-only result shape.

Validation still protects live hydration invariants: puzzle/source identity, lifecycle/mode/UUID run ID, piece IDs and canonical cells, tray permutation, rotation state, counters/facts, result class consistency, completion seal/effect consistency, and optional organization/viewport shapes.

### Local statistics

Keep the current `PuzzleStatsV1` schema and run-ID dedup ring, but remove compatibility behavior:

- no unversioned legacy stats conversion;
- no future-schema preservation;
- no fallback seeding for omitted current fields such as `recordedRunIds`;
- no `incompatible_schema` result;
- no deprecated `saveCompletionTime` shim.

**Every present record that is not a valid current object is disposable.** This includes malformed JSON, JSON primitives such as `42`, `null`, or strings, different schema versions, and invariant-invalid current objects. Each is best-effort deleted and treated as empty stats. The Web Locks behavior remains: current writes stay serialized when possible, while storage/lock failures remain retryable `storage_error` failures.

Delete stale test mocks for `saveCompletionTime` when the shim is removed so the final residue fence represents real consumers.

### Server completion write path

The Worker completion route validates one current request and calls `recordVersionedCompletion` directly.

Delete `recordLegacyCompletion`, `LegacyCompletionWrite`, `LegacyCompletionWriteExecution`, `CompletionWriteExecutor.writeLegacy`, D1/Bun legacy stats upserts and dedupe heuristic, `recordCompletionLegacy`, legacy parser/result aliases, legacy tests, and stale mock properties.

The current run ledger remains the source of idempotency and conflict detection.

## D1 `timing_quality` storage boundary

The domain/API field disappears, but this ticket does **not** rebuild `puzzle_completion_runs` and does **not** rewrite its checked-in database schema.

For current writes:

- D1 and Bun-SQLite input contracts no longer accept timing quality;
- each driver writes storage-only literal `known` into the existing non-null column;
- stored completion facts and repository interfaces no longer expose the column;
- canonical-best logic becomes `resultClass === 'standard_timed' && elapsedActiveSeconds !== null`.

The existing `packages/shared/src/schema.ts` representation and `packages/shared/drizzle/**` migrations continue describing the physical database, including the historical CHECK that permits `legacy_unknown`. Once application writers always supply `known`, the CHECK's reachable shapes are exactly the current Relaxed and timed shapes, so narrowing it would add migration churn without behavioral gain.

**Migration fence:** do not run `drizzle-kit generate`, do not add or modify anything under `packages/shared/drizzle/`, and verify the implementation diff for that directory is empty.

## Route simplification

The puzzle route returns to two presentation modes:

- **Timed:** show timer and timed completion statistics;
- **Relaxed:** show Relaxed presentation without a timer.

Delete `showUnknownTimePresentation`, `TIME UNAVAILABLE`, `persistenceReadOnly`, and the local-stat `incompatible_schema` acknowledgement branch. Current retry behavior remains unchanged for real storage/network/auth/server failures.

## Dependency and fixture cleanup

After legacy run hashing is deleted, `@noble/hashes` has no live `apps/web` consumer. Remove it from `apps/web/package.json` and update `bun.lock` with Bun, then inspect the lockfile diff. The accepted diff may remove `@noble/hashes` and entries that become unreachable because of that removal; it must not contain unrelated package version changes or additions.

Update all live consumers in the same work rather than relying on final cleanup discovery, including web API client/tests and route mock factories, session test fixtures and edge/storage tests, route tests, and E2E persisted-state/support helpers.

Historical `docs/superpowers/` plans/specs remain provenance and do not need rewriting.

## Testing strategy

Use existing tests as the behavior fence, deleting compatibility-only assertions rather than replacing them with migration machinery.

Focused replacement assertions:

- shared type validator accepts current Timed/Relaxed requests and rejects `{ timeSeconds }`, legacy run IDs, and removed fields;
- session storage loads current snapshots, destructively recovers from stale data, and accepts schema-1 snapshots with obsolete extra `timingQuality` while returning/serializing the current shape without it;
- local stats delete malformed JSON, JSON primitives, different schemas, and invalid current records while preserving current run-ID dedup;
- Worker completion route rejects legacy bodies and stores current requests through the versioned ledger only;
- web API tests prove only the current completion client remains;
- route tests cover Timed/Relaxed presentation and fresh fallback after stale persistence;
- the whole `persistence*.test.ts` group runs after load-result changes;
- Task 4 establishes package-local gates, adds session-side behavioral red tests before changing the engine, then runs `session*.test.ts` + `persistence*.test.ts` immediately after the session/domain cut and before route/E2E fixture edits;
- current gameplay smoke E2E runs immediately after the four-field contract cut and again in final verification.

## Risks and mitigations

- **Broad Task 4 blast radius:** removing a cross-package type can make the workspace temporarily uncompilable. Mitigation: keep `TimingQuality` temporarily exported only during the uncommitted request/shared substeps, add behavioral web tests before changing the engine, then remove the export after session consumers are gone and run focused session/persistence gates before route/E2E work.
- **Accidental current-session wipe:** exact-key session validation would reject existing schema-1 snapshots carrying obsolete fields. Mitigation: preserve field-permissive hydration and add the explicit obsolete-`timingQuality` regression test.
- **Lockfile drift:** a dependency-removal install could rewrite unrelated resolutions. Mitigation: inspect `apps/web/package.json` + `bun.lock` diff and reject unrelated version/addition churn.
- **Accidental D1 rebuild:** schema generation would turn a deletion-only change into migration work. Mitigation: no `drizzle-kit generate` and a hard `packages/shared/drizzle/**` no-diff gate.

## Implementation boundaries

HPA-556 should land as one implementation PR with small commits. It must not extract components or add abstraction layers while deleting compatibility. Once merged, HPA-557 can split board/inventory/completion UI against a simpler route and current-only persistence model.
