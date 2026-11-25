# HPA-1028 — Implementation plan

**Goal:** Prevent wrong-service E2E runs and eliminate the install/pause race.  
**Design:** [HPA-1028 design](../specs/2026-11-23-hpa-1028-e2e-reliability-design.md), revised after [round 1](https://github.com/cwchanap/perseus/pull/188#pullrequestreview-6032808311) and [round 2](https://github.com/cwchanap/perseus/pull/188#pullrequestreview-6032912579) reviews.  
**Delivery:** One PR; implementation complete through the review-driven API-port preflight. Collision evidence has been gathered locally; PR evidence updates, non-draft CI, and Linear completion remain pending.

## 1. Establish the actual dependency baseline

- [x] From the repository root, run `bun install --frozen-lockfile`. Record branch SHA and installed Playwright version (the lockfile pins 1.65.1; the reviewer observed stale 1.64.1 node_modules). Install Chromium with the existing `bun run --cwd apps/web test:install-browsers:chromium`.
- [x] Keep historical wrong-service and clock evidence in HPA-1028; no need to repeat the ten wrong-app runs. Reproduce the clock failure as part of step 3, against the locked version, not stale node_modules.

## 2. Exclusive server ownership and fixed API origin

**Files:** `apps/web/playwright.config.ts`, `apps/api/package.json`, `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`, `apps/web/e2e/profile.spec.ts`, `scripts/assert-port-free.ts`, `scripts/assert-port-free.test.ts`.

- [x] Set both reuseExistingServer values to false. Use explicit IPv4 loopback endpoints so `localhost` DNS ordering cannot split probes, browser traffic, and server binds across IPv4 and IPv6: API HTTP readiness URL `http://127.0.0.1:3999/api` with a 180 s timeout, Wrangler `--ip 127.0.0.1`, preview `port: 4173` with `--host 127.0.0.1 --strictPort` and its own 180 s startup budget, build:e2e, baseURL `http://127.0.0.1:4173`, migrations, auth/CORS, projects and existing CI. Add only the demonstrated narrow TCP preflight for 127.0.0.1:3999 while loading `playwright.config.ts`, before `webServer` availability checks or process startup and independent of HTTP status. Do not add global setup, identity probes, a collision harness, dynamic ports or process killing.
- [x] Set preview webServer.env.PUBLIC_API_BASE and harness-services API_ORIGIN to the literal `http://127.0.0.1:3999` (one small shared constant is optional, not required); remove inherited env reads in both. Explicit value overrides the shell for the build. Leave ordinary dev and production configuration unchanged.
- [x] Verify one-time negative cases via the agent's execution tooling, outside normal browser suite. On otherwise free ports, start an agent-owned temporary loopback HTTP listener on 4173, run actual Playwright with a focused existing spec, capture its nonzero occupied-port result and show listener still responds. Separately repeat the reproduced foreign-API case with a listener on 127.0.0.1:3999 armed to return 503 to a first `/api` request and then 200 during startup; expect the narrow TCP preflight to produce a nonzero result before either webServer launches or test bodies, with meaningful port output, the foreign listener still answering, and owned processes cleaned up. Never kill another workspace's process. Remove only the temporary listener the agent started. Do not add a permanent subprocess collision suite.
- [x] With free ports, execute `PUBLIC_API_BASE=http://localhost:4690 bun run --cwd apps/web test:e2e -- harness-services.spec.ts --retries=0`. Let Playwright launch and build its own preview; do not launch or rebuild it independently for this check. Immediately after the successful run and before any other build, inspect the generated client JS under `apps/web/build/` (e.g. `_app/immutable`). Require at least one JS file, at least one match for literal `http://127.0.0.1:3999`, and no match for `localhost:4690` in those files; record the positive asset path and negative scan result, distinguishing no match from scan failure. The spec exercises its own fixed API_ORIGIN; the bundle check independently verifies webServer.env in playwright.config.ts. Leave any existing `.env.local` untouched. No production endpoints, separate MCP request proof, or new test framework.

## 3. Deterministic clock initialization

**Files:** `apps/web/e2e/support/paused-clock.ts` (small new helper), `apps/web/e2e/support/gameplay-page.ts`, `apps/web/e2e/playwright-clock-contract.spec.ts`. Comment-only edits also in the determinism comment in `apps/web/e2e/gameplay-infrastructure.spec.ts` and the “Atomic `gotoFixture()` initialization” / “Clock and rAF implications” sections of `apps/web/e2e/README.md`; correct the `GotoFixtureOptions.clock` documentation and stage 4 comments.

- [x] Extract the old two-call sequence into initializePausedClock typed against `Pick<Page['clock'], 'install' | 'pauseAt'>`; call it at existing stage 4 after reduced-motion emulation. Add exactly one @smoke contract test alongside the existing relative performance.now delta test. Its adapter delegates to real page.clock and injects a 150 ms Node-side delay after install; call helper, navigate to '/', assert Date.now() equals startAt. Run before fix and capture failure (if the locked version already behaves differently, accurately record it).
- [x] Fix helper: named `PAUSE_LEAD_MS = 3_600_000`; install at startAt minus the virtual lead, then pause at startAt. Execute before navigation on a blank page; no real sleeps in helper, retries, wider timeouts, setFixedTime/setSystemTime or product timer changes. Keep atomic init ordering and public clock option unchanged. Document that performance.now() remains a monotonic baseline whose numeric value tests must not assume.
- [x] Re-run the delayed test, existing delta test and existing session-controls cases (3 s active + 5 s paused + 2 s resumed = 5 s, relaxed clockless). The delayed test directly exercises the race; no mandatory repeat-each stress, reload/interval/real-clock test expansion or separate fixture flow. Keep existing assertions and reduced-motion behavior. Correct the explicit numeric-zero claims in gameplay-page.ts, gameplay-infrastructure.spec.ts and README; use a frozen monotonic baseline, not guaranteed numeric zero. The session-controls header already describes a frozen baseline and its timer starts at elapsed zero; preserve that test.

## 4. Documentation

- [x] Concise `apps/web/e2e/README.md` edits: ports must be free; stop the owning process in its own workspace; E2E build uses 3999 regardless of shell env; correct stage-4 clock ordering in “Atomic `gotoFixture()` initialization” and clock/rAF baseline wording in “Clock and rAF implications”. No AGENTS.md edits or new operator framework.
- [x] Self-review for harness-only diff and single PR. No production UI/API, native, engine, dependency, CI architecture or art changes.

## 5. Acceptance — existing suites plus lightweight agent verification

- [x] Record actual locked Playwright version and branch SHA. Agent-executed one-time port conflict checks from step 2 fail nonzero with meaningful port diagnostics, no test bodies, sentinel alive, owned children cleaned up. The 503→200 foreign-API case must exercise the final TCP preflight. Free-port run succeeds; the inherited-4690 Playwright run and immediate positive/negative client JS bundle scan in step 2 establish the fixed API origin independently of a separately launched preview.
- [x] New delayed-adapter test passes, old-sequence result recorded; existing delta and timed/relaxed session controls pass. No weakened expectations or retries.
- [x] MCP-driven desktop Chromium E2E: quick Gallery or puzzle smoke load and one current screenshot for visual sanity only (no UI changes or mockup). Reuse an available Perseus instance when safe; do not repeat the full gameplay walkthrough, capture a baseline, or add a visual suite. This check is not evidence for either harness fix: a separate browser does not exercise the Playwright webServer env or clock helper. Actual Playwright tests and the collision/bundle checks provide functional proof. One desktop platform, no human sign-off or native acceptance. Existing smoke lane stays intact.
- [x] Run from root:
  - `bun run --cwd apps/web check`
  - `bun run --cwd apps/web lint`
  - `bun run --cwd apps/web test:e2e -- playwright-clock-contract.spec.ts gameplay-session-controls.spec.ts --retries=0`
  - `PUBLIC_API_BASE=http://localhost:4690 bun run --cwd apps/web test:e2e -- harness-services.spec.ts --retries=0` followed immediately by the client JS bundle scan in step 2 (before the next build)
  - `bun run --cwd apps/web test:e2e -- --retries=0`
  - `bun run --cwd apps/web test:e2e:assert-production-bundle`
  - `bun run --cwd apps/web test:e2e:smoke -- --retries=0`
- [ ] Paste actual outcomes, collision diagnostics including the final 503→200 preflight result, positive/negative bundle scan evidence and one MCP smoke screenshot into PR.
- [ ] Required Build & Lint, Unit Tests and Chromium smoke gates green when implementation leaves draft; skipped draft/docs-only CI is not a pass. HPA-825 residual production QA remains independent. Mark HPA-1028 Done only after acceptance.

If a distinct product bug is reproduced, record separately rather than expanding this PR. No new ticket or PR for the consolidated clock and reuse fixes.
