# HPA-1 NativeScript Offline Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the iPad NativeScript/Svelte Native/Canvas stack first, then extract Perseus's existing framework-neutral gameplay engine and portable session codec into `@perseus/game-core`, migrate web to it, and prove a deterministic local puzzle can save and resume completely offline on iPad.

**Architecture:** Keep the Canvas proof as a hard first-commit gate inside one HPA-1 draft PR. After it passes, create one independently green game-core package containing the engine, helpers, codec, and full pure validation parity; then migrate web/delete duplicates; finally make NativeScript consume the real workspace package and add the small Canvas/persistence vertical slice. `apps/mobile` participates in root CI only through Linux-safe pure tests, never through an iOS/Xcode Turbo build.

**Tech Stack:** Bun 1.3.14 workspaces + Turborepo, TypeScript 5.9, Vitest 4, existing `@perseus/types`, NativeScript + Svelte Native from the current official Svelte template, official `@nativescript/canvas` 2.x, iOS/iPad simulator or device.

**Spec:** `docs/superpowers/specs/2026-08-23-hpa-1-nativescript-offline-vertical-slice-design.md`

## Global Constraints

- Deliver HPA-1 through one implementation PR. Keep it draft while the Canvas gate is unresolved; if the gate fails, close/retain that PR with only the probe evidence and do not add game-core extraction commits.
- **Do not create `packages/game-core` until Task 1's iPad Canvas gate passes.**
- Use official `@nativescript/canvas`; do not add PixiJS, Phaser, Three.js, `@nativescript/canvas-polyfill`, WebView gameplay, or a renderer abstraction.
- `@perseus/game-core` may depend on `@perseus/types`, but may not import Svelte, NativeScript, DOM, browser `Storage`, filesystem, fetch, Cloudflare, or analytics APIs.
- Keep `@perseus/types` focused on API/wire contracts.
- Rename the engine-facing metadata contract to `SessionPuzzleSpec`; do not export a second unrelated `PuzzleMetadata` name beside `@perseus/types.PuzzleMetadata`.
- Extract the engine + helpers + portable codec + all pure validation assertions together in Task 2. A copied `session.test.ts` must never exist in a supposedly green game-core without its codec dependency.
- Keep Svelte `PuzzleSessionStore`, browser run-ID logic, browser storage-key enumeration, and `createSessionStorageAdapter()` in `apps/web`.
- Keep `SessionStorageAdapter` synchronous. Do not add an async repository, SQLite, write queue, database, or persistence index.
- Do not leave compatibility aliases/re-exports at the old web-local gameplay paths after Task 3.
- `apps/mobile` must not expose Turbo `build/check/lint` tasks that invoke NativeScript/iOS/Xcode. Add only Linux-safe pure `test:unit` participation once those tests exist.
- Retain NativeScript template ignore rules so `platforms/`, `hooks/`, generated Xcode output, and other build artifacts are never committed.
- Use one checked-in deterministic 2x2 local fixture. No network API, download manifest, Gallery, Downloaded library, or HPA-2 behavior.
- HPA-1 uses a fixed/fit-only viewport. No production pinch/pan, gesture framework, or persisted viewport.
- Tap and drag must end at the same shared `PuzzleSession` `attempt_placement` action.
- `BoardViewModel` stays in `apps/mobile`; do not move/repurpose the web DOM viewport helpers.
- Use one five-operation `SessionFileOps` seam only to unit-test the NativeScript file adapter.
- No portrait, authentication, completion sync, cloud save, native E2E framework, or generic state-management framework.

---

## File Structure

### Task 1: Native gate + workspace safety

- Generate: `apps/mobile/**` from the official NativeScript Svelte template.
- Create: `apps/mobile/app/components/CanvasProbe.svelte`
- Create: `apps/mobile/app/assets/hpa-1/probe-piece.png`
- Modify: `apps/mobile/app/app.ts`
- Modify: `apps/mobile/app/App.svelte`
- Verify/retain: `apps/mobile/.gitignore`
- Normalize: `apps/mobile/package.json` so no Turbo task name invokes iOS/Xcode.

### Task 2: complete green game-core copy

- Create: `packages/game-core/package.json`
- Create: `packages/game-core/tsconfig.json`
- Create: `packages/game-core/vitest.config.ts`
- Create: `packages/game-core/src/index.ts`
- Copy/adapt: history, hints, inventory, rotation + their tests.
- Copy/adapt: session contracts/engine + session tests.
- Create from portable persistence code: `packages/game-core/src/session/codec.ts`
- Move/copy all pure codec/validation assertions into game-core tests.

