# Galaxy Arcade UI Redesign Design

## Summary

Redesign the Perseus web UI around the approved **Galaxy Arcade** mockup while preserving the
existing SvelteKit routes, gameplay/session behavior, persistence, APIs, search/filtering,
progression, admin operations, and accessibility contracts.

This is a web presentation and responsive-composition change. It is **not** a gameplay, persistence,
API, or mobile rewrite. The implementation remains one ticket and one implementation PR; the PR
must stop for a hard review gate after the gameplay composition lands before completion/admin work
continues.

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

When prose and the rendered canonical mock disagree, the rendered canonical mock and its local note
win. In particular, 3a renders a **three-column** desktop poster wall; Perseus must not adopt the
turn-level prose that mentions four columns.

Mock puzzle names, art, scores, times, piece counts, and records are illustrative. Production data
remains authoritative.

## Goals

1. Make puzzle art the dominant discovery and completion surface.
2. Replace small text-heavy arcade chrome with a readable gem/icon/progress vocabulary.
3. Give phone, landscape tablet, and desktop deliberately different composition without changing
   puzzle semantics.
4. Give desktop navigation and admin tools stable sidebars rather than floating link clusters.
5. Preserve the existing keyboard, touch, focus, announcement, and session contracts.
6. Make visual parity reproducible without putting pixel-diff tests in the normal smoke lane.

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

## Existing owners and the one required composition change

Keep the current ownership boundaries unless explicitly listed below:

- `apps/web/src/routes/+layout.svelte` owns player auth refresh and root route composition.
- `apps/web/src/routes/+page.svelte` owns gallery loading/search/category/pagination/quick/saved
  progress behavior.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` owns browser gameplay orchestration and the outer
  board/tray layout.
- `PuzzleBoardPanel.svelte` owns the board viewport, pan/zoom state, reference overlay, and board
  rendering.
- `PuzzleToolbar.svelte` owns the single accessible toolbar action tree and roving focus behavior.
- `PuzzleInventoryPanel.svelte` owns tray presentation plus tray-local keyboard navigation while
  canonical filter/order/selection stay in the session.
- `PuzzleCompletionDialog.svelte` owns the one completion flow.
- Admin keeps route-local `AdminTab` state and separate `AdminPuzzlesPanel` /
  `PlayerAccessPanel` data owners.
- `puzzleLayout.ts` remains the sole responsive board-metric owner.

### Gameplay toolbar lift

Today `PuzzleToolbar` is nested inside `PuzzleBoardPanel`, while the outer puzzle route grid owns
`board | tray-resizer | tray`. The Galaxy Arcade tablet/desktop composition requires
`control rail | board | tray`, so the toolbar must be lifted into the puzzle route grid.

This is one planned composition refactor, not a new layout framework:

- `PuzzleToolbar` moves from `PuzzleBoardPanel.svelte` to `puzzle/[id]/+page.svelte`.
- `PuzzleBoardPanel` remains the owner of zoom/pan state and reference/board rendering.
- `PuzzleBoardPanel` exposes exactly three imperative presentation controls through component
  exports: `zoomIn()`, `zoomOut()`, and `resetView()`.
- The route binds the panel instance with `bind:this` and wires toolbar zoom/reset callbacks to those
  exports. The route does **not** adopt zoom or pan state.
- Existing `viewResetVersion` behavior remains valid for route-driven reset events that already
  exist; the imperative methods are only the user-control seam needed after lifting the toolbar.

No other `PuzzleBoardPanel` state is promoted upward.

## Visual language

### Palette and typography

Retune the current `layout.css` token system instead of creating a second theme:

- primary ground: `#0a0620`
- elevated surface: approximately `#150d33`
- control surface: approximately `#1c1440` / `#1f1548`
- border: approximately `#2c1c60` / `#38246f`
- cyan primary: `#3affff` / `#00b4d8`
- magenta accent: `#ff2ea6` / `#ff5cc0`
- gold accent: `#ffcc00` / `#ffe06b`
- success: retain the existing green semantic token
- body hierarchy: white/lavender with Rajdhani rather than tiny mono copy everywhere

