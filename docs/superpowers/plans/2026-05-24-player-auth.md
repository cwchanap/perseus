# Player Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google-only player authentication with admin-managed email allowlist while keeping
anonymous gameplay available.

**Architecture:** The API owns Google OAuth, player sessions, account storage, and allowlist
checks. The Cloudflare Worker implementation is canonical and uses KV; the Bun route variant keeps
the same contracts with JSON files under `DATA_DIR/auth`. The Svelte app only links to auth
routes, checks session state, renders account controls, and lets admins manage the allowlist.

**Tech Stack:** Bun, Turborepo, Hono, Cloudflare Workers, Workers KV, SvelteKit static adapter,
Svelte 5 runes, Vitest browser mode, Playwright.

---

## File Structure

Create backend auth modules with narrow ownership:

- `apps/api/src/services/player-auth.shared.ts`: pure helpers for email normalization, return
  path validation, PKCE, base64url, SHA-256 session hashes, OAuth state generation, Google token
  exchange, and Google ID token claim validation helpers.
- `apps/api/src/services/player-auth.worker.ts`: KV-backed allowlist, player, OAuth state, and
  session repository for Worker routes.
- `apps/api/src/services/player-auth.ts`: filesystem-backed allowlist, player, OAuth state, and
  session repository for Bun routes.
- `apps/api/src/routes/auth.worker.ts`: Worker player auth routes.
- `apps/api/src/routes/auth.ts`: Bun player auth routes.

Modify existing API boundaries:

- `packages/types/src/index.ts`: shared player auth response and allowlist types.
- `apps/api/src/worker.ts`: add Google env bindings and mount `/api/auth`.
- `apps/api/src/index.ts`: require Google env vars and mount `/api/auth`.
- `apps/api/src/routes/admin.worker.ts`: add Worker allowlist routes.
- `apps/api/src/routes/admin.ts`: add Bun allowlist routes.
- `apps/api/.env.example`: document local auth variables.
- `apps/api/wrangler.toml` and `apps/api/wrangler.production.toml`: document Worker variables.
- `packages/infrastructure/src/index.ts`: bind Google auth config for production.

Modify web boundaries:

- `apps/web/src/lib/services/api.ts`: add player auth and allowlist API client functions.
- `apps/web/src/lib/types/puzzle.ts`: re-export player auth shared types.
- `apps/web/src/lib/stores/playerAuth.ts`: own frontend session state and logout behavior.
- `apps/web/src/routes/+layout.svelte`: replace lone floating Quick Puzzle link with navigation
  cluster and account state.
- `apps/web/src/routes/login/+page.svelte`: player login page and error-code rendering.
- `apps/web/src/routes/admin/+page.svelte`: add Player Access panel.

Add focused tests:

- `apps/api/src/services/player-auth.shared.test.ts`
- `apps/api/src/services/player-auth.worker.test.ts`
- `apps/api/src/services/player-auth.test.ts`
- `apps/api/src/routes/__tests__/auth.worker.test.ts`
- `apps/api/src/routes/__tests__/auth.test.ts`
- extend `apps/api/src/routes/__tests__/admin.worker.test.ts`
- extend `apps/api/src/routes/__tests__/admin.test.ts`
- `apps/web/src/lib/stores/playerAuth.test.ts`
- `apps/web/src/routes/layout.svelte.test.ts`
- `apps/web/src/routes/login/page.svelte.test.ts`
- extend `apps/web/src/routes/admin/admin-page.svelte.test.ts`

## Task 1: Shared Player Auth Contracts

**Files:**

- Modify: `packages/types/src/index.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts`
- Test: `packages/types/src/index.test.ts`

- [ ] **Step 1: Add failing type/validation tests**

Append these tests to `packages/types/src/index.test.ts`:

```ts
import {
	isPlayerSessionResponse,
	isPlayerAllowlistEntry,
	type PlayerSessionResponse,
	type PlayerAllowlistEntry
} from './index';

describe('player auth contracts', () => {
	it('validates an authenticated player session response', () => {
		const response: PlayerSessionResponse = {
			authenticated: true,
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				name: 'Player One',
				picture: 'https://example.com/avatar.png',
				createdAt: 1716500000000,
				lastLoginAt: 1716500100000
			}
		};

		expect(isPlayerSessionResponse(response)).toBe(true);
	});

	it('rejects authenticated session responses without a user', () => {
		expect(isPlayerSessionResponse({ authenticated: true })).toBe(false);
	});

	it('validates allowlist entries with linked player metadata', () => {
		const entry: PlayerAllowlistEntry = {
			email: 'player@example.com',
			createdAt: 1716500000000,
			addedBy: 'admin',
			player: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1716500000000,
				lastLoginAt: 1716500100000
			}
		};

		expect(isPlayerAllowlistEntry(entry)).toBe(true);
	});

	it('rejects allowlist entries with invalid email shape', () => {
		expect(
			isPlayerAllowlistEntry({
				email: 'not-an-email',
				createdAt: 1716500000000,
				addedBy: 'admin'
			})
		).toBe(false);
	});
});
```

- [ ] **Step 2: Run the focused shared type test and verify it fails**

Run:

```bash
cd packages/types && bunx vitest run src/index.test.ts
```

Expected: FAIL because `isPlayerSessionResponse` and `isPlayerAllowlistEntry` are not exported.

- [ ] **Step 3: Add shared player auth types and validators**

Add this block after `SessionResponse` in `packages/types/src/index.ts`:

```ts
export interface PlayerUser {
	id: string;
	email: string;
	name?: string;
	picture?: string;
	createdAt: number;
	lastLoginAt: number;
}

export interface PlayerSessionResponse {
	authenticated: boolean;
	user?: PlayerUser;
}

export interface PlayerAllowlistEntry {
	email: string;
	createdAt: number;
	addedBy: string;
	player?: PlayerUser;
}

export interface PlayerAllowlistResponse {
	entries: PlayerAllowlistEntry[];
}

export interface PlayerAllowlistMutationResponse {
	entry: PlayerAllowlistEntry;
}

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function isPlayerUser(value: unknown): value is PlayerUser {
	if (typeof value !== 'object' || value === null) return false;
	const user = value as Record<string, unknown>;
	if (!isNonEmptyString(user.id)) return false;
	if (!isNonEmptyString(user.email) || !SIMPLE_EMAIL_PATTERN.test(user.email)) return false;
	if (!isFiniteNumber(user.createdAt)) return false;
	if (!isFiniteNumber(user.lastLoginAt)) return false;
	if (user.name !== undefined && !isNonEmptyString(user.name)) return false;
	if (user.picture !== undefined && !isNonEmptyString(user.picture)) return false;
	return true;
}

export function isPlayerSessionResponse(value: unknown): value is PlayerSessionResponse {
	if (typeof value !== 'object' || value === null) return false;
	const response = value as Record<string, unknown>;
	if (typeof response.authenticated !== 'boolean') return false;
	if (response.authenticated) return isPlayerUser(response.user);
	return response.user === undefined;
}

export function isPlayerAllowlistEntry(value: unknown): value is PlayerAllowlistEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	if (!isNonEmptyString(entry.email) || !SIMPLE_EMAIL_PATTERN.test(entry.email)) return false;
	if (!isFiniteNumber(entry.createdAt)) return false;
	if (!isNonEmptyString(entry.addedBy)) return false;
	if (entry.player !== undefined && !isPlayerUser(entry.player)) return false;
	return true;
}
```

- [ ] **Step 4: Re-export web types**

Update the import and export lists in `apps/web/src/lib/types/puzzle.ts` to include:

```ts
(PlayerUser,
	PlayerSessionResponse,
	PlayerAllowlistEntry,
	PlayerAllowlistResponse,
	PlayerAllowlistMutationResponse);
```

- [ ] **Step 5: Run the focused shared type test and verify it passes**

Run:

```bash
cd packages/types && bunx vitest run src/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit shared contracts**

Run:

```bash
git add packages/types/src/index.ts packages/types/src/index.test.ts apps/web/src/lib/types/puzzle.ts
git commit -m "feat: add player auth contracts"
```

## Task 2: Pure Auth Helpers

**Files:**

- Create: `apps/api/src/services/player-auth.shared.ts`
- Test: `apps/api/src/services/player-auth.shared.test.ts`

- [ ] **Step 1: Write failing pure helper tests**

Create `apps/api/src/services/player-auth.shared.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	hashToken,
	normalizeEmail,
	parseReturnTo,
	validateGoogleClaims
} from './player-auth.shared';

describe('player auth shared helpers', () => {
	it('normalizes emails by trimming and lowercasing', () => {
		expect(normalizeEmail('  Player@Example.COM  ')).toBe('player@example.com');
	});

	it.each(['missing-at', '@example.com', 'player@', 'player@example'])(
		'rejects invalid email %s',
		(email) => {
			expect(() => normalizeEmail(email)).toThrow('Invalid email');
		}
	);

	it('accepts only same-origin return paths', () => {
		expect(parseReturnTo('/puzzle/abc')).toBe('/puzzle/abc');
		expect(parseReturnTo(null)).toBe('/');
		expect(parseReturnTo('https://evil.example')).toBe('/');
		expect(parseReturnTo('//evil.example')).toBe('/');
		expect(parseReturnTo('admin')).toBe('/');
	});

	it('creates PKCE verifier and challenge strings', async () => {
		const pair = await createPkcePair();
		expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
		expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(pair.challenge).not.toBe(pair.verifier);
	});

	it('hashes tokens without returning the raw token', async () => {
		const hash = await hashToken('raw-session-token');
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(hash).not.toContain('raw-session-token');
	});

	it('builds a Google authorization URL with required params', async () => {
		const state = createOAuthState();
		const pkce = await createPkcePair();
		const url = buildGoogleAuthUrl({
			clientId: 'client-id',
			redirectUri: 'https://app.example.com/api/auth/google/callback',
			state,
			codeChallenge: pkce.challenge
		});

		expect(url.origin).toBe('https://accounts.google.com');
		expect(url.pathname).toBe('/o/oauth2/v2/auth');
		expect(url.searchParams.get('client_id')).toBe('client-id');
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://app.example.com/api/auth/google/callback'
		);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('scope')).toBe('openid email profile');
		expect(url.searchParams.get('state')).toBe(state);
		expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	});

	it('validates Google claims for the configured audience', () => {
		vi.setSystemTime(1_716_500_000_000);
		const claims = validateGoogleClaims(
			{
				iss: 'https://accounts.google.com',
				aud: 'client-id',
				exp: Math.floor(Date.now() / 1000) + 60,
				sub: 'google-sub-123',
				email: 'Player@Example.COM',
				email_verified: true,
				name: 'Player One',
				picture: 'https://example.com/avatar.png'
			},
			'client-id'
		);

		expect(claims).toEqual({
			sub: 'google-sub-123',
			email: 'player@example.com',
			name: 'Player One',
			picture: 'https://example.com/avatar.png'
		});
	});

	it('rejects unverified Google emails', () => {
		expect(() =>
			validateGoogleClaims(
				{
					iss: 'https://accounts.google.com',
					aud: 'client-id',
					exp: Math.floor(Date.now() / 1000) + 60,
					sub: 'google-sub-123',
					email: 'player@example.com',
					email_verified: false
				},
				'client-id'
			)
		).toThrow('Google email is not verified');
	});
});
```

- [ ] **Step 2: Run helper tests and verify they fail**

Run:

```bash
cd apps/api && bunx vitest run src/services/player-auth.shared.test.ts
```

Expected: FAIL because `player-auth.shared.ts` does not exist.

- [ ] **Step 3: Implement helper module**

Create `apps/api/src/services/player-auth.shared.ts`:

```ts
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PLAYER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export interface GoogleIdentityClaims {
	sub: string;
	email: string;
	name?: string;
	picture?: string;
}

