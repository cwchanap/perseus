# HPA-46 Portrait and Adaptive Tablet UX Design

**Date:** 2026-08-30  
**Linear:** HPA-46 — [Perseus Mobile] Add portrait and adaptive tablet UX  
**Depends on:** HPA-3 (Done)

## Goal

Add portrait iPad gameplay and live landscape/portrait switching on top of the completed HPA-3 mobile gameplay path without creating a second board, controller, persistence model, or responsive UI framework.

The same `PuzzleSession`, `PuzzleCanvas`, `PuzzleTray`, toolbar actions, filesystem session adapter, and downloaded puzzle model remain authoritative. HPA-46 changes only how the existing gameplay surface is arranged when the available tablet dimensions change, plus the minimum transient-gesture cleanup needed when that surface is resized.

## Current baseline

HPA-1 through HPA-3 are complete. Current `main` already has:

- one shared `@perseus/game-core` `PuzzleSession` for placement, lifecycle, time, history, hints, rotation, inventory organization, reference state, viewport state, and completion sealing;
- one production `Gameplay.svelte` composition root for mobile;
- one `PuzzleCanvas.svelte` whose backing surface is derived from actual NativeScript layout size and rebuilt on `layoutChanged`;
- one `boardViewport.ts` source for fit/zoom/pan, screen-to-canvas conversion, and canonical cell hit-testing;
- persisted viewport units defined as zoom relative to Fit plus pan in fit-cell units;
- a persistent landscape right tray and a full-bleed cross-view drag overlay;
- a concrete landscape toolbar, tray, setup/pause/discard/completion sheets, and offline resume behavior;
- iPad orientation metadata intentionally restricted to landscape by HPA-3.

Two HPA-3 implementation details matter directly to orientation changes:

1. `PuzzleCanvas` keeps transient multi-pointer state (`gesture`, `transientViewport`, pointer slots/count) outside `PuzzleSession`; today it is reset on run changes and partly reset by native touch cancellation.
2. `BoardTransform.viewport` is a **render-clamped echo** of the persisted viewport input. The persisted `sessionState.viewport` remains the source value and may have a wider legal pan range on another surface.

Those seams are sufficient for portrait. No game-core, download, session-schema, backend, auth, or library change is required.

## Delivery decision

Use one implementation PR for HPA-46. This planning PR becomes that implementation PR: implementation commits continue on the same branch after review.

Task boundaries are reviewable commits inside the PR, not extra tickets or PRs.

## Approaches considered

### A. One adaptive gameplay grid — selected

Keep one `Gameplay.svelte` tree and reassign the existing Canvas/tray within one GridLayout based on actual rendered width/height:

- landscape: `columns="*,320"`, one row, tray on the right;
- portrait: one column, `rows="*,<tray-height>"`, tray on the bottom.

`PuzzleCanvas` and `PuzzleTray` stay mounted while their GridLayout row/column changes. This preserves the active `PuzzleSession`, selected piece, hint presentation, sheets, and other in-memory state naturally.

Use one small feature-local pure helper to derive the concrete tablet layout values. It is not a generic responsive framework.

### B. Duplicate landscape and portrait markup

Render separate `{#if portrait}` / `{:else}` Gameplay trees. This is initially easy to read but duplicates toolbar/tray/canvas wiring and risks remounting native views during rotation. It also makes later fixes easy to apply to one orientation only.

Rejected.

### C. Generic responsive layout/toolbar framework

Create reusable breakpoints, slot-based responsive containers, or a generalized toolbar system. There is only one real native gameplay consumer today, so the abstraction would be configuration without demonstrated reuse.

Rejected under YAGNI.

## Architecture

```text
Gameplay.svelte
  PuzzleSession + lifecycle/persistence + ephemeral gameplay state
        |
        +--> gameplayLayout.ts
        |      actual size -> concrete tablet layout values
        |
        +--> GameplayToolbar.svelte
        |      landscape arrangement / compact portrait arrangement
        |
        +--> PuzzleCanvas.svelte
        |      same component instance
        |      layoutChanged -> cancel transient pointer gesture on resize
        |      -> backing surface -> boardViewport
        |
        +--> PuzzleTray.svelte
               same component instance
               right panel in landscape
               bottom drawer in portrait
               explicit local drag cancellation on gameplay resize
```

### Ownership rules