Keep Orbitron for short display/numeric emphasis, Rajdhani for normal UI copy, and Share Tech Mono
only where mono metadata is useful.

Remove the full-screen CRT/scanline overlay. The canonical mock uses radial glow blooms rather than
scanlines.

### Candy controls

Primary actions use a rounded cyan glossy treatment with a hard lower edge/shadow. Secondary actions
use dark glass/indigo surfaces. Gold is reserved for hint/reward emphasis. Magenta is used for wrong
placement and destructive emphasis, not as a generic secondary color.

Icon-only controls retain stable textual `aria-label`s, pressed state, disabled state, focus-visible
state, and minimum 44px coarse-pointer targets.

## Closed visual vocabularies

### Difficulty gems

Use existing `PuzzleDifficulty` values from `@perseus/types`; do not redeclare the domain union.

| Difficulty | Visual | Accent |
| --- | --- | --- |
| `easy` | 1 gem + piece count | cyan |
| `normal` | 2 gems + piece count | magenta |
| `hard` | 3 gems + piece count | gold |

`DifficultyGems.svelte` is presentational only. Screen readers still receive `Easy`, `Normal`, or
`Hard` in the accessible label even when the visible word is omitted.

### Category icons

`CategoryBadge.svelte` is the **only** category-to-icon mapping site. `CategoryFilter` reuses
`CategoryBadge` in compact/icon mode instead of creating a second icon table.

| `PuzzleCategory` | Icon metaphor | Accent family |
| --- | --- | --- |
| `Animals` | paw | amber/gold |
| `Nature` | leaf | green |
| `Art` | sparkle/palette | magenta |
| `Architecture` | building | cyan |
| `Abstract` | stacked diamond/shapes | violet |
| `Food` | plate/fork | orange |
| `Travel` | compass | sky/cyan |

Icons are inline SVG and decorative; the category name remains the accessible name. Existing
`CATEGORY_COLORS` may be retuned/replaced by token-backed classes, but callers do not define their
own category visuals.

### Progress rings

`ProgressRing.svelte` accepts an already-derived percentage and owns no persistence or progression
state. Gallery percentage comes from existing saved `placedCount / pieceCount`; gameplay percentage
comes from current placed count / total pieces.

### Completion stars

Stars are a deterministic **presentation-only** summary over data the completion dialog already
receives. They are never written to saves, APIs, progression, or stats.

| Stars | Rule |
| --- | --- |
| 3 | `standard_timed` or `rotation_timed`, `hintsUsed === 0`, and `incorrectAttempts === 0` |
| 2 | any timed result (`standard_timed`, `rotation_timed`, or `assisted_timed`) that is not a 3-star result |
| 1 | `relaxed` |

`PuzzleCompletionDialog` owns this mapping in one local helper/derived value. Awards/mastery remain
separate truthful data and are not used to silently increase or decrease the star count.

## Player application shell

Create one thin `ArcadeShell.svelte` for non-puzzle, non-admin player routes.

### Exact breakpoint

The persistent desktop sidebar appears at **`min-width: 1440px`** only. Below 1440px the shell uses
compact header/navigation chrome.

This number is intentionally separate from gameplay board tiers. It guarantees:

- canonical 1080×810 tablet gallery gets the full content width
- canonical 1440×900 desktop gets the 232px sidebar
- Task 1 and Task 3 cannot choose different shell breakpoints

### Desktop contents

At ≥1440px:

- 232px sidebar
- Perseus brand
- Arcade
- Ranks
- Upload
- Quick
- Profile/sign-in state
- authenticated score and rank near the foot
- sign-out available but visually secondary

`+layout.svelte` reuses the existing `getPlayerProgression()` call after authenticated state is
known. No progression store is added. Failure to load score/rank is non-blocking.

`/puzzle/*` and `/admin` bypass the player shell.

## Gallery

Preserve all existing gallery behavior: puzzle fetch, 300ms debounced search, category filtering,
cursor pagination, quick puzzle discovery, per-variant saved progress, newest resumable session,
all-saved-progress dialog, discard flow, and loading/error/empty states.

Use one `PuzzleCard` implementation across form factors.

### Phone — 2a

