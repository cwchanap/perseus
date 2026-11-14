# HPA-825 — Remaining Arcade QA: Implementation and Verification Plan

**Linear:** [HPA-825](https://linear.app/cwchanap/issue/HPA-825/verify-remaining-arcade-qa-upload-persistence-drag-and-cold-paint)  
**Design:** [HPA-825 design spec](../specs/2026-11-13-hpa-825-residual-arcade-qa-design.md)  
**Origins:** [GitHub #86](https://github.com/cwchanap/perseus/issues/86); previous frontend fixes [PR #138](https://github.com/cwchanap/perseus/pull/138)  
**Delivery:** **One PR for the ticket**. This draft carries design/plan and the focused drag-harness correction. Keep future evidence and any reproduced application fix on **this PR**, not a second implementation PR.

## Outcome and canonical evidence record

There are three **open verification questions**, not three proven bugs. The table below is the **only place to update the results**; keep the design document stable. Record UTC test date, deployed revision, OS/browser and redacted evidence links as observations become available.

| Question | Status | Current evidence / disposition |
| --- | --- | --- |
| Signed-in upload persistence | **Pending** | PR #138's persistent success notice exists in source, but authenticated production POST, owned list and **terminal status** have not been checked. A temporary `processing` row is insufficient. |
| Native pointer placement | **Pending** | Desktop Chromium has a strict no-fallback `dragTo` check in default E2E and desktop-only `@smoke`; its passing CI result and Safari physical drag have **not** yet been verified in this plan. |
| Cold first paint | **Pending** | Dark CSS + theme color exist; no new cold-navigation frame capture. No white-flash reproduction claimed. |

Use exactly one final disposition per question: **fixed**, **not reproducible**, **intended**, or **explicitly deferred** (with the missing access/environment and next action). `failed` generation may be an observed terminal status while **owned persistence works**; describe both facts without conflating them.

## Step 0 — Confirm current build and deployment before testing

1. Compare current `main` and this PR head; do not assume the original `0fe71b87` draft base remains the active baseline. At 2026-11-14T02:10Z, `main` was `4b582ae9` (dependency/workflow files changed since the draft).
2. Check the latest successful production deploy using `gh run list --workflow deploy-infrastructure.yml -L 5` (or GitHub Actions). At the initial review, [Deploy Infrastructure run 43544192168](https://github.com/cwchanap/perseus/actions/runs/43544192168) **succeeded** for `ca379441` (2026-11-14), superseding the older `d927ee86` report. Recheck on test day. The application's `/health`, `/api/health` and `/api` endpoints **do not expose a deployed commit SHA**; do not search for a nonexistent version header or require exact served-SHA verification. Use the successful deployment run as the candidate revision and compare visible app behavior/bundle assets with that build where practical.
3. Record `https://perseus.cwchanap.dev/`, UTC time, browser/OS, cache state, successful deploy-run SHA and any observable asset/build evidence. If the exact served revision cannot be confirmed, record that limitation; do not treat staging, Playwright fixtures, or an old local build as equivalent to authenticated production.
4. The Linear ticket has **no UI mockup attached**. Visually compare against the current arcade design; if a mockup is attached later, compare against it before closure.

## Step 1 — Authorized upload: require stable terminal ownership

Run **once in one authorized production browser** with a unique throwaway title and a non-sensitive ~1024px JPEG.

1. In the browser's DevTools **Network** tab, capture the `POST /api/puzzle-families` status and the response JSON's **`id`** (family ID) with UTC T+0. The upload UI deliberately displays only a generic success message, not that ID; if the response was missed, find the newest matching family in `GET /api/player/puzzle-families` instead. The form should show persistent "accepted for processing" feedback and a `View my puzzles` link. Do not save cookies/tokens or private account details in the evidence.
2. Immediately inspect `GET /api/player/puzzle-families` (follow `nextCursor` if present), the `/profile` uploaded count and the new card after a reload. Owned puzzle cards can show `PROCESSING…` or `FAILED` until ready. The new ID should appear as `processing`, `ready`, or `failed`; zero uploaded after a successful 201 for a genuinely new family is a **candidate defect**, not a pass.
3. Record elapsed time and recheck the **same family ID** until a terminal `ready` or `failed` state. `ready` confirms upload and generation; `failed` confirms owned persistence but identifies a generation failure requiring diagnosis/disposition. Neither a 201 nor a T+0 `processing` row closes this check.
4. If it remains `processing` unusually long or approaches the reaper's **2-hour age threshold**, inspect the Workflow instance, Durable Object authority and status mirrors for the family ID. This indicates possible stuck processing, **not an automatic proof of data loss**: the reaper removes it only if the workflow is confirmed dead, the authoritative DO is not `ready`, and cleanup succeeds. If it disappears from the owned list, investigate the reaper/ownership path as a reproduced persistence failure.
5. For non-2xx or 201 + missing owned row on reload, first isolate the failed step (auth, R2, KV, D1 ownership, workflow start, player-identity/owned-list filtering). Patch only that specific failure with a focused regression. Public gallery omission while `processing` is expected.
6. **Cleanup:** there is no player-facing family delete. If authorized as an operator, after terminal state remove the disposable family through the protected `POST /api/admin/puzzle-family-delete/:familyId` endpoint. A stuck `processing` family needs the route's explicit `force=true` path and appropriate authorization; do not force-delete an active workflow as routine cleanup. Otherwise document that a non-sensitive throwaway will remain public, or do not perform a production upload if that cannot be accepted. Never directly edit production D1.

Only on a proven failure inspect `apps/web/src/routes/upload/+page.svelte`, `apps/web/src/lib/services/api.ts`, `apps/web/src/routes/profile/+page.svelte`, `apps/api/src/routes/puzzle-families.worker.ts`, `apps/api/src/routes/player.worker.ts`, and shared ownership repositories. No speculative backend rewrite, schema change or polling architecture.

## Step 2 — Mouse drag: strict Chromium smoke + one human Safari check

**Harness change included in this PR:**

- In `apps/web/e2e/support/gameplay-page.ts`, `placeWithMouse` **must not synthesize DnD events in `chromium-desktop`**. Real `dragTo` must produce an engine-accepted placement or an explicit rejection; ignored drops fail with source/target diagnostics. Keep the existing fallback for mobile Chromium/WebKit, where Playwright HTML5 DnD is documented unreliable.
- In `apps/web/e2e/gameplay-interactions.spec.ts`, keep correct-placement `@smoke` **outside the `@extended` describe**, and skip non-`chromium-desktop` projects. Both the default desktop E2E and automatic Chromium desktop smoke now exercise native `dragstart` → `drop`; mobile fallback adds no proof. The rejected-placement test remains `@extended`-only and is **not** part of automatic smoke.
- Preserve the existing wrong-drop, keyboard, tap, session-restore and gallery-resume tests; they already cover those rules. Do not add an entire second manual matrix.

Run:

```bash
bun run --cwd apps/web test:e2e
bun run --cwd apps/web test:e2e:smoke
bun run --cwd apps/web test:e2e:extended -- gameplay-interactions.spec.ts --project=chromium-desktop
```

Then manually try **one desktop Safari physical mouse/trackpad drag**, since the existing Playwright projects have mobile WebKit but no desktop WebKit. Record whether the piece leaves the tray, fills the correct cell and advances the placed count. If it fails, capture dragstart/dragover/drop behavior and fix the proven seam (`PuzzlePiece.svelte`, `PuzzleBoard.svelte`, `PuzzleInventoryPanel.svelte`, route callback) **on this same PR**. Do not rewrite `PuzzleSession` unless the engine itself is demonstrated wrong. Synthetic fallback success or iOS tap success alone cannot clear desktop Safari drag.

## Step 3 — Cold first paint: classify, then patch only if observed

1. Capture first frames on **cold direct navigation** to `/` in desktop Chromium and **iOS Safari**. Repeat hard reload/cache-disabled and normal warm revisits; record any white frame, dark empty shell, late gallery data or persistent blank, with environment and timing.
2. The static adapter emits `200.html` SPA fallback, which the API Worker serves for missing asset routes. On a fresh `bun run build`, check the fallback's head for the render-blocking CSS asset and confirm its `html/body` dark paint. Existing `app.html` `theme-color` and `layout.css` already use `#0a0620`.
3. **If white default browser canvas before CSS is proven**, assess the small `<meta name="color-scheme" content="dark">` change in `app.html`, re-capture on the same browser, and only keep it if it improves the reproduced issue.
4. **If the page is briefly dark/empty while the SPA hydrates**, record it as intended if the UI reliably resolves. **If it stays empty excessively or errors**, investigate the actual hydration/data problem; do not mask it with a splash screen. Route content loading can be intended or an evidenced defect depending on duration and errors.
5. No change merely because the old September report mentioned a flash.

## Step 4 — Conditional implementation and tests

- A reproduced upload failure receives a **single focused regression** at its failing web/API/repository seam; preserve normalized byte limit and async processing behavior unless the evidence implicates them.
- A reproduced native-drag failure receives a focused input-path fix; use the already-existing smoke/extended test, including the strict desktop gate. Do not add a new engine.
- A reproduced paint defect receives the smallest cause-specific change plus a visual recheck with the same cold conditions.
- If nothing reproduces, leave production code unchanged and close with evidence, not a speculative patch.
- Never add new image art or SFX to this coding task; any requested asset belongs in a separate task.

Verification commands for touched code:

```bash
bun run --cwd apps/web test:e2e
bun run --cwd apps/web test:e2e:smoke
bun run --cwd apps/web test:e2e:extended -- gameplay-interactions.spec.ts --project=chromium-desktop
bun run --cwd apps/web test:unit -- src/routes/upload/page.svelte.test.ts  # upload UI only
bun run --cwd apps/api test -- src/routes/puzzle-families.worker.test.ts   # API only
bun run check
bun run lint
```

Run `bun run test:unit` **root-wide** if shared types or gameplay-core change; root `bun run test` alone skips them. Run `test:e2e:webkit` only if tap/keyboard/WebKit behavior is touched. Existing CI provides Android/Linux coverage; no separate manual acceptance on those platforms.

## End-to-end acceptance (bounded, not a repeated full matrix)

- [ ] **macOS:** Chromium desktop native `dragTo` smoke passes without a synthetic fallback; a physical mouse/trackpad drag in **Safari** places a piece, updates visible progress, and matches the current board/tray UI. A cold gallery navigation is visually compared with existing arcade styling.
- [ ] **Windows (minimal spot check):** Chrome or Edge opens a puzzle, places one piece with mouse input and renders the dark arcade shell without an unexplained white/blank navigation. Keep this supported-platform end-to-end check small; do not repeat the full Chromium test matrix already covered in automation.
- [ ] **iOS:** Safari tap-to-place and puzzle navigation remain usable; inspect cold gallery first paint against the existing dark theme. Touch is **not** required to perform desktop HTML5 DnD.
- [ ] **Production upload (one authorized browser on any supported desktop OS):** capture 201/non-2xx + family ID, immediate owned row/count and **terminal** `ready`/`failed` (or evidence of a stuck/deleted state); a reload shows the correct family. An expected public-gallery delay while processing is not a persistence failure.
- [ ] **Visual check:** upload status and profile, board/tray placement, and cold arcade background match the shipped UI; HPA-825 has **no attached mockup** as of this plan, but compare directly with one if attached later.
- [ ] **Evidence:** each of the three canonical table rows records date, revision/environment, observed outcome and final disposition (`fixed`, `not reproducible`, `intended`, or `deferred` with a precise blocker and follow-up). No reproduced bug is closed without a narrow regression and post-fix check.

**Not yet executed:** no authenticated production upload, human Safari/Windows interaction, or cold-paint capture was performed while preparing this document. The Playwright changes above also need CI results before claiming success. Keep all results in the table above and link this PR from HPA-825.
