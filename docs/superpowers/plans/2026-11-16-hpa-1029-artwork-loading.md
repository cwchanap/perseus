# HPA-1029 — Implementation plan and end-to-end acceptance

Linear: https://linear.app/cwchanap/issue/HPA-1029

Design: [2026-11-16-hpa-1029-artwork-loading-design.md](../specs/2026-11-16-hpa-1029-artwork-loading-design.md)

**PR rule:** This draft PR is the **single** HPA-1029 PR. Commit diagnosis, any scoped implementation and regressions here; do not create a second implementation PR. The current commit contains design/plan documentation only.

## 1. Reproduce and classify before modifying behavior

- [ ] Run the deployed site as a signed-out player in a *fresh browser context with cache disabled*. Collect a Network/Performance timeline for Gallery card thumbnails, first game/tray, and completion artwork. Capture first frame/screenshot, request start/TTFB/finish, transfer size/status/content type, DOM `img.complete`/`naturalWidth` and first visible decoded art. Use the specific Shojo Crystal Waltz / Conservatory Reader reports where possible.
- [ ] Repeat after refresh with the same profile/cache enabled and record differences. Check that image requests aren't canceled by SPA navigation, deferred by `loading="lazy"`, or blocked by CSS. Separate the earlier withdrawn reference-dialog observation from the confirmed completion panel delay.
- [ ] Diagnose the first failing stage with concrete evidence. Add a brief table to the PR description (URL class, network/decode/paint times, status, cold vs warm, screenshots); label any root-cause hypothesis that remains unconfirmed.
- [ ] Establish a deterministic regression with the existing fixture router / image route interception (held/delayed response, explicit failure, or reproduced slow-server behavior). Avoid wall-clock-only sleeps and failures that disappear when warmed.

**Exit gate:** one independently reproducible, measured failure with an identified owner. Do not implement blanket preloading or a new asset cache before this gate.

## 2. Make one minimal targeted change

Change only the relevant path selected by the evidence:

- **Network/API bottleneck:** focus on `apps/api/src/services/storage.worker.ts` and the affected image handlers in `apps/api/src/routes/{puzzles,puzzle-families}.worker.ts`. Keep existing endpoints, R2 keys, public response/cache headers, and missing-asset semantics. If replacing buffer-before-response with R2 streaming is warranted, test body bytes/MIME, successful first-load display and missing/error responses end-to-end. Avoid speculative CDN or concurrency infrastructure.
- **Browser scheduling/decode/visibility:** focus on `apps/web/src/lib/components/PuzzleCard.svelte`, `PuzzlePiece.svelte`, `PuzzleCompletionDialog.svelte`, and if needed the existing `PuzzleBoard.svelte` or `puzzle/[id]/+page.svelte`. Reuse native `<img>` events and local component state; reset state on URL changes. Preserve Gallery lazy loading below the fold, quick-puzzle blob URLs, keyboard/drag interactions and completion focus. Use a small visible placeholder while pending and a failure treatment only where the reproduction demonstrates an unexplained blank surface.
- **Completion-only late reference:** reuse `resolveReferenceImage()` and the same URL. Any early fetch must be narrowly scoped, justified by a timing comparison, and must not starve the playable piece images.

No API schema, new store/controller, extra panel framework, asset pipeline, image art or SFX in this PR. Do not mix [HPA-1032](https://linear.app/cwchanap/issue/HPA-1032)'s tray sizing and Gallery spinner polish into this task.

## 3. Automated regression tests

- [ ] Focused test exercises the **reproduced root cause**, not just an artificially mocked success.
- [ ] Gallery test: first uncached visible card renders its expected image and not a permanent dark frame; an image 404/failed decode gets an explicit fallback; refresh and changing the card URL do not leave stale error state.
- [ ] Gameplay test: fetch/decode of expected tray piece image(s) is observable by `img.complete && img.naturalWidth > 0`; a held/delayed piece response has an appropriate visible interim state and after release shows actual piece art without refresh. Test placement remains possible when images are ready.
- [ ] Completion test: after solving a deterministic puzzle, the reference `<img>` visibly resolves without requiring another navigation; an intentionally delayed or failed reference has clear pending/fallback treatment and does not break VIEW ARTWORK, modal focus or completion recording.
- [ ] If API code changes, add route/service coverage for R2 success, absent object, read error and actual streamed/buffered body; run a **full-stack API + web browser E2E** via MCP, not only mock assertions.

Prefer extending `apps/web/e2e/gallery.spec.ts`, `apps/web/e2e/gameplay-*.spec.ts` and the existing component tests; reuse `e2e/support/test`, `gameplayPage.gotoFixture()` and registered fixture image paths. When intercepting fixture URLs, respect the fixture-router's last-registered-first route precedence, total interception and diagnostics teardown. Work around existing [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028) service-reuse issues with clean, known services rather than changing the harness as part of this PR.

## 4. End-to-end acceptance — machine-verifiable

- [ ] **MCP-driven browser run**, one supported desktop platform, fresh context/cache disabled: initial Gallery artwork, puzzle piece images, first tray interaction and completion artwork all become visible without reload. Assert actual image pixels or `naturalWidth > 0` as appropriate — not simply an `<img>` element existing — and save request timing evidence.
- [ ] Warm refresh of the same puzzle remains correct; forced image delay/failure presents an understandable loading/error fallback rather than an unexplained blank dark frame, and success resumes without refresh.
- [ ] **MCP-driven visual check:** capture before/after Gallery, tray, completion dialog and full-artwork view screenshots. Compare to any Linear mockup if supplied, otherwise the existing Galaxy Arcade UI. Include a narrow/mobile viewport check for overflow, legibility and placeholders. One browser platform suffices for shared web presentation unless diagnostics prove a Safari/WebKit-specific path.
- [ ] Preserve Gallery navigation, puzzle masks/rotation, selection/placement, completion persistence and focus/keyboard actions. The E2E must actually solve one deterministic puzzle and reach the results dialog.
- [ ] Targeted tests, `bun run --cwd apps/web test:unit`, `bun run --cwd apps/web test:e2e`, applicable API tests if touched, `bun run check`, `bun run lint` and CI all pass. Use `bun run test:unit` if any shared types/game-core code changes. Docs-only draft PRs skip automatic CI: green CI must be established after code changes, not presumed now.
- [ ] PR evidence records the measured before/after cold-load timing and the specific cause fixed, plus successful MCP E2E and screenshot verification. No human acceptance gate.

This acceptance scope is deliberately browser-based; macOS/Windows are not separate requirements for a platform-agnostic web change. Add a WebKit/iOS-specific E2E only if reproduction shows a platform-specific image loading/painting bug. Android/Linux remain CI-only.

## 5. Finish in this same PR

- [ ] Replace the PR's provisional diagnosis section with trace findings, affected files and actual fix. Avoid recording a hypothesis as verified.
- [ ] Attach automation-produced screenshots/logs and report exact test results. Do not merge until the diagnostic exit gate, E2E and visual criteria pass.
- [ ] Update the Linear issue with the single PR link and final evidence/disposition. Close it only after the fix is merged and checked.
