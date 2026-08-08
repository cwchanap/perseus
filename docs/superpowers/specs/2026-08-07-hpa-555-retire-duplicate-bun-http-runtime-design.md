# HPA-555 — Retire the Duplicate Bun HTTP API Runtime

## Goal

Use Cloudflare Workers as the only Perseus HTTP API runtime for local development, end-to-end tests, and production. Keep Bun as the package manager and test runner, but stop maintaining a second Bun server implementation.

This is a deletion-first architecture cleanup. API behavior should remain unchanged except that the Bun HTTP runtime, its filesystem-backed implementation, and runtime-parity maintenance are removed.

## Context

The API currently has two parallel HTTP stacks:

- `apps/api/src/index.ts` mounts Bun-specific routes and services.
- `apps/api/src/worker.ts` mounts Worker-specific routes and is the production runtime.
- `apps/api/package.json` already uses `wrangler dev` for normal API development and Wrangler for the production build while still exposing `dev:bun`, `build:bun`, and `start:bun`.
- `apps/web/playwright.config.ts` is the important remaining consumer of the Bun HTTP server: it builds and starts the Bun API on port 3999 for gameplay E2E.
- `scripts/admin-upload-puzzle.ts` still defaults local uploads to port 3000 even though the canonical Wrangler development server is port 4690.
- `apps/api/.env.example` still documents Bun-only `PORT` and `DATA_DIR` settings.
- The root `README.md` currently contains substantial Admin CLI operating procedures that are not yet present in `docs/OPERATOR_RUNBOOK.md`.

The Worker implementation is the canonical runtime. It already owns Cloudflare bindings, scheduled cleanup, production routing, and the richer route/service implementations. Maintaining parity with the Bun filesystem implementation adds duplicate code, duplicate tests, and duplicate documentation without current product value.

HPA-225 is complete, so this ticket is now unblocked. HPA-555 should land before HPA-556 and HPA-558 so those tickets only need to work with the surviving runtime and final E2E topology.

## Chosen Approach

Delete the Bun HTTP runtime and keep the surviving `*.worker.ts` file names for now.

Do not rename all surviving Worker files as part of this ticket. Removing the duplicate runtime provides the architectural benefit; a mass rename would create a large mechanical diff immediately before HPA-556 and HPA-557 modify the same route area.

Do not introduce a runtime-neutral route factory, dependency-injection container, repository framework, compatibility wrapper, or replacement server abstraction.

## Runtime Architecture After This Change

`apps/api/src/worker.ts` remains the sole HTTP entry point.

Local development:

1. Local D1 migrations are applied with the existing Wrangler migration command.
2. `wrangler dev` runs the API Worker together with the workflows Worker configuration on port 4690 for normal development.
3. The API uses local Wrangler D1, KV, R2, Durable Object, and Workflow bindings.
4. Local developer tooling that targets the API by default uses the same port 4690 instead of the deleted Bun server's port 3000.

Production:

1. The same Worker entry point is built and deployed.
2. Production bindings continue to come from the existing Wrangler/Pulumi configuration.

Bun remains in the repository for package management, scripts, tests, and any shared non-HTTP utility that still has an actual consumer.

## Deletion Boundary

Delete the Bun HTTP entry point and Bun-only implementation files once the reference sweep confirms they are not used outside that runtime.

Expected Bun-only deletion set:

- `apps/api/src/index.ts`
- unsuffixed Bun route siblings such as `routes/puzzles.ts`, `routes/admin.ts`, `routes/auth.ts`, and `routes/player.ts`
- Bun-only completion route sibling `routes/puzzles.complete.ts`
- Bun-only middleware such as unsuffixed admin auth, player auth, and rate-limit middleware
- `services/storage.ts`
- Bun-specific player-auth storage/service implementation
- Bun-only puzzle generation helpers under `apps/api` when their only consumers are the deleted filesystem routes/tests
- `apps/api/src/db.ts`
- all Bun/filesystem tests whose import graph reaches the deleted modules, including direct sibling imports such as `./storage` and `./rate-limit`
- cross-runtime parity/drift tests
- any local API types/helpers used only by those files

