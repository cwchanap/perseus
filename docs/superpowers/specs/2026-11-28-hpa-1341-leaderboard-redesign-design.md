# HPA-1341 — Web leaderboard redesign

**Status:** Proposed; design only, revised after [design review](https://github.com/cwchanap/perseus/pull/191#pullrequestreview-6096603761) and [follow-up review](https://github.com/cwchanap/perseus/pull/191#pullrequestreview-6099462531).  
**Linear:** [HPA-1341](https://linear.app/cwchanap/issue/HPA-1341/web-ui-redesign-leaderboard-page-with-top-3-podium)  
**Prerequisite:** HPA-1340 / [PR #190](https://github.com/cwchanap/perseus/pull/190), merged; shared components verified on main.  
**Implementation:** [single-PR plan](../plans/2026-11-28-hpa-1341-leaderboard-redesign.md)

## Goal and reference

Bring the public /leaderboard page into the Galaxy Arcade page design established by /profile. The approved Linear attachments were inspected: `pages-mockup.html?page=leaderboard` and `pages-leaderboard.png` (desktop and mobile). Their content area is the visual reference; preserve the existing navigation/auth shell, not the mock's illustrative shell or hardcoded player data.

- Global rankings kicker, LEADERBOARD title, score formula chip with star. Preserve 100×Easy + 200×Normal + 300×Hard + achievement points; use compact mock wording with an accessible expansion.
- Desktop podium: cyan #2 left, larger gold #1 centered with crown, pink #3 right; tinted rounded panels, avatar/initials, name, grouped score and E/N/H clears. Rounded rankings table below starts at #4, with rank, player, difficulty gem headers, clear counts and gold score.
- Mobile: compact podium in the same visual order; score chip wraps below title and its text can wrap inside the chip; table shows rank, player, score and E/N/H counts under the name. Hide visual podium clear counts at the mock's ~760px breakpoint while keeping them accessible to assistive technology. No page-level horizontal scrolling.
- Current viewer gets a cyan inset/tint and YOU chip on the existing row or podium card, never a duplicate row. Loading, error and empty use shared arcade presentation.

## Current code and ownership

| Existing seam | Proposed change |
| --- | --- |
| `apps/web/src/routes/leaderboard/+page.svelte` | Keep onMount, fetchOverallLeaderboard, AbortController and loading/error lifecycle unchanged. Use one derived projection from the response, PageHeader, inline podium and semantic table. |
| `PageHeader.svelte` | Reuse kicker/title/titleTestId and actions snippet for score chip. Add `min-w-0 max-w-full` to the shared actions flex wrapper (currently unconstrained); keep the global `.arcade-chip` nowrap behavior for other callers. The leaderboard formula chip locally uses `white-space: normal; max-width: 100%; min-width: 0` with a shrink-resistant decorative star and one wrapping text child. |
| `DifficultyGems.svelte` | Reuse existing default 1/2/3 gems for desktop column headers, with no piece count. Add one opt-in `singleGem?: boolean` prop (default false) for the mock's single colored gem per podium difficulty. Announce actual labeled clear counts separately; never pass a clear count as pieceCount. |
| `EmptyState.svelte`, `routes/layout.css` | Reuse arcade-panel, arcade-chip, arcade-alert-error and shared typography for states and table. Use scoped CSS for podium accents, formula wrapping and table responsiveness only. |
| `lib/constants/icons.ts`, `lib/utils/playerIdentity.ts` | Reuse ICONS.crown/star, playerIdentity(name) for display name/initials; no assets. |
| `profile/ProfileBestTimes.svelte`, `ProfileHero.svelte`, `routes/profile/+page.svelte` | Reuse existing image-error visibility fallback pattern, responsive difficulty-inline/column toggle, score.toLocaleString(), and max-w-[72rem] page width. No changes to these components/routes. |
| `packages/types/src/core.ts`, `packages/shared/src/repositories.ts`, `lib/services/api.ts` | Read-only reference. Existing typed contract and resolved avatar URLs. |

One new route-local pure helper, `apps/web/src/routes/leaderboard/podium.ts` with `leaderboardLayout(board: OverallLeaderboardResponse)`, owns the tiny display projection. Return `{ podium, rows }` as arrays of `{ entry: OverallLeaderboardEntry, you: boolean }` so the same viewer marker is used everywhere. The route derives this once when board is available. Keep podium/table markup inline and share one avatar snippet (decorative container with `aria-hidden="true"`, image layered over initials with `alt=""` and an opaque `background: var(--bg-2)` so transparent pixels cannot reveal initials; hide only failed image on error using the local hideBrokenThumb pattern). Keep the readable player name outside the hidden avatar container. Use rank-based scoped styles and keyed iteration by player ID. No extra component, service, store, auth lookup, global CSS or ranking algorithm. Use correct Tailwind v4 font family syntax (`font-(family-name:--font-display)`).

## Display rules (normal API contract)

`listOverallLeaderboard` in packages/shared/src/repositories.ts limits the ordered positive-score list to 50, assigns rank = index + 1, and returns the viewer's existing entry if present. The total ordering includes player ID as a tiebreak. If the viewer has a score but is outside the returned top 50, the server returns separately ranked me. Under the normal stable API contract, ranks are contiguous, a short list contains every scored player, and an empty list has no ranked viewer. Do not add special branches for fabricated missing ranks, viewer-only empty boards or concurrent rank-query inconsistencies.

- Project podium as `[entries[1], entries[0], entries[2]].filter(Boolean)` (filter undefined with a type-safe predicate in implementation), rows as `entries.slice(3)`; preserve every supplied rank/score/count. Derive `you` for both arrays from me?.player.id. If me exists and its ID is not in entries, append it once to rows, without changing its rank. No client-side score sorting or recalculation.
- With 1 or 2 returned players, the same projection renders fewer podium cards, centered/balanced with their rank styling. With 0 entries, render EmptyState; when there are no rows (1–3 players), omit empty table. Do not fabricate entries or slots.
- If viewer is in podium, mark only that card YOU with cyan accent while preserving medal color. If in regular rows, highlight that row. If outside the list, highlight the single appended row. Exactly one YOU element when me exists, none without me. This explicitly supersedes the initial planning-only duplicate-row decision; the mock does not require a podium viewer to appear twice.
- Use a real `<table>` with accessible name and scoped column headings, visually matching the rounded mock. Desktop Easy/Normal/Hard headers use DifficultyGems; mobile uses CSS display:none for the difficulty cells and switches to the compact E/N/H summary under the name, with full difficulty names accessible. Keep rank/player/score header semantics (visually hidden at compact width if needed, not removed from the accessibility tree). Do not turn the table into a grid or duplicate the responsive table. For podium counts, wrap decorative single gems/visible numbers in aria-hidden and provide labeled sr-only counts; hide only the visual summary on mobile, not its accessible text.
- Show real rank text or an accessible #1 crown label. Player names stay accessible even when visually truncated. Loading/error branches retain original messages and IDs; do not show sample data.

## Test contract and scope boundaries

Keep `leaderboard-title`, `leaderboard-loading`, `leaderboard-error`, `overall-leaderboard-table`, `overall-leaderboard-me`. The last identifies the highlighted card or table row, not necessarily a row. Add `overall-leaderboard-podium` for scoped assertions. Update the title expectation to Leaderboard and move the existing Ace and Top Scorer assertions to podium. The existing progression smoke's deliberately small detached-viewer mock can stay as a synthetic fixture; the helper's detached-viewer test uses the actual 50-entry contract. Do not add defensive rules for the synthetic fixture. The helper owns projection cases, page unit tests own rendering states, existing E2E owns the gameplay-to-profile integration, and MCP owns real navigation and two-width visual parity. No duplicate state matrix or new E2E spec.

No API/scoring/ranking/auth change, filters/tabs/pagination, family leaderboard or profile redesign, global shell changes, native app changes, dependencies, migrations or new art/SFX. Future asset creation, if needed, belongs to a separate ticket. Everything here goes into this same draft PR.

## Risk and acceptance

The main layout risks are the nowrap formula chip in a narrow PageHeader and a 390px row containing a long player name, YOU chip and 5-digit score. Allow the formula text to wrap and the name to wrap/truncate while keeping score and YOU readable without horizontal overflow. Verify both during the existing mobile MCP check; no additional screenshot matrix.

Use the implemented app through browser MCP on one Chromium platform at **1440×900** (actual desktop sidebar shell, 232px sidebar) and **390×844** (mobile compact shell), matching the existing Playwright project viewports. At 1440px the available content area is nominally 1208px before any scrollbar; compare the leaderboard content area against the original HTML/PNG at matching available content width, not the mock's illustrative navigation shell. Use mockup-matched fixture data, real Ranks navigation and two final screenshots. Check visible values, order, clear-count presentation and viewer placement; list and fix meaningful visual mismatches. Run the existing progression E2E (MCP-accessible execution environment), focused unit tests and normal CI. No separate native/platform or human gate. Implementation and acceptance remain pending.
