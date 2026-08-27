# Puzzle Difficulty, Achievements, and Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut server puzzles over to one family with three fixed concrete variants, then add idempotent progression/mastery and Standard/Rotation plus overall leaderboards without making `PuzzleSession` difficulty-mutable.

**Architecture:** Family is the catalog/image/workflow/deletion identity; variant puzzle ID is the board/session/completion/local-stat identity. One Cloudflare Workflow generates all three variants using difficulty-qualified checkpoints. The existing completion executor remains the single transaction boundary for retained runs, first clears, mode-specific best times, mastery, and achievements. Web, admin, and NativeScript browse families and resolve a difficulty to a concrete variant before gameplay/download.

**Tech Stack:** TypeScript, SvelteKit/Svelte 5, NativeScript + Svelte Native, Cloudflare Workers/Workflows/Durable Objects/KV/R2/D1/Access, Drizzle ORM, Vitest, Playwright, Bun/Turbo, Pulumi.

**Spec:** `docs/superpowers/specs/2026-08-26-puzzle-difficulty-achievements-leaderboards-design.md`

**Freshness baseline:** Reviewed against `main` at `67be5f3e28ab78c186e100e53cd09c6dc7f37f57` after the NativeScript offline-library and Access-only admin changes landed.

## Global Constraints

- Implement this entire cutover in **one PR**. Task commits below are checkpoints, not separate PRs.
- Fixed server tiers are code-owned: `1:1` = Easy 16, Normal 49, Hard 100; `4:3` / `3:4` = Easy 12, Normal 48, Hard 108.
- Difficulty is piece count only. Rotation, hints, reference modes, and timed/relaxed modes stay independent.
- `PuzzleSession` remains keyed by one concrete variant ID. Do not add mutable difficulty to game-core state/schema.
- Family is the only catalog/workflow/deletion/reaper grain. Variant is the gameplay/session/completion/local-stat grain.
- Generate all three variants eagerly in **one family Workflow**. Do not create child workflows or a coordinator service.
- Every repeated Workflow checkpoint inside the difficulty loop includes difficulty in its step name (`generate-${difficulty}-row-${row}`, `finalize-${difficulty}`, etc.).
- Reuse `PUZZLE_METADATA_DO` with a `family | variant` discriminator; do not add another metadata binding.
- Shared original/thumbnail are family-owned; only piece assets live under `puzzles/<variantId>/pieces/`.
- Reuse the existing completion deletion fence once per variant during family cleanup. Do not create a second deletion protocol.
- Completion points are award-once per family+difficulty: Easy 100, Normal 200, Hard 300. Replays award zero completion points.
- Score is derived from unique clears + achievement rows. No score ledger, event ledger, mutable total, rule engine, or materialized overall leaderboard.
- Competitive best times are only `standard_timed` and `rotation_timed`, stored/queryable separately.
- Assisted/relaxed completions still earn unique-clear progression and factual Hintless/Flawless mastery; they never enter time boards.
- Initial mastery is exactly `hintless`, `flawless`, `rotation_clear`, and mastery is non-scoring.
- Achievement IDs/requirements/points are exactly the nine entries in the spec; predicates are ordinary code/queries.
- Puzzle board order: `bestTimeSeconds ASC, achievedAt ASC, playerId ASC`.
- Overall board order: `score DESC, hard DESC, normal DESC, easy DESC, scoreReachedAt ASC, playerId ASC`.
- Return top 50 plus the signed-in player's row if outside the top 50. Never expose email in leaderboard projections.
- The shipped Profile → Puzzle Results list must survive the `puzzle_stats` drop; rewrite it at family+difficulty grain.
- Web family cards resolve Continue/progress/local Standard best independently for each variant; there is no single family piece count/progress/best.
- New server saves use `puzzle-progress-v2-<variantId>`. Quick Puzzle `q-*` saves stay on existing `puzzle-progress-q-*` keys.
- Quick Puzzles remain arbitrary-count/local and outside account progression/leaderboards.
- Public `GET /api/puzzles` catalog listing is removed; both web and mobile browse `/api/puzzle-families`.
- NativeScript downloads remain concrete variant packages after family+difficulty selection.
- Admin remains Cloudflare-Access-only; do not reintroduce passkeys.
- Rename the narrow admin CLI collection path to `/api/admin/puzzle-families` and update its Pulumi Access destination/token helpers in the same PR. Do not keep the old path alias.
- Breaking cutover is read-only export -> deploy -> import/verify families -> one-shot cleanup of old KV/R2 objects. Do not purge source objects before replacement families are ready.
- No runtime V1 completion parser, old server catalog path, legacy difficulty, or legacy metadata/save compatibility branch remains.
- Preserve retained-run quota behavior; destructive history reset clears `player_completion_usage`.

---

## Task 1: Add difficulty/family contracts and make game-core emit V2 completions

