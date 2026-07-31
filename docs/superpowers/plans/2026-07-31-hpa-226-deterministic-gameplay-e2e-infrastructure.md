# Deterministic Gameplay Fixture and E2E Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic gameplay fixtures, browser-only runtime controls, reusable Playwright helpers, cross-browser projects, diagnostics, accessibility support, and representative smoke coverage for HPA-226.

**Architecture:** Playwright owns fixture metadata, synthetic assets, authentication personas, persistence seeding, and HTTP outcomes. Production code gains one route-level gameplay dependency adapter that consumes a build-time Vite virtual module: normal Vite/Vitest builds receive a no-op implementation, while the E2E preview receives a strict reader for configured `e2e-*` fixtures. Tests drive rendered UI and observable HTTP/state boundaries; they never dispatch PuzzleSession actions directly.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, SvelteKit 2 / Svelte 5, Vite 7, Vitest 4 browser mode, Playwright 1.57, `@axe-core/playwright`, GitHub Actions.

## Global Constraints

- Target Playwright `1.57.0`.
- Use `trace: 'retain-on-failure'` and `screenshot: 'on-first-failure'`.
- Keep `failOnFlakyTests: Boolean(process.env.CI)` and zero retries in stability commands.
- Fixture IDs are zero-based: `id = row * cols + col`.
- Fixture grids come from `getGridDimensionsForAspectRatio`; transposed grids are invalid.
- Intercept every request containing an `e2e-*` fixture ID before either backend sees it.
- Missing runtime config falls back only for ordinary API and `q-*` puzzles; an unconfigured `e2e-*` puzzle is a hard error.
- Malformed or mismatched supplied config is always a hard error.
- Normal production bundles contain no E2E reader, fixture ID, runtime global, or validation marker.
- New gameplay tests import the shared extended `test` object and use `GameplayPage`.
- `localStorage` is the canonical PuzzleSession medium.
- Install Playwright clock before navigation in deterministic timer tests.
- Do not use `page.waitForTimeout()` without an inline browser-specific justification.
- Native WebKit mouse drag becomes PR-blocking only after a 20-run, zero-retry `ubuntu-latest` spike passes.
- Browser emulation does not certify physical devices or assistive technology.

## Dependency Order

```text
Task 0 virtual no-op foundation
  -> Task 1 production runtime adapter
  -> Task 2 strict E2E reader
  -> Task 3 production bundle safety
  -> Task 4 Playwright projects/contracts
  -> Task 5 fixture catalog/assets
  -> Task 6 routing/personas/API/persistence
  -> Task 7 shared test fixture/gotoFixture
  -> Task 8 interactions/dialog base/WebKit spike
  -> Task 9 small-fixture smoke
  -> Task 10 large/a11y coverage
  -> Task 11 CI/docs
  -> Task 12 stability audit
```

## Shared Plan Interfaces

Task 6 produces this bounded completion configuration for Task 7:

```ts
export type CompletionScenario =
	| { kind: 'success' }
	| { kind: 'deferred-success' }
	| { kind: 'network-abort' }
	| { kind: 'http-failure'; status: 400 | 401 | 404 | 409 | 429 | 500 };
```

Task 8 completes this shared player-facing surface:

```ts
export class GameplayPage {
	gotoFixture(id: GameplayFixtureId, options?: GotoFixtureOptions): Promise<void>;
	expectReady(): Promise<void>;
	placeWithMouse(pieceId: number, x: number, y: number): Promise<void>;
	selectAndPlaceWithKeyboard(pieceId: number, x: number, y: number): Promise<void>;
	tapPiece(pieceId: number): Promise<void>;
	dragWithTouch(pieceId: number, x: number, y: number): Promise<void>;
	expectPiecePlaced(pieceId: number, x: number, y: number): Promise<void>;
	waitForDialog(name: string | RegExp): Promise<Locator>;
	expectDialogInitialFocus(dialog: Locator, target: Locator): Promise<void>;
	activateDialogAction(dialog: Locator, name: string | RegExp): Promise<void>;
	dismissDialog(dialog: Locator, method: 'escape' | 'visible-close-button'): Promise<void>;
}
```

