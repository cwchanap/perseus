# Admin Portal Enhancement Design

## Summary

Simplify the Perseus admin portal around the Cloudflare Zero Trust boundary that already protects the production admin surface, then improve the existing admin UI with tab separation, client-side puzzle pagination, and an enlarged puzzle-image preview.

This remains one implementation slice and one PR. It does not introduce a new admin framework, a new storage/indexing path, or another authentication mechanism.

## Goals

- Remove the Perseus admin passkey and `perseus_session` authentication layer.
- Keep Cloudflare Access as the production admin security boundary.
- Preserve the existing forced full-document navigation when entering `/admin` from the public SPA so Cloudflare Access receives a document request and can challenge it.
- Preserve the existing narrow Cloudflare Access service-token path for admin upload automation, but remove its dependency on the Perseus passkey/session flow.
- Separate puzzle management and player allowlist management into `PUZZLES` and `PLAYER ACCESS` tabs.
- Show the puzzle list in fixed pages of 20 rows.
- Allow a ready puzzle thumbnail to open the existing reference image in an enlarged modal view.

## Non-Goals

- No Worker-side Cloudflare Access JWT validation.
- No replacement local-dev admin authentication.
- No role/permission system.
- No new backend or storage pagination API.
- No search, filtering, sorting, or page-size selector in the admin portal.
- No player-access pagination.
- No URL-backed tab state or nested admin routes.
- No generic tab, pagination, dialog, or lightbox framework.
- No new image endpoint or raw-original download path.
- No compatibility path for the deleted passkey/session API.

## Current Context

Production admin traffic is already protected by Cloudflare Access. `packages/infrastructure/src/admin-access.ts` covers `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*` with the configured browser identity/device-posture policy. A more-specific CLI Access application covers the admin puzzle endpoint and adds a service-token policy for automation.

The Pulumi-managed API Worker in `packages/infrastructure/src/workers.ts` already disables both the `workers.dev` subdomain and preview URLs with `subdomain: { enabled: false, previewsEnabled: false }`. Pulumi is the production source of truth, so this change must preserve that setting rather than duplicate it in Wrangler configuration.

The application currently adds a second admin-auth layer: `/api/admin/login` validates `ADMIN_PASSKEY`, creates `perseus_session`, the admin Svelte layout checks that session, and all admin API handlers use `requireAuth`. Startup and one-off upload CLIs also obtain the same session after passing Cloudflare Access.

The current admin page loads puzzle management and player access together. Puzzle processing is polled every three seconds. `GET /api/admin/puzzles` returns the full freshly-read admin puzzle list, including `processing` and `failed` records. Startup upload tooling also consumes that full list for its preflight deduplication snapshot.

The web client already exposes `getReferenceImageUrl(puzzleId)`, backed by `GET /api/puzzles/:id/reference`, so enlarged image viewing does not require a new asset/API path.

## Design

### 1. Cloudflare Access becomes the sole production admin gate

Delete the Perseus admin login/session feature rather than leaving a dormant compatibility layer:

- Remove `/api/admin/login`, `/api/admin/session`, and `/api/admin/logout`.
- Remove `requireAuth` from admin API handlers.
- Delete the admin-session middleware once all references are gone.
- Remove `ADMIN_PASSKEY` from the Worker environment, Pulumi bindings, GitHub Actions configuration, local development configuration, and operator documentation.
- Remove admin-only `LoginResponse`, `SessionResponse`, and `WORKER_AUTH_ERROR_CODE` contracts once their callers are gone.
- Remove the `/admin/login` Svelte route and the admin page's Perseus `LOGOUT` button.

`JWT_SECRET` stays because player authentication still uses it.

Production authorization is therefore:

```text
Browser admin
  -> Cloudflare Access: email + device posture
  -> /admin and /api/admin/*

Admin upload automation
  -> Cloudflare Access: service token
  -> exact /api/admin/puzzles path only
```

The more-specific CLI Access app keeps browser email/posture access as well, so browser administration continues to work on `/api/admin/puzzles`.

The destructive delete route remains `POST /api/admin/puzzle-delete/:id`, outside the CLI service-token application's exact `/api/admin/puzzles` destination. Do not broaden the CLI Access destinations.

Local development intentionally has no admin auth after this change. Local `/admin` and `/api/admin/*` are developer-only surfaces; do not add a replacement dev passkey or feature flag.

### 2. Preserve the admin document-navigation seam

`apps/web/src/lib/services/adminNavigation.ts` and the document-navigation branch in `apps/web/src/routes/admin/+layout.svelte` remain.

A client-side navigation from a public page to `/admin` does not inherently make a new document request. The existing layout detects that case and calls `window.location.assign(...)`; this must remain so the browser reaches Cloudflare Access before rendering the admin document.

The layout is otherwise simplified: no session fetch, login-page special case, loading spinner, redirect state, or route-change session rechecks. On a direct admin document load that already passed Access, it renders its children immediately.

Update comments so they describe Cloudflare Access as the security boundary rather than referring to the deleted application auth layer.

### 3. Simplify the admin upload CLIs instead of replacing auth

Keep the existing Cloudflare Access credential support:

- service tokens remain the preferred automation path;
- browser `CF_Authorization` JWT support may remain for operator use;
- `--skip-access` remains valid only for loopback/local targets.

Delete the Perseus login/session step. Once Access credentials are probed successfully, CLI GET/POST requests go directly to `/api/admin/puzzles` with the Access headers.

The startup CLI's readiness check becomes an Access/backend-health check only. Remove `--passkey`, `ADMIN_PASSKEY`, `passkey-missing`, session-cookie parsing, and `/api/admin/login` calls.

