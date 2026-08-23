# HPA-1: NativeScript Offline Vertical Slice — Design

**Linear:** HPA-1  
**Status:** Design for implementation  
**Date:** 2026-08-23

## Context

HPA-1 is the first implementation ticket in the reviewed Perseus mobile roadmap. It has no blocker, blocks HPA-2, and exists to answer the highest-risk architectural question before the mobile product grows: can an iPad-first NativeScript + Svelte Native client render and interact with a Perseus puzzle through a native-backed Canvas while reusing the existing gameplay engine and persistence contract?

The broader mobile architecture was already reviewed in `docs/superpowers/specs/2026-08-23-nativescript-mobile-offline-design.md` at commit `c69875ba6ff75b19a4bfd3817bdb2e654a0729ca`. HPA-1 intentionally implements only the first bounded proof from that roadmap.

Current `main` already contains most of the domain seam we need:

- `apps/web/src/lib/services/gameplay/session/session.ts` explicitly describes `PuzzleSession` as framework-independent. Its only coupling is through web-local import paths.
- `session/types.ts` contains the portable session contract, but currently imports the tiny `Rotation` and `PlacedPiece` types from web-local files.
- `history.ts`, `hints.ts`, and rotation logic are pure TypeScript already.
- `inventory.ts` is pure logic but its type signature imports web-only `Puzzle` / `PuzzlePiece` wrappers.
- `session/persistence.ts` currently mixes two concerns: the portable session codec/validator and browser-specific `localStorage` mechanics.
- `session/store.ts` is deliberately a thin Svelte adapter and should remain web-only.
- `runtime.ts` owns browser-only runtime wiring such as the browser UUID factory and web E2E override; it should remain web-only while consuming shared rotation behavior.

The implementation should therefore be an extraction and native proof, not a gameplay rewrite.

## Current external feasibility evidence

The selected native surface is the maintained official `@nativescript/canvas` package, not the old unsupported `NativeScript/nativescript-canvas` project and not the community Android-Canvas wrapper.

As of this design:

- NativeScript's official project guide supports `ns create <name> --svelte` for Svelte Native projects.
- `@nativescript/canvas` 2.x is the current native Canvas line; v2 is backed by Rust/Skia/WebGPU and provides a native iOS/Android rendering surface.
- the package ships `@nativescript/canvas/svelte`, which registers `<canvas>` with Svelte Native through `registerNativeViewElement`.
- NativeScript core exposes native-backed `Crypto.randomUUID()` and `getRandomValues()` for iOS and Android, so the mobile app does not need a UUID dependency.

HPA-1 still treats runtime viability as unproven until the real iPad simulator/device gate passes. Documentation evidence is not a substitute for executing the gate.

## Goals

1. Prove NativeScript + Svelte Native + official Canvas can build and launch on an iPad simulator/device.
2. Draw a real Perseus puzzle-piece PNG, receive tap/drag coordinates, and redraw it after a transform before touching the web gameplay engine.
3. Extract only the framework-independent gameplay/session code into `@perseus/game-core`.
4. Keep `@perseus/game-core` free of Svelte, NativeScript, DOM, storage, filesystem, fetch, Cloudflare, and analytics APIs.
5. Keep the web app behavior unchanged while it consumes the new game-core package.
6. Render a deterministic local 2x2 fixture through a minimal Canvas renderer and a small board view model.
7. Route both tap-piece/tap-cell and drag placement through the same shared `PuzzleSession` `attempt_placement` action.
8. Persist the session to app-private files synchronously and atomically.
9. Prove a partially played puzzle survives app termination/relaunch and resumes with networking unavailable.
10. Keep HPA-1 in one implementation PR; the feasibility gate is a stop condition inside that PR, not a separate extraction PR.

## Non-goals

- Public gallery or puzzle downloads.
- Download manifests, staging directories, library discovery, remove-download behavior, or HPA-2 work.
- Production pinch zoom, two-finger pan, gesture arbitration, animated snap/reject feedback, or HPA-3 gameplay polish.
- Full toolbar, inventory drawer, reference UI, hint UI, pause dialogs, completion sheet, or landscape product layout parity.
- Portrait layout or orientation-change handling.
- Google login, secure token storage, completion submission, account outbox, or cloud save.
- SQLite, a generic repository layer, a Redux-style store, dependency-injection container, generic renderer framework, or game-engine integration.
- PixiJS, Phaser, Three.js, `@nativescript/canvas-polyfill`, or another canvas abstraction for this proof.
- Backward-compatibility aliases for the old web-local gameplay import paths. Update consumers cleanly in this pre-release codebase.

