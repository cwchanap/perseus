# HPA-555 — Retire Duplicate Bun HTTP Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cloudflare Workers the only Perseus HTTP API runtime for development, E2E, and production while keeping Bun only as package manager/test tooling.

**Architecture:** First switch Playwright to a Wrangler-backed local API so the Bun server has no runtime consumer. Then delete the Bun entry point, filesystem routes/services/middleware/tests and obsolete scripts in one deletion-focused task. Keep surviving `*.worker.ts` names, shared domain/database utilities, and Cloudflare infrastructure unchanged.

**Tech Stack:** Bun 1.3.14, Hono, Cloudflare Workers/Wrangler 4.60, D1, KV, R2, Durable Objects, Workflows, Vitest 4, Playwright 1.57, SvelteKit.

## Global Constraints

- `apps/api/src/worker.ts` is the sole HTTP API entry point after this work.
- Normal API development remains `wrangler dev` on port `4690` with `--env dev` and the existing API + workflows configs.
- Gameplay E2E runs the same Worker implementation on deterministic port `3999`.
- Keep Bun as the workspace package manager, script runtime, and test runner.
- Keep surviving `*.worker.ts` and `.worker.test.ts` names; do not mass-rename them.
- Do not add runtime-neutral route factories, DI containers, repository frameworks, compatibility wrappers, or a replacement Bun mode.
- Do not redesign endpoints, authentication, Cloudflare bindings, deployment architecture, or workflow behavior.
- Local filesystem API data may be discarded; do not migrate it.
- Do not change completion/session compatibility behavior assigned to HPA-556.
- Do not simplify CI workflow topology assigned to HPA-558.
- `AGENTS.md` is already a symlink to `CLAUDE.md`; do not edit it separately.
- `@perseus/shared/bun` is outside the HTTP-runtime deletion unless a final repository-wide reference sweep proves it is unused independently.
- Use existing Wrangler local binding simulation; do not add a second permanent Wrangler E2E config.
- Use Wrangler CLI `--assets` only to provide an API-only E2E assets directory and avoid the concurrent frontend-build startup race.
- Preserve `PUBLIC_API_BASE=http://localhost:3999` for Playwright.

## Dependency Order

```text
Task 1 Worker-backed E2E replacement
  -> Task 2 delete Bun HTTP runtime + Bun-only tests/scripts
  -> Task 3 align local tooling and active documentation
  -> Task 4 final Worker-only verification
```

## File Map

| Path | Responsibility after HPA-555 |
| --- | --- |
| `apps/api/src/worker.ts` | Sole HTTP entry point and scheduled Worker handler. |
| `apps/api/src/db.worker.ts` | Worker D1 DB context, including its own small `ApiDbContext` type. |
| `apps/api/package.json` | Wrangler dev/build/deploy plus deterministic `dev:e2e`; no Bun HTTP server scripts. |
| `apps/web/playwright.config.ts` | Starts Worker-backed API on 3999 and Vite preview on 4173. |
| `scripts/admin-upload-puzzle.ts` | Local single-upload CLI defaults to canonical Worker port 4690. |
| `CLAUDE.md` | Canonical contributor guide; `AGENTS.md` follows via symlink. |
| `apps/api/README.md` | Short Worker-oriented package overview. |
| `README.md` | Product purpose, quick start, and links to contributor/operator docs. |
| `docs/OPERATOR_RUNBOOK.md` | Existing detailed production/admin/operations reference; no new documentation hierarchy. |
| `apps/api/src/index.ts` | Deleted. |
| Bun unsuffixed route/middleware/service siblings | Deleted. |
| Bun filesystem/generator tests and cross-runtime parity tests | Deleted. |

---

### Task 1: Replace the Playwright Bun Backend with Wrangler

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/web/playwright.config.ts`

**Interfaces:**

- Produces: `bun run dev:e2e` in `@perseus/api`, serving the Worker API on `http://localhost:3999`.
- Produces: Playwright API `webServer.command = 'bun run dev:e2e'`.
- Preserves: frontend `PUBLIC_API_BASE=http://localhost:3999`.

