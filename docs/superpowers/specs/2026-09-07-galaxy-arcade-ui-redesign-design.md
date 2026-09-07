# Galaxy Arcade UI Redesign Design

## Summary

Redesign the Perseus web UI around the approved **Galaxy Arcade** mockup while preserving the
existing SvelteKit routes, game-core/session behavior, persistence, APIs, search/filtering,
progression, admin operations, and accessibility contracts.

This is a presentation and responsive-layout change, not a gameplay or backend rewrite. The work
stays in `apps/web` except for documentation and test snapshots. `apps/mobile`,
`@perseus/game-core`, `@perseus/types`, `@perseus/shared`, the API, workflows, migrations, and
infrastructure are out of scope.

The implementation is one ticket / one PR. Individual implementation tasks may use separate
commits for reviewability, but they are not separate deliverables or follow-up PRs.

## Source of Truth

The visual reference is the supplied `Perseus Redesign Board.html`. The board contains several
exploratory alternatives; only the following variants are canonical implementation targets:

| Surface | Phone | Landscape tablet | Desktop |
| --- | --- | --- | --- |
| Gallery | **2a — Art-first tiles, gems for difficulty** | **2d — Gallery — art wall** | **3a — Poster wall with persistent nav** |
| Gameplay | **2b — Candy controls over a full-bleed board** | **2e — Gameplay — candy rail, tray shelf** | **3b — Board centre, rail left, tray docked right** |
| Completion | **2c — Three stars, one number** | **2f — Mission complete — art centre stage** | **3c — Result over the finished board** |
| Admin | — | — | **4a — Database table with live sidebar tabs** |

Turn 1 remains structural exploration only. Variant 4b is not part of the redesign.

When the board's prose and rendered screen disagree, the **rendered canonical variant and its
variant note win**. In particular, the turn-3 intro says "four-up poster wall", but 3a renders a
three-column poster grid and its note explicitly says to keep the repo's three-up arrangement.
Perseus therefore keeps a three-column desktop gallery.

The mockup uses sample puzzle names, scores, records, piece counts, thumbnails, and artwork only to
show hierarchy. Real Perseus data remains authoritative.

## Product Goals

1. Make puzzle art the dominant visual element in discovery and completion.
2. Replace dense text-heavy arcade chrome with immediately readable icon, gem, progress, and score
   vocabulary.
3. Give phone, landscape tablet, and desktop layouts intentionally different geometry without
   changing gameplay semantics.
4. Give desktop navigation and admin controls a stable home instead of floating text links.
5. Preserve existing accessibility and keyboard/touch behavior while changing visual treatment.
6. Make visual parity testable at the mockup's canonical viewport sizes.

## Non-goals

- No new puzzle rules, difficulty definitions, progression rules, achievements, scoring, or rank
  calculations.
- No new `PuzzleSession` state or save-file schema.
- No new API endpoint or database field.
- No `apps/mobile` redesign.
- No component library, icon package, generic design-system package, or state-management framework.
- No rewrite of leaderboard, profile, quick puzzle, upload, login, or error-page content where the
  mockup does not provide a canonical replacement screen. These routes inherit the new shell and
  visual tokens only.
- No next-puzzle recommendation algorithm solely to reproduce the mockup's `NEXT` label.
- No backwards-compatibility layer for superseded web markup or CSS classes.

## Existing Architecture to Preserve

Perseus already has the right ownership boundaries:

- `apps/web/src/routes/+layout.svelte` owns player auth refresh and non-gameplay navigation.
- `apps/web/src/routes/+page.svelte` owns gallery loading, debounced search, category filtering,
  cursor pagination, quick puzzles, and local saved-progress discovery.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` owns browser gameplay orchestration while
  `@perseus/game-core` remains the canonical gameplay/session owner.
- `PuzzleToolbar.svelte` already provides roving keyboard focus and accessible hold/toggle
  semantics for hint/reference/undo/redo/zoom/rotation/pause/setup.
- `PuzzleInventoryPanel.svelte` already owns panel-local drawer and keyboard-navigation state while
  canonical selection/filter/tray order remains in the session.
- `PuzzleCompletionDialog.svelte` already owns completion presentation, focus trapping, local/server
  best-time presentation, awards, retry, replay, and return-to-arcade actions.
- Admin already separates `AdminPuzzlesPanel.svelte` and `PlayerAccessPanel.svelte`, with the admin
  route owning the active tab.
- `puzzleLayout.ts` already owns responsive board metrics.

The redesign changes these presentation boundaries only where the mockup needs new composition.
It does not move canonical state into new stores.

## Visual Language

### Palette

Use the mockup's deep-indigo arcade ground rather than the current near-black CRT treatment:

- primary ground: `#0a0620`
- elevated dark surface: approximately `#150d33`
- control surface: approximately `#1c1440` / `#1f1548`
- border: approximately `#2c1c60` / `#38246f`
- cyan primary: `#3affff` / `#00b4d8`
- magenta accent: `#ff2ea6` / `#ff5cc0`
- gold accent: `#ffcc00` / `#ffe06b`
- success: existing green token
- body copy: white/lavender hierarchy rather than small dim mono everywhere

Keep the current CSS-token approach in `layout.css`; retune the existing tokens instead of adding a
second theme layer. Keep Orbitron for short display labels and numeric emphasis, Rajdhani for normal
UI copy, and Share Tech Mono only where actual mono metadata is useful.

Remove the current global scanline/CRT overlay. The canonical mockup uses soft radial glow blooms,
not a full-screen scanline effect.

### Candy controls

Primary actions use the mockup's rounded glossy gradient with a hard lower edge/shadow so they read
as pressable. Secondary controls use dark glass/indigo surfaces with a lavender border. Gold is
reserved for the hint/reward emphasis. Magenta is used for wrong placement and destructive/admin
emphasis, not as a general secondary button color.

Every icon-only control must keep a stable accessible name with `aria-label` and the existing
pressed/disabled semantics.

### Difficulty vocabulary

The gallery no longer spells out Easy / Normal / Hard in normal browsing chrome.

- easy: one cyan gem + piece count
- normal: two magenta gems + piece count
- hard: three gold gems + piece count

The underlying `PUZZLE_DIFFICULTIES` values and piece-count data do not change. Screen-reader text
must still expose the difficulty name; the omission is visual only.

A small `DifficultyGems.svelte` component is justified because the same vocabulary appears in
phone/tablet/desktop gallery cards and admin rows. It must remain presentational and consume
existing difficulty plus piece-count data.

### Progress vocabulary

Use a reusable presentational `ProgressRing.svelte` for resume banners and gameplay percentage.
It accepts the percentage and sizing/styling inputs required by the screen; it owns no persistence
or progression state.

## Application Shell and Navigation

### Player routes

Create a thin `ArcadeShell.svelte` wrapper used by `+layout.svelte` for non-puzzle, non-admin
player routes.

Desktop at the canonical 1440×900 layout uses the 232px persistent sidebar from 3a:

- Perseus brand at top
- Arcade
- Ranks
- Upload
- Quick
- Profile / sign-in state
- score and rank summary pinned near the bottom when authenticated
- sign-out remains available without becoming a primary visual destination

The shell reuses the existing auth store and existing player progression endpoint. It must not add
an application-wide progression store. A small shell-local fetch is sufficient, and failures are
non-blocking: navigation still renders with score/rank omitted.

Phone and tablet do **not** inherit the 232px sidebar. Their header/nav remains compact so the
canonical 2a/2d art surfaces keep the available width. The shell breakpoint is intentionally
separate from gameplay's board tiers: the canonical 1080×810 tablet gallery has no desktop
sidebar, while 1440×900 does.

### Puzzle route

The puzzle route remains a full-screen gameplay surface and does not render the player shell.

### Admin route

Admin owns its own desktop shell because its sidebar contains live local tabs (`Missions`,
`Player access`) in addition to `Upload` and `View arcade`. The root layout must therefore exclude
`/admin` from the player shell, just as it already excludes `/puzzle/*` from normal navigation.

