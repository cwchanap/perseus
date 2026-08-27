# Puzzle Difficulty, Achievements, and Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace standalone server puzzles with three-tier puzzle families, add idempotent achievements/mastery/progression, and expose per-puzzle plus overall leaderboards while keeping `PuzzleSession` a fixed-board engine.

**Architecture:** A player-facing family owns one image and three concrete variant puzzle IDs. One Cloudflare Workflow eagerly generates all variants; the existing completion executor becomes the single transaction boundary for run retention, first-clear points, competitive best times, mastery, and achievements. D1 owns queryable ownership/progression, KV/DO owns live family/variant metadata, and R2 stores one family original/thumbnail plus variant piece assets.

**Tech Stack:** TypeScript, SvelteKit/Svelte 5, Cloudflare Workers/Workflows/Durable Objects/KV/R2/D1, Drizzle ORM, Vitest, Playwright, Bun/Turbo.

**Spec:** `docs/superpowers/specs/2026-08-26-puzzle-difficulty-achievements-leaderboards-design.md`

## Global Constraints

- Implement this feature in **one PR**. Task commits below stay on the same branch/PR.
- Fixed server difficulties: `1:1` = Easy 16, Normal 49, Hard 100; `4:3` and `3:4` = Easy 12, Normal 48, Hard 108.
- Difficulty is piece count only; rotation, hints, references, and timed/relaxed modes remain independent.
- `PuzzleSession` remains keyed by one concrete variant ID. Do not add mutable difficulty to `@perseus/game-core`.
- Generate all three variants eagerly in one family Workflow. Do not create three child workflows or a coordinator service.
- Reuse the existing `PUZZLE_METADATA_DO` binding for family and variant strong-consistency writes.
- Completion points are award-once per family+difficulty: Easy 100, Normal 200, Hard 300. Replays award zero completion points.
- Competitive best times exist only for `standard_timed` and `rotation_timed`, on separate boards.
- Assisted/relaxed completions still earn first-clear progression and factual Hintless/Flawless mastery.
- Mastery badges are exactly `hintless`, `flawless`, `rotation_clear` and are non-scoring.
- Achievement IDs/requirements/points are exactly the nine entries in the spec; implement predicates directly, not through a rule engine.
- Puzzle board order: time ASC, achievedAt ASC, playerId ASC.
- Overall board order: score DESC, Hard DESC, Normal DESC, Easy DESC, scoreReachedAt ASC, playerId ASC.
- Leaderboard responses return top 50 plus the signed-in player's row when outside the top 50; never expose email.
- Quick Puzzles remain local, arbitrary-piece-count, and outside account progression/leaderboards.
- **Save-key clarification:** new server variants use `puzzle-progress-v2-<variantId>`. Quick Puzzle IDs (`q-*`) continue using `puzzle-progress-<q-id>`, so the server breaking reset does not discard Quick Puzzle progress.
- No runtime compatibility branch for old server metadata, old server save keys, or V1 completion payloads.
- Preserve the existing retained-run quota policy and reset `player_completion_usage` with old completion history.

---

## Task 1: Add fixed difficulty, family, leaderboard, and V2 completion contracts