- [ ] **Step 1: Record the current E2E dependency on Bun**

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

- [ ] **Step 2: Add the deterministic Worker E2E bootstrap script**

In `apps/api/package.json`, add this script without changing the existing normal `dev` command:

```json
"dev:e2e": "mkdir -p dist/e2e-assets && touch dist/e2e-assets/index.html && bun run db:migrate:local && wrangler dev --port 3999 --env dev -c wrangler.toml -c ../workflows/wrangler.dev.toml --assets dist/e2e-assets --var JWT_SECRET:e2e-test-secret --var ADMIN_PASSKEY:e2e-test-passkey --var GOOGLE_CLIENT_ID:e2e-google-client --var GOOGLE_CLIENT_SECRET:e2e-google-secret --var AUTH_REDIRECT_BASE_URL:http://localhost:3999 --var ALLOWED_ORIGINS:http://localhost:4173,http://127.0.0.1:4173 --var NODE_ENV:development"
```

Rationale encoded by the command:

- `db:migrate:local` applies the existing D1 migrations before the server starts;
- the first `-c` config is the HTTP-exposed API Worker;
- the second `-c` config is the workflows Worker used through bindings;
- Wrangler local mode keeps D1/KV/R2/DO/Workflow data local;
- `--assets dist/e2e-assets` supplies the existing `ASSETS` binding without depending on `apps/web/build` being ready;
- all test values are deterministic and non-production;
- port 3999 stays fixed for `PUBLIC_API_BASE`.

Do not add `.dev.vars.e2e`, a third Wrangler file, or a shell helper script.

- [ ] **Step 3: Point Playwright at `dev:e2e`**

Change only the API server entry in `apps/web/playwright.config.ts` from:

```ts
{
	command: 'bun run build:bun && bun run start:bun',
	port: 3999,
	cwd: '../api',
	reuseExistingServer: !process.env.CI,
	env: {
		...process.env,
		PORT: '3999',
		JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-test-secret',
		ADMIN_PASSKEY: process.env.ADMIN_PASSKEY ?? 'e2e-test-passkey',
		ALLOWED_ORIGINS:
			process.env.ALLOWED_ORIGINS ?? 'http://localhost:4173,http://127.0.0.1:4173',
		NODE_ENV: process.env.NODE_ENV ?? 'test'
	}
}
```

to:

```ts
{
	command: 'bun run dev:e2e',
	url: 'http://localhost:3999/health',
	cwd: '../api',
	reuseExistingServer: !process.env.CI
}
```

Keep the frontend server entry and this line unchanged:

```ts
PUBLIC_API_BASE: process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'
```

Using `/health` as the readiness URL verifies the Worker handler is responding, not merely that a TCP port is open.

- [ ] **Step 4: Format-check the two files**

```bash
bunx prettier --check apps/api/package.json apps/web/playwright.config.ts
git diff --check
```

Expected: both commands exit zero.

- [ ] **Step 5: Run the Worker-backed E2E smoke suite before deleting Bun**

```bash
bun run --cwd apps/web test:e2e:smoke
```

Expected:

- Playwright starts `bun run dev:e2e` from `apps/api`;
- local D1 migrations complete or report already applied;
- Wrangler exposes the API Worker on 3999 and the workflows Worker through bindings;
- the frontend builds/previews independently on 4173;
- Chromium desktop/mobile smoke passes.

If this fails because the API Worker cannot see `ASSETS`, fix only the `dev:e2e` bootstrap command. Do not change `worker.ts` or add a separate Wrangler config to accommodate the test harness.

- [ ] **Step 6: Commit the replacement backend**

```bash
git add apps/api/package.json apps/web/playwright.config.ts
git commit -m "test(e2e): run API backend with Wrangler"
```

---

