# Puzzle Difficulty, Achievements, and Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Keep every task in this document on one implementation PR.

**Goal:** Cut server puzzles over to family + fixed Easy/Normal/Hard variants, prove that lifecycle locally, then layer V2 progression, mastery, achievements, and leaderboards onto the existing completion path.

**Architecture:** family = catalog/image/workflow/ownership/deletion identity; variant = board/session/download/completion/local-stat identity. One family Workflow eagerly generates three concrete variants. D1 owns family ownership plus progression; KV/DO owns live family/variant metadata; R2 stores one family original/thumbnail plus variant pieces. D1 is the only completion-write runtime after this change.

**Spec:** `docs/superpowers/specs/2026-08-26-puzzle-difficulty-achievements-leaderboards-design.md`

## Delivery Rules

- One implementation PR for this task. Phase A and Phase B below are internal green checkpoints, not separate PRs.
- The earlier claim that progression is architecturally inseparable from family cutover is withdrawn; it could be deferred technically. It remains in this PR because difficulty + achievements + leaderboards are one approved task and this project defaults to one PR per task.
- Keep Phase A runnable before adding Phase B.
- No second metadata DO, child workflows, generic progression service, achievement DSL, score ledger, materialized board, V1 parser, or legacy difficulty.
- Quick Puzzles remain local and arbitrary-count.

## Global Invariants

- Difficulty rows×cols/counts:
  - Easy: `1:1 4×4=16`, `4:3 3×4=12`, `3:4 4×3=12`
  - Normal: `1:1 7×7=49`, `4:3 6×8=48`, `3:4 8×6=48`
  - Hard: `1:1 10×10=100`, `4:3 9×12=108`, `3:4 12×9=108`
- `PuzzleSession` remains concrete-variant only.
- Family Workflow checkpoints are difficulty-qualified.
- Family is the only catalog/delete/reaper grain; reuse deletion fences once per variant.
- No D1 `puzzle_variants` table.
- Completion runs and best-time rows carry server-derived `familyId + difficulty`.
- `player_difficulty_completions` stays as the award-once/score index.
- Atomic completion batch: run + first clear + PB + factual mastery. Achievement thresholds reconcile after the batch from a bounded snapshot.
- Standard/Rotation boards stay separate. Assisted/relaxed progress but do not rank by time.
- New server saves use `puzzle-progress-v2-<variantId>`; Quick saves remain `puzzle-progress-q-*`.
- Admin create/list uses `/api/admin/puzzle-families`; browser-only delete uses sibling `/api/admin/puzzle-family-delete/:familyId`.

---

# Phase A — Family Cutover

## Task 1: Add fixed difficulty and family contracts

**Files**

- Create: `packages/types/src/puzzle-family.ts`
- Modify: `packages/types/src/grid.ts`
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/src/grid.test.ts`
- Test: `packages/types/src/index.test.ts`

**Produces**

- `PuzzleDifficulty`, `PUZZLE_DIFFICULTIES`, `DIFFICULTY_PIECE_COUNTS`
- `getDifficultyPieceCount(aspectRatio, difficulty)`
- `PuzzleFamilyMetadata`, `PuzzleFamilySummary`, `PuzzleFamilyListResponse`, `PuzzleVariantSummary`

- [ ] **1. Write RED grid tests**

Assert both count and rows/cols, using code orientation explicitly:

```ts
expect(getDifficultyPieceCount('4:3', 'easy')).toBe(12);
expect(getGridDimensionsForAspectRatio(12, '4:3')).toEqual({ rows: 3, cols: 4 });
expect(getDifficultyPieceCount('3:4', 'hard')).toBe(108);
expect(getGridDimensionsForAspectRatio(108, '3:4')).toEqual({ rows: 12, cols: 9 });
```

Cover all nine combinations and assert `isValidPieceCountForAspectRatio(...)` for each.

- [ ] **2. Write RED family validation tests**

A family has exactly `easy|normal|hard` variant IDs, one valid aspect ratio, one family status, and no scalar `pieceCount`.

- [ ] **3. Run RED**

```bash
bun --cwd packages/types run test:unit
```

- [ ] **4. Implement contracts**

Keep the difficulty map code-owned. Add family summary/detail response types used by web/mobile/admin.

- [ ] **5. Verify**

```bash
bun --cwd packages/types run test:unit
bun --cwd packages/types run build
```

Commit: `feat(types): add puzzle family difficulty contracts`

---

## Task 2: Add family D1 ownership and replace the player uploads query

**Files**

- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/repositories.ts`
- Create: `packages/shared/drizzle/0005_puzzle_families.sql`
- Create/modify corresponding Drizzle metadata
- Test: `packages/shared/src/__tests__/schema.test.ts`
- Test: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `apps/api/src/routes/player.worker.ts`
- Test: `apps/api/src/routes/player.worker.test.ts`

