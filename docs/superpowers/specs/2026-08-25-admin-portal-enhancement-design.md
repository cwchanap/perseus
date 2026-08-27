# Admin Portal Enhancement Design

## Summary

Simplify the Perseus admin portal around the Cloudflare Zero Trust boundary that already protects production, then improve the existing admin UI with tab separation, client-side puzzle search/filtering + pagination, and enlarged reference-image viewing.

This remains one implementation slice and one PR. It does not add a new auth mechanism, backend admin query API, storage index, tab framework, or pagination library.

## Goals

- Remove the Perseus admin passkey and `perseus_session` layer.
- Keep Cloudflare Access as the production admin security boundary.
- Preserve the existing full-document navigation seam for client-routed entry into `/admin`.
- Preserve the narrow Access service-token path for admin upload automation, without the app passkey/session step.
- Separate puzzle management and player allowlist management into `PUZZLES` and `PLAYER ACCESS` tabs.
- Search puzzles by name and filter by category/status.
- Paginate filtered puzzle results at a fixed 20 rows.
- Open ready puzzle reference images in the existing full-screen reference overlay.

## Non-Goals

- No Worker-side Access JWT validation or replacement local-dev admin auth.
- No role/permission system.
- No backend admin search/filter/pagination API or server-side admin search index.
- No admin sorting/page-size selector.
- No Player Access search/filtering/pagination.
- No URL-backed search/filter/tab state or nested admin routes.
- No generic tab/filter/pagination/dialog/lightbox framework.
- No new image endpoint or raw-original download path.
- No compatibility path for deleted passkey/session APIs.
- No new Worker route/custom-domain IaC in this task.

## Current Context

Cloudflare Access already protects `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*`. A more-specific CLI Access application covers the exact admin puzzle endpoint and adds a Service Auth policy for upload automation.

The Pulumi-managed API Worker already has:

```ts
subdomain: { enabled: false, previewsEnabled: false }
```

That blocks the normal `workers.dev` and preview entry points. After `requireAuth` is removed, this origin-isolation setting is no longer merely defense in depth: any other live hostname/route that reaches the Worker without an Access application would expose the admin API without an application auth gate.

The repository does **not** declare the production Worker Custom Domain/Route. `createWorkerRoute()` is exported but unused, and the production Wrangler config contains no route/custom-domain declaration. Therefore the repo cannot prove that `AUTH_REDIRECT_BASE_URL` is the Worker's only live hostname. The implementation rollout must explicitly inspect the deployed Worker's Domains/Routes before shipping the auth removal.

The current application adds a second admin-auth layer: `/api/admin/login` validates `ADMIN_PASSKEY`, creates `perseus_session`, the admin layout checks it, and admin handlers use `requireAuth`. Startup/one-off upload CLIs also obtain that session after passing Cloudflare Access.

`GET /api/admin/puzzles` intentionally returns the full fresh all-status list. Processing polling and startup deduplication depend on that behavior. The public gallery paginator cannot be reused because it filters to `ready` and is backed by the gallery cache.

The web app already provides:

- `SearchBar.svelte` for the exact search input chrome/accessibility.
- `$lib/constants/categories` for category values/types.
- `ReferenceOverlay.svelte` for a full-screen reference dialog with focus trapping/restoration, close control, coarse-pointer sizing, and image-error fallback.
- `getReferenceImageUrl(puzzleId)` for the existing reference endpoint.

## Design

### 1. Cloudflare Access becomes the only production admin authentication gate

Delete the application admin auth feature completely:

- Remove `/api/admin/login`, `/api/admin/session`, `/api/admin/logout`.
- Remove `requireAuth` from operational admin handlers without changing handler bodies.
- Delete the admin-session middleware and dedicated tests after all live/test references are removed.
- Remove `ADMIN_PASSKEY` from Worker `Env`, runtime validation, Pulumi bindings, GitHub Actions deployment/seed inputs, local/E2E config, CLI options, and current docs.
- Remove admin-only `LoginResponse`, `SessionResponse`, and `WORKER_AUTH_ERROR_CODE`.
- Delete `/admin/login` and the Perseus `LOGOUT` control.
- Keep `JWT_SECRET` and all player auth unchanged.

Production authorization becomes:

