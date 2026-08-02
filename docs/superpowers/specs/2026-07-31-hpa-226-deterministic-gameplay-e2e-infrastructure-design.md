# Deterministic Gameplay Fixture and E2E Infrastructure Design

- **Issue:** HPA-226
- **Parent:** HPA-215
- **Date:** 2026-07-31
- **Status:** Review-ready design

## Objective

Build a deterministic Playwright foundation for Perseus gameplay so each HPA-215 feature
workstream can add reliable end-to-end coverage without depending on production puzzle data,
mutable server state, external image assets, real OAuth, uncontrolled time, or random tray and
rotation generation.

HPA-226 owns the reusable fixture catalog, narrow application test seam, Playwright fixtures,
player-facing interaction driver, browser projects, diagnostics, accessibility scan helper, and
representative smoke coverage proving that the infrastructure works. It does not own every
feature scenario in the gameplay UX epic.

This document is the single implementation source of truth. It incorporates all design-review
resolutions and supersedes earlier drafts and the removed review addendum.

> **Pinned-version note:** This design targets Playwright 1.57.0. Its `--only-shell` option is
> defined as replacing Chromium with `chromium-headless-shell` when Chromium is requested; it
> does not replace or suppress an accompanying WebKit installation. The implementation verifies
> this exact resolution with `playwright install --dry-run --only-shell chromium webkit`.

## Current Repository Baseline

The current web E2E setup is intentionally small:

- `apps/web/playwright.config.ts` starts the Bun API and built web preview but defines no explicit
  browser projects, viewport matrix, retries, reporters, or failure-artifact policy.
- `.github/workflows/e2e-test.yml` installs only Chromium and runs one undifferentiated E2E job.
- Gallery and profile tests intercept selected HTTP requests independently in each test file.
- `apps/web/e2e/puzzle-solving.spec.ts` contains four skipped gameplay cases because no known
  puzzle fixture or reusable interaction harness exists.
- `apps/web/e2e/fixtures/test-image.jpg` already exists as the Quick Puzzle upload asset.
- The puzzle route constructs a browser run-ID factory, browser clock, random tray shuffle, and
  puzzle-derived rotations directly.

HPA-236 is complete. The extracted `PuzzleSession` engine already accepts a `Clock`,
`RunIdFactory`, initial tray order, restart tray-order factory, and rotation factory. HPA-226
exposes those existing injection points at the route boundary rather than creating a second
state model or bypassing domain actions.

## Fixed Design Decisions

1. Fixture puzzle metadata, image responses, authentication responses, and API outcomes are
   owned by the Playwright harness.
2. The web application receives only a narrow, build-time-gated E2E runtime configuration for
   values generated inside the browser: run IDs, tray ordering, and rotations.
3. Browser time is controlled through Playwright's installed clock before navigation. The
   application does not gain a timer-control endpoint.
4. The harness does not expose `PuzzleSession.dispatch`, direct piece placement, direct
   completion sealing, or arbitrary post-startup persistence mutation.
5. There are no `/api/test/*` routes and no test-only storage mutation endpoints in either the
   Bun or Cloudflare Worker API runtime.
6. Tests use visible UI, accessibility roles, stable test IDs, and observable network outcomes.
   Direct state seeding is limited to explicit setup before application startup.
7. A normal production build contains neither the E2E configuration reader nor fixture data.
8. The shared E2E preview continues to run existing non-gameplay and Quick Puzzle tests without
   requiring deterministic gameplay configuration.
9. CI may retry once for diagnostics, but `failOnFlakyTests` makes a retry-pass fail the job.
10. Firefox is deferred. Chromium supplies the core suite and WebKit supplies the critical
    Safari, responsive, focus, keyboard, and supported touch compatibility axis.
11. Browser emulation is compatibility coverage, not physical-device or assistive-technology
    certification.
12. The implementation targets the repository's pinned Playwright 1.57.0 contracts. Configuration
    literals or CLI behavior from later Playwright releases are not assumed.

## Ownership

### HPA-226 owns

- deterministic puzzle builder and fixture catalog;
- deterministic reference and piece assets served without external dependencies;
- secure E2E runtime dependency injection;
- fresh-state reset and explicit persisted-state seeding;
- anonymous and authenticated HTTP personas;
- controllable API success, delay, retryable failure, and terminal failure;
- reusable mouse, keyboard, tap, and supported touch-drag interaction methods;
- browser and viewport projects;
- diagnostics and accessibility scan utilities;
- representative infrastructure smoke coverage;
- resolution or explicit ownership linkage for existing skipped gameplay tests;
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

HPA-226 establishes extension points for helpers whose UI does not yet exist. The owning feature
ticket adds concrete methods and selectors when that surface lands.

## Architecture