Before deleting any less-obvious helper, verify imports. In particular, keep shared domain, image, database, CLI, or test utilities if they still have consumers outside the deleted HTTP stack.

The `@perseus/shared/bun` database driver is not automatically in scope. It belongs to the shared package, has independent tests, and should only be removed if a final repository-wide reference sweep shows it has no surviving purpose.

## Worker Dependency Cleanup

The surviving Worker code should not depend on a deleted Bun module.

One known example is `apps/api/src/db.worker.ts`, which imports the `ApiDbContext` type from `apps/api/src/db.ts`. Move that small type definition into `db.worker.ts` or otherwise colocate it with the surviving Worker code. Do not create a new cross-runtime abstraction solely to preserve the old structure.

Use the same rule for any other Worker-to-Bun type-only dependency discovered during deletion.

## Testing Strategy

Delete tests whose purpose disappears with the Bun runtime:

- Bun filesystem/server implementation tests
- tests that directly import or mock deleted Bun-only routes, middleware, database, auth, storage, or generator modules
- cross-runtime parity/drift tests
- duplicate tests that only prove both route implementations behave the same

Preserve the existing Worker test suites as the API behavioral coverage. Do not mechanically port Bun-only tests merely to preserve test count; the production Worker behavior is already canonical.

Keep genuinely shared domain/database tests, including shared-package Bun driver tests that are independent of the HTTP runtime.

Do not rename the surviving `.worker.test.ts` suite wholesale in this ticket.

## Playwright E2E Backend

Replace the Bun API `webServer` entry in `apps/web/playwright.config.ts` with the Worker runtime before deleting the Bun server.

The E2E API process must:

- apply local D1 migrations before startup
- start Wrangler with the API and workflows development configuration
- use local D1, KV, R2, Durable Object, and Workflow bindings
- listen on port 3999
- inject deterministic test values for the required Worker variables
- preserve `PUBLIC_API_BASE=http://localhost:3999`
- use an explicit longer Playwright web-server startup timeout so a cold Wrangler/migration boot is not constrained by Playwright's default startup timeout

Add one small `dev:e2e` script in `apps/api/package.json` for this bootstrap command and have Playwright invoke it. This keeps the test configuration readable without introducing a new architecture layer.

The API Worker has an `ASSETS` binding that normally points at the web build, while Playwright launches its API and frontend web servers concurrently. Avoid making API startup depend on the frontend build winning that race. For E2E only, create an empty directory under the already-generated API `dist/` area and use Wrangler's `--assets` override so the `ASSETS` binding exists without requiring the frontend build. The frontend continues to be served by Playwright's Vite preview server.

The smoke suite is the integration proof that the Worker-backed test server boots and the existing gameplay harness still works. Worker-focused API tests remain responsible for endpoint behavior; do not expand HPA-555 into a new E2E parity suite.

Do not add a second permanent Wrangler configuration solely for E2E.

## Package, Tooling, and Environment Cleanup

In `apps/api/package.json`:

- remove `dev:bun`
- remove `build:bun`
- remove `start:bun`
- add `dev:e2e` for the local migration + Worker E2E bootstrap
- keep normal `dev`, `build`, `deploy`, migration, test, check, and lint commands

Treat the API package's Bun type dependency atomically with TypeScript configuration. After deleting the Bun HTTP source/tests, verify the surviving `apps/api/src` tree has no `bun:*` imports or `Bun.*` usage. If it is clean, remove both `@types/bun` from `apps/api/package.json` and `"bun"` from `apps/api/tsconfig.json` `compilerOptions.types`. Do not remove one while silently relying on workspace hoisting for the other.

Do not remove Bun from the workspace.

Update `scripts/admin-upload-puzzle.ts` so its local default and help text use `http://127.0.0.1:4690`. Do not change the production-first startup/bulk uploader defaults.

Update `apps/api/.env.example` to remove the Bun-only `PORT` and `DATA_DIR` entries. Keep the Worker secrets/OAuth examples, including the local callback URL on port 4690. Wrangler configuration, not a Bun `PORT` variable, owns the normal local server port.

## Documentation

Make one contributor guide canonical without losing existing operator procedures or inventing another documentation layer.