Concrete setup, pause, mobile-tray, and redesigned-completion methods are added by HPA-219, HPA-221, and HPA-224 when those surfaces exist; HPA-226 supplies the base role/focus/action contract.

---

### Task 0: Establish the No-Op Virtual Module Foundation

**Files:**
- Create: `apps/web/src/lib/services/gameplay/runtime.types.ts`
- Create: `apps/web/build/gameplay-runtime-override-plugin.ts`
- Create: `apps/web/build/gameplay-runtime-override-plugin.test.ts`
- Create: `apps/web/src/virtual-modules.d.ts`
- Modify: `apps/web/vite.config.ts`

**Produces:**

```ts
export interface GameplayRuntimeDependencies {
	runIdFactory: RunIdFactory;
	createInitialTrayOrder(pieceIds: readonly number[]): number[];
	createRestartTrayOrder(pieceIds: readonly number[]): number[];
	createRotations(puzzleId: string, pieceIds: readonly number[]): Record<number, Rotation>;
}

export interface GameplayRuntimeOverrideContext {
	puzzleId: string;
	pieceIds: readonly number[];
}

export function gameplayRuntimeOverridePlugin(options?: {
	harnessEnabled?: boolean;
	readerPath?: string;
}): Plugin;
```

- [ ] **Step 1: Write failing plugin tests**

Test exact resolution and no-op output:

```ts
it('resolves only the exact virtual id', async () => {
	const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
	expect(await plugin.resolveId?.call({} as never, 'virtual:perseus-gameplay-runtime-override'))
		.toBe('\0virtual:perseus-gameplay-runtime-override');
	expect(await plugin.resolveId?.call({} as never, './runtime-override')).toBeNull();
});

it('emits a no-op module outside the harness build', async () => {
	const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
	const code = await plugin.load?.call(
		{} as never,
		'\0virtual:perseus-gameplay-runtime-override'
	);
	expect(String(code)).toContain('return null');
	expect(String(code)).not.toContain('e2e-gameplay-runtime');
});
```

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
```

Expected: FAIL because the plugin does not exist.

- [ ] **Step 3: Implement shared types and plugin**

Use:

```ts
const virtualId = 'virtual:perseus-gameplay-runtime-override';
const resolvedVirtualId = `\0${virtualId}`;
```

The plugin is `enforce: 'pre'`. Normal mode emits an inline `readGameplayRuntimeOverride()` returning `null`. Harness mode re-exports from `readerPath`; Task 2 supplies the reader.

- [ ] **Step 4: Add the module declaration**

```ts
declare module 'virtual:perseus-gameplay-runtime-override' {
	import type {
		GameplayRuntimeDependencies,
		GameplayRuntimeOverrideContext
	} from '$lib/services/gameplay/runtime.types';

	export function readGameplayRuntimeOverride(
		context: GameplayRuntimeOverrideContext
	): GameplayRuntimeDependencies | null;
}
```

- [ ] **Step 5: Install plugin before Tailwind and SvelteKit**

```ts
plugins: [gameplayRuntimeOverridePlugin(), tailwindcss(), sveltekit()]
```

Capture `PERSEUS_E2E_HARNESS === '1'` when the config is created; an existing Vitest process does not switch modes after environment mutation.

- [ ] **Step 6: Verify GREEN**

```bash
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
bun run --cwd apps/web check
bun run --cwd apps/web test:unit
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/services/gameplay/runtime.types.ts \
  apps/web/build/gameplay-runtime-override-plugin.ts \
  apps/web/build/gameplay-runtime-override-plugin.test.ts \
  apps/web/src/virtual-modules.d.ts apps/web/vite.config.ts