**Files:**
- Create: `packages/types/src/progression.ts`
- Modify: `packages/types/src/grid.ts`
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/src/grid.test.ts`
- Test: `packages/types/src/index.test.ts`

**Interfaces:**
- Produces `PuzzleDifficulty`, `PUZZLE_DIFFICULTIES`, `DIFFICULTY_PIECE_COUNTS`, `getDifficultyPieceCount()`.
- Produces `PuzzleFamilyMetadata`, `PuzzleFamilySummary`, `PuzzleVariantSummary`.
- Produces `AchievementId`, `MasteryBadge`, `CompletionProgressionDelta`, `PlayerProgressionSummary`.
- Produces `RecordPuzzleCompletionV2`, `RecordPuzzleCompletionResponseV2`, `PuzzleLeaderboardResponse`, `OverallLeaderboardResponse`.

- [ ] **Step 1: Write failing fixed-grid tests**

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

For every value, also assert `isValidPieceCountForAspectRatio(count, ratio) === true`.

- [ ] **Step 2: Write failing family/V2 contract tests**

Pin exact V2 fields and reject V1/missing mastery facts:

```ts
expect(isRecordPuzzleCompletionV2({
  version: 2,
  runId,
  resultClass: 'standard_timed',
  elapsedActiveSeconds: 42,
  hintsUsed: 0,
  incorrectAttempts: 1
}, MAX_COMPLETION_TIME_SECONDS)).toBe(true);
```

Define the response delta explicitly:

```ts
export interface CompletionProgressionDelta {
  firstDifficultyCompletion: boolean;
  completionPointsAwarded: number;
  newAchievementIds: AchievementId[];
  newMasteryBadges: MasteryBadge[];
  competitive: null | {
    personalBest: boolean;
    bestTimeSeconds: number;
    rank: number | null;
  };
}
```

- [ ] **Step 3: Run RED**

Run: `bun --cwd packages/types run test:unit`

Expected: FAIL on missing symbols/validators.

- [ ] **Step 4: Implement contracts**

In `grid.ts`:

```ts
export const PUZZLE_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PuzzleDifficulty = (typeof PUZZLE_DIFFICULTIES)[number];

export const DIFFICULTY_PIECE_COUNTS = {
  easy: { '1:1': 16, '4:3': 12, '3:4': 12 },
  normal: { '1:1': 49, '4:3': 48, '3:4': 48 },
  hard: { '1:1': 100, '4:3': 108, '3:4': 108 }
} as const satisfies Record<PuzzleDifficulty, Record<PuzzleAspectRatio, number>>;
```

In `progression.ts`, define family/variant summaries, public leaderboard player projection `{ id, name, avatarUrl }`, leaderboard rows, progression summary, and the V2 completion request/response. Delete V1 as the active exported request contract rather than adding compatibility parsing.

- [ ] **Step 5: Verify and commit**

Run:
- `bun --cwd packages/types run test:unit`
- `bun --cwd packages/types run build`

Commit: `feat(types): add puzzle family progression contracts`

---

## Task 2: Replace the D1 standalone puzzle/stat schema with family/progression tables

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/drizzle/0005_puzzle_families_progression.sql`
- Create: `packages/shared/drizzle/meta/0005_snapshot.json`
- Modify: `packages/shared/drizzle/meta/_journal.json`
- Test: `packages/shared/src/__tests__/schema.test.ts`

**Interfaces:**
- Produces `puzzleFamilies`, `puzzleVariants`, revised `puzzleCompletionRuns`, `puzzleBestTimes`, `playerDifficultyCompletions`, `playerAchievements`, `playerVariantMastery`.
- Retains `playerProfiles`, `puzzleDeletionTombstones`, `playerCompletionUsage`.
- Removes new-code use of old `puzzles` and `puzzleStats` tables.

- [ ] **Step 1: Write failing schema tests**

Pin these invariants:

```ts
expect(puzzleFamilies).toBeDefined();
expect(puzzleVariants).toBeDefined();
expect(puzzleBestTimes).toBeDefined();
expect(playerDifficultyCompletions).toBeDefined();
expect(playerAchievements).toBeDefined();
expect(playerVariantMastery).toBeDefined();
```

Also inspect generated SQL for unique `(family_id, difficulty)`, competitive ranking index `(puzzle_id, result_class, best_time_seconds, achieved_at)`, and closed-union CHECK constraints.

- [ ] **Step 2: Run RED**

Run: `bun --cwd packages/shared run test:unit -- src/__tests__/schema.test.ts`

- [ ] **Step 3: Implement the Drizzle schema**

Use explicit checks:

```ts
sql`${t.difficulty} IN ('easy', 'normal', 'hard')`
sql`${t.badge} IN ('hintless', 'flawless', 'rotation_clear')`
```

`puzzle_completion_runs` keeps all four result classes and gains non-null `hints_used`/`incorrect_attempts`. `puzzle_best_times` allows only Standard/Rotation timed rows.

- [ ] **Step 4: Write the destructive migration**

`0005_puzzle_families_progression.sql` intentionally resets puzzle progression:

```sql
DROP TABLE IF EXISTS puzzle_stats;
DROP TABLE IF EXISTS puzzle_completion_runs;
DELETE FROM player_completion_usage;
DROP TABLE IF EXISTS puzzles;
```

