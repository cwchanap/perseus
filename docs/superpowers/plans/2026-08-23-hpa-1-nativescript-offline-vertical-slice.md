# HPA-1 NativeScript Offline Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the iPad NativeScript/Svelte Native/Canvas stack first, then extract Perseus's existing framework-neutral gameplay engine into `@perseus/game-core` and use it to run, save, terminate, relaunch, and resume one deterministic local puzzle entirely offline.

**Architecture:** Treat Canvas viability as a hard gate: `apps/mobile` must draw and manipulate a real Perseus piece PNG on iPad before shared-code extraction begins. After the gate, copy the pure engine/helpers into a new package and get that package green while the web app still uses its old files; only then migrate the web consumer and delete the duplicates. Keep browser storage/Svelte adapters in `apps/web` and native runtime/filesystem/rendering adapters in `apps/mobile`.

**Tech Stack:** Bun 1.3.x workspaces + Turborepo, TypeScript 5.9, Vitest 4, existing `@perseus/types`, NativeScript + Svelte Native from the current official `ns create --svelte` template, official `@nativescript/canvas` 2.x, iOS/iPad simulator or device.

**Spec:** `docs/superpowers/specs/2026-08-23-hpa-1-nativescript-offline-vertical-slice-design.md`

## Global Constraints

- Deliver all HPA-1 implementation work through one implementation PR; do not split Canvas proof, extraction, and mobile vertical slice into separate PRs.
- **Do not create `packages/game-core` until Task 1's iPad Canvas gate passes.** If Task 1 fails, stop HPA-1 and revisit the renderer/UI choice.
- Use the maintained official `@nativescript/canvas` package and its Svelte registration entry. Do not add PixiJS, Phaser, Three.js, `@nativescript/canvas-polyfill`, WebView gameplay, or a second Canvas abstraction.
- `@perseus/game-core` may depend on `@perseus/types`, but must import no Svelte, NativeScript, DOM, browser storage, filesystem, fetch, Cloudflare, or analytics API.
- Keep `@perseus/types` focused on API/wire contracts. Gameplay runtime/session types belong in `@perseus/game-core`.
- Keep `SessionStorageAdapter` synchronous. Do not add an async storage abstraction, database, repository framework, write queue, or persistence index.
- Keep Svelte's `PuzzleSessionStore`, browser run-ID/storage wiring, and browser session-key enumeration in `apps/web`.
- Do not preserve web-local gameplay type/helper files as compatibility aliases after migration. Update imports cleanly and delete the old files in Task 3.
- Use one checked-in deterministic 2x2 local fixture; no network API, download manifest, Gallery, Downloaded library, or HPA-2 behavior.
- The HPA-1 viewport is fixed/fit-only. No production pinch/pan, gesture-arbitration framework, persisted viewport, or HPA-3 UI polish.
- Both tap and drag placement must call the same shared `PuzzleSession` `attempt_placement` action. Do not duplicate correctness rules in mobile code.
- No portrait, authentication, completion sync, cloud save, SQLite, or generic state-management framework.
- Native UI automation is not required. Use pure TypeScript tests plus a recorded iPad simulator/device smoke checklist.

---

## File Structure

### Task 1 — Canvas gate only

Generated/created under `apps/mobile`:

- `apps/mobile/package.json` — generated NativeScript/Svelte Native app dependencies and scripts.
- `apps/mobile/nativescript.config.ts` — generated app configuration; keep generated defaults unless iOS launch requires a targeted setting.
- `apps/mobile/webpack.config.js` — generated NativeScript bundler configuration; no custom renderer aliasing.
- `apps/mobile/app/app.ts` — app bootstrap plus `@nativescript/canvas/svelte` registration import.
- `apps/mobile/app/App.svelte` — host the gate screen.
- `apps/mobile/app/components/CanvasProbe.svelte` — one temporary Canvas probe for PNG draw/tap/drag/redraw.
- `apps/mobile/app/assets/hpa-1/probe-piece.png` — one real generated Perseus piece PNG.

The probe is allowed to be replaced by the final gameplay screen after the gate passes. Do not build package extraction around unverified Canvas code.

### Shared package after the gate

- `packages/game-core/package.json`
- `packages/game-core/tsconfig.json`
- `packages/game-core/src/index.ts`
- `packages/game-core/src/history.ts`
- `packages/game-core/src/history.test.ts`
- `packages/game-core/src/hints.ts`
- `packages/game-core/src/hints.test.ts`
- `packages/game-core/src/inventory.ts`
- `packages/game-core/src/inventory.test.ts`
- `packages/game-core/src/rotation.ts`
- `packages/game-core/src/rotation.test.ts`
- `packages/game-core/src/session/types.ts`
- `packages/game-core/src/session/session.ts`
- `packages/game-core/src/session/session.test.ts`
- `packages/game-core/src/session/session.edge.test.ts`
- `packages/game-core/src/session/codec.ts`
- `packages/game-core/src/session/codec.test-fixtures.ts`
- `packages/game-core/src/session/codec.test.ts`
- focused codec validation tests moved from the current persistence suite as needed.

