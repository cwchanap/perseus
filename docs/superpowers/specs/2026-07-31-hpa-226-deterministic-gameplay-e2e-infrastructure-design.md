# Deterministic Gameplay Fixture and E2E Infrastructure Design

- **Issue:** HPA-226
- **Parent:** HPA-215
- **Date:** 2026-07-31
- **Status:** Approved design

## Objective

Build a deterministic Playwright foundation for Perseus gameplay so each HPA-215 feature
workstream can add reliable end-to-end coverage without depending on production puzzle data,
mutable server state, external image assets, real OAuth, uncontrolled time, or random tray and
rotation generation.

HPA-226 owns the reusable fixture catalog, application test seam, Playwright fixtures,
interaction driver, browser projects, diagnostics, accessibility scan helper, and a small
representative smoke suite proving that the infrastructure works. It does not own every feature
scenario in the gameplay UX epic.

## Current Repository Baseline

The current web E2E setup is intentionally small:

- `apps/web/playwright.config.ts` starts the Bun API and the built web preview but defines no
  explicit browser projects, viewport matrix, retries, reporters, or failure-artifact policy.
- `.github/workflows/e2e-test.yml` installs only Chromium and runs one undifferentiated E2E job.
- Gallery and profile tests intercept selected HTTP requests independently in each test file.
- `apps/web/e2e/puzzle-solving.spec.ts` contains four skipped gameplay cases because no known
  puzzle fixture or reusable interaction harness exists.
- The puzzle route constructs a browser run-ID factory, browser clock, random tray shuffle, and
  puzzle-derived rotations directly.

HPA-236 is complete. The extracted `PuzzleSession` engine already accepts a `Clock`,
`RunIdFactory`, initial tray order, restart tray-order factory, and rotation factory. HPA-226
will expose those existing injection points at the application boundary rather than creating a
second gameplay state model or bypassing domain actions.

## Fixed Design Decisions

1. Fixture puzzle metadata, image responses, authentication responses, and API outcomes are
   owned by the Playwright harness.
2. The web application receives only a narrow, compile-time-gated E2E runtime configuration for
   values generated inside the browser: run IDs, tray ordering, and rotations.
3. Browser time is controlled through Playwright's clock support before navigation. The
   application does not gain a timer-control endpoint.
4. The harness does not expose `PuzzleSession.dispatch`, direct piece placement, direct
   completion sealing, or arbitrary post-startup persistence mutation.
5. There are no `/api/test/*` routes and no test-only storage mutation endpoints in either the
   Bun or Cloudflare Worker API runtime.
6. Tests use visible UI, accessibility roles, stable test IDs, and observable network outcomes.
   Direct state seeding is limited to explicit fixture setup before application startup.
7. A normal production build must not contain the E2E runtime global, fixture catalog, fixture
   IDs, or E2E configuration reader.
8. CI may retry once for richer diagnostics, but `failOnFlakyTests` makes a retry-pass fail the
   job rather than hide instability.
9. Firefox is deferred. Chromium supplies the core suite and WebKit supplies the critical
   Safari, responsive, focus, and touch-compatibility axis for this ticket.
10. Browser emulation is compatibility coverage, not a claim of physical-device gesture or
    assistive-technology equivalence.

## Ownership

### HPA-226 owns

- deterministic puzzle builder and fixture catalog;
- deterministic reference and piece assets served without external dependencies;
- secure E2E runtime dependency injection;
- fresh-state reset and explicit persisted-state seeding;
- anonymous and authenticated HTTP personas;
- controllable API success, deferred response, retryable failure, and terminal failure;
- reusable mouse, keyboard, tap, and supported touch-drag interaction methods;
- browser and viewport projects;
- diagnostics and accessibility scan utilities;
- representative infrastructure smoke coverage;
- migration of existing infrastructure-owned skipped gameplay tests;
- local and CI commands, security boundaries, and debugging documentation.

### Feature tickets own

