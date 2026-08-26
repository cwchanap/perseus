# Admin Portal Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Perseus admin passkey/session layer with the existing Cloudflare Access boundary and improve the admin portal with tabs, 20-row client-side pagination, and enlarged reference-image viewing.

**Architecture:** Keep the production security boundary at Cloudflare Access and remove the redundant application admin session end-to-end, including browser, API, CLI, and deployment configuration. Keep the admin puzzle API as a full fresh list because processing polling and startup deduplication depend on that behavior; pagination is a route-local Svelte concern. Split the current admin page into two focused panels and reuse the existing reference-image endpoint plus `modalFocus` for enlargement.

**Tech Stack:** Svelte 5 / SvelteKit static adapter, TypeScript, Hono on Cloudflare Workers, Cloudflare Access + Pulumi, Bun, Vitest browser tests.

**Spec:** `docs/superpowers/specs/2026-08-25-admin-portal-enhancement-design.md`

## Global Constraints

- Deliver all implementation work in one PR.
- Cloudflare Access is the sole production admin authentication boundary after this change.
- Preserve `packages/infrastructure/src/workers.ts` behavior that disables both the Worker public subdomain and preview URLs; do not duplicate that production setting in Wrangler.
- Preserve the forced full-document navigation seam for client-routed entry into `/admin`.
- Do not add Worker-side Access JWT validation or replacement local-dev admin auth.
- Do not add backend/storage pagination for `GET /api/admin/puzzles`; keep its full-list response contract for processing polling and CLI deduplication.
- Admin puzzle page size is fixed at 20.
- `PUZZLES` is the default admin tab; tab state stays local to the route.
- Reuse `GET /api/puzzles/:id/reference` through `getReferenceImageUrl()` for enlarged images.
- Do not add generic tab, pagination, dialog, or lightbox abstractions.
- Delete obsolete passkey/session compatibility paths instead of preserving backward compatibility.
- Keep player auth (`JWT_SECRET`, `PlayerSessionResponse`, Google auth, OAuth/avatar rate limiting) unchanged.

---

## File Structure

### Admin authentication boundary

- Modify: `apps/api/src/routes/admin.worker.ts` — remove login/session/logout endpoints and `requireAuth` from operational admin routes.
- Modify: `apps/api/src/worker.ts` — remove `ADMIN_PASSKEY` from `Env` and production env validation.
- Delete: `apps/api/src/middleware/auth.worker.ts` — obsolete admin session implementation.
- Delete: `apps/api/src/middleware/auth.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-extra.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-coverage.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit.worker.ts` — remove only admin-login limiter exports; retain OAuth/avatar limiting.
- Modify relevant files under `apps/api/src/routes/__tests__/` and `apps/api/src/__tests__/` that assert passkey/session behavior.
- Modify: `packages/types/src/core.ts` — remove admin-only login/session contracts and Worker-auth probe constant.
- Modify: `apps/web/src/lib/types/puzzle.ts` — stop re-exporting deleted admin auth types.
- Modify: `apps/web/src/lib/services/api.ts` — remove browser admin login/logout/session methods.
- Delete: `apps/web/src/routes/admin/login/+page.svelte`
- Delete: `apps/web/src/routes/admin/login/page.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/+layout.svelte` — retain only the Access-triggering document-navigation behavior plus child rendering.
- Modify: `apps/web/src/routes/admin/layout.svelte.test.ts` — pin the simplified layout contract.
- Modify: `apps/web/src/lib/services/adminNavigation.ts` — update stale comments only; behavior stays unchanged.
- Modify: `apps/web/src/routes/admin/+page.svelte` — remove obsolete Perseus logout UI before the later panel extraction.

### CLI and deployment configuration

- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/cli.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/startup/token.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: script tests under `scripts/`, especially `scripts/startup/cli.test.ts`, `scripts/startup/token.test.ts`, and `scripts/admin-bulk-upload-startup.test.ts`.
- Modify: `packages/infrastructure/src/admin-access.ts` — narrow CLI destinations to `/api/admin/puzzles` and remove stale session-layer comments.
- Modify: `packages/infrastructure/src/admin-access.test.ts`
- Modify: `packages/infrastructure/src/workers.ts` — update stale comments while preserving `subdomain: { enabled: false, previewsEnabled: false }`.
- Modify: `packages/infrastructure/src/index.ts` — remove `adminPasskey` Pulumi secret binding.
- Modify: `packages/infrastructure/src/deploy-workflow.test.ts`
- Modify: `.github/workflows/deploy-infrastructure.yml` — remove `adminPasskey` config from preview/deploy inputs.
- Modify: `apps/api/wrangler.toml` — remove the development `ADMIN_PASSKEY` value.
- Modify: `apps/api/package.json` — remove the E2E `ADMIN_PASSKEY` injected variable.
- Modify: `apps/api/.env.example`
- Modify: `packages/infrastructure/README.md`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`
- Modify: `CLAUDE.md`

### Admin UI composition

- Modify: `apps/web/src/routes/admin/+page.svelte` — shell, tabs, navigation links only.
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte` — puzzle list, polling, deletion, pagination, preview.
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte` — allowlist load/add/remove.
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts` — shell/tab behavior only.
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts`

---

### Task 1: Retire the application admin passkey/session end-to-end

**Files:**
- Modify/delete the authentication-boundary and CLI/configuration files listed above.
- Test: existing API admin/worker tests, admin layout tests, script tests, types tests, and infrastructure tests.

**Interfaces:**
- Consumes: existing Cloudflare Access browser policy, existing CLI Access service token, `forceAdminDocumentNavigation()`, existing `/api/admin/*` handlers.
- Produces: admin APIs reachable after Cloudflare Access without a `perseus_session`; CLI requests authenticated only by Access headers; no `ADMIN_PASSKEY` runtime/config contract.
- Produces the simplified readiness interface:

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

- Produces session-free upload helper shapes:

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

- Preserves: `accessHeaders()`, `probeAccessToken()`, `probeServiceToken()`, `--skip-access` loopback restriction, `JWT_SECRET`, player auth, OAuth/avatar limiting.

- [ ] **Step 1: Rewrite the admin layout tests around Cloudflare Access rather than app sessions**

Replace the session/login assertions in `apps/web/src/routes/admin/layout.svelte.test.ts` with two core behaviors:

```ts
it('renders admin children immediately after a direct document load', async () => {
  vi.mocked(isClientRoutedAdminPath).mockReturnValue(false);
  render(AdminLayout, { children: makeChildren() });

  await expect.element(page.getByTestId('child-content')).toBeVisible();
  expect(forceAdminDocumentNavigation).not.toHaveBeenCalled();
});

it('forces a document navigation when admin was entered through client routing', async () => {
  vi.mocked(isClientRoutedAdminPath).mockReturnValue(true);
  render(AdminLayout, { children: makeChildren() });

  await vi.waitFor(() => {
    expect(forceAdminDocumentNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/admin' })
    );
  });
});
```

Remove mocks/assertions for `checkSession`, `goto('/admin/login')`, login-page special casing, loading state, and session rechecks.

- [ ] **Step 2: Add API regression coverage proving operational admin routes no longer require the app cookie**

In the existing admin route/worker test owner, add a request to `GET /api/admin/puzzles` with no `perseus_session` and assert the handler returns its normal success payload under the local test harness:

```ts
const response = await app.request('/api/admin/puzzles', {}, env);
expect(response.status).toBe(200);
expect(await response.json()).toEqual(expect.objectContaining({ puzzles: expect.any(Array) }));
```

Also replace obsolete tests for login/session/logout with absence checks so the deleted routes cannot silently return later:

```ts
expect((await app.request('/api/admin/login', { method: 'POST' }, env)).status).toBe(404);
expect((await app.request('/api/admin/session', {}, env)).status).toBe(404);
expect((await app.request('/api/admin/logout', { method: 'POST' }, env)).status).toBe(404);
```

Use the repository's existing `app`/`env` fixture names when applying the assertions; do not create a second test harness.

- [ ] **Step 3: Update script tests for Access-only readiness and requests**

In `scripts/startup/cli.test.ts`, change readiness expectations to the new four-outcome contract. The positive case no longer supplies a passkey:

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

Keep blocked, unhealthy, and missing-Access cases. Delete the `passkey-missing` case.

In upload/token tests, assert requests to `/api/admin/puzzles` contain the Access headers but never call `/api/admin/login` and never require a `perseus_session` cookie.

- [ ] **Step 4: Update infrastructure tests before implementation**

In `packages/infrastructure/src/admin-access.test.ts`, change the CLI path contract to:

```ts
expect(CLI_ACCESS_PATHS).toEqual(['/api/admin/puzzles']);
```

Keep the existing assertions that the narrow app contains the browser email/posture policy plus the service-token policy.

In the Worker infrastructure test owner, retain/assert:

```ts
expect(workerArgs.subdomain).toEqual({
  enabled: false,
  previewsEnabled: false
});
```

In `packages/infrastructure/src/deploy-workflow.test.ts`, change the config-map expectations so `adminPasskey` is absent while `jwtSecret`, `adminAccessEmail`, `adminDeviceSerials`, and Google credentials remain.

- [ ] **Step 5: Run the focused tests to confirm the old implementation fails the new contract**

Run:

```bash
bun run test:unit --filter=@perseus/web
bun run test:unit --filter=@perseus/api
bun run test:scripts
bun run test:unit --filter=@perseus/infrastructure
```

Expected before implementation: failures in the new Access-only layout/API/script/infrastructure expectations because the current code still requires the passkey/session and still includes `/api/admin/login` in the CLI Access destinations.

- [ ] **Step 6: Remove the admin login/session endpoints and route middleware**

In `apps/api/src/routes/admin.worker.ts`:

- delete imports from `../middleware/auth.worker`;
- delete the `loginRateLimit` import;
- delete `/login`, `/session`, and `/logout` handlers;
- remove `requireAuth` from every operational admin handler while leaving handler bodies unchanged.

For example:

```ts
// before
admin.get('/puzzles', requireAuth, async (c) => {
  // existing body
});

// after
admin.get('/puzzles', async (c) => {
  // existing body unchanged
});
```

Apply the same mechanical removal to player-allowlist mutations and puzzle deletion. Do not add a replacement middleware.

- [ ] **Step 7: Remove the admin passkey from Worker configuration while preserving player auth**

In `apps/api/src/worker.ts`:

```ts
export interface Env {
  // ...existing bindings...
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // no ADMIN_PASSKEY
}
```

Remove only this production validation line:

```ts
if (!env.ADMIN_PASSKEY) missingEnv.push('ADMIN_PASSKEY');
```

Keep the `JWT_SECRET` validation and all player-auth environment handling.

Delete `apps/api/src/middleware/auth.worker.ts` and its three dedicated auth-session test files after the route imports are gone.

- [ ] **Step 8: Remove only the obsolete login limiter from the shared rate-limit module**

In `apps/api/src/middleware/rate-limit.worker.ts`, delete `loginRateLimit()` and `resetLoginAttempts()` plus login-only comments/fixtures that become unused. Keep `oauthRateLimit()`, `avatarRateLimit()`, `resetAvatarAttempts()`, the shared KV helpers, and their tests.

Do not restructure the rate-limit storage implementation. If removing the login exports leaves `MAX_LOGIN_ATTEMPTS`/`getRateLimitKey()` unused, delete those symbols only; keep `checkAndIncrement()` behavior used by OAuth/avatar paths.

- [ ] **Step 9: Delete the browser admin login/session surface while preserving document navigation**

Delete:

```text
apps/web/src/routes/admin/login/+page.svelte
apps/web/src/routes/admin/login/page.svelte.test.ts
```

Remove `login()`, `logout()`, and `checkSession()` from `apps/web/src/lib/services/api.ts`.

Simplify `apps/web/src/routes/admin/+layout.svelte` to the existing document-navigation gate plus child rendering:

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

Keep the current helper's base-path/query/hash behavior. Update `adminNavigation.ts` comments so Cloudflare Access alone is named as the production security boundary.

Remove the Perseus `LOGOUT` button, `loggingOut`, `logoutError`, `handleLogout()`, `goto`, and `logout` import from the current admin page. Keep Upload and View Arcade.

- [ ] **Step 10: Remove admin-only shared auth types/constants**

From `packages/types/src/core.ts`, delete:

```ts
export interface LoginResponse { /* ... */ }
export interface SessionResponse { /* ... */ }
export const WORKER_AUTH_ERROR_CODE = 'unauthorized';
```

Do not touch `PlayerSessionResponse`.

Remove the matching imports/re-exports from `apps/web/src/lib/types/puzzle.ts` and imports from `apps/web/src/lib/services/api.ts`.

- [ ] **Step 11: Remove the passkey/session step from both admin upload CLIs**

In `scripts/startup/types.ts`, remove `passkey` from `Options` and update the Access-app comment to name only `/api/admin/puzzles`.

In `scripts/startup/cli.ts`:

- remove `--passkey` usage/options parsing;
- remove `ADMIN_PASSKEY` loading;
- remove passkey output from `status`;
- change `ReadinessOutcome` and `evaluateReadiness()` to the interface in this task's Interfaces section.

In `scripts/startup/upload.ts`:

- delete `sessionCookieFrom()`;
- delete `adminLogin()`;
- remove the cookie argument from `fetchExistingKeys()`, `pollForExistingKey()`, `uploadWithRetry()`, and `processEntry()`;
- have `cmdUpload()` probe Access, construct `baseHeaders = accessHeaders(options)`, fetch the full admin list, and POST directly with those headers.

The request shape becomes:

```ts
const response = await fetch(`${server}/api/admin/puzzles`, {
  method: 'POST',
  headers: {
    ...baseHeaders,
    'Idempotency-Key': idempotencyHeader
  },
  body: formData,
  redirect: 'manual',
  signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
});
```

In `scripts/startup/token.ts`, remove `WORKER_AUTH_ERROR_CODE` and `isWorkerAuth401()`. Both probes treat `401`, `302`, and `403` as blocked; `200` as accepted; `5xx` as backend unhealthy.

In `scripts/admin-upload-puzzle.ts`, remove `Options.passkey`, `--passkey`, `ADMIN_PASSKEY`, the `/api/admin/login` request, and `sessionCookieFrom()`. POST the form directly with `accessHeaders(options)`.

Update `scripts/admin-bulk-upload-startup.ts` comments so service-token instructions no longer mention placing credentials next to `ADMIN_PASSKEY`.

- [ ] **Step 12: Remove passkey configuration and keep the existing Access ingress guard**

In `packages/infrastructure/src/admin-access.ts`:

```ts
export const CLI_ACCESS_PATHS = ['/api/admin/puzzles'] as const;
```

Rewrite comments that currently describe `perseus_session`/passkey defense-in-depth. Preserve the exact-path design that keeps `POST /api/admin/puzzle-delete/:id` outside the service-token app.

In `packages/infrastructure/src/index.ts`, remove:

```ts
ADMIN_PASSKEY: config.requireSecret('adminPasskey')
```

Remove `adminPasskey` from both Pulumi config maps in `.github/workflows/deploy-infrastructure.yml`.

Remove the dev/E2E values from `apps/api/wrangler.toml` and `apps/api/package.json`.

Update `packages/infrastructure/src/workers.ts` comments but leave this behavior unchanged:

```ts
subdomain: { enabled: false, previewsEnabled: false }
```

Update current operator/config docs (`apps/api/.env.example`, `packages/infrastructure/README.md`, `.agents/skills/perseus-operations/references/operator-runbook.md`, `CLAUDE.md`) to describe Cloudflare Access credentials only. Do not rewrite historical completed files under `docs/superpowers/specs/` or `docs/superpowers/plans/`.

- [ ] **Step 13: Run a current-reference sweep for deleted admin auth**

Run:

```bash
rg -n "ADMIN_PASSKEY|adminPasskey|/api/admin/login|/api/admin/session|/api/admin/logout|perseus_session|checkSession\(|WORKER_AUTH_ERROR_CODE" \
  apps packages scripts .github CLAUDE.md .agents \
  --glob '!docs/superpowers/**'