interface GoogleClaimsPayload {
	iss?: unknown;
	aud?: unknown;
	exp?: unknown;
	sub?: unknown;
	email?: unknown;
	email_verified?: unknown;
	name?: unknown;
	picture?: unknown;
}

export function normalizeEmail(email: string): string {
	const normalized = email.trim().toLowerCase();
	if (!EMAIL_PATTERN.test(normalized)) {
		throw new Error('Invalid email');
	}
	return normalized;
}

export function parseReturnTo(value: string | null | undefined): string {
	if (!value) return '/';
	if (!value.startsWith('/') || value.startsWith('//')) return '/';
	try {
		const parsed = new URL(value, 'https://perseus.local');
		if (parsed.origin !== 'https://perseus.local') return '/';
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return '/';
	}
}

function randomBytes(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createOAuthState(): string {
	return bytesToBase64Url(randomBytes(32));
}

export async function createPkcePair(): Promise<PkcePair> {
	const verifier = bytesToBase64Url(randomBytes(32));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return {
		verifier,
		challenge: bytesToBase64Url(new Uint8Array(digest))
	};
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export function buildGoogleAuthUrl(params: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): URL {
	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set('client_id', params.clientId);
	url.searchParams.set('redirect_uri', params.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', 'openid email profile');
	url.searchParams.set('state', params.state);
	url.searchParams.set('code_challenge', params.codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function validateGoogleClaims(
	payload: GoogleClaimsPayload,
	expectedAudience: string
): GoogleIdentityClaims {
	const issuer = readString(payload.iss);
	if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
		throw new Error('Invalid Google token issuer');
	}
	if (payload.aud !== expectedAudience) {
		throw new Error('Invalid Google token audience');
	}
	if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
		throw new Error('Google token expired');
	}
	const sub = readString(payload.sub);
	if (!sub) {
		throw new Error('Google token missing subject');
	}
	const rawEmail = readString(payload.email);
	if (!rawEmail) {
		throw new Error('Google token missing email');
	}
	if (payload.email_verified !== true) {
		throw new Error('Google email is not verified');
	}

	const claims: GoogleIdentityClaims = {
		sub,
		email: normalizeEmail(rawEmail)
	};
	const name = readString(payload.name);
	const picture = readString(payload.picture);
	if (name) claims.name = name;
	if (picture) claims.picture = picture;
	return claims;
}
```

- [ ] **Step 4: Run helper tests and verify they pass**

Run:

```bash
cd apps/api && bunx vitest run src/services/player-auth.shared.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit pure helpers**

Run:

```bash
git add apps/api/src/services/player-auth.shared.ts apps/api/src/services/player-auth.shared.test.ts
git commit -m "feat(api): add player auth helpers"
```

## Task 3: Worker Player Auth Storage

**Files:**

- Create: `apps/api/src/services/player-auth.worker.ts`
- Test: `apps/api/src/services/player-auth.worker.test.ts`

- [ ] **Step 1: Write failing Worker storage tests**

Create `apps/api/src/services/player-auth.worker.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlayerUser } from '@perseus/types';
import {
	addAllowlistEntry,
	createPlayerSession,
	deleteAllowlistEntry,
	getAllowlistEntry,
	getPlayerByEmail,
	getPlayerSession,
	listAllowlistEntries,
	revokePlayerSession,
	revokePlayerSessionsForEmail,
	upsertPlayer
} from './player-auth.worker';

class MemoryKV {
	private store = new Map<string, string>();

	async get(key: string, type?: 'json') {
		const value = this.store.get(key) ?? null;
		if (value === null) return null;
		return type === 'json' ? JSON.parse(value) : value;
	}

	async put(key: string, value: string, _options?: { expirationTtl?: number }) {
		this.store.set(key, value);
	}

	async delete(key: string) {
		this.store.delete(key);
	}

	async list(options?: { prefix?: string }) {
		const prefix = options?.prefix ?? '';
		return {
			keys: [...this.store.keys()]
				.filter((name) => name.startsWith(prefix))
				.sort()
				.map((name) => ({ name })),
			list_complete: true,
			cursor: undefined
		};
	}
}

describe('player auth Worker storage', () => {
	let kv: KVNamespace;

	beforeEach(() => {
		kv = new MemoryKV() as unknown as KVNamespace;
	});

	it('adds, reads, lists, and deletes allowlist entries', async () => {
		const entry = await addAllowlistEntry(kv, ' Player@Example.COM ', 'admin');

		expect(entry.email).toBe('player@example.com');
		expect(await getAllowlistEntry(kv, 'player@example.com')).toMatchObject({
			email: 'player@example.com',
			addedBy: 'admin'
		});
		expect(await listAllowlistEntries(kv)).toHaveLength(1);

		await deleteAllowlistEntry(kv, 'player@example.com');
		expect(await getAllowlistEntry(kv, 'player@example.com')).toBeNull();
	});

	it('upserts players and links them by normalized email', async () => {
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'Player@Example.COM',
			name: 'Player One',
			picture: 'https://example.com/avatar.png'
		});

		expect(player.email).toBe('player@example.com');
		expect(player.id).toBe('google-sub-123');
		expect(await getPlayerByEmail(kv, 'player@example.com')).toMatchObject({
			id: 'google-sub-123',
			email: 'player@example.com'
		});
	});

	it('creates, reads, revokes, and bulk revokes sessions by email', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player: PlayerUser = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});

		const created = await createPlayerSession(kv, player);
		expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(await getPlayerSession(kv, created.token)).toMatchObject({
			user: { id: 'google-sub-123', email: 'player@example.com' }
		});

		await revokePlayerSession(kv, created.token);
		expect(await getPlayerSession(kv, created.token)).toBeNull();

		const second = await createPlayerSession(kv, player);
		await revokePlayerSessionsForEmail(kv, 'player@example.com');
		expect(await getPlayerSession(kv, second.token)).toBeNull();
	});
});
```

- [ ] **Step 2: Run Worker storage tests and verify they fail**

Run:

```bash
cd apps/api && bunx vitest run src/services/player-auth.worker.test.ts
```

Expected: FAIL because `player-auth.worker.ts` does not exist.

- [ ] **Step 3: Implement Worker storage**

Create `apps/api/src/services/player-auth.worker.ts` with these exported signatures:

```ts
import type { PlayerAllowlistEntry, PlayerUser } from '@perseus/types';
import {
	PLAYER_SESSION_DURATION_MS,
	OAUTH_STATE_TTL_SECONDS,
	hashToken,
	normalizeEmail,
	type GoogleIdentityClaims,
	type StoredOAuthState
} from './player-auth.shared';

const ALLOWLIST_PREFIX = 'player_allowlist:';
const PLAYER_PREFIX = 'player:';
const PLAYER_EMAIL_INDEX_PREFIX = 'player_email_index:';
const PLAYER_SESSION_PREFIX = 'player_session:';
const PLAYER_SESSIONS_PREFIX = 'player_sessions:';

export interface CreatedPlayerSession {
	token: string;
	expiresAt: number;
}

export interface PlayerSessionRecord {
	sessionHash: string;
	user: PlayerUser;
	createdAt: number;
	expiresAt: number;
}

function allowlistKey(email: string): string {
	return `${ALLOWLIST_PREFIX}${normalizeEmail(email)}`;
}

function playerKey(id: string): string {
	return `${PLAYER_PREFIX}${id}`;
}

function emailIndexKey(email: string): string {
	return `${PLAYER_EMAIL_INDEX_PREFIX}${normalizeEmail(email)}`;
}

function sessionKey(hash: string): string {
	return `${PLAYER_SESSION_PREFIX}${hash}`;
}

function sessionsIndexKey(playerId: string): string {
	return `${PLAYER_SESSIONS_PREFIX}${playerId}`;
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
	return (await kv.get(key, 'json')) as T | null;
}

async function writeJson(kv: KVNamespace, key: string, value: unknown, ttlSeconds?: number) {
	const options = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
	await kv.put(key, JSON.stringify(value), options);
}

export async function addAllowlistEntry(
	kv: KVNamespace,
	email: string,
	addedBy: string
): Promise<PlayerAllowlistEntry> {
	const normalized = normalizeEmail(email);
	const existing = await getAllowlistEntry(kv, normalized);
	if (existing) return existing;
	const entry: PlayerAllowlistEntry = {
		email: normalized,
		createdAt: Date.now(),
		addedBy
	};
	await writeJson(kv, allowlistKey(normalized), entry);
	return entry;
}

export async function getAllowlistEntry(
	kv: KVNamespace,
	email: string
): Promise<PlayerAllowlistEntry | null> {
	return await readJson<PlayerAllowlistEntry>(kv, allowlistKey(email));
}

export async function listAllowlistEntries(kv: KVNamespace): Promise<PlayerAllowlistEntry[]> {
	const listed = await kv.list({ prefix: ALLOWLIST_PREFIX });
	const entries = await Promise.all(
		listed.keys.map((key) => readJson<PlayerAllowlistEntry>(kv, key.name))
	);
	return entries.filter((entry): entry is PlayerAllowlistEntry => entry !== null);
}

export async function deleteAllowlistEntry(kv: KVNamespace, email: string): Promise<void> {
	await kv.delete(allowlistKey(email));
}

export async function upsertPlayer(
	kv: KVNamespace,
	claims: GoogleIdentityClaims
): Promise<PlayerUser> {
	const email = normalizeEmail(claims.email);
	const existing = await readJson<PlayerUser>(kv, playerKey(claims.sub));
	const now = Date.now();
	const player: PlayerUser = {
		id: claims.sub,
		email,
		createdAt: existing?.createdAt ?? now,
		lastLoginAt: now
	};
	if (claims.name) player.name = claims.name;
	if (claims.picture) player.picture = claims.picture;
	await writeJson(kv, playerKey(player.id), player);
	await kv.put(emailIndexKey(email), player.id);
	return player;
}

export async function getPlayer(kv: KVNamespace, id: string): Promise<PlayerUser | null> {
	return await readJson<PlayerUser>(kv, playerKey(id));
}

export async function getPlayerByEmail(kv: KVNamespace, email: string): Promise<PlayerUser | null> {
	const playerId = await kv.get(emailIndexKey(email));
	return playerId ? await getPlayer(kv, playerId) : null;
}

async function readSessionHashes(kv: KVNamespace, playerId: string): Promise<string[]> {
	return (await readJson<string[]>(kv, sessionsIndexKey(playerId))) ?? [];
}

async function writeSessionHashes(
	kv: KVNamespace,
	playerId: string,
	hashes: string[]
): Promise<void> {
	await writeJson(kv, sessionsIndexKey(playerId), [...new Set(hashes)]);
}

export async function createPlayerSession(
	kv: KVNamespace,
	user: PlayerUser
): Promise<CreatedPlayerSession> {
	const tokenBytes = new Uint8Array(32);
	crypto.getRandomValues(tokenBytes);
	const token = btoa(String.fromCharCode(...tokenBytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
	const sessionHash = await hashToken(token);
	const expiresAt = Date.now() + PLAYER_SESSION_DURATION_MS;
	const record: PlayerSessionRecord = {
		sessionHash,
		user,
		createdAt: Date.now(),
		expiresAt
	};
	await writeJson(
		kv,
		sessionKey(sessionHash),
		record,
		Math.ceil(PLAYER_SESSION_DURATION_MS / 1000)
	);
	await writeSessionHashes(kv, user.id, [...(await readSessionHashes(kv, user.id)), sessionHash]);
	return { token, expiresAt };
}

export async function getPlayerSession(
	kv: KVNamespace,
	token: string
): Promise<PlayerSessionRecord | null> {
	const sessionHash = await hashToken(token);
	const record = await readJson<PlayerSessionRecord>(kv, sessionKey(sessionHash));
	if (!record || record.expiresAt <= Date.now()) return null;
	const allowlistEntry = await getAllowlistEntry(kv, record.user.email);
	if (!allowlistEntry) return null;
	return record;
}

export async function revokePlayerSession(kv: KVNamespace, token: string): Promise<void> {
	await kv.delete(sessionKey(await hashToken(token)));
}

export async function revokePlayerSessionsForEmail(kv: KVNamespace, email: string): Promise<void> {
	const player = await getPlayerByEmail(kv, email);
	if (!player) return;
	const hashes = await readSessionHashes(kv, player.id);
	await Promise.all(hashes.map((hash) => kv.delete(sessionKey(hash))));
	await kv.delete(sessionsIndexKey(player.id));
}
```

- [ ] **Step 4: Run Worker storage tests and verify they pass**

Run:

```bash
cd apps/api && bunx vitest run src/services/player-auth.worker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Worker storage**

Run:

```bash
git add apps/api/src/services/player-auth.worker.ts apps/api/src/services/player-auth.worker.test.ts
git commit -m "feat(api): add worker player auth storage"
```

## Task 4: Bun Player Auth Storage

**Files:**

- Create: `apps/api/src/services/player-auth.ts`
- Test: `apps/api/src/services/player-auth.test.ts`

- [ ] **Step 1: Write failing Bun storage tests**

Create `apps/api/src/services/player-auth.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	addAllowlistEntry,
	createPlayerSession,
	deleteAllowlistEntry,
	getAllowlistEntry,
	getPlayerSession,
	initializePlayerAuthStorage,
	listAllowlistEntries,
	consumeOAuthState,
	revokePlayerSessionsForEmail,
	storeOAuthState,
	upsertPlayer
} from './player-auth';

describe('Bun player auth storage', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'perseus-auth-'));
		process.env.DATA_DIR = dataDir;
		await initializePlayerAuthStorage();
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		delete process.env.DATA_DIR;
	});

	it('persists allowlist entries under DATA_DIR/auth', async () => {
		const entry = await addAllowlistEntry('Player@Example.COM', 'admin');

		expect(entry.email).toBe('player@example.com');
		expect(await getAllowlistEntry('player@example.com')).toMatchObject({
			email: 'player@example.com'
		});
		expect(await listAllowlistEntries()).toHaveLength(1);

		await deleteAllowlistEntry('player@example.com');
		expect(await getAllowlistEntry('player@example.com')).toBeNull();
	});

	it('stores players and revokes active sessions when allowlist is removed', async () => {
		await addAllowlistEntry('player@example.com', 'admin');
		const player = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'player@example.com',
			name: 'Player One'
		});
		const session = await createPlayerSession(player);

		expect(await getPlayerSession(session.token)).toMatchObject({
			user: { email: 'player@example.com' }
		});

		await revokePlayerSessionsForEmail('player@example.com');
		expect(await getPlayerSession(session.token)).toBeNull();
	});

	it('stores OAuth state once and consumes it', async () => {
		await storeOAuthState('state-token', {
			codeVerifier: 'verifier',
			returnTo: '/puzzle/abc'
		});

		expect(await consumeOAuthState('state-token')).toMatchObject({
			state: 'state-token',
			codeVerifier: 'verifier',
			returnTo: '/puzzle/abc'
		});
		expect(await consumeOAuthState('state-token')).toBeNull();
	});
});
```

- [ ] **Step 2: Run Bun storage tests and verify they fail**

Run:

```bash
cd apps/api && bunx vitest run src/services/player-auth.test.ts
```

Expected: FAIL because `player-auth.ts` does not exist.

- [ ] **Step 3: Implement filesystem storage**

Create `apps/api/src/services/player-auth.ts` with the same exported function names as the test.
Use JSON files under `join(process.env.DATA_DIR || './data', 'auth')`:

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlayerAllowlistEntry, PlayerUser } from '@perseus/types';
import {
	PLAYER_SESSION_DURATION_MS,
	hashToken,
	normalizeEmail,
	type GoogleIdentityClaims
} from './player-auth.shared';

interface PlayerSessionRecord {
	sessionHash: string;
	user: PlayerUser;
	createdAt: number;
	expiresAt: number;
}

function authDir(): string {
	return join(process.env.DATA_DIR || './data', 'auth');
}

function filePath(...segments: string[]): string {
	return join(authDir(), ...segments);
}

async function ensureDirs(): Promise<void> {
	await mkdir(filePath('allowlist'), { recursive: true });
	await mkdir(filePath('players'), { recursive: true });
	await mkdir(filePath('email-index'), { recursive: true });
	await mkdir(filePath('sessions'), { recursive: true });
	await mkdir(filePath('session-index'), { recursive: true });
	await mkdir(filePath('oauth-state'), { recursive: true });
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, 'utf-8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await ensureDirs();
	await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

export async function initializePlayerAuthStorage(): Promise<void> {
	await ensureDirs();
}

export async function addAllowlistEntry(
	email: string,
	addedBy: string
): Promise<PlayerAllowlistEntry> {
	const normalized = normalizeEmail(email);
	const existing = await getAllowlistEntry(normalized);
	if (existing) return existing;
	const entry = { email: normalized, createdAt: Date.now(), addedBy };
	await writeJson(filePath('allowlist', `${encodeURIComponent(normalized)}.json`), entry);
	return entry;
}

export async function getAllowlistEntry(email: string): Promise<PlayerAllowlistEntry | null> {
	return await readJson<PlayerAllowlistEntry>(
		filePath('allowlist', `${encodeURIComponent(normalizeEmail(email))}.json`)
	);
}

export async function listAllowlistEntries(): Promise<PlayerAllowlistEntry[]> {
	await ensureDirs();
	const { readdir } = await import('node:fs/promises');
	const files = await readdir(filePath('allowlist'));
	const entries = await Promise.all(
		files
			.filter((file) => file.endsWith('.json'))
			.map((file) => readJson<PlayerAllowlistEntry>(filePath('allowlist', file)))
	);
	return entries.filter((entry): entry is PlayerAllowlistEntry => entry !== null);
}

export async function deleteAllowlistEntry(email: string): Promise<void> {
	await rm(filePath('allowlist', `${encodeURIComponent(normalizeEmail(email))}.json`), {
		force: true
	});
}

export async function upsertPlayer(claims: GoogleIdentityClaims): Promise<PlayerUser> {
	const email = normalizeEmail(claims.email);
	const existing = await readJson<PlayerUser>(filePath('players', `${claims.sub}.json`));
	const now = Date.now();
	const player: PlayerUser = {
		id: claims.sub,
		email,
		createdAt: existing?.createdAt ?? now,
		lastLoginAt: now
	};
	if (claims.name) player.name = claims.name;
	if (claims.picture) player.picture = claims.picture;
	await writeJson(filePath('players', `${player.id}.json`), player);
	await writeFile(filePath('email-index', `${encodeURIComponent(email)}.txt`), player.id, 'utf-8');
	return player;
}

export async function getPlayer(id: string): Promise<PlayerUser | null> {
	return await readJson<PlayerUser>(filePath('players', `${id}.json`));
}

export async function getPlayerByEmail(email: string): Promise<PlayerUser | null> {
	try {
		const playerId = await readFile(
			filePath('email-index', `${encodeURIComponent(normalizeEmail(email))}.txt`),
			'utf-8'
		);
		return await getPlayer(playerId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function sessionIndexPath(playerId: string): Promise<string> {
	await ensureDirs();
	return filePath('session-index', `${playerId}.json`);
}

async function readSessionHashes(playerId: string): Promise<string[]> {
	return (await readJson<string[]>(await sessionIndexPath(playerId))) ?? [];
}

async function writeSessionHashes(playerId: string, hashes: string[]): Promise<void> {
	await writeJson(await sessionIndexPath(playerId), [...new Set(hashes)]);
}

export async function createPlayerSession(
	user: PlayerUser
): Promise<{ token: string; expiresAt: number }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const token = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
	const sessionHash = await hashToken(token);
	const expiresAt = Date.now() + PLAYER_SESSION_DURATION_MS;
	await writeJson(filePath('sessions', `${sessionHash}.json`), {
		sessionHash,
		user,
		createdAt: Date.now(),
		expiresAt
	});
	await writeSessionHashes(user.id, [...(await readSessionHashes(user.id)), sessionHash]);
	return { token, expiresAt };
}

export async function getPlayerSession(token: string): Promise<PlayerSessionRecord | null> {
	const sessionHash = await hashToken(token);
	const record = await readJson<PlayerSessionRecord>(filePath('sessions', `${sessionHash}.json`));
	if (!record || record.expiresAt <= Date.now()) return null;
	if (!(await getAllowlistEntry(record.user.email))) return null;
	return record;
}

export async function revokePlayerSession(token: string): Promise<void> {
	await rm(filePath('sessions', `${await hashToken(token)}.json`), { force: true });
}

export async function revokePlayerSessionsForEmail(email: string): Promise<void> {
	const player = await getPlayerByEmail(email);
	if (!player) return;
	for (const hash of await readSessionHashes(player.id)) {
		await rm(filePath('sessions', `${hash}.json`), { force: true });
	}
	await rm(await sessionIndexPath(player.id), { force: true });
}

export async function storeOAuthState(
	state: string,
	value: Omit<StoredOAuthState, 'state' | 'createdAt'>
): Promise<void> {
	await writeJson(filePath('oauth-state', `${state}.json`), {
		...value,
		state,
		createdAt: Date.now()
	});
}

export async function consumeOAuthState(state: string): Promise<StoredOAuthState | null> {
	const path = filePath('oauth-state', `${state}.json`);
	const value = await readJson<StoredOAuthState>(path);
	await rm(path, { force: true });
	if (!value) return null;
	if (Date.now() - value.createdAt > OAUTH_STATE_TTL_SECONDS * 1000) return null;
	return value;
}
```