- HPA-218 Continue Mission and gallery-progress scenarios;
- HPA-219 tap-to-place and bottom-sheet inventory scenarios;
- HPA-220 filtering, sizing, and shuffle scenarios;
- HPA-237 staging-tray scenarios;
- HPA-221 setup, pause, restart, and Relaxed-mode scenarios;
- HPA-222 reference and assistance scenarios;
- HPA-223 roving focus, announcements, display preferences, and screen-reader scenarios;
- HPA-224 completion-report, replay, and next-mission scenarios.

HPA-226 establishes extension points for helpers whose UI does not yet exist. The owning
feature ticket adds the concrete methods and selectors when that surface lands.

## Architecture

```text
Playwright test
    |
    +-- typed fixture catalog and API scenario router
    |
    +-- browser context setup
    |     +-- fresh storage and cookies
    |     +-- window.__PERSEUS_E2E_GAMEPLAY_V1__
    |     +-- Playwright clock
    |
    +-- player-facing GameplayPage driver
    |
    v
Built web application in E2E mode
    |
    +-- ordinary puzzle source service -> intercepted fixture HTTP responses
    |
    +-- ordinary PuzzleSession actions and persistence
    |
    +-- aliased E2E runtime reader -> injected run IDs, tray order, rotations
```

The fixture catalog and API scenario router live only under `apps/web/e2e/`. Production source
contains the runtime dependency interface and a no-op override module. An E2E build-time alias
replaces only that no-op module with the configuration reader.

## Deterministic Fixture Catalog

### Initial fixtures

| Fixture | Ratio | Grid | Pieces | Primary purpose |
| --- | --- | ---: | ---: | --- |
| `e2e-square-4` | 1:1 | 2 x 2 | 4 | Full completion, persistence, error, and input smoke flows |
| `e2e-landscape-12` | 4:3 | 4 x 3 | 12 | Landscape responsive and reference coverage |
| `e2e-portrait-12` | 3:4 | 3 x 4 | 12 | Portrait responsive and mobile coverage |
| `e2e-square-100` | 1:1 | 10 x 10 | 100 | Layout, inventory, focus, interaction, and diagnostic support |
| `e2e-square-225` | 1:1 | 15 x 15 | 225 | Large-layout and interaction support without full solve loops |

The 4-piece fixture is the only puzzle solved completely by the infrastructure smoke suite.
Large fixtures prove renderability and representative interactions; CI never places all 100 or
225 pieces.

### Fixture builder

`apps/web/e2e/fixtures/builder.ts` defines a pure typed builder accepting:

- fixture ID and display name;
- aspect ratio;
- rows and columns;
- image width and height;
- creation timestamp;
- reference-image availability;
- canonical tray order;
- canonical rotation map;
- deterministic run-ID sequence.

The builder generates piece records from row and column positions and reuses the shared grid
and edge helpers from `@perseus/types`. It validates:

- `rows * cols === pieceCount`;
- unique piece IDs;
- unique in-bounds correct coordinates;
- flat outside edges;
- complementary adjacent edges;
- complete tray-order permutations;
- rotations limited to `0 | 90 | 180 | 270`;
- image dimensions matching the declared aspect ratio.

Fixture construction fails during test import when a catalog definition violates an invariant.

### Fixture files

```text
apps/web/e2e/fixtures/
  builder.ts
  catalog.ts
  assets.ts
  fixture-router.ts
  api-scenario.ts
  auth-persona.ts
  persisted-state.ts
```

`catalog.ts` exports the five immutable definitions. Tests request fixtures by the bounded
fixture ID type rather than constructing ad hoc puzzle payloads.

### Deterministic assets

`assets.ts` generates small deterministic SVG responses for every piece and reference image.
Do not check in hundreds of PNG files. Each SVG includes its fixture and piece identity,
uses fixed dimensions, and has no network dependency.

Asset fidelity is sufficient to exercise image loading, layout, sizing, and reference rendering.
Pixel-perfect jigsaw masking and animation regression remain outside HPA-226.

### HTTP routing

Fixture IDs use the ordinary API puzzle path rather than Quick Puzzle storage. Playwright
intercepts existing routes for:

- puzzle detail;
- piece image;
- reference image;
- gallery list when a test starts from the gallery;
- authenticated session and profile responses when required;
- completion submission.

