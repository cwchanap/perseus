# Deterministic Gameplay Fixture and E2E Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic gameplay fixtures, browser-only runtime controls, reusable Playwright helpers, cross-browser projects, diagnostics, accessibility support, and representative smoke coverage for HPA-226.

**Architecture:** Keep fixture metadata, synthetic assets, authentication personas, and API outcomes inside Playwright. Add one route-level gameplay dependency adapter and a build-time Vite virtual module so an E2E build can inject deterministic run IDs, tray orders, and rotations for `e2e-*` fixtures while ordinary and Quick Puzzle routes retain production behavior. Tests drive rendered UI and observable HTTP/state boundaries; they never dispatch PuzzleSession actions directly.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, SvelteKit 2 / Svelte 5, Vite 7, Vitest 4 browser mode, Playwright 1.57, `@axe-core/playwright`, GitHub Actions.

## Global Constraints

- Target the repository-pinned Playwright `1.57.0` contract.
- Use `trace: 'retain-on-failure'` and `screenshot: 'on-first-failure'`.
- Keep `failOnFlakyTests: Boolean(process.env.CI)` and zero retries in stability commands.
- Fixture piece IDs are zero-based: `id = row * cols + col`.
- Fixture rows and columns come from `getGridDimensionsForAspectRatio`; transposed grids are invalid.
- Every request containing an `e2e-*` fixture ID is intercepted before it reaches either backend runtime.
- Missing E2E runtime configuration falls back only for ordinary API puzzles and `q-*` Quick Puzzles; missing configuration for an `e2e-*` fixture is a hard error.
- A malformed or mismatched supplied E2E runtime configuration is always a hard error.
- Production builds contain no E2E reader, fixture ID, runtime global, or validation marker.
- New gameplay E2E tests use the shared extended `test` object and `GameplayPage`; do not add another per-file mock stack.
- `localStorage` is the canonical PuzzleSession persistence medium.
- `page.clock.install()` must occur before navigation in deterministic timer tests.
- `page.waitForTimeout()` is prohibited unless an inline comment names the browser behavior and explains why no observable signal exists.
- WebKit native mouse drag is PR-blocking only after a 20-run, zero-retry `ubuntu-latest` headless-WebKit spike passes.
- Browser emulation does not certify physical-device gestures or assistive technology.

---

## File Structure

### Production and build boundary

- `apps/web/src/lib/services/gameplay/runtime.ts` — route-level production dependency adapter and virtual-module consumer.
- `apps/web/src/lib/services/gameplay/runtime.types.ts` — shared runtime and E2E configuration types plus validators that do not import browser globals.
- `apps/web/src/lib/testing/e2e-gameplay-runtime.ts` — concrete E2E reader used only by the harness build.
- `apps/web/src/virtual-modules.d.ts` — TypeScript declaration for `virtual:perseus-gameplay-runtime-override`.
- `apps/web/vite.config.ts` — pre-enforced virtual module plugin; no-op for ordinary Vite/Vitest, E2E reader for `PERSEUS_E2E_HARNESS=1`.
- `apps/web/eslint.config.js` — import restrictions that prevent bypassing the virtual module.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — consumes the runtime adapter and passes adapted values into `createPuzzleSessionStore`.
- `apps/web/scripts/assert-no-e2e-harness.ts` — non-vacuous normal-build sentinel scanner.

### Deterministic fixture and harness services

- `apps/web/e2e/gameplay-fixtures/builder.ts` — pure fixture builder and invariant checks.
- `apps/web/e2e/gameplay-fixtures/catalog.ts` — five immutable fixture definitions.
- `apps/web/e2e/gameplay-fixtures/assets.ts` — padded deterministic SVG generation.
- `apps/web/e2e/gameplay-fixtures/fixture-router.ts` — complete HTTP interception for fixture data and assets.
- `apps/web/e2e/gameplay-fixtures/auth-persona.ts` — anonymous/authenticated/delayed/failed session responses.
- `apps/web/e2e/gameplay-fixtures/api-scenario.ts` — immediate, deferred, retryable, and terminal HTTP outcomes.
- `apps/web/e2e/gameplay-fixtures/persisted-state.ts` — validated localStorage seeding and reset.
- `apps/web/e2e/support/test.ts` — canonical extended Playwright `test` and `expect` exports.
- `apps/web/e2e/support/diagnostics.ts` — automatic console, page-error, request, and scenario attachments.
- `apps/web/e2e/support/accessibility.ts` — axe, focus, and live-region helpers.
- `apps/web/e2e/support/gameplay-page.ts` — setup lifecycle plus player-facing interaction methods.

### Verification suites

- `apps/web/src/lib/services/gameplay/runtime.test.ts` — production adapter tests.
- `apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts` — configuration validation and activation tests.
- `apps/web/src/lib/services/gameplay/runtime-virtual-module.test.ts` — Vite plugin/no-op behavior tests where practical.
- `apps/web/e2e/playwright-clock-contract.spec.ts` — pure Playwright clock contract.
- `apps/web/e2e/gameplay-infrastructure.spec.ts` — small-fixture load, completion, auth, timer, persistence, and input smoke.
- `apps/web/e2e/gameplay-large-fixtures.spec.ts` — aspect-ratio and large-layout coverage.
- `apps/web/e2e/gameplay-accessibility.spec.ts` — gallery/gameplay/current-completion scans.
- `apps/web/e2e/README.md` — fixture lifecycle, commands, security boundary, and debugging.