**Important:** this Phase-A migration is additive. Keep legacy completion tables and the old `puzzles` table temporarily so this checkpoint is runnable. They are removed in Phase B's destructive reset before the final PR is complete.

**Produces**

- `puzzleFamilies` only; **no `puzzleVariants` table**
- `insertPuzzleFamilyOwnership`
- `ensurePuzzleFamilyOwnership`
- `deletePuzzleFamilyOwnership`
- `setPuzzleFamilyStatus`
- `listPlayerPuzzleFamilies` with the existing `(createdAt, id)` cursor

- [ ] **1. Write RED schema/repository tests**

Pin family ownership/status columns and the existing cursor semantics for ready/processing/failed owned families.

- [ ] **2. Run RED**

```bash
bun --cwd packages/shared run test:unit -- src/__tests__/repositories.d1.test.ts
```

- [ ] **3. Add `0005_puzzle_families.sql` and repository helpers**

Do not create a D1 variant catalog mirror.

- [ ] **4. Rename the player-owned uploads endpoint**

```text
GET /api/player/puzzle-families
```

Return family summaries. Keep pagination behavior; update profile/web API consumers later in Phase A.

- [ ] **5. Verify**

```bash
bun --cwd packages/shared run test:unit
bun --cwd packages/shared run check
bun --cwd apps/api run test:unit -- src/routes/player.worker.test.ts
```

Commit: `feat(db): add puzzle family ownership model`

---

## Task 3: Convert metadata/storage and Workflow to one family with three variants

**Files**

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

**Produces**

- one `WorkflowParams { familyId }`
- `family:*` read model + `puzzle:*` variant read model
- family R2 original/thumbnail helpers
- variant piece helpers
- family listing/indexing

- [ ] **1. Write RED metadata tests**

Use the same `PUZZLE_METADATA_DO` namespace but discriminate `family | variant` and address by the corresponding ID.

- [ ] **2. Write RED Workflow tests**

One family execution must reuse preallocated IDs and generate the approved counts.

Pin checkpoint names exactly enough to catch the current collision bug:

```text
generate-easy-row-0
finalize-easy
generate-normal-row-0
finalize-normal
generate-hard-row-0
finalize-hard
finalize-family
```

Repeated per-difficulty status/mirror steps must also contain difficulty.

- [ ] **3. Run RED**

```bash
bun --cwd apps/workflows run test:unit
bun --cwd apps/api run test:unit -- src/services/storage.worker.test.ts
```

- [ ] **4. Generalize `PuzzleMetadataDO`**

Keep reservation logic separate. Reservations now map the upload idempotency key to `familyId`.

- [ ] **5. Move shared assets to family scope**

```text
families/<familyId>/original
families/<familyId>/thumbnail.jpg
puzzles/<variantId>/pieces/<pieceId>.png
```

Variant reference resolves family original.

- [ ] **6. Rewrite Workflow loop**

Retain row checkpoints; qualify each by difficulty. Only mirror family status into D1 `puzzle_families`.

- [ ] **7. Verify**

```bash
bun --cwd apps/workflows run test:unit
bun --cwd apps/workflows run check
bun --cwd apps/api run test:unit
bun --cwd apps/api run check
```

Commit: `feat(workflow): generate three puzzle variants per family`

