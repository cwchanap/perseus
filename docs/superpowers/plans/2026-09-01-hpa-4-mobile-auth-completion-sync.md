# HPA-4 Mobile Auth and Account-Bound Completion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional native Google sign-in to the NativeScript iPad app and submit only completions created while that account was active, using the existing Perseus player session, completion endpoint, filesystem seams, native HTTP transport, and retry policy while preserving signed-out offline play.

**Architecture:** Native Google Sign-In exchanges an ID token for the existing opaque KV player session. Bearer and browser cookie credentials share one server resolver. Mobile stores that bearer only in secure storage and writes one `completions/<runId>.json` record per run; `syncStatus: 'pending'` is the queue. `App.svelte` tolerates one non-authoritative `{ authenticated:false }` probe, validates before each drain, and drains on exactly four active-app triggers including the common online-completion path. Existing session file primitives are promoted into one generic mobile storage layer, and the existing native GET adapter becomes the single NativeScript `Http.request` adapter.

**Tech Stack:** TypeScript 5.9, Hono/Cloudflare Workers, Vitest 4, NativeScript 9, Svelte Native 1.0, `@nativescript/google-signin` 2.1.1, `@nativescript/secure-storage` 4.0, existing `@perseus/types` and `@perseus/game-core`.

**Spec:** `docs/superpowers/specs/2026-09-01-hpa-4-mobile-auth-completion-sync-design.md`

## Global Constraints

- One HPA-4 PR only. Continue on `docs/hpa-4-mobile-auth-completion-sync-plan`; do not create another implementation PR.
- Each task/stop gate below is a reviewable green commit inside the same PR.
- Signed-out mobile download/play/resume/completion remains network-independent.
- Reuse existing `GOOGLE_CLIENT_ID` as Google Sign-In `serverClientId` and backend ID-token audience. Do not add another backend audience.
- Do not create Firebase/Firebase Auth or commit `GoogleService-Info.plist`.
- Reuse the existing opaque KV player session and `getPlayerSession()` validation. No mobile JWT/session format or refresh-token system.
- Browser cookie auth remains behaviorally unchanged.
- `GET /api/auth/session` remains HTTP 200 `PlayerSessionResponse`; a single `{ authenticated:false }` is not authoritative enough to delete the mobile credential.
- Existing `POST /api/puzzles/:id/complete` remains the only server completion write route.
- Reuse `completionRequestFromSeal()`, `isFailureRetryable()`, and one shared HTTP-status mapper. Do not add a generic retry framework.
- Every HPA-4 completion record is durable before submission starts.
- Signed-out records are permanently `local_only`; later login never promotes them to pending.
- `accountId` is frozen at completion time. Another account never submits or mutates that record.
- One `Documents/perseus/completions/<runId>.json` file is both local record and queue state. No `outbox/` directory.
- Do not add retry-attempt counters or caps in HPA-4. Unknown 4xx becomes terminal; 5xx/transport remains retryable.
- Bearer tokens may exist only in memory and `@nativescript/secure-storage`, never ordinary JSON or `ApplicationSettings`.
- Drain is sequential and active-app only. No background task, timer, polling loop, daemon, push, or generic sync framework.
- No D1 migration, KV schema change, Workflow change, gameplay-session schema change, or cloud-save work.
- iOS/iPad only. No Android auth/release work.
- Package-local mobile TypeScript is authoritative: `cd apps/mobile && bunx tsc --noEmit`.

## Implementation Baseline

Before Task 1, restore the workspace links so red/green output is not polluted by a missing `workspace:*` package:

```bash
bun install --frozen-lockfile
```

Then record the pre-change focused baselines:

```bash
cd packages/types && bunx vitest run src/index.test.ts
cd ../../apps/api && bunx vitest run src/routes/__tests__/auth.worker.test.ts src/middleware/player-auth.worker.test.ts
cd ../mobile && bunx vitest run
bunx tsc --noEmit
cd ../..
```

If any baseline remains red after `bun install --frozen-lockfile`, document the exact pre-existing failure in PR #76 before changing production code. Do not treat workspace-link noise as a task regression.

## Operator Prerequisite Before Task 3B

Create one Google iOS OAuth client for bundle `org.perseus.mobile` in the same Google Cloud project as the existing Perseus web/server OAuth client. Record:

1. the exact iOS OAuth client ID;
2. its reversed URL scheme (`com.googleusercontent.apps...`);
3. the existing Perseus web/server client ID currently deployed as API `GOOGLE_CLIENT_ID`.

Task 3B writes the iOS/server client IDs to `Info.plist` as `GIDClientID` / `GIDServerClientID`, adds the exact reversed URL scheme, reads those values in the adapter, and calls `GoogleSignin.configure({ clientId, serverClientId })`.

If the live ID token cannot exchange successfully against the existing API `GOOGLE_CLIENT_ID`, stop at the Task 3B gate and fix Google/iOS configuration. Do not add another backend audience.

## Risks and Detection

### R1 — KV consistency produces a false unauthenticated probe

One cross-isolate miss can return `{ authenticated:false }` for a valid new session. Task 3A pins a two-strike state machine: first false retains the credential and records one strike; authenticated success resets it; only a second consecutive false clears. Task 3B exercises exchange -> immediate bearer probe on the target iPad runtime.

### R2 — Google iOS/server-client configuration produces the wrong audience

