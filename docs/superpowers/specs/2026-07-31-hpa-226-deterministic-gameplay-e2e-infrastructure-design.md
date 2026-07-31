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
interaction drivers, browser projects, diagnostics, accessibility scan helper, and a small
representative smoke suite proving that the infrastructure works. It does not own every
feature scenario in the gameplay UX epic.

## Current Repository Baseline

The current web E2E setup is intentionally small:

- `apps/web/playwright.config.ts` starts the Bun API and the built web preview but defines no
  explicit browser projects, viewport matrix, retries, reporters, or failure-artifact policy.
- `.github/workflows/e2e-test.yml` installs only Chromium and runs one undifferentiated E2E job.
- Gallery and profile tests intercept selected HTTP requests directly in each test file.
- `apps/web/e2e/puzzle-solving.spec.ts` contains four skipped gameplay cases because no known
  puzzle fixture or reusable interaction harness exists.
- The puzzle route creates production browser dependencies directly: a browser run-ID factory,
  browser clock, random tray shuffle, and seeded rotation generation.

HPA-236 is complete. The extracted `PuzzleSession` engine already accepts a `Clock`,
`RunIdFactory`, initial tray order, restart tray-order factory, and rotation factory. HPA-226
will expose those existing injection points at the application boundary rather than creating a
second gameplay state model or bypassing domain actions.

## Fixed Design Decisions

The implementation must follow these decisions:

1. Fixture puzzle metadata, image responses, authentication responses, and API outcomes are
   owned by the Playwright harness.
2. The web application receives only a narrow, compile-time-gated E2E runtime configuration for
   values generated inside the browser: run IDs, tray ordering, and rotations.
3. Browser time is controlled through Playwright's clock support before navigation. The
   application does not gain a custom timer-control endpoint.
4. The harness does not expose `PuzzleSession.dispatch`, direct piece placement, direct
   completion sealing, or arbitrary persistence mutation to tests.
5. There are no `/api/test/*` routes and no test-only storage mutation endpoints in either the
   Bun or Cloudflare Worker API runtime.
6. Tests use visible UI, accessibility roles, stable test IDs, and observable network outcomes.
   Direct state seeding is limited to explicit fixture setup before application startup.
7. A normal production build must not contain the E2E runtime global, fixture catalog, fixture
   IDs, or test-control implementation.
8. Retries may collect richer diagnostics in CI, but `failOnFlakyTests` must make a retry-pass
   fail the job rather than hide instability.
9. Firefox is documented as deferred. Chromium supplies the core suite and WebKit supplies the
   critical Safari, responsive, focus, and touch-compatibility axis for this ticket.
10. Physical-device gesture and assistive-technology validation remains manual product QA;
    browser emulation is compatibility coverage, not a claim of device equivalence.

## Scope

### HPA-226 owns

- deterministic puzzle builders and fixture catalog;
- deterministic reference and piece assets served without external dependencies;
- secure E2E runtime dependency injection;
- fresh-state reset and explicit persisted-state seeding;
- anonymous and authenticated HTTP personas;
- controllable API success, deferred response, retryable failure, and terminal failure;
- reusable mouse, keyboard, tap, and supported touch-drag interaction drivers;
- browser and viewport projects;
- diagnostics and accessibility scan utilities;
- representative infrastructure smoke coverage;
- migration of existing skipped infrastructure-owned gameplay tests;
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
feature ticket adds the concrete helper methods and selectors when that surface lands.

## Architecture

The E2E system has four boundaries:

```text
Playwright test
    |
    +-- typed fixture catalog and API scenario router
    |
    +-- browser context setup
    |     +-- fresh storage/cookies
    |     +-- deterministic runtime global
    |     +-- Playwright clock
    |
    +-- player-facing GameplayPage driver
    |
    v
Built web application in E2E mode
    |
    +-- normal puzzle source service -> intercepted fixture HTTP responses
    |
    +-- normal PuzzleSession actions and persistence
    |
    +-- narrow E2E runtime reader -> injected run IDs/tray order/rotations
```

The fixture catalog and API scenario router live only under `apps/web/e2e/`. The web runtime
seam lives under `apps/web/src/lib/services/gameplay/` or a focused `testing/` subdirectory but
is activated only in a dedicated E2E build.

## Deterministic Fixture Catalog

### Fixture set

The first catalog contains five puzzles:

| Fixture | Ratio | Grid | Pieces | Primary purpose |
| --- | --- | ---: | ---: | --- |
| `e2e-square-4` | 1:1 | 2 x 2 | 4 | Full completion, persistence, error, and input smoke flows |
| `e2e-landscape-12` | 4:3 | 4 x 3 | 12 | Landscape responsive and reference coverage |
| `e2e-portrait-12` | 3:4 | 3 x 4 | 12 | Portrait responsive and mobile coverage |
| `e2e-square-100` | 1:1 | 10 x 10 | 100 | Layout, inventory, focus, interaction, and diagnostic support |
| `e2e-square-225` | 1:1 | 15 x 15 | 225 | Large-layout and interaction support without full solve loops |

The small 4-piece puzzle is the only fixture solved completely by the infrastructure smoke
suite. Large fixtures prove renderability and representative interactions; CI never places
all 100 or 225 pieces.

### Fixture builder

Create a typed pure builder that accepts:

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
and edge helpers from `@perseus/types`. It must validate:

- `rows * cols === pieceCount`;
- every piece ID is unique;
- every correct coordinate is in bounds and unique;
- outside edges are flat;
- adjacent edges are complementary;
- tray order is a complete permutation;
- rotations contain exactly the supported values;
- declared image dimensions match the intended aspect ratio.

Fixture construction fails immediately during test import when a catalog definition violates
an invariant. Tests must not discover malformed fixture data only after opening the browser.

### Deterministic assets

Do not check in hundreds of generated PNG files. The fixture router serves small deterministic
SVG responses for:

- every piece-image URL;
- every reference-image URL;
- optional gallery thumbnail URLs when feature tests need them.

Each asset includes its fixture and piece identity visually, uses fixed dimensions, and has no
network dependency. The content is stable across machines and browser projects. Asset fidelity
is sufficient to exercise image loading, layout, transparency-independent sizing, and reference
rendering; pixel-perfect jigsaw masking remains outside HPA-226.

### API routing

Fixture IDs use the ordinary API puzzle path rather than Quick Puzzle storage. Playwright
intercepts the existing routes, including:

- puzzle detail;
- piece image;
- reference image;
- gallery list when a test starts from the gallery;
- authenticated session and profile endpoints as needed;
- completion submission.

Requests for an unregistered `e2e-*` fixture fail the test with a diagnostic instead of falling
through to the real Bun server. Non-fixture requests may continue to the local API for existing
non-gameplay E2E coverage.

## E2E Runtime Dependency Seam

### Production dependency factory

Extract route-level construction of runtime-generated gameplay dependencies into one focused
factory. The production result contains:

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
- rotations retain the existing deterministic puzzle-derived seed behavior.

The route constructs the `PuzzleSession` exclusively through this dependency object. This
removes direct random generation from the route and gives HPA-226 one explicit integration
boundary.

### E2E configuration contract

A Playwright init script installs a frozen configuration before any application script runs.
A representative contract is:

```ts
interface PerseusE2ERuntimeConfigV1 {
	version: 1;
	fixtureId: string;
	runIds: string[];
	initialTrayOrder: number[];
	restartTrayOrders: number[][];
	rotations: Record<number, Rotation>;
}
```

The exact global name is implementation detail, but it must be unique, versioned, and defined
in one module. The E2E runtime validates all data before exposing dependencies. Exhausting the
run-ID or restart-order sequence is a test failure with a clear message; it never falls back to
production randomness.

### Build gating

Use an explicit build-time public environment value such as `PUBLIC_E2E_HARNESS=1` only in the
Playwright web-server build command. A normal production build treats the harness as disabled.

The implementation must include automated proof that the production output does not contain:

- the runtime global name;
- `e2e-square-4` or another fixture sentinel;
- E2E validation error messages;
- fixture data or asset generators.

A disabled harness ignores any similarly named browser global. Production behavior cannot be
enabled by a query parameter, cookie, request header, local-storage key, or runtime-only value.

### Clock control

The route continues using its existing browser `Clock` implementation based on `performance`,
`Date`, and interval functions. Playwright installs its clock before navigation and advances
browser time through the supported test API.

Tests may:

- freeze the initial wall-clock time;
- advance active gameplay time;
- verify pause or hidden-time exclusion when feature scenarios exist;
- release timer-driven UI without `waitForTimeout`.

The E2E runtime does not expose a separate clock or timer mutation method.

## Storage, Authentication, and API Scenarios

### Isolation and reset

