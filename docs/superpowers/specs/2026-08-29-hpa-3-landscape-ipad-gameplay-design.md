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

The setup sheet exposes only Timed/Relaxed, Rotation Off/On, Start, and Back to Library. Start dispatches `configure_setup`, then `start`, then persists immediately.

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

Backgrounding is not explicit Pause. Suspend ordering is load-bearing: first `session.setDocumentHidden(true)` so the engine checkpoints/stops the clock, then serialize/save the current state, leaving sheet state unchanged. Foreground calls `setDocumentHidden(false)` without forcing Pause UI.

### Restart

Restart confirms when meaningful activity exists, dispatches `restart`, persists setup state, reopens setup seeded from prior mode/rotation, and the next Start dispatches `configure_setup + start`. Restart gets a fresh shuffled tray order and resets viewport to Fit.

### Discard

Discard confirms, calls existing `SessionStorageAdapter.clearSession(puzzleId)`, and exits only after success. Failure stays on the concrete sheet with inline copy.

## Small tested session policy seam

Do not add Svelte component testing infrastructure just for HPA-3. Move only the persistence/lifecycle decisions that are easy to regress into `apps/mobile/app/gameplay/gameplaySessionPolicy.ts` with normal Vitest coverage.

The file is not a controller or store. It contains only four deterministic helpers: `entrySheetFor`, `suspendSession`, `commitViewport`, and `discardProgress`. Tests use fakes to pin fresh/active/paused entry policy, hide-before-save suspend ordering, viewport-save gating, and discard result. `Gameplay.svelte` remains wiring; ephemeral hint/feedback presentation stays component-local.

## Persisted viewport seam

The V1 schema already contains optional `PersistedViewport { zoom, panX, panY }`; the codec already round-trips it and rejects non-finite numbers or `zoom <= 0`.

Add one engine action `{ type: 'set_viewport'; viewport: PersistedViewport | null }` with `viewport_changed` and `viewport_noop` outcomes. It mirrors the codec numeric predicate, clones the value, notifies subscribers, and never marks gameplay activity, result eligibility, or undo/redo history. `null` means Fit/default.

### Shared persisted units

Task 1 documents the shared units on `PersistedViewport`:

- `zoom` = multiplier over fit-to-viewport cell scale (`1` = Fit);
- `panX`/`panY` = offsets in fit-cell units, not pixels;
- positive pan moves the board right/down;
- app UI may clamp its usable range, but persisted units are portable.

The web’s current live viewport uses different non-persisted CSS-pixel/absolute-scale values. HPA-3 does not reuse or change that helper.

Mobile UI clamps zoom to `1..4`. At Fit, pan normalizes to zero and persistence uses `null`. Pan is clamped so the board cannot be moved completely out of view; an axis that still fits remains centered.

## One board geometry source

`boardViewport.ts` is the only module allowed to compute fit geometry or canonical cell hit-testing. It owns layout DIPs -> backing pixels, screen-DIP -> backing coordinates, `createBoardTransform`, explicit `calculateFitZoom(..., 1)`, fit/zoom/pan clamp, `BoardTransform.cellAt`, two-pointer focal transform, and double-tap Fit suppression.

`boardViewModel.ts` becomes a draw projection over a supplied `BoardTransform`; it must not call `calculateFitZoom()` or own a second `cellAt()` formula. A discriminating unit test pins 2×2 in 800×600 to `fitCellSize === 300` and `boardX === 100`.

## Canvas sizing and first paint

The current fixed `700×800` surface and letterboxing conversion are removed, but the native plugin assumption is proven **before** the tray rewrite.

Production sequence: wait for a non-zero `layoutChanged`, read rendered DIPs, derive backing pixels from density, assign backing `width/height`, recreate transform/view model, then schedule first draw on the next JS turn. This replaces the current arbitrary 100 ms delay while preserving its intent that `loaded` alone is too early.

If changing backing dimensions feeds back into NativeScript layout instead of only backing resolution, stop at the surface gate and revise before external tray/gesture work.

## Board gestures and transient viewport

Final Canvas gesture ownership:

- exactly two touch pointers -> combined zoom + centroid pan;
- tap -> board placement when selected;
- doubleTap -> Fit when not suppressed by a placement sequence;
- one-finger Canvas movement -> no pan and no piece drag.

The HPA-1 `on:pan`, `pointFromPan`, `pieceAt`, and in-Canvas unplaced path are deleted when the external tray lands.

Two-pointer math derives from one gesture-start baseline. `PuzzleCanvas.svelte` holds `transientViewport: PersistedViewport | null | undefined`; rendering uses transient when defined and session viewport otherwise. Transient changes redraw every frame without persisting; gesture end commits once through `gameplaySessionPolicy.commitViewport()`.

A placement tap records a short suppression window so a later native `doubleTap` callback cannot perform `place -> Fit` after placement clears selection. More -> Fit Board is always available; do not delay every placement tap.

## External tray and cross-view drag

Unplaced pieces live only in `PuzzleTray.svelte` after the surface gate. `Gameplay.svelte` owns one full-bleed drag overlay spanning board and tray. Tray never draws outside its clipped column; Canvas never owns the in-flight tray piece.