git commit -m "test(web): add gameplay runtime virtual module"
```

---

### Task 1: Extract the Production Runtime Adapter

**Files:**
- Create: `apps/web/src/lib/services/gameplay/runtime.ts`
- Create: `apps/web/src/lib/services/gameplay/runtime.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Produces:**

```ts
export function createGameplayRuntimeDependencies(
	puzzleId: string,
	pieceIds: readonly number[]
): GameplayRuntimeDependencies;
```

- [ ] **Step 1: Write failing adapter tests**

Mock the virtual module to return `null`; mock shuffle to reverse IDs. Assert initial/restart order, complete rotation keys, and production run-ID factory. Add a test where a fixed override is returned and production shuffle is not called.

- [ ] **Step 2: Verify RED**

```bash
bun run --cwd apps/web test:unit -- src/lib/services/gameplay/runtime.test.ts
```

- [ ] **Step 3: Implement adapter**

1. Call `readGameplayRuntimeOverride({ puzzleId, pieceIds })`.
2. Return non-null override.
3. Otherwise use `createBrowserRunIdFactory`, `shuffleArray`, and the existing puzzle-derived rotation seed.
4. Clone arrays/objects at return boundaries.
5. Validate generated tray orders as complete permutations.

- [ ] **Step 4: Refactor the route**

```ts
const pieceIds = loadedPuzzle.pieces.map((piece) => piece.id);
const runtime = createGameplayRuntimeDependencies(loadedPuzzle.id, pieceIds);

const store = createPuzzleSessionStore({
	metadata,
	runIdFactory: runtime.runIdFactory,
	clock,
	restored,
	initialTrayOrder: runtime.createInitialTrayOrder(pieceIds),
	createTrayOrder: () => runtime.createRestartTrayOrder(pieceIds),
	createRotations: (requestedPieceIds) =>
		runtime.createRotations(loadedPuzzle.id, requestedPieceIds),
	onEvent: handleSessionEvent
});
```

Preserve hydration, subscription, auto-start, completion effects, and checkpoint ordering.

- [ ] **Step 5: Update route tests**

Mock fixed runtime values. Assert fresh load consumes initial order and restart consumes the restart factory through the real session engine.

- [ ] **Step 6: Verify GREEN**

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/runtime.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/services/gameplay/runtime.ts \
  apps/web/src/lib/services/gameplay/runtime.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor(web): add gameplay runtime adapter"
```

---

### Task 2: Implement the Strict E2E Reader and Import Guardrails

**Files:**
- Create: `apps/web/src/lib/testing/e2e-gameplay-runtime.ts`
- Create: `apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts`
- Modify: `apps/web/build/gameplay-runtime-override-plugin.test.ts`
- Modify: `apps/web/eslint.config.js`

**Produces:**

```ts
export interface PerseusE2EGameplayConfigV1 {
	version: 1;
	fixtureId: string;
	runIds: readonly string[];
	initialTrayOrder: readonly number[];
	restartTrayOrders: readonly (readonly number[])[];
	rotations: Readonly<Record<number, Rotation>>;
}
```

- [ ] **Step 1: Write reader tests**

Cover absent config for ordinary/`q-*`, absent config for `e2e-*`, malformed config, fixture mismatch, frozen-object requirement, valid run IDs, complete tray permutations, exact rotation keys, sequence exhaustion, and clone isolation.

- [ ] **Step 2: Verify RED**

```bash
bun run --cwd apps/web test:unit -- src/lib/testing/e2e-gameplay-runtime.test.ts
```

- [ ] **Step 3: Implement reader**

Use `PERSEUS_E2E_CONFIG:` for every error. Validate the complete frozen global before creating closures. Store run/restart cursors inside the returned dependency object. Never fall back after config is present.

- [ ] **Step 4: Test harness plugin output**

With `harnessEnabled: true` and an explicit normalized `readerPath`, assert generated code re-exports that path and has no inline fallback.

- [ ] **Step 5: Add ESLint restrictions**

Reject from production source:
- `$lib/testing/e2e-gameplay-runtime`;
- relative imports ending in `e2e-gameplay-runtime`;
- paths containing `runtime-override`.

Allow only `runtime.ts` to import `virtual:perseus-gameplay-runtime-override`. Testing files may import the concrete reader.

- [ ] **Step 6: Verify GREEN**

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/runtime.test.ts \
  src/lib/testing/e2e-gameplay-runtime.test.ts
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
bun run --cwd apps/web check
bun run --cwd apps/web lint
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/testing/e2e-gameplay-runtime.ts \
  apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts \
  apps/web/build/gameplay-runtime-override-plugin.test.ts apps/web/eslint.config.js
git commit -m "test(web): enforce deterministic runtime configuration"
```

