# HPA-4 Optional Mobile Google Sign-In and Account-Bound Completion Sync Design

**Date:** 2026-09-01  
**Linear:** HPA-4 — [Perseus Mobile] Add optional Google sign-in and account-bound completion sync  
**Depends on:** HPA-3 (Done)  
**Independent of:** HPA-46 portrait/adaptive tablet UX (Done)

## Goal

Add the smallest optional account layer needed for mobile completion submission without weakening offline-first gameplay: native Google sign-in, the existing Perseus opaque player session carried as a bearer credential, one durable local completion record per run, and active-app retry for completions created while that account was already signed in.

Signed-out download, play, resume, and completion remain fully local. Signing in adds completion submission only; it does not create cloud saves or make gameplay depend on the network.

## Current Baseline

The repository already owns almost all server semantics HPA-4 needs:

- `apps/api/src/services/player-auth.shared.ts` verifies Google ID tokens against `GOOGLE_CLIENT_ID`.
- `apps/api/src/services/player-auth.worker.ts` owns the allowlist, player upsert, opaque player-session creation, validation, and revocation.
- `apps/api/src/routes/auth.worker.ts` creates the same player session for browser Google OAuth and exposes `GET /api/auth/session` as a `200 PlayerSessionResponse` probe.
- `apps/api/src/middleware/player-auth.worker.ts` and `optional-player-auth.worker.ts` currently read only the browser cookie.
- `apps/api/src/routes/puzzles.complete.worker.ts` already owns the V2 completion write and immutable `runId` replay/conflict behavior.
- `packages/game-core/src/session/codec.ts` already owns completion failure retryability through `isFailureRetryable()`.
- `packages/game-core` already exposes `completionRequestFromSeal(seal)`.
- mobile `Gameplay.svelte` already saves the completed session snapshot immediately when `completion_sealed` fires.
- `apps/mobile/app/App.svelte` is already the composition root for mobile storage, API clients, Library, and Gameplay.

HPA-4 extends these seams rather than creating another account, retry, or synchronization system.

## Selected Architecture

### 1. Native Google ID token -> existing Perseus player session

Add one thin route:

```text
POST /api/auth/mobile/google
{ "idToken": "..." }
```

The route stays outside `/google/*`, so it does not inherit browser-only requirements for `GOOGLE_CLIENT_SECRET` or `AUTH_REDIRECT_BASE_URL`.

It performs only:

1. parse a non-empty ID token;
2. `verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID)`;
3. `getAllowlistEntry()`;
4. `upsertPlayer()`;
5. `createPlayerSession()`;
6. return the opaque session token, expiry, and existing `PlayerUser` with `Cache-Control: no-store`.

Add a shared response and guard beside the existing player contracts:

```ts
export interface MobilePlayerSessionResponse {
  token: string;
  expiresAt: number;
  user: PlayerUser;
}

export function isMobilePlayerSessionResponse(
  value: unknown
): value is MobilePlayerSessionResponse;
```

The guard requires a non-empty token, finite expiry, and `isPlayerUser(user)`. There is no mobile JWT/session type, refresh token, new KV prefix, or database work.

### 2. Reuse the existing Google server audience without Firebase

Create one Google iOS OAuth client for bundle `org.perseus.mobile` in the same Google Cloud project as the existing Perseus web/server client.

The mobile app needs:

- the iOS OAuth client ID;
- that client's reversed URL scheme in `Info.plist`;
- the existing Perseus web/server OAuth client ID as the Google Sign-In `serverClientId`.

`@nativescript/google-signin` 2.1.1 does **not** require `GoogleService-Info.plist` when `configure()` receives an explicit `clientId`; its iOS implementation also accepts `serverClientId` directly. HPA-4 therefore does not create a Firebase project or add `GoogleService-Info.plist`.

Store the two non-secret client IDs in `Info.plist` as `GIDClientID` and `GIDServerClientID`. The native adapter reads those values and calls:

```ts
await GoogleSignin.configure({
  clientId: iosClientId,
  serverClientId
});
```

This makes both identities explicit. Google documents the server client ID as the ID-token audience, so the backend continues verifying against the existing `GOOGLE_CLIENT_ID`. If the native gate produces a different `aud`, fix Google configuration and stop; do not add a second backend audience.

### 3. One canonical bearer-or-cookie player-session resolver

Move credential extraction behind one function in `apps/api/src/middleware/player-auth.worker.ts`:

- valid explicit `Authorization: Bearer <token>` -> bearer token;
- any other explicit `Authorization` value -> authentication failure, with **no cookie fallback**;
- no Authorization header -> existing `perseus_player_session` cookie.

