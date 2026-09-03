# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

This is a Turborepo monorepo using Bun as the package manager.

```bash
# Install dependencies
bun install

# Apply local D1 migrations (required once after install, and after any
# migration in packages/shared/drizzle, before `bun run dev` will serve
# DB-backed paths: /api/player/*, /api/puzzles/:id/complete, authenticated
# upload ownership). Wrangler does not auto-apply D1 migrations on `wrangler dev`.
cd apps/api && bun run db:migrate:local

# Development (runs web + API concurrently; API embeds the workflows worker)
bun run dev

# Run specific app
bun run dev --filter=@perseus/web            # Vite dev server on :4692
bun run dev --filter=@perseus/api            # Multi-worker wrangler dev on :4690 (API + workflows worker)
bun run dev:standalone --filter=@perseus/workflows  # Standalone workflows worker (rarely needed)
bun run --cwd apps/mobile ios                # NativeScript iOS app (requires Xcode toolchain)

# Build / type check / lint / format
bun run build
bun run check          # tsc --noEmit + svelte-check
bun run lint           # prettier --check + eslint per workspace
bun run format         # prettier --write across the repo

# Root-level `scripts/` have their own tasks (not part of turbo)
bun run check:scripts
bun run lint:scripts
bun run test:scripts   # bun test scripts/
bun run test:shell     # bash scripts/verify-tarball-paths.test.sh
```

### Tests

```bash
bun run test         # turbo `test` task: api, workflows, web, shared, infrastructure
bun run test:unit    # turbo `test:unit` task: the above PLUS types, game-core, mobile
bun run test:e2e     # Playwright, web app only
```

`test` and `test:unit` are **not** interchangeable — `packages/types`, `packages/game-core`,
and `apps/mobile` only define `test:unit`, so `bun run test` silently skips them. Use
`bun run test:unit` when touching shared engine or type code.

Per-workspace and single-test runs:

```bash
cd apps/api && bun run test:watch                       # vitest watch

# Append a file path or a `-t <name>` filter after `--`; it lands on the vitest invocation
bun run --cwd apps/api test -- src/routes/leaderboard.worker.test.ts
bun run --cwd apps/workflows test -- src/helpers.test.ts -t 'some test name'
bun run --cwd packages/game-core test:unit -- src/session/session.test.ts
bun run --cwd packages/shared test -- src/__tests__/repositories.d1.test.ts
bun run --cwd apps/mobile test:unit -- -t 'some test name'   # file glob is fixed by the script

# Web unit tests run in Playwright browser mode; pass a file or -t filter the same way
bun run --cwd apps/web test:unit -- src/routes/page.svelte.test.ts

# Single E2E spec / single test
bun run --cwd apps/web test:e2e -- gallery.spec.ts
bun run --cwd apps/web test:e2e -- --grep 'restores a saved session'
```

## Architecture

### Monorepo Structure

- `apps/web` — SvelteKit frontend (static adapter), Tailwind CSS v4
- `apps/mobile` — NativeScript + svelte-native iOS/Android app sharing the gameplay engine
- `apps/api` — Hono HTTP API on Cloudflare Workers; also serves the built web assets
- `apps/workflows` — Cloudflare Workflows for async puzzle piece generation + `PuzzleMetadataDO`
- `packages/types` — Shared types, constants, and pure validation/geometry helpers
- `packages/game-core` — Platform-agnostic puzzle session engine shared by web and mobile
- `packages/shared` — D1/Drizzle schema, migrations, repositories, progression, image helpers
- `packages/infrastructure` — Pulumi IaC for Cloudflare deployment

Three layers are shared across apps and are the reason most changes touch more than one workspace:
`@perseus/types` (pure data + geometry), `@perseus/game-core` (gameplay behavior), and
`@perseus/shared` (server-side persistence). Web and mobile depend on the first two; API and
workflows depend on the first and third.

### Shared Gameplay Engine (`@perseus/game-core`)

The puzzle session — placement, history/undo, hints, inventory, rotation, geometry, run-id
generation, and the save-file codec — lives here as **pure TypeScript with no browser or
NativeScript globals** (`packages/game-core/src/index.ts` documents this contract). Platform
concerns are injected by each app:

- `Clock` (`src/runtime.ts`) — a default implementation over `performance.now`/`setInterval`;
  tests and NativeScript inject their own.
- `SessionKeyValueStore` (`src/session/storage.ts`) — web backs it with `localStorage`
  (`apps/web/src/lib/services/gameplay/session/persistence.ts`), mobile with the native file
  system (`apps/mobile/app/gameplay/sessionFiles.ts`).
