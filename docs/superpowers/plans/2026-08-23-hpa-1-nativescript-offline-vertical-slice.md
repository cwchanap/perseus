# HPA-1 NativeScript Offline Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the iPad NativeScript/Svelte Native/Canvas stack first, then extract Perseus's existing framework-neutral gameplay engine into `@perseus/game-core` and use it to run, save, terminate, relaunch, and resume one deterministic local puzzle entirely offline.

**Architecture:** Treat Canvas viability as a hard gate: `apps/mobile` must draw and manipulate a real Perseus piece PNG on iPad before shared-code extraction begins. After the gate, move only pure gameplay/session code and the portable session codec into `packages/game-core`; keep browser storage/Svelte adapters in `apps/web` and native runtime/filesystem/rendering adapters in `apps/mobile`.

**Tech Stack:** Bun 1.3.x workspaces + Turborepo, TypeScript 5.9, Vitest 4, existing `@perseus/types`, NativeScript + Svelte Native from the current official `ns create --svelte` template, official `@nativescript/canvas` 2.x, iOS/iPad simulator or device.

**Spec:** `docs/superpowers/specs/2026-08-23-hpa-1-nativescript-offline-vertical-slice-design.md`

## Global Constraints

- Deliver all HPA-1 implementation work through one implementation PR; do not split Canvas proof, extraction, and mobile vertical slice into separate PRs.
- **Do not create or move `packages/game-core` until Task 1's iPad Canvas gate passes.** If Task 1 fails, stop HPA-1 and revisit the renderer/UI choice.
- Use the maintained official `@nativescript/canvas` package and its Svelte registration entry. Do not add PixiJS, Phaser, Three.js, `@nativescript/canvas-polyfill`, WebView gameplay, or a second Canvas abstraction.
- `@perseus/game-core` may depend on `@perseus/types`, but must import no Svelte, NativeScript, DOM, browser storage, filesystem, fetch, Cloudflare, or analytics API.
- Keep `@perseus/types` focused on API/wire contracts. Gameplay runtime/session types belong in `@perseus/game-core`.
- Keep `SessionStorageAdapter` synchronous. Do not add an async storage abstraction, database, repository framework, write queue, or persistence index.
- Keep Svelte's `PuzzleSessionStore`, browser run-ID/storage wiring, and browser session-key enumeration in `apps/web`.
- Do not preserve web-local gameplay type/helper files as compatibility aliases. Update imports cleanly.
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
- `packages/game-core/src/session/codec.validation-activity.test.ts`
- `packages/game-core/src/session/codec.validation-completion.test.ts`
- `packages/game-core/src/session/codec.validation-fields.test.ts`

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
- `apps/web/src/lib/types/puzzle.ts` — remove web-local `PlacedPiece` ownership and import it from game-core where needed.
- delete the moved web-owned files: `history.ts`, `hints.ts`, `inventory.ts`, `rotation.ts`, `session/session.ts`, `session/types.ts`, and pure tests after their game-core replacements exist.

### Final mobile vertical slice

- `apps/mobile/app/gameplay/fixture.ts` — deterministic 2x2 metadata and local asset map.
- `apps/mobile/app/assets/hpa-1/piece-0.png` ... `piece-3.png` — checked-in real generated Perseus piece assets.
- `apps/mobile/app/gameplay/runtime.ts` — NativeScript `Clock` + `RunIdFactory` adapters.
- `apps/mobile/app/gameplay/boardViewModel.ts` + `.test.ts` — fit transform, hit testing, render projection only.
- `apps/mobile/app/gameplay/sessionFiles.ts` + `.test.ts` — small filesystem operations seam used by the adapter test.
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
- Modify: root `bun.lock` after workspace install if the NativeScript scaffold changes dependency resolution.

**Interfaces:**

No reusable gameplay interface is produced by this task. The only output is a verified fact: the selected native stack can load/draw a real piece PNG, report local tap/drag coordinates, and redraw it after position change on iPad.

- [ ] **Step 1: Verify the local iOS toolchain before touching shared code**

Run from the repository root on the macOS implementation machine:

```bash
ns --version
ns doctor ios
```