| Concern | Owner |
| --- | --- |
| Gameplay rules/state/run identity | existing `PuzzleSession` |
| Session persistence | existing game-core codec + mobile file adapter |
| Canonical puzzle coordinates | existing session spec and placement rules |
| Persisted viewport value | existing `sessionState.viewport`; written only through the existing viewport commit path |
| Render-clamped viewport echo | existing `BoardTransform.viewport`; never a new persistence source |
| Fit/zoom/pan/cell projection | existing `boardViewport.ts` |
| Native Canvas relayout/redraw | existing `PuzzleCanvas.svelte` |
| Multi-pointer transient state reset on backing-size change | `PuzzleCanvas.svelte` local state only |
| Cross-view tray drag + overlay cancellation on gameplay resize | `PuzzleTray.svelte` local drag state + existing `Gameplay.svelte` overlay callback |
| Landscape vs portrait placement | new feature-local `gameplayLayout.ts` |
| Drawer expanded/collapsed state | ephemeral `Gameplay.svelte` state |
| Portrait tray header affordance | `PuzzleTray.svelte` |
| Portrait toolbar arrangement | `GameplayToolbar.svelte` |
| iPad supported orientations | `App_Resources/iOS/Info.plist` |

No orientation state is written to `PuzzleSession` or persisted files.

## Layout source of truth

Use actual rendered gameplay dimensions, not a second orientation service or hard-coded device model list.

`Gameplay.svelte` seeds its first valid layout from `Screen.mainScreen.widthDIPs/heightDIPs`, then listens to the content GridLayout's `layoutChanged` event and feeds the latest non-zero size into `gameplayLayout.ts`.

The helper returns only the values this gameplay screen needs:

```ts
type GameplayLayoutMode = 'landscape' | 'portrait';

interface GameplayLayout {
  mode: GameplayLayoutMode;
  rows: string;
  columns: string;
  trayRow: number;
  trayColumn: number;
  compactToolbar: boolean;
  drawerMode: boolean;
}
```

The constants stay concrete and local:

- landscape tray width: `320` DIPs, matching HPA-3;
- portrait collapsed tray height: `220` DIPs;
- portrait expanded tray height: `360` DIPs.

Invalid/zero `layoutChanged` sizes do **not** synthesize a fallback orientation. `Gameplay.svelte` keeps the last valid `GameplayLayout` until another valid rendered size arrives. This avoids a temporary portrait -> fake-landscape snap during rotation/startup layout passes.

Do not add breakpoint registries, device-class services, media-query abstractions, or platform-specific orientation observers. NativeScript already emits `layoutChanged` after the view size changes, and `PuzzleCanvas` already consumes that event for its backing surface.

This size-based approach also handles iPad Split View without a separate product concept.

## Landscape behavior

Landscape remains behaviorally identical to HPA-3:

```text
+------------------------------------------------------------------+
| LIBRARY | Puzzle · Difficulty | Timer | Undo Redo Hint Ref More   |
+--------------------------------------------------+---------------+
|                                                  | PIECES        |
|                 PUZZLE BOARD                     | filters       |
|                 native Canvas                    | piece grid    |
|                                                  |               |
+--------------------------------------------------+---------------+
```

The adaptive work must not regress the current right-side tray, gestures, toolbar behavior, or offline completion path.

## Portrait behavior

Portrait uses the same child components with the tray moved below the board:

```text
+------------------------------------------------------+
| LIBRARY | Puzzle · Difficulty | Timer | More         |
|          Undo | Redo | Hint | Reference              |
+------------------------------------------------------+
|                                                      |
|                 PUZZLE BOARD                         |
|                 native Canvas                        |
|                                                      |
+------------------------------------------------------+
| PIECES n left | MORE/LESS PIECES | Shuffle | Rotate  |
| All | Corners | Edges | Center                       |
| scrollable piece grid                                |
+------------------------------------------------------+
```

### Bottom tray drawer

Portrait starts with the tray collapsed to `220` DIPs so the board remains primary while one useful piece row stays reachable.

A single `MORE PIECES` / `LESS PIECES` action in the existing tray header toggles between `220` and `360` DIPs. Expansion only changes the GridLayout row height. It does not alter session state, tray membership/order, puzzle coordinates, or viewport persistence.

The expanded/collapsed choice is ephemeral and remains in memory while rotating away from portrait. Returning to portrait restores the same drawer choice for the mounted gameplay screen. Do not add another persisted preference/schema field for one tablet presentation choice.

`PuzzleTray` keeps exactly the HPA-3 product surface: remaining count, All/Corners/Edges/Center, Shuffle, selected-piece Rotate, selection, and long-press drag. No named trays, staging, manual organization, horizontal carousel, or draggable divider is added.

## Portrait toolbar

Add one `compact` presentation prop to the existing concrete `GameplayToolbar`.

Landscape markup stays unchanged.

Portrait uses two fixed rows:

1. Library, puzzle title/difficulty, timer, More;
2. Undo, Redo, Hint, Reference.

