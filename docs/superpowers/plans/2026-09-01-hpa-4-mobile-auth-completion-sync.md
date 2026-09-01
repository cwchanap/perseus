# HPA-4 Mobile Auth and Account-Bound Completion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional native Google sign-in to the NativeScript iPad app and sync only account-owned mobile completions through the existing idempotent Perseus completion endpoint, while preserving signed-out offline play.

**Architecture:** Reuse the existing Google verifier, allowlist/player upsert, opaque KV player session, `requirePlayerAuth`, and V2 completion route. Mobile stores that same player-session token in iOS secure storage, writes every completion to an app-private filesystem record before any network work, and uses a small account-tagged sequential outbox that `App.svelte` drains on sign-in, foreground resume, or connectivity restoration. No cloud-save model, second auth/session type, alternate completion route, global mobile store, or generic sync/job framework is introduced.

**Tech Stack:** TypeScript 5.9, Hono/Cloudflare Workers, Vitest 4, NativeScript 9, Svelte Native 1.0, `@nativescript/google-signin` 2.1, `@nativescript/secure-storage` 4.0, existing `@perseus/types` and `@perseus/game-core`.

**Spec:** `docs/superpowers/specs/2026-09-01-hpa-4-mobile-auth-completion-sync-design.md`

## Global Constraints

- One HPA-4 PR only. Continue implementation on `docs/hpa-4-mobile-auth-completion-sync-plan`; do not create a second implementation PR.
- Review each task as a separate green commit inside this PR.
- Signed-out mobile download/play/resume/completion must remain network-independent.
- Reuse the existing `GOOGLE_CLIENT_ID` as the Google Sign-In **server client ID** and backend ID-token audience. Do not add a second backend Google audience variable.
- Reuse the existing KV player session and `getPlayerSession()` validation. Do not mint a mobile JWT/session type or add a refresh-token system.
- Browser cookie auth remains supported and behaviorally unchanged.
- The existing `POST /api/puzzles/:id/complete` remains the only server completion write route.
- Every HPA-4 mobile completion record is durable before submission is attempted.
- A completion created while signed out is permanently local-only; later login must not manufacture an outbox entry for it.
- A signed-in completion/outbox item is permanently tagged with the account ID active at completion time; another account must never submit or delete it.
- The Perseus bearer token may exist only in memory and `@nativescript/secure-storage`, never ordinary app JSON/ApplicationSettings.
- Outbox drain is sequential and active-app only; no background task, polling loop, daemon, generic queue framework, or push work.
- No D1 migration, KV schema change, Workflow change, gameplay-session schema change, or cloud-save work.
- HPA-4 is iOS/iPad only. Do not add Android auth/configuration work.
- Package-local mobile TypeScript remains authoritative: `cd apps/mobile && bunx tsc --noEmit`.

## Operator Prerequisite Before Task 3

Create one Google **iOS OAuth client** in the same Google Cloud project as the existing Perseus web/server OAuth client, with bundle ID `org.perseus.mobile`. Record its exact iOS client ID and reversed URL scheme. Task 3 adds those exact non-secret identifiers to `apps/mobile/App_Resources/iOS/Info.plist` together with the existing backend/web client ID as `GIDServerClientID`.

If the iOS client does not exist or Google Sign-In cannot return an ID token whose `aud` is the existing `GOOGLE_CLIENT_ID`, stop HPA-4 at the Task 3 native gate. Do not add a second backend audience to work around a configuration error.

## Final File Ownership

### Shared/API contracts

- Modify `packages/types/src/core.ts` — add the successful mobile player-session exchange response.
- Modify `apps/api/src/routes/auth.worker.ts` — one mobile Google ID-token exchange; session/logout reuse canonical player-session credential resolution.
- Modify `apps/api/src/routes/__tests__/auth.worker.test.ts` — mobile exchange + bearer session/logout + browser regression coverage.
- Modify `apps/api/src/middleware/player-auth.worker.ts` + `.test.ts` — canonical bearer-or-cookie credential/session resolution.
- Modify `apps/api/src/middleware/optional-player-auth.worker.ts` — reuse the same resolver; no second cookie-only validation path.
- Modify the existing completion-route test that owns authenticated completion behavior — pin bearer parity without changing the route implementation.

### Mobile account boundary