---

### Task 1: Extract the Route-Level Gameplay Runtime Adapter

**Files:**
- Create: `apps/web/src/lib/services/gameplay/runtime.types.ts`
- Create: `apps/web/src/lib/services/gameplay/runtime.ts`
- Create: `apps/web/src/lib/services/gameplay/runtime.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Produces:

```ts
export interface GameplayRuntimeDependencies {
	runIdFactory: RunIdFactory;
	createInitialTrayOrder(pieceIds: readonly number[]): number[];
	createRestartTrayOrder(pieceIds: readonly number[]): number[];
	createRotations(
		puzzleId: string,
		pieceIds: readonly number[]
	): Record<number, Rotation>;
}

export interface GameplayRuntimeOverrideContext {
	puzzleId: string;
	pieceIds: readonly number[];
}

export function createGameplayRuntimeDependencies(
	puzzleId: string,
	pieceIds: readonly number[]
): GameplayRuntimeDependencies;
```

- Consumes the virtual module defined in Task 2:

```ts
import { readGameplayRuntimeOverride } from 'virtual:perseus-gameplay-runtime-override';
```

- [ ] **Step 1: Write failing production-adapter tests**

Create `runtime.test.ts` with deterministic mocks around the existing factories:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGameplayRuntimeDependencies } from './runtime';

vi.mock('virtual:perseus-gameplay-runtime-override', () => ({
	readGameplayRuntimeOverride: vi.fn(() => null)
}));

vi.mock('$lib/utils/shuffle', () => ({
	shuffleArray: vi.fn((ids: readonly number[]) => [...ids].reverse())
}));

it('adapts production run id, tray order, and puzzle-derived rotations', () => {
	const runtime = createGameplayRuntimeDependencies('puzzle-a', [0, 1, 2, 3]);

	expect(runtime.createInitialTrayOrder([0, 1, 2, 3])).toEqual([3, 2, 1, 0]);
	expect(runtime.createRestartTrayOrder([0, 1, 2, 3])).toEqual([3, 2, 1, 0]);
	expect(Object.keys(runtime.createRotations('puzzle-a', [0, 1, 2, 3]))).toEqual([
		'0',
		'1',
		'2',
		'3'
	]);
});
```

Add a second test that supplies an override object and proves the adapter returns it without invoking production shuffle.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run --cwd apps/web test:unit -- src/lib/services/gameplay/runtime.test.ts
```

Expected: FAIL because `runtime.ts` and the virtual module declaration do not exist.

- [ ] **Step 3: Implement the shared types and production adapter**

In `runtime.types.ts`, export the interfaces above plus a helper that validates a returned tray order is a complete permutation of canonical IDs.

In `runtime.ts`:

1. Call `readGameplayRuntimeOverride({ puzzleId, pieceIds })`.
2. Return the override when non-null.
3. Otherwise return production dependencies using:
   - `createBrowserRunIdFactory()`;
   - `shuffleArray([...pieceIds])` for initial/restart order;
   - the existing puzzle-ID-and-piece-ID hash before `generateRandomRotations`.
4. Clone every returned array/object so callers cannot retain mutable internal references.

- [ ] **Step 4: Refactor the puzzle route to use the adapter**

Replace direct route-level construction of `runIdFactory`, shuffled tray order, and rotation callback with:

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

Preserve all existing hydration, start, completion-effect, and checkpoint ordering.

- [ ] **Step 5: Update route tests to mock the adapter boundary**

In `page.svelte.test.ts`, mock `createGameplayRuntimeDependencies` with fixed IDs/orders/rotations. Add an assertion that a fresh route passes the configured initial order and a restart consumes the next restart order through the real session store.

- [ ] **Step 6: Run focused and route tests**

Run:

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/runtime.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/src/lib/services/gameplay/runtime.types.ts \
  apps/web/src/lib/services/gameplay/runtime.ts \
  apps/web/src/lib/services/gameplay/runtime.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "refactor(web): add gameplay runtime adapter"
```

---

### Task 2: Add the Build-Time Virtual Module and Strict E2E Reader

**Files:**
- Create: `apps/web/src/lib/testing/e2e-gameplay-runtime.ts`
- Create: `apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts`
- Create: `apps/web/src/virtual-modules.d.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/eslint.config.js`

**Interfaces:**
- Produces:

```ts
export interface PerseusE2EGameplayConfigV1 {
	version: 1;
	fixtureId: string;
	runIds: readonly string[];
	initialTrayOrder: readonly number[];
	restartTrayOrders: readonly (readonly number[])[];
	rotations: Readonly<Record<number, Rotation>>;
}

export function readGameplayRuntimeOverride(
	context: GameplayRuntimeOverrideContext
): GameplayRuntimeDependencies | null;
```

- [ ] **Step 1: Write activation and validation tests**

Create direct-reader tests covering this exact matrix:

```ts
it.each([
	['ordinary-id', null],
	['q-local-id', null]
])('returns null without config for %s', (puzzleId, expected) => {
	delete window.__PERSEUS_E2E_GAMEPLAY_V1__;
	expect(readGameplayRuntimeOverride({ puzzleId, pieceIds: [0, 1, 2, 3] })).toBe(expected);
});

it('throws when an e2e fixture has no config', () => {
	delete window.__PERSEUS_E2E_GAMEPLAY_V1__;
	expect(() =>
		readGameplayRuntimeOverride({ puzzleId: 'e2e-square-4', pieceIds: [0, 1, 2, 3] })
	).toThrow(/PERSEUS_E2E_CONFIG: missing/);
});
```

Also test:
- malformed global on any puzzle throws;
- fixture mismatch throws;
- global must be frozen;
- run IDs satisfy `isPuzzleRunId`;
- initial/restart orders are complete permutations;
- rotations contain exactly canonical IDs and valid values;
- sequence exhaustion throws rather than falling back;
- arrays/objects returned to the session are clones.

- [ ] **Step 2: Run the reader tests and verify RED**

Run:

```bash
bun run --cwd apps/web test:unit -- src/lib/testing/e2e-gameplay-runtime.test.ts
```

Expected: FAIL because the reader and global declaration do not exist.

- [ ] **Step 3: Implement the strict reader**

Use a single error prefix, `PERSEUS_E2E_CONFIG:`. Read the global through a typed `Window` augmentation. Validate before creating closures. Keep mutable sequence cursors inside the returned dependency object, not on the global.

The initial order is returned once; `createRestartTrayOrder` advances through `restartTrayOrders`; `runIdFactory.create()` advances through `runIds`. Exhaustion throws a prefixed error.

- [ ] **Step 4: Add the virtual-module declaration**

Create `src/virtual-modules.d.ts`:

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

- [ ] **Step 5: Implement the pre-enforced Vite plugin**

In `vite.config.ts`, define:

```ts
const virtualId = 'virtual:perseus-gameplay-runtime-override';
const resolvedVirtualId = `\0${virtualId}`;
```

Add an `enforce: 'pre'` plugin before `tailwindcss()` and `sveltekit()`.

- When `PERSEUS_E2E_HARNESS === '1'`, `load()` re-exports `readGameplayRuntimeOverride` from the normalized absolute reader path.
- Otherwise `load()` emits a typed no-op function returning `null`.
- Capture `harnessEnabled` when the config is created; tests must not mutate the process environment and expect an existing Vite config to switch behavior.

- [ ] **Step 6: Add ESLint import restrictions**

Extend `apps/web/eslint.config.js`:

1. A production-source rule rejects imports matching:
   - `$lib/testing/e2e-gameplay-runtime`;
   - relative paths ending in `e2e-gameplay-runtime`;
   - paths containing `runtime-override`.
2. A narrow file override for `src/lib/services/gameplay/runtime.ts` permits only the exact virtual module.
3. E2E and testing files may import the concrete reader for direct validation tests.

Use `no-restricted-imports` with explicit `paths` and `patterns`; do not add a custom plugin.

- [ ] **Step 7: Run unit, type, and lint verification**

Run:

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/runtime.test.ts \
  src/lib/testing/e2e-gameplay-runtime.test.ts
bun run --cwd apps/web check
bun run --cwd apps/web lint
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add \
  apps/web/src/lib/testing/e2e-gameplay-runtime.ts \
  apps/web/src/lib/testing/e2e-gameplay-runtime.test.ts \
  apps/web/src/virtual-modules.d.ts \
  apps/web/vite.config.ts \
  apps/web/eslint.config.js
git commit -m "test(web): gate deterministic gameplay runtime"
```

---

### Task 3: Add a Non-Vacuous Production-Bundle Safety Check

**Files:**
- Create: `apps/web/scripts/assert-no-e2e-harness.ts`
- Create: `apps/web/scripts/assert-no-e2e-harness.test.ts`
- Modify: `apps/web/package.json`
- Modify: `.github/workflows/e2e-test.yml`

**Interfaces:**
- Produces:

```ts
export interface BundleScanResult {
	filesScanned: number;
	bytesScanned: number;
}

export async function assertNoE2EHarness(buildDirectory: string): Promise<BundleScanResult>;
```

- [ ] **Step 1: Write failing scanner tests**

Use temporary directories to test:
- missing directory rejects;
- empty directory rejects;
- directory with no `.js` rejects;
- unreadable file rejects where the platform supports permission changes;
- a sentinel in nested JavaScript rejects with the file path;
- clean nested JavaScript returns positive file/byte counts.

Sentinels:

```ts
const SENTINELS = [
	'__PERSEUS_E2E_GAMEPLAY_V1__',
	'e2e-square-4',
	'PERSEUS_E2E_CONFIG:',
	'e2e-gameplay-runtime.ts'
] as const;
```

- [ ] **Step 2: Run scanner tests and verify RED**

```bash
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
```

Expected: FAIL because the scanner does not exist.

- [ ] **Step 3: Implement recursive scanning**

Scan `apps/web/build/` by default. Resolve from the web-app directory, not the caller's current directory. Recursively collect `.js` files, sort paths for stable diagnostics, read all files, require `filesScanned > 0` and `bytesScanned > 0`, and report every sentinel match before exiting non-zero.

- [ ] **Step 4: Add package scripts**

Add:

```json
{
	"build:e2e": "PERSEUS_E2E_HARNESS=1 bun run build",
	"test:e2e:assert-production-bundle": "bun run build && bun scripts/assert-no-e2e-harness.ts"
}
```

Do not make ordinary `build` enable the harness.

- [ ] **Step 5: Wire the existing E2E workflow**

In `.github/workflows/e2e-test.yml`, after `bun install` and before browser installation, run:

```yaml
- name: Verify production bundle excludes E2E harness
  run: bun run --cwd apps/web test:e2e:assert-production-bundle
