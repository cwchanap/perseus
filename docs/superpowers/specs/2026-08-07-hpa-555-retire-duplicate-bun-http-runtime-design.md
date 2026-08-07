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
2. `wrangler dev` runs the API Worker together with the workflows Worker configuration.
3. The API uses local Wrangler D1, KV, R2, Durable Object, and Workflow bindings.

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
- Bun-only middleware such as unsuffixed admin/player auth middleware
- `services/storage.ts`
- Bun-specific player-auth storage/service implementation
- `apps/api/src/db.ts`
- Bun/filesystem route tests and runtime-parity tests
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
- cross-runtime parity/drift tests
- duplicate tests that only prove both route implementations behave the same

Preserve real behavioral coverage on the Worker implementation.

When a Bun test contains an important API behavior not covered by the Worker suite, move only that assertion/scenario into the appropriate Worker test file. Do not mechanically port every deleted Bun test.

Keep genuinely shared domain/database tests.

Do not rename the surviving `.worker.test.ts` suite wholesale in this ticket.

## Playwright E2E Backend

Replace the Bun API `webServer` entry in `apps/web/playwright.config.ts` with the Worker runtime.

The E2E API process must:

- apply local D1 migrations before startup
- start Wrangler with the API and workflows development configuration
- use local D1, KV, R2, Durable Object, and Workflow bindings
- listen on port 3999
- expose the required E2E secrets/origin variables to the Worker
- preserve `PUBLIC_API_BASE=http://localhost:3999`

Prefer one small `dev:e2e` script in `apps/api/package.json` if it keeps `playwright.config.ts` readable. This is command reuse, not a new architecture layer.

The E2E flow must work from a clean checkout/build state. The API Worker has an `ASSETS` binding that points at the web build, while Playwright currently starts multiple `webServer` processes. Verify that this does not introduce a startup race. If it does, use the smallest fix, such as prebuilding once or overriding the assets directory for the API-only E2E Worker. Do not add a second permanent Wrangler configuration solely for E2E unless the existing config cannot support the test harness cleanly.

## Package and Script Cleanup

In `apps/api/package.json`:

- remove `dev:bun`
- remove `build:bun`
- remove `start:bun`
- keep normal `dev`, `build`, `deploy`, migration, test, check, and lint commands
- remove `@types/bun` from the API package only if no surviving API source/test requires it

Do not remove Bun from the workspace.

## Documentation

Make one short contributor guide canonical.

- Keep `CLAUDE.md` as the canonical contributor guide.
- Replace `AGENTS.md` with a short pointer to `CLAUDE.md` instead of maintaining a copy.
- Remove dual-runtime descriptions, Bun HTTP environment variables, obsolete file references, and stale references such as the removed `progress.ts` service from current contributor documentation.
- Delete or reduce `apps/api/README.md` to a short Worker-oriented package overview if it no longer adds useful information.
- Keep the root `README.md` focused on product purpose and quick-start development.
- Link deployment, admin, D1 recovery, seeding, security, and other operational procedures to `docs/OPERATOR_RUNBOOK.md` instead of duplicating them.

Historical design/plan documents do not need to be rewritten merely because they describe the architecture that existed when they were authored.

## Data and Compatibility

Local filesystem API data may be discarded.

Do not create a data migration, compatibility adapter, fallback reader, or optional Bun mode. Local Worker development should use Wrangler-managed local bindings going forward.

Endpoint contracts, authentication behavior, and Cloudflare infrastructure are otherwise unchanged by this ticket.

## Implementation Order

1. Run a repository-wide reference sweep for the Bun entry point, unsuffixed route/service/middleware siblings, Bun DB adapter, filesystem storage, Bun scripts, and parity tests.
2. Remove the Bun entry point and Bun-only HTTP implementation, fixing small Worker type dependencies exposed by deletion.
3. Delete Bun-only/parity tests and move only missing high-value behavioral assertions into Worker tests.
4. Replace the Playwright E2E backend with the Wrangler Worker runtime on port 3999 and make local migration/bootstrap deterministic.
5. Remove obsolete Bun server scripts and API-only dependencies after references are gone.
6. Update contributor/API/root documentation to describe the single Worker runtime and link operational detail to the existing runbook.
7. Run the focused verification and a final dead-reference sweep.

## Verification

Required checks:

- `bun run dev --filter=@perseus/api` starts the Worker development runtime successfully after local D1 migrations.
- Worker `/health` responds successfully.
- At least one D1-backed API path is exercised locally to confirm bindings/migrations are usable.
- `bun run build --filter=@perseus/api` passes.
- `bun run check --filter=@perseus/api` passes.
- `bun run lint --filter=@perseus/api` passes.
- focused Worker API tests pass.
- `bun run --cwd apps/web test:e2e:smoke` passes against the Worker-backed API server on port 3999.
- no `dev:bun`, `build:bun`, or `start:bun` scripts remain.
- no production/test imports reference deleted Bun HTTP modules.
- no cross-runtime parity test remains.
- current contributor documentation no longer describes a dual HTTP runtime.

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
