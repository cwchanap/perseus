# HPA-4 Optional Mobile Google Sign-In and Account-Bound Completion Sync Design

**Date:** 2026-09-01  
**Linear:** HPA-4 — [Perseus Mobile] Add optional Google sign-in and account-bound completion sync  
**Depends on:** HPA-3 (Done)  
**Independent of:** HPA-46 portrait/adaptive tablet UX (Done)

## Goal

Add the smallest optional account layer needed for mobile completion submission without weakening the offline-first product: native Google sign-in, one existing Perseus player session carried as a mobile bearer credential, durable local completion records, and an account-owned retry outbox.

A signed-out player must continue to download, play, resume, and complete puzzles entirely offline. Signing in adds only completion submission; it does not create cloud saves or make gameplay depend on the network.

## Current Baseline

The repository already owns almost all server-side semantics HPA-4 needs:

- `apps/api/src/services/player-auth.shared.ts` verifies Google ID tokens, including issuer, signature, expiry, verified email, and audience.
- `apps/api/src/services/player-auth.worker.ts` owns the allowlist, player upsert, opaque player-session creation, validation, and revocation in KV.
- `apps/api/src/routes/auth.worker.ts` uses those services for browser Google OAuth and stores the opaque session token in `perseus_player_session`.
- `apps/api/src/middleware/player-auth.worker.ts` validates that same session for protected routes, but currently reads only the browser cookie.
- `apps/api/src/routes/puzzles.complete.worker.ts` already accepts the current versioned completion request and records it idempotently by immutable `runId`.
- `packages/game-core` already exposes `completionRequestFromSeal(seal)`; mobile `Gameplay.svelte` already receives the immutable `completion_sealed` event and saves the completed session snapshot immediately.
- `apps/mobile/app/App.svelte` is already the composition root for the mobile filesystem, API client, download store, session storage, and Library/Gameplay navigation.

HPA-4 should join these seams rather than inventing a second account or completion system.

## Approaches Considered

### Option A — Native Google ID token -> existing Perseus session (selected)

Use `@nativescript/google-signin` on iOS to acquire a Google ID token. Configure Google Sign-In with the existing backend/web OAuth client ID as the **server client ID**, so the ID token audience remains the existing `GOOGLE_CLIENT_ID` already validated by `verifyGoogleIdToken()`.

POST that ID token to one new mobile auth route. The route reuses the current allowlist, player upsert, and `createPlayerSession()` functions, then returns the same opaque Perseus session token to mobile. Protected API routes accept that token as `Authorization: Bearer ...` through the same session validator used by the browser cookie.

This adds one transport difference, not a second auth model.

### Option B — Launch the existing browser OAuth flow and deep-link back into mobile

Rejected. It would add browser/deep-link/cookie transfer ceremony while still needing mobile credential storage. It also fails the ticket's native Google sign-in intent.

### Option C — Mint a separate mobile JWT/session type

Rejected. It would duplicate expiration, revocation, allowlist, player lookup, tests, and protected-route logic that the existing opaque KV player session already provides.

## Selected Architecture

### 1. Mobile Google exchange is a thin auth route

Add:

```text
POST /api/auth/mobile/google
Content-Type: application/json

{ "idToken": "..." }
```

Success returns a small shared response:

```ts
export interface MobilePlayerSessionResponse {
  token: string;
  expiresAt: number;
  user: PlayerUser;
}
```

Route behavior:

1. Parse a non-empty `idToken`.
2. Call `verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID)`.
3. Check the existing player allowlist.
4. Call `upsertPlayer()`.
5. Call `createPlayerSession()`.
6. Return `{ token, expiresAt, user }` with `Cache-Control: no-store`.

The route uses the existing OAuth rate-limit middleware. Invalid Google identity is `401`; a valid but non-allowlisted identity is `403`; missing server Google configuration remains a structured `500`.

There is no new database table, KV prefix, JWT format, refresh token, or mobile-specific server session.

### 2. Reuse the existing Google server audience

The iOS app requires its own Google iOS OAuth client for bundle ID `org.perseus.mobile` and its reversed URL scheme. For backend authentication, configure the Google iOS SDK's server client ID to the existing Perseus web/server OAuth client ID.

Google documents `serverClientID` / `GIDServerClientID` as the value returned in the ID token's `aud` claim. Therefore the backend continues verifying against the existing `GOOGLE_CLIENT_ID`; HPA-4 does **not** add a second server audience variable or infrastructure binding.

This is an operator prerequisite for the native implementation: create the iOS OAuth client in the same Google Cloud project and supply its client configuration to the NativeScript iOS app. The server/web client ID already deployed for Perseus remains authoritative for backend ID-token verification.

### 3. One player-session resolver accepts bearer or cookie

