# Admin Portal Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Perseus admin passkey/session layer with the existing Cloudflare Access boundary and improve the admin portal with tabs, puzzle search/filtering, fixed 20-row client-side pagination, and enlarged reference-image viewing.

**Architecture:** Remove the redundant application admin session across browser, API, CLI, workflows, and deployment configuration while preserving Cloudflare Access, origin isolation, forced admin document navigation, and the full-list `GET /api/admin/puzzles` contract. Split the route into puzzle/player panels; reuse `SearchBar` and web category constants; keep filter/page arithmetic in two tiny pure route-local helpers; reuse the existing reference-image endpoint plus `modalFocus` for enlargement.

**Tech Stack:** Svelte 5 / SvelteKit static adapter, TypeScript, Hono on Cloudflare Workers, Cloudflare Access + Pulumi, Bun, Vitest browser tests.

**Spec:** `docs/superpowers/specs/2026-08-25-admin-portal-enhancement-design.md`

## Global Constraints

- Deliver all implementation work in one PR unless the user explicitly approves a split.
- Task 1 (auth/CLI/infra/docs) must be the first isolated implementation commit and pass its own verification/review gate before UI commits begin.
- Cloudflare Access is the sole production admin authentication boundary after this change.
- Preserve `packages/infrastructure/src/workers.ts` `subdomain: { enabled: false, previewsEnabled: false }`; Pulumi remains the production ingress source of truth.
- Preserve forced full-document navigation for client-routed entry into `/admin`.
- Do not add Worker-side Access JWT validation or replacement local-dev admin auth.
- Do not add backend/storage search, filtering, or pagination for `GET /api/admin/puzzles`.
- Keep the startup uploader's full-list deduplication behavior intact.
- Keep `credentials: 'include'` on browser admin API fetches.
- Admin search is case-insensitive substring matching on trimmed puzzle name.
- Admin filters are category + status with AND semantics.
- Admin puzzle page size is fixed at 20 and pagination runs after filtering.
- Search/filter changes reset page state to page 1.
- `PUZZLES` is the default admin tab; tab/search/filter/page state stays route-local.
- Reuse `SearchBar.svelte`, `$lib/constants/categories`, `getReferenceImageUrl()`, and `modalFocus`.
- Do not add generic auth, tab, filter, pagination, dialog, or lightbox abstractions.
- Delete obsolete passkey/session compatibility paths instead of preserving backward compatibility.
- Keep player auth (`JWT_SECRET`, `PlayerSessionResponse`, Google auth, OAuth/avatar rate limiting) unchanged.

---

## Task 1: Retire the application admin passkey/session end-to-end

This task is deliberately broad but mechanical: delete one authentication layer completely while preserving Cloudflare Access and player auth. Do not mix admin UX refactors into this commit.

### Files

**API runtime:**

- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/worker.ts`
- Delete: `apps/api/src/middleware/auth.worker.ts`
- Delete: `apps/api/src/middleware/auth.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-extra.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-coverage.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit.worker.ts`
- Modify: `apps/api/src/middleware/rate-limit.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit-coverage.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit-post-tracking.worker.test.ts`
- Modify: `apps/api/src/__tests__/worker.test.ts`
- Modify: `apps/api/src/__tests__/worker-extra.worker.test.ts`

**Admin route tests that currently mock `../../middleware/auth.worker` and must remove the mock entirely:**

- Modify: `apps/api/src/routes/__tests__/admin.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-coverage.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-ownership-catch.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-fail-reservation.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-cleanup-final.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-dead-pending-failure.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-idempotency-errors.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-ownership-mirror-best-effort.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-worker-extra.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-extra-coverage.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-idempotency-commit.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-aspect-ratio.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-ownership-db-init.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-idempotency-race.worker.test.ts`
- Modify: `apps/api/src/routes/__tests__/admin-coverage-gaps.worker.test.ts`

**Shared/web contracts:**

- Modify: `packages/types/src/core.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`
- Delete: `apps/web/src/routes/admin/login/+page.svelte`
- Delete: `apps/web/src/routes/admin/login/page.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/+layout.svelte`
- Modify: `apps/web/src/routes/admin/layout.svelte.test.ts`
- Modify: `apps/web/src/lib/services/adminNavigation.ts`
- Modify: `apps/web/src/routes/admin/+page.svelte`
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts`

**CLI:**

- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/cli.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/startup/token.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/startup/cli.test.ts`
- Modify: `scripts/startup/token.test.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`

**Infrastructure/workflows/config/docs:**

- Modify: `packages/infrastructure/src/admin-access.ts`
- Modify: `packages/infrastructure/src/admin-access.test.ts`
- Modify: `packages/infrastructure/src/workers.ts` comments only; preserve origin isolation exactly.
- Modify: `packages/infrastructure/src/index.ts`
- Modify: `packages/infrastructure/src/deploy-workflow.test.ts`
- Modify: `.github/workflows/deploy-infrastructure.yml`
- Modify: `.github/workflows/seed-startup-puzzles.yml`
- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/package.json`
- Modify: `apps/api/.env.example`
- Modify: `packages/infrastructure/README.md`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `docs/PRD.md`

### Resulting interfaces

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

### Steps

- [ ] **Step 1: Rewrite admin layout tests around the Access document boundary**

In `apps/web/src/routes/admin/layout.svelte.test.ts`, delete mocks/assertions for `checkSession`, `goto('/admin/login')`, login-page special casing, loading/redirecting-by-session, and route-change session rechecks.

Pin only the two behaviors that remain:

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

- [ ] **Step 2: Rewrite web API tests so admin auth is no longer a client contract**

In `apps/web/src/lib/services/__tests__/api.test.ts`:

- delete `login`, `logout`, and `checkSession` imports and their suites;
- keep `fetchAdminPuzzles()` success coverage and its `credentials: 'include'` assertion;
- change the current test named like `throws ApiError when not authenticated` into a generic error-propagation fixture, e.g. `throws ApiError for a 401 response`, without describing 401 as the expected admin-auth contract.

Example retained assertion:

```ts
expect(fetch).toHaveBeenCalledWith(
  expect.stringMatching(/\/api\/admin\/puzzles$/),
  expect.objectContaining({ credentials: 'include' })
);
```

- [ ] **Step 3: Rewrite API route/worker tests before deleting middleware**

In `apps/api/src/routes/__tests__/admin.worker.test.ts`, use its existing route harness to assert `GET /puzzles` succeeds without a `perseus_session`.

Replace login/session/logout success behavior with deleted-route expectations:

```ts
expect((await admin.request('/login', { method: 'POST' }, env)).status).toBe(404);
expect((await admin.request('/session', {}, env)).status).toBe(404);
expect((await admin.request('/logout', { method: 'POST' }, env)).status).toBe(404);
```

Use the existing test harness signature in that file; do not introduce a second Hono app just for these checks.

For every admin route test listed above, remove the entire `vi.mock('../../middleware/auth.worker', ...)` block. Do **not** replace it with a pass-through `requireAuth` fake.

In `apps/api/src/__tests__/worker-extra.worker.test.ts`:

- remove `ADMIN_PASSKEY` from `validEnv`;
- remove the fake admin `/session` route; the mocked admin router only needs routes used by that worker test.

In `apps/api/src/__tests__/worker.test.ts`, remove assertions that production requires `ADMIN_PASSKEY`; keep `JWT_SECRET` and CORS validation.

- [ ] **Step 4: Rewrite login-rate-limit tests to keep only player-facing behavior**

In `rate-limit.worker.test.ts`, `rate-limit-coverage.worker.test.ts`, and `rate-limit-post-tracking.worker.test.ts`:

- delete login-only imports/cases for `loginRateLimit` / `resetLoginAttempts`;
- preserve OAuth and avatar tests;
- preserve the shared KV helper behavior those paths still exercise.

`rate-limit-post-tracking.worker.test.ts` must stop importing `loginRateLimit`, otherwise deleting the export will break compilation.

- [ ] **Step 5: Rewrite CLI and infrastructure tests to Access-only semantics**

In `scripts/startup/cli.test.ts`, remove `passkey-missing` and make accepted Access credentials sufficient:

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

In token tests, pin simplified probe behavior:

```text
200 -> ok
401/302/403 -> blocked
5xx -> unhealthy
network/unexpected -> error
```

In upload tests, no request should call `/api/admin/login` or require a `perseus_session` cookie.

In `packages/infrastructure/src/admin-access.test.ts`:

```ts
expect(CLI_ACCESS_PATHS).toEqual(['/api/admin/puzzles']);
```

In `packages/infrastructure/src/deploy-workflow.test.ts`, assert `adminPasskey` is absent while Access, JWT, and Google configuration remain.