```text
Browser admin
  -> Cloudflare Access identity + device posture
  -> /admin and /api/admin/*

Admin upload automation
  -> Cloudflare Access service token
  -> exact /api/admin/puzzles only
```

The sibling destructive endpoint stays `POST /api/admin/puzzle-delete/:id`, outside the CLI Service Auth path.

Browser admin fetches keep `credentials: 'include'` so the Access cookie continues to ride with requests.

Local development intentionally has no admin auth after this change.

### 2. Treat ingress coverage as a rollout precondition

Before deploying the auth removal:

1. Open the deployed API Worker in Cloudflare Workers & Pages and inspect its Domains/Routes view (the exact dashboard label may vary).
2. Enumerate every live Route and Custom Domain for the Worker.
3. Confirm `workers.dev` and Preview URLs are disabled.
4. For every live hostname, verify an Access application covers `/admin*` and `/api/admin*`.
5. Stop the rollout if any reachable hostname bypasses Access.

Do not add new routing IaC merely to satisfy this ticket; the check documents the current external assumption cheaply.

### 3. Remove first, then repair deletion-owned tests

Task 1 is a deletion/refactor, not new behavioral logic. Do not spend multiple steps rewriting ~30 tests against APIs that still exist just to manufacture a long red phase.

Within the isolated Task 1 commit:

1. Record a green baseline for affected suites.
2. Delete production/session/CLI/config surface.
3. Repair directly-owned tests/fixtures/mocks to match the deletion.
4. Run the full case-insensitive repository sweep and verification gate.

Tasks 3 and 4 remain test-first because they add new behavior whose contract benefits from red/green development.

### 4. Preserve the admin document-navigation gate without mounting children first

Client-side navigation from a public page to `/admin` must still become a full document navigation so Cloudflare Access can challenge it.

After session checking is removed, the layout must **not render admin children until it has decided whether a full-document redirect is required**. Do not rely on parent/child `onMount` ordering.

Use a blocked-by-default state:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		forceAdminDocumentNavigation,
		isClientRoutedAdminPath
	} from '$lib/services/adminNavigation';

	let { children } = $props();
	let redirecting = $state(true);

	onMount(() => {
		const shouldRedirect = isClientRoutedAdminPath($page.url.pathname);
		redirecting = shouldRedirect;

		if (shouldRedirect) {
			forceAdminDocumentNavigation($page.url);
		}
	});
</script>

