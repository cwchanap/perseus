# Admin Portal Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Perseus application admin passkey/session layer in favor of the existing Cloudflare Access boundary, then improve the admin portal with tabs, puzzle search/filtering, fixed 20-row client-side pagination, and enlarged reference-image viewing.

**Architecture:** Keep `GET /api/admin/puzzles` as the fresh full-list all-status contract. Task 1 removes the redundant app auth across API/web/CLI/config and is reviewed as an isolated first commit. The UI then splits puzzle/player concerns; puzzle list math lives in two tiny pure route-local helpers; existing `SearchBar`, category constants, `ReferenceOverlay`, and reference-image endpoint are reused.

**Tech Stack:** Svelte 5 / SvelteKit static adapter, TypeScript, Hono on Cloudflare Workers, Cloudflare Access + Pulumi, Bun, Vitest browser tests.

**Spec:** `docs/superpowers/specs/2026-08-25-admin-portal-enhancement-design.md`

## Global Constraints

- Deliver all implementation work in one PR unless the user explicitly approves a split.
- Task 1 is the first isolated implementation commit and must pass its own verification + diff-review gate before UI commits begin.
- Cloudflare Access is the sole production admin authentication gate after Task 1.
- Preserve `packages/infrastructure/src/workers.ts` `subdomain: { enabled: false, previewsEnabled: false }` exactly.
- Before rollout, enumerate the deployed API Worker's actual Domains & Routes and verify every reachable hostname is covered by Access for `/admin*` and `/api/admin*`.
- Preserve forced full-document navigation for client-routed entry into `/admin`; do not mount admin children before deciding whether that navigation is required.
- Do not add Worker-side Access JWT validation or replacement local-dev admin auth.
- Do not add backend/storage search, filtering, or pagination for `GET /api/admin/puzzles`.
- Keep startup uploader full-list dedup behavior intact.
- Keep `credentials: 'include'` on browser admin API calls.
- Search is trimmed, case-insensitive substring matching on puzzle name.
- Category + status + search combine with AND semantics.
- Pagination runs after filtering with fixed `PAGE_SIZE = 20`.
- Criteria changes reset the requested page to page 1.
- Reuse `SearchBar.svelte`, `$lib/constants/categories`, `ReferenceOverlay.svelte`, and `getReferenceImageUrl()`.
- Do not add generic auth/tab/filter/pagination/dialog/lightbox abstractions.
- Preserve `AGENTS.md` as a symlink to `CLAUDE.md`; modify only `CLAUDE.md`.
- Delete obsolete passkey/session compatibility paths instead of preserving backward compatibility.
- Keep player auth (`JWT_SECRET`, `PlayerSessionResponse`, Google OAuth, OAuth/avatar rate limiting) unchanged.

---

# Task 1: Retire the application admin passkey/session end-to-end

This is a deletion/refactor. Use the sequence **green baseline -> delete runtime/config -> repair directly-owned tests -> sweep -> verify**. Do not manufacture a long test-first red phase for APIs whose only intended behavior is deletion.

## Task 1 file inventory

### API runtime

- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/worker.ts`
- Delete: `apps/api/src/middleware/auth.worker.ts`
- Delete: `apps/api/src/middleware/auth.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-extra.worker.test.ts`
- Delete: `apps/api/src/middleware/auth-coverage.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit.worker.ts`

### API tests/fixtures that directly own deleted auth behavior

- Modify: `apps/api/src/middleware/rate-limit.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit-coverage.worker.test.ts`
- Modify: `apps/api/src/middleware/rate-limit-post-tracking.worker.test.ts`
- Modify: `apps/api/src/__tests__/worker.test.ts`
- Modify: `apps/api/src/__tests__/worker-extra.worker.test.ts`
- Modify: `apps/api/src/services/__tests__/reaper.test.ts`

Remove the `../../middleware/auth.worker` mock entirely from every current admin route test that has one, including:

- `apps/api/src/routes/__tests__/admin.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-coverage.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-ownership-catch.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-fail-reservation.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-cleanup-final.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-dead-pending-failure.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-idempotency-errors.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-ownership-mirror-best-effort.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-worker-extra.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-extra-coverage.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-idempotency-commit.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-aspect-ratio.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-ownership-db-init.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-idempotency-race.worker.test.ts`
- `apps/api/src/routes/__tests__/admin-coverage-gaps.worker.test.ts`

Do not replace those mocks with a pass-through `requireAuth` fake.

### Shared/web auth contracts

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

### CLI

- Modify: `scripts/startup/types.ts`
- Modify: `scripts/startup/cli.ts`
- Modify: `scripts/startup/upload.ts`
- Modify: `scripts/startup/upload.test.ts`
- Modify: `scripts/startup/token.ts`
- Modify: `scripts/startup/cli.test.ts`
- Modify: `scripts/startup/token.test.ts`
- Modify: `scripts/admin-upload-puzzle.ts`
- Modify: `scripts/admin-bulk-upload-startup.ts`
- Modify: `scripts/admin-bulk-upload-startup.test.ts`

### Infrastructure/workflows/current docs

- Modify: `packages/infrastructure/src/admin-access.ts`
- Modify: `packages/infrastructure/src/admin-access.test.ts`
- Modify: `packages/infrastructure/src/workers.ts` comments only; preserve the origin-isolation setting exactly.
- Modify: `packages/infrastructure/src/index.ts`
- Modify: `packages/infrastructure/src/deploy-workflow.test.ts`
- Modify: `.github/workflows/deploy-infrastructure.yml`
- Modify: `.github/workflows/seed-startup-puzzles.yml`
- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/package.json`
- Modify: `apps/api/.env.example`
- Modify: `packages/infrastructure/README.md`
- Modify: `.agents/skills/perseus-operations/references/operator-runbook.md`
- Modify: `CLAUDE.md`
- Modify: `docs/PRD.md`
- Modify other **current/pending** `docs/**` hits found by the final sweep, including `docs/follow_up/**` when they describe the old admin passkey/login as current behavior.

`AGENTS.md` is **not** a separate modification target. It is a symlink to `CLAUDE.md` and must remain one.

`packages/infrastructure/Pulumi.production.yaml` is **not tracked**; `Pulumi.*.yaml` is gitignored. Remove the orphan `adminPasskey` from the real Pulumi stack configuration operationally after deployment rather than adding a nonexistent file to this PR.

## Resulting CLI interfaces

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

Session-cookie parameters disappear:

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

## Task 1 steps

- [ ] **Step 1: Record a green baseline**

```bash
bun run test:unit --filter=@perseus/types
bun run test:unit --filter=@perseus/api
bun run test:unit --filter=@perseus/web
bun run test:scripts
bun run test:unit --filter=@perseus/infrastructure
bun run check:scripts
bun run check --filter=@perseus/api --filter=@perseus/web --filter=@perseus/infrastructure
```

If baseline is not green, separate pre-existing failures from this task before deleting auth.

- [ ] **Step 2: Delete the API admin session layer**

In `apps/api/src/routes/admin.worker.ts`:

- remove imports from `../middleware/auth.worker`;
- remove `loginRateLimit` import;
- delete `/login`, `/session`, `/logout` handlers;
- remove `requireAuth` from all operational admin handlers;
- leave every handler body otherwise unchanged.

Keep the list contract full and fresh:

```ts
admin.get('/puzzles', async (c) => {
  const { puzzles } = await listPuzzles(c.env.PUZZLE_METADATA);
  return c.json({ puzzles });
});
```

In `apps/api/src/worker.ts`:

- remove `ADMIN_PASSKEY` from `Env`;
- remove only the production missing-env validation for `ADMIN_PASSKEY`;
- keep `JWT_SECRET` validation.

Delete `apps/api/src/middleware/auth.worker.ts` after production imports are gone.

- [ ] **Step 3: Delete only login-specific rate limiting**

