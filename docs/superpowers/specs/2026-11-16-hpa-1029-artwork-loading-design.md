# HPA-1029 — Reliable first-load and completion artwork

Linear: https://linear.app/cwchanap/issue/HPA-1029

## Goal and observed symptoms

A signed-out playtest reported blank Gallery cards on a cold visit, dark tray slots for 30+ seconds in **Shojo Crystal Waltz** until reload, and a blank completed-artwork panel for 10–20 seconds in **Shojo Conservatory Reader** even on a return visit. Board/tray art loaded in 1–2 seconds during the likely warm-cache visit. The reference overlay did work on that return visit; its earlier reported failure is withdrawn.

**Two distinct concerns:** (1) the code already has a deterministic missing loading/failure presentation for images; fix this without requiring a production slowdown to reproduce. (2) the actual latency root cause remains unknown; investigate cold/warm timings *before* modifying R2/KV delivery, preload or caching behavior. Showing a fallback is not itself proof that the loading delay is resolved.

## Existing owners inspected on main (2026-11-17)

- **Gallery:** `apps/web/src/lib/components/PuzzleCard.svelte` uses `getFamilyThumbnailUrl` with a native lazy `<img>` and `thumbnailError`; pending looks like a dark card, and error state can remain stale when the card's family changes.
- **Gameplay:** `puzzleSource.ts` maps API pieces to `getPieceImageUrl` and local quick puzzles to blob URLs; `PuzzlePiece.svelte` and `PuzzleBoard.svelte` render images without status handling. Preserve piece masks, drag/rotation, keyboard placement and quick-puzzle URLs.
- **Completion:** `PuzzleCompletionDialog.svelte` renders the same reference URL in the results preview and full-artwork view. A missing URL gets a fallback; a nonempty URL that is slow or fails produces an unexplained dark area. Keep the existing board reveal, completion recording and modal focus.
- **Related surfaces:** `ReferenceOverlay.svelte` resets its `imageError` flag on activation rather than URL changes; the Gallery route's Continue panel has a separate `resumeImageError` flag. Remove these duplicate behaviors while touching the shared image primitive, but do not redesign their UX.
- **API:** `puzzles.worker.ts` serves piece/reference/variant thumbnails; `puzzle-families.worker.ts` serves family thumbnails. All use `storage.worker.ts:getImage()` and a 24-hour public cache header. The helper awaits `R2Bucket.get` and `arrayBuffer()` before returning. This is only a possible latency contributor.
- **Test infrastructure:** `apps/web/e2e/gameplay-fixtures/fixture-router.ts` intercepts known fixture image URLs. `gameplayPage` and its deferred completion/auth patterns provide a starting point; do not add a second gameplay harness.

## A. Deterministic UI fix — implement first

Add one small Svelte action `apps/web/src/lib/actions/imageStatus.ts`, following the existing action convention:

- Parameter: `{ src, onStatus? }`; state is `pending | loaded | error`, reflected on the actual image as `data-image-state`. Attach native `load`/`error` listeners, remove them on destroy, and notify a supplied callback only when status changes.
- On mount, handle an already-cached image (`node.complete && node.naturalWidth > 0`) as loaded. Avoid treating an empty/unassigned source as a failed image.
- On `update()`, reset to pending only when `src` changes; a new callback object or unrelated rerender must not restart the status. A new URL must recover from a prior failure. Preserve image element ownership long enough for status updates; do not permanently unmount an errored image in a way that prevents recovery.
- Adopt it at ready Gallery cards, inventory pieces, placed pieces, completion preview and full artwork, reference overlay and Continue artwork. Replace `thumbnailError`, `imageError` and `resumeImageError` rather than layering another independent flag over them.
- Use existing layout for visible pending and error treatments: a subtle loading placeholder and a clear unavailable state, without changing actual source URLs or blocking gameplay. A placed piece can retain its cell; an unavailable image must not make placement or completion state lie. Preserve offscreen Gallery lazy loading, existing pointer/keyboard handlers and local blob URLs.

Keep this as a small DOM/action + component presentation change. No image manager, asset preloader, global store, new artwork, or SFX.

## B. Measure performance per surface; gate server changes

