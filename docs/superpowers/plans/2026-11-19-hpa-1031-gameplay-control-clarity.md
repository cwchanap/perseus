# HPA-1031 — Single-PR implementation plan and E2E acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1031
Design: [2026-11-19-hpa-1031-gameplay-control-clarity-design.md](../specs/2026-11-19-hpa-1031-gameplay-control-clarity-design.md)
Baseline: current `main`, inspected 2026-11-19

**PR rule:** Keep design, implementation, regression tests, screenshots, and final evidence on **this same draft PR**. Do not create a second implementation PR for HPA-1031. This first commit is documentation-only; implementation and acceptance are still pending.

## 0. Baseline and safety rails

- [ ] Before code changes, verify the branch is current with `main` and capture an automated desktop and narrow-viewport baseline screenshot of the gameplay route, open More panel, and paused dialog. No Linear mockup was attached at planning time: Galaxy Arcade is the visual baseline.
- [ ] Inspect existing selectors/tests before renaming text: accessible action names and exact Exit/Discard button names are used in component and Playwright tests.
- [ ] Keep all changes in `apps/web`. No `PuzzleSession`, game-core, API, storage, timer, drag/drop, D1/R2, or mobile NativeScript changes.

## 1. Label the existing toolbar actions

Files:
- `apps/web/src/lib/components/PuzzleToolbar.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

- [ ] Render short text alongside the SVG for **existing** secondary actions **when More is expanded**: Redo, Zoom out, Zoom in, Rotation mode, Sound effects, Peek reference, Leaderboard, Mission setup. Use a small local span in each button and shared scoped CSS. Do not add a second menu, data registry, action abstraction, or duplicated buttons.
- [ ] Keep the closed desktop rail icon-sized (including direct Redo and Rotation), preserve hover titles and full accessible button names, and give the expanded desktop flyout enough width for its labels. In the compact two-column More flyout, allow label wrapping while preserving 44px minimum hit targets.
- [ ] Ensure the visible label is included in the accessible name (`label-content-name-mismatch`) without changing the existing locator contracts. Keep click handlers, `aria-pressed`, More `aria-expanded`, disabled flags, tabindex/roving arrow navigation, and desktop visual order.
- [ ] Replace the ambiguous rotation-lock `title` / `rotation-lock-reason` with the specific **mode-toggle** explanation. When the mode is locked, render the same short explanation inside **open More** as passive text; do not depend on focus/hover of a disabled button. Respect rotation-enabled vs rotation-disabled wording.
- [ ] Extend component assertions for the open-panel text, locked-state explanation, button names, toggled state, one enabled Tab stop, keyboard traversal, and resize transitions.

**Implementation note:** CSS differs across breakpoints: ≥1024px uses a vertical 3.25rem desktop rail with `display: contents` reordering and an 11rem expanded flyout; <1024px uses a two-column panel. Limit width and label style adjustments to `.toolbar-secondary[data-open='true']`; do not widen the closed rail or disrupt `offsetParent`-based keyboard traversal.

## 2. Explain Exit versus Discard without changing outcomes

Files:
- `apps/web/src/lib/components/SessionPauseDialog.svelte`
- `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts`

- [ ] Add a concise visible statement under the Timed/Relaxed subtitle: “Exit saves this run so you can resume later. Discard deletes its saved progress after confirmation.” Show for both `presentation='paused'` and `presentation='resume'`; do not duplicate it in the restart-confirmation view.
- [ ] Keep **Exit**, **Discard**, **Restart**, and **Resume** button names, order unless visual QA proves an issue, and their callbacks unchanged. Existing `DiscardSessionDialog` remains the destructive confirmation.
- [ ] Unit-test copy in both presentations, confirm the restart view does not display irrelevant guidance, and preserve focus trapping and callback tests.
- [ ] Do not modify `exitToArcade`/`discardAndExit`: current route already flushes and persists on Exit and clears on confirmed Discard.

## 3. Give players an in-game click/tap-to-place hint

Files:
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` (if focused route assertions fit)
- `apps/web/e2e/gameplay-interactions.spec.ts` (canonical interaction proof)

- [ ] Add a small, visible, noninteractive hint near the existing board/HUD: initially “Select a piece, then click or tap a board cell to place it — or drag a piece.” When a piece is selected, switch to “Piece selected: click or tap a board cell to place it.”
- [ ] Derive visibility from existing `sessionState.lifecycle`, `placedPieces.length`, `currentSelectedPieceId` and `gameplayInputBlocked`: active before first accepted placement, or active with a selection; never over dialogs/reveal, and clear after placement when no piece is selected. No new tutorial state, storage, event listeners or session fields.
- [ ] Style a narrow, bounded overlay/pill that does not consume board layout height or intercept pointer input. Check board cell hit targets and both desktop/phone layouts. Do not change the existing board's `dropZoneInteraction` or inventory `onSelect`.
- [ ] Add a rendered browser regression: hint initially visible, click/tap a tray piece, click/tap its correct board cell, assert accepted placement and hint dismissal; explicitly prove a selected-piece hint and no blockage of a board click. Retain keyboard and mouse-drag tests.

