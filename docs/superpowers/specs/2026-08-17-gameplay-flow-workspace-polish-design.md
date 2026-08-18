# Gameplay Flow and Puzzle Workspace Polish Design

**Status:** Approved direction for implementation

## Summary

This change is one small gameplay-polish task covering five related points of friction in the existing puzzle experience:

1. Continuing a Relaxed run should resume immediately instead of opening the Resume Mission dialog.
2. Exit should always save and return to the arcade without an exit-choice popup; destructive deletion moves to an explicit Discard action in gameplay and on the home page.
3. The desktop puzzle tray should start wider and be resizable with a divider between the board and tray.
4. Rotation-enabled runs should receive newly shuffled piece orientations when a run starts or restarts.
5. A hint should make the corresponding tray piece unmistakable and bring it into view while retaining the matching board destination highlight.

The work deliberately reuses the current route-owned session orchestration, `PuzzleSession` actions, session storage adapter, gameplay runtime factories, inventory panel, and gallery progress discovery. It does not introduce a new layout framework, saved-progress store, session schema, or hint algorithm.

## Current Behavior

The puzzle route currently treats every restored active or paused session the same: it pauses active sessions and opens `SessionPauseDialog` with the `resume` presentation. This protects Timed runs from silently resuming, but adds unnecessary friction to Relaxed runs.

Exit is currently modeled as a choice dialog. `requestReturnToArcade()` opens `ExitSessionDialog` for resumable sessions, and that dialog offers Cancel, Discard, and Save & Exit. The result is that a safe action—leaving after saving—requires confirmation, while the destructive action is coupled to Exit rather than presented independently.

The desktop `.game-layout` uses a fixed board-plus-sidebar grid. The tray has a minimum width derived from three piece columns, but the player cannot allocate more room to piece inspection.

The gameplay runtime already owns rotation generation through `createRotations`. Production currently derives a deterministic seed from puzzle identity, so the same puzzle and piece list receive the same orientations on each run. E2E can override the runtime for deterministic tests.

Hints already contain the exact piece ID and target coordinates. The session resets the inventory filter to All, the route passes the piece ID to `PuzzleInventoryPanel`, and the board receives the target cell. The remaining usability problem is presentation: the piece may be outside the tray scroll position or behind the collapsed mobile drawer, the tray treatment is easy to miss, and the route clears the hint after 1.8 seconds.

## Goals

- Preserve explicit resume for restored Timed runs while making restored Relaxed runs enter active gameplay immediately.
- Make Exit a consistent, non-destructive action: checkpoint, save, and navigate home with no choice dialog.
- Keep Discard explicit, confirmed, and available from both the gameplay Pause/Resume surface and the home page’s current Continue panel.
- Improve desktop piece inspection with a wider default tray and a pointer- and keyboard-resizable divider.
- Generate fresh valid orientations for each newly configured rotation-enabled run while preserving restored orientations and deterministic E2E overrides.
- Make a hint visibly connect one tray piece to one board destination and ensure the piece is revealed without changing selection or focus.

## Non-Goals

- Persisting tray width across reloads, routes, or devices.
- Resizing the mobile bottom drawer.
- Adding a generic split-pane or resizable-panel component.
- Changing `PuzzleSessionState`, persistence schema/version, lifecycle transition rules, or completion sealing.
- Adding a server-side saved-progress API.
- Adding Discard controls to every puzzle card; the home action belongs to the existing Continue on this device panel.
- Changing which piece the hint algorithm chooses.
- Automatically selecting, rotating, or placing a hinted piece.
- Broad visual redesign of the Pause dialog, home page, board, or inventory.

## Product Behavior

### 1. Continue and Restore

Route entry distinguishes restored runs by mode and lifecycle.

| Restored state | Entry behavior |
| --- | --- |
| Timed + active | Dispatch `pause`, checkpoint, and show `Resume Mission`. |
| Timed + paused | Keep paused and show `Resume Mission`. |
| Relaxed + active | Keep active and show no popup. |
| Relaxed + paused | Dispatch `resume`, checkpoint, and show no popup. |
| Setup | Keep the mandatory Mission Setup dialog. |
| Completed | Keep the existing completion dialog restoration. |

This is a route-entry presentation policy in `apps/web/src/routes/puzzle/[id]/+page.svelte`. `PuzzleSession` remains the canonical lifecycle owner and requires no new action.

Manual Pause remains unchanged for both Timed and Relaxed play. A player who presses Pause still sees `Mission Paused` and can Resume, Restart, Exit, or Discard.

### 2. Exit and Discard

Exit has one meaning everywhere: save the current state and return to the arcade.

Before navigation, the route:

1. Clears route-local transient gameplay presentation such as selection, hint, and rejection animation.
2. Pauses an active session so the timer is stopped and the saved lifecycle is stable.
3. Flushes the session clock and saves the latest serialized snapshot through the existing storage adapter.
4. Navigates to `/`.

