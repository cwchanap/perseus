# Player Profile Page — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Scope:** A private, self-only player profile page combining an editable identity card with an activity hub (created puzzles + solving stats), backed by a new D1 database shared via a `@perseus/shared` package.

---

## 1. Goals & Decisions

| Aspect            | Decision                                                                            |
| ----------------- | ----------------------------------------------------------------------------------- |
| Page focus        | **Full profile** — identity card + activity hub                                     |
| Solving stats     | **Server-side**, synced across devices, tied to the player                          |
| Puzzle ownership  | **Add ownership tracking** (`ownerId`); existing puzzles are **not** backfilled     |
| Profile editing   | **Editable** display name + avatar                                                  |
| Visibility        | **Private** — only the signed-in player views their own profile                     |
| Avatar            | **Image upload to R2** (`avatars/{playerId}`)                                       |
| Storage tier      | **D1** (Cloudflare, production) + `bun:sqlite` (Bun dev server), same schema        |
| ORM               | **Drizzle ORM** — single TypeScript schema, two drivers                             |
| Data-access layer | **New shared package `@perseus/shared`** (schema + repositories + driver factories) |

### Non-goals

- Public profiles / shareable profile URLs.
- Backfilling existing puzzles with ownership.
- Leaderboards or competitive ranking (D1 makes this possible later, but it is out of scope now).
- Editing Google-sourced email or identity fields other than display name/avatar.

---

## 2. Architecture Overview

```
┌─────────────────┐      ┌──────────────────────────────────────────────┐
│  apps/web       │      │  apps/api  (dual-runtime)                     │
│  /profile route │◀────▶│  player.ts        (Bun)   ← createBunDb      │
│  api.ts service │ HTTP │  player.worker.ts (Worker)← createD1Db       │
└─────────────────┘      │  puzzles.ts: upload writes ownership row      │
                          └────────────┬─────────────────────────────────┘
                                       │ imports
                          ┌────────────▼──────────────────────────────────┐
                          │  packages/shared  (@perseus/shared)            │
                          │   schema.ts · types.ts · repositories.ts       │
                          │   drivers/d1.ts · drivers/bun.ts               │
                          └────────────┬──────────────────────────────────┘
                                       │ Drizzle
                          ┌────────────▼──────────────────────────────────┐
                          │  D1  (prod)  /  bun:sqlite  (dev)              │
                          │  tables: player_profiles, puzzle_stats, puzzles│
                          └───────────────────────────────────────────────┘
```

The new feature follows the codebase's established **dual-runtime convention** (parallel `.ts` / `.worker.ts` files for Bun dev and Cloudflare Worker production). All relational player data lives in D1; existing KV/DO puzzle metadata is unchanged.

---

## 3. Data Model & Storage

### 3.1 New shared package `@perseus/shared`

Created at `packages/shared`, published as `@perseus/shared`. Dependencies: `drizzle-orm`, `drizzle-kit` (dev).

```
packages/shared/
  src/
    schema.ts           # Drizzle table definitions (pure — no runtime deps)
    types.ts            # types inferred from schema
    repositories.ts     # async query functions, each taking a `db` client
    drivers/
      d1.ts             # createD1Db(env)   → drizzle-orm/d1
      bun.ts            # createBunDb(dataDir) → drizzle-orm/bun-sql
    index.ts            # re-exports schema + types + repositories
  drizzle.config.ts
  drizzle/migrations/   # generated SQL migrations
  package.json
```

**`package.json` exports** (subpath exports keep the D1 driver out of Bun bundles and `bun:sqlite` out of Worker bundles):

```json
{
	"exports": {
		".": "./src/index.ts",
		"./d1": "./src/drivers/d1.ts",
		"./bun": "./src/drivers/bun.ts"
	}
}
```

### 3.2 Drizzle schema (`schema.ts`)

```ts
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const playerProfiles = sqliteTable('player_profiles', {
	playerId: text('player_id').primaryKey(),
	displayName: text('display_name'), // overrides Google name when non-null
	avatarUrl: text('avatar_url'), // overrides Google picture when non-null
	updatedAt: integer('updated_at').notNull()
});

export const puzzleStats = sqliteTable(
	'puzzle_stats',
	{
		playerId: text('player_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		bestTimeSeconds: integer('best_time_seconds').notNull(),
		totalCompletions: integer('total_completions').notNull().default(1),
		firstCompletedAt: integer('first_completed_at').notNull(),
		lastCompletedAt: integer('last_completed_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.playerId, t.puzzleId] }), index('idx_ps_player').on(t.playerId)]
);

export const puzzles = sqliteTable(
	'puzzles',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		name: text('name').notNull(),
		pieceCount: integer('piece_count').notNull(),
		category: text('category'),
		status: text('status').notNull().default('processing'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('idx_puzzles_owner').on(t.ownerId, t.createdAt)]
);
```

