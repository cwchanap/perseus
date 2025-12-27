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
bun run dev --filter=@perseus/api

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
```

## Architecture

### Monorepo Structure

- `apps/web` - SvelteKit frontend with static adapter, Tailwind CSS v4, Vitest for unit tests, Playwright for E2E
- `apps/api` - Hono HTTP API running on Bun (port 3000)

### Web App (`@perseus/web`)

- **Framework**: SvelteKit with static adapter (SSG)
- **Styling**: Tailwind CSS v4 via Vite plugin
- **Testing**: Vitest with browser-mode Playwright for Svelte component tests
- **Routes**: `src/routes/` - SvelteKit file-based routing
- **Lib**: `src/lib/` - Shared components and utilities

### API (`@perseus/api`)

- **Runtime**: Bun
- **Framework**: Hono with CORS and logger middleware
- **Entry**: `src/index.ts` - Main entry point with middleware and route mounting
- **Route Groups**: Routes organized in `src/routes/` (puzzles, admin)
- **Services**: Business logic in `src/services/` (storage, puzzle-generator)
- **Environment**: Requires `JWT_SECRET`, `ADMIN_PASSKEY` in production; `ALLOWED_ORIGINS` for CORS

## Code Style

- Tabs for indentation
- Single quotes
- No trailing commas
- 100 char line width
- Prettier + ESLint for formatting and linting
- Pre-commit hooks via Husky + lint-staged (auto-formats on commit)

## Environment Variables

API requires:

- `JWT_SECRET` - JWT signing secret (required in production)
- `ADMIN_PASSKEY` - Admin authentication passkey (required in production)
- `ALLOWED_ORIGINS` - Comma-separated CORS origins (required in production)
- `PORT` - API port (default: 3000)
- `NODE_ENV` - Environment mode (development/production)

## Active Technologies

- TypeScript 5.9 (strict mode) (001-jigsaw-puzzle)
- JSON files (metadata) + filesystem folders (images) on API server (001-jigsaw-puzzle)

## Recent Changes

- 001-jigsaw-puzzle: Added TypeScript 5.9 (strict mode)
