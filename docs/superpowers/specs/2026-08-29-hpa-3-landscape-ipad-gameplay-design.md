# HPA-3 Landscape iPad Gameplay Design

**Date:** 2026-08-29  
**Linear:** HPA-3 — [Perseus Mobile] Reach production landscape iPad gameplay parity  
**Depends on:** HPA-2 (Done)

## Goal

Turn the proven NativeScript offline vertical slice into the real landscape-first iPad puzzle experience without creating a second gameplay architecture.

The mobile app uses the existing `@perseus/game-core` `PuzzleSession` for gameplay rules, keeps downloaded sessions fully local/offline, and adds only the native rendering, touch interaction, and concrete tablet UI that HPA-3 needs.

## Current baseline

HPA-1 and HPA-2 are complete. Current `main` already has:

- one pure shared `@perseus/game-core` with `PuzzleSession`, history, hints, rotation, inventory filters, session codec, and file/browser storage adapters;
- one NativeScript app composition root in `apps/mobile/app/App.svelte`;
- explicit variant downloads with manifest-last finalization and a filesystem-derived Downloaded library;
- variant-scoped session files keyed by `ReadyPuzzle.id`;
- a working Canvas vertical slice with tap-piece/tap-cell placement and one-finger piece dragging;
- lifecycle checkpointing on NativeScript suspend/resume;
- the puzzle-family + Easy/Normal/Hard catalog model from PR #73.

The production gap is concentrated in `apps/mobile/app/gameplay`: `Gameplay.svelte` still auto-starts/resumes a run and presents debug UI, while `PuzzleCanvas.svelte` still uses a fixed `700×800` backing surface and keeps unplaced pieces inside the Canvas.

PR #73 does not require a new HPA-3 persistence model. `DownloadManifestV1` already embeds the current `ReadyPuzzle`, including `familyId` and `difficulty`. Gameplay remains a concrete **variant** session keyed by `manifest.puzzle.id`; family and difficulty are presentation/catalog metadata.

## Delivery decision

Use one implementation PR for HPA-3. Continue implementation on the existing draft PR/branch. Task boundaries below are reviewable commits inside that one PR, not extra tickets or PRs.

## Architecture

```text
App.svelte
  library/download ownership + screen switch
        |
        v
Gameplay.svelte
  NativeScript composition + ephemeral presentation
        |
        +--> gameplaySessionPolicy.ts
        |      tiny tested entry/suspend/viewport/discard policy
        |
        +--> Toolbar / Tray / Sheets
        |
        +--> PuzzleCanvas.svelte
                 |
                 +--> boardViewport.ts   (only board geometry / coordinates)
                 +--> boardViewModel.ts  (draw-record projection only)
        |
        v
   PuzzleSession
        |
        v
 session file adapter
```

### Ownership rules

| Concern | Owner |
| --- | --- |
| Placement validity, lifecycle/mode/time, rotation, undo/redo, hint selection, reference mode, inventory filter/order, completion seal | `PuzzleSession` |
| Session serialization and validation | existing game-core codec |
| Download/package/session identity | concrete variant `puzzle.id` |
| Family/difficulty | existing `ReadyPuzzle` metadata; presentation only |
| Persisted viewport value | `PuzzleSession.state.viewport` through one new action |
| Fit/zoom/pan/screen↔Canvas/cell math | mobile `boardViewport.ts` only |
| Draw-record projection | mobile `boardViewModel.ts` over a supplied `BoardTransform` |
| Native Canvas size/readiness/gesture wiring | `PuzzleCanvas.svelte` |
| Cross-view tray drag | `PuzzleTray.svelte` + `Gameplay.svelte` full-bleed drag overlay |
| Load-bearing entry/suspend/viewport/discard orchestration | tiny pure `gameplaySessionPolicy.ts` |
| Sheet visibility, hint highlight, rejection flash | ephemeral `Gameplay.svelte` state |

No backend, D1, Workflow, API route, auth, completion outbox, new persisted schema, global store, gesture framework, or dialog framework is needed.

## Variant identity after puzzle families

A downloaded Easy/Normal/Hard variant is one complete gameplay package. HPA-3 keeps these invariants:

