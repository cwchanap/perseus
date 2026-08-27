# Puzzle Difficulty, Achievements, and Leaderboards Design

Date: 2026-08-26

## Summary

Perseus currently treats each server puzzle as one concrete generated board with one piece count. That makes the existing roughly-100+ piece experience too difficult as the only option and gives players little long-term progression beyond individual completion stats.

This design adds three fixed piece-count difficulty tiers, global achievements, non-scoring per-puzzle mastery, per-puzzle competitive time leaderboards, and an overall score leaderboard.

The core architectural decision is to introduce a player-facing **puzzle family** that owns one image and three concrete **puzzle variants**. Each variant remains an ordinary fixed-grid puzzle with its own puzzle ID, generated pieces, saved session, completion runs, and competitive best times. The gameplay engine continues to operate on one concrete puzzle ID and does not become difficulty-aware beyond receiving that variant's fixed metadata.

The feature intentionally makes a clean break from the old standalone server-puzzle model. Existing server puzzles are regenerated into three new variants from their retained original images; old local saves and completion history are reset rather than carried through legacy branches.

## Goals

- Make every server puzzle available at Easy, Normal, and Hard difficulty.
- Define difficulty only by piece count/grid size; timed/relaxed mode, rotation, hints, and reference tools remain independent gameplay settings.
- Keep the current puzzle-session engine centered on one immutable board shape.
- Add meaningful replay value without a grind loop.
- Add per-puzzle competitive rankings for Standard and Rotation timed runs.
- Add an overall ranking driven primarily by unique puzzle completions, with small achievement bonuses.
- Reuse the existing player profile identity for leaderboard display.
- Keep local Quick Puzzles independent from server progression.

## Non-goals

The first release does not add:

- daily/weekly/monthly leaderboards or seasons
- streaks or recurring quests
- configurable achievement rules or an achievement DSL
- XP/levels separate from leaderboard score
- currencies or achievement rewards
- category-completion achievements
- time-threshold achievements
- mastery score
- assisted or relaxed time leaderboards
- country/friends-only rankings
- live/WebSocket leaderboard updates
- anti-cheat machinery
- percentile calculations
- backward-compatible runtime handling for old server puzzles, saves, or completion records

## 1. Difficulty Model

Difficulty is piece count only.

| Difficulty | 1:1 | 4:3 | 3:4 |
| --- | ---: | ---: | ---: |
| Easy | 4x4 = 16 | 4x3 = 12 | 3x4 = 12 |
| Normal | 7x7 = 49 | 8x6 = 48 | 6x8 = 48 |
| Hard | 10x10 = 100 | 12x9 = 108 | 9x12 = 108 |

These counts satisfy the existing aspect-ratio grid rules and keep the current roughly-100-piece experience as the Hard tier while introducing substantially more approachable Easy and Normal tiers.

Use one shared hard-coded definition in `@perseus/types`, conceptually:

```ts
export const PUZZLE_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PuzzleDifficulty = (typeof PUZZLE_DIFFICULTIES)[number];

export const DIFFICULTY_PIECE_COUNTS = {
  easy: { '1:1': 16, '4:3': 12, '3:4': 12 },
  normal: { '1:1': 49, '4:3': 48, '3:4': 48 },
  hard: { '1:1': 100, '4:3': 108, '3:4': 108 }
} as const;
```

Do not store these values in D1 or make them admin-configurable.

Rotation, hints, reference modes, and timed/relaxed mode keep their current semantics. Easy does not automatically disable rotation or enable assistance, and Hard does not force rotation.

## 2. Puzzle Family and Variant Model

### 2.1 Puzzle family

A `PuzzleFamily` is the player-facing identity of one uploaded image. Gallery cards, ownership, category, original image, thumbnail, and family-level progression use this identity.

Conceptually:

```ts
interface PuzzleFamilyMetadata {
  id: string;
  name: string;
  category?: PuzzleCategory;
  aspectRatio: PuzzleAspectRatio;
  createdAt: number;
  status: 'processing' | 'ready' | 'failed';
  variants: {
    easy: string;
    normal: string;
    hard: string;
  };
}
```

