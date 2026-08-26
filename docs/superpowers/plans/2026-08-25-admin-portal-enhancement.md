# Admin Portal Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Perseus admin passkey/session layer with the existing Cloudflare Access boundary and improve the admin portal with tabs, 20-row client-side pagination, and enlarged reference-image viewing.

**Architecture:** Remove the redundant application admin session across browser, API, CLI, and deployment config while preserving the current Cloudflare Access path policies and forced admin document navigation. Keep `GET /api/admin/puzzles` as the existing fresh full-list API; pagination stays in the admin Svelte panel so processing polling and startup-upload deduplication keep their current semantics. Split the route into puzzle and player-access panels and reuse the existing reference-image endpoint plus `modalFocus` for enlargement.

**Tech Stack:** Svelte 5 / SvelteKit static adapter, TypeScript, Hono on Cloudflare Workers, Cloudflare Access + Pulumi, Bun, Vitest browser tests.

**Spec:** `docs/superpowers/specs/2026-08-25-admin-portal-enhancement-design.md`

## Global Constraints

- Deliver all implementation work in one PR.
- Cloudflare Access is the sole production admin authentication boundary after this change.
- Preserve `packages/infrastructure/src/workers.ts` behavior that disables both the Worker public subdomain and preview URLs; Pulumi remains the production source of truth.
- Preserve the forced full-document navigation seam for client-routed entry into `/admin`.
- Do not add Worker-side Access JWT validation or replacement local-dev admin auth.
- Do not add backend/storage pagination for `GET /api/admin/puzzles`.
- Keep the startup uploader's full-list deduplication behavior intact.
- Admin puzzle page size is fixed at 20.
- `PUZZLES` is the default admin tab; tab state stays local to the route.
- Reuse `GET /api/puzzles/:id/reference` through `getReferenceImageUrl()` for enlarged images.
- Do not add generic tab, pagination, dialog, or lightbox abstractions.
- Delete obsolete passkey/session compatibility paths instead of preserving backward compatibility.
- Keep player auth (`JWT_SECRET`, `PlayerSessionResponse`, Google auth, OAuth/avatar rate limiting) unchanged.

---

## Task 1: Retire the application admin passkey/session end-to-end

**Files:**

- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/worker.ts`
- Delete: `apps/api/src/middleware/auth.worker.ts`
- Delete: `apps/api/src/middleware/auth.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-extra.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-coverage.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit.worker.ts`
- Modify: `apps/api/src/middleware/rate-limit.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit-coverage.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin.worker.test.ts`
- Modify: `apps/api/src/__tests__/worker.test.ts`
- Modify other existing API tests only where they directly assert `requireAuth`, `ADMIN_PASSKEY`, or the deleted login/session endpoints.
- Modify: `packages/types/src/core.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Modify: `apps/web/src/lib/services/api.ts`
- Delete: `apps/web/src/routes/admin/login/+page.svelte`
- Delete: `apps/web/src/routes/admin/login/page.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/+layout.svelte`
- Modify: `apps/web/src/routes/admin/layout.svelte.test.ts`
- Modify: `apps/web/src/lib/services/adminNavigation.ts`
- Modify: `apps/web/src/routes/admin/+page.svelte`
- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/cli.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/startup/token.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/startup/cli.test.ts`
- Modify: `scripts/startup/token.test.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`
- Modify other script tests only where signatures change because the session-cookie argument disappears.
- Modify: `packages/infrastructure/src/admin-access.ts`
- Modify: `packages/infrastructure/src/admin-access.test.ts`
- Modify: `packages/infrastructure/src/workers.ts` comments only; preserve its Worker subdomain settings.
- Modify: `packages/infrastructure/src/index.ts`
- Modify: `packages/infrastructure/src/deploy-workflow.test.ts`
- Modify: `.github/workflows/deploy-infrastructure.yml`
- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/package.json`
- Modify: `apps/api/.env.example`
- Modify: `packages/infrastructure/README.md`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`
- Modify: `CLAUDE.md`

**Resulting interfaces:**

```ts
export type ReadinessOutcome =
  | { ready: true }
  | { ready: false; reason: 'access-probe-failed' }
  | { ready: false; reason: 'backend-unhealthy' }
  | { ready: false; reason: 'access-missing' };

export function evaluateReadiness(args: {
  skipAccess: boolean;
  hasToken: boolean;
  hasServiceToken: boolean;
  probeResult: string | undefined;
}): ReadinessOutcome;
```

```ts
export async function fetchExistingKeys(
  server: string,
  baseHeaders: Record<string, string>,
  requireReady?: boolean
): Promise<Set<string>>;

