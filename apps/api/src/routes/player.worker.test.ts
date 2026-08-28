/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock the Worker DB factory so the route never touches a real D1 binding.
vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/types', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/types')>();
	return {
		...actual,
		coercePuzzleStatus: vi.fn(actual.coercePuzzleStatus)
	};
});

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
	const familiesStore = new Map<string, unknown[]>();
	const statsStore = new Map<string, unknown[]>();
	return {
		...actual,
		// Mock validateImageEndMarker so the synthetic PNG_BYTES fixture
		// (valid headers but not decodable) passes validation. The real
		// function has dedicated unit tests in packages/shared.
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		// Exposed for test-only reset between cases.
		__store: store,
		__puzzlesStore: puzzlesStore,
		__familiesStore: familiesStore,
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
		getPlayerProgressionSummary: vi.fn(() => ({
			score: 0,
			rank: null,
			easyClears: 0,
			normalClears: 0,
			hardClears: 0,
			achievementsUnlocked: 0,
			achievementsTotal: 9,
			masteryEarned: 0
		})),
		ensurePublicDisplayName: vi.fn().mockResolvedValue(undefined),
		listPlayerPuzzles: vi.fn(
			async (db: unknown, playerId: string): Promise<{ rows: unknown[]; nextCursor?: string }> => ({
				rows: puzzlesStore.get(playerId) ?? [],
				nextCursor: undefined
			})
		),
		listPlayerPuzzleFamilies: vi.fn(
			async (db: unknown, playerId: string): Promise<{ rows: unknown[]; nextCursor?: string }> => ({
				rows: familiesStore.get(playerId) ?? [],
				nextCursor: undefined
			})
		),
		listPlayerStats: vi.fn(
			async (
				_db: unknown,
				playerId: string,
				opts: { cursor?: string }
			): Promise<{ rows: unknown[] }> => {
				if (opts.cursor !== undefined) {
					actual.parsePlayerStatsCursor(opts.cursor);
				}
				return { rows: statsStore.get(playerId) ?? [] };
			}
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
import { validateImageEndMarker } from '@perseus/shared';

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

	it('GET progression returns the authenticated player summary', async () => {
		const shared = await import('@perseus/shared');
		vi.mocked(shared.getPlayerProgressionSummary).mockResolvedValueOnce({
			score: 325,
			rank: 2,
			easyClears: 1,
			normalClears: 1,
			hardClears: 0,
			achievementsUnlocked: 2,
			achievementsTotal: 9,
			masteryEarned: 3
		});

		const res = await buildApp().request(
			'/api/player/progression',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toEqual({
			score: 325,
			rank: 2,
			easyClears: 1,
			normalClears: 1,
			hardClears: 0,
			achievementsUnlocked: 2,
			achievementsTotal: 9,
			masteryEarned: 3
		});
		expect(shared.getPlayerProgressionSummary).toHaveBeenCalledWith({}, 'p1');
	});

	it('GET progression returns 401 without auth', async () => {
		const res = await buildApp().request('/api/player/progression', {}, DUMMY_ENV);
		expect(res.status).toBe(401);
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

	it('PATCH rejects an email-shaped displayName with 400', async () => {
		const res = await buildApp().request(
			'/api/player/profile',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
				body: JSON.stringify({ displayName: 'player@example.com' })
			},
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(body.message).toBe('displayName is not allowed');
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
// width/height, plus an IDAT chunk (image data) and IEND chunk so
// validateImageEndMarker confirms the image is structurally complete.
// PNG signature (8) + IHDR (25) + IDAT (13) + IEND (12) = 58 bytes.
// parseImageDimensions reads bytes 16–24 for dims; validateImageEndMarker
// checks the last 12 bytes for IEND and scans chunks for at least one IDAT.
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
	0x08,
	0x02,
	0x00,
	0x00,
	0x00, // bitDepth=8, colorType=2, compression=0, filter=0, interlace=0
	0x00,
	0x00,
	0x00,
	0x00, // IHDR CRC (dummy — tests don't validate CRC)
	// IDAT chunk: length=1, 1 byte data, dummy CRC
	0x00,
	0x00,
	0x00,
	0x01, // IDAT length = 1
	0x49,
	0x44,
	0x41,
	0x54, // "IDAT"
	0x00, // 1 byte data
	0x00,
	0x00,
	0x00,
	0x00, // IDAT CRC (dummy)
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

	afterEach(async () => {
		// Restore the store-backed getProfileOverride factory implementation
		// even when a test's assertions fail before reaching an in-test
		// restore block. mockReset clears any per-test mockImplementation;
		// the reinstall below mirrors the module-level factory (line 37).
		const shared = await import('@perseus/shared');
		const store = (shared as any).__store as Map<string, any>;
		vi.mocked(shared.getProfileOverride).mockReset();
		vi.mocked(shared.getProfileOverride).mockImplementation(async (_db, playerId) => {
			return store.get(playerId) ?? null;
		});
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

	it('deletes the losing versioned object when a later upload wins after a prior token', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		const priorToken = 'prior-token';
		profileStore.set('p1', {
			displayName: null,
			avatarUrl: '/api/player/p1/avatar',
			avatarUpdateToken: priorToken
		});
		vi.mocked(shared.updateProfileAvatarUrl).mockImplementationOnce(
			async (_db, playerId, avatarUrl, updatedAt) => {
				profileStore.set(playerId, {
					displayName: null,
					avatarUrl,
					updatedAt,
					avatarUpdateToken: 'winning-token'
				});
			}
		);

		const form = new FormData();
		form.append('avatar', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(bucket.put).toHaveBeenCalledTimes(1);
		const versionedKey = vi.mocked(bucket.put).mock.calls[0][0];
		expect(bucket.delete).toHaveBeenCalledWith(versionedKey);
		expect(bucket.delete).not.toHaveBeenCalledWith(`avatars/p1/${priorToken}`);
	});

	it('deletes the losing versioned object when a later upload wins from no prior token', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		vi.mocked(shared.updateProfileAvatarUrl).mockImplementationOnce(
			async (_db, playerId, avatarUrl, updatedAt) => {
				profileStore.set(playerId, {
					displayName: null,
					avatarUrl,
					updatedAt,
					avatarUpdateToken: 'winning-token'
				});
			}
		);

		const form = new FormData();
		form.append('avatar', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(bucket.put).toHaveBeenCalledTimes(1);
		const versionedKey = vi.mocked(bucket.put).mock.calls[0][0];
		expect(bucket.delete).toHaveBeenCalledWith(versionedKey);
	});

	it('logs and continues when the avatar cleanup re-read throws', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		const priorToken = 'prior-token';
		vi.mocked(shared.getProfileOverride)
			.mockResolvedValueOnce({
				displayName: null,
				avatarUrl: '/api/player/p1/avatar',
				avatarUpdateToken: priorToken
			} as any)
			.mockRejectedValueOnce(new Error('D1 re-read down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const form = new FormData();
		form.append('avatar', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(bucket.delete).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to re-read override for cleanup:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when the losing versioned object delete fails after a prior token', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		profileStore.set('p1', {
			displayName: null,
			avatarUrl: '/api/player/p1/avatar',
			avatarUpdateToken: 'prior-token'
		});
		vi.mocked(shared.updateProfileAvatarUrl).mockImplementationOnce(
			async (_db, playerId, avatarUrl, updatedAt) => {
				profileStore.set(playerId, {
					displayName: null,
					avatarUrl,
					updatedAt,
					avatarUpdateToken: 'winning-token'
				});
			}
		);
		vi.mocked(bucket.delete).mockRejectedValueOnce(new Error('R2 delete down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const form = new FormData();
		form.append('avatar', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to delete losing R2 object:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when the losing versioned object delete fails from no prior token', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;
		vi.mocked(shared.updateProfileAvatarUrl).mockImplementationOnce(
			async (_db, playerId, avatarUrl, updatedAt) => {
				profileStore.set(playerId, {
					displayName: null,
					avatarUrl,
					updatedAt,
					avatarUpdateToken: 'winning-token'
				});
			}
		);
		vi.mocked(bucket.delete).mockRejectedValueOnce(new Error('R2 delete down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const form = new FormData();
		form.append('avatar', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to delete losing R2 object:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when the no-prior-token cleanup re-read throws', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		vi.mocked(shared.getProfileOverride)
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('D1 re-read down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const form = new FormData();
		form.append('avatar', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'a.png');
		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(200);
		expect(bucket.delete).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			'Avatar upload: failed to re-read override for cleanup:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
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
		// for the player. The mock defaults to true (so normal avatar
		// uploads pass); override it to false here to test the rejection
		// path. The real validateImageEndMarker has dedicated unit tests
		// in packages/shared/src/__tests__/image.test.ts.
		vi.mocked(validateImageEndMarker).mockResolvedValueOnce(false);
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

	it('POST avatar rejects dimensions exceeding the maximum with 400', async () => {
		const { bucket } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const oversizedPng = new Uint8Array(PNG_BYTES);
		// MAX_AVATAR_DIMENSION is 512 in the route; use 513x1 to reach the
		// dimension guard before the structural end-marker check.
		new DataView(oversizedPng.buffer).setUint32(16, 513);
		const form = new FormData();
		form.append('avatar', new Blob([oversizedPng], { type: 'image/png' }), 'a.png');

		const res = await buildApp().request(
			'/api/player/avatar',
			{ method: 'POST', headers: AUTH_COOKIE, body: form },
			env
		);

		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('dimensions must be');
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
		// Two sequential uploads A then B for the same player. Each writes
		// to its own versioned key (avatars/p1/{token}). D1's
		// avatarUpdateToken selects which one the serve route reads. The
		// second upload captures the first's token as previousToken and,
		// after confirming its own token is authoritative, deletes the
		// first's R2 object — so only the D1-selected version remains.
		const { bucket, store } = createMockBucket();
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
		// The first upload's versioned object was reclaimed by the second
		// (the second captured it as previousToken and deleted it after
		// confirming its own token is authoritative).
		const firstKey = versionedPuts[0][0] as string;
		expect(store.has(firstKey)).toBe(false);
		// Only the winning version remains in R2.
		const remaining = [...store.keys()].filter(
			(k) => k.startsWith('avatars/p1/') && !k.startsWith('avatars/staging/')
		);
		expect(remaining).toEqual([`avatars/p1/${token}`]);
	});

	it('overlapping concurrent uploads leave only the D1-selected version in R2', async () => {
		// The leak this closes: two uploads A and B both read the same
		// previousToken O BEFORE either D1 write lands. A writes token A,
		// B writes token B (overwriting A in D1). Under the old logic, A
		// re-read D1, saw B, and did nothing — A's R2 object was orphaned.
		// The fix: when the post-write re-read shows another token, delete
		// this upload's own versionedKey (it is definitively no longer
		// authoritative). After both uploads finish, only the D1-selected
		// version's R2 object remains.
		const { bucket, store } = createMockBucket();
		const env = { PUZZLES_BUCKET: bucket } as unknown as Env;
		const shared = await import('@perseus/shared');
		const profileStore = (shared as any).__store as Map<string, any>;

		// Seed an initial avatar with token O so both uploads read the same
		// previousToken. Without a prior token the cleanup branch is skipped
		// and the leak cannot manifest.
		profileStore.set('p1', {
			displayName: null,
			avatarUrl: '/api/player/p1/avatar',
			avatarUpdateToken: 'O'
		});
		store.set('avatars/p1/O', {
			body: new Uint8Array(PNG_BYTES).buffer,
			contentType: 'image/png',
			etag: 'etag-O'
		});

		// Gate the two previousToken reads: both uploads must call
		// getProfileOverride for the pre-upload previousToken read BEFORE
		// either is allowed to proceed past it. This forces the
		// interleaving where both read O before either D1 write. After the
		// gate releases, getProfileOverride reflects the live store so the
		// post-write re-reads see the actual D1 winner.
		let preReads = 0;
		let releasePreReads!: () => void;
		const preReadGate = new Promise<void>((resolve) => {
			releasePreReads = resolve;
		});
		vi.mocked(shared.getProfileOverride).mockImplementation(async (_db, playerId) => {
			preReads++;
			if (preReads === 2) releasePreReads();
			// The first two calls are the pre-upload previousToken reads —
			// gate them so both observe O. Later calls (post-write re-reads)
			// return the live store value immediately.
			if (preReads <= 2) {
				await preReadGate;
				return profileStore.get(playerId) ?? null;
			}
			return profileStore.get(playerId) ?? null;
		});

		const makeForm = () => {
			const blob = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
			const form = new FormData();
			form.append('avatar', blob, 'a.png');
			return form;
		};

		// Fire both uploads concurrently so their previousToken reads
		// overlap at the gate.
		const [resA, resB] = await Promise.all([
			buildApp().request(
				'/api/player/avatar',
				{ method: 'POST', headers: AUTH_COOKIE, body: makeForm() },
				env
			),
			buildApp().request(
				'/api/player/avatar',
				{ method: 'POST', headers: AUTH_COOKIE, body: makeForm() },
				env
			)
		]);
		expect(resA.status).toBe(200);
		expect(resB.status).toBe(200);

		// Exactly one versioned object remains — the D1-selected one. The
		// losing upload's object was deleted by its own post-write re-read
		// branch, and the prior O object was deleted by the winner.
		const winnerToken = profileStore.get('p1')?.avatarUpdateToken;
		expect(winnerToken).toBeTruthy();
		expect(winnerToken).not.toBe('O');
		const remaining = [...store.keys()].filter(
			(k) => k.startsWith('avatars/p1/') && !k.startsWith('avatars/staging/')
		);
		expect(remaining).toEqual([`avatars/p1/${winnerToken}`]);
		// The prior O object was reclaimed by the winning upload.
		expect(store.has('avatars/p1/O')).toBe(false);
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
		(shared as any).__familiesStore.clear();
		(shared as any).__statsStore.clear();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('GET puzzle-families returns owned families', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__familiesStore.set('p1', [
			{
				id: 'a0000000-0000-4000-8000-000000000001',
				name: 'Cat',
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: 1
			}
		]);
		const res = await buildApp().request(
			'/api/player/puzzle-families',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.families).toHaveLength(1);
		expect(body.families[0].name).toBe('Cat');
		expect(body.families[0].aspectRatio).toBe('1:1');
		expect(body.families[0].pieceCount).toBeUndefined();
		expect(body.families[0].variants).toBeUndefined();
	});

	it('GET puzzle-families forwards limit and cursor query params', async () => {
		const { listPlayerPuzzleFamilies } = await import('@perseus/shared');
		await buildApp().request(
			'/api/player/puzzle-families?limit=5&cursor=100',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(listPlayerPuzzleFamilies).toHaveBeenCalledWith(expect.anything(), 'p1', {
			limit: 5,
			cursor: '100'
		});
	});

	it('GET puzzle-families returns 400 for a malformed cursor', async () => {
		const shared = await import('@perseus/shared');
		vi.mocked(shared.listPlayerPuzzleFamilies).mockRejectedValueOnce(
			new shared.InvalidPlayerPuzzleFamilyCursorError('garbage')
		);
		const res = await buildApp().request(
			'/api/player/puzzle-families?cursor=garbage',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(body.message).toBe('Invalid puzzle family cursor');
	});

	it('GET puzzle-families rethrows unexpected listing errors', async () => {
		const shared = await import('@perseus/shared');
		vi.mocked(shared.listPlayerPuzzleFamilies).mockRejectedValueOnce(new Error('D1 unavailable'));
		const res = await buildApp().request(
			'/api/player/puzzle-families',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(500);
	});

	it('GET puzzle-families requires authentication', async () => {
		const res = await buildApp().request('/api/player/puzzle-families', {}, DUMMY_ENV);
		expect(res.status).toBe(401);
	});

	it('GET stats returns recorded stats', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__statsStore.set('p1', [
			{
				familyId: 'fam-1',
				familyName: 'Cat',
				difficulty: 'easy',
				standardBestTimeSeconds: 90,
				rotationBestTimeSeconds: null,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			}
		]);
		const res = await buildApp().request('/api/player/stats', { headers: AUTH_COOKIE }, DUMMY_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.stats).toHaveLength(1);
		expect(body.stats[0].standardBestTimeSeconds).toBe(90);
	});

	it('GET stats returns a variant-only row and profile totals from the combined model', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__statsStore.set('p1', [
			{
				familyId: 'fam-variant',
				familyName: 'Variant Result',
				difficulty: 'normal',
				standardBestTimeSeconds: null,
				rotationBestTimeSeconds: null,
				totalCompletions: 2,
				firstCompletedAt: 100,
				lastCompletedAt: 200
			}
		]);
		vi.mocked(shared.getPlayerSummary).mockResolvedValueOnce({
			puzzlesUploaded: 0,
			puzzlesSolved: 1,
			totalCompletions: 2
		});

		const [statsResponse, profileResponse] = await Promise.all([
			buildApp().request('/api/player/stats', { headers: AUTH_COOKIE }, DUMMY_ENV),
			buildApp().request('/api/player/profile', { headers: AUTH_COOKIE }, DUMMY_ENV)
		]);

		expect(statsResponse.status).toBe(200);
		expect(await statsResponse.json()).toEqual({
			stats: [
				{
					familyId: 'fam-variant',
					familyName: 'Variant Result',
					difficulty: 'normal',
					standardBestTimeSeconds: null,
					rotationBestTimeSeconds: null,
					totalCompletions: 2,
					firstCompletedAt: 100,
					lastCompletedAt: 200
				}
			]
		});
		expect(profileResponse.status).toBe(200);
		expect(((await profileResponse.json()) as any).summary).toEqual({
			puzzlesUploaded: 0,
			puzzlesSolved: 1,
			totalCompletions: 2
		});
	});

	it('GET stats forwards limit and v3 cursor query params', async () => {
		const { listPlayerStats } = await import('@perseus/shared');
		await buildApp().request(
			'/api/player/stats?limit=10&cursor=v3%7C1%7C%7Cfam-variant%7Cnormal',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(listPlayerStats).toHaveBeenCalledWith(expect.anything(), 'p1', {
			limit: 10,
			cursor: 'v3|1||fam-variant|normal'
		});
	});

	it('GET stats returns structured 400 for an invalid cursor', async () => {
		const { InvalidPlayerStatsCursorError, listPlayerStats } = await import('@perseus/shared');
		vi.mocked(listPlayerStats).mockRejectedValueOnce(
			new InvalidPlayerStatsCursorError('v3|0|10|pz1')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await buildApp().request(
			'/api/player/stats?cursor=v3%7C0%7C10%7Cpz1',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'bad_request',
			message: 'Invalid stats cursor'
		});
		consoleSpy.mockRestore();
	});

	it('GET stats rejects an explicitly empty cursor', async () => {
		const response = await buildApp().request(
			'/api/player/stats?cursor=',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'bad_request',
			message: 'Invalid stats cursor'
		});
	});

	it('GET stats does not mislabel database errors as invalid cursors', async () => {
		const { listPlayerStats } = await import('@perseus/shared');
		vi.mocked(listPlayerStats).mockRejectedValueOnce(new Error('database unavailable'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await buildApp().request(
			'/api/player/stats',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);

		expect(response.status).toBe(500);
		expect(response.status).not.toBe(400);
		consoleSpy.mockRestore();
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
		(shared as any).__familiesStore?.clear();
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

	it('GET progression returns 500 when the summary fails validation', async () => {
		const shared = await import('@perseus/shared');
		vi.mocked(shared.getPlayerProgressionSummary).mockResolvedValueOnce({ score: 0 } as any);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await buildApp().request(
			'/api/player/progression',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: 'internal_error',
			message: 'Failed to build progression summary'
		});
		consoleSpy.mockRestore();
	});

	it('GET puzzle-families returns 500 when a projected row fails validation', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__familiesStore.set('p1', [
			{
				id: 'a0000000-0000-4000-8000-000000000001',
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: 1
			}
		]);
		const res = await buildApp().request(
			'/api/player/puzzle-families',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);
		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe('internal_error');
	});

	it.each([
		['a non-string category', { category: 123 }],
		['an invalid category string', { category: 'Unknown' }],
		['an invalid status', { status: 'Unknown' }]
	])('GET puzzle-families rejects a good row alongside %s', async (_description, invalidFields) => {
		const shared = await import('@perseus/shared');
		if ('status' in invalidFields) {
			const types = await import('@perseus/types');
			vi.mocked(types.coercePuzzleStatus).mockReturnValueOnce('invalid' as any);
		}
		const goodFamily = {
			id: 'a0000000-0000-4000-8000-000000000002',
			name: 'Good family',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 1
		};
		(shared as any).__familiesStore.set('p1', [
			{
				...goodFamily,
				id: 'a0000000-0000-4000-8000-000000000001',
				name: 'Bad family',
				...invalidFields
			},
			goodFamily
		]);

		const res = await buildApp().request(
			'/api/player/puzzle-families',
			{ headers: AUTH_COOKIE },
			DUMMY_ENV
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: 'internal_error',
			message: 'Failed to list puzzle families'
		});
	});

	it('GET stats returns 500 when a projected row fails validation', async () => {
		const shared = await import('@perseus/shared');
		(shared as any).__statsStore.set('p1', [
			{
				familyId: 'pz1',
				standardBestTimeSeconds: 90,
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
