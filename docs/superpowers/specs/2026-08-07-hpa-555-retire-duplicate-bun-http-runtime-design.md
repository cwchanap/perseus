# HPA-555 — Retire the Duplicate Bun HTTP API Runtime

## Goal

Use Cloudflare Workers as the only Perseus HTTP API runtime for local development, end-to-end tests, and production. Keep Bun as the package manager, script runtime, and test runner, but stop maintaining a second Bun HTTP server implementation.

This is a deletion-first architecture cleanup. API behavior should remain unchanged except that the Bun HTTP runtime, its filesystem-backed implementation, and runtime-parity maintenance are removed.

## Context

The API currently has two parallel HTTP stacks:

- `apps/api/src/index.ts` mounts Bun-specific routes and filesystem-backed services.
- `apps/api/src/worker.ts` mounts Worker-specific routes and is the production runtime.
- `apps/api/package.json` already uses multi-worker `wrangler dev` for normal API development while retaining `dev:bun`, `build:bun`, `start:bun`, and a generic `start` script.
- `apps/web/playwright.config.ts` still builds and starts the Bun API on port 3999 for gameplay E2E.
- `scripts/admin-upload-puzzle.ts` still defaults local uploads to port 3000 even though the canonical Wrangler development server is port 4690.
- `apps/api/.env.example` still documents Bun-only `PORT` and `DATA_DIR` settings.
- The root `README.md` contains substantial Admin CLI operating procedures that are not yet present in `docs/OPERATOR_RUNBOOK.md`.

The Worker implementation is the canonical runtime. It already owns Cloudflare bindings, scheduled cleanup, production routing, and the richer route/service implementations. Maintaining parity with the Bun filesystem implementation adds duplicate code, tests, and documentation without current product value.

### Pre-existing Worker development blocker

The current multi-worker Wrangler development path cannot start cleanly because `apps/workflows/src/index.ts` exports a runtime constant from a Worker entrypoint:

```ts
export const CURRENT_RESERVATION_SCHEMA = 1;
```

`CURRENT_RESERVATION_SCHEMA` is only used inside that file. Remove only the `export` modifier before changing E2E. Type-only exports such as `export interface Env` erase at build and remain valid.

This small prerequisite fix belongs in HPA-555 because the ticket standardizes development and E2E on the Worker runtime; deleting the fallback Bun server before proving the canonical runtime boots would make the migration unsafe.

HPA-225 is complete, so HPA-555 is otherwise unblocked. HPA-555 should land before HPA-556 and HPA-558 so those tickets only need to work with the surviving runtime and final E2E topology.

## Chosen Approach

Delete the Bun HTTP runtime and keep the surviving `*.worker.ts` file names for now.

Do not rename all surviving Worker files as part of this ticket. Removing the duplicate runtime provides the architectural benefit; a mass rename would create mechanical churn immediately before HPA-556 and HPA-557 modify the same route area.

Do not introduce a runtime-neutral route factory, dependency-injection container, repository framework, compatibility wrapper, second Wrangler configuration, or replacement server abstraction.

## Runtime Architecture After This Change

`apps/api/src/worker.ts` remains the sole HTTP entry point.

Local development:

1. `apps/workflows/src/index.ts` exports only valid Worker runtime entrypoints; `CURRENT_RESERVATION_SCHEMA` remains file-local.
2. Local D1 migrations are applied with the existing Wrangler migration command.
3. `wrangler dev` runs the API Worker together with the workflows Worker configuration on port 4690.
4. The API uses local Wrangler D1, KV, R2, Durable Object, and Workflow bindings.
5. Local developer tooling that targets the API defaults to port 4690 instead of the deleted Bun server's port 3000.

E2E:

1. Playwright starts the same Worker implementation on deterministic port 3999.
2. The E2E bootstrap applies local D1 migrations first.
3. The API Worker uses the existing API + workflows configs and deterministic test variables.
4. A tiny generated assets directory supplies `env.ASSETS` so API startup does not race the concurrently built frontend.
5. Playwright uses Worker-only `GET /api` as its readiness/provenance URL; a leftover Bun server cannot satisfy that check.

Production:

1. The same Worker entry point is built and deployed.
2. Production bindings continue to come from the existing Wrangler/Pulumi configuration.

Bun remains in the repository for package management, scripts, tests, and shared non-HTTP utilities with real consumers.

## Deletion Boundary

Delete the Bun HTTP entry point and Bun-only implementation files after the Worker dev/E2E paths are proven.

Expected Bun-only deletion set includes:

