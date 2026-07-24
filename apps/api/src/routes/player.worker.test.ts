/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock the Worker DB factory so the route never touches a real D1 binding.
vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
}));

// Mock the shared repositories with an in-memory store so the route's
// override-preservation logic (PATCH keeps existing avatarUrl) is exercised.
vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const store = new Map<
		string,
		{
			displayName: string | null;
			avatarUrl: string | null;
			updatedAt?: number;
			avatarUpdateToken?: string;
		}
	>();
	// In-memory stores backing the mocked list repositories so the list
	// routes can be exercised end-to-end without a real D1 binding.
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
		updateProfileAvatarUrl: vi.fn(
			(
				db: unknown,
				playerId: string,
				avatarUrl: string,
				updatedAt?: number,
				avatarUpdateToken?: string
			) => {
				const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
				store.set(playerId, { ...existing, avatarUrl, updatedAt, avatarUpdateToken });
			}
		),
		clearProfileAvatarUrl: vi.fn(async (db: unknown, playerId: string) => {
			const existing = store.get(playerId) ?? { displayName: null, avatarUrl: null };
			store.set(playerId, { ...existing, avatarUrl: null });
		}),
		clearProfileAvatarUrlIfOwned: vi.fn(
			async (db: unknown, playerId: string, ownerToken: string) => {
				const existing = store.get(playerId);
				// Owner-checked: only clear when the row's avatarUpdateToken matches.
				// A missing row or a mismatched token is a no-op.
				if (existing && (existing as any).avatarUpdateToken === ownerToken) {
					store.set(playerId, { ...existing, avatarUrl: null });
				}
			}
		),
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
vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

import player from './player.worker';
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

const DUMMY_ENV = {} as unknown as Env;
const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };

function buildApp() {
	const app = new Hono<{
		Bindings: Env;
		Variables: { playerSession: PlayerSessionRecord };
	}>();
	app.route('/api/player', player);
	return app;
}

describe('player profile routes (Worker)', () => {
	beforeEach(async () => {
		const shared = await import('@perseus/shared');
		const store = (shared as any).__store as Map<string, unknown> | undefined;
		store?.clear();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('GET profile returns Google defaults when no override', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.name).toBe('Google Name');
		expect(body.picture).toBe('g.jpg');
		expect(body.summary).toEqual({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		});
	});

	it('PATCH then GET reflects override', async () => {
		const patch = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: 'Custom' })
			},
			DUMMY_ENV
		);
		expect(patch.status).toBe(200);

		const res = await buildApp().request(
			'/api/player/profile',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		const body = (await res.json()) as any;
		expect(body.name).toBe('Custom');
	});

	it('PATCH with null resets to Google name', async () => {
		// Seed an override first.
		const { updateProfileDisplayName } = await import('@perseus/shared');
		await (updateProfileDisplayName as any)({}, 'p1', 'Custom');

		await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: null })
			},
			DUMMY_ENV
		);

		const body = (await (
			await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE }, DUMMY_ENV)
		).json()) as any;
		expect(body.name).toBe('Google Name');
	});

	it('PATCH rejects non-string displayName with 400', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: 42 })
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
	});

	it('PATCH rejects a displayName longer than 255 characters with 400', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: 'x'.repeat(256) })
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
	});

	it('PATCH accepts a 255-character displayName', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: 'x'.repeat(255) })
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
	});

	it('PATCH trims surrounding whitespace before storing displayName', async () => {
		const patch = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: '  Custom  ' })
			},
			DUMMY_ENV
		);
		expect(patch.status).toBe(200);

		const body = (await (
			await buildApp().request('/api/player/profile', { headers: AUTH_COOKIE }, DUMMY_ENV)
		).json()) as any;
		expect(body.name).toBe('Custom');
	});

	it('PATCH rejects an empty displayName with 400', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: '' })
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('bad_request');
	});

	it('PATCH rejects a whitespace-only displayName with 400', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: '   ' })
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('bad_request');
	});

	it('PATCH rejects a body without displayName with 400 (no silent reset)', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({})
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
	});

	it('PATCH rejects invalid JSON body with 400', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: 'not-json'
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
	});
});

