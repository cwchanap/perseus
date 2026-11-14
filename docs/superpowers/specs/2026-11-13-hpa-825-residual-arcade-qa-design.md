# HPA-825 — Remaining Arcade QA: Evidence-First Design

**Linear:** [HPA-825](https://linear.app/cwchanap/issue/HPA-825/verify-remaining-arcade-qa-upload-persistence-drag-and-cold-paint)  
**Original report:** [GitHub #86](https://github.com/cwchanap/perseus/issues/86)  
**Previous remediation:** [PR #138](https://github.com/cwchanap/perseus/pull/138) and its [implementation plan](../plans/2026-10-23-issue-86-qa-remediation.md)  
**Source baseline:** `0fe71b87` when drafted; by this review, `main` advanced to `4b582ae9` (dependency/workflow files only).  
**Deployment observation:** [Deploy Infrastructure run 43544192168](https://github.com/cwchanap/perseus/actions/runs/43544192168) succeeded on 2026-11-14 for `ca379441`, after the previous reviewer's 2026-11-06 `d927ee86` baseline. This confirms a workflow run, **not independently the assets served by production**; recheck the latest successful run and actual deployed revision when testing.  
**Delivery:** one draft PR for design, verification, and any evidenced fixes.

## Goal and boundaries

PR #138 already shipped the confirmed frontend work: persistent upload feedback/profile link, decode-safe preview, URL gallery filters, Continue/empty copy, malformed ID recovery, title tooltip and theme color. Pause and action-menu accessibility were already fixed.

Only these three questions remain unresolved:

1. Does an authenticated upload survive to a **terminal state** (`ready` or `failed`) in the player's owned list? A temporary `processing` row is not enough to close the persistence question.
2. Does desktop HTML5 **native dragstart/drop** work without synthetic E2E fallback, and does Safari physical mouse/trackpad drag work?
3. Does a cold gallery navigation flash white or remain abnormally blank, and is that pre-CSS browser canvas, hydration, or slow data?

**No speculative application changes.** Prefer verification, the existing test fixtures and the known code seams. Do not introduce a new upload pipeline, global event bus, drag controller, session schema, D1 migration, loading-screen framework, new graphics, or audio. Keep the task to this single PR.

## Relevant existing behavior

### Upload is asynchronous and can be reaped

`apps/web/src/routes/upload/+page.svelte` normalizes the image, POSTs through `createPlayerPuzzle`, keeps feedback visible, and links to `/profile`. The API (`apps/api/src/routes/puzzle-families.worker.ts`) writes R2 assets, metadata, a D1 ownership row, and starts a Workflow before returning HTTP 201. The owned-list endpoint (`GET /api/player/puzzle-families`) includes `processing` entries, and the profile summary counts them.

However, `apps/api/src/services/reaper.ts` considers `processing` entries **older than two hours** for cleanup if their Workflow is confirmed dead and the Durable Object is not authoritatively `ready`. Cleanup can remove the D1 ownership row too. Thus 201 plus an immediate `processing` entry proves initial writes, **not durable completion or failure retention**. A normal `failed` terminal state remains owned; distinguish generation failure from missing persistence.

The public gallery may omit an owned upload until `ready`; that is intended, not proof it disappeared.

### Desktop DnD was masked by fallback

`PuzzlePiece.svelte` uses `draggable` and `dragstart` to set `DataTransfer`; `PuzzleBoard.svelte` handles `dragover`/`drop` and routes placement through `PuzzleSession`. The former `e2e/support/gameplay-page.ts::placeWithMouse` tried `dragTo()` but synthesized `dragover`/`drop` if no piece was placed. That can mask a broken `draggable`, `dragstart` or `setData` path.

For HPA-825, require **no synthetic fallback on `chromium-desktop`**, including for rejected drops; keep the documented fallback only for mobile/WebKit where Playwright drag delivery is unreliable. Add the existing correct-placement test to automatic Chromium smoke; this is a focused harness improvement, not a production gameplay rewrite. One manual desktop Safari pointer drag remains useful because the project has no desktop WebKit Playwright project.

Existing tests already cover wrong placement, save/resume, keyboard and iOS-style tap; do not repeat their entire acceptance matrix manually.

### First paint already has a dark CSS background

`apps/web/src/app.html` defines `theme-color: #0a0620` and `apps/web/src/routes/layout.css` paints `html/body` dark. The static adapter produces an SPA fallback `200.html` (`apps/web/vite.config.ts`), served on route misses by `apps/api/src/worker.ts`.

Recheck the generated fallback `<head>` and CSS link with a fresh build if a paint issue is reproduced. A white pre-CSS **browser canvas** may warrant `<meta name="color-scheme" content="dark">`, **only after capture confirms that case**. A short dark empty shell during expected SPA hydration is an **intended** loading state; a persistent or excessive blank state needs investigation rather than automatic dismissal.

## Test account and cleanup rule

Use **one** authorized production browser session and a disposable, non-sensitive picture. The normal player UI does not support deleting owned families. If appropriate admin access is available, use the existing protected `POST /api/admin/puzzle-family-delete/:familyId` operator route **only once processing has finished** (or follow its explicitly authorized force-delete process for a genuinely stuck family). Otherwise record that the intentionally public throwaway remains, or avoid uploading if that outcome is not acceptable. Never store credentials, session cookies or identifiable account traces in the PR. Never mutate production D1 directly.

## Acceptance and record ownership

The [implementation/verification plan](../plans/2026-11-13-hpa-825-residual-arcade-qa.md) is the **single canonical evidence/disposition table**. Keep the design decisions here stable; do not duplicate per-run status in both files.

The ticket has **no Linear UI mockup attached**. Visually compare against shipped arcade UI, and explicitly compare with a ticket mockup if one appears. End-to-end acceptance focuses on macOS, Windows, and iOS only: use an efficient representative browser matrix instead of repeating every test on every platform. Android/Linux have CI coverage only. Mark unrun checks **pending**, never passing; any deferred case must name the missing access/environment and follow-up.
