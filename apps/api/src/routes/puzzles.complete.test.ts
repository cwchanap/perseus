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

vi.mock('../services/storage', () => ({
	getPuzzle: vi.fn().mockResolvedValue({ id: 'pz', status: 'ready' } as never)
}));

vi.mock('./puzzles', () => ({
	isPuzzleReady: vi.fn().mockReturnValue(true)
}));

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import complete from '../routes/puzzles.complete';
import * as playerAuth from '../services/player-auth';
import * as storage from '../services/storage';
import * as puzzlesRoute from './puzzles';
import { recordCompletion } from '@perseus/shared';
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
// A valid UUIDv4 (puzzle IDs are crypto.randomUUID()); 'pz1' is rejected by the
// format check, so tests that exercise the happy path use this instead.
const PUZZLE_ID = '123e4567-e89b-42d3-a456-426614174000';

function buildApp() {
	const app = new Hono();
	app.route('/api/puzzles', complete);
	return app;
}

function jsonHeaders() {
	return { 'Content-Type': 'application/json', ...AUTH_COOKIE };
}

describe('POST /api/puzzles/:id/complete (Bun)', () => {
	beforeEach(() => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
		vi.mocked(storage.getPuzzle).mockResolvedValue({ id: PUZZLE_ID, status: 'ready' } as never);
		vi.mocked(puzzlesRoute.isPuzzleReady).mockReturnValue(true);
		// Reset call history on every asserted mock so each test only reflects
		// its own requests (the not.toHaveBeenCalled() assertions depend on this).
		vi.mocked(storage.getPuzzle).mockClear();
		vi.mocked(puzzlesRoute.isPuzzleReady).mockClear();
		vi.mocked(recordCompletion).mockClear();
	});

	it('records a completion', async () => {
		const { recordCompletion } = await import('@perseus/shared');
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(recordCompletion).toHaveBeenCalledWith(expect.anything(), 'p1', PUZZLE_ID, 90);
	});

	it('rejects a malformed puzzle id with 400', async () => {
		const res = await buildApp().request('/api/puzzles/not-a-uuid/complete', {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(400);
		expect(storage.getPuzzle).not.toHaveBeenCalled();
	});

	it('rejects a non-v4 UUID with 400', async () => {
		// UUIDv1 (version digit is 1, not 4)
		const res = await buildApp().request(
			'/api/puzzles/123e4567-e89b-12d3-a456-426614174000/complete',
			{
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify({ timeSeconds: 90 })
			}
		);
		expect(res.status).toBe(400);
	});

	it('returns 404 when the puzzle does not exist', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(404);
		expect(recordCompletion).not.toHaveBeenCalled();
	});

	it('returns 404 when the puzzle is not ready', async () => {
		vi.mocked(puzzlesRoute.isPuzzleReady).mockReturnValueOnce(false);
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(404);
		expect(recordCompletion).not.toHaveBeenCalled();
	});

	it('rejects non-numeric timeSeconds', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 'fast' })
		});
		expect(res.status).toBe(400);
	});

	it('rejects missing timeSeconds', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({})
		});
		expect(res.status).toBe(400);
	});

	it('rejects negative timeSeconds', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: -5 })
		});
		expect(res.status).toBe(400);
	});

	it('rejects timeSeconds above the 24h sanity ceiling', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 24 * 60 * 60 + 1 })
		});
		expect(res.status).toBe(400);
		expect(storage.getPuzzle).not.toHaveBeenCalled();
	});

	it('rejects invalid JSON body with 400', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: 'not-json'
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({ error: 'bad_request' });
	});

	it('requires authentication', async () => {
		const res = await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timeSeconds: 90 })
		});
		expect(res.status).toBe(401);
	});

	it('floors fractional timeSeconds', async () => {
		const { recordCompletion } = await import('@perseus/shared');
		await buildApp().request(`/api/puzzles/${PUZZLE_ID}/complete`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ timeSeconds: 90.7 })
		});
		expect(recordCompletion).toHaveBeenCalledWith(expect.anything(), 'p1', PUZZLE_ID, 90);
	});
});