The three variant IDs are allocated once when the family is created and reused by workflow retries.

### 2.2 Puzzle variant

A `PuzzleVariant` is one concrete playable board. It keeps a separate puzzle ID and the existing fixed-grid metadata required by `PuzzleSession`.

Each variant adds two immutable identity fields to the current puzzle metadata shape:

```ts
familyId: string;
difficulty: PuzzleDifficulty;
```

Each variant owns:

- piece count
- grid rows/columns
- generated piece assets
- saved session
- completion runs
- competitive best times

The family owns the image-level metadata; variants do not become a second player-facing catalog.

### 2.3 Gameplay boundary

`PuzzleSession` remains variant-based. It continues to receive one concrete `puzzleId`, `pieceCount`, `gridRows`, `gridCols`, and piece list.

Do not add mutable difficulty to session setup and do not key saves by `familyId + difficulty`. The selected difficulty is resolved to a concrete variant before the session is created.

This preserves the existing validation rule that a puzzle ID uniquely identifies one board geometry.

## 3. Storage Ownership

### 3.1 KV and Durable Object metadata

Keep the current variant metadata path and Durable Object consistency model for concrete puzzles:

```text
family:<familyId>        -> puzzle family metadata
puzzle:<variantId>       -> concrete variant metadata
```

The existing metadata Durable Object machinery remains the consistency primitive for mutable processing metadata. Do not introduce a second generic coordination framework.

The family is considered player-ready only when all three variants are ready:

```text
all variants ready      -> family ready
any terminal failure    -> family failed
otherwise               -> family processing
```

The gallery lists families rather than individual variant records. No partially playable family UI is required in v1.

### 3.2 R2 layout

Store shared image assets once per family and generated pieces once per variant:

```text
families/<familyId>/original
families/<familyId>/thumbnail.jpg

puzzles/<variantId>/pieces/0.png
puzzles/<variantId>/pieces/1.png
...
```

Variant reference-image requests resolve `variantId -> familyId` and serve the family original. Gallery thumbnails use the family thumbnail.

### 3.3 D1 ownership/catalog mirror

Replace the old standalone `puzzles` ownership mirror with explicit family and variant rows:

```text
puzzle_families
  id                 PK
  owner_id
  name
  category           nullable
  aspect_ratio
  status
  created_at

puzzle_variants
  id                 PK
  family_id
  difficulty
  piece_count
```

`(family_id, difficulty)` is unique.

D1 remains a query/ownership/progression store. KV/DO remains authoritative for live puzzle processing metadata.

Profile semantics after the migration:

- `puzzlesUploaded` = number of puzzle families owned by the player
- `puzzlesSolved` = number of distinct families on which the player has completed at least one difficulty
- `totalCompletions` = accepted completion runs, preserving its existing meaning as replay-inclusive activity

## 4. Upload and Generation Flow

### 4.1 New uploads

Server uploads no longer accept an arbitrary piece count. They accept:

- image
- name
- optional category
- aspect ratio

The server derives all three variant specs from `DIFFICULTY_PIECE_COUNTS`.

Creation flow:

```text
upload image
   |
   +-- allocate family ID
   +-- allocate Easy/Normal/Hard variant IDs
   +-- store original once
   +-- create shared thumbnail once
   +-- create family + ownership records
   +-- start one family workflow
            |
            +-- generate Easy pieces
            +-- generate Normal pieces
            +-- generate Hard pieces
            +-- mark all variants ready
            +-- mark family ready
```

Use one Cloudflare Workflow instance per family. Do not spawn one workflow per difficulty and add another coordinator.

The workflow may reuse existing piece-generation helpers for each variant. It should load/decode the original image once per workflow execution where practical.

### 4.2 Failure and retry

If any variant generation fails:

- mark the family failed
- retain the family original
- keep already-generated variant assets rather than rolling back a distributed R2/KV transaction
- retry only missing/failed work where the existing workflow retry structure makes that straightforward
- never publish the family to the playable gallery until all three variants are ready

Existing cleanup/reaper behavior should be extended to family/variant assets rather than replaced with a new transaction system.