- `RunIdCrypto` (`src/session/runId.ts`) — web uses browser crypto; mobile resolves native
  crypto in `apps/mobile/app/gameplay/runtime.ts`.

When changing gameplay rules, change them here — not in a single app — and run
`bun run test:unit` so both platform wrappers are exercised. `src/session/codec.ts` is a
versioned persistence format; changing it affects saved sessions on both platforms.

### Web App (`@perseus/web`)

- SvelteKit static adapter (SSG). `/puzzle/[id]` and `/profile` set `prerender = false`;
  `/quick` is prerendered.
- Routes: gallery (`/`), puzzle (`/puzzle/[id]`), quick puzzle (`/quick`), leaderboard, login,
  profile, upload, admin.
- `/quick` generates a puzzle entirely client-side (`src/lib/services/quickPuzzle/`) using the
  same `@perseus/types` mask/geometry code the workflow uses server-side — no API required.
- `src/lib/services/gameplay/` wraps `@perseus/game-core` with browser adapters, and is the seam
  the E2E harness overrides via a virtual module (`virtual:perseus-gameplay-runtime-override`).
- Testing: Vitest in **browser mode** via Playwright/Chromium for Svelte component tests; E2E via
  Playwright.

### Mobile App (`apps/mobile`)

NativeScript + `@nativescript-community/svelte-native` (Svelte 4, pinned via `overrides` — it is
deliberately a different Svelte major than the web app's Svelte 5). Structure:

- `app/gameplay/` — canvas rendering (`@nativescript/canvas`), tray, viewport, sheets, and the
  session store built on `@perseus/game-core`
- `app/library/` — gallery, downloaded-puzzle library, download manifest/store for offline play
- `app/api/` — REST client against the same API worker, over native HTTP

Mobile defines only `test:unit` and no `lint`/`check` script, so root `lint`/`check`/`test` skip
it. Verify mobile changes with `bun run --cwd apps/mobile test:unit`.

### API (`@perseus/api`)

Hono on Cloudflare Workers for both local development and production. `src/worker.ts` is the HTTP
entry and mounts the route groups:

| Mount                  | File                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `/api/puzzles`         | `src/routes/puzzles.worker.ts`, `puzzles.complete.worker.ts`       |
| `/api/puzzle-families` | `src/routes/puzzle-families.worker.ts`                             |
| `/api/leaderboard`     | `src/routes/leaderboard.worker.ts`                                 |
| `/api/admin`           | `src/routes/admin.worker.ts`                                       |
| `/api/auth`            | `src/routes/auth.worker.ts` (Google OAuth → signed player session) |
| `/api/player`          | `src/routes/player.worker.ts`                                      |

Naming convention: `*.worker.ts` files hold Worker-runtime implementations (routes, services,
middleware); `*.shared.ts` holds runtime-agnostic logic those files reuse and that unit tests can
exercise directly (e.g. `services/player-auth.shared.ts`, `routes/puzzles.complete.shared.ts`).

Middleware in `src/middleware/`: `player-auth.worker.ts` (required session),
`optional-player-auth.worker.ts` (anonymous-tolerant), `rate-limit.worker.ts`.

Local development runs via Wrangler (`bun run dev --filter=@perseus/api`) on
`http://localhost:4690`, with local D1, KV, R2, Durable Object, and Workflow bindings — no second
runtime. The Worker also serves static web assets via `env.ASSETS` (Cloudflare Workers Assets
binding), acting as a combined API + static file server in production.

In production, puzzle creation triggers a Cloudflare Workflow (`PUZZLE_WORKFLOW` binding) for
async piece generation. The Durable Object `PuzzleMetadataDO` (defined in `apps/workflows`)
provides strongly consistent metadata updates, with KV as an eventually consistent read cache.

### Workflows (`@perseus/workflows`)

Runs on Cloudflare Workers. Contains:

- `PerseusWorkflow` (`WorkflowEntrypoint`) — processes uploaded images into jigsaw pieces
  row-by-row with checkpoint progress tracking stored in KV/DO
- `PuzzleMetadataDO` (`DurableObject`) — source of truth for puzzle metadata; KV is synced with
  retries but DO write is authoritative
- Image processing via `@cf-wasm/photon` (crop/resize) and `@cf-wasm/resvg` (SVG mask rendering)

### Shared Data Layer (`@perseus/shared`)

Server-side persistence shared by the API and workflows workers:

- `src/schema.ts` — Drizzle SQLite/D1 schema: `player_profiles`, `puzzle_completion_runs`,
  `puzzle_best_times`, `player_difficulty_completions`, `player_achievements`,
  `player_variant_mastery`, `puzzle_deletion_tombstones`, `player_completion_usage`,
  `puzzle_families`
- `src/repositories.ts`, `src/completion-writes.ts` — query/write helpers; completion writes are
  idempotent and fenced against deleted puzzles
- `src/progression.ts` — achievement ids, point values, and mastery badge rules (pure; the
  authority for scoring, not the API routes)
- `src/workflow-status.ts`, `src/image.ts` — status mirroring and image helpers
- `drizzle/` — numbered migrations plus `meta/_journal.json`. Adding a migration here means
  re-running `cd apps/api && bun run db:migrate:local`.
- Import as `@perseus/shared`, or `@perseus/shared/d1` for the D1 driver binding.

Tests run under `bun --bun vitest` (not plain vitest) and some use `miniflare` for a real D1.

### Shared Types (`@perseus/types`)

`packages/types/src/index.ts` is only a barrel. The actual definitions live in domain modules:

- `core.ts` — `PuzzleMetadata`, `PuzzlePiece`, `EdgeConfig`, validation functions
  (`validatePuzzleMetadata`, `validateWorkflowParams`, …); also re-exports from `grid.ts`,
  `errors.ts`, and `jigsaw-path.ts`
- `grid.ts` — aspect ratios, difficulties, `DIFFICULTY_PIECE_COUNTS`, `getGridDimensions`,
  edge-type derivation
- `jigsaw-path.ts` — `generateJigsawPath` / `generateJigsawSvgMask`
- `puzzle-family.ts`, `errors.ts` — family metadata; `ErrorCode` / `ERROR_HTTP_STATUS`

Always import from the `@perseus/types` root, not a deep path.

### Puzzle Generation Algorithm

Pieces are generated on a grid (square root for square counts, largest factor ≤ sqrt for
non-square). Each piece image is padded with `TAB_RATIO` (20%) overlap on each side to accommodate
jigsaw tab protrusions; `EXPANSION_FACTOR = 1 + 2 * TAB_RATIO` (1.4) is the resulting container
scale. An SVG mask with jigsaw-shaped paths is rendered and applied as an alpha channel. Edge
types (`flat`, `tab`, `blank`) are determined deterministically by position — adjacent pieces
always have matching/opposite edges, with no coordination between them.

This geometry is used in three places and must stay consistent: the workflow
(`apps/workflows/src/index.ts`), the web quick-puzzle generator
(`apps/web/src/lib/services/quickPuzzle/render.ts`), and the E2E fixture builder
(`apps/web/e2e/gameplay-fixtures/assets.ts`).

### Infrastructure (`@perseus/infrastructure`)

Pulumi TypeScript program for Cloudflare deployment. `packages/infrastructure/src/workers.ts`
exports `createApiWorker` and `createWorkflowsWorker` which handle Worker versioning, Durable
Object migrations, Workflow registration, and R2/KV/DO binding wiring. Must build apps before
deploying.

**D1 migration safety:** The deploy workflow (`.github/workflows/deploy-infrastructure.yml`)
applies additive D1 migrations BEFORE publishing new Worker code (on subsequent deploys, when the
D1 database already exists). This ensures new columns and tables are present by the time the new
Worker version goes live. This is safe for additive migrations only (new tables, new columns, new
indexes). Before shipping a non-additive migration (column rename, type change, column drop, table
drop), adopt an expand/contract flow: ship the expand migration + backward-compatible Worker code
first, then ship the contract migration after the old Worker version is no longer live.

**First-deploy D1 gap:** On the first-ever production deploy, Pulumi creates the D1 database and
publishes the Worker in the same `pulumi up`, so the Worker is live before
`wrangler d1 migrations apply` runs. D1-dependent paths (`/api/puzzles/:id/complete`,
`/api/player/*`, `/api/admin/*`, workflow status mirrors) can hit missing tables and 500 until
migrations complete. For a zero-downtime first deploy, run migrations manually against the
Pulumi-provisioned DB before triggering the workflow (see the comment in
`deploy-infrastructure.yml`). Subsequent deploys are unaffected.

**D1 database ID:** The `database_id` in `apps/api/wrangler.production.toml` and
`apps/workflows/wrangler.production.toml` must match the Pulumi-managed D1 database (exported as
`d1DatabaseId` from the infrastructure stack). If the Pulumi stack is destroyed and recreated,
update both wrangler configs with the new database ID.

**D1 state-loss recovery (re-adoption):** If Pulumi state is lost/corrupted but the D1 database
still exists in Cloudflare, do NOT let `pulumi up` create a fresh database (it would get a new
UUID and lose all data). Instead, re-adopt the existing database: temporarily restore the
`import:` line in `createD1Database` (`packages/infrastructure/src/resources.ts`) using
``import: `${accountId}/${existingUuid}` ``, set a Pulumi config value with the existing UUID, run
`pulumi up` to adopt the resource back into state, then remove the `import:` line and config so
Pulumi fully owns the resource going forward. The original adoption procedure was introduced in
`fd43f33` and removed in `e3229c9` after adoption completed — consult those commits if the lines
above are stale. Find the existing UUID via `wrangler d1 list` or the Cloudflare dashboard.

## Code Style

- Tabs for indentation
- Single quotes
- No trailing commas
- 100 char line width
- Prettier + ESLint for formatting and linting
- Pre-commit hooks via Husky + lint-staged (auto-formats on commit)

## Environment Variables

**API Worker** bindings (Cloudflare):

- `JWT_SECRET` — required in production for player sessions
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_REDIRECT_BASE_URL` — Google OAuth login flow
- `ALLOWED_ORIGINS` — comma-separated CORS origins (required in production)
- `NODE_ENV` — controls dev/prod behavior; unset NODE_ENV is treated as production
- `TRUSTED_PROXY`, `TRUSTED_PROXY_LIST` — optional IP spoofing protection
- `PUZZLES_BUCKET` (R2), `PUZZLE_METADATA` (KV), `PUZZLE_METADATA_DO` (DO), `DB` (D1),
  `PUZZLE_WORKFLOW`, `ASSETS` — Cloudflare bindings

**Web**: `PUBLIC_API_BASE` (empty for same-origin). `bun run check` and `bun run build` set it to
`''` if unset; CI copies `apps/web/.env.example` to `.env` before linting.

## Testing Notes

- API/workflows tests: files matching `src/**/*.test.ts`; worker-runtime tests use the
  `.worker.test.ts` naming convention
- Web unit tests run in browser mode via Playwright/Chromium (headless); all tests require
  assertions (`requireAssertions: true`). Run
  `bun run --cwd apps/web test:install-browsers:chromium` once before the first run.
- `packages/shared` tests run under `bun --bun vitest`; D1 repository tests use miniflare
- A few web invariant tests run under `bun test` rather than vitest (vite plugins, build scripts,
  E2E fixture builders) — see the "Run web bun:test invariants" step in
  `.github/workflows/unit-test.yml`
- Web E2E tests: `apps/web/e2e/` with Playwright; deterministic gameplay harness documented in
  [`apps/web/e2e/README.md`](apps/web/e2e/README.md)

## E2E Testing

Deterministic gameplay E2E lives in [`apps/web/e2e/`](apps/web/e2e/README.md). Playwright starts
two servers itself: the API via `apps/api` `dev:e2e` on `:3999` (which applies local D1 migrations
and injects test auth vars) and a production-mode web preview on `:4173` built with
`PERSEUS_E2E_HARNESS=1`. Key commands (from repo root):

- `bun run --cwd apps/web test:e2e` — default local run (chromium-desktop, excludes `@extended`)
- `bun run --cwd apps/web test:e2e:smoke` — automatic Chromium desktop/mobile E2E
- `bun run --cwd apps/web test:e2e:webkit` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:extended` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:a11y` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:stability` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:assert-production-bundle` — automatic pre-browser assertion
  that the harness never ships in a production build

New gameplay tests must import `test` and `expect` from `e2e/support/test`, which provides the
`gameplayPage` fixture (atomic `gotoFixture()` init + automatic teardown). See the
[harness README](apps/web/e2e/README.md) for fixtures, interception rules, the completion matrix,
and extension rules.

## CI

Three automatic code workflows run on PRs; docs-only changes (`docs/**`, `**/*.md`, `**/*.mdx`)
skip all three, and draft PRs are skipped:

- **Build & Lint** — `lint`, `lint:scripts`, `check`, `check:scripts`, `build`
- **Unit Tests** — `test:scripts`, `test:shell`, `test:unit`, the web `bun test` invariants, and
  Codecov upload (`fail_ci_if_error: true`, so coverage upload failures fail the job)
- **E2E Tests** — Chromium smoke lane only; the extended/webkit/a11y/stability lanes are manual

## Operator Runbook

Production operations procedures (deploy, D1 migrations, state-loss recovery, seed uploads, orphan
reaper, force-delete, Access gate, legacy key removal) are consolidated in the repo-local
[`perseus-operations`](.agents/skills/perseus-operations/SKILL.md) skill. Root `scripts/`
(`admin:upload`, `admin:startup:*`, `import-puzzle-families.ts`, `cleanup-legacy-puzzles.ts`) are
the CLI entry points that runbook drives; use the skill for full detail rather than invoking them
from memory.
