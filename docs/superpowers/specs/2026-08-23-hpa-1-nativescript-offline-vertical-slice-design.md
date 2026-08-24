# HPA-1: NativeScript Offline Vertical Slice — Design

**Linear:** HPA-1  
**Status:** Design for implementation  
**Date:** 2026-08-23

## Context

HPA-1 is the first implementation ticket in the reviewed Perseus mobile roadmap. It has no blocker, blocks HPA-2, and exists to answer the highest-risk architectural question before the mobile product grows: can an iPad-first NativeScript + Svelte Native client render and interact with a Perseus puzzle through a native-backed Canvas while reusing the existing gameplay engine and persistence contract?

The broader mobile architecture already lives in `docs/superpowers/specs/2026-08-23-nativescript-mobile-offline-design.md`. HPA-1 implements only the first proof from that roadmap.

Current `main` already contains most of the domain seam:

- `apps/web/src/lib/services/gameplay/session/session.ts` is framework-independent apart from web-local import paths.
- `session/types.ts` contains the portable session contract, but imports tiny web-local `Rotation` and `PlacedPiece` types.
- `history.ts`, `hints.ts`, `rotation.ts`, and the logic in `inventory.ts` are pure TypeScript.
- `session/persistence.ts` mixes the portable codec/validator with browser `Storage` mechanics.
- `session/store.ts` is a thin Svelte adapter and must remain web-only.
- `runtime.ts` owns browser-specific run-ID/randomization/E2E wiring and must remain web-only.

The implementation is therefore an extraction and native proof, not a gameplay rewrite.

## Goals

1. Prove NativeScript + Svelte Native + official `@nativescript/canvas` can build and launch on an iPad simulator/device.
2. Draw a real Perseus puzzle-piece PNG, receive tap/drag coordinates, and redraw it after movement before creating `packages/game-core`.
3. Extract the existing engine, pure helpers, portable codec, and their full parity tests into `@perseus/game-core` as one green extraction unit.
4. Keep `@perseus/game-core` free of Svelte, NativeScript, DOM, browser storage, filesystem, fetch, Cloudflare, and analytics APIs.
5. Keep the Svelte store and browser `Storage` adapter in `apps/web`.
6. Keep `apps/mobile` out of NativeScript/Xcode work in root Turbo/Ubuntu CI while still running its pure unit tests there.
7. Prove NativeScript webpack can consume the real `workspace:*` game-core package before building the full mobile slice.
8. Render one deterministic local 2x2 fixture through a concrete Canvas renderer and small board view model.
9. Route tap and drag placement through the same shared `PuzzleSession` `attempt_placement` action.
10. Persist the session synchronously through app-private files using temp-then-atomic-replace semantics.
11. Prove a partially played puzzle survives termination/relaunch and resumes with networking unavailable.
12. Deliver HPA-1 through one implementation PR, staged so the Canvas gate is the first implementation commit and no extraction commit exists until it passes.

## Non-goals

- Public gallery or puzzle downloads.
- Download manifests, staging directories, library discovery, or HPA-2 work.
- Production pinch zoom, two-finger pan, gesture arbitration, persisted viewport, or HPA-3 polish.
- Full toolbar/tray/reference/hint/pause/completion UI parity.
- Portrait layout or orientation-change behavior.
- Google login, secure token storage, completion submission, outbox, or cloud save.
- SQLite, repository/DI/global-store frameworks, or generic renderer interfaces.
- PixiJS, Phaser, Three.js, `@nativescript/canvas-polyfill`, or a second Canvas stack.
- Backward-compatibility aliases for old web-local gameplay import paths.
- A native E2E framework for this proof.

## Delivery and gate strategy

HPA-1 remains one implementation PR because the ticket is one coherent task: the native playable is the evidence that the shared extraction boundary is useful. The PR must still preserve the gate operationally:

1. Open the implementation PR as a draft with the Canvas probe/scaffold work first.
2. Do not create `packages/game-core` before the probe passes on iPad.
3. If the probe fails, stop the ticket and close/retain that draft PR as failure evidence; do not add an extraction commit.
4. If the probe passes, continue on the same PR with the green extraction, web migration, and offline vertical slice.

This makes “gate before extract” a commit/branch invariant without turning one Linear ticket into multiple PRs.

## Hard feasibility gate

### Minimal scaffold

