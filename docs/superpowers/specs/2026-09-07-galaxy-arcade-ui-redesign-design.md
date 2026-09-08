# Galaxy Arcade UI Redesign Design

## Summary

Redesign the Perseus web UI around the approved **Galaxy Arcade** mockup while preserving the
existing SvelteKit routes, gameplay/session behavior, persistence, APIs, search/filtering,
progression rules, admin operations, and accessibility contracts.

This is a web presentation and responsive-composition change. It is **not** a gameplay,
persistence, API, or NativeScript rewrite. The implementation remains one ticket and one
implementation PR, with a mandatory review gate immediately after the gameplay composition lands.

## Canonical mockup targets

The supplied `Perseus Redesign Board.html` contains exploratory alternatives. Only these variants
are implementation targets:

| Surface | Phone | Landscape tablet | Desktop |
| --- | --- | --- | --- |
| Gallery | **2a** | **2d** | **3a** |
| Gameplay | **2b** | **2e** | **3b** |
| Completion | **2c** | **2f** | **3c** |
| Admin | — | — | **4a** |

Turn 1 is design exploration only. Admin 4b is not part of this work.

When prose and a rendered canonical screen disagree, the rendered screen and its local note win.
In particular, 3a renders a **three-column** desktop poster wall; Perseus must not adopt the
turn-level prose that mentions four columns.

The phone mock is authored at 393×852. Perseus already standardizes phone behavior at 390×844 in
Playwright, so automated behavior and visual baselines use **390×844** as the single implementation
viewport. This is the only deliberate outer-frame normalization; composition and proportions still
follow 2a/2b/2c.

Mock puzzle names, art, scores, times, piece counts, and records are illustrative. Production data
remains authoritative.

## Goals

1. Make puzzle art the dominant discovery and completion surface.
2. Replace text-heavy chrome with readable gem/icon/progress vocabulary.
3. Give phone, landscape tablet, and desktop intentionally different composition without changing
   puzzle semantics.
4. Give desktop navigation and admin tools stable sidebars instead of floating link clusters.
5. Preserve keyboard, touch, focus, announcement, and session behavior.
6. Make the two highest-risk responsive rules executable: 1440px shell activation and three-column
   tablet/desktop gallery layout.
7. Make visual parity reproducible without putting pixel-diff tests in normal smoke CI.

## Non-goals

- No `@perseus/game-core` behavior changes.
- No session codec/save-schema changes.
- No API endpoint, D1 field, migration, workflow, or infrastructure changes.
- No NativeScript/mobile-app redesign.
- No new scoring, achievement, mastery, or ranking persistence.
- No component library, icon dependency, global UI store, or generic sidebar framework.
- No information-architecture redesign for Leaderboard, Profile, Quick Puzzle, Upload, Login, or
  Error pages where the board supplies no canonical replacement screen.
- No next-puzzle recommendation algorithm just to reproduce a `NEXT` label.
- No backwards-compatibility layer for superseded web markup or CSS classes.

## Existing owners and required composition changes

Keep current ownership unless explicitly listed below:

- `apps/web/src/routes/+layout.svelte` owns auth refresh and root player-shell composition.
- `apps/web/src/routes/+page.svelte` owns gallery loading/search/category/pagination/quick/saved
  progress behavior.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` owns gameplay orchestration and the outer workspace.
- `PuzzleBoardPanel.svelte` owns board viewport, pan/zoom state, reference overlay, and board
  rendering.
- `PuzzleToolbar.svelte` owns the single accessible toolbar action tree and roving focus.
- `PuzzleInventoryPanel.svelte` owns tray-local presentation and keyboard navigation while canonical
  filter/order/selection remain in the session.
- `PuzzleCompletionDialog.svelte` owns the one completion flow.
- Admin keeps route-local `AdminTab`; `AdminPuzzlesPanel` and `PlayerAccessPanel` retain their data
  owners.
- `puzzleLayout.ts` remains the sole JavaScript gameplay-layout metric owner.

### Gameplay toolbar lift

Today `PuzzleToolbar` is nested inside `PuzzleBoardPanel`, while the route owns
`board | tray-resizer | tray`. Galaxy Arcade requires `rail | board | tray`, so the toolbar moves to
`puzzle/[id]/+page.svelte`.

The board panel keeps viewport state. Only two new imperative presentation controls are exposed:

- `zoomIn()`
- `zoomOut()`

`FIT` does **not** get a third imperative reset seam. The route already owns
`boardViewResetVersion`; the lifted toolbar invokes the existing route reset path and the panel
continues resetting from that signal.

No zoom or pan state moves into the route.

### Deliberate HPA-217 reversal

HPA-217 hid Fit and Pause behind `MORE` on phone because the old toolbar was a horizontal/wrapping
row that consumed board **height**. Galaxy Arcade moves high-frequency controls into a vertical
right rail, so direct Fit and Pause consume reserved **width** instead. The earlier product cut is
therefore intentionally reversed for the canonical phone layout, not forgotten.

At 390×844 these actions are direct:

- Hint
- Reference
- Undo
- Fit
- Pause

`MORE` remains available for lower-frequency actions when needed. The shared E2E helper keeps its
fallback behavior for narrower/noncanonical layouts, while the 390×844 test explicitly proves the
direct Pause path.

## Visual language

### Palette and typography

Retune the existing token system rather than creating a second theme:

- primary ground: `#0a0620`
- elevated surface: approximately `#150d33`
- control surface: approximately `#1c1440` / `#1f1548`
- border: approximately `#2c1c60` / `#38246f`
- cyan primary: `#3affff` / `#00b4d8`
- magenta accent: `#ff2ea6` / `#ff5cc0`
- gold accent: `#ffcc00` / `#ffe06b`
- success: existing green semantic token
- body hierarchy: white/lavender with Rajdhani rather than tiny mono copy everywhere

Keep Orbitron, Rajdhani, and Share Tech Mono, but stop loading them from the Google Fonts runtime
CDN. Bundle them locally through Fontsource so functional tests and visual baselines use the same
font bytes without a network stub.

Remove the full-screen CRT/scanline overlay. The canonical mock uses radial glow blooms rather than
scanlines.

### Candy controls

Primary actions use rounded cyan glossy treatment with a hard lower edge/shadow. Secondary actions
use dark glass/indigo surfaces. Gold is reserved for hint/reward emphasis. Magenta is used for wrong
placement and destructive emphasis, not as a generic secondary color.

Icon-only controls retain stable textual `aria-label`s, pressed/disabled state, focus-visible state,
and 44px coarse-pointer targets.

## Closed visual vocabularies

### Difficulty gems

Use `PuzzleDifficulty` from `@perseus/types`; do not redeclare it.

| Difficulty | Visual | Accent |
| --- | --- | --- |
| `easy` | 1 gem + piece count | cyan |
| `normal` | 2 gems + piece count | magenta |
| `hard` | 3 gems + piece count | gold |

`DifficultyGems.svelte` is presentational only. Accessible labels still say Easy/Normal/Hard.

### Category icons

`CategoryBadge.svelte` is the **only** `PuzzleCategory -> icon` mapping site.

| Category | Icon metaphor | Accent family |
| --- | --- | --- |
| `Animals` | paw | amber/gold |
| `Nature` | leaf | green |
| `Art` | sparkle/palette | magenta |
| `Architecture` | building | cyan |
| `Abstract` | stacked diamond/shapes | violet |
| `Food` | plate/fork | orange |
| `Travel` | compass | sky/cyan |

Icons are inline SVG and decorative. Compact mode keeps the category name as `sr-only` text so the
radio label remains named. `CATEGORY_ALL` is not a `PuzzleCategory`; `CategoryFilter` renders its
All control directly rather than routing it through `CategoryBadge`.

The current `CATEGORY_COLORS` constant is obsolete and removed rather than retuned.

### Progress rings

`ProgressRing.svelte` accepts an already-derived percentage and owns no persistence or progression
state. Gallery percentage comes from existing saved `placedCount / pieceCount`; gameplay percentage
comes from current placed count / total pieces.

