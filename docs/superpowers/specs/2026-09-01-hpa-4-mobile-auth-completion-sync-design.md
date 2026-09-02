# HPA-4 Optional Mobile Google Sign-In and Account-Bound Completion Sync Design

**Date:** 2026-09-01  
**Linear:** HPA-4 — [Perseus Mobile] Add optional Google sign-in and account-bound completion sync  
**Depends on:** HPA-3 (Done)  
**Independent of:** HPA-46 portrait/adaptive tablet UX (Done)

## Goal

Add the smallest optional account layer needed for mobile completion submission without weakening offline-first gameplay: native Google sign-in, the existing Perseus opaque player session carried as a bearer credential, one durable local completion record per run, and active-app retry for completions created while that account was already signed in.

Signed-out download, play, resume, and completion remain fully local. Signing in adds completion submission only; it does not create cloud saves or make gameplay depend on the network.

## Current Baseline

The repository already owns almost all semantics HPA-4 needs:

- `apps/api/src/services/player-auth.shared.ts` verifies Google ID tokens against `GOOGLE_CLIENT_ID`.
- `apps/api/src/services/player-auth.worker.ts` owns the allowlist, player upsert, opaque player-session creation, validation, revocation, and its isolate-local grace cache.
- `apps/api/src/routes/auth.worker.ts` creates that player session for browser Google OAuth and exposes `GET /api/auth/session` as a `200 PlayerSessionResponse` probe.
- `apps/api/src/middleware/player-auth.worker.ts` and `optional-player-auth.worker.ts` currently read only the browser cookie.
- `apps/api/src/routes/puzzles.complete.worker.ts` already owns the V2 completion write and immutable `runId` replay/conflict behavior.
- `packages/game-core/src/session/codec.ts` already owns completion failure retryability through `isFailureRetryable()`.
- `packages/game-core` already exposes `completionRequestFromSeal(seal)`.
- mobile `Gameplay.svelte` already saves the completed session snapshot immediately when `completion_sealed` fires.
- `apps/mobile/app/gameplay/sessionStore.ts` + `sessionFiles.ts` already form a generic JSON-by-ID filesystem layer with temp-write + atomic replacement; only directory listing is missing.
- `apps/mobile/app/api/nativePuzzleHttp.ts` already owns the single NativeScript `Http.request` call site.
- `apps/mobile/app/App.svelte` is already the composition root for mobile storage, API clients, Library, and Gameplay.

HPA-4 extends these seams rather than creating another account, retry, HTTP, filesystem, or synchronization system.

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
- the existing Perseus web/server OAuth client ID as Google Sign-In `serverClientId`.

`@nativescript/google-signin` 2.1.1 accepts explicit `clientId` + `serverClientId`, so HPA-4 does not create a Firebase project or add `GoogleService-Info.plist`.

Store the two non-secret client IDs in `Info.plist` as `GIDClientID` and `GIDServerClientID`. The native adapter reads them and calls:

```ts
await GoogleSignin.configure({
  clientId: iosClientId,
  serverClientId
});
```

If the native gate produces an ID token the existing API rejects, fix Google configuration and stop. Do not add a second backend audience.

### 3. One canonical bearer-or-cookie player-session resolver

Move credential extraction behind one function in `apps/api/src/middleware/player-auth.worker.ts`:

- valid explicit `Authorization: Bearer <token>` -> bearer token;
- any other explicit `Authorization` value -> authentication failure, with no cookie fallback;
- no Authorization header -> existing `perseus_player_session` cookie.

Both forms call the existing `getPlayerSession()` and produce the same `PlayerSessionRecord`.

Reuse this resolver from:

- `requirePlayerAuth`;
- `optionalPlayerAuth`;
- `GET /api/auth/session`;
- `POST /api/auth/logout`.

