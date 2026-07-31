# Deterministic Gameplay Fixture and E2E Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic gameplay fixtures, browser-only runtime controls, reusable Playwright helpers, cross-browser projects, diagnostics, accessibility support, and representative smoke coverage for HPA-226.

**Architecture:** Playwright owns fixture metadata, synthetic assets, authentication personas, persistence seeding, and HTTP outcomes. Production code gains one route-level gameplay dependency adapter that consumes a build-time Vite virtual module: normal Vite/Vitest builds receive a no-op implementation, while the E2E preview receives a strict reader for configured `e2e-*` fixtures. Tests drive rendered UI and observable HTTP/state boundaries; they never dispatch PuzzleSession actions directly.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, SvelteKit 2 / Svelte 5, Vite 7, Vitest 4 browser mode, Playwright 1.57, `@axe-core/playwright`, GitHub Actions.

## Global Constraints

- Target the repository-pinned Playwright `1.57.0` contract.
- Use `trace: 'retain-on-failure'` and `screenshot: 'on-first-failure'`.
- Keep `failOnFlakyTests: Boolean(process.env.CI)` and zero retries in stability commands.
- Fixture piece IDs are zero-based: `id = row * cols + col`.
- Fixture rows and columns come from `getGridDimensionsForAspectRatio`; transposed grids are invalid.
- Every request containing an `e2e-*` fixture ID is intercepted before it reaches either backend runtime.
- Missing runtime configuration falls back only for ordinary API puzzles and `q-*` Quick Puzzles; an unconfigured `e2e-*` fixture is a hard error.
- A malformed or mismatched supplied runtime configuration is always a hard error.
- Normal production bundles contain no E2E reader, fixture ID, runtime global, or validation marker.
- New gameplay E2E tests use the shared extended `test` object and `GameplayPage`; do not add another per-file mock stack.
- `localStorage` is the canonical PuzzleSession persistence medium.
- `page.clock.install()` occurs before navigation in deterministic timer tests.
- `page.waitForTimeout()` is prohibited unless an inline comment names the browser behavior and explains why no observable signal exists.
- Native WebKit mouse drag is PR-blocking only after a 20-run, zero-retry `ubuntu-latest` headless-WebKit spike passes.
- Browser emulation does not certify physical-device gestures or assistive technology.

---

## File Structure

### Production and build boundary

- `apps/web/src/lib/services/gameplay/runtime.types.ts` — shared adapter/configuration types and pure validators.
- `apps/web/build/gameplay-runtime-override-plugin.ts` — testable pre-enforced Vite virtual-module plugin.
- `apps/web/src/virtual-modules.d.ts` — declaration for `virtual:perseus-gameplay-runtime-override`.
- `apps/web/src/lib/services/gameplay/runtime.ts` — route-level production adapter and virtual-module consumer.
- `apps/web/src/lib/testing/e2e-gameplay-runtime.ts` — strict E2E configuration reader.
- `apps/web/vite.config.ts` — installs the virtual-module plugin for Vite and browser-mode Vitest.
- `apps/web/eslint.config.js` — import restrictions preventing seam bypasses.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — adapts runtime dependencies into `createPuzzleSessionStore`.
- `apps/web/scripts/assert-no-e2e-harness.ts` — non-vacuous normal-build sentinel scanner.

### Playwright harness

- `apps/web/e2e/gameplay-fixtures/` — typed builder, catalog, padded SVGs, route controls, personas, API outcomes, persistence.
- `apps/web/e2e/support/test.ts` — canonical extended Playwright `test` and `expect`.
- `apps/web/e2e/support/diagnostics.ts` — automatic console, page-error, request, and scenario attachments.
- `apps/web/e2e/support/accessibility.ts` — axe, focus, and live-region helpers.
- `apps/web/e2e/support/gameplay-page.ts` — setup lifecycle and player-facing interaction methods.

### Verification suites

- `apps/web/src/lib/services/gameplay/runtime.test.ts`
- `apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts`
- `apps/web/build/gameplay-runtime-override-plugin.test.ts`
- `apps/web/e2e/playwright-clock-contract.spec.ts`
- `apps/web/e2e/gameplay-infrastructure.spec.ts`
- `apps/web/e2e/gameplay-large-fixtures.spec.ts`
- `apps/web/e2e/gameplay-accessibility.spec.ts`
- `apps/web/e2e/README.md`