export async function pollForExistingKey(
  server: string,
  baseHeaders: Record<string, string>,
  dedupKey: string,
  requireReady?: boolean
): Promise<boolean>;

export async function uploadWithRetry(
  server: string,
  baseHeaders: Record<string, string>,
  formData: FormData,
  entryName: string,
  dedupKey: string
): Promise<Response>;
```

- [ ] **Step 1: Rewrite the admin layout tests around the Access document boundary**

In `apps/web/src/routes/admin/layout.svelte.test.ts`, replace session/login behavior with two contracts:

```ts
it('renders children immediately for a direct admin document load', async () => {
  vi.mocked(isClientRoutedAdminPath).mockReturnValue(false);
  render(AdminLayout, { children: makeChildren() });

  await expect.element(page.getByTestId('child-content')).toBeVisible();
  expect(forceAdminDocumentNavigation).not.toHaveBeenCalled();
});

it('forces document navigation when admin was entered through client routing', async () => {
  vi.mocked(isClientRoutedAdminPath).mockReturnValue(true);
  render(AdminLayout, { children: makeChildren() });

  await vi.waitFor(() => {
    expect(forceAdminDocumentNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/admin' })
    );
  });
});
```

Delete layout test mocks/assertions for `checkSession`, `goto('/admin/login')`, the login-page special case, loading state, and route-change session rechecks.

- [ ] **Step 2: Change API tests to the Access-only app contract**

In `apps/api/src/routes/__tests__/admin.worker.test.ts`, use its existing route harness to assert `GET /puzzles` succeeds without a `perseus_session`. In `apps/api/src/__tests__/worker.test.ts`, remove the production configuration expectation that `ADMIN_PASSKEY` is mandatory.

Replace login/session/logout success tests with 404 expectations for the deleted routes. Reuse existing test helpers; do not add a second Hono/Worker harness.

- [ ] **Step 3: Change script and infrastructure tests before production code**

In `scripts/startup/cli.test.ts`, remove `passkey-missing` and make a valid Access credential sufficient:

```ts
expect(
  evaluateReadiness({
    skipAccess: false,
    hasToken: false,
    hasServiceToken: true,
    probeResult: 'ok'
  })
).toEqual({ ready: true });
```

In `scripts/startup/token.test.ts` and upload tests, update the expected probe/request path so a successful Access probe reaches `GET /api/admin/puzzles` directly; no test should expect `/api/admin/login` or `perseus_session`.

In `packages/infrastructure/src/admin-access.test.ts`:

```ts
expect(CLI_ACCESS_PATHS).toEqual(['/api/admin/puzzles']);
```

In `packages/infrastructure/src/deploy-workflow.test.ts`, assert `adminPasskey` is absent while the existing Access, JWT, and Google auth settings remain.

- [ ] **Step 4: Run focused tests and confirm the new contract is red**

```bash
bun run test:unit --filter=@perseus/web
bun run test:unit --filter=@perseus/api
bun run test:scripts
bun run test:unit --filter=@perseus/infrastructure
```

Expected before implementation: the new Access-only expectations fail against the current passkey/session implementation.

- [ ] **Step 5: Remove the API admin session layer**

In `apps/api/src/routes/admin.worker.ts`:

- delete the imports from `../middleware/auth.worker`;
- delete the `loginRateLimit` import;
- delete `/login`, `/session`, and `/logout` handlers;
- remove `requireAuth` from every operational admin handler while leaving each handler body unchanged.

A puzzle-list handler should become:

```ts
admin.get('/puzzles', async (c) => {
  try {
    const { puzzles: puzzleList } = await listPuzzles(c.env.PUZZLE_METADATA);
    return c.json({ puzzles: puzzleList });
  } catch (error) {
    console.error('Failed to list puzzles for admin', error);
    return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
  }
});
```

Apply only the middleware removal to create, allowlist, and delete handlers; do not rewrite their business logic.

In `apps/api/src/worker.ts`, remove `ADMIN_PASSKEY: string` from `Env` and remove the production `missingEnv` check for `ADMIN_PASSKEY`. Keep `JWT_SECRET` validation.

Delete `apps/api/src/middleware/auth.worker.ts` and its three dedicated test files once route references are gone.

- [ ] **Step 6: Remove only login-specific rate limiting**

In `apps/api/src/middleware/rate-limit.worker.ts`, delete `loginRateLimit()` and `resetLoginAttempts()`. Remove `MAX_LOGIN_ATTEMPTS` and the login-key helper only if they become unused.

Keep `oauthRateLimit()`, `avatarRateLimit()`, `resetAvatarAttempts()`, and the shared KV helpers unchanged. Delete only login-oriented cases from `rate-limit.worker.test.ts` / `rate-limit-coverage.worker.test.ts`; keep OAuth/avatar coverage.

- [ ] **Step 7: Remove the browser login/session surface but keep forced document navigation**

Delete the two files under `apps/web/src/routes/admin/login/`.

Remove `login()`, `logout()`, and `checkSession()` from `apps/web/src/lib/services/api.ts`.

Reduce `apps/web/src/routes/admin/+layout.svelte` to:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import {
    forceAdminDocumentNavigation,
    isClientRoutedAdminPath
  } from '$lib/services/adminNavigation';

  let { children } = $props();
  let redirecting = $state(false);

  onMount(() => {
    if (isClientRoutedAdminPath($page.url.pathname)) {
      redirecting = true;
      forceAdminDocumentNavigation($page.url);
    }
  });
</script>

{#if !redirecting}
  {@render children()}
{/if}
```

