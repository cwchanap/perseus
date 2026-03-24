import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';

// auth.ts reads JWT_SECRET eagerly via an IIFE at module-load time.
// Set it before the dynamic import below so the module initialises successfully.
const originalJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-key-for-bun-auth-testing-1234567890';

afterAll(() => {
	if (originalJwtSecret === undefined) {
		delete process.env.JWT_SECRET;
	} else {
		process.env.JWT_SECRET = originalJwtSecret;
	}
});

// Dynamically import so the env var above is visible when the module runs.
let createSession: typeof import('./auth').createSession;
let verifySession: typeof import('./auth').verifySession;
let getSessionToken: typeof import('./auth').getSessionToken;
let setSessionCookie: typeof import('./auth').setSessionCookie;
let clearSessionCookie: typeof import('./auth').clearSessionCookie;
let requireAuth: typeof import('./auth').requireAuth;
let optionalAuth: typeof import('./auth').optionalAuth;

beforeAll(async () => {
	const mod = await import('./auth');
	createSession = mod.createSession;
	verifySession = mod.verifySession;
	getSessionToken = mod.getSessionToken;
	setSessionCookie = mod.setSessionCookie;
	clearSessionCookie = mod.clearSessionCookie;
	requireAuth = mod.requireAuth;
	optionalAuth = mod.optionalAuth;
});

// ─── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
	it('returns a non-empty JWT string', async () => {
		const token = await createSession({ userId: 'user-1' });
		expect(typeof token).toBe('string');
		expect(token.length).toBeGreaterThan(0);
	});

	it('includes userId, sessionId, createdAt and exp in the token payload', async () => {
		const token = await createSession({ userId: 'user-1', username: 'alice', role: 'admin' });
		// JWT is three base64url parts separated by dots (hono/jwt uses HS256)
		const parts = token.split('.');
		expect(parts.length).toBe(3);
		const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(payload.userId).toBe('user-1');
		expect(payload.username).toBe('alice');
		expect(payload.role).toBe('admin');
		expect(typeof payload.sessionId).toBe('string');
		expect(typeof payload.createdAt).toBe('number');
		expect(typeof payload.exp).toBe('number');
	});

	it('generates unique tokens on successive calls', async () => {
		const t1 = await createSession({ userId: 'u' });
		await new Promise((r) => setTimeout(r, 5));
		const t2 = await createSession({ userId: 'u' });
		expect(t1).not.toBe(t2);
	});

	it('trims whitespace from userId and username', async () => {
		const token = await createSession({ userId: '  user-1  ', username: '  alice  ' });
		const parts = token.split('.');
		const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(payload.userId).toBe('user-1');
		expect(payload.username).toBe('alice');
	});

	it('throws when userId is empty', async () => {
		await expect(createSession({ userId: '' })).rejects.toThrow('userId is required');
	});

	it('throws when userId is whitespace only', async () => {
		await expect(createSession({ userId: '   ' })).rejects.toThrow('userId is required');
	});

	it('throws when username is an empty string', async () => {
		await expect(createSession({ userId: 'u', username: '' })).rejects.toThrow(
			'username must be a non-empty string'
		);
	});

	it('throws when role is an empty string', async () => {
		await expect(createSession({ userId: 'u', role: '' })).rejects.toThrow(
			'role must be a non-empty string'
		);
	});

	it('omits username from payload when not provided', async () => {
		const token = await createSession({ userId: 'u' });
		const parts = token.split('.');
		const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(payload.username).toBeUndefined();
	});
});

// ─── verifySession ────────────────────────────────────────────────────────────

describe('verifySession', () => {
	it('returns a valid session for a freshly created token', async () => {
		const token = await createSession({ userId: 'bob', username: 'Bob', role: 'admin' });
		const session = await verifySession(token);
		expect(session).not.toBeNull();
		expect(session?.userId).toBe('bob');
		expect(session?.username).toBe('Bob');
		expect(session?.role).toBe('admin');
	});

	it('returns null for a garbage token', async () => {
		expect(await verifySession('not.a.token')).toBeNull();
	});

	it('returns null for an empty string', async () => {
		expect(await verifySession('')).toBeNull();
	});

	it('returns null for a tampered payload', async () => {
		const token = await createSession({ userId: 'u' });
		const parts = token.split('.');
		const fakePayload = btoa(JSON.stringify({ userId: 'hacker', exp: Date.now() + 99999 }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const tampered = `${parts[0]}.${fakePayload}.${parts[2]}`;
		expect(await verifySession(tampered)).toBeNull();
	});

	it('returns null for an expired token', async () => {
		// Construct a token with exp in the past
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'u',
			createdAt: now - 20000,
			exp: Math.floor((now - 10000) / 1000) // 10 seconds ago (JWT seconds)
		};
		const { sign } = await import('hono/jwt');
		const expiredToken = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(expiredToken)).toBeNull();
	});
});