The existing More and Reference menus remain the only secondary action surfaces. In compact mode, More uses a narrow multi-row arrangement so Fit Board, Rotation, Pause, Restart, and Discard do not depend on five long labels fitting side-by-side.

Do not create reusable toolbar-item data models, registries, overflow engines, or responsive toolbar components. The toolbar already has one real caller and two concrete tablet arrangements are simpler.

## Orientation changes during an active run

An orientation/layout change is presentation-only.

`Gameplay.svelte` must not reconstruct `PuzzleSession`, dispatch `restart`, `start`, `pause`, `resume`, or `set_viewport`, or reload the persisted session because the screen size changed.

The same mounted gameplay tree means these values survive naturally:

- `runId` and lifecycle/mode/time;
- placed pieces and counters;
- undo/redo history;
- selected piece;
- rotation state;
- tray filter/order;
- hint presentation;
- open setup/pause/discard/completion sheet where applicable.

### Transient pointer/drag cancellation

Native interface rotation is allowed to cancel an in-flight finger gesture, but HPA-46 must make that cancellation deterministic instead of relying on iOS to deliver `touchesCancelled`.

When `PuzzleCanvas.syncSurface()` observes a real backing width/height change after the initial surface exists:

- clear `gesture`;
- clear `transientViewport`;
- clear cached pointer slots;
- reset `activePointerCount`;
- rebuild from the persisted `sessionState.viewport`, not a stale transient effective viewport;
- do **not** call `onViewportCommit`.

This is the same no-commit reset intent already used when a new `runId` invalidates stale pointer state. Keep it as a local helper in `PuzzleCanvas.svelte`; do not add a gesture manager.

The tray has separate transient state. `PuzzleTray.svelte` exposes one narrow component method that cancels an armed long-press drag by setting its local `dragArmed` false and calling the existing `onPieceDragCancel` callback. When `Gameplay.svelte` accepts a changed rendered gameplay size, it calls that method so the existing parent overlay is cleared and tray scrolling cannot remain disabled after rotation.

No gesture state is persisted. A rotation may terminate the current pinch/drag; the next gesture must work normally.

## Viewport behavior across portrait/landscape

Keep the HPA-3 persisted viewport contract unchanged.

`PuzzleCanvas.syncSurface()` already receives `layoutChanged` and derives new backing dimensions. `boardViewport.ts` expresses pan in fit-cell units and clamps projection to the current surface.

The key distinction is:

```text
sessionState.viewport
  persisted user intent
       |
       v
createBoardTransform(surface)
       |
       v
BoardTransform.viewport
  render-clamped echo for THIS surface only
```

`BoardTransform.viewport` must never be written back merely because a relayout clamped it. A pan value legal in landscape may be clamped in portrait and become legal again when landscape returns.

Therefore orientation handling must:

- reuse the same persisted `sessionState.viewport` value;
- recompute fit scale from the new Canvas dimensions;
- preserve zoom/pan intent in the existing portable units;
- clamp only the rendered transform where the new surface cannot show the previous pan range;
- keep canonical cell coordinates unchanged;
- never call `onViewportCommit` from `syncSurface()` or the gameplay layout handler;
- rebuild from `sessionState.viewport` after a resize cancels a transient pinch.

Only completed user viewport gestures and the existing explicit Fit action may use the existing viewport commit writer.

Add a focused `boardViewport.test.ts` characterization using one persisted viewport whose pan fits the landscape surface but is clamped on portrait. Re-project the **same original input** on landscape again and prove the wider pan returns. This pins render-clamp-only behavior; a cell hit-test derived from each transform's own `boardX/boardY` is insufficient because it would pass even if pan were ignored.

## Cross-view drag after relayout

Keep the HPA-3 drag architecture:

- tray gesture coordinates remain true screen DIPs;
- the full-bleed overlay remains owned by `Gameplay.svelte`;
- final drop still calls `PuzzleCanvas.cellAtScreenPoint()` using the Canvas's current on-screen origin and current surface metrics.

No portrait-specific drop math is needed. Relayout updates the Canvas's actual origin/size, so the existing conversion remains the source of truth.

If rotation occurs during an armed tray drag, HPA-46 cancels the drag as described above rather than attempting to continue the physical gesture across the relayout.

The focused native smoke must include one portrait tray-to-board drag after at least one orientation change.

## iOS orientation metadata

HPA-3 deliberately limited the iPad `UISupportedInterfaceOrientations~ipad` array to landscape.

HPA-46 adds `UIInterfaceOrientationPortrait` to the iPad array. Do not add upside-down portrait unless a later product requirement asks for it.

The existing non-iPad orientation list is left alone; phone-sized UX remains out of scope.