```

The Playwright web server later runs `build:e2e`, producing a separate harness preview.

- [ ] **Step 6: Verify scanner and builds**

```bash
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
bun run --cwd apps/web test:e2e:assert-production-bundle
PERSEUS_E2E_HARNESS=1 bun run --cwd apps/web build
```

Expected: scanner tests pass; normal bundle assertion passes; E2E build succeeds.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/scripts/assert-no-e2e-harness.ts \
  apps/web/scripts/assert-no-e2e-harness.test.ts \
  apps/web/package.json \
  .github/workflows/e2e-test.yml
git commit -m "test(web): verify production bundle excludes E2E harness"
```

---

### Task 4: Establish Playwright Projects, Artifact Policy, and Harness Contract Probes

**Files:**
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/package.json`
- Create: `apps/web/e2e/playwright-clock-contract.spec.ts`
- Create: `apps/web/scripts/assert-browser-install.ts`
- Create: `apps/web/scripts/assert-browser-install.test.ts`

**Interfaces:**
- Projects:
  - `chromium-desktop` — 1440 × 900
  - `chromium-mobile` — 390 × 844
  - `chromium-tablet` — 768 × 1024
  - `webkit-mobile` — 390 × 844
  - `webkit-tablet` — 768 × 1024

- [ ] **Step 1: Write the Playwright clock contract test**

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

- [ ] **Step 2: Add browser-install dry-run parser tests**

`assert-browser-install.ts` runs or parses:

```bash
playwright install --dry-run --only-shell chromium webkit
```

Tests prove it requires:
- `chromium-headless-shell`;
- `webkit`;
- no full `chromium` browser entry.

Keep matching tolerant of URL/version changes but strict about browser names.

- [ ] **Step 3: Run contract tests before configuration changes**

```bash
bun test apps/web/scripts/assert-browser-install.test.ts
bun run --cwd apps/web test:e2e -- e2e/playwright-clock-contract.spec.ts
```

Expected: the parser test fails because the script is absent; the E2E command cannot select the future project configuration yet.

- [ ] **Step 4: Expand `playwright.config.ts`**

Configure:

```ts
export default defineConfig({
	testDir: 'e2e',
	failOnFlakyTests: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI
		? [['github'], ['html', { open: 'never' }]]
		: [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure',
		screenshot: 'on-first-failure'
	},
	projects: [
		{ name: 'chromium-desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
		{ name: 'chromium-mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
		{ name: 'chromium-tablet', use: { browserName: 'chromium', viewport: { width: 768, height: 1024 }, hasTouch: true } },
		{ name: 'webkit-mobile', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
		{ name: 'webkit-tablet', use: { browserName: 'webkit', viewport: { width: 768, height: 1024 }, hasTouch: true } }
	],
	webServer: [/* keep API server */, {
		command: 'bun run build:e2e && bun run preview -- --port 4173 --strictPort',
		/* existing port/cwd/env */
	}]
});
```

Keep current API environment variables and reuse behavior.

- [ ] **Step 5: Add explicit package commands**

Add the exact commands from the design, including explicit project lists for smoke, WebKit, extended, accessibility, and stability. Retain:

```json
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit",
"test:install-browsers:dry-run": "playwright install --dry-run --only-shell chromium webkit"
```

- [ ] **Step 6: Implement and run the browser-install assertion**

```bash
bun test apps/web/scripts/assert-browser-install.test.ts
bun run --cwd apps/web test:install-browsers:dry-run | bun apps/web/scripts/assert-browser-install.ts
```

Expected: parser tests pass and the dry-run confirms headless-shell Chromium plus normal WebKit.

- [ ] **Step 7: Install browsers and run the clock probe**

```bash
bun run --cwd apps/web test:install-browsers
bun run --cwd apps/web test:e2e -- \
  e2e/playwright-clock-contract.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

Expected: PASS with exact 2,000 ms advancement.

- [ ] **Step 8: Commit**

```bash
git add \
  apps/web/playwright.config.ts \
  apps/web/package.json \
  apps/web/e2e/playwright-clock-contract.spec.ts \
  apps/web/scripts/assert-browser-install.ts \
  apps/web/scripts/assert-browser-install.test.ts
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

export function buildGameplayFixture(input: GameplayFixtureInput): GameplayFixture;
export function getGameplayFixture(id: GameplayFixtureId): GameplayFixture;
export function createPieceSvg(fixture: GameplayFixture, pieceId: number): string;
export function createReferenceSvg(fixture: GameplayFixture): string;
```

- [ ] **Step 1: Write builder invariant tests**

Test exact grids:

```ts
expect(buildGameplayFixture({ id: 'e2e-landscape-12', aspectRatio: '4:3', pieceCount: 12, ...base }).puzzle)
	.toMatchObject({ gridRows: 3, gridCols: 4 });
expect(buildGameplayFixture({ id: 'e2e-portrait-12', aspectRatio: '3:4', pieceCount: 12, ...base }).puzzle)
	.toMatchObject({ gridRows: 4, gridCols: 3 });
```

Also assert:
- IDs are `0..pieceCount-1`;
- coordinates are unique and in bounds;
- outer edges are flat;
- every horizontal and vertical neighbor is complementary;
- invalid ratio/count combinations throw;
- incomplete tray order throws;
- invalid rotation throws;
- duplicate run ID throws.

- [ ] **Step 2: Run builder tests and verify RED**

```bash
bun test apps/web/e2e/gameplay-fixtures/builder.test.ts
```

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Implement the pure builder**

Use `getGridDimensionsForAspectRatio`, `getTopEdge`, `getRightEdge`, `getBottomEdge`, and `getLeftEdge` from `@perseus/types`. Generate `PuzzlePiece.imagePath` deterministically. Freeze the returned fixture recursively or clone at consumer boundaries so catalog definitions cannot be mutated across tests.

- [ ] **Step 4: Define the five catalog fixtures**

Use these grid/count pairs:
- 1:1, 4 → 2 × 2;
- 4:3, 12 → 3 × 4;
- 3:4, 12 → 4 × 3;
- 1:1, 100 → 10 × 10;
- 1:1, 225 → 15 × 15.

Use fixed UUIDv4-shaped run IDs, fixed timestamps, and deterministic permutation generators committed as literal results in `catalog.ts` so reviewing fixture behavior does not require reproducing a random algorithm.

- [ ] **Step 5: Implement padded SVG generation**

Generate XML-safe labels and a viewBox whose transparent padding corresponds to the current `TAB_RATIO`/`EXPANSION_FACTOR`. Include fixture ID, piece ID, correct coordinates, and stable geometric marks. Do not reference fonts or remote resources.

- [ ] **Step 6: Run all fixture tests**

```bash
bun test \
  apps/web/e2e/gameplay-fixtures/builder.test.ts \
  apps/web/e2e/gameplay-fixtures/catalog.test.ts \
  apps/web/e2e/gameplay-fixtures/assets.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/gameplay-fixtures
git commit -m "test(web): add deterministic gameplay fixture catalog"
```

---

### Task 6: Add Fixture Routing, Authentication Personas, API Outcomes, and Persistence Controls

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

export interface PersistedStateController {
	reset(page: Page): Promise<void>;
	seedSession(page: Page, snapshot: PersistedPuzzleSessionV1): Promise<void>;
	seedStats(page: Page, puzzleId: string, stats: unknown): Promise<void>;
}
```

- [ ] **Step 1: Write service-level Playwright tests**

Use a standalone page/context to prove:
- fixture detail and SVG routes are fulfilled;
- unknown `e2e-*` request fails the test and never reaches the API;
- ordinary requests can `route.fallback()`;
- anonymous/authenticated session payloads match the app contract;
- deferred route teardown fails until released or cancelled;
- recorded completion body is available for assertions;
- reset clears cookies/localStorage/sessionStorage and defensively clears IndexedDB/Cache Storage;
- session seeding writes `puzzle-progress-${id}` through production serialization.

- [ ] **Step 2: Run tests and verify RED**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/gameplay-fixtures/harness-services.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

Expected: FAIL because the services are absent.

- [ ] **Step 3: Implement total fixture interception**

Register the most specific routes before broad routes. For every request URL containing the fixture ID:
- fulfill known detail/piece/reference/list endpoints;
- throw from the route handler for unknown paths;
- never call `fallback()`.

Ordinary traffic falls through.

- [ ] **Step 4: Implement personas and API scenario recording**

Keep response bodies typed from shared contracts. A deferred response owns an explicit promise and has `release()` and `cancel()` operations. `assertSettled()` reports the route name and request when teardown finds a pending deferred route.

- [ ] **Step 5: Implement validated persistence controls**

Use `serializeSession` for valid session snapshots where possible. For migration/corruption tests, provide a separately named `seedRawLocalStorage` helper so normal feature tests cannot accidentally bypass codecs.

- [ ] **Step 6: Run harness service tests**

Use the same command as Step 2. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/gameplay-fixtures
git commit -m "test(web): add deterministic gameplay harness services"
```

---

### Task 7: Create the Canonical Extended Test Fixture, Diagnostics, and `gotoFixture()` Lifecycle

**Files:**
- Create: `apps/web/e2e/support/test.ts`
- Create: `apps/web/e2e/support/diagnostics.ts`
- Create: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/support/test-fixture.spec.ts`

**Interfaces:**

```ts
export interface GotoFixtureOptions {
	persona?: AuthPersona;
	seedSession?: PersistedPuzzleSessionV1;
	seedStats?: unknown;
	clock?: { startAt: Date } | false;
	completion?: CompletionScenario;
}

export class GameplayPage {
	constructor(private readonly page: Page, private readonly services: GameplayServices);
	gotoFixture(id: GameplayFixtureId, options?: GotoFixtureOptions): Promise<void>;
	expectReady(): Promise<void>;
}
```

- [ ] **Step 1: Write lifecycle-order tests**

Instrument the setup methods and assert `gotoFixture()` executes:

1. fixture lookup;
2. route registration;
3. reset/seed;
4. `addInitScript` for a deeply frozen runtime config;
5. `page.clock.install()` when requested;
6. navigation;
7. observable ready assertion.

Add a test that deliberately removes the init script for an `e2e-*` fixture and expects the prefixed missing-config error. Add a Quick Puzzle/ordinary route test proving no config is required.

- [ ] **Step 2: Run and verify RED**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/support/test-fixture.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

Expected: FAIL because the shared fixture does not exist.

- [ ] **Step 3: Implement automatic diagnostics**

Record:
- console errors;
- uncaught page errors;
- failed requests;
- unexpected non-success responses;
- fixture/persona identity;
- observed API scenario requests;
- pending deferred routes.

Attach JSON/text artifacts with `testInfo.attach`. Allowlist expected errors by exact scenario matcher, not global regexes.

- [ ] **Step 4: Implement the canonical extended test object**

`support/test.ts` exports `test` and `expect` from `base.extend`. Auto fixtures install diagnostics and call `apiScenario.assertSettled()` plus `fixtureRouter.assertNoUnexpectedFixtureRequests()` during teardown.

- [ ] **Step 5: Implement `gotoFixture()`**

Build the frozen configuration from the catalog. Use `page.addInitScript` before navigation. When deterministic time is requested, install the clock before any page operation. Wait for `puzzle-board` plus the expected unplaced tray-piece count rather than a fixed delay.

- [ ] **Step 6: Run lifecycle and existing regression tests**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/support/test-fixture.spec.ts \
  e2e/gallery.spec.ts \
  e2e/profile.spec.ts \
  e2e/quick-puzzle.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

Expected: PASS; existing suites remain usable with the shared harness build.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/support
git commit -m "test(web): add shared gameplay E2E fixture"
```

---

### Task 8: Implement Player-Facing Interaction Methods and Run the WebKit Drag Spike

**Files:**
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/gameplay-interactions.spec.ts`
- Create: `apps/web/e2e/webkit-drag-spike.spec.ts`

**Interfaces:**

```ts
class GameplayPage {
	placeWithMouse(pieceId: number, x: number, y: number): Promise<void>;
	selectAndPlaceWithKeyboard(pieceId: number, x: number, y: number): Promise<void>;
	tapPiece(pieceId: number): Promise<void>;
	dragWithTouch(pieceId: number, x: number, y: number): Promise<void>;
	expectPiecePlaced(pieceId: number, x: number, y: number): Promise<void>;
}
```

- [ ] **Step 1: Write interaction tests through rendered UI**

Cover:
- mouse placement into the correct cell;
- rejected mouse placement retains the piece;
- keyboard Enter/Space select and place;
- touch drag on a touch-enabled project;
- source locator scopes through `getByTestId('piece-slot-0')` before nested `puzzle-piece`;
- placement assertions observe the board cell/placed image and tray slot state.

- [ ] **Step 2: Run Chromium interaction tests and verify RED**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop \
  --retries=0
```

Expected: FAIL because the methods are absent.

- [ ] **Step 3: Implement mouse and keyboard methods**

Prefer `source.dragTo(target)`. If a cross-browser fallback is needed, encapsulate it in one private method that dispatches standards-shaped drag events against rendered elements. Attach source/target bounding boxes on failure.

Keyboard placement focuses the unplaced piece, presses Enter, verifies `aria-pressed` or `data-selected`, focuses the target drop zone, presses Enter, and waits on observable placement.

- [ ] **Step 4: Implement current touch-drag compatibility method**

Use Playwright touchscreen/pointer APIs where sufficient. When the current component requires touch-event sequences, dispatch `touchstart`, `touchmove`, and `touchend` with coordinates derived from locator bounding boxes; keep this adapter private to the driver.

- [ ] **Step 5: Run Chromium and WebKit compatibility tests**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/gameplay-interactions.spec.ts \
  --project=chromium-desktop \
  --project=webkit-mobile \
  --retries=0
```

Expected: keyboard/supported touch paths pass in WebKit.

- [ ] **Step 6: Execute the native WebKit mouse-drag spike on CI-equivalent Linux**

```bash
bun run --cwd apps/web test:e2e -- \
  e2e/webkit-drag-spike.spec.ts \
  --project=webkit-mobile \
  --repeat-each=20 \
  --retries=0 \
  --workers=1
```

Decision:
- zero failures → tag native drag `@webkit-critical`;
- any failure after the allowed UI-event fallback → tag it `@extended`, keep keyboard/touch critical, attach traces, and create/link a follow-up Linear issue.

Record the decision in `apps/web/e2e/README.md` during Task 11.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/e2e/support/gameplay-page.ts \
  apps/web/e2e/gameplay-interactions.spec.ts \
  apps/web/e2e/webkit-drag-spike.spec.ts
git commit -m "test(web): add gameplay interaction driver"
```

---

### Task 9: Add Small-Fixture Completion, Authentication, Timer, and Persistence Smoke Coverage

**Files:**
- Create: `apps/web/e2e/gameplay-infrastructure.spec.ts`
- Modify: `apps/web/e2e/puzzle-solving.spec.ts`

**Interfaces:**
- Consumes all shared harness and `GameplayPage` interfaces from Tasks 5–8.

- [ ] **Step 1: Replace skipped known-puzzle and placement coverage with failing fixture tests**

Add tagged tests:

```ts
test('@smoke known fixture loads deterministic board and tray', async ({ gameplayPage }) => {
	await gameplayPage.gotoFixture('e2e-square-4');
	await gameplayPage.expectReady();
	await expect(gameplayPage.unplacedPieces()).toHaveCount(4);
});
```

Migrate or remove the corresponding skipped tests from `puzzle-solving.spec.ts` in the same commit so there is one owner for each scenario.

- [ ] **Step 2: Add authenticated completion smoke**

Use authenticated persona and immediate success. Make one rejected attempt, then solve pieces 0–3 through UI. Assert:
- celebration visible;
- local stats updated;
- exactly one completion request;
- body contains the deterministic run ID, correct result class, and elapsed value;
- server effect succeeds.

- [ ] **Step 3: Add anonymous completion smoke**

Use anonymous persona and HTTP 401. Solve through keyboard or mouse. Assert:
- celebration visible;
- local stats succeed;
- exactly one server request was attempted;
- unauthorized effect state is observable through the current UI/persisted session contract;
- the test does not expect “no request.”

- [ ] **Step 4: Add deferred failure/retry/success smoke**

Use authenticated persona. Hold the response, complete the board, assert pending state, release a retryable 500, use the visible retry action, then return success. Assert one initial and one retry request with the same sealed run payload.

- [ ] **Step 5: Add deterministic timer integration**

Install the clock through `gotoFixture`, perform the first counted action, advance exactly 5 seconds, finish the puzzle, and assert the timer UI plus completion request contain exactly 5 active seconds, subject to existing whole-second/floor rules.

- [ ] **Step 6: Add persistence seed/reset smoke**

Seed a valid active snapshot with one placed piece and known order. Navigate and assert restoration. Create a fresh context without the seed and assert the board starts empty and canonical localStorage key is absent.

- [ ] **Step 7: Run the Chromium smoke suite**

```bash
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

Expected: PASS.

- [ ] **Step 8: Verify no unexplained gameplay skips remain**

```bash
rg "test\.skip|describe\.skip" apps/web/e2e
```

For every remaining skip, either enable it, replace it, or add an inline comment with the exact owning HPA ticket and why the current UI cannot exercise it.

- [ ] **Step 9: Commit**

```bash
git add \
  apps/web/e2e/gameplay-infrastructure.spec.ts \
  apps/web/e2e/puzzle-solving.spec.ts
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

**Interfaces:**

```ts
export async function scanAccessibility(
	page: Page,
	testInfo: TestInfo,
	options?: { include?: string[]; exclude?: string[] }
): Promise<void>;

export async function expectInitialFocus(dialog: Locator, expected: Locator): Promise<void>;
export async function expectLiveRegion(page: Page, text: string | RegExp): Promise<void>;
```

- [ ] **Step 1: Add the accessibility dependency**

```bash
bun add --cwd apps/web -d @axe-core/playwright
```

Commit lockfile changes only with this task.

- [ ] **Step 2: Write ratio and large-layout tests**

Tests assert:
- landscape puzzle renders 3 rows × 4 columns;
- portrait puzzle renders 4 rows × 3 columns;
- board aspect ratio is usable at mobile/tablet/desktop viewport classes;
- 100- and 225-piece fixtures render all tray slots;
- one representative keyboard/touch interaction works without solving the full puzzle;
- no assertion depends on synthetic SVG pixel-perfect tab shape.

Tag large checks `@extended`.

- [ ] **Step 3: Write failing accessibility helper tests**

Use gallery, active gameplay, and current completion surfaces. Fail on serious/critical axe findings, attach the complete result JSON, and include bounded exclusions only with comments naming the owning feature ticket.

- [ ] **Step 4: Implement accessibility helpers**

Use `AxeBuilder`. Normalize findings into stable attachments. Provide role-based focus and live-region assertions; do not reach into Svelte state.

- [ ] **Step 5: Run explicit matrices**

```bash
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
```

Expected: PASS across only the explicitly listed projects.

- [ ] **Step 6: Commit**

```bash
git add \
  apps/web/e2e/gameplay-large-fixtures.spec.ts \
  apps/web/e2e/support/accessibility.ts \
  apps/web/e2e/gameplay-accessibility.spec.ts \
  apps/web/package.json \
  bun.lock
git commit -m "test(web): add large-fixture and accessibility coverage"
```

---

### Task 11: Split CI Jobs and Document the Harness

**Files:**
- Modify: `.github/workflows/e2e-test.yml`
- Create: `apps/web/e2e/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- PR jobs:
  - production bundle safety;
  - Chromium smoke;
  - WebKit critical.
- Extended job on main/manual/schedule:
  - explicit extended project matrix;
  - accessibility scans;
  - large fixtures.

- [ ] **Step 1: Refactor the workflow into bounded jobs**

Use separate jobs with shared setup steps or a reusable YAML anchor only if repository style already permits it. Each browser job:
- checks out;
- sets up Bun 1.3.14;
- installs dependencies;
- installs required Playwright browsers;
- runs one explicit package command;
- uploads `apps/web/test-results` and `apps/web/playwright-report` on failure.

The production-bundle safety job does not install browsers.

- [ ] **Step 2: Add extended triggers**

Keep smoke jobs on pull requests. Run extended coverage on push to `main`, `workflow_dispatch`, and a documented schedule if desired by repository policy. Do not make every project run for every PR.

- [ ] **Step 3: Write the E2E README**

Document:
- existing `e2e/fixtures/test-image.jpg` vs typed `e2e/gameplay-fixtures/`;
- five fixture IDs, exact rows × columns, zero-based IDs;
- total `e2e-*` interception;
- virtual module and import restrictions;
- ordinary/Quick Puzzle missing-config fallback;
- `gotoFixture()` ordering;
- installed clock and rAF/idle effects;
- localStorage reset/seeding;
- auth/completion matrix;
- deferred route cleanup;
- commands and project matrices;
- WebKit spike result and follow-up issue when applicable;
- browser-install dry-run behavior;
- diagnostics and artifact paths;
- accessibility limitations;
- feature-ticket ownership.

- [ ] **Step 4: Update repository guidance**

In `CLAUDE.md`, replace the outdated short E2E description with links to the README and exact smoke/extended commands. State that new gameplay E2E tests import from `e2e/support/test`.

- [ ] **Step 5: Validate workflow syntax and local commands**

Run:

```bash
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web test:e2e:smoke -- --retries=0
bun run --cwd apps/web test:e2e:webkit -- --retries=0
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
```

Also inspect the workflow diff for correct artifact paths and trigger scoping.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/e2e-test.yml apps/web/e2e/README.md CLAUDE.md
git commit -m "ci: split deterministic gameplay E2E jobs"
```

---

### Task 12: Run the Full Stability Gate and Final Requirement Audit

**Files:**
- Modify only files required to fix failures found by verification.
- Update: `apps/web/e2e/README.md` only when actual WebKit spike behavior differs from the planned expectation.

**Interfaces:**
- Produces verification evidence for HPA-226 acceptance criteria.

- [ ] **Step 1: Run static and unit verification**

```bash
bun run --cwd apps/web check
bun run --cwd apps/web lint
bun run --cwd apps/web test:unit
bun test apps/web/scripts/assert-no-e2e-harness.test.ts
bun test apps/web/scripts/assert-browser-install.test.ts
```

Expected: all exit 0 with no warnings treated as errors.

- [ ] **Step 2: Run production and E2E build checks**

```bash
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web build:e2e
```

Expected: normal bundle contains no sentinels; harness build succeeds.

- [ ] **Step 3: Run repeated Chromium smoke with zero retries**

```bash
bun run --cwd apps/web test:e2e:stability
```

Expected: ten serial repetitions pass with zero flaky retries.

- [ ] **Step 4: Run smoke under normal parallelism**

```bash
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

Expected: PASS.

- [ ] **Step 5: Run repeated WebKit critical coverage**

```bash
bun run --cwd apps/web test:e2e:webkit -- \
  --repeat-each=10 \
  --retries=0 \
  --workers=1
```

Expected: PASS. Native mouse drag is included only if Task 8's 20-run spike passed.

- [ ] **Step 6: Run extended and accessibility suites**

```bash
bun run --cwd apps/web test:e2e:extended -- --retries=0
bun run --cwd apps/web test:e2e:a11y -- --retries=0
```

Expected: PASS.

- [ ] **Step 7: Audit skipped tests and arbitrary waits**

```bash
rg "test\.skip|describe\.skip" apps/web/e2e
rg "waitForTimeout" apps/web/e2e
```

Expected:
- no unexplained gameplay skip;
- no `waitForTimeout`, or every occurrence has the required adjacent justification and linked browser behavior.

- [ ] **Step 8: Audit production-seam imports and sentinels**

```bash
rg "e2e-gameplay-runtime|runtime-override|__PERSEUS_E2E_GAMEPLAY_V1__|e2e-square-4" \
  apps/web/src \
  --glob '!lib/testing/**' \
  --glob '!virtual-modules.d.ts'
```

Expected: only the approved virtual-module import in `runtime.ts`; no fixture sentinel in normal production source.

- [ ] **Step 9: Map every acceptance criterion to evidence**

Record in the PR description or a final PR comment:
- command and result for each verification group;
- fixture coverage by ratio/count;
- authenticated/anonymous/Quick Puzzle completion behavior;
- WebKit spike decision;
- production-bundle scan counts;
- artifact paths from one intentionally failed local test, then restore the passing state.

- [ ] **Step 10: Commit final verification-driven fixes**

If verification required code changes:

```bash
git add <only-the-files-changed-to-fix-verification>
git commit -m "test(web): stabilize deterministic gameplay E2E suite"
```

If no files changed, do not create an empty commit.

---

## Execution Notes

- Implement from a fresh worktree based on the latest `main` after the design/plan PR is merged.
- Use test-driven development for each task: failing focused test, minimal implementation, passing focused test, then broader regression checks.
- Do not batch unrelated tasks into one commit; each task has an independent review gate.
- When a task reveals a contradiction with the approved design, update the design document in a separate documentation commit before changing implementation scope.
- HPA-218 through HPA-224 and HPA-237 consume this foundation and remain responsible for their feature-specific E2E scenarios.