**Files:**
- Create: `packages/types/src/progression.ts`
- Modify: `packages/types/src/grid.ts`
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/src/grid.test.ts`
- Test: `packages/types/src/index.test.ts`
- Modify: `packages/game-core/src/session/types.ts`
- Test: `packages/game-core/src/session/session.test.ts`

**Interfaces:**
- Produces `PuzzleDifficulty`, `PUZZLE_DIFFICULTIES`, `DIFFICULTY_PIECE_COUNTS`, `getDifficultyPieceCount()`.
- Produces `PuzzleFamilyMetadata`, `PuzzleFamilySummary`, `PuzzleVariantSummary`, `AchievementId`, `MasteryBadge`.
- Produces `RecordPuzzleCompletionV2`, `RecordPuzzleCompletionResponseV2`, leaderboard/profile contracts.
- `completionRequestFromSeal(seal)` becomes the only client projection to `RecordPuzzleCompletionV2`.

- [ ] **Step 1: Write RED tests for all fixed grids**

```ts
expect(getDifficultyPieceCount('1:1', 'easy')).toBe(16);
expect(getDifficultyPieceCount('1:1', 'normal')).toBe(49);
expect(getDifficultyPieceCount('1:1', 'hard')).toBe(100);
expect(getDifficultyPieceCount('4:3', 'easy')).toBe(12);
expect(getDifficultyPieceCount('4:3', 'normal')).toBe(48);
expect(getDifficultyPieceCount('4:3', 'hard')).toBe(108);
expect(getDifficultyPieceCount('3:4', 'easy')).toBe(12);
expect(getDifficultyPieceCount('3:4', 'normal')).toBe(48);
expect(getDifficultyPieceCount('3:4', 'hard')).toBe(108);
```

For each entry also assert `isValidPieceCountForAspectRatio(count, ratio) === true` and that `getGridDimensionsForAspectRatio()` returns the approved row/column orientation.

- [ ] **Step 2: Write RED tests for family/V2 validation**

Pin exactly one variant ID per difficulty and exact V2 fields. Reject V1, missing `hintsUsed`, missing `incorrectAttempts`, invalid negative counters, relaxed with non-null time, and timed with null/non-integer time.

```ts
expect(isRecordPuzzleCompletionV2({
  version: 2,
  runId,
  resultClass: 'rotation_timed',
  elapsedActiveSeconds: 42,
  hintsUsed: 0,
  incorrectAttempts: 1
}, MAX_COMPLETION_TIME_SECONDS)).toBe(true);
```

- [ ] **Step 3: Write RED game-core projection test**

Use a sealed completion whose hints/wrong attempts are non-zero and assert:

```ts
expect(completionRequestFromSeal(seal)).toEqual({
  version: 2,
  runId: seal.runId,
  resultClass: seal.resultClass,
  elapsedActiveSeconds: seal.elapsedActiveSeconds,
  hintsUsed: seal.hintsUsed,
  incorrectAttempts: seal.incorrectAttempts
});
```

The projection must not include `completedAt`, `rotationEnabled`, or `rotationUsed`.

- [ ] **Step 4: Run RED**

Run:
- `bun --cwd packages/types run test:unit`
- `bun --cwd packages/game-core run test:unit`

Expected: FAIL on missing difficulty/family/V2 symbols and V1 projection.

- [ ] **Step 5: Implement minimal contracts and projection**

In `grid.ts` define the fixed mapping. In `progression.ts` define public family/progression/leaderboard contracts. Replace the active V1 completion request export with V2.

Update game-core imports/exports and `completionRequestFromSeal()` only; do not change `PuzzleSessionState`, `PersistedPuzzleSessionV1`, or the session schema version because difficulty is not session state.

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd packages/types run test:unit`
- `bun --cwd packages/types run build`
- `bun --cwd packages/game-core run test:unit`
- `bun --cwd packages/game-core run build`

Commit: `feat(core): add puzzle family and V2 completion contracts`

---

