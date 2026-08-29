# HPA-3 Landscape iPad Gameplay Design

**Date:** 2026-08-29  
**Linear:** HPA-3 — [Perseus Mobile] Reach production landscape iPad gameplay parity  
**Depends on:** HPA-2 (Done)

## Goal

Turn the proven NativeScript offline vertical slice into the production landscape-first iPad puzzle experience without creating a second gameplay architecture.

HPA-3 keeps `@perseus/game-core` `PuzzleSession` as the only gameplay controller, keeps downloaded sessions fully local/offline, and adds only the native rendering, coordinate/gesture handling, and concrete tablet UI needed for the shipped landscape loop.

## Verified baseline

Current `main` after PR #73 already has:

- one pure `@perseus/game-core` with `PuzzleSession`, lifecycle/time, placement, history, hints, rotation, inventory filtering, persistence codec, and storage-adapter semantics;
- one NativeScript composition root in `apps/mobile/app/App.svelte`;
- explicit variant downloads and a filesystem-derived Downloaded library;
- variant-scoped session files keyed by `ReadyPuzzle.id`;
- a working HPA-1 Canvas slice with tap/drag placement;
- puzzle-family + Easy/Normal/Hard catalog data already carried by `ReadyPuzzle` and `DownloadManifestV1`.

The mobile gameplay code is intentionally still prototype-level:

- `Gameplay.svelte` immediately dispatches `start`/`resume` and uses sorted piece IDs plus an all-zero rotation override;
- `PuzzleCanvas.svelte` has a fixed `700 × 800` backing surface, an in-canvas temporary piece strip, and an `on:pan` handler that owns piece dragging;
- `toCanvasPoint()` compensates for the fixed backing surface being letterboxed inside the rendered view.

Those seams are the target of HPA-3. No backend or persistence migration is required.

## Delivery decision

Use one HPA-3 PR. The planning branch is the implementation branch; implementation continues on the same PR with task-sized commits. Do not split HPA-3 across multiple PRs.

## Ownership

```text
App.svelte
  library/download ownership + screen switch
        |
        v
Gameplay.svelte
  session construction + dispatch orchestration
  persistence boundaries + ephemeral UI/drag state
      /        |          \
     v         v           v
Toolbar      Tray        Canvas
controls     pieces      board/render/gestures
     \         |           /
      \        v          /
       ---- PuzzleSession ----
             |
             v
       session file adapter
```

| Concern | Owner |
| --- | --- |
| Placement validity, lifecycle/mode/time, rotation, history, hints, reference mode, filter/order, completion seal | `PuzzleSession` |
| Session serialization/validation | existing game-core codec |
| Download/session identity | concrete variant `manifest.puzzle.id` |
| Family/difficulty | current `ReadyPuzzle` metadata; presentation only |
| Persisted viewport value | `PuzzleSession.state.viewport` through one new action |
| Fit/zoom/pan/screen-coordinate math | mobile `boardViewport.ts` |
| Board drawing + Canvas gesture ownership | `PuzzleCanvas.svelte` |
| Persistent tray and piece touch | `PuzzleTray.svelte` |
| Cross-column drag visualization + dispatch coordination | `Gameplay.svelte` |
| Setup/pause/discard/completion presentation | concrete mobile sheets |

Do not import web Svelte components or `apps/web/src/lib/services/gameplay/viewport.ts`. The web viewport helper owns a different pixel-pan policy and is not persisted. Reuse only portable game-core helpers such as `calculateFitZoom()` and `matchesInventoryFilter()`.

## Variant identity

A downloaded Easy/Normal/Hard variant remains one complete gameplay package.

- session key: `manifest.puzzle.id`;
- asset paths: existing installed variant paths;
- validation context: `sessionSpecFromManifest(manifest)`;
- family ID and difficulty are display metadata only;
- changing difficulty means leaving this concrete variant and opening/downloading another one.

