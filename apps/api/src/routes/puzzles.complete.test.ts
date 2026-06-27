/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const completions = new Map<string, number[]>();
	return {
		...actual,
		__completions: completions,
		recordCompletion: vi.fn(
			async (db: unknown, playerId: string, _puzzleId: string, time: number) => {
				const arr = completions.get(playerId) ?? [];
				arr.push(time);
				completions.set(playerId, arr);
			}
		)
	};
});

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import complete from '../routes/puzzles.complete';
import * as playerAuth from '../services/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';

const TEST_PLAYER: PlayerSessionRecord = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'P',
		picture: 'p.jpg',
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
	app.route('/api/puzzles', complete);
	return app;
}

describe('POST /api/puzzles/:id/complete (Bun)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('records a completion', async () => {
		const { recordCompletion } = await import('@perseus/shared');
		const res = await buildApp().request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(recordCompletion).toHaveBeenCalledWith(expect.anything(), 'p1', 'pz1', 90);
	});

	it('rejects non-numeric timeSeconds', async () => {
		const res = await buildApp().request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ timeSeconds: 'fast' })
		});
		expect(res.status).toBe(400);
	});

	it('rejects missing timeSeconds', async () => {
		const res = await buildApp().request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({})
		});
		expect(res.status).toBe(400);
	});

	it('rejects negative timeSeconds', async () => {
		const res = await buildApp().request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ timeSeconds: -5 })
		});
		expect(res.status).toBe(400);
	});

	it('requires authentication', async () => {
		const res = await buildApp().request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(401);
	});

	it('floors fractional timeSeconds', async () => {
		const { recordCompletion } = await import('@perseus/shared');
		await buildApp().request('/api/puzzles/pz1/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...AUTH_COOKIE },
			body: JSON.stringify({ timeSeconds: 90.7 })
		});
		expect(recordCompletion).toHaveBeenCalledWith(expect.anything(), 'p1', 'pz1', 90);
	});
});