Because the Worker no longer emits a `requireAuth` 401, Access probes no longer need `WORKER_AUTH_ERROR_CODE` to distinguish Worker 401 from Access 401. A 401 from the probe is simply treated as Access blocked.

### 4. Keep puzzle pagination entirely in the admin UI

Do not change `GET /api/admin/puzzles` or `fetchAdminPuzzles()` for this feature.

Reasons:

- the current admin polling wants fresh processing progress, while the public gallery's cached pagination index has a 60-second TTL;
- the startup uploader expects the full admin list for deduplication;
- the current data volume only needs a usability improvement, not a storage scalability project.

`AdminPuzzlesPanel.svelte` owns the full `PuzzleSummary[]` and a zero-based `pageIndex`. Use a fixed `PAGE_SIZE = 20` and derive the visible slice from the in-memory array.

Show Previous/Next controls only when there is more than one page. Disable them at the boundaries and display `PAGE n / totalPages`.

Polling continues to refresh the full puzzle array so processing work anywhere in the admin list can continue to resolve. After a reload or deletion, clamp `pageIndex` to the last valid page so deleting the final row of the final page does not leave an empty out-of-range page.

No API/wire-contract or storage-service change is part of pagination.

### 5. Split the admin page by responsibility

Use three route-local files:

```text
apps/web/src/routes/admin/
  +page.svelte
  AdminPuzzlesPanel.svelte
  PlayerAccessPanel.svelte
```

`+page.svelte` owns only:

- the page header;
- Upload and View Arcade links;
- a local `puzzles | players` active-tab value;
- the two tab buttons and conditional panel mount.

`AdminPuzzlesPanel.svelte` owns the existing puzzle loading, processing polling, deletion, partial-success message, pagination, and image-preview state.

`PlayerAccessPanel.svelte` owns the existing allowlist load/add/remove/error state.

The default tab is `PUZZLES`. Use normal accessible tab semantics (`tablist`, `tab`, `aria-selected`, `tabpanel`) but no reusable tab abstraction.

Mount only the active panel. This means Player Access is not fetched on initial admin load, processing polling stops while the puzzle panel is unmounted, and returning to a tab reloads its data and resets that panel's local page state. That reset is acceptable for this private admin tool and keeps state ownership simple.

### 6. Reuse the reference image for enlargement

For ready puzzles, make the existing thumbnail a button labelled `View full image for <puzzle name>`. Clicking it sets a route-local `previewPuzzle` state.

Render a small modal directly in `AdminPuzzlesPanel.svelte` using the existing `modalFocus` action pattern:

- `role="dialog"` and `aria-modal="true"`;
- focusable dialog container using `modalFocus`;
- Escape closes;
- visible Close button;
- `<img src={getReferenceImageUrl(previewPuzzle.id)} ...>` constrained to the viewport with `object-contain`.

Processing and failed placeholders are not clickable. Do not add a lightbox dependency or new generic dialog component for this one use.

## Testing Strategy

### Admin authentication removal

- API route tests prove admin operations no longer require `perseus_session` and the deleted login/session/logout routes are absent.
- Worker environment tests no longer require `ADMIN_PASSKEY` in production configuration.
- Admin layout tests prove direct admin loads render immediately and client-routed entry still forces a document navigation.
- Infrastructure tests pin the existing `subdomain.enabled = false` and `previewsEnabled = false` behavior and update the CLI Access path expectation to only `/api/admin/puzzles`.
- Script tests prove status/upload work with Access credentials alone and no passkey/session-cookie step.

### Admin UI

- Shell tests prove `PUZZLES` is the default tab and `PLAYER ACCESS` is loaded only after selecting its tab.
- Puzzle-panel tests retain ready/processing/failed rendering, delete/force-delete/error behavior, and three-second polling.
- Pagination tests cover 21+ rows, Previous/Next boundaries, and clamping after deletion/reload.
- Preview tests cover opening the existing reference URL, Close, Escape, and non-clickable processing/failed placeholders.
- Player-access tests retain linked-player display plus add/remove/error behavior after extraction.

## Documentation Cleanup

Update current operational documentation and comments that instruct operators to set an admin passkey or describe `perseus_session` as a security layer. Historical design/plan documents may remain historical records; do not rewrite old completed specs merely to erase history. Current README/runbook/config examples must describe Cloudflare Access as the active admin boundary.

## Rollout

This is intentionally a breaking change with no compatibility window.

Deploying the implementation removes application-level admin auth in the same release that removes its callers and configuration. Existing Cloudflare Access resources stay in place. The Pulumi Worker continues to have public subdomain and preview URLs disabled.

After deployment, manually verify:

1. An allowed browser identity/device can open `/admin` without a Perseus passkey prompt.
2. A browser/device denied by Cloudflare Access cannot reach `/admin` or broad admin API paths.
3. The CLI service token can list/create through exact `/api/admin/puzzles` but cannot reach the delete sibling path.
4. Public player routes remain unaffected.
5. Local development opens the admin portal without a passkey.

## Self-Review Decisions

The initial brainstorm was tightened in four places after inspecting the current repository:

1. **No new Wrangler ingress flags.** Pulumi already disables `workers.dev` and preview URLs; duplicate production configuration would create two sources of truth.
2. **No backend admin paginator.** Client-side slicing preserves fresh three-second processing polling and avoids changing the full-list contract used by startup deduplication.
3. **Do not delete admin document navigation.** It is still required to turn public-SPA navigation into a document request that reaches Cloudflare Access.
4. **Do not delete the shared rate-limit module.** Only the admin-login limiter is obsolete; OAuth/avatar limiting remains player-facing behavior.
