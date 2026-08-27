# Puzzle Difficulty, Achievements, and Leaderboards Design

Date: 2026-08-26

Freshness review: revised against `main` at `67be5f3e28ab78c186e100e53cd09c6dc7f37f57`, including the shipped NativeScript offline library and Access-only admin portal.

## Summary

Perseus currently treats each server puzzle as one concrete generated board with one piece count. This design replaces that server-catalog model with a player-facing **puzzle family** that owns one image and exactly three concrete **puzzle variants**: Easy, Normal, and Hard.

A **family** is the catalog/image/workflow/ownership/deletion identity. A **variant** is the board/session/download/completion/local-stat identity. `PuzzleSession` continues to understand only one immutable board and never gains mutable difficulty state.

The same feature adds global one-time achievements, non-scoring per-variant mastery, Standard/Rotation time leaderboards per difficulty, and an overall score derived from unique family+difficulty clears plus achievement rows.

The cutover is intentionally breaking. Existing arbitrary-count server puzzles are regenerated into new families. Old server completion history is reset rather than assigned fake difficulty semantics. Quick Puzzles remain local and keep their arbitrary piece-count model.

## Goals

- Make every server puzzle available at Easy, Normal, and Hard difficulty.
- Define difficulty only by fixed piece count/grid shape.
- Preserve one-puzzle-ID = one immutable board geometry.
- Generate all three variants eagerly in one Cloudflare Workflow.
- Make family the only public/admin catalog and cleanup grain.
- Keep web and NativeScript on the same family catalog API.
- Add replay value without repeat-clear farming.
- Add separate Standard and Rotation timed leaderboards per family+difficulty.
- Add an overall score driven primarily by unique clears, with small achievement bonuses.
- Preserve Profile → Puzzle Results under the family+difficulty model.
- Reuse the existing completion executor, deletion fence, `PUZZLE_METADATA_DO`, profile identity, and Access-only admin model.

## Non-goals

No seasons, recurring quests, streaks, XP/levels, currency, rewards, achievement DSL, configurable difficulty, category achievements, arbitrary time-threshold achievements, mastery score, assisted/relaxed time boards, social/friends/country boards, WebSocket ranking updates, anti-cheat subsystem, materialized score ledger, generic ranking framework, second metadata DO, child workflows, runtime V1 parser, `legacy` difficulty, or runtime server-catalog compatibility layer.

## 1. Difficulty Model

Difficulty is piece count only. The grid table is explicitly **rows × cols** to match `getGridDimensionsForAspectRatio()`.

| Difficulty | 1:1 rows×cols | 4:3 rows×cols | 3:4 rows×cols |
| ---------- | ------------: | ------------: | ------------: |
| Easy       |      4×4 = 16 |      3×4 = 12 |      4×3 = 12 |
| Normal     |      7×7 = 49 |      6×8 = 48 |      8×6 = 48 |
| Hard       |   10×10 = 100 |    9×12 = 108 |    12×9 = 108 |

The values live in `@perseus/types`:

```ts
export const PUZZLE_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PuzzleDifficulty = (typeof PUZZLE_DIFFICULTIES)[number];

export const DIFFICULTY_PIECE_COUNTS = {
	easy: { '1:1': 16, '4:3': 12, '3:4': 12 },
	normal: { '1:1': 49, '4:3': 48, '3:4': 48 },
	hard: { '1:1': 100, '4:3': 108, '3:4': 108 }
} as const;
```

Every value must pass the existing `isValidPieceCountForAspectRatio()` and resolve to the rows/cols above through `getGridDimensionsForAspectRatio()`.

Rotation, hints, reference modes, and timed/relaxed mode remain independent. Easy does not disable rotation; Hard does not force it.

## 2. Family and Variant Model

### 2.1 Family

```ts
interface PuzzleFamilyMetadata {
	id: string;
	name: string;
	category?: PuzzleCategory;
	aspectRatio: PuzzleAspectRatio;
	createdAt: number;
	status: 'processing' | 'ready' | 'failed';
	variants: Record<PuzzleDifficulty, string>;
}
```

The family owns name/category/owner, aspect ratio, original image, thumbnail, three preallocated variant IDs, workflow status, public/admin/mobile catalog identity, and cleanup/reaper lifecycle.

### 2.2 Variant

Existing concrete puzzle metadata gains immutable identity:

```ts
familyId: string;
difficulty: PuzzleDifficulty;
```

The variant owns piece count, rows/cols, piece metadata/assets, save/session, native download package, local stats, completion runs, mode-specific best times, and mastery.