### Task 3: web migration/deletion

- Modify: `apps/web/package.json`
- Modify: web `session/persistence.ts` and browser-only persistence tests.
- Modify: web `session/store.ts` + test.
- Modify: gameplay runtime/types/E2E runtime wiring.
- Modify: components/routes/tests importing moved types/helpers/codecs.
- Modify: `apps/web/src/lib/types/puzzle.ts` to stop owning `PlacedPiece`.
- Delete: web pure helper/session/type copies and their migrated pure tests.

### Task 4: real workspace consumer + native 2x2 slice

- Create: `apps/mobile/vitest.config.ts`
- Modify: `apps/mobile/package.json` to add `@perseus/game-core: workspace:*` and Linux-safe `test:unit`.
- Create temporary: `apps/mobile/app/gameplay/coreBundleProbe.ts` for the webpack workspace gate; delete after real gameplay imports game-core.
- Create: `apps/mobile/app/gameplay/fixture.ts`
- Create: four real piece PNGs under `apps/mobile/app/assets/hpa-1/`.
- Create: `runtime.ts`, `boardViewModel.ts`, `boardViewModel.test.ts`, `PuzzleCanvas.svelte`, `Gameplay.svelte`.
- Modify only if the workspace gate proves necessary: `apps/mobile/webpack.config.js`.

### Task 5: file persistence + relaunch

- Create: `apps/mobile/app/gameplay/sessionFiles.ts`
- Create: `apps/mobile/app/gameplay/sessionStorage.ts`
- Create: `apps/mobile/app/gameplay/sessionStorage.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`

---

## Task 1: Prove NativeScript + Svelte Native + Canvas on iPad Without Polluting Turbo/CI

**Files:**
- Generate/modify: `apps/mobile/**`
- Create: `apps/mobile/app/components/CanvasProbe.svelte`
- Create: `apps/mobile/app/assets/hpa-1/probe-piece.png`
- Modify: root `bun.lock` after workspace install.

**Interfaces:** No reusable gameplay interface. Output is gate evidence only.

- [ ] **Step 1: Verify the local iOS toolchain**

```bash
ns --version
ns doctor ios
```

Expected: no blocking Xcode/CocoaPods/iOS runtime error. Host setup failures are environment work, not reasons to redesign Perseus.

- [ ] **Step 2: Scaffold the mobile shell and install only Canvas**

```bash
cd apps
ns create mobile --svelte
cd mobile
ns plugin add @nativescript/canvas
cd ../..
bun install
```

Confirm the resolved package is official `@nativescript/canvas` 2.x. Do not add the polyfill package.

- [ ] **Step 3: Keep the new `apps/*` workspace Linux-safe**

Inspect the generated package scripts:

```bash
cat apps/mobile/package.json
```

The committed result must not define Turbo task names such as `build`, `check`, or `lint` when they invoke `ns build ios`, Xcode, or any macOS-only native build. Keep native execution explicit, for example:

```json
{
  "scripts": {
    "ios": "ns run ios"
  }
}
```

If the template already omits those task names, do not add them. Do not add `test:unit` until Task 4 has pure tests.

Retain template ignore coverage for generated native output. Before the gate commit, verify:

```bash
rg '^(platforms|hooks)/|platforms/|hooks/' apps/mobile/.gitignore .gitignore
```

If the template places those patterns elsewhere, preserve the equivalent ignore behavior; do not weaken it.

- [ ] **Step 4: Register the official Svelte Canvas element**

At app bootstrap before mounting the root:

```ts
import '@nativescript/canvas/svelte';
```

Do not copy the package's internal registration code.

- [ ] **Step 5: Check in one real Perseus piece PNG**

Create:

```text
apps/mobile/app/assets/hpa-1/probe-piece.png
```

Use a real generated piece with transparent jigsaw edges.

- [ ] **Step 6: Implement the one-screen probe**

`CanvasProbe.svelte` should contain only the Canvas, one status label, one image position, and tap/pan handlers. Equivalent behavior:

```ts
let canvas: any;
let piece: ImageSource | null = null;
let x = 80;
let y = 80;
let dragStart = { x: 0, y: 0 };
let origin = { x, y };

function draw(): void {
  if (!canvas || !piece) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(piece, x, y, 128, 128);
}

function onTap(event: any): void {
  status = `tap ${Math.round(event.getX())},${Math.round(event.getY())}`;
}

function onPan(event: any): void {
  if (event.state === 1) {
    dragStart = { x: event.getX(), y: event.getY() };
    origin = { x, y };
  } else if (event.state === 2) {
    x = origin.x + event.getX() - dragStart.x;
    y = origin.y + event.getY() - dragStart.y;
    draw();
  }
}
```