Expected: the NativeScript CLI reports an installed version and the iOS doctor completes without a blocking Xcode/CocoaPods/runtime error. If the CLI is absent, install the current stable NativeScript CLI before continuing; do not change repository code to work around a missing host tool.

- [ ] **Step 2: Scaffold only the mobile shell**

```bash
cd apps
ns create mobile --svelte
cd mobile
ns plugin add @nativescript/canvas
cd ../..
bun install
```

Inspect `apps/mobile/package.json` and keep the official template's mutually compatible NativeScript/Svelte versions rather than hand-upgrading the generated stack during HPA-1.

Expected: `@nativescript/canvas` resolves on the 2.x line. Do not add `@nativescript/canvas-polyfill`.

- [ ] **Step 3: Register the official Svelte Canvas element**

At the top of `apps/mobile/app/app.ts`, before the root component is mounted, add:

```ts
import '@nativescript/canvas/svelte';
```

Do not copy the package's internal `registerNativeViewElement()` implementation into Perseus unless this entry demonstrably fails.

- [ ] **Step 4: Add one real generated Perseus PNG fixture**

Generate/copy one small puzzle piece using the existing Perseus puzzle generation output and commit it as:

```text
apps/mobile/app/assets/hpa-1/probe-piece.png
```

Visually confirm the file has the same transparent jigsaw boundary used by real Perseus gameplay. Do not substitute a rectangle, emoji, or SF Symbol.

- [ ] **Step 5: Implement the smallest Canvas probe**

Create `apps/mobile/app/components/CanvasProbe.svelte` with one Canvas, one status label, and no navigation/framework abstraction. Use the plugin's Canvas 2D context and NativeScript's local image source:

```svelte
<script lang="ts">
  import { ImageSource } from '@nativescript/core';

  let canvas: any;
  let piece: ImageSource | null = null;
  let x = 80;
  let y = 80;
  let dragStartX = 0;
  let dragStartY = 0;
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
      dragStartX = event.getX();
      dragStartY = event.getY();
      originX = x;
      originY = y;
    }
    if (event.state === 2) {
      x = originX + event.getX() - dragStartX;
      y = originY + event.getY() - dragStartY;
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

If the current plugin event/image types differ slightly from the example, use the official 2.x API actually installed; keep the behavior and file boundary the same. Do not solve a typing mismatch with a new wrapper library.

- [ ] **Step 6: Make the probe the only app screen**

Replace the generated sample content in `apps/mobile/app/App.svelte` with:

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

Choose an iPad simulator or physical iPad when prompted/available.

Record in the implementation PR:

```text
Canvas gate
- NativeScript CLI: <resolved version>
- @nativescript/canvas: <resolved 2.x version>
- device/simulator: <iPad model>
- iOS: <version>
- real PNG visible with transparency: PASS
- tap coordinates align with Canvas: PASS
- drag coordinates update: PASS
- piece redraw moves after drag: PASS
- second clean relaunch without manual Xcode edits: PASS
```

- [ ] **Step 8: Repeat a clean relaunch**

Stop the app, rerun `ns run ios`, and confirm the same seven gate facts without manual edits under `platforms/` or the generated Xcode project.

**STOP HERE if any gate item is not reliable.** Do not execute Task 2. Document the failure in HPA-1/PR and redesign the rendering choice.

- [ ] **Step 9: Commit only after the gate passes**

```bash
git add apps/mobile bun.lock
git commit -m "feat: prove NativeScript Canvas on iPad"
```

---

## Task 2: Extract the Pure Gameplay Engine and Helper Contracts

**Precondition:** Task 1 gate passed on iPad.

**Files:**
- Create: `packages/game-core/package.json`
- Create: `packages/game-core/tsconfig.json`
- Create: `packages/game-core/src/index.ts`
- Move: `apps/web/src/lib/services/gameplay/history.ts` -> `packages/game-core/src/history.ts`
- Move: `apps/web/src/lib/services/gameplay/history.test.ts` -> `packages/game-core/src/history.test.ts`
- Move: `apps/web/src/lib/services/gameplay/hints.ts` -> `packages/game-core/src/hints.ts`
- Move: `apps/web/src/lib/services/gameplay/hints.test.ts` -> `packages/game-core/src/hints.test.ts`
- Move/adapt: `apps/web/src/lib/services/gameplay/inventory.ts` -> `packages/game-core/src/inventory.ts`
- Move: `apps/web/src/lib/services/gameplay/inventory.test.ts` -> `packages/game-core/src/inventory.test.ts`
- Move/adapt: `apps/web/src/lib/services/gameplay/rotation.ts` -> `packages/game-core/src/rotation.ts`
- Move: `apps/web/src/lib/services/gameplay/rotation.test.ts` -> `packages/game-core/src/rotation.test.ts`
- Move/adapt: `apps/web/src/lib/services/gameplay/session/types.ts` -> `packages/game-core/src/session/types.ts`
- Move/adapt: `apps/web/src/lib/services/gameplay/session/session.ts` -> `packages/game-core/src/session/session.ts`
- Move: `apps/web/src/lib/services/gameplay/session/session.test.ts` -> `packages/game-core/src/session/session.test.ts`
- Move: `apps/web/src/lib/services/gameplay/session/session.edge.test.ts` -> `packages/game-core/src/session/session.edge.test.ts`

**Interfaces produced:**

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}

export interface PuzzleSession {
  getState(): Readonly<PuzzleSessionState>;
  dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
  setDocumentHidden(hidden: boolean): void;
  checkpointTime(): void;
  dispose(): void;
  subscribe(listener: () => void): () => void;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession;

export function matchesInventoryFilter(
  piece: Readonly<{ correctX: number; correctY: number }>,
  grid: Readonly<{ gridCols: number; gridRows: number }>,
  filter: InventoryFilter
): boolean;
```