## Task 2: Replace standalone D1 puzzle/stat schema with family/progression tables

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/drizzle/0005_puzzle_families_progression.sql`
- Create: `packages/shared/drizzle/meta/0005_snapshot.json`
- Modify: `packages/shared/drizzle/meta/_journal.json`
- Test: `packages/shared/src/__tests__/schema.test.ts`

**Interfaces:**
- Produces `puzzleFamilies`, `puzzleVariants`, revised `puzzleCompletionRuns`, `puzzleBestTimes`, `playerDifficultyCompletions`, `playerAchievements`, `playerVariantMastery`.
- Retains infrastructure tables `playerProfiles`, `puzzleDeletionTombstones`, `playerCompletionUsage`.
- Drops new-code use of `puzzles`, `puzzleStats`, `timingQuality`, and `legacy_unknown`.

- [ ] **Step 1: Write RED schema tests**

Assert new table exports and inspect SQL for:
- unique `(family_id, difficulty)`
- `puzzle_best_times` PK `(player_id, puzzle_id, result_class)`
- ranking index `(puzzle_id, result_class, best_time_seconds, achieved_at)`
- first-clear PK `(player_id, family_id, difficulty)`
- mastery PK `(player_id, puzzle_id, badge)`
- achievement PK `(player_id, achievement_id)`
- closed checks for difficulty, competitive result class, and mastery badge.

- [ ] **Step 2: Run RED**

Run: `bun --cwd packages/shared run test:unit -- src/__tests__/schema.test.ts`

- [ ] **Step 3: Implement Drizzle schema**

`puzzle_completion_runs` keeps all four result classes and stores:

```text
player_id, run_id, puzzle_id, result_class,
elapsed_active_seconds, hints_used, incorrect_attempts, completed_at
```

Remove `timing_quality`; relaxed timing nullability is represented directly by result class.

- [ ] **Step 4: Write destructive migration**

The migration deliberately resets old puzzle history/ownership:

```sql
DROP TABLE IF EXISTS puzzle_stats;
DROP TABLE IF EXISTS puzzle_completion_runs;
DELETE FROM player_completion_usage;
DROP TABLE IF EXISTS puzzles;
```

Then create the family/variant/progression tables and revised completion ledger. Preserve profiles, deletion-fence table, and quota table definition.

- [ ] **Step 5: Verify and commit**

Run:
- `bun --cwd packages/shared run test:unit -- src/__tests__/schema.test.ts`
- `bun --cwd packages/shared run check`

Commit: `feat(db): add family progression schema`

---

## Task 3: Extend the existing completion executor and rewrite Profile Puzzle Results

**Files:**
- Create: `packages/shared/src/progression.ts`
- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/drivers/bun.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/drivers.test.ts`
- Test: `packages/shared/src/__tests__/repositories.test.ts`
- Test: `packages/shared/src/__tests__/repositories.d1.test.ts`

**Interfaces:**
- Consumes trusted server-derived `{ playerId, puzzleId, familyId, difficulty }` plus V2 facts.
- `StoredCompletionFacts` stores/compares `hintsUsed` and `incorrectAttempts` in addition to puzzle/result/time.
- Produces `listPuzzleLeaderboard()`, `listOverallLeaderboard()`, `getPlayerProgressionSummary()`.
- Replaces old `listPlayerStats()` internals with family+difficulty rows containing Standard and Rotation bests while retaining cursor pagination.

- [ ] **Step 1: Write scoring/mastery RED tests**

```ts
expect(completionPointsForDifficulty('easy')).toBe(100);
expect(completionPointsForDifficulty('normal')).toBe(200);
expect(completionPointsForDifficulty('hard')).toBe(300);
expect(masteryForCompletion({
  hintsUsed: 0,
  incorrectAttempts: 0,
  resultClass: 'rotation_timed'
})).toEqual(['hintless', 'flawless', 'rotation_clear']);
```

Define the exact nine achievement constants in code, not D1.

- [ ] **Step 2: Write completion executor RED tests**

Cover in both driver suites:
- first family+difficulty clear inserts/scores once
- exact V2 run replay returns replay semantics and no duplicate delta
- same run ID with changed `hintsUsed` or `incorrectAttempts` conflicts
- Standard updates only Standard PB
- Rotation updates only Rotation PB
- assisted/relaxed create no best-time row
- worse repeat keeps original PB/`achievedAt`; better repeat replaces both
- mastery inserts idempotently
- achievements unlock exactly at 1/5/15 unique clears, one full set, 1/5 Hard clears, and first mastery of each type
- retained-run quota remains enforced.

- [ ] **Step 3: Write Profile Puzzle Results RED tests**

Pin the new row grain:

```ts
{
  familyId,
  familyName,
  difficulty: 'normal',
  variantId,
  standardBestTimeSeconds: 90,
  rotationBestTimeSeconds: 120,
  totalCompletions: 4,
  firstCompletedAt,
  lastCompletedAt
}
```

Preserve bounded cursor pagination. Timed rows sort before rows with no competitive best; use the minimum non-null Standard/Rotation best as the profile-list sort value, then `variantId`. Verify this sort does not affect leaderboard mode separation.

- [ ] **Step 4: Run RED**

Run: `bun --cwd packages/shared run test:unit`

- [ ] **Step 5: Extend `CompletionWriteExecutor.write()` as the single transaction**

```ts
interface VersionedCompletionWrite {
  playerId: string;
  puzzleId: string;
  familyId: string;
  difficulty: PuzzleDifficulty;
  runId: string;
  resultClass: ResultClass;
  elapsedActiveSeconds: number | null;
  hintsUsed: number;
  incorrectAttempts: number;
  receivedAt: number;
}
```

Transaction order:
1. tombstone/quota checks
2. insert/find run and compare full V2 stored facts
3. on newly inserted run only, first-clear insert
4. mode-specific PB upsert when competitive
5. mastery inserts
6. achievement inserts
7. return durable progression delta.

Replace Standard-only `isCanonicalBest` with competitive eligibility for Standard/Rotation; keep the result-class key in the PB table.

- [ ] **Step 6: Implement ranking/profile queries**