Canonical 393×852:

- compact shell/header
- one-column scrolling art-first feed
- resume banner with progress ring and one cyan resume action
- square dominant artwork
- icon category chip
- title + compact progress/best/mastery data
- gem difficulty actions

### Landscape tablet — 2d

Canonical 1080×810:

- compact shell; no 232px sidebar
- three-column square poster wall
- full-width resume strip
- compact category/search controls

Portrait 768×1024 remains supported and may use a different intermediate column count as needed;
canonical parity is required at 1080×810.

### Desktop — 3a

Canonical 1440×900:

- 232px shell sidebar
- three-column poster wall in the content region
- search/categories across the top
- wide resume banner with ~74px ring
- score/rank in sidebar

## Gameplay

All action semantics remain wired to the existing session/orchestration methods.

### One toolbar tree

Keep one `PuzzleToolbar` DOM/action tree and its roving-focus logic. Do not create separate mobile
and desktop toolbars.

Phone must expose these high-frequency actions directly without opening overflow:

- Hint
- Reference/peek affordance
- Undo
- Fit/reset view
- Pause

`MORE` is **not deleted as a product requirement**. It may remain on phone only for low-frequency
actions such as redo, zoom in/out, rotation, or setup when showing every action would reduce board
usable space. Tablet and desktop expose the complete action set directly in the rail.

This preserves the responsive-toolbar reason for the existing overflow while still matching the
mock's direct high-frequency rail.

### Phone — 2b

Canonical 393×852; regression viewport 390×844:

- full-screen/full-bleed board focal surface
- compact floating HUD with clock, pieces remaining, progress ring
- right rail with direct high-frequency actions
- bottom floating tray sheet
- magenta rejected-placement feedback

Extend the current tray-local `drawerOpen` presentation state into:

```ts
type MobileSheetState = 'peek' | 'half' | 'full';
```

Targets:

- `peek`: 140px
- `half`: 300px default
- `full`: 528px
- handle cycle: `peek -> half -> full -> peek`
- hint reveal raises the tray to at least `half` before scrolling the hinted piece into view

Sheet state is never serialized.

Before finalizing phone toolbar geometry, tests must prove at 390×844:

- the 6×8 portrait board keeps a useful cell-size range (36–48px)
- the board remains visible with the default half sheet
- the default half sheet is visible and usable
- the five high-frequency actions are reachable without opening `MORE`
- all low-frequency actions remain keyboard/touch reachable, either directly or through overflow

Do not replace overflow with a scrollable icon rail that steals the board height.

### Landscape tablet — 2e

Canonical 1080×810:

- ~88px left toolbar rail
- board centered
- docked right tray
- default tray width approximately 300px
- arbitrary aspect/grid sizing stays dynamic

Portrait tablet may use the stacked phone-style tray if docking would starve the board.

### Desktop — 3b

Canonical 1440×900:

- ~96px left rail
- centered board
- `DESKTOP_TRAY_BASE_WIDTH` becomes **352px**
- redo and full action set visible

Mock 48/72/84px cells are fixture-specific visual targets, not constants.

### Board metrics

Keep the current tiers:

- small `<640`
- medium `<1024`
- large `<1440`
- extra-large `>=1440`

`puzzleLayout.ts` remains the only JavaScript board-metric owner. CSS may use orientation for
composition but must not duplicate board-size calculations in another service.

## Completion

Keep one `PuzzleCompletionDialog.svelte`.

Add `referenceImageUrl: string | null`, sourced from the already-loaded
`LoadedPuzzleSource.resolveReferenceImage()` result. No extra fetch is introduced.

Preserve focus trap, Escape/dismiss, result class, elapsed/best time, local failure state, server
retry, clear points, achievements, mastery, family rank, Play Again, and Back to Arcade.

- phone 2c: finished art, star summary, large result/time, four compact stat tiles
- tablet 2f: two columns; ~396px art for the mock fixture; no unnecessary scrolling
- desktop 3c: large two-column/result-over-board treatment; ~504px art; remove the 24rem large-screen cap

Do not rename Back to Arcade to `NEXT`.

## Admin — canonical 4a

