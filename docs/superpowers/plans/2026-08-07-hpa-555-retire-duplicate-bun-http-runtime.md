# HPA-555 — Retire Duplicate Bun HTTP Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cloudflare Workers the only Perseus HTTP API runtime for development, E2E, and production while keeping Bun for package management, scripts, and tests.

**Architecture:** Prove the Worker-backed Playwright server first, then delete the duplicate Bun HTTP implementation and every test tied to it. Keep the surviving `*.worker.ts` names and existing shared/Cloudflare architecture. Finish by preserving the Admin CLI operating guidance in the existing runbook, aligning local tooling with port 4690, and running Worker-only verification.

**Tech Stack:** Bun 1.3.14, Hono, Cloudflare Workers/Wrangler 4.60, D1, KV, R2, Durable Objects, Workflows, Vitest 4, Playwright 1.57, SvelteKit.

## Global Constraints

- `apps/api/src/worker.ts` is the sole HTTP API entry point after this work.
- Normal API development remains Wrangler on port `4690`; E2E uses the same Worker code on port `3999`.
- Keep Bun as workspace package manager/script/test runtime.
- Keep surviving `*.worker.ts` and `.worker.test.ts` names.
- Do not add route factories, DI, repository frameworks, compatibility wrappers, another Wrangler config, or an optional Bun HTTP mode.
- Do not redesign endpoint/auth/Cloudflare behavior or pull HPA-556/HPA-558 work into this ticket.
- Local filesystem API data may be discarded.
- `AGENTS.md` is a symlink to `CLAUDE.md`; do not edit it separately.
- Keep `@perseus/shared/bun`; shared-package tests still use it independently of the HTTP server.
- Preserve `PUBLIC_API_BASE=http://localhost:3999` for Playwright.
- Treat `@types/bun` in `apps/api/package.json` and `"bun"` in `apps/api/tsconfig.json` as one cleanup decision.

## Dependency Order

```text
Task 1 Worker-backed E2E replacement
  -> Task 2 delete Bun HTTP runtime + complete Bun-only test set
  -> Task 3 local tooling + content-preserving docs move
  -> Task 4 final Worker-only verification
```

---

### Task 1: Replace the Playwright Bun Backend with Wrangler

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/web/playwright.config.ts`

**Produces:** `bun run dev:e2e` serving the Worker API on port 3999, with Playwright waiting on `/health` for up to 180 seconds.

- [ ] **Step 1: Confirm and baseline the current backend**

```bash
rg -n "build:bun|start:bun|PUBLIC_API_BASE|3999" \
  apps/web/playwright.config.ts apps/api/package.json
bun run --cwd apps/web test:e2e:smoke
```

Expected: Playwright still starts `build:bun && start:bun`; current smoke passes.

- [ ] **Step 2: Add the Worker E2E bootstrap**

Add to `apps/api/package.json`:

```json
"dev:e2e": "mkdir -p dist/e2e-assets && touch dist/e2e-assets/index.html && bun run db:migrate:local && wrangler dev --port 3999 --env dev -c wrangler.toml -c ../workflows/wrangler.dev.toml --assets dist/e2e-assets --var JWT_SECRET:e2e-test-secret --var ADMIN_PASSKEY:e2e-test-passkey --var GOOGLE_CLIENT_ID:e2e-google-client --var GOOGLE_CLIENT_SECRET:e2e-google-secret --var AUTH_REDIRECT_BASE_URL:http://localhost:3999 --var ALLOWED_ORIGINS:http://localhost:4173,http://127.0.0.1:4173 --var NODE_ENV:development"
```

Keep normal `dev` unchanged. The first Wrangler config is the HTTP Worker; the workflows config is the bound secondary Worker. `--assets dist/e2e-assets` supplies the existing `ASSETS` binding without racing the concurrent frontend build.

- [ ] **Step 3: Point Playwright at `dev:e2e`**

Replace only the API `webServer` entry with:

```ts
{
	command: 'bun run dev:e2e',
	url: 'http://localhost:3999/health',
	cwd: '../api',
	reuseExistingServer: !process.env.CI,
	timeout: 180_000
}
```

Keep the frontend server and:

```ts
PUBLIC_API_BASE: process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'
```

unchanged.

- [ ] **Step 4: Verify the replacement before any deletion**

```bash
bunx prettier --check apps/api/package.json apps/web/playwright.config.ts
git diff --check
bun run --cwd apps/web test:e2e:smoke
```

Expected: migrations apply/already-applied, Wrangler serves health on 3999, and Chromium desktop/mobile smoke passes. Treat smoke as the Worker-server/harness integration gate; Worker API tests carry endpoint behavior.

If multi-config or `--assets` fails, fix only this bootstrap command. Do not create another Wrangler project.

- [ ] **Step 5: Commit**

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
- Delete: Bun HTTP source and tests listed below

- [ ] **Step 1: Baseline canonical Worker tests**

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

- [ ] **Step 2: Record exact references to modules that will disappear**

```bash
rg -n \
  "['\"](\.\.?/)+(db|routes/(admin|auth|player|puzzles)(\.complete)?|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|utils/jigsawPath|types(/index)?)['\"]" \
  apps/api/src --glob '*.ts'