```text
Playwright test
    |
    +-- typed gameplay fixture catalog and API scenario router
    |
    +-- GameplayPage.gotoFixture(...)
    |     +-- reset or seed browser state
    |     +-- register fixture and API routes
    |     +-- install and freeze fixture runtime config
    |     +-- install Playwright clock when requested
    |     +-- navigate only after setup is complete
    |
    +-- player-facing interaction methods
    |
    v
Shared built web application in E2E mode
    |
    +-- ordinary puzzle source service -> intercepted fixture HTTP responses
    |
    +-- ordinary PuzzleSession actions and local persistence
    |
    +-- route runtime adapter
          +-- virtual build module
                +-- E2E reader in harness build
                +-- no-op implementation in normal build
          +-- deterministic override for configured e2e-* fixture
          +-- production dependencies for ordinary and Quick Puzzles
```

The gameplay fixture catalog and API scenario router live only under
`apps/web/e2e/gameplay-fixtures/`. The existing `apps/web/e2e/fixtures/test-image.jpg` remains
unchanged for Quick Puzzle upload coverage; typed gameplay catalog code is kept separate from
binary upload assets.

## Deterministic Fixture Catalog

### Initial fixtures

Five deterministic fixtures span the three supported aspect ratios, including dedicated
4-piece completion, 100-piece layout, and 225-piece large-layout cases.

The grid column below is explicitly **rows × columns**.

| Fixture            | Ratio | Grid (rows × columns) | Pieces | Primary purpose                                               |
| ------------------ | ----- | --------------------: | -----: | ------------------------------------------------------------- |
| `e2e-square-4`     | 1:1   |                 2 × 2 |      4 | Full completion, persistence, error, and input smoke flows    |
| `e2e-landscape-12` | 4:3   |                 3 × 4 |     12 | Landscape responsive and reference coverage                   |
| `e2e-portrait-12`  | 3:4   |                 4 × 3 |     12 | Portrait responsive and mobile coverage                       |
| `e2e-square-100`   | 1:1   |               10 × 10 |    100 | Layout, inventory, focus, interaction, and diagnostic support |
| `e2e-square-225`   | 1:1   |               15 × 15 |    225 | Large-layout support without full solve loops                 |

The 4-piece fixture is the only puzzle solved completely by the infrastructure smoke suite.
Large fixtures prove renderability and representative interactions; CI never places all 100 or
225 pieces.

### Fixture builder

`apps/web/e2e/gameplay-fixtures/builder.ts` defines a pure typed builder accepting:

- fixture ID and display name;
- aspect ratio;
- piece count;
- image width and height;
- creation timestamp;
- reference-image availability;
- canonical tray order;
- canonical rotation map;
- deterministic run-ID sequence.

Rows and columns are derived from the shared production contract, not supplied as an unchecked
orientation:

```ts
const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, aspectRatio);

if (rows <= 0 || cols <= 0 || rows * cols !== pieceCount) {
	throw new Error('Invalid fixture aspect-ratio and piece-count combination');
}
```

If a fixture definition also records expected dimensions for readability, the builder requires
exact equality with `getGridDimensionsForAspectRatio`; validating only `rows * cols` is
insufficient because it would admit transposed 4:3 and 3:4 grids.

Piece IDs are **zero-based**, matching production generation:

```ts
const id = row * cols + col;
```

For a 2 × 2 fixture, valid IDs are `0`, `1`, `2`, and `3`.

The builder reuses shared grid and edge helpers from `@perseus/types` so complementary edges are
correct by construction. It validates:

- the exact shared rows and columns for the ratio/count pair;
- `rows * cols === pieceCount`;
- unique zero-based piece IDs;
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
  test-image.jpg                 # existing Quick Puzzle upload fixture

apps/web/e2e/gameplay-fixtures/
  builder.ts
  catalog.ts
  assets.ts
  fixture-router.ts
  api-scenario.ts
  auth-persona.ts
  persisted-state.ts
```

`catalog.ts` exports immutable definitions. Tests request fixtures by a bounded fixture-ID type
rather than constructing ad hoc puzzle payloads.

### Deterministic assets

`assets.ts` generates deterministic SVG responses for every piece and reference image. Do not
check in hundreds of PNG files.

Generated piece SVGs include viewBox dimensions and transparent padding compatible with the
current `EXPANSION_FACTOR` and `TAB_RATIO` overflow model. Tests may assert loading, placement,
and layout behavior, but they do not infer pixel-perfect tab geometry from synthetic assets.

### Fixture IDs and HTTP routing

Fixture IDs deliberately use the `e2e-*` namespace and are not UUIDv4 values. They are harness
identifiers, not production puzzle IDs, and they cannot collide with the `q-*` Quick Puzzle
namespace.

Playwright intercepts existing routes for:

- puzzle detail;
- piece image;
- reference image;
- gallery list when a test starts from the gallery;
- authenticated session and profile responses when required;
- completion submission.

Every request containing an `e2e-*` fixture ID is intercepted. An unregistered or
non-intercepted `e2e-*` request is a hard harness failure before the request reaches a backend.
The suite does not rely on backend fallback behavior: the Bun filesystem runtime and production
Worker runtime do not enforce identical invalid-ID paths, so a missed interception could surface
as different 4xx/5xx behavior depending on runtime. Total interception keeps the fixture contract
runtime-independent.

Non-fixture requests continue to the local Bun API for existing unrelated E2E coverage.

## Runtime Dependency Seam

### Route-level adapter

Create `apps/web/src/lib/services/gameplay/runtime.ts`:

```ts
interface GameplayRuntimeDependencies {
	runIdFactory: RunIdFactory;
	createInitialTrayOrder(pieceIds: readonly number[]): number[];
	createRestartTrayOrder(pieceIds: readonly number[]): number[];
	createRotations(puzzleId: string, pieceIds: readonly number[]): Record<number, Rotation>;
}
```

This is a route-level adapter, not a one-for-one mirror of `CreatePuzzleSessionOptions`. The
route maps it explicitly:

```ts
const pieceIds = loadedPuzzle.pieces.map((piece) => piece.id);
const runtime = createGameplayRuntimeDependencies(loadedPuzzle.id, pieceIds);

