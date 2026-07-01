/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { rmSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The Bun player route resolves its DB via the `../db` singleton, which loads
// `bun:sqlite`. The api test runner (vitest under Node) cannot load that
// builtin, so we mock the DB factory and the shared repositories with an
// in-memory store. Repository/DB integration is covered by @perseus/shared.
vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const store = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
	// In-memory stores backing the mocked list repositories so the list
	// routes can be exercised end-to-end without a real database.
	const puzzlesStore = new Map<string, unknown[]>();
	const statsStore = new Map<string, unknown[]>();
	return {
		...actual,
		// Exposed for test-only reset between cases.
		__store: store,
		__puzzlesStore: puzzlesStore,
		__statsStore: statsStore,
		getProfileOverride: vi.fn((db: unknown, playerId: string) => store.get(playerId) ?? null),
		// Field-specific upserts mirror the real ON CONFLICT behavior: each
		// writes only its column, preserving the other.
		updateProfileDisplayName: vi.fn((db: unknown, playerId: string, displayName: string | null) => {
			const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
			store.set(playerId, { ...existing, displayName });
		}),
		updateProfileAvatarUrl: vi.fn((db: unknown, playerId: string, avatarUrl: string) => {
			const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
			store.set(playerId, { ...existing, avatarUrl });
		}),
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		})),
		listPlayerPuzzles: vi.fn(
			async (db: unknown, playerId: string): Promise<{ rows: unknown[]; nextCursor?: string }> => ({
				rows: puzzlesStore.get(playerId) ?? [],
				nextCursor: undefined
			})
		),
		listPlayerStats: vi.fn(
			async (db: unknown, playerId: string): Promise<{ rows: unknown[] }> => ({
				rows: statsStore.get(playerId) ?? []
			})
		)
	};
});

// The route guards itself with `requirePlayerAuth`, which reads the
// `perseus_player_session` cookie and resolves the session via getPlayerSession.
// We mock the session resolver so the real middleware runs end-to-end.
vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import player from '../routes/player';
import * as playerAuth from '../services/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';

const TEST_PLAYER: PlayerSessionRecord = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'Google Name',
		picture: 'g.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'h',
	createdAt: 1,
	expiresAt: 9999999999999
};

const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };

function buildApp() {
	const app = new Hono();
	app.route('/api/player', player);
	return app;
}

describe('player profile routes (Bun)', () => {
	beforeEach(async () => {
		const shared = await import('@perseus/shared');
		const store = (shared as any).__store as Map<string, unknown> | undefined;
		store?.clear();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('GET profile returns Google defaults when no override', async () => {
		const res = await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe('Google Name');
		expect(body.picture).toBe('g.jpg');
		expect(body.summary).toEqual({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		});
	});

	it('PATCH then GET reflects override', async () => {
		const patch = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: 'Custom' })
		});
		expect(patch.status).toBe(200);

		const res = await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE });
		const body = await res.json();
		expect(body.name).toBe('Custom');
	});

	it('PATCH with null resets to Google name', async () => {
		const { updateProfileDisplayName } = await import('@perseus/shared');
		await (updateProfileDisplayName as any)({}, 'p1', 'Custom');

		await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: null })
		});

		const body = await (
			await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE })
		).json();
		expect(body.name).toBe('Google Name');
	});

	it('PATCH rejects non-string displayName with 400', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: 42 })
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});

	it('PATCH rejects a displayName longer than 255 characters with 400', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: 'x'.repeat(256) })
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});

	it('PATCH accepts a 255-character displayName', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: 'x'.repeat(255) })
		});
		expect(res.status).toBe(200);
	});

	it('PATCH trims surrounding whitespace before storing displayName', async () => {
		const patch = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: '  Custom  ' })
		});
		expect(patch.status).toBe(200);

		const body = await (
			await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE })
		).json();
		expect(body.name).toBe('Custom');
	});

	it('PATCH rejects an empty displayName with 400', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: '' })
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('bad_request');
	});

	it('PATCH rejects a whitespace-only displayName with 400', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ displayName: '   ' })
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('bad_request');
	});

	it('PATCH rejects a body without displayName with 400 (no silent reset)', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({})
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});

	it('PATCH rejects invalid JSON body with 400', async () => {
		const res = await buildApp().request('/api/player/profile', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: 'not-json'
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});
});

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04];