No `DownloadManifestV1` or `PersistedPuzzleSessionV1` version bump is needed.

## Landscape-only boundary

HPA-3 temporarily advertises only iPad landscape orientations in `UISupportedInterfaceOrientations~ipad`. The phone block remains unchanged.

HPA-46 owns portrait, orientation changes during an active run, and adaptive tablet layout. HPA-3 does not add a general responsive-layout framework or draggable tray divider.

The gameplay shell is concrete:

```text
+------------------------------------------------------------------+
| Library | Puzzle · Difficulty | Timer | Undo Redo Hint Ref More  |
+--------------------------------------------------+---------------+
|                                                  | PIECES n left |
|                                                  | filters       |
|                 PUZZLE BOARD                     |               |
|                 native Canvas                    | piece grid    |
|                                                  |               |
|                                                  | Rotate        |
+--------------------------------------------------+---------------+
```

The board column is flexible and receives the majority of the screen. The right tray is a practical fixed width around 320 DIP.

## Canvas surface and coordinate contract

The production Canvas must fill the board column. HPA-3 removes the fixed `700 × 800` surface.

On `loaded` and `layoutChanged`:

1. read the Canvas rendered size in DIPs with `getActualSize()`;
2. derive the backing size from the rendered DIP size and display density;
3. update the Canvas backing width/height only when they changed;
4. rebuild `BoardViewModel` / `createBoardTransform()` from the current backing size.

The Canvas view stays stretched to the board column. The backing dimensions follow the layout; layout does not follow a hard-coded backing surface.

`boardViewport.ts` owns one pure screen-to-canvas conversion used by cross-view placement:

```ts
interface CanvasSurfaceMetrics {
  layoutWidthDip: number;
  layoutHeightDip: number;
  backingWidth: number;
  backingHeight: number;
}

function screenPointToCanvas(
  screenX: number,
  screenY: number,
  originXDip: number,
  originYDip: number,
  metrics: CanvasSurfaceMetrics
): { x: number; y: number } | null;
```

The helper subtracts the Canvas screen origin and scales by `backingWidth / layoutWidthDip` and `backingHeight / layoutHeightDip`. It rejects non-finite/zero dimensions and points outside the rendered Canvas.

Once the Canvas fills its layout cell, the HPA-1 letterboxing compensation in `toCanvasPoint()` is deleted. Do not keep two screen-to-canvas formulas.

## Board fit and persisted viewport

The schema already contains optional:

```ts
interface PersistedViewport {
  zoom: number;
  panX: number;
  panY: number;
}
```

Add exactly one engine action:

```ts
{ type: 'set_viewport'; viewport: PersistedViewport | null }
```

with outcomes:

```ts
{ type: 'viewport_changed'; viewport: PersistedViewport | null }
{ type: 'viewport_noop'; reason: 'invalid_viewport' }
```

`doSetViewport()` must accept only the same numeric domain the codec already accepts:

- `zoom` is finite and **strictly greater than 0**;
- `panX`/`panY` are finite;
- `null` means Fit/default.

The engine does not enforce mobile's `1..4` UI policy. It only prevents state that would later make the existing V1 codec reject the whole save.

Viewport changes:

- do not set `hasUserActivity`;
- do not affect result class;
- do not enter undo/redo history;
- do not trigger completion effects.

Mobile policy remains:

- `zoom` is a multiplier over fit scale;
- UI clamp is `1..4`;
- persisted pan is in board-cell units;
- `zoom === 1` normalizes to Fit / `viewport === null`;
- oversized axes clamp so the board cannot be dragged completely away;
- an axis whose transformed board still fits remains centered.

### Fit geometry

The production board uses:

```ts
calculateFitZoom(gridCols, gridRows, canvasWidth, canvasHeight, 1)
```

The tray/chrome are already outside the board column, so the game-core helper's default `0.9` padding would add a second unnecessary inset. A 4×3 board in an 800×600 backing surface therefore has fit cell size 200 and origin 0,0.