- session key: `manifest.puzzle.id`;
- asset paths: existing installed variant paths;
- session validation: `sessionSpecFromManifest(manifest)`;
- display: puzzle name + difficulty + piece count;
- no mutable difficulty field in session state;
- changing difficulty means leaving gameplay and opening/downloading another concrete variant.

No migration is required for HPA-2 manifests or session files.

## Landscape-only HPA-3 boundary

HPA-3 temporarily advertises only the two iPad landscape orientations in `Info.plist`.

This is pre-release scope control. HPA-46 owns portrait, live orientation switching, and portrait tray/layout adaptation. Phone optimization and Android release polish remain out of scope.

```text
+------------------------------------------------------------------+
| < LIBRARY | Puzzle · Difficulty | Timer | Undo Redo Hint Ref More |
+--------------------------------------------------+---------------+
|                                                  | PIECES  n left |
|                                                  | filters       |
|                 PUZZLE BOARD                     |               |
|                 native Canvas                    | scrollable    |
|                                                  | piece grid    |
|                                                  |               |
|                                                  | Shuffle/Rotate|
+--------------------------------------------------+---------------+
```

The board owns the flexible majority column. The tray is a fixed practical right column; there is no draggable divider.

## Session entry and lifecycle

### New run

Starting a downloaded variant constructs a fresh `PuzzleSession` in `setup` and opens a concrete setup sheet. It does **not** auto-dispatch `start`.

The setup sheet exposes only:

- Timed / Relaxed;
- Rotation Off / On;
- Start;
- Back to Library.

Start dispatches `configure_setup`, then `start`, then persists immediately.

Remove the HPA-1 all-zero `createRotations` override. Rotation-enabled runs use the existing game-core default generator.

Fresh and restarted tray order use one mobile-local Fisher-Yates helper. The same helper backs the explicit Shuffle action. Do not add shuffle to game-core and do not import the web-only `apps/web` helper.

### Resume

The existing Downloaded classifier remains authoritative.

- active resumable snapshot -> active gameplay, no entry dispatch;
- paused resumable snapshot -> remains paused and opens Pause sheet;
- sealed completed snapshot -> `protected`, no Resume;
- invalid snapshot -> existing Downloaded recovery actions.

`createPuzzleSession()` already starts the clock while constructing an active + timed + `timerStarted` restored session. HPA-3 must not “re-arm” it with `start`, `resume`, or an entry `setDocumentHidden(false)` call.

### Explicit Pause

Pause dispatches `pause`, persists, and opens a concrete Pause sheet. Resume dispatches `resume`, persists, and closes it.

### Background / foreground

Backgrounding is not explicit Pause.

Suspend ordering is load-bearing:

1. `session.setDocumentHidden(true)` so the engine checkpoints/stops the clock;
2. serialize/save the now-current state;
3. leave sheet state unchanged.

Foreground calls `setDocumentHidden(false)`. It does not force Pause UI. A session explicitly paused before backgrounding remains paused.

### Restart

Restart is a fresh run:

- confirm when meaningful activity exists;
- dispatch `restart`;
- persist the setup-state replacement immediately;
- reopen setup seeded from prior mode/rotation choices;
- next Start dispatches `configure_setup + start`.

Restart gets a fresh shuffled tray order and resets viewport to Fit. Existing engine filter-reset behavior remains authoritative.

### Discard

Discard confirms, calls existing `SessionStorageAdapter.clearSession(puzzleId)`, and exits only after success. Failure stays on the concrete sheet with inline copy.

## Small tested session policy seam

Do not add Svelte component testing infrastructure just for HPA-3. Instead, move only the persistence/lifecycle decisions that are easy to regress into `apps/mobile/app/gameplay/gameplaySessionPolicy.ts` with normal Vitest coverage.

The file is not a controller or store. It holds four deterministic helpers over tiny interfaces:

```ts
entrySheetFor(restored): 'setup' | 'pause' | null
suspendSession(session, save): void
commitViewport(session, viewport, save): PuzzleSessionOutcome
discardProgress(storage, puzzleId): boolean
```

Tests use fakes to pin:

- fresh -> Setup;
- active restored -> no sheet and **no dispatch**;
- paused restored -> Pause;
- suspend calls hidden=true before save;
- viewport persists only after `viewport_changed`;
- invalid viewport does not save;
- discard returns the storage result.