// Minimal in-memory R2 bucket double: put() stores bytes + contentType,
// get() returns a body stream + writeHttpMetadata like the real binding.
// put() returns an R2Object-like { etag } so the rollback's conditional
// restore (onlyIf: { etagMatches }) can be exercised. When onlyIf is
// provided, put() only writes if the current stored etag matches.
function createMockBucket() {
	const store = new Map<string, { body: ArrayBuffer; contentType: string; etag: string }>();
	let etagCounter = 0;
	const bucket = {
		put: vi.fn(
			async (
				key: string,
				body: ReadableStream<Uint8Array>,
				opts?: {
					httpMetadata?: { contentType?: string };
					onlyIf?: { etagMatches?: string };
				}
			) => {
				// Conditional put: only write if the current etag matches.
				if (opts?.onlyIf?.etagMatches) {
					const current = store.get(key);
					if (!current || current.etag !== opts.onlyIf.etagMatches) {
						return null; // precondition failed — mirrors R2 behavior
					}
				}
				const buf = await new Response(body).arrayBuffer();
				const etag = `etag-${++etagCounter}`;
				store.set(key, {
					body: buf,
					contentType: opts?.httpMetadata?.contentType ?? '',
					etag
				});
				return { etag };
			}
		),
		get: vi.fn(async (key: string) => {
			const entry = store.get(key);
			if (!entry) return null;
			return {
				body: new Response(entry.body).body,
				arrayBuffer: async () => entry.body,
				httpMetadata: { contentType: entry.contentType },
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

// Minimal PNG with a valid IHDR chunk so parseImageDimensions can extract
// width/height, plus an IEND chunk so validateImageEndMarker confirms the
// image is structurally complete. PNG signature (8) + IHDR length (4) + "IHDR"
// (4) + width (4) + height (4) + IEND chunk (12) = 36 bytes.
// parseImageDimensions reads bytes 16–24 for dims; validateImageEndMarker
// checks the last 12 bytes for the IEND chunk.
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

describe('player avatar route (Worker)', () => {
	// Self-contained auth setup: this block must not depend on a leaked
	// getPlayerSession mock from the profile suite above. Without this,
	// running the avatar tests in isolation resolves the session to
	// undefined and every case fails with 401.
	beforeEach(async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		const shared = await import('@perseus/shared');
		const store = (shared as any).__store as Map<string, unknown> | undefined;
		store?.clear();
	});

	it('POST avatar stores to R2 and returns avatarUrl', async () => {
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');

		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.avatarUrl).toBe('/api/player/p1/avatar');
		// The versioned key (avatars/p1/{token}) must hold the uploaded bytes.
		// The token is a UUID generated by the route — verify via the mock store.
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		const token = profileStore.get('p1')?.avatarUpdateToken;
		expect(token).toBeTruthy();
		const versionedKey = `avatars/p1/${token}`;
		expect(bucket.put).toHaveBeenCalledWith(versionedKey, expect.any(Uint8Array), {
			httpMetadata: { contentType: 'image/png' }
		});
		const live = store.get(versionedKey);
		expect(live).toBeDefined();
		expect(live!.contentType).toBe('image/png');
		// No staging objects should exist — the versioned key IS the live key.
		const stagingKeys = [...store.keys()].filter((k) => k.startsWith('avatars/staging/'));
		expect(stagingKeys).toHaveLength(0);
	});

	it('GET avatar serves the stored image from R2', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		const res = await buildApp().request('/api/player/p1/avatar', {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		const buf = new Uint8Array(await res.arrayBuffer());
		expect(buf[0]).toBe(0x89);
	});

	it('GET unknown avatar returns 404', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const res = await buildApp().request('/api/player/nobody/avatar', {}, env);
		expect(res.status).toBe(404);
	});

	it('POST avatar rejects missing file with 400', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: new FormData() },
			env
		);
		expect(res.status).toBe(400);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('POST avatar rejects unsupported type with 400', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' });
		const form = new FormData();
		form.append('avatar', blob, 'a.gif');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);
		expect(res.status).toBe(400);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('POST avatar rejects oversized file with 400', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const blob = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);
		expect(res.status).toBe(400);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('POST avatar rejects truncated PNG (valid header but no IEND) with 400', async () => {
		// A PNG with a valid IHDR header but no IEND chunk passes
		// parseImageDimensions but should be rejected by
		// validateImageEndMarker — a truncated image would render broken
		// for the player.
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		// PNG_BYTES without the last 12 bytes (IEND chunk)
		const truncatedPng = PNG_BYTES.slice(0, PNG_BYTES.length - 12);
		const blob = new Blob([new Uint8Array(truncatedPng)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Image is corrupted or truncated');
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('POST avatar preserves an existing displayName', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const { updateProfileDisplayName, getProfileOverride } = await import('@perseus/shared');
		await (updateProfileDisplayName as any)({}, 'p1', 'KeepMe');

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		const row = await (getProfileOverride as any)({}, 'p1');
		expect(row.displayName).toBe('KeepMe');
		expect(row.avatarUrl).toBe('/api/player/p1/avatar');
	});

	it('cleans up versioned R2 object and returns 500 when the DB override write throws (prior avatar preserved)', async () => {
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Seed a pre-existing avatar at a versioned key. The new upload
		// writes to a different versioned key, so the prior avatar must
		// remain intact on DB failure.
		const priorToken = 'prior-token';
		const priorKey = `avatars/p1/${priorToken}`;
		const priorPng = [0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb];
		await bucket.put(priorKey, new Uint8Array(priorPng) as unknown as ReadableStream<Uint8Array>, {
			httpMetadata: { contentType: 'image/png' }
		});

		// Force the DB override write to fail.
		const { updateProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(updateProfileAvatarUrl).mockRejectedValueOnce(new Error('D1 down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(500);
		// The prior versioned key must still hold the prior bytes — the
		// failed upload wrote to a different versioned key and cleaned it up.
		const live = store.get(priorKey);
		expect(live).toBeDefined();
		expect(Array.from(new Uint8Array(live!.body))).toEqual(priorPng);
		// The new upload's versioned key was cleaned up — only the prior key remains.
		const avatarKeys = [...store.keys()].filter((k) => k.startsWith('avatars/p1/'));
		expect(avatarKeys).toEqual([priorKey]);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar DB write failed; cleaning up versioned R2 object:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('leaves no orphaned object on DB write failure when no prior avatar existed', async () => {
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// No prior avatar seeded. The upload writes to a unique versioned
		// key, then deletes it on DB failure. No bytes are reachable via
		// the public serve route (which reads the token from D1).
		const { updateProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(updateProfileAvatarUrl).mockRejectedValueOnce(new Error('D1 down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(500);
		// No avatar keys should remain — the versioned object was cleaned up.
		const avatarKeys = [...store.keys()].filter((k) => k.startsWith('avatars/'));
		expect(avatarKeys).toHaveLength(0);
		// The versioned object was deleted.
		expect(bucket.delete).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('returns 500 and does not write D1 when the R2 put fails', async () => {
		// With versioned keys, the R2 write happens BEFORE the D1 write.
		// If R2 fails, D1 is never touched — no rollback needed.
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		bucket.put = vi.fn(async () => {
			throw new Error('R2 quota exceeded');
		}) as any;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(500);
		// No R2 objects should exist — the put failed.
		const avatarKeys = [...store.keys()].filter((k) => k.startsWith('avatars/'));
		expect(avatarKeys).toHaveLength(0);
		// D1 was never written — no avatarUrl or token in the profile store.
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		expect(profileStore.get('p1')).toBeUndefined();
		expect(consoleSpy).toHaveBeenCalledWith('Avatar R2 put failed:', expect.any(Error));
		consoleSpy.mockRestore();
	});

	it('uses a unique versioned key per upload so concurrent failures do not interfere', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Each upload writes to its own versioned key
		// (avatars/p1/{token}), so a DB failure in one upload only
		// deletes that upload's versioned object — never another upload's.
		const { updateProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(updateProfileAvatarUrl).mockRejectedValueOnce(new Error('D1 down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(500);
		// Verify that a versioned key was used (not the legacy fixed key).
		const putCalls = vi.mocked(bucket.put).mock.calls;
		const versionedPuts = putCalls.filter(
			([k]) =>
				typeof k === 'string' && k.startsWith('avatars/p1/') && !k.startsWith('avatars/staging/')
		);
		expect(versionedPuts).toHaveLength(1);
		// The legacy fixed key was never written.
		const legacyPuts = putCalls.filter(([k]) => k === 'avatars/p1');
		expect(legacyPuts).toHaveLength(0);
		// The versioned object was cleaned up.
		expect(bucket.delete).toHaveBeenCalledWith(versionedPuts[0][0]);
		consoleSpy.mockRestore();
	});

	it('concurrent uploads write to distinct versioned keys (no race)', async () => {
		// Item 4 fix: two uploads A and B for the same player overlap.
		// Each writes to its own versioned key (avatars/p1/{token}).
		// D1's avatarUpdateToken selects which one the serve route reads.
		// The last D1 write wins (both are valid avatars), and the
		// corresponding R2 object is the one served. No rollback or
		// owner-checked clear is needed — the losing upload's R2 object
		// simply lingers as storage waste (not reachable by the serve route).
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// First upload succeeds fully.
		const blob1 = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form1 = new FormData();
		form1.append('avatar', blob1, 'a.png');
		const res1 = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form1 },
			env
		);
		expect(res1.status).toBe(200);

		// Second upload also succeeds — writes to a different versioned key.
		const blob2 = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form2 = new FormData();
		form2.append('avatar', blob2, 'b.png');
		const res2 = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form2 },
			env
		);
		expect(res2.status).toBe(200);

		// Two distinct versioned keys were written to R2.
		const putCalls = vi.mocked(bucket.put).mock.calls;
		const versionedPuts = putCalls.filter(
			([k]) =>
				typeof k === 'string' && k.startsWith('avatars/p1/') && !k.startsWith('avatars/staging/')
		);
		expect(versionedPuts).toHaveLength(2);
		expect(versionedPuts[0][0]).not.toBe(versionedPuts[1][0]);

		// D1's avatarUpdateToken points to the second upload's key
		// (last D1 write wins).
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		const token = profileStore.get('p1')?.avatarUpdateToken;
		expect(token).toBeTruthy();
		// The serve route reads from the D1-selected versioned key.
		const serveRes = await buildApp().request('/api/player/p1/avatar', {}, env);
		expect(serveRes.status).toBe(200);
	});

	it('logs and continues when D1 read for previous-token cleanup fails', async () => {
		// Line 193: getProfileOverride throws during the pre-upload read
		// for previousToken. The upload proceeds (no cleanup) and succeeds.
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		const { getProfileOverride } = await import('@perseus/shared');
		vi.mocked(getProfileOverride).mockRejectedValueOnce(new Error('D1 read down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to read previous override for cleanup:',
			expect.any(Error)
		);
		// The upload still wrote a versioned object.
		const avatarKeys = [...store.keys()].filter((k) => k.startsWith('avatars/p1/'));
		expect(avatarKeys).toHaveLength(1);
		consoleSpy.mockRestore();
	});

	it('logs when R2 delete of superseded object fails (best-effort cleanup)', async () => {
		// Line 251: the .catch on bucket.delete logs but does not fail the
		// request when the superseded R2 object cannot be deleted.
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Seed a prior avatar with a known token.
		const priorToken = 'prior-token';
		const priorKey = `avatars/p1/${priorToken}`;
		const priorPng = [0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb];
		await bucket.put(priorKey, new Uint8Array(priorPng) as unknown as ReadableStream<Uint8Array>, {
			httpMetadata: { contentType: 'image/png' }
		});

		// Pre-populate the D1 store with the prior token so the upload
		// captures previousToken and attempts cleanup.
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		profileStore.set('p1', {
			displayName: null,
			avatarUrl: '/api/player/p1/avatar',
			avatarUpdateToken: priorToken
		});

		// Make bucket.delete reject.
		bucket.delete = vi.fn(async () => {
			throw new Error('R2 delete failed');
		}) as any;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to delete superseded R2 object:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when D1 re-read for cleanup fails after successful upload', async () => {
		// Line 255: the second getProfileOverride (to verify our token is
		// still authoritative before deleting the superseded object) throws.
		// The request still succeeds; the superseded object lingers.
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Seed a prior avatar.
		const priorToken = 'prior-token';
		const priorKey = `avatars/p1/${priorToken}`;
		const priorPng = [0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb];
		await bucket.put(priorKey, new Uint8Array(priorPng) as unknown as ReadableStream<Uint8Array>, {
			httpMetadata: { contentType: 'image/png' }
		});

		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		profileStore.set('p1', {
			displayName: null,
			avatarUrl: '/api/player/p1/avatar',
			avatarUpdateToken: priorToken
		});

		// The first getProfileOverride (pre-upload read) succeeds and
		// returns the prior token. The second (post-upload re-read for
		// cleanup) throws.
		const { getProfileOverride } = await import('@perseus/shared');
		vi.mocked(getProfileOverride)
			.mockResolvedValueOnce({
				displayName: null,
				avatarUrl: '/api/player/p1/avatar',
				avatarUpdateToken: priorToken
			} as any)
			.mockRejectedValueOnce(new Error('D1 re-read down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
		const form = new FormData();
		form.append('avatar', blob, 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to re-read override for cleanup:',
			expect.any(Error)
		);
		// The superseded object was NOT deleted (re-read failed before the
		// delete could run).
		expect(store.get(priorKey)).toBeDefined();
		consoleSpy.mockRestore();
	});

	it('serves legacy unversioned avatar when D1 lookup fails', async () => {
		// Lines 283-288: the serve route's D1 lookup throws, so it falls
		// back to the legacy unversioned key (avatars/{playerId}).
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Seed a legacy avatar at the unversioned key.
		const legacyKey = 'avatars/p1';
		const legacyPng = [0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb];
		await bucket.put(
			legacyKey,
			new Uint8Array(legacyPng) as unknown as ReadableStream<Uint8Array>,
			{ httpMetadata: { contentType: 'image/png' } }
		);

		// Force the D1 lookup to throw.
		const { getProfileOverride } = await import('@perseus/shared');
		vi.mocked(getProfileOverride).mockRejectedValueOnce(new Error('D1 serve down'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await buildApp().request('/api/player/p1/avatar', {}, env);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		const buf = new Uint8Array(await res.arrayBuffer());
		expect(Array.from(buf)).toEqual(legacyPng);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar serve: D1 override lookup failed for p1, falling back to legacy key:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('player lists (Worker)', () => {
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
		const res = await buildApp().request(
			'/api/player/puzzles',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.puzzles).toHaveLength(1);
		expect(body.puzzles[0].name).toBe('Cat');
	});

	it('GET puzzles forwards limit and cursor query params', async () => {
		const { listPlayerPuzzles } = await import('@perseus/shared');
		await buildApp().request(
			'/api/player/puzzles?limit=5&cursor=100',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(listPlayerPuzzles).toHaveBeenCalledWith(expect.anything(), 'p1', {
			limit: 5,
			cursor: '100'
		});
	});

	it('GET puzzles requires authentication', async () => {
		const res = await buildApp().request('/api/player/puzzles', {}, DUMMY_ENV);
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
		const res = await buildApp().request('/api/player/stats', { headers: AUTH_COOKIE }, DUMMY_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.stats).toHaveLength(1);
		expect(body.stats[0].bestTimeSeconds).toBe(90);
	});

	it('GET stats forwards limit query param', async () => {
		const { listPlayerStats } = await import('@perseus/shared');
		await buildApp().request('/api/player/stats?limit=10', { headers: AUTH_COOKIE }, DUMMY_ENV);
		expect(listPlayerStats).toHaveBeenCalledWith(expect.anything(), 'p1', { limit: 10 });
	});

	it('GET stats requires authentication', async () => {
		const res = await buildApp().request('/api/player/stats', {}, DUMMY_ENV);
		expect(res.status).toBe(401);
	});
});

describe('player response validation (Worker)', () => {
	beforeEach(async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__store?.clear();
		(shared as any).__puzzlesStore?.clear();
		(shared as any).__statsStore?.clear();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('GET profile returns 500 when the assembled profile fails validation', async () => {
		const { getPlayerSummary } = await import('@perseus/shared');
		vi.mocked(getPlayerSummary).mockResolvedValueOnce({
			puzzlesUploaded: NaN,
			puzzlesSolved: 0,
			totalCompletions: 0
		});
		const res = await buildApp().request(
			'/api/player/profile',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe('internal_error');
	});

	it('GET puzzles returns 500 when a projected row fails validation', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__puzzlesStore.set('p1', [
			{ id: 'pz1', pieceCount: 4, status: 'ready', createdAt: 1 }
		]);
		const res = await buildApp().request(
			'/api/player/puzzles',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe('internal_error');
	});

	it('GET stats returns 500 when a projected row fails validation', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__statsStore.set('p1', [
			{
				puzzleId: 'pz1',
				bestTimeSeconds: 90,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			}
		]);
		const res = await buildApp().request('/api/player/stats', { headers: AUTH_COOKIE }, DUMMY_ENV);
		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe('internal_error');
	});
});