## Board gesture ownership

Task 3 removes the HPA-1 Canvas `on:pan`, `pointFromPan`, `pieceAt`, in-canvas unplaced records, and all Canvas-owned piece-drag state together.

After that cutover the Canvas interaction surface is:

- board tap -> placement when a piece is selected;
- two-pointer touch -> one combined viewport transform (pinch + centroid translation from one gesture baseline);
- double-tap -> Fit when the tap sequence starts with **no selected piece**;
- one-finger move on the Canvas -> no board pan.

The selection rule gives deterministic tap-vs-double-tap precedence without delaying every placement:

- if a tap sequence starts with a selected piece, it is placement-only and cannot trigger Fit even if the platform also recognizes a double tap;
- if it starts with no selected piece, the first tap has no placement action and a recognized double tap may Fit.

A tiny local suppression flag/time window is acceptable to remember that a double-tap sequence began with selection. Do not add a generic gesture arbiter.

Two-pointer calculations use the gesture-start viewport/centroid/distance for every frame. Do not independently apply a pinch delta and a pan delta to already-mutated viewport state.

Viewport changes redraw transiently while fingers move and dispatch `set_viewport` only at gesture end/cancel. Fit dispatches `set_viewport(null)`.

## External tray and cross-view drag

Unplaced pieces live only in `PuzzleTray.svelte`.

Tap placement:

1. tray piece -> `select_piece`;
2. Canvas cell -> one `attempt_placement`.

Cross-view drag uses narrow callbacks in screen DIPs:

```ts
onPieceDragStart(pieceId, screenX, screenY)
onPieceDragMove(pieceId, screenX, screenY)
onPieceDragEnd(pieceId, screenX, screenY)
```

`Gameplay.svelte` owns one full-bleed drag overlay spanning board + tray. The tray image itself never needs to render outside its column, so native clipping cannot hide the dragged piece.

The overlay is presentation-only:

- source: existing local `piecePaths[pieceId]`;
- position: current screen-DIP drag point converted relative to the gameplay root;
- no session state and no persisted drag coordinates;
- `isUserInteractionEnabled=false` so it cannot steal touch events.

On drag end, `Gameplay.svelte` asks `PuzzleCanvas.cellAtScreenPoint()` for a canonical cell and dispatches the same `attempt_placement` path as tap placement.

- outside board -> remove overlay/snap back, no gameplay dispatch;
- engine rejection -> remove overlay, brief reject feedback;
- accepted -> remove overlay; tray projection drops the placed piece and Canvas draws the canonical placement.

## Tray order and organization

Mobile adds one small local Fisher-Yates helper:

```ts
shuffleIds(ids, random = Math.random)
```

Use it for all three mobile tray-order entry points:

1. fresh `initialTrayOrder`;
2. `createTrayOrder()` used by restart;
3. the user-visible Shuffle action.

This avoids shipping sorted IDs as a mobile-only policy while still keeping shuffle out of game-core. Tests inject deterministic randomness.

The tray exposes only:

- All / Corners / Edges / Center;
- Shuffle;
- remaining count;
- selected/highlighted piece;
- one selected-piece Rotate action when rotation is enabled.

Filtering reuses `matchesInventoryFilter()` through a mobile pure projection helper. Filter/order changes dispatch the existing `update_tray_organization` contract. Do not expose active tray, membership, names, rename/remove, manual grouping, multi-select, or clustering.

A successful hint uses the existing `hint_target` event and the engine's existing automatic filter reset to All. Hint target/piece highlighting is ephemeral.

## Session entry and lifecycle

### New run

A fresh session remains in `setup` and opens a concrete setup sheet. Do not auto-dispatch `start`.

The sheet exposes only Timed/Relaxed, Rotation Off/On, Start, and Library.

Start does:

1. `configure_setup`;
2. `start`;
3. immediate persistence.

Remove the HPA-1 all-zero `createRotations` override. Use the existing game-core default rotation generator. No mobile preference store is added.

### Restored run

Remove the current HPA-1 automatic `start`/`resume` dispatch entirely.

- active restored session: leave it active; **do not dispatch `start`, `resume`, or an initial `setDocumentHidden(false)`**;
- paused restored session: leave it paused and open Pause;
- completed/protected session remains handled by Downloaded and does not expose Resume.

`PuzzleSession` construction already starts its clock when a restored state is active + timed + `timerStarted`. HPA-3 must not duplicate or reinterpret that engine contract.

### Explicit Pause

Pause -> dispatch `pause`, persist, open Pause sheet. Resume -> dispatch `resume`, persist, close the sheet.

### Background / foreground

Background is not explicit Pause.

Suspend order is load-bearing:

1. `session.setDocumentHidden(true)`; `stopClock()` checkpoints/stops active timed play;
2. serialize/save the now-current state without re-checkpointing;
3. leave sheet state unchanged.

Foreground calls `setDocumentHidden(false)` and changes no dialog state. The engine restarts the clock only when lifecycle/mode/timer state requires it. An explicitly paused session remains paused.

### Restart / discard

Restart dispatches the existing `restart`, persists the new setup state, and reopens Setup seeded from prior mode/rotation. Fresh/restart order comes from the same mobile `shuffleIds()` factory. Viewport resets to Fit and filter resets to All through fresh/restart engine semantics.

Discard confirms, calls `SessionStorageAdapter.clearSession(puzzleId)`, and exits only after a successful clear. Failure remains inline on the concrete sheet.

## Toolbar, reference, feedback

Visible toolbar actions: Library, Undo, Redo, Hint, Reference, More. Show puzzle name, difficulty and timer in the same top area.

More expands one concrete row: Fit Board, Rotation On/Off, Pause, Restart, Discard.

Reference expands one concrete row: Hold to Peek, Toggle, Ghost. All modes dispatch existing `set_reference_mode`; no reference file means no active Reference affordance and no network fallback.

Reference rendering stays Canvas-local:

- Ghost behind pieces at low opacity;
- Hold/Toggle as a stronger board-aligned overlay while pieces remain visible.

Placement feedback stays ephemeral:

- accepted -> brief green target flash;
- rejected/non-upright -> brief red target flash;
- hint target -> distinct persistent outline until consumed/replaced.

No animation framework or sound system is added.

## Completion

Completion is local sealed-session state only in HPA-3.

On completion, persist immediately and show a concrete sheet from `SealedCompletion` plus variant metadata:

- puzzle name/difficulty;
- Timed/Relaxed;
- elapsed time when timed;
- hints used;
- incorrect attempts;
- rotation enabled/used;
- Back to Library.

Do not add auth, outbox, completion APIs, achievements, leaderboard queries, or another local completion database. HPA-4 owns account-bound submission.

Downloaded reuses `getDifficultyLabel()` for copy such as `EASY · 16 PIECES`; the existing `none | resumable | protected | invalid` action matrix stays unchanged.

## Testing strategy

### Game-core

Pin:

- valid viewport clone/store;
- `zoom: 0`, negative zoom, NaN/Infinity -> `viewport_noop` and unchanged state;
- Fit/null clearing;
- no user-activity/history/result-class side effects;
- real serialize/load round trip with schema V1 unchanged.

### Mobile pure math

`boardViewport.test.ts` owns the risky coordinate/gesture math:

- layout DIP size -> backing pixel size;
- `screenPointToCanvas()` at multiple densities and origins;
- explicit `paddingFactor=1` fit example (4×3 in 800×600 => 200, origin 0,0);
- transformed Canvas point -> canonical cell;
- zoom/pan normalization and clamp;
- pinch-center anchoring;
- centroid-only pan;
- combined pinch + translation from one baseline;
- transform restoration.

