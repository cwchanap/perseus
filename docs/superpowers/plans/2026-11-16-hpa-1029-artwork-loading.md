# HPA-1029 — Implementation plan and end-to-end acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1029

Design: [2026-11-16-hpa-1029-artwork-loading-design.md](../specs/2026-11-16-hpa-1029-artwork-loading-design.md)

**PR rule:** Keep all implementation and tests in **draft PR #181**; no second PR for this ticket. The current PR is documentation-only until work is committed. No change to gameplay/persistence or new art/SFX.

## 1. Fix deterministic image status first

- [ ] Add `apps/web/src/lib/actions/imageStatus.ts`: native image load/error listeners; `data-image-state=pending|loaded|error`; optional callback; handle already-complete warm-cache images; change status only when `src` changes; cleanup listeners. A status callback must not induce an action update loop.
- [ ] Adopt the same action in `PuzzleCard.svelte`, `PuzzlePiece.svelte`, the placed piece image in `PuzzleBoard.svelte`, both `PuzzleCompletionDialog.svelte` images, `ReferenceOverlay.svelte` and the Gallery Continue art. Remove the three existing one-off error flags. Keep the image mounted for nonempty URLs (or explicitly recover on a source change) so an error does not permanently lock out the next URL.
- [ ] Keep `<img>` mounted for each nonempty URL. Hide unready/errored images with **`opacity: 0`, not `display: none`**, so the Gallery's native `loading="lazy"` still initiates offscreen loads near the viewport and changing `src` can recover. Use a visible placeholder above the card's existing dark frame; never report loaded merely because the element exists.
- [ ] For the tray and placed board cells, render status decorations only inside the **100%** `.piece-slot` / `.drop-zone`, not inside the intentionally **140%** jigsaw image wrapper (tabs offset **-20%**). Use `onStatus` or carefully scoped `:has()` selectors; check rotated pieces, normal tabs, neighboring overlap and stacking without clipping actual jigsaw shapes.
- [ ] For `PuzzleCompletionDialog.svelte`, **reuse** the results preview's existing responsive width and `aspect-ratio: 3 / 4` as the pending/error placeholder frame (avoid adding unnecessary sizing rules). Give the **full-artwork view** a bounded, nonzero placeholder stage during pending/error; retain the actual artwork's aspect ratio when loaded, since its `width:auto;height:auto` image alone reserves nothing. Add an unavailable fallback for nonempty-but-failed URLs in both views, preserving null/`''` behavior and VIEW ARTWORK/focus semantics. On Gallery Continue, hide pending/error decorative artwork **silently** behind existing text/progress overlay (no unavailable caption).
- [ ] Keep UI and behavior unchanged outside image status: Gallery/Bookmarks/Profile card navigation, quick-puzzle blob URLs, tray/board masks, selection, drag/rotation, keyboard focus, result persistence and completion controls. No generated artwork/SFX, new store/controller or extra image-loading framework.

## 2. Deterministic regression coverage

- [ ] Unit-test the action for pending → loaded, error and recovery after changing the URL, warm-cache complete, no spurious reset on unrelated updates, callback/dispose cleanup.
- [ ] Implement **one tiny reusable image response hold/fail helper** (existing `DeferredHandle` shape plus `assertClean()`). Hook into `fixture-router.ts` only for known gameplay fixture images (`/api/puzzles/<fixture-id>/pieces/:n/image`, `/reference`, `/thumbnail`). `gameplayPage.assertSettled()` must catch any unreleased gameplay image hold. Preserve existing method validation, failure provenance and fixture leak detection; no general HPA-1028 harness rewrite.
- [ ] **Gallery test wiring is different:** `getFamilyThumbnailUrl()` points to `/api/puzzle-families/:familyId/thumbnail` and `gallery.spec.ts` navigates to `/`, not `gotoFixture()`. Use the same tiny hold/fail helper but register a Gallery-specific thumbnail route in the Gallery specs; clean up with `afterEach`/`finally` and a direct `assertClean()`. `gameplayPage.assertSettled()` does nothing for a Gallery-only navigation, so must **not** be relied on for Gallery teardown.
- [ ] Update `e2e/support/diagnostics.ts` for **explicitly declared** failing/aborted image URLs, expected method, status and provenance only. Keep unrelated failed requests, 4xx/5xx, page errors, and console errors fatal; narrowly allow any browser failed-resource console entry attributable to the declared test image rather than globally suppressing it. For Gallery, assert the exact intentional 404/abort and cleanup via the Gallery test owner. Do not disable diagnostics or expand network retry behavior.
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

- [ ] **MCP runs/inspects the committed Playwright E2E suite** from §2 as the end-to-end acceptance, including Gallery held/failure recovery, piece/tray/board and completed-artwork states and a warm reload. **Do not** run a second interactive MCP fixture scenario duplicating those assertions. Validate actual image decode (`naturalWidth > 0`) as well as `data-image-state`. Use MCP separately for the live cold/warm production trace (§3), which fixtures cannot establish.
- [ ] **MCP screenshot visual check** of the **final** Gallery card, ordinary/rotated and placed pieces, status placeholders, completion preview and full-artwork view at desktop and narrow viewport. If a Linear mockup is attached, compare with it; otherwise check alignment, bounding boxes, overflow, aspect ratio and readable fallback text against the shipped Galaxy Arcade UI. Save screenshots/visual observations as PR evidence. A separate before-state capture is optional, not a gate; no human acceptance and no new screenshot-baseline infrastructure.
- [ ] Focused component/action tests; `bun run --cwd apps/web test:unit`, `bun run --cwd apps/web test:e2e`, `bun run check`, `bun run lint`, applicable API tests and PR CI pass. Run `bun run test:unit` if any shared engine/types code changes.
- [ ] Preserve toolbar/modal focus, Gallery navigation, quick puzzle images, selection/rotation/placement, completion recording and local progress. No art/SFX or new gameplay controller.

## 6. Finish on the same PR

- [ ] Record the actual per-surface production trace and chosen or rejected backend fixes in PR #181. Note honest unresolved performance symptoms; do not assert faster loading if unmeasured.
- [ ] Attach automated screenshot/trace evidence and test/CI results. Keep the PR draft until acceptance is verified.
- [ ] Update HPA-1029 with the implementation and measured outcome; mark Done only after merge and verification.

## Risk and fallback

Production timing may not reproduce the two earlier cold visits. This does **not** block the deterministic status fix, which has held/failing image E2E coverage. It **does** block claiming a server-speed issue fixed without evidence. Keep the scope one small presentation action plus narrowly proven performance changes, not a generalized image loading subsystem.