### 4.3 Upload UI and seed catalog

The player/server upload page removes the piece-count selector.

The startup seed catalog removes `pieceCount`; every seed image receives all three difficulties automatically:

```ts
interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  aspectRatio: PuzzleAspectRatio;
}
```

## 5. Gallery and Difficulty UX

The gallery renders one card per puzzle family.

A family card exposes a compact difficulty picker before navigation to gameplay. Selecting a difficulty resolves the matching variant ID and navigates to the existing variant-based gameplay route.

The card or adjacent family action may expose the family leaderboard. The exact modal/page container should follow existing UI composition patterns; this design does not require a new generic family-screen framework.

Difficulty labels should always show both the tier and piece count, for example:

```text
Easy · 16 pieces
Normal · 49 pieces
Hard · 100 pieces
```

This avoids making the abstract tier name the only cue.

## 6. Completion Contract

### 6.1 Version 2 request

The current server completion payload does not contain the immutable completion facts needed for Hintless/Flawless mastery. Introduce a clean V2 contract.

Only submit facts required by the initial server-side rules:

```ts
interface RecordPuzzleCompletionV2 {
  version: 2;
  runId: string;
  resultClass: ResultClass;
  elapsedActiveSeconds: number | null;
  hintsUsed: number;
  incorrectAttempts: number;
}
```

`rotationEnabled` and `rotationUsed` are intentionally not duplicated in V2: the initial server rules only need `resultClass === 'rotation_timed'` for Rotation Clear, and redundant client fields would create unnecessary consistency checks.

The server derives `familyId` and `difficulty` from the submitted variant puzzle ID. The client must not submit difficulty, score, or family ID as redundant authority.

### 6.2 Completion eligibility

All accepted authenticated server completions can contribute to progression:

- `standard_timed`: progression + Standard leaderboard eligibility
- `rotation_timed`: progression + Rotation leaderboard eligibility
- `assisted_timed`: progression only
- `relaxed`: progression only

Anonymous/local completion continues to work as local gameplay/stat behavior but does not create account-level achievements, score, mastery, or leaderboard entries. No retroactive anonymous-to-account sync is required in v1.

### 6.3 Completion response

The completion response may include the low-cost deltas needed by the completion dialog:

- whether first-clear points were awarded for this family+difficulty
- newly unlocked achievement IDs
- newly earned mastery badges
- personal-best status/best time when competitively eligible
- current competitive rank when cheaply available

A lost response followed by an idempotent retry does not need to replay the exact original unlock animation. Durable profile/progression state is authoritative; transient celebration UI is best-effort.

Network/submission failure never blocks local puzzle completion.

## 7. D1 Progression and Ranking Tables

The migration is a clean reset, so remove legacy completion shapes that only existed to preserve old history. The new tables can encode the current rules directly.

### 7.1 Completion runs

```text
puzzle_completion_runs
  player_id
  run_id
  puzzle_id            -- variant ID
  result_class
  elapsed_active_seconds nullable for relaxed
  hints_used
  incorrect_attempts
  completed_at

PRIMARY KEY (player_id, run_id)
```

Keep the current run-ID idempotency/conflict semantics.

### 7.2 Competitive best times

```text
puzzle_best_times
  player_id
  puzzle_id            -- variant ID
  result_class         -- only standard_timed / rotation_timed
  best_time_seconds
  achieved_at

PRIMARY KEY (player_id, puzzle_id, result_class)
```

Index `(puzzle_id, result_class, best_time_seconds, achieved_at)` for top-time queries.

Only `standard_timed` and `rotation_timed` create/update these rows.

### 7.3 Unique difficulty completions

```text
player_difficulty_completions
  player_id
  family_id
  difficulty
  first_completed_at

PRIMARY KEY (player_id, family_id, difficulty)
```

This primary key implements the award-once rule without a separate points ledger.

### 7.4 Achievements

```text
player_achievements
  player_id
  achievement_id
  unlocked_at

PRIMARY KEY (player_id, achievement_id)
```

Achievement definitions and point values live in application constants, not a database table.

### 7.5 Mastery