`trayPieces.test.ts` pins immutable deterministic Fisher-Yates and filtered unplaced projection.

No new Svelte component-test framework is required.

### iPad gates

Task 3 must prove on the real established iPad simulator:

- Canvas rendered DIP size fills the flexible board column;
- backing size follows rendered layout rather than staying 700×800;
- screen-to-cell conversion remains correct at device scale;
- persistent tray works;
- full-bleed drag overlay stays visible across the tray/board boundary;
- tap and cross-view drag placement both work.

Task 4 then verifies pinch, two-finger pan, Fit, transformed placement, and the selection-aware tap/double-tap precedence.

Final offline smoke downloads one representative Easy variant while the API is available, then removes network/API dependency and covers setup, placement, gestures, persisted viewport, rotation, filters/shuffle, hints/reference, undo/redo, pause/lifecycle, completion, and protected Downloaded state.

If reliable multi-touch injection is unavailable, record pinch/two-finger-pan as explicit manual acceptance evidence rather than adding a fragile native E2E framework. Pure transform math remains automated.

## Risks and stop conditions

### Canvas layout/backing mismatch

Risk: a flexible GridLayout can still contain a fixed backing surface, producing incorrect hit testing and wasted board area.

Mitigation: Task 3 derives backing size from actual layout and has a real iPad gate. If changing the backing width/height changes layout size rather than just backing resolution in the installed Canvas version, stop and use that plugin version's supported backing-size path; do not retain the 700×800 surface or add a second letterboxing formula.

### Coordinate-space drift

Risk: tray screen DIPs, Canvas rendered DIPs and Canvas backing pixels can diverge.

Mitigation: one tested `screenPointToCanvas()` is the only cross-view placement conversion. Both drawing/hit-testing then use the same `BoardTransform`.

### Gesture recognizer conflict

Risk: legacy `on:pan`, two-pointer touch, tap and double-tap can all claim overlapping input.

Mitigation: delete Canvas pan with the in-canvas tray; two-pointer touch owns viewport navigation; selected-piece sequences own placement and suppress Fit; no-selection double taps own Fit.

### Cross-column drag clipping

Risk: a tray child cannot visibly travel outside its native column.

Mitigation: a full-bleed root overlay paints the in-flight piece; tray/Canvas remain independent views.

## Scope fence

HPA-3 does **not** include:

- portrait/adaptive layout or live orientation switching (HPA-46);
- phone optimization;
- Android release polish;
- draggable tray width;
- named/staging/manual tray organization;
- local-photo puzzle creation;
- Google login, cloud session sync, auth, completion outbox/server retry, achievements, leaderboards, or account UI (HPA-4);
- API/D1/Workflow/infrastructure changes;
- download/session schema migration;
- web viewport helper sharing;
- second gameplay controller/store;
- generic toolbar/dialog/gesture/responsive-layout frameworks;
- broad native E2E infrastructure.

## Acceptance mapping

HPA-3 is complete when:

- the iPad app is landscape-only for this slice;
- Canvas fills the board column with layout-derived backing size and one tested screen-coordinate conversion;
- a persistent right tray and visible full-bleed drag overlay support tap + cross-view drag placement;
- Canvas pan is gone and pinch/two-finger pan/Fit do not conflict with placement;
- fresh/restart tray order and user Shuffle use the same mobile Fisher-Yates helper;
- Timed/Relaxed, rotation, undo/redo, hints, reference modes, filters/shuffle, pause/resume, restart/discard and completion are all driven through `PuzzleSession`;
- backgrounding excludes hidden active time without changing explicit Pause presentation;
- viewport restores through the existing V1 optional field and invalid zoom cannot poison a save;
- one downloaded variant completes fully offline through the production landscape UI;
- focused game-core/mobile tests plus a small iPad smoke provide the gate.