describe('player avatar route (Bun)', () => {
	// Isolate avatar writes to a per-test temp directory instead of the shared
	// default ./data, which could collide with real data or parallel runs.
	let dataDir: string;
	let originalDataDir: string | undefined;

	beforeEach(() => {
		originalDataDir = process.env.DATA_DIR;
		dataDir = mkdtempSync(join(tmpdir(), 'perseus-player-test-'));
		process.env.DATA_DIR = dataDir;
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		if (originalDataDir === undefined) {
			delete process.env.DATA_DIR;
		} else {
			process.env.DATA_DIR = originalDataDir;
		}
	});

	it('POST avatar stores the file and returns avatarUrl', async () => {
		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');

		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.avatarUrl).toBe('/api/player/p1/avatar');
	});

	it('GET avatar serves the stored image with sniffed content-type', async () => {
		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});

		const res = await buildApp().request('/api/player/p1/avatar');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		const buf = new Uint8Array(await res.arrayBuffer());
		expect(buf[0]).toBe(0x89);
	});

	it('GET unknown avatar returns 404', async () => {
		const res = await buildApp().request('/api/player/nobody/avatar');
		expect(res.status).toBe(404);
	});

	it('GET avatar rejects path-traversal player ids with 400', async () => {
		const res = await buildApp().request('/api/player/..%2f..%2fetc/avatar');
		expect(res.status).toBe(400);
	});

	it('POST avatar rejects missing file with 400', async () => {
		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: new FormData()
		});
		expect(res.status).toBe(400);
	});

	it('POST avatar rejects unsupported type with 400', async () => {
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' });
		const form = new FormData();
		form.append('avatar', blob, 'a.gif');
		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});
		expect(res.status).toBe(400);
	});

	it('POST avatar rejects oversized file with 400', async () => {
		const blob = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});
		expect(res.status).toBe(400);
	});

	it('POST avatar preserves an existing displayName', async () => {
		const { updateProfileDisplayName } = await import('@perseus/shared');
		await (updateProfileDisplayName as any)({}, 'p1', 'KeepMe');

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});

		const { getProfileOverride } = await import('@perseus/shared');
		const row = await (getProfileOverride as any)({}, 'p1');
		expect(row.displayName).toBe('KeepMe');
		expect(row.avatarUrl).toBe('/api/player/p1/avatar');
	});

	it('rolls back the avatar file and returns 500 when the DB override write throws (prior avatar exists)', async () => {
		// Seed a pre-existing avatar so the rollback path restores it.
		const { mkdirSync } = await import('node:fs');
		const avatarPath = join(dataDir, 'avatars', 'p1');
		mkdirSync(join(dataDir, 'avatars'), { recursive: true });
		writeFileSync(avatarPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]));

		const { updateProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(updateProfileAvatarUrl).mockRejectedValueOnce(new Error('DB down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});

		expect(res.status).toBe(500);
		// File must be restored to the prior bytes, not left with the new upload.
		const restored = readFileSync(avatarPath);
		expect(Array.from(restored)).toEqual([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar DB write failed; rolling back avatar file:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('leaves the new avatar file orphaned on DB write failure when no prior avatar existed', async () => {
		const { updateProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(updateProfileAvatarUrl).mockRejectedValueOnce(new Error('DB down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});

		expect(res.status).toBe(500);
		// The new file is left in place (orphaned) rather than deleted, to
		// avoid a TOCTOU race where a blind rm could remove another concurrent
		// upload's file. The profile DB write failed, so the profile doesn't
		// point at this path — the orphan is harmless.
		expect(existsSync(join(dataDir, 'avatars', 'p1'))).toBe(true);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar DB write failed; rolling back avatar file:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('player lists (Bun)', () => {
	beforeEach(async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__puzzlesStore.clear();
		(shared as any).__statsStore.clear();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('GET puzzles returns owned puzzles', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__puzzlesStore.set('p1', [
			{ id: 'pz1', name: 'Cat', pieceCount: 4, status: 'ready', createdAt: 1 }
		]);
		const res = await buildApp().request('/api/player/puzzles', { headers: AUTH_COOKIE });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.puzzles).toHaveLength(1);
		expect(body.puzzles[0].name).toBe('Cat');
	});

	it('GET puzzles forwards limit and cursor query params', async () => {
		const { listPlayerPuzzles } = await import('@perseus/shared');
		await buildApp().request('/api/player/puzzles?limit=5&cursor=100', { headers: AUTH_COOKIE });
		expect(listPlayerPuzzles).toHaveBeenCalledWith(expect.anything(), 'p1', {
			limit: 5,
			cursor: '100'
		});
	});

	it('GET puzzles requires authentication', async () => {
		const res = await buildApp().request('/api/player/puzzles');
		expect(res.status).toBe(401);
	});

	it('GET stats returns recorded stats', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__statsStore.set('p1', [
			{
				puzzleId: 'pz1',
				puzzleName: 'Cat',
				bestTimeSeconds: 90,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			}
		]);
		const res = await buildApp().request('/api/player/stats', { headers: AUTH_COOKIE });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.stats).toHaveLength(1);
		expect(body.stats[0].bestTimeSeconds).toBe(90);
	});

	it('GET stats forwards limit query param', async () => {
		const { listPlayerStats } = await import('@perseus/shared');
		await buildApp().request('/api/player/stats?limit=10', { headers: AUTH_COOKIE });
		expect(listPlayerStats).toHaveBeenCalledWith(expect.anything(), 'p1', { limit: 10 });
	});

	it('GET stats requires authentication', async () => {
		const res = await buildApp().request('/api/player/stats');
		expect(res.status).toBe(401);
	});
});

describe('player response validation (Bun)', () => {
	beforeEach(async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__store?.clear();
		(shared as any).__puzzlesStore?.clear();
		(shared as any).__statsStore?.clear();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('GET profile returns 500 when the assembled profile fails validation', async () => {
		// getPlayerSummary returns a shape that isPlayerProfile rejects (NaN is
		// not a finite number), simulating a schema/contract drift.
		const { getPlayerSummary } = await import('@perseus/shared');
		vi.mocked(getPlayerSummary).mockResolvedValueOnce({
			puzzlesUploaded: NaN,
			puzzlesSolved: 0,
			totalCompletions: 0
		});
		const res = await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE });
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe('internal_error');
	});

	it('GET puzzles returns 500 when a projected row fails validation', async () => {
		const shared = await import('@perseus/shared');
		// Missing required field `name` → isPlayerPuzzleSummary rejects.
		(shared as any).__puzzlesStore.set('p1', [
			{ id: 'pz1', pieceCount: 4, status: 'ready', createdAt: 1 }
		]);
		const res = await buildApp().request('/api/player/puzzles', { headers: AUTH_COOKIE });
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe('internal_error');
	});

	it('GET stats returns 500 when a projected row fails validation', async () => {
		const shared = await import('@perseus/shared');
		// Missing required field `puzzleName` → isPlayerStatRow rejects.
		(shared as any).__statsStore.set('p1', [
			{
				puzzleId: 'pz1',
				bestTimeSeconds: 90,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			}
		]);
		const res = await buildApp().request('/api/player/stats', { headers: AUTH_COOKIE });
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe('internal_error');
	});
});