```

Expected: no live-code/current-document references to the deleted admin auth surface. A `perseus_session` hit is acceptable only if it is clearly unrelated to the deleted admin cookie; inspect rather than blanket-replacing.

- [ ] **Step 14: Run focused verification for the auth retirement**

Run:

```bash
bun run test:unit --filter=@perseus/types
bun run test:unit --filter=@perseus/api
bun run test:unit --filter=@perseus/web
bun run test:scripts
bun run check:scripts
bun run test:unit --filter=@perseus/infrastructure
bun run check --filter=@perseus/api --filter=@perseus/web --filter=@perseus/infrastructure
```

Expected: all commands exit 0.

- [ ] **Step 15: Commit the complete auth-boundary change**

```bash
git add apps packages scripts .github CLAUDE.md .agents
git commit -m "refactor: rely on Cloudflare Access for admin auth"
```

---

### Task 2: Split the admin portal into puzzle and player-access tabs

**Files:**
- Modify: `apps/web/src/routes/admin/+page.svelte`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte`
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts`

**Interfaces:**
- `+page.svelte` owns `type AdminTab = 'puzzles' | 'players'` and defaults to `'puzzles'`.
- `AdminPuzzlesPanel.svelte` has no external props; it owns puzzle API state and lifecycle.
- `PlayerAccessPanel.svelte` has no external props; it owns allowlist API state and lifecycle.
- Switching tabs conditionally mounts exactly one panel, so inactive-panel polling/fetching stops naturally.

- [ ] **Step 1: Rewrite the admin shell test around tabs and lazy panel loading**

Mock the API methods as the existing `admin-page.svelte.test.ts` already does and assert the default tab behavior:

```ts
render(AdminPage);