### Completion stars

Stars are a deterministic **presentation-only** summary over existing dialog data:

| Stars | Rule |
| --- | --- |
| 3 | competitive timed result, `hintsUsed === 0`, `incorrectAttempts === 0` |
| 2 | any other timed result |
| 1 | `relaxed` |

The implementation reuses the dialog's existing `competitiveTimedResult` derived value instead of
encoding `standard_timed || rotation_timed` a second time. Stars are never written to saves, APIs,
progression, or stats.

## Player application shell

Create one thin `ArcadeShell.svelte` for non-puzzle, non-admin player routes.

### Exact breakpoint

The persistent desktop sidebar appears at **`min-width: 1440px`** only. Below 1440px the shell uses
compact chrome.

This requirement is tested from rendered CSS at 1439px and 1440px using the repository's existing
`page.viewport()` + `getComputedStyle()` browser-test pattern. Do not add a data attribute that only
repeats the breakpoint number.

### Desktop contents

At >=1440px:

- 232px sidebar
- Perseus brand
- Arcade
- Ranks
- Upload
- Quick
- Profile/sign-in state
- authenticated score and rank near the foot
- sign-out visually secondary

### Progression refresh

Adding score/rank to the shell creates a **new** `getPlayerProgression()` call site; it is not an
existing root-layout request.

Keep it route-local to `+layout.svelte` rather than adding a store. The request is keyed to the
current pathname while the authenticated player shell is visible, with an `AbortController` for
superseded navigation. Returning from a completed puzzle to Arcade/Profile therefore refetches and
shows fresh progression.

`/profile` already fetches progression for its own page content. A direct/profile navigation may
therefore issue two progression reads; that small duplicate is accepted explicitly to avoid adding
shared progression state solely for deduplication.

`/puzzle/*` and `/admin` bypass the player shell and do not trigger the shell progression request.

## Gallery

Preserve puzzle fetch, 300ms search debounce, category filtering, cursor pagination, quick puzzle
discovery, per-variant saved progress, newest resumable session, all-saved-progress dialog, discard
flow, and loading/error/empty states.

Use one `PuzzleCard` implementation across form factors.

### Phone — 2a

Implementation viewport 390×844:

- compact shell/header
- one-column art-first feed
- resume banner with progress ring and one cyan resume action
- dominant square art
- icon category chip
- title + compact progress/best/mastery data
- gem difficulty actions

### Landscape tablet — 2d

At 1080×810:

- compact shell; no 232px sidebar
- **exactly three** poster columns
- full-width resume strip
- compact category/search controls

### Desktop — 3a

At 1440×900:

- 232px shell sidebar
- **exactly three** poster columns
- search/categories across the top
- wide resume banner with ~74px ring
- score/rank in sidebar

The three-column rule at 1080 and 1440 is asserted from `getComputedStyle(...).gridTemplateColumns`,
not left to screenshot review.

## Gameplay layout metrics

The new rail is part of the measured gameplay workspace and must be represented in the math.

`puzzleLayout.ts` owns:

```ts
export const GAMEPLAY_RAIL_WIDTH = {
  small: 56,
  medium: 56,
  large: 88,
  'extra-large': 96
} as const;

export const MOBILE_SHEET_HEIGHT = {
  peek: 140,
  half: 300,
  full: 528
} as const;
```

The same rail width is subtracted from:

- small/medium horizontal board reserve
- desktop `desktopWidthCap`
- `clampTrayWidth` so the remaining board column still satisfies `DESKTOP_BOARD_MIN_WIDTH`

The half-sheet constant is the small/medium vertical reserve; the board metric must not silently
hardcode another `300` with a different owner.

Tests pin the rail-aware board/tray invariant at 1080 and 1440: after tray clamping,

```text
layout width - rail - tray - separator >= DESKTOP_BOARD_MIN_WIDTH
```

and the reported board metric never exceeds the actual board column.

Keep the current viewport tiers:

