# Gameplay Flow and Puzzle Workspace Polish Design

**Status:** Approved direction for implementation

## Summary

This is one gameplay-polish task covering five related points of friction:

1. Restored Relaxed runs resume without `Resume Mission`.
2. Exit always saves and returns to the arcade; destructive deletion is a separate confirmed Discard action in gameplay and on the home page.
3. The desktop puzzle tray is wider by default and resizable, while board sizing and tray sizing use one shared layout contract.
4. Rotation-enabled runs receive a fresh orientation shuffle on setup/restart.
5. Hints clearly reveal the corresponding tray piece and keep the matching board destination highlighted until the hint is actually resolved or gameplay leaves the active flow.

The work reuses the current puzzle route, `PuzzleSession` lifecycle/actions, session storage adapter, `puzzleLayout.ts`, gameplay runtime factory, inventory panel, gallery progress discovery, and existing tests. It does not add a session schema, split-pane framework, saved-progress store, new RNG, or hint-selection algorithm.

## Goals

- Preserve explicit player-controlled resume for restored Timed runs.
- Enter restored Relaxed active/paused runs directly into active gameplay.
- Make Exit a single non-destructive operation: settle, save, and navigate home.
- Keep Discard explicit, confirmed, and available only from Pause/Resume and the home Continue panel.
- Make the desktop tray visibly wider than the old layout for the current puzzle, with dragging/keyboard resizing that reduces tray scrolling and shows more pieces at once.
- Keep piece preview size tied to board cell size; this task does **not** introduce independently scalable tray thumbnails.
- Keep board metrics and tray width coherent as the player resizes the split.
- Randomize initial orientation per configured run without changing the existing runtime interface or deterministic E2E override.
- Keep a hint active through rejected placement attempts; clear it only after the hinted piece is successfully placed, another hint replaces it, or lifecycle cleanup occurs.
- Reveal the hinted tray piece after the drawer/filter DOM has rendered, without stealing focus or selecting it.

## Non-Goals

- Persisting tray width across reloads, puzzles, or devices.
- Resizing the mobile bottom drawer.
- Larger independent tray thumbnails or a tray zoom control.
- A generic splitter/resizable-pane package or component.
- New `PuzzleSessionState`, actions/events, persistence schema/version, or lifecycle rules.
- A new saved-progress store or server-side progress deletion API.
- Discard controls on every puzzle card.
- Changing which piece `getHintPieceId` chooses.
- Automatically selecting, rotating, or placing hinted pieces.
- A broad visual redesign.

## Current Behavior and Reuse

### Restore and Exit

The route currently pauses every restored active run and presents both active/paused restores through `SessionPauseDialog`. Exit uses `ExitSessionDialog` to offer Cancel, Discard, and Save & Exit.

The new flow stays route-local. `PuzzleSession` remains the lifecycle authority.

### Tray and Board Layout

Today `puzzleLayout.ts` contains the desktop board↔tray assumption:

- `DESKTOP_SIDE_PANEL_COLUMNS = 3`
- `DESKTOP_LAYOUT_RESERVE = 88`
- `desktopWidthCap = (viewportWidthCap - reserve) / (1 + 3 / gridCols)`

The CSS mirrors that model with a tray width based on three `--piece-slot-size` columns. A free `--tray-width` cannot be added without removing the old circular board-width solve; otherwise the board and CSS reserve two different side-panel widths.

`PuzzleBoardPanel` already recomputes fit bounds on viewport resize. No new board controller is required.

### Rotation

`generateRandomRotations(ids, seed?)` already uses `Math.random` when `seed` is omitted. Production only needs to stop supplying the puzzle-derived seed. The virtual runtime override remains unchanged.

### Hints

`PuzzleSession` already owns hint selection and resets the filter to All. The route owns `activeHintPieceId` / `activeHintTarget`. The inventory already has drawer state, a scroll container, roving `activePieceId`, and hinted-over-rejected styling precedence.

The current route clears a hint before dispatching `attempt_placement`, so a rejected attempt on the hinted piece incorrectly consumes the visible hint. That must move to the successful-placement event path.