await expect.element(page.getByRole('heading', { name: /control panel/i })).toBeVisible();
await expect.element(page.getByRole('tab', { name: 'PUZZLES' })).toHaveAttribute('aria-selected', 'true');
expect(fetchAdminPuzzles).toHaveBeenCalledOnce();
expect(fetchPlayerAllowlist).not.toHaveBeenCalled();
```

Then select Player Access:

```ts
await page.getByRole('tab', { name: 'PLAYER ACCESS' }).click();
await expect.element(page.getByRole('tab', { name: 'PLAYER ACCESS' })).toHaveAttribute(
  'aria-selected',
  'true'
);
await vi.waitFor(() => expect(fetchPlayerAllowlist).toHaveBeenCalledOnce());
```

Keep shell assertions for Upload and View Arcade. Remove puzzle/delete/allowlist behavior assertions from this file once equivalent tests exist in the panel owners.

- [ ] **Step 2: Run the shell test to verify the current combined page fails the tab contract**

Run:

```bash
bun run test:unit --filter=@perseus/web -- apps/web/src/routes/admin/admin-page.svelte.test.ts
```

If Turbo/Vitest does not forward the file argument in this workspace, run the full web unit suite instead:

```bash
bun run test:unit --filter=@perseus/web
```

Expected before implementation: the tab-role/lazy-load assertions fail.

- [ ] **Step 3: Extract the existing puzzle behavior without changing it**

Create `AdminPuzzlesPanel.svelte` by moving the current puzzle-owned state and functions from `+page.svelte`:

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
onMount/onDestroy puzzle lifecycle
```