### Scroll vs drag rule

The tray must remain usable with 100–108-piece Hard variants. Use NativeScript’s high-level `longPress` as the drag arm: ordinary movement before recognition belongs to ScrollView; longPress began arms drag and disables scrolling; armed touch move updates overlay; up/cancel drops/snaps back and restores scrolling.

Do not add a custom duration or generic gesture arbiter unless the installed runtime proves the high-level recognizer cannot coexist with ScrollView. Task 3B is an explicit native stop gate for this assumption.

Drop outside board is a no-op; wrong slot/non-upright uses the normal engine rejection path; accepted drop places canonically. Drag coordinates are never persisted.

## Tray behavior and order

Expose remaining count, All/Corners/Edges/Center, Shuffle, selected highlight, and selected-piece Rotate when enabled. Use `matchesInventoryFilter()` for visible projection.

Keep all-unplaced IDs separate from visible-unplaced IDs. Reorder/Shuffle always receives a complete permutation of all unplaced IDs even when a non-All filter is active; this has an explicit regression test.

Do not expose active tray, membership, names, rename/remove, multi-select, or clustering. Hint target/piece highlight stays ephemeral; engine remains responsible for resetting filter to All.

## Toolbar, reference and feedback

Visible controls: Library, puzzle/difficulty, timer, Undo, Redo, Hint, Reference, More. More expands Fit Board, Rotation On/Off, Pause, Restart, Discard. Reference expands Hold to Peek, Toggle, Ghost using only the downloaded reference asset; there is no network fallback.

Placement feedback stays ephemeral: accepted success flash, rejected failure flash, and separate persistent hint outline. No animation framework or sound system is added.

## Completion

Completion is local-only in HPA-3. On `completion_sealed`, persist the sealed session immediately and show a concrete native sheet with puzzle/difficulty, Timed/Relaxed, elapsed time when applicable, hints, incorrect attempts, rotation enabled/used, and Back to Library.

Do not add completion API calls, auth, outbox, achievements, leaderboards, or another local completion database. HPA-4 owns account-bound submission. Downloaded row copy reuses `getDifficultyLabel()` exactly, matching Gallery casing such as `Easy · 16 PIECES`.

## Testing strategy

Game-core tests pin viewport validation/history/activity/round-trip and the shared unit comment. Mobile Vitest pins layout/backing conversion, screen→Canvas conversion, discriminating fit geometry, zoom/pan/inverse transform, two-pointer math, double-tap suppression, draw projection over supplied transform, shuffle policy, filtered-vs-all unplaced projection, and `gameplaySessionPolicy` call ordering. No Svelte component-test framework is added.

### Native gates

**Task 3A surface gate:** prove Canvas layout/backing sizing, first post-layout paint, existing tap/drag hit testing, and relayout before changing interaction ownership.

**Task 3B tray gate:** use a downloaded Hard variant to prove real tray scrolling, ordinary scroll vs long-press drag separation, cross-column overlay visibility, outside drop, and valid drop. If longPress+ScrollView is unreliable, stop and choose the smallest local alternative.

### Final offline acceptance

Download one Hard variant for scroll/zoom/drag stress and one Easy variant for the complete offline journey. Hard verifies the dense interaction path but does **not** require a 100–108-piece manual solve. Easy verifies setup, shuffled start, tap/drag, rotation, filters/shuffle, Hint, references, undo/redo, pause/resume, viewport restore, background timing, offline completion, and protected completed progress.

If reliable multi-touch automation is unavailable, record explicit manual evidence rather than adding a fragile native E2E framework.

## Risks and stop conditions

1. Canvas backing-size semantics — prove in Task 3A.
2. DIP vs backing-pixel coordinates — one tested conversion only.
3. First-paint readiness — first non-zero layout + next-turn draw.
4. ScrollView vs piece drag recognizers — Hard tray gate proves long-press arm.
5. Tap vs double-tap recognizers — placement sequence suppresses Fit.
6. Cross-column clipping — full-bleed Gameplay overlay.
7. Transient gesture redraw — render transient, persist once on end.
8. Shared viewport units — document before first writer ships.

## Scope fence

HPA-3 excludes portrait/live orientation switching (HPA-46), phone UI, Android release polish, draggable tray sizing, named/staging/manual tray organization, local-photo creation, auth/cloud sync/completion outbox/progression (HPA-4), backend/API/D1/Workflow/infrastructure changes, new schema versions, a second controller/store, web viewport sharing, generic UI/gesture frameworks, and broad native E2E infrastructure.

## Acceptance mapping

HPA-3 is complete when landscape iPad gameplay uses a dynamic Canvas + usable right tray; one geometry module owns fit/transform/cell mapping; Hard stress proves scroll/drag/zoom behavior; placement routes through one `attempt_placement`; gameplay parity remains `PuzzleSession`-driven; load-bearing entry/suspend/viewport/discard policy is unit-tested; backgrounding stops elapsed time without forcing Pause; viewport restores in documented portable units; one Easy variant completes entirely offline; and no HPA-46/HPA-4/backend/schema/framework scope leaks in.