Update `adminNavigation.ts` comments to say Cloudflare Access is the security boundary. Keep the helper logic unchanged.

Remove the Perseus `LOGOUT` button and its state/handler/imports from `apps/web/src/routes/admin/+page.svelte`; keep Upload and View Arcade.

- [ ] **Step 8: Remove admin-only shared auth contracts**

From `packages/types/src/core.ts`, delete `LoginResponse`, the admin `SessionResponse`, and `WORKER_AUTH_ERROR_CODE`. Do not change `PlayerSessionResponse`.

Remove the matching imports/re-exports from `apps/web/src/lib/types/puzzle.ts` and imports from `apps/web/src/lib/services/api.ts`.

- [ ] **Step 9: Remove the passkey/session step from both upload CLIs**

In `scripts/startup/types.ts`, remove `passkey` from `Options` and update the Access-app comment to name only `/api/admin/puzzles`.

In `scripts/startup/cli.ts`:

- remove `--passkey` from usage and value flags;
- stop loading `ADMIN_PASSKEY`;
- remove passkey status output;
- apply the new `ReadinessOutcome`/`evaluateReadiness()` signature.

In `scripts/startup/upload.ts`:

- delete `sessionCookieFrom()` and `adminLogin()`;
- remove the cookie argument from `fetchExistingKeys()`, `pollForExistingKey()`, `uploadWithRetry()`, and internal `processEntry()`;
- after `resolveAndProbeAccess()`, send GET/POST requests directly with `accessHeaders(options)`.

The POST header shape remains:

```ts
headers: {
  ...baseHeaders,
  'Idempotency-Key': idempotencyHeader
}
```

In `scripts/startup/token.ts`, delete `WORKER_AUTH_ERROR_CODE` and `isWorkerAuth401()`. Treat `401`, `302`, and `403` as Access blocked; keep `200` as accepted and `5xx` as backend unhealthy.

In `scripts/admin-upload-puzzle.ts`, remove its passkey option/env lookup and `/api/admin/login` call, then POST directly with `accessHeaders(options)`.

Update `scripts/admin-bulk-upload-startup.ts` operator comments so they no longer mention `ADMIN_PASSKEY`.

- [ ] **Step 10: Remove passkey deployment/config inputs and keep the existing ingress guard**

In `packages/infrastructure/src/admin-access.ts`:

```ts
export const CLI_ACCESS_PATHS = ['/api/admin/puzzles'] as const;
```

Update comments to describe Cloudflare Access as the only admin gate. Preserve the exact-path boundary that keeps `POST /api/admin/puzzle-delete/:id` outside the CLI service-token application.

In `packages/infrastructure/src/index.ts`, remove the `ADMIN_PASSKEY: config.requireSecret('adminPasskey')` binding.

Remove `adminPasskey` from both Pulumi config maps in `.github/workflows/deploy-infrastructure.yml`.

Remove the local/E2E `ADMIN_PASSKEY` values from `apps/api/wrangler.toml` and `apps/api/package.json`.

Update `packages/infrastructure/src/workers.ts` comments but preserve exactly:

```ts
subdomain: { enabled: false, previewsEnabled: false }
```

