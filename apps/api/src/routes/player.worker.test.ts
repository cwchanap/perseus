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