- Modify `apps/mobile/package.json` and `bun.lock` — add Google Sign-In + secure storage plugins.
- Modify `apps/mobile/App_Resources/iOS/Info.plist` — actual iOS Google client/server client/reversed URL-scheme configuration.
- Create `apps/mobile/app/api/playerApi.ts` + `.test.ts` — exchange/session/logout/completion HTTP contract over an injected JSON transport.
- Create `apps/mobile/app/api/nativePlayerHttp.ts` — NativeScript `Http.request` adapter only.
- Create `apps/mobile/app/account/mobileAccount.ts` + `.test.ts` — pure account session orchestration and persisted-session validation.
- Create `apps/mobile/app/account/nativeGoogleAuth.ts` — `GoogleSignin.configure({})`, sign-in, ID-token retrieval, sign-out.
- Create `apps/mobile/app/account/nativeSessionStore.ts` — one secure-storage key.
- Create `apps/mobile/app/account/AccountBar.svelte` — minimal sign-in/signed-in/sign-out surface.
- Modify `apps/mobile/app/App.svelte` — composition root owns active account state.

### Mobile completion/outbox

- Create `apps/mobile/app/storage/nativeAtomicReplace.ts` — extract only the existing iOS same-file atomic replace helper.
- Modify `apps/mobile/app/gameplay/sessionFiles.ts` — call that helper; keep the existing session file interface unchanged.
- Create `apps/mobile/app/completion/completionStore.ts` + `.test.ts` — v1 completion/outbox records and file-state transitions over injected file ops.
- Create `apps/mobile/app/completion/nativeCompletionFiles.ts` — concrete `Documents/perseus/completions` + `outbox` mechanics/listing.
- Create `apps/mobile/app/completion/completionSync.ts` + `.test.ts` — submission classification and same-account sequential drain.
- Modify `apps/mobile/app/gameplay/Gameplay.svelte` — call injected completion sink only after the completed session snapshot is saved.
- Modify `apps/mobile/app/App.svelte` — create completion store, run immediate account-bound sync, and trigger guarded drain on sign-in/resume/connectivity restoration.

---

## Task 1: Add one native Google ID-token exchange that reuses the current player session

**Files:**
- Modify: `packages/types/src/core.ts`
- Modify: `apps/api/src/routes/auth.worker.ts`
- Modify: `apps/api/src/routes/__tests__/auth.worker.test.ts`

**Interfaces:**

```ts
export interface MobilePlayerSessionResponse {
  token: string;
  expiresAt: number;
  user: PlayerUser;
}
```

HTTP:

```text
POST /api/auth/mobile/google
{ "idToken": string }
-> 200 MobilePlayerSessionResponse
```

- [ ] **Step 1: Add failing route tests for the successful exchange and audience reuse**

Extend the existing mocked auth test instead of creating a second route harness:

```ts
it('exchanges a native Google ID token for the existing Perseus player session', async () => {
  const res = await auth.fetch(
    request('/mobile/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'native-google-id-token' })
    }),
    env
  );

  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(sharedAuth.verifyGoogleIdToken).toHaveBeenCalledWith(
    'native-google-id-token',
    'google-client-id'
  );
  expect(playerAuth.getAllowlistEntry).toHaveBeenCalledWith(kv, 'player@example.com');
  expect(playerAuth.upsertPlayer).toHaveBeenCalledWith(kv, claims);
  expect(playerAuth.createPlayerSession).toHaveBeenCalledWith(kv, player);
  expect(await res.json()).toEqual({
    token: 'player-session-token',
    expiresAt: 1_719_092_000_000,
    user: player
  });
});
```

Add explicit cases for invalid body, verifier rejection, and valid-but-not-allowlisted identity:

```ts
expect((await invalidBody.json()).error).toBe('bad_request');
expect(invalidToken.status).toBe(401);
expect(notAllowed.status).toBe(403);
```

- [ ] **Step 2: Run the focused test red**

```bash
bun run --cwd apps/api test:unit -- src/routes/__tests__/auth.worker.test.ts
```

Expected: FAIL because `/mobile/google` and `MobilePlayerSessionResponse` do not exist.

- [ ] **Step 3: Add the shared response and the minimal route**

Add the response next to `PlayerSessionResponse` in `packages/types/src/core.ts`.

In `auth.worker.ts`, keep the mobile route outside `/google/*` because native exchange does not require `GOOGLE_CLIENT_SECRET` or `AUTH_REDIRECT_BASE_URL`:

```ts
auth.use('/mobile/google', oauthRateLimit);

auth.post('/mobile/google', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return withNoStore(c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400));
  }

  const idToken =
    typeof body === 'object' && body !== null &&
    typeof (body as { idToken?: unknown }).idToken === 'string'
      ? (body as { idToken: string }).idToken.trim()
      : '';
  if (!idToken) {
    return withNoStore(c.json({ error: 'bad_request', message: 'Google ID token required' }, 400));
  }
  if (!c.env.GOOGLE_CLIENT_ID) return serverMisconfigured();

  let claims;
  try {
    claims = await verifyGoogleIdToken(idToken, c.env.GOOGLE_CLIENT_ID);
  } catch {
    return withNoStore(c.json({ error: 'invalid_google_token', message: 'Invalid Google identity' }, 401));
  }

  const allowlisted = await getAllowlistEntry(c.env.PUZZLE_METADATA, claims.email);
  if (!allowlisted) {
    return withNoStore(c.json({ error: 'not_allowed', message: 'Account is not allowed' }, 403));
  }

  const user = await upsertPlayer(c.env.PUZZLE_METADATA, claims);
  const session = await createPlayerSession(c.env.PUZZLE_METADATA, user);
  const response: MobilePlayerSessionResponse = { ...session, user };
  return withNoStore(c.json(response));
});
```

