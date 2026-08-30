# HPA-46 Portrait and Adaptive Tablet UX Design

**Date:** 2026-08-30  
**Linear:** HPA-46 — [Perseus Mobile] Add portrait and adaptive tablet UX  
**Depends on:** HPA-3 (Done)

## Goal

Add portrait iPad gameplay and live landscape/portrait switching on top of the completed HPA-3 mobile gameplay path without creating a second board, controller, persistence model, or responsive UI framework.

The same `PuzzleSession`, `PuzzleCanvas`, `PuzzleTray`, toolbar actions, filesystem session adapter, and downloaded puzzle model remain authoritative. HPA-46 changes only how the existing gameplay surface is arranged when the available tablet dimensions change.

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
        |      existing layoutChanged -> backing surface -> boardViewport
        |
        +--> PuzzleTray.svelte
               same component instance
               right panel in landscape
               bottom drawer in portrait
```

### Ownership rules

| Concern | Owner |
| --- | --- |
| Gameplay rules/state/run identity | existing `PuzzleSession` |
| Session persistence | existing game-core codec + mobile file adapter |
| Canonical puzzle coordinates | existing session spec and placement rules |
| Fit/zoom/pan/cell projection | existing `boardViewport.ts` |
| Native Canvas relayout/redraw | existing `PuzzleCanvas.svelte` |
| Landscape vs portrait placement | new feature-local `gameplayLayout.ts` |
| Drawer expanded/collapsed state | ephemeral `Gameplay.svelte` state |
| Portrait tray header affordance | `PuzzleTray.svelte` |
| Portrait toolbar arrangement | `GameplayToolbar.svelte` |
| iPad supported orientations | `App_Resources/iOS/Info.plist` |

No orientation state is written to `PuzzleSession` or persisted files.

## Layout source of truth

Use actual rendered gameplay dimensions, not a second orientation service or hard-coded device model list.

`Gameplay.svelte` seeds its first layout from `Screen.mainScreen.widthDIPs/heightDIPs`, then listens to the content GridLayout's `layoutChanged` event and feeds the latest non-zero size into `gameplayLayout.ts`.

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

Invalid/zero layout sizes return no replacement layout; the last valid layout stays rendered.

Do not add breakpoint registries, device-class services, media-query abstractions, or platform-specific orientation observers. NativeScript already emits `layoutChanged` after the view size changes, and `PuzzleCanvas` already consumes that event for its backing surface.

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

The expanded/collapsed choice is ephemeral. Do not add another persisted preference/schema field for one tablet presentation choice.

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

An in-flight drag or pinch is ephemeral interaction state, not gameplay state. Native gesture cancellation during rotation may cancel that gesture; HPA-46 does not add a gesture-recovery protocol merely to continue a finger gesture through physical rotation.

## Viewport behavior across portrait/landscape

Keep the HPA-3 persisted viewport contract unchanged.

`PuzzleCanvas.syncSurface()` already receives `layoutChanged`, derives new backing dimensions, and rebuilds the transform from the current effective viewport. `boardViewport.ts` already expresses pan in fit-cell units and clamps projection to the current surface.

Therefore orientation handling should:

- reuse the same persisted `sessionState.viewport` value;
- recompute fit scale from the new Canvas dimensions;
- preserve zoom/pan intent in the existing portable units;
- clamp only the rendered transform where the new surface cannot show the previous pan range;
- keep canonical cell coordinates unchanged;
- avoid automatically committing a new viewport merely because the device rotated.

Not committing on rotation is intentional: a portrait-specific clamp should not destroy the user's broader landscape pan value. Returning to landscape can project the same persisted value again.

Add a focused `boardViewport.test.ts` characterization proving one persisted viewport reprojects across landscape and portrait surfaces while canonical cell hit-testing remains the same.

## Cross-view drag after relayout

Keep the HPA-3 drag architecture:

- tray gesture coordinates remain true screen DIPs;
- the full-bleed overlay remains owned by `Gameplay.svelte`;
- final drop still calls `PuzzleCanvas.cellAtScreenPoint()` using the Canvas's current on-screen origin and current surface metrics.

No portrait-specific drop math is needed. Relayout updates the Canvas's actual origin/size, so the existing conversion remains the source of truth.

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

Extend `boardViewport.test.ts` with one cross-aspect characterization proving the same persisted viewport projects valid canonical cells in both landscape and portrait.

No Svelte component-test framework is added for this ticket.

### Native iPad smoke

Keep native acceptance small. On an iPad simulator/device:

1. launch the app in portrait and open/resume a downloaded puzzle;
2. verify compact toolbar actions and the collapsed/expanded bottom tray;
3. select and place at least one piece in portrait;
4. zoom/pan, then rotate to landscape;
5. verify the same run remains active with placement/filter/selection state intact where visible and the viewport remains understandable;
6. use the existing right tray in landscape;
7. rotate back to portrait;
8. perform one long-press tray drag onto the board;
9. background/foreground once and verify timing/session persistence still behaves as HPA-3 defined.

Use the existing manual/TestFlight/XCUITest-style evidence only if convenient. Do not add a broad native E2E framework for one orientation journey.

### Regression checks

Run:

- `bun run --cwd apps/mobile test:unit`;
- `bun run --cwd packages/game-core test:unit` only if game-core changes unexpectedly (the planned implementation should not touch it);
- normal workspace checks affected by the final diff;
- `ns run ios --no-hmr --justlaunch` for the final native build/smoke.

## Risks and stop conditions

1. **Runtime GridLayout row/column reassignment** — NativeScript supports runtime layout-property changes; prove the same Canvas/tray instances reflow correctly on the first implementation/device pass. If Svelte Native remounts the children, stop and use the smallest imperative GridLayout property update rather than duplicate gameplay trees.
2. **Compact toolbar width** — verify on the target iPad portrait width. If one label still clips, shorten concrete copy or move that existing action into the existing More menu; do not build responsive infrastructure.
3. **Tray height** — `220`/`360` are concrete starting values. Adjust only if the target iPad smoke shows the collapsed tray cannot expose one useful row or expanded tray starves the board.
4. **Gesture cancellation during rotation** — canceling an in-flight gesture is acceptable. Gameplay/session state loss is not.
5. **Viewport reprojection** — if current HPA-3 fit-cell units reveal a real orientation bug, fix `boardViewport.ts` locally with tests; do not add orientation-specific coordinates or schema fields.

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

HPA-46 is complete when iPad advertises portrait support; the existing gameplay tree adapts between a right-side landscape tray and bottom portrait drawer without rebuilding the run; portrait exposes all existing toolbar/tray actions through one compact arrangement; orientation changes preserve gameplay state and reuse the current portable viewport contract; canonical placement coordinates remain unchanged; one focused native smoke covers portrait play plus at least one live orientation change; and no game-core/schema/backend/account/framework scope leaks into the ticket.
