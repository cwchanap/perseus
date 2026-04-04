/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for worker.ts.
 * Covers: GET /api info route and the ASSETS 404 → /200.html SPA fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../routes/puzzles.worker', () => {
	const app = new Hono();
	app.get('/', (c: any) => c.json({ puzzles: [] }));
	return { default: app };
});

vi.mock('../routes/admin.worker', () => {
	const app = new Hono();
	app.get('/session', (c: any) => c.json({ authenticated: false }));
	return { default: app };
});

import worker from '../worker';

function createMockCtx(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn()
	} as any;
}

const validEnv = {
	NODE_ENV: 'development',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	ADMIN_PASSKEY: 'test-passkey',
	ALLOWED_ORIGINS: '',
	ASSETS: {
		fetch: vi.fn(() => new Response('static asset', { status: 200 }))
	}
};

describe('Worker - GET /api route', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		validEnv.ASSETS.fetch = vi.fn(() => new Response('static', { status: 200 }));
	});

	it('should return API info for GET /api', async () => {
		const req = new Request('http://localhost/api');
		const res = await worker.fetch(req, validEnv as any, createMockCtx());

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Perseus API');
		expect(body.version).toBeDefined();
		expect(body.timestamp).toBeDefined();
		expect(validEnv.ASSETS.fetch).not.toHaveBeenCalled();
	});
});

describe('Worker - ASSETS 404 SPA fallback', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('should serve /200.html when ASSETS returns 404 for unknown path', async () => {
		const spaFallbackContent = '<html>SPA</html>';
		const assetsFetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
			.mockResolvedValueOnce(new Response(spaFallbackContent, { status: 200 }));

		const env = {
			...validEnv,
			ASSETS: { fetch: assetsFetch }
		};

		const req = new Request('http://localhost/some-unknown-page');
		const res = await worker.fetch(req, env as any, createMockCtx());

		// The second ASSETS.fetch call should be for /200.html
		expect(assetsFetch).toHaveBeenCalledTimes(2);
		const secondCall = assetsFetch.mock.calls[1][0] as Request;
		expect(secondCall.url).toContain('/200.html');
		expect(res.status).toBe(200);
	});
});

describe('Worker - CORS middleware branches', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('should use explicitly configured ALLOWED_ORIGINS in dev mode', async () => {
		const env = {
			NODE_ENV: 'development',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: 'https://example.com,https://test.example.com',
			ASSETS: { fetch: vi.fn(() => new Response('asset', { status: 200 })) }
		};

		const req = new Request('http://localhost/api/health', {
			headers: { Origin: 'https://example.com' }
		});
		const res = await worker.fetch(req, env as any, createMockCtx());

		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
	});

	it('should return 200 for production with valid ALLOWED_ORIGINS set', async () => {
		const env = {
			NODE_ENV: 'production',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: 'https://myapp.example.com',
			ASSETS: { fetch: vi.fn(() => new Response('asset', { status: 200 })) }
		};

		const req = new Request('http://localhost/api/health', {
			headers: { Origin: 'https://myapp.example.com' }
		});
		const res = await worker.fetch(req, env as any, createMockCtx());

		// Should pass validation and return health check response
		expect(res.status).toBe(200);
	});

	it('should return 500 when only ALLOWED_ORIGINS is missing in production', async () => {
		const env = {
			NODE_ENV: 'production',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: '',
			ASSETS: { fetch: vi.fn() }
		};

		const req = new Request('http://localhost/api/health');
		const res = await worker.fetch(req, env as any, createMockCtx());

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('server_misconfigured');
	});
});

describe('Worker - error handler CORS branches', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('includes allowed origin in CORS header on error', async () => {
		const env = {
			NODE_ENV: 'development',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: 'https://allowed.example.com',
			ASSETS: {
				fetch: vi.fn(() => {
					throw new Error('ASSETS crashed');
				})
			}
		};

		const req = new Request('http://localhost/some-page', {
			headers: { Origin: 'https://allowed.example.com' }
		});
		const res = await worker.fetch(req, env as any, createMockCtx());

		expect(res.status).toBe(500);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example.com');
	});

	it('should use wildcard origin in error handler when origin is not allowed', async () => {
		const env = {
			NODE_ENV: 'development',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: 'https://allowed.example.com',
			ASSETS: {
				fetch: vi.fn(() => {
					throw new Error('ASSETS crashed');
				})
			}
		};

		const req = new Request('http://localhost/some-page', {
			headers: { Origin: 'https://evil.example.com' }
		});
		const res = await worker.fetch(req, env as any, createMockCtx());

		expect(res.status).toBe(500);
		// Origin not in allowed list → fallback to *
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('uses DEFAULT_ALLOWED_ORIGINS in dev mode when ALLOWED_ORIGINS is empty on error', async () => {
		const env = {
			NODE_ENV: 'development',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: '', // empty → envOrigins.length === 0 → use DEFAULT_ALLOWED_ORIGINS
			ASSETS: {
				fetch: vi.fn(() => {
					throw new Error('ASSETS crashed');
				})
			}
		};

		// localhost:5173 is in DEFAULT_ALLOWED_ORIGINS → should be reflected in CORS header
		const req = new Request('http://localhost/some-page', {
			headers: { Origin: 'http://localhost:5173' }
		});
		const res = await worker.fetch(req, env as any, createMockCtx());

		expect(res.status).toBe(500);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
	});
});