```text
player_variant_mastery
  player_id
  puzzle_id            -- variant ID
  badge
  earned_at

PRIMARY KEY (player_id, puzzle_id, badge)
```

Allowed initial badges are `hintless`, `flawless`, and `rotation_clear`.

## 8. Overall Score

Completion points are awarded once per family+difficulty:

| Difficulty | Points |
| --- | ---: |
| Easy | 100 |
| Normal | 200 |
| Hard | 300 |

Replays never add overall completion points. They remain useful for personal-best times and mastery.

Overall score is derived, not stored in a mutable ledger:

```text
100 * unique Easy completions
+ 200 * unique Normal completions
+ 300 * unique Hard completions
+ achievement bonus points
```

No daily score, streak multiplier, repeat-completion multiplier, or XP system is added.

## 9. Achievement Catalog

Launch with one fixed global catalog:

| ID | Requirement | Points |
| --- | --- | ---: |
| `first_clear` | Complete any family+difficulty | 25 |
| `getting_started` | Complete 5 unique family+difficulty variants | 50 |
| `puzzle_regular` | Complete 15 unique family+difficulty variants | 100 |
| `full_set` | Complete Easy + Normal + Hard for one family | 75 |
| `hard_mode` | Complete any Hard variant | 50 |
| `hard_veteran` | Complete 5 unique Hard variants | 100 |
| `hintless` | Earn Hintless mastery once | 25 |
| `flawless` | Earn Flawless mastery once | 25 |
| `rotation_clear` | Earn Rotation Clear mastery once | 25 |

Maximum initial achievement bonus is 475 points, less than the 600 points earned by completing all three difficulties of one additional family. This keeps catalog completion as the primary overall-ranking driver.

Do not add arbitrary solve-time achievements until real timing data exists.

## 10. Per-Variant Mastery

Each family+difficulty can display three non-scoring mastery badges:

- **Hintless**: complete with `hintsUsed === 0`
- **Flawless**: complete with `incorrectAttempts === 0`
- **Rotation Clear**: complete with `resultClass === 'rotation_timed'`

Badges may be earned across different runs; one perfect run is not required.

Assisted or relaxed runs may earn Hintless/Flawless when the factual condition is satisfied. Rotation Clear specifically requires a competitive Rotation timed completion.

Mastery is intentionally non-scoring so replay/completionism does not distort the overall leaderboard.

## 11. Achievement Evaluation

On each accepted authenticated completion, the server performs one bounded progression update:

```text
record completion run
   |
   +-- insert first family+difficulty completion if absent
   +-- update competitive best time if eligible
   +-- insert newly satisfied mastery badges
   +-- evaluate the fixed achievement catalog
```

Unique constraints make these writes idempotent under completion retries.

Achievement predicates are ordinary application functions/queries. Do not build a rule interpreter.

## 12. Per-Puzzle Competitive Leaderboards

Every family has two competitive boards per difficulty:

| Difficulty | Standard | Rotation |
| --- | --- | --- |
| Easy | yes | yes |
| Normal | yes | yes |
| Hard | yes | yes |

Selectors choose difficulty and mode; the UI renders one table at a time.

Only each player's best eligible time appears.

Ranking order:

```text
best_time_seconds ASC
achieved_at ASC
player_id ASC
```

Whole-second timing remains unchanged. Do not add millisecond timing only to reduce ties.

API shape:

```text
GET /api/puzzle-families/:familyId/leaderboard
    ?difficulty=normal
    &mode=standard
```

Return the top 50 plus the signed-in player's own row/rank when outside the top 50. No pagination is required in v1.

## 13. Overall Leaderboard

Overall ranking order:

```text
score DESC
hard_completions DESC
normal_completions DESC
easy_completions DESC
score_reached_at ASC
player_id ASC
```

`hard/normal/easy_completions` count unique family+difficulty first completions.

`score_reached_at` is derived as the latest timestamp among the scoring completion and achievement rows that make up the player's current score. Do not store a separate mutable score timestamp solely for tie-breaking.

API shape:

```text
GET /api/leaderboard
```