- small `<640`
- medium `<1024`
- large `<1440`
- extra-large `>=1440`

Mock cell sizes remain fixture-specific targets, not constants.

### Tiered docked tray defaults

A 300px tablet tray must be reachable. The base width is therefore tier-aware:

- large / 1080-class docked layout: **300px base**
- extra-large / desktop: **352px base**

Existing coarse-puzzle widening may still produce a wider tray when needed; the 300/352 values are
base floors, not hard maximums.

## Phone gameplay — 2b

At 390×844:

- board is the focal surface
- floating HUD shows clock, pieces remaining, progress ring
- direct right rail exposes Hint/Reference/Undo/Fit/Pause
- bottom tray defaults to `half`
- rejected placement uses magenta

### Tri-state sheet semantics

Extend private `drawerOpen` to:

```ts
type MobileSheetState = 'peek' | 'half' | 'full';
```

The sheet handle is no longer a binary disclosure, so it does **not** use `aria-expanded`.
It is a plain button with `aria-controls` and a next-action label:

- `peek`: `Expand piece tray to half`
- `half`: `Expand piece tray to full`
- `full`: `Collapse piece tray to peek`

After a transition, `PuzzleInventoryPanel` calls an optional presentation callback supplied by the
route, and the route sends `Piece tray: peek/half/full.` through the existing gameplay announcer.
Sheet state is never persisted.

Hint reveal raises the sheet to at least half before scrolling the hinted piece into view.

### Phone proof

Rendered E2E proves geometry rather than mere DOM visibility:

- sheet root reports `data-sheet-state="half"`
- board and sheet bounding boxes do not overlap in the usable layout
- board top remains on-screen
- all five direct actions have boxes and are reachable without opening `MORE`
- one visible enabled toolbar action remains the roving `tabindex="0"` stop
- Pause is clicked directly at 390×844 and opens the pause dialog

## Landscape tablet gameplay — 2e

At 1080×810:

- ~88px left rail
- centered board
- docked right tray with 300px base floor
- dynamic arbitrary-grid/aspect sizing

Portrait tablet may use the stacked phone-style sheet when docking would starve the board.

## Desktop gameplay — 3b

At 1440×900:

- ~96px left rail
- centered board
- 352px tray base floor
- full action set visible including redo

## Completion

Keep one `PuzzleCompletionDialog.svelte` and add `referenceImageUrl: string | null` from the
already-loaded `LoadedPuzzleSource.resolveReferenceImage()` result. No extra fetch.

Preserve focus trap, Escape/dismiss, result class, elapsed/best time, local failure state, server
retry, clear points, achievements, mastery, family rank, Play Again, and Back to Arcade.

- phone 2c: finished art, stars, large result/time, four compact stats
- tablet 2f: two columns; ~396px art for the mock fixture
- desktop 3c: large two-column result; ~504px art; remove 24rem large-screen cap

Do not rename Back to Arcade to `NEXT`.

## Admin — canonical 4a

The mock shows counts for both sidebar tabs. To preserve that parity without moving data ownership,
both existing panels mount once when `/admin` loads:

- `AdminPuzzlesPanel active={activeTab === 'puzzles'}`
- `PlayerAccessPanel active={activeTab === 'players'}`

Each panel performs its normal initial read once and reports its list length through optional
`onCountChange(count)`. This intentionally makes Player Access eager on the initial Missions view;
the small extra admin-only read is accepted for the visible count.

`AdminPuzzlesPanel.active` gates its processing poll interval, so an inactive hidden panel does not
poll in the background. The inactive tabpanel remains mounted but `hidden`/inert to users.

No duplicate fetch of the same panel data is added.

At 1440×900:

- 232px admin sidebar
- Missions + count
- Player access + count
- Upload
- View arcade
- selected panel in content

Mission rows keep search/filter/paging/polling/preview/delete/session cleanup and become:

- ~60px thumbnail/status placeholder
- mission/category text
- passive status dot + text
- three `DifficultyGems`
- accessible preview icon
- accessible delete icon
- delete is the only red row action

