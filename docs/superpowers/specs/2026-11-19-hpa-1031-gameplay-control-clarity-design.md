# HPA-1031 — Gameplay control clarity: design specification

Linear: https://linear.app/cwchanap/issue/HPA-1031
Planning baseline: Perseus `main` inspected 2026-11-19
Delivery: **one web implementation PR for this ticket**. This documentation-only draft is that PR's starting point.

## Problem and outcome

A first-time player must guess what icon-only actions mean, why Exit differs from Discard, why a locked rotation-mode button still permits piece rotation, and how to place without dragging. Make those existing behaviors legible **without changing the game rules**.

This is a presentation/copy improvement, not another gameplay-control system. Keep the Galaxy Arcade style, the current toolbar action callbacks, the existing `PuzzleSession` owner, persistence, keyboard navigation, and input semantics.

## Existing implementation (verified on main)

- `apps/web/src/lib/components/PuzzleToolbar.svelte` already gives every action `aria-label` and `title`, but almost every button has only SVG content. `More puzzle actions` expands `.toolbar-secondary`: the desktop rail is 3.25rem-wide icon buttons and a flyout; compact viewports use a two-column flyout. The toolbar already implements roving keyboard focus and `aria-pressed` on stateful actions.
- `SessionPauseDialog.svelte` shows Exit / Discard / Restart / Resume without explanatory copy. The puzzle route's `exitToArcade()` persists and navigates away; `requestDiscard()` opens `DiscardSessionDialog`, whose confirmation invokes `discardAndExit()` and clears the saved session. Do not alter these callbacks.
- The puzzle route locks the **rotation mode toggle** when `placedPieces.length > 0`. `handlePieceRotate()` separately allows rotating a selected **unplaced** piece while rotation mode is enabled; `PuzzleInventoryPanel` already has a Rotate button. The current lock description, “Rotation is locked after the first placement,” is inaccurate.
- `PuzzleBoard.svelte` already handles native click/tap on a cell with an already selected piece; tray selection, drag/drop and Enter/Space placement already work. `MissionSetupDialog` receives an introductory `inputHelp` string, but the active board has no persistent contextual placement hint.
- Existing regression seams: `PuzzleToolbar.svelte.test.ts`, `SessionDialogs.svelte.test.ts`, `gameplay-session-controls.spec.ts`, `gameplay-interactions.spec.ts`, and `gameplay-mobile-tap.spec.ts`.

## Product behavior

### 1. Self-describing toolbar / More panel

- Retain all action names, ids, callbacks, disabled gates, `aria-label` values, `aria-pressed`, keyboard roving behavior, and More's expanded state.
- Give the **visible actions in an open More panel** short text next to their icons: Redo, Zoom out, Zoom in, Rotation mode, Sound effects, Peek reference, Leaderboard, Mission setup (when those actions exist). Keep text semantically consistent with each button's accessible name; do not introduce a `label-content-name-mismatch` a11y regression.
- Keep the narrow **closed rail** icon-first. Native `title` already offers a mouse tooltip, while current `aria-label` values support assistive technology; do not widen the rail or recreate its actions in a second menu.
- Use the existing More container and scoped CSS only. On desktop, a modestly wider *expanded* flyout may be necessary to fit text; on compact viewports, preserve reachable 44px touch targets, readable/wrapping labels, and no horizontal overflow. Focus must not jump or duplicate tab stops on open, close, or resize.
- Do not introduce a toolbar action registry, new menu component, global state, CSS-tooltip library, or new sounds/music controls.

### 2. Truthful Exit / Discard copy

- In both paused and restored-resume presentations, keep buttons named **Exit**, **Discard**, **Restart**, and **Resume** for compatibility with existing tests and player expectations.
- Add concise visible explanatory text in the dialog, such as: **“Exit saves this run so you can resume later. Discard deletes its saved progress after confirmation.”**
- The existing destructive confirmation remains required. Avoid wording implying Exit uploads or syncs online.
- Preserve the existing restart confirmation, focus trap, and accessible dialog labels.

### 3. Explain the *mode* lock, not a piece lock

- When the mode switch becomes disabled after first placement, update its `title` / `aria-describedby` help to: **“Rotation mode can't change after the first placement. You can still rotate unplaced pieces when the mode is on.”**
- Also expose that explanation as readable noninteractive text **inside the expanded More panel** while locked. A disabled button cannot be relied upon to receive keyboard focus; make the explanation visible without requiring focus on it.
- Do **not** unlock the mode toggle, disable per-piece rotation, or change persisted rotation flags/engine transitions. When rotation mode is off, do not suggest the player can rotate pieces anyway.

### 4. A small in-game placement hint

- Use existing route-derived state only: show a small contextual hint while the session is active **before the first accepted placement**, or while a piece is selected. Hide it on pause, setup, completion, and during completion reveal; remove it after placement when no piece is selected. No persisted “tutorial seen” flag.
- Initial wording: **“Select a piece, then click or tap a board cell to place it — or drag a piece.”** Once selected: **“Piece selected: click or tap a board cell to place it.”** The keyboard flow remains available (Enter/Space; Escape to cancel), with no new interaction.
- Anchor the hint to the existing board/HUD presentation without stealing pointer input, creating horizontal overflow, shrinking the board when it appears/disappears, or obscuring any playable board cell. Use the existing typography/theme tokens.
- Do not alter selection, snapping, drag/drop, first-placement timer semantics, result scoring, or the `PuzzleSession`.

## Scope boundaries and dependencies

**Inside this ticket:** visible toolbar action labels, mode-lock explanation, pause/exit/discard copy, contextual placement hint, focused component and rendered-browser tests.

**Outside:** HPA-1029 artwork loading (work already in progress); HPA-1032 tray and Gallery layout/presentation; HPA-825 real-pointer drag investigation and production QA; HPA-1028 Playwright harness reliability. Timer start is a separate product-rule question, not a reason to change clock behavior here. No new art/SFX or background music; if assets become necessary, make them an independent ticket, not part of this coding PR.

## Acceptance contract

- The open More panel shows readable, action-matching labels; every existing action still works; focus/`aria-pressed`/disabled state remain correct.
- Pause or Resume Mission explicitly communicates Exit-vs-Discard. Browser E2E demonstrates Exit persists progress and can resume, and Discard removes progress **only after confirmation**.
- After a placed piece, the rotation-mode toggle stays locked and the visible explanation distinguishes it from rotating unplaced pieces. A separate piece-rotation interaction still works when rotation mode is enabled.
- Before first placement, gameplay shows the placement hint; click/tap-to-place actually selects then places a piece; the hint updates/clears at the right lifecycle boundary. Keyboard and drag interactions are not regressed.
- **MCP-driven Playwright E2E** exercises the real rendered UI on one web browser platform at desktop and narrow viewport sizes; browser engine duplication is not necessary for shared UI changes. Run focused component tests and CI gates.
- **MCP-driven visual screenshot check:** compare desktop open More/pause dialog/rotation lock/placement hint and compact More/placement hint against the shipped Galaxy Arcade presentation. The Linear ticket has no attached mockup as of planning; if one is later attached, use it as visual reference. Check readable text, rail dimensions, focus, no overlapping/obscured controls, and no horizontal overflow. No human acceptance gate.
- The implementation and all tests land as **one PR for HPA-1031**. No API/backend/persistence changes, no new infrastructure, no backward-compatibility layer.