- [ ] **Step 4: Run Bun storage tests and verify they pass**

Run:

```bash
cd apps/api && bunx vitest run src/services/player-auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Bun storage**

Run:

```bash
git add apps/api/src/services/player-auth.ts apps/api/src/services/player-auth.test.ts
git commit -m "feat(api): add bun player auth storage"
```

## Task 5: Worker Player Auth Routes

**Files:**

- Create: `apps/api/src/routes/auth.worker.ts`
- Modify: `apps/api/src/worker.ts`
- Test: `apps/api/src/routes/__tests__/auth.worker.test.ts`

- [ ] **Step 1: Write failing Worker auth route tests**

Create `apps/api/src/routes/__tests__/auth.worker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/player-auth.worker', () => ({
	addAllowlistEntry: vi.fn(),
	createPlayerSession: vi.fn(),
	getAllowlistEntry: vi.fn(),
	getPlayerSession: vi.fn(),
	revokePlayerSession: vi.fn(),
	storeOAuthState: vi.fn(),
	consumeOAuthState: vi.fn(),
	upsertPlayer: vi.fn()
}));

vi.mock('../../services/player-auth.shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/player-auth.shared')>();
	return {
		...actual,
		validateGoogleClaims: vi.fn(),
		verifyGoogleIdToken: vi.fn(),
		exchangeGoogleCode: vi.fn()
	};
});

