# HPA-4 Mobile Auth and Account-Bound Completion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional native Google sign-in to the NativeScript iPad app and submit only completions created while that account was active, using the existing Perseus player session, completion endpoint, and retry policy while preserving signed-out offline play.

**Architecture:** Native Google Sign-In exchanges an ID token for the existing opaque KV player session. Bearer and browser cookie credentials share one server resolver. Mobile stores that bearer only in secure storage and writes one `completions/<runId>.json` record per run; `syncStatus: 'pending'` is the queue, so there is no second outbox directory. `App.svelte` validates the bearer through the existing `GET /api/auth/session` probe before each active-app drain, and web/mobile share the same completion HTTP-status -> failure-code -> retryability policy.

**Tech Stack:** TypeScript 5.9, Hono/Cloudflare Workers, Vitest 4, NativeScript 9, Svelte Native 1.0, `@nativescript/google-signin` 2.1.1, `@nativescript/secure-storage` 4.0, existing `@perseus/types` and `@perseus/game-core`.

**Spec:** `docs/superpowers/specs/2026-09-01-hpa-4-mobile-auth-completion-sync-design.md`

## Global Constraints

- One HPA-4 PR only. Continue on `docs/hpa-4-mobile-auth-completion-sync-plan`; do not create another implementation PR.
- Each task/stop gate below is a reviewable green commit inside the same PR.
- Signed-out mobile download/play/resume/completion remains network-independent.
- Reuse the existing `GOOGLE_CLIENT_ID` as Google Sign-In's server client ID and backend ID-token audience. Do not add a second backend audience.
- Do not create Firebase/Firebase Auth or commit `GoogleService-Info.plist`; plugin 2.1.1 accepts explicit `clientId` + `serverClientId`.
- Reuse the existing opaque KV player session and `getPlayerSession()` validation. No mobile JWT/session format or refresh-token system.
- Browser cookie auth remains behaviorally unchanged.
- `GET /api/auth/session` remains HTTP 200 with `PlayerSessionResponse`, including `{ authenticated: false }` for an invalid/expired session.
- The existing `POST /api/puzzles/:id/complete` remains the only server completion write route.
- Reuse `completionRequestFromSeal()` and the existing completion failure policy; do not invent a generic HTTP retry classifier.
- Every HPA-4 completion record is durable before network submission starts.
- Signed-out completion records are permanently `local_only`; later login never promotes them to pending.
- `accountId` is frozen at completion time. Another account never submits or mutates that record.
- One `Documents/perseus/completions/<runId>.json` file is both local record and queue state. No `outbox/` directory.
- Bearer tokens may exist only in memory and `@nativescript/secure-storage`, never ordinary JSON or `ApplicationSettings`.
- Draining is sequential and active-app only: sign-in, foreground resume, connectivity restoration. No background task, timer, polling loop, daemon, push, or generic sync framework.
- No D1 migration, KV schema change, Workflow change, gameplay-session schema change, or cloud-save work.
- iOS/iPad only. No Android auth/release work.
- Package-local mobile TypeScript is authoritative: `cd apps/mobile && bunx tsc --noEmit`.

## Operator Prerequisite Before Task 3B

Before native configuration work begins, create an iOS OAuth client for bundle `org.perseus.mobile` in the same Google Cloud project as the existing Perseus web/server OAuth client. Record:

1. the exact iOS OAuth client ID;
2. its exact reversed URL scheme;
3. the existing Perseus web/server client ID used as API `GOOGLE_CLIENT_ID`.

Task 3B writes the first and third values to `Info.plist` as `GIDClientID` / `GIDServerClientID`, adds the reversed URL scheme, then reads those Info.plist values and passes both explicitly to `GoogleSignin.configure({ clientId, serverClientId })`.

If the ID token cannot exchange successfully against the existing API `GOOGLE_CLIENT_ID`, stop at the Task 3B gate and fix Google configuration. Do not add another backend audience.

## Final File Ownership

### Shared/API auth

