# HPA-1 NativeScript Offline Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the iPad NativeScript/Svelte Native/Canvas stack and host/runtime assumptions first, then extract one shared Perseus gameplay/session core, prove NativeScript can consume it, migrate web, and ship a deterministic offline native puzzle that survives terminate/relaunch.

**Architecture:** The implementation PR starts with a mobile feasibility commit and does not create `packages/game-core` until Canvas, runtime primitives, file replacement, and Ubuntu workspace installation are proven. Game-core then owns the existing engine, codec, generic session-adapter semantics, portable runtime/math helpers, and full pure test parity; web and mobile provide only platform storage/runtime presentation wiring.

**Tech Stack:** Bun 1.3.14 workspaces + Turborepo, TypeScript 5.9, Vitest 4, existing `@perseus/types`, NativeScript/Svelte Native from the official template, official `@nativescript/canvas` 2.x, iOS/iPad simulator or device.

**Spec:** `docs/superpowers/specs/2026-08-23-hpa-1-nativescript-offline-vertical-slice-design.md`

## Global Constraints

- One implementation PR for HPA-1. Review it by commit; do not split the ticket unless its scope is explicitly redesigned first.
- Do not create `packages/game-core` until Task 1 passes every native and Ubuntu gate.
- Do not migrate/delete web copies until Task 3 proves NativeScript can execute a real runtime import from game-core.
- Use only official `@nativescript/canvas`; no polyfill, PixiJS, Phaser, Three.js, WebView renderer, or renderer abstraction.
- `@perseus/game-core` may depend on `@perseus/types` but imports no Svelte, NativeScript, DOM `Storage`, filesystem, fetch, Cloudflare, or analytics API.
- Keep `SessionStorageAdapter` synchronous and implement its semantics once in game-core over a three-method `SessionKeyValueStore`.
- Keep browser storage namespace/enumeration and the Svelte `Readable` wrapper in `apps/web`.
- Keep Canvas hit testing/render projection in `apps/mobile`; move only the existing pure `calculateFitZoom()` math to game-core.
- Use one deterministic checked-in 2×2 local fixture. No HPA-2 gallery/download/manifest/library behavior.
- Both tap and drag terminate at the same shared `attempt_placement` action. Mobile code never decides placement correctness.
- Fixed/fit-only viewport. No production pinch/pan/gesture framework or persisted viewport behavior in the native UI.
- `apps/mobile` must not define Turbo `build`, `check`, or `lint` scripts that invoke Xcode/NativeScript. Its root-CI participation is Linux-safe pure tests only.
- Prefer clean same-volume atomic replacement for mobile session files when Task 1 proves it is readily usable; a documented temp-write + remove-target + rename-temp fallback is acceptable for this pre-release proof.
- No compatibility re-export files after web migration.

---

## Task 1: Prove Canvas, Runtime Primitives, File Replacement, and Ubuntu Workspace Safety

**Files:**
- Create: generated `apps/mobile/**` Svelte Native scaffold
- Create: `apps/mobile/app/components/CanvasProbe.svelte`
- Create: `apps/mobile/app/assets/hpa-1/probe-piece.png`
- Modify: `apps/mobile/app/app.ts`
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/package.json`
- Verify/retain: `apps/mobile/.gitignore`
- Modify: root `bun.lock` when workspace dependency resolution changes it

**Interfaces:** None survive as shared architecture. This task produces gate evidence only: Canvas works, required JS runtime primitives exist, one file replacement mode works, generated native output is ignored, and existing Ubuntu workflows accept the scaffold.

- [ ] **Step 1: Verify the local iOS toolchain**

```bash
ns --version
ns doctor ios
```

Expected: NativeScript CLI, Xcode, CocoaPods, and an iOS simulator/device are usable. Fix host setup only; do not change Perseus architecture to work around a broken local toolchain.

- [ ] **Step 2: Scaffold the mobile app and install only official Canvas**

```bash
cd apps
ns create mobile --svelte
cd mobile
ns plugin add @nativescript/canvas
cd ../..
bun install
```

Keep the template's mutually compatible NativeScript/Svelte versions. `apps/mobile/package.json` must not add Pixi/Phaser/Three/polyfill dependencies.

- [ ] **Step 3: Make Turbo-facing scripts host-safe**

Keep an explicit native command but remove any generated root-task names that would make Turbo invoke an iOS build on Ubuntu. The relevant `scripts` shape is:

```json
{
  "scripts": {
    "ios": "ns run ios"
  }
}
```

Other template-local scripts may remain when they are not named `build`, `check`, or `lint`; later tasks add `test:unit`. Do not add a fake no-op `build` script.

Verify generated native output is ignored:

```bash
git check-ignore apps/mobile/platforms apps/mobile/hooks || true
git status --short apps/mobile
```

`platforms/`, `hooks/`, and generated Xcode/native build output must not appear as staged/untracked product files.

- [ ] **Step 4: Register the official Svelte Canvas element**

At the top of `apps/mobile/app/app.ts` before mounting the root component:

```ts
import '@nativescript/canvas/svelte';
```

Do not copy `registerNativeViewElement()` into Perseus.

- [ ] **Step 5: Add one real Perseus piece PNG**

Copy one generated puzzle piece with a transparent jigsaw boundary to:

```text
apps/mobile/app/assets/hpa-1/probe-piece.png
```

Do not use a rectangle, emoji, or system icon for this gate.

- [ ] **Step 6: Implement the one-screen Canvas/runtime probe**

`CanvasProbe.svelte` keeps the Canvas proof concrete and reports runtime capability in the same screen:

```svelte
<script lang="ts">
  import { File, knownFolders, path } from '@nativescript/core';

  let canvas: any;
  let piece: any;
  let x = 80;
  let y = 80;
  let dragStartX = 0;
  let dragStartY = 0;
  let originX = x;
  let originY = y;
  let status = 'waiting';

  function runtimeStatus(): string {
    const hasClock = typeof globalThis.performance?.now === 'function';
    const cryptoSource = (globalThis as any).crypto;
    const hasCrypto =
      typeof cryptoSource?.randomUUID === 'function' ||
      typeof cryptoSource?.getRandomValues === 'function';
    return `clock=${hasClock} crypto=${hasCrypto}`;
  }

  function draw(): void {
    if (!canvas || !piece) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(piece, x, y, 128, 128);
  }

  function onTap(event: any): void {
    status = `${runtimeStatus()} tap=${Math.round(event.getX())},${Math.round(event.getY())}`;
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
      status = `${runtimeStatus()} drag=${Math.round(event.getX())},${Math.round(event.getY())}`;
      draw();
    }
  }
