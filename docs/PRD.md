# Perseus - Product Requirements Document

> **Version:** 2.1
> **Last Updated:** 2026-04-25
> **Status:** Current product baseline
> **Owner:** Product + Engineering
> **Source of truth:** Repository implementation on `main`

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Product Overview](#product-overview)
3. [Current Product Scope](#current-product-scope)
4. [Requirements Status](#requirements-status)
5. [Current Product Constraints](#current-product-constraints)
6. [Roadmap](#roadmap)
7. [Metrics & Analytics Status](#metrics--analytics-status)
8. [Quality & Testing Status](#quality--testing-status)
9. [Risks & Dependencies](#risks--dependencies)
10. [Appendix](#appendix)
11. [Document History](#document-history)

---

## Executive Summary

### Vision

Perseus is currently a polished single-player jigsaw puzzle arcade with an admin content
pipeline and cloud-based puzzle generation. The near-term goal is to strengthen the solo
gameplay loop and operating model before expanding into social, competitive, or account-based
features.

### Current Product Position

As implemented today, Perseus lets anonymous players browse ready puzzles, filter them by
category, solve them with mouse, touch, or keyboard input, and track personal bests and
in-progress boards locally in the browser. Admins can authenticate with a passkey, upload
source images, monitor asynchronous processing, and delete puzzles when needed.

In the production architecture, Perseus runs on Cloudflare Workers and uses Cloudflare
Workflows, R2, KV, and a Durable Object to generate and store puzzle assets.

### What Perseus is today

- A single-player puzzle experience with local progress and best-time tracking
- A curated content platform with admin upload and processing workflows
- A Cloudflare-native backend for puzzle generation and asset delivery
- A dark, arcade-styled web experience with category-based discovery

### What Perseus is not yet

- No player accounts or cloud progress sync
- No daily challenge or leaderboards
- No achievements, sharing, or multiplayer
- No offline mode (no service worker or PWA packaging)
- No product analytics baseline in the codebase

---

## Product Overview

### Primary users

1. **Players**  
   Anonymous visitors who want a quick, polished jigsaw puzzle experience with some replay
   value.

2. **Admins**  
   Internal operators who upload images, categorize puzzles, monitor processing, and remove
   broken or unwanted content.

### Core player journey

1. Land on the gallery at `/`
2. Browse available puzzles and optionally filter by category
3. Open a puzzle and solve it with drag-and-drop, touch, or keyboard
4. See timer, progress, and personal best feedback
5. Replay to beat a local personal best

### Core admin journey

1. Log in via passkey at `/admin/login`
2. Open the protected admin panel at `/admin`
3. Upload an image with name and optional category
4. Wait while the cloud workflow generates puzzle assets
5. Monitor progress, failure, or ready status
6. Delete or force-delete puzzles when necessary

---

## Current Product Scope

### Player experience

The current player product is centered on a single-player gallery and solve loop:

- Public gallery of ready puzzles
- Client-side category filtering and category badges
- Puzzle solving with mouse drag-and-drop
- Touch drag emulation for mobile and touch devices
- Keyboard piece selection and placement
- Progress bar and placed-piece counter
- Auto-starting timer with tab visibility pause/resume behavior
- Local per-puzzle progress persistence in `localStorage` (including rotation state)
- Local per-puzzle personal best tracking in `localStorage`
- Completion modal with replay flow
- Undo / redo (in-memory move history stack, up to 50 states; Cmd/Ctrl+Z / Cmd/Ctrl+Y shortcuts)
- Hint system (highlights the target cell for the selected or next unplaced piece for 1.8 s)
- Zoom and pan (mouse wheel / toolbar buttons; pan by pointer drag when zoomed in; fit-to-viewport reset)
- Reference image overlay (hold the Reference button or key to peek at the full source image; auto-dismisses on release or window blur)
- Piece rotation mode (optional; toggled before first placement; pieces must be upright to place; rotation state persisted and undoable)

### Admin experience

The current admin product supports content creation and moderation:

- Passkey-based authentication
- Session-protected admin routes
- Upload flow with client-side image preview
- Optional category assignment
- Async cloud generation with progress polling
- Status-aware admin list for `processing`, `ready`, and `failed` puzzles
- Delete and force-delete actions

### Platform scope

The deployed product architecture uses a Cloudflare-native backend:

- Hono API routes for public and admin operations
- Cloudflare Worker serving API routes and static web assets
- Cloudflare Workflow for async piece generation
- Durable Object for authoritative metadata updates
- KV for cached metadata, session keys, and rate-limit state
- R2 for original images, thumbnails, and generated piece images

---

## Requirements Status

### 1. Player discovery and gallery

| Requirement                              | Status          | Notes                                                                  |
| ---------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| Gallery loads available puzzles from API | Implemented     | Public gallery calls `GET /api/puzzles` and renders ready puzzles only |
| Empty, loading, and error states         | Implemented     | All major gallery states are handled in UI                             |
| Category filtering                       | Implemented     | `All` plus 7 categories; filtering is client-side                      |
| Category badges on puzzle cards          | Implemented     | Badge is shown when a puzzle has a category                            |
| Search                                   | Not implemented | No text search UI or search endpoint exists                            |
| Pagination / infinite scroll             | Not implemented | Gallery loads all ready puzzles in one response                        |

**Implementation references:** `apps/web/src/routes/+page.svelte`,
`apps/web/src/lib/components/PuzzleCard.svelte`,
`apps/web/src/lib/components/CategoryFilter.svelte`, `packages/types/src/index.ts`

### 2. Puzzle gameplay

| Requirement                           | Status      | Notes                                                                                                                                        |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Board rendering and piece tray        | Implemented | Grid board and shuffled inventory are fully wired                                                                                            |
| Mouse drag-and-drop placement         | Implemented | Uses HTML drag and drop on board cells                                                                                                       |
| Touch drag support                    | Implemented | Touch gestures synthesize drag/drop events                                                                                                   |
| Keyboard placement                    | Implemented | Pieces and drop zones support keyboard interaction                                                                                           |
| Incorrect placement feedback          | Implemented | Rejected piece gets temporary shake feedback                                                                                                 |
| Progress bar and placed-piece counter | Implemented | Visible during play                                                                                                                          |
| Completion modal with replay          | Implemented | Includes final time and replay/back actions                                                                                                  |
| Hint system                           | Implemented | `getHintPieceId` selects target piece; board cell glows for 1.8 s; toolbar Hint button triggers flow                                         |
| Undo / redo                           | Implemented | In-memory `createHistory` stack (cap 50); covers placements and rotation changes; Cmd/Ctrl+Z/Y shortcuts wired                               |
| Zoom / pan                            | Implemented | Mouse-wheel zoom, toolbar +/− buttons, pointer-drag pan when zoomed, fit-to-viewport reset via `ZoomableBoardFrame`                          |
| Reference image overlay               | Implemented | Hold-to-peek via `ReferenceOverlay`; served from `GET /api/puzzles/:id/reference`; hidden when no reference exists                           |
| Piece rotation mode                   | Implemented | Optional mode toggled before first placement; 90° clockwise per click; upright required to place; seeded random init; persisted and undoable |

**Implementation references:** `apps/web/src/routes/puzzle/[id]/+page.svelte`,
`apps/web/src/lib/components/PuzzleBoard.svelte`,
`apps/web/src/lib/components/PuzzlePiece.svelte`,
`apps/web/src/lib/components/PuzzleToolbar.svelte`,
`apps/web/src/lib/components/ReferenceOverlay.svelte`,
`apps/web/src/lib/components/ZoomableBoardFrame.svelte`,
`apps/web/src/lib/services/gameplay/history.ts`,
`apps/web/src/lib/services/gameplay/hints.ts`,
`apps/web/src/lib/services/gameplay/rotation.ts`,
`apps/web/src/lib/services/gameplay/viewport.ts`

### 3. Timer, replay, and personal progress

| Requirement                         | Status          | Notes                                                                              |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| Game timer                          | Implemented     | Starts on first placement or first piece rotation                                  |
| Pause timer when tab becomes hidden | Implemented     | Visibility-aware timer behavior exists                                             |
| Personal best per puzzle            | Implemented     | Stored locally only                                                                |
| Completion count per puzzle         | Implemented     | Stored locally only                                                                |
| Resume in-progress puzzle           | Implemented     | Restores placed pieces, rotation mode, and per-piece rotations from `localStorage` |
| Cross-device progress sync          | Not implemented | No player account or server-side progress                                          |
| Global / shared stats               | Not implemented | No server-side score submission exists                                             |

**Important limitation:** Progress and stats are device-local only and can be lost if browser
storage is cleared.

**Implementation references:** `apps/web/src/lib/stores/timer.ts`,
`apps/web/src/lib/components/GameTimer.svelte`, `apps/web/src/lib/services/progress.ts`,
`apps/web/src/lib/services/stats.ts`

### 4. Accessibility and input coverage

| Requirement                                   | Status                | Notes                                             |
| --------------------------------------------- | --------------------- | ------------------------------------------------- |
| Keyboard support for core puzzle interactions | Implemented           | Piece selection and placement are supported       |
| Focus handling in completion modal            | Implemented           | Focus trap and focus restore behavior are present |
| ARIA roles and labels on key controls         | Implemented           | Present across puzzle and admin flows             |
| Reduced-motion-aware UI treatments            | Partially implemented | Some motion-safe / motion-reduce handling exists  |
| Screen reader placement announcements         | Not implemented       | No live region updates for gameplay events        |
| High contrast mode                            | Not implemented       | No dedicated accessibility theme exists           |
| Dedicated accessibility settings              | Not implemented       | No settings surface exists                        |

**Implementation references:** `apps/web/src/routes/puzzle/[id]/+page.svelte`,
`apps/web/src/lib/components/PuzzleBoard.svelte`,
`apps/web/src/lib/components/PuzzlePiece.svelte`,
`apps/web/src/routes/admin/+layout.svelte`

### 5. Admin authentication and route protection

| Requirement                        | Status          | Notes                                                                 |
| ---------------------------------- | --------------- | --------------------------------------------------------------------- |
| Passkey login                      | Implemented     | Admin login posts to `/api/admin/login`                               |
| Protected admin routes             | Implemented     | Client checks session before rendering protected routes               |
| Logout                             | Implemented     | Session cookie is cleared; Worker variant also revokes stored session |
| Login rate limiting                | Implemented     | 5 attempts per window with lockout behavior                           |
| Player accounts                    | Not implemented | Admin is the only authenticated role                                  |
| Multiple admin roles / permissions | Not implemented | Single admin role only                                                |

**Implementation references:** `apps/web/src/routes/admin/login/+page.svelte`,
`apps/web/src/routes/admin/+layout.svelte`, `apps/api/src/routes/admin.worker.ts`,
`apps/api/src/middleware/auth.worker.ts`,
`apps/api/src/middleware/rate-limit.worker.ts`

### 6. Admin content management

| Requirement                         | Status          | Notes                                                                                                                             |
| ----------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Upload image and create puzzle      | Implemented     | Name, optional category, and image upload are supported; original image is persisted in R2 and used as the player reference image |
| Image validation                    | Implemented     | File size and MIME validation are enforced                                                                                        |
| Category assignment                 | Implemented     | Uses shared category list                                                                                                         |
| Async processing status             | Implemented     | Admin list shows `processing`, `ready`, and `failed`                                                                              |
| Processing progress display         | Implemented     | Generated piece count is shown while processing                                                                                   |
| Delete ready puzzle                 | Implemented     | Available in admin list                                                                                                           |
| Force-delete processing puzzle      | Implemented     | Explicit force-delete flow exists                                                                                                 |
| Edit puzzle metadata after creation | Not implemented | No rename, recategorize, or republish flow exists                                                                                 |
| Schedule puzzle publication         | Not implemented | No scheduling or publish date support exists                                                                                      |
| Daily challenge assignment          | Not implemented | No date-based featured puzzle model exists                                                                                        |

**Implementation references:** `apps/web/src/routes/admin/+page.svelte`,
`apps/api/src/routes/admin.worker.ts`, `packages/types/src/index.ts`

### 7. Backend and platform operations

| Requirement                          | Status          | Notes                                                                                                                                                                 |
| ------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public API for ready puzzles         | Implemented     | Public API exposes ready content only                                                                                                                                 |
| Admin API for all puzzle states      | Implemented     | Admin API includes processing and failed items                                                                                                                        |
| Static asset serving from API Worker | Implemented     | Production Worker also serves web assets                                                                                                                              |
| Async cloud puzzle generation        | Implemented     | Cloudflare Workflow processes uploads                                                                                                                                 |
| Strongly consistent metadata updates | Implemented     | Durable Object is authoritative                                                                                                                                       |
| Cached metadata store                | Implemented     | KV is used as an eventually consistent cache                                                                                                                          |
| Public reference image endpoint      | Implemented     | `GET /api/puzzles/:id/reference` serves original image from R2; `hasReference` field on puzzle responses reflects R2 presence; graceful degradation if R2 unavailable |
| Observability / invocation logs      | Implemented     | Pulumi enables Worker observability and logs                                                                                                                          |
| Product analytics / event tracking   | Not implemented | No analytics SDK or event pipeline exists                                                                                                                             |
| Realtime multiplayer infrastructure  | Not implemented | No room model, websocket flow, or shared player state exists                                                                                                          |

**Implementation references:** `apps/api/src/worker.ts`,
`apps/api/src/routes/puzzles.worker.ts`, `apps/workflows/src/index.ts`,
`packages/infrastructure/src/index.ts`, `packages/infrastructure/src/workers.ts`

---

## Current Product Constraints

### Fixed production puzzle size

The current production upload flow is intentionally fixed to **225 pieces (15x15)**. The web
admin UI hard-codes this value, shared types define `DEFAULT_PIECE_COUNT = 225`, and the Worker
admin route rejects other piece counts.

This is the most important current gameplay constraint and should be treated as part of the
product baseline until a broader difficulty or piece-count strategy is implemented.

### Public content visibility

Only puzzles with `status: 'ready'` are visible in the public gallery and public puzzle routes.
Processing or failed puzzles remain admin-only.

### Local-only player state

Player progress and best times are stored only in the browser. There is no user identity, no
server-side progress backup, and no shared leaderboard submission path.

### Single-theme product

The current UI ships in a dark neon visual style. There is **no theme toggle**, even though the
product already presents a dark visual treatment.

### Storage model is content-first, not player-first

The current storage stack is optimized for puzzle metadata and generated assets, not for
user-centric features such as leaderboards, cross-device sync, social graphs, or long-lived
player profiles.

### Dual runtime parity is not perfect

The repo still contains Bun and Worker runtime variants. The current product baseline should be
considered the **Cloudflare Worker path**, since that is the production architecture and the more
fully hardened implementation.

---

## Roadmap

### Now: strengthen the current single-player product

| Initiative                                 | Status      | Why it matters                                                                                  |
| ------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| Add real product analytics                 | Not started | The repo currently has no code-backed DAU, retention, or funnel metrics                         |
| Close single-player usability gaps         | Done        | Reference image, hints, zoom/pan, undo/redo, and piece rotation were all shipped in this period |
| Resolve piece-count strategy               | Not started | Current 225-piece lock limits casual entry and runtime parity                                   |
| Finish realistic puzzle E2E coverage       | In progress | Gallery E2E exists, but full puzzle interaction coverage depends on seeded puzzle fixtures      |
| Add admin edit and content lifecycle tools | Not started | Admins can create and delete content but cannot edit, schedule, or stage it                     |

**Recommendation:** Keep the next phase focused on the existing solo experience before adding
community or social features.

### Next: add repeat-play loops and server-backed competition

| Initiative                   | Status      | Notes                                                                       |
| ---------------------------- | ----------- | --------------------------------------------------------------------------- |
| Daily challenge              | Not started | Natural next step for repeat engagement, but needs server-backed scheduling |
| Leaderboards                 | Not started | Requires new persistence and anti-abuse design                              |
| Player identity / cloud sync | Not started | Prerequisite for cross-device progress and durable competition              |
| Admin scheduling             | Not started | Needed to manage featured or date-based content                             |
| Admin analytics dashboard    | Not started | Depends on product analytics instrumentation                                |

**Recommendation:** Treat `daily challenge + leaderboard + player identity` as one coherent
product wave rather than isolated features.

### Later: expand beyond the single-player core

| Initiative                        | Status      | Notes                                                     |
| --------------------------------- | ----------- | --------------------------------------------------------- |
| Achievements / progression system | Not started | Depends on reliable player identity and event tracking    |
| Share completion                  | Not started | Best paired with server-backed stats or daily challenge   |
| PWA / offline support             | Not started | Requires service worker and offline asset strategy        |
| Multiplayer co-op                 | Not started | Requires new realtime architecture and shared state model |
| Advanced difficulty modes         | Not started | Includes rotation or broader piece-count personalization  |
| Sound effects                     | Not started | Pure UX enhancement, not core product leverage yet        |

---

## Metrics & Analytics Status

### Current status

The repository does **not** contain a product analytics pipeline. There is no evidence-backed
DAU, retention, session duration, abandonment, or conversion reporting in the codebase today.

### What is measurable today

| Area                     | Current availability   | Notes                                                                         |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| Puzzle processing state  | Available              | Admin UI exposes `processing`, `ready`, and `failed` plus generation progress |
| Workflow / platform logs | Available              | Worker observability and invocation logs are configured in infrastructure     |
| Player personal best     | Available locally only | Stored in browser `localStorage`, not aggregated                              |
| Player completion count  | Available locally only | Stored per puzzle in `localStorage`, not reported centrally                   |
| Product funnel metrics   | Not available          | Requires analytics implementation                                             |
| Retention / DAU          | Not available          | Requires analytics implementation                                             |

### Recommended first analytics events

When analytics is added, the first event set should stay close to the current product:

- `gallery_viewed`
- `category_filtered`
- `puzzle_opened`
- `first_piece_placed`
- `puzzle_completed`
- `puzzle_abandoned`
- `personal_best_beaten`
- `admin_login_succeeded`
- `admin_upload_started`
- `puzzle_generation_failed`
- `puzzle_generation_completed`

### Suggested first measurable KPIs

Once instrumentation exists, the first dashboard should answer:

- How many players open a puzzle after viewing the gallery?
- What percent of started puzzles are completed?
- Which categories drive the highest start and completion rates?
- How often are puzzles replayed to improve personal best?
- How reliable is generation success or failure by upload?
- How long does generation take end-to-end?

---

## Quality & Testing Status

### Automated testing in the repo

| Area                        | Current status                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Web component / route tests | Strong coverage across core routes, components, services, stores, and the new gameplay services (history, hints, rotation, viewport) |
| API tests                   | Strong coverage across routes, storage, auth, rate limiting, and Worker variants; branch coverage improved from ~81.9% to ~92.1%     |
| Workflow tests              | Good unit coverage around helper logic, types, DO logic, and workflow behavior                                                       |
| End-to-end tests            | Present but partial; gallery coverage is stronger than full puzzle solving coverage                                                  |

### Current E2E gap

The web E2E suite covers the gallery and basic puzzle route behavior, but several
interaction-heavy puzzle tests are still skipped because the suite lacks a deterministic seeded
puzzle strategy in CI.

### Recent engineering direction

The period from 2026-03-31 to 2026-04-25 delivered two distinct phases:

1. **Feature expansion** — Hints, undo/redo, zoom/pan, reference image overlay, and piece
   rotation were all shipped as part of the gameplay controls work (Tasks 2 and 3). The public
   reference image API (`GET /api/puzzles/:id/reference`) and the `hasReference` field were added
   to both Bun and Worker routes.

2. **Stabilization and coverage hardening** — After the feature work landed, a focused set of
   commits improved branch coverage from approximately 81.9% to 92.1% in the API, added Worker
   route tests for admin and puzzle paths, refactored test helpers, and fixed several edge-case
   bugs (duplicate completion, undo of solved state, rotation toggle lock, pointer ID tracking,
   magic-byte image validation, pan state on blur, seeded random normalization).

---

## Risks & Dependencies

### Product risks

| Risk                                | Impact                                                  | Mitigation                                                                                                           |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No analytics baseline               | Product prioritization remains guess-driven             | Implement analytics before setting user growth targets                                                               |
| Local-only progress and stats       | Player history is lost across devices or storage clears | Add player identity and cloud sync before promising durable progression                                              |
| Fixed 225-piece production flow     | Limits onboarding flexibility and product breadth       | Decide whether to keep a single canonical difficulty or reintroduce multiple piece counts                            |
| No server-backed competition model  | Daily challenge and leaderboards cannot launch cleanly  | Add persistence designed for rankings and submissions                                                                |
| Admin tooling is create/delete only | Content ops may become cumbersome as the catalog grows  | Add edit, scheduling, and operational views                                                                          |
| E2E interaction coverage gap        | Regression risk for the new gameplay controls           | Add seeded puzzle fixtures in CI so hint, undo/redo, zoom, rotation, and reference flows can be exercised end-to-end |

### Technical dependencies for future roadmap

- **Leaderboards, daily challenge, and accounts** need new server-side persistence and player
  identity
- **Multiplayer** needs realtime shared state, likely via Durable Object room coordination or
  another realtime transport
- **PWA / offline** needs a service worker, cache policy, and offline asset lifecycle design
- **Advanced analytics** needs event collection, storage, privacy policy, and dashboarding
  choices

---

## Appendix

### Key implementation references

- Web gallery: `apps/web/src/routes/+page.svelte`
- Puzzle play route: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Puzzle board: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Puzzle piece interactions: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Puzzle toolbar (undo/redo, hint, reference, zoom, rotation controls): `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Reference overlay: `apps/web/src/lib/components/ReferenceOverlay.svelte`
- Zoom/pan board frame: `apps/web/src/lib/components/ZoomableBoardFrame.svelte`
- Undo/redo history helper: `apps/web/src/lib/services/gameplay/history.ts`
- Hint strategy helper: `apps/web/src/lib/services/gameplay/hints.ts`
- Rotation helpers (normalize, clockwise, seeded random init): `apps/web/src/lib/services/gameplay/rotation.ts`
- Viewport helpers (clamp zoom/pan, fit-zoom): `apps/web/src/lib/services/gameplay/viewport.ts`
- Timer: `apps/web/src/lib/stores/timer.ts`
- Local progress (includes rotation state): `apps/web/src/lib/services/progress.ts`
- Local stats: `apps/web/src/lib/services/stats.ts`
- Admin UI: `apps/web/src/routes/admin/+page.svelte`
- Admin auth gate: `apps/web/src/routes/admin/+layout.svelte`
- API Worker entry: `apps/api/src/worker.ts`
- Public puzzle routes (includes reference endpoint): `apps/api/src/routes/puzzles.worker.ts`
- Admin routes: `apps/api/src/routes/admin.worker.ts`
- Worker auth: `apps/api/src/middleware/auth.worker.ts`
- Worker rate limit: `apps/api/src/middleware/rate-limit.worker.ts`
- Workflow and Durable Object: `apps/workflows/src/index.ts`
- Shared product types: `packages/types/src/index.ts`
- Cloudflare infrastructure: `packages/infrastructure/src/index.ts`,
  `packages/infrastructure/src/workers.ts`

### Explicitly out of current scope

These features are not present in the implementation and should be treated as future work rather
than current commitments:

- Daily challenge
- Leaderboards
- Achievements
- Social sharing
- Multiplayer
- Player accounts
- Cloud progress sync
- PWA / offline mode
- Admin analytics dashboard
- Admin scheduling / publish controls
- Theme toggle
- Sound effects

---

## Document History

| Version | Date         | Author       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1     | 2026-04-25   | Claude Code  | Updated status fields to reflect April 2026 feature work: hints, undo/redo, zoom/pan, reference image overlay, and piece rotation are all implemented; added public reference image API row; updated progress persistence note to include rotation state; marked "Close single-player usability gaps" roadmap item as Done; updated test coverage figures; added E2E interaction coverage gap to risks; removed now-implemented items from out-of-scope list; added new gameplay service implementation references; updated Document History |
| 2.0     | 2026-03-31   | Copilot      | Rewrote PRD to match implemented repository status, current constraints, and realistic roadmap                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1.0     | January 2026 | Product Team | Initial aspirational PRD with future feature requirements                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