Every test gets a fresh Playwright browser context. An automatic fixture additionally clears
before application startup:

- cookies;
- `localStorage`;
- `sessionStorage`;
- IndexedDB databases, if any are introduced or detected;
- Cache Storage entries, if any are introduced or detected.

The reset helper accepts an explicit preservation option only when a test is validating reload
or resume behavior inside the same test. Tests never depend on cleanup performed by a previous
test.

### Persisted-state seeding

Provide typed seed helpers for supported application records:

- a versioned `PersistedPuzzleSessionV1` snapshot;
- local statistics for a fixture puzzle;
- Quick Puzzle records only when a Quick Puzzle test explicitly needs them;
- feature-owned device preferences once their schemas exist.

Seed data is serialized through shared production codecs or validated builders wherever
possible. A test must not duplicate raw storage-key formats unless it is specifically testing a
migration or malformed-record path.

Seeding happens before application startup. After navigation, tests interact through the UI.

### Authentication personas

The default persona is anonymous. A typed router can switch to:

- anonymous;
- authenticated player with deterministic identity;
- session endpoint delay;
- session endpoint failure.

Authentication simulation occurs through the existing HTTP contract. Tests do not inject the
Svelte authentication store directly and do not create real OAuth sessions.

### Controllable API outcomes

Create an `ApiScenario` helper for completion and other feature-owned HTTP effects. Supported
response modes are:

- immediate success;
- deferred response with a test-owned `release()` operation;
- retryable network abort;
- retryable HTTP 500;
- unauthorized HTTP 401;
- quota HTTP 429;
- conflict HTTP 409;
- not-found HTTP 404;
- validation HTTP 400.

A deferred response uses a promise controlled by the test and is released by a named helper.
Arbitrary sleep is not used to create races.

The router records request method, URL, body, and response outcome for diagnostics and
assertions. Unexpected writes fail the test unless explicitly allowed.

## Playwright Fixture Layer

Define one project-local `test` export using `test.extend`. Proposed modules:

```text
apps/web/e2e/
  fixtures/
    catalog.ts
    builder.ts
    assets.ts
    api-scenario.ts
    auth-persona.ts
    persisted-state.ts
  support/
    test.ts
    diagnostics.ts
    accessibility.ts
    gameplay-page.ts
  specs/
    gameplay-infrastructure.spec.ts
    gameplay-large-fixtures.spec.ts
```

Existing files may be migrated incrementally; HPA-226 does not need to reorganize unrelated
E2E suites solely for naming consistency.

The extended test provides:

- `fixtureCatalog`;
- `fixtureRouter`;
- `apiScenario`;
- `authPersona`;
- `persistedState`;
- `gameplayPage`;
- `scanAccessibility`;
- automatic console and network diagnostics.

Fixture responsibilities are narrow and composable. A test that does not request gameplay
fixtures does not pay their setup cost.

## Gameplay Interaction Driver

`GameplayPage` wraps locators and player-facing interactions. It does not contain domain-state
mutation methods.

### Stable selectors

Use existing test surfaces where available:

- puzzle pieces by `data-testid="puzzle-piece"` and `data-piece-id`;
- board cells by `data-testid="drop-zone"`, `data-x`, and `data-y`;
- board by `data-testid="puzzle-board"`;
- accessible role and name for dialogs and controls.

Add new test IDs only when role/name is unstable or a coordinate/identity is not otherwise
observable. Test IDs describe semantic test surfaces and must not mirror internal component
structure.

### Mouse placement

`placeWithMouse(pieceId, x, y)`:

1. finds the unplaced piece;
2. finds the target drop zone;
3. performs the browser drag interaction;
4. waits for observable placement state;
5. reports source and target bounding boxes on failure.

The helper may dispatch standards-compatible drag events only when Playwright's normal drag
operation cannot drive the existing HTML drag-and-drop path consistently across supported
engines. It still targets the rendered UI and its event handlers; it never calls the session
engine.

### Keyboard placement

`selectAndPlaceWithKeyboard(pieceId, x, y)`:

1. focuses the piece;
2. selects it with Enter or Space;
3. verifies the selected state through ARIA or the existing data attribute;
4. focuses the target cell;
5. places with Enter or Space;
6. verifies placement and selection cleanup.

Additional navigation methods introduced by HPA-223 extend this driver rather than replacing
it.

### Tap and touch