</script>
```

Use the concrete image-loading API provided by the installed Canvas/NativeScript versions, but keep it in this one probe file; do not add a renderer wrapper.

- [ ] **Step 7: Add a temporary file-replacement probe to the same screen**

Use app-private documents storage and record which strategy succeeds:

```ts
function probeRemoveThenRename(): boolean {
  const root = path.join(knownFolders.documents().path, 'perseus-hpa1-probe');
  const targetPath = path.join(root, 'session.json');
  const tempPath = `${targetPath}.tmp`;
  const target = File.fromPath(targetPath);
  const temp = File.fromPath(tempPath);

  target.writeTextSync('old');
  temp.writeTextSync('new');
  target.removeSync();
  temp.renameSync('session.json');
  return File.fromPath(targetPath).readTextSync() === 'new';
}
```

Before accepting that fallback, attempt the clean same-volume replacement primitive exposed by the installed iOS/NativeScript runtime. If it works reliably, record `atomic` and use it in Task 6. If the bridge/API is absent or awkward enough to fail this gate, run the exact fallback above, record `remove_then_rename`, and continue when the read-back is `new`.

Do not create game-core based on an unexecuted replacement assumption.

- [ ] **Step 8: Launch on an iPad and record every local gate**

```bash
cd apps/mobile
ns run ios
```

Record in the implementation PR:

```text
NativeScript CLI: <actual output from ns --version>
@nativescript/canvas: <actual resolved version>
iPad/iOS: <actual simulator or device>
PNG transparency: PASS/FAIL
Tap coordinates: PASS/FAIL
Drag coordinates: PASS/FAIL
Redraw movement: PASS/FAIL
performance.now: PASS/FAIL
crypto random source: PASS/FAIL
replacement mode: atomic | remove_then_rename | FAIL
clean relaunch without generated-project edits: PASS/FAIL
```

The implementation PR must contain actual values, not the angle-bracket labels above; they are the evidence fields to fill from the just-run commands.

- [ ] **Step 9: Repeat a clean relaunch**

Stop the app and rerun:

```bash
cd apps/mobile
ns run ios
```

The gate fails if it requires manual edits under `platforms/` or the generated Xcode project.

- [ ] **Step 10: Commit the scaffold/gate code only after native checks pass**

```bash
git add apps/mobile bun.lock
git commit -m "feat: prove NativeScript mobile feasibility"
```

**STOP HERE** if any required native gate is red. Do not create `packages/game-core`.

- [ ] **Step 11: Push and trigger the existing Ubuntu workflows before extraction**

```bash
git push