Create `apps/mobile` from the official Svelte Native template and add only official `@nativescript/canvas` for rendering.

The proof screen has one responsibility:

```text
Svelte Native Page
  -> <canvas>
     -> draw one checked-in real Perseus piece PNG
     -> tap reports local canvas coordinates
     -> drag reports local canvas coordinates
     -> moved piece is redrawn at the new position
```

Use `@nativescript/canvas/svelte` for element registration. Do not maintain a local Canvas registration wrapper unless the official entry demonstrably fails.

The gate fixture must be a real generated Perseus piece PNG with transparency, not a synthetic square or system image.

### Mobile workspace / CI isolation starts at scaffold time

The repository has `apps/*` as workspaces and Turbo task names such as `build`, `check`, `lint`, and `test:unit`. The generated mobile app must not accidentally make Ubuntu CI invoke NativeScript iOS/Xcode work.

After scaffolding:

- retain the template ignore rules for generated `platforms/`, `hooks/`, and other NativeScript build output;
- do not expose a package `build`, `check`, or `lint` script that shells out to `ns build ios`, Xcode, or another macOS-only step;
- keep native execution behind an explicit app-local command such as `ios: ns run ios` or direct `ns run ios`;
- once pure tests exist, expose only a Linux-safe `test:unit` task for the mobile package;
- root Turbo `build/check/lint` may skip the mobile package when it has no matching host-neutral script.

Native correctness is proven by the explicit iPad smoke path, not by pretending an Ubuntu worker can build iOS.

### Pass criteria

On an iPad simulator or physical iPad:

1. `apps/mobile` builds and launches.
2. Canvas is visible and sized predictably.
3. the real piece PNG renders with transparency intact.
4. tap coordinates line up with the Canvas.
5. one-finger drag coordinates update correctly.
6. redraw visibly moves the PNG.
7. a clean relaunch repeats the proof without editing `platforms/` or the generated Xcode project.
8. generated platform/hook output remains ignored and untracked.

Record the NativeScript CLI version, resolved Canvas version, iPad model, and iOS version in the implementation PR.

### Stop condition

If the selected stack cannot satisfy the gate reliably, stop HPA-1. Do not create `packages/game-core`, do not move web files, and do not substitute another renderer inside the ticket without redesigning the Linear scope.

## `@perseus/game-core` boundary after the gate

### Package responsibility

```text
@perseus/types
  API/wire contracts only
       |
       v
@perseus/game-core
  session contracts
  PuzzleSession
  history / hints / rotation / inventory
  session codec + validation
       |
       +----------------+
       v                v
apps/web             apps/mobile
Svelte adapter       Svelte Native UI
localStorage         filesystem adapter
browser runtime      native runtime
```

`@perseus/game-core` may depend on `@perseus/types` for existing completion/result/run-ID wire primitives. It must not absorb general API/client types.

### Avoid the `PuzzleMetadata` collision

`@perseus/types` already exports API `PuzzleMetadata`. The engine currently has a different internal `PuzzleMetadata` contract with only puzzle identity/source/grid/canonical placement fields.

Rename the engine-facing contract during extraction:

```ts
export interface SessionPuzzleSpec {
  puzzleId: string;
  source: PuzzleSourceType;
  pieceCount: number;
  gridCols: number;
  gridRows: number;
  pieces: ReadonlyArray<{ id: number; correctX: number; correctY: number }>;
}
```

`CreatePuzzleSessionOptions.metadata` becomes `SessionPuzzleSpec`. Do not publicly export two unrelated `PuzzleMetadata` names from the packages consumed together by HPA-2.

### Portable primitive types