Use the concrete image/event APIs exposed by the installed 2.x package; do not add a wrapper.

- [ ] **Step 7: Run root host-neutral gates before native launch**

```bash
bun run check
bun run lint
bun run build
```

Expected: the new workspace does not make Turbo attempt an iOS build.

- [ ] **Step 8: Run the hard iPad gate**

```bash
cd apps/mobile
ns run ios
```

Record NativeScript CLI version, resolved Canvas version, iPad model, and iOS version. Verify:

```text
Canvas visible
real piece transparency intact
tap coordinates line up
drag coordinates change
redraw moves the piece
```

- [ ] **Step 9: Repeat a clean relaunch and inspect generated-file hygiene**

Stop/re-run `ns run ios` without manual edits under `platforms/` or Xcode project files. Then:

```bash
git status --short apps/mobile
git ls-files 'apps/mobile/platforms/**' 'apps/mobile/hooks/**'
```

Expected: no generated platform/hook file is tracked.

**STOP HERE if the gate is unreliable.** Do not execute Task 2. The draft implementation PR ends with probe evidence only.

- [ ] **Step 10: Commit the gate only after it passes**

```bash
git add apps/mobile bun.lock
git commit -m "feat: prove NativeScript Canvas on iPad"
```

---

## Task 2: Create One Green `@perseus/game-core` With Engine + Codec + Full Pure Validation

**Precondition:** Task 1 passed on iPad.

**Files:**
- Create: `packages/game-core/package.json`
- Create: `packages/game-core/tsconfig.json`
- Create: `packages/game-core/vitest.config.ts`
- Create: `packages/game-core/src/index.ts`
- Copy/adapt: helper sources/tests.
- Copy/adapt: `session/types.ts`, `session/session.ts`, `session.test.ts`, `session.edge.test.ts`.
- Create: `session/codec.ts` and codec tests from current persistence behavior.

**Interfaces produced:**

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}

export interface SessionPuzzleSpec {
  puzzleId: string;
  source: PuzzleSourceType;
  pieceCount: number;
  gridCols: number;
  gridRows: number;
  pieces: ReadonlyArray<{ id: number; correctX: number; correctY: number }>;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession;
export function serializeSession(state: PuzzleSessionState, now?: number): PersistedPuzzleSessionV1 | null;
export function loadPersistedSession(raw: string | null, context: SessionValidationContext): SessionLoadResult;
export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean;
export function isFailureRetryable(code: CompletionFailureCode): boolean;
```

- [ ] **Step 1: Create the package config and copy the existing test configuration**

`packages/game-core/package.json`:

```json
{
  "name": "@perseus/game-core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test:unit": "tsc --noEmit && vitest run --coverage"
  },
  "dependencies": {
    "@perseus/types": "workspace:*"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.0.18",
    "typescript": "^5.9.0",
    "vitest": "^4.0.18"
  }
}
```

Copy both:

```bash
cp packages/types/tsconfig.json packages/game-core/tsconfig.json
cp packages/types/vitest.config.ts packages/game-core/vitest.config.ts
```

- [ ] **Step 2: Copy the engine/helpers/tests without deleting web originals**

Use copy/editor operations, not `git mv`, for:

```text
history.ts + history.test.ts
hints.ts + hints.test.ts
inventory.ts + inventory.test.ts
rotation.ts + rotation.test.ts
session/types.ts
session/session.ts
session/session.test.ts
session/session.edge.test.ts
```

Web remains untouched in this task.

- [ ] **Step 3: Copy the portable codec before trying to make session tests green**

Create `packages/game-core/src/session/codec.ts` from the pure sections of current web `session/persistence.ts`:

```ts
serializeSession
loadPersistedSession
isResumable
isFailureRetryable
```

Move/copy every private validator and clone helper required by those functions.

Do **not** copy:

```text
PROGRESS_KEY_PREFIX / progressKey
resolveSessionStorage
createBrowserRunIdFactory / fallback browser UUID behavior
listResumableSessionCandidateIds
createSessionStorageAdapter
noopThrowingStorage
```

- [ ] **Step 4: Preserve the full pure persistence parity contract**

Create game-core codec fixtures/tests from all existing assertions that exercise the portable functions, including the current cases in:

```text
apps/web/src/lib/services/gameplay/session/persistence.test.ts
apps/web/src/lib/services/gameplay/session/persistence.validation-activity.test.ts
apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts
apps/web/src/lib/services/gameplay/session/persistence.validation-fields.test.ts
apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts
```

For mixed files such as `persistence.validation-storage.test.ts`, move/copy serializer/cloning/validator assertions into game-core and leave `Storage` adapter/error/destructive-load assertions for Task 3's web suite. Do not replace the existing matrix with two representative tests.

Also copy `persistence.test-fixtures.ts` into a game-core-owned codec fixture module, stripping browser-only `Storage` helpers if they are unused there.

- [ ] **Step 5: Remove web-local type dependencies in the copied package**

In copied session types:

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}

export interface SessionPuzzleSpec {
  puzzleId: string;
  source: PuzzleSourceType;
  pieceCount: number;
  gridCols: number;
  gridRows: number;
  pieces: ReadonlyArray<{ id: number; correctX: number; correctY: number }>;
}
```