---

## Task 4: Make deletion/reaper family-scoped

**Files**

- Modify: `apps/api/src/services/storage.worker.ts`
- Modify: `apps/api/src/services/puzzle-deletion.worker.ts`
- Modify: `apps/api/src/services/reaper.ts`
- Test: `apps/api/src/services/__tests__/puzzle-deletion.worker.test.ts`
- Test: `apps/api/src/services/__tests__/reaper.test.ts`
- Test: `apps/api/src/services/__tests__/reaper-d1-coverage.test.ts`
- Test: `apps/api/src/services/storage-worker-extra.worker.test.ts`

**Produces**

- family-scoped `CleanupRecord`
- family stuck-workflow scan
- family cleanup orchestration over three existing variant fences

- [ ] **1. Write RED cleanup-record tests**

Record immutable `familyId`, three variant IDs, three piece counts, and reservation identity needed for retries.

- [ ] **2. Write RED reaper tests**

Pin that the stuck scan lists `family:*`, never independently reaps `puzzle:*`, and checks the one family workflow.

- [ ] **3. Write RED deletion-order tests**

Before shared assets are removed, call `beginPuzzleDeletion()` for all three variant IDs. Complete all variant tombstones/assets/data before cleanup record removal.

- [ ] **4. Implement family cleanup by composing existing fences**

Do not add a second DB deletion protocol. Keep cleanup idempotent/retryable.

- [ ] **5. Verify**

```bash
bun --cwd apps/api run test:unit -- src/services/__tests__/puzzle-deletion.worker.test.ts src/services/__tests__/reaper.test.ts
bun --cwd apps/api run check
```

Commit: `feat(api): make puzzle cleanup family scoped`

---

## Task 5: Cut public/admin/upload APIs and Access to family identity

**Files**