Update current operator/config docs in `apps/api/.env.example`, `packages/infrastructure/README.md`, `.agents/skills/perseus-operations/references/operator-runbook.md`, and `CLAUDE.md`. Leave historical completed files under `docs/superpowers/` unchanged.

- [ ] **Step 11: Sweep current code/docs for deleted auth references**

```bash
rg -n "ADMIN_PASSKEY|adminPasskey|/api/admin/login|/api/admin/session|/api/admin/logout|checkSession\(|WORKER_AUTH_ERROR_CODE" \
  apps packages scripts .github CLAUDE.md .agents \
  --glob '!docs/superpowers/**'

rg -n "perseus_session" apps packages scripts .github CLAUDE.md .agents
```

Expected: no active admin-auth references remain.

- [ ] **Step 12: Verify Task 1**

```bash
bun run test:unit --filter=@perseus/types
bun run test:unit --filter=@perseus/api
bun run test:unit --filter=@perseus/web
bun run test:scripts
bun run check:scripts
bun run test:unit --filter=@perseus/infrastructure
bun run check --filter=@perseus/api --filter=@perseus/web --filter=@perseus/infrastructure
```

Expected: every command exits 0.

- [ ] **Step 13: Commit Task 1**

```bash
git add apps packages scripts .github CLAUDE.md .agents
git commit -m "refactor: rely on Cloudflare Access for admin auth"
```

---

## Task 2: Split puzzle management and Player Access into route-local tabs

**Files:**

- Modify: `apps/web/src/routes/admin/+page.svelte`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte`
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts`

**Ownership:**

- `+page.svelte`: page header, Upload/View Arcade links, local active-tab state.
- `AdminPuzzlesPanel.svelte`: puzzle loading, polling, deletion, success/error state.
- `PlayerAccessPanel.svelte`: allowlist loading, add/remove, stale-response guard, error state.

- [ ] **Step 1: Add a failing shell test for default tab and lazy Player Access loading**

In `admin-page.svelte.test.ts`:

```ts
render(AdminPage);

await expect.element(page.getByRole('tab', { name: 'PUZZLES' })).toHaveAttribute(
  'aria-selected',
  'true'
);
expect(fetchAdminPuzzles).toHaveBeenCalledOnce();
expect(fetchPlayerAllowlist).not.toHaveBeenCalled();

await page.getByRole('tab', { name: 'PLAYER ACCESS' }).click();
await vi.waitFor(() => expect(fetchPlayerAllowlist).toHaveBeenCalledOnce());
```

Keep shell assertions for the Control Panel heading, Upload, and View Arcade.

- [ ] **Step 2: Run the web unit suite and confirm the tab test is red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected before implementation: the tab/lazy-load assertions fail.

- [ ] **Step 3: Extract puzzle behavior into `AdminPuzzlesPanel.svelte`**

Move the current puzzle-owned state/functions and `MISSION DATABASE` markup without behavior changes:

```text
puzzles
loadingPuzzles
puzzlesError
puzzlesFetchInFlight
successMessage / successTimeout
deletingId
pollInterval
mounted
sessionStorageAdapter
showSuccess()
startPollingIfNeeded()
loadPuzzles()
handleDelete()
puzzle onMount/onDestroy lifecycle
```

Move the existing puzzle-specific tests from `admin-page.svelte.test.ts` into `AdminPuzzlesPanel.svelte.test.ts`: ready/processing/failed rendering, load error, ready delete, force delete, delete error, partial warning, warning timer replacement, and processing polling.

- [ ] **Step 4: Extract allowlist behavior into `PlayerAccessPanel.svelte`**

Move the current allowlist-owned state/functions and `PLAYER ACCESS` markup:

```text
allowlist
allowlistEmail
loadingAllowlist
allowlistError
allowlistSaving
removingAllowlistEmail
allowlistLoadSequence
loadAllowlist()
handleAllowlistSubmit()
handleAllowlistRemove()
```

Its `onMount` calls only `loadAllowlist()`.

Move allowlist tests into `PlayerAccessPanel.svelte.test.ts`: linked/pending rows, load error, add, add error, remove, remove error, and stale-response protection.

- [ ] **Step 5: Reduce `+page.svelte` to the shell and tabs**

Use local state only:

```svelte
<script lang="ts">
  import AdminPuzzlesPanel from './AdminPuzzlesPanel.svelte';
  import PlayerAccessPanel from './PlayerAccessPanel.svelte';

  type AdminTab = 'puzzles' | 'players';
  let activeTab: AdminTab = $state('puzzles');
</script>
```