Change:

```ts
interface CreatePuzzleSessionOptions {
  metadata: SessionPuzzleSpec;
  // existing fields unchanged
}
```

Update copied session tests from `PuzzleMetadata` to `SessionPuzzleSpec`. Do not rename actions, outcomes, clocks, or runtime method names.

- [ ] **Step 6: Make copied helper imports package-local**

`session/session.ts` should use relative imports:

```ts
import { createHistory, type History } from '../history';
import { getHintPieceId } from '../hints';
import { matchesInventoryFilter } from '../inventory';
import { generateRandomRotations, isUpright, rotateClockwise } from '../rotation';
```

For `inventory.ts`, keep the current behavior but replace web `Pick<>` dependencies with structural coordinates/grid fields.

- [ ] **Step 7: Export the complete package surface**

`src/index.ts`:

```ts
export * from './history';
export * from './hints';
export * from './inventory';
export * from './rotation';
export * from './session/types';
export * from './session/session';
export * from './session/codec';
```

- [ ] **Step 8: Run the independently green package and unchanged web**

```bash
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
```

Expected: both pass before any web import migration/deletion.

- [ ] **Step 9: Verify package purity**

```bash
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: no prohibited runtime/platform dependency.

- [ ] **Step 10: Commit the complete green copy**

```bash
git add packages/game-core bun.lock
git commit -m "refactor: add shared Perseus game core"
```

---

## Task 3: Migrate Web to Game-Core and Delete Duplicates in the Same Commit

**Files:**
- Modify: `apps/web/package.json`
- Modify: web persistence/store/runtime/components/routes/tests.
- Delete: old pure helpers/session/type owners and migrated pure tests.

**Interfaces:** Web browser adapter signatures remain unchanged. Pure codec imports come from `@perseus/game-core`.

- [ ] **Step 1: Add the workspace dependency**

In web dependencies:

```json
"@perseus/game-core": "workspace:*"
```

Run `bun install`.

- [ ] **Step 2: Reduce web persistence to browser concerns over the shared codec**

Keep browser-only behavior in `apps/web/src/lib/services/gameplay/session/persistence.ts` and import shared types/functions:

```ts
import {
  isFailureRetryable,
  isResumable,
  loadPersistedSession,
  type PersistedPuzzleSessionV1,
  type RunIdFactory,
  type SessionLoadResult,
  type SessionPersistenceError,
  type SessionStorageAdapter,
  type SessionValidationContext
} from '@perseus/game-core';
```

Keep `createBrowserRunIdFactory`, candidate key enumeration, `createSessionStorageAdapter`, and fallback storage local.

Do not re-export `serializeSession`/`loadPersistedSession` from the old module solely for compatibility.

- [ ] **Step 3: Keep the Svelte store web-only**

Change the engine import in `session/store.ts` to game-core while preserving the existing direct-subscriber batching behavior:

```ts
import {
  createPuzzleSession,
  type CreatePuzzleSessionOptions,
  type PuzzleSession,
  type PuzzleSessionAction,
  type PuzzleSessionOutcome,
  type PuzzleSessionState
} from '@perseus/game-core';
```

- [ ] **Step 4: Migrate all remaining domain/helper/codec imports**

Update runtime, components, route, gallery progress, E2E support, and tests so moved types/helpers/codecs come from game-core.

Run these completeness searches while editing:

```bash
rg "\$lib/services/gameplay/(history|hints|inventory|rotation)" apps/web/src
rg "\$lib/services/gameplay/session/(types|session)" apps/web/src
rg "\$lib/types/gameplay" apps/web/src
rg "serializeSession|loadPersistedSession|isResumable|isFailureRetryable" apps/web/src
```

For the last search, inspect every match: codec consumers such as the puzzle route/tests must import the pure function from game-core rather than depending on a compatibility re-export from web persistence. The browser persistence adapter itself may import/use the shared functions.

- [ ] **Step 5: Split mixed persistence tests without dropping assertions**

Leave web tests covering:

```text
browser Storage read/write/remove errors
peek vs destructive load behavior
candidate key enumeration
browser run-ID/crypto fallback
noop/fallback Storage behavior
```

Remove only pure codec assertions already copied into game-core. Keep the overall assertion behavior parity between the two packages.

- [ ] **Step 6: Delete web-local pure duplicates**

Delete after consumers compile against game-core:

```text
apps/web/src/lib/services/gameplay/history.ts
apps/web/src/lib/services/gameplay/history.test.ts
apps/web/src/lib/services/gameplay/hints.ts
apps/web/src/lib/services/gameplay/hints.test.ts
apps/web/src/lib/services/gameplay/inventory.ts
apps/web/src/lib/services/gameplay/inventory.test.ts
apps/web/src/lib/services/gameplay/rotation.ts
apps/web/src/lib/services/gameplay/rotation.test.ts
apps/web/src/lib/services/gameplay/session/session.ts
apps/web/src/lib/services/gameplay/session/session.test.ts
apps/web/src/lib/services/gameplay/session/session.edge.test.ts
apps/web/src/lib/services/gameplay/session/types.ts
apps/web/src/lib/types/gameplay.ts
```

Remove local `PlacedPiece` from `apps/web/src/lib/types/puzzle.ts`. Do not create aliases.

- [ ] **Step 7: Run web and root gates**

```bash
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
bun run check
bun run lint
bun run build
```

- [ ] **Step 8: Run representative gameplay E2E**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
cd ../..
```