Move credential extraction behind one narrow function in `apps/api/src/middleware/player-auth.worker.ts`:

- if an `Authorization` header is present, it must be exactly a non-empty `Bearer <token>` credential;
- if no `Authorization` header is present, fall back to `perseus_player_session`;
- never silently fall back to the browser cookie when a malformed/unsupported Authorization header was explicitly supplied.

Both credential forms call the existing `getPlayerSession()` and set the same `playerSession` context variable.

Use this resolver for:

- `requirePlayerAuth` (therefore the existing completion route gains bearer support automatically);
- `GET /api/auth/session`, so mobile can validate a stored bearer session while web keeps its cookie behavior;
- `POST /api/auth/logout`, so mobile can revoke the same server session while the existing cookie logout remains unchanged.

Do not add `/api/mobile/complete` or any alternate completion route.

### 4. Mobile account state stays at the composition root

Add only a small account strip to the Library surface:

- signed out: **SIGN IN WITH GOOGLE**;
- signed in: display the existing `PlayerUser` name/email plus **SIGN OUT**;
- transient sign-in/logout error copy may appear in that same surface.

`App.svelte` owns the current in-memory account session and passes concrete callbacks/state to the account component. Do not add a global store, account router, profile screen, or provider abstraction.

Native adapters remain narrow:

```ts
interface GoogleIdTokenProvider {
  signIn(): Promise<string>;
  signOut(): Promise<void>;
}

interface MobileSessionStore {
  read(): PersistedMobileSession | null;
  write(session: PersistedMobileSession): void;
  clear(): void;
}
```

`@nativescript/google-signin` is the Google adapter. `@nativescript/secure-storage` is the secure-session adapter.

The secure record contains only what mobile needs offline:

```ts
interface PersistedMobileSession {
  version: 1;
  token: string;
  expiresAt: number;
  user: PlayerUser;
}
```

Use one fixed secure-storage key such as `perseus_player_session_v1`. Never write the bearer token under `Documents/perseus`, `ApplicationSettings`, session JSON, completion JSON, or outbox JSON.

On app boot, an unexpired secure record is sufficient to restore the account label immediately. When online, `GET /api/auth/session` may validate it; `401`/unauthenticated clears the secure record. Expired local records are cleared without a request.

Logout is local-first from the user's perspective: attempt server revocation and Google sign-out, but always clear the Perseus secure credential. Logout must not delete downloads, puzzle sessions, completions, or outbox records.

### 5. Completion persistence is explicit and local-first

A completed mobile session is already saved immediately in `Gameplay.svelte`. HPA-4 keeps that ordering and adds an injected completion callback **after** `saveCurrentSnapshot()`.

Project the immutable seal once with `completionRequestFromSeal(seal)` and write a durable completion record:

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

The `accountId` is captured from the active Perseus account at the instant of completion. It never changes later.

- signed out at completion -> `accountId: null`, `local_only`, no outbox, no upload now or after a later login;
- signed in at completion -> record `pending`, create the same-account outbox item, then attempt the existing completion API.

Writing the outbox before the network request deliberately closes the app-termination gap between “we intended to sync” and “we learned the request failed.” A successful immediate request removes the outbox in the same flow.

### 6. The outbox is a tiny filesystem queue, not a sync framework

Store one immutable request per run:

```ts
interface CompletionOutboxItemV1 {
  version: 1;
  runId: string;
  puzzleId: string;
  accountId: string;
  createdAt: number;
  request: RecordPuzzleCompletionV2;
}
```

Path:

```text
Documents/perseus/outbox/<runId>.json
```

Drain rules:

1. Load items and sort by `createdAt`, then `runId` for deterministic ties.
2. Process sequentially; no concurrency/worker pool.
3. Skip every item whose `accountId !== activeSession.user.id`.
4. Submit to the existing `POST /api/puzzles/:id/complete` with the active bearer token.
5. `2xx`: mark the completion `synced`, remove the outbox item, continue.
6. Transport failure, HTTP `408`, `429`, or `5xx`: keep `pending`, stop this drain pass.
7. HTTP `401`: keep the item `pending`, stop; a later re-login to the **same account** may resume it.
8. Other `4xx`: mark the completion `terminal`, remove the outbox item, continue.

`runId` makes replay safe on the server, so retry does not need a client-generated idempotency key.

Do not rewrite an outbox item's account owner after sign-in. Do not scan local-only completions to manufacture outbox items.

### 7. Retry only while the app is active

`App.svelte` owns one `drainOutbox()` call site and a small in-memory “drain already running” guard.

Trigger a drain when:

- an account successfully signs in;
- the app enters/resumes the foreground while an account is active and connectivity is available;
- NativeScript `Connectivity.startMonitoring()` reports a transition from no connection to a connected state.