`Gameplay.svelte` remains wiring. Ephemeral hint/feedback presentation stays component-local; do not build a reducer/framework around it.

## Persisted viewport seam

The V1 schema already contains optional `PersistedViewport { zoom, panX, panY }`; the codec already round-trips it and rejects non-finite numbers or `zoom <= 0`.

Add one engine action:

```ts
{ type: 'set_viewport'; viewport: PersistedViewport | null }
```

with outcomes:

```ts
{ type: 'viewport_changed'; viewport: PersistedViewport | null }
{ type: 'viewport_noop'; reason: 'invalid_viewport' }
```

The transition mirrors the codec numeric predicate, clones the value, notifies subscribers, and never marks gameplay activity, result eligibility, or undo/redo history.

`null` means Fit/default and serializes without the optional field.

### Shared persisted units

Task 1 updates the `PersistedViewport` type comment so the shared boundary is unambiguous for future consumers:

- `zoom` = multiplier over fit-to-viewport cell scale (`1` = Fit);
- `panX`/`panY` = offsets in **fit-cell units**, not pixels;
- positive pan moves the board right/down;
- app-side UI may clamp the usable range, but persisted units are portable.

The web’s current live viewport uses different non-persisted CSS-pixel/absolute-scale values. HPA-3 does not reuse or change that helper.

Mobile UI clamps zoom to `1..4`. At Fit, pan normalizes to zero and persistence uses `null`. Pan is clamped so the board cannot be moved completely out of view; a transformed axis that still fits remains centered.

## One board geometry source

`boardViewport.ts` is the only module allowed to compute fit geometry or canonical cell hit-testing.

It owns:

- layout DIPs -> Canvas backing pixels;
- screen-DIP -> Canvas backing coordinate conversion;
- `createBoardTransform()`;
- explicit `calculateFitZoom(..., 1)` use;
- fit/zoom/pan clamp;
- `BoardTransform.cellAt()`;
- two-pointer focal transform;
- double-tap Fit suppression helper.

`boardViewModel.ts` becomes a draw projection over a supplied `BoardTransform`. It must not call `calculateFitZoom()` and must not own a second `cellAt()` formula.

A discriminating unit test pins the production fit formula:

- 2×2 board in an 800×600 Canvas -> `fitCellSize === 300`, `boardX === 100`.

That assertion fails under the old default `0.9` formula and prevents draw/hit geometry from silently diverging.

## Canvas sizing and first paint

The current fixed `700×800` surface and letterboxing conversion are removed, but the native plugin assumption is proven **before** the tray rewrite.

The production sequence is:

1. listen for `layoutChanged`;
2. read non-zero rendered size in DIPs;
3. derive backing pixels from actual density;
4. assign Canvas backing `width/height`;
5. create the transform/view model from that backing size;
6. schedule the first draw on the next JS turn after the first non-zero layout event.

This replaces the current arbitrary 100 ms first-paint delay while preserving its real intent: `loaded` alone is too early for reliable drawing.

If changing Canvas backing width/height changes NativeScript layout dimensions rather than only backing resolution, stop at the surface gate and revise the Canvas sizing strategy before external tray/gesture work.

## Board gestures and transient viewport

Final Canvas gesture ownership:

- `touch` with exactly two pointers -> combined zoom + centroid pan;
- `tap` -> board placement when a piece is selected;
- `doubleTap` -> Fit when the current sequence was not a placement sequence;
- one-finger Canvas movement -> no pan and no piece drag.

The HPA-1 `on:pan`, `pointFromPan`, `pieceAt`, and in-Canvas unplaced-piece path are deleted when the external tray lands.

Two-pointer math always derives the current transform from one gesture-start baseline. Pinch and pan are not applied as separate incremental mutations.

`PuzzleCanvas.svelte` holds a transient viewport during the gesture:

```ts
let transientViewport: PersistedViewport | null | undefined;
```

`undefined` means no active gesture; `null` is a valid transient Fit value. Rendering uses:

```text
transientViewport !== undefined
  ? transientViewport
  : sessionState.viewport
```

Changing `transientViewport` triggers redraw every frame without writing session state. Gesture end commits once through `gameplaySessionPolicy.commitViewport()`.