- Create: `apps/api/src/routes/puzzle-families.worker.ts`
- Create: `apps/api/src/routes/puzzle-families.worker.test.ts`
- Modify: `apps/api/src/routes/puzzles.worker.ts`
- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/adminPuzzleList.ts`
- Modify: `apps/web/src/routes/admin/adminPuzzleList.test.ts`
- Modify: `packages/infrastructure/src/admin-access.ts`
- Modify: `packages/infrastructure/src/admin-access.test.ts`
- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/catalog.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify relevant script tests

**Public routes**

```text
GET  /api/puzzle-families
GET  /api/puzzle-families/:familyId
POST /api/puzzle-families
GET  /api/puzzle-families/:familyId/thumbnail
```

Concrete variant detail/assets remain under `/api/puzzles/:variantId/...`; remove public `GET /api/puzzles` list.

**Admin routes**

```text
GET  /api/admin/puzzle-families
POST /api/admin/puzzle-families
POST /api/admin/puzzle-family-delete/:familyId
```

- [ ] **1. Write RED create/list/detail tests**

Create accepts name/category/aspect/image only and allocates 1 family + 3 variant UUIDs.

- [ ] **2. Write RED Access tests**

`CLI_ACCESS_PATHS` becomes exact `/api/admin/puzzle-families`. Assert the sibling delete route is not in the CLI app and remains under broad browser admin policy.

- [ ] **3. Update `AdminPuzzlesPanel`**

One family row, family preview/status/polling, three fixed counts shown together, whole-family delete.

- [ ] **4. Update upload CLIs**

Remove `--pieces` / catalog `pieceCount`. Idempotency key becomes image-level family identity such as normalized `name + aspectRatio` (preserve the existing hashed header mechanism).

- [ ] **5. Verify**

```bash
bun --cwd apps/api run test:unit
bun --cwd apps/api run check
bun --cwd apps/web run test:unit -- src/routes/admin
bun --cwd packages/infrastructure run test:unit
bun run test:scripts
bun run check:scripts
```

Commit: `feat(api): expose family catalog and admin endpoints`

---

## Task 6: Cut web gallery/progress/upload to family identity

**Files**

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
- Modify: `apps/web/src/lib/services/stats.ts`
- Modify relevant stats tests
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`
- Modify: `apps/web/src/routes/upload/+page.svelte`
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`

- [ ] **1. Write family-card RED tests**

One card must render three difficulty states independently. Multiple difficulties may simultaneously show Continue.

- [ ] **2. Keep progress/local stats variant keyed**

Resolve family variants before calling existing session/stat helpers. No family aggregate stat object.

- [ ] **3. Pin save namespaces**

```ts
server variant -> puzzle-progress-v2-<uuid>
q-*            -> puzzle-progress-q-*
```

Enumeration accepts only the new server namespace plus existing Quick keys. It intentionally ignores old server `puzzle-progress-<uuid>` without changing retryable-404 behavior.

- [ ] **4. Remove server piece-count upload input**

Keep Quick Puzzle uploader unchanged.

- [ ] **5. Verify**

```bash
bun --cwd apps/web run test:unit
bun --cwd apps/web run check
```

Commit: `feat(web): add family difficulty gallery`

---

## Task 7: Move NativeScript to the family catalog without changing download packages

**Files**

- Modify: `apps/mobile/app/api/puzzleApi.ts`
- Modify: `apps/mobile/app/api/puzzleApi.test.ts`
- Modify: `apps/mobile/app/library/Gallery.svelte`
- Modify: `apps/mobile/app/library/Library.svelte`
- Create: `apps/mobile/app/library/familyGallery.ts`
- Create: `apps/mobile/app/library/familyGallery.test.ts`
- Modify only download-store/manifest tests if shared type changes require fixture updates

- [ ] **1. Write API RED tests**

`listPuzzles()` becomes `listPuzzleFamilies()` against `/api/puzzle-families`. Variant detail/asset URL methods remain concrete-variant based.

- [ ] **2. Write pure family-gallery RED tests**

Test difficulty labels and `family + difficulty -> variantId` selection in `familyGallery.ts`; do not invent Svelte-Native component-test infrastructure.

- [ ] **3. Update Gallery/Library**

Render one family with Easy/Normal/Hard download actions. `onDownload` still receives the selected concrete variant ID.

- [ ] **4. Preserve downloaded package/session model**

No family bundle and no filesystem schema change beyond fixture type adjustments genuinely required by the API contract.

- [ ] **5. Verify**

```bash
bun --cwd apps/mobile run test:unit
cd apps/mobile && bunx tsc --noEmit
```

Commit: `feat(mobile): select puzzle difficulty from family catalog`

---

## Task 8: Run a real local family create/delete gate

This gate happens **before** production migration tooling is considered ready.

- [ ] **1. Apply local D1 migrations**

```bash
bun --cwd apps/api run db:migrate:local
```

- [ ] **2. Start the real API + Workflow dev runtime**

```bash
bun --cwd apps/api run dev
```

- [ ] **3. Upload one square family with the updated local admin CLI**

Use a small checked-in/test image or disposable local image. Wait until the family is `ready`.

- [ ] **4. Verify generated identity/assets**

Assert:

```text
Easy   16 pieces  4×4
Normal 49 pieces  7×7
Hard   100 pieces 10×10
```

Probe family thumbnail/reference plus representative piece assets from all three variants.

- [ ] **5. Delete via family delete path**

Verify family original/thumbnail, all three piece prefixes, family/variant KV/DO metadata, D1 family row, and cleanup record are gone. Verify all three variant deletion fences finish.

- [ ] **6. Record the gate result in the implementation PR body/task report**

No production code change is required solely to record this evidence.

Commit only if the gate exposed and fixed a real issue.

---

## Task 9: Add safe one-shot production export/import/cleanup tooling and runbook

**Files**

- Create: `scripts/export-legacy-puzzles.ts`
- Create: `scripts/import-puzzle-families.ts`
- Create: `scripts/cleanup-legacy-puzzles.ts`
- Create: `scripts/puzzle-family-migration.test.ts`
- Modify: `.gitignore`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`

**Important:** merge to `main` triggers deployment. The production D1/content export must therefore be completed and verified **before merging the implementation PR**.