- [ ] **Step 9: Re-run import/purity fences and commit**

```bash
rg "\$lib/services/gameplay/(history|hints|inventory|rotation)|\$lib/services/gameplay/session/(types|session)|\$lib/types/gameplay" apps/web/src
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: no old web-local gameplay imports and no prohibited game-core dependency.

```bash
git add packages/game-core apps/web bun.lock
git commit -m "refactor: consume shared game core on web"
```

---

## Task 4: Prove NativeScript Can Bundle the Workspace Package, Then Build the 2x2 Shared-Session Slice

**Files:**
- Create: `apps/mobile/vitest.config.ts`
- Modify: `apps/mobile/package.json`
- Create/delete temporary: `app/gameplay/coreBundleProbe.ts`
- Create: `fixture.ts`, `runtime.ts`, `boardViewModel.ts`, `boardViewModel.test.ts`, `PuzzleCanvas.svelte`, `Gameplay.svelte`.
- Create: four real piece PNGs.
- Modify only if required by the bundle gate: `apps/mobile/webpack.config.js`.

**Interfaces:**

```ts
export interface BoardCell { x: number; y: number }

export interface BoardViewModel {
  state(session: Readonly<PuzzleSessionState>): BoardRenderState;
  cellAt(canvasX: number, canvasY: number): BoardCell | null;
  pieceAt(canvasX: number, canvasY: number, session: Readonly<PuzzleSessionState>): number | null;
}
```

- [ ] **Step 1: Add the real workspace dependency and Linux-safe mobile unit task**

Add:

```json
"@perseus/game-core": "workspace:*"
```

to dependencies.

Once pure tests exist, mobile's Turbo-facing script is only:

```json
"test:unit": "vitest run --coverage"
```

Do not add root-task `build/check/lint` scripts that invoke NativeScript. Native iOS remains `ios: ns run ios` or direct `ns run ios`.

Create `apps/mobile/vitest.config.ts` with the same basic V8 coverage shape as the other pure packages, scoped to `app/**/*.test.ts`.

- [ ] **Step 2: Add a minimal runtime import probe before building gameplay**

Create:

```ts
// app/gameplay/coreBundleProbe.ts
import { rotateClockwise } from '@perseus/game-core';

