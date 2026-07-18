/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for player.worker.ts (Worker runtime):
 * - sniffImageType WebP branch (lines 50-61)
 * - POST /avatar invalid form data catch (line 143)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
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
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		})),
		listPlayerPuzzles: vi.fn(async () => ({ rows: [], nextCursor: undefined })),
		listPlayerStats: vi.fn(async () => ({ rows: [], nextCursor: undefined }))
	};
});

vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

import player from '../routes/player.worker';
import type { Env } from '../worker';
import * as playerAuth from '../services/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

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
	const app = new Hono<{
		Bindings: Env;
		Variables: { playerSession: PlayerSessionRecord };
	}>();
	app.route('/api/player', player);
	return app;
}

// Minimal in-memory R2 bucket double.
function createMockBucket() {
	const store = new Map<string, { body: ArrayBuffer; contentType: string }>();
	const bucket = {
		put: vi.fn(
			async (
				key: string,
				body: ReadableStream<Uint8Array>,
				opts?: { httpMetadata?: { contentType?: string } }
			) => {
				const buf = await new Response(body).arrayBuffer();
				store.set(key, {
					body: buf,
					contentType: opts?.httpMetadata?.contentType ?? ''
				});
			}
		),
		get: vi.fn(async (key: string) => {
			const entry = store.get(key);
			if (!entry) return null;
			return {
				body: new Response(entry.body).body,
				writeHttpMetadata: (h: Headers) => {
					if (entry.contentType) h.set('Content-Type', entry.contentType);
				}
			};
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		})
	};
	return { bucket, store };
}

// Minimal WebP: RIFF....WEBP + VP8X chunk with canvas dimensions.
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

describe('player avatar – WebP sniffing (Worker)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('accepts and stores a WebP avatar to R2 (sniffImageType webp branch)', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		const blob = new Blob([WEBP_BYTES], { type: 'image/webp' });
		const form = new FormData();
		form.append('avatar', blob, 'a.webp');

		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.avatarUrl).toBe('/api/player/p1/avatar');
		expect(bucket.put).toHaveBeenCalledWith('avatars/p1', expect.any(Uint8Array), {
			httpMetadata: { contentType: 'image/webp' }
		});
	});

	it('serves a stored WebP avatar from R2 with sniffed content-type', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		const blob = new Blob([WEBP_BYTES], { type: 'image/webp' });
		const form = new FormData();
		form.append('avatar', blob, 'a.webp');
		await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		const res = await buildApp().request('/api/player/p1/avatar', {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/webp');
	});
});

describe('player avatar – unknown image type (Worker, line 61)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('rejects an avatar with unrecognized magic bytes with 400', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Text content with image/jpeg MIME — magic bytes don't match any type
		const textBlob = new Blob([new TextEncoder().encode('not an image')], {
			type: 'image/jpeg'
		});
		const form = new FormData();
		form.append('avatar', textBlob, 'a.jpg');

		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(bucket.put).not.toHaveBeenCalled();
	});
});

describe('player avatar – invalid form data (Worker, line 143)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('returns 400 when the avatar form data cannot be parsed', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		const res = await buildApp().request(
			'/api/player/avatar',
			{
				method: 'POST',
				headers: {
					...AUTH_COOKIE,
					'Content-Type': 'application/json'
				},
				body: '{"not":"form-data"}'
			},
			env
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(body.message).toBe('Invalid form data');
		expect(bucket.put).not.toHaveBeenCalled();
	});
});
