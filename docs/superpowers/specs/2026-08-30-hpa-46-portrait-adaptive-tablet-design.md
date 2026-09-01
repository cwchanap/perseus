# HPA-46 Portrait and Adaptive Tablet UX Design

**Date:** 2026-08-30  
**Linear:** HPA-46 — [Perseus Mobile] Add portrait and adaptive tablet UX  
**Depends on:** HPA-3 (Done)

## Goal

Add portrait iPad gameplay and live landscape/portrait switching on top of the completed HPA-3 mobile gameplay path without creating a second board, controller, persistence model, or responsive UI framework.

The same `PuzzleSession`, `PuzzleCanvas`, `PuzzleTray`, toolbar, filesystem session adapter, and downloaded puzzle model remain authoritative. HPA-46 changes only how the existing gameplay surface is arranged when the available tablet dimensions change, plus the minimum gesture cleanup needed when the Canvas really changes size.

## Current baseline

HPA-1 through HPA-3 are complete. Current `main` already has:

- one shared `@perseus/game-core` `PuzzleSession` for placement, lifecycle, time, history, hints, rotation, inventory organization, reference state, viewport state, and completion sealing;
- one production `Gameplay.svelte` composition root for mobile;
- one `PuzzleCanvas.svelte` whose backing surface is derived from actual NativeScript layout size and rebuilt on `layoutChanged`;
- one `boardViewport.ts` source for backing-size math, fit/zoom/pan, screen-to-Canvas conversion, and canonical cell hit-testing;
- persisted viewport units defined as zoom relative to Fit plus pan in fit-cell units;
- a persistent landscape right tray and a full-bleed cross-view drag overlay;
- one concrete toolbar and More/Reference menus that already expose every HPA-3 action;
- iPad orientation metadata intentionally restricted to landscape by HPA-3.

No game-core, download, session-schema, backend, auth, or library change is required.

## Delivery decision

Use one implementation PR for HPA-46. This planning PR becomes that implementation PR: implementation commits continue on the same branch after review.

Task/commit boundaries are ordered around the native risk: prove runtime reflow first, then add resize cancellation, then add the portrait drawer. Do not build toolbar variants before the existing toolbar is measured in portrait.

## Approaches considered

### A. One adaptive gameplay grid — selected

Keep one `Gameplay.svelte` tree and reassign the existing Canvas/tray within one GridLayout based on the actual rendered page width/height:

- landscape: `columns="*,320"`, one row, tray on the right;
- portrait: one column, `rows="*,<tray-height>"`, tray on the bottom.

`PuzzleCanvas` and `PuzzleTray` stay mounted while their GridLayout row/column changes. This preserves the active `PuzzleSession` and component-local state naturally.

Use one small feature-local pure helper to derive the concrete tablet layout values. It is not a generic responsive framework.

### B. Duplicate landscape and portrait gameplay markup

Rejected. Separate `{#if portrait}` / `{:else}` trees duplicate gameplay wiring and risk remounting native views during rotation.

### C. Generic responsive layout/toolbar framework

Rejected. There is one real native gameplay consumer; abstraction would be configuration without demonstrated reuse.

### D. Pre-build a second compact toolbar arrangement

Rejected for now. The existing toolbar has one markup tree and has not yet demonstrated clipping at supported portrait widths. Adding a compact `{#if}` branch before measurement would duplicate the bar/menu and spend extra vertical space in portrait. HPA-46 first ships the existing toolbar unchanged through the portrait smoke. If the smoke demonstrates an actual clipped or unreachable action, stop and revise the plan around a single-tree row/column reflow rather than fork the toolbar markup.

## Architecture

```text
Gameplay.svelte
  PuzzleSession + lifecycle/persistence + ephemeral gameplay state
        |
        +--> gameplayLayout.ts
        |      actual page size -> concrete tablet grid values
        |
        +--> GameplayToolbar.svelte
        |      unchanged unless native measurement proves a defect
        |
        +--> PuzzleCanvas.svelte
        |      same component instance
        |      nextSurfaceMetrics() -> real resize? -> cancel transient pointers
        |      layout/backing -> boardViewport transform
        |
        +--> PuzzleTray.svelte
               same component instance
               right panel in landscape
               bottom drawer in portrait
               one narrow active-drag cancel seam
```

### Ownership rules

