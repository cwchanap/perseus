# Deterministic Gameplay E2E Harness

This directory holds the deterministic end-to-end test harness for the puzzle
gameplay page (`/puzzle/[id]`). It replaces every source of non-determinism a
real puzzle introduces — random tray order, random run ids, random rotations,
the real backend, the wall clock, real OAuth — with fixed, byte-stable fixtures
so a test run reproduces identically every time, locally and in CI.

This document is the operator and contributor reference for the harness. For the
umbrella design, see the HPA-226 design doc; for production gameplay behavior,
see the source under `src/lib/services/gameplay/`.

> **Feature ownership:** HPA-226 delivers the _infrastructure_ (fixtures,
> router, runtime override, interaction driver, CI split). Concrete gameplay
> scenarios — new completion outcomes, new interaction methods, new a11y
> assertions — are owned by the feature ticket that needs them. Add a scenario
> by importing from `e2e/support/test` and following the extension rules below.

---

## Table of contents

- [Project commands](#project-commands)
- [E2E lanes](#e2e-lanes)
- [Fixture catalog](#fixture-catalog)
- [Total request interception](#total-request-interception)
- [Virtual module and import rules](#virtual-module-and-import-rules)
- [Fallback semantics](#fallback-semantics)
- [Atomic `gotoFixture()` initialization](#atomic-gotofixture-initialization)
- [Clock and rAF implications](#clock-and-raf-implications)
- [localStorage persistence](#localstorage-persistence)
- [Completion matrix](#completion-matrix)
- [Deferred route cleanup](#deferred-route-cleanup)
- [Cross-input and dialog extension rules](#cross-input-and-dialog-extension-rules)
- [Browser matrix and tags](#browser-matrix-and-tags)
- [WebKit drag result (HPA-517)](#webkit-drag-result-hpa-517)
- [Firefox deferral](#firefox-deferral)
- [CI artifacts](#ci-artifacts)
- [Accessibility limits](#accessibility-limits)

---

## Project commands

All commands run from the repo root unless noted. The `test:e2e:*` family is
defined in `apps/web/package.json`; invoke a command with
`bun run --cwd apps/web <command>`.

| Command                             | Role                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `test:install-browsers:chromium`    | Chromium-only install for Unit Tests and automatic E2E.  |
| `test:e2e:assert-production-bundle` | First validation in automatic E2E.                       |
| `test:e2e:smoke`                    | Automatic Chromium desktop/mobile E2E lane.              |
| `test:install-browsers`             | Chromium+WebKit install for local/manual broad coverage. |
| `test:e2e:webkit`                   | Manual pre-release WebKit critical coverage.             |
| `test:e2e:extended`                 | Manual pre-release five-project coverage.                |
| `test:e2e:a11y`                     | Manual pre-release accessibility coverage.               |
| `test:e2e:stability`                | Manual pre-release ten-repeat Chromium stability sweep.  |

The default local `test:e2e` script remains available for Chromium gameplay
runs and excludes the slow `@extended` scenarios.

Pass Playwright flags after `--`, e.g. `bun run --cwd apps/web test:e2e:smoke -- --retries=0 --grep "fixture load"`.

---

## E2E lanes

```text
Automatic code-change E2E:
  production-bundle assertion -> Chromium install -> desktop/mobile smoke

Manual workflow dispatch:
  Chromium+WebKit install -> WebKit -> extended -> accessibility -> stability
```

Documentation-only changes do not start Build & Lint, Unit Tests, or E2E. Unit
Tests installs Chromium only; manual broad coverage installs Chromium and
WebKit.

---

## Fixture catalog

Five fixtures span the three supported aspect ratios, a small completion
fixture, two non-square layouts, and two large layout fixtures. Every fixture is
built through the validated `buildFixture` builder
(`e2e/gameplay-fixtures/builder.ts`), so a transposed grid, partial tray
permutation, or invalid rotation fails at **test import time** — a broken
catalog can never ship.

Run IDs are fixed UUIDv4-shaped strings (never random). Tray permutations are
literal for the completion fixture and a fixed-seed LCG Fisher–Yates shuffle for
the larger layouts, so the catalog is byte-stable across runs. Rotations are
non-zero only on the rotation-enabled completion fixture.

| Fixture ID         | Aspect | Grid (rows × cols) | Piece count | Piece IDs | Image     | Role                  |
| ------------------ | ------ | ------------------ | ----------- | --------- | --------- | --------------------- |
| `e2e-square-4`     | `1:1`  | 2 × 2              | 4           | 0–3       | 200×200   | Completion + rotation |
| `e2e-landscape-12` | `4:3`  | 3 × 4              | 12          | 0–11      | 400×300   | Landscape layout      |
| `e2e-portrait-12`  | `3:4`  | 4 × 3              | 12          | 0–11      | 300×400   | Portrait layout       |
| `e2e-square-100`   | `1:1`  | 10 × 10            | 100         | 0–99      | 1000×1000 | Large layout          |
| `e2e-square-225`   | `1:1`  | 15 × 15            | 225         | 0–224     | 1500×1500 | Large layout          |

**Piece IDs are zero-based and assigned as `row * cols + col`**, matching the
production puzzle generator. So in `e2e-square-4` (2 cols), piece `2` is at
correct cell `(x=0, y=1)`; in `e2e-landscape-12` (4 cols), piece `7` is at
`(x=3, y=1)`. The `correctX`/`correctY` on each piece is the source of truth.

Rows and columns are **derived** from the shared production grid contract
(`getGridDimensionsForAspectRatio` in `packages/types`), never accepted as an
unchecked orientation. Validating only `rows * cols` would admit transposed 4:3
/ 3:4 grids; the builder requires exact equality with the shared helper. Edge
geometry reuses the shared edge helpers so complementary neighbors are correct by
construction, and the builder additionally validates flat outer edges and
complementary neighbors as defense-in-depth.

The fixture catalog lives in `e2e/gameplay-fixtures/catalog.ts`; the builder in
`e2e/gameplay-fixtures/builder.ts`. The default fixture is `e2e-square-4`.

---

## Total request interception

The fixture router (`e2e/gameplay-fixtures/fixture-router.ts`) intercepts
**every** request whose path carries an `e2e-*` fixture id **before** either
backend sees it. The invariant is total: an `e2e-*` request can never fall
through to the real API.

| Request shape                                  | Router behavior                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/puzzles/<known-id>`                  | Fulfill with the `ReadyPuzzle` metadata JSON.                                                                                                                                                                                                                                                                            |
| `GET /api/puzzles/<known-id>/pieces/<n>/image` | Fulfill with a padded piece SVG. 404 if `n` is out of range.                                                                                                                                                                                                                                                             |
| `GET /api/puzzles/<known-id>/reference`        | Fulfill with the reference SVG.                                                                                                                                                                                                                                                                                          |
| `GET /api/puzzles/<known-id>/thumbnail`        | Fulfill with the thumbnail SVG.                                                                                                                                                                                                                                                                                          |
| `POST /api/puzzles/<known-id>/complete`        | Fulfill **403** `{ error: 'undeclared_completion' }` by default. An undeclared completion is a harness violation — only the `ApiScenarioController` produces a successful completion. When a controller is installed (registered after the router), it takes precedence and owns the outcome. Never reaches the backend. |
| Any **other** sub-path under a known id        | Fulfill **404** (`unknown_fixture_path`). Never passed through.                                                                                                                                                                                                                                                          |
| `/api/puzzles/e2e-<unknown-id>` (typo)         | Fulfill **404** (`unknown_e2e_fixture`) immediately. Never `fallback()`.                                                                                                                                                                                                                                                 |
| Any non-`e2e-*` path                           | `route.fallback()` — ordinary traffic (gallery list, auth session, real puzzle ids) reaches the backend untouched.                                                                                                                                                                                                       |

Every router-fulfilled response carries the `x-perseus-e2e-source:
fixture-router` header so tests can prove who answered a request. The
`ApiScenarioController` stamps the same header with value `api-scenario` on its
responses. The page diagnostics layer (`e2e/support/diagnostics.ts`) records
any `e2e-*` response that reaches the real backend (no marker, not a completion
path) as a **leak** and fails teardown — so a future API path added under
`/api/puzzles/:id/…` fails loudly instead of silently reaching production.

**HTTP method enforcement:** the router enforces the production contract — POST
for `/complete`, GET for metadata, piece, reference, and thumbnail endpoints.
The `ApiScenarioController` enforces POST for `/complete`. Auth personas enforce
GET for `/api/auth/session`. A wrong-method request receives a 405 with the
`x-perseus-e2e-violation: method_not_allowed` header so a client-side method
regression cannot pass E2E silently.

**Harness violations:** responses carrying `x-perseus-e2e-violation` (undeclared
completion, wrong HTTP method) are recorded by diagnostics as harness violations
and fail teardown regardless of HTTP status. An undeclared completion (no
`ApiScenarioController` installed) receives a 403 `undeclared_completion` from
the router — only the controller produces a successful completion.

**Completion provenance:** when a completion scenario is declared, diagnostics
requires the response marker to equal `api-scenario` (the controller's
provenance), validates the fixture ID matches the declared scenario, and
confirms the method is POST. A response from the router's 403 default (or a
real-backend response with the expected status) is flagged as unexpected —
proving the configured scenario actually handled the response.

Playwright route precedence: routes run in **reverse** registration order, and
`route.fallback()` passes control to earlier-registered handlers. The router is
installed before the `ApiScenarioController`, so the controller (registered
later) runs first on `/complete` and owns the outcome when a scenario is
installed. The router's default 200 completion fulfillment is the safety net
that guarantees total interception when no controller is present.

---

## Virtual module and import rules

The harness injects deterministic gameplay dependencies (run ids, tray order,
rotations) through a single Vite virtual module:
`virtual:perseus-gameplay-runtime-override`. Only **one** production file may
import it: `src/lib/services/gameplay/runtime.ts`. Two ESLint configs enforce
this boundary (see `apps/web/eslint.config.js`):

1. **Universal guardrail** — no file except `runtime.ts` may import the virtual
   module.
2. **Production-source guardrail** — production source (`src/**`, excluding
   `src/lib/testing/**` and `runtime.ts`) may not import the concrete E2E reader
   (`**/e2e-gameplay-runtime`) or any `*runtime-override*` module.

The Vite plugin (`vite-plugins/gameplay-runtime-override-plugin.ts`) emits
different module bodies depending on the build:

- **Normal build** (`bun run build`): an inline no-op reader that always returns
  `null`, so the production runtime supplies its own (random) factories and the
  concrete reader is dead-code eliminated.
- **Harness build** (`bun run build:e2e`, i.e. `PERSEUS_E2E_HARNESS=1`): re-exports
  the real reader from `/src/lib/testing/e2e-gameplay-runtime`.

The reader consumes the frozen `window.__PERSEUS_E2E_GAMEPLAY_V1__` global
planted by the E2E init script. `bun run --cwd apps/web
test:e2e:assert-production-bundle` builds the normal bundle and scans every
`.js` file for harness sentinels (`__PERSEUS_E2E_GAMEPLAY_V1__`, `e2e-square-4`,
`PERSEUS_E2E_CONFIG:`, `e2e-gameplay-runtime.ts`), failing if any leak through.

---

## Fallback semantics

The runtime reader (`src/lib/testing/e2e-gameplay-runtime.ts`) decides whether
to use the harness config with a strict fallback policy:

- **Missing global + non-`e2e-*` puzzle** → return `null`. The production
  runtime supplies its own factories. Ordinary and `q-*` (quick-puzzle) traffic
  is unaffected by the harness.
- **Missing global + `e2e-*` puzzle** → **hard error**
  (`PERSEUS_E2E_CONFIG: missing gameplay config for e2e puzzle`). An unconfigured
  fixture can never silently fall back to random behavior.
- **Present config with any defect** → **hard error**, prefixed
  `PERSEUS_E2E_CONFIG:`. Once config is present, any defect (bad version,
  non-permutation tray order, missing rotation key, exhausted run ids) is a hard
  failure — never a fallback.

The reader validates the complete frozen shape before creating any closures, and
clones arrays/objects at return boundaries so callers cannot mutate the frozen
config.

---

## Atomic `gotoFixture()` initialization

`GameplayPage.gotoFixture()` (`e2e/support/gameplay-page.ts`) is the canonical
entry point. It composes the four harness services (fixture router, auth
persona, API scenario controller, persisted-state controller) behind **one**
atomic init script and a strict lifecycle order:

1. **Fixture lookup** — `getFixture(id)`.
2. **Route registration** — fixture router, then (optional) API scenario
   controller for completion, then auth persona (defaults to `anonymous` so the
   harness never depends on the real API for auth).
3. **Cookie reset** — `context.clearCookies()`.
4. **Optional clock** — `page.clock.install({ time })` + `pauseAt` **before**
   navigation, so navigation does not advance `performance.now()`.
5. **ONE atomic init script** — clears storage → seeds session/stats → freezes
   the config global. Synchronous, before any app script runs.
6. **Navigation** — `page.goto('/puzzle/<id>')`.
7. **Ready state** — waits for `puzzle-board` to be visible and the expected
   tray piece count to render. No fixed delays; only Playwright auto-waiting
   locators.

The init script is singular on purpose: separate storage and config init scripts
have an unspecified evaluation order, so seeding the session after the app read
it (or vice versa) would be non-deterministic. One script does
clear → seed → freeze-config, synchronously, before any app script runs.

A test rarely calls `gotoFixture()` with raw options — it passes a
`CompletionScenario`, a `seedSession`, a `persona`, or a `clock`, and the page
handles the rest. `expectReady()` is idempotent and safe to re-call after
interactions that re-render the board.

---

## Clock and rAF implications

Passing `clock: { startAt }` to `gotoFixture()` installs Playwright's clock
**and pauses it** at `startAt` before navigation. An installed clock controls:

- `performance.now()` — frozen at zero (relative to `startAt`) until a test calls
  `page.clock.runFor(ms)`.
- `requestAnimationFrame` / `cancelAnimationFrame`.
- `requestIdleCallback` / `cancelIdleCallback`.
- `setTimeout` / `setInterval` (and their `Date.now`-based scheduling).

Navigation with a paused clock is safe: pages do not need advancing time to
initialize, and `fetch` is clock-independent. A test advances time explicitly via
`page.clock.runFor()` (e.g. to advance a gameplay timer before asserting a
sealed `elapsedActiveSeconds`). See `playwright-clock-contract.spec.ts` for the
contract test.

If `clock` is omitted or `false`, the real wall clock stays in place — use that
for tests that do not care about timing.

---

## localStorage persistence

The puzzle page stores resumable progress in `localStorage` under the production
key `puzzle-progress-<puzzleId>` (see
`src/lib/services/gameplay/session/persistence.ts`). This is the **canonical
persistence medium** the harness seeds and asserts against. Puzzle stats live
under `puzzle-stats-<puzzleId>`.

Key format:

- Session: `puzzle-progress-e2e-square-4` (prefix `puzzle-progress-` + fixture id).
- Stats: `puzzle-stats-e2e-square-4` (prefix `puzzle-stats-` + fixture id).

The persisted-state helpers (`e2e/gameplay-fixtures/persisted-state.ts`) provide:

- `buildMinimalSeed(fixtureId)` — a minimal, fully-valid `PersistedPuzzleSessionV1`
  with byte-stable field order.
- `buildSessionValidationContext(fixtureId)` — the production
  `SessionValidationContext` (piece ids, grid, placement coordinates) the codec
  validates against.
- `progressKey(puzzleId)` — the exact localStorage key.

A seeded snapshot is validated by the **production codec** before it is planted,
so a test can never silently plant a state the app would ignore. Fresh Playwright
contexts already isolate storage per test; `gotoFixture()` always clears both
stores in its init script before seeding.

---

## Completion matrix

`POST /api/puzzles/:id/complete` is driven by the `ApiScenarioController`
(`e2e/gameplay-fixtures/api-scenario.ts`) under a bounded `CompletionScenario`
union:

| Scenario                                    | Behavior                                                                                                                                                                                                                                                                                                                       | Use                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ kind: 'success' }`                       | Fulfill 200 `{ ok: true }` immediately.                                                                                                                                                                                                                                                                                        | Happy-path completion.                                                                                                                         |
| `{ kind: 'deferred-success' }`              | Hold the route pending. `release()` fulfills all held routes with 200; `cancel()` aborts them.                                                                                                                                                                                                                                 | Retry, spinner, and pending-state tests.                                                                                                       |
| `{ kind: 'network-abort' }`                 | `route.abort('failed')`. Diagnostics expects NO response on the completion path — any HTTP response (even one stamped with the `api-scenario` marker) is flagged as unexpected, so `network-abort` cannot be used as a wildcard that tolerates arbitrary statuses. Only the aborted POST is allowlisted (via `requestfailed`). | Network-failure retry path.                                                                                                                    |
| `{ kind: 'http-failure', status }`          | Fulfill with the given status. `status ∈ {400, 401, 404, 409, 429, 500}`.                                                                                                                                                                                                                                                      | HTTP-error handling per status.                                                                                                                |
| `{ kind: 'retry-sequence', failureStatus }` | First POST fulfills with `failureStatus`, every subsequent POST fulfills with 200. The controller records every attempt and stamps the `api-scenario` provenance marker itself. `failureStatus ∈ {400, 401, 404, 409, 429, 500}`. Diagnostics allows only `failureStatus` and 200 on the completion path.                      | Controller-owned failure-then-success retry flow (e.g. a retryable 500 followed by a manual retry that succeeds with the same sealed payload). |

Every intercepted request is recorded (url, method, headers, body, parsed JSON)
so tests can assert on the sealed payload the puzzle page sent. The scenario is
passed to `gotoFixture({ completion })`; the returned `gameplayPage.completionHandle`
is the deferred handle (functional for `deferred-success`; a no-op for the rest).

---

## Deferred route cleanup

A `deferred-success` scenario holds its route pending until the test calls
`release()` or `cancel()`. **A deferred route must be released or cancelled
before the test ends.** The `gameplayPage` fixture's automatic teardown runs
`assertSettled()`, which calls `ApiScenarioController.assertClean()` — this
**throws** (with the URL and body of every held route) if any deferred route is
still pending, so a forgotten release is obvious rather than silently hanging.

Teardown also runs `assertNoUnexpectedErrors()` (no non-allowlisted
console/page/failed-request/leaked-fixture errors) and
`assertNoUnexpectedFixtureRequests()`. Both are no-ops when `gotoFixture()` was
never called, so importing the `gameplayPage` fixture is always safe.

---

## Cross-input and dialog extension rules

The `GameplayPage` driver (`e2e/support/gameplay-page.ts`) exposes the supported
interaction methods. **New gameplay tests must import `test` and `expect` from
`e2e/support/test`**, which provides the `gameplayPage` fixture and its
automatic teardown.

To add a new **interaction method** (a new input modality, a new gesture):

1. Add the method to `GameplayPage` in `e2e/support/gameplay-page.ts`.
2. Drive it through the existing `pieceSource(pieceId)` / `dropZone(x, y)`
   locators so source scoping stays consistent.
3. Verify it on Chromium first, then WebKit. Keep reliable WebKit interactions
   (keyboard, touch, dialog) in the `test:e2e:webkit` coverage and keep mouse
   drag in `@extended` (see below).
4. Add a placement assertion via `expectPiecePlaced(pieceId, x, y)` or a new
   assertion helper in the same file.

To extend the **completion dialog** (new action, new focus rule):

1. Reuse the dialog helpers: `waitForDialog(name)`,
   `expectDialogInitialFocus(dialog, target)`, `activateDialogAction(dialog,
name)`, `dismissDialog(dialog, 'escape' | 'visible-close-button')`.
2. Assert role + focus together via the a11y helpers
   (`expectRoleFocused`, `expectContainedIn`) — a control that keeps its visual
   style but loses its role is a regression.

Do **not** add a fourth completion outcome by editing a spec file. Add it to the
`CompletionScenario` union in `api-scenario.ts` so the matrix stays bounded and
auditable, then exercise it from a spec.

---

## Browser matrix and tags

Tests are tagged and the `test:e2e:*` scripts select projects by tag. Tags live
in `test.describe(...)` or individual `test(...)` titles.

| Tag         | Lane                 | Projects                                               | Cadence                                                  |
| ----------- | -------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `@smoke`    | `chromium-smoke`     | `chromium-desktop`, `chromium-mobile`                  | Automatic code-change E2E and manual stability dispatch. |
| `@extended` | `manual-pre-release` | all five projects                                      | `workflow_dispatch` only.                                |
| `@a11y`     | `manual-pre-release` | `chromium-desktop`, `chromium-tablet`, `webkit-mobile` | `workflow_dispatch` only.                                |

The `test:e2e:webkit` command selects reliable WebKit scenarios on
`webkit-mobile` and runs only in the manual pre-release lane.

The five Playwright projects (`playwright.config.ts`):

- `chromium-desktop` — 1440×900
- `chromium-mobile` — 390×844
- `chromium-tablet` — 768×1024
- `webkit-mobile` — 390×844
- `webkit-tablet` — 768×1024

---

## WebKit drag result (HPA-517)

A dedicated spike (`e2e/webkit-drag-spike.spec.ts`) measured raw `dragTo()`
reliability for HTML5 drag-and-drop on WebKit. **Result: 0/20 pass on
`webkit-mobile`** — `dragTo()` does not produce a drop event for HTML5 DnD on
WebKit; every attempt left the piece in the tray.

Action taken:

- Native **mouse drag** tests are tagged `@extended` (Chromium-only matrix), not
  in the manual WebKit suite.
- **Keyboard, touch, and completion dialog** tests are included in the WebKit
  suite (reliable on WebKit).
- `placeWithMouse` falls back to dispatching the DnD event sequence
  (`dragover` + `drop`) directly when `dragTo()` does not register a drop, so the
  helper remains usable across all browsers.

Follow-up: [HPA-517](https://linear.app/cwchanap/issue/HPA-517) — WebKit HTML5
drag-and-drop does not fire drop events via Playwright.

---

## Firefox deferral

Firefox is **not** in the browser matrix. This is a deliberate, documented
deferral, not an oversight:

- The gameplay surface's three input modalities are already covered by Chromium
  (mouse, keyboard, touch) and WebKit (keyboard, touch, dialog). Firefox would
  add a third engine without covering a distinct interaction class.
- CI minutes scale with project count; the current matrix already spans the two
  engine families (Blink and WebKit) that the puzzle page supports.
- Adding Firefox would also require a `firefox-*` project pair and a
  Firefox-specific tag decision for mouse drag (Firefox's HTML5 DnD behavior
  differs from both Chromium and WebKit).

If Firefox coverage becomes a requirement, add `firefox-mobile` / `firefox-tablet`
projects to `playwright.config.ts`, decide which tag each existing test belongs
under on Firefox, and extend the `test:install-browsers` shell list.

---

## CI artifacts

Every browser job uploads its artifacts **on failure only** (`if: failure()`),
retained for 7 days:

- `apps/web/test-results` — Playwright output dir (traces, screenshots, videos
  for failed tests; `trace: 'retain-on-failure'`, `screenshot: 'on-first-failure'`).
- `apps/web/playwright-report` — the HTML report.

The artifact name identifies the lane (`chromium-smoke-results`,
`manual-pre-release-results`). The production-bundle assertion is part of the
Chromium smoke job and uploads no separate artifact.

See `.github/workflows/e2e-test.yml` for the two-job split.

---

## Accessibility limits

The `@a11y` lane runs axe-core (`@axe-core/playwright`) against the WCAG
2.0/2.1 A+AA rule sets via `e2e/support/accessibility.ts`. It:

- attaches the **full** axe JSON (passes, incomplete, every violation impact) as
  a test attachment, and
- fails **only** on `serious` / `critical` violations; `minor` / `moderate`
  findings pass but remain visible in the attached JSON for triage.

Accepted deferrals live in the central `DEFERRED_RULES` register (each entry
names its owning HPA ticket and reason); adding a deferral means adding a
documented entry there, never a silent `disableRules` at a call site.

**Automated scanning is not manual certification.** axe checks a structural
subset of WCAG — it does **not** verify real screen-reader / AT behavior,
focus-trap correctness under tab cycling, or announced semantics in
NVDA/VoiceOver. Manual AT certification remains a separate, human-driven
activity. A green `@a11y` lane means "no serious/critical structural violations
detected", not "certified for assistive technology".