Keep `GET /api/auth/session` behavior unchanged: invalid or temporarily unseen sessions return HTTP 200 `{ authenticated: false }`. Do not change web to a 401 contract.

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
  consecutiveUnauthenticated: 0 | 1;
}
```

Restore accepts only:

- `version === 1`;
- non-empty token;
- finite future `expiresAt`;
- `isPlayerUser(user)`;
- `consecutiveUnauthenticated` equal to `0` or `1`.

Invalid/expired secure data is cleared. There is no compatibility parser.

The bearer token exists only in memory and `@nativescript/secure-storage`; never under `Documents/perseus` or `ApplicationSettings`.

Library UI remains one small account strip: sign in, signed-in identity, sign out, and transient error/reconnecting text. No global account store, profile route, or provider abstraction.

The existing server session lifetime remains 30 days with no refresh path. When it expires, mobile signs in again; any pending completion stays bound to its original account until that same account signs in again.

### 5. A single negative `/session` probe is not authoritative

`auth.worker.ts` deliberately does not clear the browser cookie when `getPlayerSession()` misses KV, because a newly created session can be temporarily invisible on another Worker isolate. Mobile must preserve the same tolerance.

Before any drain trigger:

1. if there is no active local session, do nothing;
2. if local `expiresAt <= now`, clear it immediately without a request;
3. call `GET /api/auth/session` with the bearer;
4. `{ authenticated: true }` -> reset `consecutiveUnauthenticated` to `0`, refresh cached `PlayerUser`, then drain;
5. first valid `{ authenticated: false }` -> persist `consecutiveUnauthenticated: 1`, keep the account credential/label, skip this drain pass;
6. second consecutive valid `{ authenticated: false }` from a later trigger -> clear secure + in-memory account state and do not drain;
7. transport failure or server `5xx` -> retain the credential and current counter, skip this pass.

Any successful authenticated probe resets the counter. Logout still clears immediately because it is an explicit user action.

This avoids random sign-outs from one KV consistency miss without allowing a dead bearer to retry forever.

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

There is no second outbox directory or duplicate request file. Drain lists `completions/`, validates records, filters `syncStatus === 'pending' && accountId === activeSession.user.id`, and sorts by `completedAt` then `runId`.

Do **not** add `attempts` or retry-exhaustion state in HPA-4. A fixed cap would convert a temporary API outage into permanent data loss after enough foreground events. This pre-1.0 project has no compatibility obligation, so the record can be replaced later if real usage proves retry metadata is needed.

### 7. Reuse the shipped completion-failure policy

Extract the current web status -> `CompletionFailureCode` mapping into `packages/game-core/src/session/codec.ts` beside `isFailureRetryable()`:

```ts
export function completionFailureCodeFromHttpStatus(
  status: number
): CompletionFailureCode;
```

Both web and mobile call it.

Required mapping:

| Wire | Failure code / disposition |
| --- | --- |
| 2xx | synced |
| 401 | `unauthorized` -> auth-required; stop pass |
| 400 | `bad_request` -> terminal |
| 404 | `not_found` -> terminal |
| 409 | `run_id_conflict` -> terminal |
| 429 | `completion_quota_exceeded` -> terminal |
| 408 | `network_error` -> retryable; stop pass |
| other 4xx | `bad_request` -> terminal |
| 5xx | `internal_error` -> retryable; stop pass |
| transport rejection | `network_error` -> retryable; stop pass |
| other unexpected non-2xx | `internal_error` -> retryable; stop pass |

`isFailureRetryable()` remains the single retryability policy. In particular, 429 is the server's completion quota terminal, not a generic rate limit.

Unknown 4xx is deliberately terminal so a configuration/client error cannot become permanent foreground retry work. Server/transport failures stay retryable because they may recover.

### 8. Completion file parsing reuses shared validators

A completion file is accepted only when the outer record is valid and:

- `runId` is valid and equals `request.runId`;
- `puzzleId` is a valid puzzle ID;
- `completedAt` is finite;
- `accountId` is null or a non-empty string;
- `syncStatus` is one of the four current values;
- `isRecordPuzzleCompletionV2(request, MAX_COMPLETION_TIME_SECONDS)` passes.

Unknown/corrupt current-format files are removed from the HPA-4 completion directory; no compatibility parser is added. The canonical sealed gameplay session remains independent.

### 9. Four explicit active-app drain triggers

`App.svelte` owns one in-memory drain guard. Every trigger first uses the session-validation policy above; only an authenticated probe may drain.

Triggers are exactly:

1. after successful sign-in;
2. immediately after a signed-in completion record is durably written;
3. foreground resume;
4. connectivity transition from offline to connected.

After validation, process only pending records owned by the active account, one at a time.

- synced -> mark record synced and continue;
- terminal -> mark record terminal and continue;
- retryable -> keep pending and stop;
- unauthorized -> keep pending, feed one unauthenticated signal through the same two-strike account policy, and stop.

No background task, daemon, timer, polling loop, push integration, or generic sync framework.

### 10. Promote the existing mobile file layer instead of duplicating it

The current `gameplay/sessionStore.ts` and `gameplay/sessionFiles.ts` are generic despite their names. HPA-4 promotes them mechanically into `app/storage/`:

```ts
interface FileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(fromPath: string, toPath: string): void;
  remove(path: string): void;
  list(rootPath: string): string[];
}

