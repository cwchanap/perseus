import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requirePlayerAuth, PLAYER_SESSION_COOKIE } from './player-auth';
import * as playerAuth from '../services/player-auth';

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

describe('requirePlayerAuth middleware', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 401 when no player session cookie is present', async () => {
		const app = new Hono();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(new Request('http://localhost/protected'));
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('unauthorized');
		expect(body.message).toBe('Player authentication required');
	});

	it('returns 401 when the session token is invalid or expired', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(null);

		const app = new Hono();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Cookie: `${PLAYER_SESSION_COOKIE}=invalid-token` }
			})
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('unauthorized');
		expect(body.message).toBe('Invalid or expired player session');
	});

	it('calls next and sets playerSession when token is valid', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'hash',
			user: { id: 'player-1', email: 'player@example.com', createdAt: 1, lastLoginAt: 2 },
			createdAt: 1,
			expiresAt: Date.now() + 10000
		});

		const app = new Hono<{ Variables: { playerSession: unknown } }>();
		app.use('/protected', requirePlayerAuth);
		let playerSessionInRoute: unknown;
		app.get('/protected', (c) => {
			playerSessionInRoute = c.get('playerSession');
			return c.json({ ok: true });
		});

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Cookie: `${PLAYER_SESSION_COOKIE}=valid-token` }
			})
		);
		expect(res.status).toBe(200);
		expect(playerSessionInRoute).toMatchObject({
			user: { id: 'player-1', email: 'player@example.com' }
		});
	});
});