Provide a basic `tapPiece(pieceId)` helper using Playwright pointer/touch input where the current
UI supports it.

Provide `dragWithTouch(pieceId, x, y)` only for the current direct-touch path. It may use a
small standards-shaped touch-event adapter because Playwright's high-level touchscreen API does
not provide a complete multi-step drag abstraction. The adapter drives the rendered element,
window listeners, hit testing, and drop handlers used by players.

HPA-219 owns tap-to-place selection semantics, bottom-sheet scrolling, safe-area behavior,
and two-finger board pan helpers. HPA-226 supplies the module and extension conventions.

### Dialog helpers

HPA-226 implements helpers only for dialog surfaces present when the ticket is delivered. It
provides the pattern and base methods for:

- waiting for a dialog by role and accessible name;
- asserting initial focus and focus containment;
- activating visible dialog actions;
- dismissing with an allowed keyboard or pointer path.

HPA-221 and HPA-224 add concrete setup, pause, restart, and completion-report methods when their
new UIs land.

### Observable state and waits

Tests wait on:

- web-first locator assertions;
- URL transitions;
- visible progress and placed-piece output;
- dialog state;
- request or response completion;
- `expect.poll` for recorded diagnostics or request counts.

`page.waitForTimeout` is prohibited unless the call has an inline explanation naming the
browser behavior that has no observable signal. The code review checklist treats unexplained
sleep as a defect.

## Browser and Viewport Matrix

### Projects

Define explicit Playwright projects:

| Project | Engine | Viewport | Suite purpose |
| --- | --- | --- | --- |
| `chromium-desktop` | Chromium | 1440 x 900 | Primary core and desktop smoke coverage |
| `chromium-mobile` | Chromium | 390 x 844 | Primary responsive and tap coverage |
| `chromium-tablet` | Chromium | 768 x 1024 | Extended tablet layout coverage |
| `webkit-mobile` | WebKit | 390 x 844 | Critical Safari touch, focus, and responsive compatibility |
| `webkit-tablet` | WebKit | 768 x 1024 | Extended Safari tablet compatibility |

Browser context options include touch capability and mobile emulation only where appropriate.
The viewport is explicit rather than inherited from a named device whose dimensions may change
with Playwright updates.

### Test tags

Use bounded tags:

- `@smoke` for fast pull-request coverage;
- `@webkit-critical` for the minimal WebKit gate;
- `@extended` for main-branch or scheduled coverage;
- `@large` for 100- and 225-piece fixture checks;
- `@a11y` for automated accessibility scans.

Feature tags may be added by owning tickets, but browser-project logic must not depend on a
large, undocumented tag vocabulary.

### Firefox decision

Firefox is not a required HPA-226 project. The repository currently has no Firefox-specific
product requirement or defect signal, while WebKit directly covers the Safari/mobile risk
called out by HPA-215. Document the install and project extension point so Firefox can be added
as a scheduled compatibility job later without redesigning fixtures or helpers.

## Accessibility Support

Add `@axe-core/playwright` and expose one scan helper that:

- runs against a named stable surface;
- records the scanned URL, fixture, browser project, and included region;
- supports narrowly scoped rule exclusions with a required issue link and rationale;
- attaches the complete violation JSON on failure;
- produces a concise assertion message with rule, impact, and affected selectors.

Initial HPA-226 scans cover currently available surfaces:

- gallery with fixture cards;
- active gameplay;
- the existing completion surface reached by solving `e2e-square-4`.

Setup, pause, and redesigned completion scans are added by their owning feature tickets. Axe
coverage does not replace HPA-223 manual VoiceOver and desktop screen-reader QA.

The helper also provides reusable assertions for:

- expected active element;
- focus movement;
- live-region text when such regions exist;
- dialog role, label, and modal state.

## Diagnostics

### Automatic collection

An automatic fixture records:

- browser console errors and warnings;
- uncaught page errors;
- failed requests;
- unexpected response statuses;
- fixture-router matches and misses;
- API write requests and outcomes.

Expected console or network failures must be registered before the action that triggers them.
At teardown, any unconsumed expectation or unexpected error fails the test.

### Playwright artifacts

Configure:

- screenshot on first failure;
- trace retained for failures and retries;
- HTML report;
- machine-readable JSON or blob report for CI aggregation;
- a test-results directory containing diagnostics attachments.

CI uses one retry for diagnostic reproduction and sets `failOnFlakyTests: true`, so a passing
retry remains a failed build and must be investigated.