Do not create a generic configurable sidebar framework solely to share the player/admin chrome.
Share tokens and small leaf components where natural; keep the two navigation compositions clear.

## Gallery Redesign

### Data flow

Keep all existing gallery behavior:

- `fetchPuzzles`
- 300ms debounced search
- category filtering
- cursor pagination / infinite loading
- quick-puzzle discovery
- per-variant local progress
- newest resumable session
- all-saved-progress dialog
- discard-progress behavior
- loading/error/empty states

No gallery service contract changes are required.

### Phone — 2a

Canonical viewport: 393×852; existing E2E mobile 390×844 is the nearest routine regression target.

- Deep-indigo glow background.
- Compact brand/header.
- Art-first cards: square artwork dominates, title sits over/near the art, category becomes a
  color-coded icon chip, mastery/best-time presentation stays compact.
- Difficulty uses gem chips, not text rows.
- Saved-progress resume strip uses a prominent progress ring and one cyan candy resume action.
- Search/category affordances stay reachable but visually secondary to art.
- Keep scrolling as the browsing model.

### Landscape tablet — 2d

Canonical composition: 1080×810 inside the mockup frame.

- No persistent desktop sidebar.
- Three-column square poster wall.
- Resume strip spans the content width.
- Category filtering becomes the compact icon/chip row shown by the mock while preserving the
  existing category values and accessible labels.
- Keep the same poster/card component as phone/desktop; change layout with CSS rather than a second
  card implementation.

Portrait tablet remains supported by the existing 768×1024 E2E lane. It should inherit the new
visual language while keeping a usable stacked responsive arrangement; the landscape mockup must
not regress portrait support.

### Desktop — 3a

Canonical viewport: 1440×900.

- 232px persistent left sidebar.
- Three-column square poster wall in the content region.
- Search and category controls across the top content row.
- Resume banner spans the content region with an approximately 74px ring and large candy resume
  action.
- Score/rank lives in the sidebar rather than floating over content.

## Gameplay Redesign

All gameplay actions continue to dispatch through the existing route/session contracts. This is a
layout and presentation change.

### Phone — 2b

Canonical viewport: 393×852.

- Board is the visual background/full-bleed focal surface.
- Compact HUD floats above the board: clock icon + time, remaining-piece icon/count, progress ring.
- Right-side control rail exposes the high-frequency actions without a `MORE` menu:
  - gold Hint
  - Reference / peek
  - Undo
  - Fit/reset view
  - Pause
- Redo may stay out of the phone rail; it remains available where current product behavior requires
  it, but the phone visual priority follows the mock.
- Wrong placement feedback uses magenta.
- Inventory becomes a bottom floating sheet with local presentation states:
  - `peek`: 140px target height
  - `half`: 300px target height
  - `full`: 528px target height
  - handle cycles `peek -> half -> full -> peek`
- Sheet state is UI-only and is never serialized in `PuzzleSession` or local session persistence.
- Existing filter actions remain `all`, `corners`, `edges`, `center`, and shuffle. The compact
  mockup may represent common filters with icons, but hidden/overflow actions must remain
  accessible rather than deleting functionality.
- Existing tap piece -> tap cell and keyboard behavior remains unchanged.

### Landscape tablet — 2e

Canonical composition: 1080×810.

- Permanent ~88px left control rail.
- Board centered in the remaining space; the mock demonstrates 72px cells for its 6×8 fixture,
  but production board sizing remains aspect/grid driven.
- Right inventory tray is docked instead of overlaid.
- Preserve the existing drag-to-resize tray behavior where it already applies; default geometry
  should visually match the mock before the user resizes it.

Portrait tablet remains adaptive and may use the phone/stacked tray composition when a docked
right tray would starve the board.

### Desktop — 3b

Canonical viewport: 1440×900.

- ~96px left control rail.
- Board centered.
- ~352px default right tray.
- Redo is present in the rail.
- The mock's 84px cells are a target for its 6×8 fixture, not a hardcoded board cell size.

### Board metrics

Keep `puzzleLayout.ts` as the sole board-size owner. Update its target/reserve calculations to
match the new chrome while retaining arbitrary grid dimensions and aspect ratios.