Do not set a cookie on this route and do not change the browser callback.

- [ ] **Step 4: Run focused auth + types checks**

```bash
bun run --cwd apps/api test:unit -- src/routes/__tests__/auth.worker.test.ts
bun run --cwd packages/types test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/core.ts apps/api/src/routes/auth.worker.ts apps/api/src/routes/__tests__/auth.worker.test.ts
git commit -m "feat(api): exchange mobile Google identity for player session"
```

---

## Task 2: Make bearer and cookie credentials share one player-session validation path

**Files:**
- Modify: `apps/api/src/middleware/player-auth.worker.ts`
- Modify: `apps/api/src/middleware/player-auth.worker.test.ts`
- Modify: `apps/api/src/middleware/optional-player-auth.worker.ts`
- Modify: `apps/api/src/routes/auth.worker.ts`
- Modify: `apps/api/src/routes/__tests__/auth.worker.test.ts`
- Modify: the existing API completion-route Worker test that exercises `POST /api/puzzles/:id/complete`

**Interfaces:**

```ts
export function playerSessionTokenFromRequest(c: PlayerAuthContext): string | null;
export async function resolvePlayerSession(c: PlayerAuthContext): Promise<PlayerSessionRecord | null>;
```

Rules:

```text
Authorization present + valid Bearer -> bearer token
Authorization present + malformed/other scheme -> null, no cookie fallback
Authorization absent -> perseus_player_session cookie
```

- [ ] **Step 1: Pin credential precedence in the existing middleware test**

Add table coverage:

```ts
it('uses bearer auth when Authorization is present', async () => {
  const res = await app.request('/protected', {
    headers: {
      Authorization: 'Bearer native-session-token',
      Cookie: 'perseus_player_session=browser-session-token'
    }
  }, env);

  expect(playerAuth.getPlayerSession).toHaveBeenCalledWith(kv, 'native-session-token');
  expect(res.status).toBe(200);
});

it('does not fall back to a cookie for an explicit malformed Authorization header', async () => {
  const res = await app.request('/protected', {
    headers: {
      Authorization: 'Basic nope',
      Cookie: 'perseus_player_session=browser-session-token'
    }
  }, env);

  expect(playerAuth.getPlayerSession).not.toHaveBeenCalled();
  expect(res.status).toBe(401);
});
```

Keep/add a cookie-only case proving existing web behavior remains green.

- [ ] **Step 2: Run middleware tests red**

```bash
bun run --cwd apps/api test:unit -- src/middleware/player-auth.worker.test.ts
```

Expected: bearer cases fail because middleware is cookie-only.

- [ ] **Step 3: Implement the single resolver and reuse it from required + optional auth**

In `player-auth.worker.ts`:

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
  if (!token) return null;
  return getPlayerSession(c.env.PUZZLE_METADATA, token);
}
```

`requirePlayerAuth` becomes a thin status wrapper around `resolvePlayerSession()`.

Change `optional-player-auth.worker.ts` to call the same resolver and set `playerSession` only when it resolves. Delete its direct `getCookie()` + `getPlayerSession()` duplication.

- [ ] **Step 4: Make `/session` and `/logout` reuse the same credential extraction**

`GET /session` calls `resolvePlayerSession(c)` and returns the existing `PlayerSessionResponse` shape.

`POST /logout` calls `playerSessionTokenFromRequest(c)` for revocation, then keeps the existing browser cookie clear operation. A bearer request therefore revokes the same KV session; a browser request still clears the cookie exactly as before.

Add auth-route tests for bearer `/session`, bearer `/logout`, and cookie regression.

- [ ] **Step 5: Pin unchanged completion-route behavior over bearer**

In the existing completion Worker route test, send:

```ts
headers: {
  Authorization: 'Bearer native-session-token',
  'Content-Type': 'application/json'
}
```

Assert the same `recordVersionedCompletion(...)` arguments and response as the cookie-authenticated case. Do not add a mobile completion route or fork the route handler.

- [ ] **Step 6: Run the API gate and commit**

```bash
bun run --cwd apps/api test:unit -- \
  src/middleware/player-auth.worker.test.ts \
  src/routes/__tests__/auth.worker.test.ts
bun run --cwd apps/api test:unit