### Task 2: Delete the Duplicate Bun HTTP Runtime

**Files:**

- Modify: `apps/api/src/db.worker.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/vitest.config.ts`
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
- Delete: Bun-only tests identified below
- Modify if generated: `bun.lock`

**Interfaces:**

- `getWorkerDbContext(env: Env): ApiDbContext` remains unchanged for callers.
- `ApiDbContext` remains `{ db: AppDb; completionWrites: CompletionWriteExecutor }` but is owned by `db.worker.ts`.
- Worker route/service modules and their public HTTP behavior remain unchanged.

- [ ] **Step 1: Baseline the surviving Worker suite**

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

- [ ] **Step 2: Record active references to the Bun-only source tree**

```bash
rg -n \
  "src/index\.ts|routes/(admin|auth|player|puzzles)(\.complete)?'|services/(storage|player-auth|puzzle-generator)'|middleware/(auth|player-auth|rate-limit)'|from './db'|from '../db'|utils/jigsawPath|src/types/index|build:bun|start:bun|dev:bun" \
  apps packages scripts CLAUDE.md README.md \
  --glob '!docs/superpowers/**'
```

Expected active matches are confined to:

- Bun implementation files/tests that this task deletes;
- `apps/api/src/db.worker.ts` type-only import from `./db`;
- `apps/api/package.json` Bun HTTP scripts;
- active documentation corrected in Task 3.

There must be no production Worker route importing a Bun implementation module.

- [ ] **Step 3: Make `db.worker.ts` self-contained before deleting `db.ts`**

Replace:

```ts
import { createD1CompletionWriteExecutor, createD1Db } from '@perseus/shared/d1';
import type { Env } from './worker';
import type { AppDb } from '@perseus/shared';
import type { ApiDbContext } from './db';
```

with:

```ts
import { createD1CompletionWriteExecutor, createD1Db } from '@perseus/shared/d1';
import type { AppDb, CompletionWriteExecutor } from '@perseus/shared';
import type { Env } from './worker';

export interface ApiDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
}
```

Do not create `db.shared.ts` or another context factory.

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

The Worker siblings (`*.worker.ts`), `player-auth.shared.ts`, `puzzles.complete.shared.ts`, `puzzle-ready.ts`, shared packages, reaper services, D1 code, and workflows code stay.

- [ ] **Step 5: Delete Bun-only and parity tests**

Delete these known tests because their implementation target is removed:

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
  apps/api/src/services/storage.test.ts \
  apps/api/src/services/storage-extra.test.ts \
  apps/api/src/services/storage-findOriginal.test.ts \
  apps/api/src/services/storage-idempotency-coverage.test.ts \
  apps/api/src/services/__tests__/storage-reclaim-race.test.ts \
  apps/api/src/services/player-auth.test.ts \
  apps/api/src/__tests__/puzzles.test.ts \
  apps/api/src/__tests__/player.test.ts \
  apps/api/src/__tests__/player-coverage.test.ts \
  apps/api/src/__tests__/player-rename-coverage.test.ts \
  apps/api/src/__tests__/puzzle-generator.test.ts \
  apps/api/src/__tests__/puzzle-generator.getSharp.test.ts \
  apps/api/src/__tests__/jigsawPath.test.ts
```

Then find any remaining test that directly imports a deleted module:

```bash
rg -l \
  "services/(storage|player-auth|puzzle-generator)'|middleware/(auth|player-auth|rate-limit)'|routes/(admin|auth|player|puzzles)(\.complete)?'|from '../db'|from './db'|utils/jigsawPath" \
  apps/api/src \
  --glob '*.test.ts'
