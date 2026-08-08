# HPA-555 — Retire Duplicate Bun HTTP Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cloudflare Workers the only Perseus HTTP API runtime for development, E2E, and production while keeping Bun for package management, scripts, and tests.

**Architecture:** Prove the Worker-backed Playwright server first, then delete the duplicate Bun HTTP implementation and every test tied to it. Keep the surviving `*.worker.ts` names and existing shared/Cloudflare architecture. Finish by moving operator guidance out of the root README without losing it, aligning local tooling with port 4690, and running Worker-only verification.

**Tech Stack:** Bun 1.3.14, Hono, Cloudflare Workers/Wrangler 4.60, D1, KV, R2, Durable Objects, Workflows, Vitest 4, Playwright 1.57, SvelteKit.

## Global Constraints

- `apps/api/src/worker.ts` is the sole HTTP API entry point after this work.
- Normal API development remains Wrangler on port `4690` with `--env dev` and the existing API + workflows configs.
- Gameplay E2E uses the same Worker implementation on deterministic port `3999`.
- Keep Bun as the workspace package manager, script runtime, and test runner.
- Keep surviving `*.worker.ts` and `.worker.test.ts` names; do not mass-rename them.
- Do not add runtime-neutral route factories, DI containers, repository frameworks, compatibility wrappers, or a replacement Bun mode.
- Do not redesign endpoints, authentication, Cloudflare bindings, deployment architecture, or workflow behavior.
- Local filesystem API data may be discarded; do not migrate it.
- Do not change completion/session compatibility behavior assigned to HPA-556.
- Do not simplify CI workflow topology assigned to HPA-558.
- `AGENTS.md` is already a symlink to `CLAUDE.md`; do not edit it separately.
- Keep `@perseus/shared/bun`; it still has shared-package test consumers independent of the deleted HTTP server.
- Use existing Wrangler local binding simulation; do not add a second permanent Wrangler E2E config.
- Use Wrangler CLI `--assets` only to provide the existing `ASSETS` binding for the API-only E2E process without depending on the concurrent frontend build.
- Preserve `PUBLIC_API_BASE=http://localhost:3999` for Playwright.
- Treat `@types/bun` in `apps/api/package.json` and `"bun"` in `apps/api/tsconfig.json` as one cleanup decision; never remove only one and rely on workspace hoisting for the other.

## Dependency Order

```text
Task 1 Worker-backed E2E replacement
  -> Task 2 delete Bun HTTP runtime + complete Bun-only test set
  -> Task 3 align local tooling + preserve/move operator documentation
  -> Task 4 final Worker-only verification
```

## File Map

| Path | Responsibility after HPA-555 |
| --- | --- |
| `apps/api/src/worker.ts` | Sole HTTP entry point and scheduled Worker handler. |
| `apps/api/src/db.worker.ts` | Worker D1 DB context, including its own small `ApiDbContext` type. |
| `apps/api/package.json` | Wrangler dev/build/deploy plus deterministic `dev:e2e`; no Bun HTTP server scripts. |
| `apps/api/tsconfig.json` | Worker/Node types only after the Bun HTTP source/test tree is gone. |
| `apps/api/vitest.config.ts` | Runs the surviving API tests without a stale Bun-test exclusion. |
| `apps/web/playwright.config.ts` | Starts Worker-backed API on 3999 and Vite preview on 4173. |
| `scripts/admin-upload-puzzle.ts` | Local single-upload CLI defaults to canonical Worker port 4690. |
| `apps/api/.env.example` | Worker secrets/OAuth examples; no Bun `PORT`/`DATA_DIR`. |
| `CLAUDE.md` | Canonical contributor guide; `AGENTS.md` follows via symlink. |
| `apps/api/README.md` | Short Worker-oriented package overview. |
| `README.md` | Product purpose, quick start, and links only. |
| `docs/OPERATOR_RUNBOOK.md` | Consolidated production/admin/operations reference, including the useful Admin CLI how-to currently in root README. |
| `apps/api/src/index.ts` and Bun siblings | Deleted. |
| Bun-only/parity tests | Deleted. |