- [ ] **Step 1: Create the workspace package with the same simple TypeScript pattern as `@perseus/types`**

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

`packages/game-core/tsconfig.json` should match `packages/types/tsconfig.json`'s strict ES2022/bundler/declaration settings.

- [ ] **Step 2: Move helper tests first and observe RED imports**

Use `git mv` for history/hints/inventory/rotation tests and sources, then run:

```bash
bun --filter @perseus/game-core test:unit
```

Expected: FAIL until web-local `$lib/...` imports and missing gameplay primitives are removed.

- [ ] **Step 3: Make `Rotation` and `PlacedPiece` game-core-owned primitives**

In `packages/game-core/src/session/types.ts`, replace the old web-local imports with:

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}
```

Keep the existing `@perseus/types` import for `ResultClass` and `RecordPuzzleCompletionV1`.

- [ ] **Step 4: Narrow the inventory helper instead of importing web `Puzzle` types**

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

Update the moved inventory test to pass only the structural fields this function needs.

- [ ] **Step 5: Move the session engine and replace every `$lib` import with package-local imports**

The top of `packages/game-core/src/session/session.ts` should resolve only through relative package files and its own types, for example:

```ts
import { createHistory, type History } from '../history';
import { getHintPieceId } from '../hints';
import { matchesInventoryFilter } from '../inventory';
import { generateRandomRotations, isUpright, rotateClockwise } from '../rotation';
import type { Rotation } from './types';
```

Do not alter state transitions or completion behavior while moving the file.

- [ ] **Step 6: Add the package barrel only for public game-core APIs**

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

- [ ] **Step 7: Run moved engine/helper tests GREEN**

```bash
bun --filter @perseus/game-core test:unit
```

Expected: PASS for history, hints, inventory, rotation, `PuzzleSession`, and session-edge behavior. Ignore codec coverage until Task 3 only if the moved package's coverage threshold configuration does not require it yet; do not weaken repository thresholds to make the extraction pass.

- [ ] **Step 8: Add a purity guard using TypeScript/import search rather than a framework**

Run:

```bash
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: no runtime/framework/platform import or API match. `@perseus/types` imports are allowed.

- [ ] **Step 9: Commit the pure engine extraction**

```bash
git add packages/game-core
git commit -m "refactor: extract Perseus game core"
```

Do not delete/update the remaining web consumers until Task 3 makes them compile in one coherent follow-up commit.

