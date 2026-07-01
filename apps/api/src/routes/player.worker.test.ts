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
	const store = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
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

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04];

describe('player avatar route (Worker)', () => {
	// Self-contained auth setup: this block must not depend on a leaked
	// getPlayerSession mock from the profile suite above. Without this,
	// running the avatar tests in isolation resolves the session to
	// undefined and every case fails with 401.
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('POST avatar stores to R2 and returns avatarUrl', async () => {
		const { bucket } = createMockBucket();
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
		expect(bucket.put).toHaveBeenCalledWith('avatars/p1', expect.any(Uint8Array), {
			httpMetadata: { contentType: 'image/png' }
		});
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

	it('rolls back R2 and returns 500 when the DB override write throws (prior avatar exists)', async () => {
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Seed a pre-existing avatar so the rollback path restores it.
		const priorPng = [0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb];
		await bucket.put(
			'avatars/p1',
			new Uint8Array(priorPng) as unknown as ReadableStream<Uint8Array>,
			{
				httpMetadata: { contentType: 'image/png' }
			}
		);

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
		// R2 must have been restored to the prior bytes, not left with the new upload.
		const restored = store.get('avatars/p1');
		expect(restored).toBeDefined();
		expect(Array.from(new Uint8Array(restored!.body))).toEqual(priorPng);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar DB write failed; rolling back R2 object:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('leaves the new R2 object orphaned on DB write failure when no prior avatar existed', async () => {
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// No prior avatar seeded -> rollback leaves the freshly-written object
		// in place (orphaned) rather than deleting it, to avoid a TOCTOU race
		// where a blind delete could remove another concurrent upload's object.
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
		// The orphaned object remains; delete is never called.
		expect(store.has('avatars/p1')).toBe(true);
		expect(bucket.delete).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('does not clobber a newer upload on conditional restore (etag mismatch)', async () => {
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;

		// Seed a prior avatar so the rollback path attempts a conditional restore.
		const priorPng = [0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb];
		await bucket.put(
			'avatars/p1',
			new Uint8Array(priorPng) as unknown as ReadableStream<Uint8Array>,
			{ httpMetadata: { contentType: 'image/png' } }
		);

		// First upload: put new bytes, then DB write fails. We intercept the
		// put to simulate a second upload overwriting the key between the
		// first upload's put and its rollback restore.
		const { updateProfileAvatarUrl } = await import('@perseus/shared');
		vi.mocked(updateProfileAvatarUrl).mockRejectedValueOnce(new Error('D1 down'));

		// After the first upload's initial put, simulate a concurrent second
		// upload that overwrites the same key with different bytes and a new
		// etag. The first upload's conditional restore (onlyIf: etagMatches
		// its own put etag) must fail and leave the second upload intact.
		const secondUploadBytes = [0xff, 0xd8, 0xff, 0xe0, 0x99, 0x88];
		const originalPut = vi.mocked(bucket.put);
		bucket.put = vi.fn(async (key: string, body: ReadableStream<Uint8Array>, opts?: any) => {
			const result = await originalPut(key, body, opts);
			// Only inject the concurrent overwrite after the first upload's
			// initial put (not the conditional restore, which has onlyIf).
			if (!opts?.onlyIf && key === 'avatars/p1') {
				await originalPut(
					key,
					new Uint8Array(secondUploadBytes) as unknown as ReadableStream<Uint8Array>,
					{ httpMetadata: { contentType: 'image/jpeg' } }
				);
			}
			return result;
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
		// The second upload's bytes must remain — the conditional restore did
		// not clobber them because the etag no longer matched.
		const current = store.get('avatars/p1');
		expect(current).toBeDefined();
		expect(Array.from(new Uint8Array(current!.body))).toEqual(secondUploadBytes);
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