Task 3B is a hard stop gate. A rejected native token is fixed in Google/iOS configuration, never by adding another backend audience.

### R3 — signed-in online completion is persisted but never submitted

Completion persistence is an explicit fourth drain trigger, not an implied side effect. Task 6 proves a signed-in online completion becomes synced without background/resume/connectivity events.

## Final File Ownership

### Shared/API auth

- Modify `packages/types/src/core.ts` + `packages/types/src/index.test.ts` — `MobilePlayerSessionResponse` plus `isMobilePlayerSessionResponse`.
- Modify `apps/api/src/routes/auth.worker.ts` + existing auth tests — mobile exchange, bearer `/session`, bearer `/logout`, browser regression.
- Modify `apps/api/src/middleware/player-auth.worker.ts` + test — canonical bearer-or-cookie token/session resolver.
- Modify `apps/api/src/middleware/optional-player-auth.worker.ts` — reuse canonical resolver.
- Modify `apps/api/src/routes/puzzles.complete.worker.test.ts` — bearer reaches unchanged completion route.

### Shared completion failure policy

- Modify `packages/game-core/src/session/codec.ts` + `codec.test.ts` — add `completionFailureCodeFromHttpStatus()` beside `isFailureRetryable()`.
- Modify `apps/web/src/routes/puzzle/[id]/+page.svelte` + existing route test — call shared status mapper.

### One mobile HTTP layer

- Rename `apps/mobile/app/api/nativePuzzleHttp.ts` -> `apps/mobile/app/api/nativeHttp.ts` — one NativeScript `Http.request` implementation; export general player transport + existing PuzzleApi GET wrapper.
- Modify `apps/mobile/app/App.svelte` — update import only.
- Keep `apps/mobile/app/api/puzzleApi.ts` unchanged.
- Create `apps/mobile/app/api/playerApi.ts` + `.test.ts` — auth/session/logout/completion contracts over injected transport.

### Mobile account

- Create `apps/mobile/app/account/mobileAccount.ts` + `.test.ts` — pure restore/sign-in/sign-out/two-strike probe policy; no native imports.
- Modify `apps/mobile/package.json`, `bun.lock`, `apps/mobile/App_Resources/iOS/Info.plist` in Task 3B.
- Create `apps/mobile/app/account/nativeGoogleAuth.ts` and `nativeSessionStore.ts`.
- Create `apps/mobile/app/account/AccountBar.svelte`; modify `App.svelte` + `app.css`.

### One mobile filesystem layer

- Rename `apps/mobile/app/gameplay/sessionStore.ts` -> `apps/mobile/app/storage/fileStore.ts`.
- Rename `apps/mobile/app/gameplay/sessionStore.test.ts` -> `apps/mobile/app/storage/fileStore.test.ts`.
- Rename `apps/mobile/app/gameplay/sessionFiles.ts` -> `apps/mobile/app/storage/nativeFileOps.ts`.
- Rename `SessionFileOps` -> `FileOps`, `createFileSessionKeyValueStore` -> `createFileKeyValueStore`, and `createNativeSessionFileOps` -> `createNativeFileOps`.
- Add only `FileOps.list(rootPath): string[]`.
- Modify `App.svelte` imports/session-storage composition.

### Mobile completion

- Create `apps/mobile/app/completion/completionStore.ts` + `.test.ts` — one-directory record validation/listing/status transitions over `FileOps` + `createFileKeyValueStore`.
- Create `apps/mobile/app/completion/completionSync.ts` + `.test.ts` — shared-policy disposition and sequential same-account drain.
- Modify `Gameplay.svelte` — call injected completion sink only after existing completed-session save.
- Modify `App.svelte` — durable record first, four validated drain triggers second.

---

## Task 1: Add the mobile Google exchange and guard its response contract

**Files:**
- Modify: `packages/types/src/core.ts`
- Modify: `packages/types/src/index.test.ts`
- Modify: `apps/api/src/routes/auth.worker.ts`
- Modify: `apps/api/src/routes/__tests__/auth.worker.test.ts`

**Produces:**

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

HTTP:

```text
POST /api/auth/mobile/google
{ "idToken": string }
-> 200 MobilePlayerSessionResponse
```

- [ ] **Step 1: Write the failing shared guard tests**

Add to `packages/types/src/index.test.ts`:

```ts
expect(isMobilePlayerSessionResponse({
  token: 'player-session-token',
  expiresAt: 1_719_092_000_000,
  user: player
})).toBe(true);

expect(isMobilePlayerSessionResponse({ token: '', expiresAt: 123, user: player })).toBe(false);
expect(isMobilePlayerSessionResponse({ token: 'x', expiresAt: Number.NaN, user: player })).toBe(false);
expect(isMobilePlayerSessionResponse({ token: 'x', expiresAt: 123, user: { id: 'partial' } })).toBe(false);
```

- [ ] **Step 2: Write failing route tests**

In `auth.worker.test.ts`, pin:

```ts
expect(sharedAuth.verifyGoogleIdToken).toHaveBeenCalledWith(
  'native-google-id-token',
  'google-client-id'
);
expect(playerAuth.getAllowlistEntry).toHaveBeenCalledWith(kv, 'player@example.com');
expect(playerAuth.upsertPlayer).toHaveBeenCalledWith(kv, claims);
expect(playerAuth.createPlayerSession).toHaveBeenCalledWith(kv, player);
```