## 4. Prove rotation mode and pause semantics end-to-end

Files:
- `apps/web/e2e/gameplay-session-controls.spec.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- `apps/web/e2e/gameplay-interactions.spec.ts`

- [ ] Extend existing deterministic fixture cases, not the harness: start rotation-enabled, place one piece, confirm the toolbar mode toggle is still disabled, the explanation is visible in More, and the tray Rotate action still operates on an **unplaced** selected piece.
- [ ] On a pause dialog, assert the explanatory copy. Trigger Exit and confirm saved progress survives reentry/resume; separately trigger Discard, cancel confirmation once, then confirm and assert progress is cleared. Keep these journeys independent of backend auth.
- [ ] In existing responsive toolbar E2E, open More on desktop and at 390px, assert visible text labels and action names, test an enabled secondary action, keyboard Arrow/Tab traversal, panel bounding box, minimum touch targets, and zero document/`.puzzle-main` horizontal overflow.
- [ ] Confirm the click/tap route and existing Enter/Space and native desktop drag still place a piece; do not attempt to fix HPA-825's physical-drag observation in this copy ticket.

## 5. Automated acceptance and visual evidence

**MCP is the acceptance executor**, using the committed Playwright tests and browser screenshots; do not require manual/human acceptance.

- [ ] Focused component tests pass (toolbar, pause dialog and any small route test). Run `bun run --cwd apps/web test:unit`.
- [ ] MCP-driven browser E2E on **one platform (Chromium)** runs the enhanced `gameplay-session-controls` / `gameplay-interactions` / `gameplay-mobile-tap` tests through the repository's existing fixtures. Use **desktop and 390px narrow viewport** for this shared web UI; no independent Windows/macOS/iOS sign-offs are required unless a genuine platform-specific regression is found. Run `bun run --cwd apps/web test:e2e:smoke` and targeted tests as appropriate. If CI flags unrelated HPA-1028 harness races, record the isolated evidence; do not silently broaden this PR into a harness rewrite.
- [ ] MCP screenshot visual check **on the final committed branch**: desktop closed rail and expanded More, narrow More at 390×844, paused and restored-resume dialogs, locked rotation text after a placement, initial and selected-piece hint. Compare with a Linear UI mockup **if one is attached by acceptance time**, otherwise with the shipped Galaxy Arcade styling and the initial automated screenshots. Verify text readability/contrast, board and tray visibility, no overlapping actionable controls, playable cells, panel containment and horizontal overflow. Save screenshots/observations as PR evidence.
- [ ] Run `bun run check`, `bun run lint`, `bun run --cwd apps/web test:e2e` where applicable, and required PR CI. Record actual command outcomes; do not claim results before running them.
- [ ] Preserve accessibility: button label-content-name agreement, More `aria-expanded` and keyboard traversal, dialog focus containment, visible copy, disabled rotation behavior, unchanged live gameplay announcements.
- [ ] No new art or SFX, no music toggle, no timer scoring changes, no changes to session persistence/API contracts, and no backward-compatibility shim.

## 6. Closeout on this PR only

- [ ] Commit implementation and regression tests to this branch.
- [ ] Add MCP E2E logs, screenshot paths and observed desktop/narrow outcomes to this PR's description; list any reproducible remaining issues separately rather than expanding scope.
- [ ] Keep draft until implementation and automated acceptance pass. Update Linear HPA-1031 with evidence and mark Done **only after** the implementation is merged and accepted.

## Risks and quick decisions

- **Compact label fit:** the flyout is two columns and may need scoped font/wrapping or a one-column arrangement at very narrow widths. Avoid enlarging the underlying vertical rail. Screenshot and bounds assertions decide.
- **Disabled rotation explanation:** a disabled control isn't focusable, so accessible text alone is insufficient for discoverability. Put legible passive copy in the already-open More panel; do not add focusable help controls.
- **Placement hint geometry:** a normal-flow banner would resize the puzzle board between selection states. Prefer a bounded non-blocking overlay near the HUD, then verify screenshot and board-cell hit tests at desktop and phone widths.
- **Overlap with other tickets:** HPA-1032 owns tray sizing and Gallery text; HPA-1029 owns artwork loading. Stop if the proposed diff begins to edit those surfaces rather than duplicating their work.
