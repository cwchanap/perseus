# HPA-3 Landscape iPad Gameplay Design

**Date:** 2026-08-29
**Linear:** HPA-3 — [Perseus Mobile] Reach production landscape iPad gameplay parity
**Depends on:** HPA-2 (Done)

## Goal

Turn the proven NativeScript offline vertical slice into the real landscape-first iPad puzzle experience without creating a second gameplay architecture.

The mobile app should use the existing `@perseus/game-core` `PuzzleSession` for every gameplay rule, keep downloaded sessions fully local/offline, and add only the native rendering, touch interaction, and concrete tablet UI that HPA-3 needs.

## Current baseline

HPA-1 and HPA-2 are complete. Current `main` already has:

- one pure shared `@perseus/game-core` with `PuzzleSession`, history, hints, rotation, inventory filters, session codec, and file/browser storage adapters;
- one NativeScript app composition root in `apps/mobile/app/App.svelte`;
- explicit variant downloads with manifest-last finalization and a filesystem-derived Downloaded library;
- variant-scoped session files keyed by `ReadyPuzzle.id`;
- a working Canvas vertical slice with tap-piece/tap-cell placement and one-finger piece dragging;
- lifecycle checkpointing on NativeScript suspend/resume;
- the puzzle-family + Easy/Normal/Hard catalog model from PR #73.

The production gap is intentionally concentrated in `apps/mobile/app/gameplay`: the current `Gameplay.svelte` still auto-starts a run and presents debug labels, while `PuzzleCanvas.svelte` still renders a temporary in-canvas piece strip with a fixed fit-only viewport.

PR #73 changes the catalog identity but does not require a new HPA-3 persistence model. `DownloadManifestV1` already embeds the current `ReadyPuzzle`, including `familyId` and `difficulty`. Gameplay remains a concrete **variant** session keyed by `manifest.puzzle.id`; family and difficulty are display/catalog metadata.

## Delivery decision

Use one implementation PR for HPA-3. The planning branch created for this design becomes that implementation PR; do not create a second implementation PR.

### Recommended approach: concrete mobile feature components around `PuzzleSession`

Keep `Gameplay.svelte` as the composition/orchestration root and split only concrete product surfaces that have distinct responsibilities:

- `PuzzleCanvas.svelte` — board rendering, viewport transform, board gestures, coordinate conversion, reference rendering, and board feedback;
- `PuzzleTray.svelte` — the persistent right-side unplaced-piece tray, selection, cross-view drag events, filters, shuffle, and selected-piece Rotate action;
- `GameplayToolbar.svelte` — visible actions plus one concrete More row and one concrete Reference row;
- concrete setup/pause/discard/completion sheet components;
- a small pure `boardViewport.ts` for transform/clamp math;
- one small `PuzzleSession` action for persisting the viewport through the already-existing `viewport` field.

This reuses the engine and persistence boundaries already proven by HPA-1/HPA-2 while keeping native interaction concerns mobile-local.

### Rejected: keep all production behavior in `Gameplay.svelte` and `PuzzleCanvas.svelte`

This would initially create fewer files, but it would mix session lifecycle, menus/sheets, filters, cross-view drag ownership, Canvas gesture arbitration, transforms, reference drawing, and completion presentation in two already-growing files. The short-term file-count saving would make HPA-46 portrait work harder and testing less focused.

### Rejected: add a mobile gameplay controller/store or generic gesture/dialog framework

`PuzzleSession` is already the canonical gameplay controller. A second controller or Redux-style store would duplicate ownership and synchronization. Generic toolbar, dialog, gesture, or responsive-layout abstractions have no second mobile caller today and are explicitly outside HPA-3.

## Architecture and ownership