Render two buttons inside `role="tablist"`, set `role="tab"`, `aria-selected`, and `aria-controls`, and conditionally mount exactly one `role="tabpanel"`.

Do not add URL/query synchronization. Switching away destroys the inactive panel; returning reloads its data and resets that panel's local state.

- [ ] **Step 6: Verify Task 2**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/web/src/routes/admin
git commit -m "refactor: split admin portal into tabs"
```

---

## Task 3: Add fixed 20-row client-side puzzle pagination

**Files:**

- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`

**Contract:** `fetchAdminPuzzles(): Promise<PuzzleSummary[]>` and `GET /api/admin/puzzles` stay unchanged.

- [ ] **Step 1: Add failing pagination tests with 21 puzzles**

Create 21 ready `PuzzleSummary` rows. Assert page 1 shows rows 1-20, row 21 is absent, Previous is disabled, and `PAGE 1 / 2` is shown. Click Next and assert row 21 is visible, row 1 is absent, Next is disabled, and Previous returns to page 1.

Add a second case: navigate to page 2, delete its only row, have the reload return 20 rows, and assert the component clamps back to the valid first page.

- [ ] **Step 2: Run the web unit suite and confirm pagination is red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected before implementation: the pagination controls/visibility assertions fail.

- [ ] **Step 3: Add route-local pagination state**

In `AdminPuzzlesPanel.svelte`:

```ts
const PAGE_SIZE = 20;
let pageIndex = $state(0);

const totalPages = $derived(Math.max(1, Math.ceil(puzzles.length / PAGE_SIZE)));
const visiblePuzzles = $derived(
  puzzles.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)
);

function clampPageIndex() {
  const maxPageIndex = Math.max(0, Math.ceil(puzzles.length / PAGE_SIZE) - 1);
  pageIndex = Math.min(pageIndex, maxPageIndex);
}
```

Call `clampPageIndex()` after a successful `loadPuzzles()` assignment. Render `visiblePuzzles` instead of `puzzles`.

Keep processing polling based on `puzzles.some((p) => p.status === 'processing')` so processing work on a non-visible page still keeps polling active.

- [ ] **Step 4: Add minimal Previous/Next controls**

Render controls only when `puzzles.length > PAGE_SIZE`:

```svelte
<nav aria-label="Puzzle pages">
  <button type="button" disabled={pageIndex === 0} onclick={() => (pageIndex -= 1)}>
    PREVIOUS
  </button>
  <span>PAGE {pageIndex + 1} / {totalPages}</span>
  <button
    type="button"
    disabled={pageIndex >= totalPages - 1}
    onclick={() => (pageIndex += 1)}
  >
    NEXT
  </button>
</nav>
```

Use existing admin styling. Do not add page-number buttons or a page-size selector.

- [ ] **Step 5: Verify Task 3 and confirm the API did not change**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
git diff -- apps/api/src/routes/admin.worker.ts apps/web/src/lib/services/api.ts
```

Expected: tests/check exit 0; Task 3 has no API-client or API-route diff.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/web/src/routes/admin/AdminPuzzlesPanel.svelte apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts
git commit -m "feat: paginate admin puzzle list"
```

---

## Task 4: Add enlarged reference-image preview for ready puzzles

**Files:**

- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`

**Dependencies already present:** `getReferenceImageUrl(puzzleId)` and `$lib/actions/modalFocus`.

- [ ] **Step 1: Add failing preview tests**

Mock:

```ts
getReferenceImageUrl: vi.fn((id: string) => `/api/puzzles/${id}/reference`)
```

For a ready puzzle, click `View full image for Forest Scene` and assert a dialog named `Forest Scene image preview` appears with an image `src` of `/api/puzzles/p1/reference`.

Add Close-button and Escape-key cases. Assert processing/failed placeholders do not expose full-image buttons.

- [ ] **Step 2: Run the web unit suite and confirm preview is red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected before implementation: preview button/dialog assertions fail.

- [ ] **Step 3: Make only ready thumbnails interactive**

In `AdminPuzzlesPanel.svelte`:

```ts
import { getReferenceImageUrl, getThumbnailUrl } from '$lib/services/api';
import { modalFocus } from '$lib/actions/modalFocus';

let previewPuzzle: PuzzleSummary | null = $state(null);
```

Wrap only a ready thumbnail in:

```svelte
<button
  type="button"
  aria-label={`View full image for ${puzzle.name}`}
  onclick={() => (previewPuzzle = puzzle)}