---

### Task 3: Add Non-Vacuous Production-Bundle Safety

**Files:**
- Create: `apps/web/scripts/assert-no-e2e-harness.ts`
- Create: `apps/web/scripts/assert-no-e2e-harness.test.ts`
- Modify: `apps/web/package.json`
- Modify: `.github/workflows/e2e-test.yml`

**Produces:**

```ts
export async function assertNoE2EHarness(buildDirectory: string): Promise<{
	filesScanned: number;
	bytesScanned: number;
}>;
```

- [ ] **Step 1: Write scanner tests**

Missing, empty, no-JavaScript, unreadable, and sentinel-containing outputs fail. Clean nested JavaScript returns positive counts.

Sentinels:

```ts
const SENTINELS = [
	'__PERSEUS_E2E_GAMEPLAY_V1__',
	'e2e-square-4',
	'PERSEUS_E2E_CONFIG:',
	'e2e-gameplay-runtime.ts'
] as const;
```

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
```

- [ ] **Step 3: Implement scanner**

Resolve `apps/web/build/`, sort recursive `.js` paths, require at least one readable file and positive bytes, and report every match.

- [ ] **Step 4: Add scripts**

```json
"build:e2e": "PERSEUS_E2E_HARNESS=1 bun run build",
"test:e2e:assert-production-bundle": "bun run build && bun scripts/assert-no-e2e-harness.ts"
```

- [ ] **Step 5: Wire workflow before browser installation**

```yaml
- name: Verify production bundle excludes E2E harness
  run: bun run --cwd apps/web test:e2e:assert-production-bundle
```

- [ ] **Step 6: Verify**

```bash
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web build:e2e
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/scripts apps/web/package.json .github/workflows/e2e-test.yml
git commit -m "test(web): verify production bundle excludes E2E harness"
```

---

### Task 4: Establish Playwright Projects and Contract Probes

**Files:**
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/package.json`
- Create: `apps/web/e2e/playwright-clock-contract.spec.ts`
- Create: `apps/web/scripts/assert-browser-install.ts`
- Create: `apps/web/scripts/assert-browser-install.test.ts`

- [ ] **Step 1: Write clock contract**

```ts
import { expect, test } from '@playwright/test';

test('@smoke installed clock advances performance.now exactly', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await page.goto('/');
	const before = await page.evaluate(() => performance.now());
	await page.clock.runFor(2_000);
	const after = await page.evaluate(() => performance.now());
	expect(after - before).toBe(2_000);
});
```

- [ ] **Step 2: Write browser-install parser tests**

Require `chromium-headless-shell` and `webkit`; reject a full Chromium browser entry. Tolerate version/URL changes.

- [ ] **Step 3: Expand Playwright config**

Add valid artifact/retry/report settings and projects:
- `chromium-desktop` 1440 × 900;
- `chromium-mobile` 390 × 844;
- `chromium-tablet` 768 × 1024;
- `webkit-mobile` 390 × 844;
- `webkit-tablet` 768 × 1024.

Use `build:e2e` for web preview; preserve API server environment.

- [ ] **Step 4: Add explicit scripts**