## Product Behavior

### 1. Continue and Restore

| Restored state | Entry behavior |
| --- | --- |
| Timed + active | Dispatch `pause`, checkpoint, show `Resume Mission`. |
| Timed + paused | Keep paused, show `Resume Mission`. |
| Relaxed + active | Keep active, no popup. |
| Relaxed + paused | Dispatch `resume`, checkpoint, no popup. |
| Setup | Keep mandatory Mission Setup. |
| Completed | Keep current completion restoration. |

Manual Pause is unchanged for both modes.

### 2. Exit and Discard

Exit always:

1. Clears route-local transient gameplay presentation.
2. If active, dispatches the existing `pause`.
3. Flushes/checkpoints the live session through the existing persistence path.
4. Navigates to `/`.

There is no Exit confirmation and no Save-vs-Discard choice.

`SessionPauseDialog` exposes `Discard` on both `Mission Paused` and `Resume Mission`. It opens one reusable `DiscardSessionDialog`. Cancel returns to the exact prior pause presentation without changing `pausePresentation`.

Confirming gameplay discard preserves the existing defensive order:

1. Stop periodic checkpointing.
2. Dispose the live session.
3. Clear the route session reference.
4. `clearSession(puzzle.id)`.
5. Navigate home.

This keeps the existing unmount-after-discard regression closed.

The home Continue panel exposes the same confirmed Discard action. Home clears through the session storage adapter and recomputes through `discoverGalleryProgress()`.

### 3. Desktop Tray and Board Contract

`puzzleLayout.ts` becomes the single owner of desktop split constants and arithmetic.

Export:

```ts
export const DESKTOP_TRAY_MIN_WIDTH = 300;
export const DESKTOP_TRAY_BASE_WIDTH = 360;
export const DESKTOP_BOARD_MIN_WIDTH = 480;
export const DESKTOP_TRAY_SEPARATOR_WIDTH = 20;
```

Keep the existing three-column visual baseline only for **initial tray width**, not for board width solving.

Add:

```ts
export function getDefaultPuzzleTrayWidth(
  puzzle: PuzzleBoardSource,
  viewport: PuzzleViewportSize
): number;
```

It derives the preferred board width **without** a side-panel circular solve, derives a preferred cell size, then returns at least `360px` and at least the current three-column tray footprint. This ensures the new default does not narrow coarse-grid puzzles while making dense puzzles (for example 15×15) wider than the old 17.5rem minimum.

The goal is **more visible pieces / less tray scrolling**, not larger independent thumbnails. `--piece-slot-size` remains board-cell-derived.

Add:

```ts
export function clampTrayWidth(layoutWidth: number, requestedWidth: number): number;
```

It clamps to:

```text
min = 300
max = max(300, layoutWidth - 480 - 20)
```

If a synthetic measured layout cannot fit 300 + 480 + 20, the tray minimum wins. The desktop breakpoint normally keeps production layouts outside this conflict.

Change board metrics to use the actual applied tray width:

```ts
getResponsivePuzzleBoardMetrics(puzzle, viewport, trayWidth)
```

For desktop tiers:

```text
desktopWidthCap = max(
  minimum board pixel width,
  viewportWidthCap - trayWidth - DESKTOP_TRAY_SEPARATOR_WIDTH
)
```

Delete `DESKTOP_SIDE_PANEL_COLUMNS`, `DESKTOP_LAYOUT_RESERVE`, and the `1 + 3 / gridCols` circular solve.

The route owns:

- `requestedTrayWidth`: the player's preference for the current puzzle.
- measured `gameLayoutWidth`.
- `appliedTrayWidth`: projection of `requestedTrayWidth` through `clampTrayWidth`.
- pointer/keyboard interaction state.

Clamping does **not** overwrite `requestedTrayWidth`. If the viewport shrinks and then grows, the applied tray returns to the player's prior request.

On puzzle load, `requestedTrayWidth` resets to `getDefaultPuzzleTrayWidth(...)`.

The route passes `appliedTrayWidth` to `getResponsivePuzzleBoardMetrics(...)` and always emits:

```css
--tray-width: <applied width>;
```

outside the `currentBoardMetrics ? ... : ''` conditional so the split width exists before board metrics are ready.

Pointer behavior composes with the route's current global Hold-to-Peek cleanup:

- add only a new window `pointermove`;
- extend the existing capture-phase `pointerup` / `pointercancel`;
- extend existing blur cleanup;
- ignore non-matching pointer IDs;
- no pointer capture.

Below 1024px the separator is hidden and non-interactive.

### 4. Rotation Shuffle

Keep `createRotations(puzzleId, pieceIds)` unchanged.

Production `buildRotations`:

```ts
function buildRotations(
  _puzzleId: string,
  pieceIds: readonly number[]
): Record<number, Rotation> {
  const rotations = generateRandomRotations([...pieceIds]);

  if (pieceIds.length > 0 && pieceIds.every((id) => rotations[id] === 0)) {
    rotations[pieceIds[0]!] = 90;
  }

  return rotations;
}
```

No local hash/seed. No extra clone: `generateRandomRotations` already creates a fresh record and the session validates/clones factory output at its boundary.

### 5. Hint Relationship and Lifetime

A hint keeps the existing piece choice, filter reset, target event, counter semantics, and announcement.

Presentation:

- tray slot uses `--gold` / `--gold-glow`;
- visible non-interactive `HINT` badge;
- board target uses the same gold visual language;
- collapsed mobile drawer opens;
- hinted piece becomes the inventory roving candidate;
- no `.focus()`, `onSelect`, `onRotate`, or placement callback.

Reveal must happen **after DOM update**:

1. set `drawerOpen = true`;
2. set `activePieceId = pieceId`;
3. `await tick()`;
4. confirm `activeHintPieceId` still matches;
5. call `scrollIntoView({ block: 'nearest', inline: 'nearest' })`.

Hint lifetime:

- `handlePiecePlaced` no longer clears the hint before `attempt_placement`.
- `placement_rejected` leaves the hint intact.
- `placement_accepted` clears the hint when `event.pieceId === activeHintPieceId`.
- another `hint_target` replaces it;
- Pause/Exit/Restart/Discard/navigation/teardown clear it through existing transient cleanup.
- Undo/Redo and selection alone do not clear it.

Remove `HINT_DURATION_MS`, `hintTimeout`, and all timeout scheduling/cleanup.

Update `docs/PRD.md` in the implementation PR so the 1.8-second wording and seeded-rotation wording do not contradict the shipped behavior.

## Architecture and Ownership

- **Puzzle route:** restore/exit/discard orchestration, requested tray width, measured layout width, splitter pointer/keyboard state, hint lifetime.
- **`puzzleLayout.ts`:** desktop split constants, default tray width, pure clamp, board metrics with actual tray reservation.
- **`SessionPauseDialog` / `DiscardSessionDialog`:** presentation only.
- **Home route:** discard target + existing storage/discovery calls.
- **Gameplay runtime:** production orientation generation.
- **Inventory:** drawer/render/scroll reveal.
- **Board:** target styling only.

## Accessibility

- Timed restore keeps explicit resume.
- Relaxed restore removes an unnecessary modal.
- Discard dialog keeps the existing full-screen scrim, `modalFocus`, Escape cancellation, safe-area padding, and `aria-modal`.
- Home/gameplay underlay is inert while confirming.
- Separator has `role="separator"`, vertical orientation, keyboard Arrow/Home/End behavior, and coherent numeric ARIA values based on **applied** width.
- Hint has both visual badge and existing live announcement; reveal never steals focus.

## Risks and Mitigations

### Board/tray sizing drift

**Risk:** CSS tray width and board metrics reserve different widths, creating dead board space or unnecessary downscaling.

**Mitigation:** delete the old three-column board solve, pass the applied tray width into `getResponsivePuzzleBoardMetrics`, and test board width changes as tray width changes.

### Default tray regression on coarse puzzles

**Risk:** a fixed 360px default can be narrower than today's three-column tray when puzzle pieces are large.

**Mitigation:** derive initial requested width from the larger of 360px and the old three-column visual footprint. Keep slot size board-derived; the feature goal is reduced scrolling, not larger thumbnails.