Also pin malformed JSON/body -> 400, verifier rejection -> 401, non-allowlisted identity -> 403, and missing `GOOGLE_CLIENT_ID` -> structured 500.

- [ ] **Step 3: Run red exactly**

```bash
cd packages/types && bunx vitest run src/index.test.ts
cd ../../apps/api && bunx vitest run src/routes/__tests__/auth.worker.test.ts
cd ../..
```

Expected: new guard/route cases fail because they do not exist.

- [ ] **Step 4: Implement the minimal shared guard**

Reuse existing private helpers in `core.ts`:

```ts
export function isMobilePlayerSessionResponse(
  value: unknown
): value is MobilePlayerSessionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    isNonEmptyString(response.token) &&
    isFiniteNumber(response.expiresAt) &&
    isPlayerUser(response.user)
  );
}
```

- [ ] **Step 5: Implement the thin route**

Keep `/mobile/google` outside `/google/*`. Parse non-empty `idToken`, verify against `c.env.GOOGLE_CLIENT_ID`, reuse allowlist/upsert/session functions, and return `{ ...session, user }` through `withNoStore()`.

Do not set a cookie. Do not change browser callback behavior. Do not add a new database/KV/session type.

- [ ] **Step 6: Run green and commit**

```bash
cd packages/types && bunx vitest run src/index.test.ts
cd ../../apps/api && bunx vitest run src/routes/__tests__/auth.worker.test.ts
cd ../..

git add packages/types/src/core.ts packages/types/src/index.test.ts \
  apps/api/src/routes/auth.worker.ts apps/api/src/routes/__tests__/auth.worker.test.ts
git commit -m "feat(api): exchange mobile Google identity for player session"
```

---

## Task 2: Make bearer and cookie credentials share one player-session resolver

**Files:**
- Modify: `apps/api/src/middleware/player-auth.worker.ts`
- Modify: `apps/api/src/middleware/player-auth.worker.test.ts`
- Modify: `apps/api/src/middleware/optional-player-auth.worker.ts`
- Modify: `apps/api/src/routes/auth.worker.ts`
- Modify: `apps/api/src/routes/__tests__/auth.worker.test.ts`
- Modify: `apps/api/src/routes/puzzles.complete.worker.test.ts`

**Produces:**

```ts
export function playerSessionTokenFromRequest(c: PlayerAuthContext): string | null;
export async function resolvePlayerSession(c: PlayerAuthContext): Promise<PlayerSessionRecord | null>;
```

Rules:

```text
explicit valid Bearer -> bearer
explicit malformed/other Authorization -> null, never cookie fallback
Authorization absent -> existing player cookie
```

- [ ] **Step 1: Add failing credential-precedence tests**

Pin bearer-over-cookie, malformed-header-no-fallback, cookie-only regression, and invalid bearer -> unauthorized.

- [ ] **Step 2: Run red exactly**

```bash
cd apps/api && bunx vitest run src/middleware/player-auth.worker.test.ts
cd ../..
```

- [ ] **Step 3: Implement the canonical resolver**

```ts
export function playerSessionTokenFromRequest(c: PlayerAuthContext): string | null {
  const authorization = c.req.header('Authorization');
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    return match?.[1] ?? null;
  }
  return getCookie(c, PLAYER_SESSION_COOKIE) ?? null;
}

export async function resolvePlayerSession(
  c: PlayerAuthContext
): Promise<PlayerSessionRecord | null> {
  const token = playerSessionTokenFromRequest(c);
  return token ? getPlayerSession(c.env.PUZZLE_METADATA, token) : null;
}
```

Make `requirePlayerAuth` and `optionalPlayerAuth` delegate to it.

- [ ] **Step 4: Reuse it from `/session` and `/logout`**

Preserve `/session` as a 200 probe:

```ts
const session = await resolvePlayerSession(c);
return withNoStore(c.json(
  session
    ? { authenticated: true, user: session.user }
    : { authenticated: false }
));
```

`/logout` revokes the extracted token if present and still clears the browser cookie. Add bearer + cookie regression cases.

- [ ] **Step 5: Pin bearer parity on the existing completion route**

In `puzzles.complete.worker.test.ts`, send a valid V2 request with:

```ts
headers: {
  Authorization: 'Bearer native-session-token',
  'Content-Type': 'application/json'
}
```

Assert the same `recordVersionedCompletion(...)` inputs/result as cookie-authenticated completion. Do not modify the completion route itself beyond middleware behavior.

- [ ] **Step 6: Run API gate and commit explicit paths**

```bash
cd apps/api && bunx vitest run \
  src/middleware/player-auth.worker.test.ts \
  src/routes/__tests__/auth.worker.test.ts \
  src/routes/puzzles.complete.worker.test.ts
cd ../..

git add apps/api/src/middleware/player-auth.worker.ts \
  apps/api/src/middleware/player-auth.worker.test.ts \
  apps/api/src/middleware/optional-player-auth.worker.ts \
  apps/api/src/routes/auth.worker.ts \
  apps/api/src/routes/__tests__/auth.worker.test.ts \
  apps/api/src/routes/puzzles.complete.worker.test.ts
git commit -m "feat(api): accept player sessions as bearer credentials"
```

---

## Task 3A: Add the pure mobile PlayerApi and account/session policy