const store = createPuzzleSessionStore({
	metadata,
	runIdFactory: runtime.runIdFactory,
	clock,
	initialTrayOrder: runtime.createInitialTrayOrder(pieceIds),
	createTrayOrder: () => runtime.createRestartTrayOrder(pieceIds),
	createRotations: (requestedPieceIds) =>
		runtime.createRotations(loadedPuzzle.id, requestedPieceIds)
});
```

The signature differences are intentional:

- the engine receives `initialTrayOrder` as a value; the route computes it once after loading;
- the engine receives a zero-argument `createTrayOrder`; the route closes over canonical IDs;
- the engine passes only requested piece IDs to `createRotations`; the route closes over the
  loaded puzzle ID so production retains its current puzzle-derived seed.

Production behavior remains unchanged:

- run IDs use the existing browser UUID factory;
- initial and restart tray orders use the existing shuffle behavior;
- rotations retain the current puzzle-derived seed behavior.

### Build-time virtual module

Use an exact virtual module ID instead of relying on ordering between a user alias and
SvelteKit's `$lib` alias:

```ts
const runtimeOverrideId = 'virtual:perseus-gameplay-runtime-override';
const resolvedRuntimeOverrideId = `\0${runtimeOverrideId}`;
```

`apps/web/vite.config.ts` includes a small `enforce: 'pre'` plugin on every Vite/Vitest run:

```ts
function gameplayRuntimeOverridePlugin(): Plugin {
	const harnessEnabled = process.env.PERSEUS_E2E_HARNESS === '1';
	const readerPath = normalizePath(
		fileURLToPath(new URL('./src/lib/testing/e2e-gameplay-runtime.ts', import.meta.url))
	);

	return {
		name: 'perseus-gameplay-runtime-override',
		enforce: 'pre',
		resolveId(id) {
			return id === runtimeOverrideId ? resolvedRuntimeOverrideId : null;
		},
		load(id) {
			if (id !== resolvedRuntimeOverrideId) return null;
			if (harnessEnabled) {
				return `export { readGameplayRuntimeOverride } from ${JSON.stringify(readerPath)};`;
			}
			return `export function readGameplayRuntimeOverride() { return null; }`;
		}
	};
}
```

`runtime.ts` is the only production module allowed to import
`virtual:perseus-gameplay-runtime-override`. Add a TypeScript declaration for the virtual module
and ESLint restrictions that:

- prohibit direct imports of `$lib/testing/e2e-gameplay-runtime` from production source;
- prohibit relative or alias-based `runtime-override` imports;
- allow the virtual-module import only in `runtime.ts` through a narrow file override.

This prevents a relative import from bypassing the build seam and silently falling back to
production randomness.

### Vitest behavior

`apps/web/vite.config.ts` also configures browser-mode Vitest. The virtual plugin therefore
applies there as follows:

- ordinary unit/component tests run with `PERSEUS_E2E_HARNESS` unset and receive the no-op module;
- E2E-reader validation tests import the concrete reader directly from the testing directory;
- only the Playwright preview build sets `PERSEUS_E2E_HARNESS=1`;
- no global environment mutation in one test process may switch the already-created Vite config
  from production to harness mode.

### Shared-preview activation semantics

The E2E reader distinguishes configured fixture tests from ordinary suite traffic:

| Runtime state                            | Loaded puzzle                      | Result                                            |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| Global absent                            | Ordinary API or `q-*` Quick Puzzle | Return `null`; use production dependencies        |
| Global absent                            | `e2e-*` fixture                    | Throw a deterministic missing-configuration error |
| Global present and valid                 | Matching `e2e-*` fixture           | Return deterministic dependencies                 |
| Global present but malformed             | Any puzzle                         | Throw a deterministic validation error            |
| Global present but fixture ID mismatches | Any puzzle                         | Throw a deterministic fixture-mismatch error      |

This preserves one shared preview build for the full Playwright suite. Existing Quick Puzzle,
gallery, profile, and error tests do not install gameplay configuration unless they load an
`e2e-*` fixture.

A fixture-configured context is bound to one fixture. Tests that intentionally switch to an
ordinary puzzle create a fresh context rather than carrying a mismatched fixture global.

### E2E configuration contract

`GameplayPage.gotoFixture()` installs and freezes the configuration before navigation:

```ts
window.__PERSEUS_E2E_GAMEPLAY_V1__ = Object.freeze({
	version: 1,
	fixtureId: 'e2e-square-4',
	runIds: ['00000000-0000-4000-8000-000000000001'],
	initialTrayOrder: [3, 1, 0, 2],
	restartTrayOrders: [[1, 2, 3, 0]],
	rotations: { 0: 0, 1: 90, 2: 180, 3: 270 }
});
```

The reader validates the complete contract. Empty or exhausted run-ID and restart-order
sequences fail clearly and never fall back to production randomness.

### Production-bundle proof

Add `apps/web/scripts/assert-no-e2e-harness.ts`. It scans the normal static-adapter JavaScript
output under `apps/web/build/` and fails when it finds:

- `__PERSEUS_E2E_GAMEPLAY_V1__`;
- `e2e-square-4`;
- the E2E validation error prefix;
- the concrete E2E reader module path or source marker.

The scanner cannot pass vacuously. Before checking sentinels it requires:

- the expected build directory to exist;
- at least one recursively discovered `.js` file;
- a strictly positive total byte count across scanned JavaScript;
- every discovered file to be readable.

Package scripts include:

```json
{
	"build:e2e": "PERSEUS_E2E_HARNESS=1 bun run build",
	"test:e2e:assert-production-bundle": "bun run build && bun scripts/assert-no-e2e-harness.ts"
}
```

`.github/workflows/e2e-test.yml` runs
`bun run --cwd apps/web test:e2e:assert-production-bundle` after dependency installation and
before Playwright browser installation. The subsequent Playwright web server performs the
separate `build:e2e` build for the shared harness preview.

A query parameter, cookie, request header, local-storage key, or similarly named browser global
cannot activate the harness in a normal build.

## Clock Determinism

The design targets Playwright 1.57. `page.clock.install()` overrides the browser time surfaces
used by the current gameplay clock, including:

- `Date`;
- `setTimeout` and `setInterval`;
- `performance.now()`;
- `requestAnimationFrame`;
- `requestIdleCallback`;
- `Event.timeStamp`.

Gameplay timer tests call:

```ts
await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
```

before `page.goto()` or any operation that can invoke clock-related browser APIs.

`page.clock.setFixedTime()` is insufficient for elapsed-gameplay assertions because it fixes wall
clock without supplying deterministic timer advancement.

Clock verification is split into two tests:

1. **Slice 1 harness probe:** install the clock, read `performance.now()`, run exactly 2,000 ms,
   and assert exact 2,000 ms monotonic advancement. This requires no puzzle fixture or driver.
2. **Later timer integration smoke:** after the small fixture and driver exist, perform a counted
   gameplay action, advance time, and assert the timer UI and sealed elapsed seconds.

Because `clock.install()` also controls animation and idle callbacks, future HPA-219/HPA-222
animation tests must advance the installed clock to drive `requestAnimationFrame` work. A test
that needs real-time animation opts out of the installed clock in a separate context and does not
combine that scenario with deterministic elapsed-time assertions.

If a dependency upgrade changes the clock contract, the harness probe fails before feature tests
silently become nondeterministic.

## State, Authentication, and API Controls

### Isolation and reset

Every test receives a fresh Playwright browser context. The canonical session persistence medium
is `localStorage`.

The automatic reset policy is:

- cookies: always cleared;
- `localStorage`: always cleared unless the current test explicitly preserves or seeds it;
- `sessionStorage`: cleared defensively, but it is not the PuzzleSession medium;
- IndexedDB and Cache Storage: cleared defensively when present; current gameplay does not rely
  on them.

Helper names and documentation must not imply that PuzzleSession currently uses sessionStorage,
IndexedDB, or Cache Storage.

### Persisted-state seeding

`persisted-state.ts` provides typed setup for:

- `PersistedPuzzleSessionV1`;
- local puzzle statistics;
- Quick Puzzle records when a Quick Puzzle test explicitly needs them;
- feature-owned device preferences once their schemas exist.

Seed data uses production serializers or validated builders wherever possible. Raw storage-key
payloads are permitted only for migration or malformed-record tests. Seeding happens before
application startup; after navigation, tests use the UI.

### Authentication personas

The default persona is anonymous. `auth-persona.ts` supports:

- anonymous;
- authenticated player with deterministic identity;
- deferred session response;
- failed session response.

Simulation occurs through the existing HTTP contract. Tests do not inject the Svelte auth store
and do not create real OAuth sessions.

### Completion effect matrix

API-source puzzle completion always seals local completion and requests both applicable effects:
local statistics and server submission. Anonymous API completion still attempts the authenticated
completion endpoint and receives an unauthorized outcome unless the test registers another
response.

| Scenario                       | Persona       | Expected assertions                                                                   |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------- |
| Fixture load/layout            | Anonymous     | No completion effect                                                                  |
| Anonymous full completion      | Anonymous     | Celebration and local stats succeed; one server-submission attempt returns 401        |
| Successful full completion     | Authenticated | Local stats succeed; one completion request with deterministic run ID returns success |
| Deferred failure/retry/success | Authenticated | Request remains pending, fails retryably, then succeeds after explicit release/retry  |
| Local Quick Puzzle completion  | Anonymous     | Local stats apply; server submission is not applicable                                |

Tests must not assert that anonymous API completion sends no request. The client deliberately
attempts submission and records the unauthorized effect state.

### Controllable API outcomes

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

Deferred responses use explicit promises, not sleeps. Teardown fails when a deferred route was
never released or intentionally cancelled. The helper records method, URL, request body, and
outcome. Unexpected writes fail unless explicitly registered.

## Playwright Fixture and Driver Layer

### Files

```text
apps/web/e2e/gameplay-fixtures/
  builder.ts
  catalog.ts
  assets.ts
  fixture-router.ts
  api-scenario.ts
  auth-persona.ts
  persisted-state.ts

