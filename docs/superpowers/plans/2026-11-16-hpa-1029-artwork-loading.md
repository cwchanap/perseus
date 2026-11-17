# HPA-1029 — Implementation plan and end-to-end acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1029

Design: [2026-11-16-hpa-1029-artwork-loading-design.md](../specs/2026-11-16-hpa-1029-artwork-loading-design.md)

**PR rule:** Keep all implementation and tests in **draft PR #181**; no second PR for this ticket. The current PR is documentation-only until work is committed. No change to gameplay/persistence or new art/SFX.

## 1. Fix deterministic image status first

- [ ] Add `apps/web/src/lib/actions/imageStatus.ts`: native image load/error listeners; `data-image-state=pending|loaded|error`; optional callback; handle already-complete warm-cache images; change status only when `src` changes; cleanup listeners. A status callback must not induce an action update loop.
- [ ] Adopt the same action in `PuzzleCard.svelte`, `PuzzlePiece.svelte`, the placed piece image in `PuzzleBoard.svelte`, both `PuzzleCompletionDialog.svelte` images, `ReferenceOverlay.svelte` and the Gallery Continue art. Remove the three existing one-off error flags. Keep the image mounted for nonempty URLs (or explicitly recover on a source change) so an error does not permanently lock out the next URL.
- [ ] Keep pending/failed states clearly visible in the existing Galaxy Arcade styling, with modest placeholder/fallback elements. Preserve Gallery lazy loading offscreen, board/tray geometry, piece selection/drag/rotation, Continue interactions, completion focus and quick-puzzle blob URLs. Do not mark an image loaded before actual successful load, or block a puzzle run because art failed.

## 2. Deterministic regression coverage

- [ ] Unit-test the action for pending → loaded, error and recovery after changing the URL, warm-cache complete, no spurious reset on unrelated updates, callback/dispose cleanup.
- [ ] Add a **minimal image hold/fail control** to the existing fixture image response path, matching the public `DeferredHandle` release/cancel/pending-count shape and asserting no held image requests remain in `gameplayPage.assertSettled()`. Follow existing route precedence and provenance rules. Use the same controlled response helper for Gallery thumbnail cases; do not add untracked `page.route` holds per test or broaden generic HPA-1028 harness work.
- [ ] Extend current Gallery/browser and gameplay specs, not a new E2E framework: held image → visible pending → release → loaded and decoded image; failed image → explicit unavailable state; changed card/Continue/reference URL → recover from prior failure. Verify actual pixel/decode readiness (e.g., `naturalWidth > 0`) **in addition** to `data-image-state`.
- [ ] Solve a deterministic fixture puzzle, check placed piece imagery and both completion artwork surfaces, keep focus/navigation/selection/placement and local completion intact. Test recovery without requiring a full reload. Use one supported web platform and a narrow viewport; add Safari-specific cases only if evidence warrants.

## 3. Cold/warm production diagnosis (after baseline UI fix)

- [ ] MCP-driven signed-out cold-browser session against the deployed site with cache disabled, then a warm reload. Capture request waterfall and screenshots for Gallery thumbnail, tray images and completed reference art; use Shojo Crystal Waltz / Shojo Conservatory Reader when available.
- [ ] Record puzzle difficulty, actual piece count and in-flight image request count at first tray paint. Per surface log request status/MIME/size, request start/TTFB/finish, cache behavior, image decode readiness, and first visible paint. Note canceled requests or lazy scheduling versus real network stalls.
- [ ] Update the PR's existing **three-row** evidence table independently for Gallery, tray, completion. Mark fixed / no longer reproducible / unverified for each; do not equate an immediate placeholder with actual asset loading speed.

**Exit gate for server/network changes only:** concrete measurements implicate an existing Worker, KV or R2 delivery path. If no latency is reproducible, keep backend untouched and record the negative result, without claiming a speed fix.

## 4. Optional targeted backend/performance change (only if proven)

- [ ] For a proven bottleneck, touch only the relevant existing image route, `apps/api/src/services/variant-playability.worker.ts` or `apps/api/src/services/storage.worker.ts:getImage`, after checking all callers. No blind retries, new CDN, asset manifest, cache database or blanket preloader.
- [ ] If `getImage` changes, extend `apps/api/src/services/storage-coverage.worker.test.ts` for body bytes, content type/fallback, missing object and R2 failures; adjust the relevant route tests for behavior (not just mocked helper returns). Streaming is *not* automatically authorized.
- [ ] If backend changes, run a **real Worker-to-browser MCP E2E smoke journey** using a known local/staging R2 asset and route, separate from fixture interception which cannot exercise the Worker. One platform sufficient. Assert status, MIME, decoded image and failure behavior; preserve existing cache headers.

## 5. Automated end-to-end and visual acceptance

- [ ] An MCP-controlled browser/test journey verifies a cold Gallery card, pending/released/failed tray piece, successful placed piece, deterministic completed puzzle, preview plus full completed artwork, and warm reload. Reuse the committed Playwright cases and current fixtures; do **not** invent a duplicate second E2E suite. UI state alone is insufficient: verify genuine loaded image bytes/decode.
- [ ] **MCP screenshot visual check** for Gallery card, ordinary and placed tray/board pieces, completion preview and full artwork at desktop and narrow viewport. Compare to a Linear mockup if attached; HPA-1029 currently has none, so use before/after captures against the existing Galaxy Arcade UI. Check placeholders, artwork framing, overflow and readability. Save artifacts as PR evidence. No human acceptance requirement and no screenshot-baseline framework added.
- [ ] Focused component/action tests; `bun run --cwd apps/web test:unit`, `bun run --cwd apps/web test:e2e`, `bun run check`, `bun run lint`, applicable API tests and PR CI pass. Run `bun run test:unit` if any shared engine/types code changes.
- [ ] Preserve toolbar/modal focus, Gallery navigation, quick puzzle images, selection/rotation/placement, completion recording and local progress. No art/SFX or new gameplay controller.

## 6. Finish on the same PR

- [ ] Record the actual per-surface production trace and chosen or rejected backend fixes in PR #181. Note honest unresolved performance symptoms; do not assert faster loading if unmeasured.
- [ ] Attach automated screenshot/trace evidence and test/CI results. Keep the PR draft until acceptance is verified.
- [ ] Update HPA-1029 with the implementation and measured outcome; mark Done only after merge and verification.

## Risk and fallback

Production timing may not reproduce the two earlier cold visits. This does **not** block the deterministic status fix, which has held/failing image E2E coverage. It **does** block claiming a server-speed issue fixed without evidence. Keep the scope one small presentation action plus narrowly proven performance changes, not a generalized image loading subsystem.
