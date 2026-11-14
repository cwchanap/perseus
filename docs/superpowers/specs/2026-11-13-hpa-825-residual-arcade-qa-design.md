# HPA-825 — Remaining Arcade QA: Evidence-First Design

**Linear:** [HPA-825](https://linear.app/cwchanap/issue/HPA-825/verify-remaining-arcade-qa-upload-persistence-drag-and-cold-paint)  
**Original report:** [GitHub #86](https://github.com/cwchanap/perseus/issues/86)  
**Previous remediation:** [PR #138](https://github.com/cwchanap/perseus/pull/138), merged 2026-10-28; [its implementation plan](../plans/2026-10-23-issue-86-qa-remediation.md)  
**Code baseline:** `main` at `0fe71b87ac43cc3e275d1c8834c0506099650eb2`, inspected 2026-11-13. Production deployment commit and fresh runtime behavior have **not** been verified.  
**Delivery:** One PR for this ticket, starting with design/plan only; continue any reproduced fix on the **same PR**.

## Problem and scope

PR #138 already implemented the confirmed frontend fixes from #86: persistent upload feedback and profile link, decode-safe upload previews, URL-derived gallery filters, clearer Continue/empty-state copy, malformed-ID recovery, title tooltips, and the dark theme color. Pause and action-menu accessibility were already fixed.

Three **unresolved verification questions** remain, not three established code defects:

1. Does an authenticated **production** image upload persist as an owned puzzle and appear on the player's profile after reload?
2. Does a **real mouse/trackpad** drag place a puzzle piece and update progress, or was the original failed attempt caused by browser automation?
3. Does a **cold navigation** still flash white/blank before the dark arcade shell, and if so at which paint stage?

The desired outcome is a defensible disposition for each question: **fixed**, **not reproducible**, **intended behavior**, or **explicitly deferred** with the missing access/environment and next owner/action. Only a reproduced defect authorizes a code change.

## Existing seams and assumptions

### Upload and ownership

- `apps/web/src/routes/upload/+page.svelte` normalizes the selected image, calls `createPlayerPuzzle`, keeps a success status, and links to `/profile`. The selected image is decoded before preview; original file size is not compared to the server's normalized 10 MB limit.
- `apps/web/src/lib/services/api.ts` sends `POST /api/puzzle-families` with credentials. The route in `apps/api/src/routes/puzzle-families.worker.ts` writes the original image, family/variant metadata, and the D1 ownership row (initially `processing`), then starts a Workflow **before** returning HTTP 201.
- `GET /api/player/puzzle-families` is the owned-family read; `apps/web/src/routes/profile/+page.svelte` displays the owned list, including processing/failed entries. Public gallery playability is a **separate later state** (`ready`) and must not be confused with upload persistence.
- These code paths make a persistence failure *possible to diagnose*, not safe to assert without an authenticated trace. A 201 by itself does not establish profile visibility.

### Drag/placement

- `apps/web/src/lib/components/PuzzlePiece.svelte` sets `DataTransfer` in `dragstart`. `PuzzleBoard.svelte` accepts `dragover`/`drop` and sends a placement attempt to the existing `PuzzleSession` flow through the puzzle route.
- `apps/web/e2e/gameplay-interactions.spec.ts` exercises mouse drag; `e2e/support/gameplay-page.ts::placeWithMouse` first tries Playwright `dragTo()` **then falls back to dispatching synthetic DnD events**. A passing test proves handling of a drop, **not necessarily native pointer delivery**.
- The harness already documents a WebKit automation limitation (`e2e/README.md`, HPA-517 spike: `dragTo()` 0/20 on mobile WebKit). Do not treat this as evidence of a human-visible gameplay defect. Existing tap-to-place and keyboard alternatives are separate supported paths.

### First paint

- `apps/web/src/routes/layout.css` paints both `html` and `body` with `--bg-0: #0a0620`; `apps/web/src/app.html` already has matching `theme-color`.
- A white browser canvas before the CSS paints, an empty *dark* app shell during hydration, and a slow gallery data render are different phenomena. Measure which, if any, occurs before changing the shell.

## Decision rules

| Question | Evidence to collect | Decision |
| --- | --- | --- |
| Authenticated upload | Deployed build/commit, authorized account (redacted), image type/size, upload request status and returned family ID, owned-family list (including pagination), profile appearance on reload, later status | If 201 + owned `processing`/`ready` row is visible: persistence works. If non-2xx or 201 + missing row after controlled reload, trace the failing stage and fix only that failure. An item pending processing not yet in the *public gallery* is intended. |
| Real drag | Browser/OS, actual pointer input, visible tray source and target, before/after placed count, board/tray states, and whether local saved progress survives navigation | A manually successful drag closes the question. If native pointer fails reproducibly, isolate event delivery vs rejected placement before modifying piece/board handlers. Synthetic E2E alone is insufficient. |
| Cold first paint | Browser/OS, full navigation versus client-side transition, cache state, screen recording or timestamped frame capture, visible background, network/console signals | If no flash is observed in repeat cold loads: not reproducible on recorded environments. If a flash occurs, classify pre-CSS canvas / hydration gap / route-content loading and patch only its actual cause. |

When the production login or a physical browser is unavailable, mark the check **unverified/deferred**, not passing. Do not introduce live-account credentials into tests, logs, commits, screenshots, or the PR.

## Design boundaries

- Keep new behavior local to the actual failing seam, if one is demonstrated. Reuse existing upload API, ownership repository, `PuzzleSession`, DnD handlers, SvelteKit routes, and Playwright fixtures.
- No redesign of upload, new status polling, gallery/profile data model, D1 migration, schema change, global event bus, drag abstraction, loading-screen framework, or speculative engine rewrite.
- Do not duplicate PR #138's shipped improvements or broaden into generic arcade polish.
- Do not manufacture production-access or timing results. A documentation-only draft is a planning artifact, **not proof that QA passed**.
- No new UI art or sound effects are needed; any future asset request must be scoped separately.

## Review and acceptance UX

The Linear ticket has **no UI mockup attached** (it links to the original QA issue). Compare the actual UI visually with the **existing** arcade design and the current shipped screens. If a Linear mockup is later attached, add an explicit side-by-side comparison before closing the ticket.

The manual end-to-end target is the **web** experience on macOS (Chrome/Safari, real mouse/trackpad), Windows (Chrome/Edge, real mouse), and iOS (Safari, tap-to-place and first navigation; do not require HTML5 desktop drag on touch). Record OS/browser, production URL and deployment, and a concise pass/fail/deferral for every applicable check. Android/Linux are not additional manual acceptance targets; retain the project's existing CI coverage.

See the [implementation and verification plan](../plans/2026-11-13-hpa-825-residual-arcade-qa.md) for the order of operations, bounded fix branches, tests and end-to-end acceptance criteria.