export const CORE_BUNDLE_PROBE = rotateClockwise(0);
```

Import `CORE_BUNDLE_PROBE` into the current probe screen and show/use the value so webpack must include the runtime module.

- [ ] **Step 3: Run the workspace-package bundling gate**

```bash
cd apps/mobile
ns run ios
```

Expected: the app launches with the runtime export from `@perseus/game-core` bundled.

If it fails specifically because the generated webpack TypeScript rule excludes the symlinked workspace source:

```bash
ns prepare ios --env.verbose
```

Inspect the resolved TypeScript rule, then use the documented `webpack.chainWebpack()` hook in the generated `webpack.config.js` to add the resolved `../../packages/game-core/src` directory to that existing rule's include set. Do not add another TypeScript loader, copy game-core into the app, or change game-core into a mobile-specific build.

Re-run `ns run ios` immediately after the one config change. If the failure is not a workspace-source transpilation/resolution issue, diagnose the actual error rather than applying this fallback blindly.

- [ ] **Step 4: Add deterministic fixture typed with `SessionPuzzleSpec`**

```ts
import type { SessionPuzzleSpec } from '@perseus/game-core';

export const HPA1_FIXTURE: SessionPuzzleSpec = {
  puzzleId: 'hpa-1-offline-fixture',
  source: 'local',
  pieceCount: 4,
  gridCols: 2,
  gridRows: 2,
  pieces: [
    { id: 0, correctX: 0, correctY: 0 },
    { id: 1, correctX: 1, correctY: 0 },
    { id: 2, correctX: 0, correctY: 1 },
    { id: 3, correctX: 1, correctY: 1 }
  ]
};
```

Create four real local piece images and a small `pieceId -> asset path` map. No manifest.

Delete `coreBundleProbe.ts` once real gameplay runtime imports game-core.

- [ ] **Step 5: Write RED BoardViewModel tests**

For an 800x600 Canvas with a centered square 2x2 board:

```ts
it('maps fitted canvas points to canonical cells', () => {
  const vm = createBoardViewModel({
    canvasWidth: 800,
    canvasHeight: 600,
    gridCols: 2,
    gridRows: 2
  });

  expect(vm.cellAt(250, 150)).toEqual({ x: 0, y: 0 });
  expect(vm.cellAt(550, 450)).toEqual({ x: 1, y: 1 });
  expect(vm.cellAt(5, 5)).toBeNull();
});
```

Also pin `pieceAt()` and placed-piece projection from a session snapshot. Test only geometry/projection; no placement correctness.

Run:

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
```

Expected: RED before implementation.

- [ ] **Step 6: Implement one centered fit transform**

Core cell mapping:

```ts
function cellAt(canvasX: number, canvasY: number): BoardCell | null {
  if (canvasX < board.x || canvasY < board.y) return null;
  if (canvasX >= board.x + board.width || canvasY >= board.y + board.height) return null;
  return {
    x: Math.floor((canvasX - board.x) / cellWidth),
    y: Math.floor((canvasY - board.y) / cellHeight)
  };
}
```

No zoom/pan/matrix framework.

- [ ] **Step 7: Add app-local runtime adapters**

```ts
export function createMobileRunIdFactory(): RunIdFactory {
  return { create: () => getNativeCrypto().randomUUID().toLowerCase() };
}

export function createMobileClock(): Clock {
  return {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
  };
}
```

Use the public crypto surface provided by the installed NativeScript version. No UUID dependency.

- [ ] **Step 8: Create one shared session and one placement function**

```ts
const session = createPuzzleSession({
  metadata: HPA1_FIXTURE,
  runIdFactory: createMobileRunIdFactory(),
  clock: createMobileClock(),
  initialTrayOrder: [0, 1, 2, 3],
  createTrayOrder: () => [0, 1, 2, 3],
  createRotations: (ids) => Object.fromEntries(ids.map((id) => [id, 0])) as Record<number, Rotation>
});

function attemptPlacement(pieceId: number, cell: BoardCell): PuzzleSessionOutcome {
  return session.dispatch({
    type: 'attempt_placement',
    pieceId,
    x: cell.x,
    y: cell.y
  });
}
```

Tap: `select_piece -> cellAt -> attemptPlacement`.

Drag: `pieceAt -> transient Canvas drag -> cellAt on release -> attemptPlacement`.

- [ ] **Step 9: Replace the probe with one concrete Canvas renderer**

`PuzzleCanvas.svelte` owns Canvas reference, image cache, draw order, transient drag position, and native gesture translation. It redraws from `BoardViewModel.state(sessionState)`; it never duplicates correctness rules.

- [ ] **Step 10: Run mobile pure tests and native shared-session smoke**

```bash
bunx vitest run app/gameplay/boardViewModel.test.ts
ns run ios
```

Verify:

```text
2x2 renders
piece tap selection works
correct tap placement accepted
wrong tap placement rejected/counted by PuzzleSession
correct drag placement accepted through same attemptPlacement()
```

- [ ] **Step 11: Commit**