- Modify `packages/types/src/core.ts` + `packages/types/src/index.test.ts` — `MobilePlayerSessionResponse` plus `isMobilePlayerSessionResponse`.
- Modify `apps/api/src/routes/auth.worker.ts` + existing auth tests — mobile exchange, bearer `/session`, bearer `/logout`, browser regression.
- Modify `apps/api/src/middleware/player-auth.worker.ts` + test — canonical bearer-or-cookie token/session resolver.
- Modify `apps/api/src/middleware/optional-player-auth.worker.ts` — reuse canonical resolver.
- Modify the existing completion Worker route test — bearer reaches the unchanged completion route.

### Shared completion failure policy

- Modify `packages/game-core/src/session/codec.ts` + `codec.test.ts` — extract `completionFailureCodeFromHttpStatus()` beside `isFailureRetryable()`.
- Modify `apps/web/src/routes/puzzle/[id]/+page.svelte` + existing route test — use the shared status mapper; preserve current behavior including terminal quota 429.

### Mobile account

- Create `apps/mobile/app/api/playerApi.ts` + `.test.ts` — auth/session/logout/completion contract over injected transport.
- Create `apps/mobile/app/account/mobileAccount.ts` + `.test.ts` — pure restore/sign-in/sign-out validation; no native imports.
- Modify `apps/mobile/package.json`, `bun.lock`, `apps/mobile/App_Resources/iOS/Info.plist` — native dependencies/config only in Task 3B.
- Create `apps/mobile/app/api/nativePlayerHttp.ts` — NativeScript HTTP adapter.
- Create `apps/mobile/app/account/nativeGoogleAuth.ts` — explicit client/server client configuration, sign-in/token/sign-out.
- Create `apps/mobile/app/account/nativeSessionStore.ts` — one secure-storage key.
- Create `apps/mobile/app/account/AccountBar.svelte`; modify `App.svelte` + `app.css` — minimal account UI/composition.

### Mobile completion

- Create `apps/mobile/app/storage/nativeAtomicReplace.ts`; modify `gameplay/sessionFiles.ts` — extract/reuse the existing iOS atomic replacement primitive.
- Create `apps/mobile/app/completion/completionStore.ts` + `.test.ts` — one-directory record validation/listing/status transitions.
- Create `apps/mobile/app/completion/nativeCompletionFiles.ts` — `Documents/perseus/completions` mechanics only.
- Create `apps/mobile/app/completion/completionSync.ts` + `.test.ts` — shared-policy disposition and sequential same-account drain.
- Modify `Gameplay.svelte` — call injected completion sink only after its existing completed-session save.
- Modify `App.svelte` — durable record first, validated-session drain triggers second.

---

## Task 1: Add the native Google ID-token exchange and validate its response contract

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

- [ ] **Step 1: Add failing shared validator tests**

Pin valid response plus malformed token/expiry/user cases:

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

- [ ] **Step 2: Add failing mobile-exchange route tests**

Extend the existing auth Worker test harness. Pin:

- success calls `verifyGoogleIdToken(idToken, GOOGLE_CLIENT_ID)`;
- success calls existing allowlist/upsert/session functions;
- response is no-store and matches the new response type;
- malformed body -> 400;
- verifier rejection -> 401;
- valid non-allowlisted identity -> 403;
- missing `GOOGLE_CLIENT_ID` -> structured 500.

Keep the route outside `/google/*` so it does not require `GOOGLE_CLIENT_SECRET` / `AUTH_REDIRECT_BASE_URL`.

- [ ] **Step 3: Run red**

```bash
bun run --cwd packages/types test:unit
bun run --cwd apps/api test:unit -- src/routes/__tests__/auth.worker.test.ts
```

Expected: new guard/route tests fail.

- [ ] **Step 4: Implement the minimal guard and route**

In `core.ts`, reuse existing `isNonEmptyString`, `isFiniteNumber`, and `isPlayerUser`:

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