git add apps/api/src/middleware/player-auth.worker.ts \
  apps/api/src/middleware/player-auth.worker.test.ts \
  apps/api/src/middleware/optional-player-auth.worker.ts \
  apps/api/src/routes/auth.worker.ts \
  apps/api/src/routes/__tests__/auth.worker.test.ts \
  apps/api/src/routes

git commit -m "feat(api): accept player sessions as bearer credentials"
```

Before committing, confirm the broad `apps/api/src/routes` add contains only the intended completion test change.

---

## Task 3: Add native Google sign-in and secure Perseus account storage

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Create: `apps/mobile/app/api/playerApi.ts`
- Create: `apps/mobile/app/api/playerApi.test.ts`
- Create: `apps/mobile/app/api/nativePlayerHttp.ts`
- Create: `apps/mobile/app/account/mobileAccount.ts`
- Create: `apps/mobile/app/account/mobileAccount.test.ts`
- Create: `apps/mobile/app/account/nativeGoogleAuth.ts`
- Create: `apps/mobile/app/account/nativeSessionStore.ts`
- Create: `apps/mobile/app/account/AccountBar.svelte`
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`

**Interfaces:**

```ts
export interface PersistedMobileSession {
  version: 1;
  token: string;
  expiresAt: number;
  user: PlayerUser;
}

export interface MobileSessionStore {
  read(): PersistedMobileSession | null;
  write(session: PersistedMobileSession): void;
  clear(): void;
}

export interface GoogleIdTokenProvider {
  signIn(): Promise<string>;
  signOut(): Promise<void>;
}
```

```ts
export interface PlayerApi {
  exchangeGoogleIdToken(idToken: string): Promise<MobilePlayerSessionResponse>;
  getSession(token: string): Promise<PlayerSessionResponse>;
  logout(token: string): Promise<void>;
  submitCompletion(
    puzzleId: string,
    request: RecordPuzzleCompletionV2,
    token: string
  ): Promise<{ status: number; body: unknown }>;
}
```

- [ ] **Step 1: Add the two native dependencies**

```bash
cd apps/mobile
bun add @nativescript/google-signin@^2.1.1 @nativescript/secure-storage@^4.0.2
```

Expected: `apps/mobile/package.json` and root `bun.lock` change; no Firebase dependency is added.

- [ ] **Step 2: Add failing pure API/account tests before importing native plugins**

`playerApi.test.ts` uses an injected transport and pins paths/headers:

```ts
expect(request).toHaveBeenCalledWith({
  method: 'POST',
  url: 'https://api.example.com/api/auth/mobile/google',
  headers: { 'Content-Type': 'application/json' },
  body: { idToken: 'google-id-token' }
});

expect(completionRequest.headers.Authorization).toBe('Bearer player-token');
```

`mobileAccount.test.ts` pins restore/sign-in/logout boundaries:

```ts
it('persists a Perseus session only after Google exchange succeeds', async () => {
  const session = await signInMobileAccount({ google, api, store });
  expect(store.write).toHaveBeenCalledWith(session);
});

it('clears the secure Perseus credential even when remote logout fails', async () => {
  api.logout.mockRejectedValue(new Error('offline'));
  await signOutMobileAccount({ current: saved, google, api, store });
  expect(store.clear).toHaveBeenCalledTimes(1);
});

it('drops an already-expired secure record without a network request', () => {
  expect(restoreMobileAccount(store, now)).toBeNull();
  expect(store.clear).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run mobile tests red**

```bash
bun run --cwd apps/mobile test:unit -- app/api/playerApi.test.ts app/account/mobileAccount.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the injected `PlayerApi` and native HTTP adapter**

`playerApi.ts` owns URL/status parsing; `nativePlayerHttp.ts` owns only NativeScript `Http.request` conversion. Keep this separate from public `puzzleApi.ts` rather than widening its GET-only contract.

For auth/session methods, non-2xx responses throw typed/status-bearing errors. `submitCompletion` returns `{ status, body }` for Task 5 classification instead of throwing on HTTP status; only transport failure rejects.

- [ ] **Step 5: Implement the pure account functions**

```ts
export async function signInMobileAccount(deps: {
  google: GoogleIdTokenProvider;
  api: PlayerApi;
  store: MobileSessionStore;
}): Promise<PersistedMobileSession> {
  const idToken = await deps.google.signIn();
  const response = await deps.api.exchangeGoogleIdToken(idToken);
  const session: PersistedMobileSession = { version: 1, ...response };
  deps.store.write(session);
  return session;
}
```

`restoreMobileAccount(store, now)` accepts only `version: 1`, non-empty token, finite future `expiresAt`, and a structurally present user ID/email; invalid/expired data is cleared. There is no compatibility parser.

`signOutMobileAccount()` attempts API logout and Google sign-out but clears the secure store in a `finally` path.