import authRoutes from '../auth.worker';
import * as storage from '../../services/player-auth.worker';
import * as shared from '../../services/player-auth.shared';

const env = {
	GOOGLE_CLIENT_ID: 'client-id',
	GOOGLE_CLIENT_SECRET: 'client-secret',
	AUTH_REDIRECT_BASE_URL: 'https://app.example.com',
	PUZZLE_METADATA: {} as KVNamespace,
	NODE_ENV: 'production'
};

describe('Worker player auth routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('redirects Google start requests to Google and sets state cookie', async () => {
		const res = await authRoutes.fetch(
			new Request('https://app.example.com/google/start?returnTo=/puzzle/abc'),
			env as never
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toContain('https://accounts.google.com/o/oauth2/v2/auth');
		expect(res.headers.get('set-cookie')).toContain('perseus_oauth_state=');
		expect(storage.storeOAuthState).toHaveBeenCalledWith(
			env.PUZZLE_METADATA,
			expect.any(String),
			expect.objectContaining({ returnTo: '/puzzle/abc' })
		);
	});

	it('redirects not-allowed users back to login', async () => {
		(storage.consumeOAuthState as ReturnType<typeof vi.fn>).mockResolvedValue({
			state: 'state',
			codeVerifier: 'verifier',
			returnTo: '/'
		});
		(shared.exchangeGoogleCode as ReturnType<typeof vi.fn>).mockResolvedValue({
			id_token: 'id-token'
		});
		(shared.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		(storage.getAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const res = await authRoutes.fetch(
			new Request('https://app.example.com/google/callback?state=state&code=code', {
				headers: { cookie: 'perseus_oauth_state=state' }
			}),
			env as never
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/login?error=not_allowed');
	});

	it('creates a session for allowlisted verified users', async () => {
		(storage.consumeOAuthState as ReturnType<typeof vi.fn>).mockResolvedValue({
			state: 'state',
			codeVerifier: 'verifier',
			returnTo: '/puzzle/abc'
		});
		(shared.exchangeGoogleCode as ReturnType<typeof vi.fn>).mockResolvedValue({
			id_token: 'id-token'
		});
		(shared.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
			sub: 'google-sub-123',
			email: 'player@example.com',
			name: 'Player One'
		});
		(storage.getAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
			email: 'player@example.com',
			createdAt: 1,
			addedBy: 'admin'
		});
		(storage.upsertPlayer as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'google-sub-123',
			email: 'player@example.com',
			name: 'Player One',
			createdAt: 1,
			lastLoginAt: 2
		});
		(storage.createPlayerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			token: 'session-token',
			expiresAt: Date.now() + 1000
		});

		const res = await authRoutes.fetch(
			new Request('https://app.example.com/google/callback?state=state&code=code', {
				headers: { cookie: 'perseus_oauth_state=state' }
			}),
			env as never
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/puzzle/abc');
		expect(res.headers.get('set-cookie')).toContain('perseus_player_session=session-token');
	});

	it('returns authenticated session state for valid sessions', async () => {
		(storage.getPlayerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1,
				lastLoginAt: 2
			}
		});

		const res = await authRoutes.fetch(
			new Request('https://app.example.com/session', {
				headers: { cookie: 'perseus_player_session=session-token' }
			}),
			env as never
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			authenticated: true,
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1,
				lastLoginAt: 2
			}
		});
	});
});
```

- [ ] **Step 2: Run Worker route tests and verify they fail**

Run:

```bash
cd apps/api && bunx vitest run src/routes/__tests__/auth.worker.test.ts
```

Expected: FAIL because `auth.worker.ts` is missing and token helper exports are incomplete.

- [ ] **Step 3: Add Google token helper exports**

Extend `apps/api/src/services/player-auth.shared.ts` with:

```ts
export interface GoogleTokenResponse {
	id_token: string;
	access_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
}

export interface StoredOAuthState {
	state: string;
	codeVerifier: string;
	returnTo: string;
	createdAt: number;
}

export async function exchangeGoogleCode(params: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	codeVerifier: string;
}): Promise<GoogleTokenResponse> {
	const body = new URLSearchParams();
	body.set('code', params.code);
	body.set('client_id', params.clientId);
	body.set('client_secret', params.clientSecret);
	body.set('redirect_uri', params.redirectUri);
	body.set('grant_type', 'authorization_code');
	body.set('code_verifier', params.codeVerifier);

	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!response.ok) {
		throw new Error(`Google token exchange failed with ${response.status}`);
	}
	const payload = (await response.json()) as Record<string, unknown>;
	if (typeof payload.id_token !== 'string') {
		throw new Error('Google token response missing id_token');
	}
	return payload as unknown as GoogleTokenResponse;
}

export async function verifyGoogleIdToken(
	idToken: string,
	clientId: string
): Promise<GoogleIdentityClaims> {
	const response = await fetch(
		`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
	);
	if (!response.ok) {
		throw new Error(`Google ID token verification failed with ${response.status}`);
	}
	return validateGoogleClaims((await response.json()) as Record<string, unknown>, clientId);
}
```

- [ ] **Step 4: Add OAuth state storage to Worker storage**

Add these exports to `apps/api/src/services/player-auth.worker.ts`:

```ts
import type { StoredOAuthState } from './player-auth.shared';
import { OAUTH_STATE_TTL_SECONDS } from './player-auth.shared';

const OAUTH_STATE_PREFIX = 'oauth_state:';

function oauthStateKey(state: string): string {
	return `${OAUTH_STATE_PREFIX}${state}`;
}

export async function storeOAuthState(
	kv: KVNamespace,
	state: string,
	value: Omit<StoredOAuthState, 'state' | 'createdAt'>
): Promise<void> {
	await writeJson(
		kv,
		oauthStateKey(state),
		{ ...value, state, createdAt: Date.now() },
		OAUTH_STATE_TTL_SECONDS
	);
}

export async function consumeOAuthState(
	kv: KVNamespace,
	state: string
): Promise<StoredOAuthState | null> {
	const key = oauthStateKey(state);
	const value = await readJson<StoredOAuthState>(kv, key);
	await kv.delete(key);
	return value;
}
```

- [ ] **Step 5: Implement Worker auth routes**

Create `apps/api/src/routes/auth.worker.ts`:

```ts
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../worker';
import {
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	exchangeGoogleCode,
	parseReturnTo,
	verifyGoogleIdToken,
	PLAYER_SESSION_DURATION_MS
} from '../services/player-auth.shared';
import {
	consumeOAuthState,
	createPlayerSession,
	getAllowlistEntry,
	getPlayerSession,
	revokePlayerSession,
	storeOAuthState,
	upsertPlayer
} from '../services/player-auth.worker';

const PLAYER_SESSION_COOKIE = 'perseus_player_session';
const OAUTH_STATE_COOKIE = 'perseus_oauth_state';

const auth = new Hono<{ Bindings: Env }>();

function redirectBase(env: Env): string {
	if (!env.AUTH_REDIRECT_BASE_URL) throw new Error('AUTH_REDIRECT_BASE_URL is required');
	return env.AUTH_REDIRECT_BASE_URL.replace(/\/+$/, '');
}

function callbackUrl(env: Env): string {
	return `${redirectBase(env)}/api/auth/google/callback`;
}

function cookieOptions(env: Env, maxAge: number) {
	return {
		httpOnly: true,
		secure: env.NODE_ENV !== 'development',
		sameSite: 'Lax' as const,
		path: '/',
		maxAge
	};
}

function loginRedirect(error: string): Response {
	return Response.redirect(`/login?error=${encodeURIComponent(error)}`, 302);
}

auth.get('/google/start', async (c) => {
	const state = createOAuthState();
	const pkce = await createPkcePair();
	const returnTo = parseReturnTo(c.req.query('returnTo'));
	await storeOAuthState(c.env.PUZZLE_METADATA, state, {
		codeVerifier: pkce.verifier,
		returnTo
	});
	setCookie(c, OAUTH_STATE_COOKIE, state, cookieOptions(c.env, 10 * 60));
	return c.redirect(
		buildGoogleAuthUrl({
			clientId: c.env.GOOGLE_CLIENT_ID,
			redirectUri: callbackUrl(c.env),
			state,
			codeChallenge: pkce.challenge
		}).toString()
	);
});

auth.get('/google/callback', async (c) => {
	const state = c.req.query('state');
	const code = c.req.query('code');
	if (!state || !code || getCookie(c, OAUTH_STATE_COOKIE) !== state) {
		return loginRedirect('session_expired');
	}

	const stored = await consumeOAuthState(c.env.PUZZLE_METADATA, state);
	if (!stored) return loginRedirect('session_expired');

	try {
		const tokenResponse = await exchangeGoogleCode({
			code,
			clientId: c.env.GOOGLE_CLIENT_ID,
			clientSecret: c.env.GOOGLE_CLIENT_SECRET,
			redirectUri: callbackUrl(c.env),
			codeVerifier: stored.codeVerifier
		});
		const claims = await verifyGoogleIdToken(tokenResponse.id_token, c.env.GOOGLE_CLIENT_ID);
		const allowlistEntry = await getAllowlistEntry(c.env.PUZZLE_METADATA, claims.email);
		if (!allowlistEntry) return loginRedirect('not_allowed');
		const player = await upsertPlayer(c.env.PUZZLE_METADATA, claims);
		const session = await createPlayerSession(c.env.PUZZLE_METADATA, player);
		setCookie(
			c,
			PLAYER_SESSION_COOKIE,
			session.token,
			cookieOptions(c.env, Math.floor(PLAYER_SESSION_DURATION_MS / 1000))
		);
		deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
		return c.redirect(stored.returnTo);
	} catch (error) {
		console.error('Player Google OAuth callback failed:', error);
		return loginRedirect('google_error');
	}
});

auth.get('/session', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (!token) return c.json({ authenticated: false });
	const session = await getPlayerSession(c.env.PUZZLE_METADATA, token);
	if (!session) {
		deleteCookie(c, PLAYER_SESSION_COOKIE, { path: '/' });
		return c.json({ authenticated: false });
	}
	return c.json({ authenticated: true, user: session.user });
});

auth.post('/logout', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (token) await revokePlayerSession(c.env.PUZZLE_METADATA, token);
	deleteCookie(c, PLAYER_SESSION_COOKIE, { path: '/' });
	return c.json({ success: true });
});

export default auth;
```

- [ ] **Step 6: Mount Worker routes and env bindings**

Modify `apps/api/src/worker.ts`:

```ts
export interface Env {
	PUZZLES_BUCKET: R2Bucket;
	PUZZLE_METADATA: KVNamespace;
	PUZZLE_METADATA_DO: DurableObjectNamespace;
	PUZZLE_WORKFLOW: WorkflowBinding<WorkflowParams>;
	JWT_SECRET: string;
	ADMIN_PASSKEY: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	AUTH_REDIRECT_BASE_URL: string;
	ALLOWED_ORIGINS?: string;
	NODE_ENV?: string;
	TRUSTED_PROXY?: string;
	TRUSTED_PROXY_LIST?: string;
	ASSETS: Fetcher;
}
```

Add missing production env checks:

```ts
if (!env.GOOGLE_CLIENT_ID) missingEnv.push('GOOGLE_CLIENT_ID');
if (!env.GOOGLE_CLIENT_SECRET) missingEnv.push('GOOGLE_CLIENT_SECRET');
if (!env.AUTH_REDIRECT_BASE_URL) missingEnv.push('AUTH_REDIRECT_BASE_URL');
```

Import and mount:

```ts
import auth from './routes/auth.worker';

app.route('/api/auth', auth);
```

- [ ] **Step 7: Run Worker route tests and verify they pass**

Run:

```bash
cd apps/api && bunx vitest run src/routes/__tests__/auth.worker.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Worker auth routes**

Run:

```bash
git add apps/api/src/routes/auth.worker.ts apps/api/src/routes/__tests__/auth.worker.test.ts apps/api/src/services/player-auth.shared.ts apps/api/src/services/player-auth.worker.ts apps/api/src/worker.ts
git commit -m "feat(api): add worker player auth routes"
```

## Task 6: Bun Player Auth Routes

**Files:**

- Create: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing Bun auth route tests**

Create `apps/api/src/routes/__tests__/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.AUTH_REDIRECT_BASE_URL = 'http://localhost:4690';

vi.mock('../../services/player-auth', () => ({
	createPlayerSession: vi.fn(),
	getAllowlistEntry: vi.fn(),
	getPlayerSession: vi.fn(),
	revokePlayerSession: vi.fn(),
	storeOAuthState: vi.fn(),
	consumeOAuthState: vi.fn(),
	upsertPlayer: vi.fn()
}));

vi.mock('../../services/player-auth.shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/player-auth.shared')>();
	return {
		...actual,
		verifyGoogleIdToken: vi.fn(),
		exchangeGoogleCode: vi.fn()
	};
});