Use the existing viewport tiers rather than creating a parallel JavaScript breakpoint service:

- small `<640`
- medium `<1024`
- large `<1440`
- extra-large `>=1440`

CSS may additionally use orientation for tablet composition. Large landscape tablet and
extra-large desktop may use different rail/tray sizes while sharing the same board-metric owner.

## Completion Redesign

Keep `PuzzleCompletionDialog.svelte` as the single completion flow. Do not create a second result
route or alternate completion state machine.

Add a `referenceImageUrl: string | null` (or equivalently named presentation prop) sourced from the
already-loaded `LoadedPuzzleSource.resolveReferenceImage()` so the result can show the finished art
for both API and quick puzzles without an extra API request.

Preserve:

- modal focus trapping
- Escape/dismiss behavior
- result class semantics
- final time / personal best logic
- local-stat failure handling
- server-submission retry
- clear points
- achievements
- mastery awards
- family rank
- play again
- back to arcade

### Phone — 2c

- Finished art is central.
- Three-star reward treatment carries mastery/result emphasis.
- One large time/result number.
- Four compact icon/stat tiles for pieces, hints, incorrect attempts, rotation.
- Record/personal-best treatment becomes a trophy/reward chip.
- Keep existing truthful actions. Do not label a Back-to-Arcade action `NEXT` unless a separate
  product rule defines an actual next puzzle.

### Landscape tablet — 2f

- Two-column composition.
- Finished art left at approximately 396px wide for the mock fixture.
- Stars/time/result summary right.
- No unnecessary scrolling at 1080×810 for the standard fixture.

### Desktop — 3c

- Desktop-scale two-column/result-over-board presentation.
- Finished art approximately 504px wide for the mock fixture.
- The current fixed 24rem modal cap is removed on large viewports.
- Completion remains a modal/inert overlay over the existing puzzle route; no new navigation state
  is introduced.

## Admin Redesign — 4a

Use 4a's database-table design, not 4b's moderation grid.

Canonical viewport: 1440×900.

The admin route keeps its current tab state and panels but changes composition:

- 232px admin sidebar.
- `Missions` and `Player access` become sidebar tabs with live counts.
- `Upload` and `View arcade` move into the same sidebar.
- Content column contains only the selected admin tool.
- Normal body text becomes 13–15px Rajdhani instead of ~9px uppercase mono.
- Mission table rows use ~60px thumbnails instead of 48px.
- Status is a passive dot + word pill; it must not look like an action button.
- Easy/normal/hard piece counts use the shared gem vocabulary.
- Preview and delete use icon actions with accessible labels.
- Delete is the only red/destructive row action.
- Preserve current search, category/status filters, page slicing, polling, preview overlay, forced
  delete warning, local session cleanup, success/error states, and Player Access behavior.

Admin is desktop-first in this scope because the mockup only defines 4a at desktop size. Existing
responsive behavior must remain functional, but pixel-parity work is limited to the canonical
1440×900 screen.

## Unmocked Routes

Leaderboard, Profile, Quick Puzzle, Upload, Login, and Error retain their current content and
behavior. They receive:

- the new global colors/type tokens
- the player shell where applicable
- updated shared button/control styling where they already use those classes
- spacing fixes needed so the shell does not overlap content

Do not redesign their information architecture in this PR.

## Component Boundaries

Create only the reusable presentation pieces the canonical screens repeat:

- `ArcadeShell.svelte` — non-gameplay player shell/navigation
- `DifficultyGems.svelte` — 1/2/3 gem visual with accessible difficulty text and piece count
- `ProgressRing.svelte` — presentational conic progress ring

Prefer modifying existing components for the rest:

- `PuzzleCard.svelte`
- `PuzzleDifficultyPicker.svelte`
- `CategoryFilter.svelte`
- `PuzzleToolbar.svelte`
- `PuzzleInventoryPanel.svelte`
- `PuzzleCompletionDialog.svelte`
- admin route/panels

Do not add an icon framework. Inline the small SVG paths needed by each focused component, or use a
small local snippet within that component when one icon repeats inside it.