- [ ] **1. Add read-only legacy export**

Against the old production API, capture old puzzle ID, name, category, aspect, owner ID, and retained original bytes into ignored `.migration/puzzle-families/` artifacts. Fail if any ready puzzle cannot be exported.

- [ ] **2. Add new-family importer**

Post originals to `/api/admin/puzzle-families`, preserve owner ID through the operator seam, and poll until every imported family is ready/failed.

- [ ] **3. Add post-import old-object cleanup**

Only after replacements are verified, delete legacy `puzzle:*` KV and old `puzzles/<oldId>/` R2 original/thumbnail/piece objects. This is one-shot tooling, not runtime fallback.

- [ ] **4. Document mandatory D1 backup as rollout step 0**

Use current Wrangler syntax:

```bash
mkdir -p .migration/puzzle-families
bunx wrangler d1 export perseus-player-data \
  --remote \
  --output .migration/puzzle-families/d1-before-family-cutover.sql \
  --config apps/api/wrangler.production.toml
```

Verify the file is non-empty before proceeding.

- [ ] **5. Document the accepted empty-gallery window**

After family-only code deploys and before imported families finish all three variants, production gallery is empty. This is accepted pre-release downtime and must be explicit.

- [ ] **6. Document final order**

```text
PRE-MERGE: D1 export -> legacy content export -> verify backups
MERGE/DEPLOY: migrations + family code
POST-DEPLOY: import families -> wait all ready -> verify -> cleanup old objects
```

- [ ] **7. Verify**

```bash
bun run test:scripts
bun run check:scripts
bun run lint:scripts
```

Commit: `feat(scripts): add puzzle family cutover tooling`

---

# Phase B — Completion Progression and Leaderboards

## Task 10: Remove the duplicate Bun completion driver and add V2/progression schema

**Files**

- Delete: `packages/shared/src/drivers/bun.ts`
- Delete or fold: `packages/shared/src/__tests__/drivers.test.ts`
- Modify: `packages/shared/package.json` (remove `./bun` export)
- Move uniquely valuable repository/driver assertions into `packages/shared/src/__tests__/repositories.d1.test.ts`
- Modify: `packages/types/src/*` for V2/progression contracts
- Modify: `packages/game-core/src/session/types.ts`
- Modify: `packages/game-core/src/session/session.test.ts`
- Modify: `packages/shared/src/schema.ts`
- Create: `packages/shared/drizzle/0006_puzzle_progression_reset.sql`
- Create/modify corresponding Drizzle metadata
- Test: `packages/shared/src/__tests__/schema.test.ts`

**Final schema**

```text
puzzle_families
puzzle_completion_runs (+ family_id, difficulty, hints_used, incorrect_attempts; no timing_quality)
puzzle_best_times (+ family_id, difficulty, result_class)
player_difficulty_completions
player_achievements
player_variant_mastery
player_profiles
player_completion_usage
puzzle_deletion_tombstones
```

No `puzzle_variants`, old `puzzles`, or old `puzzle_stats` in final schema.

- [ ] **1. Prove Bun driver is unused outside tests**

Repeat repository search before deleting. If a production importer appears on current main, stop and revise this task; do not delete blindly.

- [ ] **2. Delete Bun driver/export and migrate unique tests to D1/Miniflare**

D1 is the behavior contract for completion writes.

- [ ] **3. Add V2 request/projection tests**

`completionRequestFromSeal()` must emit `version:2`, hints, and incorrect attempts; route code will reuse this helper.

- [ ] **4. Write final schema RED tests**

Pin no `puzzle_variants`, no `timing_quality`, run family/difficulty facts, best-time mode key, award-once/achievement/mastery keys, and quota reset.

- [ ] **5. Implement destructive `0006` reset**

Reset old completion/stat data and `player_completion_usage`; preserve profile identity and family rows. Remove old `puzzles`/`puzzle_stats` final schema.

- [ ] **6. Verify**

```bash
bun --cwd packages/types run test:unit
bun --cwd packages/game-core run test:unit
bun --cwd packages/shared run test:unit
bun --cwd packages/shared run check
bun --cwd apps/api run db:migrate:local
```