### 2.3 Gameplay boundary

Family+difficulty resolves to one variant ID before gameplay starts. `PuzzleSession` receives only the concrete variant spec. Do not add family or mutable difficulty to session state.

## 3. KV/DO and R2 Ownership

Use KV read models:

```text
family:<familyId>   -> family metadata
puzzle:<variantId>  -> concrete variant metadata
```

Reuse `PUZZLE_METADATA_DO` for both, addressed by family ID or variant ID and discriminated as `family | variant`. Do not add a second binding.

Family readiness is a rollup:

```text
all 3 variants ready -> family ready
any terminal variant failure -> family failed
otherwise -> family processing
```

The public/admin catalog lists `family:*` only.

R2 layout:

```text
families/<familyId>/original
families/<familyId>/thumbnail.jpg
puzzles/<variantId>/pieces/<pieceId>.png
```

There is no variant-owned original/thumbnail after cutover. Variant reference requests resolve `variantId -> familyId` and serve the family original.

## 4. D1 Schema

D1 keeps only queryable ownership/progression state that is not already represented adequately by KV.

### 4.1 Family catalog

```text
puzzle_families
  id          PK
  owner_id
  name
  category    nullable
  aspect_ratio
  status
  created_at
```

There is **no `puzzle_variants` D1 table**. The variant→family+difficulty map already exists in family metadata and each concrete variant KV/DO record. Duplicating it in D1 adds another consistency surface without a query that requires it.

The existing D1 ownership helpers become family-grained equivalents:

- `insert/ensure/deletePuzzleFamilyOwnership`
- `setPuzzleFamilyStatus`
- `listPlayerPuzzleFamilies`

The player-owned uploads list keeps its current `(createdAt, id)` cursor semantics but returns family rows, including processing/failed families.

### 4.2 Completion runs

Accepted completion runs carry trusted denormalized family identity derived by the server from variant metadata:

```text
puzzle_completion_runs
  player_id
  run_id
  puzzle_id                 -- variant ID
  family_id
  difficulty
  result_class
  elapsed_active_seconds    nullable for relaxed
  hints_used
  incorrect_attempts
  completed_at

PRIMARY KEY (player_id, run_id)
```

The reset removes `timing_quality` / `legacy_unknown` rather than preserving a compatibility column.

### 4.3 Competitive bests

```text
puzzle_best_times
  player_id
  puzzle_id                 -- variant ID
  family_id
  difficulty
  result_class              -- standard_timed | rotation_timed
  best_time_seconds
  achieved_at

PRIMARY KEY (player_id, puzzle_id, result_class)
```

The family/difficulty columns are trusted denormalized identity for profile/family queries, not a second catalog table.

### 4.4 Unique clears

```text
player_difficulty_completions
  player_id
  family_id
  difficulty
  first_completed_at

PRIMARY KEY (player_id, family_id, difficulty)
```

This table is intentionally retained even though it is derivable from the non-pruned run ledger: `INSERT ... ON CONFLICT DO NOTHING` gives atomic award-once semantics and cheap score/count reads.

### 4.5 Achievements and mastery

```text
player_achievements
  player_id
  achievement_id
  unlocked_at

PRIMARY KEY (player_id, achievement_id)

player_variant_mastery
  player_id
  puzzle_id
  badge
  earned_at

PRIMARY KEY (player_id, puzzle_id, badge)
```

Achievement definitions and point values remain code constants. No achievement table or rule language is added.

## 5. Family-Scoped Deletion and Reaping

Family is the only catalog/delete/reaper grain. A variant is never independently reaped or exposed through an admin delete action because siblings share the original/thumbnail and `family.variants` must remain coherent.

Extend the current cleanup record to family scope:

```ts
interface CleanupRecord {
	familyId: string;
	variantIds: Record<PuzzleDifficulty, string>;
	pieceCounts: Record<PuzzleDifficulty, number>;
	idempotencyKey?: string;
	createdAt: number;
}
```

The reaper scans `family:*`, checks the one family workflow, and decides cleanup once for the whole family.

Reuse the existing completion deletion fence once per variant:

```text
persist family CleanupRecord
beginPuzzleDeletion(easy)
beginPuzzleDeletion(normal)
beginPuzzleDeletion(hard)
tombstone family + variant metadata DOs
delete family original/thumbnail
delete three piece prefixes
delete family KV/D1 row
finishPuzzleDeletion(easy/normal/hard)
delete family-scoped first-clear rows
remove cleanup record
```

