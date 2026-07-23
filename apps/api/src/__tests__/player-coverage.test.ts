/**
 * Coverage tests for player.ts (Bun runtime):
 * - sniffImageType WebP branch (lines 48-59)
 * - POST /avatar invalid form data catch (line 142)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const store = new Map<
		string,
		{ displayName: string | null; avatarUrl: string | null; avatarUpdateToken: string | null }
	>();
	return {
		...actual,
		__store: store,
		getProfileOverride: vi.fn((db: unknown, playerId: string) => store.get(playerId) ?? null),
		updateProfileDisplayName: vi.fn((db: unknown, playerId: string, displayName: string | null) => {
			const existing = store.get(playerId) ?? {
				displayName: null,
				avatarUrl: null,
				avatarUpdateToken: null
			};
			store.set(playerId, { ...existing, displayName });
		}),
		updateProfileAvatarUrl: vi.fn(
			(db: unknown, playerId: string, avatarUrl: string, _ts: number, token?: string) => {
				const existing = store.get(playerId) ?? {
					displayName: null,
					avatarUrl: null,
					avatarUpdateToken: null
				};
				store.set(playerId, { ...existing, avatarUrl, avatarUpdateToken: token ?? null });
			}
		),
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
import type { PlayerSessionRecord } from '../services/player-auth';
import { Hono } from 'hono';

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

// Minimal WebP: RIFF....WEBP + VP8X chunk with canvas dimensions.
// RIFF header (12 bytes) + VP8X chunk (18 bytes) = 30 bytes.
// VP8X layout: fourCC(4) + chunkSize(4) + flags(1) + reserved(3) + width-1(3) + height-1(3)
const WEBP_BYTES = new Uint8Array([
	0x52,
	0x49,
	0x46,
	0x46, // "RIFF"
	0x16,
	0x00,
	0x00,
	0x00, // file size = 30 - 8 = 22 (little-endian)
	0x57,
	0x45,
	0x42,
	0x50, // "WEBP"
	0x56,
	0x50,
	0x38,
	0x58, // "VP8X"
	0x00,
	0x00,
	0x00,
	0x00, // chunk size (placeholder)
	0x00, // flags
	0x00,
	0x00,
	0x00, // reserved
	0x2f,
	0x00,
	0x00, // width-1 = 47 → width = 48
	0x2f,
	0x00,
	0x00 // height-1 = 47 → height = 48
]);

describe('player avatar – WebP sniffing (Bun)', () => {
	let dataDir: string;
	let originalDataDir: string | undefined;

	beforeEach(() => {
		originalDataDir = process.env.DATA_DIR;
		dataDir = mkdtempSync(join(tmpdir(), 'perseus-player-webp-'));
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

	it('accepts and stores a WebP avatar (sniffImageType webp branch)', async () => {
		const blob = new Blob([WEBP_BYTES], { type: 'image/webp' });
		const form = new FormData();
		form.append('avatar', blob, 'a.webp');

		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.avatarUrl).toBe('/api/player/p1/avatar');
	});

	it('serves a stored WebP avatar with sniffed image/webp content-type', async () => {
		const blob = new Blob([WEBP_BYTES], { type: 'image/webp' });
		const form = new FormData();
		form.append('avatar', blob, 'a.webp');
		await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});

		const res = await buildApp().request('/api/player/p1/avatar');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/webp');
	});
});

describe('player avatar – unknown image type (Bun, line 59)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('rejects an avatar with unrecognized magic bytes with 400', async () => {
		// Text content with image/jpeg MIME — magic bytes don't match any type
		const textBlob = new Blob([new TextEncoder().encode('not an image')], {
			type: 'image/jpeg'
		});
		const form = new FormData();
		form.append('avatar', textBlob, 'a.jpg');

		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});
});

describe('player avatar – invalid form data (Bun, line 142)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('returns 400 when the avatar form data cannot be parsed', async () => {
		const res = await buildApp().request('/api/player/avatar', {
			method: 'POST',
			headers: {
				...AUTH_COOKIE,
				'Content-Type': 'application/json'
			},
			body: '{"not":"form-data"}'
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toBe('Invalid form data');
	});
});
