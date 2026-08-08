# HPA-555 — Retire Duplicate Bun HTTP Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cloudflare Workers the only Perseus HTTP API runtime for development, E2E, and production while keeping Bun for package management, scripts, and tests.

**Architecture:** First remove the pre-existing Worker-entrypoint export that prevents the configured multi-worker Wrangler dev runtime from starting. Then prove the Worker dev path, replace Playwright's Bun backend with that Worker runtime, and only then delete the Bun HTTP implementation and its tests. Finish by aligning local tooling/docs and validating the surviving module graph with TypeScript plus the same coverage-enabled API test command CI runs.

**Tech Stack:** Bun 1.3.14, Hono, Cloudflare Workers/Wrangler 4.60, D1, KV, R2, Durable Objects, Workflows, Vitest 4, Playwright 1.57, SvelteKit.

## Global Constraints

- `apps/api/src/worker.ts` is the sole HTTP API entry point after this work.
- Normal API development uses the configured Wrangler `dev` command on port `4690`; E2E uses the same Worker code on port `3999`.
- Keep Bun as workspace package manager/script/test runtime.
- Keep surviving `*.worker.ts` and `.worker.test.ts` names; do not mass-rename them.
- Do not add route factories, DI, repository frameworks, compatibility wrappers, a second Wrangler config, or an optional Bun HTTP mode.
- Do not redesign endpoints/auth/Cloudflare behavior or pull HPA-556/HPA-558 work into this ticket.
- Local filesystem API data may be discarded; do not migrate it.
- `AGENTS.md` is a symlink to `CLAUDE.md`; do not edit it separately.
- Keep `@perseus/shared/bun`; shared-package tests still use it independently of the HTTP server.
- Preserve `PUBLIC_API_BASE=http://localhost:3999` for Playwright.
- Treat `@types/bun` in `apps/api/package.json` and `"bun"` in `apps/api/tsconfig.json` as one cleanup decision.
- Compiler + package tests are the authoritative deletion-safety gates. Grep is an inventory aid only.

## Dependency Order

```text
Task 0 unblock configured Worker dev runtime
  -> Task 1 Worker-backed E2E replacement + provenance proof
  -> Task 2 delete Bun HTTP runtime + complete Bun-only test set + dead helper
  -> Task 3 local tooling + content-preserving docs move
  -> Task 4 final Worker-only verification
```

---

### Task 0: Unblock the Existing Multi-Worker Wrangler Runtime

**Files:**

- Modify: `apps/workflows/src/index.ts`

**Produces:** The existing `bun run dev --filter=@perseus/api` command can start the API + workflows Workers on port 4690 without Wrangler rejecting a plain runtime export.

**Interfaces:**

- `CURRENT_RESERVATION_SCHEMA` stays a file-local numeric constant with value `1`.
- `PuzzleMetadataDO`, `PerseusWorkflow`, and other valid Worker entrypoint exports remain unchanged.
- Type-only exports such as `export interface Env` remain unchanged.

- [ ] **Step 1: Confirm the blocker is still present and not imported elsewhere**

```bash
rg -n "CURRENT_RESERVATION_SCHEMA" apps packages scripts
```

Expected: all runtime references are within `apps/workflows/src/index.ts`; there is no external import that depends on the export.

- [ ] **Step 2: Make the constant file-local**

Change:

```ts
export const CURRENT_RESERVATION_SCHEMA = 1;
```

to:

```ts
const CURRENT_RESERVATION_SCHEMA = 1;
```

Do not change its value or reservation behavior.

- [ ] **Step 3: Run static workflows checks**

```bash
bun run check --filter=@perseus/workflows
bun run lint --filter=@perseus/workflows
```

Expected: both pass.

- [ ] **Step 4: Prove the configured Worker dev runtime actually boots**

Terminal A:

```bash
cd apps/api
bun run db:migrate:local
cd ../..
bun run dev --filter=@perseus/api
```

Terminal B:

```bash
curl --fail http://localhost:4690/health
```

Expected body:

```json
{"status":"ok"}
```

Stop the dev process after the probe.