Mode bests, runs, and mastery are removed by the variant deletion path. Global achievements remain unlocked; they are account milestones and are not revoked when content is later deleted.

Do not add a second family deletion transaction protocol around the existing fences.

## 6. One Eager Family Workflow

Server upload accepts image, name, optional category, and aspect ratio. Piece count is no longer client input.

One workflow instance is keyed by `familyId`. It reuses the preallocated variant IDs and generates all three tiers.

Workflow step names repeated per difficulty are difficulty-qualified because Cloudflare Workflow checkpoints are unique by name within an instance:

```text
generate-easy-row-0 ... finalize-easy
generate-normal-row-0 ... finalize-normal
generate-hard-row-0 ... finalize-hard
finalize-family
```

Any repeated mirror/finalization checkpoint follows the same rule. Never reuse `generate-row-${row}` across variants and never collapse all variants into one coarse step.

Only the family status is mirrored to `puzzle_families`; there is no D1 variant-status mirror.

A terminal sibling failure marks the family failed but does not roll back already generated sibling assets. Retry uses the same IDs/checkpoint names and family remains unplayable until all three variants are ready.

## 7. Public, Player, and Admin APIs

### 7.1 Public catalog

```text
GET  /api/puzzle-families
GET  /api/puzzle-families/:familyId
POST /api/puzzle-families
GET  /api/puzzle-families/:familyId/thumbnail
```

There is no public `GET /api/puzzles` catalog after cutover.

Concrete gameplay stays variant-oriented:

```text
GET  /api/puzzles/:variantId
GET  /api/puzzles/:variantId/reference
GET  /api/puzzles/:variantId/pieces/:pieceId/image
POST /api/puzzles/:variantId/complete
```

### 7.2 Player uploads/profile

Rename the player-owned upload collection to the family model:

```text
GET /api/player/puzzle-families
```

It keeps the existing bounded cursor style and shows owned processing/failed/ready families.

### 7.3 Admin and Access

Admin list/create becomes:

```text
GET  /api/admin/puzzle-families
POST /api/admin/puzzle-families
```

The narrow CLI Access application moves from exact `/api/admin/puzzles` to exact `/api/admin/puzzle-families` with no alias.

Family deletion must stay a **sibling** route so the service-token policy on the collection path is not inherited:

```text
POST /api/admin/puzzle-family-delete/:familyId
```

This remains browser-admin-only under the broad `/api/admin/*` email+posture policy. A CLI service token may list/create families but may not delete them.

`AdminPuzzlesPanel` becomes family-scoped: one row/image/status per family, fixed tier counts shown together, family preview, family polling, and whole-family delete.

## 8. Web Gallery, Saved Progress, and Local Stats

One family card renders the shared image/name/category plus three difficulty actions. There is no single family `pieceCount`, `placedCount`, or local best.

Example square family:

```text
Easy · 16 · CONTINUE 7/16 · ◆ 03:12
Normal · 49 · PLAY
Hard · 100 · PLAY
```

Saved progress and local stats remain concrete-variant keyed.

New server variants intentionally use a new server namespace:

```text
puzzle-progress-v2-<variantId>
```

Quick Puzzles retain:

```text
puzzle-progress-q-<...>
```

This small split is deliberate. Current saved-progress discovery treats a server detail 404 as retryable because KV can lag; old dead UUID keys therefore cannot be safely swept by interpreting 404 as authoritative. The v2 namespace isolates the breaking server cutover without adding a browser migration/sweep or weakening that correctness rule. The branching is localized to web persistence key mapping/enumeration.

Local stats remain `puzzle-stats-<variantId>` and the card best remains the Standard timed local best for that difficulty.

## 9. NativeScript Catalog and Downloads

The shipped mobile app is a second real catalog client and must cut over in this same change.

`PuzzleApi.listPuzzles()` becomes a family list/detail API. Mobile Gallery renders one family and an Easy/Normal/Hard choice. Selecting a difficulty resolves the variant ID, then reuses the existing variant-oriented download/package/session path unchanged.

Downloaded packages remain concrete-variant packages; multiple difficulties from one family can be installed independently. Do not introduce a family download bundle.

## 10. Completion V2 and Replay Equality

`SealedCompletion` already contains the required facts. The canonical game-core helper becomes:

```ts
completionRequestFromSeal(seal): RecordPuzzleCompletionV2
```

and emits only:

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

The Svelte route does not assemble V2 manually.

