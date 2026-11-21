# HPA-1032 — Single-PR implementation plan and MCP E2E acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1032
Design: [2026-11-21-hpa-1032-tray-gallery-polish-design.md](../specs/2026-11-21-hpa-1032-tray-gallery-polish-design.md)
Baseline: `main` @ `c7f20d314088519e063da3eb49b68d40ebaee588`, including merged HPA-1029 artwork states and HPA-1031 compact layout controls.

**Rule:** Extend this draft PR into **one implementation PR for HPA-1032**. No second PR for Gallery (absorbed HPA-1036) or for tests. Keep the branch draft until real tests, MCP E2E and final screenshots are verified. All checkboxes are pending because this branch currently contains documentation only.

## 0. Confirm code seams and reuse existing tests

- [ ] Refresh against `main` before implementation. This design review already established two code causes: the 140% jigsaw wrapper can put opaque tab tips outside a slot, and the tray's default width is calculated only at load. Write targeted regressions before fixing those causes; no full viewport × 0°/90°/180°/270° screenshot matrix.
- [ ] In `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`, reproduce 1×1 piece, selected 2×2 piece, and one 90° rotation/hover with measured 140% wrapper bounds; inspect visible tabs once in browser screenshots to validate the geometry check.
- [ ] Use existing `apps/web/e2e/gameplay-large-fixtures.spec.ts` to reproduce an **untouched** tray at 1100px, resize to 1440px, then reload at 1440px, measuring settled board/tray/slot dimensions. Manual separator changes are a distinct intentional session-only override and **reset on reload**.
- [ ] For Gallery, distinguish `loading-state` (exclusive of cards) from `load-more-spinner` (can coexist with cards) and HPA-1029 image placeholders. Inspect **existing** `apps/web/src/routes/page.svelte.test.ts` coverage before adding only missing settle/race assertions. Do not duplicate the prior success/empty/failure/retry matrix.

## 1. Fix proportional tray inset and responsive default on resize

Files:

- `apps/web/src/lib/components/PuzzlePiece.svelte` / `PuzzleInventoryPanel.svelte` (small tray-only presentation rule)
- `apps/web/src/routes/puzzle/[id]/+page.svelte` (derive default tray width; keep `puzzleLayout.ts` unchanged unless an additional proven issue)
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`, relevant existing route tests, `apps/web/e2e/gameplay-large-fixtures.spec.ts`

- [ ] Make the 140% masked-image envelope fit its **own** slot using one proportional inset. The mathematical minimum on each side is ~14.29% without hover (140% expansion); existing `hover:scale-105` increases it to ~15.99%. Prefer **~16%** if preserving hover or remove hover scaling with ~14.3% inset. Use the measured geometry to settle the actual CSS rule. Keep the full-size interaction target, image-status overlay and visual jigsaw tabs; do not clip the image, touch generators, or invent a second preview. The same rule works on selected 2×2 inspection because its containing area is larger.
- [ ] In the browser-mode component test, verify wrapper/visual `getBoundingClientRect()` fits each actual 1×1/2×2 slot to within half the existing grid gap; test an unselected upright piece, one 90° rotated piece, and selected/hovered state. At a normal scroll position, check the first row's tabs are not clipped by the scroll edge; re-run selection, hint scroll, roving focus, filter counts and large-tray scroll.
- [ ] Replace one-time `requestedTrayWidth` load assignment with route-local `manualTrayWidth: number | null`, derive default `requestedTrayWidth = manualTrayWidth ?? getDefaultPuzzleTrayWidth(puzzle, viewport)`, and keep `appliedTrayWidth` clamping based on measured `.game-layout`. Set manual override only on pointer/keyboard tray resize; reset it on new-puzzle load/reload. Do **not** add persistence or change session model. Board metrics continue using `getResponsivePuzzleBoardMetrics` without new state owners.
- [ ] Add one focused **MCP Playwright** desktop E2E alongside `gameplay-large-fixtures.spec.ts`'s widened-tray test: visit 1100×800 → resize to 1440×900 (without touching separator) → wait for fonts/ResizeObserver settle → record `--tray-width`, board-viewport dimensions and slot size → reload at **1440×900** → assert values equal within ≤2px. Check that a manually resized tray resets to its responsive default on reload using the existing resize test (not a new journey). Do not add a redundant 390px reload geometry case because the compact sheet uses CSS `clamp(3rem,16vw,4.5rem)` independent of tray width.

## 2. Prove Gallery spinner state and fix only a failing transition

Files:

- `apps/web/src/routes/page.svelte.test.ts` (**full lifecycle suite**; do not put race cases in the short `page.svelte.spec.ts`)
- `apps/web/e2e/gallery.spec.ts`
- `apps/web/src/routes/+page.svelte` **only** if focused tests reveal a real defect

- [ ] Reuse existing lifecycle cases: initial empty/error, stale next-page result, abort-by-query, load-more error/retry and IntersectionObserver gates. Do **not** reimplement these cases.
- [ ] Add **one parameterized current-next-page settle test** (success / error / abort by a committed filter switch) asserting **neither** `loading-state` nor `load-more-spinner` persists once the current request has settled; retain a visible spinner while the request is genuinely pending.
- [ ] Add **one out-of-order first-page response test**: older request completes after the newer URL search/category request, and cannot restore outdated cards, total, errors or spinner.
- [ ] Extend the **existing infinite-scroll E2E** in `apps/web/e2e/gallery.spec.ts` with a settled no-spinner assertion after page 2 arrives. Keep race timing in deterministic unit tests; avoid an E2E request matrix.
- [ ] If these pass on baseline, record **spinner not reproduced under controlled requests**, keep existing `queryVersion`/abort/`.finally()` unchanged and close this sub-finding. Otherwise patch only the failing state transition without creating a new request abstraction or masking HPA-1029 image states.

## 3. Ship minimal category-label and two-line-title changes

Files:

- `apps/web/src/lib/components/CategoryFilter.svelte`, `CategoryBadge.svelte` only if needed, existing `CategoryFilter.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleCard.svelte`, existing `PuzzleCard.svelte.test.ts`
- Existing Gallery E2E for smoke confirmation

- [ ] **Category names:** reuse the `CategoryBadge` compact component's existing `sr-only` label and expose it alongside the icon only above a **measured wide Gallery-header breakpoint**. At narrow widths retain icon-sized controls and the **already-tested** native radio accessible name (do not duplicate the screen-reader text/name tests); keep checked/focus and URL `chosen` reconciliation. No dropdown or new state.
- [ ] **Card names:** replace `truncate` with `line-clamp-2` for card heading at **all** widths; reserve stable two-line title height for uniform cards and keep `title={family.name}`. Extend the existing **390×844** status-stack/bookmark/category non-overlap regression with an intentionally long family name. Verify difficulty actions, clear badges, thumbnail overlay and links remain unobscured; do not add a tooltip-only touch workaround or modal.
- [ ] Preserve Gallery search focus/history, category deep-link behavior, bookmarks, family clear badges and HPA-1029 image placeholders. If the pre-existing `Abstract` radio click test flakes, reproduce and address only a genuine filter hit-target/locator fault, not the navigation state model.

## 4. MCP end-to-end and final visual acceptance (single browser engine)

**MCP must run and inspect the actual Playwright/browser session** on the implementation head. Static plan review or component tests alone are insufficient.

- [ ] Extend **`apps/web/e2e/gameplay-large-fixtures.spec.ts`** for the untouched-tray desktop resize→reload case; reuse its 100-/225-piece scrolling, one-piece placement, tooltip/hint and horizontal-overflow coverage. Rerun relevant `gameplay-mobile-tap.spec.ts` / `gameplay-interactions.spec.ts` existing smoke instead of duplicating a second 100-piece or full-solve journey. Confirm current-device progress resumes after reload using existing session tests.
- [ ] Gallery uses the existing `apps/web/e2e/gallery.spec.ts` infinite-scroll case for the new idle spinner check and existing URL/search/filter/bookmark/clear-badge cases; the two deterministic race regressions run in the full `page.svelte.test.ts` suite. Confirm category labels desktop and icons/names narrow, two-line card titles and no horizontal overflow.
- [ ] One supported Chromium browser engine with desktop **1440×900** and narrow **390×844** presentation acceptance is sufficient for shared web UI; the resize→reload comparison also begins at **1100×800**. No native/macOS/Windows/iOS sign-offs and no additional viewport × rotation matrix.

### Final-branch MCP visual evidence — attach to PR, not git

No attached Linear mockup as of 2026-11-21. Compare to the current Galaxy Arcade UI on `main` or any later-attached Linear mockup. MCP captures, **inspects** and links the following screenshots:

1. Gallery **desktop**: visible category labels, representative long two-line title and resolved cards.
2. Gallery **390px**: compact icon filters, long title, bookmark/clear badges and no collisions.
3. Tray **desktop**: ordinary and one rotated piece, 2×2 selected inspection, unclipped top-row tabs, board and inventory header.
4. Tray **390px**: open mobile sheet, readable/usable pieces, toolbar/hint and no horizontal overflow.
5. A **settled desktop resize→reload comparison** (1440px before and after reload), with recorded `--tray-width`, board-viewport and slot measurements.

- [ ] Confirm the browser-mode **numeric envelope containment test** passes and screenshots show recognizable tabs/selection, title readability, visible filter text, correct clipping at scroll boundary and no overlaps. Numeric test is the primary overlap regression; **MCP screenshot visual check is still mandatory**.
- [ ] Attach PNGs as GitHub PR comment/description assets (or a stable external artifact link referenced there), **never commit binary screenshots into git history**. No human approval criterion.

## 5. Quality gates and closeout

- [ ] Run focused web component/route tests, `bun run --cwd apps/web test:unit`, `bun run check`, `bun run lint` and required PR CI. Record actual commands, browser projects and results; no inherited green status from other PRs.
- [ ] If a backend handler is unexpectedly changed, add an API-to-browser **MCP end-to-end** regression. Otherwise keep this PR web-only, with no API, `PuzzleSession`, game rules, persistence schema, NativeScript, compatibility shims, generated art or SFX.
- [ ] Commit **code, tests and markdown evidence links** on **PR #185**; attach image files to GitHub, not to source control. Update this PR description and HPA-1032 with verified outcome, reproduction status, and screenshots. Mark the issue Done **only after this same PR merges and automated acceptance passes**.

### Review decisions (2026-11-21)

- **Accepted:** deterministic viewport resize/reload root cause; route-local manual override with no persistence; analytic 140% tray overlap and proportional inset; single quarter-turn envelope test; existing Gallery test suite reuse and much smaller race coverage; two-line titles; expose current compact badge text where space allows; use `gameplay-large-fixtures.spec.ts`; attach images rather than committing them.
- **Refinements:** account explicitly for `hover:scale-105` (~16% inset when retained rather than 14.3%); keep the full button/image-status hit area; the envelope measurement is the regression gate **but does not waive MCP screenshot visual acceptance**. Scroll clipping prevents header overlap but requires top-row tab-visibility inspection. Keep one narrow screenshot for shared UX rather than a full viewport×rotation matrix.
- **Not claimed:** any implementation, test, browser screenshot or CI result. All acceptance checkboxes remain pending.