```ts
listPuzzleLeaderboard(db, { puzzleId, resultClass, playerId, limit: 50 })
listOverallLeaderboard(db, { playerId, limit: 50 })
getPlayerProgressionSummary(db, playerId)
listPlayerStats(db, playerId, { limit, cursor })
```

Derive overall score with SQL CASE expressions from unique clears + achievement constants. Derive `scoreReachedAt` from the latest contributing row; do not store a score aggregate.

- [ ] **Step 7: Verify and commit**

Run:
- `bun --cwd packages/shared run test:unit`
- `bun --cwd packages/shared run check`

Commit: `feat(shared): add progression rankings and family results`

---

## Task 4: Add family metadata/storage and one retry-safe three-variant Workflow

**Files:**
- Modify: `apps/workflows/src/types.ts`
- Modify: `apps/workflows/src/helpers.ts`
- Modify: `apps/workflows/src/index.ts`
- Test: `apps/workflows/src/types.test.ts`
- Test: `apps/workflows/src/helpers.test.ts`
- Test: `apps/workflows/src/index.test.ts`
- Test: `apps/workflows/src/puzzle-metadata-do.test.ts`
- Modify: `apps/api/src/services/storage.worker.ts`
- Test: `apps/api/src/services/storage.worker.test.ts`
- Test: `apps/api/src/services/__tests__/storage-worker-do.test.ts`

**Interfaces:**
- Workflow input becomes `WorkflowParams { familyId: string }`.
- Same metadata DO class stores `{ kind: 'family' | 'variant', metadata }` by family/variant ID.
- Storage exposes `getFamily()`, family create/update, `getPuzzle()` variant reads, `listPuzzleFamiliesPage()`.
- R2 keys are family original/thumbnail + variant piece paths.

- [ ] **Step 1: Write family/variant metadata RED tests**

Assert:
- one family entity and three variant entities use the existing DO namespace
- family/variant identity mismatch is rejected
- gallery index scans only `family:*`
- public family summary includes all three variant IDs/counts.

- [ ] **Step 2: Write Workflow checkpoint RED tests**

One family run must use names equivalent to:

```text
generate-easy-row-0 ... finalize-easy
generate-normal-row-0 ... finalize-normal
generate-hard-row-0 ... finalize-hard
finalize-family
```

Pin that Normal row 0 cannot reuse Easy row 0's cached checkpoint and that retrying after a later variant failure reuses completed earlier checkpoints without minting IDs.

- [ ] **Step 3: Run RED**

Run:
- `bun --cwd apps/workflows run test:unit`
- `bun --cwd apps/api run test:unit -- src/services/storage.worker.test.ts src/services/__tests__/storage-worker-do.test.ts`

- [ ] **Step 4: Generalize metadata DO**

```ts
type MetadataEntity =
  | { kind: 'family'; metadata: PuzzleFamilyMetadata }
  | { kind: 'variant'; metadata: PuzzleMetadata };
```

Keep idempotency reservations separate and map upload idempotency keys to the family ID.

- [ ] **Step 5: Move shared R2/storage helpers to family scope**

Implement focused helpers:

```ts
getFamilyOriginalKey(familyId)
getFamilyThumbnailKey(familyId)
getPieceKey(variantId, pieceId)
getFamily(kv, familyId)
listPuzzleFamiliesPage(kv, params)
```

Variant reference resolves variant metadata then serves family original.

- [ ] **Step 6: Rewrite Workflow around preallocated variants**

```ts
for (const difficulty of PUZZLE_DIFFICULTIES) {
  const variantId = family.variants[difficulty];
  const pieceCount = getDifficultyPieceCount(family.aspectRatio, difficulty);
  // every step.do inside this loop includes `difficulty`
}
```

Generate thumbnail once, preserve row-level checkpoints, finalize each variant separately, then `finalize-family` only after all three are ready.

- [ ] **Step 7: Verify and commit**

Run:
- `bun --cwd apps/workflows run test:unit`
- `bun --cwd apps/workflows run check`
- `bun --cwd apps/api run test:unit -- src/services/storage.worker.test.ts src/services/__tests__/storage-worker-do.test.ts`

Commit: `feat(workflow): generate puzzle families with stable variants`

---

## Task 5: Move deletion/reaper/cleanup ownership to family grain

**Files:**
- Modify: `apps/api/src/services/storage.worker.ts`
- Modify: `apps/api/src/services/puzzle-deletion.worker.ts`
- Modify: `apps/api/src/services/reaper.ts`
- Test: `apps/api/src/services/__tests__/puzzle-deletion.worker.test.ts`
- Test: `apps/api/src/services/__tests__/reaper.test.ts`
- Test: `apps/api/src/services/__tests__/reaper-d1-coverage.test.ts`
- Test: `apps/api/src/services/storage.worker.test.ts`
- Modify: `packages/shared/src/repositories.ts`
- Test: `packages/shared/src/__tests__/repositories.d1.test.ts`

