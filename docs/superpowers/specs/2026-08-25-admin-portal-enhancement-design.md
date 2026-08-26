# Admin Portal Enhancement Design

## Summary

Simplify the Perseus admin portal around the Cloudflare Zero Trust boundary that already protects the production admin surface, then improve the existing admin UI with tab separation, client-side puzzle search/filtering + pagination, and an enlarged puzzle-image preview.

This remains one implementation slice and one PR. It does not introduce a new admin framework, a new storage/indexing path, or another authentication mechanism.

## Goals

- Remove the Perseus admin passkey and `perseus_session` authentication layer.
- Keep Cloudflare Access as the production admin security boundary.
- Preserve the existing forced full-document navigation when entering `/admin` from the public SPA so Cloudflare Access receives a document request and can challenge it.
- Preserve the existing narrow Cloudflare Access service-token path for admin upload automation, but remove its dependency on the Perseus passkey/session flow.
- Separate puzzle management and player allowlist management into `PUZZLES` and `PLAYER ACCESS` tabs.
- Add admin puzzle search by name.
- Add admin puzzle filtering by category and processing status.
- Show the filtered puzzle list in fixed pages of 20 rows.
- Allow a ready puzzle thumbnail to open the existing reference image in an enlarged modal view.

## Non-Goals

- No Worker-side Cloudflare Access JWT validation.
- No replacement local-dev admin authentication.
- No role/permission system.
- No new backend search/filter/pagination API.
- No server-side admin search index.
- No admin sorting or page-size selector.
- No player-access search/filtering or pagination.
- No URL-backed search/filter/tab state or nested admin routes.
- No generic tab, filter, pagination, dialog, or lightbox framework.
- No new image endpoint or raw-original download path.
- No compatibility path for the deleted passkey/session API.

## Current Context

Production admin traffic is already protected by Cloudflare Access. `packages/infrastructure/src/admin-access.ts` covers `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*` with the configured browser identity/device-posture policy. A more-specific CLI Access application covers the admin puzzle endpoint and adds a service-token policy for automation.

The Pulumi-managed API Worker in `packages/infrastructure/src/workers.ts` already disables both the `workers.dev` subdomain and preview URLs with:

```ts
subdomain: { enabled: false, previewsEnabled: false }
```

Pulumi is the production source of truth. After application `requireAuth` is removed, this origin-isolation setting is a critical part of the admin security boundary and must remain intact rather than being duplicated in Wrangler configuration.

The application currently adds a second admin-auth layer: `/api/admin/login` validates `ADMIN_PASSKEY`, creates `perseus_session`, the admin Svelte layout checks that session, and all admin API handlers use `requireAuth`. Startup and one-off upload CLIs also obtain the same session after passing Cloudflare Access.

The current admin page loads puzzle management and player access together. Puzzle processing is polled every three seconds. `GET /api/admin/puzzles` returns the full freshly-read admin puzzle list, including `processing` and `failed` records. Startup upload tooling also consumes that full list for its preflight deduplication snapshot.

The public gallery already has the exact search control we need in `SearchBar.svelte`, while admin uniquely needs status visibility for `ready`, `processing`, and `failed`. The admin already receives all metadata needed to filter locally, so adding another API query contract is unnecessary for the current scale.

The web client already exposes `getReferenceImageUrl(puzzleId)`, backed by `GET /api/puzzles/:id/reference`, so enlarged image viewing does not require a new asset/API path.

## Design

### 1. Cloudflare Access becomes the sole production admin gate

Delete the Perseus admin login/session feature rather than leaving a dormant compatibility layer:

- Remove `/api/admin/login`, `/api/admin/session`, and `/api/admin/logout`.
- Remove `requireAuth` from admin API handlers.
- Delete the admin-session middleware once all production and test references are gone.
- Remove `ADMIN_PASSKEY` from the Worker environment, Pulumi bindings, GitHub Actions deployment and seed workflows, local development configuration, and current operator/product documentation.
- Remove admin-only `LoginResponse`, `SessionResponse`, and `WORKER_AUTH_ERROR_CODE` contracts once their callers are gone.
- Remove the `/admin/login` Svelte route and the admin page's Perseus `LOGOUT` button.

`JWT_SECRET` stays because player authentication still uses it.

Production authorization becomes:

```text
Browser admin
  -> Cloudflare Access: email + device posture
  -> /admin and /api/admin/*

Admin upload automation
  -> Cloudflare Access: service token
  -> exact /api/admin/puzzles path only
```

The more-specific CLI Access app keeps browser email/posture access as well, so browser administration continues to work on `/api/admin/puzzles`.

The destructive delete route remains `POST /api/admin/puzzle-delete/:id`, outside the CLI service-token application's exact `/api/admin/puzzles` destination. Do not broaden `CLI_ACCESS_PATHS`.

Local development intentionally has no admin auth after this change. Local `/admin` and `/api/admin/*` are developer-only surfaces; do not add a replacement dev passkey or feature flag.

Browser admin fetches keep `credentials: 'include'`. The Perseus session cookie disappears, but the browser still needs to carry the Cloudflare Access cookie in production and cross-origin local API behavior should not be casually changed as part of this refactor.

### 2. Treat the auth deletion sweep as a contract, not a fallback

The passkey/session feature currently appears across runtime code, test mocks, CLIs, workflows, and current documentation. Task 1 must enumerate the known live surface and also finish with a repository-wide sweep.

The inventory explicitly includes current files that are easy to miss:

- `AGENTS.md` and `CLAUDE.md` environment-variable guidance;
- `docs/PRD.md` current admin journey;
- `.github/workflows/seed-startup-puzzles.yml` production `ADMIN_PASSKEY` injection;
- `apps/web/src/lib/services/__tests__/api.test.ts` login/logout/session tests and the admin-list 401 case;
- `apps/api/src/__tests__/worker-extra.worker.test.ts` admin-session route mock and `ADMIN_PASSKEY` fixture;
- `apps/api/src/middleware/rate-limit-post-tracking.worker.test.ts` login limiter import;
- every `apps/api/src/routes/__tests__/admin-*.worker.test.ts` file that mocks `../../middleware/auth.worker`.

Those test mocks must be removed when the middleware disappears. Leaving a fake `requireAuth: (_c, next) => next()` behind would make tests describe a security layer that production no longer has.

Historical completed documents under `docs/superpowers/` may remain historical records. Current product/runbook/config documentation must be updated.

### 3. Preserve the admin document-navigation seam

`apps/web/src/lib/services/adminNavigation.ts` and the document-navigation branch in `apps/web/src/routes/admin/+layout.svelte` remain.

A client-side navigation from a public page to `/admin` does not inherently make a new document request. The existing layout detects that case and calls `window.location.assign(...)`; this must remain so the browser reaches Cloudflare Access before rendering the admin document.

The layout is otherwise simplified: no session fetch, login-page special case, loading spinner, redirect-to-login state, or route-change session rechecks. On a direct admin document load that already passed Access, it renders its children immediately.

Update comments so they describe Cloudflare Access and origin isolation as the security boundary rather than referring to deleted application auth.

### 4. Simplify the admin upload CLIs instead of replacing auth

Keep the existing Cloudflare Access credential support:

- service tokens remain the preferred automation path;
- browser `CF_Authorization` JWT support may remain for operator use;
- `--skip-access` remains valid only for loopback/local targets.

Delete the Perseus login/session step. Once Access credentials are probed successfully, CLI GET/POST requests go directly to `/api/admin/puzzles` with the Access headers.

The startup CLI readiness check becomes an Access/backend-health check only. Remove `--passkey`, `ADMIN_PASSKEY`, `passkey-missing`, session-cookie parsing, and `/api/admin/login` calls.

Because the Worker no longer emits a `requireAuth` 401, Access probes no longer need `WORKER_AUTH_ERROR_CODE` to distinguish Worker 401 from Access 401. Probe semantics become simple:

- `200` -> Access accepted and backend is healthy;
- `401`, `302`, or `403` -> Access blocked;
- `5xx` -> Access reached the backend, but backend is unhealthy;
- network/unexpected response -> probe error.

### 5. Split the admin page by responsibility

Use three route-local components:

```text
apps/web/src/routes/admin/
  +page.svelte
  AdminPuzzlesPanel.svelte
  PlayerAccessPanel.svelte
```

`+page.svelte` owns only:

- page header;
- Upload and View Arcade links;
- local `puzzles | players` active-tab state;
- accessible tab buttons and conditional panel mount.

`AdminPuzzlesPanel.svelte` owns puzzle loading, processing polling, deletion, partial-success message, search/filter state, pagination state, and image-preview state.

