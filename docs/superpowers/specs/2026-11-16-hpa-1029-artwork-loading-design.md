# HPA-1029 — Reliable first-load and completion artwork

Linear: https://linear.app/cwchanap/issue/HPA-1029

## Goal and evidence

A signed-out playtest reported (1) blank Gallery cards on a cold visit, (2) dark inventory/tray slots for 30+ seconds in **Shojo Crystal Waltz** until a reload, and (3) a blank completed-artwork panel for about 10–20 seconds in **Shojo Conservatory Reader** even on a subsequent visit. A later, likely warm-cache run loaded board/tray images in 1–2 seconds. The reference overlay worked on that second visit, so the original overlay failure is **not** a confirmed continuing bug.

**Root cause has not been established.** The first implementation step is a reproducible cold/warm request-and-render trace. Neither a buffering issue nor a preload fix should be asserted without that evidence.

## Current ownership (main, inspected 2026-11-16)

- Gallery: `apps/web/src/lib/components/PuzzleCard.svelte` gets `getFamilyThumbnailUrl(family.id)`, uses a native lazy `<img>`, and shows **No preview** on `error`. It does not distinguish pending image bytes from a dark card.
- Gameplay: `apps/web/src/lib/services/puzzleSource.ts` resolves API-backed piece URLs through `getPieceImageUrl`; `PuzzlePiece.svelte` and `PuzzleBoard.svelte` place native `<img>` elements without load/error presentation. Quick puzzles instead resolve local blob URLs; preserve that path.
- Completion: `apps/web/src/routes/puzzle/[id]/+page.svelte` passes `resolveReferenceImage()` to `PuzzleCompletionDialog.svelte` after the existing final-board reveal; the dialog's preview and full-artwork views both use that reference URL. The dialog has a null-URL fallback but no pending/error handling for a nonempty URL. `ReferenceOverlay.svelte` already has an error fallback and is not a redesign target.
- API: `apps/api/src/routes/puzzle-families.worker.ts` and `apps/api/src/routes/puzzles.worker.ts` serve thumbnail, piece and reference images from R2 with `Cache-Control: public, max-age=86400`. `getImage` in `apps/api/src/services/storage.worker.ts` awaits `R2Bucket.get` **and** `obj.arrayBuffer()` before a response is constructed. This is a possible latency/memory contributor, not yet a proven cause.
- Browser E2E: `apps/web/e2e/gameplay-fixtures/fixture-router.ts` already fulfills piece/reference/thumbnail image URLs deterministically; use that and the existing `gameplayPage` fixture. Do not add a second gameplay harness.

## Diagnostic decision gate

In a **new browser context with disabled cache**, capture Gallery, entry to a known API puzzle, first tray paint, and the completed-artwork view; repeat in the same context after refresh. Record, per image URL:

1. Initiator, request start, response status/MIME/size/cache hints, response start/finish, failed or canceled requests, and whether a warm reload uses the cache.
2. Browser-side `<img>` creation/visibility, `complete`, `naturalWidth`, `load`/`error` and optional `decode()` completion. Capture timestamps and screenshots for request completion versus first visible artwork.
3. Which stage dominates: delayed/unavailable network bytes, API/R2 response time, image decode, lazy scheduling, or DOM/layout/paint. In production, distinguish same-origin from cross-origin asset requests and don't assume unavailable resource timing fields imply zero latency.
4. Repeat only the specific problematic puzzle/difficulty if initial deterministic tests do not reproduce. Preserve actual failed response URLs/status and timing evidence in the PR.

**Choose one proven cause and the smallest matching remedy:**

| Finding | Targeted solution, in order of preference |
| --- | --- |
| Incorrect URL / 404 / 5xx / canceled asset | Repair the affected existing source/route. Show an explicit loading/failure presentation where otherwise blank. Add a regression for the actual failure. Do not add blind retries. |
| API response time dominates | Inspect per-request KV/variant resolution and R2 read timing; remove only the demonstrated bottleneck. If `arrayBuffer()` is demonstrably expensive, stream the existing R2 object body from the existing image handlers while preserving content type, caching and 404/500 semantics. No new CDN, cache database, signed-URL scheme or API contract. |
| Bytes arrive promptly, but image decode/paint is late or fails | Keep the existing URL and layout; add local load/error handling (keyed to URL changes) and a visible waiting/failure treatment at the affected Gallery/tray/completion surfaces. Avoid duplicate downloads and avoid gating the entire puzzle on an offscreen/lazy Gallery asset. |
| Only the completion reference first request is late | Inspect its timing and first use. Consider loading the same existing reference URL earlier **only if** it materially improves completion without delaying initial piece rendering or consuming unnecessary bandwidth. Do not preload all variants/assets. |

Do not implement every alternative. If production timing cannot be reproduced, capture the negative evidence and obtain a deterministic failing case before changing performance architecture.

## UX contract after the fix

- Visible Gallery cards show artwork once the image is available and do not remain inexplicably dark; pending/failure states are visibly distinguishable. Keep offscreen thumbnail lazy loading, card sizing, bookmarks, category filtering and title behavior unchanged.
- The tray never looks like an unusable set of anonymous black pieces while available pieces are decoded; image failures are visibly distinguishable from legitimate transparent margins in jigsaw art. Preserve piece masks, rotation/placement, pointer/keyboard navigation and scroll behavior.
- The completion view renders the same reference artwork without a blank, unexplained dark frame while it loads. On failure, show an explicit unavailable state instead of a broken image. Keep the completed board reveal, result/copy, **VIEW ARTWORK** and modal focus behavior.
- If assets are actually unavailable, do **not** claim that images loaded or silently mark a run complete for display reasons. Completion recording and engine ownership are untouched.

## Constraints and non-goals

One implementation PR for **HPA-1029**: keep this **draft planning PR** and add the targeted code/tests to it after the trace; do not open a separate implementation PR. Reuse existing components/helpers and `PuzzleSession`; no new gallery state system, asset manifest, background preloader, persistence schema, routing contract or compatibility layer.

Do not overlap [HPA-825](https://linear.app/cwchanap/issue/HPA-825) (cold shell flash, production upload and real pointer QA), [HPA-1032](https://linear.app/cwchanap/issue/HPA-1032) (tray overflow, Gallery spinner/labels and titles), or [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028) (Playwright server reuse/fake-clock harness). No generated art or SFX; any future art/SFX work belongs in a separate ticket.

## Visual design baseline

Keep the existing shipped **Galaxy Arcade** UI: dark gallery-card frame, jigsaw-piece masks and completion gold artwork frame. No mockup or art attachment is present on HPA-1029 as of 2026-11-16. If a Linear mockup becomes available, compare screenshots with it; otherwise compare before/after screenshots to the shipped interface. UI visual acceptance is automated, not a human sign-off.