createFileKeyValueStore({ rootPath, fileOps }): SessionKeyValueStore
createNativeFileOps(): FileOps
```

`createFileKeyValueStore()` preserves the existing `<root>/<id>.json.tmp` -> atomic replace behavior used by session storage. The new `list()` is the only extra native capability HPA-4 needs.

Completion persistence receives `{ rootPath, fileOps }` and owns only record parsing/filtering/status transitions. It does not create another native file adapter.

Delete the old session-specific filenames after imports/tests move. Do not create `nativeAtomicReplace.ts` or `nativeCompletionFiles.ts`.

### 11. One NativeScript HTTP adapter

Replace the GET-only native transport with one general NativeScript JSON transport:

```ts
interface PlayerHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface PlayerHttpResponse {
  status: number;
  body: unknown;
}
```

`nativeHttp.ts` is the only module that calls `Http.request`.

It exports:

- the general `PlayerHttpTransport` used by `PlayerApi`;
- `nativePuzzleJsonRequest`, a thin GET wrapper that preserves existing PuzzleApi behavior by throwing on non-2xx and returning only the response body.

`puzzleApi.ts` remains unchanged apart from its import site in `App.svelte` moving from `nativePuzzleHttp.ts` to `nativeHttp.ts`.

## Native Delivery Gate

Split mobile account implementation into two reviewable commits.

### 3A — pure account/API boundary

Add `playerApi.ts` and `mobileAccount.ts` with tests and no native imports. This pins shared validators, the two-strike unauthenticated policy, restore validation, and logout semantics before plugin/config work.

### 3B — native adapters/UI/config

Add plugin dependencies, the shared native HTTP adapter, secure-storage/Google adapters, Info.plist OAuth values + reversed URL scheme, Library account UI, and `App.svelte` composition. Then prove on the target iPad runtime:

- Google modal completes;
- the ID token exchanges successfully against existing `GOOGLE_CLIENT_ID`;
- bearer `/api/auth/session` returns authenticated true;
- terminate/relaunch restores the secure local account;
- bearer token is absent from Documents and ApplicationSettings.

A red native gate stops HPA-4 before completion persistence/sync work.

## Risks and Detection

### R1 — KV consistency produces false unauthenticated probes

**Risk:** one cross-isolate KV miss can return `{ authenticated: false }` for a valid new session.

**Mitigation/detection:** two consecutive negative probes are required before credential deletion; authenticated success resets the counter. Task 3A unit tests pin the state machine, and Task 3B's native gate exercises exchange -> immediate bearer probe.

### R2 — Google iOS/server-client configuration produces the wrong audience

**Risk:** the plugin may return an ID token the existing backend rejects if client/server client configuration is wrong.

**Mitigation/detection:** Task 3B is a hard stop gate. Fix Google/iOS configuration; never add a second backend audience.

### R3 — online completion is persisted but never submitted

**Risk:** lifecycle-only retry triggers leave the common signed-in/online completion pending until a later resume/reconnect.

**Mitigation/detection:** durable signed-in completion is an explicit fourth drain trigger. Task 6 includes an online-completion acceptance case requiring `pending -> synced` without any app lifecycle event.

## Testing Strategy

### API/shared contracts

Cover:

- mobile exchange uses `GOOGLE_CLIENT_ID`, allowlist, existing player upsert/session creation;
- `isMobilePlayerSessionResponse` rejects malformed user/token/expiry;
- bearer and cookie resolve the same player-session type;
- malformed explicit Authorization never falls back to cookie;
- bearer `/session`, `/logout`, and completion work while web cookie behavior remains green.

### Shared completion failure policy

Pin `completionFailureCodeFromHttpStatus()` and `isFailureRetryable()` for 400, 401, 403, 404, 408, 409, 429, 500, and 503. Update web to call the extracted status mapper so web/mobile cannot drift.

### Mobile pure tests

Cover:

- `PlayerApi.getSession()` parses both authenticated and unauthenticated HTTP-200 bodies with `isPlayerSessionResponse`;
- secure restore requires version/token/future expiry/`isPlayerUser`/valid negative-probe counter;
- first unauthenticated probe increments the counter and retains the credential;
- authenticated success resets the counter;
- second consecutive unauthenticated probe clears the credential;
- signed-out completion writes one `local_only` file;
- signed-in completion writes one account-owned `pending` file;
- pending listing filters by account and sorts by `completedAt`, then `runId`;
- corrupt requests fail `isRecordPuzzleCompletionV2` and are removed;
- 429 quota and unknown 4xx are terminal; 401 is auth-required; 5xx/transport are retryable;
- terminal continues sequential drain; retryable/auth-required stops it;
- account B never submits or mutates account A's pending record;
- later login never changes anonymous `local_only` work to pending;
- generic file-store tests preserve existing temp-write/replace semantics and cover direct listing;
- PuzzleApi's GET wrapper retains current non-2xx/empty-response behavior over the shared native transport.

### Native iPad acceptance

Before merge, prove:

1. allowlisted Google sign-in exchanges and survives terminate/relaunch from secure storage;
2. signed-out offline completion remains `local_only` after later sign-in;
3. signed-in online completion becomes `synced` without background/resume/reconnect;
4. signed-in offline completion stays `pending`, then reconnect submits it;
5. pending account A work is skipped under account B and later drains under A;
6. one simulated first unauthenticated session probe does not delete the secure credential; a later authenticated probe resets the counter.

## Explicitly Out of Scope

- gameplay-session/cloud-save sync;
- retroactive upload of logged-out completions;
- Firebase/Firebase Auth;
- `GoogleService-Info.plist`;
- Sign in with Apple/provider-neutral identity abstraction;
- mobile profile/upload parity;
- App Store submission/compliance work;
- Android auth/release work;
- background execution, push, daemon, timers, polling, or generic sync/job frameworks;
- retry-attempt caps/telemetry until actual usage demonstrates a need;
- D1/KV/Workflow schema changes;
- alternate completion routes;
- redesign of browser Google OAuth.

## Review Resolution: 2026-09-02 Reuse/Retry Review

Accepted after verification:

- tolerate one `{ authenticated:false }` because Worker KV lookup is explicitly non-authoritative on one cross-isolate miss;
- add completion-written as the fourth drain trigger and acceptance-test the signed-in/online path;
- promote the existing generic session file code into one `app/storage/` layer with only `list()` added;
- replace the GET-only native HTTP adapter with one general `Http.request` adapter and keep PuzzleApi as a wrapper;
- fix focused Vitest commands, add workspace installation before baseline gates, use explicit git-add paths, and carry named risks.

Not accepted:

- `attempts` / five-attempt terminal cap. A retry cap can permanently discard a valid run during a temporary server outage. This pre-release project does not need to preserve current completion-file schema compatibility, so retry metadata can be added later if actual usage justifies it. Unknown 4xx is terminal now; 5xx/transport remains retryable.

## Success Criteria

HPA-4 is complete when a personal/TestFlight iPad build can optionally sign in with an allowlisted Google account, keep the existing Perseus player session only in secure storage, tolerate one non-authoritative KV miss, record every completion locally before network work, submit signed-in online completions immediately, retry only same-account pending records through the existing V2 endpoint using the same failure policy as web, and preserve signed-out offline gameplay unchanged.