No Exit confirmation is shown. This behavior applies to:

- The header Arcade/back action.
- Return to Arcade from mandatory Mission Setup.
- Exit from `SessionPauseDialog`.
- Back to Arcade from completion.

Discard becomes a separate destructive flow:

- `SessionPauseDialog` exposes a `Discard` button on both paused and resume presentations.
- Pressing it opens a focused `DiscardSessionDialog`.
- Cancel returns to the same Pause/Resume presentation without resuming or mutating the run.
- Confirm stops checkpointing, disposes the live session, clears the puzzle’s persisted session, and navigates home.
- The home page’s Continue on this device panel exposes `Discard` beside `Continue`.
- Home confirmation clears that puzzle’s persisted session and immediately reruns gallery progress discovery so the panel disappears or switches to the next newest resumable run.

`ExitSessionDialog.svelte` is removed and replaced by a reusable discard-only dialog. The dialog keeps the repository’s existing `modalFocus`, Escape-to-cancel behavior, `aria-modal`, and safe-area layout.

### 3. Wider, Resizable Desktop Tray

At the existing desktop breakpoint (`min-width: 1024px`), the layout becomes three columns:

```text
minmax(0, 1fr) | resize separator | tray width
```

Initial values:

- Default tray width: `360px`.
- Minimum tray width: `300px`.
- Minimum board column width: `480px`.
- Separator hit area: `20px`.
- Keyboard resize step: `16px`.

The maximum tray width is derived from the current `.game-layout` width after reserving the minimum board width and separator. The route reclamps the width when the viewport changes.

Pointer behavior:

- Pointer down on the separator records the pointer ID, starting X coordinate, and starting tray width.
- Moving left increases the right-hand tray width; moving right decreases it.
- Window pointer up, pointer cancel, or blur ends resizing.
- Width changes are route-local presentation state and are not serialized.

Keyboard behavior:

- `ArrowLeft`: widen the tray by one step.
- `ArrowRight`: narrow the tray by one step.
- `Home`: set the minimum tray width.
- `End`: set the current maximum tray width.

The separator uses `role="separator"`, `aria-orientation="vertical"`, an accessible label, and `aria-valuemin`, `aria-valuemax`, and `aria-valuenow` based on tray width.

Below `1024px`, the separator is not rendered for interaction and the existing mobile board plus collapsible bottom inventory layout remains unchanged.

`PuzzleBoardPanel` already observes its viewport with `ResizeObserver` and recomputes fit zoom, so the layout resize does not require a new callback or changes to `puzzleLayout.ts`.

### 4. Fresh Rotation Shuffle

The existing `createRotations(puzzleId, pieceIds)` runtime interface remains unchanged. Production changes only its implementation:

- Call `generateRandomRotations([...pieceIds])` without the puzzle-derived deterministic seed.
- Return one valid `0 | 90 | 180 | 270` entry for every requested piece.
- When at least one piece exists and the random result is entirely `0`, set the first requested piece to `90` so rotation-enabled play is visibly scrambled.
- Return a cloned record so callers cannot mutate retained generator output.

`PuzzleSession` already invokes this factory when setup is configured with rotation enabled and after Restart is followed by setup configuration. It restores persisted `pieceRotations` without regenerating them, so no session or persistence changes are needed.

The virtual gameplay runtime override remains authoritative for E2E. Production randomness is tested with a mocked rotation generator rather than probabilistic assertions.

### 5. Clear Hint Relationship

A successful hint continues to use the existing `hint_target` event, piece ID, target coordinates, filter reset, and live-region announcement. Presentation changes as follows:

- The matching inventory slot receives a strong gold outline/glow and a visible non-interactive `HINT` badge.
- The board target uses the same gold visual language.
- On mobile, a hint opens the collapsed inventory drawer.
- After the drawer and filtered piece list render, the inventory scrolls the hinted slot into view with `scrollIntoView({ block: 'nearest', inline: 'nearest' })`.
- The hinted piece becomes the inventory’s roving tab-stop candidate, but the implementation does not call `.focus()` and does not invoke `onSelect`.
- The hint remains active until the hinted piece is successfully placed, another hint replaces it, or transient gameplay state is cleared by Pause, Exit, Restart, Discard, puzzle navigation, or teardown.
- Selection alone does not clear the hint, because the player still needs the board destination while placing the selected piece.

The route removes the 1.8-second hint timeout and retains only `activeHintPieceId` plus `activeHintTarget` as route-local presentation state.

## Architecture and Ownership

### Puzzle route

`apps/web/src/routes/puzzle/[id]/+page.svelte` remains the orchestration boundary for:

- Restored-entry policy.
- Direct save-and-exit composition.
- Opening and confirming gameplay discard.
- Route-local tray width and resize interaction.
- Hint lifetime.

No new route store, context, action, or service is introduced.

### Dialog components

`SessionPauseDialog.svelte` adds one callback, `onDiscard`, and one button. `DiscardSessionDialog.svelte` owns destructive confirmation presentation and is reused by gameplay and home page callers.

### Home page

`apps/web/src/routes/+page.svelte` owns the currently selected discard target. It clears the session through `createSessionStorageAdapter()` and reuses `discoverGalleryProgress()` to recompute the Continue panel. It does not become a second authority for session validation.

### Gameplay runtime

`apps/web/src/lib/services/gameplay/runtime.ts` remains the sole production factory for initial tray order, restart tray order, run IDs, and orientations. Randomness does not enter `PuzzleSession` directly.

### Inventory and board

`PuzzleInventoryPanel.svelte` owns drawer opening and DOM reveal for the hinted piece because it owns the scroll container and slot elements. `PuzzleBoard.svelte` only aligns the target styling; it does not gain hint selection logic.

## Error Handling

- Existing session serialization and storage fallback behavior remain authoritative. Exit does not add a second persistence mechanism.
- Discard confirmation is idempotent from the user’s perspective: clearing an already-missing session still closes the dialog and refreshes home state or navigates away.
- A missing hint slot after rendering is a no-op; the session filter reset and normal rerender may resolve it on the next hint. The implementation must not throw or steal focus.
- Tray width clamping handles zero or temporarily unavailable layout measurements by retaining the current width until a positive layout width is available.
- Pointer events unrelated to the active separator pointer ID are ignored.

## Accessibility

- Timed restore keeps explicit player-controlled resume, while Relaxed restore removes an unnecessary modal.
- The discard dialog traps focus and supports Escape cancellation.
- Home content and gameplay content are inert while discard confirmation is open.
- The resizer is keyboard operable and exposes its numeric width through separator ARIA values.
- Hint styling is not the only cue: the visible `HINT` badge and existing live announcement identify the exact piece and target coordinates.
- Hint reveal changes scrolling and roving state but never forces keyboard focus.
- Reduced-motion behavior remains unchanged; no required animation is added.

## Testing Strategy

### Vitest browser tests

- `SessionDialogs.svelte.test.ts`: Pause forwards Discard; discard confirmation forwards confirm/cancel and handles Escape/focus.
- Puzzle route test: restored Relaxed active/paused sessions bypass Resume Mission; restored Timed sessions retain it; Exit saves and navigates without Exit Mission; gameplay discard cancel and confirm preserve/delete as expected; tray separator pointer/keyboard behavior and mobile absence; hint lifetime and cleanup.
- `PuzzleInventoryPanel.svelte.test.ts`: hint opens the drawer, marks the slot, adds the badge, calls `scrollIntoView`, moves the roving candidate without focusing or selecting, and preserves hinted-over-rejected precedence.
- Home route test: Continue panel renders Discard; cancel preserves progress; confirm clears the target and reruns discovery.
- `runtime.test.ts`: production rotation factory calls the generator on each request, returns valid mappings, corrects an all-upright mapping, and leaves the virtual override path unchanged.

### Playwright

Extend existing gameplay specs rather than creating a new fixture family:

- Restored Relaxed entry shows no Resume Mission dialog.
- Restored Timed entry still requires Resume.
- Exit from gameplay persists and returns to the arcade without an Exit Mission dialog.
- Discard from Pause removes persisted progress.
- Desktop separator drag changes tray width while keeping board and tray usable.
- Hint reveals and visibly marks the corresponding tray slot and board target.

## Acceptance Criteria

1. Continuing a restored Relaxed active or paused run enters gameplay without a Resume popup.
2. Continuing a restored Timed active or paused run still shows Resume Mission.
3. Exit from every existing gameplay exit entry point saves and returns home without an Exit Mission popup.
4. The Pause/Resume surface exposes Discard, which requires confirmation.
5. Canceling gameplay discard returns to the same Pause/Resume presentation with progress intact.
6. Confirming gameplay discard clears persisted progress and returns home.
7. The home Continue panel exposes Discard and refreshes immediately after confirmation.
8. The desktop tray defaults to `360px`, remains at least `300px`, and cannot reduce the board column below `480px`.
9. The separator works with pointer drag and Arrow/Home/End keys and is absent from the mobile layout.
10. Each newly configured or restarted rotation-enabled run requests a fresh orientation mapping.
11. Restored runs retain their persisted orientations.
12. A non-empty rotation-enabled run never starts with every piece upright.
13. A hint opens/reveals and strongly marks the matching tray piece without selecting or focusing it.
14. The matching board target uses the same visual cue.
15. The hint remains until placement, replacement, or lifecycle cleanup.