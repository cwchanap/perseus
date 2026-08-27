# Puzzle Difficulty, Achievements, and Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace standalone server puzzles with three-tier puzzle families, add idempotent completion progression/mastery, and expose per-puzzle plus overall leaderboards without changing the core fixed-board gameplay model.

**Architecture:** Keep `PuzzleSession` variant-oriented. Add a player-facing family read model above three concrete variant puzzle IDs, generate all variants in one Cloudflare Workflow, and extend the existing completion transaction/executor so first-clear progression, best times, mastery, and achievements share the current run-ID idempotency boundary. D1 owns queryable ownership/progression; KV/DO remains authoritative for live family/variant metadata; R2 stores one family original/thumbnail and variant piece assets.

**Tech Stack:** TypeScript, SvelteKit/Svelte 5, Cloudflare Workers + Workflows + Durable Objects + KV + R2 + D1, Drizzle ORM, Vitest, Playwright, Bun/Turbo.

**Spec:** `docs/superpowers/specs/2026-08-26-puzzle-difficulty-achievements-leaderboards-design.md`

## Global Constraints

- Deliver this entire feature in **one PR**. Tasks below are review/commit checkpoints inside that PR, not separate PRs.
- Server difficulties are fixed and code-owned: Easy/Normal/Hard are `16/49/100` pieces for `1:1` and `12/48/108` for `4:3` / `3:4`.
- Difficulty is piece count only. Timed/relaxed, rotation, hints, and reference modes remain independent.
- Keep `PuzzleSession` keyed by one concrete variant puzzle ID. Do not add mutable difficulty state to `@perseus/game-core`.
- Generate all three variants eagerly in **one family Workflow**. Do not create one workflow per difficulty or a new coordinator service.
- Use the existing `PUZZLE_METADATA_DO` namespace for both family and variant strong-consistency writes. Do not add another DO binding.
- Completion scoring is award-once per family+difficulty: Easy `100`, Normal `200`, Hard `300`; replays score `0` completion points.
- Only `standard_timed` and `rotation_timed` enter competitive best-time tables. Assisted/relaxed runs still earn progression and factual mastery.
- Keep Standard and Rotation leaderboards separate for each difficulty.
- Initial mastery badges are `hintless`, `flawless`, `rotation_clear`; mastery never adds overall score.
- Initial achievements and point values are exactly those in the spec; use ordinary predicates/constants, not a rule DSL.
- Overall leaderboard order is score DESC, Hard DESC, Normal DESC, Easy DESC, scoreReachedAt ASC, playerId ASC.
- Puzzle leaderboard order is bestTimeSeconds ASC, achievedAt ASC, playerId ASC.
- Return top 50 plus the signed-in player's own row when outside the top 50. Never expose email in leaderboard projections.
- Keep Local Quick Puzzles outside families/progression/leaderboards and retain their arbitrary piece-count UI.
- **Spec clarification:** the server save namespace changes to `puzzle-progress-v2-<variantId>`, but Quick Puzzle IDs (`q-*`) keep their existing `puzzle-progress-<q-id>` keys so this breaking server migration does not discard local Quick Puzzle progress.
- No runtime backward-compatibility branches for old server puzzle metadata, old server save keys, or old completion history.
- Preserve the existing retained-run quota policy and reset `player_completion_usage` with the destructive completion-history migration.

---

## File/Module Map

