# HPA-1031 — Single-PR implementation plan and E2E acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1031
Design: [2026-11-19-hpa-1031-gameplay-control-clarity-design.md](../specs/2026-11-19-hpa-1031-gameplay-control-clarity-design.md)
Baseline: `main` @ `cb5bb13d`, verified during the PR #184 design review

**PR rule:** The design, implementation, regressions, and final MCP evidence all land on PR #184. No second PR for HPA-1031.

**Status at `8f0588a8` (2026-11-21):** implementation and regression coverage are committed and PR #184 is non-draft. Verified gates: `bun run check` (0 errors/warnings), `bun run lint`, MCP-run Playwright smoke at `cfe5cb56` (195 passed, 9 skipped) and `@a11y` on Chromium desktop + tablet (8 passed), and green PR CI at head — Build & Lint `44880572739`, Unit Tests `44880572840`, E2E `44880572725`. Outstanding evidence: the four acceptance screenshots and MCP Playwright runs were captured at `cfe5cb56` and are not attached to the PR; `3fde3b68`, `4a146000` and `c7c66974` changed the compact More panel, hint reservation and inventory panel after capture, so a final-head capture is the remaining artifact. Local `test:unit` shows one isolated Gallery spec timeout that reproduces on the unmodified baseline — a local-environment failure outside this PR's scope, not a CI failure (the CI Unit Tests lane is green). Linear HPA-1031 stays open until merge and acceptance.

## 0. Ground rules

- [x] Recheck that the branch is current with `main` before implementation. Use `main` as the existing Galaxy Arcade visual baseline; **no mandatory before screenshots**.
- [x] Keep the implementation in `apps/web`, using current Svelte components and the existing `PuzzleSession`. Do not modify session rules, first-placement timing, persistence, API/backend, drag mechanics, gallery/tray sizing, or NativeScript.
- [x] Preserve exact existing button `aria-label` values and the Exit/Discard/Restart/Resume names used by tests; no compatibility shim, toolbar registry, new onboarding state, art, SFX, or music feature.

## 1. Expose labels in More; reuse the rotation-lock element

Files:

- `apps/web/src/lib/components/PuzzleToolbar.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`

- [x] Add a small text span to each **existing** secondary action: Redo, Zoom out, Zoom in, Rotation mode, Sound effects, **Hold to peek**, Leaderboard, Mission setup (when present). Reuse the icon/label style pattern from `PuzzleInventoryPanel.svelte`. A visible label must be a substring of its unchanged `aria-label` (e.g. “Hold to peek” within “Hold to peek reference”) so the open flyout passes axe's `label-content-name-mismatch` rule.
- [x] Show those spans **only** under `.toolbar-secondary[data-open='true']`. In the closed desktop rail, preserve 3.25rem icons, including direct Redo/Rotation; only the expanded desktop flyout may widen. At 390px, the compact open panel is 288px wide with 2-column `.toolbar-group` grids, leaving ~132px for each icon-plus-label button. The inherited `.arcade-btn-ghost` Orbitron uppercase text + letter spacing, `white-space: nowrap`, and fixed `height: 3.25rem` risk clipping **LEADERBOARD**. On **compact open-panel buttons only**, use `height: auto`, `min-height: 3.25rem`, modest padding, `white-space: normal`, left alignment and a tight/small mono label span with `min-width: 0`/safe breaking. Keep two columns when practical to avoid making the panel excessively tall. Check 390px bounds, 44px targets, label visibility, no horizontal overflow and unchanged `aria-pressed`, `aria-expanded`, focus, roving Tab/arrow traversal and callbacks.
- [x] **Move**, rather than duplicate, existing `#rotation-lock-reason` into `.toolbar-secondary`. Keep the disabled button's `aria-describedby` and hide the text when More is closed, including desktop's `display: contents` state. Render the same element visibly, passively, only when More is open and mode locked:
  - rotation on: “Rotation mode is locked after the first placement; you can still rotate unplaced pieces.”
  - rotation off: “Rotation mode is locked after the first placement; piece rotation is unavailable in this run.”