- [ ] **Step 6: Add the concrete secure-storage and Google adapters**

`nativeSessionStore.ts` uses exactly one key:

```ts
const PLAYER_SESSION_KEY = 'perseus_player_session_v1';
const secureStorage = new SecureStorage();
```

Use `getSync`, `setSync`, and `removeSync`; JSON parse/validation stays in `mobileAccount.ts`. Do not enable `useLessSecureStorage`.

`nativeGoogleAuth.ts`:

```ts
let configured = false;

async function ensureConfigured(): Promise<void> {
  if (configured) return;
  await GoogleSignin.configure({});
  configured = true;
}

export const nativeGoogleIdTokenProvider: GoogleIdTokenProvider = {
  async signIn() {
    await ensureConfigured();
    await GoogleSignin.signIn();
    const { idToken } = await GoogleSignin.getTokens();
    if (!idToken) throw new Error('google_id_token_missing');
    return idToken;
  },
  async signOut() {
    await ensureConfigured();
    await GoogleSignin.signOut();
  }
};
```

- [ ] **Step 7: Configure iOS with the actual OAuth identifiers**

After the operator prerequisite is satisfied, modify `Info.plist` using the actual values from the same Google Cloud project:

```xml
<key>GIDClientID</key>
<string>[actual org.perseus.mobile iOS client ID]</string>
<key>GIDServerClientID</key>
<string>[actual existing Perseus GOOGLE_CLIENT_ID]</string>
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>[actual reversed iOS client ID]</string>
    </array>
  </dict>
</array>
```

The bracketed values above are instructions to copy the exact registered identifiers, not values to commit literally. Before continuing, inspect the built plist and confirm no bracketed/example value remains.

- [ ] **Step 8: Add the concrete Library account strip and compose it in `App.svelte`**

`AccountBar.svelte` receives only:

```ts
export let session: PersistedMobileSession | null;
export let busy: boolean;
export let error: string | null;
export let onSignIn: () => void;
export let onSignOut: () => void;
```

Do not add account navigation/profile state. `App.svelte` restores secure state at boot and owns sign-in/sign-out mutations.

When online and a restored secure session exists, call `api.getSession(token)` once during boot/foreground validation; an unauthenticated response clears only the secure account state.

- [ ] **Step 9: Run pure gates, then the native auth stop gate**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
```

Then run the existing mobile app against a Worker configured with the same `GOOGLE_CLIENT_ID`, sign in on the target iPad simulator/device, and record all of these before Task 4:

```text
Google native modal completes
GoogleSignin.getTokens() returns a non-empty idToken
POST /api/auth/mobile/google returns 200 for an allowlisted account
GET /api/auth/session with Bearer returns the same PlayerUser
terminate/relaunch restores the Perseus account from secure storage
Documents/perseus contains no bearer token
ApplicationSettings contains no bearer token
```

If the ID token audience is not the existing server `GOOGLE_CLIENT_ID`, fix Google client/server-client configuration and repeat. Do not change backend audience logic.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/package.json bun.lock \
  apps/mobile/App_Resources/iOS/Info.plist \
  apps/mobile/app/api/playerApi.ts apps/mobile/app/api/playerApi.test.ts \
  apps/mobile/app/api/nativePlayerHttp.ts \
  apps/mobile/app/account \
  apps/mobile/app/App.svelte apps/mobile/app/app.css

git commit -m "feat(mobile): add secure optional Google account"
```

---

## Task 4: Add durable local completion records and an account-owned outbox

**Files:**
- Create: `apps/mobile/app/storage/nativeAtomicReplace.ts`
- Modify: `apps/mobile/app/gameplay/sessionFiles.ts`
- Create: `apps/mobile/app/completion/completionStore.ts`
- Create: `apps/mobile/app/completion/completionStore.test.ts`
- Create: `apps/mobile/app/completion/nativeCompletionFiles.ts`

**Interfaces:**

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

export interface CompletionOutboxItemV1 {
  version: 1;
  runId: string;
  puzzleId: string;
  accountId: string;
  createdAt: number;
  request: RecordPuzzleCompletionV2;
}
```

```ts
export interface CompletionFileOps {
  readText(path: string): string | null;
  writeTextAtomic(path: string, content: string): void;
  remove(path: string): void;
  listFileNames(directory: string): string[];
}
```

Store API:

```ts
recordCompletion(input): MobileCompletionRecordV1;
listOutbox(): CompletionOutboxItemV1[];
markSynced(runId: string): void;
markTerminal(runId: string): void;
```

- [ ] **Step 1: Write failing store tests for the two ownership paths**

Signed out:

```ts
const record = store.recordCompletion({ puzzleId, seal, accountId: null });
expect(record.syncStatus).toBe('local_only');
expect(files.namesUnder('completions')).toEqual([`${seal.runId}.json`]);
expect(files.namesUnder('outbox')).toEqual([]);
```

Signed in:

```ts
const record = store.recordCompletion({ puzzleId, seal, accountId: 'account-a' });
expect(record.syncStatus).toBe('pending');
expect(store.listOutbox()).toEqual([
  expect.objectContaining({ runId: seal.runId, accountId: 'account-a' })
]);
expect(outboxWriteOrder).toBeGreaterThan(completionWriteOrder);
```

Pin `request` to exact `completionRequestFromSeal(seal)` and `completedAt` to `seal.completedAt`.

Add transitions:

```ts
store.markSynced(runId);
expect(readRecord(runId).syncStatus).toBe('synced');
expect(store.listOutbox()).toEqual([]);