```bash
git add apps/mobile bun.lock
git commit -m "feat: run shared puzzle session on native Canvas"
```

---

## Task 5: Add Synchronous Atomic File Persistence and Offline Relaunch Resume

**Files:**
- Create: `sessionFiles.ts`
- Create: `sessionStorage.ts`
- Create: `sessionStorage.test.ts`
- Modify: `Gameplay.svelte`

**Interfaces:**

```ts
export interface SessionFileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(fromPath: string, toPath: string): void;
  remove(path: string): void;
  ensureDirectory(path: string): void;
}

export function createNativeSessionFileOps(): SessionFileOps;
export function createFileSessionStorageAdapter(options?: {
  fileOps?: SessionFileOps;
  rootPath?: string;
  onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter;
```

- [ ] **Step 1: Write RED adapter tests with one in-memory `SessionFileOps` fake**

Pin temp-before-replace order:

```ts
expect(operations).toEqual([
  'mkdir:/docs/perseus/sessions',
  'write:/docs/perseus/sessions/hpa-1-offline-fixture.json.tmp',
  'replace:/docs/perseus/sessions/hpa-1-offline-fixture.json.tmp->/docs/perseus/sessions/hpa-1-offline-fixture.json'
]);
```

Also test:

```text
valid shared-codec load
peek invalid is non-destructive
load invalid removes canonical file and returns missing
clear missing is harmless
read/write/remove errors call onError with existing error kinds
```

Run:

```bash
cd apps/mobile
bunx vitest run app/gameplay/sessionStorage.test.ts
```

- [ ] **Step 2: Implement concrete synchronous file operations**

Root:

```ts
const rootPath = path.join(knownFolders.documents().path, 'perseus', 'sessions');
```

Use NativeScript synchronous read/write/remove APIs. `replace(temp, target)` must use a same-volume atomic replacement/move primitive on iOS; do not implement atomicity as `remove(target)` then `rename(temp)`.

Keep platform detail inside `sessionFiles.ts`. Do not add a filesystem dependency/framework.

- [ ] **Step 3: Implement the adapter over game-core codec**

Read:

```ts
function readSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
  try {
    return loadPersistedSession(fileOps.readText(canonicalPath(puzzleId)), context);
  } catch (cause) {
    onError?.({ kind: 'read_error', puzzleId, cause });
    return { status: 'missing' };
  }
}
```

Save:

```ts
function saveSession(puzzleId: string, snapshot: PersistedPuzzleSessionV1): void {
  try {
    fileOps.ensureDirectory(rootPath);
    const target = canonicalPath(puzzleId);
    const temp = `${target}.tmp`;
    fileOps.writeText(temp, JSON.stringify(snapshot));
    fileOps.replace(temp, target);
  } catch (cause) {
    onError?.({ kind: 'write_error', puzzleId, cause });
  }
}
```

`isResumable()` delegates to game-core.

- [ ] **Step 4: Run adapter tests GREEN**

```bash
bunx vitest run app/gameplay/sessionStorage.test.ts
```

- [ ] **Step 5: Hydrate before session creation**

```ts
const validationContext: SessionValidationContext = {
  puzzleId: HPA1_FIXTURE.puzzleId,
  source: HPA1_FIXTURE.source,
  pieceIds: HPA1_FIXTURE.pieces.map((piece) => piece.id),
  gridCols: HPA1_FIXTURE.gridCols,
  gridRows: HPA1_FIXTURE.gridRows,
  pieceCount: HPA1_FIXTURE.pieceCount,
  pieces: HPA1_FIXTURE.pieces
};

const restored = storage.loadSession(HPA1_FIXTURE.puzzleId, validationContext);
```

Pass `restored.snapshot` only for `status === 'loaded'`.

- [ ] **Step 6: Persist meaningful state and lifecycle checkpoints**

```ts
function persist(): void {
  session.checkpointTime();
  const snapshot = serializeSession(session.getState());
  if (snapshot) storage.saveSession(HPA1_FIXTURE.puzzleId, snapshot);
}
```

Persist after accepted/rejected placement when persisted state/counters change, relevant persisted rotation changes, and lifecycle suspension/exit boundaries. Do not save selection/drag coordinates.

- [ ] **Step 7: Wire app suspension/resume through existing clock APIs**

```ts
function onSuspend(): void {
  session.checkpointTime();
  persist();
  session.setDocumentHidden(true);
}

function onResume(): void {
  session.setDocumentHidden(false);
}
```

Register/unregister NativeScript app listeners with the gameplay owner lifecycle. No Pause dialog.