---

### Task 1: Replace the Playwright Bun Backend with Wrangler

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/web/playwright.config.ts`

**Interfaces:**

- Produces: `bun run dev:e2e` in `@perseus/api`, serving the Worker API on `http://localhost:3999`.
- Produces: Playwright API `webServer.command = 'bun run dev:e2e'` with `/health` readiness and a 180-second startup timeout.
- Preserves: frontend `PUBLIC_API_BASE=http://localhost:3999`.

- [ ] **Step 1: Confirm the current Bun-backed E2E dependency**

Run from repo root:

```bash
rg -n "build:bun|start:bun|PUBLIC_API_BASE|3999" \
  apps/web/playwright.config.ts apps/api/package.json
```

Expected before the change:

```text
apps/web/playwright.config.ts -> bun run build:bun && bun run start:bun
apps/api/package.json         -> build:bun and start:bun scripts exist
PUBLIC_API_BASE               -> http://localhost:3999
```

- [ ] **Step 2: Baseline the existing smoke suite**

```bash
bun run --cwd apps/web test:e2e:smoke
```

Expected: current Chromium desktop/mobile smoke passes before changing its backend.

- [ ] **Step 3: Add the deterministic Worker E2E bootstrap script**

In `apps/api/package.json`, add exactly:

```json
"dev:e2e": "mkdir -p dist/e2e-assets && touch dist/e2e-assets/index.html && bun run db:migrate:local && wrangler dev --port 3999 --env dev -c wrangler.toml -c ../workflows/wrangler.dev.toml --assets dist/e2e-assets --var JWT_SECRET:e2e-test-secret --var ADMIN_PASSKEY:e2e-test-passkey --var GOOGLE_CLIENT_ID:e2e-google-client --var GOOGLE_CLIENT_SECRET:e2e-google-secret --var AUTH_REDIRECT_BASE_URL:http://localhost:3999 --var ALLOWED_ORIGINS:http://localhost:4173,http://127.0.0.1:4173 --var NODE_ENV:development"
```

Keep the existing normal `dev` command unchanged.

This command intentionally:

- applies the existing local D1 migrations before startup;
- passes the API config first so it is the HTTP-exposed Worker;
- passes the workflows config second so bound workflow/DO code is available in the same local dev session;
- keeps all Cloudflare resources local;
- overrides assets with a tiny API-owned directory so API startup does not race `apps/web/build`;
- injects deterministic non-production Worker variables;
- pins E2E API port 3999.

Do not add `.dev.vars.e2e`, another Wrangler config, or a shell helper.

- [ ] **Step 4: Point Playwright at the Worker E2E command**

Replace only the API entry in `apps/web/playwright.config.ts` with:

```ts
{
	command: 'bun run dev:e2e',
	url: 'http://localhost:3999/health',
	cwd: '../api',
	reuseExistingServer: !process.env.CI,
	timeout: 180_000
}
```

Keep the frontend `webServer` entry unchanged, including:

```ts
PUBLIC_API_BASE: process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'
```

The URL readiness check proves the Worker handler responds. The explicit 180-second timeout gives cold CI migration/Worker startup room beyond Playwright's default web-server startup timeout without changing per-test timeouts.

- [ ] **Step 5: Format-check the E2E bootstrap change**

```bash
bunx prettier --check apps/api/package.json apps/web/playwright.config.ts
git diff --check
```

Expected: both commands exit zero.

- [ ] **Step 6: Prove the Worker-backed E2E backend before deleting Bun**

```bash
bun run --cwd apps/web test:e2e:smoke
```

Expected:

- Playwright starts `bun run dev:e2e` from `apps/api`;
- local D1 migrations complete or report already applied;
- Wrangler exposes the API Worker on port 3999 with the workflows Worker available through bindings;
- frontend build/preview runs independently on 4173;
- Chromium desktop/mobile smoke passes.

Treat this as the server/harness integration gate. Endpoint behavior remains covered by Worker API tests; do not add a second E2E parity suite.