import authRoutes from '../auth';
import * as storage from '../../services/player-auth';

describe('Bun player auth routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns unauthenticated session when cookie is missing', async () => {
		const res = await authRoutes.fetch(new Request('http://localhost/session'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authenticated: false });
	});

	it('returns authenticated session when cookie maps to active session', async () => {
		(storage.getPlayerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1,
				lastLoginAt: 2
			}
		});

		const res = await authRoutes.fetch(
			new Request('http://localhost/session', {
				headers: { cookie: 'perseus_player_session=session-token' }
			})
		);

		expect(await res.json()).toEqual({
			authenticated: true,
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1,
				lastLoginAt: 2
			}
		});
	});
});
```

- [ ] **Step 2: Run Bun route tests and verify they fail**

Run:

```bash
cd apps/api && bunx vitest run src/routes/__tests__/auth.test.ts
```

Expected: FAIL because `auth.ts` does not exist.

- [ ] **Step 3: Implement Bun auth routes**

Create `apps/api/src/routes/auth.ts`:

```ts
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	exchangeGoogleCode,
	parseReturnTo,
	verifyGoogleIdToken,
	PLAYER_SESSION_DURATION_MS
} from '../services/player-auth.shared';
import {
	consumeOAuthState,
	createPlayerSession,
	getAllowlistEntry,
	getPlayerSession,
	revokePlayerSession,
	storeOAuthState,
	upsertPlayer
} from '../services/player-auth';

const PLAYER_SESSION_COOKIE = 'perseus_player_session';
const OAUTH_STATE_COOKIE = 'perseus_oauth_state';

const auth = new Hono();

function requireEnvValue(name: string): string {
	const value = process.env[name];
	if (!value || value.trim().length === 0) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function callbackUrl(): string {
	return `${requireEnvValue('AUTH_REDIRECT_BASE_URL').replace(/\/+$/, '')}/api/auth/google/callback`;
}

function cookieOptions(maxAge: number) {
	return {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'Lax' as const,
		path: '/',
		maxAge
	};
}

function loginRedirect(error: string): Response {
	return Response.redirect(`/login?error=${encodeURIComponent(error)}`, 302);
}

auth.get('/google/start', async (c) => {
	const state = createOAuthState();
	const pkce = await createPkcePair();
	const returnTo = parseReturnTo(c.req.query('returnTo'));
	await storeOAuthState(state, {
		codeVerifier: pkce.verifier,
		returnTo
	});
	setCookie(c, OAUTH_STATE_COOKIE, state, cookieOptions(10 * 60));
	return c.redirect(
		buildGoogleAuthUrl({
			clientId: requireEnvValue('GOOGLE_CLIENT_ID'),
			redirectUri: callbackUrl(),
			state,
			codeChallenge: pkce.challenge
		}).toString()
	);
});

auth.get('/google/callback', async (c) => {
	const state = c.req.query('state');
	const code = c.req.query('code');
	if (!state || !code || getCookie(c, OAUTH_STATE_COOKIE) !== state) {
		return loginRedirect('session_expired');
	}

	const stored = await consumeOAuthState(state);
	if (!stored) return loginRedirect('session_expired');

	try {
		const tokenResponse = await exchangeGoogleCode({
			code,
			clientId: requireEnvValue('GOOGLE_CLIENT_ID'),
			clientSecret: requireEnvValue('GOOGLE_CLIENT_SECRET'),
			redirectUri: callbackUrl(),
			codeVerifier: stored.codeVerifier
		});
		const claims = await verifyGoogleIdToken(
			tokenResponse.id_token,
			requireEnvValue('GOOGLE_CLIENT_ID')
		);
		const allowlistEntry = await getAllowlistEntry(claims.email);
		if (!allowlistEntry) return loginRedirect('not_allowed');
		const player = await upsertPlayer(claims);
		const session = await createPlayerSession(player);
		setCookie(
			c,
			PLAYER_SESSION_COOKIE,
			session.token,
			cookieOptions(Math.floor(PLAYER_SESSION_DURATION_MS / 1000))
		);
		deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
		return c.redirect(stored.returnTo);
	} catch (error) {
		console.error('Player Google OAuth callback failed:', error);
		return loginRedirect('google_error');
	}
});

auth.get('/session', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (!token) return c.json({ authenticated: false });
	const session = await getPlayerSession(token);
	if (!session) {
		deleteCookie(c, PLAYER_SESSION_COOKIE, { path: '/' });
		return c.json({ authenticated: false });
	}
	return c.json({ authenticated: true, user: session.user });
});

auth.post('/logout', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (token) await revokePlayerSession(token);
	deleteCookie(c, PLAYER_SESSION_COOKIE, { path: '/' });
	return c.json({ success: true });
});

export default auth;
```

- [ ] **Step 4: Mount Bun routes and initialize auth storage**

Modify `apps/api/src/index.ts`:

```ts
import auth from './routes/auth';
import { initializePlayerAuthStorage } from './services/player-auth';

requireEnv('GOOGLE_CLIENT_ID');
requireEnv('GOOGLE_CLIENT_SECRET');
requireEnv('AUTH_REDIRECT_BASE_URL');

await initializePlayerAuthStorage();

app.route('/api/auth', auth);
```

- [ ] **Step 5: Run Bun route tests and verify they pass**

Run:

```bash
cd apps/api && bunx vitest run src/routes/__tests__/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Bun auth routes**

Run:

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/__tests__/auth.test.ts apps/api/src/index.ts
git commit -m "feat(api): add bun player auth routes"
```

## Task 7: Admin Allowlist API

**Files:**

- Modify: `apps/api/src/routes/admin.worker.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Test: `apps/api/src/routes/__tests__/admin.worker.test.ts`
- Test: `apps/api/src/routes/__tests__/admin.test.ts`

- [ ] **Step 1: Add failing admin allowlist route tests**

Add this Worker mock and import near the top of
`apps/api/src/routes/__tests__/admin.worker.test.ts`, then add the describe block below:

```ts
vi.mock('../../services/player-auth.worker', () => ({
	addAllowlistEntry: vi.fn(),
	deleteAllowlistEntry: vi.fn(),
	getPlayerByEmail: vi.fn(),
	listAllowlistEntries: vi.fn(),
	revokePlayerSessionsForEmail: vi.fn()
}));

import * as playerAuth from '../../services/player-auth.worker';

describe('Admin Routes - Player Allowlist', () => {
	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists allowlist entries with linked player metadata', async () => {
		(playerAuth.listAllowlistEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ email: 'player@example.com', createdAt: 1, addedBy: 'admin' }
		]);
		(playerAuth.getPlayerByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'google-sub-123',
			email: 'player@example.com',
			createdAt: 1,
			lastLoginAt: 2
		});

		const res = await admin.fetch(new Request('http://localhost/player-allowlist'), mockEnv as any);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			entries: [
				{
					email: 'player@example.com',
					createdAt: 1,
					addedBy: 'admin',
					player: {
						id: 'google-sub-123',
						email: 'player@example.com',
						createdAt: 1,
						lastLoginAt: 2
					}
				}
			]
		});
	});

	it('adds a normalized allowlist email', async () => {
		(playerAuth.addAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
			email: 'player@example.com',
			createdAt: 1,
			addedBy: 'admin'
		});

		const res = await admin.fetch(
			new Request('http://localhost/player-allowlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'Player@Example.COM' })
			}),
			mockEnv as any
		);

		expect(res.status).toBe(200);
		expect(playerAuth.addAllowlistEntry).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'Player@Example.COM',
			'admin'
		);
	});

	it('removes an email and revokes active sessions', async () => {
		const res = await admin.fetch(
			new Request('http://localhost/player-allowlist/player%40example.com', {
				method: 'DELETE'
			}),
			mockEnv as any
		);

		expect(res.status).toBe(200);
		expect(playerAuth.revokePlayerSessionsForEmail).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'player@example.com'
		);
		expect(playerAuth.deleteAllowlistEntry).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'player@example.com'
		);
	});
});
```