| Concern                                                              | Owner                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Gameplay rules/state/run identity                                    | existing `PuzzleSession`                                                |
| Session persistence                                                  | existing game-core codec + mobile file adapter                          |
| Canonical puzzle coordinates                                         | existing session spec and placement rules                               |
| Fit/zoom/pan/cell projection                                         | existing `boardViewport.ts`                                             |
| Layout DIPs -> Canvas backing metrics and real-size-change detection | `boardViewport.ts`                                                      |
| Native Canvas redraw/gesture wiring                                  | existing `PuzzleCanvas.svelte`                                          |
| Landscape vs portrait placement                                      | new feature-local `gameplayLayout.ts`                                   |
| Drawer expanded/collapsed state                                      | ephemeral `Gameplay.svelte` state                                       |
| Portrait tray affordance                                             | `PuzzleTray.svelte`                                                     |
| Toolbar                                                              | existing `GameplayToolbar.svelte`; change only if smoke proves clipping |
| iPad supported orientations                                          | `App_Resources/iOS/Info.plist`                                          |

No orientation state is written to `PuzzleSession` or persisted files.

## Layout source of truth

Use the outer gameplay page's actual rendered dimensions, not a second orientation service, the inner board area, or a device-model list.

`Gameplay.svelte` seeds the first layout from `Screen.mainScreen.widthDIPs/heightDIPs`. If that seed is degenerate, use a feature-local `DEFAULT_GAMEPLAY_LAYOUT` equal to the existing HPA-3 landscape grid; this is only an initial safe value, not a synthetic dimension. After mount, `layoutChanged` on the outer page grid supplies the ongoing size.

Measuring the outer page avoids feedback between toolbar height and the portrait/landscape decision. This also makes near-square Split View/window sizes deterministic.

The helper returns only distinct state:

```ts
type GameplayLayoutMode = 'landscape' | 'portrait';

interface GameplayLayout {
	mode: GameplayLayoutMode;
	rows: string;
	columns: string;
	trayRow: number;
	trayColumn: number;
}
```

`drawerMode` is derived at the call site from `mode === 'portrait'`; there is no separate `compactToolbar` bit.

Concrete constants stay local:

- landscape tray width: `320` DIPs, matching HPA-3;
- portrait collapsed tray height: `220` DIPs;
- portrait expanded tray height: `360` DIPs.

For later invalid/zero `layoutChanged` events, keep the last valid layout. Do not replace it with the default again.

## Native reflow gate comes first

The largest HPA-46 integration risk is whether Svelte Native updates runtime GridLayout row/column placement without remounting the existing Canvas/tray children.

Prove this before drawer or gesture work:

1. enable iPad portrait;
2. wire only the adaptive grid using `gameplayLayout.ts`;
3. rotate an active puzzle between portrait and landscape;
4. verify the same `PuzzleCanvas`, `PuzzleTray`, run, placement, and selected state survive.

If runtime row/column assignment remounts the children, stop there. Use the smallest imperative GridLayout property update on the same native views rather than create separate portrait markup.

## Portrait layout

Portrait uses the same child components with the tray below the board:

```text
+------------------------------------------------------+
| existing HPA-3 toolbar                              |
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

Portrait starts with the tray collapsed to `220` DIPs so the board remains primary while a useful piece row stays reachable.

A single `MORE PIECES` / `LESS PIECES` action toggles between `220` and `360` DIPs. Expansion changes only the GridLayout row height. It does not alter session state, tray membership/order, puzzle coordinates, or viewport persistence.

The expanded/collapsed choice is ephemeral. Rotating to landscape keeps it in memory; rotating back to portrait restores that in-memory choice. Do not persist it.

`PuzzleTray` keeps exactly the HPA-3 product surface: remaining count, All/Corners/Edges/Center, Shuffle, selected-piece Rotate, selection, and long-press drag.

## Existing toolbar first

HPA-46 does not plan a toolbar code change up front.

The existing toolbar and More/Reference menus must be exercised at the narrowest supported portrait condition used for acceptance. If every action is visible/reachable, keep the toolbar untouched.

If an actual label or menu clips, stop and revise the plan before adding toolbar code. The preferred correction is a single markup tree whose `rows`, `row`, and `col` values adapt from layout state. Do not add duplicate portrait/landscape bars or duplicate More menus.

## Surface metrics and resize cancellation

HPA-3 already has the pieces for Canvas sizing, but the "did the backing size really change?" decision should be pure and tested so routine `layoutChanged` events do not cancel a live pinch.

Extend `boardViewport.ts` with a small helper beside `backingSizeFromLayout` and `CanvasSurfaceMetrics`:

```ts
interface NextSurfaceMetrics {
  metrics: CanvasSurfaceMetrics;
  backingChanged: boolean;
}