If `--assets` or multi-config startup fails, fix only the `dev:e2e` command. Do not change `worker.ts` or create another Wrangler project for the harness.

- [ ] **Step 7: Commit the replacement backend**

```bash
git add apps/api/package.json apps/web/playwright.config.ts
git commit -m "test(e2e): run API backend with Wrangler"
```

---

### Task 2: Delete the Duplicate Bun HTTP Runtime and Its Tests

**Files:**

- Modify: `apps/api/src/db.worker.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`
- Modify: `apps/api/vitest.config.ts`
- Modify if generated: `bun.lock`
- Delete: `apps/api/src/index.ts`
- Delete: `apps/api/src/db.ts`
- Delete: `apps/api/src/routes/admin.ts`
- Delete: `apps/api/src/routes/auth.ts`
- Delete: `apps/api/src/routes/player.ts`
- Delete: `apps/api/src/routes/puzzles.ts`
- Delete: `apps/api/src/routes/puzzles.complete.ts`
- Delete: `apps/api/src/middleware/auth.ts`
- Delete: `apps/api/src/middleware/player-auth.ts`
- Delete: `apps/api/src/middleware/rate-limit.ts`
- Delete: `apps/api/src/services/storage.ts`
- Delete: `apps/api/src/services/player-auth.ts`
- Delete: `apps/api/src/services/puzzle-generator.ts`
- Delete: `apps/api/src/utils/jigsawPath.ts`
- Delete: `apps/api/src/types/index.ts`
- Delete: all Bun-only/parity tests listed in Step 5

**Interfaces:**

- `getWorkerDbContext(env: Env): ApiDbContext` remains unchanged for callers.
- `ApiDbContext` remains `{ db: AppDb; completionWrites: CompletionWriteExecutor }`, but is declared in `db.worker.ts`.
- Worker route/service modules and HTTP contracts are unchanged.

- [ ] **Step 1: Baseline the canonical Worker tests**

```bash
cd apps/api
bunx vitest run \
  src/__tests__/worker.test.ts \
  src/routes/__tests__/puzzles.worker.test.ts \
  src/routes/__tests__/admin.worker.test.ts \
  src/routes/__tests__/auth.worker.test.ts \
  src/routes/player.worker.test.ts \
  src/routes/puzzles.complete.worker.test.ts
cd ../..
```

Expected: all selected Worker tests pass before deletion.

- [ ] **Step 2: Record exact imports of modules that will disappear**

```bash
rg -n \
  "(from|vi\\.mock\\() ['\"](\\.\\.?/)+(db|routes/(admin|auth|player|puzzles)(\\.complete)?|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|utils/jigsawPath|types(/index)?)[ '\"]" \
  apps/api/src \
  --glob '*.ts'
```

Also record the obsolete scripts:

```bash
rg -n "dev:bun|build:bun|start:bun|src/index\.ts" apps/api/package.json apps/web/playwright.config.ts
```

Expected: exact unsuffixed module matches are Bun implementation/tests plus the known `db.worker.ts` type import. Worker code should otherwise reference `.worker`/`.shared` modules explicitly.

- [ ] **Step 3: Make `db.worker.ts` self-contained**

Replace its Bun-type import with:

```ts
import { createD1CompletionWriteExecutor, createD1Db } from '@perseus/shared/d1';
import type { AppDb, CompletionWriteExecutor } from '@perseus/shared';
import type { Env } from './worker';

export interface ApiDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
}
```

Keep `getWorkerDbContext()` and `getWorkerDb()` behavior unchanged. Do not create `db.shared.ts`.

- [ ] **Step 4: Delete the Bun runtime source files**

```bash
rm \
  apps/api/src/index.ts \
  apps/api/src/db.ts \
  apps/api/src/routes/admin.ts \
  apps/api/src/routes/auth.ts \
  apps/api/src/routes/player.ts \
  apps/api/src/routes/puzzles.ts \
  apps/api/src/routes/puzzles.complete.ts \
  apps/api/src/middleware/auth.ts \
  apps/api/src/middleware/player-auth.ts \
  apps/api/src/middleware/rate-limit.ts \
  apps/api/src/services/storage.ts \
  apps/api/src/services/player-auth.ts \
  apps/api/src/services/puzzle-generator.ts \
  apps/api/src/utils/jigsawPath.ts \
  apps/api/src/types/index.ts
```