Commit: `feat(db): add V2 puzzle progression schema`

---

## Task 11: Extend the D1 completion executor; reconcile achievements after the atomic batch

**Files**

- Create: `packages/shared/src/progression.ts`
- Modify: `packages/shared/src/completion-writes.ts`
- Modify: `packages/shared/src/drivers/d1.ts`
- Modify: `packages/shared/src/repositories.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Add focused pure progression tests
- Modify: `apps/api/src/routes/puzzles.complete.shared.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.ts`
- Modify corresponding API tests

- [ ] **1. Write pure mastery/achievement RED tests**

```ts
masteryForCompletion({ hintsUsed: 0, incorrectAttempts: 0, resultClass: 'rotation_timed' });
// -> hintless, flawless, rotation_clear
```

Define an `AchievementSnapshot` containing only bounded counts/booleans required by the nine predicates. `evaluateAchievements(snapshot)` is pure and table-tested at every threshold boundary.

- [ ] **2. Write D1 transaction RED tests**

Cover:

- first family+difficulty clear once
- exact replay idempotent
- same run with changed hint/wrong facts conflicts
- Standard and Rotation PBs isolated
- assisted/relaxed no PB
- worse replay preserves PB achievedAt; better replay replaces it
- current-run mastery inserted atomically/idempotently
- quota/tombstone race behavior remains typed

- [ ] **3. Extend `VersionedCompletionWrite`/stored facts**

Include trusted `familyId`, `difficulty`, hints, wrong attempts.

- [ ] **4. Keep atomic batch narrow**

The D1 batch handles run/fence/quota, first-clear, PB, and factual mastery only. Conditional statements must verify full stored run facts so a run-ID conflict cannot award progression.

- [ ] **5. Reconcile achievements after the batch**

For a facts-matching newly stored **or exact replayed** run:

1. read one bounded achievement snapshot
2. run pure predicates
3. insert missing achievement IDs with `ON CONFLICT DO NOTHING ... RETURNING`

A failure after the run batch makes the request retryable; exact replay performs the same reconciliation and repairs missing achievements.

- [ ] **6. Server derives family+difficulty**

Completion route reads variant metadata and passes trusted identity into shared code. Client does not submit it.

- [ ] **7. Verify**

```bash
bun --cwd packages/shared run test:unit
bun --cwd apps/api run test:unit -- src/routes/puzzles.complete.worker.test.ts
bun --cwd packages/shared run check
bun --cwd apps/api run check
```

Commit: `feat(shared): add completion progression and mastery`

---

## Task 12: Add ranking/profile queries and web progression UI

**Files**

- Modify: `packages/shared/src/repositories.ts`
- Test: `packages/shared/src/__tests__/repositories.d1.test.ts`
- Create: `apps/api/src/routes/leaderboard.worker.ts`
- Create: `apps/api/src/routes/leaderboard.worker.test.ts`
- Modify: `apps/api/src/routes/puzzle-families.worker.ts`
- Modify: `apps/api/src/routes/player.worker.ts`
- Modify corresponding API tests
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify component tests
- Create: `apps/web/src/lib/components/PuzzleLeaderboardDialog.svelte`
- Create tests
- Create: `apps/web/src/routes/leaderboard/+page.svelte`
- Create tests
- Modify: `apps/web/src/routes/profile/+page.svelte`
- Modify profile tests
- Modify: `apps/web/src/routes/+layout.svelte`
- Modify: `apps/web/src/lib/services/api.ts`

**Queries**

```ts
listPuzzleLeaderboard(...)
listOverallLeaderboard(...)
listPlayerStats(...)          // rewritten family+difficulty grain
getPlayerSummary(...)
getPlayerProgressionSummary(...)
```

- [ ] **1. Write leaderboard ordering RED tests**

Puzzle: time ASC, achievedAt ASC, playerId ASC.

Overall: score DESC, Hard DESC, Normal DESC, Easy DESC, scoreReachedAt ASC, playerId ASC.

Top 50 + `me`; never email.

- [ ] **2. Preserve Puzzle Results**

Rewrite `listPlayerStats()` against new rows. Row grain is family+difficulty and includes Standard best, Rotation best, total runs, first/last completion. Preserve bounded cursor pagination style.

- [ ] **3. Rewrite summary semantics**

`puzzlesUploaded` = families; `puzzlesSolved` = distinct families; `totalCompletions` = run count.

- [ ] **4. Update completion UI**

Route uses `completionRequestFromSeal()` V2. Completion dialog displays only this run's newly awarded clear points, achievements, mastery, PB/rank feedback when available. Submission failure never blocks local completion.

- [ ] **5. Add family + overall leaderboard UI**

Family dialog: difficulty selector + Standard/Rotation selector. Overall page: score and E/N/H counts. Add one top-level Leaderboard nav entry.

- [ ] **6. Extend Profile instead of adding a separate achievements app**

Show score/rank, difficulty counts, achievement progress, mastery progress, and preserved Puzzle Results.

- [ ] **7. Verify**

```bash
bun --cwd packages/shared run test:unit
bun --cwd apps/api run test:unit
bun --cwd apps/web run test:unit
bun --cwd apps/web run check
```

Commit: `feat(web): add puzzle progression and leaderboards`

---

## Task 13: Integrated E2E and final single-PR gate

**Files**

- Modify: `apps/web/e2e/gallery.spec.ts`
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/catalog.ts`
- Modify: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Create: `apps/web/e2e/progression-leaderboard.spec.ts`
- Modify only additional fixtures/tests required by the final API shape

