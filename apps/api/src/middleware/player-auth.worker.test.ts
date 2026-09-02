import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requirePlayerAuth, PLAYER_SESSION_COOKIE } from './player-auth.worker';
import * as playerAuth from '../services/player-auth.worker';
import type { Env } from '../worker';

vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

describe('requirePlayerAuth worker middleware', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 401 when no player session cookie is present', async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(new Request('http://localhost/protected'), {} as Env);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('unauthorized');
		expect(body.message).toBe('Player authentication required');
	});

	it('returns 401 when the session token is invalid or expired', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(null);

		const app = new Hono<{ Bindings: Env }>();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Cookie: `${PLAYER_SESSION_COOKIE}=invalid-token` }
			}),
			{} as Env
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

		const app = new Hono<{ Bindings: Env; Variables: { playerSession: unknown } }>();
		app.use('/protected', requirePlayerAuth);
		let playerSessionInRoute: unknown;
		app.get('/protected', (c) => {
			playerSessionInRoute = c.get('playerSession');
			return c.json({ ok: true });
		});

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Cookie: `${PLAYER_SESSION_COOKIE}=valid-token` }
			}),
			{} as Env
		);
		expect(res.status).toBe(200);
		expect(playerSessionInRoute).toMatchObject({
			user: { id: 'player-1', email: 'player@example.com' }
		});
	});

	it('prefers a valid bearer token over the player session cookie', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'hash',
			user: { id: 'player-1', email: 'player@example.com', createdAt: 1, lastLoginAt: 2 },
			createdAt: 1,
			expiresAt: Date.now() + 10000
		});

		const app = new Hono<{ Bindings: Env }>();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: {
					Authorization: 'Bearer bearer-token',
					Cookie: `${PLAYER_SESSION_COOKIE}=cookie-token`
				}
			}),
			{} as Env
		);
		expect(res.status).toBe(200);
		expect(vi.mocked(playerAuth.getPlayerSession).mock.calls[0]?.[1]).toBe('bearer-token');
	});

	it('does not fall back to the cookie for a non-bearer Authorization header', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'hash',
			user: { id: 'player-1', email: 'player@example.com', createdAt: 1, lastLoginAt: 2 },
			createdAt: 1,
			expiresAt: Date.now() + 10000
		});

		const app = new Hono<{ Bindings: Env }>();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: {
					Authorization: 'Basic dXNlcjpwYXNz',
					Cookie: `${PLAYER_SESSION_COOKIE}=valid-token`
				}
			}),
			{} as Env
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('unauthorized');
		expect(body.message).toBe('Player authentication required');
		expect(playerAuth.getPlayerSession).not.toHaveBeenCalled();
	});

	it('returns 401 when the bearer token is invalid', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(null);

		const app = new Hono<{ Bindings: Env }>();
		app.use('/protected', requirePlayerAuth);
		app.get('/protected', (c) => c.json({ ok: true }));

		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Authorization: 'Bearer invalid-token' }
			}),
			{} as Env
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('unauthorized');
		expect(body.message).toBe('Invalid or expired player session');
	});
});