Then create the new family/variant/progression tables and revised completion-run table. Preserve profiles, deletion fences, and the quota table definition.

- [ ] **Step 5: Verify and commit**

Run:
- `bun --cwd packages/shared run test:unit -- src/__tests__/schema.test.ts`
- `bun --cwd packages/shared run check`

Commit: `feat(db): add puzzle family progression schema`

---

## Task 3: Extend the existing completion executor with progression and ranking queries

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
- Consumes trusted `{ playerId, puzzleId, familyId, difficulty }` plus V2 completion facts.
- `CompletionWriteExecutor.write()` returns the existing recorded/replayed/conflict semantics plus a `CompletionProgressionDelta` for newly inserted runs.
- Produces `listPuzzleLeaderboard()`, `listOverallLeaderboard()`, `getPlayerProgressionSummary()`.

- [ ] **Step 1: Write fixed scoring/mastery tests**

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

Create the nine achievement definitions as a typed constant map; do not store them in D1.

- [ ] **Step 2: Write transaction-level RED tests**

Cover:
- first family+difficulty clear inserts/scored once
- exact run replay changes nothing; mutated facts under same run ID conflict
- Standard PB updates only Standard board
- Rotation PB updates only Rotation board
- assisted/relaxed never create best-time rows
- worse replay keeps PB + original `achievedAt`; better replay replaces both
- mastery insert is idempotent
- achievement boundaries at 1/5/15 unique clears, one full set, 1/5 Hard clears, first mastery of each type
- retained-run quota remains enforced.

- [ ] **Step 3: Run RED**

Run: `bun --cwd packages/shared run test:unit`

- [ ] **Step 4: Extend the existing executor, not a parallel service**

Use this trusted write input:

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

Within the existing backend-specific transaction/batch boundary:
1. enforce tombstone/quota
2. insert/find run and preserve run-ID conflict semantics
3. only for a newly inserted run, upsert first-clear, PB, mastery, achievements
4. return one durable delta; exact replay returns empty new-unlock arrays and zero new completion points.

- [ ] **Step 5: Add narrow ranking/profile queries**

```ts
listPuzzleLeaderboard(db, { puzzleId, resultClass, playerId, limit: 50 })
listOverallLeaderboard(db, { playerId, limit: 50 })
getPlayerProgressionSummary(db, playerId)
```

Use SQL ordering exactly from Global Constraints. Derive score from difficulty clears + achievement IDs via SQL CASE expressions; derive `scoreReachedAt` as the latest timestamp among currently contributing clears/achievements rather than storing a mutable score row.

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd packages/shared run test:unit`
- `bun --cwd packages/shared run check`

Commit: `feat(shared): add completion progression and rankings`

---

## Task 4: Add family metadata/storage and one three-variant Workflow

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
- Workflow input becomes `WorkflowParams { familyId: string }`.
- Storage helpers produce `createFamilyMetadata()`, `getFamily()`, `updateFamilyMetadata()`, `createPuzzleMetadata()`/`getPuzzle()` for variants, `listPuzzleFamiliesPage()`.
- R2 keys: `families/<familyId>/original`, `families/<familyId>/thumbnail.jpg`, `puzzles/<variantId>/pieces/<pieceId>.png`.

- [ ] **Step 1: Write family/variant metadata RED tests**

Assert family and variant entities use the same DO namespace but distinct IDs/kinds. Gallery index must scan `family:*`, never `puzzle:*`.

- [ ] **Step 2: Write Workflow RED tests**

One `{ familyId }` execution must:
- reuse the preallocated `family.variants.easy|normal|hard` IDs
- generate approved counts for the family aspect ratio
- create one family thumbnail
- finalize each variant independently
- set family `ready` only after all three ready
- set family `failed` on terminal sibling failure without deleting successful sibling assets.

- [ ] **Step 3: Run RED**

Run:
- `bun --cwd apps/workflows run test:unit`
- `bun --cwd apps/api run test:unit -- src/__tests__/worker.test.ts`

- [ ] **Step 4: Generalize `PuzzleMetadataDO` entity mutations**

Use one discriminator:

```ts
type MetadataEntity =
  | { kind: 'family'; metadata: PuzzleFamilyMetadata }
  | { kind: 'variant'; metadata: PuzzleMetadata };