## Testing strategy

### Mobile unit tests

Create `gameplayLayout.test.ts` to pin:

- landscape dimensions -> existing `*,320` right tray + non-compact toolbar;
- portrait dimensions -> bottom tray + compact toolbar;
- collapsed vs expanded portrait tray heights (`220`/`360`);
- invalid/zero sizes -> no replacement layout.

Extend `boardViewport.test.ts` with one cross-aspect characterization that proves:

1. a persisted viewport/pan is accepted unchanged on a landscape surface;
2. the same input is clamped for rendering on a portrait surface;
3. the input object remains unchanged;
4. reusing that same original input on landscape restores the wider landscape projection.

No Svelte component-test framework is added for this ticket.

### Native iPad smoke

Keep native acceptance small. On an iPad simulator/device:

1. launch the app in portrait and open/resume a downloaded puzzle;
2. verify compact toolbar actions and the collapsed/expanded bottom tray;
3. select and place at least one piece in portrait;
4. zoom/pan, then rotate to landscape;
5. verify the same run remains active with placement/filter/selection state intact where visible and the viewport remains understandable;
6. perform another pinch after rotation and verify multi-touch still starts normally;
7. use the existing right tray in landscape;
8. rotate back to portrait;
9. perform one long-press tray drag onto the board;
10. verify tray scrolling is still enabled after the rotate/drag cycle;
11. background/foreground once and verify timing/session persistence still behaves as HPA-3 defined.

If practical on the target device/simulator, also rotate while a pinch or tray drag is active and verify the gesture is canceled rather than leaving stale pointer/drag state. This is evidence for the explicit cleanup, not a requirement to preserve an in-flight gesture through rotation.

Use the existing manual/TestFlight/XCUITest-style evidence only if convenient. Do not add a broad native E2E framework for one orientation journey.

### Regression checks

Run:

- `bun run --cwd apps/mobile test:unit`;
- `bun run --cwd packages/game-core test:unit` only if game-core changes unexpectedly (the planned implementation should not touch it);
- normal workspace checks affected by the final diff;
- `ns run ios --no-hmr --justlaunch` for the final native build/smoke.

## Risks and stop conditions

1. **Runtime GridLayout row/column reassignment** — NativeScript supports runtime layout-property changes; prove the same Canvas/tray instances reflow correctly on the first implementation/device pass. If Svelte Native remounts the children, stop and use the smallest imperative GridLayout property update rather than duplicate gameplay trees.
2. **Stale pointer state after resize** — reset Canvas gesture state on backing-size changes without committing transient viewport, and explicitly cancel any armed tray drag through its existing callback path.
3. **Persisted vs clamped viewport confusion** — `BoardTransform.viewport` is render-only. Never feed it back into session persistence on relayout.
4. **Compact toolbar width** — verify on the target iPad portrait width. If one label still clips, shorten concrete copy or move that existing action into the existing More menu; do not build responsive infrastructure.
5. **Tray height** — `220`/`360` are concrete starting values. Adjust only if the target iPad smoke shows the collapsed tray cannot expose one useful row or expanded tray starves the board.
6. **Gesture cancellation during rotation** — canceling an in-flight gesture is acceptable. Gameplay/session state loss or a broken next gesture is not.
7. **Viewport reprojection** — if current HPA-3 fit-cell units reveal a real orientation bug, fix `boardViewport.ts` locally with tests; do not add orientation-specific coordinates or schema fields.

## Scope fence

HPA-46 excludes:

- phone-sized UI optimization;
- Android release/polish;
- new gameplay rules or mobile-only `PuzzleSession` actions;
- a second board/view model/coordinate system;
- per-orientation persisted viewport values;
- draggable tray sizing;
- named/staging/manual tray organization;
- backend/API/D1/Workflow changes;
- Google login/account completion sync (HPA-4);
- achievements/leaderboards;
- generic responsive layout, toolbar, gesture, dialog, or state frameworks;
- a new native E2E framework.

## Acceptance mapping

HPA-46 is complete when iPad advertises portrait support; the existing gameplay tree adapts between a right-side landscape tray and bottom portrait drawer without rebuilding the run; portrait exposes all existing toolbar/tray actions through one compact arrangement; invalid intermediate layout sizes keep the last valid arrangement; orientation changes cancel stale transient Canvas/tray gestures without committing them; gameplay state and the original persisted viewport intent survive relayout; render-only viewport clamps are not written back; canonical placement coordinates remain unchanged; one focused native smoke covers portrait play, live orientation change, a working post-rotation pinch, and portrait drag; and no game-core/schema/backend/account/framework scope leaks into the ticket.