```text
App.svelte
  library/download ownership + screen switch
        |
        v
Gameplay.svelte
  session construction + dispatch orchestration
  ephemeral UI state + persistence checkpoints
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

Ownership rules:

| Concern | Owner |
| --- | --- |
| Placement validity, mode, timer, rotation, undo/redo, hint selection, reference mode, inventory filter/order, completion seal | `PuzzleSession` |
| Session serialization and validation | existing game-core codec |
| Download/package/session identity | concrete variant `puzzle.id` |
| Family/difficulty identity | existing `ReadyPuzzle` metadata; presentation only in HPA-3 |
| Viewport persisted value | `PuzzleSession.state.viewport` through one new action |
| Viewport fit/clamp/coordinate math | mobile `boardViewport.ts` |
| Gesture ownership and Canvas drawing | `PuzzleCanvas.svelte` |
| Cross-view tray drag | `PuzzleTray.svelte` + `Gameplay.svelte` coordinator |
| Dialog/sheet visibility and transient hint/rejection feedback | route-local state in `Gameplay.svelte` |

No backend, D1, Workflow, API route, auth, completion outbox, download-manifest version, or new global store is needed.

## Variant identity after puzzle families

A downloaded Easy/Normal/Hard variant is still one complete gameplay package. HPA-3 therefore keeps these invariants:

- session key: `manifest.puzzle.id`;
- asset paths: the existing installed variant paths;
- session validation: `sessionSpecFromManifest(manifest)`;
- display: puzzle family name plus `difficulty` and piece count;
- no session field for mutable difficulty;
- changing difficulty means leaving gameplay and opening/downloading another concrete variant.

No migration is required for HPA-2 manifests or session files.

## Landscape-only HPA-3 boundary

HPA-3 ships a concrete landscape tablet layout and temporarily advertises only the two iPad landscape orientations in `Info.plist`.

This is intentional pre-release scope control, not a reusable orientation policy. HPA-46 owns re-enabling portrait, adapting the layout, and preserving the same board/session state across orientation changes. iPhone optimization and Android release polish remain out of scope.

Landscape layout:

```text
+------------------------------------------------------------------+
| < LIBRARY | Puzzle · Difficulty | Timer | Undo Redo Hint Ref More |
+--------------------------------------------------+---------------+
|                                                  | PIECES  n left |
|                                                  | All Corn Edge |
|                 PUZZLE BOARD                     | Center Shuffle |
|                 native Canvas                    |               |
|                                                  | piece grid    |
|                                                  |               |
|                                                  | Rotate        |
+--------------------------------------------------+---------------+
```

The Canvas gets the flexible majority column. The tray is a fixed practical right column (no draggable divider), large enough for touch targets and piece thumbnails.

## Session entry and lifecycle

### New run

Starting a downloaded puzzle creates a fresh `PuzzleSession` in `setup` and shows a concrete setup sheet instead of immediately dispatching `start`.

The sheet exposes only:

- **Timed** / **Relaxed**;
- **Rotation Off** / **Rotation On**;
- **Start**;
- **Back to Library**.

On Start:

1. dispatch `configure_setup` with the chosen mode and rotation flag;
2. dispatch `start`;
3. persist immediately.

Do not add a separate mobile preference store in HPA-3. Restart can seed the sheet from the current run choices.

Fresh rotation-enabled sessions use the existing game-core production rotation generator. Remove the HPA-1 all-zero `createRotations` override.

### Resume

The existing Downloaded classifier remains authoritative.

- A resumable snapshot whose lifecycle is `active` restores active gameplay.
- A resumable snapshot whose lifecycle is `paused` remains paused and opens the Pause sheet. It is **not** automatically resumed.
- A sealed completed snapshot stays `protected` in Downloaded and does not expose Resume.
- Invalid progress remains owned by the existing Downloaded recovery actions.

### Explicit Pause

Pause dispatches `pause`, persists immediately, and opens a concrete Pause sheet. Resume dispatches `resume` and closes the sheet.

The Pause sheet owns Resume, Restart, Back to Library, and Discard Progress. Restart/Discard use their explicit confirmations where destructive state exists.

### Background / foreground

Backgrounding is not the same as explicit Pause.

On suspend:

1. call `session.setDocumentHidden(true)` first so the shared clock checkpoints and stops;
2. serialize and save the now-current state;
3. leave the UI sheet state unchanged.

On foreground, call `setDocumentHidden(false)`. Do not open the Pause sheet merely because the app was backgrounded. An explicitly paused session remains paused because the engine lifecycle is still `paused`.

### Restart

Restart is a new run, not an undo-all operation.

- If the run has user activity, require confirmation.
- Dispatch `restart`.
- Re-open the setup sheet seeded with the prior mode/rotation choices.
- The next Start runs `configure_setup` + `start` and persists immediately.
- Fresh state resets viewport to Fit (`viewport === null`) and filter to All through existing engine semantics.

### Discard

Discard confirms, calls the existing `SessionStorageAdapter.clearSession(puzzleId)`, and returns to Library only after a successful clear. Failure remains on the sheet with a small inline error; no generic error framework is introduced.

## Persisted viewport seam

The schema already contains optional `PersistedViewport { zoom, panX, panY }`, and the codec already validates and round-trips it. HPA-3 should not bypass `PuzzleSession` by mutating serialized snapshots directly.

Add exactly one engine action:

```ts
{ type: 'set_viewport'; viewport: PersistedViewport | null }
```

and outcomes:

```ts
{ type: 'viewport_changed'; viewport: PersistedViewport | null }
{ type: 'viewport_noop'; reason: 'invalid_viewport' }
```

The engine validates only that a non-null viewport contains finite numeric values, clones it, notifies subscribers, and does **not**:

- mark `hasUserActivity`;
- affect result class;
- enter undo/redo history;
- affect completion effects.

`null` means Fit/default and therefore serializes without the optional viewport field.

### Mobile viewport semantics

Mobile owns the policy:

- `zoom` is a multiplier over the current fit-to-viewport scale;
- allowed UI range is `1..4`;
- `panX` / `panY` are board-cell units, not device pixels;
- positive pan moves the board right/down;
- at `zoom === 1`, pan is normalized to `0,0`;
- at higher zoom, pan is clamped so the board cannot be dragged completely away from the viewport; an axis whose transformed board still fits remains centered.

Using board-cell units keeps the persisted value independent of display density and lets HPA-46 reuse it when viewport dimensions change. `boardViewport.ts` converts these values into Canvas pixels using the current fit cell size.

## Board gestures and coordinate flow

The Canvas has one transform pipeline for drawing and hit testing:

```text
canonical grid/cell
    -> fit board geometry
    -> persisted zoom + pan
    -> Canvas screen coordinate