```

Keep idempotency reservations keyed to family ID and separate from metadata entity writes.

- [ ] **Step 5: Move shared R2 assets to family scope**

Implement:

```ts
getFamilyOriginalKey(familyId: string)
getFamilyThumbnailKey(familyId: string)
getPieceKey(variantId: string, pieceId: number)
```

Variant reference reads variant metadata, then serves `getFamilyOriginalKey(variant.familyId)`.

- [ ] **Step 6: Generate variants in one loop**

```ts
for (const difficulty of PUZZLE_DIFFICULTIES) {
  const variantId = family.variants[difficulty];
  const pieceCount = getDifficultyPieceCount(family.aspectRatio, difficulty);
  await generateVariant({ familyId, variantId, difficulty, pieceCount, image });
}
```

Generate/decode the family original once where existing Photon ownership permits it; do not create three Workflows.

- [ ] **Step 7: Verify and commit**

Run:
- `bun --cwd apps/workflows run test:unit`
- `bun --cwd apps/workflows run check`
- `bun --cwd apps/api run test:unit`
- `bun --cwd apps/api run check`

Commit: `feat(workflow): generate three-tier puzzle families`

---

## Task 5: Expose family, V2 completion, leaderboard, and profile APIs

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
- Modify: `apps/api/src/__tests__/worker-extra.worker.test.ts`

**Interfaces:**
- Public/player family create accepts image/name/category/aspect ratio only.
- Admin family create additionally accepts optional `ownerId`; absent means current/system owner. This is the migration ownership-preservation seam and remains admin-only.
- Concrete gameplay stays under `/api/puzzles/:variantId` and `/complete`.
- Produces `/api/puzzle-families`, `/api/puzzle-families/:id`, `/api/puzzle-families/:id/leaderboard`, `/api/leaderboard`.

- [ ] **Step 1: Write family create/list/detail RED tests**

Successful create allocates four UUIDs (family + 3 variants), stores one original, inserts one `puzzle_families` row + three `puzzle_variants` rows, then starts the Workflow with `{ familyId }`. Public create must not accept piece count as authority.

- [ ] **Step 2: Write V2 completion RED tests**

Parser rejects V1 and accepts V2. Handler resolves `variantId -> familyId + difficulty` before calling the shared executor. Pin response:

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

Per-family board validates `difficulty` and `mode=standard|rotation`, resolves the variant ID, returns top 50 + `me`. Overall board uses approved tie-breaks. Player projection is exactly `{ id, name, avatarUrl }`.

Profile summary semantics:
- uploaded = family count
- solved = distinct families with any difficulty clear
- totalCompletions = accepted run count
- add score/rank/E-N-H counts/achievement IDs/mastery count.

- [ ] **Step 4: Implement family routes and narrow `puzzles.worker.ts`**

Move list/create/family thumbnail concerns to `puzzle-families.worker.ts`. Keep variant detail/piece/reference in `puzzles.worker.ts`. Register both routers in `worker.ts`.

Admin delete receives a family ID, fences/deletes all three variant completion records through the existing deletion executor, then removes family/variant metadata + R2 assets. Do not create a second cleanup protocol.

- [ ] **Step 5: Implement V2 completion/leaderboard/profile handlers**

Routes only validate/project. Scoring and achievement logic stays in shared code. When competitively eligible, query the player's current rank after the transaction and fill `competitive.rank`; rank failure may return `null` without failing completion.

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd apps/api run test:unit`
- `bun --cwd apps/api run check`
- `bun --cwd apps/api run lint`

Commit: `feat(api): expose puzzle family progression APIs`

---

## Task 6: Update seed/admin tooling and perform the one-shot legacy content migration

**Files:**
- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`
- Create: `scripts/migrate-puzzle-families.ts`
- Create: `scripts/migrate-puzzle-families.test.ts`
- Modify: `.gitignore`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`

**Interfaces:**
- Startup/admin upload omits piece count.
- Migration CLI supports exactly `export`, `purge`, `import`, `verify`.
- Export directory: `.migration/puzzle-families/` (gitignored).