```json
"test:e2e": "playwright test --project=chromium-desktop --grep-invert @extended",
"test:e2e:smoke": "playwright test --grep @smoke --project=chromium-desktop --project=chromium-mobile",
"test:e2e:webkit": "playwright test --grep @webkit-critical --project=webkit-mobile",
"test:e2e:extended": "playwright test --grep @extended --project=chromium-desktop --project=chromium-mobile --project=chromium-tablet --project=webkit-mobile --project=webkit-tablet",
"test:e2e:a11y": "playwright test --grep @a11y --project=chromium-desktop --project=chromium-tablet --project=webkit-mobile",
"test:e2e:stability": "playwright test --grep @smoke --project=chromium-desktop --repeat-each=10 --retries=0 --workers=1",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit",
"test:install-browsers:dry-run": "playwright install --dry-run --only-shell chromium webkit"
```

- [ ] **Step 5: Verify browser resolution**

```bash
bun test apps/web/scripts/assert-browser-install.test.ts
bun run --cwd apps/web test:install-browsers:dry-run | bun apps/web/scripts/assert-browser-install.ts
```

- [ ] **Step 6: Install and run clock probe**

```bash
bun run --cwd apps/web test:install-browsers
bun run --cwd apps/web test:e2e -- e2e/playwright-clock-contract.spec.ts \
  --project=chromium-desktop --retries=0
```

Expected: exact 2,000 ms advancement.

- [ ] **Step 7: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/package.json \
  apps/web/e2e/playwright-clock-contract.spec.ts apps/web/scripts/assert-browser-install*
git commit -m "test(web): add Playwright projects and contract probes"
```

---

### Task 5: Build Fixture Catalog and Padded Assets

**Files:**
- Create: `apps/web/e2e/gameplay-fixtures/builder.ts`
- Create: `apps/web/e2e/gameplay-fixtures/builder.test.ts`
- Create: `apps/web/e2e/gameplay-fixtures/catalog.ts`
- Create: `apps/web/e2e/gameplay-fixtures/catalog.test.ts`
- Create: `apps/web/e2e/gameplay-fixtures/assets.ts`
- Create: `apps/web/e2e/gameplay-fixtures/assets.test.ts`

**Produces:**

```ts
export type GameplayFixtureId =
	| 'e2e-square-4'
	| 'e2e-landscape-12'
	| 'e2e-portrait-12'
	| 'e2e-square-100'
	| 'e2e-square-225';
```

- [ ] **Step 1: Write invariant tests**

Exact grids: 2 × 2, 3 × 4, 4 × 3, 10 × 10, 15 × 15. Also assert zero-based IDs, unique coordinates, flat outer edges, complementary neighbors, complete tray permutations, valid rotations, and unique valid run IDs.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/e2e/gameplay-fixtures/builder.test.ts
```

- [ ] **Step 3: Implement builder**

Use shared grid/edge helpers. Never accept unchecked rows/columns. Freeze catalog values or clone at consumer boundaries.

- [ ] **Step 4: Define five fixtures**

Use fixed UUIDv4-shaped run IDs, timestamps, literal deterministic tray permutations, and rotation maps.

- [ ] **Step 5: Implement padded SVGs**

Generate XML-safe, dependency-free SVGs with transparent padding matching `TAB_RATIO` and `EXPANSION_FACTOR`. Include fixture/piece identity and coordinates.

- [ ] **Step 6: Verify and commit**

```bash
bun test apps/web/e2e/gameplay-fixtures/*.test.ts
git add apps/web/e2e/gameplay-fixtures
git commit -m "test(web): add deterministic gameplay fixture catalog"
```

---

### Task 6: Add Routing, Personas, API Outcomes, and Persistence Controls

**Files:**
- Create: `apps/web/e2e/gameplay-fixtures/fixture-router.ts`
- Create: `apps/web/e2e/gameplay-fixtures/auth-persona.ts`
- Create: `apps/web/e2e/gameplay-fixtures/api-scenario.ts`
- Create: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Create: `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`