```

Expected: no results except references to explicit `*.worker` or `.shared` module names. If an additional test imports a deleted Bun module, delete that test rather than porting it solely to preserve test count.

- [ ] **Step 6: Remove the stale Vitest exclusion**

`apps/api/vitest.config.ts` currently excludes the Bun-only `src/__tests__/puzzles.test.ts`. Remove this line:

```ts
exclude: ['src/__tests__/puzzles.test.ts'],
```

The resulting test block keeps `globals`, `setupFiles`, `include`, and coverage configuration unchanged.

- [ ] **Step 7: Remove Bun HTTP scripts and the API-only Bun type dependency**

In `apps/api/package.json`:

Delete:

```json
"dev:bun": "bun run --watch src/index.ts",
"build:bun": "bun build src/index.ts --outdir dist --target bun && rm -rf dist/drizzle && cp -R ../../packages/shared/drizzle dist/drizzle",
"start:bun": "bun run dist/index.js"
```

Delete this API-package dev dependency:

```json
"@types/bun": "^1.1.15"
```

Keep:

- `dev`
- `dev:e2e`
- `build`
- `deploy`
- D1 migration scripts
- Worker/API tests
- `check`
- `lint`

Do not remove root/workspace Bun dependencies or `@perseus/shared/bun`.

- [ ] **Step 8: Refresh the workspace lock state**

```bash
bun install
```

If `bun.lock` changes, keep only the package metadata change caused by removing `@types/bun` from `@perseus/api`.

- [ ] **Step 9: Prove deleted modules have no active references**

```bash
! rg -n \
  "dev:bun|build:bun|start:bun|src/index\.ts|services/storage'|services/player-auth'|services/puzzle-generator'|middleware/auth'|middleware/player-auth'|middleware/rate-limit'|from './db'|from '../db'|utils/jigsawPath" \
  apps packages scripts \
  --glob '!docs/superpowers/**'