Add this Bun mock near the other mocks in `apps/api/src/routes/__tests__/admin.test.ts`:

```ts
vi.mock('../../services/player-auth', () => ({
	addAllowlistEntry: vi.fn(),
	deleteAllowlistEntry: vi.fn(),
	getPlayerByEmail: vi.fn(),
	listAllowlistEntries: vi.fn(),
	revokePlayerSessionsForEmail: vi.fn()
}));
```

Add this import after the dynamic module imports are set up:

```ts
let playerAuthMock: any;

beforeAll(async () => {
	const adminModule = await import('../admin');
	app = adminModule.default;
	storageMock = await import('../../services/storage');
	authMock = await import('../../middleware/auth');
	generatorMock = await import('../../services/puzzle-generator');
	playerAuthMock = await import('../../services/player-auth');
});
```

Append this Bun route coverage:

```ts
describe('GET /player-allowlist', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns allowlist entries with linked player metadata', async () => {
		(playerAuthMock.listAllowlistEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ email: 'player@example.com', createdAt: 1, addedBy: 'admin' }
		]);
		(playerAuthMock.getPlayerByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'google-sub-123',
			email: 'player@example.com',
			createdAt: 1,
			lastLoginAt: 2
		});

		const res = await app.fetch(new Request('http://localhost/player-allowlist'));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			entries: [
				{
					email: 'player@example.com',
					createdAt: 1,
					addedBy: 'admin',
					player: {
						id: 'google-sub-123',
						email: 'player@example.com',
						createdAt: 1,
						lastLoginAt: 2
					}
				}
			]
		});
	});
});

describe('POST /player-allowlist', () => {
	it('adds an allowlist email through the filesystem service', async () => {
		(playerAuthMock.addAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
			email: 'player@example.com',
			createdAt: 1,
			addedBy: 'admin'
		});

		const res = await app.fetch(
			new Request('http://localhost/player-allowlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'Player@Example.COM' })
			})
		);

		expect(res.status).toBe(200);
		expect(playerAuthMock.addAllowlistEntry).toHaveBeenCalledWith('Player@Example.COM', 'admin');
	});
});

describe('DELETE /player-allowlist/:email', () => {
	it('removes an allowlist email and revokes active sessions', async () => {
		const res = await app.fetch(
			new Request('http://localhost/player-allowlist/player%40example.com', {
				method: 'DELETE'
			})
		);

		expect(res.status).toBe(200);
		expect(playerAuthMock.revokePlayerSessionsForEmail).toHaveBeenCalledWith('player@example.com');
		expect(playerAuthMock.deleteAllowlistEntry).toHaveBeenCalledWith('player@example.com');
	});
});
```

- [ ] **Step 2: Run admin route tests and verify they fail**

Run:

```bash
cd apps/api && bunx vitest run src/routes/__tests__/admin.worker.test.ts src/routes/__tests__/admin.test.ts
```

Expected: FAIL because allowlist routes are missing.

- [ ] **Step 3: Add Worker allowlist routes**

In `apps/api/src/routes/admin.worker.ts`, import:

```ts
import {
	addAllowlistEntry,
	deleteAllowlistEntry,
	getPlayerByEmail,
	listAllowlistEntries,
	revokePlayerSessionsForEmail
} from '../services/player-auth.worker';
```

Add routes before `export default admin`:

```ts
admin.get('/player-allowlist', requireAuth, async (c) => {
	const entries = await listAllowlistEntries(c.env.PUZZLE_METADATA);
	const withPlayers = await Promise.all(
		entries.map(async (entry) => ({
			...entry,
			player: (await getPlayerByEmail(c.env.PUZZLE_METADATA, entry.email)) ?? undefined
		}))
	);
	return c.json({ entries: withPlayers });
});

admin.post('/player-allowlist', requireAuth, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const email = (body as { email?: unknown }).email;
	if (typeof email !== 'string') {
		return c.json({ error: 'bad_request', message: 'Email is required' }, 400);
	}
	try {
		const entry = await addAllowlistEntry(c.env.PUZZLE_METADATA, email, 'admin');
		return c.json({ entry });
	} catch (error) {
		if (error instanceof Error && error.message === 'Invalid email') {
			return c.json({ error: 'bad_request', message: 'Enter a valid email address' }, 400);
		}
		throw error;
	}
});

admin.delete('/player-allowlist/:email', requireAuth, async (c) => {
	const email = decodeURIComponent(c.req.param('email'));
	try {
		await revokePlayerSessionsForEmail(c.env.PUZZLE_METADATA, email);
		await deleteAllowlistEntry(c.env.PUZZLE_METADATA, email);
		return c.json({ success: true });
	} catch (error) {
		if (error instanceof Error && error.message === 'Invalid email') {
			return c.json({ error: 'bad_request', message: 'Enter a valid email address' }, 400);
		}
		throw error;
	}
});
```

- [ ] **Step 4: Add Bun allowlist routes**

In `apps/api/src/routes/admin.ts`, import:

```ts
import {
	addAllowlistEntry,
	deleteAllowlistEntry,
	getPlayerByEmail,
	listAllowlistEntries,
	revokePlayerSessionsForEmail
} from '../services/player-auth';
```

Add routes before `export default admin`:

```ts
admin.get('/player-allowlist', requireAuth, async (c) => {
	const entries = await listAllowlistEntries();
	const withPlayers = await Promise.all(
		entries.map(async (entry) => ({
			...entry,
			player: (await getPlayerByEmail(entry.email)) ?? undefined
		}))
	);
	return c.json({ entries: withPlayers });
});

admin.post('/player-allowlist', requireAuth, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const email = (body as { email?: unknown }).email;
	if (typeof email !== 'string') {
		return c.json({ error: 'bad_request', message: 'Email is required' }, 400);
	}
	try {
		const entry = await addAllowlistEntry(email, 'admin');
		return c.json({ entry });
	} catch (error) {
		if (error instanceof Error && error.message === 'Invalid email') {
			return c.json({ error: 'bad_request', message: 'Enter a valid email address' }, 400);
		}
		throw error;
	}
});

admin.delete('/player-allowlist/:email', requireAuth, async (c) => {
	const email = decodeURIComponent(c.req.param('email'));
	try {
		await revokePlayerSessionsForEmail(email);
		await deleteAllowlistEntry(email);
		return c.json({ success: true });
	} catch (error) {
		if (error instanceof Error && error.message === 'Invalid email') {
			return c.json({ error: 'bad_request', message: 'Enter a valid email address' }, 400);
		}
		throw error;
	}
});
```

- [ ] **Step 5: Run admin route tests and verify they pass**

Run:

```bash
cd apps/api && bunx vitest run src/routes/__tests__/admin.worker.test.ts src/routes/__tests__/admin.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit admin API**

Run:

```bash
git add apps/api/src/routes/admin.worker.ts apps/api/src/routes/admin.ts apps/api/src/routes/__tests__/admin.worker.test.ts apps/api/src/routes/__tests__/admin.test.ts
git commit -m "feat(api): add player allowlist admin routes"
```

## Task 8: Web API Client And Auth Store

**Files:**

- Modify: `apps/web/src/lib/services/api.ts`
- Create: `apps/web/src/lib/stores/playerAuth.ts`
- Test: `apps/web/src/lib/services/__tests__/api.test.ts`
- Test: `apps/web/src/lib/stores/playerAuth.test.ts`

- [ ] **Step 1: Add failing API client tests**

Append to `apps/web/src/lib/services/__tests__/api.test.ts`:

```ts
import {
	addPlayerAllowlistEntry,
	fetchPlayerAllowlist,
	getPlayerSession,
	logoutPlayer,
	removePlayerAllowlistEntry
} from '../api';

it('fetches player session with credentials', async () => {
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify({ authenticated: false }), {
			headers: { 'Content-Type': 'application/json' }
		})
	);

	await expect(getPlayerSession()).resolves.toEqual({ authenticated: false });
	expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'include' });
});

it('posts player logout with credentials', async () => {
	fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

	await expect(logoutPlayer()).resolves.toBeUndefined();
	expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
		method: 'POST',
		credentials: 'include'
	});
});

it('manages player allowlist entries through admin API', async () => {
	fetchMock
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ entries: [] }), {
				headers: { 'Content-Type': 'application/json' }
			})
		)
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ entry: { email: 'player@example.com', createdAt: 1, addedBy: 'admin' } }),
				{
					headers: { 'Content-Type': 'application/json' }
				}
			)
		)
		.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

	await fetchPlayerAllowlist();
	await addPlayerAllowlistEntry('player@example.com');
	await removePlayerAllowlistEntry('player@example.com');

	expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/player-allowlist', {
		credentials: 'include'
	});
	expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/player-allowlist', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ email: 'player@example.com' })
	});
	expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/player-allowlist/player%40example.com', {
		method: 'DELETE',
		credentials: 'include'
	});
});
```

- [ ] **Step 2: Add failing auth store tests**

Create `apps/web/src/lib/stores/playerAuth.test.ts`:

```ts
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayerAuthStore } from './playerAuth';
import { getPlayerSession, logoutPlayer } from '$lib/services/api';

vi.mock('$lib/services/api', () => ({
	getPlayerSession: vi.fn(),
	logoutPlayer: vi.fn()
}));

describe('playerAuth store', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('loads authenticated user state', async () => {
		vi.mocked(getPlayerSession).mockResolvedValue({
			authenticated: true,
			user: { id: 'google-sub-123', email: 'player@example.com', createdAt: 1, lastLoginAt: 2 }
		});
		const store = createPlayerAuthStore();

		await store.refresh();

		expect(get(store).user?.email).toBe('player@example.com');
		expect(get(store).status).toBe('authenticated');
	});

	it('clears state after logout', async () => {
		vi.mocked(getPlayerSession).mockResolvedValue({
			authenticated: true,
			user: { id: 'google-sub-123', email: 'player@example.com', createdAt: 1, lastLoginAt: 2 }
		});
		vi.mocked(logoutPlayer).mockResolvedValue(undefined);
		const store = createPlayerAuthStore();
		await store.refresh();

		await store.logout();

		expect(logoutPlayer).toHaveBeenCalled();
		expect(get(store)).toEqual({ status: 'anonymous', user: null, error: null });
	});
});
```

- [ ] **Step 3: Run web client/store tests and verify they fail**

Run:

```bash
cd apps/web && bunx vitest --run --browser src/lib/services/__tests__/api.test.ts src/lib/stores/playerAuth.test.ts
```

Expected: FAIL because new functions and store are missing.

- [ ] **Step 4: Implement API client functions**

In `apps/web/src/lib/services/api.ts`, import player types and add:

```ts
export async function getPlayerSession(): Promise<PlayerSessionResponse> {
	const response = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
	return handleResponse<PlayerSessionResponse>(response);
}

export async function logoutPlayer(): Promise<void> {
	const response = await fetch(`${API_BASE}/api/auth/logout`, {
		method: 'POST',
		credentials: 'include'
	});
	await handleVoidResponse(response);
}