**Produces:** `FixtureRouter`, `AuthPersona`, `CompletionScenario`, `ApiScenarioController`, and `PersistedStateController` used by Task 7.

- [ ] **Step 1: Write service-level tests**

Prove known fixture routes fulfill; unknown `e2e-*` paths fail without fallback; ordinary traffic falls through; personas match auth contracts; each `CompletionScenario` installs the expected route behavior; deferred teardown fails until released/cancelled; request bodies are recorded; storage seeds are deterministic.

- [ ] **Step 2: Verify RED**

```bash
bun run --cwd apps/web test:e2e -- e2e/gameplay-fixtures/harness-services.spec.ts \
  --project=chromium-desktop --retries=0
```

- [ ] **Step 3: Implement total interception**

Register specific routes first. A URL containing the fixture ID is fulfilled or fails immediately; it never calls `fallback()`.

- [ ] **Step 4: Implement personas and API scenarios**

Use shared response types. Map the bounded `CompletionScenario` union to route behavior. Deferred routes expose `release()` and `cancel()`; teardown reports route and request details.

- [ ] **Step 5: Implement persistence controls**

Normal seeds use production validators/codecs. A separately named raw helper serves migration/corruption tests. Fresh contexts provide default isolation; explicit same-context reset clears cookies plus browser stores before reload.

- [ ] **Step 6: Verify and commit**

```bash
bun run --cwd apps/web test:e2e -- e2e/gameplay-fixtures/harness-services.spec.ts \
  --project=chromium-desktop --retries=0
git add apps/web/e2e/gameplay-fixtures
git commit -m "test(web): add deterministic gameplay harness services"
```

---

### Task 7: Create Canonical Test Fixture and `gotoFixture()`

**Files:**
- Create: `apps/web/e2e/support/test.ts`
- Create: `apps/web/e2e/support/diagnostics.ts`
- Create: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/support/test-fixture.spec.ts`

**Produces:**

```ts
export interface GotoFixtureOptions {
	persona?: AuthPersona;
	seedSession?: PersistedPuzzleSessionV1;
	seedStats?: unknown;
	clock?: { startAt: Date } | false;
	completion?: CompletionScenario;
}
```

- [ ] **Step 1: Write lifecycle-order tests**

Assert: fixture lookup → route registration → cookie reset → optional clock install → one atomic init script → navigation → ready state.

The single init script synchronously clears/seeds localStorage/sessionStorage and defines/deep-freezes `window.__PERSEUS_E2E_GAMEPLAY_V1__`. Do not register separate storage and config init scripts whose evaluation order is unspecified.

- [ ] **Step 2: Implement diagnostics**

Attach console errors, page errors, failed requests, unexpected responses, fixture/persona identity, API records, and pending deferred routes. Expected errors use narrow scenario allowlists.

- [ ] **Step 3: Implement canonical `test.extend`**

Export `test`/`expect`. Automatic teardown calls `assertSettled()` and `assertNoUnexpectedFixtureRequests()`.

- [ ] **Step 4: Implement `gotoFixture()`**

Install clock before any navigation when requested. Use one atomic init script. Wait for `puzzle-board` and expected tray count; never fixed delay.

- [ ] **Step 5: Verify existing suite compatibility**

```bash
bun run --cwd apps/web test:e2e -- e2e/support/test-fixture.spec.ts \
  e2e/gallery.spec.ts e2e/profile.spec.ts e2e/quick-puzzle.spec.ts \
  --project=chromium-desktop --retries=0
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/support
git commit -m "test(web): add shared gameplay E2E fixture"
```

---

### Task 8: Implement Interactions, Dialog Base, and WebKit Spike

**Files:**
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/gameplay-interactions.spec.ts`
- Create: `apps/web/e2e/webkit-drag-spike.spec.ts`

- [ ] **Step 1: Write rendered-UI tests**

Cover correct/rejected mouse placement, Enter/Space selection and placement, supported touch drag, source scoping through `piece-slot-${id}`, and current completion-dialog role/action/focus behavior.