Video remains off by default because trace, DOM snapshots, screenshots, console output, and
network records provide the primary debugging package. A developer may enable video locally or
for a targeted investigation.

## Representative Infrastructure Smoke Suite

The HPA-226 suite proves the foundation with these scenarios:

### 1. Known fixture load

- load `e2e-square-4` through the ordinary puzzle route;
- assert fixture metadata, board, four tray pieces, piece assets, and reference asset;
- assert no request reaches production puzzle data.

### 2. Mouse rejection and completion

- attempt one wrong placement through the UI;
- verify observable rejection behavior;
- place all four pieces with the mouse helper;
- verify completion UI;
- verify one completion request with the deterministic run ID and result payload;
- verify no duplicate request after a short deterministic clock advance.

### 3. Keyboard placement

- load a fresh `e2e-square-4` run;
- select one piece and place it through keyboard controls;
- verify focus, selected state, placement, and progress.

### 4. WebKit touch compatibility

- load `e2e-portrait-12` in `webkit-mobile`;
- complete one supported direct-touch drag;
- verify placement and absence of unexpected browser errors.

This is browser-emulated compatibility coverage, not physical iOS gesture certification.

### 5. Persistence seed, reload, and reset

- seed a valid active session with deterministic elapsed time and one placement;
- reload and verify restored tray order, placement, run ID, and time;
- invoke the explicit reset helper before a fresh navigation;
- verify no progress is restored.

### 6. Deferred and retryable completion outcome

- solve the small fixture while completion submission is deferred;
- verify the UI does not invent success before the response;
- release a retryable failure;
- verify the existing failure or retry affordance available at delivery time;
- retry and release success;
- verify request identity and idempotency.

The exact UI assertions follow the current completion surface and are updated by HPA-224 when
that surface changes.

### 7. Large fixture layout and representative interaction

For `e2e-square-100` and `e2e-square-225`:

- assert the expected number of rendered unplaced pieces;
- assert board dimensions and aspect-ratio invariants;
- assert no duplicate piece or cell identities;
- perform one representative placement or selection;
- collect render and interaction durations as diagnostics.

HPA-226 does not set a fragile universal performance threshold. A feature ticket may consume
the fixtures and timing helper with its own agreed device, operation, and budget.

### 8. Aspect-ratio coverage

Load square, landscape, and portrait fixtures in their representative viewport classes and
assert that the board remains visible, bounded, and usable without horizontal page overflow.

### Existing skipped tests

Replace infrastructure-owned skipped cases in `puzzle-solving.spec.ts` with the new smoke
coverage. A skipped test that belongs to an unimplemented feature is removed or linked in a
comment to its owning Linear issue; it is not left as an unbounded placeholder.

## CI Design

### Pull-request jobs

Split the current E2E workflow into independent jobs:

1. **Chromium smoke**
   - installs Chromium;
   - runs `@smoke` in `chromium-desktop` and `chromium-mobile`;
   - targets a short feedback loop.

2. **WebKit critical**
   - installs WebKit and required system dependencies;
   - runs `@webkit-critical` in `webkit-mobile`;
   - isolates Safari-specific failures from the primary suite.

Both jobs upload Playwright reports and test results when failed or flaky. Both use the same
E2E build command and fixture catalog.

### Extended jobs

On `main` and a scheduled workflow:

- run Chromium desktop, mobile, and tablet projects;
- run WebKit mobile and tablet projects;
- include `@extended`, `@large`, and `@a11y`;
- use `--repeat-each` with zero retries in a dedicated stability pass;
- exercise multiple worker counts or randomized file order when practical.

The scheduled stability job must expose a real failure rather than repeatedly retry until
success.

### Local commands

Add documented scripts resembling:

```text
bun run --cwd apps/web test:e2e:smoke
bun run --cwd apps/web test:e2e:webkit
bun run --cwd apps/web test:e2e:extended
bun run --cwd apps/web test:e2e:ui
bun run --cwd apps/web test:e2e:repeat
bun run --cwd apps/web test:install-browsers
```

Exact names may follow repository script conventions, but developers must be able to run each
CI class locally without reconstructing arguments from workflow YAML.

## Error Handling and Misuse Guards

The harness fails early for:

- missing fixture registration;
- an unexpected fixture API request;
- an exhausted run-ID or restart-order sequence;
- malformed seeded persistence;
- an unexpected write request;
- an unexpected console error or page exception;
- an expected failure that never occurred;
- a production build containing an E2E sentinel;
- an unexplained arbitrary wait;
- a fixture that leaves deferred routes unreleased at teardown.

