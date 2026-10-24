# Issue #86 — arcade QA verification and fix plan

**Issue:** https://github.com/cwchanap/perseus/issues/86, including September 18 and October 20 follow-ups  
**Baseline:** source verified against `main` (October 23–24, 2026); no fresh signed-in production reproduction  
**Delivery:** continue implementation on this **same draft PR**; no separate PR or new ticket.

## Verdict and constraints

Issue #86 is **partly valid**, not nine open code bugs. Keep changes route-local, lean, and evidenced: no speculative backend rewrites, global filter stores, gameplay-engine changes, generic UI frameworks or schema migrations. Keep local progress, existing session persistence, auth flow, and gallery cursor pagination.

### Code-backed verification

| Reported issue | Code evidence and disposition |
| --- | --- |
| #1 Valid JPEG upload disappears | `upload/+page.svelte` catches failure in `formError` and resets only after `createPlayerPuzzle` resolves. However the **success notice vanishes after 3 seconds** (confirmed UX flaw). Worker responds 201 only after image upload/metadata/ownership and workflow start; player profile includes processing, ready and failed. Actual signed-in 201/profile mismatch is **not reproduced**. Fix notice unconditionally; backend only with HTTP evidence. |
| #2 Bad image broken preview | Selection currently invokes `FileReader.readAsDataURL` before image decoding, so a corrupt file may reach `<img>`. **Fix** MIME selection and decode-before-preview. Server 10 MB limit applies to **normalized uploaded file**, not original input; do **not** reject large raw originals. |
| #3 Pause unclear | Existing `SessionPauseDialog.svelte` is a labelled modal with pause/resume choices. **Already fixed; no change.** |
| #4 Drag unclear | Native drag/drop and keyboard/tap paths exist. Existing `@extended` mouse drag E2E is present; WebKit synthetic drag is unreliable. **Reuse test, manually verify if necessary; no speculative rewrite.** |
| #5 Search/category URL not persisted | Gallery filter variables are component-only. **Fix** using URL as sole committed source of truth; keep only unfinished text input local. |
| #6 Continue and no-results conflict | Continue displays saved local progress independently of remote gallery results. **Clarify copy only**, not discovery or filtering. |
| #7 Missing puzzle state differs | Valid missing ID already maps to 404; malformed server UUID currently yields generic 400. **Validate locally** using shared `isPuzzleId` and existing synthetic 404 branch; preserve real 400/5xx. |
| #8 Icon-only action a11y | Pause/More and secondary toolbar controls have names and More has `aria-expanded`. **Already fixed; no change.** |
| #9 Blank/flash on cold visit | Global `routes/layout.css` paints `html/body` dark, loaded by the shell stylesheet; an inline dark background would be redundant. `app.html` theme-color is `#2563eb`, mismatching dark `--bg-0` `#0a0620`. **Fix theme-color; investigate actual blank/flash only if reproducible.** |
| Follow-up: truncated bookmark names | Shared `PuzzleCard.svelte` truncates with no title tooltip. **Add native `title={family.name}`.** |

## Plan — one PR

### Step 0. Upload diagnostic at the start, if authenticated access is available

Before runtime implementation, try a real **signed-in** ~1024px JPEG upload. Record POST `/api/puzzle-families` status/response and subsequent GET `/api/player/profile` and `/api/player/puzzle-families` presence/count. Inspect Worker logs only as needed; avoid posting any image, credentials, token or personal account details.

Write the outcome in the PR description: **201 + owned row present** means no demonstrated persistence bug; **non-2xx** requires diagnosing the failing request; **201 + missing owned row** requires checking D1 ownership/status, player identity and profile/list filters before fixing and testing. If authenticated testing is unavailable, explicitly say **not verified**. This diagnostic determines whether backend work is warranted; **it is not a merge gate for confirmed frontend changes**. No speculative backend commits.

### A. Upload: minimal unconditional feedback fix