nextSurfaceMetrics(
  layoutWidthDip: number,
  layoutHeightDip: number,
  density: number,
  previous: CanvasSurfaceMetrics | null
): NextSurfaceMetrics | null
```

The helper:

- returns `null` for non-renderable dimensions;
- rounds backing width/height exactly once, matching the Canvas assignment;
- reports `backingChanged: false` for the first valid layout because there is no stale pointer state yet;
- reports `false` when an identical-size `layoutChanged` fires again;
- reports `true` only when an established backing width or height actually changes.

Unit tests pin all three valid cases plus invalid input.

`PuzzleCanvas.syncSurface()` consumes this result. On `backingChanged` it clears only ephemeral two-pointer state (`gesture`, `transientViewport`, pointer slots/count) and does not call `onViewportCommit`. It then rebuilds from `sessionState.viewport`, not a stale transient frame.

This is intentionally narrower than an orientation service: a real surface resize is the event that invalidates gesture coordinates, regardless of why it happened.

## Tray drag cancellation on reflow

`PuzzleTray` has independent local `dragArmed` state. Reusing only the Canvas reset is insufficient if iOS swallows the tray's native `cancel` during rotation.

Expose one narrow `cancelActiveDrag()` method that reuses the existing cancel branch semantics:

- if no drag is armed, no-op;
- otherwise set `dragArmed = false` and invoke the existing `onPieceDragCancel()` callback.

`Gameplay.svelte` calls this when the outer page reports a real layout mode/size change that moves the gameplay surface. This clears both tray-local scrolling state and the parent full-screen drag overlay without inventing a gesture manager.

An in-flight drag or pinch is allowed to end during rotation. Gameplay/session state must survive.

## Orientation changes during an active run

An orientation/layout change is presentation-only.

`Gameplay.svelte` must not reconstruct `PuzzleSession`, dispatch `restart`, `start`, `pause`, `resume`, or `set_viewport`, or reload the persisted session because the screen size changed.

The same mounted gameplay tree preserves:

- `runId` and lifecycle/mode/time;
- placed pieces and counters;
- undo/redo history;
- selected piece;
- rotation state;
- tray filter/order;
- hint presentation;
- open setup/pause/discard/completion sheet where applicable.

Only in-flight native gesture state is canceled when the surface really changes.

## Viewport behavior across portrait/landscape

Keep the HPA-3 persisted viewport contract unchanged.

There are two different values with different ownership:

- `sessionState.viewport` = persisted user intent;
- `BoardTransform.viewport` = a clamped render echo for the current surface.

A portrait surface may clamp pan more tightly than landscape. That clamped echo must never be committed merely because the device rotated. Reusing the original persisted value when returning to landscape must recover the wider projection.

Extend `boardViewport.test.ts` only with the missing invariants:

1. `createBoardTransform()` does not mutate the caller's persisted viewport object;
2. landscape -> stricter portrait render clamp -> landscape again with the same input recovers the original wider pan.

Existing pan-clamp/fixed-point tests remain; do not restate them as a second broad cross-aspect suite.

## Cross-view drag after relayout

Keep HPA-3 drag geometry unchanged:

- tray gesture coordinates remain true screen DIPs;
- the full-bleed overlay remains owned by `Gameplay.svelte`;
- final drop still calls `PuzzleCanvas.cellAtScreenPoint()` using the Canvas's current on-screen origin and current surface metrics.

No portrait-specific drop math is needed.

## iOS orientation metadata

HPA-46 declares all four iPad orientations in `UISupportedInterfaceOrientations~ipad`: portrait, upside-down portrait, and both landscapes. The plist does not set `UIRequiresFullScreen`, so the app is eligible for iPad multitasking (Split View / Slide Over), which is what makes the outer-page window-size adaptivity in this design reachable at all. Omitting `UIInterfaceOrientationPortraitUpsideDown` would opt the app out of multitasking and contradict the adaptive-window premise.

Upside-down portrait needs no separate UX: the gameplay grid is driven by measured outer-page width/height, and upside-down portrait has the same dimensions as portrait, so it reuses the portrait layout. Leave the existing non-iPad orientation list alone; phone-sized UX remains out of scope.

## Testing strategy

### Mobile unit tests

`gameplayLayout.test.ts` pins:

- exported HPA-3 default landscape layout;
- landscape dimensions -> `*,320` right tray;
- portrait dimensions -> bottom tray;
- collapsed/expanded portrait heights (`220`/`360`);
- invalid/zero sizes -> `null`.

`boardViewport.test.ts` pins:

- `nextSurfaceMetrics`: first layout / identical refire / real resize / invalid input;
- persisted input is not mutated by render clamping;
- the same persisted viewport recovers its wider landscape pan after a stricter portrait projection.

No Svelte component-test framework is added.

### Native iPad smoke

Keep native acceptance small and staged.

**Reflow gate before later work:**

1. open an active puzzle in landscape;
2. rotate to portrait and back;
3. verify Canvas/tray instances do not remount/reset the run;
4. verify the existing toolbar and More/Reference menus remain reachable at the target portrait width.

**Final acceptance:**

1. launch/open or resume in portrait;
2. collapse/expand the bottom tray;
3. select/place a piece;
4. start and finish a pinch, rotate, then verify a fresh pinch works after rotation;
5. set a non-All filter, rotate to landscape, verify same run/filter/placement state;
6. rotate back and long-press drag one tray piece onto the board;
7. background/foreground once and verify HPA-3 timing/session behavior remains unchanged.

If practical, rotate during an active pinch/drag to confirm it cancels cleanly; this is additional evidence, not a requirement to preserve a finger gesture across rotation.

Do not add a broad native E2E framework.

### Verification commands

Run:

- `bun run --cwd apps/mobile test:unit` for the pure TypeScript tests;
- `bunx ns run ios --no-hmr --justlaunch` from `apps/mobile` for the actual native build/smoke.

Do not claim root `bun run check` validates HPA-46: `apps/mobile` currently has no `check` script and Turbo skips it. Do not add a new check/lint task solely for this ticket. The `.svelte` layout changes are verified through the native build/smoke, not a nonexistent automated Svelte checker.

## Risks and stop conditions

1. **Runtime GridLayout row/column reassignment** — prove first, before drawer/cancellation work. If children remount, stop and use the smallest imperative property update.
2. **False-positive resize cancellation** — pure `nextSurfaceMetrics` tests must prove identical `layoutChanged` events do not reset active pointers.
3. **Viewport persistence regression** — render-clamped `BoardTransform.viewport` must never replace `sessionState.viewport` because of relayout.
4. **Toolbar width** — measure before coding, at both full portrait width **and compact multitasking width** (Split View / Slide Over). The four-orientation plist without `UIRequiresFullScreen` makes compact window widths a supported runtime state, and the existing `auto,*,auto,auto,auto,auto,auto,auto` toolbar grid sizes `auto` tracks to content, so fixed actions can overflow a compact window even when full-width portrait fits. If an existing action clips at any supported width, stop and revise around one adaptive markup tree (single-tree row/column reflow) rather than a duplicate toolbar or opting out of multitasking.
5. **Tray height** — `220`/`360` are concrete starting values. Adjust only if native smoke shows one is unusable.
6. **Gesture cancellation during rotation** — canceling an in-flight gesture is acceptable. Gameplay/session state loss is not.

## Scope fence

HPA-46 excludes:

- phone-sized UI optimization;
- Android release/polish;
- new gameplay rules or mobile-only `PuzzleSession` actions;
- a second board/view model/coordinate system;
- per-orientation persisted viewport values;
- speculative compact-toolbar variants;
- draggable tray sizing;
- named/staging/manual tray organization;
- backend/API/D1/Workflow changes;
- Google login/account completion sync (HPA-4);
- achievements/leaderboards;
- generic responsive layout, toolbar, gesture, dialog, or state frameworks;
- a new native E2E framework;
- mobile build/check/lint infrastructure unrelated to the feature.

## Acceptance mapping

HPA-46 is complete when iPad advertises portrait support; the existing gameplay tree adapts between a right-side landscape tray and bottom portrait drawer without rebuilding the run; real Canvas resizes cancel only transient gesture state; the existing toolbar remains reachable in portrait or a separately reviewed single-tree reflow is added only if native measurement proves it necessary; orientation changes preserve gameplay state and reuse the persisted-vs-render-clamped viewport contract; canonical placement coordinates remain unchanged; and one focused native smoke covers portrait play plus live orientation changes without game-core/schema/backend/account/framework scope leaks.