### 3.3 Key data-design choices

- **Effective identity** = `displayName ?? google.name`, `avatarUrl ?? google.picture`. Google data remains the source of truth for defaults; D1 holds only overrides. An unedited profile therefore works correctly with **zero** D1 rows.
- **`puzzles` is a denormalized summary** (mirrors the existing `PuzzleSummary` type). Full puzzle metadata stays in KV/DO. This keeps the profile page a single fast SQL query and avoids N KV reads. Existing puzzles are absent from D1 (no backfill) and therefore never appear on any profile.
- **Avatars** are stored in R2 under prefix `avatars/{playerId}` within the existing `PUZZLES_BUCKET`; `avatarUrl` stores the serving path.

### 3.4 Driver factories & cross-runtime repository contract

Driver creation is runtime-specific, so the factories live in the shared package behind subpath exports:

- `@perseus/shared/bun` → `createBunDb(dataDir)` uses `drizzle-orm/bun-sql` + `bun:sqlite`
- `@perseus/shared/d1` → `createD1Db(env)` uses `drizzle-orm/d1` + the `env.DB` binding

Each app/runtime does one line of driver wiring:

- `apps/api/src/db.ts` (Bun) → `createBunDb(process.env.DATA_DIR)`
- `apps/api/src/db.worker.ts` (Worker) → `createD1Db(c.env)`

