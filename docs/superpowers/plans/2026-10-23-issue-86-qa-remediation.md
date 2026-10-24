# Issue #86 — arcade QA verification and fix plan

**Source:** https://github.com/cwchanap/perseus/issues/86 (including 2026-09-18 and 2026-10-20 follow-up comments)  
**Baseline:** current \`main\` as reviewed on 2026-10-23  
**Delivery:** one implementation PR; continue using this draft PR/branch after the plan review. No separate implementation PR.

## Verdict and constraints

The umbrella issue is **partly valid**, not nine open implementation bugs. The signed-in upload failure needs a reproducible request/response trace; the other confirmed issues are mostly route-local UI work. Avoid speculative backend rewrites, new stores, generic components, new persistence contracts, and changes to the shared game engine. Preserve the existing gallery pagination/infinite scroll, session saves, and authentication flow.

### Code-backed verification (not a fresh authenticated production reproduction)

| Original item | Finding on current main | Disposition |
| --- | --- | --- |
| #1 Upload silently fails | \`upload/+page.svelte\` catches API/normalization errors and shows \`role="alert"\`; it clears the form only after \`createPlayerPuzzle\` resolves and auto-clears the success message after 3s. \`api.ts\` posts to \`/api/puzzle-families\`. The Worker returns 201 only after R2 upload, family/variant metadata, D1 ownership insert, and workflow creation. \`getPlayerSummary\` counts processing, ready **and failed** owned families. Thus a successful 201 should be reflected in the profile; the reported 0 count remains unexplained. Existing web unit tests mock the API; they do **not** prove the real signed-in path. | **Unconfirmed root cause / required signed-in repro.** Improve confirmation; fix backend only against evidence. |
| #2 Invalid image preview | \`handleImageSelect\` immediately stores any selected \`File\` and uses \`FileReader.readAsDataURL\`; the file input's \`accept\` is advisory, and actual \`createImageBitmap\` decode happens later, on submit, inside \`normalizePuzzleImageFile\`. Invalid files can therefore be previewed as broken images. | **Confirmed by code. Fix.** |
| #3 Pause feedback | \`PuzzleToolbar.svelte\` has Pause action; \`SessionPauseDialog.svelte\` is an accessible modal labelled “Mission Paused” with Resume/Restart/Exit/Discard. | **Already addressed. No code change.** |
| #4 Drag/placement | \`PuzzlePiece.svelte\` emits native HTML5 \`dragstart\` data; \`PuzzleBoard.svelte\` handles native \`dragover/drop\` and also keyboard/click placement through the engine. This does not prove a human drag succeeds; scripted gestures can fail to synthesize the browser drag data transfer. | **Manual human test, then act only if reproducible.** |
| #5 URL-persisted filters | Gallery \`+page.svelte\` initializes \`searchQuery\` to empty and \`selectedCategory\` to All; it fetches with their component-state values but never reads/writes the page URL. | **Confirmed by code. Fix.** |
| #6 Empty search vs Continue | Gallery renders \`continue-on-device\` outside the filtered result branches whenever local progress is present, while “NO MISSIONS MATCH YOUR SCAN” refers only to the remote catalog. Both are true but visually ambiguous. | **Confirmed UX ambiguity. Clarify scope, retain local resume.** |
| #7 Inconsistent missing-puzzle page | \`+error.svelte\` has branded 404 “SECTOR NOT FOUND” and arcade recovery. The puzzle route catches 404 into a separate “Mission no longer available” state and invalid UUID API 400 into generic “Failed to load mission.” | **Confirmed by code. Fix route presentation.** |
| #8 Icon-only more-actions accessibility | \`PuzzleToolbar.svelte\` provides names/titles for the secondary actions and an accessible named trigger with \`aria-expanded\`. | **Already addressed. No code change.** |
| #9 First-paint flash | \`app.html\` has no inline initial background style; \`layout.css\` sets a dark \`:root/html/body\` after styles load. Theme-color is currently blue (\`#2563eb\`) rather than the shell's \`#0a0620\`. This makes a light flash plausible but is **not** a runtime reproduction. | **Cold-navigation visual check; apply minimal initial dark background if confirmed.** |
| Follow-up: truncated bookmark title | Shared \`PuzzleCard.svelte\` truncates the title with CSS \`truncate\`; no \`title\` attribute provides hover discovery, though the full string remains in DOM text/image alt. | **Confirmed by code. Fix shared card.** |

## Implementation plan (one PR)

### A. Upload flow: reproduce first, then address precisely (highest priority)

1. Exercise **signed-in** \`/upload\` with a real valid JPEG (around 1024px). Record POST \`/api/puzzle-families\` status/response; inspect Worker logs when available; check GET \`/api/player/profile\` and \`/api/player/puzzle-families\` immediately after POST. Do not log image contents, OAuth tokens, or personal email.
2. Interpret the trace before changing the backend:
   - **201 + family present:** no persistence bug. Make the success banner persistent until dismissed/new attempt, clearly distinguish “uploaded/processing” from “ready in gallery,” and offer a “View my puzzles” link. Do not discard the success confirmation after 3 seconds.
   - **Non-2xx:** preserve name/image on failure and show the server-provided reason in the existing \`role="alert"\`; adjust the failing API path only if the trace identifies a real fault. The existing Worker cleanup/ownership workflow is authoritative; do not add an alternate write path.
   - **201 + missing ownership:** verify D1 row and status, profile/list filters, and actual account identity; fix the specific mismatch plus a Worker regression test. This contradicts the reviewed insert-before-201/count-processing contracts and must be demonstrated, not assumed.
3. Keep the upload button disabled during requests and prevent duplicate submission. Ensure a retryable error remains visible and that a successful return has a durable confirmation.

**Files to inspect/change only when needed:** \`apps/web/src/routes/upload/+page.svelte\`, \`apps/web/src/lib/services/api.ts\`, \`apps/api/src/routes/puzzle-families.worker.ts\`, \`packages/shared/src/repositories.ts\`; no schema/migration by default.

### B. Reject invalid image *before* preview

- In \`upload/+page.svelte\`, synchronously reject non-JPEG/PNG/WebP declared MIME and files above the existing 10MB bound; clear previous image/preview and show an immediate inline \`role="alert"\`.
- Decode before promoting an image to a visible preview (reuse browser image decoding, with failure handling); keep the input clear on failure. Prevent a slower previous selection from overwriting a newer one, and clean up any temporary blob/preview URL if used.
- Continue using \`normalizePuzzleImageFile\` for actual crop/dimension checks and the existing Worker magic-byte validation as the source of truth. Do not duplicate the entire image validation stack on the client.

### C. Persist gallery query/category in the URL

- Make the gallery route parse \`q\` and \`category\` from \`page.url.searchParams\`; unknown category becomes All, blank \`q\` is ignored. Do not create a global filter store.
- On user search, preserve the existing 300ms debounce; write canonical \`q\` to the URL without creating a browser history entry per keystroke. On discrete category select / clear filters, create a meaningful navigation/history state. Keep other unrelated URL params and any base path intact; avoid request loops caused by reading and writing the same URL.
- URL navigation (deep link, reload, back/forward) must rehydrate both controls and refetch the correct first page. Retain the current query-version/abort guards and cursor pagination reset, and do not mutate the URL on initial hydration until a user changes filters.
- Implement in \`apps/web/src/routes/+page.svelte\` with the existing SvelteKit \`$app/state\` + navigation facilities; no server changes required.

### D. Explain local Continue alongside filtered search

- Keep “Continue on this device” available even if the remote gallery has zero matches. This is a **separate saved-session shortcut**, not a search result; hiding it could strand a resumable offline/local puzzle.
- Visually/semantically label the result section as *gallery results* and give the Continue panel a short “Saved on this device — not part of search” description. Change empty-result copy to explicitly say no **gallery** missions match.
- Do not change the saved-progress discovery, session persistence, or result filtering rules.

### E. Missing puzzle and bookmarks polish

- Use the existing puzzle-route error branch; map invalid server UUID (\`ApiError\` 400 for invalid puzzle-ID format) and genuine 404/not-found to a “SECTOR NOT FOUND” / unavailable presentation with the same clear RETURN TO ARCADE recovery as \`+error.svelte\`. Keep network/5xx failures as retryable “FAILED TO LOAD MISSION” rather than mislabelling an outage as 404. Do not indiscriminately reinterpret every 400.
- In shared \`PuzzleCard.svelte\`, set a native \`title={family.name}\` (or equivalent equally small discoverable affordance) on the truncated title; add a regression test for long titles. This works in both Gallery and Bookmarks.
- If a cold-load recording confirms #9, add a minimal dark \`html/body\` initial paint style to \`apps/web/src/app.html\`, and align \`theme-color\` with \`--bg-0\`. Avoid loading screens, SSR rewrites, or new animation mechanisms.

### F. Non-bugs / manual gates

- Do not re-implement pause or the more-actions labels (#3/#8). Keep existing tests.
- Human-test #4 on mouse/trackpad and touch/keyboard where applicable (actual drag/drop, placement count, wrong cell rejection). Only add a code fix if this fails outside synthetic automation.
- Cold-navigate without warmed CSS/cache to verify #9 before changing styling.
- Signed-in uploads and the post-upload profile count are a release gate; a mocked frontend success is not enough.

## Regression test plan

- \`apps/web/src/routes/upload/page.svelte.test.ts\`: invalid MIME/file size rejected before preview, undecodable image leaves no broken image, stale preview race, backend failure preserves form/alert, real success confirmation survives beyond 3s and provides profile link.
- \`apps/api/src/routes/__tests__/*\` or \`puzzle-families.worker.test.ts\` **only if #1 backend root cause is demonstrated**: successful 201 implies owned \`processing\` row visible to player profile/list; failing path is handled/rolled back with useful status.
- \`apps/web/src/routes/page.svelte.test.ts\` + \`apps/web/e2e/gallery.spec.ts\`: \`/?q=macaw&category=Animals\` hydration, query/category updates, refresh/back/forward, unknown category, clear filters, stale-page cancellation, visible local Continue alongside gallery-only no-results wording.
- \`apps/web/src/routes/puzzle/[id]/page.svelte.test.ts\` and existing E2E fixture routes: malformed ID (400) vs absent valid ID (404) vs 500 presentation and recovery.
- \`apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts\`: long card title exposes complete string.
- Manual smoke: authenticated successful/failed upload and profile count, actual drag, cold-navigation flash. Test the built artifact; do not attempt Google OAuth in mocked CI E2E.

Suggested checks: \`bun run --cwd apps/web test:unit -- src/routes/upload/page.svelte.test.ts\`, \`bun run --cwd apps/web test:unit -- src/routes/page.svelte.test.ts\`, \`bun run --cwd apps/web test:e2e -- gallery.spec.ts\`, \`bun run check\`, \`bun run lint\`, and \`bun run test:unit\` if shared/API code changes.

## Acceptance criteria

- [ ] Signed-in JPEG upload has an observed, documented outcome (successful 201 reflected in Profile, or correctly diagnosed API failure); no unexplained silent reset.
- [ ] Unsupported/corrupt input never shows a broken preview or enables successful submission.
- [ ] Gallery query/category survive deep links, reload, and meaningful back/forward navigation without breaking infinite scroll.
- [ ] Continue-local is clearly distinct from filtered remote gallery results.
- [ ] Bad puzzle identifier/missing puzzle gets helpful 404-style recovery; server outages still show an error.
- [ ] Full card titles are discoverable without removing visual truncation.
- [ ] Human drag and cold first-paint outcomes recorded; only verified regressions change code.
- [ ] Pause/menu existing behavior remains intact.

## PR boundary

This draft initially changes **only this plan document**. After review, implement the verified web fixes and necessary tests **on this same branch and PR**. Keep #4 and #9 gated by manual evidence and any backend work gated by a signed-in HTTP trace. No second PR, new Linear ticket, abstraction framework, schema migration, or engine change is proposed for this issue.