## Options considered

### Option A — Gate first, then extract the existing engine (selected)

Create the minimal NativeScript/Svelte Native shell and prove official Canvas on iPad first. Once the Canvas proof passes, extract the already-pure engine, codec, and helper code into `@perseus/game-core`, update web imports, then replace the throwaway Canvas probe with the real shared-session vertical slice.

**Pros**

- fails cheaply on the riskiest technology assumption;
- avoids creating a shared package with no viable native consumer;
- reuses existing gameplay rules rather than porting them;
- keeps the mobile proof small enough to debug;
- produces a real reusable boundary for HPA-2/HPA-3.

**Cons**

- the implementation PR has a hard mid-PR stop gate;
- some initial Canvas probe code is intentionally replaced once the gate passes.

### Option B — Extract `game-core` first, then try NativeScript

**Rejected:** the extraction itself is low risk and would create speculative architecture if Canvas/Svelte Native proves unreliable.

### Option C — Keep the web engine in place and duplicate only the minimal mobile rules

**Rejected:** duplicated placement, lifecycle, validation, and persistence rules would become the long-term parity problem HPA-1 exists to avoid.

### Option D — Use a WebView or game engine wrapper for the first proof

**Rejected:** WebView gameplay defeats the native-client goal; adding Pixi/Phaser/polyfills before raw Canvas is proven adds dependencies without solving a current need.

## Hard feasibility gate

The implementation must begin here and must not create `packages/game-core` before the gate passes.

### Minimal scaffold

Create `apps/mobile` from the official Svelte Native template and keep the generated project structure unless a change is required for the monorepo. Add only the official `@nativescript/canvas` plugin.

The proof screen has one responsibility:

```text
Svelte Native Page
  -> <canvas>
     -> draw one checked-in real Perseus piece PNG
     -> tap reports local canvas coordinates
     -> pan/drag reports local canvas coordinates
     -> moved piece is redrawn at the new position
```

Use the plugin's Svelte registration entry (`@nativescript/canvas/svelte`) rather than maintaining a local registration wrapper unless the official entry demonstrably fails.

The gate fixture must be an actual generated Perseus puzzle-piece PNG, not a colored square or system icon. It may be copied into `apps/mobile/app/assets/hpa-1/` solely for this checked-in fixture.

### Pass criteria

On an iPad simulator or physical iPad:

1. `apps/mobile` builds and launches.
2. the native Canvas is visible and sized predictably inside the Svelte Native page.
3. the real piece PNG renders with transparency intact.
4. a tap produces coordinates that line up with the visible Canvas.
5. a one-finger drag/pan produces changing local coordinates.
6. updating the simple piece position and redrawing visibly moves the PNG.
7. relaunching the app repeats the proof without one-off Xcode project edits.

Record the simulator/device model + iOS version and the exact dependency versions in the implementation PR's validation section.

### Stop condition

If the selected stack cannot satisfy the seven pass criteria reliably, stop HPA-1 implementation at the gate. Do not create `packages/game-core`, do not move web files, and do not substitute another renderer inside the same ticket without redesigning the Linear scope.

A failed gate should leave only the minimal probe/scaffold evidence needed to explain the failure; the next decision is a rendering/UI architecture decision, not more extraction work.

## `@perseus/game-core` boundary after the gate

### Package responsibility

`packages/game-core` owns framework-independent gameplay state transitions and the portable persisted-session contract:

```text
@perseus/types
  API/wire contracts only
       |
       v
@perseus/game-core
  session contracts
  PuzzleSession
  history
  hints
  rotation
  inventory filtering
  session codec + validation
       |
       +----------------+
       v                v
apps/web             apps/mobile
Svelte adapter       Svelte Native view
localStorage         filesystem adapter
browser runtime      native runtime
```

The package may depend on `@perseus/types` for `ResultClass`, `RecordPuzzleCompletionV1`, UUID/run-id validation, completion limits, and result-class constants already shared with the API. It must not absorb general API/client types.