- [ ] **Step 8: Prove terminate/relaunch offline**

Manual sequence:

```text
1. Launch fixture.
2. Place piece 0 correctly.
3. Make one wrong placement so a counter changes.
4. Terminate app.
5. Disable networking / ensure no API dependency is available.
6. Relaunch.
7. Verify piece 0 + counter/session state restored.
8. Place another piece by drag.
```

- [ ] **Step 9: Commit**

```bash
git add apps/mobile
git commit -m "feat: resume mobile puzzle sessions offline"
```

---

## Task 6: Final Cross-Consumer Verification and PR Evidence

**Files:** No planned production files; fix only HPA-1 defects discovered by these gates and update PR validation evidence.

- [ ] **Step 1: Run all Linux-safe unit tasks**

```bash
bun run test:unit
```

Expected: includes game-core and mobile pure tests. It must not invoke an iOS/native build.

- [ ] **Step 2: Run root host-neutral gates**

```bash
bun run check
bun run lint
bun run build
```

Expected: mobile has no native/Xcode Turbo task for these names, so Ubuntu-equivalent root commands remain host-safe.

- [ ] **Step 3: Run game-core purity and old-import fences**

```bash
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
rg "\$lib/services/gameplay/(history|hints|inventory|rotation)|\$lib/services/gameplay/session/(types|session)|\$lib/types/gameplay" apps/web/src
```

Expected: no matches requiring remediation.

- [ ] **Step 4: Re-run representative web gameplay E2E**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
cd ../..
```

- [ ] **Step 5: Verify no generated NativeScript output is tracked**

```bash
git ls-files 'apps/mobile/platforms/**' 'apps/mobile/hooks/**'
git status --short
```

Expected: no generated platform/hook files and only intended HPA-1 changes.

- [ ] **Step 6: Run final iPad smoke**

```bash
cd apps/mobile
ns run ios
```

Record actual versions/device and PASS/FAIL for:

```text
real PNG Canvas gate
workspace @perseus/game-core runtime import
2x2 render
tap placement
drag placement
wrong-placement rejection from shared PuzzleSession
background timer checkpoint
terminate/relaunch offline resume
```

- [ ] **Step 7: Inspect scope**

```bash
git diff main...HEAD --stat
git diff main...HEAD -- packages/game-core apps/mobile apps/web
```

Remove accidental Gallery/download, portrait, pinch/pan framework, auth/sync, SQLite, WebView, alternate renderer, generic repository/DI/global-store, or manual tray work.

- [ ] **Step 8: Update the implementation PR body with observed evidence**

Use concrete values, not placeholders:

```markdown
## Canvas feasibility gate
- NativeScript CLI: <actual>
- @nativescript/canvas: <actual>
- Device: <actual iPad/iOS>
- Real-piece draw/tap/drag/redraw: PASS

## Automated
- bun run test:unit — PASS
- bun run check — PASS
- bun run lint — PASS
- bun run build — PASS
- gameplay-session-controls Chromium desktop — PASS

## Native smoke
- workspace game-core bundle: PASS
- 2x2 tap + drag: PASS
- shared-session rejection behavior: PASS
- terminate/relaunch offline resume: PASS
```

If verification changes no code, do not create an empty commit.

---

## Plan Self-Review

### Spec coverage

- Hard Canvas gate before game-core: Task 1.
- Mobile workspace CI isolation from the first scaffold: Task 1 + Task 6.
- Complete green engine + codec + validation package: Task 2.
- `SessionPuzzleSpec` naming boundary: Task 2 + Task 4.
- Web migration with explicit persistence/codecs search and deletion: Task 3.
- NativeScript `workspace:*` runtime bundle gate with targeted webpack fallback only if demonstrated: Task 4.
- One placement path and app-local BoardViewModel: Task 4.
- Five-operation file seam, atomic save, lifecycle checkpoint, offline resume: Task 5.
- Root/web/native final evidence: Task 6.

### Scope check

This remains one HPA-1 implementation PR. The tasks are sequential commits/review gates inside that PR, not separate tickets or PRs. HPA-2/HPA-3/HPA-46/HPA-4 remain separate roadmap work.

### Type consistency

The plan consistently uses:

```ts
SessionPuzzleSpec
PuzzleSession
PuzzleSessionState
PuzzleSessionOutcome
Clock
RunIdFactory
SessionStorageAdapter
SessionValidationContext
PersistedPuzzleSessionV1
Rotation
PlacedPiece
```

No remaining plan step intentionally uses the engine-local name `PuzzleMetadata`.