This is a hard gate. Do not proceed to Task 1 if the configured Worker runtime does not serve health successfully.

- [ ] **Step 5: Commit**

```bash
git add apps/workflows/src/index.ts
git commit -m "fix(workflows): keep reservation schema constant internal"
```

---

### Task 1: Replace the Playwright Bun Backend with Wrangler

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/web/playwright.config.ts`

**Produces:** `bun run dev:e2e` serves the Worker API on port 3999; Playwright waits on Worker-only `GET /api` for up to 180 seconds.

- [ ] **Step 1: Baseline both current paths before changing E2E**

Confirm the Bun-backed E2E dependency still exists:

```bash
rg -n "build:bun|start:bun|PUBLIC_API_BASE|3999" \
  apps/web/playwright.config.ts apps/api/package.json
bun run --cwd apps/web test:e2e:smoke
```

Expected: current Bun-backed smoke passes.

Then reconfirm Task 0's Worker path before replacing the fallback:

Terminal A:

```bash
bun run dev --filter=@perseus/api
```

Terminal B:

```bash
curl --fail http://localhost:4690/api
```

Expected: HTTP 200 with the Perseus API info JSON. Stop the dev process.

- [ ] **Step 2: Add the deterministic Worker E2E bootstrap**

Add to `apps/api/package.json`:

```json
"dev:e2e": "mkdir -p dist/e2e-assets && touch dist/e2e-assets/index.html && bun run db:migrate:local && wrangler dev --port 3999 --env dev -c wrangler.toml -c ../workflows/wrangler.dev.toml --assets dist/e2e-assets --var JWT_SECRET:e2e-test-secret --var ADMIN_PASSKEY:e2e-test-passkey --var GOOGLE_CLIENT_ID:e2e-google-client --var GOOGLE_CLIENT_SECRET:e2e-google-secret --var AUTH_REDIRECT_BASE_URL:http://localhost:3999 --var ALLOWED_ORIGINS:http://localhost:4173,http://127.0.0.1:4173 --var NODE_ENV:development"
```

Keep the normal `dev` command unchanged.

The command intentionally reuses:

- the existing API Wrangler config;
- the existing workflows Wrangler config;
- local D1/KV/R2/DO/Workflow simulation;
- deterministic non-production variables;
- a generated `dist/e2e-assets` directory so `ASSETS` does not depend on the concurrently built web bundle.

Do not add `.dev.vars.e2e`, a helper shell script, or another Wrangler config.

- [ ] **Step 3: Make Playwright readiness Worker-specific**

Replace only the API `webServer` entry with:

```ts
{
	command: 'bun run dev:e2e',
	url: 'http://localhost:3999/api',
	cwd: '../api',
	reuseExistingServer: !process.env.CI,
	timeout: 180_000
}
```

Keep the frontend server entry and:

```ts
PUBLIC_API_BASE: process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'
```

unchanged.

`GET /api` is intentional: the Worker entrypoint exposes it and the Bun entrypoint does not. A leftover Bun process therefore cannot satisfy Playwright's readiness check.

- [ ] **Step 4: Format-check the bootstrap/config change**

```bash
bunx prettier --check apps/api/package.json apps/web/playwright.config.ts
git diff --check
```

Expected: both pass.

- [ ] **Step 5: Prove the E2E server is the Worker before trusting smoke**

Free any stale listener on port 3999 first:

```bash
PIDS="$(lsof -tiTCP:3999 -sTCP:LISTEN || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS
fi
```

Start the new backend manually.

Terminal A:

```bash
cd apps/api
bun run dev:e2e
```

Terminal B:

```bash
curl --fail http://localhost:3999/api
```

Expected: HTTP 200 with Perseus API info. Stop the manual E2E API process before the next step.

- [ ] **Step 6: Run smoke through Playwright's own webServer lifecycle**

Make sure 3999 is free, then run:

```bash
PIDS="$(lsof -tiTCP:3999 -sTCP:LISTEN || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS
fi

