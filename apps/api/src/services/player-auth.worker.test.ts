import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUser } from '@perseus/types';

const sharedAuth = vi.hoisted(() => {
	const PLAYER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

	function bytesToBase64Url(bytes: Uint8Array): string {
		const chunkSize = 0x8000;
		let binary = '';
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
		}
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	}

	function normalizeEmail(email: string): string {
		const normalized = email.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
			throw new Error('Invalid email');
		}
		return normalized;
	}

	async function hashToken(token: string): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
		return Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
	}

	return {
		PLAYER_SESSION_DURATION_MS,
		OAUTH_STATE_TTL_SECONDS: 10 * 60,
		bytesToBase64Url,
		normalizeEmail,
		hashToken
	};
});

vi.mock('./player-auth.shared', () => sharedAuth);

import { PLAYER_SESSION_DURATION_MS, hashToken } from './player-auth.shared';

import {
	addAllowlistEntry,
	createPlayerSession,
	deleteAllowlistEntry,
	getAllowlistEntry,
	getPlayer,
	getPlayerByEmail,
	getPlayerSession,
	listAllowlistEntries,
	revokePlayerSession,
	revokePlayerSessionsForEmail,
	upsertPlayer,
	__resetGracePeriod
} from './player-auth.worker';

class MemoryKV {
	private store = new Map<string, string>();
	private putOptionStore = new Map<string, { expirationTtl?: number } | undefined>();
	private listPageSize = Number.POSITIVE_INFINITY;

	async get(key: string, type?: 'json') {
		const value = this.store.get(key) ?? null;
		if (value === null) return null;
		return type === 'json' ? JSON.parse(value) : value;
	}

	async put(key: string, value: string, options?: { expirationTtl?: number }) {
		this.store.set(key, value);
		this.putOptionStore.set(key, options);
	}

	async delete(key: string) {
		this.store.delete(key);
		this.putOptionStore.delete(key);
	}

	async list(options?: { prefix?: string; cursor?: string }) {
		const prefix = options?.prefix ?? '';
		const start = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
		const keys = [...this.store.keys()]
			.filter((name) => name.startsWith(prefix))
			.sort()
			.map((name) => ({ name }));
		const end = Math.min(start + this.listPageSize, keys.length);
		return {
			keys: keys.slice(start, end),
			list_complete: end >= keys.length,
			cursor: end >= keys.length ? undefined : String(end)
		};
	}

	has(key: string): boolean {
		return this.store.has(key);
	}

	putOptions(key: string): { expirationTtl?: number } | undefined {
		return this.putOptionStore.get(key);
	}

	setListPageSize(pageSize: number): void {
		this.listPageSize = pageSize;
	}

	dump(): string {
		return [...this.store.entries()].map(([key, value]) => `${key}:${value}`).join('\n');
	}
}

function sessionIndexKey(email: string, sessionHash: string): string {
	return `player_sessions:${email}:session:${sessionHash}`;
}

function revokedAfterKey(email: string): string {
	return `player_sessions:${email}:revoked_after`;
}