export function getGoogleLoginUrl(returnTo = '/'): string {
	const params = new URLSearchParams({ returnTo });
	return `${API_BASE}/api/auth/google/start?${params.toString()}`;
}

export async function fetchPlayerAllowlist(): Promise<PlayerAllowlistEntry[]> {
	const response = await fetch(`${API_BASE}/api/admin/player-allowlist`, {
		credentials: 'include'
	});
	const data = await handleResponse<PlayerAllowlistResponse>(response);
	return data.entries;
}

export async function addPlayerAllowlistEntry(email: string): Promise<PlayerAllowlistEntry> {
	const response = await fetch(`${API_BASE}/api/admin/player-allowlist`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ email })
	});
	const data = await handleResponse<PlayerAllowlistMutationResponse>(response);
	return data.entry;
}

export async function removePlayerAllowlistEntry(email: string): Promise<void> {
	const response = await fetch(
		`${API_BASE}/api/admin/player-allowlist/${encodeURIComponent(email)}`,
		{
			method: 'DELETE',
			credentials: 'include'
		}
	);
	await handleVoidResponse(response);
}
```

- [ ] **Step 5: Implement auth store**

Create `apps/web/src/lib/stores/playerAuth.ts`:

```ts
import { writable } from 'svelte/store';
import type { PlayerUser } from '$lib/types/puzzle';
import { getPlayerSession, logoutPlayer } from '$lib/services/api';

export interface PlayerAuthState {
	status: 'loading' | 'authenticated' | 'anonymous';
	user: PlayerUser | null;
	error: string | null;
}

export function createPlayerAuthStore() {
	const store = writable<PlayerAuthState>({ status: 'loading', user: null, error: null });

	return {
		subscribe: store.subscribe,
		async refresh() {
			store.set({ status: 'loading', user: null, error: null });
			try {
				const session = await getPlayerSession();
				if (session.authenticated) {
					store.set({ status: 'authenticated', user: session.user, error: null });
				} else {
					store.set({ status: 'anonymous', user: null, error: null });
				}
			} catch {
				store.set({ status: 'anonymous', user: null, error: null });
			}
		},
		async logout() {
			try {
				await logoutPlayer();
			} finally {
				store.set({ status: 'anonymous', user: null, error: null });
			}
		}
	};
}

export const playerAuth = createPlayerAuthStore();
```

- [ ] **Step 6: Run web client/store tests and verify they pass**

Run:

```bash
cd apps/web && bunx vitest --run --browser src/lib/services/__tests__/api.test.ts src/lib/stores/playerAuth.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit web client/store**

Run:

```bash
git add apps/web/src/lib/services/api.ts apps/web/src/lib/services/__tests__/api.test.ts apps/web/src/lib/stores/playerAuth.ts apps/web/src/lib/stores/playerAuth.test.ts
git commit -m "feat(web): add player auth client state"
```

## Task 9: Player Login Page And Global Account UI

**Files:**

- Modify: `apps/web/src/routes/+layout.svelte`
- Create: `apps/web/src/routes/login/+page.svelte`
- Test: `apps/web/src/routes/layout.svelte.test.ts`
- Test: `apps/web/src/routes/login/page.svelte.test.ts`

- [ ] **Step 1: Write failing layout tests**

Create `apps/web/src/routes/layout.svelte.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import Layout from './+layout.svelte';
import { playerAuth } from '$lib/stores/playerAuth';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
	page: {
		subscribe(fn: (value: unknown) => void) {
			fn({ url: { pathname: '/' } });
			return () => {};
		}
	}
}));
vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: {
		subscribe: vi.fn((fn) => {
			fn({ status: 'anonymous', user: null, error: null });
			return () => {};
		}),
		refresh: vi.fn(),
		logout: vi.fn()
	}
}));

function children() {
	return createRawSnippet(() => ({
		render: () => '<main>child</main>',
		setup: () => {}
	}));
}

describe('root layout account nav', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refreshes player auth on mount and shows sign in link', async () => {
		render(Layout, { children: children() });

		await expect.element(page.getByTestId('quick-puzzle-link')).toBeVisible();
		await expect.element(page.getByRole('link', { name: /sign in/i })).toBeVisible();
		expect(playerAuth.refresh).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Write failing login page tests**

Create `apps/web/src/routes/login/page.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LoginPage from './+page.svelte';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
	page: {
		subscribe(fn: (value: unknown) => void) {
			fn({ url: new URL('http://localhost/login?error=not_allowed') });
			return () => {};
		}
	}
}));
vi.mock('$lib/services/api', () => ({
	getGoogleLoginUrl: vi.fn(() => '/api/auth/google/start?returnTo=%2F')
}));

describe('/login', () => {
	it('renders Google sign in link and not-allowed message', async () => {
		render(LoginPage);

		await expect.element(page.getByRole('link', { name: /sign in with google/i })).toBeVisible();
		await expect.element(page.getByText(/not on the player access list/i)).toBeVisible();
	});
});
```

- [ ] **Step 3: Run layout/login tests and verify they fail**

Run:

```bash
cd apps/web && bunx vitest --run --browser src/routes/layout.svelte.test.ts src/routes/login/page.svelte.test.ts
```

Expected: FAIL because the layout and login page do not implement player auth UI.

- [ ] **Step 4: Implement account nav in layout**

Modify `apps/web/src/routes/+layout.svelte`:

```svelte
<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import favicon from '$lib/assets/favicon.svg';
	import { playerAuth } from '$lib/stores/playerAuth';

	let { children } = $props();

	const isOnPuzzleRoute = $derived($page.url.pathname.startsWith('/puzzle/'));

	onMount(() => {
		void playerAuth.refresh();
	});