apps/web/e2e/support/
  test.ts
  diagnostics.ts
  accessibility.ts
  gameplay-page.ts

apps/web/e2e/gameplay-infrastructure.spec.ts
apps/web/e2e/gameplay-large-fixtures.spec.ts
apps/web/e2e/playwright-clock-contract.spec.ts
```

Existing unrelated E2E files and the Quick Puzzle upload asset remain in place. HPA-226 does not
reorganize them solely for naming consistency.

### Canonical extended test object

`support/test.ts` exports the canonical E2E `test` and `expect`. It provides:

- `fixtureCatalog`;
- `fixtureRouter`;
- `apiScenario`;
- `authPersona`;
- `persistedState`;
- `gameplayPage`;
- `scanAccessibility`;
- automatic console and network diagnostics.

New gameplay tests consume these shared modules. They do not copy the existing gallery or
profile pattern into a third per-file mock stack. Existing suites may migrate incrementally when
touched for feature work.

### `GameplayPage.gotoFixture()`

One entry point owns setup order so feature tickets cannot accidentally navigate too early:

1. assert the fixture exists;
2. register fixture, auth, asset, and API routes;
3. reset or seed browser state;
4. install and freeze the fixture runtime global with `addInitScript`;
5. install the Playwright clock when the scenario requests deterministic time;
6. navigate to the fixture route;
7. wait for the observable ready state.

### Stable selectors

Use existing surfaces where available:

- board by `data-testid="puzzle-board"`;
- cells by `data-testid="drop-zone"`, `data-x`, and `data-y`;
- pieces by `data-testid="puzzle-piece"` and `data-piece-id`;
- accessible role and name for dialogs and controls.

For a source piece, the driver scopes to the unplaced tray slot using the existing
`piece-slot-${id}` test surface before locating its nested puzzle piece. A broad
`[data-piece-id="..."]` locator is insufficient after partial placement because rendered tray
and board representations may overlap semantically.

Add test IDs only when role/name is unstable or coordinate/identity is otherwise unavailable.
Test IDs describe semantic surfaces rather than internal component structure.

### Mouse placement

`GameplayPage.placeWithMouse(pieceId, x, y)`:

1. finds the unplaced source piece in its tray slot;
2. finds the target drop zone;
3. performs the browser drag interaction;
4. waits for observable placement state;
5. records source and target geometry on failure.

A standards-compatible drag-event fallback is allowed only when Playwright's native drag path
cannot drive the current HTML drag-and-drop behavior consistently. The fallback still targets
rendered UI and event handlers; it never calls the session engine.

### Keyboard placement

`GameplayPage.selectAndPlaceWithKeyboard(pieceId, x, y)`:

1. focuses the unplaced piece;
2. selects with Enter or Space;
3. verifies selected state through ARIA or existing data attributes;
4. focuses the target cell;
5. places with Enter or Space;
6. verifies placement and selection cleanup.

HPA-223 extends this driver with roving-navigation methods.

### Tap and touch

`GameplayPage.tapPiece(pieceId)` uses browser pointer or touchscreen input where the current UI
supports it.

`GameplayPage.dragWithTouch(pieceId, x, y)` covers the current direct-touch path. It may use a
small standards-shaped touch-event adapter because Playwright has no complete high-level
multi-step touch-drag primitive. The adapter drives the rendered element, window listeners, hit
testing, and drop handlers used by players.

HPA-219 owns tap-to-place semantics, bottom-sheet scrolling, safe-area behavior, and two-finger
board-pan helpers.

## Browser and Viewport Matrix

### Projects

| Project            | Browser  | Viewport   | Default purpose                           |
| ------------------ | -------- | ---------- | ----------------------------------------- |
| `chromium-desktop` | Chromium | 1440 × 900 | Core PR smoke and existing suite          |
| `chromium-mobile`  | Chromium | 390 × 844  | Core responsive PR smoke                  |
| `chromium-tablet`  | Chromium | 768 × 1024 | Extended layout/accessibility             |
| `webkit-mobile`    | WebKit   | 390 × 844  | Critical Safari/touch/focus compatibility |
| `webkit-tablet`    | WebKit   | 768 × 1024 | Extended Safari layout/accessibility      |

Firefox is deferred until a product requirement, defect signal, or maintenance budget justifies
another compatibility axis.

### WebKit HTML5 drag spike

Native HTML5 mouse drag is an implementation risk, not an assumed PR capability. Slice 1 runs a
CI-like spike on **ubuntu-latest with headless WebKit**:

1. try Playwright's native `dragTo()` path;
2. try the allowed UI-event fallback only if needed;
3. run the representative placement scenario at least 20 consecutive times;
4. use `--retries=0 --workers=1`;
5. capture traces and geometry for every failure.

Native mouse drag joins `@webkit-critical` only after zero failures. If it remains unreliable:

- WebKit mouse drag is tagged `@extended` and is not a required PR check;
- WebKit remains PR-blocking for responsive, focus, keyboard, and supported touch placement;
- `apps/web/e2e/README.md` documents the limitation and evidence;
- a follow-up issue is linked instead of silently skipping the scenario.

The entire WebKit project is never demoted solely because native HTML5 mouse drag is unreliable.

### Tags and explicit commands

Tests use bounded tags:

- `@smoke` — fast representative infrastructure and existing critical flows;
- `@webkit-critical` — selected WebKit-responsive, focus, keyboard, and supported touch checks;
- `@extended` — large fixtures, broader viewport matrix, and non-blocking compatibility cases;
- `@a11y` — automated accessibility scans.

Commands name their projects explicitly:

```json
{
	"test:e2e": "playwright test --project=chromium-desktop --grep-invert @extended",
	"test:e2e:smoke": "playwright test --grep @smoke --project=chromium-desktop --project=chromium-mobile",
	"test:e2e:webkit": "playwright test --grep @webkit-critical --project=webkit-mobile",
	"test:e2e:extended": "playwright test --grep @extended --project=chromium-desktop --project=chromium-mobile --project=chromium-tablet --project=webkit-mobile --project=webkit-tablet",
	"test:e2e:a11y": "playwright test --grep @a11y --project=chromium-desktop --project=chromium-tablet --project=webkit-mobile",
	"test:e2e:stability": "playwright test --grep @smoke --project=chromium-desktop --repeat-each=10 --retries=0 --workers=1",
	"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit",
	"test:install-browsers:dry-run": "playwright install --dry-run --only-shell chromium webkit"
}
```

The single browser-install command is intentional for Playwright 1.57. Its CLI defines
`--only-shell` as applying when installing Chromium; with `chromium webkit`, Chromium resolves to
`chromium-headless-shell` while WebKit remains a normal WebKit installation. Slice 1 runs the
`--dry-run` command and asserts that output lists `chromium-headless-shell` and `webkit` without a
full Chromium download. Two separate installation commands are unnecessary and would duplicate
setup work.

Adding WebKit increases browser download, cache, and Linux dependency cost. `--with-deps` already
exists in CI. Developers who need headed Chromium install the full browser separately.

## Diagnostics and Failure Artifacts

The design targets the repository's Playwright 1.57 type contract:

```ts
export default defineConfig({
	failOnFlakyTests: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	use: {
		trace: 'retain-on-failure',
		screenshot: 'on-first-failure'
	},
	reporter: process.env.CI
		? [['github'], ['html', { open: 'never' }]]
		: [['list'], ['html', { open: 'never' }]]
});
```

`retain-on-failure-and-retries` is not valid in Playwright 1.57 and does not appear in this
design. It may be considered only after a deliberate dependency upgrade and contract review.

The automatic diagnostics fixture records:

- unexpected console errors;
- uncaught page errors;
- failed requests;
- unexpected non-success API responses;
- fixture and persona identity;
- registered and observed API scenario outcomes;
- pending deferred routes;
- source/target geometry for failed placement helpers.

Known expected errors are allowlisted narrowly by scenario. A broad console-error ignore is not
permitted.

CI uploads `test-results/` and `playwright-report/` when the job fails. Trace and screenshot paths
remain visible in the GitHub job summary.

## Accessibility Support

Add `@axe-core/playwright` and a shared scan helper.

HPA-226 scans the surfaces available at delivery:

- gallery;
- active gameplay;
- current completion surface.

Setup, pause, mobile tray, and redesigned completion scans belong to their feature tickets when
those surfaces exist.

The helper also supports:

- initial-focus assertions;
- focus containment for current dialogs;
- live-region existence and text assertions;
- attachment of axe findings to the Playwright report.

Automated scans do not replace HPA-223's manual VoiceOver and desktop screen-reader validation.

## Representative Smoke Coverage

| Smoke                           | Fixture                | Persona       | Input                          | Required assertion                                                                                          |
| ------------------------------- | ---------------------- | ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Known fixture load              | `e2e-square-4`         | Anonymous     | None                           | Board, four tray pieces, and deterministic assets load                                                      |
| Authenticated completion        | `e2e-square-4`         | Authenticated | Mouse                          | One rejected attempt, full solve, celebration, local stats, one successful deterministic completion request |
| Anonymous completion            | `e2e-square-4`         | Anonymous     | Keyboard or mouse              | Celebration and local stats succeed; one server attempt records 401                                         |
| Keyboard placement              | `e2e-square-4`         | Anonymous     | Keyboard                       | Select, place, and selection cleanup use visible UI                                                         |
| WebKit compatibility            | `e2e-square-4`         | Anonymous     | Keyboard or supported touch    | Critical placement path works at 390 × 844                                                                  |
| Deterministic timer integration | `e2e-square-4`         | Authenticated | Any counted action             | Installed clock advances UI and sealed elapsed seconds exactly                                              |
| Deferred retry                  | `e2e-square-4`         | Authenticated | Mouse or keyboard              | Deferred submission, retryable failure, explicit retry, success                                             |
| Persistence seed/reset          | `e2e-square-4`         | Anonymous     | UI after seed                  | Seed restores; reset removes canonical localStorage state                                                   |
| Ratio layout                    | Landscape and portrait | Anonymous     | None                           | Exact shared grid orientation, board ratio, and usable controls                                             |
| Large layout                    | 100 and 225 pieces     | Anonymous     | One representative interaction | All pieces render without full solve loop                                                                   |

The infrastructure suite does not own future setup, pause, tray-filter, staging, or redesigned
completion behavior.

## Waiting Policy

Allowed synchronization:

- Playwright web-first assertions;
- URL assertions;
- locator state and count assertions;
- explicit request/response promises;
- explicit release of deferred routes;
- observable application state;
- Playwright clock advancement for timer-driven behavior.

`page.waitForTimeout()` is prohibited. A rare exception requires an inline comment naming the
browser behavior and explaining why no observable signal exists.

## Existing Skipped Tests

Each existing skipped gameplay test is handled by one of:

1. enable it through the new fixture and driver foundation;
2. replace it with a clearer infrastructure-owned scenario;
3. remove it and link the exact owning HPA-215 feature ticket when the required UI does not yet
   exist.

No unexplained gameplay skip remains after HPA-226.

## CI Structure

### Pull-request jobs

1. **Production bundle safety** in `.github/workflows/e2e-test.yml`
   - run `bun run --cwd apps/web test:e2e:assert-production-bundle`;
   - fail if build output is absent/empty or contains harness sentinels.
2. **Chromium smoke**
   - install Chromium headless shell and WebKit using the shared Playwright 1.57 command;
   - run `test:e2e:smoke`;
   - upload artifacts on failure.
3. **WebKit critical**
   - run `test:e2e:webkit` using the WebKit spike result;
   - upload artifacts on failure.

### Extended job

Run on `main`, manually, or on a schedule:

- `test:e2e:extended` across its explicit five-project matrix;
- `test:e2e:a11y`;
- 100- and 225-piece checks;
- optional extended WebKit mouse-drag coverage.

### Stability gate

Before HPA-226 is complete:

- run the browser-install dry-run contract;
- run the clock contract probe;
- run Chromium smoke ten times serially with zero retries;
- run Chromium smoke with normal parallel workers;
- run WebKit critical repeatedly with zero retries;
- run the production-bundle sentinel assertion;
- remove root causes rather than increasing timeouts.

## Documentation

Add `apps/web/e2e/README.md` covering:

- additive fixture directory structure and the existing Quick Puzzle upload asset;
- fixture catalog, shared grid orientation, and zero-based IDs;
- fixture-ID interception rules and cross-runtime backend differences;
- `GameplayPage.gotoFixture()` lifecycle;
- virtual-module build gate and shared-preview fallback semantics;
- Vitest/no-op behavior and import restrictions;
- clock installation order and animation-callback implications;
- localStorage reset and seeding;
- authentication and completion-effect matrix;
- API scenario registration and deferred-route cleanup;
- browser projects and explicit tag/project commands;
- WebKit drag-spike result;
- browser-install dry-run, WebKit cost, and Chromium headless-shell behavior;
- diagnostics and artifact locations;
- accessibility scan limitations;
- security boundary and non-vacuous production-bundle proof;
- feature-test ownership.

## Delivery Sequence

1. **Harness contracts and WebKit spike**
   - verify exact Playwright 1.57 trace, clock, and browser-install contracts;
   - add the pure `performance.now()` clock probe;
   - run the browser-install dry-run assertion;
   - decide WebKit mouse-drag gating with the ubuntu-latest 20-run spike.
2. **Playwright baseline**
   - projects, tags, reporters, artifacts, browser installation, and split CI jobs.
3. **Fixture catalog**
   - additive gameplay-fixtures directory, exact shared grids, zero-based builder, five fixtures,
     padded SVG assets, and total `e2e-*` route interception.
4. **Runtime determinism**
   - route adapter, pre-enforced virtual module, import restrictions, scoped shared-preview
     activation, validation, Vitest behavior, and production-bundle assertion.
5. **State and API controls**
   - localStorage reset/seeding, defensive secondary-store cleanup, auth personas, completion
     matrix, deferred responses, and failure scenarios.
6. **Gameplay driver**
   - `gotoFixture`, scoped tray-piece selection, mouse, keyboard, current tap/touch support,
     dialog base, and observable waits.
7. **Smoke coverage**
   - skipped-test resolution, authenticated and anonymous completion, timer integration,
     persistence, failure, ratios, and large fixtures.
8. **Accessibility and documentation**
   - axe helper, focus/live-region support, E2E guide, installation cost, and threat analysis.
9. **Stability verification**
   - repeated, serial, parallel, Chromium, and WebKit runs without hidden flakes or arbitrary
     sleeps.

## Acceptance-Criteria Mapping

| HPA-226 criterion                                 | Design coverage                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No production data or external images             | Fixture router and generated padded SVG assets                                                    |
| All ratios plus small, 100, and 225 pieces        | Five fixtures using exact shared rows/columns and dedicated size cases                            |
| Deterministic full completion                     | Authenticated 4-piece completion smoke                                                            |
| Large fixtures without full solve                 | 100/225 render and representative interaction tests                                               |
| Timer, randomness, storage, auth, and API control | Installed clock, route adapter, localStorage seed/reset, personas, API scenarios                  |
| Reusable cross-input helpers                      | Scoped mouse, keyboard, tap, and supported touch methods                                          |
| Chromium and WebKit CI                            | Explicit PR projects and split jobs                                                               |
| Mobile, tablet, and desktop                       | 390 × 844, 768 × 1024, and 1440 × 900 projects                                                    |
| Accessibility and focus/live support              | Axe, focus, and live-region helpers                                                               |
| Screenshots, traces, console and network evidence | Valid Playwright 1.57 artifact modes and diagnostics fixture                                      |
| Skipped gameplay tests resolved                   | Enable, replace, or owning-ticket linkage rule                                                    |
| Commands and lifecycle documented                 | E2E README and explicit package scripts                                                           |
| Stable repeated runs without sleeps               | `failOnFlakyTests`, repeat gates, observable waits, sleep prohibition                             |
| Test hooks not unsafe in production               | Build-time virtual module, no-op normal build, scoped fixture activation, non-vacuous bundle scan |
| Existing suite remains usable                     | Missing global falls back only for non-`e2e-*` puzzles                                            |

## Non-Goals

- implementing every HPA-215 feature scenario;
- solving 100- or 225-piece puzzles in CI;
- adding production fixture or test-control services;
- maintaining duplicate Bun and Worker test routes;
- pixel-perfect animation or screenshot regression;
- production load testing;
- replacing unit and component tests;
- certifying physical iOS or Android gesture equivalence;
- certifying assistive technology through axe alone;
- adding Firefox solely for matrix symmetry.

## Risks and Mitigations

### E2E code leaks into production

Use the pre-enforced virtual module, no-op normal implementation, import restrictions, and
non-vacuous production-bundle sentinel assertion.

### Shared E2E build breaks existing tests

The E2E reader returns `null` for unconfigured ordinary and Quick Puzzles and hard-fails only for
missing `e2e-*` configuration or malformed supplied configuration.

### Route interception diverges from API contracts

Use shared request/response types, keep fixture contracts bounded, and retain API unit and
integration coverage. E2E interception validates the web contract, not storage-runtime behavior.

### Cross-browser drag behavior flakes

Centralize interaction mechanics, require the WebKit spike, attach geometry and traces, and keep
keyboard or supported touch coverage critical when mouse drag is not reliable.

### Large fixture tests become expensive

Generate metadata and assets programmatically, avoid full solves, tag them `@extended`, and use
explicit project filters.

### Retries hide instability

Use `failOnFlakyTests`; keep the stability pass at zero retries.

### Feature tickets bypass the foundation

Export one canonical extended test object and `GameplayPage.gotoFixture()` entry point. New
gameplay suites do not create independent mock stacks.

## References

- HPA-226: https://linear.app/cwchanap/issue/HPA-226/quality-build-deterministic-gameplay-fixture-and-e2e-test
- HPA-215: https://linear.app/cwchanap/issue/HPA-215/product-gameplay-first-ux-polish-for-perseus-puzzle-sessions
- Playwright 1.57 test types: https://github.com/microsoft/playwright/blob/v1.57.0/packages/playwright/types/test.d.ts
- Playwright 1.57 CLI source: https://github.com/microsoft/playwright/blob/v1.57.0/packages/playwright-core/src/cli/program.ts
- Playwright fixtures: https://playwright.dev/docs/test-fixtures
- Playwright projects: https://playwright.dev/docs/test-projects
- Playwright clock: https://playwright.dev/docs/clock
- Playwright accessibility testing: https://playwright.dev/docs/accessibility-testing
- Vite plugin API: https://vite.dev/guide/api-plugin.html
