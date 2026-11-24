# HPA-1028 — Implementation plan

**Goal:** Prevent unrelated services from being used by Playwright and eliminate the fake-clock install/pause race.  
**Design:** [HPA-1028 design](../specs/2026-11-23-hpa-1028-e2e-reliability-design.md).  
**Delivery:** Complete all tasks in this same draft PR. No implementation or tests have been run as part of planning.

## 1. Reproduce and establish baseline

- [ ] Install with the existing Bun lockfile; record git SHA and actual Playwright version (`bun run --cwd apps/web test:e2e -- --list` validates discovery; use `bunx playwright --version` from apps/web to record version). Install Chromium using the existing command.
- [ ] In an isolated workspace with free test ports, reproduce the old install(startAt)/pauseAt(startAt) sequence with an injected real Node-side 150 ms delay on a fresh page. Capture result and version. Do not claim current reproduction until observed; historical 1.64.1 evidence is in HPA-1028.
- [ ] Confirm both webServer entries, port and readiness behavior in locked Playwright, API root response, Vite prerendered Gallery HTML, and all existing clock users. Search all scripts/docs/CI for PUBLIC_API_BASE and the two E2E ports. Capture current main board and completion screenshots using MCP-driven browser with fixed fixture/viewport, to compare after fix.
- [ ] Create a temporary unrelated loopback HTTP listener on preview port; show existing reuse behavior with controlled harmless test invocation, not a product-failure report. Clean up only the listener created by this regression; avoid real neighboring apps.

## 2. Server startup: own both services

**Edit:** `apps/web/playwright.config.ts`; add small `apps/web/e2e/support/server-identity.ts` global setup (or equivalent single module); use existing API and HTML responses. No production route or Vite build plugin.

- [ ] Add meaningful names; change both reuseExistingServer settings to false unconditionally. Use port: 3999 / 4173 for TCP occupancy; retain baseURL, API cwd/dev:e2e, migrations, 180 s API startup budget, Vite build:e2e + preview --strictPort, project definitions and reporters. Do not change default ports or add a custom server launcher. If TCP semantics of the actual Playwright version differ, use the minimal startup guard described in design.
- [ ] Because API readiness previously required HTTP, wire a single global setup (not a per-test fixture) to probe the expected URLs before any browser test body, including one bounded fetch deadline per attempt and a bounded overall deadline. Validate successful status, no redirect, exact API JSON message, and Perseus HTML description. Report expected service and port on mismatch. Allow transient startup readiness, not successful mismatched responses. No auth writes, production network, or polling in individual tests. Use relative config path and verify setup runs after webServer starts.
- [ ] Ensure the harness preview is compiled against the owned local API base; inspect existing callers of PUBLIC_API_BASE and keep only supported local override semantics or reject invalid values explicitly. No remote endpoint allowed for this harness.
- [ ] Implement a focused automated collision regression outside the normal browser suite (e.g. Bun test or standalone script under apps/web/scripts). Launch a temporary loopback server, spawn the actual Playwright entrypoint with a known smoke spec, verify nonzero exit + named port diagnostic before any browser test body, verify sentinel still serves after exit. Cover preview 200/404 and API /api 404 independently; do not start the test if any pre-existing listener would be overwritten. Cleanup owned sentinel and subprocess in finally, with timeout; avoid recursively invoking Playwright from an active Playwright test. Test identity check for wrong JSON/HTML and valid services without starting production API. Add to existing invariant command if cheap and isolated; otherwise document dedicated automated command and run explicitly, retaining regular smoke gate. Record positive clean-start and owned-process cleanup in acceptance. No broad runner redesign.

## 3. Clock initialization

**Edit:** `apps/web/e2e/support/gameplay-page.ts` stage 4; add `apps/web/e2e/support/paused-clock.ts`; extend `apps/web/e2e/playwright-clock-contract.spec.ts`; adjust existing misleading comments, including gameplay-session-controls spec.