// ─── getSessionToken ──────────────────────────────────────────────────────────

describe('getSessionToken', () => {
	it('returns undefined when no cookie is present', async () => {
		const app = new Hono();
		let captured: string | undefined = 'sentinel';
		app.get('/t', (c) => {
			captured = getSessionToken(c);
			return c.text('ok');
		});
		await app.fetch(new Request('http://localhost/t'));
		expect(captured).toBeUndefined();
	});

	it('returns the token from the admin_session cookie', async () => {
		const app = new Hono();
		let captured: string | undefined;
		app.get('/t', (c) => {
			captured = getSessionToken(c);
			return c.text('ok');
		});
		await app.fetch(
			new Request('http://localhost/t', { headers: { Cookie: 'admin_session=mytoken123' } })
		);
		expect(captured).toBe('mytoken123');
	});
});

// ─── setSessionCookie / clearSessionCookie ────────────────────────────────────

describe('setSessionCookie', () => {
	it('adds Set-Cookie header to response', async () => {
		const app = new Hono();
		app.get('/login', (c) => {
			setSessionCookie(c, 'tok123');
			return c.text('ok');
		});
		const res = await app.fetch(new Request('http://localhost/login'));
		const cookie = res.headers.get('Set-Cookie');
		expect(cookie).toContain('admin_session=tok123');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Path=/');
	});
});

describe('clearSessionCookie', () => {
	it('sets Max-Age=0 to expire the cookie', async () => {
		const app = new Hono();
		app.get('/logout', (c) => {
			clearSessionCookie(c);
			return c.text('ok');
		});
		const res = await app.fetch(
			new Request('http://localhost/logout', { headers: { Cookie: 'admin_session=tok' } })
		);
		const cookie = res.headers.get('Set-Cookie');
		expect(cookie).toContain('admin_session=');
		expect(cookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i);
	});
});

// ─── requireAuth middleware ───────────────────────────────────────────────────

describe('requireAuth middleware', () => {
	it('returns 401 when no cookie is present', async () => {
		const app = new Hono();
		app.use('/protected', requireAuth);
		app.get('/protected', (c) => c.json({ ok: true }));
		const res = await app.fetch(new Request('http://localhost/protected'));
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('unauthorized');
	});

	it('returns 401 for an invalid token', async () => {
		const app = new Hono();
		app.use('/protected', requireAuth);
		app.get('/protected', (c) => c.json({ ok: true }));
		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Cookie: 'admin_session=bad.token.here' }
			})
		);
		expect(res.status).toBe(401);
	});

	it('calls next and sets session on context for a valid token', async () => {
		const token = await createSession({ userId: 'admin', role: 'admin' });
		const app = new Hono<{ Variables: { session: unknown } }>();
		app.use('/protected', requireAuth);
		let sessionInRoute: unknown;
		app.get('/protected', (c) => {
			sessionInRoute = c.get('session');
			return c.json({ ok: true });
		});
		const res = await app.fetch(
			new Request('http://localhost/protected', {
				headers: { Cookie: `admin_session=${token}` }
			})
		);
		expect(res.status).toBe(200);
		expect((sessionInRoute as { userId: string }).userId).toBe('admin');
	});
});

// ─── verifySession — string / non-standard exp & createdAt edge cases ─────────