---

## Task 3: Move the Portable Session Codec and Rewire the Web App

**Files:**
- Create/move: `packages/game-core/src/session/codec.ts`
- Create/move: game-core codec test files listed in File Structure.
- Modify: `packages/game-core/src/index.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: browser persistence tests retained under `apps/web/src/lib/services/gameplay/session/`
- Modify: `apps/web/src/lib/services/gameplay/session/store.ts` and test.
- Modify: `apps/web/src/lib/services/gameplay/runtime.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.types.ts`
- Modify: `apps/web/src/lib/testing/e2e-gameplay-runtime.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/SessionPauseDialog.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify matching tests that import moved types/helpers.
- Delete moved web pure sources/tests once no consumer uses them.

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

The existing web interface remains:

```ts
export function createSessionStorageAdapter(options?: {
  storage?: Storage;
  onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter;
```

- [ ] **Step 1: Split pure codec tests away from browser adapter tests**

Move/rename the existing pure validation fixtures/tests into `packages/game-core/src/session/codec*.test.ts`. Keep tests requiring `Storage`, localStorage enumeration, fallback storage, destructive load, or browser `Crypto` under `apps/web`.

At minimum the game-core codec suite must continue to pin:

```ts
expect(loadPersistedSession(JSON.stringify(validSnapshot), context)).toEqual({
  status: 'loaded',
  snapshot: validSnapshot
});

expect(loadPersistedSession('{', context)).toEqual({
  status: 'invalid',
  reason: 'malformed_json'
});
```

and existing cross-field completion/activity/rotation/tray/viewport invariants without weakening them.

Run the moved tests before implementation and expect import failures:

```bash
bun --filter @perseus/game-core test:unit
```

- [ ] **Step 2: Move only the codec/validator portion of web persistence**

Create `packages/game-core/src/session/codec.ts` containing:

```ts
export function serializeSession(...): PersistedPuzzleSessionV1 | null;
export function loadPersistedSession(...): SessionLoadResult;
export function isResumable(...): boolean;
export function isFailureRetryable(...): boolean;
```

plus the private V1 validators/clone helpers they use.

Do **not** move:

```ts
createBrowserRunIdFactory
listResumableSessionCandidateIds
createSessionStorageAdapter
noopThrowingStorage
```

because those depend on browser `Crypto` / `Storage` or localStorage namespace enumeration.

- [ ] **Step 3: Make web persistence a browser adapter over game-core**

The browser module imports the shared codec and types:

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

Keep the existing adapter behavior unchanged:

```ts
function loadSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
  const result = readSession(puzzleId, context);
  if (result.status !== 'invalid') return result;
  storage.removeItem(progressKey(puzzleId));
  return { status: 'missing' };
}
```

Preserve its existing `onError` catches rather than allowing browser storage failures to escape.

- [ ] **Step 4: Add `@perseus/game-core` to the web workspace and migrate direct imports cleanly**

`apps/web/package.json`:

```json
{
  "dependencies": {
    "@perseus/game-core": "workspace:*"
  }
}
```

Merge this entry into the existing dependency object; do not replace unrelated dependencies.

Update production and tests so domain imports come from `@perseus/game-core`. Examples:

```ts
import {
  createPuzzleSession,
  generateRandomRotations,
  type Rotation,
  type PuzzleSessionAction,
  type PuzzleSessionState
} from '@perseus/game-core';
```

Keep browser `createBrowserRunIdFactory()` imported from web persistence.

- [ ] **Step 5: Keep the Svelte store web-only**

Update `session/store.ts` to:

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

Do not move `Readable` or store batching behavior into game-core.

- [ ] **Step 6: Remove web-local primitive ownership**

In `apps/web/src/lib/types/puzzle.ts`, remove the local `PlacedPiece` definition and import/re-export only where the web file still needs it:

```ts
import type { PlacedPiece, Rotation } from '@perseus/game-core';
```

Delete `apps/web/src/lib/types/gameplay.ts` after all consumers import `Rotation` from game-core. Do not keep a compatibility alias file.

- [ ] **Step 7: Delete moved helper/engine files only after compile search is clean**