The route parses `idToken`, verifies against `c.env.GOOGLE_CLIENT_ID`, reuses `getAllowlistEntry`, `upsertPlayer`, and `createPlayerSession`, and returns `{ ...session, user }`. Do not set a cookie and do not change browser callback behavior.

- [ ] **Step 5: Run focused gates and commit**

```bash
bun run --cwd packages/types test:unit
bun run --cwd apps/api test:unit -- src/routes/__tests__/auth.worker.test.ts

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
- Modify: existing Worker completion-route test for `POST /api/puzzles/:id/complete`

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

- [ ] **Step 1: Add failing precedence tests**

Pin bearer-over-cookie, malformed-header-no-fallback, cookie-only regression, invalid bearer -> unauthorized.

- [ ] **Step 2: Run red**

```bash
bun run --cwd apps/api test:unit -- src/middleware/player-auth.worker.test.ts
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

`requirePlayerAuth` and `optionalPlayerAuth` both delegate to it.

- [ ] **Step 4: Reuse extraction/resolution from `/session` and `/logout`**

Preserve `/session` exactly as a 200 probe:

```ts
const session = await resolvePlayerSession(c);
return withNoStore(c.json(
  session
    ? { authenticated: true, user: session.user }
    : { authenticated: false }
));
```

`/logout` revokes the extracted token if present and still clears the browser cookie. Add bearer + cookie regression tests.

- [ ] **Step 5: Pin bearer parity on the existing completion route**

Send an authenticated completion using `Authorization: Bearer native-session-token` and assert the same `recordVersionedCompletion` arguments/result as cookie auth. Do not change `puzzles.complete.worker.ts` beyond middleware behavior.

- [ ] **Step 6: Run API gate and commit**

```bash
bun run --cwd apps/api test:unit

git add apps/api/src/middleware/player-auth.worker.ts \
  apps/api/src/middleware/player-auth.worker.test.ts \
  apps/api/src/middleware/optional-player-auth.worker.ts \
  apps/api/src/routes/auth.worker.ts \
  apps/api/src/routes/__tests__/auth.worker.test.ts \
  apps/api/src/routes
git diff --cached --name-only
git commit -m "feat(api): accept player sessions as bearer credentials"
```

Before commit, confirm the broad routes add contains only the intended completion test change.

---

## Task 3A: Add the pure mobile PlayerApi and account/session validation

**Files:**
- Create: `apps/mobile/app/api/playerApi.ts`
- Create: `apps/mobile/app/api/playerApi.test.ts`
- Create: `apps/mobile/app/account/mobileAccount.ts`
- Create: `apps/mobile/app/account/mobileAccount.test.ts`

**Interfaces:**

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
```

- [ ] **Step 1: Write failing PlayerApi tests**

Pin exact URLs and bearer headers. `exchangeGoogleIdToken()` accepts only a 2xx body passing `isMobilePlayerSessionResponse`.

`getSession()` must accept both valid HTTP-200 shapes:

```ts
expect(await api.getSession('token')).toEqual({ authenticated: false });
expect(await api.getSession('token')).toEqual({ authenticated: true, user: player });
```

Both are parsed with `isPlayerSessionResponse`; `{ authenticated: false }` is not an exception.

`submitCompletion()` returns `{ status, body }` for the existing endpoint; transport errors reject.

- [ ] **Step 2: Write failing account restore/sign-out tests**

Pin restore validity:

```ts
const restored = restoreMobileAccount(JSON.stringify({
  version: 1,
  token: 'player-token',
  expiresAt: now + 60_000,
  user: player
}), now);
expect(restored?.user).toEqual(player);
```

Reject/clear:

- wrong version;
- empty token;
- expired/non-finite expiry;
- partial/invalid user failing `isPlayerUser`;
- malformed JSON.

Pin local-first sign-out: secure credential clears even if API logout or Google sign-out fails.

- [ ] **Step 3: Run red**

```bash
bun run --cwd apps/mobile test:unit -- \
  app/api/playerApi.test.ts \
  app/account/mobileAccount.test.ts