bun run --cwd apps/web test:e2e:smoke
```

Expected:

- local D1 migrations complete or report already applied;
- Playwright starts `bun run dev:e2e`;
- its readiness URL `/api` succeeds only after the Worker is live;
- Chromium desktop/mobile smoke passes.

Treat smoke as the Worker-server/gameplay-harness integration gate. Worker API tests carry endpoint behavior; do not add a parity E2E suite.

- [ ] **Step 7: Commit**

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
- Delete: Bun HTTP source/tests and orphan helper listed below

- [ ] **Step 1: Baseline canonical Worker tests**

Run the focused Worker suite before deletion:

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

Expected: all pass.

- [ ] **Step 2: Inventory current references for review context only**

Use grep only to understand the current deletion surface:

```bash
rg -n \
  "db|routes/(admin|auth|player|puzzles)|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|puzzle-ready|jigsawPath" \
  apps/api/src --glob '*.ts'
```

This is not a correctness gate. The authoritative post-delete checks are TypeScript compilation plus the full API test command.

- [ ] **Step 3: Make `db.worker.ts` self-contained**

Replace its imports of `ApiDbContext` from `./db` with:

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

- [ ] **Step 4: Delete Bun HTTP source and the orphaned readiness helper**

```bash
rm \
  apps/api/src/index.ts \
  apps/api/src/db.ts \
  apps/api/src/routes/admin.ts \
  apps/api/src/routes/auth.ts \
  apps/api/src/routes/player.ts \
  apps/api/src/routes/puzzles.ts \
  apps/api/src/routes/puzzles.complete.ts \
  apps/api/src/routes/puzzle-ready.ts \
  apps/api/src/middleware/auth.ts \
  apps/api/src/middleware/player-auth.ts \
  apps/api/src/middleware/rate-limit.ts \
  apps/api/src/services/storage.ts \
  apps/api/src/services/player-auth.ts \
  apps/api/src/services/puzzle-generator.ts \
  apps/api/src/utils/jigsawPath.ts \
  apps/api/src/types/index.ts
```

Keep all `*.worker.ts`, `*.shared.ts`, shared packages, reaper code, and workflows code.

`puzzle-ready.ts` is deleted because after the Bun routes/completion/parity code disappears, its only remaining consumer would be its own test.

- [ ] **Step 5: Delete the complete known Bun-only/parity test set**

```bash
rm -f \
  apps/api/src/routes/_cross-runtime-drift.test.ts \
  apps/api/src/routes/puzzles.test.ts \
  apps/api/src/routes/puzzles-coverage.test.ts \
  apps/api/src/routes/puzzles.complete.test.ts \
  apps/api/src/routes/puzzle-ready.test.ts \
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

Do not port these solely to preserve test count; their implementation target is gone and Worker sibling suites remain.

- [ ] **Step 6: Remove stale test config and redundant server scripts**

Delete from `apps/api/vitest.config.ts`:

```ts
exclude: ['src/__tests__/puzzles.test.ts'],
```

Delete from `apps/api/package.json`:

```json
"dev:bun": "bun run --watch src/index.ts",
"build:bun": "bun build src/index.ts --outdir dist --target bun && rm -rf dist/drizzle && cp -R ../../packages/shared/drizzle dist/drizzle",
"start": "wrangler dev --local",
"start:bun": "bun run dist/index.js"
```

Keep normal configured `dev`, Task 1 `dev:e2e`, Worker `build`, deploy, migration, test, check, and lint commands.

- [ ] **Step 7: Remove API Bun types atomically if usage is gone**

Verify the surviving API tree:

```bash
! rg -n "from ['\"]bun:|import\(['\"]bun:|\bBun\." apps/api/src
```

Expected: no matches.

Then remove `@types/bun` from `apps/api/package.json` and change `apps/api/tsconfig.json` to:

```json
"types": ["@cloudflare/workers-types", "node"]
```

Do not remove root/shared Bun tooling.

- [ ] **Step 8: Refresh dependencies and run the authoritative module/test gates**

```bash
bun install
bunx prettier --check \
  apps/api/package.json \
  apps/api/tsconfig.json \
  apps/api/vitest.config.ts \
  apps/api/src/db.worker.ts
git diff --check

bun run check --filter=@perseus/api
bun run test:unit --filter=@perseus/api
```

