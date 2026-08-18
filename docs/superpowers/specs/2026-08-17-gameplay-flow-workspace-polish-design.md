# Gameplay Flow and Puzzle Workspace Polish Design

**Status:** Approved direction for implementation

## Summary

This is one gameplay-polish task covering five related points of friction in the existing puzzle experience:

1. Continuing a Relaxed run resumes immediately instead of opening `Resume Mission`.
2. Exit always saves and returns to the arcade without an exit-choice popup; destructive deletion moves to an explicit confirmed Discard action in gameplay and on the home page.
3. The desktop puzzle tray starts wider and can be resized with a divider between the board and tray.
4. Rotation-enabled runs receive newly shuffled piece orientations when a run starts or restarts.
5. A hint makes the corresponding tray piece unmistakable, reveals it in the tray, and keeps the matching board destination highlighted until the hint is no longer relevant.

The work reuses the current route-owned session orchestration, `PuzzleSession` lifecycle/actions, session storage adapter, gameplay runtime factory, inventory panel, gallery progress discovery, and existing browser/E2E suites. It does not introduce a new session schema, split-pane framework, saved-progress store, or hint algorithm.

## Current Behavior

The puzzle route currently treats every restored active or paused session the same: active sessions are paused and both active/paused restores open `SessionPauseDialog` with the `resume` presentation. This protects Timed runs from silently resuming, but adds unnecessary friction to Relaxed runs.

Exit is currently modeled as a choice dialog. `requestReturnToArcade()` opens `ExitSessionDialog` for resumable sessions, and that dialog offers Cancel, Discard, and Save & Exit. Safe navigation therefore requires another decision while the destructive action is coupled to Exit.

The desktop `.game-layout` is a fixed two-column grid. The tray width is derived from three piece columns and cannot be adjusted by the player.

The gameplay runtime already owns orientation generation through `createRotations(puzzleId, pieceIds)`. Production currently derives a deterministic seed from puzzle identity, so the same puzzle and piece list receive the same orientations on every configured run.

Hints already carry the exact piece ID and target coordinates. `PuzzleSession` resets the inventory filter to All, the route exposes the hinted piece ID, and the board highlights the destination. The remaining problem is presentation: the piece can be outside the tray viewport or behind the collapsed mobile drawer, the tray treatment is easy to miss, and the route clears the hint after 1.8 seconds.

## Goals

- Preserve explicit resume for restored Timed runs while making restored Relaxed runs enter active gameplay immediately.
- Make Exit a consistent non-destructive action: settle the live run, checkpoint/save it, and navigate home with no choice dialog.
- Keep Discard explicit, confirmed, and available from both the Pause/Resume surface and the home page Continue panel.
- Improve desktop piece inspection with a wider default tray and a pointer- and keyboard-resizable divider.
- Generate a fresh valid orientation mapping for each newly configured rotation-enabled run while preserving restored orientations and deterministic E2E overrides.
- Make a hint visibly connect one tray piece to one board destination and reveal the tray piece without changing selection or focus.

## Non-Goals

- Persisting tray width across reloads, routes, or devices.
- Resizing the mobile bottom drawer.
- Adding a generic split-pane or resizable-panel package/component.
- Changing `PuzzleSessionState`, session actions/events, persistence schema/version, lifecycle rules, completion sealing, or gallery validation rules.
- Adding a server-side saved-progress API.
- Adding Discard controls to every puzzle card.
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
| Setup | Keep mandatory Mission Setup. |
| Completed | Keep existing completion restoration. |

This is a route-entry policy in `apps/web/src/routes/puzzle/[id]/+page.svelte`. `PuzzleSession` remains the canonical lifecycle owner and gains no new action.

Manual Pause remains unchanged for both modes. A player who presses Pause still sees `Mission Paused` and can Resume, Restart, Exit, or Discard.

### 2. Exit and Discard

Exit has one meaning everywhere: save the current state and return to the arcade.

Before navigation, the route:

1. Clears route-local transient gameplay presentation such as selection, hint, and rejection animation.
2. If the run is active, dispatches the existing `pause` action so timer/lifecycle state is settled.
3. Flushes the session clock and saves the latest serialized snapshot through the existing storage adapter.
4. Navigates to `/`.

No Exit confirmation is shown. The same composition is used by:

- The header Arcade/back action.
- Return to Arcade from Mission Setup.
- Exit from `SessionPauseDialog`.
- Back to Arcade from completion.

Discard becomes a separate destructive flow:

- `SessionPauseDialog` exposes `Discard` on both paused and resume presentations.
- Pressing it opens `DiscardSessionDialog`.
- Cancel returns to the exact prior Pause/Resume presentation without changing `pausePresentation` or resuming the run.
- Confirm preserves the existing defensive ordering: stop the periodic checkpoint, dispose the live session, clear the route session reference, delete persisted progress, then navigate home. This prevents teardown from re-saving the discarded snapshot.
- The home Continue panel exposes `Discard` beside `Continue`.
- Home confirmation clears that puzzle’s persisted session and immediately reruns `discoverGalleryProgress()` so the panel disappears or switches to the next newest resumable run.

`ExitSessionDialog.svelte` is replaced by a discard-only dialog. The new component copies the existing fixed full-screen scrim and dialog shell, including `modalFocus`, Escape-to-cancel behavior, `aria-modal`, z-index, and safe-area padding. No shared dialog framework is introduced.

### 3. Wider, Resizable Desktop Tray

At the existing desktop breakpoint (`min-width: 1024px`), the layout becomes:

```text
minmax(0, 1fr) | 20px resize separator | tray width
```

Initial constraints:

- Default tray width: `360px`.
- Minimum tray width: `300px`.
- Minimum preferred board column width: `480px`.
- Separator hit area: `20px`.
- Keyboard resize step: `16px`.

The numeric clamp is a small pure helper in the existing `apps/web/src/lib/services/puzzleLayout.ts`, covered by `puzzleLayout.test.ts`. The route owns only DOM measurement and interaction state.

For a measured layout width where both minimums fit, the maximum tray width is:

```text
layoutWidth - 480 - 20
```

`clampTrayWidth(...)` clamps the requested tray width between `300` and that feasible maximum. If a synthetic/constrained layout is narrower than `300 + 480 + 20 = 800px`, the tray minimum wins and the board may fall below the preferred 480px floor. This keeps the separator ARIA range internally valid; the real desktop layout is normally wider than this conflict because resizing is only exposed at the 1024px desktop breakpoint.

If `.game-layout.clientWidth` is zero/unavailable, the route retains the current width until it has a positive measurement instead of inventing a maximum.

Pointer behavior:

- Pointer down on the separator records pointer ID, starting X, and starting tray width.
- A new window `pointermove` handler ignores non-matching pointer IDs.
- Existing route `pointerup`/`pointercancel` cleanup is extended rather than replaced, so Hold-to-Peek reference release still works.
- Existing window `blur` cleanup is also extended to cancel tray resizing while preserving reference/selection cleanup.
- No pointer capture is required.
- Width changes are route-local and are not serialized.

Keyboard behavior:

- `ArrowLeft`: widen by `16px`.
- `ArrowRight`: narrow by `16px`.
- `Home`: set the minimum width.
- `End`: set the current measured maximum.

The separator uses `role="separator"`, `aria-orientation="vertical"`, an accessible label, and numeric `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`.

Below `1024px`, CSS hides the separator and the existing mobile board plus collapsible bottom inventory remains the only interactive layout. `PuzzleBoardPanel` already observes its viewport with `ResizeObserver` and recalculates fit zoom when the board column changes.

### 4. Fresh Rotation Shuffle

The existing `createRotations(puzzleId, pieceIds)` interface and virtual E2E override remain unchanged. Production changes only `buildRotations`:

- Call `generateRandomRotations([...pieceIds])` without the puzzle-derived deterministic seed.
- Return a cloned record containing valid `0 | 90 | 180 | 270` values for every requested piece.
- If a non-empty generated mapping is entirely `0`, set the first requested piece to `90` so rotation-enabled play is visibly scrambled.

`PuzzleSession` already calls this factory when setup is configured with rotation enabled and after Restart followed by setup configuration. Restored sessions keep persisted `pieceRotations`, so no session or persistence work is needed.

Production randomness is tested with a mocked `generateRandomRotations`; no test asserts on `Math.random` or probabilistic inequality.

### 5. Clear Hint Relationship

Hint policy remains unchanged. A successful hint continues to use the existing `hint_target` event, piece ID, target coordinates, filter reset, and live-region announcement.

Presentation changes:

- The matching tray slot receives a strong `--gold` / `--gold-glow` treatment and a visible non-interactive `HINT` badge.
- The board target uses the same gold visual language.
- On mobile, a hint opens a collapsed inventory drawer.
- After the drawer/filter rerender, the panel scrolls the hinted slot into view with `scrollIntoView({ block: 'nearest', inline: 'nearest' })`.
- The hinted piece becomes the inventory roving tab-stop candidate, but the code never calls `.focus()` and never invokes selection/rotation/placement callbacks.
- The hint remains active until the hinted piece is successfully placed, another hint replaces it, or transient gameplay state is cleared by Pause, Exit, Restart, Discard, puzzle navigation, or teardown.
- Selection alone does not clear the hint.

The route removes `HINT_DURATION_MS`, `hintTimeout`, and all timeout cleanup. `activeHintPieceId` plus `activeHintTarget` remain route-local presentation state.

`docs/PRD.md` must be updated in the implementation change so its two 1.8-second hint descriptions and deterministic/seeded rotation wording do not contradict the new behavior.

## Architecture and Ownership

### Puzzle route

`apps/web/src/routes/puzzle/[id]/+page.svelte` owns:

- Restored-entry policy.
- Direct save-and-exit composition.
- Gameplay discard orchestration.
- Route-local tray width and pointer/keyboard resize state.
- Hint lifetime.

The restore and exit/discard changes are implemented in one route pass so the file is not repeatedly rewritten around the same lifecycle code.

### Layout helper

`apps/web/src/lib/services/puzzleLayout.ts` owns the small pure `clampTrayWidth` calculation beside existing responsive puzzle metrics. This is not a split-pane abstraction; it exists only to make the numeric board/tray invariant testable without DOM event handlers.

### Dialog components

`SessionPauseDialog.svelte` adds `onDiscard`. `DiscardSessionDialog.svelte` owns destructive confirmation presentation and is reused by gameplay and home callers.

### Home page

`apps/web/src/routes/+page.svelte` owns the selected discard target. It clears progress through `createSessionStorageAdapter()` and recomputes through `discoverGalleryProgress()`. The existing `<main>` becomes inert/aria-hidden while the discard dialog is open, and `DiscardSessionDialog` renders as a sibling after `</main>` so underlying Continue/filter/card controls are not reachable.

### Gameplay runtime

`apps/web/src/lib/services/gameplay/runtime.ts` remains the sole production factory for tray order, run IDs, and orientations. Randomness does not enter `PuzzleSession` directly.

### Inventory and board

`PuzzleInventoryPanel.svelte` owns drawer opening and DOM reveal because it owns the tray scroll container and slot elements. `PuzzleBoard.svelte` only aligns destination styling.

## Error Handling

- Existing session serialization and storage fallback behavior remain authoritative; Exit does not create a second persistence path.
- Discard preserves the current stop/dispose/clear ordering so unmount/page teardown cannot recreate deleted progress.
- Clearing an already-missing home session still closes the dialog and recomputes gallery progress.
- A missing hinted slot is a no-op; the code must not throw or steal focus.
- Tray resize ignores unrelated pointer IDs and ignores resize requests until a positive layout measurement exists.