Move the `MISSION DATABASE` markup with it. Keep the existing ready/processing/failed display, force-delete confirmation, best-effort local session clear, partial-success message, and three-second polling behavior unchanged.

Do not move allowlist code or page-header navigation into this component.

- [ ] **Step 4: Move the existing puzzle tests to the new owner**

Create `AdminPuzzlesPanel.svelte.test.ts` from the existing puzzle-specific cases:

- ready/processing/failed rendering;
- puzzle API load error;
- ready delete confirmation;
- processing force-delete flag;
- delete API error alert;
- partial-success warning and replacement timer;
- processing polling until terminal state.

Render `AdminPuzzlesPanel` directly in those tests and keep the current API/session-storage mocks.

- [ ] **Step 5: Extract Player Access without changing behavior**

Create `PlayerAccessPanel.svelte` by moving:

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

Its `onMount` calls only `loadAllowlist()`. Move the existing `PLAYER ACCESS` markup unchanged before styling cleanup.

- [ ] **Step 6: Move the allowlist tests to the new owner**

Create `PlayerAccessPanel.svelte.test.ts` with the existing cases for:

- linked player metadata and pending/no-account row;
- load error;
- adding an allowlist email;
- add error;
- removal;
- remove error;
- stale-response sequence protection.

Render `PlayerAccessPanel` directly.

