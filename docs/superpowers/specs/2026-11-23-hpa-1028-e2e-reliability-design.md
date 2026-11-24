# HPA-1028 — E2E server ownership and deterministic clock initialization

- Linear: [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028/e2e-harden-server-reuse-and-fake-clock-initialization)
- Base reviewed: `dd0fe6da7e3e7b6afccf4d9a6a51e8f271bfe81e` (main, after HPA-1032)
- Status: proposed, revised after [design review](https://github.com/cwchanap/perseus/pull/188#pullrequestreview-6032808311); implementation and acceptance pending. One PR.
- HPA-1027 is consolidated here; HPA-825's remaining production QA is separate.

## Problem and evidence

1. `apps/web/playwright.config.ts` enables `reuseExistingServer: !process.env.CI` for both Wrangler API (3999, HTTP readiness /api) and Vite preview (4173, TCP readiness). HPA-1028 records ten invalid runs against Gliese, not ten Perseus product failures. Starting a fresh owned server is simpler than identifying a pre-existing build.
2. The preview build and `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts:32` both use `process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'`. Production-mode SvelteKit embeds this value at build time; `apps/web/src/lib/services/api.ts` recommends port 4690 for ordinary local dev. An inherited environment variable can silently send E2E traffic to the wrong API even with server reuse disabled. The existing E2E port is 3999 (`.env.test` agrees); there is no supported remote E2E mode.
3. `apps/web/e2e/support/gameplay-page.ts:251-270` installs the clock at startAt and pauses at that same instant. Time runs between calls, so an already-past target can throw "Cannot fast-forward to the past". Historical 1.64.1 harness-shaped reproduction: 3/3 failures with an injected 150 ms delay; ten isolated serial completion runs passed. This demonstrates the race, not the precise cause of the original contention. `bun.lock` now pins @playwright/test, playwright and playwright-core at 1.65.1; install the lockfile and record the actual version before reproducing.
4. Existing `e2e/playwright-clock-contract.spec.ts` checks performance.now deltas after install/navigation/pause at +5 seconds; it does not exercise the helper's pre-navigation sequence. `e2e/gameplay-session-controls.spec.ts` already proves 3 s active + 5 s paused + 2 s resumed = 5 s active, through gotoFixture.

## Decision A — exclusive runner-owned servers and a fixed E2E API origin

Set `reuseExistingServer: false` for both existing entries, in local and CI runs. Preserve API `url: 'http://localhost:3999/api'` and 180 s HTTP readiness budget, preview `port: 4173`, build:e2e and --strictPort, baseURL, existing dev:e2e migration/auth/CORS setup and test projects. Names may be added for diagnostics, but no extra startup code.

Rely on Playwright's built-in availability/bind behavior. The review inspected the locked runner's occupied-port check (IPv4 and IPv6), HTTP readiness check and Miniflare's address-in-use handling: a foreign TCP listener on 4173 fails before the preview is launched; a ready HTTP service on 3999 fails the URL availability pre-check. A stable foreign /api 404 is not HTTP-ready, so Wrangler attempts startup and should fail on binding 3999. Verify that last case on the actual locked environment; do not assume source inspection is execution evidence. If startup times out instead, the existing timeout must fail closed; if an actual false pass occurs, stop and address only that demonstrated gap. No switch of API readiness to TCP, globalSetup probe, custom preflight, or collision runner. Do not kill foreign processes, hop ports, or add same-checkout reuse protocols. Document stopping the owning process from its own workspace. Concurrent workers within one invocation share the owned services.

Hardcode `http://localhost:3999` in the preview webServer.env.PUBLIC_API_BASE and the harness-services spec's API_ORIGIN (or share one small E2E constant only if it reduces duplication without adding plumbing). Remove both inherited PUBLIC_API_BASE reads. The explicit env entry must win over process.env; ordinary dev/production build settings remain untouched. Demonstrate with a deliberately exported local-dev value, checking the actual unmocked API request origin in the browser and harness-service path. No external service or production endpoint needs to be contacted for this proof.

Record one-time, agent-executed collision checks with temporary listeners on free loopback ports: 4173 with ordinary HTTP (TCP occupancy), 3999 with /api returning a stable 404 (bind-failure path), and a ready 200 /api if useful for the cheap direct pre-check. Verify nonzero exit, actionable port output, no test bodies run, listener still answers, and owned children exit. No permanent subprocess-based collision suite. Use a listener on the same loopback interface(s) as the intended service so the check actually exercises a bind conflict.

## Decision B — pause from an earlier virtual time, before navigation

Keep the existing route/cookie/clock/atomic init/navigation ordering and reduced-motion behavior. Extract the public API calls into a tiny `e2e/support/paused-clock.ts` helper accepting `Pick<Page['clock'], 'install' | 'pauseAt'>`:

```ts
const PAUSE_LEAD_MS = 3_600_000;
await clock.install({ time: new Date(startAt.getTime() - PAUSE_LEAD_MS) });
await clock.pauseAt(startAt);
```

Call from GameplayPage stage 4 on the blank page before app scripts/timers exist. The lead is virtual, not a real wait; it exceeds normal test setup duration. Do not widen timeouts, add retries, use setFixedTime, or expose delay injection through the product/harness options.

Add one @smoke contract test alongside the existing relative delta test: a small adapter delegates to actual page.clock and inserts a 150 ms host-side wait after install; invoke the actual shared initializer, navigate to '/', assert Date.now() equals the requested startAt. Demonstrate the old sequence fails under that delay (or report accurately if the pinned version differs), and the new helper passes. The existing delta contract and session controls cover elapsed time and pause/resume; keep them unchanged apart from correcting misleading comments that assume a numerically zero performance.now baseline. No extra reload/interval/real-clock suite or ten-repeat stress gate: the injected delay tests this race directly. Retain omitted/false real-clock behavior and existing reduced motion.

References: [Playwright Clock API](https://playwright.dev/docs/api/class-clock), [webServer configuration](https://playwright.dev/docs/test-webserver).

## Scope and acceptance (implementation pending)

Only web E2E config, harness-services spec, tiny clock helper, gameplay-page, one additional clock test and concise README edits (port ownership/troubleshooting, clock ordering and monotonic-baseline wording). No product code, engine, codec, native app, API routes, dependencies, CI architecture or artwork/SFX. No AGENTS.md change. HPA-825 stays separate.

- Actual local Playwright entrypoint with an unrelated listener on 4173 and independently a stable /api 404 on 3999 fails before test bodies, identifies the occupied port, leaves the listener alive and cleans up owned children; CI uses the same false reuse settings. Record one-time checks, not a new testing framework. No need to recreate historical wrong-app runs.
- Clean startup on free ports runs the owned services. With PUBLIC_API_BASE=http://localhost:4690 inherited, the actual preview's unmocked Gallery API request and harness-services path still target 3999. Existing fixture solve and ordinary API tests pass; verify cleanup.
- One injected-delay contract regression proves the actual helper pauses at the requested wall epoch on the locked version. Existing runFor delta and timed/relaxed session-controls tests pass without weakened assertions.
- MCP-driven desktop Chromium acceptance uses the existing Gallery/fixture gameplay/session-controls flow and checks the current board/completion screenshot(s) for obvious unintended visual changes. No baseline capture, pixel diff, separate visual suite, or native/manual human sign-off; this is harness-only and has no ticket mockup.
- Focused clock/session-controls/harness-services specs, full default desktop E2E, smoke, production-bundle assertion and web check/lint pass. Record command outcomes, SHA, version, collision diagnostics and the lightweight MCP screenshot evidence. Existing CI remains unchanged; skipped draft/docs CI is not a pass. All implementation stays in this PR.
