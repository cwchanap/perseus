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
bun run dev --filter=@perseus/web
bun run dev --filter=@perseus/api        # Multi-worker wrangler dev: API + workflows worker
bun run dev:standalone --filter=@perseus/workflows  # Standalone workflows worker (rarely needed)

# Build all apps
bun run build

# Type checking
bun run check

# Linting
bun run lint

# Format code
bun run format

# Run all tests
bun run test

# Unit tests only
bun run test:unit

# E2E tests only (web app)
bun run test:e2e

# Run tests for a specific app
cd apps/api && bun run test
cd apps/workflows && bun run test
cd apps/web && bun run test:unit

# Watch mode for a specific app
cd apps/api && bun run test:watch
```

## Architecture

### Monorepo Structure

- `apps/web` - SvelteKit frontend with static adapter, Tailwind CSS v4
- `apps/api` - Hono HTTP API on Cloudflare Workers (local dev and production); Bun is the package manager/test runner, not a second HTTP runtime
- `apps/workflows` - Cloudflare Workers Workflows for async puzzle piece generation
- `packages/types` - Shared TypeScript types and validation functions used by all apps
- `packages/infrastructure` - Pulumi IaC for Cloudflare deployment (Workers, KV, R2, Workflows, Durable Objects)

### Web App (`@perseus/web`)

- **Framework**: SvelteKit with static adapter (SSG); puzzle page at `/puzzle/[id]` is dynamically rendered (`prerender = false`)
- **Styling**: Tailwind CSS v4 via Vite plugin
- **Testing**: Vitest with browser-mode Playwright for Svelte component tests; E2E via Playwright
- **Routes**: `src/routes/` - SvelteKit file-based routing (gallery, puzzle `[id]`, admin)
- **State**: `src/lib/stores/` - Svelte stores (e.g., piece selection)

### API (`@perseus/api`)

The API is Hono on Cloudflare Workers for both local development and production. `src/worker.ts` is the HTTP entry; the route, service, and middleware implementations live in `*.worker.ts` files (e.g. `src/routes/puzzles.worker.ts`, `src/routes/admin.worker.ts`, `src/services/storage.worker.ts`, `src/middleware/auth.worker.ts`). Local development runs via Wrangler (`bun run dev --filter=@perseus/api`) on `http://localhost:4690`, with local D1, KV, R2, Durable Object, and Workflow bindings — no second runtime.

The **Worker** (`src/worker.ts`) also serves static web assets via `env.ASSETS` (Cloudflare Workers Assets binding), acting as a combined API + static file server in production.

In production, puzzle creation triggers a Cloudflare Workflow (`PUZZLE_WORKFLOW` binding) for async piece generation. The Durable Object `PuzzleMetadataDO` (defined in `apps/workflows`) provides strongly consistent metadata updates, with KV as an eventually consistent read cache.

### Workflows (`@perseus/workflows`)

Runs on Cloudflare Workers. Contains:

- `PerseusWorkflow` (`WorkflowEntrypoint`) — processes uploaded images into jigsaw pieces row-by-row with checkpoint progress tracking stored in KV/DO
- `PuzzleMetadataDO` (`DurableObject`) — source of truth for puzzle metadata; KV is synced with retries but DO write is authoritative
- Image processing via `@cf-wasm/photon` (crop/resize) and `@cf-wasm/resvg` (SVG mask rendering)

### Shared Types (`@perseus/types`)

`packages/types/src/index.ts` defines all shared types (`PuzzleMetadata`, `PuzzlePiece`, `EdgeConfig`, etc.) and validation functions (`validatePuzzleMetadata`, `validateWorkflowParams`, etc.). Import from `@perseus/types` in Worker code.

### Puzzle Generation Algorithm

Pieces are generated on a grid (square root for square counts, largest factor ≤ sqrt for non-square). Each piece image is padded with `TAB_RATIO` (20%) overlap on each side to accommodate jigsaw tab protrusions. An SVG mask with jigsaw-shaped paths is rendered and applied as an alpha channel. Edge types (`flat`, `tab`, `blank`) are determined deterministically by position — adjacent pieces always have matching/opposite edges.

### Infrastructure (`@perseus/infrastructure`)

Pulumi TypeScript program for Cloudflare deployment. `packages/infrastructure/src/workers.ts` exports `createApiWorker` and `createWorkflowsWorker` which handle Worker versioning, Durable Object migrations, Workflow registration, and R2/KV/DO binding wiring. Must build apps before deploying.