```

This deliberately matches exact quoted relative module paths regardless of whether they appear in `import`, `from`, or `vi.mock(...)`, and does not match `.worker`/`.shared` suffixes.

Also record scripts:

```bash
rg -n "dev:bun|build:bun|start:bun|src/index\.ts" \
  apps/api/package.json apps/web/playwright.config.ts
```

- [ ] **Step 3: Make `db.worker.ts` self-contained**

Use:

```ts
import { createD1CompletionWriteExecutor, createD1Db } from '@perseus/shared/d1';
import type { AppDb, CompletionWriteExecutor } from '@perseus/shared';
import type { Env } from './worker';

export interface ApiDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
}
```

Keep `getWorkerDbContext()`/`getWorkerDb()` behavior unchanged. Do not create `db.shared.ts`.

- [ ] **Step 4: Delete Bun HTTP source**

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

Keep all `*.worker.ts`, `*.shared.ts`, shared packages, reaper code, and workflows code.

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

Do not port these just to preserve test count; their implementation target is gone and Worker sibling suites remain.

- [ ] **Step 6: Prove no exact Bun-module reference was missed**

```bash
! rg -n \
  "['\"](\.\.?/)+(db|routes/(admin|auth|player|puzzles)(\.complete)?|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|utils/jigsawPath|types(/index)?)['\"]" \
  apps/api/src --glob '*.ts'
```

Expected: no matches. This catches direct sibling forms such as `./storage`, `./rate-limit`, `./auth`, and `./player-auth` as well as `../db`/route/service imports.

- [ ] **Step 7: Remove stale Vitest config and Bun HTTP scripts**

Delete from `apps/api/vitest.config.ts`:

```ts
exclude: ['src/__tests__/puzzles.test.ts'],
```

Delete from `apps/api/package.json`:

```json
"dev:bun": "bun run --watch src/index.ts",
"build:bun": "bun build src/index.ts --outdir dist --target bun && rm -rf dist/drizzle && cp -R ../../packages/shared/drizzle dist/drizzle",
"start:bun": "bun run dist/index.js"
```

Keep Task 1 `dev:e2e` and all Worker scripts.

- [ ] **Step 8: Remove API Bun type dependency and tsconfig entry together**

First verify the surviving API tree has no Bun runtime/type usage:

```bash
! rg -n "from ['\"]bun:|import\(['\"]bun:|\bBun\." apps/api/src
```

Expected: no matches.

Then remove `@types/bun` from `apps/api/package.json` and change `apps/api/tsconfig.json` to:

```json
"types": ["@cloudflare/workers-types", "node"]
```

Do not remove root/shared Bun tooling.

- [ ] **Step 9: Refresh and verify the deletion**

```bash
bun install
bunx prettier --check \
  apps/api/package.json \
  apps/api/tsconfig.json \
  apps/api/vitest.config.ts \
  apps/api/src/db.worker.ts
git diff --check