**Cross-runtime contract:** `bun:sqlite` is synchronous while D1 is async. Therefore every repository function in `@perseus/shared` is `async` and **always `await`s** its Drizzle results. On Bun the awaited value unwraps instantly; on D1 it awaits the promise — identical call sites in both runtimes. Repository functions accept a generically-typed `db` client (against Drizzle's shared base interface); the concrete type is resolved at the app boundary.

### 3.5 Migrations

`drizzle-kit generate` produces versioned `packages/shared/drizzle/migrations/*.sql`. These are applied:

- to **D1** via `wrangler d1 migrations apply perseus-player-data`;
- to **Bun dev** SQLite via Drizzle's `migrate()` helper on server startup against `${DATA_DIR}/perseus.db`.

---

## 4. API Endpoints

New dual-runtime route file `apps/api/src/routes/player.ts` / `player.worker.ts`, mounted at `/api/player`. Every endpoint requires player auth (`requirePlayerAuth`). The completion-recording endpoint is mounted under the existing puzzles routes (at `/api/puzzles`) rather than the player mount, so it lives in `puzzles.ts` / `puzzles.worker.ts`.

| Method + path                    | Route file  | Purpose                                                                                                                                            |
| -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/player/profile`        | `player.*`  | Identity card data: effective name/avatar, email, join date, last login + **summary counts** (puzzles uploaded, puzzles solved, total completions) |
| `PATCH /api/player/profile`      | `player.*`  | Update `display_name` (nullable to reset to Google default)                                                                                        |
| `POST /api/player/avatar`        | `player.*`  | Upload avatar image → R2 `avatars/{playerId}` → returns `avatarUrl`                                                                                |
| `GET /api/player/puzzles`        | `player.*`  | Paginated list of puzzles owned by the player (from `puzzles` table)                                                                               |
| `GET /api/player/stats`          | `player.*`  | Paginated solving stats (best times, completions) for the player                                                                                   |
| `POST /api/puzzles/:id/complete` | `puzzles.*` | Record a solve (time in seconds) → atomic upsert into `puzzle_stats`                                                                               |

### 4.1 Integration with existing code

- **`POST /api/puzzles`** (upload): additionally writes a row to the `puzzles` table with `ownerId` = the session player's id, via the shared repository.
- **Workflow completion path** (`apps/workflows`): when generation finishes, update `puzzles.status` → `'ready'` in D1. The workflows worker gains a `DB` binding and uses `createD1Db`.

### 4.2 Completion recording semantics

The server performs an atomic best-time upsert:

```sql
INSERT INTO puzzle_stats (player_id, puzzle_id, best_time_seconds, total_completions,
                          first_completed_at, last_completed_at)
VALUES (?, ?, ?, 1, ?, ?)
ON CONFLICT(player_id, puzzle_id) DO UPDATE SET
  best_time_seconds  = MIN(excluded.best_time_seconds, puzzle_stats.best_time_seconds),
  total_completions  = puzzle_stats.total_completions + 1,
  last_completed_at  = excluded.last_completed_at;
```

Expressed via Drizzle (or its `sql` helper where needed for `MIN`/`ON CONFLICT`).

---

## 5. Web

### 5.1 New route `/profile`

`apps/web/src/routes/profile/+page.svelte` (`prerender = false`).

- **Auth guard** in `routes/profile/+layout.ts` load hook: if `playerAuth` is anonymous, redirect to `/login` (mirrors the admin layout guard, but for players).
- **Identity card**: avatar (image, with initials fallback before upload), effective name, email, join date, last login. An **Edit** toggle reveals: display-name input (with "reset to Google default") and an avatar file picker that uploads to `POST /api/player/avatar` (reuses the upload page's `FormData` pattern).
- **Summary stat tiles**: puzzles uploaded · puzzles solved · total completions.
- **"My Puzzles" grid**: reuses `PuzzleCard`, cursor-paginated (same infinite-scroll pattern as the gallery).
- **"Best Times" list**: puzzle name · best time · completions, paginated.

### 5.2 Web service additions (`apps/web/src/lib/services/api.ts`)

Following the existing `fetch` + `ApiError` + `credentials: 'include'` pattern:

`getPlayerProfile`, `updatePlayerProfile`, `uploadPlayerAvatar`, `getPlayerPuzzles`, `getPlayerStats`, `recordCompletion`.

### 5.3 Completion recording hook

At `apps/web/src/routes/puzzle/[id]/+page.svelte:465` — where `saveCompletionTime` currently runs on first completion — additionally call `recordCompletion(puzzle.id, elapsed)`.

- **Fire-and-forget**: no `await`; failures are logged and never block the celebration UI.
- localStorage stats (`stats.ts`) remain as the **offline fallback**; D1 is the source of truth.

### 5.4 Navigation

In `apps/web/src/routes/+layout.svelte`, the existing player-name span becomes a link to `/profile`, and a `→ PROFILE` link is added alongside QUICK PUZZLE / UPLOAD.

### 5.5 Shared types (`packages/types`)

New exported types + validators (matching the existing `isPlayerUser` style):

- `PlayerProfile` — effective identity + summary counts
- `PlayerProfileUpdate` — `{ displayName?: string | null }`
- `PlayerPuzzleSummary` — the D1 puzzle row shape
- `PlayerStatRow` — `{ puzzleId, bestTimeSeconds, totalCompletions, firstCompletedAt, lastCompletedAt }`
- Corresponding type guards / validators.

---

## 6. Infrastructure

### 6.1 Pulumi (`packages/infrastructure`)

- `config.ts`: add `d1Database: 'perseus-player-data'` to `naming`.
- `resources.ts`: add `createD1Database()` → `new cloudflare.D1Database('player-data', { accountId, name: naming.d1Database })`.
- `workers.ts`: extend `WorkerBindings` with `d1Databases?: Array<{ binding: string; databaseId: pulumi.Input<string> }>`; handle the `d1_database` binding type in `buildVersionBindings`.
- `index.ts`: create the D1 database once; wire a `DB` binding into `commonBindings` so **both** the API worker and the workflows worker receive it.

### 6.2 wrangler config

- `apps/api/wrangler.toml` (+ `wrangler.production.toml`): add `[[d1_databases]]` → binding `DB`, database `perseus-player-data` (production config carries the real `database_id`); add the `env.dev` override.
- `apps/workflows/wrangler.toml` (+ production): add the same `DB` binding.

---

## 7. Testing

Following existing conventions:

- **`@perseus/shared`**: repository tests against in-memory `bun:sqlite` — fast and exercises the exact SQL D1 will run.
- **API**: `player.test.ts` (Bun, temp `bun:sqlite` DB) / `player.worker.test.ts` (miniflare D1) covering the five `/api/player/*` endpoints; the `POST /api/puzzles/:id/complete` endpoint is tested in the puzzles test files; an updated `POST /api/puzzles` test asserting an ownership row is written.
- **Web**: `profile/page.svelte.test.ts` (browser-mode Vitest) for identity/edit/lists; `api.test.ts` additions for the six new service functions; assertion that the completion hook calls `recordCompletion`; a Playwright `profile.spec.ts` e2e covering the view + edit flow.

---

## 8. Out of scope / future

- Backfilling existing puzzles with ownership.
- Public profiles.
- Leaderboards (D1 + the `puzzle_stats` table make this a natural future addition).
- Migrating existing KV/DO puzzle metadata into D1.