- `packages/types/src/grid.ts` — fixed difficulty piece-count mapping and grid helper.
- `packages/types/src/progression.ts` — family/variant/progression/leaderboard public contracts and V2 completion request/response.
- `packages/shared/src/schema.ts` + `packages/shared/drizzle/0005_puzzle_families_progression.sql` — clean D1 family/progression schema.
- `packages/shared/src/progression.ts` — fixed achievement catalog, completion-point helper, factual mastery helper.
- `packages/shared/src/completion-writes.ts` + `packages/shared/src/drivers/{d1,bun}.ts` — transactional completion/progression write boundary.
- `packages/shared/src/repositories.ts` — family ownership/profile/leaderboard query functions.
- `apps/workflows/src/index.ts` — generalized metadata DO plus one family generation workflow.
- `apps/api/src/services/storage.worker.ts` — family/variant KV + R2 storage helpers and gallery family index.
- `apps/api/src/routes/puzzle-families.worker.ts` — family listing/create/detail/thumbnail/per-family leaderboard.
- `apps/api/src/routes/puzzles.worker.ts` — concrete variant details/pieces/reference only.
- `apps/api/src/routes/puzzles.complete.*` — V2 completion submission and progression delta response.
- `apps/api/src/routes/leaderboard.worker.ts` — overall leaderboard.
- `apps/api/src/routes/player.worker.ts` — profile progression summary/achievement/mastery data.
- `scripts/export-legacy-puzzles.ts` + `scripts/import-puzzle-families.ts` — one-shot operator migration with no runtime legacy branch.
- `apps/web/src/routes/+page.svelte` + `PuzzleCard.svelte` — one family card with difficulty selection.
- `apps/web/src/routes/leaderboard/+page.svelte` — overall leaderboard.
- `apps/web/src/lib/components/PuzzleLeaderboardDialog.svelte` — per-family difficulty/mode board.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` + `PuzzleCompletionDialog.svelte` — V2 submission and completion-earned feedback.
- `apps/web/src/routes/profile/+page.svelte` — score/rank/completion/achievement/mastery summary.

---

### Task 1: Add fixed difficulty, family, progression, and V2 completion contracts

**Files:**
- Create: `packages/types/src/progression.ts`
- Modify: `packages/types/src/grid.ts`
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/src/grid.test.ts`
- Test: `packages/types/src/index.test.ts`

**Interfaces:**
- Produces: `PuzzleDifficulty`, `PUZZLE_DIFFICULTIES`, `DIFFICULTY_PIECE_COUNTS`, `getDifficultyPieceCount(aspectRatio, difficulty)`.
- Produces: `PuzzleFamilyMetadata`, `PuzzleFamilySummary`, `PuzzleVariantSummary`, `MasteryBadge`, `AchievementId`.
- Produces: `RecordPuzzleCompletionV2`, `RecordPuzzleCompletionResponseV2`, `PuzzleLeaderboardResponse`, `OverallLeaderboardResponse`, `PlayerProgressionSummary`.
- Removes the V1 completion request as the active public contract; this is a deliberate breaking change.

- [ ] **Step 1: Write failing difficulty/grid tests**

Add exact expectations for all nine aspect-ratio/difficulty combinations and assert each value passes `isValidPieceCountForAspectRatio`:

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

- [ ] **Step 2: Write failing V2/family validation tests**

Cover a valid timed V2 completion, a valid relaxed completion with null time, rejection of missing `hintsUsed` / `incorrectAttempts`, and family metadata with exactly one ID per difficulty:

```ts
expect(
  isRecordPuzzleCompletionV2({
    version: 2,
    runId,
    resultClass: 'standard_timed',
    elapsedActiveSeconds: 42,
    hintsUsed: 0,
    incorrectAttempts: 1
  }, MAX_COMPLETION_TIME_SECONDS)
).toBe(true);
```

- [ ] **Step 3: Run the type package tests and confirm RED**

Run: `bun --cwd packages/types run test:unit`

Expected: FAIL because the new difficulty/family/V2 symbols do not exist yet.

- [ ] **Step 4: Implement the shared contracts**

Put fixed grid rules in `grid.ts` and player/progression contracts in the new focused module:

```ts
export const PUZZLE_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PuzzleDifficulty = (typeof PUZZLE_DIFFICULTIES)[number];

export const DIFFICULTY_PIECE_COUNTS = {
  easy: { '1:1': 16, '4:3': 12, '3:4': 12 },
  normal: { '1:1': 49, '4:3': 48, '3:4': 48 },
  hard: { '1:1': 100, '4:3': 108, '3:4': 108 }
} as const satisfies Record<PuzzleDifficulty, Record<PuzzleAspectRatio, number>>;

export function getDifficultyPieceCount(
  aspectRatio: PuzzleAspectRatio,
  difficulty: PuzzleDifficulty
): number {
  return DIFFICULTY_PIECE_COUNTS[difficulty][aspectRatio];
}
```

