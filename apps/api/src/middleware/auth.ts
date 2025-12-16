// Auth middleware for admin routes
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';

const SESSION_COOKIE = 'admin_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();

export interface SessionPayload {
  sessionId: string;
  createdAt: number;
  exp: number;
  [key: string]: unknown;
}

export async function createSession(): Promise<string> {
  const now = Date.now();
  const payload: SessionPayload = {
    sessionId: crypto.randomUUID(),
    createdAt: now,
    exp: Math.floor((now + SESSION_DURATION_MS) / 1000) // JWT exp is in seconds
  };

  return await sign(payload, JWT_SECRET);
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const payload = await verify(token, JWT_SECRET);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000
  });
}

export function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: '/'
  });
}

export function getSessionToken(c: Parameters<typeof getCookie>[0]): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

// Middleware to require authentication
export const requireAuth = createMiddleware(async (c, next) => {
  const token = getSessionToken(c);

  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }

  const session = await verifySession(token);

  if (!session) {
    clearSessionCookie(c);
    return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
  }

  // Add session to context for use in routes
  c.set('session', session);

  await next();
});

// Middleware to optionally check authentication (doesn't fail if not authenticated)
export const optionalAuth = createMiddleware(async (c, next) => {
  const token = getSessionToken(c);

  if (token) {
    const session = await verifySession(token);
    if (session) {
      c.set('session', session);
    }
  }

  await next();
});