An unregistered `e2e-*` request fails the test instead of falling through to the Bun server.
Non-fixture requests may continue to the local API for existing unrelated E2E coverage.

## Runtime Dependency Seam

### Production dependency factory

Create `apps/web/src/lib/services/gameplay/runtime.ts`:

```ts
interface GameplayRuntimeDependencies {
	runIdFactory: RunIdFactory;
	createInitialTrayOrder(pieceIds: number[]): number[];
	createRestartTrayOrder(pieceIds: number[]): number[];
	createRotations(puzzleId: string, pieceIds: number[]): Record<number, Rotation>;
}
```

Production behavior remains unchanged:

- run IDs use the existing browser UUID factory;
- initial and restart tray orders use the existing shuffle behavior;
- rotations retain the existing puzzle-derived seed behavior.

The puzzle route constructs `PuzzleSession` exclusively through this dependency object.

### Exact build-gating mechanism

Create the production no-op module:

`apps/web/src/lib/services/gameplay/runtime-override.ts`

It exports a typed `readGameplayRuntimeOverride(): GameplayRuntimeDependencies | null` that
always returns `null` and contains no E2E global name or fixture sentinel.

Create the E2E-only reader:

`apps/web/src/lib/testing/e2e-gameplay-runtime.ts`

In `apps/web/vite.config.ts`, when and only when the build process has
`PERSEUS_E2E_HARNESS=1`, alias the exact import path
`$lib/services/gameplay/runtime-override` to the E2E reader. Normal development and production
builds resolve the physical no-op module.

The Playwright web-server build command sets `PERSEUS_E2E_HARNESS=1`. No public environment
variable is read by the application at runtime.

This alias split makes the E2E reader absent from normal production bundles rather than merely
dormant behind a browser-controlled flag.

### E2E configuration contract

A Playwright init script installs and freezes this value before application scripts run:

```ts
window.__PERSEUS_E2E_GAMEPLAY_V1__ = {
	version: 1,
	fixtureId: 'e2e-square-4',
	runIds: ['00000000-0000-4000-8000-000000000001'],
	initialTrayOrder: [4, 2, 1, 3],
	restartTrayOrders: [[2, 3, 4, 1]],
	rotations: { 1: 0, 2: 90, 3: 180, 4: 270 }
};
```

The E2E reader validates the complete contract. Exhausting the run-ID or restart-order sequence
fails with a clear error and never falls back to production randomness.

### Production-bundle proof

Add `apps/web/scripts/assert-no-e2e-harness.ts`. It scans the normal built JavaScript output and
fails when it finds any of these sentinels:

- `__PERSEUS_E2E_GAMEPLAY_V1__`;
- `e2e-square-4`;
- the E2E contract validation prefix;
- the E2E reader module path.

The production build/check workflow runs this assertion. Setting the E2E global, query
parameter, cookie, request header, or local-storage key on a normal build has no effect.

### Clock control

The route retains its existing browser `Clock` implementation based on `performance`, `Date`,
and interval functions. Playwright installs its clock before navigation and advances browser
time through the supported test API.

Tests may freeze wall time, advance active gameplay time, release timer-driven UI, and validate
pause or hidden-time exclusion when those feature scenarios exist. The E2E runtime does not
expose a separate timer mutation method.

## State, Authentication, and API Controls

### Isolation and reset

Every test receives a fresh Playwright browser context. `apps/web/e2e/support/test.ts` defines an
automatic fixture that also clears before application startup:

- cookies;
- `localStorage`;
- `sessionStorage`;
- IndexedDB databases when present;
- Cache Storage entries when present.

A preservation option is allowed only inside a test validating reload or resume. No test relies
on cleanup from another test.

### Persisted-state seeding

`persisted-state.ts` provides typed setup for:

- `PersistedPuzzleSessionV1`;
- local puzzle statistics;
- Quick Puzzle records when a Quick Puzzle test explicitly needs them;
- feature-owned device preferences once their schemas exist.

Seed data uses production serializers or validated builders wherever possible. Raw storage-key
payloads are permitted only for a migration or malformed-record scenario. Seeding happens
before application startup; after navigation, tests use the UI.

### Authentication personas

