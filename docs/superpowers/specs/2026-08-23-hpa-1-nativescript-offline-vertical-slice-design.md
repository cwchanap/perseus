# HPA-1: NativeScript Offline Vertical Slice — Design

**Linear:** HPA-1  
**Status:** Design for implementation  
**Date:** 2026-08-23

## Context

HPA-1 is the first implementation ticket in the reviewed Perseus mobile roadmap. It exists to answer the highest-risk question cheaply: can NativeScript + Svelte Native + the official native Canvas run Perseus gameplay on iPad while sharing the existing engine and session semantics with web?

Current `main` already provides most of the reusable seam:

- `session/session.ts` is framework-independent apart from `$lib` import paths;
- `history.ts`, `hints.ts`, `rotation.ts`, and the logic in `inventory.ts` are pure TypeScript;
- `session/persistence.ts` mixes portable session semantics with browser namespace/global wiring;
- `session/store.ts` is a thin Svelte adapter and remains web-only;
- `viewport.ts` contains one reusable pure fit calculation plus DOM-board pan/zoom helpers that remain web-only.

This ticket extracts existing behavior and proves a native consumer. It does not create a second gameplay engine or persistence policy.

## Goals

1. Prove Canvas, tap/drag/redraw, runtime clock/crypto availability, a usable temp-file replacement strategy, and Ubuntu workspace installation before creating `packages/game-core`.
2. Extract one green `@perseus/game-core` containing `PuzzleSession`, pure helpers, portable codec/validation, shared session-adapter semantics, default clock, run-ID formatting/factory, fit math, and validation-context derivation.
3. Preserve all existing pure validation assertions under Node Vitest with `requireAssertions: true`.
4. Prove NativeScript can bundle the real `workspace:*` game-core package before migrating web away from its existing copies.
5. Migrate web cleanly and delete duplicate pure sources/tests without compatibility aliases.
6. Render one deterministic local 2×2 puzzle through a concrete Canvas view, with tap and drag terminating at the same `attempt_placement` action.
7. Persist mobile sessions through a file-backed key/value store and prove terminate/relaunch offline resume.
8. Keep HPA-1 one implementation PR, with hard stop gates enforced by commit order.

## Non-goals

- HPA-2 gallery/downloads/manifests/library work.
- HPA-3 production pinch/pan/gesture arbitration or full tablet gameplay parity.
- Portrait/adaptive layout.
- Authentication, completion sync, cloud saves, SQLite, WebView gameplay, native E2E framework, DI/repository/global-store frameworks, or multiple Canvas/rendering stacks.
- Manual/named tray organization.
- Backward-compatibility aliases for pre-release web-local imports.

## Delivery strategy

HPA-1 remains one implementation PR. The sequence is the safety mechanism:

1. Open the implementation PR as a draft with only the mobile probe/scaffold commit.
2. Pass the complete Task 1 feasibility gate before `packages/game-core` exists.
3. Mark the implementation PR ready after the local/native gate passes so the Ubuntu Build & Lint and Unit Tests workflows exercise the scaffold; require both green before extraction.
4. Create game-core while web still uses its old copies.
5. Prove NativeScript consumes the real game-core runtime package before migrating/deleting web copies.
6. Only then migrate web and finish the mobile vertical slice.

If a hard gate fails, stop HPA-1 at that point and report the finding. Do not copy shared sources into mobile to bypass a package-consumption failure.

## Task 1 feasibility gate

### Canvas proof

Create `apps/mobile` from the official Svelte Native template and add only `@nativescript/canvas`. The single probe screen must:

- draw one real generated Perseus piece PNG with transparency intact;
- report local Canvas tap coordinates;
- report changing one-finger drag coordinates;
- redraw the piece at a changed position;
- repeat after a clean relaunch without editing generated `platforms/` or Xcode output.

Use `@nativescript/canvas/svelte` for registration. Do not add the polyfill or a wrapper renderer.

### Runtime primitive proof

The same on-device probe must display and verify:

```ts
typeof globalThis.performance?.now === 'function'
```

and a usable cryptographic random source that exposes `randomUUID()` or `getRandomValues()` for the shared `RunIdFactory`. A UUID dependency is not added unless this gate disproves the existing runtime assumption and the ticket is redesigned.

### Session-file replacement proof

Before extraction, use a tiny app-private test file to determine the concrete iOS write strategy:

1. write an existing canonical file;
2. write a complete sibling temporary file;
3. attempt the clean same-volume replacement mechanism available through the NativeScript/iOS runtime;
4. read the canonical path and verify it contains the complete new value;
5. record the selected replacement mode in the implementation PR.