The server resolves `variantId -> familyId + difficulty` from trusted metadata. The client never submits family, difficulty, or score.

`VersionedCompletionWrite`, stored facts, and `completionFactsMatch()` include `hintsUsed` and `incorrectAttempts`. Same run ID with changed facts is a conflict.

## 11. Completion Write Boundary

Keep `CompletionWriteExecutor.write()` as the one write seam. Delete the test-only Bun/SQLite driver before expanding this subsystem; D1/Miniflare is the contract implementation. Remove `@perseus/shared/bun` and migrate any uniquely valuable tests into the D1-backed suite.

The atomic D1 batch contains only facts that must not drift from an accepted run:

1. deletion-fence/quota checks and run insert/read
2. first family+difficulty clear insert
3. Standard/Rotation personal-best upsert when eligible
4. current-run factual mastery inserts

Mastery stays in the atomic batch because it is a direct fact of the accepted run and the completion response should not be able to persist a Hintless/Flawless run without its corresponding badge.

Achievement threshold evaluation happens **after** the atomic batch. Read one bounded progression snapshot, evaluate the nine predicates in pure TypeScript, then `INSERT ... ON CONFLICT DO NOTHING ... RETURNING` for newly satisfied IDs. Exact replays also re-run this achievement reconciliation, so a failure after the run transaction is repaired by retry/next completion without duplicating score.

No second `ProgressionService` transaction is introduced; this remains part of the completion executor/repository flow.

## 12. Progression, Achievements, and Mastery

Unique clear points:

| Difficulty | Points |
| ---------- | -----: |
| Easy       |    100 |
| Normal     |    200 |
| Hard       |    300 |

Each family+difficulty scores once. Replays score zero completion points.

Global achievements:

| ID                | Requirement                    | Points |
| ----------------- | ------------------------------ | -----: |
| `first_clear`     | any unique clear               |     25 |
| `getting_started` | 5 unique clears                |     50 |
| `puzzle_regular`  | 15 unique clears               |    100 |
| `full_set`        | Easy+Normal+Hard on one family |     75 |
| `hard_mode`       | any Hard clear                 |     50 |
| `hard_veteran`    | 5 unique Hard clears           |    100 |
| `hintless`        | first Hintless mastery         |     25 |
| `flawless`        | first Flawless mastery         |     25 |
| `rotation_clear`  | first Rotation Clear mastery   |     25 |

Mastery is per variant and non-scoring:

- `hintless`: complete with `hintsUsed === 0`
- `flawless`: complete with `incorrectAttempts === 0`
- `rotation_clear`: complete with `resultClass === 'rotation_timed'`

Badges may be earned on different runs. Assisted/relaxed runs may earn factual Hintless/Flawless. Rotation Clear requires a Rotation timed run.

## 13. Competitive and Overall Leaderboards

Per family+difficulty, Standard and Rotation boards are separate. Assisted/relaxed runs never enter time boards.

Puzzle ordering:

```text
best_time_seconds ASC
achieved_at ASC
player_id ASC
```

Overall score is derived:

```text
100*Easy + 200*Normal + 300*Hard + achievement points
```

Overall ordering:

```text
score DESC
hard_completions DESC
normal_completions DESC
easy_completions DESC
score_reached_at ASC
player_id ASC
```

`score_reached_at` is derived from the latest contributing unique-clear/achievement timestamp. No mutable total or materialized board.

APIs:

```text
GET /api/puzzle-families/:familyId/leaderboard?difficulty=normal&mode=standard
GET /api/leaderboard
```

Return top 50 plus the signed-in player's row when outside the top 50. Leaderboard identity exposes only `{ id, name, avatarUrl }`; never email.

## 14. Profile and Puzzle Results

Profile remains the progression home. Show score/rank, Easy/Normal/Hard unique counts, achievements, mastery totals/progress, and the existing Puzzle Results section.

`listPlayerStats()` is rewritten at **family+difficulty** grain. A result row contains family name, difficulty, Standard best, Rotation best, replay-inclusive completion count, first completion, and last completion. Preserve the existing bounded cursor/pagination style; do not silently delete this shipped screen when `puzzle_stats`/`puzzles` go away.

Summary semantics:

- `puzzlesUploaded`: owned families
- `puzzlesSolved`: distinct families with any difficulty clear
- `totalCompletions`: accepted completion runs including replays

## 15. Quick Puzzles

Quick Puzzles remain local, arbitrary-count, and outside families/account progression/leaderboards. Their upload UI and local schema are unchanged. Their current `puzzle-progress-q-*` keys remain valid.