>
  <img src={getThumbnailUrl(puzzle.id)} alt="" />
</button>
```

Keep processing and failed placeholders non-interactive.

- [ ] **Step 4: Add the route-local modal using the existing focus pattern**

Render the preview inside the same component:

```svelte
{#if previewPuzzle}
  <div class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4">
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${previewPuzzle.name} image preview`}
      tabindex="-1"
      use:modalFocus
      onkeydown={(event) => event.key === 'Escape' && (previewPuzzle = null)}
      class="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] flex-col border border-(--accent) bg-(--bg-1)"
    >
      <div class="flex items-center justify-between gap-4 border-b border-(--border) p-3">
        <span>{previewPuzzle.name}</span>
        <button type="button" onclick={() => (previewPuzzle = null)}>CLOSE</button>
      </div>
      <img
        src={getReferenceImageUrl(previewPuzzle.id)}
        alt={previewPuzzle.name}
        class="min-h-0 max-h-[calc(100dvh-6rem)] max-w-full object-contain"
      />
    </div>
  </div>
{/if}
```

Adjust only styling details needed to match the current admin visual language. Do not add zoom, pan, download, carousel, backdrop-click behavior, or a lightbox dependency.

- [ ] **Step 5: Verify Task 4**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/web/src/routes/admin/AdminPuzzlesPanel.svelte apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts
git commit -m "feat: preview admin puzzle images"
```

---

## Task 5: Final integration verification and scope audit

- [ ] **Step 1: Verify deleted auth references are gone from current code/docs**

```bash
rg -n "ADMIN_PASSKEY|adminPasskey|/api/admin/login|/api/admin/session|/api/admin/logout|checkSession\(|WORKER_AUTH_ERROR_CODE" \
  apps packages scripts .github CLAUDE.md .agents \
  --glob '!docs/superpowers/**'

rg -n "perseus_session" apps packages scripts .github CLAUDE.md .agents
```

Expected: no active admin-auth references remain.

- [ ] **Step 2: Verify the existing ingress and CLI scope remain narrow**

```bash
rg -n "subdomain:|previewsEnabled|CLI_ACCESS_PATHS|puzzle-delete" \
  packages/infrastructure/src apps/api/src/routes/admin.worker.ts
```

Confirm:

- API Worker still has `subdomain: { enabled: false, previewsEnabled: false }`.
- `CLI_ACCESS_PATHS` contains only `/api/admin/puzzles`.
- destructive deletion remains at `/api/admin/puzzle-delete/:id`.

- [ ] **Step 3: Run the complete affected verification set**

```bash
bun run test:unit --filter=@perseus/types
bun run test:unit --filter=@perseus/api
bun run test:unit --filter=@perseus/web
bun run test:unit --filter=@perseus/infrastructure
bun run test:scripts
bun run check:scripts
bun run check --filter=@perseus/api --filter=@perseus/web --filter=@perseus/infrastructure
bun run lint --filter=@perseus/api --filter=@perseus/web
bun run lint:scripts
```

Expected: every command exits 0.

- [ ] **Step 4: Audit the final diff against the four requested outcomes**

```text
[ ] Passkey/session removed; existing Cloudflare Access boundary retained
[ ] Player Access is a separate tab and does not load on the initial Puzzles tab
[ ] Puzzle list paginates in-memory at exactly 20 rows without changing the admin list API
[ ] Ready puzzle thumbnail opens the existing reference image in a focused modal
[ ] Forced admin document navigation remains
[ ] CLI service-token upload still works without application login
[ ] No generic auth/tab/pagination/lightbox framework was introduced
```

Fix mismatches in the owning task rather than adding compensating abstractions.

- [ ] **Step 5: Perform the deployment smoke check after merge/deploy**

1. Allowed browser identity/device opens `/admin` without a Perseus passkey prompt.
2. `PUZZLES` is selected initially and shows at most 20 rows.
3. `PLAYER ACCESS` loads when selected and add/remove still works.
4. Ready thumbnail opens the enlarged reference image; Close and Escape dismiss it.
5. `bun run admin:startup:status` with the existing CLI service-token environment reports readiness without asking for a passkey.
6. A bounded upload using the service token can list/create through `/api/admin/puzzles`.
7. The CLI service token cannot reach `/api/admin/puzzle-delete/:id` through Cloudflare Access.
8. A browser/device outside the Access policy cannot reach `/admin`.