- [ ] **Step 7: Reduce `+page.svelte` to the route shell and accessible tab switcher**

The page keeps the current title/header visual language and Upload/View Arcade links, then owns only local tab state:

```svelte
<script lang="ts">
  import AdminPuzzlesPanel from './AdminPuzzlesPanel.svelte';
  import PlayerAccessPanel from './PlayerAccessPanel.svelte';

  type AdminTab = 'puzzles' | 'players';
  let activeTab: AdminTab = $state('puzzles');
</script>

<div role="tablist" aria-label="Admin sections">
  <button
    type="button"
    role="tab"
    aria-selected={activeTab === 'puzzles'}
    aria-controls="admin-puzzles-panel"
    onclick={() => (activeTab = 'puzzles')}
  >
    PUZZLES
  </button>
  <button
    type="button"
    role="tab"
    aria-selected={activeTab === 'players'}
    aria-controls="admin-player-access-panel"
    onclick={() => (activeTab = 'players')}
  >
    PLAYER ACCESS
  </button>
</div>

{#if activeTab === 'puzzles'}
  <section id="admin-puzzles-panel" role="tabpanel" aria-label="Puzzles">
    <AdminPuzzlesPanel />
  </section>
{:else}
  <section id="admin-player-access-panel" role="tabpanel" aria-label="Player Access">
    <PlayerAccessPanel />
  </section>
{/if}
```

Use the existing admin typography/border utility classes rather than introducing a tab component.

- [ ] **Step 8: Verify the extracted responsibilities**

Run:

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
```

Expected: exit 0 with the shell, puzzle-panel, and player-access tests passing.

- [ ] **Step 9: Commit the tab/panel extraction**

```bash
git add apps/web/src/routes/admin
git commit -m "refactor: split admin portal into tabs"
```

---

### Task 3: Add 20-row client-side puzzle pagination

**Files:**
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`

**Interfaces:**
- Keep `fetchAdminPuzzles(): Promise<PuzzleSummary[]>` unchanged.
- Add route-local constant `const PAGE_SIZE = 20`.
- Add zero-based `pageIndex` state.
- Derive `totalPages` and `visiblePuzzles` from the full `puzzles` array.
- Keep polling based on the full puzzle array, not only the visible page.

- [ ] **Step 1: Add failing pagination tests with 21 puzzles**

Build 21 ready summaries and assert only the first 20 are initially visible:

```ts
const manyPuzzles: PuzzleSummary[] = Array.from({ length: 21 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `Puzzle ${index + 1}`,
  pieceCount: 48,
  status: 'ready'
}));

vi.mocked(fetchAdminPuzzles).mockResolvedValue(manyPuzzles);
render(AdminPuzzlesPanel);

await expect.element(page.getByText('Puzzle 1')).toBeVisible();
await expect.poll(() => page.getByText('Puzzle 21').query()).toBeNull();
await expect.element(page.getByText('PAGE 1 / 2')).toBeVisible();
await expect.element(page.getByRole('button', { name: 'PREVIOUS' })).toBeDisabled();
```

Click Next and assert `Puzzle 21` appears, `Puzzle 1` is gone, Next is disabled, and Previous works.

- [ ] **Step 2: Add a failing clamp-after-delete test**

Start with 21 puzzles, navigate to page 2, delete the only row on that page, and have the reload return the first 20 puzzles:

```ts
vi.mocked(fetchAdminPuzzles)
  .mockResolvedValueOnce(manyPuzzles)
  .mockResolvedValueOnce(manyPuzzles.slice(0, 20));

await page.getByRole('button', { name: 'NEXT' }).click();
await page.getByRole('button', { name: 'DELETE' }).click();

await expect.element(page.getByText('Puzzle 1')).toBeVisible();
await expect.poll(() => page.getByText('PAGE 2 / 2').query()).toBeNull();
```

Use the existing delete confirmation mock and `deletePuzzle` fixture.

- [ ] **Step 3: Run the puzzle-panel tests to verify pagination is red**

Run:

```bash
bun run test:unit --filter=@perseus/web
```