Atomic replacement is preferred when cleanly reachable. If the public/runtime bridge does not provide a reliable replacement primitive for this proof, `remove(target) -> rename(temp)` is an acceptable HPA-1 fallback. The save remains temp-first so the canonical path is never written incrementally. Do not build a journal, lock, or recovery subsystem.

### Workspace/Ubuntu proof

`apps/mobile` is under the root `apps/*` workspace. Preserve the template ignore rules for `platforms/`, `hooks/`, and generated native output. Do not expose `build`, `check`, or `lint` scripts that invoke NativeScript/Xcode; the mobile package participates in Turbo only through Linux-safe pure tests when those tests exist.

After the native probe passes, push the scaffold commit and mark the implementation PR ready long enough to require both current Ubuntu workflows green. This proves root `bun install` accepts the NativeScript dependency graph and that Turbo does not invoke Xcode work before game-core extraction begins.

## `@perseus/game-core` boundary

### Core session contract

Rename the engine-local `PuzzleMetadata` to avoid collision with `@perseus/types.PuzzleMetadata`:

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

`CreatePuzzleSessionOptions.metadata` uses `SessionPuzzleSpec`.

Game-core also owns the tiny gameplay primitives currently stranded in web-local files:

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}
```

### Existing engine/helpers

Move substantially unchanged:

- `PuzzleSession` + session action/outcome/event contracts;
- history;
- hints;
- rotation;
- inventory filtering, narrowed to structural coordinate/grid inputs;
- the pure `calculateFitZoom()` helper and its existing tests; `clampZoom()`/`clampPan()` remain web-local.

### Codec + validation + shared adapter

The first green game-core package includes the portable codec and the existing session-adapter semantics together because current session tests already exercise persistence behavior.

Move:

- `serializeSession()`;
- `loadPersistedSession()`;
- `isResumable()`;
- `isFailureRetryable()`;
- V1 validators/clone helpers;
- the generic `peek/load/save/clear/isResumable` adapter behavior and its error mapping.

The adapter depends only on a three-method structural store:

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
```

This is not a repository abstraction; it is the smallest surface the existing adapter already uses after browser key construction is removed.

Keep browser-only in `apps/web`:

- `PROGRESS_KEY_PREFIX` and `progressKey()`;
- `resolveSessionStorage()` / `noopThrowingStorage`;
- `listResumableSessionCandidateIds()` because it enumerates `Storage.length/key()`;
- the wrapper that maps puzzle IDs to `puzzle-progress-${id}` and delegates to the game-core adapter;
- browser-global crypto resolution.

### Shared runtime helpers

Avoid recreating existing platform-neutral logic in mobile:

```ts
export function createDefaultClock(): Clock;

export interface RunIdCrypto {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

export function createRunIdFactory(cryptoSource: RunIdCrypto): RunIdFactory;
export function validationContextFrom(spec: SessionPuzzleSpec): SessionValidationContext;
```

`createDefaultClock()` uses the current `performance.now()`, `Date.now()`, and `globalThis.setInterval/clearInterval` shape. The Task 1 device gate proves those primitives before extraction.

Web keeps `createBrowserRunIdFactory(cryptoSource?: Crypto)` only as a small resolver/wrapper around the shared factory. Mobile passes the NativeScript crypto source verified by Task 1.

## Test ownership and CI

Move the existing pure tests with the behavior they validate. Do not replace them with a few representative cases.

The split is explicit:

- engine/history/hints/rotation/inventory tests move to game-core;
- `persistence.validation-activity.test.ts`, `persistence.validation-completion.test.ts`, and `persistence.validation-fields.test.ts` move with codec ownership;
- generic session-adapter/error/clone assertions move with the shared adapter;
- split the large `persistence.test.ts` by behavior: codec/shared-adapter/run-ID formatting moves; browser-global crypto resolution, candidate enumeration, and browser fallback behavior remain web-local;
- `persistence.fallback-storage.test.ts` remains web-local.

`packages/game-core/vitest.config.ts` follows the small package config pattern but must include:

```ts
expect: { requireAssertions: true }
```

so migrated tests keep the assertion discipline they currently inherit from web.

When game-core exists, update Unit Tests workflow coverage inputs so both `apps/*/coverage/lcov.info` and `packages/game-core/coverage/lcov.info` are retained/uploaded. Do not broaden CI architecture beyond this ownership correction.

## NativeScript workspace-package gate before web migration

After game-core is green while web still uses the old copies:

1. add `@perseus/game-core: workspace:*` to mobile;
2. import and execute a runtime value such as `rotateClockwise(0)` from game-core;
3. run `ns run ios`.

If direct workspace-source bundling fails:

1. inspect the resolved NativeScript webpack configuration;
2. allow one targeted `chainWebpack()` resolve/include adjustment for `packages/game-core/src` when that is the demonstrated cause;
3. rerun the gate.

