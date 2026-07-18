/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage test for player.ts (Bun runtime):
 * - Avatar promotion rename failure rollback (lines 174-179): when rename
 *   throws after a successful DB override write, the route rolls back the DB
 *   avatarUrl, deletes the orphaned staging file, and returns 500.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock node:fs/promises so rename throws while mkdir/writeFile/unlink behave
// normally (the staging file must be created before the rename is attempted).
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		rename: vi.fn(async () => {
			throw new Error('Cross-device rename not permitted');
		})
	};
});

vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const store = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
	return {
		...actual,
		__store: store,
		getProfileOverride: vi.fn((db: unknown, playerId: string) => store.get(playerId) ?? null),
		updateProfileDisplayName: vi.fn((db: unknown, playerId: string, displayName: string | null) => {
			const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
			store.set(playerId, { ...existing, displayName });
		}),
		updateProfileAvatarUrl: vi.fn((db: unknown, playerId: string, avatarUrl: string) => {
			const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
			store.set(playerId, { ...existing, avatarUrl });
		}),
		clearProfileAvatarUrl: vi.fn(async (db: unknown, playerId: string) => {
			const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
			store.set(playerId, { ...existing, avatarUrl: null });
		}),
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		})),
		listPlayerPuzzles: vi.fn(async () => ({ rows: [], nextCursor: undefined })),
		listPlayerStats: vi.fn(async () => ({ rows: [], nextCursor: undefined }))
	};
});

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import player from '../routes/player';
import * as playerAuth from '../services/player-auth';
import { Hono } from 'hono';
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

// Minimal PNG with a valid IHDR chunk so parseImageDimensions can extract
// width/height, plus an IEND chunk so validateImageEndMarker confirms
// structural completeness.
const PNG_BYTES = [
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a, // PNG signature
	0x00,
	0x00,
	0x00,
	0x0d, // IHDR chunk length = 13
	0x49,
	0x48,
	0x44,
	0x52, // "IHDR"
	0x00,
	0x00,
	0x00,
	0x01, // width = 1
	0x00,
	0x00,
	0x00,
	0x01, // height = 1
	// IEND chunk: 4-byte zero length + "IEND" + CRC AE 42 60 82
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x45,
	0x4e,
	0x44,
	0xae,
	0x42,
	0x60,
	0x82
];

describe('player avatar – rename promotion failure rollback (Bun, lines 174-179)', () => {
	let dataDir: string;
	let originalDataDir: string | undefined;

	beforeEach(() => {
		originalDataDir = process.env.DATA_DIR;
		dataDir = mkdtempSync(join(tmpdir(), 'perseus-player-rename-'));
		process.env.DATA_DIR = dataDir;
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		if (originalDataDir === undefined) {
			delete process.env.DATA_DIR;
		} else {
			process.env.DATA_DIR = originalDataDir;
		}
	});

	it('rolls back DB avatarUrl, deletes the staging file, and returns 500 when rename fails', async () => {
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
		expect((await res.json()).error).toBe('internal_error');

		// The DB avatarUrl was rolled back to null so the profile does not
		// reference a serve route that 404s.
		const { clearProfileAvatarUrl } = await import('@perseus/shared');
		expect(clearProfileAvatarUrl).toHaveBeenCalledWith(expect.anything(), 'p1');

		// No staging files should remain — the orphaned staging file was deleted.
		const avatarsDir = join(dataDir, 'avatars');
		if (existsSync(avatarsDir)) {
			const files = readdirSync(avatarsDir);
			expect(files.filter((f) => f.startsWith('.staging-'))).toHaveLength(0);
		}

		// The rename failure was logged.
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar promotion rename failed; rolling back DB and staging file:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs (but does not throw) when the avatarUrl rollback itself fails after rename failure', async () => {
		// clearProfileAvatarUrl rejecting must not turn the 500 into an unhandled
		// rejection — the route swallows the rollback error and still returns 500.
		const { clearProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(clearProfileAvatarUrl).mockRejectedValueOnce(new Error('D1 rollback down'));

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
		// Both the rename failure and the rollback failure were logged.
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar promotion rename failed; rolling back DB and staging file:',
			expect.any(Error)
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to clear avatar URL after rename failure:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});