Keep all `*.worker.ts`, `*.shared.ts`, `puzzle-ready.ts`, reaper code, packages, and workflows code.

- [ ] **Step 5: Delete the complete known Bun-only/parity test set**

```bash
rm -f \
  apps/api/src/routes/_cross-runtime-drift.test.ts \
  apps/api/src/routes/puzzles.test.ts \
  apps/api/src/routes/puzzles-coverage.test.ts \
  apps/api/src/routes/puzzles.complete.test.ts \
  apps/api/src/routes/__tests__/admin.test.ts \
  apps/api/src/routes/__tests__/admin-extra.test.ts \
  apps/api/src/routes/__tests__/admin-aspect-ratio.test.ts \
  apps/api/src/routes/__tests__/admin-idempotency.test.ts \
  apps/api/src/routes/__tests__/auth.test.ts \
  apps/api/src/middleware/auth.test.ts \
  apps/api/src/middleware/player-auth.test.ts \
  apps/api/src/middleware/rate-limit.test.ts \
  apps/api/src/middleware/rate-limit-avatar.test.ts \
  apps/api/src/middleware/rate-limit-avatar-cleanup.test.ts \
  apps/api/src/middleware/rate-limit-cleanup-dynamic.test.ts \
  apps/api/src/services/storage.test.ts \
  apps/api/src/services/storage-extra.test.ts \
  apps/api/src/services/storage-findOriginal.test.ts \
  apps/api/src/services/storage-idempotency-coverage.test.ts \
  apps/api/src/services/storage-idempotency-final.test.ts \
  apps/api/src/services/storage-idempotency-fs-branches.test.ts \
  apps/api/src/services/__tests__/storage-reclaim-race.test.ts \
  apps/api/src/services/player-auth.test.ts \
  apps/api/src/__tests__/puzzles.test.ts \
  apps/api/src/__tests__/player.test.ts \
  apps/api/src/__tests__/player-coverage.test.ts \
  apps/api/src/__tests__/player-rename-coverage.test.ts \
  apps/api/src/__tests__/player-avatar-integrity-coverage.test.ts \
  apps/api/src/__tests__/puzzle-generator.test.ts \
  apps/api/src/__tests__/puzzle-generator.getSharp.test.ts \
  apps/api/src/__tests__/jigsawPath.test.ts
```

These tests target deleted Bun modules. Do not port them mechanically; corresponding Worker suites remain the source of HTTP behavior coverage.

- [ ] **Step 6: Prove no Bun-only test/import was missed**

Run the same exact-module sweep after deletion:

```bash
! rg -n \
  "(from|vi\\.mock\\() ['\"](\\.\\.?/)+(db|routes/(admin|auth|player|puzzles)(\\.complete)?|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|utils/jigsawPath|types(/index)?)[ '\"]" \
  apps/api/src \
  --glob '*.ts'
```

Expected: no matches. This explicitly catches sibling forms such as `./storage`, `./rate-limit`, `./auth`, and `./player-auth`, not only `services/...` paths.

- [ ] **Step 7: Remove the stale Vitest exclusion**

In `apps/api/vitest.config.ts`, delete:

```ts
exclude: ['src/__tests__/puzzles.test.ts'],
```

Keep the rest of the test configuration unchanged.

- [ ] **Step 8: Remove obsolete Bun HTTP scripts**

Delete these scripts from `apps/api/package.json`:

```json
"dev:bun": "bun run --watch src/index.ts",
"build:bun": "bun build src/index.ts --outdir dist --target bun && rm -rf dist/drizzle && cp -R ../../packages/shared/drizzle dist/drizzle",
"start:bun": "bun run dist/index.js"
```

Keep the Task 1 `dev:e2e` script and all normal Worker scripts.

- [ ] **Step 9: Remove API Bun types only as one atomic cleanup**