## 16. Breaking Cutover and Operator Safety

Old arbitrary-count server puzzles cannot truthfully map to Easy/Normal/Hard, so content is regenerated from retained originals. Old completion history is reset rather than relabeled.

The operator sequence is:

```text
0. export full production D1 schema+data to a local backup
1. read-only export old puzzle metadata, owner IDs, and retained originals
2. verify exported manifest/image counts
3. deploy the family/progression code + D1 migrations
4. import old images through the new admin family-create path with preserved ownerId
5. wait until every replacement family has all 3 variants ready
6. verify family/variant counts and spot-check assets
7. one-shot delete leftover old puzzle:* KV and puzzles/<oldId>/ R2 objects
8. archive/remove local migration artifacts after acceptance
```

A concrete D1 backup command is documented in the runbook, using `wrangler d1 export ... --remote --output ...` against `apps/api/wrangler.production.toml`.

No permanent old-puzzle parser/list fallback is added. The one-shot exporter/cleanup script is operator tooling only.

### Risks and accepted trade-offs

- **Destructive D1 reset:** production D1 is exported before migration. Player profiles remain preserved; old completion/stat rows are intentionally not restored.
- **Temporary empty production gallery:** once family-only code is deployed, the public gallery is empty until imported families finish all three variants. This is accepted for the pre-release project and must be called out in the runbook.
- **Family cleanup blast radius:** deletion removes three boards plus shared image assets, so a real local create/delete gate is required before production cutover.
- **Workflow checkpoint identity:** difficulty-qualified step names are load-bearing; tests must pin them.
- **No user-save conversion:** old server save keys are ignored by namespace; Quick Puzzle saves survive.

## 17. Local Runtime Gate Before Production Migration

Before writing/executing the production cutover, prove the dangerous family lifecycle locally:

```text
apply local D1 migrations
start API + Workflow dev runtime
upload one square family through the local admin CLI
wait for ready
verify 16 / 49 / 100 variants with 4×4 / 7×7 / 10×10 grids
verify family thumbnail + shared reference + representative piece assets
family-delete it
verify family original/thumbnail are gone
verify all three piece prefixes are gone
verify family/variant metadata is gone and deletion fences completed
```

The gate must explicitly run `bun --cwd apps/api run db:migrate:local` before the dev runtime. Package-only unit tests are not sufficient for this protocol.

## 18. Delivery Boundary

This task remains one implementation PR. Catalog cutover and progression are organized as two internal phases/checkpoints, not two mergeable PRs.

Progression could technically be shipped later without a compatibility layer; the earlier claim that it is architecturally inseparable is intentionally withdrawn. The reason to keep one PR is the task's chosen delivery scope: difficulty, achievements, and leaderboards were designed as one pre-release feature, and this project prefers one PR per task unless explicitly approved otherwise.

The implementation should still keep Phase A (family cutover) green and locally runnable before Phase B (progression/leaderboards) is layered on top.

## 19. Acceptance Criteria

1. Every server family exposes exactly Easy/Normal/Hard at the approved rows×cols/counts.
2. Web/admin/mobile catalog identity is family; gameplay/download/session identity is variant.
3. One family Workflow generates all three variants with difficulty-qualified checkpoints.
4. Reaper/admin delete operate on a whole family while reusing the three existing variant deletion fences.
5. No D1 `puzzle_variants` table or second metadata DO exists.
6. Player-owned uploads remain visible at family grain with the existing cursor behavior.
7. Web family cards show independent progress/local-best state per difficulty.
8. NativeScript chooses difficulty then reuses concrete variant downloads.
9. V2 comes from `completionRequestFromSeal()` and same-run altered mastery facts conflict.
10. D1 is the only completion-write driver after the cutover.
11. Unique clears award 100/200/300 exactly once; mastery is non-scoring.
12. Nine global achievements unlock idempotently from pure predicates over durable progression state.
13. Standard and Rotation boards remain separate; assisted/relaxed never rank by time.
14. Overall score is derived, not stored.
15. Profile Puzzle Results survives at family+difficulty grain with both mode bests.
16. Quick Puzzle behavior and current keys remain unchanged.
17. Admin family delete stays on sibling `/api/admin/puzzle-family-delete/:familyId`, outside CLI service-token inheritance.
18. A local family create/delete runtime gate passes before production migration.
19. Production runbook starts with a D1 export and explicitly documents the temporary empty-gallery window.
