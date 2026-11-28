# HPA-1341 — Web leaderboard redesign

**Status:** Proposed; design only.  
**Linear:** [HPA-1341](https://linear.app/cwchanap/issue/HPA-1341/web-ui-redesign-leaderboard-page-with-top-3-podium)  
**Prerequisite:** HPA-1340 / [PR #190](https://github.com/cwchanap/perseus/pull/190), merged; shared components verified on main.  
**Implementation:** [single-PR plan](../plans/2026-11-28-hpa-1341-leaderboard-redesign.md)

## Goal and reference

Bring the public /leaderboard page into the Galaxy Arcade page design established by /profile. The approved Linear attachments were inspected: `pages-mockup.html?page=leaderboard` and `pages-leaderboard.png` (desktop and mobile). Treat their content area as the visual source of truth; preserve the real app's existing navigation/auth shell, not the mock's illustrative shell or hardcoded names/scores.

- Global rankings kicker, LEADERBOARD title, score formula chip with star. The formula means 100×Easy + 200×Normal + 300×Hard + achievement points; use the compact mock wording with an accessible expansion.
- Desktop podium: cyan #2 left, larger gold #1 centered with crown, pink #3 right; tinted rounded panels, player initials/avatar, name, comma-grouped score and E/N/H clears. The desktop table below starts with the remaining ranks (normally #4 onward), rounded purple surface, rank, player, difficulty gem headers, clear counts and gold score at right.
- Mobile: keep three compact podium columns (center taller), formula chip wraps below title, and use compact rows with rank, player, score and the E/N/H summary below the name; no page-level horizontal scroll. The mock hides visual podium clear counts on mobile; keep them available to assistive technology and visible at wider widths. Keep long names, large scores and the YOU chip within their cells. At very narrow widths favor readable wrap/compact sizing over overflow.
- Current viewer gets a cyan inset/tinted row and YOU label, not just a color change. Loading, error and empty successful results use the shared arcade presentation. No artificial leaderboard data.

## Current code and ownership

| Existing seam | Proposed change |
| --- | --- |
| `apps/web/src/routes/leaderboard/+page.svelte` | Keep onMount, fetchOverallLeaderboard, AbortController, loading/error lifecycle and response as the sole owner. Add derived display projections, PageHeader, podium and rankings markup. |
| `apps/web/src/lib/components/PageHeader.svelte` | Use kicker/title/titleTestId and actions snippet for the score chip. |
| `apps/web/src/lib/components/DifficultyGems.svelte` | Reuse for desktop column headers with showPieceCount=false; the existing 1/2/3 colored gems already match. Use the same visual language and labeled counts in podium (compact one gem per difficulty as mock; if needed add a narrowly scoped opt-in compact prop to DifficultyGems, preserving defaults, rather than duplicate its SVG/color mapping). |
| `apps/web/src/lib/components/EmptyState.svelte` and `apps/web/src/routes/layout.css` | Reuse arcade-panel, arcade-chip, arcade-alert/error and shared typography for states and table; use EmptyState for no rankings or error as appropriate. Use scoped CSS only for leaderboard podium accents and responsive row layout. |
| `apps/web/src/lib/constants/icons.ts`, `apps/web/src/lib/utils/playerIdentity.ts` | Use ICONS.crown/star and existing playerIdentity(name) for display and initials. Prefer actual resolved avatarUrl when present, with initials fallback on missing/failed image; decorative avatar next to readable name. No new image assets. |
| `packages/types/src/core.ts`, `packages/shared/src/repositories.ts`, `apps/web/src/lib/services/api.ts` | Read-only reference. OverallLeaderboardEntry/Response are already typed, entries are ordered/ranked server-side, and me mirrors its entry if in the returned top list or is a separately ranked viewer. API resolves avatar URLs and passes credentials and abort signal. |

Use Svelte 5 derived state and keyed iteration by player.id. Keep everything within the route, using small markup snippets for repeated presentation; extract a single route-specific LeaderboardPodium component only if the route becomes hard to read. No generic podium/table engine, new global state, new fetch, auth lookup or shared CSS rewrite. Correct Tailwind v4 font family syntax (`font-(family-name:--font-display)`), not `font-(--font-display)`.

## Display rules (decisions for incomplete mock states)

- Use server-returned ranks and order, never compute score/rank, sort by score, or relabel based on visual position. Build podium from entries with ranks 1–3 only, in desktop/mobile visual order 2, 1, 3. Missing ranks produce no fake/empty player card: use occupied slots (one centered, two balanced) and keep real labels/colors. A detached `me` never fills a vacant podium slot even if a synthetic test supplies rank 3.
- Derive viewer identity from `board.me?.player.id`, not name, rank, client auth store or avatar. Table uses returned non-podium entries in original order. If viewer is in podium, mark their card YOU and deliberately retain **only that viewer** in the table (at their true rank) to satisfy the ticket's highlighted YOU row; this is the one intentional podium/table repetition. Otherwise highlight their existing table row; if outside returned entries, append the actual `me` row once, separated/styled as needed, without inventing intermediate ranks. There is exactly one YOU table row when me exists, none when absent.
- Zero entries and no me: shared empty state; if a viewer is returned without entries, show their real row. With only podium entries and no viewer, don't render an empty table header; all players are already represented. Loading/error must not show sample rankings or a misleading empty success state.
- Keep semantic table markup (caption or accessible name, scoped column headings), or equivalent explicit table roles if a responsive grid is needed. Desktop headers identify Easy, Normal, Hard in text accessible to AT. Mobile compact summaries retain labeled counts; avoid double-announcing hidden duplicate text. No clickable fake player links. Use real visible rank text or accessible crown rank label, readable labels and full names accessible even when visually truncated.

## Test contract and scope boundaries

Keep `leaderboard-title`, `leaderboard-loading`, `leaderboard-error`, `overall-leaderboard-table`, `overall-leaderboard-me` on their corresponding visible elements; the last now identifies the one highlighted table row in all viewer cases. Add a stable podium container/card hook only if needed for tests. Update existing assertions for the intentional title change from Overall Leaderboard to Leaderboard and the relocation of ranks 1–3 out of the table; continue asserting actual names, score, clear counts and viewer row. Do not hide failures by loosening assertions to page-wide text.

No API/scoring/ranking/auth change, filter/tab/pagination, family leaderboard modal redesign, global navigation redesign, native app changes, new dependencies, database migrations, or new image/SFX creation. Keep any future art/SFX generation in a separate ticket. All implementation and validation go into the same draft PR as these docs.

## Acceptance summary

Desktop and narrow browser screenshots must match both approved mockup references in page geometry, typography, color hierarchy, podium positions, score chip, table/compact rows and YOU treatment; compare equal deterministic data and viewport widths. Execute the UI via a browser MCP (one Chromium platform, two viewport sizes) and verify state, values, responsive fit and diagnostics, plus existing and targeted regression tests and normal CI. No independent native/device or human acceptance gate for this web-only presentation change. Actual implementation, E2E and visual comparison are pending.