{#if !redirecting}
	{@render children()}
{/if}
```

This preserves the Access challenge seam and prevents puzzle/allowlist fetches from starting before that decision.

### 5. Simplify the upload CLIs to Access-only authentication

Keep:

- service token as the preferred automation credential;
- optional `CF_Authorization` JWT path for operator use;
- `--skip-access` only for loopback/local targets.

Delete:

- `--passkey` / `ADMIN_PASSKEY`;
- `/api/admin/login`;
- app session-cookie parsing;
- `passkey-missing`;
- `WORKER_AUTH_ERROR_CODE` / Worker-401 disambiguation.

Probe mapping becomes:

```text
200           -> ok
401/302/403   -> Access blocked
5xx           -> backend unhealthy
other/network -> error
```

The seed workflow keeps only `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.

This changes automation from two credentials (Access service token + app passkey) to one Access service token for list/create. Document that explicitly. If that credential is suspected compromised, temporarily disable it, rotate it, revoke/delete it, or remove/disable its Service Auth policy. There is no longer a passkey second factor.

The currently configured token lifetime is one year (`8760h`), so current docs that still claim a 90-day default must be corrected.

### 6. Make the auth deletion inventory complete but symlink-safe

Known live deletion/repair surface includes:

- API admin route/Worker env and admin session middleware.
- Login-only rate limiter exports and login cases in all three rate-limit test owners, including `rate-limit-post-tracking.worker.test.ts`.
- Every admin route test that mocks `../../middleware/auth.worker`; delete those mocks rather than replacing them with pass-through fakes.
- `apps/web/src/lib/services/__tests__/api.test.ts`.
- `apps/api/src/__tests__/worker-extra.worker.test.ts`.
- `apps/api/src/services/__tests__/reaper.test.ts`.
- `scripts/startup/upload.test.ts`.
- CLI files/tests.
- `.github/workflows/deploy-infrastructure.yml`.
- `.github/workflows/seed-startup-puzzles.yml`.
- Pulumi `adminPasskey` binding and current operator docs.
- `CLAUDE.md`, `docs/PRD.md`, and pending `docs/follow_up/**` text.

`AGENTS.md` is a symlink to `CLAUDE.md`, not a second document. Modify `CLAUDE.md` only and verify the symlink remains `AGENTS.md -> CLAUDE.md`.

`packages/infrastructure/Pulumi.production.yaml` is not tracked; stack files are gitignored. After deployed code no longer consumes `adminPasskey`, remove the orphan key from the actual Pulumi stack configuration operationally rather than adding a nonexistent repo file to the change list.

Historical completed docs under `docs/superpowers/**` remain unchanged.

### 7. Split the admin page by responsibility

Keep route-local composition:

```text
apps/web/src/routes/admin/
  +page.svelte
  AdminPuzzlesPanel.svelte
  PlayerAccessPanel.svelte
  adminPuzzleList.ts
  adminPuzzleList.test.ts
```

`+page.svelte` owns only the header, Upload/View Arcade links, active tab, and two accessible tab buttons.

`AdminPuzzlesPanel` owns puzzle fetch/poll/delete, search/filter/page state, and preview state.

`PlayerAccessPanel` owns allowlist load/add/remove/error state.

Mount only the active panel. `PUZZLES` is the default. No tab framework or URL state.

### 8. Reuse SearchBar and web category constants

Use `SearchBar` unchanged. Admin search is immediate client-side filtering, so no debounce.

Use `PUZZLE_CATEGORIES` / `PuzzleCategory` from `$lib/constants/categories`.

Use simple route-local `<select>` controls for:

- `ALL CATEGORIES` + categories
- `ALL STATUS`, `READY`, `PROCESSING`, `FAILED`

Do not reuse gallery `CategoryFilter.svelte`; its chip UI is not suitable here.

### 9. Keep filter/page arithmetic in two pure route-local helpers

Add only:

```ts
filterAdminPuzzles(puzzles, { query, category, status });
pageSlice(items, pageIndex, pageSize);
```

`filterAdminPuzzles`:

- trims/lowercases query;
- uses case-insensitive substring name matching;
- combines name/category/status with AND semantics;
- excludes uncategorized puzzles from concrete category filters.

`pageSlice` returns `{ page, totalPages, clampedIndex }`. Criteria handlers explicitly reset `pageIndex = 0`. Poll/deletion shrinkage uses `clampedIndex` for rendering/navigation; do not introduce a `$effect` that reads and writes page state.

Pure tests own filter/page arithmetic. Browser tests own only UI wiring plus one 21-row pagination wiring case.

Pipeline:

```text
fresh full list
  -> filterAdminPuzzles(...)
  -> pageSlice(..., 20)
  -> render
```

Polling still inspects the unfiltered full list so hidden `processing` rows keep status refreshes active.

### 10. Reuse ReferenceOverlay unchanged for enlarged images

Do not hand-roll a weaker modal.

For a ready row:

- thumbnail button sets `previewPuzzle`;
- `ReferenceOverlay` receives `imageUrl={getReferenceImageUrl(previewPuzzle.id)}`, `active`, `dismissible`, and `onDismiss`.

The existing component already handles focus trapping/restoration, Close, coarse-pointer target size, and `Reference image unavailable` on image load failure. That fallback matters for legacy rows because `PuzzleSummary` cannot tell the admin whether a reference asset exists.

Keep Escape handling route-local in `AdminPuzzlesPanel`, mirroring the gameplay route:

```svelte
<svelte:window onkeydown={handlePreviewKeyDown} />
```

```ts
function handlePreviewKeyDown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || previewPuzzle === null) return;
	event.preventDefault();
	previewPuzzle = null;
}
```

`ReferenceOverlay` already lets non-Tab keys bubble, so it requires no new props or behavior changes for this task. Its existing accessible name `Reference image` is sufficient; do not invent a puzzle-specific dialog API solely for admin.

Processing/failed placeholders remain non-interactive.

## Testing Strategy

### Auth deletion

- Start from a green baseline.
- Delete runtime/config first, then repair directly-owned tests.
- Admin routes succeed locally without `perseus_session`; deleted login/session/logout routes are absent.
- No admin test retains an `auth.worker`/`requireAuth` mock.
- Web API tests retain `credentials: 'include'` and treat a synthetic 401 only as generic error handling.
- Worker/reaper fixtures no longer contain `ADMIN_PASSKEY`.
- CLI tests cover Access-only probes/requests.
- Seed/deploy workflow tests/config no longer require the passkey.
- Case-insensitive sweep covers `apps`, `packages`, `scripts`, `.github`, `.agents`, `CLAUDE.md`, and `docs` except historical `docs/superpowers/**`.
- Symlink check proves `AGENTS.md -> CLAUDE.md`.

### Admin UI

- Shell tests: default `PUZZLES`, lazy `PLAYER ACCESS`.
- Pure helper tests: trim/case/AND/uncategorized/page boundaries/clamp.
- Panel tests: SearchBar/select/Reset wiring, filtered-empty/count, hidden-processing polling, one 21-row pagination wiring case.
- Preview tests: ready thumbnail opens existing `ReferenceOverlay`, Close + Escape dismiss, failed image shows existing unavailable fallback, processing/failed placeholders do not open preview.
- Existing `ReferenceOverlay` tests remain the owner of focus/touch/error behavior.

## Delivery Shape

Keep one implementation PR for this ticket unless explicitly approved otherwise.

Task 1 remains the first isolated commit and must pass its complete verification + diff-review gate before UI commits begin. The Task 1 internal sequence is **baseline -> delete -> repair tests -> sweep -> verify**, not a long deletion-specific red phase.

Production ingress verification and service-token smoke happen at rollout after the single PR is deployed.

## Rollout

Before deploying the auth removal:

1. Enumerate every live Route and Custom Domain for the deployed API Worker from its Cloudflare Domains/Routes view or equivalent account API/CLI listing.
2. Confirm `workers.dev` and Preview URLs are disabled.
3. Confirm every live hostname that reaches the Worker is protected by Access for `/admin*` and `/api/admin*`.
4. Stop if any alternate hostname bypasses Access.

After deployment:

1. Allowed browser identity/device opens `/admin` without a Perseus passkey prompt.
2. Denied browser/device cannot reach `/admin` or broad admin API paths.
3. Browser navigation from the public SPA to `/admin` performs the full-document Access path before admin panels mount/fetch.
4. Service-token CLI can list/create through exact `/api/admin/puzzles`.
5. Service token cannot reach `/api/admin/puzzle-delete/:id`.
6. Production seed workflow succeeds with no `ADMIN_PASSKEY`.
7. `PUZZLES` search/category/status/Reset/20-row filtered pagination work.
8. `PLAYER ACCESS` add/remove still works.
9. Ready thumbnail opens the existing reference overlay; Close/Escape work; missing reference shows the unavailable fallback.
10. Public player routes remain unaffected.
11. Local dev opens admin without a passkey.
12. Remove the now-unused `adminPasskey` from the actual Pulumi stack config.
13. Verify the service-token incident procedure: temporarily disable, rotate, revoke/delete, or remove/disable Service Auth if compromised.

## Review Decisions

The latest review was checked against the tree:

1. **Accepted: live ingress enumeration before rollout.** Production route/custom-domain binding is external to this repo, so the Access-only assumption needs an operator check.
2. **Accepted: invert Task 1.** For a pure deletion, delete first and repair owned tests immediately afterward; keep TDD for new Tasks 3/4.
3. **Accepted: add `scripts/startup/upload.test.ts` and `reaper.test.ts`; widen the sweep.**
4. **Corrected: no tracked `Pulumi.production.yaml`.** Stack files are gitignored; remove `adminPasskey` from actual stack config operationally after deploy.
5. **Accepted: preserve `AGENTS.md` symlink.** Modify `CLAUDE.md` only.
6. **Accepted with a smaller implementation: reuse `ReferenceOverlay` unchanged.** Admin mirrors gameplay route-level Escape handling instead of adding props or duplicating modal markup.
7. **Accepted invariant, not lifecycle assumption: block children until the document-navigation decision.**
8. **Accepted: document automation-factor change.** The Access service token becomes the sole list/create credential; current emergency controls include temporary disable, rotation, revoke/delete, and policy removal rather than only rotation.