Run:

```bash
rg "\$lib/services/gameplay/(history|hints|inventory|rotation)|\$lib/services/gameplay/session/(types|session)|\$lib/types/gameplay" apps/web/src
```

Expected: no production/test consumer remains.

Then remove the moved old files from `apps/web`.

- [ ] **Step 8: Run game-core and web focused tests**

```bash
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
```

Expected: PASS. If the web package uses a different package name, use the exact `name` from `apps/web/package.json`; do not change package naming for HPA-1.

- [ ] **Step 9: Run type/lint/build regression gates**

```bash
bun check
bun lint
bun build
```

Expected: all existing workspaces compile/build. Fix import ownership errors rather than adding path aliases back to deleted web-local modules.

- [ ] **Step 10: Run the representative existing web gameplay smoke**

From `apps/web`, run the existing deterministic gameplay/session control smoke path already used by the repository, for example:

```bash
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

If the exact project/file name changed on current `main`, select the existing gameplay session smoke; do not add a new web E2E solely for the extraction.

- [ ] **Step 11: Commit the codec split and web migration**

```bash
git add packages/game-core apps/web package.json bun.lock
git commit -m "refactor: consume shared game core on web"
```

---

## Task 4: Add a Deterministic 2x2 Mobile Session and Board View Model

**Files:**
- Replace/remove: `apps/mobile/app/components/CanvasProbe.svelte` once the gate evidence is recorded.
- Create: `apps/mobile/app/gameplay/fixture.ts`
- Create: `apps/mobile/app/assets/hpa-1/piece-0.png`
- Create: `apps/mobile/app/assets/hpa-1/piece-1.png`
- Create: `apps/mobile/app/assets/hpa-1/piece-2.png`
- Create: `apps/mobile/app/assets/hpa-1/piece-3.png`
- Create: `apps/mobile/app/gameplay/runtime.ts`
- Create: `apps/mobile/app/gameplay/boardViewModel.ts`
- Create: `apps/mobile/app/gameplay/boardViewModel.test.ts`
- Create: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Create: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/package.json` — add `@perseus/game-core: workspace:*` and direct test dependencies only if the generated app does not inherit them.
- Modify: `apps/mobile/app/App.svelte`

**Interfaces:**

```ts
export interface BoardCell {
  x: number;
  y: number;
}

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

export function createMobileClock(): Clock;
export function createMobileRunIdFactory(): RunIdFactory;
```

- [ ] **Step 1: Add the 2x2 fixture metadata before UI code**

`fixture.ts` should define stable canonical metadata and an asset map:

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

Use real generated Perseus piece PNGs and keep them small. The fixture is deliberately not a future download manifest.

- [ ] **Step 2: Write RED board-view-model tests**

Create tests that pin fit geometry and hit testing without NativeScript:

```ts
it('maps a fitted 2x2 board tap to the canonical cell', () => {
  const vm = createBoardViewModel({ canvasWidth: 800, canvasHeight: 600, gridCols: 2, gridRows: 2 });

  expect(vm.cellAt(250, 150)).toEqual({ x: 0, y: 0 });
  expect(vm.cellAt(550, 450)).toEqual({ x: 1, y: 1 });
  expect(vm.cellAt(5, 5)).toBeNull();
});

it('projects placed pieces from PuzzleSession state instead of keeping its own board truth', () => {
  const state = stateWithPlacedPiece({ pieceId: 0, x: 0, y: 0 });
  const vm = createBoardViewModel({ canvasWidth: 800, canvasHeight: 600, gridCols: 2, gridRows: 2 });

  expect(vm.state(state).pieces.find((piece) => piece.pieceId === 0)?.placed).toBe(true);
});
```

Use small local fixture builders in the test file; do not import web test fixtures.

- [ ] **Step 3: Run the board tests and observe RED**

From `apps/mobile`, run the generated/test script once Vitest is wired, or directly:

```bash
bunx vitest run app/gameplay/boardViewModel.test.ts
```

Expected: FAIL because `createBoardViewModel` does not exist.

- [ ] **Step 4: Implement one fit-only board transform**