**D1 migration safety:** The deploy workflow (`.github/workflows/deploy-infrastructure.yml`) applies additive D1 migrations BEFORE publishing new Worker code (on subsequent deploys, when the D1 database already exists). This ensures new columns and tables are present by the time the new Worker version goes live. This is safe for additive migrations only (new tables, new columns, new indexes). Before shipping a non-additive migration (column rename, type change, column drop, table drop), adopt an expand/contract flow: ship the expand migration + backward-compatible Worker code first, then ship the contract migration after the old Worker version is no longer live.

**First-deploy D1 gap:** On the first-ever production deploy, Pulumi creates the D1 database and publishes the Worker in the same `pulumi up`, so the Worker is live before `wrangler d1 migrations apply` runs. D1-dependent paths (`/api/puzzles/:id/complete`, `/api/player/*`, `/api/admin/*`, workflow status mirrors) can hit missing tables and 500 until migrations complete. For a zero-downtime first deploy, run migrations manually against the Pulumi-provisioned DB before triggering the workflow (see the comment in `deploy-infrastructure.yml`). Subsequent deploys are unaffected.

**D1 database ID:** The `database_id` in `apps/api/wrangler.production.toml` and `apps/workflows/wrangler.production.toml` must match the Pulumi-managed D1 database (exported as `d1DatabaseId` from the infrastructure stack). If the Pulumi stack is destroyed and recreated, update both wrangler configs with the new database ID.

**D1 state-loss recovery (re-adoption):** If Pulumi state is lost/corrupted but the D1 database still exists in Cloudflare, do NOT let `pulumi up` create a fresh database (it would get a new UUID and lose all data). Instead, re-adopt the existing database: temporarily restore the `import:` line in `createD1Database` (`packages/infrastructure/src/resources.ts`) using `import: \`${accountId}/${existingUuid}\``, set a Pulumi config value with the existing UUID, run `pulumi up`to adopt the resource back into state, then remove the`import:`line and config so Pulumi fully owns the resource going forward. The original adoption procedure was introduced in`fd43f33`and removed in`e3229c9`after adoption completed — consult those commits if the lines above are stale. Find the existing UUID via`wrangler d1 list` or the Cloudflare dashboard.

## Code Style

- Tabs for indentation
- Single quotes
- No trailing commas
- 100 char line width
- Prettier + ESLint for formatting and linting
- Pre-commit hooks via Husky + lint-staged (auto-formats on commit)

## Environment Variables

**API Worker** bindings (Cloudflare):

- `JWT_SECRET`, `ADMIN_PASSKEY` — required in production
- `ALLOWED_ORIGINS` — comma-separated CORS origins (required in production)
- `NODE_ENV` — controls dev/prod behavior; unset NODE_ENV is treated as production
- `TRUSTED_PROXY`, `TRUSTED_PROXY_LIST` — optional IP spoofing protection
- `PUZZLES_BUCKET` (R2), `PUZZLE_METADATA` (KV), `PUZZLE_METADATA_DO` (DO), `PUZZLE_WORKFLOW`, `ASSETS` — Cloudflare bindings

## Testing Notes

- API tests: files matching `src/**/*.test.ts`; worker-runtime tests use the `.worker.test.ts` naming convention
- Web unit tests run in browser mode via Playwright/Chromium (headless); all tests require assertions (`requireAssertions: true`)
- Web E2E tests: `apps/web/e2e/` directory with Playwright (`gallery.spec.ts`, `puzzle-solving.spec.ts`); deterministic gameplay harness documented in [`apps/web/e2e/README.md`](apps/web/e2e/README.md)

## E2E Testing

Deterministic gameplay E2E lives in [`apps/web/e2e/`](apps/web/e2e/README.md). Key commands (from repo root):

- `bun run --cwd apps/web test:e2e` — default local run (chromium-desktop, excludes `@extended`)
- `bun run --cwd apps/web test:e2e:smoke` — automatic Chromium desktop/mobile E2E
- `bun run --cwd apps/web test:e2e:webkit` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:extended` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:a11y` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:stability` — local/manual pre-release
- `bun run --cwd apps/web test:e2e:assert-production-bundle` — automatic pre-browser assertion

Unit Tests installs Chromium only, and docs-only changes skip all three automatic code workflows: Build & Lint, Unit Tests, and E2E.

New gameplay tests must import `test` and `expect` from `e2e/support/test`, which provides the `gameplayPage` fixture (atomic `gotoFixture()` init + automatic teardown). See the [harness README](apps/web/e2e/README.md) for fixtures, interception rules, the completion matrix, and extension rules.

## Operator Runbook

Production operations procedures (deploy, D1 migrations, state-loss recovery,
seed uploads, orphan reaper, force-delete, Access gate, legacy key removal)
are consolidated in the repo-local
[`perseus-operations`](.agents/skills/perseus-operations/SKILL.md) skill.
The sections below are brief pointers; use the skill for full detail.
