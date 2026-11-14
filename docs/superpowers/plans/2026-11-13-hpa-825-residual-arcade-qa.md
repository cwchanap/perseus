# HPA-825 — Remaining Arcade QA: Implementation and Verification Plan

**Linear:** [HPA-825](https://linear.app/cwchanap/issue/HPA-825/verify-remaining-arcade-qa-upload-persistence-drag-and-cold-paint)  
**Design:** [2026-11-13 design spec](../specs/2026-11-13-hpa-825-residual-arcade-qa-design.md)  
**Origin:** [GitHub #86](https://github.com/cwchanap/perseus/issues/86), including follow-ups; prior remediation [PR #138](https://github.com/cwchanap/perseus/pull/138)  
**Baseline:** `main` at `0fe71b87ac43cc3e275d1c8834c0506099650eb2` on 2026-11-13; current **production deployment not yet confirmed**.  
**PR strategy:** **One PR for HPA-825**. This PR begins with these documents; put evidence, any confirmed fixes, regressions, and closeout updates on this **same branch and PR**. No follow-up implementation PR for the same ticket.

## Delivery contract

Investigate only these three residual questions: signed-in production upload ownership visibility, real-pointer placement, and cold first paint. Source review proves neither a deployed fix nor a runtime defect. In particular, the previous implementation already shipped persistent upload feedback, safe previews, gallery filters, invalid-ID handling, and theme color. Do **not** redo these.

Record a small disposition table in the PR (or update the table below) with the deployed revision, test date, browser/OS, a redacted screenshot/recording/network observation, and the decision. Each row ends as **fixed**, **not reproducible**, **intended**, or **explicitly deferred**; unrun work is `pending`, not `passed`. This is a bounded QA closure ticket, not an architecture project.

| Area | Current result | Evidence needed | Final disposition |
| --- | --- | --- | --- |
| Signed-in upload persistence | **Pending; authenticated production run not performed** | POST status/ID, owned-family API response, profile on reload, eventual status; deployed revision | Pending |
| Native pointer drag | **Pending; physical input not rechecked** | Real drag video/observation, progress and board/tray state; distinguish E2E fallback | Pending |
| Cold first paint | **Pending; no recent frame capture** | Repeat direct-navigation captures + dark/white paint classification | Pending |

## Step 0 — Establish the runtime baseline

1. Read current `main`, check the production deployment revision if available, and record URL, UTC time, OS/browser and whether the test uses a local build, deployed production, or Playwright fixture.
2. Prefer the real production site `https://perseus.cwchanap.dev/` for the previously reported behaviors. Use a disposable puzzle/image only with an **authorized signed-in test account**. No credentials or tokens go into documents or logs.
3. Compare observed UI to the existing arcade look. No ticket mockup is attached today; if one is added later in Linear, perform the visual comparison against it before sign-off.
4. Keep this PR documentation-only until actual evidence establishes a fix worth making.

**Gate:** Do not infer the live site is on `main` just because the repository is updated.

## Step 1 — Upload: authenticated persistence, not just a success toast

Manual end-to-end on production with an authorized account:

1. Open `/upload` signed in. Pick a valid JPEG around 1024 px with a unique throwaway title, submit once, and capture the response status and family ID for `POST /api/puzzle-families` in a **redacted** Network trace.
2. Check that UI reports **accepted for processing** and offers **View my puzzles**. Navigate to `/profile` and reload. Inspect `GET /api/player/puzzle-families` (follow `nextCursor` if applicable) for the **same family ID**, including `processing`, `ready` or `failed` state. `GET /api/player/profile` is supporting context, not a substitute for the owned list.
3. If `processing`, distinguish a legitimately asynchronous workflow from missing persistence. Check again after processing has had a chance to finish; a temporary absence from the **public gallery** while processing is expected.
4. If the upload returns a non-2xx response, capture its error category and isolate normalization, auth, R2, KV, D1 ownership, or workflow-start failure. If 201 succeeds but the owned list still omits the family after reload/pagination, check session identity, repository filtering, and server logs for **that family ID** before changing code. If it appears in the owned API but not `/profile`, inspect the profile mapping/render path instead.
5. Record the observed result, and remove a test puzzle afterward if supported by the normal UI. Never modify production D1 directly as a testing shortcut. If authenticated access is unavailable, mark **deferred: authorized session required**, with no fabricated trace.

**Code seams only if failure is reproduced:** `apps/web/src/routes/upload/+page.svelte`, `apps/web/src/lib/services/api.ts`, `apps/web/src/routes/profile/+page.svelte`, `apps/api/src/routes/puzzle-families.worker.ts`, `apps/api/src/routes/player.worker.ts`, and existing shared ownership repositories. Add one focused frontend/API regression for the actual failure; do not create a new upload pipeline or database migration.

## Step 2 — Drag: distinguish physical mouse from the harness

1. Use a ready, small puzzle on a **desktop browser with real mouse/trackpad**. Start a session, note the placed count, drag a visible tray piece to its correct cell, then check: drop accepted, piece leaves the tray, board cell fills, and count increases (for example 0/16 to 1/16).
2. Navigate away and resume to verify that already-existing saved progress reflects that placement. Verify an intentionally wrong drop is rejected without advancing progress. Use mouse/trackpad on macOS and Windows; test tap-to-place separately on iOS Safari.
3. Run the existing `@extended` mouse test to protect drop handling, but **do not count its pass as physical drag proof**: `e2e/support/gameplay-page.ts::placeWithMouse` may dispatch a synthetic `drop` after `dragTo` fails. The documented WebKit `dragTo` spike (0/20) is an automation limitation until human input demonstrates otherwise.
4. If real input fails repeatably, capture source/target, browser, event evidence and session feedback. Restrict changes to `PuzzlePiece.svelte`, `PuzzleBoard.svelte`, `PuzzleInventoryPanel.svelte` or `routes/puzzle/[id]/+page.svelte` as the evidence requires. Retain the shared `PuzzleSession` placement rules; no new drag engine or generic input state machine.

**Regression only if needed:** add a narrow test that exercises the failing delivery path and checks board/tray/progress; reuse the existing gameplay fixture. Preserve keyboard/tap coverage. Avoid brittle WebKit synthetic-drag assertions.

## Step 3 — First paint: capture before fixing

1. Open the gallery URL in a fresh tab/clean browser context with a real **cold document navigation**, not just a SvelteKit client transition. Record short screen video/frame captures including first paint. Repeat after hard reload with cache disabled, and once on a normal warm revisit.
2. Compare macOS Chrome/Safari, Windows Chrome/Edge, and iOS Safari as accessible. Record whether the reported flash is white browser canvas before CSS, an empty dark shell before hydration, or slow route content after shell paint. Note network/console evidence if it helps.
3. Existing `app.html` uses `theme-color: #0a0620`; `routes/layout.css` already paints `html/body` dark. A speculative inline style or splash screen is **not justified** by the historical observation alone.
4. Only if reproducible, fix the precise paint stage, likely within `apps/web/src/app.html`, `apps/web/src/routes/layout.css`, `apps/web/src/routes/+layout.svelte` or the existing `ArcadeShell.svelte`. Add a deterministic first-paint/assertion only if it proves the measured failure; otherwise retain the manual capture as evidence.

## Step 4 — Implement just the reproduced fixes

Follow these branches **conditionally**, in the same PR:

- **No reproduction:** change no application code. Document the checked environment, evidence and disposition; do not declare untested devices verified.
- **Upload reproduced:** patch one demonstrated failing operation; add one regression at the web route, player API, or shared repository seam that would have failed before the fix. Keep normalized file-size and async processing semantics unchanged unless they are the demonstrated cause.
- **Drag reproduced:** fix the event/interaction path, not the session engine unless engine behavior itself is proven wrong. Check real pointer behavior after the change.
- **Cold paint reproduced:** address the classified paint gap and verify visually under the same cold conditions; avoid unrelated theme redesign.

If a fix changes gameplay-core or shared types, run the full `bun run test:unit` (root `test` skips these workspaces). If only web/API code changes, run focused unit tests for the touched area plus the existing relevant E2E lanes.

## Step 5 — Verification and closeout

**Automated regression commands (as applicable to changed code):**

```bash
# Current browser E2E paths; note native-pointer evidence still needs a human check
bun run --cwd apps/web test:e2e:extended -- gameplay-interactions.spec.ts
bun run --cwd apps/web test:e2e:webkit

# Existing upload, API and profile suites when their code is touched
bun run --cwd apps/web test:unit -- src/routes/upload/page.svelte.test.ts
bun run --cwd apps/api test -- src/routes/puzzle-families.worker.test.ts

# When code is changed (full test:unit if game-core/types are touched)
bun run check
bun run lint
```

A **docs-only** draft does not claim these tests were executed. `test:e2e:extended` is a manual/pre-release lane, not an automatic pointer certification. Prefer tests at the failing seam over broad new suites.

### End-to-end acceptance criteria

- [ ] **macOS (Chrome and Safari):** an authorized signed-in upload returns an observable result and its owned puzzle appears on `/profile` after reload, or a precise, evidenced defect is fixed; physical mouse/trackpad placement advances progress and survives resume; repeated cold navigations do not exhibit the original unexplained flash, or the issue is captured and fixed.
- [ ] **Windows (Chrome or Edge):** real mouse drag places a piece, wrong placement does not increment progress, and resume retains the result; cold gallery navigation is visually checked for unintended white/blank paint; signed-in upload/profile behavior is rechecked when a test account is available.
- [ ] **iOS (Safari):** the supported **tap/select-to-place** path advances progress and resumes correctly; direct cold navigation is visually inspected for light/blank flash; upload success and profile list are spot-checked if the authorized session is available. Desktop HTML5 drag is **not** an iOS touch acceptance requirement.
- [ ] **Visual comparison:** inspect uploaded-puzzle feedback, board/tray placement state, and first-paint arcade styling against the existing shipped UI. There is currently **no mockup attached to HPA-825**; if Linear gains one, compare with it explicitly.
- [ ] **Evidence and disposition:** every residual finding has a dated environment/build reference, redacted observation, and one of `fixed`, `not reproducible`, `intended` or an **explicit deferral** identifying the missing environment/access and follow-up action. A reproduced bug has a focused regression and post-fix check.

Android and Linux require no separate manual acceptance; keep relying on existing CI coverage. No new image art/SFX is in scope.

### Completion rule

Before marking HPA-825 done, update this plan/PR with the **actual** three outcomes and link the draft PR from Linear. If authorized production access or a required real device is absent, preserve the `deferred` disposition with a named follow-up; do **not** relabel the check as passing. Keep all implementation work for this ticket in this single PR.
