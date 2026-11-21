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
- Use the existing More container and scoped CSS only. On desktop, widen only the *expanded* flyout as needed, keeping the closed rail at 3.25rem. **On compact viewports**, the existing `width: min(18rem, calc(100vw - 2rem))` flyout puts two buttons per row at roughly 132px each at 390px. The inherited uppercase Orbitron `.arcade-btn-ghost` font, `white-space: nowrap` and 3.25rem fixed button height will clip words such as **LEADERBOARD** beside a 1.45rem icon. Scope overrides to `.toolbar-secondary[data-open='true'] .toolbar-button`: retain a 3.25rem minimum tap height but permit auto height, modest padding, wrapped text and left alignment; give the label span small/tight mono typography and `min-width: 0`/safe breaking as necessary. Retain the two-column layout if text fits; avoid a taller eight-row one-column sheet unless visual checks demonstrate it is necessary. Preserve 44px targets, bounded panel, no horizontal overflow, and stable roving focus across open/close/resize.
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

- Render **one permanently reserved, fixed-height hint line** as a **direct child** of `.board-stage` between the existing direct-child `.hud-header` and `<PuzzleBoardPanel>`. Do **not** wrap the header and hint together: existing `.board-stage > .hud-header` selectors across breakpoints would stop matching. Keep this node and its reserved footprint present even when the text is empty; changing text must not resize the board viewport, intercept pointer input or obscure any cell. The desktop `.board-stage` already has `gap: 2.25rem`; adjust the new hint's margin/gap locally to avoid charging that gap twice. Reserve **two text lines on compact (<1024px) and one on desktop (>=1024px)**, with constant height across all copy states. No new live region or announcements.
- Derive four copy states from existing `sessionState.lifecycle`, `placedPieces.length`, `currentSelectedPieceId`, `gameplayInputBlocked`, `rotationEnabled` and `pieceRotations`: **(1) none** while not active/paused/revealing/completed, or after the first placement with no selection; **(2) initial:** “Select a piece, then click/tap a cell or drag.”; **(3) selected/upright:** “Piece selected: click/tap its board cell.”; **(4) selected/non-upright in rotation mode:** “Rotate upright first, then click/tap its cell.” Keep all three active messages short (~40–46 characters), rather than switching copy by viewport. Guard with `sessionState?.lifecycle === 'active'` (no hint mid-load), and classify selected rotation using **`rotationEnabled && (pieceRotations[currentSelectedPieceId] ?? 0) !== 0`** only after checking `currentSelectedPieceId !== null`, mirroring the engine's zero fallback so missing rotation entries are treated as upright.
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
- **MCP-driven browser acceptance** runs the committed Playwright tests on Chromium, using desktop and 390px narrow viewports; no multi-OS sign-offs. Also run component tests, `check`, `lint` and smoke. The existing `test:e2e:a11y` script includes **chromium-desktop, chromium-tablet and webkit-mobile**: for a Chromium-only environment run an equivalent explicit Playwright a11y invocation selecting Chromium projects, or install WebKit before running the script verbatim. Record the command and browser projects actually exercised; do not claim the full script ran if only Chromium was installed.
- **MCP-driven screenshot visual check: four final screenshots** — expanded More **after placing a piece** (desktop and 390px), and the hint line (desktop and 390px). Compare with any attached Linear mockup, otherwise the shipped Galaxy Arcade UI. Verify readable action/lock text, no blocking board cells, stable board dimensions and no horizontal overflow. No pre-change screenshots or human acceptance gate required.
- Implementation, tests, and evidence land on **the same PR for HPA-1031**. No API/backend/persistence changes, new infrastructure, new art/SFX, or compatibility shim.