Stop connectivity monitoring on unmount. There is no background task, daemon, timer loop, push notification, or generic synchronization scheduler.

### 8. Native filesystem code stays concrete

HPA-4 needs atomic JSON writes plus outbox directory listing. Reuse the existing iOS atomic-replace implementation rather than creating a repository framework.

Extract only the existing `NSFileManager.replaceItemAt...` helper into a tiny mobile-local storage utility that both `sessionFiles.ts` and the new completion file adapter can call. Keep completion parsing, listing, and status updates in the completion feature; do not generalize the session store into a new persistence abstraction.

Unknown/corrupt HPA-4 completion/outbox JSON has no compatibility obligation in this pre-release app. A corrupt outbox file is removed and not submitted; its unrelated session/download files remain untouched.

## Native Dependencies and Configuration

Use the current NativeScript plugins directly:

- `@nativescript/google-signin` `^2.1.1` for native Google Sign-In and ID-token retrieval;
- `@nativescript/secure-storage` `^4.0.2` for iOS Keychain-backed Perseus session storage.

The iOS Google configuration must include:

- the iOS OAuth client for `org.perseus.mobile`;
- the matching reversed-client-ID URL scheme;
- the existing Perseus backend/web OAuth client as `GIDServerClientID` / plugin `serverClientId`.

Do not enable the secure-storage `useLessSecureStorage` fallback. If secure storage cannot work in the target simulator/device build, HPA-4 stops at the native auth gate rather than putting the Perseus bearer token in `NSUserDefaults`/`ApplicationSettings`.

## Error and UX Policy

- Google cancellation/denial: remain signed out; show small account-area error/cancel feedback only.
- Invalid Google token / non-allowlisted account: remain signed out; never persist a Perseus token.
- Mobile session validation failure: clear the secure Perseus credential; retain all local content/outbox.
- Completion persistence failure: completion UI still reflects the engine's sealed local session; surface/log a local persistence failure, but do not attempt network submission without the durable HPA-4 local record/outbox.
- Immediate completion submission failure: never block the completion sheet; leave the item pending according to the classification above.
- Account switch: old-account outbox stays on disk but is skipped.
- Logout with no network: local sign-out still completes; server expiry/revocation handles the remote session later.

## Testing Strategy

### API

Focused Worker tests cover:

- mobile exchange rejects missing/malformed ID token;
- existing Google verifier is called with `GOOGLE_CLIENT_ID`;
- non-allowlisted identity is rejected;
- allowlisted identity reuses upsert + current player-session creation;
- bearer auth resolves the same `PlayerSessionRecord` as cookie auth;
- malformed explicit Authorization does not fall back to cookie;
- bearer completion reaches the unchanged completion route;
- existing web cookie auth/session/logout behavior remains green.

### Mobile unit tests

Pure/mobile-local tests cover:

- secure-store parsing, expiry, write, and clear boundaries without importing the native plugin in unit tests;
- signed-out completion creates only `local_only` completion data;
- signed-in completion creates account-owned `pending` + outbox before submit;
- `2xx`, retryable, `401`, and terminal outcomes update/delete the correct files;
- account B never submits account A's outbox;
- drain is sequential and stops on retryable/auth-required outcomes;
- later sign-in never turns an anonymous completion into an outbox item;
- logout clears only secure credentials.

### Native iPad stop/acceptance gates

Before the completion-sync wiring depends on it, prove on the real target runtime:

1. Google sign-in returns a non-empty ID token whose backend exchange succeeds for an allowlisted account.
2. The returned Perseus session survives terminate/relaunch from secure storage.
3. No bearer token exists under `Documents/perseus` or `ApplicationSettings`.
4. Signed-out offline completion creates only a local completion record.
5. Signed-in offline completion creates a same-account outbox item without blocking completion UI.
6. Restoring connectivity drains it and removes the outbox item.
7. Creating a pending item as account A, then signing in as account B, does not submit/remove A's item.
8. Signing back in as account A drains the item idempotently.

## Explicitly Out of Scope

- gameplay-session/cloud-save sync;
- uploading anonymous/logged-out historical completions after login;
- Sign in with Apple or a provider-neutral identity layer;
- mobile profile/upload parity;
- App Store submission/compliance work;
- background execution, push, daemon, timer-based polling, or a generic sync/job framework;
- new D1 tables, KV session types, refresh-token systems, or alternate completion routes;
- Android release/configuration work;
- redesigning the existing web Google OAuth flow.

## Success Criteria

HPA-4 is complete when a personal/TestFlight iPad build can optionally sign in with an allowlisted Google account, keep its Perseus session in iOS secure storage, submit only completions that were created while that account was already active, survive offline/relaunch with a same-account durable outbox, and later retry those requests through the existing idempotent completion endpoint without changing signed-out gameplay or web cookie authentication.