**Files:**
- Create: `apps/mobile/app/api/playerApi.ts`
- Create: `apps/mobile/app/api/playerApi.test.ts`
- Create: `apps/mobile/app/account/mobileAccount.ts`
- Create: `apps/mobile/app/account/mobileAccount.test.ts`

**Produces:**

```ts
export interface PlayerHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PlayerHttpResponse {
  status: number;
  body: unknown;
}

export type PlayerHttpTransport = (
  request: PlayerHttpRequest
) => Promise<PlayerHttpResponse>;

export interface PlayerApi {
  exchangeGoogleIdToken(idToken: string): Promise<MobilePlayerSessionResponse>;
  getSession(token: string): Promise<PlayerSessionResponse>;
  logout(token: string): Promise<void>;
  submitCompletion(
    puzzleId: string,
    request: RecordPuzzleCompletionV2,
    token: string
  ): Promise<PlayerHttpResponse>;
}
```

```ts
export interface PersistedMobileSession {
  version: 1;
  token: string;
  expiresAt: number;
  user: PlayerUser;
  consecutiveUnauthenticated: 0 | 1;
}

export interface GoogleIdTokenProvider {
  signIn(): Promise<string>;
  signOut(): Promise<void>;
}

export interface MobileSessionStore {
  read(): string | null;
  write(raw: string): void;
  clear(): void;
}

export type SessionProbeDecision =
  | { kind: 'authenticated'; session: PersistedMobileSession }
  | { kind: 'uncertain'; session: PersistedMobileSession }
  | { kind: 'cleared' };
```

- [ ] **Step 1: Write failing PlayerApi tests**

Pin exact exchange/session/logout/completion paths and bearer headers. `exchangeGoogleIdToken()` accepts only 2xx bodies passing `isMobilePlayerSessionResponse`.

`getSession()` must accept both valid HTTP-200 shapes via `isPlayerSessionResponse`:

```ts
expect(await api.getSession('token')).toEqual({ authenticated: false });
expect(await api.getSession('token')).toEqual({ authenticated: true, user: player });
```

`submitCompletion()` returns `{ status, body }`; only transport failure rejects.

- [ ] **Step 2: Write failing restore/two-strike tests**

Pin valid restore:

```ts
expect(restoreMobileAccount(JSON.stringify({
  version: 1,
  token: 'player-token',
  expiresAt: now + 60_000,
  user: player,
  consecutiveUnauthenticated: 0
}), now)?.user).toEqual(player);
```

Reject malformed JSON, wrong version, empty token, expired/non-finite expiry, invalid `PlayerUser`, and counter values other than `0 | 1`.

Pin probe policy:

```ts
expect(applySessionProbe(saved0, { authenticated: false })).toEqual({
  kind: 'uncertain',
  session: { ...saved0, consecutiveUnauthenticated: 1 }
});

expect(applySessionProbe(saved1, { authenticated: false })).toEqual({ kind: 'cleared' });

expect(applySessionProbe(saved1, { authenticated: true, user: refreshed })).toEqual({
  kind: 'authenticated',
  session: { ...saved1, user: refreshed, consecutiveUnauthenticated: 0 }
});
```

Pin sign-in initializes the counter to `0` and sign-out clears local secure state even if remote logout/Google sign-out fails.

- [ ] **Step 3: Run red exactly**

```bash
cd apps/mobile && bunx vitest run \
  app/api/playerApi.test.ts \
  app/account/mobileAccount.test.ts
cd ../..
```

Expected: only these new test files run and fail because modules do not exist.

- [ ] **Step 4: Implement PlayerApi validation**

- normalize `baseUrl` once;
- exchange: POST JSON, require 2xx + `isMobilePlayerSessionResponse`;
- session: GET bearer, require 2xx + `isPlayerSessionResponse` including authenticated false;
- logout: POST bearer, require 2xx;
- completion: POST V2 bearer and return raw `{ status, body }` for Task 5.

Do not import NativeScript in this file.

- [ ] **Step 5: Implement pure account functions**

`restoreMobileAccount(raw, now)` fully validates current V1 and returns null for anything invalid/expired.

`signInMobileAccount()` obtains Google ID token through the injected provider, exchanges it, writes:

```ts
{
  version: 1,
  token: response.token,
  expiresAt: response.expiresAt,
  user: response.user,
  consecutiveUnauthenticated: 0
}
```

`applySessionProbe()` implements the exact state table from Step 2; it does not do I/O.

`signOutMobileAccount()` attempts remote logout + Google sign-out but clears the injected secure store in a `finally` path.

- [ ] **Step 6: Run green and commit**

```bash
cd apps/mobile && bunx vitest run \
  app/api/playerApi.test.ts \
  app/account/mobileAccount.test.ts
bunx tsc --noEmit
cd ../..

git add apps/mobile/app/api/playerApi.ts apps/mobile/app/api/playerApi.test.ts \
  apps/mobile/app/account/mobileAccount.ts apps/mobile/app/account/mobileAccount.test.ts
git commit -m "feat(mobile): define player account boundary"
```

---

## Task 3B: Add one native HTTP adapter, Google/secure adapters, and the iPad auth gate

**Files:**
- Rename: `apps/mobile/app/api/nativePuzzleHttp.ts` -> `apps/mobile/app/api/nativeHttp.ts`
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Create: `apps/mobile/app/account/nativeGoogleAuth.ts`
- Create: `apps/mobile/app/account/nativeSessionStore.ts`
- Create: `apps/mobile/app/account/AccountBar.svelte`
- Modify: `apps/mobile/app/app.css`