From `rate-limit.worker.ts`, remove `loginRateLimit()`, `resetLoginAttempts()`, and login-only constants/helpers if unused.

Keep `oauthRateLimit()`, `avatarRateLimit()`, `resetAvatarAttempts()`, and shared KV logic unchanged.

- [ ] **Step 4: Remove the browser admin login/session surface and keep the document gate blocked by default**

Delete the two `/admin/login` files.

Remove `login()`, `logout()`, `checkSession()` from the web API service and remove the admin `LOGOUT` UI.

Do **not** remove `credentials: 'include'` from admin puzzle/allowlist/delete calls.

Simplify `+layout.svelte` without rendering children before the document-navigation decision:

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

Do not rely on parent/child `onMount` ordering.

- [ ] **Step 5: Remove admin-only shared auth contracts**

Delete `LoginResponse`, admin `SessionResponse`, and `WORKER_AUTH_ERROR_CODE` from shared types and their web/CLI imports.

Do not change `PlayerSessionResponse`.

- [ ] **Step 6: Simplify both upload CLIs to Access-only auth**

Remove:

- `--passkey` option/value flag;
- `ADMIN_PASSKEY` env loading;
- passkey readiness output/reason;
- `/api/admin/login` requests;
- `sessionCookieFrom()` and app-session cookie parameters;
- `WORKER_AUTH_ERROR_CODE` / `isWorkerAuth401()`.

Probe behavior:

```text
200           -> ok
401/302/403   -> blocked
5xx           -> unhealthy
other/network -> error
```

Direct list/create requests use only `accessHeaders(options)` plus existing request headers such as `Idempotency-Key`.

- [ ] **Step 7: Remove passkey deployment/seed inputs while preserving Access scope**

In `packages/infrastructure/src/admin-access.ts`:

```ts
export const CLI_ACCESS_PATHS = ['/api/admin/puzzles'] as const;
```

Do not broaden it to the sibling delete endpoint.

Remove `ADMIN_PASSKEY: config.requireSecret('adminPasskey')` from `packages/infrastructure/src/index.ts`.

Remove `adminPasskey` from deploy workflow Pulumi config maps.