describe('verifySession — edge cases', () => {
	it('handles valid ISO string exp (covers string exp path)', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		// Build a payload with exp as an ISO date string instead of a numeric Unix timestamp.
		// hono/jwt's verify passes because NaN < numericNow === false (no "expired" throw),
		// so verifySession receives exp as a string and exercises the else-if branch.
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'iso-exp-user',
			createdAt: now - 1000,
			exp: new Date(now + 86_400_000).toISOString()
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const token = await sign(payload, process.env.JWT_SECRET!);
		const session = await verifySession(token);
		// The string ISO date is parseable → expMs is in the future → session returned
		expect(session).not.toBeNull();
		expect(session?.userId).toBe('iso-exp-user');
	});

	it('returns null when string exp cannot be parsed as a date', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'bad-exp-user',
			createdAt: now - 1000,
			exp: 'not-a-date' // isNaN(new Date('not-a-date').getTime()) === true
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});

	it('returns null when exp is neither number nor string', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		// {} coerces to NaN in numeric comparison, so hono verify doesn't throw,
		// but the else branch in verifySession returns null.
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'obj-exp-user',
			createdAt: now - 1000,
			exp: {} as unknown as number
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});

	it('returns null for token with empty sessionId', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: '', // empty string → trim().length === 0 → null
			userId: 'user-1',
			createdAt: now - 1000,
			exp: Math.floor((now + 86_400_000) / 1000)
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});

	it('returns null for token with empty userId', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: '', // empty string → trim().length === 0 → null
			createdAt: now - 1000,
			exp: Math.floor((now + 86_400_000) / 1000)
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});

	it('handles valid ISO string createdAt (covers string createdAt path)', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'iso-createdat-user',
			createdAt: new Date(now - 5_000).toISOString(), // ISO string
			exp: Math.floor((now + 86_400_000) / 1000)
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		const session = await verifySession(token);
		expect(session).not.toBeNull();
		expect(session?.userId).toBe('iso-createdat-user');
	});

	it('returns null when string createdAt cannot be parsed', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'bad-createdat-user',
			createdAt: 'not-a-date', // isNaN(new Date('not-a-date').getTime()) === true
			exp: Math.floor((now + 86_400_000) / 1000)
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});

	it('returns null when createdAt is neither number nor string', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'null-createdat-user',
			createdAt: null as unknown as number, // null triggers the else branch
			exp: Math.floor((now + 86_400_000) / 1000)
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});

	it('returns null when createdAt is after expMs (impossible timestamp relationship)', async () => {
		const { sign } = await import('hono/jwt');
		const now = Date.now();
		const payload = {
			sessionId: crypto.randomUUID(),
			userId: 'future-created-user',
			// createdAt is well after expMs — violates valid session invariant
			createdAt: now + 20_000,
			exp: Math.floor((now + 10_000) / 1000) // expires 10 s from now (seconds)
		};
		const token = await sign(payload, process.env.JWT_SECRET!);
		expect(await verifySession(token)).toBeNull();
	});
});

// ─── optionalAuth middleware ──────────────────────────────────────────────────

describe('optionalAuth middleware', () => {
	it('calls next even with no cookie', async () => {
		const app = new Hono();
		app.use('/page', optionalAuth);
		app.get('/page', (c) => c.json({ ok: true }));
		const res = await app.fetch(new Request('http://localhost/page'));
		expect(res.status).toBe(200);
	});

	it('sets session on context when a valid token is present', async () => {
		const token = await createSession({ userId: 'alice' });
		const app = new Hono<{ Variables: { session: unknown } }>();
		app.use('/page', optionalAuth);
		let sessionInRoute: unknown;
		app.get('/page', (c) => {
			sessionInRoute = c.get('session');
			return c.json({ ok: true });
		});
		await app.fetch(
			new Request('http://localhost/page', {
				headers: { Cookie: `admin_session=${token}` }
			})
		);
		expect((sessionInRoute as { userId: string }).userId).toBe('alice');
	});

	it('does not set session when token is invalid and still calls next', async () => {
		const app = new Hono<{ Variables: { session: unknown } }>();
		app.use('/page', optionalAuth);
		let sessionInRoute: unknown = 'sentinel';
		app.get('/page', (c) => {
			sessionInRoute = c.get('session');
			return c.json({ ok: true });
		});
		const res = await app.fetch(
			new Request('http://localhost/page', {
				headers: { Cookie: 'admin_session=garbage.token.value' }
			})
		);
		expect(res.status).toBe(200);
		expect(sessionInRoute).toBeUndefined();
	});
});
