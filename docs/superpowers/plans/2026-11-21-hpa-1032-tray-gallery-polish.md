# HPA-1032 — Single-PR implementation plan and MCP E2E acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1032
Design: [2026-11-21-hpa-1032-tray-gallery-polish-design.md](../specs/2026-11-21-hpa-1032-tray-gallery-polish-design.md)
Baseline: `main` @ `c7f20d314088519e063da3eb49b68d40ebaee588`, including merged HPA-1029 artwork states and HPA-1031 compact layout controls.

**Rule:** Extend this draft PR into **one implementation PR for HPA-1032**. No second PR for Gallery (absorbed HPA-1036) or for tests. Keep the branch draft until real tests, MCP E2E and final screenshots are verified. All checkboxes are pending because this branch currently contains documentation only.

## 0. Establish failures and scope before editing

- [ ] Check for changes to `main` and rebase/refresh before coding; confirm current layouts using the same deterministic test fixtures in `apps/web/e2e`. Distinguish gallery-request loading from HPA-1029 image placeholders and expected infinite-scroll loading.
- [ ] At desktop **1440×900**, intermediate **1100×800**, and narrow **390×844**, reproduce a 16-piece puzzle's normal, 90° and 270° rotated tray silhouette near its neighbors and header; test selected 2×2 inspection. Include a large (100-piece) inventory for filters and scroll. Capture the final visible art, **not just the transparent 140% image wrapper's DOM rectangle**.
- [ ] At a fixed viewport, compare the **settled** `board-viewport`, `inventory-panel` and `piece-slot` bounds before/after reload and after `document.fonts.ready`/ResizeObserver settle. Do not confuse initial placeholder metrics or a manually resized tray with a reload regression.
- [ ] Use the existing `gallery.spec.ts` fixture router / `page.route` with held and out-of-order first-page requests, success, empty and error, and a held/failed next-page request. Record which of `loading-state`, `load-more-spinner` and image placeholders is actually stuck. Avoid speculative fixes if baseline coverage already passes.

## 1. Correct only demonstrated tray presentation/layout faults

Files to inspect/change as needed:

- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/routes/puzzle/[id]/+page.svelte` and `apps/web/src/lib/services/puzzleLayout.ts` **only if a reload metric mismatch is reproduced**
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`; existing `PuzzlePiece` and puzzle-layout tests where appropriate

- [ ] Scope the piece visual sizing/inset to **unselected tray pieces**, accounting for the 140% masked image, 90° rotations and hover scale, so the **opaque silhouette** has breathing room without touching neighboring slots or toolbar. Preserve recognizably protruding jigsaw tabs; do **not** apply blanket `overflow: hidden` to the piece, disable rotation, change image generation, or scale **board-placed** pieces. Retain the full-slot button/drag hit target and the 100%-slot pending/error fallback.
- [ ] Preserve the intended selected `selected-expanded` 2×2 footprint and its larger visual, keyboard roving-tabstop, selection ring, hint badge, scroll-to-hint, and filter counts. If selected art causes collisions, use existing grid/scroll spacing rather than treating it as an ordinary piece.
- [ ] If fixed-viewport reload geometry still changes **after settle**, fix the specific `ResizeObserver`/viewport fallback or CSS sizing inconsistency. Keep `getResponsivePuzzleBoardMetrics` and its existing width clamp as the single authority; no new global state or persisted tray width. Assert board/tray/slot settled dimensions agree within a small pixel tolerance (e.g. ≤2px) at the same viewport.
- [ ] Write a focused component or route regression for each confirmed fault; use browser screenshot/geometry proof for real visible silhouette containment (wrapper DOM bounds include intentional transparent padding). Keep scroll-only inventory with Corners/Edges/Center filters; no pagination.

## 2. Make Gallery loading correspond to active requests

Files:

- `apps/web/src/routes/+page.svelte`
- `apps/web/src/routes/page.svelte.spec.ts`
- `apps/web/e2e/gallery.spec.ts`

- [ ] Write deterministic held-request/response-order cases: initial response success, empty, failure; fast `q`/category switch where older request completes last; aborted first-page request; next-page success/error/reset on filter switch. Test the actual URL-driven navigation, current list, and spinner's settled absence without relying on sleeps.
- [ ] Reuse the existing `queryVersion`, `AbortController`, `loadMoreController` and `.finally()` lifecycle. If a reproduced path leaves either spinner stale, make the smallest local state-transition fix. Never let a superseded request overwrite current cards/error/total, or let its completion hide the current request's real loading indicator. **Do not** remove legitimate `load-more-spinner` behavior introduced by PR #83.
- [ ] Keep separate and meaningful: first-page `loading-state`, pagination `load-more-spinner`/retry, empty/no-results, and HPA-1029 image-status pending/error. No new request abstraction, spinner component or backend work.
- [ ] If baseline already passes all deterministic request-settle cases, document the report as not reproduced under those fixtures rather than manufacturing a code change; focused regression tests still protect the intended behavior.

## 3. Improve category and card-title discoverability

Files:

- `apps/web/src/lib/components/CategoryFilter.svelte` and its existing test coverage
- `apps/web/src/lib/components/PuzzleCard.svelte` and its existing test coverage
- `apps/web/src/routes/page.svelte.spec.ts` and `apps/web/e2e/gallery.spec.ts`

- [ ] Keep the existing radio group, category icons, URL commits and immediate `chosen` intent reconciliation. Display a short category label alongside the icon at widths where the topbar has room; on narrow screens, keep compact icon controls with **explicit** accessible names and a sensible hover title. Preserve checked/focus styling, touch target and horizontal containment. No dropdown, custom radio state manager or extra controls.
- [ ] Confirm `PuzzleCard` heading already retains the full `title={family.name}` tooltip and an untruncated DOM/accessibility name. Verify with a long fixture title; on narrow touch widths, allow a **bounded two-line presentation** if needed to distinguish cards, checking it does not cover progress/bookmark/clear badges or difficulty actions. No new popover/modal.
- [ ] Re-run category click/keyboard-focus tests. The historically timing-out `Abstract` radio test must be checked on this branch; if still hit by a hidden child, fix the **label hit target or test locator** only as warranted, without changing URL filter semantics.
- [ ] Preserve card navigation, bookmark toggle, family clear badges, category deep links, URL history, search focus, infinite scroll and HPA-1029 thumbnails.

## 4. End-to-end verification (MCP, single web platform)

MCP must execute/inspect Playwright in the actual app/browser; a unit-only or static-document review is insufficient. Build on existing tests rather than new duplicated journeys.

- [ ] MCP-run Chromium desktop and narrow-browser E2E using `apps/web/e2e/gallery.spec.ts`, `apps/web/e2e/gameplay-mobile-tap.spec.ts`, `apps/web/e2e/gameplay-interactions.spec.ts` and a focused additional test only for an uncovered regression. Assert a representative real puzzle loads, selected and rotated tray pieces remain usable, a piece places by click/keyboard or drag, progress remains, and the saved game resumes after reload. Assert 100-piece inventory remains scrollable and filterable.
- [ ] MCP-check the Gallery with controlled success, empty, error, stale/raced and pagination requests: when each **current** request settles, neither spinner remains unless another current page is actively fetching. Test category names and selection (desktop + compact), full long-title access, search URL/deep-link/back, and preserved card links/bookmarks/badges.
- [ ] MCP-assert settled responsive geometry at **1440×900**, **1100×800**, and **390×844**, including identical viewport before and after reload; check no document horizontal overflow and the compact gameplay More/header/hint controls from HPA-1031 remain reachable. Only one browser engine is required for this shared web change; no separate macOS/Windows/iOS/native acceptance.

### Required final-branch visual evidence

There is **no attached Linear mockup as of 2026-11-21**. If one appears, compare against it; otherwise compare against the shipped Galaxy Arcade layout. MCP captures and inspects real screenshots, and the PR links/attaches the evidence:

1. Gallery desktop after settle: category labels, loaded cards, representative long title.
2. Gallery 390px after settle: compact category accessibility/visibility and long title without card overlay collision.
3. Puzzle desktop with ordinary and rotated pieces, selected enlarged piece, inventory header, board and toolbar in frame.
4. Puzzle 390px tray open with ordinary/rotated pieces and reachable header controls.
5. Same viewport puzzle **before and after reload** after fonts/layout settle, with measured board, tray and slot rectangles recorded alongside images.

The screenshot/geometry review must establish visually no opaque neighbor/header overhang, no clipped jigsaw tabs, no hidden category/text controls, no horizontal overflow, and consistent settled proportions. Do not mark it passed from an uninspected screenshot or an earlier branch head. **No human approval gate.**

## 5. Quality gates and closeout

- [ ] Run focused web component/route tests, `bun run --cwd apps/web test:unit`, `bun run check`, `bun run lint`, and required PR CI. Record actual commands/results and classify pre-existing unrelated failures accurately; do not claim green based on another PR's results.
- [ ] If any shared backend handler is touched despite the initial scope, add a corresponding real API-to-browser **MCP end-to-end** check; otherwise keep this strictly web-only.
- [ ] Verify no new persistence contract, API, gameplay/session rules, NativeScript changes, framework, compatible legacy adapter, generated art or SFX. New asset work must be a separately scoped ticket if genuinely required.
- [ ] Commit implementation, tests and inspected final screenshots/evidence to **this same PR**. Update its description and HPA-1032 with outcome/remaining limitations. Mark the Linear ticket Done **only after merge and acceptance**, not on planning-doc creation.

### Scope/risk decisions

- The original `loading-state` is guarded by request version and a current-request `.finally()`; a bad spinner report may actually describe infinite scroll or image decode. Evidence decides, not assumption.
- The 140% image wrapper is necessary for tabs and can exceed its slot **as a DOM rectangle even when transparent**; require visible-silhouette evidence before shrinking it.
- Selected 2×2 expansion is intentional; a too-strict “every pixel inside original 1×1 slot” assertion would be incorrect.
- HPA-1031 changed breakpoints and viewport/hint reserves on `main`; check those exact boundaries, especially the fractional <1024px band, without reopening toolbar scope.