**Interfaces:**
- `CleanupRecord` becomes family-scoped with family ID, all three variant IDs, and all three piece counts.
- Reaper enumerates family records/workflow IDs only.
- Existing completion deletion fence is invoked once per variant ID; there is no family completion fence.

- [ ] **Step 1: Write cleanup-record RED tests**

Pin:

```ts
{
  familyId,
  variantIds: { easy: easyId, normal: normalId, hard: hardId },
  pieceCounts: { easy: 16, normal: 49, hard: 100 },
  createdAt
}
```

A cleanup record must contain everything needed to retry shared/variant asset cleanup after family metadata disappears.

- [ ] **Step 2: Write reaper RED tests**

Cover:
- reaper scans `family:*`, not `puzzle:*`
- workflow lookup uses `familyId`
- a stuck family with one already-ready variant is still one cleanup unit
- no sibling variant is independently fenced/deleted before family cleanup is chosen
- stale KV family status is revalidated through authoritative family DO status before cleanup, preserving current fail-closed behavior.

- [ ] **Step 3: Write deletion fence/order RED tests**

Before any destructive shared/variant asset deletion, assert `beginPuzzleDeletion()` succeeded for Easy, Normal, and Hard variant IDs. After cleanup, assert `finishPuzzleDeletion()` runs for each variant and retained-run usage is reconciled.

Family-specific first-clear/mastery/PB/run rows are deleted. Global achievement rows remain.

- [ ] **Step 4: Run RED**

Run:
- `bun --cwd apps/api run test:unit -- src/services/__tests__/puzzle-deletion.worker.test.ts src/services/__tests__/reaper.test.ts src/services/__tests__/reaper-d1-coverage.test.ts`
- `bun --cwd packages/shared run test:unit -- src/__tests__/repositories.d1.test.ts`

- [ ] **Step 5: Implement family cleanup orchestration**

Cleanup sequence:

```text
write family CleanupRecord
begin fence easy
begin fence normal
begin fence hard
tombstone family + variant metadata DOs
delete families/<familyId>/original + thumbnail
delete each puzzles/<variantId>/pieces/*
delete family + variant KV/D1 catalog rows
finish each variant deletion
delete CleanupRecord
```