Expected:

- TypeScript reports no dangling imports in the surviving API source tree;
- the coverage-enabled API test command used by CI passes, including runtime `vi.mock()` resolution.

If either fails because a deleted module is still referenced, fix the surviving consumer or delete an overlooked Bun-only test/helper according to the deletion boundary. Do not add a compatibility wrapper.

- [ ] **Step 9: Run remaining API/Worker integration gates**

```bash
bun run build --filter=@perseus/api
bun run lint --filter=@perseus/api
bun run --cwd apps/web test:e2e:smoke
```

Expected: all pass with the Bun HTTP server physically gone.

- [ ] **Step 10: Commit**

```bash
git add -A apps/api bun.lock
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

- [ ] **Step 1: Point the single-upload CLI at Worker dev**

Change:

```ts
const LOCAL_SERVER = 'http://127.0.0.1:3000';
```

to:

```ts
const LOCAL_SERVER = 'http://127.0.0.1:4690';
```

Update the usage/help default to the same port. Leave production/bulk uploader defaults unchanged.

- [ ] **Step 2: Remove Bun-only env examples**

Delete from `apps/api/.env.example`:

```dotenv
# Server port (optional, default: 3000)
PORT=3000

# Data directory (optional, default: ./data)
DATA_DIR=./data
```

Keep Worker secrets/OAuth examples and `AUTH_REDIRECT_BASE_URL=http://localhost:4690`.

- [ ] **Step 3: Preserve the Admin CLI how-to in the existing runbook**

Add a final section to `docs/OPERATOR_RUNBOOK.md`:

```markdown
## 11. Admin CLI Uploads
```

Move the useful content currently under root `README.md` `## Admin CLI: upload puzzles` into it:

- credentials and Pulumi output exports;
- readiness command;
- single-puzzle upload command/flags/valid piece counts;
- bulk/startup catalog commands/options;
- token rotation;
- idempotency behavior;
- notes about service tokens, processing state, and keeping secrets/assets out of git.

Change local `http://127.0.0.1:3000` references to `http://127.0.0.1:4690`. Keep production examples unchanged.

Do not duplicate material the runbook already owns: replace the old seed-workflow body with a pointer to **§5 Seed Startup Puzzles**, and replace service-token blast-radius detail with a pointer to **§8 Cloudflare Access (Admin Gate)** plus `packages/infrastructure/src/admin-access.ts`.

- [ ] **Step 4: Slim the root README only after Step 3**

Replace it with:

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

- [ ] **Step 5: Replace the API README**

Use:

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

- [ ] **Step 6: Make `CLAUDE.md` Worker-only**

Update only active guidance:

- `apps/api` is Hono on Cloudflare Workers for development + production;
- `src/worker.ts` is the HTTP entry;
- existing `*.worker.ts` files are the route/service implementations;
- local API uses Wrangler bindings on 4690;
- Bun is package/test tooling, not an HTTP server;
- remove dual-runtime table and Bun `PORT`/`DATA_DIR` section;
- remove stale `src/lib/services/progress.ts` reference.

Keep unrelated infrastructure/testing/runbook guidance unchanged.

- [ ] **Step 7: Verify documentation was moved rather than lost**

```bash
! rg -n \
  "dual runtime|dev:bun|build:bun|start:bun|Bun API|DATA_DIR|PORT=3000|127\.0\.0\.1:3000|localhost:3000|src/lib/services/progress\.ts" \
  README.md CLAUDE.md apps/api/README.md apps/api/.env.example scripts/admin-upload-puzzle.ts docs/OPERATOR_RUNBOOK.md

rg -n \
  "Admin CLI Uploads|admin:upload|admin:startup:upload|CF_ACCESS_CLIENT_ID|Token rotation|Idempotency" \
  docs/OPERATOR_RUNBOOK.md
```

Expected: no stale runtime guidance; the runbook still contains the operating procedures removed from root README.

- [ ] **Step 8: Validate and commit**