### Portable primitive types

Move the gameplay primitives currently stranded in web-local type files into game-core:

```ts
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedPiece {
  pieceId: number;
  x: number;
  y: number;
}
```

Web `apps/web/src/lib/types/gameplay.ts` and `PlacedPiece` in `apps/web/src/lib/types/puzzle.ts` should be removed or updated at their consumers rather than retained as compatibility aliases.

### Pure helpers

Move these existing implementations substantially unchanged:

- `history.ts`
- `hints.ts`
- `rotation.ts`
- `inventory.ts`

Narrow `matchesInventoryFilter()` so it consumes only the coordinates/grid fields it actually needs:

```ts
export function matchesInventoryFilter(
  piece: Readonly<{ correctX: number; correctY: number }>,
  grid: Readonly<{ gridCols: number; gridRows: number }>,
  filter: InventoryFilter
): boolean;
```

Do not move web `Puzzle` presentation types into game-core just to preserve the old signature.

### Session engine

Move `session/session.ts` and `session/types.ts` to game-core and replace `$lib/...` imports with local package imports. Preserve the existing public behavior and action/outcome/event contracts.

The Svelte `session/store.ts` remains in `apps/web`; it becomes a consumer of `createPuzzleSession` and session types from `@perseus/game-core`.

### Split the persistence module by responsibility

The current `apps/web/.../session/persistence.ts` is the main extraction seam.

Move to game-core:

- `serializeSession()`
- `loadPersistedSession()`
- `isResumable()`
- `isFailureRetryable()`
- V1 shape/cross-field validation and clone helpers used by those functions

Keep in web:

- `PROGRESS_KEY_PREFIX` and key construction
- `resolveSessionStorage()`
- `createBrowserRunIdFactory()`
- browser UUID fallback behavior
- `listResumableSessionCandidateIds()` because it enumerates browser `Storage`
- `createSessionStorageAdapter()` because it owns `Storage` / `localStorage`
- `noopThrowingStorage`

The browser adapter imports the portable codec functions from `@perseus/game-core`. `peekSession()` stays read-only; `loadSession()` keeps its existing behavior of deleting an invalid browser record and returning `missing`.

Do not create an abstract persistence repository or storage base class. `SessionStorageAdapter` is already the required seam.

### Tests move with ownership

Move deterministic unit tests with the code they validate:

- session engine tests -> game-core;
- history/hints/rotation/inventory tests -> game-core;
- codec and validation tests -> game-core;
- browser-storage failure/enumeration/adapter tests -> remain under `apps/web`.

Web route/component/E2E tests remain web tests and must still pass after import migration.

## Mobile vertical slice after extraction

### Fixture

Use one checked-in deterministic 2x2 fixture. It contains:

- stable fixture puzzle ID;
- four pieces with IDs and canonical `correctX` / `correctY` positions;
- four real generated piece PNGs with local asset paths;
- fixed grid size and board dimensions suitable for landscape iPad.

No HTTP request, gallery API, download manifest, or remote asset path is involved.

This is test/proof content, not the HPA-2 download-package format. HPA-2 may later introduce a manifest without migrating HPA-1's fixture contract.

### Native runtime adapters

Keep platform/runtime concerns in `apps/mobile`:

- `createMobileClock()` supplies `monotonicNow`, `wallNow`, interval scheduling, and cancellation through NativeScript/JavaScript runtime APIs.
- `createMobileRunIdFactory()` supplies a lowercase UUID v4 through NativeScript core's native-backed Crypto surface.
- the fixture supplies deterministic tray order and fixed rotations where needed; HPA-1 does not need a configurable RNG service.

Do not place these adapters in game-core.

### Board view model

Add one small `BoardViewModel` in the mobile app. It translates canonical puzzle/session state into Canvas coordinates and vice versa for the fixed/fit-only viewport.

It owns only presentation geometry:

```ts
interface BoardViewModel {
  state(): BoardRenderState;
  cellAt(canvasX: number, canvasY: number): { x: number; y: number } | null;
  pieceAt(canvasX: number, canvasY: number): number | null;
}
```

`BoardRenderState` contains board bounds and draw records for placed/unplaced/active pieces. It must not decide whether a placement is correct.

For HPA-1, one fit transform computed from Canvas size is enough. No persisted zoom/pan and no multi-touch gesture state are needed.