### Tap vs double-tap

A placement tap records a short suppression window so a following native `doubleTap` callback cannot perform `place -> Fit` after the placement clears selection. A selected-piece sequence remains placement-oriented; More -> Fit Board is always available as the deterministic escape hatch.

Do not delay every placement tap waiting to discover whether a second tap arrives.

## External tray and cross-view drag

Unplaced pieces live only in `PuzzleTray.svelte` after the surface gate.

Tap placement:

1. tap tray piece -> `select_piece`;
2. tap board cell -> `attempt_placement`.

Cross-view dragging uses the narrow callback protocol already planned. `Gameplay.svelte` owns one full-bleed drag overlay spanning both columns, positioned in screen DIPs. The tray never attempts to draw outside its own clipped column; Canvas never owns the in-flight tray piece.

### Scroll vs drag rule

The tray must remain usable with 100–108-piece Hard variants.

Use NativeScript’s existing **long-press gesture as the drag arm**:

- ordinary vertical movement before long-press recognition belongs to the ScrollView;
- `longPress` began arms the piece drag and disables tray scrolling;
- while armed, touch move updates the full-bleed overlay;
- touch up/cancel performs drop/snap-back and re-enables scrolling.

Do not add a custom duration or generic gesture arbiter unless the installed NativeScript/iOS behavior proves the high-level recognizer cannot coexist with ScrollView. This is an explicit Task 3B native stop gate.

Drop semantics:

- outside board -> clear overlay, no gameplay dispatch;
- wrong slot/non-upright -> same `attempt_placement`, reject feedback, snap back;
- accepted -> tray projection removes the piece, board renders canonical placement.

Drag coordinates are never persisted.

## Tray behavior and order

Expose only:

- remaining count;
- All / Corners / Edges / Center;
- Shuffle;
- selected highlight;
- selected-piece Rotate when rotation is enabled.

Use `matchesInventoryFilter()` from game-core for visible projection.

Keep two distinct concepts:

- **all unplaced IDs** -> source for reorder/shuffle;
- **visible unplaced IDs** -> filtered rendering only.

Shuffle under Corners/Edges/Center must still dispatch a complete permutation of **all** unplaced IDs; passing the filtered subset would correctly no-op in the engine and is explicitly unit-tested.

Do not expose `activeTray`, membership, names, rename/remove, multi-select, or clustering.

Hints continue to use the existing `hint_target` event. Mobile keeps target/piece highlight ephemeral; the engine remains responsible for resetting the filter to All.

## Toolbar, reference and feedback

Visible controls: Library, puzzle/difficulty, timer, Undo, Redo, Hint, Reference, More.

More expands exactly: Fit Board, Rotation On/Off, Pause, Restart, Discard.

Reference expands: Hold to Peek, Toggle, Ghost. Use only the downloaded reference asset; there is no network fallback.

Placement feedback stays ephemeral:

- accepted -> brief target-cell success flash;
- rejected -> brief target-cell reject flash;
- hint target -> persistent outline until consumed/replaced.

No animation framework or sound system is added.

## Completion

Completion is local-only in HPA-3.

On `completion_sealed`:

1. persist the sealed session immediately;
2. show a concrete native completion sheet projected from `SealedCompletion` + downloaded variant metadata.

Show puzzle name/difficulty, Timed/Relaxed, elapsed time when applicable, hints, incorrect attempts, rotation enabled/used, and Back to Library.

Do not add completion API calls, auth, outbox, achievements, leaderboards, or another local completion database. HPA-4 owns account-bound completion submission.

Downloaded row copy reuses `getDifficultyLabel()` exactly, matching Gallery casing such as `Easy · 16 PIECES`.

## Testing strategy

### Game-core

Tests pin:

- valid viewport store/clone;
- `zoom <= 0` and non-finite rejection;
- Fit clearing;
- no activity/history/result-class mutation;
- serializer/loader round trip;
- shared persisted units documented on the type.

### Mobile pure tests

Vitest covers:

- layout-DIP/backing-pixel conversion;
- screen-DIP -> Canvas conversion;
- discriminating no-padding fit geometry;
- zoom/pan/inverse cell transform;
- two-pointer focal/centroid math;
- double-tap suppression;
- draw projection uses supplied transform;
- fresh/restart/button shuffle from one helper;
- filtered visible projection vs complete unplaced reorder input;
- `gameplaySessionPolicy` entry/suspend/viewport/discard behavior and call ordering.

No Svelte component-test framework is added.

### Native gates

#### Surface gate (Task 3A)

Before external tray work:

- Canvas fills current board column on the iPad simulator;
- backing dimensions follow rendered DIPs × density;
- first post-layout paint succeeds without the old 100 ms delay;
- existing in-Canvas tap/drag still hit the expected cells at device density;
- relayout recreates geometry without stale coordinates.

#### Tray gate (Task 3B)

Use a downloaded Hard variant (100–108 pieces) to prove the behavior Easy cannot exercise:

- tray actually scrolls;
- ordinary scroll does not start drag;
- long-press drag can start without scrolling;
- overlay stays visible across tray -> board;
- outside drop is no-op;
- valid board drop reaches the correct canonical cell.

If long-press + ScrollView cannot be made reliable with the installed high-level NativeScript gestures, stop this task and choose the smallest local iOS-compatible alternative. Do not introduce a generic gesture subsystem.

### Final offline acceptance

Avoid a pointless manual 100-piece solve. Download both:

- one Hard variant for the scroll/zoom/drag stress path;
- one Easy variant for the complete offline journey.

After downloads, stop the API/network dependency.

Hard stress path verifies tray scrolling, long-press drag, pinch, two-finger pan, Fit and transform-aware placement.

Easy full journey verifies setup, shuffled start, tap/drag placement, rotation, filters/shuffle, Hint, all references, undo/redo, pause/resume, viewport restore, background timing, offline completion sheet, and protected completed progress.

If reliable multi-touch automation is unavailable, record explicit manual evidence rather than adding a fragile native E2E framework.

## Risks and stop conditions

1. **Canvas backing-size semantics** — prove in Task 3A before tray/gesture rewrite.
2. **DIP vs backing-pixel coordinates** — one tested `screenPointToCanvas()` conversion only.
3. **First-paint readiness** — first non-zero `layoutChanged` + next-turn draw replaces fixed 100 ms delay; native gate proves it.
4. **ScrollView vs piece drag recognizers** — long-press arm is the intended rule; Hard tray gate proves it before proceeding.
5. **Tap vs double-tap recognizers** — placement sequence suppresses Fit; no delayed placement.
6. **Cross-column clipping** — full-bleed Gameplay overlay owns in-flight piece.
7. **Transient gesture redraw** — transient viewport participates in reactive draw but persists only once at gesture end.
8. **Shared viewport units** — units are documented on the shared type before the first writer ships.

## Scope fence

HPA-3 does **not** include:

- portrait/live orientation switching (HPA-46);
- phone UI;
- Android release/polish;
- draggable tray sizing;
- named/staging/manual tray organization;
- local-photo puzzle creation;
- Google login, cloud session sync, completion outbox/server retry, achievements, leaderboards, or account UI (HPA-4);
- backend/API/D1/Workflow/infrastructure changes;
- new download/session schema version;
- a second gameplay controller/store;
- web viewport-helper sharing;
- generic toolbar/dialog/gesture/responsive-layout frameworks;
- broad native E2E infrastructure.

## Acceptance mapping

HPA-3 is complete when:

- iPad gameplay is landscape-only for this slice, with a dynamic Canvas majority column and persistent usable right tray;
- one geometry module owns fit, transform and cell hit-testing;
- Hard tray stress proves scrolling, drag arming, cross-column overlay and zoom/pan behavior;
- tap placement and cross-view drag share the same `attempt_placement` path;
- Timed/Relaxed, rotation, undo/redo, hints, reference modes, filters/shuffle, pause/resume, restart/discard and completion are driven through `PuzzleSession`;
- the load-bearing entry/suspend/viewport/discard decisions are covered by pure unit tests rather than only a manual checklist;
- backgrounding stops elapsed time without forcing Pause UI;
- viewport restores from the existing V1 optional field using documented portable units;
- one downloaded Easy variant can be completed entirely offline through the production landscape UI;
- no manual tray grouping, backend/auth work, schema migration, second controller, or generic native framework is added.