**Produces:**

```ts
export const nativePlayerHttpTransport: PlayerHttpTransport;
export const nativePuzzleJsonRequest: PuzzleJsonRequest;
export const nativeGoogleIdTokenProvider: GoogleIdTokenProvider;
export const nativeMobileSessionStore: MobileSessionStore;
```

- [ ] **Step 1: Add the two native dependencies**

```bash
cd apps/mobile
bun add @nativescript/google-signin@^2.1.1 @nativescript/secure-storage@^4.0.2
cd ../..
```

Expected: `apps/mobile/package.json` + root `bun.lock` change; no Firebase dependency.

- [ ] **Step 2: Replace the GET-only native HTTP module with one general adapter**

Move `nativePuzzleHttp.ts` to `nativeHttp.ts` and make it the only `Http.request` owner:

```ts
export const nativePlayerHttpTransport: PlayerHttpTransport = async (request) => {
  const response = await Http.request({
    url: request.url,
    method: request.method,
    headers: request.headers,
    content: request.body === undefined ? undefined : JSON.stringify(request.body)
  });

  let body: unknown = null;
  if (response.content) {
    try {
      body = response.content.toJSON();
    } catch {
      body = response.content.toString();
    }
  }

  return { status: response.statusCode, body };
};

export const nativePuzzleJsonRequest: PuzzleJsonRequest = async (url) => {
  const response = await nativePlayerHttpTransport({ method: 'GET', url });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`puzzle_api_http_${response.status}`);
  }
  if (response.body === null) throw new Error('puzzle_api_empty_response');
  return response.body;
};
```

`puzzleApi.ts` stays unchanged. Update only the import in `App.svelte`.

- [ ] **Step 3: Add native secure-storage adapter**

Use one key `perseus_player_session_v1` with `SecureStorage.getSync/setSync/removeSync`. The adapter stores raw JSON only; validation remains in `mobileAccount.ts`. Do not enable `useLessSecureStorage`.

- [ ] **Step 4: Add explicit Google configuration**

Read `GIDClientID` and `GIDServerClientID` from the main iOS bundle; reject missing/empty values. Configure exactly once:

```ts
await GoogleSignin.configure({
  clientId: iosClientId,
  serverClientId
});
```

Then `signIn()` + `getTokens()` must return a non-empty ID token. `signOut()` delegates to Google Sign-In.

- [ ] **Step 5: Configure Info.plist from the operator prerequisite**

Add:

- `GIDClientID` = exact registered `org.perseus.mobile` iOS OAuth client ID;
- `GIDServerClientID` = exact existing Perseus web/server OAuth client ID used by API `GOOGLE_CLIENT_ID`;
- one `CFBundleURLTypes` scheme = exact reversed iOS client ID.

Do not add `GoogleService-Info.plist`.

- [ ] **Step 6: Add minimal AccountBar + App.svelte composition**

`AccountBar.svelte` props:

```ts
export let session: PersistedMobileSession | null;
export let busy: boolean;
export let status: 'idle' | 'reconnecting';
export let error: string | null;
export let onSignIn: () => void;
export let onSignOut: () => void;
```

`App.svelte` restores secure JSON through `restoreMobileAccount`, owns `accountSession`, composes `PlayerApi` with `nativePlayerHttpTransport`, and implements sign-in/sign-out. Do not add completion drain yet.

- [ ] **Step 7: Run automated mobile gate**

```bash
cd apps/mobile
bunx vitest run
bunx tsc --noEmit
cd ../..
```

- [ ] **Step 8: Run the native iPad auth stop gate**

Against a Worker using the same existing `GOOGLE_CLIENT_ID`, record:

```text
Google native modal completes
Google ID token is non-empty
POST /api/auth/mobile/google -> 200 for allowlisted account
GET /api/auth/session with Bearer -> authenticated true
terminate/relaunch restores the secure local account
Documents/perseus contains no bearer token
ApplicationSettings contains no bearer token
```

If the native ID token is rejected, stop Task 3B and fix Google configuration. Do not change API audience logic.

- [ ] **Step 9: Commit only after the native gate is green**

```bash
git add -A apps/mobile/app/api/nativePuzzleHttp.ts apps/mobile/app/api/nativeHttp.ts \
  apps/mobile/package.json bun.lock apps/mobile/App_Resources/iOS/Info.plist \
  apps/mobile/app/account/nativeGoogleAuth.ts apps/mobile/app/account/nativeSessionStore.ts \
  apps/mobile/app/account/AccountBar.svelte apps/mobile/app/App.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add secure native Google account"
```

---

## Task 4A: Promote the existing session file code into one generic mobile storage layer

**Files:**
- Rename: `apps/mobile/app/gameplay/sessionStore.ts` -> `apps/mobile/app/storage/fileStore.ts`
- Rename: `apps/mobile/app/gameplay/sessionStore.test.ts` -> `apps/mobile/app/storage/fileStore.test.ts`
- Rename: `apps/mobile/app/gameplay/sessionFiles.ts` -> `apps/mobile/app/storage/nativeFileOps.ts`
- Modify: `apps/mobile/app/App.svelte`

**Produces:**

```ts
export interface FileOps {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  replace(fromPath: string, toPath: string): void;
  remove(path: string): void;
  list(rootPath: string): string[];
}

export function createFileKeyValueStore(options: {
  rootPath: string;
  fileOps: FileOps;
}): SessionKeyValueStore;

export function createNativeFileOps(): FileOps;
```