- [ ] Add failing real-browser contract first: shared two-call initializer exercised through a small adapter which inserts 150 ms real Node wait after install. Delegates to actual page.clock; no fake browser API. Preserve existing relative performance delta test intent. Capture failing old behavior, or explicitly record if current dependency already fixes the issue.
- [ ] Implement initializePausedClock using public install({ time: startAt minus named 1-hour virtual lead }) then pauseAt(startAt). Call before navigation from stage 4, after existing reduced-motion emulation. Check all paused fixture tests fit within lead. No arbitrary wall-clock sleeps in implementation, timeout widening, swallowing errors or blanket retries. Keep fixture option type unchanged. Do not change setup stage order or the atomic init script.
- [ ] In contract spec, assert Date.now() equals startAt at first navigation; performance.now() baseline is frozen, both clocks unchanged during a real host wait; after runFor(2000) each advances exactly 2000. Verify navigation/reload carry correct time as appropriate to existing clock contract, real-clock path remains normal, and runFor drives scheduled interval behavior. Do not assume performance.now() must start at numeric zero; audit any absolute assertions before revising comments. Use the exact requested epoch and monotonic deltas. If this public API strategy fails on installed version, retain behavioral contract and validate a smaller supported alternative; no production timer modifications.
- [ ] Execute focused clock spec >=10 times with retries=0, including concurrent workers (one Playwright invocation; do not fight exclusive fixed ports across invocations). Keep the contract @smoke. Verify existing gameplay session controls 3s active + 5s paused + 2s resumed = 5s sealed elapsed, relaxed run clockless, completion/persistence assertions intact. Include actual helper-through-gotoFixture browser path, not just low-level clock proof.

## 4. Documentation and self-review

- [ ] Update `apps/web/e2e/README.md` project commands, server ownership/occupied port troubleshooting, startup checks, atomic init and clock/rAF section; update AGENTS.md E2E paragraph only if necessary. Explain local same-project reuse is intentionally removed to prevent stale/wrong-build false positives; developers stop their own server from its owning workspace, not kill by port. Document dedicated collision regression command if not automatic.
- [ ] Audit diff: no production code/API routes/engine/DB schema/mobile/art changes; no broad CI restructuring; no timeout/retry masking. Confirm new helper code fits existing TS, Prettier/ESLint and Bun invariant patterns.

## 5. End-to-end acceptance checklist

Run via the implementation agent's MCP browser/Playwright tooling on a single desktop Chromium platform, with no human or native-device acceptance gate.

- [ ] Wrong preview HTTP service (200 and 404) and wrong API service (/api 404) produce explicit nonzero, named port/service failure, no browser test bodies; independently confirm sentinel alive, no port hopping. CI mode remains fail-closed. Validate identity mismatch with focused test; record results.
- [ ] Free ports start real local Wrangler API and harness preview, validate identity and load Perseus Gallery; play a deterministic puzzle, place pieces, pause/resume/complete, assert session/progress and exact timed result, no undeclared fixture requests. Verify both runner-owned servers stop on exit; capture logs and branch SHA. Capture board and completion screenshots and visually compare to main (no mockup or intentional visual changes).
- [ ] Clock regression: record old/new versions, 150 ms injected delay, exact wall epoch and monotonic deltas; >=10 successful fixed iterations at retries=0 and multi-worker run; existing timed/relaxed completion and real-clock checks pass. Preserve reload and reduced-motion contract.
- [ ] Run commands from root (adjust only based on actual spec/command discovery):
  - `bun run --cwd apps/web check`
  - `bun run --cwd apps/web lint`
  - `bun test apps/web/scripts` plus any new focused invariant tests (if applicable; collision regression may have its own invocation)
  - `bun run --cwd apps/web test:e2e -- playwright-clock-contract.spec.ts --repeat-each=10 --workers=4 --retries=0`
  - `bun run --cwd apps/web test:e2e -- gameplay-session-controls.spec.ts --retries=0`
  - `bun run --cwd apps/web test:e2e -- --retries=0`
  - `bun run --cwd apps/web test:e2e:assert-production-bundle`
  - `bun run --cwd apps/web test:e2e:smoke -- --retries=0`
- [ ] Record pass/fail counts, commit SHA, actual Playwright version, collision test logs, screenshot paths and any distinct observed failure in PR. Required Build & Lint, Unit Tests, Chromium smoke gates green when code PR leaves draft. Do not claim docs-only skipped CI is a pass. Do not mark Done until implementation evidence satisfies ticket; leave HPA-825 residual production QA independent.

## Stop conditions

One PR, no new tickets for the two consolidated defects. If reproduction shows a separate genuine product issue, document it without speculative fixes. No real production auth/upload testing in this harness ticket.