### One placement path

Both input modes terminate at one function owned by the mobile gameplay screen/controller:

```ts
function attemptPlacement(pieceId: number, cell: { x: number; y: number }): PuzzleSessionOutcome {
  return session.dispatch({
    type: 'attempt_placement',
    pieceId,
    x: cell.x,
    y: cell.y
  });
}
```

Tap flow:

```text
tap piece -> select_piece
          -> tap board -> BoardViewModel.cellAt()
                       -> attemptPlacement()
```

Drag flow:

```text
drag starts on piece -> remember dragged piece id
move -> renderer shows transient drag position
release -> BoardViewModel.cellAt()
        -> attemptPlacement()
```

Transient drag position is view state only. It is not added to `PuzzleSession` or persisted.

A rejected placement remains rejected because of `PuzzleSession`; the Canvas view merely redraws from the resulting state.

## Canvas rendering boundary

Keep rendering concrete:

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

`PuzzleCanvas.svelte` owns the plugin Canvas reference, image loading/cache for the four local fixture assets, drawing order, and native pointer/gesture event translation.

Do not create a renderer interface with multiple implementations. There is one native Canvas renderer in this ticket.

The renderer redraws on:

- Canvas ready/size change;
- session state change;
- selection change;
- transient drag movement;
- resume hydration.

## Filesystem session adapter

### Storage shape

HPA-1 needs only session files:

```text
<app documents>/perseus/sessions/<puzzleId>.json
```

Do not create downloads, completion, outbox, or index directories yet.

### Adapter semantics

Implement the existing synchronous `SessionStorageAdapter` in `apps/mobile`:

- `peekSession()` reads and validates without deleting invalid data;
- `loadSession()` reads and validates; when invalid, remove the invalid session and return `missing`, matching the web adapter's current semantics;
- `saveSession()` writes JSON to a sibling temporary file and atomically replaces/renames it to `<puzzleId>.json`;
- `clearSession()` removes the file when present;
- `isResumable()` delegates to game-core.

The temporary filename can be deterministic because writes are synchronous and single-process for this MVP, for example `<puzzleId>.json.tmp`. Do not add a write queue, lock file, journal, debounce scheduler, or database.

### Save ownership

The mobile gameplay screen owns the same simple policy as the web route: after a meaningful persisted state change, serialize the current state and write it through the adapter.

For the vertical slice, persist after:

- accepted/rejected placement if state/counters changed;
- selection-independent persisted rotation change if used by the fixture;
- lifecycle checkpoint/background event;
- explicit exit/relaunch preparation.

Selection and transient drag coordinates are runtime-only and need not trigger writes.

Before serialization at an application lifecycle boundary, call `checkpointTime()` so timed state is current.

## Resume flow

At mobile gameplay startup:

1. load the checked-in fixture metadata;
2. construct `SessionValidationContext` from that canonical fixture;
3. call the filesystem adapter's `loadSession()`;
4. if loaded and resumable/restorable, pass the snapshot to `createPuzzleSession({ restored })`;
5. otherwise create a fresh session;
6. subscribe the board view to session changes and draw the resulting snapshot.

The proof does not need a resume chooser. With one fixture, automatic restore is sufficient.

The acceptance journey is:

```text
launch -> place at least one piece -> persist
       -> terminate app
       -> disable network / keep network unavailable
       -> relaunch
       -> same fixture and placed-piece/session state restored
```

## Application lifecycle

Wire the minimal NativeScript background/resume events needed to preserve timer correctness:

- before suspension/background: `checkpointTime()`, save current snapshot, `setDocumentHidden(true)`;
- on resume: `setDocumentHidden(false)` and redraw.

The acceptance criterion is termination/relaunch offline resume. HPA-1 does not need a Pause dialog or polished background UI, but it should not knowingly allow the timed clock to accumulate while the app is backgrounded.

## Error handling

Keep errors explicit and local:

- Canvas/plugin build or runtime failure: gate fails; stop ticket.
- fixture image load failure: show a simple debug/error label and fail the gate/vertical-slice smoke; do not silently substitute an icon.
- invalid session: shared codec rejects it; `loadSession()` removes it and starts fresh.
- filesystem read/write/remove failure: surface through a small `onError(SessionPersistenceError)` callback and keep the app usable for the proof; do not build a notification framework.
- rejected placement: redraw from session state; no separate mobile correctness rules.