---

### Task 0: Establish the No-Op Virtual Module Foundation

**Files:**
- Create: `apps/web/src/lib/services/gameplay/runtime.types.ts`
- Create: `apps/web/build/gameplay-runtime-override-plugin.ts`
- Create: `apps/web/build/gameplay-runtime-override-plugin.test.ts`
- Create: `apps/web/src/virtual-modules.d.ts`
- Modify: `apps/web/vite.config.ts`

**Interfaces:**

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
```

```ts
export function gameplayRuntimeOverridePlugin(options?: {
	harnessEnabled?: boolean;
	readerPath?: string;
}): Plugin;
```

- [ ] **Step 1: Write failing plugin tests**

Test the plugin by calling `resolveId` and `load` directly:

```ts
it('resolves only the exact virtual id', async () => {
	const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
	expect(await plugin.resolveId?.call({} as never, 'virtual:perseus-gameplay-runtime-override')).toBe(
		'\0virtual:perseus-gameplay-runtime-override'
	);
	expect(await plugin.resolveId?.call({} as never, './runtime-override')).toBeNull();
});

it('emits a no-op module for ordinary Vite and Vitest', async () => {
	const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
	const code = await plugin.load?.call(
		{} as never,
		'\0virtual:perseus-gameplay-runtime-override'
	);
	expect(String(code)).toContain('return null');
	expect(String(code)).not.toContain('e2e-gameplay-runtime');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
```

Expected: FAIL because the plugin does not exist.

- [ ] **Step 3: Implement shared types and the no-op-capable plugin**

Use these IDs:

```ts
const virtualId = 'virtual:perseus-gameplay-runtime-override';
const resolvedVirtualId = `\0${virtualId}`;
```

The plugin uses `enforce: 'pre'`. With `harnessEnabled: false`, `load()` returns an inline module exporting `readGameplayRuntimeOverride()` that returns `null`. With `harnessEnabled: true`, it re-exports from `readerPath`; Task 2 supplies and validates that concrete file.

- [ ] **Step 4: Add the TypeScript declaration**

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

- [ ] **Step 5: Install the plugin in `vite.config.ts`**

Place it before Tailwind and SvelteKit plugins:

```ts
plugins: [
	gameplayRuntimeOverridePlugin(),
	tailwindcss(),
	sveltekit()
]
```

The default factory reads `PERSEUS_E2E_HARNESS === '1'` once when the config is created. Ordinary Vite and browser-mode Vitest therefore receive the no-op module.

- [ ] **Step 6: Run focused, type, and existing unit checks**

```bash
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
bun run --cwd apps/web check
bun run --cwd apps/web test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/src/lib/services/gameplay/runtime.types.ts \
  apps/web/build/gameplay-runtime-override-plugin.ts \
  apps/web/build/gameplay-runtime-override-plugin.test.ts \
  apps/web/src/virtual-modules.d.ts \
  apps/web/vite.config.ts
git commit -m "test(web): add gameplay runtime virtual module"
```

---

### Task 1: Extract the Production Gameplay Runtime Adapter

**Files:**
- Create: `apps/web/src/lib/services/gameplay/runtime.ts`
- Create: `apps/web/src/lib/services/gameplay/runtime.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**

```ts
export function createGameplayRuntimeDependencies(
	puzzleId: string,
	pieceIds: readonly number[]
): GameplayRuntimeDependencies;
```

- [ ] **Step 1: Write failing adapter tests**

Mock the already-resolvable virtual module to return `null`, and mock shuffle to reverse IDs. Assert initial/restart order and complete rotation keys. Add a test where the virtual module returns a fixed override and production shuffle is not called.

```ts
vi.mock('virtual:perseus-gameplay-runtime-override', () => ({
	readGameplayRuntimeOverride: vi.fn(() => null)
}));
```

- [ ] **Step 2: Run and verify RED**

```bash
bun run --cwd apps/web test:unit -- src/lib/services/gameplay/runtime.test.ts
```

Expected: FAIL because `runtime.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

1. Call `readGameplayRuntimeOverride({ puzzleId, pieceIds })`.
2. Return the override when non-null.
3. Otherwise use `createBrowserRunIdFactory`, `shuffleArray`, and the current puzzle-ID/piece-ID rotation seed.
4. Clone arrays/objects at each return boundary.
5. Validate production-generated tray orders as complete permutations before returning them.

- [ ] **Step 4: Refactor the puzzle route**

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

Preserve hydration, subscription, auto-start, completion-effect, and checkpoint ordering.

- [ ] **Step 5: Update route tests**

Mock `createGameplayRuntimeDependencies` with fixed orders/rotations. Assert a fresh route consumes the configured initial order and restart consumes the restart factory through the real session engine.

- [ ] **Step 6: Run focused and route tests**

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/runtime.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/src/lib/services/gameplay/runtime.ts \
  apps/web/src/lib/services/gameplay/runtime.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor(web): add gameplay runtime adapter"
```

---

### Task 2: Implement the Strict E2E Runtime Reader and Import Guardrails

**Files:**
- Create: `apps/web/src/lib/testing/e2e-gameplay-runtime.ts`
- Create: `apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts`
- Modify: `apps/web/build/gameplay-runtime-override-plugin.test.ts`
- Modify: `apps/web/eslint.config.js`

**Interfaces:**

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

- [ ] **Step 1: Write reader activation tests**

Cover:
- absent global + ordinary ID → `null`;
- absent global + `q-*` → `null`;
- absent global + `e2e-*` → `PERSEUS_E2E_CONFIG: missing`;
- malformed global on any ID → hard error;
- fixture mismatch → hard error;
- global must be frozen;
- run IDs satisfy `isPuzzleRunId`;
- initial/restart orders are complete permutations;
- rotations contain exactly canonical IDs and valid values;
- sequence exhaustion throws;
- returned arrays/objects are clones.

- [ ] **Step 2: Run and verify RED**

```bash
bun run --cwd apps/web test:unit -- src/lib/testing/e2e-gameplay-runtime.test.ts
```

Expected: FAIL because the reader does not exist.

- [ ] **Step 3: Implement the strict reader**

Use `PERSEUS_E2E_CONFIG:` for every configuration error. Validate the entire frozen global before creating closures. Keep run-ID/restart-order cursors inside the returned dependency object. Never fall back to production randomness after a config is present.

- [ ] **Step 4: Prove the harness plugin re-exports the concrete reader**

Extend the plugin test with an explicit `readerPath` and `harnessEnabled: true`. Assert generated code re-exports from that exact normalized path and contains no inline fallback.

- [ ] **Step 5: Add ESLint restrictions**

Use `no-restricted-imports` to reject from production source:
- `$lib/testing/e2e-gameplay-runtime`;
- relative paths ending in `e2e-gameplay-runtime`;
- any `runtime-override` path.

Add a narrow override allowing `runtime.ts` to import only `virtual:perseus-gameplay-runtime-override`. Testing files may import the concrete reader directly.

- [ ] **Step 6: Run verification**

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/runtime.test.ts \
  src/lib/testing/e2e-gameplay-runtime.test.ts
bun test apps/web/build/gameplay-runtime-override-plugin.test.ts
bun run --cwd apps/web check
bun run --cwd apps/web lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/src/lib/testing/e2e-gameplay-runtime.ts \
  apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts \
  apps/web/build/gameplay-runtime-override-plugin.test.ts \
  apps/web/eslint.config.js
git commit -m "test(web): enforce deterministic runtime configuration"
```

---

### Task 3: Add a Non-Vacuous Production-Bundle Safety Check

**Files:**
- Create: `apps/web/scripts/assert-no-e2e-harness.ts`
- Create: `apps/web/scripts/assert-no-e2e-harness.test.ts`
- Modify: `apps/web/package.json`
- Modify: `.github/workflows/e2e-test.yml`

**Interface:**

```ts
export async function assertNoE2EHarness(buildDirectory: string): Promise<{
	filesScanned: number;
	bytesScanned: number;
}>;
```

- [ ] **Step 1: Write scanner tests**

Use temporary directories to prove missing, empty, no-JavaScript, unreadable, and sentinel-containing output fails. A clean nested build returns positive file and byte counts.

Sentinels:

```ts
const SENTINELS = [
	'__PERSEUS_E2E_GAMEPLAY_V1__',
	'e2e-square-4',
	'PERSEUS_E2E_CONFIG:',
	'e2e-gameplay-runtime.ts'
] as const;
```

- [ ] **Step 2: Run and verify RED**

```bash
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
```

- [ ] **Step 3: Implement recursive scanning**

Resolve `apps/web/build/` from the web app directory. Sort paths for stable output. Require at least one readable `.js` file and positive total bytes. Report every sentinel and source file before exiting non-zero.

- [ ] **Step 4: Add package scripts**

```json
"build:e2e": "PERSEUS_E2E_HARNESS=1 bun run build",
"test:e2e:assert-production-bundle": "bun run build && bun scripts/assert-no-e2e-harness.ts"
```

- [ ] **Step 5: Wire `.github/workflows/e2e-test.yml`**

After dependency installation and before browser installation:

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

- [ ] **Step 1: Write the clock contract**

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

- [ ] **Step 2: Write browser-install dry-run parser tests**

Require `chromium-headless-shell` and `webkit`, and reject a full Chromium browser entry. Matching tolerates version/URL changes but not browser-name changes.

- [ ] **Step 3: Expand Playwright configuration**

Add:
- `failOnFlakyTests: Boolean(process.env.CI)`;
- `retries: process.env.CI ? 1 : 0`;
- `trace: 'retain-on-failure'`;
- `screenshot: 'on-first-failure'`;
- GitHub + HTML reporters in CI, list + HTML locally;
- projects: Chromium desktop/mobile/tablet and WebKit mobile/tablet;
- `build:e2e` for the web preview server;
- existing API server environment unchanged.

Viewport sizes:
- 1440 × 900;
- 390 × 844;
- 768 × 1024.

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

- [ ] **Step 5: Implement browser-install assertion and run RED/GREEN**

```bash
bun test apps/web/scripts/assert-browser-install.test.ts
bun run --cwd apps/web test:install-browsers:dry-run | bun apps/web/scripts/assert-browser-install.ts
```

- [ ] **Step 6: Install browsers and run the clock probe**

```bash
bun run --cwd apps/web test:install-browsers
bun run --cwd apps/web test:e2e -- \
  e2e/playwright-clock-contract.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

Expected: exact 2,000 ms advancement.

- [ ] **Step 7: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/package.json \
  apps/web/e2e/playwright-clock-contract.spec.ts apps/web/scripts/assert-browser-install*
git commit -m "test(web): add Playwright projects and contract probes"
```

---

### Task 5: Build the Deterministic Fixture Catalog and Padded Assets

**Files:**
- Create: `apps/web/e2e/gameplay-fixtures/builder.ts`
- Create: `apps/web/e2e/gameplay-fixtures/builder.test.ts`
- Create: `apps/web/e2e/gameplay-fixtures/catalog.ts`
- Create: `apps/web/e2e/gameplay-fixtures/catalog.test.ts`
- Create: `apps/web/e2e/gameplay-fixtures/assets.ts`
- Create: `apps/web/e2e/gameplay-fixtures/assets.test.ts`

**Interfaces:**

```ts
export type GameplayFixtureId =
	| 'e2e-square-4'
	| 'e2e-landscape-12'
	| 'e2e-portrait-12'
	| 'e2e-square-100'
	| 'e2e-square-225';

export interface GameplayFixture {
	id: GameplayFixtureId;
	puzzle: Puzzle;
	aspectRatio: PuzzleAspectRatio;
	initialTrayOrder: readonly number[];
	restartTrayOrders: readonly (readonly number[])[];
	rotations: Readonly<Record<number, Rotation>>;
	runIds: readonly string[];
}
```

- [ ] **Step 1: Write invariant tests**

Assert exact grids:
- 1:1/4 → 2 × 2;
- 4:3/12 → 3 × 4;
- 3:4/12 → 4 × 3;
- 1:1/100 → 10 × 10;
- 1:1/225 → 15 × 15.

Also assert zero-based IDs, unique coordinates, flat outer edges, complementary neighbors, complete tray permutations, valid rotations, and valid unique run IDs.

- [ ] **Step 2: Run and verify RED**

```bash
bun test apps/web/e2e/gameplay-fixtures/builder.test.ts
```

- [ ] **Step 3: Implement the builder**

Use `getGridDimensionsForAspectRatio` and shared edge helpers. Do not accept caller-supplied unchecked rows/columns. Freeze catalog values or clone at consumer boundaries.

- [ ] **Step 4: Define five immutable fixtures**

Use fixed UUIDv4-shaped run IDs, fixed timestamps, literal deterministic tray permutations, and fixed rotation maps.

- [ ] **Step 5: Implement padded SVGs**

Generate XML-safe, dependency-free SVGs with transparent padding compatible with `TAB_RATIO` and `EXPANSION_FACTOR`. Include fixture ID, piece ID, and coordinates; do not use remote fonts/assets.

- [ ] **Step 6: Run fixture tests**

```bash
bun test apps/web/e2e/gameplay-fixtures/*.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/gameplay-fixtures
git commit -m "test(web): add deterministic gameplay fixture catalog"
```

---

### Task 6: Add Fixture Routing, Personas, API Outcomes, and Persistence Controls

**Files:**
- Create: `apps/web/e2e/gameplay-fixtures/fixture-router.ts`
- Create: `apps/web/e2e/gameplay-fixtures/auth-persona.ts`
- Create: `apps/web/e2e/gameplay-fixtures/api-scenario.ts`
- Create: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Create: `apps/web/e2e/gameplay-fixtures/harness-services.spec.ts`

**Interfaces:**

```ts
export interface FixtureRouter {
	install(page: Page, fixture: GameplayFixture): Promise<void>;
	assertNoUnexpectedFixtureRequests(): void;
}

export type AuthPersona =
	| { kind: 'anonymous' }
	| { kind: 'authenticated'; user: PlayerUser }
	| { kind: 'deferred'; release: () => Promise<void> }
	| { kind: 'failed'; status: number };

export interface ApiScenarioController {
	completeWithSuccess(): void;
	completeWithDeferredSuccess(): DeferredRoute;
	completeWithHttpFailure(status: 400 | 401 | 404 | 409 | 429 | 500): void;
	completeWithNetworkAbort(): void;
	requests(): readonly RecordedRequest[];
	assertSettled(): void;
}
```

- [ ] **Step 1: Write service-level Playwright tests**

Prove known fixture routes fulfill; unknown `e2e-*` paths fail without backend fallback; ordinary traffic falls through; personas match auth contracts; deferred teardown fails until released/cancelled; request bodies are recorded; reset/seed controls modify canonical localStorage deterministically.

- [ ] **Step 2: Run and verify RED**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/gameplay-fixtures/harness-services.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

- [ ] **Step 3: Implement total fixture interception**

Register specific routes before broad routes. Any URL containing the fixture ID is either fulfilled by a known handler or fails immediately; never call `fallback()` for `e2e-*` traffic.

- [ ] **Step 4: Implement personas and API scenarios**

Use shared response types. Deferred routes expose explicit `release()` and `cancel()`. `assertSettled()` reports route name and request details.

- [ ] **Step 5: Implement persistence controls**

Use production codecs/validators for normal seeds. Provide a separately named raw-storage helper only for migration/corruption tests. Reset cookies, localStorage, sessionStorage, and defensively present IndexedDB/Cache Storage.

- [ ] **Step 6: Run GREEN and commit**

```bash
bun run --cwd apps/web test:e2e -- e2e/gameplay-fixtures/harness-services.spec.ts \
  --project=chromium-desktop --retries=0
git add apps/web/e2e/gameplay-fixtures
git commit -m "test(web): add deterministic gameplay harness services"
```

---

### Task 7: Create the Canonical Extended Test Fixture and `gotoFixture()`

**Files:**
- Create: `apps/web/e2e/support/test.ts`
- Create: `apps/web/e2e/support/diagnostics.ts`
- Create: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/support/test-fixture.spec.ts`

**Interface:**

```ts
export interface GotoFixtureOptions {
	persona?: AuthPersona;
	seedSession?: PersistedPuzzleSessionV1;
	seedStats?: unknown;
	clock?: { startAt: Date } | false;
	completion?: CompletionScenario;
}

export class GameplayPage {
	gotoFixture(id: GameplayFixtureId, options?: GotoFixtureOptions): Promise<void>;
	expectReady(): Promise<void>;
}
```

- [ ] **Step 1: Write lifecycle-order tests**

Assert order: fixture lookup → routes → reset/seed → frozen init-script global → optional clock install → navigation → observable ready state. Add unconfigured `e2e-*` failure and ordinary/Quick Puzzle fallback tests.

- [ ] **Step 2: Implement automatic diagnostics**

Attach console errors, page errors, failed requests, unexpected non-success responses, fixture/persona identity, API request records, and pending deferred routes. Expected errors require narrow scenario allowlists.

- [ ] **Step 3: Implement canonical `test.extend`**

Export `test`/`expect`. Automatic teardown calls `assertSettled()` and `assertNoUnexpectedFixtureRequests()`.

- [ ] **Step 4: Implement `gotoFixture()`**

Use `page.addInitScript` before navigation. Deep-freeze config. Install clock before any page operation when requested. Wait for `puzzle-board` and expected tray-piece count, never a fixed delay.

- [ ] **Step 5: Verify existing suite compatibility**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/support/test-fixture.spec.ts \
  e2e/gallery.spec.ts \
  e2e/profile.spec.ts \
  e2e/quick-puzzle.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/support
git commit -m "test(web): add shared gameplay E2E fixture"
```

---

### Task 8: Implement Player-Facing Interaction Methods and WebKit Spike

**Files:**
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/gameplay-interactions.spec.ts`
- Create: `apps/web/e2e/webkit-drag-spike.spec.ts`

**Interface:**

```ts
placeWithMouse(pieceId: number, x: number, y: number): Promise<void>;
selectAndPlaceWithKeyboard(pieceId: number, x: number, y: number): Promise<void>;
tapPiece(pieceId: number): Promise<void>;
dragWithTouch(pieceId: number, x: number, y: number): Promise<void>;
expectPiecePlaced(pieceId: number, x: number, y: number): Promise<void>;
```

- [ ] **Step 1: Write rendered-UI interaction tests**

Cover correct/rejected mouse placement, Enter/Space selection and placement, supported touch drag, and source scoping through `piece-slot-${id}`.

- [ ] **Step 2: Implement mouse and keyboard methods**

Prefer `dragTo`. Encapsulate any standards-shaped drag-event fallback privately. Attach source/target bounds on failure. Keyboard flow verifies selected state before target activation.

- [ ] **Step 3: Implement current touch path**

Use Playwright touch/pointer APIs where possible; otherwise dispatch a bounded touch sequence using locator-derived coordinates.

- [ ] **Step 4: Run Chromium/WebKit compatibility**

```bash
bun run --cwd apps/web test:e2e -- e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop --project=webkit-mobile --retries=0
```

- [ ] **Step 5: Run the 20-pass WebKit drag spike**

```bash
bun run --cwd apps/web test:e2e -- e2e/webkit-drag-spike.spec.ts \
  --project=webkit-mobile --repeat-each=20 --retries=0 --workers=1
```

Zero failures permits `@webkit-critical`; any failure moves native mouse drag to `@extended`, keeps keyboard/touch critical, and requires a linked follow-up issue.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/support/gameplay-page.ts \
  apps/web/e2e/gameplay-interactions.spec.ts apps/web/e2e/webkit-drag-spike.spec.ts
git commit -m "test(web): add gameplay interaction driver"
```

---

### Task 9: Add Small-Fixture Completion, Auth, Timer, and Persistence Smoke

**Files:**
- Create: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/puzzle-solving.spec.ts`

- [ ] **Step 1: Replace skipped known-puzzle/placement coverage**

Add `@smoke` fixture load and placement tests, then remove or migrate the matching skips so each scenario has one owner.

- [ ] **Step 2: Add authenticated completion**

One rejected attempt, solve pieces 0–3 through UI, assert celebration, local stats, one successful request, deterministic run ID/result class/elapsed payload.

- [ ] **Step 3: Add anonymous completion**

Assert celebration/local stats still succeed and exactly one server submission attempt records 401. Do not assert “no request.”

- [ ] **Step 4: Add deferred retry**

Hold response, complete board, expose retryable failure, activate visible retry, then succeed. Initial and retry requests use the same sealed payload.

- [ ] **Step 5: Add deterministic timer integration**

Install clock, perform first counted action, advance exactly five seconds, finish, and assert timer UI plus sealed request elapsed seconds.

- [ ] **Step 6: Add persistence seed/reset**

Seed one placed piece and known order; assert restoration. Fresh context without seed starts empty and lacks the canonical key.

- [ ] **Step 7: Run smoke and audit skips**

```bash
bun run --cwd apps/web test:e2e:smoke -- --retries=0
rg "test\.skip|describe\.skip" apps/web/e2e
```

Every remaining skip must name the exact owning HPA ticket and missing UI dependency.

- [ ] **Step 8: Commit**

```bash
git add apps/web/e2e/gameplay-infrastructure.spec.ts apps/web/e2e/puzzle-solving.spec.ts
git commit -m "test(web): add deterministic gameplay smoke coverage"
```

---

### Task 10: Add Aspect-Ratio, Large-Layout, and Accessibility Coverage

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

Assert 3 × 4 landscape, 4 × 3 portrait, usable board/control layout by viewport, full 100/225 tray counts, and one representative interaction without full solve. Tag large cases `@extended`.

- [ ] **Step 3: Implement accessibility helper**

Use `AxeBuilder`; fail on serious/critical findings; attach full JSON. Provide role-based initial-focus, containment, and live-region helpers. Exclusions require comments naming owning feature tickets.

- [ ] **Step 4: Add gallery/gameplay/current-completion scans**

Tag `@a11y`. Do not claim manual screen-reader certification.

- [ ] **Step 5: Run explicit matrices**

```bash
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/gameplay-large-fixtures.spec.ts \
  apps/web/e2e/support/accessibility.ts apps/web/e2e/gameplay-accessibility.spec.ts \
  apps/web/package.json bun.lock
git commit -m "test(web): add large-fixture and accessibility coverage"
```

---

### Task 11: Split CI Jobs and Document the Harness

**Files:**
- Modify: `.github/workflows/e2e-test.yml`
- Create: `apps/web/e2e/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Split workflow jobs**

Create bounded jobs:
1. production bundle safety, no browser install;
2. Chromium smoke;
3. WebKit critical;
4. extended/a11y on main, manual trigger, or documented schedule.

Browser jobs upload `apps/web/test-results` and `apps/web/playwright-report` on failure.

- [ ] **Step 2: Document the harness**

README covers fixture directories, exact grids/zero-based IDs, total interception, virtual module/import restrictions, fallback semantics, `gotoFixture()` order, clock/rAF implications, localStorage, completion matrix, deferred cleanup, commands, WebKit spike result, browser install dry-run, artifacts, accessibility limitations, and feature ownership.

- [ ] **Step 3: Update `CLAUDE.md`**

Link the README, list smoke/extended commands, and require new gameplay tests to import from `e2e/support/test`.

- [ ] **Step 4: Validate commands**

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

### Task 12: Run the Full Stability Gate and Requirement Audit

**Files:**
- Modify only files required to fix verified failures.
- Update `apps/web/e2e/README.md` only if the actual WebKit result differs from the planned critical/extended split.

- [ ] **Step 1: Static and unit verification**

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

- [ ] **Step 3: Repeated Chromium smoke**

```bash
bun run --cwd apps/web test:e2e:stability
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

- [ ] **Step 4: Repeated WebKit critical**

```bash
bun run --cwd apps/web test:e2e:webkit -- \
  --repeat-each=10 --retries=0 --workers=1
```

- [ ] **Step 5: Extended and accessibility**

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

Expected: no unexplained gameplay skip, no unjustified timeout, and only the approved virtual import in production source.

- [ ] **Step 7: Record acceptance evidence**

Add a PR comment mapping each HPA-226 criterion to command output, fixture coverage, auth/completion behavior, WebKit decision, bundle scan counts, and artifact paths.

- [ ] **Step 8: Commit only verification-driven fixes**

```bash
git add <only-files-changed-to-fix-failing-verification>
git commit -m "test(web): stabilize deterministic gameplay E2E suite"
```

Do not create an empty commit.

---

## Execution Notes

- Implement from a fresh worktree based on the latest `main` after the design/plan PR is merged.
- Use test-driven development for each task: focused failing test, minimal implementation, passing focused test, then broader regression checks.
- Keep one independently reviewable commit per task; do not batch unrelated tasks.
- If implementation reveals a contradiction with the approved design, amend the design in a separate documentation commit before changing scope.
- HPA-218 through HPA-224 and HPA-237 consume this foundation and remain responsible for feature-specific E2E scenarios.
