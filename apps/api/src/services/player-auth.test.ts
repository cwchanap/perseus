import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUser } from '@perseus/types';

const sharedAuth = vi.hoisted(() => {
	const PLAYER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
	const OAUTH_STATE_TTL_SECONDS = 10 * 60;

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
		OAUTH_STATE_TTL_SECONDS,
		PLAYER_SESSION_DURATION_MS,
		bytesToBase64Url,
		hashToken,
		normalizeEmail
	};
});

vi.mock('./player-auth.shared', () => sharedAuth);

import {
	OAUTH_STATE_TTL_SECONDS,
	PLAYER_SESSION_DURATION_MS,
	hashToken
} from './player-auth.shared';
import {
	addAllowlistEntry,
	consumeOAuthState,
	createPlayerSession,
	deleteAllowlistEntry,
	getAllowlistEntry,
	getPlayer,
	getPlayerByEmail,
	getPlayerSession,
	initializePlayerAuthStorage,
	listAllowlistEntries,
	revokePlayerSession,
	revokePlayerSessionsForEmail,
	storeOAuthState,
	upsertPlayer
} from './player-auth';

function encoded(value: string): string {
	return encodeURIComponent(value);
}

function authPath(dataDir: string, ...segments: string[]): string {
	return join(dataDir, 'auth', ...segments);
}

async function readJsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, 'utf-8')) as T;
}