`PlayerAccessPanel.svelte` owns the existing allowlist load/add/remove/error state.

The default tab is `PUZZLES`. Use normal accessible tab semantics (`tablist`, `tab`, `aria-selected`, `tabpanel`) but no reusable tab abstraction.

Mount only the active panel. This means Player Access is not fetched on initial admin load, processing polling stops while the puzzle panel is unmounted, and returning to a tab reloads that panel's data and local state. That reset is acceptable for this private admin tool.

### 6. Reuse existing web search/category seams

Do not create a second hand-rolled search field. Reuse:

```svelte
<SearchBar
  value={searchQuery}
  onInput={(value) => {
    searchQuery = value;
    pageIndex = 0;
  }}
/>
```

`SearchBar.svelte` already owns the `Search puzzles` accessible name, `SEARCH MISSIONS...` placeholder, focus styling, and component tests. Do not add debounce: gallery debounce belongs to the gallery route because it drives network requests; admin filtering is in-memory.

For the category `<select>`, import `PUZZLE_CATEGORIES` / `PuzzleCategory` through `$lib/constants/categories`, matching existing web conventions. Do not reuse `CategoryFilter.svelte`; its gallery chip UI is not appropriate for this admin toolbar.

Status remains a small route-local `<select>` with `ALL STATUS`, `READY`, `PROCESSING`, and `FAILED`.

### 7. Keep filter/page arithmetic pure and route-local

Do not bury all list math in Svelte `$derived` / write-back `$effect` code or force browser tests to prove array arithmetic through 20+ DOM rows.

Add one tiny route-local helper file, not a pagination framework:

```text
apps/web/src/routes/admin/adminPuzzleList.ts
apps/web/src/routes/admin/adminPuzzleList.test.ts
```

It owns two pure functions:

```ts
export function filterAdminPuzzles(
  puzzles: readonly PuzzleSummary[],
  filters: {
    query: string;
    category: 'all' | PuzzleCategory;
    status: 'all' | PuzzleStatus;
  }
): PuzzleSummary[];

export function pageSlice<T>(
  items: readonly T[],
  pageIndex: number,
  pageSize: number
): {
  page: T[];
  totalPages: number;
  clampedIndex: number;
};
```

`filterAdminPuzzles` uses the same name rule as gallery listing: trim query, lowercase, substring match. Category/status combine with AND semantics. A puzzle without category matches only `all` category.

`pageSlice` clamps without writing back into Svelte state. The panel derives the visible page from `clampedIndex`; criteria-change callbacks explicitly reset `pageIndex = 0`. If polling/deletion shrinks the current result set, the helper immediately renders the final valid page without a state-writing `$effect`.

Pure helper tests own:

- case-insensitive/trimmed name matching;
- category + status AND behavior;
- uncategorized behavior;
- empty result;
- page boundaries and out-of-range clamping.

Browser component tests own only wiring that needs the DOM: SearchBar callback, selects, Reset, filtered-empty copy/count, polling while a processing row is hidden, and one minimal pagination-control wiring case.

### 8. Search/filter before fixed 20-row pagination

`GET /api/admin/puzzles` and `fetchAdminPuzzles()` stay full-list contracts. The UI pipeline is:

```text
fresh full list
  -> filterAdminPuzzles(name + category + status)
  -> pageSlice(..., 20)
  -> rendered rows
```

Filters combine with AND semantics. Missing category metadata matches only `ALL CATEGORIES`; do not invent an `Uncategorized` category.

Provide `RESET` only while any criterion is active. Reset clears search/category/status and returns to page 1.

Empty states stay distinct:

- full list empty -> `No missions found.`
- full list non-empty but filtered list empty -> `No missions match the current search and filters.`

Keep polling based on the unfiltered `puzzles` array so a processing puzzle hidden by status/category/search still causes status refreshes.

Show Previous/Next only when filtered results exceed 20 rows. When filters are active, show the match count relative to total (for example `7 OF 127`).

No API/wire-contract or storage-service change is part of search/filter/pagination.

### 9. Reuse the reference image for enlargement

For ready puzzles, make the existing thumbnail a button labelled `View full image for <puzzle name>`. Clicking it sets route-local `previewPuzzle` state.

Render a small modal directly in `AdminPuzzlesPanel.svelte` using the existing `modalFocus` action pattern:

- `role="dialog"` and `aria-modal="true"`;
- focusable dialog container using `modalFocus`;
- Escape closes;
- visible Close button;
- `<img src={getReferenceImageUrl(previewPuzzle.id)} ...>` constrained to the viewport with `object-contain`.

Processing and failed placeholders are not clickable. Do not add a lightbox dependency or generic dialog component.

## Delivery Shape

Keep one implementation PR for this ticket unless explicitly approved otherwise.

The auth cut is the highest-risk part, so it must be the **first isolated implementation commit**. Before adding tab/search/filter/preview commits, run the complete Task 1 verification set and review the Task 1 diff on its own. This is an intra-PR review checkpoint only; it is not a second PR and does not imply a pre-merge production deploy.

The final production Access/seed smoke occurs after the single PR deploy. If a later decision explicitly approves splitting the ticket, Task 1 is already structured so it can be separated mechanically without redesign.

## Testing Strategy

### Admin authentication removal

- API route tests prove admin operations no longer require `perseus_session` and deleted login/session/logout routes are absent.
- All admin route test mocks of `auth.worker` are deleted.
- Worker environment fixtures no longer require `ADMIN_PASSKEY`.
- Admin layout tests prove direct admin loads render immediately and client-routed entry still forces a document navigation.
- Infrastructure/verification checks pin the existing `subdomain.enabled = false` and `previewsEnabled = false` behavior and narrow CLI path.
- Script tests prove status/upload work with Access credentials alone and no passkey/session-cookie step.
- Current seed workflow no longer injects `ADMIN_PASSKEY`.

### Admin UI

- Shell tests prove `PUZZLES` is default and Player Access loads only after selecting its tab.
- Puzzle-panel tests retain ready/processing/failed rendering, delete/force-delete/error behavior, and three-second polling.
- Pure helper tests own filter and page arithmetic.
- Panel tests cover control wiring, Reset, filtered-empty copy/count, polling while filtered, pagination-button wiring, and preview.
- Player-access tests retain linked-player display plus add/remove/error behavior after extraction.

## Documentation Cleanup

Update current operational/product documentation and comments that instruct operators to set an admin passkey or describe `perseus_session` as a live security layer, including `AGENTS.md`, `CLAUDE.md`, `docs/PRD.md`, infrastructure README, and the operator runbook.

Historical completed design/plan documents under `docs/superpowers/` may remain historical records.

## Rollout

This is intentionally a breaking auth change with no compatibility window.

After deployment, manually verify:

1. Allowed browser identity/device opens `/admin` without a Perseus passkey prompt.
2. A browser/device denied by Cloudflare Access cannot reach `/admin` or broad admin API paths.
3. Direct public Worker subdomain/preview access remains disabled.
4. CLI service token can list/create through exact `/api/admin/puzzles`.
5. CLI service token cannot reach `/api/admin/puzzle-delete/:id` through Access.
6. Production startup seed workflow runs without `ADMIN_PASSKEY`.
7. `PUZZLES` supports name search, category/status filtering, Reset, and 20-row filtered pagination.
8. `PLAYER ACCESS` remains separately managed in its own tab.
9. Ready puzzle thumbnails open the enlarged reference image.
10. Public player routes remain unaffected.
11. Local development opens the admin portal without a passkey.

## Review Decisions

The external design review was applied selectively after checking the tree:

1. **Accepted: complete auth deletion inventory.** The review identified live files missing from the plan: `AGENTS.md`, `docs/PRD.md`, seed workflow, API client tests, worker-extra fixtures, rate-limit post-tracking tests, and admin-route auth mocks.
2. **Accepted: pure list helpers.** Filter/page arithmetic moves to two tiny route-local pure functions; no framework is introduced.
3. **Accepted: reuse `SearchBar` and web category constants.** This removes duplicate search markup and follows existing web imports.
4. **Partially accepted: auth review isolation.** The risk is real, but splitting one ticket into two PRs conflicts with the project delivery constraint. Task 1 remains an isolated first commit with a hard verification/review checkpoint inside the single PR; production smoke stays post-deploy.
5. **Accepted: remove stale auth mocks, not just production middleware.** Tests must stop pretending `requireAuth` exists after the feature is deleted.
6. **Kept from prior review: no backend admin query layer.** Full-list admin API remains necessary for processing polling and startup deduplication.
7. **Kept from prior review: no duplicate Wrangler ingress flags.** Pulumi remains the ingress source of truth.