```bash
bun run check:scripts
bun run test:scripts
bunx prettier --check \
  scripts/admin-upload-puzzle.ts \
  apps/api/.env.example \
  CLAUDE.md apps/api/README.md README.md docs/OPERATOR_RUNBOOK.md
git diff --check

git add \
  scripts/admin-upload-puzzle.ts apps/api/.env.example \
  CLAUDE.md apps/api/README.md README.md docs/OPERATOR_RUNBOOK.md
git commit -m "docs: make Worker runtime and operations canonical"
```

---

### Task 4: Final Worker-Only Verification

**Files:** No committed files unless verification exposes a defect in Tasks 0–3.

- [ ] **Step 1: Verify critical deletion outcomes**

```bash
! test -e apps/api/src/index.ts
! test -e apps/api/src/db.ts
! test -e apps/api/src/services/storage.ts
! test -e apps/api/src/routes/_cross-runtime-drift.test.ts
! test -e apps/api/src/routes/puzzle-ready.ts
! test -e apps/api/src/routes/puzzle-ready.test.ts

! rg -n "dev:bun|build:bun|start:bun" apps/api/package.json apps/web/playwright.config.ts
! rg -n '"start"[[:space:]]*:[[:space:]]*"wrangler dev --local"' apps/api/package.json
! rg -n "from ['\"]bun:|import\(['\"]bun:|\bBun\." apps/api/src
! rg -n '"bun"' apps/api/tsconfig.json
```

These are focused outcome assertions, not an attempt to model the entire import graph with grep.

- [ ] **Step 2: Run the authoritative module/test gates again**

```bash
bun run check --filter=@perseus/api
bun run test:unit --filter=@perseus/api
```

Expected: TypeScript resolves the surviving module graph and the CI-equivalent coverage-enabled API suite passes.

- [ ] **Step 3: Verify the shared Bun driver remains intentionally used**

```bash
rg -n "@perseus/shared/bun|drivers/bun" packages/shared
```

Expected: shared-package tests still cover the driver.

- [ ] **Step 4: Verify local D1 and Worker startup**

```bash
cd apps/api
bun run db:migrate:local
bunx wrangler d1 execute perseus-player-data --local --config wrangler.toml \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
cd ../..
```

Then start:

```bash
bun run dev --filter=@perseus/api
```

and in another terminal:

```bash
curl --fail http://localhost:4690/health
curl --fail http://localhost:4690/api
```

Expected health body:

```json
{"status":"ok"}
```

Both requests must return 2xx.

- [ ] **Step 5: Run remaining code/integration gates**

```bash
bun run build --filter=@perseus/api
bun run lint --filter=@perseus/api
bun run check --filter=@perseus/workflows
bun run lint --filter=@perseus/workflows
bun run --cwd apps/web test:e2e:smoke
```

Expected: all pass against the single Worker implementation.

- [ ] **Step 6: Verify active docs/tooling and final scope**

```bash
! rg -n \
  "dual runtime|dev:bun|build:bun|start:bun|Bun API|DATA_DIR|PORT=3000|127\.0\.0\.1:3000|localhost:3000|src/lib/services/progress\.ts" \
  README.md CLAUDE.md apps/api/README.md apps/api/.env.example scripts/admin-upload-puzzle.ts docs/OPERATOR_RUNBOOK.md

rg -n "http://127\.0\.0\.1:4690|http://localhost:4690" \
  scripts/admin-upload-puzzle.ts apps/api/.env.example README.md CLAUDE.md docs/OPERATOR_RUNBOOK.md
rg -n "Admin CLI Uploads|admin:upload|Token rotation" docs/OPERATOR_RUNBOOK.md

git status --short
git diff --check main...HEAD
git log --oneline main..HEAD
```

Expected implementation commit shape:

```text
fix(workflows): keep reservation schema constant internal
test(e2e): run API backend with Wrangler
refactor(api): remove duplicate Bun HTTP runtime
docs: make Worker runtime and operations canonical
```

Do not add a `.worker.ts` rename pass, compatibility layer, second Wrangler config, endpoint/auth redesign, HPA-556 work, or HPA-558 CI changes.