## Accessibility

Accessibility is a release requirement, not a follow-up.

- Preserve existing toolbar roving-focus behavior.
- Preserve inventory roving focus and keyboard navigation.
- Preserve modal focus trapping and `inert` behavior.
- All icon-only controls have `aria-label`.
- `aria-pressed`, `aria-expanded`, `aria-selected`, `disabled`, and existing relationships remain
  semantically correct.
- Gem-only difficulty controls expose Easy / Normal / Hard to assistive technology.
- Color is not the only admin status signal; keep the status word.
- Touch controls remain at least 44×44 CSS px under coarse pointers.
- `prefers-reduced-motion` continues disabling non-essential motion.
- Radial glows and decorative stars are `aria-hidden` / non-interactive.

## Error and Loading States

No service error semantics change.

- Gallery fetch failures keep retry/empty distinctions.
- Saved-progress incomplete discovery keeps the current retryable-outage behavior.
- Completion server retry remains visible and actionable.
- Admin processing/failed states remain explicit.
- Shell score/rank fetch failure is non-blocking and does not surface a page-level error.

Restyle these states to the new theme without changing their contracts.

## Testing Strategy

### Unit/component tests

Update browser-mode Vitest tests for changed structure while preserving semantic assertions. Add
focused tests for the three new presentation components and new local inventory-sheet behavior.

Do not rewrite behavior tests into snapshot-only tests. Existing functional assertions remain the
primary regression contract.

### E2E behavior

Keep existing Playwright behavior suites passing for:

- gallery search/filter/load-more
- saved progress / discard / resume
- tap and keyboard placement
- hint/reference
- undo/redo
- pause/setup/discard
- tray filter/shuffle/resize
- completion and retry
- progression/leaderboard links
- admin CRUD/filter/polling/player access
- accessibility

The existing 768×1024 tablet projects remain as portrait regression lanes.

### Visual parity

Add a focused `apps/web/e2e/ui-redesign-visual.spec.ts` using deterministic fixtures and Playwright
screenshot assertions for the canonical states:

- 390×844 or 393×852-equivalent phone: gallery, gameplay, completion
- 1080×810 landscape tablet: gallery, gameplay, completion
- 1440×900 desktop: gallery, gameplay, completion
- 1440×900 desktop admin: Missions and Player Access states

The mockup itself is not checked into the repository, so the first implementation capture becomes
the committed baseline only after manual side-by-side review against the canonical mockup. Once
approved, subsequent runs protect that parity from drift.

Visual parity means matching composition, hierarchy, spacing, sizing, palette, icon/gem language,
and control treatment. Runtime data and truthful action copy may differ from mock sample content.

## Acceptance Criteria

1. Gallery matches 2a, 2d, and 3a at their canonical form factors.
2. Gameplay matches 2b, 2e, and 3b while all existing session/gameplay behavior remains intact.
3. Completion matches 2c, 2f, and 3c while preserving the existing completion/retry/action
   contract.
4. Admin Missions and Player Access use the 4a shell/table language at 1440×900.
5. Desktop gallery uses a three-column poster wall, resolving the mockup prose/render conflict in
   favor of rendered 3a.
6. Phone inventory sheet cycles `peek -> half -> full -> peek` and does not persist that UI state.
7. Landscape tablet uses edge controls + docked tray; portrait tablet remains usable and passes the
   existing 768×1024 regression tests.
8. Puzzle board sizing remains dynamic for arbitrary grid/aspect values; no fixture-specific 48,
   72, or 84px hardcoded cell rule is introduced.
9. Leaderboard/profile/quick/upload/login/error retain their behavior and render correctly inside
   the new shell/theme.
10. No API, database, shared game-core, save-schema, or NativeScript changes are required.
11. Existing accessibility semantics remain intact and icon-only additions have accessible names.
12. Focused visual-regression screenshots are manually approved against the mockup and committed as
    the redesign baseline.
13. `bun run --cwd apps/web test:unit`, `bun run --cwd apps/web check`, relevant Playwright
    behavior suites, and the visual parity spec pass before the PR is marked ready for review.