describe('player auth Worker storage', () => {
	let memoryKV: MemoryKV;
	let kv: KVNamespace;

	beforeEach(() => {
		memoryKV = new MemoryKV();
		kv = memoryKV as unknown as KVNamespace;
		vi.setSystemTime(1_716_500_000_000);
		__resetGracePeriod();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('adds, reads, lists, and deletes allowlist entries with normalized email', async () => {
		const entry = await addAllowlistEntry(kv, ' Player@Example.COM ', 'admin');
		await addAllowlistEntry(kv, 'second@example.com', 'admin');

		expect(entry).toEqual({
			email: 'player@example.com',
			createdAt: 1_716_500_000_000,
			addedBy: 'admin'
		});
		expect(await getAllowlistEntry(kv, 'PLAYER@example.com')).toMatchObject({
			email: 'player@example.com',
			addedBy: 'admin'
		});
		expect((await listAllowlistEntries(kv)).map((listed) => listed.email)).toEqual([
			'player@example.com',
			'second@example.com'
		]);

		await deleteAllowlistEntry(kv, ' Player@Example.COM ');
		expect(await getAllowlistEntry(kv, 'player@example.com')).toBeNull();
		expect((await listAllowlistEntries(kv)).map((listed) => listed.email)).toEqual([
			'second@example.com'
		]);
	});

	it('lists allowlist entries across multiple KV pages', async () => {
		memoryKV.setListPageSize(1);

		await addAllowlistEntry(kv, 'first@example.com', 'admin');
		await addAllowlistEntry(kv, 'second@example.com', 'admin');
		await addAllowlistEntry(kv, 'third@example.com', 'admin');

		expect((await listAllowlistEntries(kv)).map((listed) => listed.email)).toEqual([
			'first@example.com',
			'second@example.com',
			'third@example.com'
		]);
	});

	it('upserts players and links them by normalized email', async () => {
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'Player@Example.COM',
			name: 'Player One',
			picture: 'https://example.com/avatar.png'
		});

		expect(player).toEqual({
			id: 'google-sub-123',
			email: 'player@example.com',
			name: 'Player One',
			picture: 'https://example.com/avatar.png',
			createdAt: 1_716_500_000_000,
			lastLoginAt: 1_716_500_000_000
		});
		expect(await getPlayer(kv, 'google-sub-123')).toEqual(player);
		expect(await getPlayerByEmail(kv, ' PLAYER@example.com ')).toEqual(player);

		vi.setSystemTime(1_716_500_001_000);
		const updated = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'Updated@Example.COM'
		});

		expect(updated).toMatchObject({
			id: 'google-sub-123',
			email: 'updated@example.com',
			createdAt: 1_716_500_000_000,
			lastLoginAt: 1_716_500_001_000
		});
		expect(await getPlayerByEmail(kv, 'player@example.com')).toBeNull();
		expect(await getPlayerByEmail(kv, 'updated@example.com')).toEqual(updated);
	});

	it('ignores stale player email index entries', async () => {
		await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'old@example.com'
		});
		const updated = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'new@example.com'
		});
		await memoryKV.put('player_email_index:old@example.com', 'google-sub-123');

		expect(await getPlayerByEmail(kv, 'old@example.com')).toBeNull();
		expect(await getPlayerByEmail(kv, 'new@example.com')).toEqual(updated);
	});

	it('keeps old email index entries owned by another player during email changes', async () => {
		await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'old@example.com'
		});
		await memoryKV.put('player_email_index:old@example.com', 'google-sub-other');
		await upsertPlayer(kv, {
			sub: 'google-sub-other',
			email: 'old@example.com'
		});
		const updated = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'new@example.com'
		});

		expect(await getPlayerByEmail(kv, 'old@example.com')).toMatchObject({
			id: 'google-sub-other',
			email: 'old@example.com'
		});
		expect(await getPlayerByEmail(kv, 'new@example.com')).toEqual(updated);
	});

	it('creates, reads, revokes, and bulk revokes sessions by normalized email', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player: PlayerUser = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});

		const created = await createPlayerSession(kv, player);
		const sessionHash = await hashToken(created.token);
		const sessionTtlSeconds = Math.ceil(PLAYER_SESSION_DURATION_MS / 1000);

		expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(created.expiresAt).toBe(1_716_500_000_000 + PLAYER_SESSION_DURATION_MS);
		expect(memoryKV.has(`player_session:${sessionHash}`)).toBe(true);
		expect(memoryKV.has(sessionIndexKey('player@example.com', sessionHash))).toBe(true);
		expect(memoryKV.putOptions(`player_session:${sessionHash}`)).toEqual({
			expirationTtl: sessionTtlSeconds
		});
		expect(memoryKV.putOptions(sessionIndexKey('player@example.com', sessionHash))).toEqual({
			expirationTtl: sessionTtlSeconds
		});
		expect(memoryKV.dump()).not.toContain(created.token);
		expect(await getPlayerSession(kv, created.token)).toMatchObject({
			sessionHash,
			user: { id: 'google-sub-123', email: 'player@example.com' },
			createdAt: 1_716_500_000_000,
			expiresAt: created.expiresAt
		});

		const retained = await createPlayerSession(kv, player);
		await revokePlayerSession(kv, created.token);
		expect(await getPlayerSession(kv, created.token)).toBeNull();
		expect(memoryKV.has(sessionIndexKey('player@example.com', sessionHash))).toBe(false);
		expect(await getPlayerSession(kv, retained.token)).toMatchObject({
			user: { id: 'google-sub-123', email: 'player@example.com' }
		});

		const third = await createPlayerSession(kv, player);
		await revokePlayerSessionsForEmail(kv, ' Player@Example.COM ');
		expect(await getPlayerSession(kv, retained.token)).toBeNull();
		expect(await getPlayerSession(kv, third.token)).toBeNull();
		expect(memoryKV.putOptions(revokedAfterKey('player@example.com'))).toEqual({
			expirationTtl: sessionTtlSeconds
		});
	});

	it('bulk revokes sessions created under an old email after player email changes', async () => {
		await addAllowlistEntry(kv, 'old@example.com', 'admin');
		await addAllowlistEntry(kv, 'new@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'old@example.com'
		});
		const created = await createPlayerSession(kv, player);

		await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'new@example.com'
		});
		expect(await getPlayerByEmail(kv, 'old@example.com')).toBeNull();
		expect(await getPlayerSession(kv, created.token)).toMatchObject({
			user: { email: 'old@example.com' }
		});

		await revokePlayerSessionsForEmail(kv, ' OLD@example.com ');

		expect(await getPlayerSession(kv, created.token)).toBeNull();
	});

	it('bulk revokes sessions across paginated session index listings', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const sessions = await Promise.all([
			createPlayerSession(kv, player),
			createPlayerSession(kv, player),
			createPlayerSession(kv, player)
		]);
		const sessionHashes = await Promise.all(sessions.map((session) => hashToken(session.token)));
		memoryKV.setListPageSize(1);

		await revokePlayerSessionsForEmail(kv, 'player@example.com');

		for (const [index, session] of sessions.entries()) {
			expect(await getPlayerSession(kv, session.token)).toBeNull();
			expect(memoryKV.has(`player_session:${sessionHashes[index]}`)).toBe(false);
			expect(memoryKV.has(sessionIndexKey('player@example.com', sessionHashes[index]))).toBe(false);
		}
	});

	it('uses the revoke watermark when a session index key is missing', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(kv, player);
		const sessionHash = await hashToken(created.token);
		await kv.delete(sessionIndexKey('player@example.com', sessionHash));

		await revokePlayerSessionsForEmail(kv, 'player@example.com');

		expect(memoryKV.has(`player_session:${sessionHash}`)).toBe(true);
		expect(await memoryKV.get(revokedAfterKey('player@example.com'))).toBe('1716500000000');
		expect(await getPlayerSession(kv, created.token)).toBeNull();
	});

	it('requires an active allowlist entry to create and read sessions', async () => {
		const player: PlayerUser = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});

		await expect(createPlayerSession(kv, player)).rejects.toThrow('Player is not allowlisted');

		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const created = await createPlayerSession(kv, player);
		await deleteAllowlistEntry(kv, 'player@example.com');

		expect(await getPlayerSession(kv, created.token)).toBeNull();
	});

	it('returns null for missing and expired sessions', async () => {
		expect(await getPlayerSession(kv, 'missing-session-token')).toBeNull();

		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(kv, player);

		vi.setSystemTime(1_716_500_000_000 + PLAYER_SESSION_DURATION_MS + 1);

		expect(await getPlayerSession(kv, created.token)).toBeNull();
		await expect(revokePlayerSessionsForEmail(kv, 'missing@example.com')).resolves.toBeUndefined();
	});

	it('returns session from grace period when KV has not propagated', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(kv, player);
		const sessionHash = await hashToken(created.token);

		// Simulate KV eventual consistency by deleting the session from KV
		await memoryKV.delete(`player_session:${sessionHash}`);

		// Grace period should still return the session
		expect(await getPlayerSession(kv, created.token)).toMatchObject({
			sessionHash,
			user: { id: 'google-sub-123', email: 'player@example.com' },
			createdAt: 1_716_500_000_000,
			expiresAt: created.expiresAt
		});
	});

	it('returns null after grace period expires even when KV has not propagated', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(kv, player);
		const sessionHash = await hashToken(created.token);

		// Simulate KV eventual consistency
		await memoryKV.delete(`player_session:${sessionHash}`);

		// Advance time past the grace period (10 seconds)
		vi.setSystemTime(1_716_500_010_000);

		expect(await getPlayerSession(kv, created.token)).toBeNull();
	});

	it('cleans up grace period when session is found in KV', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(kv, player);

		// First read finds it in KV, should clean up grace period
		expect(await getPlayerSession(kv, created.token)).toMatchObject({
			user: { id: 'google-sub-123' }
		});

		// Now simulate KV miss after grace period was cleaned up
		const sessionHash = await hashToken(created.token);
		await memoryKV.delete(`player_session:${sessionHash}`);

		// Grace period was cleaned up by the KV hit, so this should return null
		expect(await getPlayerSession(kv, created.token)).toBeNull();
	});

	it('clears grace period entry when individual session is revoked', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(kv, player);
		const sessionHash = await hashToken(created.token);

		// Remove from KV to simulate propagation delay
		await memoryKV.delete(`player_session:${sessionHash}`);

		// Revoke should clear grace period too
		await revokePlayerSession(kv, created.token);

		expect(await getPlayerSession(kv, created.token)).toBeNull();
	});
});
