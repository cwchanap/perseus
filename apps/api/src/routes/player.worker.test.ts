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
	return {
		...actual,
		// Exposed for test-only reset between cases.
		__store: store,
		getProfileOverride: vi.fn((db: unknown, playerId: string) => store.get(playerId) ?? null),
		upsertProfileOverride: vi.fn(
			(
				db: unknown,
				playerId: string,
				values: { displayName: string | null; avatarUrl: string | null }
			) => {
				store.set(playerId, values);
			}
		),
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		}))
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
		const { upsertProfileOverride } = await import('@perseus/shared');
		await (upsertProfileOverride as any)({}, 'p1', { displayName: 'Custom', avatarUrl: null });

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
		})
	};
	return { bucket, store };
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04];

describe('player avatar route (Worker)', () => {
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
		expect(bucket.put).toHaveBeenCalledWith('avatars/p1', expect.any(ReadableStream), {
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
		const { upsertProfileOverride, getProfileOverride } = await import('@perseus/shared');
		await (upsertProfileOverride as any)({}, 'p1', {
			displayName: 'KeepMe',
			avatarUrl: null
		});

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
});