- [ ] **Step 1: Move/rename mechanically before changing behavior**

Rename the modules/types/functions and update `App.svelte` imports. Preserve current `getItem/setItem/removeItem` behavior exactly.

- [ ] **Step 2: Run the moved tests before adding list**

```bash
cd apps/mobile && bunx vitest run app/storage/fileStore.test.ts
cd ../..
```

Expected: existing missing-file and temp-write -> replace tests stay green after the mechanical move.

- [ ] **Step 3: Add failing list test**

Extend the in-memory fake and pin direct names only:

```ts
expect(fileOps.list('/completions')).toEqual([
  'run-a.json',
  'run-b.json'
]);
```

Nested directories and files from other roots must not appear.

- [ ] **Step 4: Implement NativeScript listing in the existing native adapter**

Use the already-shipped NativeScript pattern:

```ts
list(rootPath) {
  if (!Folder.exists(rootPath)) return [];
  return (Folder.fromPath(rootPath).getEntitiesSync() ?? [])
    .filter((entity) => File.exists(entity.path))
    .map((entity) => entity.path.slice(entity.path.lastIndexOf('/') + 1));
}
```

Keep existing `NSFileManager.replaceItemAt...` implementation in this same module; do not extract another primitive.

- [ ] **Step 5: Run storage + mobile gates and commit**

```bash
cd apps/mobile
bunx vitest run app/storage/fileStore.test.ts
bunx tsc --noEmit
cd ../..

git add -A apps/mobile/app/storage apps/mobile/app/gameplay/sessionStore.ts \
  apps/mobile/app/gameplay/sessionStore.test.ts apps/mobile/app/gameplay/sessionFiles.ts \
  apps/mobile/app/App.svelte
git commit -m "refactor(mobile): promote shared file storage primitives"
```

---

## Task 4B: Add one-file durable completion history/queue over the promoted file layer

**Files:**
- Create: `apps/mobile/app/completion/completionStore.ts`
- Create: `apps/mobile/app/completion/completionStore.test.ts`

**Produces:**

```ts
export type CompletionSyncStatus = 'local_only' | 'pending' | 'synced' | 'terminal';

export interface MobileCompletionRecordV1 {
  version: 1;
  runId: string;
  puzzleId: string;
  completedAt: number;
  accountId: string | null;
  request: RecordPuzzleCompletionV2;
  syncStatus: CompletionSyncStatus;
}

export interface CompletionStore {
  recordCompletion(input: {
    puzzleId: string;
    seal: SealedCompletion;
    accountId: string | null;
  }): MobileCompletionRecordV1;
  listPendingForAccount(accountId: string): MobileCompletionRecordV1[];
  markSynced(runId: string): void;
  markTerminal(runId: string): void;
}
```

- [ ] **Step 1: Write failing signed-out/signed-in persistence tests**

Signed out:

```ts
const record = store.recordCompletion({ puzzleId, seal, accountId: null });
expect(record.syncStatus).toBe('local_only');
expect(store.listPendingForAccount('account-a')).toEqual([]);
```

Signed in:

```ts
const record = store.recordCompletion({ puzzleId, seal, accountId: 'account-a' });
expect(record.syncStatus).toBe('pending');
expect(store.listPendingForAccount('account-a')).toEqual([record]);
```

Pin `request === completionRequestFromSeal(seal)` and `completedAt === seal.completedAt`.

- [ ] **Step 2: Pin current-format validation**

Add cases rejecting/removing records when:

- `version !== 1`;
- `runId !== request.runId`;
- `puzzleId` fails `isPuzzleId`;
- `request` fails `isRecordPuzzleCompletionV2(..., MAX_COMPLETION_TIME_SECONDS)`;
- `accountId` is invalid;
- status is unknown.

There is no compatibility branch.

- [ ] **Step 3: Pin account filtering, order, and status updates**

Create A/B records out of order. Assert A listing sorts `completedAt`, then `runId`, and never returns B or `local_only/synced/terminal` records.

```ts
store.markSynced(runId);
expect(readRecord(runId)?.syncStatus).toBe('synced');

store.markTerminal(otherRunId);
expect(readRecord(otherRunId)?.syncStatus).toBe('terminal');
```

- [ ] **Step 4: Run red exactly**

```bash
cd apps/mobile && bunx vitest run app/completion/completionStore.test.ts
cd ../..
```

- [ ] **Step 5: Implement over `createFileKeyValueStore`**

Create one file KV store rooted at `Documents/perseus/completions` (the caller supplies `rootPath` + `FileOps`). `recordCompletion()` serializes one validated V1 record through `setItem(runId, JSON.stringify(record))`.

`listPendingForAccount()` uses `fileOps.list(rootPath)`, accepts direct `*.json` names, derives `runId`, reads via the same file KV store, validates, removes corrupt current-format files, filters by owner/status, then sorts.

Do not add a second native file module, index file, database, or outbox directory.

- [ ] **Step 6: Run green and commit**

```bash
cd apps/mobile
bunx vitest run app/storage/fileStore.test.ts app/completion/completionStore.test.ts
bunx tsc --noEmit
cd ../..

git add apps/mobile/app/completion/completionStore.ts apps/mobile/app/completion/completionStore.test.ts
git commit -m "feat(mobile): persist account-bound completion records"
```