After the deterministic UI fix, trace in a **fresh signed-out browser context with disabled cache**, then warm reload. Record *separately* for a visible Gallery card, an in-game piece, and completion reference art:

1. Exact puzzle/difficulty/piece count, number of piece image requests in flight at first tray paint, request initiator, start/TTFB/finish, HTTP status/content type/size/cache indicators, failures/cancellations, and warm cache behavior.
2. DOM image availability, `complete`, `naturalWidth`, native events/optional `decode()`, and first visible render timing. Capture representative screenshots; do not interpret missing cross-origin timing fields as zero.
3. Per-surface classification: request scheduling, network/API/R2 latency, decode failure/latency, DOM/paint or not reproduced. Record a disposition for each row, even when results differ across surfaces.

**Server-side changes require positive evidence, per affected surface.** Several independent causes may be found, so allow only the minimum justified fix or fixes; do not force an unrelated symptom into one cause. Validate these candidates, without assuming them:

| Evidence | Smallest authorized response |
| --- | --- |
| URL is wrong / expected asset 404s or 5xx | Repair only the identified existing source/route; retain truthful UI fallback |
| Per-piece response latency dominated by variant metadata reads | Measure existing `resolvePlayableVariant` KV reads and request concurrency first; optimize only the demonstrated bottleneck |
| R2 buffering dominates | Evaluate streaming from the existing image helper while preserving endpoint semantics, response body bytes/content type/cache headers and error handling; inspect all helper callers |
| Network completes but decode/paint remains slow | Investigate browser-side sizing, decode or rendering specifically; do not blame KV/R2 |
| Completion reference is first requested too late | Consider narrowly-scoped reuse/early retrieval of the **same** URL only if timing proves benefit without starving piece downloads |
| No production slowdown reproduced | Ship the deterministic status fix, record negative findings and keep performance unverified rather than claiming the 10–30 s delay was fixed |

No generic preloading of 100+ pieces, CDN, signed URL, new cache store or retry loop without measured justification.

## C. Verification strategy

- Extend the **existing** deterministic gameplay fixture interception with a narrowly scoped delayed/failing image option and a hold handle following the existing `DeferredHandle` `release()`/`cancel()`/`pendingCount` contract. Ensure teardown asserts no held image routes remain. Cover Gallery thumbnails through the same controlled image-response helper or an equally scoped existing Gallery route setup; do not create one-off untracked holds in each test.
- Action unit tests cover loaded cache, pending-to-loaded/error, a URL change after error, no duplicate callbacks, and cleanup. Browser specs check `data-image-state` **and** actual decoded image readiness (`naturalWidth > 0` or equivalent), so a falsely marked loaded attribute cannot pass.
- One MCP-driven end-to-end browser journey is sufficient for shared web UI; it can run/inspect the committed Playwright paths rather than duplicating their scenarios. If backend image delivery changes, use MCP to exercise the **real Worker → R2 image route → browser**, not solely fixture-fulfilled requests; supplement with focused storage/route tests.
- Use MCP-driven **visual screenshot checks** at desktop and narrow widths. Compare to an attached Linear mockup if one becomes available, otherwise to the shipped Galaxy Arcade UI and before/after captures. This is automated visual verification, **not** a human approval gate and **not** a new pixel-baseline test framework.

## Constraints and scope

**One implementation PR for HPA-1029:** continue working in draft PR #181 rather than opening another PR. UI presentation changes are allowed immediately; only server/performance architecture remains evidence-gated. No changes to `PuzzleSession`, completion recording, stats, persistence schema, routing contracts or compatibility layer.

Exclude [HPA-825](https://linear.app/cwchanap/issue/HPA-825) (cold shell/production upload/pointer QA), [HPA-1032](https://linear.app/cwchanap/issue/HPA-1032) (tray overflow and Gallery spinner/labels), and [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028) (general harness hardening). Image-specific held/fail fixture coverage is in scope; a harness rewrite is not. No generated art or SFX; scope any future new assets into a separate task.

## Risks

A cold production trace may not reproduce the historical slowdown. The deterministic UI bug remains valid and testable independently; keep the latency disposition explicitly **unverified** in that case. A broken/slow image can trigger a stale error flag if the source changes; the shared action and tests must cover this. Do not treat successful fixture responses or screenshot presence alone as evidence that real R2 requests are fast.