store.markTerminal(runId);
expect(readRecord(runId).syncStatus).toBe('terminal');
expect(store.listOutbox()).toEqual([]);
```

Also pin deterministic `createdAt`/`runId` sort and corrupt-outbox removal without deleting the completion/session/download data.

- [ ] **Step 2: Run red**

```bash
bun run --cwd apps/mobile test:unit -- app/completion/completionStore.test.ts
```

Expected: FAIL because completion persistence does not exist.

- [ ] **Step 3: Extract only the existing atomic-replace primitive**

Move the current iOS `NSFileManager.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError` implementation from `sessionFiles.ts` into:

```ts
export function atomicReplaceNativeFile(fromPath: string, toPath: string): void;
```

`sessionFiles.ts` imports this helper and otherwise keeps its current `SessionFileOps` surface unchanged. Run the existing session-store tests immediately to prove this is a mechanical extraction.

- [ ] **Step 4: Implement the pure completion store**

`recordCompletion()` must perform this order:

```ts
const request = completionRequestFromSeal(seal);
const record: MobileCompletionRecordV1 = {
  version: 1,
  runId: seal.runId,
  puzzleId,
  completedAt: seal.completedAt,
  accountId,
  request,
  syncStatus: accountId === null ? 'local_only' : 'pending'
};
writeCompletion(record);

if (accountId !== null) {
  writeOutbox({
    version: 1,
    runId: seal.runId,
    puzzleId,
    accountId,
    createdAt: seal.completedAt,
    request
  });
}
return record;
```

Do not inspect other local completion files to create outbox entries later.

- [ ] **Step 5: Implement concrete native completion file mechanics**

Create/ensure:

```text
Documents/perseus/completions
Documents/perseus/outbox
```

Use temp file + `atomicReplaceNativeFile()` for all record/outbox writes. `listFileNames()` returns only direct `.json` filenames from the requested directory. No recursive scan/index/database.

- [ ] **Step 6: Run mobile persistence gates and commit**

```bash
bun run --cwd apps/mobile test:unit -- \
  app/gameplay/sessionStore.test.ts \
  app/completion/completionStore.test.ts
cd apps/mobile && bunx tsc --noEmit

git add apps/mobile/app/storage/nativeAtomicReplace.ts \
  apps/mobile/app/gameplay/sessionFiles.ts \
  apps/mobile/app/completion/completionStore.ts \
  apps/mobile/app/completion/completionStore.test.ts \
  apps/mobile/app/completion/nativeCompletionFiles.ts

git commit -m "feat(mobile): persist account-owned completion outbox"
```

---

## Task 5: Submit after local persistence and drain only the active account's outbox

**Files:**
- Create: `apps/mobile/app/completion/completionSync.ts`
- Create: `apps/mobile/app/completion/completionSync.test.ts`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/App.svelte`

**Interfaces:**

```ts
export type SubmissionDisposition =
  | 'synced'
  | 'retryable'
  | 'auth_required'
  | 'terminal';

export function classifyCompletionSubmission(status: number): SubmissionDisposition;

export async function submitRecordedCompletion(args: {
  item: CompletionOutboxItemV1;
  token: string;
  api: PlayerApi;
  store: CompletionStore;
}): Promise<SubmissionDisposition>;

export async function drainCompletionOutbox(args: {
  activeSession: PersistedMobileSession;
  api: PlayerApi;
  store: CompletionStore;
}): Promise<void>;
```

Gameplay prop:

```ts
export let onCompletion: (puzzleId: string, seal: SealedCompletion) => void;
```

- [ ] **Step 1: Write failing classification and account-isolation tests**

```ts
it.each([
  [200, 'synced'],
  [201, 'synced'],
  [408, 'retryable'],
  [429, 'retryable'],
  [500, 'retryable'],
  [503, 'retryable'],
  [401, 'auth_required'],
  [400, 'terminal'],
  [404, 'terminal'],
  [409, 'terminal'],
  [410, 'terminal']
])('classifies HTTP %s as %s', (status, expected) => {
  expect(classifyCompletionSubmission(status)).toBe(expected);
});
```