Player Access keeps add/remove behavior and uses readable 13–15px Rajdhani.

## Unmocked routes

Leaderboard, Profile, Quick Puzzle, Upload, Login, and Error keep their current information
architecture. They inherit the new tokens/shell and receive only spacing/readability fixes needed to
avoid overlap or broken shared controls.

## Visual-regression contract

Visual screenshots are a **manual parity lane**, not a smoke gate.

### Local fonts

Task 1 replaces the remote Google Fonts import with locally bundled Fontsource packages for
Orbitron, Rajdhani, and Share Tech Mono. The existing gameplay-E2E Google Fonts stub is then deleted;
there is no `PERSEUS_E2E_VISUAL` flag.

### Deterministic data/art

`ui-redesign-visual.spec.ts` must:

- fulfill gallery/admin JSON locally
- fulfill gallery/admin thumbnail requests with checked-in `e2e/fixtures/test-image.jpg`
- seed saved progress so the gallery resume banner exists
- use the deterministic gameplay harness for gameplay/completion
- wait for `document.fonts.ready` and all rendered images before capture
- emulate reduced motion
- use `maxDiffPixelRatio: 0.005`

### Correct device contexts

The manual visual lane reuses Chromium but creates context-appropriate describe blocks:

- phone: `390×844`, `hasTouch: true`, `isMobile: true`
- landscape tablet: `1080×810`, `hasTouch: true`, `isMobile: true`
- desktop/admin: `1440×900`, desktop pointer semantics

This ensures coarse-pointer CSS is represented in phone/tablet baselines.

### Lane isolation

- normal `test:e2e` excludes `@visual`
- `test:e2e:visual` runs `@visual` with one worker on Chromium
- no screenshot update command is added to CI

Behavioral tests must be green before candidate baselines are generated.

## Testing and acceptance

### Functional contracts

Keep current unit/E2E coverage for:

- search/category/pagination/quick/resume/discard
- gameplay placement/selection/rejection
- toolbar roving focus and shortcuts
- reference hold/toggle
- inventory roving focus/filter/hint behavior
- undo/redo/rotation/pause/setup
- completion focus/actions/retry/awards
- admin filter/poll/delete/allowlist behavior
- portrait-tablet support

`apps/web/src/routes/page.svelte.spec.ts` is explicitly part of the gallery regression set.

### Hard Gate A

After Task 4, stop on the same PR and review before completion/admin work. Gate A requires:

- no non-web scope
- rendered shell breakpoint tests green at 1439/1440
- rendered gallery three-column tests green at 1080/1440
- toolbar lifted out of `PuzzleBoardPanel`
- board panel still owns zoom/pan
- rail-aware layout invariants green at 1080/1440
- 390×844 board/sheet geometry proof green
- direct Pause path green
- sheet state local/unpersisted with correct next-state labels/announcements
- existing keyboard/touch/announcer tests green

### Gate B

Before visual baseline generation:

```bash
bun run --cwd apps/web lint
bun run --cwd apps/web check
bun run --cwd apps/web test:unit
bun run --cwd apps/web test:e2e:smoke
bun run --cwd apps/web test:e2e:a11y
bun run --cwd apps/web test:e2e:extended
```

All must pass.

## Success criteria

The redesign is complete when:

1. 2a–2f, 3a–3c, and 4a are materially matched at the standardized target viewports.
2. Player sidebar is hidden at 1439px and visible at 1440px by computed style.
3. Gallery computes exactly three columns at 1080×810 and 1440×900.
4. Rail-aware metrics preserve the 480px minimum desktop board column after tray clamping.
5. Phone board/sheet geometry is proven at 390×844, not merely visible.
6. Tri-state sheet semantics no longer misuse `aria-expanded`.
7. Tablet tray can start around 300px and desktop around 352px.
8. Shell progression refreshes after route changes without a global store.
9. Fonts are local and visual phone/tablet captures use touch/mobile contexts.
10. Functional behavior is green before visual baselines are approved.
11. No game-core, persistence, API, D1, workflow, infrastructure, or NativeScript scope is added.
