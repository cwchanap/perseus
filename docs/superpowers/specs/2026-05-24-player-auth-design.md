# Player Authentication Design

Date: 2026-05-24
Status: Approved design

## Summary

Perseus will add Google-only player authentication as the account foundation for future cloud
progress, personal best sync, leaderboards, and daily challenges. The first implementation slice
is auth-only: players can sign in, sign out, and see signed-in state, while gameplay remains
available to anonymous visitors.

The existing admin passkey system remains the operator authentication boundary. Admins will use
the existing protected admin panel to manage a KV-backed player email allowlist. Google verifies
identity, and Perseus decides whether the verified email may create or use a player account.

## Goals

- Add Google-only player sign-in and sign-out.
- Keep Google tokens out of the browser by owning the OAuth flow in the API Worker.
- Require an app-level email allowlist before account creation or session use.
- Give admins a small allowlist management surface in the existing admin panel.
- Store only minimal account profile data in this slice.
- Preserve the current anonymous gallery, puzzle, and quick puzzle flows.
- Leave a clear path for cloud progress, daily challenges, and leaderboards.

## Non-Goals

- No email/password, magic link, anonymous upgrade, or multi-provider auth.
- No cloud progress sync, server-side personal bests, score submission, or leaderboard UI.
- No public signup outside the allowlist.
- No replacement of the existing admin passkey auth.
- No bulk allowlist import in the first slice.

## Chosen Approach

Use a Worker-owned Google OAuth redirect flow with KV-backed allowlist, accounts, and sessions.
The Svelte app only links to auth endpoints and reads a session response. It never receives or
stores Google access tokens or ID tokens.

D1 is deferred. KV is sufficient for the first slice because the data is small, key-oriented, and
low-write. A later progress or leaderboard slice can add D1 when relational queries, ranking, and
historical submissions become real requirements.

## Architecture

The production path stays Cloudflare Worker-first. New player auth routes are mounted beside the
existing puzzle and admin routes:

- `/api/auth/*` owns player Google sign-in, callback, session, and logout.
- `/api/admin/player-allowlist/*` owns admin-managed allowlist operations.
- Existing `/api/admin/*` passkey login, session checks, and puzzle management remain unchanged.

The Worker implementation is canonical for production. The first implementation also adds Bun API
route parity for the same public contracts by using a filesystem-backed auth storage service under
`DATA_DIR/auth`, matching how local puzzle storage already mirrors production storage.

Shared response and model types live in `packages/types` so the API and web app agree on
contracts.

## OAuth Flow

1. The player clicks "Sign in with Google" from the app shell or `/login`.
2. `GET /api/auth/google/start` creates a random state value and PKCE verifier, stores them in
   KV with a short TTL, sets a temporary HttpOnly state cookie, and redirects to Google with
   `openid email profile`.
3. Google redirects to `/api/auth/google/callback`.
4. The API verifies the returned state against KV and the state cookie, exchanges the code for
   tokens, and validates the ID token.
5. ID token validation checks signature, issuer, audience, expiry, subject, email, and
   `email_verified`.
6. The normalized email must exist in the player allowlist.
7. If allowed, the API upserts the player profile, records `lastLoginAt`, creates a revocable
   player session, clears temporary OAuth state, sets `perseus_player_session`, and redirects back
   to the app.
8. `/api/auth/session` returns authenticated user state for the frontend.
9. `/api/auth/logout` revokes the server-side session and clears the player cookie.

Player sessions last 30 days. Admin session behavior is unchanged.

## KV Data Model

Production Worker keys:

- `player_allowlist:<normalizedEmail>` stores an allowlist entry.
- `player:<googleSub>` stores the minimal player profile.
- `player_email_index:<normalizedEmail>` maps an email address to a Google subject.
- `player_session:<sessionHash>` stores an active player session record.
- `player_sessions:<googleSub>` stores the known active session hashes for revocation.
- `oauth_state:<stateHash>` stores short-lived OAuth state and PKCE verifier data.

Allowlist entry value:

```ts
interface PlayerAllowlistEntry {
	email: string;
	createdAt: number;
	addedBy: string;
	player?: PlayerUser;
}
```

Player value:

```ts
interface PlayerUser {
	id: string;
	email: string;
	name?: string;
	picture?: string;
	createdAt: number;
	lastLoginAt: number;
}
```

Session response:

```ts
interface PlayerSessionResponse {
	authenticated: boolean;
	user?: PlayerUser;
}
```

The session record stores enough information to verify the session, find the player, and confirm
the email is still allowlisted. Session verification should require both an active session key and
a current allowlist entry.

## API Contract

Player auth endpoints:

- `GET /api/auth/google/start?returnTo=/optional/path`
- `GET /api/auth/google/callback`
- `GET /api/auth/session`
- `POST /api/auth/logout`