Expected before implementation: the pagination-control and visibility assertions fail.

- [ ] **Step 4: Add local pagination state and visible slicing**

In `AdminPuzzlesPanel.svelte`:

```ts
const PAGE_SIZE = 20;
let pageIndex = $state(0);

const totalPages = $derived(Math.max(1, Math.ceil(puzzles.length / PAGE_SIZE)));
const visiblePuzzles = $derived(
  puzzles.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)
);

function clampPageIndex() {
  pageIndex = Math.min(pageIndex, Math.max(0, totalPages - 1));
}
```

Call `clampPageIndex()` after `loadPuzzles()` assigns a successful fresh result. Do not use an effect that can create a page/load feedback loop.

Change only the render loop:

```svelte
{#each visiblePuzzles as puzzle (puzzle.id)}
```

Keep `startPollingIfNeeded()` checking `puzzles.some(...)` so processing rows outside the visible page still keep polling alive.

- [ ] **Step 5: Add Previous/Next controls only when pagination is useful**

Below the list, render controls when `puzzles.length > PAGE_SIZE`:

```svelte
{#if puzzles.length > PAGE_SIZE}
  <nav aria-label="Puzzle pages">
    <button
      type="button"
      onclick={() => (pageIndex -= 1)}
      disabled={pageIndex === 0}
    >
      PREVIOUS
    </button>
    <span>PAGE {pageIndex + 1} / {totalPages}</span>
    <button
      type="button"
      onclick={() => (pageIndex += 1)}
      disabled={pageIndex >= totalPages - 1}
    >
      NEXT
    </button>
  </nav>
{/if}
```

Style these with existing admin button/border utilities. Do not add direct page-number buttons or a page-size selector.

- [ ] **Step 6: Verify pagination without changing the API**

Run:

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
rg -n "fetchAdminPuzzles|/api/admin/puzzles" apps/web/src/lib/services/api.ts apps/api/src/routes/admin.worker.ts
```

Expected: tests/check exit 0; `fetchAdminPuzzles()` and `GET /api/admin/puzzles` retain the existing full-list contract.

- [ ] **Step 7: Commit client-side pagination**

```bash
git add apps/web/src/routes/admin/AdminPuzzlesPanel.svelte apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts
git commit -m "feat: paginate admin puzzle list"
```

---

### Task 4: Add enlarged reference-image preview for ready puzzles

**Files:**
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`

**Interfaces:**
- Consumes existing `getThumbnailUrl(puzzleId)` and `getReferenceImageUrl(puzzleId)` from `$lib/services/api`.
- Consumes existing `modalFocus` action from `$lib/actions/modalFocus`.
- Adds route-local `previewPuzzle: PuzzleSummary | null` only; no new shared component or API.

- [ ] **Step 1: Add failing image-preview tests**

Extend the API mock with a stable reference URL:

```ts
getReferenceImageUrl: vi.fn((id: string) => `/api/puzzles/${id}/reference`)
```

For a ready puzzle, click the thumbnail button and assert:

```ts
await page.getByRole('button', { name: 'View full image for Forest Scene' }).click();

await expect.element(page.getByRole('dialog', { name: 'Forest Scene image preview' })).toBeVisible();
await expect
  .element(page.getByRole('img', { name: 'Forest Scene' }))
  .toHaveAttribute('src', '/api/puzzles/p1/reference');
```

Add one Close-button case and one Escape-key case. Assert processing/failed placeholders do not expose `View full image ...` buttons.

- [ ] **Step 2: Run the web tests to verify the preview contract is red**

Run:

```bash
bun run test:unit --filter=@perseus/web
```

Expected before implementation: the preview button/dialog assertions fail.

- [ ] **Step 3: Make only ready thumbnails interactive**

Import the existing reference helper and modal action:

```ts
import { getReferenceImageUrl, getThumbnailUrl } from '$lib/services/api';
import { modalFocus } from '$lib/actions/modalFocus';

let previewPuzzle: PuzzleSummary | null = $state(null);
```

Wrap only the ready thumbnail in a button:

```svelte
<button
  type="button"
  aria-label={`View full image for ${puzzle.name}`}
  onclick={() => (previewPuzzle = puzzle)}
>
  <img src={getThumbnailUrl(puzzle.id)} alt="" />
</button>
```