## Testing strategy

### Game-core unit tests

The extracted deterministic tests are the parity contract. Run them in their own workspace package and keep coverage focused on:

- session lifecycle and clock behavior;
- placement and completion rules;
- undo/redo;
- hints;
- rotation;
- inventory filters;
- serialization;
- V1 validation/cross-field invariants;
- resumability and retryability policy.

### Web regression tests

Run the existing web unit suite after the import/storage split. Browser-specific persistence tests continue to pin localStorage failure, destructive `loadSession()`, non-destructive `peekSession()`, and candidate enumeration behavior.

The existing web gameplay smoke remains the highest-value integration fence that the extracted engine still behaves the same in its original consumer.

### Mobile pure tests

Use ordinary TypeScript tests for code that does not need native UI:

- `BoardViewModel` coordinate-to-cell and render projection;
- filesystem adapter read/save/load/clear using an injectable minimal file-ops seam or temporary directory helper;
- atomic write ordering (`tmp write` before replace);
- resume hydration against the fixture.

Keep the filesystem seam concrete and tiny; it exists only so pure adapter behavior can be tested without booting iOS.

### Native iPad smoke

Do not create a native E2E framework in HPA-1. Record a short manual/simulator smoke in the PR:

1. gate proof (real PNG, tap, drag, redraw);
2. launch the final 2x2 vertical slice;
3. place one piece by tap;
4. place/reject one piece by drag;
5. terminate;
6. disable networking;
7. relaunch and verify saved state;
8. optionally finish the 2x2 puzzle to prove completion still comes from game-core.

Automated native UI testing is deferred until a reliable, cost-effective harness is justified.

## File ownership

### New game-core package

- `packages/game-core/package.json`
- `packages/game-core/tsconfig.json`
- `packages/game-core/src/index.ts`
- `packages/game-core/src/history.ts`
- `packages/game-core/src/hints.ts`
- `packages/game-core/src/inventory.ts`
- `packages/game-core/src/rotation.ts`
- `packages/game-core/src/session/types.ts`
- `packages/game-core/src/session/session.ts`
- `packages/game-core/src/session/codec.ts`
- corresponding moved unit tests

### Web files changed by extraction

- browser session persistence module/tests
- Svelte session store/tests
- gameplay runtime/tests
- routes/components/tests that import moved gameplay/session types/helpers
- `apps/web/package.json` to depend on `@perseus/game-core`

No API, workflow, database, infrastructure, or shared wire-contract behavior should change.

### Mobile proof

The NativeScript generated scaffold stays under `apps/mobile`. HPA-1 adds only the concrete proof/runtime/gameplay files needed for:

- Canvas registration/probe;
- fixture + assets;
- session runtime adapters;
- board view model;
- Canvas gameplay view;
- filesystem session adapter;
- minimal lifecycle wiring.

Do not pre-create Gallery, Downloaded, Account, outbox, download store, or future navigation modules.

## Acceptance mapping

| HPA-1 acceptance criterion | Design evidence |
| --- | --- |
| Canvas gate passes before extraction | Hard feasibility gate and stop condition |
| game-core is runtime/framework pure | Explicit package boundary + import rules |
| web behavior stays green | clean import migration + existing web regression gates |
| mobile renders fixture | 2x2 fixture + concrete Canvas renderer |
| tap and drag placement | one shared `attemptPlacement()` path |
| placement/completion come from PuzzleSession | BoardViewModel restricted to geometry; session owns rules |
| termination/relaunch offline resume | synchronous filesystem adapter + resume flow |
| tests cover extraction/codec/adapter | game-core unit move + mobile pure tests + iPad smoke |

## Review checklist

Before implementation begins, reject any plan change that does one of the following without a demonstrated need:

- extracts game-core before the Canvas gate passes;
- moves Svelte store/browser storage into game-core;
- adds a generic storage/repository abstraction;
- adds a second rendering engine or Canvas wrapper;
- expands the fixture into a download/library contract;
- implements production gestures or HPA-3 UI;
- introduces portrait/auth/sync work;
- duplicates placement or validation rules in the mobile client;
- splits HPA-1 across multiple implementation PRs.