Game-core owns the gameplay primitives currently stranded in web-local files:

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}
```

Update consumers and delete the old web-local definitions. Do not leave compatibility aliases.

### Helpers and engine

Move substantially unchanged:

- `history.ts`
- `hints.ts`
- `rotation.ts`
- `inventory.ts`
- `session/session.ts`
- `session/types.ts`

`matchesInventoryFilter()` already needs only placement/grid geometry. At the package boundary, replace the web `Pick<PuzzlePiece>` / `Pick<Puzzle>` type dependencies with equivalent structural fields; do not redesign its behavior.

### Codec is part of the same green extraction unit

The session tests already exercise persisted-session round trips. Therefore the first green game-core package must contain both the engine and portable codec; the codec cannot be deferred to a later task.

Move in the same extraction commit:

- `serializeSession()`
- `loadPersistedSession()`
- `isResumable()`
- `isFailureRetryable()`
- all private validators/clone helpers used by them
- every existing pure assertion covering serialization, hydration, activity, completion, rotation, tray organization, viewport, retryability, and cross-field validation

Keep in web:

- `PROGRESS_KEY_PREFIX` / key enumeration
- `resolveSessionStorage()`
- `createBrowserRunIdFactory()` and browser crypto fallback
- `listResumableSessionCandidateIds()`
- `createSessionStorageAdapter()`
- `noopThrowingStorage`
- tests whose behavior depends on browser `Storage`, destructive browser load, storage errors, candidate enumeration, or browser crypto

Some existing persistence test files mix pure codec and browser adapter cases. Split by behavior, not filename, and preserve every existing assertion rather than replacing the validation suite with a few representative examples.

### Testing configuration moves with the package

Create `packages/game-core/vitest.config.ts` using the same small Vitest/coverage pattern as `packages/types/vitest.config.ts`, along with the package `tsconfig.json`. The package should be independently runnable with `bun --filter @perseus/game-core test:unit`.

## Web migration

After game-core is independently green while web still uses its original copies:

1. add `@perseus/game-core: workspace:*` to web;
2. point `session/store.ts` at the shared engine/contracts while keeping its Svelte `Readable` behavior local;
3. reduce web `session/persistence.ts` to browser run-ID/key/storage mechanics over imported codec functions/types;
4. update route/components/runtime/tests to import engine types/helpers/codecs from game-core;
5. delete the duplicated web pure source/test files in that same migration commit;
6. do not leave re-export aliases.

Completeness searches must cover both the old helper/session paths and codec call sites such as `serializeSession`, `loadPersistedSession`, `isResumable`, and `isFailureRetryable`. Direct route/test imports are updated rather than hidden behind the old persistence module.

Run web unit tests and the existing deterministic `e2e/gameplay-session-controls.spec.ts` Chromium-desktop flow after migration.

## NativeScript workspace-package compile gate

The first mobile runtime import from `@perseus/game-core` is a second explicit technical gate. Web/Vite consuming workspace TypeScript does not prove NativeScript webpack will consume the same symlinked `workspace:*` source.

Before building the rest of the mobile gameplay screen:

1. add `@perseus/game-core: workspace:*` to `apps/mobile`;
2. import and execute one small runtime export such as `rotateClockwise(0)` or `createHistory()` from game-core;
3. run `ns run ios` and verify the app launches with that runtime import bundled;
4. remove the temporary probe once the real gameplay screen imports game-core.

If the generated webpack configuration excludes the workspace TypeScript source, inspect the resolved config with `ns prepare ios --env.verbose` and make one targeted `webpack.chainWebpack()` adjustment so the existing TypeScript rule includes the resolved `packages/game-core/src` directory. Do not add a second TypeScript loader, copy shared sources into the app, or change rendering architecture.

A custom webpack change is allowed for workspace compilation only when this gate demonstrates it is required. The existing prohibition is against renderer alias/framework work, not a necessary monorepo include.

## Mobile vertical slice

### Fixture

Use one checked-in deterministic 2x2 fixture:

- stable puzzle ID;
- four canonical pieces with IDs and `correctX` / `correctY`;
- four real generated piece PNGs;
- local asset paths only.

The fixture is typed as `SessionPuzzleSpec`. It is proof content, not an HPA-2 download manifest.

### Native runtime adapters

Keep runtime concerns app-local:

- `createMobileClock()` implements the existing `Clock` contract;
- `createMobileRunIdFactory()` implements `RunIdFactory` using NativeScript core crypto;
- fixed tray order/rotations are sufficient for the proof.

Do not add a runtime container.

### Board view model

`BoardViewModel` stays in `apps/mobile`; web `viewport.ts` solves DOM board zoom/pan and is not the Canvas fit/hit-test seam.

HPA-1 needs only:

```ts
interface BoardCell {
  x: number;
  y: number;
}