First check the surviving API source tree:

```bash
! rg -n "from ['\"]bun:|import\\(['\"]bun:|\\bBun\." apps/api/src
```

Expected: no matches after the Bun source/tests above are deleted.

Then:

1. remove `@types/bun` from `apps/api/package.json`;
2. remove `"bun"` from `apps/api/tsconfig.json` `compilerOptions.types`, leaving:

```json
"types": ["@cloudflare/workers-types", "node"]
```

Do not touch the root workspace's Bun types or `@perseus/shared/bun`.

- [ ] **Step 10: Refresh dependencies and format**

```bash
bun install
bunx prettier --check \
  apps/api/package.json \
  apps/api/tsconfig.json \
  apps/api/vitest.config.ts \
  apps/api/src/db.worker.ts
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 11: Run the full surviving API suite**

```bash
cd apps/api
bunx vitest run
cd ../..

bun run check --filter=@perseus/api
bun run build --filter=@perseus/api
bun run lint --filter=@perseus/api
```

Expected: all commands pass with only Worker/shared API tests remaining.

- [ ] **Step 12: Re-run the Worker-backed E2E smoke suite**

```bash
bun run --cwd apps/web test:e2e:smoke
```

Expected: smoke still passes after the Bun implementation is physically gone.

- [ ] **Step 13: Commit the deletion**

```bash
git add -A apps/api apps/web/playwright.config.ts bun.lock
git commit -m "refactor(api): remove duplicate Bun HTTP runtime"
```

---

### Task 3: Align Local Tooling and Preserve Operator Documentation

**Files:**

- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `apps/api/.env.example`
- Modify: `CLAUDE.md`
- Modify: `apps/api/README.md`
- Modify: `README.md`
- Modify: `docs/OPERATOR_RUNBOOK.md`
- Do not edit: `AGENTS.md`

**Interfaces:**

- Local single-upload default becomes `http://127.0.0.1:4690`.
- Root README becomes product/quick-start only.
- Admin CLI operating instructions remain available in the existing operator runbook instead of being deleted.

- [ ] **Step 1: Fix the local single-upload CLI default**

In `scripts/admin-upload-puzzle.ts`, change:

```ts
const LOCAL_SERVER = 'http://127.0.0.1:3000';
```

to:

```ts
const LOCAL_SERVER = 'http://127.0.0.1:4690';
```

Update both usage/help strings that say the default is `http://127.0.0.1:3000` to `http://127.0.0.1:4690`.

Do not change production defaults in startup/bulk-upload tooling.

- [ ] **Step 2: Remove Bun-only environment examples**

In `apps/api/.env.example`, delete only:

```dotenv
# Server port (optional, default: 3000)
PORT=3000

# Data directory (optional, default: ./data)
DATA_DIR=./data
```

Keep the secrets, Access variables, `NODE_ENV=development`, Google OAuth examples, and:

```dotenv
AUTH_REDIRECT_BASE_URL=http://localhost:4690
```

- [ ] **Step 3: Move Admin CLI how-to out of root README without losing it**

Create a new final runbook section:

```markdown
## 11. Admin CLI Uploads
```

Move the useful operator content currently under root `README.md` `## Admin CLI: upload puzzles` into this section:

- credentials and Pulumi stack-output exports;
- readiness command;
- single-puzzle upload command, flags, valid piece counts, and production Access note;
- bulk/startup catalog local commands and options;
- token rotation procedure;
- idempotency behavior;
- operational notes about service tokens, processing state, and keeping secrets/assets out of git.

While moving it:

- change local API/default `http://127.0.0.1:3000` references to `http://127.0.0.1:4690`;
- keep production URL examples unchanged;
- replace the old `### CI seed workflow` body with a short pointer to existing runbook **§5 Seed Startup Puzzles** instead of duplicating that procedure;
- replace the old `### Service token blast radius` body with a short pointer to existing runbook **§8 Cloudflare Access (Admin Gate)** and `packages/infrastructure/src/admin-access.ts` instead of duplicating that analysis.

Do not create another admin document.