### Requested width lost on viewport shrink

**Risk:** mutating stored width during clamp causes a temporary narrow viewport to permanently overwrite the player's chosen width.

**Mitigation:** store `requestedTrayWidth` and derive `appliedTrayWidth`; test shrink → re-widen restores the request.

### Hint reveal before drawer render

**Risk:** synchronous `scrollIntoView` on a `display:none` drawer is a no-op.

**Mitigation:** `await tick()` and test that the inventory body is visible when scroll is invoked.

### Hint consumed by rejection

**Risk:** clearing before placement dispatch removes a paid hint on an incorrect attempt.

**Mitigation:** clear only from `placement_accepted`; add rejection-retains-hint coverage.

### Splitter integration coverage

**Risk:** pointer-ID splitter logic can regress without running in the default E2E gate.

**Mitigation:** put one `@smoke` desktop-only resizer/hint test **outside** the `@extended` describe so both `test:e2e` (`--grep-invert @extended`) and the smoke gate can select it.

## Testing Strategy

### Unit / browser tests

- `SessionDialogs.svelte.test.ts`: migrate old Exit dialog tests; full scrim, Escape, confirm/cancel, Pause Discard callback.
- Puzzle route tests: full restore table, migrate all five old Exit contracts, preserve discard-unmount regression, remove dead `resumableState`/`isResumable` test plumbing, hint rejection retention, successful-placement clearing.
- `puzzleLayout.test.ts`: default tray width dense/coarse cases, clamp min/max/conflict, board width reservation using actual tray width.
- Route layout tests: requested-vs-applied width, keyboard/pointer IDs, shrink/re-widen restoration, mobile hidden separator, Hold-to-Peek regression.
- Inventory tests: `tick`-ordered reveal, drawer visible at scroll time, badge/gold styling state, roving update without focus/select.
- Home tests: Discard, inert `<main>`, cancel, clear, rediscovery.
- `runtime.test.ts`: mocked fresh calls and all-upright bump; no clone-artifact test.

### E2E

- `gameplay-session-controls.spec.ts`: Relaxed restore no popup, Timed restore popup, direct Exit, Pause Discard.
- `gameplay-large-fixtures.spec.ts`: keep the existing extended suite; add a **separate, non-`@extended` `@smoke` test** outside that describe, desktop-only via `test.skip`, using `IMMEDIATE_START` and a 100-piece fixture to exercise splitter drag plus offscreen hint reveal.

## Acceptance Criteria

1. Restored Relaxed active/paused runs enter gameplay without `Resume Mission`.
2. Restored Timed active/paused runs still show `Resume Mission`.
3. All existing Exit entry points save and return home without an Exit-choice dialog.
4. Pause/Resume exposes confirmed Discard; cancel returns to the exact prior presentation.
5. Gameplay discard cannot be undone by teardown re-saving the cleared snapshot.
6. Home Continue exposes confirmed Discard and makes the underlying `<main>` inert.
7. Desktop initial tray width is never narrower than the new 360px baseline or the prior three-column footprint for that puzzle/viewport.
8. Tray resizing reduces scrolling by showing more board-cell-sized pieces; this task does not independently enlarge thumbnails.
9. Board metrics reserve the **applied** tray width and no longer use the old `1 + 3/gridCols` solve.
10. A temporary layout shrink does not overwrite requested tray width; re-widening restores the player's requested width.
11. Separator pointer/keyboard interaction preserves Hold-to-Peek cleanup and is hidden on mobile.
12. Rotation-enabled setup/restart gets a fresh orientation mapping; restored sessions retain persisted rotations; non-empty generated mappings are not all upright.
13. Rejected placement of the hinted piece keeps the hint.
14. Successful placement of the hinted piece clears it.
15. Hint reveal occurs after the drawer/filter DOM update, scrolls the piece into view, and does not focus/select it.
16. The default automated E2E gate runs the desktop splitter/hint smoke path.
17. `docs/PRD.md` reflects persistent hint lifetime and fresh per-run rotation initialization.