- [ ] **Step 6: Run the focused tests and confirm the new contract is red**

```bash
bun run test:unit --filter=@perseus/web
bun run test:unit --filter=@perseus/api
bun run test:scripts
bun run test:unit --filter=@perseus/infrastructure
```

Expected before implementation: failures are specifically caused by still-present passkey/session behavior, auth mocks, login limiter exports, CLI login flow, or `adminPasskey` configuration.

- [ ] **Step 7: Remove the API admin session layer**

In `apps/api/src/routes/admin.worker.ts`:

- delete imports from `../middleware/auth.worker`;
- delete the `loginRateLimit` import;
- delete `/login`, `/session`, and `/logout` handlers;
- remove `requireAuth` from every operational admin handler while leaving handler bodies unchanged.

Keep the full-list response unchanged:

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

In `apps/api/src/worker.ts`, remove `ADMIN_PASSKEY: string` from `Env` and remove only the production `missingEnv` check for `ADMIN_PASSKEY`. Keep `JWT_SECRET` validation.

Delete `apps/api/src/middleware/auth.worker.ts` and its three dedicated tests once every route/test reference has been removed.

- [ ] **Step 8: Remove only login-specific rate limiting**

In `apps/api/src/middleware/rate-limit.worker.ts`, delete `loginRateLimit()` and `resetLoginAttempts()`. Remove `MAX_LOGIN_ATTEMPTS` and the login-key helper if they become unused.

Keep `oauthRateLimit()`, `avatarRateLimit()`, `resetAvatarAttempts()`, and shared KV/read-modify-write helpers unchanged.

- [ ] **Step 9: Remove the browser login/session surface while preserving Access navigation**

Delete:

```text
apps/web/src/routes/admin/login/+page.svelte
apps/web/src/routes/admin/login/page.svelte.test.ts
```

Remove `login()`, `logout()`, and `checkSession()` from `apps/web/src/lib/services/api.ts`.

Do **not** remove `credentials: 'include'` from `fetchAdminPuzzles`, allowlist mutations, or delete requests.

Reduce `apps/web/src/routes/admin/+layout.svelte` to the document-navigation guard plus child rendering:

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

Update `adminNavigation.ts` comments so Cloudflare Access + origin isolation are described as the security boundary.

Remove the Perseus `LOGOUT` button, handler, state, `goto`, and `logout` import from the current admin page/test. Keep Upload and View Arcade.

- [ ] **Step 10: Remove admin-only shared auth contracts**

From `packages/types/src/core.ts`, delete:

```ts
export interface LoginResponse { /* deleted */ }
export interface SessionResponse { /* deleted */ }
export const WORKER_AUTH_ERROR_CODE = 'unauthorized';
```

Do not change `PlayerSessionResponse`.

Remove matching imports/re-exports from `apps/web/src/lib/types/puzzle.ts` and imports from web/CLI code.

- [ ] **Step 11: Remove the passkey/session step from both upload CLIs**

In `scripts/startup/types.ts`, remove `passkey` from `Options`; update the CLI Access comment to name only `/api/admin/puzzles`.

In `scripts/startup/cli.ts`:

- remove `--passkey` from usage/value flags;
- stop reading `ADMIN_PASSKEY`;
- remove passkey status output;
- use the new four-outcome `ReadinessOutcome`.

In `scripts/startup/upload.ts`:

- delete `sessionCookieFrom()` and `adminLogin()`;
- remove cookie parameters from `fetchExistingKeys()`, `pollForExistingKey()`, `uploadWithRetry()`, and `processEntry()`;
- after `resolveAndProbeAccess()`, call list/upload directly with `accessHeaders(options)`.

POST stays:

```ts
headers: {
  ...baseHeaders,
  'Idempotency-Key': idempotencyHeader
}
```

In `scripts/startup/token.ts`, remove `WORKER_AUTH_ERROR_CODE` / `isWorkerAuth401()` and use the simplified probe status mapping.

In `scripts/admin-upload-puzzle.ts`, remove passkey option/env lookup and `/api/admin/login`; POST directly with Access headers.

Update `scripts/admin-bulk-upload-startup.ts` comments to remove `ADMIN_PASSKEY` instructions.

- [ ] **Step 12: Remove passkey config from deployment and seed workflows**

In `packages/infrastructure/src/admin-access.ts`:

```ts
export const CLI_ACCESS_PATHS = ['/api/admin/puzzles'] as const;
```

