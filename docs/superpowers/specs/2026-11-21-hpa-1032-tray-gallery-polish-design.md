# HPA-1032 — Puzzle tray and Gallery presentation polish

Linear: https://linear.app/cwchanap/issue/HPA-1032
Baseline: `main` at `c7f20d314088519e063da3eb49b68d40ebaee588` (2026-11-21, after HPA-1031 merged).
Companion implementation plan: [2026-11-21-hpa-1032-tray-gallery-polish.md](../plans/2026-11-21-hpa-1032-tray-gallery-polish.md).

**Delivery:** One web-only PR for HPA-1032, containing this specification, implementation, focused regressions and MCP-controlled E2E/visual evidence. This issue already absorbed HPA-1036; do not open a second ticket/PR for its Gallery work. This is a plan, not a claim that the bug is reproduced or fixed.

## User outcomes

1. Normal and 90°/180°/270° rotated tray pieces are visually distinguishable without their *opaque silhouette* spilling over adjacent slots, the inventory header or gameplay controls. Keep recognizable jigsaw tabs. The selected-piece 2×2 inspection area intentionally stays larger.
2. At the **same viewport and unchanged default tray settings**, a settled puzzle layout has consistent board and tray geometry after a reload; do not mistake the initial measurement frame for its final responsive size.
3. Gallery/search fetching has truthful states: active request → loading, settled success → cards, settled empty → empty/no-results, settled failure → actionable error; an obsolete request cannot leave a spinner over newer results. The pagination spinner remains visible **only while its page is actually loading**.
4. Category choices are understandable visually when space permits and always have short accessible names on compact layouts; long card titles are discoverable on desktop and narrow touch screens without breaking navigation or the artwork overlay.

## Existing code and decisions

### Tray and board

- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` owns the scrollable `.pieces-grid`, square `.piece-slot` elements, a selected `.piece-slot.selected-expanded` spanning 2×2 tracks, Corners/Edges/Center filters, and the mobile peek/half/full sheet. Do not replace with paging or a second piece preview.
- `apps/web/src/lib/components/PuzzlePiece.svelte` displays a server-generated transparent piece image inside a deliberately **140%** image wrapper offset using `TAB_RATIO`. Rotation applies to `.piece-visual`; the recent HPA-1029 image-status fallback belongs to a **100%-of-slot** overlay and must stay aligned to the ordinary slot. `hover:scale-105` also affects visible size. Do not globally clip the 140% image or remove jigsaw tabs.
- The puzzle route `apps/web/src/routes/puzzle/[id]/+page.svelte` sets `--piece-slot-size`, `--tray-columns`, `--board-width`, etc. using `getResponsivePuzzleBoardMetrics()` in `apps/web/src/lib/services/puzzleLayout.ts`. It measures `.game-layout` using `ResizeObserver` and uses viewport fallback before measurement. Mobile has a separate fluid tray slot size. HPA-1031 just changed compact breakpoints and hint/toolbar height budgets.
- First reproduce overflow using an unselected ordinary/rotated tray piece and a selected enlarged piece at desktop, mid-width and phone widths. Distinguish true **visible alpha/silhouette** overflow from the oversized transparent image element's DOM rectangle. Prefer a **tray-scoped presentation fix**: tune the visual scale/inner inset and, only if necessary, slot gap/padding. Keep the outer button/drag hit target, square grid, selection ring, status overlay and board pieces as they are. Do not shrink the gameplay board or alter `PuzzleSession` to fix tray spacing.
- For reload shifts, compare **settled** geometry after fonts/assets and layout measurement, at a fixed viewport without manual tray resizing. Fix a demonstrated mismatch at the narrowest existing CSS/layout seam; no new layout state or persisted user tray-width preference.

### Gallery

- `apps/web/src/routes/+page.svelte` already has separate `loading`, `loadingMore`, `error` and `loadMoreError` flags, `queryVersion`, `AbortController`, and a current-request `.finally()` guard. **Do not rewrite this blindly.** Reproduce the reported stuck spinner with controlled deferred/aborted/failed requests, including rapid URL search/category changes and pagination. Preserve the expected `load-more-spinner` while a next page is genuinely pending. Do not confuse HPA-1029's per-image `Loading…` placeholders with Gallery request spinners.
- `apps/web/src/lib/components/CategoryFilter.svelte` already keeps category intent synchronized with asynchronous URL navigation and renders accessible hidden names via `CategoryBadge`; icons alone are still hard to scan visually. Expose concise visible names on a sufficiently wide layout, retain icon-size controls on narrow screens with explicit radio accessible name and native hover title where useful, and leave the existing `selected`/`chosen`/URL behavior intact. Avoid adding a filter dropdown or new state manager. Preserve keyboard focus and checked styles.
- `apps/web/src/lib/components/PuzzleCard.svelte` already has `title={family.name}` on the truncated heading. Verify that the full title remains available by hover/assistive technology. On narrow touch layout, where hover does not exist, prefer a constrained second line or other **existing-card CSS** adjustment if the single-line ellipsis hides meaningful distinctions; do not add a modal or new card interaction. Preserve bookmark, clear status, difficulty action and thumbnail presentation.

## Non-goals and ownership

- HPA-1029 owns image download/decode failures and completion artwork. Its merged PR #181 supplied image status fallbacks; do not remove them or mask errors behind Gallery spinners.
- HPA-1031 (merged PR #184) owns toolbar/pause/rotation-mode instructions and its compact viewport fixes. Do not redesign those controls or regress their 1023.98px breakpoint behavior.
- HPA-825 covers physical drag verification; HPA-1028 covers wrong-server and fake-clock Playwright harness reliability.
- No changes to API, Workers, puzzle generation, persisted session schemas, scoring, timer semantics, bookmarks, difficulty tiers, pagination contracts, accessibility framework or mobile NativeScript app. No new artwork or SFX (create a separate art/audio task if assets ever become necessary). No backward-compatibility work.

## Automated acceptance contract

- **Deterministic E2E:** MCP drives existing Playwright tests on Chromium desktop and a 390×844 narrow viewport. One browser engine is sufficient for shared web UI. Verify normal/rotated/selected piece presentation, functional filtering and placement, scrolling with a large tray, fixed-viewport settled reload geometry, and local progress restoration.
- **Gallery E2E:** MCP checks success, empty, failure, stale/overlapping requests and next-page settle, including absence of `loading-state`/`load-more-spinner` when idle. Verify search/URL history, filter name/checked state, long-title discovery and unchanged bookmark/clear-badge/infinite-scroll behavior.
- **MCP screenshot inspection:** Issue currently has **no attached UI mockup**. Compare final-branch desktop/narrow Gallery and ordinary/rotated/selected tray screenshots against the shipped Galaxy Arcade UI on `main`; if a Linear mockup is later attached, use it instead. Include an identical-viewport before/after-reload layout comparison. Check visible alpha overhang, text contrast, no header/toolbar collisions, no horizontal overflow and unchanged layout after settle. Attach actual final artifacts to this PR. Never require human approval.
- **Regression gates:** Add focused component/route tests for reproduced failure paths, run relevant web unit tests and `bun run check`/`bun run lint`, and obtain required CI. If a Gallery test hits the known local `Abstract` radio click-interception timeout noted on PRs #181/#184, reproduce on the current branch before deciding whether a small in-scope label/hit-target fix is needed; do not hide unrelated failures.
- Implement all work on this **same PR**, not a planning PR followed by a second implementation PR. The document alone does not satisfy acceptance.