- [ ] **Step 2: Implement mouse/keyboard**

Prefer `dragTo`; encapsulate any standards-shaped fallback privately. Attach bounds on failure. Keyboard verifies selection before target activation.

- [ ] **Step 3: Implement touch path**

Use Playwright touch/pointer APIs where possible; otherwise dispatch a bounded touch sequence from locator coordinates.

- [ ] **Step 4: Implement dialog base**

Locate dialogs by role and accessible name. Assert initial focus using `toBeFocused`, activate visible actions by role/name, and support only Escape or an accessible visible close button for dismissal. Do not add setup/pause/mobile-tray-specific selectors before their owning features exist.

- [ ] **Step 5: Verify Chromium/WebKit**

```bash
bun run --cwd apps/web test:e2e -- e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop --project=webkit-mobile --retries=0
```

- [ ] **Step 6: Run 20-pass WebKit spike**

```bash
bun run --cwd apps/web test:e2e -- e2e/webkit-drag-spike.spec.ts \
  --project=webkit-mobile --repeat-each=20 --retries=0 --workers=1
```

Zero failures permits `@webkit-critical`; any failure moves native mouse drag to `@extended`, keeps keyboard/touch critical, and requires a linked follow-up issue.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/support/gameplay-page.ts \
  apps/web/e2e/gameplay-interactions.spec.ts apps/web/e2e/webkit-drag-spike.spec.ts
git commit -m "test(web): add gameplay interaction driver"
```

---

### Task 9: Add Small-Fixture Smoke Coverage

**Files:**
- Create: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/puzzle-solving.spec.ts`

- [ ] **Step 1: Replace skipped known-puzzle/placement tests**

Add `@smoke` fixture load/placement coverage, then remove or migrate matching skips.

- [ ] **Step 2: Authenticated completion**

One rejected attempt, solve IDs 0–3 through UI, assert celebration, local stats, one successful request, deterministic run ID/result class/elapsed payload.

- [ ] **Step 3: Anonymous completion**

Assert celebration/local stats and exactly one attempted server request returning 401.

- [ ] **Step 4: Deferred retry**

Hold response, complete, expose retryable failure, use visible retry, then succeed with the same sealed payload.

- [ ] **Step 5: Timer integration**

Install clock, perform first counted action, advance exactly five seconds, finish, and assert timer UI plus sealed elapsed seconds.

- [ ] **Step 6: Persistence seed/reset**

Seed one placement/order and assert restoration. Fresh context starts empty with no canonical key.

- [ ] **Step 7: Verify and audit skips**

```bash
bun run --cwd apps/web test:e2e:smoke -- --retries=0
rg "test\.skip|describe\.skip" apps/web/e2e
```

Every remaining skip names the exact owning HPA ticket and missing UI dependency.

- [ ] **Step 8: Commit**

```bash
git add apps/web/e2e/gameplay-infrastructure.spec.ts apps/web/e2e/puzzle-solving.spec.ts
git commit -m "test(web): add deterministic gameplay smoke coverage"
```

---

### Task 10: Add Large-Layout and Accessibility Coverage

**Files:**
- Create: `apps/web/e2e/gameplay-large-fixtures.spec.ts`
- Create: `apps/web/e2e/support/accessibility.ts`
- Create: `apps/web/e2e/gameplay-accessibility.spec.ts`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add dependency**

```bash
bun add --cwd apps/web -d @axe-core/playwright
```

- [ ] **Step 2: Add ratio/large tests**

Assert 3 × 4 landscape, 4 × 3 portrait, usable layout by viewport, full 100/225 tray counts, and one representative interaction without full solve. Tag large cases `@extended`.

- [ ] **Step 3: Implement accessibility helper**

Use `AxeBuilder`; fail on serious/critical findings and attach full JSON. Add role-based focus, containment, and live-region helpers. Exclusions name owning tickets.

- [ ] **Step 4: Add scans**

