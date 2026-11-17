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
- **Visibility and lazy loading:** Keep each `<img>` mounted for nonempty URLs. Hide an unready/broken image with `opacity: 0`, **not `display: none`**: `PuzzleCard.svelte` uses `loading="lazy"`, and removing it from layout can prevent intersection-triggered loading or recovery after the URL changes. Place placeholders in an independent container layer; do not change URLs or block gameplay.
- **Piece and board indicators:** The PNG/SVG jigsaw image is intentionally in a **140%** expanded wrapper, offset by **-20%** for tabs. Put pending/error UI on the **100%** outer tray `.piece-slot` and board `.drop-zone` cell (with a local `onStatus` callback or scoped `:has([data-image-state=...])` selector). Avoid a background/border on the enlarged image or shadow wrapper that spills over neighbors; preserve stacking, actual tabs, placement, rotation and keyboard access.
- **Completion artwork:** The results preview **already has** a responsive width and `aspect-ratio: 3 / 4` on `.completion-reference-art`; reuse that frame for pending/error overlays rather than inventing a new sizing rule. A nonempty image URL currently lacks an error fallback. The full-artwork subview has no status fallback, and the `width: auto; height: auto` image cannot reserve visible dimensions before load: give its containing stage a bounded, nonzero pending/error placeholder while preserving the actual artwork aspect when loaded. Show a clear unavailable message on failure in both views. Preserve the null/`''` URL behavior (no broken `<img>` or inconsistent VIEW ARTWORK entry), results layout, focus trap and full-artwork navigation.
- **Continue art:** The Gallery resume image is a decorative background behind the progress ring, title and overlay; hide it silently when pending/error without placing an 'unavailable' caption behind the content.
- **Gallery:** Keep offscreen thumbnail lazy loading, dimensions, bookmarks, card affordances, filters and title behavior. A visible pending thumbnail must have a recognizable frame rather than an inexplicable dark panel.

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

- Create one **small reusable image-response hold/fail helper** with the existing `DeferredHandle`-style `release()`/`cancel()`/`pendingCount` and `assertClean()` semantics; do not build a generic request orchestration framework. Wire it into `fixture-router.ts` for gameplay fixture `/api/puzzles/<fixture-id>/pieces/:n/image`, `/reference`, and `/thumbnail`. Ensure `gameplayPage.assertSettled()` validates its pending routes. Preserve fixture provenance and method/unknown-path checks.
- **Gallery is a separate route:** `Gallery` uses `/api/puzzle-families/:familyId/thumbnail`, which is **not** intercepted by the gameplay fixture router. Reuse the tiny response helper in `gallery.spec.ts`'s own image route and assert its cleanup with `afterEach`/`finally` regardless of test outcome. Do **not** rely on `gameplayPage.assertSettled()` for Gallery: it is a no-op when `gotoFixture()` was not called.
- In `e2e/support/diagnostics.ts`, explicitly declare only the expected fixture image failure/abort URL and outcome for intentional negatives: retain strict provenance, request method, unexpected HTTP status and unrelated failed-request/page/console checks. Where a browser logs a failed-resource console error, scope handling to that declared request as narrowly as possible; never turn off diagnostics or globally ignore all 404s. Gallery tests must assert the intended 404 and their own hold cleanup instead of bypassing checks.
- Action unit tests cover loaded cache, pending-to-loaded/error, a URL change after error, no duplicate callbacks, and cleanup. Browser specs check `data-image-state` **and** actual decoded image readiness (`naturalWidth > 0` or equivalent), so a falsely marked loaded attribute cannot pass.
- **MCP executes/inspects the committed Playwright end-to-end suite** for the deterministic Gallery/gameplay cases; do not replay those held-image scenarios as a second interactive browser journey. Use MCP browser inspection separately for the live cold/warm production trace (which fixture routing cannot measure), and only if backend delivery changes, a **real Worker → R2 image route → browser** smoke check. Supplement backend changes with focused storage/route tests.
- Use MCP-driven **visual screenshot checks** of the **final** Gallery, piece/cell placeholders and completion (results + full-artwork) at desktop and narrow widths. Compare with a Linear mockup if attached, otherwise inspect alignment, framing, aspect, overflow and text legibility against the shipped Galaxy Arcade design. Attach final screenshots as PR evidence; before screenshots are optional when useful, **not** a separate required baseline run. This is automated visual verification, **not** a human approval gate or a new pixel-baseline framework.

## Constraints and scope

**One implementation PR for HPA-1029:** continue working in draft PR #181 rather than opening another PR. UI presentation changes are allowed immediately; only server/performance architecture remains evidence-gated. No changes to `PuzzleSession`, completion recording, stats, persistence schema, routing contracts or compatibility layer.

Exclude [HPA-825](https://linear.app/cwchanap/issue/HPA-825) (cold shell/production upload/pointer QA), [HPA-1032](https://linear.app/cwchanap/issue/HPA-1032) (tray overflow and Gallery spinner/labels), and [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028) (general harness hardening). Image-specific held/fail fixture coverage is in scope; a harness rewrite is not. No generated art or SFX; scope any future new assets into a separate task.

## Risks

A cold production trace may not reproduce the historical slowdown. The deterministic UI bug remains valid and testable independently; keep the latency disposition explicitly **unverified** in that case. A broken/slow image can trigger a stale error flag if the source changes; the shared action and tests must cover this. Do not treat successful fixture responses or screenshot presence alone as evidence that real R2 requests are fast.