---

## Task 5: Share completion failure mapping and drain pending records on four explicit triggers

**Files:**
- Modify: `packages/game-core/src/session/codec.ts`
- Modify: `packages/game-core/src/session/codec.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Create: `apps/mobile/app/completion/completionSync.ts`
- Create: `apps/mobile/app/completion/completionSync.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/App.svelte`

**Produces:**

```ts
export function completionFailureCodeFromHttpStatus(
  status: number
): CompletionFailureCode;

export type SubmissionDisposition =
  | 'synced'
  | 'retryable'
  | 'auth_required'
  | 'terminal';

export async function drainPendingCompletions(args: {
  activeSession: PersistedMobileSession;
  api: PlayerApi;
  store: CompletionStore;
}): Promise<SubmissionDisposition | 'empty'>;
```

Gameplay prop:

```ts
export let onCompletion: (puzzleId: string, seal: SealedCompletion) => void;
```

- [ ] **Step 1: Write failing shared HTTP mapping tests**

Pin:

```ts
expect(completionFailureCodeFromHttpStatus(400)).toBe('bad_request');
expect(completionFailureCodeFromHttpStatus(401)).toBe('unauthorized');
expect(completionFailureCodeFromHttpStatus(403)).toBe('bad_request');
expect(completionFailureCodeFromHttpStatus(404)).toBe('not_found');
expect(completionFailureCodeFromHttpStatus(408)).toBe('network_error');
expect(completionFailureCodeFromHttpStatus(409)).toBe('run_id_conflict');
expect(completionFailureCodeFromHttpStatus(429)).toBe('completion_quota_exceeded');
expect(completionFailureCodeFromHttpStatus(500)).toBe('internal_error');
expect(completionFailureCodeFromHttpStatus(503)).toBe('internal_error');
```

Also assert retryability through existing `isFailureRetryable()`: 401/408/5xx retryable, 400/403/404/409/429 terminal.

- [ ] **Step 2: Run shared red**

```bash
cd packages/game-core && bunx vitest run src/session/codec.test.ts
cd ../..
```

- [ ] **Step 3: Implement the shared mapper and migrate web**

```ts
export function completionFailureCodeFromHttpStatus(status: number): CompletionFailureCode {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 404: return 'not_found';
    case 408: return 'network_error';
    case 409: return 'run_id_conflict';
    case 429: return 'completion_quota_exceeded';
    default:
      if (status >= 400 && status < 500) return 'bad_request';
      return 'internal_error';
  }
}
```

In web's `mapCompletionError`, delete the local status switch:

```ts
const code = err instanceof ApiError
  ? completionFailureCodeFromHttpStatus(err.status)
  : 'network_error';
return { code, retryable: isFailureRetryable(code) };
```

Run existing web route tests and pin 429 remains terminal.

- [ ] **Step 4: Write failing mobile drain tests**

Pin:

- 200/replay success -> `markSynced`, continue;
- 429 body `{ error: 'completion_quota_exceeded' }` -> terminal + `markTerminal`, continue;
- 409 -> terminal, continue;
- unknown 403 -> terminal, continue;
- 500/503 -> retryable, keep pending, stop;
- transport rejection -> retryable, keep pending, stop;
- 401 -> auth_required, keep pending, stop;
- account B never submits account A;
- calls are strictly sequential.

- [ ] **Step 5: Implement the mobile drain with the shared policy**

For each `store.listPendingForAccount(activeSession.user.id)` record:

```ts
try {
  const response = await api.submitCompletion(
    record.puzzleId,
    record.request,
    activeSession.token
  );

  if (response.status >= 200 && response.status < 300) {
    store.markSynced(record.runId);
    continue;
  }

  const code = completionFailureCodeFromHttpStatus(response.status);
  if (code === 'unauthorized') return 'auth_required';
  if (isFailureRetryable(code)) return 'retryable';

  store.markTerminal(record.runId);
} catch {
  return 'retryable';
}
```

Return `synced` after processing at least one successful/terminal item, or `empty` if there was nothing for the account.

- [ ] **Step 6: Wire Gameplay completion only after the existing local session save**

Preserve exact ordering:

```ts
} else if (event.type === 'completion_sealed') {
  saveCurrentSnapshot();
  completionSeal = event.seal;
  onCompletion(spec.puzzleId, event.seal);
}
```

Gameplay never receives account/session/API/storage details.

- [ ] **Step 7: Add one validated drain path in `App.svelte`**

Implement `validateAndDrain()`:

1. return if no `accountSession`;
2. clear immediately if local `expiresAt <= Date.now()`;
3. call `playerApi.getSession(token)`;
4. pass the valid response through `applySessionProbe()`;
5. `authenticated`: persist returned session, update `accountSession`, run guarded drain;
6. `uncertain`: persist strike-1 session, keep account, show reconnecting state, skip drain;
7. `cleared`: clear secure/in-memory account, skip drain;
8. transport/5xx from the probe: keep account/counter and skip this pass.

If a completion POST returns `auth_required`, feed `{ authenticated:false }` through the same `applySessionProbe()` policy once; do not directly delete the bearer on a single 401.

- [ ] **Step 8: Add exactly four drain triggers**

Call `validateAndDrain()`:

1. after successful sign-in;
2. immediately after `completionStore.recordCompletion(...)` writes a signed-in `pending` record;
3. on `Application.resumeEvent`;
4. when `Connectivity.startMonitoring()` observes offline -> connected.

Completion handler:

```ts
function onGameplayCompletion(puzzleId: string, seal: SealedCompletion): void {
  const accountId = accountSession?.user.id ?? null;
  const record = completionStore.recordCompletion({ puzzleId, seal, accountId });
  if (record.syncStatus === 'pending') void validateAndDrainGuarded();
}
```

If completion persistence throws, surface/log local sync-record failure and do not POST that run.

Use one in-memory promise guard so overlapping triggers share one pass. Stop connectivity monitoring and remove application listeners during teardown. No timer.

- [ ] **Step 9: Run focused green gates and commit**

```bash
cd packages/game-core && bunx vitest run src/session/codec.test.ts
cd ../../apps/web && bunx vitest run src/routes/puzzle/'[id]'/page.svelte.test.ts
cd ../mobile && bunx vitest run app/completion/completionSync.test.ts app/account/mobileAccount.test.ts
bunx tsc --noEmit
cd ../..