- [ ] **Step 4: Slim the root README after the operator content is safe**

Replace `README.md` with:

```markdown
# Perseus

Single-player jigsaw puzzle arcade built with SvelteKit, a Hono API on Cloudflare Workers, and Cloudflare Workflows for piece generation.

## Development

```bash
bun install
cd apps/api && bun run db:migrate:local
cd ../..
bun run dev
```

The API development server runs on `http://localhost:4690`.

## Documentation

- Contributor guide: [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md` is a symlink to the same guide)
- Production/admin operations: [`docs/OPERATOR_RUNBOOK.md`](docs/OPERATOR_RUNBOOK.md)
```

No Admin CLI procedure should remain only in root README after this step.

- [ ] **Step 5: Replace the stale API README with a short Worker overview**

Replace `apps/api/README.md` with:

```markdown
# Perseus API

Hono API running on Cloudflare Workers for local development and production. Bun remains the package manager and test runner; it is not a second HTTP runtime.

## Development

From the repository root:

```bash
cd apps/api && bun run db:migrate:local
cd ../..
bun run dev --filter=@perseus/api
```

The normal local API port is `4690`. Local D1, KV, R2, Durable Object, and Workflow bindings are provided by Wrangler.

For repository layout, environment variables, testing, and contributor conventions, see [`../../CLAUDE.md`](../../CLAUDE.md). For deployment and admin procedures, see [`../../docs/OPERATOR_RUNBOOK.md`](../../docs/OPERATOR_RUNBOOK.md).
```

Do not duplicate endpoint lists or operator procedures here.

- [ ] **Step 6: Make `CLAUDE.md` describe one HTTP runtime**

Update the active architecture and environment sections so they say:

- `apps/api` is a Hono API on Cloudflare Workers for local development and production;
- `src/worker.ts` is the HTTP entry point;
- route/service implementations use the existing `*.worker.ts` names;
- local development uses Wrangler bindings and port 4690;
- Bun is package/test tooling, not an HTTP server;
- remove the stale `src/lib/services/progress.ts` reference;
- remove Bun HTTP `PORT`/`DATA_DIR` guidance and dual-runtime tables.

Keep unrelated architecture, testing, infrastructure, and runbook material unchanged. Do not edit `AGENTS.md` separately.

- [ ] **Step 7: Search active docs/tooling for stale runtime guidance**

```bash
! rg -n \
  "dual runtime|dev:bun|build:bun|start:bun|Bun API|DATA_DIR|PORT=3000|127\.0\.0\.1:3000|localhost:3000|src/lib/services/progress\.ts" \
  README.md CLAUDE.md apps/api/README.md apps/api/.env.example scripts/admin-upload-puzzle.ts docs/OPERATOR_RUNBOOK.md
```

Expected: no stale Bun-runtime/local-port references remain in active guidance. Historical `docs/superpowers/**` files are intentionally excluded.

Confirm Admin CLI guidance survived the README cleanup:

```bash
rg -n \
  "Admin CLI Uploads|admin:upload|admin:startup:upload|CF_ACCESS_CLIENT_ID|Token rotation|Idempotency" \
  docs/OPERATOR_RUNBOOK.md
```

Expected: the runbook contains the moved operating guidance.

- [ ] **Step 8: Validate scripts and documentation formatting**

```bash
bun run check:scripts
bun run test:scripts
bunx prettier --check \
  scripts/admin-upload-puzzle.ts \
  apps/api/.env.example \
  CLAUDE.md \
  apps/api/README.md \
  README.md \
  docs/OPERATOR_RUNBOOK.md
git diff --check
```

Expected: all commands pass.

- [ ] **Step 9: Commit tooling and docs**

```bash
git add \
  scripts/admin-upload-puzzle.ts \
  apps/api/.env.example \
  CLAUDE.md \
  apps/api/README.md \
  README.md \
  docs/OPERATOR_RUNBOOK.md

git commit -m "docs: make Worker runtime and operations canonical"
```

---

### Task 4: Final Worker-Only Verification

**Files:** No committed files unless verification exposes a defect in Tasks 1–3.

- [ ] **Step 1: Verify the deletion boundary**

```bash
! test -e apps/api/src/index.ts
! test -e apps/api/src/db.ts
! test -e apps/api/src/services/storage.ts
! test -e apps/api/src/services/player-auth.ts
! test -e apps/api/src/routes/admin.ts
! test -e apps/api/src/routes/auth.ts
! test -e apps/api/src/routes/player.ts
! test -e apps/api/src/routes/puzzles.ts
! test -e apps/api/src/routes/puzzles.complete.ts
! test -e apps/api/src/routes/_cross-runtime-drift.test.ts
```

Expected: every assertion exits zero.

- [ ] **Step 2: Verify no Bun HTTP imports/scripts/types remain in the API package**

```bash
! rg -n \
  "(from|vi\\.mock\\() ['\"](\\.\\.?/)+(db|routes/(admin|auth|player|puzzles)(\\.complete)?|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|utils/jigsawPath|types(/index)?)[ '\"]" \
  apps/api/src \
  --glob '*.ts'

! rg -n "dev:bun|build:bun|start:bun" apps/api/package.json apps/web/playwright.config.ts
! rg -n "from ['\"]bun:|import\\(['\"]bun:|\\bBun\." apps/api/src
! rg -n '"bun"' apps/api/tsconfig.json
```

Expected: all commands exit zero. Root/shared Bun tooling is intentionally outside this assertion.

- [ ] **Step 3: Verify shared Bun driver remains intentional**

```bash
rg -n "@perseus/shared/bun|drivers/bun" \
  packages/shared apps scripts \
  --glob '!apps/api/src/db.ts'
```

Expected: shared-package tests still reference the Bun driver. Do not delete it in HPA-555.

- [ ] **Step 4: Verify local D1 migration state**

```bash
cd apps/api
bun run db:migrate:local
bunx wrangler d1 execute perseus-player-data --local --config wrangler.toml \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
cd ../..
```

Expected: migrations apply/already-applied and the local database returns the migrated table list.

- [ ] **Step 5: Verify normal Worker development startup**

Start in one terminal:

```bash
bun run dev --filter=@perseus/api
```

Then from another terminal:

```bash
curl --fail http://localhost:4690/health
```

Expected response:

```json
{"status":"ok"}
```

Stop the dev server after the probe.

- [ ] **Step 6: Run all code gates**

```bash
bun run build --filter=@perseus/api
bun run check --filter=@perseus/api
bun run lint --filter=@perseus/api

cd apps/api
bunx vitest run
cd ../..

bun run --cwd apps/web test:e2e:smoke
```

Expected: all commands pass against the single Worker implementation.

- [ ] **Step 7: Verify active documentation/tooling invariants**

```bash
! rg -n \
  "dual runtime|dev:bun|build:bun|start:bun|Bun API|DATA_DIR|PORT=3000|127\.0\.0\.1:3000|localhost:3000|src/lib/services/progress\.ts" \
  README.md CLAUDE.md apps/api/README.md apps/api/.env.example scripts/admin-upload-puzzle.ts docs/OPERATOR_RUNBOOK.md

rg -n "http://127\.0\.0\.1:4690|http://localhost:4690" \
  scripts/admin-upload-puzzle.ts apps/api/.env.example README.md CLAUDE.md docs/OPERATOR_RUNBOOK.md

rg -n "Admin CLI Uploads|admin:upload|Token rotation" docs/OPERATOR_RUNBOOK.md
```

Expected: stale runtime guidance is gone, Worker local port references exist, and Admin CLI procedures remain discoverable in the runbook.

- [ ] **Step 8: Review final scope and commits**

```bash
git status --short
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
```

Expected implementation commits are approximately:

```text
test(e2e): run API backend with Wrangler
refactor(api): remove duplicate Bun HTTP runtime
docs: make Worker runtime and operations canonical
```

Do not add a `.worker.ts` rename pass, compatibility layer, second Wrangler config, endpoint/auth redesign, HPA-556 work, or HPA-558 CI changes.
