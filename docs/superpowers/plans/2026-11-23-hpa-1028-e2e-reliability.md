# HPA-1028 — Implementation plan

**Goal:** Prevent wrong-service E2E runs and eliminate the install/pause race.  
**Design:** [HPA-1028 design](../specs/2026-11-23-hpa-1028-e2e-reliability-design.md), revised after [review](https://github.com/cwchanap/perseus/pull/188#pullrequestreview-6032808311).  
**Delivery:** One PR; planning only so far, no implementation or execution evidence yet.

## 1. Establish the actual dependency baseline

- [ ] From the repository root, run `bun install --frozen-lockfile`. Record branch SHA and installed Playwright version (the lockfile pins 1.65.1; the reviewer observed stale 1.64.1 node_modules). Install Chromium with the existing `bun run --cwd apps/web test:install-browsers:chromium`.
- [ ] Keep historical wrong-service and clock evidence in HPA-1028; no need to repeat the ten wrong-app runs. Reproduce the clock failure as part of step 3, against the locked version, not stale node_modules.

## 2. Exclusive server ownership and fixed API origin

**Files:** `apps/web/playwright.config.ts`, `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`.

- [ ] Set both reuseExistingServer values to false. Keep API HTTP readiness URL `http://localhost:3999/api` and 180 s timeout, preview TCP port 4173 and --strictPort, build:e2e, baseURL, migrations, auth/CORS, projects and existing CI. Optional descriptive server names only. Do not add global setup, identity probes, TCP preflight, collision harness, dynamic ports or process killing.
- [ ] Set preview webServer.env.PUBLIC_API_BASE and harness-services API_ORIGIN to the literal `http://localhost:3999` (one small shared constant is optional, not required); remove inherited env reads in both. Explicit value overrides the shell for the build. Leave ordinary dev and production configuration unchanged.
- [ ] Verify one-time negative cases via the agent's execution tooling, outside normal browser suite. On otherwise free ports, start an agent-owned temporary loopback HTTP listener on 4173, run actual Playwright with a focused existing spec, capture its nonzero occupied-port result and show listener still responds. Separately repeat with a listener on 3999 returning stable 404 at /api, bound to the intended interface(s); expect Wrangler/Miniflare address-in-use or existing fail-closed startup timeout. If the latter is slow, record it rather than introducing speculative machinery. Confirm no test bodies execute and owned processes are cleaned up. A /api 200 check is optional; never kill another workspace's process. Remove only the temporary listener the agent started. Do not add a permanent subprocess test suite. If a true false pass is observed, address the demonstrated gap before claiming acceptance.
- [ ] With free ports, run existing E2E with `PUBLIC_API_BASE=http://localhost:4690` in the shell. Use MCP browser network evidence for an unmocked Gallery API request and run harness-services spec under that env; confirm both use the actual local E2E API on 3999, not 4690. Do not contact production. This proves the wrong-target regression without a new config framework.

## 3. Deterministic clock initialization

**Files:** `apps/web/e2e/support/paused-clock.ts` (small new helper), `apps/web/e2e/support/gameplay-page.ts`, `apps/web/e2e/playwright-clock-contract.spec.ts`. Correct misleading zero-baseline comments wherever present, including the session-controls spec if needed.

- [ ] Extract the old two-call sequence into initializePausedClock typed against `Pick<Page['clock'], 'install' | 'pauseAt'>`; call it at existing stage 4 after reduced-motion emulation. Add exactly one @smoke contract test alongside the existing relative performance.now delta test. Its adapter delegates to real page.clock and injects a 150 ms Node-side delay after install; call helper, navigate to '/', assert Date.now() equals startAt. Run before fix and capture failure (if the locked version already behaves differently, accurately record it).
- [ ] Fix helper: named `PAUSE_LEAD_MS = 3_600_000`; install at startAt minus virtual lead; pause at startAt. Execute before navigation on a blank page; no real sleeps in helper, retries, wider timeouts, setFixedTime or product timer changes. Keep atomic init ordering and public clock option unchanged.
- [ ] Re-run the delayed test, existing delta test and existing session-controls cases (3 s active + 5 s paused + 2 s resumed = 5 s, relaxed clockless). The delayed test directly exercises the race; no mandatory repeat-each stress, reload/interval/real-clock test expansion or separate fixture flow. Keep existing assertions and reduced-motion behavior. Audit comments/consumers for any absolute performance.now assumption; correct wording to monotonic deltas, not guaranteed numeric zero.

## 4. Documentation

- [ ] Concise `apps/web/e2e/README.md` edits: ports must be free; stop the owning process in its own workspace; E2E build uses 3999 regardless of shell env; correct stage-4 clock ordering and clock/rAF baseline wording. No AGENTS.md edits or new operator framework.
- [ ] Self-review for harness-only diff and single PR. No production UI/API, native, engine, dependency, CI architecture or art changes.

## 5. Acceptance — existing suites plus lightweight agent verification

- [ ] Record actual locked Playwright version and branch SHA. Agent-executed one-time port conflict checks from step 2 fail nonzero with meaningful port diagnostics, no test bodies, sentinel alive, owned children cleaned up. Free-port run succeeds; actual API origin is 3999 even with inherited 4690. CI remains fail-closed with same config.
- [ ] New delayed-adapter test passes, old-sequence result recorded; existing delta and timed/relaxed session controls pass. No weakened expectations or retries.
- [ ] MCP-driven desktop Chromium E2E: reuse existing Gallery and fixture/session-controls flows to confirm real Perseus app, progress, pause/resume and completion; capture current board/completion screenshot(s) for a quick visual sanity check (no UI mockup, baseline capture, pixel comparison or separate visual suite). One desktop platform, no human sign-off or native acceptance. Existing automated smoke lane remains intact.
- [ ] Run from root:
  - `bun run --cwd apps/web check`
  - `bun run --cwd apps/web lint`
  - `bun run --cwd apps/web test:e2e -- playwright-clock-contract.spec.ts gameplay-session-controls.spec.ts --retries=0`
  - `PUBLIC_API_BASE=http://localhost:4690 bun run --cwd apps/web test:e2e -- harness-services.spec.ts --retries=0`
  - `bun run --cwd apps/web test:e2e -- --retries=0`
  - `bun run --cwd apps/web test:e2e:assert-production-bundle`
  - `bun run --cwd apps/web test:e2e:smoke -- --retries=0`
- [ ] Paste actual outcomes, collision diagnostics and concise MCP evidence into PR. Required Build & Lint, Unit Tests and Chromium smoke gates green when implementation leaves draft; skipped draft/docs-only CI is not a pass. HPA-825 residual production QA remains independent. Mark HPA-1028 Done only after acceptance.

If a distinct product bug is reproduced, record separately rather than expanding this PR. No new ticket or PR for the consolidated clock and reuse fixes.