- `apps/api/src/index.ts`
- `apps/api/src/db.ts`
- unsuffixed Bun route siblings: `routes/puzzles.ts`, `routes/admin.ts`, `routes/auth.ts`, `routes/player.ts`, `routes/puzzles.complete.ts`
- Bun-only middleware: unsuffixed admin auth, player auth, and rate-limit middleware
- `services/storage.ts`
- Bun-specific player-auth service/storage
- Bun-only puzzle generation helpers under `apps/api`
- `apps/api/src/utils/jigsawPath.ts` and local API types used only by the deleted path
- all Bun/filesystem tests whose import graph reaches deleted modules
- cross-runtime parity/drift tests

Also delete `apps/api/src/routes/puzzle-ready.ts` and `puzzle-ready.test.ts`. After the Bun routes, Bun completion route, and parity tests are removed, `puzzle-ready.ts` has no Worker/runtime consumer; keeping it would leave dead code whose only consumer is its own test.

Keep shared domain, image, database, CLI, or test utilities that still have independent consumers.

The `@perseus/shared/bun` database driver remains out of scope because shared-package tests still use it independently of the HTTP runtime.

## Worker Dependency Cleanup

The surviving Worker code must not depend on a deleted Bun module.

`apps/api/src/db.worker.ts` currently imports the `ApiDbContext` type from `apps/api/src/db.ts`. Move that small interface into `db.worker.ts` and keep `getWorkerDbContext()` / `getWorkerDb()` behavior unchanged. Do not create `db.shared.ts` or another factory.

The TypeScript compiler is the authoritative dangling-import gate after deletion. Do not treat a hand-written grep as proof of module-graph correctness.

## Testing Strategy

Delete tests whose implementation target disappears:

- Bun filesystem/server implementation tests
- tests that directly import or mock deleted Bun routes, middleware, database, auth, storage, generator, or helper modules
- cross-runtime parity/drift tests
- duplicate tests whose only purpose is Bun/Worker parity
- `puzzle-ready.test.ts` once its implementation is deleted

Preserve existing Worker tests as API behavioral coverage. Do not mechanically port Bun tests merely to preserve test count.

Keep genuinely shared domain/database tests, including shared-package Bun-driver tests independent of the HTTP server.

Final API test verification should use the same package command CI runs (`test:unit`, including coverage), not only bare `vitest run`.

## Playwright E2E Backend

Replace the Bun API `webServer` entry with the Worker runtime before deleting Bun.

The E2E API process must:

- apply local D1 migrations before startup
- start Wrangler with the API and workflows development configuration
- use local D1, KV, R2, Durable Object, and Workflow bindings
- listen on port 3999
- inject deterministic test values for required Worker variables
- preserve `PUBLIC_API_BASE=http://localhost:3999`
- use an explicit 180-second Playwright web-server startup timeout
- use `http://localhost:3999/api` as the readiness URL so the gate proves the Worker implementation, not merely any HTTP server on port 3999

Add one small `dev:e2e` script in `apps/api/package.json`. Do not add `.dev.vars.e2e`, a shell helper, or another Wrangler project.

The API Worker has an `ASSETS` binding that normally points at the web build while Playwright launches API and frontend servers concurrently. For E2E only, create an empty directory under `apps/api/dist/` and use Wrangler's `--assets` override. This supplies the binding without requiring the frontend build to win the startup race.

The existing smoke suite is the integration proof that the Worker-backed test server boots and the gameplay harness still works. Worker-focused API tests remain responsible for endpoint behavior; do not add a new E2E parity suite.

## Package, Tooling, and Environment Cleanup

In `apps/api/package.json`:

- remove `dev:bun`
- remove `build:bun`
- remove `start:bun`
- remove the generic `start: "wrangler dev --local"` near-duplicate; normal local development is the configured `dev` command
- add `dev:e2e` for deterministic local migration + Worker E2E bootstrap
- keep `dev`, `build`, `deploy`, migrations, tests, check, and lint

Treat API Bun types atomically. After deletion, verify the surviving API source/test tree has no `bun:*` imports or `Bun.*` usage. If clean, remove both `@types/bun` from `apps/api/package.json` and `"bun"` from `apps/api/tsconfig.json` `compilerOptions.types`. Do not remove one while relying on workspace hoisting for the other.

Do not remove Bun from the workspace.

Update `scripts/admin-upload-puzzle.ts` so its local default/help text use `http://127.0.0.1:4690`. Leave production/bulk uploader defaults unchanged.

Update `apps/api/.env.example` to remove Bun-only `PORT` and `DATA_DIR`. Keep Worker secrets/OAuth examples, including the callback URL on 4690.