### Web files retained/changed

- `apps/web/package.json` — add workspace dependency on `@perseus/game-core`.
- `apps/web/src/lib/services/gameplay/session/store.ts` + tests — remain the Svelte adapter, import game-core.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` + browser-storage tests — retain localStorage/run-ID/key enumeration only, import game-core codec/types.
- `apps/web/src/lib/services/gameplay/runtime.ts`
- `apps/web/src/lib/services/gameplay/runtime.types.ts`
- `apps/web/src/lib/testing/e2e-gameplay-runtime.ts`
- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/SessionPauseDialog.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- tests touching the moved public types/helpers.
- `apps/web/src/lib/types/puzzle.ts` — stop owning `PlacedPiece`.
- delete after migration: web `history`, `hints`, `inventory`, `rotation`, `session/session`, `session/types`, `types/gameplay`, and their pure unit tests.

### Final mobile vertical slice

- `apps/mobile/app/gameplay/fixture.ts` — deterministic 2x2 metadata and local asset map.
- `apps/mobile/app/assets/hpa-1/piece-0.png` ... `piece-3.png` — checked-in real generated Perseus piece assets.
- `apps/mobile/app/gameplay/runtime.ts` — NativeScript `Clock` + `RunIdFactory` adapters.
- `apps/mobile/app/gameplay/boardViewModel.ts` + `.test.ts` — fit transform, hit testing, render projection only.
- `apps/mobile/app/gameplay/sessionFiles.ts` — concrete synchronous NativeScript filesystem operations.
- `apps/mobile/app/gameplay/sessionStorage.ts` + `.test.ts` — synchronous atomic `SessionStorageAdapter` implementation.
- `apps/mobile/app/gameplay/PuzzleCanvas.svelte` — concrete native Canvas renderer + tap/drag event translation.
- `apps/mobile/app/gameplay/Gameplay.svelte` — one session/controller screen, persistence policy, lifecycle wiring.
- `apps/mobile/app/App.svelte` — host the final vertical slice instead of the probe.

---

## Task 1: Prove NativeScript + Svelte Native + Canvas on iPad

**Files:**
- Create generated `apps/mobile/**` scaffold.
- Create: `apps/mobile/app/components/CanvasProbe.svelte`
- Create: `apps/mobile/app/assets/hpa-1/probe-piece.png`
- Modify: `apps/mobile/app/app.ts`
- Modify: `apps/mobile/app/App.svelte`
- Modify: root `bun.lock` after workspace install if dependency resolution changes it.

**Interfaces:** No reusable gameplay interface is produced by this task. The output is a verified fact: the selected native stack can load/draw a real piece PNG, report local tap/drag coordinates, and redraw it after position change on iPad.

- [ ] **Step 1: Verify the local iOS toolchain before touching shared code**

```bash
ns --version
ns doctor ios
```

Expected: NativeScript CLI is installed and the iOS doctor completes without a blocking Xcode/CocoaPods/runtime error. A missing host tool is an environment fix, not a repository architecture change.

- [ ] **Step 2: Scaffold only the mobile shell**

```bash
cd apps
ns create mobile --svelte
cd mobile
ns plugin add @nativescript/canvas
cd ../..
bun install
```

Keep the official template's mutually compatible NativeScript/Svelte versions. Confirm `apps/mobile/package.json` resolves `@nativescript/canvas` on the 2.x line. Do not add `@nativescript/canvas-polyfill`.

- [ ] **Step 3: Register the official Svelte Canvas element**

At the top of `apps/mobile/app/app.ts`, before mounting the root component:

```ts
import '@nativescript/canvas/svelte';
```

Do not copy the package's internal `registerNativeViewElement()` into Perseus.

- [ ] **Step 4: Add one real generated Perseus PNG fixture**

Generate/copy one small piece using existing Perseus puzzle generation output and commit it as:

```text
apps/mobile/app/assets/hpa-1/probe-piece.png
```

Visually confirm it has the transparent jigsaw boundary used by real gameplay. Do not substitute a rectangle, emoji, or system icon.

- [ ] **Step 5: Implement the smallest Canvas probe**

Create `apps/mobile/app/components/CanvasProbe.svelte` with one Canvas and one status label. Keep the behavior equivalent to:

```svelte
<script lang="ts">
  import { ImageSource } from '@nativescript/core';

  let canvas: any;
  let piece: ImageSource | null = null;
  let x = 80;
  let y = 80;
  let startX = 0;
  let startY = 0;
  let originX = x;
  let originY = y;
  let status = 'waiting for canvas';

  function draw(): void {
    if (!canvas || !piece) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#20242b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(piece, x, y, 128, 128);
  }

  function onLoaded(event: any): void {
    canvas = event.object;
    piece = ImageSource.fromFileSync('~/assets/hpa-1/probe-piece.png');
    status = piece ? 'piece loaded' : 'piece load failed';
    draw();
  }

  function onTap(event: any): void {
    status = `tap ${Math.round(event.getX())},${Math.round(event.getY())}`;
  }

  function onPan(event: any): void {
    if (event.state === 1) {
      startX = event.getX();
      startY = event.getY();
      originX = x;
      originY = y;
    }
    if (event.state === 2) {
      x = originX + event.getX() - startX;
      y = originY + event.getY() - startY;
      status = `drag ${Math.round(event.getX())},${Math.round(event.getY())}`;
      draw();
    }
  }
</script>

<gridLayout rows="*, auto">
  <canvas row="0" on:loaded={onLoaded} on:tap={onTap} on:pan={onPan} />
  <label row="1" text={status} />
</gridLayout>
```

If the installed 2.x package exposes a different concrete event/image type, use that official type/API while keeping this one-file probe behavior. Do not add a wrapper library.

- [ ] **Step 6: Make the probe the only app screen**

`apps/mobile/app/App.svelte`:

```svelte
<script lang="ts">
  import CanvasProbe from './components/CanvasProbe.svelte';
</script>

<page>
  <actionBar title="Perseus Canvas Probe" />
  <CanvasProbe />
</page>
```

- [ ] **Step 7: Build and launch specifically on an iPad simulator/device**

```bash
cd apps/mobile
ns run ios
```

Record the actual output of `ns --version`, the installed `@nativescript/canvas` version from `package.json`/lockfile, the chosen iPad model, and its iOS version in the implementation PR. Record PASS/FAIL for real-PNG transparency, tap coordinates, drag coordinates, redraw movement, and a second clean relaunch.

- [ ] **Step 8: Repeat a clean relaunch**

Stop the app, rerun `ns run ios`, and confirm the proof without manual edits under `platforms/` or the generated Xcode project.

**STOP HERE if any gate item is not reliable.** Do not execute Task 2. Document the failure and redesign the rendering choice.

- [ ] **Step 9: Commit only after the gate passes**

```bash
git add apps/mobile bun.lock
git commit -m "feat: prove NativeScript Canvas on iPad"
```

---

## Task 2: Create a Green `@perseus/game-core` Copy Before Migrating Web

**Precondition:** Task 1 gate passed on iPad.

**Important sequencing:** Copy the pure source/tests into `packages/game-core` first. Do **not** remove the original web files in this task. That temporary duplication keeps the web workspace green while the new package is reviewed/tested independently. Task 3 migrates consumers and deletes the originals in the same green commit.

**Files:**
- Create: `packages/game-core/package.json`
- Create: `packages/game-core/tsconfig.json`
- Create: `packages/game-core/src/index.ts`
- Copy/adapt from web: `history.ts` + test
- Copy/adapt from web: `hints.ts` + test
- Copy/adapt from web: `inventory.ts` + test
- Copy/adapt from web: `rotation.ts` + test
- Copy/adapt from web: `session/types.ts`
- Copy/adapt from web: `session/session.ts` + `session.test.ts` + `session.edge.test.ts`

**Interfaces produced:**

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession;

export function matchesInventoryFilter(
  piece: Readonly<{ correctX: number; correctY: number }>,
  grid: Readonly<{ gridCols: number; gridRows: number }>,
  filter: InventoryFilter
): boolean;
```

- [ ] **Step 1: Create the workspace package using the same small pattern as `@perseus/types`**

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

Copy `packages/types/tsconfig.json` as the starting `packages/game-core/tsconfig.json`; keep its strict ES2022/bundler/declaration settings.

- [ ] **Step 2: Copy helper tests/sources into the package and observe RED**

Use `cp`, editor file creation, or equivalent — **not `git mv`** — so the web sources remain in place:

```bash
cp apps/web/src/lib/services/gameplay/history.ts packages/game-core/src/history.ts
cp apps/web/src/lib/services/gameplay/history.test.ts packages/game-core/src/history.test.ts
cp apps/web/src/lib/services/gameplay/hints.ts packages/game-core/src/hints.ts
cp apps/web/src/lib/services/gameplay/hints.test.ts packages/game-core/src/hints.test.ts
cp apps/web/src/lib/services/gameplay/inventory.ts packages/game-core/src/inventory.ts
cp apps/web/src/lib/services/gameplay/inventory.test.ts packages/game-core/src/inventory.test.ts
cp apps/web/src/lib/services/gameplay/rotation.ts packages/game-core/src/rotation.ts
cp apps/web/src/lib/services/gameplay/rotation.test.ts packages/game-core/src/rotation.test.ts
mkdir -p packages/game-core/src/session
cp apps/web/src/lib/services/gameplay/session/types.ts packages/game-core/src/session/types.ts
cp apps/web/src/lib/services/gameplay/session/session.ts packages/game-core/src/session/session.ts
cp apps/web/src/lib/services/gameplay/session/session.test.ts packages/game-core/src/session/session.test.ts
cp apps/web/src/lib/services/gameplay/session/session.edge.test.ts packages/game-core/src/session/session.edge.test.ts
```

Run:

```bash
bun --filter @perseus/game-core test:unit
```

Expected: FAIL until web-local `$lib/...` imports and primitives are removed from the copies.

- [ ] **Step 3: Make `Rotation` and `PlacedPiece` game-core-owned primitives**

In `packages/game-core/src/session/types.ts`, replace web-local imports with:

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}
```

Keep the existing `@perseus/types` dependency for `ResultClass` and `RecordPuzzleCompletionV1`.

- [ ] **Step 4: Narrow inventory instead of importing web `Puzzle` types**

`packages/game-core/src/inventory.ts`:

```ts
import type { InventoryFilter } from './session/types';

export function matchesInventoryFilter(
  piece: Readonly<{ correctX: number; correctY: number }>,
  grid: Readonly<{ gridCols: number; gridRows: number }>,
  filter: InventoryFilter
): boolean {
  if (filter === 'all') return true;

  const onHorizontalBoundary = piece.correctX === 0 || piece.correctX === grid.gridCols - 1;
  const onVerticalBoundary = piece.correctY === 0 || piece.correctY === grid.gridRows - 1;
  const isCorner = onHorizontalBoundary && onVerticalBoundary;
  const isPerimeter = onHorizontalBoundary || onVerticalBoundary;

  if (filter === 'corners') return isCorner;
  if (filter === 'edges') return isPerimeter && !isCorner;
  return !isPerimeter;
}
```

Update only the copied inventory test to use these structural fields.

- [ ] **Step 5: Replace copied session `$lib` imports with package-local imports**

The copied `packages/game-core/src/session/session.ts` should import through relative package paths, for example:

```ts
import { createHistory, type History } from '../history';
import { getHintPieceId } from '../hints';
import { matchesInventoryFilter } from '../inventory';
import { generateRandomRotations, isUpright, rotateClockwise } from '../rotation';
import type { Rotation } from './types';
```

Do not edit session transition behavior during extraction.

- [ ] **Step 6: Export only the package's real public surface**

`packages/game-core/src/index.ts`:

```ts
export * from './history';
export * from './hints';
export * from './inventory';
export * from './rotation';
export * from './session/types';
export * from './session/session';
```

The codec export is added in Task 3.

- [ ] **Step 7: Run the new package GREEN while web remains untouched**

```bash
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
```

If the web workspace's package name differs, use its existing `name` from `apps/web/package.json`; do not rename it in HPA-1.

- [ ] **Step 8: Run a purity search**

```bash
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: no platform/framework runtime imports. `@perseus/types` is allowed.

- [ ] **Step 9: Commit the independently green package copy**

```bash
git add packages/game-core bun.lock
git commit -m "refactor: add shared Perseus game core"
```

At this commit, temporary duplicated pure source exists by design; the original web app must still compile and test unchanged.

---

## Task 3: Move the Portable Codec, Migrate Web, Then Delete Duplicates

**Files:**
- Create: `packages/game-core/src/session/codec.ts` and focused codec tests.
- Modify: `packages/game-core/src/index.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts` + browser persistence tests.
- Modify: `apps/web/src/lib/services/gameplay/session/store.ts` + test.
- Modify: `apps/web/src/lib/services/gameplay/runtime.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.types.ts`
- Modify: `apps/web/src/lib/testing/e2e-gameplay-runtime.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/SessionPauseDialog.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify matching tests that import moved types/helpers.
- Delete the old web pure copies only after all consumers compile against game-core.

**Interfaces produced:**

```ts
export function serializeSession(
  state: PuzzleSessionState,
  now?: number
): PersistedPuzzleSessionV1 | null;

export function loadPersistedSession(
  raw: string | null,
  context: SessionValidationContext
): SessionLoadResult;

export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean;
export function isFailureRetryable(code: CompletionFailureCode): boolean;
```

The existing web browser adapter signature remains unchanged.

- [ ] **Step 1: Split pure codec tests from browser adapter tests**

Copy the existing pure serialization/validation cases from `apps/web/src/lib/services/gameplay/session/persistence*.test.ts` into focused game-core codec tests. Leave anything that requires browser `Storage`, localStorage enumeration, fallback storage, destructive browser load, or browser `Crypto` in `apps/web`.

At minimum preserve existing assertions equivalent to:

```ts
expect(loadPersistedSession(JSON.stringify(validSnapshot), context)).toMatchObject({
  status: 'loaded'
});

expect(loadPersistedSession('{', context)).toEqual({
  status: 'invalid',
  reason: 'malformed_json'
});
```

and the current cross-field completion/activity/rotation/tray/viewport invariants.

- [ ] **Step 2: Run the copied codec tests RED**

```bash
bun --filter @perseus/game-core test:unit
```

Expected: FAIL because `session/codec.ts` has not been created/exported yet.

- [ ] **Step 3: Extract only portable codec behavior**

Create `packages/game-core/src/session/codec.ts` from the portable parts of web persistence:

```ts
export function serializeSession(...): PersistedPuzzleSessionV1 | null;
export function loadPersistedSession(...): SessionLoadResult;
export function isResumable(...): boolean;
export function isFailureRetryable(...): boolean;
```

Move their private V1 validators/clone helpers too.

Do **not** move these browser concerns:

```ts
createBrowserRunIdFactory
listResumableSessionCandidateIds
createSessionStorageAdapter
noopThrowingStorage
```

- [ ] **Step 4: Export the codec and get game-core GREEN**

Add:

```ts
export * from './session/codec';
```

then run:

```bash
bun --filter @perseus/game-core test:unit
```

Expected: PASS.

- [ ] **Step 5: Add the workspace dependency and make web persistence a browser adapter over game-core**

Merge this into `apps/web/package.json`'s existing dependencies:

```json
"@perseus/game-core": "workspace:*"
```

Update browser persistence imports:

```ts
import {
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

Keep the existing browser adapter behavior: `peekSession()` is non-destructive; `loadSession()` removes invalid localStorage and returns `missing`; storage failures still flow through `onError`.

- [ ] **Step 6: Keep the Svelte store web-only**

`session/store.ts` should import the engine/contracts from game-core while retaining its Svelte `Readable` wrapper:

```ts
import type { Readable } from 'svelte/store';
import {
  createPuzzleSession,
  type CreatePuzzleSessionOptions,
  type PuzzleSession,
  type PuzzleSessionAction,
  type PuzzleSessionOutcome,
  type PuzzleSessionState
} from '@perseus/game-core';
```

Do not move store batching/subscription behavior into game-core.

- [ ] **Step 7: Migrate all remaining domain imports**

Update production/tests so `Rotation`, `PlacedPiece`, session contracts, engine, history/hints/inventory/rotation helpers come from `@perseus/game-core`.

Use searches as the completeness fence:

```bash
rg "\$lib/services/gameplay/(history|hints|inventory|rotation)|\$lib/services/gameplay/session/(types|session)|\$lib/types/gameplay" apps/web/src
```

Expected before deletion: no consumer imports the old files.

- [ ] **Step 8: Delete the temporary web duplicates and old primitive owner**

Remove:

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

In `apps/web/src/lib/types/puzzle.ts`, remove the local `PlacedPiece` definition and consume `PlacedPiece` / `Rotation` from game-core where still needed. Do not add alias/re-export compatibility files.

- [ ] **Step 9: Run focused and repository regression gates**

```bash
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
bun check
bun lint
bun build
```

Use the actual existing web package name if it differs. Fix ownership/import failures rather than adding aliases back.

- [ ] **Step 10: Run the representative existing web gameplay smoke**

From `apps/web`:

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

If current `main` renamed that exact smoke, run the existing deterministic gameplay/session control equivalent. Do not add a new web E2E solely for the extraction.

- [ ] **Step 11: Re-run game-core purity check**

```bash
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: no prohibited dependency.

- [ ] **Step 12: Commit the green migration/deletion together**

```bash
git add packages/game-core apps/web bun.lock
git commit -m "refactor: consume shared game core on web"
```

---

## Task 4: Run a Deterministic 2x2 Puzzle Through Shared `PuzzleSession`

**Files:**
- Replace/remove: `apps/mobile/app/components/CanvasProbe.svelte` once gate evidence is recorded.
- Create: `apps/mobile/app/gameplay/fixture.ts`
- Create: four fixture PNGs under `apps/mobile/app/assets/hpa-1/`.
- Create: `apps/mobile/app/gameplay/runtime.ts`
- Create: `apps/mobile/app/gameplay/boardViewModel.ts`
- Create: `apps/mobile/app/gameplay/boardViewModel.test.ts`
- Create: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Create: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/package.json` — add `@perseus/game-core: workspace:*` plus test dependencies/scripts only when required by the generated app.
- Modify: `apps/mobile/app/App.svelte`

**Interfaces:**

```ts
export interface BoardCell { x: number; y: number }

export interface BoardPieceDraw {
  pieceId: number;
  assetPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  placed: boolean;
}

export interface BoardRenderState {
  board: { x: number; y: number; width: number; height: number };
  pieces: BoardPieceDraw[];
}

export interface BoardViewModel {
  state(session: Readonly<PuzzleSessionState>): BoardRenderState;
  cellAt(canvasX: number, canvasY: number): BoardCell | null;
  pieceAt(canvasX: number, canvasY: number, session: Readonly<PuzzleSessionState>): number | null;
}
```

- [ ] **Step 1: Add the 2x2 fixture metadata and real piece assets**

`fixture.ts`:

```ts
import type { PuzzleMetadata } from '@perseus/game-core';

export const HPA1_FIXTURE: PuzzleMetadata = {
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

export const HPA1_ASSETS: Readonly<Record<number, string>> = {
  0: '~/assets/hpa-1/piece-0.png',
  1: '~/assets/hpa-1/piece-1.png',
  2: '~/assets/hpa-1/piece-2.png',
  3: '~/assets/hpa-1/piece-3.png'
};
```

Use real generated Perseus pieces. This is proof content, not a future HPA-2 manifest.

- [ ] **Step 2: Write RED board-view-model tests**

Pin fit geometry and hit testing without NativeScript:

```ts
it('maps fitted-board taps to canonical 2x2 cells', () => {
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

it('projects placed truth from PuzzleSession state', () => {
  const state = stateWithPlacedPiece({ pieceId: 0, x: 0, y: 0 });
  const vm = createBoardViewModel({
    canvasWidth: 800,
    canvasHeight: 600,
    gridCols: 2,
    gridRows: 2
  });

  expect(vm.state(state).pieces.find((piece) => piece.pieceId === 0)?.placed).toBe(true);
});
```

Keep any `stateWithPlacedPiece()` helper local to this test file; do not import web test fixtures.

- [ ] **Step 3: Run RED**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
```

Expected: FAIL because the view model does not exist.

- [ ] **Step 4: Implement one centered fit transform**

Core hit-test logic:

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

No zoom, pan, matrix framework, or persisted viewport.

- [ ] **Step 5: Run board tests GREEN**

```bash
bunx vitest run app/gameplay/boardViewModel.test.ts
```

- [ ] **Step 6: Add app-local `Clock` and `RunIdFactory` adapters**

Use NativeScript's installed native-backed Crypto surface and standard runtime timers. Keep the public behavior:

```ts
export function createMobileRunIdFactory(): RunIdFactory {
  return {
    create: () => getNativeCrypto().randomUUID().toLowerCase()
  };
}

export function createMobileClock(): Clock {
  return {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
  };
}
```

Implement `getNativeCrypto()` with the public Crypto export actually provided by the generated NativeScript version; do not add a UUID package or put this adapter in game-core.

- [ ] **Step 7: Create one shared session in `Gameplay.svelte`**

```ts
const session = createPuzzleSession({
  metadata: HPA1_FIXTURE,
  runIdFactory: createMobileRunIdFactory(),
  clock: createMobileClock(),
  initialTrayOrder: [0, 1, 2, 3],
  createTrayOrder: () => [0, 1, 2, 3],
  createRotations: (ids) => Object.fromEntries(ids.map((id) => [id, 0])) as Record<number, Rotation>
});
```

No setup screen or runtime dependency container.

- [ ] **Step 8: Define one placement path and use it from both gestures**

```ts
function attemptPlacement(pieceId: number, cell: BoardCell): PuzzleSessionOutcome {
  return session.dispatch({
    type: 'attempt_placement',
    pieceId,
    x: cell.x,
    y: cell.y
  });
}
```

Tap flow: `select_piece` -> board `cellAt()` -> `attemptPlacement()`.

Drag flow: start on `pieceAt()` -> keep transient drag position in Canvas component -> release through board `cellAt()` -> `attemptPlacement()`.

Do not create mobile correctness rules.

- [ ] **Step 9: Replace the probe with `PuzzleCanvas.svelte`**

Reuse the proven Canvas registration/draw path. The component receives shared session state and callbacks, owns image caching and transient drag position, and redraws from `BoardViewModel.state(state)` after every shared-session update.

Do not introduce a renderer interface with multiple implementations.

- [ ] **Step 10: Run pure tests and iPad shared-session smoke**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
ns run ios
```

Verify on iPad:

```text
2x2 fixture renders
piece tap selection works
correct tap placement is accepted
wrong tap placement is rejected/counted by PuzzleSession
correct drag placement is accepted through the same action
```

- [ ] **Step 11: Commit**

```bash
git add apps/mobile bun.lock
git commit -m "feat: run shared puzzle session on native Canvas"
```

---

## Task 5: Add Synchronous Atomic File Persistence and Offline Relaunch Resume

**Files:**
- Create: `apps/mobile/app/gameplay/sessionFiles.ts`
- Create: `apps/mobile/app/gameplay/sessionStorage.ts`
- Create: `apps/mobile/app/gameplay/sessionStorage.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`

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

`SessionFileOps` is a five-operation test seam for one adapter, not a general filesystem abstraction.

- [ ] **Step 1: Write RED adapter tests using an in-memory file-ops fake**

Pin normal save/load and the temp-before-replace order:

```ts
it('writes a sibling temp file before replacing the canonical file', () => {
  const operations: string[] = [];
  const fileOps = fakeFileOps(operations);
  const adapter = createFileSessionStorageAdapter({
    fileOps,
    rootPath: '/docs/perseus/sessions'
  });

  adapter.saveSession('hpa-1-offline-fixture', validSnapshot());

  expect(operations).toEqual([
    'mkdir:/docs/perseus/sessions',
    'write:/docs/perseus/sessions/hpa-1-offline-fixture.json.tmp',
    'replace:/docs/perseus/sessions/hpa-1-offline-fixture.json.tmp->/docs/perseus/sessions/hpa-1-offline-fixture.json'
  ]);
});

it('loads through the shared codec', () => {
  const adapter = createFileSessionStorageAdapter({
    fileOps: fakeFileOpsWithSession(validSnapshot()),
    rootPath: '/docs/perseus/sessions'
  });

  expect(adapter.loadSession(HPA1_FIXTURE.puzzleId, validationContext())).toMatchObject({
    status: 'loaded'
  });
});

it('keeps peek non-destructive and removes invalid data on load', () => {
  const fileOps = fakeFileOpsWithRaw('{');
  const adapter = createFileSessionStorageAdapter({ fileOps, rootPath: '/docs/perseus/sessions' });

  expect(adapter.peekSession(HPA1_FIXTURE.puzzleId, validationContext()).status).toBe('invalid');
  expect(fileOps.has(sessionPath())).toBe(true);

  expect(adapter.loadSession(HPA1_FIXTURE.puzzleId, validationContext()).status).toBe('missing');
  expect(fileOps.has(sessionPath())).toBe(false);
});
```

- [ ] **Step 2: Run RED**

```bash
cd apps/mobile
bunx vitest run app/gameplay/sessionStorage.test.ts
```

- [ ] **Step 3: Implement concrete synchronous NativeScript file operations**

Use app-private documents storage:

```ts
const rootPath = path.join(
  knownFolders.documents().path,
  'perseus',
  'sessions'
);
```

Use `File.readTextSync`, `File.writeTextSync`, `removeSync`, and same-directory synchronous replacement/rename. `replace(fromPath, toPath)` must leave `toPath` containing either the complete previous JSON or the complete new JSON; do not implement it as `remove(toPath)` followed by `rename(fromPath)`.

For the iPad target, use the native iOS atomic replace/move primitive behind `SessionFileOps.replace` when replacing an existing file. Keep that platform detail confined to `sessionFiles.ts`. If an Android implementation is already trivial with the generated NativeScript interop, use `java.nio.file.Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)` there; do not add a filesystem dependency just for cross-platform symmetry in HPA-1.

- [ ] **Step 4: Implement the synchronous adapter over game-core codec**

Read behavior:

```ts
function readSession(
  puzzleId: string,
  context: SessionValidationContext
): SessionLoadResult {
  try {
    return loadPersistedSession(fileOps.readText(canonicalPath(puzzleId)), context);
  } catch (cause) {
    onError?.({ kind: 'read_error', puzzleId, cause });
    return { status: 'missing' };
  }
}
```

Save behavior:

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

`peekSession()` remains non-destructive. `loadSession()` removes an invalid canonical file and returns `missing`, matching web semantics. `isResumable()` delegates to game-core.

- [ ] **Step 5: Run adapter tests GREEN**

```bash
bunx vitest run app/gameplay/sessionStorage.test.ts
```

- [ ] **Step 6: Hydrate from the fixture before creating the session**

Build `SessionValidationContext` directly from `HPA1_FIXTURE`:

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

Pass `restored.snapshot` into `createPuzzleSession()` only when `status === 'loaded'`.

- [ ] **Step 7: Persist after meaningful mutations and lifecycle checkpoints**

Use one helper:

```ts
function persist(): void {
  session.checkpointTime();
  const snapshot = serializeSession(session.getState());
  if (snapshot) {
    storage.saveSession(HPA1_FIXTURE.puzzleId, snapshot);
  }
}
```

Call it after persisted placement/counter/rotation changes and before suspension/termination-relevant lifecycle boundaries. Do not save selection or transient drag coordinates.

- [ ] **Step 8: Wire minimal suspend/resume behavior**

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

Register/unregister NativeScript application listeners with the gameplay owner lifecycle. Do not add a Pause dialog.

- [ ] **Step 9: Prove offline terminate/relaunch resume on iPad**

Manual sequence:

```text
1. Launch fixture.
2. Place piece 0 correctly.
3. Make one wrong placement so a persisted counter changes.
4. Terminate the app.
5. Disable networking / ensure no API dependency is available.
6. Relaunch.
7. Verify piece 0 and session/counter state restore.
8. Place another piece by drag and continue playing.
```

- [ ] **Step 10: Commit**

```bash
git add apps/mobile
git commit -m "feat: resume mobile puzzle sessions offline"
```

---

## Task 6: Final Cross-Consumer Verification and PR Evidence

**Files:** No planned production changes. Update the implementation PR body with observed validation evidence. Fix only HPA-1 defects found by these gates.

**Interfaces:** None.

- [ ] **Step 1: Re-run game-core unit + purity gates**

```bash
bun --filter @perseus/game-core test:unit
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: tests PASS and purity search has no prohibited dependency.

- [ ] **Step 2: Run repository checks**

```bash
bun test:unit
bun check
bun lint
bun build
```

If the generated NativeScript package needs package-local scripts to participate in Turbo, add only the minimal scripts consistent with existing workspaces. Do not disable root checks.

- [ ] **Step 3: Re-run representative web gameplay E2E**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

Expected: PASS with no behavior change attributable to extraction.

- [ ] **Step 4: Re-run final iPad smoke from a clean launch**

```bash
cd apps/mobile
ns run ios
```

Record the actual NativeScript CLI version, actual resolved Canvas version, actual iPad model/iOS version, and PASS/FAIL for:

```text
real Perseus PNG Canvas gate
final 2x2 fixture render
tap placement
drag placement
wrong-placement rejection from shared PuzzleSession
terminate/relaunch with networking unavailable restores progress
background lifecycle does not incorrectly accumulate active timer when timed mode is exercised
```

- [ ] **Step 5: Inspect final scope**

```bash
git diff main...HEAD --stat
git diff main...HEAD -- packages/game-core apps/mobile apps/web
```

Remove accidental Gallery/download, portrait, pinch/pan framework, auth/sync, SQLite, WebView, Pixi/Phaser/Three/polyfill, generic repository/DI/global-store, or manual-tray work.

- [ ] **Step 6: Put validation evidence in the implementation PR body**

The PR body must contain three concrete sections:

```markdown
## Validation

### Canvas feasibility gate
Record the actual NativeScript CLI version, resolved @nativescript/canvas version, iPad model/iOS version, and PASS status for real-piece draw/tap/drag/redraw.

### Automated
List the exact successful game-core unit, root unit/check/lint/build, and representative web Playwright commands.

### Native smoke
Record PASS for 2x2 tap + drag placement, shared-session rejection behavior, and terminate/relaunch offline resume.
```

Do not leave template tokens in the final implementation PR.

- [ ] **Step 7: Commit only verification-driven fixes when needed**

If verification changes no code, do not create an empty commit. If fixes are required:

```bash
git add <only files changed to fix an HPA-1 verification failure>
git commit -m "fix: close HPA-1 verification gaps"
```

---

## Plan Self-Review

### Spec coverage

- Canvas technology risk is gated before extraction: Task 1.
- New game-core is independently green without breaking web between commits: Task 2.
- Portable codec extraction, web migration, and deletion of temporary duplicates happen together: Task 3.
- Deterministic local Canvas gameplay uses the shared session and one placement path: Task 4.
- Synchronous atomic file persistence and offline relaunch resume: Task 5.
- Web parity, package purity, repository checks, and iPad evidence are rechecked together: Task 6.
- HPA-2/HPA-3/HPA-46/HPA-4 concerns remain out of scope.

### Type consistency

The plan consistently uses the existing contracts that move into game-core:

```ts
PuzzleMetadata
PuzzleSession
PuzzleSessionState
PuzzleSessionOutcome
Clock
RunIdFactory
SessionStorageAdapter
SessionValidationContext
SessionLoadResult
PersistedPuzzleSessionV1
SessionPersistenceError
Rotation
PlacedPiece
```

The mobile `BoardViewModel` consumes shared state but owns only presentation geometry. Browser/native storage implementations consume the shared codec but never enter game-core.

### Placeholder and sequencing check

There are no TBD/TODO implementation steps. Runtime version/device values are explicitly instructions to record observed evidence, not unresolved design decisions. Every commit boundary is intended to stay buildable/testable: Task 2 copies before Task 3 migrates/deletes, avoiding a red intermediate web workspace and avoiding compatibility shims.