Keep processing/failed placeholders as their existing non-button elements.

- [ ] **Step 4: Render the route-local modal using the established focus pattern**

At the end of `AdminPuzzlesPanel.svelte`:

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

Adjust utility classes to the existing admin visual language, but keep the interaction contract exactly this small. Do not add zoom, pan, download, carousel, backdrop-click semantics, or a dependency.

- [ ] **Step 5: Verify preview behavior and admin accessibility checks**

Run:

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
```

Expected: exit 0.

- [ ] **Step 6: Commit image preview**

```bash
git add apps/web/src/routes/admin/AdminPuzzlesPanel.svelte apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts
git commit -m "feat: preview admin puzzle images"
```

---

### Task 5: Final integration verification and scope audit

**Files:**
- Modify only files found by the explicit current-reference checks below if they still contain stale active documentation/comments.
- Do not modify historical completed design/plan documents solely because they describe the old system.

**Interfaces:**
- No new interfaces. This task proves the final branch matches the spec and that the four feature requirements landed without extra architecture.

- [ ] **Step 1: Verify no live passkey/session dependencies remain**

Run:

```bash
rg -n "ADMIN_PASSKEY|adminPasskey|/api/admin/login|/api/admin/session|/api/admin/logout|checkSession\(|WORKER_AUTH_ERROR_CODE" \
  apps packages scripts .github CLAUDE.md .agents \
  --glob '!docs/superpowers/**'
```

Expected: no active references.

Then inspect the remaining `perseus_session` occurrences separately:

```bash
rg -n "perseus_session" apps packages scripts .github CLAUDE.md .agents
```

Expected: no admin-session implementation/reference remains.

- [ ] **Step 2: Verify the production ingress guard and CLI path boundary**

Run:

```bash
rg -n "subdomain:|previewsEnabled|CLI_ACCESS_PATHS|puzzle-delete" packages/infrastructure/src apps/api/src/routes/admin.worker.ts
```

Confirm from the output:

- API Worker has `subdomain: { enabled: false, previewsEnabled: false }`.
- `CLI_ACCESS_PATHS` contains only `/api/admin/puzzles`.
- destructive deletion remains at `/api/admin/puzzle-delete/:id`, not under `/api/admin/puzzles/*`.

- [ ] **Step 3: Run the complete affected verification set**

Run fresh from the repository root:

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

- [ ] **Step 4: Perform a manual production smoke check after deployment**

Using the existing production Access setup:

1. Open `/admin` from the configured allowed identity/device and confirm there is no Perseus passkey prompt.
2. Confirm `PUZZLES` is selected initially and the first page shows at most 20 rows.
3. Switch to `PLAYER ACCESS` and confirm the allowlist loads and add/remove still work.
4. Open a ready puzzle thumbnail and confirm the reference image is readable at enlarged size; Close and Escape dismiss it.
5. Run `bun run admin:startup:status` with the existing CLI service-token environment and confirm readiness does not request a passkey.
6. Run a bounded startup upload or dry operational probe using the existing service token and confirm list/create works.
7. Confirm the CLI service token cannot access the delete sibling route through Cloudflare Access.
8. Confirm a browser/device outside the Access policy cannot reach `/admin`.

- [ ] **Step 5: Self-review the final diff against the spec**

Check each requirement explicitly:

```text
[ ] passkey/session removed, Access retained
[ ] full-document admin navigation retained
[ ] CLI still service-token capable without app login
[ ] Player Access is a separate tab
[ ] puzzle page size is exactly 20 and client-side only
[ ] processing polling remains fresh
[ ] ready thumbnail opens existing reference image
[ ] no generic UI/auth/pagination framework added
[ ] no backend pagination/storage/index change added
[ ] historical docs left historical; current runbooks/config updated
```

Fix any mismatch in the owning task's file rather than adding a compensating abstraction.

- [ ] **Step 6: Commit any final stale-reference cleanup**

If Step 1 or Step 5 required current-document/comment cleanup, commit only those corrections:

```bash
git add -u
git commit -m "docs: align admin operations with Access auth"
```

If no cleanup was required, do not create an empty commit.