gh pr ready
gh pr checks --watch
```

Require both current **Build & Lint** and **Unit Tests** jobs green. This is the actual proof that root Ubuntu `bun install` accepts the NativeScript workspace and Turbo does not try to run Xcode.

**STOP HERE** if either workflow is red because of the mobile scaffold. Fix only workspace/package integration and rerun before Task 2.

---

## Task 2: Create One Green `@perseus/game-core` With Engine, Codec, Adapter Semantics, and Portable Helpers

**Precondition:** Task 1 native gate and both Ubuntu workflows are green.

**Files:**
- Create: `packages/game-core/package.json`
- Create: `packages/game-core/tsconfig.json`
- Create: `packages/game-core/vitest.config.ts`
- Create: `packages/game-core/src/index.ts`
- Copy/adapt: web `history.ts`, `hints.ts`, `rotation.ts`, `inventory.ts` and tests
- Copy/adapt: web `session/types.ts`, `session/session.ts` and session tests
- Create: `packages/game-core/src/session/codec.ts`
- Create: `packages/game-core/src/session/storage.ts`
- Create: `packages/game-core/src/session/runId.ts`
- Create: `packages/game-core/src/runtime.ts`
- Create: `packages/game-core/src/geometry.ts`
- Create/move: corresponding pure tests
- Modify: `.github/workflows/unit-test.yml`
- Modify: root `bun.lock`
- Keep untouched for now: existing web pure source copies and web consumers

**Interfaces produced:**

```ts
export interface SessionKeyValueStore {
  getItem(puzzleId: string): string | null;
  setItem(puzzleId: string, value: string): void;
  removeItem(puzzleId: string): void;
}