- [ ] **Step 1: Write tooling RED tests**

Startup `CatalogEntry` becomes:

```ts
interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  aspectRatio: PuzzleAspectRatio;
}
```

Migration manifest preserves the old owner and source image:

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

- [ ] **Step 2: Implement `export` against the old deployment**

The command must run before deploying the breaking code:
1. enumerate current legacy puzzles through existing admin API
2. obtain ownership with:

```bash
bunx wrangler d1 execute perseus-player-data \
  --remote \
  --config apps/api/wrangler.production.toml \
  --command "SELECT id, owner_id FROM puzzles" \
  --json
```

3. download every retained `/api/puzzles/:id/reference`
4. write manifest/images under `.migration/puzzle-families/`
5. fail non-zero when any ready puzzle lacks an owner row or exportable original.

- [ ] **Step 3: Implement `purge` against the old deployment**

Require a complete export manifest first. Call the existing old admin DELETE endpoint for every exported puzzle ID so old KV/R2/D1 puzzle state is removed while the old runtime still understands it. Stop on first failure; do not proceed to deployment with a partially purged catalog.

- [ ] **Step 4: Implement `import` and `verify` against the new deployment**

`import` posts each manifest image to the new admin family create endpoint with preserved `ownerId`, then polls family status to terminal state. `verify` asserts every manifest entry maps to one ready family whose Easy/Normal/Hard variants have the approved counts.

No completion/save history is imported.

- [ ] **Step 5: Document exact deployment order**

```text
1. bun scripts/migrate-puzzle-families.ts export
2. inspect/export count and image files
3. bun scripts/migrate-puzzle-families.ts purge
4. deploy D1 migration + API/workflow/web
5. bun scripts/migrate-puzzle-families.ts import
6. bun scripts/migrate-puzzle-families.ts verify
7. delete/archive .migration/puzzle-families locally
```

The D1 migration resets completion runs and `player_completion_usage`.

- [ ] **Step 6: Verify and commit**

Run:
- `bun run test:scripts`
- `bun run check:scripts`
- `bun run lint:scripts`

Commit: `feat(scripts): migrate legacy puzzles into families`

---

## Task 7: Change web gallery/upload/session plumbing to family + difficulty UX

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
- Gallery consumes family summaries and renders one card per family.
- Difficulty buttons navigate to existing `/puzzle/<variantId>` routes.
- Server save keys move to v2; Quick `q-*` keys stay on the old prefix.

- [ ] **Step 1: Write family gallery/API RED tests**

Pin one family card with three labels such as `Easy · 16 pieces`, `Normal · 49 pieces`, `Hard · 100 pieces`; non-square fixtures use 12/48/108. Clicking each label uses the corresponding variant ID.

- [ ] **Step 2: Write save-key RED tests through the public adapter**

Use fake `Storage`, call `createSessionStorageAdapter().saveSession(...)`, and assert actual keys rather than adding a production test seam:

```ts
expect(storage.getItem(`puzzle-progress-v2-${serverUuid}`)).not.toBeNull();
expect(storage.getItem('puzzle-progress-q-123')).not.toBeNull();
expect(storage.getItem(`puzzle-progress-${serverUuid}`)).toBeNull();
```

Candidate enumeration accepts new server keys + existing `q-*` keys and ignores old server keys.

- [ ] **Step 3: Run RED**

Run: `bun --cwd apps/web run test:unit -- src/lib/components/__tests__/PuzzleCard.svelte.test.ts src/lib/services/gameplay/session/persistence.test.ts`

- [ ] **Step 4: Implement family gallery/upload UI**

Modify the existing `PuzzleCard` rather than introducing a new family-page framework. Remove server piece-count selector/state/validation from `routes/upload/+page.svelte`. Do not modify `QuickPuzzleUploader.svelte` behavior.

- [ ] **Step 5: Implement server-only save namespace reset**

Keep `@perseus/game-core` unchanged:

```ts
const SERVER_PROGRESS_KEY_PREFIX = 'puzzle-progress-v2-';
const QUICK_PROGRESS_KEY_PREFIX = 'puzzle-progress-';

function progressKey(puzzleId: string): string {
  return puzzleId.startsWith('q-')
    ? `${QUICK_PROGRESS_KEY_PREFIX}${puzzleId}`
    : `${SERVER_PROGRESS_KEY_PREFIX}${puzzleId}`;
}
```

- [ ] **Step 6: Verify and commit**

Run:
- `bun --cwd apps/web run test:unit`
- `bun --cwd apps/web run check`

Commit: `feat(web): add puzzle family difficulty selection`

---

## Task 8: Add completion feedback, family boards, overall leaderboard, and profile progression

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
- Gameplay submits V2 from `sealedCompletion`.
- Completion dialog consumes `CompletionProgressionDelta`.
- Family dialog consumes `PuzzleLeaderboardResponse`; top-level page consumes `OverallLeaderboardResponse`.

- [ ] **Step 1: Write completion-dialog RED tests**

Cover `+200 First Normal Clear`, newly unlocked achievement, newly earned mastery, PB+rank, non-PB best-vs-run time, and server-submission failure that does not block local completion UI.

Route payload is exactly:

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

- [ ] **Step 2: Write family/overall/profile RED tests**

Family leaderboard has Easy/Normal/Hard and Standard/Rotation selectors, one table at a time, plus `YOU · #N` when outside top 50. Overall page renders score + E/N/H counts and no email. Profile renders score/rank/E/N/H counts/achievement progress/mastery count while keeping existing private identity editing.

- [ ] **Step 3: Run RED**

Run: `bun --cwd apps/web run test:unit -- src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts src/routes/profile/page.svelte.test.ts`

- [ ] **Step 4: Implement UI using existing composition patterns**

Use the existing modal focus/action pattern for `PuzzleLeaderboardDialog`; do not extract a dialog framework. Add `Leaderboard` to existing top navigation. Extend current profile rather than adding an achievements route.

- [ ] **Step 5: Verify and commit**

Run:
- `bun --cwd apps/web run test:unit`
- `bun --cwd apps/web run check`
- `bun --cwd apps/web run lint`

Commit: `feat(web): add achievements and leaderboards`

---

## Task 9: Add E2E coverage and run the full single-PR gate

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/catalog.ts`
- Create: `apps/web/e2e/progression-leaderboard.spec.ts`
- Modify: `apps/api/src/__tests__/worker-extra.worker.test.ts`

**Interfaces:**
- Uses existing E2E harness only; no new production test-only endpoint.

- [ ] **Step 1: Update deterministic fixtures**

Give each server fixture one family ID plus stable Easy/Normal/Hard variant IDs/counts. Keep gameplay page object variant-oriented after navigation.

- [ ] **Step 2: Add critical authenticated flow**

```text
gallery shows one family
 -> choose Easy
 -> complete Standard timed run
 -> completion dialog shows first-clear/progression delta
 -> family Standard/Easy board shows player
 -> overall board shows new score
 -> profile shows Easy completion + achievement/mastery totals
```

Also choose Normal and assert a different variant ID/count, proving difficulty is not mutable session state.

- [ ] **Step 3: Pin Quick Puzzle regression**

Existing Quick Puzzle custom piece-count creation and local resume remain functional; `q-*` gameplay exposes no account leaderboard/progression affordance.

- [ ] **Step 4: Run focused E2E**

Run:
- `bun --cwd apps/web run test:e2e -- gallery.spec.ts progression-leaderboard.spec.ts`
- `bun --cwd apps/web run test:e2e:smoke`

- [ ] **Step 5: Run full verification**

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
```

- [ ] **Step 6: Final diff audit and commit**

Confirm:
- no V1 completion compatibility parser remains
- old server save keys are not enumerated
- Quick `q-*` save keys remain valid
- one Workflow per family upload
- no generic achievement/ranking framework
- exact leaderboard tie-breaks
- no email in leaderboard contracts/UI
- migration resets `player_completion_usage`.

Commit: `test: cover puzzle progression and leaderboards`

---

## PR Completion Gate

All nine tasks are intentionally delivered together in one PR. Family identity is required to make difficulty stable, and stable difficulty identity is required for correct scoring/leaderboards; splitting them would force temporary compatibility states this pre-release project does not need.