## Documentation

Make one contributor guide canonical without losing operator procedures or inventing another documentation layer.

- Keep `CLAUDE.md` as the canonical contributor guide.
- Do not edit `AGENTS.md` separately; it is already a symlink to `CLAUDE.md`.
- Remove dual-runtime descriptions, Bun HTTP environment variables, obsolete file references, and stale references such as removed `src/lib/services/progress.ts`.
- Replace `apps/api/README.md` with a short Worker-oriented package overview pointing to `CLAUDE.md` and the operator runbook.
- Before slimming root `README.md`, move its useful Admin CLI operating guidance into `docs/OPERATOR_RUNBOOK.md`.
- Preserve credentials, single-upload, bulk-upload, token rotation, idempotency, and operational notes; update local API URLs from port 3000 to 4690.
- Where the runbook already owns seed workflow or Access policy material, link to those sections instead of duplicating them.
- Keep root README focused on product purpose, quick start, and links to contributor/operator docs.

Historical design/plan documents do not need rewriting merely because they describe the architecture that existed when authored.

## Data and Compatibility

Local filesystem API data may be discarded.

Do not create a data migration, compatibility adapter, fallback reader, or optional Bun mode. Local Worker development uses Wrangler-managed local bindings going forward.

Endpoint contracts, authentication behavior, and Cloudflare infrastructure are otherwise unchanged.

## Implementation Order

1. Remove the invalid runtime export from `apps/workflows/src/index.ts` and prove the existing configured Worker dev command serves `/health` on 4690.
2. Baseline current Bun-backed smoke, then replace Playwright's API backend with the Worker runtime and prove Worker provenance via `GET /api` plus smoke.
3. Make `db.worker.ts` self-contained and delete the Bun HTTP source, complete Bun-only/parity test set, and orphaned `puzzle-ready` helper/test.
4. Remove stale Vitest exclusion, Bun HTTP scripts including generic `start`, and API Bun types only if surviving usage is gone.
5. Point local single-upload tooling at Worker port 4690 and remove Bun-only environment examples.
6. Move existing Admin CLI operating guidance into the operator runbook, then simplify root/API/contributor documentation.
7. Run compiler, CI-equivalent API tests, build/lint, local D1/Worker probes, E2E smoke, and final scope checks.

## Verification

Required checks:

- after the one-word workflow entrypoint fix, `bun run dev --filter=@perseus/api` starts successfully and `/health` returns `{"status":"ok"}` on port 4690
- Playwright API readiness uses `GET /api`, which exists only on the Worker entrypoint
- `bun run --cwd apps/web test:e2e:smoke` passes against the Worker-backed API on port 3999
- local D1 migrations apply (or report already applied), and a local D1 schema query succeeds
- `bun run check --filter=@perseus/api` passes after deletion; this is the primary dangling-import gate
- `bun run test:unit --filter=@perseus/api` passes; this exercises the same coverage-enabled API test command used by CI and catches broken runtime test mocks/imports
- `bun run build --filter=@perseus/api` passes
- `bun run lint --filter=@perseus/api` passes
- local single-upload CLI defaults to port 4690
- `apps/api/.env.example` contains no Bun-only `PORT` or `DATA_DIR`
- no `dev:bun`, `build:bun`, `start:bun`, or generic API `start` script remains
- `apps/api/src/routes/puzzle-ready.ts` and its test are gone
- API TypeScript config and package dependencies do not retain a one-sided Bun type dependency
- no cross-runtime parity test remains
- active contributor docs no longer describe a dual HTTP runtime
- Admin CLI procedures remain available in `docs/OPERATOR_RUNBOOK.md` after root README is shortened

A grep may still be used as a convenience inventory, but it is not a correctness gate for deleted imports. Compiler + tests are authoritative.

## Non-Goals

- renaming surviving `.worker.ts` files
- redesigning endpoints or authentication
- redesigning Cloudflare infrastructure
- changing persistence/completion compatibility covered by HPA-556
- simplifying CI topology covered by HPA-558
- replacing the deleted runtime with a generic abstraction
- preserving local filesystem API data
- deleting `@perseus/shared/bun` while shared tests use it
- creating a new documentation generator/hierarchy

## Success Criteria

After HPA-555, Perseus has one HTTP implementation for each endpoint and one runtime model for development, E2E, and production. The canonical Worker runtime boots locally before the fallback is removed, E2E proves it is talking to the Worker entrypoint, and future API changes no longer require parallel Bun/Worker implementation or parity maintenance.