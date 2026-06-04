# Player Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and
> superpowers:verification-before-completion while executing this plan.

**Goal:** Move web server puzzle upload to `/upload` for logged-in players, keep `/quick`
local-only, and add a local admin upload script.

**Architecture:** Add player-session middleware for Bun and Worker runtimes, mount
player-authenticated `POST /api/puzzles`, and keep admin `POST /api/admin/puzzles` for the script.
The Svelte upload page reuses the existing browser-side image normalization and multipart upload
contract.

**Tech Stack:** Bun, Hono, Cloudflare Workers, SvelteKit, Svelte 5 runes, Vitest browser mode.

---

## Tasks

- [ ] Add failing API tests for anonymous and authenticated `POST /api/puzzles`.
- [ ] Implement player session middleware in Bun and Worker runtimes.
- [ ] Add `POST /api/puzzles` by reusing current puzzle creation validation and persistence flow.
- [ ] Add API client functions for player puzzle upload.
- [ ] Create `/upload` and move the visible server upload form out of `/admin`.
- [ ] Add `scripts/admin-upload-puzzle.ts` and package script wiring.
- [ ] Run focused API/web tests, then `bun run check` and relevant unit tests.