The default persona is anonymous. `auth-persona.ts` supports:

- anonymous;
- authenticated player with deterministic identity;
- deferred session response;
- failed session response.

Simulation occurs through the existing HTTP contract. Tests do not inject the Svelte auth store
and do not create real OAuth sessions.

### API scenarios

`api-scenario.ts` supports:

- immediate success;
- deferred response with a test-owned `release()` operation;
- retryable network abort;
- retryable HTTP 500;
- unauthorized HTTP 401;
- quota HTTP 429;
- conflict HTTP 409;
- not-found HTTP 404;
- validation HTTP 400.

Deferred responses use explicit promises, not sleeps. The helper records method, URL, request
body, and outcome. Unexpected writes fail unless explicitly registered.

## Playwright Fixture and Driver Layer

### Files

```text
apps/web/e2e/support/
  test.ts
  diagnostics.ts
  accessibility.ts
  gameplay-page.ts

apps/web/e2e/gameplay-infrastructure.spec.ts
apps/web/e2e/gameplay-large-fixtures.spec.ts
```

Existing unrelated E2E files remain in place. HPA-226 does not reorganize them solely for
naming consistency.

### Extended test object

`support/test.ts` exports the canonical E2E `test` and `expect`. It provides:

- `fixtureCatalog`;
- `fixtureRouter`;
- `apiScenario`;
- `authPersona`;
- `persistedState`;
- `gameplayPage`;
- `scanAccessibility`;
- automatic console and network diagnostics.

Fixtures are narrow and composable. Tests without gameplay fixtures do not pay their setup
cost.

### Stable selectors

Use existing surfaces where available:

- puzzle pieces by `data-testid="puzzle-piece"` and `data-piece-id`;
- board cells by `data-testid="drop-zone"`, `data-x`, and `data-y`;
- board by `data-testid="puzzle-board"`;
- accessible role and name for dialogs and controls.

Add test IDs only when role/name is unstable or coordinate/identity is otherwise unavailable.
Test IDs describe semantic surfaces rather than internal component structure.

### Mouse placement

`GameplayPage.placeWithMouse(pieceId, x, y)`:

1. finds the unplaced piece and target drop zone;
2. performs the browser drag interaction;
3. waits for observable placement state;
4. records source and target bounding boxes on failure.

A standards-compatible drag-event fallback is allowed only when Playwright's normal drag path
cannot drive the existing HTML drag-and-drop behavior consistently. The fallback still targets
the rendered UI and event handlers; it never calls the session engine.

### Keyboard placement

`GameplayPage.selectAndPlaceWithKeyboard(pieceId, x, y)`:

1. focuses the piece;
2. selects with Enter or Space;
3. verifies selected state through ARIA or the existing data attribute;
4. focuses the target cell;
5. places with Enter or Space;
6. verifies placement and selection cleanup.

HPA-223 extends this driver with roving-navigation methods.

### Tap and touch

`GameplayPage.tapPiece(pieceId)` uses browser pointer/touch input where the current UI supports
it.

`GameplayPage.dragWithTouch(pieceId, x, y)` covers the current direct-touch path. It may use a
small standards-shaped touch-event adapter because Playwright does not expose a complete
high-level touch-drag primitive. The adapter drives the rendered element, window listeners, hit
testing, and drop handlers used by players.

HPA-219 owns tap-to-place semantics, bottom-sheet scrolling, safe-area behavior, and two-finger
board-pan helpers.

### Dialog base

HPA-226 implements methods only for dialog surfaces present at delivery:

- wait by dialog role and accessible name;
- assert initial focus and focus containment;
- activate visible actions;
- dismiss through an allowed keyboard or pointer path.

HPA-221 and HPA-224 add concrete setup, pause, restart, and redesigned completion methods.

### Wait policy

Tests wait on web-first locator assertions, URL transitions, visible progress, placed-piece
output, dialog state, request/response completion, or `expect.poll`.

`page.waitForTimeout` is prohibited unless the call has an inline explanation naming the
browser behavior that has no observable signal. An unexplained sleep is a review-blocking
defect.

## Browser and Viewport Projects

