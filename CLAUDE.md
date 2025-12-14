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
- **Entry**: `src/index.ts` - Single-file API with routes defined inline
- **Endpoints**: `/` (info), `/health`, `/api/hello`

## Code Style

- Tabs for indentation
- Single quotes
- No trailing commas
- 100 char line width
- Prettier + ESLint for formatting and linting