Define family metadata with immutable `variants: Record<PuzzleDifficulty, string>` and define V2 with exactly `version`, `runId`, `resultClass`, `elapsedActiveSeconds`, `hintsUsed`, `incorrectAttempts`.

- [ ] **Step 5: Run tests/check and commit**

Run:
- `bun --cwd packages/types run test:unit`
- `bun --cwd packages/types run build`

Commit: `feat(types): add puzzle family progression contracts`

---

### Task 2: Replace the D1 standalone-puzzle stats schema with family/progression tables

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/drizzle/0005_puzzle_families_progression.sql`
- Create: `packages/shared/drizzle/meta/0005_snapshot.json`
- Modify: `packages/shared/drizzle/meta/_journal.json`
- Test: `packages/shared/src/__tests__/schema.test.ts`

**Interfaces:**
- Produces Drizzle tables: `puzzleFamilies`, `puzzleVariants`, `puzzleCompletionRuns`, `puzzleBestTimes`, `playerDifficultyCompletions`, `playerAchievements`, `playerVariantMastery`.
- Retains infrastructure tables: `playerProfiles`, `puzzleDeletionTombstones`, `playerCompletionUsage`.
- Removes `puzzles` and `puzzleStats` from the new schema.

- [ ] **Step 1: Write schema tests for required keys/checks/indexes**

Pin the important invariants rather than snapshotting every SQL detail:

```ts
expect(puzzleVariants).toBeDefined();
expect(playerDifficultyCompletions).toBeDefined();
expect(puzzleBestTimes).toBeDefined();
expect(playerAchievements).toBeDefined();
expect(playerVariantMastery).toBeDefined();
```

The migration test/inspection must also pin:
- unique `(family_id, difficulty)`
- competitive best-time PK `(player_id, puzzle_id, result_class)`
- ranking index `(puzzle_id, result_class, best_time_seconds, achieved_at)`
- mastery PK `(player_id, puzzle_id, badge)`
- achievement PK `(player_id, achievement_id)`
- retained-run counter reset.

- [ ] **Step 2: Run shared schema tests and confirm RED**

Run: `bun --cwd packages/shared run test:unit -- src/__tests__/schema.test.ts`

Expected: FAIL because the family/progression tables do not exist.

- [ ] **Step 3: Implement the Drizzle schema**

Use explicit text CHECK constraints for the closed unions:

```ts
sql`${t.difficulty} IN ('easy', 'normal', 'hard')`
sql`${t.resultClass} IN ('standard_timed', 'rotation_timed')`
sql`${t.badge} IN ('hintless', 'flawless', 'rotation_clear')`
```

Keep `puzzle_completion_runs` replay-inclusive and add `hints_used` and `incorrect_attempts` non-null integers.

- [ ] **Step 4: Write the destructive migration**

`0005_puzzle_families_progression.sql` must deliberately reset old puzzle progression:

```sql
DROP TABLE IF EXISTS puzzle_stats;
DROP TABLE IF EXISTS puzzle_completion_runs;
DELETE FROM player_completion_usage;
DROP TABLE IF EXISTS puzzles;
```

Then create the new family/variant/progression tables plus the revised `puzzle_completion_runs`. Preserve `player_profiles`; preserve the deletion-fence table and quota table definition.

Update Drizzle journal/snapshot metadata in the same change.

- [ ] **Step 5: Run shared tests/check and commit**

Run:
- `bun --cwd packages/shared run test:unit -- src/__tests__/schema.test.ts`
- `bun --cwd packages/shared run check`

Commit: `feat(db): add puzzle family progression schema`

---

### Task 3: Extend the existing completion executor with scoring, mastery, achievements, and leaderboard queries

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
- Consumes trusted server-resolved `familyId` and `difficulty` with V2 completion facts.
- Produces `CompletionProgressionDelta` containing `firstDifficultyCompletion`, `newAchievementIds`, `newMasteryBadges`, and competitive personal-best facts.
- Produces `listPuzzleLeaderboard(...)`, `listOverallLeaderboard(...)`, and `getPlayerProgressionSummary(...)` repository queries.

- [ ] **Step 1: Write fixed-catalog scoring/mastery tests**

Create the catalog as code constants, with the exact nine IDs/points from the spec. Pin the simple helpers:

```ts
expect(completionPointsForDifficulty('easy')).toBe(100);
expect(completionPointsForDifficulty('normal')).toBe(200);
expect(completionPointsForDifficulty('hard')).toBe(300);
expect(masteryForCompletion({ hintsUsed: 0, incorrectAttempts: 0, resultClass: 'rotation_timed' }))
  .toEqual(['hintless', 'flawless', 'rotation_clear']);