`boardViewModel.ts` computes one centered board rectangle with a small fixed margin, derives `cellWidth`/`cellHeight`, and uses floor division for `cellAt()`.

Keep the essential hit-test logic equivalent to:

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

Do not add zoom, pan, matrix classes, or persisted viewport state.

- [ ] **Step 5: Run board tests GREEN**

```bash
bunx vitest run app/gameplay/boardViewModel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add NativeScript runtime adapters without third-party dependencies**

`runtime.ts` uses the framework-neutral contracts:

```ts
import { Crypto } from '@nativescript/core/wgc/crypto';
import type { Clock, RunIdFactory } from '@perseus/game-core';

export function createMobileRunIdFactory(): RunIdFactory {
  const crypto = new Crypto();
  return { create: () => crypto.randomUUID().toLowerCase() };
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

If the installed NativeScript version exports Crypto through a different documented public path, use that public export. Do not add a UUID package.

- [ ] **Step 7: Create one `PuzzleSession` in `Gameplay.svelte`**

Construct the shared engine directly, without Redux/DI/store layers:

```ts
const session = createPuzzleSession({
  metadata: HPA1_FIXTURE,
  runIdFactory: createMobileRunIdFactory(),
  clock: createMobileClock(),
  initialTrayOrder: [0, 1, 2, 3],
  createTrayOrder: () => [0, 1, 2, 3],
  createRotations: (ids) => Object.fromEntries(ids.map((id) => [id, 0]))
});
```

Dispatch `start` once the gameplay screen is ready. Keep the vertical slice relaxed or timed according to the existing default; do not add a setup screen.

- [ ] **Step 8: Implement one shared placement function**

Inside the gameplay controller:

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

Tap flow must call `select_piece` then this function. Drag release must call this same function. No mobile `isCorrectCell()` helper is allowed.

- [ ] **Step 9: Replace the probe with a concrete `PuzzleCanvas.svelte`**

Reuse the proven `<canvas>` element and 2D draw API. The component receives a session snapshot + callbacks and owns only:

```ts
export let state: Readonly<PuzzleSessionState>;
export let onSelectPiece: (pieceId: number) => void;
export let onAttemptPlacement: (pieceId: number, cell: BoardCell) => void;
```

Keep transient drag coordinates inside the component. On every session change, draw from `BoardViewModel.state(state)` so accepted/rejected board truth comes back from the engine.

- [ ] **Step 10: Run mobile pure tests and launch the shared-session screen**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
ns run ios
```

On iPad, verify:

```text
- 2x2 fixture renders from checked-in PNGs
- tapping a piece selects it
- tapping its correct cell places it
- tapping a wrong cell leaves the session unplaced and increments the shared counter
- dragging a piece to the correct cell uses the same shared session action
```

- [ ] **Step 11: Commit the shared-session mobile vertical slice**

```bash
git add apps/mobile packages/game-core bun.lock
git commit -m "feat: run shared puzzle session on native Canvas"
```

---

## Task 5: Add Atomic File Persistence and Offline Relaunch Resume

**Files:**
- Create: `apps/mobile/app/gameplay/sessionFiles.ts`
- Create: `apps/mobile/app/gameplay/sessionFiles.test.ts` if the low-level seam has behavior worth pinning separately.
- Create: `apps/mobile/app/gameplay/sessionStorage.ts`
- Create: `apps/mobile/app/gameplay/sessionStorage.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`

**Interfaces:**

```ts
export interface SessionFileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(from: string, to: string): void;
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

- [ ] **Step 1: Write RED adapter tests against an in-memory file-ops fake**

Pin normal save/load plus atomic ordering:

```ts
it('writes a temp file before replacing the canonical session file', () => {
  const operations: string[] = [];
  const fileOps = fakeFileOps(operations);
  const adapter = createFileSessionStorageAdapter({ fileOps, rootPath: '/docs/perseus/sessions' });

  adapter.saveSession('hpa-1-offline-fixture', validSnapshot());

  expect(operations).toEqual([
    'mkdir:/docs/perseus/sessions',
    'write:/docs/perseus/sessions/hpa-1-offline-fixture.json.tmp',
    'replace:/docs/perseus/sessions/hpa-1-offline-fixture.json.tmp->/docs/perseus/sessions/hpa-1-offline-fixture.json'
  ]);
});

it('loads through the shared codec', () => {
  const fileOps = fakeFileOpsWithSession(validSnapshot());
  const adapter = createFileSessionStorageAdapter({ fileOps, rootPath: '/docs/perseus/sessions' });

  expect(adapter.loadSession(HPA1_FIXTURE.puzzleId, validationContext())).toMatchObject({
    status: 'loaded'
  });
});

it('removes an invalid canonical file on destructive load but not on peek', () => {
  const fileOps = fakeFileOpsWithRaw('{');
  const adapter = createFileSessionStorageAdapter({ fileOps, rootPath: '/docs/perseus/sessions' });

  expect(adapter.peekSession(HPA1_FIXTURE.puzzleId, validationContext()).status).toBe('invalid');
  expect(fileOps.exists(sessionPath())).toBe(true);

  expect(adapter.loadSession(HPA1_FIXTURE.puzzleId, validationContext()).status).toBe('missing');
  expect(fileOps.exists(sessionPath())).toBe(false);
});
```

- [ ] **Step 2: Run RED**

```bash
cd apps/mobile
bunx vitest run app/gameplay/sessionStorage.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the tiny filesystem seam**

Use `knownFolders.documents()` / NativeScript `Folder` + `File` APIs only in `createNativeSessionFileOps()`. The fake interface is not a generic filesystem framework; it exposes exactly the five operations the adapter needs.

Canonical root:

```ts
const rootPath = path.join(knownFolders.documents().path, 'perseus', 'sessions');
```

Do not create downloads/completions/outbox/index directories.

- [ ] **Step 4: Implement the synchronous `SessionStorageAdapter`**

Core behavior:

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

Atomic save:

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

`loadSession()` must mirror web destructive invalid-load semantics; `peekSession()` remains non-destructive. Delegate `isResumable` to game-core.

- [ ] **Step 5: Run adapter tests GREEN**

```bash
bunx vitest run app/gameplay/sessionStorage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Hydrate before creating the mobile session**

In `Gameplay.svelte`, build one validation context from `HPA1_FIXTURE`:

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

const restored = sessionStorage.loadSession(HPA1_FIXTURE.puzzleId, validationContext);

const session = createPuzzleSession({
  metadata: HPA1_FIXTURE,
  restored: restored.status === 'loaded' ? restored.snapshot : undefined,
  runIdFactory: createMobileRunIdFactory(),
  clock: createMobileClock(),
  initialTrayOrder: [0, 1, 2, 3],
  createTrayOrder: () => [0, 1, 2, 3],
  createRotations: (ids) => Object.fromEntries(ids.map((id) => [id, 0]))
});
```

If the restored session lifecycle is `setup`, start it; otherwise preserve the restored lifecycle rather than blindly restarting it.

- [ ] **Step 7: Persist after meaningful session mutations**

Use one helper:

```ts
function persist(): void {
  session.checkpointTime();
  const snapshot = serializeSession(session.getState());
  if (snapshot) {
    sessionStorage.saveSession(HPA1_FIXTURE.puzzleId, snapshot);
  }
}
```

Call it after placement outcomes that mutate persisted state/counters and at lifecycle boundaries. Do not persist selection or transient drag coordinates.

- [ ] **Step 8: Wire minimal app background/resume lifecycle**

Register NativeScript suspend/resume events in the gameplay owner:

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

Register/unregister listeners with the component/app lifecycle. Do not add a Pause dialog.

- [ ] **Step 9: Prove terminate/relaunch offline resume on iPad**

Manual/simulator sequence:

```text
1. Launch fixture.
2. Place piece 0 correctly.
3. Make one wrong placement so a persisted counter changes.
4. Terminate the app from the simulator/device.
5. Disable networking / ensure no network dependency is available.
6. Relaunch.
7. Verify piece 0 remains placed and the session/counter state restores.
8. Place another piece by drag and confirm normal play continues.
```

This must work without any API call or WebView.

- [ ] **Step 10: Commit persistence/resume**

```bash
git add apps/mobile
git commit -m "feat: resume mobile puzzle sessions offline"
```

---

## Task 6: Run Final Cross-Consumer Verification and Document the Gate Evidence

**Files:**
- Modify no production file unless a verification failure exposes an HPA-1 bug.
- Update the implementation PR body with validation evidence; do not create a second closeout document unless repository policy requires it.

**Interfaces:** None.

- [ ] **Step 1: Re-run game-core purity and unit gates**

```bash
bun --filter @perseus/game-core test:unit
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: tests PASS; purity search returns no prohibited runtime/framework/platform dependency.

- [ ] **Step 2: Run repository checks**

```bash
bun test:unit
bun check
bun lint
bun build
```

Expected: PASS for all workspaces that participate in these root Turbo tasks. If NativeScript's generated package does not support a root Turbo script, add only the minimum package scripts/configuration required for the repo's existing workspace convention; do not disable root checks globally.

- [ ] **Step 3: Run the representative web gameplay E2E again**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

Expected: PASS and no web gameplay behavior change attributable to the extraction.

- [ ] **Step 4: Re-run the final iPad smoke from a clean launch**

```bash
cd apps/mobile
ns run ios
```

Record:

```text
Final HPA-1 smoke
- Canvas gate still PASS with official @nativescript/canvas
- final 2x2 fixture renders
- tap placement PASS
- drag placement PASS
- wrong placement rejected by shared PuzzleSession PASS
- terminate/relaunch with network unavailable restores progress PASS
- app background does not accumulate active timer unexpectedly PASS (if timed fixture exercised)
```

- [ ] **Step 5: Inspect the final diff for scope creep**

```bash
git diff main...HEAD --stat
git diff main...HEAD -- packages/game-core apps/mobile apps/web
```

Reject/remove any accidental addition of:

```text
Gallery/download API
portrait UI
pinch/pan framework
auth/sync
SQLite
WebView
Pixi/Phaser/Three/canvas-polyfill
generic repository/DI/global store
manual tray organization
```

- [ ] **Step 6: Add the exact validation section to the implementation PR**

Use this shape:

```markdown
## Validation

### Canvas feasibility gate
- NativeScript CLI: `<version>`
- `@nativescript/canvas`: `<version>`
- iPad/iOS: `<model + version>`
- real Perseus PNG draw/tap/drag/redraw: PASS

### Automated
- `bun --filter @perseus/game-core test:unit`
- `bun test:unit`
- `bun check`
- `bun lint`
- `bun build`
- representative web Playwright gameplay smoke

### Native smoke
- 2x2 fixture tap + drag placement
- wrong-placement rejection from `PuzzleSession`
- terminate/relaunch offline resume
```

- [ ] **Step 7: Commit only verification-driven fixes, if any**

If no code changed, do not create an empty commit. If fixes were required:

```bash
git add <only HPA-1 fix files>
git commit -m "fix: close HPA-1 verification gaps"
```

---

## Plan Self-Review

### Spec coverage

- Canvas technology risk is gated before extraction: Task 1.
- `@perseus/game-core` owns only pure gameplay/session behavior: Tasks 2-3.
- browser adapters remain browser-owned: Task 3.
- deterministic local Canvas vertical slice with one placement path: Task 4.
- synchronous atomic filesystem persistence and offline relaunch resume: Task 5.
- web parity, package purity, and iPad evidence are rechecked together: Task 6.
- HPA-2/HPA-3/HPA-46/HPA-4 concerns are explicitly absent from all implementation tasks.

### Type consistency

The plan uses the existing game-core-bound contracts consistently:

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

The mobile `BoardViewModel` consumes `PuzzleSessionState` but produces only presentation geometry. `SessionStorageAdapter` consumes the codec but neither storage implementation enters game-core.

### No-placeholder check

The plan contains no TBD implementation requirement. Version values that must reflect the implementation machine/install are intentionally recorded as `<resolved version>` in PR validation evidence rather than hardcoded into product behavior; the implementation uses the official generated Svelte Native compatibility set and current Canvas 2.x line.