Keep admin route-local tabs and existing panel data ownership.

At 1440×900:

- 232px admin sidebar
- Missions + live count
- Player access + live count
- Upload
- View arcade
- selected tool in the content column

Counts come from the lists the panels already loaded. Each panel exposes optional
`onCountChange(count)`; the route stores display counts only. No second fetch.

Mission rows retain search/filter/paging/polling/preview/delete/session-cleanup behavior and become:

- ~60px thumbnail/status placeholder
- mission/category text
- passive dot + status text
- three `DifficultyGems`
- accessible preview icon
- accessible delete icon
- delete is the only red row action

Player Access retains add/remove behavior and adopts readable 13–15px Rajdhani tool styling.

Admin parity is desktop-only because the board defines 4a only at desktop size; smaller admin
layouts must remain functional but are not pixel-parity targets.

## Unmocked routes

Leaderboard, Profile, Quick Puzzle, Upload, Login, and Error keep their current information
architecture. They inherit the new tokens/shell and receive only spacing/readability fixes required
to avoid overlap or broken shared controls.

## Visual-regression contract

Visual screenshots are a **manual parity lane**, not a normal smoke gate.

### Deterministic data/art

`ui-redesign-visual.spec.ts` must:

- explicitly fulfill gallery/admin JSON
- explicitly fulfill `/api/puzzle-families/:id/thumbnail` with the checked-in
  `e2e/fixtures/test-image.jpg`
- seed a deterministic saved session for gallery cases so the canonical resume banner is present
- use the existing deterministic gameplay harness for gameplay/completion cases
- wait for `document.fonts.ready` before every capture
- use reduced motion for every capture

### Font handling

The gameplay E2E fixture currently stubs Google Fonts for offline-safe functional tests. Add a
`PERSEUS_E2E_VISUAL=1` escape in `e2e/support/test.ts` so the manual visual lane does not install
that font stub. Functional lanes keep their current offline-safe behavior.

### Lane isolation

Add scripts in `apps/web/package.json`:

- normal `test:e2e` excludes both `@extended` and `@visual`
- `test:e2e:visual` sets `PERSEUS_E2E_VISUAL=1`, selects `@visual`, pins
  `chromium-desktop`, and uses one worker

The visual spec changes viewport size inside the single Chromium project for 393×852, 1080×810,
and 1440×900 captures. No extra Playwright project is required.

Each screenshot uses an explicit small `maxDiffPixelRatio` (0.005) so antialiasing noise does not
mask structural differences or make the lane unusably exact.

Baselines are generated/updated only after all functional gates are green and every candidate is
manually compared side-by-side with its canonical mock variant.

## Review gates

### Gate A — mandatory after gameplay

After Tasks 1–4 are implemented and gameplay behavior tests are green, stop on the same PR and
review the accumulated diff before starting completion/admin work. Gate A specifically verifies:

- shell breakpoint is exactly 1440px
- gallery is art-first and three columns at canonical tablet/desktop sizes
- toolbar was lifted cleanly from `PuzzleBoardPanel`
- board-panel zoom ownership stayed local
- 390×844 board/sheet/action invariants are green
- keyboard/touch/announcer behavior remains green

This gate replaces the reviewer's proposed two-PR split while preserving this project's one-PR
constraint.

### Gate B — before visual baselines

Completion/admin/unmocked-route work must pass unit/check/lint plus smoke/a11y/extended functional
E2E before screenshot candidates are generated. Do not bless screenshots around functional
failures.

## Acceptance

The work is complete only when:

- canonical 2a–2f, 3a–3c, and 4a composition is visually matched at target viewports
- 3a is three columns
- player sidebar activates only at ≥1440px
- toolbar is a route-grid sibling of the board/tray on tablet/desktop
- phone high-frequency actions do not require overflow
- phone tray state remains local/unpersisted
- arbitrary puzzle dimensions remain supported
- completion stars follow the closed table above and remain presentation-only
- category icons come from the single `CategoryBadge` mapping
- admin counts use panel-owned data, not duplicate fetches
- current behavioral/accessibility E2E contracts pass
- visual tests run only through the manual `@visual` lane and include real deterministic art