If that still fails, use the package's existing TypeScript build as the simple fallback:

- `bun --filter @perseus/game-core build`;
- point package runtime/types exports at `dist/index.js` / `dist/index.d.ts`;
- rerun `ns run ios`.

If neither the source path (with at most one targeted config correction) nor the built `dist/` package works, stop HPA-1 before web migration. Do not copy game-core source into mobile.

## Web migration

Only after the workspace-package gate passes:

- add the game-core dependency to web;
- keep `session/store.ts` as the Svelte `Readable` wrapper over shared `PuzzleSession`;
- make web persistence a thin browser namespace/global wrapper over the shared adapter/codec;
- use shared `createDefaultClock()`, `createRunIdFactory()` wrapper, `calculateFitZoom()`, and `validationContextFrom()` where their old implementations were consumed;
- update all route/component/runtime/test imports;
- delete old pure helper/session/type/test copies in the same commit;
- leave no compatibility re-export files.

Run the full web unit suite plus the existing deterministic `e2e/gameplay-session-controls.spec.ts` Chromium-desktop flow.

## Mobile vertical slice

### Fixture and board

Use one checked-in deterministic 2×2 `SessionPuzzleSpec` plus four real generated local piece images. Asset paths are app-local proof data, not an HPA-2 manifest.

`BoardViewModel` stays in `apps/mobile` because Canvas hit testing/render projection is presentation geometry. It reuses `calculateFitZoom()` but owns centered fit bounds, `cellAt()`, `pieceAt()`, and draw records. It never decides placement correctness.

Both interactions terminate at one shared action:

```ts
function attemptPlacement(pieceId: number, cell: { x: number; y: number }): PuzzleSessionOutcome {
  return session.dispatch({ type: 'attempt_placement', pieceId, x: cell.x, y: cell.y });
}
```

Tap: select piece -> `cellAt()` -> `attemptPlacement()`.

Drag: `pieceAt()` -> transient drag position -> `cellAt()` on release -> `attemptPlacement()`.

### File-backed session store

Mobile does not implement a second `SessionStorageAdapter`. It implements only `SessionKeyValueStore` using app-private files:

```text
<documents>/perseus/sessions/<puzzleId>.json
```

Use a tiny test seam for native file operations:

```ts
export interface SessionFileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(fromPath: string, toPath: string): void;
  remove(path: string): void;
}
```

The concrete store maps:

- `getItem(id)` -> read canonical file;
- `setItem(id, value)` -> ensure session directory, write sibling `.tmp`, then use the replacement mode proven in Task 1;
- `removeItem(id)` -> remove canonical file when present.

Tests cover only file mechanics such as missing -> `null`, temp-before-replace ordering, selected replacement strategy, and errors from the file seam. `peek/load/clear/error` session semantics are tested once in game-core.

### Lifecycle/resume

Use shared `createDefaultClock()` and `validationContextFrom(HPA1_FIXTURE)`. Create the session from a loaded snapshot when present. Persist after meaningful persisted mutations and at lifecycle boundaries.

On suspension:

1. `checkpointTime()`;
2. serialize/save through the shared adapter;
3. `setDocumentHidden(true)`.

On resume call `setDocumentHidden(false)`.

The final native proof is: place progress -> mutate a persisted counter -> terminate -> networking unavailable -> relaunch -> same session state restored -> continue with both interaction modes.

## Risks and gates

| Risk | Earliest cheap gate | Decision on failure |
| --- | --- | --- |
| NativeScript/Canvas interaction is unreliable | Task 1 iPad probe | Stop before game-core exists |
| Native runtime lacks required clock/crypto primitives | Task 1 status probe | Stop/redesign runtime choice; no UUID dependency guessed in advance |
| App-private replacement strategy is awkward | Task 1 file probe | Use clean atomic replacement when available; otherwise documented remove+rename fallback |
| NativeScript dependencies break Ubuntu root install/CI | Task 1 ready-PR workflows | Stop before extraction and fix workspace packaging only |
| NativeScript cannot consume `workspace:*` game-core | Post-extraction, pre-web-migration bundle gate | One targeted webpack correction, then `dist/` fallback; otherwise stop before web migration |

## Reviewability

The implementation PR should be reviewed by commit:

1. Canvas/runtime/filesystem/CI feasibility gate.
2. Large mechanical green game-core copy/extraction; review public boundaries and tests, not copy noise.
3. NativeScript runtime import/package-consumption gate.
4. Web migration + deletion, where the semantically meaningful import/ownership diff is easiest to inspect.
5. Mobile gameplay slice.
6. File-backed store + offline relaunch evidence.

This keeps one ticket/PR while making the irreversible boundaries explicit and reviewable.