Do not call old puzzle-scoped `deletePuzzleAssets()` against a variant because it must no longer own original/thumbnail.

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd apps/api run test:unit`
- `bun --cwd apps/api run check`
- `bun --cwd packages/shared run test:unit`

Commit: `refactor(api): make family the puzzle deletion grain`

---

## Task 6: Cut API/admin/Access surfaces over to families and V2 completion

**Files:**
- Create: `apps/api/src/routes/puzzle-families.worker.ts`
- Create: `apps/api/src/routes/puzzle-families.worker.test.ts`
- Create: `apps/api/src/routes/leaderboard.worker.ts`
- Create: `apps/api/src/routes/leaderboard.worker.test.ts`
- Modify: `apps/api/src/routes/puzzles.worker.ts`
- Modify: `apps/api/src/routes/puzzles.complete.shared.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`
- Modify: `apps/api/src/routes/player.worker.ts`
- Modify: `apps/api/src/routes/player.worker.test.ts`
- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `packages/infrastructure/src/admin-access.ts`
- Modify: `packages/infrastructure/src/admin-access.test.ts`

**Interfaces:**
- Public family list/create/detail/thumbnail and per-family leaderboard.
- Concrete variant detail/piece/reference/complete only under `/api/puzzles/:variantId`.
- No public `GET /api/puzzles` list.
- Admin list/create collection is `/api/admin/puzzle-families`.
- V2 route resolves `variantId -> familyId+difficulty` before executor call.

- [ ] **Step 1: Write family API RED tests**

Create accepts `name`, optional category, aspect ratio, image. It allocates one family + three stable variant UUIDs, stores one family original, inserts family/variant ownership rows, and starts one workflow with `{ familyId }`.

List/detail returns family summaries; `pieceCount` is per variant, not family scalar.

- [ ] **Step 2: Write V2 completion RED tests**

Parser rejects V1. Handler loads variant metadata and passes trusted `familyId`/`difficulty` plus parsed V2 facts to the executor. Exact replay remains idempotent; mismatched mastery facts conflict.

Response can project:

```ts
{
  ok: true,
  progression: {
    firstDifficultyCompletion: true,
    completionPointsAwarded: 200,
    newAchievementIds: ['first_clear'],
    newMasteryBadges: ['flawless'],
    competitive: { personalBest: true, bestTimeSeconds: 90, rank: 4 }
  }
}
```

- [ ] **Step 3: Write leaderboard/profile RED tests**

Family leaderboard validates difficulty/mode and resolves one variant. Overall leaderboard uses exact tie-break order. Profile returns progression summary plus paginated rewritten Puzzle Results. Public leaderboard player projection never includes email.

- [ ] **Step 4: Write Access path RED tests**

Change the narrow CLI path expectation from `/api/admin/puzzles` to `/api/admin/puzzle-families`. Verify broad browser admin remains `/api/admin/*` and delete stays outside the narrow service-token collection path.

- [ ] **Step 5: Implement route cutover**

Move list/create from `puzzles.worker.ts` to family route. Keep detail/piece/reference concrete. Update admin list/create/delete semantics to families. Register family/leaderboard routers. Do not retain the old catalog list as a mobile compatibility route.

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd apps/api run test:unit`
- `bun --cwd apps/api run check`
- `bun --cwd apps/api run lint`
- `bun --cwd packages/infrastructure run test:unit`
- `bun --cwd packages/infrastructure run check`

Commit: `feat(api): expose family catalog progression endpoints`

---

## Task 7: Update seed/admin tooling and implement import-before-cleanup migration

**Files:**
- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/catalog.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/startup/token.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`
- Create: `scripts/export-legacy-puzzles.ts`
- Create: `scripts/import-puzzle-families.ts`
- Create: `scripts/cleanup-legacy-puzzles.ts`
- Create: `scripts/puzzle-family-migration.test.ts`
- Modify: `.gitignore`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`

**Interfaces:**
- Seed/admin family upload sends image/name/category/aspect ratio only.
- Access helpers target `/api/admin/puzzle-families` and continue supporting current service-token/JWT modes; no passkey field returns.
- Export writes ignored local manifest/images.
- Import uses new family create with operator `ownerId` seam.
- Cleanup removes only old exported KV/R2 objects after replacements are ready; no legacy HTTP route remains.

- [ ] **Step 1: Write seed/tooling RED tests**

Remove catalog `pieceCount` and change idempotency identity to content identity without a mutable count, e.g. stable catalog `id` + aspect ratio. Assert generated `FormData` contains no `pieceCount` and CLI URL is `/api/admin/puzzle-families`.

- [ ] **Step 2: Write migration-manifest RED tests**

```ts
interface LegacyPuzzleExport {
  oldPuzzleId: string;
  name: string;
  category?: string;
  aspectRatio: PuzzleAspectRatio;
  pieceCount: number;
  ownerId: string;
  imageFile: string;
}
```

Store under ignored `.migration/puzzle-families/`.

- [ ] **Step 3: Implement read-only pre-deploy export**

Use current Access helpers to enumerate old catalog/ownership and download every ready puzzle reference image. Fail if any ready source image/owner metadata cannot be captured. Perform no delete.

- [ ] **Step 4: Implement post-deploy import**

Read the manifest, POST each source to `/api/admin/puzzle-families` with preserved `ownerId`, poll family status, and require all three variants ready before marking that manifest entry imported.

- [ ] **Step 5: Implement post-import orphan cleanup**

After all replacement families are verified, use one-shot Cloudflare/operator tooling to delete each exported old `puzzle:<oldId>` KV record and `puzzles/<oldId>/...` R2 objects. Do not add an application runtime endpoint/parser for old puzzle records.

- [ ] **Step 6: Update runbook sequence**

```text
1. export old metadata/ownership/originals (read-only)
2. verify export count/files
3. deploy new schema/API/workflow/web/mobile
4. import families through Access-protected family create
5. wait until every family has 3 ready variants
6. clean old exported KV/R2 objects
7. archive/delete local export
```

Document that D1 completion history/quota is intentionally reset at deploy.

- [ ] **Step 7: Verify and commit**

Run:
- `bun run test:scripts`
- `bun run check:scripts`
- `bun run lint:scripts`

Commit: `feat(scripts): migrate standalone puzzles to families`

---

## Task 8: Cut web gallery/progress/local-stats/admin UX over to family + variant resolution

**Files:**
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleCard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`
- Create: `apps/web/src/lib/components/PuzzleDifficultyPicker.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleDifficultyPicker.svelte.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Test: `apps/web/src/lib/services/stats.test.ts`
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.spec.ts`
- Modify: `apps/web/src/routes/upload/+page.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/adminPuzzleList.ts`
- Modify: `apps/web/src/routes/admin/adminPuzzleList.test.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`

**Interfaces:**
- Family card has three variant summaries, not scalar `pieceCount`/progress.
- `galleryProgress` remains variant-ID keyed and resolves three variants per visible family.
- `stats.ts` remains variant-ID keyed; no family aggregate is introduced.
- Server and Quick save key families coexist as specified.
- Admin panel lists/deletes/previews families.

- [ ] **Step 1: Write family-card RED tests**

For a square family assert three actions:

```text
Easy · 16 pieces
Normal · 49 pieces
Hard · 100 pieces
```

No single card `href=/puzzle/<familyId>` exists; each action points to its variant ID.

- [ ] **Step 2: Write per-difficulty progress/best RED tests**

Seed Easy and Hard resumable saves with different `placedCount` values and Normal with none. Assert Easy/Hard show their own Continue counters and Normal shows Play.

Seed local Standard bests for different variant IDs and assert the card reads each independently. Do not modify local stats into a family key.

- [ ] **Step 3: Write off-page discovery and save-prefix RED tests**

Pin:

```ts
server UUID -> puzzle-progress-v2-<uuid>
q-123       -> puzzle-progress-q-123
old server puzzle-progress-<uuid> -> ignored
```

Off-page saved variant discovery loads concrete variant metadata and can surface family name+difficulty without requiring a family save key.

- [ ] **Step 4: Write admin family-panel RED tests**

Admin lists one family, shows E/N/H counts, family preview, family status polling, and deletes the family. On delete, best-effort clear all three web variant sessions. Player Access panel stays unchanged.

- [ ] **Step 5: Implement web catalog/session changes**

Flatten family variants only where a concrete session validation context is needed. Keep `@perseus/game-core` storage adapter unchanged.

Remove server piece-count selection from player upload. Leave `QuickPuzzleUploader.svelte` untouched.

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd apps/web run test:unit`
- `bun --cwd apps/web run check`
- `bun --cwd apps/web run lint`

Commit: `feat(web): make puzzle catalog family-aware`

---

## Task 9: Cut NativeScript gallery/download selection over to family summaries

**Files:**
- Modify: `apps/mobile/app/api/puzzleApi.ts`
- Modify: `apps/mobile/app/api/puzzleApi.test.ts`
- Create: `apps/mobile/app/library/familyGallery.ts`
- Create: `apps/mobile/app/library/familyGallery.test.ts`
- Modify: `apps/mobile/app/library/Gallery.svelte`
- Modify: `apps/mobile/app/library/Library.svelte`
- Modify: `apps/mobile/app/library/downloadedLibrary.ts`
- Modify: `apps/mobile/app/library/downloadedLibrary.test.ts`
- Modify: `apps/mobile/app/library/Downloaded.svelte`

**Interfaces:**
- `PuzzleApi.listPuzzleFamilies(cursor?)` calls `/api/puzzle-families`.
- `familyThumbnailUrl(familyId)` uses family thumbnail route.
- Detail/reference/piece methods remain concrete `variantId` APIs.
- `familyDownloadOptions(family)` returns exactly Easy/Normal/Hard `{ difficulty, variantId, pieceCount }` rows in tier order.
- Gallery difficulty tap calls existing `onDownload(variantId)`; downloaded packages/sessions remain variant IDs.

- [ ] **Step 1: Write API RED tests**

Assert family list decoding accepts three variant summaries and that no catalog request calls `GET /api/puzzles`:

```ts
await api.listPuzzleFamilies();
expect(requestJson).toHaveBeenCalledWith(`${baseUrl}/api/puzzle-families`);
```

Keep concrete `getPuzzle(variantId)`, `referenceUrl(variantId)`, and `pieceImageUrl(variantId, pieceId)` behavior.

- [ ] **Step 2: Write the pure family-gallery RED tests**

```ts
expect(familyDownloadOptions(family)).toEqual([
  { difficulty: 'easy', variantId: family.variants.easy.id, pieceCount: 16 },
  { difficulty: 'normal', variantId: family.variants.normal.id, pieceCount: 49 },
  { difficulty: 'hard', variantId: family.variants.hard.id, pieceCount: 100 }
]);
```

This keeps selection logic testable with the mobile package's existing Vitest-only setup instead of adding Svelte-Native component test infrastructure.

- [ ] **Step 3: Update Gallery/Library to consume the pure projection**

`Library.svelte` stores `PuzzleFamilySummary[]`. `Gallery.svelte` renders one family thumbnail/name and the three `familyDownloadOptions()` rows; tapping a row calls `onDownload(option.variantId)`.

Installed/download-job state remains a `Set<string>`/ID keyed by variant. Installing Easy therefore does not mark Normal/Hard installed.

- [ ] **Step 4: Make Downloaded rows distinguish sibling variants**

Extend `downloadedLibrary.ts` to carry `difficulty` from installed variant metadata and render it in `Downloaded.svelte` beside piece count. This avoids two installed difficulties of the same family appearing as indistinguishable same-name rows while preserving variant-keyed launch/remove/progress behavior.

- [ ] **Step 5: Run the mobile unit suite and commit**

Run: `bun --cwd apps/mobile run test:unit`

Commit: `feat(mobile): select puzzle difficulty before download`

---

## Task 10: Add completion feedback, family boards, overall leaderboard, and progression profile UI

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- Create: `apps/web/src/lib/components/PuzzleLeaderboardDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleLeaderboardDialog.svelte.test.ts`
- Create: `apps/web/src/routes/leaderboard/+page.svelte`
- Create: `apps/web/src/routes/leaderboard/page.svelte.test.ts`
- Modify: `apps/web/src/routes/profile/+page.svelte`
- Modify: `apps/web/src/routes/profile/page.svelte.test.ts`
- Modify: `apps/web/src/routes/+layout.svelte`
- Modify: `apps/web/src/lib/services/api.ts`

**Interfaces:**
- Puzzle route obtains V2 by calling `completionRequestFromSeal(seal)`; it does not construct the request object manually.
- Completion UI consumes `CompletionProgressionDelta`.
- Profile consumes progression summary + rewritten paginated family+difficulty Puzzle Results.

- [ ] **Step 1: Write completion-dialog RED tests**

Cover:
- `+200 First Normal Clear`
- new achievement + point value
- new mastery badges
- competitive PB + rank
- non-PB current vs best
- submission failure still leaves local completion UI usable.

Route test spies on `completionRequestFromSeal`/API call and verifies hints/incorrect attempts come from the seal through the canonical helper.

- [ ] **Step 2: Write family/overall leaderboard RED tests**

Family dialog defaults to current difficulty + Standard, toggles Standard/Rotation without mixing rows, and renders top 50 + separate `YOU · #N` when needed.

Overall page renders score + E/N/H counts and public profile identity without email.

- [ ] **Step 3: Write profile RED tests**

Assert score/rank, E/N/H counts, achievement progress, mastery count, and retained Puzzle Results rows showing difficulty plus separate Standard/Rotation bests. Keep current private email/name/avatar editing behavior.

- [ ] **Step 4: Implement UI using existing composition patterns**

Use current modal focus/action behavior for family leaderboard; do not extract a generic dialog framework. Add `Leaderboard` beside existing navigation entries.

- [ ] **Step 5: Verify and commit**

Run:
- `bun --cwd apps/web run test:unit`
- `bun --cwd apps/web run check`
- `bun --cwd apps/web run lint`

Commit: `feat(web): add puzzle progression and leaderboards`

---

## Task 11: Update E2E fixtures and run the full single-PR verification gate

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/catalog.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Create: `apps/web/e2e/progression-leaderboard.spec.ts`
- Modify: `apps/api/src/__tests__/worker-extra.worker.test.ts` only if route-registration assertions live there
- Modify: `docs/superpowers/plans/2026-08-26-puzzle-difficulty-achievements-leaderboards.md` only for a real execution-discovered correction, not as an implementation diary

**Interfaces:**
- Verifies the full family -> variant -> completion -> ranking flow while preserving Quick Puzzle and mobile unit coverage.

- [ ] **Step 1: Convert deterministic E2E catalog fixtures to family + three variants**

Each family has stable family ID and three stable variant IDs/counts. Gameplay page object remains variant-oriented once URL reaches `/puzzle/<variantId>`.

- [ ] **Step 2: Add critical authenticated E2E path**

```text
gallery shows one family
 -> Easy shows its own Continue/Play state
 -> choose Easy concrete variant
 -> complete Standard timed run
 -> dialog shows first-clear/progression delta
 -> family Easy/Standard leaderboard shows player
 -> overall leaderboard reflects score
 -> profile shows Easy clear + achievement/mastery + Puzzle Results row
```

Also select Normal and prove it navigates to a different variant ID/piece count.

- [ ] **Step 3: Pin family cleanup/admin integration**

Use existing API/admin integration tests to prove one family delete fences/removes all three variant gameplay identities and no variant remains independently catalogued. Do not add a new browser E2E seam solely for deletion when unit/worker coverage already owns the protocol.

- [ ] **Step 4: Add Quick Puzzle regression assertions**

Custom piece count and local resume remain functional; `q-*` has no family/account leaderboard UI.

- [ ] **Step 5: Run focused suites**

Run:
- `bun --cwd apps/web run test:e2e -- gallery.spec.ts progression-leaderboard.spec.ts`
- `bun --cwd apps/web run test:e2e:smoke`
- `bun --cwd apps/mobile run test:unit`

- [ ] **Step 6: Run full repository gate**

From repo root:

```bash
bun run check
bun run lint
bun run test:unit
bun run test:scripts
bun run check:scripts
bun run test:e2e
bun run build
bun --cwd apps/web run test:e2e:assert-production-bundle
bun --cwd apps/mobile run test:unit
```

- [ ] **Step 7: Final spec/diff audit and commit**

Verify explicitly:
- no mutable difficulty in `PuzzleSession`
- no V1 completion parser/export
- `completionRequestFromSeal` owns V2 projection
- run replay equality includes hint/wrong-attempt facts
- no public `GET /api/puzzles` catalog list
- web/mobile/admin all browse families
- family reaper/deletion owns shared assets and fences all three variants
- every repeated Workflow step name includes difficulty
- Profile Puzzle Results still exists at family+difficulty grain
- server save prefix v2 and Quick `q-*` prefix coexist
- admin CLI Access protects `/api/admin/puzzle-families`
- migration does not delete old source objects before replacement verification
- no second DO, child workflow, score ledger, achievement engine, generic ranking API, or legacy difficulty was introduced.

Commit: `test: cover family difficulty progression cutover`

---

## PR Completion Gate

This remains one cohesive implementation PR. Family identity is required to define difficulty, shared-asset ownership, and deletion correctly; variant identity is required for saves/downloads/completions; those identities in turn define progression and leaderboard keys. Splitting the cutover would require temporary catalog/completion compatibility paths that this pre-release project deliberately avoids.

Before marking the PR ready, all eleven tasks must be complete and the full gate above must pass.