## Accessibility

- Timed restore retains explicit player-controlled resume; Relaxed restore removes an unnecessary modal.
- Discard confirmation traps focus and supports Escape cancellation.
- Home/gameplay content is inert while discard confirmation is open.
- The resizer is keyboard operable and exposes a coherent numeric ARIA range.
- Hint styling is not the only cue: a visible `HINT` badge plus the existing live announcement identifies the exact piece and target coordinates.
- Hint reveal may scroll and update roving state but never forces keyboard focus.

## Testing Strategy

### Vitest / browser tests

- `SessionDialogs.svelte.test.ts`: migrate from `ExitSessionDialog` to discard-only confirmation; Pause forwards Discard; outer scrim/focus/Escape behavior remains covered.
- Puzzle route test: add a `restoredModeState` because the current snapshot mock hardcodes `mode: 'timed'`; cover the full Timed/Relaxed restore table; migrate every old Exit Mission / Save & Exit test; preserve the discard-unmount regression; test direct Exit and exact cancel-discard presentation.
- `puzzleLayout.test.ts`: cover min clamp, feasible max/board floor, and the `<800px` conflict policy.
- Puzzle route layout tests: stub positive `.game-layout.clientWidth`, cover keyboard/pointer resizing, viewport reclamping, and mobile-hidden separator while keeping existing Hold-to-Peek pointer-release tests green.
- `PuzzleInventoryPanel.svelte.test.ts`: drawer opening, gold hint/badge, `scrollIntoView`, roving update without focus/select, and hinted-over-rejected precedence.
- Home route test: Continue panel Discard, inert main, cancel, clear, and rediscovery.
- `runtime.test.ts`: mock `generateRandomRotations`, assert invocation/output cloning/all-upright correction, and keep virtual override coverage.

### Playwright

Extend existing specs rather than creating a new fixture family:

- `gameplay-session-controls.spec.ts`: Relaxed restore bypasses Resume Mission; Timed restore still requires it; direct Exit saves/navigates; Pause Discard confirms and deletes.
- `gameplay-large-fixtures.spec.ts`: one chromium-desktop-only resizer/hint scenario using `seedPreferences: IMMEDIATE_START` so the mandatory setup dialog does not keep the page inert. The test can select a late tray piece, return the tray scroll to the top, request Hint, and verify the piece/target are revealed.

## Acceptance Criteria

1. Restored Relaxed active or paused runs enter gameplay without `Resume Mission`.
2. Restored Timed active or paused runs still show `Resume Mission`.
3. Every existing Exit entry saves and returns home without an Exit Mission popup.
4. Pause/Resume exposes Discard, which requires confirmation.
5. Canceling gameplay discard returns to the exact prior `Mission Paused` or `Resume Mission` presentation.
6. Confirming gameplay discard clears progress, navigates home, and cannot be undone by route teardown re-saving the snapshot.
7. The home Continue panel exposes Discard; the underlying `<main>` is inert while confirming; confirmation recomputes gallery progress.
8. Desktop tray defaults to `360px`, remains at least `300px`, and preserves a `480px` board floor whenever the measured layout can satisfy both minimums.
9. For an infeasible layout below `800px`, the clamp deliberately preserves the `300px` tray minimum; the production desktop breakpoint normally avoids this state.
10. Separator pointer/keyboard resizing works, reclamps after layout shrink, and does not disturb Hold-to-Peek pointer cleanup.
11. The separator is non-interactive/hidden on mobile.
12. Newly configured/restarted rotation-enabled runs request fresh orientation mappings; restored runs retain persisted orientations.
13. A non-empty rotation-enabled run never starts entirely upright.
14. Hint reveals and strongly marks the corresponding tray piece without selecting or focusing it, while the board target uses the same gold cue.
15. Hint remains until placement, replacement, or lifecycle cleanup, and `docs/PRD.md` describes that lifetime accurately.
