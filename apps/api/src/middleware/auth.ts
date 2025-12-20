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
  userId: string;
  username?: string;
  role?: string;
  createdAt: number;
  exp: number;
  [key: string]: unknown;
}

export async function createSession(user: {
  userId: string;
  username?: string;
  role?: string;
}): Promise<string> {
  if (!user || typeof user.userId !== 'string' || user.userId.trim().length === 0) {
    throw new Error('userId is required');
  }

  if (user.username !== undefined && (typeof user.username !== 'string' || user.username.trim().length === 0)) {
    throw new Error('username must be a non-empty string');
  }

  if (user.role !== undefined && (typeof user.role !== 'string' || user.role.trim().length === 0)) {
    throw new Error('role must be a non-empty string');
  }

  const now = Date.now();
  const payload: SessionPayload = {
    sessionId: crypto.randomUUID(),
    userId: user.userId.trim(),
    createdAt: now,
    exp: Math.floor((now + SESSION_DURATION_MS) / 1000) // JWT exp is in seconds
  };

  if (user.username) payload.username = user.username.trim();
  if (user.role) payload.role = user.role.trim();

  return await sign(payload, JWT_SECRET);
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const payload = await verify(token, JWT_SECRET);
    const session = payload as unknown as SessionPayload;

    // Validate sessionId
    if (typeof session.sessionId !== 'string' || session.sessionId.trim().length === 0) {
      return null;
    }

    // Validate userId
    if (typeof session.userId !== 'string' || session.userId.trim().length === 0) {
      return null;
    }

    // Validate createdAt (number or ISO string)
    let createdAt: number;
    if (typeof session.createdAt === 'number') {
      createdAt = session.createdAt;
    } else if (typeof session.createdAt === 'string') {
      const parsed = new Date(session.createdAt).getTime();
      if (isNaN(parsed)) {
        return null;
      }
      createdAt = parsed;
    } else {
      return null;
    }

    // Validate exp (number or ISO string)
    let exp: number;
    if (typeof session.exp === 'number') {
      exp = session.exp;
    } else if (typeof session.exp === 'string') {
      const parsed = new Date(session.exp).getTime();
      if (isNaN(parsed)) {
        return null;
      }
      exp = parsed;
    } else {
      return null;
    }

    // Validate timestamp relationships: exp > now and createdAt <= exp
    const now = Date.now();
    if (exp <= now || createdAt > exp) {
      return null;
    }

    // Return normalized session with trimmed strings
    return {
      ...session,
      sessionId: session.sessionId.trim(),
      userId: session.userId.trim(),
      createdAt,
      exp
    };
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
    try {
      const session = await verifySession(token);
      if (session) {
        c.set('session', session);
      } else {
        clearSessionCookie(c);
      }
    } catch {
      clearSessionCookie(c);
    }
  }

  await next();
});