Account ownership:

```ts
store.listOutbox.mockReturnValue([
  makeItem({ runId: 'a-1', accountId: 'account-a', createdAt: 1 }),
  makeItem({ runId: 'b-1', accountId: 'account-b', createdAt: 2 }),
  makeItem({ runId: 'a-2', accountId: 'account-a', createdAt: 3 })
]);

await drainCompletionOutbox({
  activeSession: makeSession('account-b'),
  api,
  store
});

expect(api.submitCompletion).toHaveBeenCalledTimes(1);
expect(api.submitCompletion).toHaveBeenCalledWith(
  expect.any(String),
  expect.objectContaining({ runId: 'b-1' }),
  'token-account-b'
);
expect(store.markSynced).toHaveBeenCalledWith('b-1');
expect(store.markSynced).not.toHaveBeenCalledWith('a-1');
```

Add tests that drain is sequential, terminal continues, and retryable/401 stops without removing the pending item.

- [ ] **Step 2: Run red**

```bash
bun run --cwd apps/mobile test:unit -- app/completion/completionSync.test.ts
```

- [ ] **Step 3: Implement the minimal classification/drain**

```ts
export function classifyCompletionSubmission(status: number): SubmissionDisposition {
  if (status >= 200 && status < 300) return 'synced';
  if (status === 401) return 'auth_required';
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'terminal';
}
```

Transport rejection is treated as `retryable`.

`drainCompletionOutbox()` filters by exact `accountId`, keeps the store-provided deterministic order, awaits each request before starting the next, and stops on `retryable` or `auth_required`.

- [ ] **Step 4: Wire gameplay completion after the existing local session save**

Preserve this order in `completion_sealed`:

```ts
} else if (event.type === 'completion_sealed') {
  saveCurrentSnapshot();
  completionSeal = event.seal;
  onCompletion(spec.puzzleId, event.seal);
}
```

`Gameplay.svelte` still does not know account state, HTTP, or outbox paths.

- [ ] **Step 5: Compose local-first immediate submission in `App.svelte`**

`App.svelte` completion handler:

```ts
function onGameplayCompletion(puzzleId: string, seal: SealedCompletion): void {
  const accountId = accountSession?.user.id ?? null;
  const record = completionStore.recordCompletion({ puzzleId, seal, accountId });
  if (record.accountId !== null && accountSession?.user.id === record.accountId) {
    void drainOutboxGuarded();
  }
}
```

`recordCompletion()` is synchronous/durable before `drainOutboxGuarded()` starts. If persistence throws, catch/surface/log that failure and do not submit the run.

- [ ] **Step 6: Add exactly three active-app retry triggers**

In `App.svelte`:

1. after successful sign-in;
2. on `Application.resumeEvent` when an account is active and `Connectivity.getConnectionType() !== Connectivity.connectionType.none`;
3. `Connectivity.startMonitoring()` when connection changes from `none` to any connected type.

Use one in-memory guard:

```ts
let outboxDrainPromise: Promise<void> | null = null;

function drainOutboxGuarded(): Promise<void> {
  if (!accountSession) return Promise.resolve();
  if (outboxDrainPromise) return outboxDrainPromise;
  const session = accountSession;
  outboxDrainPromise = drainCompletionOutbox({ activeSession: session, api: playerApi, store: completionStore })
    .finally(() => {
      outboxDrainPromise = null;
    });
  return outboxDrainPromise;
}
```

Before each item submission, `drainCompletionOutbox()` still checks the immutable item account against the supplied session. A later account switch cannot reuse this pass to submit the other account's item.

Stop connectivity monitoring and remove the resume listener during component teardown. Do not add a timer.

- [ ] **Step 7: Run mobile gates and commit**

```bash
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit

git add apps/mobile/app/completion/completionSync.ts \
  apps/mobile/app/completion/completionSync.test.ts \
  apps/mobile/app/gameplay/Gameplay.svelte \
  apps/mobile/app/App.svelte

git commit -m "feat(mobile): sync same-account completions when online"
```

---

## Task 6: Prove the offline/account boundary on iPad and run the single-PR final gate

**Files:**
- No planned production files. Fix only defects discovered by this acceptance pass on the same HPA-4 branch.

**Produces:** recorded acceptance evidence in the HPA-4 PR body/comment; no second PR.

- [ ] **Step 1: Run focused and repository automated gates**

```bash
bun run --cwd packages/types test:unit
bun run --cwd apps/api test:unit
bun run --cwd apps/mobile test:unit
cd apps/mobile && bunx tsc --noEmit
cd ../..
bun run check
bun run lint
```

All must pass or the PR remains draft with the exact unrelated/pre-existing blocker documented.