```

Every pointer/gesture path uses the inverse transform before asking for a candidate board cell. Placement validity still dispatches exactly one `attempt_placement` action.

Gesture ownership:

- one-finger drag that begins on an unplaced tray piece = piece drag;
- pinch = board zoom;
- two-finger pan = board pan;
- double-tap empty/board area = Fit (`set_viewport(null)`);
- tap tray piece = select;
- tap board cell with a selection = attempt placement.

One-finger dragging on the Canvas never pans the board. This keeps piece placement and board navigation unambiguous.

Pinch zoom preserves the board point under the pinch center when possible, then clamps the result. Two-finger pan updates only the viewport. Viewport changes are persisted at gesture end, not on every movement frame.

## External tray and cross-view dragging

HPA-3 removes the temporary in-Canvas unplaced-piece strip. Unplaced pieces live only in `PuzzleTray.svelte`.

Tap placement stays simple:

1. tap tray piece -> `select_piece`;
2. tap Canvas board cell -> `attempt_placement`.

Cross-view drag uses a narrow concrete callback protocol rather than a drag service:

```ts
onPieceDragStart(pieceId, screenX, screenY)
onPieceDragMove(pieceId, screenX, screenY)
onPieceDragEnd(pieceId, screenX, screenY)
```

`Gameplay.svelte` owns the ephemeral dragged piece/coordinates. On drag end it asks the Canvas for the board cell at those screen coordinates and dispatches the same `attempt_placement` action used by tap placement.

- release outside the board: snap back, no gameplay dispatch, no incorrect-attempt count;
- engine rejection (`wrong_slot` / `non_upright`): snap back and show brief reject feedback;
- accepted placement: remove from tray projection and draw in canonical board location.

Do not persist drag coordinates.

## Tray behavior

The right tray exposes only the proven simple organization model:

- remaining-piece count;
- All / Corners / Edges / Center filters;
- Shuffle;
- selected-piece highlight;
- one selected-piece Rotate action when rotation mode is enabled.

Filter dispatches the existing `update_tray_organization -> set_filter` action. Shuffle creates a Fisher-Yates order for the current unplaced IDs and dispatches the existing `reorder` update with `trayId: 'main'`.

Mobile does not expose or deliberately mutate `activeTray`, manual membership, names, rename/remove, multi-select, or automatic clustering. The shared optional organization object remains tolerated because web already uses the same filter/reorder contract.

A successful hint uses the existing game-core `hint_target` event. Mobile stores the target only as ephemeral presentation state, resets the filter to All through the engine's existing hint behavior, highlights the hinted tray piece and target cell, and clears that highlight when the hinted piece is successfully placed or another hint replaces it.

## Toolbar and reference behavior

Keep the frequent controls visible:

- Library;
- Undo;
- Redo;
- Hint;
- Reference;
- More.

Show puzzle name, difficulty and timer in the same top area without creating a generic responsive toolbar component.

`More` expands one concrete row with exactly the lower-frequency HPA-3 actions:

- Fit Board;
- Rotation On/Off (engine availability rules still apply);
- Pause;
- Restart;
- Discard.

`Reference` expands one concrete reference row:

- **Hold to Peek** — touch down dispatches `set_reference_mode('hold')`, touch up/cancel dispatches `null`;
- **Toggle** — tap toggles `'toggle'` / `null`;
- **Ghost** — tap toggles `'ghost'` / `null`.

The optional downloaded reference image is loaded by `PuzzleCanvas.svelte` when present.

- ghost draws the reference behind puzzle pieces at low opacity;
- hold/toggle draw the reference as a stronger board overlay while keeping the puzzle visible;
- no reference asset means the Reference control is disabled/hidden with no network fallback.

Reference mode is runtime-only exactly as the current game-core contract defines; counters/facts remain engine-owned.

## Placement feedback

Keep feedback concrete and short-lived:

- accepted placement: brief green target-cell flash;
- rejected placement: brief red target-cell flash and selected/tray piece remains available;
- non-upright rejection uses the same red feedback; the Rotate action remains the correction path;
- hint target uses a distinct persistent outline until consumed/replaced.

No animation framework or sound system is introduced by HPA-3.

## Completion

When the engine emits/seals completion, persist the completed session and show a concrete native completion sheet projected from `SealedCompletion` plus the downloaded variant metadata.

Show:

- puzzle name and difficulty;
- Timed / Relaxed result label;
- elapsed time when timed;
- hints used;
- incorrect attempts;
- whether rotation was enabled/used;
- Back to Library.

Do not add cloud submission UI, achievements, leaderboard calls, completion outbox, authentication, or a second local completion database. The sealed session is already durable local completion state; Downloaded classifies it as `protected` and displays completed progress. Replaying requires the existing explicit Discard Progress action.

This deliberately leaves server submission/auth handling to HPA-4.

## Error handling

Keep errors at their owning surface:

- piece/reference load failure -> gameplay inline error and Library exit affordance;
- discard failure -> stay on discard sheet with inline message;
- session launch becoming invalid -> existing “return to Downloaded” path;
- missing reference asset -> simply no Reference controls;
- gesture release outside board -> no-op/snap back;
- invalid viewport action -> ignore the update and keep the last valid transform.

No generic error/result framework is added.

## Testing strategy

### Game-core focused tests

Add deterministic tests that prove:

- `set_viewport` clones and stores finite values;
- Fit (`null`) clears the value;
- viewport changes do not set user activity or alter undo/redo/result class;
- viewport survives the existing serializer/loader round trip;
- malformed non-finite values cannot enter state.

### Mobile pure tests

Keep most new logic outside the simulator:

- fit transform from grid + viewport dimensions;
- zoom clamping and pinch-center anchoring;
- pan clamping and screen <-> board/cell inverse transform;
- transform restoration from persisted viewport;
- filtered unplaced-piece projection and deterministic shuffle helper behavior.

Do not add a Svelte component test framework solely for HPA-3.

### iPad smoke

Use the existing NativeScript/iPad simulator path rather than introducing a broad native E2E framework.

One representative Easy variant is enough. Download it while the API is available, then remove network/API dependency and verify the production landscape UI can:

1. start a Timed or Relaxed run through setup;
2. tap-place and cross-view drag-place pieces;
3. pinch zoom, two-finger pan, and Fit;
4. persist/restore zoom and pan;
5. rotate a selected piece, filter/shuffle, use Hint and all three reference modes;
6. undo/redo;
7. explicitly pause/resume;
8. background/foreground without accruing hidden active time or opening an unwanted Pause sheet;
9. finish the puzzle offline and see the completion sheet;
10. return to Downloaded and see protected completed progress.

If reliable multi-touch injection is unavailable in the current NativeScript simulator tooling, record pinch/two-finger-pan as explicit manual acceptance evidence rather than adding a fragile automation framework. All pure transform/gesture math remains automated.

## Scope fence

HPA-3 does **not** include:

- portrait layout or live orientation switching (HPA-46);
- phone UI;
- Android release/polish;
- draggable tray sizing;
- named/staging trays or persisted manual tray organization;
- local-photo puzzle creation;
- Google login, cloud session sync, completion outbox/server retry, achievements, leaderboards, or account UI (HPA-4);
- backend/API/D1/Workflow/infrastructure changes;
- new download manifest or session schema version;
- a second gameplay controller/store;
- generic toolbar/dialog/gesture/responsive-layout frameworks;
- broad native E2E infrastructure.

## Acceptance mapping

HPA-3 is complete when:

- the iPad app is landscape-only for this release slice, with the Canvas owning the majority column and a persistent usable right tray;
- pinch, two-finger pan, Fit, tap placement and cross-view drag placement share one transform-aware placement path;
- Timed/Relaxed, rotation, undo/redo, hints, reference modes, filters/shuffle, pause/resume, restart/discard and completion are all driven through `PuzzleSession`;
- no manual tray-grouping feature is exposed or persisted by mobile;
- backgrounding stops active elapsed time without changing the explicit pause UI state;
- viewport state restores from the existing V1 optional viewport field through the new narrow engine action;
- a downloaded variant can be completed offline through the production landscape UI;
- focused game-core/mobile tests plus one small iPad landscape smoke provide the gate.