Cover gallery, active gameplay, and current completion. Tag `@a11y`; do not claim manual screen-reader certification.

- [ ] **Step 5: Verify and commit**

```bash
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
git add apps/web/e2e/gameplay-large-fixtures.spec.ts \
  apps/web/e2e/support/accessibility.ts apps/web/e2e/gameplay-accessibility.spec.ts \
  apps/web/package.json bun.lock
git commit -m "test(web): add large-fixture and accessibility coverage"
```

---

### Task 11: Split CI Jobs and Document Harness

**Files:**
- Modify: `.github/workflows/e2e-test.yml`
- Create: `apps/web/e2e/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Split jobs**

Create:
1. production bundle safety without browser installation;
2. Chromium smoke;
3. WebKit critical;
4. extended/a11y on `main` and `workflow_dispatch`.

Browser jobs upload `apps/web/test-results` and `apps/web/playwright-report` on failure.

- [ ] **Step 2: Write README**

Document fixture directories/grids/IDs, total interception, virtual module/import rules, fallback semantics, atomic `gotoFixture()` init, clock/rAF implications, localStorage, completion matrix, deferred cleanup, cross-input and dialog-base extension rules, explicit project commands, WebKit result, Firefox deferral, browser dry-run, artifacts, a11y limits, and feature ownership.

- [ ] **Step 3: Update `CLAUDE.md`**

Link README, list smoke/extended commands, and require new gameplay tests to import `e2e/support/test`.

- [ ] **Step 4: Verify commands**

```bash
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web test:e2e:smoke -- --retries=0
bun run --cwd apps/web test:e2e:webkit -- --retries=0
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/e2e-test.yml apps/web/e2e/README.md CLAUDE.md
git commit -m "ci: split deterministic gameplay E2E jobs"
```

---

### Task 12: Full Stability Gate and Requirement Audit

**Files:**
- Modify only files proven necessary by failing verification.
- Update `apps/web/e2e/README.md` if actual WebKit results change the documented split.

- [ ] **Step 1: Static/unit checks**

```bash
bun run --cwd apps/web check
bun run --cwd apps/web lint
bun run --cwd apps/web test:unit
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
bun test apps/web/scripts/assert-browser-install.test.ts
```

- [ ] **Step 2: Build safety**

```bash
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web build:e2e
```

- [ ] **Step 3: Chromium stability**

```bash
bun run --cwd apps/web test:e2e:stability
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

- [ ] **Step 4: WebKit stability**

```bash
bun run --cwd apps/web test:e2e:webkit -- \
  --repeat-each=10 --retries=0 --workers=1
```

- [ ] **Step 5: Extended/a11y**

```bash
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
```

- [ ] **Step 6: Skip/wait/import audits**

```bash
rg "test\.skip|describe\.skip" apps/web/e2e
rg "waitForTimeout" apps/web/e2e
rg "e2e-gameplay-runtime|runtime-override|__PERSEUS_E2E_GAMEPLAY_V1__|e2e-square-4" \
  apps/web/src --glob '!lib/testing/**' --glob '!virtual-modules.d.ts'
```

- [ ] **Step 7: Record acceptance evidence**

Add a PR comment mapping each criterion to command output, fixture coverage, auth/completion behavior, WebKit decision, bundle scan counts, and artifact paths.

- [ ] **Step 8: Commit only if verification changed files**

```bash
git status --short
```

If output is empty, do not commit. Otherwise stage every listed path explicitly, verify `git diff --cached`, then run:

```bash
git commit -m "test(web): stabilize deterministic gameplay E2E suite"
```

---

## Execution Notes

- Execute from a fresh worktree based on latest `main` after the design/plan PR merges.
- Use TDD per task: focused failing test, minimal implementation, passing focused test, broader regression check.
- Keep one independently reviewable commit per task.
- If implementation contradicts the approved design, amend the design in a separate documentation commit before changing scope.
- HPA-218 through HPA-224 and HPA-237 remain responsible for feature-specific E2E scenarios.
