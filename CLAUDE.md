# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

This is a Turborepo monorepo using Bun as the package manager.

```bash
# Install dependencies
bun install

# Development (runs all apps concurrently)
bun run dev

# Run specific app
bun run dev --filter=@perseus/web
bun run dev --filter=@perseus/api        # Uses wrangler dev (Cloudflare Worker mode)
bun run dev --filter=@perseus/workflows

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
- `apps/api` - Hono HTTP API with **dual runtime targets**: Bun (local dev) and Cloudflare Workers (production)
- `apps/workflows` - Cloudflare Workers Workflows for async puzzle piece generation
- `packages/types` - Shared TypeScript types and validation functions used by all apps
- `packages/infrastructure` - Pulumi IaC for Cloudflare deployment (Workers, KV, R2, Workflows, Durable Objects)

### Web App (`@perseus/web`)

- **Framework**: SvelteKit with static adapter (SSG); puzzle page at `/puzzle/[id]` is dynamically rendered (`prerender = false`)
- **Styling**: Tailwind CSS v4 via Vite plugin
- **Testing**: Vitest with browser-mode Playwright for Svelte component tests; E2E via Playwright
- **Routes**: `src/routes/` - SvelteKit file-based routing (gallery, puzzle `[id]`, admin)
- **State**: `src/lib/stores/` - Svelte stores (e.g., piece selection)
- **Services**: `src/lib/services/progress.ts` - puzzle progress tracking (client-side)

### API (`@perseus/api`) — Dual Runtime

The API has parallel implementations for two runtimes. Files without `.worker` suffix run on Bun; files with `.worker.ts` run on Cloudflare Workers.

| Layer          | Bun (local)                                   | Cloudflare Worker (production)             |
| -------------- | --------------------------------------------- | ------------------------------------------ |
| Entry          | `src/index.ts`                                | `src/worker.ts`                            |
| Puzzles routes | `src/routes/puzzles.ts`                       | `src/routes/puzzles.worker.ts`             |
| Admin routes   | `src/routes/admin.ts`                         | `src/routes/admin.worker.ts`               |
| Storage        | `src/services/storage.ts` (filesystem + JSON) | `src/services/storage.worker.ts` (KV + R2) |
| Middleware     | `src/middleware/auth.ts`                      | `src/middleware/auth.worker.ts`            |

The **Worker** (`src/worker.ts`) also serves static web assets via `env.ASSETS` (Cloudflare Workers Assets binding), acting as a combined API + static file server in production.

In production, puzzle creation triggers a Cloudflare Workflow (`PUZZLE_WORKFLOW` binding) for async piece generation. The Durable Object `PuzzleMetadataDO` (defined in `apps/workflows`) provides strongly consistent metadata updates, with KV as an eventually consistent read cache.

### Workflows (`@perseus/workflows`)

Runs on Cloudflare Workers. Contains:

- `PerseusWorkflow` (`WorkflowEntrypoint`) — processes uploaded images into jigsaw pieces row-by-row with checkpoint progress tracking stored in KV/DO
- `PuzzleMetadataDO` (`DurableObject`) — source of truth for puzzle metadata; KV is synced with retries but DO write is authoritative
- Image processing via `@cf-wasm/photon` (crop/resize) and `@cf-wasm/resvg` (SVG mask rendering)

### Shared Types (`@perseus/types`)

`packages/types/src/index.ts` defines all shared types (`PuzzleMetadata`, `PuzzlePiece`, `EdgeConfig`, etc.) and validation functions (`validatePuzzleMetadata`, `validateWorkflowParams`, etc.). Import from `@perseus/types` in Worker code; the Bun API imports from its local `src/types/index.ts`.

### Puzzle Generation Algorithm

Pieces are generated on a grid (square root for square counts, largest factor ≤ sqrt for non-square). Each piece image is padded with `TAB_RATIO` (20%) overlap on each side to accommodate jigsaw tab protrusions. An SVG mask with jigsaw-shaped paths is rendered and applied as an alpha channel. Edge types (`flat`, `tab`, `blank`) are determined deterministically by position — adjacent pieces always have matching/opposite edges.

### Infrastructure (`@perseus/infrastructure`)

Pulumi TypeScript program for Cloudflare deployment. `packages/infrastructure/src/workers.ts` exports `createApiWorker` and `createWorkflowsWorker` which handle Worker versioning, Durable Object migrations, Workflow registration, and R2/KV/DO binding wiring. Must build apps before deploying.

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

**Bun API** (local dev, `src/index.ts`):

- Same secret env vars; no Cloudflare bindings
- `DATA_DIR` — filesystem path for puzzle data (default: `./data`)
- `PORT` — API port (default: 3000)

## Testing Notes

- API tests: files matching `src/**/*.test.ts` excluding `src/__tests__/puzzles.test.ts`; worker tests use `.worker.test.ts` naming convention
- Web unit tests run in browser mode via Playwright/Chromium (headless); all tests require assertions (`requireAssertions: true`)
- Web E2E tests: `apps/web/e2e/` directory with Playwright (`gallery.spec.ts`, `puzzle-solving.spec.ts`)