Diagnostics name the fixture, browser project, URL, request, and expected scenario wherever
applicable.

## Security Boundary

The E2E harness is safe only when all of the following hold:

- activation is compile-time gated by the dedicated E2E web build;
- the production build omits the reader and configuration contract;
- no API test route is added;
- no query parameter or runtime user input enables the harness;
- configuration is validated and frozen before use;
- the harness controls dependency values, not arbitrary domain actions;
- browser tests run against local build output, not a deployed production URL.

Documentation must include a short threat analysis explaining why setting the E2E global in a
normal production page has no effect.

## Documentation

Add an E2E guide covering:

- fixture names and intended use;
- how to add a fixture without duplicating geometry rules;
- how to extend `GameplayPage` from a feature ticket;
- how to register expected API and console failures;
- how to seed and reset state;
- browser-project and tag ownership;
- local commands matching CI;
- trace and HTML-report debugging;
- the Firefox decision;
- physical-device and screen-reader limitations;
- the production security boundary;
- the rule against arbitrary sleeps and direct domain bypass.

## Delivery Slices

The implementation should be planned in these slices:

1. **Playwright baseline** — projects, reporters, artifacts, scripts, browser installation, and
   split CI jobs.
2. **Fixture catalog** — typed builder, five fixtures, deterministic assets, and fixture router.
3. **Runtime determinism** — route dependency factory, E2E configuration reader, validation,
   and production-bundle exclusion checks.
4. **State and API controls** — reset, persistence seeding, authentication personas, deferred
   responses, and failure scenarios.
5. **Gameplay driver** — mouse, keyboard, current tap/touch support, dialog base, and observable
   waits.
6. **Smoke coverage** — enable or replace skipped tests, small completion, persistence, failure,
   aspect-ratio, and large-fixture scenarios.
7. **Accessibility and documentation** — axe helper, focus/live-region support, guide, and
   security documentation.
8. **Stability verification** — repeated, parallel, Chromium, and WebKit runs without hidden
   flakes or arbitrary sleeps.

## Acceptance-Criteria Mapping

| HPA-226 criterion | Design coverage |
| --- | --- |
| No production data or external images | Playwright fixture router and generated SVG assets |
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
| Commands and lifecycle documented | E2E guide and matching local scripts |
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
- certifying VoiceOver, NVDA, JAWS, or other assistive technology through axe alone;
- setting feature performance budgets before the owning ticket defines an operation and
  reference device;
- adding Firefox solely for matrix symmetry.

## Risks and Mitigations

### The E2E seam leaks into production

Mitigate with compile-time gating, a disabled-by-default production factory, and a bundle
sentinel test.

### Route interception diverges from API contracts

Use shared request and response types, keep fixtures bounded, and retain API unit or integration
coverage for server behavior. E2E interception validates the web contract, not storage-runtime
implementation.

### Cross-browser drag behavior becomes flaky

Centralize interaction mechanics in one driver, prefer observable outcomes, attach bounding
boxes and traces, and use the narrowest standards-shaped event fallback required by the current
UI.

### Large fixture tests become slow

Generate metadata and assets programmatically, avoid full solves, tag large checks separately,
and keep the pull-request gate to representative assertions.

### Retries hide instability

Enable `failOnFlakyTests` in CI and run the scheduled repeat pass with zero retries.

### Feature tickets bypass the infrastructure

Document ownership, export one canonical extended test object, and require feature E2E tests to
consume the shared fixture/router/driver modules instead of adding independent mock stacks.

## References

- HPA-226: https://linear.app/cwchanap/issue/HPA-226/quality-build-deterministic-gameplay-fixture-and-e2e-test
- HPA-215: https://linear.app/cwchanap/issue/HPA-215/product-gameplay-first-ux-polish-for-perseus-puzzle-sessions
- Playwright fixtures: https://playwright.dev/docs/test-fixtures
- Playwright projects: https://playwright.dev/docs/test-projects
- Playwright clock: https://playwright.dev/docs/clock
- Playwright retries and flaky-test failure: https://playwright.dev/docs/test-retries
- Playwright accessibility testing: https://playwright.dev/docs/accessibility-testing
- `@axe-core/playwright`: https://github.com/dequelabs/axe-core-npm