```

- [ ] **Step 4: Implement the pure modules only**

No `@nativescript/*` imports in this task.

`restoreMobileAccount(raw, now)` uses `isPlayerUser` and returns null on any invalid current-format record. `signInMobileAccount()` persists only after Google exchange returns a guarded `MobilePlayerSessionResponse`.

- [ ] **Step 5: Run mobile pure gate and commit**

```bash
bun run --cwd apps/mobile test:unit -- \
  app/api/playerApi.test.ts \
  app/account/mobileAccount.test.ts
cd apps/mobile && bunx tsc --noEmit
cd ../..

git add apps/mobile/app/api/playerApi.ts apps/mobile/app/api/playerApi.test.ts \
  apps/mobile/app/account/mobileAccount.ts apps/mobile/app/account/mobileAccount.test.ts
git commit -m "feat(mobile): define validated player account boundary"
```

---

## Task 3B: Add native Google/secure-storage adapters and pass the iPad auth gate

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Create: `apps/mobile/app/api/nativePlayerHttp.ts`
- Create: `apps/mobile/app/account/nativeGoogleAuth.ts`
- Create: `apps/mobile/app/account/nativeSessionStore.ts`
- Create: `apps/mobile/app/account/AccountBar.svelte`
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`

- [ ] **Step 1: Add only the two native dependencies**

```bash
cd apps/mobile
bun add @nativescript/google-signin@^2.1.1 @nativescript/secure-storage@^4.0.2
```

No Firebase package and no `GoogleService-Info.plist`.

- [ ] **Step 2: Add exact iOS OAuth values to Info.plist**

Using the operator-prerequisite values, add:

- `GIDClientID` = exact `org.perseus.mobile` iOS OAuth client ID;
- `GIDServerClientID` = exact existing Perseus API `GOOGLE_CLIENT_ID`;
- `CFBundleURLTypes` containing the exact reversed iOS client URL scheme.

Do not commit example/bracket values. Verify the built plist contains the registered values before the native gate.

- [ ] **Step 3: Implement the native Google adapter with explicit configuration**

Read the two Info.plist strings via `NSBundle.mainBundle.objectForInfoDictionaryKey` and configure once:

```ts
await GoogleSignin.configure({
  clientId: readInfoString('GIDClientID'),
  serverClientId: readInfoString('GIDServerClientID')
});
```

Then `signIn()` + `getTokens()` must return a non-empty ID token. `signOut()` delegates to the plugin. Do not load a Google service plist.

- [ ] **Step 4: Implement native secure-storage + HTTP adapters**

Use one secure key:

```ts
const PLAYER_SESSION_KEY = 'perseus_player_session_v1';
```

The adapter stores raw current-format JSON only. Validation stays in `mobileAccount.ts`. Do not enable `useLessSecureStorage`.

`nativePlayerHttp.ts` converts NativeScript `Http.request` to the pure `PlayerHttpResponse` contract only.

- [ ] **Step 5: Add minimal account UI and compose it in App.svelte**

`AccountBar.svelte` gets only current session/busy/error and sign-in/sign-out callbacks. No profile navigation or global store.

Boot may show a valid unexpired secure account immediately. Online validity is confirmed through `PlayerApi.getSession()` before any completion drain is allowed; Task 5 owns that common validation/drain path.

- [ ] **Step 6: Run automated mobile gates**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

- [ ] **Step 7: Run the native auth stop gate before completion work**

On the target iPad simulator/device, prove all of:

```text
Google native modal completes
Google getTokens returns a non-empty ID token
POST /api/auth/mobile/google returns 200 for an allowlisted account
GET /api/auth/session with Bearer returns authenticated:true for the same PlayerUser
terminate/relaunch restores the account from secure storage
Documents/perseus contains no bearer token
ApplicationSettings contains no bearer token
```

The successful backend exchange is the audience gate. If it fails because `aud` is not the existing `GOOGLE_CLIENT_ID`, fix iOS/server client configuration and repeat; do not change backend verification.

- [ ] **Step 8: Commit only after the native gate is green**

```bash
git add apps/mobile/package.json bun.lock \
  apps/mobile/App_Resources/iOS/Info.plist \
  apps/mobile/app/api/nativePlayerHttp.ts \
  apps/mobile/app/account/nativeGoogleAuth.ts \
  apps/mobile/app/account/nativeSessionStore.ts \
  apps/mobile/app/account/AccountBar.svelte \
  apps/mobile/app/App.svelte apps/mobile/app/app.css
git commit -m "feat(mobile): add secure native Google account"
```

---

## Task 4: Persist one validated completion record per run

**Files:**
- Create: `apps/mobile/app/storage/nativeAtomicReplace.ts`
- Modify: `apps/mobile/app/gameplay/sessionFiles.ts`
- Create: `apps/mobile/app/completion/completionStore.ts`
- Create: `apps/mobile/app/completion/completionStore.test.ts`
- Create: `apps/mobile/app/completion/nativeCompletionFiles.ts`

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
```

```ts
recordCompletion(input): MobileCompletionRecordV1;
listPendingForAccount(accountId: string): MobileCompletionRecordV1[];
markSynced(runId: string): void;
markTerminal(runId: string): void;
```

- [ ] **Step 1: Write failing signed-out/signed-in tests**

Signed out creates exactly one file and never becomes pending:

```ts
const record = store.recordCompletion({ puzzleId, seal, accountId: null });
expect(record.syncStatus).toBe('local_only');
expect(record.accountId).toBeNull();
expect(store.listPendingForAccount('account-a')).toEqual([]);
```

Signed in creates the same single record as pending:

```ts
const record = store.recordCompletion({ puzzleId, seal, accountId: 'account-a' });
expect(record.syncStatus).toBe('pending');
expect(record.request).toEqual(completionRequestFromSeal(seal));
expect(store.listPendingForAccount('account-a').map((x) => x.runId)).toEqual([seal.runId]);
```

Pin account filtering and `completedAt`, then `runId` sort.

- [ ] **Step 2: Pin current-format parsing with shared validators**

A record is valid only if:

```text
version === 1
runId is valid
puzzleId is valid
request passes isRecordPuzzleCompletionV2(request, MAX_COMPLETION_TIME_SECONDS)
request.runId === runId
completedAt is finite
accountId is null or non-empty
syncStatus is current enum
```

Add corrupt JSON, invalid request, run-ID mismatch, invalid account, and unknown status cases. Invalid current-format files are removed; no compatibility parser.

- [ ] **Step 3: Run red**

```bash
bun run --cwd apps/mobile test:unit -- app/completion/completionStore.test.ts
```

- [ ] **Step 4: Extract only the existing native atomic replacement helper**

Move the existing `NSFileManager.replaceItemAt...` implementation from `gameplay/sessionFiles.ts` to:

```ts
export function atomicReplaceNativeFile(fromPath: string, toPath: string): void;
```

`sessionFiles.ts` imports it; its public `SessionFileOps` contract stays unchanged.

Run existing session store tests immediately after the mechanical extraction.

- [ ] **Step 5: Implement the one-directory completion store**

Path only:

```text
Documents/perseus/completions/<runId>.json
```

`recordCompletion()` atomically writes one record. `listPendingForAccount()` lists `completions/`, parses/validates current records, filters `pending` + exact account, and sorts by `completedAt` then `runId`.

`markSynced` / `markTerminal` rewrite that same record atomically. There is no `outbox` type, parser, directory, or dual write.

- [ ] **Step 6: Run persistence gates and commit**

```bash
bun run --cwd apps/mobile test:unit -- \
  app/gameplay/sessionStore.test.ts \
  app/completion/completionStore.test.ts
cd apps/mobile && bunx tsc --noEmit
cd ../..

git add apps/mobile/app/storage/nativeAtomicReplace.ts \
  apps/mobile/app/gameplay/sessionFiles.ts \
  apps/mobile/app/completion/completionStore.ts \
  apps/mobile/app/completion/completionStore.test.ts \
  apps/mobile/app/completion/nativeCompletionFiles.ts
git commit -m "feat(mobile): persist account-owned completions"
```

---

## Task 5: Reuse the shipped completion failure policy and validate the bearer before draining

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
```

```ts
export type SubmissionDisposition =
  | 'synced'
  | 'retryable'
  | 'auth_required'
  | 'terminal';
```

- [ ] **Step 1: Add failing shared status-mapping tests**

Pin exact existing semantics:

```ts
expect(completionFailureCodeFromHttpStatus(400)).toBe('bad_request');
expect(completionFailureCodeFromHttpStatus(401)).toBe('unauthorized');
expect(completionFailureCodeFromHttpStatus(404)).toBe('not_found');
expect(completionFailureCodeFromHttpStatus(409)).toBe('run_id_conflict');
expect(completionFailureCodeFromHttpStatus(429)).toBe('completion_quota_exceeded');
expect(completionFailureCodeFromHttpStatus(408)).toBe('internal_error');
expect(completionFailureCodeFromHttpStatus(500)).toBe('internal_error');
expect(completionFailureCodeFromHttpStatus(503)).toBe('internal_error');

expect(isFailureRetryable('completion_quota_exceeded')).toBe(false);
expect(isFailureRetryable('unauthorized')).toBe(true);
expect(isFailureRetryable('internal_error')).toBe(true);
```

- [ ] **Step 2: Extract the current web mapping without changing behavior**

Move only the HTTP-status -> failure-code switch from `+page.svelte` to `codec.ts`. Web keeps transport -> `network_error`, then derives retryability with `isFailureRetryable`.

Run the existing web completion tests, especially quota 429 and unauthorized retry behavior.

- [ ] **Step 3: Add failing mobile disposition/drain tests**

Pin:

```text
2xx -> synced
401 -> auth_required, pending preserved, stop
400/404/409/429 -> terminal, mark terminal, continue
408/5xx -> retryable, pending preserved, stop
transport -> retryable, pending preserved, stop
```

The 429 fixture must use `{ error: 'completion_quota_exceeded', message: ... }` to document that this route's 429 is quota, not generic throttling.

Pin same-account filtering, deterministic sequential order, and account B never mutating account A's record.

- [ ] **Step 4: Implement mobile disposition from the shared policy**

For a non-2xx response:

```ts
const code = completionFailureCodeFromHttpStatus(response.status);
if (code === 'unauthorized') return 'auth_required';
return isFailureRetryable(code) ? 'retryable' : 'terminal';
```

Transport rejection is `network_error` and therefore retryable. Do not add status ranges such as `status === 429 || status >= 500` in mobile.

- [ ] **Step 5: Wire completion persistence after the existing completed-session save**

Keep this ordering in `Gameplay.svelte`:

```ts
} else if (event.type === 'completion_sealed') {
  saveCurrentSnapshot();
  completionSeal = event.seal;
  onCompletion(spec.puzzleId, event.seal);
}
```

`Gameplay.svelte` knows no account/HTTP/filesystem queue details.

`App.svelte` captures `accountSession?.user.id ?? null`, writes the completion record synchronously, then may start the guarded validation/drain path. If persistence fails, do not submit that run.

- [ ] **Step 6: Implement one session-validation-before-drain path**

Use the same function after sign-in, foreground resume, and offline -> online connectivity transition:

```ts
async function validateAccountAndDrain(): Promise<void> {
  const current = accountSession;
  if (!current) return;

  let response: PlayerSessionResponse;
  try {
    response = await playerApi.getSession(current.token);
  } catch (error) {
    if (isExplicitUnauthorized(error)) {
      clearAccountSession();
    }
    return; // transport/5xx keeps the local credential and skips drain
  }

  if (!response.authenticated) {
    clearAccountSession();
    return;
  }

  accountSession = { ...current, user: response.user };
  await drainPendingForSession(accountSession);
}
```

`clearAccountSession()` clears secure storage + in-memory account only. It never touches completion files, sessions, or downloads.

`PlayerApi.getSession()` already returns valid `{ authenticated: false }`; it must not throw for that 200 response.

- [ ] **Step 7: Add exactly three active-app validation/drain triggers**

1. after successful sign-in;
2. `Application.resumeEvent` when an account exists and connectivity is not none;
3. connectivity transition from none -> connected.

Use one in-memory promise guard so overlapping triggers collapse to one pass. No timer.

- [ ] **Step 8: Run shared/web/mobile gates and commit**

```bash
bun run --cwd packages/game-core test:unit -- src/session/codec.test.ts
bun run --cwd apps/web test:unit -- 'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../..

git add packages/game-core/src/session/codec.ts packages/game-core/src/session/codec.test.ts \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts' \
  apps/mobile/app/completion/completionSync.ts \
  apps/mobile/app/completion/completionSync.test.ts \
  apps/mobile/app/gameplay/Gameplay.svelte apps/mobile/app/App.svelte
git commit -m "feat(mobile): retry validated account completions"
```

---

## Task 6: Prove anonymous/offline/account-switch boundaries on iPad and run the single-PR gate

**Files:**
- No planned production files. Fix only defects discovered by acceptance on the same HPA-4 branch.

- [ ] **Step 1: Run automated gates**

```bash
bun run --cwd packages/types test:unit
bun run --cwd packages/game-core test:unit
bun run --cwd apps/api test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../..
bun run check
bun run lint
```

All must pass or the PR remains draft with the exact unrelated/pre-existing blocker documented.

- [ ] **Step 2: Prove signed-out completion stays local-only forever**

On iPad:

1. sign out;
2. disable networking;
3. complete a downloaded puzzle;
4. inspect `Documents/perseus/completions/<runId>.json` and verify `accountId: null`, `syncStatus: 'local_only'`;
5. restore network and sign in;
6. verify that record remains local-only and no request for that `runId` reaches the completion endpoint.

- [ ] **Step 3: Prove signed-in offline completion becomes one pending record and drains on reconnect**

1. sign in as account A;
2. disable networking;
3. complete another puzzle;
4. verify exactly one completion file exists for the run with account A + `pending`;
5. verify there is no `Documents/perseus/outbox` directory;
6. restore connectivity;
7. session probe must return authenticated true before completion POST;
8. completion POST succeeds/replays and the same record becomes `synced`.

- [ ] **Step 4: Prove quota/conflict are terminal and do not poison later work**

Using controlled API/test data, exercise:

- 429 `completion_quota_exceeded` -> current record becomes terminal and the drain continues to the next same-account pending record;
- 409 `run_id_conflict` -> terminal and continue;
- 5xx -> current record remains pending and later items are not attempted in that pass.

- [ ] **Step 5: Prove dead bearer is cleared before retry work**

Invalidate/revoke the current Perseus session, then trigger foreground/connectivity validation:

```text
GET /api/auth/session with bearer -> 200 { authenticated:false }
secure storage record removed
in-memory account removed
no completion POST attempted in that pass
pending completion files remain unchanged
```

- [ ] **Step 6: Prove account isolation**

1. create a pending completion as account A;
2. sign out and sign in as account B;
3. trigger foreground/connectivity validation and verify A's record is neither submitted nor mutated;
4. sign back in as account A;
5. validate session, drain, and verify replay-safe completion sync.

- [ ] **Step 7: Prove credential storage boundary**

After sign-in, terminate/relaunch, and logout, inspect:

```text
Documents/perseus/** -> no bearer token
ApplicationSettings -> no bearer token
secure storage -> current bearer present only while signed in
logout -> secure bearer removed; downloads/sessions/completions preserved
```

- [ ] **Step 8: Final scope/diff review**

Confirm:

```text
one HPA-4 PR only
no Firebase dependency
no GoogleService-Info.plist
no outbox directory/type/parser
no second backend Google audience
no alternate completion endpoint
no D1/KV/Workflow/schema migration
no background/timer sync
web completion retry behavior unchanged
```

Update the PR body with actual gate results and leave HPA-4 In Progress until the native acceptance ledger is green.