export function createSessionStorageAdapter(options: {
  store: SessionKeyValueStore;
  onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter;

export function createDefaultClock(): Clock;

export interface RunIdCrypto {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

export function createRunIdFactory(source: RunIdCrypto): RunIdFactory;
export function calculateFitZoom(
  puzzleWidth: number,
  puzzleHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  paddingFactor?: number
): number;
export function validationContextFrom(spec: SessionPuzzleSpec): SessionValidationContext;
```

- [ ] **Step 1: Create the package and assertion-strict Vitest config**

`packages/game-core/package.json` starts source-first so web and the first NativeScript gate can test direct workspace consumption:

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

Copy `packages/types/tsconfig.json`. Copy its Vitest config but add the assertion contract web currently supplies:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    expect: { requireAssertions: true },
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text', 'html'],
      reportsDirectory: './coverage'
    }
  }
});
```

- [ ] **Step 2: Copy rather than move the pure engine/helper sources and tests**

```bash
mkdir -p packages/game-core/src/session
cp apps/web/src/lib/services/gameplay/history.ts packages/game-core/src/history.ts
cp apps/web/src/lib/services/gameplay/history.test.ts packages/game-core/src/history.test.ts
cp apps/web/src/lib/services/gameplay/hints.ts packages/game-core/src/hints.ts
cp apps/web/src/lib/services/gameplay/hints.test.ts packages/game-core/src/hints.test.ts
cp apps/web/src/lib/services/gameplay/rotation.ts packages/game-core/src/rotation.ts
cp apps/web/src/lib/services/gameplay/rotation.test.ts packages/game-core/src/rotation.test.ts
cp apps/web/src/lib/services/gameplay/inventory.ts packages/game-core/src/inventory.ts
cp apps/web/src/lib/services/gameplay/inventory.test.ts packages/game-core/src/inventory.test.ts
cp apps/web/src/lib/services/gameplay/session/types.ts packages/game-core/src/session/types.ts
cp apps/web/src/lib/services/gameplay/session/session.ts packages/game-core/src/session/session.ts
cp apps/web/src/lib/services/gameplay/session/session.test.ts packages/game-core/src/session/session.test.ts
cp apps/web/src/lib/services/gameplay/session/session.edge.test.ts packages/game-core/src/session/session.edge.test.ts
```

Do not delete the originals yet.

- [ ] **Step 3: Make package-local primitives and rename engine metadata**

In game-core `session/types.ts`:

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

Change only the copied engine contract name: `CreatePuzzleSessionOptions.metadata: SessionPuzzleSpec`. Do not change action/outcome/lifecycle names.

- [ ] **Step 4: Remove `$lib` type dependencies from copied helpers/engine**

`inventory.ts` becomes structurally typed:

```ts
import type { InventoryFilter } from './session/types';

export function matchesInventoryFilter(
  piece: Readonly<{ correctX: number; correctY: number }>,
  grid: Readonly<{ gridCols: number; gridRows: number }>,
  filter: InventoryFilter
): boolean {
  if (filter === 'all') return true;
  const horizontal = piece.correctX === 0 || piece.correctX === grid.gridCols - 1;
  const vertical = piece.correctY === 0 || piece.correctY === grid.gridRows - 1;
  const corner = horizontal && vertical;
  const perimeter = horizontal || vertical;
  if (filter === 'corners') return corner;
  if (filter === 'edges') return perimeter && !corner;
  return !perimeter;
}
```

The copied `session.ts` imports helpers through `../history`, `../hints`, `../inventory`, `../rotation`, and `./types` only.

- [ ] **Step 5: Extract the entire portable codec before running session tests**

Create `packages/game-core/src/session/codec.ts` from the pure region of web persistence and keep the signatures:

```ts
export function serializeSession(
  state: PuzzleSessionState,
  now: number = Date.now()
): PersistedPuzzleSessionV1 | null;

export function loadPersistedSession(
  raw: string | null,
  context: SessionValidationContext
): SessionLoadResult;

export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean;
export function isFailureRetryable(code: CompletionFailureCode): boolean;
```

Move all private V1 validators and clone helpers used by those functions. Update copied `session.test.ts` to import `serializeSession/loadPersistedSession` from `./codec`, not a nonexistent copied `persistence.ts`.

- [ ] **Step 6: Move the existing adapter semantics once over `SessionKeyValueStore`**

Create `session/storage.ts`:

```ts
export interface SessionKeyValueStore {
  getItem(puzzleId: string): string | null;
  setItem(puzzleId: string, value: string): void;
  removeItem(puzzleId: string): void;
}

export function createSessionStorageAdapter(options: {
  store: SessionKeyValueStore;
  onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
  const { store, onError } = options;

  function readSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
    try {
      return loadPersistedSession(store.getItem(puzzleId), context);
    } catch (cause) {
      onError?.({ kind: 'read_error', puzzleId, cause });
      return { status: 'missing' };
    }
  }

  return {
    peekSession: readSession,
    loadSession(puzzleId, context) {
      const result = readSession(puzzleId, context);
      if (result.status !== 'invalid') return result;
      try {
        store.removeItem(puzzleId);
      } catch (cause) {
        onError?.({ kind: 'remove_error', puzzleId, cause });
      }
      return { status: 'missing' };
    },
    saveSession(puzzleId, snapshot) {
      try {
        store.setItem(puzzleId, JSON.stringify(snapshot));
      } catch (cause) {
        onError?.({ kind: 'write_error', puzzleId, cause });
      }
    },
    clearSession(puzzleId) {
      try {
        store.removeItem(puzzleId);
      } catch (cause) {
        onError?.({ kind: 'remove_error', puzzleId, cause });
      }
    },
    isResumable
  };
}
```

This is the existing behavior with browser key construction removed; do not add a repository base class.

- [ ] **Step 7: Split persistence tests by actual ownership**

Move/adapt these pure suites wholesale:

```text
persistence.validation-activity.test.ts
persistence.validation-completion.test.ts
persistence.validation-fields.test.ts
```

Move `persistence.validation-storage.test.ts` assertions that cover generic adapter/error behavior and serializer cloning into game-core tests, replacing the broad `Storage` fake with a three-method `SessionKeyValueStore` fake.

Split the large `persistence.test.ts` by describe-block behavior:

```text
MOVE: serialize/load/isResumable/retryability/cross-field codec tests
MOVE: generic peek/load/save/clear/error semantics
MOVE: UUID formatting/factory tests that inject an explicit crypto source
KEEP WEB: browser global crypto resolution
KEEP WEB: listResumableSessionCandidateIds Storage.length/key enumeration
KEEP WEB: noopThrowingStorage/browser fallback behavior
```

Keep `persistence.fallback-storage.test.ts` web-local. No pure assertion is intentionally deleted.

- [ ] **Step 8: Move the reusable runtime/math helpers**

Create `runtime.ts`:

```ts
export function createDefaultClock(): Clock {
  return {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
  };
}
```

Create `session/runId.ts` by moving the existing UUID-v4 byte formatting behind a structural source:

```ts
export interface RunIdCrypto {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

export function createRunIdFactory(source: RunIdCrypto): RunIdFactory {
  return {
    create: () =>
      typeof source.randomUUID === 'function'
        ? source.randomUUID().toLowerCase()
        : fallbackUuidV4(source)
  };
}
```

`fallbackUuidV4()` keeps the existing version/variant-bit logic; do not introduce `Math.random`.

Move only `calculateFitZoom()` from web `viewport.ts` into `geometry.ts`, preserving its existing formula and fit tests. Leave `clampZoom()` and `clampPan()` in web.

Add to `session/types.ts` or a focused helper module:

```ts
export function validationContextFrom(spec: SessionPuzzleSpec): SessionValidationContext {
  return {
    puzzleId: spec.puzzleId,
    source: spec.source,
    pieceIds: spec.pieces.map((piece) => piece.id),
    gridCols: spec.gridCols,
    gridRows: spec.gridRows,
    pieceCount: spec.pieceCount,
    pieces: spec.pieces
  };
}
```

- [ ] **Step 9: Export only the shared public surface**

`src/index.ts` exports the engine/contracts/helpers/codec/storage/runtime/run-ID/fit/context helper. It does not export browser globals or NativeScript code.

- [ ] **Step 10: Update Unit Tests coverage ownership**

In `.github/workflows/unit-test.yml`, retain current app coverage and add game-core explicitly.

Artifact step:

```yaml
path: |
  apps/*/coverage/lcov.info
  packages/game-core/coverage/lcov.info
```

Codecov step:

```yaml
files: ./apps/*/coverage/lcov.info,./packages/game-core/coverage/lcov.info
```

Do not broaden this into a CI redesign.

- [ ] **Step 11: Install and run the new package before touching web consumers**

```bash
bun install
bun --filter @perseus/game-core test:unit
bun --filter @perseus/game-core build
bun --filter @perseus/web test:unit
```

Expected: game-core is green and web remains green because original web copies still exist.

- [ ] **Step 12: Run the purity fence**

```bash
rg "from ['\"](svelte|@nativescript|\$lib)|localStorage|\bStorage\b|fetch\(|Cloudflare|analytics" packages/game-core/src
```

Expected: no prohibited platform/framework dependency. `SessionKeyValueStore` is allowed because it is not the DOM `Storage` type; if the literal `Storage` regex matches that identifier, inspect the match rather than renaming a clear domain type solely for grep.

- [ ] **Step 13: Commit the independently green extraction**

```bash
git add packages/game-core .github/workflows/unit-test.yml bun.lock
git commit -m "refactor: extract shared Perseus game core"
```

The large copied source is temporary duplication by design. Review the boundary/tests in this commit; Task 4 is where deletion/import migration carries the meaningful cross-app diff.

---

## Task 3: Prove NativeScript Can Execute the Real Workspace Game-Core Package

**Precondition:** Task 2 is green; web still uses old copies.

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/app/App.svelte` or the existing probe component
- Conditionally modify only if demonstrated necessary: `apps/mobile/webpack.config.js`
- Conditionally modify only if source bundling still fails: `packages/game-core/package.json`

**Interfaces:** None new. This is a package-consumption gate.

- [ ] **Step 1: Add the real workspace dependency**

```json
{
  "dependencies": {
    "@perseus/game-core": "workspace:*"
  }
}
```

Merge it into the generated dependency list rather than replacing NativeScript dependencies.

- [ ] **Step 2: Execute a runtime export, not a type-only import**

In the probe screen:

```ts
import { rotateClockwise } from '@perseus/game-core';

const gameCoreProbe = rotateClockwise(0);
```

Render/log `gameCoreProbe === 90` so the runtime module must actually bundle.

- [ ] **Step 3: Run the direct source-package gate**

```bash
bun install
cd apps/mobile
ns run ios
```

PASS means the app launches and reports the runtime result `90`.

- [ ] **Step 4: If direct source bundling fails, allow one targeted webpack correction**

First inspect:

```bash
cd apps/mobile
ns prepare ios --env.verbose
```

If the demonstrated failure is that the existing TS rule/resolution excludes the symlinked workspace source, extend only that existing rule/resolve behavior to include the resolved `packages/game-core/src` path. Do not add another loader or copy source files.

Then rerun:

```bash
ns run ios
```

- [ ] **Step 5: If the targeted correction still fails, use the already-supported `dist/` fallback**

```bash
cd ../..
bun --filter @perseus/game-core build
```

Change game-core package runtime/type exports to:

```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

Then:

```bash
bun install
cd apps/mobile
ns run ios
```

- [ ] **Step 6: Stop before web migration if both supported paths fail**

If direct source consumption (with at most one targeted webpack correction) and the built `dist/` package both fail, **STOP HPA-1 here**. Keep web on its old implementation and report the package-consumption failure. Do not copy `packages/game-core/src` into mobile.

- [ ] **Step 7: Commit only the successful package-consumption path**

```bash
git add apps/mobile packages/game-core/package.json bun.lock
git commit -m "build: prove mobile consumes shared game core"
```

If `packages/game-core/package.json` did not change, omit it from `git add`.

---

## Task 4: Migrate Web to Game-Core and Delete the Temporary Copies

**Precondition:** Task 3 proves NativeScript can execute game-core.

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/store.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.ts`
- Modify: `apps/web/src/lib/services/gameplay/runtime.types.ts`
- Modify: `apps/web/src/lib/services/gameplay/viewport.ts`
- Modify: route/components/tests importing moved engine/helpers/types/codec
- Delete: old web copies of history/hints/inventory/rotation/session engine/contracts and their pure tests
- Delete or narrow: web-local `types/gameplay.ts` and local `PlacedPiece` owner after consumers move
- Modify: root `bun.lock`

**Interfaces:** Web keeps its current public browser adapter signature so current call sites do not need a storage API migration:

```ts
export function createSessionStorageAdapter(options?: {
  storage?: Storage;
  onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter;
```

- [ ] **Step 1: Add the workspace dependency**

```json
"@perseus/game-core": "workspace:*"
```

Run `bun install`.

- [ ] **Step 2: Make browser persistence a namespace/global wrapper over shared semantics**

Keep browser `PROGRESS_KEY_PREFIX`, `progressKey()`, storage resolution, fallback storage, and candidate enumeration. Delegate session semantics:

```ts
import {
  createSessionStorageAdapter as createPortableSessionStorageAdapter,
  createRunIdFactory,
  type SessionKeyValueStore,
  type SessionPersistenceError,
  type SessionStorageAdapter
} from '@perseus/game-core';

export function createSessionStorageAdapter(options?: {
  storage?: Storage;
  onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
  const storage = resolveSessionStorage(options?.storage);
  const store: SessionKeyValueStore = {
    getItem: (puzzleId) => storage.getItem(progressKey(puzzleId)),
    setItem: (puzzleId, value) => storage.setItem(progressKey(puzzleId), value),
    removeItem: (puzzleId) => storage.removeItem(progressKey(puzzleId))
  };
  return createPortableSessionStorageAdapter({ store, onError: options?.onError });
}
```

`createBrowserRunIdFactory(cryptoSource?: Crypto)` resolves browser/global crypto exactly as today and returns `createRunIdFactory(resolvedSource)`.

- [ ] **Step 3: Keep the Svelte store web-only**

`session/store.ts` imports `createPuzzleSession` and its types from game-core while keeping the current subscriber/batching implementation unchanged.

- [ ] **Step 4: Reuse portable runtime/math/context helpers**

Replace the route-local default clock body with `createDefaultClock()`.

Move web callers of `calculateFitZoom()` to `@perseus/game-core`; keep `clampZoom()` and `clampPan()` in `viewport.ts`.

Use `validationContextFrom()` where web is currently hand-deriving the same session validation shape. Do not expand the helper to API/network metadata.

- [ ] **Step 5: Migrate all domain imports**

Update `Rotation`, `PlacedPiece`, `SessionPuzzleSpec`, `PuzzleSession*`, history/hints/inventory/rotation helpers, codec functions, and related tests to import from `@perseus/game-core`.

Run completeness searches before deleting anything:

```bash
rg "\$lib/services/gameplay/(history|hints|inventory|rotation)|\$lib/services/gameplay/session/(types|session)|\$lib/types/gameplay" apps/web/src
rg "from ['\"].*session/persistence['\"]" apps/web/src
rg "serializeSession|loadPersistedSession|isResumable|isFailureRetryable" apps/web/src
```

Every first search hit must be migrated. For the persistence/function searches, inspect each hit: browser namespace/crypto/candidate wrappers may remain in `persistence.ts`, but direct portable codec semantics should import game-core rather than the old owner.

- [ ] **Step 6: Delete temporary duplicate pure files and moved tests**

Delete the old web source/test owners after no consumer imports them:

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
```

Remove the old `Rotation` / `PlacedPiece` definitions when no web-local consumer owns them. Do not leave compatibility re-export files.

- [ ] **Step 7: Run the cross-consumer regression gate**

```bash
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
bun run check
bun run lint
bun run build
```

Fix import/ownership mistakes rather than restoring aliases.

- [ ] **Step 8: Run the existing gameplay session-control E2E**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

Expected: unchanged web gameplay behavior.

- [ ] **Step 9: Commit migration + deletion atomically**

```bash
git add apps/web packages/game-core bun.lock
git commit -m "refactor: migrate web to shared game core"
```

Review this commit closely: unlike Task 2's copy noise, this is the semantic ownership/import migration.

---

## Task 5: Run One Deterministic 2×2 Puzzle Through Shared `PuzzleSession`

**Files:**
- Replace/remove: temporary `CanvasProbe.svelte` after its evidence is recorded
- Create: `apps/mobile/app/gameplay/fixture.ts`
- Create: `apps/mobile/app/assets/hpa-1/piece-0.png` through `piece-3.png`
- Create: `apps/mobile/app/gameplay/boardViewModel.ts`
- Create: `apps/mobile/app/gameplay/boardViewModel.test.ts`
- Create: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Create: `apps/mobile/app/gameplay/Gameplay.svelte`
- Create: `apps/mobile/app/gameplay/runtime.ts` only for NativeScript crypto-source resolution
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/package.json` to add Linux-safe `test:unit`

**Interfaces:**

```ts
export interface BoardCell { x: number; y: number }

export interface BoardViewModel {
  cellAt(canvasX: number, canvasY: number): BoardCell | null;
  pieceAt(canvasX: number, canvasY: number, state: Readonly<PuzzleSessionState>): number | null;
  state(session: Readonly<PuzzleSessionState>): BoardRenderState;
}
```

- [ ] **Step 1: Add the deterministic fixture and real assets**

`fixture.ts`:

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

Add four real generated piece PNGs under `app/assets/hpa-1/`. Asset mapping stays app-local; do not create a manifest schema.

- [ ] **Step 2: Add a Linux-safe pure unit test command**

Merge into mobile scripts:

```json
"test:unit": "vitest run app/**/*.test.ts"
```

Add Vitest as a dev dependency only if the generated app does not already resolve the workspace tool.

- [ ] **Step 3: Write RED BoardViewModel tests using shared fit math**

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

The implementation calls shared `calculateFitZoom()`; it does not copy that formula.

- [ ] **Step 4: Run RED then implement the minimal fit/hit-test projection**

```bash
cd apps/mobile
bunx vitest run app/gameplay/boardViewModel.test.ts
```

Implement centered board bounds, `cellAt()`, `pieceAt()`, and draw records. No zoom state, pan state, transform framework, or placement validation.

- [ ] **Step 5: Run BoardViewModel tests green**

```bash
bunx vitest run app/gameplay/boardViewModel.test.ts
```

- [ ] **Step 6: Resolve native crypto only; reuse shared clock/run-ID factory**

`runtime.ts` exports only the platform resolver proven in Task 1:

```ts
import type { RunIdCrypto } from '@perseus/game-core';

export function resolveMobileCrypto(): RunIdCrypto {
  const source = (globalThis as any).crypto;
  if (
    !source ||
    (typeof source.randomUUID !== 'function' && typeof source.getRandomValues !== 'function')
  ) {
    throw new Error('native_crypto_unavailable');
  }
  return source as RunIdCrypto;
}
```

Do not implement another UUID formatter or clock.

- [ ] **Step 7: Create the shared session with existing contracts**

```ts
const session = createPuzzleSession({
  metadata: HPA1_FIXTURE,
  clock: createDefaultClock(),
  runIdFactory: createRunIdFactory(resolveMobileCrypto()),
  initialTrayOrder: [0, 1, 2, 3],
  createTrayOrder: () => [0, 1, 2, 3],
  createRotations: (ids) => Object.fromEntries(ids.map((id) => [id, 0])) as Record<number, Rotation>
});
```

No controller/store framework is added.

- [ ] **Step 8: Route tap and drag through one placement function**

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

Tap flow: `select_piece -> board cellAt -> attemptPlacement`.

Drag flow: `pieceAt -> transient draw position -> cellAt on release -> attemptPlacement`.

Wrong-cell/non-upright rejection comes only from `PuzzleSession`.

- [ ] **Step 9: Replace the probe with one concrete Canvas renderer**

`PuzzleCanvas.svelte` owns the Canvas reference, four-image cache, drawing order, transient drag position, and native gesture translation. It redraws from `BoardViewModel.state(sessionState)` after shared-session notifications.

No renderer interface or second implementation is created.

- [ ] **Step 10: Run pure tests and native gameplay smoke**

```bash
cd apps/mobile
bun run test:unit
ns run ios
```

Verify:

```text
2×2 fixture renders
piece selection works
correct tap placement accepted
wrong tap placement rejected/counted by PuzzleSession
correct drag placement accepted through same attempt_placement action
```

- [ ] **Step 11: Commit**

```bash
git add apps/mobile bun.lock
git commit -m "feat: run shared puzzle session on native Canvas"
```

---

## Task 6: Add the File-Backed Key/Value Store and Prove Offline Relaunch Resume

**Files:**
- Create: `apps/mobile/app/gameplay/sessionFiles.ts`
- Create: `apps/mobile/app/gameplay/sessionStore.ts`
- Create: `apps/mobile/app/gameplay/sessionStore.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`

**Interfaces:**

```ts
export interface SessionFileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(fromPath: string, toPath: string): void;
  remove(path: string): void;
}

export function createFileSessionKeyValueStore(options: {
  rootPath: string;
  fileOps: SessionFileOps;
}): SessionKeyValueStore;
```

- [ ] **Step 1: Write RED tests for file mechanics only**

```ts
it('returns null when the canonical session file is missing', () => {
  const store = createFileSessionKeyValueStore({
    rootPath: '/sessions',
    fileOps: fakeFileOps()
  });
  expect(store.getItem('p1')).toBeNull();
});

it('writes a complete temp file before replacing the canonical file', () => {
  const operations: string[] = [];
  const store = createFileSessionKeyValueStore({
    rootPath: '/sessions',
    fileOps: fakeFileOps(operations)
  });

  store.setItem('p1', '{"ok":true}');

  expect(operations).toEqual([
    'write:/sessions/p1.json.tmp:{"ok":true}',
    'replace:/sessions/p1.json.tmp->/sessions/p1.json'
  ]);
});
```

Do not retest `peekSession/loadSession/clearSession/isResumable` here; those semantics are owned by game-core Task 2 tests.

- [ ] **Step 2: Run RED**

```bash
cd apps/mobile
bunx vitest run app/gameplay/sessionStore.test.ts
```

- [ ] **Step 3: Implement the four-operation file seam using the Task 1 replacement mode**

At native construction time, create the session root once:

```ts
const rootPath = path.join(knownFolders.documents().path, 'perseus', 'sessions');
Folder.fromPath(rootPath);
```

`createNativeSessionFileOps()` uses synchronous NativeScript `File` operations. Its `replace()` implements exactly the mode recorded in Task 1:

- `atomic`: use the proven same-volume replacement bridge/API;
- `remove_then_rename`: remove an existing canonical file, then rename the complete sibling temp file.

Do not add journaling or retry queues.

- [ ] **Step 4: Implement only the file-backed `SessionKeyValueStore`**

```ts
export function createFileSessionKeyValueStore(options: {
  rootPath: string;
  fileOps: SessionFileOps;
}): SessionKeyValueStore {
  const canonical = (id: string) => path.join(options.rootPath, `${id}.json`);

  return {
    getItem(id) {
      return options.fileOps.readText(canonical(id));
    },
    setItem(id, value) {
      const target = canonical(id);
      const temp = `${target}.tmp`;
      options.fileOps.writeText(temp, value);
      options.fileOps.replace(temp, target);
    },
    removeItem(id) {
      options.fileOps.remove(canonical(id));
    }
  };
}
```

The shared game-core `createSessionStorageAdapter({ store })` supplies all session semantics.

- [ ] **Step 5: Run file-store tests green**

```bash
bunx vitest run app/gameplay/sessionStore.test.ts
```

- [ ] **Step 6: Hydrate through the shared context/adapter path**

```ts
const fileStore = createFileSessionKeyValueStore({ rootPath, fileOps });
const storage = createSessionStorageAdapter({ store: fileStore });
const context = validationContextFrom(HPA1_FIXTURE);
const restored = storage.loadSession(HPA1_FIXTURE.puzzleId, context);

const session = createPuzzleSession({
  metadata: HPA1_FIXTURE,
  clock: createDefaultClock(),
  runIdFactory: createRunIdFactory(resolveMobileCrypto()),
  restored: restored.status === 'loaded' ? restored.snapshot : undefined,
  initialTrayOrder: [0, 1, 2, 3],
  createTrayOrder: () => [0, 1, 2, 3]
});
```

- [ ] **Step 7: Persist meaningful mutations and lifecycle checkpoints**

Use one helper:

```ts
function persist(): void {
  session.checkpointTime();
  const snapshot = serializeSession(session.getState());
  if (snapshot) storage.saveSession(HPA1_FIXTURE.puzzleId, snapshot);
}
```

Call it after persisted placement/counter/rotation changes and on suspension/exit boundaries. Selection and drag coordinates do not trigger writes.

- [ ] **Step 8: Wire background timing with the existing engine methods**

```ts
function onSuspend(): void {
  persist();
  session.setDocumentHidden(true);
}

function onResume(): void {
  session.setDocumentHidden(false);
}
```

Register/unregister the NativeScript application listeners with the gameplay screen lifecycle. Do not add a Pause dialog.

- [ ] **Step 9: Prove terminate/relaunch offline resume on iPad**

Manual native sequence:

```text
1. Launch the 2×2 fixture.
2. Place piece 0 correctly.
3. Make one wrong placement so a persisted counter changes.
4. Terminate the app.
5. Disable networking / make no API dependency available.
6. Relaunch.
7. Verify piece 0 and the counter/session state are restored.
8. Place another piece by drag and continue.
9. Background/resume a timed run and verify hidden time does not accumulate as active time.
```

- [ ] **Step 10: Run final automated gates**

```bash
cd ../../..
bun --filter @perseus/game-core test:unit
bun --filter @perseus/web test:unit
bun run test:unit
bun run check
bun run lint
bun run build
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
cd ../mobile
bun run test:unit
```

- [ ] **Step 11: Re-run the final native app smoke**

```bash
cd apps/mobile
ns run ios
```

Record the actual NativeScript/Canvas/iPad versions and PASS/FAIL evidence for Canvas, runtime primitives, selected file replacement mode, workspace game-core import, tap/drag, shared rejection behavior, background timer behavior, and offline terminate/relaunch resume.

- [ ] **Step 12: Re-run current PR checks**

```bash
git push
gh pr checks --watch
```

Require current required workflows green.

- [ ] **Step 13: Commit only implementation/verification changes**

```bash
git add apps/mobile
git commit -m "feat: resume mobile puzzle sessions offline"
```

If final verification required fixes outside mobile, include only those HPA-1 verification fixes in the commit and describe them in the implementation PR body.

---

## Plan Self-Review

### Spec coverage

- Task 1 proves all cheap native/host assumptions before extraction: Canvas, gestures/redraw, clock/crypto, replacement strategy, ignored native output, Ubuntu root install/workflows.
- Task 2 creates one green shared package with engine + codec + generic adapter + existing pure tests, preserves `requireAssertions`, moves fit/runtime/run-ID/context helpers, and keeps coverage reporting truthful.
- Task 3 proves NativeScript runtime consumption before web migration, with source -> targeted webpack -> built `dist/` fallback and a hard stop.
- Task 4 migrates web and deletes duplicates atomically.
- Task 5 proves one shared-session 2×2 Canvas gameplay path with both interaction modes.
- Task 6 adds only file mechanics, composes them with the shared adapter, and proves offline relaunch/background behavior.

### Scope check

No task adds gallery/downloads, portrait, auth/sync, SQLite, cloud save, renderer frameworks, a second session adapter, native E2E infrastructure, or production pinch/pan behavior.

### Type consistency

The plan consistently uses:

```ts
SessionPuzzleSpec
SessionKeyValueStore
SessionStorageAdapter
SessionFileOps
RunIdCrypto
createRunIdFactory
createDefaultClock
validationContextFrom
calculateFitZoom
PuzzleSession
PuzzleSessionState
PuzzleSessionOutcome
```

### Reviewability

Review the implementation PR by commit. Task 2 is intentionally a large mechanical copy/extraction; Task 4's migration/deletion commit is the informative ownership diff. The single-PR decision remains unchanged.