- [ ] **Step 2: Prove signed-out completion never becomes future upload work**

On iPad:

1. Ensure Perseus account is signed out.
2. Disable networking.
3. Complete a downloaded puzzle.
4. Inspect `Documents/perseus/completions/<runId>.json`:
   - `accountId` is `null`;
   - `syncStatus` is `local_only`.
5. Confirm no `outbox/<runId>.json` exists.
6. Restore networking and sign in.
7. Confirm that run still has no outbox item and no completion request for that `runId` reaches the API.

This is the hard fence against retroactive anonymous upload.

- [ ] **Step 3: Prove signed-in offline -> reconnect -> idempotent drain**

1. Sign in as allowlisted account A.
2. Disable networking.
3. Complete a different downloaded puzzle.
4. Confirm completion JSON is `pending`, `accountId` equals A's `PlayerUser.id`, and `outbox/<runId>.json` exists.
5. Confirm completion UI remains usable while offline.
6. Restore connectivity while the app is active.
7. Confirm exactly the existing `/api/puzzles/:id/complete` route receives the same `runId`/V2 request.
8. Confirm completion JSON becomes `synced` and the outbox file is removed.
9. Replay the same request once manually/test-side and confirm existing server idempotency reports replay rather than a duplicate logical completion.

- [ ] **Step 4: Prove account-switch ownership**

1. Create another pending completion while signed in as account A.
2. Sign out offline; confirm local content/outbox remains.
3. Sign in as allowlisted account B.
4. Restore networking/trigger foreground.
5. Confirm A's outbox file remains untouched and no request for A's run is made with B's bearer token.
6. Sign out B and sign back in as A.
7. Confirm A's pending run drains and the outbox item is removed only then.

- [ ] **Step 5: Prove secure storage boundary and logout scope**

Before/after terminate + relaunch and logout, inspect:

```text
Documents/perseus/sessions       preserved
Documents/perseus/downloads      preserved
Documents/perseus/completions    preserved
Documents/perseus/outbox         preserved except items legitimately drained
ApplicationSettings              contains no Perseus bearer token
```

After logout, `GET /api/auth/session` with the old bearer must no longer authenticate when server revocation succeeded; regardless of network, the app must no longer load that bearer from secure storage.

- [ ] **Step 6: Run the scope fence**

```bash
git diff --name-only main...HEAD
rg "perseus_player_session_v1|Authorization: Bearer|Bearer " apps/mobile/app
rg "ApplicationSettings" apps/mobile/app/account apps/mobile/app/completion
rg "POST /api/auth/mobile/google|/api/auth/mobile/google" apps/api apps/mobile
rg "mobile.*complete|/api/mobile" apps/api apps/mobile
```

Expected:

- changed files are limited to HPA-4 auth/account/completion work plus the two planning docs;
- secure token references are limited to secure-account/API code;
- no `ApplicationSettings` token storage;
- one mobile Google exchange route;
- no alternate mobile completion route.

- [ ] **Step 7: Update the draft PR with acceptance evidence; do not create another PR**

Record exact automated results and the three native scenarios (anonymous local-only, same-account offline retry, account switching) in the existing HPA-4 PR. Keep the PR draft until failures are resolved and the evidence is complete.

---

## Plan Self-Review

### Spec coverage

- Native Google sign-in + ID-token exchange: Task 1 + Task 3.
- Existing allowlist/player/session reuse: Task 1.
- One bearer/cookie session validator with web compatibility: Task 2.
- Secure mobile credential storage: Task 3.
- Local-first completion record: Task 4 + Task 5.
- Logged-out completions never retro-upload: Task 4 + Task 6.
- Same-account pending outbox and sequential retry: Task 4 + Task 5.
- Foreground/connectivity retry only: Task 5.
- Account-switch safety/logout preservation: Task 5 + Task 6.
- Existing completion endpoint/runId idempotency: Task 2 + Task 6.
- No cloud save/background framework/provider abstraction: global constraints + scope fence.

### Placeholder scan

The only bracketed strings are in the Task 3 `Info.plist` example, where they explicitly mean “copy the actual registered external OAuth identifiers and verify no bracketed/example value is committed.” They are not source placeholders to ship.

### Type consistency

- Server exchange returns `MobilePlayerSessionResponse`.
- `PersistedMobileSession` adds only `version: 1` around that response.
- `PlayerApi.submitCompletion()` consumes the existing `RecordPuzzleCompletionV2` projected by `completionRequestFromSeal()`.
- `CompletionOutboxItemV1.accountId` is always non-null and is compared to `PersistedMobileSession.user.id` before submission.
- `Gameplay.svelte` emits only `{ puzzleId, SealedCompletion }`; account/network/storage ownership stays in `App.svelte` and completion modules.