Both forms call the existing `getPlayerSession()` and produce the same `PlayerSessionRecord`.

Reuse this resolver from:

- `requirePlayerAuth`;
- `optionalPlayerAuth`;
- `GET /api/auth/session`;
- `POST /api/auth/logout`.

Keep `GET /api/auth/session` behavior unchanged: an invalid/expired session returns HTTP 200 `{ authenticated: false }`. Mobile parses the body with `isPlayerSessionResponse`; web keeps the same contract.

Do not add `/api/mobile/complete`. Bearer support automatically reaches the existing completion route.

### 4. Mobile account state remains concrete and local to `App.svelte`

Keep two injected seams:

```ts
interface GoogleIdTokenProvider {
  signIn(): Promise<string>;
  signOut(): Promise<void>;
}

interface MobileSessionStore {
  read(): string | null;
  write(raw: string): void;
  clear(): void;
}
```

The secure payload is:

```ts
interface PersistedMobileSession {
  version: 1;
  token: string;
  expiresAt: number;
  user: PlayerUser;
}
```

Restore accepts only:

- `version === 1`;
- non-empty token;
- finite future `expiresAt`;
- `isPlayerUser(user)`.

Invalid/expired secure data is cleared. There is no compatibility parser.

The bearer token exists only in memory and `@nativescript/secure-storage`; never under `Documents/perseus` or `ApplicationSettings`.

Library UI remains one small account strip: sign in, signed-in identity, sign out, and transient error text. No global account store, profile route, or provider abstraction.

### 5. Session validation gates every drain

Use one `App.svelte` path for sign-in, foreground resume, and connectivity restoration:

1. if there is no active local session, do nothing;
2. call `GET /api/auth/session` with its bearer;
3. valid `{ authenticated: false }` (or an explicit HTTP 401 auth failure) -> clear secure storage and drop in-memory account state; do not drain;
4. valid `{ authenticated: true }` -> update the cached `PlayerUser` if needed, then drain pending completions;
5. transport failure or server `5xx` -> retain the local credential and skip this drain pass.

This prevents a dead bearer from becoming a permanent foreground/connectivity retry loop while preserving offline account labeling when the network itself is unavailable.

Logout remains local-first: attempt server revocation and Google sign-out, but always clear the secure Perseus credential. Downloads, puzzle sessions, and completion files are untouched.

### 6. One completion file is both history and queue state

Use one durable record per run:

```ts
interface MobileCompletionRecordV1 {
  version: 1;
  runId: string;
  puzzleId: string;
  completedAt: number;
  accountId: string | null;
  request: RecordPuzzleCompletionV2;
  syncStatus: 'local_only' | 'pending' | 'synced' | 'terminal';
}
```

Path:

```text
Documents/perseus/completions/<runId>.json
```

The `accountId` is frozen from the active account at completion time.

- signed out -> `accountId: null`, `local_only` forever;
- signed in -> account ID + `pending` before any network request;
- successful submission -> update the same record to `synced`;
- terminal failure -> update the same record to `terminal`;
- retryable failure -> leave the same record `pending`.

There is **no second `outbox/` directory or duplicate request file**. Drain lists `completions/`, validates records, filters `syncStatus === 'pending' && accountId === activeSession.user.id`, and sorts by `completedAt` then `runId`.

This removes dual-write split-brain risk while keeping recovery trivial for the current scale.

### 7. Reuse the shipped completion-failure policy

Do not invent a mobile HTTP-range retry policy. Extract the existing web status -> `CompletionFailureCode` mapping into `packages/game-core/src/session/codec.ts` beside `isFailureRetryable()`:

```ts
export function completionFailureCodeFromHttpStatus(
  status: number
): CompletionFailureCode;
```

Both web and mobile call it.

Expected completion dispositions are:

| Wire | Failure code / disposition |
| --- | --- |
| 2xx | synced |
| 401 | `unauthorized` -> auth required; stop pass |
| 400 | `bad_request` -> terminal |
| 404 | `not_found` -> terminal |
| 409 | `run_id_conflict` -> terminal |
| 429 | `completion_quota_exceeded` -> terminal |
| 408 / 5xx / unknown server error | `internal_error` -> retryable; stop pass |
| transport rejection | `network_error` -> retryable; stop pass |

`isFailureRetryable()` remains the single retryability policy. In particular, completion HTTP 429 is the server's quota terminal, not a generic rate-limit retry.

### 8. Completion file parsing reuses shared validators

A completion file is accepted only when the outer record is valid and:

- `runId` is valid and equals `request.runId`;
- `puzzleId` is a valid puzzle ID;
- `completedAt` is finite;
- `accountId` is null or a non-empty string;
- `syncStatus` is one of the four current values;
- `isRecordPuzzleCompletionV2(request, MAX_COMPLETION_TIME_SECONDS)` passes.

Unknown/corrupt files are removed from the HPA-4 completion directory; no compatibility parser is added. The canonical sealed gameplay session remains independent.

### 9. Retry remains sequential and active-app only

`App.svelte` owns one in-memory drain guard. After session validation, process only pending records owned by the active account, one at a time.

- synced -> mark record synced and continue;
- terminal -> mark record terminal and continue;
- retryable -> keep pending and stop;
- unauthorized -> keep pending, clear invalid account through the session-validation path, and stop.

Triggers remain:

- after sign-in;
- foreground resume;
- connectivity transition from offline to connected.

No background task, daemon, timer, polling loop, push integration, or generic sync framework.

### 10. Native filesystem work stays concrete

Extract only the existing iOS `NSFileManager.replaceItemAt...` helper from `apps/mobile/app/gameplay/sessionFiles.ts` into a tiny native atomic-replace utility. Reuse it for session and completion JSON writes.

Do not add a repository layer. The completion feature owns its one-directory listing/parsing/status updates.

## Native Delivery Gate

Split mobile account implementation into two reviewable commits.

### 3A — pure account/API boundary

Add `playerApi.ts` and `mobileAccount.ts` with tests and **no native imports**. This pins response validators, session false-body handling, restore validation, and logout semantics before plugin/config work.

### 3B — native adapters/UI/config

Add plugin dependencies, secure-storage/Google/native HTTP adapters, Info.plist OAuth values + reversed URL scheme, Library account UI, and `App.svelte` composition. Then prove on the target iPad runtime:

- Google modal completes;
- the ID token exchanges successfully against existing `GOOGLE_CLIENT_ID`;
- bearer `/api/auth/session` returns authenticated true;
- terminate/relaunch restores the secure local account;
- bearer token is absent from Documents and ApplicationSettings.

A red native gate stops HPA-4 before completion persistence/sync work.

## Testing Strategy

### API/shared contracts

Cover:

- mobile exchange uses `GOOGLE_CLIENT_ID`, allowlist, existing player upsert/session creation;
- `isMobilePlayerSessionResponse` rejects malformed user/token/expiry;
- bearer and cookie resolve the same player-session type;
- malformed explicit Authorization never falls back to cookie;
- bearer `/session`, `/logout`, and completion work while web cookie behavior remains green.

### Shared completion failure policy

Pin `completionFailureCodeFromHttpStatus()` and `isFailureRetryable()` for 400, 401, 404, 408, 409, 429, 500, and 503. Update web to call the extracted status mapper so web/mobile cannot drift.

### Mobile pure tests

Cover:

- `PlayerApi.getSession()` parses both authenticated and unauthenticated HTTP-200 bodies with `isPlayerSessionResponse`;
- secure restore requires version/token/future expiry/`isPlayerUser`;
- signed-out completion writes one `local_only` file;
- signed-in completion writes one account-owned `pending` file;
- pending listing filters by account and sorts by `completedAt`, then `runId`;
- corrupt requests fail `isRecordPuzzleCompletionV2` and are removed;
- 429 quota is terminal; 401 is auth-required; 5xx/transport are retryable;
- terminal continues sequential drain; retryable/auth-required stops it;
- session probe false clears the bearer and prevents drain;
- account B never submits or mutates account A's pending record;
- later login never changes anonymous `local_only` work to pending.

## Explicitly Out of Scope

- gameplay-session/cloud-save sync;
- retroactive upload of logged-out completions;
- Firebase/Firebase Auth;
- `GoogleService-Info.plist` unless a future plugin change proves it is actually required;
- Sign in with Apple/provider-neutral identity abstraction;
- mobile profile/upload parity;
- App Store submission/compliance work;
- Android auth/release work;
- background execution, push, daemon, timers, or generic sync/job frameworks;
- D1/KV/Workflow schema changes;
- alternate completion routes;
- redesign of browser Google OAuth.

## Success Criteria

HPA-4 is complete when a personal/TestFlight iPad build can optionally sign in with an allowlisted Google account, keep the existing Perseus player session only in secure storage, record every completion locally before network work, retry only same-account pending completion records through the existing V2 endpoint using the same failure policy as web, clear dead bearers through the existing session probe, and preserve signed-out offline gameplay unchanged.