- [ ] **1. Family difficulty E2E**

```text
one family card
 -> Easy + Normal + Hard have distinct variant IDs/counts
 -> resume state belongs to the selected difficulty
 -> old server save namespace is ignored
 -> Quick Puzzle resume still works
```

- [ ] **2. Progression E2E**

Authenticated eligible completion:

```text
complete Easy
 -> +100 once
 -> mastery/achievement deltas
 -> Standard family board row
 -> overall score/rank
 -> profile counts + family+difficulty Puzzle Results
```

Replay same difficulty and verify no additional clear points.

- [ ] **3. Family cleanup regression**

Keep the Task 8 real-runtime create/delete gate as mandatory evidence; do not substitute mocks at final review.

- [ ] **4. Mobile regression**

```bash
bun --cwd apps/mobile run test:unit
cd apps/mobile && bunx tsc --noEmit
```

Where a macOS/iOS simulator is available, run one `ns run ios --no-hmr --justlaunch` compile/launch smoke after the family API changes. Do not block non-mac CI on this manual smoke.

- [ ] **5. Full repository gate**

```bash
bun run check
bun run lint
bun run test:unit
bun run test:scripts
bun run check:scripts
bun run lint:scripts
bun run build
bun run test:e2e
bun --cwd apps/web run test:e2e:assert-production-bundle
```

- [ ] **6. Final diff review**

Explicitly verify:

- one implementation PR
- no D1 `puzzle_variants`
- no `@perseus/shared/bun`
- no V1 completion parser
- no generic achievement/ranking engine
- one family Workflow with difficulty-qualified checkpoints
- family-only cleanup/reaper
- player upload list preserved at family grain
- Puzzle Results preserved at family+difficulty grain
- server v2 save namespace + unchanged Quick keys
- sibling admin delete route outside CLI Access policy
- production runbook begins with D1 + content exports

Commit: `test: cover puzzle family progression cutover`

---

## Production Cutover Gate Before Merge

Because merge to `main` triggers deployment, do **not** merge the implementation PR until all of these are complete:

```text
local Task 8 create/delete gate PASS
full automated PR gate PASS
production D1 export created and verified
legacy production content/owner export created and verified
operator has the import/cleanup commands and Access credentials ready
```

After merge/deploy, run import immediately, wait for every family to become ready, verify counts/assets, then execute the one-shot old-object cleanup. The temporary empty-gallery window is an accepted pre-release trade-off, not an unnoticed failure mode.