Remove `ADMIN_PASSKEY` from `.github/workflows/seed-startup-puzzles.yml`; keep the service-token stack outputs and `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.

Remove local/E2E `ADMIN_PASSKEY` variables from `apps/api/wrangler.toml` and `apps/api/package.json`.

Update the `workers.ts` comment around:

```ts
subdomain: { enabled: false, previewsEnabled: false }
```

so it describes this as origin isolation preventing a bypass of custom-domain Access, not a backstop for deleted `requireAuth`.

- [ ] **Step 8: Repair tests/fixtures directly owned by the deletion**

After production code/config is removed, repair the affected tests in one pass:

**Admin route tests**
- delete every `vi.mock('../../middleware/auth.worker', ...)` block;
- do not add pass-through `requireAuth` fakes;
- assert `GET /puzzles` succeeds locally without a `perseus_session`;
- assert deleted `/login`, `/session`, `/logout` routes return 404 where the existing route harness owns those tests.

**Worker/reaper fixtures**
- remove `ADMIN_PASSKEY` from `worker-extra.worker.test.ts` fixtures;
- remove its fake admin `/session` route if unused;
- remove `ADMIN_PASSKEY` from `services/__tests__/reaper.test.ts` `Env` fixture.

**Rate-limit tests**
- remove login-only imports/cases from all three rate-limit test owners;
- preserve OAuth/avatar coverage.

**Web API tests**
- remove `login/logout/checkSession` imports and suites;
- retain `fetchAdminPuzzles()` `credentials: 'include'` assertion;
- rename the current admin-list 401 test to generic error propagation rather than describing 401 as the expected app-auth contract.

**CLI tests**
- update `scripts/startup/upload.test.ts` option fixtures to remove `passkey`;
- remove `'session=abc'` arguments from upload helper calls;
- update readiness/probe/upload tests for Access-only signatures.

**Infrastructure tests**
- assert no `adminPasskey` config input;
- assert narrow `CLI_ACCESS_PATHS`;
- keep Worker subdomain/previews-disabled assertion.

- [ ] **Step 9: Update current docs and preserve the symlink**

Update current instructions so admin flow starts at the Access-protected `/admin` rather than `/admin/login`.

Correct current CLI credential documentation:
- list/create automation is authenticated by the Access service token only after this change;
- there is no app passkey second factor;
- current configured lifetime is `8760h` (one year), not the stale 90-day wording;
- incident response can disable, rotate, revoke/delete the service token or remove/disable its Service Auth policy.

Modify `CLAUDE.md` only. Verify `AGENTS.md` remains a symlink:

```bash
test -L AGENTS.md
test "$(readlink AGENTS.md)" = "CLAUDE.md"
```

Update `docs/PRD.md`, runbook/infrastructure README, and any current/pending docs hit by the final sweep. Leave completed `docs/superpowers/**` historical.

- [ ] **Step 10: Make a case-insensitive repository sweep the deletion source of truth**

```bash
rg -ni \
  "passkey|/admin/login|/api/admin/(login|session|logout)|checkSession\(|WORKER_AUTH_ERROR_CODE|perseus_session|middleware/auth\.worker|loginRateLimit|resetLoginAttempts" \
  apps packages scripts .github .agents CLAUDE.md docs \
  --glob '!docs/superpowers/**'
```

Expected: no active admin passkey/session references remain. Resolve every non-historical hit before Task 1 closes.

Also verify the Access cookie and symlink invariants:

```bash
rg -n "credentials: 'include'" apps/web/src/lib/services/api.ts
test -L AGENTS.md
test "$(readlink AGENTS.md)" = "CLAUDE.md"
```

- [ ] **Step 11: Verify Task 1 completely**

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

Security/scoping check:

```bash
rg -n "subdomain:|previewsEnabled|CLI_ACCESS_PATHS|puzzle-delete|credentials: 'include'" \
  packages/infrastructure/src \
  apps/api/src/routes/admin.worker.ts \
  apps/web/src/lib/services/api.ts
```

Confirm:
- public Worker subdomain + preview URLs remain disabled;
- CLI Access path is exact `/api/admin/puzzles`;
- destructive delete remains sibling `/api/admin/puzzle-delete/:id`;
- browser admin requests retain credentials.

- [ ] **Step 12: Commit and review Task 1 before any UI work**

```bash
git add apps packages scripts .github .agents CLAUDE.md docs
git commit -m "refactor: rely on Cloudflare Access for admin auth"
```

Then review the isolated commit:

```bash
git show --stat --oneline HEAD
git diff HEAD^..HEAD -- \
  apps/api \
  apps/web/src/routes/admin \
  apps/web/src/lib/services \
  scripts \
  packages/infrastructure \
  .github \
  CLAUDE.md \
  docs
```

Checklist:

```text
[ ] No application admin login/session middleware remains
[ ] No admin route test still mocks auth.worker/requireAuth
[ ] Browser admin fetches still include credentials
[ ] Worker subdomain + previews remain disabled
[ ] CLI Access path is exact /api/admin/puzzles
[ ] Delete endpoint remains outside CLI Service Auth path
[ ] Seed workflow uses Access service-token credentials only
[ ] Player auth/JWT/OAuth/avatar behavior is untouched
[ ] AGENTS.md is still a symlink to CLAUDE.md
[ ] No tab/search/filter/preview refactor is mixed into this commit
```

Do not begin Task 2 until this commit and verification are clean.

---

# Task 2: Split puzzle management and Player Access into route-local tabs

## Files

- Modify: `apps/web/src/routes/admin/+page.svelte`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte`
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts`
- Create: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Create: `apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts`

## Ownership

- `+page.svelte`: header, Upload/View Arcade, active tab.
- `AdminPuzzlesPanel.svelte`: puzzle load/poll/delete/success/error behavior.
- `PlayerAccessPanel.svelte`: allowlist load/add/remove/stale-response/error behavior.

## Steps

- [ ] **Step 1: Add a failing shell test for default tab and lazy Player Access loading**

Pin:
- `PUZZLES` is selected initially;
- puzzle panel loads initially;
- allowlist is not fetched until `PLAYER ACCESS` is selected;
- Control Panel / Upload / View Arcade remain.

- [ ] **Step 2: Run web unit tests and confirm the tab contract is red**

```bash
bun run test:unit --filter=@perseus/web
```

- [ ] **Step 3: Extract puzzle behavior unchanged**

Move current puzzle state/functions/markup into `AdminPuzzlesPanel.svelte`, including existing ready/processing/failed rendering, deletion/force-delete/partial-warning/error behavior, success timer, and 3-second processing polling.

Move those existing tests to the new panel test owner.

Do not add search/filter/pagination yet.

- [ ] **Step 4: Extract Player Access behavior unchanged**

Move allowlist load/add/remove/stale-response/error state into `PlayerAccessPanel.svelte`. Its `onMount` loads only the allowlist.

Move allowlist tests to the new panel test owner.

- [ ] **Step 5: Reduce `+page.svelte` to shell + two accessible tabs**

Use local `puzzles | players` state, normal `tablist/tab/tabpanel` semantics, and conditional mount of exactly one panel.

No tab framework, URL state, or nested admin routes.

- [ ] **Step 6: Verify and commit Task 2**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
git add apps/web/src/routes/admin
git commit -m "refactor: split admin portal into tabs"
```

---

# Task 3: Add pure admin list helpers, search/filter controls, and filtered pagination

## Files

- Create: `apps/web/src/routes/admin/adminPuzzleList.ts`
- Create: `apps/web/src/routes/admin/adminPuzzleList.test.ts`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Reuse unchanged: `apps/web/src/lib/components/SearchBar.svelte`
- Reuse unchanged: `apps/web/src/lib/constants/categories.ts`

## Interfaces

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

## Steps

- [ ] **Step 1: Write failing pure filter tests**

Use four small puzzle fixtures and pin:
- `  FoReSt  ` matches Forest names case-insensitively;
- Nature + processing + `forest` returns only the AND match;
- concrete category excludes an uncategorized legacy row;
- `all` category includes it;
- empty match returns `[]`.

- [ ] **Step 2: Write failing pure page tests**

Use integers, not DOM rows. Pin first page, final page, out-of-range clamp, empty list, negative page clamp, and `pageSize <= 0` programmer error.

- [ ] **Step 3: Run web tests and confirm helper tests are red**

```bash
bun run test:unit --filter=@perseus/web
```

- [ ] **Step 4: Implement only `filterAdminPuzzles()` and `pageSlice()`**

`filterAdminPuzzles` trims/lowercases query, does substring match, then category/status AND filtering.

`pageSlice` returns `{ page, totalPages, clampedIndex }`; do not write clamped state back from a Svelte `$effect`.

Keep this helper beside the admin route; do not promote it into a generic pagination package.

- [ ] **Step 5: Add failing panel tests for UI wiring**

With small fixtures cover:
- SearchBar value callback;
- category select;
- status select;
- combined controls;
- `RESET`;
- filtered-empty copy;
- match/total count;
- hidden `processing` row still causes polling after 3 seconds.

Pure tests own trim/case/AND/page-boundary permutations.

- [ ] **Step 6: Add one 21-row browser pagination wiring test**

Only prove that fixed 20-row controls are connected:
- page 1 shows first 20, Previous disabled, Next enabled;
- Next shows row 21, Previous enabled, Next disabled.

- [ ] **Step 7: Wire route-local state using existing seams**

Reuse:

```svelte
<SearchBar
  value={searchQuery}
  onInput={(value) => {
    searchQuery = value;
    pageIndex = 0;
  }}
/>
```

Import `PUZZLE_CATEGORIES` / `PuzzleCategory` via `$lib/constants/categories`.

Use simple `<select>` controls for `ALL CATEGORIES` and `ALL STATUS | READY | PROCESSING | FAILED`.

Do not debounce and do not reuse gallery chip-style `CategoryFilter.svelte`.

Derive:

```ts
const filteredPuzzles = $derived(
  filterAdminPuzzles(puzzles, {
    query: searchQuery,
    category: categoryFilter,
    status: statusFilter
  })
);

const pageResult = $derived(pageSlice(filteredPuzzles, pageIndex, PAGE_SIZE));
const visiblePuzzles = $derived(pageResult.page);
```

Use `pageResult.clampedIndex` in the rendered page label/buttons. Criteria callbacks reset `pageIndex = 0`.

Polling remains based on raw `puzzles.some((p) => p.status === 'processing')`.

- [ ] **Step 8: Add Reset, empty copy, count, and minimal paging controls**

`RESET` appears only while criteria are active.

Empty states:

```text
raw list empty                     -> No missions found.
raw non-empty + zero filtered rows -> No missions match the current search and filters.
```

Active criteria show `{filteredCount} OF {totalCount}` using existing admin header styling.

- [ ] **Step 9: Verify and commit Task 3**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
git diff HEAD -- apps/api/src/routes/admin.worker.ts apps/web/src/lib/services/api.ts
```

Expected: no search/filter/pagination API change.

```bash
git add \
  apps/web/src/routes/admin/AdminPuzzlesPanel.svelte \
  apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts \
  apps/web/src/routes/admin/adminPuzzleList.ts \
  apps/web/src/routes/admin/adminPuzzleList.test.ts
git commit -m "feat: filter and paginate admin puzzles"
```

---

# Task 4: Reuse ReferenceOverlay for enlarged ready-puzzle images

## Files

- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Reuse unchanged: `apps/web/src/lib/components/ReferenceOverlay.svelte`
- Reuse unchanged: `apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts`

## Steps

- [ ] **Step 1: Add failing admin-panel preview tests**

For a ready `Forest Scene`:
- click `View full image for Forest Scene`;
- assert dialog `Reference image` appears;
- assert image URL uses `/api/puzzles/<id>/reference`;
- Close dismisses;
- Escape dismisses;
- dispatch image `error` and assert `Reference image unavailable`;
- processing/failed placeholders have no preview trigger.

Do not duplicate existing `ReferenceOverlay` focus-trap/touch-target tests in the admin panel.

- [ ] **Step 2: Run web tests and confirm preview wiring is red**

```bash
bun run test:unit --filter=@perseus/web
```

- [ ] **Step 3: Make only ready thumbnails interactive and render the existing overlay**

```ts
import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
import { getReferenceImageUrl } from '$lib/services/api';

let previewPuzzle: PuzzleSummary | null = $state(null);

function dismissPreview() {
  previewPuzzle = null;
}

function handlePreviewKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || previewPuzzle === null) return;
  event.preventDefault();
  dismissPreview();
}
```

```svelte
<svelte:window onkeydown={handlePreviewKeyDown} />

<ReferenceOverlay
  imageUrl={previewPuzzle ? getReferenceImageUrl(previewPuzzle.id) : null}
  active={previewPuzzle !== null}
  dismissible
  onDismiss={dismissPreview}
/>
```

This mirrors gameplay's route-level Escape ownership. `ReferenceOverlay` remains unchanged and continues to own focus restoration, Close control, touch size, and image-error fallback.

- [ ] **Step 4: Verify and commit Task 4**

```bash
bun run test:unit --filter=@perseus/web
bun run check --filter=@perseus/web
git add apps/web/src/routes/admin/AdminPuzzlesPanel.svelte apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts
git commit -m "feat: preview admin puzzle images"
```

---

# Task 5: Final verification, ingress precondition, and rollout

- [ ] **Step 1: Repeat the case-insensitive auth-deletion sweep**

```bash
rg -ni \
  "passkey|/admin/login|/api/admin/(login|session|logout)|checkSession\(|WORKER_AUTH_ERROR_CODE|perseus_session|middleware/auth\.worker|loginRateLimit|resetLoginAttempts" \
  apps packages scripts .github .agents CLAUDE.md docs \
  --glob '!docs/superpowers/**'
```

Expected: no active old admin-auth references remain.

- [ ] **Step 2: Re-check code-level security/scoping invariants**

```bash
rg -n "subdomain:|previewsEnabled|CLI_ACCESS_PATHS|puzzle-delete|credentials: 'include'" \
  packages/infrastructure/src \
  apps/api/src/routes/admin.worker.ts \
  apps/web/src/lib/services/api.ts

test -L AGENTS.md
test "$(readlink AGENTS.md)" = "CLAUDE.md"
```

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

- [ ] **Step 4: Audit the final diff against scope**

```text
[ ] Access-only app auth cut is complete
[ ] Worker origin isolation is retained
[ ] No auth.worker/requireAuth mocks remain in admin tests
[ ] Browser admin API calls retain credentials
[ ] Forced document navigation blocks children until redirect decision
[ ] CLI service token path stays exact /api/admin/puzzles
[ ] Delete remains outside CLI Service Auth path
[ ] Seed workflow has no ADMIN_PASSKEY dependency
[ ] AGENTS.md is still a symlink to CLAUDE.md
[ ] Player Access is a separate lazy tab
[ ] Search reuses SearchBar
[ ] Categories come through web constants
[ ] Pure helper tests own filter/page math
[ ] Filtered results page at exactly 20 rows
[ ] Hidden processing rows keep polling alive
[ ] Preview reuses ReferenceOverlay unchanged
[ ] No backend admin query layer or generic UI framework was added
```

- [ ] **Step 5: Before deployment, verify the real Worker ingress inventory**

The repo cannot prove production custom-domain/route attachment. Before shipping the auth deletion:

1. Open Cloudflare Workers & Pages for the deployed API Worker.
2. Inspect **Settings -> Domains & Routes** (or an equivalent account-level API/CLI listing).
3. Enumerate every live route/custom domain pointing at the Worker.
4. Confirm `workers.dev` and previews are disabled.
5. For each live hostname, verify a Cloudflare Access application covers `/admin*` and `/api/admin*`.
6. Stop deployment if any alternate hostname can reach admin paths without Access.

Do not add new routing IaC merely for this ticket.

- [ ] **Step 6: Post-deploy admin/CLI smoke**

1. Allowed identity/device opens `/admin` without a Perseus passkey.
2. Denied identity/device cannot reach `/admin` or broad admin API paths.
3. Public-SPA navigation into `/admin` reaches the full-document Access path before admin panel fetches start.
4. `admin:startup:status` succeeds with service-token credentials and no passkey.
5. Bounded list/create works through exact `/api/admin/puzzles`.
6. Seed workflow succeeds with no `ADMIN_PASSKEY` secret dependency.
7. CLI service token cannot reach `/api/admin/puzzle-delete/:id`.
8. Puzzle search/category/status/Reset/20-row paging behave as specified.
9. Player Access add/remove still works.
10. Ready image preview opens; Close/Escape dismiss; missing reference shows unavailable fallback.
11. Public player routes remain unaffected.
12. Local dev admin remains open without app auth.

- [ ] **Step 7: Remove stale Pulumi stack config and verify the service-token incident path**

Because `Pulumi.*.yaml` stack files are untracked, remove the orphan config from the actual production stack after the deployed program no longer consumes it:

```bash
cd packages/infrastructure
pulumi config rm adminPasskey --stack <production-stack>
pulumi config --stack <production-stack>
```

Confirm `adminPasskey` is absent.

Document/verify that the Access service token is now the sole list/create credential. If compromised, use the available Cloudflare control appropriate to the incident: disable the token, rotate its secret, revoke/delete it, or remove/disable the Service Auth policy. There is no longer an application passkey second factor.