- Keep `CLAUDE.md` as the canonical contributor guide.
- Do not edit `AGENTS.md` separately; it is already a symlink to `CLAUDE.md`.
- Remove dual-runtime descriptions, Bun HTTP environment variables, obsolete file references, and stale references such as the removed `progress.ts` service from current contributor documentation.
- Replace `apps/api/README.md` with a short Worker-oriented package overview that points contributors to `CLAUDE.md` for detailed repository guidance.
- Before slimming the root `README.md`, move its Admin CLI operating guidance into `docs/OPERATOR_RUNBOOK.md`. Preserve the useful credentials, single-upload, bulk-upload, token-rotation, idempotency, and notes content; update local API URLs from port 3000 to 4690. Where the runbook already has an authoritative seed-workflow or Cloudflare Access section, link to that existing section rather than duplicating it.
- Keep the root `README.md` focused on product purpose, quick-start development, and links to the contributor guide and operator runbook.

Historical design/plan documents do not need to be rewritten merely because they describe the architecture that existed when they were authored.

## Data and Compatibility

Local filesystem API data may be discarded.

Do not create a data migration, compatibility adapter, fallback reader, or optional Bun mode. Local Worker development should use Wrangler-managed local bindings going forward.

Endpoint contracts, authentication behavior, and Cloudflare infrastructure are otherwise unchanged by this ticket.

## Implementation Order

1. Run a repository-wide reference sweep and baseline the Worker tests/E2E dependencies.
2. Replace the Playwright Bun backend with the Wrangler Worker runtime on port 3999, make local migration/bootstrap deterministic, and prove the existing smoke suite passes.
3. Remove the Bun entry point and Bun-only HTTP implementation, fixing small Worker type dependencies exposed by deletion.
4. Delete the complete Bun-only/parity test set, remove stale Vitest configuration, remove obsolete Bun server scripts, and clean API Bun types only if source usage is gone.
5. Point local single-upload tooling at Worker port 4690 and remove Bun-only environment examples.
6. Move the existing Admin CLI operating guidance into the operator runbook, then simplify the root/API/contributor documentation around the single Worker runtime.
7. Run the focused Worker verification and final dead-reference sweep.

## Verification

Required checks:

- `bun run dev --filter=@perseus/api` starts the Worker development runtime successfully after local D1 migrations.
- Worker `/health` responds successfully on port 4690.
- local D1 migrations apply (or report already applied), and a local D1 schema query succeeds against `perseus-player-data`; Worker API tests remain the endpoint-behavior check.
- the local single-upload CLI defaults to port 4690
- `apps/api/.env.example` contains no Bun-only `PORT` or `DATA_DIR`
- `bun run build --filter=@perseus/api` passes.
- `bun run check --filter=@perseus/api` passes.
- `bun run lint --filter=@perseus/api` passes.
- the full surviving API Vitest suite passes.
- `bun run --cwd apps/web test:e2e:smoke` passes against the Worker-backed API server on port 3999.
- no `dev:bun`, `build:bun`, or `start:bun` scripts remain.
- no production/test imports reference deleted Bun HTTP modules, including direct sibling imports such as `./storage`, `./rate-limit`, `./auth`, or `./player-auth`.
- API TypeScript config and package dependencies do not retain a one-sided Bun type dependency.
- no cross-runtime parity test remains.
- current contributor documentation no longer describes a dual HTTP runtime.
- Admin CLI operating procedures remain available in `docs/OPERATOR_RUNBOOK.md` after the root README is shortened.

## Non-Goals

- renaming every surviving `.worker.ts` file
- redesigning endpoints or authentication
- redesigning Cloudflare infrastructure
- changing persistence/completion compatibility behavior covered by HPA-556
- simplifying the broader CI gate covered by HPA-558
- replacing the deleted runtime with a generic runtime abstraction
- preserving local filesystem API data
- creating a new documentation generator or hierarchy

## Success Criteria

After HPA-555, Perseus has one HTTP implementation for each endpoint and one runtime model to understand during development, E2E, and production. A normal API change should no longer require editing parallel Bun and Worker route/service implementations or maintaining tests whose only purpose is cross-runtime parity.