cd apps/api
bunx vitest run
cd ../..

bun run check --filter=@perseus/api
bun run build --filter=@perseus/api
bun run lint --filter=@perseus/api
bun run --cwd apps/web test:e2e:smoke
```

Expected: all surviving API tests/build gates and Worker-backed smoke pass with the Bun server physically gone.

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

Update both usage/help references to the same new default. Leave production/bulk uploader defaults unchanged.

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

Do not duplicate material the runbook already owns: replace the README's old CI seed-workflow body with a pointer to **§5 Seed Startup Puzzles**, and replace its service-token blast-radius body with a pointer to **§8 Cloudflare Access (Admin Gate)** plus `packages/infrastructure/src/admin-access.ts`.

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

- `apps/api` is Hono on Cloudflare Workers for dev + production;
- `src/worker.ts` is the HTTP entry;
- existing `*.worker.ts` files are the route/service implementations;
- local API uses Wrangler bindings on 4690;
- Bun is package/test tooling, not an HTTP server;
- remove the dual-runtime table, Bun `PORT`/`DATA_DIR` section, and stale `src/lib/services/progress.ts` reference.

Keep unrelated infrastructure/testing/runbook guidance unchanged.

- [ ] **Step 7: Verify no documentation was orphaned**

```bash
! rg -n \
  "dual runtime|dev:bun|build:bun|start:bun|Bun API|DATA_DIR|PORT=3000|127\.0\.0\.1:3000|localhost:3000|src/lib/services/progress\.ts" \
  README.md CLAUDE.md apps/api/README.md apps/api/.env.example scripts/admin-upload-puzzle.ts docs/OPERATOR_RUNBOOK.md

rg -n \
  "Admin CLI Uploads|admin:upload|admin:startup:upload|CF_ACCESS_CLIENT_ID|Token rotation|Idempotency" \
  docs/OPERATOR_RUNBOOK.md
```

Expected: no stale runtime guidance, and the runbook still contains the operating procedures removed from root README.

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

**Files:** No committed files unless verification exposes a defect in Tasks 1–3.

- [ ] **Step 1: Verify deletion and exact-reference invariants**

```bash
! test -e apps/api/src/index.ts
! test -e apps/api/src/db.ts
! test -e apps/api/src/services/storage.ts
! test -e apps/api/src/routes/_cross-runtime-drift.test.ts

! rg -n \
  "['\"](\.\.?/)+(db|routes/(admin|auth|player|puzzles)(\.complete)?|middleware/(auth|player-auth|rate-limit)|services/(storage|player-auth|puzzle-generator)|utils/jigsawPath|types(/index)?)['\"]" \
  apps/api/src --glob '*.ts'

! rg -n "dev:bun|build:bun|start:bun" apps/api/package.json apps/web/playwright.config.ts
! rg -n "from ['\"]bun:|import\(['\"]bun:|\bBun\." apps/api/src
! rg -n '"bun"' apps/api/tsconfig.json
```

Expected: all assertions exit zero. Root/shared Bun tooling is outside these checks.

- [ ] **Step 2: Verify the shared Bun driver is still intentionally used**

```bash
rg -n "@perseus/shared/bun|drivers/bun" packages/shared
```

Expected: shared-package tests still cover the driver.

- [ ] **Step 3: Verify local D1 and Worker startup**

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
```

Expected health body:

```json
{"status":"ok"}
```

- [ ] **Step 4: Run all code gates**

```bash
bun run build --filter=@perseus/api
bun run check --filter=@perseus/api
bun run lint --filter=@perseus/api

cd apps/api
bunx vitest run
cd ../..

bun run --cwd apps/web test:e2e:smoke
```

Expected: all pass against the single Worker implementation.

- [ ] **Step 5: Verify active docs/tooling and final scope**

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
test(e2e): run API backend with Wrangler
refactor(api): remove duplicate Bun HTTP runtime
docs: make Worker runtime and operations canonical
```

Do not add a `.worker.ts` rename pass, compatibility layer, second Wrangler config, endpoint/auth redesign, HPA-556 work, or HPA-558 CI changes.