| Project | Engine | Viewport | Purpose |
| --- | --- | --- | --- |
| `chromium-desktop` | Chromium | 1440 x 900 | Primary desktop and core smoke coverage |
| `chromium-mobile` | Chromium | 390 x 844 | Primary responsive and tap coverage |
| `chromium-tablet` | Chromium | 768 x 1024 | Extended tablet layout coverage |
| `webkit-mobile` | WebKit | 390 x 844 | Critical Safari touch, focus, and responsive compatibility |
| `webkit-tablet` | WebKit | 768 x 1024 | Extended Safari tablet compatibility |

Touch and mobile context options are enabled only for the matching projects. Viewports are
explicit rather than inherited from named devices whose definitions can change.

Use these bounded tags:

- `@smoke` — fast pull-request coverage;
- `@webkit-critical` — minimal WebKit gate;
- `@extended` — main-branch or scheduled coverage;
- `@large` — 100- and 225-piece checks;
- `@a11y` — automated accessibility scans.

Firefox is not a required project. The E2E guide records the extension point for adding it when
a product requirement or defect signal justifies the ongoing matrix cost.

## Accessibility Support

Add `@axe-core/playwright`. `support/accessibility.ts` exposes one scan helper that:

- runs against a named stable surface or locator;
- records URL, fixture, project, and included region;
- permits a rule exclusion only with a Linear issue link and rationale;
- attaches complete violation JSON on failure;
- reports rule, impact, and affected selectors concisely.

Initial HPA-226 scans cover:

- gallery with fixture cards;
- active gameplay;
- the current completion surface reached through `e2e-square-4`.

Setup, pause, and redesigned completion scans are added by their feature tickets. Axe does not
replace HPA-223 manual VoiceOver and desktop screen-reader QA.

The module also exports assertions for expected active element, focus movement, live-region
text when present, and dialog role/label/modal state.

## Diagnostics and Artifacts

An automatic fixture records:

- console errors and warnings;
- uncaught page errors;
- failed requests;
- unexpected response statuses;
- fixture-router matches and misses;
- API writes and outcomes.

Expected console or network failures are registered before the triggering action. Teardown
fails on an unexpected error, an expected error that never occurred, an unreleased deferred
route, or an unconsumed API expectation.

Configure Playwright with:

- `screenshot: 'on-first-failure'`;
- `trace: 'retain-on-failure-and-retries'`;
- one retry in CI and zero locally;
- `failOnFlakyTests: true` in CI;
- HTML and JSON reports in CI;
- a stable `test-results/` attachment directory.

Video remains off by default. Trace, DOM snapshots, screenshots, console output, and network
records are the primary debugging package.

## Representative Smoke Coverage

### 1. Known fixture load

- load `e2e-square-4` through the ordinary puzzle route;
- assert fixture metadata, board, four tray pieces, piece assets, and reference asset;
- assert no fixture request reaches production puzzle data.

### 2. Mouse rejection and completion

- attempt one wrong placement through the UI;
- verify observable rejection behavior;
- place all four pieces through `placeWithMouse`;
- verify the current completion UI;
- verify one completion request with deterministic run ID and result payload;
- advance deterministic time and verify no duplicate submission.

### 3. Keyboard placement

- load a fresh `e2e-square-4` run;
- select and place one piece through keyboard controls;
- verify focus, selected state, placement, and progress.

### 4. WebKit touch compatibility

- load `e2e-portrait-12` in `webkit-mobile`;
- complete one current direct-touch drag;
- verify placement and absence of unexpected browser errors.

This does not certify physical iOS gesture behavior.

### 5. Persistence seed, reload, and reset

- seed a valid active session with deterministic time and one placement;
- reload and verify tray order, placement, run ID, and elapsed time;
- reset before a fresh navigation;
- verify no progress is restored.

### 6. Deferred and retryable completion

- solve the small fixture while completion submission is deferred;
- verify the UI does not invent success before release;
- release a retryable failure;
- verify the current failure or retry affordance;
- retry and release success;
- verify request identity and idempotency.

HPA-224 updates completion-surface assertions when its redesigned report lands.

### 7. Large fixtures

For `e2e-square-100` and `e2e-square-225`:

- assert the expected rendered piece count;
- assert board dimensions and aspect-ratio invariants;
- assert unique piece and cell identities;
- perform one representative placement or selection;
- collect render and interaction duration as diagnostics.

HPA-226 does not set a universal performance threshold. Feature tickets consume the fixtures
and timing helper with an agreed operation, device, and budget.

### 8. Aspect ratios

Load square, landscape, and portrait fixtures in representative viewport classes and assert the
board remains visible, bounded, and usable without horizontal page overflow.

### Existing skipped tests

Replace infrastructure-owned skipped cases in `puzzle-solving.spec.ts`. A skip belonging to an
unimplemented feature is removed or linked in a comment to its owning Linear issue; it is not
left as an unbounded placeholder.

## CI and Local Commands

### Pull-request jobs

Split `.github/workflows/e2e-test.yml` into two jobs:

1. **Chromium smoke**
   - install Chromium;
   - run `@smoke` in `chromium-desktop` and `chromium-mobile`.

2. **WebKit critical**
   - install WebKit and dependencies;
   - run `@webkit-critical` in `webkit-mobile`.

Both upload `playwright-report/` and `test-results/` on failure or flaky classification.

### Extended jobs

On `main` and the scheduled workflow:

- run Chromium desktop, mobile, and tablet;
- run WebKit mobile and tablet;
- include `@extended`, `@large`, and `@a11y`;
- run a dedicated stability command with `--repeat-each=10 --retries=0 --workers=1`;
- run a second smoke pass with normal parallel workers.

The stability job exposes the first real failure rather than retrying until success.

### Exact package scripts

Add to `apps/web/package.json`:

```json
{
	"test:e2e:smoke": "playwright test --grep @smoke --project=chromium-desktop --project=chromium-mobile",
	"test:e2e:webkit": "playwright test --grep @webkit-critical --project=webkit-mobile",
	"test:e2e:extended": "playwright test --grep @extended",
	"test:e2e:ui": "playwright test --ui",
	"test:e2e:repeat": "playwright test --grep @smoke --repeat-each=10 --retries=0 --workers=1",
	"test:e2e:assert-production-boundary": "bun run scripts/assert-no-e2e-harness.ts",
	"test:install-browsers": "playwright install --with-deps chromium webkit"
}
```

The existing `test:e2e` remains the complete configured suite. CI commands call these scripts
rather than duplicating tag and project arguments in workflow YAML.

## Error Handling and Misuse Guards

Fail early for:

- missing fixture registration;
- unexpected fixture API request;
- exhausted run-ID or restart-order sequence;
- malformed seeded persistence;
- unexpected write request;
- unexpected console error or page exception;
- expected failure that never occurred;
- normal production output containing an E2E sentinel;
- unexplained arbitrary waits;
- deferred routes left unreleased at teardown.

Diagnostics name the fixture, project, URL, request, and expected scenario wherever applicable.

## Security Boundary

The E2E harness is safe only when all of the following hold:

- `PERSEUS_E2E_HARNESS=1` is consumed by Vite configuration at build time;
- the normal build resolves the physical no-op override module;
- the normal bundle passes the sentinel assertion;
- no API test route exists;
- no runtime user input enables the harness;
- configuration is validated and frozen before use;
- the harness controls dependencies, not arbitrary domain actions;
- browser tests target local build output, not production.

Documentation includes a threat analysis explaining why setting
`window.__PERSEUS_E2E_GAMEPLAY_V1__` on a normal page has no effect.

## Documentation

Add `apps/web/e2e/README.md` covering:

- fixture names and intended use;
- adding a fixture without duplicating geometry rules;
- extending `GameplayPage` from a feature ticket;
- registering expected API and console failures;
- seeding and resetting state;
- project and tag ownership;
- local commands matching CI;
- trace and HTML-report debugging;
- the Firefox decision;
- physical-device and screen-reader limitations;
- the production security boundary;
- the prohibition on arbitrary sleeps and direct domain bypass.

## Delivery Slices

1. **Playwright baseline** — projects, reporters, artifacts, scripts, browser installation, and
   split CI jobs.
