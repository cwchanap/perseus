import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUser } from '@perseus/types';

const sharedAuth = vi.hoisted(() => {
	const PLAYER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

	function bytesToBase64Url(bytes: Uint8Array): string {
		let binary = '';
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
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
		bytesToBase64Url,
		normalizeEmail,
		hashToken
	};
});

vi.mock('./player-auth.shared', () => sharedAuth);

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
	upsertPlayer
} from './player-auth.worker';

const { PLAYER_SESSION_DURATION_MS, hashToken } = sharedAuth;

class MemoryKV {
	private store = new Map<string, string>();

	async get(key: string, type?: 'json') {
		const value = this.store.get(key) ?? null;
		if (value === null) return null;
		return type === 'json' ? JSON.parse(value) : value;
	}

	async put(key: string, value: string) {
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

	has(key: string): boolean {
		return this.store.has(key);
	}

	dump(): string {
		return [...this.store.entries()].map(([key, value]) => `${key}:${value}`).join('\n');
	}
}

describe('player auth Worker storage', () => {
	let memoryKV: MemoryKV;
	let kv: KVNamespace;

	beforeEach(() => {
		memoryKV = new MemoryKV();
		kv = memoryKV as unknown as KVNamespace;
		vi.setSystemTime(1_716_500_000_000);
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

	it('creates, reads, revokes, and bulk revokes sessions by normalized email', async () => {
		await addAllowlistEntry(kv, 'player@example.com', 'admin');
		const player: PlayerUser = await upsertPlayer(kv, {
			sub: 'google-sub-123',
			email: 'player@example.com'
		});

		const created = await createPlayerSession(kv, player);
		const sessionHash = await hashToken(created.token);

		expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(created.expiresAt).toBe(1_716_500_000_000 + PLAYER_SESSION_DURATION_MS);
		expect(memoryKV.has(`player_session:${sessionHash}`)).toBe(true);
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
		expect(await getPlayerSession(kv, retained.token)).toMatchObject({
			user: { id: 'google-sub-123', email: 'player@example.com' }
		});

		const third = await createPlayerSession(kv, player);
		await revokePlayerSessionsForEmail(kv, ' Player@Example.COM ');
		expect(await getPlayerSession(kv, retained.token)).toBeNull();
		expect(await getPlayerSession(kv, third.token)).toBeNull();
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
});