- [x] Do **not** change the disabled button `title`: `pointer-events: none` means the tooltip is not a useful discovery path. Accept the known visual similarity between the mode toggle icon and tray Rotate icon in the closed desktop rail, since the open-panel wording resolves it without an icon redesign.
- [x] Add focused tests for label-text/accessible-name agreement, lock wording for both mode states, visibility when More opens/closes, existing action callbacks and stable keyboard focus. Extend present tests rather than creating a toolbar abstraction.

## 2. Make Exit/Discard copy local and accessible

Files:

- `apps/web/src/lib/components/SessionPauseDialog.svelte`
- `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts`

- [x] Add **one paragraph** under the Timed/Relaxed mission subtitle for both `presentation='paused'` and `presentation='resume'`: “Exit saves this run **on this device** so you can resume later. Discard deletes it after confirmation.”
- [x] Reference the paragraph id in the dialog's conditional `aria-describedby` (following `MissionSetupDialog`). In the restart-confirmation view, show only its existing restart copy and do not reference an absent paragraph.
- [x] Component-test presence in both presentations, absence during restart confirmation, and correct descriptive association. Do not change existing callbacks, focus trap or destructive confirmation.
- [x] **Reuse** existing E2E in `gameplay-session-controls.spec.ts` for Exit persistence and confirmed Discard removal. Do **not** add redundant Exit→reenter or Discard cancel→confirm journeys to this copy-only ticket.

## 3. Reserve a stable gameplay instruction line

Files:

- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