Preserve the exact sibling delete boundary.

In `packages/infrastructure/src/index.ts`, remove:

```ts
ADMIN_PASSKEY: config.requireSecret('adminPasskey')
```

Remove `adminPasskey` from both config maps in `.github/workflows/deploy-infrastructure.yml`.

In `.github/workflows/seed-startup-puzzles.yml`, remove:

```yaml
ADMIN_PASSKEY: ${{ secrets.ADMIN_PASSKEY }}
```

Keep `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and the existing service-token stack-output resolution.

Remove local/E2E `ADMIN_PASSKEY` values from `apps/api/wrangler.toml` and `apps/api/package.json`.

- [ ] **Step 13: Update origin-isolation comments and current documentation**

In `packages/infrastructure/src/workers.ts`, preserve exactly:

```ts
subdomain: { enabled: false, previewsEnabled: false }
```

Rewrite the nearby comment so it no longer calls application `requireAuth` a backstop; state that disabling public Worker subdomain/preview access prevents bypassing the custom-domain Access policy.

Update current docs/config examples:

- `apps/api/.env.example`
- `packages/infrastructure/README.md`
- `.agents/skills/perseus-operations/references/operator-runbook.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/PRD.md`

`docs/PRD.md` admin journey should start with reaching the Cloudflare Access-protected `/admin`, not `/admin/login`.

Do not rewrite completed historical `docs/superpowers/**` files.

- [ ] **Step 14: Make the repository sweep the deletion source of truth**

Run after implementation:

```bash
rg -n \
  "ADMIN_PASSKEY|adminPasskey|/api/admin/login|/api/admin/session|/api/admin/logout|checkSession\(|WORKER_AUTH_ERROR_CODE|perseus_session|middleware/auth\.worker|loginRateLimit|resetLoginAttempts" \
  apps packages scripts .github .agents AGENTS.md CLAUDE.md docs/PRD.md \
  --glob '!docs/superpowers/**'
```

Expected: no active admin passkey/session references remain. Any hit outside explicitly historical text must be resolved before Task 1 is considered complete.

Also verify browser Access cookies are still carried:

```bash
rg -n "credentials: 'include'" apps/web/src/lib/services/api.ts
```

Expected: admin puzzle/allowlist/delete fetches still retain credentials.

- [ ] **Step 15: Verify Task 1 completely**

```bash
bun run test:unit --filter=@perseus/types
bun run test:unit --filter=@perseus/api
bun run test:unit --filter=@perseus/web
bun run test:scripts
bun run check:scripts
bun run test:unit --filter=@perseus/infrastructure
bun run check --filter=@perseus/api --filter=@perseus/web --filter=@perseus/infrastructure
bun run lint --filter=@perseus/api --filter=@perseus/web
bun run lint:scripts
```

Expected: every command exits 0.

Verify security/scoping textually:

```bash
rg -n "subdomain:|previewsEnabled|CLI_ACCESS_PATHS|puzzle-delete" \
  packages/infrastructure/src apps/api/src/routes/admin.worker.ts
```

Confirm:

- API Worker still disables subdomain + preview URLs;
- `CLI_ACCESS_PATHS` contains only `/api/admin/puzzles`;
- destructive delete remains `POST /api/admin/puzzle-delete/:id`.

- [ ] **Step 16: Commit Task 1 as one isolated auth commit**

```bash
git add apps packages scripts .github .agents AGENTS.md CLAUDE.md docs/PRD.md
git commit -m "refactor: rely on Cloudflare Access for admin auth"
```

- [ ] **Step 17: Stop and review the Task 1 commit before UI work**

```bash
git show --stat --oneline HEAD
git diff HEAD^..HEAD -- \
  apps/api \
  apps/web/src/routes/admin \
  apps/web/src/lib/services \
  scripts \
  packages/infrastructure \
  .github
```

Review checklist:

```text
[ ] No application admin login/session middleware remains
[ ] No admin route test still mocks requireAuth
[ ] Browser admin API calls still include credentials
[ ] Worker public subdomain + preview URLs remain disabled
[ ] CLI Access path is still exact /api/admin/puzzles
[ ] Delete endpoint remains outside CLI Access path
[ ] Seed workflow uses only Access service-token credentials
[ ] Player auth/JWT/OAuth/avatar behavior is untouched
[ ] No tab/search/filter/preview refactor is mixed into this commit
```

Do not begin Task 2 until this checkpoint is clean.

---

## Task 2: Split puzzle management and Player Access into route-local tabs

### Files

- Modify: `apps/web/src/routes/admin/+page.svelte`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte`
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts`

### Ownership

- `+page.svelte`: page header, Upload/View Arcade links, local active tab.
- `AdminPuzzlesPanel.svelte`: puzzle load/poll/delete/success/error behavior.
- `PlayerAccessPanel.svelte`: allowlist load/add/remove/stale-response/error behavior.

### Steps

- [ ] **Step 1: Add a failing shell test for default tab and lazy Player Access loading**

Mock the two panel-facing service calls and assert:

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

Keep shell assertions for Control Panel, Upload, and View Arcade.

- [ ] **Step 2: Run web tests and confirm the tab contract is red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected: tab/lazy-mount assertions fail before extraction.

- [ ] **Step 3: Extract existing puzzle behavior without product changes**

Move puzzle-owned state/functions/markup from `+page.svelte` into `AdminPuzzlesPanel.svelte`:

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
MISSION DATABASE markup
```

Move the existing puzzle tests into `AdminPuzzlesPanel.svelte.test.ts`: ready/processing/failed rendering, load error, ready delete, force delete, delete error, partial warning, warning timer replacement, and three-second polling.

Do not add search/filter/pagination yet.

- [ ] **Step 4: Extract existing Player Access behavior without product changes**

Move allowlist-owned state/functions/markup into `PlayerAccessPanel.svelte`:

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

Move linked/pending display, load error, add/error, remove/error, and stale-response tests into `PlayerAccessPanel.svelte.test.ts`.

- [ ] **Step 5: Reduce `+page.svelte` to shell + accessible tabs**

```svelte
<script lang="ts">
  import AdminPuzzlesPanel from './AdminPuzzlesPanel.svelte';
  import PlayerAccessPanel from './PlayerAccessPanel.svelte';

  type AdminTab = 'puzzles' | 'players';
  let activeTab: AdminTab = $state('puzzles');
</script>
```

Render two buttons in `role="tablist"`, set `role="tab"`, `aria-selected`, and `aria-controls`, and conditionally mount one `role="tabpanel"`.

Do not add URL/query synchronization.

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

## Task 3: Add pure admin list helpers, search/filter controls, and filtered pagination

### Files

- Create: `apps/web/src/routes/admin/adminPuzzleList.ts`
- Create: `apps/web/src/routes/admin/adminPuzzleList.test.ts`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Reuse unchanged: `apps/web/src/lib/components/SearchBar.svelte`
- Reuse unchanged: `apps/web/src/lib/constants/categories.ts`

### Interfaces

```ts
import type { PuzzleCategory } from '$lib/constants/categories';
import type { PuzzleStatus, PuzzleSummary } from '$lib/types/puzzle';

export type AdminPuzzleFilters = {
  query: string;
  category: 'all' | PuzzleCategory;
  status: 'all' | PuzzleStatus;
};

export function filterAdminPuzzles(
  puzzles: readonly PuzzleSummary[],
  filters: AdminPuzzleFilters
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

### Steps

- [ ] **Step 1: Write failing pure tests for name/category/status filtering**

In `adminPuzzleList.test.ts`, use a small fixture:

```ts
const puzzles: PuzzleSummary[] = [
  { id: 'p1', name: 'Forest Ready', category: 'Nature', status: 'ready', pieceCount: 48 },
  {
    id: 'p2',
    name: 'Night Forest',
    category: 'Nature',
    status: 'processing',
    pieceCount: 48,
    progress: { generatedPieces: 4, totalPieces: 48, updatedAt: 1 }
  },
  { id: 'p3', name: 'Gallery Failure', category: 'Art', status: 'failed', pieceCount: 48 },
  { id: 'p4', name: 'Legacy Ready', status: 'ready', pieceCount: 48 }
];
```

Pin these cases:

```ts
expect(filterAdminPuzzles(puzzles, {
  query: '  FoReSt  ',
  category: 'all',
  status: 'all'
}).map((p) => p.id)).toEqual(['p1', 'p2']);

expect(filterAdminPuzzles(puzzles, {
  query: 'forest',
  category: 'Nature',
  status: 'processing'
}).map((p) => p.id)).toEqual(['p2']);

expect(filterAdminPuzzles(puzzles, {
  query: '',
  category: 'Art',
  status: 'all'
}).map((p) => p.id)).toEqual(['p3']);
```

Also assert uncategorized `p4` appears for category `all` and not for a concrete category.

- [ ] **Step 2: Write failing pure tests for page slicing and clamping**

Use integers instead of DOM rows:

```ts
expect(pageSlice([1, 2, 3, 4, 5], 0, 2)).toEqual({
  page: [1, 2],
  totalPages: 3,
  clampedIndex: 0
});

expect(pageSlice([1, 2, 3, 4, 5], 9, 2)).toEqual({
  page: [5],
  totalPages: 3,
  clampedIndex: 2
});

expect(pageSlice([], 4, 20)).toEqual({
  page: [],
  totalPages: 1,
  clampedIndex: 0
});
```

Also pin non-positive page size as programmer error:

```ts
expect(() => pageSlice([1], 0, 0)).toThrow('pageSize must be greater than 0');
```

- [ ] **Step 3: Run web tests and confirm helper tests are red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected: failure because `adminPuzzleList.ts` does not exist yet.

- [ ] **Step 4: Implement the two pure helpers**

Create `adminPuzzleList.ts`:

```ts
import type { PuzzleCategory } from '$lib/constants/categories';
import type { PuzzleStatus, PuzzleSummary } from '$lib/types/puzzle';

export type AdminPuzzleFilters = {
  query: string;
  category: 'all' | PuzzleCategory;
  status: 'all' | PuzzleStatus;
};

export function filterAdminPuzzles(
  puzzles: readonly PuzzleSummary[],
  filters: AdminPuzzleFilters
): PuzzleSummary[] {
  const query = filters.query.trim().toLowerCase();

  return puzzles.filter((puzzle) => {
    if (query && !puzzle.name.toLowerCase().includes(query)) return false;
    if (filters.category !== 'all' && puzzle.category !== filters.category) return false;
    if (filters.status !== 'all' && puzzle.status !== filters.status) return false;
    return true;
  });
}

export function pageSlice<T>(
  items: readonly T[],
  pageIndex: number,
  pageSize: number
): { page: T[]; totalPages: number; clampedIndex: number } {
  if (pageSize <= 0) throw new Error('pageSize must be greater than 0');

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedIndex = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const start = clampedIndex * pageSize;

  return {
    page: items.slice(start, start + pageSize),
    totalPages,
    clampedIndex
  };
}
```

This file stays beside the admin route. Do not move it to `$lib` or turn it into a generic pagination package.

- [ ] **Step 5: Add failing panel tests for control wiring, not list arithmetic**

In `AdminPuzzlesPanel.svelte.test.ts`, add small-fixture browser tests for:

1. `SearchBar`: enter `forest`, assert matching/non-matching rows respond.
2. Category select: select `Nature`, assert Art row hides.
3. Status select: select `PROCESSING`, assert ready row hides.
4. Combined controls: search + category + status produce expected one row.
5. Reset: clear all criteria and restore rows.
6. Filtered empty: backing list non-empty but criteria match none -> `No missions match the current search and filters.`
7. Count copy: active filters expose semantic match/total text such as `1 OF 3`.
8. Hidden processing polling: status filter `READY` hides a processing row, advance three seconds, assert `fetchAdminPuzzles()` still runs again.

The pure helper tests own trim/case/AND/page-boundary details; do not duplicate those permutations through browser DOM tests.

- [ ] **Step 6: Add one minimal browser pagination-wiring test**

Use 21 ready rows only to prove the UI controls are connected to `PAGE_SIZE = 20`:

```text
page 1 -> first 20 visible, NEXT enabled, PREVIOUS disabled
click NEXT -> 21st visible, NEXT disabled, PREVIOUS enabled
```

Do not repeat search/category/status arithmetic across 20+ row fixtures.

- [ ] **Step 7: Run web tests and confirm panel wiring is red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected: missing SearchBar/select/reset/pagination UI causes the new panel tests to fail; pure helper tests pass.

- [ ] **Step 8: Wire route-local state using existing web seams**

In `AdminPuzzlesPanel.svelte`:

```ts
import SearchBar from '$lib/components/SearchBar.svelte';
import { PUZZLE_CATEGORIES } from '$lib/constants/categories';
import type { PuzzleCategory } from '$lib/constants/categories';
import type { PuzzleStatus } from '$lib/types/puzzle';
import { filterAdminPuzzles, pageSlice } from './adminPuzzleList';

const PAGE_SIZE = 20;
type CategoryFilter = 'all' | PuzzleCategory;
type StatusFilter = 'all' | PuzzleStatus;

let searchQuery = $state('');
let categoryFilter: CategoryFilter = $state('all');
let statusFilter: StatusFilter = $state('all');
let pageIndex = $state(0);

const filteredPuzzles = $derived(
  filterAdminPuzzles(puzzles, {
    query: searchQuery,
    category: categoryFilter,
    status: statusFilter
  })
);

const pageResult = $derived(pageSlice(filteredPuzzles, pageIndex, PAGE_SIZE));
const visiblePuzzles = $derived(pageResult.page);
const hasActiveFilters = $derived(
  searchQuery.trim().length > 0 || categoryFilter !== 'all' || statusFilter !== 'all'
);
```

No `$effect` writes to `pageIndex`. `pageResult.clampedIndex` is the authoritative rendered page when polling/deletion shrinks results.

- [ ] **Step 9: Reuse `SearchBar` and add simple selects/Reset**

```svelte
<SearchBar
  value={searchQuery}
  onInput={(value) => {
    searchQuery = value;
    pageIndex = 0;
  }}
/>

<select
  aria-label="Puzzle category"
  value={categoryFilter}
  onchange={(event) => {
    categoryFilter = event.currentTarget.value as CategoryFilter;
    pageIndex = 0;
  }}
>
  <option value="all">ALL CATEGORIES</option>
  {#each PUZZLE_CATEGORIES as category}
    <option value={category}>{category}</option>
  {/each}
</select>

<select
  aria-label="Puzzle status"
  value={statusFilter}
  onchange={(event) => {
    statusFilter = event.currentTarget.value as StatusFilter;
    pageIndex = 0;
  }}
>
  <option value="all">ALL STATUS</option>
  <option value="ready">READY</option>
  <option value="processing">PROCESSING</option>
  <option value="failed">FAILED</option>
</select>
```

Add:

```ts
function resetFilters() {
  searchQuery = '';
  categoryFilter = 'all';
  statusFilter = 'all';
  pageIndex = 0;
}
```

Show `RESET` only while `hasActiveFilters` is true.

Do not reuse gallery `CategoryFilter.svelte` and do not add debounce.

- [ ] **Step 10: Render the clamped page and minimal pagination controls**

Render `visiblePuzzles` instead of raw `puzzles`.

Keep processing polling based on:

```ts
puzzles.some((puzzle) => puzzle.status === 'processing')
```

Use `pageResult.clampedIndex` in controls:

```svelte
{#if filteredPuzzles.length > PAGE_SIZE}
  <nav aria-label="Puzzle pages">
    <button
      type="button"
      disabled={pageResult.clampedIndex === 0}
      onclick={() => (pageIndex = pageResult.clampedIndex - 1)}
    >
      PREVIOUS
    </button>
    <span>PAGE {pageResult.clampedIndex + 1} / {pageResult.totalPages}</span>
    <button
      type="button"
      disabled={pageResult.clampedIndex >= pageResult.totalPages - 1}
      onclick={() => (pageIndex = pageResult.clampedIndex + 1)}
    >
      NEXT
    </button>
  </nav>
{/if}
```

Empty copy:

```svelte
{#if puzzles.length === 0}
  <p>No missions found.</p>
{:else if filteredPuzzles.length === 0}
  <p>No missions match the current search and filters.</p>
{:else}
  <!-- visiblePuzzles -->
{/if}
```

When filters are active, expose match/total count (`{filteredPuzzles.length} OF {puzzles.length}`) in the existing database header style.

- [ ] **Step 11: Verify Task 3 and confirm no API query layer was added**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
git diff HEAD -- apps/api/src/routes/admin.worker.ts apps/web/src/lib/services/api.ts
```

Expected: web tests/check exit 0; Task 3 introduces no search/filter/pagination API changes.

- [ ] **Step 12: Commit Task 3**

```bash
git add \
  apps/web/src/routes/admin/AdminPuzzlesPanel.svelte \
  apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts \
  apps/web/src/routes/admin/adminPuzzleList.ts \
  apps/web/src/routes/admin/adminPuzzleList.test.ts
git commit -m "feat: filter and paginate admin puzzles"
```

---

## Task 4: Add enlarged reference-image preview for ready puzzles

### Files

- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`

### Dependencies already present

- `getReferenceImageUrl(puzzleId)`
- `$lib/actions/modalFocus`

### Steps

- [ ] **Step 1: Add failing preview tests**

Mock:

```ts
getReferenceImageUrl: vi.fn((id: string) => `/api/puzzles/${id}/reference`)
```

For a ready `Forest Scene`, click `View full image for Forest Scene` and assert:

```text
dialog accessible name: Forest Scene image preview
image src: /api/puzzles/p1/reference
```

Add Close-button and Escape cases. Assert processing/failed placeholders expose no `View full image` button.

- [ ] **Step 2: Run web tests and confirm preview is red**

```bash
bun run test:unit --filter=@perseus/web
```

Expected: preview button/dialog assertions fail before implementation.

- [ ] **Step 3: Make only ready thumbnails interactive**

```ts
import { getReferenceImageUrl, getThumbnailUrl } from '$lib/services/api';
import { modalFocus } from '$lib/actions/modalFocus';

let previewPuzzle: PuzzleSummary | null = $state(null);
```

Ready thumbnail:

```svelte
<button
  type="button"
  aria-label={`View full image for ${puzzle.name}`}
  onclick={() => (previewPuzzle = puzzle)}
>
  <img src={getThumbnailUrl(puzzle.id)} alt="" />
</button>
```

Keep processing/failed placeholders non-interactive.

- [ ] **Step 4: Add the route-local modal using the existing focus pattern**

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

Adjust only styling needed to fit the admin visual language. Do not add zoom, pan, download, carousel, backdrop-click behavior, or a lightbox dependency.

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

- [ ] **Step 1: Repeat the auth-deletion sweep**

```bash
rg -n \
  "ADMIN_PASSKEY|adminPasskey|/api/admin/login|/api/admin/session|/api/admin/logout|checkSession\(|WORKER_AUTH_ERROR_CODE|perseus_session|middleware/auth\.worker|loginRateLimit|resetLoginAttempts" \
  apps packages scripts .github .agents AGENTS.md CLAUDE.md docs/PRD.md \
  --glob '!docs/superpowers/**'
```

Expected: no active admin passkey/session references remain.

- [ ] **Step 2: Re-check security/scoping invariants**

```bash
rg -n "subdomain:|previewsEnabled|CLI_ACCESS_PATHS|puzzle-delete|credentials: 'include'" \
  packages/infrastructure/src \
  apps/api/src/routes/admin.worker.ts \
  apps/web/src/lib/services/api.ts
```

Confirm:

- API Worker still has `subdomain: { enabled: false, previewsEnabled: false }`;
- `CLI_ACCESS_PATHS` is only `/api/admin/puzzles`;
- destructive delete remains `/api/admin/puzzle-delete/:id`;
- browser admin API fetches still carry credentials.

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

- [ ] **Step 4: Audit the final diff against requested outcomes and review constraints**

```text
[ ] Passkey/session removed; Cloudflare Access + Worker origin isolation retained
[ ] Seed/upload CLIs use Access headers only; seed workflow has no ADMIN_PASSKEY
[ ] No admin test still mocks requireAuth
[ ] Forced admin document navigation remains
[ ] Player Access is a separate tab and lazy-loads
[ ] Search reuses SearchBar
[ ] Category values come through $lib/constants/categories
[ ] Name/category/status filter math lives in route-local pure helper tests
[ ] Filtered results paginate at exactly 20 rows
[ ] Hidden processing rows still keep polling active
[ ] Ready thumbnail opens existing reference image via modalFocus
[ ] No backend admin query API or generic UI framework was introduced
```

Fix mismatches in the owning task rather than adding compensating abstractions.

- [ ] **Step 5: Perform the production smoke check after merge/deploy**

1. Allowed browser identity/device opens `/admin` without a Perseus passkey prompt.
2. Denied browser/device cannot reach `/admin` or broad admin API paths.
3. Public Worker subdomain/preview access remains disabled.
4. `bun run admin:startup:status` with service-token credentials reports readiness without a passkey.
5. A bounded seed/upload run can list/create through `/api/admin/puzzles`.
6. The production seed workflow succeeds with no `ADMIN_PASSKEY` secret dependency.
7. CLI service token cannot reach `/api/admin/puzzle-delete/:id` through Access.
8. `PUZZLES` search/category/status/Reset/pagination behave as specified.
9. `PLAYER ACCESS` add/remove still works.
10. Ready thumbnail preview opens and Close/Escape dismiss it.
11. Public player routes remain unaffected.