1. In `apps/web/src/routes/upload/+page.svelte`, remove `successTimeout`, its 3-second callback and now-unused cleanup/import; show the success status until a next attempt or navigation.
2. Say “accepted for processing” rather than suggesting immediate playability. Include “View my puzzles” linking to the existing `/profile` route.
3. Preserve existing behavior: submit is already disabled while uploading; errors already persist in `formError`. **No new concurrency guard or alert system.**
4. Only if Step 0 exposes a backend failure, inspect `apps/web/src/lib/services/api.ts`, `apps/api/src/routes/puzzle-families.worker.ts` and `packages/shared/src/repositories.ts`, then fix the specific cause and add a regression.

### B. Invalid-image selection: reuse decoding, not a raw-byte gate

1. Reject unsupported **declared MIME** using `ALLOWED_MIME_TYPES` from `@perseus/types`, echoing the early-reject handler in `QuickPuzzleUploader.svelte`; clear prior image and show `role="alert"`.
2. **Do not gate `file.size` with `MAX_FILE_SIZE`.** That 10 MB limit is enforced by the Worker on the image **after** `normalizePuzzleImageFile` resizes/compresses it, so large original images may succeed. Do not import the separate Quick Puzzle 20 MB limit either. Leave any normalized-image 400 visible in the existing form alert.
3. Probe with `const bitmap = await createImageBitmap(file)`, as `puzzleImage.ts` does, then `bitmap.close()`. Only after decode succeeds use the existing `FileReader` preview. Decode failure should say “Couldn't read this image” and show no broken preview.
4. Use **one selection generation counter**, including explicit remove/reselection, to fence the async bitmap probe and `FileReader` callbacks from racing a newer selection. Clear invalid input; avoid new preview abstractions or running the full normalization before selection.
5. Change the upload hint from “max 10MB” to “resized automatically” (or other accurate explanation of normalization).

### C. Gallery: URL-only committed filters, minimal local text state

1. In `apps/web/src/routes/+page.svelte`, import reactive `page` from `$app/state`, `goto` from `$app/navigation`. Derive `urlQuery` from `page.url.searchParams.get('q')` (trimmed), and `selectedCategory` from a small `PUZZLE_CATEGORIES.includes` parser; unknown values mean `CATEGORY_ALL`. **Only `searchQuery` remains local state for in-progress input**; remove local `debouncedQuery` and stateful category as committed sources.
2. Initialize text input directly from URL **synchronously** before initial fetch, and use one focused effect to bring text input in line with `urlQuery` when URL changes through back/forward. Avoid tracking the raw input in that synchronization effect (e.g. `untrack`); it must not revert user typing. No hydration-time URL mutation.
3. On user action, clone `page.url` (Kit 3 `page.url` is readonly), set/delete `q` and `category` while preserving other params, and call `goto(url, { replace, reset: false })`. For search typing, retain the existing 300 ms debounce and set `replace: true` only if trimmed query differs from `urlQuery`. For category select / clear filters use `replace: false` for meaningful back history.
4. **SvelteKit 3.1:** `reset: false` preserves scroll and search focus; Kit 2 `noScroll`/`keepFocus` are removed and `replaceState` is deprecated in favour of `replace`. Preserve query-version/abort cancellation and infinite-scroll cursor resets. Both first-page fetch and `loadNextPage` must read **URL-derived** values, not the uncommitted text input. No new store or bidirectional state loop.

### D. Continue versus empty gallery: copy only

Keep “Continue on this device” as saved-local progress, independent of gallery search results. Add a one-line “Saved on this device — not part of search results” caption in the Continue panel and change the filtered-empty heading to “NO GALLERY MISSIONS MATCH YOUR SCAN” (or equally scoped copy). Do not modify saved progress retrieval, filtering or layouts.

### E. Puzzle missing state, card tooltip, shell