Return the top 50 plus the signed-in player's own row/rank when needed.

At the current expected scale, calculate this from D1 rather than introducing a materialized leaderboard table. Add caching/materialization only if measurement later shows the aggregate query is a problem.

## 14. Player Identity and Privacy

Reuse the existing player profile identity:

- display-name override when present
- existing avatar when present
- initials fallback in UI

Leaderboard APIs expose only a narrow public projection:

```ts
interface LeaderboardPlayer {
  id: string;
  name: string;
  avatarUrl: string | null;
}
```

Never expose player email addresses in leaderboard responses.

Do not add separate usernames, handles, uniqueness rules, friend codes, or leaderboard-specific profile settings.

## 15. UX Surfaces

### 15.1 Top-level navigation

Add one `Leaderboard` entry next to Gallery/Profile. It defaults to Overall.

### 15.2 Family leaderboard

A family leaderboard uses two compact selectors:

```text
[ Easy ] [ Normal ] [ Hard ]
[ Standard ] [ Rotation ]
```

Then renders the top-time table plus a separated `YOU` row if the signed-in player is outside the top 50.

### 15.3 Completion dialog

Show only progression earned from the just-completed run, for example:

```text
PUZZLE COMPLETE
Normal · 48 pieces
08:42

+200 First Normal Clear

ACHIEVEMENT UNLOCKED
Full Set +75

MASTERY EARNED
Flawless
```

For an eligible competitive run, also show personal-best/rank feedback when available.

### 15.4 Profile

Extend the existing profile rather than creating a separate achievements application. Show:

- overall score and rank
- Easy/Normal/Hard unique completion counts
- achievement progress
- mastery count/progress
- existing/reworked puzzle result summaries

## 16. Local Quick Puzzles

Quick Puzzles keep their current independent local model:

```text
image + user-selected piece count -> one local puzzle
```

They do not gain:

- puzzle families
- fixed Easy/Normal/Hard tiers
- account progression
- achievements
- mastery
- server leaderboards

Their existing custom piece-count selector and local schema remain unchanged.

## 17. Breaking Migration

### 17.1 Existing server puzzles

Existing server puzzles may use arbitrary valid piece counts, including values such as 192 or 225, so they cannot truthfully be relabeled as the new Hard tier.

Perform a one-shot destructive content migration:

1. enumerate old server puzzle metadata and ownership
2. read each retained original image
3. create a new family preserving name/category/owner/aspect ratio
4. allocate three new variant IDs
5. generate Easy/Normal/Hard variants from the original
6. verify the family is ready
7. delete the old standalone puzzle metadata/assets after the replacement family is ready

This migration logic is an operator-only one-shot artifact and must not become permanent runtime compatibility code.

### 17.2 Existing saved progress

Existing browser saves are keyed by concrete old puzzle IDs and describe old board geometry. They are not convertible to the new variants.

Bump the web save namespace, for example:

```text
old: puzzle-progress-<oldPuzzleId>
new: puzzle-progress-v2-<variantId>
```

Old saves are intentionally ignored. Do not write placement-conversion logic.

### 17.3 Existing completion/progression history

Reset old puzzle completion history during the breaking migration.

Old runs may represent arbitrary piece counts, old aggregate stats do not distinguish the new competitive boards cleanly, and old server payloads do not contain the facts required for the new mastery system. Mapping those records to Easy/Normal/Hard would manufacture semantics that did not exist.

Reset/rebuild these puzzle-progression tables:

- `puzzle_completion_runs`
- old `puzzle_stats`
- new `puzzle_best_times`
- `player_difficulty_completions`
- `player_achievements`
- `player_variant_mastery`

Player account/profile identity is preserved.

No `legacy` difficulty is introduced.

## 18. API Surface

Family/catalog APIs:

```text
GET  /api/puzzle-families
GET  /api/puzzle-families/:familyId
POST /api/puzzle-families
```

Concrete gameplay APIs remain variant-oriented:

```text
GET  /api/puzzles/:variantId
POST /api/puzzles/:variantId/complete
```

Leaderboard APIs:

```text
GET /api/puzzle-families/:familyId/leaderboard?difficulty=<...>&mode=<...>
GET /api/leaderboard
```

Do not introduce a generic `/rankings/:type` or `/progression/events` framework.

## 19. Testing Strategy

Keep tests focused on the existing ownership boundaries.

### Shared types/grid

- each aspect ratio maps Easy/Normal/Hard to the approved piece count/grid
- all difficulty counts satisfy the existing aspect-ratio grid validation
- family/variant metadata validation rejects inconsistent family/difficulty identities
- V2 completion request validation covers relaxed/null timing and timed integer timing

### Workflow/storage

- one upload allocates exactly three stable variants
- workflow generates all three approved grids
- family becomes ready only after all three variants are ready
- one failed variant keeps the family out of the playable gallery
- retries reuse allocated variant IDs rather than minting duplicate variants
- shared original/thumbnail are family-scoped; piece assets are variant-scoped
- family deletion cleans family and variant assets/metadata

### Completion/progression repository

- first family+difficulty completion inserts once and awards points once
- replay does not create another scoring completion
- Standard timed updates only Standard best time
- Rotation timed updates only Rotation best time
- assisted/relaxed never enter competitive best-time rows
- mastery inserts are idempotent
- each fixed achievement unlocks at its exact predicate boundary
- run-ID retries remain idempotent/conflicting exactly as specified

### Leaderboards

- per-puzzle ordering uses time, achievedAt, then playerId
- overall ordering uses score, Hard, Normal, Easy, scoreReachedAt, playerId
- one player occupies at most one row per competitive board
- top-50 response includes a separate signed-in player rank outside the top 50
- leaderboard identity never exposes email

### Web

- gallery shows one family card, not three variant cards
- difficulty picker resolves the correct variant and piece count
- save persistence remains variant-ID based under the new namespace
- completion dialog renders first-clear/achievement/mastery deltas
- profile renders score/rank/difficulty counts/achievement/mastery summaries
- Quick Puzzle behavior remains unchanged

### Migration

- representative old arbitrary-piece-count puzzle regenerates into all three fixed tiers
- old save namespace is ignored after cutover
- old completion history is not assigned to new difficulties
- no runtime code path accepts a `legacy` difficulty

## 20. Acceptance Criteria

The feature is complete when:

1. Every server puzzle family exposes exactly Easy, Normal, and Hard using the approved piece counts.
2. Gallery listing is one family card per image.
3. Choosing a difficulty starts the matching concrete variant without making `PuzzleSession` itself difficulty-mutable.
4. New server uploads and startup seeds generate all three tiers eagerly.
5. Existing server content is regenerated through the one-shot migration; old saves and completion history are intentionally reset.
6. Authenticated completion of a family+difficulty awards 100/200/300 points once, regardless of eligible play style.
7. Replays award no additional completion points.
8. The nine fixed achievements unlock once and add their approved bonus points.
9. Hintless, Flawless, and Rotation Clear mastery can be earned per variant and add no score.
10. Standard and Rotation timed runs have separate top-50 family+difficulty leaderboards.
11. Assisted and relaxed runs never enter time leaderboards but still count for progression.
12. Overall leaderboard ranks by derived score with the approved tie-breakers.
13. Leaderboard rows reuse display name/avatar and never expose email.
14. Profile shows overall progression and rank using the existing player identity.
15. Quick Puzzles remain outside the family/progression/leaderboard system.
16. No permanent legacy-compatibility, generic achievement engine, materialized score ledger, or generic ranking framework is introduced.

## 21. Design Rationale

The central KISS decision is to preserve the existing invariant that one puzzle ID means one concrete board. Difficulty is implemented by choosing among three concrete variants, not by teaching every gameplay/persistence/completion path to understand a compound mutable board identity.

The central progression decision is to derive score from unique completion and achievement rows rather than maintain an event ledger or mutable total. Unique database keys enforce the anti-farming rules naturally.

The central migration decision is to reset incompatible history instead of carrying a permanent `legacy` concept. Perseus has no backward-compatibility requirement for real users, so preserving old arbitrary-piece semantics would increase implementation and maintenance cost without product value.