</script>
```

Replace the existing floating Quick Puzzle link block with:

```svelte
{#if !isOnPuzzleRoute}
	<nav
		class="fixed top-2 right-3 z-2000 flex items-center gap-3 text-[0.6rem] font-(--font-mono)
tracking-[0.16em] max-sm:text-[0.55rem]"
		aria-label="Player navigation"
	>
		<a
			href={resolve('/quick')}
			class="text-(--accent) opacity-70 hover:opacity-100"
			data-testid="quick-puzzle-link"
		>
			→ QUICK PUZZLE
		</a>
		{#if $playerAuth.status === 'authenticated' && $playerAuth.user}
			<span class="max-w-40 truncate text-(--text-1)"
				>{$playerAuth.user.name ?? $playerAuth.user.email}</span
			>
			<button
				type="button"
				onclick={() => playerAuth.logout()}
				class="text-(--hot) opacity-70 hover:opacity-100"
			>
				SIGN OUT
			</button>
		{:else}
			<a href={resolve('/login')} class="text-(--text-1) opacity-80 hover:text-(--accent)">
				SIGN IN
			</a>
		{/if}
	</nav>
{/if}
```

- [ ] **Step 5: Implement login page**

Create `apps/web/src/routes/login/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import { getGoogleLoginUrl } from '$lib/services/api';

	const errorMessages: Record<string, string> = {
		google_error: 'Google sign in failed. Try again.',
		session_expired: 'The sign in session expired. Start again.',
		not_allowed: 'This Google account is not on the player access list.',
		server_error: 'The sign in service is unavailable right now.'
	};

	const errorCode = $derived($page.url.searchParams.get('error'));
	const message = $derived(errorCode ? errorMessages[errorCode] : null);
	const signInHref = $derived(getGoogleLoginUrl('/'));
</script>

<svelte:head>
	<title>Player Sign In | Perseus</title>
</svelte:head>

<main
	class="flex min-h-screen items-center justify-center bg-(--bg-0) [background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]
p-6"
>
	<section class="w-full max-w-[24rem] border border-(--border) bg-(--bg-1) px-7 py-8">
		<div class="mb-6 text-center">
			<div
				class="mb-2 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
			>
				// PERSEUS PLAYER
			</div>
			<h1 class="text-[1.5rem] font-(--font-display) font-black tracking-[0.15em] text-(--text-0)">
				PLAYER ACCESS
			</h1>
		</div>

		{#if message}
			<div
				class="mb-5 border border-(--hot-dim) bg-[rgba(255,0,102,0.08)] px-3.5 py-2.5
text-[0.7rem] font-(--font-mono) tracking-[0.05em] text-(--hot)"
				role="alert"
			>
				{message}
			</div>
		{/if}

		<a
			href={signInHref}
			class="block w-full border border-(--accent) px-4 py-3 text-center text-[0.65rem]
font-(--font-display) font-bold tracking-[0.2em] text-(--accent)
transition-all duration-200 hover:bg-(--accent-glow)"
		>
			SIGN IN WITH GOOGLE
		</a>

		<a
			href={resolve('/')}
			class="mt-6 block text-center text-[0.62rem] font-(--font-mono) tracking-[0.15em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)"
		>
			← BACK TO ARCADE
		</a>
	</section>
</main>
```

- [ ] **Step 6: Run layout/login tests and verify they pass**

Run:

```bash
cd apps/web && bunx vitest --run --browser src/routes/layout.svelte.test.ts src/routes/login/page.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit player login UI**

Run:

```bash
git add apps/web/src/routes/+layout.svelte apps/web/src/routes/layout.svelte.test.ts apps/web/src/routes/login/+page.svelte apps/web/src/routes/login/page.svelte.test.ts
git commit -m "feat(web): add player login UI"
```

## Task 10: Admin Allowlist UI

**Files:**

- Modify: `apps/web/src/routes/admin/+page.svelte`
- Test: `apps/web/src/routes/admin/admin-page.svelte.test.ts`

- [ ] **Step 1: Add failing admin UI tests**

Append to `apps/web/src/routes/admin/admin-page.svelte.test.ts`:

```ts
import {
	addPlayerAllowlistEntry,
	fetchPlayerAllowlist,
	removePlayerAllowlistEntry
} from '$lib/services/api';

it('renders player access allowlist entries', async () => {
	vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
	vi.mocked(fetchPlayerAllowlist).mockResolvedValue([
		{
			email: 'player@example.com',
			createdAt: 1,
			addedBy: 'admin',
			player: {
				id: 'google-sub-123',
				email: 'player@example.com',
				name: 'Player One',
				createdAt: 1,
				lastLoginAt: 2
			}
		}
	]);

	render(AdminPage);

	await expect.element(page.getByText('PLAYER ACCESS')).toBeVisible();
	await expect.element(page.getByText('player@example.com')).toBeVisible();
	await expect.element(page.getByText('Player One')).toBeVisible();
});

it('adds a player allowlist email', async () => {
	vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
	vi.mocked(fetchPlayerAllowlist).mockResolvedValue([]);
	vi.mocked(addPlayerAllowlistEntry).mockResolvedValue({
		email: 'player@example.com',
		createdAt: 1,
		addedBy: 'admin'
	});

	render(AdminPage);

	await page.getByPlaceholder('player@example.com').fill('player@example.com');
	await page.getByRole('button', { name: /add player/i }).click();

	await vi.waitFor(() => {
		expect(addPlayerAllowlistEntry).toHaveBeenCalledWith('player@example.com');
	});
});
```

Update the existing API mock in this test file to include:

```ts
fetchPlayerAllowlist: vi.fn().mockResolvedValue([]),
addPlayerAllowlistEntry: vi.fn(),
removePlayerAllowlistEntry: vi.fn()
```

- [ ] **Step 2: Run admin UI test and verify it fails**

Run:

```bash
cd apps/web && bunx vitest --run --browser src/routes/admin/admin-page.svelte.test.ts
```

Expected: FAIL because Player Access UI is missing.

- [ ] **Step 3: Add allowlist imports and state**

In `apps/web/src/routes/admin/+page.svelte`, extend the API imports:

```ts
	addPlayerAllowlistEntry,
	fetchPlayerAllowlist,
	removePlayerAllowlistEntry,
```

Add state:

```ts
let allowlist = $state<PlayerAllowlistEntry[]>([]);
let allowlistEmail = $state('');
let loadingAllowlist = $state(true);
let allowlistError: string | null = $state(null);
let allowlistSaving = $state(false);
let removingAllowlistEmail: string | null = $state(null);
```

Call `await loadAllowlist();` inside `onMount`.

Add functions:

```ts
async function loadAllowlist() {
	loadingAllowlist = true;
	allowlistError = null;
	try {
		allowlist = await fetchPlayerAllowlist();
	} catch (e) {
		allowlistError = e instanceof ApiError ? e.message : 'Failed to load player access';
	} finally {
		loadingAllowlist = false;
	}
}

async function handleAllowlistSubmit(event: Event) {
	event.preventDefault();
	if (!allowlistEmail.trim()) return;
	allowlistSaving = true;
	allowlistError = null;
	try {
		await addPlayerAllowlistEntry(allowlistEmail.trim());
		allowlistEmail = '';
		await loadAllowlist();
	} catch (e) {
		allowlistError = e instanceof ApiError ? e.message : 'Failed to add player';
	} finally {
		allowlistSaving = false;
	}
}

async function handleAllowlistRemove(email: string) {
	removingAllowlistEmail = email;
	allowlistError = null;
	try {
		await removePlayerAllowlistEntry(email);
		await loadAllowlist();
	} catch (e) {
		allowlistError = e instanceof ApiError ? e.message : 'Failed to remove player';
	} finally {
		removingAllowlistEmail = null;
	}
}
```

- [ ] **Step 4: Render Player Access panel**

Add a third panel inside the existing admin grid:

```svelte
<div class="border border-(--border) bg-(--bg-1) lg:col-span-2">
	<div class="flex items-center justify-between border-b border-(--border) bg-(--bg-2) px-4 py-3">
		<span
			class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
		>
			PLAYER ACCESS
		</span>
		<span class="text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--accent)">
			{allowlist.length} ALLOWED
		</span>
	</div>

	<form onsubmit={handleAllowlistSubmit} class="flex flex-wrap gap-3 p-4">
		<input
			type="email"
			bind:value={allowlistEmail}
			placeholder="player@example.com"
			class="min-w-0 flex-1 border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)"
			disabled={allowlistSaving}
		/>
		<button
			type="submit"
			disabled={allowlistSaving || !allowlistEmail.trim()}
			class="border border-(--accent) px-4 py-2 text-[0.6rem] font-(--font-display)
font-bold tracking-[0.18em] text-(--accent) disabled:opacity-40"
		>
			{allowlistSaving ? 'ADDING...' : 'ADD PLAYER'}
		</button>
	</form>

	{#if allowlistError}
		<div
			class="mx-4 mb-4 border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) text-(--hot)"
			role="alert"
		>
			{allowlistError}
		</div>
	{/if}

	{#if loadingAllowlist}
		<div class="p-4 text-[0.72rem] font-(--font-mono) text-(--text-2)">LOADING ACCESS LIST...</div>
	{:else if allowlist.length === 0}
		<div class="p-4 text-[0.72rem] font-(--font-mono) text-(--text-2)">No players allowlisted.</div>
	{:else}
		<div class="flex flex-col">
			{#each allowlist as entry (entry.email)}
				<div class="flex items-center justify-between gap-3 border-t border-(--border) px-4 py-3">
					<div class="min-w-0">
						<div class="truncate text-[0.82rem] font-(--font-mono) text-(--text-0)">
							{entry.email}
						</div>
						<div class="text-[0.65rem] font-(--font-mono) text-(--text-2)">
							{entry.player?.name ?? 'No account created'}
						</div>
					</div>
					<button
						type="button"
						onclick={() => handleAllowlistRemove(entry.email)}
						disabled={removingAllowlistEmail === entry.email}
						class="shrink-0 border border-(--hot-dim) px-2.5 py-[0.35rem]
text-[0.55rem] font-(--font-display) font-semibold tracking-[0.15em] text-(--hot)
disabled:opacity-40"
					>
						{removingAllowlistEmail === entry.email ? '...' : 'REMOVE'}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>
```

- [ ] **Step 5: Run admin UI tests and verify they pass**

Run:

```bash
cd apps/web && bunx vitest --run --browser src/routes/admin/admin-page.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit admin allowlist UI**

Run:

```bash
git add apps/web/src/routes/admin/+page.svelte apps/web/src/routes/admin/admin-page.svelte.test.ts
git commit -m "feat(web): add player allowlist admin UI"
```

## Task 11: Config And Infrastructure

**Files:**

- Modify: `apps/api/.env.example`
- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/wrangler.production.toml`
- Modify: `packages/infrastructure/src/index.ts`
- Modify: `packages/infrastructure/README.md`

- [ ] **Step 1: Update local env example**

Add to `apps/api/.env.example`:

```dotenv
# Google OAuth for player sign-in
GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
AUTH_REDIRECT_BASE_URL=http://localhost:4690
```

- [ ] **Step 2: Update Wrangler variable documentation**

Add comments under `[vars]` in `apps/api/wrangler.toml`:

```toml
# Player auth callback origin. For local dev, set this in .dev.vars or env.dev.vars.
# AUTH_REDIRECT_BASE_URL = "http://localhost:4690"
```

Add to `[vars]` in `apps/api/wrangler.production.toml`:

```toml
# Set via Pulumi in production:
# AUTH_REDIRECT_BASE_URL = "https://your-production-origin.example"
```

- [ ] **Step 3: Bind production auth config in Pulumi**

Modify `packages/infrastructure/src/index.ts`:

```ts
envVars: {
	NODE_ENV: 'production',
	ALLOWED_ORIGINS: config.require('ALLOWED_ORIGINS'),
	AUTH_REDIRECT_BASE_URL: config.require('AUTH_REDIRECT_BASE_URL')
},
secretVars: {
	JWT_SECRET: config.requireSecret('jwtSecret'),
	ADMIN_PASSKEY: config.requireSecret('adminPasskey'),
	GOOGLE_CLIENT_ID: config.requireSecret('googleClientId'),
	GOOGLE_CLIENT_SECRET: config.requireSecret('googleClientSecret')
}
```

- [ ] **Step 4: Document setup commands**

Add to `packages/infrastructure/README.md` near existing Pulumi config setup:

```bash
pulumi config set AUTH_REDIRECT_BASE_URL https://your-production-origin.example
pulumi config set --secret googleClientId YOUR_GOOGLE_CLIENT_ID
pulumi config set --secret googleClientSecret YOUR_GOOGLE_CLIENT_SECRET
```

Also document Google callback URL:

```text
Production callback URL:
https://your-production-origin.example/api/auth/google/callback

Local callback URL:
http://localhost:4690/api/auth/google/callback
```

- [ ] **Step 5: Run infrastructure type check**

Run:

```bash
cd packages/infrastructure && bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit config docs**

Run:

```bash
git add apps/api/.env.example apps/api/wrangler.toml apps/api/wrangler.production.toml packages/infrastructure/src/index.ts packages/infrastructure/README.md
git commit -m "chore: document player auth configuration"
```

## Task 12: Full Verification And Fixups

**Files:**

- Modify only files required by failing checks.

- [ ] **Step 1: Run API unit tests**

Run:

```bash
cd apps/api && bun run test:unit
```

Expected: PASS. If failures mention mocked modules missing new exports, update the affected test
mock to include the exact new function used by the module under test.

- [ ] **Step 2: Run web unit tests**

Run:

```bash
cd apps/web && bun run test:unit
```

Expected: PASS. If layout tests fail because the root layout now calls `playerAuth.refresh`,
mock `$lib/stores/playerAuth` in that test file with `subscribe`, `refresh`, and `logout`.

- [ ] **Step 3: Run repository type check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Run repository unit suite**

Run:

```bash
bun run test:unit
```

Expected: PASS.

- [ ] **Step 5: Run E2E suite if local browsers are installed**

Run:

```bash
bun run test:e2e
```

Expected: PASS or a clear environment failure about missing browser binaries. If browser binaries
are missing, run:

```bash
cd apps/web && bun run test:install-browsers
```

Then retry:

```bash
bun run test:e2e
```

- [ ] **Step 6: Run formatting and lint checks**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 7: Commit verification fixups**

If Step 1 through Step 6 required code changes, commit them:

```bash
git add apps packages docs
git commit -m "fix: stabilize player auth rollout"
```

If no files changed, do not create an empty commit.

## Task 13: Manual OAuth Smoke Check

**Files:**

- Modify only if the manual check exposes a real bug.

- [ ] **Step 1: Configure local Google OAuth values**

Create or update `apps/api/.dev.vars` locally with real values:

```dotenv
GOOGLE_CLIENT_ID=your-local-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-local-client-secret
AUTH_REDIRECT_BASE_URL=http://localhost:4690
JWT_SECRET=local-jwt-secret-with-at-least-32-characters
ADMIN_PASSKEY=local-admin-passkey
ALLOWED_ORIGINS=http://localhost:4692
```

Do not commit `.dev.vars`.

- [ ] **Step 2: Start the API Worker**

Run:

```bash
cd apps/api && bun run dev
```

Expected: Wrangler dev starts on `http://localhost:4690`.

- [ ] **Step 3: Start the web app**

In a second terminal, run:

```bash
cd apps/web && PUBLIC_API_BASE=http://localhost:4690 bun run dev
```

Expected: Vite starts on `http://localhost:4692`.

- [ ] **Step 4: Add your email to the allowlist**

Open `http://localhost:4692/admin/login`, sign in with the local admin passkey, open the Player
Access panel, add the Google email you will use for the smoke test, and confirm it appears in the
list.

- [ ] **Step 5: Sign in as a player**

Open `http://localhost:4692/login`, click `SIGN IN WITH GOOGLE`, complete Google auth, and confirm
you return to the app with the account control showing your display name or email.

- [ ] **Step 6: Verify sign out**

Click `SIGN OUT` in the top-right account control.

Expected: the account control returns to `SIGN IN` without interrupting gallery access.

- [ ] **Step 7: Verify non-allowlisted behavior**

Remove the email from Player Access, sign out if still signed in, then try the Google login again.

Expected: the browser returns to `/login?error=not_allowed` and the login page shows the
not-allowed message.

- [ ] **Step 8: Stop dev servers**

Stop both dev server processes with `Ctrl+C`.