```

Expected: zero matches to deleted Bun modules/scripts. References to `.worker`, `.shared`, `@perseus/shared/bun`, and historical `docs/superpowers/**` are allowed.

- [ ] **Step 10: Run the surviving API verification**

```bash
bun run check --filter=@perseus/api
bun run lint --filter=@perseus/api
bun run build --filter=@perseus/api

cd apps/api
bunx vitest run
cd ../..

bun run --cwd apps/web test:e2e:smoke
```

Expected:

- type-check, lint, and Worker build pass;
- the remaining API tests pass without Bun filesystem modules;
- Playwright smoke still passes against Wrangler on port 3999.

- [ ] **Step 11: Commit the deletion**

```bash
git add -A apps/api bun.lock
git commit -m "refactor(api): remove duplicate Bun HTTP runtime"
```

---

### Task 3: Align Local Tooling and Active Documentation

**Files:**

- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `CLAUDE.md`
- Replace content: `apps/api/README.md`
- Replace content: `README.md`
- Do not edit: `AGENTS.md`
- Reference only: `docs/OPERATOR_RUNBOOK.md`

**Interfaces:**

- Normal local API URL: `http://127.0.0.1:4690`.
- E2E-only API URL: `http://localhost:3999`.
- Production operator procedures remain owned by `docs/OPERATOR_RUNBOOK.md`.

- [ ] **Step 1: Update the single-upload CLI default**

In `scripts/admin-upload-puzzle.ts`, change:

```ts
const LOCAL_SERVER = 'http://127.0.0.1:3000';
```

to:

```ts
const LOCAL_SERVER = 'http://127.0.0.1:4690';
```

Update the usage line to exactly:

```text
--server <url>              API server base URL (default: http://127.0.0.1:4690)
```

Do not change the bulk/startup uploader's production-first `DEFAULT_SERVER` behavior.

- [ ] **Step 2: Rewrite the API section in `CLAUDE.md` around one runtime**

Replace the dual-runtime description/table with this architecture model:

```markdown
### API (`@perseus/api`)

- **Runtime**: Cloudflare Workers via Hono for local development and production.
- **Entry point**: `apps/api/src/worker.ts`.
- **Local development**: `bun run dev --filter=@perseus/api` starts the API and workflows Workers through Wrangler on port 4690; apply local D1 migrations first with `bun run db:migrate:local` from `apps/api`.
- **Storage**: local/production bindings use D1, KV, R2, Durable Objects, and Workflows through Wrangler configuration.
- **Routes**: Worker route modules use the existing `.worker.ts` suffix; the suffix remains for now even though there is no second HTTP runtime.
- **Production assets**: the API Worker also serves the built SvelteKit static assets through the `ASSETS` binding.
```

Also:

- remove the `Bun API` environment-variable subsection;
- keep the Worker bindings/env list;
- remove stale references to `src/lib/services/progress.ts`;
- update testing notes so they describe Worker tests without a Bun-vs-Worker convention;
- state that gameplay E2E starts the API Worker on port 3999 through `dev:e2e`.

Do not duplicate operator procedures already in `docs/OPERATOR_RUNBOOK.md`.

- [ ] **Step 3: Replace `apps/api/README.md` with a short package overview**

Use this content:

```markdown
# Perseus API

Hono API running on Cloudflare Workers for both local development and production.

## Development

From the repository root:

```bash
bun install
cd apps/api && bun run db:migrate:local
cd ../.. && bun run dev --filter=@perseus/api
```

The local API Worker listens on `http://127.0.0.1:4690` and starts with the workflows Worker through Wrangler.

## Commands

- `bun run dev` — local API + workflows Workers through Wrangler.
- `bun run dev:e2e` — E2E-only Worker runtime on port 3999.
- `bun run build` — production Worker dry-run build.
- `bun run check` — TypeScript check.
- `bun run lint` — formatting and lint checks.
- `bun run test` — API tests.

See [`../../CLAUDE.md`](../../CLAUDE.md) for repository development guidance and [`../../docs/OPERATOR_RUNBOOK.md`](../../docs/OPERATOR_RUNBOOK.md) for deployment and operational procedures.
```

Do not document removed Bun server commands or obsolete example endpoints.

- [ ] **Step 4: Replace the root README with product + quick start + pointers**

Use this concise structure:

```markdown
# Perseus

Single-player jigsaw puzzle arcade built with SvelteKit, a Hono API on Cloudflare Workers, and Cloudflare Workflows for puzzle generation.

## Development

```bash
bun install
cd apps/api && bun run db:migrate:local
cd ../.. && bun run dev
```

Default local services:

- API Worker: `http://127.0.0.1:4690`
- Web app: `http://127.0.0.1:4692`

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — contributor guide, architecture, commands, and testing.
- [`docs/OPERATOR_RUNBOOK.md`](docs/OPERATOR_RUNBOOK.md) — deployment, D1 operations, admin/seeding procedures, recovery, and production operations.
- [`apps/web/e2e/README.md`](apps/web/e2e/README.md) — deterministic gameplay E2E harness.
```

Do not preserve the current long admin/deployment/security procedures in the root README; the runbook is canonical for those topics.

- [ ] **Step 5: Search active docs/tooling for stale Bun runtime assumptions**

```bash
rg -n \
  "dual runtime|Dual Runtime|Bun API|dev:bun|build:bun|start:bun|src/index\.ts|filesystem \+ JSON|localhost:3000|127\.0\.0\.1:3000|src/lib/services/progress\.ts" \
  README.md CLAUDE.md apps/api/README.md scripts \
  --glob '!docs/superpowers/**'
```

Expected: no stale Bun HTTP runtime/port/file references remain. Historical planning docs are intentionally excluded.

- [ ] **Step 6: Validate script and documentation changes**

```bash
bun run check:scripts
bun run test:scripts
bunx prettier --check \
  scripts/admin-upload-puzzle.ts \
  CLAUDE.md \
  apps/api/README.md \
  README.md

git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 7: Commit tooling/docs cleanup**

```bash
git add \
  scripts/admin-upload-puzzle.ts \
  CLAUDE.md \
  apps/api/README.md \
  README.md

git commit -m "docs: make Worker runtime canonical"
```

---

### Task 4: Verify the Worker-Only API End to End

**Files:** No committed files unless verification exposes a defect in Tasks 1–3.

- [ ] **Step 1: Verify the final diff is deletion-first and scoped**

```bash
git status --short
git diff --check main...HEAD
git diff --stat main...HEAD
```

Expected:

- the largest source-code change is deletion of the Bun HTTP stack/tests;
- no mass `.worker.ts` renames;
- no Cloudflare infrastructure redesign;
- no HPA-556/HPA-558 implementation changes.

- [ ] **Step 2: Apply local D1 migrations and start the normal Worker runtime**

From one terminal:

```bash
bun run --cwd apps/api db:migrate:local
bun run dev --filter=@perseus/api
```

Expected: Wrangler exposes the API Worker on port 4690 and starts the workflows Worker through the second config.

- [ ] **Step 3: Probe Worker health and one D1-backed route**

From another terminal:

```bash
curl --fail http://127.0.0.1:4690/health
curl -i http://127.0.0.1:4690/api/player/session
```

Expected:

- `/health` returns `200` with `{"status":"ok"}`;
- `/api/player/session` reaches the Worker/D1-backed player route without a missing-table/server-startup failure. Its exact auth/session response may be unauthenticated and is not changed by HPA-555.

Stop the dev server after the probe.

- [ ] **Step 4: Run all static/API gates**

```bash
bun run build --filter=@perseus/api
bun run check --filter=@perseus/api
bun run lint --filter=@perseus/api
bun run --cwd apps/api test
```

Expected: all commands exit zero.

- [ ] **Step 5: Run the required gameplay smoke gate**

```bash
bun run --cwd apps/web test:e2e:smoke
```

Expected: Chromium desktop/mobile smoke passes with the Worker-backed API on port 3999.

- [ ] **Step 6: Verify local admin tooling points to the Worker port**

```bash
bun run admin:upload -- --help 2>&1 | rg "default: http://127.0.0.1:4690"
```

Expected: command exits zero after finding the new default in help output.

- [ ] **Step 7: Run the final dead-runtime sweep**

```bash
! rg -n \
  "dev:bun|build:bun|start:bun|src/index\.ts|dual runtime|Dual Runtime|Bun API|localhost:3000|127\.0\.0\.1:3000" \
  README.md CLAUDE.md apps/api apps/web/playwright.config.ts scripts \
  --glob '!docs/superpowers/**'

! rg -n \
  "from ['\"](\.\.?/)+(services/(storage|player-auth|puzzle-generator)|middleware/(auth|player-auth|rate-limit)|routes/(admin|auth|player|puzzles)(\.complete)?|db|utils/jigsawPath)" \
  apps/api/src
```

Expected: zero active references to the deleted Bun HTTP runtime. Explicit `.worker`, `.shared`, and `@perseus/shared/bun` references are not matched by this sweep.

- [ ] **Step 8: Confirm the shared Bun driver remains intentionally independent**

```bash
rg -n "@perseus/shared/bun|createBunDbContext" packages apps scripts --glob '!docs/superpowers/**'
```

Expected: shared-package tests/driver references may remain. Do not delete them as part of HPA-555 unless there are literally no surviving non-historical references.

- [ ] **Step 9: Final acceptance review**

Confirm evidence exists for every HPA-555 acceptance condition:

- one HTTP implementation per endpoint;
- normal API dev/build/check/lint work with Workers;
- API Worker health and a D1-backed path run locally;
- gameplay E2E smoke uses the Worker backend;
- Bun HTTP scripts and filesystem-server code/tests are gone;
- local single-upload tooling targets port 4690;
- `CLAUDE.md` is canonical and `AGENTS.md` needs no separate copy maintenance;
- root/API READMEs describe the Worker-only architecture and point operations to the runbook;
- no compatibility wrapper, generic runtime abstraction, endpoint redesign, or data migration was introduced.

Do not mark HPA-555 complete if any row lacks direct evidence.