interface BoardViewModel {
  state(session: Readonly<PuzzleSessionState>): BoardRenderState;
  cellAt(canvasX: number, canvasY: number): BoardCell | null;
  pieceAt(
    canvasX: number,
    canvasY: number,
    session: Readonly<PuzzleSessionState>
  ): number | null;
}
```

The view model computes one centered fit transform, cell hit testing, and piece draw records. It never decides placement correctness.

### One placement path

Both input modes terminate at one mobile function:

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

Tap: `select_piece -> cellAt -> attemptPlacement`.

Drag: `pieceAt -> transient drag position -> cellAt on release -> attemptPlacement`.

Transient drag position is view state only.

### Concrete Canvas renderer

```text
PuzzleSession snapshot
       |
       v
BoardViewModel
       |
       v
PuzzleCanvas.svelte
       |
       v
CanvasRenderingContext2D
```

There is one renderer. `PuzzleCanvas.svelte` owns Canvas/image cache/draw order/gesture translation. No renderer interface is needed.

## Filesystem session adapter

### Storage shape

```text
<app documents>/perseus/sessions/<puzzleId>.json
```

No downloads/completions/outbox/index directories exist in HPA-1.

### Small filesystem seam

NativeScript filesystem calls cannot be meaningfully executed in the normal Vitest process. Use one narrow test seam:

```ts
export interface SessionFileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(fromPath: string, toPath: string): void;
  remove(path: string): void;
  ensureDirectory(path: string): void;
}
```

This exists only to test one session adapter; it is not a repository/filesystem framework.

### Adapter semantics

Implement the existing synchronous `SessionStorageAdapter`:

- `peekSession()` validates without deleting;
- `loadSession()` removes invalid canonical data and returns `missing`, matching web behavior;
- `saveSession()` writes a sibling `.tmp` file then atomically replaces the canonical file;
- `clearSession()` removes the canonical file;
- `isResumable()` delegates to game-core.

The concrete iOS `replace()` uses the platform-supported same-volume atomic replacement/move primitive behind `SessionFileOps`; do not implement replacement as `remove(target)` followed by `rename(temp)`.

### Save and lifecycle ownership

The gameplay screen checkpoints and persists after meaningful persisted state changes and on application suspension/backgrounding. Selection and drag coordinates remain transient.

At suspension:

1. `checkpointTime()`;
2. serialize/save;
3. `setDocumentHidden(true)` so timed active play stops accumulating.

At resume, call `setDocumentHidden(false)`. HPA-1 does not add a Pause dialog.

## Testing and evidence

### Game-core

The extracted package owns the existing deterministic engine/helper/codec validation coverage. No existing pure validation assertion is intentionally dropped.

### Web

After migration run:

- `bun --filter @perseus/web test:unit`;
- root `bun check`, `bun lint`, and `bun build`;
- `bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop` from `apps/web`.

### Mobile pure tests

Expose a Linux-safe mobile `test:unit` only after pure tests exist. It covers:

- board fit + cell/piece hit testing;
- one-path placement orchestration where useful without NativeScript UI;
- filesystem adapter semantics through `SessionFileOps`;
- temp-before-replace ordering;
- shared codec hydration / invalid cleanup behavior.

Do not add a mobile `build/check/lint` Turbo task that invokes iOS/Xcode.

### Native smoke

Record PASS/FAIL for:

1. Canvas real-PNG gate;
2. game-core runtime workspace import bundled by NativeScript;
3. 2x2 render;
4. tap placement;
5. drag placement;
6. wrong placement rejected/counted by shared `PuzzleSession`;
7. background timer checkpoint behavior;
8. terminate/relaunch with networking unavailable restoring placed pieces/counters.

## Acceptance mapping

- Canvas gate before shared extraction: hard gate section.
- Pure `@perseus/game-core`: package boundary + purity test.
- Existing web behavior preserved: green pre-migration copy, then unit/build/E2E migration gates.
- Mobile fixture rendered and interactive: workspace compile gate + mobile slice.
- Tap/drag share placement rules: one `attemptPlacement` path.
- Offline relaunch resume: synchronous filesystem adapter + native smoke.
- Game-core/mobile service tests: package parity tests + Linux-safe mobile unit tests.

## Explicit scope fences

HPA-1 does not add downloads/gallery, production pinch/pan, portrait, auth/sync, SQLite, WebView, Pixi/Phaser/Three/polyfill, named/manual tray organization, native E2E infrastructure, generic persistence repositories, or cross-platform renderer abstractions.