```

- [ ] **Step 2: Write executor/repository RED tests**

Cover these transaction-level cases in both in-memory/Bun and D1-backed suites:
- first family+difficulty completion inserts once; retry/replay does not score twice
- standard timed updates only Standard PB
- rotation timed updates only Rotation PB
- assisted/relaxed create no `puzzle_best_times`
- worse replay keeps the old PB/achievedAt
- better replay replaces PB/achievedAt
- Hintless/Flawless/Rotation Clear mastery inserts are idempotent
- achievements unlock exactly at 1/5/15 unique clears, one full set, 1/5 Hard clears, and first mastery of each type
- run-ID exact replay remains `replayed`; same run ID with changed V2 facts is `conflict`
- quota remains capped by `MAX_RETAINED_COMPLETION_RUNS`.

- [ ] **Step 3: Run shared progression tests and confirm RED**

Run: `bun --cwd packages/shared run test:unit`

Expected: FAIL on missing progression tables/helpers and old V1 write shape.

- [ ] **Step 4: Extend `CompletionWriteExecutor.write()` as the single atomic write boundary**

Use one trusted input shape:

```ts
export interface VersionedCompletionWrite {
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

The transaction must:
1. enforce tombstone + retained-run quota
2. insert/find the run and preserve conflict semantics
3. on a newly inserted run only, upsert first-clear, PB, mastery, and achievement rows
4. return the durable delta; an exact replay returns no duplicate unlock delta.

Do not add a second `ProgressionService` transaction beside the existing executor.

- [ ] **Step 5: Add leaderboard/profile queries**

Implement narrow repository functions with exact ordering:

```ts
listPuzzleLeaderboard(db, { puzzleId, resultClass, playerId?, limit: 50 })
listOverallLeaderboard(db, { playerId?, limit: 50 })
getPlayerProgressionSummary(db, playerId)
```

Overall score should be a SQL aggregate over difficulty clears plus achievement constants. Derive `scoreReachedAt` from the latest contributing first-clear/achievement timestamp instead of storing a mutable score row.

- [ ] **Step 6: Run shared tests/check and commit**

Run:
- `bun --cwd packages/shared run test:unit`
- `bun --cwd packages/shared run check`

Commit: `feat(shared): add completion progression and ranking queries`

---

### Task 4: Add family metadata/storage and generate all three variants in one Workflow

**Files:**
- Modify: `apps/workflows/src/types.ts`
- Modify: `apps/workflows/src/helpers.ts`
- Modify: `apps/workflows/src/index.ts`
- Test: `apps/workflows/src/types.test.ts`
- Test: `apps/workflows/src/helpers.test.ts`
- Test: `apps/workflows/src/index.test.ts`
- Test: `apps/workflows/src/puzzle-metadata-do.test.ts`
- Modify: `apps/api/src/services/storage.worker.ts`
- Test: `apps/api/src/__tests__/worker.test.ts`

**Interfaces:**
- Consumes `WorkflowParams { familyId: string }`.
- Produces authoritative family metadata addressed by family ID and variant metadata addressed by variant ID through the existing `PUZZLE_METADATA_DO` namespace.
- Produces R2 keys `families/<familyId>/original`, `families/<familyId>/thumbnail.jpg`, and `puzzles/<variantId>/pieces/<pieceId>.png`.

- [ ] **Step 1: Write DO/storage tests for family vs variant entities**

Pin separate entity identity while reusing the same DO class:

```ts
await putFamilyMetadata(familyId, family);
await putVariantMetadata(variantId, variant);
expect(await getFamily(...)).toMatchObject({ id: familyId, status: 'processing' });
expect(await getPuzzle(...)).toMatchObject({ id: variantId, familyId, difficulty: 'easy' });
```

Also pin gallery indexing to `family:*` keys only, so three variants never become three gallery cards.

- [ ] **Step 2: Write workflow RED tests for stable three-variant generation**

One workflow event must:
- reuse the three variant IDs already stored in family metadata
- generate the approved Easy/Normal/Hard counts for the family aspect ratio
- write one thumbnail under the family key
- mark family ready only after all three variant metadata records are ready
- mark family failed when a variant reaches terminal failure
- keep successful variant assets on a sibling failure.

- [ ] **Step 3: Run workflow/API storage tests and confirm RED**

Run:
- `bun --cwd apps/workflows run test:unit`
- `bun --cwd apps/api run test:unit -- src/__tests__/worker.test.ts`

- [ ] **Step 4: Generalize metadata DO without adding another namespace**

Use an entity discriminator in stored metadata/update payloads:

```ts
type MetadataEntity =
  | { kind: 'family'; metadata: PuzzleFamilyMetadata }
  | { kind: 'variant'; metadata: PuzzleMetadata };
```

Keep idempotency reservation behavior separate from entity mutation behavior; reservations still map an upload idempotency key to the family ID.

- [ ] **Step 5: Change storage/R2 helpers to family ownership**

Add focused helpers:

```ts
getFamilyOriginalKey(familyId)
getFamilyThumbnailKey(familyId)
getPieceKey(variantId, pieceId)
getFamily(kv, familyId)
listPuzzleFamiliesPage(kv, params)
```

Variant `reference` resolution must read variant metadata, then serve `getFamilyOriginalKey(variant.familyId)`.

- [ ] **Step 6: Rewrite the Workflow loop over fixed difficulties**

Keep one workflow and reuse existing generation helpers:

```ts
for (const difficulty of PUZZLE_DIFFICULTIES) {
  const variantId = family.variants[difficulty];
  const pieceCount = getDifficultyPieceCount(family.aspectRatio, difficulty);
  await generateVariant({ variantId, familyId, difficulty, pieceCount, image });
}
```

Generate the thumbnail once before/around the loop, then commit family `ready` only after the three variant finalizations succeed.

- [ ] **Step 7: Run workflow/API tests/check and commit**

Run:
- `bun --cwd apps/workflows run test:unit`
- `bun --cwd apps/workflows run check`
- `bun --cwd apps/api run test:unit`
- `bun --cwd apps/api run check`

Commit: `feat(workflow): generate puzzle families with three variants`

---

### Task 5: Replace server upload/list APIs with family APIs and expose completion/leaderboard/profile endpoints

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
- Modify: `apps/api/src/services/storage.worker.ts`

**Interfaces:**
- Produces `GET/POST /api/puzzle-families`, `GET /api/puzzle-families/:familyId`, family thumbnail, and per-family leaderboard.
- Keeps `GET /api/puzzles/:variantId`, piece/reference routes, and `POST /api/puzzles/:variantId/complete` variant-oriented.
- Produces `GET /api/leaderboard` and progression-rich profile reads.

- [ ] **Step 1: Write family-create/list/detail RED tests**

The create request accepts only `name`, optional `category`, `aspectRatio`, and `image`. Assert `pieceCount` is ignored/rejected rather than used as server difficulty authority.

A successful create must allocate exactly four UUIDs: one family + three stable variants, store one original, insert one family ownership row + three variant rows, and start workflow with `{ familyId }`.

- [ ] **Step 2: Write V2 completion/progression response RED tests**

Update parser tests to reject V1 and accept V2. Resolve `variantId -> { familyId, difficulty }` server-side before calling `recordVersionedCompletion`.

Pin a response shape like:

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

For exact replay, `ok: true` remains idempotent and the durable state does not duplicate awards; transient unlock animations need not be recreated.

- [ ] **Step 3: Write leaderboard/profile RED tests**

Per-family endpoint validates `difficulty` and `mode=standard|rotation`, resolves the variant, and returns top 50 + optional `me`. Overall endpoint uses the specified tie-break order. Profile summary changes semantics to families uploaded/families solved and adds score/rank/difficulty counts/achievement/mastery data.

Assert leaderboard player projections contain only `id`, `name`, `avatarUrl`; never email.

- [ ] **Step 4: Implement family routes and reduce `puzzles.worker.ts` to concrete gameplay reads**

Move gallery list/create concerns out of `puzzles.worker.ts`; keep concrete variant detail/piece/reference routes there. Register the new family router in `worker.ts`.

Update admin create/delete paths to operate on a family and all three variants; reuse the existing deletion fence/reaper sequence rather than adding a second cleanup protocol.

- [ ] **Step 5: Implement completion/leaderboard/profile handlers**

Map shared repository/executor outcomes to HTTP once. Do not calculate points in route code; route code should project the shared progression delta and query results.

- [ ] **Step 6: Run API tests/check and commit**

Run:
- `bun --cwd apps/api run test:unit`
- `bun --cwd apps/api run check`
- `bun --cwd apps/api run lint`

Commit: `feat(api): expose puzzle family progression APIs`

---

### Task 6: Update seed/upload tooling and add the one-shot destructive content migration

**Files:**
- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`
- Create: `scripts/export-legacy-puzzles.ts`
- Create: `scripts/import-puzzle-families.ts`
- Create: `scripts/puzzle-family-migration.test.ts`
- Modify: `.gitignore`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`

**Interfaces:**
- Seed/admin upload sends image/name/category/aspect ratio only.
- Migration export writes a local ignored manifest + original image files before the breaking deployment.
- Migration import uploads those originals through the new family API after deployment; no runtime legacy parser remains.

- [ ] **Step 1: Write tooling RED tests**

Change startup catalog validation so `pieceCount` is no longer required and is rejected as stale content metadata. Pin request `FormData` to omit `pieceCount`.

For migration, use an ignored directory such as `.migration/puzzle-families/` and manifest shape:

```ts
interface LegacyPuzzleExport {
  oldPuzzleId: string;
  name: string;
  category?: string;
  aspectRatio: PuzzleAspectRatio;
  ownerId: string;
  imageFile: string;
}
```

- [ ] **Step 2: Implement pre-deploy export**

`export-legacy-puzzles.ts` runs against the old deployment before merge/deploy:
1. obtain admin credentials using the existing startup auth helpers
2. enumerate legacy server puzzles and current D1 ownership
3. download each retained `/api/puzzles/:id/reference`
4. write manifest + original bytes under `.migration/puzzle-families/`
5. fail non-zero if any ready puzzle cannot be exported.

Do not delete production data during export.

- [ ] **Step 3: Implement post-deploy import**

`import-puzzle-families.ts` reads the manifest, posts each original to the new family/admin create endpoint, waits/polls the family status endpoint until `ready` or `failed`, and restores preserved ownership through the existing operator/D1 path documented in the runbook. It does not attempt to restore old completion history.

- [ ] **Step 4: Document deployment order**

Add an explicit runbook sequence:

```text
1. run legacy export against current production
2. verify manifest/image count
3. deploy D1 migration + new API/workflow/web
4. run family import
5. verify every imported family has 3 ready variants
6. delete/archive exported local migration files
```

The D1 migration clears old completion/quota stats by design.

- [ ] **Step 5: Run script tests/check and commit**

Run:
- `bun run test:scripts`
- `bun run check:scripts`
- `bun run lint:scripts`

Commit: `feat(scripts): migrate legacy puzzles into families`

---

### Task 7: Change web gallery/upload/session plumbing to family + difficulty UX

**Files:**
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleCard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`
- Create: `apps/web/src/lib/components/PuzzleDifficultyPicker.svelte`
- Create: `apps/web/src/lib/components/__tests__/PuzzleDifficultyPicker.svelte.test.ts`
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.spec.ts`
- Modify: `apps/web/src/routes/upload/+page.svelte`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`

**Interfaces:**
- Consumes family summaries/details from Task 5.
- Produces one gallery card per family with three difficulty buttons resolving to `/puzzle/<variantId>`.
- Server save keys use v2; Quick Puzzle keys remain unchanged.

- [ ] **Step 1: Write API + difficulty-picker RED tests**

Pin family list/detail decoding and picker labels such as `Easy · 16 pieces`, `Normal · 49 pieces`, `Hard · 100 pieces` (aspect-aware counts for non-square families).

`PuzzleCard` must not render three separate cards or duplicate family metadata.

- [ ] **Step 2: Write save-key RED tests including the Quick Puzzle exception**

Pin exact keys:

```ts
expect(progressKeyForTest(serverUuid)).toBe(`puzzle-progress-v2-${serverUuid}`);
expect(progressKeyForTest('q-123')).toBe('puzzle-progress-q-123');
```

Candidate enumeration must scan both prefixes, but old server `puzzle-progress-<uuid>` records are intentionally ignored.

- [ ] **Step 3: Run targeted web unit tests and confirm RED**

Run: `bun --cwd apps/web run test:unit -- src/lib/components/__tests__/PuzzleCard.svelte.test.ts src/lib/services/gameplay/session/persistence.test.ts`

- [ ] **Step 4: Implement family gallery + upload changes**

Change root gallery state/API calls to family summaries. Add the compact difficulty picker to the existing card rather than introducing a new family-page framework.

Remove server `pieceCount` state/select/validation from `routes/upload/+page.svelte`; keep `QuickPuzzleUploader.svelte` unchanged.

- [ ] **Step 5: Implement server-only save namespace reset**

Keep the portable `@perseus/game-core` adapter untouched. Change only the web key mapping:

```ts
const SERVER_PROGRESS_KEY_PREFIX = 'puzzle-progress-v2-';
const QUICK_PROGRESS_KEY_PREFIX = 'puzzle-progress-';

function progressKey(puzzleId: string): string {
  return puzzleId.startsWith('q-')
    ? `${QUICK_PROGRESS_KEY_PREFIX}${puzzleId}`
    : `${SERVER_PROGRESS_KEY_PREFIX}${puzzleId}`;
}
```

Enumeration accepts new server keys and existing `q-*` quick keys only.

- [ ] **Step 6: Run web unit/check and commit**

Run:
- `bun --cwd apps/web run test:unit`
- `bun --cwd apps/web run check`

Commit: `feat(web): add puzzle family difficulty selection`

---

### Task 8: Add completion-earned feedback, per-family boards, overall leaderboard, and profile progression

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
- Consumes V2 completion progression delta, family leaderboard response, overall leaderboard response, profile progression summary.
- Produces the top-level `Leaderboard` navigation entry, an overall board, and a per-family dialog with difficulty + Standard/Rotation selectors.

- [ ] **Step 1: Write completion-dialog RED tests**

Cover:
- `+200 First Normal Clear`
- newly unlocked achievement with points
- newly earned mastery badges
- PB + rank for competitive runs
- non-PB shows best time + this-run time
- submission failure still leaves the local completion dialog usable.

The route sends exactly the V2 completion facts already available from `sealedCompletion`:

```ts
{
  version: 2,
  runId: seal.runId,
  resultClass: seal.resultClass,
  elapsedActiveSeconds: seal.elapsedActiveSeconds,
  hintsUsed: seal.hintsUsed,
  incorrectAttempts: seal.incorrectAttempts
}
```

- [ ] **Step 2: Write leaderboard/profile RED tests**

Puzzle dialog:
- defaults to the selected/current family difficulty and Standard
- toggles Standard/Rotation without mixing rows
- renders top 50 and separate `YOU · #N` row when needed.

Overall page:
- renders score and E/N/H counts
- uses avatar or initials
- never renders email.

Profile:
- renders score/rank, E/N/H unique counts, achievement count/progress, mastery count
- keeps existing editable private name/avatar/email behavior.

- [ ] **Step 3: Run targeted web tests and confirm RED**

Run: `bun --cwd apps/web run test:unit -- src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts src/routes/profile/page.svelte.test.ts`

- [ ] **Step 4: Implement completion and leaderboard UI using existing component patterns**

Use the existing modal focus/action style for `PuzzleLeaderboardDialog`; do not extract a generic dialog framework. Add `Leaderboard` beside Gallery/Profile in existing navigation.

Keep family board controls to two compact selectors: Easy/Normal/Hard and Standard/Rotation.

- [ ] **Step 5: Implement profile progression summary**

Extend the current profile page rather than creating a separate achievements route. Show score/rank + counts first; render the fixed achievement list/mastery progress below existing identity summary.

- [ ] **Step 6: Run web unit/check/lint and commit**

Run:
- `bun --cwd apps/web run test:unit`
- `bun --cwd apps/web run check`
- `bun --cwd apps/web run lint`

Commit: `feat(web): add achievements and leaderboards`

---

### Task 9: Add end-to-end coverage and run the full single-PR verification gate

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/progression-leaderboard.spec.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/catalog.ts`
- Modify: `apps/api/src/__tests__/worker-extra.worker.test.ts` if route registration coverage requires it
- Modify: `docs/superpowers/plans/2026-08-26-puzzle-difficulty-achievements-leaderboards.md` only if execution discovers an actual plan correction; do not turn it into an implementation diary.

**Interfaces:**
- Validates the whole user path without adding new production seams beyond the existing E2E harness.

- [ ] **Step 1: Update deterministic fixtures to family + variants**

A fixture family must provide stable IDs for all three difficulties and the approved counts. Keep the gameplay page object variant-oriented once navigation reaches `/puzzle/<variantId>`.

- [ ] **Step 2: Add the critical E2E path**

Cover one authenticated flow:

```text
gallery shows one family
 -> choose Easy
 -> complete eligible timed run
 -> completion dialog shows first-clear/progression delta
 -> open family leaderboard and see player's Standard row
 -> open overall leaderboard and see score
 -> profile reflects Easy completion + achievement/mastery totals
```

Add a separate assertion that choosing Normal navigates to a different variant ID/piece count, proving difficulty is not mutable state inside one session.

- [ ] **Step 3: Add Quick Puzzle regression coverage**

Reuse existing Quick Puzzle E2E/unit coverage to assert custom piece-count selection and local resume behavior still work and no leaderboard/progression UI appears for `q-*` puzzles.

- [ ] **Step 4: Run the focused E2E suite**

Run:
- `bun --cwd apps/web run test:e2e -- gallery.spec.ts progression-leaderboard.spec.ts`
- `bun --cwd apps/web run test:e2e:smoke`

Expected: PASS on desktop/mobile smoke where the existing harness supports these flows.

- [ ] **Step 5: Run the full repository gate**

Run from repo root:

```bash
bun run check
bun run lint
bun run test:unit
bun run test:scripts
bun run check:scripts
bun run test:e2e
```

Also run build validation:

```bash
bun run build
bun --cwd apps/web run test:e2e:assert-production-bundle
```

- [ ] **Step 6: Review the final diff against the spec and commit**

Verify explicitly:
- no V1 completion compatibility path remains
- no old server save-prefix enumeration remains
- Quick `q-*` save keys still work
- no generic ranking/achievement framework was introduced
- only one family workflow is created per server upload
- all leaderboard queries use the approved tie-break order
- emails are absent from leaderboard response types and render paths
- migration reset includes `player_completion_usage`.

Commit: `test: cover puzzle progression and leaderboards`

---

## PR Completion Gate

Before marking the PR ready for review, the implementation must satisfy all nine tasks in this document and the approved design spec. The expected PR is intentionally broad but cohesive: family identity is the prerequisite for difficulty, and difficulty identity is the prerequisite for correct progression and leaderboards, so splitting these into separately mergeable PRs would create temporary compatibility architecture that this pre-release project does not need.