git add packages/game-core/src/session/codec.ts packages/game-core/src/session/codec.test.ts \
  apps/web/src/routes/puzzle/'[id]'/+page.svelte apps/web/src/routes/puzzle/'[id]'/page.svelte.test.ts \
  apps/mobile/app/completion/completionSync.ts apps/mobile/app/completion/completionSync.test.ts \
  apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/App.svelte
git commit -m "feat(mobile): sync validated same-account completions"
```

---

## Task 6: Prove account/offline boundaries and run the single-PR final gate

**Files:**
- No planned production files. Fix only defects found by this acceptance pass on the same HPA-4 branch.

**Produces:** recorded native acceptance evidence in PR #76; no second PR.

- [ ] **Step 1: Run full automated gates**

```bash
bun install --frozen-lockfile
bun run --cwd packages/types test:unit
bun run --cwd packages/game-core test:unit
bun run --cwd apps/api test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../..
bun run check
bun run lint
```

Every failing command must be fixed or recorded as an exact pre-existing unrelated blocker; do not claim a clean gate from partial output.

- [ ] **Step 2: Prove signed-out completion never becomes future upload work**

1. Sign out.
2. Disable networking.
3. Complete a downloaded puzzle.
4. Inspect `Documents/perseus/completions/<runId>.json`: `accountId: null`, `syncStatus: local_only`.
5. Restore network and sign in.
6. Confirm the record remains `local_only` and no completion POST for that run occurs.

- [ ] **Step 3: Prove the common signed-in online path drains immediately**

1. Sign in as allowlisted account A with network available.
2. Complete a downloaded puzzle.
3. Confirm the completion file is first written `pending`.
4. Without backgrounding, reconnecting, or signing in again, confirm the same file becomes `synced` and the API receives the V2 request once.

This is the acceptance test for the fourth completion-written trigger.

- [ ] **Step 4: Prove signed-in offline -> reconnect**

1. Stay signed in as A.
2. Disable networking.
3. Complete another puzzle; confirm account A + `pending`.
4. Restore connectivity.
5. Confirm reconnect triggers validation then submission and the record becomes `synced`.

- [ ] **Step 5: Prove account ownership across account switching**

1. Create a pending record as A while offline.
2. Sign out and sign in as account B.
3. Restore network/trigger validation.
4. Confirm A's record stays pending and no A run ID is POSTed under B.
5. Sign back in as A and confirm the record drains idempotently.

- [ ] **Step 6: Prove one unauthenticated probe does not delete the credential**

Using the pure test seam or a controlled Worker test fixture:

1. Start with valid secure session counter `0`.
2. Return one valid HTTP-200 `{ authenticated:false }` probe.
3. Confirm secure session remains with counter `1`, account UI remains signed in/reconnecting, and no drain runs.
4. Return authenticated true on the next trigger.
5. Confirm counter resets to `0` and pending drain resumes.
6. Separately prove two consecutive false probes clear the credential.

- [ ] **Step 7: Prove credential storage boundary**

After sign-in and terminate/relaunch:

- secure account restores;
- no bearer token appears in `Documents/perseus`;
- no bearer token appears in `ApplicationSettings`;
- logout clears secure credential without deleting downloads, gameplay sessions, or completion records.

- [ ] **Step 8: Final scope/reuse sweep**

```bash
rg -n "GoogleService-Info|Firebase|outbox/|nativeAtomicReplace|nativeCompletionFiles|setInterval\(|background task|refresh token" \
  apps/mobile apps/api packages/game-core docs/superpowers/specs/2026-09-01-hpa-4-mobile-auth-completion-sync-design.md \
  docs/superpowers/plans/2026-09-01-hpa-4-mobile-auth-completion-sync.md

rg -n "Http\.request" apps/mobile/app/api
rg -n "createNativeSessionFileOps|createFileSessionKeyValueStore|SessionFileOps" apps/mobile/app
```

Expected final production shape:

- no Firebase/plist/outbox/duplicate native file modules/background/timer/refresh-token work;
- one `Http.request` owner in `app/api/nativeHttp.ts`;
- old session-specific file-op names are gone after their mechanical promotion;
- HPA-4 remains one PR.

- [ ] **Step 9: Record acceptance evidence in PR #76**

Update the PR body/checklist with actual command results and native evidence. Keep the PR draft if any required stop gate remains red.