Admin allowlist endpoints:

- `GET /api/admin/player-allowlist`
- `POST /api/admin/player-allowlist` with `{ email }`
- `DELETE /api/admin/player-allowlist/:email`

Admin allowlist routes use the existing admin `requireAuth` middleware. Emails are lowercased,
trimmed, and validated before storage. Adding an existing email is idempotent. Removing an email
prevents future sign-ins and revokes known active sessions for the linked player.

`returnTo` accepts same-origin app paths that start with `/` and do not start with `//`.
Absolute `http(s)` URLs are also accepted when the origin is in the server's `ALLOWED_ORIGINS`
allowlist (in development, this falls back to default localhost origins when `ALLOWED_ORIGINS` is
unset). Invalid or missing return targets fall back to `/`.

## Frontend UX

The global layout gets a small navigation cluster instead of a lone floating Quick Puzzle link.
It includes `Quick Puzzle` and an account control.

Signed-out state:

- Shows a `Sign in` link.
- `/login` shows a Google sign-in action and friendly error messages for callback failures.
- Anonymous players can still browse, play puzzles, and create quick puzzles.

Signed-in state:

- Shows the player's display name or email.
- Provides a `Sign out` action.
- Does not unlock additional gameplay behavior in this slice.

On app load, the web app calls `/api/auth/session`. A successful response populates a small auth
store or service. A missing, expired, or failed session check renders signed-out state without
blocking public content.

## Configuration

New production secrets and variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `AUTH_REDIRECT_BASE_URL`

`AUTH_REDIRECT_BASE_URL` is the public origin used to build the Google callback URL. Local Worker
development uses the equivalent values in `.dev.vars` or Wrangler-supported local secret config
with `NODE_ENV=development` for local HTTP callbacks.

The existing `JWT_SECRET` can remain the signing secret source, but player auth code must use a
separate cookie name, session prefix, and route module from admin auth so player and admin
sessions cannot overlap.

## Error Handling

OAuth failures redirect back to `/login` with a short error code:

- `google_error` for Google denial or token exchange failure.
- `session_expired` for missing, invalid, expired, or already-used state.
- `not_allowed` for verified Google users whose email is not allowlisted.
- `server_error` for unexpected server failures.

The UI maps these codes to friendly messages. Token details, raw provider errors, and stack traces
are not exposed to the browser.

Admin allowlist routes return structured JSON errors using the existing API style:
`{ error, message }`.

## Security

- Browser code never receives Google tokens.
- OAuth state is random, single-use, TTL-bound, and checked against both KV and an HttpOnly
  cookie.
- PKCE is used for the Google code exchange.
- ID token validation checks signature and required claims server-side.
- Player sessions use `HttpOnly`, `SameSite=Lax`, `Secure` outside development, and a distinct
  `perseus_player_session` cookie.
- Player session keys are stored server-side and can be revoked.
- Session verification confirms the account email is still allowlisted.
- Admin allowlist mutation remains behind existing admin auth.
- Player auth start/callback failure paths are rate-limited by IP using the existing rate-limit
  style.

## Testing

Backend tests:

- Google callback rejects missing or invalid state.
- Google callback handles token exchange failure.
- ID token validation rejects bad issuer, audience, expiry, subject, unverified email, and
  non-allowlisted email.
- Allowlisted verified email upserts a player, creates a session, and redirects successfully.
- `/api/auth/session` handles missing, valid, expired, revoked, and malformed sessions.
- `/api/auth/logout` clears cookies and revokes server-side sessions.
- Admin allowlist routes require admin auth, validate email, add/list/remove entries, expose
  linked player metadata, and revoke sessions on removal.
- Worker tests are priority; Bun tests cover equivalent behavior for the same route contracts.

Frontend tests:

- Layout renders signed-out and signed-in account controls from the session API.
- `/login` renders the Google sign-in action.
- `/login` maps known error codes to friendly messages.
- Logout clears displayed user state.
- Admin panel can add, list, and remove allowlist entries and handles validation errors.

E2E tests:

- Use mocked API/session responses for layout and login error states.
- Do not automate full Google OAuth in normal CI.
- Verify the real Google flow with a manual local OAuth smoke check after route implementation.

Verification commands:

- `bun run check`
- `bun run test:unit`
- targeted `apps/api` and `apps/web` tests during development
- `bun run test:e2e` when browser-covered routes or flows are touched

## Rollout Notes

The first release can ship with an empty allowlist. Admins add test players from the existing
admin panel. Anonymous gameplay stays available, so there is no migration pressure for existing
local progress or quick puzzles.

Future slices can add cloud progress, daily challenge participation, and leaderboard submission
against this account identity without changing the sign-in model.