2. **Fixture catalog** — typed builder, five fixtures, SVG assets, and fixture router.
3. **Runtime determinism** — dependency factory, alias-based E2E reader, validation, and
   production-bundle assertion.
4. **State and API controls** — reset, persistence seeding, auth personas, deferred responses,
   and failure scenarios.
5. **Gameplay driver** — mouse, keyboard, current tap/touch support, dialog base, and observable
   waits.
6. **Smoke coverage** — skipped-test resolution, small completion, persistence, failure,
   aspect-ratio, and large-fixture scenarios.
7. **Accessibility and documentation** — axe helper, focus/live-region support, E2E guide, and
   threat analysis.
8. **Stability verification** — repeated, serial, parallel, Chromium, and WebKit runs without
   hidden flakes or arbitrary sleeps.

## Acceptance-Criteria Mapping

| HPA-226 criterion | Design coverage |
| --- | --- |
| No production data or external images | Fixture router and generated SVG assets |
| All ratios plus small, 100, and 225 pieces | Five-fixture catalog |
| Deterministic full completion | 4-piece mouse completion smoke |
| Large fixtures without full solve | Large-layout representative interaction tests |
| Timer, randomness, storage, auth, and API control | Playwright clock, runtime seam, reset/seed, personas, API scenarios |
| Reusable cross-input helpers | `GameplayPage` mouse, keyboard, tap, and supported touch methods |
| Chromium and WebKit CI | Explicit projects and split PR jobs |
| Mobile, tablet, and desktop | 390 x 844, 768 x 1024, and 1440 x 900 projects |
| Accessibility and focus/live support | Axe and focus assertion helpers |
| Screenshots, traces, console and network evidence | Artifact config and automatic diagnostics fixture |
| Skipped gameplay tests resolved | Replacement or owning-ticket linkage rule |
| Commands and lifecycle documented | E2E README and exact package scripts |
| Stable repeated runs without sleeps | `failOnFlakyTests`, repeat pass, observable waits, sleep prohibition |

## Non-Goals

- implementing every HPA-215 feature scenario;
- solving 100- or 225-piece puzzles in CI;
- adding a production fixture or test-control service;
- maintaining duplicate Bun and Worker test routes;
- pixel-perfect animation or screenshot regression;
- production load testing;
- replacing unit and component tests;
- certifying physical iOS or Android gesture equivalence;
- certifying assistive technology through axe alone;
- setting feature performance budgets before the owning ticket defines an operation and
  reference device;
- adding Firefox solely for matrix symmetry.

## Risks and Mitigations

### E2E code leaks into production

Use the build-time alias, no-op production module, and production-bundle sentinel assertion.

### Route interception diverges from API contracts

Use shared request and response types, keep fixtures bounded, and retain API unit/integration
coverage. E2E interception validates the web contract, not storage-runtime implementation.

### Cross-browser drag behavior is flaky

Centralize mechanics in one driver, prefer observable outcomes, attach geometry and traces, and
use only the narrowest standards-shaped event fallback required by the current UI.

### Large fixture tests are slow

Generate metadata and assets programmatically, avoid full solves, tag large checks separately,
and keep the PR gate to representative assertions.

### Retries hide instability

Use `failOnFlakyTests` and run the stability pass with zero retries.

### Feature tickets bypass the foundation

Export one canonical extended test object and require feature E2E tests to consume the shared
fixture, router, and driver modules instead of adding independent mock stacks.

## References

- HPA-226: https://linear.app/cwchanap/issue/HPA-226/quality-build-deterministic-gameplay-fixture-and-e2e-test
- HPA-215: https://linear.app/cwchanap/issue/HPA-215/product-gameplay-first-ux-polish-for-perseus-puzzle-sessions
- Playwright fixtures: https://playwright.dev/docs/test-fixtures
- Playwright projects: https://playwright.dev/docs/test-projects
- Playwright clock: https://playwright.dev/docs/clock
- Playwright retries and flaky-test failure: https://playwright.dev/docs/test-retries
- Playwright accessibility testing: https://playwright.dev/docs/accessibility-testing
- `@axe-core/playwright`: https://github.com/dequelabs/axe-core-npm
