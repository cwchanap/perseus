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
- Existing regression seams: `PuzzleToolbar.svelte.test.ts`, `SessionDialogs.svelte.test.ts`, the real-route `page.svelte.test.ts`, `gameplay-mobile-tap.spec.ts`, `gameplay-interactions.spec.ts`, and `gameplay-accessibility.spec.ts`. Existing `gameplay-session-controls.spec.ts` already proves Exit saves and confirmed Discard removes progress; do not duplicate those journeys. Session progress persists in this browser/device's `localStorage`, not across devices.

## Product behavior

### 1. Self-describing toolbar / More panel

- Retain all action names, ids, callbacks, disabled gates, `aria-label` values, `aria-pressed`, keyboard roving behavior, and More's expanded state.
- Give the **visible actions in an open More panel** short text next to their icons: Redo, Zoom out, Zoom in, Rotation mode, Sound effects, **Hold to peek**, Leaderboard, Mission setup (when those actions exist). Each visible label must occur within its existing accessible `aria-label` (e.g. “Hold to peek” within “Hold to peek reference”); keep `aria-label` unchanged, including exact test locator contracts, and avoid `label-content-name-mismatch`. Reuse the icon-plus-label pattern already in `PuzzleInventoryPanel` rather than creating a new action representation.
- Keep the narrow **closed rail** icon-first. Native `title` already offers a mouse tooltip, while current `aria-label` values support assistive technology; do not widen the rail or recreate its actions in a second menu.
- Use the existing More container and scoped CSS only. On desktop, a modestly wider *expanded* flyout may be necessary to fit text; on compact viewports, preserve reachable 44px touch targets, readable/wrapping labels, and no horizontal overflow. Focus must not jump or duplicate tab stops on open, close, or resize.
- Do not introduce a toolbar action registry, new menu component, global state, CSS-tooltip library, or new sounds/music controls.

### 2. Truthful Exit / Discard copy

- In both paused and restored-resume presentations, keep buttons named **Exit**, **Discard**, **Restart**, and **Resume** for compatibility with existing tests and player expectations.
- Add one visible paragraph in the dialog: **“Exit saves this run on this device so you can resume later. Discard deletes it after confirmation.”** This precisely describes local-only persistence and does not imply online sync.
- Set the dialog's `aria-describedby` to that paragraph's id in the paused and restored-resume presentations, following `MissionSetupDialog`'s pattern. Do not reference the paragraph while the inline restart-confirmation view is displayed.
- The existing destructive confirmation remains required. Preserve the restart confirmation, focus trap, button labels and callbacks.

### 3. Explain the *mode* lock, not a piece lock

- Reuse and **move the existing** `#rotation-lock-reason` inside `.toolbar-secondary`, keeping the disabled Rotation mode button's `aria-describedby` reference. Show the **same single element** as readable, noninteractive text only while More is expanded. Explicitly hide it when `data-open='false'` on desktop (where the parent uses `display: contents`) and on compact layouts; hidden referenced descriptions still work for assistive technology.
- Use truthfully distinct copy: when mode is **on**, **“Rotation mode is locked after the first placement; you can still rotate unplaced pieces.”** When mode is **off**, **“Rotation mode is locked after the first placement; piece rotation is unavailable in this run.”**
- Do not edit or depend on the disabled toggle's `title`: its `pointer-events: none` means the tooltip is not accessible by hover. Avoid another help element or a focusable helper control.
- Do **not** unlock the mode toggle, disable per-piece rotation, or change persisted rotation flags/engine transitions. The closed rail and tray Rotate button currently share a similar rotation icon, which remains a known discoverability limit until More is opened; do not spend this copy-focused PR on an icon redesign.

### 4. A small in-game placement hint

- Render **one permanently reserved, fixed-height hint line** in `.board-stage`, between `.hud-header` and `<PuzzleBoardPanel>`. Keep the element and its space present throughout a puzzle route even when the text is empty; only update text, never insert/remove the line. This deliberately costs one small line of board height but prevents overlaying a playable cell and avoids viewport resize/zoom recomputation on every selection. Allow enough reserved height for text at narrow widths without reflow when the variant changes. Do not add a live-region or extra announcements.
- Derive four copy states from existing `sessionState.lifecycle`, `placedPieces.length`, `currentSelectedPieceId`, `gameplayInputBlocked`, `rotationEnabled` and `pieceRotations[currentSelectedPieceId]`: **(1) none** while inactive/paused/revealing/completed or after the first accepted placement with no selection; **(2) initial** before placement: “Select a piece, then click or tap a board cell — or drag.”; **(3) selected/upright:** “Piece selected: click or tap its board cell to place it.”; **(4) selected/not upright in rotation mode:** “Rotate this piece upright first, then click or tap its cell.” Initial wording may be shortened at narrow widths without losing the click/tap or drag option.
- The rotation-specific variant is essential: `validatePlacement()` rejects non-upright pieces as **counted incorrect attempts** when rotation is on. Do not encourage placement before fixing rotation. No new tutorial state, persisted flag, event listener, or session mutation.
- Use existing theme typography, preserve board hit targets, and keep placement via click/tap, drag, Enter/Space and Escape unchanged. No change to selection/snapping, timer start, result scoring, or the `PuzzleSession`.

## Scope boundaries and dependencies

**Inside this ticket:** visible toolbar action labels, mode-lock explanation, pause/exit/discard copy, contextual placement hint, focused component and rendered-browser tests.

**Outside:** HPA-1029 artwork loading (work already in progress); HPA-1032 tray and Gallery layout/presentation; HPA-825 real-pointer drag investigation and production QA; HPA-1028 Playwright harness reliability. Timer start is a separate product-rule question, not a reason to change clock behavior here. No new art/SFX or background music; if assets become necessary, make them an independent ticket, not part of this coding PR.

## Acceptance contract

- Toolbar component tests confirm visible labels are included in the existing accessible names, buttons work, and roving focus/pressed/disabled states remain correct. The existing gameplay accessibility E2E must **open More before the axe scan**, covering both labels and the visible lock explanation.
- The Pause/Resume dialog presents truthful **on-this-device** Exit-vs-Discard copy with `aria-describedby`. Focused `SessionDialogs.svelte.test.ts` covers both presentations and the restart-confirmation view. Existing E2E already checks persistence on Exit and deletion after confirmation; rerun it, but do not add duplicate save/discard journeys.
- Real-route `page.svelte.test.ts` proves the lock explanation, rotating an **unplaced** piece after mode lock, and the derived hint lifecycle (initial → selected upright/non-upright → cleared; hidden during pause/completion reveal). The reserved hint line's footprint must stay stable when the message changes.
- Extend existing mobile-tap and responsive-toolbar E2E with visible-label, hit-target, overflow, hint/click-to-place and stable viewport-height checks; retain current keyboard and drag regressions.
- **MCP-driven browser acceptance** runs the committed Playwright tests on Chromium, using desktop and 390px narrow viewports; no multi-OS sign-offs. Also run component tests, `check`, `lint`, smoke and the explicit `test:e2e:a11y` lane, which is not part of automatic PR CI.
- **MCP-driven screenshot visual check: four final screenshots** — expanded More **after placing a piece** (desktop and 390px), and the hint line (desktop and 390px). Compare with any attached Linear mockup, otherwise the shipped Galaxy Arcade UI. Verify readable action/lock text, no blocking board cells, stable board dimensions and no horizontal overflow. No pre-change screenshots or human acceptance gate required.
- Implementation, tests, and evidence land on **the same PR for HPA-1031**. No API/backend/persistence changes, new infrastructure, new art/SFX, or compatibility shim.