describe('player auth Bun filesystem storage', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'perseus-player-auth-'));
		process.env.DATA_DIR = dataDir;
		vi.useFakeTimers();
		vi.setSystemTime(1_716_500_000_000);
		await initializePlayerAuthStorage();
	});

	afterEach(async () => {
		vi.useRealTimers();
		delete process.env.DATA_DIR;
		await rm(dataDir, { recursive: true, force: true });
	});

	it('adds, reads, lists, and deletes allowlist entries with normalized email and idempotency', async () => {
		const entry = await addAllowlistEntry(' Player@Example.COM ', 'admin');
		vi.setSystemTime(1_716_500_001_000);
		const duplicate = await addAllowlistEntry('player@example.com', 'other-admin');
		await addAllowlistEntry('second@example.com', 'admin');

		expect(entry).toEqual({
			email: 'player@example.com',
			createdAt: 1_716_500_000_000,
			addedBy: 'admin'
		});
		expect(duplicate).toEqual(entry);
		expect(await getAllowlistEntry('PLAYER@example.com')).toEqual(entry);
		expect((await listAllowlistEntries()).map((listed) => listed.email)).toEqual([
			'player@example.com',
			'second@example.com'
		]);
		expect(
			await readJsonFile(authPath(dataDir, 'allowlist', `${encoded('player@example.com')}.json`))
		).toEqual(entry);

		await deleteAllowlistEntry(' Player@Example.COM ');
		expect(await getAllowlistEntry('player@example.com')).toBeNull();
		expect((await listAllowlistEntries()).map((listed) => listed.email)).toEqual([
			'second@example.com'
		]);
	});

	it('upserts players, updates email indexes, and guards against stale email indexes', async () => {
		const player = await upsertPlayer({
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
		expect(await getPlayer('google-sub-123')).toEqual(player);
		expect(await getPlayerByEmail(' PLAYER@example.com ')).toEqual(player);

		vi.setSystemTime(1_716_500_001_000);
		const updated = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'Updated@Example.COM'
		});

		expect(updated).toMatchObject({
			id: 'google-sub-123',
			email: 'updated@example.com',
			createdAt: 1_716_500_000_000,
			lastLoginAt: 1_716_500_001_000
		});
		expect(await getPlayerByEmail('player@example.com')).toBeNull();
		expect(await getPlayerByEmail('updated@example.com')).toEqual(updated);
		expect(
			existsSync(authPath(dataDir, 'email-index', `${encoded('player@example.com')}.txt`))
		).toBe(false);

		await writeFile(
			authPath(dataDir, 'email-index', `${encoded('player@example.com')}.txt`),
			'google-sub-123',
			'utf-8'
		);
		expect(await getPlayerByEmail('player@example.com')).toBeNull();
	});

	it('creates and reads sessions only for allowlisted players and stores only token hashes', async () => {
		const player: PlayerUser = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});

		await expect(createPlayerSession(player)).rejects.toThrow('Player is not allowlisted');

		await addAllowlistEntry('player@example.com', 'admin');
		const created = await createPlayerSession(player);
		const sessionHash = await hashToken(created.token);
		const sessionPath = authPath(dataDir, 'sessions', `${sessionHash}.json`);
		const sessionIndexPath = authPath(
			dataDir,
			'session-index',
			encoded('player@example.com'),
			'session',
			`${sessionHash}.txt`
		);

		expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(created.expiresAt).toBe(1_716_500_000_000 + PLAYER_SESSION_DURATION_MS);
		expect(existsSync(sessionPath)).toBe(true);
		expect(existsSync(sessionIndexPath)).toBe(true);
		expect(await readFile(sessionPath, 'utf-8')).not.toContain(created.token);
		expect(await getPlayerSession(created.token)).toMatchObject({
			sessionHash,
			user: { id: 'google-sub-123', email: 'player@example.com' },
			createdAt: 1_716_500_000_000,
			expiresAt: created.expiresAt
		});

		await deleteAllowlistEntry('player@example.com');
		expect(await getPlayerSession(created.token)).toBeNull();
	});

	it('revokes individual sessions and removes the email session index entry', async () => {
		await addAllowlistEntry('player@example.com', 'admin');
		const player = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(player);
		const retained = await createPlayerSession(player);
		const sessionHash = await hashToken(created.token);
		const sessionIndexPath = authPath(
			dataDir,
			'session-index',
			encoded('player@example.com'),
			'session',
			`${sessionHash}.txt`
		);

		await revokePlayerSession(created.token);

		expect(await getPlayerSession(created.token)).toBeNull();
		expect(existsSync(authPath(dataDir, 'sessions', `${sessionHash}.json`))).toBe(false);
		expect(existsSync(sessionIndexPath)).toBe(false);
		expect(await getPlayerSession(retained.token)).toMatchObject({
			user: { id: 'google-sub-123', email: 'player@example.com' }
		});
	});

	it('bulk revokes sessions by original email after the player email changes', async () => {
		await addAllowlistEntry('old@example.com', 'admin');
		await addAllowlistEntry('new@example.com', 'admin');
		const oldPlayer = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'old@example.com'
		});
		const created = await createPlayerSession(oldPlayer);

		await upsertPlayer({
			sub: 'google-sub-123',
			email: 'new@example.com'
		});

		expect(await getPlayerByEmail('old@example.com')).toBeNull();
		expect(await getPlayerSession(created.token)).toMatchObject({
			user: { email: 'old@example.com' }
		});

		await revokePlayerSessionsForEmail(' OLD@example.com ');

		expect(await getPlayerSession(created.token)).toBeNull();
		expect(
			existsSync(authPath(dataDir, 'sessions', `${await hashToken(created.token)}.json`))
		).toBe(false);
	});

	it('uses the revocation watermark when a session index file is missing', async () => {
		await addAllowlistEntry('player@example.com', 'admin');
		const player = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(player);
		const sessionHash = await hashToken(created.token);
		await rm(
			authPath(
				dataDir,
				'session-index',
				encoded('player@example.com'),
				'session',
				`${sessionHash}.txt`
			),
			{ force: true }
		);

		await revokePlayerSessionsForEmail('player@example.com');

		expect(existsSync(authPath(dataDir, 'sessions', `${sessionHash}.json`))).toBe(true);
		expect(
			await readFile(
				authPath(dataDir, 'session-index', encoded('player@example.com'), 'revoked_after.txt'),
				'utf-8'
			)
		).toBe('1716500000000');
		expect(await getPlayerSession(created.token)).toBeNull();
	});

	it('returns null for expired and missing sessions', async () => {
		expect(await getPlayerSession('missing-session-token')).toBeNull();

		await addAllowlistEntry('player@example.com', 'admin');
		const player = await upsertPlayer({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		const created = await createPlayerSession(player);

		vi.setSystemTime(1_716_500_000_000 + PLAYER_SESSION_DURATION_MS + 1);

		expect(await getPlayerSession(created.token)).toBeNull();
	});

	it('bulk revoke does not require the email to be allowlisted or currently linked', async () => {
		await expect(revokePlayerSessionsForEmail('missing@example.com')).resolves.toBeUndefined();
		expect(
			await readFile(
				authPath(dataDir, 'session-index', encoded('missing@example.com'), 'revoked_after.txt'),
				'utf-8'
			)
		).toBe('1716500000000');
		expect(await readdir(authPath(dataDir, 'sessions'))).toEqual([]);
	});

	it('returns an empty allowlist when the allowlist directory is missing', async () => {
		await rm(authPath(dataDir, 'allowlist'), { recursive: true, force: true });

		expect(await listAllowlistEntries()).toEqual([]);
	});

	it('throws unexpected filesystem and JSON read errors', async () => {
		await writeFile(
			authPath(dataDir, 'players', `${encoded('broken-sub')}.json`),
			'{broken',
			'utf-8'
		);
		await expect(getPlayer('broken-sub')).rejects.toThrow(SyntaxError);

		await rm(authPath(dataDir, 'allowlist'), { recursive: true, force: true });
		await writeFile(authPath(dataDir, 'allowlist'), 'not-a-directory', 'utf-8');
		await expect(listAllowlistEntries()).rejects.toMatchObject({ code: 'ENOTDIR' });

		await rm(authPath(dataDir, 'email-index'), { recursive: true, force: true });
		await mkdir(authPath(dataDir, 'email-index', `${encoded('player@example.com')}.txt`), {
			recursive: true
		});
		await expect(getPlayerByEmail('player@example.com')).rejects.toMatchObject({ code: 'EISDIR' });

		await rm(authPath(dataDir, 'session-index'), { recursive: true, force: true });
		await mkdir(authPath(dataDir, 'session-index', encoded('player@example.com')), {
			recursive: true
		});
		await writeFile(
			authPath(dataDir, 'session-index', encoded('player@example.com'), 'session'),
			'not-a-directory',
			'utf-8'
		);
		await expect(revokePlayerSessionsForEmail('player@example.com')).rejects.toMatchObject({
			code: 'ENOTDIR'
		});
	});

	it('stores and consumes OAuth state once and ignores expired state', async () => {
		await storeOAuthState('state-one', {
			codeVerifier: 'verifier',
			returnTo: '/puzzle/abc'
		});

		expect(await consumeOAuthState('state-one')).toEqual({
			state: 'state-one',
			codeVerifier: 'verifier',
			returnTo: '/puzzle/abc',
			createdAt: 1_716_500_000_000
		});
		expect(await consumeOAuthState('state-one')).toBeNull();

		await storeOAuthState('state-two', {
			codeVerifier: 'verifier-two',
			returnTo: '/'
		});
		vi.setSystemTime(1_716_500_000_000 + OAUTH_STATE_TTL_SECONDS * 1000 + 1);

		expect(await consumeOAuthState('state-two')).toBeNull();
		expect(existsSync(authPath(dataDir, 'oauth-state', `${encoded('state-two')}.json`))).toBe(
			false
		);
	});
});