- [x] Render **one always-present, fixed-height line** as a **direct child** of `.board-stage` between `.hud-header` and `<PuzzleBoardPanel>`, with **no new wrapper** around the header: multiple responsive styles use `.board-stage > .hud-header` direct-child selectors. Keep the element and its height even with empty text so selection transitions do not change board viewport or zoom. Account for the desktop `.board-stage` `gap: 2.25rem` without paying a second large gap for the line (adjust the new node's margin or panel spacing locally). Reserve constant **2-line compact (<1024px) and 1-line desktop (>=1024px)** heights; no overlay or pointer interception.
- [x] Compute text via **one route-derived value** (no persisted tutorial flag, timers or new state):
  1. **None/empty:** paused, setup, completed, reveal/input blocked, or post-first-placement with no selected piece.
  2. **Initial:** active, zero accepted placements, nothing selected — “Select a piece, then click/tap a cell or drag.”
  3. **Selected upright:** active, selected piece upright — “Piece selected: click/tap its board cell.”
  4. **Selected not upright:** active, rotation mode on and selected piece's rotation non-zero — “Rotate upright first, then click/tap its cell.”
- [x] Derive only from `sessionState`, `placedPieces`, `currentSelectedPieceId`, `gameplayInputBlocked`, `rotationEnabled` and `pieceRotations`. Use **`sessionState?.lifecycle === 'active'`** as the visibility gate so null/loading state has no hint. Once selection is confirmed non-null, use **`rotationEnabled && (pieceRotations[currentSelectedPieceId] ?? 0) !== 0`** for the rotation-first copy; an absent entry is upright, consistent with the canonical engine. Keep all active messages ~40–46 characters and ensure 390px text wraps within the **same reserved two-line height** (not resizing with copy). Use existing Galaxy Arcade typography and no new live-region announcement; selection already invokes `announceGameplay`.
- [x] Route component tests prove initial → selected upright → accepted/cleared, selected non-upright → Rotate → upright, selection after first placement, hint empty on pause and during reveal, and **unchanged board viewport height** across text transitions.
- [x] Extend the existing route test for first-placement mode lock: place a piece, then select and rotate a **different unplaced** piece while the mode toggle remains disabled. This guards the real user confusion without changing `PuzzleSession` or the validation rule (`non_upright` is a counted incorrect attempt).

## 4. Extend existing browser checks at the right level

Files:

- `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- `apps/web/e2e/gameplay-accessibility.spec.ts`
- Existing `apps/web/e2e/gameplay-interactions.spec.ts` / `gameplay-session-controls.spec.ts` remain regression coverage.

- [x] Extend the existing responsive toolbar test (`gameplay-mobile-tap.spec.ts`) to assert visible More labels, preserved accessible names/keyboard reachability, open panel bounds, touch targets, and no document/`.puzzle-main` horizontal overflow at desktop and 390px. Do not create another toolbar journey.
- [x] Add simple hint text + unchanged board viewport height assertions to the existing tap-to-place test; let its existing real placement assertion prove the interaction. Do not introduce a second click-to-place journey or duplicate the keyboard/drag tests.
- [x] In the existing active-gameplay accessibility E2E (after a placement), **open More before `assertPageAccessible`** so axe scans the displayed labels and the lock explanation. Explicitly run the separate `test:e2e:a11y` lane as part of acceptance; it is not run by default CI.
- [x] Keep the existing Exit/Discard E2E, keyboard Enter/Space, native desktop drag and session-controls regressions passing without reauthoring those flows. Do not fix HPA-825 physical-drag or HPA-1028 harness issues here.

## 5. Automated acceptance and visual verification

**MCP executes/inspects the actual Playwright tests and captures the screenshots.** The evidence is the committed commands, results and final images; no manual/human sign-off. One browser engine is sufficient for shared web UI changes.

- [x] Run `bun run --cwd apps/web test:unit`, `bun run check` and `bun run lint`; record outcomes.
- [x] Run the existing Playwright suite via MCP in Chromium desktop and 390px mobile viewport, including `bun run --cwd apps/web test:e2e:smoke` and focused route/toolbar tests. The stock `bun run --cwd apps/web test:e2e:a11y` script selects **chromium-desktop + chromium-tablet + webkit-mobile**. To satisfy the a11y acceptance with a **Chromium-only install**, run `cd apps/web && bunx playwright test --grep @a11y --project=chromium-desktop --project=chromium-tablet`; **or** install Chromium + WebKit via `bun run --cwd apps/web test:install-browsers` and then run `bun run --cwd apps/web test:e2e:a11y` verbatim. Record the actual selected browser projects and results; never claim the default three-project lane ran when WebKit is absent. Required PR CI passes. If an unrelated harness flake arises, record it against HPA-1028 rather than expanding this PR.
- [ ] **Four MCP screenshot checks, final branch only:** (captured and inspected at `cfe5cb56`; not attached to the PR, and compact-panel/hint fixes landed after capture — see status)
  1. Desktop expanded More **after one placement** (labels + lock description).
  2. 390px expanded More **after one placement** (labels, lock description, bounds).
  3. Desktop hint line (initial or selected, with board visible).
  4. 390px hint line (prefer selected rotated-piece warning, with board visible).
- [ ] Compare those screenshots with a Linear mockup **if one becomes available**, otherwise the shipped Galaxy Arcade UI on `main`. Check readable labels, color/contrast, reserved-line geometry, board cells unobscured, functional controls, no horizontal overflow or unexpected board zoom/resize. No separate pause-dialog screenshot required: its local copy/layout is covered by the component test.
- [x] Verify no new API/backend/persistence schema, score/timer semantics, toolchain/harness or generated art/SFX changes. CI and test results must be real, not inferred from planning.

## 6. Closeout on this PR

- [x] Commit all implementation/test updates to **PR #184**, document commands, MCP screenshot evidence and any narrowly deferred issues in its description.
- [ ] Keep draft until automated acceptance completes, then update Linear HPA-1031. Mark Done only when implementation is merged and accepted.

## Review decisions

Accepted 2026-11-19 design-review feedback: (1) rotation-aware selected hint to prevent counted `non_upright` attempts; (2) permanently reserved, stable-height line instead of overlay/dynamic-flow banner; (3) narrower regression scope using existing tests; (4) axe scan with More open; (5) “Hold to peek” visibility; (6) move/reuse lock explanation and skip disabled `title`; (7) device-local Exit wording with `aria-describedby`; (8) no baseline screenshots and only four final screenshots. **Adjustment:** retain explicit MCP-run E2E and screenshot acceptance per project requirements, without duplicating underlying Playwright journeys.

Follow-up review incorporated: compact open-panel labels must override inherited no-wrap/fixed-height Orbitron controls; hint stays a **direct child** of `.board-stage` preserving responsive header selectors with short messages and a two-line compact reservation; derived rotation uses `?? 0` and lifecycle gates null; the default a11y script includes WebKit so a Chromium-only equivalent command or explicit WebKit install is required. These are implementation details, **not additional PRs or test journeys**.