1. In `apps/web/src/lib/services/puzzleSource.ts` **after** the quick-puzzle prefix branch and **before** `fetchPuzzle(id)`, reuse `isPuzzleId` from `@perseus/types`: if false, throw `new ApiError(404, 'not_found', 'Mission not found')`. This mirrors the existing quick-puzzle synthetic 404 and enters the route's existing 404 panel and RETURN TO ARCADE link **without a network call**. Optionally retitle the 404 panel “SECTOR NOT FOUND”. A real server 400 and network/500 stay error states; do **not** translate arbitrary API 400 messages.
2. Add native `title={family.name}` to the truncated heading in shared `PuzzleCard.svelte`; test discoverability without changing visual truncation.
3. Change `apps/web/src/app.html` theme-color to `#0a0620` **unconditionally**. Do **not** add an inline dark `html/body` style: render-blocking stylesheet already supplies this. A cold-navigation repro should distinguish **light browser canvas before document paint** (investigate `<meta name="color-scheme" content="dark">` only if demonstrated) from an **empty dark shell until hydration** (different cause). Do not invent a splash screen.

### F. Non-bugs and manual evidence

Preserve existing #3 pause and #8 named secondary controls; run existing tests only. For #4 reuse `apps/web/e2e/gameplay-interactions.spec.ts` `@extended` desktop mouse-drag test and human mouse/trackpad verification where needed; WebKit synthetic drag failure alone is not proof of a broken mechanic. For #9 record a cold cache navigation before making any further change. **Backend changes depend on a signed-in trace; frontend merge does not.**

## Tests and verification

- **Upload unit:** `apps/web/src/routes/upload/page.svelte.test.ts`: replace auto-dismiss test with persistent status + `/profile` link; MIME rejection; **large raw MIME-valid input allowed through decode**; corrupt bitmap no preview; bitmap closed; stale bitmap/reader callbacks ignored; existing failure alert and disabled-submit contract retained. Server normalized-byte limit remains as-is.
- **Gallery unit/E2E:** `apps/web/src/routes/page.svelte.test.ts`, `apps/web/e2e/gallery.spec.ts`. Reuse `$app/state` mocking from `apps/web/src/routes/error.svelte.test.ts`. Test first fetch from `/?q=macaw&category=Animals`, unknown category, refresh, back/forward, debounced replace vs category/clear push, **focus and scroll retained during typing**, stale request cancellation, pagination and local Continue with gallery-only empty state.
- **Puzzle source/route:** `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` and focused source tests: malformed ID returns 404 **with no `fetchPuzzle` call**; valid missing ID 404, other API 400 and 5xx keep separate failure presentation.
- **Cards:** `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts` checks full title attribute on truncated heading.
- **Manual/shell:** check theme-color `#0a0620`; classify cold navigation canvas-vs-hydration issue; execute existing `@extended` mouse drag test. Authenticated upload + profile trace if access exists; otherwise document **unverified**, not passing.
- **Backend tests:** add only if Step 0 establishes a backend fault; test actual failure and owned-family visibility rather than inventing a new write path.

Checks: `bun run --cwd apps/web test:unit -- src/routes/upload/page.svelte.test.ts`, `bun run --cwd apps/web test:unit -- src/routes/page.svelte.test.ts`, `bun run --cwd apps/web test:e2e -- gallery.spec.ts`, `bun run check`, `bun run lint`. Run shared/API unit suites only if touched.

## Acceptance criteria

- [ ] Success status stays visible until next attempt/navigation; `/profile` link, retryable errors and disabled-submit behavior work.
- [ ] Unsupported/corrupt image never produces broken preview; **raw** photos larger than 10 MB are not rejected solely because of original byte size.
- [ ] URL drives committed gallery query/category, survives deep links, reload/back/forward, and keeps focus/scroll/infinite scroll intact.
- [ ] Local Continue and gallery-only no-results are clearly distinguished without altering data paths.
- [ ] Malformed puzzle IDs hit existing 404 recovery without `fetchPuzzle`; real 400/500/network remain distinguishable.
- [ ] PuzzleCard exposes full title with truncation intact, and shell theme-color matches dark background.
- [ ] Existing pause and More controls remain intact; drag and cold paint are changed only on verified evidence.
- [ ] Authenticated trace recorded if access exists; if unavailable, explicitly unverified. **Not a frontend merge gate.**

## PR boundary

This draft starts **docs only**. After plan review, implement the verified frontend fixes and tests **on this same branch and PR**. No second implementation PR, new Linear ticket, speculative backend rewrite, schema migration, global URL filter store, or engine change.
